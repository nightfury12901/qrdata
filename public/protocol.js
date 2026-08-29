// Photon Framing Protocol — RGB Mode
// Each frame uses 3 independent RS blocks (R, G, B channels).
// This gives independent error correction per color channel.

// CRC-8 calculation (polynomial 0x07)
function crc8(data) {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 0x80) {
        crc = (crc << 1) ^ 0x07;
      } else {
        crc <<= 1;
      }
    }
  }
  return crc & 0xFF;
}

// ---- Layout constants ----
const BLOCKS_PER_CHANNEL = 1;
const BLOCK_SIZE = 200;        // bytes per RS block
const ECC_SIZE = 32;           // RS parity bytes per block
const DATA_PER_BLOCK = BLOCK_SIZE - ECC_SIZE; // 168 data bytes per block
const NUM_CHANNELS = 3;        // R, G, B
const TOTAL_DATA = DATA_PER_BLOCK * BLOCKS_PER_CHANNEL * NUM_CHANNELS; // 2016 bytes total data
const HEADER_SIZE = 5;         // seq(2) + length(2) + flags(1)
const FOOTER_SIZE = 1;         // CRC-8
const MAX_PAYLOAD_SIZE = TOTAL_DATA - HEADER_SIZE - FOOTER_SIZE; // 2010 bytes

// Protocol Flags
const FLAG_TEXT = 0;
const FLAG_FILE_META = 1;
const FLAG_FILE_DATA = 2;
const FLAG_FOUNTAIN_DATA = 3;

