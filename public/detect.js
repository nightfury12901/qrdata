/**
 * detect.js — Anchor marker detection pipeline.
 *
 * Takes raw RGBA ImageData and finds the 4 corner anchors of the Photon
 * grid pattern. Returns ordered anchor centers [TL, TR, BL, BR] in
 * processing-canvas coordinates, or null if detection fails.
 *
 * Pipeline: grayscale → Otsu threshold → binarize → connected component
 * labeling → filter by size/shape → identify quadrilateral + orientation.
 */

// ---- Grayscale conversion ----

function toGrayscale(rgba, count) {
  const gray = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const off = i * 4;
    // We want anchors (Black) to be dark, and EVERYTHING else to be light.
    // By taking the max of RGB, any color (Red, Green, Blue, White) becomes ~255.
    // Only Black remains ~0.
    gray[i] = Math.max(rgba[off], rgba[off + 1], rgba[off + 2]);
  }
  return gray;
}

// ---- Otsu's threshold ----

/**
 * Compute optimal binary threshold using Otsu's method.
 * @param {Uint8Array} gray
 * @returns {number} threshold value (0-255)
 */
function otsuThreshold(gray) {
  // Build histogram
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;

  const total = gray.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];

  let w0 = 0, sum0 = 0;
  let bestThresh = 0, bestVar = 0;

  for (let t = 0; t < 256; t++) {
    w0 += hist[t];
    if (w0 === 0) continue;
    const w1 = total - w0;
    if (w1 === 0) break;

    sum0 += t * hist[t];
    const m0 = sum0 / w0;
    const m1 = (sumAll - sum0) / w1;
    const between = w0 * w1 * (m0 - m1) * (m0 - m1);

    if (between > bestVar) {
      bestVar = between;
      bestThresh = t;
    }
  }

  return bestThresh;
}

// ---- Binarization ----

/**
 * Binarize grayscale image: dark pixels → 1, light pixels → 0.
 * (We label dark pixels because anchors are dark.)
 * @param {Uint8Array} gray
 * @param {number} threshold
 * @returns {Uint8Array} binary image (0 or 1 per pixel)
 */
function binarize(gray, threshold) {
  const bin = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    bin[i] = gray[i] <= threshold ? 1 : 0;
  }
  return bin;
}

// ---- Connected Component Labeling (two-pass, 4-connectivity) ----

/**
 * Find connected components of dark pixels (value = 1).
 * @param {Uint8Array} binary
 * @param {number} width
 * @param {number} height
 * @returns {Array<{cx,cy,area,bbox:{x,y,w,h},solidity}>}
 */
function findBlobs(binary, width, height) {
  const labels = new Int32Array(width * height);
  // Union-find parent array (index 0 unused)
  const parent = [0];
  let nextLabel = 1;

  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]; // path compression
      x = parent[x];
    }
    return x;
  }

  function union(a, b) {
    a = find(a);
    b = find(b);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  }

  // Pass 1: assign provisional labels
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (binary[idx] === 0) continue; // skip light pixels

      const left = x > 0 ? labels[idx - 1] : 0;
      const above = y > 0 ? labels[idx - width] : 0;

      if (left === 0 && above === 0) {
        labels[idx] = nextLabel;
        parent.push(nextLabel);
        nextLabel++;
      } else if (left !== 0 && above === 0) {
        labels[idx] = left;
      } else if (left === 0 && above !== 0) {
        labels[idx] = above;
      } else {
        // Both neighbors labeled
        const minL = Math.min(left, above);
        labels[idx] = minL;
        union(left, above);
      }
    }
  }

  // Pass 2: resolve labels and accumulate stats
  const stats = new Map(); // root label → stats object

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (labels[idx] === 0) continue;

      const root = find(labels[idx]);

      if (!stats.has(root)) {
        stats.set(root, {
          area: 0, sumX: 0, sumY: 0,
          minX: x, minY: y, maxX: x, maxY: y,
        });
      }
      const s = stats.get(root);
      s.area++;
      s.sumX += x;
      s.sumY += y;
      if (x < s.minX) s.minX = x;
      if (y < s.minY) s.minY = y;
      if (x > s.maxX) s.maxX = x;
      if (y > s.maxY) s.maxY = y;
    }
  }

  // Convert to result array
  const blobs = [];
  for (const s of stats.values()) {
    const bw = s.maxX - s.minX + 1;
    const bh = s.maxY - s.minY + 1;
    blobs.push({
      cx: s.sumX / s.area,
      cy: s.sumY / s.area,
      area: s.area,
      bbox: { x: s.minX, y: s.minY, w: bw, h: bh },
      solidity: s.area / (bw * bh),
    });
  }

  return blobs;
}

