import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';

const mockReadTile = vi.fn();
vi.mock('../../../src/storage/index.js', () => ({
  getTileStore: () => ({ readTile: mockReadTile }),
}));

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
  sismember: vi.fn(),
  quit: vi.fn(),
};
vi.mock('ioredis', () => ({ Redis: vi.fn(() => mockRedis) }));

vi.mock('../../../src/situation/config/airports.js', () => {
  const airports = new Map([
    ['KORD', { icao: 'KORD', name: "O'Hare", lat: 41.9742, lon: -87.9073 }],
    ['KJFK', { icao: 'KJFK', name: 'JFK', lat: 40.6413, lon: -73.7781 }],
  ]);
  return {
    loadAirports: vi.fn(),
    getAirport: (icao: string) => airports.get(icao),
    getAllAirports: () => [...airports.values()],
  };
});

import { createSituationApp } from '../../../src/situation/server.js';
import { Redis } from 'ioredis';

describe('Situation API Server', () => {
  let app: ReturnType<typeof createSituationApp>['app'];

  beforeAll(() => {
    mockRedis.get.mockResolvedValue(null);
    mockRedis.hgetall.mockResolvedValue({});
    mockRedis.smembers.mockResolvedValue([]);
    mockRedis.zrevrangebyscore.mockResolvedValue([]);
    mockReadTile.mockResolvedValue(null);

    const result = createSituationApp(new Redis() as any);
    app = result.app;
  });

  describe('GET /situation/airport/:icao', () => {
    it('returns 404 for unknown ICAO', async () => {
      const res = await request(app).get('/situation/airport/ZZZZ');
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });

    it('returns cached situation for valid ICAO', async () => {
      mockRedis.get.mockImplementation(async (key: string) => {
        if (key === 'situation:airport:KORD') {
          return JSON.stringify({
            icao: 'KORD',
            timestamp: '2026-04-08T14:30:00Z',
            dataAge: 87,
            rings: {
              '5nm': { maxDbz: 42, precipTypes: ['rain'], severity: 'moderate' },
              '20nm': { maxDbz: 55, precipTypes: ['rain', 'hail'], severity: 'heavy' },
              '50nm': { maxDbz: 28, precipTypes: ['rain'], severity: 'light' },
            },
            trend: 'intensifying',
            rampStatus: 'caution',
            nearestActiveCell: { distanceNm: 8.2, bearing: 247, dbz: 55 },
          });
        }
        return null;
      });

      const res = await request(app).get('/situation/airport/KORD');
      expect(res.status).toBe(200);
      expect(res.body.icao).toBe('KORD');
      expect(res.body.rings['5nm'].severity).toBe('moderate');
      expect(res.body.rampStatus).toBe('caution');
    });
  });

  describe('GET /situation/summary', () => {
    it('returns cached summary', async () => {
      mockRedis.get.mockImplementation(async (key: string) => {
        if (key === 'situation:summary') {
          return JSON.stringify({
            generated: '2026-04-08T14:30:00Z',
            dataAge: 87,
            regions: [],
            systemStatus: 'operational',
          });
        }
        return null;
      });

      const res = await request(app).get('/situation/summary');
      expect(res.status).toBe(200);
      expect(res.body.systemStatus).toBe('operational');
    });

    it('returns 503 when summary not computed', async () => {
      mockRedis.get.mockResolvedValue(null);
      const res = await request(app).get('/situation/summary');
      expect(res.status).toBe(503);
    });
  });

  describe('GET /situation/route', () => {
    it('returns 400 without waypoints', async () => {
      const res = await request(app).get('/situation/route');
      expect(res.status).toBe(400);
    });

    it('returns 400 with single waypoint', async () => {
      const res = await request(app).get('/situation/route?waypoints=KORD');
      expect(res.status).toBe(400);
    });

    it('returns 400 for unknown airport in route', async () => {
      const res = await request(app).get('/situation/route?waypoints=KORD,ZZZZ');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/ZZZZ/);
    });
  });

  describe('GET /situation/airport/:icao/history', () => {
    it('returns 404 for unknown ICAO', async () => {
      const res = await request(app).get('/situation/airport/ZZZZ/history');
      expect(res.status).toBe(404);
    });

    it('returns 404 for unwatched airport', async () => {
      mockRedis.sismember.mockResolvedValue(0);
      const res = await request(app).get('/situation/airport/KORD/history');
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/watchlist/i);
    });
  });

  describe('GET /overlays/cells.geojson', () => {
    it('returns empty FeatureCollection when no data', async () => {
      mockRedis.get.mockResolvedValue(null);
      const res = await request(app).get('/overlays/cells.geojson');
      expect(res.status).toBe(200);
      expect(res.body.type).toBe('FeatureCollection');
      expect(res.body.features).toHaveLength(0);
    });

    it('returns 400 for invalid bounds', async () => {
      const res = await request(app).get('/overlays/cells.geojson?bounds=abc');
      expect(res.status).toBe(400);
    });
  });
});
