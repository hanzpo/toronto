"""Read-only access to the built data for the QA checks.

Everything is converted to absolute world coordinates (E, N metres; z datum
metres). The region is processed in *blocks* of 4x4 level-0 tiles (one level-1
tile) plus a one-tile halo, so checks see features that cross tile borders.
A finding belongs to the block whose core contains its location, so every
finding is reported exactly once.

Tile data quirks handled here:
  * road / rail pieces extend ~20 m past their tile (the client clips them).
    A segment belongs to the tile containing its midpoint (``own``), which
    gives an exact partition of the network without duplicates.
  * a piece endpoint *inside* its tile rect is a real vertex (way end or
    shared node); one outside is a clip artefact.
  * junctions are duplicated into every tile within 80 m -> keep in-tile ones.
Missing arrays are tolerated everywhere (empty structures).
"""

from __future__ import annotations

import functools
import json
import math
from dataclasses import dataclass, field

import numpy as np

from .. import geo, tbn

S0 = geo.TILE_SIZE[0]
G0 = geo.TERRAIN_GRID[0]
GR = geo.GROUND_RES
BLOCK = 4  # level-0 tiles per block side (= one level-1 tile)
HALO = 1  # tiles of context around a block

TILES = geo.OUT / "tiles" / "0"
# road ribbon width as drawn by app/src/workers/roads.ts
ROAD_W_DEFAULT = np.array([24, 18, 14, 12, 10, 8, 5, 5, 2.2, 3], dtype=np.float64)
SIDEWALK_W = np.array([0, 0, 3.2, 2.8, 2.4, 1.9, 0, 0, 0, 0], dtype=np.float64)
URBAN = {2, 4, 5, 6, 11, 12, 17, 18, 19, 21, 22}

# road flags (SPEC)
F_ONEWAY, F_BRIDGE, F_TUNNEL, F_LINK, F_ROUNDABOUT = 1, 2, 4, 8, 16


def manifest() -> dict:
    return json.loads((geo.OUT / "manifest.json").read_text())


