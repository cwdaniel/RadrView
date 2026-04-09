import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReadTile = vi.fn();
vi.mock('../../../src/storage/index.js', () => ({
  getTileStore: () => ({ readTile: mockReadTile }),
}));

// Mock airports
vi.mock('../../../src/situation/config/airports.js', () => {
  const airports = new Map([
    ['KORD', { icao: 'KORD', name: "O'Hare", lat: 41.9742, lon: -87.9073 }],
  ]);
  return {
    loadAirports: vi.fn(),
    getAirport: (icao: string) => airports.get(icao),
    getAllAirports: () => [...airports.values()],
  };
});

const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  smembers: vi.fn(),
  sadd: vi.fn(),
  srem: vi.fn(),
  zadd: vi.fn(),
  zrangebyscore: vi.fn(),
  zrevrangebyscore: vi.fn(),
  zremrangebyscore: vi.fn(),
  hgetall: vi.fn(),
};
vi.mock('ioredis', () => ({ Redis: vi.fn(() => mockRedis) }));

import { WatchlistUpdater } from '../../../src/situation/workers/watchlist-updater.js';
import { Redis } from 'ioredis';

describe('WatchlistUpdater', () => {
  let updater: WatchlistUpdater;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.smembers.mockResolvedValue([]);
    mockRedis.get.mockResolvedValue(null);
    mockRedis.hgetall.mockResolvedValue({ epochMs: String(Date.now()) });
    mockRedis.zrevrangebyscore.mockResolvedValue(['20260408143000']);
    mockReadTile.mockResolvedValue(null);
    updater = new WatchlistUpdater(new Redis() as any);
  });

  it('adds airports to watchlist', async () => {
    await updater.addToWatchlist(['KORD', 'KJFK']);
    expect(mockRedis.sadd).toHaveBeenCalledWith('situation:watchlist', 'KORD', 'KJFK');
  });

  it('removes airports from watchlist', async () => {
    await updater.removeFromWatchlist(['KORD']);
    expect(mockRedis.srem).toHaveBeenCalledWith('situation:watchlist', 'KORD');
  });

  it('gets current watchlist', async () => {
    mockRedis.smembers.mockResolvedValue(['KORD', 'KJFK']);
    const list = await updater.getWatchlist();
    expect(list).toEqual(['KORD', 'KJFK']);
  });

  it('processes new frame for empty watchlist', async () => {
    mockRedis.smembers.mockResolvedValue([]);
    const changes = await updater.processNewFrame();
    expect(changes).toHaveLength(0);
  });

  it('returns null for uncached situation', async () => {
    const result = await updater.getCachedSituation('KORD');
    expect(result).toBeNull();
  });
});
