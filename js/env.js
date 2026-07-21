// env.js — procedural environment presets. Purely visual: nothing here may
// influence the simulation (friction, gravity, geometry the sim touches).
// No textures beyond in-memory canvas gradients, no external assets, and any
// scatter uses a fixed seed — the same preset always renders identically.
import * as THREE from 'three';
import { makeRng, matFactory } from './lib.js';
import { buildTerrain, TERRAIN_FOR_ENV, isTerrain } from './terrain.js';
import { buildWater, punchBasin } from './water.js';

export const ENVS = [
  { id: 'proving', label: 'Proving Ground' },
  { id: 'salt', label: 'Salt Flat' },
  { id: 'night', label: 'Night Lot' },
  { id: 'grid', label: 'Grid' },
  // Ledger #5: topoIntersection and topoRoundabout have always asked for
  // 'city' (director.js:267, 478) and always silently got 'proving', because
  // apply() falls back on an unknown id. Two of ten topologies were rendering
  // in the wrong environment. The director was right and the preset was
  // missing — so add the preset rather than edit the director, which keeps
  // every generated scenario byte-identical.
  { id: 'city', label: 'City Overcast' },
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
  // flat overcast daylight — soft key, lifted hemi, cool grey ground
  city: {
    bg: '#8fa0ad', fogN: 34, fogF: 120,
    hemiSky: '#dfe8f0', hemiGnd: '#54585e', hemi: 0.66,
    key: 1.32, keyColor: '#fdf7ec', fill: 0.5, fillColor: '#b4c4d4',
    ground: ['#585c63', '#4c5057', '#42464d'],
  },
};

/* ---------------- procedural skybox ----------------
   A camera-following gradient dome + sun/moon disc, deterministic star field
   and low-poly cloud blobs. Purely visual; all materials are fog-free and
   tone-map-exempt so the authored sky colors survive ACES. Fog color comes
   from the sky's horizon so the ground disc fades into the sky, not into a
   flat backdrop. */
const SKY_R = 430;
// unit vector from a preset's sun az/el — the sky draws its disc here and, as
// of 1B, the key light comes from here too rather than from a hardcoded corner
const dirOf = (az, el) => new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
// legacy key direction, kept for presets with no sun in the sky (grid)
const KEY_FALLBACK = new THREE.Vector3(6, 9, 4).normalize();
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
  city: {
    top: '#5b6b7d', mid: '#8fa0ad', hor: '#c3ccd2', fog: '#b7c0c6',
    sun: { hex: '#f4f1ea', glow: '#e8e6df', az: 1.35, el: 0.68, size: 18 },
    clouds: { n: 12, hex: '#dfe4e8' },
  },
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const mixHex = (a, b, t) => '#' + new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString();

// The overcast target for a preset: its OWN horizon dragged most of the way to
// the weather's haze colour. Deriving from the preset rather than from a fixed
// grey is what keeps a socked-in night a dark night instead of a grey
// afternoon — and taking the haze from the weather rather than hardcoding grey
// is what lets a dust storm be tan and mist be brighter than what it hides.
const hazeTarget = (cfg, hz) => mixHex(cfg.hor, (hz && hz.hex) || '#8f979d', 0.72);

// cloud hides things in the sky (sun, stars, more blobs); haze.amt recolours
// the air. They are separate because a dust storm hazes hard on a half-clear
// sky, and driving blob count off haze would grow clouds out of the dust.
/* The dome is a shader (1B), not a 4x512 canvas ramp. Three reasons, in order
   of how much they matter:

   1. A vertical ramp cannot express an AZIMUTHAL sun glow. The sun disc was
      drawn at the preset's az/el into a sky that did not respond to it at all
      (ledger #2) — the one place every scene visibly announced that the sky was
      a backdrop rather than a light source.
   2. Uniforms let weather move without a rebuild. `makeSky` used to be called
      from `applyWeather`, so every weather change disposed the dome, the
      textures, the star field and every cloud blob and rebuilt the lot.
      Structure is now per-PRESET and weather is per-frame-cheap.
   3. No banding and no texture memory.

   Injected into MeshBasicMaterial rather than written as a raw ShaderMaterial,
   the same call water.js makes: `toneMapped:false` + the material's own
   colorspace chunk is exactly the linear->sRGB-without-tonemapping path the
   canvas version got for free, and hand-rolling it is how the authored hexes
   start drifting from what ACES does to everything else.

   The CPU still computes top/mid/hor with the same mixHex expression, because
   `horizonNow()` feeds the terrain's baked haze, the scene background and the
   fog tint — those four must agree or the landscape meets a sky it does not
   match. The shader adds what the ramp could not: sun glow and a horizon band. */
