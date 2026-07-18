# Lowpoly Garage — Procedural Vehicle Generator

A seeded, procedural low-poly 3D vehicle generator built with Three.js. **92 vehicle
archetypes** in 9 categories — sedans, lowriders, hearses, semis with 6 trailer types
(incl. container & car-carrier), road trains, fire trucks, monster trucks, trophy trucks,
F1 racers, dragsters, stock cars, ice-cream vans, SWAT & armored vans, articulated buses,
trams, bulldozers, excavators, wheel loaders, road rollers, mining haulers, crane trucks,
tractors, motorcycles, quads, snowmobiles, tuk-tuks, kei trucks, humvees, double-deckers,
boat & caravan tow combos and more — each with randomized proportions, paint, wheels and
accessories per seed. Effectively endless variations.

![style](https://img.shields.io/badge/style-flat--shaded%20low--poly-orange)

## Run it

```
run.bat
```

…or any static file server from this folder, e.g. `npx http-server -p 5183 -c-1 .`
then open http://localhost:5183. Fully offline — Three.js r169 is vendored in `libs/`.

Works on desktop and mobile (touch orbit/pinch zoom), installs as a PWA, and keeps
working offline thanks to a service worker.

## Controls

| Action | How |
| --- | --- |
| New vehicle | **Generate** button, `G`, or `Space` |
| Specific seed | Type anything in the Seed box, press Enter |
| Vehicle type | Type dropdown (92 archetypes in 9 categories, or "Surprise me") |
| Cycle types | `T` (Shift+T backwards) — keeps the current seed |
| Paint override | Color chips (Auto = per-seed palette) |
| Turntable on/off | Spin button or `R` |
| Fleet view | Fleet button or `F` — parks 40 seeded vehicles in rows |
| Snapshot | Camera button — saves a PNG (system share sheet on mobile) |
| Export 3D model | Download button — saves the current vehicle (or whole fleet) as `.glb` |
| Favorites | `★` next to the seed box — saved builds appear in the type dropdown |
| Slideshow | `S` — auto-generates a new vehicle every few seconds |
| History back/forward | `◀` `▶` buttons or arrow keys |
| Share | Click the name chip — copies a URL with `?seed=&type=&paint=` |

There's also a **1-in-100 golden vehicle** easter egg — gold chrome paint and ✨ in the
name (only when no paint override is active).

## How it works

- `js/lib.js` — seeded RNG (xmur3 + mulberry32), weighted paint palettes, and the
  geometry kit: `slab` (two-rectangle frustum — every chamfered body panel),
  `wedge` (plan-tapered solids), and `quadPrism`/`panesOnQuad` which place windows,
  lights and grilles *flush on any face*, including sloped windshields.
- `js/parts.js` — wheels/axles, bumpers, mirrors, light bars, ladders, cones,
  awnings, cargo (logs/crates/barrels), exhaust stacks, spoilers…
- `js/families.js` — parameterized family builders: `car()`, `truckFront()+chassis()`,
  `van()`, `bus()` — most archetypes are configs of these.
- `js/vehicles.js` — special builds (F1, hot rod, monster, tractor, forklift, bikes,
  semi + trailer combos, road train, car+caravan, SUV+boat…) and the type registry.
- `js/names.js` — seeded name generator ("Crimson Badger GT", "Engine No. 7"…).
- `js/main.js` — scene, studio lighting (ACES, soft shadows, env reflections),
  camera auto-framing per vehicle size, spawn animation, render-on-demand loop,
  fleet view, snapshot/GLTF export, UI wiring, URL state, PWA registration.

Same seed + same type + same paint ⇒ identical vehicle, always.

## Dev extras

- `?smoke=1` — builds every archetype × 4 seeds at boot and logs failures to console.
- `?sheet=1` — renders a contact sheet of all 92 archetypes into one tiled canvas.
- `window.__app` — renderer/scene/camera/generate exposed for debugging.
