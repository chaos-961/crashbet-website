// director.js — the incident engine (game phase G1).
// generateScene(seed, d) deals a complete, deterministic round scenario:
// a topology (roads + dressing), a cast of driven cars, and ONE scripted
// incident that goes wrong at exactly tick 600 (T = 10 s). The output is a
// plain CrashSim scenario ({world, roads, props, cars}) plus scene meta —
// nothing here touches physics, and nothing here may import physics.js
// (physics.js imports THIS module for its pinned `director` test scenario).
//
// Determinism contract (same as vehicles): one master seed, separately
// derived rng streams per facet — 'scn:'+seed+':topo' / ':incident' /
// ':cast' / ':dress' — consumed in a FIXED order, so forcing one facet never
// shifts another. Zero Math.random(). The only trig runs at generation time
// (its output is plain numbers in the scenario; the per-tick driver in
// physics.js is transcendental-free).
import { makeRng, clamp } from './lib.js';
import { roadCurve } from './roads.js';
import { generateWorld } from './worldgen.js';

export const INCIDENT_TICK = 600; // T = 10 s at 60 Hz — the moment it goes wrong
export const RESOLVE_TICKS = 1800; // ≤ 30 s of aftermath before the hard cap
// A 10 s approach eats >100 m of road. Below this the scene is a crawl and
// nothing crumples, so lanes that can't sustain it are rejected outright
// rather than silently throttled (the failure mode the first sweeps hit).
const MIN_V = 7.5;
// where the incident sits on a lane: as late as possible, leaving runout for
// the wreck to slide/tumble into
const RUNOUT = 34;
// the fastest a lane can support: run-up before the anchor / preview seconds
function laneMaxV(lane, anchorS = lane.len - RUNOUT, tick = INCIDENT_TICK) {
  return (anchorS - 4) / (tick / 60);
}
// the incident anchor + the speed that fits it, clamped to the lane's own
// design speed. Returns null when the lane simply can't host an approach.
function solveApproach(lane, want) {
  const anchorS = lane.len - RUNOUT;
  if (anchorS < 40) return null;
  const v = Math.min(want === undefined ? lane.v : want, laneMaxV(lane, anchorS));
  if (v < MIN_V) return null;
  return { anchorS, v };
}

/* Head-on geometry. Two cars approach from OPPOSITE ends of the same road,
   so during the 10 s preview they close 2·v·10 metres between them. They can
   only meet mid-road: v = L/20. Anchoring the incident near one lane's far
   end (as a one-sided solveApproach does) puts the meeting point right at
   the oncoming car's spawn, and the pair start already past each other —
   the failure the first blowout sweeps showed as growing separation. */
function solveHeadOn(lane, opp, tick = INCIDENT_TICK) {
  if (!opp) return null;
  const L = Math.min(lane.len, opp.len);
  const sec = tick / 60;
  const v = Math.min(lane.v, (L - 22) / (2 * sec));
  if (v < MIN_V) return null;
  const reach = v * sec;          // each car's own run-up
  if (L - reach < 12) return null; // no room left for the far side
  // the shared meeting point, expressed in each lane's own arc coordinates
  return { v, aS: reach, oS: L - reach };
}

/* ---------------- vehicle pools (curated REG ids) ---------------- */
const FAST = ['muscle', 'sedan', 'sports', 'hothatch', 'coupe', 'taxi', 'rally', 'stockcar', 'gtcoupe'];
const CIVIC = ['sedan', 'hatch', 'wagon', 'suv', 'minivan', 'pickup', 'coupe', 'micro', 'lowrider', 'taxi'];
const HEAVY = ['citybus', 'schoolbus', 'boxtruck', 'flatbed', 'garbage', 'semibox', 'tanker'];

/* ---------------- polyline helpers (flat [x,z,...] arrays) ---------------- */
function laneLen(pts) {
  let l = 0;
  for (let i = 2; i < pts.length; i += 2) l += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  return l;
}
// point + heading at arc distance s along the polyline
function arcPos(pts, s) {
  let acc = 0;
  for (let i = 0; i < pts.length - 2; i += 2) {
    const dx = pts[i + 2] - pts[i], dz = pts[i + 3] - pts[i + 1];
    const el = Math.hypot(dx, dz);
    if (acc + el >= s || i === pts.length - 4) {
      const k = el > 1e-9 ? clamp((s - acc) / el, 0, 1) : 0;
      return { x: pts[i] + dx * k, z: pts[i + 1] + dz * k, heading: Math.atan2(-dz, dx) };
    }
    acc += el;
  }
  return { x: pts[0], z: pts[1], heading: 0 };
}
// slice of the polyline from arc distance s0 to the end (starts on the cut point)
function slicePts(pts, s0) {
  const out = [];
  let acc = 0, started = s0 <= 0;
  if (started) out.push(pts[0], pts[1]);
  for (let i = 0; i < pts.length - 2; i += 2) {
    const dx = pts[i + 2] - pts[i], dz = pts[i + 3] - pts[i + 1];
    const el = Math.hypot(dx, dz);
    if (!started && acc + el > s0) {
      const k = el > 1e-9 ? (s0 - acc) / el : 0;
      out.push(pts[i] + dx * k, pts[i + 1] + dz * k);
      started = true;
    }
    if (started) out.push(pts[i + 2], pts[i + 3]);
    acc += el;
  }
  if (out.length < 4) out.push(pts[pts.length - 2], pts[pts.length - 1]);
  return out;
}
// geometric crossing of two lanes: the sample pair with minimum distance,
// as arc distances along each. Only meaningful when the lanes really cross.
function crossOf(a, b) {
  let best = 1e9, sA = 0, sB = 0, closeN = 0;
  let accA = 0;
  for (let i = 0; i < a.pts.length; i += 2) {
    if (i > 0) accA += Math.hypot(a.pts[i] - a.pts[i - 2], a.pts[i + 1] - a.pts[i - 1]);
    let accB = 0, near = false;
    for (let j = 0; j < b.pts.length; j += 2) {
      if (j > 0) accB += Math.hypot(b.pts[j] - b.pts[j - 2], b.pts[j + 1] - b.pts[j - 1]);
      const d2 = (a.pts[i] - b.pts[j]) ** 2 + (a.pts[i + 1] - b.pts[j + 1]) ** 2;
      if (d2 < best) { best = d2; sA = accA; sB = accB; }
      if (d2 < 3.2 * 3.2) near = true;
    }
    if (near) closeN++;
  }
  // closeLen ≈ metres of lane A that run within 3.2 m of lane B: ~0 for a
  // perpendicular crossing, large when the lanes merge/overlap
  return { sA, sB, dist: Math.sqrt(best), closeLen: closeN * 2.5 };
}
// local curvature score around arc distance s (heading change per meter)
function curvatureAt(pts, s, win = 12) {
  const a = arcPos(pts, Math.max(0, s - win)), b = arcPos(pts, s + win);
  let dh = b.heading - a.heading;
  while (dh > Math.PI) dh -= 2 * Math.PI;
  while (dh < -Math.PI) dh += 2 * Math.PI;
  return Math.abs(dh) / (2 * win);
}

/* ---------------- lane extraction from road specs ---------------- */
// One lane per direction, offset ±w/4 from the spline (right-hand traffic).
// Loops are unrolled into an open 85 % window so the driver never wraps.
function lanesOfRoad(spec, rng, vBase) {
  const curve = roadCurve(spec);
  const total = curve.getLength();
  const n = Math.max(8, Math.ceil(total / 2.5));
  const off = spec.w / 4;
  const u0 = spec.loop ? rng() : 0;
  const span = spec.loop ? 0.85 : 1;
  const fwd = [], rev = [];
  // Per-sample deck height, kept in a SEPARATE array so `pts` stays a flat
  // [x,z,…] pair list. The stride is load-bearing: arcPos/laneLen/slicePts/
  // crossOf all walk it two at a time, and physics reads the very same array
  // as `drive.pts`. Widening it to triples would ripple into the driver and
  // move every pinned hash. y rides alongside instead.
  const fy = [], ry = [];
  for (let i = 0; i <= n; i++) {
    const u = spec.loop ? (u0 + (span * i) / n) % 1 : i / n;
    const p = curve.getPointAt(u);
    const t = curve.getTangentAt(u);
    const l = Math.hypot(t.x, t.z) || 1;
    const nx = t.z / l, nz = -t.x / l; // left normal
    fwd.push(p.x - nx * off, p.z - nz * off); // right side, travelling forward
    rev.push(p.x + nx * off, p.z + nz * off); // right side of the reverse run
    fy.push(p.y); ry.push(p.y);
  }
  rev.reverse(); // flat [x,z] pairs: reverse pairwise
  for (let i = 0; i < rev.length; i += 2) { const t = rev[i]; rev[i] = rev[i + 1]; rev[i + 1] = t; }
  ry.reverse(); // one y per sample, so a plain reverse matches the pair swap
  const lanes = [];
  for (const [pts, ys] of [[fwd, fy], [rev, ry]]) {
    const len = laneLen(pts);
    if (len > 55) lanes.push({ pts, ys, len, v: vBase, w: spec.w, road: spec });
  }
  return lanes;
}

/* Deck height at arc distance s along a lane. Returns exactly 0 for a flat
   road (every y sample is 0, so the lerp is 0 + (0−0)·k), which is what lets
   the placement helpers hand physics a `y` unconditionally without moving a
   single pre-existing hash. Mirrors arcPos's walk so the two never disagree
   about which segment `s` falls in. */
function arcY(lane, s) {
  const ys = lane && lane.ys;
  if (!ys) return 0;
  const pts = lane.pts;
  let acc = 0;
  for (let i = 0; i < pts.length - 2; i += 2) {
    const dx = pts[i + 2] - pts[i], dz = pts[i + 3] - pts[i + 1];
    const el = Math.hypot(dx, dz);
    if (acc + el >= s || i === pts.length - 4) {
      const k = el > 1e-9 ? clamp((s - acc) / el, 0, 1) : 0;
      const a = ys[i >> 1], b = ys[(i >> 1) + 1];
      return a + (b - a) * k;
    }
    acc += el;
  }
  return ys[0];
}

/* Order lanes longest-first for the placement solver. The quantisation is
   load-bearing, not tidiness: the two directions of a straight symmetric road
   have the SAME length up to float noise, and a raw `b.len - a.len` let that
   noise pick the winner. Arc length accumulates through sqrt, whose last bits
   are not guaranteed equal across JS engines, so node and the browser sorted
   a causeway's two lanes oppositely and generated MIRRORED scenes from one
   seed (cars at x=+69 heading -pi in node, x=-69 heading 0 in the browser).
   That breaks the game's core promise — the headless pre-sim the bets settle
   against has to be the scene the player watches. Rounding to cm puts genuine
   length differences on one side and noise on the other; the build-order tie
   break is exact integer maths, so the result is engine-independent. */
