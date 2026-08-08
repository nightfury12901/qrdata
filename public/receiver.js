/**
 * receiver.js — 64x64 RGB Grid + Fountain Code Decoder (v9)
 * Fixed: computeHomography call format, sampleAreaRGB destructuring,
 *        added downscale for faster detection on mobile.
 */

const video = document.getElementById('cameraVideo');
const overlay = document.getElementById('overlayCanvas');
const octx = overlay.getContext('2d');

const statStatus = document.getElementById('statStatus');
const statFPS = document.getElementById('statFPS');
const statRate = document.getElementById('statRate');
const statThroughput = document.getElementById('statThroughput');
const statErrors = document.getElementById('statErrors');
const statProgress = document.getElementById('statProgress');
const statAnchors = document.getElementById('statAnchors');
const statPxCell = document.getElementById('statPxCell');
const statMessage = document.getElementById('statMessage');
const btnCopy = document.getElementById('btnCopy');
const btnReset = document.getElementById('btnReset');
const btnDownload = document.getElementById('btnDownload');
const filePreviewContainer = document.getElementById('filePreviewContainer');

if (btnCopy) {
  btnCopy.addEventListener('click', () => {
    statMessage.select();
    document.execCommand('copy');
    const old = btnCopy.textContent;
    btnCopy.textContent = 'Copied!';
    setTimeout(() => { btnCopy.textContent = old; }, 2000);
  });
}

let fountainDecoder = null;
let currentFileToDownload = null;

if (btnReset) {
  btnReset.addEventListener('click', () => {
    fountainDecoder = null;
    currentFileToDownload = null;
    statMessage.value = 'Waiting for droplets...';
    if (btnDownload) btnDownload.style.display = 'none';
    if (filePreviewContainer) filePreviewContainer.innerHTML = '';
    if (statProgress) { statProgress.textContent = '—'; statProgress.style.color = ''; }
  });
}

if (btnDownload) {
  btnDownload.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!currentFileToDownload) return;
    
    // Try Web Share API (best for iOS)
    if (navigator.canShare && navigator.canShare({ files: [currentFileToDownload] })) {
      try {
        await navigator.share({ files: [currentFileToDownload], title: currentFileToDownload.name });
        return;
      } catch (err) { console.log('Share cancelled:', err); }
    }
    
    // Desktop fallback
    try {
      const url = URL.createObjectURL(currentFileToDownload);
      const a = document.createElement('a');
      a.href = url; a.download = currentFileToDownload.name;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e2) { console.log('Download fallback failed:', e2); }
    
    // Last resort: render inline
    if (filePreviewContainer) {
      filePreviewContainer.innerHTML = '';
      if (currentFileToDownload.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = ev => {
          const img = document.createElement('img');
          img.src = ev.target.result;
          img.style.cssText = 'max-width:100%;border:2px solid #39f;border-radius:8px;';
          filePreviewContainer.appendChild(img);
          alert('Image shown below. Long-press to save.');
        };
        reader.readAsDataURL(currentFileToDownload);
      } else {
        const reader = new FileReader();
        reader.onload = ev => {
          const txt = document.createElement('textarea');
          txt.value = ev.target.result;
          txt.style.cssText = 'width:100%;background:#222;color:#fff;';
          txt.rows = 8;
          filePreviewContainer.appendChild(txt);
        };
        reader.readAsText(currentFileToDownload);
      }
    }
  });
}

// ---- Stats ----
const stats = { totalFrames: 0, successFrames: 0, totalErrorsCorrected: 0, validFrames: 0 };
let lastTime = performance.now();
let frameTimes = [];

// ---- Processing canvas (downscaled for speed) ----
// We process at max 720p to keep mobile fast
const MAX_PROC_DIM = 720;
let procCanvas = null;
let procCtx = null;

// ---- Camera init ----
async function initCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    video.srcObject = stream;
    video.addEventListener('play', onVideoPlay);
    statStatus.textContent = 'Camera started, waiting...';
  } catch (err) {
    statStatus.textContent = 'Camera error: ' + err.message;
  }
}

function onVideoPlay() {
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;

  // Create a downscaled processing canvas
  const scale = Math.min(1, MAX_PROC_DIM / Math.max(video.videoWidth, video.videoHeight));
  procCanvas = document.createElement('canvas');
  procCanvas.width = Math.round(video.videoWidth * scale);
  procCanvas.height = Math.round(video.videoHeight * scale);
  procCtx = procCanvas.getContext('2d', { willReadFrequently: true });

  requestAnimationFrame(processFrame);
}

