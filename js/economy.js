// economy.js — bankroll, slip, settlement, persistence (game phase G2).
//
// Pure integer money: whole dollars for stakes/payouts, odds in integer
// hundredths (see markets.js). payout = ⌊stake · oddsH / 100⌋ and INCLUDES
// the returned stake (decimal-odds convention). The bankroll is deducted at
// bet time and can never go negative by construction (validation caps total
// staked at the bankroll).
//
// The profile is versioned JSON under localStorage["crashbet.profile.v1"];
// the store is injectable so the whole module runs headless in node (memory
// store) — that is how tests/economy.mjs exercises it.
//
// Anti-cheese rules (spec "Money rules"):
//  - each seed settles winnings ONCE per profile (settled-seed ring ledger);
//  - custom/shared seeds run as Exhibition: fully playable, zero bankroll,
//    ledger or stats mutation;
//  - campaign seeds come from a hidden per-profile stream and are only
//    revealed at settlement (hiding is the UI's job; the stream lives here).
import { makeRng, clamp } from './lib.js';
import { settleMarket, PARLAY_CAP } from './markets.js';

export const PROFILE_KEY = 'crashbet.profile.v1';
export const START_BANKROLL = 100;
export const LEDGER_CAP = 500;

/* ---------------- storage ---------------- */
// injectable store: browser gets localStorage, tests get memoryStore()
export function memoryStore() {
  const m = new Map();
  return {
    get: (k) => (m.has(k) ? m.get(k) : null),
    set: (k, v) => m.set(k, v),
    del: (k) => m.delete(k),
  };
}
export function localStore() {
  return {
    get: (k) => localStorage.getItem(k),
    set: (k, v) => localStorage.setItem(k, v),
    del: (k) => localStorage.removeItem(k),
  };
}

/* ---------------- profile ---------------- */
// `entropy` seeds the hidden campaign stream — any unpredictable string
// (crypto randomness in the app; a fixed string in tests for determinism)
export function newProfile(entropy) {
  return {
    v: 1,
    key: String(entropy),
    bankroll: START_BANKROLL,
    campaign: { n: 0 },
    round: null, // { seed, d, exhibition, daily?, phase: 'open'|'locked', slip }
    ledger: [],  // settled seeds, ring buffer of LEDGER_CAP
    stats: {
      rounds: 0, byKind: {}, biggestWin: 0, streak: 0, bestStreak: 0, busts: 0,
      staked: 0, returned: 0,
    },
    achievements: [], // unlocked ids — see achievements.js
    daily: null,      // { last: 'YYYY-MM-DD', streak, best, plays }
    settings: {},
  };
}

export function loadProfile(store) {
  const raw = store.get(PROFILE_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    return p && p.v === 1 ? p : null;
  } catch {
    return null;
  }
}
export const saveProfile = (store, p) => store.set(PROFILE_KEY, JSON.stringify(p));
export const wipeProfile = (store) => store.del(PROFILE_KEY);

// the hidden campaign stream: 8-char base36 seeds, ≈2.8×10¹² distinct scenes
export function campaignSeed(profile, n = profile.campaign.n) {
  const r = makeRng('camp:' + profile.key + ':' + n);
  let s = '';
  for (let i = 0; i < 8; i++) s += r.int(0, 35).toString(36);
  return s;
}

export const seedSettled = (profile, seed) => profile.ledger.includes(seed);

/* ---------------- rounds ---------------- */
// deal the next campaign round (or restore an unfinished one — boot always
// resumes: the seed re-deals deterministically, the slip draft is restored)
export function currentRound(profile) {
  if (profile.round) return profile.round;
  const seed = campaignSeed(profile);
  profile.round = { seed, exhibition: false, phase: 'open', slip: null };
  return profile.round;
}

// a custom/shared/replayed seed — always Exhibition (also when a campaign
// seed already settled once: re-watch forever, never re-bet for money)
export function exhibitionRound(profile, seed) {
  profile.round = { seed: String(seed), exhibition: true, phase: 'open', slip: null };
  return profile.round;
}

