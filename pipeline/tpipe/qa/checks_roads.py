"""Road checks on level-0 render tiles (what the client actually draws).

The ribbon model mirrors app/src/workers/roads.ts: width = r_width (else the
class default), at least 10 m for class 0-1, drawn flat-capped along the
centreline; tunnels are not drawn; non-bridge roads are draped on terrain,
bridges use their own z. There is no taper between ways of different width.

Categories (thresholds below):
  road_width_step          ways meeting end-to-end (degree-2) with a width jump
  bridge_width_anomaly     bridge ribbons much wider/narrower than their approaches,
                           or implausibly wide per lane
  road_overlap_nonjunction ribbons of different ways overlapping outside junction
                           boxes / shared nodes (markings cross lanes: ramp merges,
                           dual carriageways mapped too close)
  flat_crossing            road/road or road/rail centrelines crossing with no
                           shared node and no vertical separation, neither a bridge
  deck_below_clearance     as above but one side is a bridge whose deck is too low
  junction_hardware_on_grade_sep  junction boxes / crossings / stop lines on
                           motorways or bridge decks
  elevation_jump           bridge deck ends that float above / dive below the road
                           they join, dangling decks, steep deck grades
  road_below_terrain       bridge decks (and rail bridges) under the terrain
  duplicate_footway        footways running alongside a road that already draws
                           a sidewalk
  footway_as_road          paths drawn as wide as roads; footbridges drawn thin
  sidewalk_bridge_discontinuity  sidewalks that stop where a bridge deck starts
  dash_phase_break         lane-dash phase / lane-line lateral jumps at way boundaries
"""

from __future__ import annotations

import math

import numpy as np
import shapely
from scipy.spatial import cKDTree

from .core import finding
from .data import F_BRIDGE, F_LINK, F_ONEWAY, F_TUNNEL, SIDEWALK_W, URBAN, Block, ribbon_quads

# ----------------------------------------------------------------------------- thresholds
NODE_EPS = 0.05  # m: vertices this close are the same OSM node
WIDTH_STEP_MIN = 1.0  # m: |w1 - w2| to report a step
WIDTH_STEP_RATIO = 1.15  # and max/min at least this
CONTINUE_DOT = -0.7  # degree-2 ends count as a continuation if dir_a . dir_b < this (~>135 deg)
BRIDGE_RATIO = 1.3  # bridge width / approach width
BRIDGE_DW = 2.0  # m, and at least this much wider (or narrower)
BRIDGE_PER_LANE = 5.5  # m per lane on a bridge ribbon
OVERLAP_Z = 3.0  # m: ribbons further apart vertically are grade separated
OVERLAP_MIN_AREA = 12.0  # m2 per way pair
OVERLAP_ZONE_PAD = 2.0  # m added to junction-box radius / shared-node disc
CLEARANCE_ROAD = 4.5  # m: road over road
CLEARANCE_RAIL = 5.5  # m: road over rail / rail over road
SHARED_NODE_R = 1.0  # m: a crossing this close to a shared node is a real junction
DECK_STEP = 0.6  # m: deck end vs the surface it joins
DANGLING_DECK = 1.5  # m above terrain at an unconnected deck end
DECK_GRADE = 0.12  # rise / run on a deck segment >= 3 m
BELOW_TERRAIN = 0.5  # m: deck below terrain
BELOW_STEP = 4.0  # m: sampling step along decks
DUP_MARGIN = 2.0  # m beyond road half width + sidewalk
DUP_ANGLE = math.radians(20)
DUP_SAMPLE = 5.0  # m
DUP_MIN_LEN = 25.0  # m of duplicated footway per way to report
DUP_MIN_FRAC = 0.5
FOOTWAY_MAX_W = 3.0  # m: path ribbon wider than this reads as a road
FOOTBRIDGE_MIN_W = 2.5  # m: footbridge deck narrower than this reads as a line
SW_BRIDGE_D = 10.0  # m: footway end this close to a bridge end without continuing
DASH_TOL = 0.75  # m phase mismatch
LANE_LINE_TOL = 0.4  # m lateral lane-line mismatch
DASH_ON = 3.0

CLASS_W = np.array([10, 8, 5, 4, 3, 2, 1.5, 1, 0.5, 0.5])  # severity weight per road class


def _cls_w(c):
    return CLASS_W[np.minimum(np.asarray(c, np.int64), 9)]


