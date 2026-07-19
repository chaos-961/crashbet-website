# Crash Bet — Deterministic Crash-Physics Sandbox

One sandbox, full freedom: spawn seeded low-poly vehicles (**92 archetypes**, endless
seeds), drop props (ramp, barrier, box stack, pole), tune per-car physics, hit Play and
watch them crash and crumple. Everything is deterministic — the same scenario URL replays
the identical crash, frame for frame, on any machine.

Built with vanilla JS + Three.js r169 + Rapier 3D (both vendored — no build step, fully
offline, installs as a PWA).

![style](https://img.shields.io/badge/style-flat--shaded%20low--poly-orange)

## Run it

```
run.bat
```

…or any static file server from this folder, e.g. `npx http-server -p 5183 -c-1 .`
then open http://localhost:5183.

## The editor

The app boots into an empty scene. Everything happens in one unified editor:

- **Spawn** — pick a vehicle type / seed / paint, press *Spawn car*, tap the ground.
  Or drop a prop: ramp (cars jump it), concrete barrier, box stack, light pole.
- **Select & transform** — click/tap an object: orange outline + gizmo with move
  arrows (object-local X/Z) and a rotation ring. Drag the body to free-move.
  Works with mouse and touch. Hovering highlights objects.
- **Selected car** — live-edit type / seed / paint (only that car rebuilds), heading,
  launch speed, steering, throttle — plus physics: mass ×, grip ×, bounce, crumple
  softness — and launch behavior: start delay, brake-at-time, rolling start.
- **Scene** — gravity (Moon 1.6 / Earth 9.8 / Heavy 20 or anything in between),
  arena size, invisible arena walls, and four procedural environments:
  Proving Ground, Salt Flat, Night Lot, Grid.
- **Simulate** — Play / Pause / Reset / single-step / slow motion (½×, ¼×).
  Reset is perfect: the exact same run, every time.

Limits: 10 cars on desktop, 6 on mobile (plus props) — tuned to stay smooth.

## Shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `R` | Reset |
| `.` | Step one tick |
| `Delete` | Delete selected |
| `Esc` | Deselect / cancel placing |
| `F` | Focus camera on selected |
| `D` / Shift+drag | Duplicate |
| `G` | Reroll selected car's seed |
| `T` / `Shift+T` | Cycle vehicle type (keeps seed) |
| `H` | Hide / show UI |
| `?` | Shortcut overlay |

There's still a **1-in-100 golden vehicle** easter egg (only when no paint override
is active), plus PNG snapshots and `.glb` export from the top bar.

## Sharing

Click the name chip to copy the current URL — it *is* the save file. Cars, props,
gravity, environment, launch timing: everything that affects the sim is serialized as
`?scene=…&car=…&prop=…`, and loading the link reproduces the crash exactly.
Old `?seed=&type=&paint=` garage links still work.

## How it works

- `js/lib.js` — seeded RNG (xmur3 + mulberry32) and the low-poly geometry kit
  (`slab`, `wedge`, face-flush panes for windows/lights).
- `js/parts.js` / `js/families.js` / `js/vehicles.js` — the 92-archetype procedural
  vehicle generator; same seed + type + paint ⇒ identical vehicle, always.
- `js/props.js` — deterministic rigid-body props with explicit collider recipes.
- `js/env.js` — procedural environment presets (no textures, no assets).
- `js/physics.js` — Rapier raycast-vehicle sim at a fixed 60 Hz; zero randomness,
  stable creation order, FNV state hashing for the determinism self-test.
- `js/deform.js` — plastic crumple deformation (weld-group vertex displacement,
  purely contact-driven ⇒ replays bit-exact).
- `js/editor.js` — the unified editor: selection, gizmo, inspector, URL codec.
- `js/main.js` — renderer, ACES studio lighting, camera framing, PWA glue.

## Dev extras

- `?smoke=1` — builds every archetype × 4 seeds at boot and logs failures (368/368).
- `?simtest=1` — runs two scenarios (legacy 3-car crash + gravity-20 ramp-jump with
  props and tuned cars) twice each and verifies bit-identical state hashes.
- `?sheet=1` — renders a contact sheet of all 92 archetypes.
- `window.__app` — renderer/scene/editor exposed for debugging.
