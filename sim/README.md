# gta-sim — local traffic + pedestrian simulation (Rust → WebAssembly)

Agent-based simulation of cars and pedestrians around the camera/player, plus
the time-of-day demand model used for the region-wide congestion overlay.
It runs inside a Web Worker (`app/src/sim/sim.worker.ts`) and publishes
snapshots to the renderer through a SharedArrayBuffer
(`app/src/sim/protocol.ts` documents the layout).

## Build

Requirements: Rust (stable), the `wasm32-unknown-unknown` target and
[wasm-pack](https://rustwasm.github.io/wasm-pack/).

```sh
rustup target add wasm32-unknown-unknown
cd app && pnpm build:sim     # → app/src/sim/pkg/{sim.js, sim_bg.wasm, *.d.ts}
```

The generated package in `app/src/sim/pkg/` is committed (≈130 kB wasm) so
`pnpm dev` / `pnpm build` work without a Rust toolchain. Re-run
`pnpm build:sim` after changing anything under `sim/`.

## Test

```sh
cd sim && cargo test --release
```

Unit tests cover IDM, signal phases, lane-graph building/eviction, turn
classification, red-light stopping, queues without overlap, spawning,
pedestrian walk-signal crossing and the player car. `tests/real_tiles.rs`
streams the real graph tiles (`app/public/data/graph`) along a moving focus
(downtown → DVP → 401) as a stress test.

## Modules

| file | contents |
|---|---|
| `graph.rs` | streaming road graph: tiles in/out, nodes unified by OSM id, directed links per edge direction with lanes, turn classes, junction control (signal / stop / priority / free), signal clusters, spatial grid |
| `world.rs` | cars (s = front bumper): smooth arc-length junction paths, per-zone junction reservations (conflicting paths never occupied twice, left turns / minor roads yield, don't-block-the-box, pedestrians on crossings), animated lane changes that occupy both lanes, zipper merges, surface-transit obstacles mapped onto lanes (doors-open streetcar rule), IDM car-following, MOBIL-style lane changes (passing + turn lanes), junction logic (fixed-time signals with amber, stop signs, minor-yields-to-major with junction reservation, merges), routing (weighted random with destination bias), demand-driven spawn/despawn, render output; the player car (kinematic bicycle model, road snapping) |
| `peds.rs` | pedestrians on sidewalks (offset lines of class 2–6 roads), corner turning, crossing on the walk phase, crowds at transit stops |
| `collide.rs` | player collisions: oriented boxes (cars, transit) and building footprints streamed from level-0 render tiles |
| `demand.rs` | hourly weekday/weekend profiles, class densities, bottleneck factors, BPR speed ratio for the congestion tier |
| `idm.rs`, `signal.rs`, `rng.rs` | model primitives |
| `lib.rs` | wasm-bindgen facade `Sim` |
