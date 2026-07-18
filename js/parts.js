// parts.js — wheels, lights and accessory builders shared by all vehicles
import * as THREE from 'three';
import { box, cyl, slab, sphere, quadPrism, subQuad, faceQuad } from './lib.js';

/* ---------------- wheels ---------------- */
export function wheel(M, r, w, o = {}) {
  const g = new THREE.Group();
  const seg = o.seg || 12;
  g.add(cyl(M('#232629', { rough: 0.95, env: 0.25 }), { r, len: w, axis: 'z', seg }));
  if (o.white) g.add(cyl(M('#e7e4da', { rough: 0.85 }), { r: r * 0.76, len: w * 1.06, axis: 'z', seg }));
  const hubHex = o.hub || '#c9ced4';
  g.add(cyl(M(hubHex, { rough: 0.32, metal: 0.75, env: 1.1 }), { r: r * (o.hubR || 0.58), len: w * 1.1, axis: 'z', seg }));
  return g;
}

// One axle: wheels both sides (+optional dual pairs / visible axle rod)
export function axle(g, M, o) {
  const { x, track, r, w } = o;
  const y = o.y !== undefined ? o.y : r;
  for (const s of [-1, 1]) {
    const wh = wheel(M, r, w, o);
    wh.position.set(x, y, s * track / 2);
    g.add(wh);
    if (o.dual) {
      const w2 = wheel(M, r, w, o);
      w2.position.set(x, y, s * (track / 2 - w * 1.12));
      g.add(w2);
    }
  }
  if (o.rod) {
    const rod = cyl(M('#33373d', { rough: 0.6 }), { r: Math.max(0.05, r * 0.13), len: track, axis: 'z', seg: 8 });
    rod.position.set(x, y, 0);
    g.add(rod);
  }
}

/* ---------------- face details (always flush, even on sloped faces) ---------------- */
export function facePane(g, pt, side, fr, mat, t = 0.03, off = 0.01) {
  g.add(quadPrism(subQuad(faceQuad(pt, side), fr[0], fr[1], fr[2], fr[3]), t, mat, off));
}
export function headlightsOn(g, M, pt, o = {}) {
  const { v0 = 0.5, v1 = 0.78, w = 0.17, edge = 0.07, hex = '#ffedb8' } = o;
  const mat = M(hex, { rough: 0.25, env: 1.2, emissive: '#ffd98a', emInt: 0.5 });
  facePane(g, pt, 'front', [edge, edge + w, v0, v1], mat, 0.035);
  facePane(g, pt, 'front', [1 - edge - w, 1 - edge, v0, v1], mat, 0.035);
}
export function taillightsOn(g, M, pt, o = {}) {
  const { v0 = 0.5, v1 = 0.76, w = 0.13, edge = 0.06 } = o;
  const mat = M('#d8402f', { rough: 0.3, env: 1, emissive: '#c81f10', emInt: 0.55 });
  facePane(g, pt, 'rear', [edge, edge + w, v0, v1], mat, 0.03);
  facePane(g, pt, 'rear', [1 - edge - w, 1 - edge, v0, v1], mat, 0.03);
}
export function grilleOn(g, M, pt, o = {}) {
  const { f0 = 0.32, f1 = 0.68, v0 = 0.14, v1 = 0.42 } = o;
  facePane(g, pt, 'front', [f0, f1, v0, v1], M('#272a2f', { rough: 0.7 }), 0.025);
}

/* ---------------- chrome & body bits ---------------- */
export function bumper(g, M, o) {
  const { x, w, y, h = 0.13, d = 0.16, hex = '#c9ced4' } = o;
  const b = box(M(hex, { rough: 0.35, metal: 0.55, env: 0.9 }), d, h, w);
  b.position.set(x, y, 0);
  g.add(b);
}
export function mirrors(g, M, o) {
  const { x, y, w, hex = '#2c2f34' } = o;
  for (const s of [-1, 1]) {
    const stalk = box(M(hex, { rough: 0.6 }), 0.05, 0.04, 0.16);
    stalk.position.set(x, y, s * (w / 2 + 0.03));
    g.add(stalk);
    const m = box(M(hex, { rough: 0.6 }), 0.05, 0.14, 0.09);
    m.position.set(x, y + 0.02, s * (w / 2 + 0.13));
    g.add(m);
  }
}
export function sideStripe(g, M, o) {
  const { x0, x1, y, h = 0.1, w, hex } = o;
  const mat = M(hex, { rough: 0.5 });
  for (const s of [-1, 1]) {
    const b = box(mat, x1 - x0, h, 0.03);
    b.position.set((x0 + x1) / 2, y, s * (w / 2 + 0.005));
    g.add(b);
  }
}
export function racingStripes(g, M, o) {
  const { x0, x1, y, hex = '#eceff1', w2 = 0.16, gap = 0.1 } = o;
  const mat = M(hex, { rough: 0.5 });
  for (const s of [-1, 1]) {
    const b = box(mat, x1 - x0, 0.018, w2);
    b.position.set((x0 + x1) / 2, y + 0.005, s * (gap / 2 + w2 / 2));
    g.add(b);
  }
}

