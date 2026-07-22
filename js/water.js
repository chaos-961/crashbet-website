// water.js — the basin and the surface on it. Strictly render-side, exactly
// like terrain.js, weather.js and vegetation.js: it reads nothing from the sim
// and writes nothing back. The sim carves its own basin out of the ground
// collider and runs the buoyancy (physics._stepWater); this draws what that
// hole looks like. Opt-in with null, so a scenario without world.water pays
// nothing and no pinned hash can move because of anything in here.
//
// Four decisions worth keeping:
//
// 1. MeshStandardMaterial + onBeforeCompile, NOT a raw ShaderMaterial. Water
//    has to sit in the same lighting, ACES tone map, fog and shadow pipeline as
//    everything else, and a raw shader means re-implementing all four and then
//    watching them drift apart the moment weather touches exposure. Injecting
//    into the standard material buys the whole chain for free and costs only
//    knowing which chunk to replace.
//
// 2. The plane is pre-rotated into world space (geometry.rotateX) rather than
//    the mesh being rotated. Wave math is then plain world XZ: displace
//    transformed.y, write objectNormal, done. Rotating the mesh instead means
//    every wind term needs an axis swap and the analytic normal has to be
//    un-rotated before it is handed back.
//
// 3. The banks stay VERTICAL. The sim's land slabs are vertical walls, so a
//    sloped visual bank promises a beach the physics will not honour and a car
//    finds an invisible wall halfway down it. Riprap is what real causeways and
//    embankments actually use, so an armoured vertical edge is not a compromise
//    — it is the correct answer that also happens to be the legal one.
//
// 4. The silt bed displaces DOWNWARD ONLY. The bed collider's top face is
//    exactly `bed`, so any upward displacement buries a settled wreck in
//    visual silt — the one thing a player is looking at when a car sinks.
import * as THREE from 'three';
import { makeRng, mergeByMaterial } from './lib.js';

/* Per-environment palettes. Water takes its colour from the place and the sky
   above it — a night causeway under a bright blue channel reads as a texture
   swap, not as water. `sky` is only a fallback: env passes the live hazed
   horizon in, so the fresnel rim matches whatever weather is doing. */
const WATER_PRESETS = {
  proving: { deep: '#1d3c50', shallow: '#3f7383', silt: '#3a3f3c', rock: '#4c4f55', foam: '#dfe9ee' },
  salt:    { deep: '#2a4a52', shallow: '#6f9a97', silt: '#6d6653', rock: '#8b8168', foam: '#f2ece0' },
  night:   { deep: '#0a141f', shallow: '#16303f', silt: '#171b20', rock: '#23262c', foam: '#5f7285' },
  grid:    { deep: '#16222c', shallow: '#26414f', silt: '#232830', rock: '#2e3239', foam: '#9fb0bc' },
  city:    { deep: '#22333d', shallow: '#48646d', silt: '#33383a', rock: '#4a4e54', foam: '#d2dade' },
  // 1F. The fresnel rim takes the live hazed horizon, so these only have to be
  // right for the water's own body colour — the sky half looks after itself.
  dawn:    { deep: '#1c2a3e', shallow: '#4a5f72', silt: '#33352f', rock: '#4a4a4c', foam: '#e8d8c8' },
  dusk:    { deep: '#231d33', shallow: '#54455c', silt: '#332d30', rock: '#463c42', foam: '#e6c0aa' },
  alpine:  { deep: '#123a4e', shallow: '#3f8a9c', silt: '#4a5058', rock: '#6d747c', foam: '#f4fafd' },
  coastal: { deep: '#12455c', shallow: '#4fa0a8', silt: '#8a7f63', rock: '#8d8570', foam: '#f2f6f2' },
  desert:  { deep: '#26404a', shallow: '#5b8a86', silt: '#8a7350', rock: '#9b8461', foam: '#f0e4cc' },
  suburb:  { deep: '#1c3e4a', shallow: '#48808a', silt: '#4a4a3c', rock: '#5c5c50', foam: '#e8f0f2' },
};
export const waterPreset = (id) => WATER_PRESETS[id] || WATER_PRESETS.proving;

