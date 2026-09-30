# Network interactions

Status: spec (2026-09-30). Part of the engine layer (NETWORK.md).

Nothing at a meeting point is placed by hand or copied from data. An
**interaction resolver** finds every place where two network assets, or an
asset and the terrain, water or a building, meet or come close. It classifies
the meeting and generates the right structure from the assets involved.
Curated overrides can force a classification (e.g. "this crossing is grade
separated"), never draw geometry.

## Inputs to the resolver
For each pair: the two assets (category, class, profile), the plan-view
relation (crossing, touching end, merging, parallel within d), and the vertical
relation from the solved profiles (Δz at the meeting point versus the required
clearance). Grade separation is decided by the vertical solver using tags
(bridge, tunnel, layer), class priority (freeway > heavy rail > arterial >
LRT/tram > local > path), terrain, and curated corridors. The resolver never
guesses Δz.

## Asset × asset

| A \ B | same level (\|Δz\| < 0.5 m, shared node) | different level (Δz ≥ clearance) | parallel, close |
|---|---|---|---|
| **road × road** | junction node: T, X, multi-leg, roundabout. Or a merge/diverge node (gore, taper, added lane) when one-way links join at a shallow angle | overpass: a bridge variant of the upper asset with abutments, piers kept out of the lower lanes, and clearance ≥ 5.0 m | divided-road pair: shared median band; or a frontage road with a separator band. Never overlapping bands |
| **road × heavy rail** | **level crossing**: crossing panels across the full road width, stop bars, crossbucks, flashers, and gates by rail class and speed; road lanes continue flat across, with the rail at road z | rail over road: rail bridge (through-girder or deck, clearance ≥ 4.3–5 m), street dips; road over rail: road bridge, clearance ≥ 7 m | corridor fence or wall band between them |
| **road × tram/LRT** | embedded track through the junction: streetcar special work, flush grooved rails, shared box. Mid-block: the track crosses in its ROW, with a signalized crossing if it's a separate ROW | rare; bridge variant | the tram runs in a road band: mixed lane (King) or centre ROW (Spadina) per the road asset |
| **heavy rail × heavy rail** | **switch node**: turnout (points, closure, frog, guard rails, long ties, switch machine); crossover = two turnouts; **diamond** when crossing without joining | flyover / dive-under: bridge variant with clearance ≥ 7 m | **shared corridor**: one bed, one height profile, track centres at the standard spacing (≥ 4.0–4.5 m), one berm or cut |
| **tram × tram** | grooved switches and crossings (special work), radius ≥ 11 m | n/a | double track in one ROW or lane |
| **tram × heavy rail** | diamond with a protection signal (rare) | bridge | fence band |
| **path/sidewalk × road** | crosswalk: marked at junctions, PXO or mid-block where tagged, with ramps and tactile plates at both ends | footbridge or underpass: bridge variant of the path asset with stairs or ramps | sidewalk band of the road asset (never a separate overlapping path) |
| **path × heavy rail** | pedestrian level crossing with gates or maze barriers | footbridge (with stair towers) or tunnel | fence |
| **path × path** | **path junction node**: the legs are joined into one continuous walkable surface with filleted corners (radius about the path width), matching surface material (or a transition where materials differ), and no overlapping ribbons or slivers. A T, X or multi-leg junction is generated from the leg widths like a road node. A path end touching a sidewalk, plaza or platform joins that surface (curb ramp if levels differ) | footbridge or underpass | merged into one path of the combined width |
| **platform × track** | station edge: the platform band at 1.6–1.7 m from the track centre, with platform height by mode | n/a | n/a |
| **stop × road lane** | bus stop: a curbside stop in the lane, or a bay (lay-by) when the curb lane is parking | n/a | n/a |

### Pedestrian network
Footpaths, sidewalks, crosswalks, plazas, platforms and footbridges form one
connected **pedestrian mesh**. It's a network asset family with its own
segments and generated nodes, so every junction is a clean continuous surface.
The same mesh is the pedestrian sim's path graph. QA: `path_overlap` (two path
ribbons overlapping away from a node), `path_dangling` (a path end within 3 m
of another walkable surface but not joined) and `path_gap` (a walkable surface
break shorter than 1 m).

