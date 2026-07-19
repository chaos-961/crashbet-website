// editor.js — the unified sandbox editor (replaces the old Garage/Crash split).
// One scene, one inspector: spawn cars & props, select/move/rotate with a
// gizmo, tune per-car physics, and run the deterministic sim (physics.js).
//
// Editing contract: while paused, edits touch ONLY the edited object
// (CrashSim.replaceCar / replaceProp — meshes and creation order of everything
// else are untouched). Any edit sets `dirty`; Play/Reset/Step then do one full
// deterministic rebuild from the scenario, which is the only state a recorded
// run ever starts from. URL is the sole persistence layer.
import * as THREE from 'three';
import { loadRapier, CrashSim } from './physics.js';
import { REG } from './vehicles.js';
import { PROPS, SCENERY, isProp, isScenery, propMeta } from './props.js';
import { ENVS, isEnv } from './env.js';
import { buildRoad, ROAD_DEFAULTS, ROAD_MAX_PTS } from './roads.js';
import { generateWorld, WORLD_PRESETS } from './worldgen.js';
import { makeRng, clamp, disposeGroup } from './lib.js';

const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;
const r2 = (v) => Math.round(v * 100) / 100;

const catOf = (id) => { const e = REG.find((x) => x.id === id); return e ? e.cat : 'Cars'; };
const resolveType = (seed, typeId) => REG.some((e) => e.id === typeId) ? typeId : makeRng('t:' + seed).pick(REG).id;

export const SWATCHES = ['#c63d3d', '#e07b39', '#e3c53a', '#3e8948', '#3a76c4', '#2b3a55', '#e8e9eb', '#26292e', '#dd8fb4'];

