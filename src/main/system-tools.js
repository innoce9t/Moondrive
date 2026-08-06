'use strict';

/* ============================================================
   system-tools.js — Windows package updates (winget) and
   startup-app management. All functions are platform-guarded;
   on non-Windows systems they resolve with { supported: false }.
   ============================================================ */

const { spawn, execFile } = require('child_process');
const os = require('os');

const IS_WIN = process.platform === 'win32';

// ------------------------------------------------------------
// Small process helpers
// ------------------------------------------------------------
function run(cmd, args, { timeout = 60000, env } = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout, windowsHide: true, maxBuffer: 1024 * 1024 * 8, env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || '', err });
      }
    );
  });
}

// Matches ANSI/VT escape sequences winget emits (colours, cursor moves) even
// when its output is piped — these otherwise corrupt column alignment.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

function stripAnsi(s) {
  return s.replace(ANSI_RE, '');
}

/** Strip escape sequences, carriage-return redraws, and progress-bar noise. */
function cleanConsole(text) {
  return text
    .split('\n')
    .map((line) => stripAnsi(line.split('\r').pop())) // final redraw of each line, no escapes
    .filter((line) => !/^[\s█░▒▓·\-─\\|/]*$/.test(line) || line.trim() === '')
    .join('\n');
}

// ------------------------------------------------------------
// winget
// ------------------------------------------------------------
async function wingetAvailable() {
  if (!IS_WIN) return { supported: false, reason: 'winget is only available on Windows.' };
  const res = await run('winget', ['--version'], { timeout: 15000 });
  if (res.code !== 0) {
    return { supported: false, reason: 'winget was not found. Install "App Installer" from the Microsoft Store.' };
  }
  return { supported: true, version: res.stdout.trim() };
}

/**
 * Parse the table produced by `winget upgrade`. winget separates columns with
 * runs of 2+ spaces and pads them, so splitting on /\s{2,}/ recovers the fields
 * reliably — a name's own single spaces stay intact, while column gaps split.
 * This is far more robust than slicing by header character positions, which
 * breaks when piped output uses a different code page or carries escape codes.
 */
function parseWingetUpgrade(raw) {
  const text = cleanConsole(raw);
  const lines = text.split(/\r?\n/);

  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/(^|\s)Name(\s|$)/.test(l) && /\bId\b/.test(l) && /\bVersion\b/.test(l) && /\bAvailable\b/.test(l)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return [];

  const header = lines[headerIdx];
  const iId = header.indexOf('Id');
  const iVersion = header.indexOf('Version');
  const iAvailable = header.indexOf('Available');
  const iSource = header.indexOf('Source');
  const canSlice = iId > 0 && iVersion > iId && iAvailable > iVersion;

  const items = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) continue;
    if (/^[-─=\s]+$/.test(t)) continue; // separator row
    if (/^\d+\s+(package|upgrade)/i.test(t)) break; // "N upgrades available." footer
    if (/have version numbers that cannot be determined/i.test(t)) continue;

    let name;
    let id;
    let version;
    let available;
    let source = '';

    // Primary: slice by the header's column positions. This survives winget's
    // truncated long names ("…"), which leave only one space before the Id.
    if (canSlice && line.length >= iAvailable) {
      name = line.slice(0, iId).trim();
      id = line.slice(iId, iVersion).trim();
      version = line.slice(iVersion, iAvailable).trim();
      available = line.slice(iAvailable, iSource > iAvailable ? iSource : undefined).trim();
      source = iSource > iAvailable ? line.slice(iSource).trim() : '';
    }

    // Fallback: if slicing looks wrong (ids/versions never contain spaces),
    // split on runs of 2+ spaces instead.
    if (!id || /\s/.test(id) || !available || /\s/.test(available)) {
      const cols = t.split(/\s{2,}/);
      if (cols.length >= 4) {
        [name, id, version, available, source] = cols;
        source = source || '';
      }
    }

    if (id && available && !/\s/.test(id)) {
      items.push({ name: name || id, id, version: version || '', available, source: source || '' });
    }
  }
  return items;
}

async function wingetListUpgrades() {
  const avail = await wingetAvailable();
  if (!avail.supported) return { supported: false, reason: avail.reason, items: [] };

  // Run through cmd with `chcp 65001` so winget emits UTF-8 that Node decodes
  // correctly regardless of the machine's default console code page.
  const res = await run(
    'cmd.exe',
    ['/d', '/s', '/c', 'chcp 65001 >nul & winget upgrade --include-unknown --accept-source-agreements --disable-interactivity'],
    { timeout: 120000 }
  );
  let items = parseWingetUpgrade(res.stdout || '');
  // Fallback: some winget builds reject --disable-interactivity; retry without it.
  if (!items.length && /--disable-interactivity|unexpected argument|Unrecognized/i.test(res.stdout + res.stderr)) {
    const res2 = await run(
      'cmd.exe',
      ['/d', '/s', '/c', 'chcp 65001 >nul & winget upgrade --include-unknown --accept-source-agreements'],
      { timeout: 120000 }
    );
    items = parseWingetUpgrade(res2.stdout || '');
  }
  return { supported: true, items };
}

