// markets.js — the market generator + odds engine v1 (game phase G2).
//
// generateMarkets(scene, opts) builds every bettable market for a dealt round
// FROM THE SCENE SPEC ALONE — it is outcome-blind BY CONSTRUCTION: this
// module must never import recorder.js or read an event log at generation
// time. The only inputs are the scenario (cars, paths, props, meta) plus a
// static calibration table measured offline over thousands of settled scenes
// (a bookmaker's historical priors — data about PAST rounds, never this one).
//
// settleMarket(market, rec) is the single source of settlement truth: a pure
// function of the market and the recorder's output. Settlement is the ONLY
// place the outcome is read.
//
// Money is integer-only everywhere: odds are decimal odds in integer
// hundredths (oddsH 250 = ×2.50), payouts are ⌊stake · oddsH / 100⌋ dollars.
import { clamp } from './lib.js';

export const ODDS_MIN = 110;   // ×1.10 — the spec's floor for singles
export const ODDS_MAX = 5000;  // ×50 — the spec's ceiling for singles
export const PARLAY_CAP = 50000; // ×500 combined

// house margin per difficulty: ~6 % baseline easing to ~2 % at d ≥ 8 —
// hard reads pay nearly fair (spec: "Money rules")
export function marginFor(d) {
  return d >= 8 ? 0.02 : Math.max(0.03, 0.06 - (d - 1) * 0.005);
}

function oddsFromP(p, d, floor = ODDS_MIN) {
  const fair = (1 - marginFor(d)) / clamp(p, 0.02, 0.985);
  return clamp(Math.round(fair * 100), floor, ODDS_MAX);
}
// don't offer near-certainties: a 97 % shot clipped to the ×1.10 floor pays
// the BETTOR ~+7 % EV per bet (the quick Monte Carlo found the leak — a dozen
// heavily-staked "the far lamp post survives" markets per scene). The
// headline pair is exempt (the spec requires both sides) and instead gets a
// lower ×1.03 floor so honest 90 %+ scenes stay house-positive.
const OFFER_MAX = 0.85;
const HEADLINE_FLOOR = 103;

/* ---------------- geometry helpers (scene-spec only) ---------------- */
// min distance between a point and a flat [x,z,...] polyline
function distToPts(pts, x, z) {
  let m = Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    const dx = pts[i] - x, dz = pts[i + 1] - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < m) m = d2;
  }
  return Math.sqrt(m);
}
// min distance between two polylines (sampled — plenty for role bucketing)
function pathDist(a, b) {
  let m = Infinity;
  for (let i = 0; i < a.length; i += 2) {
    const d = distToPts(b, a[i], a[i + 1]);
    if (d < m) m = d;
  }
  return m;
}

/* ---------------- calibration table ----------------
   Empirical hit rates measured by tools/calibrate.mjs over generated+settled
   scenes, keyed kind → template → role. Numbers are smoothed toward the kind
   default (Laplace-style) so thin cells never produce absurd odds. Regenerate
   after any director/physics change that moves outcome statistics — the
   Monte Carlo gate (tests/montecarlo.mjs) catches drift. */
