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
// Empirical table from tools/calibrate.mjs (400 scenes, all difficulties,
// Laplace-smoothed toward each kind mean). Regenerate after director/physics
// changes that move outcome statistics; tests/montecarlo.mjs catches drift.
// Regenerated for G4: the 8-template G1 table left the 12 new templates
// falling back to bare kind means, so 60 % of the incident library was priced
// off an average instead of its own measured rate.
export const CALIB = {
  anyflip: {
    _: 0.068,
    blowout: {
      _: 0.142
    },
    brakefail: {
      _: 0.011
    },
    chain: {
      _: 0.113
    },
    debris: {
      _: 0.07
    },
    drowsy: {
      _: 0.083
    },
    jackknife: {
      _: 0.014
    },
    leftturn: {
      _: 0.074
    },
    loadspill: {
      _: 0.064
    },
    merge: {
      _: 0.014
    },
    overspeed: {
      _: 0.041
    },
    pit: {
      _: 0.025
    },
    police: {
      _: 0.13
    },
    pullout: {
      _: 0.012
    },
    rampjump: {
      _: 0.029
    },
    redlight: {
      _: 0.115
    },
    rollover: {
      _: 0.025
    },
    stall: {
      _: 0.138
    },
    sunblind: {
      _: 0.016
    },
    tailgate: {
      _: 0.013
    },
    wrongway: {
      _: 0.162
    }
  },
  anyglass: {
    _: 0.185,
    blowout: {
      _: 0.197
    },
    brakefail: {
      _: 0.213
    },
    chain: {
      _: 0.516
    },
    debris: {
      _: 0.105
    },
    drowsy: {
      _: 0.222
    },
    jackknife: {
      _: 0.147
    },
    leftturn: {
      _: 0.164
    },
    loadspill: {
      _: 0.05
    },
    merge: {
      _: 0.075
    },
    overspeed: {
      _: 0.111
    },
    pit: {
      _: 0.132
    },
    police: {
      _: 0.18
    },
    pullout: {
      _: 0.062
    },
    rampjump: {
      _: 0.151
    },
    redlight: {
      _: 0.339
    },
    rollover: {
      _: 0.069
    },
    stall: {
      _: 0.191
    },
    sunblind: {
      _: 0.084
    },
    tailgate: {
      _: 0.068
    },
    wrongway: {
      _: 0.386
    }
  },
  anywheel: {
    _: 0.102,
    blowout: {
      _: 0.149
    },
    brakefail: {
      _: 0.043
    },
    chain: {
      _: 0.247
    },
    debris: {
      _: 0.031
    },
    drowsy: {
      _: 0.137
    },
    jackknife: {
      _: 0.058
    },
    leftturn: {
      _: 0.085
    },
    loadspill: {
      _: 0.028
    },
    merge: {
      _: 0.022
    },
    overspeed: {
      _: 0.061
    },
    pit: {
      _: 0.038
    },
    police: {
      _: 0.165
    },
    pullout: {
      _: 0.048
    },
    rampjump: {
      _: 0.044
    },
    redlight: {
      _: 0.267
    },
    rollover: {
      _: 0.038
    },
    stall: {
      _: 0.144
    },
    sunblind: {
      _: 0.025
    },
    tailgate: {
      _: 0.052
    },
    wrongway: {
      _: 0.22
    }
  },
  chain3: {
    _: 0.175,
    blowout: {
      _: 0.195
    },
    brakefail: {
      _: 0.107
    },
    chain: {
      _: 0.488
    },
    debris: {
      _: 0.202
    },
    drowsy: {
      _: 0.27
    },
    jackknife: {
      _: 0.037
    },
    leftturn: {
      _: 0.161
    },
    loadspill: {
      _: 0.093
    },
    merge: {
      _: 0.037
    },
    overspeed: {
      _: 0.105
    },
    pit: {
      _: 0.128
    },
    police: {
      _: 0.207
    },
    pullout: {
      _: 0.031
    },
    rampjump: {
      _: 0.075
    },
    redlight: {
      _: 0.145
    },
    rollover: {
      _: 0.128
    },
    stall: {
      _: 0.22
    },
    sunblind: {
      _: 0.162
    },
    tailgate: {
      _: 0.034
    },
    wrongway: {
      _: 0.479
    }
  },
  crash: {
    _: 0.273,
    blowout: {
      _: 0.314,
      actor: 0.293,
      agg: 0.634,
      ambNear: 0.153,
      vic: 0.44
    },
    brakefail: {
      _: 0.333,
      actor: 0.164,
      agg: 0.543,
      ambFar: 0.205,
      ambNear: 0.1,
      vic: 0.806
    },
    chain: {
      _: 0.458,
      actor: 0.452,
      agg: 0.401,
      ambFar: 0.234,
      ambNear: 0.165,
      vic: 0.581
    },
    debris: {
      _: 0.215,
      actor: 0.182,
      agg: 0.182,
      ambNear: 0.209,
      vic: 0.332
    },
    drowsy: {
      _: 0.364,
      actor: 0.331,
      agg: 0.625,
      ambFar: 0.059,
      ambNear: 0.246,
      vic: 0.552
    },
    jackknife: {
      _: 0.126,
      actor: 0.164,
      agg: 0.094,
      ambNear: 0.186,
      vic: 0.094
    },
    leftturn: {
      _: 0.223,
      actor: 0.234,
      agg: 0.244,
      ambNear: 0.207,
      vic: 0.297
    },
    loadspill: {
      _: 0.222,
      actor: 0.205,
      agg: 0.165,
      ambNear: 0.193,
      vic: 0.393
    },
    merge: {
      _: 0.112,
      actor: 0.234,
      agg: 0.094,
      ambFar: 0.071,
      ambNear: 0.184,
      vic: 0.158
    },
    overspeed: {
      _: 0.192,
      actor: 0.33,
      agg: 0.164,
      ambNear: 0.203
    },
    pit: {
      _: 0.125,
      actor: 0.164,
      agg: 0.165,
      ambFar: 0.164,
      ambNear: 0.162,
      vic: 0.165
    },
    police: {
      _: 0.283,
      actor: 0.214,
      agg: 0.254,
      ambFar: 0.149,
      ambNear: 0.147,
      vic: 0.754
    },
    pullout: {
      _: 0.15,
      actor: 0.234,
      agg: 0.166,
      ambFar: 0.079,
      ambNear: 0.075,
      vic: 0.401
    },
    rampjump: {
      _: 0.144,
      actor: 0.205,
      agg: 0.117,
      ambFar: 0.097,
      ambNear: 0.266
    },
    redlight: {
      _: 0.329,
      actor: 0.234,
      agg: 0.554,
      ambFar: 0.234,
      ambNear: 0.156,
      vic: 0.507
    },
    rollover: {
      _: 0.26,
      actor: 0.377,
      agg: 0.29,
      ambNear: 0.221
    },
    stall: {
      _: 0.305,
      actor: 0.189,
      agg: 0.301,
      ambFar: 0.234,
      ambNear: 0.313,
      vic: 0.333
    },
    sunblind: {
      _: 0.339,
      actor: 0.377,
      agg: 0.546,
      ambNear: 0.055,
      vic: 0.826
    },
    tailgate: {
      _: 0.099,
      actor: 0.205,
      ambFar: 0.128,
      vic: 0.053
    },
    wrongway: {
      _: 0.452,
      actor: 0.205,
      agg: 0.459,
      ambNear: 0.356,
      vic: 0.65
    }
  },
  fire: {
    _: 0.004,
    blowout: {
      _: 0,
      actor: 0.003,
      agg: 0.001,
      ambNear: 0,
      vic: 0.001
    },
    brakefail: {
      _: 0,
      actor: 0.002,
      agg: 0.001,
      ambFar: 0.003,
      ambNear: 0,
      vic: 0.001
    },
    chain: {
      _: 0.015,
      actor: 0.025,
      agg: 0.001,
      ambFar: 0.003,
      ambNear: 0.001,
      vic: 0.001
    },
    debris: {
      _: 0,
      actor: 0.003,
      agg: 0.001,
      ambNear: 0,
      vic: 0.001
    },
    drowsy: {
      _: 0,
      actor: 0.002,
      agg: 0.001,
      ambFar: 0.001,
      ambNear: 0,
      vic: 0.001
    },
    jackknife: {
      _: 0,
      actor: 0.002,
      agg: 0.001,
      ambNear: 0,
      vic: 0.001
    },
    leftturn: {
      _: 0,
      actor: 0.003,
      agg: 0.001,
      ambNear: 0,
      vic: 0.001
    },
    loadspill: {
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
    overspeed: {
      _: 0.001,
      actor: 0.003,
      agg: 0.002,
      ambNear: 0.002
    },
    pit: {
      _: 0,
      actor: 0.002,
      agg: 0.001,
      ambFar: 0.002,
      ambNear: 0.001,
      vic: 0.001
    },
    police: {
      _: 0.006,
      actor: 0.001,
      agg: 0.001,
      ambFar: 0.002,
      ambNear: 0.011,
      vic: 0.001
    },
    pullout: {
      _: 0.007,
      actor: 0.003,
      agg: 0.001,
      ambFar: 0,
      ambNear: 0.001,
      vic: 0.03
    },
    rampjump: {
      _: 0,
      actor: 0.003,
      agg: 0.002,
      ambFar: 0.001,
      ambNear: 0.001
    },
    redlight: {
      _: 0,
      actor: 0.003,
      agg: 0.001,
      ambFar: 0.003,
      ambNear: 0,
      vic: 0.001
    },
    rollover: {
      _: 0.001,
      actor: 0.003,
      agg: 0.001,
      ambNear: 0.001
    },
    stall: {
      _: 0.007,
      actor: 0.002,
      agg: 0.001,
      ambFar: 0.003,
      ambNear: 0.012,
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
    wrongway: {
      _: 0.022,
      actor: 0.003,
      agg: 0.049,
      ambNear: 0.018,
      vic: 0.001
    }
  },
  first: {
    _: 0.188,
    blowout: {
      _: 0.254,
      actor: 0.125,
      agg: 0.617,
      ambNear: 0.069,
      vic: 0.424
    },
    brakefail: {
      _: 0.279,
      actor: 0.113,
      agg: 0.53,
      ambFar: 0.141,
      ambNear: 0.011,
      vic: 0.793
    },
    chain: {
      _: 0.198,
      actor: 0.084,
      agg: 0.285,
      ambFar: 0.161,
      ambNear: 0.071,
      vic: 0.516
    },
    debris: {
      _: 0.136,
      actor: 0.125,
      agg: 0.156,
      ambNear: 0.081,
      vic: 0.306
    },
    drowsy: {
      _: 0.265,
      actor: 0.194,
      agg: 0.589,
      ambFar: 0.04,
      ambNear: 0.101,
      vic: 0.467
    },
    jackknife: {
      _: 0.105,
      actor: 0.113,
      agg: 0.076,
      ambNear: 0.149,
      vic: 0.076
    },
    leftturn: {
      _: 0.138,
      actor: 0.161,
      agg: 0.217,
      ambNear: 0.1,
      vic: 0.217
    },
    loadspill: {
      _: 0.156,
      actor: 0.141,
      agg: 0.142,
      ambNear: 0.123,
      vic: 0.279
    },
    merge: {
      _: 0.078,
      actor: 0.161,
      agg: 0.076,
      ambFar: 0.049,
      ambNear: 0.109,
      vic: 0.136
    },
    overspeed: {
      _: 0.165,
      actor: 0.266,
      agg: 0.113,
      ambNear: 0.164
    },
    pit: {
      _: 0.089,
      actor: 0.113,
      agg: 0.071,
      ambFar: 0.113,
      ambNear: 0.125,
      vic: 0.133
    },
    police: {
      _: 0.189,
      actor: 0.125,
      agg: 0.18,
      ambFar: 0.103,
      ambNear: 0.023,
      vic: 0.71
    },
    pullout: {
      _: 0.133,
      actor: 0.161,
      agg: 0.151,
      ambFar: 0.044,
      ambNear: 0.051,
      vic: 0.386
    },
    rampjump: {
      _: 0.112,
      actor: 0.141,
      agg: 0.081,
      ambFar: 0.066,
      ambNear: 0.205
    },
    redlight: {
      _: 0.249,
      actor: 0.161,
      agg: 0.53,
      ambFar: 0.161,
      ambNear: 0.043,
      vic: 0.435
    },
    rollover: {
      _: 0.223,
      actor: 0.304,
      agg: 0.258,
      ambNear: 0.171
    },
    stall: {
      _: 0.176,
      actor: 0.081,
      agg: 0.285,
      ambFar: 0.161,
      ambNear: 0.099,
      vic: 0.317
    },
    sunblind: {
      _: 0.306,
      actor: 0.161,
      agg: 0.525,
      ambNear: 0.017,
      vic: 0.805
    },
    tailgate: {
      _: 0.086,
      actor: 0.141,
      ambFar: 0.111,
      vic: 0.036
    },
    wrongway: {
      _: 0.235,
      actor: 0.141,
      agg: 0.435,
      ambNear: 0.088,
      vic: 0.435
    }
  },
  flip: {
    _: 0.023,
    blowout: {
      _: 0.043,
      actor: 0.015,
      agg: 0.004,
      ambNear: 0.069,
      vic: 0.004
    },
    brakefail: {
      _: 0.001,
      actor: 0.014,
      agg: 0.004,
      ambFar: 0.017,
      ambNear: 0.001,
      vic: 0.004
    },
    chain: {
      _: 0.021,
      actor: 0.018,
      agg: 0.029,
      ambFar: 0.02,
      ambNear: 0.071,
      vic: 0.004
    },
    debris: {
      _: 0.014,
      actor: 0.015,
      agg: 0.007,
      ambNear: 0.022,
      vic: 0.007
    },
    drowsy: {
      _: 0.016,
      actor: 0.013,
      agg: 0.028,
      ambFar: 0.005,
      ambNear: 0.021,
      vic: 0.003
    },
    jackknife: {
      _: 0.001,
      actor: 0.014,
      agg: 0.005,
      ambNear: 0.002,
      vic: 0.005
    },
    leftturn: {
      _: 0.013,
      actor: 0.02,
      agg: 0.06,
      ambNear: 0.002,
      vic: 0.007
    },
    loadspill: {
      _: 0.014,
      actor: 0.017,
      agg: 0.052,
      ambNear: 0.003,
      vic: 0.006
    },
    merge: {
      _: 0.001,
      actor: 0.02,
      agg: 0.005,
      ambFar: 0.006,
      ambNear: 0.003,
      vic: 0.006
    },
    overspeed: {
      _: 0.007,
      actor: 0.017,
      agg: 0.014,
      ambNear: 0.011
    },
    pit: {
      _: 0.002,
      actor: 0.014,
      agg: 0.009,
      ambFar: 0.014,
      ambNear: 0.003,
      vic: 0.009
    },
    police: {
      _: 0.049,
      actor: 0.067,
      agg: 0.092,
      ambFar: 0.013,
      ambNear: 0.044,
      vic: 0.004
    },
    pullout: {
      _: 0.001,
      actor: 0.02,
      agg: 0.004,
      ambFar: 0.002,
      ambNear: 0.006,
      vic: 0.004
    },
    rampjump: {
      _: 0.003,
      actor: 0.017,
      agg: 0.01,
      ambFar: 0.008,
      ambNear: 0.006
    },
    redlight: {
      _: 0.026,
      actor: 0.02,
      agg: 0.102,
      ambFar: 0.02,
      ambNear: 0.003,
      vic: 0.007
    },
    rollover: {
      _: 0.003,
      actor: 0.02,
      agg: 0.009,
      ambNear: 0.005
    },
    stall: {
      _: 0.099,
      actor: 0.081,
      agg: 0.004,
      ambFar: 0.02,
      ambNear: 0.16,
      vic: 0.004
    },
    sunblind: {
      _: 0.001,
      actor: 0.02,
      agg: 0.006,
      ambNear: 0.002,
      vic: 0.006
    },
    tailgate: {
      _: 0.001,
      actor: 0.017,
      ambFar: 0.002,
      vic: 0.004
    },
    wrongway: {
      _: 0.09,
      actor: 0.017,
      agg: 0.054,
      ambNear: 0.089,
      vic: 0.102
    }
  },
  headline: {
    _: 0.725,
    blowout: {
      _: 0.85,
      nm: 0.669
    },
    brakefail: {
      _: 0.93,
      nm: 0.764
    },
    chain: {
      _: 0.855,
      nm: 0.862
    },
    debris: {
      _: 0.667,
      nm: 0.706
    },
    drowsy: {
      _: 0.838,
      nm: 0.817
    },
    jackknife: {
      _: 0.512,
      nm: 0.594
    },
    leftturn: {
      _: 0.755,
      nm: 0.764
    },
    loadspill: {
      _: 0.652,
      nm: 0.764
    },
    merge: {
      _: 0.405,
      nm: 0.544
    },
    overspeed: {
      _: 0.635
    },
    pit: {
      _: 0.522,
      nm: 0.621
    },
    police: {
      _: 0.863,
      nm: 0.817
    },
    pullout: {
      _: 0.657,
      nm: 0.544
    },
    rampjump: {
      _: 0.596
    },
    redlight: {
      _: 0.826,
      nm: 0.764
    },
    rollover: {
      _: 0.647
    },
    stall: {
      _: 0.792,
      nm: 0.544
    },
    sunblind: {
      _: 0.934,
      nm: 0.764
    },
    tailgate: {
      _: 0.366,
      nm: 0.706
    },
    wrongway: {
      _: 0.826,
      nm: 0.794
    }
  },
  offroad: {
    _: 0.126,
    blowout: {
      _: 0.055,
      actor: 0.084,
      agg: 0.153,
      ambNear: 0.031,
      vic: 0.057
    },
    brakefail: {
      _: 0.072,
      actor: 0.076,
      agg: 0.099,
      ambFar: 0.094,
      ambNear: 0.092,
      vic: 0.02
    },
    chain: {
      _: 0.095,
      actor: 0.097,
      agg: 0.096,
      ambFar: 0.108,
      ambNear: 0.11,
      vic: 0.096
    },
    debris: {
      _: 0.119,
      actor: 0.084,
      agg: 0.488,
      ambNear: 0.015,
      vic: 0.038
    },
    drowsy: {
      _: 0.1,
      actor: 0.16,
      agg: 0.067,
      ambFar: 0.027,
      ambNear: 0.128,
      vic: 0.116
    },
    jackknife: {
      _: 0.119,
      actor: 0.076,
      agg: 0.491,
      ambNear: 0.011,
      vic: 0.027
    },
    leftturn: {
      _: 0.384,
      actor: 0.108,
      agg: 0.303,
      ambNear: 0.389,
      vic: 0.303
    },
    loadspill: {
      _: 0.092,
      actor: 0.094,
      agg: 0.353,
      ambNear: 0.015,
      vic: 0.034
    },
    merge: {
      _: 0.257,
      actor: 0.108,
      agg: 0.563,
      ambFar: 0.033,
      ambNear: 0.186,
      vic: 0.163
    },
    overspeed: {
      _: 0.04,
      actor: 0.094,
      agg: 0.076,
      ambNear: 0.058
    },
    pit: {
      _: 0.257,
      actor: 0.176,
      agg: 0.547,
      ambFar: 0.076,
      ambNear: 0.018,
      vic: 0.547
    },
    police: {
      _: 0.18,
      actor: 0.28,
      agg: 0.14,
      ambFar: 0.069,
      ambNear: 0.18,
      vic: 0.169
    },
    pullout: {
      _: 0.158,
      actor: 0.108,
      agg: 0.022,
      ambFar: 0.222,
      ambNear: 0.125,
      vic: 0.169
    },
    rampjump: {
      _: 0.038,
      actor: 0.219,
      agg: 0.054,
      ambFar: 0.044,
      ambNear: 0.03
    },
    redlight: {
      _: 0.33,
      actor: 0.108,
      agg: 0.417,
      ambFar: 0.108,
      ambNear: 0.24,
      vic: 0.369
    },
    rollover: {
      _: 0.092,
      actor: 0.108,
      agg: 0.235,
      ambNear: 0.025
    },
    stall: {
      _: 0.005,
      actor: 0.054,
      agg: 0.024,
      ambFar: 0.108,
      ambNear: 0.009,
      vic: 0.024
    },
    sunblind: {
      _: 0.007,
      actor: 0.108,
      agg: 0.03,
      ambNear: 0.011,
      vic: 0.03
    },
    tailgate: {
      _: 0.176,
      actor: 0.094,
      ambFar: 0.173,
      vic: 0.186
    },
    wrongway: {
      _: 0.02,
      actor: 0.094,
      agg: 0.084,
      ambNear: 0.013,
      vic: 0.036
    }
  },
  over: {
    _: 0.43,
    blowout: {
      _: 0.599
    },
    brakefail: {
      _: 0.647
    },
    chain: {
      _: 0.605
    },
    debris: {
      _: 0.329
    },
    drowsy: {
      _: 0.697
    },
    jackknife: {
      _: 0.199
    },
    leftturn: {
      _: 0.294
    },
    loadspill: {
      _: 0.39
    },
    merge: {
      _: 0.199
    },
    overspeed: {
      _: 0.258
    },
    pit: {
      _: 0.286
    },
    police: {
      _: 0.458
    },
    pullout: {
      _: 0.135
    },
    rampjump: {
      _: 0.256
    },
    redlight: {
      _: 0.599
    },
    rollover: {
      _: 0.286
    },
    stall: {
      _: 0.456
    },
    sunblind: {
      _: 0.583
    },
    tailgate: {
      _: 0.18
    },
    wrongway: {
      _: 0.647
    }
  },
  prophit: {
    _: 0.046,
    blowout: {
      _: 0.021,
      far: 0.013,
      mid: 0.074,
      near: 0.002
    },
    brakefail: {
      _: 0.032,
      far: 0.009,
      mid: 0.088,
      near: 0.007
    },
    chain: {
      _: 0.012,
      far: 0.008,
      mid: 0.022,
      near: 0.003
    },
    debris: {
      _: 0.135,
      far: 0.031,
      mid: 0.147,
      near: 0.13
    },
    drowsy: {
      _: 0.01,
      far: 0.01,
      mid: 0.008,
      near: 0.014
    },
    jackknife: {
      _: 0.033,
      far: 0.021,
      mid: 0.108,
      near: 0.002
    },
    leftturn: {
      _: 0.051,
      far: 0.008,
      mid: 0.13,
      near: 0.009
    },
    loadspill: {
      _: 0.345,
      mid: 0.187,
      near: 0.374
    },
    merge: {
      _: 0.006,
      far: 0.014,
      mid: 0.003,
      near: 0.009
    },
    overspeed: {
      _: 0.005,
      near: 0.005
    },
    pit: {
      _: 0.042,
      mid: 0.067,
      near: 0.022
    },
    police: {
      _: 0.011,
      far: 0.007,
      mid: 0.031,
      near: 0.003
    },
    pullout: {
      _: 0.02,
      far: 0.008,
      mid: 0.039,
      near: 0.003
    },
    rampjump: {
      _: 0.036,
      mid: 0.007,
      near: 0.059
    },
    redlight: {
      _: 0.063,
      far: 0.009,
      mid: 0.149,
      near: 0.008
    },
    rollover: {
      _: 0.003,
      far: 0.028,
      mid: 0.021,
      near: 0.003
    },
    stall: {
      _: 0.107,
      far: 0.012,
      mid: 0.106,
      near: 0.119
    },
    sunblind: {
      _: 0.015,
      far: 0.035,
      mid: 0.066,
      near: 0.002
    },
    tailgate: {
      _: 0.001,
      far: 0.008,
      mid: 0.004,
      near: 0.002
    },
    wrongway: {
      _: 0.038,
      far: 0.028,
      mid: 0.134,
      near: 0.012
    }
  },
  propsafe: {
    _: 0.954,
    blowout: {
      _: 0.979,
      far: 0.987,
      mid: 0.926,
      near: 0.998
    },
    brakefail: {
      _: 0.968,
      far: 0.991,
      mid: 0.912,
      near: 0.993
    },
    chain: {
      _: 0.988,
      far: 0.992,
      mid: 0.978,
      near: 0.997
    },
    debris: {
      _: 0.865,
      far: 0.969,
      mid: 0.853,
      near: 0.87
    },
    drowsy: {
      _: 0.99,
      far: 0.99,
      mid: 0.992,
      near: 0.986
    },
    jackknife: {
      _: 0.967,
      far: 0.979,
      mid: 0.892,
      near: 0.998
    },
    leftturn: {
      _: 0.949,
      far: 0.992,
      mid: 0.87,
      near: 0.991
    },
    loadspill: {
      _: 0.655,
      mid: 0.813,
      near: 0.626
    },
    merge: {
      _: 0.994,
      far: 0.986,
      mid: 0.997,
      near: 0.991
    },
    overspeed: {
      _: 0.995,
      near: 0.995
    },
    pit: {
      _: 0.958,
      mid: 0.933,
      near: 0.978
    },
    police: {
      _: 0.989,
      far: 0.993,
      mid: 0.969,
      near: 0.997
    },
    pullout: {
      _: 0.98,
      far: 0.992,
      mid: 0.961,
      near: 0.997
    },
    rampjump: {
      _: 0.964,
      mid: 0.993,
      near: 0.941
    },
    redlight: {
      _: 0.937,
      far: 0.991,
      mid: 0.851,
      near: 0.992
    },
    rollover: {
      _: 0.997,
      far: 0.972,
      mid: 0.979,
      near: 0.997
    },
    stall: {
      _: 0.893,
      far: 0.988,
      mid: 0.894,
      near: 0.881
    },
    sunblind: {
      _: 0.985,
      far: 0.965,
      mid: 0.934,
      near: 0.998
    },
    tailgate: {
      _: 0.999,
      far: 0.992,
      mid: 0.996,
      near: 0.998
    },
    wrongway: {
      _: 0.962,
      far: 0.972,
      mid: 0.866,
      near: 0.988
    }
  },
  special: {
    _: 0.735,
    blowout: {
      _: 0.626,
      nm: 0.551
    },
    brakefail: {
      _: 0.879,
      nm: 0.773
    },
    chain: {
      _: 0.575,
      nm: 0.534
    },
    drowsy: {
      _: 0.62,
      nm: 0.49
    },
    overspeed: {
      _: 0.441
    },
    police: {
      _: 0.836,
      nm: 0.823
    },
    pullout: {
      _: 0.865,
      nm: 0.801
    },
    redlight: {
      _: 0.924,
      nm: 0.773
    }
  },
  untouched: {
    _: 0.459,
    blowout: {
      _: 0.407,
      actor: 0.528,
      agg: 0.315,
      ambNear: 0.492,
      vic: 0.25
    },
    brakefail: {
      _: 0.402,
      actor: 0.575,
      agg: 0.099,
      ambFar: 0.594,
      ambNear: 0.611,
      vic: 0.072
    },
    chain: {
      _: 0.246,
      actor: 0.271,
      agg: 0.122,
      ambFar: 0.536,
      ambNear: 0.735,
      vic: 0.173
    },
    debris: {
      _: 0.436,
      actor: 0.417,
      agg: 0.638,
      ambNear: 0.446,
      vic: 0.238
    },
    drowsy: {
      _: 0.339,
      actor: 0.523,
      agg: 0.189,
      ambFar: 0.813,
      ambNear: 0.348,
      vic: 0.165
    },
    jackknife: {
      _: 0.679,
      actor: 0.575,
      agg: 0.848,
      ambNear: 0.496,
      vic: 0.848
    },
    leftturn: {
      _: 0.429,
      actor: 0.393,
      agg: 0.461,
      ambNear: 0.488,
      vic: 0.25
    },
    loadspill: {
      _: 0.58,
      actor: 0.469,
      agg: 0.761,
      ambNear: 0.555,
      vic: 0.398
    },
    merge: {
      _: 0.7,
      actor: 0.393,
      agg: 0.813,
      ambFar: 0.815,
      ambNear: 0.484,
      vic: 0.728
    },
    overspeed: {
      _: 0.461,
      actor: 0.469,
      agg: 0.675,
      ambNear: 0.289
    },
    pit: {
      _: 0.562,
      actor: 0.675,
      agg: 0.61,
      ambFar: 0.675,
      ambNear: 0.409,
      vic: 0.61
    },
    police: {
      _: 0.38,
      actor: 0.397,
      agg: 0.081,
      ambFar: 0.705,
      ambNear: 0.578,
      vic: 0.081
    },
    pullout: {
      _: 0.547,
      actor: 0.393,
      agg: 0.346,
      ambFar: 0.701,
      ambNear: 0.761,
      vic: 0.257
    },
    rampjump: {
      _: 0.603,
      actor: 0.469,
      agg: 0.625,
      ambFar: 0.809,
      ambNear: 0.39
    },
    redlight: {
      _: 0.441,
      actor: 0.536,
      agg: 0.131,
      ambFar: 0.536,
      ambNear: 0.668,
      vic: 0.179
    },
    rollover: {
      _: 0.433,
      actor: 0.393,
      agg: 0.547,
      ambNear: 0.392
    },
    stall: {
      _: 0.383,
      actor: 0.554,
      agg: 0.367,
      ambFar: 0.393,
      ambNear: 0.424,
      vic: 0.274
    },
    sunblind: {
      _: 0.464,
      actor: 0.393,
      agg: 0.11,
      ambNear: 0.739,
      vic: 0.11
    },
    tailgate: {
      _: 0.752,
      actor: 0.469,
      ambFar: 0.69,
      vic: 0.895
    },
    wrongway: {
      _: 0.364,
      actor: 0.594,
      agg: 0.322,
      ambNear: 0.41,
      vic: 0.274
    }
  },
  wheel: {
    _: 0.025,
    blowout: {
      _: 0.029,
      actor: 0.017,
      agg: 0.037,
      ambNear: 0.013,
      vic: 0.069
    },
    brakefail: {
      _: 0.007,
      actor: 0.015,
      agg: 0.004,
      ambFar: 0.019,
      ambNear: 0.001,
      vic: 0.03
    },
    chain: {
      _: 0.082,
      actor: 0.067,
      agg: 0.03,
      ambFar: 0.022,
      ambNear: 0.01,
      vic: 0.183
    },
    debris: {
      _: 0.002,
      actor: 0.017,
      agg: 0.008,
      ambNear: 0.003,
      vic: 0.008
    },
    drowsy: {
      _: 0.026,
      actor: 0.014,
      agg: 0.052,
      ambFar: 0.005,
      ambNear: 0.012,
      vic: 0.052
    },
    jackknife: {
      _: 0.01,
      actor: 0.015,
      agg: 0.005,
      ambNear: 0.017,
      vic: 0.005
    },
    leftturn: {
      _: 0.013,
      actor: 0.022,
      agg: 0.008,
      ambNear: 0.019,
      vic: 0.008
    },
    loadspill: {
      _: 0.002,
      actor: 0.019,
      agg: 0.007,
      ambNear: 0.003,
      vic: 0.007
    },
    merge: {
      _: 0.001,
      actor: 0.022,
      agg: 0.005,
      ambFar: 0.007,
      ambNear: 0.003,
      vic: 0.007
    },
    overspeed: {
      _: 0.008,
      actor: 0.019,
      agg: 0.015,
      ambNear: 0.012
    },
    pit: {
      _: 0.002,
      actor: 0.015,
      agg: 0.01,
      ambFar: 0.015,
      ambNear: 0.004,
      vic: 0.01
    },
    police: {
      _: 0.049,
      actor: 0.009,
      agg: 0.093,
      ambFar: 0.014,
      ambNear: 0.034,
      vic: 0.063
    },
    pullout: {
      _: 0.008,
      actor: 0.022,
      agg: 0.004,
      ambFar: 0.002,
      ambNear: 0.007,
      vic: 0.034
    },
    rampjump: {
      _: 0.003,
      actor: 0.019,
      agg: 0.011,
      ambFar: 0.009,
      ambNear: 0.006
    },
    redlight: {
      _: 0.064,
      actor: 0.022,
      agg: 0.15,
      ambFar: 0.022,
      ambNear: 0.003,
      vic: 0.102
    },
    rollover: {
      _: 0.004,
      actor: 0.022,
      agg: 0.01,
      ambNear: 0.005
    },
    stall: {
      _: 0.036,
      actor: 0.011,
      agg: 0.005,
      ambFar: 0.022,
      ambNear: 0.063,
      vic: 0.005
    },
    sunblind: {
      _: 0.001,
      actor: 0.022,
      agg: 0.006,
      ambNear: 0.002,
      vic: 0.006
    },
    tailgate: {
      _: 0.01,
      actor: 0.019,
      ambFar: 0.013,
      vic: 0.005
    },
    wrongway: {
      _: 0.057,
      actor: 0.019,
      agg: 0.15,
      ambNear: 0.037,
      vic: 0.007
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
