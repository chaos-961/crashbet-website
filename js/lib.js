// lib.js — seeded RNG, materials, and the core low-poly geometry kit
import * as THREE from 'three';

/* ---------------- seeded RNG ---------------- */
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}
function mulberry32(a) {
  return function () {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function makeRng(seed) {
  const f = mulberry32(xmur3(String(seed))());
  const r = () => f();
  r.range = (a, b) => a + (b - a) * f();
  r.int = (a, b) => Math.floor(a + (b - a + 1) * f());
  r.pick = (arr) => arr[Math.floor(f() * arr.length)];
  r.chance = (p) => f() < p;
  r.jitter = (v, fr) => v * (1 + (f() * 2 - 1) * fr);
  r.sign = () => (f() < 0.5 ? -1 : 1);
  r.weighted = (pairs) => {
    let tot = 0;
    for (const p of pairs) tot += p[1];
    let x = f() * tot;
    for (const p of pairs) { x -= p[1]; if (x <= 0) return p[0]; }
    return pairs[pairs.length - 1][0];
  };
  return r;
}

/* ---------------- paint palettes ---------------- */
export const PAINT = [
  ['#c92f2f', 3], ['#a5262e', 2], ['#d94e33', 1.4], ['#e06d21', 1.4],
  ['#e39a26', 1], ['#dfbd25', 1], ['#84a52e', 0.7], ['#2e8442', 1.5],
  ['#226332', 1], ['#238783', 1], ['#2668bd', 1.6], ['#20518f', 1.6],
  ['#233252', 1], ['#5f3f96', 0.5], ['#e6e7e9', 1.6], ['#eddfc0', 0.8],
  ['#b3b8be', 1], ['#767c84', 1], ['#383c43', 1], ['#22252a', 1.1],
  ['#74471f', 0.6], ['#bf8f57', 0.6], ['#d97fa8', 0.4], ['#5f9ecc', 0.7],
];
export function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
// NOTE: HSL math must run in sRGB space — linear-space HSL distorts saturated colors
export function shade(hex, dl, ds = 0) {
  const c = new THREE.Color(hex); const hsl = {};
  c.getHSL(hsl, THREE.SRGBColorSpace);
  c.setHSL(hsl.h, clamp(hsl.s + ds, 0, 1), clamp(hsl.l + dl, 0, 1), THREE.SRGBColorSpace);
  return '#' + c.getHexString();
}
export function jitterColor(r, hex, h = 0.008, s = 0.06, l = 0.04) {
  const c = new THREE.Color(hex); const hsl = {};
  c.getHSL(hsl, THREE.SRGBColorSpace);
  c.setHSL(
    (hsl.h + r.range(-h, h) + 1) % 1,
    clamp(hsl.s * (1 + r.range(-s, s)), 0, 1),
    clamp(hsl.l * (1 + r.range(-l, l)), 0, 1),
    THREE.SRGBColorSpace,
  );
  return '#' + c.getHexString();
}

/* ---------------- materials ---------------- */
export function matFactory() {
  const cache = new Map();
  const M = (color, opt = {}) => {
    const { rough = 0.58, metal = 0, env = 0.5, emissive = null, emInt = 0.55, flat = true, glass = false } = opt;
    const hex = color instanceof THREE.Color ? '#' + color.getHexString() : color;
    const key = [hex, rough, metal, env, emissive, emInt, flat, glass].join('|');
    if (!cache.has(key)) {
      const m = new THREE.MeshStandardMaterial({
        color: hex, roughness: rough, metalness: metal, flatShading: flat,
        envMapIntensity: env,
      });
      if (emissive) { m.emissive = new THREE.Color(emissive); m.emissiveIntensity = emInt; }
      if (glass) m.userData.glass = true; // deform.js: this pane can crack & shatter
      cache.set(key, m);
    }
    return cache.get(key);
  };
  M.list = () => [...cache.values()];
  return M;
}

/* ---------------- geometry kit ---------------- */
// hexa: solid from two quads (bottom b[4], top t[4]); both ordered so that
// looking from "top" side down, b_i sits under t_i. Flat-shaded.
export function hexa(b, t, mat) {
  const quads = [
    [t[3], t[2], t[1], t[0]], // top
    [b[0], b[1], b[2], b[3]], // bottom
    [b[2], b[1], t[1], t[2]], // +X
    [b[0], b[3], t[3], t[0]], // -X
    [b[3], b[2], t[2], t[3]], // +Z
    [b[1], b[0], t[0], t[1]], // -Z
  ];
  const pos = [];
  for (const [a, b2, c, d] of quads) pos.push(...a, ...b2, ...c, ...a, ...c, ...d);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat);
  m.castShadow = m.receiveShadow = true;
  return m;
}

// slab: chamfered box. Bottom rect [x0..x1] × width w at y0; top rect shrunk by
// nose (front top cut), tail (rear top cut), narrowed to wT, shifted by shiftT.
// noseB/tailB cut the bottom rect (raked underside). Forward = +X.
export function slab(mat, p) {
  const wT = p.wT !== undefined ? p.wT : p.w;
  const pt = {
    x0b: p.x0 + (p.tailB || 0), x1b: p.x1 - (p.noseB || 0),
    x0t: p.x0 + (p.tail || 0) + (p.shiftT || 0), x1t: p.x1 - (p.nose || 0) + (p.shiftT || 0),
    zb: p.w, zt: wT, y0: p.y0, y1: p.y1,
  };
  const zb2 = pt.zb / 2, zt2 = pt.zt / 2;
  const b = [[pt.x0b, pt.y0, -zb2], [pt.x1b, pt.y0, -zb2], [pt.x1b, pt.y0, zb2], [pt.x0b, pt.y0, zb2]];
  const t = [[pt.x0t, pt.y1, -zt2], [pt.x1t, pt.y1, -zt2], [pt.x1t, pt.y1, zt2], [pt.x0t, pt.y1, zt2]];
  const m = hexa(b, t, mat);
  m.userData.pt = pt;
  return m;
}

// wedge: plan-tapered slab (width varies along length). w0 at x0, w1 at x1.
export function wedge(mat, p) {
  const { x0, x1, y0, y1, w0, w1 } = p;
  const w0T = p.w0T !== undefined ? p.w0T : w0, w1T = p.w1T !== undefined ? p.w1T : w1;
  const nose = p.nose || 0, tail = p.tail || 0;
  const b = [[x0, y0, -w0 / 2], [x1, y0, -w1 / 2], [x1, y0, w1 / 2], [x0, y0, w0 / 2]];
  const t = [[x0 + tail, y1, -w0T / 2], [x1 - nose, y1, -w1T / 2], [x1 - nose, y1, w1T / 2], [x0 + tail, y1, w0T / 2]];
  return hexa(b, t, mat);
}

// Face quads of a slab (ordered CCW seen from outside; A→B bottom edge, D→C top edge)
export function faceQuad(pt, side) {
  const zb2 = pt.zb / 2, zt2 = pt.zt / 2;
  switch (side) {
    case 'front': return [[pt.x1b, pt.y0, zb2], [pt.x1b, pt.y0, -zb2], [pt.x1t, pt.y1, -zt2], [pt.x1t, pt.y1, zt2]];
    case 'rear': return [[pt.x0b, pt.y0, -zb2], [pt.x0b, pt.y0, zb2], [pt.x0t, pt.y1, zt2], [pt.x0t, pt.y1, -zt2]];
    case 'right': return [[pt.x0b, pt.y0, zb2], [pt.x1b, pt.y0, zb2], [pt.x1t, pt.y1, zt2], [pt.x0t, pt.y1, zt2]];
    case 'left': return [[pt.x1b, pt.y0, -zb2], [pt.x0b, pt.y0, -zb2], [pt.x0t, pt.y1, -zt2], [pt.x1t, pt.y1, -zt2]];
  }
}

// Interpolate a sub-rectangle of a quad. f: 0..1 along bottom/top edges, v: 0..1 up.
export function subQuad(q, f0, f1, v0, v1) {
  const L = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const P = (f, v) => L(L(q[0], q[1], f), L(q[3], q[2], f), v);
  return [P(f0, v0), P(f1, v0), P(f1, v1), P(f0, v1)];
}

// Thin plate sitting flush on (slightly proud of) a quad face.
export function quadPrism(q, thickness, mat, offset = 0.012) {
  const V = (v) => new THREE.Vector3(v[0], v[1], v[2]);
  const A = V(q[0]), B = V(q[1]), C = V(q[2]), D = V(q[3]);
  const n = new THREE.Vector3().subVectors(B, A).cross(new THREE.Vector3().subVectors(D, A)).normalize();
  const inner = [A, B, C, D].map((p) => p.clone().addScaledVector(n, offset));
  const outer = [A, B, C, D].map((p) => p.clone().addScaledVector(n, offset + thickness));
  const rev = (arr) => [arr[0], arr[3], arr[2], arr[1]];
  const toA = (arr) => arr.map((v) => [v.x, v.y, v.z]);
  return hexa(toA(rev(inner)), toA(rev(outer)), mat);
}

// Row of window panes across a face quad.
export function panesOnQuad(q, mat, o = {}) {
  const { cols = 1, gap = 0.045, f0 = 0.05, f1 = 0.95, v0 = 0.16, v1 = 0.88, t = 0.026, off = 0.012 } = o;
  const g = new THREE.Group();
  const span = f1 - f0, each = (span - gap * (cols - 1)) / cols;
  for (let i = 0; i < cols; i++) {
    const a = f0 + i * (each + gap);
    g.add(quadPrism(subQuad(q, a, a + each, v0, v1), t, mat, off));
  }
  return g;
}

export function box(mat, w, h, d) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = m.receiveShadow = true;
  return m;
}

export function cyl(mat, o = {}) {
  const { r = 0.3, r2 = null, len = 1, axis = 'y', seg = 12, open = false } = o;
  const g = new THREE.CylinderGeometry(r2 === null ? r : r2, r, len, seg, 1, open);
  const m = new THREE.Mesh(g, mat);
  m.castShadow = m.receiveShadow = true;
  if (axis === 'x') m.rotation.z = -Math.PI / 2; // top (r2) points +X
  else if (axis === 'z') m.rotation.x = Math.PI / 2; // top points +Z
  return m;
}

export function sphere(mat, r, detail = 0) {
  const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, detail), mat);
  m.castShadow = m.receiveShadow = true;
  return m;
}

export function disposeGroup(root) {
  const mats = new Set();
  root.traverse((c) => {
    if (c.geometry) c.geometry.dispose();
    if (c.material) {
      if (Array.isArray(c.material)) c.material.forEach((m) => mats.add(m));
      else mats.add(c.material);
    }
  });
  mats.forEach((m) => {
    // canvas-textured sign faces (scenery.js) own their textures — free them too
    if (m.map) m.map.dispose();
    if (m.emissiveMap && m.emissiveMap !== m.map) m.emissiveMap.dispose();
    m.dispose();
  });
}
