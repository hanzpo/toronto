# Performance results

Benchmarks live in `app/perf/` and drive one headless Chrome session (WebGPU,
1600×1000, DPR 1, vsync-capped at 60 Hz) through `@playwright/cli`:

```sh
app/perf/run.sh [base-url] [scenarios] [extra-query]
app/perf/run.sh                                       # dev, all frame scenarios
app/perf/run.sh https://toronto.hanznathanpo.workers.dev street,region
app/perf/run.sh http://localhost:5173 startup         # cold + warm load timing
app/perf/run.sh http://localhost:5173 draws "cam=-975,-867,30,90,7"   # draw census (main / shadow pass)
app/perf/run.sh http://localhost:5173 shots "out=/abs/dir"            # visual regression views
```

Frame scenarios: `street` (King & Spadina at eye level, walk east while looking
around), `streetcar` (chase the nearest 504), `dvp` (take over a car at
E 1800 N 2600 and drive), `city` (default oblique), `region` (70 km view),
`zoom` (wheel in/out ×2), `pan` (drag ×2). Each reports fps, frame-interval
percentiles, frames over 50 ms, main-thread ms per layer (`engine.perf.acc`),
draw calls and triangles as counted by the renderer (main + shadow pass), and
tile fetch latency. `?quality=high` pins the governor so runs compare.

Machine: M-series MacBook. Numbers are noisy when other work runs on the
machine (a Safari tab with the app and other agents were active during the
"after" runs: load average 5–17); triangles and draw calls are exact.

## Street level, King & Spadina (dev)

| | before | after |
|---|---|---|
| triangles (avg / max) | 11.0 M / 12.2 M | **3.2 M / 4.1 M** |
| draw calls (avg / max) | 444 / 511 | **266 / 310** |
| main-thread ms / frame (avg) | 7.7 (quiet machine) · 11.5 (loaded) | **4.8** (quieter) · 5.6–6.2 (loaded) |
| `render` ms (three.js submit) | 5.0 · 8.0 (loaded) | **2.6** · 3.5–3.8 (loaded) |
| transit ms | 1.6 · 2.0 | 1.1–1.3 |
| traffic ms | 0.8 · 1.0 | 0.4 |
| fps | 59.8 | 60 |

Draw census at King & Spadina (one frame): main 366 → 210, shadow 86 → 60
(landmarks 74 + 29 → ~25 + ~20; tile draws 200 → 100).

## All scenarios (dev, `quality=high`)

