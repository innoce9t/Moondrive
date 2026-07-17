# 🌙 Moondrive

A modern, sandboxed **drive organiser** built with Electron. Scan your disks,
watch your files bloom into a navigable **node graph** sized by weight and
coloured by type, then declutter with confidence — with a **Gemini AI**
assistant advising you on what to keep, archive, or delete.

Black-and-blue dashboard, smooth animations, and safety-first deletions (every
removal goes to your system Trash, never a hard delete).

![Electron](https://img.shields.io/badge/Electron-2B2E3A?logo=electron&logoColor=9FEAF9)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black)
![Gemini](https://img.shields.io/badge/Google%20Gemini-8E75B2?logo=googlegemini&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green.svg)

![Moondrive graph view](docs/graph.png)

---

## Features

- **📊 Node-graph visualiser** — a live, force-directed galaxy of your files.
  Nodes are sized by byte-weight and coloured by category (video, image, audio,
  documents, code, archives, executables…). Pan, zoom, drag nodes, and
  **double-click a folder to drill into it**; breadcrumbs let you jump back out.
- **▦ Treemap view** — a squarified space-filling map of the current folder, the
  classic "where did my disk go" view. Shares the same drill-in navigation as
  the graph; click a tile to inspect, double-click a folder to descend.
- **✏️ Rename & move** — rename any file or folder in place, or move it into
  another granted folder, straight from the details panel (sandbox-enforced).
- **↻ Scan history** — every scan is recorded, so you can watch a folder's size
  trend over time. Each entry shows a sparkline, the size delta since the last
  scan of that path, and a one-click rescan.
- **🔍 Deep, fast, correct scanner** — engineered for large drives:
  - **Bounded-concurrency I/O** (a semaphore keeps many `readdir`/`stat` calls
    in flight without exhausting file descriptors) — dramatically faster on real
    drives where per-file latency dominates.
  - **Optional worker-thread parallelism** — splits top-level subtrees across
    CPU cores for even more throughput on many-core machines.
  - **Progressive rendering** — the graph and treemap fill in *live* as
    subtrees complete, instead of waiting for the whole scan.
  - **Lazy tree over IPC** — the full tree stays in the main process; the UI
    receives only the level it's showing and fetches deeper levels on demand, so
    memory and IPC stay bounded even at millions of files.
  - **Incremental "fast rescan"** — reuses folders whose timestamp is unchanged,
    making repeat scans of a mostly-static drive near-instant.
  - **Correct accounting** — a bounded min-heap for top-largest tracking,
    hardlink/inode dedup (a hardlinked file's bytes count once), on-disk
    *allocated* size alongside logical size, and access/modify times.
  - **Boundary guarding** — skips recycle bins and pseudo filesystems
    (`/proc`, `/sys`, `System Volume Information`…), with an optional
    stay-on-one-drive mode so it won't wander into network mounts.
  - Streams live progress, tolerates permission errors, and skips symlinks by
    default. An optional **drive watcher** nudges you to rescan when the folder
    changes.
- **🗂 Largest files & duplicate finder** — instantly surface the biggest space
  hogs, and detect duplicate files (grouped by size + content fingerprint) with
  a one-click "reclaimable space" estimate.
- **🤖 Gemini AI assistant** — chat with Google's Gemini about how to organise
  your drive. It sees only *aggregate* stats and the *names* of your largest
  items — **never file contents**.
- **✨ AI auto-organize (one click)** — Gemini proposes a tidy set of subfolders
  and assigns your loose files to them. You get a grouped **preview** with a
  checkbox per move, apply exactly what you want, and there's a **one-click undo**
  that moves everything back and removes the folders it created. Every proposed
  move is validated against the real file listing and the sandbox before running.
- **🧹 Junk & cache scanner** — instantly flags reclaimable clutter over the
  scanned tree (no extra disk I/O): dependency caches (`node_modules`), build
  artifacts (`build`/`dist`/`target`/`.next`…), temp files, logs, backups,
  incomplete downloads, and system clutter (`.DS_Store`, `Thumbs.db`). Grouped by
  type with a reclaimable-space total; select and trash.
- **⭳ App updates (Windows / winget)** — check for available package upgrades
  via `winget`, pick exactly which apps to update, and upgrade them silently
  with live console output. Or upgrade everything in one click.
- **⏻ Startup-app manager (Windows)** — see everything that launches at boot
  (registry Run keys + startup folders, per-user and machine-wide) and flip each
  on/off with a toggle. Uses the same non-destructive StartupApproved mechanism
  as Task Manager — it never deletes your Run entries or shortcuts.
- **🗑 App uninstaller (Windows)** — lists everything in "Add/Remove Programs"
  (read from the registry Uninstall keys, not just winget packages), sorted by
  size with a filter box, and uninstalls via each app's own uninstaller
  (silent/MSI-aware where possible). For safety the main process caches the list
  and uninstalls **by id** — the renderer never handles a raw command line.
- **🛡 Sandboxed by design** — Moondrive can only read or modify folders you
  explicitly grant. There's an optional, clearly-warned "grant root access" for
  power users. Every filesystem mutation passes through a single allow-list gate
  in the main process.
- **🗑 Safe deletions** — files are moved to the system Trash (restorable), with
  a confirmation step and multi-select trashing from the lists.
- **🎨 Modern UI** — black/blue glassy dashboard, glowing nodes, fluid
  transitions, toasts, and a keyboard-friendly modal system.

## Architecture

```
src/
├── main/                 Electron main process (Node — full filesystem access)
│   ├── main.js           App lifecycle + all IPC handlers (sandbox-gated)
│   ├── scanner.js        Recursive, cancellable scan + duplicate detection
│   ├── gemini.js         Minimal Gemini REST client + privacy-safe summariser
│   ├── system-tools.js   winget upgrades + Windows startup/uninstall management
│   ├── parallel-scan.js  Worker-pool scanner (splits subtrees across threads)
│   ├── scanner-worker.js Worker entry point for a single subtree scan
│   └── store.js          Local JSON settings + the sandbox allow-list gate
├── preload/
│   └── preload.js        contextBridge — the only surface the UI can touch
└── renderer/             Sandboxed UI (no Node access)
    ├── index.html        Dashboard layout
    ├── styles.css        Black & blue theme + animations
    ├── graph.js          Canvas force-directed node graph (MoonGraph)
    ├── treemap.js        Squarified treemap on canvas (MoonTreemap)
    └── renderer.js        App logic, views, navigation, AI chat
```

### Security model

- `contextIsolation: true`, `nodeIntegration: false` — the renderer has **no**
  direct access to `fs`, `path`, or Node. It talks to the main process only
  through the narrow `window.moondrive` API defined in the preload.
- Every filesystem-mutating IPC handler re-validates its target against the
  sandbox allow-list (`Store.isPathAllowed`), which correctly rejects
  sibling-prefix tricks (e.g. `/data-evil` is **not** inside `/data`).
- Deletions use Electron's `shell.trashItem` — items go to the OS Trash and can
  be restored.
- A strict Content-Security-Policy is set on the renderer document.

## Getting started

```bash
npm install     # installs Electron
npm start       # launch the app
npm run dev     # launch with DevTools open
```

> **Note:** `npm install` downloads the Electron binary from GitHub releases.
> In network-restricted environments that download may be blocked; run it on a
> machine with normal outbound access.

### Using the AI assistant

1. Get a free API key from [Google AI Studio](https://aistudio.google.com/apikey).
2. Open **Settings → Gemini AI**, paste your key, pick a model, and save.
3. Head to **AI assistant** and ask away.

### Packaging

```bash
npm run pack    # unpacked build in release/
npm run dist    # installable build (AppImage / NSIS / dmg) via electron-builder
```

## How the graph works

Each scanned folder becomes a central **hub**; its children orbit it as glowing
nodes. Node radius scales with `√(size)` so both huge and tiny items stay
visible, and colour encodes the file category. A lightweight physics loop
(gravity + pairwise repulsion + collision separation) keeps the layout tidy and
alive. When a folder has hundreds of children, the long tail is bundled into a
single "+N smaller items" node you can expand.

## Privacy

Moondrive runs entirely on your machine. The only network calls it makes are to
Google's Gemini API — and only when you use the assistant, sending only
aggregate statistics and file/folder **names**, never contents. Your API key and
granted-folder list are stored in a local JSON settings file.

## License

MIT

## Author

Built by **Ahsan Nawazish** — AI / ML Engineer. A systems-focused desktop project: concurrency-tuned scanning, IPC architecture, security sandboxing, and hand-rolled Canvas visualizations.
[Portfolio](https://ahsan.live) · [LinkedIn](https://linkedin.com/in/anawazish) · [GitHub](https://github.com/innoce9t)