function processFrame(now) {
  if (video.paused || video.ended) { requestAnimationFrame(processFrame); return; }

  // FPS
  const dt = now - lastTime;
  lastTime = now;
  frameTimes.push(dt);
  if (frameTimes.length > 30) frameTimes.shift();
  const avgDt = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
  if (statFPS) statFPS.textContent = (1000 / avgDt).toFixed(1);

  stats.totalFrames++;

  // Draw to downscaled canvas for detection
  procCtx.drawImage(video, 0, 0, procCanvas.width, procCanvas.height);
  const imageData = procCtx.getImageData(0, 0, procCanvas.width, procCanvas.height);
  const rgba = imageData.data;
  const W = procCanvas.width;
  const H_dim = procCanvas.height;

  // Clear overlay
  octx.clearRect(0, 0, overlay.width, overlay.height);

  // Detect grid anchors
  const pts = detectGridAnchors(rgba, W, H_dim);

  if (pts && pts.length === 4) {
    if (statStatus) { statStatus.textContent = 'Locked / Receiving'; statStatus.style.color = '#0f0'; }
    if (statAnchors) statAnchors.textContent = 'Found 4';

    // Scale pts back to full overlay coordinates
    const scaleX = overlay.width / W;
    const scaleY = overlay.height / H_dim;
    const ptsOverlay = pts.map(p => ({ x: p.x * scaleX, y: p.y * scaleY }));

    // Draw anchor markers on overlay
    octx.strokeStyle = '#0f0';
    octx.lineWidth = 3;
    octx.beginPath();
    octx.moveTo(ptsOverlay[0].x, ptsOverlay[0].y);
    octx.lineTo(ptsOverlay[1].x, ptsOverlay[1].y);
    octx.lineTo(ptsOverlay[2].x, ptsOverlay[2].y);
    octx.lineTo(ptsOverlay[3].x, ptsOverlay[3].y);
    octx.closePath();
    octx.stroke();

    // Compute homography: from GRID ANCHOR CENTERS → IMAGE anchor centers
    // The anchor squares are 8x8 cells, so their centers in grid coords are at (4,4), (60,4), (60,60), (4,60)
    const half = ANCHOR_SIZE / 2;
    const far = GRID_SIZE - ANCHOR_SIZE / 2;

    // src = anchor centers in grid coordinate space
    // dst = anchor centers in downscaled image pixel space
    const srcPts = [
      [half, half],           // TL
      [far, half],            // TR
      [far, far],             // BR
      [half, far]             // BL
    ];
    const dstPts = [
      [pts[0].x, pts[0].y],  // TL
      [pts[1].x, pts[1].y],  // TR
      [pts[2].x, pts[2].y],  // BR
      [pts[3].x, pts[3].y],  // BL
    ];

    const H = computeHomography(srcPts, dstPts);
    if (!H) { requestAnimationFrame(processFrame); return; }

    // Sample each data cell's RGB
    const rChannel = new Uint8Array(BYTES_PER_CHANNEL);
    const gChannel = new Uint8Array(BYTES_PER_CHANNEL);
    const bChannel = new Uint8Array(BYTES_PER_CHANNEL);

    let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
    const sampledR = new Float32Array(dataCellCoords.length);
    const sampledG = new Float32Array(dataCellCoords.length);
    const sampledB = new Float32Array(dataCellCoords.length);

    // Compute sample radius = ~0.35 of a cell's pixel size
    const cellPx = Math.hypot(
      pts[1].x - pts[0].x, pts[1].y - pts[0].y
    ) / (GRID_SIZE - ANCHOR_SIZE);
    const sampleRadius = Math.max(1, Math.floor(cellPx * 0.35));

    for (let i = 0; i < dataCellCoords.length; i++) {
      const { x, y } = dataCellCoords[i];
      const { x: imgX, y: imgY } = projectPoint(H, x + 0.5, y + 0.5);

      const { r, g, b } = sampleAreaRGB(rgba, W, H_dim, imgX, imgY, sampleRadius);
      sampledR[i] = r;
      sampledG[i] = g;
      sampledB[i] = b;

      if (r < minR) minR = r; if (r > maxR) maxR = r;
      if (g < minG) minG = g; if (g > maxG) maxG = g;
      if (b < minB) minB = b; if (b > maxB) maxB = b;
    }

    // Adaptive per-channel threshold
    const threshR = (minR + maxR) / 2;
    const threshG = (minG + maxG) / 2;
    const threshB = (minB + maxB) / 2;

    for (let i = 0; i < dataCellCoords.length; i++) {
      const bitR = sampledR[i] > threshR ? 1 : 0;
      const bitG = sampledG[i] > threshG ? 1 : 0;
      const bitB = sampledB[i] > threshB ? 1 : 0;

      const byteIdx = Math.floor(i / 8);
      const bitIdx = 7 - (i % 8);
      rChannel[byteIdx] |= (bitR << bitIdx);
      gChannel[byteIdx] |= (bitG << bitIdx);
      bChannel[byteIdx] |= (bitB << bitIdx);
    }

    // Decode frame
    stats.successFrames++;
    let frame;
    try {
      frame = decodeFrame(rChannel, gChannel, bChannel);
    } catch (e) {
      console.error('decodeFrame error:', e);
      requestAnimationFrame(processFrame);
      return;
    }

    if (frame.valid) {
      stats.validFrames++;
      stats.totalErrorsCorrected += frame.errorsCorrected || 0;
      handleDecodedFrame(frame);
    }

    const rate = stats.successFrames > 0
      ? ((stats.validFrames / stats.successFrames) * 100).toFixed(1)
      : '0.0';
    if (statRate) statRate.textContent = `${rate}% (${stats.validFrames}/${stats.successFrames})`;
    if (statErrors) statErrors.textContent = stats.totalErrorsCorrected;
    if (statPxCell) statPxCell.textContent = cellPx.toFixed(1);

  } else {
    if (statStatus) { statStatus.textContent = 'Searching for grid...'; statStatus.style.color = '#888'; }
    if (statAnchors) statAnchors.textContent = pts ? `Found ${pts.length}/4` : 'Found 0/4';
  }

  requestAnimationFrame(processFrame);
}

