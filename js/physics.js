// physics.js — deterministic crash sim (Rapier 3D, fixed 60 Hz timestep)
//
// Determinism contract (the product depends on it):
//  - same scenario ⇒ identical sim, frame for frame, on any refresh rate
//  - zero Math.random(); any noise comes from makeRng('p:'+seed) streams
//  - bodies/colliders/wheels are created in stable array order, never object-key order
//  - rendering interpolates between physics states and never feeds back into the sim
import * as THREE from 'three';
import { buildVehicle } from './vehicles.js';
import { makeRng, clamp, disposeGroup } from './lib.js';
import { makeDeformState, applyImpact, flushDeform } from './deform.js';
import { buildProp } from './props.js';
import { buildRoad, buildJunction } from './roads.js';
// terrain.js is pure (integer-hash noise, zero rng, no THREE state beyond
// geometry it does not build here), so the sim may sample the SAME height
// field the visual mesh uses and cannot drift from it.
import { makeHeightField } from './terrain.js';
import { signalAt, GREEN, AMBER } from './signals.js';
import { generateWorld } from './worldgen.js';
import { generateScene } from './director.js';

export const STEP = 1 / 60;

// one-entry heightfield memo — see the drivable-terrain block in build()
let _hfCache = { key: null, heights: null };

/* ---------------- Rapier loader (lazy — 2.2 MB module, only crash mode needs it) ---------------- */
let RAPIER = null;
export async function loadRapier() {
  if (RAPIER) return RAPIER;
  const mod = await import('../libs/rapier3d-compat.module.js');
  RAPIER = mod.default;
  await RAPIER.init(); // the "deprecated parameters" console warning is upstream noise — harmless
  return RAPIER;
}

/* ---------------- per-category tuning ----------------
   mass scales with footprint relative to `ref` (m²) so a city bus outweighs a
   minibus without hand-tuning 92 archetypes. accel/vmax/grip are arcade values. */
/* per-category feel: sus = {k stiffness, c compression, r relaxation, tk travel×};
   crumpleK scales deform softness (trucks/construction are stiff steel);
   aDamp = angular damping (tall vehicles wallow instead of snap-rolling);
   wheelTough scales wheel damage resistance (a dozer doesn't shed wheels). */
const CAT_PHYS = {
  'Cars':                { mass: 1250, ref: 8.6,  accel: 6.5, vmax: 38, grip: 3.0, rest: 0.2,  comYk: 1.0, ballast: 0.55, sus: { k: 32, c: 2.4, r: 3.2, tk: 1 },    crumpleK: 1.0,  aDamp: 0.35, wheelTough: 1 },
  'Racing & Fun':        { mass: 750,  ref: 6.8,  accel: 10,  vmax: 55, grip: 4.2, rest: 0.13, comYk: 0.8, ballast: 0.6,  sus: { k: 46, c: 3.2, r: 4.0, tk: 0.9 },  crumpleK: 1.15, aDamp: 0.3,  wheelTough: 0.8 },
  'Off-Road':            { mass: 2100, ref: 9.6,  accel: 6,   vmax: 30, grip: 2.6, rest: 0.34, comYk: 1.7, ballast: 0.5,  sus: { k: 20, c: 1.8, r: 2.6, tk: 1.35 }, crumpleK: 0.85, aDamp: 0.42, wheelTough: 1.5 },
  'Vans & Buses':        { mass: 4600, ref: 17,   accel: 3.6, vmax: 25, grip: 2.4, rest: 0.24, comYk: 2.3, ballast: 0.45, sus: { k: 30, c: 2.6, r: 3.4, tk: 1 },    crumpleK: 0.9,  aDamp: 0.5,  wheelTough: 1.6 },
  'Trucks':              { mass: 7000, ref: 21.6, accel: 3.2, vmax: 24, grip: 2.4, rest: 0.28, comYk: 1.8, ballast: 0.5,  sus: { k: 34, c: 2.8, r: 3.6, tk: 1 },    crumpleK: 0.75, aDamp: 0.5,  wheelTough: 2 },
  'Service & Emergency': { mass: 1800, ref: 10,   accel: 6.5, vmax: 36, grip: 2.9, rest: 0.22, comYk: 1.2, ballast: 0.52, sus: { k: 32, c: 2.4, r: 3.2, tk: 1 },    crumpleK: 1.0,  aDamp: 0.38, wheelTough: 1.1 },
  'Construction':        { mass: 9000, ref: 15.6, accel: 2.2, vmax: 9,  grip: 3.5, rest: 0.16, comYk: 1.0, ballast: 0.6,  sus: { k: 40, c: 3.0, r: 3.8, tk: 1 },    crumpleK: 0.55, aDamp: 0.55, wheelTough: 4 },
  'Rail':                { mass: 12000, ref: 26,  accel: 2.8, vmax: 16, grip: 3.5, rest: 0.12, comYk: 1.2, ballast: 0.55, sus: { k: 44, c: 3.2, r: 4.0, tk: 1 },    crumpleK: 0.6,  aDamp: 0.55, wheelTough: 4 },
  'Special':             { mass: 750,  ref: 5.6,  accel: 4.5, vmax: 18, grip: 2.6, rest: 0.2,  comYk: 1.1, ballast: 0.55, sus: { k: 26, c: 2.2, r: 3.0, tk: 1.1 },  crumpleK: 1.1,  aDamp: 0.4,  wheelTough: 1.2 },
};

/* wheel damage model (all thresholds in Δv terms, deterministic):
   nearby impacts charge a wheel; past BENT it steers crooked with cut grip,
   past DETACH (or one massive direct hit) it tears off into a real free body. */
const WHEEL_BENT_AT = 3.2;
const WHEEL_DETACH_AT = 7.5;
const CAT_BY_ID = new Map(); // filled lazily from REG entries passed in specs

const MAX_STEER = 0.61; // ~35°

/* ---------------- collider recipes from the built model ----------------
   slab() meshes carry userData.pt (exact frustum params) → tight convex hulls.
   Big boxes/cylinders (beds, tanks, logs) become primitive colliders. Small
   details (mirrors, lights) fall under the volume floor and are skipped. */
const MIN_PART_VOL = 0.03;
const MAX_PARTS = 14;

function slabCorners(pt) {
  const zb = pt.zb / 2, zt = pt.zt / 2;
  return [
    [pt.x0b, pt.y0, -zb], [pt.x1b, pt.y0, -zb], [pt.x1b, pt.y0, zb], [pt.x0b, pt.y0, zb],
    [pt.x0t, pt.y1, -zt], [pt.x1t, pt.y1, -zt], [pt.x1t, pt.y1, zt], [pt.x0t, pt.y1, zt],
  ];
}

function collectShapes(wrap) {
  wrap.updateMatrixWorld(true);
  const shapes = [];
  const v = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  let idx = 0;
  wrap.traverse((o) => {
    if (o.userData.wheel) { o.userData._skipKids = true; }
    // skip anything inside a wheel group
    let p = o;
    while (p && p !== wrap) { if (p.userData.wheel) return; p = p.parent; }
    if (!o.isMesh || !o.geometry) return;
    idx++;
    const pt = o.userData.pt;
    if (pt) {
      const vol = ((pt.x1b - pt.x0b) * pt.zb + (pt.x1t - pt.x0t) * pt.zt) / 2 * (pt.y1 - pt.y0);
      if (vol < MIN_PART_VOL) return;
      const pts = new Float32Array(24);
      slabCorners(pt).forEach((c, i) => {
        v.set(c[0], c[1], c[2]).applyMatrix4(o.matrixWorld);
        pts[i * 3] = v.x; pts[i * 3 + 1] = v.y; pts[i * 3 + 2] = v.z;
      });
      shapes.push({ kind: 'hull', pts, vol, idx });
      return;
    }
    const gp = o.geometry.parameters;
    if (o.geometry.type === 'BoxGeometry') {
      const vol = gp.width * gp.height * gp.depth;
      if (vol < MIN_PART_VOL) return;
      o.matrixWorld.decompose(v, q, s);
      shapes.push({
        kind: 'box', he: [gp.width * s.x / 2, gp.height * s.y / 2, gp.depth * s.z / 2],
        pos: [v.x, v.y, v.z], rot: [q.x, q.y, q.z, q.w], vol, idx,
      });
    } else if (o.geometry.type === 'CylinderGeometry') {
      const r = (gp.radiusTop + gp.radiusBottom) / 2;
      const vol = Math.PI * r * r * gp.height;
      if (vol < MIN_PART_VOL * 2) return;
      o.matrixWorld.decompose(v, q, s);
      shapes.push({
        kind: 'cyl', hh: gp.height * s.y / 2, r: r * Math.max(s.x, s.z),
        pos: [v.x, v.y, v.z], rot: [q.x, q.y, q.z, q.w], vol, idx,
      });
    }
  });
  shapes.sort((a, b) => b.vol - a.vol || a.idx - b.idx);
  return shapes.slice(0, MAX_PARTS);
}

/* ---------------- wheel discovery ----------------
   wheel() groups carry userData.wheel = {r, w}. Ground wheels = bottom near y 0.
   Dual pairs collapse onto one physics wheel (outermost); all visual wheels
   still animate, mapped to their physics wheel. */
function findWheels(wrap) {
  wrap.updateMatrixWorld(true);
  const all = [];
  wrap.traverse((o) => {
    if (!o.userData.wheel) return;
    const p = new THREE.Vector3();
    o.getWorldPosition(p);
    all.push({ obj: o, r: o.userData.wheel.r, w: o.userData.wheel.w, x: p.x, y: p.y, z: p.z });
  });
  const ground = all.filter((w) => Math.abs(w.y - w.r) < w.r * 0.55 + 0.06 && w.r >= 0.13);
  // cluster by (x, side): duals / stacked pairs merge, outermost wins
  const phys = [];
  for (const w of ground) {
    const side = w.z > 0.01 ? 1 : w.z < -0.01 ? -1 : 0;
    const hit = phys.find((c) => Math.abs(c.x - w.x) < 0.32 && c.side === side);
    if (hit) {
      hit.members.push(w);
      if (Math.abs(w.z) > Math.abs(hit.z)) { hit.z = w.z; hit.r = w.r; hit.y = w.y; }
    } else {
      phys.push({ x: w.x, y: w.y, z: w.z, r: w.r, side, members: [w] });
    }
  }
  phys.sort((a, b) => b.x - a.x || a.z - b.z); // stable: front→rear, right→left
  return { phys, visual: ground, allTagged: all };
}

