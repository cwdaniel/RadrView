import { parentPort } from 'node:worker_threads';

// Test fixture: echo the payload straight back.
parentPort.on('message', (payload) => {
  parentPort.postMessage({ ok: true, echo: payload });
});
