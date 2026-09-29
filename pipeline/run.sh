#!/usr/bin/env bash
# Full, reproducible data build. Raw downloads land in raw/, intermediates in
# work/, outputs in ../app/public/data/. Re-run any step independently.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p raw/gtfs raw/dem work

BBOX=-81.0,42.75,-78.2,44.75
GEOFABRIK=https://download.geofabrik.de/north-america

# 1. OpenStreetMap: Ontario + New York (Niagara Falls NY, Great Lakes shores)
[ -f raw/ontario.osm.pbf ] || curl -sL -o raw/ontario.osm.pbf $GEOFABRIK/canada/ontario-latest.osm.pbf
[ -f raw/new-york.osm.pbf ] || curl -sL -o raw/new-york.osm.pbf $GEOFABRIK/us/new-york-latest.osm.pbf
osmium extract -b $BBOX -s smart raw/ontario.osm.pbf -o raw/bbox.osm.pbf --overwrite
osmium extract -b -79.15,42.85,-78.85,43.30 -s smart raw/new-york.osm.pbf -o raw/ny-niagara.osm.pbf --overwrite
osmium merge raw/bbox.osm.pbf raw/ny-niagara.osm.pbf -o work/combined.osm.pbf --overwrite
osmium tags-filter raw/bbox.osm.pbf r/boundary=administrative -o work/admin.osm.pbf --overwrite
osmium tags-filter raw/ontario.osm.pbf r/name="Lake Ontario","Lake Erie" -o work/lakes-on.osm.pbf --overwrite
osmium tags-filter raw/new-york.osm.pbf r/name="Lake Ontario","Lake Erie" -o work/lakes-ny.osm.pbf --overwrite
osmium merge work/lakes-on.osm.pbf work/lakes-ny.osm.pbf -o work/lakes.osm.pbf --overwrite

# 2. Terrain: Copernicus GLO-30 DSM tiles
for lat in 42 43 44; do for lon in 081 080 079; do
  n="Copernicus_DSM_COG_10_N${lat}_00_W${lon}_00_DEM"
  [ -f raw/dem/$n.tif ] || curl -s -o raw/dem/$n.tif "https://copernicus-dem-30m.s3.amazonaws.com/$n/$n.tif"
done; done
uv run python -m tpipe.terrain

# 3. Region, OSM extraction, tile pyramid, transit, landmarks
uv run python -m tpipe.region
uv run python -m tpipe.osm_extract
uv run python -m tpipe.osm_tiles
uv run python -m tpipe.transit
uv run python -m tpipe.landmarks
