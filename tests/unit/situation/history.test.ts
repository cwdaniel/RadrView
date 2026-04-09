import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRedis = {
  zadd: vi.fn(),
  zrangebyscore: vi.fn(),
  zremrangebyscore: vi.fn(),
};
vi.mock('ioredis', () => ({ Redis: vi.fn(() => mockRedis) }));

import { HistoryManager } from '../../../src/situation/analysis/history.js';
import { Redis } from 'ioredis';
import type { HistoryFrame } from '../../../src/situation/types.js';

describe('HistoryManager', () => {
  let history: HistoryManager;

  beforeEach(() => {
    vi.clearAllMocks();
    history = new HistoryManager(new Redis() as any);
  });

  it('stores a history frame', async () => {
    const frame: HistoryFrame = {
      timestamp: '2026-04-08T14:30:00Z',
      rings: {
        '5nm': { maxDbz: 42, precipTypes: ['rain'], severity: 'moderate' },
        '20nm': { maxDbz: 55, precipTypes: ['rain', 'hail'], severity: 'heavy' },
        '50nm': { maxDbz: 28, precipTypes: ['rain'], severity: 'light' },
      },
      rampStatus: 'caution',
    };
    await history.addFrame('KORD', 1712583000000, frame);
    expect(mockRedis.zadd).toHaveBeenCalledWith(
      'situation:history:KORD', 1712583000000, JSON.stringify(frame),
    );
  });

  it('retrieves frames within a time window', async () => {
    const frame = JSON.stringify({
      timestamp: '2026-04-08T14:30:00Z',
      rings: {
        '5nm': { maxDbz: 10, precipTypes: [], severity: 'clear' },
        '20nm': { maxDbz: 10, precipTypes: [], severity: 'clear' },
        '50nm': { maxDbz: 10, precipTypes: [], severity: 'clear' },
      },
      rampStatus: 'clear',
    });
    mockRedis.zrangebyscore.mockResolvedValue([frame]);
    const now = Date.now();
    const frames = await history.getFrames('KORD', 3, now);
    expect(frames).toHaveLength(1);
    expect(frames[0].rampStatus).toBe('clear');
    expect(mockRedis.zrangebyscore).toHaveBeenCalledWith(
      'situation:history:KORD', now - 3 * 3600_000, now,
    );
  });

  it('prunes old frames', async () => {
    await history.prune('KORD', 24);
    expect(mockRedis.zremrangebyscore).toHaveBeenCalledWith(
      'situation:history:KORD', '-inf', expect.any(Number),
    );
  });
});
