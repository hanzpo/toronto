"""Road + rail network model: the geometry the render tiles and the traffic
graph share (docs/ROADS.md).

OSM ways are joined into *strokes* (continuous carriageways / tracks: ways
that continue each other at a node, including straight through junctions,
merges and diverges), then per stroke:

  1. lane / width sanity (bridge ways with phantom lanes, structure widths),
  2. smoothing: every unpinned vertex becomes a tangent arc (rail_geom.fillet),
  3. a lateral profile: edge-line and pavement offsets left/right of the
     centreline per vertex, with TAC/OTM tapers between ways, auxiliary
     (acceleration / deceleration / weaving) lanes at freeway merges and
     diverges, ramps pushed beside the mainline and painted gore areas,
  4. a vertical profile: bridges, tunnels, every road/rail crossing that does
     not share a node (grade separations, inferred where tags are missing),
     curated corridor profiles (pipeline/curated/corridors.json), node-level
     consistency so ramps meet their decks, max-grade approach embankments.

    uv run python -m tpipe.roadnet [--bbox W,S,E,N (world m, debug)]
Output: work/roadnet.npz (+ work/roadnet_report.json, crossings / fixes).
"""

from __future__ import annotations

import argparse
import json
import math
import time
from collections import defaultdict

import numpy as np
import shapely
import shapely.ops
from scipy.spatial import cKDTree

from . import geo
from .rail_geom import LINK_RADIUS, RAIL_RADIUS, ROAD_RADIUS, cumlen, curated_rail_z, fillet
from .terrain import get as get_terrain

# ------------------------------------------------------------------ constants

F_ONEWAY, F_BRIDGE, F_TUNNEL, F_LINK, F_ROUND = 1, 2, 4, 8, 16
F_LOT = 32     # parking aisle / driveway / drive-through: not drawn as road (parking-lot hook)
F_DUP = 64     # footway duplicating a drawn sidewalk / crossing way: not drawn

# per-vertex flags (vf)
V_BRIDGE, V_TUNNEL, V_GRADED, V_EMBED = 1, 2, 4, 8     # EMBED: rail set in pavement
V_STRUCT_SHIFT = 4                                     # bits 4-7: structure type (STRUCT)
STRUCT = {"none": 0, "girder": 1, "portal": 2, "hammerhead": 3, "truss": 4, "arch": 5, "footbridge": 6,
          "rail": 7, "box": 8, "culvert": 9, "grass": 10, "exact": 11}
# "exact" (at grade only): the client draws the solved z as is instead of draping on its terrain
# (curated rail levels such as the Union Station deck, which other layers are built to)

# marking bits (mk, <= 24 bits so it survives a float attribute)
MK_NF, MK_NB = 0, 4                    # lanes forward / backward (4 bits each)
MK_AUXR, MK_AUXL = 8, 10               # auxiliary lanes on the right / left (2 bits)
MK_GORER, MK_GOREL = 1 << 12, 1 << 13  # pavement beyond the edge line is a painted gore
MK_NOEDGER, MK_NOEDGEL = 1 << 14, 1 << 15  # no edge line (glued beside another carriageway)
MK_CONTR, MK_CONTL = 1 << 16, 1 << 17  # edge line drawn as a continuity line
MK_BIKER, MK_BIKEL = 18, 21            # bike facility code (3 bits each, osm_extract _cycleway)
MK_MEDIAN = 1 << 24                    # (unused in float) reserved

# lane widths (m) per class; freeway 3.75 (MTO Design Supplement 2023)
LANE_W = {0: 3.75, 1: 3.65, 2: 3.4, 3: 3.4, 4: 3.35, 5: 3.6, 6: 3.2, 7: 3.0, 9: 3.0}
DEFAULT_KMH = {0: 100, 1: 80, 2: 60, 3: 50, 4: 50, 5: 40, 6: 20, 7: 10, 8: 10, 9: 20}
SIDEWALK_W = {2: 3.2, 3: 2.8, 4: 2.4, 5: 1.9}
BIKE_W = {1: 1.7, 2: 0.0, 3: 0.0, 4: 2.5}   # painted lane 1.5-1.8 (OTM Book 18), buffered +1.0 m buffer
# freeway speed-change lanes (TAC 2017 via MTO DS: parallel accel lane ~350 m incl. 90 m taper)
ACC_LEN, ACC_TAPER = 260.0, 90.0
DEC_LEN, DEC_TAPER = 150.0, 75.0
WEAVE_JOIN = 350.0          # merge aux lane runs on into the next diverge if the gap is shorter
GORE_MAX = 4.5              # painted gore up to this gap between edge lines (m)
BRANCH_DEFL = math.radians(40)
# arterial ramps (OTM Book 11 / TAC GDG 9.17 at 60-70 km/h): shorter speed-change lanes
ART_ACC_LEN, ART_ACC_TAPER = 90.0, 45.0
ART_DEC_LEN, ART_DEC_TAPER = 60.0, 30.0
ART_RAMP_MIN = 80.0          # m: a shorter one-way link is a channelized turn, not a ramp
# vertical: clearances (Toronto ECS bridge design standard 2022; rail per Transport Canada / railway practice)
# road under rail: Toronto's rail underpasses (Yonge, Bay, York St under the USRC) are signed ~4.3-4.5 m
CLEAR = {"road": 5.0, "rail": 7.0, "path": 2.7, "ped_over_road": 5.3, "road_under_rail": 4.5}
DECK = {"road": 1.3, "motorway": 1.9, "rail": 1.5, "path": 0.8}
GRADE = {"motorway": 0.035, "link": 0.055, "road": 0.05, "local": 0.07, "path": 0.12, "rail": 0.014,
         "subway": 0.035, "lrt": 0.05, "tram": 0.06}
RAMP_SMOOTH = 14.0          # m, sigma of the vertical-curve smoothing
DENSE = 10.0                # m, solve spacing


DEBUG_PINS = bool(__import__("os").environ.get("RN_DEBUG_PINS"))
MEM_LIMIT_GB = float(__import__("os").environ.get("TPIPE_MEM_GB", "4"))


def memguard(where: str = "") -> float:
    """Abort if this process's peak RSS exceeds MEM_LIMIT_GB (macOS ru_maxrss is bytes)."""
    import resource
    import sys

    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    gb = r / 1e9 if sys.platform == "darwin" else r / 1e6
    if gb > MEM_LIMIT_GB:
        raise MemoryError(f"roadnet: peak RSS {gb:.1f} GB > {MEM_LIMIT_GB} GB at {where}")
    return gb


def _kmh(cls, speed):
    return speed if 5 < speed < 140 else DEFAULT_KMH.get(int(cls), 40)


def taper_len(dw: float, kmh: float) -> float:
    """Lateral shift taper (TAC GDG / OTM Book 11: L = S·W/1.6 for >= 70 km/h,
    L = W·S²/155 below)."""
    dw = abs(dw)
    L = dw * kmh / 1.6 if kmh >= 70 else dw * kmh * kmh / 155.0
    return max(12.0, L)


# ------------------------------------------------------------------ loading


class Lines:
    """osm_lines.npz restricted to roads (kind 0) and rail (kind 1)."""

    def __init__(self, bbox=None):
        with np.load(geo.WORK / "osm_lines.npz", allow_pickle=True) as f:
            d = {k: f[k] for k in f.files}   # every array loaded once
        kind = d["kind"]
        off = np.concatenate([[0], np.cumsum(d["len"].astype(np.int64))])
        sel = np.nonzero((kind == 0) | (kind == 1))[0]
        if bbox is not None:
            x0, y0, x1, y1 = bbox
            fx = d["xy"][off[sel], 0]
            fy = d["xy"][off[sel], 1]
            sel = sel[(fx > x0) & (fx < x1) & (fy > y0) & (fy < y1)]
        self.src = sel
        lens = (off[sel + 1] - off[sel]).astype(np.int64)
        self.off = np.concatenate([[0], np.cumsum(lens)])
        vi = np.repeat(off[sel] - self.off[:-1], lens) + np.arange(lens.sum())
        self.xy = d["xy"][vi].astype(np.float64)
        self.nid = d["nid"][vi].astype(np.int64)
        g = lambda k, dt=None: (d[k][sel] if k in d else np.zeros(len(sel), dt or np.uint8))
        self.kind = g("kind")
        self.cls = g("cls")
        self.id = g("id")
        self.width = g("width")
        self.lanes = g("lanes").astype(np.int64)
        self.flags = g("flags").astype(np.int64)
        self.layer = g("layer").astype(np.int64)
        self.name = g("name")
        self.speed = g("speed")
        self.side = g("side")
        self.svc, self.sub, self.cyc = g("svc"), g("sub"), g("cyc")
        self.lf, self.lb, self.surf = g("lf").astype(np.int64), g("lb").astype(np.int64), g("surf")
        self.wraw = g("wraw", np.float32) if "wraw" in d else np.full(len(sel), np.nan, np.float32)
        self.xmark = g("xmark")
        self.n = len(sel)
        self.underpass = set()           # street ways opened from tunnel to rail underpass (below)
        # `covered=yes` / building passages were extracted as tunnels: at layer >= 0 they are
        # at grade (Union Station's train shed, passages through buildings), not underground
        lens_ = np.array([cumlen(self.xy[self.off[i]:self.off[i + 1]])[-1] for i in range(self.n)])
        short_cov = ((self.flags & F_TUNNEL) != 0) & (self.layer >= 0) & (lens_ < 600) & (
            ((self.kind == 1) & np.isin(self.cls, [0, 1])) | ((self.kind == 0) & (self.cls >= 5)))
        self.flags[short_cov] &= ~F_TUNNEL
        # short street "tunnels" under a surface rail line are underpasses (York, Bay, Yonge
        # under the Union Station Rail Corridor): open to the sky either side of the rail
        # bridge, drawn at street level with the rail bridged over them
        und = np.nonzero(((self.flags & F_TUNNEL) != 0) & (self.kind == 0) & (self.layer == -1) & (lens_ < 160)
                         & (self.cls <= 5))[0]          # public streets (not PATH, teamways, service tunnels)
        rl = np.nonzero((self.kind == 1) & np.isin(self.cls, [0, 1]) & ((self.flags & F_TUNNEL) == 0))[0]
        if len(und) and len(rl):
            rg = [shapely.LineString(self.xy[self.off[i]:self.off[i + 1]]) for i in rl]
            tree = shapely.STRtree(rg)
            ug = [shapely.LineString(self.xy[self.off[i]:self.off[i + 1]]) for i in und]
            hit = tree.query(ug, predicate="intersects")
            opened = np.unique(und[hit[0]]) if hit.size else np.zeros(0, np.int64)
            self.flags[opened] &= ~F_TUNNEL
            self.underpass = set(opened.tolist())
        self.len = np.array([cumlen(self.xy[self.off[i]:self.off[i + 1]])[-1] for i in range(self.n)])

    def pts(self, i):
        return self.xy[self.off[i]:self.off[i + 1]]

    def nids(self, i):
        return self.nid[self.off[i]:self.off[i + 1]]


def group_of(L: Lines) -> np.ndarray:
    """Stroke-join groups: 0 drivable, 1 path/track, 2 lot (hidden service), 3 rail, 4 tram, 5 dup (hidden)."""
    g = np.zeros(L.n, np.int8)
    g[(L.kind == 0) & (L.cls >= 8)] = 1
    g[(L.kind == 0) & ((L.flags & F_LOT) != 0)] = 2
    g[(L.kind == 0) & ((L.flags & F_DUP) != 0)] = 5
    g[L.kind == 1] = 3
    g[(L.kind == 1) & (L.cls == 4)] = 4
    return g


# ------------------------------------------------------------------ classification


def classify(L: Lines, report: dict) -> None:
    """Hide parking aisles / driveways and footways that duplicate drawn sidewalks."""
    road = L.kind == 0
    lot = road & (L.cls == 6) & np.isin(L.svc, [1, 2, 4])
    L.flags[lot] |= F_LOT
    # separately mapped sidewalks and crossing ways: the road draws its own sidewalk / crosswalk
    fw = road & (L.cls == 8) & np.isin(L.side, [6, 7])
    # untagged footways running beside an arterial / collector / local street for most of their length
    street = np.nonzero(road & (L.cls >= 2) & (L.cls <= 5) & ((L.flags & (F_BRIDGE | F_TUNNEL)) == 0))[0]
    pts, hw = [], []
    for i in street:
        p = L.pts(i)
        s = cumlen(p)
        k = np.arange(0, s[-1] + 0.1, 6.0)
        pts.append(np.stack([np.interp(k, s, p[:, 0]), np.interp(k, s, p[:, 1])], 1))
        hw.append(np.full(len(k), L.width[i] / 2))
    if pts:
        P = np.vstack(pts)
        H = np.concatenate(hw)
        tree = cKDTree(P)
        cand = np.nonzero(road & (L.cls == 8) & (L.sub == 1) & ~fw & ((L.flags & (F_BRIDGE | F_TUNNEL)) == 0))[0]
        for i in cand:
            p = L.pts(i)
            s = cumlen(p)
            if s[-1] < 8:
                continue
            k = np.linspace(0, s[-1], max(3, int(s[-1] / 8)))
            q = np.stack([np.interp(k, s, p[:, 0]), np.interp(k, s, p[:, 1])], 1)
            dd, ii = tree.query(q, distance_upper_bound=40)
            ok = np.isfinite(dd)
            near = np.zeros(len(q), bool)
            near[ok] = dd[ok] < H[ii[ok]] + 7.0
            if near.mean() >= 0.8:
                fw[i] = True
    L.flags[fw] |= F_DUP
    report["hidden_lot"] = int(lot.sum())
    report["hidden_dup_footways"] = int(fw.sum())


# ------------------------------------------------------------------ strokes


def _heading(p: np.ndarray, from_end: bool, reach: float = 15.0) -> float:
    """Direction pointing away from the chosen end into the line."""
    if from_end:
        p = p[::-1]
    s = cumlen(p)
    k = int(np.searchsorted(s, min(reach, s[-1])))
    k = min(max(k, 1), len(p) - 1)
    d = p[k] - p[0]
    return math.atan2(d[1], d[0])


def build_strokes(L: Lines, grp: np.ndarray, report: dict):
    """Pair way ends at nodes into continuous strokes.

    Returns strokes [[(way, reversed), ...]], per-node incidence counts and
    the list of freeway merge / diverge events."""
    nid = L.nid
    first = L.off[:-1]
    last = L.off[1:] - 1
    # incidence per node over every road + rail way (interior vertex = 2)
    w = np.full(len(nid), 2, np.int64)
    w[first] = 1
    w[last] = 1
    uniq, inv = np.unique(nid, return_inverse=True)
    inc = np.bincount(inv, weights=w).astype(np.int64)
    inc_of = dict(zip(uniq.tolist(), inc.tolist()))
    # per-group pass-through (interior) presence
    interior = np.ones(len(nid), bool)
    interior[first] = False
    interior[last] = False
    way_of_v = np.repeat(np.arange(L.n), np.diff(L.off))
    passthru = defaultdict(list)       # node -> [(way, vertex index)]
    for v in np.nonzero(interior)[0]:
        n = int(nid[v])
        if inc_of[n] > 2:
            passthru[n].append((int(way_of_v[v]), int(v)))
    ends = defaultdict(list)           # node -> [(way, end)]  end 0 start, 1 end
    for i in range(L.n):
        ends[int(nid[first[i]])].append((i, 0))
        ends[int(nid[last[i]])].append((i, 1))

    link = {}                          # (way, end) -> (way, end)
    events = []

    def arm(i, e):
        p = L.pts(i)
        h = _heading(p, e == 1)
        ow = bool(L.flags[i] & F_ONEWAY)
        # travel direction relative to the node: 'in' = arrives at node
        io = 0 if not ow else (1 if e == 1 else -1)   # +1 in, -1 out, 0 two-way
        return h, io

    for n, E in ends.items():
        if len(E) < 2 and not passthru.get(n):
            continue
        A = [(i, e) + arm(i, e) for i, e in E]
        cand = []
        for a in range(len(A)):
            for b in range(a + 1, len(A)):
                i, e, h1, io1 = A[a]
                j, f, h2, io2 = A[b]
                if i == j:
                    continue
                if grp[i] != grp[j]:
                    continue
                if (io1 == 0) != (io2 == 0) or (io1 != 0 and io1 == io2):
                    continue
                defl = abs(math.remainder(h1 - h2 - math.pi, math.tau))
                if len(A) > 2 or passthru.get(n):
                    lim = math.radians(30 if grp[i] >= 3 else 38)
                    if defl > lim:
                        continue
                # prefer continuing the same road: class, link-ness and name
                score = defl
                if L.cls[i] != L.cls[j]:
                    score += 0.35
                if (L.flags[i] & F_LINK) != (L.flags[j] & F_LINK):
                    score += 0.5
                if L.name[i] != L.name[j]:
                    score += 0.25
                cand.append((score, a, b))
        cand.sort()
        used = set()
        for defl, a, b in cand:
            if a in used or b in used:
                continue
            used.update((a, b))
            link[(A[a][0], A[a][1])] = (A[b][0], A[b][1])
            link[(A[b][0], A[b][1])] = (A[a][0], A[a][1])
        # freeway merge / diverge: one-way drivable arms of motorway/trunk class or links
        fw = [x for x in A if grp[x[0]] == 0 and x[3] != 0 and (L.cls[x[0]] <= 1 or L.flags[x[0]] & F_LINK)]
        pt = [(i, v) for i, v in passthru.get(n, []) if grp[i] == 0 and L.flags[i] & F_ONEWAY
              and (L.cls[i] <= 1 or L.flags[i] & F_LINK)]
        arterial = False
        if len(fw) + 2 * len(pt) != 3:
            # arterial interchange ramps (parclo loops, diamond ramps): a one-way ramp of real length
            # joining / leaving one carriageway of a divided arterial is a merge / diverge too
            fwa = [x for x in A if grp[x[0]] == 0 and x[3] != 0 and (L.cls[x[0]] <= 4 or L.flags[x[0]] & F_LINK)]
            pta = [(i, v) for i, v in passthru.get(n, []) if grp[i] == 0 and L.flags[i] & F_ONEWAY and L.cls[i] <= 4
                   and not L.flags[i] & F_LINK]
            links = [x for x in fwa if L.flags[x[0]] & F_LINK]
            if (len(fwa) + 2 * len(pta) == 3 and len(links) == 1 and L.len[links[0][0]] >= ART_RAMP_MIN
                    and len(inc_arms := [x for x in A if not (L.flags[x[0]] & F_LINK)]) + 2 * len(pta) >= 2
                    and all(L.flags[x[0]] & F_ONEWAY for x in inc_arms)):
                fw, pt, arterial = fwa, pta, True
        if len(fw) + 2 * len(pt) == 3:
            left = [k for k in range(len(A)) if k not in used and A[k] in fw]
            if len(left) == 1:
                i, e, h, io = A[left[0]]
                # main direction at the node
                if pt:
                    wi, v = pt[0]
                    p = L.pts(wi)
                    k = v - L.off[wi]
                    q = p[min(k + 1, len(p) - 1)] - p[max(k - 1, 0)]
                    mh = math.atan2(q[1], q[0])
                else:
                    pa = [x for x in A if (x[0], x[1]) in link and x in fw]
                    outs = [x for x in pa if x[3] == -1]
                    if not outs:
                        continue
                    mh = outs[0][2]
                # branch arm heading points away from node: diverge if the branch leaves (io -1)
                typ = "diverge" if io == -1 else "merge"
                bh = h if typ == "diverge" else h + math.pi
                dd = math.remainder(bh - mh, math.tau)
                if abs(dd) < BRANCH_DEFL:
                    events.append(dict(node=n, branch=i, bend=e, type=typ, side=1 if dd > 0 else -1, arterial=arterial))
    report["merge_events"] = len(events)

    # walk
    seen = np.zeros(L.n, bool)
    strokes = []

    def walk(i0, e_in):
        """start at way i0 entering through end e_in (so we traverse away from it)"""
        seq = []
        i, e = i0, e_in
        while True:
            seen[i] = True
            rev = e == 1
            seq.append((i, rev))
            out_end = 0 if rev else 1
            nxt = link.get((i, out_end))
            if nxt is None or seen[nxt[0]]:
                break
            i, e = nxt
        return seq

    for i in range(L.n):
        if seen[i]:
            continue
        if (i, 0) not in link:
            strokes.append(walk(i, 0))
        elif (i, 1) not in link:
            strokes.append(walk(i, 1))
    for i in range(L.n):  # cycles
        if not seen[i]:
            strokes.append(walk(i, 0))
    # orient: one-way strokes run with traffic
    for k, st in enumerate(strokes):
        i, rev = st[0]
        if rev and L.flags[i] & F_ONEWAY:
            strokes[k] = [(j, not r) for j, r in reversed(st)]
    report["strokes"] = len(strokes)
    return strokes, inc_of, events


# ------------------------------------------------------------------ per-way lanes / widths


