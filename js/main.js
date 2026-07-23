// main.js — game shell: main menu → fullscreen showroom of every model.
// Owns: renderer, camera, lights, environment hookup, camera tween, the
// showroom scene, menu/pause UI, fullscreen + orientation, boot & test hooks.
// The editor era lives on in js/editor.js (not wired up — kept for reuse);
// physics.js is only loaded by the ?simtest=1 hook.
import * as THREE from 'three';
import { OrbitControls } from '../libs/OrbitControls.js';
import { RoomEnvironment } from '../libs/RoomEnvironment.js';
import { buildVehicle, REG } from './vehicles.js';
import { PROPS, SCENERY, buildProp } from './props.js';
import { buildRoad } from './roads.js';
import { signalAt } from './signals.js';
import { disposeGroup, clamp, makeRng, mergeByMaterial } from './lib.js';
import { initEnv, ENVS } from './env.js';
import { rollWeather, initWeather, applyWetness, WEATHER_KINDS } from './weather.js';
import { initVegetation } from './vegetation.js';
import { initFX } from './fx.js';
import * as Econ from './economy.js';
import * as Ach from './achievements.js';
import { generateMarkets } from './markets.js';
import * as Bet from './betui.js';
import { buildLoadout, drivePov, POV_META } from './povcam.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage');
// Reduced motion is a live setting, not a boot constant: the OS preference
// seeds it, and the in-game Motion toggle can turn it on for a player whose OS
// says nothing. The OS asking for reduced motion always wins — the toggle can
// enable it but never overrides an explicit system preference back to "full".
const osReduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let reduceMotion = osReduceMotion;
// P4/4F rain bed: the round's precip level for Sfx. Fed by startScene, zeroed
// with the rest of the weather on the way to the menu; frame() drives the
// actual gain (0 while frozen/reduced) through a change-guard so the audio
// duck envelopes are never re-scheduled mid-flight.
let rainLvl = 0, rainSet = -1;

/* ---------------- renderer / scene ---------------- */
// small screens get a lighter renderer: DPR cap 1.5 + 1024 shadow map
const smallScreen = Math.min(screen.width, screen.height) < 700;
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, smallScreen ? 1.5 : 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.18;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();

// 50° vertical (~79° horizontal at 16:9). FOV 33 was telephoto — it flattened
// depth and made every scene read as zoomed-in (ledger, P3 camera). fitCamera's
// distance is derived from camera.fov (and so are the flake sizing and fx), so
// widening self-corrects the framing; nothing hardcodes the old value.
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 700);
camera.position.set(13, 8.5, 13);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = true;
controls.minDistance = 2.2;
controls.maxDistance = 240;
controls.minPolarAngle = 0.15;
controls.maxPolarAngle = 1.5;
controls.target.set(0, 0.8, 0);

// render-on-demand: skip renderer.render when nothing moves
let needsRender = 3;
function invalidate() { needsRender = 2; }
controls.addEventListener('change', invalidate);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

// context-loss recovery: three re-uploads geometry/materials itself, but the
// PMREM env texture lives in a render target and must be rebuilt
renderer.domElement.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  toast('Graphics context lost — recovering…');
});
renderer.domElement.addEventListener('webglcontextrestored', () => {
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  invalidate();
  toast('Recovered');
});

const hemi = new THREE.HemisphereLight('#dfe6ee', '#4a4d53', 0.55);
scene.add(hemi);
const key = new THREE.DirectionalLight('#fff1de', 1.7);
key.position.set(6, 9, 4);
key.castShadow = true;
key.shadow.mapSize.set(smallScreen ? 1024 : 2048, smallScreen ? 1024 : 2048);
key.shadow.bias = -0.0002;
key.shadow.normalBias = 0.045;
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 80;
scene.add(key);
const fill = new THREE.DirectionalLight('#a9c0d8', 0.45);
fill.position.set(-6, 4, -5);
scene.add(fill);

/* ---------------- environment (ground + presets) ---------------- */
// BASE_EXPOSURE is the look-tuning baseline (CLAUDE.md); weather rides it as a
// multiplier rather than replacing it, so a clear scene is bit-for-bit the
// exposure the whole game was tuned against.
const BASE_EXPOSURE = 1.18;
const env = initEnv({
  scene, hemi, key, fill, invalidate, small: smallScreen,
  setExposure: (m) => { renderer.toneMappingExposure = BASE_EXPOSURE * (m || 1); },
  setEnvIntensity: (m) => { scene.environmentIntensity = m == null ? 1 : m; },
});
const weather = initWeather(scene, { small: smallScreen });
const veg = initVegetation(scene, { small: smallScreen });
// G6: the menu/garage backdrop rotates through the good-looking presets by
// day — the proving ground is a dev surface now, not the front door. Scenes
// always bring their own env; this only dresses the shell.
const MENU_ENVS = ['suburb', 'coastal', 'dusk', 'alpine', 'dawn', 'city', 'desert'];
env.apply(MENU_ENVS[new Date().getDate() % MENU_ENVS.length]);

/* ---------------- camera fitting / tween ---------------- */
let camFrom = null, camTo = null, camT = 1;
const easeInOut = (t) => t * t * (3 - 2 * t);

/* Fog scale rides the live camera, not the distance the establishing shot
   happened to pick. A dashcam used to inherit the wide shot's ×20, which pushed
   a fog bank meant to read at 40 m out past 700 m and deleted the weather from
   precisely the shots weather looks best in.

   The metric is distance to the round's BOX, not to its centre — that was the
   first version and it is wrong on exactly the scenes that matter. A dashcam on
   a car at the far end of a 150 m highway is 120 m from the centroid while
   sitting 2 m from what it is filming, so centre-distance handed it the wide
   shot's fog anyway. `distanceToPoint` is 0 anywhere inside the scene, so any
   camera among the cars gets the weather at full strength and only pulling back
   past the scene thins it.

   That is also what protects the product rule: the wide read stays clear at
   every weather, because backing off to see the whole scene is the same motion
   that pushes the fog away. Two number writes, monotonic in distance, so it is
   free to run per frame and cannot pop mid-tween. */
const fogBox = new THREE.Box3();
let fogK = -1;
// The floor is NOT 1, and that matters more than the camera term. The preset
// fog distances were authored when the world was a 90 m disc with nothing
// beyond it; now there is a landscape out to 300 m and vegetation that starts
// at 1.06 × playR. At ×1 a dashcam saw 114 m of fog and the entire world past
// it — hills, treeline, everything 1A and 1E build — was a grey wall. So the
// floor is the scene's own size in fog units: a big arena keeps its horizon, a
// small one still gets a close, atmospheric bank.
// /28 is calibrated, not picked: the preset far planes land near 75 m after a
// clear-weather boost, and a scene of radius R wants to see roughly 2.5 R of
// world, so the floor is R/28 ≈ 2.5R/75. On a 150 m arena that is ×5.4 → 400 m
// clear, while the `fog` kind (0.33 × base) still closes to 140 m — a real bank
// on a 150 m scene rather than a wall two car lengths away.
const fogFloor = () => clamp(env.groundRadius / 28, 1.5, 6);
function syncFogScale() {
  if (fogBox.isEmpty()) return false;
  const k = clamp(Math.max(fogBox.distanceToPoint(camera.position), 0) / 8, fogFloor(), 20);
  if (Math.abs(k - fogK) < 0.02) return false;
  fogK = k;
  env.setFogScale(k);
  return true;
}

function fitCamera(bb, instant) {
  const size = bb.getSize(new THREE.Vector3());
  const center = bb.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.z, size.y * 1.9);
  const dist = clamp((maxDim / 2) / Math.tan((camera.fov * Math.PI) / 360) * 0.98 + 0.9, 3.4, 220);
  const tgt = new THREE.Vector3(center.x, Math.min(size.y * 0.46, 2.2), center.z);
  const dir = camera.position.clone().sub(controls.target).normalize();
  const pos = tgt.clone().addScaledVector(dir, dist);
  if (instant || reduceMotion) {
    camera.position.copy(pos);
    controls.target.copy(tgt);
    camT = 1;
  } else {
    camFrom = { pos: camera.position.clone(), tgt: controls.target.clone() };
    camTo = { pos, tgt };
    camT = 0;
  }
  // fog follows the fitted distance so big scenes don't sink into it — seeded
  // from `dist` (where the camera is GOING) rather than from the live camera,
  // which during a tween is still back at the last shot. The box is cached so
  // syncFogScale can track the camera from here on.
  fogBox.copy(bb);
  fogK = clamp(dist / 8, fogFloor(), 20);
  env.setFogScale(fogK);
  // shadow frustum follows scene size
  const s = maxDim * 0.72 + 1.6;
  const sc = key.shadow.camera;
  sc.left = -s; sc.right = s; sc.top = s; sc.bottom = -s;
  sc.updateProjectionMatrix();
  // direction comes from the sky's sun (env.state.sunDir); this only owns how
  // far out to put it so the shadow frustum covers the scene
  key.position.copy(env.state.sunDir).multiplyScalar(maxDim * 0.9 + 12);
  key.shadow.camera.far = Math.max(80, maxDim * 2.2 + 30);
  invalidate();
}

/* ---------------- toast ---------------- */
let toastT = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------------- showroom: every model in one scene ----------------
   Flow layout on the ground disc: items are built, rotated to face the
   viewer (+Z), measured, and wrapped into rows; rows advance toward +Z so
   the section order back→front is scenery → props/roads → vehicles. */
let showroom = null, showroomBox = null;

function buildShowroom() {
  if (showroom) return;
  const root = new THREE.Group();
  const sections = [
    { gap: 2.6, items: SCENERY.map((e) => () => buildProp(e.id, '7').group) },
    {
      gap: 2.8,
      items: [
        ...PROPS.map((e) => () => buildProp(e.id).group),
        () => buildRoad({ w: 5, style: 6, pts: [{ x: -9, z: 1.6 }, { x: 0, z: -1.6 }, { x: 9, z: 1.6 }] }).group,
        () => buildRoad({ w: 5, style: 1, loop: 1, pts: [{ x: -6, z: -4 }, { x: 6, z: -4 }, { x: 6, z: 4 }, { x: -6, z: 4 }] }).group,
      ],
    },
    { gap: 2.2, items: REG.map((e) => () => buildVehicle('11', e.id).group) },
  ];
  const ROW_W = 100;
  const box = new THREE.Box3(), size = new THREE.Vector3();
  let z = 0;
  for (const sec of sections) {
    let x = -ROW_W / 2, rowDepth = 0;
    for (const make of sec.items) {
      const g = make();
      g.rotation.y = -Math.PI / 2; // model forward (+X) → face the viewer (+Z)
      box.setFromObject(g);
      box.getSize(size);
      const w = size.x + sec.gap;
      if (x + w > ROW_W / 2 && x > -ROW_W / 2) { // wrap to a new row
        z += rowDepth + 3;
        rowDepth = 0;
        x = -ROW_W / 2;
      }
      g.position.x += x - box.min.x + sec.gap / 2;
      g.position.z += z - box.min.z;
      x += w;
      rowDepth = Math.max(rowDepth, size.z);
      root.add(g);
    }
    z += rowDepth + 7; // section break
  }
  // centre the whole field on the ground disc
  box.setFromObject(root);
  box.getCenter(size);
  root.position.x = -size.x;
  root.position.z = -size.z;
  scene.add(root);
  showroom = root;
  showroomBox = new THREE.Box3().setFromObject(root);
  // The Garage is display-only — nothing here is targeted, deformed or posed —
  // so it merges across the WHOLE field by material parameters. Per-build
  // `matFactory` caches mean 280 models ship 280 separate "black rubber"
  // materials, and merging by identity could never join them; by parameters
  // they collapse. This is also the one place vehicles may be merged: the ban
  // exists for deform.js weld groups, and nothing in here is ever crashed.
  mergeByMaterial(root, { byParams: true });
  freezeMatrices(root);
}

/* The showroom has to LEAVE the scene, not just go invisible.
   `visible = false` is a render-time cull and the renderer's own
   `scene.updateMatrixWorld()` walk ignores it — and that walk recurses into
   every child unconditionally. So 280 models nobody was looking at cost a
   7 321-node traversal on every frame of every round: measured at 2.3 ms, about
   30 % of the frame. `visible` is kept in step because other code reads it. */
function showShowroom(on) {
  if (!showroom) return;
  showroom.visible = on;
  if (on && !showroom.parent) scene.add(showroom);
  else if (!on && showroom.parent) scene.remove(showroom);
}

/* Stop paying for a static subtree every frame.
   `matrixAutoUpdate = false` per NODE is the knob — it skips the `updateMatrix()`
   call, which is the actual per-node work. `matrixWorldAutoUpdate` on the root
   is NOT: in r169 it only guards whether that one node composes its own
   `matrixWorld`; the child recursion below it runs unconditionally (three.module
   .js:7778). Setting it on the showroom root measured exactly zero, which is how
   this was caught.
   Only safe on content whose transforms never change after build — anything the
   sim poses each tick must stay live. */
function freezeMatrices(obj) {
  if (!obj) return;
  obj.updateMatrixWorld(true);
  obj.traverse((o) => { o.matrixAutoUpdate = false; });
}

/* ---------------- game flow: menu → showroom ---------------- */
let inGame = false;

async function startGame(wantFullscreen = true) {
  if (wantFullscreen && !document.fullscreenElement) {
    try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch {}
    try { await screen.orientation.lock('landscape'); } catch {}
  }
  buildShowroom();
  showShowroom(true); // may have been hidden by crash mode or a round
  setCamMode('orbit'); // the entry tween needs OrbitControls in charge
  inGame = true;
  document.body.classList.add('ingame');
  $('menu').hidden = true;
  $('hud').hidden = false;
  $('pause').hidden = true;
  camera.position.set(30, 46, 120);
  controls.target.set(0, 0, 0);
  fitCamera(showroomBox, true);
  invalidate();
}

