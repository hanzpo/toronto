# Ground-level audit (2026-09-30)

The bar: at street level it should feel like a GTA game. The region is bounded
to the GTA and GO area precisely so every visible thing can be hand-fixed. OSM
is used for what things mean, not for their final geometry. Use judgement, fix
implausible data, and cite references (photos, standards, diagrams).

Tour screenshots: Gardiner at Spadina and Jarvis, DVP at Bloor, 401 at 404,
427 at 401, Allen Road, Yonge & Eglinton, Markham.

## Findings (roughly by severity)

1. **Elevated expressways are broken.** The Gardiner runs mostly at grade,
   and its ramp segments float and end in mid-air. The cause is per-way
   `bridge=yes` elevation with no corridor model. Fix with curated corridor
   profiles (continuous deck elevation, piers, parapets and median barrier,
   ramps interpolated to meet the streets below): the Gardiner (Humber to
   DVP), the DVP, the 401 collectors and express lanes with their flyovers,
   the 427, 404, 400, 409, QEW (including the Burlington Skyway), 403, 410,
   407, and the Allen.
2. **Tangled dark scribbles.** Footways, parking aisles, driveways and
   service roads render as thick black road ribbons, which is the main
   "tangly mess".
   - Classify properly: footways and cycleways become thin concrete or red
     paths, or are hidden where they duplicate sidewalks; parking aisles and
     driveways are dropped from the road mesh (they belong to parking-lot
     generation); service roads become narrow, unmarked lanes.
   - Smooth alignments.
   - Build real junction surfaces (unions), not overlapping ribbons.
   - Lane counts and widths should match reality: check tags against photos.
3. **Empty land.** Commercial, industrial, retail and parking land is flat
   grey or beige, and residential yards aren't grass.
   - Generate parking lots (asphalt, stall markings, light standards, parked
     cars, landscaped islands), lawns in residential yards, grass boulevards
     and verges, highway embankments and medians, and loading areas at
     industrial buildings.
4. **Blocky ground.** The land-cover raster (4 m/px) gives stair-stepped
   shorelines, park edges and pond outlines up close, and water shows moiré
   stripes.
   - Use vector ground at level 0: triangulated water, park and land-use
     polygons with smooth edges and proper shore treatment (beaches, rock
     revetments, seawalls on the downtown waterfront).
   - Keep the raster for levels 1 and 2 only.
   - Stable water shading, with no moiré at any distance.
5. **Labels clutter street level**: station labels kilometres away stack
   across the screen. Limit by distance and occlusion and declutter overlaps.
6. **The camera clips into buildings** at low altitude. Add camera collision
   with building footprints and heights.
7. **Buildings are uniform.** One striped facade everywhere.
   - Add storefront bands on commercial streets (King, Queen, Yonge,
     Spadina, Danforth, ...), entrances and awnings.
   - Vary materials: brick, glass curtain wall, concrete.
   - Give Toronto house types (bay-and-gable, semi, suburban split) proper
     porches, driveways and garages.
8. **Rail and stations** (see the transit-agents work): clean track (ties,
   ballast, rails), switches, streetcar overhead wire, catenary for UP and
   future GO electrification, curated stations (platform type, length, depth,
   canopies, entrances) and tunnel portals cut into the terrain.
9. **Street life**: bus and streetcar shelters, trash bins, newspaper boxes,
   bike lanes (painted and separated), bike-share docks, fire hydrants,
   hydro poles and wires in older neighbourhoods, TTC stop poles, signage
   (street name blades at junctions, highway guide signs), and planters.

## Order of work
1. Transit as agents (in progress).
2. Roads and corridors: items 1 and 2, including the Gardiner.
3. Ground and water vector pass: items 3 and 4.
4. Rail infrastructure, stations and portals: item 8.
5. Buildings and street life: items 7 and 9.
6. UX fixes: items 5 and 6, which are small and can go in any time.
