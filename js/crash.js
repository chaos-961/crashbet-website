// crash.js — Crash Bet mode: scenario editor + deterministic sim runner.
// Owns the crash UI rows in the dock panel; physics lives in physics.js.
import * as THREE from 'three';
import { loadRapier, CrashSim } from './physics.js';
import { REG } from './vehicles.js';
import { makeRng, clamp } from './lib.js';

const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;
const MAX_CARS = 8;

const catOf = (id) => { const e = REG.find((x) => x.id === id); return e ? e.cat : 'Cars'; };
const resolveType = (seed, typeId) => REG.some((e) => e.id === typeId) ? typeId : makeRng('t:' + seed).pick(REG).id;

export function initCrash(ctx) {
  // ctx: { scene, camera, controls, renderer, stage, toast, invalidate, fitBox,
  //        hideGarage, showGarage, randomSeed, getPickers, setPickers, writeGarageURL }
  let R = null, sim = null;
  let active = false;
  let selected = -1;
  let placing = false;
  let rebuildT = null;
  let dirty = false; // scenario edited since last sim build
  let savedCtrl = null;
  const scenario = { cars: [] };

  /* ---------------- selection indicator (ring + heading arrow) ---------------- */
  const selGroup = new THREE.Group();
  selGroup.visible = false;
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xffb03a, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(1, 1.09, 48), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.035;
  selGroup.add(ring);
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.1, 3), ringMat);
  arrow.rotation.z = -Math.PI / 2; // cone tip points +X
  arrow.position.y = 0.035;
  selGroup.add(arrow);
  const arrowHit = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
  arrow.add(arrowHit);
  ctx.scene.add(selGroup);

  function syncIndicator() {
    const car = sim && sim.cars[selected];
    if (!car || sim.playing) { selGroup.visible = false; ctx.invalidate(); return; }
    const spec = scenario.cars[selected];
    const bb = new THREE.Box3().setFromObject(car.wrap);
    const rad = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) * 0.62 + 0.25;
    selGroup.position.set(spec.x, 0, spec.z);
    selGroup.rotation.y = spec.heading;
    ring.scale.setScalar(rad);
    arrow.scale.setScalar(0.55);
    arrow.position.x = rad + 0.55;
    selGroup.visible = true;
    ctx.invalidate();
  }

  /* ---------------- scenario <-> sim ---------------- */
  async function ensureRapier() {
    if (R) return R;
    ctx.toast('Loading physics engine…');
    R = await loadRapier();
    return R;
  }

  function rebuildSim(fit) {
    if (!R) return;
    dirty = false;
    clearTimeout(rebuildT);
    if (sim) { ctx.scene.remove(sim.root); sim.dispose(); sim = null; }
    if (scenario.cars.length) {
      sim = new CrashSim(R, scenario, catOf);
      ctx.scene.add(sim.root);
      let tris = 0;
      sim.root.traverse((o) => { if (o.isMesh && o.geometry) tris += o.geometry.attributes.position.count / 3; });
      $('stats').textContent = `${scenario.cars.length} car${scenario.cars.length > 1 ? 's' : ''} · ${Math.round(tris).toLocaleString()} tris`;
    } else {
      $('stats').textContent = 'no cars — tap +';
    }
    setPlayUI(false);
    if (fit) fitScenario(true);
    renderChips();
    syncSelectionUI();
    ctx.invalidate();
  }

  function scheduleRebuild(ms = 200) {
    dirty = true;
    clearTimeout(rebuildT);
    rebuildT = setTimeout(() => rebuildSim(false), ms);
  }

  function fitScenario(instant) {
    const bb = new THREE.Box3();
    if (sim && sim.cars.length) {
      for (const c of sim.cars) bb.expandByObject(c.wrap);
      bb.expandByScalar(Math.max(4, bb.getSize(new THREE.Vector3()).length() * 0.12));
    } else {
      bb.set(new THREE.Vector3(-12, 0, -12), new THREE.Vector3(12, 4, 12));
    }
    ctx.fitBox(bb, instant);
  }

  /* ---------------- URL state ---------------- */
  const r2 = (v) => Math.round(v * 100) / 100;
  function writeURL() {
    const q = new URLSearchParams();
    q.set('mode', 'crash');
    for (const c of scenario.cars) {
      q.append('car', [
        encodeURIComponent(c.seed), c.type, (c.paint || '').replace('#', ''),
        r2(c.x), r2(c.z), Math.round(c.heading / DEG), r2(c.speed), r2(c.throttle), Math.round(c.steer / DEG),
      ].join('~'));
    }
    history.replaceState(null, '', '?' + q.toString());
  }

  function loadFromURL(q) {
    scenario.cars.length = 0;
    for (const raw of q.getAll('car').slice(0, MAX_CARS)) {
      const p = raw.split('~');
      if (p.length < 9) continue;
      scenario.cars.push({
        seed: decodeURIComponent(p[0]) || '11',
        type: resolveType(decodeURIComponent(p[0]) || '11', p[1]),
        paint: p[2] ? '#' + p[2] : null,
        x: clamp(+p[3] || 0, -80, 80), z: clamp(+p[4] || 0, -80, 80),
        heading: clamp(+p[5] || 0, -180, 180) * DEG,
        speed: clamp(+p[6] || 0, 0, 40),
        throttle: clamp(+p[7], 0, 1) || 0,
        steer: clamp(+p[8] || 0, -30, 30) * DEG,
      });
    }
    selected = scenario.cars.length ? 0 : -1;
  }

  function defaultScenario() {
    const pick = ctx.getPickers();
    const seedA = pick.seed || ctx.randomSeed();
    scenario.cars = [
      { seed: seedA, type: resolveType(seedA, pick.type), paint: pick.paint, x: -12, z: 0, heading: 0, speed: 14, throttle: 1, steer: 0 },
      { seed: '22', type: 'pickup', paint: null, x: 12, z: 0.5, heading: 180 * DEG, speed: 14, throttle: 1, steer: 0 },
    ];
    selected = 0;
  }

  /* ---------------- car chips ---------------- */
  function renderChips() {
    const row = $('carchips');
    row.replaceChildren();
    scenario.cars.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'ccar' + (i === selected ? ' sel' : '');
      const dot = document.createElement('span');
      dot.className = 'dot';
      const builtCar = sim && sim.cars[i];
      dot.style.background = c.paint || (builtCar ? '#' + guessPaint(builtCar) : '#888');
      b.appendChild(dot);
      const label = document.createElement('span');
      const entry = REG.find((e) => e.id === c.type);
      label.textContent = `${entry ? entry.label : c.type} · ${c.seed}`;
      b.appendChild(label);
      const x = document.createElement('span');
      x.className = 'x';
      x.textContent = '✕';
      x.addEventListener('click', (ev) => { ev.stopPropagation(); removeCar(i); });
      b.appendChild(x);
      b.addEventListener('click', () => selectCar(i));
      row.appendChild(b);
    });
    if (scenario.cars.length < MAX_CARS) {
      const add = document.createElement('button');
      add.className = 'ccar add';
      add.textContent = '+ Add car';
      add.addEventListener('click', startPlacing);
      row.appendChild(add);
    }
  }

  // biggest painted material in the build ≈ body color (chip dot only, cosmetic)
  function guessPaint(car) {
    let best = null, bestN = 0;
    car.wrap.traverse((o) => {
      if (o.isMesh && o.geometry && o.material && o.material.color) {
        const n = o.geometry.attributes.position.count;
        if (n > bestN) { bestN = n; best = o.material.color; }
      }
    });
    return best ? best.getHexString() : '888888';
  }

  function selectCar(i) {
    selected = i;
    renderChips();
    syncSelectionUI();
  }

  function removeCar(i) {
    scenario.cars.splice(i, 1);
    if (selected >= scenario.cars.length) selected = scenario.cars.length - 1;
    writeURL();
    rebuildSim(false);
    fitScenario(false);
  }

  function startPlacing() {
    if (scenario.cars.length >= MAX_CARS) { ctx.toast(`Max ${MAX_CARS} cars`); return; }
    placing = true;
    ctx.stage.style.cursor = 'crosshair';
    ctx.toast('Tap the ground to place the car');
  }

  function placeCar(pt) {
    placing = false;
    ctx.stage.style.cursor = '';
    const pick = ctx.getPickers();
    const seed = pick.seed || ctx.randomSeed();
    scenario.cars.push({
      seed, type: resolveType(seed, pick.type), paint: pick.paint,
      x: clamp(pt.x, -80, 80), z: clamp(pt.z, -80, 80),
      heading: Math.atan2(pt.z, -pt.x), // face the arena center
      speed: 14, throttle: 1, steer: 0,
    });
    selected = scenario.cars.length - 1;
    writeURL();
    rebuildSim(false);
    fitScenario(false);
  }

  /* ---------------- selected-car UI sync ---------------- */
  function syncSelectionUI() {
    const c = scenario.cars[selected];
    if (c) {
      $('c_heading').value = Math.round(c.heading / DEG);
      $('c_speed').value = Math.round(c.speed * 3.6);
      $('c_steer').value = Math.round(c.steer / DEG);
      $('c_throttle').value = Math.round(c.throttle * 100);
      ctx.setPickers({ type: c.type, seed: c.seed, paint: c.paint });
      const car = sim && sim.cars[selected];
      if (car) {
        $('vname').textContent = car.built.name;
        $('vsub').textContent = `${car.built.typeLabel} · seed ${c.seed} · ${Math.round(c.speed * 3.6)} km/h`;
      }
    }
    for (const [id, vid, fmt] of [
      ['c_heading', 'v_heading', (v) => v + '°'], ['c_speed', 'v_speed', (v) => v + ' km/h'],
      ['c_steer', 'v_steer', (v) => v + '°'], ['c_throttle', 'v_throttle', (v) => v + '%'],
    ]) $(vid).textContent = fmt($(id).value);
    syncIndicator();
  }

  function sliderChanged() {
    const c = scenario.cars[selected];
    if (!c) return;
    c.heading = +$('c_heading').value * DEG;
    c.speed = +$('c_speed').value / 3.6;
    c.steer = +$('c_steer').value * DEG;
    c.throttle = +$('c_throttle').value / 100;
    const car = sim && sim.cars[selected];
    if (car && !sim.playing) { // live heading preview
      car.wrap.rotation.set(0, c.heading, 0);
    }
    writeURL();
    syncSelectionUI();
    scheduleRebuild(300);
  }
  for (const id of ['c_heading', 'c_speed', 'c_steer', 'c_throttle']) {
    $(id).addEventListener('input', sliderChanged);
  }

  // garage pickers repurposed: in crash mode they edit the selected car
  function pickersChanged() {
    const c = scenario.cars[selected];
    if (!c) return;
    const pick = ctx.getPickers();
    c.seed = pick.seed || c.seed;
    c.type = resolveType(c.seed, pick.type);
    c.paint = pick.paint;
    writeURL();
    renderChips();
    scheduleRebuild(120);
  }

  /* ---------------- sim controls ---------------- */
  function setPlayUI(playing) {
    $('c_play').textContent = playing ? '⏸ Pause' : '▶ Play';
    $('c_play').classList.toggle('playing', playing);
  }

  function play() {
    if (!scenario.cars.length) { ctx.toast('Add a car first'); return; }
    if (dirty) rebuildSim(false); // edits since last build must land before running
    if (!sim) return;
    sim.playing = !sim.playing;
    setPlayUI(sim.playing);
    if (sim.playing) { selGroup.visible = false; fitScenario(false); }
    else syncIndicator();
    ctx.invalidate();
  }

  function reset() {
    if (!sim) return;
    sim.playing = false;
    if (dirty) rebuildSim(false);
    else sim.reset();
    setPlayUI(false);
    fitScenario(false);
    syncIndicator();
    ctx.invalidate();
  }

  function stepTick() {
    if (!sim) return;
    sim.playing = false;
    setPlayUI(false);
    sim.stepOnce();
    sim.syncVisuals(1);
    ctx.invalidate();
  }

  const SPEEDS = [1, 0.5, 0.25];
  const SPEED_LABEL = ['1×', '½×', '¼×'];
  let speedIdx = 0;
  function cycleSpeed() {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    if (sim) sim.speed = SPEEDS[speedIdx];
    $('c_slow').textContent = SPEED_LABEL[speedIdx];
    $('c_slow').classList.toggle('on', speedIdx > 0);
    $('c_slow').setAttribute('aria-pressed', String(speedIdx > 0));
  }
  $('c_play').addEventListener('click', play);
  $('c_reset').addEventListener('click', reset);
  $('c_step').addEventListener('click', stepTick);
  $('c_slow').addEventListener('click', cycleSpeed);

  /* ---------------- pointer: select / drag / rotate / place ---------------- */
  const ray = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const ptr = new THREE.Vector2();
  let drag = null; // { kind: 'move'|'rotate', idx, offX, offZ }

  function rayFromEvent(e) {
    const rect = ctx.renderer.domElement.getBoundingClientRect();
    ptr.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ptr, ctx.camera);
    const hit = new THREE.Vector3();
    return ray.ray.intersectPlane(groundPlane, hit) ? hit : null;
  }

  function pickCar(e) {
    if (!sim) return -1;
    const rect = ctx.renderer.domElement.getBoundingClientRect();
    ptr.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ptr, ctx.camera);
    const hits = ray.intersectObjects(sim.cars.map((c) => c.wrap), true);
    if (!hits.length) return -1;
    let o = hits[0].object;
    while (o) {
      const i = sim.cars.findIndex((c) => c.wrap === o);
      if (i >= 0) return i;
      o = o.parent;
    }
    return -1;
  }

  function onDown(e) {
    if (!active || !e.isPrimary) return;
    if (sim && sim.playing) return; // orbit only while running
    if (placing) {
      const pt = rayFromEvent(e);
      if (pt) placeCar(pt);
      e.stopPropagation();
      return;
    }
    // rotate handle?
    if (selGroup.visible) {
      const rect = ctx.renderer.domElement.getBoundingClientRect();
      ptr.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ptr, ctx.camera);
      if (ray.intersectObject(arrowHit, true).length) {
        drag = { kind: 'rotate', idx: selected };
        ctx.controls.enabled = false;
        e.stopPropagation();
        return;
      }
    }
    const i = pickCar(e);
    if (i >= 0) {
      const pt = rayFromEvent(e);
      const c = scenario.cars[i];
      selectCar(i);
      drag = { kind: 'move', idx: i, offX: pt ? c.x - pt.x : 0, offZ: pt ? c.z - pt.z : 0, moved: false };
      ctx.controls.enabled = false;
      e.stopPropagation();
    }
  }

  function onMove(e) {
    if (!drag || !active) return;
    const pt = rayFromEvent(e);
    if (!pt) return;
    const c = scenario.cars[drag.idx];
    if (!c) return;
    if (drag.kind === 'move') {
      c.x = clamp(pt.x + drag.offX, -80, 80);
      c.z = clamp(pt.z + drag.offZ, -80, 80);
      drag.moved = true;
      const car = sim.cars[drag.idx];
      if (car) car.wrap.position.set(c.x, car.wrap.position.y, c.z);
    } else {
      c.heading = Math.atan2(-(pt.z - c.z), pt.x - c.x);
      const car = sim.cars[drag.idx];
      if (car) car.wrap.rotation.set(0, c.heading, 0);
    }
    syncSelectionUI();
  }

  function onUp() {
    if (!drag) return;
    const wasDrag = drag.kind === 'rotate' || drag.moved;
    drag = null;
    ctx.controls.enabled = true;
    if (wasDrag) {
      writeURL();
      scheduleRebuild(60);
    }
  }

  ctx.stage.addEventListener('pointerdown', onDown, true);
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', onUp);

  /* ---------------- keyboard ---------------- */
  function keydown(e) {
    const k = e.key.toLowerCase();
    if (e.key === ' ') { e.preventDefault(); play(); return true; }
    if (k === 'r') { reset(); return true; }
    if (e.key === '.') { stepTick(); return true; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected >= 0) { removeCar(selected); return true; }
    if (['g', 't', 'f', 's'].includes(k)) return true; // garage-only keys: swallow
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') return true;
    return false;
  }

  /* ---------------- enter / exit ---------------- */
  async function enter(fromURL) {
    if (active) return;
    active = true;
    document.body.classList.add('mode-crash');
    $('tabGarage').classList.remove('on'); $('tabGarage').setAttribute('aria-selected', 'false');
    $('tabCrash').classList.add('on'); $('tabCrash').setAttribute('aria-selected', 'true');
    ctx.hideGarage();
    savedCtrl = { autoRotate: ctx.controls.autoRotate, pan: ctx.controls.enablePan };
    ctx.controls.autoRotate = false;
    ctx.controls.enablePan = true;
    await ensureRapier();
    if (!active) return; // user tabbed back while wasm loaded
    if (!scenario.cars.length && !fromURL) defaultScenario();
    rebuildSim(true);
    writeURL();
    ctx.invalidate();
  }

  function exit() {
    if (!active) return;
    active = false;
    placing = false;
    ctx.stage.style.cursor = '';
    clearTimeout(rebuildT);
    document.body.classList.remove('mode-crash');
    $('tabCrash').classList.remove('on'); $('tabCrash').setAttribute('aria-selected', 'false');
    $('tabGarage').classList.add('on'); $('tabGarage').setAttribute('aria-selected', 'true');
    if (sim) { sim.playing = false; ctx.scene.remove(sim.root); sim.dispose(); sim = null; }
    selGroup.visible = false;
    if (savedCtrl) { ctx.controls.autoRotate = savedCtrl.autoRotate; ctx.controls.enablePan = savedCtrl.pan; }
    ctx.showGarage();
    ctx.writeGarageURL();
    ctx.invalidate();
  }

  /* ---------------- per-frame ---------------- */
  function update(dt) {
    if (!active || !sim) return false;
    if (sim.playing) {
      sim.update(dt);
      sim.syncVisuals();
      ctx.invalidate();
      return true;
    }
    return false;
  }

  return {
    get active() { return active; },
    get sim() { return sim; },
    scenario,
    enter, exit, update, keydown, pickersChanged, loadFromURL,
    play, reset,
  };
}
