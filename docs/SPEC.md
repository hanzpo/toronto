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
  21 platform/plaza · 22 building footprint (levels 1–2 only, far-view texture)`.

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
  12 stadium/sports · 13 hotel · 14 parking structure · 15 roof/canopy`.
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
- `r_off` u32 [n+1] · `r_xyz` f32 [3·nV] (local x, local y, elevation datum),
  densified to ≤ 32 m spacing and draped on terrain (bridges/tunnels
  interpolated between their ends).
- `r_class` u8 — `0 motorway · 1 trunk · 2 primary · 3 secondary ·
  4 tertiary · 5 residential/unclassified · 6 service · 7 pedestrian/living ·
  8 footway/cycleway/path · 9 track`.
- `r_width` f32 m · `r_lanes` u8 · `r_flags` u8 (`1 oneway · 2 bridge ·
  4 tunnel · 8 link/ramp · 16 roundabout`) · `r_layer` i8 ·
  `r_name` u16 (index into header `names`, 0xFFFF = none) · `r_osm` f64.

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
  `e_flags` u8 (road flags) · `e_name` u16 (header `names`) · `e_osm` f64.
