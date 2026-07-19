// env.js — procedural environment presets. Purely visual: nothing here may
// influence the simulation (friction, gravity, geometry the sim touches).
// No textures beyond in-memory canvas gradients, no external assets, and any
// scatter uses a fixed seed — the same preset always renders identically.
import * as THREE from 'three';
import { makeRng, matFactory } from './lib.js';

export const ENVS = [
  { id: 'proving', label: 'Proving Ground' },
  { id: 'salt', label: 'Salt Flat' },
  { id: 'night', label: 'Night Lot' },
  { id: 'grid', label: 'Grid' },
];
export const isEnv = (id) => ENVS.some((e) => e.id === id);

// look-tuning baseline (CLAUDE.md) — 'proving' must reproduce it exactly
const BASE = {
  bg: '#35383e', fogN: 32, fogF: 78,
  hemi: 0.55, hemiSky: '#dfe6ee', hemiGnd: '#4a4d53',
  key: 1.7, keyColor: '#fff1de', fill: 0.45, fillColor: '#a9c0d8',
  ground: ['#4b4e55', '#3f424a', '#35383e'],
};

const PRESETS = {
  proving: {},
  salt: {
    bg: '#cabb9d', fogN: 30, fogF: 110,
    hemiSky: '#f4e8cf', hemiGnd: '#8a7c60', hemi: 0.62,
    keyColor: '#ffe7c0', fillColor: '#d8c8a8', fill: 0.4,
    ground: ['#ded2b4', '#d0c3a4', '#c0b291'],
  },
  night: {
    bg: '#131519', fogN: 28, fogF: 105,
    hemiSky: '#39455c', hemiGnd: '#181a20', hemi: 0.46,
    key: 0.6, keyColor: '#b9c8e6', fill: 0.18, fillColor: '#3d4a63',
    ground: ['#2c2f36', '#24262c', '#1a1c21'],
  },
  grid: {
    bg: '#23252b', fogN: 30, fogF: 84,
    ground: ['#31343c', '#2b2e35', '#23252b'],
    hemi: 0.5, key: 1.5,
  },
};

function groundTexture([inner, mid, outer]) {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const x = c.getContext('2d');
  const grad = x.createRadialGradient(256, 256, 40, 256, 256, 256);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.55, mid);
  grad.addColorStop(1, outer);
  x.fillStyle = grad;
  x.fillRect(0, 0, 512, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// flat marking plate lying on the ground (y slightly above 0 to avoid z-fight)
function mark(mat, w, d, x, z, rotY = 0, y = 0.015) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
  m.rotation.x = -Math.PI / 2;
  m.rotation.z = rotY;
  m.position.set(x, y, z);
  m.receiveShadow = true;
  return m;
}

/* ---------------- per-preset decoration builders ---------------- */
function decoProving(g, M) {
  const paint = new THREE.MeshStandardMaterial({ color: '#c9ccd2', roughness: 0.9, transparent: true, opacity: 0.5 });
  const paintDim = paint.clone(); paintDim.opacity = 0.3;
  // painted center circle
  const ring = new THREE.Mesh(new THREE.RingGeometry(5.6, 6, 64), paint);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.015;
  ring.receiveShadow = true;
  g.add(ring);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.5, 24), paintDim);
  dot.rotation.x = -Math.PI / 2;
  dot.position.y = 0.015;
  g.add(dot);
  // drag-lane markings along X: dashed center line + solid lane edges
  for (let x = -38; x <= 38; x += 4) g.add(mark(paintDim, 2, 0.22, x, 0));
  for (const z of [-4.5, 4.5]) {
    g.add(mark(paintDim, 80, 0.16, 0, z));
  }
  // corner Ls of the test pad
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    g.add(mark(paint, 3, 0.24, sx * 30, sz * 22));
    g.add(mark(paint, 0.24, 3, sx * 31.4, sz * 20.6));
  }
}

function decoSalt(g, M) {
  // cracked-flat feel: sparse darker patches, deterministic scatter
  const r = makeRng('env:salt');
  const patch = new THREE.MeshStandardMaterial({ color: '#b5a789', roughness: 0.95, transparent: true, opacity: 0.42 });
  for (let i = 0; i < 26; i++) {
    const a = r.range(0, Math.PI * 2), d = r.range(12, 72);
    const m = new THREE.Mesh(new THREE.CircleGeometry(r.range(0.8, 3.2), 7), patch);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = r.range(0, Math.PI);
    m.position.set(Math.cos(a) * d, 0.012, Math.sin(a) * d);
    g.add(m);
  }
}

