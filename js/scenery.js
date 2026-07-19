// scenery.js — seeded procedural scenery library (world-building P1).
//
// Mirrors vehicles.js: a registry of builders on top of the lib.js geometry
// kit, same determinism contract (same kind+seed ⇒ identical model, zero
// Math.random()). Each builder returns { g, bodies } in prop space (ground =
// y 0, forward = +X) with EXPLICIT collider recipes for physics.js
// (_addPropRig) — never parsed from geometry. Light objects are dynamic
// (knockable: cones, signs, bins, even trees topple), heavy ones fixed.
// Sign text uses in-memory CanvasTexture only — purely visual, guarded so
// headless node builds still work (plain-color fallback).
import * as THREE from 'three';
import {
  makeRng, matFactory, slab, faceQuad, subQuad, quadPrism, panesOnQuad,
  box, cyl, sphere, shade, jitterColor, clamp,
} from './lib.js';
import * as P from './parts.js';

/* ================= shared helpers ================= */
const HAS_DOC = typeof document !== 'undefined';
const IDQ = [0, 0, 0, 1];
const boxSh = (hx, hy, hz, x = 0, y = 0, z = 0) => ({ kind: 'box', he: [hx, hy, hz], pos: [x, y, z], rot: IDQ });
const cylSh = (hh, r, x = 0, y = 0, z = 0) => ({ kind: 'cyl', hh, r, pos: [x, y, z], rot: IDQ });
const quatArr = (rx, ry, rz) => {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz));
  return [q.x, q.y, q.z, q.w];
};
function coneSh(rBase, h, y0, n = 8) {
  const pts = new Float32Array((n + 1) * 3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts[i * 3] = Math.cos(a) * rBase; pts[i * 3 + 1] = y0; pts[i * 3 + 2] = Math.sin(a) * rBase;
  }
  pts[n * 3 + 1] = y0 + h;
  return { kind: 'hull', pts };
}
// convex hull straight from a slab's userData.pt (optionally offset)
function hullFromPt(pt, dx = 0, dz = 0) {
  const zb = pt.zb / 2, zt = pt.zt / 2;
  const c = [
    [pt.x0b, pt.y0, -zb], [pt.x1b, pt.y0, -zb], [pt.x1b, pt.y0, zb], [pt.x0b, pt.y0, zb],
    [pt.x0t, pt.y1, -zt], [pt.x1t, pt.y1, -zt], [pt.x1t, pt.y1, zt], [pt.x0t, pt.y1, zt],
  ];
  const pts = new Float32Array(24);
  c.forEach((p, i) => { pts[i * 3] = p[0] + dx; pts[i * 3 + 1] = p[1]; pts[i * 3 + 2] = p[2] + dz; });
  return { kind: 'hull', pts };
}
const fixedBody = (g, shapes, fr = 0.7, rest = 0.08) =>
  [{ node: g, fixed: true, friction: fr, restitution: rest, shapes }];

// dynamic root body: re-roots the visuals so the body origin sits at H/2
// (stable COM start, pole-style — see props.js pole) and shifts the shapes,
// which builders write in plain ground coordinates, to match.
function dynGround(g, H, mass, shapes, o = {}) {
  const y = H / 2;
  const inner = new THREE.Group();
  while (g.children.length) inner.add(g.children[0]);
  inner.position.y = -y;
  g.add(inner);
  const shifted = shapes.map((s) => {
    if (s.kind === 'hull') {
      const pts = new Float32Array(s.pts);
      for (let i = 1; i < pts.length; i += 3) pts[i] -= y;
      return { kind: 'hull', pts };
    }
    return { ...s, pos: [s.pos[0], s.pos[1] - y, s.pos[2]] };
  });
  return [{
    node: g, fixed: false, mass, y, shapes: shifted,
    friction: o.fr === undefined ? 0.6 : o.fr,
    restitution: o.rest === undefined ? 0.15 : o.rest,
  }];
}

// weld-jitter: same offset per position-welded vertex group so flat-shaded
// faces never tear (deform.js trick) — organic canopies/rocks from primitives
function jitterGeo(mesh, r, amp) {
  const pos = mesh.geometry.attributes.position;
  const groups = new Map();
  for (let i = 0; i < pos.count; i++) {
    const k = Math.round(pos.getX(i) * 200) + ',' + Math.round(pos.getY(i) * 200) + ',' + Math.round(pos.getZ(i) * 200);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  }
  for (const idx of groups.values()) {
    const dx = r.range(-amp, amp), dy = r.range(-amp, amp), dz = r.range(-amp, amp);
    for (const i of idx) pos.setXYZ(i, pos.getX(i) + dx, pos.getY(i) + dy, pos.getZ(i) + dz);
  }
  pos.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
}

// canvas-textured material (sign faces, billboards). Visual only; falls back
// to a flat color in headless node where document doesn't exist.
function canvasMat(w, h, draw, o = {}) {
  if (!HAS_DOC) return new THREE.MeshStandardMaterial({ color: o.fallback || '#e8e9eb', roughness: 0.5, flatShading: true });
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  const m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.45, flatShading: true });
  if (o.emissive) { m.emissive = new THREE.Color('#ffffff'); m.emissiveMap = t; m.emissiveIntensity = o.emissive; }
  return m;
}

// sign plate: textured face toward +X, plain gray back — thin like real signs
function plate(g, geo, faceMat, backMat, y, x = 0) {
  const f = new THREE.Mesh(geo, faceMat);
  f.rotation.y = Math.PI / 2;
  f.position.set(x + 0.006, y, 0);
  f.castShadow = true;
  g.add(f);
  const b = new THREE.Mesh(geo.clone(), backMat);
  b.rotation.y = -Math.PI / 2;
  b.position.set(x - 0.006, y, 0);
  g.add(b);
}
function signPost(g, M, h, r = 0.035) {
  const p = cyl(M('#9aa0a7', { rough: 0.45, metal: 0.5, env: 0.9 }), { r, len: h, seg: 8 });
  p.position.y = h / 2;
  g.add(p);
  const base = cyl(M('#5c6167', { rough: 0.8 }), { r: r * 2.6, len: 0.05, seg: 8 });
  base.position.y = 0.025;
  g.add(base);
}

/* ================= palettes ================= */
const GREENS = ['#5fa348', '#4c8c3f', '#6fb04c', '#3f7d3a', '#7ba85a', '#568f4e'];
const PINES = ['#3f7d4a', '#356e40', '#2e6339', '#48855a'];
const BLOSSOM = ['#d98cb0', '#e0a3c0', '#d9793f', '#c9a03a', '#c46a9a'];
const BARK = ['#6d4a2b', '#7a5233', '#5e4023', '#8a6a4a'];
const ROCKS = ['#8d9096', '#7c7f86', '#9aa0a7', '#84888f'];
const WALLS = ['#e8dcc0', '#dfe2e6', '#cfd8cf', '#d9c7a8', '#c8d6e4', '#e2cfc0', '#b9c8b0', '#e6e0d0', '#d8b8a8'];
const ROOFS = ['#4a4e55', '#743a30', '#5a4633', '#3a4a5e', '#7c3b34', '#33373d', '#2f5a68'];
const DOORS = ['#7a4a2b', '#3a5e8c', '#8c3a34', '#3d4147', '#2e6339'];
const ACCENTS = ['#c9302c', '#e07b39', '#3a76c4', '#3e8948', '#e3c53a', '#8c5a9e'];

function canopy(M, r, hex, rad, o = {}) {
  const m = sphere(M(hex, { rough: 0.88, env: 0.3 }), rad, o.detail === undefined ? 0 : o.detail);
  jitterGeo(m, r, rad * (o.jit === undefined ? 0.16 : o.jit));
  m.scale.set(r.jitter(1, 0.08), r.jitter(o.squash === undefined ? 0.92 : o.squash, 0.1), r.jitter(1, 0.08));
  m.rotation.y = r.range(0, Math.PI * 2);
  return m;
}
function trunk(g, M, r, h, rad) {
  const t = cyl(M(r.pick(BARK), { rough: 0.92, env: 0.25 }), { r: rad * 0.8, r2: rad, len: h, seg: 7 });
  // cyl(): r2 is the TOP radius — pass the taper so trunks are wider at ground
  t.position.y = h / 2;
  g.add(t);
  return t;
}

/* ================= nature ================= */
function treeRound(r, M) {
  const g = new THREE.Group();
  const tH = r.range(1.1, 1.5), tR = r.range(0.1, 0.15);
  trunk(g, M, r, tH + 0.3, tR); // trunk runs into the canopy, never a gap
  const hex = jitterColor(r, r.pick(GREENS));
  const R1 = r.range(0.95, 1.35);
  const c1 = canopy(M, r, hex, R1);
  c1.position.y = tH + R1 * 0.85;
  g.add(c1);
  if (r.chance(0.5)) {
    const R2 = R1 * r.range(0.5, 0.68);
    const c2 = canopy(M, r, shade(hex, 0.05), R2);
    c2.position.set(r.range(-0.35, 0.35), tH + R1 * 1.4, r.range(-0.35, 0.35));
    g.add(c2);
  }
  const H = tH + R1 * 1.85;
  return { g, bodies: dynGround(g, H, 380 + R1 * 260, [
    cylSh(H / 2, tR * 2.1, 0, H / 2, 0),
    boxSh(R1 * 0.6, R1 * 0.58, R1 * 0.6, 0, tH + R1 * 0.85, 0),
  ], { fr: 0.7, rest: 0.08 }) };
}
function treeOak(r, M) {
  const g = new THREE.Group();
  const tH = r.range(1.4, 1.9), tR = r.range(0.16, 0.22);
  trunk(g, M, r, tH + 0.4, tR);
  const hex = jitterColor(r, r.pick(GREENS));
  const R = r.range(1.15, 1.5);
  const main = canopy(M, r, hex, R, { squash: 0.82 });
  main.position.y = tH + R * 0.78;
  g.add(main);
  const n = r.int(2, 3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + r.range(0, 1);
    const R2 = R * r.range(0.5, 0.68);
    const c = canopy(M, r, shade(hex, r.range(-0.04, 0.06)), R2);
    c.position.set(Math.cos(a) * R * 0.72, tH + R * r.range(0.62, 1.05), Math.sin(a) * R * 0.72);
    g.add(c);
    if (i < 2) { // visible branch feeding the side blob
      const br = cyl(M(r.pick(BARK), { rough: 0.9 }), { r: 0.05, len: R * 0.9, seg: 6 });
      br.position.set(Math.cos(a) * R * 0.36, tH + R * 0.42, Math.sin(a) * R * 0.36);
      br.rotation.z = Math.cos(a) * 0.7;
      br.rotation.x = -Math.sin(a) * 0.7;
      g.add(br);
    }
  }
  const H = tH + R * 1.85;
  return { g, bodies: dynGround(g, H, 700 + R * 300, [
    cylSh(H / 2, tR * 1.9, 0, H / 2, 0),
    boxSh(R * 0.85, R * 0.6, R * 0.85, 0, tH + R * 0.8, 0),
  ], { fr: 0.7, rest: 0.08 }) };
}
function treePine(r, M) {
  const g = new THREE.Group();
  const tH = r.range(0.5, 0.85);
  trunk(g, M, r, tH + 0.3, r.range(0.09, 0.13));
  const hex = jitterColor(r, r.pick(PINES));
  const tiers = r.int(3, 4);
  const baseR = r.range(0.85, 1.15);
  let y = tH;
  let H = tH;
  for (let i = 0; i < tiers; i++) {
    const k = 1 - i / tiers;
    const tierH = r.range(0.85, 1.1) * (0.7 + k * 0.4);
    const tier = cyl(M(i % 2 ? shade(hex, 0.04) : hex, { rough: 0.9, env: 0.25 }), { r: baseR * (0.35 + k * 0.65), r2: 0.03, len: tierH, seg: 8 });
    tier.position.y = y + tierH / 2;
    tier.rotation.y = r.range(0, 1);
    g.add(tier);
    y += tierH * 0.7; // clear tier separation — silhouettes read as stacked cones
    H = y + tierH * 0.42;
  }
  return { g, bodies: dynGround(g, H, 420 + H * 90, [
    cylSh(H / 2, 0.2, 0, H / 2, 0),
    coneSh(baseR * 0.8, H - tH - 0.2, tH + 0.1, 8),
  ], { fr: 0.7, rest: 0.06 }) };
}
function treeCypress(r, M) {
  const g = new THREE.Group();
  const tH = r.range(0.25, 0.45);
  trunk(g, M, r, tH + 0.2, 0.09);
  const hex = jitterColor(r, r.pick(PINES));
  const H1 = r.range(2.6, 3.4);
  const c = canopy(M, r, hex, 0.62, { squash: 1, jit: 0.12 });
  c.scale.y = H1 / 0.62 / 2;
  c.position.y = tH + H1 / 2;
  g.add(c);
  const top = canopy(M, r, shade(hex, 0.05), 0.3, { jit: 0.12 });
  top.scale.y = 1.8;
  top.position.y = tH + H1 * 0.96;
  g.add(top);
  const H = tH + H1 * 1.1;
  return { g, bodies: dynGround(g, H, 340, [cylSh(H / 2, 0.4, 0, H / 2, 0)], { fr: 0.7, rest: 0.06 }) };
}
function treePalm(r, M) {
  const g = new THREE.Group();
  const bark = M('#8a6a4a', { rough: 0.92 });
  const segs = 4;
  const lean = r.range(-0.14, 0.14);
  let x = 0, y = 0;
  for (let i = 0; i < segs; i++) {
    const len = 0.78;
    const seg = cyl(bark, { r: 0.13 - i * 0.015, r2: 0.115 - i * 0.015, len, seg: 7 });
    seg.position.set(x + Math.sin(lean * i) * 0.2, y + len / 2, 0);
    seg.rotation.z = lean * i;
    g.add(seg);
    x += Math.sin(lean * i) * len * 0.45;
    y += len * 0.94;
  }
  const topY = y + 0.1, topX = x;
  const hex = jitterColor(r, r.pick(['#4c9a4c', '#3f8c46', '#5aa350']));
  const n = r.int(6, 8);
  for (let i = 0; i < n; i++) {
    const frond = slab(M(i % 2 ? hex : shade(hex, -0.05), { rough: 0.85, env: 0.3 }), {
      x0: 0.1, x1: r.range(1.5, 1.9), y0: -0.03, y1: 0.03, w: 0.42, wT: 0.3, nose: 0.6,
    });
    const fg = new THREE.Group();
    fg.add(frond);
    fg.position.set(topX, topY, 0);
    fg.rotation.y = (i / n) * Math.PI * 2 + r.range(-0.2, 0.2);
    fg.rotation.z = -r.range(0.35, 0.6);
    g.add(fg);
  }
  for (let i = 0; i < r.int(2, 3); i++) {
    const nut = sphere(M('#6d4a2b', { rough: 0.8 }), 0.1, 0);
    nut.position.set(topX + r.range(-0.15, 0.15), topY - 0.12, r.range(-0.15, 0.15));
    g.add(nut);
  }
  const H = topY + 0.5;
  return { g, bodies: dynGround(g, H, 420, [
    cylSh(H / 2, 0.18, topX / 2, H / 2, 0),
    boxSh(0.7, 0.25, 0.7, topX, topY, 0),
  ], { fr: 0.7, rest: 0.08 }) };
}
function treeBlossom(r, M) {
  const g = new THREE.Group();
  const tH = r.range(1.2, 1.6);
  trunk(g, M, r, tH + 0.3, r.range(0.11, 0.16));
  const hex = jitterColor(r, r.pick(BLOSSOM));
  const R = r.range(1.0, 1.3);
  const c1 = canopy(M, r, hex, R, { squash: 0.85 });
  c1.position.y = tH + R * 0.82;
  g.add(c1);
  const c2 = canopy(M, r, shade(hex, 0.07), R * 0.55);
  c2.position.set(r.range(-0.4, 0.4), tH + R * 1.32, r.range(-0.4, 0.4));
  g.add(c2);
  const H = tH + R * 1.75;
  return { g, bodies: dynGround(g, H, 360 + R * 200, [
    cylSh(H / 2, 0.24, 0, H / 2, 0),
    boxSh(R * 0.62, R * 0.5, R * 0.62, 0, tH + R * 0.85, 0),
  ], { fr: 0.7, rest: 0.08 }) };
}
function bush(r, M) {
  const g = new THREE.Group();
  const hex = jitterColor(r, r.pick(GREENS));
  const n = r.int(1, 3);
  let R0 = 0;
  for (let i = 0; i < n; i++) {
    const R = r.range(0.32, 0.55);
    R0 = Math.max(R0, R);
    const c = canopy(M, r, i ? shade(hex, r.range(-0.05, 0.05)) : hex, R, { squash: 0.8 });
    c.position.set(i ? r.range(-0.35, 0.35) : 0, R * 0.62, i ? r.range(-0.35, 0.35) : 0);
    g.add(c);
  }
  if (r.chance(0.3)) { // berries
    for (let i = 0; i < 5; i++) {
      const b = sphere(M('#c9403a', { rough: 0.5, env: 0.8 }), 0.045, 0);
      const a = r.range(0, Math.PI * 2);
      b.position.set(Math.cos(a) * R0 * 0.8, R0 * r.range(0.5, 1.1), Math.sin(a) * R0 * 0.8);
      g.add(b);
    }
  }
  const H = R0 * 1.5;
  return { g, bodies: dynGround(g, H, 45, [boxSh(R0 * 0.8, H / 2, R0 * 0.8, 0, H / 2, 0)], { fr: 0.7, rest: 0.12 }) };
}
function hedge(r, M) {
  const g = new THREE.Group();
  const len = r.range(1.8, 3.4), hH = r.range(0.72, 1.0), d = 0.7;
  const soil = box(M('#4e3a26', { rough: 0.95 }), len + 0.15, 0.07, d + 0.1);
  soil.position.y = 0.035;
  g.add(soil);
  const b = box(M(jitterColor(r, r.pick(GREENS)), { rough: 0.92, env: 0.25 }), len, hH, d);
  jitterGeo(b, r, 0.05);
  b.position.y = hH / 2 + 0.06;
  g.add(b);
  return { g, bodies: fixedBody(g, [boxSh(len / 2, hH / 2, d / 2, 0, hH / 2 + 0.06, 0)], 0.8, 0.1) };
}
function flowerHeads(g, M, r, x0, x1, z0, z1, y, n) {
  for (let i = 0; i < n; i++) {
    const x = r.range(x0, x1), z = r.range(z0, z1), h = r.range(0.16, 0.3);
    const stem = cyl(M('#4c8c3f', { rough: 0.85 }), { r: 0.014, len: h, seg: 5 });
    stem.position.set(x, y + h / 2, z);
    g.add(stem);
    const head = sphere(M(r.pick(['#e05555', '#e3c53a', '#e08cc0', '#f2f3f5', '#e07b39', '#8c7fd9']), { rough: 0.6, env: 0.5 }), r.range(0.05, 0.08), 0);
    head.position.set(x, y + h + 0.04, z);
    g.add(head);
  }
}
function flowerbed(r, M) {
  const g = new THREE.Group();
  const wood = M(r.pick(['#8a6a3f', '#75552f', '#9a7a4f']), { rough: 0.9 });
  const L = r.range(1.5, 2.0);
  const bed = slab(wood, { x0: -L / 2, x1: L / 2, y0: 0, y1: 0.4, w: 0.56, wT: 0.6 });
  g.add(bed);
  const soil = box(M('#4e3a26', { rough: 0.95 }), L - 0.12, 0.05, 0.44);
  soil.position.y = 0.38;
  g.add(soil);
  flowerHeads(g, M, r, -L / 2 + 0.15, L / 2 - 0.15, -0.16, 0.16, 0.4, r.int(6, 10));
  return { g, bodies: dynGround(g, 0.42, 90, [boxSh(L / 2, 0.21, 0.3, 0, 0.21, 0)], { fr: 0.7, rest: 0.1 }) };
}
function flowerpot(r, M) {
  const g = new THREE.Group();
  const pot = cyl(M(r.pick(['#b26a48', '#c9ccd2', '#3a5e8c', '#8c5a4a']), { rough: 0.75 }), { r: 0.26, r2: 0.33, len: 0.42, seg: 10 });
  pot.position.y = 0.21;
  g.add(pot);
  const soil = cyl(M('#4e3a26', { rough: 0.95 }), { r: 0.29, len: 0.03, seg: 10 });
  soil.position.y = 0.42;
  g.add(soil);
  if (r.chance(0.35)) { // small shrub instead of flowers
    const c = canopy(M, r, r.pick(GREENS), 0.3);
    c.position.y = 0.68;
    g.add(c);
  } else flowerHeads(g, M, r, -0.16, 0.16, -0.16, 0.16, 0.42, r.int(4, 6));
  return { g, bodies: dynGround(g, 0.44, 24, [cylSh(0.22, 0.33, 0, 0.22, 0)], { fr: 0.65, rest: 0.18 }) };
}
function reeds(r, M) {
  const g = new THREE.Group();
  const n = r.int(6, 9);
  for (let i = 0; i < n; i++) {
    const a = r.range(0, Math.PI * 2), d = r.range(0, 0.3);
    const h = r.range(0.6, 1.15);
    const stalk = cyl(M(r.pick(['#5a8a3c', '#6b9a48', '#4c7c34']), { rough: 0.85 }), { r: 0.02, len: h, seg: 5 });
    stalk.position.set(Math.cos(a) * d, h / 2, Math.sin(a) * d);
    stalk.rotation.x = r.range(-0.12, 0.12);
    stalk.rotation.z = r.range(-0.12, 0.12);
    g.add(stalk);
    if (r.chance(0.65)) {
      const tip = cyl(M('#6d4a2b', { rough: 0.9 }), { r: 0.045, len: 0.2, seg: 6 });
      tip.position.set(stalk.position.x - Math.sin(stalk.rotation.z) * h * 0.5, h * 0.92, stalk.position.z + Math.sin(stalk.rotation.x) * h * 0.5);
      g.add(tip);
    }
  }
  for (let i = 0; i < 5; i++) { // grass blades
    const blade = box(M('#6b9a48', { rough: 0.85 }), 0.035, r.range(0.25, 0.45), 0.012);
    blade.position.set(r.range(-0.35, 0.35), 0.16, r.range(-0.35, 0.35));
    blade.rotation.y = r.range(0, Math.PI);
    blade.rotation.z = r.range(-0.25, 0.25);
    g.add(blade);
  }
  return { g, bodies: [] }; // drive-through decor
}
function rock(r, M) {
  const g = new THREE.Group();
  const R = r.range(0.42, 0.95);
  const sy = r.range(0.55, 0.78);
  const m = sphere(M(jitterColor(r, r.pick(ROCKS), 0.004, 0.04, 0.05), { rough: 0.95, env: 0.25 }), R, 1);
  jitterGeo(m, r, R * 0.22);
  m.scale.set(r.jitter(1, 0.15), sy, r.jitter(1, 0.15));
  m.rotation.y = r.range(0, Math.PI * 2);
  m.position.y = R * sy * 0.62;
  g.add(m);
  if (r.chance(0.5)) {
    const R2 = R * r.range(0.35, 0.55);
    const m2 = sphere(M(r.pick(ROCKS), { rough: 0.95, env: 0.25 }), R2, 1);
    jitterGeo(m2, r, R2 * 0.2);
    m2.scale.y = 0.7;
    m2.position.set(r.sign() * R * 0.9, R2 * 0.42, r.range(-0.4, 0.4));
    g.add(m2);
  }
  const H = R * sy * 1.35;
  return { g, bodies: dynGround(g, H, 220 + R * 480, [boxSh(R * 0.78, H / 2, R * 0.78, 0, H / 2, 0)], { fr: 0.85, rest: 0.05 }) };
}
function pond(r, M) {
  const g = new THREE.Group();
  const R = r.range(1.5, 2.1);
  const water = new THREE.Mesh(new THREE.CircleGeometry(R, 16), M('#4b90c9', { rough: 0.12, env: 1.6 }));
  water.rotation.x = -Math.PI / 2;
  water.position.y = 0.02;
  water.receiveShadow = true;
  g.add(water);
  const n = r.int(9, 13);
  for (let i = 0; i < n; i++) { // rock rim
    const a = (i / n) * Math.PI * 2 + r.range(-0.1, 0.1);
    const rr = r.range(0.13, 0.24);
    const m = sphere(M(r.pick(ROCKS), { rough: 0.95, env: 0.25 }), rr, 0);
    jitterGeo(m, r, rr * 0.25);
    m.scale.y = 0.65;
    m.position.set(Math.cos(a) * (R + 0.05), rr * 0.4, Math.sin(a) * (R + 0.05));
    g.add(m);
  }
  for (let i = 0; i < r.int(2, 4); i++) { // lily pads
    const pad = cyl(M('#4c8c3f', { rough: 0.8 }), { r: r.range(0.1, 0.17), len: 0.015, seg: 8 });
    const a = r.range(0, Math.PI * 2);
    pad.position.set(Math.cos(a) * R * r.range(0.2, 0.7), 0.035, Math.sin(a) * R * r.range(0.2, 0.7));
    g.add(pad);
  }
  if (r.chance(0.7)) {
    const { g: reedG } = reeds(r, M);
    const a = r.range(0, Math.PI * 2);
    reedG.position.set(Math.cos(a) * R * 0.8, 0, Math.sin(a) * R * 0.8);
    g.add(reedG);
  }
  return { g, bodies: [] };
}

