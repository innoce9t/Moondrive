'use strict';

/* ============================================================
   Moondrive renderer — app logic
   ============================================================ */

const md = window.moondrive; // preload bridge
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  settings: null,
  system: null,
  scan: null, // { root, stats }
  navStack: [], // nodes from root -> current
  selectedNode: null,
  chatHistory: [], // {role, content}
  duplicates: null,
  updates: null, // { supported, items }
  startup: null, // { supported, items }
};

let graph = null;
let treemap = null;

// ------------------------------------------------------------
// Utilities
// ------------------------------------------------------------
function formatBytes(n) {
  if (n === 0 || n == null) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatNumber(n) {
  return (n || 0).toLocaleString();
}

function formatDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function basename(p) {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function toast(message, type = 'info', timeout = 3200) {
  const host = $('#toast-host');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icons = { success: '✓', error: '✕', info: 'ⓘ' };
  el.innerHTML = `<span class="toast-ico">${icons[type] || 'ⓘ'}</span><span></span>`;
  el.querySelector('span:last-child').textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 300);
  }, timeout);
}

function confirmModal({ title, body, confirmText = 'Confirm', danger = true }) {
  return new Promise((resolve) => {
    const backdrop = $('#modal-backdrop');
    $('#modal-title').textContent = title;
    $('#modal-body').textContent = body;
    const confirmBtn = $('#modal-confirm');
    confirmBtn.textContent = confirmText;
    confirmBtn.className = danger ? 'danger-btn' : 'primary-btn';
    backdrop.hidden = false;

    const cleanup = (result) => {
      backdrop.hidden = true;
      confirmBtn.removeEventListener('click', onConfirm);
      $('#modal-cancel').removeEventListener('click', onCancel);
      resolve(result);
    };
    const onConfirm = () => cleanup(true);
    const onCancel = () => cleanup(false);
    confirmBtn.addEventListener('click', onConfirm);
    $('#modal-cancel').addEventListener('click', onCancel);
  });
}

// Very small, safe markdown -> HTML (no raw HTML passthrough).
function renderMarkdown(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = text.split('\n');
  let html = '';
  let inList = false;
  let listType = 'ul';
  const inline = (s) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/(?<!\*)\*(?!\*)([^*]+)\*(?!\*)/g, '<em>$1</em>');

  const closeList = () => { if (inList) { html += `</${listType}>`; inList = false; } };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^#{1,6}\s/.test(line)) {
      closeList();
      const level = Math.min(3, line.match(/^#+/)[0].length);
      html += `<h${level}>${inline(line.replace(/^#+\s/, ''))}</h${level}>`;
    } else if (/^\s*[-*]\s+/.test(line)) {
      if (!inList || listType !== 'ul') { closeList(); html += '<ul>'; inList = true; listType = 'ul'; }
      html += `<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`;
    } else if (/^\s*\d+\.\s+/.test(line)) {
      if (!inList || listType !== 'ol') { closeList(); html += '<ol>'; inList = true; listType = 'ol'; }
      html += `<li>${inline(line.replace(/^\s*\d+\.\s+/, ''))}</li>`;
    } else if (line.trim() === '') {
      closeList();
    } else {
      closeList();
      html += `<p>${inline(line)}</p>`;
    }
  }
  closeList();
  return html;
}

// ------------------------------------------------------------
// Init
// ------------------------------------------------------------
async function init() {
  state.settings = await md.settings.getAll();
  state.system = await md.system.info();

  window.__fmtBytes = formatBytes; // used by the treemap renderer

  graph = new MoonGraph($('#graph-canvas'), {
    onSelect: onNodeSelect,
    onEnter: onNodeEnter,
  });

  treemap = new MoonTreemap($('#treemap-canvas'), {
    onSelect: (data) => (data ? showTmDetails(data) : clearTmDetails()),
    onEnter: onNodeEnter,
  });

  buildLegend();
  renderFolderLists();
  bindUI();
  bindScanProgress();
  bindWingetProgress();
  hydrateSettings();
}

function buildLegend() {
  const legend = $('#legend');
  const cats = ['folder', 'image', 'video', 'audio', 'document', 'archive', 'code', 'other'];
  legend.innerHTML = cats
    .map(
      (c) =>
        `<div class="legend-item"><span class="legend-dot" style="background:${window.CATEGORY_COLORS[c]};color:${window.CATEGORY_COLORS[c]}"></span>${c}</div>`
    )
    .join('');
}

// ------------------------------------------------------------
// Sandbox folders
// ------------------------------------------------------------
async function renderFolderLists() {
  const folders = await md.sandbox.list();
  const makeChip = (f, withScan) => {
    const div = document.createElement('div');
    div.className = 'folder-chip';
    div.innerHTML = `
      <span class="fc-name" title="${f}">${basename(f) || f}</span>
      ${withScan ? '<button class="fc-scan" title="Scan this folder">◎</button>' : ''}
      <button class="fc-remove" title="Remove access">✕</button>`;
    if (withScan) div.querySelector('.fc-scan').addEventListener('click', () => startScan(f));
    div.querySelector('.fc-remove').addEventListener('click', async () => {
      await md.sandbox.removeFolder(f);
      renderFolderLists();
      toast('Folder access removed', 'info');
    });
    return div;
  };

  const side = $('#folder-list');
  side.innerHTML = '';
  const setSide = $('#settings-folder-list');
  setSide.innerHTML = '';

  if (!folders.length) {
    side.innerHTML = '<p style="font-size:11.5px;color:var(--text-faint);padding:4px">No folders granted yet.</p>';
  }
  folders.forEach((f) => {
    side.appendChild(makeChip(f, true));
    setSide.appendChild(makeChip(f, false));
  });
}

