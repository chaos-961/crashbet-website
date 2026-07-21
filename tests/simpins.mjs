// Determinism pin gate — run: node tests/simpins.mjs
// Runs every TEST_SCENARIOS entry twice (as ?simtest=1 does) and asserts the
// final transform + geometry hashes match the pins recorded in CLAUDE.md.
// The browser self-test proves run-to-run stability; this proves the values
// never MOVED, which is the invariant that actually protects the sim.
import { pathToFileURL } from 'url';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const load = (f) => import(pathToFileURL(path.join(root, f)));

const { REG } = await load('js/vehicles.js');
const Phys = await load('js/physics.js');
const R = await Phys.loadRapier();
const catOf = (id) => (REG.find((e) => e.id === id) || {}).cat || 'Cars';

// pins from CLAUDE.md "Running & testing" — state hash / geometry hash
const PINS = {
  legacy:   ['769824bd', 'f11ed37a'],
  extended: ['54489fae', '20413f1b'],
  scenery:  ['50fa7593', 'ec076bdc'],
  roads:    ['4ac04ea9', 'ab859269'],
  // NEW in G5. Pins the elevated DRIVING SURFACE: a car placed mid-span via
  // spec.y, driving the deck into a head-on. Nothing covered this before,
  // which is exactly how G4 shipped road elevation with no surface collider
  // at all — `bridge` enters at the ramp foot where deck y is 0, so a car on
  // the world floor is coincidentally on the road. If the deck stops being
  // solid, both cars land 5 m below and this moves loudly.
  deck:     ['354b55b0', 'f0c5be44'],
  // Both MOVED in G5 and intentionally: the bridge deck now has a collider,
  // so these two finally drive ON the span instead of along the ground
  // underneath it. Their cars also gained a spec.y (they were spawned 0.7 m
  // and 1.0 m below the deck surface respectively, i.e. inside the ramp).
  // Was bridge 6d6ed6f1/553704f, water b3a3a7d3/1996d13e.
  bridge:   ['41c337c8', 'af80eb9'],
  water:    ['ac116fb4', '9d559754'],
  // NEW in 1C. Pins world.water.v2 — buoyancy and drag reaching dynamic props
  // and torn-off wheels instead of only sim.cars. It is a flooded flat pan
  // (bed = 0, so the driving surface is carnage's own plane under 60 cm of
  // water) and it deliberately covers BOTH branches of the new loops: 3 of the
  // 7 dynamic prop bodies ride under the surface and 4 stay above it, and one
  // wheel tears off and enters at tick 24. `water` sits next to it with no v2
  // flag and did not move, which is what proves the opt-in is an opt-in.
  waterv2:  ['6ce9b062', 'aa4fcf44'],
  carnage:  ['98c34be0', '584ce83a'],
  // moved once in G4 (was 516b05b0/bdf645b9) and intentionally: the
  // spawn-overlap net used to exempt any two cars sharing a lane as an
  // "intended queue", but a switchback hairpin folds back on itself, so two
  // cars 7 m apart in space can be 100 m apart along the lane pointing at
  // each other — that exemption put a head-on at tick 25. The scrub now
  // requires closeness in BOTH space and arc length, which shifts the cast.
  //
  // moved again in P2/2A (was d4276a3c/44620267), intentionally, from TWO
  // deliberate changes to topoIntersection — which is what 'pin-1' d4 deals:
  //   1. the stubs now start at ±7.4 instead of ±6.3, so every curb collider
  //      shifted along its road;
  //   2. the `asphalt_patch` prop is gone, and with it one rDress draw, so
  //      the whole dressing stream re-rolls.
  // The junctions that replaced the patch are NOT a cause and cannot be:
  // buildJunction returns an empty `shapes` list, and stripping `junctions`
  // from this very scenario leaves all 300 tick hashes bit-identical
  // (collider count 510 either way). The geometry hash did not move at all —
  // the crash still crumples exactly as it did.
  //
  // moved again in P2/2I+2J (was 2ebef4fc/44620267), intentionally and for
  // the first time in BOTH hashes — the crash itself is different because the
  // cast is different:
  //   1. traffic signals. 'pin-1' d4 is an intersection, so its junction now
  //      carries a signal program and its ambient traffic carries stop lines;
  //      cars brake for red and hold at the bar.
  //   2. cast size 3-8 → 4-10, plus up to four cars deliberately queued on
  //      whichever arm is red at the freeze.
  // Both are scene CONTENT changes, which Phase 2 exists to make. The geometry
  // hash moving alongside is expected here and is not evidence of a physics
  // change: no force, material or solver parameter was touched.
  director: ['d84820dd', 'ea7b2a6e'],
  // NEW in P2/2D. Pins `world.weather.grip` — a wet road under DRIVEN cars, so
  // both halves of the opt-in are frozen: the friction slip each wheel is BUILT
  // with, and the brake authority the driver COMMANDS every tick. They are
  // separate code paths and only the second one made grip directional, so a pin
  // that covered just the first would certify half a feature.
  //
  // Every other pin here sets no grip and none of them moved, which is what
  // proves the opt-in is an opt-in: `wxGrip` is exactly 1 when absent and
  // multiplying a float by exactly 1.0 is bit-exact, so the tyres and brakes
  // every legacy scenario builds are the ones it always built.
  wxgrip:   ['82c01590', 'b42a8bfb'],
  worldgen: ['20bf2a4d', '418447b5'],
};

const run = (scenario) => {
  const sim = new Phys.CrashSim(R, scenario, catOf);
  const hashes = new Uint32Array(301);
  for (let i = 0; i < 300; i++) { sim.stepOnce(); hashes[i] = sim.hashState(); }
  let g = 0x811c9dc5 >>> 0;
  for (const car of sim.cars) {
    for (const md of car.deform.meshes) {
      const u = new Uint32Array(md.pos.array.buffer, md.pos.array.byteOffset, md.pos.array.length);
      for (let i = 0; i < u.length; i += 7) { g ^= u[i]; g = Math.imul(g, 16777619) >>> 0; }
    }
  }
  hashes[300] = g >>> 0;
  sim.dispose();
  return hashes;
};

let fail = 0, n = 0;
for (const [name, scenario] of Object.entries(Phys.TEST_SCENARIOS)) {
  n++;
  const a = run(scenario), b = run(scenario);
  let firstDiff = -1;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { firstDiff = i; break; }
  const state = a[299].toString(16), geo = a[300].toString(16);
  const pin = PINS[name];
  const stable = firstDiff === -1;
  const pinned = pin ? (pin[0] === state && pin[1] === geo) : null;
  const ok = stable && pinned !== false;
  if (!ok) fail++;
  const tag = !stable ? `UNSTABLE at ${firstDiff === 300 ? 'geometry' : 'step ' + firstDiff}`
            : pinned === false ? `DRIFTED (pin ${pin[0]}/${pin[1]})`
            : pinned === null ? 'no pin recorded' : 'ok';
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(9)} ${state}/${geo}  ${tag}`);
}
console.log(fail ? `\nSIM PINS: FAIL (${fail}/${n})` : `\nSIM PINS: ok (${n}/${n})`);
process.exit(fail ? 1 : 0);