function leaveGame() {
  setCamMode('orbit');
  inGame = false;
  if (crash) destroyCrashSim();
  if (round) destroyRound();
  document.body.classList.remove('ingame', 'crashmode', 'roundmode');
  Bet.closeRound();
  $('crashui').hidden = true;
  $('roundui').hidden = true;
  $('pause').hidden = true;
  $('hud').hidden = true;
  $('menu').hidden = false;
  syncMenu(); // bankroll / round-in-progress state may have moved
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  try { screen.orientation.unlock(); } catch {}
}

/* ---------------- pause menu ---------------- */
function showPause(show) {
  $('pause').hidden = !show;
  if (show) {
    if (document.exitPointerLock) document.exitPointerLock(); // free the cursor for the menu
    $('pauseMain').hidden = false;
    $('pauseSettings').hidden = true;
    syncFsLabel();
  }
}
$('garageBtn').addEventListener('click', () => startGame(true));
$('hamb').addEventListener('click', () => showPause(true));
$('p_resume').addEventListener('click', () => showPause(false));
$('p_leave').addEventListener('click', leaveGame);
$('pause').addEventListener('click', (e) => { if (e.target === $('pause')) showPause(false); });
$('p_settings').addEventListener('click', () => {
  $('pauseMain').hidden = true;
  $('pauseSettings').hidden = false;
});
$('p_back').addEventListener('click', () => {
  $('pauseMain').hidden = false;
  $('pauseSettings').hidden = true;
});

function syncFsLabel() {
  $('p_fs').textContent = document.fullscreenElement ? 'Exit Fullscreen' : 'Fullscreen';
}
$('p_fs').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      try { await screen.orientation.lock('landscape'); } catch {}
    }
  } catch {}
  syncFsLabel();
});
document.addEventListener('fullscreenchange', syncFsLabel);

/* ---------------- settings ----------------
   G6: no environment picker any more — the SCENE owns its environment (the
   director deals it per seed), and letting a Settings chip override it was
   both a spoiler surface and a mismatch with what the odds were priced on. */
let quality = smallScreen ? 'low' : 'high';
/* Quality tiers (1H). Previously this moved only DPR and shadows on/off, forced
   a shader recompile of every material on EVERY call, and was never saved — so
   it reset to the screen-size guess on every boot and none of the density knobs
   the world-building phases added had a tier to hang off.
   Now it owns DPR, shadow map size, vegetation density and precipitation
   budget, and it persists. The recompile only happens when `shadowMap.enabled`
   actually flips, which is the one change that alters the shader. */
const TIERS = {
  low: { dpr: 1, shadow: false, map: 1024, veg: 0.4, precip: 0.5 },
  high: { dpr: null, shadow: true, map: null, veg: 1, precip: 1 },
};
let qualityLive = false; // set once the profile and round bindings exist
function tier() { return TIERS[quality] || TIERS.high; }
function applyQuality(q, save = true) {
  const t = TIERS[q] ? q : 'high';
  const prevShadow = renderer.shadowMap.enabled;
  quality = t;
  const cfg = TIERS[t];
  renderer.setPixelRatio(cfg.dpr || Math.min(devicePixelRatio, smallScreen ? 1.5 : 2));
  renderer.shadowMap.enabled = cfg.shadow;
  const map = cfg.map || (smallScreen ? 1024 : 2048);
  if (key.shadow.mapSize.x !== map) {
    key.shadow.mapSize.set(map, map);
    if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
  }
  // a full material recompile is a real stall — only the shadow flag needs it
  if (prevShadow !== cfg.shadow) scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
  weather.setBudget(cfg.precip);
  // `qualityLive` short-circuits before `round` is evaluated: this runs once at
  // module scope, above the `let round` declaration, and reading it there is a
  // temporal-dead-zone throw rather than an undefined
  if (qualityLive && round) veg.build(env.terrainField, round.seed, { density: cfg.veg, value: env.terrainValue });
  $('set_quality').querySelectorAll('.mchip').forEach((c) => c.classList.toggle('sel', c.dataset.q === t));
  if (save) saveSetting('quality', t);
  invalidate();
}
$('set_quality').querySelectorAll('.mchip').forEach((b) => {
  b.addEventListener('click', () => applyQuality(b.dataset.q));
});
applyQuality(quality, false); // no profile yet — applySavedSettings lands the real tier

/* ---------------- volume + motion settings (G5) ----------------
   Both persist in profile.settings, so they survive a reload but are wiped by
   "New run" along with everything else. Volume reaches the audio graph through
   fx's master gain — there is no second mixer. */
function saveSetting(k, v) {
  if (!profile) return;
  profile.settings[k] = v;
  Econ.saveProfile(store, profile);
}

function applyVolume(pct, persist) {
  const v = clamp(Math.round(pct), 0, 100);
  $('set_vol').value = String(v);
  $('set_volN').textContent = v + '%';
  if (crashFx) crashFx.sfx.setVolume(v / 100);
  if (persist) saveSetting('volume', v);
}
$('set_vol').addEventListener('input', (e) => {
  applyVolume(parseInt(e.target.value, 10), true);
  if (crashFx) crashFx.sfx.ui('tick'); // audible feedback while dragging
});

function applyMotion(mode, persist) {
  // the OS preference is a floor, not a default the toggle can undo
  reduceMotion = osReduceMotion || mode === 'reduced';
  document.body.classList.toggle('reduced-motion', reduceMotion);
  $('set_motion').querySelectorAll('.mchip')
    .forEach((c) => c.classList.toggle('sel', c.dataset.motion === (reduceMotion ? 'reduced' : 'full')));
  if (persist) saveSetting('motion', mode);
}
$('set_motion').querySelectorAll('.mchip').forEach((b) => {
  b.addEventListener('click', () => applyMotion(b.dataset.motion, true));
});

// restore both from the profile once it exists (initProfile runs further down)
function applySavedSettings() {
  const s = (profile && profile.settings) || {};
  applyVolume(s.volume === undefined ? 50 : s.volume, false);
  applyMotion(s.motion || (osReduceMotion ? 'reduced' : 'full'), false);
  // quality persists now — it used to reset to the screen-size guess on every
  // boot, so a player who picked Low on a hot laptop got High back every time
  qualityLive = true;
  applyQuality(s.quality || (smallScreen ? 'low' : 'high'), false);
}

/* ---------------- freecam ----------------
   Orbit is the default; freecam is a true fly camera. Desktop: pointer-lock
   mouse look + WASD (Space/Ctrl or E/Q vertical, Shift boost, wheel = speed).
   Touch: fixed left joystick flies along the look direction, right-side drag
   looks around, ▲▼ buttons change altitude. Velocity is smoothed so motion
   eases in/out; render-on-demand still sleeps when the camera is at rest. */
const FINE_PTR = matchMedia('(pointer: fine)');
const fly = {
  on: false, yaw: 0, pitch: 0, speed: 26,
  keys: new Set(), vel: new THREE.Vector3(),
  joy: { x: 0, y: 0, id: null }, upBtn: 0,
  look: null, // active touch-look pointer { id, x, y }
};
const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _tvel = new THREE.Vector3();

function syncCamUI() {
  $('set_cam').querySelectorAll('.mchip').forEach((c) => c.classList.toggle('sel', (c.dataset.cam === 'fly') === fly.on));
  $('camBtn').classList.toggle('on', fly.on);
}

function requestLock() {
  try {
    const p = renderer.domElement.requestPointerLock({ unadjustedMovement: true });
    if (p && p.catch) p.catch(() => { try { renderer.domElement.requestPointerLock(); } catch {} });
  } catch { try { renderer.domElement.requestPointerLock(); } catch {} }
}

function setCamMode(mode) {
  const want = mode === 'fly';
  if (fly.on === want) { syncCamUI(); return; }
  fly.on = want;
  document.body.classList.toggle('flycam', want);
  if (want) {
    // entering freecam: any scripted POV must let go. drivePov runs every frame
    // while activePov is set and would override the freecam position outright,
    // which is why freecam and the C key were silently dead under a POV (#8).
    if (activePov) { activePov = null; $('povfx').className = ''; renderPovBar(); }
    camera.getWorldDirection(_fwd);
    fly.yaw = Math.atan2(-_fwd.x, -_fwd.z);
    fly.pitch = Math.asin(clamp(_fwd.y, -1, 1));
    fly.vel.set(0, 0, 0);
    fly.keys.clear();
    controls.enabled = false;
    camT = 1; // cancel any camera tween
    if (FINE_PTR.matches) {
      requestLock();
      toast('Freecam — WASD fly · Space/Ctrl up/down · Shift boost · scroll speed · C = orbit');
    } else {
      toast('Freecam — left stick to fly · drag right side to look · ▲▼ altitude');
    }
  } else {
    if (document.exitPointerLock) document.exitPointerLock();
    controls.enabled = true;
    camera.getWorldDirection(_fwd);
    controls.target.copy(camera.position).addScaledVector(_fwd, 16);
    controls.target.y = clamp(controls.target.y, 0.4, 40);
    toast('Orbit camera');
  }
  syncCamUI();
  invalidate();
}

// look: pointer-lock mouse on desktop
document.addEventListener('mousemove', (e) => {
  if (!fly.on || document.pointerLockElement !== renderer.domElement) return;
  fly.yaw -= e.movementX * 0.0023;
  fly.pitch = clamp(fly.pitch - e.movementY * 0.0023, -1.5, 1.5);
  invalidate();
});
renderer.domElement.addEventListener('click', () => {
  if (fly.on && inGame && FINE_PTR.matches && document.pointerLockElement !== renderer.domElement) requestLock();
});
stage.addEventListener('wheel', (e) => {
  if (!fly.on || !inGame) return;
  e.preventDefault();
  fly.speed = clamp(fly.speed * (e.deltaY > 0 ? 1 / 1.18 : 1.18), 5, 140);
  toast(`Fly speed ${Math.round(fly.speed)} m/s`);
}, { passive: false });

// look: right-half touch drag
stage.addEventListener('pointerdown', (e) => {
  if (!fly.on || !inGame || e.pointerType === 'mouse') return;
  if (fly.look === null && e.clientX > innerWidth * 0.4) {
    fly.look = { id: e.pointerId, x: e.clientX, y: e.clientY };
  }
});
addEventListener('pointermove', (e) => {
  if (fly.look && e.pointerId === fly.look.id) {
    fly.yaw -= (e.clientX - fly.look.x) * 0.005;
    fly.pitch = clamp(fly.pitch - (e.clientY - fly.look.y) * 0.005, -1.5, 1.5);
    fly.look.x = e.clientX;
    fly.look.y = e.clientY;
    invalidate();
  }
});
const endLook = (e) => { if (fly.look && e.pointerId === fly.look.id) fly.look = null; };
addEventListener('pointerup', endLook);
addEventListener('pointercancel', endLook);