async function pickFolder() {
  const res = await md.sandbox.pickFolder();
  if (res.canceled) return;
  renderFolderLists();
  toast(`Granted access to ${basename(res.folder)}`, 'success');
  const doScan = await confirmModal({
    title: 'Scan now?',
    body: `Scan ${res.folder} to build its node graph?`,
    confirmText: 'Scan',
    danger: false,
  });
  if (doScan) startScan(res.folder);
}

async function grantRoot() {
  const res = await md.sandbox.addRoot();
  if (res.canceled) return;
  renderFolderLists();
  toast('Root access granted — scan with care', 'info', 4200);
}

// ------------------------------------------------------------
// Scanning
// ------------------------------------------------------------
function bindScanProgress() {
  md.scan.onProgress((p) => {
    $('#scan-files').textContent = formatNumber(p.files);
    $('#scan-dirs').textContent = formatNumber(p.dirs);
    $('#scan-size').textContent = formatBytes(p.totalSize);
  });
}

async function startScan(folderPath) {
  switchView('graph');
  $('#empty-state').classList.add('hidden');
  const overlay = $('#scan-overlay');
  overlay.hidden = false;
  $('#scan-title').textContent = 'Scanning…';
  $('#scan-path').textContent = folderPath;
  $('#scan-files').textContent = '0';
  $('#scan-dirs').textContent = '0';
  $('#scan-size').textContent = '0 B';

  const result = await md.scan.start(folderPath);
  overlay.hidden = true;

  if (!result.ok) {
    toast(result.error || 'Scan failed', 'error', 5000);
    if (!state.scan) $('#empty-state').classList.remove('hidden');
    return;
  }

  state.scan = { root: result.root, stats: result.stats };
  state.navStack = [result.root];
  state.duplicates = null;
  $('#rescan-btn').disabled = false;

  updateTopStats();
  renderCurrentFolder();
  renderLargest();

  const skipped = result.stats.errors ? ` · ${formatNumber(result.stats.errors)} items skipped` : '';
  toast(
    `Scanned ${formatNumber(result.stats.files)} files · ${formatBytes(result.stats.totalSize)}${skipped}`,
    'success',
    4200
  );
}

function updateTopStats() {
  if (!state.scan) return;
  $('#stat-total-value').textContent = formatBytes(state.scan.stats.totalSize);
  $('#stat-files-value').textContent = formatNumber(state.scan.stats.files);
}

// ------------------------------------------------------------
// Graph navigation
// ------------------------------------------------------------
function currentFolder() {
  return state.navStack[state.navStack.length - 1];
}

function renderCurrentFolder() {
  const folder = currentFolder();
  if (!folder) return;
  graph.setFolder(folder);
  if (treemap) {
    treemap.setFolder(folder);
    const hasChildren = (folder.children || []).some((c) => c.size > 0);
    $('#treemap-empty').classList.toggle('hidden', hasChildren);
  }
  renderBreadcrumbs();
  clearDetails();
  clearTmDetails();
}

function renderBreadcrumbs() {
  const bc = $('#breadcrumbs');
  bc.innerHTML = '';
  state.navStack.forEach((node, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '›';
      bc.appendChild(sep);
    }
    const crumb = document.createElement('button');
    crumb.className = 'crumb' + (i === state.navStack.length - 1 ? ' current' : '');
    crumb.textContent = i === 0 ? basename(node.path) || node.path : node.name;
    crumb.title = node.path || node.name;
    crumb.addEventListener('click', () => {
      state.navStack = state.navStack.slice(0, i + 1);
      renderCurrentFolder();
    });
    bc.appendChild(crumb);
  });
}

function onNodeSelect(data) {
  state.selectedNode = data;
  if (!data) { clearDetails(); return; }
  showDetails(data);
}

function onNodeEnter(data) {
  if (!data) return;
  if (data._up) {
    if (state.navStack.length > 1) {
      state.navStack.pop();
      renderCurrentFolder();
    }
    return;
  }
  if (data._group) {
    // Expand the overflow bundle into a synthetic folder.
    const synth = {
      name: data.name,
      path: currentFolder().path,
      type: 'dir',
      size: data.size,
      children: data._group,
      _synthetic: true,
    };
    state.navStack.push(synth);
    renderCurrentFolder();
    return;
  }
  if (data.type === 'dir') {
    state.navStack.push(data);
    renderCurrentFolder();
  }
}

// ------------------------------------------------------------
// Details panel (shared by the graph and treemap views)
// ------------------------------------------------------------
function clearDetails() {
  $('#details-empty').hidden = false;
  $('#details-content').hidden = true;
}
function clearTmDetails() {
  $('#tm-details-empty').hidden = false;
  $('#tm-details-content').hidden = true;
}

/** Fill the common icon/name/path/grid fields for a details panel. */
function populateDetailsFields(prefix, data) {
  const cat = data.category || (data.type === 'dir' ? 'folder' : 'other');
  const color = window.CATEGORY_COLORS[cat] || '#6d7ba6';
  const iconEl = $(`#${prefix}-icon`);
  iconEl.textContent = window.CATEGORY_ICONS[cat] || '•';
  iconEl.style.background = hexA(color, 0.14);
  iconEl.style.color = color;
  $(`#${prefix}-name`).textContent = data.name;
  $(`#${prefix}-path`).textContent = data.path || '—';
  $(`#${prefix}-size`).textContent = formatBytes(data.size);
  $(`#${prefix}-type`).textContent = data.type === 'dir' ? 'Folder' : (data.ext ? `.${data.ext}` : 'File');
  $(`#${prefix}-mtime`).textContent = formatDate(data.mtimeMs);
  $(`#${prefix}-items`).textContent =
    data.type === 'dir' ? formatNumber(data.childCount || (data.children ? data.children.length : 0)) : '—';
}

