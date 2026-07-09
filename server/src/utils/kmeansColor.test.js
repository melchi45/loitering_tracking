'use strict';

const { dominantColor } = require('./kmeansColor');

describe('kmeansColor.dominantColor', () => {
  test('returns null when fewer than 20 pixels are given', () => {
    const pixels = Array.from({ length: 10 }, () => [255, 0, 0]);
    expect(dominantColor(pixels)).toBeNull();
  });

  test('returns the centroid of the majority cluster, ignoring a minority outlier group', () => {
    const majority = Array.from({ length: 40 }, () => [200, 20, 20]); // red-ish cluster
    const minority = Array.from({ length: 5 }, () => [20, 20, 200]);  // blue-ish outliers
    const pixels = [...majority, ...minority];

    const result = dominantColor(pixels, 2);

    expect(result).not.toBeNull();
    expect(result[0]).toBeGreaterThan(result[2]); // red channel dominant, not blue
    expect(result[0]).toBeGreaterThan(150); // majority cluster centroid, not pulled toward the outliers
  });

  test('handles a uniform pixel set (single color, no variance)', () => {
    const pixels = Array.from({ length: 30 }, () => [100, 150, 50]);
    const result = dominantColor(pixels, 2);
    expect(result).toEqual([100, 150, 50]);
  });

  test('rounds output to nearest integer', () => {
    const pixels = [
      ...Array.from({ length: 15 }, () => [10, 10, 10]),
      ...Array.from({ length: 15 }, () => [11, 11, 11]),
    ];
    const result = dominantColor(pixels, 1);
    expect(Number.isInteger(result[0])).toBe(true);
    expect(Number.isInteger(result[1])).toBe(true);
    expect(Number.isInteger(result[2])).toBe(true);
  });
});
