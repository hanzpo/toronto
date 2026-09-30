# Network architecture

Status: architecture (2026-09-30). This supersedes the ribbon-per-OSM-way
approach. Detailed specs: CROSS_SECTION.md (profiles), INTERSECTIONS.md
(nodes), SURFACE.md (terrain conformance), STRUCTURES.md (bridges/tunnels).

## Principle
We are building a Cities: Skylines-style engine and then mapping reality onto
its primitives. We are not rendering OSM. OSM, authoritative sources and curated
overrides are *inputs to a mapping step* that chooses assets, fits curves and
sets elevations. Everything the player sees, and everything the sims use, comes
from the primitives.

## Layer 1: engine primitives

**NetAsset**: a network type (e.g. `toronto_arterial_4l_streetcar_row`,
`dvp_6l_divided`, `go_double_track_berm`, `ttc_subway_box`). It defines:
- the cross-section profile: ordered bands (CROSS_SECTION.md) with widths,
  heights, materials and curb faces;
- lanes: for every band that carries agents, the lane lines with direction,
  vehicle types, speed and turn permissions;
- prop slots: lamps, trees, poles, bollards, catenary masts, fence posts, with
  spacing rules;
- variants: at-grade, bridge (deck + structure type), tunnel/cut, embankment,
  with transitions between them;
- the node rules this asset contributes (curb radius by design vehicle,
  crosswalk style, ROW nose, stop-line setback).

**Segment**: a NetAsset swept along a smooth curve (tangent arcs, clothoids)
with a vertical profile. Width changes are explicit transitions (tapers).
Geometry, markings, props and lanes are generated from the asset, so a segment
is always coherent with itself.

**Node**: generated from the profiles of the segments that meet there, never
drawn from data directly. It produces the box, curb returns, noses,
crosswalks, stop bars, turning paths per allowed movement, special trackwork,
and signal placement. End nodes, merge/diverge nodes (gores) and rail switch
nodes are node types too.

**Lanes / paths**: the traffic, transit and pedestrian graphs are the lane
lines of segments plus the turning paths of nodes. What is drawn is what the
agents drive on.

**Terrain snapping invariant** (as in Cities: Skylines): inside the footprint
of any at-grade asset, terrain_z ≤ pavement_z − 0.02 m everywhere. The terrain
is modified by the network, never the reverse. Under bridge variants the ground
stays natural (DTM); in tunnel variants the ground stays above the cover depth.
QA gate `terrain_above_paving` must be exactly 0 before any merge.

**Lanes come only from assets**: agents can only use lanes their asset
defines. Taxiways and runways carry aircraft paths only; airside service roads
carry airside-vehicle lanes only (GSE), which the public traffic sim cannot
enter. Public road traffic on an airfield is therefore impossible by
construction.

**Terrain modification**: the ground surface is conformed to the network (cut
and fill with a distance-field smooth union, retaining walls when a slope
doesn't fit; SURFACE.md). The network is never draped on the terrain.

**Placed assets**: buildings, landmarks, props and trees are placed objects
with footprints that respect the network's bands (a shelter only on a platform
or sidewalk, a tree only in a furniture or boulevard band or open ground).

## Layer 2: mapping reality onto primitives
The pipeline (tpipe) produces, for the whole region:
1. **Graph cleanup**: OSM ways become a clean topological network (merge split
   ways, carriageway pairing, node clustering into junctions).
2. **Asset selection**: every edge gets a NetAsset. The order of precedence is
   curated (`curated/cross_sections.json`, `corridors.json`), then authoritative
   sources (municipal curb and pavement layers, ORN lanes and widths), then OSM
   tags, then standards-based defaults by class and context.
3. **Curve fitting**: centrelines are fitted to smooth curves that respect the
   real alignment (source geometry, then imagery validation).
4. **Vertical profile**: solved jointly per corridor (shared profiles for
   parallel tracks and carriageways), with clearances at crossings, curated
   levels (the Union corridor, the Gardiner, the viaducts) and LiDAR
   bare-earth where available.
5. **Output**: the primitive network (edges with asset, curve and profile;
   nodes with legs). Everything else is generated from it, client-side or in
   the tile builder.

Manual fixes edit only layer-2 inputs (curated files) or the asset library.
Never a renderer.

## Acceptance: the vertical slice
About 1 km² around King & Spadina, built entirely on these primitives:
- the Spadina streetcar ROW with platforms;
- the King & Spadina node with special trackwork;
- curbs, sidewalks and props in their bands;
- terrain conformed;
- streetcars, cars and pedestrians on the generated lanes and paths;
- no seams, gaps, flicker, floating geometry or disagreement between what is
  drawn and what agents follow.
It is judged in the app from street level, oblique, top-down and a moving
streetcar cab. Region-wide rollout only after it passes.

## Asset families beyond streets and rail
The same primitives cover every network in the region. Each family gets its
assets, tag mapping and interaction rules in INTERACTIONS.md:
- **Airfield** (user example: Billy Bishop taxiway tapering into grass, with
  centrelines on the grass). Taxiway assets have cross-sections by ICAO code
  (width, shoulders, centreline and edge markings); runway assets carry
  designators, thresholds, touchdown zones and lights; the apron is an area
  asset with stands; airside service roads are painted on pavement (no curbs,
  no public traffic). Interactions: taxiway × taxiway gives a filleted junction
  (wheel-track fillets); taxiway × runway gives a runway entrance with
  holding-position markings; service road × taxiway gives zipper edges and a
  stop line; a taxiway end connects to an apron, runway or hangar, or gets an
  end cap. Markings are generated from the asset and exist only on pavement.
  Tags: `aeroway=taxiway|runway|apron|holding_position`, `width`, `ref`;
  `service=*` inside the airside boundary becomes an airside road.
  **Terrain:** the airfield is one graded platform. A single grading surface
  is fitted to all runways, taxiways and aprons within airfield slope limits
  (runway longitudinal ≤ ~1%, crossfall 1–1.5%; taxiways and aprons similar),
  and every paved surface takes its z from it, so there are no steps between
  pavements. Runway assets carry a graded-strip band (e.g. about 75 m each side
  for code 3; runway end safety areas beyond the ends), and taxiways carry a
  smaller graded band. The terrain is cut and filled to these bands with the
  same smooth-union rule as rail berms, so the strips merge into one graded
  field. Ground cover follows the bands (mown grass in strips, rough beyond,
  shoulders at pavement edges), not hard-edged land-cover polygons. Beyond the
  graded bands the ground blends to the LiDAR DTM. Where a platform meets water
  (Billy Bishop is landfill), the resolver generates a shoreline structure
  (armour-stone revetment or seawall) down to lake level; never grass sloping
  into water, never water under a graded area.
- **Waterfront**: dock walls, piers, ferry slips (interacting with ferry
  routes), marina pontoons.
- **Pedestrian**: see INTERACTIONS.md "Pedestrian network".
