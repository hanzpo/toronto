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
See git log.