/* ---------------- surface shader ----------------
   Injected into meshphysical. The wave sum has to land in <beginnormal_vertex>
   rather than <begin_vertex>: three computes vNormal from objectNormal in
   <normal_vertex>, which runs BEFORE <begin_vertex>, so a normal written
   alongside the displacement is a frame late and the surface lights flat.
   Height is carried across in a global and applied in <begin_vertex>. */
const V_HEAD = /* glsl */`
  uniform float uTime;
  uniform vec2  uWind;
  uniform float uAmp;
  uniform vec2  uHalf;
  varying float vShore;
  varying float vH;
  varying vec2  vXZ;
  float wH_ = 0.0;
`;

// One wave: phase from direction·position, height into wH_, analytic gradient
// into g so the normal is exact rather than finite-differenced.
const V_WAVE = /* glsl */`
  #define WWAVE(D, K, A, S) { float ph = dot(D, wxz) * K + uTime * S; wH_ += amp * A * sin(ph); g += D * amp * A * K * cos(ph); }
`;

const V_NORMAL = /* glsl */`
  vec3 objectNormal = vec3( normal );
  vec2 wxz = position.xz;
  // distance to the nearest bank, normalised — 0 at the wall, 1 offshore
  vec2 e = 1.0 - abs(wxz) / max(uHalf, vec2(0.001));
  vShore = clamp(min(e.x, e.y), 0.0, 1.0);
  // waves flatten into the shallows; a full-amplitude crest at the wall reads
  // as the water climbing the rock and then clipping through it
  float amp = uAmp * (0.22 + 0.78 * smoothstep(0.0, 0.18, vShore));
  vec2 d0 = uWind;
  vec2 d1 = vec2(d0.y, -d0.x);
  vec2 d2 = normalize(d0 * 2.0 + d1);
  vec2 d3 = normalize(d0 - d1 * 1.7);
  vec2 g = vec2(0.0);
  WWAVE(d0, 0.42, 1.00, 0.85)
  WWAVE(d2, 0.83, 0.52, 1.35)
  WWAVE(d3, 1.60, 0.26, 2.10)
  WWAVE(d1, 3.10, 0.11, 3.20)
  objectNormal = normalize(vec3(-g.x, 1.0, -g.y));
  vH = wH_;
  vXZ = wxz;
`;

const F_HEAD = /* glsl */`
  uniform float uTime;
  uniform vec2  uWind;
  uniform float uAmp;
  uniform vec3  uDeep;
  uniform vec3  uShallow;
  uniform vec3  uFoamCol;
  uniform vec3  uSky;
  uniform float uFoam;
  varying float vShore;
  varying float vH;
  varying vec2  vXZ;
  float wHash(vec2 p){ return fract(sin(dot(p, vec2(41.31, 289.07))) * 43758.5453); }
  float wNoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), u.x),
               mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
`;

// Injected after <normal_fragment_maps>: `normal` is the shading normal in view
// space by then, and diffuseColor/roughnessFactor are still upstream of
// <lights_physical_fragment>, so one injection point covers colour, foam,
// alpha, roughness and the fresnel rim.
const F_BODY = /* glsl */`
  vec3 wCol = mix(uShallow, uDeep, smoothstep(0.0, 0.42, vShore));
  float wN = wNoise(vXZ * 0.6 - uWind * uTime * 0.55);
  // two foam sources: the standing band where water meets rock, and the tops
  // of the waves themselves once there is enough amplitude to break
  float wEdge = 1.0 - smoothstep(0.0, 0.085, vShore);
  float wCrest = smoothstep(uAmp * 0.34, uAmp * 0.92, vH);
  float wFoam = clamp((wEdge * (0.5 + 0.5 * wN) + wCrest * wN * 0.55) * uFoam, 0.0, 1.0);
  vec3 wV = normalize( vViewPosition );
  float wFres = pow(1.0 - clamp(dot(wV, normal), 0.0, 1.0), 4.0);
  wCol = mix(wCol, uSky, wFres * 0.7 * (1.0 - wFoam));
  wCol = mix(wCol, uFoamCol, wFoam);
  diffuseColor.rgb = wCol;
  // shallows show the bed, deep water hides it, and grazing angles go opaque
  diffuseColor.a = clamp(mix(0.58, 0.93, smoothstep(0.0, 0.3, vShore)) + wFres * 0.32 + wFoam * 0.5, 0.0, 1.0);
  roughnessFactor = mix(0.055, 0.62, wFoam);
`;

