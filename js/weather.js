// weather.js — per-scene weather. The RENDERING half is strictly render-side,
// like fx.js and env.js: it reads nothing from the sim and writes nothing back.
//
// `rollWeather` and `gripFor` are the other half and they are PURE — plain data
// out, no THREE, no side effects — which is what lets director.js call them to
// put the scene's weather on the scenario itself (P2/2D). That matters: grip
// settles money, so the recorder and the round the player watches must read the
// same descriptor, and the only way to guarantee that is for the scene to carry
// it rather than for two callers to re-roll it and hope they agree.
//
// The descriptor is rolled from its OWN rng stream ('wx:'+seed), so the same
// seed always shows the same weather and no existing stream shifts by a draw.
//
// What actually sells weather is the LIGHTING, not the particles: an overcast
// scene reads as overcast because the sun goes away and the whole world drops a
// stop, and you would believe it with no rain drawn at all. The precipitation
// is the garnish. `envI` is the one that is easy to miss — the PMREM room
// environment is a constant IBL flood that no light intensity touches, so
// without scaling it a storm on a pale preset stays a bright afternoon with
// black shadows. It is the single biggest lever in this table.
import * as THREE from 'three';
import { makeRng, clamp } from './lib.js';

/* ---------------- kinds ----------------
   key/hemi/fill are MULTIPLIERS over whatever the environment preset authored,
   so weather composes with a preset instead of replacing its look. `exposure`
   rides the renderer's tone mapping for the last bit of gloom.

   `hemi` is the one that took two passes to get right. The instinct is to
   RAISE it in bad weather — overcast really is a sky-wide source and the
   shadows really do go away — and the first table did, up to 1.38. On a white
   salt flat that produced a storm you could read a newspaper by: albedo wins,
   and killing the key alone cannot darken a surface the ambient is still
   flooding. So hemi rises only where the ground genuinely bounces light back
   (snow, mist) and drops hard everywhere else; the *ratio* to key still climbs,
   which is what actually sells flat weather light.

   `haze` is the colour the AIR takes, and it is not always grey — a dust storm
   is a tan wall and mist is brighter than the thing it hides. Its amount comes
   from cloud and fog together, so dust hazes strongly on modest cloud. */
const KINDS = {
  clear:    { cloud: 0.05, wet: 0,    grip: 1.00, fog: 0,    key: 1.00, hemi: 1.00, fill: 1.00, exposure: 1.00, envI: 1.00, haze: '#a9b6c4' },
  fair:     { cloud: 0.30, wet: 0,    grip: 1.00, fog: 0.06, key: 0.96, hemi: 1.02, fill: 1.00, exposure: 1.00, envI: 1.00, haze: '#a9b6c4' },
  overcast: { cloud: 0.82, wet: 0.15, grip: 0.97, fog: 0.22, key: 0.40, hemi: 0.92, fill: 1.02, exposure: 0.93, envI: 0.72, haze: '#8f979d' },
  drizzle:  { cloud: 0.72, wet: 0.55, grip: 0.88, fog: 0.26, key: 0.48, hemi: 0.90, fill: 1.00, exposure: 0.93, envI: 0.70, haze: '#8d959c', precip: 'rain', rate: 0.34 },
  rain:     { cloud: 0.87, wet: 0.85, grip: 0.82, fog: 0.34, key: 0.34, hemi: 0.80, fill: 0.96, exposure: 0.87, envI: 0.58, haze: '#848c94', precip: 'rain', rate: 0.74 },
  downpour: { cloud: 0.96, wet: 1.00, grip: 0.76, fog: 0.50, key: 0.22, hemi: 0.68, fill: 0.90, exposure: 0.80, envI: 0.46, haze: '#767e87', precip: 'rain', rate: 1.00 },
  mist:     { cloud: 0.50, wet: 0.30, grip: 0.94, fog: 0.62, key: 0.58, hemi: 1.04, fill: 1.06, exposure: 0.98, envI: 0.86, haze: '#c2cbd2' },
  fog:      { cloud: 0.62, wet: 0.35, grip: 0.93, fog: 0.90, key: 0.44, hemi: 0.94, fill: 1.02, exposure: 0.94, envI: 0.74, haze: '#b9c2c9' },
  snow:     { cloud: 0.80, wet: 0.20, grip: 0.70, fog: 0.44, key: 0.52, hemi: 1.12, fill: 1.08, exposure: 1.00, envI: 0.92, haze: '#c8d3e0', precip: 'snow', rate: 0.68 },
  dust:     { cloud: 0.44, wet: 0,    grip: 0.91, fog: 0.58, key: 0.66, hemi: 0.94, fill: 0.98, exposure: 0.96, envI: 0.76, haze: '#b7986a', precip: 'dust', rate: 0.6 },
  storm:    { cloud: 1.00, wet: 1.00, grip: 0.74, fog: 0.46, key: 0.16, hemi: 0.55, fill: 0.82, exposure: 0.72, envI: 0.36, haze: '#5d646c', precip: 'rain', rate: 1.0, lightning: true },
};

