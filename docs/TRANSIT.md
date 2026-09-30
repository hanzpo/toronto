# Transit data & runtime

Owner: transit module (`pipeline/tpipe/transit*.py`, `app/src/transit/`).
Coordinates, datum and the TBN1 container are defined in `docs/SPEC.md`.

## Pipeline

```
cd pipeline && uv run python -m tpipe.transit [--download] [agency ...]
```

- Sources: `pipeline/tpipe/transit_sources.py` (`SOURCES`: key → name, url, mirror,
  mode/colour overrides). Zips live in `pipeline/raw/gtfs/{key}.zip`; `--download`
  fetches missing ones. With agency keys given, only those are rebuilt, and
  `index.json` is merged.
- **Supplementary feeds** (`pipeline/tpipe/transit_extra.py`): a source may list
  `extra` feeds that are merged into its zip before the build
  (`uv run python -m tpipe.transit_extra [--download] [agency]`; the original is kept
  as `raw/gtfs/{key}.base.zip`, extras as `raw/gtfs/{key}+{prefix}.zip`). Extra-feed ids
  are prefixed `{prefix}:`; optional fixes: `platform_suffix` (direction-specific
  platforms get a synthesised parent station) and `trim_shape_spurs` (drop the short
  sharp kink where a shape starts at the stop pole instead of on the track).
  Used for **GRT ION LRT (route 301)**: GRT's main feed (`staticfeeds/1`) is bus-only;
  ION is published by the Region of Waterloo as its own feed `staticfeeds/2`
  (real schedule, not synthetic: 16 stops per direction / 19 stations
  Conestoga – Fairway, release 41, valid 2026-07-05 – 2028-07-03).
  ION shares the `railway=rail` "Ion;CN Waterloo Spur" track (OSM `operator=Grand River
  Transit`, `electrified=contact_line`) in Uptown Waterloo; the rail graph must treat
  those ways as light rail or the LRT router breaks there.
- **Coverage** (checked 2026-09-30): TTC, GO (rail + bus), UP, VIA, YRT/Viva (blue,
  blue B, purple, purple A, orange, yellow), MiWay, DRT (Pulse 900/901), GRT (+ ION),
  HSR (incl. 10 B-Line, 20 A-Line), Brampton (Züm 501/502/505/511/561), Burlington,
  Oakville, Milton, Niagara Region Transit (St. Catharines, Welland, Niagara Falls /
  WEGO 602–604) and Barrie feeds all cover today. **Guelph**: every published copy
  (city URL, MDB mdb-3140/tld-408) ends 2026-05-02, so the last valid dates are used.
  **Bradford (BWG)** is on-demand with no static GTFS (GO buses serve Bradford).
- Rail network: OSM ways with `railway ∈ {rail, subway, light_rail, tram, narrow_gauge}`
  (no yards), read from `pipeline/raw/bbox.osm.pbf` and cached in `pipeline/work/transit_rail.npz`.
- **Service profiles** `weekday | saturday | sunday`. Per agency, the representative
  date is the non-holiday date nearest to 2026-09-29 (future preferred, Tue–Thu for
  weekday; among the 3 nearest the one with ≥97 % of the max trip count). Active
  service_ids come from calendar.txt + calendar_dates.txt. Expired feeds get their
  latest valid date. Chosen dates are in `index.json`.
- **Modes**: route_type 1/400s → `subway`, 0/900s → `streetcar`, 2/100s →
  agency `rail_mode` (GO `commuter_rail`, UP `airport_rail`, VIA `intercity_rail`),
  3/700s → `bus`; per-route overrides (TTC 5, 6 → `lrt`; GRT 301 → `lrt`). Rail
  trips whose headsign says "replacement bus"/"shuttle bus" become `bus` patterns
  (the route keeps its rail mode; the **pattern** mode is what vehicles use).
- **Patterns**: unique (route, direction, shape, stop sequence, headsign).
- **bbox clipping** (`geo.BBOX_LONLAT`): each pattern keeps its longest run of stops
  inside the bbox. Where it is cut, a *virtual* stop (flag 1) is added at the point
  where the shape crosses the bbox, timed by distance interpolation. Vehicles pass
  through virtual stops at constant speed without dwelling (VIA to Montréal/Windsor/Sarnia/NY).
