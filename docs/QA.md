# Automated QA

QA here is deterministic, so problems are found by rule rather than by
screenshot. There are three layers:

1. **Static QA** (`pipeline/tpipe/qa/`) runs over the built data. It emits a
   ranked issue list with world coordinates and OSM ids, and it is the primary
   tool.
2. **Runtime counters** (`window.__qa`, `app/src/qa/runtime.ts`) count live
   problems in the browser, such as overlapping cars, wrong-way vehicles and
   double-rendered vehicles.
3. **Visual tour and sweep** (`app/qa/`) visit issues or a fixed, seeded set of
   viewpoints and screenshot them into a contact sheet for before/after review.

Results history is in `docs/qa-results.md`.

## Running

```sh
node app/qa/props_dump.mjs                      # client prop/tree placement dump (incremental, ~2.5 min full)
cd pipeline
uv run python -m tpipe.qa --record              # whole region, 2 workers -> app/public/data/qa/issues.json
uv run python -m tpipe.qa --categories road_width_step,flat_crossing --bbox=-4096,-4096,4096,4096
uv run python -m tpipe.qa.viewpoints            # seeded sweep poses -> app/public/data/qa/viewpoints.json
```

- **`--workers`**: default 2, maximum 4. Each block is 4×4 level-0 tiles plus a
  one-tile halo. Workers keep a 48-tile LRU cache and are recycled every 40
  blocks. The whole region takes about 3 minutes, with a total peak memory of about 1.2 GB at 2 workers.
- **`--bbox=E0,N0,E1,N1`**: world metres. Write it with `=`, because the value
  starts with `-`.
- **`--max-per-cat`**: default 2000. This caps how many findings per category
  go into `issues.json`. `issues_summary.json` always has the full counts, per
  category and per sub-type.
- **`--record`**: appends a row to `docs/qa-results.md`. Add `--note "..."` to
  say what changed.
- **Prop and tree categories** read `pipeline/work/qa_props/*.bin`. That dump is
  produced by running the tile worker's real placement code
  (`workers/roads.ts`, `street.ts`, `vegetation.ts`, bundled with Vite) in
  Node, so the checks see exactly the trees, lamps and signal poles the client
  draws. Re-run the dump after changing that code or the tiles. If a tile has
  no dump, the checks fall back to OSM points.
- **Output order is deterministic**: category, then severity (descending), then
  E, N, OSM ids. Issue ids are `<category>/<rank>`.

### `issues.json`

```jsonc
{"version":1,"generated":"…","build":<manifest build>,"bbox":null,"categories":[…],
 "issues":[{"id":"flat_crossing/1","cat":"flat_crossing","sub":"road_road","rank":1,"sev":12.3,
            "e":-975.2,"n":-867.1,"z":80.4,"osm":[123,456],"desc":"…",
            "view":{"dist":110,"heading":35,"pitch":35}}]}
```

- `e`, `n` and `z` are world metres (docs/SPEC.md).
- `osm` holds way ids (positive) or relation ids (negative). Use
  `https://www.openstreetmap.org/way/<id>`.
- `view` is the orbit camera for `CameraController.jumpTo`: focus at (e, n, z),
  heading in degrees clockwise from north, pitch in degrees below the horizon.

## Categories

Thresholds are constants at the top of each module.

**Roads** (`checks_roads.py`). The ribbon model mirrors `workers/roads.ts`.

| category | sub-types | rule |
|---|---|---|
| road_width_step | no_taper | Two ways meet end to end (degree-2 node, continuing within 45°), and the drawn width jumps ≥ 1.0 m and ≥ 15 % (`WIDTH_STEP_*`). The renderer has no taper, so every such step is a hard notch (screenshot 1). |
| bridge_width_anomaly | wider/narrower_than_approach, wide_per_lane | The deck is ≥ 1.3× (or ≤ 1/1.3×) the median approach width and ≥ 2 m different, or wider than 5.5 m per lane (screenshot 3). |
| road_overlap_nonjunction | ramp_merge, parallel_ways, crossing_ribbons | Flat-capped ribbon quads of different ways overlap by ≥ 12 m² per way pair, within 3 m vertically, outside every junction box (`j_arm_r` + 2 m) and every shared-node disc (1.5× the widest half-width + 2 m). Lane markings then cross lanes (screenshot 2). |
| flat_crossing | road_road, road_rail, rail_rail, path_highway | Centrelines cross with no shared node within 1 m, and neither side is a bridge. The drawn vertical separation is < 4.5 m (road) or < 5.5 m (rail). Tunnels and tram tracks are skipped, and footways count only when they cross a motorway or trunk (screenshot 5). |
| deck_below_clearance | road, rail | As above, but one side is a bridge whose deck is too low (tracks or roads cut through the deck). |
| junction_hardware_on_grade_sep | junction_on_motorway, junction_on_bridge, node_on_motorway | A junction box (stop lines and crosswalks), or a signal, crossing or stop node, sits on a non-link motorway or a bridge deck. |
| elevation_jump | deck_floats, deck_dives, dangling_deck, steep_deck, steep_deck_rail | A deck end differs from the draped road or deck it joins by > 0.6 m, an unconnected deck end is > 1.5 m up, or a deck segment ≥ 3 m long is steeper than 12 %. This covers Gardiner ramps that float or dive. |
| road_below_terrain | deck, rail_deck | A bridge deck, sampled every 4 m, is more than 0.5 m under the terrain. Non-bridge roads are draped, so they can't be under it. |
| duplicate_footway | sidewalk_footway, parallel_path | At least 25 m and at least 50 % of a footway lies within half-width + sidewalk + 2 m of a road that already draws a sidewalk, parallel within 20°. |
| footway_as_road | too_wide, thin_footbridge | A path is drawn wider than 3 m, or a footbridge deck narrower than 2.5 m (screenshot 7). |
| sidewalk_bridge_discontinuity | road_to_deck, footway_dead_end | Sidewalks stop where a bridge deck starts (decks draw none), or a footway dead-ends within 10 m of a deck start. |
| dash_phase_break | phase, lateral, lane_count | At a way boundary the lane dash phase (from `r_v0`, period 9 m or 12 m) jumps by > 0.75 m, or the lane lines shift sideways by > 0.4 m at equal widths. Asymmetric two-way lane splits flip when the way direction flips. |

