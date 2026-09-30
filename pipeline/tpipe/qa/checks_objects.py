"""Props, vegetation, buildings and ground checks.

Props / trees come from the *client's own placement*: app/qa/props_dump.mjs
runs workers/street.ts + vegetation.ts for every level-0 tile and writes
pipeline/work/qa_props/{tx}_{ty}.bin. Tiles without a dump fall back to the
OSM points in the tile (p_kind 3 trees, 4 lamps) and signal poles re-derived
from the junction arms exactly as street.ts places them.

Categories:
  prop_in_lane       signal poles / street lamps standing inside a carriageway
  tree_on_road       tree trunk inside a carriageway (incl. ramps, bridge decks),
                     crown through a low deck, crown over motorway lanes
  tree_on_rail       trunk within RAIL_CLEAR of a track centreline / crown over rails
  tree_on_airfield   trunk on aerodrome / runway / airfield grass land cover
  tree_on_water      trunk on water
  building_overlap   overlapping footprints with overlapping height ranges
                     (coplanar roofs / walls z-fight); houses: checks_clip.house_overlap
  floating_object    buildings / houses whose base is well above or below the terrain
  raster_shore       stair-stepped raster shoreline (level-0 tiles without vector water)
"""

from __future__ import annotations

import math

import numpy as np
import shapely

from .. import geo
from .core import finding
from .data import F_BRIDGE, F_LINK, F_TUNNEL, S0, Block, seg_point_dist

PROPS = geo.WORK / "qa_props"

# ----------------------------------------------------------------------------- thresholds
PROP_MARGIN = 0.3  # m inside the ribbon edge before a pole/lamp counts as in the lane
DECK_ABOVE = 3.0  # m: road drawn this far above the prop's ground is overhead, not around it
TRUNK_MARGIN = 0.2  # m inside the ribbon edge for a trunk
CROWN_HIGHWAY = 1.5  # m of crown reaching over motorway / trunk lanes
RAIL_CLEAR = 3.0  # m: trunk this close to a track centreline
CROWN_RAIL = 0.75  # m: crown edge closer than this to the centreline
AIRFIELD = {14, 20, 23}
WATER = {1}
SHRUBS = {12, 13}
BLD_MIN_AREA = 4.0  # m2 of footprint overlap
BLD_MIN_FRAC = 0.10  # of the smaller footprint
ROOF_COPLANAR = 0.5  # m: tops closer than this z-fight
FLOAT_ABOVE = 1.5  # m: base above the highest terrain under the footprint
BURIED = 3.0  # m: base below the lowest terrain under the footprint
SHORE_MIN_PX = 60  # water/land edge pixels (4 m) per tile to report
VECTOR_WATER_KEYS = ("gw_poly", "gp_off", "w_off", "water_off", "g_off", "gv_off", "wv_off")  # vector ground present -> skip

SPECIES = ["norway maple", "silver maple", "sugar maple", "honey locust", "linden", "london plane", "oak", "willow",
           "beech", "columnar", "ornamental", "pine", "shrub", "cedar hedge", "white spruce", "blue spruce",
           "white cedar", "hemlock"]


