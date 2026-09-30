# Data & coordinate contract

Everything the pipeline emits and the client consumes follows this document.
Pipeline constants live in `pipeline/tpipe/geo.py`; the client reads them from
`data/manifest.json`.

## Coordinates

- **Projection:** Transverse Mercator centred on Toronto City Hall
  (`lat_0=43.6532 lon_0=-79.3832 k=1`, WGS84). Units are metres.
  `E` = east, `N` = north. Scale error < 0.02% region-wide ⇒ "to scale".
- **Elevation:** metres relative to a datum 75 m above sea level
  (Lake Ontario's surface ≈ 0). Lake Erie ≈ +99, Lake Simcoe ≈ +144.
- **three.js world:** `x = E`, `y = elevation`, `z = -N` (right-handed, y-up).
  Never put raw world coordinates (up to ±150 km) into vertex buffers: vertex
  data is tile-local and objects are positioned via their transform, or
  relative to a floating anchor near the camera.

## Tile pyramid

| level | edge | terrain grid | ground raster | contents |
|---|---|---|---|---|
| 0 | 1024 m | 33×33 (32 m) | 256² (4 m/px) | all buildings, houses, all roads, all rail |
| 1 | 4096 m | 65×65 (64 m) | 256² (16 m/px) | buildings ≥ 12 m (simplified), roads class ≤ 3, main rail/subway/LRT |
| 2 | 16384 m | 65×65 (256 m) | 256² (64 m/px) | buildings ≥ 35 m (simplified), roads class ≤ 1, main rail |

Tile `(L, tx, ty)` covers `E ∈ [tx·S, (tx+1)·S)`, `N ∈ [ty·S, (ty+1)·S)`.
Level-L tile contains exactly 4×4 level-(L-1) tiles. Features are assigned to
the tile containing their centroid (buildings) or clipped to the tile rect
(lines, rasters). All positions inside a tile are **f32 metres relative to the
tile's SW corner** (`E - tx·S`, `N - ty·S`). Elevations are absolute (datum).

File: `data/tiles/{L}/{tx}_{ty}.bin.gz`. Only non-empty tiles exist; the list is
in `manifest.json`.

## TBN1 container (all binary files)

Gzip of: `"TBN1"` · `u32 headerLen` · header JSON · pad to 8 · array blobs.
Header: `{"arrays": {name: [dtype, byteOffset, length]}, ...extra}` where
`byteOffset` is from the start of the 8-aligned data section and every blob
is 8-aligned. dtypes: `i8 u8 i16 u16 i32 u32 f32 f64`. Little endian.
Readers: `pipeline/tpipe/tbn.py`, `app/src/data/tbn.ts`. Clients decompress
with `DecompressionStream('gzip')`.

## Tile arrays

Terrain / ground
- `terrain_h` i16 [G·G] — decimetres (datum). Index `j·G + i`, `i` east, `j`
  north; sample `(i,j)` is at `(i·S/(G-1), j·S/(G-1))` local. Edges are shared
  with neighbours (seamless).
- `ground` u8 [256·256] — land-cover class per pixel, index `j·256 + i`, row 0
  = south, pixel centre `((i+.5)·S/256, (j+.5)·S/256)`. Classes:
  `0 land · 1 water · 2 grass/park · 3 forest · 4 residential · 5 commercial ·
  6 industrial · 7 farmland · 8 sand/beach · 9 road · 10 rail · 11 parking ·
  12 cemetery · 13 golf · 14 aeroway · 15 major road · 16 wetland ·
  17 institutional · 18 construction · 19 sports pitch · 20 runway/taxiway ·
  21 platform/plaza · 22 building footprint (levels 1–2 only, far-view texture) ·
  23 airfield grass` (everything open inside an aerodrome: runway/taxiway/apron
  areas, the aerodrome area itself, bare land and grass; the paved surfaces are
  drawn by the airport layer, docs/AIR.md; no trees/lamps are scattered on it).
  Classes 14 and 20 are no longer produced by the pipeline.
  At level 0 the raster is kept for placement queries (trees, lamps, houses);
  what is drawn is the vector ground below.

Vector ground (level 0; `pipeline/tpipe/ground.py`, run after `tpipe.transit`,
drawn by `app/src/workers/ground.ts` + `render/tiles/groundMaterial.ts`)
- At level 0 `terrain_h` is also *shaped*: land within 1.5 grid cells of a shore
  is raised to at least water level + the shore type's freeboard (below), and
  open water sits at its water level.
- `gp_off` u32 [nP+1] · `gp_xy` u16 [2·nV] (local metres × 65535/S, i.e.
  1.6 cm steps; 0 and 65535 are the tile edges) · `gp_class` u8 [nP] — the land
  cover as a planar partition: simple CCW rings, no holes, no overlaps, covering
  the whole tile (minus open cuts, below). Rings are not closed. Painter order
  when built: land use (4 5 6 7 10 17 18 23) < parks, woods, pitches, parking,
  plazas… (smaller on top) < water < piers / breakwaters. Natural edges are
  smoothed (capped corner cutting), everything simplified at 0.2 m; scraps
  < 4 m² dropped. Classes as the raster, plus vector-only
  `24 hard court (tennis, basketball, pickleball…) · 25 ball diamond ·
  26 running track · 27 pier / quay deck · 28 breakwater / groyne (armour
  stone) · 29 mown verge` (uncovered land within 45 m of a motorway / trunk:
  medians, interchange infields, shoulders; and a 4 m landscaped band inside
  commercial / industrial lots). Class 0 (anything unmapped) is drawn as rough
  grass. **Parking lots are `gp_class == 11`** (amenity=parking, asphalt base;
  stalls, islands, lamps and parked cars are drawn on top by the props layer).
- `gf_poly` u32 [nF] · `gf` f32 [5·nF] — oriented frame of pitch-like polygons
  (classes 19, 24, 25, 26): centre x, y (local), angle of the long axis (rad,
  CCW from +E), half length, half width; for line markings.
- `gw_poly` u32 [nW] · `gw_level` i16 [nW] — water surface level (dm, datum)
  per water polygon (`gp_class == 1`), or −32768 = follows `gw_field`.
  Lake Ontario −0.3 m (74.7 m ASL), Lake Erie 99.2; ponds / lakes: the 10th
  percentile of the terrain's 90 m minimum along their shore; rivers (level
  varies > 2 m along the shore) follow the field. Nothing is below Lake Ontario.
