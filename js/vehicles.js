// vehicles.js — every archetype + the registry. Forward = +X, ground = y0.
import * as THREE from 'three';
import { makeRng, matFactory, slab, wedge, faceQuad, subQuad, quadPrism, panesOnQuad, box, cyl, sphere, shade, PAINT } from './lib.js';
import { stdMats, cabin, car, truckFront, chassis, van, bus, GOLD } from './families.js';
import * as P from './parts.js';
import { genName } from './names.js';

/* ================= pickups ================= */
function pickupBed(c, M, r, o = {}) {
  const { g, mats, L, W, bodyTop, cabPt } = c;
  const x0 = -L / 2 + 0.08, x1 = cabPt.x0b - 0.05;
  const floor = box(M('#2c2f34', { rough: 0.85 }), x1 - x0, 0.05, W * 0.84);
  floor.position.set((x0 + x1) / 2, bodyTop + 0.025, 0);
  g.add(floor);
  for (const s of [-1, 1]) {
    const wall = box(mats.body2, x1 - x0, 0.28, 0.09);
    wall.position.set((x0 + x1) / 2, bodyTop + 0.14, s * (W / 2 - 0.08));
    g.add(wall);
  }
  const gate = box(mats.body2, 0.07, 0.28, W * 0.82);
  gate.position.set(x0 + 0.035, bodyTop + 0.14, 0);
  g.add(gate);
  if (o.cargo !== false) {
    const kind = r.pick(['none', 'none', 'crates', 'barrels']);
    if (kind === 'crates') P.cratesLoad(g, M, { r, x0: x0 + 0.2, x1: x1 - 0.2, y: bodyTop, w: W * 0.8 });
    if (kind === 'barrels') P.barrelsLoad(g, M, { r, x0: x0 + 0.2, x1: x1 - 0.2, y: bodyTop, w: W * 0.8 });
  }
  return { x0, x1 };
}
const PICKUP_K = { L: 5.2, W: 1.98, bodyH: 0.62, clear: 0.4, wheelR: 0.42, wheelW: 0.3, cabL: 1.55, cabX: 0.62, cabH: 0.6, rakeF: 0.42, rakeR: 0.2, sideCols: 1, axInR: 1.05, tail: 0.1, tailB: 0.03 };
function buildPickup(r, M, ctx) {
  const c = car(r, M, ctx, { ...PICKUP_K, sideCols: r.pick([1, 2]), dualRear: r.chance(0.22), mudflaps: true });
  pickupBed(c, M, r);
  return c.g;
}
function buildLifted(r, M, ctx) {
  const c = car(r, M, ctx, { ...PICKUP_K, clear: 0.66, wheelR: 0.52, wheelW: 0.36, hubR: 0.45, rod: true, poke: true, mudflaps: true });
  pickupBed(c, M, r);
  P.bullbar(c.g, M, { x: c.L / 2 + 0.12, y: c.clear + 0.28, w: c.W * 0.8 });
  if (r.chance(0.6)) P.exhaustStack(c.g, M, { x: c.cabPt.x0b - 0.12, z: c.W / 2 - 0.1, y0: c.bodyTop, h: 0.85 });
  return c.g;
}
function buildMonster(r, M, ctx) {
  const wR = r.range(0.82, 0.95);
  const clear = wR + 0.62;
  const c = car(r, M, ctx, {
    ...PICKUP_K, L: 4.4, clear, wheelR: wR, wheelW: 0.62, hubR: 0.42, wheelSeg: 14,
    rod: true, trackAdd: 0.55, axInF: 0.95, axInR: 0.95, bumpers: false, stripes: true, mirrorP: 0.3,
  });
  pickupBed(c, M, r, { cargo: false });
  const dk = M('#33373d', { rough: 0.6 });
  for (const ax of [c.L / 2 - 0.95, -c.L / 2 + 0.95]) {
    for (const s of [-1, 1]) {
      const link = box(dk, 0.1, clear - wR + 0.3, 0.1);
      link.position.set(ax + (ax > 0 ? -0.25 : 0.25), (clear + wR) / 2 - 0.08, s * 0.5);
      link.rotation.x = s * 0.28;
      c.g.add(link);
    }
  }
  if (r.chance(0.6)) { // roof light pod
    for (let i = 0; i < 4; i++) {
      const lamp = cyl(M('#ffedb8', { rough: 0.25, env: 1.2, emissive: '#ffd98a', emInt: 0.6 }), { r: 0.08, len: 0.1, axis: 'x', seg: 8 });
      lamp.position.set(c.cabPt.x1t - 0.1, c.cabPt.y1 + 0.1, -0.36 + i * 0.24);
      c.g.add(lamp);
    }
  }
  return c.g;
}

/* ================= racers & fun ================= */
function buildF1(r, M, ctx) {
  const g = new THREE.Group();
  const mats = stdMats(r, M, { bodyHex: ctx.paint || r.pick(['#c22a24', '#2668bd', '#e39a26', '#2e8442', '#e6e7e9', '#e06d21', '#d97fa8']) });
  const acc = M(shade(mats.bodyHex, -0.12), { rough: 0.5 });
  g.add(slab(mats.body, { x0: -2.25, x1: 0.35, y0: 0.16, y1: 0.52, w: 0.95, wT: 0.78, tail: 0.22 }));
  g.add(wedge(mats.body, { x0: 0.35, x1: 2.3, y0: 0.2, y1: 0.5, w0: 0.82, w1: 0.26, w0T: 0.6, w1T: 0.18 }));
  for (const s of [-1, 1]) { // sidepods
    const pod = slab(acc, { x0: -1.55, x1: 0.4, y0: 0.2, y1: 0.56, w: 0.5, wT: 0.42, nose: 0.45, tail: 0.1 });
    pod.position.z = s * 0.68;
    g.add(pod);
  }
  const cock = slab(mats.body, { x0: -1.2, x1: 0.15, y0: 0.5, y1: 0.84, w: 0.6, wT: 0.38, nose: 0.62, tail: 0.12 });
  g.add(cock);
  g.add(quadPrism(subQuad(faceQuad(cock.userData.pt, 'front'), 0.15, 0.85, 0.25, 0.9), 0.024, mats.glass, 0.012));
  const hr = box(acc, 0.34, 0.3, 0.36); hr.position.set(-1.05, 0.95, 0); g.add(hr); // headrest/airbox
  const fw = slab(acc, { x0: 2.02, x1: 2.52, y0: 0.12, y1: 0.2, w: 1.9, wT: 1.78, nose: 0.14 }); g.add(fw);
  for (const s of [-1, 1]) { const ep = box(acc, 0.5, 0.18, 0.05); ep.position.set(2.26, 0.2, s * 0.95); g.add(ep); }
  for (const s of [-1, 1]) { const post = box(acc, 0.07, 0.34, 0.06); post.position.set(-2.2, 0.72, s * 0.4); g.add(post); }
  const rw = slab(acc, { x0: -2.44, x1: -2.02, y0: 0.88, y1: 0.98, w: 1.5, wT: 1.42, nose: 0.1 }); g.add(rw);
  for (const s of [-1, 1]) { const ep = box(acc, 0.46, 0.26, 0.05); ep.position.set(-2.22, 0.98, s * 0.74); g.add(ep); }
  P.axle(g, M, { x: 1.5, track: 1.62, r: 0.33, w: 0.3, rod: true, hubR: 0.5 });
  P.axle(g, M, { x: -1.55, track: 1.66, r: 0.39, w: 0.44, rod: true, hubR: 0.5 });
  if (r.chance(0.6)) P.racingStripes(g, M, { x0: 0.4, x1: 2.2, y: 0.5, w2: 0.09, gap: 0.05, hex: r.pick(['#eceff1', '#26292e', '#e3c53a']) });
  return g;
}
function buildLeMans(r, M, ctx) {
  const g = new THREE.Group();
  const mats = stdMats(r, M, { bodyHex: ctx.paint });
  const body = slab(mats.body, { x0: -2.3, x1: 2.3, y0: 0.24, y1: 0.68, w: 2.0, wT: 1.66, nose: 0.85, tail: 0.3, noseB: 0.08 });
  g.add(body);
  cabin(g, mats, { x0: -1.15, x1: 0.55, y0: 0.66, h: 0.44, w: 1.5, wT: 0.86, rakeF: 0.78, rakeR: 0.55, sideCols: 1, mat: mats.body });
  const bpt = body.userData.pt;
  for (const s of [-1, 1]) { // pop-up style round lamps on the sloped nose
    const lamp = cyl(M('#ffedb8', { rough: 0.25, env: 1.2, emissive: '#ffd98a', emInt: 0.6 }), { r: 0.09, len: 0.12, axis: 'x', seg: 10 });
    lamp.position.set(1.92, 0.46, s * 0.6);
    lamp.rotation.z = -0.5;
    g.add(lamp);
  }
  P.taillightsOn(g, M, bpt, { v0: 0.55, v1: 0.85, w: 0.22 });
  const acc = M(shade(mats.bodyHex, -0.14), { rough: 0.5 });
  for (const s of [-1, 1]) { const post = box(acc, 0.08, 0.32, 0.07); post.position.set(-2.05, 0.82, s * 0.72); g.add(post); }
  const rw = slab(acc, { x0: -2.35, x1: -1.85, y0: 0.98, y1: 1.1, w: 2.05, wT: 1.95, nose: 0.12 }); g.add(rw);
  for (const s of [-1, 1]) { const ep = box(acc, 0.55, 0.3, 0.05); ep.position.set(-2.1, 1.1, s * 1.02); g.add(ep); }
  const fin = box(acc, 1.15, 0.26, 0.05); fin.position.set(-1.6, 0.8, 0); g.add(fin);
  const dif = box(M('#26292e', { rough: 0.7 }), 0.4, 0.18, 1.5); dif.position.set(-2.2, 0.22, 0); g.add(dif);
  P.axle(g, M, { x: 1.5, track: 1.78, r: 0.33, w: 0.32, hubR: 0.58 });
  P.axle(g, M, { x: -1.5, track: 1.78, r: 0.33, w: 0.32, hubR: 0.58 });
  if (r.chance(0.7)) P.racingStripes(g, M, { x0: -2.2, x1: 2.1, y: 0.68, hex: r.pick(['#eceff1', '#26292e', '#e3c53a']) });
  P.doorRoundels(g, M, { x: 0.85, y: 0.47, w: 1.94, r: 0.18 });
  return g;
}
function buildHotrod(r, M, ctx) {
  const g = new THREE.Group();
  const mats = stdMats(r, M, { bodyHex: ctx.paint || r.pick(['#c63d3d', '#26292e', '#e07b39', '#6c4f9e', '#a92f38']) });
  const rear = slab(mats.body, { x0: -1.95, x1: 0.3, y0: 0.5, y1: 1.05, w: 1.7, wT: 1.55, tail: 0.35, tailB: 0.18, nose: 0.05 });
  g.add(rear);
  cabin(g, mats, { x0: -1.55, x1: -0.35, y0: 1.03, h: 0.62, w: 1.6, wT: 1.4, rakeF: 0.22, rakeR: 0.12, sideCols: 1 });
  g.add(wedge(mats.body, { x0: 0.3, x1: 1.95, y0: 0.42, y1: 0.72, w0: 1.1, w1: 0.6, w0T: 0.95, w1T: 0.5, nose: 0.1 }));
  const eng = box(M('#8d939a', { rough: 0.35, metal: 0.7, env: 1.1 }), 0.72, 0.5, 0.62);
  eng.position.set(0.62, 0.95, 0); g.add(eng);
  const intake = box(M('#26292e', { rough: 0.6 }), 0.3, 0.16, 0.3); intake.position.set(0.62, 1.28, 0); g.add(intake);
  for (const s of [-1, 1]) for (let i = 0; i < 3; i++) { // zoomie pipes (rake up-and-back)
    const pipe = cyl(M('#c9ced4', { rough: 0.28, metal: 0.75, env: 1.2 }), { r: 0.05, len: 0.55, axis: 'x', seg: 8 });
    pipe.position.set(0.18 - i * 0.2, 0.92 + i * 0.05, s * 0.42);
    pipe.rotation.z = 2.35; pipe.rotation.y = s * 0.22;
    g.add(pipe);
  }
  P.taillightsOn(g, M, rear.userData.pt, { v0: 0.5, v1: 0.72, w: 0.12 });
  for (const s of [-1, 1]) { // headlamp pods
    const lamp = cyl(M('#ffedb8', { rough: 0.25, env: 1.2, emissive: '#ffd98a', emInt: 0.6 }), { r: 0.11, len: 0.16, axis: 'x', seg: 10 });
    lamp.position.set(1.72, 0.85, s * 0.5); g.add(lamp);
    const stalk = box(M('#33373d', { rough: 0.6 }), 0.06, 0.18, 0.06); stalk.position.set(1.72, 0.7, s * 0.5); g.add(stalk);
  }
  P.axle(g, M, { x: 1.55, track: 1.6, r: 0.3, w: 0.16, rod: true, hubR: 0.4 });
  P.axle(g, M, { x: -1.25, track: 2.0, r: 0.54, w: 0.46, rod: true, hubR: 0.5 });
  if (r.chance(0.5)) P.racingStripes(g, M, { x0: -1.9, x1: 0.25, y: 1.05, hex: r.pick(['#e3c53a', '#eceff1']) });
  return g;
}
function buildKart(r, M, ctx) {
  const g = new THREE.Group();
  const mats = stdMats(r, M, { bodyHex: ctx.paint });
  g.add(wedge(mats.body, { x0: -0.9, x1: 1.05, y0: 0.12, y1: 0.22, w0: 0.8, w1: 0.55, nose: 0.1 }));
  const seat = box(mats.dark, 0.4, 0.12, 0.42); seat.position.set(-0.3, 0.28, 0); g.add(seat);
  const back = slab(mats.dark, { x0: -0.52, x1: -0.32, y0: 0.22, y1: 0.75, w: 0.44, wT: 0.36, tail: 0.14 }); g.add(back);
  const engb = box(M('#8d939a', { rough: 0.35, metal: 0.6, env: 1 }), 0.32, 0.24, 0.3); engb.position.set(-0.72, 0.32, 0.12); g.add(engb);
  const col = cyl(mats.dark, { r: 0.035, len: 0.5, seg: 6 }); col.position.set(0.35, 0.42, 0); col.rotation.z = 0.5; g.add(col);
  const sw = cyl(mats.dark, { r: 0.14, len: 0.05, seg: 10 }); sw.position.set(0.24, 0.62, 0); sw.rotation.z = 0.5; g.add(sw);
  const nose = box(mats.body2 || mats.body, 0.08, 0.1, 0.6); nose.position.set(1.1, 0.22, 0); g.add(nose);
  P.axle(g, M, { x: 0.72, track: 0.95, r: 0.17, w: 0.16, rod: true, hubR: 0.45, seg: 10 });
  P.axle(g, M, { x: -0.62, track: 1.02, r: 0.18, w: 0.2, rod: true, hubR: 0.45, seg: 10 });
  return g;
}
function buildBuggy(r, M, ctx) {
  const g = new THREE.Group();
  const mats = stdMats(r, M, { bodyHex: ctx.paint });
  g.add(wedge(mats.body, { x0: -1.65, x1: 1.7, y0: 0.42, y1: 0.95, w0: 1.72, w1: 1.15, w0T: 1.55, w1T: 1.0, nose: 0.45, tail: 0.2 }));
  const ws = slab(mats.glass, { x0: 0.42, x1: 0.6, y0: 0.93, y1: 1.32, w: 1.25, wT: 1.1, nose: 0.16 }); g.add(ws);
  for (const s of [-1, 1]) {
    const seat = box(mats.dark, 0.4, 0.3, 0.42); seat.position.set(-0.25, 1.02, s * 0.38); g.add(seat);
    const bk = box(mats.dark, 0.14, 0.42, 0.42); bk.position.set(-0.5, 1.12, s * 0.38); g.add(bk);
  }
  const cage = M('#33373d', { rough: 0.5, metal: 0.3 });
  for (const hx of [0.15, -0.85]) {
    for (const s of [-1, 1]) P.post(g, M, { x: hx, z: s * 0.62, y0: 0.9, y1: 1.62, t: 0.08 });
    const top = box(cage, 0.09, 0.08, 1.32); top.position.set(hx, 1.64, 0); g.add(top);
    const rail = box(cage, 1.05, 0.08, 0.08); rail.position.set(-0.35, 1.66, 0);
    if (hx === 0.15) g.add(rail);
  }
  P.spareWheel(g, M, { x: -1.8, y: 1.05, r: 0.4, w: 0.26 });
  for (const s of [-1, 1]) { // round nose lamps
    const lamp = cyl(M('#ffedb8', { rough: 0.25, env: 1.2, emissive: '#ffd98a', emInt: 0.6 }), { r: 0.1, len: 0.1, axis: 'x', seg: 10 });
    lamp.position.set(1.62, 0.8, s * 0.4);
    g.add(lamp);
  }
  P.axle(g, M, { x: 1.15, track: 1.85, r: 0.4, w: 0.3, rod: true, hubR: 0.45 });
  P.axle(g, M, { x: -1.1, track: 1.9, r: 0.5, w: 0.38, rod: true, hubR: 0.45 });
  return g;
}
function buildJeep(r, M, ctx) {
  const g = new THREE.Group();
  const olive = ctx.army ? r.pick(['#5a6b46', '#4f5f3f', '#6b6f4a']) : null;
  const mats = stdMats(r, M, { bodyHex: ctx.paint || olive });
  const body = slab(mats.body, { x0: -1.95, x1: 1.95, y0: 0.5, y1: 1.12, w: 1.82, wT: 1.74, nose: 0.14, tail: 0.08, noseB: 0.04 });
  g.add(body);
  const bpt = body.userData.pt;
  P.grilleOn(g, M, bpt, { f0: 0.3, f1: 0.7, v0: 0.25, v1: 0.75 });
  for (const s of [-1, 1]) {
    const lamp = cyl(M('#ffedb8', { rough: 0.25, env: 1.2, emissive: '#ffd98a', emInt: 0.6 }), { r: 0.11, len: 0.06, axis: 'x', seg: 10 });
    lamp.position.set(1.97, 0.92, s * 0.55); g.add(lamp);
  }
  P.taillightsOn(g, M, bpt);
  const ws = slab(mats.glass, { x0: 0.55, x1: 0.68, y0: 1.1, y1: 1.62, w: 1.64, wT: 1.58, nose: 0.1 }); g.add(ws);
  for (const s of [-1, 1]) {
    const seat = box(mats.dark, 0.42, 0.3, 0.5); seat.position.set(0.05, 1.2, s * 0.4); g.add(seat);
    const bk = box(mats.dark, 0.14, 0.44, 0.5); bk.position.set(-0.2, 1.3, s * 0.4); g.add(bk);
  }
  const hoop = M('#2c2f34', { rough: 0.6 });
  for (const s of [-1, 1]) P.post(g, M, { x: -0.45, z: s * 0.7, y0: 1.1, y1: 1.72, t: 0.08 });
  const hb = box(hoop, 0.09, 0.08, 1.48); hb.position.set(-0.45, 1.74, 0); g.add(hb);
  if (r.chance(0.5)) { // soft top
    const roof = slab(mats.body2, { x0: -1.55, x1: 0.62, y0: 1.66, y1: 1.8, w: 1.6, wT: 1.5, nose: 0.16, tail: 0.1 });
    g.add(roof);
    for (const s of [-1, 1]) P.post(g, M, { x: -1.45, z: s * 0.68, y0: 1.1, y1: 1.68, t: 0.07 });
  }
  for (const [ax, s2] of [[1.35, 1], [-1.3, 1]]) {
    for (const s of [-1, 1]) {
      const f = slab(mats.body2, { x0: ax - 0.62, x1: ax + 0.62, y0: 0.78, y1: 0.9, w: 0.2, nose: 0.28, tail: 0.28 });
      f.position.z = s * (1.82 / 2 + 0.04); g.add(f);
    }
  }
  P.spareWheel(g, M, { x: -2.08, y: 0.85, r: 0.4, w: 0.24, hubR: 0.42 });
  if (r.chance(0.55)) P.bullbar(g, M, { x: 2.06, y: 0.75, w: 1.5 });
  if (ctx.army) { // white star disc on hood
    const star = cyl(M('#e8e9eb', { rough: 0.6 }), { r: 0.22, len: 0.02, seg: 5 });
    star.position.set(1.2, 1.13, 0); star.rotation.y = r.range(0, 1);
    g.add(star);
  }
  P.axle(g, M, { x: 1.35, track: 1.66, r: 0.44, w: 0.32, rod: true, hubR: 0.42 });
  P.axle(g, M, { x: -1.3, track: 1.66, r: 0.44, w: 0.32, rod: true, hubR: 0.42 });
  P.bumper(g, M, { x: -2.0, y: 0.62, w: 1.7, hex: '#33373d' });
  return g;
}

