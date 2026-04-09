import { Router } from 'express';
import type { Redis } from 'ioredis';

export function createSummaryRouter(redis: Redis): Router {
  const router = Router();

  router.get('/situation/summary', async (_req, res) => {
    const cached = await redis.get('situation:summary');
    if (cached) {
      res.json(JSON.parse(cached));
      return;
    }
    res.status(503).json({ error: 'Summary not yet computed' });
  });

  return router;
}
