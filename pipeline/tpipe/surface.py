"""Unified at-grade surface per level-0 tile (docs/SURFACE.md).

One planar partition ("surface arrangement") of the tile: every point belongs
to exactly one surface class (carriageway, curb, sidewalk, median, ballast,
crossing panel, driveway, path, grass, woods, water, ...), triangulated as ONE
watertight mesh with a single conformed height field. Paving *is* the terrain
where it lies, so the ground can never poke through it; vertical faces (curbs,
retaining walls, banks, cut walls) are strips extruded along the partition
boundaries where the height field steps.

    uv run python -m tpipe.surface --src ../app/public/data --out <dir> --tiles -1,2 0,0
    uv run python -m tpipe.surface --src ... --out ... --bbox E0,N0,E1,N1 --workers 2

Reads finished level-0 tiles (the road network model r_*, junction surfaces
js_*/jw_*, medians md_*, rail l_*, driveways k_*, vector ground gp_*, cuts pc_*,
terrain_h) of the tile and its 8 neighbours, and writes a copy of the tile with
the sf_* arrays added. Sources are adapters (`Source` records), so surveyed
edge-of-pavement / curb / sidewalk polygons or a LiDAR DTM can replace them.

Pipeline per tile
  1. sources: polygons with (class, priority, height group, owner)
  2. arrangement: node every source boundary, polygonize, each face takes the
     highest-priority source containing it (+ derived crossing panels, dense
     hardscape); grid lines (4 m near paving, 16 m elsewhere) are added in soft
     areas only, then polygonized again
  3. CDT of every face (shared vertices along every boundary: no T-junctions)
  4. heights: paved groups from the network solve (per owner: station, offset,
     crossfall); walks = curb + 0.15; soft ground = DTM clamped into the
     cut / fill cones of all paved boundaries (1:2), so embankments and cuts
     are slopes; conflicting cones leave a step -> retaining wall
  5. vertical strips where two groups meet at different heights
"""

from __future__ import annotations

import json
import math
import time
from pathlib import Path

import numpy as np
import shapely
from scipy.spatial import cKDTree
from shapely.strtree import STRtree

from . import geo, tbn

S0 = float(geo.TILE_SIZE[0])
MARGIN = 48.0
GRID = 1 / 32  # m: noding grid == storage lattice (sf_xy counts 1/32 m), so quantisation is exact

# ---------------------------------------------------------------- classes
# 0-63: ground classes (docs/SPEC.md gp_class), drawn by the ground material
C_LAND, C_WATER, C_GRASS, C_RES, C_COM, C_PLAZA, C_INST, C_VERGE = 0, 1, 2, 4, 5, 21, 17, 29
G_WALL, G_CUTFLOOR, G_BANK, G_DOCK = 34, 35, 33, 30
# 64+: paved classes, drawn by the street material (markings)
SC_ROAD, SC_JUNCTION, SC_CURB, SC_WALK, SC_PAVERS, SC_BLVD = 64, 65, 66, 67, 68, 69
SC_MEDIAN, SC_MEDIAN_GRASS, SC_PATH, SC_DRIVEWAY, SC_BALLAST, SC_TRACKGRASS, SC_PANEL = 70, 71, 72, 73, 74, 75, 76
SC_TRANSIT_ROW, SC_PLATFORM = 77, 78
SC_CURBFACE = 80
CLASS_NAMES = {SC_ROAD: "carriageway", SC_JUNCTION: "junction", SC_CURB: "curb", SC_WALK: "sidewalk", SC_PAVERS: "pavers",
               SC_BLVD: "boulevard", SC_MEDIAN: "median", SC_MEDIAN_GRASS: "median grass", SC_PATH: "path",
               SC_DRIVEWAY: "driveway", SC_BALLAST: "ballast", SC_TRACKGRASS: "track grass", SC_PANEL: "crossing panel",
               SC_TRANSIT_ROW: "transit ROW slab", SC_PLATFORM: "platform",
               SC_CURBFACE: "curb face", G_WALL: "wall", G_CUTFLOOR: "cut floor", G_BANK: "bank", G_DOCK: "dockwall"}

# height groups
H_SOFT, H_ROAD, H_WALK, H_RAIL, H_CUT, H_WATER = 0, 1, 2, 3, 4, 5
FIXED = (H_ROAD, H_WALK, H_RAIL, H_CUT)

# street-material surface codes (workers/roads.ts SURF_*)
SURF_ROAD, SURF_SIDEWALK, SURF_CURB, SURF_PATH, SURF_PAVERS, SURF_BALLAST = 0, 1, 2, 4, 5, 7
SURF_GRASS, SURF_GRAVEL, SURF_PANEL, SURF_WOOD = 10, 11, 12, 13

# road network model (tpipe.roadnet)
F_ONEWAY, F_LINK, F_LOT, F_DUP = 1, 8, 32, 64
V_BRIDGE, V_TUNNEL, V_GRADED, V_EMBED = 1, 2, 4, 8
ST_GRASS = 10
SW_L, SW_R, BLVD_L, BLVD_R, PAVERS, MEDIAN_L = 1, 2, 4, 8, 16, 32
SIDEWALK_W = [0, 0, 3.2, 2.8, 2.4, 1.9, 1.6]
BLVD_W, PAVER_W, CURB_W, CURB_H = 1.8, 0.9, 0.15, 0.15
FEAT_JUNCTION, FEAT_SIGNAL, FEAT_ZEBRA, FEAT_LINES, FEAT_STOP, FEAT_PXO, FEAT_RAIL = 1, 2, 3, 4, 5, 6, 7
FX_LINK, FX_RUMBLE, FX_SHARROW, FX_STAIRS, FX_CYCLE, FX_DIVIDED = 1, 2, 4, 8, 16, 32
FAR = 1e4

# height rules
CROSSFALL = 0.02
WALK_RISE = 0.015  # sidewalk cross slope up toward the property line
FILL_K, CUT_K = 2.0, 2.0  # 1:2 fill / cut slopes
SNAP = 0.3  # soft ground within this of an adjacent paved edge joins it (no wall)
WALL_MIN = 0.02
BALLAST_TOP, BALLAST_EDGE = 0.28, 0.03
ENV_CELL = 1.0
ENV_REACH = 40.0

# priorities (higher wins)
# boulevard / furniture bands (P_VERGE) sit below driveways (curb cuts cross them), sidewalks above
P_GROUND, P_TRACK, P_PATH, P_BED, P_CUT, P_VERGE, P_DRIVE, P_WALK, P_MEDIAN, P_CURB, P_ROAD, P_JUNCTION = 0, 21, 22, 30, 35, 37, 38, 40, 42, 44, 50, 60


# ---------------------------------------------------------------- tile IO

GROUND_KEYS = ("gp_off", "gp_xy", "gp_class", "gf_poly", "gf", "gw_poly", "gw_level", "gw_field",
               "sh_off", "sh_xy", "sh_z", "sh_type", "pc_off", "pc_xy", "pc_type", "pt_off", "pt_xyz", "pt_kind")


class Tiles:
    """Level-0 tiles of the source data set (cached). Vector ground keys missing from a tile
    (a data root caught between tpipe.osm_tiles and tpipe.ground) come from `fallback`."""

    def __init__(self, src: Path, fallback: Path | None = None, dtm: Path | None = None, net2: Path | None = None):
        self.net2 = Path(net2) if net2 else None
        self._net2 = None
        self.src = Path(src)
        self.fallback = Path(fallback) if fallback else None
        self.dtm = None if not dtm else "lidar" if str(dtm) == "lidar" else Path(dtm)
        self.dtm_src: dict = {}  # tile -> share of 1 m lidar samples (lidar mode; the rest is the logged 30 m fallback)
        self.cache: dict = {}
        self.dcache: dict = {}

    def get(self, tx, ty):
        k = (tx, ty)
        if k not in self.cache:
            p = self.src / "tiles" / "0" / f"{tx}_{ty}.bin.gz"
            if p.exists():
                a, h = tbn.read(p)
                a = {n: np.array(v) for n, v in a.items()}
                if "gp_off" not in a and self.fallback is not None:
                    q = self.fallback / "tiles" / "0" / f"{tx}_{ty}.bin.gz"
                    if q.exists():
                        b, _ = tbn.read(q)
                        for n in GROUND_KEYS:
                            if n in b:
                                a[n] = np.array(b[n])
                        a["_ground_fallback"] = np.array([1], np.uint8)
                self.cache[k] = (a, h)
            else:
                self.cache[k] = None
        return self.cache[k]

    def get_net2(self):
        """Primitive-network cross-sections (tpipe.primnet net2/surface.npz, docs/SPEC.md), or None."""
        if self._net2 is None and self.net2 is not None and self.net2.exists():
            d = np.load(self.net2)
            self._net2 = {k: np.array(d[k]) for k in d.files}
        return self._net2

    def get_net2_bbox(self):
        """net2/bbox.json next to surface.npz: (bbox, rail flag) or (None, False)"""
        import json
        p = self.net2.parent / "bbox.json" if self.net2 is not None else None
        if p is None or not p.exists():
            return None, False
        d = json.loads(p.read_text())
        return d.get("bbox"), bool(d.get("rail"))

    def get_dtm(self, tx, ty):
        """LiDAR DTM tile (tpipe.src_lidar): (N x N float32 datum m, res) or None."""
        k = (tx, ty)
        if k not in self.dcache:
            self.dcache[k] = None
            if self.dtm == "lidar":
                # the network model's own height source (tpipe.lidar_terrain: HRDEM 1 m, 30 m fallback)
                from . import lidar_terrain
                t = np.linspace(0.0, S0, 1025)
                gx, gy = np.meshgrid(tx * S0 + t, ty * S0 + t)
                h, src = lidar_terrain.get().sample_src(gx, gy)
                self.dtm_src[k] = float(src.mean())
                self.dcache[k] = (h.astype(np.float32), S0 / 1024)
            elif self.dtm is not None:
                p = self.dtm / f"{tx}_{ty}.bin.gz"
                if p.exists():
                    a, h = tbn.read(p)
                    N = int(round(math.sqrt(a["dtm"].size)))
                    self.dcache[k] = (a["dtm"].reshape(N, N).astype(np.float32) / 100.0 + float(h["base_m"]), S0 / (N - 1))
        return self.dcache[k]


# ---------------------------------------------------------------- polyline helpers

def offsets(x, y):
    """Miter-scaled left normals per vertex (workers/roads.ts offsets), vectorised. Zero-length
    neighbours (duplicated lane-change vertices) are skipped."""
    x, y = np.asarray(x, np.float64), np.asarray(y, np.float64)
    n = len(x)
    if n < 2:
        return np.zeros(n), np.zeros(n)
    dx, dy = np.diff(x), np.diff(y)
    L = np.hypot(dx, dy)
    good = L >= 1e-4
    # previous / next non-degenerate segment for every vertex
    idx = np.where(good, np.arange(n - 1), -1)
    prev_seg = np.maximum.accumulate(np.concatenate([[-1], idx]))[:n]  # last good segment ending at or before vertex i
    nidx = np.where(good, np.arange(n - 1), n)
    next_seg = np.minimum.accumulate(np.concatenate([nidx, [n]])[::-1])[::-1][:n]  # first good segment starting at or after i
    ux = np.where(good, dx / np.where(good, L, 1), 0)
    uy = np.where(good, dy / np.where(good, L, 1), 0)
    hp, hn = prev_seg >= 0, next_seg < n - 1
    d0x = np.where(hp, ux[np.maximum(prev_seg, 0)], 0.0)
    d0y = np.where(hp, uy[np.maximum(prev_seg, 0)], 0.0)
    d1x = np.where(hn, ux[np.minimum(next_seg, n - 2)], 0.0)
    d1y = np.where(hn, uy[np.minimum(next_seg, n - 2)], 0.0)
    d0x, d0y = np.where(hp, d0x, d1x), np.where(hp, d0y, d1y)
    d1x, d1y = np.where(hn, d1x, d0x), np.where(hn, d1y, d0y)
    sx, sy = d0x + d1x, d0y + d1y
    sl = np.hypot(sx, sy)
    deg = sl < 1e-6
    sx = np.where(deg, np.where(d1x != 0, d1x, 1.0), sx / np.where(deg, 1, sl))
    sy = np.where(deg, d1y, sy / np.where(deg, 1, sl))
    px, py = -sy, sx
    c = np.abs(px * -d1y + py * d1x)
    m = 1.0 / np.maximum(0.5, np.where(c == 0, 1.0, c))
    return px * m, py * m


NUM = ("x", "y", "z", "s", "el", "er", "pl", "pr", "lw", "wl", "wr")
DISC = ("mk", "vf", "sw")


def refine(run: dict, cuts, maxseg: float) -> dict:
    """Insert stations at along-distances `cuts` and every <= maxseg m (numeric attrs lerp, flags nearest).
    The mitred offset vectors are computed on the model's own stations and interpolated at inserted
    ones, so band edges are exactly the chords between the model's mitred corners."""
    if "ox" not in run:
        run = dict(run)
        run["ox"], run["oy"] = offsets(np.asarray(run["x"], np.float64), np.asarray(run["y"], np.float64))
    keys = NUM + ("ox", "oy")
    out = {k: [] for k in keys + DISC}
    n = len(run["x"])

    def push(i, t):
        j = min(i + 1, n - 1)
        for k in keys:
            out[k].append(run[k][i] + (run[k][j] - run[k][i]) * t)
        for k in DISC:
            out[k].append(run[k][i if t < 0.5 else j])

    push(0, 0.0)
    for i in range(n - 1):
        s0, s1 = run["s"][i], run["s"][i + 1]
        ts = []
        if abs(s1 - s0) > 1e-6:
            for c in cuts:
                if min(s0, s1) + 0.01 < c < max(s0, s1) - 0.01:
                    ts.append((c - s0) / (s1 - s0))
        L = math.hypot(run["x"][i + 1] - run["x"][i], run["y"][i + 1] - run["y"][i])
        m = int(math.ceil(L / maxseg))
        ts += [k / m for k in range(1, m)]
        last = 0.0
        for t in sorted(ts):
            if t - last < 1e-3 or t > 1 - 1e-3:
                continue
            push(i, t)
            last = t
        push(i + 1, 0.0)
    return {k: np.array(v) for k, v in out.items()}


def inv_bilinear(p, A, B, C, D):
    """(t, w) with p = bilerp(A, B, C, D): A(0,0) B(1,0) C(1,1) D(0,1). Vectorised over p (n,2)."""
    e = B - A
    f = D - A
    g = A - B + C - D
    h = p - A
    cross = lambda a, b: a[..., 0] * b[..., 1] - a[..., 1] * b[..., 0]  # noqa: E731
    k2 = cross(g, f)
    k1 = cross(e, f) + cross(h, g)
    k0 = cross(h, e)
    if abs(k2) < 1e-9 * max(1.0, abs(cross(e, f))):
        w = -k0 / np.where(np.abs(k1) < 1e-12, 1e-12, k1)
    else:
        disc = np.sqrt(np.maximum(k1 * k1 - 4 * k0 * k2, 0.0))
        w1 = (-k1 - disc) / (2 * k2)
        w2 = (-k1 + disc) / (2 * k2)
        w = np.where(np.abs(w1 - 0.5) <= np.abs(w2 - 0.5), w1, w2)
    den = e + g * w[:, None]
    t = np.where(np.abs(den[:, 0]) > np.abs(den[:, 1]), (h[:, 0] - f[0] * w) / np.where(np.abs(den[:, 0]) < 1e-12, 1e-12, den[:, 0]),
                 (h[:, 1] - f[1] * w) / np.where(np.abs(den[:, 1]) < 1e-12, 1e-12, den[:, 1]))
    return np.clip(t, 0, 1), np.clip(w, 0, 1)


def _polys(g):
    return [x for x in shapely.get_parts(g) if x.geom_type == "Polygon" and not x.is_empty]


# ---------------------------------------------------------------- sources

class Source:
    __slots__ = ("poly", "cls", "prio", "group", "owner", "bed")

    def __init__(self, poly, cls, prio, group, owner, bed=False):
        self.poly, self.cls, self.prio, self.group, self.owner, self.bed = poly, cls, prio, group, owner, bed