/* ================= small & weird ================= */
function buildTuktuk(r, M, ctx) {
  const g = new THREE.Group();
  const mats = stdMats(r, M, { bodyHex: ctx.paint || r.pick(['#e3c53a', '#3e8948', '#c63d3d', '#3a8f8a', '#e07b39']) });
  const body = wedge(mats.body, { x0: -1.05, x1: 0.95, y0: 0.3, y1: 1.0, w0: 1.5, w1: 0.62, w0T: 1.42, w1T: 0.55, nose: 0.35, tail: 0.1 });
  g.add(body);
  const ws = slab(mats.glass, { x0: 0.3, x1: 0.44, y0: 0.98, y1: 1.5, w: 0.95, wT: 0.85, nose: 0.12 }); g.add(ws);
  for (const s of [-1, 1]) P.post(g, M, { x: -0.95, z: s * 0.6, y0: 1.0, y1: 1.66, t: 0.06 });
  const roof = slab(M(r.chance(0.6) ? '#f2ead9' : mats.bodyHex, { rough: 0.6 }), { x0: -1.15, x1: 0.6, y0: 1.62, y1: 1.76, w: 1.5, wT: 1.36, nose: 0.22, tail: 0.14 });
  g.add(roof);
  const bench = box(mats.dark, 0.5, 0.24, 1.1); bench.position.set(-0.55, 1.1, 0); g.add(bench);
  const lamp = cyl(M('#ffedb8', { rough: 0.25, env: 1.2, emissive: '#ffd98a', emInt: 0.6 }), { r: 0.1, len: 0.07, axis: 'x', seg: 10 });
  lamp.position.set(0.98, 0.78, 0); g.add(lamp);
  const wh = P.wheel(M, 0.3, 0.16, { hubR: 0.45, seg: 10 }); wh.position.set(0.68, 0.3, 0); g.add(wh);
  P.axle(g, M, { x: -0.55, track: 1.4, r: 0.3, w: 0.16, hubR: 0.45, seg: 10 });
  P.bumper(g, M, { x: -1.1, y: 0.55, w: 1.35, hex: '#c9ced4' });
  return g;
}
function bikeCommon(g, M, mats, o) {
  const chrome = M('#c9ced4', { rough: 0.26, metal: 0.8, env: 1.3 });
  const fw = P.wheel(M, o.fr, o.fw, { seg: 14, hubR: 0.32 }); fw.position.set(o.fx, o.fr, 0); g.add(fw);
  const rw = P.wheel(M, o.rr, o.rw, { seg: 14, hubR: 0.32 }); rw.position.set(o.rx, o.rr, 0); g.add(rw);
  for (const s of [-1, 1]) { // fork
    const f = cyl(chrome, { r: 0.035, len: o.forkLen, seg: 6 });
    f.position.set(o.fx - o.forkLen * Math.sin(o.forkAng) / 2, o.fr + o.forkLen * Math.cos(o.forkAng) / 2, s * 0.09);
    f.rotation.z = o.forkAng;
    g.add(f);
  }
  // handlebar
  const bar = cyl(chrome, { r: 0.03, len: 0.52, axis: 'z', seg: 6 });
  bar.position.set(o.fx - o.forkLen * Math.sin(o.forkAng), o.fr + o.forkLen * Math.cos(o.forkAng) + 0.05, 0);
  g.add(bar);
  return chrome;
}
function buildMoto(r, M, ctx) {
  const g = new THREE.Group();
  const mats = stdMats(r, M, { bodyHex: ctx.paint });
  const chrome = bikeCommon(g, M, mats, { fr: 0.3, fw: 0.1, fx: 0.78, rr: 0.31, rw: 0.15, rx: -0.62, forkLen: 0.52, forkAng: 0.42 });
  const eng = box(M('#4a4e55', { rough: 0.4, metal: 0.5, env: 1 }), 0.5, 0.32, 0.3); eng.position.set(0.02, 0.42, 0); g.add(eng);
  g.add(wedge(mats.body, { x0: -0.12, x1: 0.5, y0: 0.6, y1: 0.88, w0: 0.36, w1: 0.16, nose: 0.2 })); // tank
  g.add(wedge(mats.body, { x0: 0.42, x1: 0.72, y0: 0.5, y1: 0.78, w0: 0.3, w1: 0.2 })); // front cowl
  const seat = box(mats.dark, 0.5, 0.1, 0.28); seat.position.set(-0.42, 0.68, 0); g.add(seat);
  g.add(wedge(mats.body, { x0: -0.95, x1: -0.6, y0: 0.66, y1: 0.85, w0: 0.1, w1: 0.28 })); // tail
  const ex = cyl(chrome, { r: 0.05, len: 0.62, axis: 'x', seg: 8 }); ex.position.set(-0.45, 0.32, 0.16); ex.rotation.y = -0.08; g.add(ex);
  const lamp = box(M('#ffedb8', { rough: 0.25, emissive: '#ffd98a', emInt: 0.6, env: 1.2 }), 0.05, 0.12, 0.12); lamp.position.set(0.76, 0.68, 0); g.add(lamp);
  return g;
}
function buildChopper(r, M, ctx) {
  const g = new THREE.Group();
  const mats = stdMats(r, M, { bodyHex: ctx.paint || r.pick(['#26292e', '#a92f38', '#6c4f9e', '#2b3a55', '#c63d3d']) });
  const chrome = bikeCommon(g, M, mats, { fr: 0.27, fw: 0.08, fx: 1.05, rr: 0.33, rw: 0.24, rx: -0.6, forkLen: 0.95, forkAng: 0.72 });
  const eng = box(M('#8d939a', { rough: 0.32, metal: 0.7, env: 1.2 }), 0.46, 0.34, 0.3); eng.position.set(-0.05, 0.4, 0); g.add(eng);
  g.add(wedge(mats.body, { x0: -0.25, x1: 0.42, y0: 0.56, y1: 0.82, w0: 0.34, w1: 0.12, nose: 0.24 })); // teardrop tank
  const seat = box(mats.dark, 0.44, 0.08, 0.3); seat.position.set(-0.55, 0.58, 0); g.add(seat);
  const fender = slab(mats.body, { x0: -0.85, x1: -0.32, y0: 0.62, y1: 0.72, w: 0.3, nose: 0.14, tail: 0.14 }); g.add(fender);
  for (const s of [-1, 1]) { // ape hangers
    const riser = cyl(chrome, { r: 0.025, len: 0.42, seg: 6 });
    riser.position.set(0.42, 1.12, s * 0.16); g.add(riser);
  }
  const ex = cyl(chrome, { r: 0.045, len: 0.85, axis: 'x', seg: 8 }); ex.position.set(-0.35, 0.3, 0.17); ex.rotation.y = -0.06; g.add(ex);
  const lamp = cyl(M('#ffedb8', { rough: 0.25, emissive: '#ffd98a', emInt: 0.6, env: 1.2 }), { r: 0.08, len: 0.09, axis: 'x', seg: 8 });
  lamp.position.set(0.82, 0.75, 0); g.add(lamp);
  return g;
}
function buildTractor(r, M, ctx) {
  const g = new THREE.Group();
  const mats = stdMats(r, M, { bodyHex: ctx.paint || r.pick(['#c22a24', '#2e8442', '#2668bd', '#e06d21', '#dfbd25']) });
  const hub = r.chance(0.6) ? '#dfbd25' : '#c9ced4';
  const hood = slab(mats.body, { x0: 0.1, x1: 1.95, y0: 0.72, y1: 1.42, w: 0.82, wT: 0.72, nose: 0.2, noseB: 0.05 });
  g.add(hood);
  P.grilleOn(g, M, hood.userData.pt, { f0: 0.25, f1: 0.75, v0: 0.2, v1: 0.75 });
  P.headlightsOn(g, M, hood.userData.pt, { v0: 0.55, v1: 0.8, w: 0.16, edge: 0.06 });
  g.add(slab(mats.body, { x0: -0.9, x1: 0.2, y0: 0.62, y1: 1.05, w: 0.95 }));
  const seat = box(mats.dark, 0.4, 0.14, 0.44); seat.position.set(-0.5, 1.14, 0); g.add(seat);
  const sb = box(mats.dark, 0.12, 0.4, 0.44); sb.position.set(-0.72, 1.32, 0); g.add(sb);
  const col = cyl(mats.dark, { r: 0.03, len: 0.4, seg: 6 }); col.position.set(-0.05, 1.22, 0); col.rotation.z = 0.5; g.add(col);
  const sw = cyl(mats.dark, { r: 0.14, len: 0.04, seg: 10 }); sw.position.set(-0.14, 1.38, 0); sw.rotation.z = 0.5; g.add(sw);
  for (const s of [-1, 1]) { // rear fenders
    const f = slab(mats.body2, { x0: -1.5, x1: -0.1, y0: 1.55, y1: 1.72, w: 0.5, nose: 0.4, tail: 0.4 });
    f.position.z = s * 0.85; g.add(f);
  }
  if (r.chance(0.7)) { // canopy
    for (const [px, pz] of [[0.15, 0.42], [0.15, -0.42], [-0.85, 0.42], [-0.85, -0.42]]) P.post(g, M, { x: px, z: pz, y0: pz > 0 ? 1.05 : 1.05, y1: 2.1, t: 0.06 });
    g.add(slab(mats.body2, { x0: -1.05, x1: 0.35, y0: 2.1, y1: 2.2, w: 1.05, wT: 0.95, nose: 0.12, tail: 0.12 }));
  }
  P.exhaustStack(g, M, { x: 0.6, z: 0.24, y0: 1.42, h: 0.75 });
  P.axle(g, M, { x: -0.85, track: 1.75, r: 0.82, w: 0.5, rod: true, hubR: 0.52, hub, seg: 14 });
  P.axle(g, M, { x: 1.42, track: 1.15, r: 0.4, w: 0.26, rod: true, hubR: 0.45, hub });
  P.towHitch(g, M, -1.75, 0.55);
  return g;
}
function buildForklift(r, M, ctx) {
  const g = new THREE.Group();
  const mats = stdMats(r, M, { bodyHex: ctx.paint || r.pick(['#e3c53a', '#e07b39', '#c63d3d']) });
  g.add(slab(mats.body, { x0: -0.9, x1: 0.78, y0: 0.28, y1: 0.95, w: 1.18, wT: 1.08, nose: 0.14, tail: 0.06 }));
  const cw = box(mats.dark, 0.42, 0.55, 1.1); cw.position.set(-1.05, 0.62, 0); g.add(cw);
  const seat = box(mats.dark, 0.36, 0.12, 0.4); seat.position.set(-0.25, 1.02, 0); g.add(seat);
  const sb = box(mats.dark, 0.1, 0.34, 0.4); sb.position.set(-0.45, 1.2, 0); g.add(sb);
  for (const [px, pz] of [[0.55, 0.48], [0.55, -0.48], [-0.75, 0.48], [-0.75, -0.48]]) P.post(g, M, { x: px, z: pz, y0: 0.95, y1: 1.98, t: 0.07 });
  g.add(slab(mats.body2, { x0: -0.95, x1: 0.75, y0: 1.98, y1: 2.06, w: 1.15, nose: 0.1, tail: 0.1 }));
  const mastM = M('#33373d', { rough: 0.55 });
  for (const s of [-1, 1]) { const rail = box(mastM, 0.1, 1.95, 0.09); rail.position.set(0.95, 1.08, s * 0.3); g.add(rail); }
  for (const yy of [0.6, 1.2, 1.8]) { const cross = box(mastM, 0.08, 0.09, 0.66); cross.position.set(0.95, yy, 0); g.add(cross); }
  const fkM = M('#9aa0a7', { rough: 0.4, metal: 0.6, env: 1 });
  for (const s of [-1, 1]) {
    const vert = box(fkM, 0.06, 0.5, 0.12); vert.position.set(1.04, 0.42, s * 0.26); g.add(vert);
    const fork = box(fkM, 0.85, 0.06, 0.12); fork.position.set(1.48, 0.15, s * 0.26); g.add(fork);
  }
  P.beacon(g, M, { x: -0.1, y: 2.06 });
  P.axle(g, M, { x: 0.42, track: 1.22, r: 0.3, w: 0.24, hubR: 0.5, seg: 10 });
  P.axle(g, M, { x: -0.62, track: 1.05, r: 0.25, w: 0.2, hubR: 0.5, seg: 10 });
  return g;
}
function buildGolfcart(r, M, ctx) {
  const g = new THREE.Group();
  const mats = stdMats(r, M, { bodyHex: ctx.paint || r.pick(['#e8e9eb', '#3e8948', '#7fb2d9', '#efe3c8', '#dd8fb4']) });
  g.add(slab(mats.body, { x0: -1.05, x1: 1.1, y0: 0.28, y1: 0.52, w: 1.2, nose: 0.1, tail: 0.1 }));
  g.add(wedge(mats.body, { x0: 0.55, x1: 1.1, y0: 0.52, y1: 0.8, w0: 1.15, w1: 0.95, w0T: 1.05, w1T: 0.85, nose: 0.16 }));
  const seat = box(M('#f2ead9', { rough: 0.7 }), 0.5, 0.16, 1.05); seat.position.set(-0.35, 0.62, 0); g.add(seat);
  const sb = box(M('#f2ead9', { rough: 0.7 }), 0.14, 0.42, 1.05); sb.position.set(-0.62, 0.82, 0); g.add(sb);
  const basket = box(mats.dark, 0.5, 0.3, 0.95); basket.position.set(-0.95, 0.62, 0); g.add(basket);
  const ws = slab(mats.glass, { x0: 0.62, x1: 0.72, y0: 0.8, y1: 1.42, w: 1.05, nose: 0.06 }); g.add(ws);
  for (const [px, pz] of [[0.68, 0.5], [0.68, -0.5], [-0.6, 0.5], [-0.6, -0.5]]) P.post(g, M, { x: px, z: pz, y0: px > 0 ? 0.8 : 0.55, y1: 1.62, hex: '#c9ced4', t: 0.05 });
  g.add(slab(M('#eceff1', { rough: 0.6 }), { x0: -0.95, x1: 1.0, y0: 1.62, y1: 1.72, w: 1.2, wT: 1.1, nose: 0.16, tail: 0.12 }));
  P.axle(g, M, { x: 0.68, track: 1.1, r: 0.24, w: 0.18, hubR: 0.5, seg: 10 });
  P.axle(g, M, { x: -0.6, track: 1.1, r: 0.24, w: 0.18, hubR: 0.5, seg: 10 });
  return g;
}

