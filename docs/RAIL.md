# Rail network, routes and simulated transit vehicles

Owner: transit-agents module. Covers the switch-level track graph and per-pattern
rail routes built by the pipeline (`pipeline/tpipe/rail_graph.py`,
`rail_routes.py`, `rail_validate.py`), road-matched bus shapes (`bus_roads.py`),
and the agent simulation of trains, streetcars and buses in the Rust sim
(`sim/src/rail.rs`, `sim/src/bus.rs`, hooks in `world.rs` / `lib.rs`).
Coordinates / TBN1 are defined in `docs/SPEC.md`; timetable files in `docs/TRANSIT.md`.

## Pipeline

```
cd pipeline && uv run python -m tpipe.rail_graph [--rebuild]   # graph report (cached in work/rail_graph.pkl)
cd pipeline && uv run python -m tpipe.transit [agency ...]      # routes rail patterns + writes data/rail/network.bin.gz
cd pipeline && uv run python -m tpipe.rail_validate [agency ...] [--compare DIR] [--strict]
```

### Track graph (`rail_graph.py`)

- Source: every OSM way with `railway ∈ {rail, subway, light_rail, tram, narrow_gauge}`
  incl. `service=siding|spur|yard|crossover` (tourism narrow gauge dropped).
  Main-line (`rail`) yards are left out of the output except the passenger depots below.
- **Repairs** (logged): distinct nodes within 0.6 m on the same layer are merged
  (duplicated nodes, e.g. at Union); a dangling end aligned with another dangling end
  within 25 m is joined (mapping gaps); a dangling end running into another track
  (≤ 2.5 m lateral, ≤ 35°) becomes a switch on it (unconnected crossovers / sidings);
  manual fixes in `FIXES`.
- **Graph**: nodes where tracks join / split / cross / end or where class / service
  changes; edges = track between them with the OSM geometry, draped on terrain per
  *stroke* (straightest continuation through nodes) with the grade profile (tunnel cover
  subway 14 m, LRT 10, tram 8, rail 10; bridge clearance 6 m) and blended onto node
  heights of longer strokes within 150 m, then 3-D RDP (0.2 m).
- **Movement rules** at a node: continuing from one edge end into another only when the
  path turns by less than 40° (rail) / 45° (subway) / 55° (LRT) / 75° (tram) there,
  measured over 8 m — the trunk of a switch reaches both legs, legs never reach each
  other, a diamond connects opposite arms.
- **Speed limits** per vertex (0.5 m/s units): OSM `maxspeed` (mph or km/h), else class
  default (rail 130, subway 80, LRT 70, tram 40 km/h; sidings 25, yards 15, crossovers
  40 / 25 km/h), capped by curvature `v = sqrt(a_lat · R)` (R from ±15 m, a_lat 1.1 rail,
  1.0 subway, 0.9 LRT/tram).
