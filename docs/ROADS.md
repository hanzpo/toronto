# Roads, bridges, rail track and street surfaces

Owner: roads / corridors work. Pipeline: `pipeline/tpipe/roadnet.py` (network
model), `pipeline/tpipe/rail_geom.py` (shared track smoothing),
`pipeline/curated/corridors.json` (hand-curated structures). Client:
`app/src/workers/roads.ts` (meshing), `app/src/render/tiles/roadMaterial.ts`
(surfaces and markings), `app/src/layers/CrossingsLayer.ts` (level crossings),
signal placement in `app/src/workers/street.ts` (signals part only).

OSM tells us what a road *is*; its final geometry comes from this model. The
render tiles (`r_*`, `l_*`, `j*`, `sg_*`, `md_*`, `k_*`) and the traffic graph
(`data/graph`) are both built from one file, `pipeline/work/roadnet.npz`, so
cars drive on the same centrelines, elevations and lanes that are drawn.

## Build

```sh
cd pipeline
uv run python -m tpipe.osm_extract      # (tags: service, cycleway, lanes:fwd/bwd, surface, width, crossings, level crossings)
uv run python -m tpipe.roadnet          # -> work/roadnet.npz, work/roadnet_report.json, data/crossings.json
uv run python -m tpipe.osm_tiles --workers 2
uv run python -m tpipe.graph
```

`roadnet` runs a cheap global pass (strokes, lane sanity, merge events), then
processes the region in 16 km blocks with a 1.5 km halo on 2 forked workers.
Each block writes only its core (pieces keep the segments whose midpoint lies
in the core, so blocks share boundary vertices). It checks its own peak RSS and
aborts above `TPIPE_MEM_GB` (default 4). A downtown block peaks at about 0.8 GB.

Debug on an extract: `TPIPE_WORK=work/test_dt uv run python -m tpipe.roadnet`
(then `osm_tiles --only-l2=TX,TY` and `graph` with `TPIPE_OUT=<scratch>`).

## The network model (`tpipe.roadnet`)

1. **Classification.** Parking aisles, driveways and drive-throughs
   (`service=*`) are not drawn as roads (flag 32, `F_LOT`). They are kept as
   `k_*` centrelines in the tiles for parking-lot generation and removed from
   the traffic graph. Footways that duplicate a drawn sidewalk (tagged
   `footway=sidewalk`, crossing ways, or an untagged footway running beside
   a street for 80 % of its length) are dropped (flag 64). Bus loops,
   `highway=busway` and `service=bus` stay as roads.
2. **Strokes.** Ways are joined end to end into continuous carriageways and
   tracks. At every node, the pair of way ends with the smallest deflection
   is joined, with penalties for a change of class, link-ness or name. The
   join goes through junctions, merges and diverges, so the mainline stays one
   stroke. Lane widths, tapers and dash phase are continuous along a stroke.
3. **Lanes and widths.** `nF` / `nB` come from `lanes`, `lanes:forward` and
   `lanes:backward`.
   - Phantom lanes are fixed. A bridge or tunnel way with ≥ 1.5× and ≥ +2
     lanes over both neighbours, or a short freeway piece with ≥ 2× and ≥ +3,
     gets its neighbours' lane count. Fixes are listed in
     `roadnet_report.json`.
   - A `width` tag is ignored on bridges and tunnels, where it is often the
     deck width, and is only used when plausible.
   - Lane widths: 3.75 m on freeways (MTO DS 2023), 3.4 m on arterials.
   - Shoulders: right 3.0 / left 2.5 m on freeways, right 2.5 / left 1.0 m on
     ramps.
   - Bike lanes are 1.7 m, buffered lanes 2.5 m (OTM Book 18).
   - Each vertex carries edge-line offsets `eL`/`eR` and pavement offsets
     `pL`/`pR`.
4. **Tapers.** Width changes between ways taper per OTM Book 11 / TAC:
   `L = S·W/1.6` at 70 km/h and above, `L = W·S²/155` below. An added lane
   reaches full width at the node; a dropped lane tapers after it.
