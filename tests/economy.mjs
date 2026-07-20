// G2 economy suite — run: node tests/economy.mjs
// Headless: the synthetic tests need no Rapier; the final integration test
// deals a real scene, records it and settles every market against it.
import { pathToFileURL } from 'url';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const load = (f) => import(pathToFileURL(path.join(root, f)));

const E = await load('js/economy.js');
const M = await load('js/markets.js');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ok', name); }
  else { failed++; console.log('  FAIL', name); }
}

// synthetic market list + recording: two cars, one prop
const fakeMarkets = [
  { id: 'a', group: 'car:0', label: 'A crashes', kind: 'crash', oddsH: 333, settle: { carCrash: 0 } },
  { id: 'b', group: 'car:1', label: 'B crashes', kind: 'crash', oddsH: 250, settle: { carCrash: 1 } },
  { id: 'c', group: 'headline', label: 'crash', kind: 'headline', oddsH: 120, settle: { anyCrash: true } },
  { id: 'big1', group: 'x', label: 'big', kind: 'fire', oddsH: 5000, settle: { carCrash: 0 } },
  { id: 'big2', group: 'y', label: 'big', kind: 'fire', oddsH: 5000, settle: { carCrash: 0 } },
];
const fakeRec = {
  events: [{ k: 'hit', t: 700, car: 0, o: 'car', oi: 1, dv: 5 }],
  summary: {
    perCar: [
      { touched: true, crashedAt: 700, maxDv: 5, hits: 1, flipAt: -1, wheels: 0, fireAt: -1, escapeAt: -1, glass: 0, offroadAt: -1 },
      { touched: false, crashedAt: -1, maxDv: 0, hits: 0, flipAt: -1, wheels: 0, fireAt: -1, escapeAt: -1, glass: 0, offroadAt: -1 },
    ],
    perProp: [{ hitAt: -1, movedAt: -1 }],
    crashed: 1, firstCrashTick: 700, propsMoved: 0,
    anyFlip: false, anyWheel: false, anyGlass: false, noCrash: false, restTick: 900,
  },
};

console.log('— payout flooring —');
{
  const p = E.newProfile('t1');
  E.currentRound(p);
  const slip = E.makeSlip();
  slip.legs.push({ id: 'a', stake: 3 }); // 3 × 3.33 = 9.99 → $9
  E.placeSlip(p, slip, fakeMarkets);
  const rep = E.settleRound(p, fakeMarkets, fakeRec);
  ok(rep.legs[0].payout === 9, 'floor(3 × 333 / 100) = $9');
  ok(Number.isInteger(rep.payout) && Number.isInteger(p.bankroll), 'all money integer');
  ok(p.bankroll === 100 - 3 + 9, 'bankroll 100 − 3 + 9 = 106');
}

console.log('— bankroll can never go negative —');
{
  const p = E.newProfile('t2');
  E.currentRound(p);
  const over = E.makeSlip();
  over.legs.push({ id: 'a', stake: 101 });
  ok(!E.validateSlip(over, fakeMarkets, p.bankroll).ok, 'stake over bankroll rejected');
  const allIn = E.makeSlip();
  allIn.legs.push({ id: 'b', stake: 100 }); // loses (car 1 never crashes)
  const v = E.placeSlip(p, allIn, fakeMarkets);
  ok(v.ok && p.bankroll === 0, 'all-in deducts to exactly $0');
  const rep = E.settleRound(p, fakeMarkets, fakeRec);
  ok(rep.payout === 0 && rep.busted && p.bankroll === 100 && p.stats.busts === 1,
    'losing all-in → ROCK BOTTOM: bust recorded, restart at $100');
}

