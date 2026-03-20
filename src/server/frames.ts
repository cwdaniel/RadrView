import { Router } from 'express';
import type { Redis } from 'ioredis';
import { SOURCES } from '../config/sources.js';

export function createFramesRouter(redis: Redis): Router {
  const router = Router();

  router.get('/sources', (_req, res) => {
    const sources = [
      { name: 'composite', description: 'All sources merged' },
      ...Object.values(SOURCES).map(s => ({ name: s.name, description: s.product })),
    ];
    res.json({ sources });
  });

  router.get('/frames', async (req, res) => {
    const source = (req.query.source as string) || 'composite';
    const limit = Math.min(parseInt(req.query.limit as string) || 720, 2000);
    const since = req.query.since ? parseInt(req.query.since as string) : 0;

    const frames = await redis.zrevrangebyscore(
      `frames:${source}`,
      '+inf',
      since > 0 ? String(since) : '-inf',
      'WITHSCORES',
      'LIMIT',
      0,
      limit,
    );

    const result = [];
    for (let i = 0; i < frames.length; i += 2) {
      result.push({
        timestamp: frames[i],
        epochMs: parseInt(frames[i + 1]),
      });
    }
    result.reverse();

    const latest = await redis.get(`latest:${source}`);

    res.json({ source, frames: result, latest, count: result.length });
  });

  router.get('/frames/latest', async (req, res) => {
    const source = (req.query.source as string) || 'composite';
    const latest = await redis.get(`latest:${source}`);

    if (!latest) {
      res.status(503).json({ error: 'No frames available yet' });
      return;
    }

    const meta = await redis.hgetall(`frame:${latest}`);
    res.json({
      timestamp: latest,
      epochMs: parseInt(meta.epochMs || '0'),
      source: meta.source || source,
      age: Math.floor((Date.now() - parseInt(meta.epochMs || '0')) / 1000),
    });
  });

  return router;
}
