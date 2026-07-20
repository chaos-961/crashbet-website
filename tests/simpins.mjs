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
  carnage:  ['98c34be0', '584ce83a'],
  // moved once in G4 (was 516b05b0/bdf645b9) and intentionally: the
  // spawn-overlap net used to exempt any two cars sharing a lane as an
  // "intended queue", but a switchback hairpin folds back on itself, so two
  // cars 7 m apart in space can be 100 m apart along the lane pointing at
  // each other — that exemption put a head-on at tick 25. The scrub now
  // requires closeness in BOTH space and arc length, which shifts the cast.
  director: ['d4276a3c', '44620267'],
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