/* ---------------- one car rig ---------------- */
function buildRig(R, world, spec, entryCat) {
  const built = buildVehicle(spec.seed, spec.type, spec.paint || null);
  const wrap = built.group;
  const cat = CAT_PHYS[entryCat] || CAT_PHYS.Cars;

  // non-wheel bbox for mass scaling + fallback collider
  wrap.updateMatrixWorld(true);
  const bb = new THREE.Box3();
  const tmp = new THREE.Box3();
  wrap.traverse((o) => {
    let p = o;
    while (p && p !== wrap) { if (p.userData.wheel) return; p = p.parent; }
    if (o.isMesh && o.geometry) {
      o.geometry.computeBoundingBox();
      tmp.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
      bb.union(tmp);
    }
  });
  const size = bb.getSize(new THREE.Vector3());
  const footprint = Math.max(0.8, size.x * size.z);
  // per-car tuning multipliers — defaults are exactly 1.0 so legacy scenarios
  // (and their reference hashes) are bit-identical
  const massK = clamp(spec.mass || 1, 0.25, 4);
  const gripK = clamp(spec.grip || 1, 0.2, 4);
  const restit = spec.rest == null ? 0.12 : clamp(spec.rest, 0, 1);
  const mass = cat.mass * clamp(footprint / cat.ref, 0.4, 2.8) * massK;

  const { phys: wheels, visual: visualWheels } = findWheels(wrap);
  const avgR = wheels.length ? wheels.reduce((a, w) => a + w.r, 0) / wheels.length : clamp(size.y * 0.22, 0.18, 0.5);

  // no discoverable wheels (tracks, rollers, trams) → virtual wheels at bbox corners
  let virtual = false;
  if (wheels.length < 3) {
    if (wheels.length === 2 && Math.abs(wheels[0].z) < 0.25 && Math.abs(wheels[1].z) < 0.25) {
      // inline bike: keep real wheels, add invisible outriggers for roll stability
      for (const w of [...wheels]) {
        for (const sgn of [-1, 1]) {
          wheels.push({ x: w.x, y: w.y, z: sgn * 0.42, r: w.r * 0.92, side: sgn, members: [] });
        }
      }
    } else {
      wheels.length = 0;
      virtual = true;
      const r = clamp(size.y * 0.2, 0.16, 0.45);
      const ix = clamp(size.x * 0.34, 0.4, 3.4), iz = clamp(size.z * 0.36, 0.3, 1.2);
      for (const wx of [ix, -ix]) for (const wz of [-iz, iz]) {
        wheels.push({ x: wx, y: r, z: wz, r, side: Math.sign(wz), members: [] });
      }
    }
  }

  // spawn pose — cars with a start delay or rolling start hold still at first
  const yaw = spec.heading || 0;
  const delayTicks = Math.round((spec.delay || 0) * 60);
  const rolling = !!spec.rolling;
  const v0 = (delayTicks > 0 || rolling) ? 0 : (spec.speed || 0);
  const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(qYaw);
  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    // Spawn height rides the ROAD SURFACE, not the world floor. `spec.y` is
    // the deck height the director placed this car at; it is opt-in and
    // absent on every flat scenario, where `(undefined || 0) + 0.035` is
    // bit-identically the old hardcoded 0.035 — which is what keeps the
    // pinned hashes frozen. Without it a car placed on a bridge span
    // materialised on the ground underneath and drove off under the deck.
    .setTranslation(spec.x || 0, (spec.y || 0) + 0.035, spec.z || 0)
    .setRotation({ x: qYaw.x, y: qYaw.y, z: qYaw.z, w: qYaw.w })
    .setLinvel(fwd.x * v0, 0, fwd.z * v0)
    .setAngularDamping(cat.aDamp)
    .setLinearDamping(0.04)
    .setCcdEnabled(true);
  const body = world.createRigidBody(bodyDesc);

  // part colliders (density 1 first, then rescaled to target mass)
  let shapes = collectShapes(wrap);
  const spanX = shapes.length
    ? Math.max(...shapes.map((s) => s.kind === 'hull' ? s.pts[3] : s.pos[0])) - Math.min(...shapes.map((s) => s.kind === 'hull' ? s.pts[0] : s.pos[0]))
    : 0;
  if (!shapes.length || spanX < size.x * 0.45) {
    const y0 = Math.min(bb.min.y + size.y * 0.25, avgR * 0.9);
    shapes = [{
      kind: 'box', he: [size.x * 0.46, (size.y - y0) * 0.46, size.z * 0.42],
      pos: [(bb.min.x + bb.max.x) / 2, (y0 + size.y) / 2, (bb.min.z + bb.max.z) / 2],
      rot: [0, 0, 0, 1], vol: 1, idx: 0,
    }];
  }
  const colliders = [];
  for (const s of shapes) {
    let cd = null;
    if (s.kind === 'hull') cd = RAPIER.ColliderDesc.convexHull(s.pts);
    else if (s.kind === 'box') cd = RAPIER.ColliderDesc.cuboid(s.he[0], s.he[1], s.he[2]).setTranslation(s.pos[0], s.pos[1], s.pos[2]).setRotation({ x: s.rot[0], y: s.rot[1], z: s.rot[2], w: s.rot[3] });
    else if (s.kind === 'cyl') cd = RAPIER.ColliderDesc.cylinder(s.hh, s.r).setTranslation(s.pos[0], s.pos[1], s.pos[2]).setRotation({ x: s.rot[0], y: s.rot[1], z: s.rot[2], w: s.rot[3] });
    if (!cd) continue;
    cd.setFriction(0.5).setRestitution(restit).setDensity(1);
    const col = world.createCollider(cd, body);
    if (col) colliders.push(col);
  }
  // rescale part densities to (1-ballast)·mass, then add a no-contact ballast
  // block low between the axles — lowers COM so arcade handling stays stable
  const m0 = body.mass();
  const partMass = mass * (1 - cat.ballast);
  if (m0 > 1e-6) for (const c of colliders) c.setDensity(partMass / m0);
  const wxMin = Math.min(...wheels.map((w) => w.x)), wxMax = Math.max(...wheels.map((w) => w.x));
  const bx = (wxMin + wxMax) / 2, bhe = [Math.max(0.3, (wxMax - wxMin) * 0.3), 0.1, 0.25];
  const bally = clamp(avgR * 0.55 * cat.comYk, 0.1, 1.4);
  const ballast = world.createCollider(
    RAPIER.ColliderDesc.cuboid(bhe[0], bhe[1], bhe[2])
      .setTranslation(bx, bally, 0)
      .setCollisionGroups(0) // mass only, collides with nothing
      .setDensity((mass * cat.ballast) / (8 * bhe[0] * bhe[1] * bhe[2])),
    body,
  );
  colliders.push(ballast);

  // raycast vehicle controller — one wheel per physics cluster
  const veh = world.createVehicleController(body);
  const rest = cat.rest;
  const steerXCut = wxMax - Math.max(0.25, (wxMax - wxMin) * 0.28);
  const wheelMeta = [];
  for (let i = 0; i < wheels.length; i++) {
    const w = wheels[i];
    // connection sits above the built wheel center; ~35 % static sag returns it there
    veh.addWheel({ x: w.x, y: w.y + rest * 0.65, z: w.z }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, rest, w.r);
    veh.setWheelSuspensionStiffness(i, cat.sus.k);
    veh.setWheelSuspensionCompression(i, cat.sus.c);
    veh.setWheelSuspensionRelaxation(i, cat.sus.r);
    veh.setWheelMaxSuspensionTravel(i, rest * 1.05 * cat.sus.tk);
    veh.setWheelMaxSuspensionForce(i, mass * 9.81 * 0.9);
    veh.setWheelFrictionSlip(i, cat.grip * gripK);
    veh.setWheelSideFrictionStiffness(i, 1);
    wheelMeta.push({
      steer: w.x >= steerXCut, conn: { x: w.x, y: w.y + rest * 0.65, z: w.z }, r: w.r,
      // damage model state — pos is the built wheel center (wrap-local)
      pos: { x: w.x, y: w.y, z: w.z }, w: (w.members[0] && w.members[0].w) || w.r * 0.55,
      side: w.side, hasVisual: w.members.length > 0,
      dmg: 0, bent: 0, detached: false,
    });
  }
  const nDrive = wheels.length || 1;
  const engineF = (mass * cat.accel) / nDrive;

  // visual wheels re-parent to the wrap root so the controller can drive them
  const vis = [];
  for (const vw of visualWheels) {
    // map to nearest physics wheel (same x cluster, same side)
    let best = 0, bestD = 1e9;
    for (let i = 0; i < wheels.length; i++) {
      const d = Math.abs(wheels[i].x - vw.x) + (Math.sign(wheels[i].z) === Math.sign(vw.z) ? 0 : 10);
      if (d < bestD) { bestD = d; best = i; }
    }
    wrap.attach(vw.obj);
    vis.push({ obj: vw.obj, phys: best, z: vw.z, restY: vw.y });
  }

  // dominant paint color for fx debris chips (first sizable non-glass slab)
  let paintHex = '#9aa0a7';
  wrap.traverse((o) => {
    if (paintHex !== '#9aa0a7') return;
    if (o.isMesh && o.userData.pt && o.material && !o.material.userData.glass && o.material.color) {
      paintHex = '#' + o.material.color.getHexString();
    }
  });

  return {
    spec, built, wrap, body, colliders, veh, wheelMeta, vis, mass, cat, engineF, virtual,
    size, paintHex, damage: 0, frontDmg: 0,
    delayTicks, rolling, brakeTick: (spec.brake || 0) > 0 ? Math.round(spec.brake * 60) : Infinity,
    launchV: spec.speed || 0, launchFwd: { x: fwd.x, z: fwd.z },
    deform: makeDeformState(wrap, size, clamp(spec.crumple || 1, 0.2, 3) * cat.crumpleK),
    // prev MUST start equal to cur: at spawn there is no previous state, and
    // syncVisuals lerps prev→cur by alpha. Seeding prev at the origin meant any
    // alpha-0 sync at tick 0 (i.e. accum 0, i.e. a sim sitting still) teleported
    // every car's MESH to 0,0 while its body stayed put. Nothing hit it until
    // the G5 freeze scrub made tick 0 a state you can park on and look at.
    // Visual only — hashState reads body transforms, so no pin can move.
    prev: { p: new THREE.Vector3(spec.x || 0, 0.035, spec.z || 0), q: qYaw.clone() },
    cur: { p: new THREE.Vector3(spec.x || 0, 0.035, spec.z || 0), q: qYaw.clone() },
    susPrev: new Float32Array(wheels.length), susCur: new Float32Array(wheels.length),
    rotPrev: new Float32Array(wheels.length), rotCur: new Float32Array(wheels.length),
    steerCur: 0, steerPrev: 0,
  };
}

/* ---------------- input streams ----------------
   v1 launch model: constant steer/throttle recorded as a tick-indexed stream so
   the same shape can later hold real recorded driving input. */
export function makeStream(spec) {
  const steer = clamp((spec.steer || 0), -MAX_STEER, MAX_STEER);
  const th = clamp(spec.throttle == null ? 1 : spec.throttle, 0, 1);
  return (tick) => ({ steer, throttle: th, brake: 0 });
}

