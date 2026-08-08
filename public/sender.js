/**
 * sender.js — 64x64 RGB Grid + Fountain Codes
 */

const canvas = document.getElementById('gridCanvas');
const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const msgInput = document.getElementById('msgInput');
const fileInput = document.getElementById('fileInput');
const speedSlider = document.getElementById('speedSlider');
const speedLabel = document.getElementById('speedLabel');

// Config
const CELL_SIZE = 10;
canvas.width = GRID_SIZE * CELL_SIZE;
canvas.height = GRID_SIZE * CELL_SIZE;

const COLOR_MAP = [
  '#000000', // 000
  '#0000FF', // 001
  '#00FF00', // 010
  '#00FFFF', // 011
  '#FF0000', // 100
  '#FF00FF', // 101
  '#FFFF00', // 110
  '#FFFFFF'  // 111
];

let fountainEncoder = null;
let currentFlags = FLAG_TEXT;
let isTransmitting = false;
let txTimer = null;
let frameCount = 0;
let lastIdleColor = 0;
let idleTimer = null;

// UI Handlers
speedSlider.addEventListener('input', (e) => {
  speedLabel.textContent = e.target.value + 'ms';
  if (isTransmitting) {
    clearInterval(txTimer);
    txTimer = setInterval(renderNextFrame, parseInt(e.target.value, 10));
  }
});

btnStart.addEventListener('click', async () => {
  if (isTransmitting) return;

  const file = fileInput.files[0];
  let buffer;

  if (file) {
    if (file.size > 2 * 1024 * 1024) { // 2MB limit
      alert("File too large. Max 2MB.");
      return;
    }
    const fileBuffer = await file.arrayBuffer();
    const metaStr = JSON.stringify({ name: file.name, size: file.size, type: file.type });
    const metaBytes = new TextEncoder().encode(metaStr);
    
    buffer = new Uint8Array(2 + metaBytes.length + fileBuffer.byteLength);
    buffer[0] = (metaBytes.length >> 8) & 0xff;
    buffer[1] = metaBytes.length & 0xff;
    buffer.set(metaBytes, 2);
    buffer.set(new Uint8Array(fileBuffer), 2 + metaBytes.length);
    currentFlags = FLAG_FILE_DATA;
  } else {
    const text = msgInput.value.trim();
    if (!text) {
      alert("Enter text or select a file!");
      return;
    }
    buffer = new TextEncoder().encode(text);
    currentFlags = FLAG_TEXT;
  }

  // Initialize Fountain Encoder
  fountainEncoder = new FountainEncoder(buffer, MAX_PAYLOAD);
  
  isTransmitting = true;
  frameCount = 0;
  btnStart.disabled = true;
  btnStop.disabled = false;
  msgInput.disabled = true;
  fileInput.disabled = true;

  clearInterval(idleTimer);
  const ms = parseInt(speedSlider.value, 10);
  txTimer = setInterval(renderNextFrame, ms);
});

btnStop.addEventListener('click', () => {
  isTransmitting = false;
  clearInterval(txTimer);
  btnStart.disabled = false;
  btnStop.disabled = true;
  msgInput.disabled = false;
  fileInput.disabled = false;
  startIdlePattern();
});

// Render the grid
function renderNextFrame() {
  if (!isTransmitting || !fountainEncoder) return;

  // 1. Generate next Fountain Droplet
  const droplet = fountainEncoder.generateDroplet();
  const { rChannel, gChannel, bChannel } = encodeFrame(
    currentFlags,
    droplet.seed,
    fountainEncoder.K,
    droplet.payload
  );

  renderGrid(rChannel, gChannel, bChannel);

  frameCount++;
  const statsSpan = document.getElementById('stats');
  if (statsSpan) {
    statsSpan.textContent = `Transmitting (64x64 Fountain Code)... Droplets sent: ${frameCount} (K=${fountainEncoder.K})`;
  }
}

