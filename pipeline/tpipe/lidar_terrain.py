"""Terrain for the network model's vertical solve: the NRCan HRDEM 1 m bare-earth DTM where it is
cached (pipeline/raw/lidar/hrdem_dtm/{tx}_{ty}.tif, tpipe.src_lidar), the 30 m terrain.npz
elsewhere. Same interface as tpipe.terrain.Terrain (sample, grid, and the attributes
sample_dsm reads), plus `source(x, y)` -> per-sample source code and a per-tile usage log.

Source codes: 1 = HRDEM DTM (1 m lidar), 0 = terrain.npz (30 m fallback: no cached HRDEM tile,
a no-data cell inside one, or a DTM void -- below VOID, -1 m datum, under the lake surface:
no-return patches the DTM filled, e.g. under wide decks or parked trains; counted as 'void').
Heights are world datum (ASL - 75 m), as src_lidar's products.

    TPIPE_TERRAIN=terrain   disables the lidar (the old 30 m behaviour)
"""
from __future__ import annotations

import math
import os
from collections import defaultdict
from functools import lru_cache

import numpy as np

from . import geo
from .terrain import get as get_coarse

SRC_HRDEM = 1
SRC_COARSE = 0
DATUM = 75.0
NODATA = -32767.0
VOID = -1.0


class LidarTerrain:
    def __init__(self) -> None:
        self.coarse = get_coarse()
        # sample_dsm reads these from the terrain object
        self.h, self.x0, self.y0, self.cell = self.coarse.h, self.coarse.x0, self.coarse.y0, self.coarse.cell
        self.dir = geo.RAW / "lidar" / "hrdem_dtm"
        self.dsm_dir = geo.RAW / "lidar" / "hrdem_dsm"
        self.enabled = os.environ.get("TPIPE_TERRAIN", "lidar") != "terrain" and self.dir.exists()
        self._tiles: dict = {}
        self._dtiles: dict = {}
        self.log = defaultdict(lambda: [0, 0])      # tile -> [coarse samples, hrdem samples]
        self.voids = 0

    def _tile(self, tx: int, ty: int, dsm: bool = False):
        k = (tx, ty)
        cache, d_ = (self._dtiles, self.dsm_dir) if dsm else (self._tiles, self.dir)
        if k not in cache:
            p = d_ / f"{tx}_{ty}.tif"
            if not p.exists():
                cache[k] = None
            else:
                import rasterio
                from pyproj import Transformer
                with rasterio.open(p) as d:
                    a = d.read(1).astype(np.float32)
                    inv = ~d.transform
                    crs = d.crs.to_string()
                cache[k] = (a, inv, Transformer.from_crs(geo.PROJ, crs, always_xy=True))
        return cache[k]

    def _hrdem(self, x: np.ndarray, y: np.ndarray, dsm: bool = False) -> np.ndarray:
        from scipy import ndimage
        out = np.full(x.shape, np.nan)
        if not self.enabled or not x.size:
            return out
        S = geo.TILE_SIZE[0]
        tx = np.floor(x / S).astype(np.int64)
        ty = np.floor(y / S).astype(np.int64)
        for k in set(zip(tx.tolist(), ty.tolist())):
            T = self._tile(*k, dsm=dsm)
            if T is None:
                continue
            a, inv, tr = T
            m = (tx == k[0]) & (ty == k[1])
            X, Y = tr.transform(x[m], y[m])
            c, r = inv * (np.asarray(X), np.asarray(Y))
            v = ndimage.map_coordinates(a, [np.asarray(r) - 0.5, np.asarray(c) - 0.5], order=1, mode="nearest", prefilter=False)
            nd = ndimage.map_coordinates((a > NODATA + 1).astype(np.float32), [np.asarray(r) - 0.5, np.asarray(c) - 0.5],
                                         order=1, mode="nearest", prefilter=False)
            v = v.astype(np.float64) - DATUM
            v[nd < 0.999] = np.nan
            out[m] = v
        return out

    def sample_src(self, x, y):
        """(heights, source codes) at projected coords"""
        x = np.asarray(x, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)
        shp = x.shape
        xr, yr = x.ravel(), y.ravel()
        h = self._hrdem(xr, yr)
        void = np.isfinite(h) & (h < VOID)
        h[void] = np.nan
        src = np.where(np.isfinite(h), SRC_HRDEM, SRC_COARSE).astype(np.uint8)
        miss = ~np.isfinite(h)
        if miss.any():
            h[miss] = self.coarse.sample(xr[miss], yr[miss])
        S = geo.TILE_SIZE[0]
        tk = np.floor(xr / S).astype(np.int64) * 100003 + np.floor(yr / S).astype(np.int64)
        for key, cnt_c, cnt_h in _count(tk, src):
            L = self.log[key]
            L[0] += cnt_c; L[1] += cnt_h
        self.voids += int(void.sum())
        return h.reshape(shp), src.reshape(shp)

    def sample(self, x, y):
        return self.sample_src(x, y)[0]

    def dsm(self, x, y):
        """first-return surface (decks, buildings, canopy): HRDEM 1 m DSM, the median of a 5-point
        cross 1.5 m wide (cars and single returns don't count), else the 30 m dsm.npy"""
        from .terrain import sample_dsm
        x = np.asarray(x, dtype=np.float64).ravel()
        y = np.asarray(y, dtype=np.float64).ravel()
        o = np.array([[0, 0], [1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5]])
        X = (x[:, None] + o[None, :, 0]).ravel()
        Y = (y[:, None] + o[None, :, 1]).ravel()
        h = self._hrdem(X, Y, dsm=True).reshape(len(x), 5)
        with np.errstate(all="ignore"):
            out = np.nanmedian(np.where(np.isfinite(h), h, np.nan), axis=1)
        miss = ~np.isfinite(out)
        if miss.any():
            out[miss] = sample_dsm(self.coarse, x[miss], y[miss])
        return out

    def source(self, x, y):
        return self.sample_src(x, y)[1]

    def grid(self, x0: float, y0: float, size: float, n: int) -> np.ndarray:
        t = np.linspace(0.0, size, n)
        gx, gy = np.meshgrid(x0 + t, y0 + t)
        return self.sample(gx, gy)

    def report(self) -> dict:
        """per level-0 tile: samples from each source (logged in roadnet_report.json)"""
        out = {}
        for key, (c, h) in sorted(self.log.items()):
            tx = int(round(key / 100003))
            ty = int(key - tx * 100003)
            out[f"{tx}_{ty}"] = {"hrdem_dtm_1m": int(h), "terrain_npz_30m": int(c)}
        tot_h = sum(v["hrdem_dtm_1m"] for v in out.values())
        tot_c = sum(v["terrain_npz_30m"] for v in out.values())
        return {"enabled": self.enabled, "samples_hrdem": tot_h, "samples_fallback": tot_c, "samples_void": self.voids, "per_tile": out}


