'use strict';
/* =====================================================================
 * tracks.js — track data (easy to edit) + geometry builder.
 *
 * Each track is a CLOSED loop. Define it with either:
 *   points:  [[x,y], ...]  control points in map units, in driving order
 *   corners: [[x,y], ...]  corner positions of a "street" circuit; each
 *                          corner is rounded with `cornerRadius` (map units)
 * Map units are multiplied by `scale` (default 10) to get world units.
 * A car is ~38 world units long; `width` is the road width in world units.
 *
 * The builder smooths control points with a centripetal Catmull-Rom spline,
 * resamples it every TRACK_SPACING world units and derives tangents,
 * normals, curvature, road edges, the start/finish line (placed on the
 * longest straight automatically) and the lap checkpoints.
 *
 * Keep non-adjacent parts of a track at least ~25 map units apart so the
 * roads don't overlap.
 * ===================================================================== */

const TRACK_SPACING = 8; // world units between centre-line samples

/* Visual themes. `props` are scenery types scattered off the road. */
const THEMES = {
  grass:  { label: 'Grass',  ground: '#4e9a3c', patch: '#5aa846', runoff: '#c8b27c', road: '#4d5057', curbA: '#d93a2f', curbB: '#f5f5f5', edge: '#f2f2f2', line: 'rgba(255,255,255,0.55)', dust: '#8b6f3e', props: ['tree', 'tree', 'bush'], density: 1.0 },
  desert: { label: 'Desert', ground: '#d9b26f', patch: '#cfa35e', runoff: '#ead09a', road: '#6b6058', curbA: '#c2412d', curbB: '#f3e6c8', edge: '#f3e6c8', line: 'rgba(255,240,200,0.55)', dust: '#c79a55', props: ['cactus', 'rock', 'rock'], density: 0.6 },
  snow:   { label: 'Snow',   ground: '#e6edf5', patch: '#d3deeb', runoff: '#c1cfdf', road: '#59616f', curbA: '#2f6fd1', curbB: '#ffffff', edge: '#ffffff', line: 'rgba(255,255,255,0.7)',  dust: '#ffffff', props: ['pine', 'pine', 'rock'], density: 0.9 },
  night:  { label: 'Night',  ground: '#141c29', patch: '#18233a', runoff: '#262f3d', road: '#2a2e36', curbA: '#ff2e88', curbB: '#20e3ff', edge: '#20e3ff', line: 'rgba(255,255,255,0.35)', dust: '#3a4658', props: ['building', 'tree'], density: 0.7, lamps: true, headlights: true },
  city:   { label: 'City',   ground: '#7b8189', patch: '#727880', runoff: '#9aa0a8', road: '#3d4047', curbA: '#e8c21c', curbB: '#2b2b2b', edge: '#f0f0f0', line: 'rgba(255,255,255,0.6)',  dust: '#b0b0b0', props: ['building', 'building', 'tree'], density: 1.3 },
  beach:  { label: 'Beach',  ground: '#ecd9a0', patch: '#e2c98a', runoff: '#f4e7c0', road: '#5d5f66', curbA: '#ff7b54', curbB: '#ffffff', edge: '#ffffff', line: 'rgba(255,255,255,0.6)',  dust: '#e8d39a', props: ['palm', 'palm', 'rock'], density: 0.6 },
  forest: { label: 'Forest', ground: '#2f6b2a', patch: '#357530', runoff: '#7a6a48', road: '#4a4c50', curbA: '#d93a2f', curbB: '#f5f5f5', edge: '#f2f2f2', line: 'rgba(255,255,255,0.5)',  dust: '#6b5a3a', props: ['tree', 'tree', 'pine', 'bush'], density: 2.0 },
};

