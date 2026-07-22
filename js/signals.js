// signals.js — traffic signal programs (P2/2I).
//
// A signal program is a plain object and its evaluation is a PURE function of
// the tick: no rng at eval time, no state carried between ticks, integer
// arithmetic only. That is the whole design constraint. The sim reads it to
// decide whether a car stops, so it settles money — it has to be bit-identical
// in node and the browser, and it has to give the same answer whether it is
// asked at tick 0, asked again at tick 599, or asked out of order by a scrub
// that jumped backwards.
//
// Before this, `traffic_light` props picked one lamp at build time and stood
// there. director.js said so outright: "signals on opposing corners (cosmetic
// state for now — G3 parameterizes)".
//
// Arms are keyed by the same string lanes already carry as `road` ('ew'/'ns'),
// so a lane knows which signal governs it without any extra plumbing.

export const RED = 0, AMBER = 1, GREEN = 2;

/* A program is { period, offset, stages: [{ arms, g, a }], r }.
   Each stage runs `g` ticks green then `a` ticks amber for its own arms, and
   every other arm sees red throughout; `r` is the all-red gap that follows
   each stage, which is what stops a program from handing two crossing arms
   green on the same tick. period is the sum and is stored rather than
   recomputed so eval stays branch-free. */
export function makeSignalProgram(rng, armGroups, opts = {}) {
  /* Green lengths are compressed against real signals on purpose. The whole
     preview is 600 ticks, so a realistic 20 s phase would never change on
     screen and the lights would look as static as the ones this replaces.
     A period near 550-780 shows the player roughly one full cycle. */
  const gMin = opts.gMin || 200, gMax = opts.gMax || 320;
  const amber = opts.amber || 45;
  /* INTERGREEN — amber plus all-red — has to cover the time it takes a car
     that entered on green to CLEAR the junction, or the conflicting arm goes
     green underneath it. A signalized junction is ~19 m across and traffic
     runs at ~12 m/s, so clearance is ~1.6 s; at the original all-red of 20
     ticks the total intergreen was 65 ticks (1.1 s) and cars legitimately
     mid-junction were being T-boned by traffic that had just been waved
     through. 45 + 80 = 125 ticks ≈ 2.1 s.
     G6: 80 → 110 (intergreen 155 ≈ 2.6 s). The bigger ambient casts exposed
     the flowing-arrival case: a car that committed on amber from the far
     edge of its stop envelope is still clearing as a cross car arrives AT
     SPEED exactly on the green — the driver's amber rule got harder too
     (physics.js), and the two changes together put ~0.5 s of clearance
     margin on the worst case instead of ~0. */
  const allRed = opts.allRed == null ? 110 : opts.allRed;
  const stages = armGroups.map((arms) => ({
    arms: arms.slice(),
    // integers: a program is compared and summed on tick boundaries, and a
    // fractional stage length would put the cycle a fraction out per lap
    g: Math.round(gMin + rng.range(0, gMax - gMin)),
    a: amber,
  }));
  const period = stages.reduce((n, s) => n + s.g + s.a + allRed, 0);
  return { period, offset: 0, stages, r: allRed };
}

// state of one arm at one tick. Unknown arm -> GREEN: an arm nobody signals is
// an arm nobody has to stop for, and returning RED there would silently park
// every car on an unsignalled approach.
export function signalAt(prog, arm, tick) {
  if (!prog) return GREEN;
  /* `governed` has to be settled BEFORE the walk. The walk returns from
     inside the loop, so an arm appearing only in a LATER stage was being
     reported red on the strength of stages it was never part of — i.e. the
     exact "unsignalled approach parks every car" failure the fallback above
     exists to prevent. The first version of this function shipped that bug
     and the ew/ns test could not see it, because both of those arms are
     governed by stage 0 or 1. */
  let governed = false;
  for (const st of prog.stages) if (st.arms.indexOf(arm) >= 0) { governed = true; break; }
  if (!governed) return GREEN;
  let p = (tick + prog.offset) % prog.period;
  if (p < 0) p += prog.period;
  for (const st of prog.stages) {
    const mine = st.arms.indexOf(arm) >= 0;
    if (p < st.g) return mine ? GREEN : RED;
    p -= st.g;
    if (p < st.a) return mine ? AMBER : RED;
    p -= st.a;
    if (p < prog.r) return RED;
    p -= prog.r;
  }
  return RED;
}

/* Shift the cycle so `arm` is solidly green at `tick`.

   This is what keeps the tick-600 promise intact. Every incident is
   choreographed to land at INCIDENT_TICK, and `place()` budgets each car's
   run-up assuming free-flow cruise — so if the actor's own approach went red
   mid-run the whole scene would arrive late and the odds would be priced on a
   scene that never happened. Rather than exempt the actors from physics, the
   PROGRAM is phased so their arm genuinely is green when they get there.

   Lands the target at `frac` through that stage's green — MID-green by
   default, which is the choice that maximises the smaller of the two margins
   either side. At 0.55 the tightest case left only 77 ticks (1.28 s) of green
   after the incident. */
export function phaseFor(prog, arm, tick, frac = 0.5) {
  if (!prog) return prog;
  let acc = 0, at = -1;
  for (const st of prog.stages) {
    if (st.arms.indexOf(arm) >= 0) { at = acc + Math.round(st.g * frac); break; }
    acc += st.g + st.a + prog.r;
  }
  if (at < 0) return prog; // arm not governed: nothing to phase
  let off = (at - tick) % prog.period;
  if (off < 0) off += prog.period;
  return { ...prog, offset: off };
}

// how long `arm` stays green from `tick` (0 if it is not green now). Used to
// decide whether a car far back has room to clear the junction before amber.
export function greenRemaining(prog, arm, tick) {
  if (!prog) return Infinity;
  if (signalAt(prog, arm, tick) !== GREEN) return 0;
  let n = 0;
  while (n < prog.period && signalAt(prog, arm, tick + n) === GREEN) n++;
  return n;
}
