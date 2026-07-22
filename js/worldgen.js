// worldgen.js — procedural environment generators (world-building P3).
//
// A generator is an authoring tool, not a runtime system: it emits plain
// scenario content — { world: {arena, env}, roads: [roadSpec], props:
// [propSpec] } — built from the existing road + scenery pipelines, so the
// result is ordinary editable objects and the URL codec captures the full
// generated scene (sharing needs no worldgen at load time).
//
// Determinism: one rng stream per (preset, seed) via makeRng('w:…'); prop
// placement walks the road spline (roadCurve/getPointAt), so layouts follow
// the curve however swirly it is. Zero Math.random(). Props are pushed in
// priority order (furniture → lots → filler) and trimmed to opts.maxProps,
// so a smaller budget (mobile) drops filler first, never the road anchors.
//
// Placement zones (lateral offset from the road centreline, hw = w/2):
//   hw+1.0…hw+2   sidewalk edge — lamps, hydrants, signs, bus stops
//   hw+4 …hw+6    front yards — mailboxes, trees, hedges, fences
//   hw+6.5…hw+11  lots — houses, shops, park pieces
// Zones + stop spacing are chosen so nothing overlaps by construction.
import { makeRng, clamp } from './lib.js';
import { roadCurve } from './roads.js';

// G6: arenas grew ~1.5× and the envs stopped being dev surfaces — 'suburb'
// is a real preset now and the director redraws env per scene anyway.
export const WORLD_PRESETS = [
  { id: 'suburb', label: '🏘 Suburb', env: 'suburb', arena: 190 },
  { id: 'city', label: '🏙 City', env: 'city', arena: 165 },
  { id: 'highway', label: '🛣 Highway', env: 'desert', arena: 300 },
];
export const isWorldPreset = (id) => WORLD_PRESETS.some((p) => p.id === id);

// heading that points a prop's forward (+X) along direction (dx, dz)
const headingTo = (dx, dz) => Math.atan2(-dz, dx);
const r2 = (v) => Math.round(v * 100) / 100;
// placement clamp half-extent — set by each generator to fit its arena
let EXT = 99;

// frame on a road: position + tangent/left-normal at parameter u (arc-length)
function frameOn(curve, u) {
  const p = curve.getPointAt(u);
  const t = curve.getTangentAt(u);
  const l = Math.hypot(t.x, t.z) || 1;
  return { x: p.x, z: p.z, tx: t.x / l, tz: t.z / l, nx: t.z / l, nz: -t.x / l };
}

// prop spec at lateral offset `off` from the frame; face: 'along' the road,
// 'road' (turn toward it), 'away', or a fixed heading number
function place(kind, f, off, face, r, jitter = 0.1) {
  let heading;
  if (face === 'along') heading = headingTo(f.tx, f.tz);
  else if (face === 'road') heading = headingTo(-f.nx * Math.sign(off), -f.nz * Math.sign(off));
  else if (face === 'away') heading = headingTo(f.nx * Math.sign(off), f.nz * Math.sign(off));
  else heading = face;
  return {
    kind,
    x: r2(clamp(f.x + f.nx * off, -EXT, EXT)),
    z: r2(clamp(f.z + f.nz * off, -EXT, EXT)),
    heading: r2(heading + (jitter ? r.range(-jitter, jitter) : 0)),
    seed: String(r.int(1, 9999)),
  };
}

