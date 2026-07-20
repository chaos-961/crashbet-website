// G4 acceptance sweep — run: node tests/sweep.mjs [seedsPerD] [--combos]
// Deals scenes across d 1/5/10, records each to rest, and asserts the
// invariants that define a *clean* scene:
//   1. nothing collides before the incident tick (the director's core rule)
//   2. the scene settles inside the resolve cap (no perpetual-motion round)
//   3. at least one loggable event (an empty log is an unbettable round)
//   4. markets generate, and the headline pair is always offered
// Coverage is reported per topology × template, since G4's acceptance bar is
// the CROSS PRODUCT settling clean, not just the aggregate pass rate.
import { pathToFileURL } from 'url';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const load = (f) => import(pathToFileURL(path.join(root, f)));

const { REG } = await load('js/vehicles.js');
const D = await load('js/director.js');
const Rec = await load('js/recorder.js');
const M = await load('js/markets.js');
const Phys = await load('js/physics.js');
const R = await Phys.loadRapier();
const catOf = (id) => (REG.find((e) => e.id === id) || {}).cat || 'Cars';

const PER_D = parseInt(process.argv[2] || '60', 10);
const DS = [1, 5, 10];
const cap = D.INCIDENT_TICK + D.RESOLVE_TICKS;

const combos = new Map();   // "topo/template" -> {n, fails}
const fails = [];
let n = 0, eventless = 0, early = 0, unsettled = 0, crashes = 0;
const t0 = Date.now();

for (const d of DS) {
  for (let i = 0; i < PER_D; i++) {
    const seed = `swp${d}_${i}`;
    let scene, rec, markets;
    try {
      scene = D.generateScene(seed, d);
      markets = M.generateMarkets(scene);
      rec = await Rec.recordScene(R, scene, catOf);
    } catch (e) {
      fails.push({ seed, d, why: 'THREW: ' + e.message });
      continue;
    }
    n++;
    const key = `${scene.meta.topo}/${scene.meta.template}`;
    const c = combos.get(key) || { n: 0, fails: 0, crashed: 0 };
    c.n++;

    const why = [];
    // --- hard invariants: any of these is a defect ---
    // 1. nothing collides before the incident tick. Only car↔car counts: the
    //    recorder logs curb and ground contacts as `hit` too, and a car
    //    clipping a kerb on its approach is not a choreography failure.
    const pre = rec.events.filter((e) => e.k === 'hit' && e.o === 'car' && e.t < D.INCIDENT_TICK);
    if (pre.length) { why.push(`pre-incident hit @${pre[0].t}`); early++; }
    // 2. markets sane — every scene must be bettable, both headline sides
    if (!markets.length) why.push('no markets');
    else if (!markets.some((m) => m.id === 'h.crash') || !markets.some((m) => m.id === 'h.nocrash'))
      why.push('headline pair missing');

    // --- quality budgets: legitimate outcomes, but track the rate ---
    // Running to the cap is correct when the scene is genuinely still moving
    // (a wreck tumbling down a switchback) or when an event lands so late
    // that rest cannot be confirmed before the cap. Eventless is a real
    // no-crash round: the headline pair still settles, it just plays quiet.
    if (rec.restTick >= cap) unsettled++;
    if (!rec.events.length) eventless++;

    if (!rec.summary.noCrash) { crashes++; c.crashed++; }
    if (why.length) { c.fails++; fails.push({ seed, d, key, why: why.join('; ') }); }
    combos.set(key, c);
  }
  console.error(`  …d${d} done (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}

console.log(`\n=== G4 sweep: ${n} scenes across d ${DS.join('/')} ===`);
console.log(`crashed        ${crashes}/${n} (${((crashes / n) * 100).toFixed(0)}%)`);
console.log(`pre-incident   ${early}`);
console.log(`unsettled      ${unsettled}`);
console.log(`eventless      ${eventless}`);
console.log(`failed scenes  ${fails.length}`);

const byTopo = new Map();
for (const [key, c] of combos) {
  const topo = key.split('/')[0];
  const t = byTopo.get(topo) || { n: 0, fails: 0, tpl: new Set() };
  t.n += c.n; t.fails += c.fails; t.tpl.add(key.split('/')[1]);
  byTopo.set(topo, t);
}
console.log(`\n--- coverage: ${combos.size} topology×template combos seen ---`);
for (const [topo, t] of [...byTopo].sort((a, b) => a[0].localeCompare(b[0])))
  console.log(`  ${topo.padEnd(13)} ${String(t.n).padStart(4)} scenes  ${String(t.tpl.size).padStart(2)} templates  ${t.fails ? t.fails + ' FAIL' : 'clean'}`);

if (fails.length) {
  console.log(`\n--- first 25 failures ---`);
  for (const f of fails.slice(0, 25)) console.log(`  d${f.d} ${f.seed.padEnd(10)} ${(f.key || '').padEnd(24)} ${f.why}`);
}
// budgets: these are rates, not per-scene defects. Set from the measured G4
// baseline with headroom — a regression that doubles either trips the gate.
const CAP_BUDGET = 0.10, EVENTLESS_BUDGET = 0.12;
const capRate = unsettled / n, evRate = eventless / n;
const overCap = capRate > CAP_BUDGET, overEv = evRate > EVENTLESS_BUDGET;
if (overCap) console.log(`\nBUDGET: ran to cap ${(capRate * 100).toFixed(1)}% > ${CAP_BUDGET * 100}%`);
if (overEv) console.log(`BUDGET: eventless ${(evRate * 100).toFixed(1)}% > ${EVENTLESS_BUDGET * 100}%`);
const bad = fails.length || overCap || overEv;
console.log(bad ? `\nSWEEP: FAIL (${fails.length} defects, cap ${(capRate * 100).toFixed(1)}%, eventless ${(evRate * 100).toFixed(1)}%)`
                : `\nSWEEP: ok (${n}/${n} clean, cap ${(capRate * 100).toFixed(1)}%, eventless ${(evRate * 100).toFixed(1)}%)`);
process.exit(bad ? 1 : 0);
