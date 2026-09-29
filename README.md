# GTA Twin

A browser-based, to-scale 3D simulation of everywhere GO trains run, from
Niagara Falls and Kitchener to Barrie and Oshawa. It's built from OpenStreetMap,
the Copernicus elevation model, the City of Toronto 3D Massing data and the
schedule (GTFS) feeds of 16 transit agencies. Every scheduled bus, streetcar,
subway, GO, UP Express and VIA train moves on its real timetable.

Live: https://toronto.hanznathanpo.workers.dev

## Layout

| Path | What |
|---|---|
| `pipeline/` | Offline Python data build (`run.sh`): region, terrain, OSM tiles, road graph, transit, landmarks |
| `app/` | Vite + React + three.js (WebGPU) client |
| `sim/` | Rust → WebAssembly traffic and pedestrian simulation |
| `worker/` | Cloudflare Worker serving the app and the R2-hosted dataset |
| `docs/SPEC.md` | Coordinate system and binary data contract |
| `docs/TRANSIT.md` | Transit data format and runtime |

## Develop

```sh
cd pipeline && ./run.sh          # ~10 min; downloads ~2 GB and writes app/public/data
cd app && pnpm install && pnpm dev
```

Useful URL parameters: `?cam=E,N,dist,headingDeg,pitchDeg` (metres from
Toronto City Hall), `?webgl=1` (force WebGL2), `?debug=1`.

## Deploy

```sh
./deploy.sh --data   # upload dataset to R2, build, deploy the Worker
./deploy.sh          # app only
```
