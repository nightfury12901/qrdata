/**
 * receiver.js — Camera capture and grid decode pipeline.
 *
 * Captures video from the rear camera, processes each frame to detect
 * the Photon grid pattern, and displays decoded data + performance stats.
 *
 * Depends on: detect.js (toGrayscale, otsuThreshold, binarize, findBlobs,
 *             filterAnchors, identifyAnchors, sampleArea)
 *             homography.js (computeHomography, projectPoint)
 */

// ---- Layout constants (must match sender.js) ----
const GRID_SIZE = 40;
const TOTAL_UNITS = 58;
const GRID_ORIGIN_X = 9;
const GRID_ORIGIN_Y = 9;

// Ideal anchor centers in unit coordinates
const IDEAL_ANCHORS = {
  TL: [5, 5],
  TR: [53, 5],
  BL: [5, 53],
  BR: [53, 53],
};

// Ideal cell centers
const IDEAL_CELLS = [];
for (let row = 0; row < GRID_SIZE; row++) {
  for (let col = 0; col < GRID_SIZE; col++) {
    IDEAL_CELLS.push([GRID_ORIGIN_X + col + 0.5, GRID_ORIGIN_Y + row + 0.5]);
  }
}

// ---- Processing config ----
const PROC_SCALE = 1.0; // Process at full camera resolution for 32x32 density
const SAMPLE_RADIUS = 2; // Pixel radius for cell brightness sampling

// ---- DOM elements ----
const video = document.getElementById('cameraVideo');
const overlay = document.getElementById('overlayCanvas');
const overlayCtx = overlay.getContext('2d');

// Stats DOM
const statStatus = document.getElementById('statStatus');
const statFPS = document.getElementById('statFPS');
const statRate = document.getElementById('statRate');
const statThroughput = document.getElementById('statThroughput');
const statProgress = document.getElementById('statProgress');
const statErrors = document.getElementById('statErrors');
const statAnchors = document.getElementById('statAnchors');
const statPxCell = document.getElementById('statPxCell');
const statMessage = document.getElementById('statMessage');
const btnCopy = document.getElementById('btnCopy');
const btnReset = document.getElementById('btnReset');
const btnDownload = document.getElementById('btnDownload');

if (btnCopy) {
  btnCopy.addEventListener('click', () => {
    statMessage.select();
    document.execCommand('copy');
    const oldText = btnCopy.textContent;
    btnCopy.textContent = 'Copied!';
    setTimeout(() => btnCopy.textContent = oldText, 2000);
  });
}

if (btnReset) {
  btnReset.addEventListener('click', () => {
    matrix = [];
    rank = 0;
    totalChunks = null;
    fileMeta = null;
    firstValidFrameTime = null;
    reassemblyComplete = false;
    currentFileToDownload = null;
    maxSeqReceived = -1;
    statMessage.value = 'Waiting for frames...';
    
    const statProgressText = document.getElementById('statProgressText');
    const statProgressBar = document.getElementById('statProgressBar');
    if (statProgressText) statProgressText.textContent = '0%';
    if (statProgressBar) statProgressBar.style.width = '0%';

    if (btnDownload) {
      btnDownload.style.display = 'none';
      btnDownload.href = '';
    }
    const fileContainer = document.getElementById('filePreviewContainer');
    if (fileContainer) fileContainer.innerHTML = '';
  });
}

if (btnDownload) {
  btnDownload.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!currentFileToDownload) return;
    
    // 1. Try Web Share API (The gold standard for iOS / Safari / Mobile)
    if (navigator.canShare && navigator.canShare({ files: [currentFileToDownload] })) {
      try {
        await navigator.share({
          files: [currentFileToDownload],
          title: currentFileToDownload.name
        });
        return; // Success!
      } catch (err) {
        console.log("Share API failed or user cancelled:", err);
      }
    }
    
    // 2. Fallback for Desktop Chrome/Edge/Firefox
    try {
      const url = URL.createObjectURL(currentFileToDownload);
      const a = document.createElement('a');
      a.href = url;
      a.download = currentFileToDownload.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      console.log("Desktop fallback failed:", e);
    }
    
    // 3. Bulletproof Fallback (iOS Brave/Chrome)
    // Render the file to the screen directly so the user can long-press to save
    const fileContainer = document.getElementById('filePreviewContainer');
    if (fileContainer) {
      fileContainer.innerHTML = '';
      if (currentFileToDownload.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          const img = document.createElement('img');
          img.src = ev.target.result;
          img.style.maxWidth = '100%';
          img.style.border = '2px solid #39f';
          img.style.borderRadius = '8px';
          fileContainer.appendChild(img);
          alert("Image displayed! Long-press on the image below to save it.");
        };
        reader.readAsDataURL(currentFileToDownload);
      } else {
        const reader = new FileReader();
        reader.onload = (ev) => {
          const txt = document.createElement('textarea');
          txt.value = ev.target.result;
          txt.style.width = '100%';
          txt.rows = 8;
          txt.style.background = '#222';
          txt.style.color = '#fff';
          fileContainer.appendChild(txt);
          alert("File contents displayed below.");
        };
        reader.readAsText(currentFileToDownload);
      }
    }
  });
}

