import { describe, it, expect } from 'vitest';
import {
  dbzToPixel, pixelToDbz, tileToMercatorBounds, getTilesForBounds,
  extractTilePixels, isEmptyTile, parseTimestamp, EARTH_CIRCUMFERENCE,
} from '../../src/utils/geo.js';
import type { TileBounds } from '../../src/types.js';

describe('dbzToPixel', () => {
  it('maps dBZ -10 to pixel 1', () => { expect(dbzToPixel(-10)).toBe(1); });
  it('maps dBZ 80 to pixel 255', () => { expect(dbzToPixel(80)).toBe(255); });
  it('maps dBZ 35 to mid-range pixel', () => {
    const pixel = dbzToPixel(35);
    expect(pixel).toBeGreaterThan(100);
    expect(pixel).toBeLessThan(200);
  });
  it('maps NoData (-999) to 0', () => { expect(dbzToPixel(-999)).toBe(0); });
  it('maps dBZ below -10 to 0', () => { expect(dbzToPixel(-20)).toBe(0); });
});

describe('pixelToDbz', () => {
  it('maps pixel 0 to NoData (-999)', () => { expect(pixelToDbz(0)).toBe(-999); });
  it('maps pixel 1 to dBZ -10', () => { expect(pixelToDbz(1)).toBeCloseTo(-10, 1); });
  it('maps pixel 255 to dBZ 80', () => { expect(pixelToDbz(255)).toBeCloseTo(80, 1); });
  it('round-trips correctly', () => {
    for (const dbz of [-10, 0, 20, 35, 50, 65, 80]) {
      const pixel = dbzToPixel(dbz);
      const back = pixelToDbz(pixel);
      expect(back).toBeCloseTo(dbz, 0);
    }
  });
});

describe('tileToMercatorBounds', () => {
  it('returns full world extent at zoom 0 tile 0/0/0', () => {
    const bounds = tileToMercatorBounds(0, 0, 0);
    expect(bounds.west).toBeCloseTo(-20037508.343, 0);
    expect(bounds.east).toBeCloseTo(20037508.343, 0);
    expect(bounds.north).toBeCloseTo(20037508.343, 0);
    expect(bounds.south).toBeCloseTo(-20037508.343, 0);
  });
  it('splits into 4 quadrants at zoom 1', () => {
    const nw = tileToMercatorBounds(1, 0, 0);
    const se = tileToMercatorBounds(1, 1, 1);
    expect(nw.west).toBeCloseTo(-20037508.343, 0);
    expect(nw.east).toBeCloseTo(0, 0);
    expect(se.west).toBeCloseTo(0, 0);
    expect(se.south).toBeCloseTo(-20037508.343, 0);
  });
});

describe('getTilesForBounds', () => {
  it('returns single tile for full world at zoom 0', () => {
    const s = EARTH_CIRCUMFERENCE / 2;
    const tiles = getTilesForBounds(0, -s, s, s, -s);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toEqual({ z: 0, x: 0, y: 0 });
  });
  it('returns 4 tiles for full world at zoom 1', () => {
    const s = EARTH_CIRCUMFERENCE / 2;
    expect(getTilesForBounds(1, -s, s, s, -s)).toHaveLength(4);
  });
  it('returns subset for partial bounds', () => {
    const tiles = getTilesForBounds(3, -10000000, 5000000, -5000000, 2000000);
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThan(64);
    for (const t of tiles) expect(t.z).toBe(3);
  });
  it('clamps to valid tile range', () => {
    const s = EARTH_CIRCUMFERENCE / 2;
    expect(getTilesForBounds(2, -s * 2, s * 2, s * 2, -s * 2)).toHaveLength(16);
  });
});

describe('extractTilePixels', () => {
  it('extracts pixels from a simple raster', () => {
    const raster = new Uint8Array([10,20,30,40, 50,60,70,80, 90,100,110,120, 130,140,150,160]);
    const tileBounds: TileBounds = { west: 0, east: 400, north: 400, south: 0 };
    const result = extractTilePixels(raster, 4, 4, 0, 400, 100, -100, tileBounds, 4, 4);
    expect(result.length).toBe(16);
    expect(result.some(v => v > 0)).toBe(true);
  });
  it('returns zeros for tile outside raster bounds', () => {
    const raster = new Uint8Array([10, 20, 30, 40]);
    const tileBounds: TileBounds = { west: 1000, east: 2000, north: 2000, south: 1000 };
    const result = extractTilePixels(raster, 2, 2, 0, 200, 100, -100, tileBounds, 2, 2);
    expect(result.every(v => v === 0)).toBe(true);
  });
});

describe('isEmptyTile', () => {
  it('returns true for all-zero tile', () => { expect(isEmptyTile(new Uint8Array(256 * 256))).toBe(true); });
  it('returns false if any pixel is non-zero', () => {
    const data = new Uint8Array(256 * 256);
    data[1000] = 42;
    expect(isEmptyTile(data)).toBe(false);
  });
});

describe('parseTimestamp', () => {
  it('parses MRMS filename timestamp', () => {
    const result = parseTimestamp('MRMS_SeamlessHSR_00.00_20260318-143200.grib2.gz');
    expect(result.timestamp).toBe('20260318143200');
    expect(result.epochMs).toBe(Date.UTC(2026, 2, 18, 14, 32, 0));
  });
  it('throws on invalid filename', () => {
    expect(() => parseTimestamp('no-timestamp-here.txt')).toThrow();
  });
});
