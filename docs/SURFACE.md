# Unified at-grade surface ("terrain modification")

Status: prototype (2026-09-30), behind `?surf=1`. Pipeline: `pipeline/tpipe/surface.py`.
QA: `pipeline/tpipe/qa/checks_surface.py`. Client: `app/src/workers/surface.ts` and
`app/src/render/tiles/surfaceMaterial.ts`. Architecture context: NETWORK.md (this is the
"terrain modification" primitive), CROSS_SECTION.md (bands), STRUCTURES.md (decks).

## Why

The recurring ground bugs share one root cause. Each layer was an independent mesh draped
over a 32 m terrain grid:
- the terrain;
- road ribbons, junction surfaces, sidewalks and medians;
- track beds;
- vector land cover and water.

Nothing made them agree in plan or in height. The results were grass through asphalt, gaps
between sidewalks, driveways and roads, flicker where ribbons overlap (the DVP), beds switching
between ballast and slabs at crossings, bridges standing on vertical dirt walls, and floating
rails.

The surface replaces all of those at level 0 with one primitive:
- **Plan:** a planar partition. Every point of a tile belongs to exactly one surface class.
- **Height:** one conformed height field. Paving *is* the ground where it lies. Everywhere
  else the ground is the terrain, bent into cut and fill slopes to meet the paving.
- **Mesh:** one watertight mesh per tile with shared vertices along every class boundary.
  Vertical faces (curbs, retaining walls, banks) are strips extruded along the partition
  boundaries where the height field steps.

## Data model

### Sources (inputs)

A source is a polygon with a surface class, a priority, a height group and an owner. The
owner is what its height and attributes derive from. Sources are adapters, so better inputs
replace them one by one without touching the rest.

| source | today (inferred) | replaced by |
|---|---|---|
| carriageway bands | network model per-vertex `r_pl / r_pr`, crown at the centreline | CROSS_SECTION bands (`lane`, `shoulder`, `bike_lane`, `parking`) |
| walk bands | `r_sw` bits, `SIDEWALK_W`, `r_ws` (to the building line), boulevard / paver bits | CROSS_SECTION `sidewalk`, `furniture`, `boulevard`, `frontage`; City of Toronto sidewalk polygons |
| junction boxes | `js_*`, corner walks `jw_*` | INTERSECTIONS node boxes |
| medians / ROW | `md_*` (a streetcar ROW becomes a concrete track slab, an LRT ROW grass) | `median`, `transit_row`, `platform` bands |
| track beds | `l_*` at grade: a ballast profile per track; embedded (V_EMBED) → panel; grass track | corridor `bed` band (one polygon per corridor) |
| driveways | hidden `k_*` centrelines (svc 2/4), buffered, extended 3 m to reach the curb | City of Toronto driveway polygons |
| land cover, water | vector ground `gp_*`, `gw_*` | same, plus curated / surveyed polygons |
| open cuts | `pc_*`, `pt_*` | STRUCTURES cut / portal primitives |
| natural ground | tile `terrain_h` (32 m, Copernicus) or the LiDAR DTM (`--dtm`, 1 m, tpipe.src_lidar), re-levelled to the model (below) | DTM region-wide, with roadnet solved on the DTM |

Every road piece carries a band list (`infer_bands` in surface.py). This is the plug-in point
for the network model's cross-sections. Each band has:
- `kind`, `cls`, `group`, `prio`;
- `u0` / `u1`: signed lateral offsets per station, + left;
- `on`: per station;
- `raised` + `h`: the height above the adjacent carriageway edge;
- `surf`: the street-material surface.

When the model publishes bands, `infer_bands` is skipped (`R["bands"]` set from the model)
and nothing else changes.

**DTM vs model (finding).** The network model's at-grade road z sits a median 1.8–3.1 m
above the LiDAR DTM:
- downtown p95 3–4 m;
- the Don Valley p95 11 m;
- 86–94 % of centreline vertices are off by more than 0.5 m.

The model was solved on the Copernicus DSM (buildings and canopy opened away, but still
biased high). Until `tpipe.roadnet` solves on the DTM, `--dtm` re-levels the DTM by a
Gaussian (σ 120 m) field of model-minus-DTM residuals at road centrelines. That keeps the
DTM's shape (ravines, banks) at the model's level; the residual steps become cut and fill
slopes.

