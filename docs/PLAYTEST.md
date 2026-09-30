# Playtest log

Findings from playing as a user: walking, driving, riding and operating. The
bar is a high-quality sandbox, like driving around in GTA. Each finding has an
owner; fixed items move to the bottom with the commit that fixed them.

## Session 1 (2026-09-30, live site)

### Walking (King & Spadina)
- [x] Walker collisions with buildings, props, parked and moving cars; cars
  brake, honk or change lanes for a pedestrian in the lane (25/25 in the
  real-street test).
- [x] Jointed, animated avatar (idle, walk, run, lean); taking over a
  pedestrian keeps their look.
- [ ] A turning minivan stopped diagonally across the crosswalk; queued cars
  overlap crosswalks. Partly fixed in 04d38ac (divided junctions act as one
  box); ~80 spillback cars still stop in boxes downtown at 08:15
  (`__qa.carsStoppedInBox`). Needs corridor-aware entry. → transit/sim
- [ ] 935 bus pattern stretches have no legal road path
  (pipeline/work/bus_road_gaps.json). → roads
- [ ] A red bar floats in the street in the distance (a vehicle
  representation drawn twice). → transit-agents (single representation)
- [ ] Street-level walls are blank (no storefronts or windows at grade).
  → buildings/props

### Driving
- [ ] Turning left off Spadina ends up in a plaza of scribbled service paths
  between blank walls. → roads (footway and service cleanup)
- [ ] The chase camera presses against buildings. → stations/UX (camera
  collision)
- [x] Drive button prefers the highest-class road near the view; click any
  car or pedestrian to take it over.
- [x] Arcade handling (grip, weight transfer, handbrake, reverse), curb
  impacts, building/car collisions with damage smoke, pedestrians dodge.
  Cars don't yet collide with poles and trees.
- [x] At 1024 px width the time bar was mid-screen and the Layers panel
  covered the view. Fixed in b96cfba.

### Operating a subway (Line 1 from Union)
- [x] The driving desk covered the track ahead. Fixed in 76a0a2d.
- [ ] The tunnel and station box are oversized (a ~15 m hall). Real TTC
  twin-track box is ~8.5 m wide and 4.5–5 m high; single-track tubes are
  ~5.2 m in diameter. → stations + transit (tunnel.ts)
- [ ] Tunnels are bare: no cable trays, signals, tunnel lighting rhythm,
  lining segments, or emergency exits. → stations + transit
- [x] ATP applied penalty braking immediately at P4 from standstill. It now
  warns for 3 s first. Fixed in 7839885.
- [ ] Far station labels still stack at street level. → stations/UX

### Night (21:30)
- [x] Facade window shader: per-style grid restarting per wall, blank party
  walls, occupancy schedules by use, rooms with depth, blinds, lobby glow,
  storefront spill.
- [x] Far windows average into light patches (no sparkle); density varies by
  use and hour. Costs ~10–15% fps at the 2.8 km night view → perf.
- [ ] Route overlay lines and oversized red far-vehicle markers show in
  normal (non-analytics) mode at city zoom. → transit-agents (already told)
- [ ] Street lights: pools OK, but no light on facades or road reflection;
  car headlights don't light the road. (nice-to-have) → later lighting pass

### Carried over from user screenshots (see docs/GROUND_LEVEL_AUDIT.md and the QA categories)
Width tapers, ramp gores, bridge width anomalies, median-ROW intersection
clustering, flat grade separations, footpaths and footbridges, bus loops,
sidewalk-to-bridge joins, dash phase, tram tracks classed as siding
→ roads. Trees on roads and rails → vegetation. Buses off-road and going
the wrong way, trains colliding → transit-agents. Pearson apron → airports.
CIBC Square flicker → fixed in 3eda5f1.

### User screenshot 10 (Spadina over the rail corridor, ?cam=-842,-1248,124.6,343,10&t=2026-09-30T08:15:26)
- [x] Spadina drawn at grade across the rail yard: now a bridge with walls (network model, consolidated merge)
- [ ] Far station labels (Ossington … College, kms away) stack on the horizon
  at street level: limit by distance/altitude/occlusion. → stations/UX
- [ ] Waiting pedestrians clump into one blob on the sidewalk: spread crowds
  along the stop/shelter with spacing. → transit-agents / traffic sim

### Bug hunt 2 (local dev, 13:00, High quality): 10 street-level spots
- [ ] Jumping the camera to a spot at low pitch leaves it at ~2 m inside
  plazas/courtyards and against walls. Camera must keep clearance from
  buildings and ground on jumps and orbits. → stations/UX (camera collision)
