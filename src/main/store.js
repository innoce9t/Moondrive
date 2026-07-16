'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Tiny JSON-backed settings store. Holds the sandbox allow-list of folders the
 * user has explicitly granted, the Gemini API key, and UI preferences.
 * No external dependency — writes atomically via a temp file + rename.
 */
class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {
      allowedFolders: [], // absolute paths the user has granted
      geminiApiKey: '',
      geminiModel: 'gemini-2.0-flash',
      followSymlinks: false,
    };
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = { ...this.data, ...parsed };
    } catch (e) {
      // First run or corrupt file — keep defaults.
    }
  }

  _save() {
    const dir = path.dirname(this.filePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      /* ignore */
    }
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this._save();
  }

  getAll() {
    // Never expose the raw API key length secret-ness; renderer decides masking.
    return { ...this.data };
  }

  addAllowedFolder(folder) {
    const norm = path.resolve(folder);
    if (!this.data.allowedFolders.includes(norm)) {
      this.data.allowedFolders.push(norm);
      this._save();
    }
    return this.data.allowedFolders;
  }

  removeAllowedFolder(folder) {
    const norm = path.resolve(folder);
    this.data.allowedFolders = this.data.allowedFolders.filter((f) => f !== norm);
    this._save();
    return this.data.allowedFolders;
  }

  /**
   * Sandbox gate: a path is permitted only if it is inside (or equal to) one of
   * the explicitly allowed folders. This is the single choke point every
   * filesystem-mutating IPC handler must pass through.
   */
  isPathAllowed(target) {
    const resolved = path.resolve(target);
    return this.data.allowedFolders.some((allowed) => {
      const a = path.resolve(allowed);
      if (resolved === a) return true;
      const withSep = a.endsWith(path.sep) ? a : a + path.sep;
      return resolved.startsWith(withSep);
    });
  }
}

module.exports = { Store };