/* ================= suburbia ================= */
function windowOn(g, M, pt, side, f0, f1, v0, v1, trimM, glassM) {
  g.add(quadPrism(subQuad(faceQuad(pt, side), f0 - 0.012, f1 + 0.012, v0 - 0.014, v1 + 0.014), 0.035, trimM, 0.012));
  g.add(quadPrism(subQuad(faceQuad(pt, side), f0, f1, v0, v1), 0.028, glassM, 0.032));
}
function house(r, M) {
  const g = new THREE.Group();
  const wallHex = jitterColor(r, r.pick(WALLS));
  const roofHex = r.pick(ROOFS);
  const wall = M(wallHex, { rough: 0.72, env: 0.35 });
  const trim = M(r.chance(0.75) ? '#f2f3f5' : shade(wallHex, 0.16), { rough: 0.6 });
  const roofM = M(roofHex, { rough: 0.85, env: 0.28 });
  const glass = M('#9fc0d8', { rough: 0.22, env: 1.2 });
  const doorM = M(r.pick(DOORS), { rough: 0.55 });
  const stories = r.chance(0.5) ? 2 : 1;
  const D = r.jitter(4.9, 0.06);                      // depth (x, door on +X)
  const W = r.jitter(stories === 2 ? 7.4 : 8.4, 0.08); // frontage (z)
  const y0 = 0.16;
  const wallTop = y0 + stories * 1.62;
  const rise = r.range(1.0, 1.45);
  const ov = 0.32;
  const hip = r.chance(0.4);

  // lawn + foundation
  if (r.chance(0.85)) {
    const lawn = box(M('#5d9448', { rough: 0.95, env: 0.2 }), D + 3.4, 0.05, W + 2.6);
    lawn.position.set(0.35, 0.025, 0);
    lawn.receiveShadow = true;
    g.add(lawn);
    const path = box(M('#9aa0a7', { rough: 0.9 }), 1.75, 0.055, 1.15);
    path.position.set(D / 2 + 0.85, 0.028, 0);
    g.add(path);
  }
  const found = box(M('#b3b8be', { rough: 0.9 }), D + 0.15, 0.18, W + 0.15);
  found.position.y = 0.09;
  g.add(found);

  // walls
  const body = slab(wall, { x0: -D / 2, x1: D / 2, y0, y1: wallTop, w: W });
  g.add(body);
  const pt = body.userData.pt;
  const vy = (y) => (y - y0) / (wallTop - y0);

  // door + windows
  windowOn(g, M, pt, 'front', 0.465, 0.535, vy(y0 + 0.02), vy(y0 + 1.34), trim, doorM); // door via same framing
  g.add(quadPrism(subQuad(faceQuad(pt, 'front'), 0.487, 0.513, vy(y0 + 0.6), vy(y0 + 0.72)), 0.02, M('#c9a03a', { rough: 0.35, metal: 0.6, env: 1 }), 0.062)); // handle plate
  const slots = W > 7.8 ? [0.13, 0.3, 0.7, 0.87] : [0.16, 0.32, 0.72, 0.88];
  const shutters = r.chance(0.5);
  const shutM = M(shade(roofHex, -0.04), { rough: 0.7 });
  for (let s = 1; s <= stories; s++) {
    const fy = y0 + (s - 1) * 1.62;
    const wv0 = vy(fy + 0.55), wv1 = vy(fy + 1.3);
    const row = s === 1 ? slots.filter((f) => Math.abs(f - 0.5) > 0.14) : (r.chance(0.6) ? slots : [0.2, 0.5, 0.8]);
    for (const f of row) {
      windowOn(g, M, pt, 'front', f - 0.045, f + 0.045, wv0, wv1, trim, glass);
      if (shutters) {
        P.facePane(g, pt, 'front', [f - 0.073, f - 0.053, wv0, wv1], shutM, 0.028, 0.01);
        P.facePane(g, pt, 'front', [f + 0.053, f + 0.073, wv0, wv1], shutM, 0.028, 0.01);
      }
    }
    for (const side of ['left', 'right']) {
      for (const f of r.chance(0.7) ? [0.3, 0.7] : [0.5]) {
        windowOn(g, M, pt, side, f - 0.07, f + 0.07, wv0, wv1, trim, glass);
      }
    }
    windowOn(g, M, pt, 'rear', 0.32, 0.42, wv0, wv1, trim, glass);
    windowOn(g, M, pt, 'rear', 0.58, 0.68, wv0, wv1, trim, glass);
  }

  // roof (ridge along z; hip also pulls the ridge ends in)
  const roof = slab(roofM, {
    x0: -D / 2 - ov, x1: D / 2 + ov, y0: wallTop - 0.02, y1: wallTop + rise,
    w: W + ov * 2, wT: hip ? (W + ov * 2) * r.range(0.4, 0.55) : W + ov * 2 - 0.1,
    nose: (D + ov * 2) / 2 - 0.09, tail: (D + ov * 2) / 2 - 0.09,
  });
  g.add(roof);
  const roofPt = roof.userData.pt;

  // chimney
  if (r.chance(0.55)) {
    const cz = r.range(-W * 0.28, W * 0.28);
    const ch = box(M('#8c5a4a', { rough: 0.9 }), 0.44, rise + 0.75, 0.44);
    ch.position.set(r.range(-0.5, 0.5), wallTop + (rise + 0.75) / 2 - 0.15, cz);
    g.add(ch);
    const cap = box(M('#6e4638', { rough: 0.9 }), 0.54, 0.1, 0.54);
    cap.position.set(ch.position.x, wallTop + rise + 0.62, cz);
    g.add(cap);
  }

  // porch
  if (r.chance(0.6)) {
    const Wp = r.range(2.7, 3.5);
    const floor = box(M('#c9ccd2', { rough: 0.85 }), 1.2, 0.14, Wp);
    floor.position.set(D / 2 + 0.6, 0.23, 0);
    g.add(floor);
    for (const sz of [-1, 1]) {
      const post = cyl(trim, { r: 0.055, len: 1.86, seg: 8 });
      post.position.set(D / 2 + 1.0, 0.3 + 0.93, sz * (Wp / 2 - 0.22));
      g.add(post);
    }
    const proof = slab(roofM, { x0: D / 2 - 0.12, x1: D / 2 + 1.32, y0: 2.16, y1: 2.48, w: Wp + 0.3, nose: 1.15 });
    g.add(proof);
  }

  // garage wing
  let garage = null;
  if (r.chance(0.6)) {
    const s = r.sign();
    const gw = 3.05, gh = 2.35, gd = D * 0.92;
    const zoff = s * (W / 2 + gw / 2 - 0.08);
    const sub = new THREE.Group();
    const gb = slab(wall, { x0: -gd / 2 + 0.2, x1: D / 2, y0, y1: gh, w: gw });
    sub.add(gb);
    const gpt = gb.userData.pt;
    // paneled garage door
    P.facePane(sub, gpt, 'front', [0.14, 0.86, 0.03, 0.76], M('#c9ccd2', { rough: 0.6 }), 0.045, 0.012);
    for (const v of [0.2, 0.39, 0.58]) {
      P.facePane(sub, gpt, 'front', [0.16, 0.84, v, v + 0.025], M('#a9adb4', { rough: 0.65 }), 0.02, 0.06);
    }
    const groof = slab(roofM, {
      x0: -gd / 2 + 0.08, x1: D / 2 + 0.28, y0: gh - 0.02, y1: gh + 0.6,
      w: gw + 0.45, wT: 0.2, nose: 0.1, tail: 0.1,
    });
    sub.add(groof);
    sub.position.z = zoff;
    g.add(sub);
    const drive = box(M('#9aa0a7', { rough: 0.9 }), 1.55, 0.055, gw - 0.5);
    drive.position.set(D / 2 + 0.75, 0.028, zoff);
    g.add(drive);
    garage = boxSh(gd / 2 + 0.05, gh / 2, gw / 2, (D / 2 - gd / 2 + 0.2) / 2 + 0.05, y0 + gh / 2 - 0.08, zoff);
  }

  // foundation shrubs
  for (const f of r.chance(0.7) ? [-0.35, 0.35] : []) {
    const c = canopy(M, r, r.pick(GREENS), r.range(0.3, 0.42), { squash: 0.75 });
    c.position.set(D / 2 + 0.35, 0.32, f * W * 0.8);
    g.add(c);
  }

  const shapes = [
    boxSh(D / 2, (wallTop - y0) / 2 + 0.08, W / 2, 0, (y0 + wallTop) / 2 - 0.08, 0),
    hullFromPt(roofPt),
  ];
  if (garage) shapes.push(garage);
  return { g, bodies: fixedBody(g, shapes, 0.8, 0.05) };
}
function shop(r, M) {
  const g = new THREE.Group();
  const wallHex = jitterColor(r, r.pick(WALLS));
  const accent = r.pick(ACCENTS);
  const wall = M(wallHex, { rough: 0.7, env: 0.35 });
  const glass = M('#8fb4cf', { rough: 0.2, env: 1.25 });
  const floors = r.int(1, 2) + (r.chance(0.25) ? 1 : 0);
  const D = r.jitter(4.9, 0.08), W = r.jitter(6.2, 0.1);
  const y0 = 0.12, fh = 1.72;
  const top = y0 + floors * fh;
  const found = box(M('#8d9096', { rough: 0.9 }), D + 0.1, 0.12, W + 0.1);
  found.position.y = 0.06;
  g.add(found);
  const body = slab(wall, { x0: -D / 2, x1: D / 2, y0, y1: top, w: W });
  g.add(body);
  const pt = body.userData.pt;
  const vy = (y) => (y - y0) / (top - y0);
  // storefront glazing + glass door
  g.add(panesOnQuad(faceQuad(pt, 'front'), glass, { cols: r.int(2, 3), gap: 0.03, f0: 0.08, f1: 0.62, v0: vy(y0 + 0.25), v1: vy(y0 + 1.42), t: 0.03 }));
  P.facePane(g, pt, 'front', [0.7, 0.85, vy(y0 + 0.02), vy(y0 + 1.42)], glass, 0.03, 0.012);
  // sign band above the storefront
  const band = box(M(accent, { rough: 0.55 }), 0.07, 0.46, W * 0.9);
  band.position.set(D / 2 + 0.035, y0 + fh - 0.12, 0);
  g.add(band);
  const letters = r.int(3, 5);
  for (let i = 0; i < letters; i++) {
    const chip = box(M('#f2f3f5', { rough: 0.5 }), 0.03, r.range(0.14, 0.22), r.range(0.16, 0.34));
    chip.position.set(D / 2 + 0.085, y0 + fh - 0.12, -W * 0.28 + (i / (letters - 1)) * W * 0.5);
    g.add(chip);
  }
  // upper windows
  for (let f = 2; f <= floors; f++) {
    const fy = y0 + (f - 1) * fh;
    g.add(panesOnQuad(faceQuad(pt, 'front'), glass, { cols: r.int(3, 4), gap: 0.04, f0: 0.1, f1: 0.9, v0: vy(fy + 0.5), v1: vy(fy + 1.32), t: 0.026 }));
    for (const side of ['left', 'right']) {
      g.add(panesOnQuad(faceQuad(pt, side), glass, { cols: 2, gap: 0.05, f0: 0.2, f1: 0.8, v0: vy(fy + 0.5), v1: vy(fy + 1.32), t: 0.026 }));
    }
  }
  // awning over the storefront
  if (r.chance(0.65)) {
    const aw = new THREE.Group();
    const n = 5, awW = W * 0.55;
    for (let i = 0; i < n; i++) {
      const slat = box(M(i % 2 ? '#f2f3f5' : accent, { rough: 0.7 }), 0.72, 0.028, awW / n);
      slat.position.z = -awW / 2 + (i + 0.5) * (awW / n);
      aw.add(slat);
    }
    aw.position.set(D / 2 + 0.32, y0 + fh - 0.42, -W * 0.14);
    aw.rotation.z = -0.32;
    g.add(aw);
  }
  // parapet + roof clutter
  const parapet = slab(M(shade(wallHex, -0.08), { rough: 0.7 }), { x0: -D / 2 - 0.06, x1: D / 2 + 0.06, y0: top - 0.02, y1: top + 0.34, w: W + 0.12 });
  g.add(parapet);
  const ac = box(M('#c9ccd2', { rough: 0.6 }), 0.75, 0.4, 0.6);
  ac.position.set(r.range(-D * 0.2, D * 0.2), top + 0.2, r.range(-W * 0.25, W * 0.25));
  g.add(ac);
  return { g, bodies: fixedBody(g, [boxSh(D / 2 + 0.06, (top + 0.34) / 2, W / 2 + 0.06, 0, (top + 0.34) / 2, 0)], 0.8, 0.05) };
}
function gazebo(r, M) {
  const g = new THREE.Group();
  const R = 1.9;
  const white = M('#eef0f2', { rough: 0.6 });
  const roofM = M(r.pick(['#33373d', '#4a4e55', '#5a4633']), { rough: 0.85 });
  const floor = cyl(M('#c9ccd2', { rough: 0.85 }), { r: R, len: 0.18, seg: 8 });
  floor.position.y = 0.09;
  g.add(floor);
  const shapes = [cylSh(0.09, R, 0, 0.09, 0)];
  const postR = R - 0.18;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    const x = Math.cos(a) * postR, z = Math.sin(a) * postR;
    const post = cyl(white, { r: 0.055, len: 1.9, seg: 7 });
    post.position.set(x, 0.18 + 0.95, z);
    g.add(post);
    shapes.push(boxSh(0.06, 0.95, 0.06, x, 1.13, z));
    if (k !== 0) { // k 0 stays open as the entrance
      const a2 = ((k + 1) % 8 / 8) * Math.PI * 2 + Math.PI / 8;
      const mx = (x + Math.cos(a2) * postR) / 2, mz = (z + Math.sin(a2) * postR) / 2;
      const rail = box(white, 0.06, 0.08, postR * 2 * Math.sin(Math.PI / 8) - 0.1);
      rail.position.set(mx, 0.72, mz);
      rail.rotation.y = -((a + a2) / 2) + Math.PI / 2;
      g.add(rail);
    }
  }
  const roof = cyl(roofM, { r: 0.12, len: 1.05, seg: 8 });
  // cyl(): r2 defaults to r — build the cone via CylinderGeometry directly for taper control
  roof.geometry.dispose();
  roof.geometry = new THREE.CylinderGeometry(0.12, R + 0.35, 1.05, 8);
  roof.position.y = 2.08 + 0.52;
  roof.rotation.y = Math.PI / 8;
  g.add(roof);
  const finial = sphere(white, 0.09, 0);
  finial.position.y = 3.24;
  g.add(finial);
  return { g, bodies: fixedBody(g, shapes, 0.75, 0.08) };
}
function fountain(r, M) {
  const g = new THREE.Group();
  const stone = M(r.pick(['#a3a8ae', '#b3b8be', '#98918a']), { rough: 0.88, env: 0.3 });
  const water = M('#3f86c9', { rough: 0.12, env: 0.9 }); // saturated so it reads against the stone
  const basin = cyl(stone, { r: 1.42, r2: 1.5, len: 0.42, seg: 12 });
  basin.position.y = 0.21;
  g.add(basin);
  const w1 = cyl(water, { r: 1.3, len: 0.03, seg: 12 });
  w1.position.y = 0.36;
  g.add(w1);
  const col = cyl(stone, { r: 0.2, r2: 0.14, len: 0.85, seg: 9 });
  col.position.y = 0.82;
  g.add(col);
  const bowl = cyl(stone, { r: 0.42, r2: 0.8, len: 0.26, seg: 10 });
  bowl.position.y = 1.32;
  g.add(bowl);
  const w2 = cyl(water, { r: 0.72, len: 0.025, seg: 10 });
  w2.position.y = 1.44;
  g.add(w2);
  const col2 = cyl(stone, { r: 0.1, len: 0.42, seg: 8 });
  col2.position.y = 1.62;
  g.add(col2);
  const bowl2 = cyl(stone, { r: 0.2, r2: 0.42, len: 0.18, seg: 9 });
  bowl2.position.y = 1.9;
  g.add(bowl2);
  const w3 = cyl(water, { r: 0.36, len: 0.02, seg: 9 });
  w3.position.y = 1.98;
  g.add(w3);
  const jet = cyl(water, { r: 0.05, r2: 0.03, len: 0.3, seg: 6 });
  jet.position.y = 2.13;
  g.add(jet);
  return { g, bodies: fixedBody(g, [cylSh(0.21, 1.5, 0, 0.21, 0), cylSh(0.85, 0.5, 0, 1.25, 0)], 0.7, 0.1) };
}
function picnicTable(r, M) {
  const g = new THREE.Group();
  const wood = M(jitterColor(r, r.pick(['#8a6a3f', '#75552f', '#9a7a4f'])), { rough: 0.9 });
  const top = box(wood, 1.8, 0.06, 0.78);
  top.position.y = 0.76;
  g.add(top);
  for (const s of [-1, 1]) {
    const bench = box(wood, 1.8, 0.05, 0.26);
    bench.position.set(0, 0.46, s * 0.62);
    g.add(bench);
    for (const sx of [-1, 1]) {
      const leg = box(wood, 0.07, 0.98, 0.06);
      leg.position.set(sx * 0.62, 0.42, s * 0.28);
      leg.rotation.x = s * 0.5;
      g.add(leg);
    }
  }
  for (const sx of [-1, 1]) {
    const brace = box(wood, 0.06, 0.05, 1.28);
    brace.position.set(sx * 0.62, 0.44, 0);
    g.add(brace);
  }
  return { g, bodies: dynGround(g, 0.8, 85, [
    boxSh(0.9, 0.04, 0.39, 0, 0.76, 0),
    boxSh(0.9, 0.03, 0.75, 0, 0.46, 0),
    boxSh(0.68, 0.36, 0.3, 0, 0.4, 0),
  ], { fr: 0.6, rest: 0.12 }) };
}
function bench(r, M) {
  // park bench along x: seat slats step in depth (z), backrest leans back
  const g = new THREE.Group();
  const slat = M(r.chance(0.5) ? '#2e6339' : jitterColor(r, '#8a6a3f'), { rough: 0.85 });
  const iron = M('#33373d', { rough: 0.6, metal: 0.3 });
  for (let i = 0; i < 3; i++) {
    const s = box(slat, 1.5, 0.045, 0.12);
    s.position.set(0, 0.48, 0.14 - i * 0.14);
    g.add(s);
  }
  for (let i = 0; i < 2; i++) {
    const y = 0.66 + i * 0.17;
    const s = box(slat, 1.5, 0.12, 0.04);
    s.position.set(0, y, -0.25 - (y - 0.48) * 0.22);
    s.rotation.x = 0.2;
    g.add(s);
  }
  for (const sx of [-1, 1]) { // cast-iron ends
    const leg = box(iron, 0.06, 0.48, 0.42);
    leg.position.set(sx * 0.66, 0.24, 0);
    g.add(leg);
    const back = box(iron, 0.06, 0.52, 0.05);
    back.position.set(sx * 0.66, 0.68, -0.28);
    back.rotation.x = 0.2;
    g.add(back);
    const arm = box(iron, 0.06, 0.05, 0.44);
    arm.position.set(sx * 0.66, 0.6, -0.04);
    g.add(arm);
  }
  return { g, bodies: dynGround(g, 0.95, 55, [
    boxSh(0.78, 0.25, 0.24, 0, 0.25, 0),
    boxSh(0.78, 0.22, 0.05, 0, 0.72, -0.3),
  ], { fr: 0.6, rest: 0.12 }) };
}
function playground(r, M) {
  const g = new THREE.Group();
  const [aHex, bHex, cHex] = r.pick([
    ['#c9403a', '#3a76c4', '#e3c53a'],
    ['#3a76c4', '#e3c53a', '#c9403a'],
    ['#3e8948', '#e07b39', '#3a76c4'],
  ]);
  const A = M(aHex, { rough: 0.55 }), B = M(bHex, { rough: 0.55 }), C = M(cHex, { rough: 0.55 });
  const steel = M('#c9ccd2', { rough: 0.4, metal: 0.4, env: 0.9 });
  // slide tower
  const tx = 1.1;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const post = box(A, 0.08, 2.06, 0.08); // posts reach the roof — nothing floats
    post.position.set(tx + sx * 0.5, 1.03, sz * 0.5);
    g.add(post);
  }
  const platform = box(C, 1.2, 0.07, 1.2);
  platform.position.set(tx, 1.3, 0);
  g.add(platform);
  for (const s of [-1, 1]) { // mini gable roof
    const panel = box(A, 1.25, 0.05, 0.72);
    panel.position.set(tx, 2.18, s * 0.3);
    panel.rotation.x = s * 0.62;
    g.add(panel);
  }
  // slide descends from the platform edge down to the ground (+x)
  const slide = box(B, 1.85, 0.05, 0.55);
  slide.position.set(tx + 1.32, 0.76, 0);
  slide.rotation.z = -0.6;
  g.add(slide);
  for (const s of [-1, 1]) {
    const rail = box(B, 1.85, 0.14, 0.04);
    rail.position.set(tx + 1.32, 0.83, s * 0.28);
    rail.rotation.z = -0.6;
    g.add(rail);
  }
  const slideEnd = box(B, 0.4, 0.05, 0.55); // flat run-out at the bottom
  slideEnd.position.set(tx + 2.28, 0.16, 0);
  g.add(slideEnd);
  // ladder on -x side
  for (const s of [-1, 1]) {
    const lr = box(steel, 0.05, 1.35, 0.05);
    lr.position.set(tx - 0.62, 0.675, s * 0.25);
    g.add(lr);
  }
  for (let i = 0; i < 4; i++) {
    const rung = box(steel, 0.04, 0.04, 0.5);
    rung.position.set(tx - 0.62, 0.28 + i * 0.32, 0);
    g.add(rung);
  }
  // swing frame along z
  const sx0 = -1.15;
  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) {
      const leg = box(A, 0.07, 2.15, 0.07);
      leg.position.set(sx0 + sx * 0.42, 1.02, sz * 1.45);
      leg.rotation.z = sx * 0.36;
      g.add(leg);
    }
  }
  const bar = box(A, 0.08, 0.08, 3.1);
  bar.position.set(sx0, 2.0, 0);
  g.add(bar);
  for (const sz of [-0.6, 0.6]) {
    for (const dz of [-0.22, 0.22]) {
      const chain = box(steel, 0.025, 1.45, 0.025);
      chain.position.set(sx0, 1.25, sz + dz);
      g.add(chain);
    }
    const seat = box(C, 0.42, 0.045, 0.22);
    seat.position.set(sx0, 0.52, sz);
    g.add(seat);
  }
  return { g, bodies: fixedBody(g, [
    boxSh(0.62, 0.85, 0.62, tx, 0.85, 0),
    { kind: 'box', he: [0.95, 0.04, 0.29], pos: [tx + 1.32, 0.76, 0], rot: quatArr(0, 0, -0.6) },
    boxSh(0.34, 1.05, 0.14, sx0, 1.05, 1.45),
    boxSh(0.34, 1.05, 0.14, sx0, 1.05, -1.45),
  ], 0.7, 0.1) };
}
function sandbox(r, M) {
  const g = new THREE.Group();
  const wood = M(r.pick(['#8a6a3f', '#9a7a4f']), { rough: 0.9 });
  const S = 1.9;
  for (const [x, z, ry] of [[S / 2, 0, 0], [-S / 2, 0, 0], [0, S / 2, 1], [0, -S / 2, 1]]) {
    const side = box(wood, 0.12, 0.24, S + 0.12);
    side.position.set(x, 0.12, z);
    if (ry) side.rotation.y = Math.PI / 2;
    g.add(side);
  }
  const sand = box(M('#e6d3a0', { rough: 0.95 }), S - 0.1, 0.16, S - 0.1);
  jitterGeo(sand, r, 0.02);
  sand.position.y = 0.08;
  g.add(sand);
  if (r.chance(0.6)) {
    const bucket = cyl(M(r.pick(ACCENTS), { rough: 0.5 }), { r: 0.09, r2: 0.12, len: 0.14, seg: 8 });
    bucket.position.set(r.range(-0.5, 0.5), 0.23, r.range(-0.5, 0.5));
    g.add(bucket);
  }
  return { g, bodies: fixedBody(g, [boxSh(S / 2 + 0.06, 0.12, S / 2 + 0.06, 0, 0.12, 0)], 0.8, 0.05) };
}
function fencePicket(r, M) {
  const g = new THREE.Group();
  const hex = r.pick(['#eceff1', '#eceff1', '#e8e0d0', '#b08a54']);
  const mat = M(hex, { rough: 0.8 });
  const len = r.range(2.6, 3.4);
  for (const x of [-len / 2, 0, len / 2]) {
    const post = box(mat, 0.09, 0.95, 0.09);
    post.position.set(x, 0.475, 0);
    g.add(post);
  }
  for (const y of [0.34, 0.68]) {
    const rail = box(mat, len, 0.07, 0.04);
    rail.position.set(0, y, 0.05);
    g.add(rail);
  }
  const n = Math.round(len / 0.19);
  for (let i = 0; i < n; i++) {
    const p = box(mat, 0.09, 0.78, 0.028);
    p.position.set(-len / 2 + ((i + 0.5) / n) * len, 0.47, 0.085);
    g.add(p);
  }
  return { g, bodies: dynGround(g, 0.98, 42, [boxSh(len / 2, 0.48, 0.07, 0, 0.48, 0.04)], { fr: 0.6, rest: 0.05 }) };
}
function mailbox(r, M) {
  const g = new THREE.Group();
  const post = box(M('#75552f', { rough: 0.9 }), 0.08, 1.06, 0.08);
  post.position.y = 0.53;
  g.add(post);
  const hex = r.pick(['#33373d', '#2f5f9e', '#8c3a34', '#e8e9eb', '#3e8948']);
  const bodyM = M(hex, { rough: 0.5, env: 0.6 });
  const b = box(bodyM, 0.52, 0.2, 0.24);
  b.position.set(0.1, 1.16, 0);
  g.add(b);
  const top = cyl(bodyM, { r: 0.12, len: 0.52, axis: 'x', seg: 8 });
  top.position.set(0.1, 1.26, 0);
  g.add(top);
  const door = cyl(M(shade(hex, -0.1), { rough: 0.55 }), { r: 0.115, len: 0.03, axis: 'x', seg: 8 });
  door.position.set(0.37, 1.26, 0);
  g.add(door);
  const flag = box(M('#c9302c', { rough: 0.5 }), 0.05, 0.16, 0.02);
  flag.position.set(-0.05, 1.38, 0.13);
  g.add(flag);
  return { g, bodies: dynGround(g, 1.4, 22, [
    boxSh(0.05, 0.53, 0.05, 0, 0.53, 0),
    boxSh(0.28, 0.16, 0.13, 0.1, 1.22, 0),
  ], { fr: 0.6, rest: 0.2 }) };
}