class Build:
    """Everything for one tile."""

    def __init__(self, tiles: Tiles, tx: int, ty: int):
        self.T, self.tx, self.ty = tiles, tx, ty
        self.x0, self.y0 = tx * S0, ty * S0
        self.box = shapely.box(self.x0, self.y0, self.x0 + S0, self.y0 + S0)
        self.ext = shapely.box(self.x0 - MARGIN, self.y0 - MARGIN, self.x0 + S0 + MARGIN, self.y0 + S0 + MARGIN)
        self.nb = []  # (tx, ty, arrays, header) of the 3x3 neighbourhood
        for j in (-1, 0, 1):
            for i in (-1, 0, 1):
                t = tiles.get(tx + i, ty + j)
                if t is not None:
                    self.nb.append((tx + i, ty + j, t[0], t[1]))
        self.sources: list[Source] = []
        self.pieces: dict = {}  # uid -> refined road run
        self.rails: dict = {}
        self.stats: dict = {}
        self.open_list: list = []
        self._terrain()

    # ---- natural ground (adapter: the LiDAR DTM replaces this)
    def _terrain(self):
        G = 33
        c = S0 / (G - 1)
        H = np.full((3 * (G - 1) + 1, 3 * (G - 1) + 1), np.nan)
        for tx, ty, a, _ in self.nb:
            if "terrain_h" not in a:
                continue
            i0, j0 = (tx - self.tx + 1) * (G - 1), (ty - self.ty + 1) * (G - 1)
            H[j0:j0 + G, i0:i0 + G] = a["terrain_h"].reshape(G, G) / 10.0
        if np.isnan(H).any():  # missing neighbours: nearest valid
            from scipy import ndimage
            m = np.isnan(H)
            idx = ndimage.distance_transform_edt(m, return_distances=False, return_indices=True)
            H = H[tuple(idx)]
        self.H, self.Hc, self.Hx0, self.Hy0 = H, c, self.x0 - S0, self.y0 - S0
        # LiDAR DTM (1 m) where available for the whole 3x3 block: replaces the 32 m grid
        d = [self.T.get_dtm(self.tx + i, self.ty + j) for j in (-1, 0, 1) for i in (-1, 0, 1)]
        self.dtm = False
        if all(x is not None for x in d):
            N = d[0][0].shape[0]
            D = np.zeros((3 * (N - 1) + 1, 3 * (N - 1) + 1), np.float32)
            for k, (g, _) in enumerate(d):
                i, j = k % 3, k // 3
                D[j * (N - 1):j * (N - 1) + N, i * (N - 1):i * (N - 1) + N] = g
            self.H, self.Hc = D, d[0][1]
            self.dtm = True

    def relevel_dtm(self):
        """Interim (until tpipe.roadnet solves against the DTM): the network model's at-grade road z
        sits ~2-3 m above the LiDAR DTM (it was solved on the Copernicus DSM). Shift the DTM by a
        smooth field of model-minus-DTM residuals at road centrelines (Gaussian, sigma 120 m) so its
        shape (ravines, banks, cuts) is kept at the model's level."""
        if not self.dtm:
            return
        ckd, cz = self.centreline_index()
        if ckd is None:
            return
        P = ckd.data[::4]
        r = cz[::4] - self.nat(P[:, 0], P[:, 1])
        self.stats["dtm_residual_median"] = float(np.median(r))
        self.stats["dtm_residual_p95abs"] = float(np.percentile(np.abs(r), 95))
        g = np.arange(-S0, 2 * S0 + 1, 32.0)
        gx, gy = np.meshgrid(self.x0 + g, self.y0 + g)
        num = np.zeros(gx.shape)
        den = np.zeros(gx.shape)
        sig = 120.0
        for k in range(0, len(P), 500):
            dx = gx[..., None] - P[None, None, k:k + 500, 0]
            dy = gy[..., None] - P[None, None, k:k + 500, 1]
            w = np.exp(-(dx * dx + dy * dy) / (2 * sig * sig))
            num += (w * r[None, None, k:k + 500]).sum(-1)
            den += w.sum(-1)
        off = np.where(den > 1e-6, num / np.maximum(den, 1e-6), float(np.median(r)))
        from scipy import ndimage
        n = self.H.shape[0]
        c = (np.arange(n) * self.Hc) / 32.0  # H index -> offset grid index (both start at x0 - S0)
        ci, cj = np.meshgrid(c, c)
        self.H = self.H + ndimage.map_coordinates(off, [cj, ci], order=1, mode="nearest").astype(np.float32)

    def nat(self, x, y):
        """Natural ground (datum m) at world x, y: the tiles' terrain grid, triangulated as the client did."""
        x = np.asarray(x, np.float64)
        y = np.asarray(y, np.float64)
        n = self.H.shape[0]
        fx = np.clip((x - self.Hx0) / self.Hc, 0, n - 1.0001)
        fy = np.clip((y - self.Hy0) / self.Hc, 0, n - 1.0001)
        i, j = np.floor(fx).astype(int), np.floor(fy).astype(int)
        u, v = fx - i, fy - j
        H = self.H
        h00, h10, h01, h11 = H[j, i], H[j, i + 1], H[j + 1, i], H[j + 1, i + 1]
        return np.where(u >= v, h00 + u * (h10 - h00) + v * (h11 - h10), h00 + v * (h01 - h00) + u * (h11 - h01))

    # ---- primitive network (net2): segments with explicit cross-section bands, node boxes
    def _net2_setup(self):
        N = self.T.get_net2()
        self.net2 = None
        if N is None:
            return
        so = N["seg_off"]
        segs, lines = [], []
        for i in range(len(so) - 1):
            P = N["seg_xyz"][so[i]:so[i + 1]]
            if len(P) < 2:
                continue
            ln = shapely.LineString(P[:, :2])
            if ln.intersects(self.ext.buffer(60)):
                segs.append(i)
                lines.append(ln)
        if not segs:
            return
        self.net2 = N
        self.net2_segs = segs
        self.net2_cover = shapely.union_all(shapely.buffer(np.array(lines, dtype=object), 2.5, quad_segs=2))
        nd = []
        for i in range(len(N["nd_off"]) - 1):
            r = N["nd_xy"][N["nd_off"][i]:N["nd_off"][i + 1]]
            if len(r) >= 3:
                g = shapely.make_valid(shapely.Polygon(r))
                if g.intersects(self.ext):
                    nd.append(g)
        self.net2_nodes = nd
        self.net2_box = shapely.union_all(np.array(nd, dtype=object)) if nd else shapely.Polygon()
        # box surface patches (tpipe.primgeom): one set of heights shared with the ?net=2 renderer
        self.net2_patch = None
        if "np_off" in N and len(N["np_off"]) > 1:
            tris = []
            po, to = N["np_off"], N["nt_off"]
            for i in range(len(po) - 1):
                P = N["np_xyz"][po[i]:po[i + 1]]
                tt = N["nt_tri"][to[i]:to[i + 1]].astype(np.int64)
                if not len(tt) or not shapely.box(P[:, 0].min(), P[:, 1].min(), P[:, 0].max(), P[:, 1].max()).intersects(self.ext):
                    continue
                tris.append(P[tt])  # (m, 3, 3)
            if tris:
                T3 = np.concatenate(tris)
                self.net2_patch = (T3, STRtree(shapely.polygons(T3[:, :, :2])))
        # corners: curb return (+ nc_h walk top), walk edge, building line, all with z
        self.net2_corner_pts = None
        if "nc_off" in N:
            pts, cz = [], []
            srcs = []
            co, wo, lo = N["nc_off"], N["nw_off"], N["nl_off"]
            for i in range(len(co) - 1):
                c = np.column_stack([N["nc_xy"][co[i]:co[i + 1]], N["nc_z"][co[i]:co[i + 1]]])
                w = N["nw_xyz"][wo[i]:wo[i + 1]]
                b = N["nl_xyz"][lo[i]:lo[i + 1]]
                if len(c) < 2 or not shapely.LineString(c[:, :2]).intersects(self.ext.buffer(30)):
                    continue
                h = float(N["nc_h"][i])
                for arr in (c, w, b):
                    if len(arr):
                        pts.append(arr[:, :2])
                        cz.append(arr[:, 2] + h)
                if len(w) >= 2:
                    walk = shapely.make_valid(shapely.Polygon(np.vstack([c[:, :2], w[::-1, :2]])))
                    for q in _polys(walk):
                        if q.area > 0.05:
                            srcs.append(Source(q, SC_WALK, P_WALK + 0.5, H_WALK, ("nc",)))
                    if len(b) >= 2:
                        front = shapely.make_valid(shapely.Polygon(np.vstack([w[:, :2], b[::-1, :2]])))
                        for q in _polys(front):
                            if q.area > 0.05:
                                srcs.append(Source(q, SC_PAVERS, P_WALK - 1, H_WALK, ("nc",)))
            if pts:
                self.net2_corner_pts = (cKDTree(np.concatenate(pts)), np.concatenate(cz))
            self.net2_corner_srcs = srcs

    def _replaced(self, P):
        """A model piece whose centreline lies (>= 70 %) under net2 segments is drawn from net2."""
        if self.net2 is None:
            return False
        ln = shapely.LineString(P)
        if ln.length < 1e-6:
            return False
        return shapely.intersection(ln, self.net2_cover).length >= 0.7 * ln.length

    def net2_segments(self):
        N = self.net2
        if N is None:
            return
        kinds = [str(k) for k in N["kinds"]]
        mats = [str(m) for m in N["mats"]]
        LANE = {"lane", "shoulder", "bike_lane", "parking"}
        so, bo, uo = N["seg_off"], N["nb_off"], N["nb_uoff"]
        ev = {}
        for e in range(len(N["ne_seg"])):
            ev.setdefault((int(N["ne_seg"][e]), int(N["ne_band"][e])), []).append((float(N["ne_s0"][e]), float(N["ne_s1"][e])))
        for i in self.net2_segs:
            P = N["seg_xyz"][so[i]:so[i + 1]].astype(np.float64)
            n = len(P)
            sd = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(P[:, :2], axis=0).T))])
            ox, oy = offsets(P[:, 0], P[:, 1])  # mitred at the 2 m stations, carried to the kept ones
            # decimate the 2 m stations: keep a station where dropping it would move the plan > 5 cm,
            # z > 2 cm or any band edge > 2 cm (linear interpolation between kept ones), or at an event
            U = [np.concatenate([N["nb_u0"][uo[b]:uo[b + 1]], N["nb_u1"][uo[b]:uo[b + 1]]]) for b in range(bo[i], bo[i + 1])
                 if uo[b + 1] - uo[b] == n]
            Ub = np.array([np.concatenate([N["nb_u0"][uo[b]:uo[b + 1]][None], N["nb_u1"][uo[b]:uo[b + 1]][None]]) for b in range(bo[i], bo[i + 1])
                           if uo[b + 1] - uo[b] == n]).reshape(-1, n) if U else np.zeros((0, n))
            evs = [v for (sg, _), sp in ev.items() if sg == i for a_, b_ in sp for v in (a_, b_)]
            keep = _decimate(P, sd, Ub, evs)
            P, sd, ox, oy = P[keep], sd[keep], ox[keep], oy[keep]
            n = len(P)
            bands = []
            lane_l = np.full(n, -1e9)
            lane_r = np.full(n, 1e9)
            raw = []
            for b in range(bo[i], bo[i + 1]):
                k = kinds[int(N["nb_kind"][b])]
                m = mats[int(N["nb_mat"][b])]
                if uo[b + 1] - uo[b] != len(keep):
                    continue
                u0 = N["nb_u0"][uo[b]:uo[b + 1]].astype(np.float64)[keep]
                u1 = N["nb_u1"][uo[b]:uo[b + 1]].astype(np.float64)[keep]
                raw.append((b - bo[i], k, m, float(N["nb_h"][b]), np.minimum(u0, u1), np.maximum(u0, u1)))
                if k in LANE:
                    lane_l = np.maximum(lane_l, np.maximum(u0, u1))
                    lane_r = np.minimum(lane_r, np.minimum(u0, u1))
            has_lane = lane_l > -1e8
            for bi, k, m, h, lo, hi in raw:
                on = (hi - lo) > 0.05
                if k == "platform":
                    spans = ev.get((i, bi), [])
                    on = on & np.array([any(a - 1e-3 <= v <= b_ + 1e-3 for a, b_ in spans) for v in sd])
                if k in LANE:
                    bands.append(dict(kind="lane", cls=SC_ROAD, group=H_ROAD, prio=P_ROAD + 0.35, u0=lo, u1=hi, on=on, raised=False, net=True))
                    continue
                cls, surf, prio = {
                    "median": (SC_MEDIAN_GRASS if m == "grass" else SC_MEDIAN, SURF_GRASS if m == "grass" else SURF_SIDEWALK, P_MEDIAN),
                    "transit_row": (SC_TRACKGRASS if m == "grass" else SC_TRANSIT_ROW, SURF_GRASS if m == "grass" else SURF_PANEL, P_MEDIAN),
                    "platform": (SC_PLATFORM, SURF_SIDEWALK, P_ROAD + 1),
                    "sidewalk": (SC_WALK, SURF_SIDEWALK, P_WALK),
                    "furniture": (SC_PAVERS if m == "pavers" else SC_WALK, SURF_PAVERS if m == "pavers" else SURF_SIDEWALK, P_VERGE),
                    "boulevard": (SC_BLVD, SURF_GRASS, P_VERGE),
                    "frontage": (SC_PAVERS if m == "pavers" else SC_BLVD if m == "grass" else SC_WALK,
                                 SURF_PAVERS if m == "pavers" else SURF_GRASS if m == "grass" else SURF_SIDEWALK, P_WALK - 1),
                    "curb": (SC_WALK, SURF_CURB, P_CURB),
                    "bed": (SC_BALLAST, SURF_BALLAST, P_BED),
                }.get(k, (SC_WALK, SURF_SIDEWALK, P_WALK))
                # the reference carriageway edge: the lane edge nearest to this band
                mid = (lo + hi) / 2
                ref = np.where(np.abs(mid - lane_l) <= np.abs(mid - lane_r), lane_l, lane_r)
                ref = np.where(has_lane, ref, 0.0)
                bands.append(dict(kind=k, cls=cls, group=H_WALK, prio=prio, u0=lo, u1=hi, on=on, raised=True, h=h, surf=surf,
                                  ref=ref, net=True, rgb=(214, 196, 186) if surf == SURF_PAVERS else (255, 255, 255)))
            R = dict(x=P[:, 0], y=P[:, 1], z=P[:, 2], s=sd, ox=ox, oy=oy, vf=np.zeros(n, np.int64), bands=bands, cls=4,
                     oneway=False, feats=[], net2=True)
            uid = ("net2", i)
            self.pieces[uid] = R
            self._bands(uid, R)
        # node boxes: the primgeom box patch triangles themselves (each its own face, so every surface
        # triangle lies inside one patch triangle: identical heights to the ?net=2 renderer); boxes
        # without a patch as outline polygons
        pat = getattr(self, "net2_patch", None)
        patched = shapely.Polygon()
        if pat is not None:
            T3, _ = pat
            polys = shapely.polygons(T3[:, :, :2])
            ok = shapely.is_valid(polys) & (shapely.area(polys) > 1e-6)
            for t in np.nonzero(ok)[0]:
                self.sources.append(Source(polys[t], SC_JUNCTION, P_JUNCTION, H_ROAD, ("jn", int(t))))
            patched = shapely.union_all(polys[ok])
        for g in self.net2_nodes:
            rest = shapely.difference(g, patched) if not patched.is_empty else g
            for q in _polys(rest):
                if q.area > 0.05:
                    self.sources.append(Source(q, SC_JUNCTION, P_JUNCTION, H_ROAD, ("jn", -1)))
        self.sources += getattr(self, "net2_corner_srcs", [])

    # ---- road pieces (network model) -> carriageway halves, sidewalk bands, medians
    def roads(self):
        self._net2_setup()
        ext = self.ext.buffer(40)
        for tx, ty, a, h in self.nb:
            if "r_off" not in a or "r_pl" not in a:
                continue
            ox0, oy0 = tx * S0, ty * S0
            off = a["r_off"]
            xyz = a["r_xyz"].reshape(-1, 3)
            juncs = self._junctions(a, ox0, oy0)
            xmap = {}
            if "p_kind" in a:
                pk, pxy, pv = a["p_kind"], a["p_xy"].reshape(-1, 2), a["p_var"]
                for i in range(len(pk)):
                    k = _hkey(pxy[i, 0], pxy[i, 1])
                    if pk[i] == 2 and pv[i] > 0:
                        xmap[k] = FEAT_ZEBRA if pv[i] == 1 else FEAT_PXO if pv[i] == 3 else FEAT_LINES
                    elif pk[i] == 5:
                        xmap[k] = FEAT_RAIL
            for i in range(len(off) - 1):
                f = int(a["r_flags"][i])
                if f & (F_LOT | F_DUP):
                    continue
                a0, a1 = int(off[i]), int(off[i + 1])
                if a1 - a0 < 2:
                    continue
                P = xyz[a0:a1]
                bb = shapely.box(P[:, 0].min() + ox0 - 30, P[:, 1].min() + oy0 - 30, P[:, 0].max() + ox0 + 30, P[:, 1].max() + oy0 + 30)
                if not bb.intersects(ext):
                    continue
                c = int(a["r_class"][i])
                ws = a["r_ws"].reshape(-1, 2)[a0:a1] / 10.0 if "r_ws" in a else np.zeros((a1 - a0, 2))
                run = {"x": P[:, 0].astype(np.float64), "y": P[:, 1].astype(np.float64), "z": P[:, 2].astype(np.float64),
                       "s": a["r_s"][a0:a1].astype(np.float64), "el": a["r_el"][a0:a1], "er": a["r_er"][a0:a1],
                       "pl": a["r_pl"][a0:a1], "pr": a["r_pr"][a0:a1], "lw": a["r_lw"][a0:a1],
                       "wl": ws[:, 0], "wr": ws[:, 1], "mk": a["r_mk"][a0:a1].astype(np.int64),
                       "vf": a["r_vf"][a0:a1].astype(np.int64), "sw": a["r_sw"][a0:a1].astype(np.int64)}
                run = _decimate_run(run, juncs, xmap)
                feats = self._features(run, c, juncs, xmap) if c <= 7 else []
                if c <= 7:
                    self._footprint((tx, ty, i), run, ox0, oy0)
                cuts = []
                for ft in feats:
                    cuts.append(ft["s"])
                    if ft["cb"]:
                        cuts.append(ft["s"] - ft["cb"])
                    if ft["ca"]:
                        cuts.append(ft["s"] + ft["ca"])
                R = refine(run, cuts, 16.0 if c <= 7 else 20.0)
                R["x"] += ox0
                R["y"] += oy0
                uid = (tx, ty, i)
                oneway = bool(f & F_ONEWAY)
                surf, tint, fx = SURF_ROAD, (255, 255, 255), (FX_LINK if f & F_LINK else 0)
                sub = int(a["r_sub"][i]) if "r_sub" in a else 0
                if c == 8:
                    sf = int(a["r_surf"][i]) if "r_surf" in a else 0
                    surf = {1: SURF_SIDEWALK, 2: SURF_PAVERS, 3: SURF_GRAVEL, 4: SURF_WOOD}.get(sf, SURF_PATH)
                    tint = (255, 236, 206) if sf == 3 else (200, 196, 192) if sub == 2 else (236, 232, 226)
                    if sub == 2:
                        fx |= FX_CYCLE
                    if sub == 4:
                        fx |= FX_STAIRS
                elif c == 9:
                    surf, tint = SURF_GRAVEL, (255, 236, 206)
                elif c == 7:
                    surf = SURF_PAVERS
                if c <= 1 and not f & F_LINK:
                    fx |= FX_RUMBLE
                cyc = int(a["r_cyc"][i]) if "r_cyc" in a else 0
                if (cyc & 15) == 3 or (cyc >> 4) == 3:
                    fx |= FX_SHARROW
                prio = 5.5 - c * 0.5 if c <= 7 else 1.5 if c == 8 else 1.0
                R.update(cls=c, oneway=oneway, feats=feats, code0=c + 16 * (1 if oneway else 0), surf=surf, tint=tint, fx=fx, prio=prio)
                self.pieces[uid] = R
                R["bands"] = infer_bands(R, feats) if "bands" not in R else R["bands"]
                if c <= 7 and self._replaced(np.column_stack([R["x"], R["y"]])):
                    # drawn from the primitive network's bands (net2_segments); the model's own bands stay
                    # underneath at the lowest paved priority, so any part of the model footprint net2
                    # leaves uncovered is paved at the model's own z
                    R["replaced"] = True
                    for bd in R["bands"]:
                        bd["prio"] = P_GROUND + 2 + (0.5 if bd["group"] == H_ROAD else 0)
                self._bands(uid, R)
        # junction surfaces and corner sidewalks (duplicated into every tile within 80 m: union dedups)
        js, jw = [], []
        for tx, ty, a, _ in self.nb:
            for key, out in (("js", js), ("jw", jw)):
                if f"{key}_xy" in a and f"{key}_tri" in a:
                    xy = a[f"{key}_xy"].reshape(-1, 2).astype(np.float64) + [tx * S0, ty * S0]
                    tri = a[f"{key}_tri"].reshape(-1, 3)
                    if len(tri):
                        out.append(shapely.polygons(xy[tri]))
        for arr, cls, prio, grp, own in ((js, SC_JUNCTION, P_JUNCTION, H_ROAD, ("j",)), (jw, SC_WALK, P_WALK, H_WALK, ("w",))):
            if not arr:
                continue
            g = np.concatenate(arr)
            g = g[shapely.intersects(g, self.ext)]
            if self.net2 is not None and cls == SC_JUNCTION:
                g = g[~shapely.intersects(g, self.net2_cover)]  # net2 node boxes replace these
            if self.net2 is not None and cls == SC_WALK and len(self.net2_nodes):
                g = g[~shapely.intersects(g, self.net2_box.buffer(12))]  # net2 corners replace these
            if not len(g):
                continue
            u = shapely.union_all(shapely.buffer(g, 0.01, join_style="mitre"), grid_size=GRID)
            u = shapely.simplify(shapely.buffer(u, -0.01, join_style="mitre"), 0.03)
            for q in _polys(shapely.intersection(u, self.ext)):
                if q.area > 0.05:
                    self.sources.append(Source(q, cls, prio, grp, own))
        self._medians()
        self.net2_segments()

    def _footprint(self, uid, run, ox0, oy0):
        """The model's at-grade footprint of a road piece (model_footprint_quads, shared with the QA)
        joins the arrangement; faces it wins resolve to the piece's nearest lane band."""
        fp = getattr(self, "fp", None)
        if fp is None:
            fp = self.fp = ([], [])
        for q in model_footprint_quads(np.asarray(run["x"], np.float64) + ox0, np.asarray(run["y"], np.float64) + oy0,
                                       run["pl"], run["pr"], run["vf"]):
            fp[0].append(q)
            fp[1].append(uid)
            self.sources.append(Source(q, SC_ROAD, P_GROUND + 1, H_ROAD, ("fp", uid)))

    def _junctions(self, a, ox0, oy0):
        if "j_xy" not in a:
            return {}
        xy = a["j_xy"].reshape(-1, 2)
        off, ang, r, fl, af = a["j_arm_off"], a["j_arm_ang"], a["j_arm_r"], a["j_flags"], a["j_arm_flags"]
        out = {}
        for i in range(len(xy)):
            arms = [(float(ang[k]), float(r[k]), int(af[k])) for k in range(off[i], off[i + 1])]
            out[_hkey(xy[i, 0], xy[i, 1])] = (int(fl[i]), arms)
        return out

    def _features(self, run, c, juncs, xmap):
        """Junction / crossing features along a run (port of workers/roads.ts buildRoads)."""
        feats = []
        x, y, s = run["x"], run["y"], run["s"]
        n = len(x)
        for k in range(n):
            key = _hkey(x[k], y[k])
            j = juncs.get(key)
            if j:
                if feats and abs(feats[-1]["s"] - s[k]) < 0.01:
                    continue
                kp = k - 1
                while kp >= 0 and math.hypot(x[kp] - x[k], y[kp] - y[k]) < 1e-3:
                    kp -= 1
                kn = k + 1
                while kn < n and math.hypot(x[kn] - x[k], y[kn] - y[k]) < 1e-3:
                    kn += 1
                pa = _arm_for(j[1], x[kp] - x[k], y[kp] - y[k]) if kp >= 0 else None
                na = _arm_for(j[1], x[kn] - x[k], y[kn] - y[k]) if kn < n else None
                sig = (j[0] & 1) != 0
                hw = (run["pl"][k] + run["pr"][k]) / 2

                def typ(arm):
                    if arm and arm[2] & 2:
                        return FEAT_JUNCTION
                    return FEAT_SIGNAL if sig else FEAT_STOP if arm and arm[2] & 1 else FEAT_JUNCTION
                rb = pa[1] if pa else hw
                ra = na[1] if na else hw
                feats.append(dict(s=float(s[k]), before=_feat_code(typ(pa), rb), after=_feat_code(typ(na), ra), cb=rb, ca=ra, sig=sig))
                continue
            xt = xmap.get(key)
            if xt:
                feats.append(dict(s=float(s[k]), before=_feat_code(xt, 0), after=_feat_code(xt, 0), cb=0.0, ca=0.0, sig=False))
        keep = []
        for ft in feats:
            t = int(ft["before"] // 100)
            if t in (FEAT_ZEBRA, FEAT_LINES, FEAT_PXO) and any(o["sig"] and abs(o["s"] - ft["s"]) < max(o["cb"], o["ca"]) + 10 for o in feats):
                continue
            keep.append(ft)
        keep.sort(key=lambda f: f["s"])
        return keep

    def _bands(self, uid, R):
        """One strip polygon per band per station interval (docs/CROSS_SECTION.md bands), vectorised."""
        n = len(R["x"])
        if n < 2:
            return
        ok = (R["vf"] & (V_BRIDGE | V_TUNNEL)) == 0
        fs = np.array([ft["s"] for ft in R["feats"]])
        sm = (R["s"][:-1] + R["s"][1:]) / 2
        span_all = np.searchsorted(np.sort(fs), sm + 1e-4, side="right") if len(fs) else np.zeros(n - 1, np.int64)
        C = np.column_stack([R["x"], R["y"]])
        Off = np.column_stack([R["ox"], R["oy"]])
        for bi, bd in enumerate(R["bands"]):
            u0, u1 = np.asarray(bd["u0"], np.float64), np.asarray(bd["u1"], np.float64)
            on = bd["on"] & ok
            k = np.nonzero(on[:-1] & on[1:] & (np.maximum(np.abs(u1[:-1] - u0[:-1]), np.abs(u1[1:] - u0[1:])) >= 0.05))[0]
            if not len(k):
                continue
            ring = np.stack([C[k] + Off[k] * u0[k, None], C[k + 1] + Off[k + 1] * u0[k + 1, None],
                             C[k + 1] + Off[k + 1] * u1[k + 1, None], C[k] + Off[k] * u1[k, None]], 1)
            polys = _quads(ring)
            span = span_all[k] if bd["kind"] in ("lane", "path") else np.zeros(len(k), np.int64)
            for kk, q, sp in zip(k.tolist(), polys, span.tolist()):
                if q is not None:
                    self.sources.append(Source(q, bd["cls"], bd["prio"], bd["group"], ("b", uid, kk, bi, sp)))

    def _medians(self):
        # streetcar track (class 4) in a rail right-of-way median: concrete track slab, rails set flush
        # (Spadina, St Clair, Queens Quay); LRT ROWs (Eglinton, Finch West) keep their grass bed
        trams = []
        for tx, ty, a, _ in self.nb:
            if "l_off" in a:
                lo, lx = a["l_off"], a["l_xyz"].reshape(-1, 3)
                for i in range(len(lo) - 1):
                    if a["l_class"][i] == 4 and lo[i + 1] - lo[i] >= 2:
                        trams.append(shapely.LineString(lx[lo[i]:lo[i + 1], :2].astype(np.float64) + [tx * S0, ty * S0]))
        tram_tree = STRtree(trams) if trams else None
        for tx, ty, a, _ in self.nb:
            if "md_off" not in a:
                continue
            mo, mx, mw, mk = a["md_off"], a["md_xyz"].reshape(-1, 3), a["md_w"], a["md_kind"]
            for i in range(len(mo) - 1):
                P = mx[mo[i]:mo[i + 1], :2].astype(np.float64) + [tx * S0, ty * S0]
                if len(P) < 2:
                    continue
                ox, oy = offsets(P[:, 0], P[:, 1])
                cum = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(P, axis=0).T))])
                tot = cum[-1]
                nose = np.clip(np.minimum(cum, tot - cum) / 4, 0.12, 1)
                w = (mw[mo[i]:mo[i + 1]] / 2 - 0.02) * np.sqrt(nose)
                L = P + np.column_stack([ox, oy]) * w[:, None] / np.hypot(ox, oy)[:, None]
                Rr = P - np.column_stack([ox, oy]) * w[:, None] / np.hypot(ox, oy)[:, None]
                kind = int(mk[i])
                cls = SC_MEDIAN if kind == 0 else SC_MEDIAN_GRASS
                if kind == 2 and tram_tree is not None and len(tram_tree.query(shapely.LineString(P), predicate="dwithin", distance=3.0)):
                    cls = SC_TRANSIT_ROW
                for k in range(len(P) - 1):
                    q = _quad(Rr[k], Rr[k + 1], L[k + 1], L[k])
                    if q is not None:
                        self.sources.append(Source(q, cls, P_MEDIAN, H_WALK, ("m", kind)))

    def centreline_index(self):
        """KD-tree over 1 m samples of the at-grade road centrelines (classes 0-7) with their model z."""
        if getattr(self, "_cidx", None) is None:
            xs, ys, zs = [], [], []
            for R in self.pieces.values():
                if R["cls"] > 7:
                    continue
                ok = (R["vf"] & (V_BRIDGE | V_TUNNEL)) == 0
                for k in range(len(R["x"]) - 1):
                    if not (ok[k] and ok[k + 1]):
                        continue
                    L = math.hypot(R["x"][k + 1] - R["x"][k], R["y"][k + 1] - R["y"][k])
                    t = np.linspace(0, 1, max(2, int(L) + 1))
                    xs.append(R["x"][k] + (R["x"][k + 1] - R["x"][k]) * t)
                    ys.append(R["y"][k] + (R["y"][k + 1] - R["y"][k]) * t)
                    zs.append(R["z"][k] + (R["z"][k + 1] - R["z"][k]) * t)
            self._cidx = (cKDTree(np.column_stack([np.concatenate(xs), np.concatenate(ys)])), np.concatenate(zs)) if xs else (None, None)
        return self._cidx

    # ---- rail at grade: ballast beds (embedded track -> panels)
    def rail(self):
        for tx, ty, a, _ in self.nb:
            if "l_off" not in a or "l_vf" not in a:
                continue
            off, xyz = a["l_off"], a["l_xyz"].reshape(-1, 3)
            for i in range(len(off) - 1):
                c = int(a["l_class"][i])
                if c == 4:
                    continue  # streetcar: rails set in the street, no bed
                a0, a1 = int(off[i]), int(off[i + 1])
                if a1 - a0 < 2:
                    continue
                P = xyz[a0:a1].astype(np.float64)
                run = {k: np.zeros(a1 - a0) for k in NUM}
                run.update(x=P[:, 0], y=P[:, 1], z=P[:, 2])
                run["s"] = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(P[:, :2], axis=0).T))])
                run.update(mk=np.zeros(a1 - a0, np.int64), vf=a["l_vf"][a0:a1].astype(np.int64), sw=np.zeros(a1 - a0, np.int64))
                R = refine(run, [], 10.0)
                R["x"] += tx * S0
                R["y"] += ty * S0
                if not shapely.box(R["x"].min() - 5, R["y"].min() - 5, R["x"].max() + 5, R["y"].max() + 5).intersects(self.ext):
                    continue
                uid = (tx, ty, i)
                hw = 1.4 if c == 1 else 1.8
                R.update(cls=c, hw=hw)
                self.rails[uid] = R
                vf = R["vf"]
                ok = (vf & (V_BRIDGE | V_TUNNEL)) == 0
                wt = hw - 0.6
                for k in range(len(R["x"]) - 1):
                    if not (ok[k] and ok[k + 1]):
                        continue
                    kind = 2 if vf[k] & V_EMBED else 1 if (vf[k] >> 4) == ST_GRASS else 0
                    cls = SC_PANEL if kind == 2 else SC_TRACKGRASS if kind == 1 else SC_BALLAST
                    C0 = np.array([R["x"][k], R["y"][k]])
                    C1 = np.array([R["x"][k + 1], R["y"][k + 1]])
                    o0 = np.array([R["ox"][k], R["oy"][k]])
                    o1 = np.array([R["ox"][k + 1], R["oy"][k + 1]])
                    for st, (u0, u1) in enumerate(((-hw, -wt), (-wt, 0.0), (0.0, wt), (wt, hw))):
                        q = _quad(C0 + o0 * u0, C1 + o1 * u0, C1 + o1 * u1, C0 + o0 * u1)
                        if q is not None:
                            self.sources.append(Source(q, cls, P_BED, H_RAIL, ("l", uid, k, st, u0, u1, kind), bed=True))

    def tram_row(self):
        """Streetcar track outside the travel lanes (a centre right-of-way: Spadina, St Clair,
        Queens Quay) sits on a concrete track slab: the tracks buffered 1.8 m and closed across the
        gap between them. Below carriageway priority, so street-running track stays in the lanes.
        Interim until the network model's `transit_row` band exists (docs/CROSS_SECTION.md)."""
        lines = []
        for tx, ty, a, _ in self.nb:
            if "l_off" not in a:
                continue
            lo, lx = a["l_off"], a["l_xyz"].reshape(-1, 3)
            vf = a.get("l_vf")
            for i in range(len(lo) - 1):
                if a["l_class"][i] != 4 or lo[i + 1] - lo[i] < 2:
                    continue
                P = lx[lo[i]:lo[i + 1], :2].astype(np.float64) + [tx * S0, ty * S0]
                if vf is not None and (vf[lo[i]:lo[i + 1]] & (V_BRIDGE | V_TUNNEL)).all():
                    continue
                lines.append(shapely.LineString(P))
        if self.net2 is not None:  # the primitive network carries its own transit_row / platform bands
            lines = [ln for ln in lines if shapely.intersection(ln, self.net2_cover).length < 0.7 * ln.length]
        if not lines:
            return
        self._platforms(lines)
        g = shapely.union_all(shapely.buffer(np.array(lines, dtype=object), 1.8, cap_style="flat", quad_segs=2))
        g = shapely.buffer(shapely.buffer(g, 1.5, join_style="mitre"), -1.5, join_style="mitre")
        g = shapely.intersection(g, self.ext.buffer(10))
        for q in _polys(g):
            if q.area > 1:
                self.sources.append(Source(q, SC_TRANSIT_ROW, P_BED + 2, H_WALK, ("row",)))

    def _platforms(self, lines):
        """Boarding islands at streetcar stops inside a right-of-way (placeholder for the model's
        `platform` band): 3 x 30 m, aligned with the nearest track, on the stop's side, 1.45 m from
        the track centre, raised 0.25 m. Stops on street-running track (in a travel lane) get none."""
        tree = STRtree(lines)
        for tx, ty, a, _ in self.nb:
            if "p_kind" not in a:
                continue
            k = a["p_kind"]
            xy = a["p_xy"].reshape(-1, 2).astype(np.float64) + [tx * S0, ty * S0]
            for i in np.nonzero(k == 7)[0]:
                P = shapely.Point(xy[i])
                if not self.ext.buffer(20).contains(P):
                    continue
                j = tree.nearest(P)
                ln = lines[j]
                if ln.distance(P) > 6:
                    continue
                s_ = ln.project(P)
                a0, a1 = ln.interpolate(max(0, s_ - 1)), ln.interpolate(min(ln.length, s_ + 1))
                d = np.array([a1.x - a0.x, a1.y - a0.y])
                d /= max(np.hypot(*d), 1e-9)
                T = np.array([ln.interpolate(s_).x, ln.interpolate(s_).y])
                side = 1.0 if d[0] * (xy[i, 1] - T[1]) - d[1] * (xy[i, 0] - T[0]) >= 0 else -1.0
                # the island goes on the side away from the other track of the pair
                nrm = np.array([-d[1], d[0]]) * side
                other = [q for q in tree.query(shapely.Point(T + nrm * 3.2), predicate="dwithin", distance=0.9) if q != j]
                if other:
                    nrm = -nrm
                c = T + nrm * (1.45 + 1.5)
                ax, n2 = d * 15.0, nrm * 1.5
                q = shapely.Polygon([c - ax - n2, c + ax - n2, c + ax + n2, c - ax + n2])
                # only inside a ROW (not on a street-running track's travel lane): the island must not
                # sit mostly on a carriageway of the network
                self.sources.append(Source(q, SC_PLATFORM, P_ROAD + 1, H_WALK, ("plat",)))

    def net2_rail(self):
        """The slice's rail corridor (tpipe.primrail, docs/SPEC.md "Rail corridor") as priority regions:
        the shared bed (cut into 8 m cells, heights on the bed mesh), the berm / cut slopes (their
        own triangles, exact), retaining walls (envelope breaks, see seeds) and the street-over-rail
        deck footprints (no paving under them; deck heights for the camera, sf_dk_*). The model's
        own beds inside the slice are dropped (the tile worker drops its track drawing there)."""
        N = self.T.get_net2()
        self.net2_bed = self.net2_slope = None
        self.walls_n2, self.decks_n2 = [], []
        if N is None or "rb_off" not in N:
            return
        bbox, rail = self.T.get_net2_bbox()
        if not rail or bbox is None:
            return
        sb = shapely.box(*bbox)
        if not sb.intersects(self.ext.buffer(MARGIN)):
            return
        self.sources = [x for x in self.sources if not (x.bed and x.owner[0] == "l" and sb.contains(shapely.point_on_surface(x.poly)))]
        # shared bed
        tris = []
        ro, to = N["rb_off"], N["rbt_off"]
        for i in range(len(ro) - 1):
            Pb = N["rb_xyz"][ro[i]:ro[i + 1]]
            tt = N["rbt_tri"][to[i]:to[i + 1]].astype(np.int64)
            if len(tt):
                tris.append(Pb[tt])
        if tris:
            T3 = np.concatenate(tris)
            g = shapely.polygons(T3[:, :, :2])
            near = shapely.intersects(g, self.ext.buffer(MARGIN))
            T3, g = T3[near], g[near]
            if len(T3):
                self.net2_bed = (T3, STRtree(g))
                bed = shapely.union_all(shapely.make_valid(g), grid_size=GRID)
                bed = shapely.intersection(bed, self.ext.buffer(MARGIN), grid_size=GRID)
                X0, Y0, X1, Y1 = bed.bounds
                C = 8.0
                cells = [shapely.box(x, y, x + C, y + C) for x in np.arange(math.floor(X0 / C) * C, X1, C) for y in np.arange(math.floor(Y0 / C) * C, Y1, C)]
                cells = np.array(cells, dtype=object)
                hit = shapely.intersects(cells, bed)
                parts = shapely.intersection(cells[hit], bed, grid_size=GRID)
                for ci, q0 in enumerate(parts):
                    for q in _polys(q0):
                        if q.area > 0.01:
                            self.sources.append(Source(q, SC_BALLAST, P_BED, H_RAIL, ("nb", ci)))
        # slopes: paired samples bed edge -> foot, one triangle pair per step
        so = N["rs_off"]
        st = []
        for i in range(len(so) - 1):
            a_, b_ = N["rs_in"][so[i]:so[i + 1]], N["rs_out"][so[i]:so[i + 1]]
            for k in range(len(a_) - 1):
                st.append([a_[k], a_[k + 1], b_[k + 1]])
                st.append([a_[k], b_[k + 1], b_[k]])
        if st:
            T3 = np.array(st, np.float64)
            g = shapely.polygons(T3[:, :, :2])
            ok = shapely.is_valid(g) & (shapely.area(g) > 1e-3) & shapely.intersects(g, self.ext.buffer(MARGIN))
            self.net2_slope = (T3, STRtree(g))
            for t in np.nonzero(ok)[0]:
                self.sources.append(Source(g[t], EMB_CLS, P_BED - 2, H_RAIL, ("ns", int(t))))
        # retaining walls: (line, zb per vertex, zt per vertex)
        wo = N["rw_off"]
        for i in range(len(wo) - 1):
            xy = N["rw_xy"][wo[i]:wo[i + 1]]
            if len(xy) >= 2 and shapely.LineString(xy).intersects(self.ext.buffer(MARGIN)):
                self.walls_n2.append((xy, N["rw_zb"][wo[i]:wo[i + 1]].astype(np.float64), N["rw_zt"][wo[i]:wo[i + 1]].astype(np.float64)))
        # decks: footprints + mean z; abutments act as walls for the envelope (deck z over the ground)
        do = N["st_off"]
        for i in range(len(do) - 1):
            ring = N["st_xy"][do[i]:do[i + 1]]
            if len(ring) >= 3:
                q = shapely.make_valid(shapely.Polygon(ring))
                if q.intersects(self.ext.buffer(MARGIN)):
                    self.decks_n2.append((q, float(N["st_z"][i])))
        ao = N["sa_off"]
        for i in range(len(ao) - 1):
            L = N["sa_xyz"][ao[i]:ao[i + 1]]
            if len(L) >= 2 and shapely.LineString(L[:, :2]).intersects(self.ext.buffer(MARGIN)):
                zb = self.nat(L[:, 0], L[:, 1]).astype(np.float64)
                self.walls_n2.append((L[:, :2], zb, L[:, 2].astype(np.float64)))

    def structures(self):
        """No paving under a deck footprint (the deck is drawn by the structure renderer; the
        surface there is the ground / bed below)."""
        if not getattr(self, "decks_n2", None):
            return
        D = shapely.union_all([q for q, _ in self.decks_n2], grid_size=GRID)
        out = []
        for x in self.sources:
            if x.group in (H_ROAD, H_WALK) and x.poly.intersects(D):
                r = shapely.difference(x.poly, D, grid_size=GRID)
                for q in _polys(r):
                    if q.area > 0.01:
                        out.append(Source(q, x.cls, x.prio, x.group, x.owner, x.bed))
                continue
            out.append(x)
        self.sources = out

    def deck_tris(self):
        """Deck top triangles (world x, y, z) for the camera / walker height (sf_dk_xyz): the deck
        footprint triangulated, z from the slice's street centreline stations over it."""
        if not getattr(self, "decks_n2", None):
            return np.zeros((0, 3, 3))
        N = self.T.get_net2()
        Pz = N["seg_xyz"]
        kd = cKDTree(Pz[:, :2])
        out = []
        for q, zm in self.decks_n2:
            for part in _polys(shapely.segmentize(q, 4.0)):
                tri = shapely.get_parts(shapely.constrained_delaunay_triangles(part))
                if not len(tri):
                    continue
                co = np.array([np.asarray(t.exterior.coords)[:3] for t in tri])
                flat = co.reshape(-1, 2)
                d, j = kd.query(flat, k=8)
                zz = Pz[j, 2]
                w = np.where((np.abs(zz - zm) < 3.0) & (d < 40), 1 / (d ** 2 + 1.0), 0)
                z = np.where(w.sum(1) > 0, (w * zz).sum(1) / np.maximum(w.sum(1), 1e-12), zm)
                out.append(np.concatenate([co, z.reshape(-1, 3, 1)], axis=2))
        return np.concatenate(out) if out else np.zeros((0, 3, 3))

    def rail_yards(self):
        """Gaps under 3 m between neighbouring track beds are ballast too: one shared bed / berm
        (heights: the soft ground inside the fill envelope, closed between the cones)."""
        beds = [s.poly for s in self.sources if s.bed and s.owner[6] == 0]
        if len(beds) < 2:
            return
        u = shapely.union_all(np.array(beds, dtype=object), grid_size=GRID)
        closed = shapely.buffer(shapely.buffer(u, 1.5, quad_segs=2, join_style="mitre"), -1.5, quad_segs=2, join_style="mitre")
        gaps = shapely.difference(closed, u, grid_size=GRID)
        for q in _polys(gaps):
            if q.area > 0.5:
                self.sources.append(Source(q, SC_BALLAST, P_BED - 1, H_SOFT, ("by",)))

    # ---- driveways (hidden service centrelines k_*)
    def driveways(self):
        for tx, ty, a, _ in self.nb:
            if "k_off" not in a:
                continue
            ko, kx, ks = a["k_off"], a["k_xyz"].reshape(-1, 3), a["k_svc"]
            for i in range(len(ko) - 1):
                if ks[i] not in (2, 4):
                    continue
                P = kx[ko[i]:ko[i + 1], :2].astype(np.float64) + [tx * S0, ty * S0]
                if len(P) < 2:
                    continue
                # extend both ends by 3 m so the apron always reaches the curb
                d0 = P[0] - P[1]
                d1 = P[-1] - P[-2]
                P = np.vstack([P[0] + d0 / max(np.hypot(*d0), 1e-6) * 3, P, P[-1] + d1 / max(np.hypot(*d1), 1e-6) * 3])
                g = shapely.LineString(P).buffer(1.6 if ks[i] == 2 else 1.9, cap_style="flat", join_style="mitre")
                if g.intersects(self.ext):
                    self.sources.append(Source(g, SC_DRIVEWAY, P_DRIVE, H_SOFT, ("k",)))

    # ---- land cover (vector ground partition), water, open cuts
    def ground(self):
        q = S0 / 65535.0
        self.water_level = {}
        dense = self._dense()
        for tx, ty, a, _ in self.nb:
            if "gp_off" not in a:
                continue
            off, xy, cls = a["gp_off"], a["gp_xy"].reshape(-1, 2).astype(np.float64) * q + [tx * S0, ty * S0], a["gp_class"]
            lv = {}
            if "gw_poly" in a:
                for p, lev in zip(a["gw_poly"], a["gw_level"]):
                    lv[int(p)] = int(lev)
            field = a["gw_field"].reshape(33, 33) / 10.0 if "gw_field" in a else None
            for p in range(len(off) - 1):
                r = xy[off[p]:off[p + 1]]
                if len(r) < 3:
                    continue
                g = shapely.Polygon(r)
                if not g.intersects(self.ext):
                    continue
                c = int(cls[p])
                if c == C_WATER:
                    level = lv.get(p, -32768)
                    own = ("water", level / 10.0 if level > -32767 else None, (tx, ty), level == -32767)
                    if field is not None:
                        self.water_level[(tx, ty)] = field
                    self.sources.append(Source(shapely.make_valid(g), C_WATER, P_GROUND, H_WATER, own))
                    continue
                g = shapely.make_valid(shapely.simplify(g, 0.5))
                self.sources.append(Source(g, c, P_GROUND, H_SOFT, ("g", c)))
        self.dense = dense
        # open cuts / portal approaches
        self.cut_tracks = []
        for tx, ty, a, _ in self.nb:
            if "pc_off" not in a:
                continue
            off, xy = a["pc_off"], a["pc_xy"].reshape(-1, 2).astype(np.float64) * q + [tx * S0, ty * S0]
            for r in range(len(off) - 1):
                ring = xy[off[r]:off[r + 1]]
                if len(ring) >= 3:
                    self.sources.append(Source(shapely.make_valid(shapely.Polygon(ring)), G_CUTFLOOR, P_CUT, H_CUT, ("cut",)))
            if "pt_off" in a:
                to, txyz = a["pt_off"], a["pt_xyz"].reshape(-1, 3).astype(np.float64)
                for r in range(len(to) - 1):
                    seg = txyz[to[r]:to[r + 1]].copy()
                    seg[:, :2] += [tx * S0, ty * S0]
                    self.cut_tracks.append(seg)

    def _dense(self):
        """Built-up mask (4 m raster over the extended box): non-house building coverage within ~60 m > 30 %."""
        from rasterio import features, transform
        from scipy import ndimage
        n = int((S0 + 2 * MARGIN) / 4)
        tr = transform.from_origin(self.x0 - MARGIN, self.y0 + S0 + MARGIN, 4, 4)
        shapes = []
        for tx, ty, a, _ in self.nb:
            if "b_ring_off" not in a:
                continue
            ro, vo, xy = a["b_ring_off"], a["b_vert_off"], a["b_xy"].reshape(-1, 2).astype(np.float64) + [tx * S0, ty * S0]
            h = a["b_height"]
            for b in range(len(ro) - 1):
                if h[b] < 6:
                    continue
                r = int(ro[b])
                ring = xy[vo[r]:vo[r + 1]]
                if len(ring) >= 3:
                    shapes.append((shapely.Polygon(ring), 1))
        if not shapes:
            return None
        m = features.rasterize(shapes, out_shape=(n, n), transform=tr, fill=0, dtype="uint8")[::-1]  # row 0 = south
        cov = ndimage.uniform_filter(m.astype(np.float32), size=31)
        near = ndimage.distance_transform_edt(m == 0) * 4.0 < 20.0  # hardscape reaches ~20 m from a building face
        return dict(mask=(cov > 0.3) & near, x0=self.x0 - MARGIN, y0=self.y0 - MARGIN, cell=4.0)

    def is_dense(self, x, y):
        d = self.dense
        if d is None:
            return np.zeros(np.shape(x), bool)
        n = d["mask"].shape[0]
        i = np.clip(((np.asarray(x) - d["x0"]) / d["cell"]).astype(int), 0, n - 1)
        j = np.clip(((np.asarray(y) - d["y0"]) / d["cell"]).astype(int), 0, n - 1)
        return d["mask"][j, i]


