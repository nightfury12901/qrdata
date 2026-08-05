/**
 * sender.js — Renders a 16×16 black/white data grid with 4 corner anchor
 * markers on a canvas element. The pattern is displayed for the receiver's
 * camera to decode.
 *
 * Grid layout (in "unit" coordinates, 24×24 total):
 *
 *   0  1  2  3  4 ................. 19 20 21 22 23
 *   ┌──┬──────┬──┬───────────────────┬──┬──────┬──┐
 * 0 │QZ│      │  │                   │  │      │QZ│
 * 1 │  │ TL■■ │  │                   │  │ ■■TR │  │
 * 2 │  │ ■■■■ │  │                   │  │ ■■■■ │  │
 * 3 │  │      │MG│                   │MG│      │  │
 * 4 │  │  MG  │  │  16×16 grid       │  │  MG  │  │
 *   │  │      │  │  of data          │  │      │  │
 *   │  │      │  │  cells            │  │      │  │
 *19 │  │      │  │                   │  │      │  │
 *20 │  │      │MG│                   │MG│      │  │
 *21 │  │ BL■■ │  │                   │  │ □□BR │  │  ← BR is hollow
 *22 │  │ ■■■■ │  │                   │  │ □□□□ │  │
 *23 │QZ│      │  │                   │  │      │QZ│
 *   └──┴──────┴──┴───────────────────┴──┴──────┴──┘
 *
 * QZ = quiet zone (white, 1 unit)
 * MG = margin (white, 1 unit gap between anchors and grid)
 * Anchors are 2×2 units. BR anchor is hollow (orientation marker).
 */

// ---- Layout constants (unit coordinates) ----
const GRID_SIZE = 32;
const TOTAL_UNITS = 42;
const GRID_ORIGIN = { x: 5, y: 5 }; // top-left corner of the 32x32 data grid

const ANCHORS = [
  { x: 1, y: 1,  hollow: false }, // TL
  { x: 39, y: 1, hollow: false }, // TR
  { x: 1, y: 39, hollow: false }, // BL
  { x: 39, y: 39, hollow: true }, // BR — orientation marker
];
const ANCHOR_SIZE = 2; // units

// ---- State ----
// The pattern array maps to the 1024 cells of the 32x32 grid (0 = black, 1 = white)
const pattern = new Uint8Array(GRID_SIZE * GRID_SIZE);

let txInterval = null;
let currentFrames = []; // Array of Uint8Array (32 bytes each)
let frameIndex = 0;

// ---- Canvas rendering ----
const canvas = document.getElementById('gridCanvas');
const ctx = canvas.getContext('2d');

function render() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  // Reserve space for the control panel so it doesn't overlap the top anchors
  const topReserved = 100;
  const availHeight = canvas.height - topReserved;

  const patternPx = Math.min(canvas.width, availHeight) * 0.85;
  const unit = patternPx / TOTAL_UNITS;

  const ox = (canvas.width - patternPx) / 2;
  const oy = topReserved + (availHeight - patternPx) / 2;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw anchors
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

  // Draw 32x32 data grid
  for (let row = 0; row < GRID_SIZE; row++) {
    for (let col = 0; col < GRID_SIZE; col++) {
      const cx = ox + (GRID_ORIGIN.x + col) * unit;
      const cy = oy + (GRID_ORIGIN.y + row) * unit;
      ctx.fillStyle = pattern[row * GRID_SIZE + col] ? '#ffffff' : '#000000';
      ctx.fillRect(cx, cy, unit, unit);
    }
  }
}

// Convert a 128-byte frame into the 1024-bit pattern array
function loadFrameToPattern(frameBytes) {
  for (let i = 0; i < 128; i++) {
    const byte = frameBytes[i];
    for (let bit = 0; bit < 8; bit++) {
      // Extract bits from MSB to LSB
      pattern[i * 8 + bit] = (byte >> (7 - bit)) & 1;
    }
  }
}

// ---- Transmission Logic ----

function startTransmission() {
  const text = document.getElementById('msgInput').value;
  if (!text) return;
  
  // Convert text to UTF-8
  const payloadBytes = new TextEncoder().encode(text);
  
  // Chunk payload into MAX_PAYLOAD_SIZE (28 bytes) chunks
  currentFrames = [];
  let offset = 0;
  let seq = 0;
  
  while (offset < payloadBytes.length || offset === 0 /* guarantee at least 1 frame */) {
    const chunk = payloadBytes.slice(offset, offset + MAX_PAYLOAD_SIZE);
    const isEof = (offset + MAX_PAYLOAD_SIZE) >= payloadBytes.length;
    
    // encodeFrame from protocol.js
    const frame = encodeFrame(seq, isEof, chunk);
    currentFrames.push(frame);
    
    offset += chunk.length;
    seq++;
  }
  
  frameIndex = 0;
  document.getElementById('btnStart').disabled = true;
  document.getElementById('btnStop').disabled = false;
  document.getElementById('msgInput').disabled = true;
  document.getElementById('txStatus').textContent = 'Transmitting...';
  
  // Transmit loop (target 30 FPS = ~33ms per frame)
  txInterval = setInterval(() => {
    loadFrameToPattern(currentFrames[frameIndex]);
    render();
    
    document.getElementById('txFrame').textContent = `Frame ${frameIndex + 1} of ${currentFrames.length}`;
    
    frameIndex = (frameIndex + 1) % currentFrames.length; // Loop infinitely
  }, 33);
}

function stopTransmission() {
  if (txInterval) {
    clearInterval(txInterval);
    txInterval = null;
  }
  document.getElementById('btnStart').disabled = false;
  document.getElementById('btnStop').disabled = true;
  document.getElementById('msgInput').disabled = false;
  document.getElementById('txStatus').textContent = 'Idle';
  document.getElementById('txFrame').textContent = '—';
}

// ---- Init ----
document.getElementById('btnStart').addEventListener('click', startTransmission);
document.getElementById('btnStop').addEventListener('click', stopTransmission);
window.addEventListener('resize', render);

// Set default empty checkerboard pattern
for (let i = 0; i < 1024; i++) {
  const row = Math.floor(i / 32);
  const col = i % 32;
  pattern[i] = (row + col) % 2;
}
render();