/* ---------------- roof accessories ---------------- */
export function lightbar(g, M, o) {
  const { x, y, w } = o;
  const base = box(M('#2a2d31', { rough: 0.7 }), 0.46, 0.06, w);
  base.position.set(x, y + 0.03, 0);
  g.add(base);
  const rM = M('#e04338', { rough: 0.25, env: 1.2, emissive: '#ff2a1e', emInt: 0.9 });
  const bM = M('#3a7bd5', { rough: 0.25, env: 1.2, emissive: '#1a5cff', emInt: 0.9 });
  for (const [mat, s] of [[rM, -1], [bM, 1]]) {
    const b = box(mat, 0.4, 0.11, w * 0.44);
    b.position.set(x, y + 0.115, s * w * 0.24);
    g.add(b);
  }
}
export function beacon(g, M, o) {
  const { x, y, hex = '#ffb03a', r = 0.09 } = o;
  const b = cyl(M(hex, { rough: 0.25, env: 1.2, emissive: hex, emInt: 0.9 }), { r, len: 0.12, seg: 8 });
  b.position.set(x, y + 0.06, o.z || 0);
  g.add(b);
}
export function taxiSign(g, M, o) {
  const { x, y } = o;
  const s = box(M('#f4f1e6', { rough: 0.4, emissive: '#fff6d8', emInt: 0.35 }), 0.5, 0.2, 0.14);
  s.position.set(x, y + 0.1, 0);
  g.add(s);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const dot = box(M('#26292e', { rough: 0.6 }), 0.09, 0.09, 0.02);
      dot.position.set(x - 0.13 + i * 0.13, y + 0.1, side * 0.08);
      g.add(dot);
    }
  }
}
export function roofRack(g, M, o) {
  const { x0, x1, y, w } = o;
  const mat = M('#2c2f34', { rough: 0.6 });
  for (const s of [-1, 1]) {
    const rail = box(mat, x1 - x0, 0.05, 0.05);
    rail.position.set((x0 + x1) / 2, y + 0.05, s * w * 0.36);
    g.add(rail);
  }
  const n = Math.max(2, Math.round((x1 - x0) / 0.5));
  for (let i = 0; i < n; i++) {
    const bar = box(mat, 0.05, 0.04, w * 0.76);
    bar.position.set(x0 + ((i + 0.5) / n) * (x1 - x0), y + 0.05, 0);
    g.add(bar);
  }
}
export function ladderRack(g, M, o) { // fire ladder / roof ladder
  const { x, y, len, tilt = -0.06, silver = '#c9ced4' } = o;
  const lg = new THREE.Group();
  const mat = M(silver, { rough: 0.35, metal: 0.6, env: 1 });
  for (const s of [-1, 1]) {
    const rail = box(mat, len, 0.07, 0.06);
    rail.position.set(0, 0, s * 0.19);
    lg.add(rail);
  }
  const n = Math.round(len / 0.42);
  for (let i = 0; i < n; i++) {
    const rung = box(mat, 0.06, 0.05, 0.38);
    rung.position.set(-len / 2 + ((i + 0.5) / n) * len, 0, 0);
    lg.add(rung);
  }
  lg.position.set(x, y, 0);
  lg.rotation.z = tilt;
  g.add(lg);
}
export function spoiler(g, M, o) {
  const { x, y, w, h = 0.22, hex, big = false } = o;
  const mat = M(hex, { rough: 0.5 });
  for (const s of [-1, 1]) {
    const post = box(mat, 0.07, h, 0.07);
    post.position.set(x, y + h / 2, s * w * 0.32);
    g.add(post);
  }
  const wing = slab(mat, { x0: x - 0.16, x1: x + 0.16, y0: y + h, y1: y + h + 0.06, w: w * (big ? 1.06 : 0.92), wT: w * (big ? 1.0 : 0.86), nose: 0.1 });
  g.add(wing);
  if (big) {
    for (const s of [-1, 1]) {
      const plate = box(mat, 0.34, 0.16, 0.04);
      plate.position.set(x, y + h + 0.1, s * w * (big ? 0.53 : 0.46));
      g.add(plate);
    }
  }
}
export function exhaustStack(g, M, o) {
  const { x, z, y0, h } = o;
  const p = cyl(M('#c9ced4', { rough: 0.3, metal: 0.7, env: 1.1 }), { r: 0.07, len: h, seg: 8 });
  p.position.set(x, y0 + h / 2, z);
  g.add(p);
  const tip = cyl(M('#33373d', { rough: 0.6 }), { r: 0.075, len: 0.1, seg: 8 });
  tip.position.set(x, y0 + h + 0.04, z);
  g.add(tip);
}
export function bullbar(g, M, o) {
  const { x, y, w } = o;
  const mat = M('#33373d', { rough: 0.5, metal: 0.3 });
  for (const s of [-1, 0, 1]) {
    const v = box(mat, 0.06, 0.42, 0.06);
    v.position.set(x, y, s * w * 0.28);
    g.add(v);
  }
  for (const dy of [-0.12, 0.12]) {
    const hbar = box(mat, 0.07, 0.07, w * 0.66);
    hbar.position.set(x + 0.02, y + dy, 0);
    g.add(hbar);
  }
}
export function spareWheel(g, M, o) {
  const { x, y, r = 0.36, w = 0.22 } = o;
  const wh = wheel(M, r, w, o);
  wh.rotation.y = Math.PI / 2;
  wh.position.set(x, y, 0);
  g.add(wh);
}
export function hoodScoop(g, M, o) {
  const { x, y, hex } = o;
  g.add(Object.assign(slab(M(hex, { rough: 0.5 }), {
    x0: x - 0.28, x1: x + 0.28, y0: y, y1: y + 0.13, w: 0.5, wT: 0.4, nose: 0.22,
  }), {}));
}
export function coneOnRoof(g, M, o) { // ice cream!
  const { x, y } = o;
  const cone = cyl(M('#d9a05b', { rough: 0.7 }), { r: 0.34, r2: 0.05, len: 0.62, seg: 10 });
  cone.position.set(x, y + 0.31, 0);
  g.add(cone);
  const scoop = sphere(M('#f2b8cf', { rough: 0.55 }), 0.32, 1);
  scoop.position.set(x, y + 0.72, 0);
  g.add(scoop);
  const cherry = sphere(M('#c8332b', { rough: 0.4, env: 1 }), 0.1, 1);
  cherry.position.set(x, y + 1.0, 0);
  g.add(cherry);
}
export function awning(g, M, o) {
  const { x0, x1, y, z, side = 1, colors = ['#e05555', '#f2ead9'] } = o;
  const n = Math.max(3, Math.round((x1 - x0) / 0.3));
  const ag = new THREE.Group();
  for (let i = 0; i < n; i++) {
    const b = box(M(colors[i % 2], { rough: 0.7 }), (x1 - x0) / n, 0.03, 0.55);
    b.position.set(x0 + ((i + 0.5) / n) * (x1 - x0) - (x0 + x1) / 2, 0, 0);
    ag.add(b);
  }
  ag.position.set((x0 + x1) / 2, y, side * (z !== undefined ? z : 0.28));
  ag.rotation.x = side * 0.35;
  g.add(ag);
}
export function roofAC(g, M, o) {
  const b = box(M('#dfe2e6', { rough: 0.6 }), 0.8, 0.18, 0.6);
  b.position.set(o.x, o.y + 0.09, o.z || 0);
  g.add(b);
}

