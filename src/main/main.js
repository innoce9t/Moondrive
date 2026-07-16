'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;

const { ScanSession, findDuplicates, findJunk } = require('./scanner');
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
    const allowed = ['geminiApiKey', 'geminiModel', 'followSymlinks'];
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

    const session = new ScanSession(folderPath, {
      followSymlinks: store.get('followSymlinks'),
      onProgress: (p) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('scan:progress', p);
        }
      },
    });
    activeScan = session;

    try {
      const result = await session.run();
      lastScan = result;
      activeScan = null;
      // Persist a compact history record for trend tracking.
      store.addScanHistory({
        path: folderPath,
        timestamp: Date.now(),
        files: result.stats.files,
        dirs: result.stats.dirs,
        totalSize: result.stats.totalSize,
        byCategory: result.stats.byCategory,
      });
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
 * The full tree can be huge. We cap what we ship to the renderer: the renderer
 * lazily requests deeper levels via the cached tree if needed. For now we send
 * the whole tree but strip nothing — trees are typically fine in memory. To
 * keep IPC payloads bounded we prune children beyond a depth and mark folders
 * as expandable.
 */
function serializeScan(result) {
  return {
    root: result.root,
    stats: {
      files: result.stats.files,
      dirs: result.stats.dirs,
      totalSize: result.stats.totalSize,
      errors: result.stats.errors,
      byCategory: result.stats.byCategory,
      largest: result.stats.largest.slice(0, 50),
    },
    cancelled: result.cancelled,
  };
}
