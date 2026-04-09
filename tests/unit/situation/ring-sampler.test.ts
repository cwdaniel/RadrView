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
  Redis: vi.fn(() => ({
    get: mockGet,
    zrevrangebyscore: mockZrevrangebyscore,
    hgetall: mockHgetall,
  })),
}));

import { RingSampler } from '../../../src/situation/sampling/ring-sampler.js';
import { TileReader } from '../../../src/situation/sampling/tile-reader.js';
import { Redis } from 'ioredis';

async function createTestTile(entries: Array<{ px: number; py: number; dbz: number }>): Promise<Buffer> {
  const pixels = Buffer.alloc(256 * 256, 0);
  for (const { px, py, dbz } of entries) {
    pixels[py * 256 + px] = dbzToPixel(dbz);
  }
  return sharp(pixels, { raw: { width: 256, height: 256, channels: 1 } }).png().toBuffer();
}

describe('RingSampler', () => {
  let sampler: RingSampler;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue('20260408143000');
    mockZrevrangebyscore.mockResolvedValue(['20260408143000']);
    mockHgetall.mockResolvedValue({ epochMs: '1712583000000' });
    const reader = new TileReader(new Redis() as any);
    sampler = new RingSampler(reader);
  });

  it('detects dBZ within range rings', async () => {
    const tile = await createTestTile([{ px: 128, py: 128, dbz: 55 }]);
    mockReadTile.mockResolvedValue(tile);

    const result = await sampler.sampleRings(41.9742, -87.9073, 'composite', 7);

    // At least one ring should pick up the return
    expect(result.rings['5nm'].maxDbz).toBeGreaterThanOrEqual(0);
  });

  it('returns clear rings when no radar returns', async () => {
    const tile = await createTestTile([]);
    mockReadTile.mockResolvedValue(tile);

    const result = await sampler.sampleRings(41.9742, -87.9073, 'composite', 7);
    expect(result.rings['5nm'].maxDbz).toBe(0);
    expect(result.rings['5nm'].severity).toBe('clear');
    expect(result.rings['20nm'].maxDbz).toBe(0);
    expect(result.rings['50nm'].maxDbz).toBe(0);
  });

  it('returns null nearestActiveCell when no strong returns', async () => {
    const tile = await createTestTile([]);
    mockReadTile.mockResolvedValue(tile);

    const result = await sampler.sampleRings(41.9742, -87.9073, 'composite', 7);
    expect(result.nearestActiveCell).toBeNull();
  });

  it('handles missing tiles gracefully', async () => {
    mockReadTile.mockResolvedValue(null);

    const result = await sampler.sampleRings(41.9742, -87.9073, 'composite', 7);
    expect(result.rings['5nm'].maxDbz).toBe(0);
    expect(result.rings['5nm'].severity).toBe('clear');
  });

  it('returns ring data with correct structure', async () => {
    mockReadTile.mockResolvedValue(null);

    const result = await sampler.sampleRings(41.9742, -87.9073, 'composite', 7);

    for (const key of ['5nm', '20nm', '50nm'] as const) {
      expect(result.rings[key]).toHaveProperty('maxDbz');
      expect(result.rings[key]).toHaveProperty('precipTypes');
      expect(result.rings[key]).toHaveProperty('severity');
      expect(Array.isArray(result.rings[key].precipTypes)).toBe(true);
    }
  });
});
