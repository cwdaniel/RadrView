// tests/unit/palette.test.ts
import { describe, it, expect } from 'vitest';
import {
  interpolateColor,
  buildLUT,
  colorizeTile,
  type PaletteDefinition,
} from '../../src/server/palette.js';
import { pixelToDbz } from '../../src/utils/geo.js';

const testPalette: PaletteDefinition = {
  name: 'test',
  description: 'Test palette',
  stops: [
    { dbz: 10, color: [0, 255, 0, 200] },
    { dbz: 30, color: [255, 255, 0, 230] },
    { dbz: 50, color: [255, 0, 0, 255] },
  ],
};

describe('interpolateColor', () => {
  it('returns transparent below first stop', () => {
    const color = interpolateColor(testPalette.stops, 5);
    expect(color).toEqual([0, 0, 0, 0]);
  });

  it('returns exact color at a stop', () => {
    const color = interpolateColor(testPalette.stops, 10);
    expect(color).toEqual([0, 255, 0, 200]);
  });

  it('interpolates between stops', () => {
    const color = interpolateColor(testPalette.stops, 20);
    // Midpoint between [0,255,0,200] and [255,255,0,230]
    expect(color[0]).toBeGreaterThan(100); // R increasing
    expect(color[1]).toBe(255);            // G stays 255
    expect(color[2]).toBe(0);              // B stays 0
    expect(color[3]).toBeGreaterThan(210); // A increasing
  });

  it('clamps above last stop', () => {
    const color = interpolateColor(testPalette.stops, 80);
    expect(color).toEqual([255, 0, 0, 255]);
  });
});

describe('buildLUT', () => {
  it('returns 1024-byte Uint8Array (256 entries x 4 channels)', () => {
    const lut = buildLUT(testPalette);
    expect(lut.table).toBeInstanceOf(Uint8Array);
    expect(lut.table.length).toBe(256 * 4);
    expect(lut.name).toBe('test');
  });

  it('index 0 is transparent (NoData)', () => {
    const lut = buildLUT(testPalette);
    expect(lut.table[0]).toBe(0); // R
    expect(lut.table[1]).toBe(0); // G
    expect(lut.table[2]).toBe(0); // B
    expect(lut.table[3]).toBe(0); // A
  });

  it('uses correct inverse formula for pixel-to-dBZ', () => {
    const lut = buildLUT(testPalette);
    // Pixel 1 → dBZ -10 → below first stop (10) → transparent
    expect(lut.table[1 * 4 + 3]).toBe(0); // A = 0

    // Find a pixel that maps to ~30 dBZ (at stop 2)
    // dBZ 30 → pixel = ((30+10)/90)*254+1 ≈ 114
    const px = 114;
    const dbz = pixelToDbz(px);
    expect(dbz).toBeCloseTo(30, 0);
    // At dBZ 30 → color should be [255, 255, 0, 230]
    expect(lut.table[px * 4 + 0]).toBeCloseTo(255, -1); // R
    expect(lut.table[px * 4 + 1]).toBeCloseTo(255, -1); // G
    expect(lut.table[px * 4 + 2]).toBeCloseTo(0, -1);   // B
  });
});

describe('colorizeTile', () => {
  it('applies LUT to grayscale pixels', () => {
    const lut = buildLUT(testPalette);
    // 2x2 grayscale tile: [0, 1, 128, 255]
    const grayscale = new Uint8Array([0, 1, 128, 255]);
    const rgba = colorizeTile(grayscale, lut);

    expect(rgba.length).toBe(16); // 4 pixels x 4 channels

    // Pixel 0 → NoData → transparent
    expect(rgba[0]).toBe(0);
    expect(rgba[3]).toBe(0);

    // Pixel 255 → max dBZ → should have color
    expect(rgba[12]).toBeGreaterThan(0); // R
    expect(rgba[15]).toBeGreaterThan(0); // A
  });
});
