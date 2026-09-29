"""Projection, datum and tile-grid constants shared by every pipeline stage.

See docs/SPEC.md for the full contract; the client mirrors these values
from data/manifest.json.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from pyproj import Transformer

ROOT = Path(__file__).resolve().parents[2]
PIPE = ROOT / "pipeline"
RAW = PIPE / "raw"
WORK = PIPE / "work"
OUT = ROOT / "app" / "public" / "data"

# Transverse Mercator centred on Toronto City Hall. Scale error stays below
# 0.02% across the whole region, so everything is "to scale" in metres.
ORIGIN_LAT = 43.6532
ORIGIN_LON = -79.3832
PROJ = f"+proj=tmerc +lat_0={ORIGIN_LAT} +lon_0={ORIGIN_LON} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs"

# World elevation 0 == 75 m above sea level (roughly Lake Ontario's surface).
DATUM_M = 75.0

# Tile pyramid: level -> tile edge length in metres.
TILE_SIZE = {0: 1024.0, 1: 4096.0, 2: 16384.0}
TERRAIN_GRID = {0: 33, 1: 65, 2: 65}
GROUND_RES = 256

# Broad processing bbox (lon/lat). The actual region is a polygon inside it.
BBOX_LONLAT = (-81.0, 42.75, -78.2, 44.75)

_fwd = Transformer.from_crs("EPSG:4326", PROJ, always_xy=True)
_inv = Transformer.from_crs(PROJ, "EPSG:4326", always_xy=True)


def project(lon, lat):
    """lon/lat (deg) -> (east, north) metres. Accepts scalars or arrays."""
    return _fwd.transform(lon, lat)


def unproject(x, y):
    return _inv.transform(x, y)


def tile_of(x: float, y: float, level: int) -> tuple[int, int]:
    s = TILE_SIZE[level]
    return math.floor(x / s), math.floor(y / s)


def tile_origin(tx: int, ty: int, level: int) -> tuple[float, float]:
    s = TILE_SIZE[level]
    return tx * s, ty * s


def projected_bbox() -> tuple[float, float, float, float]:
    w, s, e, n = BBOX_LONLAT
    lons = np.array([w, e, e, w, (w + e) / 2, (w + e) / 2])
    lats = np.array([s, s, n, n, s, n])
    xs, ys = project(lons, lats)
    return float(np.min(xs)), float(np.min(ys)), float(np.max(xs)), float(np.max(ys))