/* Weights per environment, because weather has to fit the place — a desert
   blizzard reads as a bug, not as variety. Every ENVS entry needs a table here
   and tests/weather.mjs asserts it in BOTH directions: a preset without a table
   silently inherits proving's weather, which is the exact shape of the bug that
   let `city` render as a proving ground for the life of the project. */
const WEIGHTS = {
  proving: { clear: 26, fair: 30, overcast: 16, drizzle: 8, rain: 8, downpour: 3, mist: 4, fog: 2, storm: 3 },
  salt:    { clear: 40, fair: 28, overcast: 10, dust: 14, mist: 3, storm: 5 },
  night:   { clear: 28, fair: 20, overcast: 17, drizzle: 8, rain: 9, mist: 6, fog: 4, snow: 5, storm: 3 },
  city:    { clear: 14, fair: 24, overcast: 26, drizzle: 12, rain: 12, downpour: 4, mist: 4, fog: 4 },
  grid:    { clear: 100 }, // the diagnostic preset stays legible
  // 1F. Snow finally has somewhere it belongs (alpine), and dust stays on the
  // two dry presets. Dawn leans to mist and fog because that is when both
  // actually happen; dusk keeps the heavier stuff for the light to cut under.
  dawn:    { clear: 30, fair: 28, overcast: 12, mist: 13, fog: 9, drizzle: 5, rain: 3 },
  dusk:    { clear: 30, fair: 26, overcast: 14, drizzle: 8, rain: 8, mist: 6, storm: 8 },
  alpine:  { clear: 24, fair: 22, overcast: 16, snow: 24, mist: 6, fog: 4, storm: 4 },
  coastal: { clear: 22, fair: 26, overcast: 16, drizzle: 8, rain: 8, mist: 8, fog: 8, storm: 4 },
  desert:  { clear: 40, fair: 26, dust: 22, overcast: 5, storm: 7 },
};

export const WEATHER_KINDS = Object.keys(KINDS);
// exported so the gate can assert every env preset has its OWN table. `WEIGHTS`
// falls back to `proving` on an unknown id, which is the same silent-fallback
// shape that let two topologies render in the wrong environment for the whole
// life of the project — an env added without a table would inherit a desert's
// weather and nothing would say so.
export const WEATHER_ENVS = Object.keys(WEIGHTS);

function weightedPick(r, table) {
  let total = 0;
  for (const k in table) total += table[k];
  let x = r() * total;
  for (const k in table) { x -= table[k]; if (x <= 0) return k; }
  return Object.keys(table)[0];
}

// A plain descriptor — no THREE objects, no side effects, safe to log or test.
export function rollWeather(seed, envId) {
  const r = makeRng('wx:' + seed);
  const kind = weightedPick(r, WEIGHTS[envId] || WEIGHTS.proving);
  const k = KINDS[kind];
  const gust = r.range(0.78, 1.18);
  return {
    kind,
    precip: k.precip || null,
    intensity: k.rate ? clamp(k.rate * gust, 0, 1) : 0,
    cloudCover: clamp(k.cloud * r.range(0.92, 1.06), 0, 1),
    wetness: k.wet,
    fogBoost: k.fog,
    // how strongly the air takes its colour. Cloud alone under-reads dust,
    // which hazes hard on a half-clear sky, so fog gets a vote too.
    haze: { hex: k.haze, amt: clamp(Math.max(k.cloud, k.fog * 0.95), 0, 1) },
    wind: { dir: r.range(0, Math.PI * 2), speed: r.range(1.5, 5) * (0.4 + k.cloud) * gust },
    lightning: !!k.lightning,
    light: { key: k.key, hemi: k.hemi, fill: k.fill, exposure: k.exposure, envI: k.envI },
  };
}

export const CLEAR = rollWeather('', 'grid'); // a usable no-weather default

