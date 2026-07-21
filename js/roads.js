// roads.js — spline road system (world-building P2).
//
// A road is a Catmull-Rom spline through 2D control points, swept into an
// asphalt ribbon with geometry lane markings, raised curbs and optional
// sidewalks + crosswalks. Deterministic by construction: ZERO randomness —
// the same spec produces the identical mesh and the identical collider
// recipe (segment counts derive from arc length, never from time or rng).
//
// buildRoad(spec) -> { group, shapes } where shapes is a flat list of box
// collider recipes for the curbs; physics.js attaches them all to a single
// fixed body at the world origin (_addRoadRig) — road points are world
// coordinates, the group is never transformed.
//
// spec: { pts: [{x,z}, ...], w: total width (m), loop: 0|1,
//         style: bit0 = double yellow centre (else white dashes),
//                bit1 = sidewalks, bit2 = crosswalks at both open ends }
import * as THREE from 'three';
import { matFactory, clamp } from './lib.js';

export const ROAD_DEFAULTS = { w: 7, loop: 0, style: 0 };
export const ROAD_MAX_PTS = 16;

const Y_ASPHALT = 0.022;      // asphalt floats 2 cm over the y-0 ground plane
const Y_MARK = 0.036;         // markings float over the asphalt
const CURB_H = 0.13, CURB_W = 0.32, SIDE_W = 1.7;
// P2/2B rural verge (style bit 4) and swept guardrail (bit 5). A verge
// REPLACES the kerb: every road in the game had a raised kerb, including
// highways and mountain roads, which is both wrong and a wall where the
// scene wants a run-off. Guardrail posts carry real colliders — a barrier
// that does not contain is decoration.
const VERGE_W = 2.2, VERGE_DROP = -0.05;
const GRAIL_H = 0.72, GRAIL_W = 0.18, GRAIL_GAP = 4.2, GRAIL_OFF = 0.55;
// bridge deck (style bit 3): a parapet wall instead of curbs, plus a solid
// underside so an elevated run reads as a structure and not floating paper
const DECK_T = 0.42, RAIL_H = 0.92, RAIL_W = 0.26;
// substructure (1G): edge girder depth, spacing between pier bents, the deck
// height below which a pier is not worth drawing, and how far below grade the
// columns run. FOOT is deliberately well under 0 — on land the ground mesh
// buries it, and over a water basin (where the ground is punched away) the
// same column carries on down and founds itself in the bed. One number, both
// cases, and no need for roads.js to know anything about water.
const GIRD_D = 0.55, PIER_GAP = 17, PIER_MIN = 1.7, PIER_FOOT = -3.6;

// Elevation v1 (G4): control points may carry a y. It is OPT-IN and defaults
// to exactly 0, which is what keeps every pinned hash alive — a flat spec
// feeds the identical control points into the identical curve, and since
// Catmull-Rom interpolates each component independently, all-zero y in gives
// exactly 0 out. Every downstream height is expressed as an offset ABOVE the
// road surface and added to the frame's y, so `+ 0` on a flat road is a
// no-op at the bit level. Do not "simplify" that back into absolute heights.
export function roadCurve(spec) {
  const pts = spec.pts.map((p) => new THREE.Vector3(p.x, p.y || 0, p.z));
  // centripetal parameterization: no cusps/self-loops even on tight zig-zags
  return new THREE.CatmullRomCurve3(pts, !!spec.loop, 'centripetal', 0.5);
}

export const isElevated = (spec) => spec.pts.some((p) => p.y);

// evenly spaced frames over the whole curve; n = left normal in the xz plane.
// The tangent is normalised by its HORIZONTAL length, so nx/nz stay a true
// horizontal normal on a slope and the ribbon never narrows as it climbs;
// ty is then rise-over-run, i.e. the grade.
function frameAt(curve, u) {
  const p = curve.getPointAt(u);
  const t = curve.getTangentAt(u);
  const l = Math.hypot(t.x, t.z) || 1;
  return { x: p.x, y: p.y, z: p.z, tx: t.x / l, ty: t.y / l, tz: t.z / l, nx: t.z / l, nz: -t.x / l };
}
function sampleFrames(curve, u0, u1, n) {
  const frames = [];
  for (let i = 0; i <= n; i++) frames.push(frameAt(curve, u0 + ((u1 - u0) * i) / n));
  return frames;
}

/* strip: quads between lateral offsets o0->o1 (heights y0->y1) swept along
   frames. Winding faces +Y for o0<o1 horizontals and +n verticals; `flip`
   mirrors it — used by the s=-1 side so every mirrored face stays outward. */