def tile_feature_keys(a):
    """junction / crossing node keys of a tile (for station decimation), as roads() builds them"""
    juncs = {}
    if "j_xy" in a:
        xy = a["j_xy"].reshape(-1, 2)
        for i in range(len(xy)):
            juncs[_hkey(xy[i, 0], xy[i, 1])] = True
    xmap = {}
    if "p_kind" in a:
        pk, pxy, pv = a["p_kind"], a["p_xy"].reshape(-1, 2), a["p_var"]
        for i in range(len(pk)):
            if (pk[i] == 2 and pv[i] > 0) or pk[i] == 5:
                xmap[_hkey(pxy[i, 0], pxy[i, 1])] = True
    return juncs, xmap


def piece_footprint_quads(a, tx, ty, i, keys):
    """The at-grade footprint of road piece i of a tile exactly as the surface builder uses it:
    the model stations decimated (_decimate_run), then model_footprint_quads. Shared with the QA."""
    off = a["r_off"]
    a0, a1 = int(off[i]), int(off[i + 1])
    P = a["r_xyz"].reshape(-1, 3)[a0:a1]
    ws = a["r_ws"].reshape(-1, 2)[a0:a1] / 10.0 if "r_ws" in a else np.zeros((a1 - a0, 2))
    run = {"x": P[:, 0].astype(np.float64), "y": P[:, 1].astype(np.float64), "z": P[:, 2].astype(np.float64),
           "s": a["r_s"][a0:a1].astype(np.float64), "el": a["r_el"][a0:a1], "er": a["r_er"][a0:a1],
           "pl": a["r_pl"][a0:a1], "pr": a["r_pr"][a0:a1], "lw": a["r_lw"][a0:a1],
           "wl": ws[:, 0], "wr": ws[:, 1], "mk": a["r_mk"][a0:a1].astype(np.int64),
           "vf": a["r_vf"][a0:a1].astype(np.int64), "sw": a["r_sw"][a0:a1].astype(np.int64)}
    run = _decimate_run(run, *keys)
    return model_footprint_quads(np.asarray(run["x"]) + tx * S0, np.asarray(run["y"]) + ty * S0, run["pl"], run["pr"], run["vf"])