/* ================= rigid trucks ================= */
function boxBed(t, M, r, x0, x1, o = {}) {
  const hex = o.hex || (r.chance(0.55) ? '#e8e9eb' : t.mats.bodyHex);
  const mat = M(hex, { rough: 0.6 });
  const b = slab(mat, { x0, x1, y0: t.clear + 0.32, y1: t.clear + 0.32 + (o.h || 1.85), w: t.W + 0.06, wT: (t.W + 0.06) * 0.94, nose: 0.05, tail: 0.05 });
  t.g.add(b);
  const pt = b.userData.pt;
  t.g.add(quadPrism(subQuad(faceQuad(pt, 'rear'), 0.06, 0.94, 0.04, 0.92), 0.02, M(shade(hex, -0.07), { rough: 0.6 }), 0.008));
  const seam = box(M('#33373d', { rough: 0.7 }), 0.02, (o.h || 1.85) * 0.85, 0.03);
  seam.position.set(x0 - 0.04, t.clear + 0.32 + (o.h || 1.85) / 2, 0);
  t.g.add(seam);
  if (o.stripeHex) P.sideStripe(t.g, M, { x0: x0 + 0.2, x1: x1 - 0.2, y: t.clear + 0.85, w: t.W + 0.06, hex: o.stripeHex, h: 0.3 });
  return pt;
}
function flatBed(t, M, r, x0, x1, cargo) {
  const mat = M('#5c6167', { rough: 0.7 });
  t.g.add(slab(mat, { x0, x1, y0: t.clear + 0.26, y1: t.clear + 0.46, w: t.W + 0.04 }));
  const hb = slab(mat, { x0: x1 - 0.08, x1: x1 + 0.04, y0: t.clear + 0.46, y1: t.clear + 1.05, w: t.W - 0.1, wT: (t.W - 0.1) * 0.9 });
  t.g.add(hb);
  const kind = cargo || r.pick(['logs', 'crates', 'barrels', 'none']);
  if (kind === 'logs') {
    for (const xx of [x0 + 0.5, x1 - 0.5]) for (const s of [-1, 1]) P.post(t.g, M, { x: xx, z: s * (t.W / 2 - 0.08), y0: t.clear + 0.46, y1: t.clear + 1.55, t: 0.09 });
    P.logsLoad(t.g, M, { x0: x0 + 0.15, x1: x1 - 0.15, y: t.clear + 0.46, w: t.W });
  }
  if (kind === 'crates') P.cratesLoad(t.g, M, { r, x0: x0 + 0.3, x1: x1 - 0.3, y: t.clear + 0.46, w: t.W - 0.3 });
  if (kind === 'barrels') P.barrelsLoad(t.g, M, { r, x0: x0 + 0.3, x1: x1 - 0.3, y: t.clear + 0.46, w: t.W - 0.3 });
}
function tankBed(t, M, r, x0, x1) {
  const mat = M(r.pick(['#c9ced4', '#b9bec4', '#e3c53a', '#e8e9eb']), { rough: 0.28, metal: 0.55, env: 1.2 });
  t.g.add(slab(M('#33373d', { rough: 0.7 }), { x0, x1, y0: t.clear + 0.24, y1: t.clear + 0.42, w: t.W * 0.8 }));
  const R = 0.8, len = x1 - x0 - 0.3;
  const tank = cyl(mat, { r: R, len, axis: 'x', seg: 12 });
  tank.position.set((x0 + x1) / 2, t.clear + 0.42 + R, 0);
  t.g.add(tank);
  for (const s of [-1, 1]) {
    const cap = cyl(M('#8d939a', { rough: 0.3, metal: 0.6, env: 1.1 }), { r: R * 0.94, len: 0.12, axis: 'x', seg: 12 });
    cap.position.set((x0 + x1) / 2 + s * len / 2, t.clear + 0.42 + R, 0);
    t.g.add(cap);
  }
  for (let i = 0; i < 2; i++) {
    const hatch = cyl(M('#8d939a', { rough: 0.3, metal: 0.6, env: 1 }), { r: 0.16, len: 0.12, seg: 8 });
    hatch.position.set(x0 + 0.8 + i * (len - 1.4), t.clear + 0.42 + R * 2, 0);
    t.g.add(hatch);
  }
}
function dumpBed(t, M, r, x0, x1) {
  const hex = r.chance(0.5) ? '#9aa0a7' : shade(t.mats.bodyHex, -0.05);
  const mat = M(hex, { rough: 0.5, metal: 0.25 });
  const dk = M(shade(hex, -0.12), { rough: 0.6 });
  t.g.add(slab(mat, { x0, x1, y0: t.clear + 0.3, y1: t.clear + 0.52, w: t.W }));
  for (const s of [-1, 1]) {
    const wall = box(mat, x1 - x0, 0.62, 0.09);
    wall.position.set((x0 + x1) / 2, t.clear + 0.82, s * (t.W / 2 - 0.05));
    t.g.add(wall);
    for (let i = 0; i < 3; i++) {
      const rib = box(dk, 0.09, 0.66, 0.05);
      rib.position.set(x0 + 0.3 + i * ((x1 - x0 - 0.6) / 2), t.clear + 0.84, s * (t.W / 2 + 0.01));
      t.g.add(rib);
    }
  }
  const shield = slab(mat, { x0: x1 - 0.1, x1: x1 + 0.25, y0: t.clear + 0.52, y1: t.clear + 1.6, w: t.W, nose: 0.18 });
  t.g.add(shield);
  const gate = box(mat, 0.08, 0.62, t.W - 0.12);
  gate.position.set(x0 + 0.04, t.clear + 0.82, 0);
  t.g.add(gate);
}
function mixerBed(t, M, r, x0, x1) {
  const hex = r.pick(['#e8e9eb', '#e3c53a', '#e07b39', '#b9bec4']);
  const mat = M(hex, { rough: 0.45 });
  const mid = (x0 + x1) / 2;
  t.g.add(slab(M('#33373d', { rough: 0.7 }), { x0, x1, y0: t.clear + 0.24, y1: t.clear + 0.44, w: t.W * 0.8 }));
  // cyl(axis:'x') already sets rotation.z = -PI/2; the tilt must ADD to that, not replace it
  const tilt = 0.15;
  const drum = cyl(mat, { r: 0.5, r2: 0.78, len: 2.1, axis: 'x', seg: 12 });
  drum.position.set(mid + 0.15, t.clear + 1.35, 0);
  drum.rotation.z = -Math.PI / 2 - tilt;
  t.g.add(drum);
  const tail = cyl(mat, { r: 0.22, r2: 0.5, len: 0.5, axis: 'x', seg: 12 });
  tail.position.set(mid - 1.12, t.clear + 1.35 + 0.19, 0);
  tail.rotation.z = -Math.PI / 2 - tilt;
  t.g.add(tail);
  const hoopM = M(shade(hex, -0.18), { rough: 0.5 });
  for (const [hx, hr] of [[mid - 0.45, 0.62], [mid + 0.55, 0.74]]) {
    const hoop = cyl(hoopM, { r: hr, len: 0.09, axis: 'x', seg: 12 });
    hoop.position.set(hx, t.clear + 1.35 - (hx - (mid + 0.15)) * tilt, 0);
    hoop.rotation.z = -Math.PI / 2 - tilt;
    t.g.add(hoop);
  }
  const frameF = box(M('#33373d', { rough: 0.6 }), 0.3, 0.9, 0.7);
  frameF.position.set(x1 - 0.3, t.clear + 0.85, 0);
  t.g.add(frameF);
  const frameR = box(M('#33373d', { rough: 0.6 }), 0.3, 1.2, 0.7);
  frameR.position.set(x0 + 0.35, t.clear + 0.95, 0);
  t.g.add(frameR);
  const chute = wedge(M('#8d939a', { rough: 0.4, metal: 0.5 }), { x0: x0 - 0.45, x1: x0 + 0.2, y0: t.clear + 1.5, y1: t.clear + 1.66, w0: 0.2, w1: 0.4 });
  t.g.add(chute);
}
function garbageBed(t, M, r, x0, x1) {
  const hex = t.mats.bodyHex;
  const mat = M(hex, { rough: 0.55 });
  const body = slab(mat, { x0: x0 + 0.7, x1, y0: t.clear + 0.3, y1: t.clear + 2.0, w: t.W + 0.04, wT: (t.W + 0.04) * 0.76, nose: 0.12, tail: 0.35 });
  t.g.add(body);
  const hopper = slab(M(shade(hex, -0.1), { rough: 0.6 }), { x0, x1: x0 + 0.8, y0: t.clear + 0.42, y1: t.clear + 1.6, w: t.W * 0.94, wT: t.W * 0.6, tail: 0.5 });
  t.g.add(hopper);
  P.sideStripe(t.g, M, { x0: x0 + 0.85, x1: x1 - 0.15, y: t.clear + 1.0, w: t.W + 0.04, hex: r.pick(['#e3c53a', '#e8e9eb']), h: 0.2 });
}
function towBed(t, M, r, x0, x1) {
  const mat = M('#5c6167', { rough: 0.6 });
  t.g.add(slab(mat, { x0, x1, y0: t.clear + 0.26, y1: t.clear + 0.46, w: t.W, tailB: 0.3 }));
  const winch = box(M('#33373d', { rough: 0.6 }), 0.5, 0.4, 0.8);
  winch.position.set(x1 - 0.35, t.clear + 0.66, 0);
  t.g.add(winch);
  const boom = box(M(t.mats.bodyHex, { rough: 0.5 }), 2.3, 0.16, 0.16);
  boom.position.set(x0 + 1.0, t.clear + 1.05, 0);
  boom.rotation.z = 0.3;
  t.g.add(boom);
  const hookM = M('#c9ced4', { rough: 0.3, metal: 0.7, env: 1.1 });
  const cable = box(M('#26292e', { rough: 0.8 }), 0.03, 0.5, 0.03);
  cable.position.set(x0 + 0.02, t.clear + 1.15, 0);
  t.g.add(cable);
  const hook = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.03, 6, 10), hookM);
  hook.castShadow = true;
  hook.position.set(x0 + 0.02, t.clear + 0.85, 0);
  t.g.add(hook);
}
function fireBody(t, M, r, x0, x1) {
  const mat = t.mats.body;
  const b = slab(mat, { x0, x1, y0: t.clear + 0.28, y1: t.clear + 1.55, w: t.W, wT: t.W * 0.92, nose: 0.06, tail: 0.08 });
  t.g.add(b);
  const pt = b.userData.pt;
  for (const s of ['left', 'right']) {
    t.g.add(panesOnQuad(faceQuad(pt, s), M('#c9ced4', { rough: 0.3, metal: 0.6, env: 1.1 }), { cols: 3, gap: 0.05, f0: 0.08, f1: 0.92, v0: 0.16, v1: 0.82, t: 0.02 }));
  }
  P.ladderRack(t.g, M, { x: (x0 + x1) / 2 - 0.2, y: t.clear + 1.78, len: x1 - x0 + 0.7, tilt: -0.05 });
  P.beacon(t.g, M, { x: x1 - 0.4, y: t.clear + 1.55, hex: '#e04338', z: 0.5 });
  P.beacon(t.g, M, { x: x1 - 0.4, y: t.clear + 1.55, hex: '#e04338', z: -0.5 });
  const step = box(M('#9aa0a7', { rough: 0.4, metal: 0.4 }), 0.35, 0.12, t.W * 0.85);
  step.position.set(x0 - 0.2, t.clear + 0.2, 0);
  t.g.add(step);
}
function armyBed(t, M, r, x0, x1) {
  const olive = M(shade(t.mats.bodyHex, -0.04), { rough: 0.8 });
  const canvas = M(shade(t.mats.bodyHex, -0.1, -0.05), { rough: 0.92 });
  t.g.add(slab(olive, { x0, x1, y0: t.clear + 0.28, y1: t.clear + 0.85, w: t.W }));
  t.g.add(slab(canvas, { x0: x0 + 0.05, x1: x1 - 0.05, y0: t.clear + 0.85, y1: t.clear + 1.75, w: t.W - 0.12, wT: (t.W - 0.12) * 0.55, nose: 0.1, tail: 0.1 }));
}
function plowBlade(t, M) {
  const bm = M('#e3c53a', { rough: 0.45, metal: 0.2 });
  const bg = new THREE.Group();
  const lower = box(bm, 0.14, 0.5, 2.9);
  lower.position.y = 0.25;
  bg.add(lower);
  const upper = box(bm, 0.14, 0.5, 2.9);
  upper.position.set(-0.09, 0.68, 0);
  upper.rotation.z = 0.42;
  bg.add(upper);
  bg.position.set(t.x1 + 0.6, 0.12, 0);
  bg.rotation.y = 0.2;
  t.g.add(bg);
  for (const s of [-1, 1]) {
    const arm = box(M('#33373d', { rough: 0.6 }), 0.8, 0.1, 0.1);
    arm.position.set(t.x1 + 0.25, 0.55, s * 0.5);
    t.g.add(arm);
  }
}
function rigidTruck(r, M, ctx, kind, o = {}) {
  const t = truckFront(r, M, ctx, {
    nose: o.nose !== undefined ? o.nose : (r.chance(0.4) ? r.range(0.9, 1.2) : 0),
    paintHex: o.paintHex, W: o.W || 2.35, cabH: o.cabH, beaconHex: o.beacon, stacks: o.stacks,
  });
  const bedL = r.jitter(o.bedL || 4.3, 0.08);
  const x1 = t.cabRearX - 0.14, x0 = x1 - bedL;
  chassis(t, M, x0 + 0.15, { axles: o.axles || (bedL > 4.4 ? 2 : 1), dual: true });
  kind(t, M, r, x0, x1);
  P.taillightsOn(t.g, M, { x0b: x0, x1b: x1, x0t: x0, x1t: x1, zb: t.W, zt: t.W, y0: t.clear + 0.3, y1: t.clear + 0.9 });
  P.bumper(t.g, M, { x: x0 - 0.06, y: t.clear + 0.05, w: t.W * 0.9, hex: '#33373d' });
  return t.g;
}