function surfaceMaterial(pal, sky) {
  const uni = {
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector2(1, 0) },
    uAmp: { value: 0.06 },
    uHalf: { value: new THREE.Vector2(1, 1) },
    uDeep: { value: new THREE.Color(pal.deep) },
    uShallow: { value: new THREE.Color(pal.shallow) },
    uFoamCol: { value: new THREE.Color(pal.foam) },
    uSky: { value: new THREE.Color(sky || '#b6cbd9') },
    uFoam: { value: 1 },
  };
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.1, metalness: 0.02,
    transparent: true,
    // a sunk car is the thing the player is watching; writing depth here would
    // let the surface occlude it from any camera above the waterline
    depthWrite: false,
  });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uni);
    sh.vertexShader = V_HEAD + V_WAVE + sh.vertexShader
      .replace('#include <beginnormal_vertex>', V_NORMAL)
      .replace('#include <begin_vertex>', 'vec3 transformed = vec3( position );\n  transformed.y += wH_;');
    sh.fragmentShader = F_HEAD + sh.fragmentShader
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + F_BODY);
  };
  mat.userData.uni = uni;
  return mat;
}

/* ---------------- punching the hole ----------------
   The sim carves its basin out of the GROUND COLLIDER — four land slabs around
   a rectangular hole, plus a bed. Nothing ever carved it out of the visual
   ground, so the flat y=0 surface ran straight over the top of the channel and
   the water at y=-0.8 was drawn entirely behind it. Measured on seed w5: with
   the terrain hidden the surface covers 72% of the frame, and with it visible,
   exactly 0. The basin has been invisible in every generated causeway.

   Punching it in the FRAGMENT shader rather than in the geometry is deliberate.
   The landscape is a polar mesh and the basin is an axis-aligned rect, so a
   geometric carve lands a ragged boundary that then has to be hidden by
   outsetting the walls — a shoreline a metre or two off from where the physics
   says the edge is, which is exactly the class of lie that makes a scene feel
   wrong. A rect test per pixel is exact, straight, needs no retessellation and
   costs one compare. Terrain does not cast shadows (terrain.js:348), so there
   is no depth-material variant to keep in step.

   Opt-in with null like everything else here: no basin, uPunchOn stays 0, and
   the branch never discards. */
const PUNCH_V = `
  varying vec3 vPunchW;
`;
const PUNCH_F = `
  uniform vec4 uPunch;    // x0, x1, z0, z1
  uniform float uPunchOn;
  varying vec3 vPunchW;
`;

export function punchBasin(material, spec) {
  if (!material) return;
  const u = material.userData.punch || (material.userData.punch = {
    uPunch: { value: new THREE.Vector4(0, 0, 0, 0) },
    uPunchOn: { value: 0 },
  });
  if (spec) {
    u.uPunch.value.set(spec.x0, spec.x1, spec.z0, spec.z1);
    u.uPunchOn.value = 1;
  } else {
    u.uPunchOn.value = 0;
  }
  if (material.userData.punchWired) return;
  material.userData.punchWired = true;
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (sh, renderer) => {
    if (prev) prev(sh, renderer);
    Object.assign(sh.uniforms, u);
    sh.vertexShader = PUNCH_V + sh.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vPunchW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
    );
    sh.fragmentShader = PUNCH_F + sh.fragmentShader.replace(
      'void main() {',
      'void main() {\n  if ( uPunchOn > 0.5 && vPunchW.x > uPunch.x && vPunchW.x < uPunch.y && vPunchW.z > uPunch.z && vPunchW.z < uPunch.w ) discard;',
    );
  };
  material.needsUpdate = true;
}

/* ---------------- basin shell ----------------
   Vertical rock walls, a silt bed and a run of riprap along the waterline. All
   vertex-coloured under one material each so the whole basin is three draw
   calls however big it gets — and the riprap merges, because a hundred loose
   boulders would otherwise be a hundred of them. */