// move: fixed virtual joystick (touch)
{
  const joy = $('joy'), nub = $('joynub');
  const setNub = () => { nub.style.transform = `translate(calc(-50% + ${fly.joy.x * 40}px), calc(-50% + ${fly.joy.y * 40}px))`; };
  joy.addEventListener('pointerdown', (e) => {
    fly.joy.id = e.pointerId;
    joy.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  joy.addEventListener('pointermove', (e) => {
    if (e.pointerId !== fly.joy.id) return;
    const rect = joy.getBoundingClientRect();
    const dx = e.clientX - (rect.left + rect.width / 2);
    const dy = e.clientY - (rect.top + rect.height / 2);
    const len = Math.hypot(dx, dy) || 1;
    const k = Math.min(1, len / 44);
    fly.joy.x = (dx / len) * k;
    fly.joy.y = (dy / len) * k;
    setNub();
    invalidate();
  });
  const endJoy = (e) => {
    if (e.pointerId !== fly.joy.id) return;
    fly.joy.id = null;
    fly.joy.x = 0; fly.joy.y = 0;
    setNub();
  };
  joy.addEventListener('pointerup', endJoy);
  joy.addEventListener('pointercancel', endJoy);
  for (const [id, v] of [['flyUp', 1], ['flyDown', -1]]) {
    const b = $(id);
    b.addEventListener('pointerdown', (e) => { fly.upBtn = v; b.setPointerCapture(e.pointerId); e.preventDefault(); });
    for (const ev of ['pointerup', 'pointercancel']) b.addEventListener(ev, () => { fly.upBtn = 0; });
  }
}

$('camBtn').addEventListener('click', () => setCamMode(fly.on ? 'orbit' : 'fly'));
$('set_cam').querySelectorAll('.mchip').forEach((b) => {
  b.addEventListener('click', () => { setCamMode(b.dataset.cam); showPause(false); });
});

function flyUpdate(dt) {
  if (!fly.on || !inGame) return false;
  camera.rotation.order = 'YXZ';
  camera.rotation.set(fly.pitch, fly.yaw, 0);
  if (!$('pause').hidden) return false; // paused: hold position
  const k = fly.keys;
  let mx = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
  let mz = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
  let my = (k.has('Space') || k.has('KeyE') ? 1 : 0) - (k.has('ControlLeft') || k.has('ControlRight') || k.has('KeyQ') ? 1 : 0);
  mx += fly.joy.x;
  mz -= fly.joy.y;
  my += fly.upBtn;
  const boost = (k.has('ShiftLeft') || k.has('ShiftRight')) ? 3 : 1;
  _fwd.set(0, 0, -1).applyEuler(camera.rotation);
  _right.set(1, 0, 0).applyEuler(camera.rotation);
  _tvel.set(0, 0, 0).addScaledVector(_fwd, mz).addScaledVector(_right, mx);
  _tvel.y += my;
  if (_tvel.lengthSq() > 1) _tvel.normalize();
  _tvel.multiplyScalar(fly.speed * boost);
  fly.vel.lerp(_tvel, 1 - Math.pow(0.0005, dt)); // smooth accel + decel
  if (_tvel.lengthSq() === 0 && fly.vel.lengthSq() < 0.004) {
    fly.vel.set(0, 0, 0);
    return false;
  }
  camera.position.addScaledVector(fly.vel, dt);
  camera.position.x = clamp(camera.position.x, -420, 420);
  camera.position.y = clamp(camera.position.y, 0.35, 300);
  camera.position.z = clamp(camera.position.z, -420, 420);
  return true;
}

/* ---------------- crash test mode ----------------
   The reason the game exists: deterministic wrecks with the full effects
   stack. Physics (Rapier, 2.2 MB) loads lazily on first entry; scenes are
   seeded per (scene, run) so Replay repeats the exact crash and Next both
   advances the scene and rerolls the cast. */
let crash = null;          // { sim, mod }
let crashFx = null;        // effects layer (created once, reused)
let crashLoading = false;
let crashSceneIdx = 0, crashRun = 0;
let crashUserSlow = false, crashMuted = false;
let crashSlowT = 0, crashSlowLast = 0; // auto slow-mo window (wall clock)
let crashPushed = false; // one camera push-in per run, on the first big hit
let crashIdleT = 0, dmgT = 0;
const _crashC = new THREE.Vector3();
const catOfId = (id) => (REG.find((e) => e.id === id) || {}).cat || 'Cars';

const FAST = ['muscle', 'sedan', 'sports', 'hothatch', 'coupe', 'taxi', 'police', 'rally', 'stockcar', 'gtcoupe'];
const CIVIC = ['sedan', 'hatch', 'wagon', 'suv', 'minivan', 'pickup', 'coupe', 'micro', 'lowrider'];
const HEAVY = ['citybus', 'schoolbus', 'boxtruck', 'flatbed', 'garbage', 'firetruck', 'semibox', 'tanker'];
const seedOf = (rng) => String(rng.int(1, 9999));

const CRASH_SCENES = [
  {
    label: 'Head-On', make(rng) {
      const v = () => 26 + rng.int(0, 6);
      return {
        cars: [
          { seed: seedOf(rng), type: rng.pick(FAST), x: -27, z: 0, heading: 0, speed: v(), throttle: 1, steer: 0, brake: 2.8 },
          { seed: seedOf(rng), type: rng.pick(rng.chance(0.3) ? HEAVY : FAST), x: 27, z: 0.5, heading: Math.PI, speed: v(), throttle: 1, steer: 0, brake: 2.8 },
        ],
      };
    },
  },
  {
    label: 'T-Bone', make(rng) {
      return {
        cars: [
          { seed: seedOf(rng), type: rng.pick(CIVIC), x: -27, z: 0, heading: 0, speed: 25, throttle: 1, steer: 0, brake: 2.6 },
          { seed: seedOf(rng), type: rng.pick(FAST), x: 1, z: -27, heading: -Math.PI / 2, speed: 26, throttle: 1, steer: 0, brake: 2.8 },
        ],
      };
    },
  },
  {
    label: 'Pileup', make(rng) {
      const cars = [{ seed: seedOf(rng), type: rng.pick(HEAVY), x: 14, z: 0, heading: 0, speed: 0, throttle: 0, steer: 0 }];
      for (let i = 0; i < 5; i++) {
        cars.push({
          seed: seedOf(rng), type: rng.pick(i ? CIVIC : FAST), x: -16 - i * 11, z: rng.range(-0.9, 0.9),
          heading: 0, speed: 24 + i * 2, throttle: 1, steer: 0, delay: i * 0.22, brake: 3.2 + i * 0.2,
        });
      }
      return { cars };
    },
  },
  {
    label: 'Ramp Jump', make(rng) {
      return {
        props: [
          { kind: 'ramp', x: 0, z: 0, heading: 0 },
          { kind: 'boxes', x: 13, z: 0.5, heading: 0.25 },
        ],
        cars: [
          { seed: seedOf(rng), type: rng.pick(FAST), x: -32, z: 0, heading: 0, speed: 30 + rng.int(0, 4), throttle: 1, steer: 0, brake: 4 },
          { seed: seedOf(rng), type: rng.pick(CIVIC), x: 20, z: 0.3, heading: 0, speed: 0, throttle: 0, steer: 0 },
        ],
      };
    },
  },
  {
    label: 'Pole & Hydrant', make(rng) {
      return {
        props: [
          { kind: 'pole', x: 8, z: 0.1, heading: 0 },
          { kind: 'hydrant', x: 11, z: -1.4, heading: 0, seed: seedOf(rng) },
          { kind: 'sign_stop', x: 13.5, z: 1.3, heading: 0.4, seed: seedOf(rng) },
          { kind: 'cone', x: 5.5, z: 1.1, heading: 0, seed: seedOf(rng) },
          { kind: 'cone', x: 6.5, z: -1.2, heading: 0.7, seed: seedOf(rng) },
        ],
        cars: [
          { seed: seedOf(rng), type: rng.pick(FAST), x: -28, z: 0, heading: 0, speed: 29 + rng.int(0, 4), throttle: 1, steer: 0, brake: 2.2 },
        ],
      };
    },
  },
  {
    label: 'Wall Slam', make(rng) {
      return {
        world: { arena: 56, walls: true },
        cars: [
          { seed: seedOf(rng), type: rng.pick(FAST), x: -18, z: -4, heading: 0.28, speed: 32, throttle: 1, steer: 0, brake: 2.5 },
          { seed: seedOf(rng), type: rng.pick(CIVIC), x: 16, z: 8, heading: Math.PI - 0.35, speed: 27, throttle: 1, steer: 0.05, delay: 0.35, brake: 3 },
        ],
      };
    },
  },
  {
    label: 'Intersection Chaos', make(rng) {
      const T = [rng.pick(FAST), rng.pick(CIVIC), rng.pick(CIVIC), rng.pick(rng.chance(0.4) ? HEAVY : FAST)];
      return {
        cars: [
          { seed: seedOf(rng), type: T[0], x: -27, z: 0.3, heading: 0, speed: 25, throttle: 1, steer: 0, brake: 2.6 },
          { seed: seedOf(rng), type: T[1], x: 27, z: -0.8, heading: Math.PI, speed: 23, throttle: 1, steer: 0, delay: 0.1, brake: 2.8 },
          { seed: seedOf(rng), type: T[2], x: 0.8, z: -27, heading: -Math.PI / 2, speed: 26, throttle: 1, steer: 0, delay: 0.05, brake: 2.6 },
          { seed: seedOf(rng), type: T[3], x: -0.5, z: 27, heading: Math.PI / 2, speed: 22, throttle: 1, steer: 0, delay: 0.2, brake: 3 },
        ],
      };
    },
  },
  {
    label: 'Suburb Rampage', async make(rng) {
      const W = await import('./worldgen.js');
      const g = W.generateWorld('suburb', seedOf(rng), {
        maxProps: smallScreen ? 18 : 40, maxRoads: smallScreen ? 3 : 6,
      });
      return {
        world: { arena: g.world.arena, walls: true },
        roads: g.roads,
        props: g.props,
        cars: [
          { seed: seedOf(rng), type: rng.pick(['pickup', 'monster', 'muscle', 'semibox']), x: 0, z: 0, heading: 0.5, speed: 24, throttle: 1, steer: 0.03, brake: 9 },
          { seed: seedOf(rng), type: rng.pick(CIVIC), x: -14, z: -10, heading: 0.2, speed: 20, throttle: 1, steer: -0.02, delay: 0.8, brake: 8 },
        ],
      };
    },
  },
];

async function buildCrashScenario(idx, run) {
  const rng = makeRng('crash:' + idx + ':' + run);
  return await CRASH_SCENES[idx].make(rng);
}

// fx owns the sim hooks; main chains cinematics (auto slow-mo) onto impact
function hookCrashSim(sim) {
  crashFx.attach(sim);
  const fxImpact = sim.onImpact;
  sim.onImpact = (car, ev) => {
    fxImpact(car, ev);
    const now = performance.now();
    if (ev.dv > 6.5 && !crashUserSlow && now > crashSlowLast + 5000) {
      sim.speed = 0.28; // wall-clock pacing only — sim steps stay identical
      crashSlowT = now + 1200;
      crashSlowLast = now;
    }
    // cinematic push-in: the establishing shot frames the whole approach, so
    // the first real hit tweens the camera down to wreck scale (orbit only —
    // never yank a freecam user)
    if (ev.dv > 5 && !crashPushed) {
      crashPushed = true;
      if (!fly.on) {
        fitCamera(new THREE.Box3(
          new THREE.Vector3(ev.point.x - 9, 0, ev.point.z - 9),
          new THREE.Vector3(ev.point.x + 9, 4.5, ev.point.z + 9),
        ), false);
      }
    }
  };
}

function crashBox() {
  const bb = new THREE.Box3();
  for (const car of crash.sim.cars) bb.expandByPoint(car.wrap.position);
  bb.expandByScalar(13);
  bb.min.y = 0;
  bb.max.y = Math.max(bb.max.y, 6);
  return bb;
}

function destroyCrashSim() {
  if (!crash) return;
  crashFx.reset();
  crashFx.detachSim();
  scene.remove(crash.sim.root);
  crash.sim.dispose();
  crash = null;
}

function spawnCrash(sim, mod, instant) {
  crash = { sim, mod };
  scene.add(sim.root);
  hookCrashSim(sim);
  sim.speed = crashUserSlow ? 0.3 : 1;
  sim.playing = true;
  crashIdleT = 0;
  crashPushed = false;
  crashSlowT = 0;
  camera.position.set(controls.target.x + 20, 13, controls.target.z + 24);
  fitCamera(crashBox(), instant);
  $('dmgHud').textContent = '💥 0';
  toast(`💥 ${CRASH_SCENES[crashSceneIdx].label} — ${crashSceneIdx + 1}/${CRASH_SCENES.length}`);
  invalidate();
}

async function startCrash(wantFullscreen = true) {
  if (crashLoading) return;
  crashLoading = true;
  try {
    if (wantFullscreen && !document.fullscreenElement) {
      try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch {}
      try { await screen.orientation.lock('landscape'); } catch {}
    }
    const mod = await import('./physics.js');
    const R = await mod.loadRapier();
    if (!crashFx) crashFx = initFX(scene, { small: smallScreen });
    crashFx.unlockAudio();
    // ?crash=N boots without a user gesture, so the context starts suspended —
    // the first tap/click anywhere unlocks it
    addEventListener('pointerdown', () => crashFx && crashFx.unlockAudio(), { once: true });
    crashFx.sfx.mute(crashMuted);
    const scenario = await buildCrashScenario(crashSceneIdx, crashRun);
    destroyCrashSim();
    setCamMode('orbit');
    inGame = true;
    document.body.classList.add('ingame', 'crashmode');
    $('menu').hidden = true;
    $('hud').hidden = false;
    $('pause').hidden = true;
    $('crashui').hidden = false;
    showShowroom(false);
    spawnCrash(new mod.CrashSim(R, scenario, catOfId), mod, true);
  } catch (e) {
    console.error('crash mode failed', e);
    toast('Crash mode failed to load');
  } finally {
    crashLoading = false;
  }
}

async function nextCrash(step) {
  if (!crash || crashLoading) return;
  crashLoading = true;
  try {
    crashSceneIdx = (crashSceneIdx + step + CRASH_SCENES.length) % CRASH_SCENES.length;
    crashRun++;
    const scenario = await buildCrashScenario(crashSceneIdx, crashRun);
    const mod = crash.mod;
    destroyCrashSim();
    const R = await mod.loadRapier(); // cached
    spawnCrash(new mod.CrashSim(R, scenario, catOfId), mod, false);
  } finally {
    crashLoading = false;
  }
}

function replayCrash() {
  if (!crash || crashLoading) return;
  crashFx.reset();
  crash.sim.reset(); // perfect reset — same scenario, bit-identical rerun
  hookCrashSim(crash.sim);
  crash.sim.speed = crashUserSlow ? 0.3 : 1; // drop any leftover auto slow-mo
  crash.sim.playing = true;
  crashIdleT = 0;
  crashPushed = false;
  crashSlowT = 0;
  fitCamera(crashBox(), false);
  $('dmgHud').textContent = '💥 0';
  toast('⟳ Replay');
  invalidate();
}

function toggleCrashSlow() {
  if (!crash) return;
  crashUserSlow = !crashUserSlow;
  crashSlowT = 0;
  crash.sim.speed = crashUserSlow ? 0.3 : 1;
  $('cSlow').classList.toggle('on', crashUserSlow);
  toast(crashUserSlow ? '🐢 Slow motion' : 'Full speed');
}

$('crashBtn').addEventListener('click', () => startCrash(true));
$('cReplay').addEventListener('click', replayCrash);
$('cNext').addEventListener('click', () => nextCrash(1));
$('cSlow').addEventListener('click', toggleCrashSlow);
$('cMute').addEventListener('click', () => {
  crashMuted = !crashMuted;
  if (crashFx) crashFx.sfx.mute(crashMuted);
  $('cMute').textContent = crashMuted ? '🔇' : '🔊';
  $('cMute').classList.toggle('off', crashMuted);
});

// per-frame crash update — called from animate()
function crashUpdate(dt, now) {
  if (!crash || !inGame) return false;
  if (crashSlowT && now > crashSlowT) {
    crash.sim.speed = crashUserSlow ? 0.3 : 1;
    crashSlowT = 0;
  }
  if (!$('pause').hidden) return false; // paused: freeze sim + fx
  let busy = false;
  crash.sim.update(dt);
  crash.sim.syncVisuals();
  if (crashFx.update(dt, camera)) busy = true;
  if (crash.sim.playing) {
    busy = true;
    // gentle auto-follow keeps the wreck centered (orbit mode only) — paused
    // while a fitCamera tween owns controls.target, same as the round path (#7)
    if (!fly.on && camT >= 1 && crash.sim.cars.length) {
      _crashC.set(0, 0, 0);
      for (const car of crash.sim.cars) _crashC.add(car.wrap.position);
      _crashC.divideScalar(crash.sim.cars.length);
      _crashC.y = Math.min(_crashC.y + 0.6, 3);
      controls.target.lerp(_crashC, 1 - Math.pow(0.25, dt));
    }
    // damage ticker + auto-sleep once everything (debris included) settles
    if (now - dmgT > 250) {
      dmgT = now;
      let total = 0, vmax = 0;
      for (const car of crash.sim.cars) {
        total += car.damage;
        const lv = car.body.linvel();
        vmax = Math.max(vmax, Math.abs(lv.x), Math.abs(lv.y), Math.abs(lv.z));
      }
      for (const d of crash.sim.debris) {
        const lv = d.body.linvel();
        vmax = Math.max(vmax, Math.abs(lv.x), Math.abs(lv.y), Math.abs(lv.z));
      }
      $('dmgHud').textContent = `💥 ${Math.round(total * 10)}`;
      crashIdleT = vmax < 0.06 ? crashIdleT + 0.25 : 0;
      if (crashIdleT > 2.5) crash.sim.playing = false; // render-on-demand sleeps again
    }
  }
  return busy;
}

/* ---------------- boot preloader ----------------
   Everything the first round needs is warmed here so no round ever pays a
   lazy-load stall mid-scene: the physics module + Rapier wasm (2.2 MB), the
   fx pools, and the showroom build. Start Game stays disabled until done.
   The same progress UI is reused for the per-round pre-sim beat below. */
let engine = null; // { mod, R } once physics is ready
let preloaded = false;

/* ONE progress component, three uses (spec G5): the boot preload, the
   per-round pre-sim beat, and scene loading. They differ in where they mount,
   never in what they are — see .pbar/.pfill in the stylesheet. */
function makeProgress({ root, fill, label, sub }) {
  const elFill = $(fill);
  const elLabel = label ? $(label) : null;
  const elSub = sub ? $(sub) : null;
  const elRoot = root ? $(root) : null;
  return {
    show(on) { if (elRoot) elRoot.hidden = !on; },
    set(pct, labelTxt, subTxt) {
      if (pct !== undefined) elFill.style.width = Math.round(clamp(pct, 0, 1) * 100) + '%';
      if (labelTxt !== undefined && elLabel) elLabel.textContent = labelTxt;
      if (subTxt !== undefined && elSub) elSub.textContent = subTxt;
    },
  };
}
const bootProgress = makeProgress({ fill: 'bootfill', label: 'bootmsg' });
const roundProgress = makeProgress({ root: 'loading', fill: 'loadfill', label: 'loadlabel', sub: 'loadsub' });

const bootStep = (pct, msg) => bootProgress.set(pct, msg);

async function preload() {
  try {
    bootStep(0.08, 'loading physics engine…');
    const mod = await import('./physics.js');
    bootStep(0.45, 'starting rapier…');
    const R = await mod.loadRapier();
    engine = { mod, R };
    bootStep(0.62, 'warming effects…');
    if (!crashFx) crashFx = initFX(scene, { small: smallScreen });
    applySavedSettings(); // the audio graph exists now — push the saved volume in
    await new Promise((r) => setTimeout(r, 0)); // let the frame breathe
    bootStep(0.78, 'building the yard…');
    buildShowroom();
    bootStep(1, 'ready');
    preloaded = true;
    $('boot').classList.add('done');
    for (const id of ['startBtn', 'seedBtn', 'garageBtn', 'crashBtn', 'dailyBtn', 'statsBtn']) $(id).disabled = false;
    $('menutag').textContent = 'bet on the physics';
    syncMenu();
  } catch (e) {
    console.error('preload failed', e);
    bootStep(1, 'failed to load — reload the page');
  }
}

/* ---------------- scene round (G1) ----------------
   deal → pre-sim (loading beat) → 10 s preview → freeze at the incident
   tick → resolve to rest → outcome card. The pre-sim and the live view are
   two separate sims built from the SAME scenario; determinism makes the
   recorded event log describe exactly what the player watches. */
let round = null; // { sim, scene, rec, markets, phase, seed, d, exhibition }
let roundLoading = false;
let roundSeedN = 0;

/* ---------------- profile / bankroll (G3) ----------------
   One profile per browser, persisted through economy.js. The campaign seed
   stream is hidden inside it — startScene never invents a seed for a money
   round, it asks the profile for the next one. */
// Dev sheets never write the player's profile: a QA sweep deals dozens of
// exhibition rounds, and the round cursor those would leave in localStorage
// hijacks the next boot's resume. (Parsed inline — q0 is declared later.)
const store = new URLSearchParams(location.search).has('sheet') ? Econ.memoryStore() : Econ.localStore();
let profile = null;

function initProfile() {
  try {
    profile = Econ.loadProfile(store);
  } catch { profile = null; }
  if (!profile) {
    // entropy for the hidden campaign stream — crypto where available so two
    // players on the same machine never walk the same scene sequence
    let ent = '';
    if (self.crypto && self.crypto.getRandomValues) {
      const b = new Uint32Array(4);
      self.crypto.getRandomValues(b);
      for (const n of b) ent += n.toString(36);
    } else ent = String(Date.now()) + Math.random().toString(36).slice(2);
    profile = Econ.newProfile(ent);
    Econ.saveProfile(store, profile);
  }
  return profile;
}


const LOAD_LINES = [
  'syncing dashcams…', 'pulling CCTV…', 'checking the traffic light…',
  'reading skid marks…', 'winding the clock back…',
];

function roundLoad(show, pct, label, sub) {
  if (!show) { roundProgress.show(false); return; }
  roundProgress.show(true);
  roundProgress.set(pct, label, sub);
}

function destroyRound() {
  if (!round) return;
  targetMap = null; hoverGroup = null;
  sigLamps = null;      // these hold materials from a sim about to be disposed
  povRig = null; activePov = null;
  env.setWater(null); // otherwise the channel follows you into the showroom
  env.setTerrain(null); // ditto the landscape
  weather.set(null);    // and the rain must not follow you into the menu
  rainLvl = 0;          // …nor its sound
  veg.clear();          // ditto the forest
  env.applyWeather(null);
  $('povfx').className = '';
  $('povbar').innerHTML = '';
  controls.enabled = true;
  crashFx.reset();
  crashFx.detachSim();
  scene.remove(round.sim.root);
  round.sim.dispose();
  round = null;
}

function roundBox(sim) {
  const bb = new THREE.Box3();
  for (const car of sim.cars) bb.expandByPoint(car.wrap.position);
  bb.expandByScalar(16);
  bb.min.y = 0;
  bb.max.y = Math.max(bb.max.y, 7);
  return bb;
}

// deal a scene: generate → pre-sim headlessly behind the loading beat → play
// G6 spoiler-free scene tag: places and weather, never the incident
const TOPO_LABEL = {
  intersection: 'Signal Junction', suburb: 'Residential Street', city: 'City Block',
  highway: 'Open Highway', causeway: 'Causeway', switchback: 'Mountain Viaduct',
  schoolzone: 'School Zone', tramcrossing: 'Level Crossing', parkinglot: 'Parking Lot',
  roundabout: 'Roundabout', boulevard: 'Boulevard', tunnelmouth: 'Tunnel Approach',
  industrialyard: 'Freight Yard', tjunction: 'T-Junction', overpass: 'Overpass',
  cloverleaf: 'Interchange', forestroad: 'Forest Road', mountainpass: 'Mountain Pass',
  canyon: 'Canyon Road', coastalcliff: 'Coast Cliffs', riverside: 'Riverside',
  harbourramp: 'Harbour Quay',
};
const WX_ICON = {
  clear: '☀', fair: '🌤', overcast: '☁', drizzle: '🌦', rain: '🌧', downpour: '⛈',
  mist: '🌫', fog: '🌫', snow: '🌨', dust: '🌪', storm: '⛈',
};

async function startScene(seedArg, dArg, wantFullscreen = true, mode = null) {
  if (roundLoading || !preloaded) return;
  roundLoading = true;
  try {
    if (wantFullscreen && !document.fullscreenElement) {
      try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch {}
      try { await screen.orientation.lock('landscape'); } catch {}
    }
    const [{ generateScene, drawDifficulty, INCIDENT_TICK }, { recordScene }] = await Promise.all([
      import('./director.js'), import('./recorder.js'),
    ]);
    // Pick the round. A campaign round pulls the next hidden seed from the
    // profile (and resumes an unfinished one, slip draft included); ANY
    // explicit seed — custom, shared link, replay — is Exhibition and never
    // moves the bankroll, and so is a campaign seed that already paid out.
    if (!profile) initProfile();
    let seed, exhibition, dailyKey = null;
    if (mode === 'daily') {
      // one attempt a day. A second visit is not blocked — it re-deals the
      // same scene as Exhibition, which is exactly what the ledger would do
      // to any already-settled seed anyway.
      const key = Econ.dailyKey();
      const info = Econ.dailyInfo(profile, key);
      seed = info.seed;
      exhibition = info.played;
      if (exhibition) Econ.exhibitionRound(profile, seed);
      else { Econ.dailyRound(profile, key); dailyKey = key; }
    } else if (seedArg != null) {
      seed = String(seedArg);
      exhibition = true;
      Econ.exhibitionRound(profile, seed);
    } else {
      const r = Econ.currentRound(profile);
      seed = r.seed;
      exhibition = r.exhibition || Econ.seedSettled(profile, seed);
      r.exhibition = exhibition;
      dailyKey = r.daily || null; // a resumed daily is still the daily
    }
    Econ.saveProfile(store, profile);
    const d = dArg != null ? clamp(dArg, 1, 10) : drawDifficulty(makeRng('d:' + seed));
    roundLoad(true, 0.05, LOAD_LINES[Math.floor(Math.random() * LOAD_LINES.length)], 'dealing scene ' + seed);
    await new Promise((r) => setTimeout(r, 0));

    const sc = generateScene(seed, d);
    // markets are generated from the SCENE ONLY, before the tape is even run —
    // markets.js is outcome-blind by construction and this ordering keeps it
    // honest (nothing here has seen the recording yet)
    const markets = generateMarkets(sc, { labelOf: (t) => (REG.find((e) => e.id === t) || {}).label || t });
    roundLoad(true, 0.15, undefined, 'running the tape…');
    // pre-sim in chunks so the loading bar actually animates on slow devices
    const rec = await recordScene(engine.R, sc, catOfId, {
      chunk: 90,
      onProgress: (p) => roundLoad(true, 0.15 + p * 0.75, undefined, 'running the tape…'),
    });
    roundLoad(true, 0.95, undefined, 'cueing playback…');

    destroyCrashSim();
    destroyRound();
    showShowroom(false);
    if (sc.world.env && ENVS.some((e) => e.id === sc.world.env)) env.apply(sc.world.env);
    env.setGroundRadius(sc.world.ground || 90);
    env.setWater(sc.world.water || null);
    // Weather (1B). Rolled from its own rng stream off the scene seed, so the
    // same seed always shows the same sky and no existing stream shifts by a
    // draw. Applied BEFORE the terrain because the clouded horizon is baked
    // into the landscape's vertex colours and the two must agree.
    //
    // P2/2D: the SCENE now carries its descriptor — the director rolls it, so
    // the recorder that priced the odds and the round being drawn here cannot
    // read different weather (which matters the moment `world.weather.grip`
    // reaches the tyres). The roll survives only as the fallback for scenarios
    // that never went through generateScene, i.e. crash mode and the pins.
    const wx = sc.world.weather || rollWeather(seed, env.current);
    env.applyWeather(wx);
    weather.set(wx);
    // audible rain only for actual rain — snow falls silent, dust is a look
    rainLvl = wx.precip === 'rain' ? clamp(wx.intensity, 0, 1) : 0;
    // Terrain (1A). Render-side and opt-in: the scenario may name a preset,
    // otherwise the seed alone is enough and the env preset picks the
    // landscape. playR defaults to the ground radius set above, which is what
    // keeps the displacement mask off the drivable area.
    env.setTerrain(sc.world.terrain || { seed });
    // Vegetation (1E). Scattered against the height field env just built, so it
    // queries the exact surface the mesh came from. Masked to r > playR, no
    // colliders, one draw call per species — it cannot touch the sim, and the
    // wind that bends it is the same descriptor driving the rain.
    veg.setWind(wx);
    veg.build(env.terrainField, seed, {
      density: quality === 'low' ? 0.45 : 1,
      value: env.terrainValue, // match the brightness the landscape was baked at
    });

    const sim = new engine.mod.CrashSim(engine.R, sc, catOfId);
    sim.stopAt = INCIDENT_TICK; // hard freeze on the exact incident tick
    round = {
      sim, scene: sc, rec, markets, phase: 'preview', seed, d, exhibition, resumeAt: 0,
      incidentTick: INCIDENT_TICK, seekTo: null, strip: null, daily: dailyKey,
    };
    // Wet roads. The rain itself is never the tell — a downpour over bright dry
    // asphalt reads as a bug — so the road surface has to carry it. Roads only:
    // materials are per-build, so this cannot leak into the next round, and the
    // terrain is deliberately left alone (grass and rock do not gloss).
    // junctions are asphalt too — leaving them dry put a bone-dry square in
    // the middle of a wet intersection, the one place the camera always looks
    if (wx.wetness > 0) {
      applyWetness([...sim.roads, ...(sim.junctions || [])].map((r) => r.group), wx.wetness);
    }
    // Freeze everything the sim will never pose. Roads are static by contract
    // (the group is never transformed) and a prop's `group` holds whatever was
    // left after the dynamic bodies re-parented their nodes to sim.root — so
    // skip any group that IS one of those nodes, because that one moves.
    // Merge first, then freeze — merging rewrites the children. Both are safe
    // here for the same reason: colliders are explicit recipes, never parsed
    // from geometry, and fx reads `rec.spec` rather than any mesh.
    for (const rec of sim.roads) { mergeByMaterial(rec.group); freezeMatrices(rec.group); }
    for (const rec of (sim.junctions || [])) { mergeByMaterial(rec.group); freezeMatrices(rec.group); }
    for (const rec of sim.props) {
      if (rec.dyn.some((d) => d.node === rec.group)) continue;
      mergeByMaterial(rec.group);
      freezeMatrices(rec.group);
    }
    targetMap = buildTargetMap(sim); // crosshair/tap targets for this round
    buildSignalLamps(sim);  // after the prop merge — noMerge lamps survive it
    scene.add(sim.root);
    povRig = buildLoadout(sc, seed, d, incidentFocus(rec, INCIDENT_TICK));
    activePov = null;
    $('povfx').className = '';
    renderPovBar();
    crashFx.attach(sim);
    hookRoundCinematics(sim);
    sim.speed = 1;
    sim.playing = true;

    setCamMode('orbit');
    inGame = true;
    document.body.classList.add('ingame', 'roundmode');
    $('menu').hidden = true;
    $('hud').hidden = false;
    $('pause').hidden = true;
    $('crashui').hidden = true;
    $('roundui').hidden = false;
    $('freeze').hidden = true;
    // G6: no incident name, no difficulty badge — the scene is the mystery.
    // The tag shows WHERE you are and what the sky is doing; what happens is
    // for the player to read.
    $('sceneLv').textContent = TOPO_LABEL[sc.meta.topo] || sc.meta.topo;
    $('sceneTopo').textContent = (WX_ICON[wx.kind] || '') + ' ' + wx.kind;
    Bet.openRound({ scene: sc, markets, profile, store, exhibition });
    setRing(1, 10);
    camera.position.set(0, 40, 90);
    fitCamera(roundBox(sim), true);
    roundLoad(false);
    toast('🎬 Ten seconds — find the tell');
    invalidate();
  } catch (e) {
    console.error('scene failed', e);
    roundLoad(false);
    toast('Scene failed to load');
  } finally {
    roundLoading = false;
  }
}

// cinematics: reuse the crash-test language (auto slow-mo + one push-in)
function hookRoundCinematics(sim) {
  // Idempotent by design (ledger #19). crashFx.attach() OVERWRITES sim.onImpact
  // with the plain fx handler before each of the two calls (scene start + the
  // freeze re-attach), so today this never stacks. The `_cine` guard makes that
  // robust regardless of call order: a second call with no attach in between
  // finds its own wrapper already installed and bails instead of double-wrapping.
  if (sim.onImpact && sim.onImpact._cine) return;
  const fxImpact = sim.onImpact;
  const wrapped = (car, ev) => {
    fxImpact(car, ev);
    const now = performance.now();
    if (ev.dv > 6.5 && now > crashSlowLast + 5000) {
      sim.speed = 0.28;
      crashSlowT = now + 1200;
      crashSlowLast = now;
    }
    if (ev.dv > 5 && !crashPushed) {
      crashPushed = true;
      if (!fly.on) {
        fitCamera(new THREE.Box3(
          new THREE.Vector3(ev.point.x - 10, 0, ev.point.z - 10),
          new THREE.Vector3(ev.point.x + 10, 5, ev.point.z + 10),
        ), false);
      }
    }
  };
  wrapped._cine = true;
  sim.onImpact = wrapped;
}

const RING_LEN = 119.4;
function setRing(frac, secs) {
  $('rfg').style.strokeDashoffset = String(RING_LEN * (1 - clamp(frac, 0, 1)));
  $('ringT').textContent = String(Math.max(0, Math.ceil(secs)));
  $('ring').classList.toggle('hot', secs <= 3);
}

/* ---------------- freeze scrub (G5) ----------------
   Spec beat 3: "study the frozen scene, scrub the last 10 s, then press BET".

   There is no rewind in a rigid-body world, so a backward seek used to rebuild
   the world and re-sim from t0 — ~30 ms of mesh rebuild plus up to 600 steps
   FOR EVERY DRAG FRAME. Correct, but it crawled under the thumb, and the whole
   value of the scrub is reading the approach frame by frame.

   So the freeze captures the last 10 s of VISUAL state once, up front, and a
   seek becomes a pure pose: no physics, no rebuild, no allocation. The sim is
   consequently never rewound at all — it stays parked on the incident tick,
   which also means resumeRound structurally cannot hand the player a scene the
   odds were never priced on (the failure the scrub gate exists to catch).

   Captured per tick: chassis pose, steer angle, suspension travel and wheel
   spin (everything syncVisuals interpolates) plus dynamic props. Debris is not
   captured because nothing may collide before the incident tick. */
function buildStrip(sim, endTick) {
  const n = endTick + 1;
  const cars = sim.cars.map((c) => ({
    w: c.susCur.length,
    p: new Float32Array(n * 3), q: new Float32Array(n * 4), st: new Float32Array(n),
    sus: new Float32Array(n * c.susCur.length), rot: new Float32Array(n * c.susCur.length),
  }));
  const props = [];
  for (const rec of sim.props) for (const _ of rec.dyn) {
    props.push({ p: new Float32Array(n * 3), q: new Float32Array(n * 4) });
  }
  const grab = (t) => {
    const i3 = t * 3, i4 = t * 4;
    for (let i = 0; i < sim.cars.length; i++) {
      const c = sim.cars[i], s = cars[i];
      s.p[i3] = c.cur.p.x; s.p[i3 + 1] = c.cur.p.y; s.p[i3 + 2] = c.cur.p.z;
      s.q[i4] = c.cur.q.x; s.q[i4 + 1] = c.cur.q.y; s.q[i4 + 2] = c.cur.q.z; s.q[i4 + 3] = c.cur.q.w;
      s.st[t] = c.steerCur;
      s.sus.set(c.susCur, t * s.w); s.rot.set(c.rotCur, t * s.w);
    }
    let k = 0;
    for (const rec of sim.props) for (const d of rec.dyn) {
      const s = props[k++];
      s.p[i3] = d.cur.p.x; s.p[i3 + 1] = d.cur.p.y; s.p[i3 + 2] = d.cur.p.z;
      s.q[i4] = d.cur.q.x; s.q[i4 + 1] = d.cur.q.y; s.q[i4 + 2] = d.cur.q.z; s.q[i4 + 3] = d.cur.q.w;
    }
  };
  // hooks off for the capture pass, exactly as a seek did: replaying 600 ticks
  // through them would dump a scene of particles and audio into one frame
  sim.onImpact = sim.onScrape = sim.onGlass = sim.onDetach = sim.onSplash = sim.onObjSplash = sim.onSunk = null;
  sim.reset();
  grab(0);
  while (sim.tick < endTick) { sim.stepOnce(); grab(sim.tick); }
  return { n, cars, props };
}

// Pose the scene from the filmstrip. prev is written alongside cur so the
// alpha lerp in syncVisuals is a no-op while frozen, and so the first stepped
// frame after resume interpolates from the state actually on screen.
function poseStrip(sim, strip, t) {
  const i3 = t * 3, i4 = t * 4;
  for (let i = 0; i < sim.cars.length; i++) {
    const c = sim.cars[i], s = strip.cars[i];
    c.cur.p.set(s.p[i3], s.p[i3 + 1], s.p[i3 + 2]);
    c.cur.q.set(s.q[i4], s.q[i4 + 1], s.q[i4 + 2], s.q[i4 + 3]);
    c.prev.p.copy(c.cur.p); c.prev.q.copy(c.cur.q);
    c.steerCur = c.steerPrev = s.st[t];
    for (let w = 0; w < s.w; w++) {
      c.susCur[w] = c.susPrev[w] = s.sus[t * s.w + w];
      c.rotCur[w] = c.rotPrev[w] = s.rot[t * s.w + w];
    }
  }
  let k = 0;
  for (const rec of sim.props) for (const d of rec.dyn) {
    const s = strip.props[k++];
    d.cur.p.set(s.p[i3], s.p[i3 + 1], s.p[i3 + 2]);
    d.cur.q.set(s.q[i4], s.q[i4 + 1], s.q[i4 + 2], s.q[i4 + 3]);
    d.prev.p.copy(d.cur.p); d.prev.q.copy(d.cur.q);
  }
  sim.syncVisuals(1);
  invalidate();
}

function seekPreview(tick) {
  // Pure pose off the captured filmstrip — 0.016 ms, no physics, no rebuild.
  // Since P2/2H every difficulty builds the strip at the freeze, so it always
  // exists here; the old re-sim fallback (reset + step up to 600 ticks, the
  // reason a backward drag once crawled) is gone. The sim stays parked on the
  // incident tick throughout, which is what keeps a resumed round settling
  // against the exact scene the odds were priced on.
  if (!round || !round.strip) return;
  poseStrip(round.sim, round.strip, clamp(Math.round(tick), 0, round.incidentTick));
}

// The GO button is also the lock, so it carries the stake it is about to
// place. It re-reads on every touch of the betting layer because the slip can
// change all the way through the freeze — time restarting is the lock.
function syncFzGo() {
  const ss = Bet.slipSummary();
  $('fzGo').textContent = ss.placed ? 'Go' : (ss.total > 0 ? `Bet $${ss.total}` : 'Bet');
}

function syncScrub(tick) {
  $('scrubBar').value = String(tick);
  const s = (tick - round.incidentTick) / 60;
  $('scrubT').textContent = (s < -0.05 ? '−' : '') + Math.abs(s).toFixed(1) + 's';
}

$('scrubBar').addEventListener('input', (e) => {
  if (!round || round.phase !== 'freeze') return;
  const t = parseInt(e.target.value, 10);
  syncScrub(t);
  // With a filmstrip a seek is a mesh pose, so apply it right here — the frame
  // tracks the thumb. Without one it is a rebuild, so it goes on the queue and
  // roundUpdate applies at most one per frame (input fires far faster).
  if (round.strip) seekPreview(t); else round.seekTo = t;
});

// resume from the freeze — the incident fires and physics runs to rest
function resumeRound() {
  if (!round || round.phase !== 'freeze') return;
  // A scrubbed-back sim MUST be returned to the incident tick before time
  // restarts. The slip settles against a recording whose incident begins at
  // exactly this tick; resuming from tick 300 would play a different scene
  // from the one the odds were priced on and the one the recorder taped.
  round.seekTo = null;
  // With a filmstrip the sim never left the incident tick — only the meshes
  // moved — so all that is owed is a pose back onto the true state.
  if (round.strip) poseStrip(round.sim, round.strip, round.incidentTick);
  else if (round.sim.tick !== round.incidentTick) seekPreview(round.incidentTick);
  round.strip = null;
  round.phase = 'resolve';
  Bet.setPhase('resolve'); // locks betting and rides any drafted slip
  $('freeze').hidden = true;
  round.sim.stopAt = null;
  round.sim.playing = true;
  crashPushed = false;
  crashSlowT = 0;
  setRing(0, 0);
  invalidate();
}

// (the G1 outcome bar was replaced by the G3 summary card — betui.settle()
// renders the same physical recap plus the bet-by-bet result)

// per-frame round update — called from the frame loop
/* Traffic signal lamps (P2/2I) — render side only, reading sim state exactly
   like fx does and writing nothing back. The aspect itself is decided by the
   sim (the drivers obey it), so this only ever mirrors it: what a player reads
   off the mast is by construction what the cars are reacting to.

   Collected once per round rather than traversed every frame, and skipped
   entirely when the aspect has not changed — a signal holds one colour for
   ~200 ticks, so this is a no-op on all but a handful of frames and must not
   defeat render-on-demand. */
let sigLamps = null;
function buildSignalLamps(sim) {
  sigLamps = [];
  if (!sim || !sim.signals || !sim.signals.some(Boolean)) return;
  for (const rec of sim.props) {
    const sig = rec.spec && rec.spec.sig;
    if (!sig) continue;
    const lamps = [[], [], []];
    rec.group.traverse((o) => {
      if (o.isMesh && o.userData.sigLamp !== undefined) lamps[o.userData.sigLamp].push(o.material);
    });
    if (lamps[0].length) sigLamps.push({ sig, lamps, last: -1 });
  }
}
function syncSignalLamps(sim) {
  if (!sigLamps || !sigLamps.length) return;
  for (const e of sigLamps) {
    const state = signalAt(sim.signals[e.sig.j], e.sig.arm, sim.tick);
    if (state === e.last) continue;
    e.last = state;
    for (let i = 0; i < 3; i++) {
      const on = i === state;
      for (const m of e.lamps[i]) { m.emissiveIntensity = on ? 1.9 : 0.1; m.needsUpdate = false; }
    }
    invalidate();
  }
}

function roundUpdate(dt, now) {
  if (!round || !inGame) return false;
  if (crashSlowT && now > crashSlowT) { round.sim.speed = 1; crashSlowT = 0; }
  if (!$('pause').hidden) return false;
  let busy = false;
  const sim = round.sim;
  // a queued scrub seek is applied here, at most one per frame (see seekPreview)
  if (round.seekTo != null && round.phase === 'freeze') {
    const t = round.seekTo;
    round.seekTo = null;
    seekPreview(t);
    busy = true;
  }
  sim.update(dt);
  sim.syncVisuals();
  syncSignalLamps(sim);
  if (crashFx.update(dt, camera)) busy = true;

  if (round.phase === 'preview') {
    const left = (600 - sim.tick) / 60;
    setRing(sim.tick / 600, left);
    busy = true;
    if (!sim.playing) { // stopAt reached: the freeze
      round.phase = 'freeze';
      Bet.setPhase('freeze');
      setRing(1, 0);
      // Every difficulty gets the freeze now (P2/2H). It used to be denied at
      // d >= 8 ("no study time at the top difficulties"), but difficulty keeps
      // its meaning through incident subtlety, cast size and similarity, camera
      // coverage and odds spread — the freeze was the ONE place a hard read
      // most needed the beat, and removing it there made high-d rounds feel
      // arbitrary rather than hard. The strip is 0.016 ms to pose, so there is
      // no cost argument for skipping it either.
      // Capture the 10 s filmstrip before anything else touches the scene:
      // it rebuilds the world, so fx has to let go of the old car objects
      // first and the crosshair map has to be rebuilt from the new ones.
      crashFx.reset();
      crashFx.detachSim();
      round.strip = buildStrip(sim, round.incidentTick);
      targetMap = buildTargetMap(sim);
      buildSignalLamps(sim); // reset() rebuilt the meshes: re-grab the materials
      hoverGroup = null;
      crashFx.attach(sim);
      hookRoundCinematics(sim);
      poseStrip(sim, round.strip, round.incidentTick);
      syncFzGo();
      syncScrub(round.incidentTick); // the scrub always opens at the incident
      $('freeze').hidden = false;
      fitCamera(roundBox(sim), false);
    }
  } else if (round.phase === 'resolve') {
    busy = true;
    Bet.tickLive(round.rec, sim.tick); // chips flip as their trigger ticks pass
    // gentle auto-follow on the wreck centroid (orbit only). It must stand down
    // while a fitCamera tween is in flight (camT<1) — the push-in on the first
    // big hit lerps controls.target too, and both running in the same frame is
    // the "camera swims and never settles" fight (ledger #7). Once the push-in
    // completes camT hits 1 and the follow resumes from where it left the target.
    if (!fly.on && camT >= 1 && sim.cars.length) {
      _crashC.set(0, 0, 0);
      for (const car of sim.cars) _crashC.add(car.wrap.position);
      _crashC.divideScalar(sim.cars.length);
      _crashC.y = Math.min(_crashC.y + 0.6, 3);
      controls.target.lerp(_crashC, 1 - Math.pow(0.3, dt));
    }
    // the recorded rest tick is authoritative — the live sim reaches it too
    if (sim.tick >= round.rec.restTick) {
      round.phase = 'done';
      sim.playing = false;
      Bet.setPhase('done');
      // settlement: economy.js pays out and consumes the seed (Exhibition
      // rounds compute the same report but mutate nothing), then the card
      // renders from that authoritative report
      const report = Econ.settleRound(profile, round.markets, round.rec);
      // achievements read the POST-settlement profile (bankroll, streak, busts
      // are all already applied) — evaluate before the profile is written back
      const unlocked = Ach.evaluate(profile, {
        report, rec: round.rec, markets: round.markets, scene: round.scene, d: round.d,
      });
      Econ.saveProfile(store, profile);
      Bet.settle(report, round.rec);
      showUnlocks(unlocked);
      renderPovBar(); // every angle unlocks once the scene has settled
      fitCamera(roundBox(sim), false);
    }
  }
  return busy;
}

/* ---------------- audio facade (G5) ----------------
   betui.js owns no engine dependencies, so it gets audio injected rather than
   importing fx. crashFx does not exist until the preloader has run, hence the
   lazy lookup on every call instead of a captured reference. */
function uiSfx(kind) {
  if (!crashFx) return;
  if (kind === 'win' || kind === 'lose') crashFx.sfx.sting(kind === 'win');
  else crashFx.sfx.ui(kind);
}

// betting layer: mounted once, driven by the round lifecycle above
Bet.mountBetUI({
  // NEXT on the summary card deals the following campaign round (already
  // in-game, so never re-request fullscreen). Resuming at the freeze is the
  // #fzGo button's job (main.js), not a betui callback — see ledger #30.
  onNext: () => startScene(null, null, false),
  sfx: uiSfx,
});
initProfile();
applySavedSettings(); // profile exists now; volume re-applies once fx is warm

/* ---------------- POV picker (G3) ----------------
   A scene ships a camera rig (povcam.js); difficulty prunes how much of it
   the player gets before the resolve, and everything unlocks once the scene
   has settled. 'free' is the existing freecam — picking it just hands the
   camera back to fly mode, so the two systems never fight over the camera. */
let povRig = null;      // { all, available }
let activePov = null;   // descriptor or null (= orbit/freecam)
const _povFocus = new THREE.Vector3();

function povFocus() {
  // pre-incident: the middle of the cast. post: the wreck centroid, which is
  // what the player actually wants to look at.
  if (!round) return _povFocus.set(0, 0, 0);
  const cars = round.sim.cars;
  if (!cars.length) return _povFocus.set(0, 0, 0);
  _povFocus.set(0, 0, 0);
  for (const c of cars) _povFocus.add(c.wrap.position);
  _povFocus.divideScalar(cars.length);
  _povFocus.y = Math.min(_povFocus.y + 1.0, 3);
  return _povFocus;
}

// Where the fixed camera rig is BUILT to look. buildLoadout used to get
// povFocus() at tick 0 — the spawn centroid — so a cctv/witness pole sat where
// the cars started, not where the crash happens, and on a long approach those
// are different places entirely (ledger #12). Read it from the tape instead:
// the first hard car↔car contact at/after the incident is the crash point; if
// there is none (a swerve-off with no strike), any first contact, then the mean
// car position at the incident tick from the coarse tracks (sampled every 10).
const _inc = new THREE.Vector3();
function incidentFocus(rec, incidentTick) {
  let carHit = null, anyHit = null;
  for (const e of rec.events) {
    if (e.k !== 'hit' || e.x === undefined || e.t < incidentTick) continue;
    if (!anyHit) anyHit = e;
    if (e.o === 'car') { carHit = e; break; }
  }
  const pick = carHit || anyHit;
  if (pick) return _inc.set(pick.x, 1.2, pick.z);
  const tr = rec.tracks, o = Math.floor(incidentTick / 10) * 3; // TRACK_EVERY=10
  if (tr && tr.length && tr[0].length > o + 2) {
    _inc.set(0, 0, 0);
    for (const t of tr) { _inc.x += t[o]; _inc.y += t[o + 1]; _inc.z += t[o + 2]; }
    _inc.divideScalar(tr.length);
    _inc.y = Math.min(_inc.y + 1.0, 3);
    return _inc;
  }
  return _inc.set(0, 0, 0);
}

function renderPovBar() {
  const bar = $('povbar');
  if (!povRig || !round) { bar.innerHTML = ''; return; }
  // after the scene settles, every angle unlocks (spec: "after resolution,
  // everything unlocks") — before that, difficulty decides
  const list = round.phase === 'done' ? povRig.all : povRig.available;
  let html = `<button class="povchip${activePov ? '' : ' sel'}" data-pov="free" title="Free look — drag to orbit · C for freecam">${POV_META.free.icon}</button>`;
  let dashN = 0;
  for (const p of list) {
    const m = POV_META[p.kind];
    let inner = m.icon, title = m.label;
    if (p.kind === 'dash') {
      // one dashcam per flagged car, so the chip has to say WHICH car — the old
      // ternary chose between `${m.icon}` and `m.icon`, i.e. nothing (#10). Now
      // a corner ordinal makes them visibly distinct and the tooltip names the car.
      dashN++;
      const car = round.scene.cars[p.car];
      const name = car ? (REG.find((e) => e.id === car.type) || {}).label || car.type : 'car';
      inner = `${m.icon}<span class="bdg">${dashN}</span>`;
      title = `Dashcam · ${name}`;
    }
    const on = activePov && activePov.id === p.id ? ' sel' : '';
    html += `<button class="povchip${on}" data-pov="${p.id}" title="${title}">${inner}</button>`;
  }
  bar.innerHTML = html;
}

function setPov(id) {
  if (!povRig) return;
  if (id === 'free') {
    activePov = null;
    $('povfx').className = '';
    setCamMode('orbit');
  } else {
    const list = round && round.phase === 'done' ? povRig.all : povRig.available;
    const p = list.find((x) => x.id === id);
    if (!p) return;
    activePov = p;
    $('povfx').className = 'on pov-' + p.kind;
    // a scripted camera owns the view: freecam and orbit both stand down
    if (fly.on) setCamMode('orbit');
    controls.enabled = false;
  }
  if (!activePov) controls.enabled = true;
  renderPovBar();
  invalidate();
}

// keyboard cycling through the rig — V forward, shift+V back — over the same
// list the bar shows (all angles once the scene has settled, the pruned set
// before). 'free' is index 0, so it is always in the cycle.
function cyclePov(dir) {
  if (!povRig || !round || !inGame) return;
  const list = round.phase === 'done' ? povRig.all : povRig.available;
  const ids = ['free', ...list.map((p) => p.id)];
  const cur = activePov ? Math.max(0, ids.indexOf(activePov.id)) : 0;
  setPov(ids[(cur + dir + ids.length) % ids.length]);
}

$('povbar').addEventListener('click', (e) => {
  const b = e.target.closest('.povchip');
  if (b) setPov(b.dataset.pov);
});

/* ---------------- crosshair targeting (G3) ----------------
   "Bet on anything from anywhere": the freecam carries a centre dot that
   raycasts the round's world, and in orbit mode a tap does the same at the
   pointer. Hitting a car or prop opens that object's markets. The map is
   built once per round — traversing every mesh per frame would be silly. */
const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
let targetMap = null;   // Object3D -> group id ('car:3' / 'prop:11')
let hoverGroup = null;

function buildTargetMap(sim) {
  const map = new Map();
  sim.cars.forEach((car, i) => car.wrap.traverse((o) => map.set(o, 'car:' + i)));
  sim.props.forEach((rec, i) => {
    const g = 'prop:' + i;
    if (rec.group) rec.group.traverse((o) => map.set(o, g));
    // dynamic prop nodes are re-parented to sim.root, so cover them too
    if (rec.dyn) for (const d of rec.dyn) if (d.node) d.node.traverse((o) => map.set(o, g));
  });
  return map;
}

function pickGroup(nx, ny) {
  if (!targetMap || !round) return null;
  _ndc.set(nx, ny);
  _ray.setFromCamera(_ndc, camera);
  for (const h of _ray.intersectObject(round.sim.root, true)) {
    const g = targetMap.get(h.object);
    if (g) return g;
  }
  return null;
}

// per-frame while freecam owns the camera: what is the dot resting on?
// The raycast is a full recursive intersect against every mesh in the round, so
// it is throttled to ~12 Hz — a crosshair label that updates in under 90 ms is
// indistinguishable from one that updates every frame, and this ran on every
// frame of every freecam second.
let crossT = 0;
function updateCrosshair(now) {
  const on = !!(round && inGame && fly.on && $('pause').hidden);
  $('crosshair').hidden = !on;
  if (!on) { hoverGroup = null; return; }
  if (now - crossT < 85) return;
  crossT = now;
  const g = pickGroup(0, 0);
  if (g === hoverGroup) return;
  hoverGroup = g;
  const tag = $('targetTag');
  if (!g) { tag.textContent = ''; tag.classList.remove('has', 'nomarket'); return; }
  const has = Bet.groupExists(g);
  tag.textContent = Bet.groupLabel(g) + (has ? '' : ' · no market');
  tag.classList.toggle('has', has);
  tag.classList.toggle('nomarket', !has);
}

// click (freecam centre) / tap (orbit, at the pointer) → that object's markets
function targetAt(nx, ny) {
  if (!round || !inGame || !$('pause').hidden) return;
  const g = pickGroup(nx, ny);
  if (!g) return;
  if (!Bet.focusGroup(g)) toast(`No market on the ${Bet.groupLabel(g)}`);
}

renderer.domElement.addEventListener('click', (e) => {
  if (!round || !inGame) return;
  if (fly.on) { targetAt(0, 0); return; }
  // orbit: ignore the click that ends a camera drag
  if (orbitDragged) return;
  const r = renderer.domElement.getBoundingClientRect();
  targetAt(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
});
// OrbitControls swallows drags; only a clean tap should open a market card
let orbitDragged = false;
let _downXY = null;
renderer.domElement.addEventListener('pointerdown', (e) => { _downXY = [e.clientX, e.clientY]; orbitDragged = false; });
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!_downXY) return;
  if (Math.abs(e.clientX - _downXY[0]) + Math.abs(e.clientY - _downXY[1]) > 9) orbitDragged = true;
});
renderer.domElement.addEventListener('pointerup', () => { _downXY = null; });

