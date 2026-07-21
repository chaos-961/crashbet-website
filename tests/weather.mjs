/* weather gate — node tests/weather.mjs
 *
 * Weather never touches the sim, so no pin can catch a mistake here. What CAN
 * go wrong is the silent-mismatch class that already bit this codebase once:
 * `topoIntersection` named an env id `ENVS` did not have, `apply()` fell back
 * on an unknown id, and two of ten topologies rendered in the wrong place for
 * their entire existence without one error. The weather tables have exactly
 * that shape — a weight table names kinds, an env names a weight table — so
 * the cross-table integrity checks below are the point of this file. The
 * distribution and invariant checks are cheap insurance on top.
 */
import { pathToFileURL, fileURLToPath } from 'url';
import path from 'path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const load = (f) => import(pathToFileURL(path.join(root, 'js', f)));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ok ' + msg); } else { fail++; console.log('  FAIL ' + msg); } };

const { rollWeather, gripFor, WEATHER_KINDS, WEATHER_ENVS, CLEAR } = await load('weather.js');
const { ENVS } = await load('env.js');

/* ---- cross-table integrity: the ledger #5 bug class ---- */
// Every env preset must have its OWN weight table. `WEIGHTS` falls back to
// `proving` on an unknown id, so without this assertion a new preset silently
// inherits a desert's weather — exactly how two topologies rendered in the
// wrong environment for the entire life of the project without one error.
for (const e of ENVS) ok(WEATHER_ENVS.includes(e.id), `env '${e.id}' has its own weight table`);
// ...and the reverse, so a renamed preset leaves a dead table behind loudly
for (const id of WEATHER_ENVS) ok(ENVS.some((e) => e.id === id), `weight table '${id}' matches a real env`);
// grid is the diagnostic preset and must stay legible — no precipitation, ever.
{
  const kinds = new Set();
  for (let i = 0; i < 600; i++) kinds.add(rollWeather('g' + i, 'grid').kind);
  ok(kinds.size === 1 && kinds.has('clear'), 'grid stays clear (diagnostic preset legible)');
}
// Every kind a weight table can produce must exist in KINDS, or it rolls a
// descriptor of undefined multipliers and the scene renders unlit.
{
  let bad = null;
  for (const e of ENVS) {
    for (let i = 0; i < 1500; i++) {
      const w = rollWeather('k' + i, e.id);
      if (!WEATHER_KINDS.includes(w.kind)) { bad = e.id + ':' + w.kind; break; }
    }
  }
  ok(!bad, 'every rolled kind exists in KINDS' + (bad ? ' (got ' + bad + ')' : ''));
}

/* ---- determinism: same seed, same sky, forever ---- */
{
  const a = rollWeather('determinism', 'proving');
  const b = rollWeather('determinism', 'proving');
  ok(JSON.stringify(a) === JSON.stringify(b), 'same seed → identical descriptor');
  const c = rollWeather('determinism', 'salt');
  ok(JSON.stringify(a) !== JSON.stringify(c), 'env changes the roll');
  // the stream is its own: rolling weather must not be able to shift anything
  // else, which is only true because it derives from 'wx:'+seed and nothing
  // else reads that stream
  ok(a.kind === rollWeather('determinism', 'proving').kind, 'repeat roll is stable');
}

/* ---- descriptor invariants ---- */
{
  let bad = [];
  for (const e of ENVS) {
    for (let i = 0; i < 500; i++) {
      const w = rollWeather('i' + i, e.id);
      const L = w.light;
      if (!(w.intensity >= 0 && w.intensity <= 1)) bad.push('intensity ' + w.intensity);
      if (!(w.cloudCover >= 0 && w.cloudCover <= 1)) bad.push('cloud ' + w.cloudCover);
      if (!(w.haze.amt >= 0 && w.haze.amt <= 1)) bad.push('haze.amt ' + w.haze.amt);
      if (!/^#[0-9a-f]{6}$/i.test(w.haze.hex)) bad.push('haze.hex ' + w.haze.hex);
      if (w.precip !== null && !['rain', 'snow', 'dust'].includes(w.precip)) bad.push('precip ' + w.precip);
      if (w.precip && w.intensity <= 0) bad.push('precip with zero intensity');
      for (const k of ['key', 'hemi', 'fill', 'exposure', 'envI'])
        if (!(L[k] > 0 && L[k] <= 2)) bad.push('light.' + k + ' ' + L[k]);
      if (!(w.wind.speed > 0) || !(w.wind.dir >= 0 && w.wind.dir < Math.PI * 2)) bad.push('wind');
      if (bad.length) break;
    }
    if (bad.length) break;
  }
  ok(!bad.length, 'descriptor invariants hold' + (bad.length ? ' (' + bad[0] + ')' : ''));
}

/* ---- the reason weather exists: scenes must not all look the same ---- */
for (const e of ENVS) {
  if (e.id === 'grid') continue; // deliberately single-kind
  const seen = new Set();
  for (let i = 0; i < 300; i++) seen.add(rollWeather('v' + i, e.id).kind);
  ok(seen.size >= 4, `env '${e.id}' produces variety (${seen.size} kinds in 300 seeds)`);
}

/* ---- CLEAR is a usable no-weather default ---- */
ok(CLEAR && CLEAR.kind === 'clear' && CLEAR.precip === null && CLEAR.light.envI === 1,
  'CLEAR default is clear, dry and unlit-unchanged');

/* ---- grip (P2/2D) ----
   Same silent-fallback class this whole file exists to guard: `gripFor` returns
   1 for anything it does not recognise, so a kind added to KINDS without a grip
   value would quietly become a dry road and nothing would say so. This asserts
   every kind carries one, in range, and that dry kinds are exactly 1 — the
   opt-in's whole safety argument is that x * 1.0 is bit-exact, and a `clear`
   row of 0.999 would move every pin the moment a topology enabled grip. */
{
  const bad = [];
  for (const k of WEATHER_KINDS) {
    const g = gripFor({ kind: k });
    if (!Number.isFinite(g) || g <= 0 || g > 1) bad.push(`${k}=${g}`);
  }
  ok(!bad.length, 'every kind has a finite grip in (0, 1]' + (bad.length ? ' — ' + bad.join(' ') : ''));
  ok(gripFor({ kind: 'clear' }) === 1 && gripFor({ kind: 'fair' }) === 1,
    'dry kinds are EXACTLY 1 (x * 1.0 is bit-exact — this is what keeps pins frozen)');
  ok(gripFor(null) === 1 && gripFor(undefined) === 1 && gripFor({ kind: 'nope' }) === 1,
    'unknown / missing weather falls back to full grip, never to NaN');
  // the ordering that makes rain readable: wetter must never grip BETTER
  ok(gripFor({ kind: 'downpour' }) < gripFor({ kind: 'rain' })
    && gripFor({ kind: 'rain' }) < gripFor({ kind: 'drizzle' })
    && gripFor({ kind: 'drizzle' }) < gripFor({ kind: 'overcast' })
    && gripFor({ kind: 'overcast' }) < gripFor({ kind: 'clear' }),
    'grip falls monotonically along the rain ramp (the tell must be readable)');
  // snow is the trap: `wet` is only 0.20, so anything deriving grip from
  // wetness would make the slipperiest surface in the table nearly dry
  ok(gripFor({ kind: 'snow' }) < gripFor({ kind: 'rain' }),
    'snow grips worse than rain despite being barely WET (grip is per-kind, not from wetness)');
  ok(gripFor({ kind: 'dust' }) < 1, 'dust costs grip despite wet = 0 (grit on hardpan)');
}

console.log(`\nWEATHER: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