function shadeGeo(geo, base, fn) {
  const p = geo.attributes.position;
  const col = new Float32Array(p.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    c.copy(base);
    fn(c, p.getX(i), p.getY(i), p.getZ(i), i);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

function buildBanks(spec, pal, r) {
  const g = new THREE.Group();
  const hx = (spec.x1 - spec.x0) / 2, hz = (spec.z1 - spec.z0) / 2;
  const bed = spec.bed;
  const top = 0; // the land slabs' top face — the wall runs from grade to bed
  const depth = top - bed;
  const rock = new THREE.Color(pal.rock);

  // Walls. Two segments vertically so the shading can darken with depth, which
  // is most of what makes the hole read as deep rather than as a dark rectangle.
  const wallMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.94, metalness: 0 });
  const wall = new THREE.Group();
  const mkWall = (w, px, pz, ry) => {
    const geo = new THREE.PlaneGeometry(w, depth, Math.max(2, Math.round(w / 6)), 3);
    shadeGeo(geo, rock, (c, x, y) => {
      // y runs +depth/2 (grade) to -depth/2 (bed)
      const t = 0.5 - y / depth; // 0 at grade, 1 at the bed
      c.multiplyScalar(1 - t * 0.55).offsetHSL(0, 0, (r() - 0.5) * 0.035);
    });
    const m = new THREE.Mesh(geo, wallMat);
    m.position.set(px, bed + depth / 2, pz);
    m.rotation.y = ry;
    m.receiveShadow = true;
    wall.add(m);
  };
  mkWall(hx * 2, 0, -hz, 0);
  mkWall(hx * 2, 0, hz, Math.PI);
  mkWall(hz * 2, -hx, 0, Math.PI / 2);
  mkWall(hz * 2, hx, 0, -Math.PI / 2);
  // four static planes sharing one material — one draw call, and safe to merge
  // only because bakeMerged now carries an existing colour attribute through
  mergeByMaterial(wall);
  g.add(wall);

  // Silt bed. Downward-only displacement (see the header) and a subdivision
  // coarse enough that it stays one cheap mesh on a 120 m basin.
  const fs = new THREE.PlaneGeometry(hx * 2, hz * 2, Math.min(40, Math.max(4, Math.round(hx / 3))), Math.min(40, Math.max(4, Math.round(hz / 3))));
  fs.rotateX(-Math.PI / 2);
  const fp = fs.attributes.position;
  for (let i = 0; i < fp.count; i++) {
    const x = fp.getX(i), z = fp.getZ(i);
    const edge = Math.min(1 - Math.abs(x) / hx, 1 - Math.abs(z) / hz);
    // pinned at the walls so silt never leaves a gap where bed meets rock
    if (edge > 0.02) fp.setY(i, -r() * 0.26 * Math.min(1, edge * 4));
  }
  fs.computeVertexNormals();
  shadeGeo(fs, new THREE.Color(pal.silt), (c, x, y) => c.multiplyScalar(1 + y * 0.5).offsetHSL(0, 0, (r() - 0.5) * 0.03));
  const floor = new THREE.Mesh(fs, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.98, metalness: 0 }));
  floor.position.set(0, bed, 0);
  floor.receiveShadow = true;
  g.add(floor);

  // Riprap. Boulders hugging the wall through the waterline — the band the eye
  // actually lands on, and the thing that stops a vertical wall reading as a
  // cut. They protrude INTO the basin only: that side is the hole, so nothing
  // drives there, and the drivable grade above stays exactly as flat as the
  // collider says it is.
  const rip = new THREE.Group();
  const ripMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  const band = Math.min(depth * 0.75, 2.4);
  const run = (len, px, pz, nx, nz) => {
    const step = 1.5;
    const n = Math.max(2, Math.floor(len / step));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n - 0.5;
      const along = t * len + (r() - 0.5) * step * 0.7;
      const s = r.range(0.5, 1.25);
      const geo = new THREE.BoxGeometry(s, s * 0.8, s * 0.9);
      shadeGeo(geo, rock, (c) => c.offsetHSL(0, (r() - 0.5) * 0.03, (r() - 0.5) * 0.09));
      const m = new THREE.Mesh(geo, ripMat);
      const inward = 0.16 + r() * 0.42;
      m.position.set(
        px + (pz === 0 ? 0 : along) + nx * inward,
        spec.y + (r() - 0.5) * band,
        pz + (px === 0 ? along : 0) + nz * inward,
      );
      m.rotation.set((r() - 0.5) * 0.5, r() * Math.PI, (r() - 0.5) * 0.5);
      m.castShadow = m.receiveShadow = true;
      rip.add(m);
    }
  };
  run(hx * 2, 0, -hz, 0, 1);
  run(hx * 2, 0, hz, 0, -1);
  run(hz * 2, -hx, 0, 1, 0);
  run(hz * 2, hx, 0, -1, 0);
  mergeByMaterial(rip);
  g.add(rip);
  return g;
}

