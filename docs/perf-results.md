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
app/perf/run.sh http://localhost:5173 views "t=2026-09-30T13:00:00&out=/abs/dir&tag=after"   # per-layer budget census + screenshots
app/perf/run.sh http://localhost:5173 flythrough "t=2026-09-30T13:00:00"                    # 3-minute memory / leak check
app/perf/run.sh http://localhost:5173 spin "t=2026-09-30T13:00:00"                          # fast rotation CPU
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

## Street-level budget pass after the consolidated merge (2026-09-30)

Budget at street level on High: ≤ 3.5 M triangles, ≤ 300 draws (main + shadow
pass), ≤ 8 ms main-thread CPU at 60 fps. Measured with `app/perf/views.js`
(one headless Chrome, 1600×1000, `quality=high`, `t=2026-09-30T13:00:00`, camera
collision off so the views stay at street level, Vite HMR socket stubbed):

```sh
app/perf/run.sh http://localhost:5173 views "quality=high&t=2026-09-30T13:00:00&out=/abs/dir&tag=after"
app/perf/run.sh http://localhost:5173 views "quality=high&t=2026-09-30T13:00:00&out=/abs/dir&tag=before&cull=0"
```

`?cull=0` switches this pass's culling off, so *before* and *after* are paired
runs minutes apart on the same code and data (the leak fix and the apron's
static buffer usage are not switchable). Draws and triangles are
`renderer.info` averages over 3 s; the per-layer rows come from a census of
~6 frames (`renderer.info.update` attributed to the top-level group / mesh,
main and shadow pass separately). The CPU column is `engine.perf.acc`; timings
are noisy (load 4–8 during the runs), counts are exact.

| view (`?cam=`) | before: tris / draws / CPU ms | after |
|---|---|---|
| King & Spadina `-1180,-620,60,40,12` | 4.90 M / 418 / 5.95 | **3.11 M / 295 / 5.40** |
| Gardiner / Spadina `-842,-1248,124.6,343,10` | 4.75 M / 393 / 5.91 | **3.07 M / 268 / 5.01** |
| Harbour, 460 m `-600,-1500,800,0,35` | 5.14 M / 330 / 6.15 | 4.44 M / 285 / 5.12 |
| DVP `2600,1800,250,20,25` | 4.33 M / 269 / 5.58 | **3.09 M / 260 / 4.83** |
| Glencairn `-4610,6133,150,0,30` | 4.45 M / 303 / 5.97 | **2.12 M / 267 / 4.88** |
| Pearson `-18400,2600,350,200,30` | 1.61 M / 215 / 4.68 | **1.04 M / 200 / 3.84** |
| King St W, eye level `-975,-867,30,90,7` | 4.74 M / 395 / 6.52 | **2.34 M / 242 / 5.00** |
| Union / rail lands, 93 m `-150,-1050,220,20,25` | 5.36 M / 443 / 6.59 | 4.08 M / 342 / 5.57 |

The King & Spadina link puts the eye against a facade without collision (with
the new camera collision it lifts to a 53 m roof view); King St W is the
street view to look at. Screenshot pairs (`<view>-before.png`,
`<view>-after.png`, `<view>-diff.png` = pixels changed by more than 40/255):
the only differences are moving cars, pedestrians, streetcars and swaying
trees (0.02–1.1 % of pixels; 4.8 % on King St W, where a streetcar moves
through the frame).

### Per layer (draws main + shadow · M triangles, both passes)

#### king-spadina