### Primitive-network bands (`--net2`, tpipe.primnet `net2/surface.npz`)

When the band file is given, segments inside it replace the inferred bands:
- **Stations.** The 2 m stations are decimated: a station is kept where dropping it would
  move the plan by more than 5 cm, z by more than 2 cm or any band edge by more than 2 cm,
  at platform events, and at least every 16 m. That cuts the King & Spadina tile from 274k to
  160k triangles.
- **Band classes and heights:**

  | kind | class | height |
  |---|---|---|
  | lane / shoulder / bike_lane / parking | carriageway | model z + crown |
  | curb, sidewalk, furniture, frontage, boulevard | per material | `nb_h` above the nearest lane edge + walk rise |
  | median, transit_row | slab or grass by material | `nb_h` above the nearest lane edge |
  | platform | platform (raised only between the `ne_*` events) | `nb_h` above the nearest lane edge |

- **Node boxes** (`nd_*`) replace `js_*`.
- **Markings** on net2 lanes take their attributes from the nearest model piece (same
  centreline).
- **Replaced model pieces** keep their inferred bands underneath at the lowest paved
  priority, so any part of the model footprint net2 leaves uncovered is still paved at the
  model's z.

### Classes (`sf_cls`)

- **0–63: ground classes** (SPEC.md `gp_class`), drawn by the ground material. Walls use 34
  (retaining wall), 33 (earth bank) and 30 (dockwall). Open-cut floor is 35.
- **64+: paved classes**, drawn by the street material:

| id | class | id | class |
|---|---|---|---|
| 64 | carriageway | 72 | path |
| 65 | junction | 73 | driveway |
| 66 | curb top | 74 | ballast |
| 67 | sidewalk | 75 | track grass |
| 68 | pavers | 76 | crossing panel |
| 69 | boulevard | 77 | transit ROW slab |
| 70 | median | 78 | platform |
| 71 | median grass | 80 | curb face (vertical) |

- **Dense default:** unmapped or land-use ground (0, 4, 5, 17, 29) becomes hardscape (21)
  where both of these hold:
  - non-house building coverage within ~60 m is over 30 %;
  - the point is within 20 m of a building face.

  Mapped green (parks, woods, lawns) stays green.

### The model footprint (shared definition)

`surface.model_footprint_quads()` defines each at-grade road piece's footprint as the network
model defines it (and as the old ribbons drew it): per segment between two model stations, the
quad between their mitred pavement corners (`r_pl / r_pr`), snapped to the 1/32 m lattice.

- The builder adds these quads to the arrangement as the lowest paved sources, just above land
  cover. Any face they win resolves to the piece's nearest lane band, so no part of a model
  footprint can become ground.
- The QA samples inside the same quads (see the invariant section below).
- Inserted stations interpolate the model's mitred offset vectors, so band edges are exactly
  the model's chords.
- Slivers thinner than 10 cm only move up in priority: land cover may join paving, but paving
  never becomes land cover.

### Priority (high wins)

`junction 60 > carriageway 50 (+0.1 per higher road class) > curb 44 > median 42 >
sidewalk / boulevard / pavers 40 > open cut 35 > track bed 30 > path 22 > track (cl. 9) 21 >
driveway 20 > land cover / water 0`

Derived rules after the priority pick:
- **Crossing panel:** any face covered by both a track bed and a road, walk, path or
  driveway source becomes a crossing panel. It keeps the paving's height, so sidewalks and
  roads across track are always panels, never ballast.
- **Rail yards:** gaps under 3 m between track beds become ballast, so parallel tracks
  share one bed.
- **Open cuts:** a street crossing a cut wins over it; the track tunnels under the street,
  with portal walls on either side.

### Height groups and rules