def way_lanes(L: Lines, strokes, report: dict):
    """(nF, nB) per way after sanity checks along each stroke."""
    ow = (L.flags & F_ONEWAY) != 0
    tot = np.maximum(1, L.lanes.copy())
    fixed = []
    for st in strokes:
        if len(st) < 2:
            continue
        ws = [i for i, _ in st]
        if L.kind[ws[0]] != 0 or L.cls[ws[0]] > 6:
            continue
        for k, i in enumerate(ws):
            nb = [tot[ws[j]] for j in (k - 1, k + 1) if 0 <= j < len(ws)]
            mx = max(nb)
            struct = L.flags[i] & (F_BRIDGE | F_TUNNEL)
            if (struct and tot[i] >= 1.5 * mx and tot[i] >= mx + 2) or \
                    (L.cls[i] <= 1 and L.len[i] < 600 and tot[i] >= 2 * mx and tot[i] >= mx + 3):
                fixed.append(dict(osm=int(L.id[i]), name=str(L.name[i]), lanes=int(tot[i]), to=int(mx),
                                  bridge=bool(L.flags[i] & F_BRIDGE)))
                tot[i] = mx
    report["lane_fixes"] = fixed
    nF = np.where(ow, tot, np.maximum(1, tot // 2 + tot % 2))
    nB = np.where(ow, 0, np.maximum(1, tot // 2))
    tag = (L.lf > 0) & (L.lb > 0) & ~ow
    nF[tag] = L.lf[tag]
    nB[tag] = L.lb[tag]
    # single-lane two-way service roads / lanes=1 two-way: one shared unmarked lane
    one = ~ow & (tot == 1)
    nF[one], nB[one] = 1, 0
    return nF.astype(np.int64), nB.astype(np.int64), tot


def way_section(L: Lines, i: int, nF: int, nB: int, base: int):
    """Cross-section of way i: (eL, eR, sL, sR, lw, bikeR, bikeL) in stroke-forward orientation."""
    c = int(L.cls[i])
    f = int(L.flags[i])
    ow = bool(f & F_ONEWAY)
    if c >= 8 or L.kind[i] != 0:
        w = float(L.width[i]) if L.width[i] > 0 else 2.0
        if w != w or w <= 0:
            w = 2.0
        wr = float(L.wraw[i])
        if wr == wr and 0.8 < wr < 8:
            w = wr
        # paths read as roads above ~3 m; footbridge decks need >= 2.6 m to read as structures
        w = float(np.clip(w, 1.5, 3.0))
        if f & F_BRIDGE:
            w = max(w, 2.8)
        return w / 2, w / 2, 0.0, 0.0, w, 0, 0
    lw = LANE_W.get(c, 3.3)
    cyc = int(L.cyc[i])
    bR, bL = cyc & 15, (cyc >> 4) & 15
    bw = lambda b: BIKE_W.get(b, 0.0)
    if f & F_LINK:
        sR, sL = 2.5, 1.0
        lw = 3.75 if c <= 1 else lw
    elif c <= 1:
        sR, sL = (3.0, 2.5) if ow else (2.0, 2.0)
    elif c <= 6:
        sR = sL = 0.35
    else:
        sR = sL = 0.0
    if ow:
        b = min(nF, base) if base else nF
        eL = b * lw / 2 + bw(bL)
        eR = nF * lw - b * lw / 2 + bw(bR)
    else:
        eR = max(nF, 1) * lw + bw(bR)
        eL = nB * lw + bw(bL) if nB else 0.0
        if nB == 0:  # one shared lane (unmarked), centred
            eL = eR = lw * 0.75
    # tagged carriageway width (never on structures: that is often the deck width)
    wr = float(L.wraw[i])
    if wr == wr and not (f & (F_BRIDGE | F_TUNNEL)) and c >= 2:
        tot = eL + eR + sL + sR
        k = (wr - sL - sR) / max(eL + eR, 1)
        if 0.72 < k < 1.35:
            eL *= k
            eR *= k
            lw *= k
    return eL, eR, sL, sR, lw, bR, bL


# ------------------------------------------------------------------ stroke geometry + lateral profile


class Stroke:
    __slots__ = ("ways", "xy", "s", "vway", "pinned_v", "kind", "cls", "group", "oneway", "nodes", "node_s", "attrs",
                 "z", "g", "vf", "req_lo", "req_hi", "pins", "struct", "sw", "ev", "dense", "ws", "exact", "corridor", "cpins")

    def __init__(self):
        self.dense = False
        self.exact = False
        self.corridor = -1
        self.cpins = {}           # corridor bed pins (kept through node-consistency rounds)
        self.sw = None
        self.ws = None
        self.vf = None
        self.g = None
        self.z = None
        self.attrs = None
        self.req_lo = []
        self.req_hi = []
        self.pins = {}
        self.ev = []


def assemble(L: Lines, st, inc_of, grp):
    """Raw stroke polyline, per-vertex source way index and pinned mask, node ids."""
    pts, nodes, vway = [], [], []
    for k, (i, rev) in enumerate(st):
        p = L.pts(i)
        n = L.nids(i)
        if rev:
            p, n = p[::-1], n[::-1]
        if k > 0:
            p, n = p[1:], n[1:]
        pts.append(p)
        nodes.append(n)
        vway.append(np.full(len(p), k, np.int64))
    P = np.vstack(pts)
    N = np.concatenate(nodes)
    VW = np.concatenate(vway)
    pinned = np.array([inc_of.get(int(x), 0) >= 3 for x in N])
    pinned[0] = pinned[-1] = True
    return P, N, VW, pinned


def radius_for(L: Lines, i: int) -> float:
    if L.kind[i] == 1:
        return RAIL_RADIUS.get(int(L.cls[i]), 60.0)
    if L.flags[i] & F_LINK:
        return LINK_RADIUS
    if L.flags[i] & F_ROUND:
        return 25.0
    return ROAD_RADIUS.get(int(L.cls[i]), 20.0)


def lateral_profile(L: Lines, S: Stroke, nF, nB, events_here):
    """Per-vertex eL, eR, pL, pR, mk, lw along the stroke. Inserts vertices at
    taper ends / lane changes (a lane change duplicates the vertex)."""
    st = S.ways
    ws = [i for i, _ in st]
    s = S.s
    # way s-ranges
    rng = []
    for k in range(len(ws)):
        idx = np.nonzero(S.vway == k)[0]
        a = idx[0] - (1 if k > 0 else 0)
        rng.append((s[max(a, 0)], s[idx[-1]]))
    ow = S.oneway
    lanes = [int(nF[i]) + int(nB[i]) for i in ws]
    base = int(np.median([nF[i] for i in ws])) if ow else 0
    sec = []
    for k, (i, rev) in enumerate(st):
        f, b = int(nF[i]), int(nB[i])
        eL, eR, sL, sR, lw, bR, bL = way_section(L, i, f, b, base)
        if rev and not ow:  # traversed against the way: swap sides / directions
            eL, eR, sL, sR, bR, bL, f, b = eR, eL, sR, sL, bL, bR, b, f
        sec.append([eL, eR, sL, sR, lw, bR, bL, f, b])
    sec = np.array(sec, dtype=np.float64)
    kmh = [_kmh(L.cls[i], L.speed[i]) for i in ws]
    # merge / diverge nodes on this stroke: no taper on the branch side there
    ev_s = {}
    for ev in events_here:
        ev_s.setdefault(round(ev["s"], 2), set()).add(ev["side"])
    # breakpoints per side value (eL, eR, sL, sR)
    bps = [[] for _ in range(4)]
    cuts = []           # (s, k_before, k_after) lane-count change points
    for k in range(len(ws)):
        a, b = rng[k]
        for c in range(4):
            bps[c].append((a, sec[k, c]))
            bps[c].append((b, sec[k, c]))
    for k in range(len(ws) - 1):
        sb = rng[k][1]
        la, lb_ = lanes[k], lanes[k + 1]
        if sec[k, 7] != sec[k + 1, 7] or sec[k, 8] != sec[k + 1, 8]:
            cuts.append(sb)
        sides_ev = set()
        for key, v in ev_s.items():
            if abs(key - sb) < 1.0:
                sides_ev |= v
        for c in range(4):
            d = sec[k + 1, c] - sec[k, c]
            if abs(d) < 0.05:
                continue
            side = 1 if c in (0, 2) else -1
            if side in sides_ev:
                T = 0.5
            else:
                T = taper_len(d, max(kmh[k], kmh[k + 1]))
            la_len = rng[k][1] - rng[k][0]
            lb_len = rng[k + 1][1] - rng[k + 1][0]
            if lb_ > la:      # lane added: full width at the boundary
                T = min(T, 0.45 * la_len)
                t0, t1 = sb - T, sb
            elif lb_ < la:    # lane dropped: taper after
                T = min(T, 0.45 * lb_len)
                t0, t1 = sb, sb + T
            else:
                T = min(T, 0.45 * la_len, 0.45 * lb_len) if T > 0.5 else T
                t0, t1 = sb - T / 2, sb + T / 2
            bps[c] = [(x, v) for x, v in bps[c] if not (t0 < x < t1) and not (abs(x - sb) < 1e-6)]
            bps[c].append((t0, sec[k, c]))
            bps[c].append((t1, sec[k + 1, c]))
    # auxiliary lanes from merge / diverge events (per side), unioned
    aux = {1: [], -1: []}
    for ev in events_here:
        if ev.get("osm_aux"):
            continue
        s0 = ev["s"]
        art = ev.get("arterial", False)
        if ev["type"] == "merge":
            aux[ev["side"]].append((s0, s0 + (ART_ACC_LEN if art else ACC_LEN), 0.0, ART_ACC_TAPER if art else ACC_TAPER))
        else:
            aux[ev["side"]].append((s0 - (ART_DEC_LEN if art else DEC_LEN), s0, ART_DEC_TAPER if art else DEC_TAPER, 0.0))
    auxbp = {}
    S.ev = []                       # (s0, s1, side): merge / diverge stretches (no sidewalk there)
    for side, iv in aux.items():
        for a_, b_, ta, tb in iv:
            S.ev.append((a_ - ta, b_ + tb, side))
        iv = [(max(s[0], a), min(s[-1], b), ta, tb) for a, b, ta, tb in sorted(iv)]
        merged = []
        for a, b, ta, tb in iv:
            if merged and a - merged[-1][1] < WEAVE_JOIN:
                pa, pb, pta, ptb = merged[-1]
                merged[-1] = (pa, max(pb, b), pta, tb if b >= pb else ptb)
            else:
                merged.append((a, b, ta, tb))
        pts = [(s[0] - 1, 0.0)]
        for a, b, ta, tb in merged:
            pts += [(a - ta, 0.0), (a, 1.0), (b, 1.0), (b + tb, 0.0)]
        pts.append((s[-1] + 1, 0.0))
        auxbp[side] = (merged, pts)
    # new vertices: all breakpoints inside the stroke
    extra = set()
    for c in range(4):
        for x, _ in bps[c]:
            if s[0] < x < s[-1]:
                extra.add(round(x, 3))
    for side in auxbp:
        for x, _ in auxbp[side][1]:
            if s[0] < x < s[-1]:
                extra.add(round(x, 3))
    # densify tapers (curved alignments)
    ext = sorted(extra)
    S_new = np.unique(np.concatenate([s, np.array(ext, dtype=np.float64)]))
    # duplicate lane-change vertices
    dup = [c for c in cuts if s[0] < c < s[-1]]
    xy = np.stack([np.interp(S_new, s, S.xy[:, 0]), np.interp(S_new, s, S.xy[:, 1])], 1)
    # keep exact original vertices (np.interp at original s returns them)
    vway = np.searchsorted([r[1] for r in rng], S_new - 1e-6).clip(0, len(ws) - 1)
    order = np.arange(len(S_new))
    if dup:
        di = np.searchsorted(S_new, dup)
        order = np.sort(np.concatenate([order, di]))
        S_new, xy = S_new[order], xy[order]
        vway = vway[order]
        # the second copy of each duplicated vertex belongs to the next way
        isdup = np.zeros(len(S_new), bool)
        isdup[1:] = order[1:] == order[:-1]
        vway[isdup] = np.minimum(vway[isdup] + 1, len(ws) - 1)
    val = []
    for c in range(4):
        bp = sorted(bps[c])
        xs = np.array([x for x, _ in bp])
        vs = np.array([v for _, v in bp])
        val.append(np.interp(S_new, xs, vs))
    eL, eR, sL, sR = val
    lw = sec[vway, 4]
    f = sec[vway, 7].astype(np.int64)
    b = sec[vway, 8].astype(np.int64)
    bR = sec[vway, 5].astype(np.int64)
    bL = sec[vway, 6].astype(np.int64)
    auxR = np.zeros(len(S_new))
    auxL = np.zeros(len(S_new))
    for side, (merged, pts) in auxbp.items():
        xs = np.array([x for x, _ in pts])
        vs = np.array([v for _, v in pts])
        a = np.interp(S_new, xs, vs)
        if side == -1:
            auxR = a
        else:
            auxL = a
    eR = eR + auxR * lw
    eL = eL + auxL * lw
    fullR = (auxR > 0.999).astype(np.int64)
    fullL = (auxL > 0.999).astype(np.int64)
    # OSM-modelled aux lanes (lanes added at a merge / before a diverge)
    osmaux = np.zeros(len(S_new), np.int64)
    for ev in events_here:
        if ev.get("osm_aux"):
            s0 = ev["s"]
            if ev["type"] == "merge":
                m = (S_new >= s0) & (S_new <= s0 + 700)
            else:
                m = (S_new >= s0 - 700) & (S_new <= s0)
            osmaux[m] = np.maximum(osmaux[m], ev["osm_aux"])
    nFt = f + fullR + fullL
    # lane sanity: a short OSM way with a smaller lanes tag inside a wider carriageway (a split for
    # turn lanes, a mistagged bridge way) keeps the width of its neighbours through the tapers --
    # mark the lanes that width holds instead of one lane line pair on a 10 m pavement
    if ow:
        fit = np.floor((eL + eR) / np.maximum(lw, 2.5) + 0.35).astype(np.int64) - b - fullR - fullL
        grow = fit > f
        f = np.where(grow, np.minimum(fit, 8), f)
        nFt = f + fullR + fullL
    mk = (np.minimum(nFt, 15) << MK_NF) | (np.minimum(b, 15) << MK_NB)
    mk |= (np.minimum(fullR + osmaux, 3) << MK_AUXR) | (np.minimum(fullL, 3) << MK_AUXL)
    mk |= (np.minimum(bR, 7) << MK_BIKER) | (np.minimum(bL, 7) << MK_BIKEL)
    # shoulders vanish where an aux lane occupies them? no: shoulders stay outside aux lanes
    S.xy = xy
    S.s = S_new
    S.vway = vway
    S.attrs = dict(eL=eL, eR=eR, pL=eL + sL, pR=eR + sR, mk=mk, lw=lw)


# ------------------------------------------------------------------ merges: push ramps, gores


def _project(P: np.ndarray, s: np.ndarray, q: np.ndarray, lo: int, hi: int):
    """Project points q onto polyline P[lo:hi+1]: returns (s, signed lateral offset (+left), seg index)."""
    A = P[lo:hi]
    B = P[lo + 1:hi + 1]
    d = B - A
    ll = (d * d).sum(1)
    ll[ll < 1e-12] = 1e-12
    out_s = np.empty(len(q))
    out_d = np.empty(len(q))
    out_k = np.empty(len(q), np.int64)
    for j, p in enumerate(q):
        t = np.clip(((p - A) * d).sum(1) / ll, 0, 1)
        c = A + d * t[:, None]
        dist = np.hypot(*(p - c).T)
        k = int(np.argmin(dist))
        cr = d[k, 0] * (p[1] - A[k, 1]) - d[k, 1] * (p[0] - A[k, 0])
        out_s[j] = s[lo + k] + t[k] * (s[lo + k + 1] - s[lo + k])
        out_d[j] = math.copysign(dist[k], cr)
        out_k[j] = lo + k
    return out_s, out_d, out_k


def apply_merges(strokes: list[Stroke], events, report):
    """Push each ramp beside its mainline's edge near the merge / diverge node,
    fill the gap between the edge lines with a painted gore, drop the shoulders
    in between and mark the glued stretch's edge as a continuity line."""
    done = 0
    for ev in events:
        M = strokes[ev["main"]]
        B = strokes[ev["bstroke"]]
        if M is B or M.attrs is None or B.attrs is None:
            continue
        side = ev["side"]           # +1 branch on the left of the main, -1 right
        sm = ev["s"]
        # branch vertices near the node (branch stroke runs away from / towards the node)
        bn = ev["bs"]               # branch s at node
        reach = 450.0
        sel = np.nonzero(np.abs(B.s - bn) <= reach)[0]
        if len(sel) < 2:
            continue
        lo = int(np.searchsorted(M.s, sm - reach - 100))
        hi = int(np.searchsorted(M.s, sm + reach + 100))
        lo, hi = max(lo, 0), min(hi, len(M.s) - 1)
        if hi - lo < 1:
            continue
        ps, pd, pk = _project(M.xy, M.s, B.xy[sel], lo, hi)
        eM = np.interp(ps, M.s, M.attrs["eL"] if side > 0 else M.attrs["eR"])
        # branch inner side (toward the main): for a right-side branch its left
        eB = B.attrs["eL"][sel] if side < 0 else B.attrs["eR"][sel]
        target = eM + eB                       # |offset| of branch centreline when glued
        nat = side * pd                        # natural offset on the branch side (may be < 0 near node)
        push = np.maximum(0.0, target - nat)
        # stop pushing once the branch has clearly left (natural gap large) -- push only
        # on the contiguous run from the node outward
        order = np.argsort(np.abs(B.s[sel] - bn))
        active = np.zeros(len(sel), bool)
        for o in order:
            if push[o] <= 0 and np.abs(B.s[sel][o] - bn) > 5:
                break
            active[o] = True
        push[~active] = 0
        if not push.any():
            continue
        # normal of the main at the projections
        k = pk
        t = M.xy[k + 1] - M.xy[k]
        tl = np.hypot(*t.T)
        tl[tl < 1e-9] = 1
        nrm = np.stack([-t[:, 1] / tl, t[:, 0] / tl], 1) * side
        B.xy[sel] = B.xy[sel] + nrm * push[:, None]
        gap = nat - target                      # >0 where not glued (edge lines apart)
        glued = active & (push > 0)
        gore = ~glued & (gap > 0) & (gap < GORE_MAX) & (np.abs(B.s[sel] - bn) < reach)
        # gore run: contiguous from the glued stretch outward
        gsel = np.zeros(len(sel), bool)
        started = False
        for o in order:
            if glued[o]:
                started = True
                continue
            if started and gore[o]:
                gsel[o] = True
            elif started:
                break
        inner_p = "pL" if side < 0 else "pR"
        inner_e = "eL" if side < 0 else "eR"
        bmk = B.attrs["mk"]
        for j, v in enumerate(sel):
            if glued[j]:
                B.attrs[inner_p][v] = B.attrs[inner_e][v]
                bmk[v] |= MK_NOEDGEL if side < 0 else MK_NOEDGER
            elif gsel[j]:
                B.attrs[inner_p][v] = B.attrs[inner_e][v] + gap[j]
                # the gore is bordered by the main's edge line: no own (yellow left) edge line on the
                # ramp along it
                bmk[v] |= (MK_GOREL | MK_NOEDGEL) if side < 0 else (MK_GORER | MK_NOEDGER)
        # main: no shoulder alongside glued + gore stretch; continuity edge along glued
        gs = ps[glued]
        span = ps[glued | gsel]
        if len(span):
            M.ev.append((float(span.min()), float(span.max()), side))
        if len(gs):
            a, b = gs.min() - 2, gs.max() + 2
            m = (M.s >= a) & (M.s <= b)
            key_p, key_e = ("pL", "eL") if side > 0 else ("pR", "eR")
            M.attrs[key_p][m] = M.attrs[key_e][m]
            M.attrs["mk"][m] |= MK_CONTL if side > 0 else MK_CONTR
        if gsel.any():
            gs2 = ps[gsel]
            a, b = gs2.min() - 2, gs2.max() + 2
            m = (M.s >= a) & (M.s <= b)
            key_p, key_e = ("pL", "eL") if side > 0 else ("pR", "eR")
            M.attrs[key_p][m] = M.attrs[key_e][m]
        done += 1
    report["merges_built"] = done


# ------------------------------------------------------------------ vertical


def _sweep_max(s, req):
    """upper envelope of cones: out[i] = max_j req[j] - G_j*|s_i - s_j|; req = (value, grade) arrays"""
    val, G = req
    out = val.copy()
    cur, g = -np.inf, 0.0
    for i in range(len(s)):
        if i:
            cur -= g * (s[i] - s[i - 1])
        if val[i] > cur:
            cur, g = val[i], G[i]
        out[i] = max(out[i], cur)
    cur, g = -np.inf, 0.0
    for i in range(len(s) - 1, -1, -1):
        if i < len(s) - 1:
            cur -= g * (s[i + 1] - s[i])
        if val[i] > cur:
            cur, g = val[i], G[i]
        out[i] = max(out[i], cur)
    return out


def _sweep_min(s, val, G):
    o = _sweep_max(s, (-val, G))
    return -o


def grade_of(L: Lines, i: int) -> float:
    if L.kind[i] == 1:
        return {0: GRADE["rail"], 1: GRADE["rail"] * 1.5, 2: GRADE["subway"], 3: GRADE["lrt"], 4: GRADE["tram"]}.get(
            int(L.cls[i]), GRADE["lrt"])
    c = int(L.cls[i])
    if L.flags[i] & F_LINK:
        return GRADE["link"]
    if c <= 1:
        return GRADE["motorway"]
    if c <= 4:
        return GRADE["road"]
    if c <= 7:
        return GRADE["local"]
    return GRADE["path"]


# vertical-curve length scale per class of line (m): the solve spreads a rise over ~2-3 of these
ELL = {"motorway": 130.0, "link": 55.0, "road": 55.0, "local": 40.0, "path": 12.0, "rail": 220.0, "subway": 120.0,
       "lrt": 70.0, "tram": 45.0}


def _ell_of(L: Lines, i: int) -> float:
    if L.kind[i] == 1:
        return {0: ELL["rail"], 1: ELL["rail"] * 0.6, 2: ELL["subway"], 3: ELL["lrt"], 4: ELL["tram"]}.get(int(L.cls[i]), ELL["lrt"])
    c = int(L.cls[i])
    if c == 8 and L.sub[i] == 4:
        return 4.0          # stairs
    if L.flags[i] & F_LINK:
        return ELL["link"]
    if c <= 1:
        return ELL["motorway"]
    if c <= 4:
        return ELL["road"]
    if c <= 7:
        return ELL["local"]
    return ELL["path"]


CORR_D = 8.0          # m: parallel tracks this close belong to one corridor cluster
CORR_CELL = 6.0       # m: height-field cell
CORR_SIGMA = 3.0      # cells: field smoothing (about 18 m) -- level across, smooth along


def corridor_fields(strokes: list[Stroke], report) -> set:
    """Lateral coherence of track levels (docs/ROADS.md "Source of truth"): heavy-rail tracks that
    run parallel within CORR_D m form corridor clusters (union-find over close parallel vertex
    pairs); each cluster gets one smooth height field (robust median per cell, normalised
    Gaussian smoothing), curated exact levels dominating; every track vertex of the cluster is
    pinned to the field, except bridge / tunnel runs and the approach ramps of tracks that leave
    the field towards them (real flyovers and dives). Returns the strokes to re-solve."""
    from scipy.ndimage import gaussian_filter
    ids = [si for si, S in enumerate(strokes) if S.kind == 1 and S.cls <= 1 and len(S.s) >= 2 and S.z is not None]
    if len(ids) < 2:
        return set()
    P, T, O, V = [], [], [], []
    for si in ids:
        S = strokes[si]
        t = np.gradient(S.xy, axis=0)
        t /= np.maximum(np.hypot(t[:, 0], t[:, 1]), 1e-9)[:, None]
        ok = (S.vf & V_TUNNEL) == 0
        P.append(S.xy[ok]); T.append(t[ok]); O.append(np.full(ok.sum(), si)); V.append(np.nonzero(ok)[0])
    P, T, O, V = np.vstack(P), np.vstack(T), np.concatenate(O), np.concatenate(V)
    if len(P) < 2:
        return set()
    tree = cKDTree(P)
    pairs = tree.query_pairs(CORR_D, output_type="ndarray")
    if not len(pairs):
        return set()
    a, b = pairs[:, 0], pairs[:, 1]
    keep = (O[a] != O[b]) & (np.abs((T[a] * T[b]).sum(1)) > 0.85)
    parent = {si: si for si in ids}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for i, j in zip(O[a[keep]], O[b[keep]]):
        ri, rj = find(int(i)), find(int(j))
        if ri != rj:
            parent[ri] = rj
    clusters = defaultdict(list)
    for si in ids:
        clusters[find(si)].append(si)
    fixed = set()
    n_cl = n_pin = 0
    for root, members in clusters.items():
        if len(members) < 2:
            continue
        n_cl += 1
        for si in members:
            strokes[si].corridor = root
        # per-vertex data of the cluster
        xs, zs, ws, own, vix, free = [], [], [], [], [], []
        for si in members:
            S = strokes[si]
            ex = (S.vf >> V_STRUCT_SHIFT) == STRUCT["exact"]
            st = (S.vf & (V_BRIDGE | V_TUNNEL)) != 0
            xs.append(S.xy); zs.append(S.z); ws.append(np.where(ex, 50.0, 1.0)); own.append(np.full(len(S.s), si))
            vix.append(np.arange(len(S.s))); free.append(~st)
        X, Z, W, OW, VI, FR = np.vstack(xs), np.concatenate(zs), np.concatenate(ws), np.concatenate(own), \
            np.concatenate(vix), np.concatenate(free)
        x0, y0 = X.min(0) - 3 * CORR_CELL * CORR_SIGMA
        nx = int((X[:, 0].max() - x0) / CORR_CELL) + 3 * int(CORR_SIGMA) + 3
        ny = int((X[:, 1].max() - y0) / CORR_CELL) + 3 * int(CORR_SIGMA) + 3
        if nx * ny > 4_000_000:
            continue                                   # a region-sized cluster: leave it to the solve
        ci = ((X[:, 0] - x0) / CORR_CELL).astype(np.int64)
        cj = ((X[:, 1] - y0) / CORR_CELL).astype(np.int64)

        def field(use):
            # robust per-cell level (weighted median), then normalised Gaussian smoothing
            num = np.zeros((ny, nx)); den = np.zeros((ny, nx))
            cell = cj[use] * nx + ci[use]
            order = np.lexsort((Z[use], cell))
            cu, zu, wu = cell[order], Z[use][order], W[use][order]
            starts = np.concatenate([[0], np.nonzero(np.diff(cu))[0] + 1, [len(cu)]])
            for a_, b_ in zip(starts[:-1], starts[1:]):
                if b_ <= a_:                        # no tracks in this pass (empty selection)
                    continue
                w_ = wu[a_:b_]
                c = np.cumsum(w_)
                med = zu[a_ + int(np.searchsorted(c, c[-1] / 2))]
                k = cu[a_]
                num.flat[k] = med * c[-1]
                den.flat[k] = c[-1]
            num = gaussian_filter(num, CORR_SIGMA, mode="constant")
            den = gaussian_filter(den, CORR_SIGMA, mode="constant")
            return np.where(den > 1e-9, num / np.maximum(den, 1e-12), np.nan)
        F = field(FR)
        fz = F[cj, ci]
        # flyover / dive approaches: a track leaving the field by > 1.5 m with its own bridge or
        # tunnel run within 300 m keeps its solved profile there
        fly = np.zeros(len(Z), bool)
        for si in members:
            S = strokes[si]
            m = OW == si
            st = (S.vf & (V_BRIDGE | V_TUNNEL)) != 0
            if not st.any():
                continue
            sb = S.s[st]
            near = np.min(np.abs(S.s[:, None] - sb[None, :]), axis=1) < 300.0 if len(sb) < 4000 else np.ones(len(S.s), bool)
            dev = np.abs(Z[m] - fz[m]) > 1.5
            fly[np.nonzero(m)[0][near & dev]] = True
        if fly.any():
            F = field(FR & ~fly)
            fz = F[cj, ci]
        # tracks beside curated (exact) ones take the curated level (no step at the snap edge)
        EXm = W > 1.0
        if EXm.any() and (~EXm).any():
            et = cKDTree(X[EXm])
            d_, k_ = et.query(X[~EXm], distance_upper_bound=CORR_D + 2.0)
            hit = np.isfinite(d_)
            idx = np.nonzero(~EXm)[0][hit]
            fz[idx] = Z[EXm][k_[hit]]
        pin = FR & ~fly & np.isfinite(fz)
        for si in members:
            S = strokes[si]
            m = np.nonzero((OW == si) & pin)[0]
            if not len(m):
                continue
            ex = (S.vf >> V_STRUCT_SHIFT) == STRUCT["exact"]
            pins = {int(VI[k]): float(fz[k]) for k in m if not ex[VI[k]]}
            if pins:
                S.pins = {**S.pins, **pins}
                fixed.add(si)
                n_pin += len(pins)
    report["corridor_clusters"] = n_cl
    report["corridor_pins"] = n_pin
    return fixed


def solve_profile(S: Stroke, L: Lines, curated=None):
    """Elevation per vertex: regularised least squares on the stroke,

        min  sum w_i (z_i - t_i)^2 ds  +  sum lam_i (z'')^2 ds
        s.t. z_i >= lo_i (clearances over crossings, decks over the ground),
             z_i <= hi_i (tunnel cover), z_i = pin / curated (strong weights)

    t = ground for at-grade vertices (weight 1), free on decks (weight 0) and
    ground - cover in tunnels (weak). lam = ell^4 gives vertical curves with a
    length scale ell per class; inequalities by an active set (a few passes).
    Duplicate (zero-length) vertices share one unknown."""
    s, g = S.s, S.g
    n0 = len(s)
    ws = [i for i, _ in S.ways]
    vf = S.vf
    br = (vf & V_BRIDGE) != 0
    tu = (vf & V_TUNNEL) != 0
    lo = np.full(n0, -np.inf)
    hi = np.full(n0, np.inf)
    eq = {}
    for (sv, Z, hwid) in S.req_lo:
        m = np.abs(s - sv) <= hwid
        if not m.any():
            m[np.argmin(np.abs(s - sv))] = True
        lo[m] = np.maximum(lo[m], Z)
    for (sv, Z, hwid) in S.req_hi:
        m = np.abs(s - sv) <= hwid
        if not m.any():
            m[np.argmin(np.abs(s - sv))] = True
        hi[m] = np.minimum(hi[m], Z)
    lay = np.array([max(1, abs(int(L.layer[ws[k]]))) for k in S.vway])
    sub = np.array([L.kind[ws[k]] == 1 and L.cls[ws[k]] == 2 for k in S.vway])
    cover = np.where(sub, 14.0, 9.0) * lay
    gs = _smooth_s(s, g, 40.0) if n0 > 3 else g
    # decks stay clear of the ground below; tunnels keep some cover -- both ramp in from the
    # run ends (portals / abutments), otherwise the bounds jump between adjacent vertices
    def run_ramp(mask, R):
        k = np.zeros(n0)
        for a_, b_ in _runs(mask):
            ea = s[a_ - 1] if a_ > 0 else -np.inf     # open stroke ends count as far away
            eb = s[b_ + 1] if b_ < n0 - 1 else np.inf
            d_ = np.minimum(s[a_:b_ + 1] - ea, eb - s[a_:b_ + 1])
            k[a_:b_ + 1] = np.clip(d_ / R, 0.0, 1.0)
        return k
    kb = run_ramp(br, 30.0)
    kt = run_ramp(tu, 90.0)
    # subway / LRT vertices pinned to the rail graph (rail_graph_targets): the pin is the
    # depth, no tunnel-cover bound on top of it
    if curated is not None and S.kind == 1 and len(curated[0]):
        kt[np.isin(np.array([int(L.cls[ws[k]]) for k in S.vway]), (2, 3))] = 0.0
    lo_hard = lo.copy()          # clearances over crossings: enforced first
    lo[br] = np.maximum(lo[br], gs[br] + 1.2 * kb[br] - 0.15)
    hi[tu] = np.minimum(hi[tu], g[tu] - 0.6 * cover[tu] * kt[tu] + 0.3)
    # at-grade roads never dip into the ground (4th-order solutions overshoot slightly)
    free = ~br & ~tu & ((vf >> V_STRUCT_SHIFT) != STRUCT["exact"])   # curated levels are not floored
    # ... except where it must dip under a crossing (a street underpass below a rail corridor)
    for (sv, Z, hwid) in S.req_hi:
        free &= np.abs(s - sv) > hwid + 90.0
    lo[free] = np.maximum(lo[free], g[free] - 0.15)
    if S.pins:
        exv = (vf >> V_STRUCT_SHIFT) == STRUCT["exact"]
        for vi, Z in S.pins.items():
            if curated is not None and exv[int(vi)] and S.kind == 1:
                continue          # a curated level is not moved by node / corridor pins
            eq[int(vi)] = Z
    if curated is not None:
        cm, cz = curated
        for vi, Z in zip(cm, cz):
            eq[int(vi)] = float(Z)
    has = bool(eq) or br.any() or tu.any() or np.isfinite(lo[~free]).any() or np.isfinite(hi).any() \
        or (lo[free] > g[free] - 0.14).any()
    if not has:
        S.z = g.copy()
        return
    # unknowns: unique stations
    # (vertices closer than 1.5 m share one unknown: very short steps make the system stiff)
    gap = np.diff(s)
    newg = np.zeros(len(gap), bool)
    acc = 0.0
    for i_, d_ in enumerate(gap):
        acc += d_
        if acc > 1.5:
            newg[i_] = True
            acc = 0.0
    key = np.concatenate([[0], np.cumsum(newg)])
    n = int(key[-1]) + 1
    first = np.zeros(n, np.int64)
    first[key[::-1]] = np.arange(n0)[::-1]
    su = s[first]
    ds = np.gradient(su) if n > 1 else np.ones(1)
    ds = np.maximum(ds, 0.2)
    # per-unknown data
    ell = np.array([_ell_of(L, ws[k]) for k in S.vway])[first]
    w = np.where(br[first], 1e-5, np.where(tu[first], 0.05, 1.0))
    t = np.where(tu[first], g[first] - cover[first] * kt[first], g[first])
    LO = np.full(n, -np.inf)
    LOH = np.full(n, -np.inf)
    HI = np.full(n, np.inf)
    np.maximum.at(LO, key, lo)
    np.maximum.at(LOH, key, lo_hard)
    np.minimum.at(HI, key, hi)
    EQ = {}
    for vi, Z in eq.items():
        i = int(key[vi])
        # a clearance over a crossing beats a node / corridor pin
        EQ[i] = max(Z, LO[i]) if np.isfinite(LO[i]) and LO[i] > -1e8 and (br[first[i]] or LO[i] > g[first[i]] + 1) \
            and not S.exact else Z
    # normal equations assembled directly in symmetric banded form (bandwidth 2), solved with
    # a banded Cholesky; equality / active constraints only add to the diagonal
    from scipy.linalg import solveh_banded

    ab = np.zeros((3, n))            # ab[2 + i - j, j] = M[i, j] for i <= j (upper form)
    rhs = np.zeros(n)

    def add(i, j, v):                # symmetric contribution M[i,j] += v (i <= j), vectorised
        np.add.at(ab, (2 + i - j, j), v)
    wd = w * ds
    add(np.arange(n), np.arange(n), wd)
    rhs += wd * t
    if n > 2:
        i = np.arange(1, n - 1)
        h1 = np.maximum(su[i] - su[i - 1], 0.2)
        h2 = np.maximum(su[i + 1] - su[i], 0.2)
        lam = ell[i] ** 4 * (h1 + h2) / 2
        c = [2 / (h1 * (h1 + h2)), -2 / (h1 * h2), 2 / (h2 * (h1 + h2))]
        idx = [i - 1, i, i + 1]
        for p_ in range(3):
            for q_ in range(p_, 3):
                add(idx[p_], idx[q_], lam * c[p_] * c[q_])
    if n > 1:
        i = np.arange(n - 1)
        h = np.maximum(su[i + 1] - su[i], 0.2)
        mu = ell[i] ** 2 * 0.25 / h
        add(i, i, mu)
        add(i + 1, i + 1, mu)
        add(i, i + 1, -mu)
    add(np.array([0]), np.array([0]), np.array([1e-6]))
    rhs[0] += 1e-6 * g[first[0]]
    BIG = 3e3 ** 2
    active = dict(EQ)
    z = None
    # active set in two tiers: the hard bounds (crossing clearances, tunnel cover) first; the
    # soft floors (decks over the ground, roads not below it) only where the hard-bound
    # solution still violates them -- pinning floors early left single vertices stuck low
    tier = LOH
    for it in range(40):
        ab2 = ab.copy()
        rhs2 = rhs.copy()
        if active:
            ii = np.fromiter(active.keys(), np.int64)
            zz = np.fromiter(active.values(), np.float64)
            ab2[2, ii] += BIG * ds[ii]
            rhs2[ii] += BIG * ds[ii] * zz
        try:
            z = solveh_banded(ab2, rhs2, lower=False, check_finite=False)
        except np.linalg.LinAlgError:
            from scipy.linalg import solve_banded
            full = np.zeros((5, n))
            full[0:3] = ab2
            full[3, :-1] = ab2[1, 1:]
            full[4, :-2] = ab2[0, 2:]
            z = solve_banded((2, 2), full, rhs2)
        viol = False
        for i in np.nonzero(z < tier - 0.05)[0]:
            if i not in EQ and active.get(int(i)) != tier[i] and not (tier[i] > HI[i]):
                active[int(i)] = tier[i]
                viol = True
        for i in np.nonzero(z > HI + 0.05)[0]:
            if i not in EQ and active.get(int(i)) != HI[i] and not (LO[i] > HI[i]):
                active[int(i)] = HI[i]
                viol = True
        if __import__("os").environ.get("RN_DEBUG_SOLVE"):
            print("   it", it, "tierH", tier is LOH, "active", len(active), "minviolLO", float(np.min(z - LO)), "viol", viol, "maxHIviol", float(np.max(z - HI)))
        if not viol:
            if tier is LOH:
                tier = LO
                continue
            break
    z = z[key]
    # final grade limiter: halfway between the lower and upper G-Lipschitz envelopes removes
    # cliffs left where constraints conflict (e.g. two pins a few metres apart)
    ghard = np.array([_ghard(L, ws[k]) for k in S.vway])
    d_ = np.diff(z)
    h_ = np.maximum(np.diff(s), 1e-3)
    # (the two-tier active set leaves no conflicting cliffs; the limiter's halfway envelope made
    # sawtooth decks between clearance vertices, so it is opt-in now)
    if n0 > 2 and __import__("os").environ.get("RN_LIMIT") and (np.abs(d_) > 2 * ghard[1:] * h_ + 0.05).any():
        up = _sweep_max(s, (z, ghard))
        dn = -_sweep_max(s, (-z, ghard))
        zl_ = (up + dn) / 2
        # clearances over crossings are kept
        req = np.zeros(n0, bool)
        for (sv, Z, hwid) in S.req_lo:
            req |= np.abs(s - sv) <= hwid
        z = np.where(req, np.maximum(z, zl_), zl_)
    S.z = np.clip(z, g - 60.0, g + 90.0)


def _ghard(L: Lines, i: int) -> float:
    """Steepest acceptable grade (streets 12 %, freeways 7 %, rail 4 %, trams 9 %, stairs 80 %)."""
    if L.kind[i] == 1:
        return 0.09 if L.cls[i] == 4 else 0.04
    c = int(L.cls[i])
    if c == 8:
        return 0.8 if L.sub[i] == 4 else 0.25
    return 0.07 if c <= 1 and not (L.flags[i] & F_LINK) else 0.12


def _smooth_s(s, z, sigma, step=2.0):
    """Gaussian smoothing in arclength (non-uniform samples), ends held."""
    from scipy.ndimage import gaussian_filter1d

    if s[-1] - s[0] < step * 3:
        return z.copy()
    u = np.arange(s[0], s[-1] + step, step)
    zu = np.interp(u, s, z)
    return np.interp(s, u, gaussian_filter1d(zu, sigma / step, mode="nearest"))


def _closing_s(s, z, width, step=2.0):
    """Morphological closing in arclength: fills dips narrower than `width`."""
    from scipy.ndimage import grey_closing

    if s[-1] - s[0] < step * 3:
        return z.copy()
    u = np.arange(s[0], s[-1] + step, step)
    zu = np.interp(u, s, z)
    k = max(3, int(width / step) | 1)
    return np.maximum(z, np.interp(s, u, grey_closing(zu, size=k, mode="nearest")))


def _runs(mask):
    i, n = 0, len(mask)
    while i < n:
        if mask[i]:
            j = i
            while j + 1 < n and mask[j + 1]:
                j += 1
            yield i, j
            i = j + 1
        else:
            i += 1


# ------------------------------------------------------------------ crossings


def find_crossings(L: Lines, strokes: list[Stroke], way_stroke, report, subset=None):
    """Every intersection of road/rail centrelines that is not a shared node.
    Returns list of dict(a=way, b=way, p=(x, y))."""
    t0 = time.time()
    m = ((L.kind == 0) & ((L.flags & (F_LOT | F_DUP)) == 0) & (L.cls != 9)) | (L.kind == 1)
    if subset is not None:
        sel = np.zeros(L.n, bool)
        sel[subset] = True
        m &= sel
    cand = np.nonzero(m)[0]
    if len(cand) < 2:
        report["crossings_found"] = 0
        return []
    geoms = _lines(L, cand)
    tree = shapely.STRtree(geoms)
    ia, ib = tree.query(geoms, predicate="crosses")
    m = ia < ib
    ia, ib = cand[ia[m]], cand[ib[m]]
    # paths only matter against drivable roads and rail
    path_a = (L.kind[ia] == 0) & (L.cls[ia] >= 7)
    path_b = (L.kind[ib] == 0) & (L.cls[ib] >= 7)
    keep = ~(path_a & path_b)
    ia, ib = ia[keep], ib[keep]
    ga = _lines(L, ia)
    gb = _lines(L, ib)
    inter = shapely.intersection(ga, gb)
    pts, idx = shapely.get_coordinates(inter, return_index=True)
    out = []
    for k in range(len(pts)):
        a, b = int(ia[idx[k]]), int(ib[idx[k]])
        p = pts[k]
        # shared nodes (the crosses predicate still fires when ways touch and cross elsewhere)
        na = set(L.nids(a).tolist())
        shared = [x for x in L.nids(b).tolist() if x in na]
        if shared:
            pa = L.pts(a)
            ok = True
            for v in np.nonzero(np.isin(L.nids(a), shared))[0]:
                if np.hypot(*(pa[v] - p)) < 0.5:
                    ok = False
            if not ok:
                continue
        out.append(dict(a=a, b=b, p=(float(p[0]), float(p[1]))))
    report["crossings_found"] = len(out)

    return out


def _lines(L: Lines, idx) -> np.ndarray:
    idx = np.asarray(idx, np.int64)
    lens = L.off[idx + 1] - L.off[idx]
    vi = np.repeat(L.off[idx] - np.concatenate([[0], np.cumsum(lens)[:-1]]), lens) + np.arange(lens.sum())
    return shapely.linestrings(L.xy[vi], indices=np.repeat(np.arange(len(idx)), lens))


def _kind_name(L, i):
    if L.kind[i] == 1:
        return "rail"
    if L.cls[i] >= 7:
        return "path"
    return "road"


def decide_levels(L: Lines, X, dsm_sample, report):
    """upper / lower for every crossing; at-grade ones are dropped (reported)."""
    ups = []
    stats = defaultdict(int)
    suspicious = []
    for x in X:
        a, b = x["a"], x["b"]
        fa, fb = int(L.flags[a]), int(L.flags[b])
        la, lb = int(L.layer[a]), int(L.layer[b])
        ta, tb = bool(fa & F_TUNNEL), bool(fb & F_TUNNEL)
        ba, bb = bool(fa & F_BRIDGE), bool(fb & F_BRIDGE)
        ka, kb = _kind_name(L, a), _kind_name(L, b)
        up = None
        how = "tags"
        # OSM `layer` is the authority on stacking; bridge / tunnel only imply +1 / -1 when
        # the layer is untagged (a Lake Shore bridge over a creek is not above the Gardiner)
        ea = la if la != 0 else (1 if ba else -1 if ta else 0)
        eb = lb if lb != 0 else (1 if bb else -1 if tb else 0)
        if ea != eb:
            up = a if ea > eb else b
        elif ta != tb:
            up = b if ta else a
        elif ba != bb:
            up = a if ba else b
        elif ta and tb:
            stats["both_tunnel_same_layer"] += 1
            continue
        else:
            # untagged / same level: grade separation is certain for freeways and rail
            hwy = (ka == "road" and L.cls[a] <= 1 and not L.flags[a] & F_LINK) or \
                  (kb == "road" and L.cls[b] <= 1 and not L.flags[b] & F_LINK)
            if ka == "path" or kb == "path":
                if (ka == "rail" or kb == "rail") or hwy:
                    # footpath crossing a rail line / freeway without a node: a footbridge was not tagged,
                    # or it is an at-grade path crossing -- assume at grade unless freeway
                    if not hwy:
                        stats["path_rail_at_grade"] += 1
                        continue
                else:
                    stats["path_at_grade"] += 1
                    continue
            if ka == "rail" and kb == "rail":
                how = "dsm"
            elif hwy or (ka == "rail") != (kb == "rail"):
                how = "dsm"
            else:
                stats["road_road_no_node"] += 1
                lon, lat = geo.unproject(*x["p"])
                suspicious.append(dict(kind="road_road_no_node", a=int(L.id[a]), b=int(L.id[b]),
                                       lon=round(lon, 6), lat=round(lat, 6)))
                continue
            if (ka == "rail") != (kb == "rail") and not hwy:
                # rail vs ordinary road without a shared node: level crossing with a missing node?
                # use the DSM: a real grade separation shows a structure bump on the lower line
                pass
            bump_a = dsm_sample(L, a, x["p"])
            bump_b = dsm_sample(L, b, x["p"])
            if (ka == "rail") != (kb == "rail") and not hwy and L.cls[a if ka == "rail" else b] in (0, 1) and ((bump_a is None or bump_b is None or abs(bump_a - bump_b) < 2.0)):
                # a main-line / siding track and a street crossing without a shared node: level
                # crossings are always mapped as nodes, so this is a grade separation; in the GTA
                # the corridors run on embankments with streets underneath
                rl = a if ka == "rail" else b
                up = rl
                how = "rail_over_street"
                lon, lat = geo.unproject(*x["p"])
                suspicious.append(dict(kind="inferred_rail_over_street", upper=int(L.id[up]), lower=int(L.id[b if up == a else a]),
                                       lon=round(lon, 6), lat=round(lat, 6)))
                stats["separated_rail_over_street"] += 1
                ups.append(dict(up=up, lo=b if up == a else a, p=x["p"], how=how))
                continue
            if bump_a is None or bump_b is None or abs(bump_a - bump_b) < 2.0:
                # fallback: in Toronto the local road crosses over an at-grade freeway;
                # rail and road: road over rail on arterials, otherwise flagged
                if hwy:
                    fa_h = ka == "road" and L.cls[a] <= 1
                    up = b if fa_h else a
                    how = "class"
                elif (ka == "rail") != (kb == "rail"):
                    stats["rail_road_no_node_at_grade"] += 1
                    lon, lat = geo.unproject(*x["p"])
                    suspicious.append(dict(kind="rail_road_no_node", a=int(L.id[a]), b=int(L.id[b]),
                                           lon=round(lon, 6), lat=round(lat, 6)))
                    continue
                else:
                    up = a if L.cls[a] >= L.cls[b] else b
                    how = "class"
            else:
                up = b if bump_a > bump_b else a   # the lower line shows the upper deck as a bump
            lon, lat = geo.unproject(*x["p"])
            if how != "tags":
                suspicious.append(dict(kind=f"inferred_{how}", upper=int(L.id[up]), lower=int(L.id[b if up == a else a]),
                                       lon=round(lon, 6), lat=round(lat, 6)))
        lo = b if up == a else a
        stats[f"separated_{how}"] += 1
        ups.append(dict(up=up, lo=lo, p=x["p"], how=how))
    report["crossing_levels"] = dict(stats)
    report["suspicious"] = suspicious
    return ups


def make_dsm_sampler(terr):
    from .terrain import sample_dsm

    def f(L, i, p):
        pts = L.pts(i)
        s = cumlen(pts)
        if s[-1] < 1:
            return None
        q = shapely.linestrings(pts)
        sp = shapely.line_locate_point(q, shapely.points(p))
        ks = np.array([sp - 45, sp - 30, sp, sp + 30, sp + 45])
        ok = (ks >= 0) & (ks <= s[-1])
        if ok.sum() < 3 or not ok[2]:
            return None
        xs = np.interp(ks[ok], s, pts[:, 0])
        ys = np.interp(ks[ok], s, pts[:, 1])
        h = sample_dsm(terr, xs, ys)
        mid = h[list(np.nonzero(ok)[0]).index(2)]
        others = np.delete(h, list(np.nonzero(ok)[0]).index(2))
        return float(mid - np.median(others))
    return f


# ------------------------------------------------------------------ curated corridors


_RG = None


def _rail_graph_points():
    """Dense (2 m) subway / LRT track points with the elevation the trains run on, from
    work/rail_graph.pkl (tpipe.rail_graph; run it before roadnet), as (KD-tree, xyz)."""
    global _RG
    if _RG is None:
        import pickle
        p = geo.WORK / "rail_graph.pkl"
        chunks = []
        if p.exists():
            from . import rail_graph as _rail_graph  # noqa: F401  (unpickling needs the class)
            g = pickle.loads(p.read_bytes())
            for e, (seg, _fl) in enumerate(g.e_xyz):
                if int(g.e_kind[e]) not in (1, 2) or len(seg) < 2:
                    continue
                for a_, b_ in zip(seg[:-1], seg[1:]):
                    k = max(1, int(math.ceil(float(np.hypot(*(b_[:2] - a_[:2]))) / 2.0)))
                    t = np.arange(k)[:, None] / k
                    chunks.append(a_[None, :3] + (b_[None, :3] - a_[None, :3]) * t)
                chunks.append(seg[-1:, :3])
            del g
        pts = np.vstack(chunks) if chunks else np.zeros((0, 3))
        _RG = (cKDTree(pts[:, :2]) if len(pts) else None, pts)
    return _RG


def rail_graph_targets(strokes: list, L, curated: dict, report) -> None:
    """Pin subway / LRT strokes to the rail graph's elevations (exact targets, merged into the
    curated ones): the drawn track is the path the trains run on (Yorkdale's east track was
    solved 7 m above its at-grade station). Crossing clearances still apply on top."""
    tree, pts = _rail_graph_points()
    if tree is None:
        return
    n = 0
    for si, S in enumerate(strokes):
        if S.kind != 1:
            continue
        ws = [w for w, _ in S.ways]
        vc = np.array([int(L.cls[ws[k]]) for k in S.vway])
        if not np.isin(vc, (2, 3)).any():
            continue
        d, i = tree.query(S.xy, distance_upper_bound=1.5)
        m = np.isfinite(d) & np.isin(vc, (2, 3))
        if not m.any():
            continue
        idx = np.nonzero(m)[0]
        z = pts[i[m], 2]
        prev = curated.get(si)
        if prev is not None:
            keep = ~np.isin(idx, prev[0])
            idx, z = np.concatenate([prev[0], idx[keep]]), np.concatenate([prev[1], z[keep]])
        curated[si] = (idx, z)
        n += 1
    report["rail_graph_pinned_strokes"] = n


def load_curated():
    p = geo.PIPE / "curated" / "corridors.json"
    out = json.loads(p.read_text())["corridors"] if p.exists() else []
    return out


def curated_targets(C, strokes: list[Stroke], L: Lines, terr, report):
    """Map curated control points onto strokes: per stroke (mask, z) exact targets,
    plus structure types and forced bridge ranges."""
    out = {}
    used = []
    for c in C:
        names = [n.lower() for n in c.get("names", [])]
        ids = set(int(x) for x in c.get("ways", []))
        ctrl = c.get("profile", [])
        if not ctrl:
            continue
        cx, cy = geo.project(np.array([p[0] for p in ctrl]), np.array([p[1] for p in ctrl]))
        cxy = np.stack([cx, cy], 1)
        hts = np.array([p[2] for p in ctrl], np.float64)
        mode = c.get("mode", "above_ground")
        reach = float(c.get("snap", 60.0))
        cls_max = int(c.get("max_class", 1))
        struct = STRUCT.get(c.get("structure", "girder"), 1)
        force = bool(c.get("force_bridge", False))
        box = shapely.buffer(shapely.linestrings(cxy), reach)
        nst = 0
        kind = 1 if c.get("kind") == "rail" else 0
        for si, S in enumerate(strokes):
            if S.kind != kind or S.cls > cls_max:
                continue
            ws = [i for i, _ in S.ways]
            if ids:
                if not any(int(L.id[i]) in ids for i in ws):
                    continue
            elif names and not any(any(n in str(L.name[i]).lower() for n in names) for i in ws):
                # ramps of the corridor carry no name: accept links touching the corridor
                if not all(L.flags[i] & F_LINK for i in ws):
                    continue
            inside = shapely.contains_xy(box, S.xy[:, 0], S.xy[:, 1])
            if not inside.any():
                continue
            # position of each stroke vertex along the control polyline
            line = shapely.linestrings(cxy)
            tpos = shapely.line_locate_point(line, shapely.points(S.xy[inside]))
            cs = cumlen(cxy)
            h = np.interp(tpos, cs, hts)
            # only between the first and last control points
            ok = (tpos > cs[0] + 1e-3) & (tpos < cs[-1] - 1e-3)
            idx = np.nonzero(inside)[0][ok]
            if not len(idx):
                continue
            base = _smooth_s(S.s, S.g, 150.0)[idx] if mode == "above_ground" else 0.0
            zt = base + h[ok]
            # ramps: only pin the part of the ramp within the corridor where it is a bridge
            if all(L.flags[i] & F_LINK for i in ws) and not c.get("pin_links", False):
                keep = (S.vf[idx] & V_BRIDGE) != 0
                idx, zt = idx[keep], zt[keep]
                if not len(idx):
                    continue
            if force:
                S.vf[idx] |= V_BRIDGE
            bi = idx[(S.vf[idx] & V_BRIDGE) != 0]
            S.vf[bi] = (S.vf[bi] & 0x0F) | (struct << V_STRUCT_SHIFT)
            if c.get("exact"):
                ai = idx[(S.vf[idx] & (V_BRIDGE | V_TUNNEL)) == 0]
                S.vf[ai] = (S.vf[ai] & 0x0F) | (STRUCT["exact"] << V_STRUCT_SHIFT)
                S.exact = True
            ms = c.get("main_span")
            if ms:
                mx, my = geo.project(ms["center"][0], ms["center"][1])
                dd = np.hypot(S.xy[bi, 0] - mx, S.xy[bi, 1] - my)
                mi = bi[dd <= ms["length"] / 2]
                S.vf[mi] = (S.vf[mi] & 0x0F) | (STRUCT[ms.get("structure", "truss")] << V_STRUCT_SHIFT)
            if c.get("pin", True):
                prev = out.get(si)
                if prev is None:
                    out[si] = (idx, zt)
                else:
                    out[si] = (np.concatenate([prev[0], idx]), np.concatenate([prev[1], zt]))
            nst += 1
        used.append(dict(id=c["id"], strokes=nst))
    report["curated"] = used
    return out


# ------------------------------------------------------------------ main


def densify_stroke(S: Stroke, step: float):
    """Insert vertices so no segment exceeds `step` (attributes interpolated, discrete ones copied)."""
    s = S.s
    ds = np.diff(s)
    k = np.maximum(1, np.ceil(ds / step).astype(np.int64))
    if (k == 1).all():
        return
    extra = [s[i] + ds[i] * np.arange(1, k[i]) / k[i] for i in range(len(ds)) if k[i] > 1]
    insert_stations(S, np.concatenate(extra))


def insert_stations(S: Stroke, sv) -> np.ndarray:
    """Insert vertices at arclength stations sv (inside the stroke). Continuous attributes are
    interpolated, discrete ones (mk, vf, sw) copied from the segment start; zero-length
    duplicate vertices are preserved. Returns the new index of every old vertex."""
    s = S.s
    n = len(s)
    sv = np.asarray(sv, np.float64)
    sv = sv[(sv > s[0] + 1e-3) & (sv < s[-1] - 1e-3)]
    if len(sv):
        # drop stations that coincide with existing vertices
        j = np.clip(np.searchsorted(s, sv), 1, n - 1)
        sv = sv[(np.abs(s[j] - sv) > 1e-3) & (np.abs(s[j - 1] - sv) > 1e-3)]
    if not len(sv):
        return np.arange(n)
    sv = np.unique(sv)
    S2 = np.concatenate([s, sv])
    orig = np.concatenate([np.ones(n, bool), np.zeros(len(sv), bool)])
    order = np.argsort(S2, kind="stable")
    S2, orig = S2[order], orig[order]
    oldpos = np.empty(n, np.int64)
    oldpos[order[order < n]] = np.nonzero(orig)[0]
    src = np.clip(np.searchsorted(s, S2, side="right") - 1, 0, n - 1)
    nxt = np.clip(src + 1, 0, n - 1)
    xy = np.stack([np.interp(S2, s, S.xy[:, 0]), np.interp(S2, s, S.xy[:, 1])], 1)
    xy[oldpos] = S.xy
    # an inserted vertex lies on segment (src, nxt), which belongs to the way of its END vertex
    # (same convention as the fillet labelling)
    vway = S.vway[nxt]
    vway[oldpos] = S.vway
    if S.attrs is not None:
        A = {}
        for key, v in S.attrs.items():
            if key == "mk":
                a = v[nxt].copy()     # per-way marking state: the segment's (end) way
            else:
                a = np.interp(S2, s, v)
            a[oldpos] = v
            A[key] = a
        S.attrs = A
    if S.vf is not None:
        vf = S.vf[src].copy()
        inner = ~orig
        both = S.vf[src] & S.vf[nxt]
        vf[inner] = (both[inner] & 0x0F) | (S.vf[src][inner] & ~0x0F)
        vf[oldpos] = S.vf
        S.vf = vf
    if S.sw is not None:
        sw = S.sw[nxt].copy()
        sw[oldpos] = S.sw
        S.sw = sw
    for key in ("g", "z"):
        v = getattr(S, key)
        if v is not None and len(v) == n:
            setattr(S, key, np.interp(S2, s, v))
    S.xy, S.s, S.vway = xy, S2, vway
    return oldpos


def _densify_solve(S: Stroke, terr, curated, si):
    """Refine a stroke to DENSE spacing before its vertical solve (keeps pins / curated indices valid)."""
    s = S.s
    ds = np.diff(s)
    k = np.maximum(1, np.ceil(ds / DENSE).astype(np.int64))
    S.dense = True
    if (k == 1).all():
        return
    extra = np.concatenate([s[i] + ds[i] * np.arange(1, k[i]) / k[i] for i in range(len(ds)) if k[i] > 1])
    remap = insert_stations(S, extra)
    S.g = terr.sample(S.xy[:, 0], S.xy[:, 1]).astype(np.float64)
    S.z = S.g.copy() if S.z is None or len(S.z) != len(S.s) else S.z
    S.pins = {int(remap[k_]): v for k_, v in S.pins.items()}
    if si in curated:
        idx, zt = curated[si]
        curated[si] = (remap[idx], zt)


BLOCK = 16384.0      # processing block (m); lines within HALO of a block are processed with it
HALO = 1500.0


def prep(bbox=None) -> dict:
    """Global, cheap pass: lines, classification, strokes, lane sanity, merge events."""
    t0 = time.time()
    report = {}
    L = Lines(bbox)
    print(f"{L.n:,} lines ({(L.kind == 0).sum():,} roads, {(L.kind == 1).sum():,} rail) "
          f"{len(L.xy):,} vertices ({time.time() - t0:.0f}s)", flush=True)
    classify(L, report)
    grp = group_of(L)
    raw_strokes, inc_of, events = build_strokes(L, grp, report)
    print(f"{len(raw_strokes):,} strokes, {len(events):,} merge/diverge events ({time.time() - t0:.0f}s)", flush=True)
    nF, nB, tot = way_lanes(L, raw_strokes, report)
    # way bounding boxes (block selection)
    lens = np.diff(L.off)
    wid = np.repeat(np.arange(L.n), lens)
    bx0 = np.full(L.n, np.inf); by0 = np.full(L.n, np.inf); bx1 = np.full(L.n, -np.inf); by1 = np.full(L.n, -np.inf)
    np.minimum.at(bx0, wid, L.xy[:, 0]); np.minimum.at(by0, wid, L.xy[:, 1])
    np.maximum.at(bx1, wid, L.xy[:, 0]); np.maximum.at(by1, wid, L.xy[:, 1])
    ev_by_way = defaultdict(list)
    for ev in events:
        ev_by_way[ev["branch"]].append(ev)
    stroke_of = np.full(L.n, -1, np.int64)
    for si, st in enumerate(raw_strokes):
        for i, _ in st:
            stroke_of[i] = si
    bd = building_density()
    with np.load(geo.WORK / "osm_nodes.npz") as f:
        nodes = {k: f[k] for k in ("kind", "xy", "id")}
    print(f"prep done ({time.time() - t0:.0f}s, {memguard('prep'):.1f} GB)", flush=True)
    return dict(L=L, grp=grp, raw=raw_strokes, inc=inc_of, events=events, nF=nF, nB=nB, report=report,
                box=(bx0, by0, bx1, by1), stroke_of=stroke_of, bd=bd, nodes=nodes, t0=t0)


def block_strokes(G, halo_box):
    """Sub-strokes: contiguous runs of each stroke's ways that touch the halo box, with the
    arclength of the preceding (dropped) ways so dash phase stays continuous."""
    L = G["L"]
    bx0, by0, bx1, by1 = G["box"]
    x0, y0, x1, y1 = halo_box
    hit = (bx1 >= x0) & (bx0 <= x1) & (by1 >= y0) & (by0 <= y1)
    sids = np.unique(G["stroke_of"][np.nonzero(hit)[0]])
    out = []
    for si in sids:
        if si < 0:
            continue
        st = G["raw"][si]
        acc = 0.0
        run, s0 = [], 0.0
        for i, rev in st:
            if hit[i]:
                if not run:
                    s0 = acc
                run.append((i, rev))
            elif run:
                out.append((run, s0))
                run = []
            acc += float(L.len[i])
        if run:
            out.append((run, s0))
    return out


def run_block(G, core, halo):
    t0 = G["t0"]
    L, grp, inc_of = G["L"], G["grp"], G["inc"]
    nF, nB = G["nF"], G["nB"]
    global nF_glob, nB_glob
    nF_glob, nB_glob = nF, nB
    report = {}
    subs = block_strokes(G, halo)
    raw_strokes = [st for st, _ in subs]
    s_off = [s0 for _, s0 in subs]
    in_block = set(i for st in raw_strokes for i, _ in st)
    events = [ev for ev in G["events"] if ev["branch"] in in_block]
    terr = get_terrain()

    # ---- geometry: assemble + fillet
    strokes: list[Stroke] = []
    way_stroke = np.full(L.n, -1, np.int64)
    node_pos = defaultdict(list)      # node -> [(stroke, vertex)]
    for si, st in enumerate(raw_strokes):
        P, N, VW, pinned = assemble(L, st, inc_of, grp)
        i0 = st[0][0]
        R = np.array([radius_for(L, st[k][0]) for k in VW])
        Q, vmap = fillet(P, pinned, R)
        S = Stroke()
        S.ways = st
        S.kind = int(L.kind[i0])
        S.cls = int(min(L.cls[i] for i, _ in st))
        S.group = int(grp[i0])
        S.oneway = bool(L.flags[i0] & F_ONEWAY)
        S.xy = Q
        S.s = cumlen(Q) + s_off[si]
        # source way per new vertex: from the vertex map
        vw = np.zeros(len(Q), np.int64)
        vw[vmap] = VW
        # a vertex between the images of original vertices i-1 and i lies on segment (i-1, i),
        # which belongs to the way of vertex i: label every vertex by the NEXT mapped vertex
        # (labelling by the previous one shifted way boundaries past filleted nodes and cut the
        # first segment off ways -> missing graph edges)
        mapped = np.zeros(len(Q), bool)
        mapped[vmap] = True
        nxt = np.where(mapped, np.arange(len(Q)), len(Q) - 1)
        idx = np.minimum.accumulate(nxt[::-1])[::-1]
        vw = vw[idx]
        S.vway = vw
        S.nodes = dict()
        for k, n in enumerate(N):
            S.nodes.setdefault(int(n), int(vmap[k]))
        S.node_s = {n: float(S.s[v]) for n, v in S.nodes.items()}
        S.attrs = None
        S.pinned_v = vmap[pinned]
        strokes.append(S)
        for k, (i, rev) in enumerate(st):
            way_stroke[i] = si
        for n, v in S.nodes.items():
            if inc_of.get(n, 0) >= 3 or v == 0 or v == len(Q) - 1:
                node_pos[n].append((si, v))
    memguard("fillet")

    # ---- merge events located on their strokes
    evs_by_stroke = defaultdict(list)
    ev_full = []
    for ev in events:
        bi = ev["branch"]
        bs = way_stroke[bi]
        n = ev["node"]
        mains = [(si, v) for si, v in node_pos.get(n, []) if si != bs and 0 < v < len(strokes[si].s) - 1]
        if not mains:
            continue
        si, v = mains[0]
        M = strokes[si]
        if not M.oneway or strokes[bs].group != 0:
            continue
        B = strokes[bs]
        bv = B.nodes.get(n)
        if bv is None:
            continue
        # recompute side on the smoothed geometry
        t = M.xy[min(v + 1, len(M.xy) - 1)] - M.xy[max(v - 1, 0)]
        sgn = 1 if ev["type"] == "diverge" else -1
        # a point on the branch ~30 m from the node
        bdir = 1 if bv == 0 else -1
        k = int(np.clip(np.searchsorted(B.s, B.s[bv] + bdir * 30.0), 0, len(B.s) - 1))
        q = B.xy[k] - M.xy[v]
        side = 1 if (t[0] * q[1] - t[1] * q[0]) > 0 else -1
        # does OSM model the aux lane (lane count change on the main at this node)?
        k_before = M.vway[max(v - 1, 0)]
        k_after = M.vway[min(v + 1, len(M.vway) - 1)]
        wa, wb = M.ways[k_before][0], M.ways[k_after][0]
        la, lb = int(nF[wa]), int(nF[wb])
        osm_aux = 0
        nbr = int(nF[B.ways[0][0]])
        if ev["type"] == "merge" and lb > la:
            osm_aux = lb - la
        if ev["type"] == "diverge" and la > lb:
            osm_aux = la - lb
        e2 = dict(ev, main=si, bstroke=bs, s=float(M.s[v]), bs=float(B.s[bv]), side=side, osm_aux=osm_aux, sgn=sgn)
        evs_by_stroke[si].append(e2)
        ev_full.append(e2)
    report["merge_events_located"] = len(ev_full)

    # ---- lateral profiles (roads)
    for si, S in enumerate(strokes):
        if S.kind == 0:
            lateral_profile(L, S, nF, nB, evs_by_stroke.get(si, []))
        else:
            n = len(S.s)
            hw = 1.8
            S.attrs = dict(eL=np.full(n, hw), eR=np.full(n, hw), pL=np.full(n, hw), pR=np.full(n, hw),
                           mk=np.zeros(n, np.int64), lw=np.full(n, 3.6))
    # event s may have moved (vertex insertion keeps s of original vertices) -> fine
    apply_merges(strokes, ev_full, report)
    building_fixes(L, strokes, halo, inc_of, report)
    twin_shoulders(L, strokes, report)
    memguard("lateral")

    # ---- vertical: densify (render spacing; structures get DENSE later), ground, flags
    for S in strokes:
        densify_stroke(S, 25.0)
        ws = [i for i, _ in S.ways]
        fl = np.array([int(L.flags[ws[k]]) for k in S.vway])
        S.vf = ((fl & F_BRIDGE) != 0) * V_BRIDGE | ((fl & F_TUNNEL) != 0) * V_TUNNEL
        S.vf = S.vf.astype(np.int64)
        default_struct = STRUCT["rail"] if S.kind == 1 else (STRUCT["footbridge"] if S.cls >= 7 else STRUCT["girder"])
        S.vf[(S.vf & V_BRIDGE) != 0] |= default_struct << V_STRUCT_SHIFT
    allxy = np.vstack([S.xy for S in strokes])
    allg = terr.sample(allxy[:, 0], allxy[:, 1]).astype(np.float64)
    o = 0
    for S in strokes:
        S.g = allg[o:o + len(S.s)]
        o += len(S.s)
    # ---- crossings
    X = find_crossings(L, strokes, way_stroke, report, np.nonzero(way_stroke >= 0)[0])
    ups = decide_levels(L, X, make_dsm_sampler(terr), report)
    geoms = {}

    def sloc(si, p):
        g = geoms.get(si)
        if g is None:
            g = geoms[si] = shapely.linestrings(strokes[si].xy)
        # stroke s starts at the arclength of the dropped ways (block sub-strokes): offset it
        return float(shapely.line_locate_point(g, shapely.points(p))) + float(strokes[si].s[0])

    keep = []
    for u in ups:
        # a line in a tunnel below needs no structure above it (cover is solved per tunnel);
        # two lines both in tunnels are not our business either
        if L.flags[u["up"]] & F_TUNNEL:
            continue
        if L.flags[u["lo"]] & F_TUNNEL:
            u["down"] = True     # an underpass: the tunnel is pushed below the upper line instead
        elif L.kind[u["up"]] == 1 and L.kind[u["lo"]] == 0 and (
                u["lo"] in L.underpass or np.isfinite(curated_rail_z(np.asarray(u["p"], np.float64).reshape(1, 2))[0])):
            # a street underpass below the rail (tagged as a short tunnel): the street dips under
            # the track, which keeps its level (and gets a bridge over the street)
            u["down"] = True
            u["open"] = True
        elif L.kind[u["up"]] == 1 and int(L.cls[u["up"]]) in (2, 3) and L.kind[u["lo"]] == 0:
            # subway / LRT over a road: the track keeps the rail graph's grade (the path the
            # trains run on, tpipe.rail_graph); the road dips under it. Lifting the track
            # instead raised one Yorkdale track 7 m over its at-grade station.
            u["down"] = True
        keep.append(u)
    report["crossings_over_tunnels_skipped"] = len(ups) - len(keep)
    ups = keep
    # a line that joins the other within 150 m of the crossing (a ramp meeting its deck, a
    # split carriageway) is not grade-separated from it there: OSM draws the join slightly off
    joined = []
    for u in ups:
        iu, il = int(way_stroke[u["up"]]), int(way_stroke[u["lo"]])
        if iu < 0 or il < 0:
            joined.append(u)
            continue
        U, Lo = strokes[iu], strokes[il]
        common = set(U.node_s) & set(Lo.node_s)
        near = False
        if common:
            su = sloc(iu, u["p"])
            for n in common:
                if abs(U.node_s[n] - su) < 150.0:
                    near = True
                    break
        if not near:
            joined.append(u)
    report["crossings_skipped_joined"] = len(ups) - len(joined)
    ups = joined
    for u in ups:
        u["iu"], u["il"] = int(way_stroke[u["up"]]), int(way_stroke[u["lo"]])
        u["su"] = sloc(u["iu"], u["p"])
        u["sl"] = sloc(u["il"], u["p"])
        # the upper line is a structure over the lower one (tags often stop short of it)
        U = strokes[u["iu"]]
        Lo = strokes[u["il"]]
        hl = float(np.interp(u["sl"], Lo.s, np.maximum(Lo.attrs["pL"], Lo.attrs["pR"]))) + 2.0
        # the structure extent along the upper line: lower line's half width / sin(crossing angle)
        k_ = int(np.clip(np.searchsorted(U.s, u["su"]), 1, len(U.s) - 1))
        tu = U.xy[k_] - U.xy[k_ - 1]
        k2 = int(np.clip(np.searchsorted(Lo.s, u["sl"]), 1, len(Lo.s) - 1))
        tl = Lo.xy[k2] - Lo.xy[k2 - 1]
        sn = abs(tu[0] * tl[1] - tu[1] * tl[0]) / max(np.hypot(*tu) * np.hypot(*tl), 1e-9)
        hl = min(hl / max(sn, 0.3), 60.0)
        u["hl"] = hl
        insert_stations(U, [u["su"] - hl, u["su"] + hl])
        m = np.abs(U.s - u["su"]) <= hl + 1e-6
        if u.get("down") and not u.get("open"):
            continue
        # always a structure over the whole width of the lower line (OSM bridge ways often stop short)
        st = STRUCT["rail"] if U.kind == 1 else STRUCT["footbridge"] if U.cls >= 7 else STRUCT["girder"]
        U.vf[m] |= V_BRIDGE | (st << V_STRUCT_SHIFT) * ((U.vf[m] >> V_STRUCT_SHIFT) == 0)
    report["structures_inferred"] = sum(1 for u in ups if u["how"] != "tags")
    curated = curated_targets(load_curated(), strokes, L, terr, report)

    # a subway / LRT line under a road where the rail graph (the path the trains run on) is
    # at grade -- a covered way, e.g. Lawrence West under Lawrence Ave -- keeps its grade:
    # the road is lifted over it instead of the track diving 8 m
    rg_tree, rg_pts = _rail_graph_points()
    for u in ups:
        if rg_tree is None or not u.get("down") or L.kind[u["lo"]] != 1 or int(L.cls[u["lo"]]) not in (2, 3):
            continue
        Lo = strokes[u["il"]]
        k_ = int(np.argmin(np.abs(Lo.s - u["sl"])))
        d_, i_ = rg_tree.query(Lo.xy[k_], distance_upper_bound=2.0)
        if np.isfinite(d_) and Lo.g[k_] - rg_pts[i_, 2] < 3.0:
            u["down"] = False
    rail_graph_targets(strokes, L, curated, report)

    # ---- iterate: crossing requirements -> profiles -> node consistency
    need = set(i for i, S in enumerate(strokes) if (S.vf & (V_BRIDGE | V_TUNNEL)).any())
    need |= set(curated.keys())
    for u in ups:
        need.add(u["il"] if u.get("down") else u["iu"])
    for S in strokes:
        S.z = S.g.copy()
        S.pins = {}

    def requirements():
        for S in strokes:
            S.req_lo = []
            S.req_hi = []
        for u in ups:
            U, Lo = strokes[u["iu"]], strokes[u["il"]]
            zl = float(np.interp(u["sl"], Lo.s, Lo.z))
            ku, kl = _kind_name(L, u["up"]), _kind_name(L, u["lo"])
            clr = CLEAR["rail"] if kl == "rail" else CLEAR["path"] if kl == "path" else (
                CLEAR["ped_over_road"] if ku == "path" else CLEAR["road_under_rail"] if ku == "rail" else CLEAR["road"])
            deck = DECK["rail"] if ku == "rail" else DECK["path"] if ku == "path" else (
                DECK["motorway"] if L.cls[u["up"]] <= 1 else DECK["road"])
            if u.get("down"):
                zu = float(np.interp(u["su"], U.s, U.z))
                Lo.req_hi.append((u["sl"], zu - clr - deck, 6.0))
            else:
                U.req_lo.append((u["su"], zl + clr + deck, max(u["hl"] - 1.0, 3.0)))

    def solve(ids):
        for si in sorted(ids):
            S = strokes[si]
            if not getattr(S, "dense", False):
                _densify_solve(S, terr, curated, si)
            solve_profile(S, L, curated.get(si))

    # 1. every structured stroke on its own constraints (twice: lower lines settle first)
    for it in range(2):
        requirements()
        solve(need)
    # 2. node consistency without ratcheting: at every node the most constrained stroke (largest
    #    departure from the ground; rail at level crossings) sets the elevation and the others
    #    follow it. Pins are recomputed from scratch each round (never accumulated) and only
    #    two rounds propagate, so a raised approach can lift the streets meeting it but a
    #    chain of streets can never lift itself.
    own_dev = {si: None for si in range(len(strokes))}
    for rnd in range(2):
        new_pins = defaultdict(dict)
        for n, lst in node_pos.items():
            if len(lst) < 2:
                continue
            zs = []
            for si, _v in lst:
                S = strokes[si]
                k = min(int(np.searchsorted(S.s, S.node_s[n] - 1e-6)), len(S.s) - 1)
                zs.append((si, k, float(S.z[k]), float(S.z[k] - S.g[k])))
            paths = [x for x in zs if strokes[x[0]].kind == 0 and strokes[x[0]].cls >= 7]
            zs = paths if len(paths) >= 2 and len(paths) == len(zs) else [x for x in zs if x not in paths]
            if len(zs) < 2:
                continue
            rails = [x for x in zs if strokes[x[0]].kind == 1]
            if rails and len(rails) < len(zs):
                src = max(rails, key=lambda x: abs(x[3]))
                targets = [x for x in zs if strokes[x[0]].kind == 0]
            else:
                src = max(zs, key=lambda x: abs(x[3]))
                targets = [x for x in zs if x is not src]
            if abs(src[3]) < 0.3 and max(abs(x[2] - src[2]) for x in targets) < 0.3:
                continue
            for si, k, z, d in targets:
                T = strokes[si]
                # never drag a surface street into a tunnel's depth (portal nodes, bad tags)
                if src[2] < T.g[k] - 1.0 and not (T.vf[k] & V_TUNNEL):
                    continue
                if abs(z - src[2]) > 0.05:
                    new_pins[si][k] = src[2]
        changed = 0
        touched = set(new_pins) | set(si for si, S in enumerate(strokes) if S.pins)
        for si in touched:
            # node pins win over the corridor bed only at the node itself
            strokes[si].pins = {**strokes[si].cpins, **new_pins.get(si, {})}
            changed += len(strokes[si].pins)
        if not touched:
            break
        need |= touched
        # requirements stay as computed from the unpinned solution: pins must not feed back
        # into clearances (a ramp pinned to its deck would otherwise lift the deck, and so on)
        solve(touched)
        memguard("solve")
    # 2b. track ends that touch another track without a shared node (sidings and switches whose OSM
    #     ways stop on, not at, the other track) take its level: a train must not step metres at a
    #     switch. The flatter of the two follows the more constrained one.
    rail_ids = [si for si, S in enumerate(strokes) if S.kind == 1 and len(S.s) >= 2 and not (S.vf & V_TUNNEL).all()]
    if len(rail_ids) > 1:
        allp = np.vstack([strokes[si].xy for si in rail_ids])
        own = np.concatenate([np.full(len(strokes[si].xy), si) for si in rail_ids])
        vix = np.concatenate([np.arange(len(strokes[si].xy)) for si in rail_ids])
        rtree = cKDTree(allp)
        extra = defaultdict(dict)
        for si in rail_ids:
            S = strokes[si]
            for v in (0, len(S.s) - 1):
                if S.vf[v] & V_TUNNEL:
                    continue
                best = None
                for j in rtree.query_ball_point(S.xy[v], 1.0):
                    if own[j] == si:
                        continue
                    T = strokes[own[j]]
                    dz = float(T.z[vix[j]] - S.z[v])
                    if abs(dz) > 0.3 and (best is None or abs(dz) < abs(best[2])):
                        best = (own[j], vix[j], dz)
                if best is None:
                    continue
                tj, tv, dz = best
                T = strokes[tj]
                if abs(T.z[tv] - T.g[tv]) >= abs(S.z[v] - S.g[v]):
                    extra[si][v] = float(T.z[tv])
                else:
                    extra[tj][tv] = float(S.z[v])
        for si, pins in extra.items():
            strokes[si].pins = {**strokes[si].pins, **pins}
        if extra:
            solve(set(extra))
        report["rail_touch_pins"] = sum(len(v) for v in extra.values())
    # 2c. track corridors: parallel tracks (yards, multi-track main lines) share one bed level --
    #     a smooth height field per corridor cluster, level across the tracks, varying along the
    #     corridor; flyovers / dives (bridge / tunnel runs and their approach ramps) keep their own
    fixed = corridor_fields(strokes, report)
    if fixed:
        solve(fixed)
        # streets at level crossings (shared nodes) follow the corridor's new level
        xpins = defaultdict(dict)
        for n, lst in node_pos.items():
            rs = [(si, v) for si, v in lst if strokes[si].kind == 1 and si in fixed]
            if not rs:
                continue
            si_r, _ = rs[0]
            R_ = strokes[si_r]
            zr = float(R_.z[min(int(np.searchsorted(R_.s, R_.node_s[n] - 1e-6)), len(R_.s) - 1)])
            for si, _v in lst:
                T = strokes[si]
                if T.kind == 0:
                    k = min(int(np.searchsorted(T.s, T.node_s[n] - 1e-6)), len(T.s) - 1)
                    if abs(T.z[k] - zr) > 0.05:
                        xpins[si][k] = zr
        for si, p_ in xpins.items():
            strokes[si].pins = {**strokes[si].pins, **p_}
        if xpins:
            solve(set(xpins))
        report["level_crossing_repins"] = sum(len(v) for v in xpins.values())
    # 3. one last clearance pass against the final lower lines (a street lifted by a pin at a
    #    junction next to an underpass must not end up under the rail deck), no more pins after
    requirements()
    solve(set(u["il"] if u.get("down") else u["iu"] for u in ups))

    # short elevated gaps between two decks (an inferred structure next to a tagged bridge that
    # stops short, two bridge ways with a few metres of untagged way between) are one deck: a
    # 10 m stub of track / road floating between two abutments reads as a hole
    filled = 0
    for S in strokes:
        br = (S.vf & V_BRIDGE) != 0
        if not br.any() or br.all():
            continue
        for a_, b_ in list(_runs(~br & ((S.vf & V_TUNNEL) == 0))):
            if a_ == 0 or b_ == len(br) - 1:
                continue
            if S.s[b_ + 1] - S.s[a_ - 1] > 30.0 or (S.z[a_:b_ + 1] - S.g[a_:b_ + 1]).min() < 1.5:
                continue
            S.vf[a_:b_ + 1] = (S.vf[a_:b_ + 1] & 0x0F) | V_BRIDGE | (S.vf[a_ - 1] & ~0x0F)
            filled += 1
    report["deck_gaps_filled"] = filled
    # streets dipped under a rail line (open underpasses): drawn at their solved z, not draped
    dipped = 0
    for S in strokes:
        if S.kind != 0 or S.z is None:
            continue
        m = (S.z < S.g - 0.5) & ((S.vf & (V_BRIDGE | V_TUNNEL)) == 0) & ((S.vf >> V_STRUCT_SHIFT) == 0)
        if m.any():
            S.vf[m] = (S.vf[m] & 0x0F) | (STRUCT["exact"] << V_STRUCT_SHIFT)
            dipped += int(m.sum())
    report["street_vertices_dipped"] = dipped
    for S in strokes:
        if S.kind == 0 and S.cls >= 7 and S.attrs is not None:
            m = (S.vf & V_BRIDGE) != 0
            for k in ("eL", "eR", "pL", "pR"):
                S.attrs[k][m] = np.maximum(S.attrs[k][m], 1.4)
        dz = np.abs(S.z - S.g)
        S.vf[dz > 0.15] |= V_GRADED
        S.vf[(S.vf & (V_BRIDGE | V_TUNNEL)) != 0] |= V_GRADED
    return strokes, report, ups, ev_full, curated



# ------------------------------------------------------------------ sidewalks, boulevards, pavers

SW_L, SW_R, BLVD_L, BLVD_R, PAVERS, MEDIAN_L = 1, 2, 4, 8, 16, 32
SIDE_TAG = {2: SW_L, 3: SW_R, 4: SW_L | SW_R}


def building_density():
    """KD-tree over building footprints (first vertex) + kind flags: house-like / commercial."""
    with np.load(geo.WORK / "osm_buildings.npz", allow_pickle=True) as f:
        xy, ringlen, nring, kind = f["xy"], f["ringlen"], f["nring"], f["kind"]
    ro = np.concatenate([[0], np.cumsum(ringlen.astype(np.int64))])
    po = np.concatenate([[0], np.cumsum(nring.astype(np.int64))])
    # every 3rd footprint vertex, with its building: big downtown towers have few buildings but
    # many vertices along the street, so "buildings near" counts owners of nearby vertices
    nv = np.diff(ro)
    ring_b = np.repeat(np.arange(len(po) - 1), np.diff(po))
    owner = np.repeat(ring_b, nv)[::3]
    pts = xy[::3]
    house = np.isin(kind, [1, 11])            # houses, garages / sheds
    comm = np.isin(kind, [3, 4, 13])           # office / retail / hotel
    # outer rings (float32 world coords) for per-block footprint polygons (building_fixes)
    r0 = ro[po[:-1]]
    rl = (ro[po[:-1] + 1] - r0).astype(np.int32)
    global BLDG
    BLDG = dict(xy=xy.astype(np.float32), r0=r0, rl=rl, fx=xy[r0, 0].astype(np.float32), fy=xy[r0, 1].astype(np.float32))
    return cKDTree(pts), house, comm, owner, pts


BLDG = None


WALK_MAX = 12.0


TWIN_GAP = 0.6       # median barrier space between the inner pavement edges of twin carriageways


def twin_shoulders(L: Lines, strokes: list[Stroke], report):
    """Divided roads mapped as two one-way centrelines (DVP, Gardiner, arterials): where the
    two pavements would overlap (full inner shoulders on centrelines 12 m apart), the inner
    shoulders narrow so the carriageways meet at a median barrier instead of drawing one
    carriageway's edge line / parapet / barrier inside the other's lanes. Lanes are kept
    (shoulders go down to 0.4 m); the change is ramped at 1:30 along the road."""
    cand = [si for si, S in enumerate(strokes) if S.kind == 0 and S.group == 0 and S.oneway and S.cls <= 5
            and S.attrs is not None]
    by_name = defaultdict(list)
    for si in cand:
        nm = str(L.name[strokes[si].ways[0][0]])
        if nm:
            by_name[nm].append(si)
    pl0 = {si: strokes[si].attrs["pL"].copy() for lst in by_name.values() if len(lst) >= 2 for si in lst}
    n_v = 0
    for nm, lst in by_name.items():
        if len(lst) < 2:
            continue
        pts = np.vstack([strokes[si].xy for si in lst])
        owner = np.concatenate([np.full(len(strokes[si].xy), si) for si in lst])
        vidx = np.concatenate([np.arange(len(strokes[si].xy)) for si in lst])
        tree = cKDTree(pts)
        for si in lst:
            A = strokes[si]
            n = len(A.s)
            if n < 2:
                continue
            lay = np.array([int(L.layer[A.ways[k][0]]) for k in A.vway])
            T = np.gradient(A.xy, axis=0)
            T /= np.maximum(np.hypot(T[:, 0], T[:, 1]), 1e-9)[:, None]
            N = np.stack([-T[:, 1], T[:, 0]], 1)
            eL, pL = A.attrs["eL"], pl0[si]
            cut = np.zeros(n)
            near = tree.query_ball_point(A.xy, 40.0)
            for k in range(n):
                best = None
                for j in near[k]:
                    bj = owner[j]
                    if bj == si:
                        continue
                    B = strokes[bj]
                    v = vidx[j]
                    for a_ in (v - 1, v):
                        if a_ < 0 or a_ + 1 >= len(B.s):
                            continue
                        P0, P1 = B.xy[a_], B.xy[a_ + 1]
                        d = P1 - P0
                        ll = float(d @ d)
                        if ll < 1e-9:
                            continue
                        if float(d @ T[k]) > -0.85 * math.sqrt(ll):
                            continue                  # not the opposite direction
                        t = float(np.clip((A.xy[k] - P0) @ d / ll, 0, 1))
                        q = P0 + d * t
                        lat = float((q - A.xy[k]) @ N[k])
                        along = abs(float((q - A.xy[k]) @ T[k]))
                        if lat <= 0.5 or along > 3.0 or int(L.layer[B.ways[B.vway[a_]][0]]) != lay[k]:
                            continue
                        pb = pl0[bj][a_] + t * (pl0[bj][a_ + 1] - pl0[bj][a_])
                        eb = B.attrs["eL"][a_] + t * (B.attrs["eL"][a_ + 1] - B.attrs["eL"][a_])
                        if best is None or lat < best[0]:
                            best = (lat, pb, eb)
                if best is None:
                    continue
                lat, pb, eb = best
                over = pL[k] + pb - (lat - TWIN_GAP)
                if over <= 0.05:
                    continue
                sa, sb = max(pL[k] - eL[k], 0.0), max(pb - eb, 0.0)
                if sa + sb < 1e-6:
                    continue
                cut[k] = min(over * sa / (sa + sb), max(0.0, sa - 0.4))
            if not (cut > 0).any():
                continue
            s = A.s
            for k in range(1, n):          # ramp 1:30 both ways
                cut[k] = max(cut[k], cut[k - 1] - (s[k] - s[k - 1]) / 30.0)
            for k in range(n - 2, -1, -1):
                cut[k] = max(cut[k], cut[k + 1] - (s[k + 1] - s[k]) / 30.0)
            cut = np.minimum(cut, np.maximum(pL - eL - 0.4, 0.0))
            A.attrs["pL"] = pL - cut
            n_v += int((cut > 0.05).sum())
    report["twin_shoulders_narrowed"] = n_v


def building_fixes(L: Lines, strokes: list[Stroke], halo, inc_of, report):
    """Streets vs building footprints (block-local polygons):
    - dead-end stubs that run into a building stop at its wall (OSM draws the way into the
      entrance / garage: University Ave's stub into Union, lane ends at loading docks);
    - local streets, lanes and service roads never pave over a footprint: the pavement half
      width on a side shrinks to the wall (a 5.5 m alley drawn against a facade)."""
    if BLDG is None:
        return
    x0, y0, x1, y1 = halo
    B = BLDG
    sel = np.nonzero((B["fx"] > x0) & (B["fx"] < x1) & (B["fy"] > y0) & (B["fy"] < y1))[0]
    if not len(sel):
        return
    lens = B["rl"][sel].astype(np.int64)
    vi = np.repeat(B["r0"][sel] - np.concatenate([[0], np.cumsum(lens)[:-1]]), lens) + np.arange(lens.sum())
    polys = shapely.polygons(shapely.linearrings(B["xy"][vi].astype(np.float64), indices=np.repeat(np.arange(len(sel)), lens)))
    polys = polys[shapely.is_valid(polys)]
    if not len(polys):
        return
    tree = shapely.STRtree(polys)
    trimmed = 0
    narrowed = 0
    # ends where no other drivable way continues (footways / hidden paths don't count)
    drv = (L.kind == 0) & (L.cls <= 7) & ((L.flags & F_DUP) == 0)
    dn = L.nid[np.repeat(drv, np.diff(L.off))]
    du, dc = np.unique(dn, return_counts=True)
    dinc = dict(zip(du.tolist(), dc.tolist()))
    for S in strokes:
        if S.kind != 0 or S.group not in (0, 2) or S.attrs is None or len(S.s) < 2:
            continue
        # -- dead-end stubs into buildings
        for end in (0, 1):
            n = S.ways[0][0] if end == 0 else S.ways[-1][0]
            nid = int(L.nids(n)[0] if (end == 0) != S.ways[0 if end == 0 else -1][1] else L.nids(n)[-1])
            if dinc.get(nid, 0) != 1:
                continue        # the end is a junction or continues: leave it
            k_end = 0 if end == 0 else len(S.s) - 1
            # an overshoot a few metres past the last junction (University Ave past Front): end
            # the street at the junction
            if S.cls <= 5:
                jn = [(abs(sv - S.s[k_end]), sv) for n2, sv in S.node_s.items() if dinc.get(n2, 0) >= 3]
                if jn:
                    dd_, sj = min(jn)
                    if 0.5 < dd_ < 12.0:
                        kj = int(np.argmin(np.abs(S.s - sj)))
                        keep = np.arange(0, kj + 1) if end == 1 else np.arange(kj, len(S.s))
                        if len(keep) >= 2:
                            _subset(S, keep)
                            trimmed += 1
                            continue
            pe = shapely.Point(S.xy[k_end])
            hit = tree.query(pe, predicate="within")
            if not len(hit):
                continue
            wall = polys[hit[0]]
            # walk back until outside; cut on the wall
            ks = range(len(S.s)) if end == 0 else range(len(S.s) - 1, -1, -1)
            kout = None
            for k in ks:
                if not wall.contains(shapely.Point(S.xy[k])):
                    kout = k
                    break
            if kout is None or abs(S.s[kout] - S.s[k_end]) > 40:
                continue
            seg = shapely.LineString([S.xy[kout], S.xy[k_end]])
            cut = seg.intersection(wall.boundary)
            cp = shapely.get_coordinates(cut)
            if not len(cp):
                continue
            q = cp[np.argmin(np.hypot(*(cp - S.xy[kout]).T))]
            # replace the inside vertices by one vertex on the wall (0.5 m back)
            d = q - S.xy[kout]
            dl = math.hypot(*d)
            q = S.xy[kout] + d * max(0.0, (dl - 0.5)) / max(dl, 1e-9)
            if end == 1:
                keep = np.arange(0, kout + 2)
            else:
                keep = np.arange(kout - 1, len(S.s))
            keep = keep[(keep >= 0) & (keep < len(S.s))]
            _subset(S, keep)
            S.xy[-1 if end == 1 else 0] = q
            trimmed += 1
        # -- pavement over footprints (local streets / service / lanes)
        if S.cls < 5:
            continue
        # segments whose pavement touches a footprint get vertices every 4 m (widths are per vertex)
        P = S.xy
        d_ = np.diff(P, axis=0)
        ln_ = np.hypot(*d_.T)
        okk = ln_ > 0.3
        if not okk.any():
            continue
        n_ = np.zeros_like(d_)
        n_[okk] = np.stack([-d_[okk, 1], d_[okk, 0]], 1) / ln_[okk, None]
        wmax = np.maximum(np.maximum(S.attrs["pL"][:-1], S.attrs["pL"][1:]), np.maximum(S.attrs["pR"][:-1], S.attrs["pR"][1:]))
        quads = shapely.polygons(np.stack([P[:-1] + n_ * wmax[:, None], P[1:] + n_ * wmax[:, None],
                                           P[1:] - n_ * wmax[:, None], P[:-1] - n_ * wmax[:, None]], 1))
        qa, _qb = tree.query(quads, predicate="intersects")
        qa = np.unique(qa[okk[qa]])
        if not len(qa):
            continue
        st = np.concatenate([S.s[k] + np.arange(4.0, max(ln_[k] - 1.0, 4.0), 4.0) for k in qa if ln_[k] > 5.0] or [np.zeros(0)])
        if len(st):
            insert_stations(S, st)
        P = S.xy
        t = np.gradient(P, axis=0)
        tl = np.maximum(np.hypot(*t.T), 1e-9)
        nl = np.stack([-t[:, 1] / tl, t[:, 0] / tl], 1)
        for key, sgn in (("pL", 1.0), ("pR", -1.0)):
            ends = P + nl * (sgn * S.attrs[key])[:, None]
            segs = shapely.linestrings(np.stack([P, ends], 1))
            a_, b_ = tree.query(segs, predicate="intersects")
            if not len(a_):
                continue
            inter = shapely.intersection(segs[a_], polys[b_])
            for q_, g_ in zip(a_, inter):
                c_ = shapely.get_coordinates(g_)
                if not len(c_):
                    continue
                dmin = float(np.min(np.hypot(*(c_ - P[q_]).T)))
                if polys[b_[list(a_).index(q_)]].contains(shapely.Point(P[q_])):
                    continue      # the centreline is inside the building: a passage, leave it
                other = "pR" if key == "pL" else "pL"
                # hugging the facade: pave away from the wall (keep a 2.8 m lane overall)
                new = max(0.3 if S.attrs[other][q_] >= 2.5 else 1.4, dmin - 0.3)
                if new < S.attrs[key][q_]:
                    ek = "eL" if key == "pL" else "eR"
                    S.attrs[key][q_] = new
                    S.attrs[ek][q_] = min(S.attrs[ek][q_], new)
                    narrowed += 1
    report["stubs_trimmed_at_buildings"] = trimmed
    report["pavement_vertices_narrowed_at_buildings"] = narrowed


def _subset(S: Stroke, keep):
    """Keep only vertices `keep` (sorted) of a stroke."""
    S.xy = S.xy[keep].copy()
    S.s = S.s[keep]
    S.vway = S.vway[keep]
    if S.attrs is not None:
        S.attrs = {k: v[keep] for k, v in S.attrs.items()}
    for key in ("vf", "sw", "g", "z"):
        v = getattr(S, key)
        if v is not None and len(v) >= len(keep):
            setattr(S, key, v[keep])


def _walk_to_buildings(S: Stroke, idx, tree, bpts, bits):
    """Per-vertex sidewalk width left / right reaching the facades (S.ws), for paved downtown
    streets: the lateral distance from the pavement edge to the nearest building vertex beside
    the vertex (within 3 m along), clamped to [2.4, WALK_MAX]."""
    if S.ws is None:
        S.ws = np.zeros((len(S.s), 2), np.float32)
    for k in idx:
        p = S.xy[k]
        t = S.xy[min(k + 1, len(S.s) - 1)] - S.xy[max(k - 1, 0)]
        tl = math.hypot(*t)
        if tl < 1e-6:
            continue
        t = t / tl
        nl = np.array([-t[1], t[0]])
        q = tree.query_ball_point(p, S.attrs["pL"][k] + WALK_MAX + 2)
        if not q:
            continue
        d = bpts[q] - p
        along = d @ t
        lat = d @ nl
        ok = np.abs(along) < 3.0
        for col, sgn, key, bit in ((0, 1, "pL", SW_L), (1, -1, "pR", SW_R)):
            if not bits & bit:
                continue
            v = sgn * lat[ok] - S.attrs[key][k]
            v = v[v > 0.8]
            if len(v):
                S.ws[k, col] = float(np.clip(v.min() - 0.1, 2.4, WALK_MAX))


def sidewalks(L: Lines, strokes: list[Stroke], report, bd=None):
    """Per-vertex sidewalk bits for streets (classes 2-5, not links / tunnels):
    OSM sidewalk tags, else both sides where the street is built up. Bridges keep
    their sidewalks (a deck sidewalk behind the parapet)."""
    tree, house, comm, owner, bpts = bd if bd is not None else building_density()
    cnt = defaultdict(int)
    # divided roads: a one-way carriageway with its same-name twin (opposite direction) on its
    # left has a median there, not a sidewalk
    twins = defaultdict(list)
    for si, S in enumerate(strokes):
        if S.kind == 0 and S.group == 0 and S.oneway and 1 <= S.cls <= 5:
            twins[str(L.name[S.ways[0][0]])].append(si)
    tw_tree = {}
    for nm, lst in twins.items():
        if nm and len(lst) >= 2:
            P = np.vstack([strokes[k].xy for k in lst])
            T = np.vstack([np.gradient(strokes[k].xy, axis=0) for k in lst])
            O = np.concatenate([np.full(len(strokes[k].xy), k) for k in lst])
            tw_tree[nm] = (cKDTree(P), T, O, P)

    def median_left(S, idxs):
        nm = str(L.name[S.ways[0][0]])
        if nm not in tw_tree:
            return False
        tr, T, O, P = tw_tree[nm]
        hits = 0
        for k in idxs:
            p = S.xy[k]
            t = S.xy[min(k + 1, len(S.xy) - 1)] - S.xy[max(k - 1, 0)]
            tl = math.hypot(*t) or 1
            nl = np.array([-t[1], t[0]]) / tl
            for q in tr.query_ball_point(p, 45.0):
                if strokes[O[q]] is S:
                    continue
                if np.dot(T[q], t) < 0 and np.dot(P[q] - p, nl) > 0:
                    hits += 1
                    break
        return hits * 2 >= len(idxs)

    for S in strokes:
        S.sw = np.zeros(len(S.s), np.int64)
        if S.kind != 0 or S.group != 0:
            continue
        ws = [i for i, _ in S.ways]
        mid = [(k, i) for k, i in enumerate(ws) if 2 <= L.cls[i] <= 5 and not L.flags[i] & (F_LINK | F_TUNNEL)]
        if not mid:
            continue
        for k, i in mid:
            m = S.vway == k
            if not m.any():
                continue
            pts = S.xy[m]
            probe = pts[[0, len(pts) // 2, -1]]
            near = tree.query_ball_point(probe, 60.0)
            nb_ = [np.unique(owner[np.asarray(x, np.int64)]) if len(x) else np.zeros(0, np.int64) for x in near]
            dens = np.array([len(x) for x in nb_])
            built = (dens >= 3).sum() >= 2
            allb = np.unique(np.concatenate(nb_)) if dens.sum() else np.zeros(0, np.int64)
            fh = house[allb].mean() if len(allb) else 0.0
            fc = comm[allb].mean() if len(allb) else 0.0
            side = int(L.side[i])
            rev = S.ways[k][1]
            bits = 0
            if side in SIDE_TAG:
                bits = SIDE_TAG[side]
                if rev and side in (2, 3):
                    bits = SW_L if bits == SW_R else SW_R
            elif side == 5 or (side == 0 and built):
                # sidewalk=separate: the sidewalks exist (mapped as footways, which are hidden)
                bits = SW_L | SW_R
                vi_ = np.nonzero(m)[0]
                if S.oneway and median_left(S, [vi_[0], vi_[len(vi_) // 2], vi_[-1]]):
                    bits = SW_R | MEDIAN_L
            if bits:
                if fc >= 0.3 and L.cls[i] <= 4:
                    bits |= PAVERS
                    # commercial main street: hard surface out to the building line
                    _walk_to_buildings(S, np.nonzero(m)[0], tree, bpts, bits)
                elif fh >= 0.5 and L.cls[i] >= 3:
                    # suburban street: grass boulevard between curb and walk
                    bits |= (BLVD_L if bits & SW_L else 0) | (BLVD_R if bits & SW_R else 0)
                cnt["streets"] += 1
            S.sw[m] = bits
        # merge / diverge stretches (arterial interchange ramps): the sidewalk on the ramp side stops
        # 15 m before the gore and resumes after the speed-change lane -- it never lies between the
        # carriageway and a ramp glued beside it (the outer edge of the combined section has none)
        for a_, b_, side in (S.ev or []):
            m = (S.s >= a_ - 15.0) & (S.s <= b_ + 15.0)
            bit = SW_L if side > 0 else SW_R
            if (S.sw[m] & bit).any():
                cnt["merge_sidewalk_cut"] += 1
            S.sw[m] &= ~(bit | (BLVD_L if side > 0 else BLVD_R))
    # no sidewalk band on top of (or squeezed against) another carriageway running alongside at the
    # same level: a twin carriageway across a narrow median, a frontage road, a glued ramp. The
    # walk band (1.8 m + curb) needs pavement edge + 2.3 m clear of any other drivable pavement.
    drv = [S for S in strokes if S.kind == 0 and S.group == 0 and S.cls <= 6 and S.attrs is not None]
    if drv:
        DP = np.vstack([S.xy for S in drv])
        DT = np.vstack([np.gradient(S.xy, axis=0) if len(S.xy) > 1 else np.zeros((1, 2)) for S in drv])
        DT /= np.maximum(np.hypot(DT[:, 0], DT[:, 1]), 1e-9)[:, None]
        DH = np.concatenate([np.maximum(S.attrs["pL"], S.attrs["pR"]) for S in drv])
        DO = np.concatenate([np.full(len(S.xy), k) for k, S in enumerate(drv)])
        DZ = np.concatenate([(S.z if S.z is not None else S.g if S.g is not None else np.zeros(len(S.xy))) for S in drv])
        dtree = cKDTree(DP)
        for k_, S in enumerate(drv):
            if S.sw is None or not (S.sw & (SW_L | SW_R)).any() or len(S.xy) < 2:
                continue
            T = np.gradient(S.xy, axis=0)
            T /= np.maximum(np.hypot(T[:, 0], T[:, 1]), 1e-9)[:, None]
            for v in np.nonzero(S.sw & (SW_L | SW_R))[0]:
                for side, bit, e in ((1, SW_L, S.attrs["pL"][v]), (-1, SW_R, S.attrs["pR"][v])):
                    if not S.sw[v] & bit:
                        continue
                    nrm = side * np.array([-T[v, 1], T[v, 0]])
                    q = S.xy[v] + nrm * (e + 1.75)
                    for j in dtree.query_ball_point(q, 20.0):
                        zv = S.z[v] if S.z is not None else DZ[j]
                        if DO[j] == k_ or abs(DT[j] @ T[v]) < 0.9 or abs(DZ[j] - zv) > 2.0:
                            continue
                        lat = float((DP[j] - S.xy[v]) @ nrm)
                        if lat > 0 and lat - DH[j] < e + 2.3 and abs(float((DP[j] - S.xy[v]) @ T[v])) < 12.0:
                            S.sw[v] &= ~(bit | (BLVD_L if side > 0 else BLVD_R))
                            cnt["sidewalk_cut_alongside"] += 1
                            break
    report["sidewalk_streets"] = dict(cnt)


# ------------------------------------------------------------------ junction clusters


CLUSTER_D = 32.0     # junction nodes joined by a road piece shorter than this form one intersection


def junction_clusters(L: Lines, strokes: list[Stroke], inc_of, report, nodes=None):
    """Logical intersections: at-grade junction nodes of streets (>= 3 arms, classes <= 6,
    at least two non-link street arms), clustered across dual carriageways / median
    right-of-ways. Per member node the arm radii put every approach's crosswalk and
    stop bar on one line across the whole cross-section."""
    if nodes is None:
        with np.load(geo.WORK / "osm_nodes.npz") as f:
            nodes = {k: f[k] for k in ("kind", "xy", "id")}
    nk, nxy, nnid = nodes["kind"], nodes["xy"], nodes["id"]
    sig_ids = set(nnid[nk == 0].tolist())
    sig_tree = cKDTree(nxy[nk == 0]) if (nk == 0).any() else None
    stop_xy = nxy[nk == 1]
    stop_tree = cKDTree(stop_xy) if len(stop_xy) else None
    # arms per node from strokes: (stroke, vertex, direction +1 / -1)
    arms = defaultdict(list)
    for si, S in enumerate(strokes):
        if S.kind != 0 or S.group != 0:
            continue
        for n, sv in S.node_s.items():
            if inc_of.get(n, 0) < 3:
                continue
            k = min(int(np.searchsorted(S.s, sv - 1e-6)), len(S.s) - 1)
            if S.vf[k] & V_TUNNEL:
                continue
            for d in (-1, 1):
                j = k + d
                # skip zero-length duplicates
                while 0 <= j < len(S.s) and abs(S.s[j] - S.s[k]) < 0.01:
                    j += d
                if 0 <= j < len(S.s):
                    arms[n].append((si, k, d))
    J = {}
    for n, A in arms.items():
        if len(A) < 3:
            continue
        cl = [strokes[si].cls for si, _, _ in A]
        if min(cl) > 6:
            continue
        street = sum(1 for si, k, d in A if 2 <= strokes[si].cls <= 6 and not
                     (L.flags[strokes[si].ways[strokes[si].vway[k]][0]] & F_LINK))
        if street < 2:
            continue
        J[n] = A
    # cluster by short connecting pieces
    parent = {n: n for n in J}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    pos = {}
    for n, A in J.items():
        si, k, _ = A[0]
        pos[n] = strokes[si].xy[k]
    for si, S in enumerate(strokes):
        if S.kind != 0 or S.group != 0:
            continue
        mem = sorted((sv, n) for n, sv in S.node_s.items() if n in J)
        for (s0, a), (s1, b) in zip(mem, mem[1:]):
            if s1 - s0 < CLUSTER_D:
                ra, rb = find(a), find(b)
                if ra != rb:
                    parent[ra] = rb
    groups = defaultdict(list)
    for n in J:
        groups[find(n)].append(n)
    out = []
    for root, mem in groups.items():
        P = np.array([pos[n] for n in mem])
        c = P.mean(0)
        memset = set(mem)
        sig = any(n in sig_ids for n in mem) or (sig_tree is not None and len(sig_tree.query_ball_point(c, 20.0)) > 0)
        # arms leaving the cluster
        legs = []
        internal = []
        for n in mem:
            for si, k, d in J[n]:
                S = strokes[si]
                # walk to the next node on this stroke: internal if it is a member within CLUSTER_D
                other = None
                for m2, sv in S.node_s.items():
                    # (any member further along this stroke, not only the adjacent one: a cluster chained
                    # over several short pieces would otherwise mark a crosswalk ladder at each end
                    # member's leg line -- two ladders on one line, the doubled crosswalks)
                    if m2 in memset and m2 != n and 0 < d * (sv - S.s[k]) < 150.0:
                        if other is None or abs(sv - S.s[k]) < abs(S.node_s[other] - S.s[k]):
                            other = m2
                j = k + d
                while 0 <= j < len(S.s) and abs(S.s[j] - S.s[k]) < 3.0:
                    j += d
                j = min(max(j, 0), len(S.s) - 1)
                # heading over ~15 m
                t = int(np.clip(np.searchsorted(S.s, S.s[k] + d * 15.0), 0, len(S.s) - 1))
                v = S.xy[t] - S.xy[k]
                ang = math.atan2(v[1], v[0])
                # half width of the pavement on each side as seen leaving the node
                pl, pr = S.attrs["pL"][k], S.attrs["pR"][k]
                hw = max(pl, pr) if d > 0 else max(pl, pr)
                wi = S.ways[S.vway[min(max(k + (1 if d > 0 else 0) - (0 if d > 0 else 1), 0), len(S.vway) - 1)]][0]
                rec = dict(n=n, si=si, k=k, d=d, ang=ang, hw=float(hw), pl=float(pl if d > 0 else pr),
                           pr=float(pr if d > 0 else pl), p=S.xy[k].copy(), way=wi, sw=int(S.sw[k]) if S.sw is not None else 0)
                if other is not None:
                    rec["other"] = other
                    internal.append(rec)
                else:
                    legs.append(rec)
        if len(legs) < 2:
            continue
        # group leg arms by direction (a dual carriageway approach = 2 arms)
        legs.sort(key=lambda r: r["ang"])
        grp_ = []
        for r in legs:
            for g_ in grp_:
                if abs(math.remainder(r["ang"] - g_["ang"], math.tau)) < math.radians(28):
                    g_["arms"].append(r)
                    break
            else:
                grp_.append(dict(ang=r["ang"], arms=[r]))
        for g_ in grp_:
            a = np.array([[math.cos(r["ang"]), math.sin(r["ang"])] for r in g_["arms"]]).mean(0)
            g_["ang"] = math.atan2(a[1], a[0])
            g_["dir"] = a / max(np.hypot(*a), 1e-9)
        # leg radius: the box reaches past every crossing leg's pavement edge
        for g_ in grp_:
            a = g_["dir"]
            R = 0.0
            for h in grp_:
                if h is g_:
                    continue
                sn = abs(math.sin(h["ang"] - g_["ang"]))
                for r in h["arms"]:
                    off = float(np.dot(r["p"] - c, a))
                    ext = r["hw"] / max(sn, 0.35) if sn > 0.35 else r["hw"] * 2.5
                    R = max(R, off + min(ext, r["hw"] * 2.5))
            for r in g_["arms"] + internal:
                R = max(R, float(np.dot(r["p"] - c, a)) + 1.0)
            g_["R"] = R + 0.5
            # full cross-section half width of the leg (for crosswalk span / signals)
            lat = []
            nrm = np.array([-a[1], a[0]])
            for r in g_["arms"]:
                o = float(np.dot(r["p"] - c, nrm))
                lat += [o - r["hw"], o + r["hw"]]
            g_["lat"] = (min(lat), max(lat))
        out.append(dict(root=root, mem=mem, c=c, sig=sig, legs=grp_, internal=internal))
    report["junction_clusters"] = len(out)
    report["junction_clusters_multi"] = sum(1 for x in out if len(x["mem"]) > 1)
    # member-node records (j_* arrays)
    rec = dict(xy=[], osm=[], cl=[], flags=[], arm_off=[0], arm_ang=[], arm_r=[], arm_hw=[], arm_flags=[])
    for ci, C in enumerate(out):
        c = C["c"]
        for n in C["mem"]:
            p = pos[n]
            rec["xy"].append(p)
            rec["osm"].append(float(n))
            rec["cl"].append(float(C["root"]))
            rec["flags"].append(1 if C["sig"] else 0)
            stops = stop_tree.query_ball_point(p, 30.0) if stop_tree is not None else []
            for g_ in C["legs"]:
                for r in g_["arms"]:
                    if r["n"] != n:
                        continue
                    rr = g_["R"] - float(np.dot(p - c, g_["dir"]))
                    af = 0
                    for si_ in stops:
                        q = stop_xy[si_] - p
                        if math.hypot(*q) > 2 and abs(math.remainder(math.atan2(q[1], q[0]) - r["ang"], math.tau)) < 0.5:
                            af |= 1
                    rec["arm_ang"].append(r["ang"])
                    rec["arm_r"].append(max(rr, 0.5))
                    rec["arm_hw"].append(r["hw"])
                    rec["arm_flags"].append(af)
            for r in C["internal"]:
                if r["n"] != n:
                    continue
                q = pos[r["other"]] - p
                rec["arm_ang"].append(r["ang"])
                rec["arm_r"].append(float(math.hypot(*q)) + 0.5)
                rec["arm_hw"].append(r["hw"])
                rec["arm_flags"].append(2)     # internal: no markings on this piece
            rec["arm_off"].append(len(rec["arm_ang"]))
    return out, rec


def junction_surfaces(clusters, strokes: list[Stroke], report):
    """Pavement polygon per intersection (union of the approach carriageways, closed
    with curb-return fillets, clipped to the crosswalk lines), corner sidewalks,
    curb lines, tactile pads at crosswalk ends, and signal poles."""
    import mapbox_earcut as earcut

    surf = []
    walks = []
    curbs = []
    pads = []
    poles = []
    # every drivable carriageway quad of the block (poles / plates must stand clear of all of them)
    quads = []
    for S in strokes:
        if S.kind != 0 or S.group not in (0, 2) or S.cls > 6 or S.attrs is None:
            continue
        P = S.xy
        d_ = np.diff(P, axis=0)
        ln_ = np.hypot(*d_.T)
        for k in np.nonzero(ln_ > 0.2)[0]:
            if S.vf[k] & V_TUNNEL:
                continue
            n_ = np.array([-d_[k, 1], d_[k, 0]]) / ln_[k]
            quads.append(shapely.Polygon([P[k] + n_ * S.attrs["pL"][k], P[k + 1] + n_ * S.attrs["pL"][k + 1],
                                          P[k + 1] - n_ * S.attrs["pR"][k + 1], P[k] - n_ * S.attrs["pR"][k]]))
    qtree = shapely.STRtree(quads) if quads else None

    def on_road(pt, margin=0.4):
        return qtree is not None and len(qtree.query(pt, predicate="dwithin", distance=margin)) > 0
    for ci, C in enumerate(clusters):
        c = C["c"]
        strips = []
        swstrips = []
        maxR = max(g_["R"] for g_ in C["legs"])
        for g_ in C["legs"]:
            for r in g_["arms"]:
                S = strokes[r["si"]]
                k, d = r["k"], r["d"]
                sv = S.s[k]
                reach = g_["R"] - float(np.dot(r["p"] - c, g_["dir"])) + 8.0
                m = (d * (S.s - sv) >= -0.01) & (d * (S.s - sv) <= reach)
                idx = np.nonzero(m)[0]
                if len(idx) < 2:
                    continue
                idx = idx if d > 0 else idx[::-1]
                strips.append(_strip(S, idx, 0.0))
                if r["sw"] & (SW_L | SW_R):
                    ws = SIDEWALK_W.get(S.cls, 2.4) + (1.8 if r["sw"] & (BLVD_L | BLVD_R) else 0.0)
                    swstrips.append(_strip(S, idx, ws, r["sw"]))
        for r in C["internal"]:
            S = strokes[r["si"]]
            k, d = r["k"], r["d"]
            sv = S.s[k]
            m = (d * (S.s - sv) >= -0.01) & (d * (S.s - sv) <= CLUSTER_D + 2)
            idx = np.nonzero(m)[0]
            if len(idx) >= 2:
                strips.append(_strip(S, idx if d > 0 else idx[::-1], 0.0))
        strips = [x for x in strips if x is not None and not x.is_empty]
        if not strips:
            continue
        road = shapely.union_all(strips)
        big = max(g_["R"] for g_ in C["legs"])
        rc = 7.0 if any(strokes[r["si"]].cls <= 3 for g_ in C["legs"] for r in g_["arms"]) else 5.0
        closed = road.buffer(rc, quad_segs=4).buffer(-rc, quad_segs=4)
        # clip: hull of the crosswalk lines
        hp = []
        for g_ in C["legs"]:
            a = g_["dir"]
            nrm = np.array([-a[1], a[0]])
            lo, hi = g_["lat"]
            R = g_["R"]
            hp.append(c + a * R + nrm * (lo - 6))
            hp.append(c + a * R + nrm * (hi + 6))
        clip = shapely.convex_hull(shapely.multipoints(np.array(hp)))
        clip = clip.union(shapely.Point(c).buffer(max(3.0, min(g_["R"] for g_ in C["legs"]) * 0.8)))
        # channelising islands (holes in the union of the carriageways: a slip-lane island in a
        # fork) stay islands -- the closing would pave them over
        islands = []
        for part in shapely.get_parts(road):
            if part.geom_type != "Polygon":
                continue
            for ring in part.interiors:
                h = shapely.Polygon(ring)
                if 6.0 < h.area < 4000.0:
                    islands.append(h)
        isl = shapely.union_all(islands).intersection(clip) if islands else shapely.Polygon()
        js = closed.intersection(clip)
        if not isl.is_empty:
            js = js.difference(isl)
        if js.is_empty or js.area < 4:
            continue
        js = shapely.make_valid(js)
        surf.append((ci, js))
        cw = shapely.Polygon()
        if swstrips:
            sw = shapely.union_all([x for x in swstrips if x is not None]).buffer(rc * 0.6, quad_segs=4).buffer(-rc * 0.6, quad_segs=4)
            cw = shapely.make_valid(sw.difference(closed).intersection(clip))
        ped = shapely.make_valid(cw.union(isl)) if not isl.is_empty else cw
        if not ped.is_empty and ped.area > 1:
            walks.append((ci, ped))
            cl = shapely.union_all([closed.boundary.intersection(clip).intersection(cw.buffer(0.3)) if not cw.is_empty else shapely.Polygon(),
                                    isl.boundary if not isl.is_empty else shapely.Polygon()])
            if not cl.is_empty:
                curbs.append((ci, cl))
        # everything drivable around the intersection (poles and plates must stand clear of it)
        drive = shapely.make_valid(shapely.union_all([js] + strips))
        ped_in = ped.buffer(-0.45) if not ped.is_empty else ped

        def place(p, allow_drop=False):
            """Move a pole / plate standing on pavement onto the nearest corner sidewalk or island
            (0.45 m in from the curb); failing that, just outside the pavement."""
            pt = shapely.Point(p)
            if not drive.buffer(0.4).contains(pt) and not on_road(pt):
                return p
            if not ped_in.is_empty:
                q = shapely.ops.nearest_points(ped_in, pt)[0]
                if q.distance(pt) < 15.0 and not on_road(q, 0.2):
                    return np.array([q.x, q.y])
            if allow_drop:
                return None
            # nearest free spot on rings around the point
            for r_ in (1.5, 3.0, 4.5, 6.0, 8.0, 10.0, 13.0):
                best = None
                for k_ in range(16):
                    a_ = k_ * math.pi / 8
                    q = shapely.Point(p[0] + r_ * math.cos(a_), p[1] + r_ * math.sin(a_))
                    if not drive.buffer(0.4).contains(q) and not on_road(q):
                        best = q
                        break
                if best is not None:
                    return np.array([best.x, best.y])
            return None
        # tactile pads at each leg's crosswalk ends (on the sidewalk / refuge)
        for g_ in C["legs"]:
            a = g_["dir"]
            nrm = np.array([-a[1], a[0]])
            lo, hi = g_["lat"]
            R = g_["R"]
            mid = R + 1.9
            for e, sgn in ((hi, 1), (lo, -1)):
                p = c + a * mid + nrm * (e + sgn * 0.45)
                if C["sig"] or any(r["sw"] for r in g_["arms"]):
                    q = place(p, allow_drop=True)
                    if q is not None:
                        pads.append((ci, q, math.atan2(nrm[1], nrm[0]) + (0 if sgn > 0 else math.pi), 3.0))
        if C["sig"]:
            for g_ in C["legs"]:
                a = g_["dir"]
                nrm = np.array([-a[1], a[0]])
                lo, hi = g_["lat"]
                # travel into the box is along -a; its right is +nrm. Far-side pole beyond the box on
                # the right, mast over the approach lanes; near-side pole on the approach corner;
                # median poles only where a real median / island is there
                opp = min(C["legs"], key=lambda h: math.cos(h["ang"] - g_["ang"]))
                if opp is not g_ and math.cos(opp["ang"] - g_["ang"]) < -0.7:
                    far = opp["R"] + 2.2
                else:  # T-junction stem: the far curb of the cross street
                    far = max((max(r["hw"] for r in h["arms"]) for h in C["legs"] if h is not g_), default=g_["R"]) + 2.5
                mast = float(np.clip(max(hi, 2.5) * 0.9, 2.5, 11.0))
                q = place(c - a * far + nrm * (max(hi, 2.5) + 1.0))
                if q is not None:
                    poles.append((ci, q, g_["ang"], mast, 0))
                q = place(c + a * (g_["R"] + 4.0) + nrm * (max(hi, 2.5) + 1.0))
                if q is not None:
                    poles.append((ci, q, g_["ang"], 1.2, 1))
                if len(g_["arms"]) >= 2:
                    offs = sorted(float(np.dot(r["p"] - c, nrm)) for r in g_["arms"])
                    q = place(c + a * (g_["R"] + 1.0) + nrm * ((offs[0] + offs[-1]) / 2), allow_drop=True)
                    if q is not None:
                        poles.append((ci, q, g_["ang"], 1.2, 2))
    report["junction_surfaces"] = len(surf)
    return surf, walks, curbs, pads, poles


def _strip(S: Stroke, idx, extra, sw=None):
    """Polygon of a stroke's pavement over vertex indices idx (in walking order);
    extra > 0: widen the sides that have sidewalks by `extra` (sidewalk band)."""
    P = S.xy[idx]
    if len(P) < 2:
        return None
    d = np.gradient(P, axis=0)
    ln = np.hypot(*d.T)
    ln[ln < 1e-9] = 1
    nrm = np.stack([-d[:, 1] / ln, d[:, 0] / ln], 1)
    fwd = idx[-1] >= idx[0]
    pl = S.attrs["pL"][idx] if fwd else S.attrs["pR"][idx]
    pr = S.attrs["pR"][idx] if fwd else S.attrs["pL"][idx]
    if extra:
        lbit, rbit = (SW_L, SW_R) if fwd else (SW_R, SW_L)
        pl = pl + (extra if sw & lbit else 0.0)
        pr = pr + (extra if sw & rbit else 0.0)
    left = P + nrm * pl[:, None]
    right = P - nrm * pr[:, None]
    ring = np.vstack([left, right[::-1]])
    g = shapely.Polygon(ring)
    if not g.is_valid:
        g = shapely.make_valid(g)
    return g


# ------------------------------------------------------------------ medians, rail embedding


def medians(L: Lines, strokes: list[Stroke], clusters, report):
    """Raised medians between the two carriageways of divided streets (same name,
    opposite directions, 0.8-30 m apart). kind: 0 concrete, 1 grass, 2 rail right-of-way."""
    cand = [si for si, S in enumerate(strokes) if S.kind == 0 and S.group == 0 and S.oneway and 2 <= S.cls <= 5]
    by_name = defaultdict(list)
    for si in cand:
        nm = str(L.name[strokes[si].ways[0][0]])
        if nm:
            by_name[nm].append(si)
    rail_pts = [S.xy for S in strokes if S.kind == 1 and not (S.vf & V_TUNNEL).all()]
    rtree = cKDTree(np.vstack(rail_pts)) if rail_pts else None
    ctree = cKDTree(np.array([C["c"] for C in clusters])) if clusters else None
    cR = np.array([max(g_["R"] for g_ in C["legs"]) + 3.0 for C in clusters]) if clusters else None
    out = []
    for nm, lst in by_name.items():
        if len(lst) < 2:
            continue
        pts = np.vstack([strokes[si].xy for si in lst])
        owner = np.concatenate([np.full(len(strokes[si].xy), si) for si in lst])
        vidx = np.concatenate([np.arange(len(strokes[si].xy)) for si in lst])
        tree = cKDTree(pts)
        for si in lst:
            A = strokes[si]
            # sample every ~8 m
            k = np.unique(np.searchsorted(A.s, np.arange(0, A.s[-1], 8.0)).clip(0, len(A.s) - 1))
            seg = []
            for kk in k:
                p = A.xy[kk]
                t = A.xy[min(kk + 1, len(A.s) - 1)] - A.xy[max(kk - 1, 0)]
                tl = math.hypot(*t) or 1
                t = t / tl
                nrm = np.array([-t[1], t[0]])   # left of travel: the median side (right-hand traffic)
                best = None
                for j in tree.query_ball_point(p, 45.0):
                    if owner[j] == si:
                        continue
                    B = strokes[owner[j]]
                    q = B.xy[vidx[j]]
                    u = B.xy[min(vidx[j] + 1, len(B.s) - 1)] - B.xy[max(vidx[j] - 1, 0)]
                    if np.dot(u, t) > -0.8 * (math.hypot(*u) or 1):
                        continue
                    lat = float(np.dot(q - p, nrm))
                    if lat <= 0:
                        continue
                    if best is None or lat < best[0]:
                        best = (lat, owner[j], vidx[j])
                if best is None:
                    seg.append(None)
                    continue
                lat, bj, bv = best
                B = strokes[bj]
                gap = lat - A.attrs["pL"][kk] - B.attrs["pL"][bv]
                if not (0.8 < gap < 30):
                    seg.append(None)
                    continue
                cpos = p + nrm * (A.attrs["pL"][kk] + gap / 2)
                if ctree is not None:
                    dd, ci = ctree.query(cpos)
                    if dd < cR[ci]:
                        seg.append(None)
                        continue
                # only one of the two carriageways emits (the one with the smaller stroke id)
                if bj < si:
                    seg.append(None)
                    continue
                kind = 1 if gap > 4 else 0
                if rtree is not None and rtree.query_ball_point(cpos, gap / 2 + 0.5):
                    kind = 2
                seg.append((cpos, gap, kind, float(A.z[kk] if A.z is not None else A.g[kk])))
            run = []
            for x in seg + [None]:
                if x is None:
                    if len(run) >= 2:
                        out.append(run)
                    run = []
                else:
                    run.append(x)
    report["medians"] = len(out)
    return out


def grass_track(strokes: list[Stroke], med, report):
    """Rail in a median right-of-way (Line 5 / Line 6 style) sits on a grass track bed."""
    pts, hw = [], []
    for run in med:
        for p, w, k, _ in run:
            if k == 2:
                pts.append(p)
                hw.append(w / 2)
    if not pts:
        return
    tree = cKDTree(np.array(pts))
    hw = np.array(hw)
    n = 0
    for S in strokes:
        if S.kind != 1 or S.cls not in (3, 4):
            continue
        d, i = tree.query(S.xy, distance_upper_bound=20.0)
        ok = np.isfinite(d)
        m = np.zeros(len(S.s), bool)
        m[ok] = d[ok] < hw[i[ok]] + 4.0
        m &= (S.vf & (V_BRIDGE | V_TUNNEL | V_EMBED)) == 0
        S.vf[m] = (S.vf[m] & 0x0F) | (STRUCT["grass"] << V_STRUCT_SHIFT)
        n += int(m.sum())
    report["grass_track_vertices"] = n


def embed_rail(strokes: list[Stroke], surfaces, report):
    """Rail set in pavement: all streetcar track, and any track inside a junction
    surface or across a drivable carriageway (level crossings, median ROW crossings)."""
    polys = [g for _, g in surfaces]
    road_pts = []
    road_hw = []
    road_z = []
    for S in strokes:
        if S.kind == 0 and S.group == 0 and S.cls <= 6:
            keep = (S.vf & V_TUNNEL) == 0                 # a street in a tunnel / underpass is not
            road_pts.append(S.xy[keep])                   # across the track
            road_hw.append(np.maximum(S.attrs["pL"], S.attrs["pR"])[keep])
            road_z.append((S.z if S.z is not None else S.g)[keep])
    rp = np.vstack(road_pts) if road_pts else np.zeros((0, 2))
    rh = np.concatenate(road_hw) if road_hw else np.zeros(0)
    rz = np.concatenate(road_z) if road_z else np.zeros(0)
    tree = cKDTree(rp) if len(rp) else None
    ptree = shapely.STRtree(polys) if polys else None
    n = 0
    for S in strokes:
        if S.kind != 1:
            continue
        cls = [0] * 0
        tram = np.array([True for _ in S.s]) if S.cls == 4 else np.zeros(len(S.s), bool)
        m = tram.copy()
        if tree is not None:
            for k in range(len(S.s)):
                if m[k] or S.vf[k] & (V_BRIDGE | V_TUNNEL):
                    continue
                zk = S.z[k] if S.z is not None else S.g[k]
                for j in tree.query_ball_point(S.xy[k], 25.0):
                    # same level only: a street passing under (or over) the track is no crossing
                    if np.hypot(*(rp[j] - S.xy[k])) < rh[j] + 1.0 and abs(rz[j] - zk) < 1.5:
                        m[k] = True
                        break
        if ptree is not None:
            hit = ptree.query(shapely.points(S.xy), predicate="within")
            zz = S.z if S.z is not None else S.g
            ok = np.abs(zz[hit[0]] - S.g[hit[0]]) < 1.0      # junction surfaces are at grade
            m[hit[0][ok]] = True
        # grow by one vertex so panels cover the whole road width between samples
        m2 = m.copy()
        m2[1:] |= m[:-1]
        m2[:-1] |= m[1:]
        S.vf[m2 & ((S.vf & (V_BRIDGE | V_TUNNEL)) == 0)] |= V_EMBED
        n += int(m2.sum())
    report["embedded_rail_vertices"] = n



# ------------------------------------------------------------------ output


def _tri(geom):
    """earcut triangulation of a (multi)polygon -> (xy (n,2), tri (m,3))."""
    import mapbox_earcut as earcut

    xs, ts = [], []
    base = 0
    for g in shapely.get_parts(geom):
        if g.geom_type != "Polygon" or g.area < 0.5:
            continue
        rings = [np.asarray(g.exterior.coords)[:-1]] + [np.asarray(r.coords)[:-1] for r in g.interiors]
        v = np.vstack(rings)
        ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
        t = earcut.triangulate_float64(v, ends).reshape(-1, 3)
        xs.append(v)
        ts.append(t + base)
        base += len(v)
    if not xs:
        return np.zeros((0, 2)), np.zeros((0, 3), np.int64)
    return np.vstack(xs), np.vstack(ts)


def _block(args):
    """Process one block (errors are reported, not fatal: the block is retried without detail)."""
    try:
        return _block_inner(args)
    except MemoryError:
        raise
    except Exception as e:  # noqa: BLE001
        import traceback
        print(f"  block {args} FAILED: {e!r}\n{traceback.format_exc()}", flush=True)
        # a failed block would leave a silent hole in the network (downtown lost its roads
        # once); fail the build unless explicitly allowed
        if not __import__("os").environ.get("RN_ALLOW_BLOCK_FAIL"):
            raise
        return None


def _block_inner(args):
    """Process one block; returns its core output (lists) and report."""
    core = args
    G = _G
    x0, y0, x1, y1 = core
    halo = (x0 - HALO, y0 - HALO, x1 + HALO, y1 + HALO)
    strokes, report, ups, evs, curated = run_block(G, core, halo)
    if not strokes:
        return None
    L = G["L"]
    sidewalks(L, strokes, report, G["bd"])
    clusters, jrec = junction_clusters(L, strokes, G["inc"], report, G["nodes"])
    surf, walks, curbs, pads, poles = junction_surfaces(clusters, strokes, report)
    med = medians(L, strokes, clusters, report)
    embed_rail(strokes, surf, report)
    grass_track(strokes, med, report)
    out = emit(L, strokes, clusters, jrec, surf, walks, curbs, pads, poles, med, core)
    del strokes, clusters, jrec, surf, walks, curbs, pads, poles, med
    # compact right away: a handful of flat arrays per block instead of ~200k small dicts / tuples
    # (the per-item Python objects of all blocks were what made a serial run grow to 7 GB)
    out = merge_parts([out])
    inside = lambda x, y: x0 <= x < x1 and y0 <= y < y1
    report["suspicious"] = [q for q in report.get("suspicious", []) if inside(*geo.project(q["lon"], q["lat"]))]
    report["lane_fixes"] = []
    memguard("block")
    return out, report


_G = None


def _worker_start():
    import os

    print(f"  roadnet worker {os.getpid()} up ({memguard('worker'):.1f} GB)", flush=True)


def build(bbox=None, out_path=None, workers=2, only=None):
    global _G
    t0 = time.time()
    G = prep(bbox)
    _G = G
    L = G["L"]
    x0, y0 = L.xy.min(0)
    x1, y1 = L.xy.max(0)
    cores = []
    for j in range(math.floor(y0 / BLOCK), math.floor(y1 / BLOCK) + 1):
        for i in range(math.floor(x0 / BLOCK), math.floor(x1 / BLOCK) + 1):
            c = (i * BLOCK, j * BLOCK, (i + 1) * BLOCK, (j + 1) * BLOCK)
            if only and (i, j) not in only:
                continue
            cores.append(c)
    # biggest first
    bx0, by0, bx1, by1 = G["box"]
    cx = (bx0 + bx1) / 2
    cy = (by0 + by1) / 2
    cnt = {c: int(((cx >= c[0]) & (cx < c[2]) & (cy >= c[1]) & (cy < c[3])).sum()) for c in cores}
    cores = sorted([c for c in cores if cnt[c]], key=lambda c: -cnt[c])
    print(f"{len(cores)} blocks", flush=True)
    # finished blocks are spooled to disk (not kept in memory): the retained output of all blocks
    # plus the global prep state was what pushed a serial run from ~4 GB to 7 GB
    import shutil
    spool = geo.WORK / "roadnet_blocks"
    shutil.rmtree(spool, ignore_errors=True)
    spool.mkdir(parents=True)
    parts = []
    reports = []

    def keep(blk):
        f = spool / f"{len(parts):04d}.npz"
        np.savez(f, **blk)
        parts.append(f)
    if workers > 1 and len(cores) > 1:
        # ProcessPoolExecutor: a worker that dies (OOM kill, crash at start) raises
        # BrokenProcessPool here instead of the silent respawn loop of multiprocessing.Pool
        import multiprocessing as mp
        from concurrent.futures import ProcessPoolExecutor, as_completed
        from concurrent.futures.process import BrokenProcessPool

        try:
            with ProcessPoolExecutor(workers, mp_context=mp.get_context("fork"), initializer=_worker_start) as ex:
                futs = [ex.submit(_block, c) for c in cores]
                for k, f in enumerate(as_completed(futs), 1):
                    res = f.result()
                    if res:
                        keep(res[0])
                        reports.append(res[1])
                    del res
                    if k % 10 == 0 or k == len(cores):
                        print(f"  {k}/{len(cores)} blocks ({time.time() - t0:.0f}s)", flush=True)
        except BrokenProcessPool as e:
            raise SystemExit(f"roadnet: a worker process died ({e}); memory watchdog / fork problem? "
                             f"re-run with --workers 1") from e
    else:
        for k, c in enumerate(cores, 1):
            res = _block(c)
            if res:
                keep(res[0])
                reports.append(res[1])
            del res
            print(f"  {k}/{len(cores)} blocks ({time.time() - t0:.0f}s, {memguard('main'):.1f} GB)", flush=True)
    write_crossings(G)
    base_report = dict(G["report"])
    _G = None
    del G, L
    A = concat_block_files(parts)
    shutil.rmtree(spool, ignore_errors=True)
    report = base_report
    report["rail_pieces_stitched"] = stitch_rail(A)
    report["underpasses"] = write_underpasses(A)
    for r in reports:
        for k, v in r.items():
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                report[k] = report.get(k, 0) + v
            elif isinstance(v, dict):
                d = report.setdefault(k, {})
                for kk, vv in v.items():
                    if isinstance(vv, (int, float)):
                        d[kk] = d.get(kk, 0) + vv
            elif isinstance(v, list) and k in ("suspicious", "curated"):
                report.setdefault(k, []).extend(v)
    path = out_path or (geo.WORK / "roadnet.npz")
    np.savez(path, **A)
    (geo.WORK / "roadnet_report.json").write_text(json.dumps(report, indent=1, default=str))
    print(f"wrote {path} ({time.time() - t0:.0f}s): {len(A['road_off']) - 1:,} road pieces, "
          f"{len(A['rail_off']) - 1:,} rail pieces, {len(A['jn_osm']):,} junction nodes, "
          f"{len(A['js_off']) - 1:,} surfaces, {len(A['md_off']) - 1:,} medians", flush=True)
    return A


def write_crossings(G, path=None):
    """Railway level crossings for the client (layers/CrossingsLayer.ts) and the sims:
    data/crossings.json = {crossings: [{id, e, n, kind (5 road / 6 path), gates, lights,
    roads: [way ids], tracks: [way ids], approaches: [{heading, mast: [e, n], yaw, arm, cant}]}]}.
    heading = travel direction toward the crossing (rad, CCW from +E); the mast stands on the
    right of that approach 5.5 m before the node; the gate arm points `yaw` across `arm` metres
    of lanes; `cant` = cantilever flasher over the lanes (wide roads)."""
    L = G["L"]
    nd = G["nodes"]
    sel = np.nonzero(np.isin(nd["kind"], [5, 6]))[0]
    with np.load(geo.WORK / "osm_nodes.npz") as f:
        var = f["var"] if "var" in f.files else np.zeros(len(f["kind"]), np.uint8)
    order = np.argsort(L.nid)
    snid = L.nid[order]
    way_of_v = np.repeat(np.arange(L.n), np.diff(L.off))
    out = []
    for q in sel:
        nid = int(nd["id"][q])
        a = np.searchsorted(snid, nid)
        b = np.searchsorted(snid, nid, side="right")
        vs = order[a:b]
        if not len(vs):
            continue
        roads, tracks, tcls = [], [], []
        appr = []
        for v in vs:
            w = int(way_of_v[v])
            if L.kind[w] == 1:
                tracks.append(float(L.id[w]))
                tcls.append(int(L.cls[w]))
                continue
            if L.kind[w] != 0 or (L.flags[w] & (F_LOT | F_DUP)) and nd["kind"][q] == 5:
                continue
            roads.append(float(L.id[w]))
            p = L.pts(w)
            k = v - L.off[w]
            hw = max(float(L.width[w]) / 2, 1.0)
            for d in (-1, 1):
                j = k + d
                if not (0 <= j < len(p)):
                    continue
                t = p[k] - p[j]                       # travel toward the node from this side
                tl = math.hypot(*t)
                if tl < 1e-6:
                    continue
                t /= tl
                right = np.array([t[1], -t[0]])
                pos = p[k] - t * 5.5 + right * (hw + 1.3)
                appr.append(dict(heading=round(math.atan2(t[1], t[0]), 4), mast=[round(float(pos[0]), 2), round(float(pos[1]), 2)],
                                 yaw=round(math.atan2(-right[1], -right[0]), 4), arm=round(hw + 0.6 if nd["kind"][q] == 5 else hw + 0.3, 2),
                                 cant=bool(hw > 7.5)))
        if not tracks or not roads:
            continue
        vv = int(var[q]) if q < len(var) else 0
        # untagged road crossings of main-line / freight track are gated in practice (Transport Canada
        # GCS: gates where train speed / traffic warrant); streetcar-road crossings have neither
        if nd["kind"][q] == 5 and tcls and min(tcls) <= 1 and not (vv & 3):
            vv |= 3
        if tcls and min(tcls) == 4:
            vv = 0
        out.append(dict(id=nid, e=round(float(nd["xy"][q][0]), 2), n=round(float(nd["xy"][q][1]), 2), kind=int(nd["kind"][q]),
                        gates=bool(vv & 1), lights=bool(vv & 2) or bool(vv & 1), roads=roads, tracks=tracks, approaches=appr))
    if path is None:
        # debug extracts (TPIPE_WORK=work/test_*) must not overwrite the real data's crossings file
        path = (geo.OUT / "crossings.json") if geo.WORK.resolve() == (geo.PIPE / "work").resolve() else (geo.WORK / "crossings.json")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(dict(version=1, crossings=out), separators=(",", ":")))
    print(f"wrote {path}: {len(out):,} level crossings ({sum(1 for c in out if c['gates']):,} gated)", flush=True)


def emit(L: Lines, strokes, clusters, jrec, surf, walks, curbs, pads, poles, med, core):
    """Core-block output (merged over blocks by merge_parts). Pieces keep only the segments
    whose midpoint lies in the core, so neighbouring blocks share their boundary vertices."""
    x0, y0, x1, y1 = core
    inside = lambda x, y: (x >= x0) & (x < x1) & (y >= y0) & (y < y1)  # noqa: E731
    nF, nB = nF_glob, nB_glob

    def seg_runs(S):
        if len(S.s) < 2:
            return []
        mid = (S.xy[1:] + S.xy[:-1]) / 2
        return [(a, b + 2) for a, b in _runs(inside(mid[:, 0], mid[:, 1]))]   # vertex slices [a, b)

    O = defaultdict(list)
    for S in strokes:
        z = S.z if S.z is not None else S.g
        ws = [i for i, _ in S.ways]
        runs_ = seg_runs(S)
        if S.kind == 1:
            # rail pieces split where a bridge / tunnel starts or ends (piece flags stay meaningful)
            split = []
            for a, b in runs_:
                key = S.vf[a:b] & (V_BRIDGE | V_TUNNEL)
                cuts = [0] + [k for k in range(1, b - a) if key[k] != key[k - 1]] + [b - a]
                for c0, c1 in zip(cuts[:-1], cuts[1:]):
                    p0 = a + max(c0 - 1, 0) if c0 > 0 else a
                    if a + c1 - p0 >= 2:
                        split.append((p0, a + c1))
            runs_ = split
        for a, b in runs_:
            if S.kind == 1:
                sw_ = [ws[k] for k in sorted(set(S.vway[a:b].tolist()))]
                O["rail"].append(dict(xyz=np.column_stack([S.xy[a:b], z[a:b]]), vf=S.vf[a:b], s=S.s[a:b],
                                      cls=S.cls if S.cls != 1 else int(L.cls[ws[0]]),
                                      flags=int(np.bitwise_or.reduce(L.flags[sw_])) & ~(F_BRIDGE | F_TUNNEL) |
                                      (F_BRIDGE if (S.vf[a + 1:b] & V_BRIDGE).all() else 0) |
                                      (F_TUNNEL if (S.vf[a + 1:b] & V_TUNNEL).all() else 0),
                                      osm=[float(L.id[i]) for i in sw_],
                                      corr=float(L.id[strokes[S.corridor].ways[0][0]]) if S.corridor >= 0 else 0.0))
                continue
            if S.group == 2:
                O["lot"].append(dict(xyz=np.column_stack([S.xy[a:b], z[a:b]]), osm=float(L.id[ws[0]]), svc=int(L.svc[ws[0]])))
                continue
            if S.group not in (0, 1):
                continue
            wc = np.array([int(L.cls[ws[k]]) for k in S.vway[a:b]])
            key = wc * 4 + (S.vf[a:b] & (V_BRIDGE | V_TUNNEL))
            cuts = [0] + [k for k in range(1, len(wc)) if key[k] != key[k - 1]] + [len(wc)]
            for c0, c1 in zip(cuts[:-1], cuts[1:]):
                p0 = a + max(c0 - 1, 0) if c0 > 0 else a
                p1 = a + c1
                if p1 - p0 < 2:
                    continue
                sl = slice(p0, p1)
                inner = S.vf[a + c0:p1]
                i0 = ws[S.vway[a + c0]]
                wsel = sorted(set(ws[k] for k in S.vway[sl]))
                fl = int(np.bitwise_or.reduce(L.flags[wsel])) & ~(F_BRIDGE | F_TUNNEL)
                if (inner & V_BRIDGE).all():
                    fl |= F_BRIDGE
                if (inner & V_TUNNEL).all():
                    fl |= F_TUNNEL
                mkp = S.attrs["mk"][a + c0:p1]
                O["road"].append(dict(
                    xyz=np.column_stack([S.xy[sl], z[sl]]), el=S.attrs["eL"][sl], er=S.attrs["eR"][sl],
                    pl=S.attrs["pL"][sl], pr=S.attrs["pR"][sl], mk=S.attrs["mk"][sl], lw=S.attrs["lw"][sl],
                    vf=S.vf[sl], sw=S.sw[sl] if S.sw is not None else np.zeros(p1 - p0, np.int64), s=S.s[sl],
                    ws=S.ws[sl] if S.ws is not None else np.zeros((p1 - p0, 2), np.float32),
                    cls=int(L.cls[i0]), flags=fl & 0xFF, osm=float(L.id[i0]), name=str(L.name[i0]),
                    layer=int(L.layer[i0]), side=int(L.side[i0]),
                    lanes=int(np.median((mkp & 15) + ((mkp >> 4) & 15))),
                    width=float(np.median(S.attrs["pL"][a + c0:p1] + S.attrs["pR"][a + c0:p1])),
                    svc=int(L.svc[i0]), sub=int(L.sub[i0]), surf=int(L.surf[i0]), cyc=int(L.cyc[i0])))
        # ---- per-way geometry for the traffic graph (drivable): ways whose first vertex is in the core
        if S.kind == 0 and S.group in (0, 2):
            for k, (i, rev) in enumerate(S.ways):
                p0 = L.pts(i)[0]
                if not inside(p0[0], p0[1]):
                    continue
                idx = np.nonzero(S.vway == k)[0]
                if not len(idx):
                    continue
                a0 = idx[0] - 1 if k > 0 else idx[0]
                sl = np.arange(max(a0, 0), idx[-1] + 1)
                xyz = np.column_stack([S.xy[sl], z[sl]])
                ss = S.s[sl] - S.s[sl[0]]
                ns = L.nids(i)
                if rev:
                    xyz = xyz[::-1]
                    ss = ss[-1] - ss[::-1]
                # node stations: project the OSM nodes (in way order) onto the way's own polyline,
                # monotonically (a stroke may pass the same node twice, so no id lookup)
                if len(xyz) < 2:
                    continue      # a stub trimmed away at a building wall
                q = L.pts(i)
                nss = np.empty(len(q))
                seg_a, seg_b = xyz[:-1, :2], xyz[1:, :2]
                dd = seg_b - seg_a
                ll = np.maximum((dd * dd).sum(1), 1e-12)
                lo_s = 0.0
                for t_, p_ in enumerate(q):
                    tt = np.clip(((p_ - seg_a) * dd).sum(1) / ll, 0, 1)
                    cpt = seg_a + dd * tt[:, None]
                    dist = np.hypot(*(cpt - p_).T)
                    sv = ss[:-1] + tt * np.diff(ss)
                    dist = np.where(sv >= lo_s - 0.5, dist, np.inf)
                    k_ = int(np.argmin(dist))
                    nss[t_] = max(sv[k_], lo_s)
                    lo_s = nss[t_]
                nss[0], nss[-1] = 0.0, ss[-1]
                mid = sl[len(sl) // 2]
                fl = int(L.flags[i])
                if (S.vf[sl] & V_BRIDGE).any():
                    fl |= F_BRIDGE
                if ((S.vf[sl] >> V_STRUCT_SHIFT) == STRUCT["exact"]).any():
                    fl |= F_TUNNEL       # dipped under a rail corridor: cars take the graph's z there
                O["way"].append(dict(id=float(L.id[i]), xyz=xyz, s=ss, nF=int(nF[i]), nB=int(nB[i]),
                                     width=float(S.attrs["pL"][mid] + S.attrs["pR"][mid]), flags=fl,
                                     node=ns.astype(np.int64), node_s=nss))
    # ---- junctions (member-node records of clusters whose centre is in the core)
    ao = jrec["arm_off"]
    rec_i = 0
    for ci, C in enumerate(clusters):
        n_mem = len(C["mem"])
        inc = inside(C["c"][0], C["c"][1])
        for m_ in range(n_mem):
            k = rec_i + m_
            if inc:
                O["jn"].append(dict(xy=jrec["xy"][k], osm=jrec["osm"][k], cl=jrec["cl"][k], flags=jrec["flags"][k],
                                    ang=jrec["arm_ang"][ao[k]:ao[k + 1]], r=jrec["arm_r"][ao[k]:ao[k + 1]],
                                    hw=jrec["arm_hw"][ao[k]:ao[k + 1]], af=jrec["arm_flags"][ao[k]:ao[k + 1]]))
        rec_i += n_mem
    for key, lst in (("js", surf), ("jw", walks)):
        for ci, g_ in lst:
            c = clusters[ci]["c"]
            if not inside(c[0], c[1]):
                continue
            v, t = _tri(g_)
            if len(t):
                O[key].append(dict(xy=v, tri=t, c=c))
    for ci, g_ in curbs:
        c = clusters[ci]["c"]
        if not inside(c[0], c[1]):
            continue
        g2 = shapely.line_merge(g_) if g_.geom_type in ("MultiLineString", "LineString") else g_
        road = next((g for c_, g in surf if c_ == ci), None)
        for part in shapely.get_parts(g2):
            if part.geom_type == "LineString" and part.length >= 0.5:
                q = np.asarray(part.coords)
                # orient with the road surface on the left (the client faces curbs that way)
                if road is not None and len(q) >= 2:
                    m_ = (q[0] + q[1]) / 2
                    d_ = q[1] - q[0]
                    nl = np.array([-d_[1], d_[0]]) / max(np.hypot(*d_), 1e-9)
                    if not road.buffer(0.3).contains(shapely.Point(m_ + nl * 0.4)):
                        q = q[::-1]
                O["jc"].append(q)
    for ci, p_, ang, w_ in pads:
        if inside(p_[0], p_[1]):
            O["jt"].append((p_, ang, w_))
    for ci, p_, ang, mast, kind in poles:
        if inside(clusters[ci]["c"][0], clusters[ci]["c"][1]):
            O["sg"].append((p_, ang, mast, kind, clusters[ci]["root"]))
    for run in med:
        P = np.array([[p[0], p[1], z_] for p, _, _, z_ in run])
        W_ = np.array([g for _, g, _, _ in run])
        kd = int(np.bincount([k for _, _, k, _ in run]).argmax())
        mid = (P[1:, :2] + P[:-1, :2]) / 2
        for a, b in _runs(inside(mid[:, 0], mid[:, 1])):
            O["md"].append(dict(xyz=P[a:b + 2], w=W_[a:b + 2], kind=kd))
    return dict(O)


# offset arrays -> (the array they index into, its row count key); triangle arrays -> their vertex arrays
_OFFS = {"road_off": "road_xyz", "lot_off": "lot_xyz", "rail_off": "rail_xyz", "rail_osm_off": "rail_osm",
         "way_off": "way_xyz", "way_node_off": "way_node", "jn_arm_off": "jn_arm_ang", "js_off": "js_tri",
         "jw_off": "jw_tri", "jc_off": "jc_xy", "md_off": "md_xyz"}
_TRIS = {"js_tri": "js_xy", "jw_tri": "jw_xy"}


def write_underpasses(A: dict, path=None) -> int:
    """Streets passing under main-line / siding track (rail more than 3 m above the street at the
    crossing, street not in a tunnel): one record per street x track crossing for the structures builder
    (docs/STRUCTURES.md) -- data/underpasses.json = {underpasses: [{e, n, street, street_name,
    track, z_street, z_rail, clearance}]}, z = datum m at the crossing, clearance = rail top - street."""
    ro, rx, rv = A["road_off"], A["road_xyz"], A["road_vf"]
    lo, lx, lv, lc = A["rail_off"], A["rail_xyz"], A["rail_vf"], A["rail_cls"]
    loo, losm = A["rail_osm_off"], A["rail_osm"]
    # streets (not in tunnels) that cross under a surface track by more than 3 m
    tun = np.add.reduceat((rv & V_TUNNEL) != 0, ro[:-1].astype(np.int64)) if len(ro) > 1 else np.zeros(0)
    dip = np.nonzero((A["road_cls"] <= 6) & (tun == 0))[0] if len(ro) > 1 else np.zeros(0, np.int64)
    rails = [i for i in range(len(lo) - 1) if lc[i] <= 1 and lo[i + 1] - lo[i] >= 2]
    out = []
    if len(dip) and rails:
        rg = [shapely.LineString(lx[lo[i]:lo[i + 1], :2]) for i in rails]
        tree = shapely.STRtree(rg)
        dip = dip[(ro[dip + 1] - ro[dip]) >= 2]
        cnt = (ro[dip + 1] - ro[dip]).astype(np.int64)
        vi = np.repeat(ro[dip].astype(np.int64) - np.concatenate([[0], np.cumsum(cnt)[:-1]]), cnt) + np.arange(cnt.sum())
        roads = shapely.linestrings(rx[vi, :2], indices=np.repeat(np.arange(len(dip)), cnt))
        pairs = tree.query(roads, predicate="intersects")        # (road index, rail index)

        def z_at(Q, q):
            k = int(np.argmin(np.hypot(*(Q[:, :2] - q).T)))
            return float(Q[k, 2])
        for a, j in zip(*pairs):
            i = dip[a]
            P = rx[ro[i]:ro[i + 1]]
            for pt in shapely.get_parts(shapely.intersection(roads[a], rg[j])):
                if pt.geom_type != "Point":
                    continue
                q = np.array([pt.x, pt.y])
                ri = rails[j]
                zr, zs = z_at(lx[lo[ri]:lo[ri + 1]], q), z_at(P, q)
                if zr - zs < 3.0:
                    continue
                out.append(dict(e=round(float(q[0]), 1), n=round(float(q[1]), 1), street=int(A["road_osm"][i]),
                                street_name=str(A["road_name"][i]), track=int(losm[loo[ri]]),
                                z_street=round(zs, 2), z_rail=round(zr, 2), clearance=round(zr - zs, 2)))
    if path is None:
        path = (geo.OUT / "underpasses.json") if geo.WORK.resolve() == (geo.PIPE / "work").resolve() else (geo.WORK / "underpasses.json")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(dict(version=1, underpasses=out), separators=(",", ":")))
    print(f"wrote {path}: {len(out):,} street x track underpass crossings", flush=True)
    return len(out)


def stitch_rail(A: dict) -> int:
    """Join rail pieces that continue each other across a block seam (each block emits its core
    part of a track; both share the seam vertex). A piece end joins a piece start at exactly the
    same point when that pairing is unique there and class / flags agree; the osm lists merge.
    Unstitched, a yard crossing a seam reads as dozens of dangling track ends."""
    off, xyz = A["rail_off"], A["rail_xyz"]
    n = len(off) - 1
    if n < 2:
        return 0
    cls, fl = A["rail_cls"], A["rail_flags"]
    first = np.round(xyz[off[:-1], :2], 3)
    last = np.round(xyz[off[1:] - 1, :2], 3)
    touch = defaultdict(list)                 # point -> [(piece, 0 start / 1 end)]
    for i in range(n):
        touch[(first[i, 0], first[i, 1])].append((i, 0))
        touch[(last[i, 0], last[i, 1])].append((i, 1))
    nxt = np.full(n, -1, np.int64)
    prv = np.full(n, -1, np.int64)
    for lst in touch.values():
        if len(lst) != 2:
            continue
        (a, ea), (b, eb) = lst
        if ea == eb or a == b:
            continue
        i, j = (a, b) if ea == 1 else (b, a)      # i ends here, j starts here
        if cls[i] != cls[j] or fl[i] != fl[j]:
            continue
        nxt[i], prv[j] = j, i
    if not (nxt >= 0).any():
        return 0
    oo, osm = A["rail_osm_off"], A["rail_osm"]
    order, done = [], np.zeros(n, bool)
    for i in range(n):
        if done[i] or prv[i] >= 0:
            continue
        chain = [i]
        done[i] = True
        while nxt[chain[-1]] >= 0 and not done[nxt[chain[-1]]]:
            chain.append(int(nxt[chain[-1]]))
            done[chain[-1]] = True
        order.append(chain)
    for i in range(n):                         # closed loops: keep as they are
        if not done[i]:
            order.append([i])
            done[i] = True
    new = {k: [] for k in ("xyz", "vf", "s")}
    offs, oofs, osm_new, cls_new, fl_new, corr_new = [0], [0], [], [], [], []
    corr = A.get("rail_corr", np.zeros(n))
    for chain in order:
        cnt = 0
        ids = []
        for q, i in enumerate(chain):
            a, b = off[i] + (1 if q else 0), off[i + 1]
            new["xyz"].append(xyz[a:b])
            new["vf"].append(A["rail_vf"][a:b])
            new["s"].append(A["rail_s"][a:b])
            cnt += b - a
            for x in osm[oo[i]:oo[i + 1]]:
                if not ids or ids[-1] != x:
                    ids.append(x)
        offs.append(offs[-1] + cnt)
        osm_new += ids
        oofs.append(oofs[-1] + len(ids))
        cls_new.append(cls[chain[0]])
        fl_new.append(fl[chain[0]])
        corr_new.append(corr[chain[0]])
    A["rail_off"] = np.array(offs, np.int64)
    A["rail_xyz"] = np.vstack(new["xyz"])
    A["rail_vf"] = np.concatenate(new["vf"])
    A["rail_s"] = np.concatenate(new["s"])
    A["rail_cls"] = np.array(cls_new, cls.dtype)
    A["rail_flags"] = np.array(fl_new, fl.dtype)
    A["rail_osm_off"] = np.array(oofs, np.int64)
    A["rail_osm"] = np.array(osm_new, osm.dtype)
    A["rail_corr"] = np.array(corr_new, np.float64)
    return n - len(order)


def concat_block_files(files) -> dict:
    """concat_blocks over spooled block files, one array name at a time (bounded memory)."""
    if not files:
        return merge_parts([])
    with np.load(files[0], allow_pickle=True) as f:
        keys = list(f.files)
    A = {}
    for k in keys:
        arrs = []
        for fn in files:
            with np.load(fn, allow_pickle=True) as f:
                arrs.append(f[k])
        if k in _TRIS:
            base = 0
            out = []
            for fn, t in zip(files, arrs):
                out.append(t + base)
                with np.load(fn, allow_pickle=True) as f:
                    base += len(f[_TRIS[k]])
            A[k] = np.concatenate(out)
        else:
            A[k] = concat_blocks([{k: a} for a in arrs])[k]
        del arrs
    return A


def concat_blocks(blocks: list[dict]) -> dict:
    """Concatenate per-block array dicts (merge_parts output), shifting offsets and triangle indices."""
    if not blocks:
        return merge_parts([])
    A = {}
    for k in blocks[0]:
        arrs = [b[k] for b in blocks]
        if k in _OFFS:
            base = 0
            out = [np.zeros(1, np.int64)]
            for b in blocks:
                o = b[k]
                out.append(o[1:] + base)
                base += int(o[-1])
            A[k] = np.concatenate(out)
        elif k in _TRIS:
            base = 0
            out = []
            for b in blocks:
                out.append(b[k] + base)
                base += len(b[_TRIS[k]])
            A[k] = np.concatenate(out) if out else arrs[0]
        else:
            A[k] = np.concatenate(arrs) if arrs[0].ndim == 1 else np.vstack(arrs)
    return A


def merge_parts(parts) -> dict:
    """Concatenate block outputs into the roadnet.npz arrays (docs/ROADS.md)."""
    def items(k):
        return [x for p in parts for x in p.get(k, [])]

    def cat(lst, dt, cols=None):
        if not lst:
            return np.zeros((0, cols) if cols else 0, dt)
        return (np.vstack(lst) if cols else np.concatenate(lst)).astype(dt)

    def offs(lens):
        return np.concatenate([[0], np.cumsum(lens)]).astype(np.int64)
    A = {}
    R = items("road")
    A["road_off"] = offs([len(r["xyz"]) for r in R])
    A["road_xyz"] = cat([r["xyz"] for r in R], np.float64, 3)
    for key, dt in (("el", np.float32), ("er", np.float32), ("pl", np.float32), ("pr", np.float32), ("mk", np.uint32),
                    ("vf", np.uint8), ("sw", np.uint8), ("s", np.float32), ("lw", np.float32)):
        A[f"road_{key}"] = cat([r[key] for r in R], dt)
    A["road_ws"] = cat([r["ws"] for r in R], np.float32, 2)
    for key, dt in (("cls", np.uint8), ("flags", np.uint8), ("osm", np.float64), ("layer", np.int8), ("side", np.uint8),
                    ("lanes", np.uint8), ("width", np.float32), ("svc", np.uint8), ("sub", np.uint8), ("surf", np.uint8),
                    ("cyc", np.uint8)):
        A[f"road_{key}"] = np.array([r[key] for r in R], dt)
    A["road_name"] = np.array([r["name"] for r in R], dtype=object)
    T = items("lot")
    A["lot_off"] = offs([len(r["xyz"]) for r in T])
    A["lot_xyz"] = cat([r["xyz"] for r in T], np.float64, 3)
    A["lot_osm"] = np.array([r["osm"] for r in T], np.float64)
    A["lot_svc"] = np.array([r["svc"] for r in T], np.uint8)
    RL = items("rail")
    A["rail_off"] = offs([len(r["xyz"]) for r in RL])
    A["rail_xyz"] = cat([r["xyz"] for r in RL], np.float64, 3)
    A["rail_vf"] = cat([r["vf"] for r in RL], np.uint8)
    A["rail_s"] = cat([r["s"] for r in RL], np.float32)
    A["rail_cls"] = np.array([r["cls"] for r in RL], np.uint8)
    A["rail_flags"] = np.array([r["flags"] for r in RL], np.uint8)
    A["rail_osm_off"] = offs([len(r["osm"]) for r in RL])
    A["rail_osm"] = np.array([x for r in RL for x in r["osm"]], np.float64)
    # corridor cluster per piece (OSM id of a member way, 0 = none): tracks sharing one bed level
    A["rail_corr"] = np.array([r.get("corr", 0.0) for r in RL], np.float64)
    W = items("way")
    A["way_id"] = np.array([w["id"] for w in W], np.float64)
    A["way_off"] = offs([len(w["xyz"]) for w in W])
    A["way_xyz"] = cat([w["xyz"] for w in W], np.float64, 3)
    A["way_s"] = cat([w["s"] for w in W], np.float64)
    A["way_nF"] = np.array([w["nF"] for w in W], np.uint8)
    A["way_nB"] = np.array([w["nB"] for w in W], np.uint8)
    A["way_width"] = np.array([w["width"] for w in W], np.float32)
    A["way_flags"] = np.array([w["flags"] for w in W], np.uint8)
    A["way_node_off"] = offs([len(w["node"]) for w in W])
    A["way_node"] = cat([w["node"] for w in W], np.int64)
    A["way_node_s"] = cat([w["node_s"] for w in W], np.float64)
    J = items("jn")
    A["jn_xy"] = np.array([j["xy"] for j in J], np.float64).reshape(-1, 2)
    A["jn_osm"] = np.array([j["osm"] for j in J], np.float64)
    A["jn_cl"] = np.array([j["cl"] for j in J], np.float64)
    A["jn_flags"] = np.array([j["flags"] for j in J], np.uint8)
    A["jn_arm_off"] = offs([len(j["ang"]) for j in J])
    A["jn_arm_ang"] = cat([np.asarray(j["ang"]) for j in J], np.float32)
    A["jn_arm_r"] = cat([np.asarray(j["r"]) for j in J], np.float32)
    A["jn_arm_hw"] = cat([np.asarray(j["hw"]) for j in J], np.float32)
    A["jn_arm_flags"] = cat([np.asarray(j["af"]) for j in J], np.uint8)
    for key in ("js", "jw"):
        X = items(key)
        base = np.concatenate([[0], np.cumsum([len(x["xy"]) for x in X])]).astype(np.int64)
        A[f"{key}_xy"] = cat([x["xy"] for x in X], np.float64, 2)
        A[f"{key}_tri"] = cat([x["tri"] + base[k] for k, x in enumerate(X)], np.int64, 3)
        A[f"{key}_off"] = offs([len(x["tri"]) for x in X])
        A[f"{key}_c"] = np.array([x["c"] for x in X], np.float64).reshape(-1, 2)
    C = items("jc")
    A["jc_off"] = offs([len(c) for c in C])
    A["jc_xy"] = cat(C, np.float64, 2)
    P = items("jt")
    A["jt_xy"] = np.array([p for p, _, _ in P], np.float64).reshape(-1, 2)
    A["jt_ang"] = np.array([a for _, a, _ in P], np.float32)
    A["jt_w"] = np.array([w for _, _, w in P], np.float32)
    Q = items("sg")
    A["sg_xy"] = np.array([p for p, *_ in Q], np.float64).reshape(-1, 2)
    A["sg_ang"] = np.array([q[1] for q in Q], np.float32)
    A["sg_mast"] = np.array([q[2] for q in Q], np.float32)
    A["sg_kind"] = np.array([q[3] for q in Q], np.uint8)
    A["sg_cl"] = np.array([q[4] for q in Q], np.float64)
    M = items("md")
    A["md_off"] = offs([len(m["xyz"]) for m in M])
    A["md_xyz"] = cat([m["xyz"] for m in M], np.float64, 3)
    A["md_w"] = cat([m["w"] for m in M], np.float32)
    A["md_kind"] = np.array([m["kind"] for m in M], np.uint8)
    return A

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", default=None, help="E0,N0,E1,N1 world metres (debug)")
    ap.add_argument("--workers", type=int, default=2)
    a = ap.parse_args()
    build(tuple(map(float, a.bbox.split(","))) if a.bbox else None, workers=a.workers)
