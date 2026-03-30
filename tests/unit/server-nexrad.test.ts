import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';

// Mock ioredis before importing server
vi.mock('ioredis', () => {
  const mockRedis = {
    get: vi.fn(),
    hgetall: vi.fn(),
    zrevrangebyscore: vi.fn(),
    hset: vi.fn(),
    quit: vi.fn(),
    smembers: vi.fn(),
    sadd: vi.fn(),
    expire: vi.fn(),
  };
  return {
    Redis: vi.fn(() => mockRedis),
  };
});

// Mock the wind fetcher to avoid real network/GDAL calls
vi.mock('../../src/wind/fetcher.js', () => ({
  getWindGrid: vi.fn(() => null),
  startWindFetcher: vi.fn(async () => {}),
}));

import { createApp } from '../../src/server/index.js';
import { Redis } from 'ioredis';

describe('Server NEXRAD endpoints', () => {
  let app: ReturnType<typeof createApp>['app'];
  let mockRedis: any;

  beforeAll(() => {
    mockRedis = new Redis() as any;
    const result = createApp(mockRedis);
    app = result.app;
  });

  describe('GET /nexrad/stations', () => {
    it('returns array of 159 stations', async () => {
      // Mock status calls (hgetall returns empty for all stations since no scan provider)
      mockRedis.hgetall.mockResolvedValue({});

      const res = await request(app).get('/nexrad/stations');
      expect(res.status).toBe(200);
      expect(res.body).toBeInstanceOf(Array);
      expect(res.body).toHaveLength(159);
    });

    it('each station has id, lat, lon, name, and status fields', async () => {
      mockRedis.hgetall.mockResolvedValue({});

      const res = await request(app).get('/nexrad/stations');
      expect(res.status).toBe(200);

      for (const station of res.body) {
        expect(station).toHaveProperty('id');
        expect(station).toHaveProperty('lat');
        expect(station).toHaveProperty('lon');
        expect(station).toHaveProperty('name');
        expect(station).toHaveProperty('status');
        expect(typeof station.id).toBe('string');
        expect(typeof station.lat).toBe('number');
        expect(typeof station.lon).toBe('number');
        expect(typeof station.name).toBe('string');
      }
    });

    it('includes KTLX with correct coordinates', async () => {
      mockRedis.hgetall.mockResolvedValue({});

      const res = await request(app).get('/nexrad/stations');
      const ktlx = res.body.find((s: any) => s.id === 'KTLX');
      expect(ktlx).toBeDefined();
      expect(ktlx.lat).toBeCloseTo(35.33306, 3);
      expect(ktlx.lon).toBeCloseTo(-97.2775, 3);
      expect(ktlx.name).toBe('Oklahoma City, OK');
    });

    it('station status defaults to unavailable when no scan provider', async () => {
      mockRedis.hgetall.mockResolvedValue({});

      const res = await request(app).get('/nexrad/stations');
      for (const station of res.body) {
        expect(station.status).toBe('unavailable');
      }
    });
  });

  describe('GET /wind/grid', () => {
    it('returns 503 when wind data not loaded', async () => {
      const res = await request(app).get('/wind/grid');
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/wind/i);
    });
  });

  describe('Tile endpoint with layer parameter', () => {
    it('returns 400 for invalid palette with layer param', async () => {
      mockRedis.get.mockResolvedValue('other-timestamp');

      const res = await request(app)
        .get('/tile/20260318143200/4/3/5?palette=nonexistent&layer=velocity');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/palette/i);
    });

    it('returns transparent PNG for tile at low zoom (no NEXRAD)', async () => {
      mockRedis.get.mockResolvedValue('other-timestamp');

      const res = await request(app)
        .get('/tile/20260318143200/4/3/5?layer=reflectivity');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/image\/png/);
    });
  });
});