/* ---------------- driver controller (director era) ----------------
   Closed-loop pure pursuit along a world-space polyline. Everything here is a
   pure function of sim state + the drive spec, and uses ONLY +,-,*,/ and
   Math.sqrt/min/max/abs — no transcendentals, so it is bit-deterministic across
   JS engines, not just across runs (Math.sin/atan2 precision is engine-defined).

   spec.drive = {
     pts:  [x0,z0, x1,z1, ...]   flat world-coordinate polyline (the lane path)
     v:    cruise target speed (m/s) — initial; also set spec.speed = v so the
           existing launch path spawns the car already rolling
     end:  'stop' | 'coast'      behaviour at path end (default 'stop')
     cmds: [{t, v?, bias?, off?, noBrake?, brakeMax?}, ...] sorted by t —
           sparse timeline overrides: target speed, steering bias (rad, added
           to pursuit steer), driver off (no pedals, bias-only steer),
           brake failure, emergency brake strength (default 1, slam ≈ 2.5)
   } */
function makeDriver(drive) {
  const n = drive.pts.length >> 1;
  const cum = new Float64Array(n); // cumulative arc length at each point
  for (let i = 1; i < n; i++) {
    const dx = drive.pts[i * 2] - drive.pts[i * 2 - 2];
    const dz = drive.pts[i * 2 + 1] - drive.pts[i * 2 - 1];
    cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dz * dz);
  }
  return {
    pts: drive.pts, n, cum, total: cum[n - 1],
    end: drive.end || 'stop',
    cmds: drive.cmds || [],
    acc: drive.acc || 0, // ambient car-following; >1 = full-attention tick bound (see driveTick)
    /* Signal stop lines, COPIED rather than referenced. `drive.stops` lives on
       the scenario, and the scenario is shared between the headless recorder
       sim and the live one — latching "I am through this junction" onto the
       spec would let the pre-sim hand its progress to the round the player
       watches, which is the one thing that must never happen. */
    stops: (drive.stops || []).map((s) => ({
      s: s.s, j: s.j, arm: s.arm, until: s.until == null ? Infinity : s.until, done: false,
    })),
    seg: 0, ci: 0,
    vt: drive.v || 0, bias: 0, off: false, noBrake: false, brakeMax: 1,
    done: false,
  };
}

function driveTick(sim, car, tick) {
  const d = car.driver;
  while (d.ci < d.cmds.length && d.cmds[d.ci].t <= tick) {
    const c = d.cmds[d.ci++];
    if (c.v !== undefined) d.vt = c.v;
    if (c.bias !== undefined) d.bias = c.bias;
    if (c.off !== undefined) d.off = c.off;
    if (c.noBrake !== undefined) d.noBrake = c.noBrake;
    if (c.brakeMax !== undefined) d.brakeMax = c.brakeMax;
  }
  const v = car.veh.currentVehicleSpeed();
  // shock: after a real hit the driver stops driving and just gets on the
  // brake — wrecks settle instead of grinding against the pile forever
  if (car.damage > 6) return { steer: 0, throttle: 0, brake: 0.9 };
  // control lost (blowout etc.): locked steer, dragging to a stop — a car
  // that never hits anything must still come to rest
  if (d.off) return { steer: clamp(d.bias, -MAX_STEER, MAX_STEER), throttle: 0, brake: 0.1 };
  const t = car.body.translation(), q = car.body.rotation();
  // forward vector = quat * (1,0,0), arithmetic only
  const hx = 1 - 2 * (q.y * q.y + q.z * q.z);
  const hz = 2 * (q.x * q.z - q.w * q.y);
  const P = d.pts;
  // advance progress: hop segments whose end we have passed (projection > len)
  let segFrac = 0;
  while (true) {
    const ax = P[d.seg * 2], az = P[d.seg * 2 + 1];
    const bx = P[d.seg * 2 + 2], bz = P[d.seg * 2 + 3];
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    const proj = len2 > 1e-9 ? ((t.x - ax) * dx + (t.z - az) * dz) / len2 : 1;
    if (proj < 1 || d.seg >= d.n - 2) { segFrac = Math.max(0, Math.min(1, proj)); break; }
    d.seg++;
  }
  // remaining path length from our projected position to the terminus
  const segLen = d.cum[d.seg + 1] - d.cum[d.seg];
  const arcNow = d.cum[d.seg] + segFrac * segLen;
  const remainPath = Math.max(0, d.total - arcNow);
  // goal point: walk the lookahead distance along the polyline from our projection
  const L = clamp(0.55 * Math.abs(v) + 2.5, 3.5, 13);
  let gx = P[d.n * 2 - 2], gz = P[d.n * 2 - 1];
  let remain = L;
  let sx = t.x, sz = t.z; // walk start: our position projected forward is close enough
  let reachedEnd = true;
  for (let s = d.seg; s < d.n - 1; s++) {
    const bx = P[s * 2 + 2], bz = P[s * 2 + 3];
    const ex = bx - sx, ez = bz - sz;
    const el = Math.sqrt(ex * ex + ez * ez);
    if (el >= remain && el > 1e-9) {
      const k = remain / el;
      gx = sx + ex * k; gz = sz + ez * k;
      reachedEnd = false;
      break;
    }
    remain -= el;
    sx = bx; sz = bz;
  }
  // end-of-path handling: anticipatory braking into the terminus (v² = 2·a·s),
  // then hold once we are basically there
  if (remainPath < 2.4) d.done = true;
  let vt = d.vt;
  if (d.end === 'stop') {
    const vLim = Math.sqrt(2 * 3.6 * Math.max(0, remainPath - 1.2));
    if (vLim < vt) vt = vLim;
    if (d.done) vt = 0;
  } else if (d.done) {
    // coast out: off the pedals and rolling to a stop past the path end.
    // Firm enough that the scene actually settles — a feather brake leaves
    // cars trickling for thousands of ticks and the pre-sim never rests.
    return { steer: clamp(d.bias, -MAX_STEER, MAX_STEER), throttle: 0, brake: 0.4 };
  }
  // pure pursuit: lateral offset of the goal in car frame → curvature → steer.
  // cross(h, g) sign matches wheel-steer sign (verified against MAX_STEER turn
  // direction in the sim, not assumed).
  const ox = gx - t.x, oz = gz - t.z;
  const gl = Math.sqrt(ox * ox + oz * oz);
  let steer = d.bias;
  if (gl > 0.6 && !d.done) {
    const lat = hz * ox - hx * oz; // sign verified empirically (drivetest.mjs)
    const kappa = (2 * lat) / (gl * L);
    steer = clamp(kappa * (car.size.x * 0.55) + d.bias, -MAX_STEER, MAX_STEER);
  }
  // ambient car-following (spec.drive.acc): never plow into a slower car
  // ahead during the preview — heavy casts can't hold their plan speed
  // through bends, and over 10 s a 2 m/s deficit becomes a pre-incident
  // rear-end. Detection probes MY OWN PATH (goal point, a far point, and
  // their midpoint), not a straight-ahead cone: on a bend the car ahead sits
  // metres off the heading axis, and opposing traffic 6.5 m off the path
  // never triggers. After the incident tick attentiveness drops to panic
  // range only, so cars still pile into fresh wrecks like real late brakers.
  // Essential template cars never carry .acc — choreography is untouched.
  // Arithmetic-only reads of sim state in fixed car order: deterministic.
  if (d.acc && sim) {
    const lookout = Math.abs(v) * 1.5 + 8;
    // far probe: walk the polyline `lookout` metres from our projection
    let fpx = P[d.n * 2 - 2], fpz = P[d.n * 2 - 1];
    let rem2 = lookout, wx = t.x, wz = t.z;
    for (let s = d.seg; s < d.n - 1; s++) {
      const bx = P[s * 2 + 2], bz = P[s * 2 + 3];
      const ex = bx - wx, ez = bz - wz;
      const el = Math.sqrt(ex * ex + ez * ez);
      if (el >= rem2 && el > 1e-9) { const k = rem2 / el; fpx = wx + ex * k; fpz = wz + ez * k; break; }
      rem2 -= el; wx = bx; wz = bz;
    }
    const mpx = (gx + fpx) / 2, mpz = (gz + fpz) / 2;
    const panic2 = (Math.abs(v) * 0.7 + 5) ** 2;
    const tame = d.acc > 1 ? tick < d.acc : true; // acc = tick bound of full attention
    for (const other of sim.cars) {
      if (other === car) continue;
      const to = other.body.translation();
      const dMe2 = (to.x - t.x) ** 2 + (to.z - t.z) ** 2;
      if (dMe2 > (lookout + 3) ** 2) continue;
      // ahead of us at all? (behind-us traffic is its own problem)
      if ((to.x - t.x) * hx + (to.z - t.z) * hz < 1.5) continue;
      const onPath =
        (to.x - gx) ** 2 + (to.z - gz) ** 2 < 13 ||
        (to.x - mpx) ** 2 + (to.z - mpz) ** 2 < 13 ||
        (to.x - fpx) ** 2 + (to.z - fpz) ** 2 < 13;
      if (!onPath) continue;
      // same-direction traffic only: reacting to crossing cars blipping
      // through the probes shifts junction arrival times and breaks the
      // conflict scrub's crossing-window guarantees (found on a d9
      // intersection where the drift caused the pre-600 hit it "prevented")
      const oq = other.body.rotation();
      const ohx = 1 - 2 * (oq.y * oq.y + oq.z * oq.z);
      const ohz = 2 * (oq.x * oq.z - oq.w * oq.y);
      // 0.2 ≈ 78°: crossing traffic (≈90°) stays excluded, while same-lane
      // pairs separated by a tight bend (large heading gap) still register
      if (hx * ohx + hz * ohz < 0.2) continue;
      // the leader's TRUE velocity projected on my heading — a truck crabbing
      // sideways through a bend reads ~9 on its own odometer while making
      // ~4 m/s of actual progress, and capping to the odometer still rear-ends
      const olv = other.body.linvel();
      const vo = olv.x * hx + olv.z * hz;
      const closeIn = dMe2 < panic2;
      if (!tame && !closeIn) continue; // post-incident: only panic range reacts
      const cap = Math.max(0, vo - (closeIn && tame ? 1.5 : closeIn ? 0 : 0.3));
      if (cap < vt) vt = cap;
    }
  }
  /* SIGNAL STOP LINES (P2/2I). Same anticipatory shape as the end-of-path
     brake above — v² = 2·a·s onto the bar — so a car eases up to a red and
     holds instead of stamping on it. Arithmetic only, and the signal is a
     pure function of the tick, so this stays bit-deterministic.

     AMBER is a dilemma zone, not a second red: a car already too close to
     stop comfortably must GO. Braking regardless is how you manufacture the
     rear-end this whole file exists to prevent, and it would land before tick
     600 where nothing is allowed to touch. */
  let holdAtLine = false;
  if (d.stops.length && sim && sim.signals) {
    for (let k = 0; k < d.stops.length; k++) {
      const st = d.stops[k];
      if (st.done) continue;
      if (tick > st.until) { st.done = true; continue; } // see `until` in director.js
      const dist = st.s - arcNow;
      /* Latch on being GENUINELY through (a car length past), never on being
         merely close. Releasing at "almost there" is how the first version
         let a car ease up to the bar and then, the moment it got within
         20 cm, drop the constraint and accelerate straight through the red —
         it came to rest 4 m into the junction. Holding down to −1.2 m instead
         means a nose over the line still gets pinned. */
      if (dist < -1.2) { st.done = true; continue; }
      if (dist > 110) continue;                       // not yet its problem
      const state = signalAt(sim.signals[st.j], st.arm, tick);
      if (state === GREEN) continue;
      const av = Math.abs(v);
      // can we still pull up? (0.55 m of slack for the nose)
      const needed = (av * av) / (2 * 3.2);
      if (state === AMBER && needed > dist - 0.55) continue;
      const vLim = Math.sqrt(2 * 3.2 * Math.max(0, dist - 0.55));
      if (vLim < vt) vt = vLim;
      if (dist < 2.2) holdAtLine = true;
    }
  }
  // speed control
  const dv = vt - v;
  let throttle = clamp(dv * 0.42, 0, 1);
  let brake = 0;
  if (dv < -0.8 && !d.noBrake) brake = clamp(-dv * 0.5, 0, d.brakeMax);
  if (d.done && d.end === 'stop' && Math.abs(v) < 0.4) { throttle = 0; brake = 1; }
  // waiting at a red: hold hard rather than creep. The anticipatory limit
  // alone decays asymptotically, leaving a car idling forward at ~0.6 m/s —
  // which over a 200-tick red walks it into the middle of the junction.
  if (holdAtLine && Math.abs(v) < 1.2) { throttle = 0; brake = 1; }
  return { steer, throttle, brake };
}