/* ================= street & city ================= */
function lampClassic(r, M) {
  const g = new THREE.Group();
  const iron = M('#26292e', { rough: 0.6, metal: 0.25 });
  const base = cyl(iron, { r: 0.16, r2: 0.1, len: 0.3, seg: 8 });
  base.position.y = 0.15;
  g.add(base);
  const pole = cyl(iron, { r: 0.045, r2: 0.038, len: 2.75, seg: 8 });
  pole.position.y = 0.3 + 1.375;
  g.add(pole);
  const collar = cyl(iron, { r: 0.075, len: 0.06, seg: 8 });
  collar.position.y = 3.02;
  g.add(collar);
  const lantern = box(M('#ffe6b0', { rough: 0.3, env: 1.1, emissive: '#ffd98a', emInt: 0.9 }), 0.2, 0.3, 0.2);
  lantern.position.y = 3.28;
  g.add(lantern);
  const cap = cyl(iron, { r: 0.19, r2: 0.02, len: 0.2, seg: 8 });
  cap.position.y = 3.52;
  g.add(cap);
  const finial = sphere(iron, 0.045, 0);
  finial.position.y = 3.66;
  g.add(finial);
  if (r.chance(0.35)) { // hanging flower basket
    const arm = box(iron, 0.4, 0.03, 0.03);
    arm.position.set(0.2, 2.55, 0);
    g.add(arm);
    const basket = cyl(M('#75552f', { rough: 0.9 }), { r: 0.11, r2: 0.14, len: 0.14, seg: 8 });
    basket.position.set(0.38, 2.4, 0);
    g.add(basket);
    flowerHeads(g, M, r, 0.3, 0.46, -0.08, 0.08, 2.45, 4);
  }
  return { g, bodies: dynGround(g, 3.7, 95, [
    cylSh(1.85, 0.06, 0, 1.85, 0),
    boxSh(0.12, 0.2, 0.12, 0, 3.35, 0),
  ], { fr: 0.5, rest: 0.1 }) };
}
function trafficLight(r, M) {
  const g = new THREE.Group();
  const steel = M(r.chance(0.6) ? '#33373d' : '#8d939a', { rough: 0.55, metal: 0.35, env: 0.8 });
  const base = cyl(M('#5c6167', { rough: 0.8 }), { r: 0.16, len: 0.1, seg: 8 });
  base.position.y = 0.05;
  g.add(base);
  const mast = cyl(steel, { r: 0.08, r2: 0.06, len: 5.05, seg: 8 });
  mast.position.y = 0.1 + 2.52;
  g.add(mast);
  const arm = cyl(steel, { r: 0.05, r2: 0.04, len: 3.3, axis: 'x', seg: 8 });
  arm.position.set(1.65, 4.95, 0);
  g.add(arm);
  const brace = cyl(steel, { r: 0.028, len: 1.5, seg: 6 });
  brace.position.set(0.62, 4.55, 0);
  brace.rotation.z = 1.05;
  g.add(brace);
  const lit = r.int(0, 2);
  const makeHead = (hx, hy) => {
    const head = box(M('#22252a', { rough: 0.7 }), 0.2, 0.82, 0.3);
    head.position.set(hx, hy, 0);
    g.add(head);
    ['#e04338', '#e8a02e', '#3ecf5a'].forEach((hex, i) => {
      const lamp = cyl(M(hex, { rough: 0.3, env: 1.1, emissive: hex, emInt: i === lit ? 1.7 : 0.12 }), { r: 0.095, len: 0.05, axis: 'x', seg: 10 });
      lamp.position.set(hx + 0.11, hy + 0.26 - i * 0.26, 0);
      g.add(lamp);
      const visor = box(M('#16181c', { rough: 0.8 }), 0.12, 0.03, 0.22);
      visor.position.set(hx + 0.15, hy + 0.37 - i * 0.26, 0);
      g.add(visor);
    });
  };
  makeHead(2.95, 4.42);
  makeHead(0.16, 3.35);
  return { g, bodies: dynGround(g, 5.35, 260, [
    cylSh(2.55, 0.09, 0, 2.55, 0),
    boxSh(1.62, 0.05, 0.05, 1.65, 4.95, 0),
    boxSh(0.13, 0.42, 0.16, 2.98, 4.42, 0),
  ], { fr: 0.5, rest: 0.08 }) };
}
function hydrant(r, M) {
  const g = new THREE.Group();
  const hex = r.pick(['#c9302c', '#c9302c', '#e3c53a', '#e07b39']);
  const bodyM = M(hex, { rough: 0.45, env: 0.7 });
  const flange = cyl(bodyM, { r: 0.17, len: 0.07, seg: 9 });
  flange.position.y = 0.035;
  g.add(flange);
  const b = cyl(bodyM, { r: 0.135, r2: 0.115, len: 0.44, seg: 9 });
  b.position.y = 0.29;
  g.add(b);
  const dome = sphere(bodyM, 0.125, 1);
  dome.scale.y = 0.85;
  dome.position.y = 0.52;
  g.add(dome);
  const nut = cyl(M(shade(hex, -0.12), { rough: 0.5 }), { r: 0.045, len: 0.08, seg: 5 });
  nut.position.y = 0.62;
  g.add(nut);
  const caps = M(shade(hex, -0.1), { rough: 0.5 });
  const side = cyl(caps, { r: 0.055, len: 0.36, axis: 'z', seg: 8 });
  side.position.y = 0.33;
  g.add(side);
  const front = cyl(caps, { r: 0.06, len: 0.09, axis: 'x', seg: 8 });
  front.position.set(0.15, 0.28, 0);
  g.add(front);
  return { g, bodies: dynGround(g, 0.66, 240, [cylSh(0.33, 0.15, 0, 0.33, 0)], { fr: 0.6, rest: 0.12 }) };
}
function trashCan(r, M) {
  const g = new THREE.Group();
  const hex = r.pick(['#33613b', '#26292e', '#5c6167', '#4a6b8a']);
  const b = cyl(M(hex, { rough: 0.7 }), { r: 0.25, r2: 0.29, len: 0.76, seg: 10 });
  b.position.y = 0.38;
  g.add(b);
  const rim = cyl(M(shade(hex, -0.1), { rough: 0.6 }), { r: 0.31, len: 0.06, seg: 10 });
  rim.position.y = 0.79;
  g.add(rim);
  const band = cyl(M(shade(hex, 0.12), { rough: 0.7 }), { r: 0.285, len: 0.1, seg: 10 });
  band.position.y = 0.45;
  g.add(band);
  if (r.chance(0.5)) {
    const dome = sphere(M(shade(hex, -0.06), { rough: 0.6 }), 0.28, 1);
    dome.scale.y = 0.55;
    dome.position.y = 0.84;
    g.add(dome);
  }
  return { g, bodies: dynGround(g, 0.84, 20, [cylSh(0.42, 0.3, 0, 0.42, 0)], { fr: 0.6, rest: 0.25 }) };
}
function binWheelie(r, M) {
  const g = new THREE.Group();
  const hex = r.pick(['#3e8948', '#3a76c4', '#33373d', '#e3c53a', '#7a4a9e']);
  const bodyM = M(hex, { rough: 0.6 });
  const b = slab(bodyM, { x0: -0.27, x1: 0.27, y0: 0.2, y1: 0.96, w: 0.5, wT: 0.58, shiftT: 0.02 });
  g.add(b);
  const lid = slab(M(shade(hex, -0.09), { rough: 0.6 }), { x0: -0.3, x1: 0.3, y0: 0.96, y1: 1.06, w: 0.6, wT: 0.52, nose: 0.12 });
  g.add(lid);
  const barM = M('#26292e', { rough: 0.7 });
  const bar = box(barM, 0.05, 0.05, 0.5);
  bar.position.set(-0.28, 1.0, 0);
  g.add(bar);
  for (const s of [-1, 1]) {
    const wheel = cyl(barM, { r: 0.09, len: 0.05, axis: 'z', seg: 9 });
    wheel.position.set(-0.22, 0.09, s * 0.24);
    g.add(wheel);
  }
  return { g, bodies: dynGround(g, 1.08, 16, [boxSh(0.29, 0.44, 0.3, 0, 0.62, 0)], { fr: 0.55, rest: 0.25 }) };
}
function dumpster(r, M) {
  const g = new THREE.Group();
  const hex = r.pick(['#3e8948', '#2668bd', '#7c3b34', '#33373d', '#5c6167']);
  const bodyM = M(hex, { rough: 0.6, metal: 0.15 });
  const b = slab(bodyM, { x0: -0.95, x1: 0.95, y0: 0.22, y1: 1.22, w: 1.12, wT: 1.2 });
  g.add(b);
  for (const s of [-1, 1]) {
    const skid = box(M('#26292e', { rough: 0.8 }), 1.7, 0.22, 0.12);
    skid.position.set(0, 0.11, s * 0.42);
    g.add(skid);
    const lid = box(M(shade(hex, -0.1), { rough: 0.6 }), 1.86, 0.05, 0.56);
    lid.position.set(0, 1.26, s * 0.29);
    lid.rotation.x = -s * 0.1;
    g.add(lid);
    const pocket = box(M(shade(hex, -0.14), { rough: 0.7 }), 0.1, 0.3, 0.5);
    pocket.position.set(s * 0.99, 0.62, 0);
    g.add(pocket);
  }
  if (r.chance(0.4)) P.sideStripe(g, M, { x0: -0.8, x1: 0.8, y: 0.75, w: 1.16, hex: '#e3c53a', h: 0.12 });
  return { g, bodies: dynGround(g, 1.34, 330, [boxSh(0.95, 0.56, 0.62, 0, 0.72, 0)], { fr: 0.55, rest: 0.12 }) };
}
function mailboxDrop(r, M) {
  const g = new THREE.Group();
  const hex = r.pick(['#2f5f9e', '#c9302c', '#3e8948', '#e3c53a']);
  const bodyM = M(hex, { rough: 0.5, env: 0.6 });
  for (const [sx, sz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
    const leg = box(M('#33373d', { rough: 0.7 }), 0.05, 0.42, 0.05);
    leg.position.set(sx * 0.2, 0.21, sz * 0.18);
    g.add(leg);
  }
  const b = box(bodyM, 0.52, 0.62, 0.48);
  b.position.y = 0.72;
  g.add(b);
  const top = cyl(bodyM, { r: 0.26, len: 0.52, axis: 'x', seg: 10 });
  top.scale.z = 0.92;
  top.position.y = 1.03;
  g.add(top);
  const slot = box(M(shade(hex, -0.16), { rough: 0.6 }), 0.02, 0.06, 0.34);
  slot.position.set(0.265, 0.95, 0);
  g.add(slot);
  const decal = box(M('#f2f3f5', { rough: 0.5 }), 0.015, 0.12, 0.34);
  decal.position.set(0.265, 0.68, 0);
  g.add(decal);
  return { g, bodies: dynGround(g, 1.3, 105, [boxSh(0.27, 0.45, 0.25, 0, 0.85, 0)], { fr: 0.55, rest: 0.15 }) };
}
function busStop(r, M) {
  const g = new THREE.Group();
  const steel = M('#3d4147', { rough: 0.5, metal: 0.4, env: 0.8 });
  const glass = M('#a8c8dc', { rough: 0.18, env: 1.3 });
  const roofHex = r.pick(['#3a5e8c', '#2f6b6b', '#8c3a34']);
  for (const sx of [-1, 1]) for (const z of [-0.48, 0.52]) {
    const post = box(steel, 0.07, 2.26, 0.07);
    post.position.set(sx * 1.34, 1.13, z);
    g.add(post);
  }
  const roof = slab(M(roofHex, { rough: 0.6 }), { x0: -1.58, x1: 1.58, y0: 2.26, y1: 2.44, w: 1.4, nose: 0.12, tail: 0.12 });
  g.add(roof);
  const back = box(glass, 2.68, 1.55, 0.035);
  back.position.set(0, 1.28, -0.48);
  g.add(back);
  for (const sx of [-1, 1]) {
    const side = box(glass, 0.035, 1.55, 0.92);
    side.position.set(sx * 1.32, 1.28, 0.02);
    g.add(side);
  }
  const bench = box(M('#8a6a3f', { rough: 0.85 }), 2.2, 0.06, 0.38);
  bench.position.set(0, 0.55, -0.2);
  g.add(bench);
  for (const sx of [-1, 1]) {
    const leg = box(steel, 0.06, 0.53, 0.3);
    leg.position.set(sx * 0.9, 0.27, -0.2);
    g.add(leg);
  }
  const sign = box(M('#2f5f9e', { rough: 0.5 }), 0.04, 0.3, 0.5);
  sign.position.set(1.34, 2.62, 0);
  g.add(sign);
  const busIcon = box(M('#f2f3f5', { rough: 0.5 }), 0.02, 0.14, 0.3);
  busIcon.position.set(1.37, 2.62, 0);
  g.add(busIcon);
  return { g, bodies: fixedBody(g, [
    boxSh(1.34, 0.78, 0.03, 0, 1.28, -0.48),
    boxSh(0.03, 0.78, 0.46, -1.32, 1.28, 0.02),
    boxSh(0.03, 0.78, 0.46, 1.32, 1.28, 0.02),
    boxSh(1.1, 0.28, 0.19, 0, 0.28, -0.2),
    boxSh(1.6, 0.1, 0.72, 0, 2.35, 0),
  ], 0.6, 0.15) };
}
function billboard(r, M) {
  const g = new THREE.Group();
  const steel = M('#4c5157', { rough: 0.55, metal: 0.3 });
  for (const s of [-1, 1]) {
    const post = box(steel, 0.14, 2.6, 0.14);
    post.position.set(0, 1.3, s * 1.1);
    g.add(post);
  }
  const panel = box(steel, 0.1, 1.75, 3.5);
  panel.position.y = 3.28;
  g.add(panel);
  const accent = r.pick(ACCENTS);
  const face = canvasMat(512, 256, (x, w, h) => {
    x.fillStyle = r.pick(['#f2ede2', '#e8f0f2', '#f2e8e0']);
    x.fillRect(0, 0, w, h);
    x.fillStyle = accent;
    x.fillRect(0, 0, w, 74);
    x.beginPath();
    x.arc(96, 168, 52, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = '#ffffff';
    x.font = 'bold 44px Arial, sans-serif';
    x.fillText(r.pick(['BIG SALE!', 'CRASH BET', 'DRIVE NOW', 'LOW POLY™']), 26, 52);
    x.fillStyle = '#3d4147';
    for (let i = 0; i < 3; i++) x.fillRect(180, 118 + i * 38, 290 - i * 60, 18);
  });
  const fplane = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.65), face);
  fplane.rotation.y = Math.PI / 2;
  fplane.position.set(0.06, 3.28, 0);
  fplane.castShadow = true;
  g.add(fplane);
  for (const s of [-1, 1]) { // little spotlights on top
    const lamp = box(M('#ffe6b0', { rough: 0.4, emissive: '#ffd98a', emInt: 0.7 }), 0.1, 0.07, 0.16);
    lamp.position.set(0.14, 4.22, s * 1.1);
    g.add(lamp);
  }
  return { g, bodies: fixedBody(g, [
    boxSh(0.07, 1.3, 0.07, 0, 1.3, -1.1),
    boxSh(0.07, 1.3, 0.07, 0, 1.3, 1.1),
    boxSh(0.06, 0.88, 1.75, 0, 3.28, 0),
  ], 0.6, 0.2) };
}
function utilityBox(r, M) {
  const g = new THREE.Group();
  const hex = r.pick(['#7a8577', '#8d939a', '#6b7a68', '#8c5a4a']);
  const base = box(M('#8d9096', { rough: 0.9 }), 0.72, 0.08, 0.85);
  base.position.y = 0.04;
  g.add(base);
  const b = slab(M(hex, { rough: 0.6 }), { x0: -0.33, x1: 0.33, y0: 0.08, y1: 1.1, w: 0.8, wT: 0.75, nose: 0.05 });
  g.add(b);
  for (let i = 0; i < 3; i++) {
    const vent = box(M(shade(hex, -0.14), { rough: 0.7 }), 0.02, 0.05, 0.55);
    vent.position.set(0.335, 0.78 - i * 0.12, 0);
    g.add(vent);
  }
  if (r.chance(0.6)) {
    const label = box(M('#e3c53a', { rough: 0.55 }), 0.02, 0.14, 0.14);
    label.position.set(0.34, 0.35, 0.2);
    g.add(label);
  }
  return { g, bodies: dynGround(g, 1.12, 180, [boxSh(0.36, 0.55, 0.42, 0, 0.58, 0)], { fr: 0.6, rest: 0.12 }) };
}
function bikeRack(r, M) {
  const g = new THREE.Group();
  const steel = M('#9aa0a7', { rough: 0.35, metal: 0.6, env: 1 });
  for (let i = 0; i < 3; i++) {
    const z = (i - 1) * 0.5;
    const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.021, 6, 10, Math.PI), steel);
    hoop.position.set(0, 0.42, z);
    hoop.castShadow = true;
    g.add(hoop);
    for (const s of [-1, 1]) {
      const leg = cyl(steel, { r: 0.021, len: 0.44, seg: 6 });
      leg.position.set(s * 0.26, 0.22, z);
      g.add(leg);
    }
  }
  return { g, bodies: fixedBody(g, [boxSh(0.3, 0.34, 0.68, 0, 0.34, 0)], 0.6, 0.2) };
}
function foodCart(r, M) {
  const g = new THREE.Group();
  const accent = r.pick(['#c9302c', '#e07b39', '#3a76c4', '#3e8948']);
  const bodyM = M(r.pick(['#f2ede2', '#e8e9eb', '#efe3c8']), { rough: 0.6 });
  const b = box(bodyM, 1.25, 0.8, 0.72);
  b.position.y = 0.92;
  g.add(b);
  const counter = box(M('#c9ccd2', { rough: 0.4, metal: 0.3, env: 0.9 }), 1.35, 0.05, 0.82);
  counter.position.y = 1.35;
  g.add(counter);
  for (const s of [-1, 1]) {
    const wheel = P.wheel(M, 0.28, 0.09, { seg: 12 });
    wheel.position.set(-0.25, 0.28, s * 0.42);
    g.add(wheel);
    const handle = cyl(M('#33373d', { rough: 0.6 }), { r: 0.025, len: 0.65, seg: 6 });
    handle.position.set(-0.85, 0.98, s * 0.25);
    handle.rotation.z = 1.05;
    g.add(handle);
  }
  for (const s of [-1, 1]) {
    const leg = box(M('#33373d', { rough: 0.6 }), 0.05, 0.52, 0.05);
    leg.position.set(0.5, 0.26, s * 0.3);
    g.add(leg);
  }
  for (const [sx, sz] of [[0.55, 0.33], [0.55, -0.33], [-0.55, 0.33], [-0.55, -0.33]]) {
    const post = cyl(M('#c9ced4', { rough: 0.4, metal: 0.5 }), { r: 0.02, len: 0.85, seg: 6 });
    post.position.set(sx, 1.78, sz);
    g.add(post);
  }
  const aw = new THREE.Group();
  const n = 5;
  for (let i = 0; i < n; i++) {
    const slat = box(M(i % 2 ? '#f7f3ea' : accent, { rough: 0.7 }), 0.95, 0.028, 0.98 / n);
    slat.position.z = -0.49 + (i + 0.5) * (0.98 / n);
    aw.add(slat);
  }
  aw.position.set(0.1, 2.26, 0);
  aw.rotation.z = -0.18;
  g.add(aw);
  if (r.chance(0.6)) { // menu board
    const board = box(M('#26292e', { rough: 0.7 }), 0.03, 0.3, 0.42);
    board.position.set(0.64, 1.05, 0);
    g.add(board);
  }
  return { g, bodies: dynGround(g, 2.35, 125, [
    boxSh(0.65, 0.42, 0.4, 0, 0.94, 0),
    boxSh(0.5, 0.05, 0.5, 0.1, 2.26, 0),
  ], { fr: 0.55, rest: 0.15 }) };
}
function tableUmbrella(r, M) {
  const g = new THREE.Group();
  const base = cyl(M('#5c6167', { rough: 0.7 }), { r: 0.2, len: 0.05, seg: 9 });
  base.position.y = 0.025;
  g.add(base);
  const leg = cyl(M('#8d939a', { rough: 0.5, metal: 0.4 }), { r: 0.035, len: 0.68, seg: 7 });
  leg.position.y = 0.39;
  g.add(leg);
  const top = cyl(M('#f2f3f5', { rough: 0.55 }), { r: 0.52, len: 0.045, seg: 10 });
  top.position.y = 0.75;
  g.add(top);
  const pole = cyl(M('#c9ced4', { rough: 0.4, metal: 0.4 }), { r: 0.025, len: 1.55, seg: 6 });
  pole.position.y = 1.5;
  g.add(pole);
  const hex = r.pick(['#3a76c4', '#c9302c', '#3e8948', '#e3c53a', '#e07b39']);
  const cone = cyl(M(hex, { rough: 0.7 }), { r: 0.98, r2: 0.05, len: 0.4, seg: 8 });
  cone.position.y = 2.22;
  g.add(cone);
  const fringe = cyl(M(r.chance(0.5) ? '#f7f3ea' : shade(hex, -0.1), { rough: 0.7 }), { r: 0.99, len: 0.05, seg: 8 });
  fringe.position.y = 2.02;
  g.add(fringe);
  return { g, bodies: dynGround(g, 2.45, 38, [
    cylSh(0.4, 0.5, 0, 0.4, 0),
    cylSh(0.85, 0.04, 0, 1.55, 0),
    cylSh(0.18, 0.85, 0, 2.2, 0),
  ], { fr: 0.55, rest: 0.2 }) };
}