/* ---------------- suburb: one curvy residential street ---------------- */
// G6: half 52 → 78 (a real 10 s approach both ways), plus two side-street
// cul-de-sacs — short stubs (< 55 m, so lanesOfRoad never lifts a lane off
// them) with houses of their own, seamed to the main road by apron junctions.
function suburb(r, props, out) {
  EXT = 92;
  const half = 78;
  const z0 = r.range(-10, 10);
  const road = {
    w: 7, loop: 0, style: 6, // white dashes + sidewalks + crosswalks
    pts: [
      { x: -half, z: r2(z0 + r.range(-6, 6)) },
      { x: r2(-half / 3 + r.range(-4, 4)), z: r2(z0 + r.range(8, 15) * r.pick([1, -1])) },
      { x: r2(half / 3 + r.range(-4, 4)), z: r2(z0 + r.range(8, 15) * r.pick([1, -1])) },
      { x: half, z: r2(z0 + r.range(-6, 6)) },
    ],
  };
  const curve = roadCurve(road);
  const L = curve.getLength();
  const roads = [road];

  // side streets: two cul-de-sac stubs off alternating sides. The stub starts
  // INSIDE the apron junction (overlap is fine — the junction sits 2 mm
  // below both layers) and runs ~30 m out into its own pocket of houses.
  for (const [u, sideK] of [[0.3, 1], [0.68, -1]]) {
    const f = frameOn(curve, u);
    const side = sideK;
    const nx = f.nx * side, nz = f.nz * side;
    const sx = f.x + nx * 2.4, sz = f.z + nz * 2.4;
    const ex = f.x + nx * 32, ez = f.z + nz * 32;
    roads.push({ w: 6, loop: 0, style: 2, pts: [{ x: r2(sx), z: r2(sz) }, { x: r2((sx + ex) / 2), z: r2((sz + ez) / 2) }, { x: r2(ex), z: r2(ez) }] });
    out.junctions.push({
      x: r2(f.x + nx * 3.6), z: r2(f.z + nz * 3.6), reach: 4.4, style: 0,
      arms: [{ a: r2(Math.atan2(nz, nx)), w: 6 }, { a: r2(Math.atan2(nz, nx) + Math.PI), w: 6 }],
    });
    // houses along the stub, then a turning-circle read at the end
    for (let i = 0; i < 2; i++) {
      const t = 12 + i * 11;
      const px = f.x + nx * t, pz = f.z + nz * t;
      const lx = -nz, lz = nx; // stub-left
      for (const s of [1, -1]) {
        props.push({
          kind: 'house', x: r2(px + lx * s * 8.6), z: r2(pz + lz * s * 8.6),
          heading: r2(headingTo(-lx * s, -lz * s) + r.range(-0.05, 0.05)), seed: String(r.int(1, 9999)),
        });
      }
    }
    props.push({ kind: r.pick(['tree_round', 'tree_oak', 'gazebo']), x: r2(ex + nx * 7), z: r2(ez + nz * 7), heading: r2(r.range(0, 6.28)), seed: String(r.int(1, 9999)) });
  }

  // street furniture first — it anchors the "street" read even on tight budgets
  props.push(place('sign_speed', frameOn(curve, 0.045), 5.6, 'road', r));
  props.push(place('sign_stop', frameOn(curve, 0.955), -5.6, 'road', r));
  const nLamp = Math.round(L / 18);
  for (let i = 0; i < nLamp; i++) {
    const f = frameOn(curve, (i + 0.5) / nLamp);
    props.push(place('lamp_classic', f, (i % 2 ? 4.8 : -4.8), 'road', r));
  }
  props.push(place('hydrant', frameOn(curve, r.range(0.3, 0.7)), 4.9, 'road', r));

  // lots: houses (one park lot swaps in a playground/gazebo/pond corner)
  const nStop = Math.floor(L / 13.5);
  const parkAt = r.int(1, Math.max(1, nStop - 2));
  for (let i = 0; i < nStop; i++) {
    const u = (i + 0.5) / nStop;
    const f = frameOn(curve, u);
    const side = i % 2 ? 1 : -1; // alternate sides of the street
    const lotOff = side * r.range(9.5, 11.5);
    if (i === parkAt) {
      props.push(place(r.pick(['playground', 'gazebo', 'pond']), f, lotOff, 'road', r));
      props.push(place('bench', f, side * 6.2, 'road', r));
      props.push(place('tree_' + r.pick(['round', 'blossom', 'oak']), frameOn(curve, u + 0.02), side * 13.5, 'away', r, 0.6));
    } else {
      props.push(place('house', f, lotOff, 'road', r, 0.05));
      props.push(place('mailbox', f, side * 4.6, 'road', r));
      if (r.chance(0.6)) props.push(place(r.pick(['fence_picket', 'hedge']), frameOn(curve, u + 0.012), side * 5.9, 'along', r, 0.04));
    }
    // a tree between this lot and the next, opposite side half the time
    const fT = frameOn(curve, clamp(u + 0.5 / nStop, 0, 1));
    const tSide = r.chance(0.5) ? side : -side;
    props.push(place('tree_' + r.pick(['round', 'oak', 'pine', 'blossom', 'cypress']), fT, tSide * r.range(6.5, 9), 'away', r, 0.6));
  }

  // filler — first to go when the budget trims
  for (let i = 0; i < 9; i++) {
    const f = frameOn(curve, r.range(0.08, 0.92));
    props.push(place(r.pick(['bush', 'rock', 'reeds', 'flowerbed', 'trash_can']), f, r.pick([1, -1]) * r.range(13, 20), 'road', r, 0.9));
  }
  // 2G rural fringe — the suburb's edge bleeds into farmland, set well back off
  // the road (pushed last, so the mobile budget trims it before any identity)
  for (let i = 0; i < 5; i++) {
    const f = frameOn(curve, r.range(0.12, 0.88));
    props.push(place(r.pick(['barn', 'silo', 'tractor_shed', 'grain_hopper', 'hay_wrap', 'feed_bin', 'chicken_coop', 'windmill', 'orchard_row']),
      f, r.pick([1, -1]) * r.range(28, 40), 'away', r, 0.4));
  }
  return roads;
}

