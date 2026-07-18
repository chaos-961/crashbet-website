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

export const STEP = 1 / 60;

/* ---------------- Rapier loader (lazy — 2.2 MB module, only crash mode needs it) ---------------- */
let RAPIER = null;
export async function loadRapier() {
  if (RAPIER) return RAPIER;
  const mod = await import('../libs/rapier3d-compat.module.js');
  RAPIER = mod.default;
  await RAPIER.init();
  return RAPIER;
}

/* ---------------- per-category tuning ----------------
   mass scales with footprint relative to `ref` (m²) so a city bus outweighs a
   minibus without hand-tuning 92 archetypes. accel/vmax/grip are arcade values. */
const CAT_PHYS = {
  'Cars':                { mass: 1250, ref: 8.6,  accel: 6.5, vmax: 38, grip: 3.0, rest: 0.2,  comYk: 1.0, ballast: 0.55 },
  'Racing & Fun':        { mass: 750,  ref: 6.8,  accel: 10,  vmax: 55, grip: 4.2, rest: 0.13, comYk: 0.8, ballast: 0.6 },
  'Off-Road':            { mass: 2100, ref: 9.6,  accel: 6,   vmax: 30, grip: 2.6, rest: 0.34, comYk: 1.7, ballast: 0.5 },
  'Vans & Buses':        { mass: 4600, ref: 17,   accel: 3.6, vmax: 25, grip: 2.4, rest: 0.24, comYk: 2.3, ballast: 0.45 },
  'Trucks':              { mass: 7000, ref: 21.6, accel: 3.2, vmax: 24, grip: 2.4, rest: 0.28, comYk: 1.8, ballast: 0.5 },
  'Service & Emergency': { mass: 1800, ref: 10,   accel: 6.5, vmax: 36, grip: 2.9, rest: 0.22, comYk: 1.2, ballast: 0.52 },
  'Construction':        { mass: 9000, ref: 15.6, accel: 2.2, vmax: 9,  grip: 3.5, rest: 0.16, comYk: 1.0, ballast: 0.6 },
  'Rail':                { mass: 12000, ref: 26,  accel: 2.8, vmax: 16, grip: 3.5, rest: 0.12, comYk: 1.2, ballast: 0.55 },
  'Special':             { mass: 750,  ref: 5.6,  accel: 4.5, vmax: 18, grip: 2.6, rest: 0.2,  comYk: 1.1, ballast: 0.55 },
};
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
  const mass = cat.mass * clamp(footprint / cat.ref, 0.4, 2.8);

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

  // spawn pose
  const yaw = spec.heading || 0;
  const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(qYaw);
  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(spec.x || 0, 0.035, spec.z || 0)
    .setRotation({ x: qYaw.x, y: qYaw.y, z: qYaw.z, w: qYaw.w })
    .setLinvel(fwd.x * (spec.speed || 0), 0, fwd.z * (spec.speed || 0))
    .setAngularDamping(0.35)
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
    cd.setFriction(0.5).setRestitution(0.12).setDensity(1);
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
    veh.setWheelSuspensionStiffness(i, 32);
    veh.setWheelSuspensionCompression(i, 2.4);
    veh.setWheelSuspensionRelaxation(i, 3.2);
    veh.setWheelMaxSuspensionTravel(i, rest * 1.05);
    veh.setWheelMaxSuspensionForce(i, mass * 9.81 * 0.9);
    veh.setWheelFrictionSlip(i, cat.grip);
    veh.setWheelSideFrictionStiffness(i, 1);
    wheelMeta.push({ steer: w.x >= steerXCut, conn: { x: w.x, y: w.y + rest * 0.65, z: w.z }, r: w.r });
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

  return {
    spec, built, wrap, body, colliders, veh, wheelMeta, vis, mass, cat, engineF, virtual,
    deform: makeDeformState(wrap, size),
    prev: { p: new THREE.Vector3(0, 0.035, 0), q: qYaw.clone() },
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
    this.onImpact = null; // (car, ev) hook — deformation pass
    this.build();
  }

  build() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = STEP;
    this.events = new RAPIER.EventQueue(true);
    const g = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.groundCol = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(220, 1, 220).setTranslation(0, -1, 0).setFriction(0.9),
      g,
    );
    this.cars = [];
    this.colToCar = new Map();
    for (const spec of this.scenario.cars) {
      const rig = buildRig(RAPIER, this.world, spec, this.catOf(spec.type));
      rig.stream = makeStream(spec);
      this.root.add(rig.wrap);
      for (const c of rig.colliders) this.colToCar.set(c.handle, rig);
      this.cars.push(rig);
    }
    this.tick = 0;
    this.accum = 0;
    this.syncVisuals(1);
  }

  stepOnce() {
    for (const car of this.cars) {
      const inp = car.stream(this.tick);
      const v = car.veh.currentVehicleSpeed();
      const th = v < car.cat.vmax ? inp.throttle : 0;
      for (let i = 0; i < car.wheelMeta.length; i++) {
        car.veh.setWheelEngineForce(i, th * car.engineF);
        car.veh.setWheelBrake(i, inp.brake * car.mass * 0.02);
        if (car.wheelMeta[i].steer) car.veh.setWheelSteering(i, inp.steer);
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
    this.events.drainCollisionEvents(() => {});
    this.processImpacts();
  }

  // crumple pass: read contact manifolds for every car, displace vertices
  // scaled by Δv (impulse / mass). Purely contact-driven ⇒ deterministic.
  processImpacts() {
    const DV_MIN = 0.9; // below this it's resting/scraping contact, not a hit
    for (const car of this.cars) {
      const bodyPos = car.body.translation(), bodyQuat = car.body.rotation();
      let hit = false;
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
            if (dv < DV_MIN) return;
            const pt = manifold.solverContactPoint(0);
            const n = manifold.normal(); // points collider1 → collider2
            const s = flipped ? 1 : -1;  // push INTO our car
            const ev = { point: pt, dir: { x: n.x * s, y: n.y * s, z: n.z * s }, dv };
            applyImpact(car.deform, ev, bodyPos, bodyQuat);
            hit = true;
            if (this.onImpact) this.onImpact(car, ev);
          });
        });
      }
      if (hit) flushDeform(car.deform);
    }
  }

  // wall-clock update with accumulator; render-rate independent
  update(dtWall) {
    if (!this.playing) return false;
    this.accum += Math.min(dtWall, 0.1) * this.speed;
    let n = 0;
    while (this.accum >= STEP && n < 6) { this.stepOnce(); this.accum -= STEP; n++; }
    if (n === 6) this.accum = 0; // hitched frame: drop backlog, sim state stays exact
    return n > 0;
  }

  syncVisuals(alphaArg) {
    const alpha = alphaArg !== undefined ? alphaArg : clamp(this.accum / STEP, 0, 1);
    const qz = new THREE.Quaternion(), qy = new THREE.Quaternion();
    const Z = new THREE.Vector3(0, 0, 1), Y = new THREE.Vector3(0, 1, 0);
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
        qy.setFromAxisAngle(Y, m.steer ? steer : 0);
        qz.setFromAxisAngle(Z, -rot);
        v.obj.quaternion.copy(qy).multiply(qz);
      }
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
    return h >>> 0;
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
    this.events.free();
    this.world.free();
    this.cars = [];
  }

  dispose() { this.disposeSim(); }
}

/* ---------------- determinism self-test (?simtest=1) ---------------- */
export async function simSelfTest(catOf, log = console.log) {
  const R = await loadRapier();
  const scenario = {
    cars: [
      { seed: '11', type: 'sedan', x: -14, z: 0, heading: 0, speed: 16, throttle: 1, steer: 0 },
      { seed: '22', type: 'pickup', x: 14, z: 0.4, heading: Math.PI, speed: 16, throttle: 1, steer: 0 },
      { seed: '33', type: 'citybus', x: 0, z: -14, heading: Math.PI / 2, speed: 10, throttle: 1, steer: 0.2 },
    ],
  };
  const run = () => {
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
  const a = run(), b = run();
  let firstDiff = -1;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { firstDiff = i; break; }
  const ok = firstDiff === -1;
  log(ok ? `SIM DETERMINISTIC: ok (300 steps + crumple, final hash ${a[299].toString(16)}, geo ${a[300].toString(16)})`
         : `SIM DETERMINISTIC: FAIL — first divergence at ${firstDiff === 300 ? 'geometry' : 'step ' + firstDiff}`);
  return ok;
}
