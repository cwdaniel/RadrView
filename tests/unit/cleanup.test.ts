import { describe, it, expect } from 'vitest';
import { getCleanupCutoffMs } from '../../src/pipeline/cleanup.js';

describe('getCleanupCutoffMs', () => {
  it('returns epoch ms for N hours ago', () => {
    const now = Date.now();
    const cutoff = getCleanupCutoffMs(24, now);
    const expected = now - 24 * 60 * 60 * 1000;
    expect(cutoff).toBe(expected);
  });

  it('handles fractional hours', () => {
    const now = Date.now();
    const cutoff = getCleanupCutoffMs(0.5, now);
    const expected = now - 0.5 * 60 * 60 * 1000;
    expect(cutoff).toBe(expected);
  });
});