/* ================= semi + trailers ================= */
function boxTrailer(r, M, g, x1, o = {}) {
  const Lt = r.jitter(7.6, 0.05), hex = o.hex || r.pick(['#e8e9eb', '#e8e9eb', '#c63d3d', '#3a76c4', '#3e8948', '#e07b39', '#efe3c8']);
  const mat = M(hex, { rough: 0.6 });
  const b = slab(mat, { x0: x1 - Lt, x1, y0: 1.12, y1: 3.2, w: 2.45, wT: 2.45 * 0.96, nose: 0.05, tail: 0.05 });
  g.add(b);
  g.add(quadPrism(subQuad(faceQuad(b.userData.pt, 'rear'), 0.05, 0.95, 0.03, 0.95), 0.02, M(shade(hex, -0.08), { rough: 0.6 }), 0.008));
  const rail = box(M('#2c2f34', { rough: 0.8 }), Lt * 0.9, 0.25, 1.4);
  rail.position.set(x1 - Lt / 2, 0.98, 0);
  g.add(rail);
  if (r.chance(0.5)) P.sideStripe(g, M, { x0: x1 - Lt + 0.3, x1: x1 - 0.3, y: 1.75, w: 2.45, hex: r.pick(['#c63d3d', '#3a76c4', '#e3c53a', '#26292e']), h: 0.34 });
  return Lt;
}
function tankTrailer(r, M, g, x1) {
  const Lt = 7.2;
  const mat = M(r.pick(['#c9ced4', '#e8e9eb', '#b9bec4', '#e3c53a']), { rough: 0.26, metal: 0.55, env: 1.25 });
  const rail = box(M('#2c2f34', { rough: 0.8 }), Lt * 0.9, 0.3, 1.3);
  rail.position.set(x1 - Lt / 2, 1.0, 0);
  g.add(rail);
  const R = 1.02;
  const tank = cyl(mat, { r: R, len: Lt - 0.5, axis: 'x', seg: 14 });
  tank.position.set(x1 - Lt / 2, 1.15 + R, 0);
  g.add(tank);
  for (const s of [-1, 1]) {
    const cap = cyl(M('#8d939a', { rough: 0.3, metal: 0.6, env: 1.1 }), { r: R * 0.93, len: 0.14, axis: 'x', seg: 14 });
    cap.position.set(x1 - Lt / 2 + s * (Lt - 0.5) / 2, 1.15 + R, 0);
    g.add(cap);
  }
  for (let i = 0; i < 3; i++) {
    const hatch = cyl(M('#8d939a', { rough: 0.3, metal: 0.6 }), { r: 0.17, len: 0.14, seg: 8 });
    hatch.position.set(x1 - 1.2 - i * 2.2, 1.15 + R * 2, 0);
    g.add(hatch);
  }
  return Lt;
}
function flatTrailer(r, M, g, x1, cargo) {
  const Lt = 7.4;
  const mat = M('#5c6167', { rough: 0.7 });
  g.add(slab(mat, { x0: x1 - Lt, x1, y0: 1.05, y1: 1.3, w: 2.45 }));
  const rail = box(M('#2c2f34', { rough: 0.8 }), Lt * 0.85, 0.22, 1.3);
  rail.position.set(x1 - Lt / 2, 0.95, 0);
  g.add(rail);
  if (cargo === 'logs') {
    for (const xx of [x1 - 0.6, x1 - Lt / 2, x1 - Lt + 0.6]) for (const s of [-1, 1]) P.post(g, M, { x: xx, z: s * 1.1, y0: 1.3, y1: 2.7, t: 0.1 });
    P.logsLoad(g, M, { x0: x1 - Lt + 0.2, x1: x1 - 0.2, y: 1.3, w: 2.3 });
  } else {
    P.cratesLoad(g, M, { r, x0: x1 - Lt + 0.5, x1: x1 - 0.5, y: 1.3, w: 2.1 });
    P.barrelsLoad(g, M, { r, x0: x1 - Lt + 0.5, x1: x1 - 0.5, y: 1.3, w: 2.1 });
  }
  return Lt;
}
function trailerAxles(M, g, xRear) {
  for (let i = 0; i < 2; i++) P.axle(g, M, { x: xRear + 0.6 + i * 1.15, track: 2.1, r: 0.5, w: 0.32, dual: true, hubR: 0.5 });
  for (const s of [-1, 1]) { // legs
    const leg = box(M('#8d939a', { rough: 0.4, metal: 0.5 }), 0.1, 0.95, 0.1);
    leg.position.set(xRear + 5.6, 0.5, s * 0.7);
    g.add(leg);
  }
}
function semi(r, M, ctx, trailerKind) {
  const t = truckFront(r, M, ctx, {
    nose: r.chance(0.7) ? r.range(1.0, 1.35) : 0, W: 2.4, cabH: 1.9, cabL: 1.85, stacks: true, x1: 2.9,
  });
  const hasSleeper = r.chance(0.65);
  if (hasSleeper) {
    t.g.add(slab(t.mats.body, { x0: t.cabRearX - 0.85, x1: t.cabRearX + 0.03, y0: t.clear, y1: t.clear + 1.72, w: 2.3, wT: 2.1, tail: 0.1 }));
  }
  chassis(t, M, t.cabRearX - 2.9, { axles: 2 });
  const fw = cyl(M('#33373d', { rough: 0.6 }), { r: 0.45, len: 0.1, seg: 12 });
  fw.position.set(t.cabRearX - 2.0, 1.02, 0);
  t.g.add(fw);
  const x1T = t.cabRearX - (hasSleeper ? 1.0 : 0.45); // trailer front face
  const Lt = trailerKind(r, M, t.g, x1T);
  trailerAxles(M, t.g, x1T - Lt);
  return t.g;
}

/* ================= vans / buses / rv / caravan ================= */
function buildIcecream(r, M, ctx) {
  const accent = r.pick(['#d9636f', '#d97fa8', '#5f9ecc']);
  const v = van(r, M, ctx, {
    paintHex: r.pick(['#f0dfc8', '#f2d8e2', '#efe3cf']), twoTone: true, upHex: '#fdfdfb',
    splitF: 0.48, noseCut: 0.45, L: 4.7, H: 2.0, white: true, rearWindow: false,
  });
  P.coneOnRoof(v.g, M, { x: 0.2, y: v.topY });
  const fq = faceQuad(v.bpt, 'right');
  v.g.add(quadPrism(subQuad(fq, 0.22, 0.62, 0.5, 0.82), 0.03, v.mats.glass, 0.014));
  P.awning(v.g, M, { x0: -1.35, x1: 0.35, y: v.topY - 0.1, z: v.W / 2 + 0.1, side: 1, colors: [accent, '#f7f3ea'] });
  P.sideStripe(v.g, M, { x0: -v.L / 2 + 0.2, x1: v.L / 2 - 0.4, y: v.clear + 0.55, w: v.W, hex: accent, h: 0.16 });
  return v.g;
}
function buildFoodtruck(r, M, ctx) {
  const v = van(r, M, ctx, {
    paintHex: r.pick(['#e07b39', '#e3c53a', '#3a8f8a', '#c63d3d', '#7fb2d9', '#dd8fb4']),
    noseCut: 0.3, L: 5.5, H: 2.2, rearWindow: false,
  });
  const fq = faceQuad(v.bpt, 'right');
  v.g.add(quadPrism(subQuad(fq, 0.18, 0.62, 0.45, 0.8), 0.03, v.mats.glass, 0.014));
  P.awning(v.g, M, { x0: -1.6, x1: 0.6, y: v.topY - 0.25, z: v.W / 2 + 0.1, side: 1, colors: ['#f7f3ea', shade(v.mats.bodyHex, -0.12)] });
  const vent = cyl(M('#9aa0a7', { rough: 0.4, metal: 0.5 }), { r: 0.14, len: 0.3, seg: 8 });
  vent.position.set(-1.6, v.topY + 0.15, 0.3);
  v.g.add(vent);
  P.roofAC(v.g, M, { x: 0.8, y: v.topY, z: -0.3 });
  P.sideStripe(v.g, M, { x0: -v.L / 2 + 0.2, x1: v.L / 2 - 0.5, y: v.clear + 0.5, w: v.W, hex: '#f7f3ea', h: 0.16 });
  return v.g;
}
function buildAmbulance(r, M, ctx) {
  const v = van(r, M, ctx, { paintHex: '#eef0f2', H: 2.1, L: 5.1, noseCut: 0.5, stripeHex: '#c9302c', stripeF: 0.3, stripeH: 0.18 });
  P.lightbar(v.g, M, { x: v.L / 2 - 0.9, y: v.topY, w: v.W * 0.6 });
  const red = M('#c9302c', { rough: 0.5 });
  for (const s of [-1, 1]) {
    const c1 = box(red, 0.4, 0.12, 0.03), c2 = box(red, 0.12, 0.4, 0.03);
    for (const c of [c1, c2]) c.position.set(-0.5, v.clear + v.H * 0.62, s * (v.W / 2 + 0.01));
    v.g.add(c1); v.g.add(c2);
  }
  return v.g;
}
function buildRV(r, M, ctx) {
  const g = new THREE.Group();
  const mats = stdMats(r, M, { bodyHex: ctx.paint || r.pick(['#efe9dc', '#e8e9eb', '#f2ead9']) });
  const L = 6.9, W = 2.28, H = 2.25, clear = 0.42;
  const body = slab(mats.body, { x0: -L / 2, x1: L / 2, y0: clear, y1: clear + H, w: W, wT: W * 0.9, nose: 0.3, tail: 0.2, noseB: 0.08 });
  g.add(body);
  const bpt = body.userData.pt;
  const cab = slab(mats.body, { x0: L / 2 - 1.7, x1: L / 2 + 0.45, y0: clear + H - 0.75, y1: clear + H + 0.15, w: W, wT: W * 0.88, nose: 0.4 });
  g.add(cab); // over-cab bunk
  g.add(quadPrism(subQuad(faceQuad(bpt, 'front'), 0.08, 0.92, 0.5, 0.82), 0.028, mats.glass, 0.014));
  g.add(quadPrism(subQuad(faceQuad(cab.userData.pt, 'front'), 0.2, 0.8, 0.3, 0.75), 0.024, mats.glass, 0.012));
  for (const s of ['left', 'right']) {
    g.add(panesOnQuad(faceQuad(bpt, s), mats.glass, { cols: 3, f0: 0.1, f1: 0.66, v0: 0.55, v1: 0.8 }));
  }
  const accent = r.pick(['#c63d3d', '#3a76c4', '#e07b39', '#3a8f8a']);
  P.sideStripe(g, M, { x0: -L / 2 + 0.2, x1: L / 2 - 0.2, y: clear + H * 0.42, w: W, hex: accent, h: 0.16 });
  P.sideStripe(g, M, { x0: -L / 2 + 0.5, x1: L / 2 - 0.8, y: clear + H * 0.28, w: W, hex: shade(accent, -0.1), h: 0.09 });
  P.headlightsOn(g, M, bpt, { v0: 0.24, v1: 0.36, w: 0.1 });
  P.taillightsOn(g, M, bpt, { v0: 0.24, v1: 0.42, w: 0.07 });
  P.grilleOn(g, M, bpt, { f0: 0.36, f1: 0.64, v0: 0.12, v1: 0.24 });
  P.bumper(g, M, { x: L / 2 + 0.03, y: clear + 0.1, w: W * 0.94 });
  P.bumper(g, M, { x: -L / 2 - 0.03, y: clear + 0.1, w: W * 0.94 });
  P.roofAC(g, M, { x: -0.6, y: clear + H });
  P.axle(g, M, { x: L / 2 - 1.05, track: W - 0.3, r: 0.42, w: 0.3 });
  P.axle(g, M, { x: -L / 2 + 1.5, track: W - 0.3, r: 0.42, w: 0.3, dual: true });
  return g;
}
function caravanTrailer(r, M) {
  const g = new THREE.Group();
  const hex = r.pick(['#f2ead9', '#e8e9eb', '#efe9dc']);
  const mats = { body2: M(shade(hex, -0.1), { rough: 0.6 }) };
  const body = slab(M(hex, { rough: 0.55 }), { x0: -1.6, x1: 1.6, y0: 0.55, y1: 2.0, w: 1.95, wT: 1.7, nose: 0.42, tail: 0.42 });
  g.add(body);
  const pt = body.userData.pt;
  const glass = M('#20303e', { rough: 0.16, metal: 0.08, env: 1.7 });
  for (const s of ['left', 'right']) {
    g.add(panesOnQuad(faceQuad(pt, s), glass, { cols: 2, f0: 0.12, f1: s === 'right' ? 0.6 : 0.88, v0: 0.45, v1: 0.78 }));
  }
  g.add(quadPrism(subQuad(faceQuad(pt, 'rear'), 0.2, 0.8, 0.45, 0.8), 0.024, glass, 0.012));
  g.add(quadPrism(subQuad(faceQuad(pt, 'front'), 0.3, 0.7, 0.45, 0.78), 0.024, glass, 0.012));
  g.add(quadPrism(subQuad(faceQuad(pt, 'right'), 0.68, 0.9, 0.04, 0.85), 0.02, mats.body2, 0.01)); // door
  const stripe = r.pick(['#c63d3d', '#3a8f8a', '#e07b39', '#3a76c4']);
  P.sideStripe(g, M, { x0: -1.45, x1: 1.45, y: 1.0, w: 1.95, hex: stripe, h: 0.12 });
  const vent = box(M('#dfe2e6', { rough: 0.6 }), 0.4, 0.1, 0.4);
  vent.position.set(0.2, 2.03, 0);
  g.add(vent);
  g.add(wedge(M('#33373d', { rough: 0.7 }), { x0: 1.55, x1: 2.4, y0: 0.52, y1: 0.65, w0: 0.55, w1: 0.1 }));
  const jockey = P.wheel(M, 0.11, 0.08, { seg: 8 });
  jockey.position.set(2.1, 0.11, 0);
  g.add(jockey);
  P.axle(g, M, { x: -0.2, track: 1.85, r: 0.33, w: 0.24, white: r.chance(0.4) });
  P.taillightsOn(g, M, pt, { v0: 0.16, v1: 0.3, w: 0.08 });
  return g;
}
function buildCaravanCombo(r, M, ctx) {
  const g = new THREE.Group();
  const c = car(r, M, ctx, { L: 4.5, cabL: 2.1, sideCols: r.pick([2, 3]) });
  c.g.position.x = 2.55;
  g.add(c.g);
  P.towHitch(c.g, M, -2.3, 0.42);
  const trailer = caravanTrailer(r, M);
  trailer.position.x = -2.15;
  g.add(trailer);
  return g;
}
function buildPickupCamper(r, M, ctx) {
  const g = new THREE.Group();
  const c = car(r, M, ctx, { ...PICKUP_K, sideCols: 1, mudflaps: true });
  pickupBed(c, M, r, { cargo: false });
  c.g.position.x = 2.9;
  g.add(c.g);
  P.towHitch(c.g, M, -2.7, 0.45);
  const trailer = caravanTrailer(r, M);
  trailer.position.x = -2.35;
  g.add(trailer);
  return g;
}
function boatTrailer(r, M) {
  const g = new THREE.Group();
  const frame = M('#4c5157', { rough: 0.6, metal: 0.3 });
  for (const s of [-1, 1]) {
    const rail = box(frame, 3.5, 0.09, 0.11);
    rail.position.set(-0.1, 0.5, s * 0.55);
    g.add(rail);
  }
  g.add(wedge(M('#33373d', { rough: 0.7 }), { x0: 1.6, x1: 2.5, y0: 0.46, y1: 0.58, w0: 1.15, w1: 0.12 }));
  const jockey = P.wheel(M, 0.1, 0.08, { seg: 8 });
  jockey.position.set(2.2, 0.1, 0);
  g.add(jockey);
  P.axle(g, M, { x: -0.55, track: 1.72, r: 0.3, w: 0.2 });
  // hull — long bow taper, flared topsides
  const hullHex = r.pick(['#e8e9eb', '#3a76c4', '#c63d3d', '#3a8f8a', '#efe3c8', '#2b3a55']);
  const hull = slab(M(hullHex, { rough: 0.4, env: 0.8 }), {
    x0: -1.65, x1: 2.0, y0: 0.6, y1: 1.18, w: 1.28, wT: 1.5, nose: 1.05, noseB: 0.5, tail: 0.06,
  });
  g.add(hull);
  const deck = M(shade(hullHex, -0.12), { rough: 0.6 });
  const cockpit = box(deck, 1.6, 0.06, 1.1);
  cockpit.position.set(-0.6, 1.18, 0);
  g.add(cockpit);
  const ws = slab(M('#1b2836', { rough: 0.3, metal: 0.05, env: 0.9 }), { x0: 0.32, x1: 0.48, y0: 1.2, y1: 1.5, w: 1.1, wT: 0.95, nose: 0.3 });
  g.add(ws);
  for (const s of [-1, 1]) { // bench seats
    const seat = box(M('#f2ead9', { rough: 0.7 }), 0.5, 0.16, 0.42);
    seat.position.set(-0.85, 1.26, s * 0.3);
    g.add(seat);
  }
  const motor = box(M('#26292e', { rough: 0.6 }), 0.3, 0.42, 0.34);
  motor.position.set(-1.85, 1.06, 0);
  g.add(motor);
  const skeg = box(M('#26292e', { rough: 0.6 }), 0.1, 0.4, 0.05);
  skeg.position.set(-1.88, 0.66, 0);
  g.add(skeg);
  P.taillightsOn(g, M, hull.userData.pt, { v0: 0.1, v1: 0.3, w: 0.08 });
  return g;
}
function buildSuvBoat(r, M, ctx) {
  const g = new THREE.Group();
  const c = car(r, M, ctx, { L: 4.75, W: 1.98, bodyH: 0.72, clear: 0.44, wheelR: 0.43, cabL: 2.6, cabX: -0.5, cabH: 0.62, rakeF: 0.4, rakeR: 0.22, sideCols: 3, roofRack: true });
  c.g.position.x = 2.85;
  g.add(c.g);
  P.towHitch(c.g, M, -2.45, 0.48);
  const b = boatTrailer(r, M);
  b.position.x = -2.15;
  g.add(b);
  return g;
}
function hayTrailer(r, M) {
  const g = new THREE.Group();
  const wood = M('#8a6a3f', { rough: 0.9 });
  const bed = box(wood, 3.3, 0.14, 1.9);
  bed.position.set(-0.1, 0.62, 0);
  g.add(bed);
  for (const s of [-1, 1]) { // slatted side rails
    for (const xx of [-1.5, -0.6, 0.3, 1.2]) P.post(g, M, { x: xx, z: s * 0.92, y0: 0.69, y1: 1.15, hex: '#6d5432', t: 0.07 });
    const rail = box(wood, 3.2, 0.07, 0.06);
    rail.position.set(-0.15, 1.12, s * 0.92);
    g.add(rail);
  }
  g.add(wedge(M('#33373d', { rough: 0.7 }), { x0: 1.5, x1: 2.35, y0: 0.5, y1: 0.62, w0: 1.0, w1: 0.12 }));
  P.axle(g, M, { x: -0.15, track: 1.8, r: 0.37, w: 0.24, hub: '#6d5432' });
  const bale = M('#d9c26a', { rough: 0.88 });
  const n = r.int(2, 3);
  for (let i = 0; i < n; i++) {
    for (const s of [-1, 1]) {
      const b = cyl(bale, { r: 0.42, len: 0.8, axis: 'z', seg: 12 });
      b.position.set(-1.35 + i * 1.15, 1.11, s * 0.45);
      g.add(b);
    }
  }
  for (let i = 0; i < n - 1; i++) { // top row
    const b = cyl(bale, { r: 0.42, len: 0.8, axis: 'z', seg: 12 });
    b.position.set(-0.78 + i * 1.15, 1.86, 0);
    g.add(b);
  }
  return g;
}
function buildTractorHay(r, M, ctx) {
  const g = new THREE.Group();
  const t = buildTractor(r, M, ctx);
  t.position.x = 2.35;
  g.add(t);
  const tr = hayTrailer(r, M);
  tr.position.x = -1.75;
  g.add(tr);
  return g;
}
function buildRoadTrain(r, M, ctx) {
  const t = truckFront(r, M, ctx, { nose: r.range(1.0, 1.35), W: 2.4, cabH: 1.9, cabL: 1.85, stacks: true, x1: 2.9 });
  chassis(t, M, t.cabRearX - 2.9, { axles: 2 });
  const fw = cyl(M('#33373d', { rough: 0.6 }), { r: 0.45, len: 0.1, seg: 12 });
  fw.position.set(t.cabRearX - 2.0, 1.02, 0);
  t.g.add(fw);
  P.bullbar(t.g, M, { x: t.x1 + 0.16, y: t.clear + 0.35, w: t.W * 0.86 }); // outback roo bar
  const hex = r.pick(['#e8e9eb', '#c63d3d', '#3a76c4', '#3e8948', '#e07b39']);
  const x1a = t.cabRearX - 0.45;
  const L1 = boxTrailer(r, M, t.g, x1a, { hex });
  trailerAxles(M, t.g, x1a - L1);
  const x1b = x1a - L1 - 0.7;
  const L2 = boxTrailer(r, M, t.g, x1b, { hex });
  trailerAxles(M, t.g, x1b - L2);
  P.axle(t.g, M, { x: x1b + 0.15, track: 2.1, r: 0.5, w: 0.32, dual: true, hubR: 0.5 }); // converter dolly
  const bar = box(M('#33373d', { rough: 0.6 }), 0.95, 0.1, 0.12);
  bar.position.set(x1a - L1 - 0.32, 0.55, 0);
  t.g.add(bar);
  return t.g;
}