# ============================================================================ props
def load_props(B: Block) -> dict:
    """Trees, lamps, signals (world coordinates) for the block + halo; `have` = tiles with a dump."""
    T = {k: [] for k in ("x", "y", "z", "h", "w", "sp")}
    Lm = {k: [] for k in ("x", "y", "z")}
    Sg = {k: [] for k in ("x", "y", "z", "j")}
    have = np.zeros(len(B.tiles), bool)
    for ti, (tx, ty) in enumerate(B.tiles):
        f = PROPS / f"{tx}_{ty}.bin"
        if not f.exists():
            continue
        raw = f.read_bytes()
        if len(raw) < 16:
            continue
        have[ti] = True
        nv, nl, ns, _ = np.frombuffer(raw, "<u4", 4)
        nv, nl, ns = int(nv), int(nl), int(ns)
        ox, oy = B.origin(ti)
        vx = np.frombuffer(raw, "<u2", nv, 16) / 64.0 + ox
        vy = np.frombuffer(raw, "<u2", nv, 16 + nv * 2) / 64.0 + oy
        T["x"].append(vx)
        T["y"].append(vy)
        T["z"].append(B.terrain(vx, vy))
        T["h"].append(np.frombuffer(raw, "u1", nv, 16 + nv * 4) / 10.0)
        T["w"].append(np.frombuffer(raw, "u1", nv, 16 + nv * 5) / 10.0)
        T["sp"].append(np.frombuffer(raw, "u1", nv, 16 + nv * 6).astype(np.int64))
        a = np.frombuffer(raw, "<f4", offset=16 + ((nv * 7 + 3) // 4) * 4)
        o = 0
        lm = a[o:o + nl * 5].reshape(-1, 5).astype(np.float64)
        Lm["x"].append(lm[:, 0] + ox)
        Lm["y"].append(lm[:, 1] + oy)
        Lm["z"].append(lm[:, 2])
        o += nl * 5
        sg = a[o:o + ns * 7].reshape(-1, 7).astype(np.float64)
        Sg["x"].append(sg[:, 0] + ox)
        Sg["y"].append(sg[:, 1] + oy)
        Sg["z"].append(sg[:, 2])
        Sg["j"].append(np.full(len(sg), ti * 100000) + sg[:, 4])
    # fallback for tiles without a dump
    miss = ~have
    if miss.any():
        P = B.pts
        pt = B.tile_index(P["x"], P["y"])
        m = (pt >= 0) & miss[np.maximum(pt, 0)]
        tr = m & (P["kind"] == 3)
        T["x"].append(P["x"][tr])
        T["y"].append(P["y"][tr])
        T["z"].append(B.terrain(P["x"][tr], P["y"][tr]))
        T["h"].append(np.full(tr.sum(), 12.0))
        T["w"].append(np.full(tr.sum(), 9.0))
        T["sp"].append(np.full(tr.sum(), -1, np.int64))
        lp = m & (P["kind"] == 4)
        Lm["x"].append(P["x"][lp])
        Lm["y"].append(P["y"][lp])
        Lm["z"].append(B.terrain(P["x"][lp], P["y"][lp]))
        sx, sy, sj = _signal_poles(B)
        st = B.tile_index(sx, sy)
        sm = (st >= 0) & miss[np.maximum(st, 0)]
        Sg["x"].append(sx[sm])
        Sg["y"].append(sy[sm])
        Sg["z"].append(B.terrain(sx[sm], sy[sm]))
        Sg["j"].append(sj[sm])
    cat = lambda d: {k: (np.concatenate(v) if v else np.zeros(0)) for k, v in d.items()}  # noqa: E731
    return {"trees": cat(T), "lamps": cat(Lm), "signals": cat(Sg), "have": have}


def _signal_poles(B: Block):
    """street.ts: a pole on the far-right corner of every approach of a signalized junction."""
    J = B.junc
    xs, ys, js = [], [], []
    for q in range(len(J["x"])):
        if not (J["flags"][q] & 1):
            continue
        arms = J["arms"][q]
        for ai, (ang, r, hw, _) in enumerate(arms):
            ca, sa = math.cos(ang), math.sin(ang)
            tX, tY = -ca, -sa
            rX, rY = tY, -tX
            oi = min(range(len(arms)), key=lambda o: (math.cos(arms[o][0] - ang), o))
            far = (arms[oi][1] if oi != ai else r) + 1.8
            xs.append(J["x"][q] + tX * far + rX * (hw + 1.2))
            ys.append(J["y"][q] + tY * far + rY * (hw + 1.2))
            js.append(J["osm"][q])
    return np.array(xs), np.array(ys), np.array(js)


class Carriageway:
    """Owned road segments (classes 0-6, no tunnels) with ribbon half-width and drawn z."""

    def __init__(self, B: Block, max_cls: int = 6):
        R = B.roads
        self.ok = R.n > 0
        if not self.ok:
            return
        c, f = R.attrs["class"], R.attrs["flags"]
        sp = R.seg_piece
        m = (c[sp] <= max_cls) & ((f[sp] & F_TUNNEL) == 0)
        self.seg, self.sp = R.seg[m], sp[m]
        s = self.seg
        self.x0, self.y0, self.x1, self.y1 = R.X[s], R.Y[s], R.X[s + 1], R.Y[s + 1]
        self.hw = R.attrs["w"][self.sp] / 2
        self.cls = c[self.sp]
        self.flags = f[self.sp]
        self.osm = R.attrs["osm"][self.sp]
        zm = (R.Z[s] + R.Z[s + 1]) / 2
        tz = B.terrain((self.x0 + self.x1) / 2, (self.y0 + self.y1) / 2)
        self.bridge = (self.flags & F_BRIDGE) != 0
        self.z = np.where(self.bridge, zm, np.where(np.isfinite(tz), tz, zm))
        self.ok = len(s) > 0
        if self.ok:
            self.tree = shapely.STRtree(shapely.linestrings(
                np.stack([np.stack([self.x0, self.y0], 1), np.stack([self.x1, self.y1], 1)], 1)))
            self.hwmax = float(self.hw.max())

    def near(self, px, py, extra):
        """(point idx, seg idx, distance) for points within hw+extra of a segment."""
        if not self.ok or len(px) == 0:
            return np.zeros(0, np.int64), np.zeros(0, np.int64), np.zeros(0)
        a, b = self.tree.query(shapely.points(px, py), predicate="dwithin", distance=self.hwmax + float(np.max(extra)))
        d, _ = seg_point_dist(px[a], py[a], self.x0[b], self.y0[b], self.x1[b], self.y1[b])
        ex = extra[a] if np.ndim(extra) else extra
        k = d < self.hw[b] + ex
        return a[k], b[k], d[k]


def _best_per_point(a, score):
    """index into (a, score) of the max score per distinct a."""
    if len(a) == 0:
        return np.zeros(0, np.int64)
    o = np.lexsort((-score, a))
    first = np.ones(len(o), bool)
    first[1:] = a[o][1:] != a[o][:-1]
    return o[first]


CLASS_NAME = ["motorway", "trunk", "primary", "secondary", "tertiary", "residential", "service", "pedestrian"]


def _road_lbl(cw: Carriageway, b: int) -> str:
    return f"{CLASS_NAME[min(int(cw.cls[b]), 7)]}{' bridge' if cw.bridge[b] else ''}{' ramp' if cw.flags[b] & F_LINK else ''} (way {int(cw.osm[b])})"


def check_props(B: Block, cats: set) -> list[dict]:
    want = {"prop_in_lane", "tree_on_road", "tree_on_rail", "tree_over_track", "tree_on_airfield", "tree_on_water"} & cats
    if not want:
        return []
    P = B.__dict__.get("_props") or load_props(B)
    B._props = P
    out: list[dict] = []
    cw = Carriageway(B)
    src = "client placement" if P["have"].any() else "OSM/derived"
    # ---- poles and lamps in lanes
    if "prop_in_lane" in cats and cw.ok:
        for kind, D, w in (("signal_pole", P["signals"], 3.0), ("lamp", P["lamps"], 2.0)):
            px, py, pz = D["x"], D["y"], D["z"]
            core = B.in_core(px, py)
            idx = np.nonzero(core)[0]
            a, b, d = cw.near(px[idx], py[idx], -PROP_MARGIN)
            a = idx[a]
            k = np.abs(cw.z[b] - pz[a]) < DECK_ABOVE
            a, b, d = a[k], b[k], d[k]
            depth = cw.hw[b] - d
            for q in _best_per_point(a, depth):
                i, s = a[q], b[q]
                out.append(finding("prop_in_lane", kind, w * (1 + depth[q] / max(cw.hw[s], 0.5)), px[i], py[i], pz[i], [cw.osm[s]],
                                   f"{kind.replace('_', ' ')} stands {depth[q]:.1f} m inside the carriageway of {_road_lbl(cw, s)} ({src})",
                                   bearing=math.atan2(cw.y1[s] - cw.y0[s], cw.x1[s] - cw.x0[s])))
    T = P["trees"]
    tx, ty, tz, th, tw, tsp = T["x"], T["y"], T["z"], T["h"], T["w"], T["sp"].astype(np.int64)
    core = B.in_core(tx, ty)
    idx = np.nonzero(core)[0]

    def spn(i):
        s = int(tsp[i])
        return SPECIES[s] if 0 <= s < len(SPECIES) else "OSM tree"

    # ---- trees on roads
    if "tree_on_road" in cats and cw.ok and len(idx):
        crown = tw[idx] / 2
        a, b, d = cw.near(tx[idx], ty[idx], crown)
        a_full = idx[a]
        deck_h = cw.z[b] - tz[a_full]  # drawn road surface above the tree's ground
        trunk = (d < cw.hw[b] - TRUNK_MARGIN) & (deck_h < DECK_ABOVE)
        through = cw.bridge[b] & (deck_h >= DECK_ABOVE) & (deck_h < th[a_full]) & (d < cw.hw[b] + crown[a] * 0.5)
        hwy = (cw.cls[b] <= 1) & (deck_h < DECK_ABOVE) & (d - crown[a] < cw.hw[b] - CROWN_HIGHWAY) & ~trunk
        sub = np.where(trunk, 0, np.where(through, 1, np.where(hwy, 2, -1)))
        k = sub >= 0
        a_full, b, d, sub, deck_h = a_full[k], b[k], d[k], sub[k], deck_h[k]
        score = np.where(sub == 0, 10 + cw.hw[b] - d, np.where(sub == 1, 5.0, 1 + cw.hw[b] - d))
        names = ["trunk_in_carriageway", "crown_through_deck", "crown_over_highway"]
        for q in _best_per_point(a_full, score):
            i, s = a_full[q], b[q]
            if sub[q] == 0:
                txt = f"{spn(i)} trunk {cw.hw[s] - d[q]:.1f} m inside {_road_lbl(cw, s)}"
                sev = 3 + (cw.hw[s] - d[q])
            elif sub[q] == 1:
                txt = f"{spn(i)} ({th[i]:.0f} m) grows through {_road_lbl(cw, s)} deck {deck_h[q]:.1f} m above its ground"
                sev = 2.0
            else:
                txt = f"{spn(i)} crown ({tw[i]:.0f} m) reaches {cw.hw[s] - (d[q] - tw[i] / 2):.1f} m over {_road_lbl(cw, s)} lanes"
                sev = 1.0
            if int(tsp[i]) in SHRUBS:
                sev *= 0.5
            out.append(finding("tree_on_road", names[sub[q]], sev * (1.5 if cw.cls[s] <= 1 else 1), tx[i], ty[i], tz[i], [cw.osm[s]],
                               txt + f" ({src})", bearing=math.atan2(cw.y1[s] - cw.y0[s], cw.x1[s] - cw.x0[s])))
    # ---- trees on rails
    L = B.rails
    if ({"tree_on_rail", "tree_over_track"} & cats) and L.n and len(idx):
        lf, lc = L.attrs["flags"], L.attrs["class"]
        sp = L.seg_piece
        m = (lf[sp] & F_TUNNEL) == 0
        s, sp = L.seg[m], sp[m]
        if len(s):
            x0, y0, x1, y1 = L.X[s], L.Y[s], L.X[s + 1], L.Y[s + 1]
            tree = shapely.STRtree(shapely.linestrings(np.stack([np.stack([x0, y0], 1), np.stack([x1, y1], 1)], 1)))
            lim = np.maximum(RAIL_CLEAR, tw[idx] / 2 + CROWN_RAIL)
            a, b = tree.query(shapely.points(tx[idx], ty[idx]), predicate="dwithin", distance=float(lim.max()))
            d, _ = seg_point_dist(tx[idx][a], ty[idx][a], x0[b], y0[b], x1[b], y1[b])
            zr = np.where(lf[sp[b]] & F_BRIDGE, (L.Z[s[b]] + L.Z[s[b] + 1]) / 2, tz[idx][a])
            low = zr - tz[idx][a] < np.maximum(th[idx][a], DECK_ABOVE)
            trunk = (d < RAIL_CLEAR) & low
            crown = ~trunk & (d - tw[idx][a] / 2 < CROWN_RAIL) & low & (lc[sp[b]] != 4)
            k = trunk | crown
            a, b, d, trunk = a[k], b[k], d[k], trunk[k]
            for q in _best_per_point(a, np.where(trunk, 10 - d, 1 - d)):
                i = idx[a[q]]
                j = b[q]
                kind = ["main line", "siding", "subway", "light rail", "streetcar", "rail"][min(int(lc[sp[j]]), 5)]
                sev = (3 + RAIL_CLEAR - d[q]) if trunk[q] else 1.0
                if int(tsp[i]) in SHRUBS:
                    sev *= 0.5
                cat = "tree_on_rail" if trunk[q] else "tree_over_track"
                if cat not in cats:
                    continue
                out.append(finding(cat, "trunk_on_track" if trunk[q] else "crown_over_track", sev, tx[i], ty[i], tz[i],
                                   [L.attrs["osm"][sp[j]]],
                                   f"{spn(i)} {'trunk' if trunk[q] else 'crown'} {d[q]:.1f} m from the {kind} track centreline ({src})",
                                   bearing=math.atan2(y1[j] - y0[j], x1[j] - x0[j])))
    # ---- land cover under the trunk
    if ({"tree_on_airfield", "tree_on_water"} & cats) and len(idx):
        # probe +-1 cm: dump coordinates are quantized to 1/64 m, so trunks on a 4 m pixel edge are ambiguous
        probes = [B.ground(tx[idx] + dx, ty[idx] + dy) for dx, dy in ((-0.01, -0.01), (0.01, -0.01), (-0.01, 0.01), (0.01, 0.01))]
        g = probes[0]
        for cat, cls, nm in (("tree_on_airfield", AIRFIELD, "airfield"), ("tree_on_water", WATER, "water")):
            if cat not in cats:
                continue
            hit = np.logical_and.reduce([np.isin(pg, list(cls)) for pg in probes])
            for q in np.nonzero(hit)[0]:
                i = idx[q]
                out.append(finding(cat, "trunk", 1.0 + th[i] / 10, tx[i], ty[i], tz[i], [],
                                   f"{spn(i)} ({th[i]:.0f} m) stands on {nm} land cover (class {int(g[q])}) ({src})"))
    return out


# ============================================================================ buildings
def check_buildings(B: Block, cats: set) -> list[dict]:
    want = {"building_overlap", "floating_object"} & cats
    if not want:
        return []
    out = []
    polys, A = B.buildings()
    hp, H = B.houses()
    if "building_overlap" in cats and len(polys) > 1:
        tree = shapely.STRtree(polys)
        i, j = tree.query(polys, predicate="intersects")
        k = i < j
        i, j = i[k], j[k]
        if len(i):
            inter = shapely.intersection(polys[i], polys[j])
            ar = shapely.area(inter)
            ai, aj = shapely.area(polys[i]), shapely.area(polys[j])
            frac = ar / np.maximum(np.minimum(ai, aj), 1e-6)
            lo_i, hi_i = A["base"][i] + A["min"][i], A["base"][i] + A["height"][i]
            lo_j, hi_j = A["base"][j] + A["min"][j], A["base"][j] + A["height"][j]
            vert = (np.minimum(hi_i, hi_j) - np.maximum(lo_i, lo_j)) > 0.2
            k = (ar >= BLD_MIN_AREA) & (frac >= BLD_MIN_FRAC) & vert
            cen = shapely.centroid(inter[k])
            cx, cy = shapely.get_x(cen), shapely.get_y(cen)
            for q, (a, b) in enumerate(zip(i[k], j[k])):
                if not B.in_core(cx[q], cy[q]):
                    continue
                ark, fr = ar[k][q], frac[k][q]
                dtop = abs(hi_i[k][q] - hi_j[k][q])
                cop = dtop < ROOF_COPLANAR
                same = A["osm"][a] == A["osm"][b]
                sub = "duplicate_record" if same and fr > 0.95 else ("coplanar_roof" if cop else ("contained" if fr > 0.95 else "volume_overlap"))
                sev = ark / 20 * (3 if cop else 1)
                oa, ob = sorted((int(A["osm"][a]), int(A["osm"][b])))
                out.append(finding("building_overlap", sub, sev, cx[q], cy[q], max(hi_i[k][q], hi_j[k][q]), [oa, ob],
                                   f"buildings {oa} ({A['height'][a]:.0f} m) and {ob} ({A['height'][b]:.0f} m) overlap {ark:.0f} m2 "
                                   f"({fr * 100:.0f}% of the smaller){'; roofs within ' + format(dtop, '.1f') + ' m (z-fighting)' if cop else ''}",
                                   key=("building_overlap", oa, ob)))
    if "floating_object" in cats:
        # terrain range under each footprint (vertices + centroid)
        if len(polys):
            cen = shapely.centroid(polys)
            cx, cy = shapely.get_x(cen), shapely.get_y(cen)
            core = B.in_core(cx, cy)
            idx = np.nonzero(core)[0]
            if len(idx):
                co, ind = shapely.get_coordinates(shapely.boundary(polys[idx]), return_index=True)
                tz = B.terrain(co[:, 0], co[:, 1])
                tmax = np.full(len(idx), -np.inf)
                tmin = np.full(len(idx), np.inf)
                np.maximum.at(tmax, ind, np.nan_to_num(tz, nan=-np.inf))
                np.minimum.at(tmin, ind, np.nan_to_num(tz, nan=np.inf))
                base = A["base"][idx]
                fl = base - tmax
                bu = tmin - base
                for q in np.nonzero(np.isfinite(tmax) & ((fl > FLOAT_ABOVE) | (bu > BURIED)))[0]:
                    i = idx[q]
                    up = fl[q] > FLOAT_ABOVE
                    out.append(finding("floating_object", "building_floats" if up else "building_buried", fl[q] if up else bu[q] / 2,
                                       cx[i], cy[i], base[q], [A["osm"][i]],
                                       f"building {int(A['osm'][i])} base {base[q]:.1f} m is {fl[q]:.1f} m above the highest ground under it"
                                       if up else f"building {int(A['osm'][i])} base {base[q]:.1f} m is {bu[q]:.1f} m below the lowest ground under it"))
        if len(hp):
            core = B.in_core(H["x"], H["y"])
            idx = np.nonzero(core)[0]
            if len(idx):
                co, ind = shapely.get_coordinates(shapely.boundary(hp[idx]), return_index=True)
                tz = np.nan_to_num(B.terrain(co[:, 0], co[:, 1]), nan=-np.inf)
                tmax = np.full(len(idx), -np.inf)
                np.maximum.at(tmax, ind, tz)
                fl = H["base"][idx] - tmax
                for q in np.nonzero(np.isfinite(tmax) & (fl > FLOAT_ABOVE))[0]:
                    i = idx[q]
                    out.append(finding("floating_object", "house_floats", fl[q], H["x"][i], H["y"][i], H["base"][i], [H["osm"][i]],
                                       f"house {int(H['osm'][i])} floats {fl[q]:.1f} m above the ground"))
    return out


# ============================================================================ ground
def check_shore(B: Block, cats: set) -> list[dict]:
    if "raster_shore" not in cats:
        return []
    out = []
    for (tx, ty), d in zip(B.tiles, B.data):
        if not (B.cx0 <= tx < B.cx0 + 4 and B.cy0 <= ty < B.cy0 + 4):
            continue
        if any(k in d for k in VECTOR_WATER_KEYS):
            continue
        g = d.get("ground")
        if g is None or len(g) != 256 * 256:
            continue
        w = g.reshape(256, 256) == 1
        if not w.any() or w.all():
            continue
        ex = w[:, 1:] != w[:, :-1]
        ey = w[1:, :] != w[:-1, :]
        n = int(ex.sum() + ey.sum())
        if n < SHORE_MIN_PX:
            continue
        # a stair corner = a pixel corner where both an x-edge and a y-edge meet
        corners = int((ex[1:, :] & ey[:, 1:]).sum() + (ex[:-1, :] & ey[:, :-1]).sum())
        jj, ii = np.nonzero(ex)
        x = tx * S0 + (ii.mean() + 1) * 4
        y = ty * S0 + (jj.mean() + 0.5) * 4
        out.append(finding("raster_shore", "stair_steps", n * 4 / 1000 * (1 + corners / max(n, 1)), x, y, 0.0, [],
                           f"tile {tx}_{ty}: {n * 4 / 1000:.1f} km of 4 m raster shoreline, {corners} stair corners (no vector water)",
                           key=("raster_shore", tx, ty)))
    return out


OBJECT_CATS = {"prop_in_lane", "tree_on_road", "tree_on_rail", "tree_over_track", "tree_on_airfield", "tree_on_water",
               "building_overlap", "floating_object", "raster_shore"}


def run(B: Block, cats: set) -> list[dict]:
    out = []
    out += check_props(B, cats)
    out += check_buildings(B, cats)
    out += check_shore(B, cats)
    return out
