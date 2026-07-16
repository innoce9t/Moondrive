'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;

const { ScanSession, findDuplicates, findJunk } = require('./scanner');
const { ParallelScanSession } = require('./parallel-scan');
const gemini = require('./gemini');
const { Store } = require('./store');
const systemTools = require('./system-tools');

const isDev = process.argv.includes('--dev');

let mainWindow = null;
let store = null;

/** Currently running scan session, so we can cancel it. */
let activeScan = null;
/** Last completed scan result — kept in main so AI/duplicate calls can reuse it. */
let lastScan = null;
/** Last applied auto-organise batch, for one-click undo. */
let lastOrganizeBatch = null;
/** Cache of installed apps by id, so uninstall runs by id (never a renderer-supplied command). */
const installedAppsById = new Map();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#070b18',
    title: 'Moondrive',
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs require(); renderer stays isolated
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  store = new Store(path.join(app.getPath('userData'), 'moondrive-settings.json'));
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  // --- Settings / sandbox -------------------------------------------------
  ipcMain.handle('settings:getAll', () => store.getAll());

  ipcMain.handle('settings:set', (_e, { key, value }) => {
    const allowed = [
      'geminiApiKey',
      'geminiModel',
      'followSymlinks',
      'scanConcurrency',
      'sameDeviceOnly',
      'skipSystemPaths',
      'dedupHardlinks',
      'fastRescan',
      'useWorkers',
      'watchDrive',
    ];
    if (!allowed.includes(key)) throw new Error(`Setting "${key}" is not writable.`);
    store.set(key, value);
    return store.getAll();
  });

  ipcMain.handle('sandbox:pickFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Grant Moondrive access to a folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    const folder = result.filePaths[0];
    const folders = store.addAllowedFolder(folder);
    return { canceled: false, folder, allowedFolders: folders };
  });

  ipcMain.handle('sandbox:addRoot', async () => {
    // Grant the system root / drive roots. Requires an explicit confirm dialog.
    const roots = getSystemRoots();
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Grant root access'],
      defaultId: 0,
      cancelId: 0,
      title: 'Grant root access',
      message: 'Grant Moondrive access to your entire drive?',
      detail:
        `This lets Moondrive scan and (with confirmation) delete anything under:\n\n${roots.join('\n')}\n\n` +
        'System files may be included. Deletions always move items to the Trash and require confirmation, but proceed with care.',
    });
    if (choice.response !== 1) return { canceled: true };
    let folders = store.getAll().allowedFolders;
    for (const r of roots) folders = store.addAllowedFolder(r);
    return { canceled: false, allowedFolders: folders, roots };
  });

  ipcMain.handle('sandbox:removeFolder', (_e, folder) => {
    return store.removeAllowedFolder(folder);
  });

  ipcMain.handle('sandbox:list', () => store.getAll().allowedFolders);

  ipcMain.handle('sandbox:suggestFolders', () => suggestFolders());

  // Grant one of the *suggested* folders without a dialog. We re-validate the
  // path against the suggestion list so the renderer can't grant arbitrary
  // paths through this channel.
  ipcMain.handle('sandbox:grantSuggested', (_e, folder) => {
    const allowed = suggestFolders();
    if (!allowed.includes(path.resolve(folder))) {
      throw new Error('That folder is not in the suggested list.');
    }
    const folders = store.addAllowedFolder(folder);
    return { ok: true, folder: path.resolve(folder), allowedFolders: folders };
  });

  // --- Scanning -----------------------------------------------------------
  ipcMain.handle('scan:start', async (_e, folderPath) => {
    if (!store.isPathAllowed(folderPath)) {
      throw new Error('That folder is outside the sandbox. Grant access to it first.');
    }
    if (activeScan) activeScan.cancel();
    stopDriveWatch();

    const s = store.getAll();
    const fastRescan = !!s.fastRescan;
    // Incremental reuse only when rescanning the same root we last scanned.
    const previousTree =
      fastRescan && lastScan && lastScan.root && path.resolve(lastScan.root.path) === path.resolve(folderPath)
        ? lastScan.root
        : null;

    const options = {
      followSymlinks: !!s.followSymlinks,
      concurrency: Number(s.scanConcurrency) || 48,
      sameDeviceOnly: !!s.sameDeviceOnly,
      skipSystemPaths: s.skipSystemPaths !== false,
      dedupHardlinks: s.dedupHardlinks !== false,
      fastRescan,
      previousTree,
      recordDirMtimes: fastRescan, // so this scan's tree carries dir mtimes for next time
      onProgress: (p) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('scan:progress', p);
      },
      // Progressive rendering: stream each completed top-level subtree (shallow).
      onSubtree: (subtree) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('scan:partial', { rootPath: folderPath, child: shallowNode(subtree) });
        }
      },
    };

    const session = s.useWorkers
      ? new ParallelScanSession(folderPath, { ...options, workers: 0 })
      : new ScanSession(folderPath, options);
    activeScan = session;

    try {
      const result = await session.run();
      lastScan = result;
      activeScan = null;
      store.addScanHistory({
        path: folderPath,
        timestamp: Date.now(),
        files: result.stats.files,
        dirs: result.stats.dirs,
        totalSize: result.stats.totalSize,
        byCategory: result.stats.byCategory,
      });
      if (!result.cancelled) startDriveWatch(folderPath);
      return { ok: true, ...serializeScan(result) };
    } catch (err) {
      activeScan = null;
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('scan:cancel', () => {
    if (activeScan) activeScan.cancel();
    return true;
  });

  // Lazy tree: the renderer holds only shallow nodes and fetches a folder's
  // direct children on demand as the user drills in.
  ipcMain.handle('scan:getChildren', (_e, folderPath) => {
    if (!lastScan) return { ok: false, error: 'No scan loaded.' };
    const node = findNodeByPath(lastScan.root, folderPath);
    if (!node) return { ok: false, error: 'Folder not found in the current scan.' };
    return { ok: true, path: node.path, children: (node.children || []).map(shallowNode) };
  });

  ipcMain.handle('scan:duplicates', async () => {
    if (!lastScan) throw new Error('Run a scan first.');
    return findDuplicates(lastScan.root);
  });

  ipcMain.handle('scan:junk', async () => {
    if (!lastScan) throw new Error('Run a scan first.');
    return findJunk(lastScan.root);
  });

  // --- AI auto-organise ---------------------------------------------------
  ipcMain.handle('organize:propose', async (_e, folderPath) => {
    if (!lastScan) throw new Error('Run a scan first.');
    const apiKey = store.get('geminiApiKey');
    if (!apiKey) return { ok: false, error: 'Add your Gemini API key in Settings first.' };

    const folder = findNodeByPath(lastScan.root, folderPath) || lastScan.root;
    const files = (folder.children || []).filter((c) => c.type === 'file');
    if (!files.length) return { ok: false, error: 'This folder has no loose files to organise.' };

    let plan;
    try {
      plan = await gemini.proposeOrganization({
        apiKey,
        model: store.get('geminiModel') || gemini.DEFAULT_MODEL,
        folderName: folder.name || folderPath,
        files: files.map((f) => ({ name: f.name, category: f.category, size: f.size })),
      });
    } catch (err) {
      return { ok: false, error: err.message };
    }

    // Validate every proposed move against the real file listing + sandbox.
    const byName = new Map(files.map((f) => [f.name, f]));
    const seen = new Set();
    const moves = [];
    for (const m of plan.moves) {
      const file = byName.get(m.file);
      if (!file || seen.has(m.file)) continue;
      const subfolder = sanitizeFolderName(m.folder);
      if (!subfolder) continue;
      const to = path.join(folderPath, subfolder, file.name);
      if (path.resolve(to) === path.resolve(file.path)) continue; // no-op
      if (!store.isPathAllowed(to)) continue;
      seen.add(m.file);
      moves.push({ from: file.path, to, name: file.name, folder: subfolder, size: file.size, reason: String(m.reason || '').slice(0, 140) });
    }
    return { ok: true, folderPath, moves, totalFiles: files.length };
  });

  ipcMain.handle('organize:apply', async (_e, moves) => {
    const results = [];
    const done = [];
    for (const mv of moves) {
      if (!store.isPathAllowed(mv.from) || !store.isPathAllowed(mv.to)) {
        results.push({ from: mv.from, ok: false, error: 'outside sandbox' });
        continue;
      }
      try {
        await fsp.mkdir(path.dirname(mv.to), { recursive: true });
        await fsp.rename(mv.from, mv.to);
        if (lastScan) removeFromMainTree(lastScan.root, mv.from);
        results.push({ from: mv.from, to: mv.to, ok: true });
        done.push({ from: mv.from, to: mv.to });
      } catch (e) {
        results.push({ from: mv.from, ok: false, error: e.message });
      }
    }
    // Record for undo (reverse direction).
    lastOrganizeBatch = done.length ? { moves: done } : null;
    return { ok: true, results, canUndo: !!lastOrganizeBatch };
  });

  ipcMain.handle('organize:undo', async () => {
    if (!lastOrganizeBatch) return { ok: false, error: 'Nothing to undo.' };
    const results = [];
    const createdDirs = new Set();
    for (const mv of lastOrganizeBatch.moves) {
      if (!store.isPathAllowed(mv.from) || !store.isPathAllowed(mv.to)) {
        results.push({ ok: false, error: 'outside sandbox' });
        continue;
      }
      try {
        await fsp.mkdir(path.dirname(mv.from), { recursive: true });
        await fsp.rename(mv.to, mv.from); // move back
        createdDirs.add(path.dirname(mv.to));
        results.push({ ok: true });
      } catch (e) {
        results.push({ ok: false, error: e.message });
      }
    }
    // Clean up now-empty folders the organise step created.
    for (const dir of createdDirs) {
      try {
        const remaining = await fsp.readdir(dir);
        if (!remaining.length) await fsp.rmdir(dir);
      } catch (e) {
        /* leave non-empty dirs alone */
      }
    }
    lastOrganizeBatch = null;
    return { ok: true, results };
  });

  ipcMain.handle('organize:canUndo', () => ({ canUndo: !!lastOrganizeBatch }));

  // --- File operations (all sandbox-gated) --------------------------------
  ipcMain.handle('fs:trash', async (_e, targetPath) => {
    if (!store.isPathAllowed(targetPath)) {
      throw new Error('Refused: path is outside the sandbox.');
    }
    await shell.trashItem(targetPath);
    if (lastScan) removeFromMainTree(lastScan.root, targetPath);
    return { ok: true };
  });

  ipcMain.handle('fs:trashMany', async (_e, paths) => {
    const results = [];
    for (const p of paths) {
      if (!store.isPathAllowed(p)) {
        results.push({ path: p, ok: false, error: 'outside sandbox' });
        continue;
      }
      try {
        await shell.trashItem(p);
        if (lastScan) removeFromMainTree(lastScan.root, p);
        results.push({ path: p, ok: true });
      } catch (e) {
        results.push({ path: p, ok: false, error: e.message });
      }
    }
    return results;
  });

  ipcMain.handle('fs:reveal', (_e, targetPath) => {
    shell.showItemInFolder(targetPath);
    return true;
  });

  ipcMain.handle('fs:open', async (_e, targetPath) => {
    const err = await shell.openPath(targetPath);
    return { ok: !err, error: err || null };
  });

  ipcMain.handle('fs:createFolder', async (_e, { parent, name }) => {
    const target = path.join(parent, name);
    if (!store.isPathAllowed(target)) throw new Error('Refused: outside the sandbox.');
    await fsp.mkdir(target, { recursive: true });
    return { ok: true, path: target };
  });

  ipcMain.handle('fs:move', async (_e, { from, to }) => {
    if (!store.isPathAllowed(from) || !store.isPathAllowed(to)) {
      throw new Error('Refused: source or destination is outside the sandbox.');
    }
    await fsp.rename(from, to);
    if (lastScan) {
      // Same parent = rename (keep node, rewrite paths); different parent = it
      // left the current subtree, so drop it (reappears on next scan).
      if (path.dirname(from) === path.dirname(to)) renameInMainTree(lastScan.root, from, to);
      else removeFromMainTree(lastScan.root, from);
    }
    return { ok: true };
  });

  // --- AI -----------------------------------------------------------------
  ipcMain.handle('ai:ask', async (_e, { messages }) => {
    const apiKey = store.get('geminiApiKey');
    const model = store.get('geminiModel') || gemini.DEFAULT_MODEL;
    const summary = gemini.buildScanSummary(lastScan);

    // Prepend the scan summary as context to the first user turn.
    const withContext = messages.slice();
    if (withContext.length) {
      withContext[withContext.length - 1] = {
        ...withContext[withContext.length - 1],
        content: `Current scan summary:\n${summary}\n\n---\nUser: ${withContext[withContext.length - 1].content}`,
      };
    }

    try {
      const text = await gemini.generate({
        apiKey,
        model,
        systemPrompt: gemini.SYSTEM_PROMPT,
        messages: withContext,
      });
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // --- System info --------------------------------------------------------
  ipcMain.handle('system:info', () => ({
    platform: process.platform,
    home: os.homedir(),
    hostname: os.hostname(),
  }));

  // --- Package updates (winget) ------------------------------------------
  ipcMain.handle('winget:available', () => systemTools.wingetAvailable());
  ipcMain.handle('winget:list', () => systemTools.wingetListUpgrades());
  ipcMain.handle('winget:upgrade', (_e, ids) =>
    systemTools.wingetUpgrade(ids, (id, line) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('winget:progress', { id, line });
      }
    })
  );

  // --- Startup apps -------------------------------------------------------
  ipcMain.handle('startup:list', () => systemTools.listStartupApps());
  ipcMain.handle('startup:set', (_e, { entry, enable }) => systemTools.setStartupApp(entry, enable));

  // --- Installed apps (uninstall) ----------------------------------------
  ipcMain.handle('apps:list', async () => {
    const res = await systemTools.listInstalledApps();
    // Cache the full entries (incl. uninstall strings) so uninstall works by id
    // and the renderer never handles or supplies a raw command line.
    installedAppsById.clear();
    if (res.items) {
      for (const a of res.items) installedAppsById.set(a.id, a);
    }
    // Strip internal command fields before sending to the renderer.
    const items = (res.items || []).map(({ _uninstall, _quiet, ...pub }) => pub);
    return { ...res, items };
  });

  ipcMain.handle('apps:uninstall', async (_e, id) => {
    const app = installedAppsById.get(id);
    if (!app) return { ok: false, error: 'Unknown app — refresh the list and try again.' };
    return systemTools.uninstallApp(app, (line) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('apps:progress', { id, line });
      }
    });
  });

  // --- Scan history -------------------------------------------------------
  ipcMain.handle('history:list', () => store.getScanHistory());
  ipcMain.handle('history:clear', () => store.clearScanHistory());

  // --- Move destination picker -------------------------------------------
  ipcMain.handle('fs:pickDestination', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a destination folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    return { canceled: false, dir: result.filePaths[0] };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findNodeByPath(root, target) {
  if (!root) return null;
  if (path.resolve(root.path) === path.resolve(target)) return root;
  if (root.children) {
    for (const c of root.children) {
      if (c.type === 'dir') {
        const found = findNodeByPath(c, target);
        if (found) return found;
      }
    }
  }
  return null;
}

/** Remove a node from the cached tree and subtract its size up the ancestry. */
function removeFromMainTree(root, targetPath) {
  const target = path.resolve(targetPath);
  let removedSize = 0;
  (function recurse(node) {
    if (!node.children) return false;
    const idx = node.children.findIndex((c) => path.resolve(c.path) === target);
    if (idx !== -1) {
      removedSize = node.children[idx].size;
      node.children.splice(idx, 1);
      node.size -= removedSize;
      node.childCount = Math.max(0, (node.childCount || 1) - 1);
      return true;
    }
    for (const c of node.children) {
      if (c.type === 'dir' && recurse(c)) {
        c.size -= removedSize; // propagate the reduction up
        return true;
      }
    }
    return false;
  })(root);
}

/** Rename a node in the cached tree and rewrite its subtree's paths. */
function renameInMainTree(root, fromPath, toPath) {
  const node = findNodeByPath(root, fromPath);
  if (!node) return;
  node.name = path.basename(toPath);
  const from = fromPath;
  (function rewrite(n) {
    if (n.path && n.path.startsWith(from)) n.path = toPath + n.path.slice(from.length);
    if (n.children) n.children.forEach(rewrite);
  })(node);
}

/** Strip anything path-like or unsafe from an AI-proposed folder name. */
function sanitizeFolderName(name) {
  if (!name || typeof name !== 'string') return '';
  const clean = name
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\.\.+/g, '')
    .trim()
    .slice(0, 60);
  if (!clean || clean === '.' || clean === '..') return '';
  return clean;
}