/* ================= construction & specials (batch 2) ================= */
function crawlerTrack(g, M, o) {
  const { x, z, len, r = 0.42, w = 0.48 } = o;
  const dark = M('#26292e', { rough: 0.92, env: 0.2 });
  const body = box(dark, len, r * 1.5, w);
  body.position.set(x, r, z); g.add(body);
  for (const ex of [-1, 1]) {
    const end = cyl(dark, { r, len: w * 1.02, axis: 'z', seg: 12 });
    end.position.set(x + ex * len / 2, r, z); g.add(end);
  }
  const hub = M('#484c53', { rough: 0.5, metal: 0.3 });
  const n = Math.max(3, Math.round(len / 0.55));
  for (let i = 0; i < n; i++) {
    const rw = cyl(hub, { r: r * 0.42, len: w * 1.06, axis: 'z', seg: 10 });
    rw.position.set(x - len / 2 + ((i + 0.5) / n) * len, r * 0.72, z); g.add(rw);
  }
  const spr = cyl(hub, { r: r * 0.6, len: w * 1.08, axis: 'z', seg: 8 });
  spr.position.set(x + len / 2, r, z); g.add(spr);
}
function buildBulldozer(r, M, ctx) {
  const g = new THREE.Group();
  const mats = stdMats(r, M, { bodyHex: ctx.paint || r.pick(['#e39a26', '#dfbd25', '#e06d21']) });
  const W = 1.95;
  crawlerTrack(g, M, { x: -0.1, z: W / 2, len: 3.2, r: 0.46, w: 0.52 });
  crawlerTrack(g, M, { x: -0.1, z: -W / 2, len: 3.2, r: 0.46, w: 0.52 });
  const hood = slab(mats.body, { x0: -0.5, x1: 1.3, y0: 0.92, y1: 1.5, w: 1.3, wT: 1.14, nose: 0.22, noseB: 0.05 });
  g.add(hood);
  P.grilleOn(g, M, hood.userData.pt, { f0: 0.28, f1: 0.72, v0: 0.2, v1: 0.72 });
  P.headlightsOn(g, M, hood.userData.pt, { v0: 0.55, v1: 0.82, w: 0.16, edge: 0.08 });
  cabin(g, mats, { x0: -1.45, x1: -0.35, y0: 1.48, h: 0.92, w: 1.35, wT: 1.12, rakeF: 0.26, rakeR: 0.2, sideCols: 1 });
  const seat = box(mats.dark, 0.4, 0.14, 0.44); seat.position.set(-0.9, 1.56, 0); g.add(seat);
  P.exhaustStack(g, M, { x: 0.55, z: 0.35, y0: 1.5, h: 0.72 });
  P.beacon(g, M, { x: -0.95, y: 2.4, hex: '#ffb03a' });
  const bladeM = M('#c9ced4', { rough: 0.42, metal: 0.5, env: 1 });
  const bg = new THREE.Group();
  const lower = box(bladeM, 0.16, 0.95, 2.35); lower.position.y = 0.48; bg.add(lower);
  const upper = box(bladeM, 0.16, 0.6, 2.35); upper.position.set(-0.14, 1.15, 0); upper.rotation.z = 0.44; bg.add(upper);
  bg.position.set(2.25, 0.12, 0); g.add(bg);
  for (const s of [-1, 1]) { const arm = box(mats.dark, 1.6, 0.13, 0.13); arm.position.set(1.35, 0.55, s * (W / 2 + 0.28)); g.add(arm); }
  return g;
}
function buildExcavator(r, M, ctx) {
  const g = new THREE.Group();
  const mats = stdMats(r, M, { bodyHex: ctx.paint || r.pick(['#e39a26', '#dfbd25', '#e06d21', '#c92f2f']) });
  const W = 1.75;
  crawlerTrack(g, M, { x: 0, z: W / 2 + 0.05, len: 3.0, r: 0.42, w: 0.5 });
  crawlerTrack(g, M, { x: 0, z: -W / 2 - 0.05, len: 3.0, r: 0.42, w: 0.5 });
  const base = cyl(mats.dark, { r: 0.85, len: 0.22, seg: 14 }); base.position.set(-0.2, 0.95, 0); g.add(base);
  g.add(slab(mats.body, { x0: -1.7, x1: 0.6, y0: 1.05, y1: 1.62, w: 1.7, wT: 1.55, nose: 0.2, tail: 0.1 }));
  g.add(slab(mats.body2, { x0: -1.95, x1: -1.5, y0: 0.98, y1: 1.58, w: 1.66, tailB: 0.12 }));
  const cab = slab(mats.body, { x0: -0.5, x1: 0.6, y0: 1.62, y1: 2.35, w: 0.92, wT: 0.84, nose: 0.26, tail: 0.1 });
  g.add(cab);
  g.add(quadPrism(subQuad(faceQuad(cab.userData.pt, 'front'), 0.12, 0.88, 0.2, 0.85), 0.024, mats.glass, 0.012));
  for (const s of ['left', 'right']) g.add(panesOnQuad(faceQuad(cab.userData.pt, s), mats.glass, { cols: 1, f0: 0.14, f1: 0.86, v0: 0.24, v1: 0.8, t: 0.02 }));
  const arm = new THREE.Group();
  const boom = box(mats.body, 1.9, 0.28, 0.3); boom.position.set(0.85, 0.5, 0); boom.rotation.z = 0.62; arm.add(boom);
  const stick = box(mats.body, 1.45, 0.24, 0.26); stick.position.set(1.7, 0.42, 0); stick.rotation.z = -0.78; arm.add(stick);
  const buM = M('#8d939a', { rough: 0.4, metal: 0.5, env: 1 });
  const bucket = new THREE.Group();
  const bback = box(buM, 0.14, 0.5, 0.58); bback.position.set(0, 0.2, 0); bucket.add(bback);
  const bbot = box(buM, 0.5, 0.14, 0.58); bbot.position.set(0.25, -0.02, 0); bucket.add(bbot);
  bucket.position.set(2.45, -0.25, 0); bucket.rotation.z = 0.35; arm.add(bucket);
  arm.position.set(0.55, 1.15, 0.34); g.add(arm);
  return g;
}
function buildWheelLoader(r, M, ctx) {
  const g = new THREE.Group();
  const mats = stdMats(r, M, { bodyHex: ctx.paint || r.pick(['#e39a26', '#dfbd25', '#e06d21']) });
  P.axle(g, M, { x: 1.2, track: 1.75, r: 0.56, w: 0.5, hubR: 0.45, seg: 14 });
  P.axle(g, M, { x: -1.2, track: 1.75, r: 0.56, w: 0.5, hubR: 0.45, seg: 14 });
  g.add(slab(mats.body, { x0: -1.95, x1: -0.1, y0: 0.58, y1: 1.4, w: 1.5, wT: 1.35, nose: 0.15, tail: 0.1 }));
  cabin(g, mats, { x0: -0.95, x1: 0.1, y0: 1.38, h: 0.86, w: 1.4, wT: 1.18, rakeF: 0.24, rakeR: 0.2, sideCols: 1 });
  g.add(slab(mats.body, { x0: 0.1, x1: 1.35, y0: 0.58, y1: 1.18, w: 1.32, wT: 1.2, nose: 0.15 }));
  for (const s of [-1, 1]) { const arm = box(mats.dark, 1.55, 0.13, 0.13); arm.position.set(1.45, 0.85, s * 0.58); arm.rotation.z = -0.16; g.add(arm); }
  const buM = M('#8d939a', { rough: 0.4, metal: 0.5, env: 1 });
  const bu = new THREE.Group();
  const bBack = box(buM, 0.14, 0.65, 1.55); bBack.position.set(0, 0.32, 0); bu.add(bBack);
  const bBot = box(buM, 0.62, 0.14, 1.55); bBot.position.set(0.32, 0.02, 0); bu.add(bBot);
  bu.position.set(2.05, 0.22, 0); g.add(bu);
  P.exhaustStack(g, M, { x: -0.35, z: 0.4, y0: 1.4, h: 0.5 });
  P.beacon(g, M, { x: -0.4, y: 2.24, hex: '#ffb03a' });
  return g;
}
function buildRoller(r, M, ctx) {
  const g = new THREE.Group();
  const mats = stdMats(r, M, { bodyHex: ctx.paint || r.pick(['#e39a26', '#dfbd25', '#c92f2f', '#2668bd']) });
  const steel = M('#b3b8be', { rough: 0.34, metal: 0.5, env: 1.05 });
  const drum = cyl(steel, { r: 0.64, len: 1.55, axis: 'z', seg: 16 }); drum.position.set(1.35, 0.64, 0); g.add(drum);
  for (const s of [-1, 1]) { const fk = box(mats.dark, 0.75, 0.13, 0.1); fk.position.set(0.92, 0.64, s * 0.8); g.add(fk); }
  g.add(slab(mats.body, { x0: -1.65, x1: 1.0, y0: 0.46, y1: 1.06, w: 1.5, wT: 1.34, nose: 0.15, tail: 0.1 }));
  P.axle(g, M, { x: -1.15, track: 1.6, r: 0.56, w: 0.52, hubR: 0.5, seg: 14 });
  const seat = box(mats.dark, 0.46, 0.16, 0.5); seat.position.set(-0.75, 1.12, 0); g.add(seat);
  const sb = box(mats.dark, 0.14, 0.4, 0.5); sb.position.set(-1.0, 1.3, 0); g.add(sb);
  for (const [px, pz] of [[-0.2, 0.55], [-0.2, -0.55], [-1.3, 0.55], [-1.3, -0.55]]) P.post(g, M, { x: px, z: pz, y0: 1.06, y1: 2.0, t: 0.06 });
  g.add(slab(mats.body2, { x0: -1.5, x1: -0.05, y0: 2.0, y1: 2.1, w: 1.35, nose: 0.12, tail: 0.12 }));
  P.beacon(g, M, { x: -0.7, y: 2.1, hex: '#ffb03a' });
  P.exhaustStack(g, M, { x: 0.35, z: 0.5, y0: 1.06, h: 0.55 });
  return g;
}
function buildHaulTruck(r, M, ctx) {
  const g = new THREE.Group();
  const mats = stdMats(r, M, { bodyHex: ctx.paint || r.pick(['#dfbd25', '#e39a26', '#e06d21']) });
  const W = 2.9, clear = 0.95;
  P.axle(g, M, { x: 1.6, track: W - 0.5, r: 0.95, w: 0.72, hubR: 0.5, seg: 16 });
  P.axle(g, M, { x: -1.7, track: W - 0.1, r: 0.95, w: 0.95, dual: true, hubR: 0.5, seg: 16 });
  const fb = slab(mats.body, { x0: 0.6, x1: 2.5, y0: clear, y1: clear + 1.0, w: W, wT: W * 0.9, nose: 0.15, noseB: 0.05 });
  g.add(fb);
  P.headlightsOn(g, M, fb.userData.pt, { v0: 0.3, v1: 0.5, w: 0.13 });
  P.grilleOn(g, M, fb.userData.pt, { f0: 0.34, f1: 0.66, v0: 0.14, v1: 0.4 });
  const cab = box(mats.body, 0.9, 0.82, 0.95); cab.castShadow = cab.receiveShadow = true; cab.position.set(1.9, clear + 1.52, W / 2 - 0.55); g.add(cab);
  const cwn = box(mats.glass, 0.5, 0.46, 0.4); cwn.position.set(2.42, clear + 1.62, W / 2 - 0.55); g.add(cwn);
  const bedM = M(shade(mats.bodyHex, -0.05), { rough: 0.5, metal: 0.2 });
  g.add(slab(bedM, { x0: -2.7, x1: 1.4, y0: clear + 0.55, y1: clear + 0.95, w: W + 0.25 }));
  for (const s of [-1, 1]) { const wall = box(bedM, 3.9, 0.85, 0.14); wall.position.set(-0.65, clear + 1.35, s * (W / 2 + 0.05)); g.add(wall); }
  g.add(slab(bedM, { x0: 1.3, x1: 1.9, y0: clear + 0.95, y1: clear + 2.6, w: W + 0.25, nose: 0.3 }));
  P.beacon(g, M, { x: 1.5, y: clear + 1.95, hex: '#ffb03a' });
  return g;
}
function buildDragster(r, M, ctx) {
  const g = new THREE.Group();
  const mats = stdMats(r, M, { bodyHex: ctx.paint });
  const rail = box(mats.dark, 4.6, 0.13, 0.2); rail.position.set(-0.2, 0.4, 0); g.add(rail);
  P.axle(g, M, { x: -1.7, track: 1.55, r: 0.64, w: 0.62, rod: true, hubR: 0.5, seg: 16 });
  P.axle(g, M, { x: 2.35, track: 0.7, r: 0.22, w: 0.12, rod: true, hubR: 0.5, seg: 10 });
  const eng = box(M('#8d939a', { rough: 0.32, metal: 0.7, env: 1.2 }), 0.7, 0.6, 0.72); eng.position.set(-0.7, 0.78, 0); g.add(eng);
  const sc = box(mats.dark, 0.36, 0.32, 0.44); sc.position.set(-0.7, 1.2, 0); g.add(sc);
  const intake = box(mats.body2, 0.3, 0.12, 0.34); intake.position.set(-0.7, 1.42, 0); g.add(intake);
  for (const s of [-1, 1]) for (let i = 0; i < 4; i++) {
    const p = cyl(M('#c9ced4', { rough: 0.28, metal: 0.75, env: 1.2 }), { r: 0.045, len: 0.42, axis: 'x', seg: 6 });
    p.position.set(-0.95 + i * 0.12, 0.72, s * 0.44); p.rotation.z = 2.3; p.rotation.y = s * 0.2; g.add(p);
  }
  g.add(slab(mats.body, { x0: -2.15, x1: -0.35, y0: 0.46, y1: 0.86, w: 0.72, wT: 0.5, nose: 0.32, tail: 0.1 }));
  const hr = box(mats.body2, 0.32, 0.3, 0.36); hr.position.set(-1.95, 0.98, 0); g.add(hr);
  const wing = slab(mats.body2, { x0: -2.85, x1: -2.4, y0: 1.42, y1: 1.52, w: 1.5, nose: 0.1 }); g.add(wing);
  for (const s of [-1, 1]) { const post = box(mats.body2, 0.07, 0.85, 0.06); post.position.set(-2.55, 1.0, s * 0.5); post.rotation.z = -0.2; g.add(post); }
  const fwing = box(mats.body2, 0.32, 0.05, 0.9); fwing.position.set(2.5, 0.24, 0); g.add(fwing);
  if (r.chance(0.7)) P.racingStripes(g, M, { x0: -2.1, x1: 2.3, y: 0.5, w2: 0.1, gap: 0.05, hex: r.pick(['#e6e7e9', '#22252a', '#dfbd25']) });
  return g;
}
function buildQuad(r, M, ctx) {
  const g = new THREE.Group();
  const mats = stdMats(r, M, { bodyHex: ctx.paint || r.pick(['#c92f2f', '#2668bd', '#2e8442', '#e06d21', '#dfbd25']) });
  P.axle(g, M, { x: 0.78, track: 1.15, r: 0.35, w: 0.36, hubR: 0.4, seg: 12 });
  P.axle(g, M, { x: -0.78, track: 1.28, r: 0.4, w: 0.44, hubR: 0.4, seg: 12 });
  g.add(wedge(mats.body, { x0: -1.05, x1: 1.05, y0: 0.44, y1: 0.74, w0: 0.88, w1: 0.6, w0T: 0.72, w1T: 0.5, nose: 0.22 }));
  const seat = box(mats.dark, 0.58, 0.15, 0.42); seat.position.set(-0.35, 0.8, 0); g.add(seat);
  const rack = box(mats.dark, 0.42, 0.05, 0.58); rack.position.set(0.88, 0.78, 0); g.add(rack);
  const col = cyl(mats.dark, { r: 0.04, len: 0.42, seg: 6 }); col.position.set(0.22, 0.92, 0); col.rotation.z = 0.42; g.add(col);
  const bar = cyl(M('#c9ced4', { rough: 0.3, metal: 0.6, env: 1 }), { r: 0.03, len: 0.52, axis: 'z', seg: 6 }); bar.position.set(0.1, 1.08, 0); g.add(bar);
  const lamp = box(M('#ffedb8', { rough: 0.25, emissive: '#ffd98a', emInt: 0.6, env: 1.2 }), 0.06, 0.13, 0.2); lamp.position.set(1.05, 0.72, 0); g.add(lamp);
  for (const ax of [0.78, -0.78]) for (const s of [-1, 1]) { const f = slab(mats.body, { x0: ax - 0.44, x1: ax + 0.44, y0: 0.62, y1: 0.74, w: 0.26, nose: 0.22, tail: 0.22 }); f.position.z = s * 0.62; g.add(f); }
  return g;
}
function buildSnowmobile(r, M, ctx) {
  const g = new THREE.Group();
  const mats = stdMats(r, M, { bodyHex: ctx.paint || r.pick(['#c92f2f', '#2668bd', '#2e8442', '#dfbd25']) });
  const dark = M('#26292e', { rough: 0.9 });
  const track = box(dark, 1.85, 0.36, 0.52); track.position.set(-0.5, 0.26, 0); g.add(track);
  for (const ex of [-1, 1]) { const e = cyl(dark, { r: 0.21, len: 0.54, axis: 'z', seg: 10 }); e.position.set(-0.5 + ex * 0.92, 0.26, 0); g.add(e); }
  for (const s of [-1, 1]) {
    const ski = slab(M('#c9ced4', { rough: 0.4, metal: 0.3, env: 1 }), { x0: 0.7, x1: 1.65, y0: 0.02, y1: 0.11, w: 0.17, nose: 0.32 });
    ski.position.z = s * 0.44; g.add(ski);
    const strut = box(mats.dark, 0.07, 0.42, 0.07); strut.position.set(1.05, 0.3, s * 0.44); g.add(strut);
  }
  g.add(wedge(mats.body, { x0: -0.35, x1: 1.25, y0: 0.36, y1: 0.78, w0: 0.56, w1: 0.42, nose: 0.36 }));
  const seat = box(mats.dark, 0.95, 0.17, 0.44); seat.position.set(-0.55, 0.62, 0); g.add(seat);
  const ws = slab(mats.glass, { x0: 0.78, x1: 0.92, y0: 0.72, y1: 1.1, w: 0.5, nose: 0.08 }); g.add(ws);
  const bar = cyl(M('#c9ced4', { rough: 0.3, metal: 0.6 }), { r: 0.03, len: 0.46, axis: 'z', seg: 6 }); bar.position.set(0.58, 0.92, 0); g.add(bar);
  const lamp = box(M('#ffedb8', { rough: 0.25, emissive: '#ffd98a', emInt: 0.6, env: 1.2 }), 0.05, 0.14, 0.22); lamp.position.set(1.22, 0.6, 0); g.add(lamp);
  return g;
}
function buildTram(r, M, ctx) {
  const g = new THREE.Group();
  const mats = stdMats(r, M, { bodyHex: ctx.paint || r.pick(['#c92f2f', '#2668bd', '#2e8442', '#dfbd25', '#e6e7e9', '#e06d21']) });
  const L = 8.6, W = 2.4, H = 2.75, clear = 0.34;
  const body = slab(mats.body, { x0: -L / 2, x1: L / 2, y0: clear, y1: clear + H, w: W, wT: W * 0.94, nose: 0.55, tail: 0.55, noseB: 0.16, tailB: 0.16 });
  g.add(body);
  const bpt = body.userData.pt;
  g.add(quadPrism(subQuad(faceQuad(bpt, 'front'), 0.1, 0.9, 0.5, 0.84), 0.026, mats.glass, 0.012));
  g.add(quadPrism(subQuad(faceQuad(bpt, 'rear'), 0.1, 0.9, 0.5, 0.84), 0.026, mats.glass, 0.012));
  for (const s of ['left', 'right']) g.add(panesOnQuad(faceQuad(bpt, s), mats.glass, { cols: 6, gap: 0.032, f0: 0.06, f1: 0.94, v0: 0.5, v1: 0.8 }));
  P.sideStripe(g, M, { x0: -L / 2 + 0.35, x1: L / 2 - 0.35, y: clear + H * 0.34, w: W, hex: r.pick(['#dfbd25', '#e6e7e9', '#22252a']), h: 0.2 });
  g.add(slab(M(shade(mats.bodyHex, -0.06), { rough: 0.6 }), { x0: -L / 2 + 0.2, x1: L / 2 - 0.2, y0: clear + H, y1: clear + H + 0.12, w: W * 0.92, nose: 0.32, tail: 0.32 }));
  const pM = M('#33373d', { rough: 0.5, metal: 0.3 });
  const pa = box(pM, 0.06, 0.55, 0.06); pa.position.set(0.55, clear + H + 0.42, 0.4); pa.rotation.z = 0.55; g.add(pa);
  const pb = box(pM, 0.06, 0.55, 0.06); pb.position.set(0.08, clear + H + 0.72, 0.4); pb.rotation.z = -0.55; g.add(pb);
  const pbar = box(pM, 0.05, 0.05, 0.85); pbar.position.set(-0.2, clear + H + 0.94, 0.4); g.add(pbar);
  P.axle(g, M, { x: L / 2 - 1.6, track: W - 0.5, r: 0.36, w: 0.24, hubR: 0.5 });
  P.axle(g, M, { x: -L / 2 + 1.6, track: W - 0.5, r: 0.36, w: 0.24, hubR: 0.5 });
  P.headlightsOn(g, M, bpt, { v0: 0.32, v1: 0.44, w: 0.12 });
  P.taillightsOn(g, M, bpt, { v0: 0.32, v1: 0.44, w: 0.08 });
  return g;
}
function buildCraneTruck(r, M, ctx) {
  const t = truckFront(r, M, ctx, { nose: r.chance(0.5) ? r.range(0.9, 1.2) : 0, W: 2.3, beaconHex: '#ffb03a', stacks: false });
  const x1 = t.cabRearX - 0.14, x0 = x1 - 4.3;
  chassis(t, M, x0 + 0.15, { axles: 2, dual: true });
  t.g.add(slab(M('#5c6167', { rough: 0.7 }), { x0, x1, y0: t.clear + 0.26, y1: t.clear + 0.5, w: t.W }));
  for (const s of [-1, 1]) {
    const arm = box(M('#33373d', { rough: 0.6 }), 0.5, 0.12, 0.2); arm.position.set(x0 + 0.55, t.clear + 0.32, s * (t.W / 2 + 0.18)); t.g.add(arm);
    const leg = box(M('#8d939a', { rough: 0.4, metal: 0.5 }), 0.16, 0.5, 0.16); leg.position.set(x0 + 0.55, t.clear + 0.06, s * (t.W / 2 + 0.32)); t.g.add(leg);
  }
  const base = cyl(t.mats.dark, { r: 0.5, len: 0.3, seg: 12 }); base.position.set(x0 + 1.25, t.clear + 0.66, 0); t.g.add(base);
  const oc = box(t.mats.body, 0.6, 0.62, 0.62); oc.castShadow = oc.receiveShadow = true; oc.position.set(x0 + 1.25, t.clear + 1.12, 0.22); t.g.add(oc);
  const boom = box(t.mats.body, 4.6, 0.3, 0.35); boom.position.set(x0 + 2.6, t.clear + 1.62, -0.14); boom.rotation.z = 0.5; t.g.add(boom);
  const tipX = x0 + 2.6 + Math.cos(0.5) * 2.3, tipY = t.clear + 1.62 + Math.sin(0.5) * 2.3;
  const cable = box(M('#26292e', { rough: 0.8 }), 0.03, 0.9, 0.03); cable.position.set(tipX, tipY - 0.45, -0.14); t.g.add(cable);
  const hook = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.03, 6, 10), M('#c9ced4', { rough: 0.3, metal: 0.7, env: 1.1 })); hook.castShadow = true; hook.position.set(tipX, tipY - 0.95, -0.14); t.g.add(hook);
  P.bumper(t.g, M, { x: x0 - 0.06, y: t.clear + 0.05, w: t.W * 0.9, hex: '#33373d' });
  return t.g;
}
function buildKei(r, M, ctx) {
  const c = car(r, M, ctx, { L: 3.05, W: 1.62, bodyH: 0.5, clear: 0.34, wheelR: 0.32, wheelW: 0.26, cabL: 1.45, cabX: 0.5, cabH: 0.74, rakeF: 0.16, rakeR: 0.1, cabWf: 0.96, cabTopWf: 0.9, sideCols: 1, nose: 0.05, noseB: 0.03, axInF: 0.52, axInR: 0.55 });
  pickupBed(c, M, r);
  return c.g;
}
function buildTrophy(r, M, ctx) {
  const c = car(r, M, ctx, { ...PICKUP_K, L: 4.7, clear: 0.62, wheelR: 0.5, wheelW: 0.44, hubR: 0.42, rod: true, poke: true, spotPod: true, stripes: true, bumpers: false, mirrorP: 0.3, cabL: 1.5, cabX: 0.7 });
  pickupBed(c, M, r, { cargo: false });
  P.spareWheel(c.g, M, { x: -c.L / 2 + 0.45, y: c.bodyTop + 0.32, r: 0.42, w: 0.3 });
  P.bullbar(c.g, M, { x: c.L / 2 + 0.12, y: c.clear + 0.3, w: c.W * 0.85 });
  return c.g;
}
function miniCar(M, r, len) {
  const cg = new THREE.Group();
  const m = M(r.weighted(PAINT), { rough: 0.55, env: 0.42 });
  cg.add(slab(m, { x0: -len / 2, x1: len / 2, y0: 0.05, y1: 0.33, w: 0.92, wT: 0.84, nose: 0.14, tail: 0.1 }));
  cg.add(slab(m, { x0: -len * 0.22, x1: len * 0.24, y0: 0.31, y1: 0.56, w: 0.82, wT: 0.6, nose: 0.16, tail: 0.12 }));
  for (const ax of [len * 0.3, -len * 0.3]) for (const s of [-1, 1]) { const wh = P.wheel(M, 0.14, 0.1, { seg: 8 }); wh.position.set(ax, 0.14, s * 0.4); cg.add(wh); }
  return cg;
}
function containerTrailer(r, M, g, x1) {
  const Lt = 6.4;
  const hex = r.pick(['#c92f2f', '#2668bd', '#2e8442', '#e06d21', '#dfbd25', '#b3b8be', '#20518f']);
  const mat = M(hex, { rough: 0.62 });
  const rail = box(M('#2c2f34', { rough: 0.8 }), Lt + 0.6, 0.28, 1.3); rail.position.set(x1 - Lt / 2, 0.9, 0); g.add(rail);
  g.add(slab(mat, { x0: x1 - Lt, x1, y0: 1.1, y1: 2.95, w: 2.42, nose: 0.02, tail: 0.02 }));
  const dk = M(shade(hex, -0.08), { rough: 0.62 });
  for (let i = 0; i <= 13; i++) {
    for (const s of [-1, 1]) { const rib = box(dk, 0.05, 1.75, 0.03); rib.position.set(x1 - Lt + (i / 13) * Lt, 2.02, s * (2.42 / 2 + 0.006)); g.add(rib); }
  }
  g.add(quadPrism(subQuad(faceQuad({ x0b: x1 - Lt, x1b: x1, x0t: x1 - Lt, x1t: x1, zb: 2.42, zt: 2.42, y0: 1.1, y1: 2.95 }, 'rear'), 0.06, 0.94, 0.05, 0.95), 0.02, dk, 0.008));
  trailerAxles(M, g, x1 - Lt);
  return Lt;
}
function carCarrierTrailer(r, M, g, x1) {
  const Lt = 7.6;
  const frameM = M('#5c6167', { rough: 0.7 });
  g.add(slab(frameM, { x0: x1 - Lt, x1, y0: 1.05, y1: 1.2, w: 2.4 }));
  const rail = box(M('#2c2f34', { rough: 0.8 }), Lt * 0.9, 0.22, 1.2); rail.position.set(x1 - Lt / 2, 0.92, 0); g.add(rail);
  g.add(slab(frameM, { x0: x1 - Lt, x1: x1 - 0.5, y0: 2.5, y1: 2.62, w: 2.4 }));
  for (const xx of [x1 - 0.6, x1 - Lt + 0.5]) for (const s of [-1, 1]) P.post(g, M, { x: xx, z: s * 1.12, y0: 1.2, y1: 2.55, t: 0.08, hex: '#33373d' });
  for (let i = 0; i < 2; i++) { const mc = miniCar(M, r, 1.9); mc.position.set(x1 - 1.4 - i * 2.3, 1.2, 0); g.add(mc); }
  for (let i = 0; i < 2; i++) { const mc = miniCar(M, r, 1.9); mc.position.set(x1 - 1.5 - i * 2.3, 2.62, 0); g.add(mc); }
  trailerAxles(M, g, x1 - Lt);
  return Lt;
}
function buildBendyBus(r, M, ctx) {
  const g = new THREE.Group();
  const front = bus(r, M, ctx, { L: 5.8, cols: 4, dualRear: true });
  front.g.position.x = 2.3;
  g.add(front.g);
  const mats = front.mats, W = front.W, H = front.H, clear = front.clear;
  const rg = new THREE.Group();
  const body = slab(mats.body, { x0: -3.2, x1: 0.25, y0: clear, y1: clear + H, w: W, wT: W * 0.92, nose: 0.12, tail: 0.24 });
  rg.add(body);
  const bpt = body.userData.pt;
  for (const s of ['left', 'right']) rg.add(panesOnQuad(faceQuad(bpt, s), mats.glass, { cols: 4, gap: 0.028, f0: 0.06, f1: 0.9, v0: 0.5, v1: 0.82 }));
  rg.add(quadPrism(subQuad(faceQuad(bpt, 'rear'), 0.12, 0.88, 0.5, 0.82), 0.026, mats.glass, 0.012));
  P.axle(rg, M, { x: -2.2, track: W - 0.3, r: 0.54, w: 0.3, hubR: 0.5, dual: true });
  P.taillightsOn(rg, M, bpt, { v0: 0.12, v1: 0.26, w: 0.06 });
  rg.position.x = -2.55;
  g.add(rg);
  const acc = M('#22252a', { rough: 0.92 });
  for (let i = 0; i < 6; i++) { const ring = box(acc, 0.1, H * 0.92, W * 0.9); ring.position.set(-2.15 + i * 0.26, clear + H * 0.5, 0); g.add(ring); }
  if (r.chance(0.6)) P.sideStripe(g, M, { x0: -5.6, x1: 5.0, y: clear + H * 0.36, w: W, hex: r.pick(['#dfbd25', '#e6e7e9', '#c92f2f']), h: 0.2 });
  return g;
}

