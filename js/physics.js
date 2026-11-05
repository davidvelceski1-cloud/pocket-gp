'use strict';
/* =====================================================================
 * physics.js — car movement, track queries and car-to-car collisions.
 *
 * Model (arcade, top-down):
 *  - Each car has a heading `angle` (0 = pointing up / -y, clockwise +)
 *    and a velocity vector (vx, vy).
 *  - Every step the velocity is split into a forward part and a sideways
 *    part relative to the heading. Auto-throttle / brake act on the
 *    forward part; `grip` damps the sideways part. Turning rotates the
 *    heading faster than the velocity follows, which gives natural slides
 *    (more on low-grip, high-speed cars).
 *  - Off the road (grass, sand, ...) the top speed and grip drop sharply.
 *
 * Nothing in here allocates memory per step.
 * ===================================================================== */

const CAR_LENGTH = 38;
const CAR_WIDTH = 20;
const CAR_CIRCLE_R = 10.5;   // each car = two circles (front/back) for collisions
const CAR_CIRCLE_OFS = 9;

const PHYS = {
  offroadSpeed: 0.42,      // fraction of top speed allowed off the road
  offroadGrip: 0.55,       // grip multiplier off the road
  overSpeedDecel: 2.4,     // how hard cars slow when above their speed limit
  minOverSpeedDecel: 230,  // units/s² minimum slow-down when above the limit
  coastDrag: 0.25,         // drag when neither throttling nor braking
  curbTolerance: 6,        // curbs count as road for this many units
  restitution: 0.35,       // bounciness of car-to-car hits
  collisionSpeedLoss: 0.0008, // fraction of speed lost per unit of impact (max 25%)
  trackSearch: 24,         // samples searched around the last known position
  worldMargin: 260,        // cars can't drive further than this outside the track bounds
};

/** Create a car state object (called only when setting up a race). */
function createCar(carIndex, isPlayer) {
  return {
    carIndex, stats: CARS[carIndex], isPlayer,
    x: 0, y: 0, angle: 0, vx: 0, vy: 0,
    px: 0, py: 0, pa: 0,           // previous step (for render interpolation)
    sn: 0, cs: 1,                  // sin/cos of angle (cached)
    speed: 0, slip: 0,             // forward / sideways speed
    steer: 0, brake: 0, throttle: true,
    speedMul: 1,
    // track & race progress
    trackIdx: 0, trackLat: 0, offTrack: false,
    nextCp: 0, cpPassed: 0, lastCpIdx: 0, score: 0,
    lap: 0, lapStart: 0, lastLap: 0, bestLap: Infinity,
    finished: false, finishTime: 0, position: 1,
    wrongWay: 0,
    ai: null,
  };
}

/** Advance one car by dt seconds. Uses car.steer (-1..1), car.brake (0..1), car.throttle. */
function stepCar(c, track, dt) {
  const s = c.stats;

  // --- Steering: rotate the heading. Little authority at very low speed.
  const absSpeed = c.speed < 0 ? -c.speed : c.speed;
  const authority = absSpeed < 90 ? absSpeed / 90 : 1;
  c.angle += c.steer * s.handling * authority * dt * (c.speed < 0 ? -1 : 1);
  if (c.angle > Math.PI) c.angle -= Math.PI * 2;
  else if (c.angle < -Math.PI) c.angle += Math.PI * 2;

  const sn = Math.sin(c.angle), cs = Math.cos(c.angle);
  c.sn = sn; c.cs = cs;

  // --- Split velocity into forward/sideways relative to the NEW heading.
  let fwd = c.vx * sn - c.vy * cs;
  let lat = c.vx * cs + c.vy * sn;

  const top = s.topSpeed * c.speedMul;
  const limit = c.offTrack ? top * PHYS.offroadSpeed : top;

  if (c.brake > 0.01) {
    // Progressive brake; never reverses.
    if (fwd > 0) { fwd -= s.braking * c.brake * dt; if (fwd < 0) fwd = 0; }
    else { fwd += s.braking * c.brake * dt; if (fwd > 0) fwd = 0; }
  } else if (c.throttle) {
    // Auto-throttle: strong at low speed, tapering near the top.
    if (fwd < limit) {
      fwd += s.accel * (1 - 0.55 * fwd / top) * dt;
      if (fwd > limit) fwd = limit;
    }
  } else {
    fwd -= fwd * PHYS.coastDrag * dt;
  }
  if (fwd > limit) {
    // Too fast for the surface (grass) or pushed by a collision.
    const dec = Math.max(PHYS.minOverSpeedDecel, (fwd - limit) * PHYS.overSpeedDecel);
    fwd -= dec * dt;
    if (fwd < limit) fwd = limit;
  }

  // --- Grip: kill sideways sliding.
  const grip = s.grip * (c.offTrack ? PHYS.offroadGrip : 1);
  lat *= Math.exp(-grip * dt);

  c.vx = sn * fwd + cs * lat;
  c.vy = -cs * fwd + sn * lat;
  c.speed = fwd;
  c.slip = lat;

  c.x += c.vx * dt;
  c.y += c.vy * dt;

  // Keep cars inside the world.
  const m = PHYS.worldMargin;
  if (c.x < track.minX - m) { c.x = track.minX - m; c.vx = 0; }
  else if (c.x > track.maxX + m) { c.x = track.maxX + m; c.vx = 0; }
  if (c.y < track.minY - m) { c.y = track.minY - m; c.vy = 0; }
  else if (c.y > track.maxY + m) { c.y = track.maxY + m; c.vy = 0; }

  queryTrack(c, track);
}