/**
 * Upgrade a list of package ids sequentially, streaming console lines through
 * onLine(id, text). Returns a per-package result summary.
 */
async function wingetUpgrade(ids, onLine) {
  const avail = await wingetAvailable();
  if (!avail.supported) return { supported: false, reason: avail.reason, results: [] };

  const results = [];
  for (const id of ids) {
    const result = await new Promise((resolve) => {
      const child = spawn(
        'winget',
        [
          'upgrade',
          '--id', id,
          '--exact',
          '--silent',
          '--accept-package-agreements',
          '--accept-source-agreements',
          '--disable-interactivity',
        ],
        { windowsHide: true }
      );
      let buf = '';
      const push = (chunk) => {
        buf += chunk.toString();
        const parts = buf.split(/\r?\n/);
        buf = parts.pop();
        for (const line of parts) {
          const clean = stripAnsi(line.split('\r').pop());
          if (clean && clean.trim()) onLine && onLine(id, clean);
        }
      };
      child.stdout.on('data', push);
      child.stderr.on('data', push);
      child.on('error', (e) => resolve({ id, ok: false, error: e.message }));
      child.on('close', (code) => resolve({ id, ok: code === 0, code }));
    });
    results.push(result);
  }
  return { supported: true, results };
}

// ------------------------------------------------------------
// Startup apps (Windows)
// ------------------------------------------------------------
function ps(script, timeout = 30000) {
  // Force UTF-8 output so Node decodes PowerShell's stdout correctly regardless
  // of the machine's console code page (Windows PowerShell 5.1 otherwise emits
  // in the OEM/ANSI page, which mangles non-ASCII names/paths).
  const utf8Prefix = '$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';
  return run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', utf8Prefix + script],
    { timeout }
  );
}

/** Parse JSON from PowerShell stdout, tolerating a UTF-8 BOM and stray escapes. */
function parsePsJson(stdout) {
  let out = stripAnsi(String(stdout || '')).trim();
  if (out.charCodeAt(0) === 0xfeff) out = out.slice(1); // strip BOM
  if (!out) return [];
  const json = JSON.parse(out);
  return Array.isArray(json) ? json : [json];
}

const LIST_STARTUP_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'

function Test-Disabled($bytes) {
  if (-not $bytes) { return $false }
  # Task Manager marks disabled entries with an odd first byte (3, 11, ...).
  return (($bytes[0] -band 1) -eq 1)
}

$approved = @{}
$approvedPaths = @(
  @{ Scope='user';    Kind='Run';           Path='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run' },
  @{ Scope='machine'; Kind='Run';           Path='HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run' },
  @{ Scope='machine'; Kind='Run';           Path='HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run32' },
  @{ Scope='user';    Kind='StartupFolder'; Path='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder' },
  @{ Scope='machine'; Kind='StartupFolder'; Path='HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder' }
)
foreach ($ap in $approvedPaths) {
  $key = Get-Item -LiteralPath $ap.Path -ErrorAction SilentlyContinue
  if ($key) {
    foreach ($valName in $key.GetValueNames()) {
      $bytes = $key.GetValue($valName)
      $approved[$valName] = @{ disabled = (Test-Disabled $bytes); kind = $ap.Kind; scope = $ap.Scope }
    }
  }
}

$items = Get-CimInstance Win32_StartupCommand -ErrorAction SilentlyContinue | ForEach-Object {
  $name = $_.Name
  $status = $approved[$name]
  $disabled = if ($status) { $status.disabled } else { $false }
  [pscustomobject]@{
    name     = $name
    command  = $_.Command
    location = $_.Location
    user     = $_.User
    enabled  = -not $disabled
    known    = [bool]$status
  }
}

$items | ConvertTo-Json -Depth 4 -Compress
`;

async function listStartupApps() {
  if (!IS_WIN) return { supported: false, reason: 'Startup management is only available on Windows.', items: [] };
  const res = await ps(LIST_STARTUP_SCRIPT);
  if (res.code !== 0) {
    return { supported: true, items: [], error: (res.stderr || 'Could not read startup entries.').trim() };
  }
  let parsed = [];
  try {
    parsed = parsePsJson(res.stdout);
  } catch (e) {
    return { supported: true, items: [], error: 'Could not parse startup entries.' };
  }
  return { supported: true, items: parsed };
}

/**
 * Enable or disable a startup entry using the same StartupApproved mechanism
 * Windows Task Manager uses. This is non-destructive — it never deletes the
 * underlying Run entry or shortcut, only flips the approved flag.
 */
function buildToggleScript(entry, enable) {
  const name = String(entry.name || '').replace(/'/g, "''");
  const location = String(entry.location || '');
  const isFolder = /startup/i.test(location) && !/\\Run/i.test(location);
  const isMachine = /^HKLM/i.test(location) || /Common/i.test(location);

  const subkey = isFolder ? 'StartupFolder' : 'Run';
  const hive = isMachine ? 'HKLM:' : 'HKCU:';
  const keyPath = `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\${subkey}`;

  // 02 = enabled, 03 = disabled; both followed by a zeroed FILETIME.
  const firstByte = enable ? 2 : 3;
  return `
