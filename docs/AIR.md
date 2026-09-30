# Air traffic (`data/air/`)

Aircraft at **CYYZ Toronto Pearson, CYTZ Billy Bishop, CYHM Hamilton and CYKF
Waterloo**, driven analytically from the sim clock like transit (scrubbing needs
no state). Built by `pipeline/tpipe/air.py`, rendered by `app/src/layers/AirLayer.ts`
(+ `app/src/air/*`, models in `app/src/models/aircraft.ts`).

## Data sources: what's real, what's modelled

| part | source | status |
|---|---|---|
| runways, taxiways/taxilanes, stands, terminals | OSM `aeroway=*` from `raw/bbox.osm.pbf` | real |
| elevations | pipeline terrain grid (`work/terrain.npz`) | real |
| flight numbers + city pairs | vradarserver *standing-data* route DB (callsign → airports, CC0; `raw/air/sd`, sparse git clone of github.com/vradarserver/standing-data) | real routes (the DB is historical, so some pairings may be discontinued) |
| airlines operating at each airport, daily volumes, fleet (type) mix | curated table `CARRIERS` in `air.py` | modelled from public 2024–26 service patterns |
| departure / arrival **times**, turnarounds, stand allocation | generated (`build_schedule`) | **synthetic** |

The OpenSky Network API was tried first: anonymous access no longer serves
historical flights (only the last few hours, incomplete) and the credit limit was
hit within minutes; the Pearson website's flight API is captcha-protected. So the
times are **synthetic** but shaped per market from the airports' published
patterns (hour-of-day weights `H` in `air.py`): domestic banks 06–09 / 12–14 /
16–20, transatlantic departures 17–23 and arrivals 11–17, west-coast red-eyes
05–07, sun destinations out in the morning, Asia around midday / midnight,
Cargojet's Hamilton night hub (arrivals 22–02, departures 02–05). Billy Bishop's
curfew (no movements 23:00–06:45) is enforced.

Counts (movements = arrivals + departures):

| airport | weekday | saturday | sunday |
|---|---|---|---|
| CYYZ | 1124 | 938 | 1024 |
| CYTZ | 166 | 134 | 150 |
| CYHM | 44 | 18 | 30 |
| CYKF | 10 | 10 | 10 |

(Pearson real-world ≈ 1,150–1,250/day; Billy Bishop ≈ 150–200.)

## Files

- `airports.json` — `{version, airports: [...], airlines: {ICAO: {name, iata}}, places: {ICAO: {iata, city, name, lat, lon}}}`.
  Per airport: `icao, iata, name, pos [E,N,elev]`, `configs` (runway configurations,
  see below), `curfew`, `nodes [[E,N,elev]]`, `edges [[a,b,kind]]`
  (`0 taxiway · 1 taxilane · 2 runway · 3 stand lead-in`), `runways`
  (`des, thr [E,N,elev], end, hdg` true °, `len`, `entry` node for line-up,
  `exits [[node, metres from threshold, exit angle°]]`), `stands`
  (`ref, pos` nose stop point, `hdg` unit nose-in vector, `node` lead-in start,
  `span` approx. stand width, `zone` T1/T3/T/remote).
- `schedule_{weekday,saturday,sunday}.json` — per airport `types[]`,
  `airlines[]` and parallel arrays of **rotations** (one aircraft: an arrival and
  the departure it operates next): `al, ty, st` (stand), `acs, afrom, ta, sa`
  (arrival callsign / origin ICAO / touchdown time / runway stream), `dcs, dto, td, sd`
  (departure … / start-of-takeoff-roll time / stream). Times are seconds from local
  midnight of the **air day**, which runs 03:00 → 27:00; `td < ta` means the aircraft
  night-stops and departs next morning.

## Runway configuration (assumptions)

Movements carry a *stream*; the client maps streams to runways per day
(deterministic pseudo-wind from the date: 68 % westerly, 32 % easterly, same for
all airports):

| airport | streams | west flow | east flow |
|---|---|---|---|
| CYYZ | A1/A2 arrivals (split by origin bearing), D1 departures, N night (00:30–06:30 single runway) | arr 24R + 23, dep 24L, night 23 | arr 06L + 05, dep 06R, night 05 |
| CYTZ | M mixed | 26 | 08 |
| CYHM | M mixed | 30 | 12 |
| CYKF | M mixed | 26 | 08 |

Per-stream runway separation is enforced in the pipeline (arrivals ≥ 95 s,
departures ≥ 70 s, mixed arr/dep ≥ 110 s) by delaying later movements.

## Motion model (`app/src/air/track.ts`)

- Arrival: appears 180 km out on the great-circle bearing of its origin, routes via
  a corner-post fix 65 km out (Pearson: NE/SE/SW/NW), turns (R ≈ 3.3 km, coordinated
  bank) onto a 16–23 km straight final, 3° glideslope aimed 330 m past the
  threshold, flare, touchdown, decelerates (1.7–2.2 m/s²) to a high-speed/right-angle
  exit, then taxis the OSM graph (Dijkstra; runway edges ×14 cost so runways are only
  crossed) with filleted corners and curvature-limited speed to its stand.
- Departure: pushback along the lead-in line + pivot, engine start, taxi to the
  runway entry, line-up and hold, takeoff roll (1.75–2.3 m/s² to Vr), rotation
  (pitch smoothing), straight climb-out 4.5–8 km, turn towards the destination,
  climb to FL240–360 (turboprops FL240), disappears 180 km out.
- Aircraft are parked at their stand between in-block and pushback (and overnight).
- No taxi conflict resolution: aircraft can occasionally overlap on taxiways.

## Rendering

Parametric low-poly models (`models/aircraft.ts`, real dimensions): DH8D, CRJ9,
E75L, E295, BCS3, A319/A320/A20N/A321/A21N, B737/B738/B38M/B39M, B752F, B763F,
B788/B789, A333/A339, A359, B77W. Liveries (`air/liveries.ts`) recolour five
parts (fuselage, fin, belly, accent/logo, engines). One `InstancedMesh` per type,
one shared lit material; gear retracts; additive sprite lights (red/green/white
nav, strobes, beacon, landing/taxi lights). Far aircraft keep ≥ 15 px and turn into
dark (day) / glowing (analytics) icons; parked aircraft are drawn to scale only.

## Regenerate

```
cd pipeline
git clone --depth 1 --filter=blob:none --sparse https://github.com/vradarserver/standing-data.git raw/air/sd
(cd raw/air/sd && git sparse-checkout set routes/schema-01 airports/schema-01 airlines/schema-01)
uv run python -m tpipe.air        # needs raw/bbox.osm.pbf + work/terrain.npz; ~10 s
```

Output: `app/public/data/air/{airports,schedule_weekday,schedule_saturday,schedule_sunday}.json`.
