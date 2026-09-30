# Engine primitives

The complete primitive set for the network engine (NETWORK.md). Everything
the player sees and every agent path is built from these. Reality is mapped
onto them (tags → primitives, INTERACTIONS.md "Tag modelling rules").

## 0. Shared properties

**Every linear network asset** has:
- `id`, `family`, `class`, `name`;
- `profile`: ordered bands (CROSS_SECTION.md), each with kind, width(s),
  height, surface material and curb faces;
- `lanes`: per agent-carrying band, the direction, vehicle classes (public
  car, bus, streetcar, LRT, heavy rail, subway, aircraft, GSE, bicycle,
  pedestrian), speed, turn permissions and signal group;
- `markings`: centre, edge and lane lines, arrows, symbols (asset-driven);
- `prop_slots`: kind, band, spacing and offset rules (lamps, trees, catenary
  masts, fence posts…);
- `variants`: at-grade, embankment, cut, bridge (with structure type), tunnel
  (box or bored), covered way, plus transition rules between them;
- `node_rules`: design vehicle, curb radius, crosswalk style, nose type,
  stop-line setback, and which node types it may form;
- `clearances`: vertical clearance above and below, lateral clearance;
- `lod`: near, mid and far representations.

**Every segment** (an asset instance) has: the asset, a smooth plan curve
(tangent arcs or clothoids), a vertical profile z(s), width transitions,
variant ranges along s, events (crosswalks, stops, driveways, poles),
`corridor_id` (shared-profile cluster), `source` (OSM ids, curated id) and
`review` flags.

**Every node** has: its type, the legs (segment ids with the leg's
cross-section at the node), a generated footprint, turning paths, markings,
props, and `source` and `review` flags.

## 1. Terrain and water

| Primitive | Properties |
|---|---|
| **Terrain** | bare-earth heightfield (LiDAR DTM 0.5–2 m where available, else Copernicus 30 m), modified by the network (the snapping invariant), land-cover classes painted from bands and areas with soft edges |
| **Water body** | kind (lake, river, pond, canal), surface level or level profile along the river (flat across the channel, stepping only at curated weirs, dams and falls), bed depth, flow direction and speed (for rapids and foam) |
| **Shoreline** | linear: kind (dock wall, revetment, beach, natural bank, seawall), top z, toe z at the water level, material |
| **Land cover area** | kind (grass mown or rough, woods, meadow, sand, rock/scree, garden, farmland), soft-edged polygon |

## 2. Linear network assets

| Family | Assets | Key properties |
|---|---|---|
| **Road** | local, collector, arterial (plain, streetcar in mixed traffic, centre streetcar/LRT ROW), expressway/freeway (divided), ramp, alley/laneway, service road, driveway, parking aisle | bands: frontage, sidewalk, furniture, boulevard, bike lane, parking, lanes, median, transit_row, curb; lane count and widths, turn lanes, bus lanes, speed, one-way |
| **Heavy rail** | main line, siding, yard track, industrial spur | gauge, track-centre spacing, ballast bed width, tie type, speed, signal blocks, electrification (UP: none; future GO: OCS) |
| **Subway** | bored tube, cut-and-cover box, open cut, surface (fenced) | tunnel section by type, third rail side, walkway, tunnel furniture slots |
| **LRT / streetcar** | LRT on ROW, streetcar embedded in lane, streetcar on centre ROW | grooved or tee rail, embedded or ballasted, ROW surface (concrete/grass), OCS pole slots, min radius 11 m |
| **Pedestrian** | sidewalk (band), footway/path, trail, stairs, ramp | surface, width, lighting slots |
| **Cycle** | protected cycle track, painted lane (band), multi-use trail | buffer type, surface colour |
| **Airfield** | runway, taxiway, taxilane, airside service road | ICAO code (width, shoulders, strip), markings, edge lights, graded strip band |
| **Barrier** | fence, noise wall, crash barrier, guardrail, retaining wall | height, material, post spacing; placed along segment bands |

## 3. Area assets