// Empirical table from tools/calibrate.mjs (400 scenes, all difficulties,
// Laplace-smoothed toward each kind mean). Regenerate after director/physics
// changes that move outcome statistics; tests/montecarlo.mjs catches drift.
export const CALIB = {
  anyflip: {
    _: 0.007,
    blowout: {
      _: 0.001
    },
    brakefail: {
      _: 0.001
    },
    chain: {
      _: 0.028
    },
    drowsy: {
      _: 0.001
    },
    overspeed: {
      _: 0.003
    },
    police: {
      _: 0.001
    },
    pullout: {
      _: 0.001
    },
    redlight: {
      _: 0.042
    }
  },
  anyglass: {
    _: 0.24,
    blowout: {
      _: 0.172
    },
    brakefail: {
      _: 0.198
    },
    chain: {
      _: 0.659
    },
    drowsy: {
      _: 0.174
    },
    overspeed: {
      _: 0.111
    },
    police: {
      _: 0.057
    },
    pullout: {
      _: 0.143
    },
    redlight: {
      _: 0.378
    }
  },
  anywheel: {
    _: 0.152,
    blowout: {
      _: 0.08
    },
    brakefail: {
      _: 0.089
    },
    chain: {
      _: 0.457
    },
    drowsy: {
      _: 0.132
    },
    overspeed: {
      _: 0.07
    },
    police: {
      _: 0.05
    },
    pullout: {
      _: 0.108
    },
    redlight: {
      _: 0.157
    }
  },
  chain3: {
    _: 0.255,
    blowout: {
      _: 0.256
    },
    brakefail: {
      _: 0.238
    },
    chain: {
      _: 0.702
    },
    drowsy: {
      _: 0.259
    },
    overspeed: {
      _: 0.195
    },
    police: {
      _: 0.084
    },
    pullout: {
      _: 0.035
    },
    redlight: {
      _: 0.221
    }
  },
  crash: {
    _: 0.358,
    blowout: {
      _: 0.334,
      actor: 0.35,
      agg: 0.554,
      ambNear: 0.163,
      vic: 0.636
    },
    brakefail: {
      _: 0.423,
      actor: 0.55,
      agg: 0.745,
      ambNear: 0.138,
      vic: 0.835
    },
    chain: {
      _: 0.586,
      actor: 0.612,
      agg: 0.516,
      ambNear: 0.065,
      vic: 0.772
    },
    drowsy: {
      _: 0.372,
      actor: 0.394,
      agg: 0.669,
      ambNear: 0.181,
      vic: 0.636
    },
    overspeed: {
      _: 0.214,
      actor: 0.315,
      agg: 0.319,
      ambNear: 0.191
    },
    police: {
      _: 0.242,
      actor: 0.134,
      agg: 0.335,
      ambNear: 0.061,
      vic: 0.733
    },
    pullout: {
      _: 0.17,
      actor: 0.195,
      agg: 0.317,
      ambFar: 0.063,
      ambNear: 0.047,
      vic: 0.303
    },
    redlight: {
      _: 0.31,
      agg: 0.566,
      ambNear: 0.147,
      vic: 0.526
    }
  },
  fire: {
    _: 0.008,
    blowout: {
      _: 0,
      actor: 0.006,
      agg: 0.001,
      ambNear: 0,
      vic: 0.001
    },
    brakefail: {
      _: 0,
      actor: 0.004,
      agg: 0.001,
      ambNear: 0,
      vic: 0.001
    },
    chain: {
      _: 0.04,
      actor: 0.054,
      agg: 0.001,
      ambNear: 0.002,
      vic: 0.047
    },
    drowsy: {
      _: 0.004,
      actor: 0.006,
      agg: 0.001,
      ambNear: 0.006,
      vic: 0.001
    },
    overspeed: {
      _: 0.001,
      actor: 0.005,
      agg: 0.004,
      ambNear: 0.002
    },
    police: {
      _: 0,
      actor: 0.003,
      agg: 0.001,
      ambNear: 0,
      vic: 0.001
    },
    pullout: {
      _: 0.004,
      actor: 0.005,
      agg: 0.001,
      ambFar: 0.001,
      ambNear: 0.001,
      vic: 0.014
    },
    redlight: {
      _: 0,
      agg: 0.002,
      ambNear: 0.001,
      vic: 0.002
    }
  },
  first: {
    _: 0.247,
    blowout: {
      _: 0.243,
      actor: 0.276,
      agg: 0.52,
      ambNear: 0.057,
      vic: 0.52
    },
    brakefail: {
      _: 0.33,
      actor: 0.114,
      agg: 0.724,
      ambNear: 0.007,
      vic: 0.827
    },
    chain: {
      _: 0.251,
      actor: 0.078,
      agg: 0.465,
      ambNear: 0.045,
      vic: 0.715
    },
    drowsy: {
      _: 0.283,
      actor: 0.185,
      agg: 0.608,
      ambNear: 0.07,
      vic: 0.591
    },
    overspeed: {
      _: 0.197,
      actor: 0.248,
      agg: 0.268,
      ambNear: 0.166
    },
    police: {
      _: 0.214,
      actor: 0.093,
      agg: 0.314,
      ambNear: 0.024,
      vic: 0.711
    },
    pullout: {
      _: 0.157,
      actor: 0.135,
      agg: 0.308,
      ambFar: 0.036,
      ambNear: 0.032,
      vic: 0.281
    },
    redlight: {
      _: 0.229,
      agg: 0.539,
      ambNear: 0.036,
      vic: 0.459
    }
  },
  flip: {
    _: 0.002,
    blowout: {
      _: 0,
      actor: 0.001,
      agg: 0,
      ambNear: 0,
      vic: 0
    },
    brakefail: {
      _: 0,
      actor: 0.001,
      agg: 0,
      ambNear: 0,
      vic: 0
    },
    chain: {
      _: 0.008,
      actor: 0.013,
      agg: 0,
      ambNear: 0,
      vic: 0
    },
    drowsy: {
      _: 0,
      actor: 0.001,
      agg: 0,
      ambNear: 0,
      vic: 0
    },
    overspeed: {
      _: 0,
      actor: 0.001,
      agg: 0.001,
      ambNear: 0
    },
    police: {
      _: 0,
      actor: 0.001,
      agg: 0,
      ambNear: 0,
      vic: 0
    },
    pullout: {
      _: 0,
      actor: 0.001,
      agg: 0,
      ambFar: 0,
      ambNear: 0,
      vic: 0
    },
    redlight: {
      _: 0.009,
      agg: 0.04,
      ambNear: 0,
      vic: 0
    }
  },
  headline: {
    _: 0.8,
    blowout: {
      _: 0.792,
      nm: 0.527
    },
    brakefail: {
      _: 0.946,
      nm: 0.871
    },
    chain: {
      _: 0.914,
      nm: 0.677
    },
    drowsy: {
      _: 0.83,
      nm: 0.65
    },
    overspeed: {
      _: 0.6
    },
    police: {
      _: 0.805,
      nm: 0.929
    },
    pullout: {
      _: 0.545,
      nm: 0.4
    },
    redlight: {
      _: 0.792,
      nm: 0.48
    }
  },
  offroad: {
    _: 0.018,
    blowout: {
      _: 0.051,
      actor: 0.012,
      agg: 0.247,
      ambNear: 0.001,
      vic: 0.002
    },
    brakefail: {
      _: 0,
      actor: 0.008,
      agg: 0.001,
      ambNear: 0.001,
      vic: 0.001
    },
    chain: {
      _: 0,
      actor: 0,
      agg: 0.001,
      ambNear: 0.003,
      vic: 0.002
    },
    drowsy: {
      _: 0.007,
      actor: 0.013,
      agg: 0.035,
      ambNear: 0.001,
      vic: 0.002
    },
    overspeed: {
      _: 0.003,
      actor: 0.011,
      agg: 0.008,
      ambNear: 0.004
    },
    police: {
      _: 0.047,
      actor: 0.007,
      agg: 0.104,
      ambNear: 0,
      vic: 0.13
    },
    pullout: {
      _: 0,
      actor: 0.01,
      agg: 0.001,
      ambFar: 0.001,
      ambNear: 0.002,
      vic: 0.001
    },
    redlight: {
      _: 0.038,
      agg: 0.084,
      ambNear: 0.002,
      vic: 0.084
    }
  },
  over: {
    _: 0.565,
    blowout: {
      _: 0.681
    },
    brakefail: {
      _: 0.761
    },
    chain: {
      _: 0.714
    },
    drowsy: {
      _: 0.74
    },
    overspeed: {
      _: 0.415
    },
    police: {
      _: 0.402
    },
    pullout: {
      _: 0.17
    },
    redlight: {
      _: 0.616
    }
  },
  prophit: {
    _: 0.041,
    blowout: {
      _: 0.059,
      far: 0.028,
      mid: 0.241,
      near: 0.017
    },
    brakefail: {
      _: 0.03,
      far: 0.023,
      mid: 0.142,
      near: 0.003
    },
    chain: {
      _: 0.026,
      far: 0.015,
      mid: 0.071,
      near: 0.004
    },
    drowsy: {
      _: 0.048,
      far: 0.035,
      mid: 0.192,
      near: 0.011
    },
    overspeed: {
      _: 0.003,
      near: 0.003
    },
    police: {
      _: 0.038,
      far: 0.031,
      mid: 0.164,
      near: 0.007
    },
    pullout: {
      _: 0.043,
      far: 0.028,
      mid: 0.124,
      near: 0.001
    },
    redlight: {
      _: 0.118,
      mid: 0.203,
      near: 0.015
    }
  },
  propsafe: {
    _: 0.959,
    blowout: {
      _: 0.941,
      far: 0.972,
      mid: 0.759,
      near: 0.983
    },
    brakefail: {
      _: 0.97,
      far: 0.977,
      mid: 0.858,
      near: 0.997
    },
    chain: {
      _: 0.974,
      far: 0.985,
      mid: 0.929,
      near: 0.996
    },
    drowsy: {
      _: 0.952,
      far: 0.965,
      mid: 0.808,
      near: 0.989
    },
    overspeed: {
      _: 0.997,
      near: 0.997
    },
    police: {
      _: 0.962,
      far: 0.969,
      mid: 0.836,
      near: 0.993
    },
    pullout: {
      _: 0.957,
      far: 0.972,
      mid: 0.876,
      near: 0.999
    },
    redlight: {
      _: 0.882,
      mid: 0.797,
      near: 0.985
    }
  },
  special: {
    _: 0.775,
    blowout: {
      _: 0.707,
      nm: 0.423
    },
    brakefail: {
      _: 0.867,
      nm: 0.744
    },
    chain: {
      _: 0.745,
      nm: 0.435
    },
    drowsy: {
      _: 0.711,
      nm: 0.554
    },
    overspeed: {
      _: 0.358
    },
    police: {
      _: 0.765,
      nm: 0.921
    },
    pullout: {
      _: 0.886,
      nm: 0.568
    },
    redlight: {
      _: 0.786,
      nm: 0.465
    }
  },
  untouched: {
    _: 0.413,
    blowout: {
      _: 0.445,
      actor: 0.498,
      agg: 0.316,
      ambNear: 0.578,
      vic: 0.153
    },
    brakefail: {
      _: 0.333,
      actor: 0.191,
      agg: 0.045,
      ambNear: 0.566,
      vic: 0.032
    },
    chain: {
      _: 0.222,
      actor: 0.212,
      agg: 0.132,
      ambNear: 0.833,
      vic: 0.1
    },
    drowsy: {
      _: 0.408,
      actor: 0.435,
      agg: 0.175,
      ambNear: 0.531,
      vic: 0.275
    },
    overspeed: {
      _: 0.328,
      actor: 0.348,
      agg: 0.344,
      ambNear: 0.351
    },
    police: {
      _: 0.484,
      actor: 0.592,
      agg: 0.045,
      ambNear: 0.773,
      vic: 0.032
    },
    pullout: {
      _: 0.597,
      actor: 0.589,
      agg: 0.267,
      ambFar: 0.882,
      ambNear: 0.858,
      vic: 0.322
    },
    redlight: {
      _: 0.593,
      agg: 0.259,
      ambNear: 0.761,
      vic: 0.379
    }
  },
  wheel: {
    _: 0.04,
    blowout: {
      _: 0.014,
      actor: 0.027,
      agg: 0.046,
      ambNear: 0.002,
      vic: 0.025
    },
    brakefail: {
      _: 0.017,
      actor: 0.018,
      agg: 0.003,
      ambNear: 0.011,
      vic: 0.054
    },
    chain: {
      _: 0.131,
      actor: 0.148,
      agg: 0.031,
      ambNear: 0.007,
      vic: 0.219
    },
    drowsy: {
      _: 0.029,
      actor: 0.03,
      agg: 0.054,
      ambNear: 0.013,
      vic: 0.054
    },
    overspeed: {
      _: 0.006,
      actor: 0.024,
      agg: 0.018,
      ambNear: 0.009
    },
    police: {
      _: 0.008,
      actor: 0.015,
      agg: 0.003,
      ambNear: 0.001,
      vic: 0.042
    },
    pullout: {
      _: 0.033,
      actor: 0.022,
      agg: 0.085,
      ambFar: 0.013,
      ambNear: 0.005,
      vic: 0.031
    },
    redlight: {
      _: 0.03,
      agg: 0.09,
      ambNear: 0.003,
      vic: 0.05
    }
  }
};