function decoNight(g, M) {
  // emissive pole lights around the lot + faked light pools (no extra real
  // lights — performance-safe, the dimmed key light still does the shadows)
  const steel = M('#3c4046', { rough: 0.6 });
  const glow = M('#ffd27a', { rough: 0.4, emissive: '#ffcf70', emInt: 2.4 });
  const pool = new THREE.MeshBasicMaterial({ color: '#6b5c33', transparent: true, opacity: 0.34, blending: THREE.AdditiveBlending, depthWrite: false });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.35;
    const x = Math.cos(a) * 26, z = Math.sin(a) * 26;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 5.6, 8), steel);
    mast.position.set(x, 2.8, z);
    mast.castShadow = true;
    g.add(mast);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.14, 0.34), glow);
    head.position.set(x - Math.cos(a) * 0.5, 5.55, z - Math.sin(a) * 0.5);
    head.rotation.y = -a;
    g.add(head);
    const p = new THREE.Mesh(new THREE.CircleGeometry(4.4, 26), pool);
    p.rotation.x = -Math.PI / 2;
    p.position.set(head.position.x, 0.012, head.position.z);
    g.add(p);
  }
  // painted parking bays
  const paint = new THREE.MeshStandardMaterial({ color: '#8f959e', roughness: 0.9, transparent: true, opacity: 0.32 });
  for (let i = -3; i <= 3; i++) g.add(mark(paint, 0.16, 5, i * 3, -14));
  for (let i = -3; i <= 3; i++) g.add(mark(paint, 0.16, 5, i * 3, 16, 0.35));
}

function decoGrid(g) {
  const grid = new THREE.GridHelper(160, 40, 0x4c5a6e, 0x3a4048);
  grid.position.y = 0.02;
  grid.material.transparent = true;
  grid.material.opacity = 0.6;
  g.add(grid);
  const axes = new THREE.GridHelper(160, 2, 0x5b6c84, 0x5b6c84);
  axes.position.y = 0.025;
  axes.material.transparent = true;
  axes.material.opacity = 0.5;
  g.add(axes);
}

const DECO = { proving: decoProving, salt: decoSalt, night: decoNight, grid: decoGrid };

/* ---------------- controller ---------------- */
// ctx: { scene, hemi, key, fill, invalidate }
export function initEnv(ctx) {
  let current = null;
  let deco = null;
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(90, 48),
    new THREE.MeshStandardMaterial({ roughness: 0.96 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ctx.scene.add(ground);

  const state = { fogN: BASE.fogN, fogF: BASE.fogF, fk: 1 };

  // fk = camera-fit scale from fitCamera — big scenes push the fog out
  function setFogScale(fk) {
    state.fk = fk;
    if (ctx.scene.fog) {
      ctx.scene.fog.near = state.fogN * fk;
      ctx.scene.fog.far = state.fogF * fk;
    }
  }

  function apply(id) {
    if (!PRESETS[id]) id = 'proving';
    if (id === current) return;
    current = id;
    const p = { ...BASE, ...PRESETS[id] };
    ctx.scene.background = new THREE.Color(p.bg);
    ctx.scene.fog = new THREE.Fog(new THREE.Color(p.bg), p.fogN * state.fk, p.fogF * state.fk);
    state.fogN = p.fogN; state.fogF = p.fogF;
    ctx.hemi.intensity = p.hemi;
    ctx.hemi.color.set(p.hemiSky);
    ctx.hemi.groundColor.set(p.hemiGnd);
    ctx.key.intensity = p.key;
    ctx.key.color.set(p.keyColor);
    ctx.fill.intensity = p.fill;
    ctx.fill.color.set(p.fillColor);
    if (ground.material.map) ground.material.map.dispose();
    ground.material.map = groundTexture(p.ground);
    ground.material.needsUpdate = true;
    if (deco) {
      ctx.scene.remove(deco);
      deco.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    }
    deco = new THREE.Group();
    (DECO[id] || (() => {}))(deco, matFactory());
    ctx.scene.add(deco);
    ctx.invalidate();
  }

  return { apply, setFogScale, state, get current() { return current; } };
}
