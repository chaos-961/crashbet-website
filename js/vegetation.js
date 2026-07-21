// vegetation.js — instanced scatter over the terrain ring (world-building P1 §1E).
//
// Strictly render-side, like fx.js, weather.js and env.js: it reads the terrain
// height field and writes nothing anywhere. Nothing here can move a sim hash —
// vegetation never gets a collider, and it is masked to r > playR so it cannot
// intrude on a lane even visually.
//
// The whole point is draw calls. A forest built the obvious way — one
// buildScenery() per tree — is 20 meshes × 300 trees = 6000 draw calls and the
// frame is gone. Here each KIND is baked down to exactly ONE InstancedMesh, so
// a nine-species landscape of ~1200 plants costs 9.
import * as THREE from 'three';
import { makeRng, clamp, bakeMerged } from './lib.js';
import { buildScenery } from './scenery.js';

/* ---------------- prototype baking ----------------
   `matFactory` dedupes materials by parameter key, which is exactly the wrong
   granularity here: every `jitterColor` call mints a new hex and therefore a
   new material, so `scree` arrives with 37 materials for 41 meshes. Splitting
   an InstancedMesh per material would hand back the draw calls this module
   exists to remove.

   So colour moves into the geometry. Each source mesh's material colour is
   baked into a vertex-colour attribute and every mesh merges into one buffer
   under one white `vertexColors` material. Per-plant variety then comes from
   `instanceColor`, which multiplies on top — one material, thousands of tints.

   Colour space is safe by construction: `m.color` is already in the linear
   working space and vertex colours are consumed in that same space, so this
   copies numbers rather than converting them. (See the sRGB rule in CLAUDE.md —
   the trap is HSL round-trips, not this.) */
function bakePrototype(kind, seed) {
  const built = buildScenery(kind, seed);
  if (!built) return null;
  const root = built.group;
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();

  let n = 0;
  const meshes = [];
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry.attributes.position) return;
    meshes.push(o);
    n += o.geometry.attributes.position.count;
  });
  if (!n) return null;

  // pick the material that covers the most vertices to donate the surface
  // parameters — roughness and metalness cannot vary per vertex, and for
  // vegetation they barely vary at all
  let bestMat = null, bestCount = -1;
  for (const mesh of meshes) {
    const c = mesh.geometry.attributes.position.count;
    if (c > bestCount) { bestCount = c; bestMat = mesh.material; }
  }
  // shared with mergeByMaterial so the index-expansion happens in exactly one
  // place — `box()` and `cyl()` are indexed and copying them in buffer order
  // silently produces spikes rather than solids
  const geo = bakeMerged(meshes, inv, { color: true });
  const box = new THREE.Box3().setFromBufferAttribute(geo.attributes.position);
  return {
    geo,
    height: Math.max(0.3, box.max.y),
    mat: {
      roughness: bestMat ? bestMat.roughness : 0.9,
      metalness: bestMat ? bestMat.metalness : 0,
      env: bestMat ? bestMat.envMapIntensity : 0.3,
    },
  };
}

/* ---------------- wind sway ----------------
   A static forest reads as a photograph. The offset scales with the SQUARE of
   local height, which is what keeps trunks planted while canopies move without
   needing a separate trunk mask per species — at y 0.3 the factor is 0.09, at
   y 3 it is 9, so the shape of the plant does the masking for free.
   Phase comes from the instance's own translation, so neighbouring plants are
   never in step; two summed frequencies stop it reading as a metronome. */
const SWAY = `
  #ifdef USE_INSTANCING
    float wph = dot(instanceMatrix[3].xz, vec2(0.37, 0.71));
  #else
    float wph = 0.0;
  #endif
  float wh = max(0.0, transformed.y);
  float wk = wh * wh * uWindAmp;
  float ws = sin(uWindTime * 1.7 + wph) * 0.7 + sin(uWindTime * 3.1 + wph * 1.63) * 0.3;
  transformed.xz += uWindDir * wk * ws;
`;

function swayMaterial(p) {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, flatShading: true,
    roughness: p.roughness, metalness: p.metalness, envMapIntensity: p.env,
  });
  const uni = {
    uWindTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uWindAmp: { value: 0 },
  };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uni);
    sh.vertexShader = sh.vertexShader
      .replace('void main() {', 'uniform float uWindTime;\nuniform vec2 uWindDir;\nuniform float uWindAmp;\nvoid main() {')
      // after begin_vertex `transformed` is still in the plant's own local
      // space, which is exactly where "height above the base" means something;
      // project_vertex applies instanceMatrix afterwards
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + SWAY);
  };
  m.userData.wind = uni;
  return m;
}

