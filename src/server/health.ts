import { Router } from 'express';
import type { Redis } from 'ioredis';

const startTime = Date.now();

const SOURCE_NAMES = ['mrms', 'mrms-alaska', 'mrms-hawaii', 'ec'];

async function getSourceHealth(redis: Redis, name: string) {
  const [health, latest] = await Promise.all([
    redis.hgetall(`source:${name}`),
    redis.get(`latest:${name}`),
  ]);
  const lastSuccess = parseInt(health.lastSuccess || '0');
  const age = lastSuccess > 0 ? Math.floor((Date.now() - lastSuccess) / 1000) : -1;
  const errors = parseInt(health.consecutiveErrors || '0');
  const status = age < 0 ? 'unknown' : age < 300 ? 'ok' : 'stale';
  return { status, lastFrame: latest, ageSeconds: age, consecutiveErrors: errors };
}

export function createHealthRouter(redis: Redis): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const results = await Promise.all(
      SOURCE_NAMES.map(async name => [name, await getSourceHealth(redis, name)] as const),
    );

    const sources: Record<string, any> = {};
    let anyOk = false;
    for (const [name, health] of results) {
      sources[name] = health;
      if (health.status === 'ok') anyOk = true;
    }

    const latestComposite = await redis.get('latest:composite');

    res.json({
      status: anyOk ? 'ok' : 'degraded',
      sources,
      latestComposite,
      uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    });
  });

  return router;
}
