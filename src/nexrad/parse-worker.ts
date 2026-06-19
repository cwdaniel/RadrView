/**
 * Worker-thread entry point for the CPU-heavy half of NEXRAD ingestion:
 * bzip2 decompression + Level 2 binary parsing + projection to Mercator.
 *
 * Running this off the main thread means a corrupt volume that sends the parser
 * into a runaway loop spins an isolated, disposable thread instead of wedging the
 * whole ingester. The parent bounds it with runWithTimeout() and terminate()s on
 * timeout (see cpu-worker.ts).
 */

import { parentPort } from 'node:worker_threads';
import { parseLevel2Reflectivity } from './parser.js';
import { projectScan } from './projector.js';
import { getStation } from './stations.js';

interface ParseJob {
  buf: Uint8Array;
  stationId: string;
}

if (!parentPort) {
  throw new Error('parse-worker must be run as a worker thread');
}

const port = parentPort;

port.on('message', (job: ParseJob) => {
  try {
    const scan = parseLevel2Reflectivity(Buffer.from(job.buf));
    if (!scan) {
      port.postMessage({ ok: false });
      return;
    }
    const station = getStation(job.stationId);
    if (!station) {
      port.postMessage({ ok: false });
      return;
    }
    const projected = projectScan(station, scan);
    port.postMessage({ ok: true, projected });
  } catch (err) {
    port.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