def model_footprint_quads(x, y, pl, pr, vf):
    """At-grade footprint of a road piece as the network model defines it (and the old ribbons drew
    it): per segment between two model stations, the quad between their mitred pavement corners,
    snapped to the surface lattice. Shared by the surface builder and qa/checks_surface.py."""
    x, y = np.asarray(x, np.float64), np.asarray(y, np.float64)
    if len(x) < 2:
        return []
    ox, oy = offsets(x, y)
    vf = np.asarray(vf)
    k = np.nonzero(((vf[:-1] | vf[1:]) & (V_BRIDGE | V_TUNNEL)) == 0)[0]
    if not len(k):
        return []
    C = np.column_stack([x, y])
    Off = np.column_stack([ox, oy])
    pl, pr = np.asarray(pl, np.float64), np.asarray(pr, np.float64)
    ring = np.stack([C[k] - Off[k] * pr[k, None], C[k + 1] - Off[k + 1] * pr[k + 1, None],
                     C[k + 1] + Off[k + 1] * pl[k + 1, None], C[k] + Off[k] * pl[k, None]], 1)
    qs = [q for q in _quads(ring) if q is not None]
    if not qs:
        return []
    qs = shapely.set_precision(np.array(qs, dtype=object), GRID)
    return [q for q in qs if not q.is_empty]


def _quads(ring):
    """Vectorised _quad over rings (m, 4, 2): valid quads directly, the rest through _quad."""
    m = len(ring)
    if not m:
        return []
    fin = np.isfinite(ring).all(axis=(1, 2))
    closed = np.concatenate([ring, ring[:, :1]], 1)
    polys = np.full(m, None, dtype=object)
    polys[fin] = shapely.polygons(closed[fin])
    valid = np.zeros(m, bool)
    valid[fin] = shapely.is_valid(polys[fin])
    area = np.zeros(m)
    area[valid] = shapely.area(polys[valid])
    out = [p if (v and a >= 1e-3) else None for p, v, a in zip(polys, valid, area)]
    for i in np.nonzero(fin & ~valid)[0]:
        out[i] = _quad(*ring[i])
    return out


def _hkey(x, y):
    return (round(float(x) * 20), round(float(y) * 20))


def _feat_code(t, r):
    return t * 100 + min(99.0, max(0.0, round(r * 10) / 10))


def _arm_for(arms, dx, dy):
    a = math.atan2(dy, dx)
    best, bd = None, 0.6
    for arm in arms:
        d = abs(math.atan2(math.sin(a - arm[0]), math.cos(a - arm[0])))
        if d < bd:
            bd, best = d, arm
    return best


def _quad(A, B, C, D):
    ring = np.array([A, B, C, D])
    if np.any(~np.isfinite(ring)):
        return None
    q = shapely.Polygon(ring)
    if not q.is_valid:
        # bow-tie at a tight bend / width step: keep every part (dropping one loses model footprint)
        q = shapely.make_valid(q)
        ps = _polys(q)
        if not ps:
            return None
        q = shapely.MultiPolygon(ps) if len(ps) > 1 else ps[0]
    if q.area < 1e-3:
        return None
    return q


# ---------------------------------------------------------------- arrangement

def arrange(B: Build):
    """Planar partition of the extended box: faces with their winning source."""
    t0 = time.time()
    src = B.sources
    polys = np.array([s.poly for s in src], dtype=object)
    polys = shapely.set_precision(polys, GRID)
    keep = ~shapely.is_empty(polys)
    src = [s for s, k in zip(src, keep) if k]
    polys = polys[keep]
    for s, p in zip(src, polys):
        s.poly = p
    lines = list(_unique_segments(polys))  # shared quad edges appear once
    for x in (B.x0, B.x0 + S0):
        lines.append(shapely.LineString([(x, B.y0 - MARGIN), (x, B.y0 + S0 + MARGIN)]))
    for y in (B.y0, B.y0 + S0):
        lines.append(shapely.LineString([(B.x0 - MARGIN, y), (B.x0 + S0 + MARGIN, y)]))
    lines.append(shapely.LineString(B.ext.exterior.coords))  # a LinearRing sends GEOS union down a ~10x slower path
    noded = shapely.union_all(np.array(lines, dtype=object), grid_size=GRID)
    faces = _polygonize(noded, B.ext)
    B.stats["t_node1"] = time.time() - t0
    info = classify(B, faces, src, polys)
    B.stats["faces1"] = len(faces)
    return faces, info, src


def _unique_segments(polys):
    """Unique lattice segments of the polygons' boundaries, as 2-point linestrings."""
    co, ci = shapely.get_coordinates(shapely.get_parts(shapely.boundary(polys)), return_index=True)
    qc = np.round(co / GRID).astype(np.int64)
    same = ci[1:] == ci[:-1]
    sa, sb = qc[:-1][same], qc[1:][same]
    nz = np.any(sa != sb, axis=1)
    sa, sb = sa[nz], sb[nz]
    swap = (sa[:, 0] > sb[:, 0]) | ((sa[:, 0] == sb[:, 0]) & (sa[:, 1] > sb[:, 1]))
    lo = np.where(swap[:, None], sb, sa)
    hi = np.where(swap[:, None], sa, sb)
    useg = np.unique(np.concatenate([lo, hi], 1), axis=0)
    return shapely.linestrings(useg.reshape(-1, 2, 2) * GRID)


def _polygonize(noded, ext):
    faces = shapely.get_parts(shapely.polygonize(shapely.get_parts(noded)))
    faces = faces[shapely.area(faces) > 1e-12]
    faces = faces[shapely.intersects(faces, ext)]
    return faces


def classify(B: Build, faces, src, polys):
    """Winning source per face (+ derived crossing panels, dense hardscape)."""
    tree = STRtree(polys)
    rp = shapely.point_on_surface(faces)
    fi, si = tree.query(rp, predicate="intersects")
    prio = np.array([s.prio for s in src])
    n = len(faces)
    best = np.full(n, -1)
    bp = np.full(n, -1e9)
    bed = np.full(n, -1)
    paved = np.zeros(n, bool)
    PAVED_FOR_PANEL = {SC_ROAD, SC_JUNCTION, SC_CURB, SC_WALK, SC_PAVERS, SC_BLVD, SC_PATH, SC_DRIVEWAY}
    for f, s in zip(fi, si):
        S = src[s]
        if S.bed:
            bed[f] = s
        elif S.cls in PAVED_FOR_PANEL:
            paved[f] = True
        if prio[s] > bp[f]:
            bp[f], best[f] = prio[s], s
    rx, ry = shapely.get_x(rp), shapely.get_y(rp)
    dense = B.is_dense(rx, ry)
    lanes_of: dict = {}
    for k, S in enumerate(src):
        if S.owner[0] == "b" and S.group == H_ROAD:
            lanes_of.setdefault(S.owner[1], []).append(k)
    lane_idx = [k for v in lanes_of.values() for k in v]
    lane_tree = STRtree([src[k].poly for k in lane_idx]) if lane_idx else None
    info = []
    for f in range(n):
        s = best[f]
        if s < 0:
            info.append(dict(cls=C_LAND if not dense[f] else C_PLAZA, group=H_SOFT, owner=("g", C_LAND), src=-1))
            continue
        S = src[s]
        if S.owner[0] == "fp":
            cand = lanes_of.get(S.owner[1])
            if not cand and lane_tree is not None:  # replaced by the primitive network: its nearest lane
                cand = [lane_idx[int(lane_tree.nearest(rp[f]))]]
            if cand:
                k = min(cand, key=lambda c: src[c].poly.distance(rp[f]))
                S, s = src[k], k
        cls, group, owner = S.cls, S.group, S.owner
        if bed[f] >= 0 and paved[f] and not S.bed:
            # a road / walk / path over track: crossing panel, flush with the paving it replaces
            if group == H_SOFT:
                owner, group = src[bed[f]].owner, H_RAIL
            cls = SC_PANEL
        if group == H_SOFT and owner[0] == "g" and cls in (C_LAND, C_RES, C_COM, C_INST, C_VERGE) and dense[f]:
            cls = C_PLAZA  # built-up: hardscape to the building line unless a green area is mapped
        info.append(dict(cls=cls, group=group, owner=owner, src=int(s)))
    _footprint_guard(B, faces, info, src, rp)
    return info


def _footprint_guard(B: Build, faces, info, src, rp):
    """Terrain-snapping invariant by construction: a face inside a model road footprint is never
    ground. Soft faces there take the nearest lane band of that piece."""
    fp = getattr(B, "fp", None)
    if not fp or not fp[0]:
        return
    ftree = STRtree(np.array(fp[0], dtype=object))
    soft = np.array([d["group"] == H_SOFT and d["cls"] < 64 for d in info])
    idx = np.nonzero(soft)[0]
    if not len(idx):
        return
    fi, qi = ftree.query(faces[idx], predicate="intersects")
    lanes: dict = {}
    for k, S in enumerate(src):
        if S.owner[0] == "b" and S.group == H_ROAD:
            lanes.setdefault(S.owner[1], []).append(k)
    n = 0
    done = set()
    for a_, q in zip(fi, qi):
        f = idx[a_]
        if f in done:
            continue
        g = faces[f]
        inter = shapely.intersection(g, fp[0][q]).area
        if inter < 0.5 * g.area:
            continue
        cand = lanes.get(fp[1][q])
        if not cand:
            continue
        k = min(cand, key=lambda c: src[c].poly.distance(rp[f]))
        S = src[k]
        info[f] = dict(cls=S.cls, group=S.group, owner=S.owner, src=int(k))
        done.add(f)
        n += 1
    B.stats["footprint_guard"] = n


def _okey(d):
    """Vertex-sharing key of a face owner (quads of one strip share vertices)."""
    o = d["owner"]
    if o[0] == "b":
        return ("b", o[1], o[3], o[4])
    if o[0] == "l":
        return ("l", o[1], o[3])
    return o


def _dkey(d):
    """Dissolve key: fragments of one source piece (one quad, one land-cover polygon...) merge."""
    return (d["cls"], d["group"], d["owner"])


def absorb_slivers(B: Build, faces, info):
    """Faces thinner than 10 cm (width ~ 2 area / perimeter) are noding artefacts between sources
    that should share an edge (the two halves of a crowned carriageway, a walk band and its
    carriageway): each takes the class / owner of the neighbour it shares the longest boundary
    with, so a sliver never falls through to the land cover underneath. Never demotes paving."""
    area = shapely.area(faces)
    per = shapely.length(faces)
    thin = np.nonzero(2 * area / np.maximum(per, 1e-9) < 0.10)[0]
    # net2 box patch triangles are real (thin ones along the outline): never absorbed
    thin = thin[[info[i]["owner"][0] != "jn" for i in thin]] if len(thin) else thin
    if not len(thin):
        return info
    is_thin = np.zeros(len(faces), bool)
    is_thin[thin] = True
    tree = STRtree(faces)
    qi, qj = tree.query(faces[thin], predicate="touches")
    ii, jj = thin[qi], qj
    soft = np.array([d["group"] == H_SOFT for d in info])
    ok = (jj != ii) & ~is_thin[jj] & (soft[ii] | ~soft[jj])  # a paving sliver only joins paving
    ii, jj = ii[ok], jj[ok]
    if not len(ii):
        return info
    shared = shapely.length(shapely.intersection(shapely.boundary(faces[jj]), shapely.boundary(faces[ii])))
    best: dict = {}
    for i, j, L in zip(ii.tolist(), jj.tolist(), shared.tolist()):
        if L > 0 and L > best.get(i, (0, -1))[0]:
            best[i] = (L, j)
    info = list(info)
    n = 0
    for i, (_, j) in best.items():
        if info[j] is not info[i]:
            info[i] = info[j]
            n += 1
    B.stats["slivers"] = n
    return info


def dissolve(B: Build, faces, info):
    """Merge the fragments that lower-priority source boundaries cut out of each winning source."""
    t0 = time.time()
    info = absorb_slivers(B, faces, info)
    groups: dict = {}
    inside = shapely.within(shapely.point_on_surface(faces), B.box)  # never merge across the tile border
    for i, d in enumerate(info):
        groups.setdefault((_dkey(d), bool(inside[i])), []).append(i)
    out_f, out_i = [], []
    for k, idx in groups.items():
        if len(idx) == 1:
            out_f.append(faces[idx[0]])
            out_i.append(info[idx[0]])
            continue
        try:
            u = shapely.coverage_union_all(faces[idx])
        except shapely.errors.GEOSException:
            u = shapely.union_all(faces[idx], grid_size=GRID)
        for q in _polys(u):
            out_f.append(q)
            out_i.append(info[idx[0]])
    B.stats["t_dissolve"] = time.time() - t0
    B.stats["faces_dissolved"] = len(out_f)
    return np.array(out_f, dtype=object), out_i


def _vid_table():
    vid: dict = {}
    V: list = []

    def get(x, y):
        k = (round(x * 1e4), round(y * 1e4))
        i = vid.get(k)
        if i is None:
            i = vid[k] = len(V)
            V.append((x, y))
        return i
    return get, V


def seeds(B: Build, faces, info):
    """Boundary samples (x, y, z) every 0.5 m along all fixed-group faces, heights by the fixed
    rules (conformed). Vectorised."""
    fix = np.nonzero([d["group"] in FIXED for d in info])[0]
    if not len(fix):
        return np.zeros((0, 3))
    parts, pidx = shapely.get_parts(shapely.boundary(faces[fix]), return_index=True)
    co, cidx = shapely.get_coordinates(parts, return_index=True)
    face = fix[pidx[cidx]]
    q = np.round(co * 1e4).astype(np.int64)
    key = q[:, 0] * (1 << 32) + (q[:, 1] & 0xFFFFFFFF)
    uk, first, vid = np.unique(key, return_index=True, return_inverse=True)
    V = co[first]
    pk = np.unique(vid * (1 << 32) + face)
    Hg, _ = fixed_heights(B, V, (pk >> 32, pk & 0xFFFFFFFF), info)
    grp = np.array([info[f]["group"] for f in face])
    z = np.array([Hg.get((int(v), int(g)), np.nan) for v, g in zip(vid, grp)])
    same = cidx[1:] == cidx[:-1]
    a_, b_ = np.nonzero(same)[0], np.nonzero(same)[0] + 1
    ok = ~np.isnan(z[a_]) & ~np.isnan(z[b_])
    a_, b_ = a_[ok], b_[ok]
    L = np.hypot(*(co[b_] - co[a_]).T)
    m = np.maximum(1, np.ceil(L / 0.5).astype(np.int64))
    e = np.repeat(np.arange(len(a_)), m + 1)
    t = np.concatenate([np.arange(k + 1) / k for k in m]) if len(m) < 1 else (np.arange(len(e)) - np.repeat(np.cumsum(m + 1) - (m + 1), m + 1)) / np.repeat(m, m + 1)
    P = co[a_][e] + (co[b_][e] - co[a_][e]) * t[:, None]
    Z = z[a_][e] + (z[b_][e] - z[a_][e]) * t
    return np.column_stack([P, Z])


def wall_seeds(B: Build, S):
    """Retaining walls / abutments break the fill envelope: drop the fixed samples whose fill cone
    would lift the ground at the wall foot above zb (the high side), and seed the foot at zb."""
    W = getattr(B, "walls_n2", None)
    if not W or not len(S):
        return S
    keep = np.ones(len(S), bool)
    add = []
    for xy, zb, zt in W:
        ln = shapely.LineString(xy)
        L = shapely.segmentize(ln, 0.5)
        c = np.asarray(L.coords)
        s_ = shapely.line_locate_point(ln, shapely.points(c))
        s0 = shapely.line_locate_point(ln, shapely.points(xy))
        zbc = np.interp(s_, s0, zb)
        add.append(np.column_stack([c, zbc]))
        reach = 2 * float(np.max(zt - zb)) + 1.0
        lo, hi = ln.bounds[:2], ln.bounds[2:]
        m = np.nonzero((S[:, 0] > lo[0] - reach) & (S[:, 0] < hi[0] + reach) & (S[:, 1] > lo[1] - reach) & (S[:, 1] < hi[1] + reach))[0]
        if not len(m):
            continue
        pts = shapely.points(S[m, :2])
        d = shapely.distance(pts, ln)
        zfoot = np.interp(shapely.line_locate_point(ln, pts), s0, zb)
        keep[m[(S[m, 2] > zfoot + 0.3) & (d < 2 * (S[m, 2] - zfoot))]] = False
    B.stats["wall_seeds_dropped"] = int((~keep).sum())
    return np.vstack([S[keep]] + add)


BASE_GRID = 32.0  # m: base cell of the soft-ground grid (split to 8 / 4 m where needed)
REFINE_TOL = 0.25  # m: a soft 32 m cell splits into 8 m, an 8 m cell into 4 m, where bilinear corners miss the target by more


def refine_soft(B: Build, faces, info, target):
    """Grid lines in soft areas: 16 m everywhere, 4 m in cells where the target surface
    (DTM clamped into the cut / fill envelope) is not planar enough; then re-polygonize."""
    t0 = time.time()
    X0, Y0, X1, Y1 = B.ext.bounds
    T, tx0, ty0 = target
    n = T.shape[0]
    ls = []
    G_ = BASE_GRID
    if G_ < 1000:
        for x in np.arange(math.ceil(X0 / G_) * G_, X1, G_):
            ls.append(shapely.LineString([(x, Y0), (x, Y1)]))
        for y in np.arange(math.ceil(Y0 / G_) * G_, Y1, G_):
            ls.append(shapely.LineString([(X0, y), (X1, y)]))
    nref = 0

    def err(cx, cy, size):
        i0, j0 = int(round((cx - tx0) / ENV_CELL)), int(round((cy - ty0) / ENV_CELL))
        k = int(round(size / ENV_CELL))
        if i0 < 0 or j0 < 0 or i0 + k >= n or j0 + k >= n:
            return 0.0
        blk = T[j0:j0 + k + 1, i0:i0 + k + 1]
        u = np.linspace(0, 1, k + 1)
        bil = (blk[0, 0] * (1 - u)[None, :] + blk[0, -1] * u[None, :]) * (1 - u)[:, None] + \
              (blk[-1, 0] * (1 - u)[None, :] + blk[-1, -1] * u[None, :]) * u[:, None]
        return float(np.abs(blk - bil).max())

    def split(cx, cy, size, sub):
        for k in np.arange(sub, size, sub):
            ls.append(shapely.LineString([(cx + k, cy), (cx + k, cy + size)]))
            ls.append(shapely.LineString([(cx, cy + k), (cx + size, cy + k)]))

    for cx in np.arange(math.floor(X0 / 32) * 32, X1, 32.0):
        for cy in np.arange(math.floor(Y0 / 32) * 32, Y1, 32.0):
            if err(cx, cy, 32) <= REFINE_TOL:
                continue
            nref += 1
            split(cx, cy, 32, 8)
            for sx in range(4):
                for sy in range(4):
                    x8, y8 = cx + 8 * sx, cy + 8 * sy
                    if err(x8, y8, 8) > REFINE_TOL:
                        split(x8, y8, 8, 4)
    # only soft / water faces are re-noded with the grid; fixed faces stay as they are (the grid
    # nodes landing on their boundaries are healed by fix_tjunctions after the CDT)
    # one global noding keeps every vertex on the lattice and shared by both sides of every edge
    work = np.ones(len(faces), bool)
    wf = faces
    winfo = list(info)
    lines = list(shapely.get_parts(shapely.MultiLineString(ls)))
    water = [f for f, d in zip(faces, info) if d["group"] == H_WATER]
    wlines = []
    if water:  # water: an 8 m grid, interior vertices carry the shore distance the water shader fades by
        wx0, wy0, wx1, wy1 = shapely.total_bounds(np.array(water, dtype=object))
        wlines += [shapely.LineString([(x, wy0), (x, wy1)]) for x in np.arange(math.ceil(wx0 / 8) * 8, wx1, 8.0)]
        wlines += [shapely.LineString([(wx0, y), (wx1, y)]) for y in np.arange(math.ceil(wy0 / 8) * 8, wy1, 8.0)]
    # clip the grid to soft / water faces: 32 m pieces x overlapping faces, one vectorised intersection
    pieces, wmask = [], []
    for ln, isw in [(ln, False) for ln in lines] + [(ln, True) for ln in wlines]:
        (ax, ay), (bx, by) = ln.coords[0], ln.coords[-1]
        L = math.hypot(bx - ax, by - ay)
        m = max(1, int(math.ceil(L / 32.0)))
        t = np.linspace(0, 1, m + 1)
        xs, ys = ax + (bx - ax) * t, ay + (by - ay) * t
        pieces.append(np.stack([np.column_stack([xs[:-1], ys[:-1]]), np.column_stack([xs[1:], ys[1:]])], 1))
        wmask.append(np.full(m, isw))
    segs = shapely.linestrings(np.concatenate(pieces)) if pieces else np.zeros(0, dtype=object)
    wmask = np.concatenate(wmask) if wmask else np.zeros(0, bool)
    softf = np.nonzero([d["group"] in (H_SOFT, H_WATER) for d in info])[0]
    fwat = np.array([info[f]["group"] == H_WATER for f in softf])
    clipped = []
    if len(segs) and len(softf):
        gi, fj = STRtree(faces[softf]).query(segs, predicate="intersects")
        keep_ = ~wmask[gi] | fwat[fj]  # the 8 m water grid only inside water
        gi, fj = gi[keep_], fj[keep_]
        cut = shapely.intersection(segs[gi], faces[softf][fj])
        parts_ = shapely.get_parts(cut)
        clipped = parts_[shapely.get_type_id(parts_) == 1]  # LineStrings only
    noded = shapely.union_all(np.concatenate([_unique_segments(wf), np.asarray(clipped, dtype=object)]), grid_size=GRID)
    faces2 = _polygonize(noded, B.ext)
    # parent: the work face containing the representative point (pieces inside fixed faces have none);
    # ambiguous or missed ones by largest overlap
    tree = STRtree(wf)
    rp = shapely.point_on_surface(faces2)
    fi, pi = tree.query(rp, predicate="intersects")
    parent = np.full(len(faces2), -1)
    cnt = np.bincount(fi, minlength=len(faces2))
    one = cnt[fi] == 1
    parent[fi[one]] = pi[one]
    amb = np.unique(np.concatenate([fi[~one], np.nonzero(cnt == 0)[0]]))  # ambiguous, or snapped outside every parent
    for i in amb:
        cand = tree.query(faces2[i], predicate="intersects")
        if len(cand):
            ov = shapely.area(shapely.intersection(wf[cand], faces2[i], grid_size=GRID))
            if ov.max() <= 0:  # a sliver made by snap-rounding: the neighbour sharing the longest edge
                ov = shapely.length(shapely.intersection(shapely.boundary(wf[cand]), shapely.boundary(faces2[i])))
            parent[i] = cand[int(np.argmax(ov))]
    B.stats["orphans"] = int(len(amb))
    ok = parent >= 0
    faces2, info2 = faces2[ok], [winfo[p] for p in parent[ok]]
    keep = ~shapely.is_empty(faces2) & (shapely.area(faces2) > 1e-6)
    faces2 = np.concatenate([faces[~work], faces2[keep]])
    info2 = [d for d, k in zip(info, work) if not k] + [d for d, k in zip(info2, keep) if k]
    B.stats["t_node2"] = time.time() - t0
    B.stats["cells_refined"] = nref
    return faces2, info2