| Primitive | Properties |
|---|---|
| **Plaza** | paving pattern, edge curbs, furniture slots |
| **Parking lot** | stall layout (angle, width), aisles, islands, lighting, occupancy profile by lot type |
| **Apron** | stands (position, heading, aircraft code), lead-in lines, GSE boxes, jet bridge slots |
| **Airfield platform** | a graded surface fitted to runways, taxiways and aprons within slope limits |
| **Platform** (area form) | height by mode, edge offset from track (1.6–1.7 m), tactile strip, canopy and shelter slots, ramps |
| **Yard** | track fan, shared bed level, buildings, lighting masts |
| **Park / green space** | land-cover mix, path network inside, tree density |

## 4. Nodes (always generated)

| Node | From | Generates |
|---|---|---|
| **Road junction** (T, X, multi-leg) | legs' cross-sections | box, curb returns, noses, perpendicular crosswalks, stop bars, turning paths, signals, streetcar special work |
| **Roundabout** | legs + a radius rule | central island, splitter islands, yield lines, circulating lane paths |
| **Merge / diverge** | one-way links at a shallow angle | gore, taper or added lane, continuity lines |
| **End** | a dead-end leg | cul-de-sac bulb, turnaround or end cap (taxiway) |
| **Level crossing** | road or path × rail at grade | crossing panels, stop bars, crossbucks, flashers, gates by class, road flat across |
| **Switch / turnout** | a rail diverge | points, closure rails, frog, guard rails, long ties, switch machine |
| **Crossover / diamond** | parallel tracks, or tracks crossing | two turnouts / a diamond with protection signal |
| **Tram special work** | tram × tram or tram × road junction | grooved switches, crossings and curves (radius ≥ 11 m), flush with the box |
| **Path junction** | path legs | a continuous surface with fillets |
| **Crosswalk / PXO** | path × road (event or node) | ladder or zebra, ramps, tactile plates, signals or PXO beacons |
| **Station edge** | platform × track | platform edge at the right offset, stop marker, door zones |
| **Stop** | stop × lane | curbside stop or bay, pole, shelter slot, waiting area |
| **Runway entrance / taxiway junction** | airfield legs | hold-short markings, wheel-track fillets |

## 5. Structures (variants, always generated)

| Structure | Properties |
|---|---|
| **Bridge / overpass** | deck type (slab, girder, box, truss, arch, through-girder for rail), span layout, depth, parapets/railings, piers (kept out of lanes and channels), abutments with wing walls |
| **Viaduct** | long bridge on bents or piers (Gardiner, Bloor Viaduct, the Don) |
| **Underpass** | the lower asset's side of a bridge: dip profile, walls, lighting |
| **Tunnel** | box or bored section, lining, walkway, lighting, furniture |
| **Portal** | headwall, wing walls, mouth; where the profile passes cover depth |
| **Cut** | slopes or retaining walls, ditch |
| **Embankment** | fill with 1:2 (1:1.5) slopes, a smooth union across a corridor |
| **Retaining wall** | height along s, coping, material |
| **Culvert** | pipe or box under fill over small streams |
| **Covered way** | a building over the network: clearance, columns in non-lane bands |
| **Footbridge** | deck, railings, stair or ramp towers |

## 6. Placed assets

| Primitive | Properties |
|---|---|
| **Building** | footprint (multipolygon), height/massing parts, roof type, facade style, use class (occupancy schedule), entrances, frontage band link |
| **Landmark** | handcrafted model, suppressed footprints, anchor frame, lighting |
| **Prop** | kind (lamp, signal, pole, bench, bin, shelter, bike share, hydrant, sign, catenary mast), allowed bands, clearances, orientation rule |
| **Tree** | species, size, allowed bands or areas, seasonal state |

## 7. Agent paths and control

| Primitive | Properties |
|---|---|
| **Lane** | from segment bands: vehicle classes, direction, speed, linked lanes |
| **Turning path** | from node rules: entry and exit lanes, curve, conflict set, signal group |
| **Pedestrian mesh** | sidewalks, paths, crosswalks, platforms, plazas as one graph |
| **Rail route and blocks** | track graph from segments and switches, blocks, safe stopping points, interlocking (RAIL.md) |
| **Signal controller** | per junction: phases, timings; per rail block: aspects |

