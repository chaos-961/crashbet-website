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
import { makeSignalProgram, phaseFor, signalAt, GREEN } from './signals.js';
// terrain.js is pure (integer-hash noise, no THREE state) — the director only
// reads its env→preset table to attach a VISUAL terrain spec to every scene.
import { TERRAIN_FOR_ENV } from './terrain.js';
// weather.js's roll is pure data (no THREE objects, no side effects), which is
// what lets the scene carry its own weather — see the `world.weather` note in
// generateScene for why that has to be the scenario's job and not main.js's.
import { rollWeather, gripFor } from './weather.js';

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
  // G6: prop budget 40 → 84 (the generators grew), junction seams pass through
  const g = generateWorld(preset, String(rTopo.int(1, 99999)), { maxProps: 84, maxRoads: 8 });
  const lanes = [];
  for (const spec of g.roads) for (const l of lanesOfRoad(spec, rTopo, vBase)) lanes.push(l);
  sortLanes(lanes);
  // big topos (the 300 m highway) need the visual ground disc to keep up;
  // setGroundRadius clamps to its 90 m floor so small arenas are unaffected
  const world = { ...g.world, ground: (g.world.arena || 140) / 2 + 22 };
  return { name: preset, world, roads: g.roads, props: g.props, junctions: g.junctions || [], lanes, crossings: [] };
}

// Signalized intersection: four road stubs meeting a bare-asphalt junction
// patch (roads must never overlap — the patch fills the hole 2 mm lower).
// Lanes run STRAIGHT THROUGH the junction across the patch; EW × NS pairs
// are the crossing geometry that red-light scenes need.
function topoIntersection(rTopo, rDress) {
  // stubs run to ±145: a 10 s approach at road speed is >100 m, so short
  // arms silently throttled every actor to a crawl (found in the G1 sweeps)
  const A = 145;
  /* P2: a real junction replaces the 13 × 13 m `asphalt_patch` prop. Stubs
     start at STUB and the junction reaches past them to REACH, so each blunt
     road end is covered by junction asphalt 2 mm below it — no z-fight, no
     seam, and the road's own lane lines now stop just outside the stop bar
     instead of running straight through the crossing. */
  const STUB = 7.4, REACH = 9.6;
  const roads = [
    { pts: [{ x: -A, z: 0 }, { x: -A / 2, z: 0 }, { x: -STUB, z: 0 }], w: 8, loop: 0, style: 1 },
    { pts: [{ x: STUB, z: 0 }, { x: A / 2, z: 0 }, { x: A, z: 0 }], w: 8, loop: 0, style: 1 },
    { pts: [{ x: 0, z: -A }, { x: 0, z: -A / 2 }, { x: 0, z: -STUB }], w: 7, loop: 0, style: 0 },
    { pts: [{ x: 0, z: STUB }, { x: 0, z: A / 2 }, { x: 0, z: A }], w: 7, loop: 0, style: 0 },
  ];
  const junctions = [{
    x: 0, z: 0, reach: REACH, style: 1 | 2 | 4 | 8, // bars · walks · box · arrows
    arms: [{ a: 0, w: 8 }, { a: Math.PI, w: 8 }, { a: -Math.PI / 2, w: 7 }, { a: Math.PI / 2, w: 7 }],
    // where a car must wait, matching the bar buildJunction paints at hx+3.2
    // (hx = 3.5 for the EW arms against the 7 m cross street, 4.0 for NS)
    stopR: { ew: 7.3, ns: 7.8 },
    signal: null, // filled in at the END of this function — see below
  }];
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
  const props = [];
  const S = (kind, x, z, heading, sig) =>
    props.push({ kind, x, z, heading, seed: String(rDress.int(1, 9999)), ...(sig ? { sig } : {}) });
  /* One signal per APPROACH, each tagged with the arm it governs (P2/2I).
     There were two, both on the EW street, both showing a lamp picked once at
     build time — so an intersection could and often did display two conflicting
     greens that never changed. Four heads means a player sees red on one street
     and green on the other at a glance, which is the whole read.

     A head faces the traffic it governs, and this prop's lamps face along its
     own +x, so heading = the direction the lamps look = OPPOSITE the travel
     direction of the approach it serves. Masts sit at radius ~11.8, clear of
     the junction apron (reach 9.6) and past the 3.2 m lane scrub. */
  S('traffic_light', 9.5, 7.0, Math.PI, { j: 0, arm: 'ew' });    // W approach, travelling +x
  S('traffic_light', -9.5, -7.0, 0, { j: 0, arm: 'ew' });        // E approach, travelling −x
  S('traffic_light', -7.0, 9.5, -Math.PI / 2, { j: 0, arm: 'ns' }); // N approach, travelling +z
  S('traffic_light', 7.0, -9.5, Math.PI / 2, { j: 0, arm: 'ns' });  // S approach, travelling −z
  S('traffic_light_ped', 6.8, -7.4, Math.PI / 2);
  S('lamp_cobra', -7.2, 7.4, 0);
  S('hydrant', 9.5, -8.6, rDress.range(0, 6.28));
  S('mailbox', -9.2, 8.8, rDress.range(0, 6.28));
  S('bench', 11.5, 8.2, Math.PI);
  if (rTopo.chance(0.7)) S('tree_oak', 14 + rTopo.range(0, 4), -12 - rTopo.range(0, 4), rTopo.range(0, 6.28));
  if (rTopo.chance(0.7)) S('tree_oak', -14 - rTopo.range(0, 4), 12 + rTopo.range(0, 4), rTopo.range(0, 6.28));
  if (rTopo.chance(0.5)) S('trash_can', 8.6, 9.4, 0);
  // Signal program is drawn LAST, after every dressing decision above, so
  // adding it cannot shift which trees or bins this topology deals.
  // generateScene then phases it onto the incident (see phaseFor).
  junctions[0].signal = makeSignalProgram(rTopo, [['ew'], ['ns']]);
  return {
    name: 'intersection',
    world: { arena: A * 2 + 20, env: 'city', ground: A + 22 },
    roads, junctions, props, lanes,
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
  // 2G coastal dressing — buoys ride the basin, a lighthouse on the far bank
  for (let i = 0; i < 3; i++) S('buoy', rTopo.range(-48, 48), rTopo.sign() * rTopo.range(24, 52), 0);
  if (rTopo.chance(0.6)) S('lighthouse', rTopo.sign() * 74, rTopo.sign() * 34, 0);
  if (rTopo.chance(0.5)) S('tide_marker', rTopo.range(-40, 40), rTopo.sign() * 20, 0);
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
  // 2G alpine dressing — engineering that lines a real mountain route
  for (let i = 0; i < 2; i++) S('rockfall_net', rTopo.range(-70, 70), rTopo.sign() * rTopo.range(24, 44), 0);
  if (rTopo.chance(0.7)) S('gabion', rTopo.range(-50, 50), rTopo.sign() * 30, 0);
  if (rTopo.chance(0.6)) S('scree', rTopo.range(-60, 60), rTopo.sign() * rTopo.range(26, 40), 0);
  if (rTopo.chance(0.6)) S('cairn', rTopo.range(-40, 40), rTopo.sign() * 24, 0);
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
  // keep-clear box only: a level crossing is not a signalized junction, and
  // "do not stop on the tracks" is exactly what the yellow box means
  const junctions = [{
    x: 0, z: 0, reach: 9.6, style: 4,
    arms: [{ a: 0, w: 8 }, { a: Math.PI, w: 8 }, { a: -Math.PI / 2, w: 6.5 }, { a: Math.PI / 2, w: 6.5 }],
  }];
  S('toll_gate', 9.5, 6.5, 0);
  S('toll_gate', -9.5, -6.5, Math.PI);
  S('sign_warn', 13, 8.5, Math.PI / 2);
  for (let i = 0; i < 4; i++) S('tree_pine', rTopo.range(-70, 70), (i % 2 ? 1 : -1) * rTopo.range(20, 46), rTopo.range(0, 6.28));
  // 2G rural dressing — the tram line runs through farmland
  for (let i = 0; i < 3; i++) S('rail_fence', -60 + i * 44, rTopo.sign() * rTopo.range(18, 30), 0);
  if (rTopo.chance(0.7)) S('farm_gate', rTopo.sign() * 40, rTopo.sign() * 16, Math.PI / 2);
  if (rTopo.chance(0.6)) S('hay_wrap', rTopo.range(-50, 50), rTopo.sign() * rTopo.range(26, 40), rTopo.range(0, 6.28));
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
    roads, junctions, props, lanes,
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
  // 2G — a service/industrial edge to the lot
  if (rTopo.chance(0.7)) S('drum_rack', -70, -34, 0);
  if (rTopo.chance(0.7)) S('tire_stack', 66, 30, 0);
  if (rTopo.chance(0.6)) S('pallet', rTopo.range(40, 70), -34, rTopo.range(0, 6.28));
  return {
    name: 'parkinglot',
    world: { arena: A * 2 + 20, env: 'proving', ground: A + 22 },
    roads, props, lanes: lanesFrom(roads, rTopo, Math.min(vBase, 8.5)), crossings: [],
  };
}

/* Roundabout — G6 rebuild. The old lanes were STRAIGHT LINES across the whole
   span: four cars driving over the island of a ring nobody circulated. Cars
   now drive real JOURNEYS — enter at one mouth, circulate the ring, exit at
   the opposite mouth — and ambient entries carry give-way lines (drive.yields)
   that hold while the circle is occupied, which is the traffic rule the place
   exists to stage.

   Geometry: circulating radius = the ring centreline R = 23. The pure-pursuit
   driver's certified band is 19–48 m (switchback note), and v²·κ at 8.8 m/s is
   ~3.4, which also bars heavies via the bendy guard — correct art direction.
   Journey k enters at arm k, runs the ring HALF way (passing arm k−1's mouth,
   which is where the merge conflict lives), and exits at the opposite arm. The
   arc is trimmed ~0.35 rad short of both mouths so the pursuit lookahead
   blends entry and exit across the junction aprons instead of kinking.
   One-way ring: each journey carries a unique `road` tag, so there is no
   opposite-direction partner and head-on templates skip this topology by
   geometry (solveHeadOn finds nothing). */
function topoRoundabout(rTopo, rDress, vBase) {
  const A = 128, R = 23;
  const ring = { pts: [], w: 8, loop: 1, style: 0 };
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ring.pts.push({ x: Math.cos(a) * R, z: Math.sin(a) * R });
  }
  const G = R + 4.4; // stub start, just clear of the ring's outer edge
  const roads = [ring,
    { w: 8, loop: 0, style: 1, pts: [{ x: -A, z: 0 }, { x: -G, z: 0 }] },
    { w: 8, loop: 0, style: 1, pts: [{ x: G, z: 0 }, { x: A, z: 0 }] },
    { w: 7, loop: 0, style: 0, pts: [{ x: 0, z: -A }, { x: 0, z: -G }] },
    { w: 7, loop: 0, style: 0, pts: [{ x: 0, z: G }, { x: 0, z: A }] },
  ];
  const props = [];
  const S = dress(props, rDress);
  // aprons over each stub-mouth seam (see the P2 note: a 2-arm junction is a
  // plain apron laid 2 mm under both, closing the sliver for good)
  const junctions = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    junctions.push({
      x: Math.cos(a) * (R + 2.2), z: Math.sin(a) * (R + 2.2),
      reach: 3.4, style: 0,
      arms: [{ a, w: 8 }, { a: a + Math.PI, w: 8 }],
    });
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    S('sign_yield', Math.cos(a) * (R + 7), Math.sin(a) * (R + 7), a);
  }
  // the island is a real garden now that nothing drives across it
  S(rTopo.chance(0.5) ? 'fountain' : 'tree_oak', 0, 0, rTopo.range(0, 6.28));
  for (let i = 0; i < 4; i++) {
    const a = rTopo.range(0, 6.28);
    S(rTopo.pick(['hedge', 'bush', 'flowerbed']), Math.cos(a) * rTopo.range(5, 10), Math.sin(a) * rTopo.range(5, 10), rTopo.range(0, 6.28));
  }
  /* Journeys. vRun stays under 9 so the ring's lateral demand is honest for
     every castable body. Sampling: straights every 2.5 m, arc every ~2.5 m of
     arc length. Yield zone per journey = the merge mouth on the ring (where
     journey k joins the arc journey k+1 is circulating). */
  const vRun = Math.min(vBase, 8.8);
  const lanes = [];
  const yieldZones = [];
  for (let k = 0; k < 4; k++) {
    const phi = (k / 4) * Math.PI * 2;
    const ax = Math.cos(phi), az = Math.sin(phi);   // outward arm unit
    const rx = az, rz = -ax;                        // right-of-inbound offset dir
    const pts = [];
    // entry straight: from the rim to just outside the ring, offset 2 m right
    for (let t = A; t >= R + 7; t -= 2.5) pts.push(ax * t + rx * 2, az * t + rz * 2);
    // arc: theta decreasing from phi−0.35 to phi−π+0.35 (half circulation)
    const th0 = phi - 0.35, th1 = phi - Math.PI + 0.35;
    const steps = Math.ceil(((th0 - th1) * R) / 2.5);
    for (let i = 0; i <= steps; i++) {
      const th = th0 + ((th1 - th0) * i) / steps;
      pts.push(Math.cos(th) * R, Math.sin(th) * R);
    }
    // exit straight: out along the opposite arm, offset 2 m right of travel
    for (let t = R + 7; t <= A; t += 2.5) pts.push(-ax * t + rx * 2, -az * t + rz * 2);
    const lane = { pts, len: laneLen(pts), v: vRun, w: 8, road: 'a' + k };
    lanes.push(lane);
    // give-way line: hold just before the arc while the merge mouth is claimed
    const sEntry = A - (R + 7); // length of the entry straight
    yieldZones.push({ road: 'a' + k, x: ax * R, z: az * R, r: 12, s: sEntry - 2 });
  }
  sortLanes(lanes);
  // crossings pair [entering k, circulating k+1] — the mouth conflict.
  // Indices must survive sortLanes, so resolve tags back to positions.
  const idxOf = (tag) => lanes.findIndex((l) => l.road === tag);
  const crossings = [];
  for (let k = 0; k < 4; k++) crossings.push([idxOf('a' + k), idxOf('a' + ((k + 1) % 4))]);
  return {
    name: 'roundabout',
    world: { arena: A * 2 + 20, env: 'city', ground: A + 22 },
    roads, junctions, props, lanes, yieldZones,
    crossings,
  };
}

/* ============ P2/2E topologies (10 → 22) ============
   Twelve new PLACES. They are the callers 2B (verge/guardrail road bits), 2C
   (drivable terrain) and 2D (weather grip) were each landed inert to serve —
   every one of those features shipped pinned and with no topology that turned
   it on, and these turn them on. They also deal the five 1F presets that only
   the Settings chip could reach (dawn/dusk/alpine/coastal/desert), which is
   what finally puts snow and the cold half of the weather table into a real
   round.

   Adding names to the topology pick array reshuffles which scene most seeds
   deal — but NOT the `director` pin, which still lands on `intersection`: its
   rng draw is small enough that floor(u·N) is 0 for both the old N=10 and the
   new N=22 array, and the intersection path is byte-identical because the
   NO_HEAVY guard below consumes no rng for a topology it does not name. So all
   12 pins stay frozen (verified), which is the proof no physics changed; the
   sweep, not a pin, is what validates the twelve new places choreograph clean.

   Two rules the whole set is built around:
   • RELIEF topos (drivable terrain) keep the road strictly inside `playR`, so
     the drivable corridor is the same flat y=0 plane it has always been and the
     hills rise only beyond it. Dressing on such a topo also stays inside playR,
     or a prop placed at y=0 would float over (or sink into) displaced ground.
   • WATER topos and RELIEF topos never combine: a basin carve and a heightfield
     over the same ground is untested, so coast/harbour get water and no
     drivable terrain, mountain/canyon/forest get drivable terrain and no water. */

// A straight lane [x0,z0]→[x1,z1], sampled every 2.5 m and tagged with a road
// id so opposite-direction pairing and crossing detection keep working. The
// junction topologies each inlined their own copy; the 2E set shares this one.
const straightLane = (x0, z0, x1, z1, v, w, road) => {
  const pts = [];
  const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 2.5);
  for (let i = 0; i <= n; i++) pts.push(x0 + ((x1 - x0) * i) / n, z0 + ((z1 - z0) * i) / n);
  return { pts, len: Math.hypot(x1 - x0, z1 - z0), v, w, road };
};

// Boulevard: a wide divided avenue at dusk. Straight and long like a city
// street, but 13 m wide, which trips roads.js's lane-count-from-width (2B), and
// it is the topology that finally deals the `dusk` preset.
function topoBoulevard(rTopo, rDress, vBase) {
  const A = 132;
  const roads = [{ w: 13, loop: 0, style: 1 | 2, pts: [{ x: -A, z: 0 }, { x: 0, z: 0 }, { x: A, z: 0 }] }];
  const props = [];
  const S = dress(props, rDress);
  for (let i = 0; i < 9; i++) { S('lamp_cobra', -80 + i * 20, 8.6, 0); S('lamp_cobra', -70 + i * 20, -8.6, Math.PI); }
  S('building_city', -46, -32, 0); S('building_city', 30, -34, 0); S('building_city', -6, 32, Math.PI);
  S('bus_stop', 22, 9.2, Math.PI); S('street_clock', -20, 9.2, 0);
  for (let i = 0; i < 4; i++) S('tree_round', -66 + i * 42, 12.5 + rTopo.range(0, 3), rTopo.range(0, 6.28));
  if (rTopo.chance(0.6)) S('food_cart', 46, 9.6, Math.PI);
  if (rTopo.chance(0.6)) S('billboard', -52, -15, Math.PI / 2);
  return {
    name: 'boulevard',
    world: { arena: A * 2 + 20, env: 'dusk', ground: A + 22 },
    roads, props, lanes: lanesFrom(roads, rTopo, vBase), crossings: [],
  };
}