| scenario | before: tris / draws / cpu ms / worst frame | after |
|---|---|---|
| street | 11.0 M / 444 / 7.7 / 50 ms | 3.2 M / 266 / 4.8–6.2 / 22 ms |
| streetcar 504 | 11.9 M / 504 / 7.7 / 21 ms | 3.4 M / 284 / 5.5 / 28 ms |
| DVP drive | 9.7 M / 548 / 7.8 / 19 ms | 3.3–4.0 M / 261–284 / 5.6–6.1 / 23 ms |
| region | 1.5 M / 309 / 6.1 / 18 ms | 1.5 M / 224 / 5.6 / 19 ms |
| zoom | 4.9 M / 463 / 8.3 / 26 ms, 0 > 50 ms | 2.7 M / 314 / 8.1 / 37 ms, 0 > 50 ms (loaded machine) |
| pan | 10.8 M / 582 / 8.9 / 18 ms | 3.4 M / 238 / 8.2 (page reloaded mid-run by another agent's edit) |

## Startup (dev server, headless Chrome, fresh profile)

| | before | after |
|---|---|---|
| first frame / first tile | — | 221 ms / 280 ms |
| all layers ready (cold) | 2.75 s | 1.74 s |
| view settled (no pending tiles), cold | 8.65 s | **1.90 s** |
| long tasks in first 8 s (cold) | 5, 475 ms | 3, 194 ms |

Deployed site before this pass (https://toronto.hanznathanpo.workers.dev):
cold settle 8.4 s with a single 3.1 s long task (+0.86 s) — the CPU profile
shows 1.65 s of it in three's `updateAttribute`: every instanced pool used
`DynamicDrawUsage`, which in three's WebGPU backend re-uploads the *whole*
buffer on every render pass (main and shadow), ignoring update ranges —
~2.8 GB/3 s of `writeBuffer` in a dev profile. Warm settle 4.2 s. Main JS
491 kB (165 kB gz) + three 688 + 243 kB. Hashed assets were served
`max-age=0, must-revalidate`; edge-cached tile hits ~50 ms, misses 200–400 ms.

After (build output): main chunk 101 kB (37 kB gz) + React 219 kB (68 kB gz,
own long-lived chunk) + three; every layer is its own chunk (Transit 47,
Interact 49, Landmarks 40, Traffic 33, Air 28 kB …), all requested in
parallel at start. Deployed numbers: re-run `app/perf/run.sh <url> startup`
after the deploy.

## What changed

Rendering
- Detail rings + per-instance frustum culling (`engine/view.ts`, `ctx.view`):
  traffic cars (full models < 320 m, 30-triangle stand-ins beyond, no shadow),
  pedestrians (full < 170 m, simple figures to 650 m, none beyond), transit
  consists and markers (culled beyond max(10 km, 40 × altitude) at street
  level), aircraft.
- Houses: full archetypes (shadow casters) for tiles within ring 1, a
  12-triangle block beyond; tile-level switch with hysteresis.
- Level-0 tiles only refine in within ~1.9 km of the camera at street level,
  growing back to the old 4 km range by ~1.1 km altitude (L1 tiles — simplified
  buildings ≥ 12 m, roads in the ground raster — are ring 2+).
- Far tiles whose projected height is < 0.6 px (flat ground at grazing angles)
  skip their terrain draw; road surfaces seen at < 1.2° beyond ring 1 skip too.
- Rail merged into the roads mesh in the tile worker (same material; the rail
  toggle uses draw ranges): one draw per tile less.
- Landmarks clustered (≤ 2.5 km) and baked per material with cluster-level
  LOD: ~75 + 30 shadow draws downtown → ~25 + 20.
- Shadows: only ring-0 casters — street lamps / signal hardware cast through
  shadow-only proxies (object layer 1, rendered only by the sun's shadow
  camera) within 320 m; aircraft only within 2.5 km; far car / pedestrian /
  house pools cast none. The shadow map refreshes every frame below 120 m
  altitude, every 2nd / 3rd frame higher up, and always when the frustum or
  sun moves (texel-snapped focus, unchanged). The startup prerender stays.
- Instance buffers: static usage + update ranges (see above); houses and
  street furniture upload only the slot range that changed.
- Empty LOD pools are pipeline-compiled with `compileAsync` after start-up
  (`engine.prewarm`) so their first use doesn't stall.
- Tile subtree skipped in the per-frame matrix walk.

Main thread
- Transit `evaluate()` skips trips whose whole pattern is outside the drawn
  range at low altitude (3209 → 1643 vehicles evaluated downtown; transit
  update 0.84 → 0.32 ms in isolation).
- Adaptive quality governor (`QualityGovernor`): frame-interval EMA steps
  detail scale (ring radii, LOD distances, tile refinement) and DPR down after
  1.2 s over budget, probes back up after 5 s under it with exponential
  back-off per level. UI: Layers → Quality (Auto / High / Medium / Low),
  persisted; `?quality=` overrides.

Deployed site
- Code splitting + parallel module loading; landmarks / airports / flights
  initialise after the first tiles; bus schedules load after the first view;
  feed decoding yields between files.
- Worker: immutable caching for `/assets/*`, 1-day SWR for textures, JSON
  revalidation answers 304, pack indexes memoised in the edge cache,
  `Server-Timing` on tile responses (edge hit / index / R2 ms).
- Service worker (`app/public/sw.js`): app shell + fonts cache-first,
  navigations / JSON / schedules network-first with offline fallback (tiles are
  already cached by the tile workers per data build).
- RUM (`engine/rum.ts` → `POST /rum` → Analytics Engine dataset
  `toronto_rum`): fps, frame p50/p95, cpu ms, long frames, tile p50/p95 and
  source (local cache / edge / R2), first tile, layers ready, draws, triangles,
  DPR, quality, backend, colo. Production only; `?rum=0` disables.

## Not done / next
- GPU-driven culling + indirect draws (three 0.186 has no multi-draw-indirect
  path for InstancedMesh in WebGPU); CPU bucketing is used instead.
- Transit evaluation in a worker (remaining ~0.2 ms evaluate + ~0.8 ms layer
  loop per frame).
- GPU occlusion culling (depth pyramid); tile-level horizon culling is limited
  to the sub-pixel test above.
- Material consolidation beyond landmarks (uber-material, KTX2).
- Tiered Cache / Cache Reserve for tile misses (dashboard setting).