## Asset × terrain and water

| Situation (solved profile vs conformed ground) | Generated structure |
|---|---|
| profile ≈ ground | at-grade: ground conformed flat under the bands, side slopes blended |
| profile above ground by 0.3 m to about 8–10 m (urban about 6 m) | **embankment**: fill with 1:2 slopes (1:1.5 where tight); a retaining wall where a slope would hit another band, a building or the property line |
| profile above that height, or over water, a road or rail | **viaduct / bridge** variant: deck, piers, abutments where it returns to fill |
| profile below ground by 0.3 m to the cover depth (about 6–8 m) | **cut**: an open cut with slopes, or retaining walls in urban areas, with drainage ditches |
| profile deeper than cover | **tunnel**: box or bored by asset; the ground stays natural above |
| profile crosses from cut to tunnel | **portal**: headwall, wing walls and the tunnel mouth, generated where the profile passes the cover depth; the approach cut flares out |
| crosses a watercourse or waterbody | **bridge** (always), or a **culvert** for small streams when the fill is ≥ 1.5 m over the channel |
| runs along a shoreline or dock wall | revetment or dock wall band; never water under pavement |

## Asset × buildings and placed objects
- **Building over the network** (air rights: Union, Pearson T1, the Eaton
  Centre galleria): a covered way. The asset's clearance holds, the columns
  stand in non-lane bands, and the building's ground floor is cut out over it.
- **Building footprint conflicting with a band** at grade: flagged by QA.
  Resolve with a curated override: either the footprint is wrong (trim it), or
  the asset or alignment is wrong (fix the mapping). Never both drawn.
- **Props, trees and furniture**: placed only in the bands that allow them
  (furniture, boulevard, platform, open ground), with clearances from lanes,
  crosswalks and tracks.

## Resolver output and checks
The resolver emits typed nodes and structures (junction, merge, level_crossing,
switch, crossover, diamond, bridge, underpass, portal, cut, embankment, culvert,
covered_way, station_edge, stop). Generation (segments, nodes, structures,
terrain) consumes them. QA asserts completeness:
- every plan-view crossing of two assets is exactly one resolved interaction;
- no crossing is left unresolved (drawn overlapping);
- no resolved interaction lacks geometry;
- no level crossing has Δz > 0.5 m, and no bridge falls below its clearance.

## Tag modelling rules
OSM tags are trusted input. The work is in *modelling* them: a precise mapping
from tags to primitives, so every tag produces the right asset, variant or
generated interaction. Judgement goes into designing that mapping and into
filling genuine gaps (a tag that is missing), never into overriding tags that
are present. Examples of the mapping:
- `railway=level_crossing` / `railway=crossing` on a shared road/path–rail node
  becomes a level-crossing node generated from both assets (panels, stop bars,
  crossbucks, gates by `crossing:barrier`, lights by `crossing:light`).
- `railway=switch` / a shared rail node where tracks diverge becomes a switch
  node (turnout geometry from the diverging angle); `railway:switch=*` sets
  the type.
- `bridge=yes` (+ `bridge:structure`, `layer`) becomes the bridge variant of the
  asset, with that structure type and clearance to what is below.
- `tunnel=yes` / `covered=yes` (+ `layer`, `location`) becomes the tunnel or
  covered-way variant; the portal is generated where the profile passes cover
  depth.
- `lanes`, `lanes:forward/backward`, `turn:lanes`, `width`, `sidewalk:*`,
  `cycleway:*`, `parking:*` and `busway` become cross-section bands.
- `railway=tram` + `embedded=yes` / a separate ROW becomes a mixed-lane or
  transit_row band; `public_transport=platform` becomes a platform band.