/* ---------------- the sim ---------------- */
export class CrashSim {
  constructor(R, scenario, catOf) {
    RAPIER = R;
    this.scenario = scenario;
    this.catOf = catOf; // (typeId) => category label
    this.root = new THREE.Group(); // add to scene
    this.tick = 0;
    this.accum = 0;
    this.speed = 1; // slow-mo factor (0.25/0.5/1)
    this.playing = false;
    this.stopAt = null; // freeze on this exact tick (round incident freeze)
    this.onImpact = null;  // (car, ev {point,dir,dv}) — big hit landed (deform already applied)
    this.onScrape = null;  // (car, ev {point,speed,dyn}) — metal grinding at speed (visual only)
    this.onGlass = null;   // (car, ev {type,point,r}) — pane cracked / shattered
    this.onDetach = null;  // (car, ev {point,r,speed}) — wheel tore off
    this.onSplash = null;  // (car, ev {point,speed}) — broke the water surface
    // v2 only: a non-car body broke the surface. A SEPARATE hook rather than a
    // wider onSplash on purpose — recorder.js resolves that one through
    // sim.cars.indexOf(car), so handing it a prop would index per[-1] and throw
    // inside the pre-sim the whole betting game settles against.
    this.onObjSplash = null; // (obj, ev {point,speed,kind})
    this.onSunk = null;    // (car, ev {point}) — under and stopped
    this.build();
  }