function showDetails(data) {
  $('#details-empty').hidden = true;
  $('#details-content').hidden = false;
  populateDetailsFields('details', data);

  const isReal = !!data.path && !data._group && !data._synthetic;
  $('#details-enter').hidden = !(data.type === 'dir');
  $('#details-open').hidden = !(isReal && data.type === 'file');
  $('#details-rename').hidden = !isReal;
  $('#details-move').hidden = !isReal;
  $('#details-reveal').hidden = !isReal;
  $('#details-trash').hidden = !isReal;

  $('#details-enter').onclick = () => onNodeEnter(data);
  $('#details-open').onclick = () => md.files.open(data.path);
  $('#details-rename').onclick = () => renameNode(data);
  $('#details-move').onclick = () => moveNode(data);
  $('#details-reveal').onclick = () => md.files.reveal(data.path);
  $('#details-trash').onclick = () => trashPath(data);
}

function showTmDetails(data) {
  $('#tm-details-empty').hidden = true;
  $('#tm-details-content').hidden = false;
  populateDetailsFields('tm-details', data);
  const isReal = !!data.path && !data._synthetic;
  $('#tm-details-enter').hidden = !(data.type === 'dir');
  $('#tm-details-reveal').hidden = !isReal;
  $('#tm-details-trash').hidden = !isReal;
  $('#tm-details-enter').onclick = () => onNodeEnter(data);
  $('#tm-details-reveal').onclick = () => md.files.reveal(data.path);
  $('#tm-details-trash').onclick = () => trashPath(data);
}