console.log('— once-per-seed settlement —');
{
  const p = E.newProfile('t3');
  const r1 = E.currentRound(p);
  const seed = r1.seed;
  const slip = E.makeSlip();
  slip.legs.push({ id: 'a', stake: 10 });
  E.placeSlip(p, slip, fakeMarkets);
  E.settleRound(p, fakeMarkets, fakeRec);
  const after = p.bankroll;
  ok(E.seedSettled(p, seed), 'seed lands in the ledger');
  // re-bet the same seed (simulated replay attack)
  p.round = { seed, exhibition: false, phase: 'open', slip: null };
  const slip2 = E.makeSlip();
  slip2.legs.push({ id: 'a', stake: 10 });
  E.placeSlip(p, slip2, fakeMarkets); // NOTE: deducts — the UI won't offer it, but even if forced…
  const rep2 = E.settleRound(p, fakeMarkets, fakeRec);
  ok(!rep2.forMoney && rep2.payout > 0 === true && p.bankroll === after - 10,
    'settled seed never pays again (stake sunk, no winnings)');
}

console.log('— parlay —');
{
  const p = E.newProfile('t4');
  ok(E.parlayOddsH(['big1', 'big2'], fakeMarkets) === M.PARLAY_CAP, '50×50 capped at ×500');
  E.currentRound(p);
  const slip = E.makeSlip();
  slip.parlay = { ids: ['big1', 'big2'], stake: 2 };
  E.placeSlip(p, slip, fakeMarkets);
  const rep = E.settleRound(p, fakeMarkets, fakeRec);
  ok(rep.parlay.win && rep.parlay.payout === 2 * 500, 'capped parlay pays stake × 500');

  E.currentRound(p);
  const slip2 = E.makeSlip();
  slip2.parlay = { ids: ['a', 'b'], stake: 5 }; // b loses
  E.placeSlip(p, slip2, fakeMarkets);
  const rep2 = E.settleRound(p, fakeMarkets, fakeRec);
  ok(!rep2.parlay.win && rep2.parlay.payout === 0, 'one losing leg kills the parlay');

  const bad = E.makeSlip();
  bad.parlay = { ids: ['a'], stake: 1 };
  ok(!E.validateSlip(bad, fakeMarkets, 100).ok, 'parlay needs ≥ 2 legs');
  const dup = E.makeSlip();
  dup.parlay = { ids: ['a', 'a'], stake: 1 };
  ok(!E.validateSlip(dup, fakeMarkets, 100).ok, 'duplicate parlay legs rejected');
}

console.log('— validation edges —');
{
  const frac = E.makeSlip();
  frac.legs.push({ id: 'a', stake: 1.5 });
  ok(!E.validateSlip(frac, fakeMarkets, 100).ok, 'fractional stake rejected');
  const zero = E.makeSlip();
  zero.legs.push({ id: 'a', stake: 0 });
  ok(!E.validateSlip(zero, fakeMarkets, 100).ok, '$0 stake rejected');
  const unknown = E.makeSlip();
  unknown.legs.push({ id: 'zzz', stake: 1 });
  ok(!E.validateSlip(unknown, fakeMarkets, 100).ok, 'unknown market rejected');
}

console.log('— mid-round resume —');
{
  const store = E.memoryStore();
  const p = E.newProfile('t5');
  const round = E.currentRound(p);
  const slip = E.makeSlip();
  slip.legs.push({ id: 'c', stake: 7 });
  E.placeSlip(p, slip, fakeMarkets);
  E.saveProfile(store, p);
  // "reload"
  const q = E.loadProfile(store);
  ok(q && q.round && q.round.seed === round.seed, 'unfinished round survives reload');
  ok(q.round.slip.legs[0].id === 'c' && q.round.slip.legs[0].stake === 7, 'slip draft restored');
  ok(q.bankroll === 93, 'deducted bankroll persisted');
  ok(E.campaignSeed(q) === round.seed, 'campaign stream re-derives the same seed');
  const rep = E.settleRound(q, fakeMarkets, fakeRec);
  ok(rep.forMoney && q.bankroll === 93 + Math.floor((7 * 120) / 100), 'resumed round settles for money');
}