/* ---------------- cargo ---------------- */
export function logsLoad(g, M, o) {
  const { x0, x1, y, w } = o;
  const bark = M('#6d4a2b', { rough: 0.9 });
  const cut = M('#c8a06a', { rough: 0.8 });
  const rows = [[-1, 0, 1], [-0.5, 0.5], [0]];
  let yy = y;
  const R = 0.21;
  for (const row of rows) {
    for (const k of row) {
      const log = new THREE.Mesh(new THREE.CylinderGeometry(R, R, x1 - x0, 9), [bark, cut, cut]);
      log.castShadow = log.receiveShadow = true;
      log.rotation.z = -Math.PI / 2;
      log.position.set((x0 + x1) / 2, yy + R, k * (w * 0.3));
      g.add(log);
    }
    yy += R * 1.75;
  }
}
export function cratesLoad(g, M, o) {
  const { r, x0, x1, y, w } = o;
  const n = r.int(2, 4);
  for (let i = 0; i < n; i++) {
    const s = r.range(0.45, 0.75);
    const b = box(M(r.pick(['#b08a54', '#c49a6c', '#9a7443']), { rough: 0.85 }), s, s, s);
    b.position.set(r.range(x0 + s / 2, x1 - s / 2), y + s / 2, r.range(-(w / 2 - s / 2), w / 2 - s / 2) * 0.7);
    b.rotation.y = r.range(-0.3, 0.3);
    g.add(b);
  }
}
export function barrelsLoad(g, M, o) {
  const { r, x0, x1, y, w } = o;
  const n = r.int(2, 5);
  for (let i = 0; i < n; i++) {
    const b = cyl(M(r.pick(['#3a76c4', '#c63d3d', '#3e8948', '#c9ced4']), { rough: 0.5, metal: 0.2 }), { r: 0.26, len: 0.62, seg: 10 });
    b.position.set(r.range(x0 + 0.3, x1 - 0.3), y + 0.31, r.range(-1, 1) * (w / 2 - 0.32));
    g.add(b);
  }
}

/* ---------------- misc structures ---------------- */
export function post(g, M, o) {
  const { x, z, y0, y1, hex = '#2c2f34', t = 0.07 } = o;
  const p = box(M(hex, { rough: 0.6 }), t, y1 - y0, t);
  p.position.set(x, (y0 + y1) / 2, z);
  g.add(p);
}
export function towHitch(g, M, x, y) {
  const b = box(M('#33373d', { rough: 0.6 }), 0.3, 0.08, 0.08);
  b.position.set(x - 0.1, y, 0);
  g.add(b);
}
