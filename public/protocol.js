// protocol.js
// 64x64 Grid with LT Fountain Codes & Reed-Solomon Erasure handling

const GRID_SIZE = 64;
const TOTAL_UNITS = GRID_SIZE * GRID_SIZE;

// 8x8 anchors in the 4 corners
const ANCHOR_SIZE = 8;
const ANCHOR_CELLS = 4 * (ANCHOR_SIZE * ANCHOR_SIZE); // 256 cells
const DATA_CELLS = TOTAL_UNITS - ANCHOR_CELLS; // 3840 cells
const BYTES_PER_CHANNEL = DATA_CELLS / 8; // 480 bytes

// We split each 480-byte channel into 2 RS blocks of 240 bytes
const RS_BLOCK_SIZE = 240;
const RS_ECC_SIZE = 40;
const RS_DATA_SIZE = 200;

// Total capacity across R, G, B (each has 2 blocks of 200 data bytes)
const FRAME_CAPACITY = 3 * 2 * RS_DATA_SIZE; // 1200 bytes

const FLAG_TEXT = 0;
const FLAG_FILE_META = 1;
const FLAG_FILE_DATA = 2;

// Header size
const HEADER_SIZE = 8;
const MAX_PAYLOAD = FRAME_CAPACITY - HEADER_SIZE; // 1192 bytes

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

function isAnchor(x, y) {
  return (
    (x < ANCHOR_SIZE && y < ANCHOR_SIZE) ||
    (x >= GRID_SIZE - ANCHOR_SIZE && y < ANCHOR_SIZE) ||
    (x < ANCHOR_SIZE && y >= GRID_SIZE - ANCHOR_SIZE) ||
    (x >= GRID_SIZE - ANCHOR_SIZE && y >= GRID_SIZE - ANCHOR_SIZE)
  );
}

// Generate the sequence of (x, y) coords for data cells
const dataCellCoords = [];
for (let y = 0; y < GRID_SIZE; y++) {
  for (let x = 0; x < GRID_SIZE; x++) {
    if (!isAnchor(x, y)) {
      dataCellCoords.push({ x, y });
    }
  }
}

/**
 * Encode a fountain droplet or standard message into 3 color channels.
 * @param {number} flags - 0, 1, 2
 * @param {number} seed - LT droplet seed
 * @param {number} numChunks - K
 * @param {Uint8Array} payload - the droplet data
 */
function encodeFrame(flags, seed, numChunks, payload) {
  initRS();
  
  const frameData = new Uint8Array(FRAME_CAPACITY);
  frameData[0] = flags;
  frameData[1] = (seed >> 8) & 0xff;
  frameData[2] = seed & 0xff;
  frameData[3] = (numChunks >> 8) & 0xff;
  frameData[4] = numChunks & 0xff;
  
  if (payload) {
    frameData.set(payload, HEADER_SIZE);
  }

  // Split into 6 blocks of 200 bytes and RS Encode to 240 bytes
  const rsBlocks = [];
  for (let i = 0; i < 6; i++) {
    const offset = i * RS_DATA_SIZE;
    const rsData = new Int32Array(RS_BLOCK_SIZE); // 240
    for (let j = 0; j < RS_DATA_SIZE; j++) {
      rsData[j] = frameData[offset + j];
    }
    rsEncoder.encode(rsData, RS_ECC_SIZE);
    
    const encoded = new Uint8Array(RS_BLOCK_SIZE);
    for (let j = 0; j < RS_BLOCK_SIZE; j++) {
      encoded[j] = rsData[j];
    }
    rsBlocks.push(encoded);
  }

  // Combine into R, G, B channels
  const rChannel = new Uint8Array(BYTES_PER_CHANNEL);
  rChannel.set(rsBlocks[0], 0);
  rChannel.set(rsBlocks[1], RS_BLOCK_SIZE);

  const gChannel = new Uint8Array(BYTES_PER_CHANNEL);
  gChannel.set(rsBlocks[2], 0);
  gChannel.set(rsBlocks[3], RS_BLOCK_SIZE);

  const bChannel = new Uint8Array(BYTES_PER_CHANNEL);
  bChannel.set(rsBlocks[4], 0);
  bChannel.set(rsBlocks[5], RS_BLOCK_SIZE);

  return { rChannel, gChannel, bChannel };
}

/**
 * Decode from R, G, B channels.
 */
function decodeFrame(rChannel, gChannel, bChannel) {
  initRS();

  const rsBlocks = [
    rChannel.slice(0, RS_BLOCK_SIZE),
    rChannel.slice(RS_BLOCK_SIZE, 2 * RS_BLOCK_SIZE),
    gChannel.slice(0, RS_BLOCK_SIZE),
    gChannel.slice(RS_BLOCK_SIZE, 2 * RS_BLOCK_SIZE),
    bChannel.slice(0, RS_BLOCK_SIZE),
    bChannel.slice(RS_BLOCK_SIZE, 2 * RS_BLOCK_SIZE)
  ];

  const frameData = new Uint8Array(FRAME_CAPACITY);
  let totalErrors = 0;

  for (let i = 0; i < 6; i++) {
    const rsData = new Int32Array(RS_BLOCK_SIZE);
    for (let j = 0; j < RS_BLOCK_SIZE; j++) {
      rsData[j] = rsBlocks[i][j];
    }

    try {
      rsDecoder.decode(rsData, RS_ECC_SIZE);
      // Wait, rsDecoder.decode does not return errors corrected in this library.
      // We just catch exceptions if uncorrectable.
      totalErrors += 0; // We can't know exactly without diffing. 
    } catch (e) {
      return { valid: false };
    }

    for (let j = 0; j < RS_DATA_SIZE; j++) {
      frameData[i * RS_DATA_SIZE + j] = rsData[j];
    }
  }

  const flags = frameData[0];
  const seed = (frameData[1] << 8) | frameData[2];
  const numChunks = (frameData[3] << 8) | frameData[4];
  const payload = frameData.slice(HEADER_SIZE);

  return {
    valid: true,
    errorsCorrected: totalErrors,
    flags,
    seed,
    numChunks,
    payload
  };
}
