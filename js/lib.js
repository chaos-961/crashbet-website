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

/* Merge a STATIC subtree down to one mesh per material.
   `matFactory` already dedupes materials by parameter key, so "per material" is
   usually a handful — a 20-mesh prop lands at 3 or 4 draw calls.

   Sim-neutral by construction: colliders are explicit recipes that are never
   parsed from geometry, so nothing physics reads is touched, and the caller's
   own group node survives so `buildTargetMap` and `disposeGroup` still work.

   NEVER call this on a vehicle. deform.js displaces per weld group with
   per-zone stiffness (nose crumples, cabin resists), and merging every panel
   into one buffer would weld zones together and change the crumple model.
   Anything that must survive gets `userData.noMerge`. */
// Two materials with identical parameters are still two GPU state changes when
// they are different objects. `matFactory` dedupes within ONE build, so a
// 20-prop scene has 20 separate "black rubber" materials and merging by uuid
// can never join them. `byParams` keys on the parameters instead, which is what
// makes a whole-showroom merge collapse thousands of meshes into dozens.
const matKey = (m) => [
  m.color && m.color.getHexString(), m.roughness, m.metalness, m.flatShading,
  m.envMapIntensity, m.emissive && m.emissive.getHexString(), m.emissiveIntensity,
  m.transparent, m.opacity, m.side, m.map ? m.map.uuid : '', m.type,
].join('|');

/* Flatten a list of meshes into ONE non-indexed triangle-list geometry, in the
   space `inv` maps into (normally the merge root's local space).

   **`box()`, `cyl()` and the torus helper are INDEXED.** `BoxGeometry` ships 24
   vertices and 36 indices; `CylinderGeometry` 52 and 96. CLAUDE.md's "all
   geometry is non-indexed" is true of the hexa/slab kit and false of three's
   primitives, which is most of the scenery. Copying `position` in buffer order
   and ignoring `index` therefore does not merge a box — it emits 8 triangles
   stitched from whatever vertices happen to be adjacent, which renders as long
   thin spikes reaching across the scene. Every merge MUST walk the index.

   `opt.color` bakes each source mesh's material colour into a vertex-colour
   attribute — that is what lets many differently-tinted meshes share one
   material (vegetation.js relies on it). */
export function bakeMerged(meshes, inv, opt = {}) {
  const m4 = new THREE.Matrix4(), m3 = new THREE.Matrix3(), v = new THREE.Vector3();
  let n = 0;
  for (const o of meshes) {
    const g = o.geometry;
    n += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const uv = opt.uv ? new Float32Array(n * 2) : null;
  // Two different things want a colour attribute out of here and they are not
  // the same operation. opt.color BAKES each mesh's MATERIAL colour into new
  // vertex colours (1E, so a hundred one-off material hexes collapse to one
  // white material). Carrying an EXISTING per-vertex colour attribute is the
  // other case, and it has to be automatic: mergeByMaterial is the only merge
  // path in the codebase and it never asked for colours, so geometry that
  // already had them lost them silently — the material still says
  // vertexColors:true, so the merged mesh then renders against an undefined
  // attribute and comes out black. Same family as the indexed-geometry bug in
  // 1H: plausible enough at a distance that nothing reports it.
  let anySrcColor = false;
  for (const o of meshes) if (o.geometry.attributes.color) { anySrcColor = true; break; }
  const col = (opt.color || anySrcColor) ? new Float32Array(n * 3) : null;
  let w = 0, wu = 0;
  let anyNormal = false;
  for (const o of meshes) {
    const g = o.geometry, p = g.attributes.position, nn = g.attributes.normal, tt = g.attributes.uv;
    const idx = g.index;
    const cnt = idx ? idx.count : p.count;
    if (nn) anyNormal = true;
    m4.multiplyMatrices(inv, o.matrixWorld);
    m3.getNormalMatrix(m4);
    const sc = g.attributes.color;
    const c = opt.color && o.material && o.material.color ? o.material.color : null;
    for (let k = 0; k < cnt; k++) {
      const i = idx ? idx.getX(k) : k;
      v.fromBufferAttribute(p, i).applyMatrix4(m4);
      pos[w] = v.x; pos[w + 1] = v.y; pos[w + 2] = v.z;
      if (nn) {
        v.fromBufferAttribute(nn, i).applyMatrix3(m3).normalize();
        nor[w] = v.x; nor[w + 1] = v.y; nor[w + 2] = v.z;
      }
      // the mesh's own vertex colours win; the material colour is the fallback,
      // and white is the fallback to that so a mixed list can never go black
      if (col) {
        if (sc) { col[w] = sc.getX(i); col[w + 1] = sc.getY(i); col[w + 2] = sc.getZ(i); }
        else if (c) { col[w] = c.r; col[w + 1] = c.g; col[w + 2] = c.b; }
        else { col[w] = 1; col[w + 1] = 1; col[w + 2] = 1; }
      }
      w += 3;
      if (uv) {
        // zeros where a mesh has no uv: a material carrying a map is only ever
        // used by geometry that has them, so this never shows
        uv[wu] = tt ? tt.getX(i) : 0; uv[wu + 1] = tt ? tt.getY(i) : 0;
        wu += 2;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (uv) geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (!anyNormal) geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

export function mergeByMaterial(root, opt = {}) {
  if (!root) return 0;
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const groups = new Map();
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    if (o.userData.noMerge || Array.isArray(o.material)) return;
    const k = opt.byParams ? matKey(o.material) : o.material.uuid;
    if (!groups.has(k)) groups.set(k, { mat: o.material, list: [], cast: false, recv: false, uv: false });
    const e = groups.get(k);
    e.list.push(o);
    e.cast = e.cast || o.castShadow;
    e.recv = e.recv || o.receiveShadow;
    e.uv = e.uv || !!o.geometry.attributes.uv;
  });
  let saved = 0;
  for (const e of groups.values()) if (e.list.length > 1) saved += e.list.length - 1;
  if (!saved) return 0;

  for (const e of groups.values()) {
    if (e.list.length < 2) continue;
    const geo = bakeMerged(e.list, inv, { uv: e.uv });
    const mesh = new THREE.Mesh(geo, e.mat);
    mesh.castShadow = e.cast;
    mesh.receiveShadow = e.recv;
    mesh.matrixAutoUpdate = false;
    for (const o of e.list) {
      if (o.parent) o.parent.remove(o);
      o.geometry.dispose(); // the material is shared and stays alive
    }
    root.add(mesh);
  }
  root.updateMatrixWorld(true);
  return saved;
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
