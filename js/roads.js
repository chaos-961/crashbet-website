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

// Deterministic: same spec ⇒ identical geometry + identical collider recipe.
export function buildRoad(spec) {
  const w = clamp(spec.w || ROAD_DEFAULTS.w, 4, 14);
  const hw = w / 2;
  const style = spec.style || 0;
  const yellow = !!(style & 1), sidewalks = !!(style & 2), crossings = !!(style & 4);
  const deck = !!(style & 8); // bridge: parapet + underside instead of curbs
  const elev = isElevated(spec);
  const curve = roadCurve(spec);
  const L = curve.getLength();
  const N = clamp(Math.ceil(L / 1.1), 8, 480);
  const frames = sampleFrames(curve, 0, 1, N);

  const M = matFactory();
  const g = new THREE.Group();
  const asphalt = [], white = [], gold = [], curb = [], walk = [], rail = [];

  pushStrip(asphalt, frames, -hw, Y_ASPHALT, hw, Y_ASPHALT, false);

  // centre marking: double yellow solid, or white dashes walked by arc length
  if (yellow) {
    for (const s of [1, -1]) pushStrip(gold, frames, s * 0.11, Y_MARK, s * 0.21, Y_MARK, s < 0);
  } else {
    const dash = 1.9, gap = 1.5;
    const nD = Math.max(1, Math.floor((L - gap) / (dash + gap)));
    for (let k = 0; k < nD; k++) {
      const s0 = gap / 2 + k * (dash + gap);
      pushStrip(white, sampleFrames(curve, s0 / L, (s0 + dash) / L, 2), -0.07, Y_MARK, 0.07, Y_MARK, false);
    }
  }

  for (const s of [1, -1]) {
    const flip = s < 0;
    // edge line
    pushStrip(white, frames, s * (hw - 0.34), Y_MARK, s * (hw - 0.22), Y_MARK, flip);
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

  // curb colliders: one box per ~2.4 m of each curb line, yaw from the tangent
  const shapes = [];
  const nSeg = clamp(Math.round(L / 2.4), 2, 220);
  const segLen = L / nSeg;
  // a parapet is a barrier, not a kerb: full height, so a car on a bridge is
  // actually contained instead of hopping the edge into the water
  const barH = deck ? RAIL_H : CURB_H;
  const barW = deck ? RAIL_W : CURB_W;
  for (const s of [1, -1]) {
    const oc = s * (hw + 0.02 + barW / 2);
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
