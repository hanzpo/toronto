# Cross-section model

Status: spec (2026-09-30). Owner: the network model (docs/ROADS.md "Source of truth").

## Why
Everything used to grow bottom-up from OSM primitives: a way became a ribbon,
a stop node became a pole + shelter, a landuse polygon became grass. OSM has no
concept of "Spadina has a centre streetcar right-of-way with boarding islands at
every stop", so every layer guessed its own piece: the surface drew grass,
platforms came out as shards, shelters landed between the rails. The fix is a
domain model of what lies across every street and corridor, derived once and
read by every consumer.

## Model
Every road **segment** (a stretch of the network model between changes) carries
an ordered **cross-section**: a list of **bands** from the left building line to
the right building line, each with a kind and a width that may vary along the
segment (tapers).

Band kinds (at least):
- `frontage` (building face to sidewalk; paved in dense areas, lawn where mapped)
- `sidewalk`
- `furniture` (trees in pits, lamps, poles, bins, bike share, benches)
- `boulevard` (grass strip)
- `bike_lane` (painted / protected with a buffer)
- `parking` (lay-by or curb lane, with time rules)
- `lane` (travel lane: direction, turn use, bus/HOV)
- `shoulder`
- `median` (painted / raised curb / planted / barrier)
- `transit_row` (a streetcar/LRT right-of-way: surface = concrete slab | grass |
  embedded-in-lane; curbs; track pair offsets inside the band)
- `platform` (boarding island or side platform: only at stops, a longitudinal
  extent [s0, s1], height, ramps at the crosswalk end, shelter/railing slots)
- `curb` (explicit, with height; a vertical face in the surface)

**Events** along a segment place discrete features by (s, band): crosswalks,
stop bars, stops (which open a `platform` band in a `transit_row` or a bus bay
in `parking`), driveways, signal poles, hydrants, lamps.

Rail **corridors** get the same treatment: bands for each track (with its
centreline offset), a shared `bed` (ballast, one polygon for all tracks in the
corridor), `platform`s at stations, `fence`, `retaining_wall`, and `berm_slope`.
Tracks within one corridor share one height profile (docs/ROADS.md).

## Derivation (priority order)
1. Curated overrides: `pipeline/curated/cross_sections.json` keyed by street and
   extent (e.g. Spadina, King–College: sidewalk 4.0 | lanes 2×3.3 | curb |
   transit_row concrete 7.2 with platforms 3.0 at each stop | ...).
2. Authoritative sources where they exist (docs/SOURCES.md: municipal
   curb/sidewalk/pavement-marking layers, ORN lanes and widths).
3. OSM tags: lanes, lanes:forward/backward, turn:lanes, width, sidewalk:*,
   cycleway:*, parking:*, railway=tram with embedded/segregated tags,
   public_transport=platform, highway=bus_stop with side.
4. Standards-based defaults by road class and context (Toronto Complete Streets
   Guidelines, TAC). For example, a dense downtown arterial has a paved frontage
   to the building line; a residential local street has a boulevard with trees.

## Consumers (all read the cross-section; none guess)
- the surface builder (docs/SURFACE.md): classes and z per band;
- road markings: lane lines, edge lines, stop bars, crosswalks;
- props: every furniture item is placed in its band (a shelter only ever on a
  platform or sidewalk; never on a track bed or travel lane);
- the traffic sim graph: lanes, turn lanes, bus lanes, parking;
- the transit sim: stop positions at platforms, doors on the platform side;
- pedestrians: walkable bands (sidewalk, platform, crosswalk);
- QA: band overlaps, props outside their band, platforms without a stop, stops
  without a platform on a transit_row.

## First deliverable
Spadina Ave (Queens Quay to Bloor), St Clair W (Yonge to Gunns Loop) and Queens
Quay W as curated segments with platforms at every 510/512/509 stop; everything
else from the derivation above. Verified in-app from street level, oblique and
top-down at three stops and two intersections per street.
