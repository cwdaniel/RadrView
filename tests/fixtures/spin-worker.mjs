import { parentPort } from 'node:worker_threads';

// Test fixture: simulate a runaway synchronous parse — blocks the worker's
// event loop forever and never replies. Only worker.terminate() can stop it.
parentPort.on('message', () => {
  // eslint-disable-next-line no-constant-condition
  while (true) { /* spin */ }
});
