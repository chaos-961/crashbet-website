// main.js — renderer/scene shell for the unified editor.
// Owns: renderer, camera, lights, environment hookup, camera tweens,
// snapshot/.glb export, help overlay, keyboard routing, boot. Everything
// scene-authoring lives in editor.js; simulation in physics.js.
import * as THREE from 'three';
import { OrbitControls } from '../libs/OrbitControls.js';
import { RoomEnvironment } from '../libs/RoomEnvironment.js';
import { buildVehicle, REG } from './vehicles.js';
import { disposeGroup, clamp } from './lib.js';
import { initEnv } from './env.js';
import { initEditor } from './editor.js';

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

const camera = new THREE.PerspectiveCamera(33, 1, 0.1, 260);
camera.position.set(13, 8.5, 13);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = true;
controls.minDistance = 2.2;
controls.maxDistance = 90;
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
  const dist = clamp((maxDim / 2) / Math.tan((camera.fov * Math.PI) / 360) * 0.98 + 0.9, 3.4, 80);
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
  // (each env preset's near/far is tuned for a ~8-unit fit)
  env.setFogScale(clamp(dist / 8, 1, 2.8));
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

const randomSeed = () => String(Math.floor(Math.random() * 90000) + 10000);

/* ---------------- editor ---------------- */
$('countline').textContent = `${REG.length} vehicle types · one sandbox`;
const editor = initEditor({
  scene, camera, controls, renderer, stage,
  toast, invalidate,
  fitBox: (bb, instant) => fitCamera(bb, instant),
  randomSeed, env, smallScreen,
});

/* ---------------- share link ---------------- */
$('namechip').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Share link copied');
  } catch { toast(location.href); }
});

/* ---------------- snapshot ---------------- */
$('snap').addEventListener('click', async () => {
  renderer.render(scene, camera); // fresh frame — the buffer isn't preserved after present
  const src = renderer.domElement;
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  const c2 = out.getContext('2d');
  c2.drawImage(src, 0, 0);
  const name = $('vname').textContent || 'crash-bet';
  const sub = $('vsub').textContent;
  const s = Math.max(out.width, out.height);
  c2.shadowColor = 'rgba(0,0,0,0.55)';
  c2.shadowBlur = s * 0.008;
  c2.fillStyle = '#f2f3f5';
  c2.font = `700 ${Math.round(s * 0.028)}px system-ui, sans-serif`;
  c2.fillText(name, s * 0.02, out.height - s * 0.035);
  if (sub) {
    c2.font = `500 ${Math.round(s * 0.017)}px system-ui, sans-serif`;
    c2.fillStyle = 'rgba(242,243,245,0.8)';
    c2.fillText(sub, s * 0.02, out.height - s * 0.012);
  }
  const blob = await new Promise((res) => out.toBlob(res, 'image/png'));
  if (!blob) { toast('Snapshot failed'); return; }
  const fname = (name.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'scene') + '.png';
  const file = new File([blob], fname, { type: 'image/png' });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Snapshot saved');
});

/* ---------------- .glb export (selected car, else the whole scene) ---------------- */
$('glb').addEventListener('click', async () => {
  const sim = editor.sim;
  const sel = editor.selection;
  let target = null, base = 'scene';
  if (sim && sel && sel.kind === 'car' && sim.cars[sel.i]) {
    target = sim.cars[sel.i].wrap;
    base = sim.cars[sel.i].built.name;
  } else if (sim && (sim.cars.length || sim.props.length)) {
    target = sim.root;
    base = 'crash-bet-scene';
  }
  if (!target) { toast('Nothing to export'); return; }
  toast('Exporting .glb…');
  try {
    const { GLTFExporter } = await import('../libs/GLTFExporter.js');
    new GLTFExporter().parse(target, (buf) => {
      const blob = new Blob([buf], { type: 'model/gltf-binary' });
      const a = document.createElement('a');
      a.download = (base.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'scene') + '.glb';
      a.href = URL.createObjectURL(blob);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast('.glb saved');
    }, (err) => { console.error('GLB EXPORT FAIL', err); toast('Export failed'); }, { binary: true });
  } catch (err) {
    console.error('GLB EXPORT FAIL', err);
    toast('Export failed');
  }
});

/* ---------------- hide / show controls ---------------- */
function toggleUI(force) {
  const hidden = document.body.classList.toggle('ui-collapsed', force);
  const btn = $('uitoggle');
  btn.setAttribute('aria-pressed', String(hidden));
  btn.setAttribute('aria-label', hidden ? 'Show controls' : 'Hide controls');
  btn.title = hidden ? 'Show controls (H)' : 'Hide controls (H)';
}
$('uitoggle').addEventListener('click', () => toggleUI());

/* ---------------- help overlay ---------------- */
function toggleHelp(force) {
  const ov = $('helpov');
  const show = force !== undefined ? force : ov.hidden;
  ov.hidden = !show;
}
$('helpBtn').addEventListener('click', () => toggleHelp());
$('helpClose').addEventListener('click', () => toggleHelp(false));
$('helpov').addEventListener('click', (e) => { if (e.target === $('helpov')) toggleHelp(false); });

/* ---------------- keyboard ---------------- */
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  // A clicked button keeps focus; Space would re-activate it on keyup AND
  // trigger Play here. Blur it so only the shortcut fires.
  if (e.key === ' ' && e.target.tagName === 'BUTTON') e.target.blur();
  if (!$('helpov').hidden && e.key !== '?') { if (e.key === 'Escape') toggleHelp(false); return; }
  if (e.key === '?') { toggleHelp(); return; }
  if (editor.keydown(e)) return;
  if (e.key.toLowerCase() === 'h') toggleUI();
});

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
  let animating = editor.update(dt); // sim steps at fixed 60 Hz internally
  if (camT < 1 && camTo) {
    camT = Math.min(1, camT + dt / 0.55);
    const e = easeInOut(camT);
    camera.position.lerpVectors(camFrom.pos, camTo.pos, e);
    controls.target.lerpVectors(camFrom.tgt, camTo.tgt, e);
    animating = true;
  }
  const moved = controls.update(); // true while damping out
  if (animating || moved || needsRender > 0) {
    renderer.render(scene, camera);
    if (needsRender > 0) needsRender--;
  }
}
requestAnimationFrame(animate);

/* ---------------- boot (URL params + test hooks) ---------------- */
const q0 = new URLSearchParams(location.search);
if (q0.has('smoke')) {
  let fails = 0, total = 0;
  for (const e of REG) {
    for (const s of ['11', '22', '33', 'lowpoly']) {
      total++;
      try { disposeGroup(buildVehicle(s, e.id).group); }
      catch (err) { fails++; console.error('SMOKE FAIL', e.id, s, err.message, err.stack); }
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

// determinism self-test: ?simtest=1 runs both scenarios twice and compares hashes
if (q0.has('simtest')) {
  import('./physics.js')
    .then((m) => m.simSelfTest((id) => (REG.find((e) => e.id === id) || {}).cat || 'Cars'))
    .catch((e) => console.error('SIM DETERMINISTIC: FAIL (error)', e));
}

if (q0.has('sheet')) contactSheet();
else editor.boot(q0).catch((e) => { console.error(e); toast('Failed to load scene'); });

// debug hook for automated visual verification
window.__app = { renderer, scene, camera, controls, REG, editor, env, fitCamera, invalidate };
