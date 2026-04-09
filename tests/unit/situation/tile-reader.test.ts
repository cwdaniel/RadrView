import { describe, it, expect, vi, beforeEach } from 'vitest';
import sharp from 'sharp';
import { dbzToPixel } from '../../../src/utils/geo.js';

const mockReadTile = vi.fn();
vi.mock('../../../src/storage/index.js', () => ({
  getTileStore: () => ({ readTile: mockReadTile }),
}));

const mockGet = vi.fn();
const mockZrevrangebyscore = vi.fn();
const mockHgetall = vi.fn();
vi.mock('ioredis', () => ({
  Redis: vi.fn(() => ({ get: mockGet, zrevrangebyscore: mockZrevrangebyscore, hgetall: mockHgetall })),
}));

import { TileReader } from '../../../src/situation/sampling/tile-reader.js';
import { Redis } from 'ioredis';

describe('TileReader', () => {
  let reader: TileReader;

  beforeEach(() => {
    vi.clearAllMocks();
    reader = new TileReader(new Redis() as any);
  });

  it('reads and decodes a tile to dBZ values', async () => {
    mockGet.mockResolvedValue('20260408143000');

    const pixel40dbz = dbzToPixel(40);
    const pixels = Buffer.alloc(256 * 256, 0);
    pixels[10 * 256 + 10] = pixel40dbz;

    const png = await sharp(pixels, { raw: { width: 256, height: 256, channels: 1 } })
      .png()
      .toBuffer();

    mockReadTile.mockResolvedValue(png);

    const result = await reader.readTileDbz('composite', 7, 34, 49);
    expect(result).not.toBeNull();
    expect(result!.width).toBe(256);
    expect(result!.height).toBe(256);

    const idx = 10 * 256 + 10;
    expect(result!.dbzValues[idx]).toBeCloseTo(40, 0);
    expect(result!.dbzValues[0]).toBeNaN();
  });

  it('returns null for missing tile', async () => {
    mockGet.mockResolvedValue('20260408143000');
    mockReadTile.mockResolvedValue(null);

    const result = await reader.readTileDbz('composite', 7, 34, 49);
    expect(result).toBeNull();
  });

  it('gets latest timestamp from Redis', async () => {
    mockGet.mockResolvedValue('20260408143000');
    const ts = await reader.getLatestTimestamp('composite');
    expect(ts).toBe('20260408143000');
  });

  it('gets previous timestamp from Redis', async () => {
    mockZrevrangebyscore.mockResolvedValue(['20260408143000', '20260408142500']);
    const ts = await reader.getPreviousTimestamp('composite');
    expect(ts).toBe('20260408142500');
  });

  it('returns null for previous when only one frame', async () => {
    mockZrevrangebyscore.mockResolvedValue(['20260408143000']);
    const ts = await reader.getPreviousTimestamp('composite');
    expect(ts).toBeNull();
  });

  it('maps precip type codes to labels', () => {
    expect(reader.precipTypeLabel(1)).toBe('rain');
    expect(reader.precipTypeLabel(2)).toBe('snow');
    expect(reader.precipTypeLabel(3)).toBe('freezing_rain');
    expect(reader.precipTypeLabel(5)).toBe('hail');
    expect(reader.precipTypeLabel(99)).toBeNull();
  });
});
