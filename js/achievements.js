// achievements.js — unlockable badges (game phase G5).
//
// Pure and headless by design, exactly like markets.js/economy.js: every test
// is a function of (settlement report, recording summary, profile, difficulty)
// and nothing here touches the DOM. main.js calls evaluate() once per
// settlement and hands the newly-unlocked list to the UI.
//
// Two rules that matter:
//  - achievements only evaluate on MONEY rounds (`report.forMoney`). Exhibition
//    and replayed seeds are re-runnable at will, so unlocking on them would let
//    a player farm every badge off one known seed — the same anti-cheese logic
//    that makes those rounds pay nothing.
//  - unlocks are append-only and idempotent: evaluate() returns only ids that
//    were not already in profile.achievements, so re-settling can never
//    double-fire a toast.

// helper: total picks on the slip (singles + parlay legs)
const pickCount = (r) => r.legs.length + (r.parlay ? r.parlay.ids.length : 0);
const allWon = (r) => r.legs.every((l) => l.win) && (!r.parlay || r.parlay.win);

export const ACHIEVEMENTS = [
  {
    id: 'first-blood', icon: '🎬', name: 'First Blood',
    desc: 'Settle your first round for money.',
    test: (c) => c.profile.stats.rounds >= 1,
  },
  {
    id: 'high-roller', icon: '💰', name: 'High Roller',
    desc: 'Stake $100 or more on a single pick.',
    test: (c) => c.report.legs.some((l) => l.stake >= 100) || (c.report.parlay && c.report.parlay.stake >= 100),
  },
  {
    id: 'long-shot', icon: '🎯', name: 'Long Shot',
    desc: 'Win a pick priced at ×10.00 or better.',
    test: (c) => c.report.legs.some((l) => l.win && l.oddsH >= 1000),
  },
  {
    id: 'parlay-king', icon: '⛓', name: 'Parlay King',
    desc: 'Land a parlay of three legs or more.',
    test: (c) => !!(c.report.parlay && c.report.parlay.win && c.report.parlay.ids.length >= 3),
  },
  {
    id: 'clean-sweep', icon: '🧹', name: 'Clean Sweep',
    desc: 'Win every pick on a slip of four or more.',
    test: (c) => pickCount(c.report) >= 4 && allWon(c.report),
  },
  {
    id: 'big-score', icon: '🤑', name: 'Big Score',
    desc: 'Clear +$500 in a single round.',
    test: (c) => c.report.net >= 500,
  },
  {
    id: 'centurion', icon: '🏦', name: 'Centurion',
    desc: 'Grow the bankroll to $1,000.',
    test: (c) => c.profile.bankroll >= 1000,
  },
  {
    id: 'hot-streak', icon: '🔥', name: 'Hot Streak',
    desc: 'Win five rounds back to back.',
    test: (c) => c.profile.stats.streak >= 5,
  },
  {
    id: 'cold-read', icon: '🧊', name: 'Cold Read',
    // the hardest reads in the game — subtlest tells, biggest cast, least
    // camera coverage. (Since P2/2H the freeze is offered at every level, so the
    // challenge is the READ, not a withheld study beat.)
    desc: 'Finish a level 8+ round in profit — the subtlest tells in the game.',
    test: (c) => c.d >= 8 && c.report.net > 0,
  },
  {
    id: 'called-it', icon: '🕊', name: 'Called It',
    desc: 'Cash the "no crash" side of the headline.',
    test: (c) => c.report.legs.some((l) => {
      const m = c.markets.find((x) => x.id === l.id);
      return l.win && m && m.settle && m.settle.anyCrash === false;
    }),
  },
  {
    id: 'rock-bottom', icon: '💀', name: 'Rock Bottom',
    desc: 'Lose everything and get staked again.',
    test: (c) => !!c.report.busted,
  },
  {
    // plain single-codepoint emoji only: the ZWJ phoenix splits into two
    // glyphs on platforms that lack it, which reads as a rendering bug
    id: 'phoenix', icon: '📈', name: 'Phoenix',
    desc: 'Climb back to $500 after going bust.',
    test: (c) => c.profile.stats.busts > 0 && c.profile.bankroll >= 500,
  },
  {
    id: 'demolition', icon: '🏚', name: 'Demolition Derby',
    // scene-based, not bet-based — you only have to be there to see it
    desc: 'Witness a round that wrecks five or more objects.',
    test: (c) => c.rec.summary.propsMoved >= 5,
  },
  {
    id: 'total-loss', icon: '🔧', name: 'Total Loss',
    desc: 'See one round produce a rollover, a lost wheel and broken glass.',
    test: (c) => c.rec.summary.anyFlip && c.rec.summary.anyWheel && c.rec.summary.anyGlass,
  },
  {
    id: 'regular', icon: '🎖', name: 'Regular',
    desc: 'Play 25 rounds.',
    test: (c) => c.profile.stats.rounds >= 25,
  },
  {
    id: 'daily-devotee', icon: '📅', name: 'Devotee',
    desc: 'Play the daily seed seven days running.',
    // profile.daily is written by the daily-seed flow; guard so this simply
    // never fires on a profile that predates it rather than throwing
    test: (c) => !!(c.profile.daily && c.profile.daily.streak >= 7),
  },
];

export const byId = (id) => ACHIEVEMENTS.find((a) => a.id === id) || null;

// evaluate against a just-settled round. Returns the ids unlocked BY THIS CALL
// (already-held ones are filtered out) and mutates profile.achievements.
export function evaluate(profile, ctx) {
  if (!profile) return [];
  if (!Array.isArray(profile.achievements)) profile.achievements = [];
  // Exhibition / already-settled seeds mutate nothing — see the header note.
  if (!ctx || !ctx.report || !ctx.report.forMoney) return [];
  const have = new Set(profile.achievements);
  const full = { ...ctx, profile };
  const fresh = [];
  for (const a of ACHIEVEMENTS) {
    if (have.has(a.id)) continue;
    let ok = false;
    // a broken test must never take the settlement down with it
    try { ok = !!a.test(full); } catch { ok = false; }
    if (ok) { profile.achievements.push(a.id); fresh.push(a.id); }
  }
  return fresh;
}

export const unlockedCount = (profile) =>
  (profile && Array.isArray(profile.achievements) ? profile.achievements.length : 0);