function calib(kind, tpl, role) {
  const K = CALIB[kind];
  if (!K) return 0.3;
  const T = K[tpl];
  if (T === undefined || typeof T === 'number') {
    return (typeof K[role] === 'number' ? K[role] : undefined) ?? K._ ?? 0.3;
  }
  return T[role] ?? T._ ?? K._ ?? 0.3;
}

/* ---------------- market construction ---------------- */
// role of a car in the scene, from the SPEC alone: choreographed cars have
// cmd timelines; ambient cars are bucketed by how close their path runs to
// the aggressor's (the chaos epicentre)
function roleOf(scene, i, aggPts) {
  const meta = scene.meta;
  if (i === meta.aggressor) return 'agg';
  if (i === meta.victim) return 'vic';
  const c = scene.cars[i];
  if (c.drive && c.drive.cmds && c.drive.cmds.length) return 'actor';
  if (aggPts && c.drive && pathDist(c.drive.pts, aggPts) < 7) return 'ambNear';
  return 'ambFar';
}

// per-template special market: label + a settle spec the settler understands
function specialFor(scene) {
  const t = scene.meta.template;
  const agg = scene.meta.aggressor, vic = scene.meta.victim;
  const pair = agg >= 0 && vic >= 0;
  switch (t) {
    case 'redlight': return pair && { label: 'The runner T-bones its victim', settle: { hitPair: [agg, vic] } };
    case 'blowout': return pair && { label: 'The head-on lands', settle: { hitPair: [agg, vic] } };
    case 'drowsy': return pair && { label: 'The drift ends in contact', settle: { hitPair: [agg, vic] } };
    case 'police': return agg >= 0 && vic >= 0 && { label: 'The PIT sticks', settle: { carCrash: vic } };
    case 'pullout': return pair && { label: 'The pullout gets hit', settle: { hitPair: [agg, vic] } };
    case 'chain': return { label: 'Three or more crash', settle: { crashedGte: 3 } };
    case 'brakefail': return vic >= 0 && { label: 'The queue takes the hit', settle: { carCrash: vic } };
    case 'overspeed': return agg >= 0 && { label: 'It leaves the road', settle: { carOffroad: agg } };
    default: return null;
  }
}