5. **Merges and diverges.** A one-way freeway or ramp node with a branch
   within 40° of the mainline is a merge or diverge event.
   - The mainline gets an auxiliary lane: acceleration 260 m + 90 m taper,
     deceleration 150 m + 75 m taper. The lengths are close to the TAC
     parallel-type lane (about 350 m including a 90 m taper).
   - Aux lanes closer than 350 m join into a weaving lane.
   - If OSM already counts the lane, the added lanes are marked auxiliary
     instead.
   - The ramp is pushed beside the mainline's edge near the node, so the two
     ribbons abut and never overlap.
   - The gap between the edge lines, up to 4.5 m, becomes a painted gore:
     white herringbone at 6 m centres (OTM Book 11).
   - The glued stretch drops its shoulders and gets a continuity line
     (20 cm, 3 m on / 3 m off).
6. **Smoothing.** Every unpinned vertex becomes a tangent arc
   (`rail_geom.fillet`). The design radius depends on class: freeway 900 m,
   ramp 70 m, arterial 150 m, local 30 m; main rail 900 m, LRT 60 m, streetcar
   15 m. The radius is limited by the length of the neighbouring segments.
   Junction, switch and stroke-end nodes are pinned.
7. **Grade separation.** Every crossing of road and rail centrelines without
   a shared node is found with an STRtree.
   - **Upper line.** Tags decide first: tunnel, then bridge, then layer.
     Untagged crossings with a freeway, or between road and rail, are decided
     by the raw DSM: the lower line shows the deck as a bump. Otherwise the
     local road goes over the at-grade freeway.
   - **At grade.** Path × road, path × rail and road × road crossings without a
     node stay at grade and are listed in the report.
   - **Clearances.** Toronto ECS bridge standard: 5.0 m over roads, 5.3 m for
     pedestrian bridges over roads, 7.0 m over rail, 2.7 m over paths. Deck
     depth is 1.3 m for streets, 1.9 m for freeways, 2.0 m for rail and
     0.8 m for footbridges.
   - **Structures.** The upper line is marked as a structure across the lower
     line's width ÷ sin(crossing angle), because OSM bridge ways often stop
     short.
8. **Vertical profile.** Each stroke is solved as regularised least squares:
   `min Σ w(z − ground)² ds + Σ ℓ⁴ (z″)² ds + Σ ℓ²/4 (z′)² ds`.
   - Weights: ground weight is 1 at grade, zero on decks, and weak toward
     `ground − cover` in tunnels.
   - Length scale ℓ per class: freeway 90 m, streets 55 m, rail 220 m,
     tram 45 m.
   - Active-set inequalities: clearances over crossings; decks at least
     1.2 m over the ground, ramping in from the abutments; tunnels keep their
     cover, ramping in from the portals; at-grade roads never below ground.
   - Hard pins: curated corridor profiles and node pins.
   - Node pins make all strokes at a junction agree on its elevation. Rail
     wins at level crossings, and paths only agree with paths.
   - A final grade limiter removes cliffs where constraints conflict. It
     allows streets 12 %, freeways 7 %, rail 4 %, trams 9 % and stairs 80 %.
   - Vertices whose elevation departs from the ground are flagged `graded`.
     The client draws them at the solved height and adds embankments
     (1:2 grass) or retaining walls.
9. **Streets.** Sidewalk bits per vertex (`r_sw`):
   - OSM `sidewalk*` tags; otherwise both sides where buildings are near.
   - Divided roads: no sidewalk on the median side of a carriageway whose
     same-name twin is on its left.
   - Bridges keep their sidewalks: a deck sidewalk behind the parapet.
   - Grass boulevards where the nearby buildings are mostly houses.
   - A paver band by the curb where they are mostly commercial.
