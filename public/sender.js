/**
 * sender.js — Renders a 32×32 RGB data grid with 4 corner anchor
 * markers on a canvas element. Each cell encodes 3 bits (R, G, B).
 *
 * The anchors remain black/white for reliable detection.
 * Data cells use 8 distinct RGB colors (one per 3-bit combination).
 */

// ---- Layout constants (unit coordinates) ----
const GRID_SIZE = 32;
const TOTAL_UNITS = 46;
const GRID_ORIGIN = { x: 7, y: 7 };

const ANCHORS = [
  { x: 3, y: 3,  hollow: false }, // TL
  { x: 41, y: 3, hollow: false }, // TR
  { x: 3, y: 41, hollow: false }, // BL
  { x: 41, y: 41, hollow: true }, // BR — orientation marker
];
const ANCHOR_SIZE = 2; // units

// ---- State ----
// 3 pattern arrays: one per color channel (0 = off, 1 = on)
const patternR = new Uint8Array(GRID_SIZE * GRID_SIZE);
const patternG = new Uint8Array(GRID_SIZE * GRID_SIZE);
const patternB = new Uint8Array(GRID_SIZE * GRID_SIZE);

let txInterval = null;
let sourceChunks = [];
let metadataFrameBlocks = null;
let fountainSeq = 0;

// ---- Canvas rendering ----
const canvas = document.getElementById('gridCanvas');
const ctx = canvas.getContext('2d');

function render() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const topReserved = 100;
  const availHeight = canvas.height - topReserved;

  const patternPx = Math.min(canvas.width, availHeight) * 0.85;
  const unit = patternPx / TOTAL_UNITS;

  const ox = (canvas.width - patternPx) / 2;
  const oy = topReserved + (availHeight - patternPx) / 2;

  // White background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw anchors (always black/white)
  for (const anchor of ANCHORS) {
    const ax = ox + anchor.x * unit;
    const ay = oy + anchor.y * unit;
    const as = ANCHOR_SIZE * unit;

    ctx.fillStyle = '#000000';
    ctx.fillRect(ax, ay, as, as);

    if (anchor.hollow) {
      const inset = as * 0.25;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(ax + inset, ay + inset, as - 2 * inset, as - 2 * inset);
    }
  }

  // Draw 32x32 RGB data grid
  for (let row = 0; row < GRID_SIZE; row++) {
    for (let col = 0; col < GRID_SIZE; col++) {
      const idx = row * GRID_SIZE + col;
      const r = patternR[idx] * 255;
      const g = patternG[idx] * 255;
      const b = patternB[idx] * 255;

      const cx = ox + (GRID_ORIGIN.x + col) * unit;
      const cy = oy + (GRID_ORIGIN.y + row) * unit;
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(cx, cy, Math.ceil(unit), Math.ceil(unit));
    }
  }
}

// Load 3 RS-encoded blocks into the RGB pattern arrays
function loadBlocksToPattern(blocks) {
  const [rBlock, gBlock, bBlock] = blocks;
  for (let i = 0; i < 128; i++) {
    for (let bit = 0; bit < 8; bit++) {
      const cellIdx = i * 8 + bit;
      if (cellIdx >= GRID_SIZE * GRID_SIZE) break;
      
      const row = Math.floor(cellIdx / GRID_SIZE);
      const col = cellIdx % GRID_SIZE;
      const mask = (row + col) % 2; // spatial mask prevents false anchors
      
      patternR[cellIdx] = ((rBlock[i] >> (7 - bit)) & 1) ^ mask;
      patternG[cellIdx] = ((gBlock[i] >> (7 - bit)) & 1) ^ mask;
      patternB[cellIdx] = ((bBlock[i] >> (7 - bit)) & 1) ^ mask;
    }
  }
}

// ---- Transmission Logic ----

