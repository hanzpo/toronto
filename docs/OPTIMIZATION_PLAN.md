# Optimization pass (queued)

Starts after the current wave of ground-level agents lands: transit motion,
traffic and pedestrians, vehicle models, street scene, air traffic. Tunnels
and portals follow, built on this framework.

## Budgets (enforced by benchmark scripts)
- Street level: ≤ 3M triangles, ≤ 400 draw calls, ≤ 8 ms GPU, ≤ 4 ms main-thread CPU
- Any view: no frame > 50 ms while zooming or panning (zoom and pan benchmarks)
- Deployed site: first meaningful frame ≤ 2.5 s on a warm CDN, ≤ 4 s cold;
  revisit ≤ 1 s (Cache Storage)

## Rendering
1. **Detail rings around the camera** (on top of the tile pyramid):
   - Ring 0 (< 300 m): full street detail, full vehicle, person and tree models, articulated consists, tunnels
   - Ring 1 (300 m – 1.5 km): low-LOD vehicles and trees, simple people
   - Ring 2 (1.5 – 4 km): simplified buildings (flat roofs, decimated footprints), vehicles as markers, no furniture
   - Beyond: level-1 and level-2 tiles
   The tile worker emits detailed and simplified building meshes per level-0 tile.
2. **Occlusion culling**: first CPU tile-level occlusion from building heights in
   the tile height data, then GPU occlusion culling against a depth pyramid
   (WebGPU compute).
3. **GPU-driven instancing**: compute-shader frustum, distance and LOD selection
   writing indirect draw arguments for cars, people, trees, lamps, train cars and
   houses. The traffic simulation's SharedArrayBuffer feeds the GPU directly, with
   no per-instance JavaScript loops.
4. **Cascaded shadows**: the near cascade updates every frame, far cascades every
   N frames; only rings 0–1 cast shadows.
5. **Adaptive quality governor**: measured frame time drives dynamic resolution,
   LOD distances and ring radii to hold 60 fps.
6. **Material consolidation**: one uber-material per category, texture arrays,
   KTX2 compressed textures, procedural markings in shaders.

## Deployed site
- **Code splitting**: the main bundle is over 500 kB. Lazy-load interact, air,
  sim, the landmark builders and the galleries; add modulepreload hints.
- **Startup**: stream-compile the wasm, show a first frame from level-2 tiles
  only, then refine; defer loading the bus schedule files; avoid long tasks
  during the first 3 s.
- **Data transfer**:
  - Brotli for JSON (the manifest is over 150 kB; trim it or send it binary).
  - Precompressed transit and landmarks files.
  - Measure the latency of R2 ranged reads per tile. Consider serving an L2
    pack in one request, or coalescing neighbouring tiles into one ranged read.
  - Edge Cache API hit-rate check; Tiered Cache or Cache Reserve if it's low.
- **Service Worker**: precache the app shell and level-2 tiles for instant
  repeat visits and offline use of visited areas.
- **Headers**: immutable caching for hashed assets; COOP/COEP retained.
- **Real User Monitoring**: record frame time, tile latency and cache hit rates
  to Workers Analytics Engine to find slow paths on real devices.

## Measurement
- Extend the playwright benchmarks (zoom, pan, street walk, ride a streetcar,
  drive the DVP) to record long frames, GPU time (timestamp queries), draw calls
  and triangles, and to run against both dev and the deployed URL.
- Keep results in `docs/perf-results.md` so regressions are visible.

## Next: tunnels and portals
Terrain cuts and retaining-wall trenches at tunnel portals; tunnel tubes and
station boxes for every underground segment near the camera (not only the
player's train); road tunnels and underpasses; subway entrance kiosks at street
level.