- `highway=footway` + `footway=crossing` becomes a crosswalk event;
  `footway=sidewalk` becomes a sidewalk band of the parent road (not a separate
  path).

Gap filling (a tag is absent):
- **Impossible at grade → separated.** Only a few classes never cross or join at
  grade: motorways and expressways (highway=motorway and grade-separated
  trunk: 400-series, the Gardiner, the DVP, the Allen), and fenced third-rail
  rapid transit (TTC subway Lines 1/2/4 and their yards). If data shows one of
  those at grade, infer grade separation (the higher class goes over unless the
  terrain says otherwise). GO, VIA, UP and freight lines, the LRTs and
  streetcars DO have level crossings and at-grade junctions (e.g. the
  Stouffville line at Midland, Barrie, Kitchener, Milton and the outer Lakeshore
  sections). There, trust OSM's `railway=level_crossing` / `railway=crossing`
  nodes and the ORWN crossings layer.
- **Missing bridge tags.** Where two assets cross without a shared node and
  without bridge or tunnel tags, the vertical solver separates them with the
  class priority and terrain. Where they share a node but the classes forbid
  at-grade, treat the shared node as an error: split it and separate.
- **Paths vs fenced corridors.** A footpath crossing a main-line rail corridor
  with no crossing tag is not a pedestrian level crossing. It's a footbridge if
  a bridge is mapped nearby, otherwise the path is cut at the fence.
- **Don't over-generate.** Tiny overlaps from digitising noise (a service road
  kissing a sidewalk, a track end within 1 m of another track) are snapped or
  merged, not turned into junctions. Minimum sizes apply: a junction needs legs
  longer than the node radius, and a switch needs a real diverging track.
- **Context decides the variant.** Downtown, raised rail gets retaining walls,
  not 1:2 grass slopes, when slopes would hit buildings or streets; in open
  country, slopes. The Don Valley gets viaduct piers, not a 40 m fill.
- **Real references for signature cases.** Union, the Gardiner, the DVP,
  Bloor Viaduct, the Allen trench and the Spadina ROW are curated and checked
  against photos and imagery. The rules handle the long tail.
- **Every rule is testable.** Each judgement rule has a QA check that would
  catch its violation, e.g. `level_crossing_on_freeway`, `level_crossing_on_subway`, `junction_between_forbidden_classes`, `mapped_crossing_not_generated` (an OSM or ORWN level crossing with no generated crossing)
  and `path_crossing_fenced_rail_at_grade`.

## Auto-snap vs manual review
The resolver has three outcomes for every interaction: **generate** (the tags
and geometry are unambiguous), **snap** (small, safe corrections: digitising
noise under ~1 m, a track end next to another track, a path end next to a
sidewalk), and **review** (do not guess).

Never auto-snap. Mark for review instead:
- contradictions in the model (a shared node where one side is tagged or
  inferred as a bridge or tunnel; a level-crossing tag between classes that
  can never be at grade; `layer` disagreeing with the solved profile);
- corrections larger than the snap tolerance (moving geometry more than ~1–2 m,
  changing z by more than ~0.5 m, deleting a mapped feature);
- signature places and curated corridors (Union, the USRC, the Gardiner, the
  DVP, the viaducts, the Allen, the airports, the Niagara gorge): always
  curated, never auto-fixed;
- anything the QA gate flags that no rule explains.

Review items go to `review_queue.json`. Each has an id, location, category,
the conflicting evidence (tags, solved z, geometry), a thumbnail, and links to
the reference sources for that spot (orthophoto tile, LiDAR DTM/DSM,
street-level photo if available). Items are fixed by hand, by an agent or a
person, using the real-world data as the guide. The fix is written as a
curated override (`pipeline/curated/*.json`) that states the plausible
solution and cites its evidence ("rail bridge over the street: DSM shows deck
at 8.1 m, street at 2.4 m, ortho shows abutments"). The override is applied to
the model on every rebuild, and the review item closes when its QA check
passes.
