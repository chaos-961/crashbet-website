// deform.js — plastic crumple deformation for Crash Bet.
//
// Geometry here is non-indexed (duplicated verts for flat shading), so vertices
// are welded by position first; displacing weld groups keeps faces attached.
// Deformation is purely a function of contact data (deterministic), accumulates,
// and is clamped per weld group so cars crumple without imploding. Visual only —
// colliders stay rigid (v1 contract).
//
// Crash-quality pass on top of the v1 crumple:
//  - zone stiffness: bumper/nose/tail zones crumple deep, the cabin resists
//  - work hardening: already-crushed metal resists further hits
//  - ridged crease noise + tangential shear so dents fold instead of airbrush
//  - glass panes (material.userData.glass) crack, then shatter — deterministic
//    thresholds per pane; visual result is a material swap / hidden mesh plus
//    an event record the sim forwards to the fx layer
//  - heavily crushed panels get a one-time paint scuff (material clone)
import * as THREE from 'three';

const KEY_EPS = 2048; // weld quantization: 1/2048 m ≈ half a millimetre

// Build once per car at rig creation. Wheels are excluded (rigid, controller-driven).
// soft = crumple-softness multiplier (1 = baseline; must be float-exact at 1).
export function makeDeformState(wrap, size, soft = 1) {
  wrap.updateMatrixWorld(true);
  const meshes = [];
  const halfX = Math.max(0.6, size.x * 0.5);
  const _w = new THREE.Vector3();
  wrap.traverse((o) => {
    let p = o;
    while (p && p !== wrap) { if (p.userData.wheel) return; p = p.parent; }
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    const pos = o.geometry.attributes.position;
    const n = pos.count;
    const orig = new Float32Array(pos.array); // pristine copy for perfect reset-by-rebuild sanity
    // weld map: vertex → representative group id (first vertex at that position)
    const reps = new Int32Array(n);
    const groups = new Map();
    for (let i = 0; i < n; i++) {
      const k = `${Math.round(pos.array[i * 3] * KEY_EPS)},${Math.round(pos.array[i * 3 + 1] * KEY_EPS)},${Math.round(pos.array[i * 3 + 2] * KEY_EPS)}`;
      let g = groups.get(k);
      if (g === undefined) { g = groups.size; groups.set(k, g); }
      reps[i] = g;
    }
    const nG = groups.size;
    // group representative positions (mesh-local, pristine)
    const gpos = new Float32Array(nG * 3);
    const seen = new Uint8Array(nG);
    for (let i = 0; i < n; i++) {
      const g = reps[i];
      if (!seen[g]) {
        seen[g] = 1;
        gpos[g * 3] = pos.array[i * 3]; gpos[g * 3 + 1] = pos.array[i * 3 + 1]; gpos[g * 3 + 2] = pos.array[i * 3 + 2];
      }
    }
    // static local↔wrap transforms (meshes never move relative to the chassis)
    const toWrap = o.matrixWorld.clone(); // wrap was at identity during build
    const fromWrap = toWrap.clone().invert();
    // zone stiffness per group: crumple zones (nose/tail) fold deep, the cabin
    // (mid-x) resists, the roof gives a little extra (rollover crush)
    const gk = new Float32Array(nG);
    for (let g = 0; g < nG; g++) {
      _w.set(gpos[g * 3], gpos[g * 3 + 1], gpos[g * 3 + 2]).applyMatrix4(toWrap);
      const nx = Math.min(1, Math.abs(_w.x) / halfX);
      let k = 0.6 + 0.9 * Math.pow(nx, 1.7);
      if (_w.y > size.y * 0.72) k *= 1.18; // roof
      gk[g] = k;
    }
    // mesh-local bounding sphere for cheap impact culling
    o.geometry.computeBoundingSphere();
    const bs = o.geometry.boundingSphere.clone();
    const isGlass = !!(o.material && o.material.userData && o.material.userData.glass);
    meshes.push({
      mesh: o, pos, orig, reps, nG, gpos, gk,
      gdisp: new Float32Array(nG * 3), // accumulated displacement per group
      crush: new Float32Array(nG),     // accumulated |displacement| per group
      toWrap, fromWrap, bs, dirty: false,
      maxSeen: 0, scuffed: false,
      glass: isGlass ? { E: 0, state: 0, K: clampN(bs.radius / 0.45, 0.7, 2.2) } : null,
    });
  });
  const maxCrush = clampN(Math.min(size.x, size.y, size.z) * 0.34, 0.14, 0.85) * soft;
  return { meshes, maxCrush, soft, hits: 0, events: [], crackMats: new Map() };
}