function hexA(hex, a) {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

async function trashPath(data) {
  const ok = await confirmModal({
    title: 'Move to Trash?',
    body: `“${data.name}” (${formatBytes(data.size)}) will be moved to your system Trash. You can restore it from there.`,
    confirmText: 'Move to Trash',
  });
  if (!ok) return;
  try {
    await md.files.trash(data.path);
    toast(`Moved “${data.name}” to Trash`, 'success');
    removeFromTree(data.path);
    renderCurrentFolder();
    renderLargest();
    updateTopStats();
  } catch (e) {
    toast(e.message || 'Could not move to Trash', 'error', 5000);
  }
}

/** Remove a path from the in-memory tree and re-aggregate sizes along the way. */
function removeFromTree(targetPath) {
  if (!state.scan) return;
  const stack = state.navStack.slice();
  (function recurse(node) {
    if (!node.children) return false;
    const idx = node.children.findIndex((c) => c.path === targetPath);
    if (idx !== -1) {
      const removed = node.children[idx];
      node.children.splice(idx, 1);
      // propagate size reduction up the nav stack
      for (const anc of stack) {
        if (anc !== node && isAncestorPath(anc.path, targetPath)) anc.size -= removed.size;
      }
      node.size -= removed.size;
      state.scan.stats.totalSize -= removed.size;
      if (removed.type === 'file') state.scan.stats.files -= 1;
      return true;
    }
    for (const c of node.children) if (c.type === 'dir' && recurse(c)) return true;
    return false;
  })(state.scan.root);
}

function isAncestorPath(anc, child) {
  if (!anc || !child) return false;
  return child === anc || child.startsWith(anc.endsWith('/') || anc.endsWith('\\') ? anc : anc + '/') || child.startsWith(anc + '\\');
}

// ------------------------------------------------------------
// Largest files view
// ------------------------------------------------------------
function renderLargest() {
  const tbody = $('#largest-table').querySelector('tbody');
  tbody.innerHTML = '';
  if (!state.scan) {
    tbody.innerHTML = '<tr><td class="empty-list">Run a scan to see your largest files.</td></tr>';
    return;
  }
  const files = state.scan.stats.largest || [];
  if (!files.length) {
    tbody.innerHTML = '<tr><td class="empty-list">No files found.</td></tr>';
    return;
  }
  const max = files[0].size || 1;
  files.forEach((f) => {
    const cat = catFromPath(f.path);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="cell-check"><input type="checkbox" data-path="${encodeURIComponent(f.path)}"></td>
      <td>
        <div class="file-name-cell">
          <span class="file-dot" style="background:${window.CATEGORY_COLORS[cat]};color:${window.CATEGORY_COLORS[cat]}"></span>
          <div style="min-width:0">
            <div class="file-name">${basename(f.path)}</div>
            <div class="file-path-sub" title="${f.path}">${f.path}</div>
          </div>
        </div>
      </td>
      <td class="cell-bar"><div class="size-bar"><div class="size-bar-fill" style="width:${(f.size / max) * 100}%"></div></div></td>
      <td><span class="size-text">${formatBytes(f.size)}</span></td>
      <td class="cell-actions">
        <button class="row-btn reveal" title="Reveal">◎</button>
        <button class="row-btn trash" title="Move to Trash">🗑</button>
      </td>`;
    tr.querySelector('.reveal').addEventListener('click', () => md.files.reveal(f.path));
    tr.querySelector('.trash').addEventListener('click', () =>
      trashPath({ name: basename(f.path), path: f.path, size: f.size, type: 'file' })
    );
    tr.querySelector('input').addEventListener('change', updateLargestSelection);
    tbody.appendChild(tr);
  });
  updateLargestSelection();
}

function updateLargestSelection() {
  const checked = $$('#largest-table input:checked');
  $('#largest-trash-selected').disabled = checked.length === 0;
  $('#largest-trash-selected').textContent = checked.length ? `Trash ${checked.length} selected` : 'Trash selected';
}

async function trashSelectedLargest() {
  const checked = $$('#largest-table input:checked');
  const paths = checked.map((c) => decodeURIComponent(c.dataset.path));
  if (!paths.length) return;
  const ok = await confirmModal({
    title: `Move ${paths.length} files to Trash?`,
    body: `${paths.length} selected files will be moved to your system Trash.`,
    confirmText: 'Move to Trash',
  });
  if (!ok) return;
  const results = await md.files.trashMany(paths);
  const okCount = results.filter((r) => r.ok).length;
  results.filter((r) => r.ok).forEach((r) => removeFromTree(r.path));
  renderCurrentFolder();
  renderLargest();
  updateTopStats();
  toast(`Moved ${okCount}/${paths.length} files to Trash`, okCount ? 'success' : 'error');
}

function catFromPath(p) {
  const ext = (p.split('.').pop() || '').toLowerCase();
  const map = window.__extCat || (window.__extCat = buildExtCat());
  return map[ext] || 'other';
}
function buildExtCat() {
  // mirror of scanner category map for renderer-side coloring
  const groups = {
    image: ['jpg','jpeg','png','gif','bmp','tiff','tif','webp','svg','heic','raw','cr2','nef','ico'],
    video: ['mp4','mkv','mov','avi','wmv','flv','webm','m4v','mpg','mpeg','3gp'],
    audio: ['mp3','wav','flac','aac','ogg','m4a','wma','aiff','opus'],
    document: ['pdf','doc','docx','txt','rtf','odt','xls','xlsx','ppt','pptx','csv','md','pages','key','numbers','epub'],
    archive: ['zip','rar','7z','tar','gz','bz2','xz','iso','dmg','pkg','deb','rpm'],
    code: ['js','ts','jsx','tsx','py','java','c','cpp','h','hpp','cs','go','rs','rb','php','html','css','json','xml','yml','yaml','sh','sql','swift','kt'],
    executable: ['exe','msi','app','bin','apk','jar','bat','cmd','com'],
  };
  const map = {};
  for (const [k, arr] of Object.entries(groups)) for (const e of arr) map[e] = k;
  return map;
}

// ------------------------------------------------------------
// Duplicates view
// ------------------------------------------------------------
async function findDuplicates() {
  if (!state.scan) { toast('Run a scan first', 'info'); return; }
  const btn = $('#find-dupes');
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  $('#dupes-summary').textContent = 'Comparing files by size and content fingerprint…';
  try {
    const groups = await md.scan.duplicates();
    state.duplicates = groups;
    renderDuplicates();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Find duplicates';
  }
}

function renderDuplicates() {
  const list = $('#dupes-list');
  const groups = state.duplicates || [];
  const wasted = groups.reduce((s, g) => s + g.wasted, 0);
  $('#dupes-summary').textContent = groups.length
    ? `${groups.length} duplicate groups · about ${formatBytes(wasted)} reclaimable`
    : 'No duplicates found. 🎉';
  list.innerHTML = '';
  groups.forEach((g) => {
    const div = document.createElement('div');
    div.className = 'dupe-group';
    const head = document.createElement('div');
    head.className = 'dupe-group-head';
    head.innerHTML = `<span class="dupe-badge">${g.count} copies</span> <strong>${formatBytes(g.size)}</strong> each · <span style="color:var(--warn)">${formatBytes(g.wasted)} wasted</span>`;
    div.appendChild(head);
    g.files.forEach((f, idx) => {
      const row = document.createElement('div');
      row.className = 'dupe-file';
      // keep the first copy unchecked by default (the "original")
      row.innerHTML = `
        <input type="checkbox" data-path="${encodeURIComponent(f.path)}" ${idx === 0 ? '' : ''}>
        <span class="dupe-path" title="${f.path}">${f.path}</span>
        <button class="row-btn reveal" title="Reveal">◎</button>`;
      row.querySelector('.reveal').addEventListener('click', () => md.files.reveal(f.path));
      row.querySelector('input').addEventListener('change', updateDupeSelection);
      div.appendChild(row);
    });
    list.appendChild(div);
  });
  updateDupeSelection();
}

function updateDupeSelection() {
  const checked = $$('#dupes-list input:checked');
  $('#dupes-trash-selected').disabled = checked.length === 0;
  $('#dupes-trash-selected').textContent = checked.length ? `Trash ${checked.length} selected` : 'Trash selected';
}

async function trashSelectedDupes() {
  const checked = $$('#dupes-list input:checked');
  const paths = checked.map((c) => decodeURIComponent(c.dataset.path));
  if (!paths.length) return;
  const ok = await confirmModal({
    title: `Move ${paths.length} duplicates to Trash?`,
    body: `${paths.length} selected copies will be moved to your system Trash. Make sure you keep at least one copy of each file.`,
    confirmText: 'Move to Trash',
  });
  if (!ok) return;
  const results = await md.files.trashMany(paths);
  const okCount = results.filter((r) => r.ok).length;
  results.filter((r) => r.ok).forEach((r) => removeFromTree(r.path));
  // prune from duplicate groups
  state.duplicates = (state.duplicates || [])
    .map((g) => ({ ...g, files: g.files.filter((f) => !paths.includes(f.path)) }))
    .filter((g) => g.files.length > 1);
  renderDuplicates();
  renderCurrentFolder();
  renderLargest();
  updateTopStats();
  toast(`Moved ${okCount}/${paths.length} duplicates to Trash`, okCount ? 'success' : 'error');
}

// ------------------------------------------------------------
// AI assistant
// ------------------------------------------------------------
async function sendChat(text) {
  if (!text.trim()) return;
  if (!state.settings.geminiApiKey) {
    toast('Add your Gemini API key in Settings first', 'error', 4500);
    switchView('settings');
    return;
  }
  const intro = $('.chat-intro');
  if (intro) intro.remove();

  appendMessage('user', text);
  state.chatHistory.push({ role: 'user', content: text });
  $('#chat-text').value = '';
  autoGrow($('#chat-text'));

  const typing = appendTyping();
  $('#chat-send').disabled = true;

  const res = await md.ai.ask(state.chatHistory.slice(-12));
  typing.remove();
  $('#chat-send').disabled = false;

  if (!res.ok) {
    appendMessage('assistant', `⚠️ ${res.error}`);
    return;
  }
  appendMessage('assistant', res.text);
  state.chatHistory.push({ role: 'assistant', content: res.text });
}

function appendMessage(role, content) {
  const log = $('#chat-log');
  const msg = document.createElement('div');
  msg.className = `msg ${role}`;
  const avatar = role === 'assistant' ? '✦' : '🙂';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  if (role === 'assistant') bubble.innerHTML = renderMarkdown(content);
  else bubble.textContent = content;
  msg.innerHTML = `<div class="msg-avatar">${avatar}</div>`;
  msg.appendChild(bubble);
  log.appendChild(msg);
  log.scrollTop = log.scrollHeight;
}

function appendTyping() {
  const log = $('#chat-log');
  const msg = document.createElement('div');
  msg.className = 'msg assistant typing';
  msg.innerHTML = `<div class="msg-avatar">✦</div><div class="msg-bubble"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`;
  log.appendChild(msg);
  log.scrollTop = log.scrollHeight;
  return msg;
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(160, el.scrollHeight) + 'px';
}

// ------------------------------------------------------------
// Settings
// ------------------------------------------------------------
function hydrateSettings() {
  $('#gemini-key').value = state.settings.geminiApiKey || '';
  $('#gemini-model').value = state.settings.geminiModel || 'gemini-2.0-flash';
  $('#follow-symlinks').checked = !!state.settings.followSymlinks;
}

async function saveAiSettings() {
  await md.settings.set('geminiApiKey', $('#gemini-key').value.trim());
  state.settings = await md.settings.set('geminiModel', $('#gemini-model').value);
  const flash = $('#ai-saved');
  flash.hidden = false;
  setTimeout(() => (flash.hidden = true), 2000);
  toast('AI settings saved', 'success');
}

// ------------------------------------------------------------
// App updates (winget)
// ------------------------------------------------------------
function unsupportedRow(table, icon, message) {
  const tbody = $(table).querySelector('tbody');
  tbody.innerHTML = `<tr><td colspan="6"><div class="unsupported-notice"><div class="un-ico">${icon}</div><p>${message}</p></div></td></tr>`;
}

async function checkUpdates() {
  const btn = $('#check-updates');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  $('#updates-summary').textContent = 'Querying winget for available upgrades…';
  try {
    const res = await md.winget.list();
    state.updates = res;
    renderUpdates();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check for updates';
  }
}

function renderUpdates() {
  const res = state.updates;
  const tbody = $('#updates-table').querySelector('tbody');
  tbody.innerHTML = '';

  if (!res || !res.supported) {
    $('#updates-summary').textContent = '';
    unsupportedRow('#updates-table', '⊘', (res && res.reason) || 'winget package updates are only available on Windows.');
    $('#updates-upgrade-all').disabled = true;
    $('#updates-upgrade-selected').disabled = true;
    return;
  }

  const items = res.items || [];
  $('#updates-summary').textContent = items.length
    ? `${items.length} update${items.length === 1 ? '' : 's'} available`
    : 'Everything is up to date. 🎉';
  $('#updates-upgrade-all').disabled = items.length === 0;

  items.forEach((it) => {
    const tr = document.createElement('tr');
    tr.dataset.id = it.id;
    tr.innerHTML = `
      <td class="cell-check"><input type="checkbox" data-id="${encodeURIComponent(it.id)}"></td>
      <td>
        <div class="file-name-cell">
          <div style="min-width:0">
            <div class="file-name">${escapeHtml(it.name)}</div>
            <div class="upd-id">${escapeHtml(it.id)}${it.source ? ' · ' + escapeHtml(it.source) : ''}</div>
          </div>
        </div>
      </td>
      <td class="upd-version">
        <span class="from">${escapeHtml(it.version)}</span>
        <span class="arrow">→</span>
        <span class="to">${escapeHtml(it.available)}</span>
      </td>
      <td class="upd-status"></td>`;
    tr.querySelector('input').addEventListener('change', updateUpdatesSelection);
    tbody.appendChild(tr);
  });
  updateUpdatesSelection();
}

function updateUpdatesSelection() {
  const checked = $$('#updates-table input:checked');
  $('#updates-upgrade-selected').disabled = checked.length === 0;
  $('#updates-upgrade-selected').textContent = checked.length ? `Upgrade ${checked.length} selected` : 'Upgrade selected';
}

async function runUpgrade(ids) {
  if (!ids.length) return;
  const consoleEl = $('#updates-console');
  consoleEl.hidden = false;
  consoleEl.textContent = '';
  ids.forEach((id) => setUpdateStatus(id, '<span class="badge-upgrading">upgrading…</span>'));
  $('#updates-upgrade-all').disabled = true;
  $('#updates-upgrade-selected').disabled = true;
  $('#check-updates').disabled = true;

  const res = await md.winget.upgrade(ids);
  $('#check-updates').disabled = false;

  if (!res.supported) {
    toast(res.reason || 'winget unavailable', 'error');
    return;
  }
  let ok = 0;
  res.results.forEach((r) => {
    if (r.ok) {
      ok++;
      setUpdateStatus(r.id, '<span class="badge-done">✓ updated</span>');
    } else {
      setUpdateStatus(r.id, `<span class="badge-fail">failed${r.code ? ' (' + r.code + ')' : ''}</span>`);
    }
  });
  toast(`Upgraded ${ok}/${res.results.length} app${res.results.length === 1 ? '' : 's'}`, ok ? 'success' : 'error');
  // Refresh the list after a short delay so completed items drop off.
  setTimeout(checkUpdates, 1200);
}

function setUpdateStatus(id, html) {
  const row = $(`#updates-table tr[data-id="${cssEscape(id)}"]`);
  if (row) row.querySelector('.upd-status').innerHTML = html;
}

function bindWingetProgress() {
  md.winget.onProgress(({ id, line }) => {
    const consoleEl = $('#updates-console');
    consoleEl.hidden = false;
    const div = document.createElement('div');
    div.innerHTML = `<span class="con-id">${escapeHtml(shortId(id))}</span>  ${escapeHtml(line)}`;
    consoleEl.appendChild(div);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  });
}

function shortId(id) {
  return id.length > 24 ? id.slice(0, 23) + '…' : id;
}

async function upgradeSelectedUpdates() {
  const ids = $$('#updates-table input:checked').map((c) => decodeURIComponent(c.dataset.id));
  const ok = await confirmModal({
    title: `Upgrade ${ids.length} app${ids.length === 1 ? '' : 's'}?`,
    body: 'winget will download and install the selected upgrades silently. This may take a few minutes.',
    confirmText: 'Upgrade',
    danger: false,
  });
  if (ok) runUpgrade(ids);
}

async function upgradeAllUpdates() {
  const ids = (state.updates?.items || []).map((i) => i.id);
  const ok = await confirmModal({
    title: `Upgrade all ${ids.length} apps?`,
    body: 'winget will download and install every available upgrade silently. This may take a while.',
    confirmText: 'Upgrade all',
    danger: false,
  });
  if (ok) runUpgrade(ids);
}

// ------------------------------------------------------------
// Startup apps
// ------------------------------------------------------------
async function refreshStartup() {
  const btn = $('#refresh-startup');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  $('#startup-summary').textContent = 'Reading startup entries…';
  try {
    const res = await md.startup.list();
    state.startup = res;
    renderStartup();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh';
  }
}

function renderStartup() {
  const res = state.startup;
  const tbody = $('#startup-table').querySelector('tbody');
  tbody.innerHTML = '';

  if (!res || !res.supported) {
    $('#startup-summary').textContent = '';
    unsupportedRow('#startup-table', '⊘', (res && res.reason) || 'Startup-app management is only available on Windows.');
    return;
  }
  if (res.error) {
    $('#startup-summary').textContent = '';
    unsupportedRow('#startup-table', '⚠', res.error);
    return;
  }

  const items = res.items || [];
  const enabled = items.filter((i) => i.enabled).length;
  $('#startup-summary').textContent = items.length
    ? `${items.length} startup entries · ${enabled} enabled`
    : 'No startup entries found.';

  items.forEach((it, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <div class="file-name-cell">
          <div style="min-width:0">
            <div class="file-name">${escapeHtml(it.name || '(unnamed)')}</div>
            <div class="startup-cmd" title="${escapeHtml(it.command || '')}">${escapeHtml(it.command || '')}</div>
          </div>
        </div>
      </td>
      <td class="startup-loc">${escapeHtml(prettyLocation(it.location))}${it.user ? ' · ' + escapeHtml(it.user) : ''}</td>
      <td class="cell-actions"><div class="toggle ${it.enabled ? 'on' : ''}" role="switch" aria-checked="${it.enabled}"></div></td>`;
    const toggle = tr.querySelector('.toggle');
    toggle.addEventListener('click', () => toggleStartup(it, toggle));
    tbody.appendChild(tr);
  });
}

function prettyLocation(loc) {
  if (!loc) return '';
  if (/HKLM/i.test(loc)) return 'Machine · Registry';
  if (/HKU|HKCU/i.test(loc)) return 'User · Registry';
  if (/common/i.test(loc)) return 'Machine · Startup folder';
  if (/startup/i.test(loc)) return 'User · Startup folder';
  return loc;
}

async function toggleStartup(entry, toggleEl) {
  const enable = !entry.enabled;
  toggleEl.classList.add('busy');
  const res = await md.startup.set(entry, enable);
  toggleEl.classList.remove('busy');
  if (!res.supported) {
    toast(res.reason || 'Not supported', 'error');
    return;
  }
  if (!res.ok) {
    toast(res.error || 'Could not change this entry', 'error', 5000);
    return;
  }
  entry.enabled = enable;
  toggleEl.classList.toggle('on', enable);
  toggleEl.setAttribute('aria-checked', String(enable));
  const items = state.startup.items || [];
  const en = items.filter((i) => i.enabled).length;
  $('#startup-summary').textContent = `${items.length} startup entries · ${en} enabled`;
  toast(`${entry.name} ${enable ? 'enabled' : 'disabled'} at startup`, 'success');
}

// small helpers
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

// ------------------------------------------------------------
// Rename & move
// ------------------------------------------------------------
function sepOf(p) {
  return p.includes('\\') ? '\\' : '/';
}
function dirnameOf(p) {
  const s = sepOf(p);
  const idx = p.lastIndexOf(s);
  return idx <= 0 ? p : p.slice(0, idx);
}
function joinPath(dir, name) {
  const s = sepOf(dir);
  return dir.endsWith(s) ? dir + name : dir + s + name;
}

/** Rewrite this node's path (and all descendants) after a rename/move. */
function rewritePaths(node, oldPrefix, newPrefix) {
  if (node.path && node.path.startsWith(oldPrefix)) {
    node.path = newPrefix + node.path.slice(oldPrefix.length);
  }
  if (node.children) node.children.forEach((c) => rewritePaths(c, oldPrefix, newPrefix));
}

function findNodeByPath(root, target) {
  if (root.path === target) return root;
  if (root.children) {
    for (const c of root.children) {
      const found = findNodeByPath(c, target);
      if (found) return found;
    }
  }
  return null;
}

async function renameNode(data) {
  const newName = await promptModal({
    title: 'Rename',
    body: `Rename “${data.name}” to:`,
    value: data.name,
    confirmText: 'Rename',
  });
  if (!newName || newName === data.name) return;
  if (/[\\/]/.test(newName)) { toast('Name cannot contain slashes', 'error'); return; }
  const dir = dirnameOf(data.path);
  const dest = joinPath(dir, newName);
  try {
    await md.files.move(data.path, dest);
    const node = state.scan ? findNodeByPath(state.scan.root, data.path) : null;
    if (node) {
      node.name = newName;
      rewritePaths(node, data.path, dest);
    }
    toast(`Renamed to “${newName}”`, 'success');
    afterMutation();
  } catch (e) {
    toast(e.message || 'Rename failed', 'error', 5000);
  }
}

async function moveNode(data) {
  const res = await md.files.pickDestination();
  if (res.canceled) return;
  if (res.dir === dirnameOf(data.path)) { toast('Already in that folder', 'info'); return; }
  if (res.dir === data.path || res.dir.startsWith(data.path + sepOf(data.path))) {
    toast('Cannot move a folder into itself', 'error');
    return;
  }
  const dest = joinPath(res.dir, data.name);
  const ok = await confirmModal({
    title: 'Move item',
    body: `Move “${data.name}” to:\n${res.dir}\n\n(It must be inside a folder you've granted access to.)`,
    confirmText: 'Move',
    danger: false,
  });
  if (!ok) return;
  try {
    await md.files.move(data.path, dest);
    removeFromTree(data.path);
    toast(`Moved “${data.name}”. Rescan to see it in its new location.`, 'success', 4500);
    afterMutation();
  } catch (e) {
    toast(e.message || 'Move failed', 'error', 5000);
  }
}

function afterMutation() {
  renderCurrentFolder();
  renderLargest();
  updateTopStats();
}

// ------------------------------------------------------------
// Prompt modal
// ------------------------------------------------------------
function promptModal({ title, body, value = '', confirmText = 'Save' }) {
  return new Promise((resolve) => {
    const backdrop = $('#prompt-backdrop');
    $('#prompt-title').textContent = title;
    $('#prompt-body').textContent = body;
    const input = $('#prompt-input');
    input.value = value;
    $('#prompt-confirm').textContent = confirmText;
    backdrop.hidden = false;
    setTimeout(() => { input.focus(); input.select(); }, 30);

    const cleanup = (result) => {
      backdrop.hidden = true;
      $('#prompt-confirm').removeEventListener('click', onOk);
      $('#prompt-cancel').removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onOk = () => cleanup(input.value.trim());
    const onCancel = () => cleanup(null);
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onOk(); }
      else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    $('#prompt-confirm').addEventListener('click', onOk);
    $('#prompt-cancel').addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  });
}

// ------------------------------------------------------------
// Scan history
// ------------------------------------------------------------
async function loadHistory() {
  state.history = await md.history.list();
  renderHistory();
}

function renderHistory() {
  const entries = (state.history || []).slice().sort((a, b) => b.timestamp - a.timestamp);
  const list = $('#history-list');
  list.innerHTML = '';
  $('#history-summary').textContent = entries.length
    ? `${entries.length} scan${entries.length === 1 ? '' : 's'} recorded`
    : 'No scans recorded yet. Scan a folder to start tracking its size over time.';

  entries.forEach((entry) => {
    // chronological series for this path, to draw a trend + delta
    const series = entries
      .filter((e) => e.path === entry.path)
      .sort((a, b) => a.timestamp - b.timestamp);
    const idx = series.findIndex((e) => e.timestamp === entry.timestamp);
    const prev = idx > 0 ? series[idx - 1] : null;
    const delta = prev ? entry.totalSize - prev.totalSize : 0;

    const card = document.createElement('div');
    card.className = 'history-card';

    const deltaClass = !prev ? 'same' : delta > 0 ? 'up' : delta < 0 ? 'down' : 'same';
    const deltaText = !prev
      ? 'first scan'
      : delta === 0
      ? 'no change'
      : `${delta > 0 ? '▲' : '▼'} ${formatBytes(Math.abs(delta))}`;

    card.innerHTML = `
      <div class="history-spark">${sparklineSVG(series.map((s) => s.totalSize))}</div>
      <div class="history-main">
        <div class="history-path" title="${escapeHtml(entry.path)}">${escapeHtml(basename(entry.path) || entry.path)}</div>
        <div class="history-sub">${escapeHtml(entry.path)}</div>
        <div class="history-sub">${new Date(entry.timestamp).toLocaleString()} · ${formatNumber(entry.files)} files · ${formatNumber(entry.dirs)} folders</div>
      </div>
      <div class="history-size">
        <div class="hs-big">${formatBytes(entry.totalSize)}</div>
        <div class="history-delta ${deltaClass}">${deltaText}</div>
      </div>
      <div class="history-actions">
        <button class="ghost-btn hist-rescan">Rescan</button>
      </div>`;
    card.querySelector('.hist-rescan').addEventListener('click', () => {
      switchView('graph');
      startScan(entry.path);
    });
    list.appendChild(card);
  });
}

/** Tiny inline SVG sparkline of totalSize over time. */
function sparklineSVG(values) {
  const w = 92;
  const h = 34;
  if (!values.length) return '';
  if (values.length === 1) {
    return `<svg width="${w}" height="${h}"><circle cx="${w / 2}" cy="${h / 2}" r="3.5" fill="#57a5ff"/></svg>`;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (w - 6) + 3;
    const y = h - 4 - ((v - min) / range) * (h - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = pts[pts.length - 1].split(',');
  return `<svg width="${w}" height="${h}">
    <polyline fill="none" stroke="#3d7bff" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" points="${pts.join(' ')}"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="2.6" fill="#57a5ff"/>
  </svg>`;
}

async function clearHistory() {
  const ok = await confirmModal({
    title: 'Clear scan history?',
    body: 'This removes all recorded scan history. It does not touch any files.',
    confirmText: 'Clear',
  });
  if (!ok) return;
  await md.history.clear();
  state.history = [];
  renderHistory();
  toast('Scan history cleared', 'info');
}

// ------------------------------------------------------------
// View switching
// ------------------------------------------------------------
function switchView(view) {
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === view));
  if (view === 'largest') renderLargest();
  if (view === 'duplicates' && !state.duplicates) $('#dupes-summary').textContent = 'Click “Find duplicates” to scan for repeated files.';
  if (view === 'updates' && !state.updates) checkUpdates();
  if (view === 'startup' && !state.startup) refreshStartup();
  if (view === 'history') loadHistory();
  if (view === 'treemap' && treemap) {
    // The canvas has no size while hidden — measure and lay out now it's visible.
    requestAnimationFrame(() => {
      treemap._resize();
      if (currentFolder()) {
        treemap.setFolder(currentFolder());
        const hasChildren = (currentFolder().children || []).some((c) => c.size > 0);
        $('#treemap-empty').classList.toggle('hidden', hasChildren);
      }
    });
  }
}

// ------------------------------------------------------------
// Bind UI
// ------------------------------------------------------------
function bindUI() {
  $$('.nav-item').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));

  $('#add-folder-btn').addEventListener('click', pickFolder);
  $('#add-root-btn').addEventListener('click', grantRoot);
  $('#settings-add-folder').addEventListener('click', pickFolder);
  $('#settings-add-root').addEventListener('click', grantRoot);
  $('#empty-add-folder').addEventListener('click', pickFolder);
  $('#empty-suggest').addEventListener('click', suggestAndScan);

  $('#rescan-btn').addEventListener('click', () => {
    if (state.scan) startScan(state.scan.root.path);
  });

  $('#scan-cancel').addEventListener('click', () => md.scan.cancel());

  // graph controls
  $('#zoom-in').addEventListener('click', () => graph.zoomIn());
  $('#zoom-out').addEventListener('click', () => graph.zoomOut());
  $('#zoom-reset').addEventListener('click', () => graph.resetView());
  $('#graph-up').addEventListener('click', () => onNodeEnter({ _up: true }));

  // largest / dupes
  $('#largest-trash-selected').addEventListener('click', trashSelectedLargest);
  $('#find-dupes').addEventListener('click', findDuplicates);
  $('#dupes-trash-selected').addEventListener('click', trashSelectedDupes);

  // updates (winget)
  $('#check-updates').addEventListener('click', checkUpdates);
  $('#updates-upgrade-selected').addEventListener('click', upgradeSelectedUpdates);
  $('#updates-upgrade-all').addEventListener('click', upgradeAllUpdates);

  // startup apps
  $('#refresh-startup').addEventListener('click', refreshStartup);

  // treemap
  $('#treemap-up').addEventListener('click', () => onNodeEnter({ _up: true }));

  // history
  $('#history-clear').addEventListener('click', clearHistory);

  // chat
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    sendChat($('#chat-text').value);
  });
  $('#chat-text').addEventListener('input', (e) => autoGrow(e.target));
  $('#chat-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat($('#chat-text').value);
    }
  });
  $$('.chat-suggestions button').forEach((b) =>
    b.addEventListener('click', () => sendChat(b.dataset.prompt))
  );

  // settings
  $('#save-ai').addEventListener('click', saveAiSettings);
  $('#toggle-key').addEventListener('click', () => {
    const inp = $('#gemini-key');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });
  $('#follow-symlinks').addEventListener('change', async (e) => {
    state.settings = await md.settings.set('followSymlinks', e.target.checked);
    toast('Symlink preference saved', 'info');
  });

  // keyboard: Escape closes modal / clears selection
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal-backdrop').hidden) $('#modal-cancel').click();
  });
}

async function suggestAndScan() {
  const suggestions = await md.sandbox.suggestFolders();
  if (!suggestions.length) {
    toast('No suggested folders available — grant one manually', 'info');
    return;
  }
  // Prefer Downloads (usually the most cluttered), else the first suggestion.
  const preferred = suggestions.find((s) => /downloads/i.test(s)) || suggestions[0];
  try {
    const res = await md.sandbox.grantSuggested(preferred);
    renderFolderLists();
    toast(`Scanning ${basename(res.folder)}…`, 'info');
    startScan(res.folder);
  } catch (e) {
    toast(e.message || 'Could not grant folder', 'error');
  }
}

// ------------------------------------------------------------
document.addEventListener('DOMContentLoaded', init);