- **Directions** (`e_dir` bit 1 forward, 2 backward): subway / LRT / tram double track
  runs on the right — a track whose parallel twin of the same class (2.5–16 m away,
  7.5 m for trams; not a track it meets itself, i.e. not loop / siding / platform pairs)
  lies consistently on one side is one-way, travelling with the twin on its left. Short
  pieces (< 30 m) between switches inherit the direction when both straight neighbours
  agree. Direction tags (`railway:preferred_direction`) are used only where there is no
  twin (Toronto's tram tags contradict the geometry about half of the time). Main-line
  rail is bidirectional (CTC); routing prefers right-hand running.
- **Platforms**: OSM platform outlines (`railway=platform[_edge]`,
  `public_transport=platform`) within 6.5 m of a track → extents along the edge.
- **Depots** (`DEPOTS`): curated facilities (GO Willowbrook, Don, Bathurst North, Whitby
  East RMF, Shirley, Lincolnville, Milton, Kitchener, West Harbour; VIA TMC; TTC Wilson,
  Davisville, Greenwood, Keele; Line 5 Mount Dennis, Line 6 Finch West, ION OMSF;
  streetcar Roncesvalles, Russell, Leslie). Each is the nearest connected yard / siding
  component (≥ 250 m of track) of its track class within 2.5 km of the given point.
- Track shared with an LRT (`LRT_SHARED_OPERATORS`, ION on the CN Waterloo Spur) is
  typed light rail.

### Rail routes (`rail_routes.py`)

Each GTFS rail pattern becomes a directed path through the graph: candidate positions per
stop (compatible tracks near the GTFS shape at the stop, in its direction, allowed by the
track's direction rule; the stop point is where the consist **front** stops: platform end
in the direction of travel minus a margin, else the GTFS stop centred under the train;
streetcars stop with the front at the pole), shortest valid paths between consecutive
stops (Dijkstra over directed edge states following the movement rules; edge cost = length
weighted by the distance to the GTFS shape *between those stops*, penalties for sidings,
yards, running against the shape, left-hand main-line running and diverging moves), and a
Viterbi over the stop candidates. The route is extended back from the first stop by the
consist length + 20 m. Its geometry **is** the pattern's shape in the timetable file, so
timetable-driven and simulated trains run on the same line.

Consist lengths used (match `app/src/models/consists.ts`): subway 138.6 (Line 4 92.6),
LRT 62.6 (Line 6 47.6, ION 30.8), streetcar 30, GO 334.6 (RH / ST 282.3), UP 78.3, VIA 152.8.

`rail_validate.py`: per pattern the route is connected (allowed movements), directional,
its shape equals the route geometry and its stops lie on it; network hash matches; lists
track travelled in both directions by one mode (terminal areas, single track).

### Road-matched bus shapes (`bus_roads.py`)

Bus pattern shapes are matched onto the drivable road graph (`data/graph`): stop-to-stop
shortest paths weighted by the distance to the GTFS shape, one-ways respected, U-turns only
at dead ends; the result is offset into the curb lane (`laneShapes: true` in the file
header, no render-time lane offset). Stretches with no legal path keep the GTFS shape and
are reported in `pipeline/work/bus_road_gaps.json` (pattern, stop positions) — roads
missing from the graph (station bus loops, busways, …).

## Data

### `data/rail/network.bin.gz` (TBN1)

Header: `version, hash, kinds ["rail","subway","light_rail","tram"],
depots: [{id, name, group (0 rail, 1 subway, 2 LRT, 3 tram), agencies, edges}]`.

| array | type | meaning |
|---|---|---|
| `n_xyz` f32 [3·nN] | node position (world E, N, elevation) |
| `n_flags` u8 | 1 switch · 2 diamond · 4 end of track · 8 created by a repair |
| `n_osm` f64 | OSM node id (negative: synthetic) |
| `e_from`, `e_to` u32 | nodes |
| `e_off` u32 [nE+1], `e_xyz` f32 | edge geometry from → to (absolute world) |
| `e_vlim` u8 [nV] | speed limit of the segment starting at each vertex, 0.5 m/s units |
| `e_vflags` u8 [nV] | per segment: 1 bridge · 2 tunnel |
| `e_len` f32 | horizontal length |
| `e_kind` u8 | 0 rail · 1 subway · 2 light rail · 3 tram |
| `e_service` u8 | 0 main · 1 siding/spur · 2 yard · 3 crossover |
| `e_dir` u8 | 1 forward allowed · 2 backward allowed |
| `e_flags` u8 | 1 bridge · 2 tunnel · 4 electrified · 8 repaired |
| `e_osm` f64 | OSM way id (first) |
| `c_off` u32 [2nE+1], `c_to` u32 | movements: leaving edge end `2e+k` (k 0 = at from, 1 = at to) you may enter the edge ends `c_to[c_off[x]..c_off[x+1]]` |
| `p_off` u32 [nE+1], `p_s` f32 [3·n] | platform extents per edge (s0, s1, side) |

### Additions to `{agency}_{profile}_rail.bin.gz`

Header `railNetwork` = network hash (a mismatch disables agents for the file).

| array | type | meaning |
|---|---|---|
| `pat_len` f32 | consist length the stop positions were computed for |
| `pat_rflags` u8 | 1 route ok (agent-capable) · 2 routed with a gap · 0 not routed |
| `pat_rstart` f32 | offset into the first route edge (along travel) where the route / shape starts |
| `pat_redge_off` u32 [nPat+1], `pat_redge` u32 | route edges, `2·edge + (1 if travelled backward)` |
| `trip_next` i32 | next trip (index in this file) of the same GTFS vehicle block starting where this one ends within 90 min; −1 none |

`pat_stop_dist` is the consist **centre** at each stop (front − `pat_len`/2; virtual
bbox-edge points unchanged). Bus files also carry `trip_next`.

## Simulation (`sim/src/rail.rs`)

- **Resources**: every edge is cut into blocks (rail 800 m, subway / LRT 150 m — CBTC-like,
  tram 120 m) that are exclusive; every switch / diamond is an exclusive interlocking zone
  covering the fouling length of each arm (55 / 35 / 28 / 18 m); every edge that loaded
  routes use in both directions carries a traffic-direction lock (shared by trains running
  the same way, exclusive against the opposite way).
- **Plan** = a pattern's route as the ordered list of resource spans (route-distance
  intervals). Spans are acquired in groups: a junction zone binds everything overlapping it
  (a chain of switches is one interlocking), and a train entering a bidirectional run locks
  the direction of the whole run.