/* ---------------- main menu (G3) ----------------
   Continue deals (or resumes) the campaign round; Garage is the old showroom;
   a custom seed always runs Exhibition. The bankroll block only appears once
   a profile exists so a first boot reads as a title screen, not a save file. */
/* G6: the menu buttons carry inline SVG icons now, so state updates mutate
   the label <span> and badge in place — an innerHTML rewrite here would wipe
   the icons the moment a profile loads. */
function setTileBadge(btn, text, cls) {
  let badge = btn.querySelector('.mbadge');
  if (text == null) { if (badge) badge.remove(); return; }
  if (!badge) { badge = document.createElement('b'); btn.appendChild(badge); }
  badge.className = 'mbadge' + (cls ? ' ' + cls : '');
  badge.textContent = text;
}
function syncMenu() {
  if (!profile) return;
  const unfinished = !!(profile.round && !profile.round.exhibition);
  $('mbAmt').textContent = '$' + profile.bankroll.toLocaleString('en-US');
  $('mbRun').textContent = unfinished ? 'round in progress' : 'round ' + (profile.campaign.n + 1);
  $('menubank').hidden = false;
  const startLab = $('startBtn').querySelector('span');
  if (startLab) startLab.textContent = unfinished ? 'Resume round' : 'Continue';
  // "New run" only means something once there is progress to throw away
  $('newRunBtn').hidden = !(profile.campaign.n > 0 || profile.bankroll !== Econ.START_BANKROLL || unfinished);
  // the daily advertises its own state: unplayed today, or the streak so far
  const dly = Econ.dailyInfo(profile);
  if (dly.played) setTileBadge($('dailyBtn'), 'done' + (dly.streak > 1 ? ` · ${dly.streak}🔥` : ''));
  else setTileBadge($('dailyBtn'), 'new', 'new');
  setTileBadge($('statsBtn'), `${Ach.unlockedCount(profile)}/${Ach.ACHIEVEMENTS.length}`);
}