- [ ] Yonge-Dundas (E 60, N 200) is an anonymous brick courtyard: no
  Yonge-Dundas Square, screens/billboards or Eaton Centre. Signature places
  need landmarks: Y-D Square + screens, Eaton Centre, Nathan Phillips Sq
  (done), Distillery District, St Lawrence Market, Kensington, Honest Ed's
  site, the Ex/BMO Field, Ontario Place pods, Scotiabank Arena plaza (done).
  → landmarks (new pass)
- [ ] Station labels float across street views and show through buildings
  (Union visible from the Harbourfront/Queen W). → stations/UX
- [x] Lake: vector water with ripples (no moiré), typed shores (dockwall,
  revetment, beach), real water levels (consolidated merge)
- [x] Blank beige land and pixelated grass: vector ground with textured
  classes within ~1.5 km (consolidated merge)
- [x] Parking lots: stalls on vector lot polygons, parked cars by lot type
  and hour, islands and light poles.
- [x] Brick scale checked: already 67 mm courses; the shot was ~1 m from the
  wall. No change.
- [x] Queen W: paved strip between curb and street walls; shop glass no
  longer reads as white panels.
- [ ] Street level at Kipling on High: 54 fps, 10.6 ms CPU, 4.8 M tris. → perf
  budget check after merges

### User screenshot 12 (Q400 at Billy Bishop)
- [x] Q400 nose, windscreen, twin nose wheels, Porter tail: rebuilt from
  references (7599942). Still missing: fuselage titles ("porter" wordmark),
  A350/Air Canada cockpit masks, door handles. → aircraft (later)

### Requested: railway level crossings (user)
- [x] Level crossings: 3,469 crossings drawn (2,439 gated) with crossbucks,
  flashers, bells, cantilevers and gate arms; 2,111 driven by the rail sim
  (warning 32 s, gates down 21 s before a train); cars stop at the stop bars
  (consolidated merge)

### Station/clipping hunt (user: "make sure things don't clip into other things")
- [x] Union: deck at rail height, no grass, 326 clipping buildings suppressed,
  platforms 1.65 m from track, shed columns cleared (consolidated merge).
  Platforms still plain (chunky black columns) → later polish
- [x] Station clearances: platform_track_clearance 386 → 55 (minor gaps),
  columns 0, building_over_track near stations 70 → 3, trains through
  buildings 13 → 0, trees on platforms 15 → 0 (consolidated merge)
- [x] Traffic doesn't drop at night: surplus cars and pedestrians now retire
  out of view (downtown cars 7036 at 17:30 → ~380 at 03:00). 04d38ac
- [ ] Camera collision leaves the camera hugging building walls at stations
  (Bloor-Yonge) → stations/UX
- [ ] Gardiner at Exhibition now elevated on piers (roads WIP): good

### Vegetation follow-ups (after 643b630)
- [ ] Near bare winter trees show 4 straight limbs (reads like a broom). → vegetation
- [ ] A tree right at the camera fills the view; camera clearance should
  include crowns, or near crowns should fade. → vegetation / camera
- [ ] Large black spike at King W (?cam=-1180,-620,60,40,12, 13:00): not a
  shadow and not a building. A long, narrow house footprint gets a huge
  near-black gable roof that pokes through its 5-storey neighbour. → rooftops
  agent (cap ridge height, long footprints get flat roofs, QA count)

### Ground/water agent (done, waiting for the consolidated merge)
- Vector ground, typed shores, water levels, 41 curated portals and open
  cuts, bridge embankments. Its code shares tileWorker/TileManager with the
  rooftops and stations work, so it lands with the roads merge and the tile
  rebuild (osm_tiles → rail graph → ground osmium filter → tpipe.ground).
- [x] L0 tiles were stored uncompressed (tile level passed as the gzip level):
  7× bigger than needed. fe53fda, takes effect with the rebuild.
- [ ] Street view at King & Spadina is 4.9–5.2 M tris and 350–400 draws
  (budget ~3.5 M). Not the ground (+0.10 M); profile per layer after the merge.
  → perf
- [ ] Road tunnel portals (Gardiner/Lakeshore underpasses, Bay St tunnel …);
  crisp edges between natural ground classes; roads not cut into hillsides.
  → ground (later)

