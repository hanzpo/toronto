"""City of Toronto topographic mapping (physical road surface, sidewalks,
parking lots) per level-0 tile, in the world frame.

Source: City of Toronto Open Data (Open Government Licence - Toronto;
attribution "Contains information licensed under the Open Government
Licence - Toronto"). Photogrammetric capture from high-resolution aerial
photography, refreshed quarterly (docs/SOURCES.md):
- "Topographic Mapping - Edge of Road": polygons of the physical road surface
  (edge of pavement = curb line in built-up areas), subtypes below.
- "Topographic Mapping - Physical area of sidewalks": sidewalk polygons.
- "Topographic Mapping - Physical area of parking lots": parking polygons.
Downloads (GeoPackage, EPSG:4326) are cached in pipeline/raw/toronto_topo/.

Product: $TPIPE_OUT/topo/{tx}_{ty}.bin.gz (TBN1), per level-0 tile:
- `tt_roff` u32 [nP+1]: polygon p owns rings [tt_roff[p], tt_roff[p+1]); its
  first ring is the outer ring (CCW), later rings are holes (CW).
- `tt_voff` u32 [nR+1]: ring r owns vertices [tt_voff[r], tt_voff[r+1]); rings
  are not closed.
- `tt_xy` u16 [2*nV]: local metres * 65535 / 1024 (1.6 cm), as `gp_xy`.
- `tt_class` u8 [nP]: 1 road edge (carriageway) - 2 intersection - 3 lane
  edge (public laneway) - 4 road bridge - 5 highway ramp - 6 highway bridge -
  7 highway edge - 10 sidewalk - 11 parking lot.
- `tt_elev` f32 [nP]: the City's ELEVATION attribute (datum m), NaN if unset.
- `tc_off` u32 [nC+1] / `tc_xy` u16 / `tc_side` u8 [nV]: edge-of-pavement lines
  (boundary of the union of classes 1-7, tile-border cuts removed), road on the
  left. `tc_side` per vertex: 1 = a sidewalk polygon within 3.0 m (curbed
  urban edge), 0 = none (rural edge, shoulder, lot or boulevard).
Polygons are clipped to the tile rectangle.

    uv run python -m tpipe.src_toronto_topo [--area downtown] [--workers 2]
"""

from __future__ import annotations

import argparse
import json
import math
import os
import time
import urllib.request
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

from . import geo, tbn

RAW = geo.RAW / "toronto_topo"
CKAN = "https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show?id="
LAYERS = {  # file stem -> CKAN package
    "edge-of-roadway-4326": "topographic-mapping-edge-of-road",
    "sidewalks-4326": "topographic-mapping-physical-area-of-sidewalks",
    "parking-lot-4326": "topographic-mapping-physical-area-of-parking-lots",
}
ROAD_CLASS = {"Road Edge": 1, "Intersection": 2, "Lane Edge": 3, "Road Bridge": 4,
              "Highway Ramp": 5, "Highway Bridge": 6, "Highway Edge": 7}
S = geo.TILE_SIZE[0]
Q = 65535.0 / S
CURB_DIST = 3.0

_G = {}  # per-process geometry cache (fork-inherited)


def download() -> None:
    """Fetch the three GeoPackages (resumable, skipped when present)."""
    RAW.mkdir(parents=True, exist_ok=True)
    for stem, pkg in LAYERS.items():
        f = RAW / f"{stem}.gpkg"
        if f.exists() and f.stat().st_size > 1e6:
            continue
        with urllib.request.urlopen(CKAN + pkg, timeout=120) as r:
            res = json.load(r)["result"]["resources"]
        url = next(x["url"] for x in res if x["url"].endswith(f"{stem}.gpkg"))
        print("download", url, flush=True)
        os.system(f"curl -sL -C - --retry 5 -o '{f}.part' '{url}' && mv '{f}.part' '{f}'")


def load() -> None:
    """Read all polygons, project to the world frame, keep in _G."""
    import pyogrio
    import shapely
    from pyproj import Transformer

    t = Transformer.from_crs("EPSG:4326", geo.PROJ, always_xy=True)
    geoms, cls, elev = [], [], []
    for stem in LAYERS:
        meta, _, g, fields = pyogrio.raw.read(RAW / f"{stem}.gpkg", columns=["SUBTYPE_DESC", "ELEVATION"])
        g = shapely.from_wkb(g)
        g = shapely.transform(g, lambda xy: np.column_stack(t.transform(xy[:, 0], xy[:, 1])))
        g = shapely.make_valid(g)
        sub = fields[0]
        ev = np.array([float(v) if v not in (None, "", "None") else np.nan for v in fields[1]], np.float64)
        ev[(ev <= 1)] = np.nan  # 0 = unset
        if stem.startswith("edge"):
            c = np.array([ROAD_CLASS.get(s, 1) for s in sub], np.uint8)
        elif stem.startswith("sidewalks"):
            c = np.full(len(g), 10, np.uint8)
        else:
            c = np.full(len(g), 11, np.uint8)
        geoms.append(g)
        cls.append(c)
        elev.append(ev - geo.DATUM_M)
        print(f"  {stem}: {len(g)} features", flush=True)
    _G["g"] = np.concatenate(geoms)
    _G["c"] = np.concatenate(cls)
    _G["e"] = np.concatenate(elev).astype(np.float32)
    _G["tree"] = shapely.STRtree(_G["g"])


