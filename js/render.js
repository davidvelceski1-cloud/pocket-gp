'use strict';
/* =====================================================================
 * render.js — all canvas drawing.
 *
 * Performance strategy:
 *  - The whole track (ground, scenery, road, curbs, lines) is drawn ONCE
 *    into an offscreen canvas when a race starts. Each frame we only blit
 *    the visible part of it with the camera transform.
 *  - Cars are pre-rendered sprites (with a soft baked shadow).
 *  - Particles live in preallocated typed arrays; nothing is allocated in
 *    the frame loop apart from short HUD strings.
 *
 * Camera: rotates with the player's car so the car always points UP the
 * screen and sits in the lower part of it. On a tall, narrow portrait
 * screen this shows the most road ahead and makes left/right buttons
 * always mean screen-left / screen-right (a fixed north-up camera would
 * make you drive sideways or downwards on a narrow view).
 * ===================================================================== */

const MAX_DPR = 2;           // cap: 2× is already sharp, 3× costs ~2× fill-rate
const CAR_SPRITE_PAD = 9;    // world units around the car for the baked shadow
const MAX_PARTICLES = 220;
const KMH = 0.5;             // world units/s → km/h shown in the HUD

/* ---------- small drawing helpers ---------- */

function roundRectPath(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}

/** Lighten (amt > 0) or darken (amt < 0) a #rrggbb colour. */
function shadeColor(hex, amt) {
  const v = parseInt(hex.slice(1), 16);
  let r = (v >> 16) & 255, gg = (v >> 8) & 255, b = v & 255;
  if (amt >= 0) { r += (255 - r) * amt; gg += (255 - gg) * amt; b += (255 - b) * amt; }
  else { r *= 1 + amt; gg *= 1 + amt; b *= 1 + amt; }
  return 'rgb(' + (r | 0) + ',' + (gg | 0) + ',' + (b | 0) + ')';
}

/** Deterministic random generator (so scenery is the same every time). */
function makeRng(seedStr) {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619); }
  return function () {
    h += 0x6D2B79F5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function formatTime(t) {
  if (!isFinite(t) || t <= 0) return '-:--.--';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
}

function ordinal(n) {
  const s = (n % 100 >= 11 && n % 100 <= 13) ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] || 'th');
  return n + s;
}

/** Car body shape parameters by style. */
const BODY_STYLES = {
  compact: { fw: 17, rw: 18.5, len: 34, r: 6, cabF: -7, cabR: 11, glassF: 5, glassR: 3.5, spoiler: false, stripes: 0 },
  sedan:   { fw: 18, rw: 19,   len: 38, r: 5, cabF: -6, cabR: 10, glassF: 5, glassR: 4, spoiler: false, stripes: 1 },
  sport:   { fw: 15.5, rw: 20, len: 38, r: 5, cabF: -3, cabR: 9, glassF: 5.5, glassR: 3, spoiler: true, stripes: 2 },
  super:   { fw: 12, rw: 21,   len: 39, r: 4, cabF: -1, cabR: 9, glassF: 6, glassR: 2.5, spoiler: true, stripes: 2 },
};