| | before | after |
|---|---|---|
| **total** (draws main+shadow · M tris) | **418 · 4.9** | **295 · 3.11** |
| CPU ms / frame (layers > 0.1 ms) | 5.95 — render:3.75 transit:1.03 traffic:0.30 street:0.30 water-life:0.18 air:0.16 | 5.4 — render:3.19 transit:1.00 traffic:0.29 street:0.27 water-life:0.17 tiles:0.17 air:0.16 |
| render submit ms, main / shadow pass | 2.84 / 1.54 | 2.2 / 1.24 |
| tiles buildings L0 | 28+6 · 0.96 | 19+6 · 0.80 |
| tiles buildings L1 | 17+0 · 0.75 | 8+0 · 0.37 |
| street | 5+4 · 0.55 | 4+4 · 0.29 |
| vegetation | 7+4 · 0.47 | 7+4 · 0.26 |
| tiles roads L0 | 6+0 · 0.43 | 6+0 · 0.37 |
| houses (instanced) | 18+9 · 0.38 | 15+9 · 0.11 |
| tiles terrain L2 | 39+0 · 0.36 | 9+0 · 0.03 |
| urban | 27+7 · 0.24 | 27+7 · 0.24 |
| tiles terrain L0 | 28+0 · 0.17 | 19+0 · 0.15 |
| tiles terrain L1 | 17+0 · 0.16 | 8+0 · 0.05 |
| landmarks + level crossings (unnamed group) | 64+14 · 0.12 | 40+1 · 0.17 |
| traffic | 20+9 · 0.10 | 20+9 · 0.10 |
| transit (cars + markers) | 20+4 · 0.08 | 20+4 · 0.08 |
| stations | 2+2 · 0.05 | 2+2 · 0.05 |
| props | 26+5 · 0.04 | 26+5 · 0.04 |
| airports | 5+6 · 0.01 | – |
| tiles buildings L2 | 10+0 · 0.00 | 5+0 · 0.00 |
| air | 6+0 · 0.00 | 6+0 · 0.00 |
| sky / lake / output pass | 2+1 · 0.00 | 2+1 · 0.00 |

#### gardiner-spadina

| | before | after |
|---|---|---|
| **total** (draws main+shadow · M tris) | **393 · 4.75** | **268 · 3.07** |
| CPU ms / frame (layers > 0.1 ms) | 5.91 — render:3.70 transit:1.08 street:0.29 traffic:0.27 water-life:0.18 air:0.16 | 5.01 — render:2.94 transit:0.97 street:0.26 traffic:0.24 water-life:0.16 tiles:0.16 air:0.15 |
| render submit ms, main / shadow pass | 2.64 / 1.44 | 1.88 / 1.11 |
| tiles buildings L0 | 26+6 · 0.85 | 15+6 · 0.57 |
| tiles buildings L1 | 18+0 · 0.69 | 10+0 · 0.53 |
| street | 5+4 · 0.52 | 4+4 · 0.36 |
| tiles roads L0 | 7+0 · 0.52 | 6+0 · 0.44 |
| tiles terrain L2 | 53+0 · 0.49 | 17+0 · 0.06 |
| vegetation | 7+4 · 0.46 | 7+4 · 0.29 |
| houses (instanced) | 17+8 · 0.36 | 14+8 · 0.11 |
| tiles terrain L0 | 26+0 · 0.18 | 14+0 · 0.12 |
| tiles terrain L1 | 18+0 · 0.17 | 10+0 · 0.05 |
| landmarks + level crossings (unnamed group) | 48+20 · 0.15 | 27+1 · 0.17 |
| urban | 19+6 · 0.13 | 19+6 · 0.13 |
| transit (cars + markers) | 19+7 · 0.08 | 19+7 · 0.08 |
| traffic | 17+6 · 0.07 | 18+7 · 0.06 |
| stations | 2+1 · 0.04 | 2+2 · 0.06 |
| props | 21+1 · 0.02 | 21+1 · 0.02 |
| airports | 5+6 · 0.01 | 0+6 · 0.01 |
| tiles buildings L2 | 8+0 · 0.01 | 5+0 · 0.00 |
| air | 5+0 · 0.00 | 5+0 · 0.00 |
| sky / lake / output pass | 2+1 · 0.00 | 2+1 · 0.00 |

#### harbour

| | before | after |
|---|---|---|
| **total** (draws main+shadow · M tris) | **330 · 5.14** | **285 · 4.44** |
| CPU ms / frame (layers > 0.1 ms) | 6.15 — render:3.66 transit:1.32 street:0.27 traffic:0.25 water-life:0.21 air:0.17 tiles:0.10 | 5.12 — render:2.97 transit:1.12 traffic:0.23 street:0.23 water-life:0.19 air:0.14 tiles:0.10 |
| render submit ms, main / shadow pass | 2.62 / 0.77 | 2.23 / 0.58 |
| tiles roads L0 | 28+0 · 1.64 | 28+0 · 1.28 |
| tiles buildings L0 | 28+6 · 0.86 | 28+6 · 0.86 |
| tiles buildings L1 | 18+0 · 0.72 | 18+0 · 0.72 |
| street | 5+0 · 0.35 | 4+0 · 0.24 |
| houses (instanced) | 17+4 · 0.33 | 12+3 · 0.32 |
| vegetation | 3+0 · 0.20 | 3+0 · 0.15 |
| tiles terrain L0 | 28+0 · 0.17 | 28+0 · 0.17 |
| tiles terrain L1 | 18+0 · 0.17 | 18+0 · 0.08 |
| tiles roads L1 | 17+0 · 0.15 | 17+0 · 0.15 |
| tiles terrain L2 | 15+0 · 0.14 | 15+0 · 0.05 |
| landmarks + level crossings (unnamed group) | 63+18 · 0.13 | 41+1 · 0.13 |
| urban | 10+3 · 0.10 | 10+3 · 0.10 |
| water-life | 3+2 · 0.07 | 3+2 · 0.07 |
| traffic | 7+0 · 0.04 | 7+0 · 0.04 |
| stations | 2+1 · 0.04 | 2+1 · 0.04 |
| transit (cars + markers) | 16+0 · 0.03 | 16+0 · 0.03 |
| airports | 6+3 · 0.01 | 6+3 · 0.01 |
| tiles buildings L2 | 5+0 · 0.00 | 5+0 · 0.00 |
| props | 4+0 · 0.00 | 4+0 · 0.00 |
| sky / lake / output pass | 2+1 · 0.00 | 2+1 · 0.00 |

