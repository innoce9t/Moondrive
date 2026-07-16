'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only surface the renderer can touch. Everything is funnelled through
 * named IPC channels handled in main.js — the renderer has no direct fs, path,
 * or Node access. Filesystem mutations are additionally sandbox-gated in main.
 */
const api = {
  settings: {
    getAll: () => ipcRenderer.invoke('settings:getAll'),
    set: (key, value) => ipcRenderer.invoke('settings:set', { key, value }),
  },

  sandbox: {
    pickFolder: () => ipcRenderer.invoke('sandbox:pickFolder'),
    addRoot: () => ipcRenderer.invoke('sandbox:addRoot'),
    removeFolder: (folder) => ipcRenderer.invoke('sandbox:removeFolder', folder),
    list: () => ipcRenderer.invoke('sandbox:list'),
    suggestFolders: () => ipcRenderer.invoke('sandbox:suggestFolders'),
    grantSuggested: (folder) => ipcRenderer.invoke('sandbox:grantSuggested', folder),
  },

  scan: {
    start: (folderPath) => ipcRenderer.invoke('scan:start', folderPath),
    cancel: () => ipcRenderer.invoke('scan:cancel'),
    duplicates: () => ipcRenderer.invoke('scan:duplicates'),
    junk: () => ipcRenderer.invoke('scan:junk'),
    onProgress: (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on('scan:progress', listener);
      return () => ipcRenderer.removeListener('scan:progress', listener);
    },
  },

  files: {
    trash: (p) => ipcRenderer.invoke('fs:trash', p),
    trashMany: (paths) => ipcRenderer.invoke('fs:trashMany', paths),
    reveal: (p) => ipcRenderer.invoke('fs:reveal', p),
    open: (p) => ipcRenderer.invoke('fs:open', p),
    createFolder: (parent, name) => ipcRenderer.invoke('fs:createFolder', { parent, name }),
    move: (from, to) => ipcRenderer.invoke('fs:move', { from, to }),
    pickDestination: () => ipcRenderer.invoke('fs:pickDestination'),
  },

  history: {
    list: () => ipcRenderer.invoke('history:list'),
    clear: () => ipcRenderer.invoke('history:clear'),
  },

  ai: {
    ask: (messages) => ipcRenderer.invoke('ai:ask', { messages }),
  },

  organize: {
    propose: (folderPath) => ipcRenderer.invoke('organize:propose', folderPath),
    apply: (moves) => ipcRenderer.invoke('organize:apply', moves),
    undo: () => ipcRenderer.invoke('organize:undo'),
    canUndo: () => ipcRenderer.invoke('organize:canUndo'),
  },

  system: {
    info: () => ipcRenderer.invoke('system:info'),
  },

  winget: {
    available: () => ipcRenderer.invoke('winget:available'),
    list: () => ipcRenderer.invoke('winget:list'),
    upgrade: (ids) => ipcRenderer.invoke('winget:upgrade', ids),
    onProgress: (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on('winget:progress', listener);
      return () => ipcRenderer.removeListener('winget:progress', listener);
    },
  },

  startup: {
    list: () => ipcRenderer.invoke('startup:list'),
    set: (entry, enable) => ipcRenderer.invoke('startup:set', { entry, enable }),
  },

  apps: {
    list: () => ipcRenderer.invoke('apps:list'),
    uninstall: (id) => ipcRenderer.invoke('apps:uninstall', id),
    onProgress: (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on('apps:progress', listener);
      return () => ipcRenderer.removeListener('apps:progress', listener);
    },
  },
};

contextBridge.exposeInMainWorld('moondrive', api);