const clampN = (v, a, b) => Math.min(b, Math.max(a, v));

// position-hash noise (stateless → order-independent, deterministic)
function hashNoise(x, y, z) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s); // 0..1
}

// crazed-glass material for the cracked stage (cached per source material)
function crackMat(state, mat) {
  let m = state.crackMats.get(mat);
  if (!m) {
    m = mat.clone();
    m.color.lerp(new THREE.Color('#cfe0ea'), 0.7);
    m.roughness = 0.92;
    m.envMapIntensity = 0.3;
    m.metalness = 0;
    state.crackMats.set(mat, m);
  }
  return m;
}

const _pW = new THREE.Vector3(), _dW = new THREE.Vector3();
const _pM = new THREE.Vector3(), _dM = new THREE.Vector3();
const _invQ = new THREE.Quaternion(), _bodyP = new THREE.Vector3();
const _m = new THREE.Matrix4(), _c = new THREE.Vector3();

/* Apply one impact.
   ev: { point {x,y,z} world, dir {x,y,z} world unit (push direction INTO the car), dv (m/s) }
   body pose passed explicitly — wrap's rendered transform may lag the sim.
   Glass crack/shatter records land in state.events (wrap-local positions);
   the sim drains them after each impact pass. */
export function applyImpact(state, ev, bodyPos, bodyQuat) {
  const dv = ev.dv;
  const depth0 = clampN(dv * 0.032, 0.015, 0.46) * state.soft; // crumple depth per hit
  const R = clampN(0.34 + dv * 0.045, 0.4, 1.5);      // falloff radius
  const R2 = R * R;
  // world → wrap-local (undeformed chassis frame)
  _bodyP.set(bodyPos.x, bodyPos.y, bodyPos.z);
  _invQ.set(bodyQuat.x, bodyQuat.y, bodyQuat.z, bodyQuat.w).invert();
  _pW.set(ev.point.x, ev.point.y, ev.point.z).sub(_bodyP).applyQuaternion(_invQ);
  _dW.set(ev.dir.x, ev.dir.y, ev.dir.z).applyQuaternion(_invQ);
  state.hits++;

  for (const md of state.meshes) {
    // impact sphere vs mesh bounding sphere (both in wrap space via toWrap)
    _c.copy(md.bs.center).applyMatrix4(md.toWrap);
    const cDist = _c.distanceTo(_pW);

    // glass panes: accumulate pane energy → crack → shatter (then inert).
    // Runs BEFORE the crumple cull — glass has two charge paths: direct
    // overlap with the impact sphere, and "frame shock", which reaches
    // panes well outside it (windshields pop in a frontal even though the
    // bumper took the contact), fading with the square of the distance.
    if (md.glass) {
      if (md.glass.state === 2) continue;
      const overlap = 1 - clampN(cDist / (md.bs.radius + R), 0, 1);
      const shock = 0.5 / (1 + cDist * cDist * 0.35);
      md.glass.E += dv * (0.55 * overlap + shock);
      if (md.glass.state === 0 && md.glass.E > 1.3 * md.glass.K) {
        md.glass.state = 1;
        md.mesh.material = crackMat(state, md.mesh.material);
        state.events.push({ type: 'glassCrack', local: { x: _c.x, y: _c.y, z: _c.z }, r: md.bs.radius });
      }
      if (md.glass.state === 1 && md.glass.E > 2.7 * md.glass.K) {
        md.glass.state = 2;
        md.mesh.visible = false;
        state.events.push({ type: 'glassShatter', local: { x: _c.x, y: _c.y, z: _c.z }, r: md.bs.radius });
        continue; // pane is gone — no crumple pass needed
      }
    }
    if (cDist > md.bs.radius + R) continue;

    // to mesh-local
    _pM.copy(_pW).applyMatrix4(md.fromWrap);
    _m.extractRotation(md.fromWrap);
    _dM.copy(_dW).transformDirection(_m); // unit dir in mesh space (rotation only)
    const { gpos, gdisp, crush, nG, gk } = md;
    const glassSoft = md.glass ? 0.35 : 1; // glass shifts a little, never folds
    let touched = false;
    for (let g = 0; g < nG; g++) {
      const gx = gpos[g * 3], gy = gpos[g * 3 + 1], gz = gpos[g * 3 + 2];
      const dx = gx - _pM.x, dy = gy - _pM.y, dz = gz - _pM.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > R2) continue;
      const t = 1 - d2 / R2;
      const fall = t * t; // smooth radial falloff
      // grain + ridged crease noise so crumples fold like beaten sheet metal
      const n1 = hashNoise(gx, gy, gz);
      const n2 = hashNoise(gx * 2.63 + 11.7, gy * 2.63, gz * 2.63);
      const ridge = 1 - Math.abs(2 * n2 - 1);
      const noise = 0.6 + 0.5 * n1 + 0.45 * ridge * ridge;
      // zone stiffness + work hardening (crushed metal resists further hits)
      const harden = 1 / (1 + crush[g] * 1.9);
      let amt = depth0 * fall * noise * gk[g] * harden * glassSoft;
      const left = state.maxCrush - crush[g];
      if (left <= 0) continue;
      if (amt > left) amt = left;
      crush[g] += amt;
      if (crush[g] > md.maxSeen) md.maxSeen = crush[g];
      // main displacement along the impact direction
      gdisp[g * 3] += _dM.x * amt; gdisp[g * 3 + 1] += _dM.y * amt; gdisp[g * 3 + 2] += _dM.z * amt;
      // tangential shear: metal spreads away from the impact center, strongest
      // at the dent rim (fall·(1-fall) peaks mid-radius) — folds, not craters
      const dot = dx * _dM.x + dy * _dM.y + dz * _dM.z;
      let tx = dx - _dM.x * dot, ty = dy - _dM.y * dot, tz = dz - _dM.z * dot;
      const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (tl > 1e-4) {
        const shear = amt * 0.4 * (fall * (1 - fall) * 4) / tl;
        gdisp[g * 3] += tx * shear; gdisp[g * 3 + 1] += ty * shear; gdisp[g * 3 + 2] += tz * shear;
      }
      touched = true;
    }
    if (touched) md.dirty = true;
  }
}

// write accumulated group displacements back to vertices; recompute flat normals
export function flushDeform(state) {
  for (const md of state.meshes) {
    if (!md.dirty) continue;
    md.dirty = false;
    const arr = md.pos.array, { orig, reps, gdisp } = md;
    for (let i = 0; i < md.pos.count; i++) {
      const g = reps[i];
      arr[i * 3] = orig[i * 3] + gdisp[g * 3];
      arr[i * 3 + 1] = orig[i * 3 + 1] + gdisp[g * 3 + 1];
      arr[i * 3 + 2] = orig[i * 3 + 2] + gdisp[g * 3 + 2];
    }
    md.pos.needsUpdate = true;
    md.mesh.geometry.computeVertexNormals();
    // one-time paint scuff once a panel is properly crushed (render-only)
    if (!md.scuffed && !md.glass && md.maxSeen > state.maxCrush * 0.42) {
      md.scuffed = true;
      const m = md.mesh.material.clone();
      m.color.multiplyScalar(0.72);
      m.roughness = Math.max(m.roughness, 0.88);
      m.envMapIntensity *= 0.5;
      md.mesh.material = m;
    }
  }
}