function pushStrip(out, frames, o0, y0, o1, y1, flip) {
  for (let i = 0; i < frames.length - 1; i++) {
    const f0 = frames[i], f1 = frames[i + 1];
    // y0/y1 are offsets ABOVE the road surface — f.y is 0 on a flat road, so
    // this stays bit-identical to the pre-elevation geometry
    let a0 = [f0.x + f0.nx * o0, f0.y + y0, f0.z + f0.nz * o0];
    let b0 = [f0.x + f0.nx * o1, f0.y + y1, f0.z + f0.nz * o1];
    let a1 = [f1.x + f1.nx * o0, f1.y + y0, f1.z + f1.nz * o0];
    let b1 = [f1.x + f1.nx * o1, f1.y + y1, f1.z + f1.nz * o1];
    if (flip) { [a0, b0] = [b0, a0]; [a1, b1] = [b1, a1]; }
    out.push(...a0, ...a1, ...b0, ...b0, ...a1, ...b1);
  }
}

/* collider orientation. yawQuat is the original flat-road form and must stay
   arithmetically untouched; basisQuat aligns local +X with the (pitched)
   tangent, +Z across the road and +Y up, for elevated runs. */
const _X = new THREE.Vector3(), _Y = new THREE.Vector3(), _Z = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);
const _M = new THREE.Matrix4(), _Q = new THREE.Quaternion();

function yawQuat(f) {
  const yaw = Math.atan2(-f.tz, f.tx);
  return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
}
function basisQuat(f) {
  _X.set(f.tx, f.ty, f.tz).normalize();
  _Z.crossVectors(_X, _UP).normalize();
  _Y.crossVectors(_Z, _X);
  _M.makeBasis(_X, _Y, _Z);
  _Q.setFromRotationMatrix(_M);
  return [_Q.x, _Q.y, _Q.z, _Q.w];
}

/* 8-corner solid, quad order copied verbatim from lib.js `hexa`.
   Corner ring is 0=(-a,-c) 1=(+a,-c) 2=(+a,+c) 3=(-a,+c) in a RIGHT-handed
   local basis. Copying the quad order is necessary but not sufficient: it only
   yields outward faces if the basis you feed it is right-handed, and a road
   frame's is not. `n` here is the LEFT normal, (t.z, -t.x), while
   tangent × up = (-t.z, t.x) — the exact opposite — so (along, up, across) is
   left-handed and every face comes out inverted. See pushPost for the fix.
   Third instance of this trap in the project after roads.js's strips and
   terrain.js's spokes; it costs nothing to check and is invisible if you do
   not: positions are correct, the mesh still covers pixels, and no pin moves.
   Signed volume via the divergence theorem is the test — positive is outward. */
function pushSolid(out, b, t) {
  const quads = [
    [t[3], t[2], t[1], t[0]], // top
    [b[0], b[1], b[2], b[3]], // bottom
    [b[2], b[1], t[1], t[2]], // +along
    [b[0], b[3], t[3], t[0]], // -along
    [b[3], b[2], t[2], t[3]], // +across
    [b[1], b[0], t[0], t[1]], // -across
  ];
  for (const [p, q, r, s] of quads) out.push(...p, ...q, ...r, ...p, ...r, ...s);
}

/* A box standing in road space: centred on lateral offset `o`, `halfAlong` by
   `halfAcross` in plan, running from yTop down to yBot, with the BOTTOM rect
   scaled by `taper` so a column can flare into its footing. */
function pushPost(out, f, o, halfAlong, halfAcross, yTop, yBot, taper) {
  const q = (a, c, y) => [f.x + f.tx * a + f.nx * c, y, f.z + f.tz * a + f.nz * c];
  const aB = halfAlong * taper, cB = halfAcross * taper;
  // the ring runs +across → -across, which is the REVERSE of hexa's order. Same
  // eight points, opposite orientation, and that is what cancels the frame
  // basis being left-handed. Feeding hexa's own order here renders every pier
  // inside-out.
  pushSolid(out,
    [q(-aB, o + cB, yBot), q(aB, o + cB, yBot), q(aB, o - cB, yBot), q(-aB, o - cB, yBot)],
    [q(-halfAlong, o + halfAcross, yTop), q(halfAlong, o + halfAcross, yTop),
      q(halfAlong, o - halfAcross, yTop), q(-halfAlong, o - halfAcross, yTop)]);
}

function meshFrom(out, mat) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(out), 3));
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat);
  m.receiveShadow = true;
  return m;
}

