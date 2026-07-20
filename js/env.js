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

/* ---------------- procedural skybox ----------------
   A camera-following gradient dome + sun/moon disc, deterministic star field
   and low-poly cloud blobs. Purely visual; all materials are fog-free and
   tone-map-exempt so the authored sky colors survive ACES. Fog color comes
   from the sky's horizon so the ground disc fades into the sky, not into a
   flat backdrop. */
const SKY_R = 430;
const SKIES = {
  proving: {
    top: '#2b5c94', mid: '#5e8fc0', hor: '#b6cbd9', fog: '#a9bcc9',
    sun: { hex: '#fff3d2', glow: '#ffe9b8', az: 0.59, el: 0.72, size: 22 },
    clouds: { n: 10, hex: '#eef1f4' },
  },
  salt: {
    top: '#6f9ab8', mid: '#c9c2a4', hor: '#ecdfc0', fog: '#ded2b4',
    sun: { hex: '#fff6e0', glow: '#ffedc4', az: -0.5, el: 0.5, size: 30 },
    clouds: { n: 5, hex: '#f4efe2' },
  },
  night: {
    top: '#070a11', mid: '#101624', hor: '#1d2536', fog: '#171e2c',
    sun: { hex: '#e6edf8', glow: '#9fb4d8', az: 2.2, el: 0.62, size: 13 },
    stars: 260,
    clouds: { n: 3, hex: '#1a2130' },
  },
  grid: { top: '#16181e', mid: '#1f2229', hor: '#2b2f37', fog: '#23252b' },
};

