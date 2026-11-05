'use strict';
/* =====================================================================
 * main.js — game loop + state machine.
 *
 * States:  menu → cars → tracks → countdown → race → results
 *          (+ `paused` flag during countdown/race)
 *
 * Loop: requestAnimationFrame drives rendering; physics runs at a fixed
 * 1/60 s step using an accumulator, so game speed is identical at 30, 60
 * or 120 Hz and after dropped frames. Rendering interpolates between the
 * last two physics steps for smooth motion on high-refresh screens.
 * ===================================================================== */

const STEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 5;

/* ---------- localStorage, always wrapped (private mode can throw) ---------- */
const Store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('pocketgp.' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('pocketgp.' + key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  },
};

const Game = {
  state: 'menu',
  paused: false,
  carIdx: 0,
  trackIdx: 0,
  countdown: 0,
  goTimer: 0,
  finishTimer: -1,
  banner: '', banner2: '', bannerColor: '#fff', bannerTimer: 0,
  vibeCooldown: 0,
  vibration: true,
  newRecord: false,
  snapCamera: true,
};

const $ = (id) => document.getElementById(id);
const screens = {};
let cardsBuilt = { cars: false, tracks: false };

/* ===================================================================== */
/* Screens                                                               */
/* ===================================================================== */

function showScreen(name) {
  for (const k in screens) screens[k].classList.toggle('active', k === name);
}

function setRaceUI(visible) {
  $('race-ui').classList.toggle('hidden', !visible);
  if (visible) Input.measure();
}

function goMenu() {
  Game.paused = false;
  Game.state = 'menu';
  setRaceUI(false);
  showScreen('menu');
  startDemo();
}

function goCars() {
  Game.state = 'cars';
  Game.paused = false;
  setRaceUI(false);
  showScreen('cars');
  if (!cardsBuilt.cars) buildCarGrid();
  selectCar(Game.carIdx, true);
}

function goTracks() {
  Game.state = 'tracks';
  setRaceUI(false);
  showScreen('tracks');
  if (!cardsBuilt.tracks) buildTrackGrid();
  refreshTrackBests();
  selectTrack(Game.trackIdx, true);
}

/* ---------- Car selection ---------- */

function buildCarGrid() {
  const grid = $('car-grid');
  const html = [];
  const bar = (label, f, cls) =>
    '<div class="stat"><span>' + label + '</span><div class="bar ' + (cls || '') + '"><i style="width:' +
    Math.round(f * 100) + '%"></i></div></div>';
  for (let i = 0; i < CARS.length; i++) {
    const c = CARS[i];
    html.push(
      '<div class="card car-card" data-i="' + i + '">' +
      '<canvas class="car-canvas"></canvas>' +
      '<div class="card-title"><span>' + c.name + '</span><span class="num">#' + (i + 1) + '</span></div>' +
      '<div class="card-sub">' + Math.round(c.topSpeed * KMH) + ' km/h &middot; ' + c.style + '</div>' +
      '<div class="stats">' +
      bar('SPD', carStatFraction(c, 'topSpeed')) +
      bar('ACC', carStatFraction(c, 'accel')) +
      bar('HND', carStatFraction(c, 'handling')) +
      bar('BRK', carStatFraction(c, 'braking')) +
      bar('GRIP', carStatFraction(c, 'grip'), 'grip') +
      '</div></div>');
  }
  grid.innerHTML = html.join('');
  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (card) selectCar(+card.dataset.i, false);
  });
  // Draw previews after layout so the canvases have their real size.
  requestAnimationFrame(() => {
    const canvases = grid.querySelectorAll('.car-canvas');
    for (let i = 0; i < canvases.length; i++) Renderer.drawCarPreview(canvases[i], i);
  });
  cardsBuilt.cars = true;
}

function selectCar(i, scrollIntoView) {
  Game.carIdx = i;
  Store.set('car', i);
  const cards = $('car-grid').children;
  for (let k = 0; k < cards.length; k++) cards[k].classList.toggle('selected', k === i);
  const c = CARS[i];
  $('car-summary').innerHTML = '<b>' + c.name + '</b>#' + (i + 1) + ' of 30 &middot; ' + Math.round(c.topSpeed * KMH) + ' km/h';
  if (scrollIntoView && cards[i]) cards[i].scrollIntoView({ block: 'center' });
}

