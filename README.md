# Lowpoly Garage — Procedural Vehicle Generator

A seeded, procedural low-poly 3D vehicle generator built with Three.js. **88 vehicle
archetypes** in 9 categories — sedans, lowriders, hearses, semis with 6 trailer types
(incl. container & car-carrier), fire trucks, monster trucks, trophy trucks, F1 racers,
dragsters, stock cars, ice-cream vans, SWAT & armored vans, articulated buses, trams,
bulldozers, excavators, wheel loaders, road rollers, mining haulers, crane trucks,
tractors, motorcycles, quads, snowmobiles, tuk-tuks, kei trucks, humvees, double-deckers
and more — each with randomized proportions, paint, wheels and accessories per seed.
Effectively endless variations.

![style](https://img.shields.io/badge/style-flat--shaded%20low--poly-orange)

## Run it

```
run.bat
```

…or any static file server from this folder, e.g. `npx http-server -p 5183 -c-1 .`
then open http://localhost:5183. Fully offline — Three.js r169 is vendored in `libs/`.

Works on desktop and mobile (touch orbit/pinch zoom).

## Controls

| Action | How |
| --- | --- |
| New vehicle | **Generate** button, `G`, or `Space` |
| Specific seed | Type anything in the Seed box, press Enter |
| Vehicle type | Type dropdown (88 archetypes in 9 categories, or "Surprise me") |
| Paint override | Color chips (Auto = per-seed palette) |
| Turntable on/off | Spin button or `R` |
| History back/forward | `◀` `▶` buttons or arrow keys |
| Share | Click the name chip — copies a URL with `?seed=&type=&paint=` |

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
  semi + trailer combos, car+caravan…) and the type registry.
- `js/names.js` — seeded name generator ("Crimson Badger GT", "Engine No. 7"…).
- `js/main.js` — scene, studio lighting (ACES, soft shadows, env reflections),
  camera auto-framing per vehicle size, spawn animation, UI wiring, URL state.

Same seed + same type + same paint ⇒ identical vehicle, always.

## Dev extras

- `?smoke=1` — builds every archetype × 4 seeds at boot and logs failures to console.
- `window.__app` — renderer/scene/camera/generate exposed for debugging.