// generateMarkets(scene, { labelOf }) → array of markets. Deterministic, no
// rng, outcome-blind. labelOf(typeId) supplies display names (REG labels in
// the app; type ids in headless tests).
export function generateMarkets(scene, opts = {}) {
  const labelOf = opts.labelOf || ((t) => t);
  const d = scene.meta.d;
  const tpl = scene.meta.template;
  const nearMissK = scene.meta.nearMiss ? 0.55 : 1;
  const markets = [];
  // `cal` is the calibration bucket (role/zone) — tools/calibrate.mjs
  // aggregates empirical hit rates by (kind, template, cal) with this tag,
  // so the harness measures exactly what the generator prices
  let _cal = '_';
  const add = (id, group, label, kind, p, settle) => {
    const head = kind === 'headline';
    // both tails are scams and neither is content: p > 0.85 clips at the odds
    // floor (bettor +EV), p < 1.5 % clips at the 2 % pricing floor (house
    // +90 % per bet on a market that essentially never hits)
    if (!head && (p > OFFER_MAX || p < 0.015)) return;
    const pc = clamp(p, 0.02, 0.985);
    markets.push({ id, group, label, kind, cal: _cal, p: pc, oddsH: oddsFromP(pc, d, head ? HEADLINE_FLOOR : ODDS_MIN), settle });
  };

  const aggIdx = scene.meta.aggressor;
  const aggPts = aggIdx >= 0 && scene.cars[aggIdx].drive ? scene.cars[aggIdx].drive.pts : null;

  // headline pair (the no-crash side is the exact complement)
  _cal = scene.meta.nearMiss ? 'nm' : '_';
  const pCrash = clamp(calib('headline', tpl, _cal), 0.05, 0.97);
  add('h.crash', 'headline', 'A crash happens', 'headline', pCrash, { anyCrash: true });
  add('h.nocrash', 'headline', 'No crash — everyone walks', 'headline', 1 - pCrash, { anyCrash: false });

  // per-vehicle markets — everything straight from the calibrated table
  // (the buckets ARE the pricing model). Rare-event markets are only offered
  // where they actually happen: a "flips" line at the 2 % floor when the true
  // rate is 0.2 % is a permanent scam, and dead markets are bad content.
  const OFFER_MIN = 0.015;
  const pCarCrash = [];
  for (let i = 0; i < scene.cars.length; i++) {
    const role = roleOf(scene, i, aggPts);
    _cal = role;
    const name = labelOf(scene.cars[i].type);
    const pc = clamp(calib('crash', tpl, role) * (role === 'agg' || role === 'vic' ? nearMissK : 1), 0.02, 0.95);
    pCarCrash.push(pc);
    add(`c${i}.crash`, `car:${i}`, `${name} crashes`, 'crash', pc, { carCrash: i });
    add(`c${i}.safe`, `car:${i}`, `${name} survives untouched`, 'untouched', calib('untouched', tpl, role), { carUntouched: i });
    const pFlip = calib('flip', tpl, role);
    if (pFlip >= OFFER_MIN) add(`c${i}.flip`, `car:${i}`, `${name} flips`, 'flip', pFlip, { carFlip: i });
    const pWheel = calib('wheel', tpl, role);
    if (pWheel >= OFFER_MIN) add(`c${i}.wheel`, `car:${i}`, `${name} loses a wheel`, 'wheel', pWheel, { carWheel: i });
    const pFire = calib('fire', tpl, role);
    if (pFire >= OFFER_MIN) add(`c${i}.fire`, `car:${i}`, `${name} catches fire`, 'fire', pFire, { carFire: i });
    const pOff = calib('offroad', tpl, role);
    if (pOff >= OFFER_MIN) add(`c${i}.offroad`, `car:${i}`, `${name} leaves the road`, 'offroad', pOff, { carOffroad: i });
    const pFirst = calib('first', tpl, role);
    if (pFirst >= OFFER_MIN) add(`c${i}.first`, `car:${i}`, `${name} crashes first`, 'first', pFirst, { carFirst: i });
  }

  // prop markets — only objects near enough to the action to be live bets
  // (everything is still targetable in the G3 UI; far props just are not
  // worth listing at ×50). Nearest ~12 by distance to any car path.
  const carPts = scene.cars.map((c) => (c.drive ? c.drive.pts : null)).filter(Boolean);
  const propD = scene.props.map((p, i) => {
    if (p.kind === 'asphalt_patch') return { i, d: Infinity };
    let m = Infinity;
    for (const pts of carPts) m = Math.min(m, distToPts(pts, p.x, p.z));
    return { i, d: m };
  }).filter((e) => e.d < 26).sort((a, b) => a.d - b.d).slice(0, 12);
  for (const { i, d: dist } of propD) {
    const p = scene.props[i];
    const zone = dist < 6 ? 'near' : dist < 14 ? 'mid' : 'far';
    _cal = zone;
    const name = p.kind.replace(/_/g, ' ');
    // "gets hit" = any contact, including a light prop knocked flying with a
    // Δv too small to log a hit on the CAR (the moved test catches those)
    const ph = calib('prophit', tpl, zone);
    add(`p${i}.hit`, `prop:${i}`, `The ${name} gets hit`, 'prophit', ph, { propHit: i });
    add(`p${i}.safe`, `prop:${i}`, `The ${name} survives`, 'propsafe', calib('propsafe', tpl, zone), { propSafe: i });
  }

  // scene-wide
  _cal = '_';
  const mu = pCarCrash.reduce((a, b) => a + b, 0);
  const line = Math.max(1.5, Math.round(mu) - 0.5);
  const pOver = calib('over', tpl, '_');
  add('s.over', 'scene', `Over ${line} vehicles crash`, 'over', pOver, { crashedOver: line });
  add('s.under', 'scene', `Under ${line} vehicles crash`, 'under', 1 - pOver, { crashedUnder: line });
  add('s.glass', 'scene', 'Glass shatters', 'anyglass', calib('anyglass', tpl, '_'), { anyGlass: true });
  const pAF = calib('anyflip', tpl, '_');
  if (pAF >= 0.015) add('s.flip', 'scene', 'Somebody flips', 'anyflip', pAF, { anyFlip: true });
  add('s.wheel', 'scene', 'A wheel comes off', 'anywheel', calib('anywheel', tpl, '_'), { anyWheel: true });
  add('s.chain3', 'scene', 'Chain of 3 or more', 'chain3', calib('chain3', tpl, '_'), { crashedGte: 3 });

  // template special (near-miss scenes get their own calibration bucket)
  _cal = scene.meta.nearMiss ? 'nm' : '_';
  const sp = specialFor(scene);
  if (sp) add('x.special', 'special', sp.label, 'special', calib('special', tpl, _cal), sp.settle);

  return markets;
}