/* ================= signs & traffic control ================= */
const GRAY_BACK = (M) => M('#8d939a', { rough: 0.5, metal: 0.3, env: 0.7 });
function octPath(x, cx, cy, R, start = Math.PI / 8) {
  x.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = start + (i / 8) * Math.PI * 2;
    const px = cx + Math.cos(a) * R, py = cy - Math.sin(a) * R;
    if (i === 0) x.moveTo(px, py); else x.lineTo(px, py);
  }
  x.closePath();
}
function signStop(r, M) {
  const g = new THREE.Group();
  signPost(g, M, 2.25);
  const face = canvasMat(256, 256, (x, w, h) => {
    x.fillStyle = '#c9302c';
    x.fillRect(0, 0, w, h);
    octPath(x, 128, 128, 112);
    x.strokeStyle = '#f2f3f5';
    x.lineWidth = 12;
    x.stroke();
    x.fillStyle = '#f2f3f5';
    x.font = 'bold 74px Arial, sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText('STOP', 128, 132);
  }, { fallback: '#c9302c' });
  plate(g, new THREE.CircleGeometry(0.42, 8, Math.PI / 8), face, GRAY_BACK(M), 1.85);
  return { g, bodies: dynGround(g, 2.3, 19, [
    cylSh(1.13, 0.05, 0, 1.13, 0),
    boxSh(0.02, 0.4, 0.4, 0, 1.85, 0),
  ], { fr: 0.5, rest: 0.25 }) };
}
function signYield(r, M) {
  const g = new THREE.Group();
  signPost(g, M, 2.2);
  const face = canvasMat(256, 256, (x, w, h) => {
    x.fillStyle = '#f2f3f5';
    x.fillRect(0, 0, w, h);
    x.strokeStyle = '#c9302c';
    x.lineWidth = 30;
    x.beginPath();
    x.moveTo(128, 236);
    x.lineTo(24, 44);
    x.lineTo(232, 44);
    x.closePath();
    x.stroke();
    x.fillStyle = '#c9302c';
    x.font = 'bold 46px Arial, sans-serif';
    x.textAlign = 'center';
    x.fillText('YIELD', 128, 116);
  }, { fallback: '#f2f3f5' });
  plate(g, new THREE.CircleGeometry(0.46, 3, -Math.PI / 2), face, GRAY_BACK(M), 1.82);
  return { g, bodies: dynGround(g, 2.25, 18, [
    cylSh(1.1, 0.05, 0, 1.1, 0),
    boxSh(0.02, 0.35, 0.38, 0, 1.82, 0),
  ], { fr: 0.5, rest: 0.25 }) };
}
function signSpeed(r, M) {
  const g = new THREE.Group();
  signPost(g, M, 2.25);
  const num = r.pick(['25', '35', '45', '50']);
  const face = canvasMat(200, 250, (x, w, h) => {
    x.fillStyle = '#f7f8f9';
    x.fillRect(0, 0, w, h);
    x.strokeStyle = '#26292e';
    x.lineWidth = 10;
    x.strokeRect(10, 10, w - 20, h - 20);
    x.fillStyle = '#26292e';
    x.textAlign = 'center';
    x.font = 'bold 30px Arial, sans-serif';
    x.fillText('SPEED', w / 2, 56);
    x.fillText('LIMIT', w / 2, 90);
    x.font = 'bold 104px Arial, sans-serif';
    x.fillText(num, w / 2, 200);
  }, { fallback: '#f7f8f9' });
  plate(g, new THREE.PlaneGeometry(0.5, 0.62), face, GRAY_BACK(M), 1.88);
  return { g, bodies: dynGround(g, 2.3, 18, [
    cylSh(1.13, 0.05, 0, 1.13, 0),
    boxSh(0.02, 0.31, 0.25, 0, 1.88, 0),
  ], { fr: 0.5, rest: 0.25 }) };
}
function signWarn(r, M) {
  const g = new THREE.Group();
  signPost(g, M, 2.3);
  const kind = r.pick(['curve', 'ped', 'signal', 'bump']);
  const face = canvasMat(256, 256, (x, w, h) => {
    x.fillStyle = '#e8b12e';
    x.fillRect(0, 0, w, h);
    x.strokeStyle = '#26292e';
    x.lineWidth = 11;
    x.beginPath();
    x.moveTo(128, 14); x.lineTo(242, 128); x.lineTo(128, 242); x.lineTo(14, 128);
    x.closePath();
    x.stroke();
    x.strokeStyle = '#26292e';
    x.fillStyle = '#26292e';
    x.lineWidth = 16;
    x.lineCap = 'round';
    if (kind === 'curve') {
      x.beginPath();
      x.moveTo(104, 196);
      x.quadraticCurveTo(104, 120, 152, 96);
      x.stroke();
      x.beginPath();
      x.moveTo(170, 110); x.lineTo(148, 66); x.lineTo(128, 106);
      x.closePath();
      x.fill();
    } else if (kind === 'ped') {
      x.beginPath();
      x.arc(128, 84, 18, 0, Math.PI * 2);
      x.fill();
      x.beginPath();
      x.moveTo(128, 104); x.lineTo(122, 152); x.lineTo(104, 196);
      x.moveTo(122, 152); x.lineTo(146, 196);
      x.moveTo(108, 124); x.lineTo(154, 132);
      x.stroke();
    } else if (kind === 'signal') {
      x.fillRect(108, 66, 40, 96);
      for (const [cy, col] of [[86, '#c9302c'], [114, '#e8a02e'], [142, '#3e8948']]) {
        x.fillStyle = col;
        x.beginPath(); x.arc(128, cy, 11, 0, Math.PI * 2); x.fill();
      }
    } else {
      x.beginPath();
      x.moveTo(64, 172);
      x.quadraticCurveTo(128, 96, 192, 172);
      x.stroke();
    }
  }, { fallback: '#e8b12e' });
  plate(g, new THREE.CircleGeometry(0.48, 4, 0), face, GRAY_BACK(M), 1.82);
  return { g, bodies: dynGround(g, 2.35, 19, [
    cylSh(1.15, 0.05, 0, 1.15, 0),
    boxSh(0.02, 0.35, 0.35, 0, 1.82, 0),
  ], { fr: 0.5, rest: 0.25 }) };
}
function signReg(r, M) {
  const g = new THREE.Group();
  signPost(g, M, 2.25);
  const kind = r.pick(['noparking', 'donotenter', 'oneway']);
  const face = canvasMat(256, 256, (x, w, h) => {
    if (kind === 'donotenter') {
      x.fillStyle = '#c9302c';
      x.fillRect(0, 0, w, h);
      x.fillStyle = '#f2f3f5';
      x.fillRect(38, 108, 180, 40);
      x.font = 'bold 30px Arial, sans-serif';
      x.textAlign = 'center';
      x.fillText('DO NOT', 128, 62);
      x.fillText('ENTER', 128, 216);
    } else if (kind === 'oneway') {
      x.fillStyle = '#26292e';
      x.fillRect(0, 24, w, 208);
      x.fillStyle = '#f2f3f5';
      x.beginPath();
      x.moveTo(226, 128); x.lineTo(150, 74); x.lineTo(150, 106);
      x.lineTo(30, 106); x.lineTo(30, 150); x.lineTo(150, 150); x.lineTo(150, 182);
      x.closePath();
      x.fill();
      x.font = 'bold 34px Arial, sans-serif';
      x.textAlign = 'center';
      x.fillStyle = '#26292e';
      x.fillText('ONE WAY', 128, 214);
      x.fillStyle = '#f2f3f5';
      x.fillText('ONE WAY', 128, 60);
    } else {
      x.fillStyle = '#f7f8f9';
      x.fillRect(0, 0, w, h);
      x.strokeStyle = '#26292e';
      x.lineWidth = 8;
      x.strokeRect(8, 8, 240, 240);
      x.fillStyle = '#26292e';
      x.font = 'bold 120px Arial, sans-serif';
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.fillText('P', 128, 132);
      x.strokeStyle = '#c9302c';
      x.lineWidth = 20;
      x.beginPath();
      x.arc(128, 128, 96, 0, Math.PI * 2);
      x.stroke();
      x.beginPath();
      x.moveTo(60, 60); x.lineTo(196, 196);
      x.stroke();
    }
  }, { fallback: '#f7f8f9' });
  plate(g, new THREE.PlaneGeometry(0.5, 0.5), face, GRAY_BACK(M), 1.86);
  return { g, bodies: dynGround(g, 2.3, 18, [
    cylSh(1.13, 0.05, 0, 1.13, 0),
    boxSh(0.02, 0.25, 0.25, 0, 1.86, 0),
  ], { fr: 0.5, rest: 0.25 }) };
}
const STREETS = ['MAIN ST', 'OAK AVE', 'ELM ST', 'MAPLE DR', '1ST AVE', 'CRASH BLVD', 'PARK LN', 'HILL RD', 'LAKE CT'];
function signStreet(r, M) {
  const g = new THREE.Group();
  signPost(g, M, 2.55);
  const blade = (name, y, ry) => {
    const face = canvasMat(320, 80, (x, w, h) => {
      x.fillStyle = '#2e6b3f';
      x.fillRect(0, 0, w, h);
      x.strokeStyle = '#f2f3f5';
      x.lineWidth = 6;
      x.strokeRect(5, 5, w - 10, h - 10);
      x.fillStyle = '#f2f3f5';
      x.font = 'bold 40px Arial, sans-serif';
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.fillText(name, w / 2, h / 2 + 2);
    }, { fallback: '#2e6b3f' });
    const holder = new THREE.Group();
    plate(holder, new THREE.PlaneGeometry(1.0, 0.24), face, GRAY_BACK(M), y);
    holder.rotation.y = ry;
    g.add(holder);
  };
  blade(r.pick(STREETS), 2.42, 0);
  if (r.chance(0.6)) blade(r.pick(STREETS), 2.18, Math.PI / 2);
  const cap = sphere(M('#5c6167', { rough: 0.6 }), 0.05, 0);
  cap.position.y = 2.57;
  g.add(cap);
  return { g, bodies: dynGround(g, 2.6, 16, [cylSh(1.28, 0.05, 0, 1.28, 0)], { fr: 0.5, rest: 0.25 }) };
}
function signHighway(r, M) {
  const g = new THREE.Group();
  const steel = M('#8d939a', { rough: 0.5, metal: 0.4, env: 0.8 });
  for (const s of [-1, 1]) {
    const post = box(steel, 0.1, 2.85, 0.1);
    post.position.set(0, 1.42, s * 1.2);
    g.add(post);
  }
  const cfg = r.pick([
    { main: 'CITY CENTER', sub: 'NEXT EXIT', arrow: '↑' },
    { main: 'NORTH', sub: 'CRASHVILLE', arrow: '↑' },
    { main: 'EXIT 12', sub: 'SANDBOX RD', arrow: '→', tab: true },
    { main: 'AIRPORT', sub: 'KEEP LEFT', arrow: '←' },
  ]);
  const face = canvasMat(512, 256, (x, w, h) => {
    x.fillStyle = '#2e7a45';
    x.fillRect(0, 0, w, h);
    x.strokeStyle = '#f2f3f5';
    x.lineWidth = 8;
    x.strokeRect(8, 8, w - 16, h - 16);
    x.fillStyle = '#f2f3f5';
    x.textAlign = 'center';
    x.font = 'bold 58px Arial, sans-serif';
    x.fillText(cfg.main, w / 2, 104);
    x.font = 'bold 38px Arial, sans-serif';
    x.fillText(cfg.sub, w / 2, 160);
    x.font = 'bold 64px Arial, sans-serif';
    x.fillText(cfg.arrow, w / 2, 228);
    if (cfg.tab) {
      x.fillStyle = '#e8b12e';
      x.fillRect(w - 170, h - 54, 154, 40);
      x.fillStyle = '#26292e';
      x.font = 'bold 26px Arial, sans-serif';
      x.fillText('EXIT ONLY', w - 93, h - 26);
    }
  }, { fallback: '#2e7a45' });
  plate(g, new THREE.PlaneGeometry(3.0, 1.5), face, GRAY_BACK(M), 3.05);
  return { g, bodies: dynGround(g, 3.85, 200, [
    boxSh(0.06, 1.42, 0.06, 0, 1.42, -1.2),
    boxSh(0.06, 1.42, 0.06, 0, 1.42, 1.2),
    boxSh(0.04, 0.75, 1.5, 0, 3.05, 0),
  ], { fr: 0.5, rest: 0.15 }) };
}
function cone(r, M) {
  const g = new THREE.Group();
  const orange = M('#e8641f', { rough: 0.55, env: 0.5 });
  const base = box(M('#d05a1a', { rough: 0.6 }), 0.34, 0.035, 0.34);
  base.position.y = 0.018;
  g.add(base);
  const body = cyl(orange, { r: 0.15, r2: 0.028, len: 0.52, seg: 9 });
  body.position.y = 0.29;
  g.add(body);
  const band = cyl(M('#f2f3f5', { rough: 0.4, env: 0.8 }), { r: 0.117, r2: 0.085, len: 0.14, seg: 9 });
  band.position.y = 0.335;
  g.add(band);
  return { g, bodies: dynGround(g, 0.56, 3.5, [
    coneSh(0.15, 0.5, 0.03, 8),
    boxSh(0.17, 0.018, 0.17, 0, 0.018, 0),
  ], { fr: 0.7, rest: 0.3 }) };
}
function delineator(r, M) {
  const g = new THREE.Group();
  const base = cyl(M('#26292e', { rough: 0.85 }), { r: 0.18, r2: 0.14, len: 0.09, seg: 9 });
  base.position.y = 0.045;
  g.add(base);
  const post = cyl(M('#e8641f', { rough: 0.5 }), { r: 0.045, len: 0.95, seg: 8 });
  post.position.y = 0.57;
  g.add(post);
  for (const y of [0.75, 0.95]) {
    const band = cyl(M('#f2f3f5', { rough: 0.35, env: 0.9 }), { r: 0.048, len: 0.1, seg: 8 });
    band.position.y = y;
    g.add(band);
  }
  return { g, bodies: dynGround(g, 1.05, 5, [
    cylSh(0.52, 0.05, 0, 0.57, 0),
    cylSh(0.045, 0.16, 0, 0.045, 0),
  ], { fr: 0.6, rest: 0.3 }) };
}
function barricade(r, M) {
  const g = new THREE.Group();
  const frameM = M('#f2f3f5', { rough: 0.6 });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = box(frameM, 0.06, 1.15, 0.06);
      leg.position.set(sx * 0.55, 0.55, sz * 0.02);
      leg.rotation.x = sz * 0.3;
      g.add(leg);
    }
  }
  const stripes = canvasMat(280, 56, (x, w, h) => {
    x.fillStyle = '#f2f3f5';
    x.fillRect(0, 0, w, h);
    x.fillStyle = '#e8641f';
    for (let sx = -h; sx < w + h; sx += 56) {
      x.beginPath();
      x.moveTo(sx, h); x.lineTo(sx + 28, h); x.lineTo(sx + 28 + h, 0); x.lineTo(sx + h, 0);
      x.closePath();
      x.fill();
    }
  }, { fallback: '#e8641f' });
  for (const y of [0.42, 0.72, 1.02]) {
    const board = box(frameM, 1.4, 0.2, 0.045);
    board.position.set(0, y, 0.05);
    g.add(board);
    const facePl = new THREE.Mesh(new THREE.PlaneGeometry(1.38, 0.19), stripes);
    facePl.position.set(0, y, 0.075);
    facePl.castShadow = true;
    g.add(facePl);
  }
  if (r.chance(0.55)) {
    for (const sx of [-0.55, 0.55]) {
      const lamp = box(M('#e8a02e', { rough: 0.35, emissive: '#ffb03a', emInt: 1.4 }), 0.07, 0.09, 0.07);
      lamp.position.set(sx, 1.18, 0);
      g.add(lamp);
    }
  }
  return { g, bodies: dynGround(g, 1.2, 26, [
    boxSh(0.7, 0.42, 0.04, 0, 0.72, 0.05),
    boxSh(0.62, 0.55, 0.2, 0, 0.55, 0),
  ], { fr: 0.6, rest: 0.2 }) };
}
function barrierWater(r, M) {
  const g = new THREE.Group();
  const hex = r.pick(['#e8641f', '#e8641f', '#f2f3f5', '#c9302c']);
  const body = slab(M(hex, { rough: 0.5, env: 0.5 }), { x0: -0.85, x1: 0.85, y0: 0, y1: 0.92, w: 0.52, wT: 0.32 });
  g.add(body);
  const cap = slab(M(hex === '#f2f3f5' ? '#e8641f' : '#f2f3f5', { rough: 0.5 }), { x0: -0.82, x1: 0.82, y0: 0.92, y1: 1.02, w: 0.34, wT: 0.28 });
  g.add(cap);
  for (const x of [-0.45, 0, 0.45]) {
    const rib = box(M(shade(hex, -0.09), { rough: 0.55 }), 0.07, 0.78, 0.5);
    rib.position.set(x, 0.42, 0);
    g.add(rib);
  }
  return { g, bodies: dynGround(g, 1.02, 85, [hullFromPt(body.userData.pt)], { fr: 0.5, rest: 0.25 }) };
}
function guardrail(r, M) {
  const g = new THREE.Group();
  const galv = M('#b3b8be', { rough: 0.35, metal: 0.55, env: 1 });
  for (const x of [-1.7, 0, 1.7]) {
    const post = box(M('#767c84', { rough: 0.6, metal: 0.3 }), 0.14, 0.62, 0.08);
    post.position.set(x, 0.31, -0.06);
    g.add(post);
  }
  for (const [y, tilt] of [[0.48, 0.35], [0.66, -0.35]]) { // W-profile from two angled bands
    const band = box(galv, 4.1, 0.17, 0.03);
    band.position.set(0, y, 0.02);
    band.rotation.x = tilt;
    g.add(band);
  }
  const crease = box(galv, 4.1, 0.05, 0.045);
  crease.position.set(0, 0.57, 0.035);
  g.add(crease);
  return { g, bodies: fixedBody(g, [boxSh(2.05, 0.34, 0.09, 0, 0.42, 0)], 0.25, 0.35) };
}
function speedBump(r, M) {
  const g = new THREE.Group();
  const n = 6, segW = 0.52;
  for (let i = 0; i < n; i++) {
    const seg = slab(M(i % 2 ? '#26292e' : '#e3c53a', { rough: 0.8 }), { x0: -0.2, x1: 0.2, y0: 0, y1: 0.1, w: segW, nose: 0.14, tail: 0.14 });
    seg.position.z = -((n - 1) / 2) * segW + i * segW;
    g.add(seg);
  }
  const pt = { x0b: -0.2, x1b: 0.2, x0t: -0.06, x1t: 0.06, zb: n * segW, zt: n * segW, y0: 0, y1: 0.1 };
  return { g, bodies: fixedBody(g, [hullFromPt(pt)], 0.9, 0) };
}
function trailerBase(g, M) {
  const frame = M('#33373d', { rough: 0.6, metal: 0.2 });
  const bed = box(frame, 1.5, 0.09, 1.05);
  bed.position.y = 0.52;
  g.add(bed);
  for (const s of [-1, 1]) {
    const wheel = P.wheel(M, 0.26, 0.14, { seg: 10 });
    wheel.position.set(0.1, 0.26, s * 0.58);
    g.add(wheel);
  }
  const tongue = box(frame, 0.8, 0.06, 0.08);
  tongue.position.set(1.05, 0.5, 0);
  g.add(tongue);
  const jack = cyl(frame, { r: 0.03, len: 0.45, seg: 6 });
  jack.position.set(1.35, 0.25, 0);
  g.add(jack);
  return frame;
}
function arrowBoard(r, M) {
  const g = new THREE.Group();
  trailerBase(g, M);
  const panelM = M(r.chance(0.6) ? '#e8a02e' : '#26292e', { rough: 0.6 });
  const panel = box(panelM, 0.09, 0.95, 1.65);
  panel.position.set(-0.35, 1.6, 0);
  g.add(panel);
  const dotOn = M('#ffb03a', { rough: 0.3, emissive: '#ffb03a', emInt: 1.9 });
  const dotOff = M('#3a3225', { rough: 0.6 });
  const dots = [
    [0.55, 0], [0.35, 0.18], [0.35, -0.18], [0.15, 0.3], [0.15, -0.3],
    [-0.05, 0], [-0.25, 0.18], [-0.25, -0.18], [-0.45, 0.3], [-0.45, -0.3],
  ];
  const dir = r.sign();
  for (const [dz, dy] of dots) {
    const lamp = cyl(Math.abs(dy) < 0.35 ? dotOn : dotOff, { r: 0.055, len: 0.04, axis: 'x', seg: 8 });
    lamp.position.set(-0.28, 1.6 + dy, dz * dir);
    g.add(lamp);
  }
  return { g, bodies: dynGround(g, 2.1, 360, [
    boxSh(0.75, 0.3, 0.55, 0, 0.42, 0),
    boxSh(0.06, 0.5, 0.85, -0.35, 1.6, 0),
  ], { fr: 0.6, rest: 0.12 }) };
}
function vmsBoard(r, M) {
  const g = new THREE.Group();
  trailerBase(g, M);
  const panel = box(M('#26292e', { rough: 0.65 }), 0.1, 1.15, 1.85);
  panel.position.set(-0.3, 1.75, 0);
  g.add(panel);
  const lines = r.pick([['DRIVE', 'SAFE'], ['SLOW', 'DOWN'], ['CRASH', 'BET !'], ['EXPECT', 'DELAYS']]);
  const face = canvasMat(320, 200, (x, w, h) => {
    x.fillStyle = '#101318';
    x.fillRect(0, 0, w, h);
    x.fillStyle = '#f0a028';
    x.font = 'bold 62px monospace';
    x.textAlign = 'center';
    x.fillText(lines[0], w / 2, 82);
    x.fillText(lines[1], w / 2, 162);
    x.fillStyle = 'rgba(16,19,24,0.55)'; // dot-matrix scanlines
    for (let gy = 0; gy < h; gy += 8) x.fillRect(0, gy, w, 3);
    for (let gx = 0; gx < w; gx += 8) x.fillRect(gx, 0, 3, h);
  }, { fallback: '#26292e', emissive: 0.9 });
  const fplane = new THREE.Mesh(new THREE.PlaneGeometry(1.72, 1.02), face);
  fplane.rotation.y = Math.PI / 2;
  fplane.position.set(-0.24, 1.75, 0);
  g.add(fplane);
  if (r.chance(0.7)) { // solar panel
    const solar = box(M('#2b3a55', { rough: 0.3, env: 1.2 }), 0.5, 0.03, 0.7);
    solar.position.set(-0.3, 2.42, 0);
    solar.rotation.z = 0.3;
    g.add(solar);
  }
  return { g, bodies: dynGround(g, 2.45, 420, [
    boxSh(0.75, 0.3, 0.55, 0, 0.42, 0),
    boxSh(0.07, 0.58, 0.95, -0.3, 1.75, 0),
  ], { fr: 0.6, rest: 0.12 }) };
}