  build() {
    // creation order is the determinism backbone: ground → walls → roads →
    // props (array order) → cars (array order). Anything that appends bodies
    // must keep it. (Legacy scenarios have no roads, so their order — and
    // their reference hashes — are untouched.)
    const W = this.scenario.world || {};
    // G4 water. Opt-in: null for every pre-G4 scenario, which skips the whole
    // _stepWater path and is why no pinned hash moved when this landed.
    // water: { y, x0, x1, z0, z1, bed? } — surface height plus the basin the
    // ground is carved away for. bed defaults to 3.5 m under the surface.
    const wat = W.water;
    this.waterY = wat && typeof wat.y === 'number' ? wat.y : null;
    // Water v2 (1C), opt-in on top of the opt-in: buoyancy and drag reach
    // dynamic props, torn-off wheels and any other debris body instead of only
    // this.cars. Absent — which is every scenario that ships today — the extra
    // loops never run and the water path is byte-for-byte the G4 one, which is
    // why the `water` and `carnage` pins did not move when this landed.
    this.waterV2 = !!(wat && wat.v2);
    this.waterBasin = wat && typeof wat.x0 === 'number'
      ? { x0: wat.x0, x1: wat.x1, z0: wat.z0, z1: wat.z1, bed: wat.bed == null ? wat.y - 3.5 : wat.bed }
      : null;
    this.world = new RAPIER.World({ x: 0, y: -(W.gravity == null ? 9.81 : W.gravity), z: 0 });
    this.world.timestep = STEP;
    this.events = new RAPIER.EventQueue(true);
    // collider handle → what it belongs to, for impact attribution ({kind,
    // rec?}; cars resolve through colToCar). Pure bookkeeping — never touches
    // creation order, so hashes are unaffected.
    this.colToObj = new Map();
    const g = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    // Ground. Without water this is the single 220 m slab it has always been —
    // byte-for-byte the original call, because every pinned hash depends on
    // this body being created exactly once, first, with these numbers. With a
    // water basin the land is instead four slabs AROUND the hole plus a bed
    // collider under it, so a car can actually leave the surface and sink.
    const basin = this.waterBasin;
    if (!basin) {
      this.groundCol = this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(220, 1, 220).setTranslation(0, -1, 0).setFriction(0.9),
        g,
      );
    } else {
      const E = 220;
      // The land slabs double as the basin WALLS: the top face stays exactly
      // at y = 0, but they reach far below the bed. With the original 2 m
      // thickness a submerged car simply slid sideways out from under them
      // and fell forever (first water test bottomed out at y = -37).
      const H = 20;
      const land = (cx, cz, hx, hz) => this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(hx, H, hz).setTranslation(cx, -H, cz).setFriction(0.9), g,
      );
      // west / east of the basin, then north / south of it (fixed order)
      const wHx = (basin.x0 + E) / 2, eHx = (E - basin.x1) / 2;
      land(-E + wHx, 0, wHx, E);
      land(basin.x1 + eHx, 0, eHx, E);
      const nHz = (basin.z0 + E) / 2, sHz = (E - basin.z1) / 2;
      const midHx = (basin.x1 - basin.x0) / 2, midCx = (basin.x0 + basin.x1) / 2;
      land(midCx, -E + nHz, midHx, nHz);
      land(midCx, basin.z1 + sHz, midHx, sHz);
      // the bed: cars settle here once they have sunk
      this.groundCol = this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(midHx, 1, (basin.z1 - basin.z0) / 2)
          .setTranslation(midCx, basin.bed - 1, (basin.z0 + basin.z1) / 2)
          .setFriction(0.9),
        g,
      );
    }
    this.colToObj.set(this.groundCol.handle, { kind: 'ground' });

    /* DRIVABLE TERRAIN (P2/2C) — opt-in on `world.terrain.drivable`, exactly
       like world.water and world.terrain itself. Absent → not one line of
       this runs and the world is the flat slab it has always been, which is
       why every pin survived it.

       Until now the terrain was VISUAL ONLY: the ground is a flat 220 m slab
       whatever the landscape does, so a car past playR drives straight
       through the hillside. Measured over 60 recorded scenes: 4 of them put a
       car inside terrain, worst burial 4.6 m — rare, because it needs a car
       to escape the whole play area first, but wrong every time it happens.
       The real point is that it is the enabling piece for relief topologies.

       The heightfield samples the SAME makeHeightField the mesh is built
       from, so collider and visual cannot drift apart. Inside playR the mask
       is exactly 0, so this is coplanar with the slab there — deliberate: the
       slab stays as the catch-all beyond the grid, and two coincident static
       surfaces at identical height agree rather than fight.

       Layout is row-major `i*(n+1)+j` with i along x and j along z. Measured,
       not assumed: the column-major reading is exactly the TRANSPOSE, which
       renders as perfectly plausible terrain that is wrong at every point. */
    const T = W.terrain;
    if (T && T.drivable) {
      // playR must match what env passes the mesh (it spreads the spec over
      // its own groundR default, so an explicit playR wins in both places)
      const playR = T.playR || Math.max(90, W.ground || 90);
      const field = makeHeightField({ ...T, playR });
      /* Extent is sized off the ARENA, not off rampTo. Sizing it off rampTo
         reaches only 1.43 × playR, and a relief topology deliberately keeps
         playR small so the hills are near the action — so the grid stopped
         well inside the landscape and everything beyond it silently fell
         through to the flat slab. (That is what the first probe caught: every
         sample past the extent read exactly 0.00.)
         Resolution is expressed as a CELL SIZE rather than a fixed grid
         count, so widening the extent does not quietly coarsen the surface
         under the cars. */
      const ext = T.extent || Math.max(field.rampTo * 1.06, (W.arena || 200) / 2 + 24);
      const n = clamp(Math.round((2 * ext) / (T.cell || 2.0)), 32, 400);
      /* Memoised on the spec. Sampling is ~1.6 µs per call (fbm with a domain
         warp), so a 194² grid cost 61 ms — on its own more than the ~30 ms
         "perfect reset" for ten cars, and a reset happens on every scrub
         capture. The array is a pure function of this key, so reusing it is
         bit-identical by construction rather than by luck; a one-entry cache
         is enough because a reset rebuilds the SAME scenario. */
      const key = `${T.seed}|${T.preset}|${playR}|${ext}|${n}`;
      let heights = _hfCache.key === key ? _hfCache.heights : null;
      if (!heights) {
        heights = new Float32Array((n + 1) * (n + 1));
        for (let i = 0; i <= n; i++) {
          const x = -ext + (2 * ext * i) / n;
          for (let j = 0; j <= n; j++) {
            const z = -ext + (2 * ext * j) / n;
            heights[i * (n + 1) + j] = field.heightAt(x, z);
          }
        }
        _hfCache = { key, heights };
      }
      this.terrainCol = this.world.createCollider(
        RAPIER.ColliderDesc.heightfield(n, n, heights, { x: 2 * ext, y: 1, z: 2 * ext })
          .setFriction(0.86).setRestitution(0.02),
        g,
      );
      this.colToObj.set(this.terrainCol.handle, { kind: 'ground' });
    }
    if (W.walls) {
      const half = (W.arena || 80) / 2;
      const wb = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      for (const [x, z, rx, rz] of [[half + 1, 0, 1, half + 2], [-half - 1, 0, 1, half + 2], [0, half + 1, half + 2, 1], [0, -half - 1, half + 2, 1]]) {
        const wc = this.world.createCollider(
          RAPIER.ColliderDesc.cuboid(rx, 6, rz).setTranslation(x, 6, z).setFriction(0.3).setRestitution(0.35),
          wb,
        );
        this.colToObj.set(wc.handle, { kind: 'wall' });
      }
    }
    this.roads = [];
    for (const spec of (this.scenario.roads || [])) this._addRoadRig(spec);
    // Junctions are asphalt lying on the y-0 ground plane and emit NO
    // colliders, so they are built between roads and props purely so they
    // share the scene root (and therefore wetness, merging and disposal).
    // No body is created here, which is why adding them cannot move a pin.
    this.junctions = [];
    // signal programs, indexed alongside junctions. Plain data evaluated by a
    // pure function of the tick — nothing here carries state between steps,
    // so a scrub that jumps backwards gets the same lights the forward run had.
    this.signals = [];
    for (const spec of (this.scenario.junctions || [])) {
      const built = buildJunction(spec);
      this.root.add(built.group);
      this.junctions.push({ spec, group: built.group });
      this.signals.push(spec.signal || null);
    }
    this.props = [];
    for (const spec of (this.scenario.props || [])) this._addPropRig(spec);
    this.cars = [];
    this.colToCar = new Map();
    for (const spec of this.scenario.cars) this._addCarRig(spec);
    this.debris = []; // torn-off wheels: { car, body, node, r, prev, cur }
    this.tick = 0;
    this.accum = 0;
    this.syncVisuals(1);
  }

  _addCarRig(spec) {
    const rig = buildRig(RAPIER, this.world, spec, this.catOf(spec.type));
    rig.stream = makeStream(spec);
    rig.driver = spec.drive ? makeDriver(spec.drive) : null;
    this.root.add(rig.wrap);
    for (const c of rig.colliders) this.colToCar.set(c.handle, rig);
    this.cars.push(rig);
    return rig;
  }

  // roads: all-static — one fixed body at the origin carrying every curb box
  // (road points are world coordinates; the group is never transformed)
  _addRoadRig(spec) {
    const built = buildRoad(spec);
    this.root.add(built.group);
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const rec = { spec, group: built.group, body, handles: [] };
    for (const s of built.shapes) {
      const c = this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(s.he[0], s.he[1], s.he[2])
          .setTranslation(s.pos[0], s.pos[1], s.pos[2])
          .setRotation({ x: s.rot[0], y: s.rot[1], z: s.rot[2], w: s.rot[3] })
          .setFriction(0.75).setRestitution(0.05),
        body,
      );
      rec.handles.push(c.handle);
      this.colToObj.set(c.handle, { kind: 'road', rec });
    }
    this.roads.push(rec);
    return rec;
  }

  _addPropRig(spec) {
    const built = buildProp(spec.kind, spec.seed);
    if (!built) return null;
    const yaw = spec.heading || 0;
    const qProp = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    // spec.y: deck height for a prop sitting on an elevated road (cones, a
    // spilled load, a jump ramp). Opt-in like the car spawn — absent on every
    // flat scenario, where `|| 0` is the old hardcoded 0.
    built.group.position.set(spec.x || 0, spec.y || 0, spec.z || 0);
    built.group.rotation.y = yaw;
    this.root.add(built.group);
    built.group.updateMatrixWorld(true);
    const rec = { spec, group: built.group, dyn: [], bodies: [], handles: [] };
    const _p = new THREE.Vector3(), _q = new THREE.Quaternion();
    for (const bd of built.bodies) {
      // body world pose = prop pose ∘ node local pose (+ optional rest height);
      // when the node IS the prop group its local pose is identity by definition
      const isRoot = bd.node === built.group;
      if (isRoot) _p.set(0, 0, 0);
      else _p.copy(bd.node.position);
      _p.y += bd.y || 0;
      _p.applyQuaternion(qProp);
      _p.x += spec.x || 0; _p.y += spec.y || 0; _p.z += spec.z || 0;
      _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw + (isRoot ? 0 : bd.node.rotation.y));
      const desc = (bd.fixed ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic().setCcdEnabled(true))
        .setTranslation(_p.x, _p.y, _p.z)
        .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
      const body = this.world.createRigidBody(desc);
      rec.bodies.push(body);
      const cols = [];
      for (const s of bd.shapes) {
        let cd = null;
        if (s.kind === 'hull') cd = RAPIER.ColliderDesc.convexHull(s.pts);
        else if (s.kind === 'box') cd = RAPIER.ColliderDesc.cuboid(s.he[0], s.he[1], s.he[2]).setTranslation(s.pos[0], s.pos[1], s.pos[2]).setRotation({ x: s.rot[0], y: s.rot[1], z: s.rot[2], w: s.rot[3] });
        else if (s.kind === 'cyl') cd = RAPIER.ColliderDesc.cylinder(s.hh, s.r).setTranslation(s.pos[0], s.pos[1], s.pos[2]).setRotation({ x: s.rot[0], y: s.rot[1], z: s.rot[2], w: s.rot[3] });
        if (!cd) continue;
        cd.setFriction(bd.friction).setRestitution(bd.restitution).setDensity(1);
        const c = this.world.createCollider(cd, body);
        cols.push(c);
        rec.handles.push(c.handle);
        this.colToObj.set(c.handle, { kind: 'prop', rec });
      }
      if (!bd.fixed) {
        const m0 = body.mass();
        if (m0 > 1e-6) for (const c of cols) c.setDensity((bd.mass || 50) / m0);
        // dynamic nodes sync straight from their body — pull them up to root
        this.root.attach(bd.node);
        bd.node.position.set(_p.x, _p.y, _p.z);
        bd.node.quaternion.copy(_q);
        rec.dyn.push({
          node: bd.node, body,
          prev: { p: _p.clone(), q: _q.clone() },
          cur: { p: _p.clone(), q: _q.clone() },
        });
      }
    }
    this.props.push(rec);
    return rec;
  }

  /* G4 water. Bodies below the surface get buoyancy plus heavy drag, and a
     car that goes under and stops is logged as sunk. Determinism rules apply
     exactly as they do in the driver controller: arithmetic only, and every
     THRESHOLD compares squared magnitudes rather than calling Math.hypot,
     whose last bits are not guaranteed identical across JS engines. The
     onSplash/onSunk hooks are render-side like the other four. */
  _stepWater() {
    const wy = this.waterY;
    for (const car of this.cars) {
      if (car.sunkAt === undefined) { car.sunkAt = -1; car.inWater = false; }
      const t = car.body.translation();
      const depth = wy - t.y;
      if (depth <= 0) { car.inWater = false; continue; }
      const v = car.body.linvel();
      const v2 = v.x * v.x + v.y * v.y + v.z * v.z;
      if (!car.inWater) {
        car.inWater = true;
        if (this.onSplash) {
          this.onSplash(car, { point: { x: t.x, y: wy, z: t.z }, speed: Math.sqrt(v2) });
        }
      }
      const sub = depth < 1.4 ? depth / 1.4 : 1; // submerged fraction, saturating
      const m = car.body.mass();
      // buoyancy just under neutral so a wreck settles instead of bobbing
      car.body.applyImpulse({ x: 0, y: m * 9.81 * 0.62 * sub * STEP, z: 0 }, true);
      const k = 1.9 * sub * STEP;
      car.body.applyImpulse({ x: -v.x * m * k, y: -v.y * m * k * 0.6, z: -v.z * m * k }, true);
      const av = car.body.angvel();
      const tk = m * k * 0.4;
      car.body.applyTorqueImpulse({ x: -av.x * tk, y: -av.y * tk, z: -av.z * tk }, true);
      if (car.sunkAt < 0 && depth > 0.9 && v2 < 1.44) {
        car.sunkAt = this.tick;
        if (this.onSunk) this.onSunk(car, { point: { x: t.x, y: t.y, z: t.z } });
      }
    }
    if (!this.waterV2) return;
    // Fixed order, same as world creation: props (array order, then each rec's
    // dyn in build order), then debris. Anything appended later must keep it.
    for (const rec of this.props) {
      for (const d of rec.dyn) this._floatBody(d, d.body, 0.8, 0.78, 2.4, 'prop');
    }
    // A torn tyre floats — real ones do — so this is the one buoyancy above
    // neutral in the sim, and a wheel bobbing away downstream is worth it.
    for (const d of this.debris) this._floatBody(d, d.body, d.r * 2, 1.05, 3.1, 'debris');
  }

  /* The generic half of _stepWater, used only by v2. Buoyancy here is a
     mass-independent acceleration (m cancels), exactly as it is for cars — the
     honest alternative needs a real submerged volume per collider, and nothing
     in this game is worth that. So `buoy` is a per-CLASS choice about whether
     that class floats, not a density. Determinism rules are the driver
     controller's: arithmetic only, thresholds on squared magnitudes. */
  _floatBody(o, body, span, buoy, drag, kind) {
    const t = body.translation();
    const depth = this.waterY - t.y;
    if (depth <= 0) { o.inWater = false; return; }
    const v = body.linvel();
    const v2 = v.x * v.x + v.y * v.y + v.z * v.z;
    if (!o.inWater) {
      o.inWater = true;
      if (this.onObjSplash) {
        this.onObjSplash(o, { point: { x: t.x, y: this.waterY, z: t.z }, speed: Math.sqrt(v2), kind });
      }
    }
    const sub = depth < span ? depth / span : 1;
    const m = body.mass();
    body.applyImpulse({ x: 0, y: m * 9.81 * buoy * sub * STEP, z: 0 }, true);
    const k = drag * sub * STEP;
    body.applyImpulse({ x: -v.x * m * k, y: -v.y * m * k * 0.6, z: -v.z * m * k }, true);
    const av = body.angvel();
    const tk = m * k * 0.4;
    body.applyTorqueImpulse({ x: -av.x * tk, y: -av.y * tk, z: -av.z * tk }, true);
  }

  stepOnce() {
    for (const car of this.cars) {
      const inp = car.driver ? driveTick(this, car, this.tick) : car.stream(this.tick);
      const v = car.veh.currentVehicleSpeed();
      let th = v < car.cat.vmax ? inp.throttle : 0;
      let brake = inp.brake;
      // launch phases: hold until the start delay, then release (with a launch
      // impulse unless it's a rolling start); brake out after brakeTick
      if (this.tick < car.delayTicks) { th = 0; brake = 1; }
      else if (this.tick === car.delayTicks && car.delayTicks > 0 && !car.rolling && car.launchV > 0) {
        car.body.setLinvel({ x: car.launchFwd.x * car.launchV, y: 0, z: car.launchFwd.z * car.launchV }, true);
      }
      if (this.tick >= car.brakeTick) { th = 0; brake = 1; }
      car.brakingNow = brake > 0.5; // render-side state for the fx layer
      car.throttleNow = th;         // (never read back into the sim)
      // driven cars get real brake authority (input 1 ≈ firm stop, slam ≈
      // emergency lockup); stream cars keep the legacy scale so the old
      // scenario hashes never move
      const brakeK = car.driver ? 0.055 : 0.02;
      for (let i = 0; i < car.wheelMeta.length; i++) {
        const m = car.wheelMeta[i];
        if (m.detached) { car.veh.setWheelEngineForce(i, 0); car.veh.setWheelBrake(i, 0); continue; }
        car.veh.setWheelEngineForce(i, th * car.engineF);
        car.veh.setWheelBrake(i, brake * car.mass * brakeK);
        // bent wheels track crooked — misalignment adds onto driver steering
        if (m.steer) car.veh.setWheelSteering(i, inp.steer + m.bent);
        else if (m.bent !== 0) car.veh.setWheelSteering(i, m.bent);
      }
      car.veh.updateVehicle(STEP);
    }
    this.world.step(this.events);
    this.tick++;
    for (const car of this.cars) {
      car.prev.p.copy(car.cur.p); car.prev.q.copy(car.cur.q);
      const t = car.body.translation(), q = car.body.rotation();
      car.cur.p.set(t.x, t.y, t.z); car.cur.q.set(q.x, q.y, q.z, q.w);
      car.susPrev.set(car.susCur); car.rotPrev.set(car.rotCur);
      car.steerPrev = car.steerCur;
      for (let i = 0; i < car.wheelMeta.length; i++) {
        car.susCur[i] = car.veh.wheelSuspensionLength(i) ?? car.cat.rest;
        car.rotCur[i] = car.veh.wheelRotation(i) ?? 0;
      }
      car.steerCur = car.veh.wheelSteering(0) ?? 0;
    }
    for (const prop of this.props) {
      for (const d of prop.dyn) {
        d.prev.p.copy(d.cur.p); d.prev.q.copy(d.cur.q);
        const t = d.body.translation(), q = d.body.rotation();
        d.cur.p.set(t.x, t.y, t.z); d.cur.q.set(q.x, q.y, q.z, q.w);
      }
    }
    for (const d of this.debris) {
      d.prev.p.copy(d.cur.p); d.prev.q.copy(d.cur.q);
      const t = d.body.translation(), q = d.body.rotation();
      d.cur.p.set(t.x, t.y, t.z); d.cur.q.set(q.x, q.y, q.z, q.w);
    }
    if (this.waterY !== null) this._stepWater();
    this.events.drainCollisionEvents(() => {});
    this.processImpacts();
  }

  // crumple pass: read contact manifolds for every car, displace vertices
  // scaled by Δv (impulse / mass). Purely contact-driven ⇒ deterministic.
  // Also charges the wheel damage model, detects scraping (visual hook only),
  // and drains glass crack/shatter events out of the deform state.
  processImpacts() {
    const DV_MIN = 0.9; // below this it's resting/scraping contact, not a hit
    const _lp = new THREE.Vector3(), _iq = new THREE.Quaternion();
    for (const car of this.cars) {
      const bodyPos = car.body.translation(), bodyQuat = car.body.rotation();
      _iq.set(bodyQuat.x, bodyQuat.y, bodyQuat.z, bodyQuat.w).invert();
      const lv = car.body.linvel();
      const speed = Math.sqrt(lv.x * lv.x + lv.y * lv.y + lv.z * lv.z);
      let hit = false;
      let scrape = null;
      for (const col of car.colliders) {
        this.world.narrowPhase.contactPairsWith(col.handle, (otherCol) => {
          const other = otherCol.handle !== undefined ? otherCol.handle : otherCol;
          this.world.narrowPhase.contactPair(col.handle, other, (manifold, flipped) => {
            const nC = manifold.numContacts(), nS = manifold.numSolverContacts();
            if (!nC || !nS) return;
            let maxImp = 0;
            for (let i = 0; i < nC; i++) {
              const imp = manifold.contactImpulse(i);
              if (imp > maxImp) maxImp = imp;
            }
            const dv = maxImp / car.mass;
            if (dv < DV_MIN) {
              // touching-while-moving = grinding metal (sparks/dust, no deform)
              if (!scrape && dv > 0.012 && speed > 3.5) {
                const pt = manifold.solverContactPoint(0);
                scrape = { point: { x: pt.x, y: pt.y, z: pt.z }, speed, dyn: this.colToCar.has(other) };
              }
              return;
            }
            const pt = manifold.solverContactPoint(0);
            const n = manifold.normal(); // points collider1 → collider2
            const s = flipped ? 1 : -1;  // push INTO our car
            // attribution: what did we hit? (cars via colToCar, rest via colToObj)
            const oCar = this.colToCar.get(other);
            const oObj = oCar ? null : this.colToObj.get(other);
            const ev = {
              point: pt, dir: { x: n.x * s, y: n.y * s, z: n.z * s }, dv,
              other: oCar ? { kind: 'car', i: this.cars.indexOf(oCar) }
                : oObj ? { kind: oObj.kind, i: oObj.rec ? (oObj.kind === 'prop' ? this.props.indexOf(oObj.rec) : this.roads.indexOf(oObj.rec)) : -1 }
                  : { kind: 'unknown', i: -1 },
            };
            applyImpact(car.deform, ev, bodyPos, bodyQuat);
            hit = true;
            // damage bookkeeping (wrap-local impact point)
            _lp.set(pt.x - bodyPos.x, pt.y - bodyPos.y, pt.z - bodyPos.z).applyQuaternion(_iq);
            car.damage += dv;
            if (_lp.x > car.size.x * 0.18) car.frontDmg += dv;
            // charge nearby wheels — a corner hit wrecks that corner's wheel
            // (contact points live on the chassis hulls, so "near" reaches
            // from the bumper face back to the wheel arch)
            for (const m of car.wheelMeta) {
              if (m.detached || !m.hasVisual) continue;
              const dx = _lp.x - m.pos.x, dy = _lp.y - m.pos.y, dz = _lp.z - m.pos.z;
              const reach = m.r * 1.6 + 0.9;
              const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
              if (dist >= reach) continue;
              const prox = 1 - dist / reach;
              m.dmg += (dv * prox * 1.35) / car.cat.wheelTough;
            }
            if (this.onImpact) this.onImpact(car, ev);
          });
        });
      }
      if (hit) {
        flushDeform(car.deform);
        // wheel damage consequences (outside the manifold iteration — this
        // mutates the world). Order: wheel index order ⇒ deterministic.
        for (let i = 0; i < car.wheelMeta.length; i++) {
          const m = car.wheelMeta[i];
          if (m.detached) continue;
          if (m.dmg > WHEEL_DETACH_AT && m.hasVisual && !car.virtual) this._detachWheel(car, i);
          else if (m.dmg > WHEEL_BENT_AT && m.bent === 0 && m.hasVisual) {
            m.bent = (m.side >= 0 ? 1 : -1) * clamp(0.04 + (m.dmg - WHEEL_BENT_AT) * 0.02, 0.04, 0.15);
            car.veh.setWheelFrictionSlip(i, car.cat.grip * clamp(car.spec.grip || 1, 0.2, 4) * 0.55);
          }
        }
      }
      // glass events out of the deform state → world space → fx hook
      const gev = car.deform.events;
      if (gev.length) {
        const fq = new THREE.Quaternion(bodyQuat.x, bodyQuat.y, bodyQuat.z, bodyQuat.w);
        for (const e of gev) {
          _lp.set(e.local.x, e.local.y, e.local.z).applyQuaternion(fq);
          _lp.x += bodyPos.x; _lp.y += bodyPos.y; _lp.z += bodyPos.z;
          if (this.onGlass) this.onGlass(car, { type: e.type, point: { x: _lp.x, y: _lp.y, z: _lp.z }, r: e.r });
        }
        gev.length = 0;
      }
      if (scrape && this.onScrape) this.onScrape(car, scrape);
    }
  }

  // tear wheel i off `car`: kill its suspension, hand the visual wheel meshes
  // to a fresh dynamic body that inherits the car's velocity at that point.
  _detachWheel(car, i) {
    const m = car.wheelMeta[i];
    m.detached = true;
    m.bent = 0;
    car.veh.setWheelMaxSuspensionForce(i, 0);
    car.veh.setWheelFrictionSlip(i, 0);
    car.veh.setWheelSteering(i, 0);
    car.veh.setWheelEngineForce(i, 0);
    const bp = car.body.translation(), bq = car.body.rotation();
    const q = new THREE.Quaternion(bq.x, bq.y, bq.z, bq.w);
    // wheel center world = body ∘ (conn dropped by current suspension length)
    const local = new THREE.Vector3(m.conn.x, m.conn.y - (car.susCur[i] || car.cat.rest), m.conn.z);
    const wp = local.clone().applyQuaternion(q).add(new THREE.Vector3(bp.x, bp.y, bp.z));
    // velocity of that material point: v + ω × r, plus axle spin for rollout
    const lv = car.body.linvel(), av = car.body.angvel();
    const rel = wp.clone().sub(new THREE.Vector3(bp.x, bp.y, bp.z));
    const vel = new THREE.Vector3(
      lv.x + av.y * rel.z - av.z * rel.y,
      lv.y + av.z * rel.x - av.x * rel.z,
      lv.z + av.x * rel.y - av.y * rel.x,
    );
    const axle = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const spin = (lv.x * fwd.x + lv.y * fwd.y + lv.z * fwd.z) / Math.max(0.12, m.r);
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(wp.x, Math.max(wp.y, m.r * 0.6), wp.z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setLinvel(vel.x, vel.y + 0.6, vel.z)
        .setAngvel({ x: av.x - axle.x * spin, y: av.y - axle.y * spin, z: av.z - axle.z * spin })
        .setLinearDamping(0.08).setAngularDamping(0.6)
        .setCcdEnabled(true),
    );
    // cylinder collider axis is local y — rotate it onto the wheel axle (local z)
    const cols = [];
    cols.push(this.world.createCollider(
      RAPIER.ColliderDesc.cylinder(m.w / 2, m.r)
        .setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 })
        .setFriction(1.1).setRestitution(0.4).setDensity(1),
      body,
    ));
    const m0 = body.mass();
    const target = clamp(18 + m.r * m.r * m.w * 480, 15, 160);
    if (m0 > 1e-6) for (const c of cols) c.setDensity(target / m0);
    for (const c of cols) this.colToObj.set(c.handle, { kind: 'debris' });
    // visual wheels of this cluster leave the car and follow the debris body
    const node = new THREE.Group();
    this.root.add(node);
    node.position.copy(wp);
    node.quaternion.copy(q);
    node.updateMatrixWorld(true);
    for (let vi = car.vis.length - 1; vi >= 0; vi--) {
      if (car.vis[vi].phys === i) {
        node.attach(car.vis[vi].obj);
        car.vis.splice(vi, 1);
      }
    }
    this.debris.push({
      car, body, node, r: m.r, handles: cols.map((c) => c.handle),
      prev: { p: wp.clone(), q: q.clone() },
      cur: { p: wp.clone(), q: q.clone() },
    });
    if (this.onDetach) this.onDetach(car, { point: { x: wp.x, y: wp.y, z: wp.z }, r: m.r, speed: vel.length() });
  }

  // wall-clock update with accumulator; render-rate independent.
  // stopAt: freeze on an EXACT tick (the round's incident freeze) — the loop
  // never steps past it, no matter the frame rate.
  update(dtWall) {
    if (!this.playing) return false;
    this.accum += Math.min(dtWall, 0.1) * this.speed;
    let n = 0;
    while (this.accum >= STEP && n < 6) {
      if (this.stopAt != null && this.tick >= this.stopAt) { this.playing = false; this.accum = 0; break; }
      this.stepOnce(); this.accum -= STEP; n++;
    }
    if (n === 6) this.accum = 0; // hitched frame: drop backlog, sim state stays exact
    return n > 0;
  }

  syncVisuals(alphaArg) {
    const alpha = alphaArg !== undefined ? alphaArg : clamp(this.accum / STEP, 0, 1);
    const qz = new THREE.Quaternion(), qy = new THREE.Quaternion(), qx = new THREE.Quaternion();
    const Z = new THREE.Vector3(0, 0, 1), Y = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0);
    for (const car of this.cars) {
      car.wrap.position.lerpVectors(car.prev.p, car.cur.p, alpha);
      car.wrap.quaternion.slerpQuaternions(car.prev.q, car.cur.q, alpha);
      const steer = car.steerPrev + (car.steerCur - car.steerPrev) * alpha;
      for (const v of car.vis) {
        const i = v.phys;
        const m = car.wheelMeta[i];
        const len = car.susPrev[i] + (car.susCur[i] - car.susPrev[i]) * alpha;
        const rot = car.rotPrev[i] + (car.rotCur[i] - car.rotPrev[i]) * alpha;
        v.obj.position.set(m.conn.x, m.conn.y - len, v.z);
        qy.setFromAxisAngle(Y, (m.steer ? steer : 0) + m.bent);
        qz.setFromAxisAngle(Z, -rot);
        v.obj.quaternion.copy(qy).multiply(qz);
        if (m.bent !== 0) { // visible camber lean on a bent wheel
          qx.setFromAxisAngle(X, m.bent * 1.5);
          v.obj.quaternion.premultiply(qx);
        }
      }
    }
    for (const prop of this.props) {
      for (const d of prop.dyn) {
        d.node.position.lerpVectors(d.prev.p, d.cur.p, alpha);
        d.node.quaternion.slerpQuaternions(d.prev.q, d.cur.q, alpha);
      }
    }
    for (const d of this.debris) {
      d.node.position.lerpVectors(d.prev.p, d.cur.p, alpha);
      d.node.quaternion.slerpQuaternions(d.prev.q, d.cur.q, alpha);
    }
  }

  // FNV-1a over the f32 bits of every chassis transform — the determinism probe
  hashState() {
    let h = 0x811c9dc5 >>> 0;
    const f = new Float32Array(7), u = new Uint32Array(f.buffer);
    for (const car of this.cars) {
      const t = car.body.translation(), q = car.body.rotation();
      f[0] = t.x; f[1] = t.y; f[2] = t.z; f[3] = q.x; f[4] = q.y; f[5] = q.z; f[6] = q.w;
      for (let i = 0; i < 7; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; }
    }
    for (const prop of this.props) {
      for (const d of prop.dyn) {
        const t = d.body.translation(), q = d.body.rotation();
        f[0] = t.x; f[1] = t.y; f[2] = t.z; f[3] = q.x; f[4] = q.y; f[5] = q.z; f[6] = q.w;
        for (let i = 0; i < 7; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; }
      }
    }
    for (const d of this.debris) { // torn-off wheels are sim state too
      const t = d.body.translation(), q = d.body.rotation();
      f[0] = t.x; f[1] = t.y; f[2] = t.z; f[3] = q.x; f[4] = q.y; f[5] = q.z; f[6] = q.w;
      for (let i = 0; i < 7; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; }
    }
    return h >>> 0;
  }

  /* ---------------- incremental editing (paused only) ----------------
     These keep the paused scene responsive: only the touched object is
     rebuilt, everything else keeps its meshes and creation index untouched.
     They intentionally do NOT promise a deterministic world — the editor
     marks the scenario dirty and Play/Reset/Step trigger a full build(),
     which is the only path a recorded run ever starts from. */
  replaceCar(i) {
    const old = this.cars[i];
    if (!old) return null;
    this._dropDebrisOf(old);
    for (const c of old.colliders) this.colToCar.delete(c.handle);
    old.veh.free();
    this.world.removeRigidBody(old.body);
    this.root.remove(old.wrap);
    disposeGroup(old.wrap);
    const spec = this.scenario.cars[i];
    const rig = buildRig(RAPIER, this.world, spec, this.catOf(spec.type));
    rig.stream = makeStream(spec);
    this.root.add(rig.wrap);
    for (const c of rig.colliders) this.colToCar.set(c.handle, rig);
    this.cars[i] = rig;
    this.syncVisuals(1);
    return rig;
  }

  appendCar() { // scenario.cars already has the new spec at the end
    const rig = this._addCarRig(this.scenario.cars[this.cars.length]);
    this.syncVisuals(1);
    return rig;
  }

  removeCarAt(i) {
    const old = this.cars[i];
    if (!old) return;
    this._dropDebrisOf(old);
    for (const c of old.colliders) this.colToCar.delete(c.handle);
    old.veh.free();
    this.world.removeRigidBody(old.body);
    this.root.remove(old.wrap);
    disposeGroup(old.wrap);
    this.cars.splice(i, 1);
  }

  _dropDebrisOf(car) {
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      if (d.car !== car) continue;
      for (const h of d.handles) this.colToObj.delete(h);
      this.world.removeRigidBody(d.body);
      this.root.remove(d.node);
      disposeGroup(d.node);
      this.debris.splice(i, 1);
    }
  }

  // paused pose edit: move body + visuals together so Step stays sane
  setCarPose(i, x, z, heading, y = 0) {
    const car = this.cars[i];
    if (!car) return;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
    const sy = y + 0.035; // matches the spawn convention above (y=0 ⇒ 0.035)
    car.body.setTranslation({ x, y: sy, z }, true);
    car.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    car.prev.p.set(x, sy, z); car.cur.p.set(x, sy, z);
    car.prev.q.copy(q); car.cur.q.copy(q);
    car.wrap.position.set(x, car.wrap.position.y, z);
    car.wrap.quaternion.copy(q);
  }

  _disposePropRig(rec) {
    for (const h of rec.handles) this.colToObj.delete(h);
    for (const b of rec.bodies) this.world.removeRigidBody(b);
    for (const d of rec.dyn) { this.root.remove(d.node); disposeGroup(d.node); }
    this.root.remove(rec.group);
    disposeGroup(rec.group);
  }

  appendProp() {
    const rec = this._addPropRig(this.scenario.props[this.props.length]);
    this.syncVisuals(1);
    return rec;
  }

  removePropAt(i) {
    const rec = this.props[i];
    if (!rec) return;
    this._disposePropRig(rec);
    this.props.splice(i, 1);
  }

  replaceProp(i) {
    this.removePropAt(i);
    const rec = this._addPropRig(this.scenario.props[i]);
    if (rec) {
      this.props.pop();
      this.props.splice(i, 0, rec);
    }
    this.syncVisuals(1);
    return rec;
  }

  _disposeRoadRig(rec) {
    for (const h of rec.handles) this.colToObj.delete(h);
    this.world.removeRigidBody(rec.body); // frees its colliders too
    this.root.remove(rec.group);
    disposeGroup(rec.group);
  }

  appendRoad() {
    return this._addRoadRig(this.scenario.roads[this.roads.length]);
  }

  removeRoadAt(i) {
    const rec = this.roads[i];
    if (!rec) return;
    this._disposeRoadRig(rec);
    this.roads.splice(i, 1);
  }

  replaceRoad(i) {
    this.removeRoadAt(i);
    const rec = this._addRoadRig(this.scenario.roads[i]);
    if (rec) {
      this.roads.pop();
      this.roads.splice(i, 0, rec);
    }
    return rec;
  }

  // paused prop pose edit: rebuild in place (props are cheap to build)
  setPropPose(i, x, z, heading) {
    const rec = this.props[i];
    if (!rec) return;
    rec.spec.x = x; rec.spec.z = z; rec.spec.heading = heading;
    this.replaceProp(i);
  }

  // perfect reset: rebuild world + fresh (undeformed) meshes from the scenario
  reset() {
    this.disposeSim();
    this.build();
  }

  disposeSim() {
    for (const car of this.cars) {
      this.root.remove(car.wrap);
      disposeGroup(car.wrap);
      car.veh.free();
    }
    for (const rec of this.props) {
      for (const d of rec.dyn) { this.root.remove(d.node); disposeGroup(d.node); }
      this.root.remove(rec.group);
      disposeGroup(rec.group);
    }
    for (const rec of this.roads) {
      this.root.remove(rec.group);
      disposeGroup(rec.group);
    }
    for (const rec of (this.junctions || [])) {
      this.root.remove(rec.group);
      disposeGroup(rec.group);
    }
    for (const d of this.debris) {
      this.root.remove(d.node);
      disposeGroup(d.node);
    }
    this.events.free();
    this.world.free(); // frees every body/collider, prop/road/debris bodies included
    this.cars = [];
    this.props = [];
    this.roads = [];
    this.junctions = [];
    this.debris = [];
  }

  dispose() { this.disposeSim(); }
}