**Props, trees, buildings and ground** (`checks_objects.py`).

| category | sub-types | rule |
|---|---|---|
| prop_in_lane | signal_pole, lamp | The client-placed pole or lamp is more than 0.3 m inside a carriageway (classes 0–6) at its own level (screenshot 4). |
| tree_on_road | trunk_in_carriageway, crown_through_deck, crown_over_highway | The trunk is more than 0.2 m inside a ribbon, including ramps and decks; the crown pokes through a deck lower than the tree; or the crown reaches ≥ 1.5 m over motorway or trunk lanes. |
| tree_on_rail | trunk_on_track, crown_over_track | The trunk is within 3 m of a track centreline, or the crown edge is within 0.75 m of it (non-tram). |
| tree_on_airfield / tree_on_water | trunk | The land cover under the trunk is aeroway, runway or airfield grass, or water. |
| building_overlap | duplicate_record, coplanar_roof, contained, volume_overlap, house_in_building | Footprints overlap by ≥ 4 m² and ≥ 10 % of the smaller one, with overlapping height ranges. Roofs within 0.5 m of each other z-fight (screenshot 6). |
| floating_object | building_floats, building_buried, house_floats | The base is more than 1.5 m above the highest terrain under the footprint, or more than 3 m below the lowest. |
| raster_shore | stair_steps | A level-0 tile without vector water has ≥ 60 water/land edge pixels. Tiles are skipped automatically once vector water arrays appear (`VECTOR_WATER_KEYS`). |

**Landmarks** (`checks_landmarks.py`).

| category | sub-types | rule |
|---|---|---|
| landmark_overlap | building_not_suppressed, house_not_suppressed, landmark_landmark | The landmark footprint and parts (world frame) overlap a building or house that is not in `suppress` by ≥ 5 m² and ≥ 3 % of that building (the CIBC Square class). |

**Transit** (`checks_transit.py`). This uses bus, streetcar and LRT shapes from
every agency and profile, sampled every 8 m and de-duplicated on a 5 m grid per
heading sector.

| category | sub-types | rule |
|---|---|---|
| transit_route_off_road | bus, streetcar | More than 20 m of samples in a 60 m cell are more than 1 m outside every ribbon (classes 0–7), and streetcars and LRT are not within 2.5 m of a tram or LRT track (screenshot 8). |
| transit_wrong_way | bus, streetcar | More than 15 m of samples lie only inside one-way ribbons, all running more than 135° against the travel direction. Samples within 3 m of a junction box are skipped. Most findings are divided arterials, where the GTFS shape follows the opposing carriageway, so the bus is drawn going the wrong way. |

**Rail** (`checks_rail.py`).

| category | sub-types | rule |
|---|---|---|
| rail_kink | tile_track, graph_edge, pattern_shape, node_movement | The radius at a vertex, (l₁+l₂)/2 ÷ turn, is below the minimum for the track kind. Main lines need 150 m, sidings 60, subway 90, LRT 25 and tram 10. A movement through a graph node that breaks the heading by more than 6/8/12/20° also counts. |
| rail_gap | hole, graph_gap, unconnected_tee | Two drawn track ends of the same class face each other within 25 m, or a graph end runs into another track within 2 m without a switch. |
| route_track_conflict | unrouted, route_not_ok, discontinuous, against_track_direction, shared_double_track | A pattern has no continuous track route, consecutive route edges have no movement between them, an edge is used against `e_dir`, or one route runs both directions on one subway, LRT or tram edge that has a parallel twin. |

## Workflow for agents

1. Run the static QA (after the props dump if you touched placement), then read
   `issues_summary.json` for counts and `issues.json` for the ranked list.
2. **Fix by category, not by screenshot.** Take the top findings of the
   category you own, look at the `desc`, open the OSM ids and fix the cause.
   The cause may be a pipeline rule, a curated override, or the renderer.
   Prefer fixes that clear a whole sub-type.
3. Re-run with `--categories <yours> --bbox=…` around your area while
   iterating. Then do a full run with `--record --note "<what changed>"`.
4. **Before/after visuals** (only when the lead says the machine has room for a
   headless browser):
   - `app/qa/run.sh tour http://localhost:5173 5 <cats> before-<topic>`, then
     after the fix `… after-<topic>`. Attach both `qa-shots/<label>/index.html`
     contact sheets.
   - For broad changes, run the seeded sweep: `app/qa/run.sh sweep
     http://localhost:5173 <label> 50 [tag-prefix] [limit]`. It is resumable;
     compare two labels.
5. **Runtime check**: in the dev console call `await __qa.goto('flat_crossing/1')`,
   then `__qa.sample()` or `await __qa.watch(10)`. This reports counters for car
   overlap, below-ground vehicles, off-road, wrong-way and left-side vehicles,
   double-rendered transit vehicles and long frames.
6. **Keep the checks honest.** If a finding is a false positive, tighten that
   check's rule or threshold in `pipeline/tpipe/qa/` and document it here.
   Don't mass-suppress findings.

Other agents own the data. These checks only read it, and they skip any array
that doesn't exist yet.
