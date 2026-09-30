# Intersection model

Status: spec (2026-09-30). Owner: the network model (docs/ROADS.md "Source of
truth"); pairs with docs/CROSS_SECTION.md.

## Why
Junctions were built bottom-up as clustered nodes with a pavement blob, then
each layer added its own pieces. The results: crosswalk ladders running
diagonally into the box, a streetcar right-of-way that ends as a wall, streetcar
track through the box as raised rods with sharp corners that kink articulated
cars, signal poles and riders in slivers of median, cars stopping diagonally in
the box. An intersection is a designed object and must be modelled as one.

## Model
Each junction is one object built from its approach cross-sections
(CROSS_SECTION.md bands at the stop line of every leg):

- **Legs**: per approach, the cross-section at the stop line, heading, and the
  lanes with their movements (from turn:lanes, else defaults), bus/streetcar
  lanes, and bike lanes.
- **Box**: the paved polygon bounded by the corner curb returns; corner radius
  by the design vehicle (a bus or streetcar turning uses 12–15 m, local 5–9 m).
- **Medians and ROW ends**: each median or transit_row band terminates at the
  stop line with a nose (mountable or raised with a taper), never a wall.
- **Crosswalks**: one per leg, perpendicular to the leg (not to the box
  diagonal), across the full road width behind the stop bar; ladder or zebra
  per the City standard. Refuge islands where a median is at least 1.8 m.
- **Stop bars** 1.5–3 m behind the crosswalk, per lane.
- **Turning paths**: each allowed movement is a smooth path from an entry lane
  to an exit lane (tangent arcs / clothoids fitted to the geometry). The traffic
  sim follows these; cars never stop diagonally in the box except in a
  protected left-turn waiting position.
- **Streetcar special work**: embedded grooved-rail curves through the box, with
  minimum radius ~11 m (TTC), switches and crossings as trackwork objects
  (turnouts), rails flush with the pavement at the box height. Articulated cars
  follow these curves, so no kinks.
- **Signals**: poles at far-right, near-right and median positions on the
  corners and noses (never in a travel lane), mast arms over the lanes, and
  pedestrian heads at each crosswalk end.
- **Transit stops at the junction**: near-side or far-side platforms from the
  cross-section's transit_row band, ending before the crosswalk.

## Consumers
The surface (box, curb returns, noses, embedded track), markings, trackwork,
props (signals), the traffic sim (turning paths, stop lines, box blocking),
the transit sim (streetcar curves), pedestrians (crosswalks, refuges) and QA
(crosswalk not perpendicular, ROW end without nose, track corner radius
< 11 m, pole in lane, car stopped in box off a turning path).

## First deliverable
King & Spadina, Queen & Spadina, Spadina & College and King & Bathurst (all
with streetcar special work), plus two suburban arterial junctions. Verified
in-app from street level, oblique and top-down, with a streetcar turning
through at least one.
