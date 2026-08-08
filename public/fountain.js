/**
 * fountain.js — Luby Transform (LT) Fountain Code
 *
 * Provides rateless erasure coding: the sender generates an infinite
 * stream of "droplets" (random XOR mixtures of file chunks). The
 * receiver collects any subset of droplets and recovers the original
 * file once it has slightly more droplets than chunks.
 *
 * All operations use only XOR — extremely lightweight for IoT.
 */

// ============================================================
// Seeded PRNG (xorshift32)
// ============================================================

function xorshift32(seed) {
  let state = seed | 0;
  if (state === 0) state = 1;
  return function () {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

// ============================================================
// Robust Soliton Distribution (cached per K)
// ============================================================

const _solitonCDFs = new Map();

function _buildSolitonCDF(K) {
  if (_solitonCDFs.has(K)) return _solitonCDFs.get(K);

  const c = 0.1;
  const delta = 0.5;
  const S = c * Math.log(K / delta) * Math.sqrt(K);

  // Ideal Soliton probabilities
  const probs = new Float64Array(K + 1);
  probs[1] = 1 / K;
  for (let d = 2; d <= K; d++) {
    probs[d] = 1 / (d * (d - 1));
  }

  // Robust spike
  const KoverS = Math.max(1, Math.round(K / S));
  for (let d = 1; d < KoverS && d <= K; d++) {
    probs[d] += S / (K * d);
  }
  if (KoverS >= 1 && KoverS <= K) {
    probs[KoverS] += S * Math.log(S / delta) / K;
  }

  // Normalize → CDF
  let Z = 0;
  for (let d = 1; d <= K; d++) Z += probs[d];

  const cdf = new Float64Array(K + 1);
  cdf[0] = 0;
  for (let d = 1; d <= K; d++) {
    cdf[d] = cdf[d - 1] + probs[d] / Z;
  }
  cdf[K] = 1.0;

  _solitonCDFs.set(K, cdf);
  return cdf;
}

/**
 * Sample a degree from the Robust Soliton distribution.
 */
function solitonDegree(K, rng) {
  if (K <= 1) return 1;
  const r = (rng() >>> 0) / 0x100000000;
  const cdf = _buildSolitonCDF(K);
  for (let d = 1; d <= K; d++) {
    if (r < cdf[d]) return d;
  }
  return 1;
}

/**
 * Select which source chunks to XOR for a given degree.
 */
function selectChunks(degree, K, rng) {
  const indices = new Set();
  while (indices.size < Math.min(degree, K)) {
    indices.add(rng() % K);
  }
  return Array.from(indices);
}

/**
 * Given a seed, reconstruct the degree and chunk indices.
 * Both encoder and decoder call this identically.
 */
function dropletInfo(seed, K) {
  const rng = xorshift32(seed);
  const degree = solitonDegree(K, rng);
  const indices = selectChunks(degree, K, rng);
  return { degree, indices };
}

// ============================================================
// Encoder
// ============================================================

class FountainEncoder {
  /**
   * @param {Uint8Array} data - the complete file bytes
   * @param {number} chunkSize - bytes per source chunk
   */
  constructor(data, chunkSize) {
    this.chunkSize = chunkSize;
    this.fileSize = data.length;
    this.K = Math.ceil(data.length / chunkSize);
    this.chunks = [];

    for (let i = 0; i < this.K; i++) {
      const chunk = new Uint8Array(chunkSize);
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, data.length);
      if (end > start) {
        chunk.set(data.subarray(start, end));
      }
      this.chunks.push(chunk);
    }

    this.nextSeed = 1;
  }

  /**
   * Generate the next fountain droplet.
   * @returns {{ seed: number, payload: Uint8Array }}
   */
  generateDroplet() {
    const seed = this.nextSeed++;
    const { indices } = dropletInfo(seed, this.K);

    const payload = new Uint8Array(this.chunkSize);
    for (const idx of indices) {
      for (let i = 0; i < this.chunkSize; i++) {
        payload[i] ^= this.chunks[idx][i];
      }
    }

    return { seed, payload };
  }
}

// ============================================================
// Decoder (Belief Propagation)
// ============================================================

class FountainDecoder {
  /**
   * @param {number} K - total source chunks
   * @param {number} chunkSize - bytes per chunk
   * @param {number} fileSize - exact file size (for trimming padding)
   */
  constructor(K, chunkSize, fileSize) {
    this.K = K;
    this.chunkSize = chunkSize;
    this.fileSize = fileSize;
    this.solved = new Array(K).fill(null);
    this.solvedCount = 0;
    this.pending = []; // { indices: number[], data: Uint8Array }
    this.dropletsReceived = 0;
    this.seenSeeds = new Set();
  }

  /**
   * Feed a droplet into the decoder.
   * @param {number} seed
   * @param {Uint8Array} payload
   * @returns {boolean} true if decoding is now complete
   */
  addDroplet(seed, payload) {
    // Skip duplicate seeds
    if (this.seenSeeds.has(seed)) return this.isComplete();
    this.seenSeeds.add(seed);
    this.dropletsReceived++;

    const { indices } = dropletInfo(seed, this.K);

    // XOR out already-solved chunks
    const data = new Uint8Array(payload);
    const remaining = [];

    for (const idx of indices) {
      if (this.solved[idx]) {
        for (let i = 0; i < this.chunkSize; i++) {
          data[i] ^= this.solved[idx][i];
        }
      } else {
        remaining.push(idx);
      }
    }

    if (remaining.length === 0) {
      return this.isComplete(); // Redundant
    }

    if (remaining.length === 1) {
      this.solved[remaining[0]] = data;
      this.solvedCount++;
      this._propagate();
    } else {
      this.pending.push({ indices: remaining, data });
    }

    return this.isComplete();
  }

  /**
   * Belief Propagation: cascade-solve pending droplets.
   */
  _propagate() {
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = this.pending.length - 1; i >= 0; i--) {
        const p = this.pending[i];

        // Remove solved indices, XOR out their data
        for (let j = p.indices.length - 1; j >= 0; j--) {
          const idx = p.indices[j];
          if (this.solved[idx]) {
            for (let k = 0; k < this.chunkSize; k++) {
              p.data[k] ^= this.solved[idx][k];
            }
            p.indices.splice(j, 1);
          }
        }

        if (p.indices.length === 0) {
          this.pending.splice(i, 1);
        } else if (p.indices.length === 1) {
          this.solved[p.indices[0]] = p.data;
          this.solvedCount++;
          this.pending.splice(i, 1);
          changed = true;
        }
      }
    }
  }

  isComplete() {
    return this.solvedCount >= this.K;
  }

  /**
   * Reassemble the decoded file.
   * @returns {Uint8Array}
   */
  getResult() {
    const result = new Uint8Array(this.fileSize);
    for (let i = 0; i < this.K; i++) {
      if (this.solved[i]) {
        const start = i * this.chunkSize;
        const len = Math.min(this.chunkSize, this.fileSize - start);
        if (len > 0) {
          result.set(this.solved[i].subarray(0, len), start);
        }
      }
    }
    return result;
  }
}

// ============================================================
// Exports
// ============================================================
window.FountainEncoder = FountainEncoder;
window.FountainDecoder = FountainDecoder;
window.FOUNTAIN_INTERNALS = { xorshift32, solitonDegree, selectChunks, dropletInfo };