/** Draw a car body centred on (0,0), nose pointing up (-y). */
function drawCarBody(g, def) {
  const st = BODY_STYLES[def.style] || BODY_STYLES.sedan;
  const hl = st.len / 2, fw = st.fw, rw = st.rw, r = st.r;

  // Wheels (peek out from under the body)
  g.fillStyle = '#121212';
  const wy1 = -hl + 6, wy2 = hl - 12;
  g.fillRect(-rw / 2 - 1.2, wy1, 3.5, 7.5); g.fillRect(rw / 2 - 2.3, wy1, 3.5, 7.5);
  g.fillRect(-rw / 2 - 1.5, wy2, 4, 8);     g.fillRect(rw / 2 - 2.5, wy2, 4, 8);

  // Body path (slight wedge from front width to rear width)
  g.beginPath();
  g.moveTo(-fw / 2 + r, -hl);
  g.lineTo(fw / 2 - r, -hl);
  g.quadraticCurveTo(fw / 2, -hl, fw / 2, -hl + r);
  g.lineTo(rw / 2, hl - r);
  g.quadraticCurveTo(rw / 2, hl, rw / 2 - r, hl);
  g.lineTo(-rw / 2 + r, hl);
  g.quadraticCurveTo(-rw / 2, hl, -rw / 2, hl - r);
  g.lineTo(-fw / 2, -hl + r);
  g.quadraticCurveTo(-fw / 2, -hl, -fw / 2 + r, -hl);
  g.closePath();
  const grad = g.createLinearGradient(-rw / 2, 0, rw / 2, 0);
  grad.addColorStop(0, shadeColor(def.color, -0.35));
  grad.addColorStop(0.3, def.color);
  grad.addColorStop(0.55, shadeColor(def.color, 0.18));
  grad.addColorStop(1, shadeColor(def.color, -0.35));
  g.fillStyle = grad;
  g.fill();
  g.lineWidth = 0.8;
  g.strokeStyle = 'rgba(0,0,0,0.45)';
  g.stroke();

  // Racing stripes
  if (st.stripes) {
    g.fillStyle = def.accent;
    if (st.stripes === 1) g.fillRect(-1.2, -hl + 1, 2.4, st.len - 2);
    else { g.fillRect(-3, -hl + 1, 2, st.len - 2); g.fillRect(1, -hl + 1, 2, st.len - 2); }
  }

  // Cabin: windshield, roof, rear window
  const cw = Math.min(fw, rw) - 4;
  g.fillStyle = '#1c2530';
  g.beginPath();
  g.moveTo(-cw / 2 + 1, st.cabF); g.lineTo(cw / 2 - 1, st.cabF);
  g.lineTo(cw / 2, st.cabF + st.glassF); g.lineTo(-cw / 2, st.cabF + st.glassF);
  g.closePath(); g.fill();
  g.fillStyle = 'rgba(160,200,255,0.35)';
  g.fillRect(-cw / 2 + 2, st.cabF + 1, cw * 0.35, 1.2);
  g.fillStyle = shadeColor(def.color, 0.1);
  g.fillRect(-cw / 2 + 0.5, st.cabF + st.glassF, cw - 1, st.cabR - st.cabF - st.glassF - st.glassR);
  if (st.stripes) {
    g.fillStyle = def.accent;
    if (st.stripes === 1) g.fillRect(-1.2, st.cabF + st.glassF, 2.4, st.cabR - st.cabF - st.glassF - st.glassR);
    else {
      g.fillRect(-3, st.cabF + st.glassF, 2, st.cabR - st.cabF - st.glassF - st.glassR);
      g.fillRect(1, st.cabF + st.glassF, 2, st.cabR - st.cabF - st.glassF - st.glassR);
    }
  }
  g.fillStyle = '#1c2530';
  g.fillRect(-cw / 2 + 1, st.cabR - st.glassR, cw - 2, st.glassR);

  // Lights
  g.fillStyle = '#fff6c8';
  g.fillRect(-fw / 2 + 1.5, -hl + 0.6, 3.5, 2);
  g.fillRect(fw / 2 - 5, -hl + 0.6, 3.5, 2);
  g.fillStyle = '#7a1010';
  g.fillRect(-rw / 2 + 1.5, hl - 2.2, 4, 1.8);
  g.fillRect(rw / 2 - 5.5, hl - 2.2, 4, 1.8);

  // Spoiler
  if (st.spoiler) {
    g.fillStyle = shadeColor(def.color, -0.45);
    g.fillRect(-rw / 2 - 0.5, hl - 6, rw + 1, 2.6);
  }
}

/* ===================================================================== */

