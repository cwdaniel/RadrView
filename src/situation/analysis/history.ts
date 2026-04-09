import type { Redis } from 'ioredis';
import type { HistoryFrame } from '../types.js';

const KEY_PREFIX = 'situation:history:';

export class HistoryManager {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async addFrame(icao: string, epochMs: number, frame: HistoryFrame): Promise<void> {
    await this.redis.zadd(`${KEY_PREFIX}${icao}`, epochMs, JSON.stringify(frame));
  }

  async getFrames(icao: string, hours: number, now?: number): Promise<HistoryFrame[]> {
    const currentMs = now ?? Date.now();
    const minMs = currentMs - hours * 3600_000;
    const raw = await this.redis.zrangebyscore(`${KEY_PREFIX}${icao}`, minMs, currentMs);
    return raw.map((s: string) => JSON.parse(s));
  }

  async prune(icao: string, retentionHours: number): Promise<void> {
    const cutoff = Date.now() - retentionHours * 3600_000;
    await this.redis.zremrangebyscore(`${KEY_PREFIX}${icao}`, '-inf', cutoff);
  }
}
