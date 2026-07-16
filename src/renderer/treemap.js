'use strict';

/* ============================================================
   MoonTreemap — a squarified treemap on canvas.
   Renders the children of the "current" folder as nested
   rectangles sized by byte-weight and coloured by type.
   Click to select, double-click a folder to drill in.
   Shares the navigation model with the node graph.
   ============================================================ */

class MoonTreemap {
  constructor(canvas, { onSelect, onEnter } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSelect = onSelect || (() => {});
    this.onEnter = onEnter || (() => {});
    this.dpr = window.devicePixelRatio || 1;

    this.folder = null;
    this.tiles = []; // { data, x, y, w, h, color }
    this.selected = null;
    this.hovered = null;
    this.pad = 3;

    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    this._bind();
    this._resize();
  }

  destroy() {
    window.removeEventListener('resize', this._resize);
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, rect.width * this.dpr);
    this.canvas.height = Math.max(1, rect.height * this.dpr);
    this.w = rect.width;
    this.h = rect.height;
    this._layout();
    this._draw();
  }

  setFolder(folder) {
    this.folder = folder;
    this.selected = null;
    this.hovered = null;
    this._layout();
    this._draw();
  }

  _colorFor(data) {
    const cat = data.category || (data.type === 'dir' ? 'folder' : 'other');
    return window.CATEGORY_COLORS[cat] || window.CATEGORY_COLORS.other;
  }

  _layout() {
    this.tiles = [];
    if (!this.folder) return;
    const children = (this.folder.children || []).filter((c) => c.size > 0);
    if (!children.length) return;

    const items = children.map((c) => ({ data: c, value: c.size }));
    const rect = { x: 4, y: 4, w: this.w - 8, h: this.h - 8 };
    this._squarify(items, rect);
  }

  // Squarified treemap (Bruls, Huizing, van Wijk).
  _squarify(items, rect) {
    const area = rect.w * rect.h;
    const total = items.reduce((s, i) => s + i.value, 0) || 1;
    const scaled = items.map((i) => ({ ...i, area: (i.value / total) * area }));

    let x = rect.x;
    let y = rect.y;
    let w = rect.w;
    let h = rect.h;
    let row = [];
    const worst = (row, len) => {
      if (!row.length) return Infinity;
      const sum = row.reduce((s, r) => s + r.area, 0);
      const max = Math.max(...row.map((r) => r.area));
      const min = Math.min(...row.map((r) => r.area));
      const len2 = len * len;
      const sum2 = sum * sum;
      return Math.max((len2 * max) / sum2, sum2 / (len2 * min));
    };

    let i = 0;
    while (i < scaled.length) {
      const len = Math.min(w, h);
      const next = scaled[i];
      const withNext = row.concat(next);
      if (row.length === 0 || worst(withNext, len) <= worst(row, len)) {
        row = withNext;
        i++;
      } else {
        this._placeRow(row, x, y, w, h);
        const rowSum = row.reduce((s, r) => s + r.area, 0);
        if (w >= h) {
          const dx = rowSum / h;
          x += dx; w -= dx;
        } else {
          const dy = rowSum / w;
          y += dy; h -= dy;
        }
        row = [];
      }
    }
    if (row.length) this._placeRow(row, x, y, w, h);
  }

  _placeRow(row, x, y, w, h) {
    const rowSum = row.reduce((s, r) => s + r.area, 0);
    if (w >= h) {
      const rw = rowSum / h;
      let cy = y;
      for (const r of row) {
        const rh = r.area / rw;
        this.tiles.push({ data: r.data, x, y: cy, w: rw, h: rh, color: this._colorFor(r.data) });
        cy += rh;
      }
    } else {
      const rh = rowSum / w;
      let cx = x;
      for (const r of row) {
        const rw = r.area / rh;
        this.tiles.push({ data: r.data, x: cx, y, w: rw, h: rh, color: this._colorFor(r.data) });
        cx += rw;
      }
    }
  }

  _tileAt(sx, sy) {
    for (let i = this.tiles.length - 1; i >= 0; i--) {
      const t = this.tiles[i];
      if (sx >= t.x && sx <= t.x + t.w && sy >= t.y && sy <= t.y + t.h) return t;
    }
    return null;
  }

  _draw() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.tiles.length) return;

    const fmt = window.__fmtBytes || ((n) => n + ' B');

    for (const t of this.tiles) {
      const active = t === this.hovered || t === this.selected;
      const inset = this.pad / 2;
      const x = t.x + inset;
      const y = t.y + inset;
      const w = Math.max(0, t.w - this.pad);
      const h = Math.max(0, t.h - this.pad);
      if (w < 1 || h < 1) continue;

      const g = ctx.createLinearGradient(x, y, x, y + h);
      g.addColorStop(0, hexRgba(t.color, active ? 0.95 : 0.72));
      g.addColorStop(1, hexRgba(t.color, active ? 0.7 : 0.42));
      ctx.fillStyle = g;
      roundRect(ctx, x, y, w, h, Math.min(6, w / 2, h / 2));
      ctx.fill();

      ctx.lineWidth = active ? 2 : 1;
      ctx.strokeStyle = active ? '#ffffff' : hexRgba(t.color, 0.9);
      ctx.stroke();

      if (t.data.type === 'dir') {
        // folder corner marker
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.fillRect(x + 4, y + 4, Math.min(14, w - 8), 2.5);
      }

      // labels when the tile is big enough
      if (w > 54 && h > 26) {
        ctx.fillStyle = 'rgba(255,255,255,0.96)';
        ctx.font = '600 12px -apple-system, Inter, sans-serif';
        ctx.textBaseline = 'top';
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 6, y + 5, w - 12, h - 10);
        ctx.clip();
        ctx.fillText(t.data.name, x + 7, y + 6);
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.font = '11px -apple-system, Inter, sans-serif';
        ctx.fillText(fmt(t.data.size), x + 7, y + 21);
        ctx.restore();
      }
    }
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener('mousemove', (e) => {
      const rect = c.getBoundingClientRect();
      const t = this._tileAt(e.clientX - rect.left, e.clientY - rect.top);
      if (t !== this.hovered) {
        this.hovered = t;
        c.style.cursor = t ? 'pointer' : 'default';
        this._draw();
      }
    });
    c.addEventListener('mouseleave', () => {
      this.hovered = null;
      this._draw();
    });
    c.addEventListener('click', (e) => {
      const rect = c.getBoundingClientRect();
      const t = this._tileAt(e.clientX - rect.left, e.clientY - rect.top);
      this.selected = t;
      this._draw();
      this.onSelect(t ? t.data : null);
    });
    c.addEventListener('dblclick', (e) => {
      const rect = c.getBoundingClientRect();
      const t = this._tileAt(e.clientX - rect.left, e.clientY - rect.top);
      if (t && t.data.type === 'dir') this.onEnter(t.data);
    });
  }
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hexRgba(hex, a) {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

window.MoonTreemap = MoonTreemap;
