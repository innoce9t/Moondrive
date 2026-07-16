'use strict';

/* ============================================================
   MoonGraph — a canvas force-directed node graph.
   Displays the children of the "current" directory as nodes that
   orbit a central hub, sized by byte-weight and coloured by type.
   Supports pan, zoom, hover, select, drag, and drill-in navigation.
   ============================================================ */

const CATEGORY_COLORS = {
  folder: '#5a7dff',
  image: '#34e0ff',
  video: '#ff6bd6',
  audio: '#7b6bff',
  document: '#ffd24a',
  archive: '#ff9a4a',
  code: '#35e0a0',
  executable: '#ff5a72',
  other: '#6d7ba6',
};

const CATEGORY_ICONS = {
  folder: '📁',
  image: '🖼',
  video: '🎬',
  audio: '🎵',
  document: '📄',
  archive: '🗜',
  code: '⟨⟩',
  executable: '⚙',
  other: '•',
};

function hexToRgba(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

class MoonGraph {
  constructor(canvas, { onSelect, onEnter } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSelect = onSelect || (() => {});
    this.onEnter = onEnter || (() => {});

    this.nodes = [];
    this.hub = null; // central node representing the current folder
    this.dpr = window.devicePixelRatio || 1;

    this.view = { x: 0, y: 0, scale: 1 };
    this.selected = null;
    this.hovered = null;
    this.spacing = 1; // multiplier for how far nodes orbit from the hub

    this._drag = null; // { node, offsetX, offsetY } or { panning:true }
    this._raf = null;
    this._time = 0;

    this._resize = this._resize.bind(this);
    this._tick = this._tick.bind(this);

    window.addEventListener('resize', this._resize);
    this._bindPointer();
    this._resize();
    this._raf = requestAnimationFrame(this._tick);
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._resize);
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, rect.width * this.dpr);
    this.canvas.height = Math.max(1, rect.height * this.dpr);
    this.w = rect.width;
    this.h = rect.height;
  }

  get cx() { return this.w / 2; }
  get cy() { return this.h / 2; }

  /**
   * Load a folder node's children into the graph.
   * @param {object} folder - the directory node (has .children)
   */
  setFolder(folder) {
    this.selected = null;
    const children = (folder.children || []).slice();

    // Cap the number of visible nodes; bundle the long tail into one node.
    const MAX = 140;
    let display = children;
    let overflow = null;
    if (children.length > MAX) {
      display = children.slice(0, MAX - 1);
      const rest = children.slice(MAX - 1);
      const size = rest.reduce((s, c) => s + c.size, 0);
      overflow = {
        name: `+${rest.length} smaller items`,
        type: 'group',
        category: 'other',
        size,
        _group: rest,
      };
    }

    const maxSize = Math.max(1, ...display.map((c) => c.size), overflow ? overflow.size : 0);

    const toNode = (data, i, count) => {
      const angle = (i / Math.max(1, count)) * Math.PI * 2;
      const ring = 120 + (i % 5) * 26;
      const r = this._radiusFor(data.size, maxSize);
      return {
        data,
        x: this.cx + Math.cos(angle) * ring + (Math.random() - 0.5) * 20,
        y: this.cy + Math.sin(angle) * ring + (Math.random() - 0.5) * 20,
        vx: 0,
        vy: 0,
        r,
        targetR: r,
        color: CATEGORY_COLORS[data.category] || CATEGORY_COLORS.other,
        appear: 0,
      };
    };

    const all = display.slice();
    if (overflow) all.push(overflow);
    this.nodes = all.map((d, i) => toNode(d, i, all.length));

    this.hub = {
      data: folder,
      x: this.cx,
      y: this.cy,
      r: 34,
      color: '#eaf1ff',
    };

    this.resetView();
  }

  _radiusFor(size, maxSize) {
    const min = 8;
    const max = 46;
    const t = Math.sqrt(size / maxSize) || 0;
    return min + t * (max - min);
  }

  clear() {
    this.nodes = [];
    this.hub = null;
    this.selected = null;
  }

  // ---- view controls ----
  zoomBy(factor, ax, ay) {
    const px = ax != null ? ax : this.w / 2;
    const py = ay != null ? ay : this.h / 2;
    const wx = (px - this.view.x) / this.view.scale;
    const wy = (py - this.view.y) / this.view.scale;
    this.view.scale = Math.min(4, Math.max(0.25, this.view.scale * factor));
    this.view.x = px - wx * this.view.scale;
    this.view.y = py - wy * this.view.scale;
  }
  zoomIn() { this.zoomBy(1.2); }
  zoomOut() { this.zoomBy(1 / 1.2); }
  resetView() { this.view = { x: 0, y: 0, scale: 1 }; }

  /** Set how far nodes orbit the hub (1 = default). Nudges the layout so the
   *  change is visible immediately without waiting for a rescan. */
  setSpacing(mult) {
    const v = Math.max(0.5, Math.min(3, Number(mult) || 1));
    this.spacing = v;
    // give the settled cloud a little energy so it re-expands/contracts
    for (const nd of this.nodes) {
      nd.vx += (Math.random() - 0.5) * 0.5;
      nd.vy += (Math.random() - 0.5) * 0.5;
    }
  }

  // ---- coordinate helpers ----
  _toWorld(sx, sy) {
    return {
      x: (sx - this.view.x) / this.view.scale,
      y: (sy - this.view.y) / this.view.scale,
    };
  }

  _nodeAt(sx, sy) {
    const { x, y } = this._toWorld(sx, sy);
    // hub first
    if (this.hub) {
      const d = Math.hypot(x - this.hub.x, y - this.hub.y);
      if (d <= this.hub.r) return this.hub;
    }
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      if (Math.hypot(x - n.x, y - n.y) <= n.r + 4) return n;
    }
    return null;
  }

  // ---- physics ----
  _simulate() {
    const nodes = this.nodes;
    const n = nodes.length;
    // Higher `spacing` weakens center gravity and strengthens repulsion, so the
    // whole cloud settles further from the hub.
    const centerPull = 0.012 / this.spacing;
    const repel = 2600 * this.spacing;

    const hubR = this.hub ? this.hub.r : 30;
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      // gravity toward hub
      a.vx += (this.cx - a.x) * centerPull;
      a.vy += (this.cy - a.y) * centerPull;

      // keep a clear orbit around the hub so nodes don't collapse onto it
      let hdx = a.x - this.cx;
      let hdy = a.y - this.cy;
      let hdist = Math.hypot(hdx, hdy);
      if (hdist < 0.01) { hdx = Math.random() - 0.5; hdy = Math.random() - 0.5; hdist = 1; }
      const minOrbit = hubR + a.r + 22 + (this.spacing - 1) * 90;
      if (hdist < minOrbit) {
        const push = (minOrbit - hdist) * 0.35;
        a.vx += (hdx / hdist) * push;
        a.vy += (hdy / hdist) * push;
      }

      for (let j = i + 1; j < n; j++) {
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist2 = dx * dx + dy * dy;
        if (dist2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; dist2 = 1; }
        const minDist = a.r + b.r + 14;
        const dist = Math.sqrt(dist2);
        // repulsion
        let force = repel / dist2;
        // hard collision separation
        if (dist < minDist) force += (minDist - dist) * 0.5;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        if (a !== this._dragNode) { a.vx += fx; a.vy += fy; }
        if (b !== this._dragNode) { b.vx -= fx; b.vy -= fy; }
      }
    }

    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      if (a === this._dragNode) { a.vx = 0; a.vy = 0; continue; }
      a.vx *= 0.82;
      a.vy *= 0.82;
      a.x += a.vx;
      a.y += a.vy;
      if (a.appear < 1) a.appear = Math.min(1, a.appear + 0.06);
    }
  }

  // ---- render ----
  _tick() {
    this._time += 1;
    this._simulate();
    this._draw();
    this._raf = requestAnimationFrame(this._tick);
  }

  _draw() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);

    if (!this.hub) return;

    ctx.save();
    ctx.translate(this.view.x, this.view.y);
    ctx.scale(this.view.scale, this.view.scale);

    // links from hub to each node
    ctx.lineWidth = 1 / this.view.scale;
    for (const n of this.nodes) {
      const isActive = n === this.hovered || n === this.selected;
      const grad = ctx.createLinearGradient(this.hub.x, this.hub.y, n.x, n.y);
      grad.addColorStop(0, hexToRgba(n.color, isActive ? 0.5 : 0.14));
      grad.addColorStop(1, hexToRgba(n.color, isActive ? 0.6 : 0.2));
      ctx.strokeStyle = grad;
      ctx.globalAlpha = n.appear;
      ctx.beginPath();
      ctx.moveTo(this.hub.x, this.hub.y);
      ctx.lineTo(n.x, n.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // nodes
    for (const n of this.nodes) {
      this._drawNode(ctx, n);
    }

    // hub
    this._drawHub(ctx);

    ctx.restore();
  }

  _drawNode(ctx, n) {
    const isSel = n === this.selected;
    const isHov = n === this.hovered;
    const pulse = isSel ? 1 + Math.sin(this._time * 0.08) * 0.04 : 1;
    const r = n.r * n.appear * pulse;

    // glow
    ctx.save();
    ctx.globalAlpha = n.appear;
    const glow = ctx.createRadialGradient(n.x, n.y, r * 0.2, n.x, n.y, r * 2.4);
    glow.addColorStop(0, hexToRgba(n.color, isSel || isHov ? 0.5 : 0.28));
    glow.addColorStop(1, hexToRgba(n.color, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(n.x, n.y, r * 2.4, 0, Math.PI * 2);
    ctx.fill();

    // body
    const body = ctx.createRadialGradient(n.x - r * 0.3, n.y - r * 0.3, r * 0.1, n.x, n.y, r);
    body.addColorStop(0, hexToRgba(n.color, 0.95));
    body.addColorStop(1, hexToRgba(n.color, 0.55));
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fill();

    // ring
    ctx.lineWidth = (isSel ? 2.5 : 1.2) / this.view.scale;
    ctx.strokeStyle = isSel ? '#ffffff' : hexToRgba(n.color, 0.9);
    ctx.stroke();

    // folder indicator ring
    if (n.data.type === 'dir') {
      ctx.lineWidth = 1.4 / this.view.scale;
      ctx.strokeStyle = hexToRgba('#ffffff', 0.35);
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 4, -Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
    }

    // label (only when big enough on screen)
    const screenR = r * this.view.scale;
    if (screenR > 14 || isHov || isSel) {
      const label = this._short(n.data.name, isSel || isHov ? 40 : 16);
      ctx.font = `${12 / this.view.scale}px -apple-system, Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(231,237,251,0.92)';
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 4;
      ctx.fillText(label, n.x, n.y + r + 5 / this.view.scale);
      ctx.shadowBlur = 0;
    }
    ctx.restore();
  }

  _drawHub(ctx) {
    const hub = this.hub;
    const r = hub.r;
    ctx.save();
    const glow = ctx.createRadialGradient(hub.x, hub.y, r * 0.3, hub.x, hub.y, r * 2.6);
    glow.addColorStop(0, 'rgba(120,170,255,0.5)');
    glow.addColorStop(1, 'rgba(120,170,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(hub.x, hub.y, r * 2.6, 0, Math.PI * 2);
    ctx.fill();

    const body = ctx.createRadialGradient(hub.x - r * 0.35, hub.y - r * 0.35, r * 0.1, hub.x, hub.y, r);
    body.addColorStop(0, '#eaf1ff');
    body.addColorStop(0.55, '#7ea6ff');
    body.addColorStop(1, '#2e6bff');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(hub.x, hub.y, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.lineWidth = 2 / this.view.scale;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.stroke();

    ctx.font = `${12.5 / this.view.scale}px -apple-system, Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(231,237,251,0.95)';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 4;
    ctx.fillText(this._short(hub.data.name || 'root', 28), hub.x, hub.y + r + 6 / this.view.scale);
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  _short(str, max) {
    if (!str) return '';
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
  }

  // ---- pointer interaction ----
  _bindPointer() {
    const c = this.canvas;
    let downAt = null;
    let moved = false;

    c.addEventListener('mousedown', (e) => {
      const rect = c.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      downAt = { sx, sy, t: Date.now() };
      moved = false;
      const node = this._nodeAt(sx, sy);
      if (node && node !== this.hub) {
        const w = this._toWorld(sx, sy);
        this._drag = { node, ox: w.x - node.x, oy: w.y - node.y };
        this._dragNode = node;
      } else {
        this._drag = { panning: true, startX: this.view.x, startY: this.view.y, sx, sy };
      }
    });

    window.addEventListener('mousemove', (e) => {
      const rect = c.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      if (this._drag) {
        if (Math.hypot(sx - downAt.sx, sy - downAt.sy) > 3) moved = true;
        if (this._drag.panning) {
          this.view.x = this._drag.startX + (sx - this._drag.sx);
          this.view.y = this._drag.startY + (sy - this._drag.sy);
        } else {
          const w = this._toWorld(sx, sy);
          this._drag.node.x = w.x - this._drag.ox;
          this._drag.node.y = w.y - this._drag.oy;
        }
        return;
      }
      // hover
      const node = this._nodeAt(sx, sy);
      this.hovered = node === this.hub ? null : node;
      c.style.cursor = node ? 'pointer' : 'grab';
    });

    window.addEventListener('mouseup', (e) => {
      if (this._drag && !moved) {
        const rect = c.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const node = this._nodeAt(sx, sy);
        if (node && node !== this.hub) {
          this.selected = node;
          this.onSelect(node.data);
        } else if (node === this.hub) {
          this.selected = null;
          this.onSelect(this.hub.data);
        } else {
          this.selected = null;
          this.onSelect(null);
        }
      }
      this._drag = null;
      this._dragNode = null;
    });

    c.addEventListener('dblclick', (e) => {
      const rect = c.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const node = this._nodeAt(sx, sy);
      if (node && node !== this.hub) {
        if (node.data.type === 'dir') this.onEnter(node.data);
        else if (node.data._group) this.onEnter(node.data); // expand overflow group
      } else if (node === this.hub) {
        this.onEnter({ _up: true });
      }
    });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      this.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, sx, sy);
    }, { passive: false });
  }
}

window.MoonGraph = MoonGraph;
window.CATEGORY_COLORS = CATEGORY_COLORS;
window.CATEGORY_ICONS = CATEGORY_ICONS;
