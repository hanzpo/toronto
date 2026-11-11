"""Read-only access to the built data for the QA checks.

Everything is converted to absolute world coordinates (E, N metres; z datum
metres). The region is processed in *blocks* of 4x4 level-0 tiles (one level-1
tile) plus a one-tile halo, so checks see features that cross tile borders.
A finding belongs to the block whose core contains its location, so every
finding is reported exactly once.

Roads and rail are the network model's, from the far level-0 tiles (net/far/0, app/scripts/net-bake.mjs):
the segments' centrelines with their solved z, carriageway width, class (the asset's rank) and per-vertex
bridge / tunnel flags, clipped to each tile. A segment belongs to the tile containing its midpoint
(``own``). Missing arrays are tolerated everywhere (empty structures).
"""

from __future__ import annotations

import functools
import json
import math
import re
from dataclasses import dataclass, field

import numpy as np

from .. import geo, tbn

S0 = geo.TILE_SIZE[0]
G0 = geo.TERRAIN_GRID[0]
GR = geo.GROUND_RES
BLOCK = 4  # level-0 tiles per block side (= one level-1 tile)
HALO = 1  # tiles of context around a block

TILES = geo.OUT / "tiles" / "0"
FAR = geo.OUT / "net" / "far" / "0"
OLD_STREET = re.compile(r"^(r|l|xr|xl|j|js|jw|jc|jt|sg|md|k)_")

# piece flags (net/bake.ts)
F_ONEWAY, F_BRIDGE, F_TUNNEL = 1, 2, 4


def manifest() -> dict:
    return json.loads((geo.OUT / "manifest.json").read_text())


@dataclass
class Lines:
    """Polylines (road or rail pieces) in world coordinates."""

    off: np.ndarray  # [P+1] vertex offsets
    X: np.ndarray
    Y: np.ndarray
    Z: np.ndarray
    attrs: dict[str, np.ndarray]  # per piece
    tile: np.ndarray  # per piece: index into Block.tiles
    vattrs: dict[str, np.ndarray] = field(default_factory=dict)  # per vertex (NaN where a tile lacks the array)
    # derived
    ZD: np.ndarray = field(default=None)  # per vertex: elevation as drawn (Block._drawn_z)
    seg: np.ndarray = field(default=None)  # vertex index of owned segment starts
    seg_piece: np.ndarray = field(default=None)

    @property
    def n(self) -> int:
        return len(self.off) - 1

    def vpiece(self) -> np.ndarray:
        return np.repeat(np.arange(self.n), np.diff(self.off))


def _empty_lines(names, vnames=()) -> Lines:
    return Lines(np.zeros(1, np.int64), np.zeros(0), np.zeros(0), np.zeros(0),
                 {k: np.zeros(0) for k in names}, np.zeros(0, np.int64), vattrs={k: np.zeros(0) for k in vnames})


@functools.lru_cache(maxsize=48)
def load_tile(tx: int, ty: int) -> dict | None:
    p = TILES / f"{tx}_{ty}.bin.gz"
    if not p.exists():
        return None
    a, h = tbn.read(p)
    a = {k: v for k, v in a.items() if not OLD_STREET.match(k)}
    a["_names"] = []
    f = FAR / f"{tx}_{ty}.bin.gz"
    if f.exists():
        far, fh = tbn.read(f)
        a.update(far)
        a["_names"] = fh.get("names", [])
    return a


