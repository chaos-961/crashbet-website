// povcam.js — the round's camera loadout (game phase G3).
//
// Every scene ships a set of points of view that difficulty prunes: dashcams
// on flagged cars (never the whole cast), a CCTV pole, a news-chopper orbit
// and a witness tripod. Freecam is always available and lives in main.js.
//
// Two rules this module exists to keep:
//  - It is PURELY render-side. It reads sim transforms and writes camera
//    position/quaternion, nothing else. No sim state is touched, so a POV
//    switch can never change what the physics does.
//  - Placement is deterministic per seed ('pov:'+seed), so the same scene
//    always ships the same camera rig — a shared seed shows the same shots.
//
// The per-type "look" is split: this module owns camera MOTION (sway, drift,
// handheld shake, slow pan); css owns the LENS treatment (grain, vignette,
// letterbox) via a class on #povfx.
import * as THREE from 'three';
import { makeRng } from './lib.js';

const _v = new THREE.Vector3();
const _f = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export const POV_META = {
  // 'Free' hands the camera back to the player: orbit by default, the
  // touch-friendly mode. The WASD/joystick freecam is a separate toggle
  // (camBtn / C key) — labelling this chip 'Freecam' claimed a mode it never
  // entered (ledger #9), it only ever calls setCamMode('orbit').
  free: { label: 'Free', icon: '🎮' },
  dash: { label: 'Dashcam', icon: '🚘' },
  cctv: { label: 'CCTV', icon: '📹' },
  chopper: { label: 'Chopper', icon: '🚁' },
  witness: { label: 'Witness', icon: '🎥' },
};

// How many non-freecam POVs a difficulty is allowed to show before the
// resolve. d1–3 get full coverage; d8+ can be a single grainy CCTV. This is
// one of the levers the spec lists under "what difficulty actually changes".
export function povBudget(d) {
  if (d <= 3) return 9;
  if (d <= 5) return 3;
  if (d <= 7) return 2;
  return 1;
}

// Deterministic rig for a scene. `focus` is the point the fixed cameras are
// aimed at — the incident neighbourhood, so every shot actually covers the
// action instead of pointing at empty asphalt.
export function buildLoadout(scene, seed, d, focus) {
  const rng = makeRng('pov:' + seed);
  const fx = focus ? focus.x : 0;
  const fz = focus ? focus.z : 0;
  const all = [];

  // dashcams: flagged cars only. The aggressor is never guaranteed one —
  // riding the car that causes it would give the read away for free.
  const agg = scene.meta.aggressor;
  for (let i = 0; i < scene.cars.length; i++) {
    if (i === agg ? rng.chance(0.3) : rng.chance(0.5)) {
      all.push({ id: 'dash' + i, kind: 'dash', car: i });
    }
  }
  // CCTV pole: off to one side, high enough to see over traffic
  const ca = rng.range(0, Math.PI * 2);
  const cr = rng.range(15, 23);
  all.push({
    id: 'cctv', kind: 'cctv',
    pos: [fx + Math.cos(ca) * cr, rng.range(6.5, 8.5), fz + Math.sin(ca) * cr],
    pan: rng.range(0.05, 0.13), phase: rng.range(0, 6.28),
  });
  // news chopper: slow high orbit
  all.push({
    id: 'chopper', kind: 'chopper',
    r: rng.range(30, 42), h: rng.range(20, 28),
    phase: rng.range(0, 6.28), spin: rng.range(0.055, 0.1) * rng.sign(),
  });
  // witness on the kerb: eye height, handheld
  const wa = ca + rng.range(1.8, 4.4); // a different side than the CCTV
  const wr = rng.range(13, 20);
  all.push({
    id: 'witness', kind: 'witness',
    pos: [fx + Math.cos(wa) * wr, rng.range(1.5, 1.8), fz + Math.sin(wa) * wr],
    shake: rng.range(0.5, 1.0),
  });

  // difficulty prune. `all` is dashcams-then-fixed, so taking the first N kept
  // ONLY dashcams at d4–7 (budget 2–3) and every wide shot was structurally
  // unreachable (ledger #11). Interleave fixed and dash — fixed first — so the
  // kept set always leads with a wide angle and mixes in dashcams as the budget
  // grows. This only reorders an already-drawn list, so no rng draw shifts and
  // the same seed still ships the same shots.
  const budget = povBudget(d);
  const dash = all.filter((p) => p.kind === 'dash');
  const fixed = all.filter((p) => p.kind !== 'dash');
  const order = [];
  for (let i = 0, j = 0; i < fixed.length || j < dash.length;) {
    if (i < fixed.length) order.push(fixed[i++]);
    if (j < dash.length) order.push(dash[j++]);
  }
  const kept = order.slice(0, budget);
  return { all, available: kept };
}