# ---------------------------------------------------------------- mesh + heights

def triangulate(B: Build, faces, info):
    """CDT of every face inside the tile (vectorised). Returns faces, info, vertex coords,
    triangles (CCW in plan) and the face of each triangle."""
    inside = shapely.within(shapely.point_on_surface(faces), B.box)
    faces = faces[inside]
    info = [d for d, k in zip(info, inside) if k]
    tris = shapely.constrained_delaunay_triangles(faces)
    parts, fidx = shapely.get_parts(tris, return_index=True)
    co = shapely.get_coordinates(shapely.get_exterior_ring(parts)).reshape(len(parts), 4, 2)[:, :3]
    q = np.round(co.reshape(-1, 2) * 1e4).astype(np.int64)
    key = q[:, 0] * (1 << 32) + (q[:, 1] & 0xFFFFFFFF)
    uk, first, inv = np.unique(key, return_index=True, return_inverse=True)
    V = co.reshape(-1, 2)[first]
    T = inv.reshape(-1, 3).astype(np.int64)
    ok = (T[:, 0] != T[:, 1]) & (T[:, 1] != T[:, 2]) & (T[:, 0] != T[:, 2])
    T, TF = T[ok], fidx[ok].astype(np.int64)
    p0, p1, p2 = V[T[:, 0]], V[T[:, 1]], V[T[:, 2]]
    cw = (p1[:, 0] - p0[:, 0]) * (p2[:, 1] - p0[:, 1]) - (p2[:, 0] - p0[:, 0]) * (p1[:, 1] - p0[:, 1]) < 0
    T[cw] = T[cw][:, [0, 2, 1]]
    T, TF = fix_tjunctions(B, V, T, TF)
    return faces, info, V, T, TF


def _edge_counts(T):
    e = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
    lo, hi = np.minimum(e[:, 0], e[:, 1]), np.maximum(e[:, 0], e[:, 1])
    k = lo * (1 << 32) + hi
    uk, cnt = np.unique(k, return_counts=True)
    return uk, cnt


def fix_tjunctions(B: Build, V, T, TF):
    """Split every triangle whose edge is unmatched (not on the tile border) at the mesh vertices
    lying on that edge: the triangulation is watertight whatever the polygon ops dropped."""
    x0, y0, x1, y1 = B.box.bounds
    kd = cKDTree(V)
    for _ in range(3):
        uk, cnt = _edge_counts(T)
        single = uk[cnt == 1]
        a_, b_ = single >> 32, single & 0xFFFFFFFF
        pa, pb = V[a_], V[b_]
        border = ((np.abs(pa[:, 0] - pb[:, 0]) < 1e-6) & ((np.abs(pa[:, 0] - x0) < 1e-4) | (np.abs(pa[:, 0] - x1) < 1e-4))) | \
                 ((np.abs(pa[:, 1] - pb[:, 1]) < 1e-6) & ((np.abs(pa[:, 1] - y0) < 1e-4) | (np.abs(pa[:, 1] - y1) < 1e-4)))
        split: dict = {}
        for a, b, P0, P1 in zip(a_[~border].tolist(), b_[~border].tolist(), pa[~border], pb[~border]):
            d = P1 - P0
            L = float(np.hypot(*d))
            on = []
            for v in kd.query_ball_point((P0 + P1) / 2, L / 2 + 1e-6):
                if v in (a, b):
                    continue
                qv = V[v] - P0
                t = float(qv @ d) / (L * L)
                if 1e-6 < t < 1 - 1e-6 and abs(qv[0] * d[1] - qv[1] * d[0]) / L < 0.004:
                    on.append((t, v))
            if on:
                split[(a, b)] = [v for _, v in sorted(on)]
                split[(b, a)] = split[(a, b)][::-1]
        if not split:
            break
        hit = np.zeros(len(T), bool)
        sk = np.array([a * (1 << 32) + b for a, b in split], np.int64)
        for j in range(3):
            hit |= np.isin(T[:, j] * (1 << 32) + T[:, (j + 1) % 3], sk)
        keepT, keepF = T[~hit], TF[~hit]
        NT, NF = [], []
        for t, f in zip(T[hit].tolist(), TF[hit].tolist()):
            done = False
            for e in range(3):
                a, b, c = t[e], t[(e + 1) % 3], t[(e + 2) % 3]
                mids = split.get((a, b))
                if mids:
                    chain = [a] + mids + [b]
                    for i in range(len(chain) - 1):
                        NT.append([chain[i], chain[i + 1], c])
                        NF.append(f)
                    done = True
                    break
            if not done:
                NT.append(t)
                NF.append(f)
        T = np.concatenate([keepT, np.array(NT, np.int64).reshape(-1, 3)])
        TF = np.concatenate([keepF, np.array(NF, np.int64)])
    return T, TF


def pairs(T, TF):
    """unique (vertex, face) incidence pairs"""
    k = np.unique(T.ravel() * (1 << 32) + np.repeat(TF, 3))
    return k >> 32, k & 0xFFFFFFFF


def incidence(T, TF):
    inc: dict = {}
    for t, f in zip(T, TF):
        for v in t:
            inc.setdefault(int(v), set()).add(int(f))
    return inc


class Attrs:
    """Street-material attributes per (vertex, face) pair: rd rm jn col rows, looked up by key."""

    def __init__(self, nf):
        self.nf = nf
        self.keys, self.rd, self.rm, self.jn, self.col = [], [], [], [], []

    def add(self, v, f, rd, rm, jn, col):
        self.keys.append(np.asarray(v, np.int64) * self.nf + np.asarray(f, np.int64))
        n = len(self.keys[-1])
        B_ = lambda a, w: np.broadcast_to(np.asarray(a, np.float64), (n, w)) if np.ndim(a) == 1 else np.asarray(a, np.float64)  # noqa: E731
        self.rd.append(B_(rd, 4)); self.rm.append(B_(rm, 4)); self.jn.append(B_(jn, 4)); self.col.append(B_(col, 4))

    def done(self):
        if self.keys:
            k = np.concatenate(self.keys)
            o = np.argsort(k, kind="stable")
            self.K = k[o]
            self.RD, self.RM, self.JN, self.COL = (np.concatenate(x)[o] for x in (self.rd, self.rm, self.jn, self.col))
        else:
            self.K = np.zeros(0, np.int64)
            self.RD = self.RM = self.JN = self.COL = np.zeros((0, 4))
        return self

    def rows(self, v, f):
        """row index per (v, f) pair, -1 where absent"""
        k = np.asarray(v, np.int64) * self.nf + np.asarray(f, np.int64)
        i = np.searchsorted(self.K, k)
        i = np.clip(i, 0, max(len(self.K) - 1, 0))
        ok = (len(self.K) > 0) & (self.K[i] == k) if len(self.K) else np.zeros(len(k), bool)
        return np.where(ok, i, -1)


def inv_bilinear_v(p, A, B_, C, D):
    """Vectorised inverse bilinear with per-point corners (n, 2) each: returns t, w in [0, 1]."""
    e = B_ - A
    f = D - A
    g = A - B_ + C - D
    h = p - A
    cr = lambda a, b: a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0]  # noqa: E731
    k2 = cr(g, f)
    k1 = cr(e, f) + cr(h, g)
    k0 = cr(h, e)
    lin = np.abs(k2) < 1e-9 * np.maximum(1.0, np.abs(cr(e, f)))
    with np.errstate(divide="ignore", invalid="ignore"):
        wl = -k0 / np.where(np.abs(k1) < 1e-12, 1e-12, k1)
        disc = np.sqrt(np.maximum(k1 * k1 - 4 * k0 * k2, 0.0))
        k2s = np.where(lin, 1.0, k2)
        w1 = (-k1 - disc) / (2 * k2s)
        w2 = (-k1 + disc) / (2 * k2s)
        wq = np.where(np.abs(w1 - 0.5) <= np.abs(w2 - 0.5), w1, w2)
        w = np.where(lin, wl, wq)
        den = e + g * w[:, None]
        tx = (h[:, 0] - f[:, 0] * w) / np.where(np.abs(den[:, 0]) < 1e-12, 1e-12, den[:, 0])
        ty = (h[:, 1] - f[:, 1] * w) / np.where(np.abs(den[:, 1]) < 1e-12, 1e-12, den[:, 1])
    t = np.where(np.abs(den[:, 0]) > np.abs(den[:, 1]), tx, ty)
    return np.clip(np.nan_to_num(t), 0, 1), np.clip(np.nan_to_num(w), 0, 1)


def _road_z_v(R, k, t, u):
    zc = R["z"][k] + (R["z"][k + 1] - R["z"][k]) * t
    if R["cls"] >= 8:
        return zc
    if R["oneway"]:
        if R["cls"] <= 1:
            return zc + CROSSFALL * u
        return zc - CROSSFALL * (u + (R["pr"][k] - R["pl"][k]) / 2) * 0.5
    return zc - CROSSFALL * np.abs(u)


def _bands_eval(B: Build, R, k, bi, span, P):
    """Heights and attributes of band quads (k, bi) of one piece at points P: z, rd, rm, jn, col."""
    n = len(k)
    bands = R["bands"]
    U0 = np.array([bd["u0"] for bd in bands], np.float64)
    U1 = np.array([bd["u1"] for bd in bands], np.float64)
    x, y, ox, oy = R["x"], R["y"], R["ox"], R["oy"]
    C0 = np.column_stack([x[k], y[k]])
    C1 = np.column_stack([x[k + 1], y[k + 1]])
    o0 = np.column_stack([ox[k], oy[k]])
    o1 = np.column_stack([ox[k + 1], oy[k + 1]])
    u00, u01, u10, u11 = U0[bi, k], U0[bi, k + 1], U1[bi, k], U1[bi, k + 1]
    t, w = inv_bilinear_v(P, C0 + o0 * u00[:, None], C1 + o1 * u01[:, None], C1 + o1 * u11[:, None], C0 + o0 * u10[:, None])
    ua, ub = u00 + (u01 - u00) * t, u10 + (u11 - u10) * t
    u = ua + (ub - ua) * w
    L = lambda a_: a_[k] + (a_[k + 1] - a_[k]) * t  # noqa: E731
    s_ = L(R["s"])
    z = np.zeros(n)
    rd = np.zeros((n, 4)); rm = np.zeros((n, 4)); jn = np.tile([FAR, FAR, 0, 0], (n, 1)).astype(np.float64); col = np.zeros((n, 4))
    raised = np.array([bool(bands[b]["raised"]) for b in bi])
    net = np.array([bool(bands[b].get("net")) for b in bi])
    h = np.array([bands[b].get("h", 0.0) for b in bi])
    surf = np.array([bands[b].get("surf", 0) for b in bi])
    rgb = np.array([bands[b].get("rgb", (255, 255, 255)) for b in bi], np.float64).reshape(n, 3)
    # raised (curb-referenced) bands
    m = raised & net
    if m.any():
        REF = np.array([bands[b]["ref"] if "ref" in bands[b] else np.zeros(len(x)) for b in range(len(bands))])
        ref = REF[bi[m], k[m]] + (REF[bi[m], k[m] + 1] - REF[bi[m], k[m]]) * t[m]
        z[m] = _road_z_v(R, k[m], t[m], ref) + h[m] + WALK_RISE * np.abs(u[m] - ref)
        rd[m] = np.column_stack([u[m], s_[m], np.abs(ref), np.abs(ref)])
    m2 = raised & ~net
    if m2.any():
        side = np.where(ua[m2] + ub[m2] > 0, 1.0, -1.0)
        e = np.where(side > 0, L(R["pl"])[m2], L(R["pr"])[m2])
        rise0 = np.array([bands[b].get("rise0", 0.0) for b in bi[m2]])
        z[m2] = _road_z_v(R, k[m2], t[m2], side * e) + h[m2] + WALK_RISE * np.maximum(0.0, np.abs(u[m2]) - e - rise0)
        rd[m2] = np.column_stack([u[m2], s_[m2], e, e])
    mr = raised
    rm[mr] = np.column_stack([np.zeros(mr.sum()), 3 + 32 * surf[mr], np.full(mr.sum(), 3.5), np.zeros(mr.sum())])
    col[mr] = np.column_stack([rgb[mr], np.full(mr.sum(), 175.0)])
    # lanes
    ml = ~raised
    if ml.any():
        z[ml] = _road_z_v(R, k[ml], t[ml], u[ml])
        mn = ml & net
        if mn.any():
            a_ = _model_lane_attrs_v(B, P[mn])
            rd[mn], rm[mn], jn[mn], col[mn] = a_
        mm = ml & ~net
        if mm.any():
            kk = np.where(t[mm] < 0.5, k[mm], k[mm] + 1)
            feats = R["feats"]
            sp = span[mm]
            fs = np.array([ft["s"] for ft in feats] + [0.0])
            fa = np.array([ft["after"] for ft in feats] + [0.0])
            fb = np.array([ft["before"] for ft in feats] + [0.0])
            nf_ = len(feats)
            hp = sp > 0
            hn = sp < nf_
            spp = np.clip(sp - 1, 0, max(nf_ - 1, 0)) if nf_ else np.zeros_like(sp)
            spn = np.clip(sp, 0, max(nf_ - 1, 0)) if nf_ else np.zeros_like(sp)
            sv = s_[mm]
            jn[mm] = np.column_stack([np.where(hp, sv - fs[spp], FAR), np.where(hn, fs[spn] - sv, FAR),
                                      np.where(hp, fa[spp], 0), np.where(hn, fb[spn], 0)])
            fxv = R["fx"] | np.where(R["sw"][kk] & MEDIAN_L, FX_DIVIDED, 0)
            rd[mm] = np.column_stack([u[mm], sv, L(R["el"])[mm], L(R["er"])[mm]])
            rm[mm] = np.column_stack([R["mk"][kk], np.full(mm.sum(), R["code0"] + 32 * R["surf"]), L(R["lw"])[mm], fxv])
            col[mm] = np.tile(list(R["tint"]) + [int(round(R["prio"] * 25))], (mm.sum(), 1))
    return z, rd, rm, jn, col


def _rail_eval(B: Build, uid, owners, P):
    """Vectorised _rail_at over points of one rail piece."""
    R = B.rails[uid]
    k = np.array([o[2] for o in owners], np.int64)
    u0 = np.array([o[4] for o in owners], np.float64)
    u1 = np.array([o[5] for o in owners], np.float64)
    kind = np.array([o[6] for o in owners], np.int64)
    x, y, ox, oy = R["x"], R["y"], R["ox"], R["oy"]
    C0 = np.column_stack([x[k], y[k]])
    C1 = np.column_stack([x[k + 1], y[k + 1]])
    o0 = np.column_stack([ox[k], oy[k]])
    o1 = np.column_stack([ox[k + 1], oy[k + 1]])
    t, w = inv_bilinear_v(P, C0 + o0 * u0[:, None], C1 + o1 * u0[:, None], C1 + o1 * u1[:, None], C0 + o0 * u1[:, None])
    u = u0 + (u1 - u0) * w
    z = R["z"][k] + (R["z"][k + 1] - R["z"][k]) * t
    s_ = R["s"][k] + (R["s"][k + 1] - R["s"][k]) * t
    hw, wt = R["hw"], R["hw"] - 0.6
    au = np.abs(u)
    zb = np.where(au <= wt, BALLAST_TOP, BALLAST_EDGE + (BALLAST_TOP - BALLAST_EDGE) * np.maximum(0.0, hw - au) / 0.6)
    z = z + np.where(kind == 0, zb, np.where(kind == 1, 0.03, 0.07))
    bc = (140, 134, 128) if R["cls"] == 2 else (140, 140, 130) if R["cls"] == 3 else (150, 140, 128)
    surf = np.where(kind == 0, SURF_BALLAST, np.where(kind == 1, SURF_GRASS, SURF_PANEL))
    n = len(P)
    col = np.where((kind == 0)[:, None], np.array(bc + (int(0.5 * 25),)), np.where((kind == 1)[:, None], np.array((235, 255, 225, int(7.1 * 25))), np.array((255, 255, 255, int(6.2 * 25)))))
    rd = np.column_stack([u, s_, np.full(n, hw), np.full(n, hw)])
    rm = np.column_stack([np.zeros(n), R["cls"] + 32 * surf, np.full(n, 3.6), np.zeros(n)])
    jn = np.tile([FAR, FAR, 0, 0], (n, 1)).astype(np.float64)
    return z, rd, rm, jn, col.astype(np.float64)


def _model_lane_attrs_v(B: Build, P):
    """Vectorised _model_lane_attrs: marking attributes from the nearest model road piece."""
    n = len(P)
    rd = np.zeros((n, 4)); rm = np.zeros((n, 4)); jn = np.tile([FAR, FAR, 0, 0], (n, 1)).astype(np.float64); col = np.zeros((n, 4))
    rm[:, 1] = 3 + 32 * SURF_ROAD
    col[:] = (255, 255, 255, 125)
    if getattr(B, "_lane_kd", None) is None:
        pts, ref = [], []
        for uid, R in B.pieces.items():
            if R.get("net2") or R["cls"] > 7:
                continue
            for kq in range(len(R["x"])):
                pts.append((R["x"][kq], R["y"][kq]))
                ref.append((uid, kq))
        B._lane_kd = (cKDTree(np.array(pts)), ref) if pts else (None, None)
    kd, ref = B._lane_kd
    if kd is None:
        return rd, rm, jn, col
    _, ii = kd.query(P)
    for j in range(n):
        at = _model_lane_attrs(B, P[j], ref[ii[j]])
        rd[j], rm[j], jn[j], col[j] = at["rd"], at["rm"], at["jn"], at["col"]
    return rd, rm, jn, col