// Tunnel mouth: a straight approach to a portal, channelled by barrier. The
// portal squares the far end as a backdrop — nothing on the centreline for
// ambient traffic to hit — and the `overheight` template (2F) brings its own
// clearance bar. Dealt at dawn.
function topoTunnelMouth(rTopo, rDress, vBase) {
  const A = 128;
  const roads = [{ w: 9, loop: 0, style: 1, pts: [{ x: -A, z: 0 }, { x: 20, z: 0 }, { x: A, z: 0 }] }];
  const props = [];
  const S = dress(props, rDress);
  S('tunnel_portal', A + 9, 0, Math.PI);           // squares the far end, off the drivable road
  S('sign_warn', 70, 7.4, Math.PI / 2);
  S('vms_board', 48, 7.8, Math.PI / 2);
  for (let i = 0; i < 7; i++) { S('jersey_run', 40 + i * 12, 6.4, 0); S('jersey_run', 40 + i * 12, -6.4, 0); }
  for (let i = 0; i < 5; i++) S('lamp_cobra', -84 + i * 24, 7.2, 0);
  if (rTopo.chance(0.7)) S('utility_box', -30, 7.6, 0);
  return {
    name: 'tunnelmouth',
    world: { arena: A * 2 + 20, env: 'dawn', ground: A + 22 },
    roads, props, lanes: lanesFrom(roads, rTopo, vBase), crossings: [],
  };
}

// Industrial yard: a wide floodlit apron with two aisles, everything slow and
// close. Fender-benders, not highway wrecks — the parking-lot shape with a
// working-yard face and the `night` preset in a real round.
function topoIndustrialYard(rTopo, rDress, vBase) {
  const A = 104;
  const roads = [
    { w: 8, loop: 0, style: 0, pts: [{ x: -A, z: -12 }, { x: 0, z: -12 }, { x: A, z: -12 }] },
    { w: 8, loop: 0, style: 0, pts: [{ x: -A, z: 18 }, { x: 0, z: 18 }, { x: A, z: 18 }] },
  ];
  const props = [];
  const S = dress(props, rDress);
  S('gantry_crane', 0, 46, 0);
  for (let i = 0; i < 4; i++) S('container_stack', -60 + i * 40, 42, (i % 2) * Math.PI / 2);
  for (let i = 0; i < 5; i++) S('container', -50 + i * 26, -42, 0);
  S('fuel_tank', -74, 3, 0); S('substation', 72, -40, 0); S('pipe_rack', 42, 3, 0);
  for (let i = 0; i < 5; i++) S('floodlight_tower', -66 + i * 32, 3, 0);
  S('weighbridge', -28, 3, 0);
  if (rTopo.chance(0.7)) S('gate_arm', 90, 3, Math.PI / 2);
  return {
    name: 'industrialyard',
    world: { arena: A * 2 + 24, env: 'night', ground: A + 22 },
    roads, props, lanes: lanesFrom(roads, rTopo, Math.min(vBase, 8.5)), crossings: [],
  };
}

// T-junction: a through road meeting a GIVE-WAY side street. A signalized T
// fought the lane model — the stem's inbound lane has nowhere to go but the
// junction centre (there is no opposite arm), so a car driving it stopped dead
// IN the box and cross traffic T-boned it, and a junction-radius turn onto the
// through road is far tighter than the pure-pursuit driver's ~22 m floor. So
// the stem is a give-way SPUR carrying no through traffic: the incident plays
// out on the through road, and the side street is the place a pullout noses out
// from. It still reads as a T — asphalt fillets, stop bars, a give-way line.
function topoTJunction(rTopo, rDress, vBase) {
  const A = 138, STUB = 7.4, REACH = 9.6;
  const roads = [
    { pts: [{ x: -A, z: 0 }, { x: -A / 2, z: 0 }, { x: -STUB, z: 0 }], w: 8, loop: 0, style: 1 },
    { pts: [{ x: STUB, z: 0 }, { x: A / 2, z: 0 }, { x: A, z: 0 }], w: 8, loop: 0, style: 1 },
    { pts: [{ x: 0, z: STUB }, { x: 0, z: 44 }, { x: 0, z: 88 }], w: 7, loop: 0, style: 0 }, // give-way spur
  ];
  const junctions = [{
    x: 0, z: 0, reach: REACH, style: 1 | 2, // stop bars + crosswalks, no signal
    arms: [{ a: 0, w: 8 }, { a: Math.PI, w: 8 }, { a: Math.PI / 2, w: 7 }],
  }];
  const props = [];
  const S = dress(props, rDress);
  S('sign_yield', 3.0, 10.2, Math.PI / 2); // give way on the spur mouth
  S('sign_street', -8, 9.2, 0);
  S('house', -30, -26, 0); S('house', 26, -28, 0); S('house', 42, 24, Math.PI);
  if (rTopo.chance(0.7)) S('tree_oak', -16 - rTopo.range(0, 5), 16 + rTopo.range(0, 4), rTopo.range(0, 6.28));
  if (rTopo.chance(0.6)) S('mailbox', 12, -8.6, 0);
  if (rTopo.chance(0.6)) S('bench', -22, 8.8, Math.PI);
  return {
    name: 'tjunction',
    world: { arena: A * 2 + 20, env: 'suburb', ground: A + 22 },
    roads, junctions, props,
    lanes: [
      straightLane(-A, 2, A, 2, 11, 8, 'ew'),   // W→E
      straightLane(A, -2, -A, -2, 11, 8, 'ew'),  // E→W
    ],
    crossings: [],
  };
}

// Overpass: a straight surface road running under an elevated crossing deck.
// The two roads meet in plan but NEVER in height, so nothing overlaps. The
// flyover is pure structure — deck + (visual-only) piers + a driving slab up at
// H that no car reaches — and every incident plays out on the ground road.
function topoOverpass(rTopo, rDress, vBase) {
  const A = 130, H = 6.4;
  const roads = [
    { w: 9, loop: 0, style: 1, pts: [{ x: -A, z: 0 }, { x: 0, z: 0 }, { x: A, z: 0 }] },
    // the flyover: elevated deck across +z→−z. deck&elev draws piers, which are
    // VISUAL ONLY (1G) — its only colliders are the parapets and slab up at H,
    // clearing a 2 m car by 4 m, so the surface road below is unaffected.
    {
      w: 10, loop: 0, style: 1 | 8, elev: true,
      pts: [{ x: 0, y: H, z: -A }, { x: 0, y: H, z: -34 }, { x: 0, y: H, z: 34 }, { x: 0, y: H, z: A }],
    },
  ];
  const props = [];
  const S = dress(props, rDress);
  S('building_city', -44, -34, 0); S('building_city', 40, 32, Math.PI);
  for (let i = 0; i < 6; i++) S('lamp_cobra', -70 + i * 28, 7.4, i % 2 ? Math.PI : 0);
  if (rTopo.chance(0.7)) S('utility_pole', -24, -8.6, 0);
  if (rTopo.chance(0.6)) S('vms_board', 30, 7.8, Math.PI / 2);
  return {
    name: 'overpass',
    world: { arena: A * 2 + 20, env: 'city', ground: A + 22 },
    roads, props,
    lanes: lanesFrom([roads[0]], rTopo, vBase), // ground road only — nobody drives the flyover
    crossings: [],
  };
}

// Forest road: gentle bends through pine woods, gravel verge instead of a kerb
// so leaving the road is a run-off. Drivable alpine terrain rises just past the
// corridor, and the wet-grip opt-in is live (a wet forest road is the point).
function topoForestRoad(rTopo, rDress, vBase) {
  const A = 96;
  const roads = [{
    w: 8.5, loop: 0, style: 1 | 16,
    pts: [
      { x: -A, z: -18 }, { x: -52, z: -28 }, { x: -14, z: -8 },
      { x: 24, z: 16 }, { x: 60, z: 6 }, { x: A, z: -20 },
    ],
  }];
  const props = [];
  const S = dress(props, rDress);
  // dressing stays inside playR (r < 98) so it sits on the flat corridor, not
  // on displaced ground; the far forest is vegetation.js scatter on the hills
  for (let i = 0; i < 8; i++) S('tree_pine', rTopo.range(-84, 84), (i % 2 ? 1 : -1) * rTopo.range(16, 40), rTopo.range(0, 6.28));
  for (let i = 0; i < 2; i++) S('tree_cluster', rTopo.range(-60, 60), (i % 2 ? 1 : -1) * rTopo.range(30, 42), rTopo.range(0, 6.28));
  if (rTopo.chance(0.7)) S('fallen_tree', rTopo.range(-40, 40), rTopo.range(24, 38), rTopo.range(0, 6.28));
  if (rTopo.chance(0.6)) S('log_pile', -58, 22, 0);
  return {
    name: 'forestroad',
    wxGrip: true,
    world: {
      arena: A * 2 + 40, env: 'alpine', ground: A + 30,
      terrain: { preset: 'rolling', seed: String(rTopo.int(1, 99999)), drivable: true, playR: A + 12 },
    },
    roads, props, lanes: lanesFrom(roads, rTopo, vBase), crossings: [],
  };
}

// Mountain pass: the flagship relief topology. A winding alpine road with a
// gravel verge AND a swept guardrail (real colliders that contain a car),
// drivable terrain, and weather grip — 2B + 2C + 2D all live at once.
function topoMountainPass(rTopo, rDress, vBase) {
  const A = 94;
  const roads = [{
    w: 9, loop: 0, style: 1 | 16 | 32,
    pts: [
      { x: -A, z: 20 }, { x: -50, z: 34 }, { x: -12, z: 8 },
      { x: 26, z: -20 }, { x: 58, z: -6 }, { x: A, z: 26 },
    ],
  }];
  const props = [];
  const S = dress(props, rDress);
  for (let i = 0; i < 3; i++) S('rockfall_net', -60 + i * 50, -34, 0);
  for (let i = 0; i < 4; i++) S('boulder_field', rTopo.range(-78, 78), (i % 2 ? 1 : -1) * rTopo.range(28, 40), rTopo.range(0, 6.28));
  if (rTopo.chance(0.7)) S('scree', -30, 36, 0);
  if (rTopo.chance(0.7)) S('cairn', 40, 30, 0);
  if (rTopo.chance(0.5)) S('alpine_hut', -72, -30, 0.6);
  return {
    name: 'mountainpass',
    wxGrip: true,
    world: {
      arena: A * 2 + 44, env: 'alpine', ground: A + 32,
      terrain: { preset: 'alpine', seed: String(rTopo.int(1, 99999)), drivable: true, playR: A + 14 },
    },
    roads, props, lanes: lanesFrom(roads, rTopo, Math.min(vBase, 11)), crossings: [],
  };
}

// Canyon: a winding desert road between rock walls, gravel verge, drivable mesa
// terrain around it. Dust weather bites here (grip on).
function topoCanyon(rTopo, rDress, vBase) {
  const A = 98;
  const roads = [{
    w: 8.5, loop: 0, style: 1 | 16,
    pts: [
      { x: -A, z: -10 }, { x: -54, z: 6 }, { x: -16, z: -14 },
      { x: 22, z: 10 }, { x: 58, z: -8 }, { x: A, z: 12 },
    ],
  }];
  const props = [];
  const S = dress(props, rDress);
  for (let i = 0; i < 4; i++) S('cliff_face', rTopo.range(-78, 78), (i % 2 ? 1 : -1) * rTopo.range(30, 42), (i % 2) * Math.PI);
  for (let i = 0; i < 3; i++) S('rock_outcrop', rTopo.range(-68, 68), (i % 2 ? 1 : -1) * rTopo.range(26, 40), rTopo.range(0, 6.28));
  if (rTopo.chance(0.7)) S('cactus', -40, 24, 0);
  if (rTopo.chance(0.6)) S('boulder_field', 44, -30, 0);
  return {
    name: 'canyon',
    wxGrip: true,
    world: {
      arena: A * 2 + 40, env: 'desert', ground: A + 30,
      terrain: { preset: 'mesa', seed: String(rTopo.int(1, 99999)), drivable: true, playR: A + 12 },
    },
    roads, props, lanes: lanesFrom(roads, rTopo, vBase), crossings: [],
  };
}

// Coastal cliff: a road along the shore, guardrail on the seaward side, the sea
// as a basin off the +z edge. Wet grip is live — a wet coast road is a bet.
function topoCoastalCliff(rTopo, rDress, vBase) {
  const A = 116;
  const roads = [{
    w: 9, loop: 0, style: 1 | 32,
    pts: [{ x: -A, z: -6 }, { x: -50, z: 4 }, { x: 0, z: -6 }, { x: 50, z: 6 }, { x: A, z: -4 }],
  }];
  const props = [];
  const S = dress(props, rDress);
  S('lighthouse', -80, -40, 0);
  for (let i = 0; i < 4; i++) S('seawall', -60 + i * 40, 12.5, 0);
  if (rTopo.chance(0.7)) S('beach_hut', 60, -18, Math.PI);
  if (rTopo.chance(0.6)) S('tide_marker', 30, 12, 0);
  return {
    name: 'coastalcliff',
    wxGrip: true,
    world: {
      arena: A * 2 + 20, env: 'coastal', ground: A + 22,
      water: { y: -0.8, x0: -A + 4, x1: A - 4, z0: 16, z1: 92 },
    },
    roads, props, lanes: lanesFrom(roads, rTopo, vBase), crossings: [],
  };
}

// Riverside: a gentle road beside a river, gravel verge toward the water so a
// slide off the shoulder is a swim. Wet grip live.
function topoRiverside(rTopo, rDress, vBase) {
  const A = 120;
  const roads = [{
    w: 9, loop: 0, style: 1 | 16,
    pts: [{ x: -A, z: -4 }, { x: -40, z: 4 }, { x: 40, z: -4 }, { x: A, z: 4 }],
  }];
  const props = [];
  const S = dress(props, rDress);
  S('dock', 20, 16, 0); S('jetty', -30, 15, Math.PI / 2);
  for (let i = 0; i < 3; i++) S('reeds', -50 + i * 40, 13.5, 0);
  for (let i = 0; i < 3; i++) S('cattails', -30 + i * 34, 13, 0);
  if (rTopo.chance(0.7)) S('rowboat', 44, 15, 0.5);
  if (rTopo.chance(0.6)) S('fishing_hut', -70, -16, 0);
  return {
    name: 'riverside',
    wxGrip: true,
    world: {
      arena: A * 2 + 20, env: 'coastal', ground: A + 22,
      water: { y: -0.8, x0: -A + 4, x1: A - 4, z0: 12, z1: 78 },
    },
    roads, props, lanes: lanesFrom(roads, rTopo, vBase), crossings: [],
  };
}

// Harbour ramp: a straight quay ending at open water. Gravel verge, no rail —
// a car that fails to stop drives off the end into the harbour.
function topoHarbourRamp(rTopo, rDress, vBase) {
  const A = 118;
  const roads = [{ w: 9, loop: 0, style: 1 | 16, pts: [{ x: -A, z: 0 }, { x: 30, z: 0 }, { x: 88, z: 0 }] }];
  const props = [];
  const S = dress(props, rDress);
  S('lighthouse', 98, -32, 0);
  for (let i = 0; i < 4; i++) S('mooring_bollard', 58 + i * 12, 8.5, 0);
  S('dock', 70, 20, 0); S('boat_trailer', -20, 10, 0);
  for (let i = 0; i < 3; i++) S('buoy', 102 + i * 6, rTopo.range(-18, 18), 0); // in the water
  if (rTopo.chance(0.7)) S('container', -50, -12, 0);
  if (rTopo.chance(0.6)) S('lifebuoy_stand', 78, 8, Math.PI / 2);
  return {
    name: 'harbourramp',
    world: {
      arena: A * 2 + 20, env: 'coastal', ground: A + 22,
      water: { y: -0.8, x0: 96, x1: A + 6, z0: -70, z1: 70 },
    },
    roads, props, lanes: lanesFrom(roads, rTopo, vBase), crossings: [],
  };
}