/* ---------------- junctions (P2) ----------------
   Before this, an "intersection" was four road stubs stopping 6.3 m short of
   the origin with a 13 × 13 m `asphalt_patch` PROP dropped in the hole: a
   fixed square that only fitted an 8 m + 7 m perpendicular cross, carried no
   markings whatsoever, and could not be sized, skewed or given a third arm.

   buildJunction(spec) -> { group, shapes }. `shapes` is ALWAYS empty — the
   junction is flat asphalt lying on the y-0 ground plane, so the world's
   ground slab already holds cars up and nothing here can move a pinned hash.
   It keeps buildRoad's return shape so callers treat the two the same.

   spec: { x, z, arms: [{ a, w }, ...], reach, fillet, style }
     a       heading of the arm, pointing AWAY from the centre
     w       that arm's road width
     reach   how far the asphalt runs along each arm. Road stubs should START
             just inside it, so their blunt ends are covered by the junction.
     style   bit0 stop bars · bit1 crosswalks · bit2 keep-clear box ·
             bit3 turn arrows

   Everything is drawn 2 mm BELOW the equivalent road layer, which is the one
   decision the whole file hangs off: a stub may overlap the junction freely
   without z-fighting, so the polygon never has to be tangent to anything and
   the arms can be any width at any angle. It is the same trick the patch prop
   used; the patch's mistake was being a fixed-size square rather than a shape
   derived from the arms actually meeting. */
const Y_JUNCT = Y_ASPHALT - 0.002;
const Y_JMARK = Y_MARK - 0.002;

/* Fan a WORLD-space ring (increasing θ about C) into +Y-facing triangles.
   The reversal is the same handedness rule as pushStrip, arrived at the same
   way: walking a ring in increasing θ makes radial × tangential = −Y, so the
   natural (C, pᵢ, pᵢ₊₁) order faces DOWN. Fourth instance of this trap in the
   project; the tell is a junction that is present, lit and invisible. */
function pushRing(out, y, cx, cz, ring) {
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    out.push(cx, y, cz, q[0], y, q[1], p[0], y, p[1]);
  }
}

/* Fan a polygon given in an ARM's (s = along, o = across) frame. Here
   d × n = +Y — the identical basis pushStrip sweeps — so a counter-clockwise
   polygon in (s, o) needs NO reversal. The two rules look contradictory and
   are not: the world ring is parameterised by θ, whose tangent is −n. */
function pushLocal(out, y, F, pts) {
  const w = ([s, o]) => [F.x + F.dx * s + F.nx * o, F.z + F.dz * s + F.nz * o];
  const a = w(pts[0]);
  for (let i = 1; i < pts.length - 1; i++) {
    const b = w(pts[i]), c = w(pts[i + 1]);
    out.push(a[0], y, a[1], b[0], y, b[1], c[0], y, c[1]);
  }
}
// axis-aligned rect in an arm frame; ordered here so callers cannot wind it
// backwards by passing the bounds in the order that reads naturally
function rectL(out, y, F, s0, s1, o0, o1) {
  const sa = Math.min(s0, s1), sb = Math.max(s0, s1);
  const oa = Math.min(o0, o1), ob = Math.max(o0, o1);
  pushLocal(out, y, F, [[sa, oa], [sb, oa], [sb, ob], [sa, ob]]);
}
// rotate a frame about its own origin, preserving d × n = +Y
const rotF = (F, c, s) => ({
  x: F.x, z: F.z,
  dx: F.dx * c + F.nx * s, dz: F.dz * c + F.nz * s,
  nx: F.nx * c - F.dx * s, nz: F.nz * c - F.dz * s,
});

/* Curb-return fillet between arm A's left edge and arm B's right edge.
   The corner of a plus-shape is REFLEX, so rounding it ADDS asphalt: the arc
   is tangent to both road edges and bulges toward the sharp corner, which is
   exactly what a real curb return does.

   Centre solves (X−P)·a = (X−P)·b = r for unit outward normals a, b, giving
   X = P + r(a+b)/(1+a·b). Both tangent points then slide outward along their
   edges LINEARLY in r, so the largest r that still fits inside `reach` has a
   closed form — no search, no iteration, nothing engine-dependent. */