// ---- Stats & State tracking ----
const stats = {
  totalFrames: 0,
  successFrames: 0, // Successfully detected grid
  validFrames: 0,   // CRC passed
  totalErrorsCorrected: 0,
  fpsFrames: 0,
  fpsStart: performance.now(),
  currentFPS: 0,
  lastAnchors: null,
  lastCells: null,
  lastPixelsPerCellNative: 0,
};

// Reassembly state
let totalChunks = null;
let matrix = [];
let rank = 0;
let fileMeta = null;
let firstValidFrameTime = null;
let reassemblyComplete = false;
let currentFileToDownload = null;
let maxSeqReceived = -1;

// ---- Audio NACK / ACK ----
let audioCtx = null;
let nackOsc = null;
let nackGain = null;

function playAudioCommand(type) {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  const now = audioCtx.currentTime;
  
  if (type === 'ACK') {
    setNackTone(false); // Stop NACK if it was running
    const gainNode = audioCtx.createGain();
    gainNode.connect(audioCtx.destination);
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(1.0, now + 0.05);
    gainNode.gain.setValueAtTime(1.0, now + 0.45);
    gainNode.gain.linearRampToValueAtTime(0, now + 0.5);
    
    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 19500;
    osc.connect(gainNode);
    osc.start(now);
    osc.stop(now + 0.5);
  }
}

function setNackTone(active) {
  if (!audioCtx) {
    if (!active) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  
  if (active && !nackOsc) {
    nackGain = audioCtx.createGain();
    nackGain.gain.value = 0.5;
    nackGain.connect(audioCtx.destination);
    
    nackOsc = audioCtx.createOscillator();
    nackOsc.type = 'sine';
    nackOsc.frequency.value = 18000;
    nackOsc.connect(nackGain);
    nackOsc.start();
  } else if (!active && nackOsc) {
    nackOsc.stop();
    nackOsc.disconnect();
    nackGain.disconnect();
    nackOsc = null;
    nackGain = null;
  }
}

// ---- Processing canvas (offscreen) ----
let procCanvas = null;
let procCtx = null;
let procW = 0, procH = 0;
let nativeW = 0, nativeH = 0;

// ---- Camera setup ----

async function initCamera() {
  statStatus.textContent = 'Requesting camera…';

  try {
    // Try to lock landscape (may fail without fullscreen, that's OK)
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock('landscape').catch(() => {});
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });

    video.srcObject = stream;
    await video.play();

    // Wait for video dimensions to be available
    await new Promise((resolve) => {
      if (video.videoWidth > 0) return resolve();
      video.addEventListener('loadedmetadata', resolve, { once: true });
    });

    nativeW = video.videoWidth;
    nativeH = video.videoHeight;
    procW = Math.round(nativeW * PROC_SCALE);
    procH = Math.round(nativeH * PROC_SCALE);

    // Create offscreen processing canvas
    procCanvas = document.createElement('canvas');
    procCanvas.width = procW;
    procCanvas.height = procH;
    procCtx = procCanvas.getContext('2d', { willReadFrequently: true });

    // Size the overlay canvas to match the video display
    resizeOverlay();

    statStatus.textContent = `Camera: ${nativeW}×${nativeH} → proc: ${procW}×${procH}`;
    statStatus.className = 'value';

    console.log(`Camera initialized: ${nativeW}×${nativeH}, processing at ${procW}×${procH}`);

    // Start decode loop
    requestAnimationFrame(decodeLoop);
  } catch (err) {
    statStatus.textContent = `Camera error: ${err.message}`;
    statStatus.className = 'value error';
    console.error('Camera init failed:', err);
  }
}

