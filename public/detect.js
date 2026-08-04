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
  const minSide = frameDim * 0.015;  // very generous lower bound
  const maxSide = frameDim * 0.25;   // generous upper bound

  return blobs.filter(b => {
    const { w, h } = b.bbox;
    // Size check
    if (w < minSide || h < minSide || w > maxSide || h > maxSide) return false;
    // Roughly square (aspect ratio between 0.5 and 2.0)
    const aspect = w / h;
    if (aspect < 0.5 || aspect > 2.0) return false;
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
 * @returns {{TL:[x,y], TR:[x,y], BL:[x,y], BR:[x,y], pixelsPerUnit:number}|null}
 */
function identifyAnchors(candidates) {
  if (candidates.length < 4) return null;

  // Strategy: pick the 4 candidates whose bounding-box centers form the
  // largest-area quadrilateral (most likely the outer anchors, not grid cells).
  // Sort by area descending and take top candidates to limit combinations.
  const sorted = candidates.slice().sort((a, b) => b.area - a.area);
  const pool = sorted.slice(0, Math.min(sorted.length, 12));

  let bestQuad = null;
  let bestArea = 0;

  // Try all combinations of 4 from the pool
  for (let i = 0; i < pool.length - 3; i++) {
    for (let j = i + 1; j < pool.length - 2; j++) {
      for (let k = j + 1; k < pool.length - 1; k++) {
        for (let l = k + 1; l < pool.length; l++) {
          const pts = [pool[i], pool[j], pool[k], pool[l]];
          const area = quadArea(pts);
          if (area > bestArea) {
            bestArea = area;
            bestQuad = pts;
          }
        }
      }
    }
  }

  if (!bestQuad) return null;

  // Order the 4 points: find centroid, sort by angle
  const centroid = {
    x: (bestQuad[0].cx + bestQuad[1].cx + bestQuad[2].cx + bestQuad[3].cx) / 4,
    y: (bestQuad[0].cy + bestQuad[1].cy + bestQuad[2].cy + bestQuad[3].cy) / 4,
  };

  // Assign TL, TR, BL, BR by position relative to centroid
  const topLeft = [], topRight = [], botLeft = [], botRight = [];
  for (const p of bestQuad) {
    if (p.cx < centroid.x && p.cy < centroid.y) topLeft.push(p);
    else if (p.cx >= centroid.x && p.cy < centroid.y) topRight.push(p);
    else if (p.cx < centroid.x && p.cy >= centroid.y) botLeft.push(p);
    else botRight.push(p);
  }

  // Each quadrant should have exactly 1 point
  if (topLeft.length !== 1 || topRight.length !== 1 ||
      botLeft.length !== 1 || botRight.length !== 1) {
    // Fallback: can't cleanly partition — try identifying hollow anchor first
    return identifyByHollow(bestQuad, centroid);
  }

  let tl = topLeft[0], tr = topRight[0], bl = botLeft[0], br = botRight[0];

  // Verify orientation: BR should be the hollow anchor (lowest solidity)
  // If it isn't, rotate the assignment so the hollow one is at BR.
  const allFour = [tl, tr, bl, br];
  const hollowIdx = findHollowIndex(allFour);

  if (hollowIdx !== null && hollowIdx !== 3) {
    // Remap so hollow is at position 3 (BR)
    const remapped = remapToHollow(allFour, hollowIdx);
    if (remapped) {
      [tl, tr, bl, br] = remapped;
    }
  }

  // Compute pixels-per-unit from anchor distances
  // TL to TR = 12 units (from x=2 to x=14)
  const distTR = Math.hypot(tr.cx - tl.cx, tr.cy - tl.cy);
  const distBL = Math.hypot(bl.cx - tl.cx, bl.cy - tl.cy);
  const pixelsPerUnit = (distTR + distBL) / 24; // average of both 12-unit spans

  return {
    TL: [tl.cx, tl.cy],
    TR: [tr.cx, tr.cy],
    BL: [bl.cx, bl.cy],
    BR: [br.cx, br.cy],
    pixelsPerUnit,
    // Pass solidity info for debug display
    _blobs: { tl, tr, bl, br },
  };
}

/**
 * Fallback identification using hollow anchor detection.
 */
function identifyByHollow(quad, centroid) {
  const hollowIdx = findHollowIndex(quad);
  if (hollowIdx === null) return null;

  // Hollow anchor is BR. The one diagonally opposite is TL.
  const br = quad[hollowIdx];
  const rest = quad.filter((_, i) => i !== hollowIdx);

  // TL is the farthest from BR
  rest.sort((a, b) => {
    const da = Math.hypot(a.cx - br.cx, a.cy - br.cy);
    const db = Math.hypot(b.cx - br.cx, b.cy - br.cy);
    return db - da;
  });
  const tl = rest[0];
  const [p1, p2] = [rest[1], rest[2]];

  // Determine TR vs BL using cross product:
  // Vector TL→BR, then check which side p1 and p2 are on
  const dx = br.cx - tl.cx;
  const dy = br.cy - tl.cy;

  const cross1 = dx * (p1.cy - tl.cy) - dy * (p1.cx - tl.cx);
  const cross2 = dx * (p2.cy - tl.cy) - dy * (p2.cx - tl.cx);

  // In screen coords (y down): negative cross = right of TL→BR line = TR side
  let tr, bl;
  if (cross1 < cross2) {
    tr = p1; bl = p2;
  } else {
    tr = p2; bl = p1;
  }

  const distTR = Math.hypot(tr.cx - tl.cx, tr.cy - tl.cy);
  const distBL = Math.hypot(bl.cx - tl.cx, bl.cy - tl.cy);
  const pixelsPerUnit = (distTR + distBL) / 24;

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
 * Find the index of the hollow anchor (lowest solidity) in an array of 4 blobs.
 * Returns null if no anchor is clearly hollow.
 */
function findHollowIndex(blobs) {
  let minSolidity = Infinity;
  let minIdx = -1;
  let secondMin = Infinity;

  for (let i = 0; i < blobs.length; i++) {
    if (blobs[i].solidity < minSolidity) {
      secondMin = minSolidity;
      minSolidity = blobs[i].solidity;
      minIdx = i;
    } else if (blobs[i].solidity < secondMin) {
      secondMin = blobs[i].solidity;
    }
  }

  // The hollow anchor should have notably lower solidity than the rest.
  // Solid anchors: solidity ~0.95-1.0, Hollow: ~0.65-0.85
  // Require at least 0.05 gap.
  if (secondMin - minSolidity > 0.05) {
    return minIdx;
  }

  return null; // can't reliably distinguish
}

/**
 * Remap 4 anchors so that the hollow one (at hollowIdx) ends up at index 3 (BR).
 * Maintains the correct spatial relationship.
 */
function remapToHollow(pts, hollowIdx) {
  // The hollow point is BR. Identify TL as the farthest from it.
  const br = pts[hollowIdx];
  const rest = pts.filter((_, i) => i !== hollowIdx);

  rest.sort((a, b) => {
    const da = Math.hypot(a.cx - br.cx, a.cy - br.cy);
    const db = Math.hypot(b.cx - br.cx, b.cy - br.cy);
    return db - da;
  });
  const tl = rest[0];
  const [p1, p2] = [rest[1], rest[2]];

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

  return [tl, tr, bl, br];
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

// ---- Export globals ----
window.toGrayscale = toGrayscale;
window.otsuThreshold = otsuThreshold;
window.binarize = binarize;
window.findBlobs = findBlobs;
window.filterAnchors = filterAnchors;
window.identifyAnchors = identifyAnchors;
window.sampleArea = sampleArea;