function pushFillet(ring, cx, cz, A, B, reach, rSpec) {
  const cross = A.dx * B.dz - A.dz * B.dx;
  if (Math.abs(cross) < 1e-4) return;          // collinear arms: no corner exists
  const ax = -A.nx, az = -A.nz;                // outward normal of A's left edge
  const bx = B.nx, bz = B.nz;                  // outward normal of B's right edge
  const dot = ax * bx + az * bz;
  const den = 1 + dot;
  if (den < 0.08) return;                      // arms double back: no sane fillet
  // intersection of the two edge lines, in C-relative coordinates
  const pAx = -A.nx * A.h, pAz = -A.nz * A.h;
  const pBx = B.nx * B.h, pBz = B.nz * B.h;
  const t = ((pBx - pAx) * B.dz - (pBz - pAz) * B.dx) / cross;
  const px = pAx + A.dx * t, pz = pAz + A.dz * t;

  const ux = (ax + bx) / den, uz = (az + bz) / den;
  const sA0 = px * A.dx + pz * A.dz, sB0 = px * B.dx + pz * B.dz;
  const kA = (ux - ax) * A.dx + (uz - az) * A.dz;
  const kB = (ux - bx) * B.dx + (uz - bz) * B.dz;
  const lim = reach - 0.15;
  let r = rSpec;
  if (kA > 1e-6) r = Math.min(r, (lim - sA0) / kA);
  if (kB > 1e-6) r = Math.min(r, (lim - sB0) / kB);
  if (!(r > 0.35)) return;                     // no room: keep the sharp corner

  const gx = px + ux * r, gz = pz + uz * r;
  const a0 = Math.atan2(-az * r, -ax * r);
  const a1 = Math.atan2(-bz * r, -bx * r);
  let da = a1 - a0;                            // a curb return is always < π
  while (da > Math.PI) da -= Math.PI * 2;
  while (da < -Math.PI) da += Math.PI * 2;
  const n = Math.max(2, Math.round(r * 1.7));
  for (let i = 0; i <= n; i++) {
    const th = a0 + (da * i) / n;
    ring.push([cx + gx + Math.cos(th) * r, cz + gz + Math.sin(th) * r]);
  }
}

