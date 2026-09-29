"""Region-wide major-road geometry for the congestion overlay (statistical tier).

Collects every class 0-2 edge (motorway, trunk, primary) from the tiled road
graph, simplifies its polyline and writes one file the client colours by the
time-of-day demand model. Segment ids are the index in this file (stable for
a given graph build); each segment also records the graph tile + edge index
it came from so live agent speeds can be blended in.

    uv run python -m tpipe.congestion
Output: data/congestion/majors.bin.gz (TBN1)
    s_off u32 [n+1] · s_xyz f32 [3·nV] absolute world (E, N, elev datum)
    s_class u8 · s_flags u8 (road flags) · s_lanes u8 (fwd lanes)
    s_oneway u8 · s_len f32 m · s_name u16 (header `names`, 0xFFFF none)
    s_tile i32 [2n] (tx, ty of the graph tile) · s_edge u32 (edge index there)
"""

from __future__ import annotations

import time

import numpy as np

from . import geo, tbn

MAX_CLASS = 2
TOLERANCE = 6.0  # m, Douglas-Peucker


def _rdp(p: np.ndarray, tol: float) -> np.ndarray:
    """Douglas-Peucker on an (n, 3) polyline using the planar distance."""
    n = len(p)
    if n <= 2:
        return np.arange(n)
    keep = np.zeros(n, dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        d = p[b, :2] - p[a, :2]
        L = float(np.hypot(*d))
        q = p[a + 1 : b, :2] - p[a, :2]
        dist = np.abs(q[:, 0] * d[1] - q[:, 1] * d[0]) / L if L > 1e-9 else np.hypot(q[:, 0], q[:, 1])
        k = int(np.argmax(dist))
        if dist[k] > tol:
            m = a + 1 + k
            keep[m] = True
            stack.append((a, m))
            stack.append((m, b))
    return np.nonzero(keep)[0]


def main() -> None:
    t0 = time.time()
    src = geo.OUT / "graph"
    S0 = geo.TILE_SIZE[0]
    pts: list[np.ndarray] = []
    cls, flg, lanes, oneway, length, name, tile, edge = [], [], [], [], [], [], [], []
    names: list[str] = []
    name_idx: dict[str, int] = {}
    files = sorted(src.glob("*.bin.gz"))
    for i, f in enumerate(files):
        a, h = tbn.read(f)
        sel = np.nonzero(a["e_class"] <= MAX_CLASS)[0]
        if not len(sel):
            continue
        tx, ty = int(h["tx"]), int(h["ty"])
        x0, y0 = tx * S0, ty * S0
        off = a["e_off"]
        xyz = a["e_xyz"].reshape(-1, 3)
        tnames = h.get("names", [])
        for e in sel:
            p = xyz[off[e] : off[e + 1]].astype(np.float64)
            p[:, 0] += x0
            p[:, 1] += y0
            p = p[_rdp(p, TOLERANCE)]
            pts.append(p.astype(np.float32))
            cls.append(a["e_class"][e])
            flg.append(a["e_flags"][e])
            lanes.append(a["e_lanes_fwd"][e])
            oneway.append(1 if a["e_lanes_bwd"][e] == 0 else 0)
            length.append(a["e_len"][e])
            nm = int(a["e_name"][e])
            if nm != 0xFFFF:
                s = tnames[nm]
                if s not in name_idx:
                    name_idx[s] = len(names)
                    names.append(s)
                name.append(name_idx[s])
            else:
                name.append(0xFFFF)
            tile.append((tx, ty))
            edge.append(e)
        if i % 5000 == 0:
            print(f"  {i:,}/{len(files):,} tiles, {len(pts):,} segments ({time.time() - t0:.0f}s)", flush=True)
    counts = np.array([len(p) for p in pts], dtype=np.int64)
    s_off = np.zeros(len(pts) + 1, dtype=np.uint32)
    np.cumsum(counts, out=s_off[1:])
    arrays = {
        "s_off": s_off,
        "s_xyz": np.concatenate(pts).ravel(),
        "s_class": np.array(cls, dtype=np.uint8),
        "s_flags": np.array(flg, dtype=np.uint8),
        "s_lanes": np.array(lanes, dtype=np.uint8),
        "s_oneway": np.array(oneway, dtype=np.uint8),
        "s_len": np.array(length, dtype=np.float32),
        "s_name": np.array(name, dtype=np.uint16),
        "s_tile": np.array(tile, dtype=np.int32).ravel(),
        "s_edge": np.array(edge, dtype=np.uint32),
    }
    n = tbn.write(geo.OUT / "congestion" / "majors.bin.gz", arrays, level=9, names=names)
    print(f"wrote {len(pts):,} segments, {int(s_off[-1]):,} vertices, {n / 1e6:.1f} MB in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