/* ================= batch 2 — 50 more (reference-image sweep) ================= */
const tMat = (hex, op) => new THREE.MeshStandardMaterial({
  color: hex, roughness: 0.6, transparent: true, opacity: op, flatShading: true, side: THREE.DoubleSide,
});

/* ---- nature ---- */
function treeDead(r, M) {
  const g = new THREE.Group();
  const bark = M(r.pick(['#6e5a48', '#5e4c3c', '#75604e']), { rough: 0.95 });
  const t = cyl(bark, { r: 0.19, r2: 0.11, len: 2.3, seg: 7 });
  t.position.y = 1.15;
  t.rotation.z = r.range(-0.06, 0.06);
  g.add(t);
  const n = r.int(3, 4);
  for (let i = 0; i < n; i++) {
    const br = cyl(bark, { r: 0.025, r2: 0.05, len: r.range(0.8, 1.25), seg: 5 });
    const a = (i / n) * Math.PI * 2 + r.range(0, 0.8);
    br.position.set(Math.cos(a) * 0.3, r.range(1.0, 1.9), Math.sin(a) * 0.3);
    br.rotation.z = Math.cos(a) * r.range(0.55, 0.95);
    br.rotation.x = -Math.sin(a) * r.range(0.55, 0.95);
    g.add(br);
  }
  return { g, bodies: dynGround(g, 2.6, 240, [cylSh(1.3, 0.16, 0, 1.3, 0)], { fr: 0.7, rest: 0.08 }) };
}
function treeStump(r, M) {
  const g = new THREE.Group();
  const st = cyl(M(r.pick(BARK), { rough: 0.95 }), { r: 0.34, r2: 0.3, len: 0.45, seg: 9 });
  st.position.y = 0.225;
  g.add(st);
  const cut = cyl(M('#c8a06a', { rough: 0.8 }), { r: 0.28, len: 0.025, seg: 9 });
  cut.position.y = 0.455;
  g.add(cut);
  for (let i = 0; i < 3; i++) { // root flares
    const root = box(M(r.pick(BARK), { rough: 0.95 }), 0.3, 0.14, 0.16);
    const a = (i / 3) * Math.PI * 2 + 0.4;
    root.position.set(Math.cos(a) * 0.32, 0.07, Math.sin(a) * 0.32);
    root.rotation.y = -a;
    g.add(root);
  }
  return { g, bodies: dynGround(g, 0.48, 150, [cylSh(0.24, 0.34, 0, 0.24, 0)], { fr: 0.8, rest: 0.05 }) };
}
function cactus(r, M) {
  const g = new THREE.Group();
  const green = M(jitterColor(r, r.pick(['#4c8c52', '#3f7d48', '#5a9a58'])), { rough: 0.8, env: 0.3 });
  const H = r.range(1.6, 2.0);
  const main = cyl(green, { r: 0.18, r2: 0.15, len: H, seg: 8 });
  main.position.y = H / 2;
  g.add(main);
  const top = sphere(green, 0.15, 1);
  top.scale.y = 0.7;
  top.position.y = H;
  g.add(top);
  for (const s of r.chance(0.85) ? (r.chance(0.5) ? [-1, 1] : [r.sign()]) : []) {
    const ay = r.range(0.55, 0.95) * H;
    const elbow = cyl(green, { r: 0.1, len: 0.34, axis: 'z', seg: 7 });
    elbow.position.set(0, ay, s * 0.28);
    g.add(elbow);
    const arm = cyl(green, { r: 0.1, r2: 0.085, len: r.range(0.5, 0.75), seg: 7 });
    arm.position.set(0, ay + 0.28, s * 0.4);
    g.add(arm);
    const tip = sphere(green, 0.085, 1);
    tip.scale.y = 0.7;
    tip.position.set(0, ay + 0.58, s * 0.4);
    g.add(tip);
  }
  if (r.chance(0.4)) {
    const fl = sphere(M('#e08cc0', { rough: 0.55 }), 0.055, 0);
    fl.position.y = H + 0.12;
    g.add(fl);
  }
  return { g, bodies: dynGround(g, H + 0.2, 130, [cylSh((H + 0.2) / 2, 0.2, 0, (H + 0.2) / 2, 0)], { fr: 0.7, rest: 0.1 }) };
}
function tumbleweed(r, M) {
  const g = new THREE.Group();
  const twig = M('#b09a5e', { rough: 0.95 });
  for (let i = 0; i < 4; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r.range(0.26, 0.34), 0.018, 5, 9), twig);
    ring.rotation.set(r.range(0, Math.PI), r.range(0, Math.PI), r.range(0, Math.PI));
    ring.position.y = 0.36;
    ring.castShadow = true;
    g.add(ring);
  }
  for (let i = 0; i < 5; i++) {
    const stick = cyl(twig, { r: 0.012, len: r.range(0.4, 0.62), seg: 4 });
    stick.position.y = 0.36;
    stick.rotation.set(r.range(0, Math.PI), r.range(0, Math.PI), r.range(0, Math.PI));
    g.add(stick);
  }
  return { g, bodies: dynGround(g, 0.72, 2.5, [boxSh(0.28, 0.28, 0.28, 0, 0.36, 0)], { fr: 0.4, rest: 0.45 }) };
}
function flowersWild(r, M) {
  const g = new THREE.Group();
  const dirt = new THREE.Mesh(new THREE.CircleGeometry(0.55, 9), M('#55452f', { rough: 0.95 }));
  dirt.rotation.x = -Math.PI / 2;
  dirt.position.y = 0.012;
  dirt.receiveShadow = true;
  g.add(dirt);
  flowerHeads(g, M, r, -0.42, 0.42, -0.42, 0.42, 0, r.int(8, 12));
  for (let i = 0; i < 7; i++) {
    const blade = box(M(r.pick(['#6b9a48', '#5a8a3c']), { rough: 0.85 }), 0.035, r.range(0.16, 0.3), 0.012);
    blade.position.set(r.range(-0.45, 0.45), 0.1, r.range(-0.45, 0.45));
    blade.rotation.y = r.range(0, Math.PI);
    blade.rotation.z = r.range(-0.25, 0.25);
    g.add(blade);
  }
  return { g, bodies: [] };
}
function logPile(r, M) {
  const g = new THREE.Group();
  P.logsLoad(g, M, { x0: -0.95, x1: 0.95, y: 0, w: 1.6 });
  return { g, bodies: dynGround(g, 1.16, 380, [boxSh(0.95, 0.55, 0.52, 0, 0.55, 0)], { fr: 0.7, rest: 0.08 }) };
}
function hayBale(r, M) {
  const g = new THREE.Group();
  const hay = M(jitterColor(r, '#d9c26a'), { rough: 0.92 });
  const bale = cyl(hay, { r: 0.5, len: 0.85, axis: 'z', seg: 12 });
  bale.position.y = 0.5;
  g.add(bale);
  for (const z of [-0.2, 0.2]) {
    const band = cyl(M('#b89a4a', { rough: 0.9 }), { r: 0.51, len: 0.06, axis: 'z', seg: 12 });
    band.position.set(0, 0.5, z);
    g.add(band);
  }
  const core = cyl(M('#c0a854', { rough: 0.92 }), { r: 0.2, len: 0.87, axis: 'z', seg: 9 });
  core.position.y = 0.5;
  g.add(core);
  return { g, bodies: dynGround(g, 1.0, 190, [
    { kind: 'cyl', hh: 0.42, r: 0.5, pos: [0, 0.5, 0], rot: quatArr(Math.PI / 2, 0, 0) }, // rolls!
  ], { fr: 0.55, rest: 0.1 }) };
}
function stoneWall(r, M) {
  const g = new THREE.Group();
  const stone = M(r.pick(ROCKS), { rough: 0.95 });
  const base = box(stone, 2.4, 0.6, 0.4);
  jitterGeo(base, r, 0.045);
  base.position.y = 0.3;
  g.add(base);
  for (let i = 0; i < r.int(5, 7); i++) { // cap stones
    const s = sphere(M(r.pick(ROCKS), { rough: 0.95 }), r.range(0.12, 0.18), 0);
    jitterGeo(s, r, 0.03);
    s.scale.y = 0.6;
    s.position.set(r.range(-1.05, 1.05), 0.63, r.range(-0.08, 0.08));
    g.add(s);
  }
  return { g, bodies: fixedBody(g, [boxSh(1.2, 0.34, 0.22, 0, 0.34, 0)], 0.85, 0.05) };
}