/* ------------------------------------------------------------------ */
/* The 15 tracks. difficulty: 1 (easy) .. 5 (hard).                    */
/* ------------------------------------------------------------------ */
const TRACK_DEFS = [
  {
    id: 'sunny-oval', name: 'Sunny Oval', difficulty: 1, theme: 'grass', width: 160,
    points: [[30, 100], [55, 45], [150, 30], [245, 45], [270, 100], [245, 155], [150, 170], [55, 155]],
  },
  {
    id: 'dune-loop', name: 'Dune Loop', difficulty: 1, theme: 'desert', width: 150,
    points: [[30, 40], [150, 25], [270, 40], [290, 120], [250, 200], [170, 180], [130, 230], [40, 210], [20, 120]],
  },
  {
    id: 'downtown', name: 'Downtown Blocks', difficulty: 3, theme: 'city', width: 130, cornerRadius: 18,
    corners: [[40, 40], [200, 40], [200, 120], [280, 120], [280, 240], [40, 240]],
  },
  {
    id: 'switchback', name: 'Switchback Pass', difficulty: 4, theme: 'forest', width: 130,
    points: [[60, 270], [260, 270], [277, 250], [260, 230], [90, 230], [73, 210], [90, 190], [260, 190], [277, 170],
      [260, 150], [90, 150], [73, 130], [90, 110], [240, 110], [272, 85], [245, 50], [140, 45], [50, 50], [25, 85],
      [25, 220], [35, 258]],
  },
  {
    id: 'coastal', name: 'Coastal Sprint', difficulty: 2, theme: 'beach', width: 160,
    points: [[30, 140], [60, 50], [160, 25], [260, 40], [310, 100], [290, 170], [220, 190], [170, 240], [80, 250], [35, 210]],
  },
  {
    id: 'chicane-park', name: 'Chicane Park', difficulty: 3, theme: 'grass', width: 140,
    points: [[30, 140], [40, 60], [80, 35], [135, 35], [150, 55], [175, 55], [190, 35], [250, 35], [285, 65], [285, 110],
      [265, 130], [265, 160], [285, 180], [270, 235], [200, 250], [110, 250], [50, 225]],
  },
  {
    id: 'frozen-lake', name: 'Frozen Lake', difficulty: 3, theme: 'snow', width: 140,
    points: [[50, 100], [110, 40], [200, 60], [240, 30], [290, 70], [270, 150], [200, 160], [160, 192], [172, 222], [232, 226], [254, 256],
      [222, 282], [140, 276], [50, 240], [70, 170]],
  },
  {
    id: 'neon-nights', name: 'Neon Nights', difficulty: 3, theme: 'night', width: 140,
    points: [[110, 35], [200, 35], [260, 60], [275, 130], [215, 140], [190, 170], [205, 200], [265, 215], [250, 262],
      [140, 270], [60, 250], [25, 190], [50, 140], [95, 115], [75, 70]],
  },
  {
    id: 'canyon-run', name: 'Canyon Run', difficulty: 3, theme: 'desert', width: 145,
    points: [[40, 240], [30, 140], [60, 60], [130, 30], [170, 70], [215, 35], [285, 55], [300, 125], [255, 170],
      [290, 225], [240, 270], [140, 255], [80, 275]],
  },
  {
    id: 'lagoon', name: 'Lagoon Ring', difficulty: 1, theme: 'beach', width: 160,
    points: [[150, 25], [220, 80], [285, 200], [250, 260], [150, 265], [50, 260], [15, 200], [80, 80]],
  },
  {
    id: 'twisty-woods', name: 'Twisty Woods', difficulty: 4, theme: 'forest', width: 130,
    points: [[40, 40], [120, 30], [140, 80], [105, 105], [115, 140], [160, 150], [220, 110], [200, 50], [270, 40], [300, 110],
      [260, 180], [290, 240], [210, 270], [150, 220], [90, 270], [30, 230], [50, 150], [20, 100]],
  },
  {
    id: 'night-speedway', name: 'Night Speedway', difficulty: 2, theme: 'night', width: 170,
    points: [[30, 110], [70, 40], [160, 30], [250, 40], [290, 110], [250, 180], [200, 185], [160, 205], [120, 185], [70, 180]],
  },
  {
    id: 'glacier-peaks', name: 'Glacier Peaks', difficulty: 5, theme: 'snow', width: 130,
    points: [[40, 260], [30, 160], [80, 110], [40, 60], [110, 25], [160, 70], [200, 30], [280, 50], [290, 130],
      [230, 135], [215, 165], [270, 200], [260, 265], [170, 250], [140, 205], [110, 215], [95, 260]],
  },
  {
    id: 'harbor-streets', name: 'Harbor Streets', difficulty: 4, theme: 'city', width: 120, cornerRadius: 15,
    corners: [[40, 40], [160, 40], [160, 100], [260, 100], [260, 260], [140, 260], [140, 180], [40, 180]],
  },
  {
    id: 'grand-prix', name: 'Grand Prix Ring', difficulty: 5, theme: 'grass', width: 140,
    points: [[40, 270], [30, 170], [60, 100], [30, 40], [110, 20], [170, 55], [240, 25], [300, 60], [290, 120],
      [235, 128], [200, 150], [205, 180], [260, 190], [300, 240], [230, 280], [160, 250], [110, 280]],
  },
];

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