/* ---------- Track selection ---------- */

function buildTrackGrid() {
  const grid = $('track-grid');
  const html = [];
  for (let i = 0; i < TRACK_DEFS.length; i++) {
    const t = TRACK_DEFS[i];
    let stars = '';
    for (let s = 1; s <= 5; s++) stars += s <= t.difficulty ? '&#9733;' : '<span class="off">&#9733;</span>';
    html.push(
      '<div class="card track-card" data-i="' + i + '">' +
      '<canvas class="track-canvas"></canvas>' +
      '<div class="card-title"><span>' + t.name + '</span></div>' +
      '<div class="card-sub"><span class="stars">' + stars + '</span> &middot; ' + THEMES[t.theme].label + '</div>' +
      '<div class="track-best">Best lap: <b data-best="' + i + '">-</b></div>' +
      '</div>');
  }
  grid.innerHTML = html.join('');
  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (card) selectTrack(+card.dataset.i, false);
  });
  requestAnimationFrame(() => {
    const canvases = grid.querySelectorAll('.track-canvas');
    for (let i = 0; i < canvases.length; i++) Renderer.drawTrackPreview(canvases[i], getTrack(i));
  });
  cardsBuilt.tracks = true;
}

function bestLapFor(trackId) {
  const v = Store.get('best.' + trackId, null);
  return typeof v === 'number' && v > 0 ? v : null;
}

function refreshTrackBests() {
  const els = $('track-grid').querySelectorAll('[data-best]');
  for (let k = 0; k < els.length; k++) {
    const t = TRACK_DEFS[+els[k].dataset.best];
    const b = bestLapFor(t.id);
    els[k].textContent = b ? formatTime(b) : '-';
  }
}

function selectTrack(i, scrollIntoView) {
  Game.trackIdx = i;
  Store.set('track', i);
  const cards = $('track-grid').children;
  for (let k = 0; k < cards.length; k++) cards[k].classList.toggle('selected', k === i);
  const t = TRACK_DEFS[i];
  $('track-summary').innerHTML = '<b>' + t.name + '</b>' + CARS[Game.carIdx].name + ' &middot; ' + RACE_LAPS + ' laps';
  if (scrollIntoView && cards[i]) cards[i].scrollIntoView({ block: 'center' });
}

/* ===================================================================== */
/* Races                                                                 */
/* ===================================================================== */

function startDemo() {
  const t = (Math.random() * TRACK_DEFS.length) | 0;
  const track = getTrack(t);
  Renderer.prepareTrack(track);
  Race.setup(track, (Math.random() * 19) | 0, true);
  Renderer.clearParticles();
  Game.snapCamera = true;
}

function startRace() {
  const track = getTrack(Game.trackIdx);
  Renderer.prepareTrack(track);
  Race.setup(track, Game.carIdx, false);
  Renderer.clearParticles();
  Input.reset();
  Game.state = 'countdown';
  Game.paused = false;
  Game.countdown = 3.6;     // brief pause, then 3-2-1
  Game.goTimer = 0;
  Game.finishTimer = -1;
  Game.bannerTimer = 0;
  Game.newRecord = false;
  Game.snapCamera = true;
  showScreen(null);
  setRaceUI(true);
  accumulator = 0;
}

function showBanner(text, sub, color, time) {
  Game.banner = text;
  Game.banner2 = sub || '';
  Game.bannerColor = color || '#fff';
  Game.bannerTimer = time || 1.6;
}

/* Race callbacks (set once) */
Race.onImpact = function (strength) {
  if (!Game.vibration || Game.vibeCooldown > 0 || strength < 40 || Race.demo) return;
  Game.vibeCooldown = 0.25;
  try { if (navigator.vibrate) navigator.vibrate(Math.min(60, 15 + (strength * 0.1) | 0)); } catch (e) { /* ignore */ }
};

