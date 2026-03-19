import { Router } from 'express';
import type { Redis } from 'ioredis';

const startTime = Date.now();

export function createHealthRouter(redis: Redis): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const mrmsHealth = await redis.hgetall('source:mrms');
    const latestMrms = await redis.get('latest:mrms');

    const mrmsLastSuccess = parseInt(mrmsHealth.lastSuccess || '0');
    const mrmsAge = mrmsLastSuccess > 0 ? Math.floor((Date.now() - mrmsLastSuccess) / 1000) : -1;
    const mrmsErrors = parseInt(mrmsHealth.consecutiveErrors || '0');

    const mrmsStatus = mrmsAge < 0 ? 'unknown' : mrmsAge < 300 ? 'ok' : 'stale';

    res.json({
      status: mrmsStatus === 'ok' || mrmsStatus === 'unknown' ? 'ok' : 'degraded',
      sources: {
        mrms: {
          status: mrmsStatus,
          lastFrame: latestMrms,
          ageSeconds: mrmsAge,
          consecutiveErrors: mrmsErrors,
        },
      },
      latestComposite: latestMrms,
      uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    });
  });

  return router;
}