/** Turn street-circuit corners into control points (one before/after each corner). */
function roundCorners(corners, r) {
  const out = [];
  const m = corners.length;
  for (let i = 0; i < m; i++) {
    const p = corners[(i - 1 + m) % m], c = corners[i], n = corners[(i + 1) % m];
    let ix = c[0] - p[0], iy = c[1] - p[1];
    let ox = n[0] - c[0], oy = n[1] - c[1];
    const il = Math.hypot(ix, iy) || 1, ol = Math.hypot(ox, oy) || 1;
    ix /= il; iy /= il; ox /= ol; oy /= ol;
    out.push([c[0] - ix * r, c[1] - iy * r]);
    out.push([c[0] + ox * r, c[1] + oy * r]);
  }
  return out;
}

/** Centripetal Catmull-Rom between p1 and p2 (no loops/cusps). Writes into out[0..1]. */
function catmullRom(p0, p1, p2, p3, t, out) {
  const knot = (a, b) => Math.max(1e-4, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
  const t0 = 0, t1 = t0 + knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
  const tt = t1 + (t2 - t1) * t;
  const lerp = (a, b, ta, tb, i) => ((tb - tt) * a[i] + (tt - ta) * b[i]) / (tb - ta);
  for (let i = 0; i < 2; i++) {
    const a1 = lerp(p0, p1, t0, t1, i), a2 = lerp(p1, p2, t1, t2, i), a3 = lerp(p2, p3, t2, t3, i);
    const b1 = ((t2 - tt) * a1 + (tt - t0) * a2) / (t2 - t0);
    const b2 = ((t3 - tt) * a2 + (tt - t1) * a3) / (t3 - t1);
    out[i] = ((t2 - tt) * b1 + (tt - t1) * b2) / (t2 - t1);
  }
}

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Build the runtime geometry for a track definition. */
function buildTrack(def) {
  const scale = def.scale || 10;
  const ctrl = def.corners ? roundCorners(def.corners, def.cornerRadius || 16) : def.points;
  const P = ctrl.map(p => [p[0] * scale, p[1] * scale]);
  const m = P.length;

  // 1. Dense polyline through the spline.
  const SUB = 30;
  const dx = [], dy = [];
  const tmp = [0, 0];
  for (let i = 0; i < m; i++) {
    const p0 = P[(i - 1 + m) % m], p1 = P[i], p2 = P[(i + 1) % m], p3 = P[(i + 2) % m];
    for (let k = 0; k < SUB; k++) {
      catmullRom(p0, p1, p2, p3, k / SUB, tmp);
      dx.push(tmp[0]); dy.push(tmp[1]);
    }
  }
  const D = dx.length;
  const cum = new Float64Array(D + 1);
  for (let i = 0; i < D; i++) {
    const j = (i + 1) % D;
    cum[i + 1] = cum[i] + Math.hypot(dx[j] - dx[i], dy[j] - dy[i]);
  }
  const total = cum[D];

  // 2. Resample at uniform arc-length spacing.
  const n = Math.max(64, Math.round(total / TRACK_SPACING));
  const sp = total / n;
  const rx = new Float32Array(n), ry = new Float32Array(n);
  let seg = 0;
  for (let k = 0; k < n; k++) {
    const s = k * sp;
    while (seg < D - 1 && cum[seg + 1] < s) seg++;
    const j = (seg + 1) % D;
    const f = (s - cum[seg]) / ((cum[seg + 1] - cum[seg]) || 1);
    rx[k] = dx[seg] + (dx[j] - dx[seg]) * f;
    ry[k] = dy[seg] + (dy[j] - dy[seg]) * f;
  }

  // 3. Heading and smoothed signed curvature (+ = turning right on screen).
  const head = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const a = (k - 1 + n) % n, b = (k + 1) % n;
    head[k] = Math.atan2(ry[b] - ry[a], rx[b] - rx[a]);
  }
  const K = 3;
  const craw = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    craw[k] = wrapAngle(head[(k + K) % n] - head[(k - K + n) % n]) / (2 * K * sp);
  }
  const curv = new Float32Array(n);
  const SM = 4;
  for (let k = 0; k < n; k++) {
    let s = 0;
    for (let j = -SM; j <= SM; j++) s += craw[(k + j + n) % n];
    curv[k] = s / (2 * SM + 1);
  }

  // 4. Put the start/finish line ~60% along the longest straight, so the
  //    grid behind it sits on the straight too.
  const STRAIGHT = 1 / 900;
  let bestLen = 0, bestStart = 0, runLen = 0, runStart = 0;
  for (let k = 0; k < 2 * n; k++) {
    if (Math.abs(curv[k % n]) < STRAIGHT) {
      if (runLen === 0) runStart = k;
      runLen++;
      if (runLen > bestLen && runLen <= n) { bestLen = runLen; bestStart = runStart; }
    } else runLen = 0;
  }
  const start = bestLen > 0 ? (bestStart + Math.floor(bestLen * 0.6)) % n : 0;

  const T = {
    def, id: def.id, name: def.name, difficulty: def.difficulty, theme: def.theme,
    n, sp, length: total, width: def.width, halfWidth: def.width / 2,
    xs: new Float32Array(n), ys: new Float32Array(n),
    tx: new Float32Array(n), ty: new Float32Array(n),
    nx: new Float32Array(n), ny: new Float32Array(n),
    curv: new Float32Array(n), radius: new Float32Array(n),
    minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity,
    checkpoints: null, cpWindow: 0,
    bg: null, bgX: 0, bgY: 0, bgScale: 1, mini: null, // filled by the renderer
  };
  for (let k = 0; k < n; k++) {
    const s = (k + start) % n;
    T.xs[k] = rx[s]; T.ys[k] = ry[s];
    const c = Math.cos(head[s]), si = Math.sin(head[s]);
    T.tx[k] = c; T.ty[k] = si;
    T.nx[k] = -si; T.ny[k] = c; // normal points to the driver's right
    T.curv[k] = curv[s];
    T.minX = Math.min(T.minX, rx[s]); T.maxX = Math.max(T.maxX, rx[s]);
    T.minY = Math.min(T.minY, ry[s]); T.maxY = Math.max(T.maxY, ry[s]);
  }

  // 5. Local corner radius (smallest within ±10 samples) — used by the AI.
  const RW = 10;
  for (let k = 0; k < n; k++) {
    let r = 4000;
    for (let j = -RW; j <= RW; j++) {
      const c = Math.abs(T.curv[(k + j + n) % n]);
      if (c > 1e-6) r = Math.min(r, 1 / c);
    }
    T.radius[k] = r;
  }

  // 6. Checkpoints, evenly spaced; checkpoint 0 is the finish line.
  const numCp = Math.max(8, Math.round(total / 500));
  T.checkpoints = new Int32Array(numCp);
  for (let i = 0; i < numCp; i++) T.checkpoints[i] = Math.round(i * n / numCp) % n;
  T.cpWindow = Math.max(4, Math.floor(n / numCp / 2));
  return T;
}

const trackCache = [];
/** Geometry for track #i (built once, then cached). */
function getTrack(i) {
  if (!trackCache[i]) {
    trackCache[i] = buildTrack(TRACK_DEFS[i]);
    trackCache[i].index = i;
  }
  return trackCache[i];
}
