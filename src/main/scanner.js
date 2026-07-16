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
 * A scan session. Handles a single recursive walk of a root path, streaming
 * progress and remaining cancellable. Produces an aggregated tree.
 */
class ScanSession {
  constructor(rootPath, { onProgress, followSymlinks = false } = {}) {
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
    this._visitedInodes = new Set();
    this._largestCap = 200;
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
      return await fsp.lstat(p);
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
      entries = await fsp.readdir(dirPath, { withFileTypes: true });
    } catch (e) {
      this.stats.errors++;
      node.error = true;
      return node;
    }

    for (const entry of entries) {
      if (this.cancelled) break;
      const childPath = path.join(dirPath, entry.name);

      const isSymlink = entry.isSymbolicLink();
      if (isSymlink && !this.followSymlinks) {
        continue; // avoid loops and duplicate accounting
      }

      if (entry.isDirectory()) {
        const dstat = await this._safeStat(childPath);
        if (!dstat || !dstat.isDirectory()) continue;
        const child = await this._walk(childPath, dstat, depth + 1);
        if (child) {
          node.children.push(child);
          node.size += child.size;
          node.childCount += 1;
        }
      } else if (entry.isFile()) {
        const fstat = await this._safeStat(childPath);
        if (!fstat) continue;
        const size = fstat.size;
        const ext = extensionOf(entry.name);
        const category = categorize(ext);

        this.stats.files++;
        this.stats.totalSize += size;
        this.stats.byCategory[category] = this.stats.byCategory[category] || { count: 0, size: 0 };
        this.stats.byCategory[category].count++;
        this.stats.byCategory[category].size += size;
        this._trackLargest(childPath, size);

        node.size += size;
        node.childCount += 1;
        node.children.push({
          name: entry.name,
          path: childPath,
          type: 'file',
          size,
          ext,
          category,
          mtimeMs: fstat.mtimeMs,
        });
        this._emit();
      }
      // Ignore sockets, fifos, devices, unresolved symlinks.
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
  categorize,
  CATEGORY_MAP,
};