- **Rail geometry** (`transit_rail.py`, HMM map matching): the GTFS shape is densified
  (10 m; 20 m for main-line rail) and matched with Viterbi onto **one continuous path
  through the OSM track graph**. Candidates per point: compatible track within 50 m (all
  parallel tracks within +15 m of the nearest compete; steep-angle tracks are candidates
  too). Emission = distance (relative + absolute) + angle + siding penalty + right-hand
  running (tracks left of the rightmost parallel track cost more; tram ways drawn against
  the travel direction cost more — Toronto's tram tracks are mapped one way per
  direction, drawn in the direction of travel). Transitions only along the track graph:
  no reversing and no turn sharper than ~78° at a node (no leg-to-leg at a switch), cost
  = |track length − shape length|. A parallel track is therefore only reachable through
  a real crossover — no sideways jumps. Where OSM topology is disconnected (duplicated
  nodes, zig-zag ways, e.g. a few spots at Union) the gap is bridged by a gentle
  Hermite S-curve over ±50 m; long gaps by a bounded shortest path, else GTFS points.
  OSM `tunnel`/`bridge`/`layer<0`/`location=underground` carry into `grade.profile`
  (cover: subway 14 m, LRT 10 m, streetcar 8 m; bridge clearance 6 m). Result
  simplified (3-D RDP, 0.3 m).
  Check with `uv run python -m tpipe.transit_validate [agency…] [-v] [--strict]`: samples
  every shape every 2 m against the OSM track and reports per route the off-track share,
  *jumps* (steep off-track runs = sideways hops), *blends* (S-curves over topology gaps)
  and, for streetcars, the share run against the tram way direction. Current data: all
  streetcar/LRT/subway lines 0 jumps and ≈0 % wrong-direction (before: 30–70 %), GO
  0–7 flagged runs per line (all at OSM topology gaps), VIA off-track only outside the
  OSM extract.
- **Bus geometry**: GTFS shape simplified (1.5 m), densified to 60 m and draped on
  terrain (3-D RDP, 1 m).
- **Stop distances**: monotone projection of stops onto the pattern shape (Viterbi
  over local minima of the stop-to-line distance, so loops and out-and-back routes work).
- **Times**: missing times are interpolated by distance. Runs of equal
  (rounded-minute) times are spread out by distance. Where arrival == departure at an
  intermediate stop, a synthetic dwell is taken from the preceding run time
  (subway 25 s, LRT 20, streetcar 12, GO 45, UP 40, VIA 60, bus 8), but never enough
  to make the segment faster than the mode's acceleration and top speed allow.
  frequencies.txt trips are expanded.

## Files (`app/public/data/transit/`)

### `index.json`

```jsonc
{
  "version": 1, "generated": "…",
  "modes": ["subway","lrt","streetcar","commuter_rail","airport_rail","intercity_rail","bus"],
  "profiles": ["weekday","saturday","sunday"],
  "agencies": [{ "id": "ttc", "name": "TTC", "profiles": {
      "weekday": { "date": "2026-09-30", "files": {
          "rail": { "file": "ttc_weekday_rail.bin.gz", "bytes": 149697, "trips": 5845,
                    "patterns": 174, "shapes": 104, "stops": 748, "vertices": 17051 },
          "bus":  { … } } }, … } }],
  "routes":   [{ "id": "ttc:1", "agency": "ttc", "short": "1", "long": "Line 1 (Yonge-University)",
                 "mode": "subway", "color": "#F8C300", "textColor": "#000000" }],
  "stations": [{ "id": "go:Union Station GO", "name": "…", "agency": "go", "pos": [E, N],
                 "modes": ["commuter_rail"], "routes": ["go:…"] }]   // non-streetcar rail only
}
```

Route ids are `{agency}:{gtfs route_id}`. Routes are sorted by mode, then agency.

### `{agency}_{profile}_{rail|bus}.bin.gz` (TBN1)

A file holds every trip of one agency and profile whose **pattern mode** is rail
(`rail`) or `bus` (`bus`). Index arrays (`idx`) are `u16` when the count fits and
`u32` otherwise; read them as generic typed arrays.

Header extras: `version, agency, profile, date, kind, modes` (the MODES list),
`routes` (route metadata as in index.json, **local** route order), `headsigns[]`,
`stopIds[]`, `stopNames[]`, `stopParents[]`, `maxDuration` (s, longest trip),
`tripNames[]` (rail only: trip_short_name, or the GO train number).

