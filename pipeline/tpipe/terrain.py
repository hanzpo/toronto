"""Terrain: Copernicus GLO-30 DSM reprojected to the world grid.

The DSM includes buildings and tree canopy, so we apply a morphological
opening (removes raised features narrower than ~200 m such as towers and
tree rows, but keeps ravines and valleys) followed by a light blur.

The result is cached as an int16 decimetre grid in pipeline/work/terrain.npz.
"""

from __future__ import annotations

import glob
import math
from functools import lru_cache

import numpy as np

from . import geo

CELL = 30.0  # metres


def build() -> None:
    import rasterio
    from rasterio.merge import merge
    from scipy import ndimage

    files = sorted(glob.glob(str(geo.RAW / "dem" / "*.tif")))
    srcs = [rasterio.open(f) for f in files]
    mosaic, transform = merge(srcs)
    dem = mosaic[0].astype(np.float32)
    inv = ~transform

    x0, y0, x1, y1 = geo.projected_bbox()
    x0 = math.floor(x0 / CELL) * CELL
    y0 = math.floor(y0 / CELL) * CELL
    nx = int(math.ceil((x1 - x0) / CELL)) + 1
    ny = int(math.ceil((y1 - y0) / CELL)) + 1
    print(f"terrain grid {nx}x{ny}")

    out = np.empty((ny, nx), dtype=np.float32)
    xs = x0 + np.arange(nx) * CELL
    for j in range(ny):  # row by row keeps memory flat
        lon, lat = geo.unproject(xs, np.full(nx, y0 + j * CELL))
        col, row = inv * (np.asarray(lon), np.asarray(lat))
        out[j] = ndimage.map_coordinates(dem, [row - 0.5, col - 0.5], order=1, mode="nearest")

    dsm = out.copy()  # raw surface model (incl. buildings) for height estimates
    out = ndimage.grey_opening(out, size=(7, 7))
    out = ndimage.gaussian_filter(out, sigma=1.0)
    out -= geo.DATUM_M
    geo.WORK.mkdir(parents=True, exist_ok=True)
    np.savez(geo.WORK / "terrain.npz", h=np.round(out * 10).astype(np.int16), x0=x0, y0=y0, cell=CELL)
    np.save(geo.WORK / "dsm.npy", np.round((dsm - geo.DATUM_M) * 10).astype(np.int16))


class Terrain:
    def __init__(self) -> None:
        d = np.load(geo.WORK / "terrain.npz")
        self.h = d["h"].astype(np.float32) / 10.0
        self.x0 = float(d["x0"])
        self.y0 = float(d["y0"])
        self.cell = float(d["cell"])

    def sample(self, x, y):
        """Bilinear elevation (world datum, metres) at projected coords."""
        from scipy import ndimage

        x = np.asarray(x, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)
        c = (x - self.x0) / self.cell
        r = (y - self.y0) / self.cell
        return ndimage.map_coordinates(self.h, [r.ravel(), c.ravel()], order=1, mode="nearest").reshape(x.shape)

    def grid(self, x0: float, y0: float, size: float, n: int) -> np.ndarray:
        """n x n samples covering [x0, x0+size] x [y0, y0+size], row 0 = south."""
        t = np.linspace(0.0, size, n)
        gx, gy = np.meshgrid(x0 + t, y0 + t)
        return self.sample(gx, gy)


def sample_dsm(t: Terrain, x, y):
    """Raw DSM (surface incl. buildings/trees), datum metres."""
    from scipy import ndimage

    if not hasattr(t, "dsm"):
        t.dsm = np.load(geo.WORK / "dsm.npy", mmap_mode="r").astype(np.float32) / 10.0
    c = (np.asarray(x) - t.x0) / t.cell
    r = (np.asarray(y) - t.y0) / t.cell
    return ndimage.map_coordinates(t.dsm, [r.ravel(), c.ravel()], order=1, mode="nearest").reshape(np.shape(x))


@lru_cache(maxsize=1)
def get() -> Terrain:
    return Terrain()


if __name__ == "__main__":
    build()