class Block:
    """Core tiles [x0, x0+4) x [y0, y0+4) plus halo, merged into world arrays."""

    def __init__(self, bx: int, by: int, tileset: set, halo: int = HALO, block: int = BLOCK):
        self.bx, self.by = bx, by
        self.cx0, self.cy0 = bx * block, by * block
        self.core = (self.cx0 * S0, self.cy0 * S0, (self.cx0 + block) * S0, (self.cy0 + block) * S0)
        self.tx0, self.ty0 = self.cx0 - halo, self.cy0 - halo
        self.nt = block + 2 * halo
        self.tiles: list[tuple[int, int]] = []
        self.data: list[dict] = []
        for ty in range(self.ty0, self.ty0 + self.nt):
            for tx in range(self.tx0, self.tx0 + self.nt):
                if (tx, ty) in tileset:
                    d = load_tile(tx, ty)
                    if d is not None:
                        self.tiles.append((tx, ty))
                        self.data.append(d)
        self._terrain()
        self._ground()
        self.nbuilt = np.array([
            (len(d.get("b_ring_off", [0])) - 1) + len(d.get("h_xy", [])) // 2 for d in self.data], dtype=np.int64)
        self.roads = self._lines("r", ["class", "width", "lanes", "flags", "name", "osm"], ["vf", "dz"])
        if self.roads.n:
            self.roads.attrs["w"] = self.roads.attrs["width"]
        self.rails = self._lines("l", ["class", "flags", "osm"], ["vf", "dz"])
        self._points()

    # ------------------------------------------------------------------ helpers
    def in_core(self, x, y) -> np.ndarray:
        x0, y0, x1, y1 = self.core
        x = np.asarray(x)
        y = np.asarray(y)
        return (x >= x0) & (x < x1) & (y >= y0) & (y < y1)

    def origin(self, i: int) -> tuple[float, float]:
        tx, ty = self.tiles[i]
        return tx * S0, ty * S0

    # ------------------------------------------------------------------ terrain / ground
    def _terrain(self) -> None:
        n = self.nt * (G0 - 1) + 1
        self.th = np.full((n, n), np.nan, dtype=np.float64)
        for (tx, ty), d in zip(self.tiles, self.data):
            h = d.get("terrain_h")
            if h is None or len(h) != G0 * G0:
                continue
            i0 = (tx - self.tx0) * (G0 - 1)
            j0 = (ty - self.ty0) * (G0 - 1)
            self.th[j0:j0 + G0, i0:i0 + G0] = h.reshape(G0, G0) / 10.0
        self.cell = S0 / (G0 - 1)

    def terrain(self, x, y) -> np.ndarray:
        """Bilinear terrain elevation (datum m); NaN outside loaded tiles."""
        gx = (np.asarray(x, np.float64) - self.tx0 * S0) / self.cell
        gy = (np.asarray(y, np.float64) - self.ty0 * S0) / self.cell
        n = self.th.shape[0]
        i = np.clip(np.floor(gx).astype(np.int64), 0, n - 2)
        j = np.clip(np.floor(gy).astype(np.int64), 0, n - 2)
        u = np.clip(gx - i, 0, 1)
        v = np.clip(gy - j, 0, 1)
        t = self.th
        z = (t[j, i] * (1 - u) + t[j, i + 1] * u) * (1 - v) + (t[j + 1, i] * (1 - u) + t[j + 1, i + 1] * u) * v
        out = (gx < 0) | (gy < 0) | (gx > n - 1) | (gy > n - 1)
        return np.where(out, np.nan, z)

    def _ground(self) -> None:
        n = self.nt * GR
        self.gr = np.full((n, n), 255, dtype=np.uint8)
        for (tx, ty), d in zip(self.tiles, self.data):
            g = d.get("ground")
            if g is None or len(g) != GR * GR:
                continue
            i0 = (tx - self.tx0) * GR
            j0 = (ty - self.ty0) * GR
            self.gr[j0:j0 + GR, i0:i0 + GR] = g.reshape(GR, GR)
        self.px = S0 / GR

    def ground(self, x, y) -> np.ndarray:
        """Land-cover class at world points (255 = no data)."""
        i = np.floor((np.asarray(x, np.float64) - self.tx0 * S0) / self.px).astype(np.int64)
        j = np.floor((np.asarray(y, np.float64) - self.ty0 * S0) / self.px).astype(np.int64)
        n = self.gr.shape[0]
        ok = (i >= 0) & (j >= 0) & (i < n) & (j < n)
        return np.where(ok, self.gr[np.clip(j, 0, n - 1), np.clip(i, 0, n - 1)], 255)

    def tile_index(self, x, y) -> np.ndarray:
        """Index into self.tiles of the tile containing each point (-1 = not loaded)."""
        tx = np.floor(np.asarray(x) / S0).astype(np.int64)
        ty = np.floor(np.asarray(y) / S0).astype(np.int64)
        lut = np.full((self.nt, self.nt), -1, dtype=np.int64)
        for k, (a, b) in enumerate(self.tiles):
            lut[b - self.ty0, a - self.tx0] = k
        i, j = tx - self.tx0, ty - self.ty0
        ok = (i >= 0) & (j >= 0) & (i < self.nt) & (j < self.nt)
        return np.where(ok, lut[np.clip(j, 0, self.nt - 1), np.clip(i, 0, self.nt - 1)], -1)

    # ------------------------------------------------------------------ polylines
    def _lines(self, p: str, names: list[str], vnames: list[str] = ()) -> Lines:
        offs, xs, ys, zs, tiles = [np.zeros(1, np.int64)], [], [], [], []
        attrs: dict[str, list] = {k: [] for k in names}
        vattrs: dict[str, list] = {k: [] for k in vnames}
        base = 0
        for ti, d in enumerate(self.data):
            off = d.get(f"{p}_off")
            xyz = d.get(f"{p}_xyz")
            if off is None or xyz is None or len(off) < 2:
                continue
            npc = len(off) - 1
            ox, oy = self.origin(ti)
            v = xyz.reshape(-1, 3).astype(np.float64)
            xs.append(v[:, 0] + ox)
            ys.append(v[:, 1] + oy)
            zs.append(v[:, 2])
            offs.append(off[1:].astype(np.int64) + base)
            base += int(off[-1])
            tiles.append(np.full(npc, ti, np.int64))
            for k in vnames:
                arr = d.get(f"{p}_{k}")
                ok = arr is not None and len(arr) == len(v)
                vattrs[k].append(arr.astype(np.float64) if ok else np.full(len(v), np.nan))
            for k in names:
                arr = d.get(f"{p}_{k}")
                attrs[k].append(arr[:npc].astype(np.float64) if arr is not None and len(arr) >= npc else np.zeros(npc))
        if len(offs) == 1:
            return _empty_lines(names, vnames)
        L = Lines(np.concatenate(offs), np.concatenate(xs), np.concatenate(ys), np.concatenate(zs),
                  {k: np.concatenate(v) for k, v in attrs.items()}, np.concatenate(tiles),
                  vattrs={k: np.concatenate(v) for k, v in vattrs.items()})
        for k in ("class", "flags", "lanes"):
            if k in L.attrs:
                L.attrs[k] = L.attrs[k].astype(np.int64)
        # owned segments: midpoint inside the piece's own tile
        vp = L.vpiece()
        last = np.zeros(len(L.X), bool)
        last[L.off[1:] - 1] = True
        start = np.nonzero(~last)[0]
        start = start[start < len(L.X) - 1]
        pc = vp[start]
        mx = (L.X[start] + L.X[start + 1]) / 2
        my = (L.Y[start] + L.Y[start + 1]) / 2
        tt = np.array(self.tiles, dtype=np.int64)[L.tile[pc]]
        own = (np.floor(mx / S0) == tt[:, 0]) & (np.floor(my / S0) == tt[:, 1])
        L.seg = start[own]
        L.seg_piece = pc[own]
        return L

    # ------------------------------------------------------------------ points
    def _points(self) -> None:
        xs, ys, kind, var, osm = [], [], [], [], []
        for ti, d in enumerate(self.data):
            pxy = d.get("p_xy")
            pk = d.get("p_kind")
            if pxy is None or pk is None or len(pk) == 0:
                continue
            ox, oy = self.origin(ti)
            p = pxy.reshape(-1, 2).astype(np.float64)
            inside = (p[:, 0] >= 0) & (p[:, 0] < S0) & (p[:, 1] >= 0) & (p[:, 1] < S0)
            xs.append(p[inside, 0] + ox)
            ys.append(p[inside, 1] + oy)
            kind.append(pk[inside].astype(np.int64))
            pv = d.get("p_var")
            var.append(pv[inside].astype(np.int64) if pv is not None else np.zeros(inside.sum(), np.int64))
            po = d.get("p_osm")
            osm.append(po[inside].astype(np.float64) if po is not None else np.zeros(inside.sum()))
        cat = lambda a, dt=np.float64: np.concatenate(a) if a else np.zeros(0, dt)  # noqa: E731
        self.pts = {"x": cat(xs), "y": cat(ys), "kind": cat(kind, np.int64), "var": cat(var, np.int64), "osm": cat(osm)}

    # ------------------------------------------------------------------ buildings
    def buildings(self, holes: bool = False, keep_suppressed: bool = False):
        """(shapely polygons, attrs) for all buildings in block+halo. Outer rings only unless
        `holes`; buildings replaced by a landmark model (landmarks.json suppress) are dropped,
        as the tile worker does, unless `keep_suppressed`."""
        key = (holes, keep_suppressed)
        cache = self.__dict__.setdefault("_bcache", {})
        if key not in cache:
            cache[key] = self._buildings(holes, keep_suppressed)
        return cache[key]

    def _buildings(self, holes: bool, keep_suppressed: bool):
        import shapely

        sup = suppressed()

        polys, att = [], {k: [] for k in ("osm", "height", "min", "base", "kind", "tile")}
        for ti, d in enumerate(self.data):
            ro, vo, bxy = d.get("b_ring_off"), d.get("b_vert_off"), d.get("b_xy")
            if ro is None or vo is None or bxy is None or len(ro) < 2:
                continue
            ox, oy = self.origin(ti)
            xy = bxy.reshape(-1, 2).astype(np.float64) + (ox, oy)
            nb = len(ro) - 1
            r0 = ro[:-1].astype(np.int64)
            a = vo[r0].astype(np.int64)
            b = vo[r0 + 1].astype(np.int64)
            ok = (b - a) >= 3
            idx = np.nonzero(ok)[0]
            if len(idx) == 0:
                continue
            osm = d.get("b_osm")
            if osm is not None and sup and not keep_suppressed:
                idx = idx[~np.isin(osm[:nb][idx].astype(np.int64), list(sup))]
                if len(idx) == 0:
                    continue
            counts = (b - a)[idx]
            vidx = np.concatenate([np.arange(a[i], b[i]) for i in idx])
            ring_id = np.repeat(np.arange(len(idx)), counts)
            coords = xy[vidx]
            rings = shapely.linearrings(coords, indices=ring_id)
            pg = shapely.polygons(rings)
            if holes:
                nr = ro[1:].astype(np.int64) - r0
                for q in np.nonzero(nr[idx] > 1)[0]:
                    i = idx[q]
                    hs = [xy[vo[r]:vo[r + 1]] for r in range(int(ro[i]) + 1, int(ro[i + 1])) if vo[r + 1] - vo[r] >= 3]
                    if hs:
                        pg[q] = shapely.Polygon(xy[a[i]:b[i]], hs)
            pg = shapely.make_valid(pg)
            polys.append(pg)
            for k, arr in (("osm", "b_osm"), ("height", "b_height"), ("min", "b_min"), ("base", "b_base"), ("kind", "b_kind")):
                v = d.get(arr)
                att[k].append(v[:nb][idx].astype(np.float64) if v is not None else np.zeros(len(idx)))
            att["tile"].append(np.full(len(idx), ti))
        if not polys:
            return np.zeros(0, object), {k: np.zeros(0) for k in att}
        return np.concatenate(polys), {k: np.concatenate(v) for k, v in att.items()}

    def houses(self):
        import shapely

        polys, att = [], {k: [] for k in ("osm", "height", "base", "x", "y")}
        for ti, d in enumerate(self.data):
            hxy = d.get("h_xy")
            if hxy is None or len(hxy) == 0:
                continue
            ox, oy = self.origin(ti)
            c = hxy.reshape(-1, 2).astype(np.float64) + (ox, oy)
            ang, hl, hw = d["h_angle"].astype(np.float64), d["h_len"] / 2.0, d["h_wid"] / 2.0
            ca, sa = np.cos(ang), np.sin(ang)
            corners = []
            for su, sv in ((1, 1), (-1, 1), (-1, -1), (1, -1)):
                corners.append(np.stack([c[:, 0] + su * hl * ca - sv * hw * sa, c[:, 1] + su * hl * sa + sv * hw * ca], 1))
            q = np.stack(corners, 1)
            polys.append(shapely.polygons(q))
            att["osm"].append(d.get("h_osm", np.zeros(len(c))).astype(np.float64))
            att["height"].append(d.get("h_height", np.zeros(len(c))).astype(np.float64))
            att["base"].append(d.get("h_base", np.zeros(len(c))).astype(np.float64))
            att["x"].append(c[:, 0])
            att["y"].append(c[:, 1])
        if not polys:
            return np.zeros(0, object), {k: np.zeros(0) for k in att}
        return np.concatenate(polys), {k: np.concatenate(v) for k, v in att.items()}


@functools.lru_cache(maxsize=1)
def suppressed() -> frozenset:
    """OSM building ids the client skips (landmark models, station clearance)."""
    out: set = set()
    p = geo.OUT / "landmarks.json"
    if p.exists():
        out |= {int(o) for L in json.loads(p.read_text()) for o in L.get("suppress", [])}
    # buildings clipping tracks / platforms, skipped by the client too (stations.json suppress)
    s = geo.OUT / "stations.json"
    if s.exists():
        d = json.loads(s.read_text())
        if isinstance(d, dict):
            out |= {int(o) for o in d.get("suppress", [])}
    return frozenset(out)


@functools.lru_cache(maxsize=1)
def stations() -> list:
    """data/stations.json stations (empty if missing)."""
    p = geo.OUT / "stations.json"
    if not p.exists():
        return []
    d = json.loads(p.read_text())
    return d.get("stations", d) if isinstance(d, dict) else d


def platform_polys():
    """(shapely rectangles, info dicts) for every platform in stations.json. `b` = compass bearing."""
    import shapely

    polys, info = [], []
    for s in stations():
        for L in s.get("levels", []):
            for pl in L.get("plats", []) or []:
                c, b, ln, w = pl.get("c"), pl.get("b", L.get("bearing", 0.0)), pl.get("len"), pl.get("w")
                if not c or not ln or not w:
                    continue
                t = math.radians(b)
                ux, uy = math.sin(t), math.cos(t)  # along the platform
                vx, vy = uy, -ux
                hl, hw = ln / 2, w / 2
                pts = [(c[0] + sx * hl * ux + sy * hw * vx, c[1] + sx * hl * uy + sy * hw * vy) for sx, sy in ((1, 1), (-1, 1), (-1, -1), (1, -1))]
                polys.append(shapely.Polygon(pts))
                info.append({"station": s.get("name", s.get("id")), "id": s.get("id"), "mode": L.get("mode"), "grade": L.get("grade"),
                             "type": pl.get("type"), "c": c, "b": b, "len": ln, "w": w, "u": (ux, uy), "v": (vx, vy)})
    return np.array(polys, dtype=object), info


def ground_polys(B: "Block", cls: int):
    """Vector ground polygons (gp_*) of one land-cover class, world coordinates, block + halo."""
    import shapely

    out = []
    for ti, d in enumerate(B.data):
        off, xy, gc = d.get("gp_off"), d.get("gp_xy"), d.get("gp_class")
        if off is None or xy is None or gc is None:
            continue
        ox, oy = B.origin(ti)
        P = xy.reshape(-1, 2).astype(np.float64) * (S0 / 65535.0) + (ox, oy)
        for k in np.nonzero(gc == cls)[0]:
            a, b = int(off[k]), int(off[k + 1])
            if b - a >= 3:
                out.append(shapely.make_valid(shapely.Polygon(P[a:b])))
    return np.array(out, dtype=object)


def ribbon_quads(L: Lines, hw: np.ndarray, seg: np.ndarray | None = None):
    """Flat-capped quads (shapely) for owned segments (or `seg` vertex starts)."""
    import shapely

    s = L.seg if seg is None else seg
    x0, y0, x1, y1 = L.X[s], L.Y[s], L.X[s + 1], L.Y[s + 1]
    dx, dy = x1 - x0, y1 - y0
    ln = np.hypot(dx, dy) + 1e-9
    nx, ny = -dy / ln * hw, dx / ln * hw
    q = np.stack([
        np.stack([x0 + nx, y0 + ny], 1), np.stack([x1 + nx, y1 + ny], 1),
        np.stack([x1 - nx, y1 - ny], 1), np.stack([x0 - nx, y0 - ny], 1)], 1)
    return shapely.polygons(q)


def seg_point_dist(px, py, x0, y0, x1, y1):
    """Distance from points to segments (all arrays broadcast) and the segment parameter t."""
    dx, dy = x1 - x0, y1 - y0
    l2 = dx * dx + dy * dy
    t = np.where(l2 > 0, ((px - x0) * dx + (py - y0) * dy) / np.where(l2 > 0, l2, 1), 0)
    t = np.clip(t, 0, 1)
    return np.hypot(px - (x0 + dx * t), py - (y0 + dy * t)), t