def _polys(geom):
    import shapely

    if geom.is_empty:
        return []
    if geom.geom_type == "Polygon":
        return [geom]
    if geom.geom_type in ("MultiPolygon", "GeometryCollection"):
        return [p for g in shapely.get_parts(geom) for p in _polys(g)]
    return []


def _q(xy: np.ndarray, x0: float, y0: float) -> np.ndarray:
    return np.clip(np.round((xy - [x0, y0]) * Q), 0, 65535).astype(np.uint16)


def build_tile(tx: int, ty: int, out_dir: Path) -> dict:
    import shapely
    from shapely.geometry import box
    from shapely.geometry.polygon import orient

    x0, y0 = tx * S, ty * S
    idx = _G["tree"].query(box(x0, y0, x0 + S, y0 + S))
    if len(idx) == 0:
        return {"tile": [tx, ty], "polys": 0}
    roff, voff, xy, cl, ev = [0], [0], [], [], []
    road, side = [], []
    for k in idx:
        g = shapely.clip_by_rect(_G["g"][k], x0, y0, x0 + S, y0 + S)
        for p in _polys(g):
            p = orient(shapely.set_precision(p, 0.02), 1.0)
            if p.is_empty or p.area < 0.5:
                continue
            for p2 in _polys(p):
                rings = [p2.exterior, *p2.interiors]
                for r in rings:
                    c = np.asarray(r.coords)[:-1]
                    xy.append(_q(c, x0, y0))
                    voff.append(voff[-1] + len(c))
                roff.append(roff[-1] + len(rings))
                cl.append(_G["c"][k])
                ev.append(_G["e"][k])
                (road if _G["c"][k] < 10 else side if _G["c"][k] == 10 else []).append(p2)
    if len(cl) == 0:
        return {"tile": [tx, ty], "polys": 0}
    # edge-of-pavement lines: union boundary minus the tile border
    coff, cxy, cside = [0], [], []
    if road:
        u = shapely.union_all(road, grid_size=0.02)
        b = shapely.difference(u.boundary, box(x0, y0, x0 + S, y0 + S).boundary.buffer(0.05))
        sw = shapely.union_all(side, grid_size=0.02) if side else None
        for ln in shapely.get_parts(shapely.line_merge(b)):
            c = np.asarray(ln.coords)
            if len(c) < 2:
                continue
            if sw is not None:
                d = shapely.distance(shapely.points(c), sw)
                s = (d <= CURB_DIST).astype(np.uint8)
            else:
                s = np.zeros(len(c), np.uint8)
            cxy.append(_q(c, x0, y0))
            cside.append(s)
            coff.append(coff[-1] + len(c))
    arrays = {
        "tt_roff": np.array(roff, np.uint32), "tt_voff": np.array(voff, np.uint32),
        "tt_xy": np.concatenate(xy).ravel(), "tt_class": np.array(cl, np.uint8),
        "tt_elev": np.array(ev, np.float32),
        "tc_off": np.array(coff, np.uint32),
        "tc_xy": np.concatenate(cxy).ravel() if cxy else np.zeros(0, np.uint16),
        "tc_side": np.concatenate(cside) if cside else np.zeros(0, np.uint8),
    }
    size = tbn.write(out_dir / f"{tx}_{ty}.bin.gz", arrays, source="City of Toronto topographic mapping (OGL-Toronto)")
    return {"tile": [tx, ty], "polys": len(cl), "bytes": size}


def _job(a):
    tx, ty, out = a
    try:
        return build_tile(tx, ty, Path(out))
    except Exception as e:
        return {"tile": [tx, ty], "error": repr(e)}


def main() -> None:
    from . import src_lidar

    ap = argparse.ArgumentParser()
    ap.add_argument("--area", default="all", help="all | downtown | test")
    ap.add_argument("--workers", type=int, default=2)
    a = ap.parse_args()
    download()
    t0 = time.time()
    load()
    g = _G["g"]
    import shapely

    bb = shapely.bounds(g)
    if a.area == "all":
        tiles = sorted({(tx, ty) for x0, y0, x1, y1 in bb
                        for tx in range(math.floor(x0 / S), math.floor(x1 / S) + 1)
                        for ty in range(math.floor(y0 / S), math.floor(y1 / S) + 1)})
    else:
        tiles = src_lidar.AREAS[a.area]
    print(f"{len(g)} polygons loaded in {time.time() - t0:.0f}s; {len(tiles)} tiles", flush=True)
    out = geo.OUT / "topo"
    out.mkdir(parents=True, exist_ok=True)
    total, n = 0, 0
    import multiprocessing as mp

    with ProcessPoolExecutor(a.workers, mp_context=mp.get_context("fork")) as ex:  # workers inherit _G
        for i, r in enumerate(ex.map(_job, [(tx, ty, str(out)) for tx, ty in tiles], chunksize=4)):
            total += r.get("bytes", 0)
            n += r.get("polys", 0)
            if "error" in r or i % 100 == 0:
                print(f"[{i + 1}/{len(tiles)}] {r}", flush=True)
    print(f"done: {len(tiles)} tiles, {n} clipped polygons, {total / 1e6:.1f} MB", flush=True)


if __name__ == "__main__":
    main()