function sortLanes(lanes) {
  lanes.forEach((l, i) => { if (l._ord === undefined) l._ord = i; });
  lanes.sort((a, b) => (Math.round(b.len * 100) - Math.round(a.len * 100)) || (a._ord - b._ord));
  return lanes;
}

/* ---------------- topologies ---------------- */
// Each returns { name, world: {arena, env}, roads, props, lanes, crossings }.
// crossings = [[laneIdxA, laneIdxB], ...] — pairs that genuinely intersect.
function topoWorldgen(preset, rTopo, vBase) {
  const g = generateWorld(preset, String(rTopo.int(1, 99999)), { maxProps: 40, maxRoads: 6 });
  const lanes = [];
  for (const spec of g.roads) for (const l of lanesOfRoad(spec, rTopo, vBase)) lanes.push(l);
  sortLanes(lanes);
  // big topos (the 290 m highway) need the visual ground disc to keep up;
  // setGroundRadius clamps to its 90 m floor so small arenas are unaffected
  const world = { ...g.world, ground: (g.world.arena || 140) / 2 + 22 };
  return { name: preset, world, roads: g.roads, props: g.props, lanes, crossings: [] };
}

// Signalized intersection: four road stubs meeting a bare-asphalt junction
// patch (roads must never overlap — the patch fills the hole 2 mm lower).
// Lanes run STRAIGHT THROUGH the junction across the patch; EW × NS pairs
// are the crossing geometry that red-light scenes need.
function topoIntersection(rTopo, rDress) {
  // stubs run to ±145: a 10 s approach at road speed is >100 m, so short
  // arms silently throttled every actor to a crawl (found in the G1 sweeps)
  const A = 145;
  const roads = [
    { pts: [{ x: -A, z: 0 }, { x: -A / 2, z: 0 }, { x: -6.3, z: 0 }], w: 8, loop: 0, style: 1 },
    { pts: [{ x: 6.3, z: 0 }, { x: A / 2, z: 0 }, { x: A, z: 0 }], w: 8, loop: 0, style: 1 },
    { pts: [{ x: 0, z: -A }, { x: 0, z: -A / 2 }, { x: 0, z: -6.3 }], w: 7, loop: 0, style: 0 },
    { pts: [{ x: 0, z: 6.3 }, { x: 0, z: A / 2 }, { x: 0, z: A }], w: 7, loop: 0, style: 0 },
  ];
  const mk = (x0, z0, x1, z1, w, road) => {
    const pts = [];
    const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 2.5);
    for (let i = 0; i <= n; i++) pts.push(x0 + ((x1 - x0) * i) / n, z0 + ((z1 - z0) * i) / n);
    return { pts, len: Math.hypot(x1 - x0, z1 - z0), v: 12.5, w, road };
  };
  const lanes = [
    mk(-A, 2, A, 2, 8, 'ew'),    // 0: W→E on the right side (+z)
    mk(A, -2, -A, -2, 8, 'ew'),  // 1: E→W
    mk(-1.75, -A, -1.75, A, 7, 'ns'), // 2: N→S (travelling +z, right side −x)
    mk(1.75, A, 1.75, -A, 7, 'ns'),   // 3: S→N
  ];
  const props = [{ kind: 'asphalt_patch', x: 0, z: 0, heading: 0, seed: String(rDress.int(1, 9999)) }];
  const S = (kind, x, z, heading) => props.push({ kind, x, z, heading, seed: String(rDress.int(1, 9999)) });
  // signals on opposing corners (cosmetic state for now — G3 parameterizes),
  // street furniture on the other two
  S('traffic_light', 7.5, 6.8, Math.PI);
  S('traffic_light', -7.5, -6.8, 0);
  S('traffic_light_ped', 6.8, -7.4, Math.PI / 2);
  S('lamp_cobra', -7.2, 7.4, 0);
  S('hydrant', 9.5, -8.6, rDress.range(0, 6.28));
  S('mailbox', -9.2, 8.8, rDress.range(0, 6.28));
  S('bench', 11.5, 8.2, Math.PI);
  if (rTopo.chance(0.7)) S('tree_oak', 14 + rTopo.range(0, 4), -12 - rTopo.range(0, 4), rTopo.range(0, 6.28));
  if (rTopo.chance(0.7)) S('tree_oak', -14 - rTopo.range(0, 4), 12 + rTopo.range(0, 4), rTopo.range(0, 6.28));
  if (rTopo.chance(0.5)) S('trash_can', 8.6, 9.4, 0);
  return {
    name: 'intersection',
    world: { arena: A * 2 + 20, env: 'city', ground: A + 22 },
    roads, props, lanes,
    crossings: [[0, 2], [0, 3], [1, 2], [1, 3]],
  };
}

/* ---------------- G4 topologies ----------------
   All six build ordinary road specs and extract lanes through lanesOfRoad,
   so opposite-lane pairing (`road` identity), the conflict scrub and the
   placement solver keep working unchanged. Roads must never OVERLAP — same
   height asphalt z-fights — so junctions leave a small gap and, where the
   hole would read as a mistake, an `asphalt_patch` fills it 2 mm lower.
   Lane arms run long (±130 m) because a 10 s approach at road speed is over
   100 m; short arms silently throttle every actor to a crawl (G1 sweeps). */
const dress = (props, rDress) => (kind, x, z, heading) =>
  props.push({ kind, x, z, heading, seed: String(rDress.int(1, 9999)) });

function lanesFrom(roads, rng, vBase) {
  const lanes = [];
  for (const spec of roads) for (const l of lanesOfRoad(spec, rng, vBase)) lanes.push(l);
  sortLanes(lanes);
  return lanes;
}

// Causeway: a bridge deck over open water. Showcases elevation + the basin —
// leaving this road is not a spin onto grass, it is a swim.
function topoCauseway(rTopo, rDress, vBase) {
  const A = 130, deckY = rTopo.range(3.2, 4.6);
  const roads = [{
    w: 9, loop: 0, style: 1 | 8,
    pts: [
      { x: -A, y: 0, z: 0 }, { x: -46, y: deckY * 0.55, z: 0 },
      { x: -20, y: deckY, z: 0 }, { x: 20, y: deckY, z: 0 },
      { x: 46, y: deckY * 0.55, z: 0 }, { x: A, y: 0, z: 0 },
    ],
  }];
  const props = [];
  const S = dress(props, rDress);
  for (const s of [-1, 1]) {
    S('guardrail', s * 62, 9.5, 0);
    S('lamp_cobra', s * 34, 7.2, 0);
  }
  if (rTopo.chance(0.6)) S('barrier_water', rTopo.range(-40, 40), 30, rTopo.range(0, 6.28));
  return {
    name: 'causeway',
    world: {
      arena: A * 2 + 20, env: 'salt', ground: A + 22,
      water: { y: -0.8, x0: -60, x1: 60, z0: -70, z1: 70 },
    },
    roads, props, lanes: lanesFrom(roads, rTopo, vBase), crossings: [],
  };
}

// Mountain switchback: hairpins climbing a grade, guardrail on the outside.
// The curvature is the point — this is the overspeed template's home.
function topoSwitchback(rTopo, rDress, vBase) {
  const A = 120;
  /* A mountain VIADUCT, not a road cut into a hillside — there is no terrain
     system, so an elevated non-bridge road renders as a ribbon floating in
     the sky with its guardrails stranded on the ground 15 m below. Style bit
     3 gives it a deck underside and full-height parapets, so it reads as a
     structure and the barriers actually contain a car (RAIL_H 0.92 against
     the old 0.13 kerb, which a wreck simply hopped).

     Geometry is tuned to a MINIMUM TURN RADIUS of ~22 m, measured, not
     guessed. The old shape folded at 12.3 m, and the pure-pursuit driver
     (lookahead 0.55·v + 2.5, up to 13 m) cannot track a radius near its own
     lookahead — it cut up to 2.06 m off the lane, which on a 4 m lane
     separation is a head-on, and made every car cover arc length faster than
     `place()` budgeted, so victims arrived before the incident tick. Every
     topology the sweep certifies clean sits at 19–48 m (roundabout 19.3,
     suburb 19.8, city 20.4, highway 47.5); this now sits just inside that
     band while staying the curviest thing in the game. Widened 8 → 10 m as
     well, which buys another metre of separation between opposing lanes. */
  const roads = [{
    w: 10, loop: 0, style: 1 | 8,
    pts: [
      { x: -A, y: 0, z: -52 }, { x: -74, y: 1.6, z: -40 }, { x: -30, y: 3.4, z: 10 },
      { x: 14, y: 5.2, z: 46 }, { x: 58, y: 7.0, z: 12 }, { x: 88, y: 8.4, z: -34 },
      { x: A, y: 9.4, z: -52 },
    ],
  }];
  const props = [];
  const S = dress(props, rDress);
  // valley floor below the viaduct — the parapets are the guardrail now
  for (let i = 0; i < 5; i++) S('tree_pine', rTopo.range(-A, A), rTopo.range(-70, 70), rTopo.range(0, 6.28));
  if (rTopo.chance(0.7)) S('rock', rTopo.range(-60, 60), rTopo.range(-40, 40), rTopo.range(0, 6.28));
  return {
    name: 'switchback',
    world: { arena: A * 2 + 30, env: 'proving', ground: A + 30 },
    roads, props, lanes: lanesFrom(roads, rTopo, vBase), crossings: [],
  };
}

// School zone: a straight street past a school, crossings, parked cars, low
// speed. Lots of soft targets close to the kerb.
function topoSchoolZone(rTopo, rDress, vBase) {
  const A = 130;
  const roads = [{ w: 8, loop: 0, style: 1 | 2 | 4, pts: [{ x: -A, z: 0 }, { x: 0, z: 0 }, { x: A, z: 0 }] }];
  const props = [];
  const S = dress(props, rDress);
  S('shop', rTopo.range(-24, 24), -26, 0);
  S('bus_stop', 16, 8.4, Math.PI);
  S('sign_warn', -22, 7.6, Math.PI / 2);
  S('sign_speed', 30, 7.6, Math.PI / 2);
  S('sign_stop', -8, 7.4, 0);
  for (let i = 0; i < 6; i++) S('bollard', -30 + i * 12, 6.6, 0);
  for (let i = 0; i < 4; i++) S('tree_oak', -50 + i * 34, -13 - rTopo.range(0, 4), rTopo.range(0, 6.28));
  if (rTopo.chance(0.8)) S('bench', 24, 8.6, Math.PI);
  return {
    name: 'schoolzone',
    world: { arena: A * 2 + 20, env: 'proving', ground: A + 22 },
    roads, props, lanes: lanesFrom(roads, rTopo, Math.min(vBase, 9)), crossings: [],
  };
}

