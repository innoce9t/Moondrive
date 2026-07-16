'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

/**
 * File-type categorisation. Each category maps to a colour bucket used by the
 * renderer's node graph. Keep the keys in sync with CATEGORY_COLORS in the UI.
 */
const CATEGORY_MAP = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'tif', 'webp', 'svg', 'heic', 'raw', 'cr2', 'nef', 'ico'],
  video: ['mp4', 'mkv', 'mov', 'avi', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp'],
  audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'aiff', 'opus'],
  document: ['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'md', 'pages', 'key', 'numbers', 'epub'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'dmg', 'pkg', 'deb', 'rpm'],
  code: ['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'html', 'css', 'json', 'xml', 'yml', 'yaml', 'sh', 'sql', 'swift', 'kt'],
  executable: ['exe', 'msi', 'app', 'bin', 'apk', 'jar', 'bat', 'cmd', 'com'],
};

const EXT_TO_CATEGORY = (() => {
  const map = {};
  for (const [cat, exts] of Object.entries(CATEGORY_MAP)) {
    for (const ext of exts) map[ext] = cat;
  }
  return map;
})();

function categorize(ext) {
  return EXT_TO_CATEGORY[ext] || 'other';
}

function extensionOf(name) {
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return '';
  return name.slice(idx + 1).toLowerCase();
}

/**
 * A counting semaphore that bounds how many async operations run at once.
 * File scanning is I/O-bound, so issuing many readdir/stat calls concurrently
 * (rather than one-at-a-time) is what makes large drives scan fast — while the
 * cap keeps us from exhausting file descriptors.
 */
class Semaphore {
  constructor(max) {
    this.max = max;
    this.count = 0;
    this.queue = [];
  }
  async run(fn) {
    if (this.count >= this.max) {
      await new Promise((resolve) => this.queue.push(resolve));
    }
    this.count++;
    try {
      return await fn();
    } finally {
      this.count--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

/**
 * A bounded min-heap that keeps the top-K largest items by `size`. Inserting is
 * O(log k), versus re-sorting a capped array on every insert. The root of the
 * heap is always the smallest of the retained items, so we can reject a new
 * candidate in O(1) once the heap is full.
 */
class BoundedMaxByMinHeap {
  constructor(cap) {
    this.cap = cap;
    this.a = []; // binary min-heap by size
  }
  get size() {
    return this.a.length;
  }
  add(item) {
    const a = this.a;
    if (a.length < this.cap) {
      a.push(item);
      this._up(a.length - 1);
    } else if (item.size > a[0].size) {
      a[0] = item;
      this._down(0);
    }
  }
  toSortedDesc() {
    return this.a.slice().sort((x, y) => y.size - x.size);
  }
  _up(i) {
    const a = this.a;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].size <= a[i].size) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  _down(i) {
    const a = this.a;
    const n = a.length;
    for (;;) {
      let s = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < n && a[l].size < a[s].size) s = l;
      if (r < n && a[r].size < a[s].size) s = r;
      if (s === i) break;
      [a[s], a[i]] = [a[i], a[s]];
      i = s;
    }
  }
}

// Directory names to skip anywhere (recycle bins, restore points, trashes).
const SKIP_DIR_NAMES = new Set([
  '$recycle.bin',
  'system volume information',
  '$sysreset',
  '.trash',
  '.trashes',
  '.spotlight-v100',
  '.fseventsd',
]);

// Absolute pseudo/virtual filesystem roots to skip on a root scan.
const PSEUDO_PATHS = new Set(
  process.platform === 'win32'
    ? []
    : ['/proc', '/sys', '/dev', '/run', '/var/run', '/private/var/vm']
);

/**
 * A scan session. Handles a single recursive walk of a root path, streaming
 * progress and remaining cancellable. Produces an aggregated tree.
 *
 * The walk runs many directory reads and file stats concurrently (bounded by
 * `concurrency`) instead of sequentially, which is a large speed-up on real
 * drives where the bottleneck is I/O latency, not CPU.
 *
 * Options:
 *  - followSymlinks     descend into symlinked directories (default false)
 *  - concurrency        max in-flight fs operations (default 48)
 *  - sameDeviceOnly     do not cross filesystem/mount boundaries (default false)
 *  - skipSystemPaths    skip recycle bins / pseudo filesystems (default true)
 *  - dedupHardlinks     count a hardlinked inode's bytes once in totals (default true)
 *  - previousTree       a prior scan's root node, enabling incremental reuse
 *  - fastRescan         reuse subtrees whose directory mtime is unchanged (needs previousTree)
 *  - onSubtree(node)    called when a direct child of the root finishes (progressive UI)
 */
class ScanSession {
  constructor(rootPath, opts = {}) {
    const {
      onProgress,
      onSubtree,
      followSymlinks = false,
      concurrency = 48,
      sameDeviceOnly = false,
      skipSystemPaths = true,
      dedupHardlinks = true,
      previousTree = null,
      fastRescan = false,
      recordDirMtimes = false,
    } = opts;

    this.rootPath = rootPath;
    this.onProgress = onProgress || (() => {});
    this.onSubtree = onSubtree || (() => {});
    this.followSymlinks = followSymlinks;
    this.sameDeviceOnly = sameDeviceOnly;
    this.skipSystemPaths = skipSystemPaths;
    this.dedupHardlinks = dedupHardlinks;
    this.fastRescan = fastRescan && !!previousTree;
    this.cancelled = false;

    this.stats = {
      files: 0,
      dirs: 0,
      totalSize: 0,
      totalAllocated: 0, // on-disk (block-allocated) bytes
      errors: 0,
      reused: 0, // directories reused from a previous scan
      byCategory: {},
      largest: [],
    };

    this._lastEmit = 0;
    this._largestCap = 200;
    this._heap = new BoundedMaxByMinHeap(this._largestCap);
    this._sem = new Semaphore(Math.max(4, concurrency));
    this._seenInodes = dedupHardlinks ? new Set() : null;
    this._rootDev = null;

    // Whether we must stat directories (to read dev for boundary checks, or
    // mtime for incremental reuse / recording). When false we skip the dir
    // stat entirely — saving one syscall per directory.
    this._needDirStat = this.sameDeviceOnly || this.fastRescan || recordDirMtimes;

    // Build a path -> node index of the previous tree for incremental reuse.
    this._prevIndex = null;
    if (this.fastRescan) {
      this._prevIndex = new Map();
      buildPathIndex(previousTree, this._prevIndex);
    }
  }

  cancel() {
    this.cancelled = true;
  }

  _emit(force = false) {
    const now = Date.now();
    if (!force && now - this._lastEmit < 120) return;
    this._lastEmit = now;
    this.onProgress({
      files: this.stats.files,
      dirs: this.stats.dirs,
      totalSize: this.stats.totalSize,
      errors: this.stats.errors,
      reused: this.stats.reused,
    });
  }

  _trackLargest(filePath, size) {
    this._heap.add({ path: filePath, size });
  }

  async run() {
    const rootStat = await this._safeStat(this.rootPath);
    if (!rootStat) {
      throw new Error(`Cannot access ${this.rootPath}`);
    }
    this._rootDev = rootStat.dev;
    const node = await this._walk(this.rootPath, rootStat, 0);
    // Materialise the top-K largest files from the heap, sorted desc.
    this.stats.largest = this._heap.toSortedDesc();
    this._emit(true);
    return {
      root: node,
      stats: this.stats,
      cancelled: this.cancelled,
    };
  }

  async _safeStat(p) {
    try {
      return await this._sem.run(() => fsp.lstat(p));
    } catch (e) {
      this.stats.errors++;
      return null;
    }
  }

  async _walk(dirPath, dirStat, depth) {
    if (this.cancelled) return null;

    const node = {
      name: path.basename(dirPath) || dirPath,
      path: dirPath,
      type: 'dir',
      size: 0,
      ext: '',
      category: 'folder',
      mtimeMs: dirStat.mtimeMs,
      childCount: 0,
      children: [],
    };

    this.stats.dirs++;

    let entries;
    try {
      entries = await this._sem.run(() => fsp.readdir(dirPath, { withFileTypes: true }));
    } catch (e) {
      this.stats.errors++;
      node.error = true;
      return node;
    }

    // Partition entries so files and subdirectories can be processed as two
    // concurrent batches rather than one blocking loop.
    const fileEntries = [];
    const dirEntries = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink() && !this.followSymlinks) continue;
      if (entry.isDirectory()) dirEntries.push(entry);
      else if (entry.isFile()) fileEntries.push(entry);
      // sockets, fifos, devices and unresolved symlinks are ignored
    }

    // Stat all files in this directory concurrently (bounded by the semaphore).
    // The file stat also gives us dev/ino (hardlink dedup), atime, and the
    // block-allocated size — all for free, no extra syscalls.
    const fileResults = await Promise.all(
      fileEntries.map(async (entry) => {
        if (this.cancelled) return null;
        const childPath = path.join(dirPath, entry.name);
        const fstat = await this._safeStat(childPath);
        if (!fstat) return null;
        const ext = extensionOf(entry.name);
        return {
          node: {
            name: entry.name,
            path: childPath,
            type: 'file',
            size: fstat.size,
            ext,
            category: categorize(ext),
            mtimeMs: fstat.mtimeMs,
            atimeMs: fstat.atimeMs,
            allocSize: fstat.blocks != null ? fstat.blocks * 512 : fstat.size,
          },
          dev: fstat.dev,
          ino: fstat.ino,
          nlink: fstat.nlink,
        };
      })
    );

    for (const r of fileResults) {
      if (!r) continue;
      const file = r.node;
      // The node is always added to the tree so the folder shows all its files.
      node.children.push(file);
      node.size += file.size;
      node.childCount += 1;

      // For global totals, count a hardlinked inode's bytes only once.
      let alreadySeen = false;
      if (this._seenInodes && r.nlink > 1 && r.ino) {
        const key = `${r.dev}:${r.ino}`;
        if (this._seenInodes.has(key)) alreadySeen = true;
        else this._seenInodes.add(key);
      }

      this.stats.files++;
      if (!alreadySeen) {
        this.stats.totalSize += file.size;
        this.stats.totalAllocated += file.allocSize;
        const c = (this.stats.byCategory[file.category] =
          this.stats.byCategory[file.category] || { count: 0, size: 0 });
        c.count++;
        c.size += file.size;
        this._trackLargest(file.path, file.size);
      }
    }
    this._emit();

    // Recurse into subdirectories concurrently. Each child walk gates its own
    // fs operations through the shared semaphore, so total in-flight I/O stays
    // capped no matter how wide or deep the tree is.
    const atDepth0 = depth === 0;
    const childDirs = await Promise.all(
      dirEntries.map(async (entry) => {
        if (this.cancelled) return null;
        const childPath = path.join(dirPath, entry.name);
        const nameLower = entry.name.toLowerCase();

        // Boundary guarding: recycle bins, restore points, pseudo filesystems.
        if (this.skipSystemPaths && (SKIP_DIR_NAMES.has(nameLower) || PSEUDO_PATHS.has(childPath))) {
          return null;
        }

        // We only stat the directory when we actually need dev (same-device
        // guard) or mtime (incremental reuse). Otherwise the readdir Dirent
        // already told us it's a directory — saving one syscall per folder.
        let dstat = null;
        if (this._needDirStat) {
          dstat = await this._safeStat(childPath);
          if (!dstat || !dstat.isDirectory()) return null;
          if (this.sameDeviceOnly && this._rootDev != null && dstat.dev !== this._rootDev) {
            return null; // different mount / device
          }
        }

        // Incremental reuse: if the folder's mtime matches the previous scan,
        // reuse the cached subtree instead of re-reading it from disk.
        if (this.fastRescan && dstat) {
          const prev = this._prevIndex.get(childPath);
          if (prev && prev.type === 'dir' && prev.mtimeMs === dstat.mtimeMs) {
            this.stats.reused++;
            this._absorbReusedSubtree(prev); // fold its stats in (in-memory only)
            const child = clonePrevSubtree(prev);
            if (atDepth0 && child) this.onSubtree(child);
            return child;
          }
        }

        const child = await this._walk(childPath, dstat || { mtimeMs: 0 }, depth + 1);
        if (atDepth0 && child) this.onSubtree(child);
        return child;
      })
    );

    for (const child of childDirs) {
      if (!child) continue;
      node.children.push(child);
      node.size += child.size;
      node.childCount += 1;
    }

    // Sort children largest-first so the graph and lists are meaningful.
    node.children.sort((a, b) => b.size - a.size);
    this._emit();
    return node;
  }

  // Fold a reused subtree's stats into the running totals (in-memory only —
  // no disk I/O). Note: hardlink dedup is best-effort across reused subtrees.
  _absorbReusedSubtree(prevNode) {
    walkPrev(prevNode, (n) => {
      if (n.type === 'file') {
        this.stats.files++;
        this.stats.totalSize += n.size;
        this.stats.totalAllocated += n.allocSize != null ? n.allocSize : n.size;
        const c = (this.stats.byCategory[n.category] =
          this.stats.byCategory[n.category] || { count: 0, size: 0 });
        c.count++;
        c.size += n.size;
        this._trackLargest(n.path, n.size);
      } else if (n.type === 'dir') {
        this.stats.dirs++;
      }
    });
  }
}