function handleDecodedFrame(frame) {
  if (!fountainDecoder || fountainDecoder.K !== frame.numChunks) {
    fountainDecoder = new FountainDecoder(
      frame.numChunks,
      MAX_PAYLOAD,
      frame.numChunks * MAX_PAYLOAD
    );
    if (statMessage) statMessage.value = 'Starting fountain decode...';
  }

  if (fountainDecoder.isComplete()) return;

  const done = fountainDecoder.addDroplet(frame.seed, frame.payload);

  const pct = Math.floor((fountainDecoder.solvedCount / fountainDecoder.K) * 100);
  if (statProgress) statProgress.textContent = `${fountainDecoder.solvedCount}/${fountainDecoder.K} chunks (${pct}%)`;
  if (statThroughput) statThroughput.textContent = `${fountainDecoder.dropletsReceived} droplets`;

  if (done) {
    if (statProgress) { statProgress.textContent += ' ✓ Complete!'; statProgress.style.color = '#0f0'; }

    const fullBuffer = fountainDecoder.getResult();

    if (frame.flags === FLAG_TEXT) {
      let str = new TextDecoder().decode(fullBuffer).replace(/\0/g, '');
      if (statMessage) statMessage.value = str;

    } else if (frame.flags === FLAG_FILE_DATA) {
      try {
        const metaLen = (fullBuffer[0] << 8) | fullBuffer[1];
        const metaBytes = fullBuffer.slice(2, 2 + metaLen);
        const meta = JSON.parse(new TextDecoder().decode(metaBytes));
        const fileData = fullBuffer.slice(2 + metaLen, 2 + metaLen + meta.size);

        currentFileToDownload = new File([fileData], meta.name, { type: meta.type || 'application/octet-stream' });
        if (statMessage) statMessage.value = `File received!\nName: ${meta.name}\nSize: ${(meta.size / 1024).toFixed(1)} KB`;

        if (btnDownload) {
          btnDownload.style.display = 'inline-block';
          btnDownload.href = 'javascript:void(0)';
        }
      } catch (err) {
        if (statMessage) statMessage.value = 'File parse error: ' + err.message;
      }
    }
  }
}

initCamera();
