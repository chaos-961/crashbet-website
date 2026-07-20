// terrain.js — procedural landscape around the play area. Purely visual:
// nothing here may influence the simulation. Opt-in exactly like world.water —
// absent spec, no mesh, no cost, and every sim pin is untouched by construction.
//
// The shape of the thing: ONE polar mesh, not a near disc plus a distant ring.
// Displacement is masked to zero inside playR, so the drivable area stays flat
// and coplanar with the physics slab — terrain can never intrude on a lane, and
// there is no seam to hide because the mask reaches 0 exactly at the boundary.
//
//   h(r) = noise(x, z) * smoothstep(playR, playR * 1.35, r)
//
// Non-indexed + computeVertexNormals() per house convention, which is what
// gives the faceted low-poly read for free. Vertex colours rather than any
// texture: one MeshStandardMaterial, one draw call, no texture memory, and
// faceted shading suits flat-blended vertex colour better than any tiling map.
import * as THREE from 'three';

/* ---------------- integer-hash value noise ----------------
   Seeded, allocation-free and cheap enough to run per vertex several times.
   Not used by the sim, so plain float math is fine here — the only promise is
   that the same seed draws the same landscape. */
function hash2i(x, z, s) {
  let h = (s ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function vnoise(x, z, s) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const fx = x - x0, fz = z - z0;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash2i(x0, z0, s), b = hash2i(x0 + 1, z0, s);
  const c = hash2i(x0, z0 + 1, s), d = hash2i(x0 + 1, z0 + 1, s);
  return (a + (b - a) * ux) * (1 - uz) + (c + (d - c) * ux) * uz;
}

// fbm; `ridge` folds each octave about its midpoint (1 - |2n-1|) and squares
// it, which is what turns rounded blobs into crests with sharp tops.
function fbm(x, z, s, oct, lac, gain, ridge) {
  let sum = 0, amp = 1, norm = 0, fx = x, fz = z;
  for (let i = 0; i < oct; i++) {
    let n = vnoise(fx, fz, (s + i * 1013) >>> 0);
    if (ridge) { n = 1 - Math.abs(n * 2 - 1); n *= n; }
    sum += n * amp; norm += amp;
    amp *= gain; fx *= lac; fz *= lac;
  }
  return sum / norm;
}

const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/* ---------------- presets ----------------
   `profile` reshapes the [0,1] fbm before it is scaled by amp — this is where
   a preset gets its silhouette. Dunes want a soft sine swell, mesa wants
   terraces, alpine wants the ridge noise pushed steeper still. Palette stops
   run low → high; `rock` wins on slope, `snow` caps height on gentle faces. */
// Amplitudes are set against the world's actual scale, not real-world ones.
// The play area is ~90–170 m and the sky dome is 430 m, so "hills" only read as
// hills between roughly 30 m and 120 m tall — at 20 m a ridge 400 m out subtends
// almost nothing and the whole ring renders as a flat wash.
export const TERRAINS = {
  alpine: {
    amp: 105, freq: 0.0062, oct: 4, lac: 2.03, gain: 0.48, ridge: true, warp: 46,
    profile: (n) => Math.pow(n, 1.35),
    low: '#4a5340', mid: '#5c6349', high: '#6d6b5c',
    rock: '#6a6660', scree: '#7d7a72', snow: '#e8ecf1',
    snowAt: 0.54, snowSlope: 0.62, slopeRock: 0.40,
  },
  mesa: {
    amp: 62, freq: 0.0052, oct: 4, lac: 2.11, gain: 0.44, ridge: false, warp: 30,
    // terraces: quantise, then blend part of the way back so the steps read as
    // strata rather than a staircase
    profile: (n) => lerp(n, Math.round(n * 5) / 5, 0.62),
    low: '#8a6247', mid: '#9c6f4c', high: '#b08359',
    rock: '#7d543c', scree: '#a67a55', snow: null,
    snowAt: 1, snowSlope: 0, slopeRock: 0.34,
  },
  dunes: {
    amp: 30, freq: 0.0072, oct: 3, lac: 2.0, gain: 0.5, ridge: false, warp: 62,
    profile: (n) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(n)),
    low: '#c2ab7e', mid: '#d2bc8e', high: '#e0cda3',
    rock: '#b09a72', scree: '#cbb586', snow: null,
    snowAt: 1, snowSlope: 0, slopeRock: 0.62,
  },
  coastal: {
    amp: 40, freq: 0.0058, oct: 4, lac: 2.05, gain: 0.47, ridge: false, warp: 34,
    profile: (n) => Math.pow(n, 1.5),
    low: '#8d8563', mid: '#5f6b48', high: '#6b7052',
    rock: '#6f6a60', scree: '#93917f', snow: null,
    snowAt: 1, snowSlope: 0, slopeRock: 0.44,
    shore: '#c8bb95', shoreTo: 3.2, // damp sand band just above the waterline
  },
  rolling: {
    amp: 34, freq: 0.0049, oct: 3, lac: 2.0, gain: 0.5, ridge: false, warp: 28,
    profile: (n) => n,
    low: '#59653f', mid: '#657049', high: '#727a54',
    rock: '#6d685e', scree: '#8a8672', snow: null,
    snowAt: 1, snowSlope: 0, slopeRock: 0.52,
  },
  flats: {
    amp: 11, freq: 0.0041, oct: 3, lac: 2.0, gain: 0.52, ridge: false, warp: 18,
    profile: (n) => n,
    low: '#87826c', mid: '#918c76', high: '#9c9781',
    rock: '#847f6d', scree: '#a09b87', snow: null,
    snowAt: 1, snowSlope: 0, slopeRock: 0.7,
  },
  basin: {
    // the bowl comes from `rise`, not the noise — see heightAt
    amp: 55, freq: 0.0055, oct: 4, lac: 2.07, gain: 0.46, ridge: true, warp: 38,
    profile: (n) => Math.pow(n, 1.2),
    low: '#6e6350', mid: '#7a6d57', high: '#8a7c63',
    rock: '#6b6152', scree: '#948873', snow: null,
    snowAt: 1, snowSlope: 0, slopeRock: 0.38,
    rise: 0.85, // extra height proportional to distance — walls you sit inside
  },
};
export const TERRAIN_IDS = Object.keys(TERRAINS);
export const isTerrain = (id) => Object.prototype.hasOwnProperty.call(TERRAINS, id);