// Rural tram crossing: a road crossing a tram line at grade. The tram lane
// and the road lanes genuinely intersect, so this hosts crossing templates.
function topoTramCrossing(rTopo, rDress, vBase) {
  const A = 135;
  const roads = [
    { w: 8, loop: 0, style: 1, pts: [{ x: -A, z: 0 }, { x: -8, z: 0 }] },
    { w: 8, loop: 0, style: 1, pts: [{ x: 8, z: 0 }, { x: A, z: 0 }] },
    { w: 6.5, loop: 0, style: 0, pts: [{ x: 0, z: -A }, { x: 0, z: -8 }] },
    { w: 6.5, loop: 0, style: 0, pts: [{ x: 0, z: 8 }, { x: 0, z: A }] },
  ];
  const props = [];
  const S = dress(props, rDress);
  S('asphalt_patch', 0, 0, 0);
  S('toll_gate', 9.5, 6.5, 0);
  S('toll_gate', -9.5, -6.5, Math.PI);
  S('sign_warn', 13, 8.5, Math.PI / 2);
  for (let i = 0; i < 4; i++) S('tree_pine', rTopo.range(-70, 70), (i % 2 ? 1 : -1) * rTopo.range(20, 46), rTopo.range(0, 6.28));
  const mkl = (x0, z0, x1, z1, w, road) => {
    const pts = [];
    const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 2.5);
    for (let i = 0; i <= n; i++) pts.push(x0 + ((x1 - x0) * i) / n, z0 + ((z1 - z0) * i) / n);
    return { pts, len: Math.hypot(x1 - x0, z1 - z0), v: vBase, w, road };
  };
  const lanes = [
    mkl(-A, 2, A, 2, 8, 'ew'), mkl(A, -2, -A, -2, 8, 'ew'),
    mkl(-1.6, -A, -1.6, A, 6.5, 'ns'), mkl(1.6, A, 1.6, -A, 6.5, 'ns'),
  ];
  return {
    name: 'tramcrossing',
    world: { arena: A * 2 + 20, env: 'proving', ground: A + 22 },
    roads, props, lanes,
    crossings: [[0, 2], [0, 3], [1, 2], [1, 3]],
  };
}

// Parking lot: a wide apron with two aisles meeting, everything slow and
// close together. Fender-benders, not highway wrecks.
function topoParkingLot(rTopo, rDress, vBase) {
  const A = 100;
  const roads = [
    { w: 7, loop: 0, style: 0, pts: [{ x: -A, z: -10 }, { x: 0, z: -10 }, { x: A, z: -10 }] },
    { w: 7, loop: 0, style: 0, pts: [{ x: -A, z: 16 }, { x: 0, z: 16 }, { x: A, z: 16 }] },
  ];
  const props = [];
  const S = dress(props, rDress);
  S('shop', 0, -40, 0);
  for (let i = 0; i < 9; i++) S('lamp_cobra', -64 + i * 16, 3, 0);
  for (let i = 0; i < 6; i++) S('planter_stone', -50 + i * 20, 26, 0);
  for (let i = 0; i < 5; i++) S('bollard', -30 + i * 15, -22, 0);
  return {
    name: 'parkinglot',
    world: { arena: A * 2 + 20, env: 'proving', ground: A + 22 },
    roads, props, lanes: lanesFrom(roads, rTopo, Math.min(vBase, 8.5)), crossings: [],
  };
}

// Roundabout: a ring with four approach stubs. Stubs stop just outside the
// ring's outer edge — overlapping asphalt z-fights — and a patch hides the
// seam. Approach lanes cross each other, which is what makes it bettable.
function topoRoundabout(rTopo, rDress, vBase) {
  const A = 128, R = 21;
  const ring = { pts: [], w: 8, loop: 1, style: 0 };
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ring.pts.push({ x: Math.cos(a) * R, z: Math.sin(a) * R });
  }
  const G = R + 4.4; // just clear of the ring's outer edge
  const roads = [ring,
    { w: 8, loop: 0, style: 1, pts: [{ x: -A, z: 0 }, { x: -G, z: 0 }] },
    { w: 8, loop: 0, style: 1, pts: [{ x: G, z: 0 }, { x: A, z: 0 }] },
    { w: 7, loop: 0, style: 0, pts: [{ x: 0, z: -A }, { x: 0, z: -G }] },
    { w: 7, loop: 0, style: 0, pts: [{ x: 0, z: G }, { x: 0, z: A }] },
  ];
  const props = [];
  const S = dress(props, rDress);
  S('asphalt_patch', 0, 0, 0);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    S('sign_yield', Math.cos(a) * (R + 7), Math.sin(a) * (R + 7), a);
  }
  S('tree_oak', 0, 0, rTopo.range(0, 6.28)); // the island
  if (rTopo.chance(0.7)) S('hedge', 6, 4, rTopo.range(0, 6.28));
  // straight approach lanes across the whole span: entering traffic conflicts
  const mkl = (x0, z0, x1, z1, w, road) => {
    const pts = [];
    const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 2.5);
    for (let i = 0; i <= n; i++) pts.push(x0 + ((x1 - x0) * i) / n, z0 + ((z1 - z0) * i) / n);
    return { pts, len: Math.hypot(x1 - x0, z1 - z0), v: vBase, w, road };
  };
  const lanes = [
    mkl(-A, 2, A, 2, 8, 'ew'), mkl(A, -2, -A, -2, 8, 'ew'),
    mkl(-1.75, -A, -1.75, A, 7, 'ns'), mkl(1.75, A, 1.75, -A, 7, 'ns'),
  ];
  return {
    name: 'roundabout',
    world: { arena: A * 2 + 20, env: 'city', ground: A + 22 },
    roads, props, lanes,
    crossings: [[0, 2], [0, 3], [1, 2], [1, 3]],
  };
}

/* ---------------- placement ---------------- */
// Put a car on `lane` so it reaches arc `sAnchor` at `tick` while cruising at
// v. If the run-up doesn't fit the lane, v is reduced to make it fit (the
// caller reads back spec._v). Returns a scenario car spec (type/seed added
// later by the cast pass).
function place(lane, sAnchor, v, tick = INCIDENT_TICK, end = 'coast') {
  const need = (tick / 60) * v;
  let vv = v;
  // If the run-up doesn't fit, slow the car down so it still arrives EXACTLY
  // at `tick`. The old MIN_V floor here silently broke that promise: once the
  // floor bound, s0 clamped to the lane start and the car arrived early — a
  // pullout victim reached the parked car at tick 599 and rear-ended it
  // before the incident, violating the nothing-collides-before-600 invariant.
  // Lanes are pre-filtered by solveApproach for a 600-tick run, but templates
  // that aim PAST T=0 (pullout budgets T+42 and up) need more road than that
  // check guarantees, so on-time arrival has to outrank the speed floor.
  // In practice this only gives up ~0.5 m/s: a lane that clears solveApproach
  // holds ≥75 m, so the worst case lands near 7 m/s, not a crawl.
  if (need > sAnchor - 3) vv = Math.max(2, (sAnchor - 3) / (tick / 60));
  const s0 = Math.max(0.5, sAnchor - (tick / 60) * vv);
  const p = arcPos(lane.pts, s0);
  return {
    x: p.x, y: arcY(lane, s0), z: p.z, heading: p.heading, speed: vv,
    drive: { pts: slicePts(lane.pts, s0), v: vv, end, cmds: [] },
    _lane: lane, _s0: s0, _v: vv, _anchor: sAnchor,
  };
}
// spawn-based placement: the car starts at arc s0 already cruising at v.
// Used for convoys — gaps stay exact because nobody's speed gets clamped.
// Returns null when the spot doesn't exist: silent clamping stacked cars on
// top of each other at lane starts (learned from the first sweep).
function placeAt(lane, s0, v, end = 'coast') {
  if (s0 < 1) return null;
  const p = arcPos(lane.pts, s0);
  return {
    x: p.x, y: arcY(lane, s0), z: p.z, heading: p.heading, speed: v,
    drive: { pts: slicePts(lane.pts, s0), v, end, cmds: [] },
    _lane: lane, _s0: s0, _v: v, _anchor: s0 + 10 * v,
  };
}
// stationary car parked at arc s (facing along the lane), driver holding still
function placeParked(lane, s, end = 'stop') {
  const p = arcPos(lane.pts, s);
  return {
    x: p.x, y: arcY(lane, s), z: p.z, heading: p.heading, speed: 0,
    drive: { pts: slicePts(lane.pts, s), v: 0, end, cmds: [] },
    _lane: lane, _s0: s, _v: 0, _anchor: s,
  };
}
const cmd = (spec, c) => { spec.drive.cmds.push(c); return spec; };

/* ---------------- incident templates ----------------
   Each returns { cars, label, tell, aggressor, victim } — cars in a fixed
   order, aggressor/victim as indices into that array. `tellK` scales how
   loud the tell is (low difficulty = loud). All triggers land at tick 600. */
