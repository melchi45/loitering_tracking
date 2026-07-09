'use strict';

/**
 * AI-05 Phase-3 (Proposed) — dominant-color extraction for Human Parsing mask pixels.
 * See docs/design/Design_AI_Color_Analysis.md §10.4.
 */

function _dist2(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

/**
 * Cluster a set of [r,g,b] pixels and return the centroid of the largest cluster.
 * @param {number[][]} pixels  Array of [r,g,b] triples (0-255 each)
 * @param {number} [k=2]       Cluster count
 * @param {number} [maxIter=6] Max Lloyd's-algorithm iterations
 * @returns {[number,number,number]|null} Rounded dominant RGB, or null if too few pixels
 */
function dominantColor(pixels, k = 2, maxIter = 6) {
  if (!pixels || pixels.length < 20) return null;

  const kEff = Math.min(k, pixels.length);
  const centroids = [];
  for (let i = 0; i < kEff; i++) {
    centroids.push(pixels[Math.floor((i + 0.5) * pixels.length / kEff)].slice());
  }

  const assignments = new Array(pixels.length).fill(0);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < pixels.length; i++) {
      let best = 0, bestDist = Infinity;
      for (let c = 0; c < kEff; c++) {
        const d = _dist2(pixels[i], centroids[c]);
        if (d < bestDist) { bestDist = d; best = c; }
      }
      if (assignments[i] !== best) { assignments[i] = best; changed = true; }
    }

    const sums = Array.from({ length: kEff }, () => [0, 0, 0, 0]);
    for (let i = 0; i < pixels.length; i++) {
      const c = assignments[i];
      sums[c][0] += pixels[i][0];
      sums[c][1] += pixels[i][1];
      sums[c][2] += pixels[i][2];
      sums[c][3] += 1;
    }
    for (let c = 0; c < kEff; c++) {
      if (sums[c][3] > 0) {
        centroids[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
      }
    }
    if (!changed) break;
  }

  const counts = new Array(kEff).fill(0);
  for (const a of assignments) counts[a]++;
  let bestC = 0;
  for (let c = 1; c < kEff; c++) if (counts[c] > counts[bestC]) bestC = c;

  return [
    Math.round(centroids[bestC][0]),
    Math.round(centroids[bestC][1]),
    Math.round(centroids[bestC][2]),
  ];
}

module.exports = { dominantColor };
