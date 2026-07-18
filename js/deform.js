// deform.js — plastic crumple deformation for Crash Bet.
//
// Geometry here is non-indexed (duplicated verts for flat shading), so vertices
// are welded by position first; displacing weld groups keeps faces attached.
// Deformation is purely a function of contact data (deterministic), accumulates,
// and is clamped per weld group so cars crumple without imploding. Visual only —
// colliders stay rigid (v1 contract).
import * as THREE from 'three';

const KEY_EPS = 2048; // weld quantization: 1/2048 m ≈ half a millimetre

// Build once per car at rig creation. Wheels are excluded (rigid, controller-driven).
export function makeDeformState(wrap, size) {
  wrap.updateMatrixWorld(true);
  const meshes = [];
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
    // mesh-local bounding sphere for cheap impact culling
    o.geometry.computeBoundingSphere();
    const bs = o.geometry.boundingSphere.clone();
    meshes.push({
      mesh: o, pos, orig, reps, nG, gpos,
      gdisp: new Float32Array(nG * 3), // accumulated displacement per group
      crush: new Float32Array(nG),     // accumulated |displacement| per group
      toWrap, fromWrap, bs, dirty: false,
    });
  });
  const maxCrush = clampN(Math.min(size.x, size.y, size.z) * 0.34, 0.14, 0.85);
  return { meshes, maxCrush, hits: 0 };
}

const clampN = (v, a, b) => Math.min(b, Math.max(a, v));

// position-hash noise (stateless → order-independent, deterministic)
function hashNoise(x, y, z) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s); // 0..1
}

const _pW = new THREE.Vector3(), _dW = new THREE.Vector3();
const _pM = new THREE.Vector3(), _dM = new THREE.Vector3();
const _invQ = new THREE.Quaternion(), _bodyP = new THREE.Vector3();
const _m = new THREE.Matrix4();

/* Apply one impact.
   ev: { point {x,y,z} world, dir {x,y,z} world unit (push direction INTO the car), dv (m/s) }
   body pose passed explicitly — wrap's rendered transform may lag the sim. */
export function applyImpact(state, ev, bodyPos, bodyQuat) {
  const dv = ev.dv;
  const depth = clampN(dv * 0.03, 0.015, 0.42);       // crumple depth per hit
  const R = clampN(0.34 + dv * 0.045, 0.4, 1.5);      // falloff radius
  const R2 = R * R;
  // world → wrap-local (undeformed chassis frame)
  _bodyP.set(bodyPos.x, bodyPos.y, bodyPos.z);
  _invQ.set(bodyQuat.x, bodyQuat.y, bodyQuat.z, bodyQuat.w).invert();
  _pW.set(ev.point.x, ev.point.y, ev.point.z).sub(_bodyP).applyQuaternion(_invQ);
  _dW.set(ev.dir.x, ev.dir.y, ev.dir.z).applyQuaternion(_invQ);
  state.hits++;

  for (const md of state.meshes) {
    // cull: impact sphere vs mesh bounding sphere (both in wrap space via toWrap)
    _pM.copy(md.bs.center).applyMatrix4(md.toWrap);
    if (_pM.distanceTo(_pW) > md.bs.radius + R) continue;
    // to mesh-local
    _pM.copy(_pW).applyMatrix4(md.fromWrap);
    _m.extractRotation(md.fromWrap);
    _dM.copy(_dW).transformDirection(_m); // unit dir in mesh space (rotation only)
    const { gpos, gdisp, crush, nG } = md;
    let touched = false;
    for (let g = 0; g < nG; g++) {
      const gx = gpos[g * 3], gy = gpos[g * 3 + 1], gz = gpos[g * 3 + 2];
      const dx = gx - _pM.x, dy = gy - _pM.y, dz = gz - _pM.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > R2) continue;
      const t = 1 - d2 / R2;
      const fall = t * t; // smooth radial falloff
      // per-vertex grain so crumples look beaten, not airbrushed
      const noise = 0.72 + 0.55 * hashNoise(gx, gy, gz);
      let amt = depth * fall * noise;
      const left = state.maxCrush - crush[g];
      if (left <= 0) continue;
      if (amt > left) amt = left;
      crush[g] += amt;
      gdisp[g * 3] += _dM.x * amt; gdisp[g * 3 + 1] += _dM.y * amt; gdisp[g * 3 + 2] += _dM.z * amt;
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
  }
}
