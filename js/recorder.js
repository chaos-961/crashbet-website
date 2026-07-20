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

const EV_CODE = {
  hit: 1, glass: 2, wheel: 3, flip: 4, fire: 5, escape: 6, prop: 7, close: 8,
  offroad: 9, splash: 10, sunk: 11,
};
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
    offroadAt: -1, splashAt: -1, sunkAt: -1,
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
  // G4 water. These never fire on a scene without a basin, so the event hash
  // of every pre-G4 scenario is untouched.
  sim.onSplash = (car) => {
    const i = carIdx.get(car);
    if (per[i].splashAt >= 0) return; // first entry only — bobbing is not news
    per[i].splashAt = sim.tick;
    events.push({ k: 'splash', t: sim.tick, car: i });
  };
  sim.onSunk = (car) => {
    const i = carIdx.get(car);
    if (per[i].sunkAt >= 0) return;
    per[i].sunkAt = sim.tick;
    events.push({ k: 'sunk', t: sim.tick, car: i });
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
  // Rest is measured by DISPLACEMENT, not instantaneous velocity. Three
  // steady-state artifacts read as motion forever while the body sits still:
  // raycast suspension holds a constant +lv.y (~0.73), G4 buoyancy holds one
  // too (a wreck parked on the basin bed), and a stuck car under driver
  // control keeps yawing in place (av.y ~0.6). The old vmax test never
  // converged on any of them — 48 % of G4 scenes ran to the 2400-tick cap.
  // Position is immune: if nothing has MOVED for a sustained window and no
  // event has fired, the scene is genuinely over. Sampling aliasing is a
  // non-issue — jitter oscillates without displacing, which is the point.
  const restRef = new Map(); // body handle -> {x,y,z} reference position
  // The bar is derived, not tuned: 0.6 m of drift across the 75-tick (1.25 s)
  // window caps a body at <0.5 m/s, so no two bodies under it can close hard
  // enough to log a contact at all (TOUCH_DV is 1.4 m/s, and 0.5+0.5 < 1.4).
  // Below this speed the scene provably cannot produce another event.
  // It has to be this generous because cars decay asymptotically: an
  // `end:'coast'` car that reached the end of its path never fully stops,
  // it just creeps at 0.2–0.4 m/s forever, and a queue of them bunched at
  // the road end held ~25 % of G4 scenes open to the cap. Drift is summed
  // per-axis (Manhattan), which over-reads a diagonal, so the effective
  // speed bound is stricter than 0.5 — erring the safe way.
  const REST_EPS = 0.6;

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
            // squared compare, never Math.hypot: this feeds the event log and
            // therefore the hash, and hypot's last bits are not guaranteed
            // equal across JS engines (the same rule the water code follows)
            if (va.x * va.x + va.z * va.z > 9 || vb.x * vb.x + vb.z * vb.z > 9) {
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
    // Rest = every CAR and every piece of debris has stopped moving. Cars are
    // all that can still generate a settleable event, so gating on all of
    // them (not just the touched ones) is strictly safer than the old rule,
    // which ignored free traffic entirely and could cut a scene whose first
    // hit lands late — measured as late as T+1151 on switchback/overspeed.
    // Disturbed props are deliberately NOT gated: their markets latch on
    // first move, and a knocked cone or a tumbleweed rolls essentially
    // forever, which alone held whole rounds open to the 2400-tick cap.
    if (sim.tick > INCIDENT_TICK + 120 && sim.tick % 5 === 0) {
      let moved = 0;
      // drift of each body from its reference pose; the largest wins
      const scan = (body) => {
        const t = body.translation();
        const ref = restRef.get(body.handle);
        if (!ref) { restRef.set(body.handle, { x: t.x, y: t.y, z: t.z }); return; }
        const m = Math.abs(t.x - ref.x) + Math.abs(t.y - ref.y) + Math.abs(t.z - ref.z);
        if (m > moved) moved = m;
      };
      for (let i = 0; i < nCars; i++) {
        // A car the sim has declared SUNK is resolved: by its own test it is
        // past 0.9 m under and below 1.2 m/s, its markets have latched, and
        // it cannot reach anything else. Buoyancy is deliberately sub-neutral
        // so a wreck keeps settling toward the bed for a long time — gating
        // on that drift ran every causeway round to the 2400-tick cap.
        if (per[i].sunkAt >= 0) continue;
        scan(sim.cars[i].body);
      }
      for (const d of sim.debris) scan(d.body);
      const lastEv = events.length ? events[events.length - 1].t : 0;
      if (moved < REST_EPS && sim.tick - lastEv > 90) {
        restRun += 5;
        if (restRun >= 75) { restTick = sim.tick; break; }
      } else {
        // something moved: re-baseline every body so the window measures
        // drift over the LAST 75 ticks, not since the scene began
        restRun = 0;
        restRef.clear();
      }
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
      splashAt: p.splashAt, sunkAt: p.sunkAt,
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