#### dvp

| | before | after |
|---|---|---|
| **total** (draws main+shadow · M tris) | **269 · 4.33** | **260 · 3.09** |
| CPU ms / frame (layers > 0.1 ms) | 5.58 — render:3.52 transit:1.04 street:0.32 water-life:0.16 air:0.16 traffic:0.13 tiles:0.11 | 4.83 — render:2.99 transit:0.92 street:0.28 water-life:0.14 air:0.14 tiles:0.14 traffic:0.11 |
| render submit ms, main / shadow pass | 2.29 / 1.32 | 1.86 / 1.06 |
| vegetation | 7+4 · 0.96 | 7+4 · 0.62 |
| tiles buildings L1 | 16+2 · 0.61 | 16+2 · 0.61 |
| tiles roads L0 | 11+0 · 0.59 | 11+0 · 0.47 |
| houses (instanced) | 18+9 · 0.53 | 18+9 · 0.29 |
| tiles terrain L2 | 44+0 · 0.41 | 44+0 · 0.13 |
| street | 5+4 · 0.33 | 4+4 · 0.11 |
| tiles buildings L0 | 11+7 · 0.33 | 11+7 · 0.33 |
| tiles terrain L1 | 16+0 · 0.15 | 16+0 · 0.08 |
| urban | 24+6 · 0.14 | 24+6 · 0.14 |
| tiles terrain L0 | 11+0 · 0.13 | 11+0 · 0.13 |
| stations | 2+1 · 0.04 | 1+1 · 0.04 |
| transit (cars + markers) | 11+4 · 0.04 | 11+4 · 0.04 |
| props | 18+1 · 0.04 | 18+1 · 0.04 |
| airports | 5+6 · 0.01 | – |
| traffic | 10+2 · 0.01 | 14+4 · 0.01 |
| landmarks + level crossings (unnamed group) | 0+2 · 0.01 | 0+1 · 0.04 |
| tiles buildings L2 | 9+0 · 0.00 | 9+0 · 0.00 |
| sky / lake / output pass | 2+1 · 0.00 | 2+1 · 0.00 |

#### glencairn

| | before | after |
|---|---|---|
| **total** (draws main+shadow · M tris) | **303 · 4.45** | **267 · 2.12** |
| CPU ms / frame (layers > 0.1 ms) | 5.97 — render:3.76 transit:1.14 street:0.36 air:0.15 tiles:0.12 airports:0.11 water-life:0.11 traffic:0.10 | 4.88 — render:2.96 transit:0.98 street:0.34 tiles:0.14 air:0.14 |
| render submit ms, main / shadow pass | 2.33 / 1.41 | 1.9 / 1.06 |
| vegetation | 7+4 · 1.17 | 7+4 · 0.55 |
| houses (instanced) | 24+15 · 0.96 | 22+15 · 0.24 |
| tiles buildings L1 | 31+3 · 0.37 | 31+3 · 0.39 |
| tiles terrain L2 | 39+0 · 0.36 | 39+0 · 0.11 |
| airports | 18+17 · 0.34 | – |
| tiles terrain L1 | 34+0 · 0.31 | 34+0 · 0.12 |
| tiles roads L0 | 7+0 · 0.29 | 7+0 · 0.24 |
| street | 5+4 · 0.28 | 4+4 · 0.10 |
| tiles buildings L0 | 7+4 · 0.11 | 7+4 · 0.11 |
| tiles terrain L0 | 7+0 · 0.07 | 6+0 · 0.05 |
| props | 17+1 · 0.06 | 17+1 · 0.06 |
| stations | 4+1 · 0.05 | 4+1 · 0.05 |
| urban | 11+4 · 0.04 | 11+4 · 0.04 |
| traffic | 12+5 · 0.01 | 14+7 · 0.03 |
| tiles roads L1 | 2+0 · 0.01 | 2+0 · 0.01 |
| transit (cars + markers) | 9+3 · 0.01 | 9+3 · 0.01 |
| sky / lake / output pass | 2+1 · 0.00 | 2+1 · 0.00 |
| tiles buildings L2 | 4+0 · 0.00 | 4+0 · 0.00 |

