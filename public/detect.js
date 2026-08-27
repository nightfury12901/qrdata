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

/**
 * Convert RGBA pixel data to grayscale.
 * @param {Uint8ClampedArray} rgba — RGBA pixel data (4 bytes per pixel)
 * @param {number} count — number of pixels (width × height)
 * @returns {Uint8Array} grayscale values (1 byte per pixel)
 */
function toGrayscale(rgba, count) {
  const gray = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const off = i * 4;
    // ITU-R BT.601 luma weights
    gray[i] = (rgba[off] * 77 + rgba[off + 1] * 150 + rgba[off + 2] * 29) >> 8;
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
  const minSide = frameDim * 0.005;  // very generous lower bound (anchors are ~4.7% of pattern)
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
 * and identify orientation (hollow anchor = BR).
 *
 * @param {Array} candidates — filtered blobs
 * @param {number} frameW — processing frame width
 * @param {number} frameH — processing frame height
 * @returns {{TL:[x,y], TR:[x,y], BL:[x,y], BR:[x,y], pixelsPerUnit:number}}
 */
function identifyAnchors(candidates, frameW, frameH) {
  if (candidates.length < 4) return null;

  // Minimum quad diagonal: the true grid should fill a meaningful portion of the frame.
  // At normal viewing distance, the grid fills 30-80% of the frame.
  // The anchor diagonal spans ~54 units out of 46 total (corner to corner).
  // Requiring 15% of frame diagonal eliminates tiny false-positive quads
  // formed by clusters of data cells.
  const frameDiag = Math.hypot(frameW, frameH);
  const minQuadDiag = frameDiag * 0.15;

  // 1. Separate candidates into solid and hollow
  const hollow = [];
  const solid = [];
  for (const c of candidates) {
    if (c.solidity >= 0.35 && c.solidity <= 0.92) {
      hollow.push(c);
    } else if (c.solidity > 0.92) {
      solid.push(c);
    }
  }

  if (hollow.length === 0 || solid.length < 3) return null;

  let bestQuad = null;
  let bestArea = 0;

  // 2. Search for a square-ish configuration around each hollow anchor
  for (const br of hollow) {
    // Performance optimization: 
    // True anchors are 2x2 units, making them the largest solid blobs in the image 
    // (except for massive background clutter like the laptop bezel, which we filter out).
    // Sort by area descending and take the top 40. This reduces N from ~500 (all data cells)
    // to 40, turning 67 million loops into just ~9,880 loops, guaranteeing 60fps!
    
    // First reject massive background clutter (laptop bezel)
    let validSolid = solid.filter(c => c.bbox.w < br.bbox.w * 3.0 && c.bbox.h < br.bbox.h * 3.0);
    // Then take the top 40 largest remaining blobs
    validSolid.sort((a, b) => b.area - a.area);
    validSolid = validSolid.slice(0, 40);

    for (let i = 0; i < validSolid.length - 1; i++) {
      for (let j = i + 1; j < validSolid.length; j++) {
        const p1 = validSolid[i];
        const p2 = validSolid[j];

        const d1 = Math.hypot(p1.cx - br.cx, p1.cy - br.cy);
        const d2 = Math.hypot(p2.cx - br.cx, p2.cy - br.cy);
        
        // Reject tiny configurations — the side length between BR and an adjacent
        // anchor spans 38 units. With minQuadDiag set to 15% of frame,
        // each side must be at least minQuadDiag * 0.5 (since diag ≈ side * 1.41).
        const minSide = minQuadDiag * 0.5;
        if (d1 < minSide || d2 < minSide) continue;

        // Ratio of side lengths (allow some perspective skew)
        const ratio = d1 / d2;
        if (ratio < 0.6 || ratio > 1.6) continue;

        // Angle between the two sides from BR must be ~90 degrees
        const v1x = p1.cx - br.cx, v1y = p1.cy - br.cy;
        const v2x = p2.cx - br.cx, v2y = p2.cy - br.cy;
        const dot = v1x * v2x + v1y * v2y;
        const cosTheta = dot / (d1 * d2);
        // cos(60) = 0.5, cos(120) = -0.5. Must be roughly orthogonal.
        if (Math.abs(cosTheta) > 0.6) continue;

        // Expected TL position (parallelogram rule)
        const expTLx = br.cx + v1x + v2x;
        const expTLy = br.cy + v1y + v2y;

        // Find the solid point closest to expected TL
        let bestTL = null;
        let bestTLDist = Infinity;
        for (const p3 of validSolid) {
          if (p3 === p1 || p3 === p2) continue;
          const err = Math.hypot(p3.cx - expTLx, p3.cy - expTLy);
          if (err < bestTLDist) {
            bestTLDist = err;
            bestTL = p3;
          }
        }

        // Allow TL to deviate by up to 40% of the side length due to perspective
        const maxErr = ((d1 + d2) / 2) * 0.4;
        if (bestTLDist < maxErr && bestTL !== null) {
          const area = quadArea([br, p1, bestTL, p2]);
          if (area > bestArea) {
            bestArea = area;
            bestQuad = { br, p1, p2, tl: bestTL };
          }
        }
      }
    }
  }

  if (!bestQuad) return null;

  // Final sanity check: quad diagonal must exceed minimum
  const diagLen = Math.hypot(bestQuad.br.cx - bestQuad.tl.cx, bestQuad.br.cy - bestQuad.tl.cy);
  if (diagLen < minQuadDiag) return null;

  const { br, p1, p2, tl } = bestQuad;

  // Determine which of p1, p2 is TR and BL using cross product
  // Vector from TL to BR
  const dx = br.cx - tl.cx;
  const dy = br.cy - tl.cy;
  
  const cross1 = dx * (p1.cy - tl.cy) - dy * (p1.cx - tl.cx);
  const cross2 = dx * (p2.cy - tl.cy) - dy * (p2.cx - tl.cx);

  // In screen coords (Y down), negative cross product is on the right side (TR)
  let tr, bl;
  if (cross1 < cross2) {
    tr = p1; bl = p2;
  } else {
    tr = p2; bl = p1;
  }

  // Compute pixels-per-unit for cell sampling (distance is 38 units)
  const distTR = Math.hypot(tr.cx - tl.cx, tr.cy - tl.cy);
  const distBL = Math.hypot(bl.cx - tl.cx, bl.cy - tl.cy);
  const pixelsPerUnit = (distTR + distBL) / 76;

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
