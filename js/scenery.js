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
  const tH = r.range(0.8, 1.3), tR = r.range(0.1, 0.15);
  trunk(g, M, r, tH, tR);
  const hex = jitterColor(r, r.pick(GREENS));
  const R1 = r.range(0.95, 1.35);
  const c1 = canopy(M, r, hex, R1);
  c1.position.y = tH + R1 * 0.72;
  g.add(c1);
  if (r.chance(0.5)) {
    const R2 = R1 * r.range(0.5, 0.68);
    const c2 = canopy(M, r, shade(hex, 0.05), R2);
    c2.position.set(r.range(-0.35, 0.35), tH + R1 * 1.28, r.range(-0.35, 0.35));
    g.add(c2);
  }
  const H = tH + R1 * 1.7;
  return { g, bodies: dynGround(g, H, 380 + R1 * 260, [
    cylSh(H / 2, tR * 2.1, 0, H / 2, 0),
    boxSh(R1 * 0.6, R1 * 0.58, R1 * 0.6, 0, tH + R1 * 0.75, 0),
  ], { fr: 0.7, rest: 0.08 }) };
}
function treeOak(r, M) {
  const g = new THREE.Group();
  const tH = r.range(1.1, 1.6), tR = r.range(0.16, 0.22);
  trunk(g, M, r, tH, tR);
  const hex = jitterColor(r, r.pick(GREENS));
  const R = r.range(1.15, 1.5);
  const main = canopy(M, r, hex, R, { squash: 0.82 });
  main.position.y = tH + R * 0.62;
  g.add(main);
  const n = r.int(2, 3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + r.range(0, 1);
    const R2 = R * r.range(0.5, 0.68);
    const c = canopy(M, r, shade(hex, r.range(-0.04, 0.06)), R2);
    c.position.set(Math.cos(a) * R * 0.72, tH + R * r.range(0.45, 0.95), Math.sin(a) * R * 0.72);
    g.add(c);
    if (i < 2) { // visible branch feeding the side blob
      const br = cyl(M(r.pick(BARK), { rough: 0.9 }), { r: 0.05, len: R * 0.9, seg: 6 });
      br.position.set(Math.cos(a) * R * 0.36, tH + R * 0.3, Math.sin(a) * R * 0.36);
      br.rotation.z = Math.cos(a) * 0.7;
      br.rotation.x = -Math.sin(a) * 0.7;
      g.add(br);
    }
  }
  const H = tH + R * 1.7;
  return { g, bodies: dynGround(g, H, 700 + R * 300, [
    cylSh(H / 2, tR * 1.9, 0, H / 2, 0),
    boxSh(R * 0.85, R * 0.6, R * 0.85, 0, tH + R * 0.66, 0),
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
    y += tierH * 0.62;
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
  const tH = r.range(0.9, 1.3);
  trunk(g, M, r, tH, r.range(0.11, 0.16));
  const hex = jitterColor(r, r.pick(BLOSSOM));
  const R = r.range(1.0, 1.3);
  const c1 = canopy(M, r, hex, R, { squash: 0.85 });
  c1.position.y = tH + R * 0.66;
  g.add(c1);
  const c2 = canopy(M, r, shade(hex, 0.07), R * 0.55);
  c2.position.set(r.range(-0.4, 0.4), tH + R * 1.15, r.range(-0.4, 0.4));
  g.add(c2);
  const H = tH + R * 1.6;
  return { g, bodies: dynGround(g, H, 360 + R * 200, [
    cylSh(H / 2, 0.24, 0, H / 2, 0),
    boxSh(R * 0.62, R * 0.5, R * 0.62, 0, tH + R * 0.7, 0),
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
  const stone = M(r.pick(['#b3b8be', '#c9ccd2', '#a8a094']), { rough: 0.85 });
  const water = M('#5fa8d8', { rough: 0.1, env: 1.7 });
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
  const g = new THREE.Group();
  const slat = M(r.chance(0.5) ? '#2e6339' : jitterColor(r, '#8a6a3f'), { rough: 0.85 });
  const iron = M('#33373d', { rough: 0.6, metal: 0.3 });
  for (let i = 0; i < 3; i++) {
    const s = box(slat, 1.5, 0.045, 0.11);
    s.position.set(0.06 - i * 0.13, 0.5, 0);
    g.add(s);
  }
  for (let i = 0; i < 2; i++) {
    const s = box(slat, 1.5, 0.045, 0.11);
    s.position.set(-0.28, 0.68 + i * 0.16, 0);
    s.rotation.z = Math.PI / 2 - 0.25;
    g.add(s);
  }
  for (const sz of [-1, 1]) {
    const leg = box(iron, 0.4, 0.5, 0.05);
    leg.position.set(-0.06, 0.26, sz * 0.66);
    g.add(leg);
    const back = box(iron, 0.05, 0.5, 0.05);
    back.position.set(-0.28, 0.72, sz * 0.66);
    back.rotation.z = -0.22;
    g.add(back);
  }
  return { g, bodies: dynGround(g, 0.98, 55, [
    boxSh(0.28, 0.26, 0.75, 0, 0.26, 0),
    boxSh(0.06, 0.26, 0.75, -0.28, 0.72, 0),
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
    const post = box(A, 0.08, 1.75, 0.08);
    post.position.set(tx + sx * 0.5, 0.875, sz * 0.5);
    g.add(post);
  }
  const platform = box(C, 1.2, 0.07, 1.2);
  platform.position.set(tx, 1.3, 0);
  g.add(platform);
  for (const s of [-1, 1]) { // mini gable roof
    const panel = box(A, 1.25, 0.05, 0.72);
    panel.position.set(tx, 2.18, s * 0.3);
    panel.rotation.x = -s * 0.62;
    g.add(panel);
  }
  // slide down +x
  const slide = box(B, 1.9, 0.05, 0.55);
  slide.position.set(tx + 1.28, 0.68, 0);
  slide.rotation.z = 0.6;
  g.add(slide);
  for (const s of [-1, 1]) {
    const rail = box(B, 1.9, 0.14, 0.04);
    rail.position.set(tx + 1.28, 0.75, s * 0.28);
    rail.rotation.z = 0.6;
    g.add(rail);
  }
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
    { kind: 'box', he: [0.98, 0.04, 0.29], pos: [tx + 1.28, 0.68, 0], rot: quatArr(0, 0, 0.6) },
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
    const z = (i - 1) * 0.55;
    const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.032, 6, 10, Math.PI), steel);
    hoop.position.set(0, 0.38, z);
    hoop.castShadow = true;
    g.add(hoop);
    for (const s of [-1, 1]) {
      const leg = cyl(steel, { r: 0.032, len: 0.4, seg: 6 });
      leg.position.set(s * 0.33, 0.2, z);
      g.add(leg);
    }
  }
  return { g, bodies: fixedBody(g, [boxSh(0.38, 0.36, 0.75, 0, 0.36, 0)], 0.6, 0.2) };
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