def fixed_heights(B: Build, V, inc, info):
    """Paved / track / cut / water heights per (vertex, group), conformed (mean of the incident
    faces' rules), and street attributes per (vertex, face). `inc` is (pv, pf) pair arrays or a
    {vertex: faces} dict. Vectorised per piece."""
    t0 = time.time()
    if isinstance(inc, dict):
        pv = np.fromiter((v for v, fs in inc.items() for _ in fs), np.int64)
        pf = np.fromiter((f for _, fs in inc.items() for f in fs), np.int64)
    else:
        pv, pf = inc
    nf = len(info)
    A = Attrs(nf)
    zp = np.full(len(pv), np.nan)
    gp = np.array([info[f]["group"] for f in pf], np.int64) if len(pf) else np.zeros(0, np.int64)
    kind = np.array([info[f]["owner"][0] for f in pf]) if len(pf) else np.zeros(0, "<U4")
    P = V[pv] if len(pv) else np.zeros((0, 2))
    # 1. bands, per piece
    mb = kind == "b"
    if mb.any():
        idx = np.nonzero(mb)[0]
        own = [info[pf[i]]["owner"] for i in idx]
        groups: dict = {}
        for i, o in zip(idx, own):
            groups.setdefault(o[1], []).append(i)
        for uid, ii in groups.items():
            ii = np.array(ii)
            R = B.pieces[uid]
            k = np.array([info[pf[i]]["owner"][2] for i in ii], np.int64)
            bi = np.array([info[pf[i]]["owner"][3] for i in ii], np.int64)
            sp = np.array([info[pf[i]]["owner"][4] for i in ii], np.int64)
            z, rd, rm, jn, col = _bands_eval(B, R, k, bi, sp, P[ii])
            zp[ii] = z
            A.add(pv[ii], pf[ii], rd, rm, jn, col)
    zp[mb & ~np.isin(gp, [H_ROAD, H_WALK])] = np.nan  # paths (soft group): attributes only
    # 2. junctions: model centreline samples, inverse distance over 6, same level only
    mj = (kind == "j") & (gp == H_ROAD)
    if mj.any():
        ckd, cz = B.centreline_index()
        ii = np.nonzero(mj)[0]
        if ckd is not None:
            dist, idx = ckd.query(P[ii], k=6)
            zz = cz[idx]
            same = np.abs(zz - zz[:, :1]) < 1.0
            w = np.where(same, 1 / (dist ** 2 + 0.25), 0)
            zp[ii] = (w * zz).sum(1) / w.sum(1)
        else:
            zp[ii] = B.nat(P[ii, 0], P[ii, 1])
        A.add(pv[ii], pf[ii], [0, 0, 0, 0], [0, 3 + 32 * SURF_ROAD, 3.5, 0], [FAR, FAR, 0, 0], [255, 255, 255, 145])
    # net2 node boxes: the box patch (primgeom), exactly; no patch -> the centreline blend
    mjn = (kind == "jn") & (gp == H_ROAD)
    if mjn.any():
        ii = np.nonzero(mjn)[0]
        z = np.full(len(ii), np.nan)
        pat = getattr(B, "net2_patch", None)
        if pat is not None:
            T3, tree = pat
            own_t = np.array([info[pf[i]]["owner"][1] for i in ii])
            z = _tri_z(T3, tree, P[ii], own_t)
        miss = np.isnan(z)
        if miss.any():
            ckd, cz_ = B.centreline_index()
            if ckd is not None:
                dist, idx = ckd.query(P[ii[miss]], k=6)
                zz = cz_[idx]
                w = np.where(np.abs(zz - zz[:, :1]) < 1.0, 1 / (dist ** 2 + 0.25), 0)
                z[miss] = (w * zz).sum(1) / w.sum(1)
            else:
                z[miss] = B.nat(P[ii[miss], 0], P[ii[miss], 1])
        zp[ii] = z
        A.add(pv[ii], pf[ii], [0, 0, 0, 0], [0, 3 + 32 * SURF_ROAD, 3.5, 0], [FAR, FAR, 0, 0], [255, 255, 255, 145])
    # net2 corners: the curves' walk-top z (curb return / walk edge / building line + nc_h)
    mnc = (kind == "nc") & (gp == H_WALK)
    if mnc.any() and getattr(B, "net2_corner_pts", None) is not None:
        ii = np.nonzero(mnc)[0]
        ckd2, cz2 = B.net2_corner_pts
        dist, idx = ckd2.query(P[ii], k=4)
        zz = cz2[idx]
        w = np.where(np.abs(zz - zz[:, :1]) < 1.0, 1 / (dist ** 2 + 1e-4), 0)
        zp[ii] = (w * zz).sum(1) / w.sum(1)
        cl = np.array([info[pf[i]]["cls"] for i in ii])
        surf = np.where(cl == SC_PAVERS, SURF_PAVERS, SURF_SIDEWALK)
        A.add(pv[ii], pf[ii], np.zeros((len(ii), 4)), np.column_stack([np.zeros(len(ii)), 3 + 32 * surf, np.full(len(ii), 3.5), np.zeros(len(ii))]),
              np.tile([FAR, FAR, 0, 0], (len(ii), 1)), np.column_stack([np.where(cl == SC_PAVERS, 214, 255), np.where(cl == SC_PAVERS, 196, 255), np.where(cl == SC_PAVERS, 186, 255), np.full(len(ii), 175)]))
    # road heights so far (conformed), for the generic walk rule
    mr = (gp == H_ROAD) & ~np.isnan(zp)
    rv, inv = np.unique(pv[mr], return_inverse=True)
    rz = np.bincount(inv, zp[mr], len(rv)) / np.maximum(np.bincount(inv, None, len(rv)), 1)
    rkd = cKDTree(V[rv]) if len(rv) else None
    # 3. generic walks (corner walks, medians, ROW slabs, platforms)
    mw = (gp == H_WALK) & (kind != "b") & ~((kind == "nc") & (getattr(B, "net2_corner_pts", None) is not None))
    if mw.any():
        ii = np.nonzero(mw)[0]
        base = B.nat(P[ii, 0], P[ii, 1])
        dd = np.zeros(len(ii))
        if rkd is not None:
            dd, j = rkd.query(P[ii])
            near = dd < 30
            base = np.where(near, rz[np.minimum(j, len(rz) - 1)], base)
        own = [info[pf[i]]["owner"] for i in ii]
        hh = np.array([0.12 if (o[0] == "m" and o[1] == 2) or o[0] == "row" else 0.25 if o[0] == "plat" else CURB_H + 0.02 if o[0] == "m" else CURB_H for o in own])
        zp[ii] = base + hh + WALK_RISE * np.minimum(dd, 3.0)
        cl = np.array([info[pf[i]]["cls"] for i in ii])
        surf = np.where(np.isin(cl, [SC_MEDIAN_GRASS, SC_BLVD]), SURF_GRASS, np.where(cl == SC_TRANSIT_ROW, SURF_PANEL, SURF_SIDEWALK))
        A.add(pv[ii], pf[ii], np.zeros((len(ii), 4)), np.column_stack([np.zeros(len(ii)), 3 + 32 * surf, np.full(len(ii), 3.5), np.zeros(len(ii))]),
              np.tile([FAR, FAR, 0, 0], (len(ii), 1)), np.tile([255, 255, 255, 175], (len(ii), 1)))
    # 4a. net2 rail corridor (tpipe.primrail): shared bed cells on the bed mesh, slope triangles exact
    kn = np.where(gp == H_RAIL, kind, "")
    for tag, setname in (("nb", "net2_bed"), ("ns", "net2_slope")):
        mm = np.nonzero(kn == tag)[0]
        ts = getattr(B, setname, None)
        if not len(mm) or ts is None:
            continue
        T3, tree = ts
        own_t = np.array([info[pf[i]]["owner"][1] for i in mm]) if tag == "ns" else None
        z = _tri_z(T3, tree, P[mm], own_t)
        miss = np.isnan(z)
        if miss.any():  # on the outline (numerics): nearest triangle vertex
            from scipy.spatial import cKDTree as _K
            V3 = T3.reshape(-1, 3)
            _, j = _K(V3[:, :2]).query(P[mm[miss]])
            z[miss] = V3[j, 2]
        zp[mm] = z
        n_ = len(mm)
        bal = np.array([info[pf[i]]["cls"] == SC_BALLAST for i in mm])
        A.add(pv[mm], pf[mm], np.tile([0.0, 0.0, 1.8, 1.8], (n_, 1)),
              np.column_stack([np.zeros(n_), np.where(bal, 32 * SURF_BALLAST, 32 * SURF_GRASS), np.full(n_, 3.6), np.zeros(n_)]),
              np.tile([FAR, FAR, 0, 0], (n_, 1)), np.where(bal[:, None], np.array((150, 140, 128, 12)), np.array((235, 255, 225, 177))))
    # 4. rail beds, cut floors, water
    mrl = np.nonzero((gp == H_RAIL) & ~np.isin(kn, ["nb", "ns"]))[0] if len(pf) else np.zeros(0, np.int64)
    if len(mrl):
        groups_r: dict = {}
        for i in mrl:
            groups_r.setdefault(info[pf[i]]["owner"][1], []).append(i)
        for uid, ii in groups_r.items():
            ii = np.array(ii)
            z, rd, rm, jn, col = _rail_eval(B, uid, [info[pf[i]]["owner"] for i in ii], P[ii])
            zp[ii] = z
            A.add(pv[ii], pf[ii], rd, rm, jn, col)
    for i in np.nonzero(gp == H_CUT)[0]:
        zp[i] = _cut_floor(B, P[i])
    mwt = gp == H_WATER
    if mwt.any():
        for i in np.nonzero(mwt)[0]:
            zp[i] = _water_level(B, info[pf[i]]["owner"], P[i])
    A.done()
    # crossing panels keep their owner's height and coordinates, with the panel look
    if len(A.K):
        fpan = np.array([info[f]["cls"] == SC_PANEL for f in range(nf)])
        rows_f = A.K % nf
        pm = fpan[rows_f]
        A.RM[pm] = [0, 3 + 32 * SURF_PANEL, 3.5, 0]
        A.COL[pm] = [255, 255, 255, int(6.2 * 25)]
    # conform: mean per (vertex, group)
    ok = ~np.isnan(zp) & np.isin(gp, list(FIXED) + [H_WATER])
    key = pv[ok] * 8 + gp[ok]
    uk, inv = np.unique(key, return_inverse=True)
    zm = np.bincount(inv, zp[ok], len(uk)) / np.bincount(inv, None, len(uk))
    Hg = {(int(k_ // 8), int(k_ % 8)): float(z_) for k_, z_ in zip(uk, zm)}
    B.stats["t_h_fixed"] = B.stats.get("t_h_fixed", 0) + time.time() - t0
    return Hg, A


def _tri_z(T3, tree, P, own=None):
    """z at plan points P on a triangle set T3 (m, 3, 3): the containing triangle's plane (`own`:
    a triangle index per point to use first, -1 none); NaN where no triangle holds the point."""
    z = np.full(len(P), np.nan)
    if not len(P):
        return z
    qi, ti = tree.query(shapely.points(P), predicate="intersects")
    if own is not None:
        has = own >= 0
        qi = np.concatenate([np.nonzero(has)[0], qi])
        ti = np.concatenate([own[has], ti])
    # first hit per point
    _, first = np.unique(qi, return_index=True)
    qi, ti = qi[first], ti[first]
    A_, B_, C_ = T3[ti, 0], T3[ti, 1], T3[ti, 2]
    p_ = P[qi]
    d = (B_[:, 1] - C_[:, 1]) * (A_[:, 0] - C_[:, 0]) + (C_[:, 0] - B_[:, 0]) * (A_[:, 1] - C_[:, 1])
    ok = np.abs(d) > 1e-12
    d = np.where(ok, d, 1.0)
    l1 = ((B_[:, 1] - C_[:, 1]) * (p_[:, 0] - C_[:, 0]) + (C_[:, 0] - B_[:, 0]) * (p_[:, 1] - C_[:, 1])) / d
    l2 = ((C_[:, 1] - A_[:, 1]) * (p_[:, 0] - C_[:, 0]) + (A_[:, 0] - C_[:, 0]) * (p_[:, 1] - C_[:, 1])) / d
    zz = l1 * A_[:, 2] + l2 * B_[:, 2] + (1 - l1 - l2) * C_[:, 2]
    z[qi[ok]] = zz[ok]
    return z


def soft_heights(B: Build, V, T, TF, info, Hg, env):
    """Soft ground: natural ground (DTM) clamped into the cut / fill envelope of the fixed boundary;
    a soft vertex on a fixed edge within SNAP of it joins it; never below adjacent water."""
    t1 = time.time()
    L, U, gx0, gy0 = env
    fsoft = np.array([d["group"] == H_SOFT for d in info])
    sv = np.unique(T[fsoft[TF]])
    if len(sv):
        P = V[sv]
        nat = B.nat(P[:, 0], P[:, 1])
        hs = smin(smax(nat, _sample(L, gx0, gy0, P), SMOOTH_K), _sample(U, gx0, gy0, P), SMOOTH_K)
        best = np.full(len(sv), np.inf)
        snap = hs.copy()
        for g in FIXED:
            z = np.array([Hg.get((int(v), g), np.nan) for v in sv])
            d = np.abs(hs - z)
            m = (d < SNAP) & (d < best)
            snap[m] = z[m]
            best[m] = d[m]
        wz = np.array([Hg.get((int(v), H_WATER), np.nan) for v in sv])
        snap = np.where(~np.isnan(wz) & (snap < wz + 0.05), wz + 0.05, snap)
        for v, h in zip(sv.tolist(), snap.tolist()):
            Hg[(v, H_SOFT)] = h
    B.stats["t_soft"] = time.time() - t1


def envelope(B: Build, S):
    """Lower (fill) and upper (cut) cone envelopes of the fixed boundary samples S (x, y, z) on a 1 m raster."""
    t0 = time.time()
    X0, Y0 = B.x0 - MARGIN, B.y0 - MARGIN
    n = int((S0 + 2 * MARGIN) / ENV_CELL) + 1
    L = np.full((n, n), -1e9, np.float32)
    U = np.full((n, n), 1e9, np.float32)
    if len(S):
        x, y, z = S[:, 0], S[:, 1], S[:, 2]
        i = np.clip(np.round((x - X0) / ENV_CELL).astype(int), 0, n - 1)
        j = np.clip(np.round((y - Y0) / ENV_CELL).astype(int), 0, n - 1)
        np.maximum.at(L, (j, i), z.astype(np.float32))
        np.minimum.at(U, (j, i), z.astype(np.float32))
        dirs = [(0, 1, 1.0), (1, 0, 1.0), (0, -1, 1.0), (-1, 0, 1.0), (1, 1, math.sqrt(2)), (1, -1, math.sqrt(2)), (-1, 1, math.sqrt(2)), (-1, -1, math.sqrt(2))]
        for _ in range(int(ENV_REACH / ENV_CELL)):
            L0, U0 = L.copy(), U.copy()
            for di, dj, st in dirs:
                sl_dst = (slice(max(dj, 0), n + min(dj, 0)), slice(max(di, 0), n + min(di, 0)))
                sl_src = (slice(max(-dj, 0), n + min(-dj, 0)), slice(max(-di, 0), n + min(-di, 0)))
                np.maximum(L[sl_dst], L0[sl_src] - st * ENV_CELL / FILL_K, out=L[sl_dst])
                np.minimum(U[sl_dst], U0[sl_src] + st * ENV_CELL / CUT_K, out=U[sl_dst])
        # distance-field union of the fills: close the narrow valleys between neighbouring cones
        # (parallel tracks / carriageways share one berm; slopes only on the outer edges), same for cuts
        from scipy import ndimage
        L = ndimage.grey_closing(L, size=(BERM_CLOSE, BERM_CLOSE))
        U = ndimage.grey_opening(U, size=(BERM_CLOSE, BERM_CLOSE))
    xs = X0 + np.arange(n) * ENV_CELL
    ys = Y0 + np.arange(n) * ENV_CELL
    gx, gy = np.meshgrid(xs, ys)
    nat = B.nat(gx, gy).astype(np.float32)
    target = smin(smax(nat, L, SMOOTH_K), U, SMOOTH_K)
    B.stats["t_envelope"] = time.time() - t0
    return (L, U, X0, Y0), (target, X0, Y0)


BERM_CLOSE = 7  # m (1 m cells): valleys narrower than this between fill cones are filled
SMOOTH_K = 0.4  # m: polynomial smooth max / min blend between the terrain and the cone envelopes


def smax(a, b, k):
    h = np.maximum(k - np.abs(a - b), 0) / k
    return np.maximum(a, b) + h * h * k * 0.25


def smin(a, b, k):
    return -smax(-a, -b, k)


def _sample(G, x0, y0, P):
    n = G.shape[0]
    fx = np.clip((P[:, 0] - x0) / ENV_CELL, 0, n - 1.001)
    fy = np.clip((P[:, 1] - y0) / ENV_CELL, 0, n - 1.001)
    i, j = np.floor(fx).astype(int), np.floor(fy).astype(int)
    u, v = fx - i, fy - j
    return (G[j, i] * (1 - u) + G[j, i + 1] * u) * (1 - v) + (G[j + 1, i] * (1 - u) + G[j + 1, i + 1] * u) * v


def _plain_attr(surf, cls, rgb, prio):
    return dict(rd=[0.0, 0.0, 0.0, 0.0], rm=[0, cls + 32 * surf, 3.5, 0], jn=[FAR, FAR, 0, 0], col=(rgb[0], rgb[1], rgb[2], int(round(prio * 25))))


def _road_z(R, k, t, u):
    """Carriageway surface z at station (k, t), lateral offset u (+ left): model z + crossfall."""
    zc = float(R["z"][k] + (R["z"][k + 1] - R["z"][k]) * t)
    if R["cls"] >= 8:
        return zc
    if R["oneway"]:
        return zc + CROSSFALL * u if R["cls"] <= 1 else zc - CROSSFALL * (u + (R["pr"][k] - R["pl"][k]) / 2) * 0.5
    return zc - CROSSFALL * abs(u)


def _band_at(B: Build, o, p):
    """Height and street-material attributes of band `o` at point p."""
    _, uid, k, bi, span = o
    R = B.pieces[uid]
    bd = R["bands"][bi]
    C0 = np.array([R["x"][k], R["y"][k]])
    C1 = np.array([R["x"][k + 1], R["y"][k + 1]])
    o0 = np.array([R["ox"][k], R["oy"][k]])
    o1 = np.array([R["ox"][k + 1], R["oy"][k + 1]])
    u00, u01, u10, u11 = bd["u0"][k], bd["u0"][k + 1], bd["u1"][k], bd["u1"][k + 1]
    t, w = inv_bilinear(np.asarray(p, np.float64)[None], C0 + o0 * u00, C1 + o1 * u01, C1 + o1 * u11, C0 + o0 * u10)
    t, w = float(t[0]), float(w[0])
    ua, ub = u00 + (u01 - u00) * t, u10 + (u11 - u10) * t
    u = ua + (ub - ua) * w
    L = lambda a: float(a[k] + (a[k + 1] - a[k]) * t)  # noqa: E731
    s = L(R["s"])
    kk = k if t < 0.5 else k + 1
    if bd.get("net"):
        if bd["raised"]:
            ref = L(bd["ref"])
            z = _road_z(R, k, t, ref) + bd["h"] + WALK_RISE * max(0.0, abs(u - ref))
            rgb = bd.get("rgb", (255, 255, 255))
            return z, dict(rd=[u, s, abs(ref), abs(ref)], rm=[0, 3 + 32 * bd["surf"], 3.5, 0], jn=[FAR, FAR, 0, 0], col=rgb + (175,))
        z = _road_z(R, k, t, u)
        return z, _model_lane_attrs(B, np.asarray(p, np.float64))
    if bd["raised"]:
        side = 1 if (ua + ub) > 0 else -1
        e = L(R["pl"]) if side > 0 else L(R["pr"])
        z = _road_z(R, k, t, side * e) + bd["h"] + WALK_RISE * max(0.0, abs(u) - e - bd.get("rise0", 0.0))
        rgb = bd.get("rgb", (255, 255, 255))
        at = dict(rd=[u, s, e, e], rm=[0, 3 + 32 * bd["surf"], 3.5, 0], jn=[FAR, FAR, 0, 0], col=rgb + (175,))
        return z, at
    z = _road_z(R, k, t, u)
    feats = R["feats"]
    fp = feats[span - 1] if span > 0 else None
    fn = feats[span] if span < len(feats) else None
    jn = [s - fp["s"] if fp else FAR, fn["s"] - s if fn else FAR, fp["after"] if fp else 0, fn["before"] if fn else 0]
    fx = R["fx"] | (FX_DIVIDED if R["sw"][kk] & MEDIAN_L else 0)
    col = R["tint"] + (int(round(R["prio"] * 25)),)
    at = dict(rd=[u, s, L(R["el"]), L(R["er"])], rm=[int(R["mk"][kk]), R["code0"] + 32 * R["surf"], L(R["lw"]), fx], jn=jn, col=col)
    return z, at


def _decimate_run(run, juncs, xmap, tol_xy=0.05, tol_z=0.02, tol_u=0.02, maxlen=24.0):
    """Drop model stations the surface does not need (fillet arcs are sampled ~1 m apart): keep a
    station where dropping it would move the plan > 5 cm, z > 2 cm or any cross-section offset
    > 2 cm, where flags / marks / sidewalk bits change, and at junction / crossing nodes."""
    n = len(run["x"])
    if n <= 2:
        return run
    P = np.column_stack([run["x"], run["y"], run["z"]]).astype(np.float64)
    sd = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(P[:, :2], axis=0).T))])
    Ub = np.array([np.asarray(run[k], np.float64) for k in ("pl", "pr", "el", "er", "lw", "wl", "wr")])
    hard = np.zeros(n, bool)
    hard[0] = hard[-1] = True
    for k in ("mk", "vf", "sw"):
        a = np.asarray(run[k])
        ch = np.nonzero(a[1:] != a[:-1])[0]
        hard[ch] = True
        hard[ch + 1] = True
    for i in range(n):
        key = _hkey(run["x"][i], run["y"][i])
        if key in juncs or key in xmap:
            hard[i] = True
    dup = np.r_[False, sd[1:] - sd[:-1] < 1e-6]  # duplicated (lane-change) stations: keep both
    hard |= dup | np.r_[dup[1:], False]
    keep = [0]
    i = 0
    while i < n - 1:
        j = i + 1
        while j < n - 1 and not hard[j]:
            c = j + 1
            if sd[c] - sd[i] > maxlen:
                break
            t = (sd[i + 1:c] - sd[i]) / max(sd[c] - sd[i], 1e-9)
            lin = P[i] + (P[c] - P[i]) * t[:, None]
            if np.abs(lin[:, :2] - P[i + 1:c, :2]).max() > tol_xy or np.abs(lin[:, 2] - P[i + 1:c, 2]).max() > tol_z:
                break
            lu = Ub[:, i][:, None] + (Ub[:, c] - Ub[:, i])[:, None] * t[None]
            if np.abs(lu - Ub[:, i + 1:c]).max() > tol_u:
                break
            j = c
        keep.append(j)
        i = j
    keep = np.array(keep)
    if len(keep) == n:
        return run
    out = {}
    for k, v in run.items():
        out[k] = np.asarray(v)[keep] if hasattr(v, "__len__") and len(v) == n else v
    # the stroke distance keeps the model's own s (dash phase continuity)
    return out


def _decimate(P, sd, Ub, events, tol_xy=0.05, tol_z=0.02, tol_u=0.02, maxlen=16.0):
    """Indices of stations to keep so linear interpolation between kept stations reproduces the
    dropped ones within the tolerances (greedy forward)."""
    n = len(P)
    keep = [0]
    ev = np.array(events) if len(events) else np.zeros(0)
    i = 0
    while i < n - 1:
        j = i + 1
        while j + 1 < n:
            c = j + 1
            if sd[c] - sd[i] > maxlen or (len(ev) and np.any((ev > sd[i] + 1e-3) & (ev < sd[c] - 1e-3))):
                break
            t = (sd[i + 1:c] - sd[i]) / max(sd[c] - sd[i], 1e-9)
            lin = P[i] + (P[c] - P[i]) * t[:, None]
            if np.abs(lin[:, :2] - P[i + 1:c, :2]).max() > tol_xy or np.abs(lin[:, 2] - P[i + 1:c, 2]).max() > tol_z:
                break
            if len(Ub):
                lu = Ub[:, i][:, None] + (Ub[:, c] - Ub[:, i])[:, None] * t[None]
                if np.abs(lu - Ub[:, i + 1:c]).max() > tol_u:
                    break
            j = c
        keep.append(j)
        i = j
    return np.array(keep)


def _model_lane_attrs(B: Build, p, near=None):
    """Street-material marking attributes at p from the nearest model road piece (the primitive
    network's lanes follow the same model centrelines, so u / s / edge lines / marks carry over)."""
    if getattr(B, "_lane_kd", None) is None:
        pts, ref = [], []
        for uid, R in B.pieces.items():
            if R.get("net2") or R["cls"] > 7:
                continue
            for k in range(len(R["x"])):
                pts.append((R["x"][k], R["y"][k]))
                ref.append((uid, k))
        B._lane_kd = (cKDTree(np.array(pts)), ref) if pts else (None, None)
    kd, ref = B._lane_kd
    if kd is None:
        return _plain_attr(SURF_ROAD, 3, (255, 255, 255), 5.0)
    if near is None:
        _, i = kd.query(p)
        near = ref[i]
    uid, k = near
    R = B.pieces[uid]
    n = len(R["x"])
    best = None
    for k0 in (k - 1, k):
        if 0 <= k0 < n - 1:
            a = np.array([R["x"][k0], R["y"][k0]])
            d = np.array([R["x"][k0 + 1], R["y"][k0 + 1]]) - a
            L2 = float(d @ d)
            if L2 < 1e-9:
                continue
            t = float(np.clip((p - a) @ d / L2, 0, 1))
            q = a + d * t
            dist = float(np.hypot(*(p - q)))
            if best is None or dist < best[0]:
                u = float(d[0] * (p[1] - a[1]) - d[1] * (p[0] - a[0])) / math.sqrt(L2)
                best = (dist, k0, t, u)
    if best is None:
        return _plain_attr(SURF_ROAD, 3, (255, 255, 255), 5.0)
    _, k0, t, u = best
    L = lambda a_: float(a_[k0] + (a_[k0 + 1] - a_[k0]) * t)  # noqa: E731
    sv = L(R["s"])
    feats = R["feats"]
    span = sum(1 for ft in feats if ft["s"] <= sv + 1e-4)
    fp = feats[span - 1] if span > 0 else None
    fn = feats[span] if span < len(feats) else None
    kk = k0 if t < 0.5 else k0 + 1
    jn = [sv - fp["s"] if fp else FAR, fn["s"] - sv if fn else FAR, fp["after"] if fp else 0, fn["before"] if fn else 0]
    fx = R["fx"] | (FX_DIVIDED if R["sw"][kk] & MEDIAN_L else 0)
    return dict(rd=[u, sv, L(R["el"]), L(R["er"])], rm=[int(R["mk"][kk]), R["code0"] + 32 * R["surf"], L(R["lw"]), fx],
                jn=jn, col=R["tint"] + (int(round(R["prio"] * 25)),))