function getSystemRoots() {
  if (process.platform === 'win32') {
    const roots = [];
    for (let c = 65; c <= 90; c++) {
      const drive = `${String.fromCharCode(c)}:\\`;
      try {
        fs.accessSync(drive);
        roots.push(drive);
      } catch (e) {
        /* not present */
      }
    }
    return roots.length ? roots : ['C:\\'];
  }
  return ['/'];
}

function suggestFolders() {
  const home = os.homedir();
  const candidates = [
    home,
    path.join(home, 'Downloads'),
    path.join(home, 'Documents'),
    path.join(home, 'Desktop'),
    path.join(home, 'Pictures'),
    path.join(home, 'Movies'),
    path.join(home, 'Videos'),
    path.join(home, 'Music'),
  ];
  return candidates
    .map((p) => path.resolve(p))
    .filter((p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch (e) {
        return false;
      }
    });
}

/**
 * A "shallow" node: everything the renderer needs to draw one node, minus the
 * children array. `hasChildren` tells the UI a folder can be drilled into; the
 * children themselves are fetched lazily via scan:getChildren. This keeps the
 * initial IPC payload tiny even for multi-million-file drives.
 */
function shallowNode(node) {
  return {
    name: node.name,
    path: node.path,
    type: node.type,
    size: node.size,
    ext: node.ext || '',
    category: node.category,
    mtimeMs: node.mtimeMs,
    atimeMs: node.atimeMs,
    allocSize: node.allocSize,
    childCount: node.childCount || (node.children ? node.children.length : 0),
    hasChildren: node.type === 'dir' && !!(node.children && node.children.length),
  };
}

