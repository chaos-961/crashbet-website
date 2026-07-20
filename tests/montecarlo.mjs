// G2 Monte Carlo gate — run: node tests/montecarlo.mjs [roundsPerDifficulty]
// Deals rounds at every difficulty (out-of-sample seeds vs the calibration
// set), bets every market to-win-$100 (unit-return staking keeps rare ×50
// markets from drowning the edge estimate in variance), and asserts the
// realized house edge lands inside the per-difficulty target band around
// marginFor(d). ~1000 rounds ≈ 8 min; pass a smaller count for quick checks.
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

const PER_D = parseInt(process.argv[2] || '100', 10);
const LO = -0.045, HI = 0.075; // band half-widths around marginFor(d)

let fails = 0;
let allStaked = 0, allReturned = 0;
const t0 = Date.now();
for (let d = 1; d <= 10; d++) {
  let staked = 0, returned = 0, bets = 0, wins = 0;
  for (let i = 0; i < PER_D; i++) {
    const scene = D.generateScene(`mc${d}-${i}`, d);
    const markets = M.generateMarkets(scene);
    const rec = await Rec.recordScene(R, scene, catOf);
    for (const m of markets) {
      const stake = Math.max(1, Math.round(10000 / m.oddsH));
      staked += stake;
      bets++;
      if (M.settleMarket(m, rec)) {
        returned += Math.floor((stake * m.oddsH) / 100);
        wins++;
      }
    }
  }
  const edge = 1 - returned / staked;
  const target = M.marginFor(d);
  const ok = edge >= target + LO && edge <= target + HI;
  if (!ok) fails++;
  allStaked += staked; allReturned += returned;
  console.log(
    `d${String(d).padStart(2)}: edge ${(edge * 100).toFixed(1).padStart(5)}%` +
    ` (target ${(target * 100).toFixed(1)}%, band ${((target + LO) * 100).toFixed(1)}…${((target + HI) * 100).toFixed(1)})` +
    ` ${ok ? 'ok' : 'OUT OF BAND'} — ${bets} bets, ${(100 * wins / bets).toFixed(1)}% hit, $${staked} staked`,
  );
}
const overall = 1 - allReturned / allStaked;
console.log(`\noverall edge ${(overall * 100).toFixed(2)}% over $${allStaked} staked (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
const overallOk = overall >= 0.005 && overall <= 0.095;
if (!overallOk) fails++;
console.log(`MONTE CARLO: ${fails === 0 ? 'ok' : fails + ' FAILURES'}`);
process.exit(fails ? 1 : 0);