def infer_bands(R, feats):
    """Cross-section bands of a road piece inferred from the network model's per-vertex offsets
    and sidewalk bits (docs/CROSS_SECTION.md). The model's own bands replace this when present:
    each band = dict(kind, cls, group, prio, u0, u1 (signed lateral offsets per station, + left),
    on (bool per station), raised (curb-referenced height), h, surf)."""
    c = R["cls"]
    n = len(R["x"])
    pl, pr = np.asarray(R["pl"], np.float64), np.asarray(R["pr"], np.float64)
    allv = np.ones(n, bool)
    bands = []
    if c >= 8:
        bands.append(dict(kind="path", cls=SC_PATH, group=H_SOFT, prio=P_TRACK if c == 9 else P_PATH, u0=-pr, u1=pl, on=allv, raised=False))
        return bands
    prio = P_ROAD + (9 - c) * 0.1
    if R["oneway"]:
        bands.append(dict(kind="lane", cls=SC_ROAD, group=H_ROAD, prio=prio, u0=-pr, u1=pl, on=allv, raised=False))
    else:  # crowned: the crown line is a band edge
        bands.append(dict(kind="lane", cls=SC_ROAD, group=H_ROAD, prio=prio, u0=np.zeros(n), u1=pl, on=allv, raised=False))
        bands.append(dict(kind="lane", cls=SC_ROAD, group=H_ROAD, prio=prio, u0=-pr, u1=np.zeros(n), on=allv, raised=False))
    if not 2 <= c <= 6:
        return bands
    # walks only outside junction boxes
    clear, s0 = [], R["s"][0]
    for ft in feats:
        e = ft["s"] - ft["cb"]
        if e - s0 > 0.5:
            clear.append((s0, e))
        s0 = max(s0, ft["s"] + ft["ca"])
    if R["s"][-1] - s0 > 0.5:
        clear.append((s0, R["s"][-1]))
    inclear = np.array([any(a - 1e-3 <= sv <= b + 1e-3 for a, b in clear) for sv in R["s"]])
    ws = SIDEWALK_W[c]
    sw = R["sw"]
    for side in (1, -1):
        bit, blvd = (SW_L, BLVD_L) if side > 0 else (SW_R, BLVD_R)
        on = ((sw & bit) != 0) & inclear
        if not on.any():
            continue
        e = pl if side > 0 else pr
        wb = np.asarray(R["wl"] if side > 0 else R["wr"], np.float64)
        has_blvd = (sw & blvd) != 0
        has_pav = ((sw & PAVERS) != 0) & ~has_blvd
        inner = np.where(has_blvd, BLVD_W, np.where(has_pav, PAVER_W, 0.0))
        if has_blvd.any():
            bands.append(dict(kind="boulevard", cls=SC_BLVD, group=H_WALK, prio=P_VERGE, u0=side * e, u1=side * (e + BLVD_W),
                              on=on & has_blvd, raised=True, h=CURB_H, surf=SURF_GRASS))
        if has_pav.any():
            bands.append(dict(kind="furniture", cls=SC_PAVERS, group=H_WALK, prio=P_VERGE, u0=side * e, u1=side * (e + PAVER_W),
                              on=on & has_pav, raised=True, h=CURB_H, surf=SURF_PAVERS, rgb=(214, 196, 186)))
        walk = np.where(wb > 0, np.maximum(ws, wb - inner), ws)
        bands.append(dict(kind="sidewalk", cls=SC_WALK, group=H_WALK, prio=P_WALK, u0=side * (e + inner), u1=side * (e + inner + walk),
                          on=on, raised=True, h=CURB_H, surf=SURF_SIDEWALK))
    return bands


def _rail_at(B: Build, o, p):
    _, uid, k, st, u0, u1, kind = o
    R = B.rails[uid]
    C0 = np.array([R["x"][k], R["y"][k]])
    C1 = np.array([R["x"][k + 1], R["y"][k + 1]])
    o0 = np.array([R["ox"][k], R["oy"][k]])
    o1 = np.array([R["ox"][k + 1], R["oy"][k + 1]])
    t, w = inv_bilinear(np.asarray(p, np.float64)[None], C0 + o0 * u0, C1 + o1 * u0, C1 + o1 * u1, C0 + o0 * u1)
    t, w = float(t[0]), float(w[0])
    u = u0 + (u1 - u0) * w
    z = float(R["z"][k] + (R["z"][k + 1] - R["z"][k]) * t)
    s = float(R["s"][k] + (R["s"][k + 1] - R["s"][k]) * t)
    hw, wt = R["hw"], R["hw"] - 0.6
    if kind == 0:
        au = abs(u)
        z += BALLAST_TOP if au <= wt else BALLAST_EDGE + (BALLAST_TOP - BALLAST_EDGE) * max(0.0, hw - au) / 0.6
        surf, rgb, pr = SURF_BALLAST, ((140, 134, 128) if R["cls"] == 2 else (140, 140, 130) if R["cls"] == 3 else (150, 140, 128)), 0.5
    elif kind == 1:
        z += 0.03
        surf, rgb, pr = SURF_GRASS, (235, 255, 225), 7.1
    else:
        z += 0.07
        surf, rgb, pr = SURF_PANEL, (255, 255, 255), 6.2
    at = dict(rd=[u, s, hw, hw], rm=[0, R["cls"] + 32 * surf, 3.6, 0], jn=[FAR, FAR, 0, 0], col=rgb + (int(pr * 25),))
    return z, at


def _cut_floor(B: Build, p):
    best, z = 1e18, float(B.nat(*p)) - 3
    for seg in B.cut_tracks:
        d = np.hypot(seg[:, 0] - p[0], seg[:, 1] - p[1])
        i = int(np.argmin(d))
        if d[i] < best:
            best, z = d[i], float(seg[i, 2]) - 0.25
    return z


def _water_level(B: Build, o, p):
    _, level, tile, _rapids = o
    if level is not None:
        return level
    f = B.water_level.get(tile)
    if f is None:
        return float(B.nat(*p))
    x, y = p[0] - tile[0] * S0, p[1] - tile[1] * S0
    fc = S0 / 32
    fx, fy = min(max(x / fc, 0), 31.9999), min(max(y / fc, 0), 31.9999)
    i, j = int(fx), int(fy)
    u, v = fx - i, fy - j
    return float((f[j, i] * (1 - u) + f[j, i + 1] * u) * (1 - v) + (f[j + 1, i] * (1 - u) + f[j + 1, i + 1] * u) * v)


# ---------------------------------------------------------------- emit

EMB_CLS = 39  # embankment / cut slope grass (ground material)
WALL_CLS = {G_WALL, G_BANK, G_DOCK, SC_CURBFACE}


def _okey_str(d):
    o = d["owner"]
    if o[0] == "b":
        return ("b", o[1], o[3], o[4])
    if o[0] == "l":
        return ("l", o[1], o[3])
    return (o[0],)


def _water_kind(o):
    _, level, _tile, rapids = o
    if rapids:
        return 3
    if level is None:
        return 2
    return 0 if min(abs(level + 0.3), abs(level - 99.2)) < 0.05 else 1  # Lake Ontario / Lake Erie


def emit(B: Build, V, T, TF, info, Hg, A):
    """Runs of triangles (class + owner) with corner positions (x, y, z) and per-corner attributes.
    Returns M = dict(runs=[...]) where each run: cls, street (bool), flags, corners (k, 3) position
    xyz, attr rows (street: index into A or -1), extra (ground: water shore distance / wall along)."""
    t0 = time.time()
    m = len(T)
    cls_f = np.array([d["cls"] for d in info])
    grp_f = np.array([d["group"] for d in info])
    cls_t, grp_t = cls_f[TF], grp_f[TF]
    # corner heights (vertex, group)
    zc = np.empty((m, 3))
    for j in range(3):
        zc[:, j] = [Hg.get((int(v), int(g)), np.nan) for v, g in zip(T[:, j], grp_t)]
    miss = np.isnan(zc)
    if miss.any():
        pv = V[T[miss]]
        zc[miss] = B.nat(pv[:, 0], pv[:, 1])
    # embankment / cut slopes: soft ground the envelope moved by > 0.5 m -> slope grass
    soft_t = (grp_t == H_SOFT) & (cls_t < 64) & (cls_t != C_WATER)
    if soft_t.any():
        pv = V[T[soft_t]].reshape(-1, 2)
        nat = B.nat(pv[:, 0], pv[:, 1]).reshape(-1, 3)
        moved = np.abs(zc[soft_t] - nat).mean(1) > 0.5
        idx = np.nonzero(soft_t)[0][moved]
        cls_t = cls_t.copy()
        cls_t[idx] = EMB_CLS
    # faces: class per face (a face is embankment grass when most of its triangles are)
    nfc = len(info)
    emb_votes = np.bincount(TF, cls_t == EMB_CLS, nfc)
    tri_n = np.bincount(TF, None, nfc)
    face_cls = np.where((emb_votes > 0.5 * np.maximum(tri_n, 1)) & (grp_f == H_SOFT), EMB_CLS, cls_f)
    # boundary loops of every face (edges used once within the face, directed as in its CCW triangles)
    loops = _face_loops(T, TF, nfc)
    okeys = [_okey_str(d) for d in info]
    runs: dict = {}
    for f, lp in loops.items():
        c = int(face_cls[f])
        if c >= 64:
            key = (1, c, okeys[f])
        elif c == C_WATER:
            key = (0, c, _water_kind(info[f]["owner"]))
        else:
            key = (0, c)
        runs.setdefault(key, []).append(f)
    # corner z per (vertex, group)
    def zof(vs, g):
        z = np.array([Hg.get((int(v), int(g)), np.nan) for v in vs])
        if np.isnan(z).any():
            P_ = V[vs[np.isnan(z)]]
            z[np.isnan(z)] = B.nat(P_[:, 0], P_[:, 1])
        return z
    # triangles per face (for faces that are not a convex fan)
    ftri: dict = {}
    for ti, f in enumerate(TF.tolist()):
        ftri.setdefault(f, []).append(ti)
    out = []
    for key, fs in runs.items():
        faces_out = []
        for f in fs:
            lps = []
            for lp in loops[f]:
                lp = np.asarray(lp)
                xyz = np.column_stack([V[lp], zof(lp, grp_f[f])])
                rows = A.rows(lp, np.full(len(lp), f)) if key[0] == 1 else None
                lps.append((xyz, rows))
            local = None
            apex = _fan_apex(V[np.asarray(loops[f][0])]) if len(loops[f]) == 1 else None
            if apex:  # rotate so the fan starts at a clean apex (no zero-area fan triangles)
                lp0 = list(np.roll(np.asarray(loops[f][0]), -apex))
                loops[f][0] = lp0
                xyz, rows = lps[0]
                lps[0] = (np.roll(xyz, -apex, axis=0), None if rows is None else np.roll(rows, -apex))
            if apex is None:
                allv = np.concatenate([np.asarray(lp) for lp in loops[f]])
                pos = {v: i for i, v in enumerate(allv.tolist())}
                tt = T[ftri[f]]
                try:
                    local = np.array([[pos[v] for v in t] for t in tt.tolist()], np.int64)
                except KeyError:  # a triangle vertex off the face boundary (should not happen): fall back to fan
                    local = None
            faces_out.append((lps, local))
        out.append(dict(cls=key[1], street=key[0] == 1, flags=key[2] if key[1] == C_WATER else 0, faces=faces_out))
    # water: per-corner shore distance (to the nearest non-water vertex)
    wt = cls_t == C_WATER
    if wt.any():
        land = np.unique(T[~wt & (cls_t < 64)])
        kd = cKDTree(V[land]) if len(land) else None
        for run in out:
            if run["cls"] == C_WATER:
                for lps, _ in run["faces"]:
                    for j, (xyz, rows) in enumerate(lps):
                        d = kd.query(xyz[:, :2], distance_upper_bound=32)[0] if kd is not None else np.full(len(xyz), 32.0)
                        lps[j] = (xyz, rows, np.minimum(d, 32))
    # ---- walls: face boundaries where the two sides' heights differ
    e = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
    et = np.tile(np.arange(m), 3)
    ez = np.concatenate([zc[:, [0, 1]], zc[:, [1, 2]], zc[:, [2, 0]]])
    lo, hi = np.minimum(e[:, 0], e[:, 1]), np.maximum(e[:, 0], e[:, 1])
    k = lo * (1 << 32) + hi
    o = np.argsort(k, kind="stable")
    ks = k[o]
    first = np.r_[True, ks[1:] != ks[:-1]]
    cnt = np.diff(np.r_[np.nonzero(first)[0], len(ks)])
    starts = np.nonzero(first)[0]
    two = starts[cnt == 2]
    i1, i2 = o[two], o[two + 1]
    t1, t2 = et[i1], et[i2]
    g1, g2 = grp_t[t1], grp_t[t2]
    # heights of the edge's two vertices on each side (align by vertex ids)
    same_dir = e[i1, 0] == e[i2, 0]
    za1, zb1 = ez[i1, 0], ez[i1, 1]
    za2 = np.where(same_dir, ez[i2, 0], ez[i2, 1])
    zb2 = np.where(same_dir, ez[i2, 1], ez[i2, 0])
    step = (g1 != g2) & (np.maximum(np.abs(za1 - za2), np.abs(zb1 - zb2)) >= WALL_MIN)
    walls = []
    for j in np.nonzero(step)[0]:
        a_, b_ = int(e[i1[j], 0]), int(e[i1[j], 1])  # directed as in triangle t1 (t1's face on its left)
        if za1[j] + zb1[j] < za2[j] + zb2[j]:  # t1 is the lower side: faces left of a->b
            A_, B_v, glo, ghi, flo, fhi = a_, b_, g1[j], g2[j], TF[t1[j]], TF[t2[j]]
            zl = (za1[j], zb1[j]); zh = (za2[j], zb2[j])
        else:  # t2 lower: in t2 the edge runs b->a with t2's face on the left
            A_, B_v, glo, ghi, flo, fhi = b_, a_, g2[j], g1[j], TF[t2[j]], TF[t1[j]]
            zl = (zb2[j], za2[j]); zh = (zb1[j], za1[j])
        pair = {int(glo), int(ghi)}
        if pair in ({H_ROAD, H_WALK}, {H_RAIL, H_WALK}, {H_ROAD, H_RAIL}):
            wcls = SC_CURBFACE
        elif H_WATER in pair:
            other = cls_f[fhi] if grp_f[flo] == H_WATER else cls_f[flo]
            wcls = G_DOCK if other >= 64 or other in (C_PLAZA, C_COM, 27) else G_BANK
        else:
            wcls = G_WALL
        walls.append((A_, B_v, int(glo), int(ghi), wcls, zl, zh))
    # chain + merge straight runs (plan within 2 cm, heights linear within 1 cm)
    nxt: dict = {}
    for i, w in enumerate(walls):
        nxt.setdefault((w[0], w[2], w[3], w[4]), []).append(i)
    has_prev = {j for w in walls for j in nxt.get((w[1], w[2], w[3], w[4]), [])}
    used = np.zeros(len(walls), bool)
    quads: dict = {}
    nwall = 0
    for i0 in [i for i in range(len(walls)) if i not in has_prev] + list(range(len(walls))):
        if used[i0]:
            continue
        chain = [i0]
        used[i0] = True
        while True:
            w = walls[chain[-1]]
            cand = [j for j in nxt.get((w[1], w[2], w[3], w[4]), []) if not used[j]]
            if not cand:
                break
            chain.append(cand[0])
            used[cand[0]] = True
        wcls = walls[i0][4]
        pts = [walls[chain[0]][0]] + [walls[c][1] for c in chain]
        zl = [walls[chain[0]][5][0]] + [walls[c][5][1] for c in chain]
        zh = [walls[chain[0]][6][0]] + [walls[c][6][1] for c in chain]
        k0, along = 0, 0.0
        while k0 < len(pts) - 1:
            k1 = k0 + 1
            while k1 + 1 < len(pts) and _linear(V, pts, zl, zh, k0, k1 + 1):
                k1 += 1
            pa, pb = V[pts[k0]], V[pts[k1]]
            L = float(np.hypot(*(pb - pa)))
            # loop A_lo, A_hi, B_hi, B_lo: faces left of a -> b (the lower side); bottoms exactly on
            # the lower surface so the positions are shared with it
            q = np.array([[pa[0], pa[1], zl[k0]], [pa[0], pa[1], zh[k0]], [pb[0], pb[1], zh[k1]], [pb[0], pb[1], zl[k1]]])
            al = np.array([along, along, along + L, along + L])
            quads.setdefault(wcls, []).append((q, al))
            along += L
            nwall += 1
            k0 = k1
    for wcls, lst in quads.items():
        out.append(dict(cls=wcls, street=wcls >= 64, flags=0, wall=True,
                        faces=[([(q, np.full(4, -1) if wcls >= 64 else None, al)], None) for q, al in lst]))
    # open edges (QA): single edges off the tile border
    single = starts[cnt == 1]
    sa, sb = e[o[single], 0], e[o[single], 1]
    pa, pb = V[sa], V[sb]
    bx0, by0, bx1, by1 = B.box.bounds
    border = ((np.abs(pa[:, 0] - pb[:, 0]) < 1e-6) & ((np.abs(pa[:, 0] - bx0) < 1e-4) | (np.abs(pa[:, 0] - bx1) < 1e-4))) | \
             ((np.abs(pa[:, 1] - pb[:, 1]) < 1e-6) & ((np.abs(pa[:, 1] - by0) < 1e-4) | (np.abs(pa[:, 1] - by1) < 1e-4)))
    B.stats.update(t_emit=time.time() - t0, walls=nwall, open_edges=int((~border).sum() + (cnt > 2).sum()))
    return dict(runs=out, A=A)


def earcut_full(pts, sizes):
    """earcut of a face (outer loop then holes, local coords (n, 2)) keeping every loop vertex: earcut
    drops exactly collinear points, so each dropped run is re-inserted by splitting the triangle on
    that loop edge. Returns (m, 3) local indices CCW, or None if the result does not cover the face.
    Mirrored in app/src/workers/surface.ts (earcutFull) and qa/checks_surface.py."""
    import mapbox_earcut
    ends = np.cumsum(sizes).astype(np.uint32)
    t = mapbox_earcut.triangulate_float64(np.ascontiguousarray(pts, np.float64), ends).reshape(-1, 3).astype(np.int64)
    if not len(t):
        return None
    tris = [list(x) for x in t.tolist()]
    used = set(t.ravel().tolist())
    start = 0
    for n in sizes:
        idx = list(range(start, start + n))
        start += n
        if not any(i in used for i in idx):
            return None
        m = len(idx)
        k0 = next(j for j in range(m) if idx[j] in used)
        j = k0
        while True:
            a = idx[j]
            chain = []
            j2 = (j + 1) % m
            while idx[j2] not in used:
                chain.append(idx[j2])
                j2 = (j2 + 1) % m
            b = idx[j2]
            if chain:
                hit = None
                for ti, tr in enumerate(tris):
                    for e in range(3):
                        if {tr[e], tr[(e + 1) % 3]} == {a, b}:
                            hit = (ti, e)
                            break
                    if hit:
                        break
                if hit is None:
                    return None
                ti, e = hit
                tr = tris[ti]
                u_, c = tr[e], tr[(e + 2) % 3]
                ch = [a] + chain + [b] if u_ == a else [b] + chain[::-1] + [a]
                tris[ti] = [ch[0], ch[1], c]
                for q in range(1, len(ch) - 1):
                    tris.append([ch[q], ch[q + 1], c])
            j = j2
            if j == k0:
                break
    T_ = np.array(tris, np.int64)
    P = np.asarray(pts, np.float64)
    cr = (P[T_[:, 1], 0] - P[T_[:, 0], 0]) * (P[T_[:, 2], 1] - P[T_[:, 0], 1]) - (P[T_[:, 2], 0] - P[T_[:, 0], 0]) * (P[T_[:, 1], 1] - P[T_[:, 0], 1])
    T_[cr < 0] = T_[cr < 0][:, [0, 2, 1]]
    if (np.abs(cr) < 1e-9).any():  # earcut emitted a zero-area triangle over a collinear run: not safe
        return None
    # verify: every loop vertex used, every loop edge is a triangle edge (no T-junction along the
    # face boundary), and the plan area equals the face area
    if len(set(T_.ravel().tolist())) != int(np.sum(sizes)):
        return None
    te = {(int(a), int(b)) for tr in T_.tolist() for a, b in ((tr[0], tr[1]), (tr[1], tr[2]), (tr[2], tr[0]))}
    st = 0
    for n in sizes:
        for i in range(n):
            a, b = st + i, st + (i + 1) % n
            if (a, b) not in te and (b, a) not in te:
                return None
        st += n
    area = 0.0
    st = 0
    for n in sizes:
        r = P[st:st + n]
        a_ = 0.5 * float(np.sum(r[:, 0] * np.roll(r[:, 1], -1) - np.roll(r[:, 0], -1) * r[:, 1]))
        area += a_ if st == 0 else -abs(a_)
        st += n
    if abs(0.5 * np.abs(cr).sum() - abs(area)) > 1e-4 + 1e-6 * abs(area):
        return None
    return T_


def _fan_apex(P):
    """Index of a fan apex for a convex CCW ring such that no fan triangle is degenerate: the apex
    and both its neighbours turn strictly (callers test `is None`; 0 is valid). Plain Python: rings
    are short."""
    pts = P.tolist()
    n = len(pts)
    cr = []
    for i in range(n):
        (x0, y0), (x1, y1), (x2, y2) = pts[i - 1], pts[i], pts[(i + 1) % n]
        c = (x1 - x0) * (y2 - y1) - (y1 - y0) * (x2 - x1)
        if c < -1e-9:
            return None
        cr.append(c > 1e-9)
    for i in range(n):
        if cr[i] and cr[i - 1] and cr[(i + 1) % n]:
            return i
    return None


