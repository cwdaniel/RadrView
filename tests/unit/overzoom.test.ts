// tests/unit/overzoom.test.ts
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { overzoomTile, readTileWithOverzoom, type TileReader } from '../../src/server/overzoom.js';

const TILE = 256;

/** Build a single-channel grayscale PNG from a per-pixel value function. */
async function makeGrayPng(value: (x: number, y: number) => number): Promise<Buffer> {
  const raw = Buffer.alloc(TILE * TILE);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      raw[y * TILE + x] = value(x, y);
    }
  }
  return sharp(raw, { raw: { width: TILE, height: TILE, channels: 1 } }).png().toBuffer();
}

/** Decode a grayscale PNG to a flat Uint8Array of luminance values. */
async function decodeGray(png: Buffer): Promise<{ data: Uint8Array; width: number; height: number }> {
  const { data, info } = await sharp(png).grayscale().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data.buffer, data.byteOffset, info.width * info.height), width: info.width, height: info.height };
}

describe('readTileWithOverzoom', () => {
  it('returns the exact tile untouched when it exists', async () => {
    const exact = await makeGrayPng(() => 42);
    const read: TileReader = async (_s, _t, z) => (z === 9 ? exact : null);

    const result = await readTileWithOverzoom(read, 'composite', 'ts', 9, 5, 5, 2);

    expect(result).toBe(exact); // same buffer, no re-encoding
  });

  it('upscales the nearest lower-zoom ancestor when the exact tile is missing', async () => {
    const parentZ7 = await makeGrayPng(() => 80);
    const read: TileReader = async (_s, _t, z, x, y) =>
      (z === 7 && x === (9 >> 2) && y === (9 >> 2) ? parentZ7 : null);

    // Request z9 — no z9 or z8 tile exists, only z7. dz = 2.
    const result = await readTileWithOverzoom(read, 'composite', 'ts', 9, 9, 9, 2);

    expect(result).not.toBeNull();
    const { width, height, data } = await decodeGray(result!);
    expect(width).toBe(TILE);
    expect(height).toBe(TILE);
    expect([...data].every(v => v === 80)).toBe(true);
  });

  it('returns null when no ancestor exists down to minZoom', async () => {
    const read: TileReader = async () => null;
    const result = await readTileWithOverzoom(read, 'composite', 'ts', 9, 1, 1, 2);
    expect(result).toBeNull();
  });
});

describe('overzoomTile (nearest-neighbor, no dBZ interpolation)', () => {
  it('preserves exact encoded values across a NoData/data edge — never blends', async () => {
    // Hard vertical edge at x=64: NoData(0) on the left, dBZ-encoded 100 on the right.
    const parent = await makeGrayPng((x) => (x < 64 ? 0 : 100));

    // z8 top-left child (dz=1): crops parent columns 0..127, which straddles the edge.
    const result = await overzoomTile(parent, 1, 0, 0);

    const { data } = await decodeGray(result);
    // Bilinear would produce intermediate values (e.g. ~50) at the boundary, fabricating
    // reflectivity between NoData and 100. Nearest-neighbor must keep only {0, 100}.
    expect([...data].every(v => v === 0 || v === 100)).toBe(true);
    expect([...data].some(v => v === 0)).toBe(true);
    expect([...data].some(v => v === 100)).toBe(true);
  });

  it('selects the correct child quadrant of the parent', async () => {
    // Four quadrants, distinct values: TL=10 TR=20 BL=30 BR=40
    const parent = await makeGrayPng((x, y) => {
      const right = x >= 128, bottom = y >= 128;
      if (!right && !bottom) return 10;
      if (right && !bottom) return 20;
      if (!right && bottom) return 30;
      return 40;
    });

    // dz=1, child (x=1,y=1) => bottom-right quadrant => all 40
    const result = await overzoomTile(parent, 1, 1, 1);
    const { data } = await decodeGray(result);
    expect([...data].every(v => v === 40)).toBe(true);
  });
});
