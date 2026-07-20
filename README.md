# Crash Bet

**A betting game about reading physics.**

Every round deals a seeded, procedurally generated traffic scene that is secretly ten
seconds from disaster. You watch it play, bet fake money on what the chaos will do —
which car crashes, whether the hydrant pops, who flips, what survives — then time
resumes and a deterministic physics sim settles every bet with zero ambiguity.

One bankroll. $100 to start. Skill is scene-reading.

Vanilla JS + Three.js r169 + Rapier 3D — both vendored. No build step, no dependencies,
fully offline, installs as a PWA.

![style](https://img.shields.io/badge/style-flat--shaded%20low--poly-orange)

## Run it

```
run.bat
```

…or any static file server from this folder, e.g. `npx http-server -p 5183 -c-1 .`
then open http://localhost:5183. (ES modules will not load from `file://`.)

## One round, beat by beat

1. **Deal.** The campaign draws a difficulty 1–10 on a geometric rarity curve
   (level 1 ≈ 38 % of rounds, level 10 ≈ 0.4 %) and a scene seed from a hidden
   per-profile stream. The director assembles a topology, a cast and an incident, then
   **pre-simulates the whole outcome headlessly** behind a loading beat. The odds engine
   never sees the result — only settlement does.
2. **Watch.** Ten seconds of normal-looking traffic with the tell hidden in plain sight:
   a van drifting in its lane, a light about to change. Betting is open the whole time,
   from any camera.
3. **Lock.** Time freezes on the exact incident tick. Study the frozen scene, drag the
   scrub bar to rewind the last ten seconds, then press **BET** to resume. At level 8+
   there is no freeze — the slip has to be in before it happens. That pressure *is* the
   difficulty.
4. **Resolve.** Physics runs to rest with auto slow-mo and a camera push-in on the first
   big impact. Bet chips settle live as their triggers pass.
5. **Payout.** Winnings count up, a scene card recaps the wreck, and every camera angle
   unlocks for replay.

Bust at $0 and the bank stakes you a fresh $100. Vehicles and property only — nobody is
ever in these cars.

## What's in it

| | |
| --- | --- |
| Vehicles | **92** seeded archetypes — same seed ⇒ identical vehicle, always |
| Scenery | **102** procedural models (nature, suburbia, city, traffic) |
| Topologies | **10** — intersection, suburb, city, highway, causeway, switchback, school zone, tram crossing, parking lot, roundabout |
| Incidents | **20** templates — red-light runner, brake failure, blowout, drowsy drift, jackknife, load spill, PIT, wrong-way, ramp jump… |
| Markets | per-vehicle, per-object, scene-wide over/unders, template specials |
| Achievements | **16** |

Difficulty also gates **near-misses** (5+), **decoys** (6+), **multi-incident scenes**
(7+) and camera coverage — level 1–3 gives you every angle, level 8+ can be a single
grainy CCTV feed.

## Modes

- **Continue** — the campaign. Real bankroll, hidden seeds, one settlement per seed.
- **Daily** — one date-derived scene a day, the same for everybody, one attempt.
- **Custom seed** — any text is a valid scene. Always Exhibition: fully playable, never
  moves your bankroll.
- **Garage** — the showroom: every model in the game, laid out to browse.
- **Crash test** — 8 seeded set-piece wrecks with the full damage + FX stack.

## Cameras

Orbit, freecam (WASD + mouse look on desktop, twin-stick on touch), and a per-scene rig
of dashcams, CCTV poles, a news chopper and witness tripods. The freecam carries a
crosshair: whatever it rests on can be bet on.

## How it works

Determinism is the product. The pre-simulated recording the bets settle against **is**
the scene you watch, bit for bit, in any browser or in node.

- `js/lib.js` — seeded RNG (xmur3 + mulberry32) and the low-poly geometry kit.
- `js/parts.js` · `js/families.js` · `js/vehicles.js` — the vehicle generator.
- `js/scenery.js` · `js/props.js` · `js/roads.js` · `js/worldgen.js` — the world:
  procedural models, spline roads with elevation, generated neighbourhoods.
- `js/physics.js` — Rapier raycast-vehicle sim at a fixed 60 Hz. Zero randomness,
  stable creation order, FNV state hashing. Also the driver controller (pure pursuit,
  arithmetic-only so it is bit-identical across JS engines).
- `js/deform.js` — plastic crumple deformation, purely contact-driven.
- `js/director.js` — the incident engine: topologies, templates, choreography.
- `js/recorder.js` — the headless pre-sim and its event log.
- `js/markets.js` — market generation + odds, **outcome-blind by construction**.
- `js/economy.js` — bankroll, slip, settlement, persistence.
- `js/betui.js` · `js/povcam.js` · `js/main.js` — the game shell.

## Tests

All headless, no framework:

```
node tests/simpins.mjs      # 10 pinned determinism scenarios — the sim's guardrail
node tests/scrub.mjs        # rewinding and replaying reproduces the exact scene
node tests/economy.mjs      # money rules, daily seed, achievements
node tests/sweep.mjs        # scene-generation acceptance across difficulties
node tests/montecarlo.mjs   # realized house edge per difficulty (slow)
node tools/calibrate.mjs    # regenerate the odds calibration table
```

In-browser: `?smoke=1` (build every model), `?simtest=1` (determinism self-test),
`?sheet=1` (contact sheet), `?scene=<seed>~<d>` (jump straight into a round),
`?crash=N` (crash-test scene N).

## Save data

One profile in `localStorage["crashbet.profile.v1"]`: bankroll, campaign cursor, the
current round and its slip draft, a settled-seed ledger, stats, achievements, settings.
"New run" wipes it after a confirm.