#### pearson

| | before | after |
|---|---|---|
| **total** (draws main+shadow · M tris) | **215 · 1.61** | **200 · 1.04** |
| CPU ms / frame (layers > 0.1 ms) | 4.68 — render:3.38 transit:0.55 air:0.19 street:0.14 tiles:0.11 airports:0.10 | 3.84 — render:2.65 transit:0.47 air:0.17 street:0.16 tiles:0.13 |
| render submit ms, main / shadow pass | 2.4 / 0.77 | 1.78 / 0.61 |
| airports | 25+9 · 0.35 | 19+6 · 0.34 |
| tiles terrain L2 | 31+0 · 0.29 | 31+0 · 0.10 |
| tiles terrain L1 | 19+0 · 0.17 | 19+0 · 0.08 |
| tiles roads L0 | 13+0 · 0.16 | 13+0 · 0.15 |
| houses (instanced) | 14+4 · 0.14 | 11+3 · 0.00 |
| vegetation | 1+0 · 0.12 | 1+0 · 0.03 |
| street | 5+0 · 0.10 | 4+0 · 0.05 |
| tiles buildings L1 | 18+0 · 0.07 | 18+0 · 0.07 |
| tiles terrain L0 | 13+0 · 0.06 | 13+0 · 0.06 |
| tiles roads L1 | 7+0 · 0.05 | 7+0 · 0.05 |
| air | 5+2 · 0.04 | 5+2 · 0.04 |
| tiles buildings L0 | 11+3 · 0.03 | 11+3 · 0.03 |
| landmarks + level crossings (unnamed group) | 3+2 · 0.01 | 2+1 · 0.01 |
| props | 6+0 · 0.01 | 6+0 · 0.01 |
| tiles buildings L2 | 8+0 · 0.00 | 8+0 · 0.00 |
| sky / lake / output pass | 2+1 · 0.00 | 2+1 · 0.00 |
| urban | 9+3 · 0.00 | 9+3 · 0.00 |
| tiles (rest) | 0+1 · 0.00 | 0+1 · 0.00 |
| stations | 2+1 · 0.00 | 2+1 · 0.00 |
| traffic | 1+0 · 0.00 | 2+0 · 0.00 |

#### king-street

| | before | after |
|---|---|---|
| **total** (draws main+shadow · M tris) | **395 · 4.74** | **242 · 2.34** |
| CPU ms / frame (layers > 0.1 ms) | 6.52 — render:4.20 transit:0.94 water-life:0.33 street:0.29 traffic:0.27 air:0.16 tiles:0.11 | 5 — render:2.93 transit:0.83 street:0.27 traffic:0.25 water-life:0.25 tiles:0.17 air:0.15 |
| render submit ms, main / shadow pass | 2.65 / 1.87 | 1.82 / 1.1 |
| water-life | 10+9 · 0.73 | 2+0 · 0.01 |
| street | 5+4 · 0.55 | 4+4 · 0.34 |
| tiles buildings L0 | 23+4 · 0.50 | 12+4 · 0.40 |
| tiles roads L0 | 6+0 · 0.44 | 6+0 · 0.41 |
| vegetation | 7+4 · 0.41 | 7+4 · 0.15 |
| houses (instanced) | 18+9 · 0.39 | 15+9 · 0.05 |
| airports | 18+18 · 0.34 | – |
| tiles buildings L1 | 9+0 · 0.26 | 3+0 · 0.12 |
| urban | 24+7 · 0.24 | 24+7 · 0.24 |
| tiles terrain L2 | 21+0 · 0.19 | 3+0 · 0.01 |
| tiles terrain L0 | 27+0 · 0.16 | 12+0 · 0.13 |
| landmarks + level crossings (unnamed group) | 49+18 · 0.14 | 32+1 · 0.17 |
| transit (cars + markers) | 19+4 · 0.09 | 19+4 · 0.09 |
| tiles terrain L1 | 10+0 · 0.09 | 3+0 · 0.01 |
| traffic | 19+8 · 0.08 | 18+7 · 0.07 |
| props | 24+4 · 0.08 | 24+4 · 0.08 |
| stations | 3+1 · 0.04 | 3+2 · 0.04 |
| sky / lake / output pass | 2+1 · 0.00 | 2+1 · 0.00 |
| air | 3+0 · 0.00 | 3+0 · 0.00 |
| tiles buildings L2 | 7+0 · 0.00 | 3+0 · 0.00 |

