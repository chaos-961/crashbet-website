# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Crash Bet" — a deterministic crash-physics sandbox on top of a seeded procedural low-poly 3D vehicle generator (92 archetypes). Vanilla JS + Three.js r169 + Rapier 3D 0.19 (`libs/rapier3d-compat.module.js`, WASM inlined). No build step, no package.json, no framework. Three.js is vendored in `libs/` (import map in `index.html` maps `three` → `./libs/three.module.js`), so the app is fully offline. Two modes: **Garage** (browse/generate vehicles) and **Crash** (place cars, launch them, watch them crumple — same scenario URL ⇒ identical crash, frame for frame).

## Running & testing

- Serve statically over HTTP (ES modules won't load from `file://`): `run.bat`, or `npx http-server -p 5183 -c-1 .` — then open http://localhost:5183. A `.claude/launch.json` config named `garage` exists for the browser preview.
- **Smoke test**: open `?smoke=1` — builds every registry type × 4 seeds at boot and logs `SMOKE DONE: N/N ok` (plus per-type stack traces) to the console. Run this after any change to `js/vehicles.js`, `js/families.js`, `js/parts.js`, or `js/lib.js`.
- **Determinism self-test**: open `?simtest=1` — runs the same 3-car crash twice (300 fixed steps), FNV-hashes every body transform per step plus the final crumpled geometry, logs `SIM DETERMINISTIC: ok/FAIL`. Run after any change to `js/physics.js` or `js/deform.js`. The hash is stable across node and browser (same wasm f32 math).
- **Headless physics testing in node** (much faster than the browser loop): `node_modules/three/` is a gitignored shim so the whole vehicle+physics chain imports in node. Import modules via `pathToFileURL`, build a `CrashSim`, call `stepOnce()` in a loop, assert on `body.translation()` / `hashState()`. See the CrashSim API in `js/physics.js`.
- Syntax check without a browser: copy a module to `.mjs` and run `node --check`.
- **Headless visual verification**: `window.__app` exposes `{ renderer, scene, camera, controls, generate, REG }`. The pattern that works even when the preview tab reports `document.hidden` (rAF suspended, screenshots time out — common in the embedded Browser pane on this machine): call `__app.generate(seed, type, { instant: true, noHist: true })`, then synchronously `__app.renderer.render(...)` and `canvas.toDataURL()`, and POST the data URL to a local sink server that writes a PNG you can then view. Deep-link a specific build with `?seed=X&type=id&paint=hex`.

## Architecture

Module chain (each imports the previous): `js/lib.js` → `js/parts.js` → `js/families.js` → `js/vehicles.js` → `js/main.js` (+ `js/names.js`). Crash side: `js/deform.js` → `js/physics.js` → `js/crash.js` → `js/main.js`. Rapier is lazy-loaded (2.2 MB) — garage boot never pays for it.

**Physics (`physics.js`) — determinism is the product.** Fixed 60 Hz timestep + accumulator; rendering interpolates between states and never feeds back. Zero `Math.random()` in sim code; bodies/colliders/wheels created in stable array order. Chassis colliders are convex hulls straight from each slab's `userData.pt` (+ big boxes/cylinders), rescaled to a per-category target mass (`CAT_PHYS`, scaled by footprint) with a no-contact ballast collider that lowers the COM. Wheels come from `userData.wheel` tags (`parts.js` `wheel()`): duals dedupe to the outer wheel, inline bikes get invisible outriggers, tracked vehicles (dozer/excavator/roller/tram) get 4 virtual wheels at bbox corners. Raycast vehicle controller per car; front-cluster wheels steer, all wheels drive. "Perfect reset" = rebuild world + vehicles from the scenario (cheap and exactly reproducible).

**Deformation (`deform.js`).** Geometry is non-indexed, so vertices weld by position (half-mm quantization) and displacement applies per weld group — faces never tear. Depth scales with contact Δv (impulse/mass, threshold 0.9 m/s), radial falloff + position-hash grain, accumulated crush clamped per group. Visual only — colliders stay rigid. Mesh↔chassis transforms are cached at build time (meshes never move relative to the wrap), so impacts convert world→mesh-local without touching render state.

**Crash mode (`crash.js`).** Scenario = car list of `{seed, type, paint, x, z, heading, speed, throttle, steer}`, serialized in the URL as repeated `car=` params (`seed~type~paint~x~z~deg~v~th~st`, `~`-separated — seeds get `~` force-escaped). Garage pickers double as the selected car's config editor. Inputs are recorded per-tick streams (`makeStream`) so constant launch params can later become real driving input. Editing while paused live-moves the wrap and debounce-rebuilds the sim; Play flushes the dirty flag first.

**Conventions that everything relies on:**
- Vehicle space: forward = **+X**, ground = **y 0**, width along z. Builders return a `THREE.Group`; `buildVehicle()` recenters it on x/z, so builders never need to center themselves.
- Determinism: same seed+type+paint ⇒ identical vehicle. Type choice, build randomness, and naming each use a *separately derived* rng (`makeRng('t:'+seed)`, `'b:'+seed+':'+typeId`, `'n:'+...`) so forcing a type doesn't shift the build's random stream. Never call `Math.random()` inside builders — always the passed `r`.

**The geometry kit (`lib.js`)** is what produces the look; prefer it over raw boxes:
- `slab(mat, {x0,x1,y0,y1,w,wT,nose,tail,noseB,tailB,shiftT})` — a frustum defined by two rectangles (chamfered box). The returned mesh carries `userData.pt`, the parameter record.
- `faceQuad(pt, 'front'|'rear'|'left'|'right')` + `subQuad` + `quadPrism`/`panesOnQuad` — place thin plates *flush on any face of a slab, including sloped ones*. All windows, headlights, taillights, and grilles work this way (`P.headlightsOn(g, M, pt)` etc.). Caveat: `faceQuad` assumes slab-shaped `pt`; on `wedge()` (plan-tapered) faces the panes skew — use round `cyl` lamps there instead (see buggy/lemans).
- `hexa(bottom4, top4)` is the underlying 8-corner solid; winding/order is exact — copy an existing call rather than deriving anew.
- All geometry is non-indexed + `computeVertexNormals()` for flat shading; materials come from the per-build `matFactory()` (`M(hex, opts)`) which dedupes by parameter key.

**Family builders (`families.js`)** — `car()`, `truckFront()`+`chassis()`, `van()`, `bus()` — are config-driven; most of the 92 registry entries are just parameter sets. Only genuinely novel shapes (F1, dragster, excavator, tram, bikes…) get bespoke builders in `vehicles.js`.

**Registry (`vehicles.js` `REG`)**: `{ id, label, cat, build(r, M, ctx) }`. `ctx.paint` is the user's paint override and must win over any `paintHex` default (`bodyHex: ctx.paint || ...`). To add a vehicle: add a REG entry (UI dropdown, counts, and smoke test pick it up automatically), optionally add a flavor-name entry in `names.js` keyed by id.

**`main.js`** owns the scene (ACES tone mapping, PMREM RoomEnvironment, shadow frustum refit per vehicle size), camera auto-framing, spawn/camera tweens, UI wiring, history stack, and URL state.

## Gotchas learned the hard way

- **Color math must stay in sRGB**: pass `THREE.SRGBColorSpace` to `getHSL`/`setHSL` (see `shade`/`jitterColor` in `lib.js`). Linear-space HSL turns saturated reds salmon.
- Look-tuning baseline (don't casually change): exposure 1.18, key light 1.7, hemi 0.55, fill 0.45; glass `#1b2836` rough 0.32 env 0.85. Brighter key lights wash colors through ACES.
- `Mesh.position` is a read-only accessor — never `Object.assign(mesh, { position: ... })`; use `mesh.position.set(...)`.
- Tall truck beds (box/garbage/army/mixer) must pass `stacks: false` to `rigidTruck` or the exhaust stacks clip through the bed.
- Old vehicles must be disposed via `disposeGroup()` (in `lib.js`) before being replaced — `generate()` already does this.
- `run.bat`'s port cleanup uses `findstr /c:` deliberately: a bare space in a `findstr` pattern means OR and will match (and kill) far too much.
- Physics wheel discovery keys off `userData.wheel` set inside `parts.js` `wheel()` — a bespoke builder that rolls its own wheel cylinders won't get suspension (it'll fall back to virtual wheels). Prefer `P.wheel`/`P.axle`.
- The crash sim's visual wheel groups get re-parented (`wrap.attach`) at rig build so the controller can drive them; garage builds are untouched.
- Rapier objects need explicit cleanup: `CrashSim.dispose()` frees the world, event queue and controllers — never drop a sim without calling it (wasm memory leaks silently).
