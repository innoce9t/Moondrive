'use strict';

/**
 * Parallel scanner: splits the root's top-level subdirectories across a pool of
 * worker threads, each running a normal ScanSession, then merges their trees
 * and stats. On many-core machines with fast storage this exceeds single-thread
 * syscall throughput — "indexing multiple pathways at the same time" at the
 * process level. It mirrors ScanSession's shape (run/cancel) so callers can use
 * either interchangeably.
 *
 * Trade-off: hardlink dedup is per-worker (a hardlink spanning two different
 * top-level subtrees may be counted twice). This is rare and documented.
 */

const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const { mergeStats, categorize, extensionOf, SKIP_DIR_NAMES, PSEUDO_PATHS } = require('./scanner');

class ParallelScanSession {
  constructor(rootPath, opts = {}) {
    this.rootPath = rootPath;
    this.opts = opts;
    this.onProgress = opts.onProgress || (() => {});
    this.onSubtree = opts.onSubtree || (() => {});
    this.workers = new Set();
    this.cancelled = false;
    const cpu = os.cpus() ? os.cpus().length : 4;
    this.poolSize = Math.max(2, Math.min(opts.workers || cpu, 8));
  }

  cancel() {
    this.cancelled = true;
    for (const w of this.workers) {
      try {
        w.postMessage({ type: 'cancel' });
      } catch (e) {
        /* ignore */
      }
    }
  }

  async run() {
    const rootStat = await fsp.lstat(this.rootPath);
    const entries = await fsp.readdir(this.rootPath, { withFileTypes: true });

    const topFiles = [];
    const topDirs = [];
    for (const e of entries) {
      if (e.isSymbolicLink() && !this.opts.followSymlinks) continue;
      const childPath = path.join(this.rootPath, e.name);
      if (e.isDirectory()) {
        const nameLower = e.name.toLowerCase();
        if (this.opts.skipSystemPaths !== false && (SKIP_DIR_NAMES.has(nameLower) || PSEUDO_PATHS.has(childPath))) {
          continue;
        }
        topDirs.push(childPath);
      } else if (e.isFile()) {
        topFiles.push({ name: e.name, path: childPath });
      }
    }

    // Root node + running totals. dirs starts at 1 for the root itself.
    const rootNode = {
      name: path.basename(this.rootPath) || this.rootPath,
      path: this.rootPath,
      type: 'dir',
      size: 0,
      ext: '',
      category: 'folder',
      mtimeMs: rootStat.mtimeMs,
      childCount: 0,
      children: [],
    };
    const merged = {
      files: 0,
      dirs: 1,
      totalSize: 0,
      totalAllocated: 0,
      errors: 0,
      reused: 0,
      byCategory: {},
      largest: [],
    };
    const seenInodes = this.opts.dedupHardlinks !== false ? new Set() : null;

    // Stat the root's own loose files on the main thread (usually few).
    await Promise.all(
      topFiles.map(async (f) => {
        let st;
        try {
          st = await fsp.lstat(f.path);
        } catch (e) {
          merged.errors++;
          return;
        }
        const ext = extensionOf(f.name);
        const fileNode = {
          name: f.name,
          path: f.path,
          type: 'file',
          size: st.size,
          ext,
          category: categorize(ext),
          mtimeMs: st.mtimeMs,
          atimeMs: st.atimeMs,
          allocSize: st.blocks != null ? st.blocks * 512 : st.size,
        };
        rootNode.children.push(fileNode);
        rootNode.size += st.size;
        rootNode.childCount++;
        merged.files++;
        let dup = false;
        if (seenInodes && st.nlink > 1 && st.ino) {
          const key = `${st.dev}:${st.ino}`;
          if (seenInodes.has(key)) dup = true;
          else seenInodes.add(key);
        }
        if (!dup) {
          merged.totalSize += st.size;
          merged.totalAllocated += fileNode.allocSize;
          const c = (merged.byCategory[fileNode.category] = merged.byCategory[fileNode.category] || { count: 0, size: 0 });
          c.count++;
          c.size += st.size;
        }
      })
    );

    // Progress: aggregate the latest counts reported by each worker + main.
    const workerProgress = new Map(); // childPath -> latest {files,dirs,totalSize,errors}
    const emit = () => {
      let f = merged.files;
      let d = merged.dirs;
      let s = merged.totalSize;
      let er = merged.errors;
      for (const p of workerProgress.values()) {
        f += p.files || 0;
        d += p.dirs || 0;
        s += p.totalSize || 0;
        er += p.errors || 0;
      }
      this.onProgress({ files: f, dirs: d, totalSize: s, errors: er, reused: merged.reused });
    };

    // Worker pool over topDirs.
    const workerOpts = this._serializableOpts();
    const queue = topDirs.slice();
    const workerFile = path.join(__dirname, 'scanner-worker.js');

    const runOne = (childPath) =>
      new Promise((resolve) => {
        if (this.cancelled) return resolve(null);
        const worker = new Worker(workerFile, { workerData: { rootPath: childPath, opts: workerOpts } });
        this.workers.add(worker);
        worker.on('message', (msg) => {
          if (msg.type === 'progress') {
            workerProgress.set(childPath, msg.p);
            emit();
          } else if (msg.type === 'done') {
            // mergeStats folds this worker's totals into `merged`, so drop its
            // in-flight progress entry to avoid double-counting in emit().
            mergeStats(merged, msg.stats, 200);
            workerProgress.delete(childPath);
            rootNode.children.push(msg.root);
            rootNode.size += msg.root.size;
            rootNode.childCount++;
            if (this.onSubtree) this.onSubtree(msg.root);
            worker.terminate();
            this.workers.delete(worker);
            resolve(msg.root);
          } else if (msg.type === 'error') {
            merged.errors++;
            worker.terminate();
            this.workers.delete(worker);
            resolve(null);
          }
        });
        worker.on('error', () => {
          merged.errors++;
          this.workers.delete(worker);
          resolve(null);
        });
      });

    // Bounded pool: keep poolSize workers busy pulling from the queue.
    const pump = async () => {
      while (queue.length && !this.cancelled) {
        const next = queue.shift();
        await runOne(next);
      }
    };
    await Promise.all(Array.from({ length: this.poolSize }, () => pump()));

    // mergeStats folds worker dirs/files into merged; recompute root aggregates.
    rootNode.children.sort((a, b) => b.size - a.size);
    emit();

    return { root: rootNode, stats: merged, cancelled: this.cancelled };
  }

  // Strip non-cloneable fields (functions) before handing opts to a worker.
  _serializableOpts() {
    const { onProgress, onSubtree, previousTree, ...rest } = this.opts;
    return rest;
  }
}

module.exports = { ParallelScanSession };
