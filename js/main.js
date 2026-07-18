// main.js — scene, turntable, UI
import * as THREE from 'three';
import { OrbitControls } from '../libs/OrbitControls.js';
import { RoomEnvironment } from '../libs/RoomEnvironment.js';
import { buildVehicle, REG } from './vehicles.js';
import { disposeGroup, clamp, makeRng } from './lib.js';

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

// render-on-demand: skip renderer.render when nothing moves (spin off, no
// tweens, controls settled) instead of burning 60fps idle
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

scene.add(new THREE.HemisphereLight('#dfe6ee', '#4a4d53', 0.55));
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
  exitFleet();
  if (current) {
    scene.remove(current.group);
    disposeGroup(current.group);
  }
  let v;
  try {
    v = buildVehicle(seed, typeId, paintSel);
  } catch (err) {
    console.error('BUILD FAIL', typeId, seed, err);
    toast(`${typeId} build failed — showing a sedan instead`);
    v = buildVehicle(seed, 'sedan', paintSel);
  }
  current = v;
  scene.add(v.group);
  const bb = new THREE.Box3().setFromObject(v.group);
  fitCamera(bb, opts.instant);
  spawnT = reduceMotion || opts.instant ? 1 : 0;

  $('vname').textContent = v.name;
  $('vsub').textContent = `${v.typeLabel} · seed ${seed}`;
  if (v.golden) toast('✨ 1-in-100 golden find!');
  $('seed').value = seed;
  const chip = $('namechip');
  chip.classList.toggle('golden', !!v.golden);
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
  updateFavBtn();
  invalidate();
}

const randomSeed = () => String(Math.floor(Math.random() * 90000) + 10000);