class RoadCtx:
    """Shared per-block road structures."""

    def __init__(self, B: Block):
        self.B = B
        R = self.R = B.roads
        a = R.attrs
        self.cls = a["class"] if R.n else np.zeros(0, np.int64)
        self.flags = a["flags"] if R.n else np.zeros(0, np.int64)
        self.osm = a["osm"] if R.n else np.zeros(0)
        self.w = a["w"] if R.n else np.zeros(0)
        self.hw = self.w / 2
        self.vp = R.vpiece()
        self.tree = cKDTree(np.column_stack([R.X, R.Y])) if len(R.X) else None
        self.ends = B.piece_ends(R)
        # is-endpoint-of-piece per vertex
        self.is_end = np.zeros(len(R.X), bool)
        if R.n:
            self.is_end[R.off[:-1]] = True
            self.is_end[R.off[1:] - 1] = True
        # per-vertex distance along the way (r_v0 + cumulative length within the piece)
        if R.n:
            d = np.hypot(np.diff(R.X), np.diff(R.Y))
            d = np.concatenate([[0.0], d])
            d[R.off[:-1]] = 0.0
            cs = np.cumsum(d)
            cs -= np.repeat(cs[R.off[:-1]], np.diff(R.off))
            self.s = cs + a["v0"][self.vp]
        else:
            self.s = np.zeros(0)
        # sidewalk drawn? (roads.ts: classes 2-5, not bridge/link; tags or built-up land)
        self.sidewalk = self._sidewalks()
        self._neighbours()

    def _sidewalks(self) -> np.ndarray:
        R, B = self.R, self.B
        if not R.n:
            return np.zeros(0, bool)
        side = R.attrs["side"]
        c, f = self.cls, self.flags
        sw = R.attrs.get("sw")
        if sw is not None and sw.any():
            # network-model tiles (tpipe.roadnet): the pipeline decides sidewalks per vertex,
            # bridges carry their sidewalks on the deck
            return (sw.astype(np.int64) & 3) != 0
        base = (c >= 2) & (c <= 5) & ((f & F_BRIDGE) == 0) & ((f & F_LINK) == 0)
        mid = (R.off[:-1] + R.off[1:] - 1) // 2
        g0 = B.ground(R.X[R.off[:-1]], R.Y[R.off[:-1]])
        g1 = B.ground(R.X[mid], R.Y[mid])
        g2 = B.ground(R.X[R.off[1:] - 1], R.Y[R.off[1:] - 1])
        urban_tile = B.nbuilt[R.tile] > 150
        uset = np.array(sorted(URBAN))

        def urb(g):
            return np.isin(g, uset) | (urban_tile & (g == 0))

        built = (urb(g0).astype(int) + urb(g1) + urb(g2)) >= 2
        tagged = np.isin(side, [2, 3, 4])
        return base & (tagged | (np.isin(side, [0, 5]) & built))

    def _neighbours(self) -> None:
        """For each real piece end: the other ways (pieces) that share the node."""
        E = self.ends
        self.end_others: list[np.ndarray] = []
        if self.tree is None or len(E["v"]) == 0:
            return
        R = self.R
        pts = np.column_stack([R.X[E["v"]], R.Y[E["v"]]])
        lists = self.tree.query_ball_point(pts, NODE_EPS)
        for k, lst in enumerate(lists):
            p = E["p"][k]
            o = self.osm[p]
            vs = np.array([v for v in lst if self.osm[self.vp[v]] != o], dtype=np.int64)
            self.end_others.append(vs)

    def continuation(self):
        """Degree-2 continuations: (end index k, own piece, other piece, other vertex)."""
        out = []
        E = self.ends
        for k, vs in enumerate(self.end_others):
            if len(vs) == 0:
                continue
            osms = np.unique(self.osm[self.vp[vs]])
            if len(osms) != 1 or not self.is_end[vs].all():
                continue
            v2 = int(vs[0])
            out.append((k, int(E["p"][k]), int(self.vp[v2]), v2))
        return out

    def dir_at_end(self, v: int) -> tuple[float, float]:
        """unit direction pointing into the piece from its end vertex v"""
        R = self.R
        p = self.vp[v]
        nb = v + 1 if v == R.off[p] else v - 1
        dx, dy = R.X[nb] - R.X[v], R.Y[nb] - R.Y[v]
        ln = math.hypot(dx, dy) or 1.0
        return dx / ln, dy / ln

    def name(self, p: int) -> str:
        B = self.B
        ni = int(self.R.attrs["name"][p])
        names = B.data[self.R.tile[p]].get("_names", [])
        return names[ni] if 0 <= ni < len(names) and ni != 0xFFFF else ""


CLASS_NAME = ["motorway", "trunk", "primary", "secondary", "tertiary", "residential", "service",
              "pedestrian", "footway", "track"]


def _lbl(ctx: RoadCtx, p: int) -> str:
    n = ctx.name(p)
    c = int(ctx.cls[p])
    return f"{n + ' ' if n else ''}({CLASS_NAME[min(c, 9)]}{', bridge' if ctx.flags[p] & F_BRIDGE else ''}{', link' if ctx.flags[p] & F_LINK else ''})"