function resizeOverlay() {
  overlay.width = overlay.clientWidth;
  overlay.height = overlay.clientHeight;
}
window.addEventListener('resize', resizeOverlay);

// ---- Main decode loop ----

function decodeLoop() {
  if (video.readyState < video.HAVE_CURRENT_DATA) {
    requestAnimationFrame(decodeLoop);
    return;
  }

  const t0 = performance.now();
  stats.totalFrames++;

  // 1. Draw video frame to processing canvas (downsampled)
  procCtx.drawImage(video, 0, 0, procW, procH);
  const imageData = procCtx.getImageData(0, 0, procW, procH);
  const pixelCount = procW * procH;

  // 2. Grayscale
  const gray = toGrayscale(imageData.data, pixelCount);

  // 3. Otsu threshold
  const threshold = otsuThreshold(gray);

  // 4. Binarize
  const binary = binarize(gray, threshold);

  // 5. Find blobs
  const blobs = findBlobs(binary, procW, procH);

  // 6. Filter anchor candidates
  const candidates = filterAnchors(blobs, procW, procH);

  // 7. Identify the 4 anchors
  const anchorsRaw = identifyAnchors(candidates, procW, procH, imageData.data);

  // Temporal smoothing: reject detections that jump wildly from the previous frame.
  // This prevents single-frame glitches where data cells form false quads.
  let anchors = anchorsRaw;
  if (anchors && stats.lastAnchors) {
    const prevCenter = [
      (stats.lastAnchors.TL[0] + stats.lastAnchors.BR[0]) / 2,
      (stats.lastAnchors.TL[1] + stats.lastAnchors.BR[1]) / 2,
    ];
    const newCenter = [
      (anchors.TL[0] + anchors.BR[0]) / 2,
      (anchors.TL[1] + anchors.BR[1]) / 2,
    ];
    const jump = Math.hypot(newCenter[0] - prevCenter[0], newCenter[1] - prevCenter[1]);
    const frameDiag = Math.hypot(procW, procH);
    // If center jumped more than 20% of frame diagonal, reject this frame's detection
    if (jump > frameDiag * 0.20) {
      anchors = stats.lastAnchors; // reuse previous stable anchors
    }
  }

  let decoded = null;

  if (anchors) {
    // 8. Compute homography (ideal → processing coords)
    const srcPts = [IDEAL_ANCHORS.TL, IDEAL_ANCHORS.TR, IDEAL_ANCHORS.BL, IDEAL_ANCHORS.BR];
    const dstPts = [anchors.TL, anchors.TR, anchors.BL, anchors.BR];
    const H = computeHomography(srcPts, dstPts);

      if (H) {
      // 9. Sample each cell's RGB values
      const numCells = GRID_SIZE * GRID_SIZE; // 1024
      const cellR = new Float64Array(numCells);
      const cellG = new Float64Array(numCells);
      const cellB = new Float64Array(numCells);
      const cellPositions = [];

      // Adaptive sample radius based on pixels-per-unit
      const sampleR = Math.max(1, Math.round(anchors.pixelsPerUnit * 0.2));

      for (let i = 0; i < numCells; i++) {
        const [idealX, idealY] = IDEAL_CELLS[i];
        const camPt = projectPoint(H, idealX, idealY);
        cellPositions.push(camPt);
        const rgb = sampleAreaRGB(imageData.data, procW, procH, camPt.x, camPt.y, sampleR);
        cellR[i] = rgb.r;
        cellG[i] = rgb.g;
        cellB[i] = rgb.b;
      }

      // LOCAL threshold per channel: midpoint of min/max brightness across all cells.
      // This automatically adapts to colored lighting and screen white balance.
      let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
      for (let i = 0; i < numCells; i++) {
        if (cellR[i] < minR) minR = cellR[i];
        if (cellR[i] > maxR) maxR = cellR[i];
        if (cellG[i] < minG) minG = cellG[i];
        if (cellG[i] > maxG) maxG = cellG[i];
        if (cellB[i] < minB) minB = cellB[i];
        if (cellB[i] > maxB) maxB = cellB[i];
      }
      
      const threshR = (minR + maxR) / 2;
      const threshG = (minG + maxG) / 2;
      const threshB = (minB + maxB) / 2;

      const bitsR = new Uint8Array(numCells);
      const bitsG = new Uint8Array(numCells);
      const bitsB = new Uint8Array(numCells);
      
      for (let i = 0; i < numCells; i++) {
        const row = Math.floor(i / GRID_SIZE);
        const col = i % GRID_SIZE;
        const mask = (row + col) % 2; // unmask spatial checkerboard
        
        bitsR[i] = (cellR[i] > threshR ? 1 : 0) ^ mask;
        bitsG[i] = (cellG[i] > threshG ? 1 : 0) ^ mask;
        bitsB[i] = (cellB[i] > threshB ? 1 : 0) ^ mask;
      }

      // 10. Convert bits to 200 bytes per channel
      const rBlock = new Uint8Array(200);
      const gBlock = new Uint8Array(200);
      const bBlock = new Uint8Array(200);
      
      for (let i = 0; i < 200; i++) {
        let byteR = 0, byteG = 0, byteB = 0;
        for (let bit = 0; bit < 8; bit++) {
          const idx = i * 8 + bit;
          byteR = (byteR << 1) | bitsR[idx];
          byteG = (byteG << 1) | bitsG[idx];
          byteB = (byteB << 1) | bitsB[idx];
        }
        rBlock[i] = byteR;
        gBlock[i] = byteG;
        bBlock[i] = byteB;
      }

      // 11. Decode framing protocol (3 channels)
      const frame = decodeFrame(rBlock, gBlock, bBlock);
      stats.successFrames++; // Grid detected successfully

      if (frame.valid) {
        if (stats.validFrames === 0) firstValidFrameTime = performance.now();
        stats.validFrames++;
        stats.totalErrorsCorrected += frame.errorsCorrected;
        
        if (frame.seq > maxSeqReceived) {
          maxSeqReceived = frame.seq;
        }
        
        if (frame.flags === 1 /* FLAG_FILE_META */ && !fileMeta) {
          try {
            const metaJson = new TextDecoder().decode(frame.payload);
            const meta = JSON.parse(metaJson);
            fileMeta = meta;
            totalChunks = meta.totalChunks;
            matrix = new Array(totalChunks).fill(null);
            rank = 0;
            statMessage.value = `Session Found: ${meta.name} (${(meta.size / 1024).toFixed(1)} KB). Waiting for broadcast...`;
          } catch (e) {
            console.error("Failed to parse file metadata:", e);
          }
        } 
        else if (frame.flags === 3 /* FLAG_FOUNTAIN_DATA */ && totalChunks && !reassemblyComplete) {
          // GF(2) Gaussian Elimination using 32-bit words for extreme speed
          const indices = getFountainIndices(frame.seq, totalChunks);
          
          const coeffWords = Math.ceil(totalChunks / 32);
          const coeff32 = new Uint32Array(coeffWords);
          for (let idx of indices) {
            coeff32[idx >> 5] |= (1 << (idx & 31));
          }
          
          // Pad payload to multiple of 4 bytes for 32-bit XOR
          const payloadWords = Math.ceil(frame.payload.length / 4);
          const paddedPayload = new Uint8Array(payloadWords * 4);
          paddedPayload.set(frame.payload);
          const payload32 = new Uint32Array(paddedPayload.buffer);
          
          let added = false;
          for (let i = 0; i < totalChunks; i++) {
            // Check if variable i is 1
            if ((coeff32[i >> 5] & (1 << (i & 31))) !== 0) {
              if (matrix[i]) {
                // Eliminate using existing pivot
                for (let j = (i >> 5); j < coeffWords; j++) coeff32[j] ^= matrix[i].coeff32[j];
                for (let j = 0; j < payloadWords; j++) payload32[j] ^= matrix[i].payload32[j];
              } else {
                // Found new pivot!
                // First, completely reduce this new row using any existing pivots > i
                for (let m = i + 1; m < totalChunks; m++) {
                  if ((coeff32[m >> 5] & (1 << (m & 31))) !== 0 && matrix[m]) {
                    for (let j = (m >> 5); j < coeffWords; j++) coeff32[j] ^= matrix[m].coeff32[j];
                    for (let j = 0; j < payloadWords; j++) payload32[j] ^= matrix[m].payload32[j];
                  }
                }
                
                matrix[i] = { coeff32, payload32 };
                rank++;
                added = true;
                
                // Back-substitute upwards to reduce existing rows
                for (let k = 0; k < i; k++) {
                  if (matrix[k] && (matrix[k].coeff32[i >> 5] & (1 << (i & 31))) !== 0) {
                    for (let j = (i >> 5); j < coeffWords; j++) matrix[k].coeff32[j] ^= coeff32[j];
                    for (let j = 0; j < payloadWords; j++) matrix[k].payload32[j] ^= payload32[j];
                  }
                }
                break;
              }
            }
          }

          if (added && rank === totalChunks) {
            reassemblyComplete = true;
            playAudioCommand('ACK');
            
            // Reassemble the file
            const fullPayload = new Uint8Array(totalChunks * MAX_PAYLOAD_SIZE);
            for (let i = 0; i < totalChunks; i++) {
              // Extract the exact payload size back from the 32-bit array
              const p8 = new Uint8Array(matrix[i].payload32.buffer).slice(0, MAX_PAYLOAD_SIZE);
              fullPayload.set(p8, i * MAX_PAYLOAD_SIZE);
            }
            
            // Truncate to exact file size
            const exactData = fullPayload.slice(0, fileMeta.size);
            
            currentFileToDownload = new File([exactData], fileMeta.name, { type: fileMeta.type || 'application/octet-stream' });
            statMessage.value = `[File Transfer Complete]\nName: ${fileMeta.name}\nSize: ${(fileMeta.size / 1024).toFixed(1)} KB`;
            
            const btnDownload = document.getElementById('btnDownload');
            if (btnDownload) {
              btnDownload.style.display = 'block';
              btnDownload.href = 'javascript:void(0)';
              btnDownload.removeAttribute('download');
            }
          }
        }
        decoded = true;
      }

      stats.lastAnchors = anchors;
      stats.lastCells = cellPositions;

      // Compute pixels-per-cell in NATIVE camera resolution
      stats.lastPixelsPerCellNative = anchors.pixelsPerUnit / PROC_SCALE;
    }
  }

  // ---- Update FPS counter ----
  stats.fpsFrames++;
  const elapsed = performance.now() - stats.fpsStart;
  if (elapsed >= 1000) {
    stats.currentFPS = (stats.fpsFrames / elapsed * 1000).toFixed(1);
    stats.fpsFrames = 0;
    stats.fpsStart = performance.now();
  }

  // ---- Update stats display ----
  statFPS.textContent = stats.currentFPS || '—';
  statRate.textContent = stats.totalFrames > 0
    ? `${((stats.successFrames / stats.totalFrames) * 100).toFixed(1)}% (${stats.successFrames}/${stats.totalFrames}) grid detected`
    : '—';
    
  // Calculate throughput
  if (firstValidFrameTime && stats.validFrames > 0) {
    const elapsedSec = (performance.now() - firstValidFrameTime) / 1000;
    // Assuming 96 payload bytes per valid frame (32x32 layout)
    const bytesReceived = stats.validFrames * 96;
    statThroughput.textContent = elapsedSec > 0.5 ? `${Math.round(bytesReceived / elapsedSec)} B/s` : '—';
  } else {
    statThroughput.textContent = '—';
  }

  statErrors.textContent = stats.totalErrorsCorrected > 0 ? stats.totalErrorsCorrected : '0';

  // Progress
  const progressPercent = totalChunks ? (rank / totalChunks) * 100 : 0;
  const statProgressText = document.getElementById('statProgressText');
  const statProgressBar = document.getElementById('statProgressBar');
  if (statProgressText && statProgressBar) {
    statProgressText.textContent = totalChunks 
      ? `${rank} / ${totalChunks} (${progressPercent.toFixed(1)}%)`
      : `0%`;
    statProgressBar.style.width = `${progressPercent}%`;
  }
  
  if (reassemblyComplete && statProgressText) {
    statProgressText.textContent = '100% (Complete ✓)';
    statProgressText.className = 'value';
  }

  statAnchors.textContent = anchors
    ? `4/4 found ✓`
    : `Found ${candidates.length}/4 (Frame entire grid!)`;
  statAnchors.className = anchors ? 'value' : 'value warn';
  statPxCell.textContent = stats.lastPixelsPerCellNative > 0
    ? stats.lastPixelsPerCellNative.toFixed(1)
    : '—';

  if (decoded) {
    statStatus.textContent = 'Decoding frames ✓';
    statStatus.className = 'value';
  } else {
    statStatus.textContent = anchors ? 'CRC failed' : 'Searching for grid…';
    statStatus.className = anchors ? 'value warn' : 'value';
  }

  // ---- Debug overlay ----
  drawOverlay(anchors, stats.lastCells);

  // ---- Audio NACK checks ----
  if (totalChunks && !reassemblyComplete && fileMeta) {
    const expectedRank = Math.min(maxSeqReceived + 1, totalChunks);
    const needsNack = rank < expectedRank;
    setNackTone(needsNack);
  } else {
    setNackTone(false);
  }

  // ---- Schedule next frame ----
  requestAnimationFrame(decodeLoop);
}

