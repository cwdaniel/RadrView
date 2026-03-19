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
  };
  return {
    Redis: vi.fn(() => mockRedis),
  };
});

import { createApp } from '../../src/server/index.js';
import { Redis } from 'ioredis';

describe('Tile Server', () => {
  let app: ReturnType<typeof createApp>['app'];
  let mockRedis: any;

  beforeAll(() => {
    mockRedis = new Redis() as any;
    const result = createApp(mockRedis);
    app = result.app;
  });

  describe('GET /frames/latest', () => {
    it('returns latest frame info', async () => {
      mockRedis.get.mockResolvedValue('20260318143200');
      mockRedis.hgetall.mockResolvedValue({
        source: 'mrms',
        epochMs: '1710772320000',
        tileCount: '847',
      });

      const res = await request(app).get('/frames/latest');
      expect(res.status).toBe(200);
      expect(res.body.timestamp).toBe('20260318143200');
      expect(res.body.source).toBe('mrms');
    });

    it('returns 503 when no frames available', async () => {
      mockRedis.get.mockResolvedValue(null);
      const res = await request(app).get('/frames/latest');
      expect(res.status).toBe(503);
    });
  });

  describe('GET /frames', () => {
    it('returns frame list', async () => {
      mockRedis.zrevrangebyscore.mockResolvedValue([
        '20260318143200', '1710772320000',
        '20260318143000', '1710772200000',
      ]);
      mockRedis.get.mockResolvedValue('20260318143200');

      const res = await request(app).get('/frames');
      expect(res.status).toBe(200);
      expect(res.body.frames).toHaveLength(2);
      expect(res.body.latest).toBe('20260318143200');
    });
  });

  describe('GET /health', () => {
    it('returns health status', async () => {
      mockRedis.hgetall.mockResolvedValue({
        lastSuccess: String(Date.now()),
        consecutiveErrors: '0',
      });
      mockRedis.get.mockResolvedValue('20260318143200');

      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  describe('GET /tile/:timestamp/:z/:x/:y', () => {
    it('returns transparent PNG for missing tile', async () => {
      mockRedis.get.mockResolvedValue('other-timestamp');

      const res = await request(app).get('/tile/20260318143200/4/3/5');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/image\/png/);
    });
  });
});
