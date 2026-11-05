'use strict';
/* =====================================================================
 * ai.js — AI drivers.
 *
 * Each AI car:
 *  1. Steers towards a point some distance ahead on the track (further
 *     ahead at higher speed), offset sideways by its own racing line:
 *     a personal bias + "cut to the inside" of the upcoming corner.
 *  2. Scans the corner radius ahead and brakes if it couldn't slow down
 *     in time for any of those corners (v_max = handling × radius).
 *  3. Moves sideways to pass slower cars ahead and lifts if blocked.
 * Per-driver randomness (skill, line bias, wobble) avoids single file.
 * ===================================================================== */

/** Create a driver personality. skill: 0 (weak) .. 1 (strong). */
function createDriver(skill) {
  return {
    skill,
    lineBias: (Math.random() * 2 - 1) * 0.22,     // preferred side of the road
    cornerFactor: 0.66 + 0.18 * skill,            // how fast it dares to corner
    brakeFactor: 0.75 + 0.15 * skill,             // how late it brakes
    lookMul: 0.9 + Math.random() * 0.25,
    wobAmp: 0.05 + 0.1 * (1 - skill),             // line imprecision
    wobFreq: 0.15 + Math.random() * 0.2,
    wobPhase: Math.random() * Math.PI * 2,
    avoidOff: 0,
  };
}

function clampAI(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** Decide steer / brake / throttle for car c. */
function updateAI(c, track, cars, dt, time) {
  const d = c.ai, n = track.n, sp = track.sp, hw = track.halfWidth;
  const speed = c.speed > 0 ? c.speed : 0;
  const sn = c.sn, cs = c.cs;

  // ---- 1. Traffic: look for slower cars ahead in our lane.
  let avoidTarget = 0, blocked = false;
  let nearest = 1e9;
  for (let i = 0; i < cars.length; i++) {
    const o = cars[i];
    if (o === c) continue;
    const dx = o.x - c.x, dy = o.y - c.y;
    const fd = dx * sn - dy * cs;           // distance ahead
    if (fd <= 0 || fd > 120 || fd > nearest) continue;
    const ld = dx * cs + dy * sn;           // sideways (+ = to our right)
    if (ld > 34 || ld < -34) continue;
    if (o.speed > speed - 5 && fd > 45) continue; // it's not slower, ignore
    nearest = fd;
    avoidTarget = ld > 0 ? -1 : 1;          // go around on the other side
    if (fd < 55 && o.speed < speed - 15) blocked = true;
  }
  if (avoidTarget !== 0) {
    // Don't dodge off the road: flip side if we're already near that edge.
    const lat = c.trackLat / hw;
    if (avoidTarget < 0 && lat < -0.4) avoidTarget = 1;
    else if (avoidTarget > 0 && lat > 0.4) avoidTarget = -1;
  }
  d.avoidOff += (avoidTarget * 0.55 - d.avoidOff) * Math.min(1, dt * 3);

  // ---- 2. Steering towards a look-ahead point on our racing line.
  const look = 60 + speed * 0.42 * d.lookMul;
  let ti = c.trackIdx + ((look / sp) | 0); if (ti >= n) ti -= n;
  let ci = c.trackIdx + (((look + 110) / sp) | 0); if (ci >= n) ci -= n;
  const inside = clampAI(track.curv[ci] * 90, -0.6, 0.6);  // + curv = right turn = right side
  let off = d.lineBias + inside + d.avoidOff + Math.sin(time * d.wobFreq * 6.283 + d.wobPhase) * d.wobAmp;
  off = clampAI(off, -0.68, 0.68);
  if (c.offTrack) off *= 0.3;                                // get back to the middle
  const tx = track.xs[ti] + track.nx[ti] * off * hw;
  const ty = track.ys[ti] + track.ny[ti] * off * hw;
  const want = Math.atan2(tx - c.x, -(ty - c.y));
  let diff = want - c.angle;
  if (diff > Math.PI) diff -= Math.PI * 2; else if (diff < -Math.PI) diff += Math.PI * 2;
  c.steer = clampAI(diff * 3, -1, 1);

  // ---- 3. Speed: brake for the tightest constraint ahead.
  const brk = c.stats.braking * d.brakeFactor;
  const hf = c.stats.handling * d.cornerFactor;
  const scan = speed * speed / (2 * brk) + 80;
  let steps = (scan / sp) | 0; if (steps > 160) steps = 160;
  let limit = hf * track.radius[c.trackIdx];
  for (let k = 2; k <= steps; k += 2) {
    let j = c.trackIdx + k; if (j >= n) j -= n;
    const vmax = hf * track.radius[j];
    const allow = Math.sqrt(vmax * vmax + 2 * brk * k * sp);
    if (allow < limit) limit = allow;
  }
  if (c.offTrack) limit = Math.min(limit, c.stats.topSpeed);

  c.throttle = true;
  c.brake = 0;
  if (speed > limit + 6) c.brake = clampAI((speed - limit) / 50 + 0.25, 0, 1);
  else if (speed > limit * 0.985) c.throttle = false;      // lift
  if (blocked && c.brake < 0.35) c.brake = 0.35;
}