// Deterministic like buildRoad: zero randomness, same spec ⇒ same mesh.
export function buildJunction(spec) {
  const g = new THREE.Group();
  const cx = spec.x || 0, cz = spec.z || 0;
  const style = spec.style || 0;
  const arms = (spec.arms || []).map((A, i) => {
    const a = A.a || 0;
    const dx = Math.cos(a), dz = Math.sin(a);
    // nx/nz is the LEFT normal, matching frameAt and lanesOfRoad exactly
    return { key: ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2), ord: i, h: clamp(A.w || 7, 4, 14) / 2, dx, dz, nx: dz, nz: -dx };
  });
  if (arms.length < 2) return { group: g, shapes: [] };
  // build-order tie-break for the same reason sortLanes has one: two arms at
  // the same angle must not let float noise decide the ring order
  arms.sort((p, q) => (p.key - q.key) || (p.ord - q.ord));

  const hmax = arms.reduce((m, A) => Math.max(m, A.h), 0);
  const reach = spec.reach || hmax + 5.6;
  const fillet = spec.fillet || Math.min(4.6, hmax * 1.15);

  const ring = [];
  for (let k = 0; k < arms.length; k++) {
    const A = arms[k], B = arms[(k + 1) % arms.length];
    // the arm's own mouth, clockwise corner first (+n sits at the SMALLER θ)
    ring.push([cx + A.dx * reach + A.nx * A.h, cz + A.dz * reach + A.nz * A.h]);
    ring.push([cx + A.dx * reach - A.nx * A.h, cz + A.dz * reach - A.nz * A.h]);
    pushFillet(ring, cx, cz, A, B, reach, fillet);
  }
  const asphalt = [];
  pushRing(asphalt, Y_JUNCT, cx, cz, ring);

  const white = [], gold = [];
  const stopBars = !!(style & 1), walks = !!(style & 2);
  const keepClear = !!(style & 4), arrows = !!(style & 8);
  /* Markings key off the CONFLICT extent, never off `reach`. A cross road of
     half-width h meeting this arm at angle θ has its edge crossing this arm's
     axis at h/|sin θ| — so an opposite arm contributes nothing (a T junction
     gets its bar where the stem is, not pushed out by the far arm), a
     perpendicular one contributes h, and a skew one correctly contributes
     more than h. Near-parallel arms diverge, so they are gated out, and the
     whole thing is capped to leave room inside the apron. */
  const hxOf = (A) => {
    let hx = 0;
    for (const B of arms) {
      if (B === A) continue;
      const sin = Math.abs(A.dx * B.dz - A.dz * B.dx);
      if (sin > 0.25) hx = Math.max(hx, B.h / sin);
    }
    return Math.min(hx, reach - 4.2);
  };
  for (const A of arms) {
    const F = { x: cx, z: cz, dx: A.dx, dz: A.dz, nx: A.nx, nz: A.nz };
    const hx = hxOf(A);
    /* The APPROACH lane occupies offsets 0..+h along n. Traffic inbound on
       this arm travels −d, and the right-hand side of −d is +n under the
       left-normal convention — the same arithmetic that puts lane 1 of a
       W↔E road at z = −2. Getting this mirrored paints every stop bar and
       arrow in the oncoming lane, which no test would ever report. */
    if (walks) {
      for (let o = -A.h + 0.45; o <= A.h - 0.45; o += 0.95) {
        rectL(white, Y_JMARK, F, hx + 0.5, hx + 2.8, o - 0.26, o + 0.26);
      }
    }
    if (stopBars) rectL(white, Y_JMARK, F, hx + 3.2, hx + 3.7, 0.12, A.h - 0.18);
    if (arrows) {
      const c = A.h * 0.5, s = hx + 7.5;        // straight-ahead, pointing in
      rectL(white, Y_JMARK, F, s, s + 2.4, c - 0.17, c + 0.17);
      pushLocal(white, Y_JMARK, F, [[s - 0.95, c], [s, c - 0.62], [s, c + 0.62]]);
    }
  }
  if (keepClear) {
    /* The box marks the CONFLICT area, and it has to sit INSIDE the
       crosswalks or its corners end up buried in the bars — which is what a
       square of hmax did. The conflict area is a rectangle, not a square:
       half-extent ALONG the widest arm is where the cross road's edge cuts
       its axis (hxOf), half-extent ACROSS is that arm's own half-width. Built
       in the arm's frame, so a skew junction gets a skew box instead of one
       stapled to the world axes. */
    const wide = arms.reduce((m, A) => (A.h > m.h ? A : m), arms[0]);
    const F = { x: cx, z: cz, dx: wide.dx, dz: wide.dz, nx: wide.nx, nz: wide.nz };
    const qs = Math.max(1.5, hxOf(wide)), qo = wide.h, t = 0.15;
    rectL(gold, Y_JMARK, F, -qs, qs, qo - t, qo + t);
    rectL(gold, Y_JMARK, F, -qs, qs, -qo - t, -qo + t);
    rectL(gold, Y_JMARK, F, qs - t, qs + t, -qo, qo);
    rectL(gold, Y_JMARK, F, -qs - t, -qs + t, -qo, qo);
    /* Hatch at 45°. In the rotated frame a point (s, o) sits at ((s−o)/√2,
       (s+o)/√2) in the box's own frame, so the two slab constraints are
       |s−o| ≤ qs√2 and |s+o| ≤ qo√2 — each bar's extent solves in closed
       form and no clipping pass is needed. (A square is the special case
       where this collapses to the old q√2 − |o|.) */
    const D = rotF(F, Math.SQRT1_2, Math.SQRT1_2);
    const S2 = Math.SQRT2, span = (qs + qo) / S2, nB = 5;
    for (let i = 0; i < nB; i++) {
      const o = -span + ((2 * span) / nB) * (i + 0.5);
      const lo = Math.max(o - qs * S2, -o - qo * S2) + 0.08;
      const hi = Math.min(o + qs * S2, -o + qo * S2) - 0.08;
      if (hi - lo > 0.4) rectL(gold, Y_JMARK, D, lo, hi, o - 0.13, o + 0.13);
    }
  }

  const M = matFactory();
  g.add(meshFrom(asphalt, M('#3d4046', { rough: 0.96, env: 0.3 })));
  if (white.length) g.add(meshFrom(white, M('#c9ccd1', { rough: 0.8, env: 0.35 })));
  if (gold.length) g.add(meshFrom(gold, M('#d7a83c', { rough: 0.8, env: 0.35 })));
  return { group: g, shapes: [] };
}