/* ---------------- driving ---------------- */
// Camera-shake style offsets are all derived from t (wall clock) with cheap
// trig — this never feeds back into anything, so non-determinism is fine here
// in a way it explicitly is NOT in the sim.
const n1 = (t, k) => Math.sin(t * k) * 0.6 + Math.sin(t * k * 2.37 + 1.1) * 0.4;

export function drivePov(pov, camera, sim, focus, t, dt) {
  if (!pov || pov.kind === 'free') return false;

  if (pov.kind === 'dash') {
    const car = sim.cars[pov.car];
    if (!car) return false;
    // sit where a dashcam sits: just behind the windscreen, on the centreline.
    // Vehicle space is forward=+X (project convention), so the local offset
    // is +X forward and +Y up.
    car.wrap.updateMatrixWorld();
    _v.set(0.55, 1.28, 0).applyMatrix4(car.wrap.matrixWorld);
    camera.position.copy(_v);
    _f.set(9, 0.9, 0).applyMatrix4(car.wrap.matrixWorld);
    // suspension sway: a little roll/pitch lag so it reads as mounted, not flown
    const sway = n1(t, 1.7) * 0.06;
    _f.y += n1(t, 2.3) * 0.09;
    camera.up.set(Math.sin(sway) * 0.2, 1, 0).normalize();
    camera.lookAt(_f);
    return true;
  }

  camera.up.copy(_up);

  if (pov.kind === 'cctv') {
    camera.position.set(pov.pos[0], pov.pos[1], pov.pos[2]);
    // a slow motorised pan that lags the action — it is a security camera,
    // it does not track perfectly
    _f.copy(focus);
    _f.x += Math.sin(t * pov.pan + pov.phase) * 2.2;
    _f.z += Math.cos(t * pov.pan * 0.8 + pov.phase) * 2.2;
    camera.lookAt(_f);
    return true;
  }

  if (pov.kind === 'chopper') {
    const a = pov.phase + t * pov.spin;
    camera.position.set(
      focus.x + Math.cos(a) * pov.r,
      pov.h + n1(t, 0.6) * 0.5,
      focus.z + Math.sin(a) * pov.r,
    );
    _f.copy(focus);
    _f.x += n1(t, 0.45) * 1.6;
    _f.z += n1(t + 3, 0.4) * 1.6;
    camera.lookAt(_f);
    return true;
  }

  if (pov.kind === 'witness') {
    const s = pov.shake;
    camera.position.set(
      pov.pos[0] + n1(t, 1.3) * 0.05 * s,
      pov.pos[1] + n1(t + 7, 1.9) * 0.04 * s,
      pov.pos[2] + n1(t + 3, 1.1) * 0.05 * s,
    );
    // handheld: the operator over- and under-corrects while tracking
    _f.copy(focus);
    _f.x += n1(t, 2.1) * 0.9 * s;
    _f.y += n1(t + 5, 1.7) * 0.5 * s;
    _f.z += n1(t + 9, 1.9) * 0.9 * s;
    camera.lookAt(_f);
    return true;
  }
  return false;
}