# ============================================================================ connections
def check_connections(ctx: RoadCtx, cats: set) -> list[dict]:
    """road_width_step, bridge_width_anomaly, sidewalk_bridge_discontinuity, dash_phase_break,
    elevation_jump (deck ends)."""
    B, R = ctx.B, ctx.R
    out: list[dict] = []
    if not R.n:
        return out
    E = ctx.ends
    ok_cls = lambda p: ctx.cls[p] <= 7 and not (ctx.flags[p] & F_TUNNEL)  # noqa: E731
    # ---- degree-2 continuations
    for k, pa, pb, vb in ctx.continuation():
        va = int(E["v"][k])
        x, y = R.X[va], R.Y[va]
        if not B.in_core(x, y) or not ok_cls(pa) or not ok_cls(pb):
            continue
        da = ctx.dir_at_end(va)
        db = ctx.dir_at_end(vb)
        if da[0] * db[0] + da[1] * db[1] > CONTINUE_DOT:
            continue
        oa, ob = ctx.osm[pa], ctx.osm[pb]
        if oa > ob:  # handle each pair once (from the lower id's end)
            continue
        wa, wb = ctx.w[pa], ctx.w[pb]
        bearing = math.atan2(-da[1], -da[0])
        z = float(B.terrain(x, y))
        pair = (min(oa, ob), max(oa, ob))
        la, lb = int(R.attrs["lanes"][pa]), int(R.attrs["lanes"][pb])
        if "road_width_step" in cats:
            dw = abs(wa - wb)
            if dw >= WIDTH_STEP_MIN and max(wa, wb) / max(min(wa, wb), 0.1) >= WIDTH_STEP_RATIO:
                sev = dw * max(_cls_w(ctx.cls[pa]), _cls_w(ctx.cls[pb])) / 2
                out.append(finding("road_width_step", "no_taper", sev, x, y, z, [oa, ob],
                                   f"{_lbl(ctx, pa)} {wa:.1f} m/{la} lanes meets {_lbl(ctx, pb)} {wb:.1f} m/{lb} lanes: "
                                   f"{dw:.1f} m hard step, no taper", key=("road_width_step", pair, round(x), round(y)), bearing=bearing))
        if "sidewalk_bridge_discontinuity" in cats:
            for p1, p2 in ((pa, pb), (pb, pa)):
                if ctx.sidewalk[p1] and (ctx.flags[p2] & F_BRIDGE) and ctx.cls[p2] <= 5 and not ctx.sidewalk[p2]:
                    out.append(finding("sidewalk_bridge_discontinuity", "road_to_deck", 2.0 + ctx.w[p1] / 4, x, y, z, [ctx.osm[p1], ctx.osm[p2]],
                                       f"sidewalks of {_lbl(ctx, p1)} stop where bridge {_lbl(ctx, p2)} starts (decks draw no sidewalk)",
                                       key=("sidewalk_bridge_discontinuity", pair, round(x), round(y)), bearing=bearing))
        if "dash_phase_break" in cats:
            out += _dash(ctx, pa, pb, va, vb, x, y, z, bearing, pair)
    # ---- bridge-specific per end
    bridge_ends = [k for k in range(len(E["v"])) if ctx.flags[E["p"][k]] & F_BRIDGE and ctx.cls[E["p"][k]] <= 8
                   and not ctx.flags[E["p"][k]] & F_TUNNEL]
    approach: dict = {}
    for k in bridge_ends:
        v, p = int(E["v"][k]), int(E["p"][k])
        x, y, zb = R.X[v], R.Y[v], R.Z[v]
        others = ctx.end_others[k]
        opieces = np.unique(ctx.vp[others]) if len(others) else np.zeros(0, np.int64)
        opieces = opieces[(ctx.cls[opieces] <= 8) & ((ctx.flags[opieces] & F_TUNNEL) == 0)]
        tz = float(B.terrain(x, y))
        if B.in_core(x, y) and "elevation_jump" in cats and math.isfinite(tz):
            if len(opieces) == 0:
                if zb - tz > DANGLING_DECK:
                    out.append(finding("elevation_jump", "dangling_deck", (zb - tz) * _cls_w(ctx.cls[p]) / 2, x, y, zb, [ctx.osm[p]],
                                       f"bridge {_lbl(ctx, p)} ends in mid-air {zb - tz:.1f} m above the ground, connected to nothing",
                                       bearing=math.atan2(*ctx.dir_at_end(v)[::-1])))
            else:
                ob = opieces[(ctx.flags[opieces] & F_BRIDGE) != 0]
                if len(ob) == len(opieces):
                    zr = float(np.median(R.Z[others[np.isin(ctx.vp[others], ob)]]))
                    what = "the deck it joins"
                else:
                    # the joining road's own elevation at the shared node (approach embankments
                    # carry solved elevations; for draped roads this is the terrain)
                    zr = float(np.median(R.Z[others]))
                    what = "the road it joins"
                dz = zb - zr
                if abs(dz) > DECK_STEP:
                    sub = "deck_floats" if dz > 0 else "deck_dives"
                    out.append(finding("elevation_jump", sub, abs(dz) * _cls_w(ctx.cls[p]) / 2, x, y, zb,
                                       [ctx.osm[p]] + [ctx.osm[q] for q in opieces[:3]],
                                       f"bridge {_lbl(ctx, p)} end is {dz:+.1f} m vs {what} ({_lbl(ctx, int(opieces[0]))}): visible step",
                                       bearing=math.atan2(*ctx.dir_at_end(v)[::-1])))
        # approach widths for bridge_width_anomaly
        ap = opieces[((ctx.flags[opieces] & F_BRIDGE) == 0) & (ctx.cls[opieces] <= 7)]
        if len(ap):
            approach.setdefault(ctx.osm[p], []).extend(ctx.w[ap].tolist())
    if "bridge_width_anomaly" in cats:
        seen = set()
        for k in bridge_ends:
            p = int(E["p"][k])
            o = ctx.osm[p]
            if o in seen or ctx.cls[p] > 7:
                continue
            seen.add(o)
            # locate at the piece's middle vertex (core check there)
            mid = (R.off[p] + R.off[p + 1] - 1) // 2
            x, y = R.X[mid], R.Y[mid]
            if not B.in_core(x, y):
                continue
            wb = ctx.w[p]
            lanes = int(R.attrs["lanes"][p])
            bearing = math.atan2(R.Y[min(mid + 1, R.off[p + 1] - 1)] - R.Y[max(mid - 1, R.off[p])],
                                 R.X[min(mid + 1, R.off[p + 1] - 1)] - R.X[max(mid - 1, R.off[p])])
            aw = approach.get(o)
            if aw:
                wa = float(np.median(aw))
                r = wb / max(wa, 0.1)
                if (r >= BRIDGE_RATIO or r <= 1 / BRIDGE_RATIO) and abs(wb - wa) >= BRIDGE_DW:
                    out.append(finding("bridge_width_anomaly", "wider_than_approach" if r > 1 else "narrower_than_approach",
                                       abs(wb - wa) * _cls_w(ctx.cls[p]) / 2, x, y, R.Z[mid], [o],
                                       f"bridge {_lbl(ctx, p)} is {wb:.1f} m wide vs {wa:.1f} m approaches ({r:.2f}x)",
                                       key=("bridge_width_anomaly", o), bearing=bearing))
                    continue
            if lanes > 0 and wb / lanes > BRIDGE_PER_LANE:
                out.append(finding("bridge_width_anomaly", "wide_per_lane", (wb / lanes - BRIDGE_PER_LANE) * _cls_w(ctx.cls[p]) / 2,
                                   x, y, R.Z[mid], [o],
                                   f"bridge {_lbl(ctx, p)}: {wb:.1f} m for {lanes} lanes = {wb / lanes:.1f} m/lane",
                                   key=("bridge_width_anomaly", o), bearing=bearing))
    return out