// ---- Debug overlay drawing ----

function drawOverlay(anchors, cells) {
  const w = overlay.width;
  const h = overlay.height;
  if (w === 0 || h === 0) return;

  overlayCtx.clearRect(0, 0, w, h);

  if (!anchors) {
    // Draw a gentle framing guide when searching
    overlayCtx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    overlayCtx.lineWidth = 2;
    const guideSize = Math.min(w, h) * 0.7;
    overlayCtx.strokeRect((w - guideSize) / 2, (h - guideSize) / 2, guideSize, guideSize);
    
    overlayCtx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    overlayCtx.font = '14px sans-serif';
    overlayCtx.textAlign = 'center';
    overlayCtx.fillText('Point at the entire grid', w / 2, (h - guideSize) / 2 - 10);
    return;
  }

  // Compute scale and offset to match CSS object-fit: cover
  const videoAspect = nativeW / nativeH;
  const screenAspect = w / h;
  
  let scale, offX, offY;
  if (videoAspect > screenAspect) {
    // Video is wider, scaled by height
    scale = h / procH;
    offX = (w - procW * scale) / 2;
    offY = 0;
  } else {
    // Video is taller, scaled by width
    scale = w / procW;
    offX = 0;
    offY = (h - procH * scale) / 2;
  }

  const toScreenX = (x) => x * scale + offX;
  const toScreenY = (y) => y * scale + offY;

  // Draw quadrilateral connecting anchors
  const pts = [anchors.TL, anchors.TR, anchors.BR, anchors.BL]; // clockwise
  overlayCtx.strokeStyle = 'rgba(0, 255, 0, 0.7)';
  overlayCtx.lineWidth = 2;
  overlayCtx.beginPath();
  overlayCtx.moveTo(toScreenX(pts[0][0]), toScreenY(pts[0][1]));
  for (let i = 1; i < 4; i++) {
    overlayCtx.lineTo(toScreenX(pts[i][0]), toScreenY(pts[i][1]));
  }
  overlayCtx.closePath();
  overlayCtx.stroke();

  // Draw anchor markers
  const labels = ['TL', 'TR', 'BR', 'BL'];
  const colors = ['#0f0', '#0f0', '#f80', '#0f0']; // BR in orange (hollow)
  for (let i = 0; i < 4; i++) {
    const x = toScreenX(pts[i][0]);
    const y = toScreenY(pts[i][1]);

    overlayCtx.fillStyle = colors[i];
    overlayCtx.beginPath();
    overlayCtx.arc(x, y, 6, 0, Math.PI * 2);
    overlayCtx.fill();

    overlayCtx.fillStyle = '#fff';
    overlayCtx.font = '11px monospace';
    overlayCtx.fillText(labels[i], x + 9, y - 4);
  }

  // Draw cell sample positions
  if (cells) {
    overlayCtx.fillStyle = 'rgba(255, 255, 0, 0.5)';
    for (const pt of cells) {
      const x = toScreenX(pt.x);
      const y = toScreenY(pt.y);
      overlayCtx.beginPath();
      overlayCtx.arc(x, y, 2, 0, Math.PI * 2);
      overlayCtx.fill();
    }
  }
}

// ---- Landing page / index redirect ----
// (not needed, receiver.html is accessed directly)

// ---- Start ----
initCamera();
