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
import { disposeGroup, clamp } from './lib.js';
import { initEnv, ENVS } from './env.js';

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
  document.body.classList.remove('ingame');
  $('pause').hidden = true;
  $('hud').hidden = true;
  $('menu').hidden = false;
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
$('startBtn').addEventListener('click', () => startGame(true));
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

/* ---------------- keyboard ---------------- */
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'Escape' && inGame) showPause($('pause').hidden);
  if ((e.key === 'c' || e.key === 'C') && inGame) { setCamMode(fly.on ? 'orbit' : 'fly'); return; }
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
  // OrbitControls.update() re-aims the camera at its target even when the
  // handlers are disabled — never run it while the freecam owns the camera
  const moved = fly.on ? false : controls.update();
  env.syncSky(camera.position);
  if (animating || moved || needsRender > 0) {
    renderer.render(scene, camera);
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

if (q0.has('sheet')) contactSheet();
else if (q0.has('play')) startGame(false); // headless/dev: skip menu, no fullscreen

// debug hook for automated visual verification
window.__app = {
  renderer, scene, camera, controls, REG, env, fitCamera, invalidate,
  startGame, leaveGame, setCamMode, fly, flyUpdate, get showroom() { return showroom; },
};