/* ---- suburbia ---- */
function fenceGate(r, M) {
  const g = new THREE.Group();
  const mat = M(r.pick(['#eceff1', '#e8e0d0', '#b08a54']), { rough: 0.8 });
  for (const s of [-1, 1]) {
    const post = box(mat, 0.11, 1.12, 0.11);
    post.position.set(s * 0.62, 0.56, 0);
    g.add(post);
    const ball = sphere(mat, 0.075, 1);
    ball.position.set(s * 0.62, 1.16, 0);
    g.add(ball);
  }
  const n = 6;
  for (let i = 0; i < n; i++) { // arched gate pickets
    const f = i / (n - 1);
    const h = 0.62 + Math.sin(f * Math.PI) * 0.24;
    const p = box(mat, 0.085, h, 0.03);
    p.position.set(-0.45 + f * 0.9, 0.16 + h / 2, 0.04);
    g.add(p);
  }
  for (const y of [0.3, 0.68]) {
    const rail = box(mat, 1.0, 0.07, 0.035);
    rail.position.set(0, y, 0.065);
    g.add(rail);
  }
  const hinge = box(M('#33373d', { rough: 0.6 }), 0.05, 0.09, 0.06);
  hinge.position.set(-0.54, 0.68, 0.05);
  g.add(hinge);
  return { g, bodies: dynGround(g, 1.24, 22, [boxSh(0.7, 0.56, 0.08, 0, 0.56, 0.02)], { fr: 0.6, rest: 0.08 }) };
}
function fenceMetal(r, M) {
  const g = new THREE.Group();
  const mat = M(r.pick(['#2e6339', '#26292e', '#2b3a55']), { rough: 0.5, metal: 0.35, env: 0.7 });
  const len = 2.6;
  for (const x of [-len / 2, 0, len / 2]) {
    const post = box(mat, 0.06, 1.06, 0.06);
    post.position.set(x, 0.53, 0);
    g.add(post);
    const fin = sphere(mat, 0.05, 0);
    fin.position.set(x, 1.1, 0);
    g.add(fin);
  }
  for (const y of [0.28, 0.95]) {
    const rail = box(mat, len, 0.055, 0.04);
    rail.position.set(0, y, 0);
    g.add(rail);
  }
  const n = Math.round(len / 0.16);
  for (let i = 1; i < n; i++) {
    const b = cyl(mat, { r: 0.013, len: 0.72, seg: 5 });
    b.position.set(-len / 2 + (i / n) * len, 0.6, 0);
    g.add(b);
  }
  return { g, bodies: dynGround(g, 1.14, 60, [boxSh(len / 2, 0.55, 0.05, 0, 0.55, 0)], { fr: 0.5, rest: 0.1 }) };
}
function doghouse(r, M) {
  const g = new THREE.Group();
  const wallHex = r.pick(['#8c5a4a', '#75552f', '#8c3a34', '#3a5e8c']);
  const b = box(M(wallHex, { rough: 0.8 }), 0.95, 0.72, 0.85);
  b.position.y = 0.4;
  g.add(b);
  for (const s of [-1, 1]) {
    const panel = box(M('#4a4e55', { rough: 0.85 }), 1.08, 0.05, 0.58);
    panel.position.set(0, 0.92, s * 0.21);
    panel.rotation.x = s * 0.55; // +z panel drops its outer edge → real gable
    g.add(panel);
  }
  const door = new THREE.Mesh(new THREE.CircleGeometry(0.2, 12), M('#1c1e22', { rough: 0.95 }));
  door.rotation.y = Math.PI / 2;
  door.position.set(0.48, 0.34, 0);
  g.add(door);
  const trim = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.25, 12), M('#f2f3f5', { rough: 0.7 }));
  trim.rotation.y = Math.PI / 2;
  trim.position.set(0.481, 0.34, 0);
  g.add(trim);
  if (r.chance(0.5)) {
    const bowl = cyl(M('#c9302c', { rough: 0.5 }), { r: 0.09, r2: 0.11, len: 0.06, seg: 8 });
    bowl.position.set(0.75, 0.03, 0.3);
    g.add(bowl);
  }
  return { g, bodies: dynGround(g, 1.22, 55, [boxSh(0.48, 0.55, 0.43, 0, 0.55, 0)], { fr: 0.65, rest: 0.12 }) };
}
function bbqGrill(r, M) {
  const g = new THREE.Group();
  const dark = M('#26292e', { rough: 0.6 });
  const drum = cyl(dark, { r: 0.29, len: 0.64, axis: 'z', seg: 10 });
  drum.position.y = 0.82;
  g.add(drum);
  const lidHandle = box(M('#8a6a3f', { rough: 0.8 }), 0.05, 0.05, 0.3);
  lidHandle.position.y = 1.14;
  g.add(lidHandle);
  const shelf = box(M('#8a6a3f', { rough: 0.85 }), 0.42, 0.035, 0.5);
  shelf.position.set(0.5, 0.82, 0);
  g.add(shelf);
  if (r.chance(0.6)) {
    const chim = cyl(dark, { r: 0.045, len: 0.28, seg: 7 });
    chim.position.set(-0.18, 1.22, 0);
    g.add(chim);
  }
  for (const [sx, sz] of [[-0.2, 0.24], [-0.2, -0.24], [0.22, 0]]) {
    const leg = cyl(M('#3d4147', { rough: 0.6, metal: 0.3 }), { r: 0.025, len: 0.56, seg: 6 });
    leg.position.set(sx, 0.28, sz);
    g.add(leg);
  }
  for (const s of [-1, 1]) {
    const wheel = cyl(dark, { r: 0.07, len: 0.04, axis: 'z', seg: 9 });
    wheel.position.set(-0.2, 0.07, s * 0.26);
    g.add(wheel);
  }
  return { g, bodies: dynGround(g, 1.18, 42, [
    cylSh(0.3, 0.32, 0, 0.82, 0),
    boxSh(0.2, 0.28, 0.2, 0, 0.28, 0),
  ], { fr: 0.55, rest: 0.18 }) };
}
function birdbath(r, M) {
  const g = new THREE.Group();
  const stone = M(r.pick(['#b3b8be', '#c9ccd2', '#a8a094']), { rough: 0.88 });
  const foot = cyl(stone, { r: 0.22, r2: 0.14, len: 0.1, seg: 9 });
  foot.position.y = 0.05;
  g.add(foot);
  const col = cyl(stone, { r: 0.075, r2: 0.06, len: 0.62, seg: 8 });
  col.position.y = 0.4;
  g.add(col);
  const bowl = cyl(stone, { r: 0.16, r2: 0.42, len: 0.14, seg: 10 });
  bowl.position.y = 0.76;
  g.add(bowl);
  const water = cyl(M('#3f86c9', { rough: 0.12, env: 0.9 }), { r: 0.36, len: 0.025, seg: 10 });
  water.position.y = 0.835;
  g.add(water);
  if (r.chance(0.55)) { // little bird on the rim
    const bird = sphere(M(r.pick(['#c9302c', '#5f9ecc', '#8a6a3f']), { rough: 0.7 }), 0.055, 1);
    bird.scale.set(1.3, 1, 1);
    bird.position.set(0.36, 0.9, 0);
    g.add(bird);
    const head = sphere(M('#33373d', { rough: 0.7 }), 0.032, 0);
    head.position.set(0.43, 0.95, 0);
    g.add(head);
  }
  return { g, bodies: dynGround(g, 0.88, 55, [cylSh(0.44, 0.2, 0, 0.44, 0)], { fr: 0.6, rest: 0.12 }) };
}
function wheelbarrow(r, M) {
  const g = new THREE.Group();
  const hex = r.pick(['#3e8948', '#c9403a', '#3a76c4']);
  const tub = slab(M(hex, { rough: 0.55 }), { x0: -0.48, x1: 0.42, y0: 0.32, y1: 0.62, w: 0.5, wT: 0.68 });
  g.add(tub);
  const wood = M('#8a6a3f', { rough: 0.85 });
  for (const s of [-1, 1]) {
    const handle = box(wood, 1.15, 0.045, 0.05);
    handle.position.set(0.35, 0.3, s * 0.2);
    handle.rotation.z = -0.1;
    g.add(handle);
    const leg = box(M('#3d4147', { rough: 0.6 }), 0.04, 0.3, 0.04);
    leg.position.set(0.3, 0.15, s * 0.2);
    g.add(leg);
  }
  const wheel = P.wheel(M, 0.17, 0.08, { seg: 10 });
  wheel.position.set(-0.58, 0.17, 0);
  g.add(wheel);
  return { g, bodies: dynGround(g, 0.66, 24, [boxSh(0.45, 0.16, 0.3, 0, 0.46, 0)], { fr: 0.55, rest: 0.2 }) };
}
function well(r, M) {
  const g = new THREE.Group();
  const stone = M(r.pick(['#a3a8ae', '#98918a']), { rough: 0.92 });
  const ring = cyl(stone, { r: 0.52, r2: 0.5, len: 0.55, seg: 10 });
  jitterGeo(ring, r, 0.03);
  ring.position.y = 0.275;
  g.add(ring);
  const hole = cyl(M('#16181c', { rough: 1 }), { r: 0.38, len: 0.02, seg: 10 });
  hole.position.y = 0.56;
  g.add(hole);
  const wood = M('#75552f', { rough: 0.85 });
  for (const s of [-1, 1]) {
    const post = box(wood, 0.09, 1.05, 0.09);
    post.position.set(0, 1.05, s * 0.48);
    g.add(post);
  }
  for (const s of [-1, 1]) { // little gable roof, ridge across the posts
    const panel = box(M('#5a4633', { rough: 0.85 }), 0.78, 0.045, 0.72);
    panel.position.set(s * 0.21, 1.72, 0);
    panel.rotation.z = -s * 0.55; // outer (+x) edge drops → gable, not valley
    g.add(panel);
  }
  const axle = cyl(wood, { r: 0.05, len: 1.0, axis: 'z', seg: 7 });
  axle.position.y = 1.32;
  g.add(axle);
  const crank = box(M('#3d4147', { rough: 0.6 }), 0.04, 0.2, 0.04);
  crank.position.set(0, 1.24, 0.54);
  g.add(crank);
  const rope = box(M('#8a6a3f', { rough: 0.95 }), 0.025, 0.55, 0.025);
  rope.position.y = 1.02;
  g.add(rope);
  const bucket = cyl(M('#6d4a2b', { rough: 0.85 }), { r: 0.1, r2: 0.12, len: 0.14, seg: 8 });
  bucket.position.y = 0.7;
  g.add(bucket);
  return { g, bodies: fixedBody(g, [cylSh(0.28, 0.54, 0, 0.28, 0), boxSh(0.06, 1.0, 0.55, 0, 1.0, 0)], 0.8, 0.05) };
}
function trampoline(r, M) {
  const g = new THREE.Group();
  const steel = M('#8d939a', { rough: 0.5, metal: 0.4 });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const leg = cyl(steel, { r: 0.03, len: 0.56, seg: 6 });
    leg.position.set(Math.cos(a) * 0.88, 0.28, Math.sin(a) * 0.88);
    g.add(leg);
  }
  const mat2 = cyl(M('#22252a', { rough: 0.85 }), { r: 0.88, len: 0.045, seg: 14 });
  mat2.position.y = 0.57;
  g.add(mat2);
  const pad = new THREE.Mesh(new THREE.TorusGeometry(0.92, 0.11, 6, 14), M(r.pick(['#3a76c4', '#3e8948', '#c9403a']), { rough: 0.6 }));
  pad.rotation.x = Math.PI / 2;
  pad.scale.z = 0.45;
  pad.position.y = 0.6;
  pad.castShadow = true;
  g.add(pad);
  // the mat is a launch pad: near-full restitution
  return { g, bodies: fixedBody(g, [cylSh(0.05, 0.95, 0, 0.55, 0)], 0.7, 0.92) };
}
function basketballHoop(r, M) {
  const g = new THREE.Group();
  const steel = M('#3d4147', { rough: 0.55, metal: 0.3 });
  const base = box(steel, 0.62, 0.22, 0.75);
  base.position.set(-0.3, 0.11, 0);
  g.add(base);
  const pole = cyl(steel, { r: 0.055, len: 2.95, seg: 8 });
  pole.position.set(-0.3, 0.22 + 1.475, 0);
  g.add(pole);
  const arm = box(steel, 0.6, 0.06, 0.06);
  arm.position.set(0, 2.95, 0);
  g.add(arm);
  const board = box(M('#eef0f2', { rough: 0.5 }), 0.045, 0.85, 1.15);
  board.position.set(0.32, 2.85, 0);
  g.add(board);
  P.facePane(g, { x0b: 0.32, x1b: 0.32, x0t: 0.32, x1t: 0.32, zb: 1.15, zt: 1.15, y0: 2.42, y1: 3.28 }, 'front', [0.33, 0.67, 0.12, 0.55], M('#e07b39', { rough: 0.55 }), 0.02, 0.03);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.23, 0.02, 6, 12), M('#e0662e', { rough: 0.4, metal: 0.3 }));
  rim.rotation.x = Math.PI / 2;
  rim.position.set(0.58, 2.55, 0);
  rim.castShadow = true;
  g.add(rim);
  const net = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.13, 0.3, 9, 1, true), tMat('#f2f3f5', 0.5));
  net.position.set(0.58, 2.38, 0);
  g.add(net);
  return { g, bodies: dynGround(g, 3.3, 150, [
    boxSh(0.31, 0.11, 0.37, -0.3, 0.11, 0),
    cylSh(1.48, 0.07, -0.3, 1.7, 0),
    boxSh(0.03, 0.43, 0.58, 0.32, 2.85, 0),
  ], { fr: 0.55, rest: 0.2 }) };
}
function soccerGoal(r, M) {
  const g = new THREE.Group();
  const white = M('#eef0f2', { rough: 0.5 });
  for (const s of [-1, 1]) {
    const post = cyl(white, { r: 0.045, len: 1.5, seg: 7 });
    post.position.set(0.55, 0.75, s * 1.2);
    g.add(post);
    const stay = cyl(white, { r: 0.035, len: 1.55, seg: 6 });
    stay.position.set(0, 0.65, s * 1.2);
    stay.rotation.z = 0.75;
    g.add(stay);
  }
  const bar = cyl(white, { r: 0.045, len: 2.48, axis: 'z', seg: 7 });
  bar.position.set(0.55, 1.5, 0);
  g.add(bar);
  const backBar = cyl(white, { r: 0.03, len: 2.48, axis: 'z', seg: 6 });
  backBar.position.set(-0.58, 0.06, 0);
  g.add(backBar);
  // net: thin translucent slab sloping from the crossbar to the ground bar
  const net = box(tMat('#e8eaec', 0.3), 1.66, 0.015, 2.3);
  net.position.set(-0.05, 0.74, 0);
  net.rotation.z = 0.9;
  net.castShadow = false;
  g.add(net);
  return { g, bodies: dynGround(g, 1.55, 35, [
    boxSh(0.05, 0.75, 1.24, 0.55, 0.75, 0),
    boxSh(0.6, 0.06, 1.24, -0.05, 0.08, 0),
  ], { fr: 0.5, rest: 0.15 }) };
}
function kiddiePool(r, M) {
  const g = new THREE.Group();
  const hex = r.pick(['#5f9ecc', '#e08cc0', '#7fb85a']);
  const wall = cyl(M(hex, { rough: 0.55 }), { r: 0.78, r2: 0.74, len: 0.3, seg: 12 });
  wall.position.y = 0.15;
  g.add(wall);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.055, 6, 12), M(shade(hex, 0.08), { rough: 0.55 }));
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.3;
  rim.castShadow = true;
  g.add(rim);
  const water = cyl(M('#7fc0e8', { rough: 0.15, env: 0.9 }), { r: 0.68, len: 0.02, seg: 12 });
  water.position.y = 0.26;
  g.add(water);
  if (r.chance(0.7)) { // rubber duck
    const duck = sphere(M('#e3c53a', { rough: 0.4, env: 0.8 }), 0.11, 1);
    duck.scale.y = 0.75;
    duck.position.set(0.2, 0.32, 0.1);
    g.add(duck);
    const head = sphere(M('#e3c53a', { rough: 0.4, env: 0.8 }), 0.065, 1);
    head.position.set(0.29, 0.42, 0.1);
    g.add(head);
    const beak = box(M('#e0662e', { rough: 0.5 }), 0.06, 0.025, 0.04);
    beak.position.set(0.36, 0.41, 0.1);
    g.add(beak);
  }
  return { g, bodies: fixedBody(g, [cylSh(0.16, 0.78, 0, 0.16, 0)], 0.6, 0.2) };
}
function gardenGnome(r, M) {
  const g = new THREE.Group();
  const body = cyl(M(r.pick(['#3a76c4', '#3e8948', '#5f3f96']), { rough: 0.6 }), { r: 0.1, r2: 0.07, len: 0.22, seg: 8 });
  body.position.y = 0.13;
  g.add(body);
  const beard = sphere(M('#f2f3f5', { rough: 0.8 }), 0.065, 1);
  beard.scale.y = 1.2;
  beard.position.set(0.045, 0.26, 0);
  g.add(beard);
  const face = sphere(M('#e8b88a', { rough: 0.6 }), 0.05, 1);
  face.position.set(0.02, 0.32, 0);
  g.add(face);
  const hat = cyl(M('#c9302c', { rough: 0.55 }), { r: 0.068, r2: 0.008, len: 0.2, seg: 8 });
  hat.position.y = 0.44;
  hat.rotation.z = -0.12;
  g.add(hat);
  for (const s of [-1, 1]) {
    const shoe = box(M('#33373d', { rough: 0.7 }), 0.07, 0.03, 0.045);
    shoe.position.set(0.05, 0.015, s * 0.045);
    g.add(shoe);
  }
  return { g, bodies: dynGround(g, 0.53, 3.5, [cylSh(0.26, 0.09, 0, 0.26, 0)], { fr: 0.6, rest: 0.3 }) };
}
function seesaw(r, M) {
  const g = new THREE.Group();
  const [aHex, bHex] = r.pick([['#c9403a', '#e3c53a'], ['#3a76c4', '#c9403a'], ['#3e8948', '#e07b39']]);
  const pivot = slab(M(aHex, { rough: 0.55 }), { x0: -0.2, x1: 0.2, y0: 0, y1: 0.42, w: 0.42, wT: 0.1, nose: 0.14, tail: 0.14 });
  g.add(pivot);
  const plank = box(M(bHex, { rough: 0.55 }), 2.3, 0.05, 0.3);
  plank.position.y = 0.47;
  plank.rotation.z = 0.15;
  g.add(plank);
  for (const s of [-1, 1]) {
    const seat = box(M(aHex, { rough: 0.55 }), 0.3, 0.03, 0.3);
    seat.position.set(s * 0.98, 0.49 + s * 0.98 * 0.151, 0);
    seat.rotation.z = 0.15;
    g.add(seat);
    const grip = box(M('#3d4147', { rough: 0.6 }), 0.04, 0.16, 0.04);
    grip.position.set(s * 0.78, 0.58 + s * 0.78 * 0.151, 0);
    grip.rotation.z = 0.15;
    g.add(grip);
    const bar = box(M('#3d4147', { rough: 0.6 }), 0.04, 0.04, 0.3);
    bar.position.set(s * 0.78, 0.64 + s * 0.78 * 0.151, 0);
    bar.rotation.z = 0.15;
    g.add(bar);
  }
  return { g, bodies: dynGround(g, 0.85, 38, [
    { kind: 'box', he: [1.15, 0.03, 0.15], pos: [0, 0.47, 0], rot: quatArr(0, 0, 0.15) },
    boxSh(0.18, 0.21, 0.18, 0, 0.21, 0),
  ], { fr: 0.6, rest: 0.15 }) };
}
function statue(r, M) {
  const g = new THREE.Group();
  const stone = M('#b3b8be', { rough: 0.9 });
  const bronze = M(r.chance(0.6) ? '#6e8578' : '#8a7a5a', { rough: 0.45, metal: 0.55, env: 0.9 });
  const step = box(stone, 0.95, 0.14, 0.95);
  step.position.y = 0.07;
  g.add(step);
  const plinth = box(stone, 0.62, 0.55, 0.62);
  plinth.position.y = 0.42;
  g.add(plinth);
  const plaque = box(M('#8a7a5a', { rough: 0.4, metal: 0.5 }), 0.02, 0.16, 0.3);
  plaque.position.set(0.32, 0.42, 0);
  g.add(plaque);
  const legs = box(bronze, 0.2, 0.42, 0.26);
  legs.position.y = 0.9;
  g.add(legs);
  const torso = slab(bronze, { x0: -0.13, x1: 0.13, y0: 1.1, y1: 1.55, w: 0.3, wT: 0.38 });
  g.add(torso);
  const head = sphere(bronze, 0.11, 1);
  head.position.y = 1.68;
  g.add(head);
  const armUp = box(bronze, 0.08, 0.42, 0.08); // raised arm — heroic!
  armUp.position.set(0.05, 1.52, 0.14);
  armUp.rotation.x = -0.5;
  g.add(armUp);
  const armDown = box(bronze, 0.08, 0.36, 0.08);
  armDown.position.set(0, 1.3, -0.16);
  armDown.rotation.x = 0.28;
  g.add(armDown);
  return { g, bodies: dynGround(g, 1.85, 420, [
    boxSh(0.32, 0.35, 0.32, 0, 0.35, 0),
    boxSh(0.2, 0.55, 0.2, 0, 1.25, 0),
  ], { fr: 0.7, rest: 0.05 }) };
}
function waterTower(r, M) {
  const g = new THREE.Group();
  const steel = M(r.chance(0.55) ? '#8d939a' : '#a05a48', { rough: 0.55, metal: 0.35, env: 0.7 });
  const shapes = [];
  for (const [sx, sz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
    const leg = box(steel, 0.12, 3.4, 0.12);
    leg.position.set(sx * 0.8, 1.7, sz * 0.8);
    g.add(leg);
    shapes.push(boxSh(0.08, 1.7, 0.08, sx * 0.8, 1.7, sz * 0.8));
  }
  for (const y of [1.1, 2.4]) { // brace rings
    for (const s of [-1, 1]) {
      const bx = box(steel, 1.75, 0.06, 0.06);
      bx.position.set(0, y, s * 0.8);
      g.add(bx);
      const bz = box(steel, 0.06, 0.06, 1.75);
      bz.position.set(s * 0.8, y, 0);
      g.add(bz);
    }
  }
  const tank = cyl(steel, { r: 1.3, len: 1.55, seg: 12 });
  tank.position.y = 4.15;
  g.add(tank);
  const belly = cyl(steel, { r: 1.3, r2: 0.35, len: 0.55, seg: 12 });
  belly.rotation.x = Math.PI;
  belly.position.y = 3.1;
  g.add(belly);
  const roof = cyl(M('#5c6167', { rough: 0.6 }), { r: 1.4, r2: 0.06, len: 0.65, seg: 12 });
  roof.position.y = 5.25;
  g.add(roof);
  const ladder = box(M('#5c6167', { rough: 0.6 }), 0.04, 3.4, 0.24);
  ladder.position.set(0.95, 1.9, 0);
  g.add(ladder);
  shapes.push(cylSh(1.3, 1.35, 0, 4.2, 0));
  return { g, bodies: fixedBody(g, shapes, 0.6, 0.1) };
}
function flagpole(r, M) {
  const g = new THREE.Group();
  const base = cyl(M('#8d9096', { rough: 0.85 }), { r: 0.16, len: 0.12, seg: 9 });
  base.position.y = 0.06;
  g.add(base);
  const pole = cyl(M('#c9ced4', { rough: 0.3, metal: 0.6, env: 1.1 }), { r: 0.035, r2: 0.02, len: 5.1, seg: 8 });
  pole.position.y = 0.12 + 2.55;
  g.add(pole);
  const ball = sphere(M('#c9a03a', { rough: 0.3, metal: 0.7, env: 1.2 }), 0.07, 1);
  ball.position.y = 5.3;
  g.add(ball);
  const hex = r.pick(['#e07b39', '#c9302c', '#3a76c4', '#3e8948']);
  const flag = slab(M(hex, { rough: 0.65 }), { x0: 0.05, x1: 1.05, y0: 4.55, y1: 5.1, w: 0.03, nose: 0.28 });
  g.add(flag);
  const stripe = slab(M('#f2f3f5', { rough: 0.65 }), { x0: 0.05, x1: 0.82, y0: 4.72, y1: 4.9, w: 0.035 });
  g.add(stripe);
  return { g, bodies: dynGround(g, 5.4, 70, [cylSh(2.7, 0.05, 0, 2.7, 0)], { fr: 0.5, rest: 0.15 }) };
}

/* ---- street & city ---- */
function buildingCity(r, M) {
  const g = new THREE.Group();
  const wallHex = jitterColor(r, r.pick(['#a05a48', '#8c6a52', '#c8b89a', '#7a8577', '#5a6b7a', '#b08468']));
  const accent = r.pick(ACCENTS);
  const wall = M(wallHex, { rough: 0.75, env: 0.3 });
  const glass = M('#8fb4cf', { rough: 0.2, env: 1.25 });
  const floors = r.int(3, 4);
  const D = r.jitter(5.4, 0.07), W = r.jitter(6.8, 0.09);
  const y0 = 0.12, fh = 1.7;
  const top = y0 + floors * fh;
  const found = box(M('#8d9096', { rough: 0.9 }), D + 0.1, 0.12, W + 0.1);
  found.position.y = 0.06;
  g.add(found);
  const body = slab(wall, { x0: -D / 2, x1: D / 2, y0, y1: top, w: W });
  g.add(body);
  const pt = body.userData.pt;
  const vy = (y) => (y - y0) / (top - y0);
  // ground floor: storefront + door
  g.add(panesOnQuad(faceQuad(pt, 'front'), glass, { cols: 3, gap: 0.03, f0: 0.07, f1: 0.66, v0: vy(y0 + 0.22), v1: vy(y0 + 1.4), t: 0.03 }));
  P.facePane(g, pt, 'front', [0.74, 0.88, vy(y0 + 0.02), vy(y0 + 1.4)], glass, 0.03, 0.012);
  const band = box(M(accent, { rough: 0.55 }), 0.07, 0.42, W * 0.92);
  band.position.set(D / 2 + 0.035, y0 + fh - 0.1, 0);
  g.add(band);
  for (let i = 0; i < 4; i++) {
    const chip = box(M('#f2f3f5', { rough: 0.5 }), 0.03, 0.18, r.range(0.18, 0.34));
    chip.position.set(D / 2 + 0.085, y0 + fh - 0.1, -W * 0.3 + (i / 3) * W * 0.6);
    g.add(chip);
  }
  // upper floors: window grid + sill bands
  for (let f = 2; f <= floors; f++) {
    const fy = y0 + (f - 1) * fh;
    g.add(panesOnQuad(faceQuad(pt, 'front'), glass, { cols: 4, gap: 0.045, f0: 0.09, f1: 0.91, v0: vy(fy + 0.45), v1: vy(fy + 1.3), t: 0.026 }));
    for (const side of ['left', 'right']) {
      g.add(panesOnQuad(faceQuad(pt, side), glass, { cols: 3, gap: 0.05, f0: 0.14, f1: 0.86, v0: vy(fy + 0.45), v1: vy(fy + 1.3), t: 0.026 }));
    }
    P.facePane(g, pt, 'front', [0.04, 0.96, vy(fy + 0.32), vy(fy + 0.42)], M(shade(wallHex, -0.09), { rough: 0.7 }), 0.02, 0.008);
  }
  const parapet = slab(M(shade(wallHex, -0.08), { rough: 0.7 }), { x0: -D / 2 - 0.07, x1: D / 2 + 0.07, y0: top - 0.02, y1: top + 0.38, w: W + 0.14 });
  g.add(parapet);
  for (let i = 0; i < 2; i++) {
    const ac = box(M('#c9ccd2', { rough: 0.6 }), 0.7, 0.4, 0.55);
    ac.position.set(r.range(-D * 0.25, D * 0.25), top + 0.2, (i - 0.5) * W * 0.4);
    g.add(ac);
  }
  if (r.chance(0.5)) { // rooftop water tank — classic skyline silhouette
    const tk = cyl(M('#75552f', { rough: 0.85 }), { r: 0.5, len: 0.85, seg: 9 });
    tk.position.set(0, top + 0.62, W * 0.28);
    g.add(tk);
    const tkRoof = cyl(M('#5a4633', { rough: 0.85 }), { r: 0.56, r2: 0.05, len: 0.3, seg: 9 });
    tkRoof.position.set(0, top + 1.2, W * 0.28);
    g.add(tkRoof);
  }
  return { g, bodies: fixedBody(g, [boxSh(D / 2 + 0.07, (top + 0.38) / 2, W / 2 + 0.07, 0, (top + 0.38) / 2, 0)], 0.8, 0.05) };
}
function marketStall(r, M) {
  const g = new THREE.Group();
  const accent = r.pick(['#c9302c', '#3e8948', '#3a76c4', '#e07b39']);
  const wood = M('#8a6a3f', { rough: 0.85 });
  const table = box(wood, 1.5, 0.07, 0.95);
  table.position.y = 0.78;
  g.add(table);
  for (const [sx, sz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
    const leg = box(wood, 0.06, 0.75, 0.06);
    leg.position.set(sx * 0.68, 0.375, sz * 0.4);
    g.add(leg);
    const post = box(wood, 0.05, 1.25, 0.05);
    post.position.set(sx * 0.68, 1.45, sz * 0.4);
    g.add(post);
  }
  for (const s of [-1, 1]) { // striped gable canopy
    for (let i = 0; i < 4; i++) {
      const slat = box(M(i % 2 ? '#f7f3ea' : accent, { rough: 0.7 }), 1.7 / 4, 0.028, 0.62);
      slat.position.set(-0.85 + (i + 0.5) * (1.7 / 4), 2.2, s * 0.26);
      slat.rotation.x = s * 0.45;
      g.add(slat);
    }
  }
  const kinds = [['#c9403a', '#b83a30'], ['#e8a02e', '#d99426'], ['#7fb85a', '#6da84c']];
  for (let c = 0; c < 2; c++) { // produce crates
    const crate = box(M('#9a7a4f', { rough: 0.85 }), 0.42, 0.16, 0.42);
    crate.position.set(-0.35 + c * 0.75, 0.9, 0);
    g.add(crate);
    const [f1, f2] = r.pick(kinds);
    for (let i = 0; i < 5; i++) {
      const fruit = sphere(M(i % 2 ? f1 : f2, { rough: 0.5, env: 0.6 }), 0.06, 0);
      fruit.position.set(-0.35 + c * 0.75 + r.range(-0.12, 0.12), 1.02, r.range(-0.12, 0.12));
      g.add(fruit);
    }
  }
  return { g, bodies: dynGround(g, 2.35, 80, [
    boxSh(0.75, 0.42, 0.48, 0, 0.45, 0),
    boxSh(0.85, 0.06, 0.55, 0, 2.2, 0),
  ], { fr: 0.55, rest: 0.15 }) };
}
function planterStone(r, M) {
  const g = new THREE.Group();
  const pot = cyl(M(r.pick(['#a3a8ae', '#b3b8be', '#98918a']), { rough: 0.9 }), { r: 0.55, r2: 0.6, len: 0.46, seg: 6 });
  pot.position.y = 0.23;
  g.add(pot);
  const soil = cyl(M('#4e3a26', { rough: 0.95 }), { r: 0.52, len: 0.03, seg: 6 });
  soil.position.y = 0.46;
  g.add(soil);
  if (r.chance(0.4)) {
    const c = canopy(M, r, r.pick(GREENS), 0.42, { squash: 0.8 });
    c.position.y = 0.78;
    g.add(c);
  } else flowerHeads(g, M, r, -0.32, 0.32, -0.32, 0.32, 0.46, r.int(5, 8));
  return { g, bodies: dynGround(g, 0.5, 210, [cylSh(0.25, 0.58, 0, 0.25, 0)], { fr: 0.7, rest: 0.08 }) };
}
function bollard(r, M) {
  const g = new THREE.Group();
  const hex = r.pick(['#33373d', '#a3a8ae', '#2b3a55']);
  const b = cyl(M(hex, { rough: 0.7 }), { r: 0.115, r2: 0.1, len: 0.56, seg: 9 });
  b.position.y = 0.28;
  g.add(b);
  const capD = sphere(M(hex, { rough: 0.7 }), 0.1, 1);
  capD.scale.y = 0.6;
  capD.position.y = 0.57;
  g.add(capD);
  if (r.chance(0.6)) {
    const band = cyl(M('#f2f3f5', { rough: 0.45, env: 0.8 }), { r: 0.118, len: 0.07, seg: 9 });
    band.position.y = 0.46;
    g.add(band);
  }
  return { g, bodies: dynGround(g, 0.64, 85, [cylSh(0.32, 0.12, 0, 0.32, 0)], { fr: 0.6, rest: 0.15 }) };
}
function retainingWall(r, M) {
  const g = new THREE.Group();
  const conc = M(r.pick(['#a2a4aa', '#98918a']), { rough: 0.92 });
  const wallB = box(conc, 2.4, 1.0, 0.28);
  wallB.position.y = 0.5;
  g.add(wallB);
  const cap = box(M(shade('#a2a4aa', -0.06), { rough: 0.9 }), 2.5, 0.09, 0.36);
  cap.position.y = 1.04;
  g.add(cap);
  for (const x of [-0.8, 0, 0.8]) {
    const seam = box(M('#8a8c92', { rough: 0.95 }), 0.02, 0.95, 0.29);
    seam.position.set(x, 0.5, 0);
    g.add(seam);
  }
  return { g, bodies: fixedBody(g, [boxSh(1.25, 0.55, 0.18, 0, 0.55, 0)], 0.8, 0.1) };
}
function utilityPole(r, M) {
  const g = new THREE.Group();
  const wood = M('#75552f', { rough: 0.95 });
  const pole = cyl(wood, { r: 0.075, r2: 0.09, len: 5.4, seg: 8 });
  pole.position.y = 2.7;
  g.add(pole);
  const arm = box(wood, 0.09, 0.09, 1.7);
  arm.position.y = 4.9;
  g.add(arm);
  for (const z of [-0.7, 0, 0.7]) {
    const ins = cyl(M('#c9ccd2', { rough: 0.4 }), { r: 0.035, len: 0.09, seg: 6 });
    ins.position.set(0, 5.0, z);
    g.add(ins);
  }
  const brace = box(wood, 0.05, 0.7, 0.05);
  brace.position.set(0, 4.55, 0.35);
  brace.rotation.x = 0.55;
  g.add(brace);
  if (r.chance(0.7)) { // transformer drum
    const tr = cyl(M('#5c6167', { rough: 0.6, metal: 0.2 }), { r: 0.2, len: 0.52, seg: 9 });
    tr.position.set(0, 4.1, 0.32);
    g.add(tr);
  }
  return { g, bodies: dynGround(g, 5.5, 230, [
    cylSh(2.75, 0.1, 0, 2.75, 0),
    boxSh(0.06, 0.06, 0.85, 0, 4.9, 0),
  ], { fr: 0.6, rest: 0.08 }) };
}
function lampCobra(r, M) {
  const g = new THREE.Group();
  const galv = M('#9aa0a7', { rough: 0.45, metal: 0.5, env: 0.9 });
  const base = cyl(M('#5c6167', { rough: 0.8 }), { r: 0.13, len: 0.14, seg: 8 });
  base.position.y = 0.07;
  g.add(base);
  const pole = cyl(galv, { r: 0.06, r2: 0.045, len: 4.3, seg: 8 });
  pole.position.y = 0.14 + 2.15;
  g.add(pole);
  const arm1 = cyl(galv, { r: 0.04, len: 0.85, seg: 7 });
  arm1.position.set(0.32, 4.55, 0);
  arm1.rotation.z = -1.05;
  g.add(arm1);
  const arm2 = cyl(galv, { r: 0.035, len: 0.7, axis: 'x', seg: 7 });
  arm2.position.set(0.98, 4.72, 0);
  g.add(arm2);
  const head = box(M('#3d4147', { rough: 0.5 }), 0.6, 0.09, 0.24);
  head.position.set(1.28, 4.72, 0);
  g.add(head);
  const lens = box(M('#fff2cf', { rough: 0.3, emissive: '#ffe9b0', emInt: 1.2 }), 0.4, 0.03, 0.16);
  lens.position.set(1.32, 4.66, 0);
  g.add(lens);
  return { g, bodies: dynGround(g, 4.8, 130, [
    cylSh(2.35, 0.07, 0, 2.35, 0),
    boxSh(0.32, 0.06, 0.13, 1.28, 4.72, 0),
  ], { fr: 0.5, rest: 0.1 }) };
}
function streetClock(r, M) {
  const g = new THREE.Group();
  const iron = M(r.chance(0.6) ? '#2e4a3f' : '#26292e', { rough: 0.55, metal: 0.2 });
  const base = cyl(iron, { r: 0.17, r2: 0.11, len: 0.32, seg: 9 });
  base.position.y = 0.16;
  g.add(base);
  const pole = cyl(iron, { r: 0.045, len: 2.15, seg: 8 });
  pole.position.y = 0.32 + 1.075;
  g.add(pole);
  const collar = cyl(iron, { r: 0.08, len: 0.06, seg: 8 });
  collar.position.y = 2.45;
  g.add(collar);
  const drum = cyl(iron, { r: 0.34, len: 0.14, axis: 'x', seg: 12 });
  drum.position.y = 2.85;
  g.add(drum);
  const face = canvasMat(128, 128, (x, w, h) => {
    x.fillStyle = '#f7f5ee';
    x.beginPath(); x.arc(64, 64, 62, 0, Math.PI * 2); x.fill();
    x.strokeStyle = '#26292e';
    x.lineWidth = 5;
    x.beginPath(); x.arc(64, 64, 58, 0, Math.PI * 2); x.stroke();
    x.lineWidth = 4;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      x.beginPath();
      x.moveTo(64 + Math.cos(a) * 48, 64 + Math.sin(a) * 48);
      x.lineTo(64 + Math.cos(a) * 54, 64 + Math.sin(a) * 54);
      x.stroke();
    }
    x.lineWidth = 6;
    x.beginPath(); x.moveTo(64, 64); x.lineTo(64, 30); x.stroke();  // ten past ten — showroom pose
    x.beginPath(); x.moveTo(64, 64); x.lineTo(88, 48); x.stroke();
  }, { fallback: '#f7f5ee' });
  for (const s of [-1, 1]) {
    const f = new THREE.Mesh(new THREE.CircleGeometry(0.29, 16), s === 1 ? face : face);
    f.rotation.y = s * Math.PI / 2;
    f.position.set(s * 0.078, 2.85, 0);
    g.add(f);
  }
  const crown = cyl(iron, { r: 0.1, r2: 0.02, len: 0.16, seg: 8 });
  crown.position.y = 3.28;
  g.add(crown);
  return { g, bodies: dynGround(g, 3.35, 110, [
    cylSh(1.35, 0.06, 0, 1.35, 0),
    boxSh(0.09, 0.35, 0.35, 0, 2.85, 0),
  ], { fr: 0.5, rest: 0.12 }) };
}
function parkingMeter(r, M) {
  const g = new THREE.Group();
  const pole = cyl(M('#5c6167', { rough: 0.5, metal: 0.4 }), { r: 0.028, len: 0.95, seg: 7 });
  pole.position.y = 0.475;
  g.add(pole);
  const head = box(M('#7a8087', { rough: 0.45, metal: 0.4, env: 0.8 }), 0.1, 0.22, 0.17);
  head.position.y = 1.06;
  g.add(head);
  const dome = cyl(M('#7a8087', { rough: 0.45, metal: 0.4, env: 0.8 }), { r: 0.085, len: 0.1, axis: 'x', seg: 9 });
  dome.position.y = 1.17;
  g.add(dome);
  const win = box(M(r.chance(0.3) ? '#c9403a' : '#dfe4ea', { rough: 0.35, env: 0.9 }), 0.02, 0.07, 0.11);
  win.position.set(0.052, 1.16, 0);
  g.add(win);
  const slot = box(M('#33373d', { rough: 0.6 }), 0.015, 0.04, 0.015);
  slot.position.set(0.055, 1.02, 0);
  g.add(slot);
  return { g, bodies: dynGround(g, 1.24, 12, [cylSh(0.62, 0.05, 0, 0.62, 0)], { fr: 0.5, rest: 0.28 }) };
}
function manhole(r, M) {
  const g = new THREE.Group();
  const iron = M('#4a4d52', { rough: 0.75, metal: 0.25 });
  const rim = cyl(M('#3d4045', { rough: 0.8 }), { r: 0.4, len: 0.014, seg: 14 });
  rim.position.y = 0.007;
  rim.receiveShadow = true;
  g.add(rim);
  const lid = cyl(iron, { r: 0.34, len: 0.022, seg: 14 });
  lid.position.y = 0.018;
  lid.receiveShadow = true;
  g.add(lid);
  const rng = makeRng('mh:' + r.int(0, 999));
  for (let i = 0; i < 8; i++) { // tread pattern
    const a = (i / 8) * Math.PI * 2;
    const dot = box(M('#565a60', { rough: 0.7 }), 0.1, 0.008, 0.03);
    dot.position.set(Math.cos(a) * 0.2, 0.032, Math.sin(a) * 0.2);
    dot.rotation.y = -a;
    g.add(dot);
  }
  return { g, bodies: [] };
}
function drainGrate(r, M) {
  const g = new THREE.Group();
  const frame = box(M('#3d4045', { rough: 0.8 }), 0.78, 0.026, 0.56);
  frame.position.y = 0.013;
  frame.receiveShadow = true;
  g.add(frame);
  for (let i = 0; i < 6; i++) {
    const slat = box(M('#565a60', { rough: 0.7, metal: 0.2 }), 0.62, 0.014, 0.045);
    slat.position.set(0, 0.03, -0.2 + i * 0.08);
    g.add(slat);
  }
  return { g, bodies: [] };
}
function sidewalkSlab(r, M) {
  const g = new THREE.Group();
  const slab1 = box(M(jitterColor(r, '#b9bec4', 0.003, 0.02, 0.03), { rough: 0.95 }), 1.5, 0.05, 1.5);
  slab1.position.y = 0.025;
  slab1.receiveShadow = true;
  g.add(slab1);
  for (const [w, d, x, z] of [[1.5, 0.02, 0, 0], [0.02, 1.5, 0, 0]]) {
    const groove = box(M('#9aa0a7', { rough: 0.95 }), w, 0.052, d);
    groove.position.set(x, 0.026, z);
    g.add(groove);
  }
  if (r.chance(0.3)) { // crack
    const crack = box(M('#9aa0a7', { rough: 0.95 }), 0.65, 0.052, 0.018);
    crack.position.set(r.range(-0.3, 0.3), 0.026, r.range(-0.5, 0.5));
    crack.rotation.y = r.range(0, Math.PI);
    g.add(crack);
  }
  return { g, bodies: [] };
}
function portaPotty(r, M) {
  const g = new THREE.Group();
  const hex = r.pick(['#2f6bb0', '#3e8948', '#2f6bb0', '#e07b39']);
  const skid = box(M('#33373d', { rough: 0.8 }), 1.05, 0.08, 1.05);
  skid.position.y = 0.04;
  g.add(skid);
  const bodyS = slab(M(hex, { rough: 0.55 }), { x0: -0.48, x1: 0.48, y0: 0.08, y1: 2.02, w: 0.95, wT: 0.88 });
  g.add(bodyS);
  const pt = bodyS.userData.pt;
  P.facePane(g, pt, 'front', [0.16, 0.84, 0.03, 0.9], M(shade(hex, -0.09), { rough: 0.6 }), 0.035, 0.012);
  P.facePane(g, pt, 'front', [0.7, 0.78, 0.42, 0.52], M('#c9ccd2', { rough: 0.4 }), 0.03, 0.05); // handle
  for (const side of ['left', 'right']) {
    P.facePane(g, pt, side, [0.2, 0.8, 0.82, 0.92], M('#dfe4ea', { rough: 0.5 }), 0.02, 0.01); // vent
  }
  const roof = slab(M('#eef0f2', { rough: 0.55 }), { x0: -0.52, x1: 0.52, y0: 2.02, y1: 2.14, w: 1.02, wT: 0.9, nose: 0.06, tail: 0.06 });
  g.add(roof);
  return { g, bodies: dynGround(g, 2.16, 85, [boxSh(0.5, 1.05, 0.5, 0, 1.08, 0)], { fr: 0.5, rest: 0.2 }) };
}
function tireStack(r, M) {
  const g = new THREE.Group();
  const rubber = M('#232629', { rough: 0.95, env: 0.2 });
  const n = r.int(3, 4);
  for (let i = 0; i < n; i++) {
    const tire = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.125, 7, 12), rubber);
    tire.rotation.x = Math.PI / 2;
    tire.scale.z = 0.62;
    tire.position.set(r.range(-0.05, 0.05), 0.13 + i * 0.17, r.range(-0.05, 0.05));
    if (i === n - 1) tire.rotation.y = r.range(0, 1);
    tire.castShadow = true;
    g.add(tire);
  }
  return { g, bodies: dynGround(g, 0.26 + n * 0.17, 45 + n * 12, [
    cylSh((0.26 + n * 0.17) / 2, 0.42, 0, (0.26 + n * 0.17) / 2, 0),
  ], { fr: 0.7, rest: 0.4 }) };
}