Race.onPlayerLap = function (car, lapTime, isPB) {
  // Persist best lap per track
  const id = Race.track.id;
  const rec = bestLapFor(id);
  if (rec === null || lapTime < rec) {
    Store.set('best.' + id, lapTime);
    Game.newRecord = true;
    showBanner('TRACK RECORD!', formatTime(lapTime), '#ffd23f', 2);
  } else if (isPB && car.lap > 1) {
    showBanner('BEST LAP', formatTime(lapTime), '#4dff7a');
  }
  if (!car.finished && car.lap === Race.laps - 1) {
    // The lap counter increments after this callback: the next lap is the last.
    if (Game.bannerTimer <= 0 || Game.banner === 'BEST LAP') showBanner('FINAL LAP', formatTime(lapTime));
  } else if (car.lap < Race.laps - 1 && Game.bannerTimer <= 0) {
    showBanner('LAP ' + (car.lap + 1) + '/' + Race.laps, formatTime(lapTime));
  }
};

Race.onPlayerFinish = function (car) {
  showBanner('FINISH!', ordinal(car.position) + ' place', car.position === 1 ? '#ffd23f' : '#fff', 2);
  Game.finishTimer = 1.8;
  Input.reset();
};

function showResults() {
  const p = Race.player;
  Game.state = 'results';
  setRaceUI(false);
  const pos = p.position;
  $('res-track').textContent = Race.track.name + ' · ' + CARS[p.carIndex].name;
  const posEl = $('res-pos');
  posEl.className = 'res-pos' + (pos === 1 ? ' p1' : '');
  posEl.innerHTML = pos + '<sup>' + ordinal(pos).slice(-2) + '</sup><small> / ' + Race.cars.length + '</small>';
  $('res-total').textContent = formatTime(p.finishTime);
  $('res-best').textContent = formatTime(p.bestLap);
  $('res-record').textContent = formatTime(bestLapFor(Race.track.id) || 0);
  $('res-new').classList.toggle('hidden', !Game.newRecord);
  const rows = [];
  for (let i = 0; i < Race.order.length; i++) {
    const c = Race.order[i];
    const def = CARS[c.carIndex];
    rows.push('<li class="' + (c.isPlayer ? 'me' : '') + '"><span class="pos">' + (i + 1) + '</span>' +
      '<span class="dot" style="background:' + def.color + '"></span>' +
      '<span class="nm">' + (c.isPlayer ? 'You (' + def.name + ')' : def.name) + '</span>' +
      '<span class="tm">' + (c.finished ? formatTime(c.finishTime) : 'racing') + '</span></li>');
  }
  $('res-standings').innerHTML = rows.join('');
  showScreen('results');
}

/* ---------- Pause ---------- */

function pause() {
  if (Game.paused || (Game.state !== 'race' && Game.state !== 'countdown')) return;
  Game.paused = true;
  Input.reset();
  showScreen('pause');
}

function resume() {
  if (!Game.paused) return;
  Game.paused = false;
  showScreen(null);
  Input.measure();
  lastTime = performance.now();
  accumulator = 0;
}

/* ===================================================================== */
/* Main loop                                                             */
/* ===================================================================== */

let lastTime = 0;
let accumulator = 0;
let fpsFrames = 0, fpsTime = 0;

function tick(dt) {
  switch (Game.state) {
    case 'menu':
      Race.update(dt, 0, 0);
      Renderer.emitParticles(Race);
      break;
    case 'countdown':
      Game.countdown -= dt;
      Race.snapPrev();
      if (Game.countdown <= 0) {
        Game.state = 'race';
        Game.goTimer = 0.9;
      }
      break;
    case 'race':
    case 'results':
      Input.update(dt);
      Race.update(dt, Input.steer, Input.brake);
      Renderer.emitParticles(Race);
      if (Game.goTimer > 0) Game.goTimer -= dt;
      if (Game.finishTimer > 0) {
        Game.finishTimer -= dt;
        if (Game.finishTimer <= 0 && Game.state === 'race') showResults();
      }
      break;
  }
  if (Game.bannerTimer > 0) Game.bannerTimer -= dt;
  if (Game.vibeCooldown > 0) Game.vibeCooldown -= dt;
  Renderer.updateParticles(dt);
}

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - lastTime) / 1000;
  lastTime = now;
  if (dt > 0.25) dt = 0.25;   // e.g. after a tab switch
  if (dt < 0) dt = 0;

  // FPS counter (updated twice a second)
  fpsFrames++; fpsTime += dt;
  if (fpsTime >= 0.5) { Renderer.fps = Math.round(fpsFrames / fpsTime); fpsFrames = 0; fpsTime = 0; }

  // Full-screen menus hide the canvas: skip the work entirely.
  if (Game.state === 'cars' || Game.state === 'tracks') return;

  if (!Game.paused) {
    accumulator += dt;
    let steps = 0;
    while (accumulator >= STEP) {
      tick(STEP);
      accumulator -= STEP;
      if (++steps >= MAX_STEPS_PER_FRAME) { accumulator = 0; break; }
    }
  }
  Renderer.drawFrame(Race, Game.paused ? 1 : accumulator / STEP, dt, Game);
}