| group | classes | height |
|---|---|---|
| ROAD | carriageway, junction, panels on roads | model centreline z (the network solve) + 2 % crown on two-way streets, planar crossfall on one-way / freeways. Junctions: inverse-distance over the 4 nearest 1 m centreline samples, excluding levels > 1 m from the nearest (never blends with a road passing above / below). |
| WALK | sidewalk, boulevard, pavers, medians, corner walks, ROW slab | adjacent carriageway edge z + curb height (0.15; medians 0.17; rail ROW 0.12) + 1.5 % rise away from the curb |
| RAIL | ballast, grass track, embedded panel | model rail z + bed profile (ballast top +0.28 inside `hw − 0.6`, falling to +0.03 at the bed edge; grass +0.03; embedded panel +0.07) |
| CUT | open-cut floor | nearest cut track z − 0.25 |
| WATER | water | `gw_level` or the river field |
| SOFT | grass, woods, land use, hardscape, paths, driveways, yard ballast | natural ground clamped into the cut / fill envelope of all fixed groups (below) |

Where several faces of one group share a vertex, the vertex takes the mean of their
proposals (conformed), so twin carriageways, ramps and junctions meet without steps.

### Cut and fill: a distance-field union (the berm rule)

Every fixed-group boundary sample `i` (every 0.5 m) at height `z_i` defines two cones:
- fill `f_i(p) = z_i − d_i(p) / 2`;
- cut `g_i(p) = z_i + d_i(p) / 2`.

Both are 1:2 slopes. On a 1 m raster over the tile plus a 48 m margin:
- `L = max_i f_i` and `U = min_i g_i`, by an 8-neighbour chamfer propagation with 40 m reach;
- `L` gets a 7 m grey closing and `U` a 7 m grey opening. Valleys narrower than that between
  neighbouring cones are filled, so parallel tracks and carriageways share one berm, with
  slopes only on the outer edges;
- the soft ground is `H = smin(smax(DTM, L, k), U, k)` with a polynomial smooth max,
  `k = 0.4 m`.

Hence:
- A raised road or track gets a grass embankment. A lowered one gets a cut slope. Both blend
  into the terrain; there are no per-feature mounds and no grass valleys between adjacent
  tracks.
- Terrain can never poke through paving. Paving is not draped; it *is* the surface there.
- **Retaining walls** appear exactly where the cones conflict (`L > U`; the cut wins).
  Examples: a raised road beside a low one with too little room for two slopes, or a road
  hard against a DTM bluff. The soft vertex on the paved edge then keeps its own height, and
  the boundary emits a vertical wall strip (class 34).
- **Snap:** a soft vertex on a paved edge within 0.3 m of that edge's height joins it. This
  covers the rasterised cones and gives no wall.

### Mesh

Build order:
1. **Arrangement.** Node every source boundary (plus the tile and margin boxes) on a
   **1/32 m lattice** with `union_all(grid_size)`, then `polygonize`. Each face takes the
   top-priority source containing its representative point.
2. **Dissolve.** Fragments of the same source (same class, group and owner, same side of the
   tile border) merge.
3. **Soft grid.** Grid lines go in soft areas only:
   - 32 m cells everywhere;
   - 8 m cells where a 32 m cell's bilinear corners miss the target surface (DTM in the
     envelope) by more than 0.25 m;
   - 4 m cells where an 8 m cell still misses.

   Then the arrangement is polygonized again; slivers join the parent they overlap most.
4. **Triangulate.** Constrained Delaunay per face (GEOS). Vertices come only from the noded
   linework, so shared boundaries share vertices.
5. **Repair.** Any unmatched interior edge is split at mesh vertices lying on it (T-junction
   repair).
6. **Walls.** Along every edge between two height groups whose heights differ by more than
   2 cm, a vertical quad from the lower to the higher surface, facing the lower side:
   - road|walk and rail|walk: a curb face (street material, concrete);
   - anything with water: a bank or dockwall;
   - otherwise: a retaining wall.

   Chains of wall edges that are straight within 2 cm and linear in height within 1 cm merge
   into one quad.

**Guarantees, checked per tile** (`checks_surface.py` on the stored, quantised mesh):
- 0 open edges (cracks / T-junctions);
- 0 overlapping or folded triangles;
- top-surface plan area equals 1024² m² exactly.

### Tile arrays (level 0, `sf_*`, format v3)

