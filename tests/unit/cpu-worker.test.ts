// tests/unit/cpu-worker.test.ts
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runWithTimeout } from '../../src/nexrad/cpu-worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '../fixtures');

describe('runWithTimeout', () => {
  it('returns the worker message for a job that finishes in time', async () => {
    const result = await runWithTimeout(
      path.join(fixtures, 'echo-worker.mjs'),
      { hello: 'world' },
      2000,
    );
    expect(result).toEqual({ ok: true, echo: { hello: 'world' } });
  });

  it('terminates a runaway synchronous job and resolves null without hanging', async () => {
    const start = Date.now();
    const result = await runWithTimeout(
      path.join(fixtures, 'spin-worker.mjs'),
      {},
      300,
    );
    const elapsed = Date.now() - start;

    expect(result).toBeNull();
    // A setTimeout/AbortSignal cannot interrupt the worker's infinite loop —
    // only terminate() can. If this returns promptly, the kill worked.
    expect(elapsed).toBeLessThan(3000);
  });
});