10. **Intersections.** Junction nodes (≥ 3 arms, classes ≤ 6, at least two
    street arms) that are joined by pieces shorter than 32 m form one
    intersection. This covers dual carriageways and median right-of-ways.
    - **Legs.** Arms within 28° are grouped into legs. Each leg's crosswalk
      line sits past every crossing pavement edge. Every member node gets
      arm radii that put its crosswalk and stop bar on that one line.
      Internal links carry no markings.
    - **Surface.** One pavement polygon per intersection: the union of the
      approach carriageways, closed with 5–7 m curb-return fillets and
      clipped to the crosswalk lines.
    - **Sidewalk corners.** Continuous around the curb returns. Curb faces
      follow the arcs.
    - **Tactile plates.** Toronto cast-iron TWSI (dark, rust patina, 0.61 m
      deep) sit at each crosswalk end.
    - **Signal poles.** Far-right corner with a mast arm over the approach
      lanes, near-right corner with a short arm, and median noses on divided
      legs. One signal group per intersection (`sg_cl`).
11. **Medians.** A median is drawn between same-name opposite carriageways
    0.8–30 m apart. It is a curbed strip (concrete, or grass above 4 m) that
    ends at the intersection with a nose. Where rail runs in it, it is a
    right-of-way (kind 2) and the track sits on a grass bed, like Line 5
    Eglinton and Line 6 Finch West.
12. **Rail embedding.** Streetcar track, and any track inside an intersection
    or across a carriageway, is set in concrete panels with grooved rails. It
    has no ballast.

## Curated structures (`pipeline/curated/corridors.json`)

Each entry names the ways, by name or OSM id, a class limit and a profile of
`[lon, lat, height]` control points. `above_ground` heights are measured over
the 150 m-smoothed bare-earth terrain. Vertices within `snap` m of the
control polyline are pinned; ramps are pinned only where they are bridges.
Optional fields:

- `structure`: girder, portal, hammerhead, truss, arch, footbridge or rail.
- `main_span`: a span with a different structure, such as a truss over a
  shipping canal.
- `force_bridge`: fills OSM gaps.
- `pin: false`: sets the structure type only.

