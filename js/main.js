// main.js — scene, turntable, UI
import * as THREE from 'three';
import { OrbitControls } from '../libs/OrbitControls.js';
import { RoomEnvironment } from '../libs/RoomEnvironment.js';
import { buildVehicle, REG } from './vehicles.js';
import { disposeGroup, clamp } from './lib.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------- renderer / scene ---------------- */
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.18;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const BG = new THREE.Color('#35383e');
scene.background = BG;
scene.fog = new THREE.Fog(BG, 32, 78);

const camera = new THREE.PerspectiveCamera(33, 1, 0.1, 220);
camera.position.set(7.4, 4.6, 7.4);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.autoRotate = !reduceMotion;
controls.autoRotateSpeed = -1.7;
controls.minDistance = 2.2;
controls.maxDistance = 60;
controls.minPolarAngle = 0.15;
controls.maxPolarAngle = 1.5;
controls.target.set(0, 0.8, 0);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

scene.add(new THREE.HemisphereLight('#dfe6ee', '#4a4d53', 0.55));
const key = new THREE.DirectionalLight('#fff1de', 1.7);
key.position.set(6, 9, 4);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0002;
key.shadow.normalBias = 0.045;
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 80;
scene.add(key);
const fill = new THREE.DirectionalLight('#a9c0d8', 0.45);
fill.position.set(-6, 4, -5);
scene.add(fill);

function groundTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const x = c.getContext('2d');
  const grad = x.createRadialGradient(256, 256, 40, 256, 256, 256);
  grad.addColorStop(0, '#4b4e55');
  grad.addColorStop(0.55, '#3f424a');
  grad.addColorStop(1, '#35383e');
  x.fillStyle = grad;
  x.fillRect(0, 0, 512, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(90, 48),
  new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.96 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

/* ---------------- state ---------------- */
let current = null;
let paintSel = null;
let spawnT = 1;
let camFrom = null, camTo = null, camT = 1;
const hist = [];
let histIdx = -1;

const easeOutBack = (t) => { const c1 = 1.35, c3 = c1 + 1; return 1 + c3 * ((t - 1) ** 3) + c1 * ((t - 1) ** 2); };
const easeInOut = (t) => t * t * (3 - 2 * t);

function fitCamera(bb, instant) {
  const size = bb.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.z, size.y * 1.9);
  const dist = clamp((maxDim / 2) / Math.tan((camera.fov * Math.PI) / 360) * 0.98 + 0.9, 3.4, 50);
  const tgt = new THREE.Vector3(0, Math.min(size.y * 0.46, 2.2), 0);
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
  // fog follows the fitted distance so long rigs / zoomed-out views don't sink into it
  // (32/78 is the tuned baseline for a ~8-unit fit distance)
  const fk = clamp(dist / 8, 1, 2.6);
  scene.fog.near = 32 * fk;
  scene.fog.far = 78 * fk;
  // shadow frustum follows model size
  const s = maxDim * 0.72 + 1.6;
  const sc = key.shadow.camera;
  sc.left = -s; sc.right = s; sc.top = s; sc.bottom = -s;
  sc.updateProjectionMatrix();
  key.position.set(6, 9, 4).normalize().multiplyScalar(maxDim * 0.9 + 12);
}