/* ===================================================================== */
/* Setup                                                                 */
/* ===================================================================== */

function updateToggles() {
  $('opt-fps').innerHTML = 'FPS counter: <b>' + (Renderer.showFps ? 'ON' : 'OFF') + '</b>';
  $('opt-vibe').innerHTML = 'Vibration: <b>' + (Game.vibration ? 'ON' : 'OFF') + '</b>';
}

const isTouchLandscape = window.matchMedia('(orientation: landscape) and (hover: none) and (pointer: coarse)');

function onResize() {
  Renderer.resize();
  Input.measure();
  if (isTouchLandscape.matches) pause();
  if (cardsBuilt.cars && Game.state === 'cars') {
    const c = $('car-grid').querySelectorAll('.car-canvas');
    for (let i = 0; i < c.length; i++) Renderer.drawCarPreview(c[i], i);
  }
  if (cardsBuilt.tracks && Game.state === 'tracks') {
    const c = $('track-grid').querySelectorAll('.track-canvas');
    for (let i = 0; i < c.length; i++) Renderer.drawTrackPreview(c[i], getTrack(i));
  }
}

function init() {
  for (const name of ['menu', 'cars', 'tracks', 'pause', 'results']) screens[name] = $('screen-' + name);

  Game.carIdx = Math.min(CARS.length - 1, Math.max(0, Store.get('car', 0) | 0));
  Game.trackIdx = Math.min(TRACK_DEFS.length - 1, Math.max(0, Store.get('track', 0) | 0));
  Game.vibration = Store.get('vibration', true) !== false;
  Renderer.showFps = Store.get('fps', false) === true;

  Renderer.init($('game'));
  Input.init();
  Input.onPause = () => { if (Game.paused) resume(); else pause(); };

  // --- Buttons
  $('btn-play').addEventListener('click', goCars);
  $('opt-fps').addEventListener('click', () => { Renderer.showFps = !Renderer.showFps; Store.set('fps', Renderer.showFps); updateToggles(); });
  $('opt-vibe').addEventListener('click', () => {
    Game.vibration = !Game.vibration;
    Store.set('vibration', Game.vibration);
    updateToggles();
    if (Game.vibration) { try { if (navigator.vibrate) navigator.vibrate(30); } catch (e) { /* ignore */ } }
  });
  $('btn-cars-next').addEventListener('click', goTracks);
  $('btn-tracks-next').addEventListener('click', startRace);
  document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.goto === 'menu') goMenu(); else goCars();
  }));
  $('btn-pause').addEventListener('click', pause);
  $('btn-pause').addEventListener('touchstart', (e) => { e.preventDefault(); pause(); }, { passive: false });
  $('btn-resume').addEventListener('click', resume);
  $('btn-restart').addEventListener('click', startRace);
  $('btn-quit').addEventListener('click', goMenu);
  $('btn-again').addEventListener('click', startRace);
  $('btn-change-car').addEventListener('click', goCars);
  $('btn-change-track').addEventListener('click', goTracks);
  $('btn-menu').addEventListener('click', goMenu);
  updateToggles();

  // --- Stop the page from scrolling / zooming / showing menus
  document.addEventListener('touchmove', (e) => {
    if (!e.target.closest || !e.target.closest('.scroll')) e.preventDefault();
  }, { passive: false });
  document.addEventListener('gesturestart', (e) => e.preventDefault()); // iOS pinch
  document.addEventListener('dblclick', (e) => e.preventDefault());
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  // --- Resize / orientation / background
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 200));
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
  window.addEventListener('pagehide', pause);

  goMenu();
  lastTime = performance.now();
  requestAnimationFrame(frame);
}

init();