// ---- Anchor Filtering ----

/**
 * Filter blobs to find anchor candidates: roughly square, within
 * expected size range.
 * @param {Array} blobs
 * @param {number} frameW — processing frame width
 * @param {number} frameH — processing frame height
 * @returns {Array} filtered blob candidates
 */
function filterAnchors(blobs, frameW, frameH) {
  // Expected anchor size: 2/16 = 12.5% of the pattern dimension.
  // The pattern may fill 20-90% of the frame. So anchor size in pixels
  // is roughly 2.5% to 11% of the frame dimension.
  const frameDim = Math.min(frameW, frameH);
  const minSide = frameDim * 0.015;  // very generous lower bound (anchors are ~4.7% of pattern)
  const maxSide = frameDim * 0.25;   // generous upper bound

  return blobs.filter(b => {
    const { w, h } = b.bbox;
    // Size check
    if (w < minSide || h < minSide || w > maxSide || h > maxSide) return false;
    // Roughly square (aspect ratio between 0.33 and 3.0 to allow for perspective)
    const aspect = w / h;
    if (aspect < 0.33 || aspect > 3.0) return false;
    // Minimum area (reject tiny noise)
    if (b.area < minSide * minSide * 0.3) return false;
    return true;
  });
}

// ---- Anchor Identification ----

/**
 * From a list of candidates, find the 4 that form the best quadrilateral
 * and identify orientation by finding the pure Blue anchor (BR).
 *
 * @param {Array} candidates — filtered blobs
 * @param {number} frameW — processing frame width
 * @param {number} frameH — processing frame height
 * @param {Uint8ClampedArray} rgba — original RGBA pixels
 * @returns {{TL:[x,y], TR:[x,y], BL:[x,y], BR:[x,y], pixelsPerUnit:number}}
 */