### QA clipping run (04cd1eb, 196k findings across 38 categories)
Queued until an agent slot frees up (overnight cap is 5):
- [ ] Landmarks: Pearson T1 model over 670 m² of carriageway (-18388, 2591),
  Old City Hall over 107 m² of road (113, -50), ROM Crystal overlapping the ROM
  historic wings (-946, 1645), Skylon overlapping an unsuppressed building
  (24714, -63067). → landmarks
- [ ] Vegetation: tree_in_building 1,186 (22 m tree in building 662538570 at
  3033, 13833). → vegetation
- [ ] Buildings: floating_object 56 (buried buildings 8.9 m under ground at
  -2772, -2753); lot_over_building 65; prop_in_building 201 (signal pole in
  building at -5412, 4709). → buildings/props
- [ ] Transit: a TTC bus path runs through Yorkdale mall (-1239, 5722).
  → transit
Sent to stations: platform_track_clearance 386, building_over_track (Allen Rd
stations, Union shed), trains through Allen Rd station buildings, trees on
platforms.

### Consolidated merge follow-ups (tonight)
- [ ] Bus pattern stretches with no road path: 935 (old graph) → 2,327 →
  1,368 after the one-way, first-segment and loop fixes. The rest are stops
  matching the wrong edge on smoothed curves. → roads
- [ ] Red far-vehicle dots still show across the city in normal mode. → UI
- [ ] Floating black boxes above Spadina near the corridor (crane parts?).
- [x] Building multipolygons: one footprint per outer ring (35 relations,
  67 rings recovered, incl. Pearson T3).
- [ ] Allen stations: Lawrence West buried (rail data 8 m below terrain),
  Wilson has no platform, Yorkdale ballast off the train path.
- [ ] landmark_road_overlap 11 left (Union, CIBC Square, AGO, Legislature …).
- [ ] tpipe.roadnet --workers 2 hung on macOS (forked workers died); now
  ProcessPoolExecutor fails loudly. Serial is 10–14 min.
- [ ] Pipeline outputs could be written into app/public/data through a stray
  symlink (736 tiles overwritten once). Agents now use TPIPE_OUT.

## Session 2 (2026-09-30 08:00, live site 1efc201, playtest agent, 38 findings)
Shots in the session scratchpad play/. Sent to owners: transit/sim (GO train
vanishes before Union [P1], LW crawl, reversed rush direction, Gardiner
pile-up, 504 overlaps, low volumes and empty platforms, route 94 headways),
player-experience (Drive spawns off-road [P1], camera ignores URL pitch,
camera in embankments and awnings, NPCs through the avatar, body roll, Layers
panel re-opening), buildings (03:00 towers lit like 21:30, plain Distillery
facades, Agincourt lots without stalls, pilaster seams), roads (grass bands
across the DVP [P1], phantom curb, Bloor viaduct edge, Kennedy rail
overpass, Gardiner hump at Park Lawn, grass verges on King & Bay, white
centre lines on residential streets).
Queued (no agent yet):
- [ ] P1 Niagara Falls: flat bands with a ~15 m sine pattern instead of a
  50 m white cascade with mist. `?cam=25000,-63000,900,200,30&t=2026-10-03T13:00:00`
  → landmarks / ground-water
- [ ] Aircraft: following a landing 737 loses it; "Taxi to gate" starts at
  108–148 km/h and rolls down the runway instead of exiting; Q400 rollout
  near the YTZ runway edge → aircraft/airports
- [ ] UI: speed readouts disagree (top bar vs panel); passed stops stay
  "Due"; St Andrew pill cut off at the screen edge; ~12 pills stack at 3 km
- [ ] Museum station: no signature columns or name sign from the cab → stations
- [ ] Rogers Centre reads as a tall white ball from 3 km → landmarks
- [ ] Zoom hitches: 129 ms frame on the jump to 3 km, 83 ms at 1 km → perf
- [ ] Downtown at 08:15 on production: 4.57 M tris / 383 draws (check the
  perf pass reached production caches)

## Resolved
- [x] Tree LOD popping and stippled crowns: matched high/mid/far models,
  per-tree CPU LOD with hysteresis and 0.4 s alpha-to-coverage cross-fade,
  conifer top-down shards fixed. 643b630 (deploy pending the tile rebuild).
- [x] Trains colliding and wrong-track running (the user's Kitchener GO
  report): signalled rail agents with interlocking. Verified with ~220
  trains, 0 overlaps and 0 overruns at 1× and 10×, KI GO operated through
  the system. 7839885, deployed.
- [x] Trees in roads, rails and water: the vegetation pass brings the QA
  counts to 0 (pending the consolidated merge and tile regeneration).
