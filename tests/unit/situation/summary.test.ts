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

import { SummaryAnalyzer } from '../../../src/situation/analysis/summary.js';
import { TileReader } from '../../../src/situation/sampling/tile-reader.js';
import { Redis } from 'ioredis';
import type { RegionConfig } from '../../../src/situation/types.js';

const testRegion: RegionConfig = {
  id: 'test-region',
  label: 'Test Region',
  bounds: { north: 45, south: 38, east: -70, west: -79 },
  airports: ['KJFK', 'KEWR'],
};

describe('SummaryAnalyzer', () => {
  let analyzer: SummaryAnalyzer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(null);
    mockHgetall.mockResolvedValue({});
    mockReadTile.mockResolvedValue(null);
    const reader = new TileReader(new Redis() as any);
    analyzer = new SummaryAnalyzer(reader, new Redis() as any);
  });

  it('returns clear region when no tiles exist', async () => {
    const result = await analyzer.analyzeRegion(testRegion, 'composite');
    expect(result.maxDbz).toBe(0);
    expect(result.severity).toBe('clear');
    expect(result.coveragePct).toBe(0);
    expect(result.id).toBe('test-region');
    expect(result.affectedAirports).toEqual([]);
  });

  it('computes data age from epoch', () => {
    const age = analyzer.computeDataAge(Date.now() - 100_000);
    expect(age).toBeCloseTo(100, -1);
  });

  it('returns unknown trend when no previous timestamp', async () => {
    const result = await analyzer.analyzeRegion(testRegion, 'composite');
    expect(result.trend).toBe('unknown');
  });
});