/* ---------------- public ----------------
   spec: { y, x0, x1, z0, z1, bed? } — the same object the sim reads, so the
   surface and the buoyancy can never disagree about where the water is. */
export function buildWater(spec, opts = {}) {
  const s = {
    y: spec.y, x0: spec.x0, x1: spec.x1, z0: spec.z0, z1: spec.z1,
    bed: spec.bed == null ? spec.y - 3.5 : spec.bed,
  };
  const pal = { ...waterPreset(opts.env), ...(opts.palette || {}) };
  const wx = s.x1 - s.x0, wz = s.z1 - s.z0;
  const cx = (s.x0 + s.x1) / 2, cz = (s.z0 + s.z1) / 2;
  const group = new THREE.Group();
  group.position.set(cx, 0, cz);

  // deterministic, and keyed on the basin so the same channel always gets the
  // same boulders — a scene that re-deals its rocks on every visit is a tell
  const r = makeRng('water:' + s.x0 + ':' + s.z0 + ':' + wx + ':' + wz);
  group.add(buildBanks({ ...s, x0: -wx / 2, x1: wx / 2, z0: -wz / 2, z1: wz / 2 }, pal, r));

  // ~1 segment per 2 m, capped. Worst case is 64x64 = 8k triangles, which is
  // 4% of what the vegetation ring costs — this never needed a quality tier.
  const sx = Math.min(64, Math.max(8, Math.round(wx / 2)));
  const sz = Math.min(64, Math.max(8, Math.round(wz / 2)));
  const geo = new THREE.PlaneGeometry(wx, wz, sx, sz);
  geo.rotateX(-Math.PI / 2);
  const mat = surfaceMaterial(pal, opts.sky);
  mat.userData.uni.uHalf.value.set(wx / 2, wz / 2);
  const surf = new THREE.Mesh(geo, mat);
  surf.position.y = s.y;
  surf.receiveShadow = true;
  surf.renderOrder = 2;
  group.add(surf);

  const uni = mat.userData.uni;
  let t = 0;

  return {
    group,
    spec: s,
    /* Weather drives the sea state. A storm has to churn or the rain is
       falling on a mirror — the single most obvious way water breaks the
       fiction the rest of the scene is selling. */
    setWeather(w, sky) {
      const speed = w && w.wind ? w.wind.speed : 2;
      const dir = w && w.wind ? w.wind.dir : 0;
      uni.uWind.value.set(Math.cos(dir), Math.sin(dir));
      uni.uAmp.value = Math.min(0.34, 0.025 + speed * 0.036);
      uni.uFoam.value = Math.min(1.35, 0.55 + speed * 0.12);
      if (sky) uni.uSky.value.set(sky);
      // wet weather flattens the specular sky and greys the water with it
      const cloud = w ? w.cloudCover || 0 : 0;
      uni.uDeep.value.set(pal.deep).multiplyScalar(1 - cloud * 0.3);
      uni.uShallow.value.set(pal.shallow).multiplyScalar(1 - cloud * 0.26);
    },
    tick(dt) {
      t += dt;
      uni.uTime.value = t;
      return true;
    },
    // is the camera under the surface AND inside the hole? Both halves matter:
    // above the bank the same y is a perfectly dry patch of grass.
    isUnder(p) {
      return p.y < s.y && p.x > s.x0 && p.x < s.x1 && p.z > s.z0 && p.z < s.z1;
    },
    dispose() {
      group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    },
  };
}