/* ---------------- generate ---------------- */
function generate(seed, typeId, opts = {}) {
  if (current) {
    scene.remove(current.group);
    disposeGroup(current.group);
  }
  let v;
  try {
    v = buildVehicle(seed, typeId, paintSel);
  } catch (err) {
    console.error('BUILD FAIL', typeId, seed, err);
    v = buildVehicle(seed, 'sedan', paintSel);
  }
  current = v;
  scene.add(v.group);
  const bb = new THREE.Box3().setFromObject(v.group);
  fitCamera(bb, opts.instant);
  spawnT = reduceMotion || opts.instant ? 1 : 0;

  $('vname').textContent = v.name;
  $('vsub').textContent = `${v.typeLabel} · seed ${seed}`;
  $('seed').value = seed;
  const chip = $('namechip');
  chip.classList.remove('pop');
  void chip.offsetWidth; // restart animation
  chip.classList.add('pop');

  if (!opts.noHist) {
    hist.splice(histIdx + 1);
    hist.push({ seed: String(seed), typeId: $('type').value, paint: paintSel });
    histIdx = hist.length - 1;
    updateHistBtns();
  }
  const q = new URLSearchParams();
  q.set('seed', seed);
  if ($('type').value !== 'any') q.set('type', $('type').value);
  if (paintSel) q.set('paint', paintSel.replace('#', ''));
  history.replaceState(null, '', '?' + q.toString());

  // count triangles from geometry — renderer.info is 0/stale before a real frame
  // (e.g. hidden tab suspends rAF) and includes the ground disc
  let tris = 0;
  v.group.traverse((o) => {
    if (o.isMesh && o.geometry) {
      const g = o.geometry;
      tris += (g.index ? g.index.count : g.attributes.position ? g.attributes.position.count : 0) / 3;
    }
  });
  $('stats').textContent = Math.round(tris).toLocaleString() + ' tris';
}

const randomSeed = () => String(Math.floor(Math.random() * 90000) + 10000);

/* ---------------- UI ---------------- */
const typeSel = $('type');
{
  const optAny = document.createElement('option');
  optAny.value = 'any';
  optAny.textContent = `Surprise me — any of ${REG.length} types`;
  typeSel.appendChild(optAny);
  const cats = [...new Set(REG.map((e) => e.cat))];
  for (const cat of cats) {
    const og = document.createElement('optgroup');
    og.label = cat;
    for (const e of REG.filter((x) => x.cat === cat)) {
      const o = document.createElement('option');
      o.value = e.id;
      o.textContent = e.label;
      og.appendChild(o);
    }
    typeSel.appendChild(og);
  }
}
$('countline').textContent = `${REG.length} vehicle types · endless seeds`;

const SWATCHES = ['#c63d3d', '#e07b39', '#e3c53a', '#3e8948', '#3a76c4', '#2b3a55', '#e8e9eb', '#26292e', '#dd8fb4'];
const paintRow = $('paints');
{
  const auto = document.createElement('button');
  auto.className = 'chipbtn auto sel';
  auto.title = 'Automatic paint';
  auto.setAttribute('aria-label', 'Automatic paint');
  auto.textContent = 'Auto';
  auto.addEventListener('click', () => setPaint(null, auto));
  paintRow.appendChild(auto);
  for (const hex of SWATCHES) {
    const b = document.createElement('button');
    b.className = 'chipbtn';
    b.style.setProperty('--c', hex);
    b.title = 'Paint ' + hex;
    b.setAttribute('aria-label', 'Paint ' + hex);
    b.addEventListener('click', () => setPaint(hex, b));
    paintRow.appendChild(b);
  }
}
function setPaint(hex, btn) {
  paintSel = hex;
  paintRow.querySelectorAll('.chipbtn').forEach((c) => c.classList.remove('sel'));
  btn.classList.add('sel');
  if (current) generate($('seed').value || randomSeed(), typeSel.value, { noHist: true });
}

$('gen').addEventListener('click', () => generate(randomSeed(), typeSel.value));
$('dice').addEventListener('click', () => generate(randomSeed(), typeSel.value));
$('seed').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); generate($('seed').value.trim() || randomSeed(), typeSel.value); $('seed').blur(); }
});
typeSel.addEventListener('change', () => generate($('seed').value.trim() || randomSeed(), typeSel.value));