/* ---------------- the daily seed (G5) ----------------
   One scene a day, the same one for everybody, playable once. It is a normal
   MONEY round with a fixed seed rather than a special case: the settled-seed
   ledger already enforces "once per profile", so a second attempt naturally
   falls through to Exhibition via the same rule that governs a replayed
   campaign seed. profile.daily only exists to drive the streak + the UI. */

// local calendar date — the daily rolls over at the player's own midnight
export function dailyKey(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

// derived from the DATE ALONE (no profile key) so every player shares the scene
export function dailySeed(key = dailyKey()) {
  const r = makeRng('daily:' + key);
  let s = '';
  for (let i = 0; i < 8; i++) s += r.int(0, 35).toString(36);
  return s;
}

export function dailyInfo(profile, key = dailyKey()) {
  const d = profile.daily || {};
  const seed = dailySeed(key);
  return {
    key, seed,
    // "used up" = the seed is in the ledger; profile.daily.last alone would be
    // fooled by a wiped-but-not-reset profile, and the ledger is the same
    // authority settleRound() consults
    played: seedSettled(profile, seed) || d.last === key,
    streak: d.streak || 0, best: d.best || 0, plays: d.plays || 0,
  };
}

export function dailyRound(profile, key = dailyKey()) {
  const seed = dailySeed(key);
  profile.round = { seed, exhibition: false, daily: key, phase: 'open', slip: null };
  return profile.round;
}

// called at settlement: advances the streak if yesterday's daily was played
export function noteDaily(profile, key) {
  const d = (profile.daily = profile.daily || { last: null, streak: 0, best: 0, plays: 0 });
  if (d.last === key) return d;
  const y = new Date(key + 'T12:00:00'); // midday avoids any DST edge on ±1 day
  y.setDate(y.getDate() - 1);
  d.streak = d.last === dailyKey(y) ? d.streak + 1 : 1;
  if (d.streak > d.best) d.best = d.streak;
  d.last = key;
  d.plays = (d.plays || 0) + 1;
  return d;
}

/* ---------------- the slip ---------------- */
export const makeSlip = () => ({ legs: [], parlay: null }); // leg: {id, stake}; parlay: {ids: [], stake}

// combined parlay odds in hundredths, capped ×500 — pure integer math
export function parlayOddsH(ids, markets) {
  let acc = 100;
  for (const id of ids) {
    const m = markets.find((x) => x.id === id);
    if (!m) return 0;
    acc = Math.floor((acc * m.oddsH) / 100);
    if (acc >= PARLAY_CAP) return PARLAY_CAP;
  }
  return acc;
}

// validate against the market list and the CURRENT bankroll. Returns
// { ok, total, errors } — never mutates anything.
export function validateSlip(slip, markets, bankroll) {
  const errors = [];
  const ids = new Set();
  let total = 0;
  const known = (id) => markets.some((m) => m.id === id);
  for (const leg of slip.legs) {
    if (!Number.isInteger(leg.stake) || leg.stake < 1) errors.push(`stake ${leg.stake} not an integer ≥ $1`);
    if (!known(leg.id)) errors.push(`unknown market ${leg.id}`);
    if (ids.has(leg.id)) errors.push(`duplicate single on ${leg.id}`);
    ids.add(leg.id);
    total += leg.stake;
  }
  if (slip.parlay) {
    const p = slip.parlay;
    if (!Number.isInteger(p.stake) || p.stake < 1) errors.push('parlay stake not an integer ≥ $1');
    if (p.ids.length < 2) errors.push('parlay needs ≥ 2 legs');
    if (new Set(p.ids).size !== p.ids.length) errors.push('parlay has duplicate legs');
    for (const id of p.ids) if (!known(id)) errors.push(`unknown parlay market ${id}`);
    total += p.stake;
  }
  if (total < 1 && (slip.legs.length || slip.parlay)) errors.push('empty stakes');
  if (total > bankroll) errors.push(`total $${total} exceeds bankroll $${bankroll}`);
  return { ok: errors.length === 0, total, errors };
}

// place = deduct the stakes NOW and store the slip on the round (the draft
// survives reloads via the profile). Exhibition rounds stake nothing.
export function placeSlip(profile, slip, markets) {
  const round = profile.round;
  if (!round || round.phase === 'settled') return { ok: false, errors: ['no open round'] };
  const v = validateSlip(slip, markets, round.exhibition ? Infinity : profile.bankroll);
  if (!v.ok) return v;
  if (!round.exhibition) {
    profile.bankroll -= v.total;
    profile.stats.staked += v.total;
  }
  round.slip = slip;
  round.staked = v.total;
  return v;
}

/* ---------------- settlement ---------------- */
// settle the round's slip against the recording. Returns a full report and
// applies money/ledger/stats — UNLESS the round is Exhibition or the seed
// already settled once (then the report is computed but nothing changes).
export function settleRound(profile, markets, rec) {
  const round = profile.round;
  if (!round) return null;
  const slip = round.slip || makeSlip();
  const already = seedSettled(profile, round.seed);
  const forMoney = !round.exhibition && !already;

  const legs = slip.legs.map((leg) => {
    const m = markets.find((x) => x.id === leg.id);
    const win = m ? settleMarket(m, rec) : false;
    return { id: leg.id, stake: leg.stake, oddsH: m ? m.oddsH : 0, win, payout: win ? Math.floor((leg.stake * m.oddsH) / 100) : 0 };
  });
  let parlay = null;
  if (slip.parlay) {
    const oddsH = Math.min(parlayOddsH(slip.parlay.ids, markets), PARLAY_CAP);
    const wins = slip.parlay.ids.map((id) => {
      const m = markets.find((x) => x.id === id);
      return m ? settleMarket(m, rec) : false;
    });
    const win = wins.every(Boolean);
    parlay = { ids: slip.parlay.ids, stake: slip.parlay.stake, oddsH, win, payout: win ? Math.floor((slip.parlay.stake * oddsH) / 100) : 0 };
  }
  const payout = legs.reduce((a, l) => a + l.payout, 0) + (parlay ? parlay.payout : 0);
  const staked = round.staked || 0;

  let busted = false;
  if (forMoney) {
    profile.bankroll += payout;
    profile.stats.returned += payout;
    profile.stats.rounds++;
    for (const l of legs) {
      const m = markets.find((x) => x.id === l.id);
      const kind = m ? m.kind : '?';
      const k = (profile.stats.byKind[kind] = profile.stats.byKind[kind] || { bets: 0, wins: 0 });
      k.bets++;
      if (l.win) k.wins++;
    }
    const net = payout - staked;
    if (net > profile.stats.biggestWin) profile.stats.biggestWin = net;
    if (payout > 0 && net >= 0 && staked > 0) {
      profile.stats.streak++;
      if (profile.stats.streak > profile.stats.bestStreak) profile.stats.bestStreak = profile.stats.streak;
    } else if (staked > 0) profile.stats.streak = 0;
    profile.ledger.push(round.seed);
    if (profile.ledger.length > LEDGER_CAP) profile.ledger.splice(0, profile.ledger.length - LEDGER_CAP);
    if (round.seed === campaignSeed(profile)) profile.campaign.n++;
    if (round.daily) noteDaily(profile, round.daily);
    // ROCK BOTTOM: bust is recorded, the campaign restarts at $100
    if (profile.bankroll <= 0) {
      profile.bankroll = START_BANKROLL;
      profile.stats.busts++;
      busted = true;
    }
  }
  round.phase = 'settled';
  // seed/daily ride along so the summary card can offer a share link without
  // main.js having to hold onto round state past settlement
  const report = {
    legs, parlay, staked, payout, net: payout - staked, forMoney, busted,
    bankroll: profile.bankroll, seed: round.seed, daily: round.daily || null,
    exhibition: !!round.exhibition,
  };
  profile.round = null;
  return report;
}