/* ================= registry ================= */
const CARS = 'Cars', RACE = 'Racing & Fun', OFF = 'Off-Road', VANS = 'Vans & Buses', TRUCK = 'Trucks', SVC = 'Service & Emergency', CONS = 'Construction', RAIL = 'Rail', SPEC = 'Special';
export const REG = [
  { id: 'sedan', label: 'Sedan', cat: CARS, build: (r, M, x) => car(r, M, x, { twoTone: true }).g },
  { id: 'coupe', label: 'Coupe', cat: CARS, build: (r, M, x) => car(r, M, x, { L: 4.3, bodyH: 0.55, cabL: 1.8, cabX: -0.3, cabH: 0.5, rakeF: 0.62, rakeR: 0.5, sideCols: 1, twoTone: true }).g },
  { id: 'hatch', label: 'Hatchback', cat: CARS, build: (r, M, x) => car(r, M, x, { L: 3.7, W: 1.85, cabL: 1.95, cabX: -0.58, cabH: 0.56, rakeF: 0.5, rakeR: 0.15, tail: 0.12, sideCols: 2 }).g },
  { id: 'wagon', label: 'Station Wagon', cat: CARS, build: (r, M, x) => car(r, M, x, { L: 4.8, cabL: 2.75, cabX: -0.55, rakeR: 0.2, sideCols: 3, roofRack: true }).g },
  { id: 'sports', label: 'Sports Car', cat: CARS, build: (r, M, x) => car(r, M, x, { L: 4.25, W: 2.0, bodyH: 0.5, clear: 0.27, cabL: 1.75, cabH: 0.42, rakeF: 0.72, rakeR: 0.55, sideCols: 1, spoiler: true, spoilerP: 0.6, stripes: true, wheelR: 0.35, nose: 0.4, noseB: 0.12 }).g },
  { id: 'supercar', label: 'Supercar', cat: CARS, build: (r, M, x) => car(r, M, x, { L: 4.45, W: 2.05, bodyH: 0.42, clear: 0.24, cabL: 1.9, cabX: -0.35, cabH: 0.4, cabWf: 0.82, rakeF: 0.9, rakeR: 0.65, sideCols: 1, spoiler: true, bigWing: true, spoilerP: 0.75, nose: 0.6, noseB: 0.1, tailB: 0.08, wheelR: 0.34, stripes: true }).g },
  { id: 'muscle', label: 'Muscle Car', cat: CARS, build: (r, M, x) => car(r, M, x, { L: 4.95, bodyH: 0.58, cabL: 1.75, cabX: -0.55, rakeF: 0.58, rakeR: 0.5, sideCols: 1, scoop: true, stripes: true, wheelRr: 0.41, wheelWr: 0.32, tail: 0.22 }).g },
  { id: 'convertible', label: 'Convertible', cat: CARS, build: (r, M, x) => car(r, M, x, { L: 4.35, bodyH: 0.55, noCabin: true, wheelR: 0.36 }).g },
  { id: 'classic', label: 'Classic Car', cat: CARS, build: (r, M, x) => car(r, M, x, { L: 4.0, W: 1.72, bodyH: 0.5, clear: 0.42, wheelR: 0.38, cabL: 1.6, cabX: -0.45, cabH: 0.78, rakeF: 0.16, rakeR: 0.1, cabWf: 0.84, cabTopWf: 0.76, fenders: true, white: true, spare: true, paintHex: r.pick(['#26292e', '#5a2e2e', '#2e4a3f', '#2b3a55', '#7c542f', '#a92f38']) }).g },
  { id: 'micro', label: 'Microcar', cat: CARS, build: (r, M, x) => car(r, M, x, { L: 2.7, W: 1.72, bodyH: 0.5, clear: 0.3, wheelR: 0.3, cabL: 1.55, cabX: 0.1, cabH: 0.6, rakeF: 0.5, rakeR: 0.3, sideCols: 1, axInF: 0.5, axInR: 0.5 }).g },
  { id: 'limo', label: 'Limousine', cat: CARS, build: (r, M, x) => car(r, M, x, { L: 8.4, bodyH: 0.55, cabL: 4.7, cabX: -0.3, cabH: 0.55, rakeF: 0.55, rakeR: 0.4, sideCols: 5, paintHex: r.pick(['#22252a', '#e6e7e9', '#233252', '#383c43']) }).g },
  { id: 'hothatch', label: 'Hot Hatch', cat: CARS, build: (r, M, x) => car(r, M, x, { L: 3.6, W: 1.88, bodyH: 0.54, clear: 0.32, cabL: 1.95, cabX: -0.5, cabH: 0.56, rakeF: 0.5, rakeR: 0.16, tail: 0.12, sideCols: 2, spoiler: true, spoilerP: 0.55, stripes: true, wheelR: 0.36 }).g },
  { id: 'roadster', label: 'Roadster', cat: CARS, build: (r, M, x) => car(r, M, x, { L: 3.95, W: 1.74, bodyH: 0.5, clear: 0.4, wheelR: 0.36, noCabin: true, fenders: true, white: true, paintHex: r.pick(['#c22a24', '#20518f', '#22252a', '#2e6b3f', '#e6e7e9']) }).g },
  { id: 'hearse', label: 'Hearse', cat: CARS, build: (r, M, x) => car(r, M, x, { L: 6.2, bodyH: 0.56, cabL: 3.7, cabX: -0.75, cabH: 0.64, rakeF: 0.5, rakeR: 0.1, sideCols: 1, paintHex: r.pick(['#22252a', '#e6e7e9', '#383c43']) }).g },
  { id: 'lowrider', label: 'Lowrider', cat: CARS, build: (r, M, x) => { const c = car(r, M, x, { L: 4.7, bodyH: 0.5, clear: 0.2, wheelR: 0.29, wheelW: 0.22, hub: '#d8b23a', white: true, cabL: 2.0, cabX: -0.35, cabH: 0.48, rakeF: 0.42, rakeR: 0.32, sideCols: 2, paintHex: r.pick(['#5f3f96', '#238783', '#c92f2f', '#d97fa8', '#20518f', '#d8b23a']) }); P.sideStripe(c.g, M, { x0: -1.9, x1: 1.9, y: c.clear + c.bodyH * 0.42, w: c.W, hex: shade(c.mats.bodyHex, 0.18), h: 0.08 }); return c.g; } },
  { id: 'gtcoupe', label: 'Grand Tourer', cat: CARS, build: (r, M, x) => car(r, M, x, { L: 4.7, W: 2.0, bodyH: 0.52, clear: 0.28, cabL: 2.1, cabX: -0.3, cabH: 0.48, rakeF: 0.75, rakeR: 0.55, sideCols: 1, twoTone: true, wheelR: 0.38, nose: 0.35, stripes: true }).g },

  { id: 'f1', label: 'Formula Racer', cat: RACE, build: buildF1 },
  { id: 'lemans', label: 'Endurance Racer', cat: RACE, build: buildLeMans },
  { id: 'rally', label: 'Rally Car', cat: RACE, build: (r, M, x) => { const c = car(r, M, x, { L: 3.9, W: 1.9, cabL: 2.0, cabX: -0.55, cabH: 0.56, rakeF: 0.5, rakeR: 0.18, tail: 0.12, sideCols: 2, spotPod: true, spoiler: true, stripes: true, clear: 0.36, wheelR: 0.4 }); P.doorRoundels(c.g, M, { x: 0.35, y: c.clear + c.bodyH * 0.48, w: c.W, r: 0.24 }); return c.g; } },
  { id: 'hotrod', label: 'Hot Rod', cat: RACE, build: buildHotrod },
  { id: 'kart', label: 'Go-Kart', cat: RACE, build: buildKart },
  { id: 'moto', label: 'Motorcycle', cat: RACE, build: buildMoto },
  { id: 'chopper', label: 'Chopper', cat: RACE, build: buildChopper },
  { id: 'dragster', label: 'Dragster', cat: RACE, build: buildDragster },
  { id: 'stockcar', label: 'Stock Car', cat: RACE, build: (r, M, x) => { const c = car(r, M, x, { L: 4.9, W: 2.02, bodyH: 0.56, clear: 0.36, cabL: 1.85, cabX: -0.4, cabH: 0.54, rakeF: 0.5, rakeR: 0.35, sideCols: 1, spoiler: true, wheelR: 0.4, wheelW: 0.34, grille: false }); P.racingStripes(c.g, M, { x0: -2.2, x1: 2.2, y: c.bodyTop, w2: 0.2, gap: 0.12, hex: r.pick(['#e6e7e9', '#22252a', '#dfbd25']) }); P.doorRoundels(c.g, M, { x: 0.15, y: c.clear + c.bodyH * 0.48, w: c.W, r: 0.24 }); return c.g; } },

  { id: 'suv', label: 'SUV', cat: OFF, build: (r, M, x) => car(r, M, x, { L: 4.75, W: 1.98, bodyH: 0.72, clear: 0.44, wheelR: 0.43, cabL: 2.6, cabX: -0.5, cabH: 0.62, rakeF: 0.4, rakeR: 0.22, sideCols: 3, roofRack: true }).g },
  { id: 'overlander', label: 'Overlander SUV', cat: OFF, build: (r, M, x) => car(r, M, x, { L: 4.8, W: 2.02, bodyH: 0.74, clear: 0.52, wheelR: 0.47, wheelW: 0.34, cabL: 2.6, cabX: -0.5, cabH: 0.62, rakeF: 0.38, rakeR: 0.22, sideCols: 3, roofRack: true, spare: true, pushBar: true, spotPod: true }).g },
  { id: 'jeep', label: '4x4 Jeep', cat: OFF, build: buildJeep },
  { id: 'humvee', label: 'Humvee', cat: OFF, build: (r, M, x) => car(r, M, x, { L: 4.85, W: 2.32, bodyH: 0.84, clear: 0.52, wheelR: 0.5, wheelW: 0.42, hubR: 0.45, cabL: 2.5, cabX: -0.3, cabH: 0.5, rakeF: 0.3, rakeR: 0.28, sideCols: 2, topWf: 0.94, cabWf: 0.94, cabTopWf: 0.82, paintHex: r.pick(['#5a6b46', '#4f5f3f', '#6b6f4a', '#c4a86a']), pushBar: true, mirrorP: 0.4 }).g },
  { id: 'pickup', label: 'Pickup Truck', cat: OFF, build: buildPickup },
  { id: 'lifted', label: 'Lifted Pickup', cat: OFF, build: buildLifted },
  { id: 'trophy', label: 'Trophy Truck', cat: OFF, build: buildTrophy },
  { id: 'monster', label: 'Monster Truck', cat: OFF, build: buildMonster },
  { id: 'buggy', label: 'Dune Buggy', cat: OFF, build: buildBuggy },
  { id: 'quad', label: 'Quad / ATV', cat: OFF, build: buildQuad },
  { id: 'kei', label: 'Kei Truck', cat: OFF, build: buildKei },
  { id: 'armyjeep', label: 'Army Jeep', cat: OFF, build: (r, M, x) => buildJeep(r, M, { ...x, army: true }) },

  { id: 'minivan', label: 'Minivan', cat: VANS, build: (r, M, x) => car(r, M, x, { L: 4.85, W: 1.95, bodyH: 0.62, clear: 0.35, wheelR: 0.38, cabL: 3.1, cabX: -0.35, cabH: 0.6, rakeF: 0.7, rakeR: 0.25, sideCols: 3, topWf: 0.92 }).g },
  { id: 'van', label: 'Panel Van', cat: VANS, build: (r, M, x) => van(r, M, x, { stripeHex: r.chance(0.5) ? r.pick(['#c63d3d', '#3a76c4', '#e3c53a', '#3e8948']) : null }).g },
  { id: 'camper', label: 'Camper Van', cat: VANS, build: (r, M, x) => van(r, M, x, { twoTone: true, splitF: 0.5, noseCut: 0.4, L: 4.6, H: 1.85, white: r.chance(0.6), paintHex: r.pick(['#3a8f8a', '#c63d3d', '#e07b39', '#3a76c4', '#8fae3e', '#dd8fb4']) }).g },
  { id: 'minibus', label: 'Minibus', cat: VANS, build: (r, M, x) => van(r, M, x, { L: 5.7, H: 1.95, sideWindows: true, sideCols: 3 }).g },
  { id: 'citybus', label: 'City Bus', cat: VANS, build: (r, M, x) => { const b = bus(r, M, x, { cols: r.int(5, 6), dualRear: true }); P.roofAC(b.g, M, { x: -1, y: b.topY }); if (r.chance(0.6)) P.sideStripe(b.g, M, { x0: -b.L / 2 + 0.3, x1: b.L / 2 - 0.5, y: b.clear + b.H * 0.38, w: b.W, hex: r.pick(['#e3c53a', '#e8e9eb', '#c63d3d']), h: 0.2 }); return b.g; } },
  { id: 'schoolbus', label: 'School Bus', cat: VANS, build: (r, M, x) => { const b = bus(r, M, x, { nose: 0.95, paintHex: '#eda921', cols: 5, L: 8.6, bumperHex: '#26292e' }); for (const yy of [0.32, 0.52]) P.sideStripe(b.g, M, { x0: -b.L / 2 + 0.3, x1: b.L / 2 - 1.3, y: b.clear + b.H * yy, w: b.W, hex: '#26292e', h: 0.07 }); const sign = cyl(M('#c9302c', { rough: 0.5 }), { r: 0.19, len: 0.05, axis: 'z', seg: 8 }); sign.position.set(0.5, b.clear + b.H * 0.55, -(b.W / 2 + 0.1)); b.g.add(sign); return b.g; } },
  { id: 'ddecker', label: 'Double-Decker', cat: VANS, build: (r, M, x) => { const b = bus(r, M, x, { H: 3.5, L: 8.4, paintHex: r.chance(0.7) ? '#c63d3d' : undefined, bands: [[0.14, 0.38], [0.56, 0.82]], cols: 5, wsV0: 0.56, winV0: 0.56, winV1: 0.82 }); b.g.add(quadPrism(subQuad(faceQuad(b.bpt, 'front'), 0.1, 0.9, 0.14, 0.4), 0.028, b.mats.glass, 0.014)); return b.g; } },
  { id: 'rv', label: 'Motorhome RV', cat: VANS, build: buildRV },
  { id: 'stepvan', label: 'Delivery Van', cat: VANS, build: (r, M, x) => van(r, M, x, { L: 4.7, W: 2.12, H: 2.35, noseCut: 0.15, rearWindow: false, stripeHex: r.chance(0.55) ? r.pick(['#c92f2f', '#2668bd', '#2e8442', '#e06d21']) : null }).g },
  { id: 'armored', label: 'Armored Truck', cat: VANS, build: (r, M, x) => van(r, M, x, { paintHex: r.pick(['#4a4e55', '#767c84', '#383c43']), L: 4.7, H: 2.0, noseCut: 0.32, rearWindow: false, stripeHex: '#22252a', stripeF: 0.5, stripeH: 0.1 }).g },
  { id: 'shuttle', label: 'Airport Shuttle', cat: VANS, build: (r, M, x) => van(r, M, x, { L: 6.3, H: 2.05, sideWindows: true, sideCols: 4, stripeHex: r.pick(['#2668bd', '#e06d21', '#dfbd25']) }).g },
  { id: 'bendybus', label: 'Articulated Bus', cat: VANS, build: buildBendyBus },

  { id: 'boxtruck', label: 'Box Truck', cat: TRUCK, build: (r, M, x) => rigidTruck(r, M, x, (t, m, rr, x0, x1) => boxBed(t, m, rr, x0, x1, { stripeHex: rr.chance(0.4) ? rr.pick(['#c92f2f', '#2668bd', '#dfbd25']) : null }), { bedL: 4.4, stacks: false }) },
  { id: 'flatbed', label: 'Flatbed Truck', cat: TRUCK, build: (r, M, x) => rigidTruck(r, M, x, (t, m, rr, x0, x1) => flatBed(t, m, rr, x0, x1), { bedL: 4.6 }) },
  { id: 'logtruck', label: 'Log Truck', cat: TRUCK, build: (r, M, x) => rigidTruck(r, M, x, (t, m, rr, x0, x1) => flatBed(t, m, rr, x0, x1, 'logs'), { bedL: 4.8, axles: 2 }) },
  { id: 'tanker', label: 'Tanker Truck', cat: TRUCK, build: (r, M, x) => rigidTruck(r, M, x, tankBed, { bedL: 4.5 }) },
  { id: 'dump', label: 'Dump Truck', cat: TRUCK, build: (r, M, x) => rigidTruck(r, M, x, dumpBed, { bedL: 4.0, paintHex: r.pick(['#e07b39', '#e3c53a', '#c63d3d']), beacon: '#ffb03a' }) },
  { id: 'mixer', label: 'Cement Mixer', cat: TRUCK, build: (r, M, x) => rigidTruck(r, M, x, mixerBed, { bedL: 3.9, paintHex: r.pick(['#e06d21', '#dfbd25', '#2668bd', '#c92f2f']), beacon: '#ffb03a', stacks: false }) },
  { id: 'garbage', label: 'Garbage Truck', cat: TRUCK, build: (r, M, x) => rigidTruck(r, M, x, garbageBed, { bedL: 4.3, paintHex: r.pick(['#2e8442', '#e06d21', '#2668bd']), stacks: false }) },
  { id: 'tow', label: 'Tow Truck', cat: TRUCK, build: (r, M, x) => rigidTruck(r, M, x, towBed, { bedL: 3.6, nose: r.range(0.9, 1.2), beacon: '#ffb03a' }) },
  { id: 'plow', label: 'Snow Plow', cat: TRUCK, build: (r, M, x) => rigidTruckWithRef(r, M, x, dumpBed, { paintHex: r.pick(['#e07b39', '#e3c53a']), beacon: '#ffb03a', bedL: 3.8, nose: 0, plow: true }) },
  { id: 'firetruck', label: 'Fire Truck', cat: SVC, build: (r, M, x) => rigidTruckWithRef(r, M, x, fireBody, { paintHex: '#c22a24', bedL: 4.6, nose: 0, W: 2.4, lightbarOnCab: true }) },
  { id: 'armytruck', label: 'Army Truck', cat: TRUCK, build: (r, M, x) => rigidTruck(r, M, x, armyBed, { bedL: 4.2, paintHex: r.pick(['#5a6b46', '#4f5f3f', '#6b6f4a']), nose: r.range(0.9, 1.2), axles: 2, stacks: false }) },
  { id: 'semibox', label: 'Semi — Box Trailer', cat: TRUCK, build: (r, M, x) => semi(r, M, x, (rr, m, g, x1) => boxTrailer(rr, m, g, x1)) },
  { id: 'semitank', label: 'Semi — Tanker', cat: TRUCK, build: (r, M, x) => semi(r, M, x, tankTrailer) },
  { id: 'semilogs', label: 'Semi — Log Hauler', cat: TRUCK, build: (r, M, x) => semi(r, M, x, (rr, m, g, x1) => flatTrailer(rr, m, g, x1, 'logs')) },
  { id: 'semiflat', label: 'Semi — Flatbed', cat: TRUCK, build: (r, M, x) => semi(r, M, x, (rr, m, g, x1) => flatTrailer(rr, m, g, x1)) },
  { id: 'semicontainer', label: 'Semi — Container', cat: TRUCK, build: (r, M, x) => semi(r, M, x, containerTrailer) },
  { id: 'carcarrier', label: 'Semi — Car Carrier', cat: TRUCK, build: (r, M, x) => semi(r, M, x, carCarrierTrailer) },
  { id: 'roadtrain', label: 'Road Train', cat: TRUCK, build: buildRoadTrain },
  { id: 'crane', label: 'Crane Truck', cat: TRUCK, build: buildCraneTruck },

  { id: 'bulldozer', label: 'Bulldozer', cat: CONS, build: buildBulldozer },
  { id: 'excavator', label: 'Excavator', cat: CONS, build: buildExcavator },
  { id: 'loader', label: 'Wheel Loader', cat: CONS, build: buildWheelLoader },
  { id: 'roller', label: 'Road Roller', cat: CONS, build: buildRoller },
  { id: 'haultruck', label: 'Mining Hauler', cat: CONS, build: buildHaulTruck },

  { id: 'tram', label: 'Tram', cat: RAIL, build: buildTram },

  { id: 'police', label: 'Police Car', cat: SVC, build: (r, M, x) => { const c = car(r, M, x, { paintHex: '#2a2d33', lightbar: true, pushBar: true, mirrorP: 0.9 }); P.sideStripe(c.g, M, { x0: -0.95, x1: 0.95, y: c.clear + c.bodyH * 0.55, w: c.W, hex: '#e8e9eb', h: 0.22 }); return c.g; } },
  { id: 'policesuv', label: 'Police SUV', cat: SVC, build: (r, M, x) => { const c = car(r, M, x, { L: 4.75, W: 1.98, bodyH: 0.72, clear: 0.44, wheelR: 0.43, cabL: 2.6, cabX: -0.5, cabH: 0.62, rakeF: 0.4, rakeR: 0.22, sideCols: 3, paintHex: '#2a2d33', lightbar: true, pushBar: true }); P.sideStripe(c.g, M, { x0: -1.1, x1: 1.1, y: c.clear + c.bodyH * 0.5, w: c.W, hex: '#e8e9eb', h: 0.24 }); return c.g; } },
  { id: 'taxi', label: 'Taxi', cat: SVC, build: (r, M, x) => { const c = car(r, M, x, { paintHex: '#efc324', taxiSign: true }); P.checkerBand(c.g, M, { x0: -1.4, x1: 1.4, y: c.clear + c.bodyH * 0.42, w: c.W, sq: 0.11 }); return c.g; } },
  { id: 'ambulance', label: 'Ambulance', cat: SVC, build: buildAmbulance },
  { id: 'mail', label: 'Mail Van', cat: SVC, build: (r, M, x) => van(r, M, x, { paintHex: '#e8e9eb', stripeHex: '#2f5f9e', rearWindow: false, L: 4.6, H: 1.9 }).g },
  { id: 'icecream', label: 'Ice Cream Truck', cat: SVC, build: buildIcecream },
  { id: 'foodtruck', label: 'Food Truck', cat: SVC, build: buildFoodtruck },
  { id: 'firechief', label: 'Fire Chief SUV', cat: SVC, build: (r, M, x) => { const c = car(r, M, x, { L: 4.75, W: 1.98, bodyH: 0.72, clear: 0.44, wheelR: 0.43, cabL: 2.6, cabX: -0.5, cabH: 0.62, rakeF: 0.4, rakeR: 0.22, sideCols: 3, paintHex: '#c22a24', lightbar: true }); P.sideStripe(c.g, M, { x0: -1.5, x1: 1.5, y: c.clear + c.bodyH * 0.5, w: c.W, hex: '#e6e7e9', h: 0.16 }); return c.g; } },
  { id: 'swat', label: 'SWAT Van', cat: SVC, build: (r, M, x) => { const v = van(r, M, x, { paintHex: '#22252a', L: 5.2, H: 2.15, noseCut: 0.3, rearWindow: false, stripeHex: '#4a4e55', stripeF: 0.42, stripeH: 0.22 }); P.lightbar(v.g, M, { x: v.L / 2 - 1.0, y: v.topY, w: v.W * 0.58 }); P.bullbar(v.g, M, { x: v.L / 2 + 0.1, y: v.clear + 0.35, w: v.W * 0.8 }); return v.g; } },

  { id: 'tractor', label: 'Farm Tractor', cat: SPEC, build: buildTractor },
  { id: 'forklift', label: 'Forklift', cat: SPEC, build: buildForklift },
  { id: 'golfcart', label: 'Golf Cart', cat: SPEC, build: buildGolfcart },
  { id: 'tuktuk', label: 'Tuk-Tuk', cat: SPEC, build: buildTuktuk },
  { id: 'snowmobile', label: 'Snowmobile', cat: SPEC, build: buildSnowmobile },
  { id: 'caravan', label: 'Car + Caravan', cat: SPEC, build: buildCaravanCombo },
  { id: 'pickupcamper', label: 'Pickup + Caravan', cat: SPEC, build: buildPickupCamper },
  { id: 'suvboat', label: 'SUV + Boat Trailer', cat: SPEC, build: buildSuvBoat },
  { id: 'tractorhay', label: 'Tractor + Hay Trailer', cat: SPEC, build: buildTractorHay },
];