/**
 * The full tree stays in main; the renderer receives only the root plus its
 * direct children (shallow). Deeper levels are pulled on demand as the user
 * navigates, so the IPC payload and renderer memory stay bounded.
 */
function serializeScan(result) {
  const root = result.root;
  return {
    root: shallowNode(root),
    children: (root.children || []).map(shallowNode),
    stats: {
      files: result.stats.files,
      dirs: result.stats.dirs,
      totalSize: result.stats.totalSize,
      totalAllocated: result.stats.totalAllocated,
      errors: result.stats.errors,
      reused: result.stats.reused,
      byCategory: result.stats.byCategory,
      largest: result.stats.largest.slice(0, 50),
    },
    cancelled: result.cancelled,
  };
}

// ---- drive watcher (opt-in) ----------------------------------------------
let driveWatcher = null;
let driveWatchTimer = null;

function stopDriveWatch() {
  if (driveWatcher) {
    try {
      driveWatcher.close();
    } catch (e) {
      /* ignore */
    }
    driveWatcher = null;
  }
  clearTimeout(driveWatchTimer);
}

function startDriveWatch(rootPath) {
  stopDriveWatch();
  if (!store.get('watchDrive')) return;
  const notify = () => {
    clearTimeout(driveWatchTimer);
    driveWatchTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scan:driveChanged', { path: rootPath });
      }
    }, 1500);
  };
  try {
    // recursive is supported on macOS/Windows; on Linux it throws and we fall
    // back to watching the root non-recursively (top-level changes only).
    driveWatcher = fs.watch(rootPath, { recursive: true }, notify);
  } catch (e) {
    try {
      driveWatcher = fs.watch(rootPath, notify);
    } catch (e2) {
      driveWatcher = null;
    }
  }
}