/* ---- signs & traffic (batch 2) ---- */
function gantry(r, M) {
  const g = new THREE.Group();
  const steel = M('#b3b8be', { rough: 0.45, metal: 0.4, env: 0.9 });
  const H = 5.3, SPAN = 9;
  const shapes = [];
  for (const s of [-1, 1]) { // lattice columns
    for (const dx of [-0.26, 0.26]) {
      const leg = box(steel, 0.11, H, 0.11);
      leg.position.set(dx, H / 2, s * SPAN / 2);
      g.add(leg);
    }
    for (let yy = 0.7; yy < H; yy += 1.1) {
      const rung = box(steel, 0.52, 0.07, 0.07);
      rung.position.set(0, yy, s * SPAN / 2);
      g.add(rung);
    }
    const foot = box(M('#5c6167', { rough: 0.8 }), 0.8, 0.22, 0.8);
    foot.position.set(0, 0.11, s * SPAN / 2);
    g.add(foot);
    shapes.push(boxSh(0.32, H / 2, 0.32, 0, H / 2, s * SPAN / 2));
  }
  for (const yy of [H - 0.65, H]) { // truss chords
    for (const dx of [-0.26, 0.26]) {
      const chord = box(steel, 0.09, 0.09, SPAN + 0.4);
      chord.position.set(dx, yy, 0);
      g.add(chord);
    }
  }
  const nDiag = 10;
  for (let i = 0; i < nDiag; i++) { // truss diagonals
    const diag = box(steel, 0.06, 0.75, 0.06);
    diag.position.set(0.26, H - 0.32, -SPAN / 2 + 0.6 + i * (SPAN - 1.2) / (nDiag - 1));
    diag.rotation.x = (i % 2 ? 1 : -1) * 0.72;
    g.add(diag);
    const diag2 = diag.clone();
    diag2.position.x = -0.26;
    g.add(diag2);
  }
  shapes.push(boxSh(0.4, 0.5, SPAN / 2, 0, H - 0.32, 0)); // beam — cars pass under
  const texts = r.pick([
    [['NORTH', '↑'], ['EXIT 12', '→']],
    [['CITY CENTER', '↑'], ['AIRPORT', '→']],
    [['CRASHVILLE', '↑'], ['SANDBOX RD', '→']],
  ]);
  [-1.9, 1.9].forEach((z, i) => {
    const face = canvasMat(384, 224, (x, w, h) => {
      x.fillStyle = '#2e7a45';
      x.fillRect(0, 0, w, h);
      x.strokeStyle = '#f2f3f5';
      x.lineWidth = 7;
      x.strokeRect(7, 7, w - 14, h - 14);
      x.fillStyle = '#f2f3f5';
      x.textAlign = 'center';
      x.font = 'bold 46px Arial, sans-serif';
      x.fillText(texts[i][0], w / 2, 96);
      x.font = 'bold 62px Arial, sans-serif';
      x.fillText(texts[i][1], w / 2, 180);
    }, { fallback: '#2e7a45' });
    const holder = new THREE.Group();
    plate(holder, new THREE.PlaneGeometry(1.95, 1.15), face, GRAY_BACK(M), 0);
    holder.position.set(0.34, H - 0.95, z);
    g.add(holder);
  });
  return { g, bodies: fixedBody(g, shapes, 0.5, 0.15) };
}
function tollGate(r, M) {
  const g = new THREE.Group();
  const cab = box(M('#8d939a', { rough: 0.55, metal: 0.2 }), 0.5, 1.05, 0.42);
  cab.position.set(0, 0.6, 0.65);
  g.add(cab);
  const cabTop = box(M('#5c6167', { rough: 0.6 }), 0.56, 0.07, 0.48);
  cabTop.position.set(0, 1.16, 0.65);
  g.add(cabTop);
  const pivot = box(M('#33373d', { rough: 0.6 }), 0.22, 0.9, 0.22);
  pivot.position.set(0, 0.45, 0.2);
  g.add(pivot);
  const armLen = 2.5;
  for (let i = 0; i < 5; i++) { // striped boom across the road
    const seg = box(M(i % 2 ? '#f2f3f5' : '#c9302c', { rough: 0.5 }), 0.075, 0.075, armLen / 5);
    seg.position.set(0, 0.88, 0.06 - (i + 0.5) * (armLen / 5));
    g.add(seg);
  }
  const weight = box(M('#33373d', { rough: 0.6 }), 0.12, 0.18, 0.3);
  weight.position.set(0, 0.88, 0.38);
  g.add(weight);
  return { g, bodies: dynGround(g, 1.25, 65, [
    boxSh(0.26, 0.53, 0.22, 0, 0.6, 0.65),
    boxSh(0.05, 0.05, armLen / 2, 0, 0.88, 0.06 - armLen / 2),
  ], { fr: 0.5, rest: 0.15 }) };
}
function trafficLightPed(r, M) {
  const g = new THREE.Group();
  const steel = M('#33373d', { rough: 0.55, metal: 0.3 });
  const pole = cyl(steel, { r: 0.045, len: 2.7, seg: 8 });
  pole.position.y = 1.35;
  g.add(pole);
  const head = box(M('#22252a', { rough: 0.7 }), 0.16, 0.44, 0.3);
  head.position.y = 2.5;
  g.add(head);
  const walk = r.chance(0.5);
  const hand = box(M('#e0662e', { rough: 0.3, emissive: '#ff7a3d', emInt: walk ? 0.12 : 1.6 }), 0.02, 0.13, 0.13);
  hand.position.set(0.085, 2.61, 0);
  g.add(hand);
  const man = box(M('#dfe8f0', { rough: 0.3, emissive: '#eef6ff', emInt: walk ? 1.5 : 0.1 }), 0.02, 0.13, 0.13);
  man.position.set(0.085, 2.4, 0);
  g.add(man);
  const btn = box(M('#e3c53a', { rough: 0.5 }), 0.09, 0.16, 0.09);
  btn.position.set(0.05, 1.1, 0);
  g.add(btn);
  const dot = cyl(M('#c9302c', { rough: 0.4 }), { r: 0.022, len: 0.03, axis: 'x', seg: 6 });
  dot.position.set(0.1, 1.12, 0);
  g.add(dot);
  return { g, bodies: dynGround(g, 2.75, 42, [
    cylSh(1.36, 0.055, 0, 1.36, 0),
    boxSh(0.1, 0.24, 0.17, 0, 2.5, 0),
  ], { fr: 0.5, rest: 0.2 }) };
}
function barrelDrum(r, M) {
  const g = new THREE.Group();
  const drum = cyl(M('#e8641f', { rough: 0.55 }), { r: 0.3, r2: 0.26, len: 0.88, seg: 10 });
  drum.position.y = 0.47;
  g.add(drum);
  for (const y of [0.33, 0.58, 0.83]) {
    const band = cyl(M('#f2f3f5', { rough: 0.4, env: 0.8 }), { r: 0.303 - (y - 0.33) * 0.028, len: 0.1, seg: 10 });
    band.position.y = y;
    g.add(band);
  }
  const lid = cyl(M('#26292e', { rough: 0.7 }), { r: 0.2, len: 0.05, seg: 10 });
  lid.position.y = 0.93;
  g.add(lid);
  const base = cyl(M('#26292e', { rough: 0.85 }), { r: 0.33, len: 0.06, seg: 10 });
  base.position.y = 0.03;
  g.add(base);
  return { g, bodies: dynGround(g, 0.96, 13, [cylSh(0.48, 0.3, 0, 0.48, 0)], { fr: 0.6, rest: 0.3 }) };
}
function chevronBoard(r, M) {
  const g = new THREE.Group();
  for (const z of [-0.3, 0.3]) {
    const post = box(M('#8d939a', { rough: 0.5, metal: 0.4 }), 0.05, 0.95, 0.05);
    post.position.set(0, 0.475, z);
    g.add(post);
  }
  const dir = r.sign();
  const face = canvasMat(300, 200, (x, w, h) => {
    x.fillStyle = '#26292e';
    x.fillRect(0, 0, w, h);
    x.fillStyle = '#e8b12e';
    for (let i = 0; i < 3; i++) {
      const cx = 50 + i * 90;
      x.beginPath();
      if (dir > 0) {
        x.moveTo(cx, 30); x.lineTo(cx + 45, 100); x.lineTo(cx, 170);
        x.lineTo(cx - 22, 170); x.lineTo(cx + 23, 100); x.lineTo(cx - 22, 30);
      } else {
        x.moveTo(cx + 22, 30); x.lineTo(cx - 23, 100); x.lineTo(cx + 22, 170);
        x.lineTo(cx, 170); x.lineTo(cx - 45, 100); x.lineTo(cx, 30);
      }
      x.closePath();
      x.fill();
    }
  }, { fallback: '#e8b12e' });
  plate(g, new THREE.PlaneGeometry(0.95, 0.62), face, GRAY_BACK(M), 1.22);
  return { g, bodies: dynGround(g, 1.55, 24, [boxSh(0.04, 0.32, 0.48, 0, 1.22, 0), boxSh(0.04, 0.48, 0.35, 0, 0.48, 0)], { fr: 0.5, rest: 0.2 }) };
}
function barricadeEnd(r, M) {
  const g = new THREE.Group();
  const frameM = M('#f2f3f5', { rough: 0.6 });
  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) {
      const leg = box(frameM, 0.05, 0.6, 0.05);
      leg.position.set(sx * 0.02, 0.29, sz * 0.32);
      leg.rotation.x = sx * 0.35;
      g.add(leg);
    }
  }
  const stripes = canvasMat(240, 90, (x, w, h) => {
    x.fillStyle = '#26292e';
    x.fillRect(0, 0, w, h);
    x.fillStyle = '#e8b12e';
    for (let sx = -h; sx < w + h; sx += 60) {
      x.beginPath();
      x.moveTo(sx, h); x.lineTo(sx + 30, h); x.lineTo(sx + 30 + h, 0); x.lineTo(sx + h, 0);
      x.closePath();
      x.fill();
    }
  }, { fallback: '#e8b12e' });
  const board = box(frameM, 0.05, 0.32, 0.92);
  board.position.set(0, 0.62, 0);
  g.add(board);
  const facePl = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.3), stripes);
  facePl.rotation.y = Math.PI / 2;
  facePl.position.set(0.028, 0.62, 0);
  facePl.castShadow = true;
  g.add(facePl);
  if (r.chance(0.5)) {
    const lamp = box(M('#e8a02e', { rough: 0.35, emissive: '#ffb03a', emInt: 1.4 }), 0.06, 0.08, 0.06);
    lamp.position.set(0, 0.82, 0);
    g.add(lamp);
  }
  return { g, bodies: dynGround(g, 0.85, 12, [boxSh(0.05, 0.2, 0.46, 0, 0.62, 0), boxSh(0.2, 0.3, 0.35, 0, 0.3, 0)], { fr: 0.55, rest: 0.25 }) };
}
function crashAttenuator(r, M) {
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const seg = box(M(i % 2 ? '#d9a326' : '#e8b12e', { rough: 0.6 }), 0.34, 0.82, 0.88);
    seg.position.set(-0.42 + i * 0.42, 0.45, 0);
    g.add(seg);
    if (i < 2) { // dark accordion gaps so the segments read
      const gap = box(M('#33373d', { rough: 0.7 }), 0.09, 0.72, 0.8);
      gap.position.set(-0.21 + i * 0.42, 0.45, 0);
      g.add(gap);
    }
  }
  const rearTex = canvasMat(220, 200, (x, w, h) => {
    x.fillStyle = '#e8b12e';
    x.fillRect(0, 0, w, h);
    x.strokeStyle = '#26292e';
    x.lineWidth = 26;
    for (const s of [-1, 1]) {
      x.beginPath();
      x.moveTo(w / 2 + s * 14, 24);
      x.lineTo(w / 2 + s * (w / 2 - 6), h - 30);
      x.stroke();
    }
  }, { fallback: '#e8b12e' });
  const rear = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 0.78), rearTex);
  rear.rotation.y = -Math.PI / 2;
  rear.position.set(-0.64, 0.45, 0);
  rear.castShadow = true;
  g.add(rear);
  const nose = cyl(M('#d9a326', { rough: 0.6 }), { r: 0.44, len: 0.8, seg: 10 });
  nose.scale.x = 0.4;
  nose.position.set(0.52, 0.45, 0);
  g.add(nose);
  return { g, bodies: dynGround(g, 0.9, 160, [boxSh(0.62, 0.42, 0.46, 0, 0.45, 0)], { fr: 0.75, rest: 0.02 }) };
}
function signWork(r, M) {
  const g = new THREE.Group();
  for (const sz of [-1, 1]) { // A-frame feet
    const foot = box(M('#8d939a', { rough: 0.5, metal: 0.4 }), 0.6, 0.05, 0.05);
    foot.position.set(0, 0.03, sz * 0.06);
    foot.rotation.y = sz * 0.35;
    g.add(foot);
  }
  const post = box(M('#8d939a', { rough: 0.5, metal: 0.4 }), 0.05, 1.5, 0.05);
  post.position.y = 0.78;
  g.add(post);
  const kind = r.pick(['ROAD WORK', 'DETOUR', 'LANE CLOSED']);
  const face = canvasMat(256, 256, (x, w, h) => {
    x.fillStyle = '#e8641f';
    x.fillRect(0, 0, w, h);
    x.strokeStyle = '#26292e';
    x.lineWidth = 10;
    x.beginPath();
    x.moveTo(128, 12); x.lineTo(244, 128); x.lineTo(128, 244); x.lineTo(12, 128);
    x.closePath();
    x.stroke();
    x.fillStyle = '#26292e';
    x.textAlign = 'center';
    x.font = 'bold 34px Arial, sans-serif';
    const wds = kind.split(' ');
    if (wds.length === 2) { x.fillText(wds[0], 128, 116); x.fillText(wds[1], 128, 158); }
    else x.fillText(kind, 128, 138);
  }, { fallback: '#e8641f' });
  plate(g, new THREE.CircleGeometry(0.44, 4, 0), face, GRAY_BACK(M), 1.32);
  return { g, bodies: dynGround(g, 1.8, 13, [
    boxSh(0.03, 0.32, 0.32, 0, 1.32, 0),
    boxSh(0.04, 0.75, 0.04, 0, 0.75, 0),
  ], { fr: 0.5, rest: 0.25 }) };
}
function lightTrailer(r, M) {
  const g = new THREE.Group();
  trailerBase(g, M);
  const gen = box(M(r.chance(0.6) ? '#e8a02e' : '#8d939a', { rough: 0.55 }), 0.75, 0.6, 0.7);
  gen.position.set(0.25, 0.88, 0);
  g.add(gen);
  const vents = box(M('#33373d', { rough: 0.7 }), 0.02, 0.3, 0.4);
  vents.position.set(0.64, 0.9, 0);
  g.add(vents);
  const mast = cyl(M('#8d939a', { rough: 0.45, metal: 0.4 }), { r: 0.05, r2: 0.035, len: 2.6, seg: 7 });
  mast.position.set(-0.4, 1.18 + 1.3, 0);
  g.add(mast);
  const bar = box(M('#33373d', { rough: 0.6 }), 0.08, 0.12, 0.95);
  bar.position.set(-0.4, 3.82, 0);
  g.add(bar);
  for (let i = 0; i < 4; i++) {
    const lamp = box(M('#fff2cf', { rough: 0.3, emissive: '#ffe9b0', emInt: 2 }), 0.1, 0.16, 0.18);
    lamp.position.set(-0.36, 3.82, -0.36 + i * 0.24);
    lamp.rotation.z = -0.3;
    g.add(lamp);
  }
  return { g, bodies: dynGround(g, 3.95, 360, [
    boxSh(0.75, 0.35, 0.55, 0.1, 0.6, 0),
    cylSh(1.35, 0.06, -0.4, 2.5, 0),
  ], { fr: 0.6, rest: 0.1 }) };
}
function scaffolding(r, M) {
  const g = new THREE.Group();
  const steel = M('#8d939a', { rough: 0.45, metal: 0.45, env: 0.9 });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = cyl(steel, { r: 0.035, len: 3.3, seg: 6 });
      post.position.set(sx * 0.95, 1.65, sz * 0.55);
      g.add(post);
    }
    for (const y of [0.5, 1.55, 2.6]) { // end rungs
      const rung = cyl(steel, { r: 0.028, len: 1.06, axis: 'z', seg: 6 });
      rung.position.set(sx * 0.95, y, 0);
      g.add(rung);
    }
  }
  for (const sz of [-1, 1]) { // X braces on the long faces
    for (const s of [-1, 1]) {
      const brace = cyl(steel, { r: 0.02, len: 2.3, seg: 5 });
      brace.position.set(0, 1.05, sz * 0.57);
      brace.rotation.z = s * 1.05;
      g.add(brace);
    }
  }
  for (let i = 0; i < 3; i++) { // plank deck
    const plank = box(M('#9a7a4f', { rough: 0.9 }), 2.1, 0.045, 0.3);
    plank.position.set(0, 1.62, -0.32 + i * 0.32);
    g.add(plank);
  }
  const toe = box(M('#e8a02e', { rough: 0.6 }), 2.1, 0.14, 0.03);
  toe.position.set(0, 1.74, 0.53);
  g.add(toe);
  return { g, bodies: dynGround(g, 3.35, 240, [
    boxSh(1.0, 1.65, 0.6, 0, 1.65, 0),
  ], { fr: 0.55, rest: 0.1 }) };
}
function pallet(r, M) {
  const g = new THREE.Group();
  const wood = M('#b08a54', { rough: 0.9 });
  for (const z of [-0.5, 0, 0.5]) {
    const stringer = box(wood, 1.1, 0.09, 0.09);
    stringer.position.set(0, 0.045, z);
    g.add(stringer);
  }
  for (let i = 0; i < 5; i++) {
    const slatB = box(wood, 0.16, 0.03, 1.15);
    slatB.position.set(-0.46 + i * 0.23, 0.105, 0);
    g.add(slatB);
  }
  if (r.chance(0.55)) { // cement bags
    const bagM = M('#dfd8c8', { rough: 0.85 });
    for (let i = 0; i < 5; i++) {
      const bag = box(bagM, 0.5, 0.14, 0.32);
      bag.position.set((i % 2) * 0.4 - 0.2, 0.19 + Math.floor(i / 2) * 0.14, (i % 2 ? -0.16 : 0.16) * (Math.floor(i / 2) % 2 ? -1 : 1));
      bag.rotation.y = r.range(-0.08, 0.08);
      g.add(bag);
    }
  } else { // brick stack
    const brickM = M('#a05a48', { rough: 0.85 });
    for (let row = 0; row < 3; row++) {
      for (let i = 0; i < 3; i++) {
        const brick = box(brickM, 0.62, 0.13, 0.28);
        brick.position.set(0, 0.19 + row * 0.135, -0.32 + i * 0.32);
        g.add(brick);
      }
    }
  }
  return { g, bodies: dynGround(g, 0.62, 130, [boxSh(0.56, 0.28, 0.58, 0, 0.28, 0)], { fr: 0.7, rest: 0.05 }) };
}
function cellTower(r, M) {
  const g = new THREE.Group();
  const steel = M('#b3b8be', { rough: 0.45, metal: 0.4, env: 0.9 });
  const H = 7.4;
  for (const [sx, sz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
    const leg = box(steel, 0.08, H, 0.08);
    leg.position.set(sx * 0.42, H / 2, sz * 0.42);
    leg.rotation.z = -sx * 0.045;
    leg.rotation.x = sz * 0.045;
    g.add(leg);
  }
  for (let yy = 0.9; yy < H - 0.4; yy += 1.3) {
    const k = 1 - (yy / H) * 0.55; // lattice narrows with height
    for (const s of [-1, 1]) {
      const bx = box(steel, 0.95 * k, 0.055, 0.06);
      bx.position.set(0, yy, s * 0.45 * k);
      g.add(bx);
      const bz = box(steel, 0.06, 0.055, 0.95 * k);
      bz.position.set(s * 0.45 * k, yy, 0);
      g.add(bz);
    }
  }
  const head = cyl(M('#5c6167', { rough: 0.6 }), { r: 0.14, len: 0.9, seg: 8 });
  head.position.y = H + 0.3;
  g.add(head);
  for (let i = 0; i < 3; i++) { // antenna panels
    const a = (i / 3) * Math.PI * 2;
    const panel = box(M('#eef0f2', { rough: 0.5 }), 0.09, 0.78, 0.22);
    panel.position.set(Math.cos(a) * 0.32, H + 0.25, Math.sin(a) * 0.32);
    panel.rotation.y = -a + Math.PI / 2;
    g.add(panel);
  }
  if (r.chance(0.6)) {
    const dish = cyl(M('#dfe4ea', { rough: 0.4 }), { r: 0.28, r2: 0.05, len: 0.18, axis: 'x', seg: 10 });
    dish.position.set(0.3, H - 1.6, 0.2);
    g.add(dish);
  }
  return { g, bodies: fixedBody(g, [boxSh(0.5, H / 2, 0.5, 0, H / 2, 0)], 0.55, 0.1) };
}

/* ================= registry ================= */
const NAT = 'Nature', SUB = 'Suburbia', CITY = 'Street & City', TRAF = 'Signs & Traffic';
export const SCENERY = [
  { id: 'tree_round', label: 'Tree', icon: '🌳', cat: NAT, build: treeRound },
  { id: 'tree_oak', label: 'Oak Tree', icon: '🌳', cat: NAT, build: treeOak },
  { id: 'tree_pine', label: 'Pine Tree', icon: '🌲', cat: NAT, build: treePine },
  { id: 'tree_cypress', label: 'Cypress', icon: '🌲', cat: NAT, build: treeCypress },
  { id: 'tree_palm', label: 'Palm Tree', icon: '🌴', cat: NAT, build: treePalm },
  { id: 'tree_blossom', label: 'Blossom Tree', icon: '🌸', cat: NAT, build: treeBlossom },
  { id: 'bush', label: 'Bush', icon: '🌿', cat: NAT, build: bush },
  { id: 'hedge', label: 'Hedge', icon: '🟩', cat: NAT, build: hedge },
  { id: 'flowerbed', label: 'Flower Planter', icon: '🌷', cat: NAT, build: flowerbed },
  { id: 'flowerpot', label: 'Flower Pot', icon: '🪴', cat: NAT, build: flowerpot },
  { id: 'reeds', label: 'Reeds & Grass', icon: '🌾', cat: NAT, build: reeds },
  { id: 'rock', label: 'Rock', icon: '🪨', cat: NAT, build: rock },
  { id: 'pond', label: 'Pond', icon: '💧', cat: NAT, build: pond },

  { id: 'house', label: 'House', icon: '🏠', cat: SUB, build: house },
  { id: 'shop', label: 'Shop', icon: '🏪', cat: SUB, build: shop },
  { id: 'gazebo', label: 'Gazebo', icon: '🎪', cat: SUB, build: gazebo },
  { id: 'fountain', label: 'Fountain', icon: '⛲', cat: SUB, build: fountain },
  { id: 'picnic_table', label: 'Picnic Table', icon: '🧺', cat: SUB, build: picnicTable },
  { id: 'bench', label: 'Park Bench', icon: '🪑', cat: SUB, build: bench },
  { id: 'playground', label: 'Playground', icon: '🛝', cat: SUB, build: playground },
  { id: 'sandbox', label: 'Sandbox', icon: '🏖️', cat: SUB, build: sandbox },
  { id: 'fence_picket', label: 'Picket Fence', icon: '🪵', cat: SUB, build: fencePicket },
  { id: 'mailbox', label: 'Mailbox', icon: '📬', cat: SUB, build: mailbox },

  { id: 'lamp_classic', label: 'Street Lamp', icon: '🏮', cat: CITY, build: lampClassic },
  { id: 'traffic_light', label: 'Traffic Light', icon: '🚦', cat: CITY, build: trafficLight },
  { id: 'hydrant', label: 'Fire Hydrant', icon: '🧯', cat: CITY, build: hydrant },
  { id: 'trash_can', label: 'Trash Can', icon: '🗑️', cat: CITY, build: trashCan },
  { id: 'bin_wheelie', label: 'Wheelie Bin', icon: '♻️', cat: CITY, build: binWheelie },
  { id: 'dumpster', label: 'Dumpster', icon: '🛢️', cat: CITY, build: dumpster },
  { id: 'mailbox_drop', label: 'Mail Drop Box', icon: '📮', cat: CITY, build: mailboxDrop },
  { id: 'bus_stop', label: 'Bus Stop', icon: '🚏', cat: CITY, build: busStop },
  { id: 'billboard', label: 'Billboard', icon: '🪧', cat: CITY, build: billboard },
  { id: 'utility_box', label: 'Utility Box', icon: '🔌', cat: CITY, build: utilityBox },
  { id: 'bike_rack', label: 'Bike Rack', icon: '🚲', cat: CITY, build: bikeRack },
  { id: 'food_cart', label: 'Food Cart', icon: '🛒', cat: CITY, build: foodCart },
  { id: 'table_umbrella', label: 'Cafe Umbrella', icon: '⛱️', cat: CITY, build: tableUmbrella },

  { id: 'sign_stop', label: 'Stop Sign', icon: '🛑', cat: TRAF, build: signStop },
  { id: 'sign_yield', label: 'Yield Sign', icon: '🔻', cat: TRAF, build: signYield },
  { id: 'sign_speed', label: 'Speed Limit', icon: '💠', cat: TRAF, build: signSpeed },
  { id: 'sign_warn', label: 'Warning Sign', icon: '⚠️', cat: TRAF, build: signWarn },
  { id: 'sign_reg', label: 'Regulatory Sign', icon: '🚫', cat: TRAF, build: signReg },
  { id: 'sign_street', label: 'Street Name', icon: '🏷️', cat: TRAF, build: signStreet },
  { id: 'sign_highway', label: 'Highway Sign', icon: '🛣️', cat: TRAF, build: signHighway },
  { id: 'cone', label: 'Traffic Cone', icon: '🔺', cat: TRAF, build: cone },
  { id: 'delineator', label: 'Delineator Post', icon: '📍', cat: TRAF, build: delineator },
  { id: 'barricade', label: 'Barricade', icon: '🚧', cat: TRAF, build: barricade },
  { id: 'barrier_water', label: 'Water Barrier', icon: '🟧', cat: TRAF, build: barrierWater },
  { id: 'guardrail', label: 'Guardrail', icon: '➖', cat: TRAF, build: guardrail },
  { id: 'speed_bump', label: 'Speed Bump', icon: '〰️', cat: TRAF, build: speedBump },
  { id: 'arrow_board', label: 'Arrow Board', icon: '➡️', cat: TRAF, build: arrowBoard },
  { id: 'vms_board', label: 'Message Board', icon: '💬', cat: TRAF, build: vmsBoard },

  // batch 2 — reference-image sweep
  { id: 'tree_dead', label: 'Dead Tree', icon: '🪾', cat: NAT, build: treeDead },
  { id: 'tree_stump', label: 'Tree Stump', icon: '🪵', cat: NAT, build: treeStump },
  { id: 'cactus', label: 'Cactus', icon: '🌵', cat: NAT, build: cactus },
  { id: 'tumbleweed', label: 'Tumbleweed', icon: '🌀', cat: NAT, build: tumbleweed },
  { id: 'flowers_wild', label: 'Wildflowers', icon: '🌼', cat: NAT, build: flowersWild },
  { id: 'log_pile', label: 'Log Pile', icon: '🪵', cat: NAT, build: logPile },
  { id: 'hay_bale', label: 'Hay Bale', icon: '🌾', cat: NAT, build: hayBale },
  { id: 'stone_wall', label: 'Stone Wall', icon: '🧱', cat: NAT, build: stoneWall },

  { id: 'fence_gate', label: 'Garden Gate', icon: '🚪', cat: SUB, build: fenceGate },
  { id: 'fence_metal', label: 'Metal Fence', icon: '🛡️', cat: SUB, build: fenceMetal },
  { id: 'doghouse', label: 'Doghouse', icon: '🐶', cat: SUB, build: doghouse },
  { id: 'bbq_grill', label: 'BBQ Grill', icon: '🍖', cat: SUB, build: bbqGrill },
  { id: 'birdbath', label: 'Birdbath', icon: '🐦', cat: SUB, build: birdbath },
  { id: 'wheelbarrow', label: 'Wheelbarrow', icon: '🛞', cat: SUB, build: wheelbarrow },
  { id: 'well', label: 'Wishing Well', icon: '🪣', cat: SUB, build: well },
  { id: 'trampoline', label: 'Trampoline', icon: '🤸', cat: SUB, build: trampoline },
  { id: 'basketball_hoop', label: 'Basketball Hoop', icon: '🏀', cat: SUB, build: basketballHoop },
  { id: 'soccer_goal', label: 'Soccer Goal', icon: '⚽', cat: SUB, build: soccerGoal },
  { id: 'kiddie_pool', label: 'Kiddie Pool', icon: '🦆', cat: SUB, build: kiddiePool },
  { id: 'garden_gnome', label: 'Garden Gnome', icon: '🧙', cat: SUB, build: gardenGnome },
  { id: 'seesaw', label: 'Seesaw', icon: '⚖️', cat: SUB, build: seesaw },
  { id: 'statue', label: 'Park Statue', icon: '🗽', cat: SUB, build: statue },
  { id: 'water_tower', label: 'Water Tower', icon: '🗼', cat: SUB, build: waterTower },
  { id: 'flagpole', label: 'Flagpole', icon: '🚩', cat: SUB, build: flagpole },

  { id: 'building_city', label: 'City Building', icon: '🏢', cat: CITY, build: buildingCity },
  { id: 'market_stall', label: 'Market Stall', icon: '🍎', cat: CITY, build: marketStall },
  { id: 'planter_stone', label: 'Stone Planter', icon: '🪻', cat: CITY, build: planterStone },
  { id: 'bollard', label: 'Bollard', icon: '⚫', cat: CITY, build: bollard },
  { id: 'retaining_wall', label: 'Retaining Wall', icon: '🧱', cat: CITY, build: retainingWall },
  { id: 'utility_pole', label: 'Utility Pole', icon: '🗼', cat: CITY, build: utilityPole },
  { id: 'lamp_cobra', label: 'Cobra Light', icon: '💡', cat: CITY, build: lampCobra },
  { id: 'street_clock', label: 'Street Clock', icon: '🕰️', cat: CITY, build: streetClock },
  { id: 'parking_meter', label: 'Parking Meter', icon: '🪙', cat: CITY, build: parkingMeter },
  { id: 'manhole', label: 'Manhole Cover', icon: '⭕', cat: CITY, build: manhole },
  { id: 'drain_grate', label: 'Drain Grate', icon: '🕳️', cat: CITY, build: drainGrate },
  { id: 'sidewalk_slab', label: 'Sidewalk Slab', icon: '⬜', cat: CITY, build: sidewalkSlab },
  { id: 'porta_potty', label: 'Porta-Potty', icon: '🚽', cat: CITY, build: portaPotty },
  { id: 'tire_stack', label: 'Tire Stack', icon: '🛞', cat: CITY, build: tireStack },

  { id: 'gantry', label: 'Sign Gantry', icon: '🌉', cat: TRAF, build: gantry },
  { id: 'toll_gate', label: 'Toll Gate', icon: '🚧', cat: TRAF, build: tollGate },
  { id: 'traffic_light_ped', label: 'Ped Signal', icon: '🚶', cat: TRAF, build: trafficLightPed },
  { id: 'barrel_drum', label: 'Traffic Drum', icon: '🛢️', cat: TRAF, build: barrelDrum },
  { id: 'chevron_board', label: 'Chevron Board', icon: '⏩', cat: TRAF, build: chevronBoard },
  { id: 'barricade_end', label: 'End Barricade', icon: '⛔', cat: TRAF, build: barricadeEnd },
  { id: 'crash_attenuator', label: 'Crash Cushion', icon: '🧽', cat: TRAF, build: crashAttenuator },
  { id: 'sign_work', label: 'Road Work Sign', icon: '👷', cat: TRAF, build: signWork },
  { id: 'light_trailer', label: 'Light Trailer', icon: '🔦', cat: TRAF, build: lightTrailer },
  { id: 'scaffolding', label: 'Scaffolding', icon: '🏗️', cat: TRAF, build: scaffolding },
  { id: 'pallet', label: 'Loaded Pallet', icon: '📦', cat: TRAF, build: pallet },
  { id: 'cell_tower', label: 'Cell Tower', icon: '📡', cat: TRAF, build: cellTower },
];

export const isScenery = (kind) => SCENERY.some((s) => s.id === kind);

// Deterministic: same kind+seed ⇒ identical model + identical collider recipe.
export function buildScenery(kind, seed = '1') {
  const e = SCENERY.find((s) => s.id === kind);
  if (!e) return null;
  const r = makeRng('sc:' + kind + ':' + seed);
  const M = matFactory();
  const { g, bodies } = e.build(r, M);
  return { group: g, bodies };
}