console.log('— exhibition rule —');
{
  const p = E.newProfile('t6');
  E.exhibitionRound(p, 'shared-link-seed');
  const slip = E.makeSlip();
  slip.legs.push({ id: 'a', stake: 50 });
  E.placeSlip(p, slip, fakeMarkets);
  ok(p.bankroll === 100, 'exhibition stakes nothing');
  const rep = E.settleRound(p, fakeMarkets, fakeRec);
  ok(!rep.forMoney && p.bankroll === 100 && p.ledger.length === 0 && p.stats.rounds === 0,
    'exhibition settles for fun: zero bankroll/ledger/stats mutation');
}

console.log('— campaign stream —');
{
  const p = E.newProfile('t7');
  const s0 = E.campaignSeed(p, 0), s1 = E.campaignSeed(p, 1);
  ok(/^[0-9a-z]{8}$/.test(s0) && s0 !== s1, '8-char base36, distinct per index');
  const p2 = E.newProfile('t7');
  ok(E.campaignSeed(p2, 0) === s0, 'same entropy → same stream (deterministic resume)');
  const p3 = E.newProfile('other');
  ok(E.campaignSeed(p3, 0) !== s0, 'different profile → different stream');
}

console.log('— integration: real scene → markets → settlement —');
{
  const { REG } = await load('js/vehicles.js');
  const D = await load('js/director.js');
  const Rec = await load('js/recorder.js');
  const Phys = await load('js/physics.js');
  const R = await Phys.loadRapier();
  const catOf = (id) => (REG.find((e) => e.id === id) || {}).cat || 'Cars';
  const scene = D.generateScene('econ-int', 3);
  const markets = M.generateMarkets(scene);
  ok(markets.length > 10, `real scene generates markets (${markets.length})`);
  ok(markets.every((m) => Number.isInteger(m.oddsH) && m.oddsH >= M.ODDS_MIN && m.oddsH <= M.ODDS_MAX),
    'all odds integer within ×1.10–×50');
  ok(new Set(markets.map((m) => m.id)).size === markets.length, 'market ids unique');
  const rec = await Rec.recordScene(R, scene, catOf);
  const results = markets.map((m) => M.settleMarket(m, rec));
  ok(results.every((r) => typeof r === 'boolean'), 'every market settles to a boolean');
  const h1 = results[markets.findIndex((m) => m.id === 'h.crash')];
  const h2 = results[markets.findIndex((m) => m.id === 'h.nocrash')];
  ok(h1 !== h2, 'headline pair settles exactly one side');
  const overI = markets.findIndex((m) => m.id === 's.over');
  const underI = markets.findIndex((m) => m.id === 's.under');
  ok(results[overI] !== results[underI], 'over/under settles exactly one side');
  // determinism: settle twice against a re-recording
  const rec2 = await Rec.recordScene(R, D.generateScene('econ-int', 3), catOf);
  const results2 = markets.map((m) => M.settleMarket(m, rec2));
  ok(results.every((r, i) => r === results2[i]), 'settlement bit-identical across re-recordings');
}

/* ================= G5: daily seed + achievements ================= */
const A = await load('js/achievements.js');

