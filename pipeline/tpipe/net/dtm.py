"""Bare-earth heights for the mapping stage: the cached 1 m LiDAR DTM per level-0 tile, falling
back to the Copernicus terrain where there is no LiDAR. Both are sampled bilinearly without
copying the rasters: the LiDAR tiles are kept as float32 (NaN = no data) in a small LRU, the
Copernicus grid as an int16 memory map."""

from __future__ import annotations

from collections import OrderedDict
from pathlib import Path

import numpy as np

from .. import geo
from ..src_lidar import NODATA, RAW, fetch_hrdem

S = geo.TILE_SIZE[0]


def _bilinear(a: np.ndarray, r: np.ndarray, c: np.ndarray) -> np.ndarray:
    h, w = a.shape
    r = np.clip(r, 0.0, h - 1.0)
    c = np.clip(c, 0.0, w - 1.0)
    r0 = np.minimum(np.floor(r).astype(np.intp), h - 2)
    c0 = np.minimum(np.floor(c).astype(np.intp), w - 2)
    fr = (r - r0).astype(np.float32)
    fc = (c - c0).astype(np.float32)
    v00 = a[r0, c0].astype(np.float32)
    v01 = a[r0, c0 + 1].astype(np.float32)
    v10 = a[r0 + 1, c0].astype(np.float32)
    v11 = a[r0 + 1, c0 + 1].astype(np.float32)
    return (v00 * (1 - fc) + v01 * fc) * (1 - fr) + (v10 * (1 - fc) + v11 * fc) * fr


class Coarse:
    def __init__(self) -> None:
        npy = geo.WORK / "net" / "terrain_h.npy"
        src = geo.WORK / "terrain.npz"
        meta = geo.WORK / "net" / "terrain_meta.npy"
        if not npy.exists() or npy.stat().st_mtime < src.stat().st_mtime:
            npy.parent.mkdir(parents=True, exist_ok=True)
            with np.load(src) as d:
                h = d["h"]
                m = np.array([float(d["x0"]), float(d["y0"]), float(d["cell"])])
            tmp = npy.with_suffix(".part.npy")
            np.save(tmp, h)
            del h
            tmp.replace(npy)
            np.save(meta, m)
        self.h = np.load(npy, mmap_mode="r")
        self.x0, self.y0, self.cell = (float(v) for v in np.load(meta))

    def sample(self, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        return _bilinear(self.h, (ys - self.y0) / self.cell, (xs - self.x0) / self.cell) / 10.0


class Dtm:
    def __init__(self, fetch: bool = False, keep: int = 24) -> None:
        self.tiles: OrderedDict[tuple[int, int], tuple[np.ndarray, object, object] | None] = OrderedDict()
        self.fetch = fetch
        self.keep = keep
        self.coarse = Coarse()

    def has_lidar(self, tx: int, ty: int) -> bool:
        return self._path(tx, ty) is not None

    def _path(self, tx: int, ty: int) -> Path | None:
        p = RAW / "hrdem_dtm" / f"{tx}_{ty}.tif"
        if p.exists():
            return p
        return fetch_hrdem(tx, ty, "dtm") if self.fetch else None

    def _tile(self, tx: int, ty: int) -> tuple[np.ndarray, object, object] | None:
        key = (tx, ty)
        if key in self.tiles:
            self.tiles.move_to_end(key)
            return self.tiles[key]
        path = self._path(tx, ty)
        t = None
        if path is not None:
            import rasterio
            from pyproj import Transformer

            with rasterio.open(path) as d:
                a = d.read(1, out_dtype=np.float32)
                inv = ~d.transform
                crs = d.crs.to_string()
            a[a <= NODATA + 1] = np.nan
            t = (a, inv, Transformer.from_crs(geo.PROJ, crs, always_xy=True))
        self.tiles[key] = t
        while sum(v is not None for v in self.tiles.values()) > self.keep:
            for k, v in self.tiles.items():
                if v is not None:
                    del self.tiles[k]
                    break
        return t

    def sample(self, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        xs = np.asarray(xs, dtype=np.float64).ravel()
        ys = np.asarray(ys, dtype=np.float64).ravel()
        out = np.full(xs.shape, np.nan, dtype=np.float64)
        tx = np.floor(xs / S).astype(np.int64)
        ty = np.floor(ys / S).astype(np.int64)
        code = (tx + (1 << 20)) * (1 << 21) + (ty + (1 << 20))
        for k in np.unique(code):
            m = code == k
            key = (int(tx[m][0]), int(ty[m][0]))
            t = self._tile(*key)
            if t is None:
                continue
            a, inv, tr = t
            X, Y = tr.transform(xs[m], ys[m])  # type: ignore[attr-defined]
            c, r = inv * (np.asarray(X), np.asarray(Y))  # type: ignore[operator]
            out[m] = _bilinear(a, np.asarray(r) - 0.5, np.asarray(c) - 0.5) - geo.DATUM_M
        miss = ~np.isfinite(out)
        if miss.any():
            out[miss] = self.coarse.sample(xs[miss], ys[miss])
        return out