The partition's faces are stored as boundary loops over a shared position table.
- **Triangulation:**
  - Convex single-loop faces (and wall quads) are fans from a verified apex.
  - Other faces are earcut, then every exactly-collinear vertex earcut drops is re-inserted.
    The pipeline verifies each such face at build time: all vertices used, every loop edge a
    triangle edge, area exact, no zero-area triangle.
  - Faces that fail are stored as explicit triangles (a handful per tile).
- **Order:** faces are in Morton order of their centroid (16 m cells). Positions are in first-use
  order; index codes are `hw − i` (0 = the next new position).
- **Vertices:** a GPU vertex is (run, position) at its first appearance. Street attributes are
  stored only for street-run vertices; water and wall vertices carry one u16.

| array | type | meaning |
|---|---|---|
| `sf_npos` | u32 [1] | position count |
| `sf_pos` | varint | zigzag deltas of x (all positions), then of y, in 1/32 m (the noding lattice: quantisation is exact) |
| `sf_pz` | varint | zigzag deltas of z in cm above `sf_z0` |
| `sf_z0` | f32 [1] | base elevation (datum m) |
| `sf_idx` | varint | index codes of all loop corners (face order, loop order) |
| `sf_run` | u8 [2·runs] | class, flags. Bits 0–3: water kind (0 lake · 1 pond · 2 river · 3 rapids); bit 4: street material; bit 5: wall. Ground runs sort first. |
| `sf_face` | varint | run of each face |
| `sf_nl` | u8 [faces] | loops per face (outer first) |
| `sf_ln` | varint | corners per loop |
| `sf_fk` | u8 [faces] | 0 fan · 1 earcut + collinear re-insertion · 2 explicit |
| `sf_nt`, `sf_tl` | u16 [explicit faces], varint | triangle count and local corner indices of explicit faces |
| `sf_su` | i16 | u in 2 cm |
| `sf_sv`, `sf_rv` | u16 dm, f32 per run | v = `sf_rv[run]` + `sf_sv` / 10 |
| `sf_se` | i16 [2] | eL, eR in cm |
| `sf_smk`, `sf_scode`, `sf_slw`, `sf_sfx`, `sf_scol` | | street material: marking bits, code, lane width (dm), extra bits, tint + priority |
| `sf_rjn`, `sf_rjv` | f32 [4·runs], u8 [runs] | per run: fpS, fnS, feature codes → dPrev = v − fpS, dNext = fnS − v; runs with `sf_rjv` = 1 carry per-vertex `sf_sjn` (i16 dm) / `sf_sjf` (u16 ×10) |
| `sf_gx` | u16 | water: shore distance × 8; walls: along × 10 |

Decoders: `app/src/workers/surface.ts` (`buildSurface`) and `pipeline/tpipe/qa/checks_surface.py`
(`decode`). The QA runs on the decoded mesh, so it covers the encoding too.

### Build performance (1 worker, nice 15; 20 prototype tiles)

| | before | after |
|---|---|---|
| downtown tile (-1,-1), incl. net2 bands | 62 s | 5.3 s |
| per tile, range (mean) | 26–90 s | 3.0–5.9 s (4.1 s) |
| peak RSS | 1.4–1.7 GB | 0.8–1.4 GB |

Where the time went, and the fixes:
- A LinearRing in the noding union sent GEOS down a ~10× slower path.
- The sliver pass was O(n²).
- Height rules, seeds, triangulation, emit and T-junction repair were per-vertex Python; they
  are now vectorised per piece.
- Model stations are decimated: fillet arcs are sampled ~1 m apart; kept stations are within
  5 cm plan, 2 cm z and 2 cm offsets. This drops ~40 % of the band quads.
- Phase 2 re-nodes only unique lattice segments plus a grid clipped to soft / water faces.

Estimate: the 17,760 level-0 tiles are mostly suburban and rural, averaging ~2–3 s, so about
6–10 h with 2 workers.

**Size:** sf_* went from 0.7–1.4 MB gz per tile to 0.31–0.70 MB. That is 0.84–1.37× the rest of
the tile (mean ≈ 1.1×). The heaviest ratios are rail-heavy tiles with a thin rest-of-tile.

## Client (`?surf=1`)