def _convex(P):
    """convex (collinear allowed) CCW ring? -> a fan from vertex 0 triangulates it keeping every vertex"""
    d1 = np.roll(P, -1, 0) - P
    d2 = np.roll(P, -2, 0) - np.roll(P, -1, 0)
    cr = d1[:, 0] * d2[:, 1] - d1[:, 1] * d2[:, 0]
    return bool((cr >= -1e-9).all())


def _face_loops(T, TF, nf):
    """{face: [loop vertex arrays]}: boundary edges of each face's triangles (used once within the
    face), chained in their CCW direction; outer loop first (largest |area|)."""
    e = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
    f = np.tile(TF, 3)
    lo, hi = np.minimum(e[:, 0], e[:, 1]), np.maximum(e[:, 0], e[:, 1])
    k = (f.astype(np.int64) << 42) | (lo << 21) | hi
    uk, inv, cnt = np.unique(k, return_inverse=True, return_counts=True)
    bnd = cnt[inv] == 1
    fe, ea, eb = f[bnd], e[bnd, 0], e[bnd, 1]
    o = np.argsort(fe, kind="stable")
    fe, ea, eb = fe[o], ea[o], eb[o]
    starts = np.r_[0, np.nonzero(np.diff(fe))[0] + 1, len(fe)]
    out = {}
    for i in range(len(starts) - 1):
        a0, a1 = starts[i], starts[i + 1]
        nxt: dict = {}
        for a, b in zip(ea[a0:a1].tolist(), eb[a0:a1].tolist()):
            nxt.setdefault(a, []).append(b)
        loops = []
        while nxt:
            a = next(iter(nxt))
            lp = [a]
            while True:
                bs = nxt.get(a)
                if not bs:
                    break
                b = bs.pop()
                if not bs:
                    del nxt[a]
                if b == lp[0]:
                    break
                lp.append(b)
                a = b
            if len(lp) >= 3:
                loops.append(lp)
        out[int(fe[a0])] = loops
    return out


def _linear(V, pts, zl, zh, k0, k2):
    """Is pts[k0..k2] one straight wall (plan within 2 cm of the chord, heights within 1 cm of linear)?"""
    P0, P2 = V[pts[k0]], V[pts[k2]]
    d = P2 - P0
    L = float(np.hypot(*d))
    if L < 1e-6:
        return False
    for k in range(k0 + 1, k2):
        q = V[pts[k]] - P0
        t = float(q @ d) / (L * L)
        if not 0 < t < 1 or abs(q[0] * d[1] - q[1] * d[0]) / L > 0.02:
            return False
        if abs(zl[k0] + (zl[k2] - zl[k0]) * t - zl[k]) > 0.01 or abs(zh[k0] + (zh[k2] - zh[k0]) * t - zh[k]) > 0.01:
            return False
    return True


def build_tile(tiles: Tiles, tx: int, ty: int):
    t0 = time.time()
    B = Build(tiles, tx, ty)
    B.roads()
    B.rail()
    B.net2_rail()
    B.tram_row()
    B.rail_yards()
    B.driveways()
    B.ground()
    B.structures()
    B.relevel_dtm()
    B.stats["t_sources"] = time.time() - t0
    B.stats["sources"] = len(B.sources)
    B.stats["dtm"] = bool(B.dtm)
    faces, info, _ = arrange(B)
    faces, info = dissolve(B, faces, info)
    env, target = envelope(B, wall_seeds(B, seeds(B, faces, info)))
    faces, info = refine_soft(B, faces, info, target)
    t1 = time.time()
    faces, info, V, T, TF = triangulate(B, faces, info)
    B.stats["t_cdt"] = time.time() - t1
    Hg, A = fixed_heights(B, V, pairs(T, TF), info)
    soft_heights(B, V, T, TF, info, Hg, env)
    M = emit(B, V, T, TF, info, Hg, A)
    p = V[T]
    area = 0.5 * np.abs((p[:, 1, 0] - p[:, 0, 0]) * (p[:, 2, 1] - p[:, 0, 1]) - (p[:, 2, 0] - p[:, 0, 0]) * (p[:, 1, 1] - p[:, 0, 1]))
    B.stats.update(area=float(area.sum()), top_tris=len(T), tris=len(T) + 2 * B.stats["walls"], faces=len(faces),
                   t_total=time.time() - t0)
    B.debug = dict(V=V, T=T, TF=TF, info=info, faces=faces, Hg=Hg)
    return B, M


def _varint(a):
    """unsigned LEB128 byte stream of a u32 array (vectorised)"""
    a = np.asarray(a, np.uint64)
    n = np.ones(len(a), np.int64)
    for k in (7, 14, 21, 28):
        n += a >= (1 << k)
    out = np.zeros(int(n.sum()), np.uint8)
    pos = np.concatenate([[0], np.cumsum(n)[:-1]])
    for b in range(5):
        m = n > b
        byte = (a[m] >> np.uint64(7 * b)) & np.uint64(0x7F)
        byte = byte | np.where(n[m] > b + 1, 0x80, 0).astype(np.uint64)
        out[pos[m] + b] = byte.astype(np.uint8)
    return out


def _morton(x, y):
    def part(v):
        v = v.astype(np.uint64) & np.uint64(0xFFFF)
        v = (v | (v << np.uint64(8))) & np.uint64(0x00FF00FF)
        v = (v | (v << np.uint64(4))) & np.uint64(0x0F0F0F0F)
        v = (v | (v << np.uint64(2))) & np.uint64(0x33333333)
        v = (v | (v << np.uint64(1))) & np.uint64(0x55555555)
        return v
    return part(x) | (part(y) << np.uint64(1))


RUN_STREET, RUN_WALL = 1, 2


def _zigzag(d):
    d = np.asarray(d, np.int64)
    return np.where(d >= 0, 2 * d, -2 * d - 1).astype(np.uint64)


def arrays(B: Build, M) -> dict:
    """sf_* tile arrays, format v3 (docs/SURFACE.md "Tile arrays"): the partition's faces as
    boundary loops over shared positions; the client triangulates each face (earcut; walls as
    quads). Faces in Morton order; class per run; street attributes per street-run vertex."""
    runs = sorted(M["runs"], key=lambda r: (r["street"], r["cls"]))
    A = M["A"]
    F = []  # (run id, loops [(xyz, rows, extra)])
    L = []  # local triangles per face (None = fan)
    for ri, r in enumerate(runs):
        for lps, local in r["faces"]:
            lps = [(lp[0], lp[1], lp[2] if len(lp) > 2 else None) for lp in lps]
            F.append((ri, lps))
            L.append(local)
    cen = np.array([lps[0][0][:, :2].mean(0) for _, lps in F])
    order = np.argsort(_morton(((cen[:, 0] - B.x0) / 16).astype(np.int64), ((cen[:, 1] - B.y0) / 16).astype(np.int64)), kind="stable")
    F = [F[i] for i in order]
    L = [L[i] for i in order]
    # face kind: 0 fan over the loop (convex), 1 earcut (+ collinear re-insertion, verified here),
    # 2 explicit local triangles (earcut failed on this face)
    fk = np.zeros(len(F), np.uint8)
    for i, ((ri, lps), lt) in enumerate(zip(F, L)):
        if lt is None:
            continue
        loc = np.concatenate([xyz[:, :2] for xyz, _, _ in lps]) - [B.x0, B.y0]
        loc = np.round(loc / GRID) * GRID  # the client sees the quantised coordinates
        if earcut_full(loc, [len(xyz) for xyz, _, _ in lps]) is not None:
            fk[i] = 1
            L[i] = None
        else:
            fk[i] = 2
    ntl = np.array([0 if lt is None else len(lt) for lt in L], np.int64)
    tl = np.concatenate([lt.ravel() for lt in L if lt is not None]) if (ntl > 0).any() else np.zeros(0, np.int64)
    B.stats["faces_fan"], B.stats["faces_earcut"], B.stats["faces_explicit"] = int((fk == 0).sum()), int((fk == 1).sum()), int((fk == 2).sum())
    X = np.concatenate([xyz for _, lps in F for xyz, _, _ in lps])
    run_c = np.concatenate([np.full(len(xyz), ri) for ri, lps in F for xyz, _, _ in lps])
    rows = np.concatenate([rw if rw is not None else np.full(len(xyz), -1) for _, lps in F for xyz, rw, _ in lps])
    extra = np.concatenate([ex if ex is not None else np.zeros(len(xyz)) for _, lps in F for xyz, _, ex in lps])
    qx = np.clip(np.round((X[:, 0] - B.x0) / GRID), 0, 32768).astype(np.int64)
    qy = np.clip(np.round((X[:, 1] - B.y0) / GRID), 0, 32768).astype(np.int64)
    z0 = float(np.floor(X[:, 2].min()))
    qz = np.clip(np.round((X[:, 2] - z0) * 100), 0, 65535).astype(np.int64)
    key = (qx << 32) | (qy << 16) | qz
    uk, first, inv = np.unique(key, return_index=True, return_inverse=True)
    po = np.argsort(first, kind="stable")
    rank = np.empty(len(po), np.int64)
    rank[po] = np.arange(len(po))
    pidx = rank[inv]
    pk = uk[po]
    px, py, pz = pk >> 32, (pk >> 16) & 0xFFFF, pk & 0xFFFF
    hw = np.maximum.accumulate(np.concatenate([[-1], pidx[:-1]])) + 1
    code = (hw - pidx).astype(np.uint64)
    # vertices: first appearance of (run, position)
    _, vfirst = np.unique(run_c * (1 << 32) + pidx, return_index=True)
    vfirst = np.sort(vfirst)
    street_run = np.array([r["street"] for r in runs])
    extra_run = np.array([(r["cls"] == C_WATER or bool(r.get("wall"))) and not r["street"] for r in runs])
    sv = vfirst[street_run[run_c[vfirst]]]
    ev = vfirst[extra_run[run_c[vfirst]]]
    r_ = rows[sv]
    has = r_ >= 0
    g = lambda T_, d: np.where(has[:, None], T_[np.maximum(r_, 0)], np.array(d, np.float64)) if len(A.K) else np.tile(np.array(d, np.float64), (len(r_), 1))  # noqa: E731
    RD, RM = g(A.RD, [0, 0, 0, 0]), g(A.RM, [0, 3 + 32 * SURF_SIDEWALK, 3.5, 0])
    JN, CO = g(A.JN, [FAR, FAR, 0, 0]), g(A.COL, [255, 255, 255, 175])
    curb = np.array([runs[run_c[c]]["cls"] == SC_CURBFACE for c in sv], bool)
    RD[curb, 1] = extra[sv[curb]]
    RM[curb, 1] = 3 + 32 * SURF_CURB
    vdm = np.round(RD[:, 1] * 10).astype(np.int64)
    # junction distances: per run when they are v - fpS / fnS - v with constant feature codes (model
    # band runs: the span is fixed per run); otherwise per vertex
    vr = run_c[sv]
    jn_run = np.zeros((len(runs), 4))  # fpS, fnS, featPrev, featNext (FAR sentinel -> 1e9)
    per_v = np.zeros(len(runs), bool)
    for ri in np.unique(vr):
        m_ = vr == ri
        v_ = RD[m_, 1]
        jp, jnx, fa, fb = JN[m_, 0], JN[m_, 1], JN[m_, 2], JN[m_, 3]
        fpS = np.where(jp >= FAR - 1, 1e9, v_ - jp)
        fnS = np.where(jnx >= FAR - 1, 1e9, v_ + jnx)
        if np.ptp(fpS) < 0.02 and np.ptp(fnS) < 0.02 and np.ptp(fa) == 0 and np.ptp(fb) == 0:
            jn_run[ri] = [np.median(fpS), np.median(fnS), fa[0], fb[0]]
        else:
            per_v[ri] = True
    pvm = per_v[vr]
    vbase = np.zeros(len(runs))
    for ri in np.unique(vr):
        vbase[ri] = np.floor(vdm[vr == ri].min() / 10.0)
    cm = lambda x: np.clip(np.round(x * 100), -32768, 32767).astype(np.int16)  # noqa: E731
    ecls = np.array([runs[run_c[c]]["cls"] for c in ev])
    ext_q = np.where(ecls == C_WATER, np.round(extra[ev] * 8), np.round(extra[ev] * 10) % 65536)
    flags = np.array([int(r["flags"]) | (RUN_STREET << 4 if r["street"] else 0) | (RUN_WALL << 4 if r.get("wall") else 0) for r in runs])
    return {
        "sf_pos": _varint(_zigzag(np.concatenate([np.diff(np.concatenate([[0], px])), np.diff(np.concatenate([[0], py]))]))),  # dx..., dy... (1/32 m), zigzag varint
        "sf_pz": _varint(_zigzag(np.diff(np.concatenate([[0], pz])))),  # z deltas (cm), zigzag varint
        "sf_z0": np.array([z0], np.float32),
        "sf_npos": np.array([len(pk)], np.uint32),
        "sf_idx": _varint(code),
        "sf_run": np.column_stack([[r["cls"] for r in runs], flags]).astype(np.uint8).ravel(),
        "sf_face": _varint(np.array([ri for ri, _ in F], np.uint64)),
        "sf_nl": np.array([len(lps) for _, lps in F], np.uint8),
        "sf_ln": _varint(np.array([len(xyz) for _, lps in F for xyz, _, _ in lps], np.uint64)),
        "sf_fk": fk,
        "sf_nt": np.clip(ntl[fk == 2], 0, 65535).astype(np.uint16),  # triangle count of each explicit face
        "sf_tl": _varint(tl.astype(np.uint64)),  # local corner indices of the explicit triangles
        "sf_su": np.clip(np.round(RD[:, 0] * 50), -32768, 32767).astype(np.int16),  # u in 2 cm
        "sf_rv": vbase.astype(np.float32),  # per run: v base (m)
        "sf_sv": np.clip(vdm - np.round(vbase[vr] * 10).astype(np.int64), 0, 65535).astype(np.uint16),  # v - base, dm
        "sf_se": np.column_stack([cm(RD[:, 2]), cm(RD[:, 3])]).ravel(),
        "sf_smk": RM[:, 0].astype(np.uint32),
        "sf_scode": RM[:, 1].astype(np.uint16),
        "sf_slw": np.clip(np.round(RM[:, 2] * 10), 0, 255).astype(np.uint8),
        "sf_sfx": RM[:, 3].astype(np.uint8),
        "sf_rjn": np.column_stack([jn_run[:, :2], jn_run[:, 2:]]).astype(np.float32).ravel(),  # per run: fpS, fnS, featPrev, featNext
        "sf_rjv": per_v.astype(np.uint8),  # 1: this run's vertices carry jn in sf_sjn / sf_sjf
        "sf_sjn": np.column_stack([np.clip(JN[pvm, 0], -3000, 3000) * 10, np.clip(JN[pvm, 1], -3000, 3000) * 10]).round().astype(np.int16).ravel(),
        "sf_sjf": np.clip(np.round(JN[pvm, 2:] * 10), 0, 65535).astype(np.uint16).ravel(),
        "sf_scol": CO.astype(np.uint8).ravel(),
        "sf_gx": ext_q.astype(np.uint16),
    }


# ---------------------------------------------------------------- driver

_TILES: Tiles | None = None
_OUT: Path | None = None


def _job(key):
    try:
        return _job1(key)
    except Exception as ex:  # fail loudly, naming the tile
        raise RuntimeError(f"tpipe.surface: tile {key[0]},{key[1]} failed: {ex!r}") from ex


def _job1(key):
    import os
    import resource
    tx, ty = key
    B, M = build_tile(_TILES, tx, ty)
    # the surface must be watertight and cover the tile exactly (docs/SURFACE.md guarantees)
    if B.stats.get("open_edges", 0) or abs(B.stats["area"] - S0 * S0) > 0.5:
        raise RuntimeError(f"surface not watertight: open edges {B.stats.get('open_edges')}, area {B.stats['area']:.2f}")
    src = _TILES.get(tx, ty)
    a, h = src
    arr = {k: v for k, v in a.items() if not k.startswith("sf_") and not k.startswith("_")}
    sf = arrays(B, M)
    dk = B.deck_tris()
    if len(dk):
        dk = dk.copy()
        dk[:, :, 0] -= tx * S0
        dk[:, :, 1] -= ty * S0
        keep = (dk[:, :, 0].max(1) > -1) & (dk[:, :, 0].min(1) < S0 + 1) & (dk[:, :, 1].max(1) > -1) & (dk[:, :, 1].min(1) < S0 + 1)
        if keep.any():
            sf["sf_dk_xyz"] = dk[keep].reshape(-1).astype(np.float32)  # deck tops (tile-local x, y, z) for heightAt
    if tx_dtm := _TILES.dtm_src.get((tx, ty)):
        B.stats["dtm_lidar_share"] = round(tx_dtm, 4)
    arr.update(sf)
    extra = {k: v for k, v in h.items() if k != "arrays"}
    path = _OUT / "tiles" / "0" / f"{tx}_{ty}.bin.gz"
    if path.is_symlink():
        path.unlink()
    # atomic: neighbours may be read by another worker while this one is written (in-place runs)
    tmp = path.with_name(path.name + f".tmp{os.getpid()}")
    size = tbn.write(tmp, arr, **extra)
    os.replace(tmp, path)
    sf_bytes = len(tbn.encode(sf))
    import gzip
    sf_gz = len(gzip.compress(tbn.encode(sf), 6))
    base_gz = len(gzip.compress(tbn.encode({k: v for k, v in arr.items() if not k.startswith("sf_")}), 6))
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e9
    st = dict(B.stats, size=size, sf_raw=sf_bytes, sf_gz=sf_gz, base_gz=base_gz, rss_gb=round(rss, 2),
              positions=int(sf["sf_npos"][0]), faces_out=len(sf["sf_nl"]))
    return key, st


def main():
    import argparse
    import multiprocessing as mp

    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="data root with finished level-0 tiles (read only)")
    ap.add_argument("--out", required=True, help="output data root (tiles/0/*.bin.gz are written here)")
    ap.add_argument("--tiles", action="append", default=[], help="TX,TY (repeat: --tiles=-1,2 --tiles=0,2)")
    ap.add_argument("--bbox", action="append", default=[], help="E0,N0,E1,N1 world metres (repeatable)")
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--fallback", default=None, help="data root to take missing vector ground (gp_*, pc_*) from")
    ap.add_argument("--dtm", default=None, help="'lidar' (tpipe.lidar_terrain, the network model's own source) or a dir of LiDAR DTM tiles (tpipe.src_lidar dtm/)")
    ap.add_argument("--all", action="store_true", help="every level-0 tile of the source manifest")
    ap.add_argument("--in-place", action="store_true", help="src == out (pipeline/run.sh): add sf_* to the data root's tiles")
    ap.add_argument("--net2", default=None, help="primitive network cross-sections (tpipe.primnet net2/surface.npz): replaces infer_bands")
    ap.add_argument("--ring", type=int, default=0, help="also write merged-input copies of tiles within N of the processed ones")
    args = ap.parse_args()
    out = Path(args.out).resolve()
    if "app/public/data/" in str(out) + "/" and not str(out).rstrip("/").endswith("data-surf") and not args.in_place:
        raise SystemExit("refusing to write into the shared data root without --in-place")
    if args.in_place and out != Path(args.src).resolve():
        raise SystemExit("--in-place needs --src == --out")
    global _TILES, _OUT
    _TILES, _OUT = Tiles(Path(args.src), args.fallback, args.dtm, args.net2), out
    (out / "tiles" / "0").mkdir(parents=True, exist_ok=True)
    keys = [tuple(map(int, k.split(","))) for k in args.tiles]
    if args.all:
        man = json.loads((Path(args.src) / "manifest.json").read_text())
        keys += [tuple(k) for k in man["tiles"]["0"] if tuple(k) not in set(keys)]
    for bb in args.bbox:
        e0, n0, e1, n1 = map(float, bb.split(","))
        for tx in range(math.floor(e0 / S0), math.floor(e1 / S0) + 1):
            for ty in range(math.floor(n0 / S0), math.floor(n1 / S0) + 1):
                if (Path(args.src) / "tiles" / "0" / f"{tx}_{ty}.bin.gz").exists() and (tx, ty) not in keys:
                    keys.append((tx, ty))
    if args.ring:
        # neighbours of the processed tiles: consistent copies (same merged inputs), no sf_*
        core = set(keys)
        ring = set()
        for tx, ty in keys:
            for j in range(-args.ring, args.ring + 1):
                for i in range(-args.ring, args.ring + 1):
                    k = (tx + i, ty + j)
                    if k not in core and (Path(args.src) / "tiles" / "0" / f"{k[0]}_{k[1]}.bin.gz").exists():
                        ring.add(k)
        for k in sorted(ring):
            a, h = _TILES.get(*k)
            path = out / "tiles" / "0" / f"{k[0]}_{k[1]}.bin.gz"
            if path.is_symlink():
                path.unlink()
            tbn.write(path, {n: v for n, v in a.items() if not n.startswith("sf_") and not n.startswith("_")},
                      **{n: v for n, v in h.items() if n != "arrays"})
        print(f"surface: wrote {len(ring)} ring tiles (merged inputs, no surface)")
    t0 = time.time()
    rep = {}
    rp = (geo.WORK / "surface_report.json") if args.in_place else (out / "surface_report.json")  # never into the served root
    rp.parent.mkdir(parents=True, exist_ok=True)
    if rp.exists():
        rep = json.loads(rp.read_text())
    if args.workers <= 1:
        it = map(_job, keys)
        pool = None
    else:
        pool = mp.get_context("fork").Pool(min(args.workers, 2), maxtasksperchild=4)
        it = pool.imap_unordered(_job, keys)
    for n, (key, st) in enumerate(it, 1):
        rep[f"{key[0]},{key[1]}"] = st
        print(f"[{n}/{len(keys)}] {key}: {st['tris']:,} tris {st['positions']:,} positions, sf {st['sf_gz'] / 1e3:.0f} kB gz "
              f"(rest of tile {st['base_gz'] / 1e3:.0f} kB), "
              f"walls {st['walls']}, open edges {st['open_edges']}, area {st['area']:.0f} m², {st['t_total']:.1f}s, rss {st['rss_gb']} GB", flush=True)
        rp.write_text(json.dumps(rep, indent=1))
    if pool:
        pool.close()
    print(f"surface: {len(keys)} tiles in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
