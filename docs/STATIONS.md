# Rail stations (curated)

Owner: stations (`pipeline/tpipe/stations.py`, `pipeline/curated/stations.json`,
`app/src/layers/StationsLayer.ts`, `app/src/layers/stations/`, Union: `app/src/landmarks/union.ts`).

## Pipeline

```
cd pipeline
uv run python -m tpipe.stations seed    # (re)seed curated/stations.json from OSM (keeps "reviewed": true entries)
uv run python -m tpipe.stations build   # curated → app/public/data/stations.json (validated, projected)
```

`seed` needs `work/stations/stn.osm.pbf` (osmium tags-filter of `raw/bbox.osm.pbf`:
station nodes, `railway=subway_entrance|train_station_entrance`, `entrance=*`,
platform ways, station buildings, `amenity=parking|bus_station`), `work/transit_rail.npz`
(OSM track ways) and `work/osm_buildings.npz`. It groups the transit index's 214 rail
stations into 184 physical complexes and seeds per complex:

- **levels** (one per mode, one per TTC line at interchanges; Line 1 runs N–S at every
  crossing, the others E–W, which assigns OSM platforms to lines): grade from the track
  tags (tunnel → underground, bridge → elevated), platform ways that have a track of the
  mode alongside (island = track on both sides, side = one side), length, width, bearing;
- **entrances**: OSM entrance nodes; `building` when inside/at an OSM building, `stair`
  (sidewalk stairwell) within 15 m of one, `pavilion` otherwise, `underground` for PATH
  links, `path` for GO/VIA walkway entrances;
- station buildings (`render: false`: the tiles already draw OSM buildings), bus
  terminals (`amenity=bus_station`), GO parking lots (`park_ride` / GO / Metrolinx tagged).

Hand review (`"reviewed": true`, 90 complexes: every TTC subway station, Line 5 underground
stations, interchanges, grades of GO/UP/VIA stations) fixed platform types, stacked
levels, depths and grades from the references below.

## Schema (`curated/stations.json`)

```jsonc
{ "id": "st-george", "name": "St George", "label": "St George", "rank": 3,   // label priority 1..3
  "ids": ["ttc:St George Station"],             // transit index station ids
  "center": [lat, lon], "agencies": ["ttc"],
  "levels": [{ "mode": "subway", "line": "1", "grade": "underground", "depth": 8,
      "layout": "island", "level_order": 0,     // 0 = upper level of a stacked station
      "center": [lat, lon], "bearing": 73.5, "length": 152, "tracks": 2,
      "platforms": [{ "type": "island", "center": [lat, lon], "bearing": 73.5, "length": 141, "width": 9.3, "osm": 123 }],
      "landmark": "union_station",               // optional: platforms drawn by a landmark model
      "structure": { "kind": "glencairn" },      // optional: Allen Rd median station structure (stations/allen.ts):
                                                 // enclosure, roof, bridging concourse(s) ("concourse": "n"|"s"|"both"),
                                                 // walkways ("walks": [{from, to}]), Lawrence West bus deck ("deck")
      "note": "…" }],
  "entrances": [{ "pos": [lat, lon], "kind": "stair|pavilion|building|path|elevator|underground", "name": "…", "osm": 1 }],
  "buildings": [{ "kind": "station_building", "center": …, "length", "width", "bearing", "render": false }],
  "bus": [{ "center", "length", "width", "bearing", "osm" }],
  "parking": [{ "center", "area", "osm", "name" }],
  "sources": ["OSM …", "Wikipedia: …"], "reviewed": true }
```

Runtime (`StationsLayer`): platforms are snapped onto the tracks the trains run on (transit
route polylines, map-matched onto OSM, with the grade profile): an island between its two
neighbouring tracks, a side platform on the far side of its track, edge 1.45–1.65 m from the
track centre; curated platform geometry picks which tracks, the layout rule fills in when a
level has none. Underground levels (curated grade and rail ≥ 3.5 m below the terrain) get a
station box (walls with TTC tile band + name tiles, lit ceiling), surface levels canopies
(GO/UP/VIA: central 40 %, subway at grade: full length, LRT: 28 m), GO shelters, stair/elevator
heads on islands, light standards and name boards. Entrances: TTC stairwells with railings and
the TTC sign post, glass pavilions, sign posts at building entrances. Bus terminals: canopy.

