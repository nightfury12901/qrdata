// Photon Framing Protocol — RGB Mode
// Each frame uses 3 raw byte channels (R, G, B) with CRC-8 validation.
// Reed-Solomon was removed: optical BER is near-zero (contrast R:61-252),
// so CRC frame-rejection + fountain code retransmission is sufficient.

// CRC-8 calculation (polynomial 0x07)
function crc8(data) {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 0x80) {
        crc = ((crc << 1) ^ 0x07) & 0xFF;
      } else {
        crc = (crc << 1) & 0xFF;
      }
    }
  }
  return crc;
}

// ---- Layout constants ----
// Each frame: 5472 data cells × 3 channels = 16416 bits = 2052 bytes total
const FRAME_BYTES = 2052;
const CHANNEL_BYTES = 684;          // FRAME_BYTES / 3
const NUM_CHANNELS = 3;             // R, G, B
const HEADER_SIZE = 5;              // seq(2) + length(2) + flags(1)
const FOOTER_SIZE = 1;              // CRC-8

// Reed-Solomon config: split each 684-byte channel into three 228-byte sub-blocks.
const BLOCKS_PER_CHANNEL = 3;
const BLOCK_SIZE = CHANNEL_BYTES / BLOCKS_PER_CHANNEL; // 228
const ECC_SIZE = 32; // Parity bytes per block
const DATA_PER_BLOCK = BLOCK_SIZE - ECC_SIZE; // 196
const TOTAL_DATA = DATA_PER_BLOCK * BLOCKS_PER_CHANNEL * NUM_CHANNELS; // 1764

const MAX_PAYLOAD_SIZE = TOTAL_DATA - HEADER_SIZE - FOOTER_SIZE; // 1758 bytes

// Protocol Flags
const FLAG_TEXT = 0;
const FLAG_FILE_META = 1;
const FLAG_FILE_DATA = 2;
const FLAG_FOUNTAIN_DATA = 3;

// Mulberry32 PRNG (used only for fountain sequence generation)
function mulberry32(a) {
  return function() {
    var t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
}

// Stateless integer hash function to generate deterministic PRBS mask for bit index `i`.
function getMaskBit(i) {
  let h = (i + 0x12345678) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 31) & 1;
}

function getFountainIndices(seq, totalChunks) {
  if (seq < totalChunks) {
    return [seq];
  }
  const prng = mulberry32(seq + 1337);
  const indices = [];
  for (let i = 0; i < totalChunks; i++) {
    if (prng() > 0.5) {
      indices.push(i);
    }
  }
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
 * Encodes a frame into 3 raw byte channels [R, G, B] with CRC and RS.
 */
function encodeFrame(seq, isEof, flags, payload) {
  initRS();
  if (payload.length > MAX_PAYLOAD_SIZE) {
    throw new Error(`Payload too large: ${payload.length} > ${MAX_PAYLOAD_SIZE}`);
  }

  const data = new Uint8Array(TOTAL_DATA);

  // Fill non-header area with random bytes for visual noise
  for (let i = HEADER_SIZE; i < TOTAL_DATA - FOOTER_SIZE; i++) {
    data[i] = Math.floor(Math.random() * 256);
  }

  // Header
  const seqWithEof = (seq & 0x7FFF) | (isEof ? 0x8000 : 0);
  data[0] = seqWithEof & 0xFF;
  data[1] = (seqWithEof >> 8) & 0xFF;
  data[2] = payload.length & 0xFF;
  data[3] = (payload.length >> 8) & 0xFF;
  data[4] = flags & 0xFF;

  // Payload
  data.set(payload, HEADER_SIZE);

  // CRC covers everything except the last byte
  data[TOTAL_DATA - 1] = crc8(data.subarray(0, TOTAL_DATA - 1));

  const blocks = [
    new Uint8Array(CHANNEL_BYTES),
    new Uint8Array(CHANNEL_BYTES),
    new Uint8Array(CHANNEL_BYTES),
  ];

  for (let ch = 0; ch < NUM_CHANNELS; ch++) {
    for (let blk = 0; blk < BLOCKS_PER_CHANNEL; blk++) {
      const rsData = new Int32Array(BLOCK_SIZE);
      const dataOffset = (ch * BLOCKS_PER_CHANNEL + blk) * DATA_PER_BLOCK;
      for (let i = 0; i < DATA_PER_BLOCK; i++) {
        rsData[i] = data[dataOffset + i];
      }
      rsEncoder.encode(rsData, ECC_SIZE);
      
      const blockOffset = blk * BLOCK_SIZE;
      for (let i = 0; i < BLOCK_SIZE; i++) {
        blocks[ch][blockOffset + i] = rsData[i];
      }
    }
  }

  return blocks;
}

/**
 * Decodes a frame from 3 raw byte channels.
 */
function decodeFrame(rBlock, gBlock, bBlock) {
  initRS();
  const blocks = [rBlock, gBlock, bBlock];
  const decoded = new Uint8Array(TOTAL_DATA);
  let totalErrors = 0;

  for (let ch = 0; ch < NUM_CHANNELS; ch++) {
    for (let blk = 0; blk < BLOCKS_PER_CHANNEL; blk++) {
      const rsData = new Int32Array(BLOCK_SIZE);
      const blockOffset = blk * BLOCK_SIZE;
      for (let i = 0; i < BLOCK_SIZE; i++) {
        rsData[i] = blocks[ch][blockOffset + i];
      }

      try {
        totalErrors += rsDecoder.decode(rsData, ECC_SIZE);
      } catch (e) {
        return { valid: false, errorsCorrected: 0, failedChannel: ch };
      }

      const dataOffset = (ch * BLOCKS_PER_CHANNEL + blk) * DATA_PER_BLOCK;
      for (let i = 0; i < DATA_PER_BLOCK; i++) {
        decoded[dataOffset + i] = rsData[i];
      }
    }
  }

  // CRC check
  const calculatedCrc = crc8(decoded.subarray(0, TOTAL_DATA - 1));
  if (calculatedCrc !== decoded[TOTAL_DATA - 1]) {
    return { valid: false, errorsCorrected: totalErrors, failedChannel: -1 };
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