- `gw_field` i16 [33·33] — river level field (dm), same layout as a 33×33
  terrain grid; only present when a field-level water polygon exists.
- `sh_off` u32 [nS+1] · `sh_xy` u16 [2·n] · `sh_z` i16 [n] (water level, dm) ·
  `sh_type` u8 [nS] — shore polylines, water on the left:
  `1 dockwall (vertical concrete, freeboard 1.6 m) · 2 revetment (armour stone,
  1.1) · 3 beach (0.25) · 4 natural bank (0.35)`. Sand next to the water →
  beach; piers → dockwall; breakwaters → revetment; `pipeline/curated/shores.json`
  zones; great-lake / harbour water against paved or industrial land →
  dockwall, else revetment; other water → natural bank.
- Open cuts / tunnel portals: where track the trains run on (rail graph,
  `tpipe.rail_graph`) is between 0.35 m and mouth height + 1.3 m below the
  ground (mouth 7.0 m rail, 5.0 subway, 5.6 LRT / streetcar), the ground is cut
  away: `pc_off` u32 · `pc_xy` u16 · `pc_type` u8 per ring vertex (edge to the
  next vertex: `0 retaining wall · 1 portal (headwall + tunnel mouth) · 2 open`),
  and the track runs inside: `pt_off` u32 · `pt_xyz` f32 (local x, y, rail level
  datum) · `pt_kind` u8 (`0 rail · 1 subway · 2 LRT · 3 tram`). The client draws
  the ballast floor 0.25 m below the rail level, walls, headwalls, mouths and
  rails, and `TileManager.heightAt` returns the rail level inside a cut (so
  surface-snapping vehicles follow the track down). Names, references and
  overrides: `pipeline/curated/portals.json`.
- Embankments are not in the data: the client fills under bridge decks
  (`r_*` / `l_*` with flag 2) that are 0.5–5.5 m above the ground (never over
  water) with 1:2 (road) / 1:1.5 (rail) grass slopes, ending in a concrete
  abutment where the span begins — so they follow whatever deck profile the
  road data carries.

Buildings (extruded footprints)
- `b_ring_off` u32 [nB+1] — building i owns rings `[b_ring_off[i], b_ring_off[i+1])`.
- `b_vert_off` u32 [nRings+1] — ring r owns vertices `[b_vert_off[r], b_vert_off[r+1])`.
- `b_xy` f32 [2·nV] — local x,y. First ring of a building is the outer ring
  (CCW), later rings are holes (CW). Rings are not closed.
- `b_height` f32 — top of building above its base (m).
- `b_min` f32 — bottom of the extruded part above base (m), for overhangs/`min_height`.
- `b_base` f32 — base elevation (datum m) = min terrain under footprint.
- `b_kind` u8 — `0 generic · 1 house · 2 apartments · 3 office/commercial ·
  4 retail · 5 industrial/warehouse · 6 civic/public · 7 education ·
  8 religious · 9 transport/station · 10 hospital · 11 garage/shed ·
  12 stadium/sports · 13 hotel · 14 parking structure · 15 roof/canopy ·
  16 under construction` (`building=construction`; the client draws a
  concrete frame part-way up with a tower crane, workers/urban.ts).
