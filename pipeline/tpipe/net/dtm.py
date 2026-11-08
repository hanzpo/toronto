"""Bare-earth heights for the mapping stage: the cached 1 m LiDAR DTM per level-0 tile, falling
back to the Copernicus terrain where there is no LiDAR."""

from __future__ import annotations

import numpy as np

from .. import geo, terrain
from ..src_lidar import NODATA, fetch_hrdem

S = geo.TILE_SIZE[0]


class Dtm:
    def __init__(self, fetch: bool = True) -> None:
        self.tiles: dict[tuple[int, int], tuple[np.ndarray, object, object] | None] = {}
        self.fetch = fetch
        self.coarse = terrain.get()

    def _tile(self, tx: int, ty: int) -> tuple[np.ndarray, object, object] | None:
        key = (tx, ty)
        if key in self.tiles:
            return self.tiles[key]
        import rasterio
        from pyproj import Transformer

        path = fetch_hrdem(tx, ty, "dtm") if self.fetch else None
        if path is None or not path.exists():
            self.tiles[key] = None
            return None
        with rasterio.open(path) as d:
            a = d.read(1).astype(np.float32)
            inv = ~d.transform
            crs = d.crs.to_string()
        a[a <= NODATA + 1] = np.nan
        self.tiles[key] = (a, inv, Transformer.from_crs(geo.PROJ, crs, always_xy=True))
        return self.tiles[key]

    def sample(self, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        from scipy import ndimage

        xs = np.asarray(xs, dtype=np.float64).ravel()
        ys = np.asarray(ys, dtype=np.float64).ravel()
        out = np.full(xs.shape, np.nan, dtype=np.float64)
        tx = np.floor(xs / S).astype(int)
        ty = np.floor(ys / S).astype(int)
        for key in set(zip(tx.tolist(), ty.tolist())):
            m = (tx == key[0]) & (ty == key[1])
            t = self._tile(*key)
            if t is None:
                continue
            a, inv, tr = t
            X, Y = tr.transform(xs[m], ys[m])  # type: ignore[attr-defined]
            c, r = inv * (np.asarray(X), np.asarray(Y))  # type: ignore[operator]
            filled = np.nan_to_num(a, nan=0.0)
            v = ndimage.map_coordinates(filled, [r - 0.5, c - 0.5], order=1, mode="nearest", prefilter=False)
            ok = ndimage.map_coordinates(np.isfinite(a).astype(np.float32), [r - 0.5, c - 0.5], order=1, mode="nearest", prefilter=False)
            v[ok < 0.999] = np.nan
            out[m] = v - geo.DATUM_M
        miss = ~np.isfinite(out)
        if miss.any():
            out[miss] = self.coarse.sample(xs[miss], ys[miss])
        return out
