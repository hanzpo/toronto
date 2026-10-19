"""Bare-earth LiDAR DTM (+ nDSM) per level-0 tile, in the world frame.

Sources (docs/SOURCES.md):
- Canada: NRCan HRDEM mosaic 1 m (CanElevation), DTM + DSM cloud-optimised
  GeoTIFFs in EPSG:3979, heights CGVD2013. One mosaic item (8_2) covers the
  whole region; it merges the provincial / TRCA / NRCan lidar projects
  (TRCA GTA 2023, York 2019, Halton 2018, Hamilton-Niagara 2021, Durham,
  Waterloo...). Open Government Licence - Canada.
- USA (Niagara County NY): USGS 3DEP bare-earth DEM dynamic image service,
  exported at 1 m in EPSG:26917 (NAD83 / UTM 17N), heights NAVD88. Public
  domain. No DSM.

Raw windows (tile + margin, native CRS, float32 LERC with 5 mm max error) are
cached in pipeline/raw/lidar/{hrdem_dtm,hrdem_dsm,usgs_dtm}/{tx}_{ty}.tif;
existing files are skipped, so a run resumes where it stopped.

Product: $TPIPE_OUT/dtm/{tx}_{ty}.bin.gz (TBN1), per level-0 tile:
- `dtm` i16 [N*N] cm above the header's `base_m` (datum metres, per tile),
  N = 1024/res + 1, index j*N + i, i east, j north, sample (i, j) at
  (i*res, j*res) tile-local; edges shared with neighbours (like terrain_h).
  Heights are world datum (ASL - 75 m), vertical datum CGVD2013 (3DEP
  NAVD88 values are shifted by the measured offset `usgs_dz`).
- `ndsm` u16 [N*N] dm: first-return surface above the bare earth (buildings,
  bridge decks, canopy); 0 = ground. Canada only (0 in the US part).
- `src` u8 [n8*n8], n8 = 1024/8 + 1: 8 m cells, 0 = no lidar (filled from the
  Copernicus terrain), 1 = HRDEM, 2 = USGS 3DEP.

    uv run python -m tpipe.src_lidar --area niagara --workers 2
    uv run python -m tpipe.src_lidar --area test | --area mask | --tiles 24,-63 ...
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

HRDEM = "https://canelevation-dem.s3.ca-central-1.amazonaws.com/hrdem-mosaic-1m/8_2-mosaic-1m-{}.tif"
USGS = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage"
RAW = geo.RAW / "lidar"
# built app data, read only (tile list, density, rail graph); products go to geo.OUT
DATA = Path(os.environ.get("TPIPE_DATA", geo.ROOT / "app" / "public" / "data"))
S = geo.TILE_SIZE[0]
MARGIN = 16.0  # metres of source read around the tile
NODATA = -32767.0
# The NY slice (same box as the osmium extract in run.sh).
NY_BOX = (-79.15, 42.85, -78.85, 43.30)

GDAL_ENV = dict(
    GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
    CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
    GDAL_HTTP_MULTIRANGE="YES",
    GDAL_HTTP_MERGE_CONSECUTIVE_RANGES="YES",
    GDAL_HTTP_MAX_RETRY="5",
    GDAL_HTTP_RETRY_DELAY="3",
    VSI_CACHE="TRUE",
)

AREAS = {
    # Chippawa / Welland mouth .. Whirlpool, Horseshoe crest .. Grass Island Pool (NY)
    "niagara": [(tx, ty) for tx in range(21, 29) for ty in range(-66, -57)],
    # downtown + Union + DVP (Bloor Viaduct .. Eglinton)
    "downtown": [(tx, ty) for tx in range(-3, 6) for ty in range(-2, 10)],
}
AREAS["test"] = AREAS["niagara"] + AREAS["downtown"]


def _tile_bounds(tx: int, ty: int, crs: str, margin: float = MARGIN):
    from pyproj import Transformer

    t = Transformer.from_crs(geo.PROJ, crs, always_xy=True)
    s = np.linspace(-margin, S + margin, 9)
    xs = np.concatenate([s, s, np.full(9, -margin), np.full(9, S + margin)]) + tx * S
    ys = np.concatenate([np.full(9, -margin), np.full(9, S + margin), s, s]) + ty * S
    X, Y = t.transform(xs, ys)
    return float(np.min(X)), float(np.min(Y)), float(np.max(X)), float(np.max(Y))


def _save(path: Path, arr: np.ndarray, crs, transform) -> None:
    import rasterio

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part.tif")
    with rasterio.open(
        tmp, "w", driver="GTiff", width=arr.shape[1], height=arr.shape[0], count=1,
        dtype="float32", crs=crs, transform=transform, nodata=NODATA, tiled=True,
        blockxsize=256, blockysize=256, compress="LERC_DEFLATE", max_z_error=0.005,
    ) as d:
        d.write(arr.astype(np.float32), 1)
    os.replace(tmp, path)


def fetch_hrdem(tx: int, ty: int, kind: str) -> Path | None:
    """Cache the HRDEM mosaic window (kind 'dtm' | 'dsm') around a tile."""
    import rasterio
    from rasterio.windows import Window, from_bounds

    out = RAW / f"hrdem_{kind}" / f"{tx}_{ty}.tif"
    if out.exists():
        return out
    with rasterio.Env(**GDAL_ENV):
        for attempt in range(4):
            try:
                with rasterio.open("/vsicurl/" + HRDEM.format(kind)) as src:
                    b = _tile_bounds(tx, ty, "EPSG:3979")
                    f = from_bounds(*b, transform=src.transform)
                    c0, r0 = math.floor(f.col_off), math.floor(f.row_off)
                    w = Window(c0, r0, math.ceil(f.col_off + f.width) - c0 + 1, math.ceil(f.row_off + f.height) - r0 + 1)
                    a = src.read(1, window=w, boundless=True, fill_value=NODATA)
                    wt = src.window_transform(w)
                    # the mosaic has holes (e.g. Table Rock / Queen Victoria Park):
                    # fill them from the per-project COGs (same 1 m grid), newest first
                    if (a <= NODATA + 1).any():
                        bb = geo.unproject(*_corners(tx, ty))
                        for pr in _projects(min(bb[0]), min(bb[1]), max(bb[0]), max(bb[1])):
                            with rasterio.open("/vsicurl/" + pr[kind]) as ps:
                                pw = from_bounds(wt.c, wt.f + wt.e * a.shape[0], wt.c + wt.a * a.shape[1], wt.f, transform=ps.transform)
                                pw = Window(round(pw.col_off), round(pw.row_off), a.shape[1], a.shape[0])
                                pa = ps.read(1, window=pw, boundless=True, fill_value=NODATA)
                                pa[~np.isfinite(pa) | (pa == ps.nodata)] = NODATA
                            hole = (a <= NODATA + 1) & (pa > NODATA + 1)
                            a[hole] = pa[hole]
                            if not (a <= NODATA + 1).any():
                                break
                    _save(out, a, src.crs, wt)
                return out
            except Exception as e:  # network hiccup: retry
                if attempt == 3:
                    raise
                print(f"  hrdem {kind} {tx},{ty} retry: {e}", flush=True)
                time.sleep(5 * (attempt + 1))
    return None


def _corners(tx: int, ty: int):
    return np.array([tx, tx + 1, tx + 1, tx]) * S, np.array([ty, ty, ty + 1, ty + 1]) * S


_PROJ_CACHE = None


def _projects(w: float, s: float, e: float, n: float) -> list[dict]:
    """HRDEM per-project lidar DTM/DSM items overlapping a lon/lat box, newest
    first. The STAC listing for the region is cached in raw/lidar."""
    global _PROJ_CACHE
    if _PROJ_CACHE is None:
        f = RAW / "hrdem_projects.json"
        if not f.exists():
            items, url = [], (
                "https://datacube.services.geo.ca/stac/api/search?collections=hrdem-lidar&limit=100&bbox="
                + ",".join(map(str, geo.BBOX_LONLAT))
            )
            while url:
                with urllib.request.urlopen(url, timeout=120) as r:
                    d = json.load(r)
                for it in d["features"]:
                    a = it["assets"]
                    if "dtm" in a:
                        items.append({"id": it["id"], "bbox": it["bbox"], "date": it["properties"]["datetime"],
                                      "dtm": a["dtm"]["href"], "dsm": a.get("dsm", {}).get("href")})
                url = next((lk["href"] for lk in d.get("links", []) if lk.get("rel") == "next"), None)
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(json.dumps(items, indent=1))
        _PROJ_CACHE = sorted(json.loads(f.read_text()), key=lambda p: p["date"], reverse=True)
    return [p for p in _PROJ_CACHE if p["bbox"][0] < e and p["bbox"][2] > w and p["bbox"][1] < n and p["bbox"][3] > s]


def _in_ny(tx: int, ty: int) -> bool:
    lon, lat = geo.unproject(np.array([tx * S, (tx + 1) * S]), np.array([ty * S, (ty + 1) * S]))
    w, s, e, n = NY_BOX
    # east of the Niagara River: the border runs roughly N-S at lon -79.02..-79.07
    return bool(max(lon) > -79.08 and min(lon) < e and max(lat) > s and min(lat) < n)


def fetch_usgs(tx: int, ty: int) -> Path | None:
    """Cache a 1 m USGS 3DEP bare-earth export (UTM 17N) around an NY-slice tile."""
    import rasterio
    from rasterio.transform import from_origin

    out = RAW / "usgs_dtm" / f"{tx}_{ty}.tif"
    if out.exists():
        return out
    x0, y0, x1, y1 = _tile_bounds(tx, ty, "EPSG:26917")
    x0, y0, x1, y1 = math.floor(x0), math.floor(y0), math.ceil(x1), math.ceil(y1)
    w, h = x1 - x0, y1 - y0
    q = (
        f"?bbox={x0},{y0},{x1},{y1}&bboxSR=26917&imageSR=26917&size={w},{h}"
        "&format=tiff&pixelType=F32&noData=-32767&interpolation=RSP_BilinearInterpolation&f=image"
    )
    for attempt in range(4):
        try:
            with urllib.request.urlopen(USGS + q, timeout=180) as r:
                data = r.read()
            with rasterio.MemoryFile(data) as m, m.open() as d:
                a = d.read(1).astype(np.float32)
                nd = d.nodata
            if nd is not None:
                a[a == nd] = NODATA
            a[(a < -1000) | (a > 9000)] = NODATA
            _save(out, a, "EPSG:26917", from_origin(x0, y1, 1.0, 1.0))
            return out
        except Exception as e:
            if attempt == 3:
                raise
            print(f"  usgs {tx},{ty} retry: {e}", flush=True)
            time.sleep(5 * (attempt + 1))
    return None


def _sample(path: Path, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    """Bilinear sample of a cached raster at world coords; NaN where no data."""
    import rasterio
    from pyproj import Transformer
    from scipy import ndimage

    with rasterio.open(path) as d:
        a = d.read(1).astype(np.float32)
        inv = ~d.transform
        crs = d.crs.to_string()
    t = Transformer.from_crs(geo.PROJ, crs, always_xy=True)
    X, Y = t.transform(xs.ravel(), ys.ravel())
    c, r = inv * (np.asarray(X), np.asarray(Y))
    bad = a <= NODATA + 1
    a[bad] = 0.0
    v = ndimage.map_coordinates(a, [r - 0.5, c - 0.5], order=1, mode="nearest", prefilter=False)
    m = ndimage.map_coordinates((~bad).astype(np.float32), [r - 0.5, c - 0.5], order=1, mode="nearest", prefilter=False)
    v[m < 0.999] = np.nan
    return v.reshape(xs.shape)


def build_tile(tx: int, ty: int, res: float, usgs_dz: float, out_dir: Path) -> dict:
    t0 = time.time()
    n = int(round(S / res)) + 1
    t = np.arange(n) * res
    gx, gy = np.meshgrid(tx * S + t, ty * S + t)
    dtm_p = fetch_hrdem(tx, ty, "dtm")
    dsm_p = fetch_hrdem(tx, ty, "dsm")
    dtm = _sample(dtm_p, gx, gy)  # ASL CGVD2013
    src = np.where(np.isfinite(dtm), 1, 0).astype(np.uint8)
    if _in_ny(tx, ty) and not np.isfinite(dtm).all():
        us = _sample(fetch_usgs(tx, ty), gx, gy) + usgs_dz
        fill = ~np.isfinite(dtm) & np.isfinite(us)
        dtm[fill] = us[fill]
        src[fill] = 2
    miss = ~np.isfinite(dtm)
    if miss.any():  # no lidar (open lake, outside coverage): Copernicus terrain
        from . import terrain

        dtm[miss] = terrain.get().sample(gx[miss], gy[miss]) + geo.DATUM_M
    dsm = _sample(dsm_p, gx, gy)
    ndsm = np.where(np.isfinite(dsm) & (src == 1), np.clip(dsm - dtm, 0, 6000), 0)

    h = dtm - geo.DATUM_M  # world datum metres
    base = float(math.floor(np.min(h)))
    cm = np.round((h - base) * 100)
    assert cm.max() < 32767, (tx, ty, base, h.max())
    step = int(round(8 / res))
    src8 = src[::step, ::step]
    cov = float((src > 0).mean())
    size = tbn.write(
        out_dir / f"{tx}_{ty}.bin.gz",
        {"dtm": cm.astype(np.int16).ravel(), "ndsm": np.round(ndsm * 10).astype(np.uint16).ravel(),
         "src": src8.ravel()},
        level=6, base_m=base, res=res, n=n, n8=int(src8.shape[0]), units={"dtm": "cm", "ndsm": "dm"},
        vdatum="CGVD2013", datum=geo.DATUM_M, usgs_dz=usgs_dz, lidar=round(cov, 4),
    )
    return {"tile": [tx, ty], "bytes": size, "lidar": cov, "base": base, "max": float(h.max()), "sec": round(time.time() - t0, 1)}


def _job(args):
    tx, ty, res, dz, out = args
    try:
        return build_tile(tx, ty, res, dz, Path(out))
    except Exception as e:
        return {"tile": [tx, ty], "error": repr(e)}


def mask_tiles(buffer_m: float = 1500.0, dense_bytes: int = 46000) -> list[tuple[int, int]]:
    """Level-0 tiles within `buffer_m` of dense tiles (render tile size above
    the 75th percentile) or of any rail / subway / LRT track (rail graph)."""
    from scipy import ndimage

    man = json.loads((DATA / "manifest.json").read_text())
    tiles = [tuple(t) for t in man["tiles"]["0"]]
    txs = np.array([t[0] for t in tiles])
    tys = np.array([t[1] for t in tiles])
    ox, oy = txs.min(), tys.min()
    grid = np.zeros((tys.max() - oy + 1, txs.max() - ox + 1), bool)
    for tx, ty in tiles:
        p = DATA / "tiles" / "0" / f"{tx}_{ty}.bin.gz"
        if p.exists() and p.stat().st_size >= dense_bytes:
            grid[ty - oy, tx - ox] = True
    net, _ = tbn.read(DATA / "rail" / "network.bin.gz")
    xyz = net["e_xyz"].reshape(-1, 3)
    rx = np.floor(xyz[:, 0] / S).astype(int) - ox
    ry = np.floor(xyz[:, 1] / S).astype(int) - oy
    ok = (rx >= 0) & (ry >= 0) & (rx < grid.shape[1]) & (ry < grid.shape[0])
    grid[ry[ok], rx[ok]] = True
    r = int(math.ceil(buffer_m / S))
    yy, xx = np.mgrid[-r : r + 1, -r : r + 1]
    grid = ndimage.binary_dilation(grid, structure=(xx**2 + yy**2) <= (r + 0.5) ** 2)
    return [(tx, ty) for tx, ty in tiles if grid[ty - oy, tx - ox]]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--area", choices=[*AREAS, "mask", "full"], default=None)
    ap.add_argument("--tiles", nargs="*", default=[])
    ap.add_argument("--res", type=float, default=1.0)
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--usgs-dz", type=float, default=None, help="NAVD88 -> CGVD2013 shift (m); default measured")
    ap.add_argument("--fetch-only", action="store_true")
    a = ap.parse_args()
    tiles = [tuple(int(v) for v in s.split(",")) for s in a.tiles]
    if a.area in AREAS:
        tiles += AREAS[a.area]
    elif a.area == "mask":
        tiles += mask_tiles()
    elif a.area == "full":
        tiles += [tuple(t) for t in json.loads((DATA / "manifest.json").read_text())["tiles"]["0"]]
    man = {tuple(t) for t in json.loads((DATA / "manifest.json").read_text())["tiles"]["0"]}
    tiles = [t for t in dict.fromkeys(tiles) if t in man]
    print(f"{len(tiles)} tiles, res {a.res} m, {a.workers} workers", flush=True)
    out = geo.OUT / "dtm"
    out.mkdir(parents=True, exist_ok=True)
    dz = a.usgs_dz
    if dz is None:
        dz_file = RAW / "usgs_dz.json"
        dz = json.loads(dz_file.read_text())["dz"] if dz_file.exists() else 0.0
    if a.fetch_only:
        with ProcessPoolExecutor(a.workers) as ex:
            list(ex.map(fetch_hrdem, [t[0] for t in tiles] * 2, [t[1] for t in tiles] * 2, ["dtm"] * len(tiles) + ["dsm"] * len(tiles)))
        return
    log = []
    total = 0
    with ProcessPoolExecutor(a.workers) as ex:
        for i, r in enumerate(ex.map(_job, [(tx, ty, a.res, dz, str(out)) for tx, ty in tiles])):
            log.append(r)
            total += r.get("bytes", 0)
            if "error" in r or i % 10 == 0:
                print(f"[{i + 1}/{len(tiles)}] {r}", flush=True)
    (out / "_log.json").write_text(json.dumps(log))
    raw = sum(f.stat().st_size for f in RAW.rglob("*.tif"))
    print(f"done: {len(tiles)} tiles, product {total / 1e6:.1f} MB, raw cache {raw / 1e6:.1f} MB", flush=True)


if __name__ == "__main__":
    main()
