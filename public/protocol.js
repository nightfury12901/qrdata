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

const FRAME_SIZE_BYTES = 128; // 32x32 grid = 1024 bits = 128 bytes
const ECC_SIZE = 28;         // Reed-Solomon parity bytes
const HEADER_SIZE = 3;       // 2 bytes seq/EOF, 1 byte length
const FOOTER_SIZE = 1;       // 1 byte CRC (sanity check)
const MAX_PAYLOAD_SIZE = FRAME_SIZE_BYTES - HEADER_SIZE - FOOTER_SIZE - ECC_SIZE; // 96 bytes

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
 * Encodes a frame of data.
 * @param {number} seq - Sequence number (0-32767)
 * @param {boolean} isEof - True if this is the last frame
 * @param {Uint8Array} payload - Up to MAX_PAYLOAD_SIZE bytes
 * @returns {Uint8Array} - 128-byte frame
 */
function encodeFrame(seq, isEof, payload) {
  initRS();
  if (payload.length > MAX_PAYLOAD_SIZE) {
    throw new Error(`Payload too large: ${payload.length} > ${MAX_PAYLOAD_SIZE}`);
  }
  
  const frame = new Uint8Array(FRAME_SIZE_BYTES);
  
  // Fill payload area with random bytes for high-frequency noise
  for (let i = HEADER_SIZE; i < FRAME_SIZE_BYTES - ECC_SIZE - FOOTER_SIZE; i++) {
    frame[i] = Math.floor(Math.random() * 256);
  }
  
  // Seq (15 bits) + EOF flag (MSB)
  const seqWithEof = (seq & 0x7FFF) | (isEof ? 0x8000 : 0);
  frame[0] = seqWithEof & 0xFF;        // LSB
  frame[1] = (seqWithEof >> 8) & 0xFF; // MSB
  
  // Length
  frame[2] = payload.length & 0xFF;
  
  // Payload
  frame.set(payload, 3);
  
  // CRC covers header and payload area
  const dataLen = FRAME_SIZE_BYTES - ECC_SIZE;
  frame[dataLen - 1] = crc8(frame.subarray(0, dataLen - 1));
  
  // Compute RS Parity
  // RS library expects Int32Array with data at start and 0s at end
  const rsData = new Int32Array(FRAME_SIZE_BYTES);
  for (let i = 0; i < dataLen; i++) {
    rsData[i] = frame[i];
  }
  rsEncoder.encode(rsData, ECC_SIZE);
  
  // Copy parity back to frame
  for (let i = 0; i < FRAME_SIZE_BYTES; i++) {
    frame[i] = rsData[i];
  }
  
  return frame;
}

/**
 * Decodes and validates a frame.
 * @param {Uint8Array} frame - 128-byte frame
 * @returns {Object} - { valid, seq, isEof, payload, errorsCorrected }
 */
function decodeFrame(frame) {
  initRS();
  if (frame.length !== FRAME_SIZE_BYTES) {
    return { valid: false, errorsCorrected: 0 };
  }
  
  const rsData = new Int32Array(FRAME_SIZE_BYTES);
  for (let i = 0; i < FRAME_SIZE_BYTES; i++) {
    rsData[i] = frame[i];
  }
  
  let errorsCorrected = 0;
  try {
    // decode returns the number of errors corrected, or throws if uncorrectable
    errorsCorrected = rsDecoder.decode(rsData, ECC_SIZE);
  } catch (e) {
    return { valid: false, errorsCorrected: 0 };
  }
  
  // Copy corrected data back
  const correctedFrame = new Uint8Array(FRAME_SIZE_BYTES);
  for (let i = 0; i < FRAME_SIZE_BYTES; i++) {
    correctedFrame[i] = rsData[i];
  }
  
  const dataLen = FRAME_SIZE_BYTES - ECC_SIZE;
  
  // Check CRC on corrected data
  const calculatedCrc = crc8(correctedFrame.subarray(0, dataLen - 1));
  if (calculatedCrc !== correctedFrame[dataLen - 1]) {
    return { valid: false, errorsCorrected };
  }
  
  const seqWithEof = correctedFrame[0] | (correctedFrame[1] << 8);
  const seq = seqWithEof & 0x7FFF;
  const isEof = (seqWithEof & 0x8000) !== 0;
  const length = correctedFrame[2];
  
  // Sanity check length
  if (length > MAX_PAYLOAD_SIZE) {
    return { valid: false, errorsCorrected };
  }
  
  const payload = correctedFrame.subarray(3, 3 + length);
  
  return {
    valid: true,
    seq,
    isEof,
    payload,
    errorsCorrected
  };
}