const MODAL_TITLE = { how: 'How to play', seed: 'Custom seed', stats: 'Your record' };
function openModal(which) {
  $('modalTitle').textContent = MODAL_TITLE[which] || 'Custom seed';
  $('modalSeed').hidden = which !== 'seed';
  $('modalHow').hidden = which !== 'how';
  $('modalStats').hidden = which !== 'stats';
  if (which === 'stats') renderStats();
  $('modal').hidden = false;
  if (which === 'seed') setTimeout(() => $('seedInput').focus(), 30);
}

/* ---------------- stats + achievements (G5) ----------------
   Everything here is derived from the profile economy.js already keeps —
   this screen adds no new bookkeeping, it just reads the ledger. */
const MONEY = (n) => (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');

function renderStats() {
  if (!profile) return;
  const s = profile.stats;
  $('stRounds').textContent = String(s.rounds);
  $('stBank').textContent = MONEY(profile.bankroll);
  $('stBest').textContent = MONEY(s.biggestWin);
  $('stStreak').textContent = String(s.bestStreak);
  $('stBusts').textContent = String(s.busts);
  // return = what came back per dollar staked. Undefined until money moves,
  // and shown as a ratio rather than a % so a 0.94 reads as "the house edge".
  $('stRoi').textContent = s.staked > 0 ? '×' + (s.returned / s.staked).toFixed(2) : '—';

  // hit rate per market kind — the one stat that actually measures scene-reading
  const kinds = Object.entries(s.byKind).filter(([, k]) => k.bets > 0)
    .sort((a, b) => b[1].bets - a[1].bets);
  $('stKinds').innerHTML = kinds.length
    ? kinds.map(([name, k]) => {
      const pct = Math.round((k.wins / k.bets) * 100);
      return `<div class="stkind"><span class="skname">${esc(name)}</span>` +
        `<span class="skbar"><i style="width:${pct}%"></i></span>` +
        `<span class="sknum">${k.wins}/${k.bets}</span></div>`;
    }).join('')
    : '<p class="stempty">No settled bets yet — place one and come back.</p>';

  const got = new Set(profile.achievements || []);
  $('stAchN').textContent = `${got.size}/${Ach.ACHIEVEMENTS.length}`;
  $('stAch').innerHTML = Ach.ACHIEVEMENTS.map((a) => {
    const on = got.has(a.id);
    return `<div class="ach${on ? ' got' : ''}"><span class="achicon">${a.icon}</span>` +
      `<span class="achtxt"><b class="achname">${esc(a.name)}</b>` +
      `<span class="achdesc">${esc(a.desc)}</span></span></div>`;
  }).join('');
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------------- share links (G5) ----------------
   A shared scene always re-deals as Exhibition (startScene forces it for any
   explicit seed), so a link can be handed around freely — the recipient plays
   the identical scene and cannot mine it for bankroll. */
function shareUrl(seed, d) {
  const base = location.origin + location.pathname;
  return `${base}?scene=${encodeURIComponent(seed)}~${d}`;
}

async function copyText(txt) {
  try {
    await navigator.clipboard.writeText(txt);
    return true;
  } catch {
    // clipboard API needs a secure context; fall back to the old trick so
    // sharing still works off a plain-http LAN address
    try {
      const ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }
}
// first run: the rules card comes up BEFORE the first deal, never over a
// live preview — the 10 s clock would tick away while the player read it
let pendingDeal = false;
const closeModal = () => {
  $('modal').hidden = true;
  if (pendingDeal) { pendingDeal = false; startScene(null, null, true); }
};

$('startBtn').addEventListener('click', () => {
  if (profile && !profile.settings.seenIntro) {
    profile.settings.seenIntro = true;
    Econ.saveProfile(store, profile);
    pendingDeal = true;
    openModal('how');
    return;
  }
  startScene(null, null, true);
});
$('seedBtn').addEventListener('click', () => openModal('seed'));
$('howBtn').addEventListener('click', () => openModal('how'));
$('statsBtn').addEventListener('click', () => openModal('stats'));
$('dailyBtn').addEventListener('click', () => startScene(null, null, true, 'daily'));

// unlocked badges land on the summary card next to the payout
function showUnlocks(ids) {
  const el = $('sumAch');
  if (!ids || !ids.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.innerHTML = ids.map((id) => {
    const a = Ach.byId(id);
    return a ? `<span class="achpill"><i>${a.icon}</i>${esc(a.name)}</span>` : '';
  }).join('');
  el.hidden = false;
}

// share the scene that just settled — always replays as Exhibition
$('sumShare').addEventListener('click', async () => {
  if (!round) return;
  const url = shareUrl(round.seed, round.d);
  const s = round.rec.summary;
  const head = round.daily ? `Crash Bet daily ${round.daily} · LV ${round.d}` : `Crash Bet · LV ${round.d}`;
  const line = s.crashed ? `${s.crashed} wrecked` : 'nobody crashed';
  const ok = await copyText(`${head}\n${line}${s.propsMoved ? ` · ${s.propsMoved} objects hit` : ''}\n${url}`);
  toast(ok ? '🔗 Result copied to clipboard' : 'Could not copy — clipboard blocked');
});
$('modalClose').addEventListener('click', closeModal);
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });

let seedD = '';
for (const b of $('seedD').querySelectorAll('.mchip')) {
  b.addEventListener('click', () => {
    seedD = b.dataset.d;
    for (const o of $('seedD').querySelectorAll('.mchip')) o.classList.toggle('sel', o === b);
  });
}
function playCustomSeed() {
  const v = $('seedInput').value.trim();
  if (!v) { $('seedInput').focus(); return; }
  closeModal();
  startScene(v, seedD ? parseInt(seedD, 10) : null, true);
}
$('seedGo').addEventListener('click', playCustomSeed);
$('seedInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') playCustomSeed(); });

