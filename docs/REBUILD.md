# Rebuild

The core is rebuilt on network primitives (NETWORK.md, PRIMITIVES.md,
INTERACTIONS.md). The old stack rendered each layer straight from OSM and
kept them in agreement by fixes; the new one generates every layer from one
model.

## Layout
- `app/src/net/core`: the engine. Pure TypeScript, no three.js. Asset
  library, network description, segments, generated nodes, lanes, structures,
  terrain modification, props. Runs in workers, in Node for tests and baking.
- `app/src/net/view`: three.js rendering of the engine output.
- `app/bench.html`, `app/src/bench`: synthetic layouts, one per interaction.
- `sim/`: Rust sim, rewritten on the engine's lanes, turning paths, signal
  groups and track graph.
- `pipeline/tpipe/mapping`: OSM and authoritative sources mapped into the
  network description (tag table, graph cleanup, curves, vertical solve).

## Order
1. Engine core and asset library.
2. Nodes: road junction, merge/diverge, end, level crossing, tram crossing,
   tram special work, switch, diamond, path junction, crosswalk, stops,
   platforms.
3. Structures and terrain modification.
4. Bench page and renderer; judged from street, oblique, top-down.
5. Sim on the bench: cars, pedestrians, streetcars, trains with interlocking.
6. Mapping the real region; then the app runs on it and the old stack is
   deleted.

## Status
- Engine, bench, sim and mapping are done; the whole region (14,472 tiles) is
  mapped and the app draws and simulates it near the camera.
- Scheduled transit is handed from the timetable layer to the sim near the
  camera (routes matched onto lanes, stops and dwell from GTFS).
- Player driving and walking run in the new sim.
- Deleted: the old street, props, crossings and traffic layers, the old sim
  crate, the net2 slice, the unified-surface prototype and the old tunnel
  builder; the old road and rail model (roadnet, rail_geom, rail_graph,
  rail_routes, transit_rail), the bus road router, the sim graph, the old roads
  worker and the QA checks of those layers.
- Derived from the network model by `app/scripts/net-bake.mjs`, which runs the
  engine on the net tiles:
  - far road and rail ribbons for every pyramid level (`net/far/{L}`); the tile
    worker draws them beyond the network layer's range and hands their road and
    rail arrays to the level-0 consumers (buildings, urban, ground, canopy);
  - the vehicle lanes per 4x4 block (`work/net/lanes`), onto which the transit
    pipeline matches bus, streetcar and rail shapes, so timetable vehicles
    follow the drawn lanes and tracks with their solved z;
  - the drawn tracks (`rail/network.bin.gz`: stations, open cuts, the Union
    deck) and the major roads of the congestion overlay
    (`congestion/majors.bin.gz`).
- Trees: placed in the network worker from the tile's network build (the
  engine's tree slots become street trees) and drawn by the vegetation layer.

## Commands
- Map the region: `cd pipeline && uv run python -m tpipe.net --region`
- One area: `uv run python -m tpipe.net --bbox=W,S,E,N --name NAME`
- Bake from the network model: `cd app && node scripts/net-bake.mjs
  --net=public/data/net --far=public/data/net/far --lanes=../pipeline/work/net/lanes
  --rail=public/data/rail/network.bin.gz --majors=public/data/congestion/majors.bin.gz
  [--bbox=W,S,E,N]`
- Transit on the lanes: `cd pipeline && uv run python -m tpipe.transit [agency ...]`
- Engine tests: `cd app && npx vitest run src/net/test`
- Sim tests: `cd netsim && cargo test --release`
- Bench: `/bench.html?l=<layout>` or `?map=tx,ty` for a mapped tile
