# Playtest log

Findings from playing as a user: walking, driving, riding and operating. The
bar is a high-quality sandbox, like driving around in GTA. Each finding has an
owner; fixed items move to the bottom with the commit that fixed them.

## Session 1 (2026-09-30, live site)

### Walking (King & Spadina)
- [ ] The player walks through cars. There's no collision with vehicles,
  props or buildings, and cars don't react to a pedestrian in the road.
  → player-experience
- [ ] The player avatar is a crude static block figure, worse than the NPC
  pedestrians. Use the jointed pedestrian model with walk and run
  animation. → player-experience
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
- [ ] "Take over nearest car" near the DVP picked a car on Broadview. Prefer
  the highest-class road near the camera focus, and let the player pick by
  clicking. → player-experience
- [ ] Driving on the sidewalk at ~110 km/h through pedestrians: no curb
  impact, pedestrians don't dodge or react, no collision response.
  → player-experience
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
- [ ] Lit windows are huge flat quads (~3 m), break across building corners
  and don't follow floor/window grids; at street level they read as stickers.
  Needs the facade shader: real window grid, varied warm/cool interiors,
  some rooms lit, blinds, lobby glow, ground-floor storefront light spill.
  → buildings/props
- [ ] From 2–3 km every building sparkles uniformly (noise). Lit-window
  density and brightness should vary by building type and time (offices dark
  after 22:00, residential warmer), with a smooth far-LOD emissive average.
  → buildings/props
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
- [ ] Spadina drawn at grade across the rail yard; parapets float as slabs. → roads (sent)
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
- [ ] Lake: huge featureless grey-blue plane with moiré banding; islands flat;
  no shoreline treatment. → ground/water
- [ ] Large blank beige areas (land class 0 = untextured) in rail lands,
  Markham fields and yards; grass patches pixelated. → ground/water (vector
  ground + textures)
- [ ] Parking lots: aisles drawn as dark ribbons over blank ground, no
  stalls/cars. → buildings/props (parking lots)
- [ ] Brick facade texture scale far too large (bricks ~1 m) on Scarborough
  plaza. → buildings/props
- [ ] Queen W: no storefront band; strip between sidewalk and building face
  unpaved/white. → buildings/props + ground
- [ ] Street level at Kipling on High: 54 fps, 10.6 ms CPU, 4.8 M tris. → perf
  budget check after merges

### User screenshot 12 (Q400 at Billy Bishop)
- [x] Q400 nose, windscreen, twin nose wheels, Porter tail: rebuilt from
  references (7599942). Still missing: fuselage titles ("porter" wordmark),
  A350/Air Canada cockpit masks, door handles. → aircraft (later)

### Requested: railway level crossings (user)
- [ ] Full crossings (panels, stop bars, crossbucks, flashers, gate arms,
  pedestrian gates, cantilevers) → roads; gates and lights driven by real
  train positions, cars and pedestrians stop, keep-clear → transit/sim.

### Station/clipping hunt (user: "make sure things don't clip into other things")
- [ ] Union: track deck shows grass with a floating roof slab, trees and a
  building wall clip into the complex; pulling in must be clean → stations
- [ ] Clearance checks at all stations: platform edge 1.6–1.7 m from track,
  columns ≥ 2.2 m, no buildings/trees over tracks → stations (+ script)
- [x] Traffic doesn't drop at night: surplus cars and pedestrians now retire
  out of view (downtown cars 7036 at 17:30 → ~380 at 03:00). 04d38ac
- [ ] Camera collision leaves the camera hugging building walls at stations
  (Bloor-Yonge) → stations/UX
- [ ] Gardiner at Exhibition now elevated on piers (roads WIP): good

### Vegetation follow-ups (after 643b630)
- [ ] Near bare winter trees show 4 straight limbs (reads like a broom). → vegetation
- [ ] A tree right at the camera fills the view; camera clearance should
  include crowns, or near crowns should fade. → vegetation / camera
- [ ] Large black spike polygon near the camera at King W (?cam=-1180,-620,60,40,12,
  13:00), probably a shadow caster or rooftop artifact. → investigate

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
