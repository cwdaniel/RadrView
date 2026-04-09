import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReadTile = vi.fn();
vi.mock('../../../src/storage/index.js', () => ({
  getTileStore: () => ({ readTile: mockReadTile }),
}));

const mockGet = vi.fn();
const mockSet = vi.fn();
const mockHgetall = vi.fn();
const mockZrevrangebyscore = vi.fn();
vi.mock('ioredis', () => ({
  Redis: vi.fn(() => ({
    get: mockGet, set: mockSet, hgetall: mockHgetall,
    zrevrangebyscore: mockZrevrangebyscore,
  })),
}));

import { CellDetector } from '../../../src/situation/sampling/cell-detector.js';
import { TileReader } from '../../../src/situation/sampling/tile-reader.js';
import { Redis } from 'ioredis';

describe('CellDetector', () => {
  let detector: CellDetector;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(null);
    mockReadTile.mockResolvedValue(null);
    const reader = new TileReader(new Redis() as any);
    detector = new CellDetector(reader, new Redis() as any);
  });

  it('returns empty FeatureCollection when no timestamp', async () => {
    const result = await detector.detectCells(35);
    expect(result.type).toBe('FeatureCollection');
    expect(result.features).toHaveLength(0);
  });

  it('returns empty FeatureCollection when no tiles exist', async () => {
    mockGet.mockImplementation(async (key: string) => {
      if (key === 'latest:composite') return '20260408143000';
      return null;
    });

    const result = await detector.detectCells(35);
    expect(result.type).toBe('FeatureCollection');
    expect(result.features).toHaveLength(0);
  });

  it('returns cached result if available', async () => {
    const cached = { type: 'FeatureCollection', features: [{ mock: true }] };
    mockGet.mockImplementation(async (key: string) => {
      if (key === 'latest:composite') return '20260408143000';
      if (key.startsWith('cells:')) return JSON.stringify(cached);
      return null;
    });

    const result = await detector.detectCells(35);
    expect(result.features).toHaveLength(1);
  });
});