/* ---------------- UI ---------------- */
const typeSel = $('type');
{
  const optAny = document.createElement('option');
  optAny.value = 'any';
  optAny.textContent = `Surprise me — any of ${REG.length} types`;
  typeSel.appendChild(optAny);
  const CAT_ICON = {
    Cars: '🚗', 'Racing & Fun': '🏁', 'Off-Road': '🏔️', 'Vans & Buses': '🚌', Trucks: '🚚',
    'Service & Emergency': '🚨', Construction: '🏗️', Rail: '🚋', Special: '✨',
  };
  const cats = [...new Set(REG.map((e) => e.cat))];
  for (const cat of cats) {
    const og = document.createElement('optgroup');
    og.label = (CAT_ICON[cat] ? CAT_ICON[cat] + ' ' : '') + cat;
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
typeSel.addEventListener('change', () => {
  const val = typeSel.value;
  if (val.startsWith('fav:')) { // favorites live in the same dropdown
    const f = favs[+val.slice(4)];
    if (f) {
      paintSel = f.paint;
      syncPaintChips();
      typeSel.value = REG.some((e) => e.id === f.type) ? f.type : 'any';
      generate(f.seed, f.type);
    }
    return;
  }
  generate($('seed').value.trim() || randomSeed(), val);
});

function syncPaintChips() {
  paintRow.querySelectorAll('.chipbtn').forEach((c, j) => {
    c.classList.toggle('sel', paintSel === null ? j === 0 : SWATCHES[j - 1] === paintSel);
  });
}

/* ---------------- favorites (localStorage) ---------------- */
const FAVKEY = 'lg_favs';
let favs = [];
try { favs = JSON.parse(localStorage.getItem(FAVKEY) || '[]'); } catch { favs = []; }
function favIndex() {
  if (!current) return -1;
  return favs.findIndex((f) => f.seed === current.seed && f.type === current.typeId && (f.paint || null) === paintSel);
}
function renderFavGroup() {
  const old = document.getElementById('favgroup');
  if (old) old.remove();
  if (!favs.length) return;
  const og = document.createElement('optgroup');
  og.id = 'favgroup';
  og.label = '★ Favorites';
  favs.forEach((f, i) => {
    const o = document.createElement('option');
    o.value = 'fav:' + i;
    o.textContent = f.name;
    og.appendChild(o);
  });
  typeSel.insertBefore(og, typeSel.children[1]);
}
function updateFavBtn() {
  const on = favIndex() >= 0;
  $('fav').classList.toggle('on', on);
  $('fav').setAttribute('aria-pressed', String(on));
  $('favstar').setAttribute('fill', on ? 'currentColor' : 'none');
}
$('fav').addEventListener('click', () => {
  if (!current) return;
  const i = favIndex();
  if (i >= 0) {
    favs.splice(i, 1);
    toast('Removed from favorites');
  } else {
    favs.push({ seed: current.seed, type: current.typeId, paint: paintSel, name: `${current.name} · ${current.seed}` });
    if (favs.length > 24) favs.shift();
    toast('★ Saved to favorites');
  }
  localStorage.setItem(FAVKEY, JSON.stringify(favs));
  renderFavGroup();
  updateFavBtn();
});
renderFavGroup();

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
  syncPaintChips();
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

/* ---------------- snapshot ---------------- */
$('snap').addEventListener('click', async () => {
  renderer.render(scene, camera); // fresh frame — the buffer isn't preserved after present
  const src = renderer.domElement;
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  const c2 = out.getContext('2d');
  c2.drawImage(src, 0, 0);
  const name = fleet ? `Fleet — seed ${$('seed').value}` : ($('vname').textContent || 'vehicle');
  const sub = fleet ? '' : $('vsub').textContent;
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
  const fname = (name.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'vehicle') + '.png';
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

/* ---------------- .glb export ---------------- */
$('glb').addEventListener('click', async () => {
  const target = fleet || (current && current.group);
  if (!target) return;
  toast('Exporting .glb…');
  try {
    const { GLTFExporter } = await import('../libs/GLTFExporter.js');
    new GLTFExporter().parse(target, (buf) => {
      const blob = new Blob([buf], { type: 'model/gltf-binary' });
      const base = fleet ? `fleet-${$('seed').value}` : ($('vname').textContent || 'vehicle');
      const a = document.createElement('a');
      a.download = (base.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'vehicle') + '.glb';
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

/* ---------------- fleet view ---------------- */
let fleet = null;
function exitFleet() {
  if (!fleet) return;
  scene.remove(fleet);
  disposeGroup(fleet);
  fleet = null;
  $('fleet').classList.remove('on');
  $('fleet').setAttribute('aria-pressed', 'false');
  if (current) scene.add(current.group);
  invalidate();
}
function showFleet() {
  if (fleet) { // toggle back to the single vehicle
    exitFleet();
    if (current) fitCamera(new THREE.Box3().setFromObject(current.group), false);
    return;
  }
  const seed = $('seed').value.trim() || randomSeed();
  $('seed').value = seed;
  const rf = makeRng('fleet:' + seed);
  const pool = [...REG];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rf() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picks = pool.slice(0, 40);
  const items = picks.map((e, i) => {
    const v = buildVehicle(seed + '#' + i, e.id, paintSel);
    const bb = new THREE.Box3().setFromObject(v.group);
    return { v, len: bb.max.x - bb.min.x, wid: bb.max.z - bb.min.z };
  });
  items.sort((a, b) => a.len - b.len); // small up front, big rigs in the back
  fleet = new THREE.Group();
  const perRow = 8;
  let x = 0;
  for (let rI = 0; rI * perRow < items.length; rI++) {
    const row = items.slice(rI * perRow, (rI + 1) * perRow);
    const maxLen = Math.max(...row.map((it) => it.len));
    const step = Math.max(...row.map((it) => it.wid)) + 1.15;
    row.forEach((it, i) => {
      it.v.group.position.set(x - maxLen / 2, 0, (i - (row.length - 1) / 2) * step);
      fleet.add(it.v.group);
    });
    x -= maxLen + 1.8;
  }
  const fc = new THREE.Box3().setFromObject(fleet).getCenter(new THREE.Vector3());
  fleet.position.x -= fc.x;
  fleet.position.z -= fc.z;
  if (current) scene.remove(current.group);
  scene.add(fleet);
  fitCamera(new THREE.Box3().setFromObject(fleet), false);
  spawnT = 1;
  $('fleet').classList.add('on');
  $('fleet').setAttribute('aria-pressed', 'true');
  invalidate();
  toast(`${picks.length} vehicles on the lot — seed ${seed}`);
}
$('fleet').addEventListener('click', showFleet);

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  // A clicked button keeps focus; Space would re-activate it on keyup AND
  // trigger Generate here. Blur it so only the shortcut fires.
  if (e.key === ' ' && e.target.tagName === 'BUTTON') e.target.blur();
  if (e.key === ' ' || e.key.toLowerCase() === 'g') { e.preventDefault(); generate(randomSeed(), typeSel.value); }
  else if (e.key.toLowerCase() === 'r') $('spin').click();
  else if (e.key.toLowerCase() === 'f') showFleet();
  else if (e.key.toLowerCase() === 't') { // cycle types with the current seed
    const dir = e.shiftKey ? REG.length - 1 : 1;
    const cur = current ? REG.findIndex((x) => x.id === current.typeId) : -1;
    const next = REG[(cur + dir + REG.length) % REG.length].id;
    typeSel.value = next;
    generate($('seed').value.trim() || randomSeed(), next);
  } else if (e.key.toLowerCase() === 's') { // slideshow / attract mode
    slideshow = !slideshow;
    slideT = 0;
    toast(slideshow ? 'Slideshow on — S to stop' : 'Slideshow off');
  } else if (e.key === 'ArrowLeft') goHist(-1);
  else if (e.key === 'ArrowRight') goHist(1);
});

/* ---------------- slideshow / attract mode ---------------- */
let slideshow = false, slideT = 0;

/* ---------------- resize / loop ---------------- */
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  // updateStyle=true: canvas drawing buffer is w*DPR but lays out at w CSS px —
  // without it, DPR 2-3 phones get a canvas 2-3x bigger than the viewport.
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
  if (slideshow) {
    slideT += dt;
    if (slideT > 6) { slideT = 0; generate(randomSeed(), typeSel.value); }
  }
  let animating = false;
  if (camT < 1 && camTo) {
    camT = Math.min(1, camT + dt / 0.55);
    const e = easeInOut(camT);
    camera.position.lerpVectors(camFrom.pos, camTo.pos, e);
    controls.target.lerpVectors(camFrom.tgt, camTo.tgt, e);
    animating = true;
  }
  if (current && !fleet && spawnT < 1) {
    spawnT = Math.min(1, spawnT + dt / 0.5);
    const e = easeOutBack(spawnT);
    current.group.scale.setScalar(Math.max(0.001, e));
    current.group.rotation.y = (1 - easeInOut(spawnT)) * -0.5;
    animating = true;
  }
  const moved = controls.update(); // true while auto-rotating or damping out
  if (animating || moved || needsRender > 0) {
    renderer.render(scene, camera);
    if (needsRender > 0) needsRender--;
  }
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

// PWA: offline cache + installability (network-first SW, see sw.js)
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

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