Tunnel API: `stationBoxesNear(e, n, r)` (exported from `layers/StationsLayer.ts`) returns the
underground boxes: reference-track path (E, N, rail z every 4 m), lateral extents (left > 0 of
the path direction), floor/ceiling relative to rail, platforms, TTC wall colour.

## References

- OpenStreetMap (platform ways, `railway=subway_entrance`, station buildings, parking), 2026-09 extract.
- Wikipedia station articles (infobox platforms/tracks/structure/parking), per station below.
- TTC: Union second platform (2014), Bloor–Yonge Capacity Improvements.
- Metrolinx: Union Station Revitalization (Bush shed restoration, atrium, York/Bay concourses).
- Known layouts used for review: Line 1 Yonge 1954 stations side platforms (cut and cover),
  University line 1963 stations centre platforms, Spadina/Allen stations in the expressway median
  centre platforms (Glencairn, Lawrence West, Yorkdale, Wilson), Line 2 1966 stations side
  platforms except Bay, Kipling, Kennedy and the St George / Bloor–Yonge lower levels (centre);
  stacked: St George (L1 upper, L2 lower, both E–W), Bloor–Yonge (L1 upper N–S, L2 lower E–W);
  Spadina: separate L1/L2 stations joined by a moving-walkway tunnel.

## Union Station

Modelled whole by `app/src/landmarks/union.ts` (landmarks.json frame): head house with the
22-column Tuscan portico (smooth limestone), track deck and concourse fronts on York/Bay, the 11
through tracks with an island between each pair (track, platform, track …: OSM platforms
4;5 … 20;21), track-3 side platform, UP Express platform 1A west of York, Bush train shed (roof per
platform, smoke slots over the tracks) and the 2018 glass atrium. The station table's GO level
is marked `landmark: union_station`; the TTC Union level (centre + second side platform) is a
regular underground box.

## Per-station table

