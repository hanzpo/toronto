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
  overlap crosswalks. → traffic sim (transit-agents owns sim now)
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

## Resolved
- [x] Trains colliding and wrong-track running (the user's Kitchener GO
  report): signalled rail agents with interlocking. Verified with ~220
  trains, 0 overlaps and 0 overruns at 1× and 10×, KI GO operated through
  the system. 7839885, deployed.
- [x] Trees in roads, rails and water: the vegetation pass brings the QA
  counts to 0 (pending the consolidated merge and tile regeneration).
