/**
 * receiver.js — 64x64 RGB Grid + Fountain Code Decoder
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
    const oldText = btnCopy.textContent;
    btnCopy.textContent = 'Copied!';
    setTimeout(() => btnCopy.textContent = oldText, 2000);
  });
}

let fountainDecoder = null;
let currentFileToDownload = null;

if (btnReset) {
  btnReset.addEventListener('click', () => {
    fountainDecoder = null;
    currentFileToDownload = null;
    statMessage.value = 'Waiting for droplets...';
    if (btnDownload) {
      btnDownload.style.display = 'none';
      btnDownload.href = '';
    }
    if (filePreviewContainer) filePreviewContainer.innerHTML = '';
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
    if (filePreviewContainer) {
      filePreviewContainer.innerHTML = '';
      if (currentFileToDownload.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          const img = document.createElement('img');
          img.src = ev.target.result;
          img.style.maxWidth = '100%';
          img.style.border = '2px solid #39f';
          img.style.borderRadius = '8px';
          filePreviewContainer.appendChild(img);
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
          filePreviewContainer.appendChild(txt);
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
  successFrames: 0,
  totalErrorsCorrected: 0,
  validFrames: 0
};

let procCanvas = null;
let procCtx = null;
let lastTime = performance.now();
let frameTimes = [];

// Initialize Camera
async function initCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }
    });
    video.srcObject = stream;
    
    video.addEventListener('play', () => {
      overlay.width = video.videoWidth;
      overlay.height = video.videoHeight;
      procCanvas = document.createElement('canvas');
      procCanvas.width = video.videoWidth;
      procCanvas.height = video.videoHeight;
      procCtx = procCanvas.getContext('2d', { willReadFrequently: true });
      requestAnimationFrame(processFrame);
    });
  } catch (err) {
    statStatus.textContent = "Camera error: " + err.message;
  }
}

function processFrame(now) {
  if (video.paused || video.ended) {
    requestAnimationFrame(processFrame);
    return;
  }

  // FPS calculation
  const dt = now - lastTime;
  lastTime = now;
  frameTimes.push(dt);
  if (frameTimes.length > 30) frameTimes.shift();
  const avgDt = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
  statFPS.textContent = (1000 / avgDt).toFixed(1);

  stats.totalFrames++;

  // Draw video to processing canvas
  procCtx.drawImage(video, 0, 0, procCanvas.width, procCanvas.height);
  const imageData = procCtx.getImageData(0, 0, procCanvas.width, procCanvas.height);
  const rgba = imageData.data;

  // Clear overlay
  octx.clearRect(0, 0, overlay.width, overlay.height);

  // 1. Detect Grid
  const pts = detectGridAnchors(rgba, procCanvas.width, procCanvas.height);
  
  if (pts && pts.length === 4) {
    statStatus.textContent = "Locked / Receiving";
    statStatus.style.color = "#0f0";
    statAnchors.textContent = "Found 4";

    // 2. Compute Homography
    const H = computeHomography(
      0, 0,
      GRID_SIZE, 0,
      GRID_SIZE, GRID_SIZE,
      0, GRID_SIZE,
      pts[0].x, pts[0].y,
      pts[1].x, pts[1].y,
      pts[2].x, pts[2].y,
      pts[3].x, pts[3].y
    );

    if (H) {
      // 3. Sample RGB cells
      const numCells = GRID_SIZE * GRID_SIZE;
      const cellR = new Float64Array(numCells);
      const cellG = new Float64Array(numCells);
      const cellB = new Float64Array(numCells);
      
      let samplePoints = [];
      let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;

      for (let i = 0; i < dataCellCoords.length; i++) {
        const { x, y } = dataCellCoords[i];
        
        // Map from grid (x+0.5, y+0.5) to image coordinates
        const u = x + 0.5;
        const v = y + 0.5;
        
        const w = H[6]*u + H[7]*v + 1;
        const imgX = (H[0]*u + H[1]*v + H[2]) / w;
        const imgY = (H[3]*u + H[4]*v + H[5]) / w;

        // Draw sampling points on overlay for debugging
        if (i % 30 === 0) { // draw a subset to save performance
          samplePoints.push({x: imgX, y: imgY});
        }

        // We use a small 1-pixel radius for 64x64 to avoid bleeding
        const [R, G, B] = sampleAreaRGB(rgba, procCanvas.width, procCanvas.height, imgX, imgY, 1);
        
        cellR[i] = R;
        cellG[i] = G;
        cellB[i] = B;

        if (R < minR) minR = R; if (R > maxR) maxR = R;
        if (G < minG) minG = G; if (G > maxG) maxG = G;
        if (B < minB) minB = B; if (B > maxB) maxB = B;
      }

      // Draw sample points
      octx.fillStyle = 'rgba(255, 0, 0, 0.5)';
      for (const p of samplePoints) {
        octx.fillRect(p.x - 1, p.y - 1, 2, 2);
      }

      // 4. Thresholding (Adaptive per channel)
      const rBlock = new Uint8Array(BYTES_PER_CHANNEL);
      const gBlock = new Uint8Array(BYTES_PER_CHANNEL);
      const bBlock = new Uint8Array(BYTES_PER_CHANNEL);
      
      const threshR = (minR + maxR) / 2;
      const threshG = (minG + maxG) / 2;
      const threshB = (minB + maxB) / 2;

      for (let i = 0; i < dataCellCoords.length; i++) {
        const bitR = cellR[i] > threshR ? 1 : 0;
        const bitG = cellG[i] > threshG ? 1 : 0;
        const bitB = cellB[i] > threshB ? 1 : 0;

        const byteIdx = Math.floor(i / 8);
        const bitIdx = 7 - (i % 8);

        rBlock[byteIdx] |= (bitR << bitIdx);
        gBlock[byteIdx] |= (bitG << bitIdx);
        bBlock[byteIdx] |= (bitB << bitIdx);
      }

      // 5. Decode Frame
      const frame = decodeFrame(rBlock, gBlock, bBlock);
      stats.successFrames++;

      if (frame.valid) {
        stats.validFrames++;
        stats.totalErrorsCorrected += frame.errorsCorrected;
        
        handleDecodedFrame(frame);
      }
      
      // Update basic stats
      const rate = ((stats.validFrames / stats.successFrames) * 100).toFixed(1);
      statRate.textContent = `${rate}% (${stats.validFrames}/${stats.successFrames})`;
      statErrors.textContent = stats.totalErrorsCorrected;
      
      // Compute pixel per cell
      const w = H[6]*GRID_SIZE + H[7]*GRID_SIZE + 1;
      const dX = (H[0]*GRID_SIZE + H[1]*GRID_SIZE + H[2]) / w - (H[2]);
      const dY = (H[3]*GRID_SIZE + H[4]*GRID_SIZE + H[5]) / w - (H[5]);
      const dist = Math.sqrt(dX*dX + dY*dY);
      statPxCell.textContent = (dist / GRID_SIZE).toFixed(1);
    }
  } else {
    statStatus.textContent = "Searching for grid...";
    statStatus.style.color = "#888";
    statAnchors.textContent = pts ? `Found ${pts.length}/4` : "Found 0/4";
  }

  requestAnimationFrame(processFrame);
}

function handleDecodedFrame(frame) {
  // Reset or instantiate Fountain Decoder if K changes or doesn't exist
  if (!fountainDecoder || fountainDecoder.K !== frame.numChunks) {
    fountainDecoder = new FountainDecoder(frame.numChunks, MAX_PAYLOAD, frame.numChunks * MAX_PAYLOAD);
    statMessage.value = "Starting fountain transfer...\n";
  }
  
  if (fountainDecoder.isComplete()) return;

  const completeNow = fountainDecoder.addDroplet(frame.seed, frame.payload);
  
  // Progress
  const pct = Math.floor((fountainDecoder.solvedCount / fountainDecoder.K) * 100);
  statProgress.textContent = `${fountainDecoder.solvedCount} / ${fountainDecoder.K} chunks (${pct}%)`;

  // Calculate Throughput (roughly: dropletsReceived / time)
  // But we'll just show droplets received so far.
  statThroughput.textContent = `${fountainDecoder.dropletsReceived} total droplets processed`;

  if (completeNow) {
    statProgress.textContent += " (Complete ✓)";
    statProgress.style.color = "#0f0";
    
    // Reassemble full buffer
    const fullBuffer = fountainDecoder.getResult();
    
    if (frame.flags === FLAG_TEXT) {
      // Decode as text, trim null bytes
      let str = new TextDecoder().decode(fullBuffer);
      str = str.replace(/\0/g, ''); // strip null padding
      statMessage.value = str;
    } else if (frame.flags === FLAG_FILE_DATA) {
      try {
        // Parse metadata header
        const metaLen = (fullBuffer[0] << 8) | fullBuffer[1];
        const metaBytes = fullBuffer.slice(2, 2 + metaLen);
        const metaStr = new TextDecoder().decode(metaBytes);
        const meta = JSON.parse(metaStr);
        
        // Extract raw file data
        const fileData = fullBuffer.slice(2 + metaLen, 2 + metaLen + meta.size);
        currentFileToDownload = new File([fileData], meta.name, { type: meta.type || 'application/octet-stream' });
        
        statMessage.value = `[File Transfer Complete]\nName: ${meta.name}\nSize: ${(meta.size / 1024).toFixed(1)} KB\nType: ${meta.type || 'unknown'}`;
        
        if (btnDownload) {
          btnDownload.style.display = 'block';
          btnDownload.href = 'javascript:void(0)';
          btnDownload.removeAttribute('download');
        }
      } catch (err) {
        statMessage.value = "Failed to parse file metadata: " + err.message;
      }
    }
  }
}

// Start
initCamera();