- `b_roof` u8 — `0 flat · 1 gabled · 2 hipped · 3 dome · 4 pyramidal · 5 skillion`.
- `b_color` u32 — `0xRRGGBB` from `building:colour`, 0 = unset.
- `b_osm` f64 — OSM id (ways positive, relations negative).

Houses (instanced archetypes, level 0 only)
- `h_xy` f32 [2n] centre · `h_angle` f32 (rad, CCW from +E, long axis) ·
  `h_len` f32 · `h_wid` f32 · `h_height` f32 (ridge above base) ·
  `h_base` f32 (datum) · `h_type` u8 · `h_var` u8 (colour/variant seed) ·
  `h_osm` f64.
- `h_type`: `0 detached · 1 large detached · 2 semi · 3 townhouse row ·
  4 bungalow · 5 garage/shed`.

Roads (level 0: all; higher levels: filtered + simplified)

> Since the network model (docs/ROADS.md), road and rail pieces are smoothed
> strokes from `pipeline/tpipe/roadnet.py` with solved elevations (`z` is
> authoritative where `r_vf`/`l_vf` bit 2 "graded" is set), per-vertex
> cross-sections (`r_el r_er r_pl r_pr r_lw`), marking bits (`r_mk`),
> structure / sidewalk flags (`r_vf`, `r_sw`), height over terrain (`r_dz`,
> `l_dz`) and stroke-continuous distance (`r_s`). Junction records gain `j_cl`
> (intersection id); intersections add `js_* jw_* jc_* jt_* sg_*`, medians
> `md_*`, hidden parking aisles / driveways `k_*`. Full list: docs/ROADS.md
> "Tile arrays". The fields below keep their meaning.
- `r_off` u32 [n+1] · `r_xyz` f32 [3·nV] (local x, local y, elevation datum),
  densified to ≤ 32 m spacing and draped on terrain (bridges/tunnels
  interpolated between their ends).
- `r_class` u8 — `0 motorway · 1 trunk · 2 primary · 3 secondary ·
  4 tertiary · 5 residential/unclassified · 6 service · 7 pedestrian/living ·
  8 footway/cycleway/path · 9 track`.
- `r_width` f32 m · `r_lanes` u8 · `r_flags` u8 (`1 oneway · 2 bridge ·
  4 tunnel · 8 link/ramp · 16 roundabout`) · `r_layer` i8 ·
  `r_name` u16 (index into header `names`, 0xFFFF = none) · `r_osm` f64.
- `r_side` u8 — sidewalk tagging: `0 untagged · 1 none · 2 left · 3 right ·
  4 both · 5 separate · 6 this way is footway=sidewalk · 7 footway=crossing`.
  The client draws curbs + raised sidewalks on classes 2–5 for 2/3/4 and, in
  built-up areas, for 0/5.
- `r_v0` f32 — distance along the OSM way (m) at the piece's first vertex, so
  lane-dash phase is continuous across tile borders.

Border pieces (level 0; for placement only, never meshed)
- `xr_off` u32 · `xr_xyz` f32 · `xr_class` u8 · `xr_flags` u8 · `xr_width` f32 —
  road pieces of the 8 neighbouring tiles with a vertex within 40 m of this
  tile (tile-local coords); `xl_off` · `xl_xyz` · `xl_class` · `xl_flags` —
  the same for rail. Trees / props near a border keep clear of carriageways
  and tracks that run just outside it.

Junctions (level 0; ≥ 3 arms of road classes 0–5, tunnels excluded; duplicated
into every tile within 80 m)
- `j_xy` f32 [2n] (tile-local; equals the shared road vertex exactly) ·
  `j_osm` f64 (OSM node id, same ids as the road graph `n_id`) ·
  `j_flags` u8 (`1 signalized`: signal node at or within 20 m).
- `j_arm_off` u32 [n+1] · `j_arm_ang` f32 (rad, CCW from +E, pointing away from
  the junction along the arm) · `j_arm_r` f32 (junction box radius along that
  arm: half-width of the widest crossing road ÷ sin angle, + 0.5 m) ·
  `j_arm_hw` f32 (arm half-width) · `j_arm_flags` u8 (`1 stop sign on this
  approach`).

Street points (level 0)
- `p_xy` f32 [2n] · `p_kind` u8 (`0 traffic signals · 1 stop sign · 2 marked
  crossing · 3 tree (incl. natural=tree_row sampled every 8 m) · 4 street
  lamp`) · `p_var` u8 (crossing: `1 zebra/ladder · 2 lines`; tree: bit 0
  conifer, bits 1–4 genus `0 unknown · 1 Acer · 2 Gleditsia · 3 Tilia ·
  4 Platanus · 5 Quercus · 6 Salix · 7 Pinus · 8 Picea · 9 Thuja · 10 Tsuga ·
  11 Fagus · 12 Ulmus · 13 Ginkgo · 14 small ornamental (Malus, Prunus, …)`) · `p_osm` f64 (0 for tree-row samples).