$ErrorActionPreference = 'Stop'
$key = '${keyPath}'
if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
$bytes = [byte[]](${firstByte},0,0,0,0,0,0,0,0,0,0,0)
New-ItemProperty -LiteralPath $key -Name '${name}' -PropertyType Binary -Value $bytes -Force | Out-Null
Write-Output 'OK'
`;
}

async function setStartupApp(entry, enable) {
  if (!IS_WIN) return { supported: false, reason: 'Startup management is only available on Windows.' };
  const res = await ps(buildToggleScript(entry, enable));
  if (res.code !== 0 || !/OK/.test(res.stdout)) {
    const msg = (res.stderr || 'Could not change this entry. Machine-wide entries may require running Moondrive as administrator.').trim();
    return { supported: true, ok: false, error: msg };
  }
  return { supported: true, ok: true };
}

// ------------------------------------------------------------
// Installed apps (list + uninstall) — Windows
// ------------------------------------------------------------
const LIST_APPS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$paths = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$apps = foreach ($p in $paths) { Get-ItemProperty $p -ErrorAction SilentlyContinue }
$apps |
  Where-Object {
    $_.DisplayName -and $_.UninstallString -and
    -not $_.SystemComponent -and
    ($_.ReleaseType -notin @('Security Update','Update Rollup','Hotfix')) -and
    -not $_.ParentKeyName
  } |
  ForEach-Object {
    $scope = if ($_.PSPath -match 'HKEY_CURRENT_USER') { 'user' } else { 'machine' }
    [pscustomobject]@{
      name        = $_.DisplayName
      version     = $_.DisplayVersion
      publisher   = $_.Publisher
      installDate = $_.InstallDate
      size        = if ($_.EstimatedSize) { [int64]$_.EstimatedSize * 1024 } else { 0 }
      uninstall   = $_.UninstallString
      quiet       = $_.QuietUninstallString
      location    = $_.InstallLocation
      key         = $_.PSChildName
      scope       = $scope
    }
  } |
  Sort-Object name -Unique |
  ConvertTo-Json -Depth 3 -Compress
`;

async function listInstalledApps() {
  if (!IS_WIN) return { supported: false, reason: 'Uninstalling apps is only available on Windows.', items: [] };
  const res = await ps(LIST_APPS_SCRIPT, 45000);
  if (res.code !== 0) {
    return { supported: true, items: [], error: (res.stderr || 'Could not read installed apps.').trim() };
  }
  let parsed = [];
  try {
    parsed = parsePsJson(res.stdout);
  } catch (e) {
    return { supported: true, items: [], error: 'Could not parse installed apps.' };
  }
  // Assign a stable composite id and keep only the fields the UI needs.
  const items = parsed.map((a) => ({
    id: `${a.scope}|${a.key}`,
    name: a.name,
    version: a.version || '',
    publisher: a.publisher || '',
    installDate: a.installDate || '',
    size: a.size || 0,
    scope: a.scope,
    _uninstall: a.uninstall || '',
    _quiet: a.quiet || '',
  }));
  return { supported: true, items };
}

/** Turn an app's registry uninstall string into a runnable command. */
function buildUninstallCommand(app) {
  const str = app._quiet || app._uninstall;
  if (!str) return null;
  // MSI products: rewrite the install/repair invocation into a silent uninstall.
  if (/msiexec/i.test(str)) {
    const guid = str.match(/\{[0-9A-Fa-f-]{36}\}/);
    if (guid) return `msiexec.exe /x ${guid[0]} /quiet /norestart`;
  }
  // Otherwise run the vendor uninstaller. QuietUninstallString (when present) is
  // silent; a plain UninstallString may open the vendor's own uninstaller UI.
  return str;
}

async function uninstallApp(app, onLine) {
  if (!IS_WIN) return { supported: false, reason: 'Uninstalling apps is only available on Windows.' };
  const cmd = buildUninstallCommand(app);
  if (!cmd) return { supported: true, ok: false, error: 'No uninstall command is registered for this app.' };

  return new Promise((resolve) => {
    // chcp 65001 so any UTF-8 output from the vendor uninstaller reads cleanly.
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `chcp 65001 >nul & ${cmd}`], { windowsHide: true });
    let buf = '';
    const push = (chunk) => {
      buf += chunk.toString();
      const parts = buf.split(/\r?\n/);
      buf = parts.pop();
      for (const line of parts) {
        const clean = stripAnsi(line.split('\r').pop());
        if (clean && clean.trim()) onLine && onLine(clean);
      }
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', (e) => resolve({ supported: true, ok: false, error: e.message }));
    child.on('close', (code) => resolve({ supported: true, ok: code === 0, code }));
  });
}

module.exports = {
  IS_WIN,
  wingetAvailable,
  wingetListUpgrades,
  wingetUpgrade,
  parseWingetUpgrade, // exported for testing
  parsePsJson, // exported for testing
  stripAnsi, // exported for testing
  listStartupApps,
  setStartupApp,
  listInstalledApps,
  uninstallApp,
};