Each tile draws ONE mesh (`TileManager`, the level-0 `terrain` object) with two index
groups:
- **Group 0: ground material.** Land cover, water, walls and banks.
- **Group 1: street material** (`roadMaterial` without its per-layer depth pull; nothing
  overlaps any more). Carriageway markings, crosswalks and stop bars are projected onto the
  mesh through the same `rd rm jn` attributes the road ribbons used.

It replaces, at level 0:
- the terrain grid and vector ground;
- road ribbons, junction surfaces, corner walks, curbs, sidewalks and medians;
- track ballast and embankment fills.

Beyond ring 1 the raster terrain takes over as before.

Separate objects that sit on the surface:
- **Structures:** decks, parapets, piers and abutments (`structuresOnly()` gives the road /
  rail meshers only the bridge runs, draped on the surface so decks start exactly where the
  paving ends).
- **Rails:** `surfaceRails()`. The rail head sits 0.16 m above ballast or grass track (on its
  ties) and flush in panels, slabs and pavement.
- Props, trees, lamps, signals, parked cars and buildings.

Placement and physics sample the surface itself:
- `SurfaceSampler` in the worker (props, lamps, street furniture);
- `TileManager.heightAt` through a 64×64 triangle bucket index (cars, walkers, cameras).

## Structures and tunnels

Structures are not part of the at-grade surface. The agreed interface with the structures
builder (STRUCTURES.md; `st_*`, `sa_*`, `sp_*` per level-0 tile):
- **`st_off / st_xy` deck footprints:** holes in the paving and walks. The ground under a
  deck is soft natural ground (DTM), with the envelope's slopes.
- **`sa_off / sa_xyz` abutment lines** (+ `sa_seat` z): the approach paving ends exactly on
  the line at the deck's z. The ground beyond slopes down from the seat (spill-through,
  1:2), never a vertical earth wall. Where a slope cannot fit, the abutment wall is the
  structure's.
- **`sp_*` pier footprints:** no hole. Piers take their base from the surface height query.

Until `st_*` exists, footprints come from the model's bridge runs (`vf & 1`). The at-grade
bands stop at the last non-bridge station, and the deck ribbon starts there.

Tunnels are excluded from the surface. Open cuts are a class whose floor follows the track
(z − 0.25); the cut walls are ordinary wall strips from the height step. Portal mouths /
headwalls still need the STRUCTURES portal primitive.

## Terrain-snapping invariant (NETWORK.md)

Inside the footprint of every at-grade asset, terrain z ≤ pavement z − 0.02 m everywhere.

- **Ring 1 (the surface), by construction.** A footprint is a set of paved / bed faces. No
  ground triangle exists inside it, so nothing can be above the paving, at vertices or
  between them. Outside the footprint, ground higher than the paving edge (a cut that could
  not slope) is joined by a vertical wall rising from the paving edge; the paving itself
  stays on top.
- **QA.** `terrain_above_paving` samples the model footprints (`model_footprint_quads`,
  inset 5 cm) on a 2 m grid, and every 1 m along every inset edge. It also samples track
  centrelines every 2 m. It requires a paved or bed class there, with no ground triangle, on
  the stored (quantised) mesh. It must be 0.
- **`surface_off_model`** (separate) counts road centreline samples whose paving is more than
  0.25 m off the model z. That happens at junction blends and at crossings where the model
  pins the rail level.
- **Beyond ring 1.** Roads are not drawn over the far terrain at all. They are painted into
  its land-cover raster (road / major road / rail / plaza classes). Where a far LOD needs
  raised roads (freeways on embankments), each far-grid vertex is clamped to
  `min(road z − 0.02)` over every road footprint point within one cell diagonal of it.
  Every far triangle overlapping a footprint then has all three corners at or below the
  lowest road point it covers, so the invariant holds between vertices too. This is
  conservative (it can notch hillsides by slope × cell), so ring 2 uses the simplified
  surface below, and the clamp applies only at levels 1–2.

## LOD beyond ring 1

- **Ring 1 (full):** the mesh as built.
- **Ring 2 (planned, not built):** the same partition simplified per class. Paved faces keep
  only their boundary; soft faces drop the 4 m / 8 m refinement; walls and curb faces lower
  than 0.3 m are dropped. That is about 20 % of the triangles, stored as a second index range
  in the same tile.
