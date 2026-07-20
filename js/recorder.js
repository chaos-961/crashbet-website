// recorder.js — the pre-sim (game phase G1). Runs a director scenario
// headlessly to rest, harvesting the EVENT LOG that the whole betting game
// settles against: per-car contacts (with what, how hard), flips, torn
// wheels, fire, glass, escapes, prop strikes, near-miss passes, rest tick.
// The recording sim is built, stepped and disposed here — the live view runs
// a SECOND sim from the same scenario, and determinism makes them identical.
//
// Everything logged is a pure function of sim state, read inside the step
// loop in fixed order — the event list (and its FNV hash) is bit-identical
// across runs and across node/browser. Nothing here ever writes sim state.
import { CrashSim } from './physics.js';
import { INCIDENT_TICK, RESOLVE_TICKS } from './director.js';
import { roadCurve } from './roads.js';

const EV_CODE = { hit: 1, glass: 2, wheel: 3, flip: 4, fire: 5, escape: 6, prop: 7, close: 8, offroad: 9 };
const OTHER_CODE = { car: 1, prop: 2, road: 3, wall: 4, ground: 5, debris: 6, unknown: 0 };

// crashed = a contact this hard or harder (Δv, m/s) — the market threshold
export const CRASH_DV = 2.5;
// logged at all (softer touches still void "survives untouched")
export const TOUCH_DV = 1.4;

