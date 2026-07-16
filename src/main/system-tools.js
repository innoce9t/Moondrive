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

/** Strip carriage-return progress redraws and spinner/progress-bar noise. */
function cleanConsole(text) {
  return text
    .split('\n')
    .map((line) => line.split('\r').pop()) // keep only the final redraw of each line
    .filter((line) => !/^[\s█░▒▓\-\\|/]*$/.test(line) || line.trim() === '')
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
 * Parse the fixed-width table produced by `winget upgrade`. winget aligns
 * columns to header positions, so we slice each row by the header indices
 * rather than splitting on whitespace (names/ids can contain spaces).
 */
function parseWingetUpgrade(raw) {
  const text = cleanConsole(raw);
  const lines = text.split(/\r?\n/);

  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/\bName\b/.test(lines[i]) && /\bId\b/.test(lines[i]) && /\bVersion\b/.test(lines[i]) && /\bAvailable\b/.test(lines[i])) {
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

  const items = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) continue;
    if (/^[-─\s]+$/.test(t)) continue; // separator row
    if (/upgrades?\s+available/i.test(t) || /package\(s\)/i.test(t)) break;
    if (t.length < iId) continue;

    const name = line.slice(0, iId).trim();
    const id = line.slice(iId, iVersion).trim();
    const version = line.slice(iVersion, iAvailable).trim();
    const available = line.slice(iAvailable, iSource > -1 ? iSource : undefined).trim();
    const source = iSource > -1 ? line.slice(iSource).trim() : '';
    if (id && available && !/^Version$/i.test(version)) {
      items.push({ name: name || id, id, version, available, source });
    }
  }
  return items;
}

async function wingetListUpgrades() {
  const avail = await wingetAvailable();
  if (!avail.supported) return { supported: false, reason: avail.reason, items: [] };

  const res = await run(
    'winget',
    ['upgrade', '--include-unknown', '--accept-source-agreements', '--disable-interactivity'],
    { timeout: 120000, env: { WINGET_DISABLE_INTERACTIVITY: '1' } }
  );
  const items = parseWingetUpgrade(res.stdout || res.stderr);
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
          const clean = line.split('\r').pop();
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
  return run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout }
  );
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
    const out = (res.stdout || '').trim();
    if (out) {
      const json = JSON.parse(out);
      parsed = Array.isArray(json) ? json : [json];
    }
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

module.exports = {
  IS_WIN,
  wingetAvailable,
  wingetListUpgrades,
  wingetUpgrade,
  parseWingetUpgrade, // exported for testing
  listStartupApps,
  setStartupApp,
};
