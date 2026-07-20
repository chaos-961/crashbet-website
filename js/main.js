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
import { disposeGroup, clamp, makeRng } from './lib.js';
import { initEnv, ENVS } from './env.js';
import { initFX } from './fx.js';
import * as Econ from './economy.js';
import { generateMarkets } from './markets.js';
import * as Bet from './betui.js';
import { buildLoadout, drivePov, POV_META } from './povcam.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

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

const camera = new THREE.PerspectiveCamera(33, 1, 0.1, 700);
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
const env = initEnv({ scene, hemi, key, fill, invalidate });
env.apply('proving');

/* ---------------- camera fitting / tween ---------------- */
let camFrom = null, camTo = null, camT = 1;
const easeInOut = (t) => t * t * (3 - 2 * t);

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
  // fog follows the fitted distance so big scenes don't sink into it
  env.setFogScale(clamp(dist / 8, 1, 20));
  // shadow frustum follows scene size
  const s = maxDim * 0.72 + 1.6;
  const sc = key.shadow.camera;
  sc.left = -s; sc.right = s; sc.top = s; sc.bottom = -s;
  sc.updateProjectionMatrix();
  key.position.set(6, 9, 4).normalize().multiplyScalar(maxDim * 0.9 + 12);
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
}

/* ---------------- game flow: menu → showroom ---------------- */
let inGame = false;