$('newRunBtn').addEventListener('click', () => {
  if (!confirm('Start a new run?\n\nThis wipes your bankroll, campaign progress and stats.')) return;
  Econ.wipeProfile(store);
  profile = null;
  initProfile();
  syncMenu();
  toast('New run — $100 on the table');
});

$('fzGo').addEventListener('click', resumeRound);
// There is deliberately NO tap-anywhere-to-resume. It made the freeze hostile
// to the thing the freeze is for: every tap meant to pick a market, aim the
// crosshair or swing the camera restarted time instead. The GO button and
// space are the only ways out.
$('betui').addEventListener('click', () => { if (round && round.phase === 'freeze') syncFzGo(); });

/* ---------------- keyboard ---------------- */
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'Escape' && inGame) showPause($('pause').hidden);
  if ((e.key === 'c' || e.key === 'C') && inGame) { setCamMode(fly.on ? 'orbit' : 'fly'); return; }
  if ((e.key === 'v' || e.key === 'V') && inGame && round && $('pause').hidden) { cyclePov(e.key === 'V' ? -1 : 1); return; }
  if (round && inGame && $('pause').hidden && (e.key === ' ' || e.code === 'Space') && round.phase === 'freeze') {
    e.preventDefault(); resumeRound(); return;
  }
  if (crash && inGame && $('pause').hidden) {
    if (e.key === 'r' || e.key === 'R') { replayCrash(); return; }
    if (e.key === 'n' || e.key === 'N') { nextCrash(1); return; }
    if (e.key === 't' || e.key === 'T') { toggleCrashSlow(); return; }
  }
  if (fly.on && inGame) {
    fly.keys.add(e.code);
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  }
});
addEventListener('keyup', (e) => fly.keys.delete(e.code));
addEventListener('blur', () => fly.keys.clear());