/* ---------------- species tables ----------------
   Keyed by terrain preset, because a landscape's plants ARE part of its
   identity — pines on the alpine ridge, cactus on the mesa, cattails at the
   coast. `hi`/`lo` are fractions of the preset's own amplitude, so a treeline
   moves with the terrain instead of sitting at a hardcoded altitude. */
const SPECIES = {
  alpine: [
    { kind: 'tree_pine', w: 34, lo: 0, hi: 0.42, slope: 0.5, scale: [0.9, 1.5] },
    { kind: 'tree_cluster', w: 20, lo: 0, hi: 0.34, slope: 0.4, scale: [0.8, 1.2] },
    { kind: 'rock', w: 16, lo: 0.2, hi: 1, slope: 1, scale: [0.8, 2.0] },
    { kind: 'boulder_field', w: 8, lo: 0.3, hi: 1, slope: 0.8, scale: [0.7, 1.3] },
    { kind: 'bramble', w: 10, lo: 0, hi: 0.3, slope: 0.5, reach: 0.4, scale: [0.7, 1.2] },
    { kind: 'tall_grass', w: 12, lo: 0, hi: 0.36, slope: 0.6, reach: 0.3, scale: [0.8, 1.4] },
  ],
  mesa: [
    { kind: 'cactus', w: 26, lo: 0, hi: 0.7, slope: 0.4, scale: [0.8, 1.5] },
    { kind: 'rock', w: 24, lo: 0, hi: 1, slope: 1, scale: [0.8, 2.2] },
    { kind: 'scree', w: 10, lo: 0.15, hi: 1, slope: 0.9, reach: 0.6, scale: [0.8, 1.4] },
    { kind: 'tree_dead', w: 14, lo: 0, hi: 0.5, slope: 0.35, scale: [0.8, 1.3] },
    { kind: 'bramble', w: 12, lo: 0, hi: 0.55, slope: 0.5, reach: 0.4, scale: [0.6, 1.0] },
    { kind: 'tumbleweed', w: 14, lo: 0, hi: 0.6, slope: 0.5, reach: 0.45, scale: [0.8, 1.3] },
  ],
  dunes: [
    { kind: 'tumbleweed', w: 34, lo: 0, hi: 1, slope: 0.6, reach: 0.45, scale: [0.8, 1.4] },
    { kind: 'cactus', w: 18, lo: 0, hi: 0.7, slope: 0.4, scale: [0.7, 1.2] },
    { kind: 'rock', w: 22, lo: 0, hi: 1, slope: 1, scale: [0.7, 1.6] },
    { kind: 'tall_grass', w: 26, lo: 0, hi: 0.5, slope: 0.4, reach: 0.3, scale: [0.6, 1.0] },
  ],
  coastal: [
    { kind: 'tall_grass', w: 30, lo: 0, hi: 0.6, slope: 0.6, reach: 0.3, scale: [0.9, 1.6] },
    { kind: 'cattails', w: 16, lo: 0, hi: 0.14, slope: 0.25, reach: 0.24, scale: [0.9, 1.5] },
    { kind: 'driftwood', w: 12, lo: 0, hi: 0.1, slope: 0.3, reach: 0.34, scale: [0.8, 1.4] },
    { kind: 'tree_cluster', w: 16, lo: 0.1, hi: 0.6, slope: 0.45, scale: [0.8, 1.2] },
    { kind: 'bramble', w: 16, lo: 0, hi: 0.55, slope: 0.5, reach: 0.4, scale: [0.7, 1.2] },
    { kind: 'rock', w: 10, lo: 0, hi: 1, slope: 1, scale: [0.7, 1.6] },
  ],
  rolling: [
    { kind: 'tree_cluster', w: 26, lo: 0, hi: 0.72, slope: 0.45, scale: [0.85, 1.35] },
    { kind: 'tree_round', w: 18, lo: 0, hi: 0.75, slope: 0.4, scale: [0.9, 1.5] },
    { kind: 'bush', w: 16, lo: 0, hi: 0.85, slope: 0.55, reach: 0.5, scale: [0.8, 1.5] },
    { kind: 'tall_grass', w: 20, lo: 0, hi: 0.8, slope: 0.6, reach: 0.3, scale: [0.8, 1.4] },
    { kind: 'bramble', w: 12, lo: 0, hi: 0.7, slope: 0.5, reach: 0.4, scale: [0.7, 1.2] },
    { kind: 'ferns', w: 10, lo: 0, hi: 0.5, slope: 0.4, reach: 0.26, scale: [0.8, 1.4] },
    { kind: 'rock', w: 8, lo: 0.2, hi: 1, slope: 1, scale: [0.7, 1.5] },
  ],
  flats: [
    { kind: 'bush', w: 24, lo: 0, hi: 1, slope: 0.7, reach: 0.5, scale: [0.7, 1.2] },
    { kind: 'tall_grass', w: 34, lo: 0, hi: 1, slope: 0.7, reach: 0.3, scale: [0.7, 1.2] },
    { kind: 'rock', w: 20, lo: 0, hi: 1, slope: 1, scale: [0.7, 1.4] },
    { kind: 'tumbleweed', w: 16, lo: 0, hi: 1, slope: 0.6, reach: 0.45, scale: [0.8, 1.2] },
  ],
  basin: [
    { kind: 'rock', w: 26, lo: 0, hi: 1, slope: 1, scale: [0.8, 2.0] },
    { kind: 'scree', w: 14, lo: 0.2, hi: 1, slope: 0.9, reach: 0.6, scale: [0.8, 1.4] },
    { kind: 'bramble', w: 20, lo: 0, hi: 0.6, slope: 0.5, reach: 0.4, scale: [0.7, 1.2] },
    { kind: 'tree_dead', w: 16, lo: 0, hi: 0.5, slope: 0.4, scale: [0.8, 1.3] },
    { kind: 'tall_grass', w: 18, lo: 0, hi: 0.55, slope: 0.6, reach: 0.3, scale: [0.7, 1.2] },
  ],
};