const DOME_HEAD = /* glsl */`
  uniform vec3 uTop; uniform vec3 uMid; uniform vec3 uHor;
  uniform vec3 uSunDir; uniform vec3 uGlowCol; uniform float uGlow;
  uniform vec3 uHazeCol; uniform float uHaze;
  varying vec3 vSkyDir;
`;
const DOME_BODY = /* glsl */`
  vec3 sd = normalize(vSkyDir);
  vec3 sky = mix(uHor, uMid, smoothstep(0.0, 0.34, sd.y));
  sky = mix(sky, uTop, smoothstep(0.34, 1.0, sd.y));
  // azimuthal glow: a broad wash around the sun plus a tight core near it
  float ca = max(dot(sd, uSunDir), 0.0);
  sky += uGlowCol * (pow(ca, 5.0) * 0.4 + pow(ca, 48.0) * 0.75) * uGlow;
  // the air thickens toward the horizon, above AND below it
  sky = mix(sky, uHazeCol, (1.0 - smoothstep(0.0, 0.3, abs(sd.y))) * uHaze * 0.55);
  diffuseColor.rgb = sky;
`;

/* Cloud cover: one extra draw call for the whole overcast read. The fbm is
   evaluated against the direction projected onto a flat deck (d.xz / d.y), so
   it foreshortens toward the horizon the way a real cloud layer does instead of
   sitting on the dome like wallpaper. Hidden outright at low cover, so a clear
   scene pays nothing for it. */
const COVER_HEAD = /* glsl */`
  uniform float uCover; uniform vec2 uScroll; uniform vec3 uCloudCol;
  varying vec3 vSkyDir;
  float cHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float cNoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(cHash(i), cHash(i + vec2(1.0, 0.0)), u.x),
               mix(cHash(i + vec2(0.0, 1.0)), cHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float cFbm(vec2 p){
    return cNoise(p) * 0.55 + cNoise(p * 2.03) * 0.28 + cNoise(p * 4.11) * 0.17;
  }
`;
const COVER_BODY = /* glsl */`
  vec3 cd = normalize(vSkyDir);
  if (cd.y < 0.04) discard;                       // below the deck
  vec2 cuv = cd.xz / max(cd.y, 0.12) * 0.85 + uScroll;
  float cn = cFbm(cuv);
  // higher cover lowers the threshold, so the deck closes up rather than just
  // fading in — fading in reads as dirty glass, closing up reads as weather
  float ca2 = smoothstep(0.62 - uCover * 0.42, 0.96 - uCover * 0.42, cn);
  ca2 *= smoothstep(0.04, 0.26, cd.y) * uCover;
  diffuseColor.rgb = uCloudCol;
  diffuseColor.a = ca2;
`;

function skyInject(mat, head, body, uni) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uni);
    sh.vertexShader = 'varying vec3 vSkyDir;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>', '#include <begin_vertex>\n  vSkyDir = normalize(position);',
    );
    sh.fragmentShader = head + sh.fragmentShader.replace(
      '#include <color_fragment>', '#include <color_fragment>\n' + body,
    );
  };
  mat.userData.uni = uni;
}

