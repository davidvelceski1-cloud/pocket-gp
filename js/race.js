'use strict';
/* =====================================================================
 * race.js — race rules: starting grid, opponents, checkpoints, laps,
 * positions and finishing. No DOM access (runs headless in tests too).
 *
 * Lap validation: each track has N checkpoints (index 0 = finish line).
 * A car must pass them in order; a checkpoint only counts when the car's
 * nearest track sample is just past it, so skipping a section (shortcut)
 * leaves the next checkpoint unpassed and the lap won't count.
 *
 * Positions: score = checkpoints passed × big number + samples travelled
 * since the last checkpoint. Finished cars rank by finish time.
 * ===================================================================== */

const RACE_LAPS = 3;
const GRID_SIZE = 6;

/** Grid slot k (0 = pole) behind the start line. */
function gridSlot(track, k) {
  const row = k >> 1, side = (k & 1) ? 1 : -1;
  const back = 40 + row * 64 + (k & 1) * 26;   // staggered rows
  const n = track.n;
  const i = ((Math.round(-back / track.sp) % n) + n) % n;
  const off = side * track.width * 0.24;
  return {
    i,
    x: track.xs[i] + track.nx[i] * off,
    y: track.ys[i] + track.ny[i] * off,
    angle: Math.atan2(track.tx[i], -track.ty[i]),
  };
}

/** The `count` cars closest in performance to car p (excluding p). */
function pickOpponents(p, count) {
  const out = [];
  for (let d = 1; out.length < count && d < CARS.length; d++) {
    // alternate: one slightly faster, one slightly slower
    if (p + d < CARS.length && out.length < count) out.push(p + d);
    if (p - d >= 0 && out.length < count) out.push(p - d);
  }
  return out;
}

/** Sort comparator for positions (defined once, no per-frame closures). */
function compareRacePos(a, b) {
  if (a.finished && b.finished) return a.finishTime - b.finishTime;
  if (a.finished) return -1;
  if (b.finished) return 1;
  return b.score - a.score;
}

const Race = {
  track: null,
  cars: [],
  order: [],           // cars sorted by position
  player: null,
  focus: null,         // car the camera follows
  time: 0,
  laps: RACE_LAPS,
  demo: false,
  finishCount: 0,
  // Hooks set by main.js
  onImpact: null,      // (strength)
  onPlayerLap: null,   // (car, lapTime, isPersonalBest)
  onPlayerFinish: null,// (car)

  /** Build the grid. demo = all-AI attract mode with endless laps. */
  setup(track, playerCarIdx, demo) {
    this.track = track;
    this.demo = demo;
    this.time = 0;
    this.finishCount = 0;
    this.laps = demo ? Infinity : RACE_LAPS;
    this.cars.length = 0;

    let ids;
    if (demo) {
      ids = [];
      for (let k = 0; k < GRID_SIZE; k++) ids.push(Math.min(CARS.length - 1, playerCarIdx + k * 2));
    } else {
      ids = pickOpponents(playerCarIdx, GRID_SIZE - 1);
      // shuffle AI grid order
      for (let k = ids.length - 1; k > 0; k--) {
        const r = (Math.random() * (k + 1)) | 0;
        const t = ids[k]; ids[k] = ids[r]; ids[r] = t;
      }
      ids.push(playerCarIdx); // player starts at the back of the grid
    }

    for (let k = 0; k < ids.length; k++) {
      const isPlayer = !demo && k === ids.length - 1;
      const c = createCar(ids[k], isPlayer);
      const slot = gridSlot(track, k);
      c.x = c.px = slot.x; c.y = c.py = slot.y;
      c.angle = c.pa = slot.angle;
      c.sn = Math.sin(c.angle); c.cs = Math.cos(c.angle);
      c.trackIdx = slot.i;
      queryTrack(c, track);
      c.lastCpIdx = 0;
      // AI personality (the player also gets one: it drives after finishing)
      const skill = isPlayer ? 0.8 : 0.45 + Math.random() * 0.55;
      c.ai = createDriver(skill);
      if (!isPlayer) c.speedMul = 0.95 + 0.06 * skill;
      this.cars.push(c);
    }
    this.player = demo ? null : this.cars[this.cars.length - 1];
    this.focus = this.player || this.cars[0];
    this.order.length = 0;
    for (let k = 0; k < this.cars.length; k++) this.order.push(this.cars[k]);
    this.updatePositions();
  },

  /** Copy current state to "previous" (used before the start, for interpolation). */
  snapPrev() {
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      c.px = c.x; c.py = c.y; c.pa = c.angle;
    }
  },

  /** One fixed physics step. steer/brake are the player's inputs. */
  update(dt, steer, brake) {
    const cars = this.cars, track = this.track;
    this.time += dt;
    this.snapPrev();

    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (c.isPlayer && !c.finished) {
        c.steer = steer; c.brake = brake; c.throttle = true;
      } else {
        updateAI(c, track, cars, dt, this.time);
      }
    }
    for (let i = 0; i < cars.length; i++) stepCar(cars[i], track, dt);
    collideCars(cars, this.onImpact);
    for (let i = 0; i < cars.length; i++) this.progress(cars[i], dt);
    this.updatePositions();
  },

  /** Checkpoints, laps, wrong-way detection. */
  progress(c, dt) {
    const tr = this.track, n = tr.n;
    const cp = tr.checkpoints[c.nextCp];
    let ahead = c.trackIdx - cp; if (ahead < 0) ahead += n;
    const lat = c.trackLat < 0 ? -c.trackLat : c.trackLat;
    if (ahead < tr.cpWindow && lat < tr.halfWidth * 2.5) {
      const wasFinishLine = c.nextCp === 0;
      c.lastCpIdx = cp;
      c.cpPassed++;
      c.nextCp = (c.nextCp + 1) % tr.checkpoints.length;
      if (wasFinishLine) this.crossLine(c);
    }
    let fd = c.trackIdx - c.lastCpIdx; if (fd < 0) fd += n;
    if (fd > n / 2) fd -= n;
    c.score = c.cpPassed * 100000 + fd;

    // Wrong way: heading against the track direction for a while.
    const dot = c.sn * tr.tx[c.trackIdx] - c.cs * tr.ty[c.trackIdx];
    if (dot < -0.3 && c.speed > 20) c.wrongWay += dt; else c.wrongWay = 0;
  },

  crossLine(c) {
    if (c.lap === 0) { c.lap = 1; return; }     // first crossing = start of lap 1
    const lapTime = this.time - c.lapStart;
    c.lapStart = this.time;
    c.lastLap = lapTime;
    const pb = lapTime < c.bestLap;
    if (pb) c.bestLap = lapTime;
    if (c.isPlayer && !c.finished && this.onPlayerLap) this.onPlayerLap(c, lapTime, pb);
    if (c.lap >= this.laps && !c.finished) {
      c.finished = true;
      c.finishTime = this.time;
      this.finishCount++;
      if (c.isPlayer && this.onPlayerFinish) this.onPlayerFinish(c);
    } else {
      c.lap++;
    }
  },

  updatePositions() {
    this.order.sort(compareRacePos);
    for (let i = 0; i < this.order.length; i++) this.order[i].position = i + 1;
  },
};
