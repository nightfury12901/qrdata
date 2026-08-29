/**
 * sender.js — Renders a 32×32 RGB data grid with 4 corner anchor
 * markers on a canvas element. Each cell encodes 3 bits (R, G, B).
 *
 * The anchors remain black/white for reliable detection.
 * Data cells use 8 distinct RGB colors (one per 3-bit combination).
 */

// ---- Layout constants (unit coordinates) ----
const GRID_SIZE = 74;
const TOTAL_UNITS = 92;
const GRID_ORIGIN = { x: 9, y: 9 };

const ANCHORS = [
  { x: 3, y: 3,  color: '#000000' }, // TL
  { x: 85, y: 3, color: '#000000' }, // TR
  { x: 3, y: 85, color: '#000000' }, // BL
  { x: 85, y: 85, color: '#000000' }, // BR — Blue orientation dot added below
];
const ANCHOR_SIZE = 4; // units

// ---- State ----
// 3 pattern arrays: one per color channel (0 = off, 1 = on)
const patternR = new Uint8Array(GRID_SIZE * GRID_SIZE);
const patternG = new Uint8Array(GRID_SIZE * GRID_SIZE);
const patternB = new Uint8Array(GRID_SIZE * GRID_SIZE);

let txInterval = null;
let sourceChunks = [];
let metadataFrameBlocks = null;
let fountainSeq = 0;

// Audio NACK/ACK state
let audioCtx = null;
let analyser = null;
let isNackActive = false;
let audioListenLoopId = null;

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

  // Draw anchors
  for (const anchor of ANCHORS) {
    const ax = ox + anchor.x * unit;
    const ay = oy + anchor.y * unit;
    const as = ANCHOR_SIZE * unit;

    ctx.fillStyle = anchor.color;
    ctx.fillRect(ax, ay, as, as);
    
    // Draw blue orientation dot OUTSIDE the BR anchor in the margin (at unit 89, 89)
    // This keeps the anchor purely black so the detector doesn't break.
    if (anchor.x === 85 && anchor.y === 85) {
      ctx.fillStyle = '#0000FF';
      ctx.fillRect(ox + 89 * unit, oy + 89 * unit, 2 * unit, 2 * unit);
    }
  }

  // Draw 32x32 RGB data grid
  for (let row = 0; row < GRID_SIZE; row++) {
    for (let col = 0; col < GRID_SIZE; col++) {
      const idx = row * GRID_SIZE + col;
      // Map 0, 1, 2, 3 to 85, 141, 197, 253 to guarantee they are strictly lighter than the black anchors
      const r = 85 + patternR[idx] * 56;
      const g = 85 + patternG[idx] * 56;
      const b = 85 + patternB[idx] * 56;

      const cx = ox + (GRID_ORIGIN.x + col) * unit;
      const cy = oy + (GRID_ORIGIN.y + row) * unit;
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(cx, cy, Math.ceil(unit), Math.ceil(unit));
    }
  }
}

// Load 3 RS-encoded blocks into the RGB pattern arrays
function loadBlocksToPattern(blocks) {
  const [rBlock, gBlock, bBlock] = blocks; // each block is 1368 bytes
  
  // Calibration cells (unmasked) for the receiver to measure brightness levels
  patternR[0] = 0; patternG[0] = 0; patternB[0] = 0;
  patternR[1] = 1; patternG[1] = 1; patternB[1] = 1;
  patternR[2] = 2; patternG[2] = 2; patternB[2] = 2;
  patternR[3] = 3; patternG[3] = 3; patternB[3] = 3;

  for (let i = 0; i < 5472; i++) {
    const cellIdx = i + 4; // Skip the 4 calibration cells
    const row = Math.floor(cellIdx / GRID_SIZE);
    const col = cellIdx % GRID_SIZE;
    
    // Spatial mask to prevent large uniform blocks (0 or 3)
    const mask = ((row + col) % 2) * 3; 
    
    const byteIdx = Math.floor(i / 4);
    const shift = 6 - (i % 4) * 2; // extracts 2 bits at a time from MSB to LSB
    
    patternR[cellIdx] = ((rBlock[byteIdx] >> shift) & 3) ^ mask;
    patternG[cellIdx] = ((gBlock[byteIdx] >> shift) & 3) ^ mask;
    patternB[cellIdx] = ((bBlock[byteIdx] >> shift) & 3) ^ mask;
  }
}