/* ---------------- grip (P2/2D) ----------------
   The tyre-friction multiplier a weather kind implies. Pure, and deliberately
   NOT part of the descriptor `rollWeather` returns: a scenario's
   `world.weather.grip` means "physics is reading this", and its absence means
   "no grip effect at all". If every descriptor carried a grip the moment the
   director attached one to a scenario every scene would silently go low-grip
   and every pin would move — the opt-in has to be a decision someone makes, not
   a field that comes along for the ride.

   Keyed per KIND rather than derived from `wet`, because `wet` describes how
   GLOSSY the road looks and the two genuinely disagree. Snow barely wets
   asphalt (wet 0.20) and is the slipperiest surface here; dust is bone dry
   (wet 0) and a layer of grit on hardpan really does cost grip. Deriving grip
   from wetness would have made snow a 0.95 and dust a no-op, which is backwards
   on both counts.

   No rng: a pure function of the kind, so it adds no draw to any stream and the
   same seed keeps dealing the same scene. */
export function gripFor(wx) {
  const k = wx && KINDS[wx.kind];
  return k && typeof k.grip === 'number' ? k.grip : 1;
}

/* ---------------- wet surfaces ----------------
   The biggest tell that it is raining is not the rain, it is the road. A
   downpour falling on bright dry asphalt reads as a bug, and no amount of
   particle density fixes it. Wet asphalt is darker and much glossier, so pull
   the albedo down and the roughness toward a sheen.

   Safe to mutate in place: materials come from a per-build `matFactory` cache,
   so every road group owns its own and nothing leaks into the next round. The
   `wxWet` guard is for double calls within one round, not for cleanup. */
export function applyWetness(groups, wet) {
  const k = clamp(wet || 0, 0, 1);
  if (k <= 0) return;
  for (const g of groups) {
    if (!g) continue;
    g.traverse((o) => {
      if (!o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m || m.userData.wxWet) continue;
        m.userData.wxWet = k;
        // scalar multiply on a linear-space colour is an exposure change, not
        // an HSL round-trip — no hue shift, so this one is safe (CLAUDE.md)
        m.color.multiplyScalar(1 - 0.42 * k);
        if (m.roughness != null) m.roughness += (0.22 - m.roughness) * 0.8 * k;
        if (m.envMapIntensity != null) m.envMapIntensity *= 1 + 1.4 * k;
        m.needsUpdate = true;
      }
    });
  }
}

/* ---------------- precipitation ----------------
   Two pooled systems, zero per-frame allocation and zero per-frame CPU: the
   fall, the wind drift and the wrap all happen in the vertex shader against a
   box that follows the camera. Scaling the amount is a draw-range change, not
   a rebuild. Rain is LineSegments so drops can be velocity-aligned streaks —
   gl_PointSize is square and cannot express a streak. */
const WRAP = `
  uniform vec3 uBox; uniform vec3 uCam; uniform float uTime;
  uniform vec2 uWind; uniform float uFall;
  vec3 wrapPos(vec3 base) {
    vec3 p = base * uBox;
    p.y -= uTime * uFall;
    p.xz += uWind * uTime;
    return mod(p, uBox) - uBox * 0.5 + uCam;
  }`;

const RAIN_VS = `
  attribute vec3 aBase; attribute float aEnd;
  uniform float uStreak;
  varying float vFade;
  ${WRAP}
  void main() {
    vec3 dir = normalize(vec3(uWind.x, -uFall, uWind.y));
    vec3 w = wrapPos(aBase) + dir * (aEnd * uStreak);
    vFade = 1.0 - aEnd * 0.85;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(w, 1.0);
  }`;

const RAIN_FS = `
  uniform vec3 uColor; uniform float uOpacity;
  varying float vFade;
  void main() { gl_FragColor = vec4(uColor, uOpacity * vFade); }`;

const FLAKE_VS = `
  attribute vec3 aBase; attribute float aSize;
  uniform float uPix; uniform float uSway; uniform float uScale;
  varying float vA;
  ${WRAP}
  void main() {
    vec3 w = wrapPos(aBase);
    // drift sideways so flakes and dust do not fall like ball bearings
    w.x += sin(uTime * 0.9 + aBase.z * 31.4) * uSway;
    w.z += cos(uTime * 0.7 + aBase.x * 27.1) * uSway;
    vec4 mv = modelViewMatrix * vec4(w, 1.0);
    // aSize is a WORLD size in metres and uPix is the projection scale, so a
    // flake is the size a flake would be. Sizing in raw pixels-at-one-metre
    // (the obvious version) makes near flakes 200 px ping-pong balls.
    float z = -mv.z;
    gl_PointSize = clamp(aSize * uScale * (uPix / max(0.5, z)), 1.0, 22.0);
    // ...and correct sizing alone still leaves the one flake that drifts within
    // a metre of the lens rendering as a fat soft ball. No real lens resolves
    // that — it is inside the near focus — so fade it out instead of drawing it.
    vA = smoothstep(0.7, 3.5, z);
    gl_Position = projectionMatrix * mv;
  }`;

