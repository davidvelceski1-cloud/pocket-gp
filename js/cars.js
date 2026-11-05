'use strict';
/* =====================================================================
 * cars.js — the 30 cars, ordered from slowest (#1) to fastest (#30).
 *
 * Edit freely. Units:
 *   topSpeed  world units / second   (HUD shows km/h = topSpeed × 0.5)
 *   accel     world units / second²  (auto-throttle, no gas button)
 *   handling  max turn rate in radians / second at full steer
 *   braking   deceleration in world units / second² at full pedal
 *   grip      how fast sideways sliding is killed (1/s). Lower = more
 *             drift. Fast cars get less grip relative to their speed, so
 *             they're quicker but harder to control.
 *   style     body shape used by the renderer: compact | sedan | sport | super
 * ===================================================================== */

const CARS = [
  // ---- Tier 1: compacts (gentle, forgiving) ----
  { name: 'Pebble',        color: '#9aa5b1', accent: '#e9eef2', style: 'compact', topSpeed: 240, accel: 110, handling: 2.30, braking: 320, grip: 22.0 },
  { name: 'Puddle Jumper', color: '#7fc8a9', accent: '#ffffff', style: 'compact', topSpeed: 254, accel: 120, handling: 2.32, braking: 333, grip: 21.7 },
  { name: 'Biscuit',       color: '#d9a066', accent: '#fff3dc', style: 'compact', topSpeed: 268, accel: 130, handling: 2.34, braking: 346, grip: 21.3 },
  { name: 'Tin Turtle',    color: '#6b8e5a', accent: '#d8e8c8', style: 'compact', topSpeed: 281, accel: 140, handling: 2.36, braking: 359, grip: 21.0 },
  { name: 'Wren',          color: '#c96f8e', accent: '#ffe1ec', style: 'compact', topSpeed: 295, accel: 150, handling: 2.38, braking: 372, grip: 20.6 },
  { name: 'Mule Mk2',      color: '#8d7b68', accent: '#f0e4d4', style: 'compact', topSpeed: 309, accel: 160, handling: 2.40, braking: 385, grip: 20.3 },
  { name: 'Meteorite',     color: '#5b7fd6', accent: '#dfe8ff', style: 'compact', topSpeed: 323, accel: 170, handling: 2.42, braking: 399, grip: 19.9 },
  { name: 'Ferret',        color: '#e0c341', accent: '#2b2b2b', style: 'compact', topSpeed: 337, accel: 180, handling: 2.44, braking: 412, grip: 19.6 },

  // ---- Tier 2: sedans / hot hatches ----
  { name: 'Kestrel',       color: '#4aa3a2', accent: '#ffffff', style: 'sedan',   topSpeed: 350, accel: 190, handling: 2.47, braking: 425, grip: 19.2 },
  { name: 'Breezer',       color: '#e57a44', accent: '#ffffff', style: 'sedan',   topSpeed: 364, accel: 200, handling: 2.49, braking: 438, grip: 18.9 },
  { name: 'Foxtrot',       color: '#8e5bd6', accent: '#f1e6ff', style: 'sedan',   topSpeed: 378, accel: 210, handling: 2.51, braking: 451, grip: 18.6 },
  { name: 'Swordfish',     color: '#2e86de', accent: '#ffd23f', style: 'sedan',   topSpeed: 392, accel: 220, handling: 2.53, braking: 464, grip: 18.2 },
  { name: 'Vortex S',      color: '#d63a3a', accent: '#ffffff', style: 'sedan',   topSpeed: 406, accel: 230, handling: 2.55, braking: 477, grip: 17.9 },
  { name: 'Rumbler',       color: '#3c4a5c', accent: '#ff8c1a', style: 'sedan',   topSpeed: 419, accel: 240, handling: 2.57, braking: 490, grip: 17.5 },
  { name: 'Harpoon',       color: '#16a085', accent: '#ecf0f1', style: 'sedan',   topSpeed: 433, accel: 250, handling: 2.59, braking: 503, grip: 17.2 },

  // ---- Tier 3: sports cars ----
  { name: 'Nimbus',        color: '#f2f2f2', accent: '#2e86de', style: 'sport',   topSpeed: 447, accel: 260, handling: 2.61, braking: 517, grip: 16.8 },
  { name: 'Riptide',       color: '#00b4d8', accent: '#03045e', style: 'sport',   topSpeed: 461, accel: 270, handling: 2.63, braking: 530, grip: 16.5 },
  { name: 'Halcyon',       color: '#f4a261', accent: '#264653', style: 'sport',   topSpeed: 474, accel: 280, handling: 2.65, braking: 543, grip: 16.1 },
  { name: 'Firebrand',     color: '#e63946', accent: '#f1faee', style: 'sport',   topSpeed: 488, accel: 290, handling: 2.67, braking: 556, grip: 15.8 },
  { name: 'Bluestreak',    color: '#1d4ed8', accent: '#ffffff', style: 'sport',   topSpeed: 502, accel: 300, handling: 2.69, braking: 569, grip: 15.5 },
  { name: 'Saber',         color: '#9ef01a', accent: '#1b1b1b', style: 'sport',   topSpeed: 516, accel: 310, handling: 2.71, braking: 582, grip: 15.1 },
  { name: 'Thunderclap',   color: '#ffbe0b', accent: '#111111', style: 'sport',   topSpeed: 530, accel: 320, handling: 2.73, braking: 595, grip: 14.8 },
  { name: 'Nightjar',      color: '#22223b', accent: '#c9ada7', style: 'sport',   topSpeed: 543, accel: 330, handling: 2.76, braking: 608, grip: 14.4 },

  // ---- Tier 4: supercars (very fast, slidey) ----
  { name: 'Quasar',        color: '#7209b7', accent: '#f72585', style: 'super',   topSpeed: 557, accel: 340, handling: 2.78, braking: 621, grip: 14.1 },
  { name: 'Blaze Runner',  color: '#ff5400', accent: '#ffd000', style: 'super',   topSpeed: 571, accel: 350, handling: 2.80, braking: 634, grip: 13.7 },
  { name: 'Hyperdrive',    color: '#00f5d4', accent: '#0b090a', style: 'super',   topSpeed: 585, accel: 360, handling: 2.82, braking: 648, grip: 13.4 },
  { name: 'Solar Flare',   color: '#ffd60a', accent: '#d00000', style: 'super',   topSpeed: 599, accel: 370, handling: 2.84, braking: 661, grip: 13.0 },
  { name: 'Apex Wolf',     color: '#adb5bd', accent: '#e63946', style: 'super',   topSpeed: 612, accel: 380, handling: 2.86, braking: 674, grip: 12.7 },
  { name: 'Event Horizon', color: '#101010', accent: '#ff006e', style: 'super',   topSpeed: 626, accel: 390, handling: 2.88, braking: 687, grip: 12.3 },
  { name: 'Singularity',   color: '#ff006e', accent: '#ffffff', style: 'super',   topSpeed: 640, accel: 400, handling: 2.90, braking: 700, grip: 12.0 },
];

/** Min/max of each stat across all cars — used to scale the stat bars. */
const CAR_STAT_RANGES = (function () {
  const keys = ['topSpeed', 'accel', 'handling', 'braking', 'grip'];
  const r = {};
  for (const k of keys) {
    let lo = Infinity, hi = -Infinity;
    for (const c of CARS) { lo = Math.min(lo, c[k]); hi = Math.max(hi, c[k]); }
    r[k] = { min: lo, max: hi };
  }
  return r;
})();

/** Stat as a 0..1 bar fill (never fully empty, so slow cars still show something). */
function carStatFraction(car, key) {
  const r = CAR_STAT_RANGES[key];
  return 0.15 + 0.85 * (car[key] - r.min) / (r.max - r.min || 1);
}