// which landscape suits which environment preset, when a scene doesn't say
export const TERRAIN_FOR_ENV = {
  proving: 'rolling', salt: 'flats', night: 'rolling', grid: 'flats',
};

const RIDGE_AT = 255;   // distant band starts lifting here…
const RIDGE_FULL = 415; // …and is at full boost by here, still inside SKY_R 430
const RIDGE_BOOST = 2.6; // ×3.6 at the far edge — enough to break the skyline

/* ---------------- height field ----------------
   Returns a closure rather than a bare function so callers (vegetation scatter,
   bridge piers, anything that needs to sit ON the landscape) can query the same
   surface the mesh was built from instead of re-deriving it. */
export function makeHeightField(spec) {
  const p = TERRAINS[spec.preset] || TERRAINS.rolling;
  const playR = spec.playR || 90;
  const rampTo = playR * 1.35;
  // 32-bit seed from the string, so two scenes never share a landscape
  let s = 2166136261 >>> 0;
  const str = 'ter:' + (spec.seed == null ? '' : spec.seed);
  for (let i = 0; i < str.length; i++) { s ^= str.charCodeAt(i); s = Math.imul(s, 16777619) >>> 0; }
  const sw1 = (s + 0x9e37) >>> 0, sw2 = (s + 0x85eb) >>> 0;

  function heightAt(x, z) {
    const r = Math.sqrt(x * x + z * z);
    const mask = smoothstep(playR, rampTo, r);
    if (mask <= 0) return 0;
    // domain warp — without it ridgelines run along the noise grid and read as
    // corduroy; with it they meander like real ones
    const wx = (fbm(x * p.freq * 0.7, z * p.freq * 0.7, sw1, 2, 2, 0.5, false) - 0.5) * p.warp;
    const wz = (fbm(x * p.freq * 0.7 + 5.2, z * p.freq * 0.7 + 1.3, sw2, 2, 2, 0.5, false) - 0.5) * p.warp;
    const n = fbm((x + wx) * p.freq, (z + wz) * p.freq, s, p.oct, p.lac, p.gain, p.ridge);
    let h = p.profile(clamp01(n)) * p.amp;
    if (p.rise) h += (r - playR) * p.rise * 0.06 * mask;
    // distant band: bias tall so something silhouettes against the dome
    h *= 1 + smoothstep(RIDGE_AT, RIDGE_FULL, r) * RIDGE_BOOST;
    return h * mask;
  }

  return { heightAt, preset: p, playR, rampTo, id: spec.preset };
}

