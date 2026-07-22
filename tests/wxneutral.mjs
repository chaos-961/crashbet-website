// Weather neutrality gate — run: node tests/wxneutral.mjs
//
// P4/4E: prove the LOOK can never touch the MONEY. The sim reads exactly one
// field of `world.weather` — a finite numeric `grip` (physics.js `this.wxGrip`);
// every other key (kind, intensity, wetness, cloud, fog, wind, lightning, haze)
// is render-side garnish. This pins that contract from the outside:
//
//   A. NEUTRALITY — replace the whole descriptor with an alien one (storm vs
//      clear, soaked vs dry, gale vs still) while carrying `grip` over
//      bit-for-bit → rec.hash must be IDENTICAL. If any other weather key ever
//      leaks into the sim, this is the test that goes red.
//   B. STRIP — on a scene that carries no grip, delete world.weather outright
//      → identical hash (the whole descriptor is cosmetic there).
//   C. TEETH — on a scene whose grip is < 0.9, delete world.weather (grip
//      reverts to exactly 1) → the hash MUST move. Guards against the inverse
//      failure: a refactor that quietly stops grip reaching the tyres would
//      make A/B pass vacuously; C is what notices.
//
// Scenes are re-generated fresh per variant (generateScene is deterministic),
// so no clone-fidelity question can contaminate the comparison.
import { pathToFileURL } from 'url';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const load = (f) => import(pathToFileURL(path.join(root, f)));

const { REG } = await load('js/vehicles.js');
const Phys = await load('js/physics.js');
const Rec = await load('js/recorder.mjs').catch(() => load('js/recorder.js'));
const { generateScene } = await load('js/director.js');
const R = await Phys.loadRapier();
const catOf = (id) => (REG.find((e) => e.id === id) || {}).cat || 'Cars';

// an alien descriptor: every render-side field different from anything a real
// roll produces together — downpour + max wetness + gale + lightning + haze
const alien = (grip) => {
  const w = {
    kind: 'downpour', intensity: 1, cloudCover: 1, wetness: 1, fogBoost: 1,
    wind: { dir: 2.618, speed: 14.5 }, lightning: true,
    haze: { hex: 0x8899aa, amt: 0.9 },
  };
  if (Number.isFinite(grip)) w.grip = grip; // carried over EXACTLY, else absent
  return w;
};

const hashOf = async (seed, d, mutate) => {
  const sc = generateScene(seed, d);
  mutate(sc);
  const rec = await Rec.recordScene(R, sc, catOf);
  return rec.hash;
};

let fail = 0, n = 0;
const ok = (cond, label) => {
  n++;
  if (!cond) fail++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}`);
};

// scan a fixed seed list, sorting scenes into the two classes the tests need:
// plain (no grip) and gripped (grip < 0.9, so reverting to 1 must be visible)
const plain = [], gripped = [];
for (let i = 0; i < 40 && (plain.length < 5 || gripped.length < 3); i++) {
  for (const d of [2, 6, 9]) {
    const seed = `wxn${i}`;
    const sc = generateScene(seed, d);
    const g = sc.world.weather && sc.world.weather.grip;
    if (Number.isFinite(g) && g < 0.9 && gripped.length < 3) gripped.push([seed, d, g]);
    else if (!Number.isFinite(g) && plain.length < 5) plain.push([seed, d]);
  }
}
console.log(`scenes: ${plain.length} plain, ${gripped.length} gripped (${gripped.map(([s, d, g]) => `${s}~${d}@${g.toFixed(2)}`).join(', ')})\n`);

// A — neutrality: alien look, same grip, same hash
for (const [seed, d] of plain) {
  const base = await hashOf(seed, d, () => {});
  const mut = await hashOf(seed, d, (sc) => { sc.world.weather = alien(undefined); });
  ok(base === mut, `A neutrality ${seed} d${d} (plain)  ${base}`);
}
for (const [seed, d, g] of gripped) {
  const base = await hashOf(seed, d, () => {});
  const mut = await hashOf(seed, d, (sc) => { sc.world.weather = alien(g); });
  ok(base === mut, `A neutrality ${seed} d${d} (grip ${g.toFixed(2)})  ${base}`);
}

// B — strip: no grip anywhere, so no weather at all must read identically
for (const [seed, d] of plain) {
  const base = await hashOf(seed, d, () => {});
  const mut = await hashOf(seed, d, (sc) => { delete sc.world.weather; });
  ok(base === mut, `B strip ${seed} d${d}  ${base}`);
}

// C — teeth: grip reverting to 1 must move the tape
for (const [seed, d, g] of gripped) {
  const base = await hashOf(seed, d, () => {});
  const mut = await hashOf(seed, d, (sc) => { delete sc.world.weather; });
  ok(base !== mut, `C teeth ${seed} d${d} (grip ${g.toFixed(2)} → 1 moves the hash)`);
}

console.log(fail ? `\nWX NEUTRAL: FAIL (${fail}/${n})` : `\nWX NEUTRAL: ok (${n}/${n})`);
process.exit(fail ? 1 : 0);