const FLAKE_FS = `
  uniform vec3 uColor; uniform float uOpacity;
  varying float vA;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float m = (1.0 - smoothstep(0.30, 0.5, length(d))) * vA;
    if (m <= 0.004) discard;
    gl_FragColor = vec4(uColor, uOpacity * m);
  }`;

// Deliberately small. Density is count/volume, and a box big enough to "cover
// the scene" spreads any affordable drop count into invisible drizzle — at
// 78×44×78 a heavy shower read as about six streaks on screen. The box follows
// the camera, so it only ever has to cover what a lens can actually resolve.
const BOX = new THREE.Vector3(44, 30, 44);

function sharedUniforms() {
  return {
    uBox: { value: BOX.clone() },
    uCam: { value: new THREE.Vector3() },
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector2() },
    uFall: { value: 18 },
    uColor: { value: new THREE.Color('#cfe0ee') },
    uOpacity: { value: 0.5 },
  };
}

export function initWeather(scene, opts = {}) {
  const small = !!opts.small;
  const MAX_RAIN = small ? 2600 : 6000;
  // Flakes need far more than drops for the same read. A drop is a long streak
  // that crosses many pixels; a flake is a dot. At the rain count snow was ~20
  // specks on screen — technically falling, visually a dirty lens. Points are
  // one draw call and these are a handful of pixels each, so the cost of the
  // honest number is nothing.
  const MAX_FLAKE = small ? 6000 : 15000;
  const root = new THREE.Group();
  root.frustumCulled = false;
  scene.add(root);

  // rain: two verts per drop (head + tail)
  const rainGeo = new THREE.BufferGeometry();
  {
    const base = new Float32Array(MAX_RAIN * 2 * 3), end = new Float32Array(MAX_RAIN * 2);
    const r = makeRng('wx:rain');
    for (let i = 0; i < MAX_RAIN; i++) {
      const x = r(), y = r(), z = r();
      for (let v = 0; v < 2; v++) {
        base[(i * 2 + v) * 3] = x; base[(i * 2 + v) * 3 + 1] = y; base[(i * 2 + v) * 3 + 2] = z;
        end[i * 2 + v] = v;
      }
    }
    rainGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_RAIN * 2 * 3), 3));
    rainGeo.setAttribute('aBase', new THREE.BufferAttribute(base, 3));
    rainGeo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    rainGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6); // never cull
  }
  const rainUni = { ...sharedUniforms(), uStreak: { value: 1.6 } };
  const rain = new THREE.LineSegments(rainGeo, new THREE.ShaderMaterial({
    uniforms: rainUni, vertexShader: RAIN_VS, fragmentShader: RAIN_FS,
    transparent: true, depthWrite: false, fog: false,
  }));
  rain.frustumCulled = false;
  rain.visible = false;
  root.add(rain);

  const flakeGeo = new THREE.BufferGeometry();
  {
    const base = new Float32Array(MAX_FLAKE * 3), size = new Float32Array(MAX_FLAKE);
    const r = makeRng('wx:flake');
    for (let i = 0; i < MAX_FLAKE; i++) {
      base[i * 3] = r(); base[i * 3 + 1] = r(); base[i * 3 + 2] = r();
      size[i] = r.range(0.03, 0.085); // metres
    }
    flakeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_FLAKE * 3), 3));
    flakeGeo.setAttribute('aBase', new THREE.BufferAttribute(base, 3));
    flakeGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    flakeGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  }
  const flakeUni = {
    ...sharedUniforms(), uPix: { value: 700 }, uSway: { value: 1.2 }, uScale: { value: 1 },
  };
  const flakes = new THREE.Points(flakeGeo, new THREE.ShaderMaterial({
    uniforms: flakeUni, vertexShader: FLAKE_VS, fragmentShader: FLAKE_FS,
    transparent: true, depthWrite: false, fog: false,
  }));
  flakes.frustumCulled = false;
  flakes.visible = false;
  root.add(flakes);

  /* Lightning reuses the impact-flash idea from fx.js: one PointLight, dark
     most of the time, spiked on a schedule drawn from the weather rng so the
     same seed storms the same way. */
  const bolt = new THREE.PointLight('#dce8ff', 0, 900, 1.4);
  bolt.position.set(0, 120, 0);
  root.add(bolt);

  let wx = null;
  let t = 0;
  let flashT = 0, nextFlash = 0, flashRng = null;
  let budget = 1; // quality-tier multiplier on the particle count (1H)

  // draw-range only, so a tier change costs nothing and needs no rebuild
  function setBudget(b) {
    budget = clamp(b == null ? 1 : b, 0, 1);
    if (wx) set(wx);
  }

  function set(w) {
    wx = w;
    rain.visible = false;
    flakes.visible = false;
    bolt.intensity = 0;
    if (!w) return;
    const p = w.precip;
    const wd = new THREE.Vector2(Math.cos(w.wind.dir), Math.sin(w.wind.dir)).multiplyScalar(w.wind.speed);
    if (p === 'rain') {
      const n = Math.round(MAX_RAIN * (0.25 + 0.75 * w.intensity) * budget);
      rainGeo.setDrawRange(0, n * 2);
      rainUni.uWind.value.copy(wd);
      rainUni.uFall.value = 26 + 22 * w.intensity;
      rainUni.uStreak.value = 1.3 + 2.6 * w.intensity;
      rainUni.uOpacity.value = 0.34 + 0.42 * w.intensity;
      rainUni.uColor.value.set('#cfe0ee');
      rain.visible = true;
    } else if (p === 'snow' || p === 'dust') {
      const n = Math.round(MAX_FLAKE * (0.3 + 0.7 * w.intensity) * budget);
      flakeGeo.setDrawRange(0, n);
      flakeUni.uWind.value.copy(wd);
      const snow = p === 'snow';
      flakeUni.uFall.value = snow ? 2.6 + 2.4 * w.intensity : 1.2;
      flakeUni.uSway.value = snow ? 1.4 : 2.6;
      // dust is fine grit, not flakes — but it still has to be SEEN. The bulk
      // of a dust storm is the tan haze on the fog; these are the grains
      // crossing it, and at half scale / a third alpha they vanished entirely.
      flakeUni.uScale.value = snow ? 1 : 0.62;
      flakeUni.uOpacity.value = snow ? 0.72 : 0.5;
      flakeUni.uColor.value.set(snow ? '#f2f7ff' : '#c8ab7c');
      flakes.visible = true;
    }
    if (w.lightning) {
      flashRng = makeRng('wx:bolt:' + w.kind + ':' + w.wind.dir.toFixed(4));
      nextFlash = flashRng.range(1.5, 6);
      flashT = 0;
    } else {
      flashRng = null;
    }
  }

  /* paused: the freeze stops the sim's clock, so hanging rain is the correct
     fiction AND it lets render-on-demand sleep through the longest UI phase.
     Animated weather would otherwise defeat needsRender for the entire study
     period, which is exactly when the player wants a steady frame to read. */
  function update(dt, camera, paused) {
    if (!wx) return false;
    const active = rain.visible || flakes.visible || !!flashRng;
    if (!active) return false;
    if (paused) return false;
    t += dt;
    rainUni.uTime.value = t; flakeUni.uTime.value = t;
    rainUni.uCam.value.copy(camera.position);
    flakeUni.uCam.value.copy(camera.position);
    if (flashRng) {
      flashT += dt;
      if (flashT >= nextFlash) {
        flashT = 0;
        nextFlash = flashRng.range(2.5, 9);
        bolt.intensity = flashRng.range(900, 2100);
        bolt.position.set(flashRng.range(-160, 160), flashRng.range(90, 190), flashRng.range(-160, 160));
      } else {
        bolt.intensity *= Math.max(0, 1 - dt * 11); // fast decay, no lingering glow
        if (bolt.intensity < 1) bolt.intensity = 0;
      }
    }
    return true;
  }

  // the projection scale that turns a world size into pixels: h / (2 tan(fov/2)).
  // Guarded because resize() legitimately runs against a 0-height stage (the
  // browser pane never fires its ResizeObserver, so boot's measurement is the
  // only one) and uPix 0 collapses every flake to the 1 px floor.
  function setPixelScale(h, fovDeg = 50) {
    if (!(h > 0)) return;
    flakeUni.uPix.value = h / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  function dispose() {
    scene.remove(root);
    rainGeo.dispose(); rain.material.dispose();
    flakeGeo.dispose(); flakes.material.dispose();
  }

  return { set, setBudget, update, setPixelScale, dispose, get wx() { return wx; } };
}
