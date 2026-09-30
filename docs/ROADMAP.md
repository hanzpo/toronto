# Roadmap

Derived from playtests (docs/PLAYTEST.md), QA (docs/QA.md), the ground-level
audit and user feedback. The bar is a sandbox that feels like driving around
a GTA game, hand-fixed and low-poly.

## Now (agents running)
- Roads: continuous chains with width tapers, junction clustering, ramp gores,
  grade separations, bridge corridors (Gardiner, DVP, 401…), footway cleanup.
- Transit agents: buses on the road graph (lane-correct, never wrong-way),
  bus garages, waiting crowds, no spawns in view.
- Stations: Union front facade, curated station table, entrances.
- Ground & water: vector ground, lake and shores, embankments, tunnel portals.
- Landmarks pass 2: Eaton Centre, Yonge-Dundas Sq, UofT, Queen's Park,
  St Lawrence Market, Distillery, AGO, Roy Thomson Hall.
- Aircraft: reference-based models, retracting gear, lights.

## Next
### World fidelity
- **Terrain-conforming everything**: sidewalks, lots and yards follow slopes;
  retaining walls where grade changes sharply (ravine edges, Bluffs).
- **Rooftops**: HVAC units, parapets, water towers, rooftop patios, green
  roofs; they dominate the view from condos and the CN Tower.
- **Alleys and laneways** (Toronto has ~2,400): garages, fences, utility
  poles, graffiti textures.
- **Construction sites** (Toronto is famous for cranes): tower cranes on
  OSM `landuse=construction` and `building=construction`, hoarding, lights.
- **Waterfront**: ferries (Jack Layton terminal ↔ Islands, animated on the real
  schedule), sailboats in the harbour, the Billy Bishop ferry and pedestrian
  tunnel, lake freighters in Hamilton Harbour.
- **Weather and seasons**: snow cover and plows in winter, rain wetness and
  puddle reflections, fog on the lake, sunset haze. The sim date already
  drives fall colours.
- **Interiors where you enter**: Union concourse, PATH network segments,
  subway mezzanines (walk mode goes underground).
- **More regions' transit**: Waterloo ION LRT (not in the GRT feed, so build
  it from OSM track and the published timetable), the Hamilton B-Line, Barrie,
  Guelph, the Niagara WEGO visitor buses, plus a GO bus network overlay.

### Simulation depth
- **Traffic realism**: time-of-day origin–destination demand (TTS data),
  real signal timings, rush-hour DVP and Gardiner jams that match the
  congestion model, collisions and incidents that close lanes, emergency
  vehicles with sirens.
- **Pedestrians**: trips between real destinations (stations, offices,
  schools), crowds at events (Rogers Centre, Scotiabank Arena, BMO Field
  schedules), jaywalking, cyclists on bike lanes, Bike Share usage.
- **Transit operations**: real-time delay propagation, short turns,
  diversions, crowding and passenger counts per car, TTC and GO service
  alerts.
- **Parking**: cars park and unpark in lots and on-street, rather than
  appearing on roads.

### Sandbox gameplay
- **Player vehicles**: pick any car type, bus driver mode (drive a TTC route,
  stop at stops, doors, fares), taxi mode, GO engineer mode with the real
  timetable and scoring (on-time performance, smooth stops).
- **Physics**: proper car handling (weight, grip, handbrake turns), damage
  and crash response, pedestrians dodging, horn reactions.
- **Missions and scenarios**: make the 8:15 at Union, rush-hour DVP
  challenge, drive the 504 end to end, deliver a GO train on time in snow.
- **Photo mode**: free camera, time of day and weather sliders, depth of
  field, hide UI, share a link (the debug-report URL already restores view
  and time).
- **Audio**: engine, rail and wheel squeal, station announcements (TTC chimes,
  "Please stand clear of the doors"), city ambience, weather.

### Analytics and tools
- **Analytics modes**: ridership heatmaps, headway and bunching charts per
  route, travel-time isochrones from any point, "what if" service changes
  (add a line, change frequency, see crowding).
- **Scenario editor**: add a subway line or station and let the sim run it.
- **Street View–style comparison**: split screen of sim vs reference photo
  for QA.

### Engineering
- **Continuous QA**: nightly pipeline build, QA run, viewpoint sweep, contact
  sheet diff vs the previous build, and counts tracked in docs/qa-results.md.
- **Performance**: GPU-driven culling and indirect draws, occlusion culling,
  KTX2 textures, worker-side transit evaluation, a mobile quality tier.
- **Data freshness**: weekly GTFS refresh through a Cloudflare Cron Trigger,
  and monthly OSM updates with QA gating.
- **Multiplayer (Durable Objects)**: shared city, see other players'
  trains, dispatch roles.
