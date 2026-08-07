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
let currentFrames = []; // Array of [rBlock, gBlock, bBlock] arrays
let frameIndex = 0;

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
      patternR[cellIdx] = (rBlock[i] >> (7 - bit)) & 1;
      patternG[cellIdx] = (gBlock[i] >> (7 - bit)) & 1;
      patternB[cellIdx] = (bBlock[i] >> (7 - bit)) & 1;
    }
  }
}

// ---- Transmission Logic ----

async function startTransmission() {
  const text = document.getElementById('msgInput').value;
  const fileInput = document.getElementById('fileInput');
  const file = fileInput.files[0];

  if (!text && !file) return;

  currentFrames = [];
  let seq = 0;

  if (file) {
    if (file.size > 1024 * 1024) {
      alert("File is too large (max 1MB)");
      return;
    }
    
    // Create Metadata Frame (filename, size, mime)
    const metaObj = {
      name: file.name,
      size: file.size,
      type: file.type
    };
    const metaBytes = new TextEncoder().encode(JSON.stringify(metaObj));
    currentFrames.push(encodeFrame(seq++, false, FLAG_FILE_META, metaBytes));

    // Chunk File Data
    const arrayBuffer = await file.arrayBuffer();
    const payloadBytes = new Uint8Array(arrayBuffer);
    
    let offset = 0;
    while (offset < payloadBytes.length) {
      const chunk = payloadBytes.slice(offset, offset + MAX_PAYLOAD_SIZE);
      const isEof = (offset + MAX_PAYLOAD_SIZE) >= payloadBytes.length;
      currentFrames.push(encodeFrame(seq++, isEof, FLAG_FILE_DATA, chunk));
      offset += chunk.length;
    }
  } else {
    // Regular text transmission
    const payloadBytes = new TextEncoder().encode(text);
    let offset = 0;
    while (offset < payloadBytes.length || offset === 0) {
      const chunk = payloadBytes.slice(offset, offset + MAX_PAYLOAD_SIZE);
      const isEof = (offset + MAX_PAYLOAD_SIZE) >= payloadBytes.length;
      currentFrames.push(encodeFrame(seq++, isEof, FLAG_TEXT, chunk));
      offset += chunk.length;
    }
  }

  frameIndex = 0;
  document.getElementById('btnStart').disabled = true;
  document.getElementById('btnStop').disabled = false;
  document.getElementById('msgInput').disabled = true;
  document.getElementById('fileInput').disabled = true;
  document.getElementById('speedSlider').disabled = true;
  document.getElementById('txStatus').textContent = 'Transmitting...';

  const speedMs = parseInt(document.getElementById('speedSlider').value);

  // Transmit loop
  txInterval = setInterval(() => {
    loadBlocksToPattern(currentFrames[frameIndex]);
    render();

    document.getElementById('txFrame').textContent = `Frame ${frameIndex + 1} of ${currentFrames.length}`;

    frameIndex = (frameIndex + 1) % currentFrames.length;
  }, speedMs);
}

function stopTransmission() {
  if (txInterval) {
    clearInterval(txInterval);
    txInterval = null;
  }
  document.getElementById('btnStart').disabled = false;
  document.getElementById('btnStop').disabled = true;
  document.getElementById('msgInput').disabled = false;
  document.getElementById('fileInput').disabled = false;
  document.getElementById('speedSlider').disabled = false;
  document.getElementById('txStatus').textContent = 'Idle';
  document.getElementById('txFrame').textContent = '—';
}

// ---- Init ----
document.getElementById('btnStart').addEventListener('click', startTransmission);
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
