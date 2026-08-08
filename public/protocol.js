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
  const frameData = new Uint8Array(FRAME_CAPACITY);
  frameData[0] = flags;
  frameData[1] = (seed >> 8) & 0xff;
  frameData[2] = seed & 0xff;
  frameData[3] = (numChunks >> 8) & 0xff;
  frameData[4] = numChunks & 0xff;
  
  if (payload) {
    frameData.set(payload, HEADER_SIZE);
  }

  // Split into 6 blocks of 200 bytes
  const rsBlocks = [];
  for (let i = 0; i < 6; i++) {
    const blockData = frameData.slice(i * RS_DATA_SIZE, (i + 1) * RS_DATA_SIZE);
    rsBlocks.push(rsEncode(blockData, RS_ECC_SIZE)); // 240 bytes
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
    const dec = rsDecode(rsBlocks[i], RS_ECC_SIZE);
    if (!dec.valid) return { valid: false };
    totalErrors += dec.errorsCorrected;
    frameData.set(dec.data, i * RS_DATA_SIZE);
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