export function initEditor(ctx) {
  // ctx: { scene, camera, controls, renderer, stage, toast, invalidate,
  //        fitBox, randomSeed, env, smallScreen }
  const MAX_CARS = ctx.smallScreen ? 6 : 10;
  const MAX_PROPS = ctx.smallScreen ? 20 : 48; // scenery counts as props (raised for generated worlds)
  const MAX_ROADS = ctx.smallScreen ? 3 : 6;

  let R = null, sim = null;
  let dirty = false;          // scenario edited since last full deterministic build
  let rebuildT = null;        // debounce timer for per-object rebuilds
  let placing = null;         // { kind:'car' } | { kind:'prop', prop:'ramp' }
  let drawingRoad = null;     // { pts: [{x,z}...] } while the road tool is laying points
  let sel = null;             // { kind:'car'|'prop'|'road', i }
  let suppressUI = false;     // guard against slider feedback loops

  const scenario = {
    cars: [], props: [], roads: [],
    world: { gravity: 9.81, slow: 1, arena: 80, walls: 1, env: 'proving' },
  };

  /* ================= selection / hover indicators ================= */
  const hoverBox = new THREE.Box3Helper(new THREE.Box3(), 0xbfc6d0);
  hoverBox.material.transparent = true;
  hoverBox.material.opacity = 0.4;
  hoverBox.visible = false;
  ctx.scene.add(hoverBox);
  const selBox = new THREE.Box3Helper(new THREE.Box3(), 0xffb03a);
  selBox.material.transparent = true;
  selBox.material.opacity = 0.85;
  selBox.material.depthTest = false;
  selBox.visible = false;
  ctx.scene.add(selBox);

  /* ================= transform gizmo (move arrows + rotate ring) ================= */
  const coarse = matchMedia('(pointer: coarse)').matches;
  const gz = new THREE.Group();
  gz.visible = false;
  ctx.scene.add(gz);
  const gzMats = {
    x: new THREE.MeshBasicMaterial({ color: 0xe0483a, depthTest: false, transparent: true, opacity: 0.95 }),
    z: new THREE.MeshBasicMaterial({ color: 0x3a8ae0, depthTest: false, transparent: true, opacity: 0.95 }),
    ring: new THREE.MeshBasicMaterial({ color: 0xffb03a, depthTest: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
  };
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });
  function makeArrow(axis) {
    const g = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 8), gzMats[axis]);
    shaft.rotation.z = -Math.PI / 2; // along +X
    shaft.position.x = 0.5;
    g.add(shaft);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.42, 10), gzMats[axis]);
    tip.rotation.z = -Math.PI / 2;
    tip.position.x = 1.21;
    g.add(tip);
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(coarse ? 0.62 : 0.4, coarse ? 0.62 : 0.4, 1.7, 6), hitMat);
    hit.rotation.z = -Math.PI / 2;
    hit.position.x = 0.85;
    hit.userData.gz = axis;
    g.add(hit);
    g.renderOrder = 5;
    if (axis === 'z') g.rotation.y = -Math.PI / 2; // +X template → +Z
    return g;
  }
  const arrowX = makeArrow('x'), arrowZ = makeArrow('z');
  gz.add(arrowX); gz.add(arrowZ);
  const ringVis = new THREE.Mesh(new THREE.TorusGeometry(1, 0.035, 8, 64), gzMats.ring);
  ringVis.rotation.x = Math.PI / 2;
  ringVis.renderOrder = 4;
  gz.add(ringVis);
  const ringHit = new THREE.Mesh(new THREE.TorusGeometry(1, coarse ? 0.42 : 0.3, 6, 32), hitMat);
  ringHit.rotation.x = Math.PI / 2;
  ringHit.userData.gz = 'ring';
  gz.add(ringHit);
  const ringNotch = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.36, 4), gzMats.ring);
  ringNotch.rotation.z = -Math.PI / 2;
  gz.add(ringNotch);
  gz.traverse((o) => { o.renderOrder = Math.max(o.renderOrder, 4); });

  function objOf(s) {
    if (!s || !sim) return null;
    if (s.kind === 'car') return sim.cars[s.i] || null;
    if (s.kind === 'road') return sim.roads[s.i] || null;
    return sim.props[s.i] || null;
  }
  function specOf(s) {
    if (!s) return null;
    if (s.kind === 'car') return scenario.cars[s.i];
    if (s.kind === 'road') return scenario.roads[s.i];
    return scenario.props[s.i];
  }
  const _bb = new THREE.Box3();
  function boundsOf(s) {
    const o = objOf(s);
    if (!o) return null;
    _bb.makeEmpty();
    if (s.kind === 'car') _bb.setFromObject(o.wrap);
    else if (s.kind === 'road') _bb.expandByObject(o.group);
    else {
      _bb.expandByObject(o.group);
      for (const d of o.dyn) _bb.expandByObject(d.node);
      if (_bb.isEmpty()) _bb.setFromCenterAndSize(new THREE.Vector3(o.spec.x, 0.5, o.spec.z), new THREE.Vector3(1, 1, 1));
    }
    return _bb;
  }

  // object-size radius cached so zooming only re-runs the cheap scale math
  let gzObjRad = 1;
  function gizmoRescale() {
    // keep the gizmo grabbable at any zoom: never smaller than ~6% of the
    // camera distance on screen, never comically larger than the object
    const dist = ctx.camera.position.distanceTo(gz.position);
    const rad = clamp(Math.max(gzObjRad, dist * 0.058), 0.8, gzObjRad + dist * 0.1);
    ringVis.scale.setScalar(rad);
    ringHit.scale.setScalar(rad);
    ringNotch.position.x = rad + 0.28;
    const aScale = clamp(rad * 0.75, 0.9, 2.6);
    for (const a of [arrowX, arrowZ]) a.scale.setScalar(aScale);
    arrowX.position.x = rad * 0.25;
    arrowZ.position.z = rad * 0.25;
  }
  ctx.controls.addEventListener('change', () => { if (gz.visible) gizmoRescale(); });

  function syncGizmo() {
    syncRoadHandles();
    const spec = specOf(sel);
    if (!spec || (sim && sim.playing) || sel.kind === 'road') {
      // roads use point handles instead of the move/rotate gizmo
      gz.visible = false; selBox.visible = false; ctx.invalidate(); return;
    }
    const bb = boundsOf(sel);
    if (!bb) { gz.visible = false; selBox.visible = false; return; }
    selBox.box.copy(bb);
    selBox.visible = true;
    gzObjRad = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) * 0.62 + 0.3;
    gz.position.set(spec.x, 0.06, spec.z);
    gz.rotation.y = spec.heading || 0;
    gizmoRescale();
    gz.visible = true;
    ctx.invalidate();
  }

  /* ================= road tool: point handles + draw preview ================= */
  const rh = new THREE.Group(); // one disc per control point of the active road
  rh.visible = false;
  ctx.scene.add(rh);
  const handleGeo = new THREE.CylinderGeometry(coarse ? 0.75 : 0.55, coarse ? 0.75 : 0.55, 0.24, 14);
  const handleMat = new THREE.MeshBasicMaterial({ color: 0xffb03a, depthTest: false, transparent: true, opacity: 0.92 });

  function activeRoadPts() {
    if (drawingRoad) return drawingRoad.pts;
    if (sel && sel.kind === 'road' && (!sim || !sim.playing)) {
      const r = scenario.roads[sel.i];
      return r ? r.pts : null;
    }
    return null;
  }
  function syncRoadHandles() {
    const pts = activeRoadPts();
    if (!pts || !pts.length) {
      if (rh.visible) { rh.clear(); rh.visible = false; ctx.invalidate(); }
      return;
    }
    while (rh.children.length > pts.length) rh.remove(rh.children[rh.children.length - 1]);
    while (rh.children.length < pts.length) {
      const m = new THREE.Mesh(handleGeo, handleMat);
      m.renderOrder = 6;
      m.userData.pi = rh.children.length;
      rh.add(m);
    }
    pts.forEach((p, j) => rh.children[j].position.set(p.x, 0.13, p.z));
    rh.visible = true;
    ctx.invalidate();
  }

  let previewRoad = null; // uncommitted mesh while drawing (visual only, no sim body)
  function refreshRoadPreview() {
    if (previewRoad) { ctx.scene.remove(previewRoad); disposeGroup(previewRoad); previewRoad = null; }
    if (drawingRoad && drawingRoad.pts.length >= 2) {
      previewRoad = buildRoad({ ...ROAD_DEFAULTS, pts: drawingRoad.pts }).group;
      ctx.scene.add(previewRoad);
    }
    syncRoadHandles();
    ctx.invalidate();
  }

  let roadT = null;
  function scheduleRoadRebuild() { // live point drag: rebuild that road only, throttled
    clearTimeout(roadT);
    const s = sel;
    roadT = setTimeout(() => {
      if (!sim || !s || s.kind !== 'road') return;
      if (scenario.roads[s.i] && sim.roads[s.i]) { sim.replaceRoad(s.i); ctx.invalidate(); }
    }, 90);
  }

  /* ================= sim lifecycle ================= */
  async function ensureRapier() {
    if (R) return R;
    ctx.toast('Loading physics engine…');
    R = await loadRapier();
    if (!sim) { sim = new CrashSim(R, scenario, catOf); ctx.scene.add(sim.root); }
    return R;
  }

  // full deterministic rebuild — the only path a run ever starts from
  function rebuildSim(fit) {
    if (!sim) return;
    dirty = false;
    clearTimeout(rebuildT);
    sim.playing = false;
    sim.reset();
    setPlayUI(false);
    if (fit) fitScenario(true);
    refreshChips();
    refreshStats();
    syncSelectionUI();
    ctx.invalidate();
  }

  function flushDirty() { if (dirty) rebuildSim(false); }

  function refreshStats() {
    const nC = scenario.cars.length, nP = scenario.props.length, nR = scenario.roads.length;
    if (!nC && !nP && !nR) { $('stats').textContent = 'empty scene'; return; }
    let tris = 0;
    if (sim) sim.root.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.attributes.position) tris += o.geometry.attributes.position.count / 3; });
    const bits = [];
    if (nC) bits.push(`${nC} car${nC > 1 ? 's' : ''}`);
    if (nP) bits.push(`${nP} prop${nP > 1 ? 's' : ''}`);
    if (nR) bits.push(`${nR} road${nR > 1 ? 's' : ''}`);
    $('stats').textContent = `${bits.join(' · ')} · ${Math.round(tris).toLocaleString()} tris`;
  }

  function refreshEmpty() {
    $('emptyhint').classList.toggle('show', !scenario.cars.length && !scenario.props.length && !scenario.roads.length);
  }

  function fitScenario(instant) {
    const bb = new THREE.Box3();
    if (sim && (sim.cars.length || sim.props.length || sim.roads.length)) {
      for (const c of sim.cars) bb.expandByObject(c.wrap);
      for (const p of sim.props) {
        bb.expandByObject(p.group);
        for (const d of p.dyn) bb.expandByObject(d.node);
      }
      for (const r of sim.roads) bb.expandByObject(r.group);
      bb.expandByScalar(Math.max(4, bb.getSize(new THREE.Vector3()).length() * 0.12));
    } else {
      bb.set(new THREE.Vector3(-12, 0, -12), new THREE.Vector3(12, 4, 12));
    }
    ctx.fitBox(bb, instant);
  }

  /* ================= URL codec (v2, backward compatible) ================= */
  function writeURL() {
    const q = new URLSearchParams();
    const W = scenario.world;
    if (scenario.cars.length || scenario.props.length || scenario.roads.length) {
      q.set('scene', [r2(W.gravity), r2(W.slow), Math.round(W.arena), W.walls ? 1 : 0, W.env].join('~'));
      for (const c of scenario.cars) {
        q.append('car', [
          // '~' is the field separator and encodeURIComponent leaves it alone — force-escape it
          encodeURIComponent(c.seed).replace(/~/g, '%7E'), c.type, (c.paint || '').replace('#', ''),
          r2(c.x), r2(c.z), Math.round(c.heading / DEG), r2(c.speed), r2(c.throttle), Math.round(c.steer / DEG),
          r2(c.mass), r2(c.grip), c.rest == null ? '' : r2(c.rest), r2(c.crumple),
          r2(c.delay), r2(c.brake), c.rolling ? 1 : 0,
        ].join('~'));
      }
      for (const p of scenario.props) {
        const f = [p.kind, r2(p.x), r2(p.z), Math.round(p.heading / DEG)];
        // v2: optional 5th field = scenery variant seed ('~' force-escaped like car seeds)
        if (p.seed != null) f.push(encodeURIComponent(p.seed).replace(/~/g, '%7E'));
        q.append('prop', f.join('~'));
      }
      for (const r of scenario.roads) {
        // road=w~loop~style~x,z~x,z~… (points are plain x,z pairs)
        q.append('road', [r2(r.w), r.loop ? 1 : 0, r.style || 0, ...r.pts.map((p) => r2(p.x) + ',' + r2(p.z))].join('~'));
      }
    } else if (W.env !== 'proving') {
      q.set('scene', [r2(W.gravity), r2(W.slow), Math.round(W.arena), W.walls ? 1 : 0, W.env].join('~'));
    }
    history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q.toString() : ''));
  }

  function parseCar(raw) {
    const p = raw.split('~');
    if (p.length < 9) return null;
    const seed = decodeURIComponent(p[0]) || '11';
    const num = (i, d) => (p[i] === undefined || p[i] === '' ? d : +p[i] || 0);
    return {
      seed, type: resolveType(seed, p[1]),
      paint: p[2] ? '#' + p[2] : null,
      x: clamp(+p[3] || 0, -100, 100), z: clamp(+p[4] || 0, -100, 100),
      heading: clamp(+p[5] || 0, -180, 180) * DEG,
      speed: clamp(+p[6] || 0, 0, 40),
      throttle: clamp(+p[7], 0, 1) || 0,
      steer: clamp(+p[8] || 0, -30, 30) * DEG,
      mass: clamp(num(9, 1) || 1, 0.5, 3),
      grip: clamp(num(10, 1) || 1, 0.3, 2.5),
      rest: p[11] === '' || p[11] === undefined ? null : clamp(+p[11] || 0, 0, 1),
      crumple: clamp(num(12, 1) || 1, 0.2, 2.5),
      delay: clamp(num(13, 0), 0, 10),
      brake: clamp(num(14, 0), 0, 20),
      rolling: num(15, 0) ? 1 : 0,
    };
  }

  function loadFromURL(q) {
    scenario.cars.length = 0;
    scenario.props.length = 0;
    scenario.roads.length = 0;
    const sc = (q.get('scene') || '').split('~');
    const W = scenario.world;
    if (sc.length >= 4) {
      W.gravity = clamp(+sc[0] || 9.81, 1, 25);
      W.slow = [1, 0.5, 0.25].includes(+sc[1]) ? +sc[1] : 1;
      W.arena = clamp(Math.round(+sc[2]) || 80, 40, 160);
      W.walls = +sc[3] ? 1 : 0;
      if (isEnv(sc[4])) W.env = sc[4];
    }
    for (const raw of q.getAll('car').slice(0, MAX_CARS)) {
      const c = parseCar(raw);
      if (c) scenario.cars.push(c);
    }
    for (const raw of q.getAll('prop').slice(0, MAX_PROPS)) {
      const p = raw.split('~');
      if (!isProp(p[0])) continue;
      const spec = {
        kind: p[0],
        x: clamp(+p[1] || 0, -100, 100), z: clamp(+p[2] || 0, -100, 100),
        heading: clamp(+p[3] || 0, -180, 180) * DEG,
      };
      if (isScenery(p[0])) spec.seed = p[4] ? decodeURIComponent(p[4]) : '1';
      scenario.props.push(spec);
    }
    for (const raw of q.getAll('road').slice(0, MAX_ROADS)) {
      const f = raw.split('~');
      if (f.length < 5) continue; // w, loop, style + at least 2 points
      const pts = [];
      for (let i = 3; i < f.length && pts.length < ROAD_MAX_PTS; i++) {
        const [x, z] = f[i].split(',').map(Number);
        if (Number.isFinite(x) && Number.isFinite(z)) pts.push({ x: clamp(x, -120, 120), z: clamp(z, -120, 120) });
      }
      if (pts.length >= 2) {
        scenario.roads.push({
          w: clamp(+f[0] || 7, 4, 14),
          loop: +f[1] ? 1 : 0,
          style: clamp(Math.round(+f[2]) || 0, 0, 7),
          pts,
        });
      }
    }
    // legacy garage links: ?seed=&type=&paint= → spawn that one car for inspection
    if (!scenario.cars.length && !scenario.props.length && (q.get('seed') || q.get('type'))) {
      const seed = q.get('seed') || ctx.randomSeed();
      const hex = q.get('paint') ? '#' + q.get('paint') : null;
      scenario.cars.push(defaultCarSpec(seed, q.get('type') || 'any', SWATCHES.includes(hex) ? hex : null, 0, 0, 0));
      scenario.cars[0].speed = 0;
      scenario.cars[0].throttle = 0;
    }
    sel = scenario.cars.length ? { kind: 'car', i: 0 } : null;
    ctx.env.apply(W.env);
  }

  function defaultCarSpec(seed, type, paint, x, z, heading) {
    return {
      seed, type: resolveType(seed, type), paint,
      x, z, heading, speed: 14, throttle: 1, steer: 0,
      mass: 1, grip: 1, rest: null, crumple: 1, delay: 0, brake: 0, rolling: 0,
    };
  }

  /* ================= paint rows ================= */
  function buildPaintRow(el, onPick) {
    const btns = [];
    const auto = document.createElement('button');
    auto.className = 'chipbtn auto sel';
    auto.textContent = 'Auto';
    auto.title = 'Automatic paint';
    auto.addEventListener('click', () => { setSel(null); onPick(null); });
    el.appendChild(auto);
    btns.push(auto);
    for (const hex of SWATCHES) {
      const b = document.createElement('button');
      b.className = 'chipbtn';
      b.style.setProperty('--c', hex);
      b.title = 'Paint ' + hex;
      b.setAttribute('aria-label', 'Paint ' + hex);
      b.addEventListener('click', () => { setSel(hex); onPick(hex); });
      el.appendChild(b);
      btns.push(b);
    }
    function setSel(hex) {
      btns.forEach((b, j) => b.classList.toggle('sel', hex === null ? j === 0 : SWATCHES[j - 1] === hex));
    }
    return { set: setSel };
  }

  const spawnPick = { seed: '', type: 'any', paint: null };
  const spawnPaints = buildPaintRow($('s_paints'), (hex) => { spawnPick.paint = hex; });
  const selPaints = buildPaintRow($('e_paints'), (hex) => {
    const c = scenario.cars[sel && sel.kind === 'car' ? sel.i : -1];
    if (!c) return;
    c.paint = hex;
    scheduleObjectRebuild();
  });

  /* ================= type dropdowns ================= */
  function fillTypeSelect(selEl, withAny) {
    if (withAny) {
      const optAny = document.createElement('option');
      optAny.value = 'any';
      optAny.textContent = `Surprise me — any of ${REG.length} types`;
      selEl.appendChild(optAny);
    }
    const CAT_ICON = {
      Cars: '🚗', 'Racing & Fun': '🏁', 'Off-Road': '🏔️', 'Vans & Buses': '🚌', Trucks: '🚚',
      'Service & Emergency': '🚨', Construction: '🏗️', Rail: '🚋', Special: '✨',
    };
    for (const cat of [...new Set(REG.map((e) => e.cat))]) {
      const og = document.createElement('optgroup');
      og.label = (CAT_ICON[cat] ? CAT_ICON[cat] + ' ' : '') + cat;
      for (const e of REG.filter((x) => x.cat === cat)) {
        const o = document.createElement('option');
        o.value = e.id;
        o.textContent = e.label;
        og.appendChild(o);
      }
      selEl.appendChild(og);
    }
  }
  fillTypeSelect($('s_type'), true);
  fillTypeSelect($('e_type'), false);

  /* ================= object chips ================= */
  function refreshChips() {
    const row = $('objchips');
    row.replaceChildren();
    scenario.cars.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'ccar' + (sel && sel.kind === 'car' && sel.i === i ? ' sel' : '');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = c.paint || '#8b929c';
      b.appendChild(dot);
      const entry = REG.find((e) => e.id === c.type);
      const label = document.createElement('span');
      label.textContent = `${entry ? entry.label : c.type} · ${c.seed}`;
      b.appendChild(label);
      b.addEventListener('click', () => select({ kind: 'car', i }));
      row.appendChild(b);
    });
    scenario.props.forEach((p, i) => {
      const b = document.createElement('button');
      b.className = 'ccar prop' + (sel && sel.kind === 'prop' && sel.i === i ? ' sel' : '');
      const meta = propMeta(p.kind);
      b.textContent = `${meta ? meta.icon + ' ' + meta.label : p.kind}`;
      b.addEventListener('click', () => select({ kind: 'prop', i }));
      row.appendChild(b);
    });
    scenario.roads.forEach((r, i) => {
      const b = document.createElement('button');
      b.className = 'ccar prop' + (sel && sel.kind === 'road' && sel.i === i ? ' sel' : '');
      b.textContent = `🛣 Road ${i + 1}`;
      b.addEventListener('click', () => select({ kind: 'road', i }));
      row.appendChild(b);
    });
    refreshEmpty();
  }

  /* ================= selection ================= */
  function select(s) {
    sel = s;
    refreshChips();
    syncSelectionUI();
  }

  function deselect() {
    sel = null;
    refreshChips();
    syncSelectionUI();
  }

  function syncSelectionUI() {
    const spec = specOf(sel);
    const isCar = sel && sel.kind === 'car';
    const isRoad = sel && sel.kind === 'road';
    document.body.classList.toggle('has-sel', !!spec);
    document.body.classList.toggle('sel-car', !!spec && isCar);
    document.body.classList.toggle('sel-prop', !!spec && !isCar && !isRoad);
    document.body.classList.toggle('sel-road', !!spec && isRoad);
    if (spec) $('sec_sel').open = true;
    suppressUI = true;
    if (spec && isCar) {
      const car = sim && sim.cars[sel.i];
      $('selTitle').textContent = car ? car.built.name : 'Selected car';
      $('vname').textContent = car ? car.built.name : '…';
      $('vsub').textContent = car ? `${car.built.typeLabel} · seed ${spec.seed} · ${Math.round(spec.speed * 3.6)} km/h` : '';
      $('e_type').value = spec.type;
      $('e_seed').value = spec.seed;
      selPaints.set(spec.paint || null);
      setSlider('e_heading', Math.round(spec.heading / DEG));
      setSlider('e_speed', Math.round(spec.speed * 3.6));
      setSlider('e_steer', Math.round(spec.steer / DEG));
      setSlider('e_throttle', Math.round(spec.throttle * 100));
      setSlider('e_mass', spec.mass);
      setSlider('e_grip', spec.grip);
      setSlider('e_rest', spec.rest == null ? 0.12 : spec.rest);
      setSlider('e_crumple', spec.crumple);
      setSlider('e_delay', spec.delay);
      setSlider('e_brake', spec.brake);
      $('e_rolling').checked = !!spec.rolling;
    } else if (spec && isRoad) {
      $('selTitle').textContent = `Road ${sel.i + 1}`;
      $('vname').textContent = `🛣 Road ${sel.i + 1}`;
      $('vsub').textContent = `${spec.pts.length} points · ${spec.loop ? 'closed loop' : 'open'} · ${r2(spec.w)} m wide`;
      setSlider('r_w', spec.w);
      $('r_loop').checked = !!spec.loop;
      $('r_yellow').checked = !!(spec.style & 1);
      $('r_side').checked = !!(spec.style & 2);
      $('r_cross').checked = !!(spec.style & 4);
    } else if (spec) {
      const meta = propMeta(spec.kind);
      const scen = isScenery(spec.kind);
      $('selTitle').textContent = meta ? meta.label : 'Prop';
      $('vname').textContent = meta ? `${meta.icon} ${meta.label}` : spec.kind;
      $('vsub').textContent = (scen ? `seed ${spec.seed || '1'} · ` : 'prop · ') + `x ${r2(spec.x)} · z ${r2(spec.z)}`;
      $('p_seedrow').style.display = scen ? '' : 'none';
      if (scen) $('p_seed').value = spec.seed || '1';
      setSlider('p_heading', Math.round(spec.heading / DEG));
    } else {
      $('selTitle').textContent = 'Selected';
      $('vname').textContent = 'Crash Bet';
      $('vsub').textContent = `${REG.length} vehicle types · tap an object to edit`;
    }
    suppressUI = false;
    syncGizmo();
  }

  /* ================= sliders ================= */
  const SLIDER_FMT = {
    e_heading: (v) => v + '°', e_speed: (v) => v + ' km/h', e_steer: (v) => v + '°', e_throttle: (v) => v + '%',
    e_mass: (v) => '×' + (+v).toFixed(2), e_grip: (v) => '×' + (+v).toFixed(2),
    e_rest: (v) => (+v).toFixed(2), e_crumple: (v) => '×' + (+v).toFixed(2),
    e_delay: (v) => (+v).toFixed(1) + ' s', e_brake: (v) => +v === 0 ? 'off' : (+v).toFixed(1) + ' s',
    p_heading: (v) => v + '°',
    r_w: (v) => (+v).toFixed(1) + ' m',
    g_gravity: (v) => (+v).toFixed(1) + ' m/s²', g_arena: (v) => v + ' m',
  };
  function setSlider(id, v) {
    $(id).value = v;
    $('v_' + id).textContent = SLIDER_FMT[id](v);
  }
  function sliderLabel(id) {
    $('v_' + id).textContent = SLIDER_FMT[id]($(id).value);
  }

  function carSliderChanged() {
    if (suppressUI) return;
    const c = sel && sel.kind === 'car' ? scenario.cars[sel.i] : null;
    if (!c) return;
    c.heading = +$('e_heading').value * DEG;
    c.speed = +$('e_speed').value / 3.6;
    c.steer = +$('e_steer').value * DEG;
    c.throttle = +$('e_throttle').value / 100;
    c.mass = +$('e_mass').value;
    c.grip = +$('e_grip').value;
    c.rest = +$('e_rest').value;
    c.crumple = +$('e_crumple').value;
    c.delay = +$('e_delay').value;
    c.brake = +$('e_brake').value;
    c.rolling = $('e_rolling').checked ? 1 : 0;
    if (sim && !sim.playing) sim.setCarPose(sel.i, c.x, c.z, c.heading);
    dirty = true;
    for (const id of ['e_heading', 'e_speed', 'e_steer', 'e_throttle', 'e_mass', 'e_grip', 'e_rest', 'e_crumple', 'e_delay', 'e_brake']) sliderLabel(id);
    $('vsub').textContent = sim && sim.cars[sel.i] ? `${sim.cars[sel.i].built.typeLabel} · seed ${c.seed} · ${Math.round(c.speed * 3.6)} km/h` : '';
    writeURL();
    syncGizmo();
    ctx.invalidate();
  }
  for (const id of ['e_heading', 'e_speed', 'e_steer', 'e_throttle', 'e_mass', 'e_grip', 'e_rest', 'e_crumple', 'e_delay', 'e_brake']) {
    $(id).addEventListener('input', carSliderChanged);
  }
  $('e_rolling').addEventListener('change', carSliderChanged);

  $('p_heading').addEventListener('input', () => {
    if (suppressUI) return;
    const p = sel && sel.kind === 'prop' ? scenario.props[sel.i] : null;
    if (!p) return;
    p.heading = +$('p_heading').value * DEG;
    sliderLabel('p_heading');
    dirty = true;
    schedulePropPose();
    writeURL();
  });

  /* ================= per-object rebuild scheduling ================= */
  // seed/type/paint edits: rebuild ONLY the selected car (debounced)
  function scheduleObjectRebuild(ms = 120) {
    dirty = true;
    writeURL();
    refreshChips();
    clearTimeout(rebuildT);
    const s = sel;
    rebuildT = setTimeout(() => {
      if (!sim || !s) return;
      if (s.kind === 'car' && sim.cars[s.i]) sim.replaceCar(s.i);
      else if (s.kind === 'prop' && sim.props[s.i]) sim.replaceProp(s.i);
      refreshStats();
      syncSelectionUI();
      ctx.invalidate();
    }, ms);
  }

  let propPoseT = null;
  function schedulePropPose() { // live prop move/rotate: rebuild that prop only, throttled
    clearTimeout(propPoseT);
    const s = sel;
    propPoseT = setTimeout(() => {
      if (!sim || !s || s.kind !== 'prop') return;
      const p = scenario.props[s.i];
      if (p && sim.props[s.i]) sim.setPropPose(s.i, p.x, p.z, p.heading);
      syncGizmo();
      ctx.invalidate();
    }, 40);
  }

  /* ================= selected-car pickers ================= */
  $('e_type').addEventListener('change', () => {
    if (suppressUI) return;
    const c = sel && sel.kind === 'car' ? scenario.cars[sel.i] : null;
    if (!c) return;
    c.type = $('e_type').value;
    scheduleObjectRebuild();
  });
  function applySeed(seed) {
    const c = sel && sel.kind === 'car' ? scenario.cars[sel.i] : null;
    if (!c || !seed) return;
    c.seed = seed;
    scheduleObjectRebuild();
  }
  $('e_seed').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); applySeed($('e_seed').value.trim()); $('e_seed').blur(); }
  });
  $('e_seed').addEventListener('change', () => applySeed($('e_seed').value.trim()));
  $('e_dice').addEventListener('click', () => {
    const seed = ctx.randomSeed();
    $('e_seed').value = seed;
    applySeed(seed);
  });

  // scenery variant seed: rebuild ONLY that prop (sim.replaceProp), like car seeds
  function applyPropSeed(seed) {
    const p = sel && sel.kind === 'prop' ? scenario.props[sel.i] : null;
    if (!p || !seed || !isScenery(p.kind) || p.seed === seed) return;
    p.seed = seed;
    if (sim && sim.props[sel.i]) sim.replaceProp(sel.i);
    dirty = true;
    writeURL();
    syncSelectionUI();
    ctx.invalidate();
  }
  $('p_seed').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); applyPropSeed($('p_seed').value.trim()); $('p_seed').blur(); }
  });
  $('p_seed').addEventListener('change', () => applyPropSeed($('p_seed').value.trim()));
  $('p_dice').addEventListener('click', () => applyPropSeed(ctx.randomSeed()));

  // road settings: width slider + style checkboxes rebuild only that road
  function roadSettingChanged() {
    if (suppressUI) return;
    const r = sel && sel.kind === 'road' ? scenario.roads[sel.i] : null;
    if (!r) return;
    r.w = +$('r_w').value;
    r.loop = $('r_loop').checked ? 1 : 0;
    r.style = ($('r_yellow').checked ? 1 : 0) | ($('r_side').checked ? 2 : 0) | ($('r_cross').checked ? 4 : 0);
    sliderLabel('r_w');
    dirty = true;
    scheduleRoadRebuild();
    writeURL();
    syncSelectionUI();
  }
  $('r_w').addEventListener('input', roadSettingChanged);
  for (const id of ['r_loop', 'r_yellow', 'r_side', 'r_cross']) $(id).addEventListener('change', roadSettingChanged);

  /* ================= road draw tool ================= */
  function beginRoadDraw() {
    if (drawingRoad) { finishRoadDraw(); return; } // the button doubles as Finish
    if (scenario.roads.length >= MAX_ROADS) { ctx.toast(`Max ${MAX_ROADS} roads`); return; }
    ensureRapier().then(() => {
      cancelPlace();
      deselect();
      drawingRoad = { pts: [] };
      ctx.stage.style.cursor = 'crosshair';
      syncPlaceUI();
      ctx.toast('Tap the ground to lay road points — Enter or the button finishes');
    }).catch((e) => { console.error(e); ctx.toast('Physics failed to load'); });
  }

  function finishRoadDraw(cancel) {
    const d = drawingRoad;
    if (!d) return;
    drawingRoad = null;
    ctx.stage.style.cursor = '';
    if (previewRoad) { ctx.scene.remove(previewRoad); disposeGroup(previewRoad); previewRoad = null; }
    if (!cancel && d.pts.length >= 2 && sim) {
      scenario.roads.push({ ...ROAD_DEFAULTS, pts: d.pts });
      sim.appendRoad();
      dirty = true;
      writeURL();
      refreshStats();
      select({ kind: 'road', i: scenario.roads.length - 1 });
    } else {
      if (!cancel && d.pts.length) ctx.toast('A road needs at least 2 points');
      syncRoadHandles();
    }
    syncPlaceUI();
    ctx.invalidate();
  }
  $('roadDraw').addEventListener('click', beginRoadDraw);

  /* ================= actions ================= */
  function duplicateSel() {
    const spec = specOf(sel);
    if (!spec || !sim) return null;
    if (sel.kind === 'car' && scenario.cars.length >= MAX_CARS) { ctx.toast(`Max ${MAX_CARS} cars`); return null; }
    if (sel.kind === 'prop' && scenario.props.length >= MAX_PROPS) { ctx.toast(`Max ${MAX_PROPS} props`); return null; }
    if (sel.kind === 'road' && scenario.roads.length >= MAX_ROADS) { ctx.toast(`Max ${MAX_ROADS} roads`); return null; }
    const copy = JSON.parse(JSON.stringify(spec));
    let s;
    if (sel.kind === 'road') {
      for (const p of copy.pts) { p.x = clamp(p.x + 2, -120, 120); p.z = clamp(p.z + 3.5, -120, 120); }
      scenario.roads.push(copy);
      sim.appendRoad();
      s = { kind: 'road', i: scenario.roads.length - 1 };
    } else if (sel.kind === 'car') {
      copy.x = clamp(copy.x + 1.2, -100, 100);
      copy.z = clamp(copy.z + 2.6, -100, 100);
      scenario.cars.push(copy);
      sim.appendCar();
      s = { kind: 'car', i: scenario.cars.length - 1 };
    } else {
      copy.x = clamp(copy.x + 1.2, -100, 100);
      copy.z = clamp(copy.z + 2.6, -100, 100);
      scenario.props.push(copy);
      sim.appendProp();
      s = { kind: 'prop', i: scenario.props.length - 1 };
    }
    dirty = true;
    writeURL();
    refreshStats();
    select(s);
    return s;
  }

  function deleteSel() {
    if (!sel || !sim) return;
    if (sel.kind === 'car') {
      scenario.cars.splice(sel.i, 1);
      sim.removeCarAt(sel.i);
    } else if (sel.kind === 'road') {
      scenario.roads.splice(sel.i, 1);
      sim.removeRoadAt(sel.i);
    } else {
      scenario.props.splice(sel.i, 1);
      sim.removePropAt(sel.i);
    }
    dirty = true;
    sel = null;
    writeURL();
    refreshChips();
    refreshStats();
    syncSelectionUI();
    ctx.invalidate();
  }

  function focusSel() {
    const bb = sel ? boundsOf(sel) : null;
    if (bb) {
      const grow = bb.clone();
      grow.expandByScalar(Math.max(1.5, grow.getSize(new THREE.Vector3()).length() * 0.18));
      ctx.fitBox(grow, false);
    } else fitScenario(false);
  }
  $('e_dup').addEventListener('click', duplicateSel);
  $('e_del').addEventListener('click', deleteSel);
  $('e_focus').addEventListener('click', focusSel);

  /* ================= spawn ================= */
  $('s_dice').addEventListener('click', () => { $('s_seed').value = ctx.randomSeed(); });

  function syncPlaceUI() {
    // armed-state feedback + mobile drawer auto-hide (body.placing, CSS)
    document.body.classList.toggle('placing', !!placing || !!drawingRoad);
    $('spawnCar').classList.toggle('arm', !!placing && placing.kind === 'car');
    for (const p of PROPS) $('prop_' + p.id).classList.toggle('arm', !!placing && placing.prop === p.id);
    $('spawnScenery').classList.toggle('arm', !!placing && isScenery(placing.prop));
    $('roadDraw').classList.toggle('arm', !!drawingRoad);
    $('roadDraw').textContent = drawingRoad ? '✓ Finish road' : '🛣 Draw road';
  }

  function cancelPlace() {
    placing = null;
    ctx.stage.style.cursor = '';
    syncPlaceUI();
  }

  function beginPlace(kind, prop) {
    if (drawingRoad) finishRoadDraw(true); // arming a spawn cancels the road tool
    if (placing && placing.kind === kind && placing.prop === prop) { cancelPlace(); return; } // toggle off
    if (kind === 'car' && scenario.cars.length >= MAX_CARS) { ctx.toast(`Max ${MAX_CARS} cars`); return; }
    if (kind === 'prop' && scenario.props.length >= MAX_PROPS) { ctx.toast(`Max ${MAX_PROPS} props`); return; }
    ensureRapier().then(() => {
      placing = { kind, prop };
      ctx.stage.style.cursor = 'crosshair';
      syncPlaceUI();
      ctx.toast(kind === 'car' ? 'Tap the ground to place the car' : 'Tap the ground to place the ' + prop);
    }).catch((e) => { console.error(e); ctx.toast('Physics failed to load'); });
  }
  $('spawnCar').addEventListener('click', () => beginPlace('car'));
  for (const p of PROPS) {
    $('prop_' + p.id).addEventListener('click', () => beginPlace('prop', p.id));
  }

  // scenery dropdown (grouped by category) + place button share the prop flow
  {
    const selEl = $('s_scenery');
    let grp = null, cat = null;
    for (const s of SCENERY) {
      if (s.cat !== cat) { cat = s.cat; grp = document.createElement('optgroup'); grp.label = cat; selEl.appendChild(grp); }
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = `${s.icon} ${s.label}`;
      grp.appendChild(o);
    }
  }
  $('spawnScenery').addEventListener('click', () => beginPlace('prop', $('s_scenery').value));

  function placeAt(pt) {
    const kind = placing.kind, prop = placing.prop;
    cancelPlace();
    if (!sim) return;
    if (kind === 'car' && scenario.cars.length >= MAX_CARS) { ctx.toast(`Max ${MAX_CARS} cars`); return; }
    if (kind === 'prop' && scenario.props.length >= MAX_PROPS) { ctx.toast(`Max ${MAX_PROPS} props`); return; }
    const half = scenario.world.arena / 2;
    const x = clamp(pt.x, -half, half), z = clamp(pt.z, -half, half);
    if (kind === 'car') {
      const seed = $('s_seed').value.trim() || ctx.randomSeed();
      const spec = defaultCarSpec(seed, spawnPick.type, spawnPick.paint, x, z, Math.atan2(z, -x));
      scenario.cars.push(spec);
      const rig = sim.appendCar();
      if (rig && rig.built.golden) ctx.toast('✨ 1-in-100 golden find!');
      dirty = true;
      writeURL();
      refreshStats();
      select({ kind: 'car', i: scenario.cars.length - 1 });
      if (scenario.cars.length === 1 && !scenario.props.length) focusSel();
    } else {
      const spec = { kind: prop, x, z, heading: 0 };
      if (isScenery(prop)) spec.seed = ctx.randomSeed(); // fresh variant each spawn
      scenario.props.push(spec);
      sim.appendProp();
      dirty = true;
      writeURL();
      refreshStats();
      select({ kind: 'prop', i: scenario.props.length - 1 });
    }
    ctx.invalidate();
  }
  $('s_type').addEventListener('change', () => { spawnPick.type = $('s_type').value; });

  /* ================= scene settings ================= */
  function sceneChanged(rebuild) {
    const W = scenario.world;
    dirty = dirty || rebuild;
    writeURL();
    if (rebuild && sim && !sim.playing) rebuildSim(false);
  }
  $('g_gravity').addEventListener('input', () => {
    scenario.world.gravity = +$('g_gravity').value;
    sliderLabel('g_gravity');
    sceneChanged(true);
  });
  for (const [id, val] of [['g_moon', 1.6], ['g_earth', 9.81], ['g_heavy', 20]]) {
    $(id).addEventListener('click', () => {
      scenario.world.gravity = val;
      setSlider('g_gravity', val);
      sceneChanged(true);
    });
  }
  $('g_arena').addEventListener('input', () => {
    scenario.world.arena = +$('g_arena').value;
    sliderLabel('g_arena');
    sceneChanged(true);
  });
  $('g_walls').addEventListener('change', () => {
    scenario.world.walls = $('g_walls').checked ? 1 : 0;
    sceneChanged(true);
  });
  {
    const row = $('envchips');
    for (const e of ENVS) {
      const b = document.createElement('button');
      b.className = 'ccar env' + (scenario.world.env === e.id ? ' sel' : '');
      b.dataset.env = e.id;
      b.textContent = e.label;
      b.addEventListener('click', () => {
        scenario.world.env = e.id;
        ctx.env.apply(e.id);
        syncEnvChips();
        writeURL(); // visual only — no sim rebuild needed
      });
      row.appendChild(b);
    }
  }
  function syncEnvChips() {
    $('envchips').querySelectorAll('.ccar').forEach((b) => b.classList.toggle('sel', b.dataset.env === scenario.world.env));
  }

  /* ================= world generator ================= */
  // replaces roads + props with a seeded generated scene; cars are kept
  // (or one is spawned at the road start so the result plays instantly)
  let lastPreset = WORLD_PRESETS[0].id;
  function runWorldGen(preset, seed) {
    lastPreset = preset;
    return ensureRapier().then(() => {
      if (drawingRoad) finishRoadDraw(true);
      cancelPlace();
      const gen = generateWorld(preset, seed, { maxProps: MAX_PROPS, maxRoads: MAX_ROADS });
      if (!gen) return;
      scenario.roads.length = 0;
      scenario.props.length = 0;
      scenario.roads.push(...gen.roads);
      scenario.props.push(...gen.props);
      scenario.world.arena = gen.world.arena;
      scenario.world.env = gen.world.env;
      ctx.env.apply(gen.world.env);
      if (!scenario.cars.length) {
        const p0 = gen.roads[0].pts[0], p1 = gen.roads[0].pts[1];
        scenario.cars.push(defaultCarSpec(
          ctx.randomSeed(), 'any', null, p0.x, p0.z,
          Math.atan2(-(p1.z - p0.z), p1.x - p0.x),
        ));
      }
      sel = null;
      rebuildSim(false);
      syncSceneUI();
      writeURL();
      fitScenario(false);
      ctx.toast(`Generated ${WORLD_PRESETS.find((w) => w.id === preset).label.slice(2).trim()} · seed ${seed}`);
    }).catch((e) => { console.error(e); ctx.toast('Physics failed to load'); });
  }
  {
    const row = $('wgchips');
    for (const p of WORLD_PRESETS) {
      const b = document.createElement('button');
      b.className = 'ccar';
      b.textContent = p.label;
      b.title = `Generate a ${p.id} scene (replaces roads & props)`;
      b.addEventListener('click', () => runWorldGen(p.id, $('wg_seed').value.trim() || ctx.randomSeed()));
      row.appendChild(b);
    }
  }
  $('wg_dice').addEventListener('click', () => {
    const seed = ctx.randomSeed();
    $('wg_seed').value = seed;
    runWorldGen(lastPreset, seed);
  });
  function syncSceneUI() {
    const W = scenario.world;
    suppressUI = true;
    setSlider('g_gravity', W.gravity);
    setSlider('g_arena', W.arena);
    $('g_walls').checked = !!W.walls;
    syncEnvChips();
    syncSlowUI();
    suppressUI = false;
  }

  /* ================= transport ================= */
  function setPlayUI(playing) {
    $('c_play').textContent = playing ? '⏸ Pause' : '▶ Play';
    $('c_play').classList.toggle('playing', playing);
  }

  function play() {
    if (!scenario.cars.length && !scenario.props.length) { ctx.toast('Spawn a car first'); return; }
    if (!sim) return;
    if (!sim.playing) flushDirty(); // edits must land before a run starts — but pausing never rebuilds
    sim.playing = !sim.playing;
    sim.speed = scenario.world.slow;
    setPlayUI(sim.playing);
    if (sim.playing) { gz.visible = false; selBox.visible = false; hoverBox.visible = false; fitScenario(false); }
    else syncSelectionUI();
    ctx.invalidate();
  }

  function reset() {
    if (!sim) return;
    rebuildSim(false);
    fitScenario(false);
  }

  function stepTick() {
    if (!sim || (!scenario.cars.length && !scenario.props.length)) return;
    if (dirty) rebuildSim(false);
    sim.playing = false;
    setPlayUI(false);
    sim.stepOnce();
    sim.syncVisuals(1);
    gz.visible = false;
    selBox.visible = false;
    ctx.invalidate();
  }

  const SPEEDS = [1, 0.5, 0.25];
  const SPEED_LABEL = { 1: '1×', 0.5: '½×', 0.25: '¼×' };
  function cycleSpeed() {
    const i = SPEEDS.indexOf(scenario.world.slow);
    scenario.world.slow = SPEEDS[(i + 1) % SPEEDS.length];
    if (sim) sim.speed = scenario.world.slow;
    syncSlowUI();
    writeURL();
  }
  function syncSlowUI() {
    $('c_slow').textContent = SPEED_LABEL[scenario.world.slow] || '1×';
    $('c_slow').classList.toggle('on', scenario.world.slow !== 1);
    $('c_slow').setAttribute('aria-pressed', String(scenario.world.slow !== 1));
  }
  $('c_play').addEventListener('click', play);
  $('c_reset').addEventListener('click', reset);
  $('c_step').addEventListener('click', stepTick);
  $('c_slow').addEventListener('click', cycleSpeed);

  /* ================= pointer: hover / select / gizmo / place ================= */
  const ray = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const ptr = new THREE.Vector2();
  let drag = null; // { mode:'free'|'axis-x'|'axis-z'|'ring', s, offX, offZ, axis, startX, startZ, downX, downY, moved }
  let downEmpty = null;

  function setRayFrom(e) {
    const rect = ctx.renderer.domElement.getBoundingClientRect();
    ptr.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ptr, ctx.camera);
  }
  function groundHit(e) {
    setRayFrom(e);
    const hit = new THREE.Vector3();
    return ray.ray.intersectPlane(groundPlane, hit) ? hit : null;
  }

  function pickObject(e) {
    if (!sim) return null;
    setRayFrom(e);
    const targets = [];
    sim.cars.forEach((c, i) => targets.push({ o: c.wrap, s: { kind: 'car', i } }));
    sim.props.forEach((p, i) => {
      targets.push({ o: p.group, s: { kind: 'prop', i } });
      for (const d of p.dyn) targets.push({ o: d.node, s: { kind: 'prop', i } });
    });
    sim.roads.forEach((r, i) => targets.push({ o: r.group, s: { kind: 'road', i } }));
    const hits = ray.intersectObjects(targets.map((t) => t.o), true);
    for (const h of hits) {
      let o = h.object;
      while (o) {
        const t = targets.find((t2) => t2.o === o);
        if (t) return t.s;
        o = o.parent;
      }
    }
    return null;
  }

  function pickGizmo(e) {
    if (!gz.visible) return null;
    setRayFrom(e);
    const hits = ray.intersectObject(gz, true);
    for (const h of hits) {
      let o = h.object;
      while (o && o !== gz) {
        if (o.userData.gz) return o.userData.gz;
        o = o.parent;
      }
    }
    return null;
  }

  function applyPose(s) {
    const spec = specOf(s);
    if (!sim || !spec) return;
    if (s.kind === 'car') sim.setCarPose(s.i, spec.x, spec.z, spec.heading);
    else schedulePropPose();
  }

  function onDown(e) {
    if (!e.isPrimary) return;
    if (sim && sim.playing) return; // orbit only while running
    if (drawingRoad) { // road tool: every ground tap lays a control point
      const pt = groundHit(e);
      if (pt) {
        if (drawingRoad.pts.length >= ROAD_MAX_PTS) ctx.toast(`Max ${ROAD_MAX_PTS} points`);
        else {
          drawingRoad.pts.push({ x: clamp(r2(pt.x), -120, 120), z: clamp(r2(pt.z), -120, 120) });
          refreshRoadPreview();
        }
      }
      e.stopPropagation();
      return;
    }
    if (placing) {
      const pt = groundHit(e);
      if (pt) placeAt(pt);
      e.stopPropagation();
      return;
    }
    // control-point handles of the selected road win over everything else
    if (rh.visible && sel && sel.kind === 'road') {
      setRayFrom(e);
      const hHits = ray.intersectObjects(rh.children, false);
      if (hHits.length) {
        drag = { mode: 'handle', s: sel, pi: hHits[0].object.userData.pi, moved: false };
        ctx.controls.enabled = false;
        e.stopPropagation();
        return;
      }
    }
    const gzHit = pickGizmo(e);
    if (gzHit && sel) {
      const spec = specOf(sel);
      const pt = groundHit(e);
      if (spec && pt) {
        if (gzHit === 'ring') drag = { mode: 'ring', s: sel };
        else drag = {
          mode: 'axis', s: sel,
          axis: gzHit === 'x'
            ? { x: Math.cos(spec.heading || 0), z: -Math.sin(spec.heading || 0) }
            : { x: Math.sin(spec.heading || 0), z: Math.cos(spec.heading || 0) },
          startX: spec.x, startZ: spec.z, ptX: pt.x, ptZ: pt.z,
        };
        ctx.controls.enabled = false;
        e.stopPropagation();
        return;
      }
    }
    const s = pickObject(e);
    if (s && s.kind === 'road') { // free-drag moves the whole road (all points)
      const pt = groundHit(e);
      select(s);
      if (e.shiftKey) {
        const dup = duplicateSel();
        if (dup && pt) { drag = { mode: 'road-move', s: dup, lx: pt.x, lz: pt.z, moved: true }; ctx.controls.enabled = false; e.stopPropagation(); return; }
      }
      if (pt) { drag = { mode: 'road-move', s, lx: pt.x, lz: pt.z, moved: false }; ctx.controls.enabled = false; }
      e.stopPropagation();
      return;
    }
    if (s) {
      if (e.shiftKey) { // Shift+drag = duplicate, then drag the copy
        select(s);
        const dup = duplicateSel();
        if (dup) {
          const spec = specOf(dup);
          const src = e.shiftKey ? specOf(dup) : null;
          // put the copy back on the original spot so the drag starts in place
          const orig = s.kind === 'car' ? scenario.cars[s.i] : scenario.props[s.i];
          spec.x = orig.x; spec.z = orig.z;
          applyPose(dup);
          const pt = groundHit(e);
          drag = { mode: 'free', s: dup, offX: pt ? spec.x - pt.x : 0, offZ: pt ? spec.z - pt.z : 0, moved: true };
          ctx.controls.enabled = false;
          e.stopPropagation();
          return;
        }
      }
      const pt = groundHit(e);
      const spec = s.kind === 'car' ? scenario.cars[s.i] : scenario.props[s.i];
      select(s);
      drag = { mode: 'free', s, offX: pt ? spec.x - pt.x : 0, offZ: pt ? spec.z - pt.z : 0, moved: false };
      ctx.controls.enabled = false;
      e.stopPropagation();
      return;
    }
    // empty space: remember — a clean click (no drag) deselects on pointerup
    downEmpty = { x: e.clientX, y: e.clientY };
  }

  function onMove(e) {
    if (!e.isPrimary) return;
    if (drag && drag.mode === 'handle') { // drag one road control point
      const r = scenario.roads[drag.s.i];
      const pt = groundHit(e);
      if (!r || !pt) return;
      const p = r.pts[drag.pi];
      p.x = clamp(r2(pt.x), -120, 120);
      p.z = clamp(r2(pt.z), -120, 120);
      drag.moved = true;
      dirty = true;
      if (rh.children[drag.pi]) rh.children[drag.pi].position.set(p.x, 0.13, p.z);
      scheduleRoadRebuild();
      ctx.invalidate();
      return;
    }
    if (drag && drag.mode === 'road-move') { // translate every point together
      const r = scenario.roads[drag.s.i];
      const pt = groundHit(e);
      if (!r || !pt) return;
      const dx = pt.x - drag.lx, dz = pt.z - drag.lz;
      drag.lx = pt.x; drag.lz = pt.z;
      for (const p of r.pts) {
        p.x = clamp(r2(p.x + dx), -120, 120);
        p.z = clamp(r2(p.z + dz), -120, 120);
      }
      drag.moved = true;
      dirty = true;
      syncRoadHandles();
      scheduleRoadRebuild();
      return;
    }
    if (drag) {
      const spec = specOf(drag.s);
      const pt = groundHit(e);
      if (!spec || !pt) return;
      const half = scenario.world.arena / 2 + 6;
      if (drag.mode === 'free') {
        spec.x = clamp(pt.x + drag.offX, -half, half);
        spec.z = clamp(pt.z + drag.offZ, -half, half);
        drag.moved = true;
      } else if (drag.mode === 'axis') {
        const d = (pt.x - drag.ptX) * drag.axis.x + (pt.z - drag.ptZ) * drag.axis.z;
        spec.x = clamp(drag.startX + drag.axis.x * d, -half, half);
        spec.z = clamp(drag.startZ + drag.axis.z * d, -half, half);
        drag.moved = true;
      } else { // ring
        spec.heading = Math.atan2(-(pt.z - spec.z), pt.x - spec.x);
        drag.moved = true;
      }
      dirty = true;
      if (drag.s.kind === 'car' && sim && sim.cars[drag.s.i]) sim.setCarPose(drag.s.i, spec.x, spec.z, spec.heading);
      else schedulePropPose();
      syncSelectionUI();
      ctx.invalidate();
      return;
    }
    // hover highlight (mouse only — no hover concept on touch)
    if (e.pointerType === 'mouse' && sim && !sim.playing && !placing) {
      const s = pickObject(e);
      if (s && !(sel && s.kind === sel.kind && s.i === sel.i)) {
        const bb = boundsOf(s);
        if (bb) {
          hoverBox.box.copy(bb);
          hoverBox.visible = true;
          ctx.stage.style.cursor = 'pointer';
          ctx.invalidate();
          return;
        }
      }
      if (hoverBox.visible) { hoverBox.visible = false; ctx.invalidate(); }
      if (!placing) ctx.stage.style.cursor = '';
    }
  }

  function onUp(e) {
    if (drag) {
      const wasDrag = drag.moved;
      const s = drag.s;
      drag = null;
      ctx.controls.enabled = true;
      if (wasDrag) {
        if (s.kind === 'prop') { // final exact pose (throttle may have skipped the last event)
          const p = scenario.props[s.i];
          if (sim && p && sim.props[s.i]) sim.setPropPose(s.i, p.x, p.z, p.heading);
        } else if (s.kind === 'road') { // final exact rebuild
          clearTimeout(roadT);
          if (sim && scenario.roads[s.i] && sim.roads[s.i]) sim.replaceRoad(s.i);
        }
        writeURL();
        syncSelectionUI();
      }
      return;
    }
    if (downEmpty && e && Math.hypot(e.clientX - downEmpty.x, e.clientY - downEmpty.y) < 6) {
      if (sel) deselect();
    }
    downEmpty = null;
  }

  ctx.stage.addEventListener('pointerdown', onDown, true);
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', onUp);

  /* ================= keyboard ================= */
  function keydown(e) {
    const k = e.key.toLowerCase();
    if (e.key === 'Enter' && drawingRoad) { finishRoadDraw(); return true; }
    if (e.key === ' ') { e.preventDefault(); play(); return true; }
    if (k === 'r') { reset(); return true; }
    if (e.key === '.') { stepTick(); return true; }
    if (e.key === 'Escape') {
      if (drawingRoad) { finishRoadDraw(true); return true; }
      if (placing) { cancelPlace(); return true; }
      if (sel) { deselect(); return true; }
      return true;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { deleteSel(); return true; }
    if (k === 'f') { focusSel(); return true; }
    if (k === 'd' && sel) { duplicateSel(); return true; }
    if (k === 'g') { // garage reflex: reroll the selected car's seed
      if (sel && sel.kind === 'car') $('e_dice').click();
      else if (!scenario.cars.length) beginPlace('car');
      return true;
    }
    if (k === 't' && sel && sel.kind === 'car') { // cycle type, keep seed
      const c = scenario.cars[sel.i];
      const dir = e.shiftKey ? REG.length - 1 : 1;
      const cur = REG.findIndex((x) => x.id === c.type);
      c.type = REG[(cur + dir + REG.length) % REG.length].id;
      scheduleObjectRebuild();
      return true;
    }
    return false;
  }

  /* ================= per-frame ================= */
  const followTgt = new THREE.Vector3();
  function update(dt) {
    if (!sim) return false;
    if (sim.playing) {
      sim.update(dt);
      sim.syncVisuals();
      if (sim.cars.length) { // gentle follow: keep the action centered
        followTgt.set(0, 0.8, 0);
        for (const c of sim.cars) { followTgt.x += c.wrap.position.x / sim.cars.length; followTgt.z += c.wrap.position.z / sim.cars.length; }
        const k = Math.min(1, dt * 1.6);
        const dx = (followTgt.x - ctx.controls.target.x) * k;
        const dz = (followTgt.z - ctx.controls.target.z) * k;
        ctx.controls.target.x += dx; ctx.controls.target.z += dz;
        ctx.camera.position.x += dx; ctx.camera.position.z += dz;
      }
      ctx.invalidate();
      return true;
    }
    return false;
  }

  /* ================= boot ================= */
  async function boot(q) {
    loadFromURL(q);
    syncSceneUI();
    refreshChips();
    if (scenario.cars.length || scenario.props.length) {
      await ensureRapier();
      rebuildSim(true);
      if (scenario.cars.length === 1 && !scenario.props.length) {
        select({ kind: 'car', i: 0 });
        focusSel();
      }
    } else {
      refreshStats();
      refreshEmpty();
      syncSelectionUI();
    }
  }

  return {
    scenario,
    get sim() { return sim; },
    get selection() { return sel; },
    boot, keydown, update, play, reset, writeURL, select, beginPlace,
    spawnCarAt: (seed, type, paint, x, z) => ensureRapier().then(() => placeAtSpec(seed, type, paint, x, z)),
    generateWorld: runWorldGen, // (preset, seed) — also the debug/verification path
    addRoad: (spec) => ensureRapier().then(() => { // debug/verification helper
      if (!spec || !Array.isArray(spec.pts) || spec.pts.length < 2) return;
      scenario.roads.push({ ...ROAD_DEFAULTS, ...spec });
      sim.appendRoad();
      dirty = true;
      writeURL();
      refreshChips();
      refreshStats();
    }),
    spawnPropAt: (kind, x, z, seed) => ensureRapier().then(() => {
      placing = { kind: 'prop', prop: kind };
      placeAt(new THREE.Vector3(x || 0, 0, z || 0));
      const i = scenario.props.length - 1;
      if (seed != null && sim && isScenery(kind) && scenario.props[i]) {
        scenario.props[i].seed = String(seed);
        sim.replaceProp(i);
        writeURL();
      }
    }),
    fitScenario,
  };

  // debug/verification helper (window.__app)
  function placeAtSpec(seed, type, paint, x, z) {
    placing = { kind: 'car' };
    const prevSeed = $('s_seed').value, prevType = spawnPick.type, prevPaint = spawnPick.paint;
    $('s_seed').value = seed;
    spawnPick.type = type || 'any';
    spawnPick.paint = paint || null;
    placeAt(new THREE.Vector3(x || 0, 0, z || 0));
    $('s_seed').value = prevSeed;
    spawnPick.type = prevType;
    spawnPick.paint = prevPaint;
  }
}