function renderGrid(rChannel, gChannel, bChannel) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw Anchors (White)
  ctx.fillStyle = '#FFF';
  ctx.fillRect(0, 0, ANCHOR_SIZE * CELL_SIZE, ANCHOR_SIZE * CELL_SIZE);
  ctx.fillRect((GRID_SIZE - ANCHOR_SIZE) * CELL_SIZE, 0, ANCHOR_SIZE * CELL_SIZE, ANCHOR_SIZE * CELL_SIZE);
  ctx.fillRect(0, (GRID_SIZE - ANCHOR_SIZE) * CELL_SIZE, ANCHOR_SIZE * CELL_SIZE, ANCHOR_SIZE * CELL_SIZE);
  ctx.fillRect((GRID_SIZE - ANCHOR_SIZE) * CELL_SIZE, (GRID_SIZE - ANCHOR_SIZE) * CELL_SIZE, ANCHOR_SIZE * CELL_SIZE, ANCHOR_SIZE * CELL_SIZE);

  // Draw Data Cells
  for (let i = 0; i < dataCellCoords.length; i++) {
    const { x, y } = dataCellCoords[i];
    
    const byteIdx = Math.floor(i / 8);
    const bitIdx = 7 - (i % 8);

    const r = (rChannel[byteIdx] >> bitIdx) & 1;
    const g = (gChannel[byteIdx] >> bitIdx) & 1;
    const b = (bChannel[byteIdx] >> bitIdx) & 1;
    
    const colorIdx = (r << 2) | (g << 1) | b;
    
    ctx.fillStyle = COLOR_MAP[colorIdx];
    ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
  }
}

// Visual Idle Pattern
function startIdlePattern() {
  clearInterval(idleTimer);
  idleTimer = setInterval(() => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#FFF';
    ctx.fillRect(0, 0, ANCHOR_SIZE * CELL_SIZE, ANCHOR_SIZE * CELL_SIZE);
    ctx.fillRect((GRID_SIZE - ANCHOR_SIZE) * CELL_SIZE, 0, ANCHOR_SIZE * CELL_SIZE, ANCHOR_SIZE * CELL_SIZE);
    ctx.fillRect(0, (GRID_SIZE - ANCHOR_SIZE) * CELL_SIZE, ANCHOR_SIZE * CELL_SIZE, ANCHOR_SIZE * CELL_SIZE);
    ctx.fillRect((GRID_SIZE - ANCHOR_SIZE) * CELL_SIZE, (GRID_SIZE - ANCHOR_SIZE) * CELL_SIZE, ANCHOR_SIZE * CELL_SIZE, ANCHOR_SIZE * CELL_SIZE);

    const rChannel = new Uint8Array(BYTES_PER_CHANNEL);
    const gChannel = new Uint8Array(BYTES_PER_CHANNEL);
    const bChannel = new Uint8Array(BYTES_PER_CHANNEL);

    for (let i = 0; i < BYTES_PER_CHANNEL; i++) {
      rChannel[i] = (lastIdleColor & 4) ? 0xff : 0;
      gChannel[i] = (lastIdleColor & 2) ? 0xff : 0;
      bChannel[i] = (lastIdleColor & 1) ? 0xff : 0;
    }
    
    lastIdleColor = (lastIdleColor + 1) % 8;
    if (lastIdleColor === 0) lastIdleColor = 1;

    for (let i = 0; i < dataCellCoords.length; i++) {
      const { x, y } = dataCellCoords[i];
      const byteIdx = Math.floor(i / 8);
      const bitIdx = 7 - (i % 8);
      
      const r = (rChannel[byteIdx] >> bitIdx) & 1;
      const g = (gChannel[byteIdx] >> bitIdx) & 1;
      const b = (bChannel[byteIdx] >> bitIdx) & 1;
      
      ctx.fillStyle = COLOR_MAP[(r << 2) | (g << 1) | b];
      ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
    }
    
    const statsSpan = document.getElementById('stats');
    if (statsSpan) statsSpan.textContent = "Idle (64x64 Grid)";
  }, 200);
}

startIdlePattern();