#### union

| | before | after |
|---|---|---|
| **total** (draws main+shadow · M tris) | **443 · 5.36** | **342 · 4.08** |
| CPU ms / frame (layers > 0.1 ms) | 6.59 — render:4.44 transit:0.93 street:0.30 traffic:0.23 water-life:0.19 air:0.15 tiles:0.12 airports:0.10 | 5.57 — render:3.58 transit:0.85 street:0.29 traffic:0.23 water-life:0.17 tiles:0.16 air:0.14 |
| render submit ms, main / shadow pass | 3.12 / 1.88 | 2.36 / 1.15 |
| tiles roads L0 | 14+0 · 0.93 | 14+0 · 0.80 |
| tiles buildings L0 | 27+5 · 0.78 | 27+5 · 0.78 |
| tiles buildings L1 | 17+0 · 0.76 | 17+0 · 0.76 |
| street | 5+4 · 0.50 | 4+4 · 0.35 |
| vegetation | 7+4 · 0.44 | 7+4 · 0.26 |
| tiles terrain L2 | 46+0 · 0.42 | 45+0 · 0.14 |
| houses (instanced) | 18+9 · 0.35 | 15+9 · 0.25 |
| airports | 18+18 · 0.34 | – |
| tiles terrain L0 | 27+0 · 0.18 | 26+0 · 0.16 |
| landmarks + level crossings (unnamed group) | 70+34 · 0.17 | 48+1 · 0.18 |
| tiles terrain L1 | 17+0 · 0.16 | 17+0 · 0.07 |
| urban | 23+8 · 0.14 | 23+8 · 0.14 |
| transit (cars + markers) | 13+0 · 0.08 | 13+0 · 0.08 |
| stations | 6+1 · 0.04 | 6+2 · 0.06 |
| traffic | 14+5 · 0.03 | 10+3 · 0.03 |
| props | 19+0 · 0.02 | 19+0 · 0.02 |
| tiles buildings L2 | 10+0 · 0.00 | 10+0 · 0.00 |
| sky / lake / output pass | 2+1 · 0.00 | 2+1 · 0.00 |

### What changed

- **Occlusion horizon** (`engine/horizon.ts`, used by `TileManager`): below
  250 m altitude a 1440-bin azimuth table of how high the nearby buildings
  (level-0 footprints within 700 m; flat-roofed solids only, houses up to half
  their ridge) block the view, rebuilt when the eye moves 2 m or the near tile
  set changes. Tiles farther than 700 m whose whole box (terrain min … highest
  building / road / house top) stays below it for every azimuth bin they span
  draw nothing in the main pass; their buildings stay in the shadow pass
  (shadow-only layer), so towers hidden behind the block still cast. Also culls
  hidden boats. Conservative by construction (bins fully covered only,
  parallax / eye-height slack); street level downtown hides 250–280 tiles.
- **Widened-frustum pool membership** (`ViewCull.wide*`, frustum opened 18°
  per side, re-snapshotted after a 5° turn or 40 m move): instanced pools used
  to draw every instance of every tile around the camera, behind it too.
  Houses (tiles within 450 m always, for their shadows; per-tile instance
  records cached so a tile re-entering the view is a copy), street lamps /
  signals (within 350 m always, for the shadow proxies), mid-far trees and
  impostors (cells beyond the 260 m shadow range, L1 canopy tiles).
- **Street furniture**: lamps only for tiles within their 900 m draw range;
  night light pools not drawn by day (−76 k triangles, −1 draw).
- **Roads**: curb faces and tactile plates (vertical 15–20 cm faces, 12 mm
  plates) moved to the front of each level-0 street mesh and skipped by draw
  range beyond 400 m (−17 % of road triangles at a distance; no holes, they
  have no plan area).