console.log('— daily seed —');
{
  ok(E.dailySeed('2026-07-20') === E.dailySeed('2026-07-20'), 'same date → same seed');
  ok(E.dailySeed('2026-07-20') !== E.dailySeed('2026-07-21'), 'different date → different seed');
  ok(/^[0-9a-z]{8}$/.test(E.dailySeed('2026-07-20')), 'daily seed is 8-char base36');
  // the whole point: it is date-derived, so two profiles share the scene
  const p1 = E.newProfile('d1'), p2 = E.newProfile('d2');
  ok(E.dailyInfo(p1, '2026-07-20').seed === E.dailyInfo(p2, '2026-07-20').seed,
    'daily seed is identical across profiles');

  const p = E.newProfile('daily-a');
  const key = '2026-07-20';
  ok(!E.dailyInfo(p, key).played, 'daily starts unplayed');
  E.dailyRound(p, key);
  ok(p.round.seed === E.dailySeed(key) && p.round.exhibition === false, 'daily round is a money round');
  E.placeSlip(p, { legs: [{ id: 'a', stake: 5 }], parlay: null }, fakeMarkets);
  E.settleRound(p, fakeMarkets, fakeRec);
  ok(E.dailyInfo(p, key).played, 'daily marked played after settlement');
  ok(p.daily.streak === 1 && p.daily.plays === 1, 'first daily sets streak 1');

  // a second attempt at the same seed must not pay again (ledger rule)
  E.dailyRound(p, key);
  E.placeSlip(p, { legs: [{ id: 'a', stake: 5 }], parlay: null }, fakeMarkets);
  const bank = p.bankroll;
  const r2 = E.settleRound(p, fakeMarkets, fakeRec);
  ok(r2.forMoney === false && p.bankroll === bank, 'replaying the daily pays nothing');

  // consecutive days advance the streak; a gap resets it
  const q = E.newProfile('daily-b');
  E.noteDaily(q, '2026-07-18');
  E.noteDaily(q, '2026-07-19');
  E.noteDaily(q, '2026-07-20');
  ok(q.daily.streak === 3, 'consecutive days build the streak');
  E.noteDaily(q, '2026-07-25');
  ok(q.daily.streak === 1 && q.daily.best === 3, 'a gap resets the streak but keeps best');
  // month/year boundaries must not be treated as gaps
  const b = E.newProfile('daily-c');
  E.noteDaily(b, '2026-01-31');
  E.noteDaily(b, '2026-02-01');
  ok(b.daily.streak === 2, 'streak survives a month boundary');
  const yb = E.newProfile('daily-d');
  E.noteDaily(yb, '2025-12-31');
  E.noteDaily(yb, '2026-01-01');
  ok(yb.daily.streak === 2, 'streak survives a year boundary');
}

console.log('— achievements —');
{
  const mk = (over) => ({
    report: { legs: [], parlay: null, staked: 0, payout: 0, net: 0, forMoney: true, busted: false, ...over },
    rec: fakeRec, markets: fakeMarkets, d: 3,
  });
  const p = E.newProfile('ach-a');
  p.stats.rounds = 1;
  const first = A.evaluate(p, mk({}));
  ok(first.includes('first-blood'), 'first-blood unlocks on a settled round');
  ok(A.evaluate(p, mk({})).length === 0, 'already-held achievements do not re-fire');

  const q = E.newProfile('ach-b');
  ok(A.evaluate(q, { ...mk({}), report: { ...mk({}).report, forMoney: false } }).length === 0,
    'exhibition rounds unlock nothing');

  const r = E.newProfile('ach-c');
  r.stats.rounds = 1;
  r.bankroll = 1200; // achievements read the POST-settlement profile, not the report
  const got = A.evaluate(r, mk({
    legs: [{ id: 'a', stake: 100, oddsH: 1200, win: true, payout: 1200 }], net: 1100,
  }));
  ok(got.includes('high-roller'), 'high-roller on a $100 stake');
  ok(got.includes('long-shot'), 'long-shot on a ×12 winner');
  ok(got.includes('big-score'), 'big-score on +$500');
  ok(got.includes('centurion'), 'centurion once the bankroll clears $1,000');

  // a throwing test must not take settlement down with it
  const bad = { id: '_boom', icon: '?', name: 'x', desc: 'x', test: () => { throw new Error('nope'); } };
  A.ACHIEVEMENTS.push(bad);
  const s = E.newProfile('ach-d');
  let threw = false;
  try { A.evaluate(s, mk({})); } catch { threw = true; }
  ok(!threw, 'a throwing achievement test is swallowed');
  A.ACHIEVEMENTS.pop();

  ok(A.ACHIEVEMENTS.every((a) => a.id && a.icon && a.name && a.desc && typeof a.test === 'function'),
    'every achievement is well-formed');
  ok(new Set(A.ACHIEVEMENTS.map((a) => a.id)).size === A.ACHIEVEMENTS.length, 'achievement ids unique');
}

console.log(`\nECONOMY SUITE: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
