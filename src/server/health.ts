import { Router } from 'express';
import type { Redis } from 'ioredis';

const startTime = Date.now();

export function createHealthRouter(redis: Redis): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const [mrmsHealth, latestMrms, ecHealth, latestEc, latestComposite] = await Promise.all([
      redis.hgetall('source:mrms'),
      redis.get('latest:mrms'),
      redis.hgetall('source:ec'),
      redis.get('latest:ec'),
      redis.get('latest:composite'),
    ]);

    const mrmsLastSuccess = parseInt(mrmsHealth.lastSuccess || '0');
    const mrmsAge = mrmsLastSuccess > 0 ? Math.floor((Date.now() - mrmsLastSuccess) / 1000) : -1;
    const mrmsErrors = parseInt(mrmsHealth.consecutiveErrors || '0');
    const mrmsStatus = mrmsAge < 0 ? 'unknown' : mrmsAge < 300 ? 'ok' : 'stale';

    const ecLastSuccess = parseInt(ecHealth.lastSuccess || '0');
    const ecAge = ecLastSuccess > 0 ? Math.floor((Date.now() - ecLastSuccess) / 1000) : -1;
    const ecErrors = parseInt(ecHealth.consecutiveErrors || '0');
    const ecStatus = ecAge < 0 ? 'unknown' : ecAge < 300 ? 'ok' : 'stale';

    const overallStatus = mrmsStatus === 'ok' || ecStatus === 'ok' ? 'ok' : 'degraded';

    res.json({
      status: overallStatus,
      sources: {
        mrms: {
          status: mrmsStatus,
          lastFrame: latestMrms,
          ageSeconds: mrmsAge,
          consecutiveErrors: mrmsErrors,
        },
        ec: {
          status: ecStatus,
          lastFrame: latestEc,
          ageSeconds: ecAge,
          consecutiveErrors: ecErrors,
        },
      },
      latestComposite,
      uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    });
  });

  return router;
}
