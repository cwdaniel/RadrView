/**
 * Run a job in a worker thread with an enforceable hard timeout.
 *
 * Unlike setTimeout/AbortSignal, `worker.terminate()` stops a thread even when
 * it is wedged in a synchronous loop (e.g. a parser chewing on a corrupt NEXRAD
 * volume). The standalone ingester previously ran parse/projection synchronously
 * on the main thread, so a single poison-pill volume could spin one core at 100%
 * and block the event loop forever — defeating the existing timeout guards.
 * Isolating that work here bounds it and keeps the ingester loop responsive.
 */

import { Worker } from 'node:worker_threads';

/**
 * Spawn a worker, post `payload`, and resolve with its first message. Resolves
 * with `null` if the worker exceeds `timeoutMs`, errors, or exits without
 * replying. The worker is always terminated before resolving.
 */
export function runWithTimeout<T = unknown>(
  workerUrl: string | URL,
  payload: unknown,
  timeoutMs: number,
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const worker = new Worker(workerUrl);
    let settled = false;

    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // terminate() is safe to call repeatedly and kills a wedged thread.
      void worker.terminate();
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    worker.once('message', (msg: T) => finish(msg));
    worker.once('error', () => finish(null));
    worker.once('exit', () => finish(null));

    worker.postMessage(payload);
  });
}