// rigid truck variant that also decorates the cab (fire lightbar / plow blade)
function rigidTruckWithRef(r, M, ctx, kind, o) {
  const t = truckFront(r, M, ctx, { nose: o.nose, paintHex: o.paintHex, W: o.W || 2.35, beaconHex: o.beacon, stacks: false });
  const bedL = r.jitter(o.bedL || 4.3, 0.06);
  const x1 = t.cabRearX - 0.14, x0 = x1 - bedL;
  chassis(t, M, x0 + 0.15, { axles: bedL > 4.4 ? 2 : 1, dual: true });
  kind(t, M, r, x0, x1);
  if (o.lightbarOnCab) P.lightbar(t.g, M, { x: (t.cpt.x0t + t.cpt.x1t) / 2, y: t.clear + t.cabH, w: t.W * 0.6 });
  if (o.plow) plowBlade(t, M);
  P.bumper(t.g, M, { x: x0 - 0.06, y: t.clear + 0.05, w: t.W * 0.9, hex: '#33373d' });
  return t.g;
}

export function buildVehicle(seed, typeId = 'any', paint = null) {
  const rT = makeRng('t:' + seed);
  let entry = REG.find((e) => e.id === typeId);
  if (!entry) entry = rT.pick(REG);
  const r = makeRng('b:' + seed + ':' + entry.id);
  const M = matFactory();
  // 1-in-100 golden vehicle — own rng stream, only when no explicit paint override
  const golden = !paint && makeRng('gold:' + seed).chance(0.01);
  const ctx = { paint: paint || (golden ? GOLD : null) };
  const g = entry.build(r, M, ctx);
  const bb = new THREE.Box3().setFromObject(g);
  const c = bb.getCenter(new THREE.Vector3());
  g.position.x -= c.x;
  g.position.z -= c.z;
  const wrap = new THREE.Group();
  wrap.add(g);
  let name = genName(makeRng('n:' + seed + ':' + entry.id), entry.id);
  if (golden) name = '✨ ' + name + ' ✨';
  return { group: wrap, name, typeLabel: entry.label, typeId: entry.id, seed: String(seed), golden };
}