/* ---------------- determinism self-test (?simtest=1) ----------------
   Two scenarios: the legacy 3-car crash (reference hash must never drift
   unless physics intentionally changed) and a full-feature one exercising
   non-default gravity, arena walls, props (ramp jump + box stack), and the
   per-car physics/launch parameters. Each runs twice and must match. */
export const TEST_SCENARIOS = {
  legacy: {
    cars: [
      { seed: '11', type: 'sedan', x: -14, z: 0, heading: 0, speed: 16, throttle: 1, steer: 0 },
      { seed: '22', type: 'pickup', x: 14, z: 0.4, heading: Math.PI, speed: 16, throttle: 1, steer: 0 },
      { seed: '33', type: 'citybus', x: 0, z: -14, heading: Math.PI / 2, speed: 10, throttle: 1, steer: 0.2 },
    ],
  },
  extended: {
    world: { gravity: 20, arena: 70, walls: true },
    props: [
      { kind: 'ramp', x: 0, z: 0, heading: 0 },
      { kind: 'boxes', x: 10, z: 0, heading: 0.3 },
      { kind: 'pole', x: 14, z: 3, heading: 0 },
    ],
    cars: [
      { seed: '11', type: 'muscle', x: -22, z: 0, heading: 0, speed: 24, throttle: 1, steer: 0, mass: 1.5, grip: 1.3, rest: 0.4, crumple: 1.6 },
      { seed: '77', type: 'pickup', x: -16, z: 6, heading: 0, speed: 18, throttle: 1, steer: 0, delay: 0.5 },
      { seed: '5', type: 'hatch', x: 18, z: -4, heading: Math.PI, speed: 0, throttle: 1, steer: 0.1, rolling: 1, delay: 0.3, brake: 3.5 },
    ],
  },
  // world-building P1: seeded scenery props (fixed + dynamic mix) must replay
  // bit-exact too — an SUV plows a suburban street of knockables
  scenery: {
    props: [
      { kind: 'house', x: 2, z: -12, heading: 0, seed: '7' },
      { kind: 'tree_round', x: -6, z: -4, heading: 0.4, seed: '3' },
      { kind: 'fence_picket', x: 4, z: -5, heading: 0.1, seed: '5' },
      { kind: 'hydrant', x: 0, z: 0.4, heading: 0, seed: '2' },
      { kind: 'cone', x: 4, z: 0, heading: 0, seed: '1' },
      { kind: 'cone', x: 6, z: 0.6, heading: 0.5, seed: '9' },
      { kind: 'sign_stop', x: 9, z: -0.5, heading: 0, seed: '4' },
      { kind: 'traffic_light', x: 13, z: 1, heading: 3.1, seed: '6' },
    ],
    cars: [
      { seed: '44', type: 'suv', x: -18, z: 0, heading: 0, speed: 22, throttle: 1, steer: 0.02 },
    ],
  },
  // world-building P2: spline roads — curb colliders must replay bit-exact
  // (the car is aimed to clip a curb of the swirly road at speed)
  roads: {
    world: { gravity: 9.81, arena: 90, walls: false },
    roads: [
      { w: 7, loop: 0, style: 6, pts: [{ x: -30, z: -10 }, { x: -10, z: 8 }, { x: 12, z: -6 }, { x: 30, z: 4 }] },
      { w: 6, loop: 1, style: 1, pts: [{ x: -6, z: -26 }, { x: 10, z: -32 }, { x: 16, z: -18 }, { x: -2, z: -14 }] },
    ],
    props: [
      { kind: 'cone', x: -8, z: 6, heading: 0, seed: '3' },
      { kind: 'sign_stop', x: 12, z: -3.2, heading: 0.6, seed: '2' },
    ],
    cars: [
      { seed: '9', type: 'sedan', x: -30, z: -14, heading: 0.35, speed: 24, throttle: 1, steer: -0.04 },
      { seed: '13', type: 'muscle', x: 26, z: 8, heading: Math.PI, speed: 20, throttle: 1, steer: 0.06, delay: 0.4 },
    ],
  },
  /* G5: a car placed ON an elevated span, driving its length.
     This is the case that had NO coverage, and its absence is why road
     elevation shipped in G4 with no drivable surface at all. `bridge` below
     enters from the ramp foot, where the deck y IS 0 — so a car at the world
     floor is coincidentally on the road, and the scenario stayed green while
     a car placed anywhere else on the span fell straight through to the
     ground. Every director-placed car on a causeway or switchback did exactly
     that: the whole cast drove along underneath the road.
     So this scenario spawns mid-span via spec.y and pins the deck surface
     collider. If the driving surface ever disappears again, these two cars
     land on the floor 5 m below and the hash moves loudly. */
  deck: {
    world: { gravity: 9.81, arena: 120, walls: false },
    roads: [
      { w: 9, loop: 0, style: 1 | 8, pts: [
        { x: -50, y: 0, z: 0 }, { x: -18, y: 5.0, z: 0 },
        { x: 18, y: 5.0, z: 0 }, { x: 50, y: 0, z: 0 },
      ] },
    ],
    props: [],
    // deck surface: 5.546 at x=∓8, 5.381 at x=12 (roadCurve, +1 cm to land on).
    // Same lane offset on purpose — they meet head-on ~40 ticks in, mid-span,
    // so the pin covers a real collision WITH deform happening on the elevated
    // surface, not just two cars coasting past each other on it.
    cars: [
      { seed: '11', type: 'sedan', x: -8, y: 5.56, z: -2.0, heading: 0, speed: 18, throttle: 1 },
      { seed: '3', type: 'pickup', x: 12, y: 5.39, z: -2.0, heading: Math.PI, speed: 12, throttle: 1 },
    ],
  },
  // G4 road elevation: a car drives a humped bridge deck, so this pins the
  // y-aware sweep AND the pitched parapet colliders (the flat-road path is
  // deliberately a different branch — see roads.js — and stays pinned by the
  // `roads` scenario above, which must never move)
  bridge: {
    world: { gravity: 9.81, arena: 90, walls: false },
    roads: [
      { w: 9, loop: 0, style: 1 | 8, pts: [
        { x: -40, y: 0, z: 0 }, { x: -14, y: 4.2, z: 0 },
        { x: 14, y: 4.2, z: 0 }, { x: 40, y: 0, z: 0 },
      ] },
    ],
    props: [],
    // y = the deck surface at x=±36 (0.689 by roadCurve, rounded up a cm so
    // the car drops the last few mm onto the slab rather than starting inside
    // it). Before the deck had a collider these cars sat at the world floor
    // and drove UNDER the span — which is precisely why this scenario passed
    // while road elevation had no drivable surface at all.
    cars: [
      { seed: '5', type: 'sedan', x: -36, y: 0.7, z: -1.8, heading: 0, speed: 26, throttle: 1 },
      { seed: '21', type: 'van', x: 36, y: 0.7, z: 1.8, heading: Math.PI, speed: 18, throttle: 1, delay: 0.3 },
    ],
  },
  // G4 water: a car leaves a bridge deck, breaks the surface and sinks to the
  // bed. Pins buoyancy/drag, the carved basin (four land slabs + bed) and the
  // splash/sunk thresholds. Water is opt-in, so no pre-G4 scenario is touched.
  water: {
    world: {
      gravity: 9.81, arena: 120, walls: false,
      water: { y: -0.6, x0: -16, x1: 16, z0: -60, z1: 60 },
    },
    roads: [
      { w: 9, loop: 0, style: 1 | 8, pts: [
        { x: -60, y: 0, z: 0 }, { x: -30, y: 3.4, z: 0 },
        { x: 30, y: 3.4, z: 0 }, { x: 60, y: 0, z: 0 },
      ] },
    ],
    props: [],
    // deck surface at x=−52 is 1.018; start on it, not 1 m under it
    cars: [
      { seed: '7', type: 'sedan', x: -52, y: 1.03, z: -3.4, heading: 0.11, speed: 30, throttle: 1 },
    ],
  },
  // 1C water v2: buoyancy and drag reach dynamic props and torn-off wheels
  // rather than only this.cars. `water` stays alongside this WITHOUT the flag,
  // which is what proves the opt-in is really an opt-in.
  //
  // A shallow flooded pan rather than a bridge, and that is a deliberate second
  // attempt. The first version put a head-on on an elevated span so the wheels
  // would drop into the channel; both cars spawned a few centimetres inside the
  // ramp, shed a wheel at tick 5 from the ejection alone and never met — the
  // exact fragility CLAUDE.md already records for the deck and bridge pins.
  // Here every body starts on flat ground, so the only thing under test is the
  // water path.
  //
  // `bed: 0` is the trick that makes it work. The bed collider's top face and
  // the surrounding land slabs then both sit at y = 0, so the driving surface
  // is exactly the flat plane carnage crashes on — same spawn heights, same
  // energy, no drop — and the only thing the basin changes is that the arena is
  // now under 60 cm of water. A dug-out pan instead dropped every car a metre
  // at spawn, and the drag on the submerged chassis bled off so much speed that
  // the wreck stopped shedding wheels at all: 0 debris bodies, and the half of
  // this scenario that exists for the debris loop tested nothing.
  //
  // The depth is chosen, not picked: _floatBody reads the body's CENTRE, so a
  // wheel at rest sits at r ≈ 0.4 and the surface has to clear that or the
  // debris loop runs on nothing. At 0.6 the wheels are properly under and the
  // chassis rides the line, which is what a flooded road actually looks like.
  waterv2: {
    world: {
      gravity: 9.81, arena: 70, walls: true,
      water: { y: 0.6, x0: -40, x1: 40, z0: -40, z1: 40, bed: 0, v2: true },
    },
    props: [
      { kind: 'pole', x: 6, z: 0, heading: 0 },
      { kind: 'boxes', x: -7, z: 5.5, heading: 0.4 },
    ],
    // the carnage cast, which is tuned to shed wheels and shatter glass
    cars: [
      { seed: '3', type: 'muscle', x: -26, z: 0, heading: 0, speed: 30, throttle: 1, steer: 0 },
      { seed: '8', type: 'sedan', x: 26, z: 0.5, heading: Math.PI, speed: 28, throttle: 1, steer: 0 },
      { seed: '21', type: 'suv', x: 0, z: -24, heading: Math.PI / 2, speed: 26, throttle: 1, steer: 0.12 },
    ],
  },
  // crash-quality pass: high-energy wrecks must replay bit-exact too — this
  // scenario is tuned to trigger wheel detachment (debris bodies enter the
  // world mid-run) and glass shatter, so it pins both new systems
  carnage: {
    world: { gravity: 9.81, arena: 70, walls: true },
    props: [
      { kind: 'pole', x: 6, z: 0, heading: 0 },
      { kind: 'barrier', x: -6, z: 6, heading: 0.8 },
    ],
    cars: [
      { seed: '3', type: 'muscle', x: -26, z: 0, heading: 0, speed: 30, throttle: 1, steer: 0 },
      { seed: '8', type: 'sedan', x: 26, z: 0.5, heading: Math.PI, speed: 28, throttle: 1, steer: 0 },
      { seed: '21', type: 'suv', x: 0, z: -24, heading: Math.PI / 2, speed: 26, throttle: 1, steer: 0.12 },
    ],
  },
  // G1 director era: a full generated round (driven cars on a signalized
  // intersection, incident firing at tick 600) must replay bit-exact. This
  // pins the driver controller AND the scene generator — any drift in lane
  // extraction, placement or pure-pursuit math moves the hash.
  director: (() => {
    // SPREAD, never re-list. The enumerated form is the exact shape that made
    // the causeway generate a bridge over dry land for a whole phase (it
    // dropped `world.water`), and it would have silently dropped `junctions`
    // here too — leaving the pin certifying a scene the game never builds.
    // A pin that bypasses part of the generator does not pin the generator.
    return { ...generateScene('pin-1', 4) };
  })(),
  // world-building P3: a full generated suburb must replay bit-exact — this
  // also pins the generator itself (layout drift changes the hash)
  worldgen: (() => {
    const g = generateWorld('suburb', '7', { maxProps: 48, maxRoads: 6 });
    return {
      world: { gravity: 9.81, arena: g.world.arena, walls: true },
      roads: g.roads,
      props: g.props,
      cars: [
        { seed: '21', type: 'pickup', x: 0, z: 0, heading: 0.5, speed: 20, throttle: 1, steer: 0.03 },
      ],
    };
  })(),
};