def _lane_lines(cls: int, hw: float, lanes: int, oneway: bool) -> tuple[list[float], bool]:
    """Lateral positions of dashed lane lines (roadMaterial.ts), u>0 = left of piece direction."""
    g = 1.2 if cls <= 1 else 0.45
    if oneway:
        if lanes < 2:
            return [], False
        lw1 = max((hw - g) * 2 / lanes, 2.4)
        return [-hw + g + k * lw1 for k in range(1, lanes)], True
    nR = max(lanes // 2, 1)
    nL = max(lanes - nR, 1)
    lines = []
    for n, sgn in ((nR, -1), (nL, 1)):
        lw = max((hw - g) / n, 2.4)
        lines += [sgn * k * lw for k in range(1, n)]
    return lines, len(lines) > 0


def _dash(ctx: RoadCtx, pa, pb, va, vb, x, y, z, bearing, pair) -> list[dict]:
    R = ctx.R
    out = []
    ca, cb = int(ctx.cls[pa]), int(ctx.cls[pb])
    la, lb = int(R.attrs["lanes"][pa]), int(R.attrs["lanes"][pb])
    if ca > 5 or cb > 5 or la < 1 or lb < 1:
        return out
    owa, owb = bool(ctx.flags[pa] & F_ONEWAY), bool(ctx.flags[pb] & F_ONEWAY)
    La, da = _lane_lines(ca, ctx.hw[pa], la, owa)
    Lb, db = _lane_lines(cb, ctx.hw[pb], lb, owb)
    if not (da and db):
        return out
    # travel frame: A -> junction -> B. A's piece runs with travel iff the junction is at its end.
    a_fwd = va == R.off[pa + 1] - 1
    b_fwd = vb == R.off[pb]
    Pa = 12.0 if ca <= 1 else 9.0
    Pb = 12.0 if cb <= 1 else 9.0
    sa, sb = ctx.s[va] + 1000.0, ctx.s[vb] + 1000.0
    offa = (-sa) % Pa if a_fwd else (sa - DASH_ON) % Pa
    offb = (-sb) % Pb if b_fwd else (sb - DASH_ON) % Pb
    if Pa == Pb:
        m = abs(offa - offb) % Pa
        m = min(m, Pa - m)
        if m > DASH_TOL:
            out.append(finding("dash_phase_break", "phase", m * _cls_w(min(ca, cb)) / 4, x, y, z, list(pair),
                               f"lane dashes jump {m:.1f} m at the boundary {_lbl(ctx, pa)} / {_lbl(ctx, pb)}",
                               key=("dash_phase_break", "phase", pair, round(x), round(y)), bearing=bearing))
    if abs(ctx.w[pa] - ctx.w[pb]) < WIDTH_STEP_MIN:
        ua = sorted(u if a_fwd else -u for u in La)
        ub = sorted(u if b_fwd else -u for u in Lb)
        if len(ua) != len(ub):
            sub, m = "lane_count", abs(len(ua) - len(ub)) * 1.0
        else:
            sub, m = "lateral", max(abs(p - q) for p, q in zip(ua, ub))
        if m > LANE_LINE_TOL:
            out.append(finding("dash_phase_break", sub, m * _cls_w(min(ca, cb)) / 2, x, y, z, list(pair),
                               f"lane lines shift sideways ({sub}, {m:.1f} m) at {_lbl(ctx, pa)} {la} lanes"
                               f"{' one-way' if owa else ''} / {_lbl(ctx, pb)} {lb} lanes{' one-way' if owb else ''}",
                               key=("dash_phase_break", sub, pair, round(x), round(y)), bearing=bearing))
    return out


# ============================================================================ overlaps
def check_overlap(ctx: RoadCtx, cats: set) -> list[dict]:
    B, R = ctx.B, ctx.R
    if "road_overlap_nonjunction" not in cats or not R.n:
        return []
    sp = R.seg_piece
    m = (ctx.cls[sp] <= 7) & ((ctx.flags[sp] & F_TUNNEL) == 0)
    seg, sp = R.seg[m], sp[m]
    if len(seg) < 2:
        return []
    quads = ribbon_quads(R, ctx.hw[sp], seg)
    tree = shapely.STRtree(quads)
    i, j = tree.query(quads, predicate="intersects")
    k = i < j
    i, j = i[k], j[k]
    pi, pj = sp[i], sp[j]
    k = ctx.osm[pi] != ctx.osm[pj]
    zi = (R.Z[seg[i]] + R.Z[seg[i] + 1]) / 2
    zj = (R.Z[seg[j]] + R.Z[seg[j] + 1]) / 2
    k &= np.abs(zi - zj) < OVERLAP_Z
    i, j, pi, pj = i[k], j[k], pi[k], pj[k]
    if len(i) == 0:
        return []
    inter = shapely.intersection(quads[i], quads[j])
    area = shapely.area(inter)
    # filter before taking centroids: degenerate (zero-length) segments give empty intersections
    k = area > 0.05
    i, j, pi, pj, area, inter = i[k], j[k], pi[k], pj[k], area[k], inter[k]
    cen = shapely.centroid(inter)
    cx, cy = shapely.get_x(cen), shapely.get_y(cen)
    # allowed zones: junction boxes + every shared node (disc of the widest road there)
    zx, zy, zr = [B.junc["x"]], [B.junc["y"]], [B.junc["r"] + OVERLAP_ZONE_PAD]
    if ctx.tree is not None:
        pairs = ctx.tree.query_pairs(NODE_EPS, output_type="ndarray")
        if len(pairs):
            a, b = pairs[:, 0], pairs[:, 1]
            d = ctx.osm[ctx.vp[a]] != ctx.osm[ctx.vp[b]]
            a, b = a[d], b[d]
            zx.append(R.X[a])
            zy.append(R.Y[a])
            zr.append(np.maximum(ctx.hw[ctx.vp[a]], ctx.hw[ctx.vp[b]]) * 1.5 + OVERLAP_ZONE_PAD)
    zx, zy, zr = np.concatenate(zx), np.concatenate(zy), np.concatenate(zr)
    allowed = np.zeros(len(i), bool)
    if len(zx):
        zt = cKDTree(np.column_stack([zx, zy]))
        rmax = float(zr.max())
        near = zt.query_ball_point(np.column_stack([cx, cy]), rmax)
        for q, lst in enumerate(near):
            if lst:
                L = np.asarray(lst)
                if np.any(np.hypot(zx[L] - cx[q], zy[L] - cy[q]) < zr[L]):
                    allowed[q] = True
    k = ~allowed
    i, j, pi, pj, area, cx, cy = i[k], j[k], pi[k], pj[k], area[k], cx[k], cy[k]
    # aggregate per way pair
    oa = np.minimum(ctx.osm[pi], ctx.osm[pj])
    ob = np.maximum(ctx.osm[pi], ctx.osm[pj])
    out = []
    if len(oa) == 0:
        return out
    key = np.stack([oa, ob], 1)
    uk, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.ravel()
    tot = np.bincount(inv, weights=area)
    for g in np.nonzero(tot >= OVERLAP_MIN_AREA)[0]:
        members = np.nonzero(inv == g)[0]
        best = members[np.argmax(area[members])]
        x, y = cx[best], cy[best]
        if not B.in_core(x, y):
            continue
        p1, p2 = int(pi[best]), int(pj[best])
        s1 = seg[i[best]]
        bearing = math.atan2(R.Y[s1 + 1] - R.Y[s1], R.X[s1 + 1] - R.X[s1])
        both_link = bool(ctx.flags[p1] & F_LINK) or bool(ctx.flags[p2] & F_LINK)
        sub = "ramp_merge" if both_link else ("parallel_ways" if _parallel(R, seg[i[best]], seg[j[best]]) else "crossing_ribbons")
        sev = float(tot[g]) / 10 * max(_cls_w(ctx.cls[p1]), _cls_w(ctx.cls[p2])) / 4
        out.append(finding("road_overlap_nonjunction", sub, sev, x, y, float(R.Z[s1]), [uk[g, 0], uk[g, 1]],
                           f"{_lbl(ctx, p1)} and {_lbl(ctx, p2)} ribbons overlap {tot[g]:.0f} m2 outside any junction box "
                           f"(markings cross lanes)", key=("road_overlap_nonjunction", int(uk[g, 0]), int(uk[g, 1])), bearing=bearing))
    return out


def _parallel(R, s1, s2) -> bool:
    a = math.atan2(R.Y[s1 + 1] - R.Y[s1], R.X[s1 + 1] - R.X[s1])
    b = math.atan2(R.Y[s2 + 1] - R.Y[s2], R.X[s2 + 1] - R.X[s2])
    return abs(math.cos(a - b)) > math.cos(math.radians(15))


# ============================================================================ crossings
RAIL_W = [10, 4, 10, 3, 1, 2]  # severity weight per rail class (main, siding, subway, LRT, tram, other)


def check_crossings(ctx: RoadCtx, cats: set) -> list[dict]:
    """flat_crossing + deck_below_clearance: centreline intersections without a shared node."""
    if not ({"flat_crossing", "deck_below_clearance"} & cats):
        return []
    B, R, L = ctx.B, ctx.R, ctx.B.rails
    # unified segment list: roads (classes 0-8), rails (not tram)
    segs = []
    if R.n:
        sp = R.seg_piece
        m = (ctx.cls[sp] <= 8) & ((ctx.flags[sp] & F_TUNNEL) == 0)
        segs.append(("r", R.seg[m], sp[m]))
    if L.n:
        lc, lf = L.attrs["class"], L.attrs["flags"]
        sp = L.seg_piece
        m = ((lf[sp] & F_TUNNEL) == 0) & (lc[sp] != 4)
        segs.append(("l", L.seg[m], sp[m]))
    if not segs:
        return []
    kind = np.concatenate([np.full(len(s[1]), 0 if s[0] == "r" else 1) for s in segs])
    src = {"r": R, "l": L}
    X0 = np.concatenate([src[t].X[s] for t, s, _ in segs])
    Y0 = np.concatenate([src[t].Y[s] for t, s, _ in segs])
    Z0 = np.concatenate([src[t].Z[s] for t, s, _ in segs])
    X1 = np.concatenate([src[t].X[s + 1] for t, s, _ in segs])
    Y1 = np.concatenate([src[t].Y[s + 1] for t, s, _ in segs])
    Z1 = np.concatenate([src[t].Z[s + 1] for t, s, _ in segs])
    P = np.concatenate([p for _, _, p in segs])
    osm = np.where(kind == 0, ctx.osm[np.where(kind == 0, P, 0)] if R.n else 0,
                   L.attrs["osm"][np.where(kind == 1, P, 0)] if L.n else 0)
    cls = np.where(kind == 0, ctx.cls[np.where(kind == 0, P, 0)] if R.n else 0,
                   L.attrs["class"][np.where(kind == 1, P, 0)] if L.n else 0)
    flg = np.where(kind == 0, ctx.flags[np.where(kind == 0, P, 0)] if R.n else 0,
                   L.attrs["flags"][np.where(kind == 1, P, 0)] if L.n else 0)
    lines = shapely.linestrings(np.stack([np.stack([X0, Y0], 1), np.stack([X1, Y1], 1)], 1))
    tree = shapely.STRtree(lines)
    i, j = tree.query(lines, predicate="intersects")
    k = (i < j) & (osm[i] != osm[j])
    i, j = i[k], j[k]
    # relevant pairs: road(0-7)/road(0-7), road/rail, rail/rail, footway/motorway-trunk
    ri, rj = kind[i] == 0, kind[j] == 0
    ci, cj = cls[i], cls[j]
    foot_i, foot_j = ri & (ci == 8), rj & (cj == 8)
    keep = (~foot_i & ~foot_j) | (foot_i & rj & (cj <= 1) & ~foot_j) | (foot_j & ri & (ci <= 1) & ~foot_i)
    keep &= ~(foot_i & ~rj) & ~(foot_j & ~ri)
    i, j = i[keep], j[keep]
    if len(i) == 0:
        return []
    # intersection point + parameters
    dxa, dya = X1[i] - X0[i], Y1[i] - Y0[i]
    dxb, dyb = X1[j] - X0[j], Y1[j] - Y0[j]
    den = dxa * dyb - dya * dxb
    ok = np.abs(den) > 1e-9
    i, j, dxa, dya, dxb, dyb, den = i[ok], j[ok], dxa[ok], dya[ok], dxb[ok], dyb[ok], den[ok]
    ex, ey = X0[j] - X0[i], Y0[j] - Y0[i]
    ta = np.clip((ex * dyb - ey * dxb) / den, 0, 1)
    tb = np.clip((ex * dya - ey * dxa) / den, 0, 1)
    px, py = X0[i] + dxa * ta, Y0[i] + dya * ta
    za = Z0[i] + (Z1[i] - Z0[i]) * ta
    zb = Z0[j] + (Z1[j] - Z0[j]) * tb
    # drawn elevation: non-bridges are draped on the terrain
    tz = B.terrain(px, py)
    za = np.where(flg[i] & F_BRIDGE, za, np.where(np.isfinite(tz), tz, za))
    zb = np.where(flg[j] & F_BRIDGE, zb, np.where(np.isfinite(tz), tz, zb))
    # shared node near the crossing -> real junction / level crossing
    allv = [np.column_stack([R.X, R.Y])] if R.n else []
    allo = [ctx.osm[ctx.vp]] if R.n else []
    if L.n:
        allv.append(np.column_stack([L.X, L.Y]))
        allo.append(L.attrs["osm"][L.vpiece()])
    V = np.concatenate(allv)
    VO = np.concatenate(allo)
    vt = cKDTree(V)
    near = vt.query_ball_point(np.column_stack([px, py]), SHARED_NODE_R)
    out = []
    for q, lst in enumerate(near):
        x, y = px[q], py[q]
        if not B.in_core(x, y):
            continue
        a, b = i[q], j[q]
        if lst:
            lst = np.asarray(lst)
            has_a = np.isin(VO[lst], [osm[a]])
            has_b = np.isin(VO[lst], [osm[b]])
            if has_a.any() and has_b.any():
                # both ways have a vertex within SHARED_NODE_R; shared if any pair coincides
                A = V[lst[has_a]]
                Bv = V[lst[has_b]]
                if np.min(np.hypot(A[:, None, 0] - Bv[None, :, 0], A[:, None, 1] - Bv[None, :, 1])) < NODE_EPS * 2:
                    continue
        dz = abs(za[q] - zb[q])
        rail = kind[a] == 1 or kind[b] == 1
        clear = CLEARANCE_RAIL if rail else CLEARANCE_ROAD
        if dz >= clear:
            continue
        ba, bb = bool(flg[a] & F_BRIDGE), bool(flg[b] & F_BRIDGE)

        def lab(s):
            if kind[s] == 0:
                return _lbl(ctx, int(P[s]))
            return f"rail ({['main', 'siding', 'subway', 'light rail', 'tram', 'other'][min(int(cls[s]), 5)]}{', bridge' if flg[s] & F_BRIDGE else ''})"

        wa = _cls_w(cls[a]) if kind[a] == 0 else RAIL_W[min(int(cls[a]), 5)]
        wb = _cls_w(cls[b]) if kind[b] == 0 else RAIL_W[min(int(cls[b]), 5)]
        sev = min(wa, wb) * (1 + (clear - dz) / clear)
        bearing = math.atan2(dya[q], dxa[q])
        zz = float(max(za[q], zb[q]))
        pair = (min(osm[a], osm[b]), max(osm[a], osm[b]))
        if ba or bb:
            if "deck_below_clearance" in cats:
                out.append(finding("deck_below_clearance", "rail" if rail else "road", sev, x, y, zz, list(pair),
                                   f"{lab(a)} crosses {lab(b)} with only {dz:.1f} m vertical separation (< {clear} m)",
                                   key=("deck_below_clearance", pair, round(x / 5), round(y / 5)), bearing=bearing))
        elif "flat_crossing" in cats:
            la = int(R.attrs["layer"][P[a]]) if kind[a] == 0 else 0
            lb = int(R.attrs["layer"][P[b]]) if kind[b] == 0 else 0
            note = f"; layers {la}/{lb} say separated" if la != lb else ""
            sub = "road_rail" if rail and not (kind[a] == 1 and kind[b] == 1) else ("rail_rail" if rail else
                                                                                    ("path_highway" if cls[a] == 8 or cls[b] == 8 else "road_road"))
            out.append(finding("flat_crossing", sub, sev, x, y, zz, list(pair),
                               f"{lab(a)} crosses {lab(b)} at the same level (dz {dz:.1f} m) with no shared node and no bridge{note}",
                               key=("flat_crossing", pair, round(x / 5), round(y / 5)), bearing=bearing))
    return out


# ============================================================================ junction hardware
def check_junction_hardware(ctx: RoadCtx, cats: set) -> list[dict]:
    if "junction_hardware_on_grade_sep" not in cats or ctx.tree is None:
        return []
    B, R = ctx.B, ctx.R
    out = []
    J = B.junc
    for q in range(len(J["x"])):
        x, y = J["x"][q], J["y"][q]
        if not B.in_core(x, y):
            continue
        lst = ctx.tree.query_ball_point([x, y], NODE_EPS)
        if not lst:
            continue
        ps = np.unique(ctx.vp[np.asarray(lst)])
        mw = ps[(ctx.cls[ps] == 0) & ((ctx.flags[ps] & F_LINK) == 0)]
        br = ps[(ctx.flags[ps] & F_BRIDGE) != 0]
        sig = bool(J["flags"][q] & 1)
        if len(mw) or len(br):
            p = int(mw[0] if len(mw) else br[0])
            sub = "junction_on_motorway" if len(mw) else "junction_on_bridge"
            sev = (3.0 if sig else 1.5) * (2 if len(mw) else 1)
            names = ", ".join(_lbl(ctx, int(s)) for s in ps[:4])
            out.append(finding("junction_hardware_on_grade_sep", sub, sev, x, y, float(R.Z[lst[0]]), [J["osm"][q]] + [ctx.osm[s] for s in ps[:4]],
                               (f"signalized junction box (crosswalk ladders + stop bars) drawn on {_lbl(ctx, p)}; arms: {names}" if sig else
                                f"junction box blanks lane/edge markings on {_lbl(ctx, p)}; arms: {names}"),
                               key=("junction_hardware_on_grade_sep", J["osm"][q])))
    # crossings / stop / signal nodes on motorways
    pts = B.pts
    m = np.isin(pts["kind"], [0, 1, 2])
    if m.any():
        idx = np.nonzero(m)[0]
        near = ctx.tree.query_ball_point(np.column_stack([pts["x"][idx], pts["y"][idx]]), NODE_EPS)
        for q, lst in zip(idx, near):
            if not lst:
                continue
            ps = np.unique(ctx.vp[np.asarray(lst)])
            mw = ps[(ctx.cls[ps] == 0) & ((ctx.flags[ps] & F_LINK) == 0)]
            if len(mw) and B.in_core(pts["x"][q], pts["y"][q]):
                kind = ["traffic signals", "stop sign", "marked crossing"][pts["kind"][q]]
                out.append(finding("junction_hardware_on_grade_sep", "node_on_motorway", 4.0, pts["x"][q], pts["y"][q], None,
                                   [pts["osm"][q], ctx.osm[mw[0]]], f"{kind} node on {_lbl(ctx, int(mw[0]))}"))
    return out


# ============================================================================ elevation of decks
def _deck_checks(B: Block, L, cls, flags, osm, label, cats: set, rail: bool) -> list[dict]:
    out = []
    if not L.n:
        return out
    sp = L.seg_piece
    m = ((flags[sp] & F_BRIDGE) != 0) & ((flags[sp] & F_TUNNEL) == 0)
    seg, sp = L.seg[m], sp[m]
    if len(seg) == 0:
        return out
    x0, y0, z0 = L.X[seg], L.Y[seg], L.Z[seg]
    x1, y1, z1 = L.X[seg + 1], L.Y[seg + 1], L.Z[seg + 1]
    ln = np.hypot(x1 - x0, y1 - y0)
    if "elevation_jump" in cats:
        grade = np.abs(z1 - z0) / np.maximum(ln, 1e-6)
        bad = (ln >= 3.0) & (grade > DECK_GRADE)
        best: dict = {}
        for q in np.nonzero(bad)[0]:
            o = osm[sp[q]]
            if o not in best or grade[q] > grade[best[o]]:
                best[o] = q
        for o, q in best.items():
            x, y = (x0[q] + x1[q]) / 2, (y0[q] + y1[q]) / 2
            if B.in_core(x, y):
                out.append(finding("elevation_jump", "steep_deck_rail" if rail else "steep_deck", grade[q] * 10, x, y, (z0[q] + z1[q]) / 2, [o],
                                   f"{label(int(sp[q]))} deck grade {grade[q] * 100:.0f}% over {ln[q]:.0f} m",
                                   key=("elevation_jump", "steep", o), bearing=math.atan2(y1[q] - y0[q], x1[q] - x0[q])))
    if "road_below_terrain" in cats:
        n = np.maximum(1, np.ceil(ln / BELOW_STEP)).astype(np.int64)
        rep = np.repeat(np.arange(len(seg)), n + 1)
        t = np.concatenate([np.linspace(0, 1, k + 1) for k in n])
        sx = x0[rep] + (x1[rep] - x0[rep]) * t
        sy = y0[rep] + (y1[rep] - y0[rep]) * t
        sz = z0[rep] + (z1[rep] - z0[rep]) * t
        depth = B.terrain(sx, sy) - sz
        bad = np.nonzero(np.nan_to_num(depth, nan=-1) > BELOW_TERRAIN)[0]
        best = {}
        for q in bad:
            o = osm[sp[rep[q]]]
            if o not in best or depth[q] > depth[best[o]]:
                best[o] = q
        for o, q in best.items():
            if B.in_core(sx[q], sy[q]):
                s = rep[q]
                out.append(finding("road_below_terrain", "rail_deck" if rail else "deck", float(depth[q]), sx[q], sy[q], sz[q], [o],
                                   f"{label(int(sp[s]))} deck is {depth[q]:.1f} m under the terrain (dives into the ground)",
                                   key=("road_below_terrain", o), bearing=math.atan2(y1[s] - y0[s], x1[s] - x0[s])))
    return out


def check_decks(ctx: RoadCtx, cats: set) -> list[dict]:
    if not ({"elevation_jump", "road_below_terrain"} & cats):
        return []
    B = ctx.B
    out = _deck_checks(B, ctx.R, ctx.cls, ctx.flags, ctx.osm, lambda p: _lbl(ctx, p), cats, False) if ctx.R.n else []
    L = B.rails
    if L.n:
        rl = lambda p: f"rail bridge ({['main', 'siding', 'subway', 'light rail', 'tram', 'other'][min(int(L.attrs['class'][p]), 5)]})"  # noqa: E731
        out += _deck_checks(B, L, L.attrs["class"], L.attrs["flags"], L.attrs["osm"], rl, cats, True)
    return out


# ============================================================================ footways
def check_footways(ctx: RoadCtx, cats: set) -> list[dict]:
    B, R = ctx.B, ctx.R
    out = []
    if not R.n:
        return out
    foot = (ctx.cls == 8) & ((ctx.flags & F_TUNNEL) == 0)
    if "footway_as_road" in cats:
        seen = set()
        for p in np.nonzero((ctx.cls >= 8) & ((ctx.flags & F_TUNNEL) == 0))[0]:
            o = ctx.osm[p]
            if o in seen:
                continue
            mid = (R.off[p] + R.off[p + 1] - 1) // 2
            x, y = R.X[mid], R.Y[mid]
            if not B.in_core(x, y):
                continue
            w = ctx.w[p]
            bearing = math.atan2(R.Y[min(mid + 1, R.off[p + 1] - 1)] - R.Y[mid], R.X[min(mid + 1, R.off[p + 1] - 1)] - R.X[mid])
            if w > FOOTWAY_MAX_W:
                seen.add(o)
                out.append(finding("footway_as_road", "too_wide", w - FOOTWAY_MAX_W, x, y, R.Z[mid], [o],
                                   f"{_lbl(ctx, p)} drawn {w:.1f} m wide (paths > {FOOTWAY_MAX_W} m read as roads)",
                                   key=("footway_as_road", o), bearing=bearing))
            elif ctx.flags[p] & F_BRIDGE and w < FOOTBRIDGE_MIN_W:
                seen.add(o)
                out.append(finding("footway_as_road", "thin_footbridge", FOOTBRIDGE_MIN_W - w + 0.5, x, y, R.Z[mid], [o],
                                   f"footbridge {_lbl(ctx, p)} drawn only {w:.1f} m wide (reads as a line)",
                                   key=("footway_as_road", o), bearing=bearing))
    if "duplicate_footway" in cats:
        out += _dup_footway(ctx, foot)
    if "sidewalk_bridge_discontinuity" in cats:
        out += _footway_bridge_gap(ctx, foot)
    return out


def _dup_footway(ctx: RoadCtx, foot: np.ndarray) -> list[dict]:
    B, R = ctx.B, ctx.R
    sp = R.seg_piece
    fm = foot[sp]
    rm = ctx.sidewalk[sp]
    if not fm.any() or not rm.any():
        return []
    fseg, fsp = R.seg[fm], sp[fm]
    rseg, rsp = R.seg[rm], sp[rm]
    # sample footway segments
    x0, y0, x1, y1 = R.X[fseg], R.Y[fseg], R.X[fseg + 1], R.Y[fseg + 1]
    ln = np.hypot(x1 - x0, y1 - y0)
    n = np.maximum(1, np.round(ln / DUP_SAMPLE)).astype(np.int64)
    rep = np.repeat(np.arange(len(fseg)), n)
    t = np.concatenate([(np.arange(k) + 0.5) / k for k in n])
    sx = x0[rep] + (x1[rep] - x0[rep]) * t
    sy = y0[rep] + (y1[rep] - y0[rep]) * t
    slen = (ln / n)[rep]
    sang = np.arctan2((y1 - y0)[rep], (x1 - x0)[rep])
    rl = shapely.linestrings(np.stack([np.stack([R.X[rseg], R.Y[rseg]], 1), np.stack([R.X[rseg + 1], R.Y[rseg + 1]], 1)], 1))
    tree = shapely.STRtree(rl)
    dmax = float((ctx.hw[rsp] + SIDEWALK_W[np.minimum(ctx.cls[rsp], 9)]).max() + DUP_MARGIN)
    a, b = tree.query(shapely.points(sx, sy), predicate="dwithin", distance=dmax)
    if len(a) == 0:
        return []
    from .data import seg_point_dist

    d, _ = seg_point_dist(sx[a], sy[a], R.X[rseg[b]], R.Y[rseg[b]], R.X[rseg[b] + 1], R.Y[rseg[b] + 1])
    lim = ctx.hw[rsp[b]] + SIDEWALK_W[np.minimum(ctx.cls[rsp[b]], 9)] + DUP_MARGIN
    rang = np.arctan2(R.Y[rseg[b] + 1] - R.Y[rseg[b]], R.X[rseg[b] + 1] - R.X[rseg[b]])
    par = np.abs(np.cos(sang[a] - rang)) > math.cos(DUP_ANGLE)
    hit = (d < lim) & par
    dup = np.zeros(len(sx), bool)
    dup[a[hit]] = True
    road_of = np.full(len(sx), -1)
    road_of[a[hit]] = rsp[b[hit]]
    fo = ctx.osm[fsp[rep]]
    out = []
    uo, inv = np.unique(fo, return_inverse=True)
    tot_l = np.bincount(inv, weights=slen, minlength=len(uo))
    dup_l = np.bincount(inv, weights=slen * dup, minlength=len(uo))
    good = np.nonzero((dup_l >= DUP_MIN_LEN) & (dup_l / np.maximum(tot_l, 1e-6) >= DUP_MIN_FRAC))[0]
    dsel = np.nonzero(dup)[0]
    by_way = {}
    for q in dsel[np.isin(inv[dsel], good)]:
        by_way.setdefault(inv[q], []).append(q)
    for g in good:
        o, dl = uo[g], dup_l[g]
        qs = by_way[g]
        q = qs[len(qs) // 2]
        x, y = sx[q], sy[q]
        if not B.in_core(x, y):
            continue
        p = int(fsp[rep[q]])
        rp = int(road_of[q])
        side6 = int(R.attrs["side"][p]) == 6
        out.append(finding("duplicate_footway", "sidewalk_footway" if side6 else "parallel_path", dl / 10, x, y, None, [o, ctx.osm[rp]],
                           f"{'footway=sidewalk' if side6 else 'path'} {_lbl(ctx, p)} runs {dl:.0f} m alongside {_lbl(ctx, rp)} "
                           f"which already draws a sidewalk", key=("duplicate_footway", o), bearing=float(sang[q])))
    return out


def _footway_bridge_gap(ctx: RoadCtx, foot: np.ndarray) -> list[dict]:
    B, R, E = ctx.B, ctx.R, ctx.ends
    out = []
    if len(E["v"]) == 0:
        return out
    ep = E["p"]
    bmask = ((ctx.flags[ep] & F_BRIDGE) != 0) & (ctx.cls[ep] >= 2) & (ctx.cls[ep] <= 5)
    if not bmask.any():
        return out
    bv = E["v"][bmask]
    bt = cKDTree(np.column_stack([R.X[bv], R.Y[bv]]))
    for k in np.nonzero(foot[ep])[0]:
        if len(ctx.end_others[k]):
            continue  # connected to something
        v = int(E["v"][k])
        x, y = R.X[v], R.Y[v]
        if not B.in_core(x, y):
            continue
        d, q = bt.query([x, y], distance_upper_bound=SW_BRIDGE_D)
        if not math.isfinite(d):
            continue
        pb = int(ctx.vp[bv[q]])
        p = int(ep[k])
        out.append(finding("sidewalk_bridge_discontinuity", "footway_dead_end", 2.0 + (SW_BRIDGE_D - d) / 5, x, y, None, [ctx.osm[p], ctx.osm[pb]],
                           f"{_lbl(ctx, p)} dead-ends {d:.1f} m from the start of bridge {_lbl(ctx, pb)} instead of continuing onto it",
                           key=("sidewalk_bridge_discontinuity", ctx.osm[p], round(x), round(y))))
    return out


ROAD_CATS = {"road_width_step", "bridge_width_anomaly", "road_overlap_nonjunction", "flat_crossing",
             "deck_below_clearance", "junction_hardware_on_grade_sep", "elevation_jump", "road_below_terrain",
             "duplicate_footway", "footway_as_road", "sidewalk_bridge_discontinuity", "dash_phase_break"}


def run(B: Block, cats: set, ctx: RoadCtx | None = None) -> list[dict]:
    if not (ROAD_CATS & cats):
        return []
    ctx = ctx or RoadCtx(B)
    out = []
    out += check_connections(ctx, cats)
    out += check_overlap(ctx, cats)
    out += check_crossings(ctx, cats)
    out += check_junction_hardware(ctx, cats)
    out += check_decks(ctx, cats)
    out += check_footways(ctx, cats)
    return out