- **Movement authority**: a train holds every span from its tail to the first span it could
  not reserve; it reserves ahead within its braking distance + a sighting margin and releases
  spans once its tail has passed. It never passes the end of its authority (braking curves +
  hard clamp) ⇒ two trains can never share a block, junction or single-track run the wrong
  way. Streetcars run **on sight**: they follow the vehicle ahead on their track (and still
  reserve junctions and single-track runs); with the road sim they also stop for car bodies
  across the track ahead and for red / amber road signals where the track enters a
  signalised junction (`Sim::tram_road`); cars treat them as obstacles (doors-open rule).
- **Dynamics** per mode (`dyn_for`): traction a0 limited by power (a ≤ p/v), service /
  emergency brake, jerk, vmax, stopping margin, min dwell (subway 1.1 m/s², 88 km/h;
  Flexity LRT / streetcar 1.2 m/s²; GO MP40 + 12 BiLevels 0.45 m/s², 4.2 W/kg, 150 km/h;
  UP DMU; VIA). Civil limits apply under the whole train, lower limits ahead are braked for.
- **Timetable as a guideline**: at a stop a train dwells ≥ its minimum dwell and never
  leaves before the scheduled departure; when early it cruises at the speed that arrives on
  time (≥ 55 % of the line speed), when late at line speed.
- **Lifecycle**: trips whose scheduled position is within the rail radius (9 km) of the focus
  become agents at that position (behind whatever occupies it, else pending = not drawn);
  a trip ending where the next trip of its vehicle block starts continues as it — same
  direction, changing ends in place, or an empty-stock **turnback** (≤ 3 changes of ends at
  dead ends / tail tracks / long tracks past a switch); the first trip of a block **pulls
  out** of the nearest depot (a parked train, or one put on a free depot track; from a depot
  outside the radius the empty train enters across the boundary) and the last one **pulls
  in** to a free depot track and parks (lights off). Depots entering the radius are filled
  by time of day. Trains leaving the radius are handed back to the timetable with their
  delay (the renderer shifts the timetable position, recovering 6 s/min). Nothing is placed
  or removed within 2 km in the camera's view cone.
- **Player train**: `rail_player_attach(feed, trip)` makes a trip's agent player-driven
  (throttle / brake command); the interlocking still applies and ATP supervises the service
  braking curve to the authority and to speed limits: it warns for 3 s, then applies the
  penalty brake to a stop (released when stopped with the controller in brake).
- **Checks**: `RailSim::check` counts body overlaps (must be 0), `overruns` counts authority
  overruns (must be 0), `audit` checks the reservation tables.

## Buses (`sim/src/bus.rs`)

A bus is a car of the road sim with a `BusAgent`: lanes, car-following, signals and junction
reservations as for any car; at each junction it takes the out-link that follows its pattern
shape; it moves to the curb lane ~220 m before a stop, stops with its front door at the pole,
dwells ≥ 8 s and not before the timetable; after its last stop it continues as the next trip
of its block, pulls in to a garage (road route) or drives off as traffic. The first trip of a
block pulls out of a garage (TTC Arrow Rd, Birchmount, Malvern, McNicoll, Mount Dennis,
Queensway, Wilson; MiWay, YRT, Brampton, DRT, HSR, GRT, Burlington, Oakville, GO — list in
`TransitLayer.ts` `GARAGES`). The TransitLayer hands timetable buses within 0.8 × the car
radius to the sim.

## Runtime (`app/src/sim/*`, `app/src/layers/TransitLayer.ts`)

The worker loads `network.bin.gz` and the rail files of the renderer's profile
(`TickMsg.railProfile`), steps the rail sim over the full sim time (chunks ≤ 0.25 s,
independent of the car budget) and publishes rail records + consist paths and bus records +
lane paths in each SAB slot (`protocol.ts`). The TransitLayer draws agent-driven vehicles
car by car along the published paths (no timetable drawing for those trips), hides pending /
finished trips, and keeps timetable vehicles from popping in or out in view.
QA (`window.__qa`): `trainOverlaps`, `railOverruns`, `railAgents`, `railPullouts`,
`railPullins`, `railParked`, `transitDupes`, `vehicleSpawnInView`, `pickTest()`,
`carsTarget/carsActive/pedsTarget/pedsActive`, `carsStoppedInBox`.

Tests: `cd sim && cargo test --release -j 4` — scenarios (following trains, opposing trains
on single track, never departs early, player behind an AI train, streetcar at a red,
streetcar behind a car, bus stop + schedule) and real data (`tests/rail_real.rs`: Union
morning peak, Union–Bloor–Weston corridor with GO Kitchener / UP / VIA, early-morning
pull-outs; 0 overlaps / overruns asserted).
