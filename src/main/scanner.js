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
 * A scan session. Handles a single recursive walk of a root path, streaming
 * progress and remaining cancellable. Produces an aggregated tree.
 *
 * The walk runs many directory reads and file stats concurrently (bounded by
 * `concurrency`) instead of sequentially, which is a large speed-up on real
 * drives where the bottleneck is I/O latency, not CPU.
 */
class ScanSession {
  constructor(rootPath, { onProgress, followSymlinks = false, concurrency = 48 } = {}) {
    this.rootPath = rootPath;
    this.onProgress = onProgress || (() => {});
    this.followSymlinks = followSymlinks;
    this.cancelled = false;
    this.stats = {
      files: 0,
      dirs: 0,
      totalSize: 0,
      errors: 0,
      byCategory: {},
      largest: [], // {path, size} kept sorted desc, capped
    };
    this._lastEmit = 0;
    this._largestCap = 200;
    this._sem = new Semaphore(Math.max(4, concurrency));
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
    });
  }

  _trackLargest(filePath, size) {
    const arr = this.stats.largest;
    if (arr.length < this._largestCap) {
      arr.push({ path: filePath, size });
      arr.sort((a, b) => b.size - a.size);
    } else if (size > arr[arr.length - 1].size) {
      arr[arr.length - 1] = { path: filePath, size };
      arr.sort((a, b) => b.size - a.size);
    }
  }

  async run() {
    const rootStat = await this._safeStat(this.rootPath);
    if (!rootStat) {
      throw new Error(`Cannot access ${this.rootPath}`);
    }
    const node = await this._walk(this.rootPath, rootStat, 0);
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
    const fileResults = await Promise.all(
      fileEntries.map(async (entry) => {
        if (this.cancelled) return null;
        const childPath = path.join(dirPath, entry.name);
        const fstat = await this._safeStat(childPath);
        if (!fstat) return null;
        const ext = extensionOf(entry.name);
        return {
          name: entry.name,
          path: childPath,
          type: 'file',
          size: fstat.size,
          ext,
          category: categorize(ext),
          mtimeMs: fstat.mtimeMs,
        };
      })
    );

    for (const file of fileResults) {
      if (!file) continue;
      this.stats.files++;
      this.stats.totalSize += file.size;
      const c = (this.stats.byCategory[file.category] = this.stats.byCategory[file.category] || { count: 0, size: 0 });
      c.count++;
      c.size += file.size;
      this._trackLargest(file.path, file.size);
      node.size += file.size;
      node.childCount += 1;
      node.children.push(file);
    }
    this._emit();

    // Recurse into subdirectories concurrently. Each child walk gates its own
    // fs operations through the shared semaphore, so total in-flight I/O stays
    // capped no matter how wide or deep the tree is.
    const childDirs = await Promise.all(
      dirEntries.map(async (entry) => {
        if (this.cancelled) return null;
        const childPath = path.join(dirPath, entry.name);
        const dstat = await this._safeStat(childPath);
        if (!dstat || !dstat.isDirectory()) return null;
        return this._walk(childPath, dstat, depth + 1);
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
};