const Renderer = {
  canvas: null, ctx: null,
  W: 0, H: 0, dpr: 1,
  safe: { top: 0, right: 0, bottom: 0, left: 0 },
  cam: { x: 0, y: 0, angle: 0, zoom: 1 },
  sprites: [],
  spriteScale: 2,
  coneSprite: null,
  bgTrack: null,
  showFps: false,
  fps: 0,
  // particle pool (struct of arrays)
  pX: new Float32Array(MAX_PARTICLES), pY: new Float32Array(MAX_PARTICLES),
  pVX: new Float32Array(MAX_PARTICLES), pVY: new Float32Array(MAX_PARTICLES),
  pLife: new Float32Array(MAX_PARTICLES), pMax: new Float32Array(MAX_PARTICLES),
  pSize: new Float32Array(MAX_PARTICLES), pKind: new Uint8Array(MAX_PARTICLES),
  pNext: 0,

  init(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.safeProbe = document.getElementById('safe-probe');
    this.resize();
  },

  /** Match the canvas to the viewport (CSS px × devicePixelRatio). */
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const W = window.innerWidth, H = window.innerHeight;
    this.W = W; this.H = H;
    if (dpr !== this.dpr) { this.sprites.length = 0; this.coneSprite = null; }
    this.dpr = dpr;
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    this.canvas.style.width = W + 'px';
    this.canvas.style.height = H + 'px';
    this.spriteScale = Math.ceil(dpr * 2);
    // Safe-area insets, measured from a hidden element padded with env(...)
    if (this.safeProbe) {
      const cs = getComputedStyle(this.safeProbe);
      this.safe.top = parseFloat(cs.paddingTop) || 0;
      this.safe.right = parseFloat(cs.paddingRight) || 0;
      this.safe.bottom = parseFloat(cs.paddingBottom) || 0;
      this.safe.left = parseFloat(cs.paddingLeft) || 0;
    }
  },

  /* ---------------- pre-rendering ---------------- */

  getCarSprite(idx) {
    let s = this.sprites[idx];
    if (s) return s;
    const sc = this.spriteScale;
    const w = CAR_WIDTH + 2 + CAR_SPRITE_PAD * 2, h = CAR_LENGTH + 2 + CAR_SPRITE_PAD * 2;
    s = document.createElement('canvas');
    s.width = Math.ceil(w * sc); s.height = Math.ceil(h * sc);
    const g = s.getContext('2d');
    g.setTransform(sc, 0, 0, sc, (w / 2) * sc, (h / 2) * sc);
    // soft ambient shadow (orientation independent)
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.55)';
    g.shadowBlur = 5 * sc;
    g.shadowOffsetY = 1.5 * sc;
    g.fillStyle = 'rgba(0,0,0,0.6)';
    roundRectPath(g, -CAR_WIDTH / 2 + 1, -CAR_LENGTH / 2 + 1, CAR_WIDTH - 2, CAR_LENGTH - 2, 6);
    g.fill();
    g.restore();
    drawCarBody(g, CARS[idx]);
    s.worldW = w; s.worldH = h;
    this.sprites[idx] = s;
    return s;
  },

  getConeSprite() {
    if (this.coneSprite) return this.coneSprite;
    const c = document.createElement('canvas');
    c.width = 128; c.height = 256;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 256, 0, 0);
    grad.addColorStop(0, 'rgba(255,240,190,0.32)');
    grad.addColorStop(1, 'rgba(255,240,190,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(54, 256); g.lineTo(74, 256); g.lineTo(128, 0); g.lineTo(0, 0);
    g.closePath(); g.fill();
    this.coneSprite = c;
    return c;
  },

  /** Free the previous track's big background canvas (mobile memory). */
  releaseTrack(track) {
    if (track && track.bg) { track.bg.width = 0; track.bg.height = 0; track.bg = null; }
  },

  /** Render the static background of a track once. */
  prepareTrack(track) {
    if (this.bgTrack && this.bgTrack !== track) this.releaseTrack(this.bgTrack);
    this.bgTrack = track;
    if (!track.mini) this.prepareMinimap(track);
    if (track.bg) return;

    const th = THEMES[track.theme];
    const M = 330;
    const x0 = track.minX - M, y0 = track.minY - M;
    const w = track.maxX - track.minX + 2 * M, h = track.maxY - track.minY + 2 * M;
    // Resolution: up to 1.5 px per world unit, max 4096 px per side, ~11 Mpx total.
    const S = Math.min(1.5, 4096 / w, 4096 / h, Math.sqrt(11e6 / (w * h)));
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * S); c.height = Math.ceil(h * S);
    const g = c.getContext('2d', { alpha: false });
    g.setTransform(S, 0, 0, S, -x0 * S, -y0 * S);
    const rng = makeRng(track.id);
    const xs = track.xs, ys = track.ys, n = track.n, hw = track.halfWidth;

    // Ground + soft patches
    g.fillStyle = th.ground;
    g.fillRect(x0, y0, w, h);
    g.fillStyle = th.patch;
    const patches = (w * h / 45000) | 0;
    for (let i = 0; i < patches; i++) {
      g.globalAlpha = 0.35 + rng() * 0.4;
      g.beginPath();
      g.arc(x0 + rng() * w, y0 + rng() * h, 20 + rng() * 90, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;

    const tracePath = (ofs) => {
      g.beginPath();
      for (let i = 0; i <= n; i++) {
        const k = i % n;
        const px = xs[k] + track.nx[k] * ofs, py = ys[k] + track.ny[k] * ofs;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath();
    };
    g.lineJoin = 'round'; g.lineCap = 'round';

    // Run-off area (gravel / sand / snow banks)
    tracePath(0);
    g.strokeStyle = th.runoff;
    g.lineWidth = track.width + 80;
    g.stroke();

    // Curbs: full stroke in colour A, dashed stroke in colour B on top
    g.lineWidth = track.width + 18;
    g.strokeStyle = th.curbA;
    g.stroke();
    g.setLineDash([22, 22]);
    g.strokeStyle = th.curbB;
    g.stroke();
    g.setLineDash([]);

    // Asphalt
    g.lineWidth = track.width;
    g.strokeStyle = th.road;
    g.stroke();
    // subtle asphalt texture
    g.fillStyle = 'rgba(0,0,0,0.12)';
    for (let i = 0; i < n * 3; i++) {
      const k = (rng() * n) | 0, o = (rng() * 2 - 1) * (hw - 6);
      g.fillRect(xs[k] + track.nx[k] * o, ys[k] + track.ny[k] * o, 3, 3);
    }

    // Edge lines
    g.lineWidth = 3;
    g.strokeStyle = th.edge;
    tracePath(hw - 6); g.stroke();
    tracePath(-(hw - 6)); g.stroke();

    // Centre dashes
    tracePath(0);
    g.setLineDash([28, 36]);
    g.lineWidth = 3;
    g.strokeStyle = th.line;
    g.stroke();
    g.setLineDash([]);

    // Start / finish: checkered band across the road at sample 0
    {
      g.save();
      g.translate(xs[0], ys[0]);
      g.rotate(Math.atan2(track.ty[0], track.tx[0]));
      const q = 10, cols = Math.ceil(track.width / q);
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < cols; col++) {
          g.fillStyle = ((row + col) & 1) ? '#111' : '#fff';
          g.fillRect(-q + row * q, -hw + col * q, q, Math.min(q, track.width - col * q));
        }
      }
      g.restore();
    }

    // Grid boxes
    g.strokeStyle = 'rgba(255,255,255,0.75)';
    g.lineWidth = 2.5;
    for (let k = 0; k < GRID_SIZE; k++) {
      const s = gridSlot(track, k);
      g.save();
      g.translate(s.x, s.y);
      g.rotate(s.angle);
      g.beginPath();
      g.moveTo(-13, -26); g.lineTo(13, -26);
      g.moveTo(-13, -26); g.lineTo(-13, -14);
      g.moveTo(13, -26); g.lineTo(13, -14);
      g.stroke();
      g.restore();
    }

    // Street lamps for night tracks (glow drawn additively)
    if (th.lamps) {
      g.globalCompositeOperation = 'lighter';
      const step = Math.round(240 / track.sp);
      for (let i = 0, side = 1; i < n; i += step, side = -side) {
        const lx = xs[i] + track.nx[i] * side * (hw + 34), ly = ys[i] + track.ny[i] * side * (hw + 34);
        const gr = g.createRadialGradient(lx, ly, 4, lx, ly, 150);
        gr.addColorStop(0, 'rgba(255,214,140,0.45)');
        gr.addColorStop(1, 'rgba(255,214,140,0)');
        g.fillStyle = gr;
        g.fillRect(lx - 150, ly - 150, 300, 300);
      }
      g.globalCompositeOperation = 'source-over';
      for (let i = 0, side = 1; i < n; i += step, side = -side) {
        const lx = xs[i] + track.nx[i] * side * (hw + 34), ly = ys[i] + track.ny[i] * side * (hw + 34);
        g.fillStyle = '#20262f'; g.beginPath(); g.arc(lx, ly, 6, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#ffe6a8'; g.beginPath(); g.arc(lx, ly, 3, 0, Math.PI * 2); g.fill();
      }
    }

    // Scenery props, kept clear of the road
    const props = th.props;
    const count = ((w * h) / 70000 * th.density) | 0;
    const minDistSq = (r) => { const d = hw + 70 + r; return d * d; };
    for (let i = 0; i < count; i++) {
      const px = x0 + rng() * w, py = y0 + rng() * h;
      const kind = props[(rng() * props.length) | 0];
      const size = kind === 'building' ? 40 + rng() * 40 : 12 + rng() * 14;
      const need = minDistSq(size);
      let ok = true;
      for (let k = 0; k < n; k += 3) {
        const dx = px - xs[k], dy = py - ys[k];
        if (dx * dx + dy * dy < need) { ok = false; break; }
      }
      if (!ok) continue;
      this.drawProp(g, kind, px, py, size, rng, th);
    }

    track.bg = c;
    track.bgX = x0; track.bgY = y0; track.bgScale = S;
  },

  drawProp(g, kind, x, y, s, rng, th) {
    switch (kind) {
      case 'tree':
      case 'bush': {
        const r = kind === 'bush' ? s * 0.6 : s;
        g.fillStyle = 'rgba(0,0,0,0.25)';
        g.beginPath(); g.arc(x + 4, y + 5, r, 0, Math.PI * 2); g.fill();
        g.fillStyle = th === THEMES.night ? '#14321c' : '#2c6a24';
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
        g.fillStyle = th === THEMES.night ? '#1d4527' : '#3f8a33';
        g.beginPath(); g.arc(x - r * 0.25, y - r * 0.25, r * 0.6, 0, Math.PI * 2); g.fill();
        break;
      }
      case 'pine': {
        g.fillStyle = 'rgba(0,0,0,0.2)';
        g.beginPath(); g.arc(x + 4, y + 5, s, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#245a3a';
        g.beginPath();
        for (let i = 0; i < 16; i++) {
          const a = i / 16 * Math.PI * 2, rr = (i & 1) ? s * 0.6 : s;
          if (i === 0) g.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
          else g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
        }
        g.closePath(); g.fill();
        g.fillStyle = 'rgba(255,255,255,0.85)';
        g.beginPath(); g.arc(x - s * 0.15, y - s * 0.15, s * 0.35, 0, Math.PI * 2); g.fill();
        break;
      }
      case 'cactus': {
        g.fillStyle = 'rgba(0,0,0,0.2)';
        g.beginPath(); g.arc(x + 3, y + 4, s * 0.6, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#4f8a3a';
        g.beginPath(); g.arc(x, y, s * 0.55, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#3a6b2a'; g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(x - s * 0.55, y); g.lineTo(x + s * 0.55, y);
        g.moveTo(x, y - s * 0.55); g.lineTo(x, y + s * 0.55);
        g.stroke();
        break;
      }
      case 'rock': {
        g.fillStyle = 'rgba(0,0,0,0.2)';
        g.beginPath(); g.ellipse(x + 3, y + 4, s * 0.8, s * 0.6, 0.4, 0, Math.PI * 2); g.fill();
        g.fillStyle = th === THEMES.snow ? '#8f9aa8' : '#9b8f80';
        g.beginPath(); g.ellipse(x, y, s * 0.8, s * 0.6, 0.4, 0, Math.PI * 2); g.fill();
        g.fillStyle = 'rgba(255,255,255,0.2)';
        g.beginPath(); g.ellipse(x - s * 0.2, y - s * 0.15, s * 0.4, s * 0.25, 0.4, 0, Math.PI * 2); g.fill();
        break;
      }
      case 'palm': {
        g.fillStyle = 'rgba(0,0,0,0.18)';
        g.beginPath(); g.arc(x + 5, y + 6, s, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#3d9a3a'; g.lineWidth = 4; g.lineCap = 'round';
        g.beginPath();
        const a0 = rng() * Math.PI;
        for (let i = 0; i < 6; i++) {
          const a = a0 + i / 6 * Math.PI * 2;
          g.moveTo(x, y); g.lineTo(x + Math.cos(a) * s, y + Math.sin(a) * s);
        }
        g.stroke();
        g.fillStyle = '#7a5a32';
        g.beginPath(); g.arc(x, y, 3.5, 0, Math.PI * 2); g.fill();
        break;
      }
      case 'building': {
        const bw = s, bh = s * (0.7 + rng() * 0.6);
        const night = th === THEMES.night;
        g.fillStyle = 'rgba(0,0,0,0.3)';
        g.fillRect(x - bw / 2 + 8, y - bh / 2 + 10, bw, bh);
        const shades = night ? ['#252b38', '#2b3242', '#1f2430'] : ['#a7adb5', '#bcc2c9', '#8f969f', '#c9b9a6'];
        g.fillStyle = shades[(rng() * shades.length) | 0];
        g.fillRect(x - bw / 2, y - bh / 2, bw, bh);
        g.fillStyle = night ? '#1a1f29' : 'rgba(0,0,0,0.12)';
        g.fillRect(x - bw / 2 + 5, y - bh / 2 + 5, bw - 10, bh - 10);
        if (night) {
          // lit windows / roof lights
          for (let i = 0; i < 6; i++) {
            g.fillStyle = rng() < 0.5 ? '#ffd27a' : '#6fd3ff';
            g.fillRect(x - bw / 2 + 8 + rng() * (bw - 20), y - bh / 2 + 8 + rng() * (bh - 20), 4, 4);
          }
        } else {
          g.fillStyle = '#6d747d';
          g.fillRect(x - 6, y - 6, 12, 12);
        }
        break;
      }
    }
  },

  /** Small north-up map of the track for the HUD. */
  prepareMinimap(track) {
    const size = 92;
    const c = document.createElement('canvas');
    const d = this.dpr;
    c.width = c.height = Math.ceil(size * d);
    const g = c.getContext('2d');
    const pad = 9;
    const w = track.maxX - track.minX, h = track.maxY - track.minY;
    const s = (size - pad * 2) / Math.max(w, h);
    const ox = pad + ((size - pad * 2) - w * s) / 2, oy = pad + ((size - pad * 2) - h * s) / 2;
    g.scale(d, d);
    g.fillStyle = 'rgba(10,14,20,0.55)';
    roundRectPath(g, 0, 0, size, size, 12); g.fill();
    g.beginPath();
    for (let i = 0; i <= track.n; i += 4) {
      const k = i % track.n;
      const x = ox + (track.xs[k] - track.minX) * s, y = oy + (track.ys[k] - track.minY) * s;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineWidth = 3.5;
    g.stroke();
    // finish marker
    g.fillStyle = '#ff3b3b';
    g.fillRect(ox + (track.xs[0] - track.minX) * s - 2.5, oy + (track.ys[0] - track.minY) * s - 2.5, 5, 5);
    track.mini = { canvas: c, size, s, ox, oy };
  },

  /* ---------------- previews for the selection screens ---------------- */

  drawCarPreview(canvas, idx) {
    const r = canvas.getBoundingClientRect();
    const d = this.dpr;
    canvas.width = Math.max(1, Math.round(r.width * d));
    canvas.height = Math.max(1, Math.round(r.height * d));
    const g = canvas.getContext('2d');
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, r.width, r.height);
    const spr = this.getCarSprite(idx);
    // Fit the car itself (not the sprite's shadow padding) into the canvas.
    const scale = Math.min(r.width / (CAR_LENGTH + 8), r.height / (CAR_WIDTH + 8));
    g.translate(r.width / 2, r.height / 2);
    g.rotate(Math.PI / 2); // nose to the right
    g.scale(scale, scale);
    g.drawImage(spr, -spr.worldW / 2, -spr.worldH / 2, spr.worldW, spr.worldH);
  },

  drawTrackPreview(canvas, track) {
    const r = canvas.getBoundingClientRect();
    const d = this.dpr;
    canvas.width = Math.max(1, Math.round(r.width * d));
    canvas.height = Math.max(1, Math.round(r.height * d));
    const g = canvas.getContext('2d');
    const th = THEMES[track.theme];
    g.setTransform(d, 0, 0, d, 0, 0);
    g.fillStyle = th.ground;
    g.fillRect(0, 0, r.width, r.height);
    const pad = 12;
    const w = track.maxX - track.minX, h = track.maxY - track.minY;
    const s = Math.min((r.width - pad * 2) / w, (r.height - pad * 2) / h);
    const ox = (r.width - w * s) / 2, oy = (r.height - h * s) / 2;
    g.beginPath();
    for (let i = 0; i <= track.n; i += 3) {
      const k = i % track.n;
      const x = ox + (track.xs[k] - track.minX) * s, y = oy + (track.ys[k] - track.minY) * s;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
    g.lineJoin = 'round';
    g.strokeStyle = th.curbA; g.lineWidth = Math.max(4, track.width * s + 3); g.stroke();
    g.strokeStyle = th.road; g.lineWidth = Math.max(3, track.width * s); g.stroke();
    // start line
    const sx = ox + (track.xs[0] - track.minX) * s, sy = oy + (track.ys[0] - track.minY) * s;
    g.save();
    g.translate(sx, sy);
    g.rotate(Math.atan2(track.ty[0], track.tx[0]));
    g.fillStyle = '#fff';
    const lw = Math.max(5, track.width * s + 2);
    g.fillRect(-1.5, -lw / 2, 3, lw);
    g.restore();
    // direction arrow
    const k = Math.round(track.n * 0.04);
    const ax = ox + (track.xs[k] - track.minX) * s, ay = oy + (track.ys[k] - track.minY) * s;
    g.save();
    g.translate(ax, ay);
    g.rotate(Math.atan2(track.ty[k], track.tx[k]));
    g.fillStyle = '#fff';
    g.beginPath(); g.moveTo(5, 0); g.lineTo(-3, -4); g.lineTo(-3, 4); g.closePath(); g.fill();
    g.restore();
  },

  /* ---------------- particles ---------------- */

  spawn(x, y, vx, vy, life, size, kind) {
    const i = this.pNext;
    this.pNext = (i + 1) % MAX_PARTICLES;
    this.pX[i] = x; this.pY[i] = y; this.pVX[i] = vx; this.pVY[i] = vy;
    this.pLife[i] = life; this.pMax[i] = life; this.pSize[i] = size; this.pKind[i] = kind;
  },

  /** Emit dust (off-road) and tyre smoke (sliding). Called once per physics step. */
  emitParticles(race) {
    const cars = race.cars;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      const spd = c.speed;
      const slide = c.slip < 0 ? -c.slip : c.slip;
      if (c.offTrack && spd > 50 && Math.random() < 0.5) {
        const side = Math.random() < 0.5 ? -7 : 7;
        const rx = c.x - c.sn * 16 + c.cs * side, ry = c.y + c.cs * 16 + c.sn * side;
        this.spawn(rx, ry, -c.vx * 0.15 + (Math.random() - 0.5) * 40, -c.vy * 0.15 + (Math.random() - 0.5) * 40,
          0.6 + Math.random() * 0.4, 6 + Math.random() * 6, 0);
      } else if (!c.offTrack && slide > 70 && spd > 80 && Math.random() < 0.6) {
        const side = Math.random() < 0.5 ? -8 : 8;
        const rx = c.x - c.sn * 14 + c.cs * side, ry = c.y + c.cs * 14 + c.sn * side;
        this.spawn(rx, ry, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, 0.5 + Math.random() * 0.3,
          5 + Math.random() * 4, 1);
      }
    }
  },

  updateParticles(dt) {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.pLife[i] <= 0) continue;
      this.pLife[i] -= dt;
      this.pX[i] += this.pVX[i] * dt; this.pY[i] += this.pVY[i] * dt;
      this.pVX[i] *= 0.96; this.pVY[i] *= 0.96;
    }
  },

  clearParticles() { this.pLife.fill(0); },

  /* ---------------- main frame ---------------- */

  /**
   * Draw one frame. alpha = interpolation between the previous and the
   * current physics step (0..1). frameDt is real time since last frame.
   */
  drawFrame(race, alpha, frameDt, game) {
    const ctx = this.ctx, track = race.track;
    if (!track || !track.bg) return;
    const W = this.W, H = this.H, d = this.dpr;
    const th = THEMES[track.theme];
    const cam = this.cam;
    const cars = race.cars;

    // --- Camera follows the (interpolated) focus car.
    const f = race.focus;
    const fx = f.px + (f.x - f.px) * alpha, fy = f.py + (f.y - f.py) * alpha;
    let da = f.angle - f.pa;
    if (da > Math.PI) da -= Math.PI * 2; else if (da < -Math.PI) da += Math.PI * 2;
    const fa = f.pa + da * alpha;
    if (game.snapCamera) {
      cam.x = fx; cam.y = fy; cam.angle = fa; game.snapCamera = false;
      cam.zoom = Math.min(W, 520) / 360;
    }
    cam.x = fx; cam.y = fy;
    let ca = fa - cam.angle;
    if (ca > Math.PI) ca -= Math.PI * 2; else if (ca < -Math.PI) ca += Math.PI * 2;
    cam.angle += ca * (1 - Math.exp(-7 * frameDt));
    const spd = f.speed > 0 ? f.speed : 0;
    const targetZoom = Math.min(W, 520) / (340 + spd * 0.32);
    cam.zoom += (targetZoom - cam.zoom) * (1 - Math.exp(-2.5 * frameDt));
    const z = cam.zoom;
    const anchorY = H * 0.64;

    // --- World
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.fillStyle = th.ground;
    ctx.fillRect(0, 0, W, H);
    ctx.translate(W / 2, anchorY);
    ctx.rotate(-cam.angle);
    ctx.scale(z, z);
    ctx.translate(-cam.x, -cam.y);

    // Blit only the visible part of the pre-rendered track.
    const R = Math.sqrt((W / 2) * (W / 2) + Math.max(anchorY, H - anchorY) * Math.max(anchorY, H - anchorY)) / z + 4;
    const bg = track.bg, S = track.bgScale;
    const bx0 = track.bgX, by0 = track.bgY, bx1 = bx0 + bg.width / S, by1 = by0 + bg.height / S;
    const sx0 = Math.max(bx0, cam.x - R), sy0 = Math.max(by0, cam.y - R);
    const sx1 = Math.min(bx1, cam.x + R), sy1 = Math.min(by1, cam.y + R);
    if (sx1 > sx0 && sy1 > sy0) {
      ctx.drawImage(bg, (sx0 - bx0) * S, (sy0 - by0) * S, (sx1 - sx0) * S, (sy1 - sy0) * S,
        sx0, sy0, sx1 - sx0, sy1 - sy0);
    }

    // Particles
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const life = this.pLife[i];
      if (life <= 0) continue;
      const t = life / this.pMax[i];
      ctx.globalAlpha = t * (this.pKind[i] === 0 ? 0.55 : 0.4);
      ctx.fillStyle = this.pKind[i] === 0 ? th.dust : '#d8d8d8';
      const sz = this.pSize[i] * (1.8 - t);
      ctx.beginPath();
      ctx.arc(this.pX[i], this.pY[i], sz, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Headlight cones at night
    if (th.headlights) {
      const cone = this.getConeSprite();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < cars.length; i++) {
        const c = cars[i];
        const x = c.px + (c.x - c.px) * alpha, y = c.py + (c.y - c.py) * alpha;
        if (Math.abs(x - cam.x) > R + 200 || Math.abs(y - cam.y) > R + 200) continue;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(c.angle);
        ctx.drawImage(cone, -60, -CAR_LENGTH / 2 - 190, 120, 190);
        ctx.restore();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // Cars
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      const x = c.px + (c.x - c.px) * alpha, y = c.py + (c.y - c.py) * alpha;
      if (Math.abs(x - cam.x) > R + 40 || Math.abs(y - cam.y) > R + 40) continue;
      let a = c.angle - c.pa;
      if (a > Math.PI) a -= Math.PI * 2; else if (a < -Math.PI) a += Math.PI * 2;
      a = c.pa + a * alpha;
      const spr = this.getCarSprite(c.carIndex);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a);
      ctx.drawImage(spr, -spr.worldW / 2, -spr.worldH / 2, spr.worldW, spr.worldH);
      if (c.brake > 0.05) {
        const st = BODY_STYLES[CARS[c.carIndex].style];
        const hl = st.len / 2;
        ctx.fillStyle = 'rgba(255,40,40,0.35)';
        ctx.fillRect(-st.rw / 2 - 1, hl - 3, st.rw + 2, 6);
        ctx.fillStyle = '#ff3a3a';
        ctx.fillRect(-st.rw / 2 + 1.5, hl - 2.4, 4, 2.2);
        ctx.fillRect(st.rw / 2 - 5.5, hl - 2.4, 4, 2.2);
      }
      ctx.restore();
    }

    // --- Screen-space overlays
    ctx.setTransform(d, 0, 0, d, 0, 0);
    if (game.state !== 'menu') this.drawHUD(race, game);
    if (this.showFps) {
      ctx.font = '600 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      const fy0 = game.state === 'menu' ? this.safe.top + 6 : this.safe.top + 74;
      ctx.fillRect(this.safe.left + 10, fy0, 58, 20);
      ctx.fillStyle = this.fps >= 55 ? '#7CFC7C' : this.fps >= 40 ? '#ffd23f' : '#ff5c5c';
      ctx.fillText(this.fps + ' FPS', this.safe.left + 16, fy0 + 14);
    }
  },

  drawHUD(race, game) {
    const ctx = this.ctx, W = this.W, H = this.H, s = this.safe;
    const p = race.player;
    if (!p) return;
    const FONT = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';

    // Top panel (leaves room for the pause button on the right)
    const x = 10 + s.left, y = 8 + s.top;
    const w = W - x - s.right - 10 - 58, h = 58;
    ctx.fillStyle = 'rgba(10,14,20,0.62)';
    roundRectPath(ctx, x, y, w, h, 12);
    ctx.fill();

    const c1 = x + 12, c2 = x + w * 0.25, c3 = x + w * 0.46, c4 = x + w - 12;
    ctx.textAlign = 'left';
    ctx.font = '700 10px ' + FONT;
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText('POS', c1, y + 16);
    ctx.fillText('LAP', c2, y + 16);
    ctx.fillText('TIME', c3, y + 16);
    ctx.textAlign = 'right';
    ctx.fillText('KM/H', c4, y + 16);

    const laps = race.laps;
    const lapShown = p.finished ? laps : Math.max(1, Math.min(p.lap, laps));
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.font = '800 24px ' + FONT;
    ctx.fillText(p.position + '/' + race.cars.length, c1, y + 42);
    ctx.font = '800 20px ' + FONT;
    ctx.fillText(lapShown + '/' + laps, c2, y + 41);
    const lapTime = p.finished ? p.finishTime : race.time - p.lapStart;
    ctx.font = '700 17px ' + FONT;
    ctx.fillText(formatTime(game.state === 'countdown' ? 0.0001 : lapTime), c3, y + 36);
    ctx.font = '600 10px ' + FONT;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText('BEST ' + formatTime(p.bestLap), c3, y + 51);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#fff';
    ctx.font = '800 24px ' + FONT;
    ctx.fillText('' + Math.round(Math.max(0, p.speed) * KMH), c4, y + 42);

    // Speed bar along the bottom of the panel
    const frac = Math.max(0, Math.min(1, p.speed / p.stats.topSpeed));
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x + 12, y + h - 4, w - 24, 2);
    ctx.fillStyle = p.offTrack ? '#ffb020' : '#ff4d3d';
    ctx.fillRect(x + 12, y + h - 4, (w - 24) * frac, 2);

    // Minimap
    const mm = race.track.mini;
    if (mm) {
      const mx = W - s.right - 10 - mm.size, my = y + h + 8;
      ctx.drawImage(mm.canvas, mx, my, mm.size, mm.size);
      const tr = race.track;
      for (let i = race.cars.length - 1; i >= 0; i--) {
        const c = race.cars[i];
        const px = mx + mm.ox + (c.x - tr.minX) * mm.s, py = my + mm.oy + (c.y - tr.minY) * mm.s;
        ctx.fillStyle = c.isPlayer ? '#fff' : CARS[c.carIndex].color;
        ctx.beginPath();
        ctx.arc(px, py, c.isPlayer ? 4.5 : 3, 0, Math.PI * 2);
        ctx.fill();
        if (c.isPlayer) { ctx.strokeStyle = '#ff3b3b'; ctx.lineWidth = 2; ctx.stroke(); }
      }
    }

    ctx.textAlign = 'center';
    // Countdown
    if (game.state === 'countdown' && game.countdown <= 3) {
      const num = Math.ceil(game.countdown);
      const frac2 = num - game.countdown; // 0..1 within the second
      const size = 110 + 50 * (1 - frac2);
      ctx.globalAlpha = Math.min(1, 0.4 + (1 - frac2));
      ctx.font = '900 ' + (size | 0) + 'px ' + FONT;
      ctx.lineWidth = 8;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeText('' + num, W / 2, H * 0.4);
      ctx.fillStyle = num === 1 ? '#ffd23f' : '#fff';
      ctx.fillText('' + num, W / 2, H * 0.4);
      ctx.globalAlpha = 1;
    } else if (game.goTimer > 0) {
      ctx.globalAlpha = Math.min(1, game.goTimer * 2);
      ctx.font = '900 120px ' + FONT;
      ctx.lineWidth = 8;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeText('GO!', W / 2, H * 0.4);
      ctx.fillStyle = '#4dff7a';
      ctx.fillText('GO!', W / 2, H * 0.4);
      ctx.globalAlpha = 1;
    }

    // Banner (lap / best lap / finish)
    if (game.bannerTimer > 0 && game.banner) {
      ctx.globalAlpha = Math.min(1, game.bannerTimer * 2);
      ctx.font = '900 30px ' + FONT;
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.strokeText(game.banner, W / 2, H * 0.3);
      ctx.fillStyle = game.bannerColor || '#fff';
      ctx.fillText(game.banner, W / 2, H * 0.3);
      if (game.banner2) {
        ctx.font = '700 18px ' + FONT;
        ctx.lineWidth = 4;
        ctx.strokeText(game.banner2, W / 2, H * 0.3 + 30);
        ctx.fillStyle = '#fff';
        ctx.fillText(game.banner2, W / 2, H * 0.3 + 30);
      }
      ctx.globalAlpha = 1;
    }

    // Wrong way / off-road hints
    if (p.wrongWay > 1 && !p.finished) {
      ctx.font = '900 28px ' + FONT;
      ctx.fillStyle = 'rgba(200,20,20,0.85)';
      roundRectPath(ctx, W / 2 - 110, H * 0.47 - 30, 220, 44, 10);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText('WRONG WAY', W / 2, H * 0.47 + 2);
    }
    ctx.textAlign = 'left';
  },
};
