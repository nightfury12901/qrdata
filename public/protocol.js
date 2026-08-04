// Photon Framing Protocol

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

const FRAME_SIZE_BYTES = 32; // 16x16 grid = 256 bits = 32 bytes
const HEADER_SIZE = 3;       // 2 bytes seq/EOF, 1 byte length
const FOOTER_SIZE = 1;       // 1 byte CRC
const MAX_PAYLOAD_SIZE = FRAME_SIZE_BYTES - HEADER_SIZE - FOOTER_SIZE; // 28 bytes

/**
 * Encodes a frame of data.
 * @param {number} seq - Sequence number (0-32767)
 * @param {boolean} isEof - True if this is the last frame
 * @param {Uint8Array} payload - Up to MAX_PAYLOAD_SIZE bytes
 * @returns {Uint8Array} - 32-byte frame
 */
function encodeFrame(seq, isEof, payload) {
  if (payload.length > MAX_PAYLOAD_SIZE) {
    throw new Error(`Payload too large: ${payload.length} > ${MAX_PAYLOAD_SIZE}`);
  }
  
  const frame = new Uint8Array(FRAME_SIZE_BYTES);
  
  // Fill the frame with a checkerboard pattern (01010101 = 0x55)
  // This ensures unused padding bytes don't create massive solid black areas
  // which could merge with anchors in the camera's binarized image.
  frame.fill(0x55);
  
  // Seq (15 bits) + EOF flag (MSB)
  const seqWithEof = (seq & 0x7FFF) | (isEof ? 0x8000 : 0);
  frame[0] = seqWithEof & 0xFF;        // LSB
  frame[1] = (seqWithEof >> 8) & 0xFF; // MSB
  
  // Length
  frame[2] = payload.length & 0xFF;
  
  // Payload
  frame.set(payload, 3);
  
  // CRC covers header and payload area
  frame[FRAME_SIZE_BYTES - 1] = crc8(frame.subarray(0, FRAME_SIZE_BYTES - 1));
  
  return frame;
}

/**
 * Decodes and validates a frame.
 * @param {Uint8Array} frame - 32-byte frame
 * @returns {Object} - { valid, seq, isEof, payload }
 */
function decodeFrame(frame) {
  if (frame.length !== FRAME_SIZE_BYTES) {
    return { valid: false };
  }
  
  // Check CRC
  const calculatedCrc = crc8(frame.subarray(0, FRAME_SIZE_BYTES - 1));
  if (calculatedCrc !== frame[FRAME_SIZE_BYTES - 1]) {
    return { valid: false };
  }
  
  const seqWithEof = frame[0] | (frame[1] << 8);
  const seq = seqWithEof & 0x7FFF;
  const isEof = (seqWithEof & 0x8000) !== 0;
  const length = frame[2];
  
  // Sanity check length
  if (length > MAX_PAYLOAD_SIZE) {
    return { valid: false };
  }
  
  const payload = frame.subarray(3, 3 + length);
  
  return {
    valid: true,
    seq,
    isEof,
    payload
  };
}