function makeSky(id) {
  const cfg = SKIES[id] || SKIES.proving;
  const g = new THREE.Group();
  const dirOf = (az, el) => new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));

  // gradient dome (v 0.5 = equator = horizon; horizon color holds below it)
  const c = document.createElement('canvas');
  c.width = 4; c.height = 512;
  const x = c.getContext('2d');
  const grad = x.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, cfg.top);
  grad.addColorStop(0.34, cfg.mid);
  grad.addColorStop(0.5, cfg.hor);
  grad.addColorStop(1, cfg.hor);
  x.fillStyle = grad;
  x.fillRect(0, 0, 4, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(SKY_R, 24, 14),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, toneMapped: false, depthWrite: false }),
  );
  dome.frustumCulled = false;
  dome.renderOrder = -10;
  g.add(dome);

  if (cfg.sun) { // sun by day, moon by night — same recipe, different palette
    const d = dirOf(cfg.sun.az, cfg.sun.el);
    const gc = document.createElement('canvas');
    gc.width = gc.height = 128;
    const gx = gc.getContext('2d');
    const rad = gx.createRadialGradient(64, 64, 6, 64, 64, 64);
    rad.addColorStop(0, cfg.sun.glow + 'bb');
    rad.addColorStop(1, cfg.sun.glow + '00');
    gx.fillStyle = rad;
    gx.fillRect(0, 0, 128, 128);
    const gtex = new THREE.CanvasTexture(gc);
    gtex.colorSpace = THREE.SRGBColorSpace;
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(cfg.sun.size * 7, cfg.sun.size * 7),
      new THREE.MeshBasicMaterial({ map: gtex, transparent: true, depthWrite: false, fog: false, toneMapped: false }),
    );
    glow.position.copy(d).multiplyScalar(SKY_R * 0.94);
    glow.lookAt(0, 0, 0);
    glow.renderOrder = -9;
    g.add(glow);
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(cfg.sun.size, 24),
      new THREE.MeshBasicMaterial({ color: cfg.sun.hex, fog: false, toneMapped: false, depthWrite: false }),
    );
    disc.position.copy(d).multiplyScalar(SKY_R * 0.92);
    disc.lookAt(0, 0, 0);
    disc.renderOrder = -8;
    g.add(disc);
  }

  if (cfg.stars) {
    const r = makeRng('sky:stars:' + id);
    const pos = new Float32Array(cfg.stars * 3);
    for (let i = 0; i < cfg.stars; i++) {
      const d = dirOf(r.range(0, Math.PI * 2), Math.asin(r.range(0.05, 0.995))).multiplyScalar(SKY_R * 0.96);
      pos[i * 3] = d.x; pos[i * 3 + 1] = d.y; pos[i * 3 + 2] = d.z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({
      color: '#cdd8ec', size: 2.2, sizeAttenuation: false,
      transparent: true, opacity: 0.9, fog: false, toneMapped: false, depthWrite: false,
    }));
    pts.frustumCulled = false;
    pts.renderOrder = -9;
    g.add(pts);
  }

  if (cfg.clouds) {
    const r = makeRng('sky:clouds:' + id);
    const mat = new THREE.MeshBasicMaterial({ color: cfg.clouds.hex, fog: false, toneMapped: false });
    for (let i = 0; i < cfg.clouds.n; i++) {
      const az = r.range(0, Math.PI * 2), el = r.range(0.1, 0.38);
      const cl = new THREE.Group();
      const blobs = r.int(3, 5);
      for (let b = 0; b < blobs; b++) {
        const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r.range(7, 12), 0), mat);
        m.scale.y = r.range(0.35, 0.5);
        m.position.set(b * r.range(6, 9) - blobs * 3.5, r.range(-1.8, 1.8), r.range(-4, 4));
        m.rotation.y = r.range(0, Math.PI);
        cl.add(m);
      }
      cl.position.copy(dirOf(az, el).multiplyScalar(SKY_R * r.range(0.8, 0.92)));
      cl.rotation.y = -az;
      cl.scale.setScalar(r.range(1.6, 3.0));
      g.add(cl);
    }
  }
  return g;
}

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
  let sky = null;
  const GROUND_R0 = 90;
  let groundR = GROUND_R0;
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(GROUND_R0, 48),
    new THREE.MeshStandardMaterial({ roughness: 0.96 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ctx.scene.add(ground);

  // director scenes need long approach roads (10 s of run-up at road speed
  // is >100 m), so the disc grows on request. Visual only — the physics
  // ground collider is already 220 m half-extent.
  function setGroundRadius(r) {
    r = Math.max(GROUND_R0, Math.round(r));
    if (r === groundR) return;
    groundR = r;
    ground.geometry.dispose();
    ground.geometry = new THREE.CircleGeometry(r, 48);
    ctx.invalidate();
  }

  /* G4 water. Purely visual — the sim carves its own basin out of the ground
     collider and runs the buoyancy (see physics._stepWater). This just draws
     the surface, plus dark basin walls so you read depth rather than a flat
     blue rectangle lying on the grass. setWater(null) removes it. */
  let waterGrp = null;
  function setWater(w) {
    if (waterGrp) {
      ctx.scene.remove(waterGrp);
      waterGrp.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      waterGrp = null;
    }
    if (w) {
      const g = new THREE.Group();
      const wx = w.x1 - w.x0, wz = w.z1 - w.z0;
      const cx = (w.x0 + w.x1) / 2, cz = (w.z0 + w.z1) / 2;
      const bed = w.bed == null ? w.y - 3.5 : w.bed;
      const surf = new THREE.Mesh(
        new THREE.PlaneGeometry(wx, wz),
        new THREE.MeshStandardMaterial({
          color: 0x2c4f63, roughness: 0.12, metalness: 0.1,
          transparent: true, opacity: 0.82,
        }),
      );
      surf.rotation.x = -Math.PI / 2;
      surf.position.set(cx, w.y, cz);
      surf.receiveShadow = true;
      g.add(surf);
      // basin walls: four inward-facing strips from the waterline down to the
      // bed, so the channel reads as cut into the ground
      const wall = new THREE.MeshStandardMaterial({ color: 0x1b2a33, roughness: 0.95 });
      const h = w.y - bed;
      const mk = (sw, px, pz, ry) => {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(sw, h), wall);
        m.position.set(px, (w.y + bed) / 2, pz);
        m.rotation.y = ry;
        g.add(m);
      };
      mk(wx, cx, w.z0, 0);
      mk(wx, cx, w.z1, Math.PI);
      mk(wz, w.x0, cz, Math.PI / 2);
      mk(wz, w.x1, cz, -Math.PI / 2);
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(wx, wz), wall);
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(cx, bed, cz);
      g.add(floor);
      waterGrp = g;
      ctx.scene.add(g);
    }
    ctx.invalidate();
  }

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
    const sk = SKIES[id] || SKIES.proving;
    // skybox replaces the flat background; fog tints to the sky's horizon
    if (sky) {
      ctx.scene.remove(sky);
      sky.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
      });
    }
    sky = makeSky(id);
    ctx.scene.add(sky);
    ctx.scene.background = new THREE.Color(sk.hor);
    ctx.scene.fog = new THREE.Fog(new THREE.Color(sk.fog), p.fogN * state.fk, p.fogF * state.fk);
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

  // the dome follows the camera so its horizon never gets "reached"
  function syncSky(pos) {
    if (sky) sky.position.copy(pos);
  }

  return { apply, setFogScale, setGroundRadius, setWater, syncSky, state, get current() { return current; } };
}