/* ---------------- resize / loop ---------------- */
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  weather.setPixelScale(h, camera.fov); // flakes are sized in metres, not pixels
  invalidate();
}
new ResizeObserver(resize).observe(stage);
resize();

let last = performance.now();
function animate(now) {
  requestAnimationFrame(animate);
  frame(now);
}
// one real frame of the app loop — exposed as __app.pump so headless checks can
// drive tweens/sim/fx/render even when the embedded pane suspends rAF
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  let animating = false;
  if (camT < 1 && camTo) {
    camT = Math.min(1, camT + dt / 0.55);
    const e = easeInOut(camT);
    camera.position.lerpVectors(camFrom.pos, camTo.pos, e);
    controls.target.lerpVectors(camFrom.tgt, camTo.tgt, e);
    animating = true;
  }
  if (flyUpdate(dt)) animating = true;
  if (crashUpdate(dt, now)) animating = true;
  if (roundUpdate(dt, now)) animating = true;
  // a scripted POV owns the camera outright — it must run after roundUpdate
  // (which moves the cars) so a dashcam sees this frame's transform, not last
  if (activePov && round) {
    drivePov(activePov, camera, round.sim, povFocus(), now / 1000, dt);
    animating = true;
  }
  updateCrosshair(now);
  // Weather is frozen while the round is. The sim's clock is stopped, so
  // hanging rain is the correct fiction — and it lets render-on-demand sleep
  // through the freeze, which is the longest UI phase and precisely when the
  // player wants a steady frame to read rather than a scene that never settles.
  const frozen = !!round && round.phase === 'freeze';
  // reduced motion parks the precipitation exactly like the freeze does —
  // hanging rain is already the shipped fiction there, and a paused volume
  // also lets render-on-demand sleep (P4/4F)
  if (weather.update(dt, camera, frozen || reduceMotion)) animating = true;
  const wantRain = frozen || reduceMotion ? 0 : rainLvl;
  if (crashFx && wantRain !== rainSet) { crashFx.sfx.setRain(wantRain); rainSet = wantRain; }
  // the canopies stop with the rain — same reasoning: the freeze is for reading
  // the scene, and a landscape that never settles defeats render-on-demand
  if (!frozen && !reduceMotion && veg.update(dt)) animating = true;
  // Water (1C). Same freeze rule, and the return value is "is the camera under
  // the surface" — a dashcam on a car that has just left the causeway goes
  // under, and the lens has to say so. Toggled rather than assigned because a
  // POV rig owns the rest of #povfx's class list.
  if (round && env.hasWater) {
    const under = env.updateWater(dt, camera, frozen || reduceMotion);
    if (!frozen && !reduceMotion) animating = true;
    $('povfx').classList.toggle('uw', under);
  }
  // OrbitControls.update() re-aims the camera at its target even when the
  // handlers are disabled — never run it while freecam or a POV owns the camera
  const moved = (fly.on || activePov) ? false : controls.update();
  // the cloud deck drifts on the scene's wind; frozen with everything else
  env.syncSky(camera.position, frozen || reduceMotion ? 0 : dt);
  // fog density follows where the camera actually is. Rounds only: they are the
  // only mode with weather, and the showroom's free camera would otherwise
  // thin its fog just by flying away from the display floor.
  if (round) syncFogScale();
  if (animating || moved || needsRender > 0) {
    // camera shake is applied for the render only, then undone — orbit and
    // freecam state never see the jitter. Skipped entirely under reduced
    // motion: shake is the one true vestibular trigger in the game (P4/4F).
    // Skipping both calls is symmetric — shakeOff is zeroed by the last undo.
    if (crashFx && !reduceMotion) crashFx.applyShake(camera);
    renderer.render(scene, camera);
    if (crashFx && !reduceMotion) crashFx.undoShake(camera);
    if (needsRender > 0) needsRender--;
  }
}
requestAnimationFrame(animate);

/* ---------------- boot (URL params + test hooks) ---------------- */
const q0 = new URLSearchParams(location.search);
$('menutag').textContent = `${REG.length + SCENERY.length + PROPS.length} procedural models · deterministic physics`;