const TEMPLATES = {
  // a car simply does not stop for the junction — classic T-bone
  redlight: {
    topos: ['intersection', 'tramcrossing', 'roundabout'],
    make(ctx) {
      const { rng, topo, tellK } = ctx;
      const [ia, ib] = rng.pick(topo.crossings);
      const vic = topo.lanes[ia], agg = topo.lanes[ib];
      const x = crossOf(vic, agg);
      // both hold constant speed, so the arrival math is exact — the tell IS
      // the speed differential (the runner approaches visibly hot and simply
      // never begins to slow for the light). Speeds are capped by the actual
      // run-up each arm offers.
      const vVic = Math.min(vic.v, laneMaxV(vic, x.sA));
      const vAgg = Math.min(13 + 3 * tellK + rng.range(0, 2), laneMaxV(agg, x.sB));
      // both aim at the SAME arrival tick (±3): a runner that clears the box
      // first only gets its tail clipped, which reads as a scrape, not a T-bone
      const tMeet = INCIDENT_TICK + rng.int(14, 22);
      const victim = place(vic, x.sA, vVic, tMeet);
      const runner = place(agg, x.sB, vAgg, tMeet + rng.int(-3, 3));
      // someone waiting properly at the light on the opposite approach
      const otherMinor = topo.lanes[ia < 2 ? (ib === 2 ? 3 : 2) : (ib === 0 ? 1 : 0)];
      const waiter = placeParked(otherMinor, Math.max(6, crossOf(vic, otherMinor).sB - 10));
      return { cars: [victim, runner, waiter], aggressor: 1, victim: 0, label: 'Red-Light Runner', tell: 'one approach never slows down' };
    },
  },
  // lead car slams the brakes, the queue concertinas
  chain: {
    topos: ['suburb', 'city', 'highway', 'intersection', 'causeway', 'switchback', 'schoolzone', 'tramcrossing', 'roundabout', 'parkinglot'],
    minLane: 115,
    make(ctx) {
      const { rng, tellK, lane } = ctx;
      let k = 2 + Math.min(3, (ctx.d >> 1)) + rng.int(0, 1); // 2..5 followers
      // convoy speed solved from the lane: run-up AND the whole queue behind
      // the lead must fit, or followers stack up at the lane start. The queue
      // size is ALSO capped so the solved speed stays ≥ 6.5 m/s — a 6-car
      // convoy on a short suburb loop crawled at 4 m/s and its soft late
      // brakes stopped everyone safely (eventless chain scenes in the sweep)
      const ap = ctx.approach;
      k = clamp(k, 1, Math.max(1, Math.floor((ap.anchorS - 69) / 12.3)));
      const v = Math.min(ap.v, (ap.anchorS - 4 - 4.5 * k) / (10 + 1.2 * k));
      const lead = place(lane, ap.anchorS, v);
      cmd(lead, { t: INCIDENT_TICK, v: 0, brakeMax: 4.5 }); // full emergency slam
      lead._short = true; // tight convoy: short vehicles only (spawn safety)
      const cars = [lead];
      // followers spawn as a rolling convoy behind the lead — exact gaps, one
      // shared speed (a clamped speed anywhere here would close a gap early)
      let gap = 0;
      for (let i = 0; i < k; i++) {
        // loud tell = the pack is visibly nose-to-tail
        // headway shrinks with difficulty; the floor is spawn-safety, not taste
        gap += Math.max(8.5, lead._v * (0.5 + rng.range(0, 0.26) - 0.12 * tellK) + 4.5);
        const f = placeAt(lane, lead._s0 - gap, lead._v);
        if (!f) break; // lane too short for more of a queue
        // tailgaters react LATE and brake softly — matching the lead's
        // authority anywhere in the queue just stops the whole convoy safely
        cmd(f, { t: INCIDENT_TICK + 52 + i * (20 + rng.int(0, 16)), v: 0, brakeMax: 0.55 });
        f._short = true;
        cars.push(f);
      }
      return { cars, aggressor: 0, victim: 1, label: 'Chain Rear-End', tell: 'the queue is packed nose-to-tail' };
    },
  },
  // front tire lets go — the car carves across the road
  blowout: {
    topos: ['suburb', 'city', 'highway', 'intersection', 'causeway', 'switchback', 'schoolzone', 'tramcrossing', 'roundabout'],
    needsOpp: true, // the carve needs oncoming geometry to be worth watching
    make(ctx) {
      const { rng, tellK, lane, opp, approach } = ctx;
      // prefer true head-on geometry; fall back to a solo run off the road
      const ho = solveHeadOn(lane, opp);
      // no oncoming partner → the follower is the ONLY victim, so budget the
      // speed so run-up (10·v) plus the follow gap (1.25·v+5) always fits the
      // lane — otherwise placeAt fails and the swerve plays out on empty road
      const vSolo = Math.max(MIN_V, Math.min(approach.v, (approach.anchorS - 6) / 11.25));
      const carA = ho ? place(lane, ho.aS, ho.v) : place(lane, approach.anchorS, vSolo);
      if (tellK > 0.8) { // loud tell: a pre-wobble in the lane
        // right-leaning (negative = shoulder side): a left-first wobble
        // wandered a semi into oncoming traffic 50 ticks early (dev20 d1)
        cmd(carA, { t: 470, bias: -0.022 });
        cmd(carA, { t: 505, bias: 0.02 });
        cmd(carA, { t: 540, bias: -0.012 });
      }
      const cars = [carA];
      let victimIdx = -1;
      const side = ho ? 1 : rng.sign(); // + = left = across the centre line
      cmd(carA, { t: INCIDENT_TICK, bias: side * 0.09, off: true });
      cmd(carA, { t: INCIDENT_TICK + 14, bias: side * (0.24 + rng.range(0, 0.05)) });
      if (ho) {
        // arrival window: the pair closes at COMBINED speed, so a victim
        // arriving at the meet point at T+n actually passes the aggressor at
        // ~T+n/2 — and the carve needs ~40–50 ticks to occupy the oncoming
        // lane. Low d sits on the sweet spot; high d widens into honest maybes.
        const lo = Math.round(62 + 10 * tellK);
        const hi = lo + 16 + Math.round(42 * (1.3 - tellK));
        const oc = place(opp, ho.oS, ho.v, INCIDENT_TICK + rng.int(lo, hi));
        victimIdx = cars.push(oc) - 1;
      }
      // with no oncoming car the follower is the ONLY thing to hit, so it is
      // mandatory there — solo scenes otherwise record zero events
      if (!ho || rng.chance(0.6)) {
        const f = placeAt(lane, carA._s0 - Math.max(9, carA._v * 1.25 + 5), carA._v);
        if (f) { f._short = true; carA._short = true; if (victimIdx < 0) victimIdx = cars.length; cars.push(f); }
      }
      return { cars, aggressor: 0, victim: victimIdx, label: 'Tire Blowout', tell: 'watch the front wheels wander' };
    },
  },
  // slow drift out of lane, then a panicked overcorrection
  drowsy: {
    topos: ['suburb', 'city', 'highway', 'intersection', 'causeway', 'switchback', 'schoolzone', 'tramcrossing', 'roundabout', 'parkinglot'],
    needsOpp: true, // ditto — a solo drift into empty grass is a non-scene
    make(ctx) {
      const { rng, tellK, lane, opp, approach } = ctx;
      const ho = solveHeadOn(lane, opp);
      // same follower-fits budget as blowout (gap 1.3·v+5 → /11.3)
      const vSolo = Math.max(MIN_V, Math.min(approach.v, (approach.anchorS - 6) / 11.3));
      const carA = ho ? place(lane, ho.aS, ho.v) : place(lane, approach.anchorS, vSolo);
      // drift RIGHT toward the shoulder (the tell), panic-yank LEFT across
      // the road — the classic pattern, and the yank aims at oncoming
      cmd(carA, { t: 500, bias: -(0.012 + 0.02 * tellK) });
      // the yank is OFF-path: with the driver still tracking the lane, pure
      // pursuit cancels the bias and the car never leaves its lane (max ~1 m
      // of incursion in the dev0 trace — the head-on could never land)
      cmd(carA, { t: INCIDENT_TICK, bias: 0.26 + rng.range(0, 0.05), off: true }); // panic yank left
      cmd(carA, { t: INCIDENT_TICK + 40, bias: -0.12 }); // flail back
      cmd(carA, { t: INCIDENT_TICK + 85, bias: 0 });
      cmd(carA, { t: INCIDENT_TICK + 150, off: false, bias: 0 }); // snaps awake
      const cars = [carA];
      let victimIdx = -1;
      // the oncoming victim is unconditional when the geometry exists — an
      // 85 % chance here left 1-in-7 drowsy scenes with nothing to hit.
      // Arrival window: same combined-closing-speed math as blowout.
      if (ho) {
        const lo = Math.round(62 + 10 * tellK);
        const hi = lo + 16 + Math.round(42 * (1.3 - tellK));
        const oc = place(opp, ho.oS, ho.v, INCIDENT_TICK + rng.int(lo, hi));
        victimIdx = cars.push(oc) - 1;
      }
      // mandatory when there is no oncoming victim (see blowout)
      if (victimIdx < 0 || rng.chance(0.6)) {
        const f = placeAt(lane, carA._s0 - Math.max(9, carA._v * 1.3 + 5), carA._v);
        if (f) { f._short = true; carA._short = true; if (victimIdx < 0) victimIdx = cars.length; cars.push(f); }
      }
      return { cars, aggressor: 0, victim: victimIdx, label: 'Drowsy Drift', tell: 'someone is creeping out of their lane' };
    },
  },
  // way too fast into a bend the road can't forgive. Genuinely uncertain —
  // the car often gathers it up with two wheels on the grass — so it only
  // deals at d ≥ 5, where "does it actually crash?" IS the market (the
  // near-miss band of the spec). Low difficulties need reliable converters.
  overspeed: {
    // city only: suburb loop apexes sit against side streets, so the catcher
    // guard strips them and the 200-sweep's only eventless scenes were all
    // suburb overspeeds. City corners keep their furniture.
    topos: ['city', 'switchback', 'causeway'],
    needsCurve: true,
    minD: 5,
    make(ctx) {
      const { rng, tellK, lane, curveS } = ctx;
      const vApp = Math.min(lane.v + 2 + 2.5 * tellK, laneMaxV(lane, curveS));
      const carA = place(lane, curveS, vApp);
      // the surge starts LATE: accelerating from t520 made the car reach the
      // apex ~40 ticks early and clip its own catchers pre-600. The elevated
      // cruise speed is the visible tell; the surge is just the final commit.
      cmd(carA, { t: 585, v: Math.min(26, carA._v + 10 + ctx.d * 0.7) });
      cmd(carA, { t: INCIDENT_TICK + 60, v: lane.v }); // (they'd lift — too late)
      // street furniture on the OUTSIDE of the bend, right in the overshoot
      // path — the generated dressing is scrubbed off the lanes, so a car
      // flying off the apex used to plough through empty grass (maxDv ~1.8,
      // never a crash). The catchers make the corner consequential.
      const aIn = arcPos(lane.pts, Math.max(0, curveS - 8));
      const aOut = arcPos(lane.pts, curveS + 8);
      let dh = aOut.heading - aIn.heading;
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      const turnL = dh > 0; // turning left → overshoot to the RIGHT
      const props = [];
      for (let k = 0; k < 3; k++) {
        const p = arcPos(lane.pts, curveS + 5 + k * 8);
        // lane-left normal is (sin h, cos h)·… — derive from heading directly
        const lx = -Math.sin(p.heading), lz = -Math.cos(p.heading);
        const s = turnL ? -1 : 1; // outside of the bend
        // the overshoot band is only ~2.5–5 m outside the lane line (traced:
        // the car plows ~4 m wide, parallel to anything further out), and
        // only massive/bolted kinds register a real Δv on the car
        const off = 2.7 + k * 1.2 + rng.range(0, 0.8);
        const px = p.x + s * lx * off, pz = p.z + s * lz * off;
        // never inside an existing dressing prop (two overlapping dynamic
        // bodies explode on spawn)
        if (ctx.topo.props.some((q) => (q.x - px) ** 2 + (q.z - pz) ** 2 < 2.4 * 2.4)) continue;
        // never inside ANY OTHER lane's corridor — the outside of a city-loop
        // bend can be another street, and normal preview traffic mowed the
        // catchers down at tick 84 (6 pre-600 violations in one sweep)
        let onLane = false;
        for (const l of ctx.topo.lanes) {
          if (l === lane || onLane) continue;
          for (let i = 0; i < l.pts.length; i += 2) {
            if ((l.pts[i] - px) ** 2 + (l.pts[i + 1] - pz) ** 2 < 3.4 * 3.4) { onLane = true; break; }
          }
        }
        if (onLane) continue;
        props.push({
          kind: rng.pick(['tree_oak', 'lamp_cobra', 'hydrant']),
          x: px, z: pz,
          heading: rng.range(0, 6.28), seed: String(rng.int(1, 9999)),
        });
      }
      return { cars: [carA], props, aggressor: 0, victim: -1, label: 'Overspeed Corner', tell: 'count how fast that one is going' };
    },
  },
  // parked car noses into traffic without looking
  pullout: {
    topos: ['suburb', 'city', 'intersection', 'schoolzone', 'parkinglot', 'roundabout', 'tramcrossing'],
    make(ctx) {
      const { rng, tellK, lane, approach } = ctx;
      const sMerge = approach.anchorS;
      // the pullout takes ~1.5–2.5 s to occupy the lane, so the victim is
      // budgeted to arrive ~90 ticks after T=0; it reacts late and brakes
      // only weakly (a full-authority stop would defuse the whole scene)
      // closing room scales with difficulty: at low d the victim arrives
      // while the pullout is mid-lane and its weak late brake can't save it
      // (a T-bone); at high d it arrives later and genuinely might stop short
      // (a fender tap or clean stop — real uncertainty, not a coin flip)
      const lo = 42 + Math.round(18 * (1.3 - tellK));
      const victim = place(lane, sMerge, approach.v, INCIDENT_TICK + rng.int(lo, lo + 16 + Math.round(16 * (1.3 - tellK))));
      // reaction time scales with how slow the road is: a 9 m/s city victim
      // braking at the same tick as a 12.5 m/s one simply stops short (every
      // city/suburb pullout defused while every intersection one converted)
      const react = INCIDENT_TICK + rng.int(30, 44) + Math.round(Math.max(0, 12.5 - victim._v) * 9);
      cmd(victim, { t: react, v: 0, brakeMax: 0.35 });
      // the parked car sits off the shoulder and noses ACROSS the lane on its
      // own short path, stalling broadside in the victim's way. (Driving it
      // along the lane instead just accelerates it away from its own victim —
      // the pullout never converted until this was a crossing path.)
      const pp = arcPos(lane.pts, sMerge + 5);
      const ph = arcPos(lane.pts, sMerge + 11);
      let nx = -(ph.z - pp.z), nz = ph.x - pp.x; // right of travel
      const nl = Math.hypot(nx, nz) || 1;
      nx /= nl; nz /= nl;
      const off = lane.w / 4 + 2.2;
      const px = pp.x + nx * off, pz = pp.z + nz * off;
      // path: from the shoulder straight across the lane and a little beyond
      const cross = [px, pz];
      for (let k = 1; k <= 4; k++) cross.push(px - nx * (off + 1.2) * (k / 4) * 1.35, pz - nz * (off + 1.2) * (k / 4) * 1.35);
      const parked = {
        x: px, z: pz,
        // heading for direction (dx,dz) is atan2(-dz,dx); the crossing
        // direction is (-nx,-nz) → atan2(nz,-nx). A stray +π here spawned it
        // facing the shoulder, and it drove AWAY from its own victim (dev1)
        heading: Math.atan2(nz, -nx), // facing across, into the lane
        speed: 0,
        drive: {
          pts: cross, v: 0, end: 'stop',
          cmds: [{ t: INCIDENT_TICK, v: 5.5 }],
        },
        _lane: lane, _s0: sMerge + 5, _v: 0, _anchor: sMerge,
      };
      return { cars: [victim, parked], aggressor: 1, victim: 0, label: 'Blind Pullout', tell: 'that parked car is angled out' };
    },
  },
  // a chase barrels through — the PIT lands around T=0
  police: {
    topos: ['suburb', 'city', 'highway', 'intersection', 'causeway', 'switchback', 'schoolzone', 'tramcrossing', 'roundabout', 'parkinglot'],
    minLane: 115,
    make(ctx) {
      const { rng, lane, approach } = ctx;
      // the cop needs ~9 m of lane behind the runner's spawn, so the run-up
      // budget shrinks by that much
      const v = Math.min(15, approach.v, (approach.anchorS - 13) / 10);
      const runner = place(lane, approach.anchorS, v);
      runner._pool = 'FAST';
      // weave amplitude respects the lane: full flourish on straights, half
      // on bends — weave + corner drift ran the tp49 runner into a tree at
      // t269, three metres off the scrubbed corridor
      let maxK = 0;
      for (let s = runner._s0 + 6; s < approach.anchorS; s += 10) maxK = Math.max(maxK, curvatureAt(lane.pts, s));
      const wAmp = maxK > 0.018 ? 0.022 : 0.045;
      for (let t = 240; t < 600; t += 90) cmd(runner, { t, bias: (t % 180 === 60 ? 1 : -1) * wAmp }); // weaving
      cmd(runner, { t: 590, bias: 0 });
      // the cop lunges hard at T=0 and clips a rear quarter before the runner
      // reacts — the small bias turns the rear-end into a PIT-style spin
      cmd(runner, { t: INCIDENT_TICK + 55, v: runner._v + 6 }); // reacts too late
      runner._short = true;
      const cop = placeAt(lane, runner._s0 - (8.5 + rng.range(0, 2)), runner._v);
      if (!cop) { // degenerate lane: no chase, just the runner losing it
        cmd(runner, { t: INCIDENT_TICK, bias: 0.14, off: true });
        return { cars: [runner], aggressor: 0, victim: -1, label: 'Police Chase', tell: 'the lights are already flashing' };
      }
      cop._pool = 'POLICE';
      // the lunge starts just before T=0 so the closing speed is real by
      // contact (~T+40..70 from an 8.5 m gap at ~3 m/s² — never pre-600; a
      // lunge that began AT 600 arrived with Δv under the crash threshold)
      cmd(cop, { t: INCIDENT_TICK - 28, v: runner._v + 14, brakeMax: 0 });
      cmd(cop, { t: INCIDENT_TICK + 20, bias: rng.sign() * 0.035 });
      const cars = [runner, cop];
      return { cars, aggressor: 1, victim: 0, label: 'Police Chase', tell: 'the lights are already flashing' };
    },
  },
  // pedals go soft right when the queue appears
  brakefail: {
    // no switchback: a parked queue on a hairpin sits beside the folded-back
    // leg and gets clipped before the incident
    topos: ['suburb', 'city', 'highway', 'intersection', 'causeway', 'schoolzone', 'tramcrossing', 'roundabout', 'parkinglot'],
    minLane: 115,
    make(ctx) {
      const { rng, tellK, lane, approach } = ctx;
      // the queue sits at the anchor; the failing car must arrive AT the
      // queue's tail, 13 m short of it, still at full speed
      const sQueue = approach.anchorS;
      const v = Math.min(approach.v + 1 + 2 * tellK, laneMaxV(lane, sQueue - 17));
      // gaps ≥ 8 m and short vehicles only: placement happens before the cast
      // pass, and a 12 m bus in a 7 m gap spawns INSIDE the car ahead
      const q1 = placeParked(lane, sQueue);
      const q2 = placeParked(lane, sQueue - 8.5);
      const carA = place(lane, sQueue - 17, v);
      q1._short = q2._short = carA._short = true;
      cmd(carA, { t: 552, noBrake: true }); // the failure — invisible until needed
      cmd(carA, { t: 585, v: 0 }); // driver stands on a dead pedal
      return { cars: [carA, q2, q1], aggressor: 0, victim: 1, label: 'Brake Failure', tell: 'no brake dive where there should be' };
    },
  },

  /* ---------------- G4: incident library 8 → 20 ----------------
     Same contract as above: cars in a fixed order, everything goes wrong at
     exactly INCIDENT_TICK, nothing may touch before it. Where a template
     needs an obstacle it returns `props` (merged into the topology dressing),
     and it must keep those clear of other lanes — normal preview traffic will
     happily mow down a badly placed catcher (learned by overspeed). */

  // a heavy stands on the brakes and the back end comes around
  jackknife: {
    topos: ['highway', 'causeway', 'city', 'suburb', 'intersection', 'tramcrossing'],
    minLane: 130,
    make(ctx) {
      const { rng, tellK, lane, approach } = ctx;
      const v = Math.min(approach.v + 2, laneMaxV(lane, approach.anchorS));
      const rig = place(lane, approach.anchorS, v);
      rig._pool = 'HEAVY'; // cast pass: this one must be a truck
      if (tellK > 0.9) cmd(rig, { t: 500, bias: -0.014 }); // a hint of wander
      cmd(rig, { t: INCIDENT_TICK, v: 0, brakeMax: 4.2 });
      cmd(rig, { t: INCIDENT_TICK + 8, bias: rng.sign() * 0.3, off: true });
      const cars = [rig];
      const follow = placeAt(lane, rig._s0 - Math.max(16, v * 1.5), v);
      if (follow) { cmd(follow, { t: INCIDENT_TICK + 44, v: 0, brakeMax: 0.7 }); cars.push(follow); }
      return { cars, aggressor: 0, victim: cars.length > 1 ? 1 : -1, label: 'Jackknife', tell: 'that trailer is moving faster than the cab' };
    },
  },

  // a flatbed sheds its load into the lane behind it
  loadspill: {
    topos: ['highway', 'causeway', 'city', 'suburb', 'intersection'],
    minLane: 125,
    make(ctx) {
      const { rng, lane, approach } = ctx;
      const v = Math.min(approach.v, laneMaxV(lane, approach.anchorS));
      const truck = place(lane, approach.anchorS, v);
      truck._pool = 'HEAVY';
      cmd(truck, { t: INCIDENT_TICK, bias: rng.sign() * 0.05, off: true });
      const cars = [truck];
      const chaser = placeAt(lane, truck._s0 - Math.max(22, v * 2.1), v);
      if (chaser) cars.push(chaser);
      // the load lands just behind the truck's incident position
      const props = [];
      const sDrop = approach.anchorS + 5;
      for (let i = 0; i < 4; i++) {
        const p = arcPos(lane.pts, sDrop + i * 2.6);
        props.push({
          kind: rng.pick(['cone', 'bin_wheelie', 'planter_stone']),
          x: p.x + rng.range(-1.4, 1.4), y: arcY(lane, sDrop + i * 2.6), z: p.z + rng.range(-1.4, 1.4),
          heading: rng.range(0, 6.28), seed: String(rng.int(1, 9999)),
        });
      }
      return { cars, props, aggressor: 0, victim: cars.length > 1 ? 1 : -1, label: 'Load Spill', tell: 'that load is not tied down' };
    },
  },

  // police contact: the pursuit ends with a nudge that spins the runner
  pit: {
    topos: ['highway', 'suburb', 'city', 'causeway', 'intersection', 'parkinglot'],
    minLane: 120, minD: 4,
    make(ctx) {
      const { rng, lane, approach } = ctx;
      const v = Math.min(approach.v + 2, laneMaxV(lane, approach.anchorS));
      const runner = place(lane, approach.anchorS, v);
      const cop = placeAt(lane, runner._s0 - 8.5, v);
      const cars = [runner];
      if (cop) {
        cop._pool = 'POLICE';
        cmd(cop, { t: INCIDENT_TICK - 40, v: v + 2.5 });        // close the gap
        cmd(cop, { t: INCIDENT_TICK, bias: 0.11, off: true });   // swing out
        cmd(cop, { t: INCIDENT_TICK + 12, bias: -0.28, off: true }); // and in
        cars.push(cop);
      }
      cmd(runner, { t: INCIDENT_TICK + 16, bias: rng.sign() * 0.26, off: true });
      return { cars, aggressor: cars.length > 1 ? 1 : 0, victim: 0, label: 'PIT Maneuver', tell: 'the cruiser is lining up on a corner' };
    },
  },

  // somebody is coming the other way in your lane
  wrongway: {
    topos: ['highway', 'causeway', 'suburb', 'city', 'intersection', 'switchback'],
    needsOpp: true, minD: 3,
    make(ctx) {
      const { rng, tellK, lane, opp } = ctx;
      const ho = solveHeadOn(lane, opp);
      const carA = place(lane, ho.aS, ho.v);
      // the wrong-way car rides the centre line from the start — the tell is
      // that it is simply on the wrong side, visible the whole preview
      const ghost = place(opp, ho.oS, ho.v * 0.9, INCIDENT_TICK + rng.int(70, 110));
      cmd(ghost, { t: 576, bias: 0.08 * tellK, off: true });
      cmd(ghost, { t: INCIDENT_TICK, bias: 0.22, off: true });
      return { cars: [carA, ghost], aggressor: 1, victim: 0, label: 'Wrong Way', tell: 'one of them is on the wrong side of the line' };
    },
  },

  // one tailgater, one lift-off — a plain two-car rear-ender
  tailgate: {
    topos: ['highway', 'causeway', 'city', 'suburb', 'schoolzone', 'roundabout', 'tramcrossing', 'parkinglot'],
    minLane: 140, // both cars plus a 10 s run-up must fit, or the tail is
                  // dropped and the scene is one car braking gently: eventless
    make(ctx) {
      const { rng, tellK, lane, approach } = ctx;
      // Solve the speed so the run-up AND the gap behind the lead both fit,
      // the way chain does. Without this the lead's 10 s approach consumed the
      // whole lane, placeAt found no room, the tail was dropped and the scene
      // was one car braking alone — 9 eventless in a 300-seed sweep.
      const v = Math.min(approach.v, laneMaxV(lane, approach.anchorS), (approach.anchorS - 10) / 11.2);
      const lead = place(lane, approach.anchorS, v);
      cmd(lead, { t: INCIDENT_TICK, v: 0, brakeMax: 4.2 });
      lead._short = true;
      const gap = Math.max(6.2, v * (0.28 - 0.08 * tellK) + 3.4);
      const tail = placeAt(lane, lead._s0 - gap, v);
      const cars = [lead];
      if (tail) {
        tail._short = true;
        cmd(tail, { t: INCIDENT_TICK + 34 + rng.int(0, 14), v: 0, brakeMax: 0.5 });
        cars.push(tail);
      }
      return { cars, aggressor: cars.length > 1 ? 1 : 0, victim: 0, label: 'Tailgater', tell: 'no room at all between those two' };
    },
  },

  // a dead car sitting in a live lane
  stall: {
    topos: ['highway', 'causeway', 'city', 'suburb', 'intersection', 'tramcrossing', 'switchback'],
    minLane: 120,
    make(ctx) {
      const { rng, tellK, lane, approach } = ctx;
      const sDead = approach.anchorS;
      const dead = placeParked(lane, sDead);
      dead._short = true;
      const v = Math.min(approach.v + 2 + tellK, laneMaxV(lane, sDead - 11));
      const comer = place(lane, sDead - 11, v);
      // brakes far too late — the tell is that nothing is slowing down
      cmd(comer, { t: INCIDENT_TICK + 14, v: 0, brakeMax: 0.7 });
      const cars = [comer, dead];
      const props = [];
      if (rng.chance(0.6)) {
        const p = arcPos(lane.pts, sDead + 5);
        props.push({ kind: 'cone', x: p.x, y: arcY(lane, sDead + 5), z: p.z, heading: 0, seed: String(rng.int(1, 9999)) });
      }
      return { cars, props, aggressor: 0, victim: 1, label: 'Stalled Car', tell: 'that one has not moved all preview' };
    },
  },

  // unprotected left across oncoming traffic
  leftturn: {
    topos: ['intersection', 'tramcrossing', 'roundabout'],
    minD: 2,
    make(ctx) {
      const { rng, topo, tellK } = ctx;
      const [ia, ib] = rng.pick(topo.crossings);
      const thru = topo.lanes[ia], turner = topo.lanes[ib];
      const x = crossOf(thru, turner);
      const vT = Math.min(thru.v + 1 + tellK, laneMaxV(thru, x.sA));
      const vU = Math.min(turner.v * 0.72, laneMaxV(turner, x.sB));
      const tMeet = INCIDENT_TICK + rng.int(12, 20);
      const straight = place(thru, x.sA, vT, tMeet);
      const turning = place(turner, x.sB, vU, tMeet + rng.int(-4, 4));
      // the turn itself: slow, then cut across
      cmd(turning, { t: INCIDENT_TICK - 26, v: vU * 0.5 });
      cmd(turning, { t: INCIDENT_TICK, bias: 0.24, off: true });
      return { cars: [straight, turning], aggressor: 1, victim: 0, label: 'Unprotected Left', tell: 'the turner never checks the gap' };
    },
  },

  // a tall vehicle carries too much speed into a bend and goes up on two wheels
  rollover: {
    topos: ['switchback', 'city', 'suburb', 'highway', 'causeway'],
    needsCurve: true, minD: 3,
    make(ctx) {
      const { rng, tellK, lane, curveS } = ctx;
      const sBend = curveS || Math.min(lane.len - 30, lane.v * 10 + 25);
      const v = Math.min(laneMaxV(lane, sBend), lane.v + 4);
      const tall = place(lane, sBend, v);
      tall._pool = 'HEAVY'; // a high centre of gravity is the whole point
      cmd(tall, { t: INCIDENT_TICK, bias: rng.sign() * 0.16, off: true });
      cmd(tall, { t: INCIDENT_TICK + 18, v: v * 0.4, brakeMax: 3.4 });
      return { cars: [tall], aggressor: 0, victim: -1, label: 'Rollover', tell: 'far too tall for that much speed' };
    },
  },

  // late braking into a stopped queue — the driver simply never saw it
  sunblind: {
    topos: ['highway', 'causeway', 'city', 'suburb', 'schoolzone', 'intersection'],
    minLane: 125,
    make(ctx) {
      const { rng, lane, approach } = ctx;
      const sQ = approach.anchorS;
      const q1 = placeParked(lane, sQ);
      const q2 = placeParked(lane, sQ - 9);
      const v = Math.min(approach.v + 3, laneMaxV(lane, sQ - 15));
      const comer = place(lane, sQ - 15, v);
      q1._short = q2._short = comer._short = true;
      cmd(comer, { t: INCIDENT_TICK + 22, v: 0, brakeMax: 0.9 }); // far too late
      return { cars: [comer, q2, q1], aggressor: 0, victim: 1, label: 'Never Saw It', tell: 'the queue is stopped and nobody is braking' };
    },
  },

  // something in the road; the swerve is worse than the obstacle
  debris: {
    topos: ['highway', 'causeway', 'suburb', 'city', 'switchback', 'intersection'],
    minLane: 120,
    make(ctx) {
      const { rng, lane, approach } = ctx;
      const v = Math.min(approach.v, laneMaxV(lane, approach.anchorS));
      const carA = place(lane, approach.anchorS, v);
      const side = rng.sign();
      cmd(carA, { t: INCIDENT_TICK, bias: side * 0.2, off: true });
      cmd(carA, { t: INCIDENT_TICK + 20, bias: -side * 0.26, off: true }); // overcorrect
      const props = [];
      const p = arcPos(lane.pts, approach.anchorS + 7);
      props.push({ kind: rng.pick(['rock', 'bin_wheelie', 'cone']), x: p.x, y: arcY(lane, approach.anchorS + 7), z: p.z, heading: rng.range(0, 6.28), seed: String(rng.int(1, 9999)) });
      const cars = [carA];
      const behind = placeAt(lane, carA._s0 - Math.max(18, v * 1.8), v);
      if (behind) cars.push(behind);
      return { cars, props, aggressor: 0, victim: cars.length > 1 ? 1 : -1, label: 'Debris Swerve', tell: 'there is something lying in the road' };
    },
  },

  // a merge into a lane that is already occupied
  merge: {
    topos: ['highway', 'causeway', 'city', 'suburb', 'roundabout', 'parkinglot'],
    needsOpp: false, minLane: 115,
    make(ctx) {
      const { rng, tellK, lane, approach } = ctx;
      const v = Math.min(approach.v, laneMaxV(lane, approach.anchorS));
      const held = place(lane, approach.anchorS, v);
      held._short = true;
      const merger = placeAt(lane, held._s0 - Math.max(8, v * 0.6), v * 1.18);
      const cars = [held];
      if (merger) {
        merger._short = true;
        // drift out, then back in on top of the car already there
        cmd(merger, { t: INCIDENT_TICK - 14, bias: 0.09 * tellK, off: true });
        cmd(merger, { t: INCIDENT_TICK, bias: -0.34, off: true });
        cars.push(merger);
      }
      return { cars, aggressor: cars.length > 1 ? 1 : 0, victim: 0, label: 'Bad Merge', tell: 'one of them is drifting toward an occupied lane' };
    },
  },

  // a launch off a ramp — does it clear what is on the far side?
  rampjump: {
    topos: ['highway', 'suburb', 'city', 'parkinglot', 'causeway'],
    minLane: 130, minD: 5,
    make(ctx) {
      const { rng, lane, approach } = ctx;
      const sRamp = approach.anchorS;
      const v = Math.min(approach.v + 6, laneMaxV(lane, sRamp));
      const carA = place(lane, sRamp - 5, v);
      const p = arcPos(lane.pts, sRamp);
      const props = [{ kind: 'ramp', x: p.x, y: arcY(lane, sRamp), z: p.z, heading: p.heading, seed: String(rng.int(1, 9999)) }];
      // a landing zone worth betting on
      const q = arcPos(lane.pts, sRamp + 11);
      props.push({ kind: rng.pick(['boxes', 'cone', 'barrier_water']), x: q.x, y: arcY(lane, sRamp + 11), z: q.z, heading: q.heading, seed: String(rng.int(1, 9999)) });
      return { cars: [carA], props, aggressor: 0, victim: -1, label: 'Ramp Jump', tell: 'that is a lot of speed at a ramp' };
    },
  },
};