/* ---------------- city: a loop block — shops out, plaza in ---------------- */
// G6: the block grew ~1.45× and gained a second ring of towers behind the
// shops, so the skyline reads as a city rather than a film set.
function city(r, props) {
  EXT = 99;
  const ex = r.range(42, 50), ez = r.range(31, 38);
  const road = {
    w: 8, loop: 1, style: 2, // sidewalk ring
    pts: [
      { x: r2(-ex), z: r2(-ez + r.range(-3, 3)) },
      { x: r2(ex + r.range(-3, 3)), z: r2(-ez) },
      { x: r2(ex), z: r2(ez + r.range(-3, 3)) },
      { x: r2(-ex + r.range(-3, 3)), z: r2(ez) },
    ],
  };
  const curve = roadCurve(road);
  const L = curve.getLength();
  // for this point winding the left normal points OUT of the block —
  // positive offsets = outside ring, centroid math = inside plaza

  // the block's identity first: plaza inside + corner anchors (survives trims)
  const cx = (road.pts[0].x + road.pts[1].x + road.pts[2].x + road.pts[3].x) / 4;
  const cz = (road.pts[0].z + road.pts[1].z + road.pts[2].z + road.pts[3].z) / 4;
  props.push({ kind: 'fountain', x: r2(cx), z: r2(cz), heading: 0, seed: String(r.int(1, 9999)) });
  props.push(place('traffic_light', frameOn(curve, 0.02), 6.4, 'along', r));
  props.push(place('sign_street', frameOn(curve, 0.06), 6.2, 'road', r));
  const a0 = r.range(0, Math.PI * 2);
  for (let i = 0; i < 3; i++) { // plaza seating rings the fountain evenly
    const a = a0 + (i / 3) * Math.PI * 2 + r.range(-0.35, 0.35);
    const d = r.range(6, 8.5);
    const bx = cx + Math.cos(a) * d, bz = cz + Math.sin(a) * d;
    props.push({
      kind: r.pick(['bench', 'table_umbrella', 'picnic_table']),
      x: r2(bx), z: r2(bz),
      heading: r2(headingTo(cx - bx, cz - bz)),
      seed: String(r.int(1, 9999)),
    });
  }

  // shops face the street from the outside ring
  const nShop = 7;
  for (let i = 0; i < nShop; i++) {
    const u = (i + 0.5) / nShop;
    props.push(place('shop', frameOn(curve, u), r.range(11, 13), 'road', r, 0.05));
  }
  // a second rank of towers behind the shops — pure skyline
  for (let i = 0; i < 5; i++) {
    const u = (i + 0.3) / 5;
    props.push(place('building_city', frameOn(curve, u), r.range(24, 32), 'road', r, 0.1));
  }

  // lamps + services around the ring
  const nLamp = Math.round(L / 22);
  for (let i = 0; i < nLamp; i++) {
    props.push(place('lamp_classic', frameOn(curve, (i + 0.25) / nLamp), 6, 'road', r));
  }
  props.push(place('bus_stop', frameOn(curve, 0.3), 6.6, 'road', r));
  props.push(place('billboard', frameOn(curve, 0.56), 11, 'road', r));
  props.push(place('food_cart', frameOn(curve, 0.68), 6.6, 'along', r));
  props.push(place('mailbox_drop', frameOn(curve, 0.79), 6.2, 'road', r));
  props.push(place('dumpster', frameOn(curve, 0.12), 15.5, 'along', r, 0.4));
  props.push(place('utility_box', frameOn(curve, 0.44), 6.3, 'road', r));
  props.push(place('bike_rack', frameOn(curve, 0.9), 6.4, 'along', r));

  // greenery toward the block corners, then filler
  for (let i = 0; i < 4; i++) {
    const sx = i % 2 ? 1 : -1, sz = i < 2 ? 1 : -1;
    props.push({
      kind: 'tree_' + r.pick(['round', 'oak', 'palm', 'blossom']),
      x: r2(cx + sx * r.range(10, 14)), z: r2(cz + sz * r.range(7, 10)),
      heading: r2(r.range(-3, 3)), seed: String(r.int(1, 9999)),
    });
  }
  for (let i = 0; i < 5; i++) {
    props.push(place(r.pick(['trash_can', 'flowerpot', 'bin_wheelie', 'flowerbed', 'bush']),
      frameOn(curve, r.range(0, 1)), r.range(6, 7.5), 'road', r, 0.8));
  }
  return [road];
}

