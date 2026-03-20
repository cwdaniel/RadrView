import { describe, it, expect } from 'vitest';
import { reverseMapTile, findNearestDbz } from '../../src/utils/color-map.js';
import { dbzToPixel } from '../../src/utils/geo.js';

describe('findNearestDbz', () => {
  it('maps green to ~15-25 dBZ range', () => {
    const dbz = findNearestDbz(0, 255, 0);
    expect(dbz).toBeGreaterThanOrEqual(15);
    expect(dbz).toBeLessThanOrEqual(25);
  });

  it('maps red to ~45-55 dBZ range', () => {
    const dbz = findNearestDbz(255, 0, 0);
    expect(dbz).toBeGreaterThanOrEqual(40);
    expect(dbz).toBeLessThanOrEqual(55);
  });

  it('rejects white as non-radar color', () => {
    const dbz = findNearestDbz(255, 255, 255);
    expect(dbz).toBe(-1);
  });

  it('rejects gray as non-radar color', () => {
    expect(findNearestDbz(150, 150, 150)).toBe(-1);
    expect(findNearestDbz(100, 100, 100)).toBe(-1);
  });
});

describe('reverseMapTile', () => {
  it('maps transparent pixels to 0', () => {
    // 2x2 RGBA tile, all transparent
    const rgba = new Uint8Array([0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0]);
    const result = reverseMapTile(rgba, 2, 2);
    expect(result.length).toBe(4);
    expect(result.every(v => v === 0)).toBe(true);
  });

  it('maps colored pixels to dBZ byte values', () => {
    // Green pixel (RGBA) = should map to some dBZ
    const rgba = new Uint8Array([0,255,0,255, 255,0,0,255, 0,0,0,0, 255,255,255,255]);
    const result = reverseMapTile(rgba, 2, 2);
    expect(result[0]).toBeGreaterThan(0); // green → dBZ
    expect(result[1]).toBeGreaterThan(0); // red → dBZ
    expect(result[2]).toBe(0);            // transparent → NoData
    expect(result[3]).toBe(0);            // white → rejected as non-radar
  });
});