function identifyAnchors(candidates, frameW, frameH, rgba) {
  if (candidates.length < 4) return null;

  const frameDiag = Math.hypot(frameW, frameH);
  const minQuadDiag = frameDiag * 0.15;

  // Sort candidates by area descending and take top 25 to ensure all 4 anchors are included
  candidates.sort((a, b) => b.area - a.area);
  const topCandidates = candidates.slice(0, 25);

  let bestQuad = null;
  let bestScore = -Infinity;

  // Evaluate all combinations of 4 blobs (25 choose 4 = 12,650 combinations)
  for (let i = 0; i < topCandidates.length - 3; i++) {
    for (let j = i + 1; j < topCandidates.length - 2; j++) {
      for (let k = j + 1; k < topCandidates.length - 1; k++) {
        for (let l = k + 1; l < topCandidates.length; l++) {
          const pts = [topCandidates[i], topCandidates[j], topCandidates[k], topCandidates[l]];
          
          // Sort clockwise around centroid
          const cx = (pts[0].cx + pts[1].cx + pts[2].cx + pts[3].cx) / 4;
          const cy = (pts[0].cy + pts[1].cy + pts[2].cy + pts[3].cy) / 4;
          pts.sort((a, b) => Math.atan2(a.cy - cy, a.cx - cx) - Math.atan2(b.cy - cy, b.cx - cx));
          
          // Compute the 4 side lengths and 2 diagonals
          const d01 = Math.hypot(pts[1].cx - pts[0].cx, pts[1].cy - pts[0].cy);
          const d12 = Math.hypot(pts[2].cx - pts[1].cx, pts[2].cy - pts[1].cy);
          const d23 = Math.hypot(pts[3].cx - pts[2].cx, pts[3].cy - pts[2].cy);
          const d30 = Math.hypot(pts[0].cx - pts[3].cx, pts[0].cy - pts[3].cy);
          
          const diag1 = Math.hypot(pts[2].cx - pts[0].cx, pts[2].cy - pts[0].cy);
          const diag2 = Math.hypot(pts[3].cx - pts[1].cx, pts[3].cy - pts[1].cy);
          
          if (diag1 < minQuadDiag || diag2 < minQuadDiag) continue;
          
          // In a perfect square, opposite sides are equal and diagonals are equal.
          // Under perspective, opposite sides are roughly equal.
          const oppRatio1 = Math.max(d01 / d23, d23 / d01);
          const oppRatio2 = Math.max(d12 / d30, d30 / d12);
          
          if (oppRatio1 > 1.3 || oppRatio2 > 1.3) continue; // too much perspective distortion (must be < 30% difference)
          
          const diagRatio = Math.max(diag1 / diag2, diag2 / diag1);
          if (diagRatio > 1.3) continue;
          
          // We want the LARGEST quad that is also as SQUARE as possible.
          // Calculate how distorted the quad is (0.0 = perfect square)
          const errorScore = (oppRatio1 - 1.0) + (oppRatio2 - 1.0) + (diagRatio - 1.0);
          
          const area = quadArea(pts);
          // Score heavily penalizes distortion, but allows large true anchors to beat tiny perfect squares of noise
          const score = area / (1.0 + errorScore * 10.0);
          
          if (score > bestScore) {
            bestScore = score;
            bestQuad = pts;
          }
        }
      }
    }
  }

  if (!bestQuad) return null;

  // We have the 4 points in clockwise order.
  // Find the BR anchor: it is the one with the blue dot just outside of it!
  const quadCenter = {
    x: (bestQuad[0].cx + bestQuad[1].cx + bestQuad[2].cx + bestQuad[3].cx) / 4,
    y: (bestQuad[0].cy + bestQuad[1].cy + bestQuad[2].cy + bestQuad[3].cy) / 4
  };

  let maxBlueTint = -Infinity;
  let brIndex = -1;
  for (let i = 0; i < 4; i++) {
    const pt = bestQuad[i];
    
    // The blue dot is located in the quiet zone margin, outside the anchor.
    // By stepping outwards from the grid center by ~5% of the anchor's distance,
    // we land perfectly on the blue dot without it interfering with the black anchor.
    const vx = pt.cx - quadCenter.x;
    const vy = pt.cy - quadCenter.y;
    const sampleX = pt.cx + vx * 0.05;
    const sampleY = pt.cy + vy * 0.05;

    const rgb = sampleAreaRGB(rgba, frameW, frameH, sampleX, sampleY, 2);
    // Blue tint: B minus max of (R, G)
    const blueTint = rgb.b - Math.max(rgb.r, rgb.g);
    
    if (blueTint > maxBlueTint) {
      maxBlueTint = blueTint;
      brIndex = i;
    }
  }

  const br = bestQuad[brIndex];
  // TL is diagonally opposite to BR in the sorted array
  const tl = bestQuad[(brIndex + 2) % 4];
  
  // Use cross product to definitively identify TR and BL
  const p1 = bestQuad[(brIndex + 1) % 4];
  const p2 = bestQuad[(brIndex + 3) % 4];
  
  const dx = br.cx - tl.cx;
  const dy = br.cy - tl.cy;
  
  const cross1 = dx * (p1.cy - tl.cy) - dy * (p1.cx - tl.cx);
  const cross2 = dx * (p2.cy - tl.cy) - dy * (p2.cx - tl.cx);

  let tr, bl;
  if (cross1 < cross2) {
    tr = p1; bl = p2;
  } else {
    tr = p2; bl = p1;
  }

  // Compute pixels-per-unit for cell sampling (distance is 88 units)
  const distTR = Math.hypot(tr.cx - tl.cx, tr.cy - tl.cy);
  const distBL = Math.hypot(bl.cx - tl.cx, bl.cy - tl.cy);
  const pixelsPerUnit = (distTR + distBL) / 176;

  return {
    TL: [tl.cx, tl.cy],
    TR: [tr.cx, tr.cy],
    BL: [bl.cx, bl.cy],
    BR: [br.cx, br.cy],
    pixelsPerUnit,
    _blobs: { tl, tr, bl, br },
  };
}

