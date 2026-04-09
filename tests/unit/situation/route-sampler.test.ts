import { describe, it, expect, vi, beforeEach } from 'vitest';
import sharp from 'sharp';

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

import { RouteSampler } from '../../../src/situation/sampling/route-sampler.js';
import { TileReader } from '../../../src/situation/sampling/tile-reader.js';
import { Redis } from 'ioredis';
import type { Airport } from '../../../src/situation/types.js';

const KORD: Airport = { icao: 'KORD', name: "O'Hare", lat: 41.9742, lon: -87.9073 };
const KDEN: Airport = { icao: 'KDEN', name: 'Denver', lat: 39.8561, lon: -104.6737 };
const KLAX: Airport = { icao: 'KLAX', name: 'Los Angeles', lat: 33.9425, lon: -118.4081 };

describe('RouteSampler', () => {
  let sampler: RouteSampler;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue('20260408143000');
    mockHgetall.mockResolvedValue({ epochMs: '1712583000000' });

    const emptyPng = await sharp(Buffer.alloc(256 * 256, 0), {
      raw: { width: 256, height: 256, channels: 1 },
    }).png().toBuffer();
    mockReadTile.mockResolvedValue(emptyPng);

    const reader = new TileReader(new Redis() as any);
    sampler = new RouteSampler(reader);
  });

  it('generates sample points along a segment', async () => {
    const result = await sampler.sampleRoute([KORD, KDEN], 'composite', 7);
    expect(result.length).toBe(1);
    expect(result[0].from).toBe('KORD');
    expect(result[0].to).toBe('KDEN');
    expect(result[0].distanceNm).toBeGreaterThan(600);
    expect(result[0].samplePoints.length).toBeGreaterThan(5);
  });

  it('first sample point is at origin airport', async () => {
    const result = await sampler.sampleRoute([KORD, KDEN], 'composite', 7);
    const first = result[0].samplePoints[0];
    expect(first.distanceNm).toBe(0);
    expect(first.lat).toBeCloseTo(KORD.lat, 1);
    expect(first.lon).toBeCloseTo(KORD.lon, 1);
  });

  it('returns clear recommendation for empty tiles', async () => {
    const result = await sampler.sampleRoute([KORD, KDEN], 'composite', 7);
    expect(result[0].severity).toBe('clear');
    expect(result[0].recommendation).toBe('clear');
    expect(result[0].significantCells).toBe(0);
  });

  it('handles multi-segment routes', async () => {
    const result = await sampler.sampleRoute([KORD, KDEN, KLAX], 'composite', 7);
    expect(result.length).toBe(2);
    expect(result[0].from).toBe('KORD');
    expect(result[0].to).toBe('KDEN');
    expect(result[1].from).toBe('KDEN');
    expect(result[1].to).toBe('KLAX');
  });
});