function updateHistBtns() {
  $('prev').disabled = histIdx <= 0;
  $('next').disabled = histIdx >= hist.length - 1;
}
function goHist(d) {
  const i = histIdx + d;
  if (i < 0 || i >= hist.length) return;
  histIdx = i;
  const h = hist[i];
  typeSel.value = h.typeId;
  paintSel = h.paint;
  paintRow.querySelectorAll('.chipbtn').forEach((c, j) => {
    c.classList.toggle('sel', h.paint === null ? j === 0 : SWATCHES[j - 1] === h.paint);
  });
  generate(h.seed, h.typeId, { noHist: true });
  updateHistBtns();
}
$('prev').addEventListener('click', () => goHist(-1));
$('next').addEventListener('click', () => goHist(1));

$('spin').addEventListener('click', () => {
  controls.autoRotate = !controls.autoRotate;
  $('spin').classList.toggle('on', controls.autoRotate);
  $('spin').setAttribute('aria-pressed', controls.autoRotate);
});
$('spin').classList.toggle('on', controls.autoRotate);

let toastT = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 2200);
}
$('namechip').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Share link copied');
  } catch { toast(location.href); }
});

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  // A clicked button keeps focus; Space would re-activate it on keyup AND
  // trigger Generate here. Blur it so only the shortcut fires.
  if (e.key === ' ' && e.target.tagName === 'BUTTON') e.target.blur();
  if (e.key === ' ' || e.key.toLowerCase() === 'g') { e.preventDefault(); generate(randomSeed(), typeSel.value); }
  else if (e.key.toLowerCase() === 'r') $('spin').click();
  else if (e.key === 'ArrowLeft') goHist(-1);
  else if (e.key === 'ArrowRight') goHist(1);
});

/* ---------------- resize / loop ---------------- */
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  // updateStyle=true: canvas drawing buffer is w*DPR but lays out at w CSS px —
  // without it, DPR 2-3 phones get a canvas 2-3x bigger than the viewport.
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
resize();

let last = performance.now();
function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (camT < 1 && camTo) {
    camT = Math.min(1, camT + dt / 0.55);
    const e = easeInOut(camT);
    camera.position.lerpVectors(camFrom.pos, camTo.pos, e);
    controls.target.lerpVectors(camFrom.tgt, camTo.tgt, e);
  }
  if (current && spawnT < 1) {
    spawnT = Math.min(1, spawnT + dt / 0.5);
    const e = easeOutBack(spawnT);
    current.group.scale.setScalar(Math.max(0.001, e));
    current.group.rotation.y = (1 - easeInOut(spawnT)) * -0.5;
  }
  controls.update();
  renderer.render(scene, camera);
}
requestAnimationFrame(animate);

/* ---------------- boot (URL params + smoke test) ---------------- */
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
if (q0.has('paint')) {
  const hex = '#' + q0.get('paint');
  const idx = SWATCHES.indexOf(hex);
  if (idx >= 0) {
    paintSel = hex;
    paintRow.querySelectorAll('.chipbtn').forEach((c, j) => c.classList.toggle('sel', j === idx + 1));
  }
}
const t0 = q0.get('type');
if (t0 && REG.some((e) => e.id === t0)) typeSel.value = t0;

// dev-only contact sheet: ?sheet=1 renders every registry type into one tiled canvas.
// Runs synchronously at boot so it works even when rAF is suspended (hidden tab).
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
  // canonical front-three-quarter view; fitCamera preserves this direction per vehicle
  camera.position.set(7.4, 4.6, 7.4);
  controls.target.set(0, 0.8, 0);
  for (let i = 0; i < REG.length; i++) {
    const e = REG[i];
    const x = (i % cols) * tile, y = Math.floor(i / cols) * tile;
    try {
      generate(seed, e.id, { instant: true, noHist: true });
      controls.update();
      renderer.render(scene, camera);
      c2.drawImage(renderer.domElement, x, y, tile, tile);
    } catch (err) {
      console.error('SHEET FAIL', e.id, err);
      c2.fillStyle = '#7a2020';
      c2.fillRect(x, y, tile, tile);
    }
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

if (q0.has('sheet')) contactSheet();
else generate(q0.get('seed') || randomSeed(), typeSel.value, { instant: true });

// debug hook for automated visual verification
window.__app = { renderer, scene, camera, controls, generate, REG };
