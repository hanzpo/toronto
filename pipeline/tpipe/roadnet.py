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
from scipy.spatial import cKDTree

from . import geo
from .rail_geom import LINK_RADIUS, RAIL_RADIUS, ROAD_RADIUS, cumlen, fillet
from .terrain import get as get_terrain

# ------------------------------------------------------------------ constants

F_ONEWAY, F_BRIDGE, F_TUNNEL, F_LINK, F_ROUND = 1, 2, 4, 8, 16
F_LOT = 32     # parking aisle / driveway / drive-through: not drawn as road (parking-lot hook)
F_DUP = 64     # footway duplicating a drawn sidewalk / crossing way: not drawn

# per-vertex flags (vf)
V_BRIDGE, V_TUNNEL, V_GRADED, V_EMBED = 1, 2, 4, 8     # EMBED: rail set in pavement
V_STRUCT_SHIFT = 4                                     # bits 4-7: structure type (STRUCT)
STRUCT = {"none": 0, "girder": 1, "portal": 2, "hammerhead": 3, "truss": 4, "arch": 5, "footbridge": 6,
          "rail": 7, "box": 8, "culvert": 9, "grass": 10}

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
# vertical: clearances (Toronto ECS bridge design standard 2022; rail per Transport Canada / railway practice)
CLEAR = {"road": 5.0, "rail": 7.0, "path": 2.7, "ped_over_road": 5.3}
DECK = {"road": 1.3, "motorway": 1.9, "rail": 2.0, "path": 0.8}
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
                    events.append(dict(node=n, branch=i, bend=e, type=typ, side=1 if dd > 0 else -1))
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
                 "z", "g", "vf", "req_lo", "req_hi", "pins", "struct", "sw", "ev", "dense")

    def __init__(self):
        self.dense = False
        self.sw = None
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
        if ev["type"] == "merge":
            aux[ev["side"]].append((s0, s0 + ACC_LEN, 0.0, ACC_TAPER))
        else:
            aux[ev["side"]].append((s0 - DEC_LEN, s0, DEC_TAPER, 0.0))
    auxbp = {}
    for side, iv in aux.items():
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
                bmk[v] |= MK_GOREL if side < 0 else MK_GORER
        # main: no shoulder alongside glued + gore stretch; continuity edge along glued
        gs = ps[glued]
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
ELL = {"motorway": 90.0, "link": 55.0, "road": 55.0, "local": 40.0, "path": 12.0, "rail": 220.0, "subway": 120.0,
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


def solve_profile(S: Stroke, L: Lines, curated=None):
    """Elevation per vertex: regularised least squares on the stroke,

        min  sum w_i (z_i - t_i)^2 ds  +  sum lam_i (z'')^2 ds
        s.t. z_i >= lo_i (clearances over crossings, decks over the ground),
             z_i <= hi_i (tunnel cover), z_i = pin / curated (strong weights)

    t = ground for at-grade vertices (weight 1), free on decks (weight 0) and
    ground - cover in tunnels (weak). lam = ell^4 gives vertical curves with a
    length scale ell per class; inequalities by an active set (a few passes).
    Duplicate (zero-length) vertices share one unknown."""
    import scipy.sparse as sp
    from scipy.sparse.linalg import spsolve

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
    lo[br] = np.maximum(lo[br], gs[br] + 1.2 * kb[br] - 0.15)
    hi[tu] = np.minimum(hi[tu], g[tu] - 0.6 * cover[tu] * kt[tu] + 0.3)
    # at-grade roads never dip into the ground (4th-order solutions overshoot slightly)
    free = ~br & ~tu
    lo[free] = np.maximum(lo[free], g[free] - 0.15)
    if S.pins:
        for vi, Z in S.pins.items():
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
    HI = np.full(n, np.inf)
    np.maximum.at(LO, key, lo)
    np.minimum.at(HI, key, hi)
    EQ = {}
    for vi, Z in eq.items():
        i = int(key[vi])
        # a clearance over a crossing beats a node / corridor pin
        EQ[i] = max(Z, LO[i]) if np.isfinite(LO[i]) and LO[i] > -1e8 and (br[first[i]] or LO[i] > g[first[i]] + 1) else Z
    rows, cols, vals, rhs = [], [], [], []
    r = 0
    # data rows
    for i in range(n):
        if w[i] > 0:
            wt = math.sqrt(w[i] * ds[i])
            rows.append(r); cols.append(i); vals.append(wt); rhs.append(wt * t[i]); r += 1
    # curvature rows
    for i in range(1, n - 1):
        h1, h2 = max(su[i] - su[i - 1], 0.2), max(su[i + 1] - su[i], 0.2)
        lam = ell[i] ** 4
        wt = math.sqrt(lam * (h1 + h2) / 2)
        c0 = 2 / (h1 * (h1 + h2)); c1 = -2 / (h1 * h2); c2 = 2 / (h2 * (h1 + h2))
        rows += [r, r, r]; cols += [i - 1, i, i + 1]; vals += [wt * c0, wt * c1, wt * c2]; rhs.append(0.0); r += 1
    # slope rows (tension): no runaway linear extrapolation across free decks
    for i in range(n - 1):
        h = max(su[i + 1] - su[i], 0.2)
        mu = ell[i] ** 2 * 0.25
        wt = math.sqrt(mu / h)
        rows += [r, r]; cols += [i, i + 1]; vals += [-wt, wt]; rhs.append(0.0); r += 1
    # weak anchor so fully free strokes (all deck) stay determined
    rows.append(r); cols.append(0); vals.append(1e-3); rhs.append(1e-3 * g[first[0]]); r += 1
    base_r = r
    A0 = sp.csr_matrix((vals, (rows, cols)), shape=(r, n))
    b0 = np.array(rhs)
    BIG = 3e3
    active = dict(EQ)
    z = None
    for it in range(8):
        er, ec, ev, eb = [], [], [], []
        for k_, (i, Z) in enumerate(active.items()):
            wt = BIG * math.sqrt(ds[i])
            er.append(k_); ec.append(i); ev.append(wt); eb.append(wt * Z)
        if er:
            A = sp.vstack([A0, sp.csr_matrix((ev, (er, ec)), shape=(len(er), n))]).tocsr()
            b = np.concatenate([b0, eb])
        else:
            A, b = A0, b0
        AtA = (A.T @ A).tocsc()
        z = spsolve(AtA, A.T @ b)
        viol = False
        for i in np.nonzero(z < LO - 0.05)[0]:
            if i not in EQ:
                active[int(i)] = LO[i]
                viol = True
        for i in np.nonzero(z > HI + 0.05)[0]:
            if i not in EQ and not (LO[i] > HI[i]):
                active[int(i)] = HI[i]
                viol = True
        if not viol:
            break
    z = z[key]
    # final grade limiter: halfway between the lower and upper G-Lipschitz envelopes removes
    # cliffs left where constraints conflict (e.g. two pins a few metres apart)
    ghard = np.array([_ghard(L, ws[k]) for k in S.vway])
    d_ = np.diff(z)
    h_ = np.maximum(np.diff(s), 1e-3)
    if n0 > 2 and (np.abs(d_) > 2 * ghard[1:] * h_ + 0.05).any():
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


def find_crossings(L: Lines, strokes: list[Stroke], way_stroke, report):
    """Every intersection of road/rail centrelines that is not a shared node.
    Returns list of dict(a=way, b=way, p=(x, y))."""
    t0 = time.time()
    cand = np.nonzero(((L.kind == 0) & ((L.flags & (F_LOT | F_DUP)) == 0) & (L.cls != 9)) | (L.kind == 1))[0]
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
    print(f"  crossings: {len(out):,} from {len(ia):,} pairs ({time.time() - t0:.0f}s)", flush=True)
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
        if ta != tb:
            up = b if ta else a
        elif ba != bb:
            up = a if ba else b
        elif la != lb:
            up = a if la > lb else b
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


def load_curated():
    p = geo.PIPE / "curated" / "corridors.json"
    if not p.exists():
        return []
    return json.loads(p.read_text())["corridors"]


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
        for si, S in enumerate(strokes):
            if S.kind != 0 or S.cls > cls_max:
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
    vway = S.vway[src]
    vway[oldpos] = S.vway
    if S.attrs is not None:
        A = {}
        for key, v in S.attrs.items():
            if key == "mk":
                a = v[src].copy()
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
        sw = S.sw[src].copy()
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


def main(bbox=None):
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
    global nF_glob, nB_glob
    nF_glob, nB_glob = nF, nB
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
        S.s = cumlen(Q)
        # source way per new vertex: from the vertex map
        vw = np.zeros(len(Q), np.int64)
        vw[vmap] = VW
        mapped = np.zeros(len(Q), bool)
        mapped[vmap] = True
        idx = np.maximum.accumulate(np.where(mapped, np.arange(len(Q)), 0))
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
    print(f"filleted ({time.time() - t0:.0f}s, {memguard('fillet'):.1f} GB)", flush=True)

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
    print(f"lateral profiles + {report['merges_built']} merges ({time.time() - t0:.0f}s, {memguard('lateral'):.1f} GB)", flush=True)

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
    X = find_crossings(L, strokes, way_stroke, report)
    ups = decide_levels(L, X, make_dsm_sampler(terr), report)
    geoms = {}

    def sloc(si, p):
        g = geoms.get(si)
        if g is None:
            g = geoms[si] = shapely.linestrings(strokes[si].xy)
        return float(shapely.line_locate_point(g, shapely.points(p)))

    keep = []
    for u in ups:
        # a line in a tunnel below needs no structure above it (cover is solved per tunnel);
        # two lines both in tunnels are not our business either
        if (L.flags[u["lo"]] & F_TUNNEL) or (L.flags[u["up"]] & F_TUNNEL):
            continue
        keep.append(u)
    report["crossings_over_tunnels_skipped"] = len(ups) - len(keep)
    ups = keep
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
        # always a structure over the whole width of the lower line (OSM bridge ways often stop short)
        st = STRUCT["rail"] if U.kind == 1 else STRUCT["footbridge"] if U.cls >= 7 else STRUCT["girder"]
        U.vf[m] |= V_BRIDGE | (st << V_STRUCT_SHIFT) * ((U.vf[m] >> V_STRUCT_SHIFT) == 0)
    report["structures_inferred"] = sum(1 for u in ups if u["how"] != "tags")
    curated = curated_targets(load_curated(), strokes, L, terr, report)

    # ---- iterate: crossing requirements -> profiles -> node consistency
    need = set(i for i, S in enumerate(strokes) if (S.vf & (V_BRIDGE | V_TUNNEL)).any())
    need |= set(curated.keys())
    for u in ups:
        need.add(u["iu"])
    for S in strokes:
        S.z = S.g.copy()
        S.pins = {}
    for it in range(8):
        for S in strokes:
            S.req_lo = []
        for u in ups:
            U, Lo = strokes[u["iu"]], strokes[u["il"]]
            zl = float(np.interp(u["sl"], Lo.s, Lo.z))
            ku, kl = _kind_name(L, u["up"]), _kind_name(L, u["lo"])
            clr = CLEAR["rail"] if kl == "rail" else CLEAR["path"] if kl == "path" else (
                CLEAR["ped_over_road"] if ku == "path" else CLEAR["road"])
            deck = DECK["rail"] if ku == "rail" else DECK["path"] if ku == "path" else (
                DECK["motorway"] if L.cls[u["up"]] <= 1 else DECK["road"])
            U.req_lo.append((u["su"], zl + clr + deck, max(u["hl"] - 1.0, 3.0)))
        for si in sorted(need):
            S = strokes[si]
            if not getattr(S, "dense", False):
                _densify_solve(S, terr, curated, si)
            solve_profile(S, L, curated.get(si))
        if DEBUG_PINS:
            worst = max(((float(np.max(np.abs(strokes[si].z - strokes[si].g))), si) for si in need), default=(0, -1))
            print("   worst dev", worst, [int(L.id[i]) for i, _ in strokes[worst[1]].ways[:3]] if worst[1] >= 0 else None)
        changed = 0
        for n, lst in node_pos.items():
            if len(lst) < 2:
                continue
            zs = []
            for si, _v in lst:
                S = strokes[si]
                k = min(int(np.searchsorted(S.s, S.node_s[n] - 1e-6)), len(S.s) - 1)
                zs.append((si, k, float(S.z[k]), float(S.z[k] - S.g[k])))
            # paths agree among themselves (footbridge + its stairs) but neither pull nor follow roads
            paths = [x for x in zs if strokes[x[0]].kind == 0 and strokes[x[0]].cls >= 7]
            zs = paths if len(paths) >= 2 and len(paths) == len(zs) else [x for x in zs if x not in paths]
            if len(zs) < 2:
                continue
            rails = [x for x in zs if strokes[x[0]].kind == 1]
            if rails and len(rails) < len(zs):
                # level crossing: the track keeps its profile, the road meets it
                Zr = float(np.mean([z for _, _, z, _ in rails]))
                for si, k, z, d in zs:
                    old = strokes[si].pins.get(k)
                    if strokes[si].kind == 0 and abs(z - Zr) > 0.05 and (old is None or abs(old - Zr) > 0.1):
                        strokes[si].pins[k] = Zr
                        need.add(si)
                        changed += 1
                continue
            dev = [d for *_, d in zs]
            if max(dev) - min(dev) < 0.25:
                continue
            if it < 2:
                Z = max(z for _, _, z, _ in zs) if max(dev) >= 0.3 else min(z for _, _, z, _ in zs)
            else:  # later passes average (the max rule can ratchet two decks up against each other)
                Z = float(np.mean([z for _, _, z, _ in zs]))
            for si, k, z, d in zs:
                old = strokes[si].pins.get(k)
                if DEBUG_PINS and it >= 5 and abs(z - Z) > 0.05 and (old is None or abs(old - Z) > 0.1):
                    print("   pin", n, si, k, len(strokes[si].s), round(z, 2), round(Z, 2), old,
                          [(a_, k_, round(b_, 2), round(d_, 2)) for a_, k_, b_, d_ in zs])
                if abs(z - Z) > 0.05 and (old is None or abs(old - Z) > (0.1 if it < 2 else 0.3)):
                    strokes[si].pins[k] = Z
                    need.add(si)
                    changed += 1
        print(f"  solve pass {it}: {len(need):,} strokes, {changed:,} node pins ({time.time() - t0:.0f}s, "
              f"{memguard('solve'):.1f} GB)", flush=True)
        if not changed:
            break
    for S in strokes:
        if S.kind == 0 and S.cls >= 7 and S.attrs is not None:
            m = (S.vf & V_BRIDGE) != 0
            for k in ("eL", "eR", "pL", "pR"):
                S.attrs[k][m] = np.maximum(S.attrs[k][m], 1.4)
        dz = np.abs(S.z - S.g)
        S.vf[dz > 0.15] |= V_GRADED
        S.vf[(S.vf & (V_BRIDGE | V_TUNNEL)) != 0] |= V_GRADED
    return L, strokes, report, ups, ev_full, curated, t0



# ------------------------------------------------------------------ sidewalks, boulevards, pavers

SW_L, SW_R, BLVD_L, BLVD_R, PAVERS = 1, 2, 4, 8, 16
SIDE_TAG = {2: SW_L, 3: SW_R, 4: SW_L | SW_R}


def building_density():
    """KD-tree over building footprints (first vertex) + kind flags: house-like / commercial."""
    with np.load(geo.WORK / "osm_buildings.npz", allow_pickle=True) as f:
        xy, ringlen, nring, kind = f["xy"], f["ringlen"], f["nring"], f["kind"]
    ro = np.concatenate([[0], np.cumsum(ringlen.astype(np.int64))])
    po = np.concatenate([[0], np.cumsum(nring.astype(np.int64))])
    first = xy[ro[po[:-1]]]
    house = np.isin(kind, [1, 11])            # houses, garages / sheds
    comm = np.isin(kind, [3, 4, 13])           # office / retail / hotel
    return cKDTree(first), house, comm


def sidewalks(L: Lines, strokes: list[Stroke], report):
    """Per-vertex sidewalk bits for streets (classes 2-5, not links / tunnels):
    OSM sidewalk tags, else both sides where the street is built up. Bridges keep
    their sidewalks (a deck sidewalk behind the parapet)."""
    tree, house, comm = building_density()
    cnt = defaultdict(int)
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
            dens = np.array([len(x) for x in near])
            built = (dens >= 3).sum() >= 2
            allb = np.unique(np.concatenate([np.asarray(x, np.int64) for x in near])) if dens.sum() else np.zeros(0, np.int64)
            fh = house[allb].mean() if len(allb) else 0.0
            fc = comm[allb].mean() if len(allb) else 0.0
            side = int(L.side[i])
            rev = S.ways[k][1]
            bits = 0
            if side in SIDE_TAG:
                bits = SIDE_TAG[side]
                if rev and side in (2, 3):
                    bits = SW_L if bits == SW_R else SW_R
            elif side in (0, 5) and built:
                bits = SW_L | SW_R
            if bits:
                if fc >= 0.3 and L.cls[i] <= 4:
                    bits |= PAVERS
                elif fh >= 0.5 and L.cls[i] >= 3:
                    # suburban street: grass boulevard between curb and walk
                    bits |= (BLVD_L if bits & SW_L else 0) | (BLVD_R if bits & SW_R else 0)
                cnt["streets"] += 1
            S.sw[m] = bits
    report["sidewalk_streets"] = dict(cnt)


# ------------------------------------------------------------------ junction clusters


CLUSTER_D = 32.0     # junction nodes joined by a road piece shorter than this form one intersection


def junction_clusters(L: Lines, strokes: list[Stroke], inc_of, report):
    """Logical intersections: at-grade junction nodes of streets (>= 3 arms, classes <= 6,
    at least two non-link street arms), clustered across dual carriageways / median
    right-of-ways. Per member node the arm radii put every approach's crosswalk and
    stop bar on one line across the whole cross-section."""
    nodes = np.load(geo.WORK / "osm_nodes.npz")
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
                    if m2 in memset and m2 != n and 0 < d * (sv - S.s[k]) < CLUSTER_D + 1:
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
        js = closed.intersection(clip)
        if js.is_empty or js.area < 4:
            continue
        # median gaps inside the box are paved (the cross street runs through)
        js = shapely.make_valid(js)
        surf.append((ci, js))
        if swstrips:
            sw = shapely.union_all([x for x in swstrips if x is not None]).buffer(rc * 0.6, quad_segs=4).buffer(-rc * 0.6, quad_segs=4)
            cw = sw.difference(closed).intersection(clip)
            cw = shapely.make_valid(cw)
            if not cw.is_empty and cw.area > 1:
                walks.append((ci, cw))
                cl = closed.boundary.intersection(clip).intersection(cw.buffer(0.3))
                if not cl.is_empty:
                    curbs.append((ci, cl))
        # tactile pads + signal poles at each leg's crosswalk ends
        for g_ in C["legs"]:
            a = g_["dir"]
            nrm = np.array([-a[1], a[0]])
            lo, hi = g_["lat"]
            R = g_["R"]
            mid = R + 1.9
            for e, sgn in ((hi, 1), (lo, -1)):
                p = c + a * mid + nrm * (e + sgn * 0.45)
                if C["sig"] or any(r["sw"] for r in g_["arms"]):
                    pads.append((ci, p, math.atan2(nrm[1], nrm[0]) * 1.0 + (0 if sgn > 0 else math.pi), 3.0))
            if C["sig"]:
                # far-right corner pole for traffic approaching along -a (from this leg into the box):
                # approach travels along -a; its right is -nrm... poles stand on the far side of the box
                # handled per approach: pole behind the stop line on the right, mast over the approach
                pass
        if C["sig"]:
            for g_ in C["legs"]:
                a = g_["dir"]
                nrm = np.array([-a[1], a[0]])
                lo, hi = g_["lat"]
                # the approach (inbound) half is on the right of inbound travel (-a): right of -a is +nrm
                # far side: pole at the opposite leg's crosswalk, right side of travel
                opp = min(C["legs"], key=lambda h: math.cos(h["ang"] - g_["ang"]))
                if opp is not g_ and math.cos(opp["ang"] - g_["ang"]) < -0.7:
                    far = opp["R"] + 2.2
                else:  # T-junction stem: the far curb of the cross street
                    far = max(max(r["hw"] for r in h["arms"]) for h in C["legs"] if h is not g_) + 2.5
                # travel direction -a; beyond the box = -a * far; right of travel = +nrm... (for travel t=-a, right = (t_y, -t_x) = (-a_y, a_x) = nrm)
                ext = hi if hi > 0 else abs(lo)
                p_far = c - a * far + nrm * (max(hi, 2.5) + 1.0)
                mast = float(np.clip(max(hi, 2.5) * 0.9, 2.5, 11.0))
                poles.append((ci, p_far, g_["ang"], mast, 0))
                # near-side pole (Toronto: signal on the near right corner too) with a short arm
                p_near = c + a * (g_["R"] + 4.0) + nrm * (max(hi, 2.5) + 1.0)
                poles.append((ci, p_near, g_["ang"], 1.2, 1))
                # median pole for dual carriageways with a median wider than 2 m
                inner = [r for r in g_["arms"]]
                if len(inner) >= 2:
                    offs = sorted(float(np.dot(r["p"] - c, nrm)) for r in inner)
                    gap_mid = (offs[0] + offs[-1]) / 2
                    p_med = c + a * (g_["R"] + 1.0) + nrm * gap_mid
                    poles.append((ci, p_med, g_["ang"], 1.2, 2))
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
    for S in strokes:
        if S.kind == 0 and S.group == 0 and S.cls <= 6:
            road_pts.append(S.xy)
            road_hw.append(np.maximum(S.attrs["pL"], S.attrs["pR"]))
    rp = np.vstack(road_pts) if road_pts else np.zeros((0, 2))
    rh = np.concatenate(road_hw) if road_hw else np.zeros(0)
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
                for j in tree.query_ball_point(S.xy[k], 25.0):
                    if np.hypot(*(rp[j] - S.xy[k])) < rh[j] + 1.0:
                        m[k] = True
                        break
        if ptree is not None:
            hit = ptree.query(shapely.points(S.xy), predicate="within")
            m[hit[0]] = True
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


def build(bbox=None, out_path=None):
    L, strokes, report, ups, evs, curated, t0 = main(bbox)
    sidewalks(L, strokes, report)
    inc_of = {}
    nid = L.nid
    w = np.full(len(nid), 2, np.int64)
    w[L.off[:-1]] = 1
    w[L.off[1:] - 1] = 1
    uq, inv = np.unique(nid, return_inverse=True)
    inc_of = dict(zip(uq.tolist(), np.bincount(inv, weights=w).astype(np.int64).tolist()))
    clusters, jrec = junction_clusters(L, strokes, inc_of, report)
    surf, walks, curbs, pads, poles = junction_surfaces(clusters, strokes, report)
    med = medians(L, strokes, clusters, report)
    embed_rail(strokes, surf, report)
    grass_track(strokes, med, report)
    print(f"street detail ({time.time() - t0:.0f}s, {memguard('detail'):.1f} GB)", flush=True)
    A = {}
    # ---- road pieces (render): strokes split at class changes; hidden groups separately
    R = dict(off=[0], xyz=[], el=[], er=[], pl=[], pr=[], mk=[], vf=[], sw=[], s=[], lw=[],
             cls=[], flags=[], osm=[], name=[], layer=[], side=[], lanes=[], width=[], svc=[], sub=[], surf=[], cyc=[])
    LOT = dict(off=[0], xyz=[], osm=[], svc=[])
    RL = dict(off=[0], xyz=[], vf=[], cls=[], flags=[], osm_off=[0], osm=[])
    W = dict(id=[], off=[0], xyz=[], s=[], nF=[], nB=[], width=[], flags=[], node_off=[0], node=[], node_s=[])
    for si, S in enumerate(strokes):
        z = S.z if S.z is not None else S.g
        ws = [i for i, _ in S.ways]
        if S.kind == 1:
            RL["xyz"].append(np.column_stack([S.xy, z]))
            RL["vf"].append(S.vf)
            RL["off"].append(RL["off"][-1] + len(S.s))
            RL["cls"].append(S.cls if S.cls != 1 else int(L.cls[ws[0]]))
            RL["flags"].append(int(np.bitwise_or.reduce(L.flags[ws])))
            RL["osm"] += [float(L.id[i]) for i in ws]
            RL["osm_off"].append(len(RL["osm"]))
            continue
        if S.group == 2:
            LOT["xyz"].append(np.column_stack([S.xy, z]))
            LOT["off"].append(LOT["off"][-1] + len(S.s))
            LOT["osm"].append(float(L.id[ws[0]]))
            LOT["svc"].append(int(L.svc[ws[0]]))
        if S.group in (0, 1):
            wc = np.array([int(L.cls[ws[k]]) for k in S.vway])
            # split at class changes and where a structure (bridge / tunnel) starts or ends, so
            # per-piece class / flags stay meaningful (share the boundary vertex)
            key = wc * 4 + (S.vf & (V_BRIDGE | V_TUNNEL))
            cuts = [0] + [k for k in range(1, len(wc)) if key[k] != key[k - 1]] + [len(wc)]
            for a, b in zip(cuts[:-1], cuts[1:]):
                a0 = max(a - 1, 0) if a > 0 else 0
                sl = slice(a0, b)
                if b - a0 < 2:
                    continue
                i0 = ws[S.vway[a]]
                R["xyz"].append(np.column_stack([S.xy[sl], z[sl]]))
                for key in ("el", "er", "pl", "pr", "mk", "lw"):
                    src = {"el": "eL", "er": "eR", "pl": "pL", "pr": "pR"}.get(key, key)
                    R[key].append(S.attrs[src][sl])
                R["vf"].append(S.vf[sl])
                R["sw"].append(S.sw[sl] if S.sw is not None else np.zeros(b - a0, np.int64))
                R["s"].append(S.s[sl])
                R["off"].append(R["off"][-1] + (b - a0))
                wsel = sorted(set(ws[k] for k in S.vway[sl]))
                fl = int(np.bitwise_or.reduce(L.flags[wsel])) & ~(F_BRIDGE | F_TUNNEL)
                inner = S.vf[a:b]
                if (inner & V_BRIDGE).all():
                    fl |= F_BRIDGE
                if (inner & V_TUNNEL).all():
                    fl |= F_TUNNEL
                R["cls"].append(int(L.cls[i0]))
                R["flags"].append(fl & 0xFF)
                R["osm"].append(float(L.id[i0]))
                R["name"].append(str(L.name[i0]))
                R["layer"].append(int(L.layer[i0]))
                R["side"].append(int(L.side[i0]))
                mkp = S.attrs["mk"][a:b]
                R["lanes"].append(int(np.median((mkp & 15) + ((mkp >> 4) & 15))))
                R["width"].append(float(np.median(S.attrs["pL"][a:b] + S.attrs["pR"][a:b])))
                R["svc"].append(int(L.svc[i0]))
                R["sub"].append(int(L.sub[i0]))
                R["surf"].append(int(L.surf[i0]))
                R["cyc"].append(int(L.cyc[i0]))
        # ---- per-way geometry for the traffic graph (drivable)
        if S.group == 0 or S.group == 2:
            for k, (i, rev) in enumerate(S.ways):
                idx = np.nonzero(S.vway == k)[0]
                if not len(idx):
                    continue
                a0 = idx[0] - 1 if k > 0 else idx[0]
                sl = np.arange(max(a0, 0), idx[-1] + 1)
                xyz = np.column_stack([S.xy[sl], z[sl]])
                ss = S.s[sl] - S.s[sl[0]]
                ns = L.nids(i)
                nss = np.array([S.node_s.get(int(n), np.nan) for n in ns]) - S.s[sl[0]]
                if rev:
                    xyz = xyz[::-1]
                    ss = ss[-1] - ss[::-1]
                    nss = (S.s[sl[-1]] - S.s[sl[0]]) - nss
                mid = sl[len(sl) // 2]
                W["id"].append(float(L.id[i]))
                W["xyz"].append(xyz)
                W["s"].append(ss)
                W["off"].append(W["off"][-1] + len(sl))
                W["nF"].append(int(nF_glob[i]))
                W["nB"].append(int(nB_glob[i]))
                W["width"].append(float(S.attrs["pL"][mid] + S.attrs["pR"][mid]))
                fl = int(L.flags[i])
                if (S.vf[sl] & V_BRIDGE).any():
                    fl |= F_BRIDGE
                W["flags"].append(fl)
                W["node"].append(ns.astype(np.int64))
                W["node_s"].append(nss)
                W["node_off"].append(W["node_off"][-1] + len(ns))

    def cat(lst, dt, cols=None):
        if not lst:
            return np.zeros((0, cols) if cols else 0, dt)
        return np.concatenate(lst).astype(dt) if cols is None else np.vstack(lst).astype(dt)
    A["road_off"] = np.array(R["off"], np.int64)
    A["road_xyz"] = cat(R["xyz"], np.float64, 3)
    for key, dt in (("el", np.float32), ("er", np.float32), ("pl", np.float32), ("pr", np.float32), ("mk", np.uint32),
                    ("vf", np.uint8), ("sw", np.uint8), ("s", np.float32), ("lw", np.float32)):
        A[f"road_{key}"] = cat(R[key], dt)
    for key, dt in (("cls", np.uint8), ("flags", np.uint8), ("osm", np.float64), ("layer", np.int8), ("side", np.uint8),
                    ("lanes", np.uint8), ("width", np.float32), ("svc", np.uint8), ("sub", np.uint8), ("surf", np.uint8),
                    ("cyc", np.uint8)):
        A[f"road_{key}"] = np.array(R[key], dt)
    A["road_name"] = np.array(R["name"], dtype=object)
    A["lot_off"] = np.array(LOT["off"], np.int64)
    A["lot_xyz"] = cat(LOT["xyz"], np.float64, 3)
    A["lot_osm"] = np.array(LOT["osm"], np.float64)
    A["lot_svc"] = np.array(LOT["svc"], np.uint8)
    A["rail_off"] = np.array(RL["off"], np.int64)
    A["rail_xyz"] = cat(RL["xyz"], np.float64, 3)
    A["rail_vf"] = cat(RL["vf"], np.uint8)
    A["rail_cls"] = np.array(RL["cls"], np.uint8)
    A["rail_flags"] = np.array(RL["flags"], np.uint8)
    A["rail_osm_off"] = np.array(RL["osm_off"], np.int64)
    A["rail_osm"] = np.array(RL["osm"], np.float64)
    A["way_id"] = np.array(W["id"], np.float64)
    A["way_off"] = np.array(W["off"], np.int64)
    A["way_xyz"] = cat(W["xyz"], np.float64, 3)
    A["way_s"] = cat(W["s"], np.float64)
    A["way_nF"] = np.array(W["nF"], np.uint8)
    A["way_nB"] = np.array(W["nB"], np.uint8)
    A["way_width"] = np.array(W["width"], np.float32)
    A["way_flags"] = np.array(W["flags"], np.uint8)
    A["way_node_off"] = np.array(W["node_off"], np.int64)
    A["way_node"] = cat(W["node"], np.int64)
    A["way_node_s"] = cat(W["node_s"], np.float64)
    # ---- junctions (member-node records)
    A["jn_xy"] = np.array(jrec["xy"], np.float64).reshape(-1, 2)
    A["jn_osm"] = np.array(jrec["osm"], np.float64)
    A["jn_cl"] = np.array(jrec["cl"], np.float64)
    A["jn_flags"] = np.array(jrec["flags"], np.uint8)
    A["jn_arm_off"] = np.array(jrec["arm_off"], np.int64)
    A["jn_arm_ang"] = np.array(jrec["arm_ang"], np.float32)
    A["jn_arm_r"] = np.array(jrec["arm_r"], np.float32)
    A["jn_arm_hw"] = np.array(jrec["arm_hw"], np.float32)
    A["jn_arm_flags"] = np.array(jrec["arm_flags"], np.uint8)
    # ---- junction surfaces / corner sidewalks (triangles, z from ground at the centre)
    for key, lst in (("js", surf), ("jw", walks)):
        xs, ts, off, cx, cz = [], [], [0], [], []
        base = 0
        for ci, g in lst:
            v, t = _tri(g)
            if not len(t):
                continue
            xs.append(v)
            ts.append(t + base)
            base += len(v)
            off.append(off[-1] + len(t))
            cx.append(clusters[ci]["c"])
        A[f"{key}_xy"] = cat(xs, np.float64, 2)
        A[f"{key}_tri"] = cat(ts, np.int64, 3)
        A[f"{key}_off"] = np.array(off, np.int64)
        A[f"{key}_c"] = np.array(cx, np.float64).reshape(-1, 2)
    cl_xy, cl_off = [], [0]
    for ci, g in curbs:
        for part in shapely.get_parts(shapely.line_merge(shapely.union_all([g]).boundary if g.geom_type.endswith("Polygon") else g)):
            if part.geom_type != "LineString" or part.length < 0.5:
                continue
            q = np.asarray(part.coords)
            cl_xy.append(q)
            cl_off.append(cl_off[-1] + len(q))
    A["jc_xy"] = cat(cl_xy, np.float64, 2)
    A["jc_off"] = np.array(cl_off, np.int64)
    A["jt_xy"] = np.array([p for _, p, _, _ in pads], np.float64).reshape(-1, 2)
    A["jt_ang"] = np.array([a for _, _, a, _ in pads], np.float32)
    A["jt_w"] = np.array([w for *_, w in pads], np.float32)
    A["sg_xy"] = np.array([p for _, p, *_ in poles], np.float64).reshape(-1, 2)
    A["sg_ang"] = np.array([a for _, _, a, _, _ in poles], np.float32)
    A["sg_mast"] = np.array([m for _, _, _, m, _ in poles], np.float32)
    A["sg_kind"] = np.array([k for *_, k in poles], np.uint8)
    A["sg_cl"] = np.array([clusters[ci]["root"] for ci, *_ in poles], np.float64)
    # ---- medians
    m_off, m_xyz, m_w, m_k = [0], [], [], []
    for run in med:
        m_xyz.append(np.array([[p[0], p[1], z] for p, _, _, z in run]))
        m_w.append(np.array([g for _, g, _, _ in run]))
        m_k.append(int(np.bincount([k for _, _, k, _ in run]).argmax()))
        m_off.append(m_off[-1] + len(run))
    A["md_off"] = np.array(m_off, np.int64)
    A["md_xyz"] = cat(m_xyz, np.float64, 3)
    A["md_w"] = cat(m_w, np.float32)
    A["md_kind"] = np.array(m_k, np.uint8)
    path = out_path or (geo.WORK / "roadnet.npz")
    np.savez(path, **A)
    rep = {k: v for k, v in report.items()}
    (geo.WORK / "roadnet_report.json").write_text(json.dumps(rep, indent=1, default=str))
    print(f"wrote {path} ({time.time() - t0:.0f}s): {len(A['road_off']) - 1:,} road pieces, "
          f"{len(A['rail_off']) - 1:,} rail strokes, {len(A['jn_osm']):,} junction nodes, "
          f"{len(A['js_off']) - 1:,} surfaces, {len(A['md_off']) - 1:,} medians", flush=True)
    return A


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", default=None)
    a = ap.parse_args()
    build(tuple(map(float, a.bbox.split(","))) if a.bbox else None)