| array | type | length | meaning |
|---|---|---|---|
| `stop_xyz` | f32 | 3·nStops | world E, N, elevation (for rail, z is on the track, e.g. in the tunnel) |
| `shape_off` | u32 | nShapes+1 | shape s = vertices `[off[s], off[s+1])` |
| `shape_xyz` | f32 | 3·nV | absolute world E, N, z |
| `pat_route` | idx | nPat | local route index (header `routes`) |
| `pat_shape` | idx | nPat | shape index |
| `pat_mode` | u8 | nPat | index into MODES |
| `pat_dir` | u8 | nPat | GTFS direction_id |
| `pat_headsign` | idx | nPat | into header `headsigns` |
| `pat_stop_off` | u32 | nPat+1 | pattern p owns rows `[off[p], off[p+1])` of the next three arrays |
| `pat_stop` | idx | nPS | local stop index |
| `pat_stop_dist` | f32 | nPS | distance along the pattern's shape (m), non-decreasing |
| `pat_stop_flag` | u8 | nPS | bit 1 = virtual bbox-edge point |
| `tp_off` | u32 | nTP+1 | time profile q = rows `[off[q], off[q+1])` (count = its pattern's stops) |
| `tp_arr` | u16 | nTPS | arrival offset from trip start (s); first = 0 |
| `tp_dwell` | u16 | nTPS | departure − arrival (s) |
| `trip_start` | i32 | nTrips | s since service-day midnight (may be ≥ 86400); **sorted ascending** |
| `trip_pattern` | idx | nTrips | pattern |
| `trip_tp` | idx | nTrips | time profile |

Trip i at stop k: `arr = trip_start[i] + tp_arr[tp_off[q]+k]`, `dep = arr + tp_dwell[…]`,
with `q = trip_tp[i]`. A trip runs from `trip_start` (arrival at its first stop) to
the arrival at its last stop. Shape distances are not stored; the client computes
them from `shape_xyz` using horizontal length.

## Runtime (`app/src/transit/`)

```ts
import { TransitSystem, fetchLoader, MODES, MODE_ID, STATE_DWELL } from './transit/index.ts';

const ts = new TransitSystem(fetchLoader('/data/transit/'));   // or a custom TransitLoader
await ts.load('weekday', { modes?, agencies?, kinds?, onFeed? }); // rail files first, then bus
await ts.setProfileForDate(new Date());                         // weekday/saturday/sunday
const v = ts.evaluate(t);  // t = seconds since local midnight of the service day
for (let i = 0; i < v.count; i++) { v.x[i]; v.y[i]; v.z[i]; v.heading[i]; v.mode[i]; … }
```

- `evaluate(t)` fills `ts.vehicles` (reused object). Its arrays are replaced
  when capacity grows, so read them from `ts.vehicles` every frame. Fields: `x, y`
  (f64 world E/N), `z`, `heading` (rad, CCW from +E), `pitch` (rad), `speed` (m/s),
  `dist` (m along shape), `route` (global route index into `ts.routes`), `trip`,
  `pattern` (global indices), `mode` (MODE_ID), `state` (0 moving, 1 dwelling),
  `prevStop`, `nextStop` (global stop indices), `fraction` (0–1 between them).
- Previous-day trips running past midnight are included by also evaluating
  `t + 86400` against the **same** loaded profile (approximation: after midnight on
  Saturday the weekday file's late trips are shown).
- Motion: dwell between arrival and departure. Between stops, a trapezoidal velocity
  profile (per-mode acceleration, see `MODE_ACCEL`) exactly fills the scheduled
  time; if the schedule is too tight the acceleration is raised (≤ 2.5×) so vehicles
  still ease in and out of stops; beyond that, or if an end is a virtual point, the
  segment runs at constant speed. Heading and pitch come from points ±6 m along the shape.
- Shape sampling (public): `ts.patternShape(pattern)` → `PatternShape` (cached; `xyz`,
  `dist`, `length`, `point(s, out)` — extrapolates straight past the ends —,
  `direction(s)`, `pose(s, half)`, `toFloat64()`), plus `ts.patternMode(pattern)` and
  `ts.tripPattern(trip)`. `vehicles.dist` is the distance of the **consist centre**.
- Only in-service trips are vehicles. Layovers between trips at terminals are
  not shown yet (blocks are not modelled).

See `TransitSystem.ts` for the query API: `routes`, `routeIndex(id)`, `setModes()`,
`routeLines()`, `linesByMode()`, `stops()`, `stopPosition()`, `stopName()`,
`arrivalsAt()`, `tripInfo()`, `vehicleAt()`, `feedsInfo()`.

Test: `node app/src/transit/transit.test.ts` (needs the generated data).

## Rendering (`app/src/layers/TransitLayer.ts`, `app/src/layers/transit/`)

- Within 2.6 km of the camera every car / module is drawn individually
  (`transit/consist.ts`): consists come from `models/consists.ts` (`consistFor`), car i
  is placed by distance from the consist front, oriented by the chord between its two
  pivots (bogies, or the module ends for suspended / single-truck articulated modules),
  so trains snake through curves and streetcar / artic-bus sections bend at the joints.
  One `InstancedMesh` per car geometry and detail level (`transit/pools.ts`; hi < 450 m,
  low beyond). Farther away: one min-pixel-size marker per vehicle (`MarkerOverlay`).
- Heights: pivot points within 2.5 m of the rendered terrain (`engine.heightAt`) sit on
  it (blended out to 3.5 m); bridges / tunnels keep the shape z. Pitch from the pivots.
- Buses are offset 1.8 m right of the (centreline) GTFS shape (`LANE_OFFSET`).
- Hold (`transit/hold.ts`): surface vehicles (bus, streetcar, LRT) within 1.4 km of the
  focus look ahead (stopping distance + 25 m) for traffic-sim cars in their corridor
  (`TrafficLayer.queryAhead` if present, else its car snapshot), red signals
  (`signalAhead`, if present) and the transit vehicle ahead in the same lane. If blocked
  the rendered distance is capped behind the obstacle with IDM-like braking; the delay
  is recovered at ≤ +20 % of the scheduled speed; never ahead of the schedule, never a
  jump. Off at high clock rates (> ~0.75 sim-s per frame) and far from the focus.
- `transit.groundVehicles(out)` → surface transit vehicles near the focus
  `{ e, n, heading, length, width, speed, trip }` (front-centre, rad CCW from +E) for
  the traffic sim; `displayDist(trip, schedDist)` (held position), `vehicleLength(trip)`.
- Player trips: `overrides` entries with `pattern` + `dist` are drawn car by car too.
