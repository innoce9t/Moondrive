'use strict';

/**
 * Worker entry point for parallel scanning. Each worker scans one top-level
 * subtree with a normal ScanSession and posts progress + the finished result
 * back to the main thread. Callbacks can't cross the thread boundary, so the
 * worker wires its own onProgress that forwards counts via postMessage.
 */

const { parentPort, workerData } = require('worker_threads');
const { ScanSession } = require('./scanner');

(async () => {
  const { rootPath, opts } = workerData;
  const session = new ScanSession(rootPath, {
    ...opts,
    onProgress: (p) => parentPort.postMessage({ type: 'progress', p }),
  });

  parentPort.on('message', (msg) => {
    if (msg && msg.type === 'cancel') session.cancel();
  });

  try {
    const res = await session.run();
    parentPort.postMessage({ type: 'done', root: res.root, stats: res.stats });
  } catch (e) {
    parentPort.postMessage({ type: 'error', error: e.message });
  }
})();