// how many plants a preset wants at full budget — a desert is not a forest
const DENSITY = { alpine: 1.0, mesa: 0.55, dunes: 0.35, coastal: 0.85, rolling: 1.0, flats: 0.4, basin: 0.6 };

export function initVegetation(scene, opts = {}) {
  const small = !!opts.small;
  const BUDGET = small ? 420 : 1250;
  const protos = new Map(); // kind -> baked prototype, cached across rounds
  let sets = [];            // live InstancedMesh list
  let t = 0;
  let amp = 0;
  const dir = new THREE.Vector2(1, 0);

  function protoFor(kind) {
    if (!protos.has(kind)) protos.set(kind, bakePrototype(kind, 'veg'));
    return protos.get(kind);
  }

  function clear() {
    for (const s of sets) {
      scene.remove(s);
      s.material.dispose(); // geometry is the cached prototype's — never dispose it
    }
    sets = [];
  }

  /* Scatter. `field` is the closure from terrain.js, so this queries the exact
     surface the mesh was built from rather than re-deriving it and drifting.
     Rejection sampling against the mask and the slope; anything that fails just
     costs one sample, and the tries budget keeps a hostile preset (a bowl whose
     walls are all too steep) from spinning. */
  function build(field, seed, o = {}) {
    clear();
    if (!field) return 0;
    const id = field.id || 'rolling';
    const table = SPECIES[id] || SPECIES.rolling;
    const p = field.preset;
    const playR = field.playR;
    // out to where the ridge boost takes over — past that a 1 m plant on a
    // 100 m hill is a subpixel speck that still costs a matrix
    const outR = Math.min(300, playR * 2.6);
    const inR = playR * 1.06; // never inside the play area, never on the seam
    const total = Math.round(BUDGET * (DENSITY[id] || 0.8) * (o.density == null ? 1 : o.density));
    if (total <= 0) return 0;
    // The same brightness the landscape was baked at (env.terrainValue). Plants
    // carry their own colours and nothing in the lighting rig can reach them,
    // so without this a night scene or a downpour leaves vivid daylight-green
    // trees standing on grey hills.
    const val = o.value == null ? 1 : o.value;

    const r = makeRng('veg:' + seed + ':' + id);
    const wsum = table.reduce((a, s) => a + s.w, 0);
    const perKind = table.map((s) => ({ spec: s, list: [] }));

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const sc = new THREE.Vector3();
    const pos = new THREE.Vector3();

    let tries = 0;
    const maxTries = total * 14;
    let placed = 0;
    while (placed < total && tries < maxTries) {
      tries++;
      // NEAR-BIASED, not area-uniform. Area-uniform is the "correct" answer and
      // it was visibly wrong: area grows with r², so ~80 % of the plants landed
      // in the outer third, and from a dashcam — the shot that matters — the
      // roadside was bare and everything else was behind the fog. Packing with
      // u^1.9 is the same trick terrain.js uses on its rings, for the same
      // reason: spend detail where the eye is.
      const a = r.range(0, Math.PI * 2);
      const u = Math.pow(r(), 1.9);
      const rad = inR + (outR - inR) * u;
      const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
      const y = field.heightAt(x, z);
      if (y <= 0.02) continue; // still on the flat apron
      // slope from a small central difference — cheaper and steadier than
      // sampling the mesh normal, and it is the same field either way
      const d = 2.2;
      const gx = (field.heightAt(x + d, z) - field.heightAt(x - d, z)) / (2 * d);
      const gz = (field.heightAt(x, z + d) - field.heightAt(x, z - d)) / (2 * d);
      const slope = Math.sqrt(gx * gx + gz * gz);
      const alt = clamp(y / (p.amp || 40), 0, 1);

      // pick a species that tolerates this altitude and slope
      let pick = null;
      let x0 = r.range(0, wsum);
      for (const s of table) { x0 -= s.w; if (x0 <= 0) { pick = s; break; } }
      if (!pick) pick = table[0];
      if (alt < pick.lo || alt > pick.hi || slope > pick.slope) continue;
      // reach: how far out a species is still worth drawing. A blade of grass
      // 250 m away is a subpixel that costs a matrix and eight triangles, so
      // the small stuff stays near and the far field is trees and rock.
      if (pick.reach != null && u > pick.reach) continue;

      const entry = perKind.find((k) => k.spec === pick);
      const s = r.range(pick.scale[0], pick.scale[1]);
      q.setFromAxisAngle(up, r.range(0, Math.PI * 2));
      sc.set(s * r.jitter(1, 0.08), s * r.jitter(1, 0.1), s * r.jitter(1, 0.08));
      pos.set(x, y - 0.05 * s, z); // sink slightly so nothing floats on a slope
      m.compose(pos, q, sc);
      entry.list.push({ m: m.clone(), tint: r.range(0.86, 1.12), warm: r.range(-0.05, 0.05) });
      placed++;
    }

    for (const k of perKind) {
      if (!k.list.length) continue;
      const proto = protoFor(k.spec.kind);
      if (!proto) continue;
      const mat = swayMaterial(proto.mat);
      const im = new THREE.InstancedMesh(proto.geo, mat, k.list.length);
      // Frustum culling on an InstancedMesh is all-or-nothing, and this set is
      // spread over the whole ring, so a bounding test can only ever say "yes".
      // Skipping it costs nothing and avoids the set popping out as a block.
      im.frustumCulled = false;
      // Vegetation lives outside playR and the shadow camera is fit to the
      // scene, so it could never cast into shot — skipping the pass is free.
      im.castShadow = false;
      im.receiveShadow = false;
      im.matrixAutoUpdate = false;
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(k.list.length * 3), 3);
      for (let i = 0; i < k.list.length; i++) {
        const it = k.list[i];
        im.setMatrixAt(i, it.m);
        // per-instance tint: the variety `jitterColor` used to buy with a new
        // material per lump, for free and without a second draw call
        im.instanceColor.setXYZ(i, (it.tint + it.warm) * val, it.tint * val, (it.tint - it.warm * 0.6) * val);
      }
      im.instanceMatrix.needsUpdate = true;
      im.instanceColor.needsUpdate = true;
      im.userData.kind = k.spec.kind;
      scene.add(im);
      sets.push(im);
    }
    return placed;
  }

  /* Wind. Amplitude is read off the sway model, not guessed: the offset is
     h²·amp, so a 3 m canopy moves 9·amp metres. The first pass used 0.0075 and
     a pixel diff over three quarters of a second found 117 changed pixels out
     of 39 000 — the sway was real, correct and completely invisible at 3 cm.
     0.030 puts a moderate breeze at ~0.3 m of canopy drift, which reads, while
     the quadratic keeps a 0.6 m rock at under a centimetre for free. */
  function setWind(w) {
    if (!w) { amp = 0; return; }
    dir.set(Math.cos(w.wind.dir), Math.sin(w.wind.dir));
    amp = 0.006 + clamp(w.wind.speed / 6, 0, 1) * 0.030;
  }

  function update(dt) {
    if (!sets.length || amp <= 0) return false;
    t += dt;
    for (const s of sets) {
      const u = s.material.userData.wind;
      u.uWindTime.value = t;
      u.uWindAmp.value = amp;
      u.uWindDir.value.copy(dir);
    }
    return true;
  }

  function dispose() {
    clear();
    for (const p of protos.values()) if (p) p.geo.dispose();
    protos.clear();
  }

  return {
    build, clear, update, setWind, dispose,
    get count() { return sets.reduce((a, s) => a + s.count, 0); },
    get draws() { return sets.length; },
  };
}