/* ---------------- conflict scrub ----------------
   Nothing may collide before tick 600. Same-lane pairs are placed with
   matched speeds + headway by construction; this pass handles CROSSING
   lanes: any two cars whose paths intersect must clear the crossing point
   ≥ 1.6 s apart during the preview. Violators get pushed back along their
   lane (which delays their arrival); unresolvable extras are dropped. */
function scrubConflicts(cars, keep) {
  for (let pass = 0; pass < 6; pass++) {
    let moved = false;
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const A = cars[i], B = cars[j];
        if (!A || !B || A._lane === B._lane) continue;
        const x = crossOf({ pts: A.drive.pts }, { pts: B.drive.pts });
        if (x.dist > 3.2) continue;
        const idx = keep.has(j) ? (keep.has(i) ? -1 : i) : j;
        if (idx === -1) continue; // both essential: template timing owns this pair
        // merging/overlapping paths (not a point crossing): timing can't make
        // that safe — drop the non-essential car outright
        if (x.closeLen > 10) { cars[idx] = null; moved = true; continue; }
        const tA = A._v > 0.1 ? x.sA / A._v : 1e9;
        const tB = B._v > 0.1 ? x.sB / B._v : 1e9;
        if (Math.min(tA, tB) > 10.4 || Math.abs(tA - tB) * 60 >= 96) continue;
        // point crossing inside the preview: push the non-essential car back
        // 2 s worth of distance so the windows clear
        const C = cars[idx];
        const back = C._v * 2.2;
        if (C._s0 - back < 1) { cars[idx] = null; moved = true; continue; }
        C._s0 -= back;
        const p = arcPos(C._lane.pts, C._s0);
        // y must follow the push-back: the new spot is somewhere else on the
        // grade, and leaving the old height drops the car through the deck
        C.x = p.x; C.y = arcY(C._lane, C._s0); C.z = p.z; C.heading = p.heading;
        C.drive.pts = slicePts(C._lane.pts, C._s0);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return cars.filter(Boolean);
}

/* ---------------- the deal ---------------- */
export function generateScene(seed, d = 1) {
  d = clamp(Math.round(d), 1, 10);
  const rTopo = makeRng('scn:' + seed + ':topo');
  const rInc = makeRng('scn:' + seed + ':incident');
  const rCast = makeRng('scn:' + seed + ':cast');
  const rDress = makeRng('scn:' + seed + ':dress');
  const tellK = clamp(1.35 - d * 0.115, 0.2, 1.3); // 1.3 = loud tell, 0.2 = hairline

  // topology first (its own stream — reroll-safe)
  const topoName = rTopo.pick([
    'intersection', 'suburb', 'city', 'highway',
    'causeway', 'switchback', 'schoolzone', 'tramcrossing', 'parkinglot', 'roundabout',
  ]);
  const VB = {
    highway: 12.5, causeway: 12, switchback: 11, suburb: 10,
    schoolzone: 8.5, parkinglot: 7.8, tramcrossing: 11, roundabout: 9.5,
  };
  const vBase = VB[topoName] || 9;
  const BESPOKE = {
    intersection: topoIntersection, causeway: topoCauseway, switchback: topoSwitchback,
    schoolzone: topoSchoolZone, tramcrossing: topoTramCrossing,
    parkinglot: topoParkingLot, roundabout: topoRoundabout,
  };
  let topo = BESPOKE[topoName]
    ? BESPOKE[topoName](rTopo, rDress, vBase)
    : topoWorldgen(topoName, rTopo, vBase);
  // degenerate generated layout (no drivable lane)? fall back to the
  // intersection — deterministic, since the branch is itself seed-derived
  if (!topo.lanes.some((l) => solveApproach(l) !== null)) topo = topoIntersection(rTopo, rDress);

  // prop scrub: generated props that encroach on a lane path get dropped —
  // an ambient car grazing a sign at tick 250 breaks the quiet preview
  // (the junction patch is AT the lanes by design and has no colliders)
  topo.props = topo.props.filter((pr) => {
    if (pr.kind === 'asphalt_patch') return true;
    for (const l of topo.lanes) {
      for (let i = 0; i < l.pts.length; i += 2) {
        const dx = pr.x - l.pts[i], dz = pr.z - l.pts[i + 1];
        if (dx * dx + dz * dz < 3.2 * 3.2) return false;
      }
    }
    return true;
  });
  // dressing may not spawn inside a big fixed prop's footprint either —
  // worldgen's yard zones overlap occasionally, and a tree ejected out of a
  // house collider falls ACROSS THE ROAD in an otherwise quiet preview
  // (tp49: two "self-toppling" trees were really standing inside houses)
  const FOOT = { house: 6.5, shop: 8, building_city: 9, gazebo: 4, hedge: 3.2, guardrail: 2.6, fence_picket: 2.4 };
  topo.props = topo.props.filter((pr) => {
    if (FOOT[pr.kind]) return true; // the bigs stay; the smalls inside them go
    for (const q of topo.props) {
      const rr = FOOT[q.kind];
      if (!rr) continue;
      const dx = pr.x - q.x, dz = pr.z - q.z;
      if (dx * dx + dz * dz < rr * rr) return false;
    }
    return true;
  });

  // template pick: compatible with the topology AND with a lane that can
  // actually sustain a full-speed 10 s approach
  const usable = topo.lanes.filter((l) => solveApproach(l) !== null);
  // the true opposite-direction lane = the OTHER lane built from the same
  // road (never proximity-guessed — connected side streets share endpoints)
  const oppOf = (l) => topo.lanes.find((o) => o !== l && o.road === l.road) || null;
  const names = Object.keys(TEMPLATES).filter((n) => {
    const t = TEMPLATES[n];
    if (!t.topos.includes(topo.name)) return false;
    if (t.minD && d < t.minD) return false;
    if (t.minLane && !usable.some((l) => l.len >= t.minLane)) return false;
    if (t.needsCurve && !usable.some((l) => curvatureAt(l.pts, Math.min(l.len - 30, l.v * 10 + 25)) > 0.02)) return false;
    // head-on templates only deal where the geometry exists — the solo
    // fallbacks (swerve into empty grass) never made a watchable scene
    if (t.needsOpp && !usable.some((l) => solveHeadOn(l, oppOf(l)) !== null)) return false;
    return usable.length > 0;
  });
  // fallback for degenerate worlds: pullout works on any approach-capable lane
  const tName = names.length ? rInc.pick(names) : 'pullout';
  const T = TEMPLATES[tName] || TEMPLATES.pullout;

  // context: the template's primary lane + its opposite-direction partner
  const fit = usable.filter((l) =>
    (!T.minLane || l.len >= T.minLane) && (!T.needsOpp || solveHeadOn(l, oppOf(l)) !== null));
  const lanePool = fit.length ? fit : usable.length ? usable : topo.lanes;
  const lane = lanePool.length ? rInc.pick(lanePool) : null;
  const opp = lane ? oppOf(lane) : null;
  let curveS = 0;
  if (T.needsCurve && lane) {
    // Pick the bend by LATERAL DEMAND (v²·κ), not by raw curvature. laneMaxV
    // is a run-up constraint, not a grip one: a corner near the lane start
    // leaves no road to accelerate over, so the sharpest bend on a lane is
    // frequently the one the car can only reach at walking pace. Choosing on
    // curvature alone dealt hairpins taken at 3 m/s — the car simply steered
    // round them and the round logged no events at all (suburb/rollover).
    // v²·κ is what actually tips a tall vehicle, so it is what to maximise.
    let best = 0;
    for (let s = 30; s < lane.len - 25; s += 6) {
      const c = curvatureAt(lane.pts, s);
      const v = Math.min(laneMaxV(lane, s), lane.v + 4);
      const demand = v * v * c;
      if (demand > best) { best = demand; curveS = s; }
    }
  }
  const ctx = { rng: rInc, d, tellK, topo, lane, opp, curveS, approach: lane ? solveApproach(lane) : null };
  const made = T.make(ctx);
  if (made.props) topo.props.push(...made.props); // template dressing (overspeed catchers)
  const keep = new Set(made.cars.map((_, i) => i)); // template cars are essential

  // near-miss band (d ≥ 5): shift the victim out of the pocket — the physics
  // decides whether it's a shave or still a clip
  let nearMiss = false;
  if (d >= 5 && rInc.chance(0.2) && made.victim >= 0) {
    nearMiss = true;
    const V = made.cars[made.victim];
    // Shifting the victim UP its lane also makes it arrive EARLIER — it has
    // less road left to cover. Unbounded, that silently undoes the template's
    // arrival budget: a pullout victim budgeted to reach the merge point at
    // T+42 shifted 15 m up a lane at 11 m/s arrives ~80 ticks sooner, i.e.
    // BEFORE the incident, and rear-ended the still-parked car at tick 599 —
    // breaking the nothing-collides-before-600 invariant. The same overshoot
    // in the other direction sails the victim past the pocket entirely and
    // the round logs nothing at all. So cap the shift by the distance the
    // victim can give up and still reach its anchor after T=0 (+20 ticks of
    // margin). The spawn-overlap net cannot catch this: the cars do not
    // overlap at spawn, they converge early.
    const room = V._anchor !== undefined && V._v > 0
      ? (V._anchor - V._s0) - V._v * ((INCIDENT_TICK + 20) / 60)
      : 0;
    const want = 9 + rInc.range(0, 6);
    const shift = Math.max(0, Math.min(want, room));
    V._s0 = Math.min(V._lane ? V._lane.len - 6 : V._s0 + shift, V._s0 + shift);
    const p = V._lane ? arcPos(V._lane.pts, V._s0) : null;
    if (p) {
      V.x = p.x; V.y = arcY(V._lane, V._s0); V.z = p.z; V.heading = p.heading;
      V.drive.pts = slicePts(V._lane.pts, V._s0);
    }
  }

  // decoy (d ≥ 6): a drifter elsewhere who recovers cleanly before T = 0
  let decoyRef = null;
  if (d >= 6 && rInc.chance(0.35)) {
    const others = usable.filter((l) => l !== lane);
    if (others.length) {
      const dl = rInc.pick(others);
      const dc = place(dl, Math.min(dl.len - 20, dl.v * 10 + 15), dl.v);
      dc.drive.acc = INCIDENT_TICK; // full attention only during the preview
      cmd(dc, { t: 470, bias: 0.03 * rInc.sign() });
      cmd(dc, { t: 555, bias: -0.015 });
      cmd(dc, { t: 585, bias: 0 });
      made.cars.push(dc);
      decoyRef = dc;
    }
  }

  // second incident (d ≥ 7): an independent single-car loss elsewhere
  let multiRef = null;
  if (d >= 7 && rInc.chance(0.3)) {
    const others = usable.filter((l) => l !== lane && crossOf(l, lane).dist > 14);
    if (others.length) {
      const ml = rInc.pick(others);
      const mc = place(ml, Math.min(ml.len - 25, ml.v * 10 + 20), ml.v + 2);
      mc.drive.acc = INCIDENT_TICK; // attentive until the chaos starts
      const side = rInc.sign();
      const t2 = INCIDENT_TICK + rInc.int(0, 110);
      cmd(mc, { t: t2, bias: side * 0.08, off: true });
      cmd(mc, { t: t2 + 18, bias: side * 0.17 });
      made.cars.push(mc);
      multiRef = mc;
    }
  }

  // ambient traffic to fill the cast (never essential — dropped on conflict).
  // Same-lane rule: only join a lane whose existing cars move at (nearly) the
  // same speed — a parked actor or a speeding aggressor makes the whole lane
  // off-limits, otherwise the ambient car would plow into it pre-incident.
  const castMax = Math.min(8, 3 + (d >> 1) + rInc.int(0, 1));
  const lanesFor = usable.length ? usable : topo.lanes;
  let guard = 0;
  while (made.cars.length < castMax && lanesFor.length && guard++ < 40) {
    const al = rInc.pick(lanesFor);
    const sA = 25 + rInc.range(0, Math.max(10, al.len - 50));
    const vNew = Math.min(al.v * (0.92 + rInc.range(0, 0.16)), laneMaxV(al, sA));
    if (vNew < MIN_V * 0.8) continue;
    const s0New = Math.max(0.5, sA - vNew * 10); // the CLAMPED spawn — compare reality
    let ok = true;
    for (const c of made.cars) {
      if (!c || c._lane !== al) continue;
      if (Math.abs(c._v - vNew) > 1.5) { ok = false; break; }
      if (Math.abs(c._s0 - s0New) < al.v * 1.5 + 14) { ok = false; break; }
    }
    if (!ok) continue;
    const amb = place(al, sA, vNew);
    // place() clamps speed near the lane start — crawlers are never good
    // content and a slow car ahead of matched traffic is a pre-600 rear-end
    if (amb._v < vNew * 0.75) continue;
    // ambient traffic keeps its distance during the preview; after the
    // incident it reacts only at panic range (late brakers still pile in)
    amb.drive.acc = INCIDENT_TICK;
    made.cars.push(amb);
  }

  // spawn-overlap safety net: no two cars may materialize inside each other,
  // whatever placement said — drop the non-essential of any too-close pair.
  // Runs TWICE: once here, and again after scrubConflicts, because the scrub
  // pushes crossing cars back along their lane and the new spot can land on
  // another car (tick-1 explosions at d9–10 intersections in the 200-sweep).
  const overlapNet = (list, isKeep) => {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const A = list[i], B = list[j];
        if (!A || !B) continue;
        // 8 m clears the longest body the cast pass can pick for a queue slot;
        // intended queues are exempt only down to that same floor
        const sep = Math.hypot(A.x - B.x, A.z - B.z);
        if (sep >= 8) continue;
        // An intended queue is close in world space AND close along the lane.
        // A hairpin (G4 switchback) folds back on itself, so two cars can sit
        // 7 m apart in space while being 100 m apart in arc length, pointing
        // straight at each other — that is not a queue, and exempting it put
        // a head-on at tick 25 (topo16). Require both to hold.
        const sameQueue = A._lane === B._lane && Math.abs((A._s0 || 0) - (B._s0 || 0)) < 14;
        if (sameQueue && isKeep(A) && isKeep(B) && sep >= 6.5) continue;
        list[isKeep(B) ? (isKeep(A) ? j : i) : j] = null;
      }
    }
  };
  overlapNet(made.cars, (c) => keep.has(made.cars.indexOf(c)));

  // resolve actor indices by reference — drops above may have shifted them
  const aggRef = made.aggressor >= 0 ? made.cars[made.aggressor] : null;
  const vicRef = made.victim >= 0 ? made.cars[made.victim] : null;
  const keptRefs = new Set(made.cars.filter((c, i) => c && keep.has(i)));
  let cars = scrubConflicts(made.cars, keep);
  overlapNet(cars, (c) => keptRefs.has(c)); // post-scrub positions re-vetted
  cars = cars.filter(Boolean);
  const decoy = decoyRef ? cars.includes(decoyRef) : false;
  const multi = multiRef ? cars.includes(multiRef) : false;

  // cast pass: types + seeds (own stream, consumed in car order).
  // Heavies are barred from fast bendy plans: a semi at 12 m/s understeers
  // through an apex, crabs across the centreline and T-bones oncoming
  // traffic 50 ticks BEFORE the incident (dev20). v²·κ ≈ lateral g demand.
  const bendy = (c) => {
    if (c._v < 2) return false;
    const pts = c.drive.pts;
    const len = laneLen(pts);
    let k = 0;
    for (let s = 10; s < len - 10; s += 8) k = Math.max(k, curvatureAt(pts, s, 8));
    return c._v * c._v * k > 2.4;
  };
  const poolFor = (c) => {
    if (c._pool === 'POLICE') return ['police'];
    // _short = spawned in a tight queue: only compact bodies fit the gap
    if (c._short) return c._pool === 'FAST' ? FAST : CIVIC;
    if (c._pool === 'FAST') return FAST;
    // an explicitly heavy actor still yields to the bendy guard
    if (c._pool === 'HEAVY') return bendy(c) ? CIVIC : HEAVY;
    if (topo.name === 'highway') return rCast.chance(0.3) && !bendy(c) ? HEAVY : CIVIC;
    return rCast.chance(0.12) && !bendy(c) ? HEAVY : CIVIC;
  };
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i];
    c.type = rCast.pick(poolFor(c));
    c.seed = String(rCast.int(1, 99999));
    delete c._lane; delete c._s0; delete c._v; delete c._anchor; delete c._pool; delete c._short;
  }

  // props may not overlap a CAR spawn either: the pullout's shoulder spot
  // sits outside the scrubbed lane corridor, and a lamp post 1.1 m from the
  // parked car exploded it on tick 1 (tp69). Clearance is footprint-aware:
  // a house's collider reaches ~7 m from its centre (tp69's taxi spawned
  // inside one whose centre was 7.9 m away).
  const BIG_PROP = { house: 10, shop: 10, building_city: 12, gazebo: 6, hedge: 5, guardrail: 4.5 };
  const props = topo.props.filter((pr) => {
    if (pr.kind === 'asphalt_patch') return true;
    const rr = BIG_PROP[pr.kind] || 3.8;
    for (const c of cars) {
      const dx = pr.x - c.x, dz = pr.z - c.z;
      if (dx * dx + dz * dz < rr * rr) return false;
    }
    return true;
  });

  return {
    // Spread the topology's world through instead of re-listing its keys. The
    // enumerated version dropped every key it did not name — including
    // `water`, so the causeway (a deck over open water, the one topology that
    // exists to show off G4 elevation) generated a bridge over dry land and
    // the buoyancy / splash / sunk path never ran in a single real round. It
    // stayed green only because the `water` simtest scenario hand-writes
    // world.water rather than going through the director. Defaults stay in
    // front so a topology can still override gravity or walls deliberately.
    world: { gravity: 9.81, walls: false, ...topo.world, arena: topo.world.arena || 100 },
    roads: topo.roads,
    props,
    cars,
    meta: {
      seed: String(seed), d, topo: topo.name, template: tName,
      incidentTick: INCIDENT_TICK, resolveTicks: RESOLVE_TICKS,
      label: made.label, tell: made.tell,
      aggressor: aggRef ? cars.indexOf(aggRef) : -1,
      victim: vicRef ? cars.indexOf(vicRef) : -1,
      nearMiss, decoy, multi,
    },
  };
}

/* difficulty draw for the campaign: P(d) ∝ 0.62^(d−1) — level 1 ≈ 38 %,
   level 10 ≈ 0.4 %. Deterministic given the rng. */
export function drawDifficulty(rng) {
  let p = 1, total = 0;
  const w = [];
  for (let i = 0; i < 10; i++) { w.push(p); total += p; p *= 0.62; }
  let x = rng() * total;
  for (let i = 0; i < 10; i++) { x -= w[i]; if (x <= 0) return i + 1; }
  return 1;
}