def _count(tk, src):
    if not len(tk):
        return []
    u, inv = np.unique(tk, return_inverse=True)
    h = np.bincount(inv, weights=(src == SRC_HRDEM), minlength=len(u))
    n = np.bincount(inv, minlength=len(u))
    return [(int(k), int(n_ - h_), int(h_)) for k, n_, h_ in zip(u, n, h)]


@lru_cache(maxsize=1)
def get() -> LidarTerrain:
    return LidarTerrain()


class GridTerrain:
    """a precomputed 1 m grid (from `python -m tpipe.lidar_terrain --grid`), sampled bilinearly --
    for processes that also load pyogrio (its GDAL and rasterio's must not meet in one process)"""

    def __init__(self, path):
        d = np.load(path)
        self.h, self.src = d["h"], d["src"]
        self.x0, self.y0, self.cell = float(d["x0"]), float(d["y0"]), float(d["cell"])

    def sample(self, x, y):
        from scipy import ndimage
        x = np.asarray(x, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)
        c = (x - self.x0) / self.cell
        r = (y - self.y0) / self.cell
        return ndimage.map_coordinates(self.h, [r.ravel(), c.ravel()], order=1, mode="nearest").reshape(x.shape)


def write_grid(bbox, path, cell=1.0, pad=40.0):
    x0, y0, x1, y1 = bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad
    xs = np.arange(x0, x1 + cell, cell)
    ys = np.arange(y0, y1 + cell, cell)
    gx, gy = np.meshgrid(xs, ys)
    h, src = get().sample_src(gx, gy)
    np.savez_compressed(path, h=h.astype(np.float32), src=src, x0=x0, y0=y0, cell=cell)


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--grid", required=True, help="E0,N0,E1,N1")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    write_grid(tuple(float(v) for v in a.grid.split(",")), a.out)