export async function simSelfTest(catOf, log = console.log) {
  const R = await loadRapier();
  const runScenario = (scenario) => {
    const sim = new CrashSim(R, scenario, catOf);
    const hashes = new Uint32Array(301);
    for (let i = 0; i < 300; i++) { sim.stepOnce(); hashes[i] = sim.hashState(); }
    // fold deformed geometry in too — crumple must replay bit-exact
    let g = 0x811c9dc5 >>> 0;
    for (const car of sim.cars) {
      for (const md of car.deform.meshes) {
        const u = new Uint32Array(md.pos.array.buffer, md.pos.array.byteOffset, md.pos.array.length);
        for (let i = 0; i < u.length; i += 7) { g ^= u[i]; g = Math.imul(g, 16777619) >>> 0; }
      }
    }
    hashes[300] = g >>> 0;
    sim.dispose();
    return hashes;
  };
  let allOk = true;
  for (const [name, scenario] of Object.entries(TEST_SCENARIOS)) {
    const a = runScenario(scenario), b = runScenario(scenario);
    let firstDiff = -1;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { firstDiff = i; break; }
    const ok = firstDiff === -1;
    allOk = allOk && ok;
    log(ok ? `SIM DETERMINISTIC [${name}]: ok (300 steps + crumple, final hash ${a[299].toString(16)}, geo ${a[300].toString(16)})`
           : `SIM DETERMINISTIC [${name}]: FAIL — first divergence at ${firstDiff === 300 ? 'geometry' : 'step ' + firstDiff}`);
  }
  log(allOk ? 'SIM DETERMINISTIC: ok' : 'SIM DETERMINISTIC: FAIL');
  return allOk;
}