- **Levels 1–2:** unchanged raster terrain with the paved classes baked into the land-cover
  raster (road / rail / plaza classes already exist).

## Prototype results

Extract: 20 level-0 tiles (+36 ring tiles) at downtown, the King & Spadina slice, the USRC,
Yonge–Dundas, Yonge north of Bloor, the Don Valley / Bloor, Don Yard, the Annex and the ION
at Bearinger Rd. Numbers are in the agent report and `surface_report.json` in the extract.
Screenshots are in the session scratchpad `surf/shots/`.

## Region build (pipeline/run.sh)

The surface step runs after `tpipe.ground`:

`tpipe.surface --src $OUT --out $OUT --in-place --all --workers 2 [--net2 $OUT/net2/surface.npz]`

- Tiles are written atomically (temp file, then rename), since workers read their neighbours.
- A tile that raises, has an open edge, or whose plan area is off by more than 0.5 m² aborts the
  run with its key.
- The report goes to `work/surface_report.json`.
- **Timing:** 10 sampled suburban / rural tiles took 0.5–2.4 s (mean 0.95 s); downtown tiles take
  3–6 s. The region should take ≈ 3–4 h at 2 workers.
- **Partial regions are safe:**
  - Tiles without `sf_face` (not built yet, or the older format) fall back to the old vector
    ground and ribbons.
  - Surface meshes carry 3 m skirts along the tile border, so a seam against such a neighbour
    never cracks.

## Migration plan

1. **Region build.** Add `tpipe.surface` to run.sh after `tpipe.ground`, at 2 workers. It
   takes ~20 s per downtown tile and ~10 s per suburban one: ≈ 17,760 tiles × ~12 s ≈ 30 h
   single-threaded. That needs the performance items below first. Peak RSS is 1.4 GB per
   worker.
2. **Inputs to the network model:**
   - CROSS_SECTION bands replace `infer_bands`;
   - INTERSECTIONS node boxes replace `js_* / jw_*`;
   - STRUCTURES `st_* / sa_*` replace bridge-run footprints;
   - the LiDAR DTM replaces `terrain_h`. The roadnet solve must then use the same DTM, or
     every at-grade road meets the DTM with small cuts and fills.
3. **Client.** Make `?surf=1` the default where `sf_*` exists; keep the old path for tiles
   without it. Then delete the level-0 ribbon, sidewalk, junction, median, embankment and
   ballast code (roads.ts keeps decks, parapets, piers, barriers and trusses).
4. **Payload.**
   - `sf_*` is ~0.8–1.2 MB gz per downtown tile, against ~0.4 MB for the whole current tile.
   - Planned: per-owner attribute tables instead of per-vertex road attributes (mk, lw, fx,
     jn, col, e → looked up by s), and an index strip order. Target ≤ 0.5 MB.
5. **Performance.** Vectorise `fixed_heights` (per-vertex Python today) and the band
   inverse-bilinear. Cache the region's pieces instead of re-reading 3×3 tiles.
6. **Region QA gate:** `surface_gap = 0`, `surface_overlap = 0`, and `terrain_above_paving`
   down to model-z mismatches only.

## Open items / known limits

- Crossing panels follow the model's `V_EMBED` extents, which overshoot the carriageway at
  some level crossings. Per the source-of-truth rule this is left to the model.
- Streetcar platforms (`platform` band, raised 0.25 m islands) wait for the model's band
  output; the class and height rule exist.
- Freeway median barriers, guardrails and tactile plates are drawn on the surface by
  `surfaceFurniture()` (workers/surface.ts):
  - jersey barriers along the left pavement edge of one-way class 0–1 carriageways;
  - steel beam guardrails on the right where the surface 4 m out is more than 1.3 m off the
    pavement (gaps under 25 m closed, runs under 20 m dropped);
  - cast-iron plates at `jt_*`, 12 mm above the walk.
- The ribbon mesher's tactile plates (roads.ts `junctionSurfaces`) are wound clockwise in plan,
  so they have never been visible. Reported to the roads owner.
- Where glued twin carriageways meet at slightly different heights, the median barrier base
  steps with the surface.