if (q0.has('smoke')) {
  let fails = 0, total = 0;
  for (const e of REG) {
    for (const s of ['11', '22', '33', 'lowpoly']) {
      total++;
      try { disposeGroup(buildVehicle(s, e.id).group); }
      catch (err) { fails++; console.error('SMOKE FAIL', e.id, s, err.message, err.stack); }
    }
  }
  for (const e of SCENERY) {
    for (const s of ['11', '22', '33', 'lowpoly']) {
      total++;
      try { disposeGroup(buildProp(e.id, s).group); }
      catch (err) { fails++; console.error('SMOKE FAIL scenery', e.id, s, err.message, err.stack); }
    }
  }
  console.log(`SMOKE DONE: ${total - fails}/${total} ok, ${fails} failures`);
}

// PWA: offline cache + installability (network-first SW, see sw.js)
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// dev-only contact sheet: ?sheet=1 renders every registry type into one tiled
// canvas. Runs synchronously at boot so it works even with rAF suspended.
// `?sheet=scenery` does the same for the scenery registry — with 184 models it
// is the only practical way to review a batch, and reviewing a batch is how
// backwards winding and misplaced colliders get caught before they ship.
function contactSheet() {
  const which = q0.get('sheet');
  const scen = which === 'scenery' || which === 'sc';
  const list = scen
    // via buildProp, not buildScenery: it stands dynamic-root props back up on
    // the ground, which is what makes a standalone render sit right
    ? SCENERY.map((s) => ({ id: s.id, make: (sd) => { const b = buildProp(s.id, sd); return b && b.group; } }))
    : REG.map((e) => ({ id: e.id, make: (sd) => buildVehicle(sd, e.id).group }));
  const tile = 340, cols = 8;
  const seed = q0.get('seed') || '11';
  const rows = Math.ceil(list.length / cols);
  const sheet = document.createElement('canvas');
  sheet.width = cols * tile;
  sheet.height = rows * tile;
  const c2 = sheet.getContext('2d');
  c2.fillStyle = '#35383e';
  c2.fillRect(0, 0, sheet.width, sheet.height);
  renderer.setPixelRatio(1);
  renderer.setSize(tile, tile);
  camera.aspect = 1;
  camera.updateProjectionMatrix();
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const x = (i % cols) * tile, y = Math.floor(i / cols) * tile;
    let grp = null;
    try {
      grp = e.make(seed);
      if (!grp) throw new Error('builder returned nothing');
      scene.add(grp);
      camera.position.set(7.4, 4.6, 7.4);
      controls.target.set(0, 0.8, 0);
      fitCamera(new THREE.Box3().setFromObject(grp), true);
      controls.update();
      renderer.render(scene, camera);
      c2.drawImage(renderer.domElement, x, y, tile, tile);
    } catch (err) {
      console.error('SHEET FAIL', e.id, err);
      c2.fillStyle = '#7a2020';
      c2.fillRect(x, y, tile, tile);
    }
    if (grp) { scene.remove(grp); disposeGroup(grp); }
    c2.fillStyle = '#ffffff';
    c2.font = 'bold 15px monospace';
    c2.fillText(e.id, x + 10, y + 22);
    c2.strokeStyle = 'rgba(255,255,255,0.12)';
    c2.strokeRect(x + 0.5, y + 0.5, tile, tile);
  }
  window.__sheet = sheet;
  document.body.replaceChildren(sheet);
  sheet.style.cssText = 'max-width:100%;height:auto;display:block';
  console.log(`SHEET DONE: ${list.length} ${scen ? 'scenery' : 'vehicle'} types, seed ${seed}`);
}

/* P4/4A — the GAME contact sheets. ?sheet=1/scenery review MODELS; these
   review the assembled game, because 22 topologies × weather × difficulty is
   far past eyeballing one round at a time.
   - ?sheet=scenes: one seed per topology (scanned off a fixed list — the
     topology draw is a function of the seed alone), dealt through the REAL
     startScene at d 1/5/10 — recorder, env pool, terrain, veg, wetness,
     merge/freeze, nothing mocked — fast-forwarded to the incident tick with
     the render hooks nulled (the scrub trick), then captured at the wide fit.
   - ?sheet=weather: every env × every weather kind over a fixed two-car
     vignette. rollWeather's forceKind renders the off-distribution cells a
     roll can never deal (a desert blizzard belongs on a QA sheet even though
     WEIGHTS bars it from the game). Terrain is baked once per row under the
     row's first kind, so under the heaviest-haze cells the LANDSCAPE horizon
     can read slightly stale — the true bake-time agreement is reviewed on the
     scenes sheet, where every round bakes exactly as shipped.
   Both land on window.__sheet with per-cell renderer stats (draw calls,
   triangles, geometries, heap) on window.__sheetStats — the 4D budget
   numbers fall out of the same pass. Both run on the memory store (see
   `store`), so a QA sweep can never move the player's profile. Async, unlike
   the synchronous model sheets: they need the boot preload (Rapier). */
async function sceneSheet() {
  const { generateScene } = await import('./director.js');
  const byTopo = new Map();
  for (let i = 0; i < 400 && byTopo.size < 22; i++) {
    const sc0 = generateScene('qa' + i, 5);
    if (!byTopo.has(sc0.meta.topo)) byTopo.set(sc0.meta.topo, 'qa' + i);
  }
  const topos = [...byTopo.keys()].sort();
  const DS = [1, 5, 10];
  const tw = 512, th = 288;
  const sheet = document.createElement('canvas');
  sheet.width = DS.length * tw;
  sheet.height = topos.length * th;
  const c2 = sheet.getContext('2d');
  c2.fillStyle = '#101318';
  c2.fillRect(0, 0, sheet.width, sheet.height);
  renderer.setPixelRatio(1);
  renderer.setSize(tw, th);
  camera.aspect = tw / th;
  camera.updateProjectionMatrix();
  const stats = [];
  window.__sheetStats = stats; // exposed early so a hung run still shows partials
  for (let rI = 0; rI < topos.length; rI++) {
    const topo = topos[rI], sd = byTopo.get(topo);
    for (let cI = 0; cI < DS.length; cI++) {
      const d = DS[cI];
      const x = cI * tw, y = rI * th;
      let cell = `${topo} ${sd}~${d}`;
      try {
        await startScene(sd, d, false);
        if (!round || round.seed !== sd) throw new Error('round failed to mount');
        const sim = round.sim;
        // the scrub trick: fast-forward the quiet preview without dumping
        // 600 ticks of fx and audio into a single frame
        sim.onImpact = sim.onScrape = sim.onGlass = sim.onDetach = sim.onSplash = sim.onSunk = null;
        while (sim.tick < round.incidentTick) sim.stepOnce();
        // two real frames: the first runs freeze-entry (strip build included —
        // which QAs buildStrip on every topology for free), the second renders
        // the settled study frame the player actually gets
        invalidate(); frame(performance.now());
        invalidate(); frame(performance.now());
        c2.drawImage(renderer.domElement, x, y, tw, th);
        const inf = renderer.info;
        stats.push({
          topo, seed: sd, d, env: round.scene.world.env,
          wx: (round.scene.world.weather || {}).kind,
          calls: inf.render.calls, tris: inf.render.triangles,
          geos: inf.memory.geometries, tex: inf.memory.textures,
          heap: performance.memory ? performance.memory.usedJSHeapSize : 0,
        });
        cell += `  ${round.scene.world.env} · ${(round.scene.world.weather || {}).kind} · ${inf.render.calls}dc`;
      } catch (err) {
        console.error('SCENE SHEET FAIL', topo, sd, d, err);
        c2.fillStyle = '#7a2020';
        c2.fillRect(x, y, tw, th);
      }
      c2.fillStyle = '#ffffff';
      c2.font = 'bold 13px monospace';
      c2.fillText(cell, x + 8, y + 18);
      c2.strokeStyle = 'rgba(255,255,255,0.14)';
      c2.strokeRect(x + 0.5, y + 0.5, tw, th);
    }
  }
  destroyCrashSim();
  destroyRound();
  showShowroom(false);
  window.__sheet = sheet;
  document.body.replaceChildren(sheet);
  sheet.style.cssText = 'max-width:100%;height:auto;display:block';
  console.log(`SHEET DONE: ${topos.length} topologies × d ${DS.join('/')}`);
}

async function weatherSheet() {
  showShowroom(false);
  const envIds = ENVS.map((e) => e.id);
  const tw = 384, th = 216;
  const sheet = document.createElement('canvas');
  sheet.width = WEATHER_KINDS.length * tw;
  sheet.height = envIds.length * th;
  const c2 = sheet.getContext('2d');
  c2.fillStyle = '#101318';
  c2.fillRect(0, 0, sheet.width, sheet.height);
  renderer.setPixelRatio(1);
  renderer.setSize(tw, th);
  camera.aspect = tw / th;
  camera.updateProjectionMatrix();
  // fixed vignette: one car, one heavy — paint readability against every sky
  const carA = buildVehicle('wxqa1', REG[0].id).group;
  carA.position.set(2.6, 0, 1.4);
  carA.rotation.y = 0.55;
  const heavyE = REG.find((e) => /truck|heavy/i.test(e.cat || '')) || REG[1];
  const carB = buildVehicle('wxqa2', heavyE.id).group;
  carB.position.set(-4.6, 0, -2.8);
  carB.rotation.y = -2.1;
  scene.add(carA, carB);
  camera.position.set(21, 7.5, 21);
  controls.target.set(0, 1.4, 0);
  const stats = [];
  window.__sheetStats = stats;
  for (let rI = 0; rI < envIds.length; rI++) {
    const id = envIds[rI];
    env.apply(id);
    env.setGroundRadius(90);
    // bake the row's landscape under its first (calmest) kind — see the
    // header comment for why heavy-haze cells may read slightly stale
    env.applyWeather(rollWeather('wxqa:' + id, id, WEATHER_KINDS[0]));
    env.setTerrain({ seed: 'wxqa' });
    veg.clear();
    veg.build(env.terrainField, 'wxqa', { density: 1, value: env.terrainValue });
    for (let cI = 0; cI < WEATHER_KINDS.length; cI++) {
      const kind = WEATHER_KINDS[cI];
      const x = cI * tw, y = rI * th;
      try {
        const wx = rollWeather('wxqa:' + id, id, kind);
        env.applyWeather(wx);
        weather.set(wx);
        veg.setWind(wx);
        // let the precip volume advance so streaks/flakes render mid-fall
        for (let k = 0; k < 5; k++) weather.update(0.35, camera, false);
        invalidate();
        frame(performance.now());
        c2.drawImage(renderer.domElement, x, y, tw, th);
        const inf = renderer.info;
        stats.push({
          env: id, kind, calls: inf.render.calls, tris: inf.render.triangles,
          heap: performance.memory ? performance.memory.usedJSHeapSize : 0,
        });
      } catch (err) {
        console.error('WX SHEET FAIL', id, kind, err);
        c2.fillStyle = '#7a2020';
        c2.fillRect(x, y, tw, th);
      }
      c2.fillStyle = '#ffffff';
      c2.font = 'bold 13px monospace';
      c2.fillText(`${id} · ${kind}`, x + 8, y + 18);
      c2.strokeStyle = 'rgba(255,255,255,0.14)';
      c2.strokeRect(x + 0.5, y + 0.5, tw, th);
    }
  }
  scene.remove(carA, carB);
  disposeGroup(carA);
  disposeGroup(carB);
  veg.clear();
  window.__sheet = sheet;
  document.body.replaceChildren(sheet);
  sheet.style.cssText = 'max-width:100%;height:auto;display:block';
  console.log(`SHEET DONE: ${envIds.length} envs × ${WEATHER_KINDS.length} weather kinds`);
}

// determinism self-test: ?simtest=1 runs every scenario twice, compares hashes
if (q0.has('simtest')) {
  import('./physics.js')
    .then((m) => m.simSelfTest((id) => (REG.find((e) => e.id === id) || {}).cat || 'Cars'))
    .catch((e) => console.error('SIM DETERMINISTIC: FAIL (error)', e));
}

// boot preload gates the menu buttons (skipped for the pure-build test hooks)
if (!q0.has('smoke') && !q0.has('simtest') && !q0.has('sheet')) preload();

if (q0.has('sheet')) {
  const w = q0.get('sheet');
  // the game sheets need Rapier + fx + showroom warm-up; the model sheets
  // deliberately skip preload so they run with rAF suspended
  if (w === 'scenes') preload().then(sceneSheet).catch((e) => console.error('SHEET FAIL', e));
  else if (w === 'weather') preload().then(weatherSheet).catch((e) => console.error('SHEET FAIL', e));
  else contactSheet();
} else if (q0.has('scene')) {
  // dev: straight into a round. ?scene=<seed>~<d> (both optional)
  const [s, dRaw] = String(q0.get('scene') || '').split('~');
  const dN = parseInt(dRaw, 10);
  const go = () => startScene(s || null, Number.isFinite(dN) ? dN : null, false);
  if (preloaded) go();
  else { const t = setInterval(() => { if (preloaded) { clearInterval(t); go(); } }, 60); }
} else if (q0.has('crash')) { // dev: straight into crash mode (?crash=N picks the scene)
  const n = parseInt(q0.get('crash'), 10);
  if (n >= 1 && n <= CRASH_SCENES.length) crashSceneIdx = n - 1;
  startCrash(false);
} else if (q0.has('play')) startGame(false); // headless/dev: skip menu, no fullscreen

// debug hook for automated visual verification
window.__app = {
  renderer, scene, camera, controls, REG, env, fitCamera, invalidate,
  startGame, leaveGame, setCamMode, fly, flyUpdate, get showroom() { return showroom; },
  startCrash, nextCrash, replayCrash, get crash() { return crash; }, get crashFx() { return crashFx; },
  weather, rollWeather, veg,
  startScene, resumeRound, seekPreview, get round() { return round; }, get preloaded() { return preloaded; },
  pump: (now) => frame(now),
};
