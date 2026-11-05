'use strict';
/* =====================================================================
 * input.js — touch controls (multi-touch) + keyboard fallback.
 *
 * Touch: Pointer Events on the controls layer. Every active pointer is
 * hit-tested against the (slightly enlarged) button rectangles, so you can
 * steer and brake at the same time and slide a thumb from ◀ to ▶.
 * Keyboard (desktop testing): ←/→ or A/D steer, Space/↓/S brake, P/Esc pause.
 *
 * Output (read by main.js every physics step):
 *   Input.steer  -1..1 (smoothed)
 *   Input.brake   0..1 (progressive while held)
 * ===================================================================== */

const Input = {
  steer: 0,
  brake: 0,
  touchL: false, touchR: false, touchB: false,
  keyL: false, keyR: false, keyB: false,
  pointers: {},          // pointerId -> {x, y}
  els: null,
  rects: { l: null, r: null, b: null },
  onPause: null,         // set by main.js

  init() {
    this.els = {
      layer: document.getElementById('controls'),
      l: document.getElementById('btn-left'),
      r: document.getElementById('btn-right'),
      b: document.getElementById('btn-brake'),
    };
    const layer = this.els.layer;

    // Block default touch behaviour (scroll, zoom, callout) on the controls.
    const block = (e) => { e.preventDefault(); };
    layer.addEventListener('touchstart', block, { passive: false });
    layer.addEventListener('touchmove', block, { passive: false });
    layer.addEventListener('touchend', block, { passive: false });

    layer.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      this.recompute();
    });
    window.addEventListener('pointermove', (e) => {
      const p = this.pointers[e.pointerId];
      if (!p) return;
      p.x = e.clientX; p.y = e.clientY;
      this.recompute();
    });
    const up = (e) => {
      if (!this.pointers[e.pointerId]) return;
      delete this.pointers[e.pointerId];
      this.recompute();
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);

    window.addEventListener('keydown', (e) => this.key(e, true));
    window.addEventListener('keyup', (e) => this.key(e, false));
    window.addEventListener('blur', () => this.reset());
    this.measure();
  },

  key(e, down) {
    switch (e.code) {
      case 'ArrowLeft': case 'KeyA': this.keyL = down; break;
      case 'ArrowRight': case 'KeyD': this.keyR = down; break;
      case 'Space': case 'ArrowDown': case 'KeyS': this.keyB = down; break;
      case 'Escape': case 'KeyP': if (down && this.onPause) this.onPause(); break;
      default: return;
    }
    e.preventDefault();
  },

  /** Cache button rectangles (call on resize / when controls appear). */
  measure() {
    const grow = (el, px) => {
      const r = el.getBoundingClientRect();
      return { x0: r.left - px, y0: r.top - px, x1: r.right + px, y1: r.bottom + px, cx: (r.left + r.right) / 2 };
    };
    this.rects.l = grow(this.els.l, 14);
    this.rects.r = grow(this.els.r, 14);
    this.rects.b = grow(this.els.b, 18);
  },

  recompute() {
    let l = false, r = false, b = false;
    const R = this.rects;
    for (const id in this.pointers) {
      const p = this.pointers[id];
      const inL = p.x >= R.l.x0 && p.x <= R.l.x1 && p.y >= R.l.y0 && p.y <= R.l.y1;
      const inR = p.x >= R.r.x0 && p.x <= R.r.x1 && p.y >= R.r.y0 && p.y <= R.r.y1;
      if (inL && inR) { // overlap of the enlarged areas: pick the closer button
        if (Math.abs(p.x - R.l.cx) < Math.abs(p.x - R.r.cx)) l = true; else r = true;
      } else if (inL) l = true;
      else if (inR) r = true;
      if (p.x >= R.b.x0 && p.x <= R.b.x1 && p.y >= R.b.y0 && p.y <= R.b.y1) b = true;
    }
    if (l !== this.touchL) { this.touchL = l; this.els.l.classList.toggle('pressed', l); }
    if (r !== this.touchR) { this.touchR = r; this.els.r.classList.toggle('pressed', r); }
    if (b !== this.touchB) { this.touchB = b; this.els.b.classList.toggle('pressed', b); }
  },

  /** Smooth the raw button state into steer/brake values. Called each physics step. */
  update(dt) {
    const left = this.touchL || this.keyL, right = this.touchR || this.keyR;
    const target = (right ? 1 : 0) - (left ? 1 : 0);
    // Quick to respond, quicker to centre.
    const rate = target === 0 ? 10 : (target * this.steer < 0 ? 14 : 7);
    if (this.steer < target) this.steer = Math.min(target, this.steer + rate * dt);
    else if (this.steer > target) this.steer = Math.max(target, this.steer - rate * dt);

    // Progressive brake: 35% instantly, ramps to 100% over ~0.4 s, releases at once.
    if (this.touchB || this.keyB) this.brake = this.brake < 0.35 ? 0.35 : Math.min(1, this.brake + dt * 1.6);
    else this.brake = 0;
  },

  reset() {
    this.pointers = {};
    this.keyL = this.keyR = this.keyB = false;
    this.steer = 0; this.brake = 0;
    if (this.els) this.recompute();
  },
};