| structure | profile / structure | sources |
|---|---|---|
| Gardiner Expressway, elevated (east of Dufferin to the Don) | Rises from grade at Dufferin to 8.5–11 m by Strachan, 11–12.5 m through downtown, then 9 m at the Don. Portal bents (2–3 columns, concrete caps) every ~20 m. | Dillon / Waterfront Toronto *Gardiner East EA, App. J: Infrastructure Baseline* (2016): 2–3 column bents, 18–21 m spans (30 m at Yonge / Jarvis / Sherbourne / Parliament / Cherry), 33–44 m deck. [Wikipedia](https://en.wikipedia.org/wiki/Gardiner_Expressway): elevated for 6.8 km. Deck height is estimated from photos (not confirmed). |
| Burlington Bay James N. Allan Skyway (QEW) | Rises to ~41 m. 151 m truss main span, girder approaches. | [Wikipedia](https://en.wikipedia.org/wiki/Burlington_Bay_James_N._Allan_Skyway): 36.7 m clearance, 151 m main span, 83.7 m back spans. |
| Garden City Skyway (QEW over the Welland Canal) | Rises to ~40 m, 110 m truss main span. | [Wikipedia](https://en.wikipedia.org/wiki/Garden_City_Skyway): 2.2 km, 35.5 m ship clearance. |
| Prince Edward (Bloor) Viaduct | Arch structure type. The deck follows the valley rims (~40 m over the Don). | [Wikipedia](https://en.wikipedia.org/wiki/Prince_Edward_Viaduct): 494 m, 40 m, three-hinged steel arches. |

Everything else is generic: bridge tags, inferred structures, clearances and
node consistency. Examples are the DVP flyovers, the 401 express / collector
transfers, the 400/404/427/409 interchanges, the 403/410/407, the Allen, the
Humber and Don bridges, the GO bridges over the Don and Humber, and the
Leaside Bridge. Add a curated entry when a structure needs a specific height
or type.

## Tile arrays (additions to docs/SPEC.md, level 0 unless noted)

Roads (all levels; per vertex unless noted):
- `r_s` f32: stroke-continuous distance, which sets the dash phase.
- `r_el`, `r_er` f32: edge-line offsets left / right of the centreline (m).
- `r_pl`, `r_pr` f32: pavement offsets.
- `r_lw` f32: nominal lane width.
- `r_mk` u32: marking bits.

  | bits | meaning |
  |---|---|
  | 0-3 | `nF` |
  | 4-7 | `nB` |
  | 8-9 | aux lanes right |
  | 10-11 | aux lanes left |
  | 12 / 13 | gore right / left |
  | 14 / 15 | no edge line right / left |
  | 16 / 17 | continuity edge right / left |
  | 18-20 | bike facility right |
  | 21-23 | bike facility left (`osm_extract._cycleway`) |

- `r_vf` u8: bit 0 bridge, 1 tunnel, 2 graded (use z), 3 embedded track;
  bits 4-7 structure type (`STRUCT`).
- `r_sw` u8: bit 0 left walk, 1 right walk, 2 / 3 boulevard left / right,
  4 pavers, 5 median on the left.
- `r_dz` f32: height over the pipeline terrain. The client drapes on its own
  terrain mesh plus `dz`, and blends to the absolute `z` on decks and high
  embankments.
- Per piece: `r_sub` path sub-kind, `r_svc` service kind, `r_surf` surface,
  `r_cyc` cycleway bits. `r_width` is now the median pavement width;
  `r_lanes` is nF + nB.
- Pieces are split where class, bridge or tunnel status changes, so the
  piece flags mean what they say.

Rail: `l_vf`, `l_dz` per vertex, as above.

Junctions:
- `j_cl` f64: intersection id, the smallest member node id.
- `j_arm_flags`: bit 1 = internal link (no markings).
- Surfaces: `js_xy` f32, `js_tri` u32.
- Corner sidewalks: `jw_xy`, `jw_tri`.
- Curb lines: `jc_off`, `jc_xy`.
- Tactile plates: `jt_xy`, `jt_ang`, `jt_w`.
- Signal poles: `sg_xy`, `sg_ang` (the heads face traffic arriving along this
  angle), `sg_mast` (m), `sg_kind` (0 far, 1 near, 2 median), `sg_cl`.

Medians: `md_off`, `md_xyz`, `md_w` (width per vertex), `md_kind`
(0 concrete, 1 grass, 2 rail right-of-way).

Parking-lot hook: `k_off`, `k_xyz`, `k_svc` hold the hidden service
centrelines (1 parking aisle, 2 driveway, 4 drive-through).

Street points: `p_kind` 5 is a railway level crossing and 6 a railway foot
crossing; `p_var` bit 0 means gates and bit 1 lights. `p_kind` 7 is a
streetcar stop. Crossing `p_var` 3 is a pedestrian crossover (PXO), drawn as
a ladder with shark teeth.

## Level crossings

`data/crossings.json` holds `{crossings: [{id, e, n, kind, gates, lights,
roads, tracks, approaches: [{heading, mast, yaw, arm, cant}]}]}`. It is
written by `roadnet.write_crossings`.

- **Gates.** Untagged road crossings of main-line or freight track are
  gated; streetcar crossings are not.
- **Drawing.** `CrossingsLayer` draws the masts: crossbucks (1.22 × 0.2 m
  blades, white with a red border), a flasher pair, a bell housing, and
  cantilevers where the road is wider than 15 m. It also draws red/white gate
  arms and the flasher lenses.
- **Road surface.** Rubber / concrete panels, with paired stop lines 4.8 and
  5.4 m before the track (Transport Canada GCS, OTM Book 11).
- **Hook.** `window.__street.setCrossing(osmNodeId, state)`, also on
  `window.__crossings`.
  - States: 0 idle, 1 warning (the lights flash alternately and the gates
    lower over 8 s), 2 gates down. Back to 0 raises the gates over 8 s.
  - `__crossings.crossings()` returns the list for the sims.

## Rail geometry (for the train simulation)

`tpipe.rail_geom` is the canonical smoothing. Use `fillet(xy, pinned, R)` on
any track polyline, with `RAIL_RADIUS[cls]`. Pin switches, diamonds and ends.

`load_rail()` returns the rendered rail pieces from `work/roadnet.npz`: world
xyz, per-vertex flags (bridge, tunnel, embedded, structure) and the OSM way
ids per piece. It gives exactly the centrelines and elevations the tiles
draw, including rail raised onto embankments and bridges by the grade
separation solve. The train sim should follow these. The same xy can be
reproduced from OSM with `fillet` and the class radii.

## Standards and references used

- **Ontario Traffic Manual, Book 11** (pavement markings):
  - Lane lines: 10 cm, 3 m on / 6 m off (urban) or 3/9 (≥ 90 km/h).
  - Edge lines: yellow left, white right, 20 cm at ramps.
  - Continuity lines: 20 cm, 3/3.
  - Gore herringbone: 45–60 cm at 6 m centres.
  - Stop bar: 30–60 cm, 1 m behind the crosswalk.
  - Tapers: L = S·W/1.6.
  - Railway crossing: paired stop lines ≥ 4.5 m before the rail.
- **OTM Book 15** (pedestrian crossings):
  - Zebra: 0.6 m blocks at 0.6 m spacing.
  - Ladder: 0.6 m bars between 0.2 m lines.
  - PXO Level 2: ladder plus shark teeth 6 m before the crossing,
    0.3–0.6 × 0.45–0.9 m.
- **OTM Book 18** (cycling):
  - Bike lanes 1.5–1.8 m; separated lanes 1.8 m + 1.0 m buffer.
  - Sharrow: 1.0 × 2.0 m symbol, two chevrons, at least every 75 m.
- **MTO Design Supplement (2023):**
  - Freeway lanes 3.75 m.
  - Shoulders: right 3.0 m, left 2.5 m.
  - Ramp shoulders: right 2.5 m, left 1.0 m.
  - Grades 3–5 %.
- **TAC GDG (2017)**, via the CSCE 2018 paper: parallel acceleration lane
  ≈ 350 m including a 90 m taper.
- **Toronto ECS bridge design standard (2022):** 5.0 m clearance for vehicles,
  5.3 m for pedestrian bridges.
- **Toronto streets:**
  - Pedestrian clearway: ≥ 2.1 m (T-310.010-10).
  - Curb: 150 mm.
  - TWSI: cast iron (Tactile Walking Surface Indicators fact sheet 2019).
  - Curb radii: 4–15 m (Curb Radii Guideline 2018).
- **TTC:**
  - Gauge 1,495 mm; track in a 280 mm concrete slab (TS 3.75).
  - Grand unions at King/Bathurst, King/Spadina and Queen/Spadina
    (Steve Munro).
- **Transport Canada Grade Crossings Standards (2019):**
  - Crossbuck: 1,220 × 200 mm blades.
  - Lights: 200/300 mm, 2.3–2.9 m high.
  - Gate lights: 3 per arm.
- **Line 5 Eglinton:** grass track in the median, paved at intersections and
  stops.
- **Line 6 Finch West:** 36 m street right-of-way, ~8 m LRT guideway.

## QA

`uv run python -m tpipe.qa --categories road_width_step,road_overlap_nonjunction,flat_crossing,deck_below_clearance,bridge_width_anomaly,junction_hardware_on_grade_sep,elevation_jump,sidewalk_bridge_discontinuity,dash_phase_break,duplicate_footway,footway_as_road`

Several checks were adapted to the network-model tiles:

- Sidewalks are read from `r_sw`.
- Elevations are the drawn ones: `r_xyz` z, not terrain draping.
- `r_width` is the true pavement width.

Some findings are expected:

- **`dangling_deck`.** A ramp pushed beside the mainline ends next to the
  mainline's edge, not on its centreline node.
- **Width steps across a merge / diverge node.** The branch supplies the
  width.