async function prepareSession() {
  const text = document.getElementById('msgInput').value;
  const fileInput = document.getElementById('fileInput');
  const file = fileInput.files[0];

  if (!text && !file) return;

  sourceChunks = [];
  let payloadBytes;
  
  const metaObj = {
    name: "text.txt",
    size: 0,
    type: "text/plain",
    totalChunks: 0
  };

  if (file) {
    if (file.size > 1024 * 1024) {
      alert("File is too large (max 1MB)");
      return;
    }
    metaObj.name = file.name;
    metaObj.size = file.size;
    metaObj.type = file.type;
    const arrayBuffer = await file.arrayBuffer();
    payloadBytes = new Uint8Array(arrayBuffer);
  } else {
    payloadBytes = new TextEncoder().encode(text);
    metaObj.size = payloadBytes.length;
  }

  // Chunk the data
  let offset = 0;
  while (offset < payloadBytes.length || offset === 0) {
    // Pad chunks to MAX_PAYLOAD_SIZE so XOR works properly
    const chunk = new Uint8Array(MAX_PAYLOAD_SIZE);
    const slice = payloadBytes.slice(offset, offset + MAX_PAYLOAD_SIZE);
    chunk.set(slice);
    sourceChunks.push(chunk);
    offset += slice.length;
  }
  
  metaObj.totalChunks = sourceChunks.length;

  // Create Metadata Frame (Handshake)
  const metaBytes = new TextEncoder().encode(JSON.stringify(metaObj));
  metadataFrameBlocks = encodeFrame(0, true, FLAG_FILE_META, metaBytes);
  
  // Display the handshake frame statically
  loadBlocksToPattern(metadataFrameBlocks);
  render();

  document.getElementById('btnPrepare').disabled = true;
  document.getElementById('btnStart').disabled = false;
  document.getElementById('msgInput').disabled = true;
  document.getElementById('fileInput').disabled = true;
  document.getElementById('txStatus').textContent = 'Handshake Ready';
  document.getElementById('txChunks').textContent = `${sourceChunks.length} chunks`;
}

function startBroadcast() {
  document.getElementById('btnStart').disabled = true;
  document.getElementById('btnStop').disabled = false;
  document.getElementById('speedSlider').disabled = true;
  document.getElementById('txStatus').textContent = 'Broadcasting...';

  const speedMs = parseInt(document.getElementById('speedSlider').value);
  fountainSeq = 1; // start fountain seq at 1

  txInterval = setInterval(() => {
    // 1. Get random indices for this sequence number
    const indices = getFountainIndices(fountainSeq, sourceChunks.length);
    
    // 2. XOR the selected chunks together
    const xorPayload = new Uint8Array(MAX_PAYLOAD_SIZE);
    for (const idx of indices) {
      for (let i = 0; i < MAX_PAYLOAD_SIZE; i++) {
        xorPayload[i] ^= sourceChunks[idx][i];
      }
    }
    
    // 3. Encode the frame and load to pattern
    const blocks = encodeFrame(fountainSeq, false, FLAG_FOUNTAIN_DATA, xorPayload);
    loadBlocksToPattern(blocks);
    render();

    document.getElementById('txFrame').textContent = `Fountain Frame: ${fountainSeq}`;
    fountainSeq++;
  }, speedMs);
}

function stopTransmission() {
  if (txInterval) {
    clearInterval(txInterval);
    txInterval = null;
  }
  document.getElementById('btnPrepare').disabled = false;
  document.getElementById('btnStart').disabled = true;
  document.getElementById('btnStop').disabled = true;
  document.getElementById('msgInput').disabled = false;
  document.getElementById('fileInput').disabled = false;
  document.getElementById('speedSlider').disabled = false;
  document.getElementById('txStatus').textContent = 'Idle';
  document.getElementById('txFrame').textContent = '—';
  document.getElementById('txChunks').textContent = '';
}

// ---- Init ----
document.getElementById('btnPrepare').addEventListener('click', prepareSession);
document.getElementById('btnStart').addEventListener('click', startBroadcast);
document.getElementById('btnStop').addEventListener('click', stopTransmission);
window.addEventListener('resize', render);

const speedSlider = document.getElementById('speedSlider');
const speedLabel = document.getElementById('speedLabel');
speedSlider.addEventListener('input', () => {
  speedLabel.textContent = `${speedSlider.value}ms`;
});

// Default rainbow pattern to show off RGB mode
for (let i = 0; i < GRID_SIZE * GRID_SIZE; i++) {
  const row = Math.floor(i / GRID_SIZE);
  const col = i % GRID_SIZE;
  // Create a colorful pattern: cycle through all 8 colors
  const colorIdx = (row + col) % 8;
  patternR[i] = (colorIdx >> 2) & 1;
  patternG[i] = (colorIdx >> 1) & 1;
  patternB[i] = colorIdx & 1;
}
render();