export async function recordScene(R, scenario, catOf, opts = {}) {
  const maxTicks = opts.maxTicks || INCIDENT_TICK + RESOLVE_TICKS;
  const chunk = opts.chunk || 0; // >0: yield to the event loop every N steps
  const sim = new CrashSim(R, scenario, catOf);
  const nCars = sim.cars.length;
  const half = ((scenario.world && scenario.world.arena) || 100) / 2;
  const events = [];
  const carIdx = new Map(sim.cars.map((c, i) => [c, i]));

  // asphalt footprint (for the 'offroad' event): each road sampled every
  // ~2.5 m. A car is off-road when its nearest sample is beyond half the road
  // width + margin — UNLESS that nearest sample is a road endpoint, which
  // means the car drove off the END of the road (escape territory, not a
  // swerve off the asphalt).
  const roadSamp = (scenario.roads || []).map((spec) => {
    const c = roadCurve(spec);
    const n = Math.max(8, Math.ceil(c.getLength() / 2.5));
    const pts = new Float64Array((n + 1) * 2);
    for (let i = 0; i <= n; i++) {
      const p = c.getPointAt(i / n);
      pts[i * 2] = p.x; pts[i * 2 + 1] = p.z;
    }
    return { pts, n, lim2: (spec.w / 2 + 2.6) ** 2 };
  });
  const offRoadAt = (x, z) => {
    if (!roadSamp.length) return false;
    let best = Infinity, bestEnd = false, bestIn = false;
    for (const rs of roadSamp) {
      for (let i = 0; i <= rs.n; i++) {
        const dx = x - rs.pts[i * 2], dz = z - rs.pts[i * 2 + 1];
        const d2 = dx * dx + dz * dz;
        if (d2 < rs.lim2) bestIn = true;
        if (d2 < best) { best = d2; bestEnd = i === 0 || i === rs.n; }
      }
    }
    return !bestIn && !bestEnd;
  };

  // ---- contact hooks (dedup: one 'hit' per car↔object pair per 20 ticks) ----
  const lastHit = new Map();
  const per = sim.cars.map(() => ({
    touched: false, crashedAt: -1, maxDv: 0, hits: 0,
    flipAt: -1, flipTicks: 0, wheels: 0, fireAt: -1, escapeAt: -1, glass: 0,
    offroadAt: -1,
  }));
  sim.onImpact = (car, ev) => {
    const i = carIdx.get(car);
    const p = per[i];
    if (ev.dv > p.maxDv) p.maxDv = ev.dv;
    if (ev.dv < TOUCH_DV) return;
    p.touched = true;
    if (ev.dv >= CRASH_DV && p.crashedAt < 0) p.crashedAt = sim.tick;
    const key = i + ':' + ev.other.kind + ':' + ev.other.i;
    const last = lastHit.get(key);
    if (last !== undefined && sim.tick - last < 20) return;
    lastHit.set(key, sim.tick);
    p.hits++;
    events.push({
      k: 'hit', t: sim.tick, car: i, dv: Math.round(ev.dv * 1000) / 1000,
      o: ev.other.kind, oi: ev.other.i,
      x: Math.round(ev.point.x * 100) / 100, z: Math.round(ev.point.z * 100) / 100,
    });
  };
  sim.onGlass = (car, ev) => {
    if (ev.type !== 'glassShatter') return;
    const i = carIdx.get(car);
    per[i].glass++;
    events.push({ k: 'glass', t: sim.tick, car: i });
  };
  sim.onDetach = (car) => {
    const i = carIdx.get(car);
    per[i].wheels++;
    events.push({ k: 'wheel', t: sim.tick, car: i });
  };

  // ---- per-prop state (dynamic bodies: knocked over / shoved) ----
  // homes are captured at tick 50, AFTER spawn settling — dynamic props drop
  // a few cm onto their rest pose and that must not read as "knocked over"
  const propState = sim.props.map((rec) => ({
    dyn: rec.dyn.length > 0, movedAt: -1, home: null,
  }));

  // ---- coarse position tracks for future scrubbing UIs (not hashed) ----
  const TRACK_EVERY = 10;
  const tracks = sim.cars.map(() => new Float32Array((Math.ceil(maxTicks / TRACK_EVERY) + 1) * 3));

  const closePairs = new Set();
  let restRun = 0, restTick = -1;

  for (let tick = 0; tick < maxTicks; tick++) {
    sim.stepOnce();
    // scans (fixed order, read-only)
    for (let i = 0; i < nCars; i++) {
      const car = sim.cars[i];
      const p = per[i];
      const q = car.cur.q;
      const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
      if (upY < 0.35) {
        if (++p.flipTicks === 45 && p.flipAt < 0) {
          p.flipAt = sim.tick;
          events.push({ k: 'flip', t: sim.tick, car: i });
        }
      } else p.flipTicks = 0;
      if (p.fireAt < 0 && car.frontDmg >= 26) {
        p.fireAt = sim.tick;
        events.push({ k: 'fire', t: sim.tick, car: i });
      }
      if (p.escapeAt < 0 && (Math.abs(car.cur.p.x) > half + 6 || Math.abs(car.cur.p.z) > half + 6)) {
        p.escapeAt = sim.tick;
        events.push({ k: 'escape', t: sim.tick, car: i });
      }
      // off the asphalt at speed (once per car, checked coarsely): a swerve
      // that never touches anything is still a loggable — and bettable — outcome
      if (p.offroadAt < 0 && sim.tick > 60 && sim.tick % 10 === 0) {
        const lv = car.body.linvel();
        if (Math.abs(lv.x) + Math.abs(lv.z) > 4.5 && offRoadAt(car.cur.p.x, car.cur.p.z)) {
          p.offroadAt = sim.tick;
          events.push({ k: 'offroad', t: sim.tick, car: i });
        }
      }
      if (sim.tick % TRACK_EVERY === 0) {
        const o = (sim.tick / TRACK_EVERY) * 3;
        tracks[i][o] = car.cur.p.x; tracks[i][o + 1] = car.cur.p.y; tracks[i][o + 2] = car.cur.p.z;
      }
    }
    // near-miss shaves around the incident: two moving cars passing close
    if (sim.tick >= INCIDENT_TICK - 10 && sim.tick <= INCIDENT_TICK + 300 && sim.tick % 3 === 0) {
      for (let i = 0; i < nCars; i++) {
        for (let j = i + 1; j < nCars; j++) {
          const key = i * 16 + j;
          if (closePairs.has(key)) continue;
          const a = sim.cars[i].cur.p, b = sim.cars[j].cur.p;
          const dx = a.x - b.x, dz = a.z - b.z;
          if (dx * dx + dz * dz < 3.1 * 3.1) {
            const va = sim.cars[i].body.linvel(), vb = sim.cars[j].body.linvel();
            if (Math.hypot(va.x, va.z) > 3 || Math.hypot(vb.x, vb.z) > 3) {
              closePairs.add(key);
              events.push({ k: 'close', t: sim.tick, car: i, oi: j });
            }
          }
        }
      }
    }
    // dynamic props: knocked over / shoved off their (settled) spot
    if (sim.tick === 50) {
      for (let pi = 0; pi < sim.props.length; pi++) {
        if (propState[pi].dyn) {
          propState[pi].home = sim.props[pi].dyn.map((d) => ({ x: d.cur.p.x, y: d.cur.p.y, z: d.cur.p.z }));
        }
      }
    }
    if (sim.tick % 5 === 0 && sim.tick > 60) {
      for (let pi = 0; pi < sim.props.length; pi++) {
        const st = propState[pi];
        if (!st.dyn || !st.home || st.movedAt >= 0) continue;
        const rec = sim.props[pi];
        for (let di = 0; di < rec.dyn.length; di++) {
          const d = rec.dyn[di];
          const h = st.home[di];
          const dx = d.cur.p.x - h.x, dy = d.cur.p.y - h.y, dz = d.cur.p.z - h.z;
          const q = d.cur.q;
          const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
          if (dx * dx + dy * dy + dz * dz > 0.36 || upY < 0.75) {
            st.movedAt = sim.tick;
            events.push({ k: 'prop', t: sim.tick, oi: pi });
            break;
          }
        }
      }
    }
    // Rest = the INCIDENT has finished playing out, not "the world is
    // motionless": an untouched ambient car cruising off down its lane would
    // otherwise hold every scene open to the hard cap. Only cars that have
    // actually been in contact, torn-off debris, and disturbed props count.
    if (sim.tick > INCIDENT_TICK + 120 && sim.tick % 5 === 0) {
      let vmax = 0;
      const scan = (body) => {
        const lv = body.linvel(), av = body.angvel();
        const m = Math.max(Math.abs(lv.x), Math.abs(lv.y), Math.abs(lv.z), Math.abs(av.x) * 0.5, Math.abs(av.y) * 0.5, Math.abs(av.z) * 0.5);
        if (m > vmax) vmax = m;
      };
      let involved = 0;
      for (let i = 0; i < nCars; i++) if (per[i].touched) { involved++; scan(sim.cars[i].body); }
      for (const d of sim.debris) { involved++; scan(d.body); }
      for (let pi = 0; pi < sim.props.length; pi++) {
        if (propState[pi].movedAt < 0) continue;
        involved++;
        for (const d of sim.props[pi].dyn) scan(d.body);
      }
      // still-moving traffic keeps a quiet scene open: cars can be seconds
      // from a late collision, and cutting at a fixed delay after T=0 threw
      // away real crashes (a pullout that landed at T+646).
      let vFree = 0;
      for (let i = 0; i < nCars; i++) {
        if (per[i].touched) continue;
        const lv = sim.cars[i].body.linvel();
        const s = Math.abs(lv.x) + Math.abs(lv.z);
        if (s > vFree) vFree = s;
      }
      const lastEv = events.length ? events[events.length - 1].t : 0;
      // 0.25 tolerates a wreck still rocking on its roof / a wheel trickling;
      // tighter thresholds never converge and every scene ran to the cap
      const settled = involved > 0 && vmax < 0.25 && sim.tick - lastEv > 90;
      if (settled || (involved === 0 && vFree < 1.2)) {
        restRun += 5;
        if (restRun >= 75) { restTick = sim.tick; break; }
      } else restRun = 0;
    }
    if (chunk > 0 && tick % chunk === chunk - 1) {
      if (opts.onProgress) opts.onProgress(tick / maxTicks);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  const ticks = sim.tick;
  if (restTick < 0) restTick = ticks;

  // ---- summary (the settlement source for G2 markets) ----
  const summary = {
    perCar: per.map((p, i) => ({
      touched: p.touched, crashedAt: p.crashedAt, maxDv: Math.round(p.maxDv * 1000) / 1000,
      hits: p.hits, flipAt: p.flipAt, wheels: p.wheels, fireAt: p.fireAt,
      escapeAt: p.escapeAt, glass: p.glass, offroadAt: p.offroadAt,
    })),
    perProp: propState.map((st, i) => {
      let hitAt = -1;
      for (const e of events) if (e.k === 'hit' && e.o === 'prop' && e.oi === i) { hitAt = e.t; break; }
      return { hitAt, movedAt: st.movedAt };
    }),
    crashed: per.filter((p) => p.crashedAt >= 0).length,
    firstCrashTick: per.reduce((m, p) => (p.crashedAt >= 0 && (m < 0 || p.crashedAt < m) ? p.crashedAt : m), -1),
    propsMoved: propState.filter((s) => s.movedAt >= 0).length,
    anyFlip: per.some((p) => p.flipAt >= 0),
    anyWheel: per.some((p) => p.wheels > 0),
    anyGlass: per.some((p) => p.glass > 0),
    noCrash: per.every((p) => p.crashedAt < 0),
    restTick,
  };

  // ---- FNV-1a over the event stream: the determinism fingerprint ----
  let h = 0x811c9dc5 >>> 0;
  const mix = (v) => { h ^= (v | 0) >>> 0; h = Math.imul(h, 16777619) >>> 0; };
  for (const e of events) {
    mix(EV_CODE[e.k]); mix(e.t);
    mix(e.car === undefined ? -1 : e.car);
    mix(e.oi === undefined ? -1 : e.oi);
    mix(e.o === undefined ? -1 : OTHER_CODE[e.o] ?? 0);
    mix(e.dv === undefined ? 0 : Math.round(e.dv * 1000));
  }
  mix(restTick); mix(ticks);
  const hash = (h >>> 0).toString(16).padStart(8, '0');

  sim.dispose();
  return { events, summary, restTick, ticks, hash, tracks };
}
