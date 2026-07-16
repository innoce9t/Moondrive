'use strict';

const https = require('https');

const DEFAULT_MODEL = 'gemini-2.0-flash';
const API_HOST = 'generativelanguage.googleapis.com';

/**
 * Minimal Gemini client using the REST generateContent endpoint. We avoid
 * pulling in the SDK to keep the dependency surface (and the sandbox) small.
 */
function generate({ apiKey, model = DEFAULT_MODEL, systemPrompt, messages }) {
  return new Promise((resolve, reject) => {
    if (!apiKey) {
      reject(new Error('No Gemini API key configured. Add one in Settings.'));
      return;
    }

    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const payload = {
      contents,
      generationConfig: {
        temperature: 0.6,
        maxOutputTokens: 2048,
      },
    };
    if (systemPrompt) {
      payload.systemInstruction = { parts: [{ text: systemPrompt }] };
    }

    const body = JSON.stringify(payload);
    const options = {
      host: API_HOST,
      path: `/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 60000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          reject(new Error(`Gemini returned an unreadable response (HTTP ${res.statusCode}).`));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const msg = parsed?.error?.message || `HTTP ${res.statusCode}`;
          reject(new Error(`Gemini error: ${msg}`));
          return;
        }
        const text = parsed?.candidates?.[0]?.content?.parts
          ?.map((p) => p.text)
          .filter(Boolean)
          .join('\n');
        if (!text) {
          const finish = parsed?.candidates?.[0]?.finishReason;
          reject(new Error(finish ? `Gemini stopped (${finish}) without producing text.` : 'Gemini returned no content.'));
          return;
        }
        resolve(text.trim());
      });
    });

    req.on('timeout', () => req.destroy(new Error('Gemini request timed out.')));
    req.on('error', (e) => reject(new Error(`Network error contacting Gemini: ${e.message}`)));
    req.write(body);
    req.end();
  });
}

/**
 * Build a compact, privacy-conscious summary of a scan for the model.
 * We send aggregate stats and only the *names* of the largest items — never
 * file contents.
 */
function buildScanSummary(scan) {
  if (!scan || !scan.stats) return 'No scan has been performed yet.';
  const { stats, root } = scan;
  const fmt = (n) => {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(1)} ${u[i]}`;
  };

  const cats = Object.entries(stats.byCategory || {})
    .sort((a, b) => b[1].size - a[1].size)
    .map(([k, v]) => `  - ${k}: ${v.count} files, ${fmt(v.size)}`)
    .join('\n');

  const largest = (stats.largest || [])
    .slice(0, 15)
    .map((f) => `  - ${fmt(f.size)}  ${f.path}`)
    .join('\n');

  const topFolders = (root?.children || [])
    .filter((c) => c.type === 'dir')
    .slice(0, 12)
    .map((c) => `  - ${fmt(c.size)}  ${c.name}`)
    .join('\n');

  return [
    `Scanned root: ${root?.path || 'unknown'}`,
    `Total: ${stats.files} files, ${stats.dirs} folders, ${fmt(stats.totalSize)}`,
    stats.errors ? `Skipped ${stats.errors} items (permission or access errors).` : null,
    '',
    'By category:',
    cats || '  (none)',
    '',
    'Top-level folders by size:',
    topFolders || '  (none)',
    '',
    'Largest files:',
    largest || '  (none)',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

const SYSTEM_PROMPT = `You are Moondrive's organisation assistant. You help the user understand and tidy up their disk.
You are given an aggregate summary of a folder scan (categories, largest files, biggest folders). You never see file contents.

Guidelines:
- Be concrete and actionable. Suggest specific folders/files to review, archive, or delete, and explain why.
- Group advice: quick wins first (large obviously-safe items), then structural organisation ideas.
- Warn before suggesting deletion of anything that could be a system folder or user documents.
- Propose a sensible folder structure when asked.
- Keep answers tight and skimmable. Use short markdown lists and headers. No fluff.
- When you cannot know something from the summary, say so instead of guessing.`;

module.exports = { generate, buildScanSummary, SYSTEM_PROMPT, DEFAULT_MODEL };
