# Real-world data sources

OSM is a lossy sketch of reality; it stays the source for *semantics* (what a
feature is). Geometry and heights should come from the best authoritative
source available, with curated overrides on top (see ROADS.md "Source of
truth"). Endpoints below were verified live on 2026-09-30 unless marked.

Attribution strings:
- OGL-Ontario: "Contains information licensed under the Open Government Licence – Ontario"
- OGL-Toronto: "Contains information licensed under the Open Government Licence – Toronto"
- OGL-Canada: "Contains information licensed under the Open Government Licence – Canada"
- USGS / FHWA: public domain (credit as courtesy)

## Ranked by impact

| # | Need | Best source | Access | Licence |
|---|---|---|---|---|
| 1 | Bare-earth terrain | Ontario DTM (lidar-derived), 0.5 m, GTA 2023 / Hamilton–Niagara 2021 / Waterloo projects | ImageServer `https://ws.geoservices.lrc.gov.on.ca/arcgis5/rest/services/Elevation/Ontario_DTM_LidarDerived/ImageServer` (`exportImage`, max 30000 px, F32, CGVD2013); DSM at `Ontario_DSM_LidarDerived` | OGL-Ontario |
| 1b | Point clouds (bridge decks, rail beds) | Ontario Classified Point Cloud, COPC LAZ on NRCan S3 (range reads) | tile index `https://services1.arcgis.com/TJH5KDher0W13Kgo/arcgis/rest/services/OntarioClassifiedPC_LidarDerived_TileIndex/FeatureServer/0` | OGL-Ontario |
| 1c | NY slice terrain | USGS 3DEP 1 m / Seamless 1 m (S1M); EPT `NY_3County_2019` | TNM API `tnmaccess.nationalmap.gov/api/v1/products` | public domain |
| 2 | Curbs, pavement, sidewalks, markings | Mississauga Planimetric_Lines/Shapes (2024; curbs, sidewalks, lane lines, stop bars, retaining walls); Brampton Curbs/Sidewalks/Pavement_Markings | ArcGIS FeatureServers (see research log) | Mississauga: **needs written consent** before shipping derived geometry. Brampton: CC BY |
| 2b | Lanes / widths elsewhere | Ontario Road Network (lanes, class, speed; weekly); Waterloo Region + Kitchener (surface width, lanes, medians); NYSDOT inventory (lane/shoulder/median widths) | ORN composite FeatureServer layer 5, bulk `ORNELEM.zip` | OGL-Ontario (review ORN "Licensed Sources") |
| 3 | Bridge heights | No Ontario open dataset has deck z / clearance → measure from DSM / COPC bridge-class points. Footprints: ORN Structure, ORWN structures, MTO bridge CSV (spans, widths), municipal bridge layers. NY: FHWA NBI (vertical clearances) | | OGL-Ontario / public domain |
| 4 | Rail | ORWN track, crossings, structures (stale but authoritative); heights from COPC; Metrolinx publishes no track geometry | `ws.gisetl.lrc.gov.on.ca/fmedatadownload/Packages/ORWNTRK.zip` | OGL-Ontario |
| 5 | Validation imagery | Ontario GEO Imagery Data Service 16 cm (SCOOP2023 GTA, SWOOP2025 Hamilton/Waterloo/Niagara); Toronto 8 cm annual ortho (WMTS); NYS Latest ortho | `…/AerialImagery/GEO_Imagery_Data_Service_2023to2027/ImageServer`; `gis.toronto.ca/arcgis/rest/services/basemap/cot_ortho/MapServer` | OGL-Ontario / OGL-Toronto / NYS free |
| 6 | Street furniture | Tree inventories (Toronto, Mississauga, Hamilton, Kitchener, Waterloo, York, Oakville, Burlington, Niagara Falls); light poles & signals (Hamilton, Brampton, Niagara Falls); transit stops/shelters (MiWay, Brampton, York, Durham, HSR, GRT) | municipal open data | municipal OGL variants |
| 7 | Building footprints (cross-check) | NRCan Automatically Extracted Buildings (lidar-derived); municipal footprints; NYS footprints | `download-telecharger.services.geo.ca/pub/nrcan_rncan/extraction/auto_building/` | OGL-Canada |

**Do not use** Esri World Imagery (licence forbids caching/export without subscription).

## Ingested
- Niagara Falls 1 m DTM (Ontario HRDEM + USGS 3DEP, shifted −0.41 m NAVD88→CGVD2013): `pipeline/tpipe/src_lidar.py --area niagara`, raw cache `pipeline/raw/lidar/`, per-L0-tile TBN (`dtm` i16 cm above `base_m`, `ndsm` u16 dm, `src` u8 at 8 m). Note: lidar water surfaces are noisy; trust banks and rims.

## Next
Downtown + DVP DTM, Toronto topographic physical features, ortho-vs-render diff tool (`qa/ortho_worklist.json`).
