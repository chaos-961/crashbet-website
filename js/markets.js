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
// and don't offer never-happens either: a market clipped to the 2 % pricing
// floor when the true rate is 0.2 % is a permanent scam, and a dead market is
// bad content besides. Module scope so generateMarkets' `add` can read it
// before the per-scene body runs (the headline pair is added first).
const OFFER_MIN = 0.015;
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
// Empirical table from tools/calibrate.mjs, Laplace-smoothed toward each kind
// mean. Regenerate after any director/physics change that moves outcome
// statistics; tests/montecarlo.mjs catches drift.
// Regenerated at the P2 close gate over 900 scenes: 2E took the world to 22
// topologies and 2F the incident library to 28 templates, so the G4 table left
// a third of the templates (rockslide/fallentree/overheight/… ) priced off a
// bare kind mean. Out-of-sample O/E after this regen sat at 0.98/0.96/0.99
// across the three difficulty bands, all intervals containing 1.00 — so NO
// difficulty axis was added (the rule in the note below still holds).
export const CALIB = {
  anyflip: {
    _: 0.05,
    barrierdrop: {
      _: 0.012
    },
    blowout: {
      _: 0.06
    },
    brakefail: {
      _: 0.005
    },
    chain: {
      _: 0.047
    },
    debris: {
      _: 0.05
    },
    drowsy: {
      _: 0.073
    },
    fallentree: {
      _: 0.215
    },
    flooddip: {
      _: 0.076
    },
    fogbank: {
      _: 0.009
    },
    jackknife: {
      _: 0.042
    },
    leftturn: {
      _: 0.018
    },
    loadspill: {
      _: 0.048
    },
    lowgrip: {
      _: 0.011
    },
    merge: {
      _: 0.009
    },
    overheight: {
      _: 0.081
    },
    overspeed: {
      _: 0.177
    },
    pit: {
      _: 0.013
    },
    police: {
      _: 0.082
    },
    pullout: {
      _: 0.024
    },
    rampjump: {
      _: 0.021
    },
    redlight: {
      _: 0.065
    },
    rockslide: {
      _: 0.087
    },
    rollover: {
      _: 0.057
    },
    stall: {
      _: 0.005
    },
    sunblind: {
      _: 0.033
    },
    tailgate: {
      _: 0.007
    },
    wideload: {
      _: 0.013
    },
    wrongway: {
      _: 0.17
    }
  },
  anyglass: {
    _: 0.177,
    barrierdrop: {
      _: 0.082
    },
    blowout: {
      _: 0.126
    },
    brakefail: {
      _: 0.106
    },
    chain: {
      _: 0.512
    },
    debris: {
      _: 0.175
    },
    drowsy: {
      _: 0.175
    },
    fallentree: {
      _: 0.353
    },
    flooddip: {
      _: 0.18
    },
    fogbank: {
      _: 0.033
    },
    jackknife: {
      _: 0.163
    },
    leftturn: {
      _: 0.18
    },
    loadspill: {
      _: 0.187
    },
    lowgrip: {
      _: 0.181
    },
    merge: {
      _: 0.03
    },
    overheight: {
      _: 0.379
    },
    overspeed: {
      _: 0.235
    },
    pit: {
      _: 0.177
    },
    police: {
      _: 0.147
    },
    pullout: {
      _: 0.11
    },
    rampjump: {
      _: 0.076
    },
    redlight: {
      _: 0.253
    },
    rockslide: {
      _: 0.271
    },
    rollover: {
      _: 0.133
    },
    stall: {
      _: 0.048
    },
    sunblind: {
      _: 0.078
    },
    tailgate: {
      _: 0.023
    },
    wideload: {
      _: 0.263
    },
    wrongway: {
      _: 0.28
    }
  },
  anywheel: {
    _: 0.117,
    barrierdrop: {
      _: 0.028
    },
    blowout: {
      _: 0.149
    },
    brakefail: {
      _: 0.047
    },
    chain: {
      _: 0.301
    },
    debris: {
      _: 0.102
    },
    drowsy: {
      _: 0.217
    },
    fallentree: {
      _: 0.235
    },
    flooddip: {
      _: 0.1
    },
    fogbank: {
      _: 0.022
    },
    jackknife: {
      _: 0.119
    },
    leftturn: {
      _: 0.1
    },
    loadspill: {
      _: 0.137
    },
    lowgrip: {
      _: 0.096
    },
    merge: {
      _: 0.02
    },
    overheight: {
      _: 0.106
    },
    overspeed: {
      _: 0.131
    },
    pit: {
      _: 0.117
    },
    police: {
      _: 0.053
    },
    pullout: {
      _: 0.067
    },
    rampjump: {
      _: 0.05
    },
    redlight: {
      _: 0.135
    },
    rockslide: {
      _: 0.18
    },
    rollover: {
      _: 0.074
    },
    stall: {
      _: 0.027
    },
    sunblind: {
      _: 0.018
    },
    tailgate: {
      _: 0.015
    },
    wideload: {
      _: 0.161
    },
    wrongway: {
      _: 0.249
    }
  },
  chain3: {
    _: 0.242,
    barrierdrop: {
      _: 0.098
    },
    blowout: {
      _: 0.312
    },
    brakefail: {
      _: 0.166
    },
    chain: {
      _: 0.559
    },
    debris: {
      _: 0.249
    },
    drowsy: {
      _: 0.342
    },
    fallentree: {
      _: 0.523
    },
    flooddip: {
      _: 0.203
    },
    fogbank: {
      _: 0.045
    },
    jackknife: {
      _: 0.079
    },
    leftturn: {
      _: 0.262
    },
    loadspill: {
      _: 0.202
    },
    lowgrip: {
      _: 0.052
    },
    merge: {
      _: 0.07
    },
    overheight: {
      _: 0.278
    },
    overspeed: {
      _: 0.189
    },
    pit: {
      _: 0.063
    },
    police: {
      _: 0.219
    },
    pullout: {
      _: 0.172
    },
    rampjump: {
      _: 0.104
    },
    redlight: {
      _: 0.223
    },
    rockslide: {
      _: 0.364
    },
    rollover: {
      _: 0.107
    },
    stall: {
      _: 0.163
    },
    sunblind: {
      _: 0.294
    },
    tailgate: {
      _: 0.032
    },
    wideload: {
      _: 0.281
    },
    wrongway: {
      _: 0.452
    }
  },
  crash: {
    _: 0.297,
    barrierdrop: {
      _: 0.093,
      agg: 0.071,
      ambFar: 0.163,
      ambNear: 0.138,
      vic: 0.071
    },
    blowout: {
      _: 0.396,
      actor: 0.278,
      agg: 0.705,
      ambFar: 0.278,
      ambNear: 0.209,
      vic: 0.705
    },
    brakefail: {
      _: 0.287,
      actor: 0.266,
      agg: 0.558,
      ambFar: 0.049,
      ambNear: 0.111,
      vic: 0.645
    },
    chain: {
      _: 0.429,
      actor: 0.501,
      agg: 0.4,
      ambFar: 0.148,
      ambNear: 0.073,
      vic: 0.574
    },
    debris: {
      _: 0.319,
      actor: 0.315,
      agg: 0.452,
      ambFar: 0.347,
      ambNear: 0.203,
      vic: 0.517
    },
    drowsy: {
      _: 0.381,
      actor: 0.291,
      agg: 0.683,
      ambFar: 0.186,
      ambNear: 0.209,
      vic: 0.683
    },
    fallentree: {
      _: 0.509,
      actor: 0.347,
      agg: 0.739,
      ambFar: 0.254,
      ambNear: 0.279,
      vic: 0.789
    },
    flooddip: {
      _: 0.271,
      actor: 0.222,
      agg: 0.458,
      ambNear: 0.178,
      vic: 0.34
    },
    fogbank: {
      _: 0.07,
      actor: 0.067,
      agg: 0.056,
      ambNear: 0.116,
      vic: 0.118
    },
    jackknife: {
      _: 0.166,
      actor: 0.178,
      agg: 0.154,
      ambNear: 0.222,
      vic: 0.09
    },
    leftturn: {
      _: 0.247,
      agg: 0.399,
      ambNear: 0.2,
      vic: 0.281
    },
    loadspill: {
      _: 0.203,
      actor: 0.344,
      agg: 0.103,
      ambNear: 0.185,
      vic: 0.362
    },
    lowgrip: {
      _: 0.102,
      actor: 0.278,
      agg: 0.064,
      ambNear: 0.153,
      vic: 0.064
    },
    merge: {
      _: 0.116,
      actor: 0.162,
      agg: 0.137,
      ambFar: 0.061,
      ambNear: 0.158,
      vic: 0.149
    },
    overheight: {
      _: 0.346,
      actor: 0.397,
      agg: 0.174,
      ambNear: 0.376,
      vic: 0.361
    },
    overspeed: {
      _: 0.315,
      agg: 0.214,
      ambNear: 0.366
    },
    pit: {
      _: 0.165,
      actor: 0.478,
      agg: 0.077,
      ambFar: 0.094,
      ambNear: 0.25,
      vic: 0.077
    },
    police: {
      _: 0.29,
      actor: 0.338,
      agg: 0.245,
      ambFar: 0.229,
      ambNear: 0.185,
      vic: 0.705
    },
    pullout: {
      _: 0.265,
      actor: 0.299,
      agg: 0.414,
      ambFar: 0.214,
      ambNear: 0.133,
      vic: 0.323
    },
    rampjump: {
      _: 0.134,
      agg: 0.199,
      ambFar: 0.127,
      ambNear: 0.177
    },
    redlight: {
      _: 0.338,
      agg: 0.639,
      ambFar: 0.254,
      ambNear: 0.166,
      vic: 0.539
    },
    rockslide: {
      _: 0.425,
      actor: 0.347,
      agg: 0.652,
      ambFar: 0.397,
      ambNear: 0.194,
      vic: 0.585
    },
    rollover: {
      _: 0.25,
      actor: 0.232,
      agg: 0.338,
      ambNear: 0.219
    },
    stall: {
      _: 0.279,
      actor: 0.222,
      agg: 0.403,
      ambFar: 0.171,
      ambNear: 0.21,
      vic: 0.387
    },
    sunblind: {
      _: 0.401,
      actor: 0.398,
      agg: 0.84,
      ambNear: 0.135,
      vic: 0.712
    },
    tailgate: {
      _: 0.062,
      actor: 0.232,
      ambFar: 0.073,
      vic: 0.039
    },
    wideload: {
      _: 0.395,
      actor: 0.397,
      agg: 0.121,
      ambNear: 0.475,
      vic: 0.425
    },
    wrongway: {
      _: 0.437,
      actor: 0.472,
      agg: 0.576,
      ambNear: 0.302,
      vic: 0.623
    }
  },
  fire: {
    _: 0.006,
    barrierdrop: {
      _: 0,
      agg: 0.001,
      ambFar: 0.002,
      ambNear: 0,
      vic: 0.001
    },
    blowout: {
      _: 0.003,
      actor: 0.003,
      agg: 0,
      ambFar: 0.003,
      ambNear: 0.004,
      vic: 0
    },
    brakefail: {
      _: 0,
      actor: 0.002,
      agg: 0.001,
      ambFar: 0.001,
      ambNear: 0,
      vic: 0.001
    },
    chain: {
      _: 0.022,
      actor: 0.038,
      agg: 0,
      ambFar: 0.003,
      ambNear: 0,
      vic: 0.011
    },
    debris: {
      _: 0,
      actor: 0.003,
      agg: 0.001,
      ambFar: 0.004,
      ambNear: 0,
      vic: 0.001
    },
    drowsy: {
      _: 0.007,
      actor: 0.003,
      agg: 0.012,
      ambFar: 0.001,
      ambNear: 0.007,
      vic: 0
    },
    fallentree: {
      _: 0.024,
      actor: 0.004,
      agg: 0.052,
      ambFar: 0.005,
      ambNear: 0.019,
      vic: 0.002
    },
    flooddip: {
      _: 0.001,
      actor: 0.004,
      agg: 0.002,
      ambNear: 0.001,
      vic: 0.002
    },
    fogbank: {
      _: 0,
      actor: 0.001,
      agg: 0.001,
      ambNear: 0,
      vic: 0.001
    },
    jackknife: {
      _: 0.014,
      actor: 0.003,
      agg: 0.001,
      ambNear: 0.012,
      vic: 0.033
    },
    leftturn: {
      _: 0,
      agg: 0.002,
      ambNear: 0.001,
      vic: 0.002
    },
    loadspill: {
      _: 0,
      actor: 0.003,
      agg: 0.001,
      ambNear: 0,
      vic: 0.001
    },
    lowgrip: {
      _: 0,
      actor: 0.003,
      agg: 0.001,
      ambNear: 0,
      vic: 0.001
    },
    merge: {
      _: 0,
      actor: 0.003,
      agg: 0.001,
      ambFar: 0.001,
      ambNear: 0,
      vic: 0.001
    },
    overheight: {
      _: 0.001,
      actor: 0.005,
      agg: 0.002,
      ambNear: 0.001,
      vic: 0.002
    },
    overspeed: {
      _: 0.001,
      agg: 0.003,
      ambNear: 0.001
    },
    pit: {
      _: 0,
      actor: 0.003,
      agg: 0.001,
      ambFar: 0.002,
      ambNear: 0.001,
      vic: 0.001
    },
    police: {
      _: 0.002,
      actor: 0.001,
      agg: 0,
      ambFar: 0.001,
      ambNear: 0.003,
      vic: 0
    },
    pullout: {
      _: 0.008,
      actor: 0.002,
      agg: 0.001,
      ambFar: 0.016,
      ambNear: 0.001,
      vic: 0.001
    },
    rampjump: {
      _: 0.001,
      agg: 0.002,
      ambFar: 0.002,
      ambNear: 0.001
    },
    redlight: {
      _: 0.012,
      agg: 0.052,
      ambFar: 0.005,
      ambNear: 0.001,
      vic: 0.002
    },
    rockslide: {
      _: 0.018,
      actor: 0.004,
      agg: 0.002,
      ambFar: 0.148,
      ambNear: 0.001,
      vic: 0.002
    },
    rollover: {
      _: 0.001,
      actor: 0.003,
      agg: 0.001,
      ambNear: 0.001
    },
    stall: {
      _: 0,
      actor: 0.002,
      agg: 0.001,
      ambFar: 0.001,
      ambNear: 0,
      vic: 0.001
    },
    sunblind: {
      _: 0,
      actor: 0.003,
      agg: 0.001,
      ambNear: 0,
      vic: 0.001
    },
    tailgate: {
      _: 0,
      actor: 0.003,
      ambFar: 0,
      vic: 0.001
    },
    wideload: {
      _: 0,
      actor: 0.005,
      agg: 0.001,
      ambNear: 0.001,
      vic: 0.001
    },
    wrongway: {
      _: 0.01,
      actor: 0.004,
      agg: 0.024,
      ambNear: 0.008,
      vic: 0.001
    }
  },
  first: {
    _: 0.185,
    barrierdrop: {
      _: 0.072,
      agg: 0.044,
      ambFar: 0.124,
      ambNear: 0.104,
      vic: 0.044
    },
    blowout: {
      _: 0.265,
      actor: 0.111,
      agg: 0.696,
      ambFar: 0.111,
      ambNear: 0.034,
      vic: 0.613
    },
    brakefail: {
      _: 0.224,
      actor: 0.062,
      agg: 0.546,
      ambFar: 0.031,
      ambNear: 0.007,
      vic: 0.634
    },
    chain: {
      _: 0.182,
      actor: 0.079,
      agg: 0.382,
      ambFar: 0.093,
      ambNear: 0.023,
      vic: 0.512
    },
    debris: {
      _: 0.187,
      actor: 0.093,
      agg: 0.437,
      ambFar: 0.139,
      ambNear: 0.059,
      vic: 0.35
    },
    drowsy: {
      _: 0.261,
      actor: 0.162,
      agg: 0.629,
      ambFar: 0.036,
      ambNear: 0.045,
      vic: 0.652
    },
    fallentree: {
      _: 0.192,
      actor: 0.139,
      agg: 0.706,
      ambFar: 0.159,
      ambNear: 0.021,
      vic: 0.156
    },
    flooddip: {
      _: 0.179,
      actor: 0.139,
      agg: 0.418,
      ambNear: 0.082,
      vic: 0.183
    },
    fogbank: {
      _: 0.066,
      actor: 0.056,
      agg: 0.035,
      ambNear: 0.106,
      vic: 0.097
    },
    jackknife: {
      _: 0.106,
      actor: 0.111,
      agg: 0.133,
      ambNear: 0.136,
      vic: 0.036
    },
    leftturn: {
      _: 0.159,
      agg: 0.359,
      ambNear: 0.113,
      vic: 0.124
    },
    loadspill: {
      _: 0.143,
      actor: 0.192,
      agg: 0.078,
      ambNear: 0.101,
      vic: 0.337
    },
    lowgrip: {
      _: 0.081,
      actor: 0.211,
      agg: 0.04,
      ambNear: 0.118,
      vic: 0.04
    },
    merge: {
      _: 0.071,
      actor: 0.101,
      agg: 0.117,
      ambFar: 0.038,
      ambNear: 0.105,
      vic: 0.035
    },
    overheight: {
      _: 0.192,
      actor: 0.159,
      agg: 0.069,
      ambNear: 0.193,
      vic: 0.319
    },
    overspeed: {
      _: 0.197,
      agg: 0.085,
      ambNear: 0.255
    },
    pit: {
      _: 0.133,
      actor: 0.411,
      agg: 0.048,
      ambFar: 0.058,
      ambNear: 0.192,
      vic: 0.048
    },
    police: {
      _: 0.178,
      actor: 0.048,
      agg: 0.226,
      ambFar: 0.062,
      ambNear: 0.033,
      vic: 0.698
    },
    pullout: {
      _: 0.183,
      actor: 0.194,
      agg: 0.402,
      ambFar: 0.073,
      ambNear: 0.031,
      vic: 0.311
    },
    rampjump: {
      _: 0.096,
      agg: 0.151,
      ambFar: 0.079,
      ambNear: 0.115
    },
    redlight: {
      _: 0.263,
      agg: 0.606,
      ambFar: 0.159,
      ambNear: 0.053,
      vic: 0.506
    },
    rockslide: {
      _: 0.234,
      actor: 0.139,
      agg: 0.607,
      ambFar: 0.159,
      ambNear: 0.032,
      vic: 0.341
    },
    rollover: {
      _: 0.192,
      actor: 0.176,
      agg: 0.309,
      ambNear: 0.128
    },
    stall: {
      _: 0.18,
      actor: 0.124,
      agg: 0.392,
      ambFar: 0.111,
      ambNear: 0.027,
      vic: 0.377
    },
    sunblind: {
      _: 0.307,
      actor: 0.093,
      agg: 0.823,
      ambNear: 0.009,
      vic: 0.695
    },
    tailgate: {
      _: 0.059,
      actor: 0.176,
      ambFar: 0.069,
      vic: 0.024
    },
    wideload: {
      _: 0.254,
      actor: 0.159,
      agg: 0.092,
      ambNear: 0.315,
      vic: 0.266
    },
    wrongway: {
      _: 0.244,
      actor: 0.264,
      agg: 0.561,
      ambNear: 0.057,
      vic: 0.444
    }
  },
  flip: {
    _: 0.018,
    barrierdrop: {
      _: 0.001,
      agg: 0.004,
      ambFar: 0.006,
      ambNear: 0.001,
      vic: 0.004
    },
    blowout: {
      _: 0.024,
      actor: 0.011,
      agg: 0.001,
      ambFar: 0.011,
      ambNear: 0.038,
      vic: 0.001
    },
    brakefail: {
      _: 0,
      actor: 0.006,
      agg: 0.002,
      ambFar: 0.003,
      ambNear: 0.001,
      vic: 0.002
    },
    chain: {
      _: 0.009,
      actor: 0.007,
      agg: 0.012,
      ambFar: 0.009,
      ambNear: 0.012,
      vic: 0.012
    },
    debris: {
      _: 0.018,
      actor: 0.009,
      agg: 0.002,
      ambFar: 0.138,
      ambNear: 0.023,
      vic: 0.002
    },
    drowsy: {
      _: 0.026,
      actor: 0.008,
      agg: 0.048,
      ambFar: 0.003,
      ambNear: 0.03,
      vic: 0.001
    },
    fallentree: {
      _: 0.096,
      actor: 0.138,
      agg: 0.005,
      ambFar: 0.015,
      ambNear: 0.134,
      vic: 0.005
    },
    flooddip: {
      _: 0.018,
      actor: 0.013,
      agg: 0.006,
      ambNear: 0.003,
      vic: 0.065
    },
    fogbank: {
      _: 0.001,
      actor: 0.002,
      agg: 0.003,
      ambNear: 0.002,
      vic: 0.003
    },
    jackknife: {
      _: 0.008,
      actor: 0.011,
      agg: 0.036,
      ambNear: 0.001,
      vic: 0.003
    },
    leftturn: {
      _: 0.001,
      agg: 0.006,
      ambNear: 0.002,
      vic: 0.006
    },
    loadspill: {
      _: 0.009,
      actor: 0.01,
      agg: 0.041,
      ambNear: 0.001,
      vic: 0.004
    },
    lowgrip: {
      _: 0.001,
      actor: 0.011,
      agg: 0.004,
      ambNear: 0.001,
      vic: 0.004
    },
    merge: {
      _: 0.001,
      actor: 0.01,
      agg: 0.003,
      ambFar: 0.004,
      ambNear: 0.001,
      vic: 0.003
    },
    overheight: {
      _: 0.018,
      actor: 0.015,
      agg: 0.069,
      ambNear: 0.003,
      vic: 0.007
    },
    overspeed: {
      _: 0.132,
      agg: 0.085,
      ambNear: 0.129
    },
    pit: {
      _: 0.001,
      actor: 0.011,
      agg: 0.005,
      ambFar: 0.006,
      ambNear: 0.002,
      vic: 0.005
    },
    police: {
      _: 0.031,
      actor: 0.048,
      agg: 0.012,
      ambFar: 0.121,
      ambNear: 0.033,
      vic: 0.001
    },
    pullout: {
      _: 0.004,
      actor: 0.007,
      agg: 0.002,
      ambFar: 0.009,
      ambNear: 0.003,
      vic: 0.002
    },
    rampjump: {
      _: 0.002,
      agg: 0.008,
      ambFar: 0.008,
      ambNear: 0.004
    },
    redlight: {
      _: 0.013,
      agg: 0.055,
      ambFar: 0.015,
      ambNear: 0.002,
      vic: 0.005
    },
    rockslide: {
      _: 0.055,
      actor: 0.013,
      agg: 0.007,
      ambFar: 0.158,
      ambNear: 0.06,
      vic: 0.007
    },
    rollover: {
      _: 0.049,
      actor: 0.009,
      agg: 0.005,
      ambNear: 0.078
    },
    stall: {
      _: 0,
      actor: 0.006,
      agg: 0.002,
      ambFar: 0.004,
      ambNear: 0.001,
      vic: 0.002
    },
    sunblind: {
      _: 0.006,
      actor: 0.009,
      agg: 0.003,
      ambNear: 0.009,
      vic: 0.003
    },
    tailgate: {
      _: 0.001,
      actor: 0.009,
      ambFar: 0.001,
      vic: 0.002
    },
    wideload: {
      _: 0.001,
      actor: 0.015,
      agg: 0.005,
      ambNear: 0.002,
      vic: 0.005
    },
    wrongway: {
      _: 0.09,
      actor: 0.013,
      agg: 0.026,
      ambNear: 0.113,
      vic: 0.072
    }
  },
  headline: {
    _: 0.761,
    barrierdrop: {
      _: 0.503,
      nm: 0.657
    },
    blowout: {
      _: 0.897,
      nm: 0.736
    },
    brakefail: {
      _: 0.887,
      nm: 0.857
    },
    chain: {
      _: 0.876,
      nm: 0.809
    },
    debris: {
      _: 0.817,
      nm: 0.779
    },
    drowsy: {
      _: 0.879,
      nm: 0.714
    },
    fallentree: {
      _: 0.928,
      nm: 0.795
    },
    flooddip: {
      _: 0.739,
      nm: 0.652
    },
    fogbank: {
      _: 0.424,
      nm: 0.619
    },
    jackknife: {
      _: 0.567,
      nm: 0.54
    },
    leftturn: {
      _: 0.798,
      nm: 0.795
    },
    loadspill: {
      _: 0.688,
      nm: 0.73
    },
    lowgrip: {
      _: 0.449,
      nm: 0.841
    },
    merge: {
      _: 0.445,
      nm: 0.696
    },
    overheight: {
      _: 0.848,
      nm: 0.795
    },
    overspeed: {
      _: 0.659
    },
    pit: {
      _: 0.677,
      nm: 0.795
    },
    police: {
      _: 0.849,
      nm: 0.848
    },
    pullout: {
      _: 0.792,
      nm: 0.798
    },
    rampjump: {
      _: 0.54
    },
    redlight: {
      _: 0.928,
      nm: 0.821
    },
    rockslide: {
      _: 0.904
    },
    rollover: {
      _: 0.677
    },
    stall: {
      _: 0.759,
      nm: 0.881
    },
    sunblind: {
      _: 0.963,
      nm: 0.857
    },
    tailgate: {
      _: 0.338,
      nm: 0.619
    },
    wideload: {
      _: 0.851,
      nm: 0.821
    },
    wrongway: {
      _: 0.827,
      nm: 0.898
    }
  },
  offroad: {
    _: 0.071,
    barrierdrop: {
      _: 0.003,
      agg: 0.017,
      ambFar: 0.025,
      ambNear: 0.005,
      vic: 0.017
    },
    blowout: {
      _: 0.083,
      actor: 0.043,
      agg: 0.145,
      ambFar: 0.043,
      ambNear: 0.073,
      vic: 0.061
    },
    brakefail: {
      _: 0.059,
      actor: 0.135,
      agg: 0.06,
      ambFar: 0.012,
      ambNear: 0.082,
      vic: 0.007
    },
    chain: {
      _: 0.014,
      actor: 0.017,
      agg: 0.016,
      ambFar: 0.036,
      ambNear: 0.015,
      vic: 0.016
    },
    debris: {
      _: 0.064,
      actor: 0.036,
      agg: 0.314,
      ambFar: 0.053,
      ambNear: 0.003,
      vic: 0.009
    },
    drowsy: {
      _: 0.048,
      actor: 0.11,
      agg: 0.051,
      ambFar: 0.014,
      ambNear: 0.053,
      vic: 0.04
    },
    fallentree: {
      _: 0.005,
      actor: 0.053,
      agg: 0.021,
      ambFar: 0.061,
      ambNear: 0.008,
      vic: 0.021
    },
    flooddip: {
      _: 0.088,
      actor: 0.053,
      agg: 0.319,
      ambNear: 0.011,
      vic: 0.025
    },
    fogbank: {
      _: 0.003,
      actor: 0.008,
      agg: 0.013,
      ambNear: 0.006,
      vic: 0.013
    },
    jackknife: {
      _: 0.136,
      actor: 0.043,
      agg: 0.627,
      ambNear: 0.005,
      vic: 0.014
    },
    leftturn: {
      _: 0.308,
      agg: 0.202,
      ambNear: 0.323,
      vic: 0.202
    },
    loadspill: {
      _: 0.027,
      actor: 0.039,
      agg: 0.127,
      ambNear: 0.005,
      vic: 0.016
    },
    lowgrip: {
      _: 0.003,
      actor: 0.043,
      agg: 0.015,
      ambNear: 0.006,
      vic: 0.015
    },
    merge: {
      _: 0.279,
      actor: 0.312,
      agg: 0.555,
      ambFar: 0.015,
      ambNear: 0.246,
      vic: 0.138
    },
    overheight: {
      _: 0.007,
      actor: 0.061,
      agg: 0.027,
      ambNear: 0.01,
      vic: 0.027
    },
    overspeed: {
      _: 0.014,
      agg: 0.033,
      ambNear: 0.018
    },
    pit: {
      _: 0.293,
      actor: 0.143,
      agg: 0.714,
      ambFar: 0.022,
      ambNear: 0.007,
      vic: 0.714
    },
    police: {
      _: 0.085,
      actor: 0.019,
      agg: 0.095,
      ambFar: 0.013,
      ambNear: 0.094,
      vic: 0.083
    },
    pullout: {
      _: 0.196,
      actor: 0.214,
      agg: 0.008,
      ambFar: 0.283,
      ambNear: 0.123,
      vic: 0.171
    },
    rampjump: {
      _: 0.01,
      agg: 0.03,
      ambFar: 0.03,
      ambNear: 0.016
    },
    redlight: {
      _: 0.209,
      agg: 0.321,
      ambFar: 0.061,
      ambNear: 0.126,
      vic: 0.271
    },
    rockslide: {
      _: 0.025,
      actor: 0.053,
      agg: 0.095,
      ambFar: 0.061,
      ambNear: 0.012,
      vic: 0.028
    },
    rollover: {
      _: 0.166,
      actor: 0.036,
      agg: 0.453,
      ambNear: 0.011
    },
    stall: {
      _: 0.001,
      actor: 0.025,
      agg: 0.007,
      ambFar: 0.015,
      ambNear: 0.003,
      vic: 0.007
    },
    sunblind: {
      _: 0.002,
      actor: 0.036,
      agg: 0.011,
      ambNear: 0.004,
      vic: 0.011
    },
    tailgate: {
      _: 0.055,
      actor: 0.119,
      ambFar: 0.052,
      vic: 0.053
    },
    wideload: {
      _: 0.029,
      actor: 0.061,
      agg: 0.106,
      ambNear: 0.009,
      vic: 0.019
    },
    wrongway: {
      _: 0.017,
      actor: 0.053,
      agg: 0.08,
      ambNear: 0.003,
      vic: 0.01
    }
  },
  over: {
    _: 0.504,
    barrierdrop: {
      _: 0.161
    },
    blowout: {
      _: 0.764
    },
    brakefail: {
      _: 0.509
    },
    chain: {
      _: 0.642
    },
    debris: {
      _: 0.501
    },
    drowsy: {
      _: 0.744
    },
    fallentree: {
      _: 0.851
    },
    flooddip: {
      _: 0.472
    },
    fogbank: {
      _: 0.126
    },
    jackknife: {
      _: 0.323
    },
    leftturn: {
      _: 0.472
    },
    loadspill: {
      _: 0.334
    },
    lowgrip: {
      _: 0.215
    },
    merge: {
      _: 0.229
    },
    overheight: {
      _: 0.689
    },
    overspeed: {
      _: 0.464
    },
    pit: {
      _: 0.392
    },
    police: {
      _: 0.562
    },
    pullout: {
      _: 0.437
    },
    rampjump: {
      _: 0.288
    },
    redlight: {
      _: 0.651
    },
    rockslide: {
      _: 0.602
    },
    rollover: {
      _: 0.175
    },
    stall: {
      _: 0.454
    },
    sunblind: {
      _: 0.744
    },
    tailgate: {
      _: 0.066
    },
    wideload: {
      _: 0.566
    },
    wrongway: {
      _: 0.698
    }
  },
  prophit: {
    _: 0.055,
    barrierdrop: {
      _: 0.069,
      far: 0.007,
      mid: 0.056,
      near: 0.112
    },
    blowout: {
      _: 0.03,
      far: 0.06,
      mid: 0.051,
      near: 0.001
    },
    brakefail: {
      _: 0.015,
      far: 0.057,
      mid: 0.016,
      near: 0.002
    },
    chain: {
      _: 0.041,
      far: 0.112,
      mid: 0.043,
      near: 0.005
    },
    debris: {
      _: 0.172,
      far: 0.165,
      mid: 0.046,
      near: 0.264
    },
    drowsy: {
      _: 0.033,
      far: 0.092,
      mid: 0.021,
      near: 0.006
    },
    fallentree: {
      _: 0.165,
      far: 0.011,
      mid: 0.01,
      near: 0.43
    },
    flooddip: {
      _: 0.131,
      far: 0.43,
      mid: 0.007,
      near: 0.017
    },
    fogbank: {
      _: 0.033,
      far: 0.17,
      mid: 0.005,
      near: 0.003
    },
    jackknife: {
      _: 0.024,
      far: 0.046,
      mid: 0.083,
      near: 0.007
    },
    leftturn: {
      _: 0.053,
      far: 0.01,
      mid: 0.14,
      near: 0.008
    },
    loadspill: {
      _: 0.321,
      far: 0.047,
      mid: 0.08,
      near: 0.347
    },
    lowgrip: {
      _: 0.027,
      far: 0.057,
      mid: 0.005,
      near: 0.022
    },
    merge: {
      _: 0.012,
      far: 0.008,
      mid: 0.003,
      near: 0.023
    },
    overheight: {
      _: 0.012,
      mid: 0.014,
      near: 0.014
    },
    overspeed: {
      _: 0.007,
      far: 0.016,
      mid: 0.017,
      near: 0.021
    },
    pit: {
      _: 0.027,
      far: 0.047,
      mid: 0.041,
      near: 0.019
    },
    police: {
      _: 0.034,
      far: 0.057,
      mid: 0.046,
      near: 0.012
    },
    pullout: {
      _: 0.042,
      far: 0.1,
      mid: 0.045,
      near: 0.007
    },
    rampjump: {
      _: 0.024,
      mid: 0.009,
      near: 0.034
    },
    redlight: {
      _: 0.052,
      far: 0.007,
      mid: 0.137,
      near: 0.027
    },
    rockslide: {
      _: 0.16,
      far: 0.013,
      mid: 0.016,
      near: 0.49
    },
    rollover: {
      _: 0.013,
      far: 0.009,
      mid: 0.014,
      near: 0.026
    },
    stall: {
      _: 0.1,
      far: 0.069,
      mid: 0.044,
      near: 0.166
    },
    sunblind: {
      _: 0.038,
      far: 0.213,
      mid: 0.074,
      near: 0.001
    },
    tailgate: {
      _: 0.03,
      far: 0.167,
      mid: 0.002,
      near: 0.006
    },
    wideload: {
      _: 0.019,
      far: 0.166,
      mid: 0.044,
      near: 0.009
    },
    wrongway: {
      _: 0.053,
      far: 0.134,
      mid: 0.042,
      near: 0.011
    }
  },
  propsafe: {
    _: 0.945,
    barrierdrop: {
      _: 0.931,
      far: 0.993,
      mid: 0.944,
      near: 0.888
    },
    blowout: {
      _: 0.97,
      far: 0.94,
      mid: 0.949,
      near: 0.999
    },
    brakefail: {
      _: 0.985,
      far: 0.943,
      mid: 0.984,
      near: 0.998
    },
    chain: {
      _: 0.959,
      far: 0.888,
      mid: 0.957,
      near: 0.995
    },
    debris: {
      _: 0.828,
      far: 0.835,
      mid: 0.954,
      near: 0.736
    },
    drowsy: {
      _: 0.967,
      far: 0.908,
      mid: 0.979,
      near: 0.994
    },
    fallentree: {
      _: 0.835,
      far: 0.989,
      mid: 0.99,
      near: 0.57
    },
    flooddip: {
      _: 0.869,
      far: 0.57,
      mid: 0.993,
      near: 0.983
    },
    fogbank: {
      _: 0.967,
      far: 0.83,
      mid: 0.995,
      near: 0.997
    },
    jackknife: {
      _: 0.976,
      far: 0.954,
      mid: 0.917,
      near: 0.993
    },
    leftturn: {
      _: 0.947,
      far: 0.99,
      mid: 0.86,
      near: 0.992
    },
    loadspill: {
      _: 0.679,
      far: 0.953,
      mid: 0.92,
      near: 0.653
    },
    lowgrip: {
      _: 0.973,
      far: 0.943,
      mid: 0.995,
      near: 0.978
    },
    merge: {
      _: 0.988,
      far: 0.992,
      mid: 0.997,
      near: 0.977
    },
    overheight: {
      _: 0.988,
      mid: 0.986,
      near: 0.986
    },
    overspeed: {
      _: 0.993,
      far: 0.984,
      mid: 0.983,
      near: 0.979
    },
    pit: {
      _: 0.973,
      far: 0.953,
      mid: 0.959,
      near: 0.981
    },
    police: {
      _: 0.966,
      far: 0.943,
      mid: 0.954,
      near: 0.988
    },
    pullout: {
      _: 0.958,
      far: 0.9,
      mid: 0.955,
      near: 0.993
    },
    rampjump: {
      _: 0.976,
      mid: 0.991,
      near: 0.966
    },
    redlight: {
      _: 0.948,
      far: 0.993,
      mid: 0.863,
      near: 0.973
    },
    rockslide: {
      _: 0.84,
      far: 0.987,
      mid: 0.984,
      near: 0.51
    },
    rollover: {
      _: 0.987,
      far: 0.991,
      mid: 0.986,
      near: 0.974
    },
    stall: {
      _: 0.9,
      far: 0.931,
      mid: 0.956,
      near: 0.834
    },
    sunblind: {
      _: 0.962,
      far: 0.787,
      mid: 0.926,
      near: 0.999
    },
    tailgate: {
      _: 0.97,
      far: 0.833,
      mid: 0.998,
      near: 0.994
    },
    wideload: {
      _: 0.981,
      far: 0.834,
      mid: 0.956,
      near: 0.991
    },
    wrongway: {
      _: 0.947,
      far: 0.866,
      mid: 0.958,
      near: 0.989
    }
  },
  special: {
    _: 0.61,
    barrierdrop: {
      _: 0.146,
      nm: 0.366
    },
    blowout: {
      _: 0.745,
      nm: 0.358
    },
    brakefail: {
      _: 0.678,
      nm: 0.766
    },
    chain: {
      _: 0.583,
      nm: 0.537
    },
    drowsy: {
      _: 0.705,
      nm: 0.305
    },
    fallentree: {
      _: 0.833,
      nm: 0.666
    },
    flooddip: {
      _: 0.568,
      nm: 0.523
    },
    fogbank: {
      _: 0.114,
      nm: 0.407
    },
    lowgrip: {
      _: 0.131,
      nm: 0.407
    },
    overheight: {
      _: 0.479,
      nm: 0.666
    },
    overspeed: {
      _: 0.282
    },
    police: {
      _: 0.727,
      nm: 0.541
    },
    pullout: {
      _: 0.885,
      nm: 0.745
    },
    redlight: {
      _: 0.883,
      nm: 0.707
    },
    rockslide: {
      _: 0.777
    },
    wideload: {
      _: 0.203,
      nm: 0.457
    }
  },
  untouched: {
    _: 0.435,
    barrierdrop: {
      _: 0.816,
      agg: 0.825,
      ambFar: 0.742,
      ambNear: 0.726,
      vic: 0.865
    },
    blowout: {
      _: 0.346,
      actor: 0.561,
      agg: 0.217,
      ambFar: 0.361,
      ambNear: 0.448,
      vic: 0.134
    },
    brakefail: {
      _: 0.477,
      actor: 0.423,
      agg: 0.081,
      ambFar: 0.878,
      ambNear: 0.68,
      vic: 0.081
    },
    chain: {
      _: 0.299,
      actor: 0.287,
      agg: 0.126,
      ambFar: 0.718,
      ambNear: 0.695,
      vic: 0.094
    },
    debris: {
      _: 0.381,
      actor: 0.384,
      agg: 0.448,
      ambFar: 0.327,
      ambNear: 0.406,
      vic: 0.274
    },
    drowsy: {
      _: 0.318,
      actor: 0.509,
      agg: 0.147,
      ambFar: 0.729,
      ambNear: 0.388,
      vic: 0.123
    },
    fallentree: {
      _: 0.353,
      actor: 0.327,
      agg: 0.181,
      ambFar: 0.373,
      ambNear: 0.54,
      vic: 0.131
    },
    flooddip: {
      _: 0.413,
      actor: 0.452,
      agg: 0.448,
      ambNear: 0.437,
      vic: 0.33
    },
    fogbank: {
      _: 0.649,
      actor: 0.725,
      agg: 0.55,
      ambNear: 0.636,
      vic: 0.519
    },
    jackknife: {
      _: 0.648,
      actor: 0.461,
      agg: 0.794,
      ambNear: 0.501,
      vic: 0.858
    },
    leftturn: {
      _: 0.429,
      agg: 0.389,
      ambNear: 0.456,
      vic: 0.389
    },
    loadspill: {
      _: 0.485,
      actor: 0.51,
      agg: 0.8,
      ambNear: 0.445,
      vic: 0.245
    },
    lowgrip: {
      _: 0.701,
      actor: 0.261,
      agg: 0.879,
      ambNear: 0.566,
      vic: 0.879
    },
    merge: {
      _: 0.639,
      actor: 0.51,
      agg: 0.76,
      ambFar: 0.676,
      ambNear: 0.547,
      vic: 0.613
    },
    overheight: {
      _: 0.359,
      actor: 0.373,
      agg: 0.663,
      ambNear: 0.3,
      vic: 0.288
    },
    overspeed: {
      _: 0.342,
      agg: 0.663,
      ambNear: 0.192
    },
    pit: {
      _: 0.611,
      actor: 0.361,
      agg: 0.809,
      ambFar: 0.822,
      ambNear: 0.391,
      vic: 0.766
    },
    police: {
      _: 0.358,
      actor: 0.461,
      agg: 0.063,
      ambFar: 0.636,
      ambNear: 0.509,
      vic: 0.029
    },
    pullout: {
      _: 0.443,
      actor: 0.476,
      agg: 0.357,
      ambFar: 0.461,
      ambNear: 0.739,
      vic: 0.284
    },
    rampjump: {
      _: 0.619,
      agg: 0.615,
      ambFar: 0.758,
      ambNear: 0.467
    },
    redlight: {
      _: 0.462,
      agg: 0.131,
      ambFar: 0.516,
      ambNear: 0.621,
      vic: 0.281
    },
    rockslide: {
      _: 0.297,
      actor: 0.327,
      agg: 0.241,
      ambFar: 0.373,
      ambNear: 0.418,
      vic: 0.241
    },
    rollover: {
      _: 0.359,
      actor: 0.218,
      agg: 0.592,
      ambNear: 0.29
    },
    stall: {
      _: 0.369,
      actor: 0.448,
      agg: 0.322,
      ambFar: 0.7,
      ambNear: 0.382,
      vic: 0.244
    },
    sunblind: {
      _: 0.379,
      actor: 0.468,
      agg: 0.093,
      ambNear: 0.578,
      vic: 0.067
    },
    tailgate: {
      _: 0.761,
      actor: 0.468,
      ambFar: 0.712,
      vic: 0.926
    },
    wideload: {
      _: 0.369,
      actor: 0.373,
      agg: 0.766,
      ambNear: 0.284,
      vic: 0.201
    },
    wrongway: {
      _: 0.361,
      actor: 0.327,
      agg: 0.34,
      ambNear: 0.461,
      vic: 0.131
    }
  },
  wheel: {
    _: 0.026,
    barrierdrop: {
      _: 0.001,
      agg: 0.006,
      ambFar: 0.009,
      ambNear: 0.002,
      vic: 0.006
    },
    blowout: {
      _: 0.027,
      actor: 0.016,
      agg: 0.03,
      ambFar: 0.016,
      ambNear: 0.022,
      vic: 0.044
    },
    brakefail: {
      _: 0.007,
      actor: 0.009,
      agg: 0.02,
      ambFar: 0.004,
      ambNear: 0.001,
      vic: 0.02
    },
    chain: {
      _: 0.086,
      actor: 0.098,
      agg: 0.056,
      ambFar: 0.013,
      ambNear: 0.002,
      vic: 0.154
    },
    debris: {
      _: 0.018,
      actor: 0.013,
      agg: 0.025,
      ambFar: 0.02,
      ambNear: 0.016,
      vic: 0.025
    },
    drowsy: {
      _: 0.041,
      actor: 0.089,
      agg: 0.095,
      ambFar: 0.005,
      ambNear: 0.019,
      vic: 0.06
    },
    fallentree: {
      _: 0.05,
      actor: 0.02,
      agg: 0.158,
      ambFar: 0.023,
      ambNear: 0.022,
      vic: 0.008
    },
    flooddip: {
      _: 0.019,
      actor: 0.02,
      agg: 0.068,
      ambNear: 0.004,
      vic: 0.009
    },
    fogbank: {
      _: 0.001,
      actor: 0.003,
      agg: 0.005,
      ambNear: 0.002,
      vic: 0.005
    },
    jackknife: {
      _: 0.022,
      actor: 0.016,
      agg: 0.005,
      ambNear: 0.024,
      vic: 0.037
    },
    leftturn: {
      _: 0.028,
      agg: 0.009,
      ambNear: 0.04,
      vic: 0.009
    },
    loadspill: {
      _: 0.025,
      actor: 0.014,
      agg: 0.006,
      ambNear: 0.027,
      vic: 0.043
    },
    lowgrip: {
      _: 0.017,
      actor: 0.016,
      agg: 0.006,
      ambNear: 0.028,
      vic: 0.006
    },
    merge: {
      _: 0.001,
      actor: 0.014,
      agg: 0.005,
      ambFar: 0.005,
      ambNear: 0.002,
      vic: 0.005
    },
    overheight: {
      _: 0.018,
      actor: 0.023,
      agg: 0.01,
      ambNear: 0.028,
      vic: 0.01
    },
    overspeed: {
      _: 0.037,
      agg: 0.012,
      ambNear: 0.048
    },
    pit: {
      _: 0.019,
      actor: 0.016,
      agg: 0.007,
      ambFar: 0.008,
      ambNear: 0.034,
      vic: 0.007
    },
    police: {
      _: 0.014,
      actor: 0.007,
      agg: 0.024,
      ambFar: 0.005,
      ambNear: 0.007,
      vic: 0.035
    },
    pullout: {
      _: 0.016,
      actor: 0.01,
      agg: 0.003,
      ambFar: 0.033,
      ambNear: 0.004,
      vic: 0.003
    },
    rampjump: {
      _: 0.004,
      agg: 0.011,
      ambFar: 0.011,
      ambNear: 0.006
    },
    redlight: {
      _: 0.025,
      agg: 0.108,
      ambFar: 0.023,
      ambNear: 0.003,
      vic: 0.008
    },
    rockslide: {
      _: 0.039,
      actor: 0.02,
      agg: 0.077,
      ambFar: 0.165,
      ambNear: 0.005,
      vic: 0.011
    },
    rollover: {
      _: 0.018,
      actor: 0.013,
      agg: 0.007,
      ambNear: 0.029
    },
    stall: {
      _: 0.004,
      actor: 0.009,
      agg: 0.002,
      ambFar: 0.006,
      ambNear: 0.008,
      vic: 0.002
    },
    sunblind: {
      _: 0.001,
      actor: 0.013,
      agg: 0.004,
      ambNear: 0.001,
      vic: 0.004
    },
    tailgate: {
      _: 0.001,
      actor: 0.013,
      ambFar: 0.001,
      vic: 0.003
    },
    wideload: {
      _: 0.038,
      actor: 0.023,
      agg: 0.007,
      ambNear: 0.066,
      vic: 0.007
    },
    wrongway: {
      _: 0.051,
      actor: 0.02,
      agg: 0.12,
      ambNear: 0.041,
      vic: 0.004
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

/* There is deliberately NO difficulty axis on CALIB. The high-difficulty bands
   once ran under target and the obvious explanation — that near-misses (d≥5),
   decoys (d≥6) and multi-incident scenes (d≥7) move the true rates, with only
   marginFor(d) to absorb it — turned out to be the wrong one. Two corrections
   were built and both made the gate WORSE (d8–10 to −7.7 %, then −4.5 %,
   from −2.8 %). A marginal per-(kind, difficulty) rate double-counts scene
   composition this table already prices via its role and template keys; an
   observed/expected ratio avoids that but could not be estimated to better
   than ±0.06 from a 400-scene sample, which is larger than the effect.

   The actual cause was a stale table: CALIB had been measured against a build
   where elevated roads had no driving surface, so cars fell through bridges.
   Regenerating it against the fixed world put all ten bands in range on its
   own. If a band drifts again, REGENERATE THIS TABLE FIRST — reach for a
   difficulty correction only with a calibration sample bigger than the Monte
   Carlo that validates it, or you will fit noise and ship it. */

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
    // P2/2F specials — car-based settles (indices from meta), same as above
    case 'rockslide': return agg >= 0 && { label: 'The rockslide takes the lead car', settle: { carCrash: agg } };
    case 'fallentree': return agg >= 0 && { label: 'The lead hits the fallen tree', settle: { carCrash: agg } };
    case 'overheight': return vic >= 0 && { label: 'The trailer gets rear-ended', settle: { carCrash: vic } };
    case 'barrierdrop': return vic >= 0 && { label: 'The queue piles into the barrier', settle: { carCrash: vic } };
    case 'fogbank': return { label: 'Three or more vanish into the fog', settle: { crashedGte: 3 } };
    case 'wideload': return pair && { label: 'The load meets the oncoming', settle: { hitPair: [agg, vic] } };
    case 'lowgrip': return pair && { label: 'It cannot stop on the wet', settle: { hitPair: [agg, vic] } };
    case 'flooddip': return agg >= 0 && { label: 'The aquaplane ends in a crash', settle: { carCrash: agg } };
    default: return null;
  }
}

// generateMarkets(scene, { labelOf }) → array of markets. Deterministic, no
// rng, outcome-blind. labelOf(typeId) supplies display names (REG labels in
// the app; type ids in headless tests).
export function generateMarkets(scene, opts = {}) {
  const labelOf = opts.labelOf || ((t) => t);
  // opts.all — CALIBRATION ONLY (tools/calibrate.mjs). Emits every candidate
  // market, skipping the offering filters below.
  //
  // Offering is itself a function of CALIB (markets outside 1.5 %…85 % are
  // withheld), so measuring rates over only the OFFERED set feeds a truncated
  // sample back in as if it were the full-population prior. That is a
  // feedback loop, and it does not converge: regenerating once put the house
  // edge at +14.6 %, splicing that result and regenerating again flipped it to
  // -42.2 %. Calibrating over ALL candidates breaks the loop — the table then
  // describes the world instead of describing the previous table's selection.
  const offerAll = !!opts.all;
  const offerable = (p) => offerAll || p >= OFFER_MIN;
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
    if (!head && !offerAll && (p > OFFER_MAX || p < OFFER_MIN)) return;
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
    if (offerable(pFlip)) add(`c${i}.flip`, `car:${i}`, `${name} flips`, 'flip', pFlip, { carFlip: i });
    const pWheel = calib('wheel', tpl, role);
    if (offerable(pWheel)) add(`c${i}.wheel`, `car:${i}`, `${name} loses a wheel`, 'wheel', pWheel, { carWheel: i });
    const pFire = calib('fire', tpl, role);
    if (offerable(pFire)) add(`c${i}.fire`, `car:${i}`, `${name} catches fire`, 'fire', pFire, { carFire: i });
    const pOff = calib('offroad', tpl, role);
    if (offerable(pOff)) add(`c${i}.offroad`, `car:${i}`, `${name} leaves the road`, 'offroad', pOff, { carOffroad: i });
    const pFirst = calib('first', tpl, role);
    if (offerable(pFirst)) add(`c${i}.first`, `car:${i}`, `${name} crashes first`, 'first', pFirst, { carFirst: i });
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
  if (offerable(pAF)) add('s.flip', 'scene', 'Somebody flips', 'anyflip', pAF, { anyFlip: true });
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
