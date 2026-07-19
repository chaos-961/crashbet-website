# World-Building Brief (improved prompt)

> This is the cleaned-up, actionable version of the original request. It is the
> source of truth for the P1–P3 roadmap tracked in CLAUDE.md.
>
> **Reference images**: drop the three originals in this folder as
> `reference-1-suburbs.png`, `reference-2-city.png`, `reference-3-roads.png`.
> A full text inventory of each is below so work can proceed without them.

## The ask

Extend Crash Bet's seeded low-poly generator beyond vehicles into a full
**world-object library** matching the look of the reference asset-pack images
(soft-shaded flat low-poly, chunky silhouettes, tasteful muted palettes),
entirely in code — no meshes, no textures on disk, same `lib.js` geometry kit,
same determinism contract (same seed ⇒ identical object).

1. **Every model is a seeded procedural builder** with real variation: colors,
   proportions, story counts, roof styles, sign text, canopy shapes, cargo…
   Spawnable in the editor like props, saved in the share URL, and with
   explicit physics collider recipes — light stuff (cones, signs, bins) is
   dynamic and knockable, heavy stuff (houses, guardrails) is fixed.
2. **Roads are NOT tile models.** They get a dedicated spline-based system
   (control points → swirly ribbon meshes with lane markings, curbs, crossings)
   so future procedural generation can route roads freely instead of snapping
   straight tiles together.
3. **End goal (P3)**: a procedural environment generator — pick a preset
   (suburb / city block / highway), get a seeded scene built from the road
   system + scenery library, ready to crash cars into.

Quality bar: "pro asset pack" — every model should look intentional from the
default camera, read clearly at gameplay distance, and hold up in close-ups.

## Deliverable phases

- **P1 — Scenery library** (`js/scenery.js`): ~50 registry-driven builders in
  4 categories (Nature, Suburbia, Street & City, Signs & Traffic), editor
  spawn UI, URL persistence (`prop=kind~x~z~deg~seed`), physics integration,
  smoke + determinism tests.
- **P2 — Spline road system** (`js/roads.js`): Catmull-Rom control-point
  roads; asphalt ribbon + geometry lane markings + curbs; editor road tool;
  URL codec; deterministic curb colliders.
- **P3 — Procedural environments**: seeded generators that lay out roads,
  lots, houses, trees and street furniture into complete scenes; perf pass
  (instancing/merging) once object counts grow.

## Reference image inventory

### Image 1 — suburban pack (`reference-1-suburbs.png`)
- 5 suburban houses: 1–2 stories, gable/hip roofs (navy, red, brown, gray),
  beige/green/blue siding, porches with columns, attached garages with paneled
  doors, chimneys, on green lawn plots with sidewalk strips and shrubs.
- Trees: round blob tree, tall pine, cypress; box hedges (several lengths),
  round bushes, rocks (gray, faceted), cattails/reeds.
- Fences: white picket runs + gates, wood picket variant.
- Yard/park: flower planter boxes (mixed tulips), mailboxes (post type, 3
  styles), trash bins (green/blue/black/steel), playground (red/blue swing +
  slide combo), sandbox, gazebo (white, octagonal, dark roof), tiered stone
  fountain, picnic table.
- Street furniture: classic lantern lampposts + modern poles, fire hydrant,
  utility cabinets (green/gray/red), striped barricades, traffic cones,
  jersey barriers (white, red), guardrail segment.
- Signs: stop, yield, speed limit 25, no parking, no entry, pedestrian
  crossing, curve warning, green street-name blade on pole.
- Road/ground pieces (→ P2): straight/corner/T/cross road tiles with lane
  paint, crosswalks, arrows, sidewalk slabs, curb ramps, manhole + drain
  covers, speed bumps.

### Image 2 — city pack (`reference-2-city.png`)
- Small buildings: corner shops with awnings + parapets, 2–3 story mixed-use
  (red/blue/green roofs), storefront glass, roof AC units.
- Traffic lights: 4 pole styles (mast arm, double head), street lights,
  overhead sign gantries (green NORTH/EXIT, blue city sign), toll-style gate.
- Park: big tiered fountain, pond with rock edge + lily pads + cattails,
  benches, picnic tables, cafe table with umbrella, food cart with striped
  awning, planters + potted flowers (many colors), hedges.
- Trees: round, pine, palm, pink/orange blossom varieties.
- Street: bus stop shelter (blue roof, glass), billboards small/large, bike
  racks, mail drop boxes (red/blue/green/yellow), dumpsters (green/blue/black),
  wheelie bins, electrical boxes, stone blocks/bollards, retaining walls,
  speed bump, sign row (warning diamonds, no-entry…).

### Image 3 — road & traffic-control pack (`reference-3-roads.png`)
- Roads (→ P2): multi-lane straights with white/yellow paint, gentle + sharp
  curves, 4-way and T intersections with crosswalks, turn-lane arrows,
  highway merges/on-ramps, medians, end caps, curb pieces, rumble strips.
- Overhead: sign gantry trusses, big green guide signs (NORTH ↑, EXIT →,
  CITY CENTER, AIRPORT), blue service signs.
- Traffic lights: 3 mast-arm styles + pedestrian signals; cobra street lights.
- Control devices: VMS matrix trailer ("DRIVE SAFE"), arrow board trailer,
  cones, drum/delineator posts (orange/white), type-III barricades with
  chevrons, water-filled barriers (orange/white), concrete jersey barriers,
  guardrails, crash attenuator, striped end barricades, speed bumps
  (yellow/black), stop/yield/speed 50/one-way/do-not-enter sign set.

## Style rules (carried over from the vehicle generator)

- Flat-shaded non-indexed geometry, `slab()`/`wedge()`/`hexa()` first, boxes
  and low-seg cylinders second; details flush via `faceQuad`/`quadPrism`.
- Muted saturated palette, sRGB HSL jitter per seed (`jitterColor`).
- Zero `Math.random()` in builders — only the passed seeded rng.
- Text (signs) via in-memory CanvasTexture only — visual, never sim-relevant,
  guarded so headless node builds still work.
- Ground = y 0, forward = +X, builders return groups + explicit collider
  recipes (never parsed from geometry).