// ---- Audio NACK / ACK Listener ----
async function initAudioListener() {
  if (audioCtx) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 4096;
    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);
    
    analyzeAudio();
  } catch (e) {
    console.error("Audio NACK listener failed:", e);
  }
}

function analyzeAudio() {
  audioListenLoopId = requestAnimationFrame(analyzeAudio);
  if (!txInterval || !sourceChunks.length) return; // Only process when transmitting
  
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Float32Array(bufferLength);
  analyser.getFloatFrequencyData(dataArray);
  
  const binSize = audioCtx.sampleRate / analyser.fftSize;
  
  const getPeak = (minFreq, maxFreq) => {
    let maxVal = -Infinity;
    let peakFreq = 0;
    const minBin = Math.floor(minFreq / binSize);
    const maxBin = Math.ceil(maxFreq / binSize);
    for (let i = minBin; i <= maxBin; i++) {
      if (dataArray[i] > maxVal) {
        maxVal = dataArray[i];
        peakFreq = i * binSize;
      }
    }
    return { val: maxVal, freq: peakFreq };
  };
  
  const threshold = -60; // dB
  
  // Check for ACK
  const ackPeak = getPeak(19300, 19700);
  if (ackPeak.val > threshold) {
    console.log("[Audio ACK] Transfer complete signal received!");
    stopTransmission();
    document.getElementById('txStatus').textContent = 'Transfer Complete (ACK)';
    return;
  }
  
  // Check for NACK (18kHz band)
  const nackPeak = getPeak(17500, 18500);
  
  if (nackPeak.val > threshold) {
    if (!isNackActive) console.log("[Audio NACK] Receiver requested fountain packets!");
    isNackActive = true;
  } else {
    isNackActive = false;
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

  initAudioListener();

  const speedMs = parseInt(document.getElementById('speedSlider').value);
  fountainSeq = 0; // start fountain seq at 0 for systematic transmission
  let nackFountainSeq = sourceChunks.length; // start sending fountain packets from here if NACKed

  txInterval = setInterval(() => {
    let currentSeq;
    if (isNackActive) {
      currentSeq = nackFountainSeq++;
      document.getElementById('txStatus').textContent = 'Broadcasting (Auto-Healing)...';
      document.getElementById('txStatus').className = 'value warn';
    } else {
      currentSeq = fountainSeq++;
      document.getElementById('txStatus').textContent = 'Broadcasting...';
      document.getElementById('txStatus').className = 'value';
    }

    // 1. Get indices for this sequence number
    const indices = getFountainIndices(currentSeq, sourceChunks.length);
    
    // 2. XOR the selected chunks together
    const xorPayload = new Uint8Array(MAX_PAYLOAD_SIZE);
    for (const idx of indices) {
      for (let i = 0; i < MAX_PAYLOAD_SIZE; i++) {
        xorPayload[i] ^= sourceChunks[idx][i];
      }
    }
    
    // 3. Encode the frame and load to pattern
    const blocks = encodeFrame(currentSeq, false, FLAG_FOUNTAIN_DATA, xorPayload);
    loadBlocksToPattern(blocks);
    render();

    document.getElementById('txFrame').textContent = `Frame: ${currentSeq}`;
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

// Default pattern: Random static to prevent structured blobs
for (let i = 0; i < GRID_SIZE * GRID_SIZE; i++) {
  const row = Math.floor(i / GRID_SIZE);
  const col = i % GRID_SIZE;
  const mask = (row + col) % 2;
  
  // Random color bits XORed with spatial mask
  patternR[i] = (Math.random() > 0.5 ? 1 : 0) ^ mask;
  patternG[i] = (Math.random() > 0.5 ? 1 : 0) ^ mask;
  patternB[i] = (Math.random() > 0.5 ? 1 : 0) ^ mask;
}
render();