// Deterministic: same spec ⇒ identical geometry + identical collider recipe.
export function buildRoad(spec) {
  const w = clamp(spec.w || ROAD_DEFAULTS.w, 4, 14);
  const hw = w / 2;
  const style = spec.style || 0;
  const yellow = !!(style & 1), sidewalks = !!(style & 2), crossings = !!(style & 4);
  const deck = !!(style & 8); // bridge: parapet + underside instead of curbs
  const verge = !!(style & 16) && !deck;   // rural: gravel shoulder, no kerb
  const guard = !!(style & 32) && !deck;   // swept guardrail (has colliders)
  const elev = isElevated(spec);
  const curve = roadCurve(spec);
  const L = curve.getLength();
  /* Caps raised from 480/220 in P2/2B. Both bound at ~528 m, and nothing in
     the game reaches that: across 514 sampled roads the longest is 321.8 m
     (switchback). So raising them is a bit-level no-op TODAY — the clamp was
     never active — while removing a silent coarsening trap for the longer
     P2 topologies. The pins prove the no-op. (Ledger #27.) */
  const N = clamp(Math.ceil(L / 1.1), 8, 900);
  const frames = sampleFrames(curve, 0, 1, N);

  const M = matFactory();
  const g = new THREE.Group();
  const asphalt = [], white = [], gold = [], curb = [], walk = [], rail = [];
  const verg = [], grail = [], wear = [];

  pushStrip(asphalt, frames, -hw, Y_ASPHALT, hw, Y_ASPHALT, false);

  /* Lane count from width. A 12 m road with one centre line reads as an
     absurdly wide two-lane; past 10.5 m it gets interior dashes and becomes
     the dual carriageway it already was in metres. Visual only — director
     lane extraction is untouched, so no scene changes shape. */
  const wide = w >= 10.5;
  const dashRun = (offset) => {
    const dash = 1.9, gap = 1.5;
    const nD = Math.max(1, Math.floor((L - gap) / (dash + gap)));
    for (let k = 0; k < nD; k++) {
      const s0 = gap / 2 + k * (dash + gap);
      const sub = sampleFrames(curve, s0 / L, (s0 + dash) / L, 2);
      pushStrip(white, sub, offset - 0.07, Y_MARK, offset + 0.07, Y_MARK, offset < 0);
    }
  };

  // centre marking: double yellow solid, or white dashes walked by arc length
  if (yellow) {
    for (const s of [1, -1]) pushStrip(gold, frames, s * 0.11, Y_MARK, s * 0.21, Y_MARK, s < 0);
  } else {
    dashRun(0);
  }
  if (wide) for (const s of [1, -1]) dashRun(s * hw * 0.5);

  /* Tyre polish. Deterministic from geometry like everything else here: a
     darker band down each wheel path, which is what stops a long straight
     from reading as one flat swatch. One extra material, so one extra draw
     call per road after the merge — cheap for how much it breaks up the
     surface at the grazing angles a dashcam actually sees. */
  const laneC = wide ? [hw * 0.25, hw * 0.75] : [hw * 0.5];
  for (const s of [1, -1]) {
    for (const lc of laneC) {
      for (const t of [-0.72, 0.72]) {
        const c = lc + t;
        pushStrip(wear, frames, s * (c - 0.34), 0.026, s * (c + 0.34), 0.026, s < 0);
      }
    }
  }

  for (const s of [1, -1]) {
    const flip = s < 0;
    // edge line
    pushStrip(white, frames, s * (hw - 0.34), Y_MARK, s * (hw - 0.22), Y_MARK, flip);
    if (verge) {
      // shoulder falling away from the asphalt edge — a shallow drop, not a
      // wall, so leaving the road is a run-off rather than a kerb strike
      pushStrip(verg, frames, s * hw, Y_ASPHALT, s * (hw + VERGE_W), VERGE_DROP, flip);
      continue;
    }
    if (deck) {
      // parapet: inner face up, top cap, outer face all the way down past the
      // deck slab — that outer face is what you see from the water below
      const p0 = hw + 0.02, p1 = hw + 0.02 + RAIL_W;
      pushStrip(rail, frames, s * p0, Y_ASPHALT, s * p0, RAIL_H, flip);
      pushStrip(rail, frames, s * p0, RAIL_H, s * p1, RAIL_H, flip);
      pushStrip(rail, frames, s * p1, RAIL_H, s * p1, -DECK_T, flip);
      continue;
    }
    // curb: inner face, top, and (when no sidewalk hides it) outer face
    const c0 = hw + 0.02, c1 = hw + 0.02 + CURB_W;
    pushStrip(curb, frames, s * c0, Y_ASPHALT, s * c0, CURB_H, flip);
    pushStrip(curb, frames, s * c0, CURB_H, s * c1, CURB_H, flip);
    if (sidewalks) {
      pushStrip(walk, frames, s * c1, CURB_H, s * (c1 + SIDE_W), CURB_H, flip);
      pushStrip(walk, frames, s * (c1 + SIDE_W), CURB_H, s * (c1 + SIDE_W), 0.004, flip);
    } else {
      pushStrip(curb, frames, s * c1, CURB_H, s * c1, 0.004, flip);
    }
  }
  // deck underside — flipped so it faces down
  if (deck) {
    const e = hw + 0.02 + RAIL_W;
    pushStrip(rail, frames, -e, -DECK_T, e, -DECK_T, true);
  }

  /* GUARDRAIL (style bit 5) — swept along both edges, posts on arc-length
     stations so spacing stays even through a bend. Unlike the 1G
     substructure this DOES contribute colliders (below), because a barrier
     that does not contain a car is scenery. The existing `guardrail` scenery
     kind is a discrete 4 m object dropped at a point; this is the continuous
     run a mountain road needs. */
  if (guard) {
    const nP = Math.max(2, Math.round(L / GRAIL_GAP));
    for (const s of [1, -1]) {
      const flip = s < 0;
      const o0 = s * (hw + GRAIL_OFF), o1 = s * (hw + GRAIL_OFF + GRAIL_W);
      // beam: inner face, top cap, outer face — a shallow W-profile read
      pushStrip(grail, frames, o0, GRAIL_H - 0.34, o0, GRAIL_H, flip);
      pushStrip(grail, frames, o0, GRAIL_H, o1, GRAIL_H, flip);
      pushStrip(grail, frames, o1, GRAIL_H, o1, GRAIL_H - 0.34, flip);
      for (let i = 0; i <= nP; i++) {
        const f = frameAt(curve, i / nP);
        pushPost(grail, f, s * (hw + GRAIL_OFF + GRAIL_W / 2), 0.07, 0.07, f.y + GRAIL_H - 0.3, f.y - 0.35, 1);
      }
    }
  }

  // crosswalks: continental bars (parallel to travel) near both open ends
  if (crossings && !spec.loop && L > 14) {
    const barL = 2.3, span = hw - 0.55;
    for (const s0 of [1.6, L - 1.6 - barL]) {
      const sub = sampleFrames(curve, s0 / L, (s0 + barL) / L, 2);
      for (let o = -span + 0.3; o <= span - 0.3; o += 0.95) {
        pushStrip(white, sub, o - 0.26, Y_MARK, o + 0.26, Y_MARK, false);
      }
    }
  }

  /* SUBSTRUCTURE (1G) — bridge decks only, and VISUAL ONLY.
     Nothing here is pushed to `shapes`, so no collider changes and no pinned
     hash can move; cars are already contained by the parapet colliders and
     held up by the deck slab. A bridge was a 0.42 m plate floating on air.

     Everything derives from arc length, like the rest of this file — zero
     randomness, so the same spec still draws the identical mesh.

     The girders run the FULL length rather than just the elevated stretch.
     Where the deck is at grade they sit below it and the ground hides them,
     which is the same trick the piers use for their footings and is far less
     code than finding the elevated sub-range and capping the sweep to it. */
  if (deck && elev) {
    const sub = [];
    const yG = -DECK_T - GIRD_D;
    for (const s of [1, -1]) {
      const flip = s < 0;
      const gO = s * (hw + 0.02 + RAIL_W);        // outer fascia, flush with the parapet
      const gI = s * (hw + 0.02 + RAIL_W - 0.34); // inner web
      pushStrip(sub, frames, gO, -DECK_T, gO, yG, flip);
      pushStrip(sub, frames, gI, yG, gI, -DECK_T, flip);
      // soffit: pass the offsets ascending and flip, so it faces DOWN on both
      // sides — the mirrored side would otherwise light from underneath
      const lo = s > 0 ? gI : gO, hi = s > 0 ? gO : gI;
      pushStrip(sub, frames, lo, yG, hi, yG, true);
    }

    // pier bents. getPointAt is arc-length parameterised, so i/nP is evenly
    // spaced along the deck rather than bunched wherever the spline is dense.
    const nP = Math.max(1, Math.round(L / PIER_GAP));
    for (let i = 0; i <= nP; i++) {
      const f = frameAt(curve, i / nP);
      if (f.y < PIER_MIN) continue; // at grade there is nothing to hold up
      const capT = f.y + yG;
      pushPost(sub, f, 0, 0.5, hw * 0.9, capT, capT - 0.46, 1);        // pier cap
      for (const s of [1, -1]) {
        pushPost(sub, f, s * hw * 0.46, 0.38, 0.38, capT - 0.46, PIER_FOOT, 1.3);
      }
    }

    // abutments: walk in from each open end to where the deck first lifts clear
    // of grade and plant a full-width block, so the span is carried into the
    // bank instead of simply stopping in mid-air
    if (!spec.loop) {
      for (const end of [0, 1]) {
        const step = (end === 0 ? 1 : -1) * (1.2 / L);
        let u = end;
        for (let k = 0; k < 240; k++) {
          const f = frameAt(curve, clamp(u, 0, 1));
          if (f.y > 0.75) { pushPost(sub, f, 0, 1.0, hw + RAIL_W, f.y - DECK_T, PIER_FOOT, 1.06); break; }
          u += step;
          if (u < 0 || u > 1) break;
        }
      }
    }

    const m = meshFrom(sub, M('#8a8d93', { rough: 0.95, env: 0.25 }));
    m.castShadow = true; // a pier's shadow on the water is most of the read
    g.add(m);
  }

  g.add(meshFrom(asphalt, M('#3d4046', { rough: 0.96, env: 0.3 })));
  g.add(meshFrom(white, M('#c9ccd1', { rough: 0.8, env: 0.35 })));
  if (gold.length) g.add(meshFrom(gold, M('#d7a83c', { rough: 0.8, env: 0.35 })));
  // a deck road takes the parapet branch and never pushes a curb, so this was
  // adding an empty mesh — a wasted draw call on every bridge in the game
  if (curb.length) g.add(meshFrom(curb, M('#93969c', { rough: 0.92, env: 0.3 })));
  if (walk.length) g.add(meshFrom(walk, M('#a9abaf', { rough: 0.94, env: 0.3 })));
  if (rail.length) g.add(meshFrom(rail, M('#9ea1a6', { rough: 0.9, env: 0.32 })));
  if (verg.length) g.add(meshFrom(verg, M('#6e6a5f', { rough: 0.98, env: 0.18 })));
  if (wear.length) g.add(meshFrom(wear, M('#34373c', { rough: 0.97, env: 0.26 })));
  if (grail.length) {
    const m = meshFrom(grail, M('#b6b9bd', { rough: 0.62, metal: 0.5, env: 0.5 }));
    m.castShadow = true; // the post shadows are what make it read as a run
    g.add(m);
  }

  // curb colliders: one box per ~2.4 m of each curb line, yaw from the tangent
  const shapes = [];
  // cap raised with N above, and inactive for the same reason: round(L/2.4)
  // only reaches 220 at L ≈ 528 m, well past the longest road dealt (321.8 m)
  const nSeg = clamp(Math.round(L / 2.4), 2, 400);
  const segLen = L / nSeg;
  // a parapet is a barrier, not a kerb: full height, so a car on a bridge is
  // actually contained instead of hopping the edge into the water. A verge is
  // the opposite case — there is no kerb at all, so it emits NO collider and
  // running off the road is a run-off rather than a strike against a wall.
  const barH = deck ? RAIL_H : guard ? GRAIL_H : CURB_H;
  const barW = deck ? RAIL_W : guard ? GRAIL_W : CURB_W;
  const barO = guard ? hw + GRAIL_OFF + GRAIL_W / 2 - barW / 2 : hw + 0.02;
  const edgeColliders = !verge || guard; // a bare verge has no line to collide with
  for (const s of edgeColliders ? [1, -1] : []) {
    const oc = s * (barO + barW / 2);
    for (let i = 0; i < nSeg; i++) {
      const f = frameAt(curve, (i + 0.5) / nSeg);
      shapes.push({
        kind: 'box',
        he: [segLen / 2 + 0.12, barH / 2, barW / 2 + 0.03],
        pos: [f.x + f.nx * oc, f.y + barH / 2, f.z + f.nz * oc],
        // A flat road MUST keep the exact yaw-only quaternion: routing it
        // through a matrix→quaternion conversion would perturb the last bits
        // and move the pinned `roads`/`worldgen`/`director` hashes. Only an
        // elevated road pays for the general (pitched) basis.
        rot: elev ? basisQuat(f) : yawQuat(f),
      });
    }
  }

  /* DRIVING SURFACE — elevated runs only.
     A flat road never needed one: the world's 220 m ground slab holds the car
     up and the asphalt is paint on top of it. An elevated run has nothing
     underneath, so without this the deck is decoration — a car placed
     mid-span falls straight through to the ground. That is exactly how G4
     shipped: the sweep swept y, the parapets were pinned, and the `bridge`
     scenario's cars enter at x=±36 where the deck y IS 0, so they drive up
     the ramp and nothing ever stood on an elevated span. The causeway then
     ran its whole cast along the ground UNDER the bridge and into the water
     basin, and the switchback ran its cast across open ground up to 15 m
     below the road, uncontained (the guardrails are up on the deck).
     Opt-in on `elev`, so a flat road emits the identical shape list it always
     has and every pre-existing hash stays bit-identical. */
  if (elev) {
    const T = deck ? DECK_T : 0.5; // slab hangs below the asphalt surface
    for (let i = 0; i < nSeg; i++) {
      const f = frameAt(curve, (i + 0.5) / nSeg);
      shapes.push({
        kind: 'box',
        // Longitudinal overlap is deliberately much smaller than the curbs'
        // 0.12: consecutive slabs are pitched to their own tangent, so on a
        // grade a generous overlap leaves the next slab's leading edge
        // standing proud — a lip that trips a wheel at speed. Nothing drives
        // on a curb, so its overlap can be sloppy; this one cannot.
        he: [segLen / 2 + 0.03, T / 2, hw + 0.02],
        pos: [f.x, f.y + Y_ASPHALT - T / 2, f.z],
        rot: basisQuat(f),
      });
    }
  }

  return { group: g, shapes };
}