## 8. Meta

| Primitive | Properties |
|---|---|
| **Curated override** | target (source id or extent), what it sets (asset, band, z, variant, classification), evidence and citations |
| **Review item** | location, category, conflicting evidence, thumbnail, reference links, status |

## 9. Interaction table

Rows are what meets what. Columns are how they meet. "—" means not
applicable. Everything in a cell is generated by the resolver
(INTERACTIONS.md), subject to the review rules.

| Pair | Same level, shared node | Crossing at different levels | Parallel / adjacent | Never allowed / review |
|---|---|---|---|---|
| road × road | junction, roundabout, or merge/diverge | overpass: upper asset's bridge variant; clearance ≥ 5.0 m | divided pair with a shared median, or frontage road + separator | a freeway at grade with any road → separate; shared node contradicting layers → review |
| road × heavy rail | level crossing (trust the mapped tags) | rail bridge over the road (≥ 4.3–5 m), or road bridge over rail (≥ 7 m) | corridor fence or wall band | freeway × rail at grade → separate |
| road × subway | — (never at grade) | tunnel/box under, or a bridge over an open cut | — | any at-grade → review |
| road × LRT/streetcar | tram special work in the junction box; mid-block signalized crossing | bridge (rare) | mixed lane or centre transit_row band | — |
| road × path | crosswalk / PXO | footbridge or underpass (path variant) | sidewalk band (never a separate overlapping path) | — |
| road × airfield | airside service road × taxiway: zipper + stop line | tunnel/bridge (e.g. roads under taxiways) | airport fence | public road × runway at grade → never; review |
| heavy rail × heavy rail | switch/turnout, crossover, diamond | flyover / dive-under (≥ 7 m) | shared corridor: one bed, one profile, standard spacing | tracks at different z within 8 m without a structure → review |
| heavy rail × subway | — | tunnel/bridge | fence | — |
| heavy rail × LRT/streetcar | diamond with protection | bridge | fence | — |
| heavy rail × path | pedestrian crossing with gates or mazes (only if mapped) | footbridge (stairs) or tunnel | fence | a path crossing a fenced main line untagged → cut at the fence, or footbridge if one is mapped |
| subway × subway | switch/crossover (in tunnel or yard) | stacked tunnels | twin tubes or a shared box | — |
| LRT/streetcar × LRT/streetcar | grooved switches and crossings (r ≥ 11 m) | — | double track in one ROW | — |
| path × path | path junction (continuous surface, fillets) | footbridge | merged path | — |
| platform × track | station edge (1.6–1.7 m offset, height by mode) | — | — | platform straddling a track → review |
| stop × lane | curbside stop or bay | — | — | stop with no platform on a transit_row → review |
| taxiway × taxiway | taxiway junction (wheel-track fillets) | — | parallel taxiways, shared strip | — |
| taxiway × runway | runway entrance with hold-short | — | — | — |
| any asset × terrain | at grade: terrain snapped below pavement (−0.02 m) | above: embankment (≤ ~8–10 m, urban ~6 m, retaining wall where tight) → viaduct/bridge above that; below: cut (≤ cover) → portal → tunnel | berm/cut shared across a corridor (smooth union) | terrain above paving → must be 0 |
| any asset × water | — | bridge (always) or culvert (small stream, fill ≥ 1.5 m) | shoreline structure (dock wall, revetment) | water under pavement → never |
| airfield platform × water | — | — | shoreline revetment or seawall | grass sloping into water → never |
| asset × building | covered way (Union, T1, galleria) | building over a tunnel (no interaction) | frontage band meets the facade | footprint in a band at grade → review (trim footprint or fix mapping) |
| prop/tree × asset | only in allowed bands with clearances | — | — | prop in lane, crosswalk or track bed → QA must be 0 |
| building × building | shared party wall | — | — | overlapping footprints → review (hidden-duplicate rule, curated) |