// Mulberry32 PRNG
function mulberry32(a) {
  return function() {
    var t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
}

/**
 * Get the chunk indices to XOR for a given sequence number.
 * @param {number} seq - The sequence number of the fountain frame.
 * @param {number} totalChunks - The total number of source chunks.
 * @returns {number[]} - Array of chunk indices.
 */
function getFountainIndices(seq, totalChunks) {
  // Phase 3: Systematic phase!
  // Send the raw original chunks first (seq 0 to totalChunks-1).
  if (seq < totalChunks) {
    return [seq];
  }

  // Fountain phase! (seq >= totalChunks)
  // For GF(2) Gaussian Elimination on small N, uniform random subset (density ~0.5) is perfect.
  const prng = mulberry32(seq + 1337); // Seed with seq
  const indices = [];

  // picking each with 50% probability is optimal for GF(2) Gaussian elimination.
  for (let i = 0; i < totalChunks; i++) {
    if (prng() > 0.5) {
      indices.push(i);
    }
  }
  // Fallback if empty (very rare, 1 in 2^N)
  if (indices.length === 0) indices.push(Math.floor(prng() * totalChunks));
  return indices;
}

let rsEncoder = null;
let rsDecoder = null;

function initRS() {
  if (rsEncoder) return;
  if (typeof RS !== 'undefined') {
    const field = RS.GenericGF.QR_CODE_FIELD_256();
    rsEncoder = new RS.ReedSolomonEncoder(field);
    rsDecoder = new RS.ReedSolomonDecoder(field);
  } else {
    throw new Error("RS library not loaded");
  }
}

/**
 * Encodes a frame of data into 3 RS-encoded blocks (one per color channel).
 * @param {number} seq - Sequence number (0-32767)
 * @param {boolean} isEof - True if this is the last frame
 * @param {number} flags - Protocol flags (0=text, 1=file meta, 2=file data)
 * @param {Uint8Array} payload - Up to MAX_PAYLOAD_SIZE bytes
 * @returns {Uint8Array[]} - Array of 3 blocks [R, G, B], each 128 bytes
 */
function encodeFrame(seq, isEof, flags, payload) {
  initRS();
  if (payload.length > MAX_PAYLOAD_SIZE) {
    throw new Error(`Payload too large: ${payload.length} > ${MAX_PAYLOAD_SIZE}`);
  }

  // Build 300-byte data buffer
  const data = new Uint8Array(TOTAL_DATA);

  // Fill with random bytes for visual noise (prevents large single-color regions)
  for (let i = HEADER_SIZE; i < TOTAL_DATA - FOOTER_SIZE; i++) {
    data[i] = Math.floor(Math.random() * 256);
  }

  // Header: seq (15 bits) + EOF flag (MSB of byte 1)
  const seqWithEof = (seq & 0x7FFF) | (isEof ? 0x8000 : 0);
  data[0] = seqWithEof & 0xFF;
  data[1] = (seqWithEof >> 8) & 0xFF;

  // Length (2 bytes, little-endian)
  data[2] = payload.length & 0xFF;
  data[3] = (payload.length >> 8) & 0xFF;

  // Flags
  data[4] = flags & 0xFF;

  // Payload
  data.set(payload, HEADER_SIZE);

  // CRC at last byte covers bytes 0..298
  data[TOTAL_DATA - 1] = crc8(data.subarray(0, TOTAL_DATA - 1));

  // Split into 4 blocks per channel (12 blocks total) and RS encode each
  const blocks = [];
  for (let ch = 0; ch < NUM_CHANNELS; ch++) {
    const channelData = new Uint8Array(BLOCK_SIZE * BLOCKS_PER_CHANNEL);
    
    for (let b = 0; b < BLOCKS_PER_CHANNEL; b++) {
      const dataOffset = (ch * BLOCKS_PER_CHANNEL + b) * DATA_PER_BLOCK;
      const rsData = new Int32Array(BLOCK_SIZE);
      for (let i = 0; i < DATA_PER_BLOCK; i++) {
        rsData[i] = data[dataOffset + i];
      }
      rsEncoder.encode(rsData, ECC_SIZE);

      const blockOffset = b * BLOCK_SIZE;
      for (let i = 0; i < BLOCK_SIZE; i++) {
        channelData[blockOffset + i] = rsData[i];
      }
    }
    blocks.push(channelData);
  }

  return blocks; // [rChannelData, gChannelData, bChannelData] (each is 800 bytes)
}

/**
 * Decodes and validates a frame from 3 RS-encoded blocks.
 * @param {Uint8Array} rBlock - 128-byte R channel block
 * @param {Uint8Array} gBlock - 128-byte G channel block
 * @param {Uint8Array} bBlock - 128-byte B channel block
 * @returns {Object} - { valid, seq, isEof, payload, errorsCorrected, failedChannel }
 */
function decodeFrame(rBlock, gBlock, bBlock) {
  initRS();

  const blocks = [rBlock, gBlock, bBlock];
  const decoded = new Uint8Array(TOTAL_DATA);
  let totalErrors = 0;

  for (let ch = 0; ch < NUM_CHANNELS; ch++) {
    for (let b = 0; b < BLOCKS_PER_CHANNEL; b++) {
      const blockOffset = b * BLOCK_SIZE;
      const rsData = new Int32Array(BLOCK_SIZE);
      for (let i = 0; i < BLOCK_SIZE; i++) {
        rsData[i] = blocks[ch][blockOffset + i];
      }

      try {
        totalErrors += rsDecoder.decode(rsData, ECC_SIZE);
      } catch (e) {
        return { valid: false, errorsCorrected: 0, failedChannel: ch };
      }

      const dataOffset = (ch * BLOCKS_PER_CHANNEL + b) * DATA_PER_BLOCK;
      for (let i = 0; i < DATA_PER_BLOCK; i++) {
        decoded[dataOffset + i] = rsData[i];
      }
    }
  }

  // Verify CRC
  const calculatedCrc = crc8(decoded.subarray(0, TOTAL_DATA - 1));
  if (calculatedCrc !== decoded[TOTAL_DATA - 1]) {
    return { valid: false, errorsCorrected: totalErrors };
  }

  // Extract header
  const seqWithEof = decoded[0] | (decoded[1] << 8);
  const seq = seqWithEof & 0x7FFF;
  const isEof = (seqWithEof & 0x8000) !== 0;
  const length = decoded[2] | (decoded[3] << 8);
  const flags = decoded[4];

  if (length > MAX_PAYLOAD_SIZE) {
    return { valid: false, errorsCorrected: totalErrors };
  }

  const payload = new Uint8Array(decoded.subarray(HEADER_SIZE, HEADER_SIZE + length));

  return {
    valid: true,
    seq,
    isEof,
    flags,
    payload,
    errorsCorrected: totalErrors
  };
}