- **Far terrain**: level-1 / level-2 terrain carries a half-resolution index
  range (same vertices, skirts hide the T-junctions) drawn beyond 8 / 25 km:
  −70 % of far-terrain triangles.
- **Landmarks**: untextured, non-emissive standard materials merged into one
  vertex-coloured material per cluster (−20 draws downtown); shadows cast by
  one depth-only proxy per face side instead of one shadow draw per material
  (downtown 14–18 → 1).
- **Apron (airports)**: ground equipment only within 2.2 km of an airport,
  pools culled against an apron bounding sphere, shadow casting only while the
  apron is inside the sun's shadow frustum (Billy Bishop / Downsview no longer
  cost 35 draws and 0.34 M triangles in downtown / North York street views);
  instance matrices no longer `DynamicDrawUsage` (re-uploaded the whole buffer
  every render pass).
- **Boats**: pools cast shadows only while a boat is inside the sun's shadow
  frustum (moored boats 2 km away were 0.37 M triangles in the King St shadow
  pass), and boats behind the downtown buildings are skipped.

### GPU / memory over a 3-minute flythrough (`app/perf/run.sh … flythrough`)

14 stops (street, oblique, 30 km overview, back to the start twice), forced GC
before each sample (`Runtime.getHeapUsage`). **Leak found and fixed**: three's
WebGPU renderer keeps a RenderObject (pipeline, bindings, and strong references
to the mesh and its geometry, i.e. every vertex array) per object × material ×
pass until the *object* dispatches `dispose`, which plain `Mesh` / `Group`
never do; geometry `dispose()` only frees the GPU buffers. Every evicted tile's
terrain / buildings / roads arrays stayed alive: ArrayBuffer backing store grew
855 → 1740 MB over ten view jumps and kept climbing. `engine/dispose.ts`
`releaseObject()` now releases tile groups on unload, dropped airport detail
and replaced vegetation pool meshes: 855 → ~1020 MB and flat (bounded by the
tile cache). JS heap 79 → 96 MB, textures 91–96, renderer geometries follow the
drawn set (629 → 1033, all referenced by the scene: 8 unreferenced throughout).
Still leaking the same way (owned by other agents, not changed): TrafficLayer
pool regrowth, `interact/tunnel.ts`, PropsLayer `lotsAndDriveways` (24
detached meshes seen after a flight).

### Rotation stress (`app/perf/run.sh … spin`, 360° in 3 s)

Pool membership churn costs `tiles` +0.3–0.4 ms and `street` +0.1 ms per frame
while turning fast (glencairn 6.6 → 6.5 ms avg, DVP max frame 12 → 13 ms, no
frame over 25 ms).

### Not done / suggestions

- Harbour at 460 m is still 4.4 M triangles: level-0 roads 1.28 M (downtown
  tiles are ~100 k each), level-0 buildings 0.86 M, level-1 buildings 0.72 M.
  Needs mesh LOD in the workers: a far road mesh (merged sidewalk bands, every
  2nd cross-section) and simplified level-0 buildings beyond ~1.5 km
  (`workers/buildings.ts`, owned by the buildings agent), or pulling the
  level-0 range in at altitude (`refineL1`: 0.46 + alt/2000).
- Draws: far level-2 terrain is 9–45 draws of ~2.5 k triangles; merging far
  tiles per 2×2 block needs a per-vertex ground-layer attribute in the terrain
  material. Urban kit (19–27 draws), props (17–26) and traffic / transit
  (≈30) are one draw per model kind; the low oblique over Union (342) is over
  300 because of these plus 36 textured landmark materials.
- Signal poles / heads (102 / 86 triangles, 0.1–0.15 M in view) would take a
  far box LOD pool (+2 draws).
- Three keeps a CPU copy of every uploaded vertex array (~800 MB of the
  ~1 GB backing store); releasing arrays after upload would need the ground
  picking to use the height grids instead of raycasts.
- The occlusion horizon only uses level-0 footprints; landmarks (CN Tower
  base, Rogers Centre) and terrain don't occlude yet.

## Not done / next
- GPU-driven culling + indirect draws (three 0.186 has no multi-draw-indirect
  path for InstancedMesh in WebGPU); CPU bucketing is used instead.
- Transit evaluation in a worker (remaining ~0.2 ms evaluate + ~0.8 ms layer
  loop per frame).
- GPU occlusion culling (depth pyramid); tile-level horizon culling is limited
  to the sub-pixel test above.
- Material consolidation beyond landmarks (uber-material, KTX2).
- Tiered Cache / Cache Reserve for tile misses (dashboard setting).