/**
 * Compute the area of a quadrilateral given 4 blob objects.
 * Uses the shoelace formula on the convex hull.
 */
function quadArea(pts) {
  // Sort by angle from centroid to get convex order
  const cx = (pts[0].cx + pts[1].cx + pts[2].cx + pts[3].cx) / 4;
  const cy = (pts[0].cy + pts[1].cy + pts[2].cy + pts[3].cy) / 4;

  const sorted = pts.slice().sort((a, b) => {
    return Math.atan2(a.cy - cy, a.cx - cx) - Math.atan2(b.cy - cy, b.cx - cx);
  });

  // Shoelace formula
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    area += sorted[i].cx * sorted[j].cy;
    area -= sorted[j].cx * sorted[i].cy;
  }
  return Math.abs(area) / 2;
}

// ---- Pixel sampling helper ----

/**
 * Sample a small area of a grayscale image and return average brightness.
 * @param {Uint8Array} gray
 * @param {number} width
 * @param {number} height
 * @param {number} cx — center x (can be fractional)
 * @param {number} cy — center y
 * @param {number} radius — half-size of sampling window
 * @returns {number} average brightness (0-255)
 */
/**
 * Sample a small area of a grayscale image and return average brightness.
 * @param {Uint8Array} gray
 * @param {number} width
 * @param {number} height
 * @param {number} cx — center x (can be fractional)
 * @param {number} cy — center y
 * @param {number} radius — half-size of sampling window
 * @returns {number} average brightness (0-255)
 */
function sampleArea(gray, width, height, cx, cy, radius) {
  const x0 = Math.max(0, Math.floor(cx - radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const x1 = Math.min(width - 1, Math.ceil(cx + radius));
  const y1 = Math.min(height - 1, Math.ceil(cy + radius));

  let sum = 0, count = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      sum += gray[y * width + x];
      count++;
    }
  }

  return count > 0 ? sum / count : 128;
}

/**
 * Sample a small area of RGBA image data and return average R, G, B.
 * @param {Uint8ClampedArray} rgba
 * @param {number} width
 * @param {number} height
 * @param {number} cx
 * @param {number} cy
 * @param {number} radius
 * @returns {{r:number, g:number, b:number}} average RGB (0-255)
 */
function sampleAreaRGB(rgba, width, height, cx, cy, radius) {
  const x0 = Math.max(0, Math.floor(cx - radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const x1 = Math.min(width - 1, Math.ceil(cx + radius));
  const y1 = Math.min(height - 1, Math.ceil(cy + radius));

  let sumR = 0, sumG = 0, sumB = 0, count = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const off = (y * width + x) * 4;
      sumR += rgba[off];
      sumG += rgba[off + 1];
      sumB += rgba[off + 2];
      count++;
    }
  }

  if (count === 0) return { r: 128, g: 128, b: 128 };
  return {
    r: sumR / count,
    g: sumG / count,
    b: sumB / count
  };
}

// ---- Export globals ----
window.toGrayscale = toGrayscale;
window.otsuThreshold = otsuThreshold;
window.binarize = binarize;
window.findBlobs = findBlobs;
window.filterAnchors = filterAnchors;
window.identifyAnchors = identifyAnchors;
window.sampleArea = sampleArea;
window.sampleAreaRGB = sampleAreaRGB;