| Station | id | levels | entrances | reviewed | sources |
|---|---|---|---|---|---|
| Acton | `acton` | GO at-grade side | 3 | seed | OSM (platforms, entrances, buildings), WP: Acton GO Station |
| Aga Khan Park & Museum | `aga-khan-park-museum` | lrt L5 at-grade side | 0 | seed | OSM (platforms, entrances, buildings) |
| Agincourt | `agincourt` | GO at-grade side | 5 | seed | OSM (platforms, entrances, buildings), WP: Agincourt GO Station |
| Ajax | `ajax` | GO at-grade side | 3 | seed | OSM (platforms, entrances, buildings), WP: Ajax GO Station |
| Albion | `albion` | lrt L6 at-grade side | 0 | seed | OSM (platforms, entrances, buildings) |
| Aldershot | `aldershot` | GO at-grade mixed | 4 | seed | OSM (platforms, entrances, buildings), WP: Aldershot GO Station |
| Allandale Waterfront | `allandale-waterfront` | GO at-grade side | 4 | seed | OSM (platforms, entrances, buildings), WP: Allandale Waterfront GO Station |
| Appleby | `appleby` | GO at-grade mixed | 8 | seed | OSM (platforms, entrances, buildings), WP: Appleby GO Station |
| Aurora | `aurora` | GO at-grade side | 8 | seed | OSM (platforms, entrances, buildings), WP: Aurora GO Station |
| Avenue | `avenue` | lrt L5 underground island 25 m | 2 | yes | OSM (platforms, entrances, buildings), WP: Avenue station |
| Barrie South | `barrie-south` | GO at-grade side | 7 | seed | OSM (platforms, entrances, buildings), WP: Barrie South GO Station |
| Bathurst | `bathurst` | subway L2 underground side 10 m | 2 | yes | OSM (platforms, entrances, buildings), WP: Bathurst station (Toronto) |
| Bay | `bay` | subway L2 underground island 12 m | 4 | yes | OSM (platforms, entrances, buildings), WP: Bay station |
| Bayview | `bayview` | subway L4 underground island 16 m | 3 | yes | OSM (platforms, entrances, buildings), WP: Bayview station (Toronto) |
| Bessarion | `bessarion` | subway L4 underground island 16 m | 2 | yes | OSM (platforms, entrances, buildings), WP: Bessarion station |
| Birchmount | `birchmount` | lrt L5 at-grade side | 0 | seed | OSM (platforms, entrances, buildings) |
| Bloomington | `bloomington` | GO at-grade side | 0 | seed | OSM (platforms, entrances, buildings), WP: Bloomington GO Station |
| Bloor | `bloor` | GO at-grade mixed | 4 | yes | OSM (platforms, entrances, buildings), WP: Bloor GO Station |
| Bloor-Yonge | `bloor-yonge` | subway L1 underground side 7 m; subway L2 underground island 15 m | 12 | yes | OSM (platforms, entrances, buildings), WP: Bloor–Yonge station, TTC: Bloor-Yonge Capacity Improvements project |
| Bradford | `bradford` | GO at-grade side | 2 | seed | OSM (platforms, entrances, buildings), WP: Bradford GO Station |
| Bramalea | `bramalea` | GO at-grade mixed | 4 | seed | OSM (platforms, entrances, buildings), WP: Bramalea GO Station |
| Brampton Innovation District | `brampton-innovation-district` | GO at-grade side | 8 | seed | OSM (platforms, entrances, buildings), WP: Brampton GO Station |
| Brantford | `brantford` | VIA at-grade mixed | 0 | seed | OSM (platforms, entrances, buildings), WP: Brantford station |
| Broadview | `broadview` | subway L2 underground side 8 m | 1 | yes | OSM (platforms, entrances, buildings), WP: Broadview station |
| Bronte | `bronte` | GO at-grade mixed | 7 | seed | OSM (platforms, entrances, buildings), WP: Bronte GO Station |
| Buffalo (Depew) | `buffalo-depew` | VIA at-grade side | 0 | seed | OSM (platforms, entrances, buildings) |
| Buffalo (Exchange) | `buffalo-exchange` | VIA at-grade side | 0 | seed | OSM (platforms, entrances, buildings) |
| Burlington | `burlington` | GO at-grade mixed | 5 | seed | OSM (platforms, entrances, buildings), WP: Burlington GO Station |
| Caledonia | `caledonia` | lrt L5 underground side 14 m | 0 | yes | OSM (platforms, entrances, buildings), WP: Caledonia station |
| Castle Frank | `castle-frank` | subway L2 underground side 8 m | 2 | yes | OSM (platforms, entrances, buildings), WP: Castle Frank station |
| Cedarvale | `cedarvale` | subway L1 underground side 10 m; lrt L5 underground island 20 m | 5 | yes | OSM (platforms, entrances, buildings), WP: Cedarvale station |
| Centennial | `centennial` | GO at-grade side | 0 | seed | OSM (platforms, entrances, buildings), WP: Centennial GO Station |
| Chaplin | `chaplin` | lrt L5 underground island 18 m | 4 | yes | OSM (platforms, entrances, buildings), WP: Chaplin station |
| Chester | `chester` | subway L2 underground side 8 m | 2 | yes | OSM (platforms, entrances, buildings), WP: Chester station (Toronto) |
| Christie | `christie` | subway L2 underground side 10 m | 1 | yes | OSM (platforms, entrances, buildings), WP: Christie station |
| Clarkson | `clarkson` | GO at-grade mixed | 7 | seed | OSM (platforms, entrances, buildings), WP: Clarkson GO Station |
| College | `college` | subway L1 underground side 8 m | 5 | yes | OSM (platforms, entrances, buildings), WP: College station (Toronto) |
| Confederation | `confederation` | GO at-grade side | 0 | seed | OSM (platforms, entrances, buildings), WP: Confederation GO Station |
| Cooksville | `cooksville` | GO at-grade side | 2 | seed | OSM (platforms, entrances, buildings), WP: Cooksville GO Station |
| Coxwell | `coxwell` | subway L2 underground side 8 m | 1 | yes | OSM (platforms, entrances, buildings), WP: Coxwell station |
| Danforth | `danforth` | GO at-grade mixed | 4 | seed | OSM (platforms, entrances, buildings), WP: Danforth GO Station |
| Davisville | `davisville` | subway L1 at-grade side | 4 | yes | OSM (platforms, entrances, buildings), WP: Davisville station |
| Dixie | `dixie` | GO at-grade side | 3 | seed | OSM (platforms, entrances, buildings), WP: Dixie GO Station |
| Don Mills | `don-mills` | subway L4 underground island 16 m | 3 | yes | OSM (platforms, entrances, buildings), WP: Don Mills station |
| Don Valley | `don-valley` | lrt L5 at-grade side | 3 | yes | OSM (platforms, entrances, buildings), WP: Don Valley station |
| Donlands | `donlands` | subway L2 underground side 10 m | 1 | yes | OSM (platforms, entrances, buildings), WP: Donlands station |
| Downsview Park | `downsview-park` | subway L1 underground island 15 m; GO at-grade side | 2 | yes | OSM (platforms, entrances, buildings), WP: Downsview Park station |
| Driftwood | `driftwood` | lrt L6 at-grade side | 0 | seed | OSM (platforms, entrances, buildings) |
| Dufferin | `dufferin` | subway L2 underground side 10 m | 6 | yes | OSM (platforms, entrances, buildings), WP: Dufferin station |
| Duncanwoods | `duncanwoods` | lrt L6 at-grade side | 0 | seed | OSM (platforms, entrances, buildings) |
| Dundas West | `dundas-west` | subway L2 underground side 10 m | 0 | yes | OSM (platforms, entrances, buildings), WP: Dundas West station |
| Dupont | `dupont` | subway L1 underground side 12 m | 2 | yes | OSM (platforms, entrances, buildings), WP: Dupont station |
| Oshawa | `durham-college-oshawa` | GO at-grade mixed | 2 | yes | OSM (platforms, entrances, buildings), WP: Oshawa GO Station |
| East Gwillimbury | `east-gwillimbury` | GO at-grade side | 3 | seed | OSM (platforms, entrances, buildings), WP: East Gwillimbury GO Station |
| Eglinton | `eglinton` | GO at-grade side | 2 | seed | OSM (platforms, entrances, buildings), WP: Eglinton station |
| Eglinton | `eglinton-ttc` | subway L1 underground island 8 m; lrt L5 underground island 22 m | 9 | yes | OSM (platforms, entrances, buildings) |
| Emery | `emery` | lrt L6 at-grade side | 0 | seed | OSM (platforms, entrances, buildings) |
| Erindale | `erindale` | GO at-grade island | 5 | seed | OSM (platforms, entrances, buildings), WP: Erindale GO Station |
| Etobicoke North | `etobicoke-north` | GO at-grade side | 1 | seed | OSM (platforms, entrances, buildings), WP: Etobicoke North GO Station |
| Exhibition | `exhibition` | GO at-grade side | 2 | yes | OSM (platforms, entrances, buildings), WP: Exhibition GO Station |
| Fairbank | `fairbank` | lrt L5 underground island 16 m | 2 | yes | OSM (platforms, entrances, buildings), WP: Fairbank station |
| Finch | `finch` | subway L1 underground island 10 m | 12 | yes | OSM (platforms, entrances, buildings), WP: Finch station |
| Finch West | `finch-west` | subway L1 underground island 15 m; lrt L6 underground island 12 m | 2 | yes | OSM (platforms, entrances, buildings), WP: Finch West station |
| Forest Hill | `forest-hill` | lrt L5 underground island 18 m | 3 | yes | OSM (platforms, entrances, buildings), WP: Forest Hill station (Toronto) |
| Georgetown | `georgetown` | GO at-grade side | 2 | seed | OSM (platforms, entrances, buildings), WP: Georgetown GO Station |
| Glencairn | `glencairn` | subway L1 at-grade island | 3 | yes | OSM (platforms, entrances, buildings), WP: Glencairn station |
| Golden Mile | `golden-mile` | lrt L5 at-grade side | 0 | seed | OSM (platforms, entrances, buildings) |
| Gormley | `gormley` | GO at-grade side | 0 | seed | OSM (platforms, entrances, buildings), WP: Gormley GO Station |
| Greenwood | `greenwood` | subway L2 underground side 8 m | 1 | yes | OSM (platforms, entrances, buildings), WP: Greenwood station (Toronto) |
| Grimsby | `grimsby` | VIA at-grade side | 1 | seed | OSM (platforms, entrances, buildings), WP: Grimsby GO Station |
| Guelph Central | `guelph-central` | GO at-grade side | 7 | seed | OSM (platforms, entrances, buildings), WP: Guelph Central Station |
| Guildwood | `guildwood` | GO at-grade mixed | 5 | seed | OSM (platforms, entrances, buildings), WP: Guildwood GO Station |
| Hakimi Lebovic | `hakimi-lebovic` | lrt L5 at-grade side | 0 | seed | OSM (platforms, entrances, buildings) |
| Hamilton | `hamilton` | GO at-grade side | 3 | yes | OSM (platforms, entrances, buildings) |
| High Park | `high-park` | subway L2 underground side 10 m | 4 | yes | OSM (platforms, entrances, buildings), WP: High Park station |
| Highway 407 | `highway-407` | subway L1 underground island 10 m | 1 | yes | OSM (platforms, entrances, buildings), WP: Highway 407 station |
| Humber College | `humber-college` | lrt L6 at-grade island | 0 | yes | OSM (platforms, entrances, buildings), WP: Humber College station |
| Ingersoll | `ingersoll` | VIA at-grade side | 0 | seed | OSM (platforms, entrances, buildings), WP: Ingersoll station |
| Ionview | `ionview` | lrt L5 at-grade side | 0 | seed | OSM (platforms, entrances, buildings) |
| Islington | `islington` | subway L2 underground side 10 m | 3 | yes | OSM (platforms, entrances, buildings), WP: Islington station (Toronto) |
| Jane | `jane` | subway L2 underground side 10 m | 3 | yes | OSM (platforms, entrances, buildings), WP: Jane station |
| Jane and Finch | `jane-and-finch` | lrt L6 at-grade side | 0 | seed | OSM (platforms, entrances, buildings), WP: Line 6 Finch West |
| Keele | `keele` | subway L2 underground side 10 m | 2 | yes | OSM (platforms, entrances, buildings), WP: Keele station |
| Keelesdale | `keelesdale` | lrt L5 underground island 16 m | 2 | yes | OSM (platforms, entrances, buildings), WP: Keelesdale station |
| Kennedy | `kennedy` | subway L2 underground island 10 m; lrt L5 underground island 14 m; GO at-grade side | 3 | yes | OSM (platforms, entrances, buildings), WP: Kennedy station, WP: Kennedy GO Station |
| King | `king` | subway L1 underground side 8 m | 10 | yes | OSM (platforms, entrances, buildings), WP: King station (Toronto) |
| King City | `king-city` | GO at-grade side | 3 | seed | OSM (platforms, entrances, buildings), WP: King City GO Station |
| Kipling | `kipling` | subway L2 at-grade island; GO at-grade island | 6 | yes | OSM (platforms, entrances, buildings), WP: Kipling station, WP: Kipling GO Station |
| Kitchener | `kitchener` | GO at-grade side | 5 | seed | OSM (platforms, entrances, buildings), WP: Kitchener station |
| Laird | `laird` | lrt L5 underground island 14 m | 2 | yes | OSM (platforms, entrances, buildings), WP: Laird station |
| Langstaff | `langstaff` | GO at-grade side | 0 | seed | OSM (platforms, entrances, buildings), WP: Langstaff GO Station |
| Lansdowne | `lansdowne` | subway L2 underground side 10 m | 3 | yes | OSM (platforms, entrances, buildings), WP: Lansdowne station (Toronto) |
| Lawrence | `lawrence` | subway L1 underground island 12 m | 2 | yes | OSM (platforms, entrances, buildings), WP: Lawrence station (Toronto) |
| Lawrence West | `lawrence-west` | subway L1 at-grade island | 4 | yes | OSM (platforms, entrances, buildings), WP: Lawrence West station |
| Leaside | `leaside` | lrt L5 underground island 16 m | 3 | yes | OSM (platforms, entrances, buildings), WP: Leaside station |
| Leslie | `leslie` | subway L4 underground island 16 m | 4 | yes | OSM (platforms, entrances, buildings), WP: Leslie station |
| Lisgar | `lisgar` | GO at-grade side | 3 | seed | OSM (platforms, entrances, buildings), WP: Lisgar GO Station |
| Long Branch | `long-branch` | GO at-grade mixed | 3 | seed | OSM (platforms, entrances, buildings), WP: Long Branch GO Station |
| Main Street | `main-street` | subway L2 underground side 8 m | 0 | yes | OSM (platforms, entrances, buildings), WP: Main Street station (Toronto) |
| Malton | `malton` | GO at-grade side | 4 | seed | OSM (platforms, entrances, buildings), WP: Malton GO Station, WP: Malton railway station |
| Maple | `maple` | GO at-grade side | 5 | seed | OSM (platforms, entrances, buildings), WP: Maple GO Station |
| Markham | `markham` | GO at-grade side | 0 | seed | OSM (platforms, entrances, buildings), WP: Markham GO Station |
| Martin Grove | `martin-grove` | lrt L6 at-grade island | 0 | seed | OSM (platforms, entrances, buildings) |
| Meadowvale | `meadowvale` | GO at-grade side | 4 | seed | OSM (platforms, entrances, buildings), WP: Meadowvale GO Station |
| Milliken | `milliken` | GO at-grade side | 0 | seed | OSM (platforms, entrances, buildings), WP: Milliken GO Station |
| Milton | `milton` | GO at-grade side | 3 | seed | OSM (platforms, entrances, buildings), WP: Milton GO Station |
| Milvan Rumike | `milvan-rumike` | lrt L6 at-grade side | 0 | seed | OSM (platforms, entrances, buildings) |
| Mimico | `mimico` | GO at-grade mixed | 2 | seed | OSM (platforms, entrances, buildings), WP: Mimico GO Station |
| Mount Dennis | `mount-dennis` | lrt L5 at-grade island; GO at-grade mixed | 5 | yes | OSM (platforms, entrances, buildings), WP: Mount Dennis station |
| Mount Joy | `mount-joy` | GO at-grade side | 0 | seed | OSM (platforms, entrances, buildings), WP: Mount Joy GO Station |
| Mount Olive | `mount-olive` | lrt L6 at-grade island | 0 | seed | OSM (platforms, entrances, buildings), WP: Mount Olive station |
| Mount Pleasant | `mount-pleasant` | GO at-grade mixed | 6 | seed | OSM (platforms, entrances, buildings), WP: Mount Pleasant station (Toronto) |
| Mount Pleasant | `mount-pleasant-ttc` | lrt L5 underground island 18 m | 3 | yes | OSM (platforms, entrances, buildings) |
| Museum | `museum` | subway L1 underground island 10 m | 5 | yes | OSM (platforms, entrances, buildings), WP: Museum station (Toronto) |
| Newmarket | `newmarket` | GO at-grade side | 10 | seed | OSM (platforms, entrances, buildings), WP: Newmarket GO Station |
| Niagara Falls | `niagara-falls` | GO at-grade side | 3 | seed | OSM (platforms, entrances, buildings) |
| Norfinch Oakdale | `norfinch-oakdale` | lrt L6 at-grade side | 0 | seed | OSM (platforms, entrances, buildings) |
| North York Centre | `north-york-centre` | subway L1 underground side 12 m | 3 | yes | OSM (platforms, entrances, buildings), WP: North York Centre station |
| O'Connor | `o-connor` | lrt L5 at-grade side | 0 | seed | OSM (platforms, entrances, buildings) |
| Oakville | `oakville` | GO at-grade mixed | 5 | seed | OSM (platforms, entrances, buildings), WP: Oakville GO Station |
| Oakwood | `oakwood` | lrt L5 underground island 16 m | 0 | yes | OSM (platforms, entrances, buildings), WP: Oakwood station (Toronto) |
| Old Cummer | `old-cummer` | GO at-grade side | 0 | seed | OSM (platforms, entrances, buildings), WP: Old Cummer GO Station |
| Old Elm | `old-elm` | GO at-grade side | 0 | seed | OSM (platforms, entrances, buildings), WP: Old Elm GO Station |
| Old Mill | `old-mill` | subway L2 elevated side | 1 | yes | OSM (platforms, entrances, buildings), WP: Old Mill station |
| Oriole | `oriole` | GO at-grade side | 0 | seed | OSM (platforms, entrances, buildings), WP: Oriole GO Station |
| Osgoode | `osgoode` | subway L1 underground island 12 m | 4 | yes | OSM (platforms, entrances, buildings), WP: Osgoode station |
| Ossington | `ossington` | subway L2 underground side 10 m | 2 | yes | OSM (platforms, entrances, buildings), WP: Ossington station |
| Pape | `pape` | subway L2 underground side 10 m | 2 | yes | OSM (platforms, entrances, buildings), WP: Pape station |
| Pearldale | `pearldale` | lrt L6 at-grade side | 0 | seed | OSM (platforms, entrances, buildings) |
| Pearson Airport | `pearson-airport` | UP elevated island | 0 | yes | OSM (platforms, entrances, buildings) |
| Pharmacy | `pharmacy` | lrt L5 at-grade side | 0 | seed | OSM (platforms, entrances, buildings) |
| Pickering | `pickering` | GO at-grade mixed | 5 | seed | OSM (platforms, entrances, buildings), WP: Pickering GO Station |
| Pioneer Village | `pioneer-village` | subway L1 underground island 18 m | 5 | yes | OSM (platforms, entrances, buildings), WP: Pioneer Village station |
| Port Credit | `port-credit` | GO at-grade mixed | 7 | seed | OSM (platforms, entrances, buildings), WP: Port Credit GO Station |
| Port Hope | `port-hope` | VIA at-grade side | 0 | seed | OSM (platforms, entrances, buildings), WP: Port Hope station |
| Queen | `queen` | subway L1 underground side 8 m | 15 | yes | OSM (platforms, entrances, buildings), WP: Queen station |
| Queen's Park | `queen-s-park` | subway L1 underground island 12 m | 5 | yes | OSM (platforms, entrances, buildings), WP: Queen's Park station (Toronto) |
| Richmond Hill | `richmond-hill` | GO at-grade side | 0 | seed | OSM (platforms, entrances, buildings), WP: Richmond Hill GO Station |
| Rosedale | `rosedale` | subway L1 trench side | 1 | yes | OSM (platforms, entrances, buildings), WP: Rosedale station (Toronto) |
| Rouge Hill | `rouge-hill` | GO at-grade side | 8 | seed | OSM (platforms, entrances, buildings), WP: Rouge Hill GO Station |
| Rowntree Mills | `rowntree-mills` | lrt L6 at-grade side | 0 | seed | OSM (platforms, entrances, buildings) |
| Royal York | `royal-york` | subway L2 underground side 10 m | 2 | yes | OSM (platforms, entrances, buildings), WP: Royal York station |
| Runnymede | `runnymede` | subway L2 underground side 10 m | 2 | yes | OSM (platforms, entrances, buildings), WP: Runnymede station |
| Rutherford | `rutherford` | GO at-grade side | 1 | seed | OSM (platforms, entrances, buildings), WP: Rutherford GO Station |
| Scarborough | `scarborough` | GO at-grade side | 6 | seed | OSM (platforms, entrances, buildings), WP: Scarborough GO Station |
| Sentinel | `sentinel` | lrt L6 at-grade side | 0 | seed | OSM (platforms, entrances, buildings) |
| Sheppard West | `sheppard-west` | subway L1 underground island 12 m | 3 | yes | OSM (platforms, entrances, buildings), WP: Sheppard West station |
| Sheppard-Yonge | `sheppard-yonge` | subway L1 underground island 12 m; subway L4 underground side 18 m | 8 | yes | OSM (platforms, entrances, buildings), WP: Sheppard–Yonge station |
| Sherbourne | `sherbourne` | subway L2 underground side 10 m | 2 | yes | OSM (platforms, entrances, buildings), WP: Sherbourne station |
| Signet Arrow | `signet-arrow` | lrt L6 at-grade side | 0 | seed | OSM (platforms, entrances, buildings) |
| Sloane | `sloane` | lrt L5 at-grade island | 0 | seed | OSM (platforms, entrances, buildings) |
| Spadina | `spadina` | subway L1 underground side 12 m; subway L2 underground side 10 m | 5 | yes | OSM (platforms, entrances, buildings), WP: Spadina station |
| St Andrew | `st-andrew` | subway L1 underground island 10 m | 8 | yes | OSM (platforms, entrances, buildings), WP: St. Andrew station |
| St. Catharines | `st-catharines` | GO at-grade side | 1 | seed | OSM (platforms, entrances, buildings), WP: St. Catharines station |
| St Clair | `st-clair` | subway L1 underground side 8 m | 6 | yes | OSM (platforms, entrances, buildings), WP: St. Clair station |
| St Clair West | `st-clair-west` | subway L1 underground side 12 m | 3 | yes | OSM (platforms, entrances, buildings), WP: St. Clair West station |
| St George | `st-george` | subway L1 underground island 8 m; subway L2 underground island 15 m | 3 | yes | OSM (platforms, entrances, buildings), WP: St. George station |
| St Patrick | `st-patrick` | subway L1 underground island 15 m | 4 | yes | OSM (platforms, entrances, buildings), WP: St. Patrick station |
| Stevenson | `stevenson` | lrt L6 at-grade island | 0 | seed | OSM (platforms, entrances, buildings), WP: Stevenson station |
| Stouffville | `stouffville` | GO at-grade side | 0 | seed | OSM (platforms, entrances, buildings), WP: Stouffville GO Station |
| Stratford | `stratford` | GO at-grade side | 0 | seed | OSM (platforms, entrances, buildings), WP: Stratford station (Ontario) |
| Streetsville | `streetsville` | GO at-grade mixed | 3 | seed | OSM (platforms, entrances, buildings), WP: Streetsville GO Station |
| Summerhill | `summerhill` | subway L1 underground side 6 m | 1 | yes | OSM (platforms, entrances, buildings), WP: Summerhill station |
| Sunnybrook Park | `sunnybrook-park` | lrt L5 at-grade side | 0 | yes | OSM (platforms, entrances, buildings) |
| TMU | `tmu` | subway L1 underground side 8 m | 6 | yes | OSM (platforms, entrances, buildings), WP: TMU station |
| Tobermory | `tobermory` | lrt L6 at-grade side | 0 | seed | OSM (platforms, entrances, buildings) |
| Union | `union` | subway L1 underground mixed 8 m; GO at-grade mixed | 29 | yes | OSM (platforms, entrances, buildings), WP: Union Station (Toronto), WP: Union station (TTC), TTC: Union Station second platform (2014), Metrolinx: Union Station Revitalization / trainshed |
| Unionville | `unionville` | GO at-grade side | 0 | seed | OSM (platforms, entrances, buildings), WP: Unionville GO Station |
| Vaughan Metropolitan Centre | `vaughan-metropolitan-centre` | subway L1 underground island 16 m | 10 | yes | OSM (platforms, entrances, buildings), WP: Vaughan Metropolitan Centre station |
| Victoria Park | `victoria-park` | subway L2 at-grade side | 5 | yes | OSM (platforms, entrances, buildings), WP: Victoria Park station (Toronto) |
| Warden | `warden` | subway L2 at-grade side | 1 | yes | OSM (platforms, entrances, buildings), WP: Warden station |
| Washago | `washago` | VIA at-grade side | 0 | seed | OSM (platforms, entrances, buildings), WP: Washago station |
| Wellesley | `wellesley` | subway L1 underground side 7 m | 2 | yes | OSM (platforms, entrances, buildings), WP: Wellesley station |
| West Harbour | `west-harbour` | GO at-grade side | 5 | seed | OSM (platforms, entrances, buildings), WP: West Harbour GO Station |
| Westmore | `westmore` | lrt L6 at-grade side | 0 | seed | OSM (platforms, entrances, buildings) |
| Weston | `weston` | GO at-grade mixed | 4 | yes | OSM (platforms, entrances, buildings), WP: Weston GO Station |
| Whitby | `whitby` | GO at-grade island | 5 | seed | OSM (platforms, entrances, buildings), WP: Whitby GO Station |
| Wilson | `wilson` | subway L1 at-grade island | 5 | yes | OSM (platforms, entrances, buildings), WP: Wilson station (Toronto) |
| Woodbine | `woodbine` | subway L2 underground side 8 m | 2 | yes | OSM (platforms, entrances, buildings), WP: Woodbine station |
| Woodstock | `woodstock` | VIA at-grade mixed | 0 | seed | OSM (platforms, entrances, buildings), WP: Woodstock station (Ontario) |
| Wynford | `wynford` | lrt L5 at-grade side | 0 | seed | OSM (platforms, entrances, buildings) |
| York Mills | `york-mills` | subway L1 underground island 12 m | 4 | yes | OSM (platforms, entrances, buildings), WP: York Mills station |
| York University | `york-university` | subway L1 underground island 25 m | 2 | yes | OSM (platforms, entrances, buildings), WP: York University station |
| Yorkdale | `yorkdale` | subway L1 at-grade island | 4 | yes | OSM (platforms, entrances, buildings), WP: Yorkdale station |