/* ---------------- highway: sweeping divided road + work zone ---------------- */
function highway(r, props) {
  EXT = 145;
  // long enough for a director round: a 10 s approach at highway speed eats
  // >110 m of road, and oncoming traffic needs the same again — the old ±64
  // span could host neither (every highway scene played out on empty asphalt)
  const half = 140;
  const z0 = r.range(-10, 10), amp = r.range(14, 26) * r.pick([1, -1]);
  const road = {
    w: 13, loop: 0, style: 1, // wide, double yellow
    pts: [
      { x: -half, z: r2(z0 - amp * 0.4) },
      { x: r2(-half / 3), z: r2(z0 + amp) },
      { x: r2(half / 3), z: r2(z0 - amp) },
      { x: half, z: r2(z0 + amp * 0.4) },
    ],
  };
  const curve = roadCurve(road);
  const L = curve.getLength();
  const uM = (m) => m / L; // arc metres → curve fraction: spacing stays metric

  props.push(place('sign_highway', frameOn(curve, 0.06), 9.4, 'road', r));
  props.push(place('sign_speed', frameOn(curve, 0.2), -9.2, 'road', r));

  // guardrails hug the two apex stretches (outside of each bend)
  for (const [u0, side] of [[0.28, Math.sign(amp)], [0.62, -Math.sign(amp)]]) {
    for (let i = 0; i < 6; i++) {
      const f = frameOn(curve, u0 + i * uM(5.1));
      props.push(place('guardrail', f, side * 8.6, 'along', r, 0.03));
    }
  }

  // work zone: vms → barricade → cone taper into the outer lane → arrow board
  const wz = r.range(0.55, 0.68);
  const wSide = r.pick([1, -1]);
  props.push(place('vms_board', frameOn(curve, wz - uM(14.5)), wSide * 8.8, 'road', r));
  props.push(place('barricade', frameOn(curve, wz - uM(6.5)), wSide * 5.2, 'along', r));
  for (let i = 0; i < 5; i++) {
    const f = frameOn(curve, wz - uM(4.4) + i * uM(2.35));
    props.push(place('cone', f, wSide * (5 - i * 0.75), 'along', r, 0.4));
  }
  props.push(place('arrow_board', frameOn(curve, wz + uM(8.7)), wSide * 3.4, 'along', r));
  props.push(place('barrier_water', frameOn(curve, wz + uM(14.5)), wSide * 4.4, 'along', r, 0.05));

  props.push(place('billboard', frameOn(curve, 0.82), -13.5, 'road', r));
  for (let i = 0; i < 4; i++) {
    props.push(place('delineator', frameOn(curve, 0.86 + i * uM(4.1)), 7.6, 'along', r));
  }
  // roadside services read: a cell tower and a rest-stop cluster
  props.push(place('cell_tower', frameOn(curve, 0.14), r.pick([1, -1]) * r.range(22, 30), 'away', r, 0.5));
  props.push(place('billboard', frameOn(curve, 0.4), 14, 'road', r));
  // sparse nature filler
  for (let i = 0; i < 14; i++) {
    const f = frameOn(curve, r.range(0.05, 0.95));
    props.push(place(r.pick(['rock', 'tree_pine', 'reeds', 'bush', 'tree_cypress']),
      f, r.pick([1, -1]) * r.range(15, 30), 'away', r, 0.9));
  }
  return [road];
}

const GENERATORS = { suburb, city, highway };

// Deterministic: same preset+seed+caps ⇒ identical scene fragment.
// G6: also returns `junctions` — apron seams for side streets. Callers that
// ignore it (the worldgen pin's hand-built scenario) simply never build them.
export function generateWorld(preset, seed = '1', opts = {}) {
  const p = WORLD_PRESETS.find((w) => w.id === preset);
  if (!p) return null;
  const maxProps = opts.maxProps || 48;
  const maxRoads = opts.maxRoads || 6;
  const r = makeRng('w:' + preset + ':' + seed);
  const props = [];
  const out = { junctions: [] };
  const roads = GENERATORS[preset](r, props, out).slice(0, maxRoads);
  if (props.length > maxProps) props.length = maxProps; // filler drops first
  return { world: { arena: p.arena, env: p.env }, roads, props, junctions: out.junctions };
}