/* ---------------- settlement (the ONLY outcome reader) ---------------- */
export function settleMarket(m, rec) {
  const s = m.settle, sum = rec.summary;
  if (s.anyCrash !== undefined) return s.anyCrash ? !sum.noCrash : sum.noCrash;
  if (s.carCrash !== undefined) return sum.perCar[s.carCrash].crashedAt >= 0;
  if (s.carUntouched !== undefined) return !sum.perCar[s.carUntouched].touched;
  if (s.carFlip !== undefined) return sum.perCar[s.carFlip].flipAt >= 0;
  if (s.carWheel !== undefined) return sum.perCar[s.carWheel].wheels > 0;
  if (s.carFire !== undefined) return sum.perCar[s.carFire].fireAt >= 0;
  if (s.carOffroad !== undefined) return sum.perCar[s.carOffroad].offroadAt >= 0;
  if (s.carFirst !== undefined) {
    const p = sum.perCar[s.carFirst];
    return sum.firstCrashTick >= 0 && p.crashedAt === sum.firstCrashTick;
  }
  if (s.propHit !== undefined) {
    const p = sum.perProp[s.propHit];
    return p.hitAt >= 0 || p.movedAt >= 0; // moved counts: light props take hits the car's Δv log never sees
  }
  if (s.propTop !== undefined) return sum.perProp[s.propTop].movedAt >= 0;
  if (s.propSafe !== undefined) {
    const p = sum.perProp[s.propSafe];
    return p.hitAt < 0 && p.movedAt < 0;
  }
  if (s.crashedGte !== undefined) return sum.crashed >= s.crashedGte;
  if (s.crashedOver !== undefined) return sum.crashed > s.crashedOver;
  if (s.crashedUnder !== undefined) return sum.crashed < s.crashedUnder;
  if (s.anyGlass !== undefined) return sum.anyGlass;
  if (s.anyFlip !== undefined) return sum.anyFlip;
  if (s.anyWheel !== undefined) return sum.anyWheel;
  if (s.hitPair !== undefined) {
    const [a, b] = s.hitPair;
    for (const e of rec.events) {
      if (e.k !== 'hit' || e.o !== 'car') continue;
      if ((e.car === a && e.oi === b) || (e.car === b && e.oi === a)) return true;
    }
    return false;
  }
  return false;
}