// Structure only — everything weather-dependent is a uniform now, so this runs
// on a PRESET change and not on a weather change.
function makeSky(id) {
  const cfg = SKIES[id] || SKIES.proving;
  const g = new THREE.Group();
  const sunDir = cfg.sun ? dirOf(cfg.sun.az, cfg.sun.el) : KEY_FALLBACK.clone();

  const domeU = {
    uTop: { value: new THREE.Color(cfg.top) },
    uMid: { value: new THREE.Color(cfg.mid) },
    uHor: { value: new THREE.Color(cfg.hor) },
    uSunDir: { value: sunDir.clone() },
    uGlowCol: { value: new THREE.Color(cfg.sun ? cfg.sun.glow : '#000000') },
    uGlow: { value: cfg.sun ? 1 : 0 },
    uHazeCol: { value: new THREE.Color('#8f979d') },
    uHaze: { value: 0 },
  };
  const domeMat = new THREE.MeshBasicMaterial({
    side: THREE.BackSide, fog: false, toneMapped: false, depthWrite: false,
  });
  skyInject(domeMat, DOME_HEAD, DOME_BODY, domeU);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(SKY_R, 32, 20), domeMat);
  dome.frustumCulled = false;
  dome.renderOrder = -10;
  g.add(dome);

  // cloud deck, just inside the dome
  const coverU = {
    uCover: { value: 0 },
    uScroll: { value: new THREE.Vector2(0, 0) },
    uCloudCol: { value: new THREE.Color(cfg.clouds ? cfg.clouds.hex : '#dfe4e8') },
  };
  const coverMat = new THREE.MeshBasicMaterial({
    side: THREE.BackSide, fog: false, toneMapped: false, depthWrite: false, transparent: true,
  });
  skyInject(coverMat, COVER_HEAD, COVER_BODY, coverU);
  const cover = new THREE.Mesh(new THREE.SphereGeometry(SKY_R * 0.97, 32, 16), coverMat);
  cover.frustumCulled = false;
  cover.renderOrder = -9.5;
  cover.visible = false;
  g.add(cover);

  // sun/moon — built once and faded by uniform, since cloud no longer rebuilds
  let glow = null, disc = null;
  if (cfg.sun) {
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
    glow = new THREE.Mesh(
      new THREE.PlaneGeometry(cfg.sun.size * 7, cfg.sun.size * 7),
      new THREE.MeshBasicMaterial({ map: gtex, transparent: true, depthWrite: false, fog: false, toneMapped: false }),
    );
    glow.position.copy(d).multiplyScalar(SKY_R * 0.94);
    glow.lookAt(0, 0, 0);
    glow.renderOrder = -9;
    g.add(glow);
    disc = new THREE.Mesh(
      new THREE.CircleGeometry(cfg.sun.size, 24),
      new THREE.MeshBasicMaterial({
        color: cfg.sun.hex, fog: false, toneMapped: false, depthWrite: false, transparent: true,
      }),
    );
    disc.position.copy(d).multiplyScalar(SKY_R * 0.92);
    disc.lookAt(0, 0, 0);
    disc.renderOrder = -8;
    g.add(disc);
  }

  /* Stars varied per star rather than 260 identical 2.2 px dots. Size,
     brightness and a slight colour spread all come off the same seeded stream,
     and a real sky's brightness distribution is heavily weighted to the faint
     end — hence the cubed roll, which leaves a handful of bright ones instead
     of an even wash of mid-grey. */
  let stars = null;
  if (cfg.stars) {
    const r = makeRng('sky:stars:' + id);
    const n = cfg.stars;
    const pos = new Float32Array(n * 3), size = new Float32Array(n), col = new Float32Array(n * 3);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const d = dirOf(r.range(0, Math.PI * 2), Math.asin(r.range(0.05, 0.995))).multiplyScalar(SKY_R * 0.96);
      pos[i * 3] = d.x; pos[i * 3 + 1] = d.y; pos[i * 3 + 2] = d.z;
      const b = r() * r() * r();           // faint-weighted
      size[i] = 1.1 + b * 3.2;
      // blue-white through to a few warm ones, then scaled by brightness
      c.setHSL(r.range(0.08, 0.62), r.range(0.05, 0.35), 0.5, THREE.SRGBColorSpace);
      const v = 0.45 + b * 0.55;
      col[i * 3] = c.r * v; col[i * 3 + 1] = c.g * v; col[i * 3 + 2] = c.b * v;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
    geo.setAttribute('aCol', new THREE.Float32BufferAttribute(col, 3));
    const starU = { uFade: { value: 1 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: starU,
      transparent: true, depthWrite: false, fog: false,
      vertexShader: `
        attribute float aSize; attribute vec3 aCol;
        varying vec3 vCol;
        void main(){
          vCol = aCol;
          gl_PointSize = aSize;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform float uFade; varying vec3 vCol;
        void main(){
          // round the point off; a square star is the tell of a naive sprite
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.12, d) * uFade;
          if (a <= 0.01) discard;
          gl_FragColor = vec4(vCol, a);
          #include <colorspace_fragment>
        }`,
    });
    stars = new THREE.Points(geo, mat);
    stars.frustumCulled = false;
    stars.renderOrder = -9;
    stars.userData.uni = starU;
    g.add(stars);
  }

  /* Parallax blobs. Built at the MAXIMUM count once and revealed by count in
     setWx, because cover no longer triggers a rebuild — the flattened gradient
     and the deck above are what actually read as overcast, these just give the
     sky something with edges in it. */
  let blobMat = null;
  const blobs = [];
  if (cfg.clouds) {
    const r = makeRng('sky:clouds:' + id);
    blobMat = new THREE.MeshBasicMaterial({ color: cfg.clouds.hex, fog: false, toneMapped: false });
    const nc = Math.min(26, Math.round(cfg.clouds.n * 2.5));
    for (let i = 0; i < nc; i++) {
      const az = r.range(0, Math.PI * 2), el = r.range(0.1, 0.38);
      const cl = new THREE.Group();
      const nb = r.int(3, 5);
      for (let b = 0; b < nb; b++) {
        const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r.range(7, 12), 0), blobMat);
        m.scale.y = r.range(0.35, 0.5);
        m.position.set(b * r.range(6, 9) - nb * 3.5, r.range(-1.8, 1.8), r.range(-4, 4));
        m.rotation.y = r.range(0, Math.PI);
        cl.add(m);
      }
      cl.position.copy(dirOf(az, el).multiplyScalar(SKY_R * r.range(0.8, 0.92)));
      cl.rotation.y = -az;
      cl.scale.setScalar(r.range(1.6, 3.0));
      blobs.push(cl);
      g.add(cl);
    }
  }

  /* The one place weather touches the sky. Everything here is a uniform write
     or a visibility flag — no allocation, no dispose, no shader recompile. */
  g.userData.setWx = (cloud, hz) => {
    const k = clamp01(cloud);
    const h = clamp01(hz ? hz.amt : 0);
    const grey = hazeTarget(cfg, hz);
    domeU.uTop.value.set(mixHex(cfg.top, grey, h * 0.95));
    domeU.uMid.value.set(mixHex(cfg.mid, grey, h * 0.9));
    domeU.uHor.value.set(mixHex(cfg.hor, grey, h * 0.7));
    domeU.uHazeCol.value.set((hz && hz.hex) || '#8f979d');
    domeU.uHaze.value = h;
    // the glow goes with the sun it belongs to
    const sunVis = cfg.sun ? clamp01(1 - k / 0.78) : 0;
    domeU.uGlow.value = sunVis;
    if (glow) { glow.material.opacity = sunVis; glow.visible = sunVis > 0.01; }
    if (disc) { disc.material.opacity = sunVis; disc.visible = sunVis > 0.01; }
    if (stars) {
      stars.userData.uni.uFade.value = clamp01(1 - k / 0.85) * 0.95;
      stars.visible = k < 0.85;
    }
    coverU.uCover.value = k;
    coverU.uCloudCol.value.set(mixHex(cfg.clouds ? cfg.clouds.hex : '#dfe4e8', grey, h * 0.85));
    cover.visible = k > 0.06;
    if (blobMat) blobMat.color.set(mixHex(cfg.clouds.hex, grey, h * 0.8));
    const show = Math.min(blobs.length, Math.round(cfg.clouds ? cfg.clouds.n * (0.6 + k * 1.9) : 0));
    for (let i = 0; i < blobs.length; i++) blobs[i].visible = i < show;
  };
  // wind scrolls the deck; see syncSky
  g.userData.scroll = coverU.uScroll;
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
    buildTerrainNow(); // the terrain annulus starts at this edge
    ctx.invalidate();
  }

  /* Water (G4, rebuilt in 1C). Purely visual — the sim carves its own basin
     out of the ground collider and runs the buoyancy (see physics._stepWater);
     env owns the lifecycle and water.js owns the look. setWater(null) removes
     it, and destroyRound calls exactly that so a channel never follows you into
     the showroom.

     It was one flat opaque quad plus four dark planes: a blue rectangle lying
     on the grass, with nothing in the frame loop touching it. */
  let water = null;
  function setWater(w) {
    if (water) { ctx.scene.remove(water.group); water.dispose(); water = null; }
    if (w) {
      water = buildWater(w, { env: current, sky: horizonNow() });
      // the sea state comes from the same descriptor driving the rain and the
      // vegetation, so wind is one value across the whole scene
      water.setWeather(wx, horizonNow());
      ctx.scene.add(water.group);
    }
    syncBasinPunch();
    ctx.invalidate();
  }

  /* The visual ground has to have the same hole in it the collider does, or it
     is simply drawn over the top of the channel — which is what had been
     happening. Re-applied after every terrain build, because applyWeather
     rebuilds the mesh (and its material) whenever the haze moves. */
  function syncBasinPunch() {
    const spec = water ? water.spec : null;
    punchBasin(ground.material, spec);
    if (terrainMesh) punchBasin(terrainMesh.material, spec);
  }

  /* Frozen while the round is, exactly like weather and vegetation: the sim's
     clock is stopped, so still water is the correct fiction, and it lets
     render-on-demand sleep through the freeze — the longest UI phase and
     precisely when the player wants a steady frame to read. Returns whether
     the camera is under the surface so main can put the lens treatment on. */
  function updateWater(dt, camera, frozen) {
    if (!water) return false;
    if (!frozen) water.tick(dt);
    return water.isUnder(camera.position);
  }

  /* Terrain (1A, promoted to the ground in 1F). Opt-in exactly like water:
     setTerrain(null) removes it and nothing else in the frame changes.

     It reaches all the way to r=0 and IS the ground wherever it exists, so the
     flat disc hides while it is up rather than being deleted — the showroom
     and crash mode still want a plain apron, and a hidden mesh costs nothing.
     Inside playR the height mask is exactly 0, so the play area is the same
     flat y=0 plane the disc was, with the same shadow receiving; what changes
     is that the surface colour is now a ramp in world units instead of a
     stretched CanvasTexture, and there is no longer a rim where the world ends.

     The spec is kept because the horizon haze and the ground ramp are baked
     into the vertex colours, so a preset change has to rebuild — same as the
     sky. */
  let terrainMesh = null;
  let terrainSpec = null;
  // declared up here rather than beside applyWeather so nothing that runs
  // during init can trip over the temporal dead zone
  let wx = null;
  const cloudNow = () => (wx ? clamp01(wx.cloudCover) : 0);
  const hazeNow = () => (wx && wx.haze ? wx.haze : { hex: '#8f979d', amt: 0 });
  // the horizon the world is actually sitting against once weather is applied —
  // terrain haze, scene background and fog all have to agree on this one value,
  // and it must be the SAME expression makeSky uses for its `hor` stop or the
  // landscape meets a sky it does not match
  const horizonNow = () => {
    const sk = SKIES[current] || SKIES.proving;
    const hz = hazeNow();
    return mixHex(sk.hor, hazeTarget(sk, hz), clamp01(hz.amt) * 0.7);
  };
  // how bright the landscape is authored, per environment — see `value` in
  // terrain.js. Not a lighting value: it scales the baked vertex colours.
  const TERRAIN_VALUE = { proving: 1, salt: 1, night: 0.34, grid: 0.7, city: 0.86 };
  // the single expression for "how bright the landscape is right now". Exported
  // so vegetation can match it — plants use their own baked colours, and
  // without this a downpour leaves vivid green trees standing on grey hills.
  const terrainValueNow = () =>
    (TERRAIN_VALUE[current] == null ? 1 : TERRAIN_VALUE[current]) * (1 - cloudNow() * 0.34);
  function dropTerrain() {
    if (!terrainMesh) return;
    ctx.scene.remove(terrainMesh);
    terrainMesh.geometry.dispose();
    terrainMesh.material.dispose();
    terrainMesh = null;
    ground.visible = true;
  }
  function buildTerrainNow() {
    dropTerrain();
    if (!terrainSpec) return;
    const pr = { ...BASE, ...(PRESETS[current] || {}) };
    terrainMesh = buildTerrain(
      { playR: groundR, r0: 0, ...terrainSpec },
      {
        horizon: horizonNow(), ground: pr.ground, small: !!ctx.small,
        // baked colours can't respond to the lighting rig, so cloud has to
        // darken the landscape here or a downpour keeps sunlit-green hills
        value: terrainValueNow(),
      },
    );
    ctx.scene.add(terrainMesh);
    ground.visible = false; // the landscape is the ground now
    syncBasinPunch();       // this mesh is new, so its hole is too
  }
  function setTerrain(spec) {
    if (spec === null || spec === undefined) { terrainSpec = null; dropTerrain(); ctx.invalidate(); return; }
    // a bare seed is enough; the preset falls back to whatever suits the env
    const s = typeof spec === 'object' ? { ...spec } : { seed: spec };
    if (!isTerrain(s.preset)) s.preset = TERRAIN_FOR_ENV[current] || 'rolling';
    terrainSpec = s;
    buildTerrainNow();
    ctx.invalidate();
  }

  /* The sun and the shadows used to disagree. The key light was hardcoded at
     (6, 9, 4) — in main.js AND again in fitCamera — while the sun disc was
     drawn from each preset's az/el. Measured angle between the two: proving
     ~10°, salt ~51°, night ~64°, so in Night Lot the moon hung behind-left
     while every shadow fell front-right. It was the single biggest reason
     scenes read as subtly wrong.
     Division of labour now: the sky owns the DIRECTION, fitCamera still owns
     the distance and the shadow frustum. */
  const state = { fogN: BASE.fogN, fogF: BASE.fogF, fk: 1, sunDir: KEY_FALLBACK.clone() };

  // fk = camera-fit scale from fitCamera — big scenes push the fog out
  function setFogScale(fk) {
    state.fk = fk;
    if (ctx.scene.fog) {
      ctx.scene.fog.near = state.fogN * fk;
      ctx.scene.fog.far = state.fogF * fk;
    }
  }

  /* The preset/weather split (1B). `apply` rebuilds STRUCTURE — sky mesh,
     decoration, terrain, ground texture, light colours — and early-returns on
     an unchanged id, which is fine and cheap. `applyWeather` only moves light
     intensities, fog distances and the sky's cloud cover, and never
     early-returns.
     That separation is the whole point: the old single `apply` bailed on an
     unchanged id and rebuilt everything otherwise, so "same preset, different
     weather, every scene" was impossible to express (ledger #3). */
  // STRUCTURE — preset changes only. This used to run from applyWeather, so
  // every weather change disposed the dome, its textures, the star field and
  // every cloud blob and built the lot again; the sky is now uniform-driven and
  // this fires once per preset.
  function rebuildSky() {
    if (sky) {
      ctx.scene.remove(sky);
      sky.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
      });
    }
    sky = makeSky(current);
    ctx.scene.add(sky);
    syncSkyTint();
  }

  // WEATHER — uniform writes plus the two scene-level colours that have to
  // agree with them. No allocation beyond the Color the background needs.
  function syncSkyTint() {
    const sk = SKIES[current] || SKIES.proving;
    const hz = hazeNow();
    if (sky) sky.userData.setWx(cloudNow(), hz);
    // background and fog tint follow the HAZED horizon, not the authored one
    if (ctx.scene.background && ctx.scene.background.isColor) ctx.scene.background.set(horizonNow());
    else ctx.scene.background = new THREE.Color(horizonNow());
    // fog goes further toward the raw haze than the sky does: the air near you
    // is the haze, while the dome is still mostly the place you are in
    const fogC = new THREE.Color(mixHex(sk.fog, hz.hex, clamp01(hz.amt) * 0.62));
    if (ctx.scene.fog) ctx.scene.fog.color.copy(fogC);
    else ctx.scene.fog = new THREE.Fog(fogC, state.fogN * state.fk, state.fogF * state.fk);
  }

  function applyWeather(w) {
    wx = w || null;
    const p = { ...BASE, ...(PRESETS[current] || {}) };
    // multipliers over the preset, so weather composes with a place instead of
    // replacing its look. This is what actually reads as weather — you would
    // believe an overcast scene with no rain drawn at all.
    const L = wx ? wx.light : { key: 1, hemi: 1, fill: 1, exposure: 1, envI: 1 };
    ctx.hemi.intensity = p.hemi * L.hemi;
    ctx.key.intensity = p.key * L.key;
    ctx.fill.intensity = p.fill * L.fill;
    // the image-based flood. Not optional: the PMREM room environment lights
    // every material regardless of what the three lights are doing, so leaving
    // it at 1 makes a storm a bright afternoon that merely lost its shadows.
    if (ctx.setEnvIntensity) ctx.setEnvIntensity(L.envI == null ? 1 : L.envI);
    // weather pulls the fog in, the far plane far more than the near one
    const fb = wx ? wx.fogBoost : 0;
    state.fogN = p.fogN * (1 - fb * 0.5);
    state.fogF = p.fogF * (1 - fb * 0.74);
    if (ctx.scene.fog) {
      ctx.scene.fog.near = state.fogN * state.fk;
      ctx.scene.fog.far = state.fogF * state.fk;
    }
    syncSkyTint();     // uniforms, not a rebuild
    buildTerrainNow(); // haze is baked into the vertex colours
    // and the sea state, for the same reason: startScene sets the water before
    // it rolls the weather, so without this the channel keeps the LAST round's
    // wind and a storm falls on a mirror
    if (water) water.setWeather(wx, horizonNow());
    if (ctx.setExposure) ctx.setExposure(L.exposure);
    ctx.invalidate();
  }

  function apply(id) {
    if (!PRESETS[id]) id = 'proving';
    if (id === current) return;
    current = id;
    const p = { ...BASE, ...PRESETS[id] };
    const sk = SKIES[id] || SKIES.proving;
    state.fogN = p.fogN; state.fogF = p.fogF;
    ctx.hemi.color.set(p.hemiSky);
    ctx.hemi.groundColor.set(p.hemiGnd);
    ctx.key.color.set(p.keyColor);
    // aim the key at the thing the player can see in the sky, keeping whatever
    // distance fitCamera last chose
    state.sunDir.copy(sk.sun ? dirOf(sk.sun.az, sk.sun.el) : KEY_FALLBACK);
    ctx.key.position.copy(state.sunDir).multiplyScalar(ctx.key.position.length() || 30);
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
    // the sky's STRUCTURE belongs to the preset, so it is rebuilt here and only
    // here; applyWeather below just moves its uniforms. `current` starts null,
    // so the first apply('proving') from boot is what creates it.
    rebuildSky();
    applyWeather(wx); // intensities, fog distances, sky uniforms and terrain
  }

  /* The dome follows the camera so its horizon never gets "reached".
     `dt` also drifts the cloud deck on the scene's own wind — the same
     descriptor bending the vegetation and slanting the rain, so one wind reads
     across the whole scene. Deliberately NOT reported as animating: at these
     speeds (a few hundredths of a UV per second) it is invisible frame to
     frame, and forcing a redraw for it would defeat render-on-demand in every
     idle state the game has. It advances on whatever frames do get drawn. */
  let skyT = 0;
  function syncSky(pos, dt) {
    if (!sky) return;
    sky.position.copy(pos);
    if (dt > 0 && sky.userData.scroll) {
      const w = wx && wx.wind ? wx.wind : null;
      const sp = w ? w.speed * 0.0022 : 0.0016;
      skyT += dt;
      sky.userData.scroll.value.set(
        Math.cos(w ? w.dir : 0.6) * sp * skyT,
        Math.sin(w ? w.dir : 0.6) * sp * skyT,
      );
    }
  }

  return {
    apply, applyWeather, setFogScale, setGroundRadius, setWater, updateWater, setTerrain, syncSky, state,
    get current() { return current; },
    get hasWater() { return !!water; },
    get weather() { return wx; },
    get terrainField() { return terrainMesh ? terrainMesh.userData.field : null; },
    get terrainValue() { return terrainValueNow(); },
    get groundRadius() { return groundR; },
  };
}
