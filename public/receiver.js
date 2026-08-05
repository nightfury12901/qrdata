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
const GRID_SIZE = 32;
const TOTAL_UNITS = 46;
const GRID_ORIGIN_X = 7;
const GRID_ORIGIN_Y = 7;

// Ideal anchor centers in unit coordinates
const IDEAL_ANCHORS = {
  TL: [4, 4],
  TR: [42, 4],
  BL: [4, 42],
  BR: [42, 42],
};

// Ideal cell centers
const IDEAL_CELLS = [];
for (let row = 0; row < GRID_SIZE; row++) {
  for (let col = 0; col < GRID_SIZE; col++) {
    IDEAL_CELLS.push([GRID_ORIGIN_X + col + 0.5, GRID_ORIGIN_Y + row + 0.5]);
  }
}

// ---- Processing config ----
const PROC_SCALE = 0.5; // Process at half the camera resolution
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
let receivedFrames = new Map();
let expectedTotalFrames = null;
let firstValidFrameTime = null;
let reassemblyComplete = false;

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
  const anchors = identifyAnchors(candidates);

  let decoded = null;

  if (anchors) {
    // 8. Compute homography (ideal → processing coords)
    const srcPts = [IDEAL_ANCHORS.TL, IDEAL_ANCHORS.TR, IDEAL_ANCHORS.BL, IDEAL_ANCHORS.BR];
    const dstPts = [anchors.TL, anchors.TR, anchors.BL, anchors.BR];
    const H = computeHomography(srcPts, dstPts);

    if (H) {
      // 9. Sample each cell — collect brightness first, then apply LOCAL threshold
      const numCells = GRID_SIZE * GRID_SIZE; // 1024
      const cellBrightness = new Float64Array(numCells);
      const cellPositions = [];

      // Adaptive sample radius based on pixels-per-unit
      const sampleR = Math.max(1, Math.round(anchors.pixelsPerUnit * 0.2));

      for (let i = 0; i < numCells; i++) {
        const [idealX, idealY] = IDEAL_CELLS[i];
        const camPt = projectPoint(H, idealX, idealY);
        cellPositions.push(camPt);
        cellBrightness[i] = sampleArea(gray, procW, procH, camPt.x, camPt.y, sampleR);
      }

      // LOCAL threshold: midpoint of min/max brightness across all cells.
      let minB = 255, maxB = 0;
      for (let i = 0; i < numCells; i++) {
        if (cellBrightness[i] < minB) minB = cellBrightness[i];
        if (cellBrightness[i] > maxB) maxB = cellBrightness[i];
      }
      const cellThreshold = (minB + maxB) / 2;

      const bits = new Uint8Array(numCells);
      for (let i = 0; i < numCells; i++) {
        bits[i] = cellBrightness[i] > cellThreshold ? 1 : 0;
      }

      // 10. Convert bits to 128 bytes
      const frameBytes = new Uint8Array(128);
      for (let i = 0; i < 128; i++) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit++) {
          byte = (byte << 1) | bits[i * 8 + bit];
        }
        frameBytes[i] = byte;
      }

      // 11. Decode framing protocol
      const frame = decodeFrame(frameBytes);
      stats.successFrames++; // Grid detected successfully

      if (frame.valid) {
        if (stats.validFrames === 0) firstValidFrameTime = performance.now();
        stats.validFrames++;
        stats.totalErrorsCorrected += frame.errorsCorrected;
        
        if (!receivedFrames.has(frame.seq)) {
          receivedFrames.set(frame.seq, frame.payload);
        }
        if (frame.isEof) {
          expectedTotalFrames = frame.seq + 1;
        }

        // Check if we have all frames
        if (expectedTotalFrames !== null && receivedFrames.size === expectedTotalFrames && !reassemblyComplete) {
          reassemblyComplete = true;
          // Concatenate all payloads
          const sortedSeq = Array.from(receivedFrames.keys()).sort((a, b) => a - b);
          let totalLen = 0;
          for (let s of sortedSeq) totalLen += receivedFrames.get(s).length;
          
          const fullPayload = new Uint8Array(totalLen);
          let offset = 0;
          for (let s of sortedSeq) {
            const p = receivedFrames.get(s);
            fullPayload.set(p, offset);
            offset += p.length;
          }
          
          const msg = new TextDecoder().decode(fullPayload);
          statMessage.value = msg;
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
  statProgress.textContent = expectedTotalFrames !== null
    ? `${receivedFrames.size} / ${expectedTotalFrames} frames`
    : `${receivedFrames.size} / ? frames`;
  
  if (reassemblyComplete) {
    statProgress.textContent += ' (Complete ✓)';
    statProgress.className = 'value';
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
