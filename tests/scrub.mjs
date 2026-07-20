// Freeze-scrub correctness gate — run: node tests/scrub.mjs
//
// The freeze scrub bar (G5) lets the player rewind the last 10 s while time is
// stopped. There is no rewind in a rigid-body world, so a backward seek
// rebuilds and replays from t0 (main.js `seekPreview`). That is only sound if
// replaying lands on EXACTLY the state a clean run would have reached:
// the slip settles against a recording whose incident starts at INCIDENT_TICK,
// so if a scrubbed sim resumes from a different state, the player watches a
// different scene from the one the odds were priced on and the recorder taped.
//
// This asserts hashState() after a scrub round-trip equals hashState() after a
// clean run — per seed, per difficulty, rewinding to arbitrary ticks including 0.
import { pathToFileURL } from 'url';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const load = (f) => import(pathToFileURL(path.join(root, f)));

const { REG } = await load('js/vehicles.js');
const Phys = await load('js/physics.js');
const { generateScene, INCIDENT_TICK } = await load('js/director.js');
const R = await Phys.loadRapier();
const catOf = (id) => (REG.find((e) => e.id === id) || {}).cat || 'Cars';

// the six render-side hooks are nulled during a seek in the app too — replaying
// 600 ticks through them would dump a scene of particles and audio in a frame
const mute = (sim) => {
  sim.onImpact = sim.onScrape = sim.onGlass = sim.onDetach = sim.onSplash = sim.onSunk = null;
  return sim;
};

// mirrors main.js seekPreview()
function seek(sim, t) {
  if (t < sim.tick) sim.reset();
  mute(sim);
  while (sim.tick < t) sim.stepOnce();
}

const SEEDS = ['pin-1', 'scrub-a', 'scrub-b', 'rch6gj2r', 'zz9x'];
const DIFFS = [1, 5, 9];
// deliberately includes 0 (full rewind) and 599 (one tick short of the incident)
const REWINDS = [312, 540, 0, 118, 599];

let fail = 0, n = 0;
for (const seed of SEEDS) {
  for (const d of DIFFS) {
    n++;
    const sc = generateScene(seed, d);

    const a = mute(new Phys.CrashSim(R, sc, catOf));
    while (a.tick < INCIDENT_TICK) a.stepOnce();
    const clean = a.hashState();

    const b = mute(new Phys.CrashSim(R, sc, catOf));
    while (b.tick < INCIDENT_TICK) b.stepOnce();
    for (const t of REWINDS) seek(b, t);
    seek(b, INCIDENT_TICK);
    const scrubbed = b.hashState();

    const ok = clean === scrubbed;
    if (!ok) fail++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${seed} d${d}  clean=${clean} scrubbed=${scrubbed}`);
    a.dispose();
    b.dispose();
  }
}

console.log(fail ? `\nSCRUB: FAIL (${fail}/${n})` : `\nSCRUB: ok (${n}/${n})`);
process.exit(fail ? 1 : 0);