async function startGame(wantFullscreen = true) {
  if (wantFullscreen && !document.fullscreenElement) {
    try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch {}
    try { await screen.orientation.lock('landscape'); } catch {}
  }
  buildShowroom();
  showroom.visible = true; // may have been hidden by crash mode
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

/* ---------------- settings ---------------- */
{
  const row = $('set_envs');
  for (const e of ENVS) {
    const b = document.createElement('button');
    b.className = 'mchip' + (env.current === e.id ? ' sel' : '');
    b.dataset.env = e.id;
    b.textContent = e.label;
    b.addEventListener('click', () => {
      env.apply(e.id);
      row.querySelectorAll('.mchip').forEach((c) => c.classList.toggle('sel', c.dataset.env === e.id));
      invalidate();
    });
    row.appendChild(b);
  }
}
let quality = smallScreen ? 'low' : 'high';
function applyQuality(q) {
  quality = q;
  renderer.setPixelRatio(q === 'low' ? 1 : Math.min(devicePixelRatio, smallScreen ? 1.5 : 2));
  renderer.shadowMap.enabled = q !== 'low';
  scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
  $('set_quality').querySelectorAll('.mchip').forEach((c) => c.classList.toggle('sel', c.dataset.q === q));
  invalidate();
}
$('set_quality').querySelectorAll('.mchip').forEach((b) => {
  b.addEventListener('click', () => applyQuality(b.dataset.q));
});
applyQuality(quality);

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
    if (showroom) showroom.visible = false;
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
    // gentle auto-follow keeps the wreck centered (orbit mode only)
    if (!fly.on && crash.sim.cars.length) {
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

function bootStep(pct, msg) {
  $('bootfill').style.width = Math.round(pct * 100) + '%';
  $('bootmsg').textContent = msg;
}

async function preload() {
  try {
    bootStep(0.08, 'loading physics engine…');
    const mod = await import('./physics.js');
    bootStep(0.45, 'starting rapier…');
    const R = await mod.loadRapier();
    engine = { mod, R };
    bootStep(0.62, 'warming effects…');
    if (!crashFx) crashFx = initFX(scene, { small: smallScreen });
    await new Promise((r) => setTimeout(r, 0)); // let the frame breathe
    bootStep(0.78, 'building the yard…');
    buildShowroom();
    bootStep(1, 'ready');
    preloaded = true;
    $('boot').classList.add('done');
    for (const id of ['startBtn', 'seedBtn', 'garageBtn', 'crashBtn']) $(id).disabled = false;
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
const store = Econ.localStore();
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
  const el = $('loading');
  if (!show) { el.hidden = true; return; }
  el.hidden = false;
  if (label !== undefined) $('loadlabel').textContent = label;
  if (pct !== undefined) $('loadfill').style.width = Math.round(pct * 100) + '%';
  if (sub !== undefined) $('loadsub').textContent = sub;
}

function destroyRound() {
  if (!round) return;
  targetMap = null; hoverGroup = null;
  povRig = null; activePov = null;
  env.setWater(null); // otherwise the channel follows you into the showroom
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
async function startScene(seedArg, dArg, wantFullscreen = true) {
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
    let seed, exhibition;
    if (seedArg != null) {
      seed = String(seedArg);
      exhibition = true;
      Econ.exhibitionRound(profile, seed);
    } else {
      const r = Econ.currentRound(profile);
      seed = r.seed;
      exhibition = r.exhibition || Econ.seedSettled(profile, seed);
      r.exhibition = exhibition;
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
    if (showroom) showroom.visible = false;
    if (sc.world.env && ENVS.some((e) => e.id === sc.world.env)) env.apply(sc.world.env);
    env.setGroundRadius(sc.world.ground || 90);
    env.setWater(sc.world.water || null);

    const sim = new engine.mod.CrashSim(engine.R, sc, catOfId);
    sim.stopAt = INCIDENT_TICK; // hard freeze on the exact incident tick
    round = { sim, scene: sc, rec, markets, phase: 'preview', seed, d, exhibition, resumeAt: 0 };
    targetMap = buildTargetMap(sim); // crosshair/tap targets for this round
    scene.add(sim.root);
    povRig = buildLoadout(sc, seed, d, povFocus());
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
    $('outcome').hidden = true;
    $('sceneLv').textContent = 'LV ' + d;
    $('sceneTopo').textContent = sc.meta.topo + ' · ' + sc.meta.label;
    Bet.openRound({ scene: sc, markets, profile, store, exhibition });
    setRing(1, 10);
    camera.position.set(0, 40, 90);
    fitCamera(roundBox(sim), true);
    roundLoad(false);
    toast(`🎬 ${sc.meta.label} — LV ${d}`);
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
  const fxImpact = sim.onImpact;
  sim.onImpact = (car, ev) => {
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
}

const RING_LEN = 119.4;
function setRing(frac, secs) {
  $('rfg').style.strokeDashoffset = String(RING_LEN * (1 - clamp(frac, 0, 1)));
  $('ringT').textContent = String(Math.max(0, Math.ceil(secs)));
  $('ring').classList.toggle('hot', secs <= 3);
}

// resume from the freeze — the incident fires and physics runs to rest
function resumeRound() {
  if (!round || round.phase !== 'freeze') return;
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
function roundUpdate(dt, now) {
  if (!round || !inGame) return false;
  if (crashSlowT && now > crashSlowT) { round.sim.speed = 1; crashSlowT = 0; }
  if (!$('pause').hidden) return false;
  let busy = false;
  const sim = round.sim;
  sim.update(dt);
  sim.syncVisuals();
  if (crashFx.update(dt, camera)) busy = true;

  if (round.phase === 'preview') {
    const left = (600 - sim.tick) / 60;
    setRing(sim.tick / 600, left);
    busy = true;
    if (!sim.playing) { // stopAt reached: the freeze
      round.phase = 'freeze';
      Bet.setPhase('freeze');
      setRing(1, 0);
      if (round.d >= 8) { // no study time at the top difficulties
        resumeRound();
      } else {
        // the freeze is the last chance to bet — say so on the button
        const ss = Bet.slipSummary();
        $('fzGo').innerHTML = (!ss.placed && ss.total > 0)
          ? `🎫&nbsp; Bet $${ss.total} &amp; go`
          : '▶&nbsp; Resume';
        $('freeze').hidden = false;
        fitCamera(roundBox(sim), false);
      }
    }
  } else if (round.phase === 'resolve') {
    busy = true;
    Bet.tickLive(round.rec, sim.tick); // chips flip as their trigger ticks pass
    // gentle auto-follow on the wreck centroid (orbit only)
    if (!fly.on && sim.cars.length) {
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
      Econ.saveProfile(store, profile);
      Bet.settle(report, round.rec);
      renderPovBar(); // every angle unlocks once the scene has settled
      fitCamera(roundBox(sim), false);
    }
  }
  return busy;
}

// betting layer: mounted once, driven by the round lifecycle above
Bet.mountBetUI({
  onLock: resumeRound,
  // NEXT on the summary card deals the following campaign round (already
  // in-game, so never re-request fullscreen)
  onNext: () => startScene(null, null, false),
});
initProfile();

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

function renderPovBar() {
  const bar = $('povbar');
  if (!povRig || !round) { bar.innerHTML = ''; return; }
  // after the scene settles, every angle unlocks (spec: "after resolution,
  // everything unlocks") — before that, difficulty decides
  const list = round.phase === 'done' ? povRig.all : povRig.available;
  let html = `<button class="povchip${activePov ? '' : ' sel'}" data-pov="free">${POV_META.free.icon}</button>`;
  for (const p of list) {
    const m = POV_META[p.kind];
    const lab = p.kind === 'dash' && round.scene.cars[p.car]
      ? `${m.icon}` : m.icon;
    html += `<button class="povchip${activePov && activePov.id === p.id ? ' sel' : ''}" data-pov="${p.id}" title="${m.label}">${lab}</button>`;
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
function updateCrosshair() {
  const on = !!(round && inGame && fly.on && $('pause').hidden);
  $('crosshair').hidden = !on;
  if (!on) { hoverGroup = null; return; }
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
function syncMenu() {
  if (!profile) return;
  const unfinished = !!(profile.round && !profile.round.exhibition);
  $('mbAmt').textContent = '$' + profile.bankroll.toLocaleString('en-US');
  $('mbRun').textContent = unfinished ? 'round in progress' : 'round ' + (profile.campaign.n + 1);
  $('menubank').hidden = false;
  $('startBtn').innerHTML = unfinished ? '▶&nbsp; Resume round' : '▶&nbsp; Continue';
  // "New run" only means something once there is progress to throw away
  $('newRunBtn').hidden = !(profile.campaign.n > 0 || profile.bankroll !== Econ.START_BANKROLL || unfinished);
}

function openModal(which) {
  $('modalTitle').textContent = which === 'how' ? 'How to play' : 'Custom seed';
  $('modalSeed').hidden = which !== 'seed';
  $('modalHow').hidden = which !== 'how';
  $('modal').hidden = false;
  if (which === 'seed') setTimeout(() => $('seedInput').focus(), 30);
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
addEventListener('pointerdown', (e) => {
  if (!round || round.phase !== 'freeze') return;
  // taps inside the betting layer are bets, not "resume" — the freeze is the
  // last chance to build a slip, so it must survive touching the panel
  if (e.target && e.target.closest && e.target.closest('#betui')) return;
  resumeRound();
});

/* ---------------- keyboard ---------------- */
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'Escape' && inGame) showPause($('pause').hidden);
  if ((e.key === 'c' || e.key === 'C') && inGame) { setCamMode(fly.on ? 'orbit' : 'fly'); return; }
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
  updateCrosshair();
  // OrbitControls.update() re-aims the camera at its target even when the
  // handlers are disabled — never run it while freecam or a POV owns the camera
  const moved = (fly.on || activePov) ? false : controls.update();
  env.syncSky(camera.position);
  if (animating || moved || needsRender > 0) {
    // camera shake is applied for the render only, then undone — orbit and
    // freecam state never see the jitter
    if (crashFx) crashFx.applyShake(camera);
    renderer.render(scene, camera);
    if (crashFx) crashFx.undoShake(camera);
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
function contactSheet() {
  const tile = 340, cols = 8;
  const seed = q0.get('seed') || '11';
  const rows = Math.ceil(REG.length / cols);
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
  for (let i = 0; i < REG.length; i++) {
    const e = REG[i];
    const x = (i % cols) * tile, y = Math.floor(i / cols) * tile;
    let v = null;
    try {
      v = buildVehicle(seed, e.id);
      scene.add(v.group);
      camera.position.set(7.4, 4.6, 7.4);
      controls.target.set(0, 0.8, 0);
      fitCamera(new THREE.Box3().setFromObject(v.group), true);
      controls.update();
      renderer.render(scene, camera);
      c2.drawImage(renderer.domElement, x, y, tile, tile);
    } catch (err) {
      console.error('SHEET FAIL', e.id, err);
      c2.fillStyle = '#7a2020';
      c2.fillRect(x, y, tile, tile);
    }
    if (v) { scene.remove(v.group); disposeGroup(v.group); }
    c2.fillStyle = '#ffffff';
    c2.font = 'bold 15px monospace';
    c2.fillText(e.id, x + 10, y + 22);
    c2.strokeStyle = 'rgba(255,255,255,0.12)';
    c2.strokeRect(x + 0.5, y + 0.5, tile, tile);
  }
  window.__sheet = sheet;
  document.body.replaceChildren(sheet);
  sheet.style.cssText = 'max-width:100%;height:auto;display:block';
  console.log(`SHEET DONE: ${REG.length} types, seed ${seed}`);
}

// determinism self-test: ?simtest=1 runs every scenario twice, compares hashes
if (q0.has('simtest')) {
  import('./physics.js')
    .then((m) => m.simSelfTest((id) => (REG.find((e) => e.id === id) || {}).cat || 'Cars'))
    .catch((e) => console.error('SIM DETERMINISTIC: FAIL (error)', e));
}

// boot preload gates the menu buttons (skipped for the pure-build test hooks)
if (!q0.has('smoke') && !q0.has('simtest') && !q0.has('sheet')) preload();

if (q0.has('sheet')) contactSheet();
else if (q0.has('scene')) {
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
  startScene, resumeRound, get round() { return round; }, get preloaded() { return preloaded; },
  pump: (now) => frame(now),
};