/** Find the nearest centre-line sample (local search around the last one) and set offTrack. */
function queryTrack(c, track) {
  const n = track.n, xs = track.xs, ys = track.ys;
  let best = c.trackIdx, bestD = Infinity;
  const R = PHYS.trackSearch;
  for (let k = -R; k <= R; k++) {
    let i = c.trackIdx + k;
    if (i < 0) i += n; else if (i >= n) i -= n;
    const dx = c.x - xs[i], dy = c.y - ys[i];
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  // Lost (far off the road)? Fall back to a full scan.
  const far = track.halfWidth * 3;
  if (bestD > far * far) {
    for (let i = 0; i < n; i++) {
      const dx = c.x - xs[i], dy = c.y - ys[i];
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
  }
  c.trackIdx = best;
  c.trackLat = (c.x - xs[best]) * track.nx[best] + (c.y - ys[best]) * track.ny[best];
  const lat = c.trackLat < 0 ? -c.trackLat : c.trackLat;
  c.offTrack = lat > track.halfWidth + PHYS.curbTolerance;
}

/**
 * Car-to-car collisions. Each car is two circles; the deepest overlap of
 * each pair is resolved by pushing the cars apart and exchanging momentum
 * along the contact normal. onImpact(strength) is called for hits that
 * involve the player (used for vibration).
 */
function collideCars(cars, onImpact) {
  const R2 = CAR_CIRCLE_R * 2;
  const reach = CAR_LENGTH + 4;
  for (let i = 0; i < cars.length; i++) {
    const a = cars[i];
    for (let j = i + 1; j < cars.length; j++) {
      const b = cars[j];
      const ddx = b.x - a.x, ddy = b.y - a.y;
      if (ddx > reach || ddx < -reach || ddy > reach || ddy < -reach) continue;

      // Find the deepest of the 4 circle-pair overlaps.
      let bestPen = 0, bnx = 0, bny = 0;
      for (let ia = -1; ia <= 1; ia += 2) {
        const ax = a.x + a.sn * CAR_CIRCLE_OFS * ia, ay = a.y - a.cs * CAR_CIRCLE_OFS * ia;
        for (let ib = -1; ib <= 1; ib += 2) {
          const bx = b.x + b.sn * CAR_CIRCLE_OFS * ib, by = b.y - b.cs * CAR_CIRCLE_OFS * ib;
          const dx = bx - ax, dy = by - ay;
          const d2 = dx * dx + dy * dy;
          if (d2 < R2 * R2) {
            const d = Math.sqrt(d2);
            const pen = R2 - d;
            if (pen > bestPen) {
              bestPen = pen;
              if (d > 1e-4) { bnx = dx / d; bny = dy / d; }
              else { const dd = Math.hypot(ddx, ddy) || 1; bnx = ddx / dd; bny = ddy / dd; }
            }
          }
        }
      }
      if (bestPen <= 0) continue;

      // Separate.
      const push = bestPen * 0.5;
      a.x -= bnx * push; a.y -= bny * push;
      b.x += bnx * push; b.y += bny * push;

      // Exchange momentum along the normal (equal masses).
      const rv = (b.vx - a.vx) * bnx + (b.vy - a.vy) * bny;
      if (rv < 0) {
        const imp = -(1 + PHYS.restitution) * rv * 0.5;
        a.vx -= imp * bnx; a.vy -= imp * bny;
        b.vx += imp * bnx; b.vy += imp * bny;
        // Speed loss scales with impact, so cars merely rubbing don't stall.
        let loss = imp * PHYS.collisionSpeedLoss;
        if (loss > 0.25) loss = 0.25;
        const keep = 1 - loss;
        a.vx *= keep; a.vy *= keep; b.vx *= keep; b.vy *= keep;
        if (onImpact && (a.isPlayer || b.isPlayer)) onImpact(-rv);
      }
    }
  }
}