// ---- incremental-scan helpers ---------------------------------------------

function buildPathIndex(node, map) {
  if (!node) return;
  map.set(node.path, node);
  if (node.children) for (const c of node.children) buildPathIndex(c, map);
}

function walkPrev(node, cb) {
  cb(node);
  if (node.children) for (const c of node.children) walkPrev(c, cb);
}

/** Deep structural clone of a previous subtree, so the new tree owns its nodes. */
function clonePrevSubtree(node) {
  const copy = { ...node };
  if (node.children) copy.children = node.children.map(clonePrevSubtree);
  return copy;
}

/**
 * Merge a batch of stats objects (from worker threads or subtree scans) into
 * one. Totals add, byCategory merges, and the largest lists are combined and
 * re-capped. Used by the worker-parallel scanner.
 */
function mergeStats(target, src, largestCap = 200) {
  target.files += src.files;
  target.dirs += src.dirs;
  target.totalSize += src.totalSize;
  target.totalAllocated += src.totalAllocated || 0;
  target.errors += src.errors;
  target.reused = (target.reused || 0) + (src.reused || 0);
  for (const [cat, v] of Object.entries(src.byCategory || {})) {
    const c = (target.byCategory[cat] = target.byCategory[cat] || { count: 0, size: 0 });
    c.count += v.count;
    c.size += v.size;
  }
  const heap = new BoundedMaxByMinHeap(largestCap);
  for (const it of target.largest || []) heap.add(it);
  for (const it of src.largest || []) heap.add(it);
  target.largest = heap.toSortedDesc();
  return target;
}

