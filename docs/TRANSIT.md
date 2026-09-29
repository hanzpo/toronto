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
- **Rail geometry**: the GTFS shape is densified to 10 m and snapped to compatible
  OSM track within 40 m, staying on the current way unless another way is more than 8 m closer
  (this stops it zig-zagging between parallel tracks). The line is then rebuilt along the
  OSM geometry. Gaps are bridged by a shortest path on the track graph, capped at
  1.6 × the GTFS length + 150 m; where no path fits, the GTFS points are kept. OSM
  `tunnel`/`bridge`/`layer<0`/`location=underground` carry into
  `grade.profile` (cover: subway 14 m, LRT 10 m, streetcar 8 m; bridge clearance 6 m).
  Result simplified (3-D RDP, 0.3 m). 96–100 % of rail shape length lies on OSM track.
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
  time; if the schedule is too tight, or an end is a virtual point, the segment runs
  at constant speed. Heading and pitch come from points ±6 m along the shape.
- Only in-service trips are vehicles. Layovers between trips at terminals are
  not shown yet (blocks are not modelled).

See `TransitSystem.ts` for the query API: `routes`, `routeIndex(id)`, `setModes()`,
`routeLines()`, `linesByMode()`, `stops()`, `stopPosition()`, `stopName()`,
`arrivalsAt()`, `tripInfo()`, `vehicleAt()`, `feedsInfo()`.

Test: `node app/src/transit/transit.test.ts` (needs the generated data).