def render_width(cls: np.ndarray, width: np.ndarray) -> np.ndarray:
    """Ribbon width the client draws (roads.ts buildRoads, level 0)."""
    c = np.minimum(cls.astype(np.int64), 9)
    w = np.where(width > 0, width, ROAD_W_DEFAULT[c])
    return np.maximum(w, np.where(c <= 1, 10.0, 2.0))


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
    a = dict(a)
    a["_names"] = h.get("names", [])
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
        # per vertex (network-model tiles, docs/ROADS.md): pavement / edge-line offsets left and right
        # of the centreline and the lane marking bits
        self.roads = self._lines("r", ["class", "width", "lanes", "flags", "layer", "side", "osm", "v0", "name", "sw"],
                                 ["pl", "pr", "el", "er", "mk", "vf", "dz", "sw", "lw"])
        if self.roads.n:
            self.roads.attrs["w"] = render_width(self.roads.attrs["class"], self.roads.attrs["width"])
            if any("r_pl" in d for d in self.data):
                # network-model tiles (tpipe.roadnet): r_width is the drawn pavement width (no class minimum)
                self.roads.attrs["w"] = np.where(self.roads.attrs["width"] > 0, self.roads.attrs["width"], self.roads.attrs["w"])
        self.rails = self._lines("l", ["class", "flags", "osm"], ["vf", "dz"])
        for L in (self.roads, self.rails):
            L.ZD = self._drawn_z(L)
        self._points()
        self._junctions()

    def _drawn_z(self, L: Lines) -> np.ndarray:
        """Per-vertex elevation as the client draws it (workers/roads.ts): network-model tiles drape
        on the terrain plus `dz` where the vertex is graded, blending to the solved absolute z on
        decks (weight 1) and high embankments ((dz - 1.5) / 3); old tiles: z on bridges, else terrain."""
        if not len(L.X):
            return np.zeros(0)
        t = self.terrain(L.X, L.Y)
        vf, dz = L.vattrs.get("vf"), L.vattrs.get("dz")
        if vf is None or not len(vf) or not np.isfinite(vf).any():
            br = (L.attrs["flags"][L.vpiece()] & F_BRIDGE) != 0 if "flags" in L.attrs else np.zeros(len(L.X), bool)
            return np.where(br | ~np.isfinite(t), L.Z, t)
        net = np.isfinite(vf)
        v = np.nan_to_num(vf).astype(np.int64)
        d = np.nan_to_num(dz)
        br, graded, tun = (v & 1) != 0, (v & 4) != 0, (v & 2) != 0
        absz = br | ((v >> 4) == 11)                      # decks, curated exact levels
        if L is self.rails and "class" in L.attrs:
            # heavy rail off the street is drawn at its solved z (roads.ts buildRail)
            absz |= (L.attrs["class"][L.vpiece()] <= 2) & ((v & 8) == 0) & ~tun
        w = np.where(absz, 1.0, np.where(graded, np.clip((d - 1.5) / 3, 0, 1), 0.0))
        # roads: the draped part never below the drawn ground (roads.ts); track keeps its dz
        zdr = t + np.where(graded, d if L is self.rails else np.where(tun, d, np.maximum(d, 0.0)), 0.0)
        zd = zdr + (L.Z - zdr) * w
        return np.where(net & np.isfinite(t), zd, L.Z)

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
                if k == "sw" and arr is not None and len(arr) == len(v) and npc:
                    # network-model tiles: per-vertex sidewalk bits (tpipe.roadnet SW_*) -> OR per piece
                    attrs[k].append(np.bitwise_or.reduceat(arr.astype(np.int64), off[:-1].astype(np.int64)).astype(np.float64))
                    continue
                attrs[k].append(arr[:npc].astype(np.float64) if arr is not None and len(arr) >= npc else np.zeros(npc))
        if len(offs) == 1:
            return _empty_lines(names, vnames)
        L = Lines(np.concatenate(offs), np.concatenate(xs), np.concatenate(ys), np.concatenate(zs),
                  {k: np.concatenate(v) for k, v in attrs.items()}, np.concatenate(tiles),
                  vattrs={k: np.concatenate(v) for k, v in vattrs.items()})
        for k in ("class", "flags", "lanes", "side", "layer"):
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

    def piece_ends(self, L: Lines) -> dict[str, np.ndarray]:
        """Real (non-clip) piece endpoints: vertex index, piece, 0=start/1=end, direction
        pointing *into* the piece. Deduplicated across tiles by (osm, position)."""
        if L.n == 0:
            return {k: np.zeros(0, np.int64) for k in ("v", "p", "end")} | {"dx": np.zeros(0), "dy": np.zeros(0)}
        first = L.off[:-1]
        lastv = L.off[1:] - 1
        ok = lastv > first
        p = np.arange(L.n)[ok]
        vs = np.concatenate([first[ok], lastv[ok]])
        ps = np.concatenate([p, p])
        end = np.concatenate([np.zeros(len(p), np.int64), np.ones(len(p), np.int64)])
        nb = np.where(end == 0, vs + 1, vs - 1)
        tt = np.array(self.tiles, dtype=np.int64)[L.tile[ps]]
        lx = L.X[vs] - tt[:, 0] * S0
        ly = L.Y[vs] - tt[:, 1] * S0
        eps = 0.05
        real = (lx >= -eps) & (lx <= S0 + eps) & (ly >= -eps) & (ly <= S0 + eps)
        vs, ps, end, nb = vs[real], ps[real], end[real], nb[real]
        # dedupe (osm, rounded position, start/end, bridge/tunnel, class): the same piece is repeated in
        # every tile it crosses, but network-model tiles also split one OSM way into pieces where its
        # class, bridge or tunnel status changes, and those pieces meet end to end at a real node
        osm = L.attrs["osm"][ps]
        fl = L.attrs["flags"][ps] & (F_BRIDGE | F_TUNNEL) if "flags" in L.attrs else np.zeros(len(ps))
        cl = L.attrs["class"][ps] if "class" in L.attrs else np.zeros(len(ps))
        key = np.stack([osm, np.round(L.X[vs] * 10), np.round(L.Y[vs] * 10), end, fl, cl], 1)
        _, first_i = np.unique(key, axis=0, return_index=True)
        first_i = np.sort(first_i)
        vs, ps, end, nb = vs[first_i], ps[first_i], end[first_i], nb[first_i]
        dx = L.X[nb] - L.X[vs]
        dy = L.Y[nb] - L.Y[vs]
        ln = np.hypot(dx, dy) + 1e-9
        return {"v": vs, "p": ps, "end": end, "dx": dx / ln, "dy": dy / ln}

    # ------------------------------------------------------------------ points / junctions
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

    def _junctions(self) -> None:
        J = {"x": [], "y": [], "osm": [], "flags": [], "arms": []}
        for ti, d in enumerate(self.data):
            jxy = d.get("j_xy")
            if jxy is None or len(jxy) == 0:
                continue
            ox, oy = self.origin(ti)
            p = jxy.reshape(-1, 2).astype(np.float64)
            ao = d.get("j_arm_off")
            for k in range(len(p)):
                if not (0 <= p[k, 0] < S0 and 0 <= p[k, 1] < S0):
                    continue
                J["x"].append(p[k, 0] + ox)
                J["y"].append(p[k, 1] + oy)
                J["osm"].append(float(d["j_osm"][k]) if "j_osm" in d else 0.0)
                J["flags"].append(int(d["j_flags"][k]) if "j_flags" in d else 0)
                arms = []
                if ao is not None:
                    for m in range(int(ao[k]), int(ao[k + 1])):
                        arms.append((float(d["j_arm_ang"][m]), float(d["j_arm_r"][m]), float(d["j_arm_hw"][m]),
                                     int(d["j_arm_flags"][m]) if "j_arm_flags" in d else 0))
                J["arms"].append(arms)
        self.junc = {k: (np.array(v) if k != "arms" else v) for k, v in J.items()}
        if len(self.junc["x"]) == 0:
            self.junc["x"] = np.zeros(0)
            self.junc["y"] = np.zeros(0)
        self.junc["r"] = np.array([max([a[1] for a in arms], default=5.0) for arms in J["arms"]], dtype=np.float64)

    # ------------------------------------------------------------------ street surfaces
    def street_polys(self, kind: str):
        """Drawn street surface polygons (shapely, world, block + halo; cached):
        `js` junction pavement (roadnet intersection surfaces, js_xy / js_tri), `jw` raised corner
        sidewalks (jw_xy / jw_tri), `md` curbed medians (md_off / md_xyz / md_w). Triangle meshes are
        merged per tile, so a point's distance to the boundary is its depth inside the surface."""
        cache = self.__dict__.setdefault("_spcache", {})
        if kind not in cache:
            cache[kind] = self._street_polys(kind)
        return cache[kind]

    def _street_polys(self, kind: str):
        import shapely

        out = []
        for ti, d in enumerate(self.data):
            ox, oy = self.origin(ti)
            if kind in ("js", "jw"):
                xy, tri = d.get(f"{kind}_xy"), d.get(f"{kind}_tri")
                if xy is None or tri is None or len(tri) < 3:
                    continue
                P = xy.reshape(-1, 2).astype(np.float64) + (ox, oy)
                t = tri.reshape(-1, 3).astype(np.int64)
                g = shapely.union_all(shapely.polygons(P[t]), grid_size=0.01)
            else:
                mo, mx, mw = d.get("md_off"), d.get("md_xyz"), d.get("md_w")
                if mo is None or mx is None or mw is None or len(mo) < 2:
                    continue
                V = mx.reshape(-1, 3).astype(np.float64)
                quads = []
                for i in range(len(mo) - 1):
                    a, b = int(mo[i]), int(mo[i + 1])
                    if b - a < 2:
                        continue
                    x, y, w = V[a:b, 0] + ox, V[a:b, 1] + oy, mw[a:b].astype(np.float64) / 2
                    dx, dy = np.diff(x), np.diff(y)
                    ln = np.hypot(dx, dy) + 1e-9
                    nx, ny = -dy / ln, dx / ln
                    quads.append(np.stack([np.stack([x[:-1] + nx * w[:-1], y[:-1] + ny * w[:-1]], 1),
                                           np.stack([x[1:] + nx * w[1:], y[1:] + ny * w[1:]], 1),
                                           np.stack([x[1:] - nx * w[1:], y[1:] - ny * w[1:]], 1),
                                           np.stack([x[:-1] - nx * w[:-1], y[:-1] - ny * w[:-1]], 1)], 1))
                if not quads:
                    continue
                g = shapely.union_all(shapely.polygons(np.concatenate(quads)), grid_size=0.01)
            out.extend(shapely.get_parts(g))
        return np.array([g for g in out if not g.is_empty], dtype=object)

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
