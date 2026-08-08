/**
 * sender.js — 64x64 RGB Grid + Fountain Codes (v8 — robust)
 */

// ---- DOM ----
const canvas = document.getElementById('gridCanvas');
const ctx = canvas.getContext('2d', { alpha: false });
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const msgInput = document.getElementById('msgInput');
const fileInput = document.getElementById('fileInput');
const speedSlider = document.getElementById('speedSlider');
const speedLabel = document.getElementById('speedLabel');
const txStatus = document.getElementById('txStatus');
const txFrame = document.getElementById('txFrame');

// ---- Config ----
const CELL_SIZE = 10;
canvas.width = GRID_SIZE * CELL_SIZE;
canvas.height = GRID_SIZE * CELL_SIZE;

const COLOR_MAP = ['#000000','#0000FF','#00FF00','#00FFFF','#FF0000','#FF00FF','#FFFF00','#FFFFFF'];

// ---- State ----
let fountainEncoder = null;
let currentFlags = FLAG_TEXT;
let isTransmitting = false;
let txTimer = null;
let idleTimer = null;
let idleColor = 1;
let frameCount = 0;

// ---- Speed slider ----
speedSlider.addEventListener('input', () => {
  speedLabel.textContent = speedSlider.value + 'ms';
  if (isTransmitting && txTimer) {
    clearInterval(txTimer);
    txTimer = setInterval(sendFrame, parseInt(speedSlider.value, 10));
  }
});

// ---- Start TX ----
btnStart.addEventListener('click', async () => {
  if (isTransmitting) return;

  try {
    const file = fileInput.files[0];
    let buffer;

    if (file) {
      if (file.size > 2 * 1024 * 1024) {
        alert('File too large. Max 2MB for now.');
        return;
      }
      const fileBuffer = await file.arrayBuffer();
      const metaStr = JSON.stringify({ name: file.name, size: file.size, type: file.type || 'application/octet-stream' });
      const metaBytes = new TextEncoder().encode(metaStr);

      // Layout: [metaLen(2)] + [meta] + [fileData]
      buffer = new Uint8Array(2 + metaBytes.length + fileBuffer.byteLength);
      buffer[0] = (metaBytes.length >> 8) & 0xff;
      buffer[1] = metaBytes.length & 0xff;
      buffer.set(metaBytes, 2);
      buffer.set(new Uint8Array(fileBuffer), 2 + metaBytes.length);
      currentFlags = FLAG_FILE_DATA;
    } else {
      const text = msgInput.value.trim();
      if (!text) { alert('Enter a message or choose a file!'); return; }
      buffer = new TextEncoder().encode(text);
      currentFlags = FLAG_TEXT;
    }

    // Init Fountain Encoder
    fountainEncoder = new FountainEncoder(buffer, MAX_PAYLOAD);
    frameCount = 0;

    // Switch to TX mode
    clearInterval(idleTimer);
    idleTimer = null;
    isTransmitting = true;

    btnStart.disabled = true;
    btnStop.disabled = false;
    msgInput.disabled = true;
    fileInput.disabled = true;

    if (txStatus) txStatus.textContent = 'Transmitting…';

    const ms = parseInt(speedSlider.value, 10);
    txTimer = setInterval(sendFrame, ms);

  } catch (err) {
    alert('Start TX failed: ' + err.message);
    console.error(err);
  }
});

// ---- Stop ----
btnStop.addEventListener('click', stopTX);

function stopTX() {
  clearInterval(txTimer);
  txTimer = null;
  isTransmitting = false;

  btnStart.disabled = false;
  btnStop.disabled = true;
  msgInput.disabled = false;
  fileInput.disabled = false;

  if (txStatus) txStatus.textContent = 'Idle';
  if (txFrame) txFrame.textContent = '—';

  startIdle();
}

// ---- Core send loop ----
function sendFrame() {
  if (!isTransmitting || !fountainEncoder) return;

  try {
    const droplet = fountainEncoder.generateDroplet();
    const { rChannel, gChannel, bChannel } = encodeFrame(
      currentFlags,
      droplet.seed,
      fountainEncoder.K,
      droplet.payload
    );

    paintGrid(rChannel, gChannel, bChannel);
    frameCount++;

    if (txStatus) txStatus.textContent = 'Transmitting…';
    if (txFrame) txFrame.textContent = `Droplet ${frameCount} / K=${fountainEncoder.K}`;

  } catch (err) {
    console.error('sendFrame error:', err);
    alert('Frame encode error: ' + err.message);
    stopTX();
  }
}

// ---- Grid renderer ----
function paintGrid(rChannel, gChannel, bChannel) {
  // Fill black background
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // White anchor squares (8x8 in corners)
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, ANCHOR_SIZE * CELL_SIZE, ANCHOR_SIZE * CELL_SIZE);
  ctx.fillRect((GRID_SIZE - ANCHOR_SIZE) * CELL_SIZE, 0, ANCHOR_SIZE * CELL_SIZE, ANCHOR_SIZE * CELL_SIZE);
  ctx.fillRect(0, (GRID_SIZE - ANCHOR_SIZE) * CELL_SIZE, ANCHOR_SIZE * CELL_SIZE, ANCHOR_SIZE * CELL_SIZE);
  ctx.fillRect((GRID_SIZE - ANCHOR_SIZE) * CELL_SIZE, (GRID_SIZE - ANCHOR_SIZE) * CELL_SIZE, ANCHOR_SIZE * CELL_SIZE, ANCHOR_SIZE * CELL_SIZE);

  // Data cells
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

// ---- Idle animation ----
function startIdle() {
  if (idleTimer) return;
  idleColor = 1;
  idleTimer = setInterval(paintIdle, 400);
}

function paintIdle() {
  // Fill black background
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // White anchors
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, ANCHOR_SIZE * CELL_SIZE, ANCHOR_SIZE * CELL_SIZE);
  ctx.fillRect((GRID_SIZE - ANCHOR_SIZE) * CELL_SIZE, 0, ANCHOR_SIZE * CELL_SIZE, ANCHOR_SIZE * CELL_SIZE);
  ctx.fillRect(0, (GRID_SIZE - ANCHOR_SIZE) * CELL_SIZE, ANCHOR_SIZE * CELL_SIZE, ANCHOR_SIZE * CELL_SIZE);
  ctx.fillRect((GRID_SIZE - ANCHOR_SIZE) * CELL_SIZE, (GRID_SIZE - ANCHOR_SIZE) * CELL_SIZE, ANCHOR_SIZE * CELL_SIZE, ANCHOR_SIZE * CELL_SIZE);

  // Checkerboard with current idle color
  const color = COLOR_MAP[idleColor];
  const altColor = '#000000';
  for (let i = 0; i < dataCellCoords.length; i++) {
    const { x, y } = dataCellCoords[i];
    ctx.fillStyle = ((x + y) % 2 === 0) ? color : altColor;
    ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
  }

  idleColor = (idleColor % 7) + 1; // cycle 1..7
  if (txStatus) txStatus.textContent = 'Idle';
}

// ---- Boot ----
startIdle();
