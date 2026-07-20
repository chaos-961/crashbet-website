// G2 odds calibration harness — run: node tools/calibrate.mjs [nScenes]
// Deals scenes across all difficulties, records + settles every market, and
// prints an empirical CALIB table (hit rates by kind → template → bucket,
// Laplace-smoothed toward the kind mean) to paste into js/markets.js.
// This is offline bookmaker data: the runtime generator stays outcome-blind.
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

const N = parseInt(process.argv[2] || '400', 10);
// agg[kind][tpl][cal] = {n, h}; kindTotal[kind] = {n, h}
const agg = {}, kindTotal = {};
const bump = (kind, tpl, cal, hit) => {
  const K = (agg[kind] = agg[kind] || {});
  const T = (K[tpl] = K[tpl] || {});
  const C = (T[cal] = T[cal] || { n: 0, h: 0 });
  C.n++; if (hit) C.h++;
  const G = (kindTotal[kind] = kindTotal[kind] || { n: 0, h: 0 });
  G.n++; if (hit) G.h++;
};

const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const seed = 'cal' + i;
  const d = 1 + (i % 10);
  const scene = D.generateScene(seed, d);
  const markets = M.generateMarkets(scene);
  const rec = await Rec.recordScene(R, scene, catOf);
  for (const m of markets) {
    // complements are priced as 1−p of their pair — aggregating both sides
    // of the same coin under one kind reads exactly 0.5 forever
    if (m.id === 'h.nocrash' || m.id === 's.under') continue;
    bump(m.kind, scene.meta.template, m.cal || '_', M.settleMarket(m, rec));
  }
  if (i % 50 === 49) console.error(`  …${i + 1}/${N} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}

// smoothing: p = (h + k·p0) / (n + k), k = 6, p0 = kind mean
const K_SMOOTH = 6;
const fmt = (x) => Number(x.toFixed(3));
const out = {};
for (const kind of Object.keys(agg).sort()) {
  const p0 = kindTotal[kind].h / Math.max(1, kindTotal[kind].n);
  const kOut = { _: fmt(p0) };
  for (const tpl of Object.keys(agg[kind]).sort()) {
    const cells = agg[kind][tpl];
    const tplN = Object.values(cells).reduce((a, c) => a + c.n, 0);
    const tplH = Object.values(cells).reduce((a, c) => a + c.h, 0);
    const tOut = { _: fmt((tplH + K_SMOOTH * p0) / (tplN + K_SMOOTH)) };
    for (const cal of Object.keys(cells).sort()) {
      if (cal === '_') continue;
      const c = cells[cal];
      tOut[cal] = fmt((c.h + K_SMOOTH * p0) / (c.n + K_SMOOTH));
    }
    kOut[tpl] = tOut;
  }
  out[kind] = kOut;
}
console.log('// empirical CALIB from', N, 'scenes —', new Date().toISOString().slice(0, 10));
console.log('export const CALIB = ' + JSON.stringify(out, null, 2).replace(/"([a-zA-Z_$][\w$]*)":/g, '$1:') + ';');

// sample-size report so thin cells are visible
console.error('\ncell sample sizes (n < 20 marked thin):');
for (const kind of Object.keys(agg).sort()) {
  for (const tpl of Object.keys(agg[kind]).sort()) {
    for (const [cal, c] of Object.entries(agg[kind][tpl])) {
      if (c.n < 20) console.error(`  thin: ${kind}.${tpl}.${cal} n=${c.n}`);
    }
  }
}
