/**
 * homography.js — Pure-JS 4-point projective transform.
 *
 * Computes a 3×3 homography matrix from four point correspondences
 * using the Direct Linear Transform (DLT) method, then projects
 * arbitrary points through it.
 *
 * Exports (as globals, loaded via <script> tag):
 *   computeHomography(src, dst) → H  (3×3 as Float64Array(9))
 *   projectPoint(H, x, y)      → {x, y}
 */

/**
 * Solve an n×n linear system Ax = b via Gaussian elimination with
 * partial pivoting. Modifies A and b in place.
 * @param {number[][]} A — n×n matrix (array of rows)
 * @param {number[]}   b — n-element right-hand side
 * @returns {number[]|null} solution vector, or null if singular
 */
function solveLinearSystem(A, b) {
  const n = A.length;

  for (let col = 0; col < n; col++) {
    // Partial pivoting: find row with largest absolute value in this column
    let maxVal = Math.abs(A[col][col]);
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(A[row][col]);
      if (v > maxVal) { maxVal = v; maxRow = row; }
    }

    if (maxVal < 1e-12) return null; // singular

    // Swap rows
    if (maxRow !== col) {
      [A[col], A[maxRow]] = [A[maxRow], A[col]];
      [b[col], b[maxRow]] = [b[maxRow], b[col]];
    }

    // Eliminate below
    const pivot = A[col][col];
    for (let row = col + 1; row < n; row++) {
      const factor = A[row][col] / pivot;
      for (let k = col; k < n; k++) {
        A[row][k] -= factor * A[col][k];
      }
      b[row] -= factor * b[col];
    }
  }

  // Back substitution
  const x = new Array(n);
  for (let row = n - 1; row >= 0; row--) {
    let sum = b[row];
    for (let k = row + 1; k < n; k++) {
      sum -= A[row][k] * x[k];
    }
    x[row] = sum / A[row][row];
  }

  return x;
}

/**
 * Compute a 3×3 homography matrix mapping src → dst.
 *
 * @param {Array<[number,number]>} src — 4 source points [[x,y], ...]
 * @param {Array<[number,number]>} dst — 4 destination points
 * @returns {Float64Array|null} 9-element array [h0..h8] row-major,
 *   where H = [[h0,h1,h2],[h3,h4,h5],[h6,h7,h8]] and h8 = 1.
 *   Returns null if the system is singular (degenerate geometry).
 */
function computeHomography(src, dst) {
  // Build the 8×8 system Ah = b where h = [h0..h7], h8 = 1
  //
  // For each correspondence (xi,yi) → (xi',yi'):
  //   xi*h0 + yi*h1 + h2 + 0 + 0 + 0 - xi'*xi*h6 - xi'*yi*h7 = xi'
  //   0 + 0 + 0 + xi*h3 + yi*h4 + h5 - yi'*xi*h6 - yi'*yi*h7 = yi'

  const A = [];
  const b = [];

  for (let i = 0; i < 4; i++) {
    const [sx, sy] = src[i];
    const [dx, dy] = dst[i];

    A.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy]);
    b.push(dx);

    A.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy]);
    b.push(dy);
  }

  const h = solveLinearSystem(A, b);
  if (!h) return null;

  return new Float64Array([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1]);
}

/**
 * Project a point through a homography.
 * @param {Float64Array} H — 9-element homography (row-major)
 * @param {number} x
 * @param {number} y
 * @returns {{x: number, y: number}}
 */
function projectPoint(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return {
    x: (H[0] * x + H[1] * y + H[2]) / w,
    y: (H[3] * x + H[4] * y + H[5]) / w,
  };
}

// Make available globally (no module system in Phase 1)
window.computeHomography = computeHomography;
window.projectPoint = projectPoint;