/**
 * Find likely-duplicate files inside an already-scanned tree.
 * Strategy: group by size (fast), then confirm with a partial hash of the
 * first + last 64KB for candidate groups. Full-file hashing is avoided to
 * keep it responsive on large drives.
 */
async function findDuplicates(tree, { maxGroups = 100 } = {}) {
  const bySize = new Map();
  (function collect(node) {
    if (node.type === 'file') {
      if (node.size > 0) {
        if (!bySize.has(node.size)) bySize.set(node.size, []);
        bySize.get(node.size).push(node);
      }
    } else if (node.children) {
      for (const c of node.children) collect(c);
    }
  })(tree);

  const candidateGroups = [...bySize.values()].filter((g) => g.length > 1);
  const results = [];

  for (const group of candidateGroups) {
    const byHash = new Map();
    for (const file of group) {
      let h;
      try {
        h = await partialHash(file.path, file.size);
      } catch (e) {
        continue;
      }
      if (!byHash.has(h)) byHash.set(h, []);
      byHash.get(h).push(file);
    }
    for (const [, files] of byHash) {
      if (files.length > 1) {
        results.push({
          size: files[0].size,
          count: files.length,
          wasted: files[0].size * (files.length - 1),
          files: files.map((f) => ({ path: f.path, name: f.name })),
        });
      }
    }
  }

  results.sort((a, b) => b.wasted - a.wasted);
  return results.slice(0, maxGroups);
}