/* ---------------- mesh ----------------
   Polar grid: `spokes` around, `rings` outward. Radial spacing is deliberately
   NOT uniform — u^1.7 packs rings into the band just outside playR where the
   mask is ramping and the eye actually is, and lets the far field coarsen.

   r0 > 0 builds an annulus, which is what Phase 1 wants: the existing flat
   ground disc still owns everything inside playR, the mask puts terrain at
   exactly y=0 where they meet, so there is no overlap to z-fight and no step
   to see. When 1F makes the terrain BE the ground, r0 goes to 0. */
export function buildTerrain(spec, opts = {}) {
  const field = makeHeightField(spec);
  const { horizon = '#a9bcc9', small = false } = opts;
  const spokes = small ? 96 : 128;
  const rings = small ? 72 : 96;
  const r0 = spec.r0 == null ? field.playR : spec.r0;
  const r1 = spec.outerR || 420;
  const p = field.preset;

  // radii, packed toward the inner edge
  const rad = new Float64Array(rings + 1);
  for (let j = 0; j <= rings; j++) rad[j] = r0 + (r1 - r0) * Math.pow(j / rings, 1.7);

  // sample the grid once; slope then comes from neighbours for free rather
  // than from four extra noise evaluations per vertex
  const H = new Float64Array((rings + 1) * spokes);
  const PX = new Float64Array((rings + 1) * spokes);
  const PZ = new Float64Array((rings + 1) * spokes);
  // Every vertex on ring j sharing one radius makes height contours line up
  // with the rings, and flat shading turns that into concentric stripes down
  // every hillside. Jittering each vertex within its own cell breaks the
  // lattice into something organic without changing the topology — the quad
  // (j,i)-(j,i+1)-(j+1,i)-(j+1,i+1) stays well formed as long as the offset
  // stays under half a cell. Ring 0 is pinned: it has to meet the ground disc.
  const dA = (Math.PI * 2) / spokes;
  for (let j = 0; j <= rings; j++) {
    const gap = j < rings ? rad[j + 1] - rad[j] : rad[j] - rad[j - 1];
    const edge = Math.min(1, j / 3); // ease the jitter in off the inner rim
    for (let i = 0; i < spokes; i++) {
      const jr = (hash2i(i, j, 0x5bf03635) - 0.5) * gap * 0.7 * edge;
      const ja = (hash2i(i, j, 0x1b873593) - 0.5) * dA * 0.7 * edge;
      const a = i * dA + ja, rr = rad[j] + jr;
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      const k = j * spokes + i;
      PX[k] = x; PZ[k] = z; H[k] = field.heightAt(x, z);
    }
  }

  // slope at a grid node: radial and tangential differences, in world units
  function slopeAt(j, i) {
    const jm = Math.max(0, j - 1), jp = Math.min(rings, j + 1);
    const im = (i - 1 + spokes) % spokes, ip = (i + 1) % spokes;
    const dr = Math.max(0.001, rad[jp] - rad[jm]);
    const dh = H[jp * spokes + i] - H[jm * spokes + i];
    const dt = Math.max(0.001, rad[j] * (Math.PI * 4 / spokes));
    const dth = H[j * spokes + ip] - H[j * spokes + im];
    return Math.sqrt((dh / dr) * (dh / dr) + (dth / dt) * (dth / dt));
  }

  const cLow = new THREE.Color(p.low), cMid = new THREE.Color(p.mid), cHigh = new THREE.Color(p.high);
  const cRock = new THREE.Color(p.rock), cScree = new THREE.Color(p.scree);
  const cSnow = p.snow ? new THREE.Color(p.snow) : null;
  const cShore = p.shore ? new THREE.Color(p.shore) : null;
  const cHaze = new THREE.Color(horizon);
  // The ground disc is still its own mesh in Phase 1, so without this the
  // landscape meets it as a hard colour edge and the play area reads as a grey
  // coin dropped on grass. Fading the terrain out of the disc's own outer
  // colour over the first `blendR` metres makes the apron give way to the
  // country instead. (1F removes the seam properly by deleting the disc.)
  const cBlend = opts.blend ? new THREE.Color(opts.blend) : null;
  const blendR = opts.blendR == null ? 95 : opts.blendR;
  // Baked vertex colours cannot respond to the lighting rig the way a lit
  // surface does, so under the night preset a daylight-green hillside stayed
  // daylight green next to a properly dark sky. One authored multiplier per
  // environment, applied last — see TERRAIN_VALUE in env.js.
  const value = opts.value == null ? 1 : opts.value;
  const tmp = new THREE.Color();
  const peak = Math.max(1, p.amp * 1.2);

  // colour for one grid node, written into out[0..2]
  function colorAt(j, i, out) {
    const k = j * spokes + i;
    const h = H[k], sl = slopeAt(j, i);
    const t = clamp01(h / peak);
    tmp.copy(cLow);
    if (t < 0.5) tmp.lerpColors(cLow, cMid, t / 0.5);
    else tmp.lerpColors(cMid, cHigh, (t - 0.5) / 0.5);
    // scree collects on middling slopes, bare rock takes over on steep ones
    tmp.lerp(cScree, clamp01((sl - p.slopeRock * 0.55) / 0.5) * 0.55);
    tmp.lerp(cRock, clamp01((sl - p.slopeRock) / 0.55));
    if (cSnow && t > p.snowAt) {
      // snow does not stick to cliffs
      const cover = smoothstep(p.snowAt, Math.min(1, p.snowAt + 0.22), t) * (1 - smoothstep(p.snowSlope, p.snowSlope + 0.5, sl));
      tmp.lerp(cSnow, clamp01(cover));
    }
    if (cShore) tmp.lerp(cShore, 1 - smoothstep(0, p.shoreTo, h));
    const d = Math.sqrt(PX[k] * PX[k] + PZ[k] * PZ[k]);
    if (cBlend) tmp.lerp(cBlend, 1 - smoothstep(r0, r0 + blendR, d));
    // aerial perspective — the far band desaturates toward the sky it sits
    // against, which is most of what sells distance in a fogged scene. Kept
    // well under half: at 0.62 the ridges washed out into the dome entirely.
    tmp.lerp(cHaze, smoothstep(200, 470, d) * 0.44);
    out[0] = tmp.r * value; out[1] = tmp.g * value; out[2] = tmp.b * value;
  }

  const quads = rings * spokes;
  const pos = new Float32Array(quads * 18); // 2 tris × 3 verts × 3 floats
  const col = new Float32Array(quads * 18);
  const c00 = [0, 0, 0], c10 = [0, 0, 0], c01 = [0, 0, 0], c11 = [0, 0, 0];
  let o = 0;
  const push = (k, c) => {
    pos[o] = PX[k]; pos[o + 1] = H[k]; pos[o + 2] = PZ[k];
    col[o] = c[0]; col[o + 1] = c[1]; col[o + 2] = c[2];
    o += 3;
  };
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < spokes; i++) {
      const ip = (i + 1) % spokes;
      const k00 = j * spokes + i, k10 = j * spokes + ip;
      const k01 = (j + 1) * spokes + i, k11 = (j + 1) * spokes + ip;
      colorAt(j, i, c00); colorAt(j, ip, c10);
      colorAt(j + 1, i, c01); colorAt(j + 1, ip, c11);
      // Winding matters exactly as much as it does in roads.js. Spoke index
      // runs with +angle and ring index runs with +radius, so the naive
      // (00, 01, 11) order gives a normal of -y and the whole landscape is
      // backface-culled when seen from above — present, lit, invisible.
      push(k00, c00); push(k11, c11); push(k01, c01);
      push(k00, c00); push(k10, c10); push(k11, c11);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals(); // non-indexed ⇒ flat per-triangle normals
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.97, metalness: 0,
  }));
  // nothing casts onto the far field and the shadow frustum is sized to the
  // scene, so both shadow passes here would be pure cost
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  mesh.renderOrder = -5;
  mesh.userData.field = field;
  return mesh;
}