// Cloverleaf onramp: a straight motorway mainline with a sweeping on-ramp
// curling in from the side. The ramp is STRUCTURE — no traffic drives it, since
// a junction-radius merge curve is far tighter than the driver's ~22 m floor —
// so the bad merge, the tailgate and the pile-up all play out on the mainline,
// which is exactly what the merge template already choreographs on a single
// carriageway (a car drifting into an occupied lane, no ramp geometry needed).
function topoCloverleaf(rTopo, rDress, vBase) {
  const A = 134;
  const roads = [
    { w: 11, loop: 0, style: 1, pts: [{ x: -A, z: 0 }, { x: 0, z: 0 }, { x: A, z: 0 }] },
    // the sweeping ramp, VISUAL ONLY — curls down from the NE to run alongside
    // the +z edge; its near edge stays clear of the mainline so nothing z-fights
    {
      w: 6.5, loop: 0, style: 1 | 16,
      pts: [{ x: -98, z: 60 }, { x: -70, z: 45 }, { x: -44, z: 27 }, { x: -20, z: 15 }, { x: 6, z: 11.5 }, { x: 34, z: 11.5 }],
    },
  ];
  const props = [];
  const S = dress(props, rDress);
  S('sign_highway', -70, -12, Math.PI / 2);
  S('arrow_board', -14, 8.6, 0);
  for (let i = 0; i < 5; i++) S('chevron_board', -30 + i * 12, 9.6, 0);
  for (let i = 0; i < 6; i++) S('lamp_cobra', -80 + i * 30, -8.6, 0);
  if (rTopo.chance(0.7)) S('sign_reg', 62, -10, Math.PI / 2);
  if (rTopo.chance(0.6)) S('cell_tower', -58, 44, 0);
  return {
    name: 'cloverleaf',
    world: { arena: A * 2 + 24, env: 'dawn', ground: A + 24 },
    roads, props, lanes: lanesFrom([roads[0]], rTopo, vBase), crossings: [],
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

/* Truncate a car's drive path `keepM` metres past its spawn. Background
   traffic used to drive the FULL lane after the incident — on the G6 worlds
   (longer roads, bigger casts) somebody was always still rolling at the
   resolve cap, and 21% of scenes never confirmed rest. Ambient cars now roll
   ~5–10 s past the incident point and coast to a stop, which is also what
   traffic actually does around a crash. Essential cars are never trimmed. */
function trimDrive(spec, keepM) {
  const pts = spec.drive.pts;
  let acc = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    acc += Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
    if (acc >= keepM) { spec.drive.pts = pts.slice(0, i + 4); return; }
  }
}

/* Street furniture on the OUTSIDE of a bend, right in the overshoot path —
   extracted from `overspeed` (G6) so every lost-it-on-the-corner motif shares
   the exact same hard-won guards: never inside existing dressing (two
   overlapping dynamic bodies explode on spawn), never inside ANY other lane's
   corridor (normal preview traffic mows the catchers down pre-600). */
function bendCatchers(ctx, lane, curveS, kinds) {
  const rng = ctx.rng;
  const aIn = arcPos(lane.pts, Math.max(0, curveS - 8));
  const aOut = arcPos(lane.pts, curveS + 8);
  let dh = aOut.heading - aIn.heading;
  while (dh > Math.PI) dh -= 2 * Math.PI;
  while (dh < -Math.PI) dh += 2 * Math.PI;
  const turnL = dh > 0; // turning left → overshoot to the RIGHT
  const props = [];
  for (let k = 0; k < 3; k++) {
    const p = arcPos(lane.pts, curveS + 5 + k * 8);
    const lx = -Math.sin(p.heading), lz = -Math.cos(p.heading);
    const s = turnL ? -1 : 1; // outside of the bend
    const off = 2.7 + k * 1.2 + rng.range(0, 0.8);
    const px = p.x + s * lx * off, pz = p.z + s * lz * off;
    if (ctx.topo.props.some((q) => (q.x - px) ** 2 + (q.z - pz) ** 2 < 2.4 * 2.4)) continue;
    let onLane = false;
    for (const l of ctx.topo.lanes) {
      if (l === lane || onLane) continue;
      for (let i = 0; i < l.pts.length; i += 2) {
        if ((l.pts[i] - px) ** 2 + (l.pts[i + 1] - pz) ** 2 < 3.4 * 3.4) { onLane = true; break; }
      }
    }
    if (onLane) continue;
    props.push({
      kind: rng.pick(kinds),
      x: px, z: pz,
      heading: rng.range(0, 6.28), seed: String(rng.int(1, 9999)),
    });
  }
  return props;
}

/* ---------------- incident templates ----------------
   Each returns { cars, label, tell, aggressor, victim } — cars in a fixed
   order, aggressor/victim as indices into that array. `tellK` scales how
   loud the tell is (low difficulty = loud). All triggers land at tick 600. */
const TEMPLATES = {
  // a car simply does not stop for the junction — classic T-bone
  redlight: {
    // NOT tjunction: its stem is one-sided, so the symmetric crossing the
    // red-light and left-turn templates choreograph (a car through the box from
    // the far arm) has no far arm to come from. The T still signals and queues
    // cross traffic; its incidents are the rear-end / pullout kind instead.
    // NOT roundabout (G6): a one-way circulating ring has no red light to run —
    // its mouth conflict is the `yieldfail` template's job now.
    topos: ['intersection', 'tramcrossing'],
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
    topos: ['suburb', 'city', 'highway', 'intersection', 'causeway', 'switchback', 'schoolzone', 'tramcrossing', 'roundabout', 'parkinglot', 'boulevard', 'tunnelmouth', 'overpass', 'cloverleaf', 'tjunction', 'industrialyard', 'forestroad', 'mountainpass', 'canyon', 'coastalcliff', 'riverside', 'harbourramp'],
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
    topos: ['suburb', 'city', 'highway', 'intersection', 'causeway', 'switchback', 'schoolzone', 'tramcrossing', 'roundabout', 'boulevard', 'tunnelmouth', 'overpass', 'cloverleaf', 'tjunction', 'forestroad', 'mountainpass', 'canyon', 'coastalcliff', 'riverside', 'harbourramp'],
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
    topos: ['suburb', 'city', 'highway', 'intersection', 'causeway', 'switchback', 'schoolzone', 'tramcrossing', 'roundabout', 'parkinglot', 'boulevard', 'tunnelmouth', 'overpass', 'cloverleaf', 'tjunction', 'industrialyard', 'forestroad', 'mountainpass', 'canyon', 'coastalcliff', 'riverside', 'harbourramp'],
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
    topos: ['city', 'switchback', 'causeway', 'forestroad', 'mountainpass', 'canyon', 'coastalcliff'],
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
      // never a crash). The catchers make the corner consequential. The
      // overshoot band is only ~2.5–5 m outside the lane line (traced), and
      // only massive/bolted kinds register a real Δv on the car.
      const props = bendCatchers(ctx, lane, curveS, ['tree_oak', 'lamp_cobra', 'hydrant']);
      return { cars: [carA], props, aggressor: 0, victim: -1, label: 'Overspeed Corner', tell: 'count how fast that one is going' };
    },
  },
  // parked car noses into traffic without looking
  pullout: {
    topos: ['suburb', 'city', 'intersection', 'schoolzone', 'parkinglot', 'roundabout', 'tramcrossing', 'boulevard', 'tunnelmouth', 'overpass', 'cloverleaf', 'tjunction', 'industrialyard', 'riverside', 'harbourramp'],
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
    topos: ['suburb', 'city', 'highway', 'intersection', 'causeway', 'switchback', 'schoolzone', 'tramcrossing', 'roundabout', 'parkinglot', 'boulevard', 'tunnelmouth', 'overpass', 'cloverleaf', 'tjunction', 'industrialyard', 'forestroad', 'mountainpass', 'canyon', 'coastalcliff', 'riverside', 'harbourramp'],
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
    topos: ['suburb', 'city', 'highway', 'intersection', 'causeway', 'schoolzone', 'tramcrossing', 'roundabout', 'parkinglot', 'boulevard', 'tunnelmouth', 'overpass', 'cloverleaf', 'tjunction', 'industrialyard', 'riverside', 'harbourramp'],
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
    topos: ['highway', 'causeway', 'city', 'suburb', 'intersection', 'tramcrossing', 'boulevard', 'tunnelmouth', 'overpass', 'cloverleaf'],
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
    topos: ['highway', 'causeway', 'city', 'suburb', 'intersection', 'boulevard', 'tunnelmouth', 'overpass', 'cloverleaf'],
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
    topos: ['highway', 'suburb', 'city', 'causeway', 'intersection', 'parkinglot', 'boulevard', 'tunnelmouth', 'overpass', 'cloverleaf'],
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
    topos: ['highway', 'causeway', 'suburb', 'city', 'intersection', 'switchback', 'boulevard', 'tunnelmouth', 'overpass', 'cloverleaf', 'forestroad', 'mountainpass', 'canyon', 'coastalcliff', 'riverside', 'harbourramp'],
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
    topos: ['highway', 'causeway', 'city', 'suburb', 'schoolzone', 'roundabout', 'tramcrossing', 'parkinglot', 'boulevard', 'tunnelmouth', 'overpass', 'cloverleaf', 'riverside', 'harbourramp', 'industrialyard'],
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
    topos: ['highway', 'causeway', 'city', 'suburb', 'intersection', 'tramcrossing', 'switchback', 'boulevard', 'tunnelmouth', 'overpass', 'cloverleaf', 'tjunction', 'industrialyard', 'forestroad', 'mountainpass', 'canyon', 'coastalcliff', 'riverside', 'harbourramp'],
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
    // NOT tjunction: its stem is one-sided, so the symmetric crossing the
    // red-light and left-turn templates choreograph (a car through the box from
    // the far arm) has no far arm to come from. The T still signals and queues
    // cross traffic; its incidents are the rear-end / pullout kind instead.
    // NOT roundabout (G6): no left turn across a one-way ring.
    topos: ['intersection', 'tramcrossing'],
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
    topos: ['switchback', 'city', 'suburb', 'highway', 'causeway', 'forestroad', 'mountainpass', 'canyon', 'coastalcliff'],
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
    topos: ['highway', 'causeway', 'city', 'suburb', 'schoolzone', 'intersection', 'boulevard', 'tunnelmouth', 'overpass', 'cloverleaf', 'coastalcliff', 'riverside', 'harbourramp'],
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
    topos: ['highway', 'causeway', 'suburb', 'city', 'switchback', 'intersection', 'boulevard', 'tunnelmouth', 'overpass', 'cloverleaf', 'tjunction', 'forestroad', 'mountainpass', 'canyon', 'coastalcliff', 'riverside', 'harbourramp'],
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
    topos: ['highway', 'causeway', 'city', 'suburb', 'roundabout', 'parkinglot', 'boulevard', 'tunnelmouth', 'overpass', 'cloverleaf', 'industrialyard'],
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
    topos: ['highway', 'suburb', 'city', 'parkinglot', 'causeway', 'boulevard', 'tunnelmouth', 'overpass', 'cloverleaf'],
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

  /* ============ P2/2F templates (20 → 28) ============
     Eight more ways to crash, each built on a proven-safe pattern so the
     nothing-before-600 rule holds by construction: obstacle-swerve (debris),
     rolling same-speed convoy that only disrupts at tick 600 (chain), or a
     carve into oncoming that only begins at 600 (blowout). Several exist to
     give the 2E places incidents that fit them — a rockslide on a pass, a
     fallen tree in the forest, a flooded dip by the river, an overheight
     trailer at the tunnel — and two (lowgrip, flooddip) are the first
     templates authored to READ as weather-grip bets.
     The plan listed ten; `convoysplit` and `towstrap` were built and cut —
     both are convoy pile-ups, i.e. `chain` with a costume, and both fought the
     lane model (convoysplit stacked followers at the lane start when the queue
     outran the run-up; towstrap settled to a no-event 82% of the time). The
     eight that shipped are each a genuinely distinct scene, which is the point.
     CALIB has no rows for these yet, so calib() falls back to the kind default
     until the close-gate regeneration; markets still generate and settle. Each
     gets a specialFor. */

  // a boulder down across a mountain carriageway — swerve, and the follower
  rockslide: {
    topos: ['switchback', 'mountainpass', 'canyon', 'forestroad'],
    minLane: 115, minD: 2,
    make(ctx) {
      const { rng, lane, approach } = ctx;
      const v = Math.min(approach.v, laneMaxV(lane, approach.anchorS));
      const carA = place(lane, approach.anchorS, v);
      const side = rng.sign();
      cmd(carA, { t: INCIDENT_TICK, bias: side * 0.22, off: true });
      cmd(carA, { t: INCIDENT_TICK + 22, bias: -side * 0.24, off: true });
      const props = [];
      const p = arcPos(lane.pts, approach.anchorS + 7);
      props.push({ kind: 'rock', x: p.x, y: arcY(lane, approach.anchorS + 7), z: p.z, heading: rng.range(0, 6.28), seed: String(rng.int(1, 9999)) });
      const cars = [carA];
      const behind = placeAt(lane, carA._s0 - Math.max(18, v * 1.8), v);
      if (behind) cars.push(behind);
      return { cars, props, aggressor: 0, victim: cars.length > 1 ? 1 : -1, label: 'Rockslide', tell: 'rock down on the carriageway' };
    },
  },

  // a trunk down across a forest road
  fallentree: {
    topos: ['forestroad', 'switchback', 'mountainpass', 'coastalcliff'],
    minLane: 115, minD: 2,
    make(ctx) {
      const { rng, lane, approach } = ctx;
      const v = Math.min(approach.v, laneMaxV(lane, approach.anchorS));
      const carA = place(lane, approach.anchorS, v);
      const side = rng.sign();
      cmd(carA, { t: INCIDENT_TICK, bias: side * 0.2, off: true });
      cmd(carA, { t: INCIDENT_TICK + 22, bias: -side * 0.25, off: true });
      const props = [];
      const p = arcPos(lane.pts, approach.anchorS + 7);
      // diagonally across the lane, not fully across both — a full-width trunk
      // reaches into the oncoming lane and clips ambient traffic before 600
      props.push({ kind: 'fallen_tree', x: p.x, y: arcY(lane, approach.anchorS + 7), z: p.z, heading: p.heading + 0.7, seed: String(rng.int(1, 9999)) });
      const cars = [carA];
      const behind = placeAt(lane, carA._s0 - Math.max(18, v * 1.8), v);
      if (behind) cars.push(behind);
      return { cars, props, aggressor: 0, victim: cars.length > 1 ? 1 : -1, label: 'Fallen Tree', tell: 'a trunk is down across the road' };
    },
  },

  // a too-tall trailer stops dead at a low clearance and gets rear-ended
  overheight: {
    topos: ['tunnelmouth', 'overpass', 'cloverleaf'],
    minLane: 125,
    make(ctx) {
      const { rng, lane, approach } = ctx;
      const v = Math.min(approach.v, laneMaxV(lane, approach.anchorS));
      const truck = place(lane, approach.anchorS, v);
      truck._pool = 'HEAVY';
      cmd(truck, { t: INCIDENT_TICK, v: 0, brakeMax: 4.2 }); // realises it won't fit
      const props = [];
      const p = arcPos(lane.pts, approach.anchorS + 8);
      props.push({ kind: 'height_bar', x: p.x, y: arcY(lane, approach.anchorS + 8), z: p.z, heading: p.heading + Math.PI / 2, seed: String(rng.int(1, 9999)) });
      const cars = [truck];
      const f = placeAt(lane, truck._s0 - Math.max(16, v * 1.6), v);
      if (f) { cmd(f, { t: INCIDENT_TICK + 40, v: 0, brakeMax: 0.6 }); cars.push(f); }
      return { cars, props, aggressor: 0, victim: cars.length > 1 ? 1 : -1, label: 'Overheight Stop', tell: 'that trailer is too tall for the bridge' };
    },
  },

  // a barrier comes down and the lead slams for it
  barrierdrop: {
    // NOT intersection — a signalized junction already governs its own stops,
    // and dropping a level-crossing barrier into it collides with the queue
    topos: ['tramcrossing', 'tjunction', 'schoolzone', 'industrialyard'],
    minLane: 115,
    make(ctx) {
      const { rng, lane, approach } = ctx;
      const v = Math.min(approach.v, laneMaxV(lane, approach.anchorS));
      const lead = place(lane, approach.anchorS, v);
      cmd(lead, { t: INCIDENT_TICK, v: 0, brakeMax: 4.0 });
      const props = [];
      const p = arcPos(lane.pts, approach.anchorS + 6);
      props.push({ kind: rng.pick(['gate_arm', 'barrier_water']), x: p.x, y: arcY(lane, approach.anchorS + 6), z: p.z, heading: p.heading + Math.PI / 2, seed: String(rng.int(1, 9999)) });
      const cars = [lead];
      const f = placeAt(lane, lead._s0 - Math.max(15, v * 1.5), v);
      if (f) { cmd(f, { t: INCIDENT_TICK + 38, v: 0, brakeMax: 0.55 }); cars.push(f); }
      return { cars, props, aggressor: 0, victim: cars.length > 1 ? 1 : -1, label: 'Barrier Drop', tell: 'the barrier is coming down ahead' };
    },
  },

  // traffic loses speed in the murk and the pack behind sees it late
  fogbank: {
    topos: ['highway', 'causeway', 'boulevard', 'tunnelmouth', 'overpass', 'cloverleaf', 'riverside', 'coastalcliff'],
    minLane: 125,
    make(ctx) {
      const { rng, tellK, lane, approach } = ctx;
      // same-speed convoy; the lead only drops to a crawl AT 600 (so nothing
      // closes before then), the pack behind reacts late
      const k = clamp(2 + (ctx.d >> 2), 1, Math.max(1, Math.floor((approach.anchorS - 66) / 12)));
      const v = Math.min(approach.v, (approach.anchorS - 4 - 4.5 * k) / (10 + 1.2 * k));
      const lead = place(lane, approach.anchorS, v);
      cmd(lead, { t: INCIDENT_TICK, v: v * 0.14, brakeMax: 3.0 });
      cmd(lead, { t: INCIDENT_TICK + 70, v: 0, brakeMax: 1.4 }); // then stops, so the scene settles (no perpetual crawl)
      lead._short = true;
      const cars = [lead];
      let gap = 0;
      for (let i = 0; i < k; i++) {
        gap += Math.max(9, lead._v * (0.6 + rng.range(0, 0.24) - 0.1 * tellK) + 4.5);
        const f = placeAt(lane, lead._s0 - gap, lead._v);
        if (!f) break;
        cmd(f, { t: INCIDENT_TICK + 30 + i * (22 + rng.int(0, 16)), v: 0, brakeMax: 0.5 });
        f._short = true;
        cars.push(f);
      }
      return { cars, aggressor: 0, victim: cars.length > 1 ? 1 : -1, label: 'Fog Bank', tell: 'traffic ahead is vanishing into the fog' };
    },
  },

  // an oversize load wanders over the centre line into the oncoming lane
  wideload: {
    topos: ['highway', 'boulevard', 'overpass', 'cloverleaf', 'causeway'],
    needsOpp: true, minLane: 125,
    make(ctx) {
      const { rng, tellK, lane, opp, approach } = ctx;
      const ho = solveHeadOn(lane, opp);
      const load = ho ? place(lane, ho.aS, Math.max(MIN_V, ho.v * 0.82)) : place(lane, approach.anchorS, Math.max(MIN_V, approach.v * 0.82));
      load._pool = 'HEAVY';
      cmd(load, { t: INCIDENT_TICK, bias: 0.12, off: true }); // too wide for the lane
      cmd(load, { t: INCIDENT_TICK + 20, bias: 0.22 });
      const cars = [load];
      let victimIdx = -1;
      if (ho) {
        const oc = place(opp, ho.oS, ho.v, INCIDENT_TICK + rng.int(48, 84));
        victimIdx = cars.push(oc) - 1;
      }
      return { cars, aggressor: 0, victim: victimIdx, label: 'Wide Load', tell: 'that load is drifting over the line' };
    },
  },

  // a slick surface: the leader eases down, the follower brakes hard but the
  // wet road (these topos carry wxGrip) runs the stop long. The bet IS the grip
  lowgrip: {
    // wxGrip topos only — the whole bet is that the wet road runs the stop long,
    // which does not exist on a dry preset (switchback/causeway carry no grip)
    topos: ['mountainpass', 'canyon', 'forestroad', 'coastalcliff', 'riverside'],
    minLane: 120,
    make(ctx) {
      const { rng, lane, approach } = ctx;
      const v = Math.min(approach.v, laneMaxV(lane, approach.anchorS));
      const lead = place(lane, approach.anchorS, v);
      cmd(lead, { t: INCIDENT_TICK, v: 0, brakeMax: 2.4 }); // eases to a full stop, so the round settles
      const cars = [lead];
      // a tighter follower gap so the wet road (not luck) decides the outcome —
      // on dry grip it stops here, on a slick road it runs on into the lead
      const f = placeAt(lane, lead._s0 - Math.max(12, v * 1.05), v);
      if (f) { cmd(f, { t: INCIDENT_TICK + 14, v: 0, brakeMax: 4.6 }); cars.push(f); } // hard brake on a slick road
      return { cars, aggressor: 1, victim: 0, label: 'Lost Traction', tell: 'the road is slick and someone is stopping' };
    },
  },

  // standing water in a dip — a car aquaplanes and slews wide
  flooddip: {
    topos: ['riverside', 'causeway', 'harbourramp', 'coastalcliff'],
    minLane: 115,
    make(ctx) {
      const { rng, lane, approach } = ctx;
      const v = Math.min(approach.v, laneMaxV(lane, approach.anchorS));
      const carA = place(lane, approach.anchorS, v);
      const side = rng.sign();
      cmd(carA, { t: INCIDENT_TICK, bias: side * 0.17, off: true });
      cmd(carA, { t: INCIDENT_TICK + 18, bias: side * 0.29, off: true }); // aquaplanes, cannot pull it back
      const cars = [carA];
      const behind = placeAt(lane, carA._s0 - Math.max(16, v * 1.6), v);
      if (behind) cars.push(behind);
      return { cars, aggressor: 0, victim: cars.length > 1 ? 1 : -1, label: 'Flooded Dip', tell: 'standing water across the dip' };
    },
  },

  /* ============ G6 bespoke motifs (the library grows to ~12x) ============
     Same contract as everything above. Variants of these are stamped out by
     the factory/reskin block after this object; each family shares a `cal`
     key (meta.calKey) so calibration cells stay thick. */

  // an illegal U-turn across the centreline, stalling broadside in oncoming
  uturn: {
    topos: ['suburb', 'city', 'boulevard', 'highway', 'tjunction', 'riverside', 'coastalcliff'],
    needsOpp: true, cal: 'uturn',
    make(ctx) {
      const { rng, tellK, lane, opp } = ctx;
      const ho = solveHeadOn(lane, opp);
      const turner = place(lane, ho.aS, Math.max(MIN_V, ho.v * 0.8));
      if (tellK > 0.7) cmd(turner, { t: 520, v: turner._v * 0.75 }); // the hesitation is the tell
      cmd(turner, { t: INCIDENT_TICK, bias: 0.3, off: true });        // hard lock across
      // hand control back so the stall actually settles — a car left in `off`
      // orbits on the 0.1 drag brake for thousands of ticks (first sweep ran
      // 21% of scenes to the cap; the recoveries below are the fix)
      cmd(turner, { t: INCIDENT_TICK + 70, off: false, bias: 0, v: 0, brakeMax: 0.9 }); // stalls broadside
      const oc = place(opp, ho.oS, ho.v, INCIDENT_TICK + rng.int(55, 95));
      cmd(oc, { t: INCIDENT_TICK + 60, v: 0, brakeMax: 0.5 });        // sees it far too late
      return { cars: [turner, oc], aggressor: 0, victim: 1, label: 'Illegal U-Turn', tell: 'that one keeps slowing for no reason' };
    },
  },

  // an overtake into the oncoming lane, timed exactly wrong
  overtake: {
    topos: ['suburb', 'highway', 'causeway', 'boulevard', 'tunnelmouth', 'overpass', 'cloverleaf', 'forestroad', 'riverside', 'coastalcliff', 'tjunction'],
    // 175: the slow lead's run-up PLUS the closing-speed spawn gap must fit
    // behind the anchor, or placeAt returns null and the scene is one slow car
    needsOpp: true, minLane: 175, cal: 'overtake',
    make(ctx) {
      const { rng, tellK, lane, opp, approach } = ctx;
      const vL = Math.max(MIN_V * 0.85, approach.v * 0.58);      // the slow lead
      const lead = place(lane, approach.anchorS, vL);
      lead._short = true;
      const vO = Math.min(approach.v + 1, laneMaxV(lane, approach.anchorS - 14));
      // spawn gap = 10 s of closing speed + a safe cushion, so the overtaker
      // arrives boxed-in at T=0 without ever touching the lead before it
      const gap0 = (vO - vL) * 10 + 12 + 6 * tellK;
      const taker = placeAt(lane, lead._s0 - gap0, vO);
      const cars = [lead];
      let victimIdx = -1;
      if (taker) {
        taker._short = true; taker._pool = rng.chance(0.4) ? 'FAST' : undefined;
        cmd(taker, { t: INCIDENT_TICK, bias: 0.16, off: true });       // swings out
        cmd(taker, { t: INCIDENT_TICK + 26, bias: 0.02, off: true });  // commits down the wrong side
        cmd(taker, { t: INCIDENT_TICK + 30, v: vO + 4 });
        cmd(taker, { t: INCIDENT_TICK + 150, bias: -0.2, off: true }); // dives back in (late)
        cmd(taker, { t: INCIDENT_TICK + 190, off: false, bias: 0, v: 0, brakeMax: 0.5 }); // pulls up, shaken
        cars.push(taker);
        // oncoming arrives at the overtake zone while the taker is out there
        const oS = Math.max(24, opp.len - approach.anchorS + 10);
        if (oS < opp.len - 20) {
          const oc = place(opp, oS, Math.min(opp.v, laneMaxV(opp, oS)), INCIDENT_TICK + rng.int(60, 110));
          cmd(oc, { t: INCIDENT_TICK + 175, v: 0, brakeMax: 0.45 }); // stops after the scare — the scene concludes
          victimIdx = cars.push(oc) - 1;
        }
      }
      return { cars, aggressor: cars.length > 1 ? 1 : 0, victim: victimIdx, label: 'Blind Overtake', tell: 'someone is boxed in and impatient' };
    },
  },

  // two racers pull level during the preview — then one of them blinks
  race: {
    topos: ['highway', 'boulevard', 'causeway', 'tunnelmouth', 'overpass', 'cloverleaf', 'city'],
    minLane: 130, cal: 'race',
    make(ctx) {
      const { rng, lane, approach } = ctx;
      const v = Math.min(approach.v + 2, laneMaxV(lane, approach.anchorS));
      const carA = place(lane, approach.anchorS, v);
      carA._pool = 'FAST'; carA._short = true;
      // B starts 9.5 m back and 0.95 m/s hotter — pulls exactly level by T=0
      const carB = placeAt(lane, carA._s0 - 9.5, v + 0.95);
      const cars = [carA];
      if (carB) {
        carB._pool = 'FAST'; carB._short = true;
        // riding the centreline the whole preview: the second half of the tell
        cmd(carB, { t: 200, bias: 0.055, off: false });
        cmd(carB, { t: INCIDENT_TICK, bias: -0.16, off: true }); // squeezes back in — on top of A
        cmd(carB, { t: INCIDENT_TICK + 30, bias: 0.1, off: true });
        cmd(carB, { t: INCIDENT_TICK + 80, off: false, bias: 0, v: 0, brakeMax: 1.4 }); // gathers it up, stops
        cars.push(carB);
      }
      return { cars, aggressor: cars.length > 1 ? 1 : 0, victim: 0, label: 'Street Race', tell: 'two of them are racing — watch the gap close' };
    },
  },

  // a lead driver brake-checks the tailgater — twice
  brakecheck: {
    topos: ['highway', 'city', 'suburb', 'boulevard', 'causeway', 'tunnelmouth', 'overpass', 'cloverleaf', 'riverside'],
    minLane: 135, cal: 'brakecheck',
    make(ctx) {
      const { rng, tellK, lane, approach } = ctx;
      const v = Math.min(approach.v, laneMaxV(lane, approach.anchorS), (approach.anchorS - 10) / 11.2);
      const lead = place(lane, approach.anchorS, v);
      lead._short = true;
      cmd(lead, { t: INCIDENT_TICK, v: v * 0.42, brakeMax: 2.1 });        // the check
      cmd(lead, { t: INCIDENT_TICK + 42, v: v * 0.95 });                  // and off again
      cmd(lead, { t: INCIDENT_TICK + 105, v: 0, brakeMax: 3.8 });         // the second one sticks
      const gap = Math.max(6.4, v * (0.3 - 0.08 * tellK) + 3.6);
      const tail = placeAt(lane, lead._s0 - gap, v);
      const cars = [lead];
      if (tail) {
        tail._short = true;
        cmd(tail, { t: INCIDENT_TICK + 30 + rng.int(0, 14), v: 0, brakeMax: 0.55 });
        cars.push(tail);
      }
      return { cars, aggressor: 0, victim: cars.length > 1 ? 1 : -1, label: 'Brake Check', tell: 'the one in front keeps testing the gap' };
    },
  },

  // the pedal sticks wide open right as traffic ahead stacks up
  stuckthrottle: {
    topos: ['highway', 'city', 'suburb', 'boulevard', 'causeway', 'tunnelmouth', 'overpass', 'cloverleaf', 'schoolzone', 'industrialyard'],
    minLane: 130, cal: 'stuckthrottle',
    make(ctx) {
      const { rng, lane, approach } = ctx;
      const sQ = approach.anchorS;
      const q1 = placeParked(lane, sQ);
      q1._short = true;
      const v = Math.min(approach.v, laneMaxV(lane, sQ - 30));
      const comer = place(lane, sQ - 30, v);
      comer._short = true;
      cmd(comer, { t: INCIDENT_TICK, v: 30, noBrake: true }); // wide open, no pedal
      cmd(comer, { t: INCIDENT_TICK + 24, bias: rng.sign() * 0.05 }); // fighting the wheel
      return { cars: [comer, q1], aggressor: 0, victim: 1, label: 'Stuck Throttle', tell: 'listen for the one that never lifts' };
    },
  },

  // steering locks solid right where the road stops being straight
  steerfail: {
    topos: ['city', 'switchback', 'forestroad', 'mountainpass', 'canyon', 'coastalcliff', 'causeway'],
    needsCurve: true, minD: 2, cal: 'steerfail',
    make(ctx) {
      const { rng, lane, curveS } = ctx;
      const v = Math.min(lane.v + 1.5, laneMaxV(lane, curveS));
      const carA = place(lane, curveS, v);
      cmd(carA, { t: INCIDENT_TICK, bias: 0, off: true }); // wheel frozen — straight on
      cmd(carA, { t: INCIDENT_TICK + 110, off: false, bias: 0, v: 0, brakeMax: 2.2 }); // grinds it to a stop
      const props = bendCatchers(ctx, lane, curveS, ['tree_oak', 'lamp_cobra', 'rock']);
      const cars = [carA];
      const behind = placeAt(lane, carA._s0 - Math.max(18, v * 1.8), v);
      if (behind) cars.push(behind);
      return { cars, props, aggressor: 0, victim: -1, label: 'Steering Failure', tell: 'watch the wheel stop answering' };
    },
  },

  // a heavy starts swaying, and each correction is bigger than the last
  fishtail: {
    topos: ['highway', 'causeway', 'boulevard', 'overpass', 'cloverleaf', 'tunnelmouth'],
    minLane: 130, cal: 'fishtail',
    make(ctx) {
      const { rng, tellK, lane, approach } = ctx;
      const v = Math.min(approach.v + 1, laneMaxV(lane, approach.anchorS));
      const rig = place(lane, approach.anchorS, v);
      rig._pool = 'HEAVY';
      if (tellK > 0.8) cmd(rig, { t: 520, bias: -0.012 }); // the first small sway
      cmd(rig, { t: INCIDENT_TICK, bias: 0.14, off: true });
      cmd(rig, { t: INCIDENT_TICK + 22, bias: -0.2, off: true });
      cmd(rig, { t: INCIDENT_TICK + 46, bias: 0.26, off: true });
      cmd(rig, { t: INCIDENT_TICK + 70, off: false, bias: 0, v: 0, brakeMax: 1.2 });
      const cars = [rig];
      const behind = placeAt(lane, rig._s0 - Math.max(20, v * 1.9), v);
      if (behind) { cmd(behind, { t: INCIDENT_TICK + 50, v: 0, brakeMax: 0.6 }); cars.push(behind); }
      return { cars, aggressor: 0, victim: cars.length > 1 ? 1 : -1, label: 'Trailer Sway', tell: 'the back end is not following the front' };
    },
  },

  // a parked car's handbrake lets go — it creeps out into the road
  runaway: {
    topos: ['suburb', 'city', 'schoolzone', 'boulevard', 'tjunction', 'riverside'],
    cal: 'pullout',
    make(ctx) {
      const { rng, lane, approach } = ctx;
      const sMerge = approach.anchorS;
      const victim = place(lane, sMerge, approach.v, INCIDENT_TICK + rng.int(90, 150));
      cmd(victim, { t: INCIDENT_TICK + rng.int(70, 100), v: 0, brakeMax: 0.4 });
      const pp = arcPos(lane.pts, sMerge + 5);
      const ph = arcPos(lane.pts, sMerge + 11);
      let nx = -(ph.z - pp.z), nz = ph.x - pp.x;
      const nl = Math.hypot(nx, nz) || 1;
      nx /= nl; nz /= nl;
      const off = lane.w / 4 + 2.2;
      const px = pp.x + nx * off, pz = pp.z + nz * off;
      const cross = [px, pz];
      for (let k = 1; k <= 4; k++) cross.push(px - nx * (off + 1.4) * (k / 4) * 1.3, pz - nz * (off + 1.4) * (k / 4) * 1.3);
      const ghost = {
        x: px, z: pz, heading: Math.atan2(nz, -nx), speed: 0,
        // nobody at the wheel: a slow constant creep, no reaction ever
        drive: { pts: cross, v: 0, end: 'coast', cmds: [{ t: INCIDENT_TICK, v: 2.1, noBrake: true }] },
        _lane: lane, _s0: sMerge + 5, _v: 0, _anchor: sMerge,
      };
      return { cars: [victim, ghost], aggressor: 1, victim: 0, label: 'Runaway Car', tell: 'no driver in the one on the shoulder' };
    },
  },

  // a drift onto the shoulder wipes out a row of parked cars
  parkedrow: {
    topos: ['suburb', 'city', 'schoolzone', 'boulevard', 'tjunction'],
    minLane: 120, cal: 'parkedrow',
    make(ctx) {
      const { rng, tellK, lane, approach } = ctx;
      const v = Math.min(approach.v, laneMaxV(lane, approach.anchorS));
      const carA = place(lane, approach.anchorS - 6, v);
      if (tellK > 0.8) cmd(carA, { t: 500, bias: -0.014 });
      cmd(carA, { t: INCIDENT_TICK, bias: -(0.1 + rng.range(0, 0.04)), off: true }); // drifts shoulder-side
      const cars = [carA];
      // the row: 2–3 parked cars on the shoulder ahead, nose to tail
      const off = lane.w / 4 + 2.1;
      const n = 2 + (rng.chance(0.5) ? 1 : 0);
      for (let k = 0; k < n; k++) {
        const s = approach.anchorS + 4 + k * 7.5;
        if (s > lane.len - 4) break;
        const pp = arcPos(lane.pts, s);
        const ph = arcPos(lane.pts, Math.min(lane.len, s + 5));
        let nx = -(ph.z - pp.z), nz = ph.x - pp.x;
        const nl = Math.hypot(nx, nz) || 1;
        nx /= nl; nz /= nl;
        cars.push({
          x: pp.x + nx * off, y: arcY(lane, s), z: pp.z + nz * off, heading: pp.heading, speed: 0,
          drive: { pts: [pp.x + nx * off, pp.z + nz * off, ph.x + nx * off, ph.z + nz * off], v: 0, end: 'stop', cmds: [] },
          _lane: null, _s0: 0, _v: 0, _anchor: 0, _short: true,
        });
      }
      return { cars, aggressor: 0, victim: cars.length > 1 ? 1 : -1, label: 'Parked Row', tell: 'that one is wandering toward the parked cars' };
    },
  },

  // a level crossing, a tram that physically cannot stop, and a chancer
  tramstrike: {
    topos: ['tramcrossing'], minD: 2, cal: 'tramstrike',
    make(ctx) {
      const { rng, topo, tellK } = ctx;
      // crossing pairs are [ew, ns] by construction; the tram rides the ns rails
      const [ia, ib] = rng.pick(topo.crossings);
      const carLane = topo.lanes[ia], tramLane = topo.lanes[ib];
      const x = crossOf(carLane, tramLane);
      const vTram = Math.min(10, laneMaxV(tramLane, x.sB));
      const vCar = Math.min(carLane.v + 1 + tellK, laneMaxV(carLane, x.sA));
      const tMeet = INCIDENT_TICK + rng.int(12, 20);
      const chancer = place(carLane, x.sA, vCar, tMeet);
      const tram = place(tramLane, x.sB, vTram, tMeet + rng.int(-2, 3));
      tram._type = 'tram';
      return { cars: [tram, chancer], aggressor: 0, victim: 1, label: 'Level Crossing', tell: 'a tram cannot stop — someone is chancing it' };
    },
  },

  // roundabout: an entry that never yields to the circulating car
  yieldfail: {
    topos: ['roundabout'], cal: 'yieldfail',
    make(ctx) {
      const { rng, topo, tellK } = ctx;
      const [ie, ic] = rng.pick(topo.crossings); // [entering, circulating]
      const enter = topo.lanes[ie], circ = topo.lanes[ic];
      /* NOT crossOf: these two paths MERGE, and on merging paths crossOf's
         min-distance point lands anywhere along the shared arc — timing both
         cars to a point 20 m downstream had them converging nose-to-tail on
         the ring well before tick 600 (the first sweep's roundabout defects).
         The meet is the MOUTH, which the topology already published as the
         yield zone: the entering lane's give-way arc, and the circulating
         lane's closest approach to the zone centre. */
      const zone = topo.yieldZones.find((y) => y.road === enter.road);
      const sA = zone.s + 4; // just past the give-way line — in the mouth
      let sB = 0, best = 1e9, acc = 0;
      for (let i = 0; i < circ.pts.length; i += 2) {
        if (i) acc += Math.hypot(circ.pts[i] - circ.pts[i - 2], circ.pts[i + 1] - circ.pts[i - 1]);
        const d2 = (circ.pts[i] - zone.x) ** 2 + (circ.pts[i + 1] - zone.z) ** 2;
        if (d2 < best) { best = d2; sB = acc; }
      }
      const vC = Math.min(circ.v, laneMaxV(circ, sB));
      const vE = Math.min(enter.v + 1.5 + 2 * tellK, laneMaxV(enter, sA));
      const tMeet = INCIDENT_TICK + rng.int(10, 18);
      const victim = place(circ, sB, vC, tMeet);
      const runner = place(enter, sA, vE, tMeet + rng.int(-3, 2));
      return { cars: [victim, runner], aggressor: 1, victim: 0, label: 'Failure To Yield', tell: 'one entry is carrying way too much speed' };
    },
  },

  // roundabout: far too fast to turn at all — straight over the island
  islandhop: {
    topos: ['roundabout'], minD: 3, cal: 'islandhop',
    make(ctx) {
      const { rng, topo } = ctx;
      // build a straight ghost lane through the island off one real entry
      const src = rng.pick(topo.lanes);
      const p0 = src.pts[0], p1 = src.pts[1]; // entry rides the arm axis
      const hx0 = src.pts[2] - src.pts[0], hz0 = src.pts[3] - src.pts[1];
      const hl = Math.hypot(hx0, hz0) || 1;
      const dx = hx0 / hl, dz = hz0 / hl;
      const pts = [];
      for (let t = 0; t <= 210; t += 2.5) pts.push(p0 + dx * t, p1 + dz * t);
      const ghostLane = { pts, len: laneLen(pts), v: src.v + 5, w: 8, road: 'hop' };
      const sMouth = 128 - 30; // the mouth sits ~R+7 before centre on a 128 arm
      const carA = place(ghostLane, sMouth, Math.min(15, laneMaxV(ghostLane, sMouth)));
      cmd(carA, { t: 585, v: 19 }); // the final surge — same shape as overspeed
      cmd(carA, { t: INCIDENT_TICK + 90, v: 0, brakeMax: 0.8 });
      return { cars: [carA], aggressor: 0, victim: -1, label: 'Straight Over', tell: 'count how fast that entry is' };
    },
  },

  // a car stalls inside the junction box; cross traffic has the green
  spillback: {
    topos: ['intersection', 'tramcrossing'], minD: 2, cal: 'spillback',
    make(ctx) {
      const { rng, topo, tellK } = ctx;
      const [ia, ib] = rng.pick(topo.crossings);
      const blockLane = topo.lanes[ia], crossLane = topo.lanes[ib];
      const x = crossOf(blockLane, crossLane);
      // the blocker eases in and dies right in the box, ten ticks early
      const blocker = place(blockLane, x.sA, Math.max(MIN_V, blockLane.v * 0.8), INCIDENT_TICK - 10);
      cmd(blocker, { t: INCIDENT_TICK - 12, v: 0, brakeMax: 2.6 }); // engine gone
      blocker._short = true;
      const vX = Math.min(crossLane.v + tellK, laneMaxV(crossLane, x.sB));
      const crosser = place(crossLane, x.sB, vX, INCIDENT_TICK + rng.int(16, 30));
      cmd(crosser, { t: INCIDENT_TICK + rng.int(8, 18), v: 0, brakeMax: 0.5 });
      return { cars: [blocker, crosser], aggressor: 1, victim: 0, label: 'Blocked Box', tell: 'someone is about to be stranded in the box' };
    },
  },

  // a gust takes a high-sided vehicle across the line — or into the rail
  gustshove: {
    topos: ['causeway', 'coastalcliff', 'overpass', 'harbourramp', 'cloverleaf'],
    minLane: 120, cal: 'gustshove',
    make(ctx) {
      const { rng, lane, approach } = ctx;
      const v = Math.min(approach.v, laneMaxV(lane, approach.anchorS));
      const rig = place(lane, approach.anchorS, v);
      rig._pool = 'HEAVY';
      const side = rng.sign();
      cmd(rig, { t: INCIDENT_TICK, bias: side * 0.12, off: true });   // the gust
      cmd(rig, { t: INCIDENT_TICK + 26, bias: -side * 0.2, off: true }); // the overcorrection
      cmd(rig, { t: INCIDENT_TICK + 60, off: false, bias: 0, v: 0, brakeMax: 1.0 });
      const cars = [rig];
      const behind = placeAt(lane, rig._s0 - Math.max(18, v * 1.7), v);
      if (behind) { cmd(behind, { t: INCIDENT_TICK + 44, v: 0, brakeMax: 0.6 }); cars.push(behind); }
      return { cars, aggressor: 0, victim: cars.length > 1 ? 1 : -1, label: 'Crosswind', tell: 'the tall one is leaning on the wind' };
    },
  },

  // brakes give out on the quay — nothing between the car and the harbour
  quayplunge: {
    topos: ['harbourramp'], cal: 'quayplunge',
    make(ctx) {
      const { rng, lane, approach } = ctx;
      const v = Math.min(approach.v + 2, laneMaxV(lane, approach.anchorS));
      const carA = place(lane, approach.anchorS, v);
      cmd(carA, { t: 552, noBrake: true });                      // the failure, invisible
      cmd(carA, { t: INCIDENT_TICK, bias: 0, off: true });       // frozen, straight at the edge
      const cars = [carA];
      const behind = placeAt(lane, carA._s0 - Math.max(18, v * 1.8), v);
      if (behind) cars.push(behind);
      return { cars, aggressor: 0, victim: -1, label: 'Dead Pedal At The Quay', tell: 'no brake lights where there should be' };
    },
  },

  // parking lot pedal error: through the planters, into the storefront
  storefront: {
    topos: ['parkinglot'], cal: 'storefront',
    make(ctx) {
      const { rng, lane, approach } = ctx;
      const v = Math.min(approach.v, laneMaxV(lane, approach.anchorS));
      const carA = place(lane, approach.anchorS, v);
      // aim the veer at the shop (parking lots always dress one at 0,−40),
      // via the pure-pursuit lateral convention: side = sign(hz·ox − hx·oz)
      const p = arcPos(lane.pts, approach.anchorS);
      const hx = Math.cos(p.heading), hz = -Math.sin(p.heading);
      const side = Math.sign(hz * (0 - p.x) - hx * (-40 - p.z)) || 1;
      cmd(carA, { t: INCIDENT_TICK, v: 15, bias: side * 0.24, off: true, noBrake: true });
      cmd(carA, { t: INCIDENT_TICK + 150, off: false, bias: 0, v: 0, noBrake: false, brakeMax: 1.2 });
      const props = [];
      for (let k = 0; k < 2; k++) {
        props.push({
          kind: rng.pick(['planter_stone', 'bollard']),
          x: rng.range(-8, 8), z: -27 - k * 5, heading: rng.range(0, 6.28), seed: String(rng.int(1, 9999)),
        });
      }
      return { cars: [carA], props, aggressor: 0, victim: -1, label: 'Pedal Error', tell: 'watch the one aimed at the shopfront' };
    },
  },

  // two cars merging into the same gap from both sides of it
  mergeduel: {
    topos: ['highway', 'causeway', 'boulevard', 'overpass', 'cloverleaf', 'industrialyard', 'parkinglot'],
    minLane: 125, cal: 'merge',
    make(ctx) {
      const { rng, tellK, lane, approach } = ctx;
      const v = Math.min(approach.v, laneMaxV(lane, approach.anchorS));
      const held = place(lane, approach.anchorS, v);
      held._short = true;
      const m1 = placeAt(lane, held._s0 - Math.max(9, v * 0.7), v * 1.14);
      const m2 = placeAt(lane, held._s0 - Math.max(19, v * 1.5), v * 1.22);
      const cars = [held];
      if (m1) {
        m1._short = true;
        cmd(m1, { t: INCIDENT_TICK - 12, bias: 0.09 * tellK, off: true });
        cmd(m1, { t: INCIDENT_TICK, bias: -0.3, off: true });
        cars.push(m1);
      }
      if (m2) {
        m2._short = true;
        cmd(m2, { t: INCIDENT_TICK + 8, bias: 0.12, off: true });
        cmd(m2, { t: INCIDENT_TICK + 30, bias: -0.32, off: true });
        cars.push(m2);
      }
      return { cars, aggressor: cars.length > 1 ? 1 : 0, victim: 0, label: 'Merge Duel', tell: 'two of them want the same gap' };
    },
  },

  // a motorcycle carries too much lean into the bend and loses the front
  bikedown: {
    topos: ['city', 'switchback', 'forestroad', 'mountainpass', 'canyon', 'coastalcliff'],
    needsCurve: true, minD: 2, cal: 'bikedown',
    make(ctx) {
      const { rng, lane, curveS } = ctx;
      const v = Math.min(lane.v + 3, laneMaxV(lane, curveS));
      const bike = place(lane, curveS, v);
      bike._type = rng.pick(['moto', 'chopper']);
      cmd(bike, { t: 585, v: Math.min(22, v + 7) });
      cmd(bike, { t: INCIDENT_TICK, bias: rng.sign() * 0.3, off: true }); // the front lets go
      cmd(bike, { t: INCIDENT_TICK + 30, off: false, bias: 0, v: 0, brakeMax: 0.4 });
      const props = bendCatchers(ctx, lane, curveS, ['rock', 'tree_pine', 'lamp_cobra']);
      const cars = [bike];
      const behind = placeAt(lane, bike._s0 - Math.max(16, v * 1.5), v);
      if (behind) { cmd(behind, { t: INCIDENT_TICK + 36, v: 0, brakeMax: 0.6 }); cars.push(behind); }
      return { cars, props, aggressor: 0, victim: -1, label: 'Bike Down', tell: 'that bike is committed to the corner' };
    },
  },

  // a stall parked just past the causeway crest, invisible until too late
  blindcrest: {
    topos: ['causeway'], minLane: 150, cal: 'stall',
    make(ctx) {
      const { rng, tellK, lane } = ctx;
      const sDead = clamp(lane.len * 0.53, 70, lane.len - 45);
      const dead = placeParked(lane, sDead);
      dead._short = true;
      const v = Math.min(lane.v + 2 + tellK, laneMaxV(lane, sDead - 11));
      const comer = place(lane, sDead - 11, v);
      cmd(comer, { t: INCIDENT_TICK + 12, v: 0, brakeMax: 0.7 });
      const cars = [comer, dead];
      const props = [];
      if (rng.chance(0.5)) {
        const p = arcPos(lane.pts, sDead + 6);
        props.push({ kind: 'cone', x: p.x, y: arcY(lane, sDead + 6), z: p.z, heading: 0, seed: String(rng.int(1, 9999)) });
      }
      return { cars, props, aggressor: 0, victim: 1, label: 'Beyond The Crest', tell: 'you cannot see past the hump — someone is parked there' };
    },
  },

  // a drift right mows down the street furniture line
  furnrun: {
    topos: ['city', 'boulevard', 'schoolzone', 'suburb'],
    minLane: 120, cal: 'furnrun',
    make(ctx) {
      const { rng, tellK, lane, approach } = ctx;
      const v = Math.min(approach.v, laneMaxV(lane, approach.anchorS));
      const carA = place(lane, approach.anchorS - 4, v);
      if (tellK > 0.7) cmd(carA, { t: 510, bias: -0.012 });
      cmd(carA, { t: INCIDENT_TICK, bias: -(0.09 + rng.range(0, 0.03)), off: true });
      cmd(carA, { t: INCIDENT_TICK + 90, v: 0, brakeMax: 0.5 });
      const props = [];
      for (let k = 0; k < 3; k++) {
        const s = approach.anchorS + 4 + k * 8;
        if (s > lane.len - 4) break;
        const pp = arcPos(lane.pts, s);
        const ph = arcPos(lane.pts, Math.min(lane.len, s + 5));
        let nx = -(ph.z - pp.z), nz = ph.x - pp.x;
        const nl = Math.hypot(nx, nz) || 1;
        nx /= nl; nz /= nl;
        const off = lane.w / 4 + 2.5 + k * 0.4;
        const px = pp.x + nx * off, pz = pp.z + nz * off;
        // never inside another lane's corridor (the overspeed lesson)
        let onLane = false;
        for (const l of ctx.topo.lanes) {
          if (l === lane || onLane) continue;
          for (let i = 0; i < l.pts.length; i += 2) {
            if ((l.pts[i] - px) ** 2 + (l.pts[i + 1] - pz) ** 2 < 3.4 * 3.4) { onLane = true; break; }
          }
        }
        if (onLane) continue;
        props.push({
          kind: rng.pick(ctx.topo.name === 'suburb' || ctx.topo.name === 'schoolzone'
            ? ['hydrant', 'mailbox', 'trash_can'] : ['lamp_cobra', 'bollard', 'bin_wheelie']),
          x: px, z: pz, heading: rng.range(0, 6.28), seed: String(rng.int(1, 9999)),
        });
      }
      const cars = [carA];
      return { cars, props, aggressor: 0, victim: -1, label: 'Furniture Run', tell: 'that one is drifting at the kerb line' };
    },
  },

  // two red-light runners from crossing arms find each other in the box
  redlight2: {
    topos: ['intersection'], minD: 4, cal: 'redlight',
    make(ctx) {
      const { rng, topo, tellK } = ctx;
      const [ia, ib] = rng.pick(topo.crossings);
      const la = topo.lanes[ia], lb = topo.lanes[ib];
      const x = crossOf(la, lb);
      const vA = Math.min(12 + 2 * tellK, laneMaxV(la, x.sA));
      const vB = Math.min(12.5 + 2 * tellK, laneMaxV(lb, x.sB));
      const tMeet = INCIDENT_TICK + rng.int(12, 18);
      const runA = place(la, x.sA, vA, tMeet);
      const runB = place(lb, x.sB, vB, tMeet + rng.int(-2, 2));
      return { cars: [runA, runB], aggressor: 1, victim: 0, label: 'Double Runner', tell: 'neither approach is slowing down' };
    },
  },

  // a pursuit blows the junction; cross traffic has the green
  chasecross: {
    topos: ['intersection', 'tramcrossing'], minD: 3, cal: 'redlight',
    make(ctx) {
      const { rng, topo, tellK } = ctx;
      const [ia, ib] = rng.pick(topo.crossings);
      const vic = topo.lanes[ia], run = topo.lanes[ib];
      const x = crossOf(vic, run);
      const vVic = Math.min(vic.v, laneMaxV(vic, x.sA));
      const vRun = Math.min(13.5 + 2 * tellK, laneMaxV(run, x.sB));
      const tMeet = INCIDENT_TICK + rng.int(13, 21);
      const victim = place(vic, x.sA, vVic, tMeet);
      const runner = place(run, x.sB, vRun, tMeet + rng.int(-3, 3));
      runner._pool = 'FAST'; runner._short = true;
      const cars = [victim, runner];
      const cop = placeAt(run, runner._s0 - 10, runner._v);
      if (cop) { cop._pool = 'POLICE'; cop._short = true; cmd(cop, { t: INCIDENT_TICK + 10, v: 0, brakeMax: 1.6 }); cars.push(cop); }
      return { cars, aggressor: 1, victim: 0, label: 'Chase Through The Box', tell: 'the sirens are coming in from the side street' };
    },
  },

  // roundabout ghost: someone enters against circulation via an exit
  wrongring: {
    topos: ['roundabout'], minD: 3, cal: 'wrongway',
    make(ctx) {
      const { rng, topo } = ctx;
      const src = rng.pick(topo.lanes);
      // the ghost rides src's path REVERSED: in via the exit, wrong way round
      const rev = [];
      for (let i = src.pts.length - 2; i >= 0; i -= 2) rev.push(src.pts[i], src.pts[i + 1]);
      const ghostLane = { pts: rev, len: src.len, v: src.v * 0.85, w: 8, road: 'ghost' };
      // meet mid-arc: the ghost reaches the shared ring stretch just after T=0
      const sMeet = src.len * 0.5;
      const victim = place(src, src.len - sMeet, src.v, INCIDENT_TICK + rng.int(40, 70));
      const ghost = place(ghostLane, sMeet, ghostLane.v, INCIDENT_TICK + rng.int(40, 70));
      cmd(ghost, { t: INCIDENT_TICK + 30, bias: 0.06, off: true });
      cmd(ghost, { t: INCIDENT_TICK + 110, off: false, bias: 0, v: 0, brakeMax: 1.0 });
      return { cars: [victim, ghost], aggressor: 1, victim: 0, label: 'Wrong Way Round', tell: 'one of them is circling the wrong way' };
    },
  },

};

/* ============ G6 variant families ============
   Two factories and a reskin stamp named variants over proven choreography.
   `reskin(base, o)` re-runs the BASE template's make() — identical rng draw
   order, identical invariants — then retouches the result (labels, forced
   casts, prop swaps). Forced casts obey the same safety arguments the cast
   pass makes: heavies are only ever forced onto straight-lane topologies,
   where bendy() would have allowed them anyway. Every variant carries its
   family's `cal` key, so calibration prices the family, not the costume. */

// obstacle-in-lane swerve (the debris pattern) with a themed obstacle set
const swerveAt = (o) => ({
  topos: o.topos, minLane: 115, minD: o.minD, cal: o.cal || 'debris',
  make(ctx) {
    const { rng, lane, approach } = ctx;
    const v = Math.min(approach.v, laneMaxV(lane, approach.anchorS));
    const carA = place(lane, approach.anchorS, v);
    if (o.pool) carA._pool = o.pool;
    const side = rng.sign();
    cmd(carA, { t: INCIDENT_TICK, bias: side * (o.b1 || 0.2), off: true });
    cmd(carA, { t: INCIDENT_TICK + 20, bias: -side * (o.b2 || 0.26), off: true });
    const props = [];
    const p = arcPos(lane.pts, approach.anchorS + 7);
    props.push({ kind: rng.pick(o.kinds), x: p.x, y: arcY(lane, approach.anchorS + 7), z: p.z, heading: rng.range(0, 6.28), seed: String(rng.int(1, 9999)) });
    if (o.extraKind && rng.chance(0.7)) {
      const q = arcPos(lane.pts, approach.anchorS + 10.5);
      props.push({ kind: o.extraKind, x: q.x + rng.range(-1.4, 1.4), y: arcY(lane, approach.anchorS + 10.5), z: q.z + rng.range(-1.4, 1.4), heading: rng.range(0, 6.28), seed: String(rng.int(1, 9999)) });
    }
    const cars = [carA];
    const behind = placeAt(lane, carA._s0 - Math.max(18, v * 1.8), v);
    if (behind) cars.push(behind);
    return { cars, props, aggressor: 0, victim: cars.length > 1 ? 1 : -1, label: o.label, tell: o.tell };
  },
});

// late braking into a stopped queue (the sunblind pattern), themed
const queueSlam = (o) => ({
  topos: o.topos, minLane: 125, minD: o.minD, cal: 'sunblind',
  make(ctx) {
    const { rng, lane, approach } = ctx;
    const sQ = approach.anchorS;
    const big = !!o.qPool;
    const q1 = placeParked(lane, sQ);
    if (big) q1._pool = o.qPool; else q1._short = true;
    const q2 = placeParked(lane, sQ - (big ? 11.5 : 9));
    q2._short = true;
    const back = big ? 19.5 : 15;
    const v = Math.min(approach.v + (o.hot || 3), laneMaxV(lane, sQ - back));
    const comer = place(lane, sQ - back, v);
    comer._short = true;
    cmd(comer, { t: INCIDENT_TICK + (o.react || 22), v: 0, brakeMax: o.brake || 0.9 });
    return { cars: [comer, q2, q1], aggressor: 0, victim: 1, label: o.label, tell: o.tell };
  },
});

// re-run a proven template, then retouch the result
const reskin = (base, o) => ({
  topos: o.topos || TEMPLATES[base].topos,
  minLane: o.minLane !== undefined ? o.minLane : TEMPLATES[base].minLane,
  minD: o.minD !== undefined ? o.minD : TEMPLATES[base].minD,
  needsOpp: TEMPLATES[base].needsOpp, needsCurve: TEMPLATES[base].needsCurve,
  cal: TEMPLATES[base].cal || base,
  make(ctx) {
    const r = TEMPLATES[base].make(ctx);
    if (o.tweak) o.tweak(r, ctx);
    if (o.label) r.label = o.label;
    if (o.tell) r.tell = o.tell;
    return r;
  },
});

Object.assign(TEMPLATES, {
  /* ---- shed-load / road-junk swerves (cal: debris/rockslide) ---- */
  debris_pallet: swerveAt({ topos: ['highway', 'industrialyard', 'cloverleaf', 'overpass', 'tunnelmouth'], kinds: ['pallet'], extraKind: 'boxes', label: 'Pallet Down', tell: 'a pallet is lying in the lane' }),
  debris_drum: swerveAt({ topos: ['tunnelmouth', 'cloverleaf', 'industrialyard', 'highway'], kinds: ['barrel_drum'], extraKind: 'cone', label: 'Drum Roll', tell: 'a traffic drum is loose in the lane' }),
  debris_tires: swerveAt({ topos: ['city', 'industrialyard', 'highway', 'parkinglot'], kinds: ['tire_stack'], label: 'Tire Wall', tell: 'somebody lost a stack of tires' }),
  debris_hay: swerveAt({ topos: ['tramcrossing', 'tjunction', 'suburb', 'riverside'], kinds: ['hay_bale'], extraKind: 'hay_bale', label: 'Bale Out', tell: 'hay bales all over the carriageway' }),
  debris_boxes: swerveAt({ topos: ['city', 'suburb', 'boulevard', 'schoolzone'], kinds: ['boxes'], extraKind: 'boxes', label: 'Lost Cargo', tell: 'boxes are strewn across the lane' }),
  debris_log: swerveAt({ topos: ['forestroad', 'switchback', 'mountainpass'], kinds: ['log_pile'], label: 'Logs Loose', tell: 'logs down across the road' }),
  debris_bin: swerveAt({ topos: ['city', 'suburb', 'schoolzone', 'boulevard'], kinds: ['bin_wheelie', 'dumpster'], label: 'Bin Day', tell: 'a bin has rolled into the road' }),
  debris_planter: swerveAt({ topos: ['boulevard', 'city', 'parkinglot'], kinds: ['planter_stone'], label: 'Planter Shift', tell: 'that planter is not where it was' }),
  debris_cone: swerveAt({ topos: ['schoolzone', 'city', 'highway', 'suburb'], kinds: ['cone', 'barricade'], extraKind: 'cone', label: 'Works Scatter', tell: 'the works zone has spilled into the lane' }),
  rockchain: swerveAt({ topos: ['canyon', 'mountainpass', 'switchback'], kinds: ['rock'], extraKind: 'rock', cal: 'rockslide', b1: 0.24, b2: 0.22, label: 'Rock Field', tell: 'more than one rock is down' }),

  /* ---- queue slams (cal: sunblind) ---- */
  tunnelqueue: queueSlam({ topos: ['tunnelmouth'], label: 'Dark Adaptation', tell: 'there is a queue just inside the dark' }),
  queue_bus: queueSlam({ topos: ['city', 'boulevard', 'schoolzone', 'suburb'], qPool: 'HEAVY', hot: 2, label: 'Behind The Bus', tell: 'the queue behind that bus is growing' }),
  icequeue: queueSlam({ topos: ['mountainpass', 'forestroad', 'coastalcliff'], minD: 2, hot: 2, brake: 1.2, react: 16, label: 'Cold Queue', tell: 'a queue on a slick road is a trap' }),
  glarequeue: queueSlam({ topos: ['boulevard', 'cloverleaf', 'causeway', 'overpass'], hot: 4, react: 26, brake: 0.8, label: 'Low Sun', tell: 'the sun is right down the road' }),

  /* ---- convoy slowdowns (cal: fogbank via reskin) ---- */
  whiteout: reskin('fogbank', { topos: ['mountainpass', 'forestroad', 'switchback'], label: 'Whiteout', tell: 'the road ahead is disappearing' }),
  dustwall: reskin('fogbank', { topos: ['canyon', 'highway', 'cloverleaf'], label: 'Dust Wall', tell: 'a brown wall is rolling over the road' }),
  convoy_brake: reskin('fogbank', { topos: ['city', 'suburb', 'boulevard', 'schoolzone'], label: 'Sudden Slowdown', tell: 'the whole line ahead is bunching up' }),

  /* ---- crossing & junction variants ---- */
  emergency_run: reskin('redlight', {
    topos: ['intersection', 'tramcrossing'], label: 'Emergency Run', tell: 'something with sirens is not stopping',
    tweak: (r) => { r.cars[1]._pool = 'EMERG'; r.cars[1]._short = false; },
  }),
  redlight_bike: reskin('redlight', {
    label: 'Two Wheels, No Patience', tell: 'the bike is threading the junction',
    tweak: (r) => { r.cars[1]._type = null; r.cars[1]._pool = 'BIKE'; },
  }),
  leftturn_truck: reskin('leftturn', {
    label: 'Wide Left', tell: 'that truck needs the whole junction to turn',
    tweak: (r, ctx) => { r.cars[1]._type = ctx.rng.pick(['boxtruck', 'flatbed']); },
  }),
  overrun: reskin('pullout', {
    topos: ['tjunction'], label: 'Stop-Sign Runner', tell: 'the side street is not slowing down',
    tweak: (r) => { const c = r.cars[1].drive.cmds[0]; if (c) c.v = 7; },
  }),

  /* ---- pullout family (cal: pullout) ---- */
  busstop_pullout: reskin('pullout', {
    topos: ['city', 'boulevard', 'schoolzone', 'suburb'], label: 'Bus Pulling Out', tell: 'the bus is indicating — nobody is letting it out',
    tweak: (r, ctx) => {
      const bus = r.cars[1];
      bus._type = ctx.rng.chance(0.5) ? 'citybus' : 'schoolbus';
      const c = bus.drive.cmds[0]; if (c) c.v = 4;
      r.props = r.props || [];
      r.props.push({ kind: 'bus_stop', x: bus.x + Math.cos(bus.heading + Math.PI) * 7, z: bus.z - Math.sin(bus.heading + Math.PI) * 7, heading: bus.heading, seed: String(ctx.rng.int(1, 9999)) });
    },
  }),
  pullout_farm: reskin('pullout', {
    topos: ['tramcrossing', 'tjunction', 'riverside', 'suburb'], label: 'Farm Gate', tell: 'the tractor is nosing out of the field',
    tweak: (r, ctx) => { r.cars[1]._type = ctx.rng.pick(['tractor', 'tractorhay']); const c = r.cars[1].drive.cmds[0]; if (c) c.v = 3.4; },
  }),
  forklift_cross: reskin('pullout', {
    topos: ['industrialyard'], label: 'Forklift Crossing', tell: 'the forklift never looks up',
    tweak: (r) => { r.cars[1]._type = 'forklift'; const c = r.cars[1].drive.cmds[0]; if (c) c.v = 3.2; },
  }),
  delivery_drop: reskin('pullout', {
    topos: ['city', 'suburb', 'boulevard'], label: 'Delivery Dash', tell: 'the van door is open and the hazards are on',
    tweak: (r, ctx) => {
      r.cars[1]._type = 'boxtruck';
      const c = r.cars[1].drive.cmds[0]; if (c) c.v = 4.5;
      r.props = r.props || [];
      r.props.push({ kind: 'boxes', x: r.cars[1].x + 2.2, z: r.cars[1].z + 1.4, heading: ctx.rng.range(0, 6.28), seed: String(ctx.rng.int(1, 9999)) });
    },
  }),

  /* ---- heavies & loads on straight roads ---- */
  jack_tanker: reskin('jackknife', {
    topos: ['highway', 'causeway', 'tunnelmouth', 'overpass', 'cloverleaf'], label: 'Tanker Jackknife', tell: 'that tanker is moving faster than the cab',
    tweak: (r) => { r.cars[0]._type = 'tanker'; },
  }),
  loadspill_logs: reskin('loadspill', {
    topos: ['highway', 'tunnelmouth', 'overpass'], label: 'Log Shed', tell: 'those logs are not chained right',
    tweak: (r, ctx) => { for (const p of r.props || []) { p.kind = 'log_pile'; } r.cars[0]._type = 'flatbed'; void ctx; },
  }),
  loadspill_fuel: reskin('loadspill', {
    topos: ['highway', 'causeway', 'cloverleaf', 'industrialyard'], label: 'Drum Shed', tell: 'drums are walking off that flatbed',
    tweak: (r) => { for (const p of r.props || []) { p.kind = 'barrel_drum'; } },
  }),
  loadspill_hay: reskin('loadspill', {
    topos: ['suburb', 'tramcrossing', 'tjunction'], label: 'Hay Shed', tell: 'the bales are leaning off the trailer',
    tweak: (r, ctx) => { for (const p of r.props || []) { p.kind = 'hay_bale'; } r.cars[0]._type = ctx.rng.chance(0.5) ? 'tractorhay' : 'flatbed'; },
  }),
  rollover_trip: {
    topos: ['highway', 'causeway', 'boulevard', 'overpass', 'cloverleaf'],
    minLane: 130, minD: 2, cal: 'rollover',
    make(ctx) {
      const { rng, lane, approach } = ctx;
      const v = Math.min(approach.v + 3, laneMaxV(lane, approach.anchorS));
      const tall = place(lane, approach.anchorS, v);
      tall._pool = 'HEAVY';
      cmd(tall, { t: INCIDENT_TICK, bias: rng.sign() * 0.22, off: true });
      cmd(tall, { t: INCIDENT_TICK + 16, bias: -rng.sign() * 0.3, off: true }); // the trip
      cmd(tall, { t: INCIDENT_TICK + 30, off: false, bias: 0, v: 0, brakeMax: 3.0 });
      return { cars: [tall], aggressor: 0, victim: -1, label: 'Swerve Trip', tell: 'too tall to swerve like that' };
    },
  },

  /* ---- stalls & sudden stops ---- */
  stall_truck: reskin('stall', {
    topos: ['highway', 'causeway', 'city', 'tunnelmouth', 'overpass', 'cloverleaf', 'industrialyard'],
    label: 'Dead Rig', tell: 'that truck has not moved all preview',
    tweak: (r, ctx) => { r.cars[1]._type = ctx.rng.pick(['semibox', 'boxtruck', 'flatbed']); r.cars[1]._short = false; },
  }),
  stall_moto: reskin('stall', {
    topos: ['city', 'suburb', 'boulevard', 'forestroad', 'riverside'],
    label: 'Dropped Bike', tell: 'a bike is down in the middle of the lane',
    tweak: (r, ctx) => { r.cars[1]._type = ctx.rng.pick(['moto', 'chopper']); },
  }),
  taxi_fare: reskin('tailgate', {
    topos: ['city', 'boulevard', 'suburb'], label: 'Sudden Fare', tell: 'taxis stop where the fare is, not where it is safe',
    tweak: (r) => { r.cars[0]._type = 'taxi'; },
  }),
  busbrake: reskin('tailgate', {
    topos: ['schoolzone', 'suburb', 'city'], label: 'School Stop', tell: 'the bus stops for the stop — the car behind does not',
    tweak: (r) => { r.cars[0]._type = 'schoolbus'; r.cars[0]._short = false; },
  }),

  /* ---- two-wheel & fast-cast variants ---- */
  blowout_bike: reskin('blowout', {
    label: 'Front Washout', tell: 'watch the bike wobble',
    tweak: (r) => { r.cars[0]._type = null; r.cars[0]._pool = 'BIKE'; r.cars[0]._short = false; },
  }),
  tailgate_moto: reskin('tailgate', {
    topos: ['city', 'highway', 'boulevard', 'suburb'], label: 'Bike In The Mirror', tell: 'the bike is sitting in the blind spot',
    tweak: (r) => { if (r.cars[1]) { r.cars[1]._type = null; r.cars[1]._pool = 'BIKE'; r.cars[1]._short = false; } },
  }),
  gust_bike: reskin('gustshove', {
    topos: ['causeway', 'coastalcliff', 'harbourramp'], label: 'Gust Takes The Bike', tell: 'the bike is fighting the crosswind',
    tweak: (r) => { r.cars[0]._pool = 'BIKE'; },
  }),
  lowgrip_bike: reskin('lowgrip', {
    label: 'No Grip For Two Wheels', tell: 'a bike on a slick road has no margin',
    tweak: (r) => { if (r.cars[1]) { r.cars[1]._pool = 'BIKE'; } },
  }),

  /* ---- wrong-way & duel variants ---- */
  wrongway_night: reskin('wrongway', { label: 'Headlights Coming', tell: 'those headlights are in your lane', tweak: (r) => { r.cars[1]._pool = 'FAST'; } }),
  chicken: reskin('wrongway', {
    topos: ['causeway', 'tunnelmouth', 'harbourramp'], minD: 4, label: 'Nobody Blinks', tell: 'neither of them is moving over',
    tweak: (r) => { cmd(r.cars[0], { t: INCIDENT_TICK + 55, bias: -0.14, off: true }); cmd(r.cars[0], { t: INCIDENT_TICK + 130, off: false, bias: 0, v: 0, brakeMax: 1.2 }); },
  }),
  merge_truck: reskin('merge', {
    topos: ['highway', 'causeway', 'cloverleaf', 'overpass', 'industrialyard'], label: 'Truck Merge', tell: 'the rig is drifting into an occupied lane',
    tweak: (r) => { if (r.cars[1]) { r.cars[1]._type = 'boxtruck'; r.cars[1]._short = false; } },
  }),
  sideswipe: reskin('race', {
    topos: ['city', 'suburb', 'boulevard', 'highway'], label: 'Sideswipe', tell: 'two of them are sharing one lane',
    tweak: (r) => { for (const c of r.cars) { c._pool = undefined; } },
  }),
  uturn_taxi: reskin('uturn', {
    topos: ['city', 'boulevard'], label: 'Taxi Flip-Around', tell: 'the taxi wants the fare across the street',
    tweak: (r) => { r.cars[0]._type = 'taxi'; },
  }),
  overtake_bike: reskin('overtake', {
    topos: ['suburb', 'forestroad', 'riverside', 'coastalcliff'], label: 'Bike Squeezes Past', tell: 'the bike is done waiting',
    tweak: (r) => { if (r.cars[1]) { r.cars[1]._pool = 'BIKE'; r.cars[1]._short = false; } },
  }),
  overtake_blind: reskin('overtake', {
    topos: ['forestroad', 'coastalcliff', 'riverside'], minD: 3, label: 'Overtake On Faith', tell: 'you cannot see what is coming — someone is going anyway',
  }),
  race_clip: reskin('race', {
    minD: 3, label: 'Wheels Touch', tell: 'the racers keep drifting closer',
    tweak: (r) => { if (r.cars[1]) { const cs = r.cars[1].drive.cmds; cs.length = 0; cmd(r.cars[1], { t: 200, bias: 0.055 }); cmd(r.cars[1], { t: INCIDENT_TICK, bias: -0.24, off: true }); cmd(r.cars[1], { t: INCIDENT_TICK + 70, off: false, bias: 0, v: 0, brakeMax: 1.4 }); } },
  }),
  brakecheck_two: reskin('brakecheck', {
    minD: 3, label: 'Road Rage', tell: 'those two have been at it all preview',
    tweak: (r) => { if (r.cars[1]) cmd(r.cars[1], { t: INCIDENT_TICK + 60, bias: 0.12, off: true }); },
  }),
  stuck_junction: reskin('stuckthrottle', {
    topos: ['city', 'suburb', 'boulevard', 'schoolzone'], label: 'No Lift At The Lights', tell: 'that one is speeding UP at the queue',
  }),
  steerfail_heavy: reskin('steerfail', {
    topos: ['city', 'causeway'], label: 'Heavy, No Steering', tell: 'the truck has stopped turning in',
    tweak: (r) => { r.cars[0]._pool = 'HEAVY'; },
  }),
  fishtail_tanker: reskin('fishtail', { label: 'Tanker Sway', tell: 'the tank is sloshing — watch the trailer', tweak: (r) => { r.cars[0]._type = 'tanker'; } }),
  yieldfail_double: reskin('yieldfail', {
    minD: 4, label: 'Both Barge In', tell: 'two entries, neither is giving way',
    tweak: (r, ctx) => {
      const extra = ctx.topo.crossings.find((c) => ctx.topo.lanes[c[0]] !== r.cars[1]._lane);
      if (extra) {
        const l = ctx.topo.lanes[extra[0]];
        const s = Math.min(l.len - 40, l.len * 0.42);
        // arrives well after the freeze so it cannot touch the main pair pre-600
        const c = place(l, s, Math.min(l.v, laneMaxV(l, s)), INCIDENT_TICK + 48);
        r.cars.push(c);
      }
    },
  }),
  overspeed_wet: reskin('overspeed', {
    topos: ['forestroad', 'mountainpass', 'canyon', 'coastalcliff'], minD: 4, label: 'Too Hot In The Wet', tell: 'that speed needs a dry road',
  }),
  drift_show: reskin('overspeed', {
    topos: ['city'], minD: 5, label: 'Showing Off', tell: 'someone is driving for an audience',
    tweak: (r) => { r.cars[0]._pool = 'FAST'; },
  }),
  brakefail_bus: reskin('brakefail', {
    topos: ['city', 'suburb', 'boulevard', 'schoolzone'], label: 'Bus, No Brakes', tell: 'the bus is not shedding any speed',
    tweak: (r) => { r.cars[0]._type = 'citybus'; r.cars[0]._short = false; },
  }),
  wide_farm: reskin('wideload', {
    topos: ['tramcrossing', 'tjunction', 'riverside', 'suburb'], label: 'Wide Farm Load', tell: 'that trailer is wider than the lane',
    tweak: (r) => { r.cars[0]._type = 'tractorhay'; },
  }),
  pit_fail: reskin('pit', {
    minD: 5, label: 'PIT Gone Wrong', tell: 'the cruiser is lining up — badly',
    tweak: (r) => {
      if (r.cars[1]) {
        const cs = r.cars[1].drive.cmds;
        cs.length = 0;
        cmd(r.cars[1], { t: INCIDENT_TICK - 40, v: r.cars[1]._v + 2.5 });
        cmd(r.cars[1], { t: INCIDENT_TICK, bias: 0.13, off: true });
        cmd(r.cars[1], { t: INCIDENT_TICK + 14, bias: -0.42, off: true }); // spins itself
        cmd(r.cars[1], { t: INCIDENT_TICK + 90, off: false, bias: 0, v: 0, brakeMax: 1.6 });
      }
    },
  }),
  pileup_mass: reskin('chain', {
    topos: ['highway', 'causeway', 'cloverleaf', 'overpass', 'tunnelmouth'], minD: 6, label: 'Mass Pile-Up', tell: 'far too many cars, far too close' }),
  lowgrip_convoy: reskin('lowgrip', {
    minD: 3, label: 'Slick Chain', tell: 'three of them, none with grip',
    tweak: (r, ctx) => {
      const last = r.cars[r.cars.length - 1];
      if (last && last._lane) {
        const third = placeAt(last._lane, last._s0 - Math.max(13, last._v * 1.1), last._v);
        if (third) { cmd(third, { t: INCIDENT_TICK + 26, v: 0, brakeMax: 4.2 }); r.cars.push(third); }
      }
      void ctx;
    },
  }),
  camper_wobble: reskin('drowsy', {
    topos: ['highway', 'causeway', 'coastalcliff', 'riverside', 'forestroad'], label: 'Overloaded Camper', tell: 'the camper is wallowing all over the lane',
    tweak: (r) => { r.cars[0]._type = 'camper'; r.cars[0]._short = false; },
  }),
  limo_block: reskin('spillback', {
    topos: ['intersection'], minD: 2, label: 'Limo In The Box', tell: 'that limousine will not clear the junction',
    tweak: (r) => { r.cars[0]._type = 'limo'; r.cars[0]._short = false; },
  }),
  icecream_stop: reskin('tailgate', {
    topos: ['suburb', 'schoolzone'], label: 'Ice Cream Stop', tell: 'the jingle means a sudden stop',
    tweak: (r) => { r.cars[0]._type = 'icecream'; r.cars[0]._short = false; },
  }),
  police_block: reskin('stall', {
    topos: ['highway', 'city', 'boulevard', 'causeway'], minD: 2, label: 'Rolling Roadblock', tell: 'the cruiser is parked across the lane',
    tweak: (r) => { r.cars[1]._pool = 'POLICE'; },
  }),
  ambulance_haste: reskin('merge', {
    topos: ['city', 'boulevard', 'highway'], label: 'Ambulance In A Hurry', tell: 'the ambulance is forcing the gap',
    tweak: (r) => { if (r.cars[1]) { r.cars[1]._pool = 'EMERG'; r.cars[1]._short = false; } },
  }),
});

/* Every topos string must name a real topology — a typo would silently strand
   a template (it just never deals). Cheap to assert once at module load. */
{
  const TOPO_NAMES = new Set([
    'intersection', 'suburb', 'city', 'highway',
    'causeway', 'switchback', 'schoolzone', 'tramcrossing', 'parkinglot', 'roundabout',
    'boulevard', 'tunnelmouth', 'industrialyard', 'tjunction', 'overpass', 'cloverleaf',
    'forestroad', 'mountainpass', 'canyon', 'coastalcliff', 'riverside', 'harbourramp',
  ]);
  for (const [n, t] of Object.entries(TEMPLATES)) {
    for (const tp of t.topos) {
      if (!TOPO_NAMES.has(tp)) throw new Error(`template ${n} names unknown topology '${tp}'`);
    }
  }
}

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
        /* The rebuild re-slices the FULL lane, so everything measured along
           the OLD path start must move with the car: a stop line kept at its
           old arc read as "passed" 26 m early and latched done, and the car
           sailed through its red into cross traffic (swp1_35). The trim is
           re-applied too — the raw re-slice silently restored the full-lane
           tail this pass exists to cut. */
        if (C.drive.stops) for (const st of C.drive.stops) st.s += back;
        if (C.drive.yields) for (const y of C.drive.yields) y.s += back;
        if (C._anchor !== undefined) trimDrive(C, (C._anchor - C._s0) + 90);
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
    // P2/2E — the twelve new places
    'boulevard', 'tunnelmouth', 'industrialyard', 'tjunction', 'overpass', 'cloverleaf',
    'forestroad', 'mountainpass', 'canyon', 'coastalcliff', 'riverside', 'harbourramp',
  ]);
  const VB = {
    highway: 12.5, causeway: 12, switchback: 11, suburb: 10,
    schoolzone: 8.5, parkinglot: 7.8, tramcrossing: 11, roundabout: 9.5,
    // 2E: relief/curvy roads cruise a little under the straights they resemble
    boulevard: 11.5, tunnelmouth: 12, industrialyard: 8, tjunction: 11, overpass: 12, cloverleaf: 12.5,
    forestroad: 10.5, mountainpass: 11, canyon: 10.5, coastalcliff: 11, riverside: 11, harbourramp: 10,
  };
  const vBase = VB[topoName] || 9;
  const BESPOKE = {
    intersection: topoIntersection, causeway: topoCauseway, switchback: topoSwitchback,
    schoolzone: topoSchoolZone, tramcrossing: topoTramCrossing,
    parkinglot: topoParkingLot, roundabout: topoRoundabout,
    boulevard: topoBoulevard, tunnelmouth: topoTunnelMouth, industrialyard: topoIndustrialYard,
    tjunction: topoTJunction, overpass: topoOverpass, cloverleaf: topoCloverleaf,
    forestroad: topoForestRoad, mountainpass: topoMountainPass, canyon: topoCanyon,
    coastalcliff: topoCoastalCliff, riverside: topoRiverside, harbourramp: topoHarbourRamp,
  };
  let topo = BESPOKE[topoName]
    ? BESPOKE[topoName](rTopo, rDress, vBase)
    : topoWorldgen(topoName, rTopo, vBase);
  // degenerate generated layout (no drivable lane)? fall back to the
  // intersection — deterministic, since the branch is itself seed-derived
  if (!topo.lanes.some((l) => solveApproach(l) !== null)) topo = topoIntersection(rTopo, rDress);

  /* ---- G6: the place picks its own sky ----
     Every topology used to hard-name ONE env, and three of them (plus both
     worldgen presets) named ids that did not exist or were diagnostic — so
     half the game rendered on the proving ground or the grid. Each place now
     draws from a curated pool of environments that actually fit it, off its
     OWN stream ('scn:'+seed+':env') so no existing facet shifts by a draw.
     The pool never includes 'proving' or 'grid': those stay dev surfaces. */
  const rEnv = makeRng('scn:' + seed + ':env');
  const ENV_POOLS = {
    intersection: ['city', 'dawn', 'dusk', 'night', 'suburb'],
    suburb: ['suburb', 'suburb', 'dawn', 'dusk'],
    city: ['city', 'city', 'night', 'dusk', 'dawn'],
    highway: ['desert', 'dawn', 'dusk', 'coastal', 'salt'],
    causeway: ['salt', 'coastal', 'dawn', 'dusk'],
    switchback: ['alpine', 'alpine', 'dawn', 'dusk'],
    schoolzone: ['suburb', 'suburb', 'city', 'dawn'],
    tramcrossing: ['suburb', 'dawn', 'dusk', 'coastal'],
    parkinglot: ['city', 'night', 'dusk', 'dawn'],
    roundabout: ['city', 'suburb', 'dusk', 'dawn'],
    boulevard: ['dusk', 'dusk', 'city', 'night', 'dawn'],
    tunnelmouth: ['dawn', 'dusk', 'night', 'alpine'],
    industrialyard: ['night', 'night', 'dusk', 'dawn'],
    tjunction: ['suburb', 'suburb', 'dawn', 'dusk', 'city'],
    overpass: ['city', 'dawn', 'dusk', 'night'],
    cloverleaf: ['dawn', 'dusk', 'desert', 'coastal'],
    forestroad: ['alpine', 'suburb', 'dawn', 'dusk'],
    mountainpass: ['alpine', 'alpine', 'dawn', 'dusk'],
    canyon: ['desert', 'desert', 'dawn', 'dusk'],
    coastalcliff: ['coastal', 'coastal', 'dawn', 'dusk'],
    riverside: ['coastal', 'suburb', 'dawn', 'dusk'],
    harbourramp: ['coastal', 'coastal', 'night', 'dawn', 'dusk'],
  };
  const envPool = ENV_POOLS[topo.name];
  if (envPool) topo.world.env = rEnv.pick(envPool);
  /* ---- G6: every scene gets a landscape ----
     Relief topologies bring their own (drivable) terrain spec and keep it.
     Everyone else gets a VISUAL ring — same null-opt-in world.terrain shape,
     no `drivable` flag, so the sim collider is untouched and only the
     horizon changes. ampK pushes real hills against the skyline; the mask
     still pins everything inside playR to exactly y = 0. */
  if (!topo.world.terrain) {
    const TAMP = { alpine: 1.7, mesa: 1.55, coastal: 1.4, rolling: 1.5, flats: 1.15, dunes: 1.35, basin: 1.35 };
    const tp = TERRAIN_FOR_ENV[topo.world.env] || 'rolling';
    topo.world.terrain = { preset: tp, seed: String(rEnv.int(1, 99999)), ampK: TAMP[tp] || 1.35 };
  }

  // prop scrub: generated props that encroach on a lane path get dropped —
  // an ambient car grazing a sign at tick 250 breaks the quiet preview
  // (the junction patch is AT the lanes by design and has no colliders)
  // (the asphalt_patch exemption that used to sit here is gone with the prop:
  // junctions are scenario content, not dressing, so nothing has to be
  // exempted from a scrub designed to keep dressing off the lanes)
  topo.props = topo.props.filter((pr) => {
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
  // 2E/2G big props get footprints too, so small dressing never spawns inside
  // a barn or a container stack. Pin-safe: pin-1 (intersection) names none of
  // these, so its dressing scrub is byte-identical.
  const FOOT = {
    house: 6.5, shop: 8, building_city: 9, gazebo: 4, hedge: 3.2, guardrail: 2.6, fence_picket: 2.4,
    barn: 7, silo: 4, tractor_shed: 6, grain_hopper: 4, windmill: 4, container: 3.4, container_stack: 6,
    gantry_crane: 8, fuel_tank: 5, substation: 6, pipe_rack: 5, lighthouse: 4, tunnel_portal: 8,
    cliff_face: 7, alpine_hut: 4, fishing_hut: 3.5, dock: 5, boulder_field: 4,
  };
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
      dc.drive.aw = rInc.int(20, 80);
      cmd(dc, { t: 470, bias: 0.03 * rInc.sign() });
      cmd(dc, { t: 555, bias: -0.015 });
      cmd(dc, { t: 585, bias: 0 });
      trimDrive(dc, (dc._anchor - dc._s0) + 85 + rInc.range(0, 40));
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
      mc.drive.aw = rInc.int(20, 80);
      const side = rInc.sign();
      const t2 = INCIDENT_TICK + rInc.int(0, 110);
      cmd(mc, { t: t2, bias: side * 0.08, off: true });
      cmd(mc, { t: t2 + 18, bias: side * 0.17 });
      cmd(mc, { t: t2 + 95, off: false, bias: 0, v: 0, brakeMax: 0.8 }); // its loss concludes too
      made.cars.push(mc);
      multiRef = mc;
    }
  }

  // ambient traffic to fill the cast (never essential — dropped on conflict).
  // Same-lane rule: only join a lane whose existing cars move at (nearly) the
  // same speed — a parked actor or a speeding aggressor makes the whole lane
  // off-limits, otherwise the ambient car would plow into it pre-incident.
  // P2/2J: 3–8 → 4–11. The scene reads as a road with traffic on it rather
  // than four cars in a diorama, and signals give the extra bodies somewhere
  // sensible to be (queued at a red) instead of merely more chances to
  // collide before tick 600 — which the sweep is the gate on.
  // G6: 4–11 → 6–14. Awareness (world.aware) is what makes the bigger cast
  // safe to watch: ambient cars now brake for the wreck instead of feeding it.
  const castMax = Math.min(14, 6 + (d >> 1) + rInc.int(0, 2));
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
    // incident awareness returns on a personal reaction clock (drive.aw), so
    // the cast reads as drivers — the closest still get caught out, the rest
    // brake and hold instead of feeding the pile
    amb.drive.acc = INCIDENT_TICK;
    amb.drive.aw = rInc.int(20, 80);
    // roll ~6–11 s past the anchor, then coast down — scenes must CONCLUDE
    trimDrive(amb, (sA - amb._s0) + 65 + rInc.range(0, 45));
    made.cars.push(amb);
  }

  /* ---- traffic signals (P2/2I) ----
     Two jobs, and the order matters.

     1. PHASE the program so the incident's own arm is genuinely green at
        INCIDENT_TICK. Every template is choreographed to land at tick 600 and
        `place()` budgets each run-up at free-flow cruise, so an actor meeting
        a red mid-approach would arrive late and the markets would be priced
        against a scene that never happened. Phasing the signal instead of
        exempting the actors means the light a player reads is the light the
        sim obeys.
     2. Hand STOP LINES to ambient traffic only, and only on the cross street.
        Two reasons, both learned from the invariants this file already
        protects: a stopped car on the ACTOR'S lane is a stationary obstacle
        the actor is budgeted to drive straight through, which is a pre-600
        rear-end; and essential cars carry no `acc`, so they would not slow
        for a queue even if one formed. Cross-street queueing is also the more
        legible picture — one street flowing, one street waiting. */
  const jSig = (topo.junctions || []).findIndex((j) => j && j.signal);
  if (jSig >= 0) {
    const J = topo.junctions[jSig];
    const actorArm = lane && lane.road ? lane.road : null;

    /* A QUEUE at the red (P2/2J). Ambient cars are anchored at a random point
       along their lane, so almost none of them were anywhere near the
       junction when the freeze hit — the lights worked and nobody was there
       to obey them. These are anchored ON the stop line instead, staggered
       back a car-gap each, so they arrive together and stack up behind the
       bar. The leader brakes for the red and the rest hold station on it
       through the ACC that already exists.
       Cross street only, for the same reason the stop lines are: a queue on
       the ACTOR'S approach is a wall of stationary metal in front of a car
       whose run-up was budgeted at free-flow cruise. */
    // arc distance at which a polyline first enters the stop radius of the
    // junction. Shared by the queue placement and the stop-line assignment —
    // a lane and a drive path are the same flat [x,z,…] shape.
    const stopSAlong = (pts, jx, jz, R) => {
      let s = 0;
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const ax = pts[i], az = pts[i + 1], bx = pts[i + 2], bz = pts[i + 3];
        const seg = Math.hypot(bx - ax, bz - az);
        if (Math.hypot(bx - jx, bz - jz) <= R) {
          // refine to the crossing point so the bar lands where it is painted
          const lo = Math.hypot(ax - jx, az - jz);
          const f = lo > R && lo > 1e-6 ? clamp((lo - R) / Math.max(1e-6, lo - Math.hypot(bx - jx, bz - jz)), 0, 1) : 0;
          return s + seg * f;
        }
        s += seg;
      }
      return -1;
    };
    /* PHASE the program onto the moment the actors are actually IN the
       junction, which is not always tick 600. `stall` parks its victim 111 m
       past the crossing, so the aggressor is through the box at tick ~218 and
       carries on; phasing to 600 left it running its own red at 218 while
       ambient traffic legitimately crossed on green, and it T-boned them.
       Essential cars carry no stop lines by design, so the signal has to be
       arranged around them rather than the other way round.
       Entry tick is exact rather than simulated: place() guarantees arc =
       s0 + v·t, and drive.pts is already sliced to the spawn, so the car
       reaches the bar at 60·s/v. */
    const entryTick = (c) => {
      const arm = c._lane && c._lane.road;
      if (!arm) return null;
      const R = (J.stopR && J.stopR[arm]) || 7.5;
      const s = stopSAlong(c.drive.pts, J.x || 0, J.z || 0, R);
      if (s < 0) return null;                       // path never reaches it
      const v = c._v || c.drive.v || 0;
      if (v < 0.5) return null;                     // parked: never traverses
      return { arm, t: Math.round((60 * s) / v) };
    };
    const essential = [];
    for (let i = 0; i < made.cars.length; i++) {
      const c = made.cars[i];
      if (!c || !c.drive || !keep.has(i)) continue;
      const e = entryTick(c);
      if (e && e.t <= INCIDENT_TICK) essential.push(e);
    }
    /* SEARCH the offset rather than pin one. An intersection incident almost
       always involves actors from BOTH arms — that is what makes it an
       intersection incident — so phaseFor, which can only satisfy a single
       (arm, tick), left 74% of junctions unable to bind and falling back to
       cosmetic. But a two-stage cycle can perfectly well be green for `ew` at
       tick 250 and green for `ns` at tick 590; it just needs the right offset.
       The offset space is one period (~550–780) and each test is a handful of
       integer comparisons, so this is a cheap exhaustive search — and a fixed
       step in a fixed order keeps it deterministic. */
    const covered = (p, arm, t) => {
      for (let k = Math.max(0, t - 8); k <= t + 100; k += 10) {
        if (signalAt(p, arm, k) !== GREEN) return false;
      }
      return true;
    };
    let obeyable = false;
    if (essential.length === 0) {
      // nothing crosses before the freeze: any phase is safe, so pick the one
      // that puts the actor's own street on green at the incident
      if (actorArm) J.signal = phaseFor(J.signal, actorArm, INCIDENT_TICK);
      obeyable = true;
    } else {
      for (let off = 0; off < J.signal.period; off += 5) {
        const p = { ...J.signal, offset: off };
        let ok = true;
        for (const e of essential) if (!covered(p, e.arm, e.t)) { ok = false; break; }
        if (ok) { J.signal = p; obeyable = true; break; }
      }
    }
    /* If no offset satisfies every actor — two crossing entries further apart
       than a green can span — ambient traffic reverts to ignoring the signal
       entirely. That is the proven pre-signal behaviour the conflict scrub was
       built against, so it is safe; the lights still animate, they just stop
       being binding for that scene. Half-obeying is what produced the
       pre-incident hits, so the fallback is all-or-nothing on purpose. */
    J.obeyed = obeyable;

    /* Queue on whichever arm is actually RED at the freeze — read straight off
       the finished program rather than inferred from the actor's street, which
       after the offset search is no longer guaranteed to be the green one. */
    const crossArm = ['ew', 'ns'].find((a) => signalAt(J.signal, a, INCIDENT_TICK) !== GREEN) || null;
    if (obeyable && crossArm && made.cars.length < castMax + 3) {
      const essLanes0 = new Set(made.cars.filter((c, i) => c && keep.has(i)).map((c) => c._lane));
      const qLanes = usable.filter((l) => l.road === crossArm && !essLanes0.has(l));
      if (qLanes.length) {
        const ql = rInc.pick(qLanes);
        const R = (J.stopR && J.stopR[crossArm]) || 7.5;
        const sLine = stopSAlong(ql.pts, J.x || 0, J.z || 0, R);
        /* Every queue car aims at the SAME point — the bar — but at staggered
           arrival ticks, starting just after this arm goes red. The leader
           pulls up and stops; each follower arrives behind it and holds
           station on the ACC that already exists. Aiming them all at tick 600
           instead (and spacing them back along the lane) put every one of them
           still rolling to a stop as the freeze hit, so the queue the player
           was meant to see was a set of cars gently decelerating. */
        let redStart = INCIDENT_TICK;
        while (redStart > 80 && signalAt(J.signal, crossArm, redStart - 1) !== GREEN) redStart--;
        const qN = sLine > 40 ? 2 + rInc.int(0, 2) : 0;
        const qv0 = Math.min(ql.v * 0.95, laneMaxV(ql, sLine));
        /* Stagger by DISTANCE, not by a flat tick count. Cars aimed at the
           same point arrive spaced by v·Δt, and the spawn-overlap net culls
           any non-essential pair closer than 8 m — so a fixed 30-tick gap
           gave 6 m at 12 m/s and the net quietly ate the queue down to two
           cars every time. Solving Δt for a 9 m gap clears the net outright,
           which is better than widening an exemption that exists to catch
           real spawn overlaps. */
        const dt = Math.max(24, Math.ceil((60 * 9) / Math.max(2, qv0)));
        for (let k = 0; k < qN; k++) {
          const tArrive = redStart + 25 + k * dt;
          if (tArrive > INCIDENT_TICK - 10) break;
          const qv = qv0;
          if (qv < MIN_V * 0.8) break;
          const qc = place(ql, sLine, qv, tArrive);
          if (!qc || qc._v < qv * 0.6) break;
          qc.drive.acc = INCIDENT_TICK; // full attention: this is a queue
          qc.drive.aw = rInc.int(20, 80);
          // clear the junction after release, then wind down
          trimDrive(qc, (sLine - qc._s0) + 55 + rInc.range(0, 30));
          made.cars.push(qc);
        }
      }
    }
    /* Stop lines go to ambient traffic on EVERY arm, not just the cross one.
       Governing half a junction is worse than governing none: the conflict
       scrub staggers crossing arrivals using free-flow timing, and a car that
       waits at a red then goes arrives nowhere near when the scrub assumed.
       With only the cross street obeying, an ambient car on the actor's arm
       would sail through on ITS red while cross traffic legitimately moved on
       green — four pre-incident hits in a 75-scene sweep, all on the
       intersection, all between ticks 204 and 297. With every ambient car
       obeying, the signal itself is the conflict resolution, which is the
       whole reason signalized junctions exist.

       The one exclusion is a lane an ESSENTIAL car is also on. Template cars
       carry no `acc` and no stops by design — their choreography is budgeted
       at free-flow cruise — so a stopped ambient car ahead of one is a wall
       it will drive straight into. */
    const essentialLanes = new Set();
    for (let i = 0; i < made.cars.length; i++) {
      const c = made.cars[i];
      if (c && keep.has(i) && c._lane) essentialLanes.add(c._lane);
    }
    for (let i = 0; obeyable && i < made.cars.length; i++) {
      const c = made.cars[i];
      if (!c || !c.drive || keep.has(i)) continue;     // essential cars: untouched
      const arm = c._lane && c._lane.road;
      if (!arm) continue;
      if (essentialLanes.has(c._lane)) continue;       // never queue in front of an actor
      const R = (J.stopR && J.stopR[arm]) || 7.5;
      const s = stopSAlong(c.drive.pts, J.x || 0, J.z || 0, R);
      if (s <= 4) continue;
      /* ROOM TO STOP (ledger #35). An ambient car placed close to the junction
         and moving fast cannot pull up at the bar — it overshoots into the box
         and is clipped by cross traffic that legitimately has the green.
         Measured at ~0.5% of intersection scenes, all ambient↔ambient grazes.
         The comfortable ambient stop is about v²/(2·3.2) m; short of that plus a
         car-length of margin, drop the car rather than seat it where it will run
         its own red. It is non-essential, so this only thins the queue — and a
         car that cannot stop was never a legible queue member anyway. */
      if (s < (c._v * c._v) / 6.4 + 6) { made.cars[i] = null; continue; }
      /* `until`: signals stop binding a few seconds after the incident. The
         recorder settles a scene by DISPLACEMENT, and a signal cycles about
         3.5 times over the 2400-tick cap — so obedient traffic is perpetually
         being restarted by a fresh green and the scene never comes to rest.
         (Ran-to-cap went 6.7% → 10.7% and broke the sweep's 10% budget.)
         Past this point ambient cars ignore the lights, finish their path and
         coast to a stop, which is also what people do after a crash. */
      c.drive.stops = [{ s, j: jSig, arm, until: INCIDENT_TICK + 150 }];
    }
  }

  /* ---- G6 give-way lines ----
     Topologies that stage a priority rule (the roundabout's circulating
     priority) publish yieldZones; every AMBIENT car whose lane matches gets
     the hold-while-occupied line. Essential cars never do — their run-up is
     budgeted at free-flow cruise, the same argument as signal stop lines. */
  if (topo.yieldZones) {
    /* Same exclusion the signal stop lines learned: never seat a hold in
       front of an ESSENTIAL car. An actor's run-up is budgeted at free-flow
       cruise, so an ambient car yielding at the mouth of the actor's own
       lane is a stationary wall it plows into pre-600 (measured: 4 of the
       first sweep's 5 defects were exactly this). */
    const essLanesY = new Set();
    for (let i = 0; i < made.cars.length; i++) {
      const c = made.cars[i];
      if (c && keep.has(i) && c._lane) essLanesY.add(c._lane);
    }
    for (let i = 0; i < made.cars.length; i++) {
      const c = made.cars[i];
      if (!c || !c.drive || keep.has(i)) continue;
      if (essLanesY.has(c._lane)) continue;
      const z = c._lane && topo.yieldZones.find((y) => c._lane.road === y.road);
      if (z) c.drive.yields = [{ x: z.x, z: z.z, r: z.r, s: z.s, until: INCIDENT_TICK + 150 }];
    }
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
  /* Curvy/relief topologies (2E) never deal heavies. A long semi off-tracks
     across the centreline on a SUSTAINED bend even when its lateral-g demand is
     low — the `bendy` v²·κ guard measures the tip, not the length-driven crab,
     so it waves a semibox through a gentle-radius corner and the drift into
     oncoming is a pre-incident head-on. Measured on coastalcliff and
     mountainpass: a semibox at ~11 m/s reaches ~5 m wide well before tick 600.
     An artic on an alpine hairpin reads wrong anyway, so this is also correct
     art direction, not only a determinism guard. */
  const NO_HEAVY = topo.name === 'mountainpass' || topo.name === 'canyon'
    || topo.name === 'forestroad' || topo.name === 'coastalcliff';
  const poolFor = (c) => {
    if (c._pool === 'POLICE') return ['police', 'policesuv'];
    if (c._pool === 'EMERG') return ['ambulance', 'firetruck'];
    if (c._pool === 'BIKE') return ['moto', 'chopper'];
    if (c._pool === 'SLOW') return ['tractor', 'icecream'];
    // _short = spawned in a tight queue: only compact bodies fit the gap
    if (c._short) return c._pool === 'FAST' ? FAST : CIVIC;
    if (c._pool === 'FAST') return FAST;
    // an explicitly heavy actor yields to the bendy guard AND to a topology
    // that bars heavies outright
    if (c._pool === 'HEAVY') return bendy(c) || NO_HEAVY ? CIVIC : HEAVY;
    if (NO_HEAVY) return CIVIC;
    if (topo.name === 'highway') return rCast.chance(0.3) && !bendy(c) ? HEAVY : CIVIC;
    return rCast.chance(0.12) && !bendy(c) ? HEAVY : CIVIC;
  };
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i];
    // _type = an exact REG id a template demands (tram, moto, tractor…). The
    // pool draw still happens so the stream never shifts on the branch.
    const drawn = rCast.pick(poolFor(c));
    c.type = c._type || drawn;
    c.seed = String(rCast.int(1, 99999));
    delete c._lane; delete c._s0; delete c._v; delete c._anchor; delete c._pool; delete c._short; delete c._type;
  }

  // props may not overlap a CAR spawn either: the pullout's shoulder spot
  // sits outside the scrubbed lane corridor, and a lamp post 1.1 m from the
  // parked car exploded it on tick 1 (tp69). Clearance is footprint-aware:
  // a house's collider reaches ~7 m from its centre (tp69's taxi spawned
  // inside one whose centre was 7.9 m away).
  const BIG_PROP = {
    house: 10, shop: 10, building_city: 12, gazebo: 6, hedge: 5, guardrail: 4.5,
    barn: 10, silo: 6, tractor_shed: 8, grain_hopper: 6, windmill: 6, container: 5, container_stack: 8,
    gantry_crane: 10, fuel_tank: 7, substation: 8, pipe_rack: 7, lighthouse: 6, tunnel_portal: 10,
    cliff_face: 9, alpine_hut: 6, fishing_hut: 5, dock: 7, boulder_field: 6,
  };
  const props = topo.props.filter((pr) => {
    const rr = BIG_PROP[pr.kind] || 3.8;
    for (const c of cars) {
      const dx = pr.x - c.x, dz = pr.z - c.z;
      if (dx * dx + dz * dz < rr * rr) return false;
    }
    return true;
  });

  /* Weather (P2/2D). Rolled HERE rather than in main.js, off the same
     'wx:'+seed stream and the same env id, so the descriptor is bit-identical
     to the one main.js used to roll for itself — no player sees different
     weather because of this move.

     Why it had to move: grip settles money. The recorder runs the scenario
     headlessly and the round the player watches builds it again, and if the
     weather were rolled separately by the renderer then the tape and the round
     could disagree about how slippery the road is. The scene has to carry it.
     It also retires a latent trap — main.js rolled against `env.current`, the
     LIVE environment, which is a Settings chip the player can change; that was
     harmless while weather was decoration and would not have stayed harmless.

     `grip` is written only when the topology asks for it, so absent means the
     tyres are untouched and every pinned hash holds. Nothing opts in yet —
     2E's mountain/coastal topologies are what turn it on. */
  const wx = rollWeather(seed, topo.world.env);
  const weather = topo.wxGrip ? { ...wx, grip: gripFor(wx) } : wx;

  return {
    // Spread the topology's world through instead of re-listing its keys. The
    // enumerated version dropped every key it did not name — including
    // `water`, so the causeway (a deck over open water, the one topology that
    // exists to show off G4 elevation) generated a bridge over dry land and
    // the buoyancy / splash / sunk path never ran in a single real round. It
    // stayed green only because the `water` simtest scenario hand-writes
    // world.water rather than going through the director. Defaults stay in
    // front so a topology can still override gravity or walls deliberately.
    // G6: `aware: true` turns on post-incident ambient awareness (physics.js
    // driveTick) — a default, not an override, so a topology could opt out.
    world: { gravity: 9.81, walls: false, aware: true, ...topo.world, arena: topo.world.arena || 100, weather },
    roads: topo.roads,
    junctions: topo.junctions || [],
    props,
    cars,
    meta: {
      seed: String(seed), d, topo: topo.name, template: tName,
      // calKey groups variant templates under their choreography family so
      // CALIB cells stay thick — markets.js and tools/calibrate.mjs both key
      // pricing on THIS, while `template` stays the variant's identity.
      calKey: T.cal || tName,
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
