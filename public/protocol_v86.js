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
const MAX_PAYLOAD_SIZE = FRAME_BYTES - HEADER_SIZE - FOOTER_SIZE; // 2046 bytes

// Keep legacy constant names so sender.js / receiver.js don't need changes
const TOTAL_DATA = FRAME_BYTES;
const BLOCKS_PER_CHANNEL = 1;
const BLOCK_SIZE = CHANNEL_BYTES;
const ECC_SIZE = 0;
const DATA_PER_BLOCK = CHANNEL_BYTES;

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
 */
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

/**
 * Encodes a frame into 3 raw byte channels [R, G, B] with CRC.
 * @returns {Uint8Array[]} [rChannel, gChannel, bChannel], each CHANNEL_BYTES bytes
 */
function encodeFrame(seq, isEof, flags, payload) {
  if (payload.length > MAX_PAYLOAD_SIZE) {
    throw new Error(`Payload too large: ${payload.length} > ${MAX_PAYLOAD_SIZE}`);
  }

  const data = new Uint8Array(FRAME_BYTES);

  // Fill non-header area with random bytes for visual noise
  for (let i = HEADER_SIZE; i < FRAME_BYTES - FOOTER_SIZE; i++) {
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
  data[FRAME_BYTES - 1] = crc8(data.subarray(0, FRAME_BYTES - 1));

  // Split into 3 equal channels (row-major: R gets bytes 0..683, G gets 684..1367, B gets 1368..2051)
  return [
    new Uint8Array(data.buffer, 0, CHANNEL_BYTES),
    new Uint8Array(data.buffer, CHANNEL_BYTES, CHANNEL_BYTES),
    new Uint8Array(data.buffer, CHANNEL_BYTES * 2, CHANNEL_BYTES),
  ];
}

/**
 * Decodes a frame from 3 raw byte channels.
 * @returns {{ valid, seq, isEof, flags, payload, errorsCorrected, failedChannel }}
 */
function decodeFrame(rBlock, gBlock, bBlock) {
  const data = new Uint8Array(FRAME_BYTES);
  data.set(rBlock.subarray(0, CHANNEL_BYTES), 0);
  data.set(gBlock.subarray(0, CHANNEL_BYTES), CHANNEL_BYTES);
  data.set(bBlock.subarray(0, CHANNEL_BYTES), CHANNEL_BYTES * 2);

  // CRC check
  const calculatedCrc = crc8(data.subarray(0, FRAME_BYTES - 1));
  if (calculatedCrc !== data[FRAME_BYTES - 1]) {
    return { valid: false, errorsCorrected: 0, failedChannel: -1 };
  }

  // Extract header
  const seqWithEof = data[0] | (data[1] << 8);
  const seq = seqWithEof & 0x7FFF;
  const isEof = (seqWithEof & 0x8000) !== 0;
  const length = data[2] | (data[3] << 8);
  const flags = data[4];

  if (length > MAX_PAYLOAD_SIZE) {
    return { valid: false, errorsCorrected: 0 };
  }

  const payload = new Uint8Array(data.subarray(HEADER_SIZE, HEADER_SIZE + length));

  return {
    valid: true,
    seq,
    isEof,
    flags,
    payload,
    errorsCorrected: 0
  };
}