/**
 * Junk / cache detection over an already-scanned in-memory tree (no disk I/O).
 * Flags well-known reclaimable directories (whole-folder) and throwaway files.
 * These are *candidates* — the UI always requires the user to review and
 * confirm before anything is trashed.
 */
const JUNK_DIRS = {
  node_modules: 'Dependency caches',
  '.cache': 'Caches',
  cache: 'Caches',
  caches: 'Caches',
  '.npm': 'Package-manager caches',
  '.yarn-cache': 'Package-manager caches',
  '.gradle': 'Build caches',
  __pycache__: 'Build caches',
  '.pytest_cache': 'Build caches',
  '.mypy_cache': 'Build caches',
  build: 'Build artifacts',
  dist: 'Build artifacts',
  target: 'Build artifacts',
  '.next': 'Build artifacts',
  '.nuxt': 'Build artifacts',
  '.parcel-cache': 'Build artifacts',
  deriveddata: 'Build artifacts',
  tmp: 'Temporary files',
  temp: 'Temporary files',
  '.tmp': 'Temporary files',
  'crashdumps': 'Crash dumps',
};

const JUNK_EXTS = {
  tmp: 'Temporary files',
  temp: 'Temporary files',
  log: 'Log files',
  bak: 'Backup files',
  old: 'Backup files',
  cache: 'Caches',
  dmp: 'Crash dumps',
  crdownload: 'Incomplete downloads',
  part: 'Incomplete downloads',
  download: 'Incomplete downloads',
};