- Street furniture kinds (from OSM nodes; `workers/props.ts` places procedural
  furniture where these are absent): `20 bike-share dock` (var = capacity) ·
  `21 post box` · `22 bench` · `23 waste basket` (var 1 = recycling) ·
  `24 fire hydrant` · `25 bus stop` (var bit 0 shelter, bit 1 bench, bit 2 bin) ·
  `26 newspaper box` · `27 bicycle parking` (var = capacity) ·
  `29 parking pay station`.

Rail
- `l_off` u32 · `l_xyz` f32 · `l_class` u8 (`0 main rail · 1 siding/yard/spur ·
  2 subway · 3 light rail · 4 tram · 5 other`) · `l_flags` u8 (as roads) ·
  `l_osm` f64.

## manifest.json

```json
{
  "version": 1,
  "projection": "+proj=tmerc ...", "origin": [lat, lon], "datum": 75,
  "tileSize": {"0":1024,"1":4096,"2":16384}, "terrainGrid": {...}, "groundRes": 256,
  "bounds": [minE, minN, maxE, maxN],
  "tiles": {"0": [[tx,ty],...], "1": [...], "2": [...]},
  "region": [[[E,N],...]],   // simplified region polygon(s)
  "municipalities": [{"name": "...", "label": [E,N]}]
}
```

## Transit (`data/transit/`)

- `index.json` — agencies, routes (`id, agency, short, long, mode, color,
  textColor`), service profiles and which files exist.
  `mode ∈ subway | streetcar | lrt | commuter_rail | airport_rail |
  intercity_rail | bus`.
- `{agency}_{profile}_{rail|bus}.bin.gz` (TBN1), `profile ∈ weekday | saturday | sunday`.
  Times are seconds since the service day's local midnight (may exceed 86400).
  Shapes are **absolute world** f32 (E, N, elevation datum). Full definition in
  `docs/TRANSIT.md` (owned by the transit module).

## Rail network (`data/rail/network.bin.gz`)

Switch-level track graph (TBN1) with draped, smoothed (`rail_geom.fillet`) edge
geometry, speed limits, direction rules, movement rules at switches, platform extents;
header lists passenger depots and level crossings. Rail timetable files reference it by
hash. Full definition in `docs/RAIL.md`.

## Landmarks (`data/landmarks.json`)

`[{ "id": "cn_tower", "name": "CN Tower", "pos": [E, N], "base": elev,
"rotation": rad, "suppress": [osmIds...] }]` — `rotation` is CCW about +y from
the model's canonical orientation; `suppress` lists OSM building ids the tile
renderer must skip because the custom model replaces them.

## Road graph (`data/graph/{tx}_{ty}.bin.gz`, level-0 grid)

Drivable roads (classes 0–6) split at intersections; built by
`pipeline/tpipe/graph.py`. Each edge lives in the tile containing its
midpoint; nodes are duplicated into every tile that references them and are
unified client-side by OSM id. Positions are tile-local like render tiles.

- `n_id` f64 (OSM node id) · `n_xyz` f32 [3·nN] · `n_flags` u8 (`1 traffic
  signals · 2 stop sign`)
- `e_from`, `e_to` u32 — indices into this tile's node table. Geometry runs
  from → to. Two-way roads are one edge with lanes in both directions.
- `e_off` u32 [nE+1] · `e_xyz` f32 — densified (≤ 12 m) draped geometry incl.
  bridge/tunnel profiles, first/last vertex = from/to node.
- `e_len` f32 m · `e_class` u8 (road classes) · `e_lanes_fwd` / `e_lanes_bwd`
  u8 (bwd = 0 ⇒ one-way) · `e_speed` f32 m/s (maxspeed or class default) ·
  `e_flags` u8 (road flags; `32` = parking aisle / driveway / drive-through, not drawn as a road) · `e_name` u16 (header `names`) · `e_osm` f64 ·
  `e_width` f32 m (as render `r_width`) · `e_side` u8 (as render `r_side`).

## Urban detail (client-derived, no extra tile arrays)

`workers/rooftops.ts` + `workers/urban.ts` derive, per level-0 tile and
deterministically (OSM id / position seeded): parapets, penthouses and roof
finishes (baked into the building mesh), rooftop equipment, construction sites
(ground class 18 components; vector outline from `gp_*` class 18 when present)
and laneway furniture (`r_svc` 3 = `service=alley`; without `r_svc`, named
"Lane …" service roads or unnamed old-city service roads with houses along
them). Records are `USTRIDE` = 9 floats: kind, x, n, z, angle, sx, sy, sz,
variant (kinds in `UK`), rendered by `layers/UrbanLayer.ts`.