const JUNK_FILES = {
  '.ds_store': 'System clutter',
  'thumbs.db': 'System clutter',
  'desktop.ini': 'System clutter',
};

function findJunk(tree) {
  const groups = new Map(); // label -> { label, items: [], totalSize, count }
  const add = (label, item) => {
    if (!groups.has(label)) groups.set(label, { label, items: [], totalSize: 0, count: 0 });
    const g = groups.get(label);
    g.items.push(item);
    g.totalSize += item.size;
    g.count += 1;
  };

  (function walk(node) {
    if (node.type === 'dir') {
      const dirLabel = JUNK_DIRS[(node.name || '').toLowerCase()];
      if (dirLabel && node.path !== tree.path) {
        // Flag the whole directory as one reclaimable item; don't descend.
        add(dirLabel, { path: node.path, name: node.name, size: node.size, kind: 'folder' });
        return;
      }
      if (node.children) node.children.forEach(walk);
    } else if (node.type === 'file') {
      const lower = (node.name || '').toLowerCase();
      const fileLabel = JUNK_FILES[lower];
      const extLabel = JUNK_EXTS[node.ext];
      const label = fileLabel || extLabel;
      if (label) add(label, { path: node.path, name: node.name, size: node.size, kind: 'file' });
    }
  })(tree);

  const list = [...groups.values()].sort((a, b) => b.totalSize - a.totalSize);
  // Cap items per group so the payload stays bounded on huge trees.
  for (const g of list) {
    g.items.sort((a, b) => b.size - a.size);
    g.truncated = g.items.length > 500;
    g.items = g.items.slice(0, 500);
  }
  const totalSize = list.reduce((s, g) => s + g.totalSize, 0);
  const totalCount = list.reduce((s, g) => s + g.count, 0);
  return { groups: list, totalSize, totalCount };
}

function partialHash(filePath, size) {
  return new Promise((resolve, reject) => {
    const CHUNK = 64 * 1024;
    const hash = crypto.createHash('sha1');
    hash.update(String(size));
    if (size <= CHUNK * 2) {
      const stream = fs.createReadStream(filePath);
      stream.on('data', (d) => hash.update(d));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
      return;
    }
    // Read head + tail
    const fd = fs.openSync(filePath, 'r');
    try {
      const head = Buffer.alloc(CHUNK);
      const tail = Buffer.alloc(CHUNK);
      fs.readSync(fd, head, 0, CHUNK, 0);
      fs.readSync(fd, tail, 0, CHUNK, size - CHUNK);
      hash.update(head);
      hash.update(tail);
      resolve(hash.digest('hex'));
    } catch (e) {
      reject(e);
    } finally {
      fs.closeSync(fd);
    }
  });
}

module.exports = {
  ScanSession,
  findDuplicates,
  findJunk,
  categorize,
  CATEGORY_MAP,
  mergeStats,
  buildPathIndex,
  clonePrevSubtree,
  extensionOf,
  SKIP_DIR_NAMES,
  PSEUDO_PATHS,
};
