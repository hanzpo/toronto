"""Primitive network (docs/NETWORK.md): reality mapped onto engine primitives, for a bbox.

    TPIPE_WORK=... uv run python -m tpipe.primnet --bbox=-1700,-1100,-600,-100 [--out DIR]

Input: the network model (tpipe.roadnet: work/roadnet.npz -- the single source of truth for
plan and z, with the curated overrides already applied), OSM tags (osm_lines.npz), curated
cross-sections (curated/cross_sections.json), GTFS stops (data/transit), level crossings and
underpasses (roadnet side outputs).

Steps (docs/NETWORK.md layer 2):
  1. graph cleanup: model ways -> edges between nodes; junction clusters are single nodes;
     chains through plain degree-2 nodes merged; divided pairs joined (curated 'pair').
  2. asset selection per edge: curated cross-section > OSM tags (TAG_TABLE) > class defaults.
  3. curves: the model's smoothed centrelines (rail_geom.fillet), resampled every 2 m.
  4. vertical: the model's solved z.
  5. interactions (docs/INTERACTIONS.md): every meeting classified (junction, continuation,
     end, embedded_track, special_work, level_crossing, underpass, stop/platform) with the
     outcome generate / snap / review; review items go to review_queue.json.
  6. nodes: legs with setbacks, box corners, curb-return radii by design vehicle,
     perpendicular crosswalks, stop bars, ROW noses, signal poles, special work.
  7. lanes and paths: lane lines per lane band with vehicle classes, turning paths per
     movement, streetcar paths through special work, the pedestrian mesh.

Output (OUT/net2/): primnet.json (assets, edges, nodes, lanes, paths, interactions),
interactions_report.json, review_queue.json.
"""
from __future__ import annotations

import argparse
import json
import math
import time
from collections import defaultdict

import numpy as np
from scipy.spatial import cKDTree

from . import geo
from .rail_geom import cumlen

# ------------------------------------------------------------------ tag mapping table
# Every OSM tag the slice reads, and its defined effect on the primitives (docs/INTERACTIONS.md
# "Tag modelling rules"). Tags arrive through the network model (tpipe.roadnet) unless noted.
TAG_TABLE = [
    ("highway=motorway|trunk|primary|secondary|tertiary|residential|service|...", "road class -> asset family, "
     "default lane width (3.5 / 3.3 / 3.0 m), curb-return radius by design vehicle (arterial 12 m, local 7 m)"),
    ("oneway=yes / -1", "one-way asset: all lanes in the edge direction; a same-name opposite pair within 30 m "
     "may be joined into one divided edge (curated 'pair')"),
    ("lanes, lanes:forward, lanes:backward (model nF / nB)", "number of lane bands per direction"),
    ("turn:lanes*", "movements per lane at the node (left lane: left + through, right lane: right + through; "
     "absent: defaults by position)"),
    ("highway=service (+ service=alley)", "shared two-way pavement: 2 x 2.5 m (alley 2 x 2.0 m: Toronto "
     "public laneways are 3.6 - 5 m of pavement), no sidewalks unless tagged"),
    ("width / est_width", "used by the model's lane-width sanity only (lane bands keep asset widths)"),
    ("sidewalk=both|left|right|separate|no (model sw bits)", "sidewalk band (+ furniture band on commercial "
     "streets, boulevard on residential) on that side; 'separate' mapped footways are hidden duplicates"),
    ("cycleway*, cycleway:left/right", "bike_lane band next to the curb on that side"),
    ("parking:*", "parking band (curated streets only in the slice)"),
    ("railway=tram (+ embedded / on a road centreline)", "tram in mixed traffic: the tram track rides in the "
     "inner lane band (classes + tram); a separate tram way beside the road: transit_row band"),
    ("railway=tram in a node box", "streetcar special work: flush embedded grooved rails following the model's "
     "tram geometry (radius >= 11 m checked; tighter -> review)"),
    ("railway=level_crossing / crossing (shared node)", "level-crossing interaction (crossings.json)"),
    ("bridge / tunnel / covered / layer (model vf)", "variant of the asset; separation from the vertical solve"),
    ("highway=traffic_signals (model junction flag)", "signalized node: signal poles on corners and noses"),
    ("footway=crossing / crossing=*", "crosswalk event (junction legs always get one per leg)"),
    ("public_transport=platform / GTFS stop", "platform band in a transit_row at the stop (curated streets)"),
]

DEFAULTS = {"lane_w": {0: 3.6, 1: 3.6, 2: 3.3, 3: 3.3, 4: 3.2, 5: 3.0, 6: 3.0},
            "lane_w_alley": 2.0, "lane_w_service": 2.5,
            "sidewalk_w": 2.0, "furniture_w": 1.0, "curb_w": 0.15, "curb_h": 0.15}
SNAP_TOL = 1.0         # m: auto-snap only below this (docs/INTERACTIONS.md "Auto-snap vs manual review")
REF = {
    "ortho": "https://gis.toronto.ca/arcgis/rest/services/basemap/cot_ortho/MapServer/export?bbox={bbox}&bboxSR=4326&size=512,512&format=png&f=image",
    "dtm": "https://ws.geoservices.lrc.gov.on.ca/arcgis5/rest/services/Elevation/Ontario_DTM_LidarDerived/ImageServer/exportImage?bbox={bbox}&bboxSR=4326&size=256,256&format=tiff&f=image",
    "dsm": "https://ws.geoservices.lrc.gov.on.ca/arcgis5/rest/services/Elevation/Ontario_DSM_LidarDerived/ImageServer/exportImage?bbox={bbox}&bboxSR=4326&size=256,256&format=tiff&f=image",
}


def _ll_bbox(x, y, r=40.0):
    from pyproj import Transformer
    inv = Transformer.from_proj(geo.PROJ, "EPSG:4326", always_xy=True)
    a = inv.transform(x - r, y - r)
    b = inv.transform(x + r, y + r)
    return f"{a[0]:.6f},{a[1]:.6f},{b[0]:.6f},{b[1]:.6f}"


def refs(x, y):
    bb = _ll_bbox(x, y)
    return {k: v.format(bbox=bb) for k, v in REF.items()} | {"thumbnail": REF["ortho"].format(bbox=bb)}


def resample(P: np.ndarray, step=2.0) -> np.ndarray:
    s = cumlen(P[:, :2])
    if s[-1] < 1e-6:
        return P[:1]
    t = np.linspace(0, s[-1], max(2, int(math.ceil(s[-1] / step)) + 1))
    return np.stack([np.interp(t, s, P[:, k]) for k in range(P.shape[1])], 1)


def normals(P):
    if len(P) < 2:
        return np.array([[1.0, 0.0]] * len(P)), np.array([[0.0, 1.0]] * len(P))
    t = np.gradient(P[:, :2], axis=0)
    t /= np.maximum(np.hypot(t[:, 0], t[:, 1]), 1e-9)[:, None]
    return t, np.stack([-t[:, 1], t[:, 0]], 1)


# ------------------------------------------------------------------ assets
def band_offsets(bands):
    """left edge offset of every band (m, + left of the edge direction) with the centre at the
    middle of the carriageway (between the outermost curbs)."""
    w = [b["w"] for b in bands]
    curbs = [i for i, b in enumerate(bands) if b["kind"] == "curb"]
    tot = sum(w)
    if len(curbs) >= 2:
        a = sum(w[:curbs[0]])
        c = sum(w[:curbs[-1] + 1])
        # a divided pair's flush median half sits inside the curbs but is not part of the carriageway
        # the centreline runs along (band "centre_skip")
        lanes = [i for i, b in enumerate(bands) if b["kind"] == "lane"]
        if lanes:
            a += sum(w[i] for i in range(curbs[0], lanes[0]) if bands[i].get("centre_skip"))
            c -= sum(w[i] for i in range(lanes[-1] + 1, curbs[-1] + 1) if bands[i].get("centre_skip"))
        mid = (a + c) / 2
    else:
        mid = tot / 2
    left = []
    acc = 0.0
    for x in w:
        left.append(mid - acc)
        acc += x
    return left     # band i spans [left[i] - w[i], left[i]] (offset + to the left)


def asset_from_tags(cls, nF, nB, oneway, sw, tram_mixed, lane_w):
    bands = []
    side_w = DEFAULTS["sidewalk_w"]
    commercial = bool(sw & 16)
    def walk(side):
        out = []
        bit = 1 if side < 0 else 2
        if sw & bit:
            out.append({"kind": "sidewalk", "w": side_w + (1.0 if commercial else 0.0), "surface": "concrete"})
            if sw & (4 if side < 0 else 8):
                out.append({"kind": "boulevard", "w": 1.5, "surface": "grass"})
            elif commercial:
                out.append({"kind": "furniture", "w": DEFAULTS["furniture_w"], "surface": "pavers"})
        return out if side < 0 else out[::-1]
    bands += walk(-1)
    bands.append({"kind": "curb", "w": DEFAULTS["curb_w"], "h": DEFAULTS["curb_h"]})
    veh = ["car", "bus", "truck"] if cls <= 6 else ["car"]
    left_lanes = [] if oneway else [-1] * max(nB, 1)
    right_lanes = [1] * max(nF, 1)
    for i, d in enumerate(left_lanes):
        b = {"kind": "lane", "w": lane_w, "dir": d, "classes": list(veh)}
        if tram_mixed and i == len(left_lanes) - 1:
            b["classes"].append("tram"); b["track"] = 0.0
        bands.append(b)
    for i, d in enumerate(right_lanes):
        b = {"kind": "lane", "w": lane_w, "dir": d, "classes": list(veh)}
        if tram_mixed and i == 0:
            b["classes"].append("tram"); b["track"] = 0.0
        bands.append(b)
    bands.append({"kind": "curb", "w": DEFAULTS["curb_w"], "h": DEFAULTS["curb_h"]})
    bands += walk(1)
    return bands


SHORT_BETWEEN = 3.0    # m: two junctions whose drawn piece between them is (nearly) nothing are one junction
NODE_MERGE = 20.0   # m: junction nodes joined by a shorter street piece are one junction


CLUSTER_MAX = 24.0      # m: largest merged-junction extent (member node to member node)


def merge_close_nodes(edges, npos, jpos, jsig, report, force=frozenset()):
    """Two junctions joined by a street piece shorter than NODE_MERGE (a side street or alley meeting a
    leg right next to the junction, a split cross street) are one designed junction: the piece is
    dropped and the nodes merged (the extra street becomes an extra leg). Logged."""
    deg = defaultdict(int)
    for e in edges:
        deg[e["a"]] += 1; deg[e["b"]] += 1
    parent = {}

    def find(k):
        while parent.get(k, k) != k:
            k = parent[k]
        return k
    drop = set()
    merged = []
    members = {}
    for i, e in sorted(enumerate(edges), key=lambda t: cumlen(t[1]["geom"][:, :2])[-1]):
        if e.get("lot") or e["a"] == e["b"]:
            continue
        L = cumlen(e["geom"][:, :2])[-1]
        forced = frozenset((int(e["a"]), int(e["b"]))) in force
        if (L >= NODE_MERGE and not forced) or deg[e["a"]] < 3 or deg[e["b"]] < 3:
            continue
        ra, rb = find(e["a"]), find(e["b"])
        if ra == rb:
            drop.add(i)
            continue
        # no chaining: the merged junction must stay compact (all member nodes within
        # CLUSTER_MAX of each other), else a run of short pieces fuses a whole block into one node
        P = np.array([npos[k][:2] for k in members.get(ra, [ra]) + members.get(rb, [rb]) if k in npos], dtype=np.float64)
        if len(P) > 1 and np.max(np.hypot(*(P[:, None, :] - P[None, :, :]).transpose(2, 0, 1))) > CLUSTER_MAX:
            report["counts"]["node_merge_refused_chain"] += 1
            continue
        keep, lose = (ra, rb) if (ra in jpos or rb not in jpos) else (rb, ra)
        parent[lose] = keep
        members[keep] = members.pop(keep, [keep]) + members.pop(lose, [lose])
        drop.add(i)
        merged.append(dict(keep=int(keep), lose=int(lose), piece=e["ways"], length_m=round(float(L), 1)))
    if not merged:
        return edges
    # positions: mean of the merged node positions
    groups = defaultdict(list)
    for k in set(parent) | set(parent.values()):
        groups[find(k)].append(k)
    for r, ks in groups.items():
        P = [npos[k] for k in ks if k in npos]
        if P:
            npos[r] = np.mean(np.array(P, dtype=np.float64), axis=0)
        jpos.setdefault(r, [npos[r][:2]])
        jsig[r] = any(jsig.get(k, False) for k in ks)
    out = []
    for i, e in enumerate(edges):
        e["a"], e["b"] = find(e["a"]), find(e["b"])
        if i in drop or (e["a"] == e["b"] and cumlen(e["geom"][:, :2])[-1] < 2 * NODE_MERGE):
            e["internal"] = True           # inside the merged junction: fill, not a leg
        out.append(e)
    report["node_merges"] = merged
    report["counts"]["node_merges"] = len(merged)
    return out


SPLIT_LINK = 10.0       # m: single-linkage distance when splitting an over-wide roadnet junction cluster


def split_wide_clusters(osm, cl, xy, report):
    """roadnet's junction clusters (jn_cl) are built for its own junction renderer and can chain a
    private loop and two street junctions into one cluster. The network model's nodes must stay
    compact: a cluster wider than CLUSTER_MAX is split by single linkage at SPLIT_LINK; the pieces
    get fresh keys (from 2**52, never an OSM id). Close junctions joined by a short street piece are
    re-merged, compactly, by merge_close_nodes. Logged."""
    cl = np.asarray(cl).astype(np.int64).copy()
    xy = np.asarray(xy, dtype=np.float64)
    by = defaultdict(list)
    for k, c in enumerate(cl):
        by[int(c)].append(k)
    nxt = 2 ** 52          # synthetic keys: exact in float64, far above OSM node ids
    for c, ks in by.items():
        if len(ks) < 2:
            continue
        P = xy[ks, :2]
        D = np.hypot(*(P[:, None, :] - P[None, :, :]).transpose(2, 0, 1))
        if D.max() <= CLUSTER_MAX:
            continue
        lab = -np.ones(len(ks), int)
        g = 0
        for i in range(len(ks)):
            if lab[i] >= 0:
                continue
            st = [i]; lab[i] = g
            while st:
                j = st.pop()
                for m in np.where((D[j] <= SPLIT_LINK) & (lab < 0))[0]:
                    lab[m] = g; st.append(m)
            g += 1
        if g < 2:
            continue
        for i, k in enumerate(ks):
            if lab[i] > 0:
                cl[k] = nxt + lab[i]
        nxt += g
        report["overrides"].append(dict(rule="split_wide_junction_cluster", cluster=c, parts=int(g),
                                        extent_m=round(float(D.max()), 1)))
        report["counts"]["junction_clusters_split"] += 1
    return cl


def divided_pairs(edges, report, bbox, dmin=6.0, dmax=30.0):
    """Divided one-way pairs not curated as one corridor (Fort York Blvd, Bremner Blvd): two one-way
    edges with the same name, opposite directions, parallel 6-30 m apart over most of their length.
    The twin's side of each is the median -- no sidewalk or frontage there (tag modelling rule
    'divided_pair_median', logged). Sets e["median_side"] (+1 left / -1 right of travel)."""
    from scipy.spatial import cKDTree
    import shapely
    from . import primgeom
    try:
        road = primgeom.city_roadway(bbox)
        if road is not None:
            shapely.prepare(road)
    except Exception:
        road = None
    ow = [e for e in edges if e.get("oneway") and not e.get("lot") and e.get("name") and len(e["geom"]) >= 2]
    by = defaultdict(list)
    for e in ow:
        by[e["name"]].append(e)
    n = 0
    for name, lst in by.items():
        if len(lst) < 2:
            continue
        for e in lst:
            G = resample(e["geom"], 5.0)
            t, nrm = normals(G)
            best = None
            for f in lst:
                if f is e:
                    continue
                Q = resample(f["geom"], 5.0)
                tq, _ = normals(Q)
                d, k = cKDTree(Q[:, :2]).query(G[:, :2])
                m = (d >= dmin) & (d <= dmax)
                if m.mean() < 0.6:
                    continue
                if np.median((t[m] * tq[k[m]]).sum(1)) > -0.8:      # not opposite directions
                    continue
                side = np.sign(np.median(((Q[k[m], :2] - G[m, :2]) * nrm[m]).sum(1)))
                if best is None or m.mean() > best[0]:
                    best = (m.mean(), int(side), f)
            if best and best[1] != 0:
                e["median_side"] = best[1]
                f = best[2]
                Q = resample(f["geom"], 5.0)
                d, k = cKDTree(Q[:, :2]).query(G[:, :2])
                m = (d >= dmin) & (d <= dmax)
                e["median_gap"] = float(np.median(d[m]))
                e["_twin_geom"] = f["geom"]
                mid = (G[m, :2] + Q[k[m], :2]) / 2
                e["median_paved"] = bool(road is not None and shapely.contains_xy(road, mid[:, 0], mid[:, 1]).mean() > 0.6)
                n += 1
                report["overrides"].append(dict(rule="divided_pair_median", ways=e["ways"], twin=best[2]["ways"],
                                                side="left" if best[1] > 0 else "right",
                                                evidence="same-name opposite one-way 6-30 m away: the side between is a median"))
    report["counts"]["divided_pair_edges"] = n


def add_median(e, bands, report):
    """the divided pair's median half on the twin's side: half the gap between the two centrelines
    minus this carriageway's half width. Paved in the City survey (a hatched / flush median) ->
    'median_flush' inside the curb at road level (centre_skip: the lanes stay on the centreline);
    else a raised planted 'median' outside the curb."""
    curbs = [i for i, b in enumerate(bands) if b["kind"] == "curb"]
    if len(curbs) < 2:
        return
    half = sum(b["w"] for b in bands[curbs[0]:curbs[-1] + 1]) / 2
    w = round(e.get("median_gap", 0.0) / 2 - half, 2)
    if w < 0.3:
        return
    left = e["median_side"] > 0
    if e.get("median_paved"):
        b = {"kind": "median_flush", "w": w, "surface": "asphalt", "centre_skip": True, "pair_median": True}
        bands.insert(curbs[0] + 1 if left else curbs[-1], b)
    else:
        b = {"kind": "median", "w": w, "surface": "grass", "pair_median": True}
        bands.insert(curbs[0] if left else curbs[-1] + 1, b)
    report["overrides"].append(dict(rule="divided_pair_median_band", ways=e["ways"], kind=b["kind"], w=w,
                                    evidence="half the gap to the twin carriageway; City pavement survey decides paved / planted"))


FIT_TOL = 0.5            # m: fitted centreline stays within this of the model polyline
FIT_DEG = 3.0            # adaptive sampling: at most this heading change per station


def fit_centreline(G, tol=FIT_TOL):
    """smooth curve through the model centreline (constrained smoothing: a discrete spline with the
    ends pinned, every point kept within FIT_TOL of the source polyline), sampled adaptively --
    at most FIT_DEG of heading change per station, 0.5 .. 4 m apart. z follows the model."""
    import shapely
    D = resample(G, 1.0)
    if len(G) < 3 or len(D) < 4:
        return resample(G, 2.0)
    src = shapely.LineString(G[:, :2])
    P = D[:, :2].copy()
    for _ in range(40):
        Q = P.copy()
        Q[1:-1] += 0.5 * (0.5 * (P[:-2] + P[2:]) - P[1:-1])
        # constraint: back within FIT_TOL of the source
        pts = shapely.points(Q[1:-1])
        near = shapely.line_interpolate_point(src, shapely.line_locate_point(src, pts))
        nx = np.column_stack([shapely.get_x(near), shapely.get_y(near)])
        dv = Q[1:-1] - nx
        dd = np.hypot(dv[:, 0], dv[:, 1])
        far = dd > tol
        Q[1:-1][far] = nx[far] + dv[far] * (tol / dd[far])[:, None]
        P = Q
    s = cumlen(P)
    z = np.interp(s / max(s[-1], 1e-9), cumlen(D[:, :2]) / max(cumlen(D[:, :2])[-1], 1e-9), D[:, 2])
    # adaptive stations
    t = np.gradient(P, axis=0)
    h = np.unwrap(np.arctan2(t[:, 1], t[:, 0]))
    kap = np.abs(np.gradient(h)) / np.maximum(np.gradient(s), 1e-6)
    st = [0.0]
    while st[-1] < s[-1]:
        k = np.interp(st[-1], s, kap)
        step = float(np.clip(math.radians(FIT_DEG) / max(k, 1e-6), 0.5, 4.0))
        st.append(min(st[-1] + step, s[-1]))
        if s[-1] - st[-1] < 0.25:
            st[-1] = s[-1]
            break
    st = np.array(st)
    X = np.column_stack([np.interp(st, s, P[:, 0]), np.interp(st, s, P[:, 1])])
    # the stations themselves within tol of the source (a chord of the smoothed curve can cut a corner)
    near = shapely.line_interpolate_point(src, shapely.line_locate_point(src, shapely.points(X[1:-1])))
    nx = np.column_stack([shapely.get_x(near), shapely.get_y(near)])
    dv = X[1:-1] - nx
    dd = np.hypot(dv[:, 0], dv[:, 1])
    far = dd > tol
    X[1:-1][far] = nx[far] + dv[far] * (tol / dd[far])[:, None]
    return np.column_stack([X, np.interp(st, s, z)])


GRADE_SEP = 3.5          # m: crossing streets this far apart in z are grade separated


CITY_MIN_EXTRA = 0.3     # m: surveyed pavement wider than the section by at least this -> widened


def city_widths(edges, assets, bbox, report):
    """Carriageway width from the City of Toronto's surveyed edge-of-roadway polygons (docs/SOURCES.md):
    rays from the centreline every 5 m find the pavement edge each side (median over the edge).
    Where the surveyed pavement is wider than the asset's carriageway, the edge gets its own
    asset: a parking band (>= 1.8 m extra) or wider curb lanes / a shoulder (less). Curated
    sections and lot aisles keep theirs. Logged per edge."""
    import shapely
    from . import primgeom
    road = primgeom.city_roadway(bbox)
    if road is None:
        return
    shapely.prepare(road)
    bnd = road.boundary
    n_w = 0
    for e in edges:
        if e.get("source") == "curated" or e.get("lot") or e.get("internal"):
            continue
        a = assets[e["asset"]]
        bands = a["bands"]
        curbs = [i for i, b in enumerate(bands) if b["kind"] == "curb"]
        if len(curbs) < 2:
            continue
        G = resample(e["geom"], 5.0)
        if len(G) < 4:
            continue
        t, nrm = normals(G)
        G, nrm = G[1:-1], nrm[1:-1]               # away from the nodes
        if not shapely.contains_xy(road, G[:, 0], G[:, 1]).mean() > 0.6:
            continue
        cw_l = a["offsets"][curbs[0] + 1] if curbs[0] + 1 < len(bands) else 0.0
        cw_r = -(a["offsets"][curbs[-1]])
        halves = []
        for side in (1, -1):
            rays = shapely.linestrings(np.stack([G[:, :2], G[:, :2] + side * nrm * 18.0], 1))
            ip = shapely.intersection(rays, bnd)
            d = []
            for k, g in enumerate(ip):
                if g.is_empty:
                    continue
                d.append(float(shapely.distance(shapely.points(G[k, :2]), g)))
            halves.append(float(np.median(d)) if len(d) >= max(2, len(G) // 2) else None)
        hl, hr = halves
        if hl is None or hr is None:
            continue
        exl, exr = hl - cw_l, hr - cw_r
        if e.get("median_side") == 1:
            exl = 0.0
        elif e.get("median_side") == -1:
            exr = 0.0
        if max(exl, exr) < CITY_MIN_EXTRA:
            continue
        nb = [dict(b) for b in bands]
        # insert on the right side first (index shifts), then the left
        for side, ex, ci in ((-1, exr, curbs[-1]), (1, exl, curbs[0])):
            if ex < CITY_MIN_EXTRA or e.get("median_side") == side:
                continue          # (the survey's pavement runs on across a flush median)
            lane_dir = -1 if side > 0 else 1
            if ex >= 1.8:
                nb.insert(ci if side < 0 else ci + 1, {"kind": "parking", "w": round(min(ex, 3.0), 2), "dir": lane_dir})
                rest = ex - min(ex, 3.0)
            else:
                rest = ex
            if rest >= CITY_MIN_EXTRA:
                nb.insert(ci if side < 0 else ci + 1, {"kind": "shoulder", "w": round(rest, 2)})
        aid = f"{e['asset']}+city{round(exl, 1)}/{round(exr, 1)}"
        if aid not in assets:
            assets[aid] = dict(a, id=aid, bands=nb, offsets=band_offsets(nb),
                               note=f"carriageway widened to the City's surveyed pavement ({hl:.1f} / {hr:.1f} m half widths)")
        e["asset"] = aid
        e["source"] = "city_survey"
        n_w += 1
        report["overrides"].append(dict(rule="city_pavement_width", ways=e["ways"], half_widths=[round(hl, 2), round(hr, 2)],
                                        asset_halves=[round(cw_l, 2), round(cw_r, 2)],
                                        evidence="City of Toronto edge-of-roadway survey (raw/toronto_topo)"))
    report["counts"]["city_widened_edges"] = n_w


def corridor_midlines(edges, curated_for, npos, jpos, jsig, report):
    """Curated divided corridors (cross_sections.json 'pair'): the one-way carriageways are evidence
    only. One edge per block is built on their MIDLINE (station by station: the midpoint of each
    carriageway point and the nearest opposite-direction point), carrying the full curated section,
    split at the cross-street nodes (junction clusters the carriageways touch). Nodes that project
    within 12 m of each other on the midline are merged (edges re-pointed). Each pairing is logged."""
    groups = defaultdict(list)
    for i, e in enumerate(edges):
        if not e.get("oneway"):
            continue
        cs = curated_for(e)
        if cs is not None and cs.get("pair"):
            groups[cs["id"]].append(i)
    drop, new_edges, remap = set(), [], {}
    for cid, idx in groups.items():
        E_ = [edges[i] for i in idx]
        pts = np.vstack([resample(e["geom"], 2.0) for e in E_])
        c0 = pts[:, :2].mean(0)
        _, _, vt = np.linalg.svd(pts[:, :2] - c0, full_matrices=False)
        axis = vt[0]
        dirs = []
        samp = []
        for e in E_:
            G = resample(e["geom"], 2.0)
            t, _ = normals(G)
            sg = 1 if float(np.mean(t @ axis)) > 0 else -1
            dirs.append(sg)
            samp.append(G)
        A = [g for g, d in zip(samp, dirs) if d > 0]
        B = [g for g, d in zip(samp, dirs) if d < 0]
        if not A or not B:
            continue
        PA, PB = np.vstack(A), np.vstack(B)
        tA, tB = cKDTree(PA[:, :2]), cKDTree(PB[:, :2])
        mids = []
        for P, other, T in ((PA, PB, tB), (PB, PA, tA)):
            d, k = T.query(P[:, :2])
            ok = d < 40.0
            mids.append((P[ok] + other[k[ok]]) / 2)
        M = np.vstack(mids)
        proj = (M[:, :2] - c0) @ axis
        o = np.argsort(proj)
        M, proj = M[o], proj[o]
        # runs without large gaps (the pair diverges / ends)
        br = np.nonzero(np.diff(proj) > 30.0)[0]
        for run in np.split(np.arange(len(M)), br + 1):
            if len(run) < 5:
                continue
            Q = M[run]
            # smooth the midline (both carriageways' samples interleave), then resample 2 m
            from scipy.ndimage import gaussian_filter1d
            Q = np.column_stack([gaussian_filter1d(Q[:, k], 3, mode="nearest") for k in range(3)])
            Q = resample(Q, 2.0)
            sQ = cumlen(Q[:, :2])
            # nodes touched by the carriageways -> stations on the midline
            keys = set()
            for e in E_:
                keys.update((e["a"], e["b"]))
            tq = cKDTree(Q[:, :2])
            st = []
            for k_ in keys:
                p = npos.get(k_)
                if p is None:
                    continue
                d, j = tq.query(p[:2])
                if d < 25.0:
                    st.append((float(sQ[j]), k_, int(j), d))
            st.sort()
            merged = []
            for x in st:
                if merged and x[0] - merged[-1][0] < 12.0:
                    keep_, lose = (merged[-1], x) if (merged[-1][1] in jpos or x[1] not in jpos) else (x, merged[-1])
                    remap[lose[1]] = keep_[1]
                    merged[-1] = keep_
                else:
                    merged.append(x)
            # corridor ends: synthetic end nodes if no node there
            if not merged or merged[0][0] > 6.0:
                k_ = -(len(new_edges) * 2 + 1) - 10 ** 9
                npos[k_] = Q[0].copy(); merged.insert(0, (0.0, k_, 0, 0.0))
            if merged[-1][0] < sQ[-1] - 6.0:
                k_ = -(len(new_edges) * 2 + 2) - 10 ** 9
                npos[k_] = Q[-1].copy(); merged.append((float(sQ[-1]), k_, len(Q) - 1, 0.0))
            for (s0, ka, j0, _), (s1, kb, j1, _) in zip(merged[:-1], merged[1:]):
                if j1 - j0 < 2:
                    continue
                npos[ka] = np.array([Q[j0, 0], Q[j0, 1], npos[ka][2]]) if ka in npos else Q[j0].copy()
                npos[kb] = np.array([Q[j1, 0], Q[j1, 1], npos[kb][2]]) if kb in npos else Q[j1].copy()
                G = Q[j0:j1 + 1].copy()
                G[0, :2], G[-1, :2] = npos[ka][:2], npos[kb][:2]
                e0 = E_[0]
                new_edges.append(dict(way=e0["way"], ways=sorted({w for e in E_ for w in e["ways"]}), a=ka, b=kb, geom=G,
                                      cls=e0["cls"], name=e0["name"], oneway=False, paired=True,
                                      nF=max(e["nF"] for e in E_), nB=max(e["nF"] for e in E_)))
            report["overrides"].append(dict(rule="corridor_midline", curated=cid, ways=sorted({w for e in E_ for w in e["ways"]}),
                                            length_m=round(float(sQ[-1]), 1), nodes=len(merged),
                                            evidence=f"{len(A)} + {len(B)} one-way carriageway pieces, midline from nearest opposite points"))
        drop.update(idx)
    for m_, k_ in remap.items():
        if m_ in jsig:
            jsig[k_] = jsig[k_] or jsig[m_]
        if m_ in jpos:
            jpos.setdefault(k_, []).extend(jpos[m_])
    out = []
    for i, e in enumerate(edges):
        if i in drop:
            continue
        e["a"] = remap.get(e["a"], e["a"]); e["b"] = remap.get(e["b"], e["b"])
        out.append(e)
    for e in new_edges:
        e["a"] = remap.get(e["a"], e["a"]); e["b"] = remap.get(e["b"], e["b"])
        # cross-street ends snap onto the moved node positions
    for e in out:
        for end, k_ in ((0, e["a"]), (-1, e["b"])):
            if k_ in npos:
                e["geom"][end, :2] = npos[k_][:2]
    report["counts"]["corridor_edges"] = len(new_edges)
    return out + new_edges


def half_bands(bands):
    """right half of a symmetric curated section: from the transit_row centre to the right edge"""
    r = next(i for i, b in enumerate(bands) if b["kind"] == "transit_row")
    row = dict(bands[r])
    w = row["w"] / 2
    row["w"] = w
    tr = [t for t in row.get("tracks", []) if t < 0]
    row["tracks"] = [t + w / 2 for t in tr]
    dirs = row.get("track_dir", [])
    row["track_dir"] = [d for t, d in zip(bands[r].get("tracks", []), dirs) if t < 0] or [1]
    row.pop("platforms", None)
    return [row] + [dict(b) for b in bands[r + 1:]]


def asset_id(bands, cls, prefix):
    lanes = sum(1 for b in bands if b["kind"] == "lane")
    sw = "".join("s" if b["kind"] == "sidewalk" else "" for b in bands)
    tram = "_tram" if any("tram" in b.get("classes", []) for b in bands) else ""
    return f"{prefix}_c{cls}_{lanes}l_{len(sw)}sw{tram}"


# ------------------------------------------------------------------ build
def build(bbox, out_dir=None, force=frozenset()):
    t0 = time.time()
    x0, y0, x1, y1 = bbox
    M = 150.0
    with np.load(geo.WORK / "roadnet.npz", allow_pickle=True) as d:
        A = {k: d[k] for k in d.files if k.startswith(("way_", "jn_", "rail_", "road_osm", "road_sw", "road_off",
                                                           "road_xyz", "road_name", "road_cls", "road_vf"))}
    with np.load(geo.WORK / "osm_lines.npz", allow_pickle=True) as f:
        L = {k: f[k] for k in ("id", "cls", "flags", "name", "kind", "lanes", "side", "cyc", "layer", "svc")}
    lid = {int(i): k for k, i in enumerate(L["id"])}
    cur = json.loads((geo.PIPE / "curated" / "cross_sections.json").read_text())["cross_sections"]
    report = {"overrides": [], "counts": defaultdict(int)}
    review = []

    # ---- 1. graph: model ways in the bbox (+ margin), drivable classes
    wo, wx, wid = A["way_off"].astype(np.int64), A["way_xyz"], A["way_id"]
    no, nn, ns = A["way_node_off"].astype(np.int64), A["way_node"], A["way_node_s"]
    ways = []
    for i in range(len(wid)):
        P = wx[wo[i]:wo[i + 1]]
        if not ((P[:, 0] > x0 - M) & (P[:, 0] < x1 + M) & (P[:, 1] > y0 - M) & (P[:, 1] < y1 + M)).any():
            continue
        k = lid.get(int(wid[i]))
        if k is None or (L["cls"][k] > 6 and not (A["way_flags"][i] & 32)):
            continue
        ways.append(i)
    lot_way = {int(wid[i]) for i in ways if A["way_flags"][i] & 32}
    jcl = split_wide_clusters(A["jn_osm"], A["jn_cl"], A["jn_xy"], report)
    jmem = {int(o): int(c) for o, c in zip(A["jn_osm"], jcl)}
    jsig = defaultdict(bool)
    jpos = defaultdict(list)
    for o, c, f, p in zip(A["jn_osm"], jcl, A["jn_flags"], A["jn_xy"]):
        jsig[int(c)] |= bool(f & 1)
        jpos[int(c)].append(p)
    deg = defaultdict(int)
    for i in ways:
        ids = nn[no[i]:no[i + 1]]
        for k, n_ in enumerate(ids):
            deg[int(n_)] += 1 if k in (0, len(ids) - 1) else 2
    npos = {}
    pieces = []          # (way index, node a, node b, s0, s1)
    for i in ways:
        ids, ss = nn[no[i]:no[i + 1]], ns[no[i]:no[i + 1]]
        cut = [0] + [k for k in range(1, len(ids) - 1) if int(ids[k]) in jmem or deg[int(ids[k])] != 2] + [len(ids) - 1]
        s_way = A["way_s"][wo[i]:wo[i + 1]]
        P = wx[wo[i]:wo[i + 1]]
        for a, b in zip(cut[:-1], cut[1:]):
            na, nb = int(ids[a]), int(ids[b])
            ka, kb = jmem.get(na, na), jmem.get(nb, nb)
            pieces.append((i, ka, kb, float(ss[a]), float(ss[b])))
            for n_, key, sv in ((na, ka, ss[a]), (nb, kb, ss[b])):
                if key not in npos:
                    npos[key] = np.array([np.interp(sv, s_way, P[:, 0]), np.interp(sv, s_way, P[:, 1]), np.interp(sv, s_way, P[:, 2])])
    for c, ps in jpos.items():
        if c in npos:
            p = np.mean(np.array(ps), 0)
            npos[c] = np.array([p[0], p[1], npos[c][2]])

    def piece_geom(pc):
        i, _, _, s0, s1 = pc
        s_way = A["way_s"][wo[i]:wo[i + 1]]
        P = wx[wo[i]:wo[i + 1]]
        m = (s_way > s0 + 1e-6) & (s_way < s1 - 1e-6)
        pts = [np.array([np.interp(s0, s_way, P[:, k]) for k in range(3)])] + list(P[m]) + \
              [np.array([np.interp(s1, s_way, P[:, k]) for k in range(3)])]
        return np.array(pts)

    # merge chains through plain degree-2 nodes with the same way attributes
    def attrs(i):
        k = lid[int(wid[i])]
        return (int(L["cls"][k]), str(L["name"][k]), bool(L["flags"][k] & 1), int(wid[i]) in lot_way)
    inc = defaultdict(list)          # non-lot pieces per node (driveways / aisles don't split streets)
    lot_inc = defaultdict(list)
    for pi_, pc in enumerate(pieces):
        tgt = lot_inc if int(wid[pc[0]]) in lot_way else inc
        tgt[pc[1]].append(pi_); tgt[pc[2]].append(pi_)
    drive_nodes = {n_ for n_ in lot_inc if len(inc.get(n_, [])) == 2}
    used = np.zeros(len(pieces), bool)
    edges = []
    for pi_ in range(len(pieces)):
        if used[pi_]:
            continue
        used[pi_] = True
        chain = [(pi_, False)]
        # extend forward from node b and backward from node a
        for direction in (1, -1):
            cur_n = pieces[pi_][2] if direction == 1 else pieces[pi_][1]
            prev = pi_
            while (cur_n not in jpos or cur_n in drive_nodes) and len(inc[cur_n]) == 2:
                nxt = [q for q in inc[cur_n] if q != prev and not used[q]]
                if not nxt or attrs(pieces[nxt[0]][0]) != attrs(pieces[pi_][0]):
                    break
                q = nxt[0]
                rev = pieces[q][1] != cur_n
                used[q] = True
                if direction == 1:
                    chain.append((q, rev))
                else:
                    chain.insert(0, (q, not rev))
                cur_n = pieces[q][1] if rev else pieces[q][2]
                prev = q
        geo_ = []
        for q, rev in chain:
            g = piece_geom(pieces[q])
            g = g[::-1] if rev else g
            geo_.append(g if not geo_ else g[1:])
        G = np.vstack(geo_)
        qa_, ra_ = chain[0]
        qb_, rb_ = chain[-1]
        na = pieces[qa_][2] if ra_ else pieces[qa_][1]
        nb = pieces[qb_][1] if rb_ else pieces[qb_][2]
        wi = pieces[qa_][0]
        edges.append(dict(way=int(wid[wi]), ways=sorted({int(wid[pieces[q][0]]) for q, _ in chain}), a=na, b=nb,
                          geom=G, cls=attrs(wi)[0], name=attrs(wi)[1], oneway=attrs(wi)[2],
                          nF=int(A["way_nF"][wi]), nB=int(A["way_nB"][wi])))
    report["counts"]["edges_raw"] = len(edges)
    # pieces inside a junction cluster (both ends in the same cluster: the crossing street
    # between the two carriageways of a divided road) are part of the node box, not edges
    for e in edges:   # pieces inside a junction: drawn as plain fill under the box, never legs
        if e["a"] == e["b"] and e["a"] in jpos and cumlen(e["geom"][:, :2])[-1] < 80.0:
            e["internal"] = True
    report["counts"]["edges_internal_dropped"] = report["counts"]["edges_raw"] - len(edges)

    # model sidewalk bits per way (road pieces), tram track pieces (rail cls 4)
    sw_of = defaultdict(int)
    ro = A["road_off"].astype(np.int64)
    for i, o in enumerate(A["road_osm"]):
        sw_of[int(o)] |= int(np.bitwise_or.reduce(A["road_sw"][ro[i]:ro[i + 1]])) if ro[i + 1] > ro[i] else 0
    rlo, rlx, rlc = A["rail_off"].astype(np.int64), A["rail_xyz"], A["rail_cls"]
    trams = []
    for i in range(len(rlo) - 1):
        if rlc[i] != 4:
            continue
        P = rlx[rlo[i]:rlo[i + 1]]
        if ((P[:, 0] > x0 - M) & (P[:, 0] < x1 + M) & (P[:, 1] > y0 - M) & (P[:, 1] < y1 + M)).any():
            Q = resample(P, 1.0)
            trams.append(np.column_stack([Q, np.full(len(Q), i)]))
    tram_pts = np.vstack(trams) if trams else np.zeros((0, 4))     # x, y, z, model rail piece
    ttree = cKDTree(tram_pts[:, :2]) if len(tram_pts) else None

    # ---- 1b. divided pairs (curated 'pair'): join the two one-way carriageways into one edge
    def curated_for(e):
        c = e["geom"][len(e["geom"]) // 2]
        for cs in cur:
            if e["name"] in cs.get("names", []) and cs.get("status") is None:
                bb = cs.get("bbox")
                if bb is None or (bb[0] <= c[0] <= bb[2] and bb[1] <= c[1] <= bb[3]):
                    return cs
        return None
    edges = corridor_midlines(edges, curated_for, npos, jpos, jsig, report)
    edges = merge_close_nodes(edges, npos, jpos, jsig, report, force)

    # ---- 2. assets
    assets = {}
    LOT = {"id": "lot_aisle", "bands": [{"kind": "lane", "w": 3.0, "dir": -1, "classes": ["car"]},
                                         {"kind": "lane", "w": 3.0, "dir": 1, "classes": ["car"]}],
           "curb_radius": 4.0, "draw": True, "markings": False,
           "note": "parking aisle / driveway / drive-through: lanes for agents; the paved lot area is the tile's lot asset"}
    LOT["offsets"] = band_offsets(LOT["bands"])
    divided_pairs(edges, report, bbox)
    for e in edges:
        if e["way"] in lot_way:
            assets.setdefault("lot_aisle", LOT)
            e["asset"], e["source"], e["lot"] = "lot_aisle", "tags", True
            continue
        cs = curated_for(e)
        if cs is not None and (cs.get("pair") in (None, False) or e.get("paired") or not e.get("oneway")):
            bands = [dict(b) for b in cs["bands"]]
            aid = cs["id"]
            e["source"] = "curated"
        else:
            G = e["geom"]
            mixed = False
            if ttree is not None:
                d, _ = ttree.query(resample(G, 5.0)[:, :2])
                mixed = (d < 3.0).mean() > 0.5
            sw = 0
            for w in e["ways"]:
                sw |= sw_of.get(w, 0)
            # standards default (CROSS_SECTION.md derivation step 4): urban streets in Toronto have
            # sidewalks both sides; the model's bits are empty where OSM maps them as separate
            # (hidden) footways or where a rule cut them -- keep an explicit one-sided tag
            if (sw & 3) == 0 and 2 <= e["cls"] <= 5 and not e.get("paired"):
                sw |= 3 | 16 if e["cls"] <= 4 else 3
                report["overrides"].append(dict(rule="sidewalk_default", ways=e["ways"], evidence="no sidewalk bits in the model; urban street class"))
            if e.get("median_side"):
                # divided one-way pair: the twin's side is the median (no walk / frontage there)
                sw &= ~(1 if e["median_side"] > 0 else 2)
            lane_w = DEFAULTS["lane_w"].get(e["cls"], 3.0)
            if e["cls"] == 6:
                svc = int(L["svc"][lid[e["way"]]]) if e["way"] in lid else 0
                lane_w = DEFAULTS["lane_w_alley"] if svc == 3 else DEFAULTS["lane_w_service"]
            bands = asset_from_tags(e["cls"], e["nF"], e["nB"], e["oneway"], sw, mixed, lane_w)
            if e.get("median_side"):
                add_median(e, bands, report)
            aid = asset_id(bands, e["cls"], "osm")
            e["source"] = "tags"
        if aid in assets and assets[aid]["bands"] != bands:
            # same family, different section (lane width, sidewalk variant): its own asset
            import hashlib
            aid = aid + "_" + hashlib.md5(json.dumps(bands, sort_keys=True).encode()).hexdigest()[:6]
        assets.setdefault(aid, {"id": aid, "bands": bands, "offsets": band_offsets(bands),
                                "curb_radius": 12.0 if (e["cls"] <= 3 or any(b["kind"] == "transit_row" for b in bands)) else 7.0})
        e["asset"] = aid

    # authoritative widths (derivation step 2): the City's surveyed pavement sets the carriageway
    city_widths(edges, assets, bbox, report)
    # stops for curated transit_row platforms (GTFS via data/transit)
    stops = load_stops(bbox)

    # ---- 3/4. curves + profile: resample the model centreline, keep the model z
    for k_, e in enumerate(edges):
        e["id"] = k_
        # streets carrying streetcar track keep to the model within 0.1 m (the rails are the
        # model's tram geometry, not re-fitted here)
        tol = FIT_TOL
        if ttree is not None:
            dd, _ = ttree.query(e["geom"][:, :2], distance_upper_bound=6.0)
            if np.isfinite(dd).mean() > 0.3:
                tol = 0.1
        src = e["geom"]
        e["geom"] = fit_centreline(src, tol)
        import shapely
        dev = float(shapely.distance(shapely.points(e["geom"][:, :2]), shapely.LineString(src[:, :2])).max()) if len(src) > 1 else 0.0
        report["counts"]["centreline_fit_max_dev_m"] = round(max(report["counts"]["centreline_fit_max_dev_m"], dev), 3)
        e["s"] = cumlen(e["geom"][:, :2])
    # driveways (docs/CROSS_SECTION.md events): a lot / driveway edge ending on a street edge's
    # interior is a driveway event on that street (s, side), not a junction
    street = [e for e in edges if not e.get("lot")]
    for e in edges:
        if not e.get("lot"):
            continue
        for end in (0, 1):
            nd = e["a"] if end == 0 else e["b"]
            if nd not in drive_nodes:
                continue
            q = e["geom"][0 if end == 0 else -1, :2]
            inner = e["geom"][min(3, len(e["geom"]) - 1) if end == 0 else max(0, len(e["geom"]) - 4), :2]
            best = None
            for st in street:
                d = np.hypot(*(st["geom"][:, :2] - q).T)
                k = int(np.argmin(d))
                if d[k] < 2.5 and 0 < k < len(d) - 1 and (best is None or d[k] < best[0]):
                    best = (d[k], st, k)
            if best is None:
                continue
            _, st, k = best
            _, nrm = normals(st["geom"])
            side = 1 if float((inner - st["geom"][k, :2]) @ nrm[k]) > 0 else -1
            st.setdefault("driveways", []).append(dict(s=round(float(st["s"][k]), 1), side=side, way=e["way"], w=4.0))
    report["counts"]["driveways"] = sum(len(e.get("driveways", [])) for e in edges)
    # ---- 6. nodes (legs, setbacks)
    # a short piece whose both ends are one node (made by any merge: roadnet's junction clusters,
    # corridor midlines, merge_close_nodes) lies inside that junction: fill, not a pair of legs
    for e in edges:
        if e["a"] == e["b"] and not e.get("internal") and cumlen(e["geom"][:, :2])[-1] < 2 * NODE_MERGE:
            e["internal"] = True
            report["counts"]["self_loop_internal"] += 1
    legs = defaultdict(list)
    for e in edges:
        if e.get("internal"):
            continue
        for end in (0, 1):
            nd = e["a"] if end == 0 else e["b"]
            G = e["geom"] if end == 0 else e["geom"][::-1]
            s = cumlen(G[:, :2])
            j = int(min(np.searchsorted(s, 12.0), len(G) - 1))
            h = G[j, :2] - G[0, :2]
            legs[nd].append(dict(edge=e["id"], end=end, ang=math.atan2(h[1], h[0])))
    nodes = []
    for nd, lg in legs.items():
        p = npos.get(nd)
        if p is None:
            continue
        typ = "junction" if len(lg) >= 3 else "continuation" if len(lg) == 2 else "end"
        lg.sort(key=lambda r: r["ang"])
        for r in lg:
            a = assets[edges[r["edge"]]["asset"]]
            off, bands = a["offsets"], a["bands"]
            curbs = [i for i, b in enumerate(bands) if b["kind"] == "curb"]
            # carriageway half widths (curb faces) and building-line half widths, as seen leaving the node
            cl = off[curbs[0]] - bands[curbs[0]]["w"] if curbs else off[0]
            cr = -(off[curbs[-1]]) if curbs else -(off[-1] - bands[-1]["w"])
            outer_l, outer_r = off[0], -(off[-1] - bands[-1]["w"])
            if r["end"] == 1:     # leaving the node against the edge direction: sides swap
                cl, cr, outer_l, outer_r = cr, cl, outer_r, outer_l
            r.update(hw_l=cl, hw_r=cr, out_l=outer_l, out_r=outer_r)
        R = max(assets[edges[r["edge"]]["asset"]]["curb_radius"] for r in lg)
        # setback: where this leg's curb line meets the angularly adjacent legs' curb lines, plus
        # 2.5 m -- the crosswalk sits just past the crossing street's curb (Toronto practice); the
        # curb return between two legs is generated in the corner (INTERSECTIONS.md)
        n_l = len(lg)
        for i_, r in enumerate(lg):
            d = 0.0
            if typ == "junction":
                h = np.array([math.cos(r["ang"]), math.sin(r["ang"])]); nv = np.array([-h[1], h[0]])
                for j_, side in (((i_ + 1) % n_l, 1), ((i_ - 1) % n_l, -1)):
                    o = lg[j_]
                    ho = np.array([math.cos(o["ang"]), math.sin(o["ang"])]); no_ = np.array([-ho[1], ho[0]])
                    # corner between r's curb on `side` (+1 left) and o's curb on the other side
                    pr_ = nv * (r["hw_l"] if side > 0 else -r["hw_r"])
                    po_ = no_ * (-o["hw_r"] if side > 0 else o["hw_l"])
                    den = h[0] * ho[1] - h[1] * ho[0]
                    if abs(den) < 0.15:           # (nearly) opposite or parallel legs: no corner
                        continue
                    a_ = ((po_[0] - pr_[0]) * ho[1] - (po_[1] - pr_[1]) * ho[0]) / den
                    d = max(d, a_)
                d = min(max(d + 2.5, max(r["hw_l"], r["hw_r"]) * 0.5 + 2.0), 40.0)
            r["setback"] = round(float(d), 2)
        node = dict(id=len(nodes), key=int(nd), xyz=[float(v) for v in p], type=typ, legs=lg,
                    signal=bool(jsig.get(nd, False)), curb_radius=R)
        nodes.append(node)
    node_of = {n_["key"]: n_ for n_ in nodes}

    # ---- 5. interactions + review queue
    inter = []
    for n_ in nodes:
        inter.append(dict(type=n_["type"], node=n_["id"], outcome="generate", xy=n_["xyz"][:2]))
        # streetcar special work: model tram geometry inside the box
        if ttree is not None and n_["type"] == "junction":
            r_box = max((r["setback"] for r in n_["legs"]), default=0.0) + 2
            ids = ttree.query_ball_point(n_["xyz"][:2], r_box)
            if ids:
                rad = min_radius(tram_pts, ids)
                outcome = "generate" if rad >= 11.0 else "review"
                inter.append(dict(type="special_work", node=n_["id"], outcome=outcome, xy=n_["xyz"][:2],
                                  min_radius=round(rad, 1)))
                if outcome == "review":
                    review.append(dict(id=f"sw_radius_{n_['id']}", category="special_work_radius", xy=n_["xyz"][:2],
                                       evidence=dict(min_radius_m=round(rad, 1), rule="TTC minimum 11 m",
                                                     model="tram rails from roadnet (rail_geom.fillet, R=15 m)"),
                                       refs=refs(*n_["xyz"][:2])))
    for e in edges:
        if any("tram" in b.get("classes", []) for b in assets[e["asset"]]["bands"]):
            inter.append(dict(type="embedded_track", edge=e["id"], outcome="generate"))
        if any(b["kind"] == "transit_row" for b in assets[e["asset"]]["bands"]):
            inter.append(dict(type="transit_row", edge=e["id"], outcome="generate"))
    # road x heavy rail from the model's side outputs (underpasses / level crossings)
    for fn, typ in (("underpasses.json", "underpass"), ("crossings.json", "level_crossing")):
        p = geo.WORK / fn
        if not p.exists():
            p = geo.OUT / fn
        if not p.exists():
            continue
        data = json.loads(p.read_text())
        for u in data.get("underpasses", data.get("crossings", [])):
            if x0 <= u["e"] <= x1 and y0 <= u["n"] <= y1:
                inter.append(dict(type=typ, outcome="generate", xy=[u["e"], u["n"]],
                                  detail={k: u[k] for k in u if k not in ("approaches",)}))
    # road x road without a shared node: a grade separation where the model levels differ by at
    # least GRADE_SEP (one passes over the other on a structure); otherwise left to QA (unresolved)
    import shapely
    gl = {e["id"] if "id" in e else k: (e, shapely.LineString(e["geom"][:, :2])) for k, e in enumerate(edges)
          if not e.get("lot") and not e.get("internal") and len(e["geom"]) >= 2}
    gk = list(gl)
    gtree = shapely.STRtree([gl[k][1] for k in gk])
    n_gs = 0
    for a_, b_ in zip(*gtree.query([gl[k][1] for k in gk], predicate="crosses")):
        if a_ >= b_:
            continue
        (ea, la), (eb, lb) = gl[gk[a_]], gl[gk[b_]]
        if {ea["a"], ea["b"]} & {eb["a"], eb["b"]}:
            continue
        for pt in shapely.get_parts(la.intersection(lb)):
            if pt.geom_type != "Point" or not (x0 <= pt.x <= x1 and y0 <= pt.y <= y1):
                continue
            za = float(np.interp(la.project(pt), cumlen(ea["geom"][:, :2]), ea["geom"][:, 2]))
            zb = float(np.interp(lb.project(pt), cumlen(eb["geom"][:, :2]), eb["geom"][:, 2]))
            if abs(za - zb) < GRADE_SEP:
                continue
            up, lo = (ea, eb) if za > zb else (eb, ea)
            inter.append(dict(type="grade_separation", outcome="generate", xy=[round(pt.x, 2), round(pt.y, 2)],
                              upper_ways=up["ways"], lower_ways=lo["ways"], clearance=round(abs(za - zb), 2)))
            n_gs += 1
    report["counts"]["grade_separations"] = n_gs
    # model contradictions: a street sharing a point with a track that the model bridges
    rvf = A["rail_vf"]
    for i in range(len(rlo) - 1):
        if rlc[i] > 1:
            continue
        P = rlx[rlo[i]:rlo[i + 1]]
        inb = (P[:, 0] > x0) & (P[:, 0] < x1) & (P[:, 1] > y0) & (P[:, 1] < y1)
        if not inb.any():
            continue
        for e in edges:
            G = e["geom"]
            t = cKDTree(G[:, :2])
            d, k = t.query(P[inb, :2])
            hit = np.nonzero(d < 1.0)[0]
            for h in hit[:1]:
                v = rlo[i] + np.nonzero(inb)[0][h]
                if (rvf[v] & 1) and abs(G[k[h], 2] - rlx[v, 2]) < 0.5:
                    xy = [float(rlx[v, 0]), float(rlx[v, 1])]
                    review.append(dict(id=f"contradiction_{e['way']}_{i}", category="shared_point_with_bridged_track",
                                       xy=xy, evidence=dict(street_way=e["way"], street_z=round(float(G[k[h], 2]), 2),
                                                            rail_z=round(float(rlx[v, 2]), 2),
                                                            rail_bridge_flag=True,
                                                            note="the street meets the track at its level where the model "
                                                                 "infers a rail bridge; decide: level crossing (drop the "
                                                                 "inferred structure) or underpass (split the node)"),
                                       refs=refs(*xy)))
                    inter.append(dict(type="road_x_rail", outcome="review", xy=xy))
    report["counts"]["interactions"] = len(inter)

    # ---- 7. band layout (platforms), frontage, sections / sweeps / node meshes (primgeom), lanes
    for e in edges:
        a = assets[e["asset"]]
        e["platforms"] = find_platforms(e, a, stops)
        e["band_left"], e["band_w"] = layout(e, a)
    frontage(edges, assets, bbox, report)
    from . import primgeom
    geo_ped, marks, poles, props = primgeom.build_geometry(edges, nodes, assets, report, bbox)
    # rail corridor primitives (tracks, shared bed, slopes / walls, fences, street-over-rail
    # structures, level crossings) from the model's rail pieces and the street sweeps
    from . import primrail
    rail = primrail.build(edges, A, bbox, report)
    jn = {n_["key"] for n_ in nodes if n_["type"] == "junction"}
    short = [frozenset((int(e["a"]), int(e["b"]))) for e in edges if "_s01" in e and not e.get("internal") and e["a"] in jn and e["b"] in jn
             and e["a"] != e["b"] and e["_s01"][1] - e["_s01"][0] < SHORT_BETWEEN]
    report["short_between_junctions"] = [sorted(x) for x in short]
    report["forced_merges"] = [sorted(x) for x in force]
    lanes, paths, ped = lanes_and_paths(edges, nodes, node_of, assets, stops, tram_pts)
    # pedestrian mesh from the sections (sidewalks, corners, crosswalks) + platforms
    ped = geo_ped + [p_ for p_ in ped if p_["kind"] == "platform"]
    ped = ped_mesh_cleanup(ped, edges, report)
    report["counts"].update(edges=len(edges), nodes=len(nodes), lanes=len(lanes), paths=len(paths),
                            ped_segments=len(ped), review=len(review))

    # the sim graph inside the slice comes from the same lanes (drawn = driven)
    graph_report = write_graph(edges, nodes, assets, jmem, jsig, bbox, out_dir, drive_nodes,
                               {w for e in edges if e.get("lot") for w in e["ways"]}, ped=ped)
    report["graph"] = graph_report
    # output: what lies in the bbox (edges with a vertex inside, their nodes)
    def inside(P, pad=0.0):
        return ((P[:, 0] > x0 - pad) & (P[:, 0] < x1 + pad) & (P[:, 1] > y0 - pad) & (P[:, 1] < y1 + pad)).any()
    keep_e = {e["id"] for e in edges if inside(e["geom"])}
    keep_e |= {r["edge"] for n_ in nodes if x0 <= n_["xyz"][0] <= x1 and y0 <= n_["xyz"][1] <= y1 for r in n_["legs"]}
    edges_out = [e for e in edges if e["id"] in keep_e]
    keep_n = {n_["id"] for n_ in nodes if x0 <= n_["xyz"][0] <= x1 and y0 <= n_["xyz"][1] <= y1}
    # nodes of kept edges too (their meshes reach into the bbox; the edge ends at their rings)
    kept_keys = {e[k] for e in edges if e["id"] in keep_e for k in ("a", "b")}
    keep_n |= {n_["id"] for n_ in nodes if n_["key"] in kept_keys}
    nodes = [n_ for n_ in nodes if n_["id"] in keep_n]
    lanes = [l_ for l_ in lanes if l_["edge"] in keep_e]
    paths = [p_ for p_ in paths if p_["node"] in keep_n]
    ped = [p_ for p_ in ped if p_.get("edge") in keep_e or p_.get("node") in keep_n]
    edges = edges_out
    # junction box surfaces (plan mesh + heights), shared by primnet.json and surface.npz
    for n_ in nodes:
        M_ = n_.get("_mesh")
        n_["_patch"] = primgeom.box_patch(M_["box"]) if (M_ and not M_.get("boxfix")) else None
    out = {
        "version": 1, "bbox": list(bbox), "tag_table": [dict(tag=t, effect=e) for t, e in TAG_TABLE],
        "assets": list(assets.values()),
        "edges": [dict(id=e["id"], asset=e["asset"], source=e["source"], name=e["name"], cls=e["cls"], ways=e["ways"],
                       a=node_of[e["a"]]["id"] if e["a"] in node_of else -1, b=node_of[e["b"]]["id"] if e["b"] in node_of else -1,
                       xyz=np.round(e["geom"], 2).tolist(), platforms=e.get("platforms", []), driveways=e.get("driveways", []),
                       band_left=np.round(e["band_left"], 2).tolist() if "band_left" in e else None,
                       frontage=[np.round(e["frontage"][0], 2).tolist(), np.round(e["frontage"][1], 2).tolist()] if "frontage" in e else None,
                       band_w=np.round(e["band_w"], 2).tolist() if "band_w" in e else None,
                       sweep=primgeom.export_edge(e) if "_rows" in e else None) for e in edges],
        "nodes": [dict({k: v for k, v in n_.items() if not k.startswith("_")}, mesh=primgeom.export_node(n_)) for n_ in nodes],
        "marks": marks, "poles": poles, "props": props,
        "lanes": lanes, "paths": paths, "ped": ped, "interactions": inter,
        "tram_special_work": special_work(nodes, tram_pts, ttree),
        "rail": rail,
        # z of the model this slice was cut from: the lidar vertical solve (tpipe.lidar_terrain) -- the
        # client draws it as is, without lifting it to the (coarser) tile terrain
        "z_source": "lidar" if json.loads((geo.WORK / "roadnet_report.json").read_text()).get("terrain_samples", {}).get("hrdem_dtm_1m") else "terrain",
    }
    write_surface(edges, nodes, assets, out_dir or (geo.OUT / "net2"), rail)
    qa_counts, qa_items = qa(out, edges, assets)
    for k_, v_ in primrail.qa(rail, edges, inter).items():
        qa_counts[k_] = len(v_)
        qa_items[k_] = v_
    inv, dropped, accepted = primgeom.invariants(edges, nodes, assets, bbox, geo.OUT / "tiles" / "0",
                                       {nm for cs in cur if cs.get("status") is None and any(b["kind"] == "transit_row" for b in cs["bands"]) for nm in cs["names"]})
    inv["band_tiling_gap"] = band_tiling_gap(edges)
    qa_counts.update(inv)
    qa_items["dropped_uncovered"] = dropped
    qa_items["old_footprint_overshoot_accepted"] = accepted
    report["old_footprint_overshoot_accepted"] = accepted
    for x in dropped:
        review.append(dict(id=f"uncovered_{x['way']}_{int(x['xy'][0])}_{int(x['xy'][1])}", category="dropped_uncovered",
                           xy=x["xy"], evidence=dict(way=x["way"], area_m2=x["area"], on_city_pavement=x["on_pavement"],
                                                     verdict=x["verdict"],
                                                     note="old tile street area not produced by the model; fraction on the "
                                                          "City's surveyed edge-of-roadway pavement given"),
                           refs=refs(*x["xy"])))
    out["qa"] = qa_counts
    report["qa"] = qa_counts
    od = out_dir or (geo.OUT / "net2")
    od.mkdir(parents=True, exist_ok=True)
    (od / "qa.json").write_text(json.dumps(dict(counts=qa_counts, items=qa_items), indent=1, default=_js))
    (od / "primnet.json").write_text(json.dumps(out, separators=(",", ":"), default=_js))
    (od / "bbox.json").write_text(json.dumps(dict(bbox=list(bbox), rail=bool(rail))))      # tile worker: roads (and rail) replaced here
    (od / "interactions_report.json").write_text(json.dumps(dict(report, counts=dict(report["counts"])), indent=1, default=_js))
    # the network model against the lidar DTM in the slice (tpipe.qa.checks_dtm, the region gate): large,
    # sustained differences are model questions (topology / levels) for review, with the evidence links
    try:
        # in a subprocess: rasterio (lidar) and pyogrio (City pavement) bundle different GDALs
        import subprocess
        import sys
        subprocess.run([sys.executable, "-m", "tpipe.qa.checks_dtm", "--bbox=" + ",".join(str(v) for v in bbox)],
                       check=True, capture_output=True, cwd=str(geo.PIPE))
        for f_ in json.loads((geo.OUT / "qa" / "model_vs_dtm.json").read_text())["findings"]:
            n_v = int(f_["desc"].split(" over ")[1].split()[0]) if " over " in f_["desc"] else 1
            dz_ = float(f_["desc"].split(" z ")[1].split(" m")[0]) if " z " in f_["desc"] else 0.0
            if abs(dz_) >= 3.0 and n_v >= 5:
                review.append(dict(id=f"model_vs_dtm_{f_['sub']}_{round(f_['e'])}_{round(f_['n'])}", category="model_vs_dtm",
                                   xy=[f_["e"], f_["n"]], evidence=dict(desc=f_["desc"], osm=f_["osm"], model_z=f_["z"],
                                   note="model z far from the lidar DTM outside structures: check topology (a way joining "
                                        "two levels), a missing bridge / tunnel tag, or a curated level"),
                                   refs=refs(f_["e"], f_["n"])))
    except Exception as ex:      # the lidar is optional
        print("primnet: model_vs_dtm review skipped:", ex)
    (od / "review_queue.json").write_text(json.dumps(dict(items=review), indent=1, default=_js))
    print(f"primnet: {len(edges)} edges, {len(nodes)} nodes, {len(assets)} assets, {len(lanes)} lanes, "
          f"{len(paths)} turning paths, {len(ped)} ped segments, {len(inter)} interactions, {len(review)} review items, qa {qa_counts} "
          f"-> {od} ({time.time() - t0:.0f}s)", flush=True)
    return out


FRONTAGE_MAX = 8.0      # m: hardscape from the sidewalk to the building line up to this (CROSS_SECTION.md)
FRONTAGE_SEEK = 15.0    # m: a facade further than this is not a frontage (open ground, a mapped lawn)


def frontage(edges, assets, bbox, report):
    """frontage band per edge side and vertex: from the outer edge of the cross-section (the
    sidewalk's outer edge) to the nearest building facade along the normal, capped at
    FRONTAGE_MAX; 0 where no facade lies within FRONTAGE_SEEK (the ground stays as mapped)."""
    import shapely
    x0, y0, x1, y1 = bbox
    with np.load(geo.WORK / "osm_buildings.npz", allow_pickle=True) as f:
        xy, ringlen, nring = f["xy"], f["ringlen"], f["nring"]
    ro = np.concatenate([[0], np.cumsum(ringlen.astype(np.int64))])
    po = np.concatenate([[0], np.cumsum(nring.astype(np.int64))])
    r0 = ro[po[:-1]]
    rl = ro[po[:-1] + 1] - r0
    fx, fy = xy[r0, 0], xy[r0, 1]
    sel = np.nonzero((fx > x0 - 300) & (fx < x1 + 300) & (fy > y0 - 300) & (fy < y1 + 300) & (rl >= 3))[0]
    polys = [shapely.Polygon(xy[r0[i]:r0[i] + rl[i]]) for i in sel]
    polys = [p_ for p_ in polys if p_.is_valid and p_.area > 4]
    if not polys:
        return
    tree = shapely.STRtree(polys)
    n_h = 0
    for e in edges:
        if "band_left" not in e or e.get("lot"):
            continue
        G = e["geom"]
        _, nrm = normals(G)
        Lf, W = e["band_left"], e["band_w"]
        outs = []
        for side in (1, -1):
            if e.get("median_side") == side:
                outs.append(np.zeros(len(G)))           # the divided pair's median: no frontage
                continue
            edge_off = Lf[:, 0] if side > 0 else Lf[:, -1] - W[:, -1]
            start = G[:, :2] + nrm * edge_off[:, None]
            end = start + side * nrm * FRONTAGE_SEEK
            rays = shapely.linestrings(np.stack([start, end], 1))
            dist = np.full(len(G), np.inf)
            ri, pi = tree.query(rays, predicate="intersects")
            if len(ri):
                inter = shapely.intersection(rays[ri], np.array(polys, dtype=object)[pi])
                d = shapely.distance(shapely.points(start[ri]), inter)
                np.minimum.at(dist, ri, d)
            w = np.where(np.isfinite(dist), np.minimum(dist, FRONTAGE_MAX), 0.0)
            # isolated gaps (a driveway, a lane between buildings) keep the paving: close short runs
            outs.append(w)
            n_h += int((w > 0).sum())
        e["frontage"] = outs
    report["counts"]["frontage_vertices"] = n_h


# ------------------------------------------------------------------ surface interface
NB_KIND = {k: i for i, k in enumerate(["lane", "shoulder", "bike_lane", "parking", "median", "transit_row", "platform",
                                        "sidewalk", "furniture", "boulevard", "frontage", "curb", "bed", "building_edge"])}
NB_KIND["frontage_walk"] = NB_KIND["frontage"]     # the walk extension is the frontage kind (clearway)
NB_MAT = {k: i for i, k in enumerate(["asphalt", "concrete", "grass", "pavers", "ballast"])}
NB_H = {"sidewalk": 0.15, "furniture": 0.15, "boulevard": 0.15, "frontage": 0.15, "curb": 0.15,
        "transit_row": 0.15, "platform": 0.35, "median": 0.15, "frontage_walk": 0.15, "building_edge": 0.15}


def _mat(b):
    k, sf = b["kind"], b.get("surface")
    if sf in NB_MAT:
        return NB_MAT[sf]
    if k in ("sidewalk", "curb", "platform", "median"):
        return NB_MAT["concrete"]
    if k in ("furniture", "building_edge"):
        return NB_MAT["pavers"]
    if k in ("frontage", "frontage_walk"):
        return NB_MAT["concrete"]
    if k == "boulevard":
        return NB_MAT["grass"]
    if k == "transit_row":
        return NB_MAT["concrete"]
    return NB_MAT["asphalt"]


def _node_geometry(nd):
    """box ring (curb line, curb returns as quadratic curves through the curb-line intersection) and
    per corner the curb-return polyline -- the same construction as app/src/net2/gen.ts genNode"""
    p0 = np.array(nd["xyz"][:2])
    legs = sorted(nd["legs"], key=lambda r: r["ang"])
    H = [np.array([math.cos(r["ang"]), math.sin(r["ang"])]) for r in legs]
    N = [np.array([-h[1], h[0]]) for h in H]
    at = lambda i, d, lat: p0 + H[i] * d + N[i] * lat  # noqa: E731

    def curve(a, ha, b, hb):
        den = ha[0] * hb[1] - ha[1] * hb[0]
        c = (a + b) / 2
        if abs(den) > 1e-3:
            t = ((b[0] - a[0]) * hb[1] - (b[1] - a[1]) * hb[0]) / den
            if -60 < t < 60:
                c = a + ha * t
        ts = np.linspace(0, 1, 9)[:, None]
        return (1 - ts) ** 2 * a + 2 * (1 - ts) * ts * c + ts ** 2 * b
    ring, returns = [], []
    n = len(legs)
    for i in range(n):
        l, j = legs[i], (i + 1) % n
        m = legs[j]
        rc, lc = at(i, l["setback"], -l["hw_r"]), at(i, l["setback"], l["hw_l"])
        rcn = at(j, m["setback"], -m["hw_r"])
        cur = curve(lc, H[i], rcn, H[j])
        ring += [rc, lc] + list(cur[1:-1])
        returns.append(cur)
    return np.array(ring), returns


def write_surface(edges, nodes, assets, od, rail=None):
    """The surface builder's input (docs/SURFACE.md; replaces its infer_bands()), from the drawn
    sections (tpipe.primgeom): per segment its sweep stations (centre + model z), the ordered
    bands (frontage, asset bands, frontage) with kind / material / top height and per-station
    signed lateral offsets u0 > u1 (+ left): band i's u1 IS band i+1's u0 (one shared boundary
    array per station, so bands tile edge to edge). Events (platforms, driveways), node boxes
    and corner polygons (built from the same ring points), curb returns. File: OUT/net2/surface.npz."""
    od.mkdir(parents=True, exist_ok=True)
    seg_xyz, seg_off, nb_off, nb_kind, nb_mat, nb_h, nb_u0, nb_u1, nb_uoff = [], [0], [0], [], [], [], [], [], [0]
    ne_seg, ne_s0, ne_s1, ne_band, ne_kind = [], [], [], [], []
    sid = 0
    for e in edges:
        rows = e.get("_rows")
        if not rows or len(rows) < 2:
            continue
        a = assets[e["asset"]]
        C = np.array([r["c"] for r in rows])
        U = np.array([r["U"] for r in rows])
        Hh = np.array([r["H"] for r in rows])
        seg_xyz.append(C); seg_off.append(seg_off[-1] + len(C))
        bands = [{"kind": "building_edge"}, {"kind": "frontage_walk"}] + a["bands"] + [{"kind": "frontage_walk"}, {"kind": "building_edge"}]
        for j, b in enumerate(bands):
            nb_kind.append(NB_KIND.get(b["kind"], NB_KIND["lane"]))
            nb_mat.append(_mat(b))
            nb_h.append(float(np.max(Hh[:, j])) if b["kind"] != "platform" else 0.35)
            nb_u0.append(U[:, j].astype(np.float32)); nb_u1.append(U[:, j + 1].astype(np.float32))
            nb_uoff.append(nb_uoff[-1] + len(U))
        nb_off.append(len(nb_kind))
        s_rows = np.array([r["s"] for r in rows])
        for p_ in e.get("platforms", []):
            ne_seg.append(sid); ne_s0.append(p_["s0"] - s_rows[0]); ne_s1.append(p_["s1"] - s_rows[0])
            ne_band.append(p_["band"] + 2); ne_kind.append(0)                               # 0 platform
        for d_ in e.get("driveways", []):                                                 # 1 driveway
            bi = 0 if d_["side"] > 0 else len(a["bands"]) - 1
            ne_seg.append(sid); ne_s0.append(d_["s"] - d_["w"] / 2 - s_rows[0]); ne_s1.append(d_["s"] + d_["w"] / 2 - s_rows[0])
            ne_band.append(bi + 2); ne_kind.append(1)
        sid += 1
    nd_xy, nd_off, nd_z, nd_zv, nd_id = [], [0], [], [], []
    nc_xy, nc_off, nc_h, nc_z, nc_node, nc_corner = [], [0], [], [], [], []
    nw_xyz, nw_off, nl_xyz, nl_off = [], [0], [], [0]
    np_xyz, np_off, nt_tri, nt_off, np_node = [], [0], [], [0], []
    for nd in nodes:
        M = nd.get("_mesh")
        if not M:
            continue
        ring = np.array([p for p, _ in M["box"]])
        nd_xy.append(ring); nd_off.append(nd_off[-1] + len(ring)); nd_z.append(float(np.mean([z for _, z in M["box"]])))
        nd_zv.append(np.array([z for _, z in M["box"]])); nd_id.append(nd["id"])
        legs = nd["_rings"]
        n_l = len(legs)
        for i in range(n_l):
            if M["par"][i]:
                continue
            L, R = legs[i], legs[(i + 1) % n_l]
            # full curves ring point -> interior -> ring point, with heights (carriageway level; the
            # walk top is + nc_h)
            for pts, zs, kA, kB, dst, off in ((M["rets"][i], M["retz"][i], "cwL", "cwR", nc_xy, nc_off),
                                              (M["walks"][i], M["walkz"][i], "walkL", "walkR", nw_xyz, nw_off),
                                              (M["bldgs"][i], M["bldgz"][i], "bldgL", "bldgR", nl_xyz, nl_off)):
                P = np.vstack([L["pts"][L["idx"][kA]], np.asarray(pts).reshape(-1, 2), R["pts"][R["idx"][kB]]])
                Z = np.concatenate([[L["z"]], np.asarray(zs), [R["z"]]])
                dst.append(np.column_stack([P, Z])); off.append(off[-1] + len(P))
            nc_h.append(0.15); nc_node.append(nd["id"]); nc_corner.append(i)
        pt = nd.get("_patch")
        if pt:
            np_xyz.append(np.column_stack([np.array(pt["p"]), np.array(pt["z"])])); np_off.append(np_off[-1] + len(pt["p"]))
            nt_tri.append(np.array(pt["t"], np.uint32).reshape(-1, 3)); nt_off.append(nt_off[-1] + len(pt["t"]))
            np_node.append(nd["id"])
    nc_xyz = nc_xy
    cat = lambda L, dt, c=None: (np.vstack(L) if c else np.concatenate(L)).astype(dt) if L else np.zeros((0, c) if c else 0, dt)  # noqa: E731
    np.savez_compressed(
        od / "surface.npz",
        seg_off=np.array(seg_off, np.uint32), seg_xyz=cat(seg_xyz, np.float64, 3),
        nb_off=np.array(nb_off, np.uint32), nb_kind=np.array(nb_kind, np.uint8), nb_mat=np.array(nb_mat, np.uint8),
        nb_h=np.array(nb_h, np.float32), nb_uoff=np.array(nb_uoff, np.uint32), nb_u0=cat(nb_u0, np.float32),
        nb_u1=cat(nb_u1, np.float32),
        ne_seg=np.array(ne_seg, np.uint32), ne_s0=np.array(ne_s0, np.float32), ne_s1=np.array(ne_s1, np.float32),
        ne_band=np.array(ne_band, np.uint16), ne_kind=np.array(ne_kind, np.uint8),
        nd_off=np.array(nd_off, np.uint32), nd_xy=cat(nd_xy, np.float64, 2), nd_z=np.array(nd_z, np.float32),
        nd_zv=cat(nd_zv, np.float32), nd_id=np.array(nd_id, np.int32),
        nc_off=np.array(nc_off, np.uint32), nc_xy=cat([c[:, :2] for c in nc_xyz], np.float64, 2),
        nc_z=cat([c[:, 2] for c in nc_xyz], np.float32), nc_h=np.array(nc_h, np.float32),
        nc_node=np.array(nc_node, np.int32), nc_corner=np.array(nc_corner, np.uint8),
        nw_off=np.array(nw_off, np.uint32), nw_xyz=cat(nw_xyz, np.float64, 3),
        nl_off=np.array(nl_off, np.uint32), nl_xyz=cat(nl_xyz, np.float64, 3),
        np_off=np.array(np_off, np.uint32), np_xyz=cat(np_xyz, np.float64, 3),
        nt_off=np.array(nt_off, np.uint32), nt_tri=cat(nt_tri, np.uint32, 3), np_node=np.array(np_node, np.int32),
        **rail_arrays(rail),
        kinds=np.array([k for k in NB_KIND if k != "frontage_walk"]), mats=np.array(list(NB_MAT)))
    print(f"primnet surface: {sid} segments, {len(nb_kind)} bands, {len(ne_seg)} events, {len(nd_z)} node boxes, "
          f"{len(nc_h)} corners (curb / walk / building-line curves with z), {len(np_node)} box patches "
          f"-> {od / 'surface.npz'}", flush=True)

def rail_arrays(rail):
    """surface.npz arrays of the rail primitives (docs/SPEC.md): bed meshes rb_ / rbt_, track bands
    rt_, slopes rs_, walls rw_, fences rf_, structures st_ (deck footprints) / sa_ (abutment lines,
    seat z) / sp_ (pier column footprints, top z)"""
    def offs(L):
        o = [0]
        for x in L:
            o.append(o[-1] + len(x))
        return np.array(o, np.uint32)

    def cat(L, c, dt=np.float64):
        return np.vstack([np.asarray(x, dt).reshape(-1, c) for x in L]).astype(dt) if L else np.zeros((0, c), dt)
    if not rail:
        return {}
    bedV = [np.column_stack([np.array(m["p"]), np.array(m["z"])]) for m in rail["bed"]]
    bedT = [np.array(m["t"], np.uint32).reshape(-1, 3) for m in rail["bed"]]
    trk = [np.array(t["xyz"]) for t in rail["tracks"]]
    sl_in = [np.array(x["inner"]) for x in rail["slopes"]]
    sl_out = [np.array(x["outer"]) for x in rail["slopes"]]
    wl = [np.array(x["xy"]) for x in rail["walls"]]
    fe = [np.array(x["xyz"]) for x in rail["fences"]]
    st = rail["structures"]
    deck = [np.array(x["deck"]) for x in st]
    abut = [np.array(a) for x in st for a in x["abutments"]]
    seat = [z for x in st for z in x["seat"]]
    piers = [np.array(c) for x in st for p in x["piers"] for c in p["cols"]]
    ptop = [p["ztop"] for x in st for p in x["piers"] for _ in p["cols"]]
    return dict(
        rb_off=offs(bedV), rb_xyz=cat(bedV, 3), rbt_off=offs(bedT), rbt_tri=cat(bedT, 3, np.uint32),
        rt_off=offs(trk), rt_xyz=cat(trk, 3), rt_hw=np.array([t["hw"] for t in rail["tracks"]], np.float32),
        rt_cls=np.array([t["cls"] for t in rail["tracks"]], np.uint8),
        rt_bridge=np.concatenate([np.array(t["bridge"], np.uint8) for t in rail["tracks"]]) if trk else np.zeros(0, np.uint8),
        rs_off=offs(sl_in), rs_in=cat(sl_in, 3), rs_out=cat(sl_out, 3),
        rs_kind=np.array([1 if x["kind"] == "cut" else 0 for x in rail["slopes"]], np.uint8),
        rw_off=offs(wl), rw_xy=cat(wl, 2), rw_zb=np.concatenate([np.array(x["zb"], np.float32) for x in rail["walls"]]) if wl else np.zeros(0, np.float32),
        rw_zt=np.concatenate([np.array(x["zt"], np.float32) for x in rail["walls"]]) if wl else np.zeros(0, np.float32),
        rf_off=offs(fe), rf_xyz=cat(fe, 3), rf_h=np.array([x["h"] for x in rail["fences"]], np.float32),
        st_off=offs(deck), st_xy=cat(deck, 2), st_z=np.array([float(np.mean(x["deck_z"])) for x in st], np.float32),
        sa_off=offs(abut), sa_xyz=cat(abut, 3), sa_seat=np.array(seat, np.float32),
        sp_off=offs(piers), sp_xy=cat(piers, 2), sp_ztop=np.array(ptop, np.float32))


def ped_mesh_cleanup(ped, edges, report):
    """pedestrian mesh as a network (INTERACTIONS.md "Pedestrian network"): sidewalk stretches lying
    on another edge's carriageway are cut out (the walk crosses there as a crosswalk / mouth), and
    every walkable end within 3 m of another walkable element is joined to it by a link."""
    import shapely
    carr = []
    for e in edges:
        rows = e.get("_rows")
        if not rows or len(rows) < 2:
            continue
        ix = e["_idx"]
        Lp = [r["c"][:2] + r["n"] * r["U"][ix["cwL"]] for r in rows]
        Rp = [r["c"][:2] + r["n"] * r["U"][ix["cwR"]] for r in rows]
        g = shapely.Polygon(Lp + Rp[::-1]).buffer(0)
        if not g.is_empty:
            carr.append((e["id"], g))
    tree = shapely.STRtree([g for _, g in carr])
    out, cut = [], 0
    for p_ in ped:
        if p_["kind"] != "sidewalk" or len(p_["xyz"]) < 2:
            out.append(p_)
            continue
        P = np.array(p_["xyz"])
        pts = shapely.points(P[:, :2])
        inside = np.zeros(len(P), bool)
        for j in tree.query(shapely.multipoints(P[:, :2]), predicate="intersects"):
            eid, g = carr[j]
            if eid == p_.get("edge"):
                continue
            inside |= shapely.contains(g, pts)
        if not inside.any():
            out.append(p_)
            continue
        cut += int(inside.sum())
        k = 0
        while k < len(P):
            if inside[k]:
                k += 1
                continue
            j = k
            while j + 1 < len(P) and not inside[j + 1]:
                j += 1
            if j > k:
                out.append(dict(p_, xyz=P[k:j + 1].tolist()))
            k = j + 1
    # links at dangling ends
    allp = np.vstack([np.array(q["xyz"])[:, :2] for q in out if len(q["xyz"]) >= 1])
    own = np.concatenate([np.full(len(q["xyz"]), i) for i, q in enumerate(out)])
    t = cKDTree(allp)
    links = []
    for i, q in enumerate(out):
        if q["kind"] not in ("sidewalk", "platform") or len(q["xyz"]) < 2:
            continue
        for end in (q["xyz"][0], q["xyz"][-1]):
            near = [j for j in t.query_ball_point(end[:2], 3.0) if own[j] != i]
            if not near or any(np.hypot(*(allp[j] - end[:2])) < 0.75 for j in near):
                continue
            j = min(near, key=lambda j: np.hypot(*(allp[j] - end[:2])))
            zz = end[2] if len(end) > 2 else 0.0
            links.append(dict(kind="link", width=2.0, edge=q.get("edge"), node=q.get("node"),
                              xyz=[list(end), [float(allp[j][0]), float(allp[j][1]), zz]]))
    report["counts"]["ped_cut_vertices"] = cut
    report["counts"]["ped_links"] = len(links)
    return out + links


def band_tiling_gap(edges):
    """stations where adjacent bands do not share their edge (U must be non-increasing: every band's
    right edge is its right neighbour's left edge by construction; a crossing is an overlap)"""
    n = 0
    for e in edges:
        for r in e.get("_rows", []):
            if (np.diff(r["U"]) > 1e-6).any():
                n += 1
    return n


CAR = "car"


PED_JOIN = 2.5    # m: walking-mesh segment ends this close are one sim node (the mesh's ends sit on
                 # their own section lines; path_dangling's tolerance is 3 m)


def write_graph(edges, nodes, assets, jmem, jsig, bbox, out_dir, drive_nodes=frozenset(), lot_ways_sl=frozenset(), ped=()):
    """Traffic-sim graph tiles for the slice (tpipe.graph format, docs/SPEC.md): the tile graph's
    edges on the slice's ways are replaced by one one-way edge per direction of every primitive
    edge, running along the centre of that direction's car lanes (band layout: platform
    shifts included) from node to node -- the sim's lane offsets (LANE_W) then put its lanes on
    the drawn lane bands. Only lanes whose asset classes include cars are counted; tram, bike and
    parking bands are never in the car graph. Tiles are read from OUT/graph and written to
    OUT/net2/graph (the overlay a ?net=2 build serves as data/graph)."""
    from . import tbn
    x0, y0, x1, y1 = bbox
    S0 = geo.TILE_SIZE[0]
    gin = geo.OUT / "graph"
    gout = (out_dir or (geo.OUT / "net2")) / "graph"
    gout.mkdir(parents=True, exist_ok=True)
    node_by_key = {n_["key"]: n_ for n_ in nodes}
    net_ways = set()
    for e in edges:
        if not e.get("lot"):
            net_ways.update(e["ways"])
    roots = set(node_by_key)
    member_root = {m: r for m, r in jmem.items() if r in roots}
    # old graph (tiles around the slice)
    tiles = [(tx, ty) for tx in range(int(x0 // S0) - 1, int(x1 // S0) + 2) for ty in range(int(y0 // S0) - 1, int(y1 // S0) + 2)]
    E, names_all = [], []
    npos, nflag = {}, {}
    for tx, ty in tiles:
        p = gin / f"{tx}_{ty}.bin.gz"
        if not p.exists():
            continue
        a, h = tbn.read(p)
        ox, oy = tx * S0, ty * S0
        ids = a["n_id"].astype(np.int64)
        nx = a["n_xyz"].reshape(-1, 3).astype(np.float64)
        for i, n_ in enumerate(ids.tolist()):
            npos.setdefault(n_, [nx[i, 0] + ox, nx[i, 1] + oy, nx[i, 2]])
            nflag[n_] = nflag.get(n_, 0) | int(a["n_flags"][i])
        off = a["e_off"].astype(np.int64)
        ex = a["e_xyz"].reshape(-1, 3).astype(np.float64)
        nm = h.get("names", [])
        nm = json.loads(nm) if isinstance(nm, str) else list(nm)
        for e in range(len(a["e_from"])):
            g = ex[off[e]:off[e + 1]].copy()
            g[:, 0] += ox; g[:, 1] += oy
            E.append(dict(a=int(ids[a["e_from"][e]]), b=int(ids[a["e_to"][e]]), g=g, cls=int(a["e_class"][e]),
                          f=int(a["e_lanes_fwd"][e]), bw=int(a["e_lanes_bwd"][e]), v=float(a["e_speed"][e]),
                          osm=float(a["e_osm"][e]), name=nm[int(a["e_name"][e])] if int(a["e_name"][e]) < len(nm) else "", fl=int(a["e_flags"][e]),
                          w=float(a["e_width"][e]) if "e_width" in a else 0.0, side=int(a["e_side"][e]) if "e_side" in a else 0))
    speed_of = {e["osm"]: e["v"] for e in E}
    flags_of = {e["osm"]: e["fl"] for e in E}
    # keep the tile graph outside the slice's ways; reconnect cluster members to the node keys
    kept = []
    for e in E:
        if int(e["osm"]) in net_ways:
            continue
        if int(e["osm"]) in lot_ways_sl and (e["a"] in drive_nodes or e["b"] in drive_nodes):
            continue      # driveway onto a slice street: the street has no node there (a driveway event)
        e["a"] = member_root.get(e["a"], e["a"])
        e["b"] = member_root.get(e["b"], e["b"])
        kept.append(e)
    # slice edges: one per direction with car lanes
    added = 0
    for e in edges:
        if "band_left" not in e or e.get("lot") or e.get("internal"):
            continue
        a = assets[e["asset"]]
        G, Lf, W = e["geom"], e["band_left"], e["band_w"]
        _, nrm = normals(G)
        sb0 = next((r["setback"] for n_ in (node_by_key.get(e["a"]),) if n_ for r in n_["legs"] if r["edge"] == e["id"] and r["end"] == 0), 0.0)
        sb1 = next((r["setback"] for n_ in (node_by_key.get(e["b"]),) if n_ for r in n_["legs"] if r["edge"] == e["id"] and r["end"] == 1), 0.0)
        s = e["s"]
        m = (s >= sb0) & (s <= s[-1] - sb1)
        if m.sum() < 2:
            m[:] = True
        for d in (1, -1):
            idx = [i for i, b in enumerate(a["bands"]) if b["kind"] == "lane" and b.get("dir", 1) == d and CAR in b.get("classes", [])]
            if not idx:
                continue
            mid = np.mean([Lf[:, i] - W[:, i] / 2 for i in idx], axis=0)
            P = np.column_stack([G[m, :2] + nrm[m] * mid[m, None], G[m, 2]])
            na = node_by_key.get(e["a"]); nb = node_by_key.get(e["b"])
            pa = na["xyz"] if na else npos.get(e["a"], G[0].tolist())
            pb = nb["xyz"] if nb else npos.get(e["b"], G[-1].tolist())
            g = np.vstack([[pa], P, [pb]])
            A_, B_ = e["a"], e["b"]
            if d < 0:
                g = g[::-1]; A_, B_ = B_, A_
            npos[A_] = list(pa if d > 0 else pb); npos[B_] = list(pb if d > 0 else pa)
            # pedestrians (sim peds.rs) walk at ped_off = width / 2 + SIDEWALK_W[cls] / 2 from this
            # direction's edge, on the sides e_side allows: put that line on the centre of the walk band
            # on the outer (right-of-travel) side; no walk band -> no sidewalk peds on this edge
            # (interim, from the asset agent; the real fix is the net2 pedestrian graph)
            wk = [i for i, b in enumerate(a["bands"]) if b["kind"] == "sidewalk"]
            wk = [i for i in wk if (i > max(idx)) == (d > 0)]
            w_ = float(sum(W[len(W) // 2, i] for i in idx)); side_ = 1
            if wk:
                j = wk[-1] if d > 0 else wk[0]
                k_ = len(W) // 2
                dw = abs(float(mid[k_] - (Lf[k_, j] - W[k_, j] / 2)))
                SW = [0.0, 0.0, 3.2, 2.8, 2.4, 1.9, 0.0][min(int(e["cls"]), 6)]
                w_ = max(w_, 2 * (dw - SW / 2)); side_ = 3      # e_side 3 = sim side bit 1 = right of travel (+lat)
            kept.append(dict(a=int(A_), b=int(B_), g=g, cls=e["cls"], f=len(idx), bw=0, v=speed_of.get(float(e["way"]), 40 / 3.6),
                             osm=float(e["way"]), name=e["name"], fl=flags_of.get(float(e["way"]), 1) | 1, w=w_, side=side_, pedmesh=1))
            added += 1
    for n_ in nodes:
        npos[n_["key"]] = n_["xyz"]
        f = (nflag.get(n_["key"], 0) & 3) | (1 if n_["signal"] else 0)
        if n_["type"] == "junction":
            # the sim's stop line (n_flags bits 2-7, whole metres): behind the widest leg's stop bar
            # (crosswalk setback + 0.3 .. + 3.3, stop bar at + 4.2 .. 4.6: gen.ts genNode)
            sb = max((r["setback"] for r in n_["legs"]), default=0.0) + 4.4
            f |= min(63, int(round(sb))) << 2
        nflag[n_["key"]] = f
    # the walking mesh (sim pednet.rs): segment ends within PED_JOIN are one node (keys from 2**51, never an
    # OSM id or a junction key); a crosswalk carries the key of the junction it crosses at
    ekey0 = {e["id"]: e for e in edges}

    def has_walk(eid):
        e = ekey0.get(eid)
        return e is None or any(b["kind"] == "sidewalk" for b in assets[e["asset"]]["bands"])
    # (a laneway / service lane has no walk: its carriageway is not part of the walking mesh)
    pseg = [p_ for p_ in ped if len(p_["xyz"]) >= 2 and p_["kind"] in ("sidewalk", "corner", "link", "crosswalk", "platform", "ramp")
            and not (p_["kind"] == "sidewalk" and not has_walk(p_.get("edge")))]
    # the walking mesh never runs on a carriageway (corner arcs towards a laneway that has no walk):
    # only crosswalks and platforms lie in the street
    import shapely
    cw, cw_lane = [], []
    for e in edges:
        rows = e.get("_rows")
        if not rows or len(rows) < 2 or e.get("internal"):
            continue
        ix = e["_idx"]
        Lp = [r["c"][:2] + r["n"] * r["U"][ix["cwL"]] for r in rows]
        Rp = [r["c"][:2] + r["n"] * r["U"][ix["cwR"]] for r in rows]
        g = shapely.Polygon(np.vstack([Lp, Rp[::-1]])).buffer(-0.3)
        if not g.is_empty:
            (cw if has_walk(e["id"]) else cw_lane).append(g)
    for nd in nodes:                       # junction boxes are carriageway too
        M_ = nd.get("_mesh")
        if M_ and M_.get("box"):
            g = shapely.Polygon(np.array([p_[0] for p_ in M_["box"]])).buffer(0).buffer(-0.3)
            if not g.is_empty:
                cw.append(g)
    if cw or cw_lane:
        cwu = shapely.union_all(cw + cw_lane)
        cws = shapely.union_all(cw) if cw else shapely.GeometryCollection()
        shapely.prepare(cwu)
        n0 = len(pseg)

        def on_cw(p_):
            g = shapely.LineString(np.array(p_["xyz"])[:, :2])
            return g.intersection(cwu).length > 0.08 * g.length
        pseg = [p_ for p_ in pseg if p_["kind"] in ("crosswalk", "platform") or not on_cw(p_)]
        # laneway / service mouths: the street's walk continues across (a mouth crossing between the
        # two loose ends either side, crossing only the lane's carriageway)
        ends = defaultdict(int)
        endp = {}
        for p_ in pseg:
            for q in (p_["xyz"][0], p_["xyz"][-1]):
                k_ = (round(q[0] / PED_JOIN), round(q[1] / PED_JOIN))
                ends[k_] += 1
                endp.setdefault(k_, q)
        loose = [endp[k_] for k_, c_ in ends.items() if c_ == 1]
        n_m = 0
        if loose:
            Lq = np.array(loose, np.float64)
            used = set()
            for i, j in sorted(cKDTree(Lq[:, :2]).query_pairs(14.0), key=lambda ij: np.hypot(*(Lq[ij[0], :2] - Lq[ij[1], :2]))):
                if i in used or j in used:
                    continue
                ln = shapely.LineString([Lq[i, :2], Lq[j, :2]])
                if not ln.intersects(cwu) or (cw and ln.intersection(cws).length > 0.5):
                    continue
                pseg.append(dict(kind="crosswalk", mouth=True, width=2.0, xyz=[Lq[i].tolist(), Lq[j].tolist()]))
                used |= {i, j}
                n_m += 1
        print(f"primnet graph: walking mesh {len(pseg)} segments ({n0 + n_m - len(pseg)} on a carriageway left out, {n_m} lane mouths)")
    pbins = defaultdict(list)
    qkey = []
    if pseg:
        ends = np.array([q[:2] for p_ in pseg for q in (p_["xyz"][0], p_["xyz"][-1])], np.float64)
        par = np.arange(len(ends))

        def fnd(i):
            while par[i] != i:
                par[i] = par[par[i]]
                i = par[i]
            return i
        for a_, b_ in cKDTree(ends).query_pairs(PED_JOIN):
            ra, rb = fnd(a_), fnd(b_)
            if ra != rb:
                par[ra] = rb
        roots = {}
        qkey = [float(2 ** 51 + roots.setdefault(fnd(i), len(roots))) for i in range(len(ends))]
        cen = defaultdict(list)
        for i, k in enumerate(qkey):
            cen[k].append(ends[i])
        cen = {k: np.mean(v, axis=0) for k, v in cen.items()}
        ekey = {e["id"]: e for e in edges}
        for j, p_ in enumerate(pseg):
            xyz = np.array(p_["xyz"], np.float64)
            car = 0.0
            if p_["kind"] == "crosswalk" and p_.get("edge") in ekey:
                e = ekey[p_["edge"]]
                mid = xyz[len(xyz) // 2, :2]
                best = None
                for k_ in (e["a"], e["b"]):
                    nd = node_by_key.get(k_)
                    if nd is not None:
                        d = float(np.hypot(*(np.array(nd["xyz"][:2]) - mid)))
                        if best is None or d < best[0]:
                            best = (d, k_)
                car = float(best[1]) if best else 0.0
            mp = xyz[len(xyz) // 2]
            pbins[(int(mp[0] // S0), int(mp[1] // S0))].append((qkey[2 * j], qkey[2 * j + 1], xyz, p_, car))
    # bin by midpoint tile (as tpipe.graph) and write
    bins = defaultdict(list)
    for e in kept:
        g = e["g"]
        mp = g[len(g) // 2]
        bins[(int(mp[0] // S0), int(mp[1] // S0))].append(e)
    n_t = 0
    for (tx, ty), lst in bins.items():
        ox, oy = tx * S0, ty * S0
        look, n_id, n_xyz, n_fl = {}, [], [], []

        def node(k):
            if k not in look:
                look[k] = len(n_id)
                n_id.append(float(k))
                p = npos[k]
                n_xyz.append([p[0] - ox, p[1] - oy, p[2]])
                n_fl.append(nflag.get(k, 0))
            return look[k]
        names = []
        name_ix = {}
        e_from, e_to, cnts, geo_, rows = [], [], [], [], []
        for e in lst:
            e_from.append(node(e["a"])); e_to.append(node(e["b"]))
            g = e["g"].copy()
            g[:, 0] -= ox; g[:, 1] -= oy
            geo_.append(g); cnts.append(len(g))
            if e["name"] not in name_ix:
                name_ix[e["name"]] = len(names); names.append(e["name"])
            rows.append(e)
        Gv = np.vstack(geo_)
        ln = [float(cumlen(g[:, :2])[-1]) for g in geo_]
        arrays = {
            "n_id": np.array(n_id, np.float64), "n_xyz": np.array(n_xyz, np.float32).ravel(), "n_flags": np.array(n_fl, np.uint8),
            "e_from": np.array(e_from, np.uint32), "e_to": np.array(e_to, np.uint32),
            "e_off": np.concatenate([[0], np.cumsum(cnts)]).astype(np.uint32), "e_xyz": Gv.astype(np.float32).ravel(),
            "e_len": np.array(ln, np.float32), "e_class": np.array([r["cls"] for r in rows], np.uint8),
            "e_lanes_fwd": np.array([r["f"] for r in rows], np.uint8), "e_lanes_bwd": np.array([r["bw"] for r in rows], np.uint8),
            "e_speed": np.array([r["v"] for r in rows], np.float32), "e_osm": np.array([r["osm"] for r in rows], np.float64),
            "e_name": np.array([name_ix[r["name"]] for r in rows], np.uint16), "e_flags": np.array([r["fl"] for r in rows], np.uint8),
            "e_width": np.array([r["w"] for r in rows], np.float32), "e_side": np.array([r["side"] for r in rows], np.uint8),
            "e_pedmesh": np.array([r.get("pedmesh", 0) for r in rows], np.uint8),
        }
        pl = pbins.pop((tx, ty), [])
        if pl:
            ql, q_key, q_xyz = {}, [], []

            def qn(k):
                if k not in ql:
                    ql[k] = len(q_key)
                    q_key.append(k)
                    c = cen[k]
                    q_xyz.append([c[0] - ox, c[1] - oy, 0.0])
                return ql[k]
            pf, pt, po, px, pk, pc, pw = [], [], [0], [], [], [], []
            for ka, kb, xyz, p_, car in pl:
                pf.append(qn(ka)); pt.append(qn(kb))
                g = xyz.copy()
                g[:, 0] -= ox; g[:, 1] -= oy
                px.append(g); po.append(po[-1] + len(g))
                q_xyz[ql[ka]][2] = float(xyz[0, 2]); q_xyz[ql[kb]][2] = float(xyz[-1, 2])
                pk.append(1 if p_["kind"] == "crosswalk" else 2 if p_["kind"] == "platform" else 0)
                pc.append(car); pw.append(float(p_.get("width", 2.0)))
            arrays.update({"q_key": np.array(q_key, np.float64), "q_xyz": np.array(q_xyz, np.float32).ravel(),
                           "p_from": np.array(pf, np.uint32), "p_to": np.array(pt, np.uint32),
                           "p_off": np.array(po, np.uint32), "p_xyz": np.vstack(px).astype(np.float32).ravel(),
                           "p_kind": np.array(pk, np.uint8), "p_car": np.array(pc, np.float64), "p_w": np.array(pw, np.float32)})
        tbn.write(gout / f"{tx}_{ty}.bin.gz", arrays, tx=tx, ty=ty, names=names)
        n_t += 1
    print(f"primnet graph: {added} slice edges (one per direction), {len(kept) - added} tile edges kept, {n_t} tiles -> {gout}")
    return dict(slice_edges=added, tiles=n_t)


def _js(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, (np.bool_,)):
        return bool(o)
    raise TypeError(type(o))


def min_radius(P, ids):
    """smallest radius of curvature (3-point circles over ~6 m) of the tram geometry near a node"""
    ids = np.array(sorted(ids))
    best = 99.0
    for pc in np.unique(P[ids, 3]):
        Q = P[ids[P[ids, 3] == pc], :2]
        for k in range(3, len(Q) - 3):
            a, b, c = Q[k - 3], Q[k], Q[k + 3]
            if np.hypot(*(a - b)) > 3.5 or np.hypot(*(c - b)) > 3.5:
                continue       # not consecutive on the track (clipped by the box radius)
            ab, bc, ca = np.hypot(*(a - b)), np.hypot(*(b - c)), np.hypot(*(c - a))
            area = abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2
            if area > 1e-3:
                best = min(best, ab * bc * ca / (4 * area))
    return best


def special_work(nodes, tram_pts, ttree):
    """streetcar track as drawn and driven: the model's tram rails (rail_geom.fillet geometry that
    the transit sim follows), embedded flush in the lanes, the ROW slab and the junction boxes.
    Returns [{piece, xyz, nodes: [junction ids whose box it crosses]}]."""
    out = []
    if not len(tram_pts):
        return out
    boxes = [(n_["id"], np.array(n_["xyz"][:2]), max((r["setback"] for r in n_["legs"]), default=0.0) + 3)
             for n_ in nodes if n_["type"] == "junction"]
    for pc in np.unique(tram_pts[:, 3]):
        Q = tram_pts[tram_pts[:, 3] == pc, :3]
        if len(Q) < 2:
            continue
        hit = sorted({nid for nid, c, r in boxes if (np.hypot(Q[:, 0] - c[0], Q[:, 1] - c[1]) < r).any()})
        out.append(dict(piece=int(pc), xyz=np.round(Q, 2).tolist(), nodes=hit))
    return out


def load_stops(bbox):
    """GTFS stops of the TTC rail file (streetcar + subway) in the bbox: [(x, y, name, routes)]"""
    from . import tbn
    x0, y0, x1, y1 = bbox
    p = geo.OUT / "transit" / "ttc_weekday_rail.bin.gz"
    if not p.exists():
        p = geo.PIPE.parent / "app" / "public" / "data" / "transit" / "ttc_weekday_rail.bin.gz"
    if not p.exists():
        return []
    a, h = tbn.read(p)
    routes = h.get("routes")
    routes = json.loads(routes) if isinstance(routes, str) else routes
    names = h.get("stopNames")
    names = json.loads(names) if isinstance(names, str) else names
    xyz = a["stop_xyz"].reshape(-1, 3)
    served = defaultdict(set)
    po = a["pat_stop_off"].astype(np.int64)
    for pt in range(len(a["pat_route"])):
        r = routes[int(a["pat_route"][pt])]["short"]
        for k in range(po[pt], po[pt + 1]):
            served[int(a["pat_stop"][k])].add(r)
    out = []
    for i, p_ in enumerate(xyz):
        if x0 - 150 <= p_[0] <= x1 + 150 and y0 - 150 <= p_[1] <= y1 + 150 and served[i]:
            out.append((float(p_[0]), float(p_[1]), names[i] if names else "", sorted(served[i])))
    return out


def find_platforms(e, a, stops):
    """platform bands of a transit_row at the stops of its routes (GTFS): side from the stop
    position, s range from the platform length"""
    G, s = e["geom"], e["s"]
    _, nrm = normals(G)
    out = []
    for bi, b in enumerate(a["bands"]):
        if b["kind"] != "transit_row" or "platforms" not in b:
            continue
        pl = b["platforms"]
        tr = cKDTree(G[:, :2])
        for (sx, sy, nm, rts) in stops:
            if not set(rts) & set(pl["routes"]):
                continue
            dd, k = tr.query([sx, sy])
            if dd > 25 or k in (0, len(G) - 1):
                continue
            lat = float((np.array([sx, sy]) - G[k, :2]) @ nrm[k])
            sc = float(s[k])
            out.append(dict(s0=round(sc - pl["platform_len"] / 2, 1), s1=round(sc + pl["platform_len"] / 2, 1),
                            side=1 if lat > 0 else -1, w=pl["w"], h=pl["h"], band=bi, stop=nm, routes=rts))
    return out


PLATFORM_TAPER = 15.0     # m: lanes shift over this length ahead of / behind a platform


def layout(e, a):
    """per-vertex band layout (left offset + width, m) along the edge: the asset's widths, with
    each platform taking its width from the curb lane (parking, else the outer lane) on its side
    and widening the transit_row there (lanes shift, the total stays), tapered."""
    s = e["s"]
    bands = a["bands"]
    W = np.tile(np.array([b["w"] for b in bands], np.float64), (len(s), 1))
    for p in e.get("platforms", []):
        f = np.clip(np.minimum(s - (p["s0"] - PLATFORM_TAPER), (p["s1"] + PLATFORM_TAPER) - s) / PLATFORM_TAPER, 0, 1)
        f = f * f * (3 - 2 * f)          # smoothstep: an S-shaped lane shift (reverse curves), no kinks
        W[:, p["band"]] += p["w"] * f
        # donor: the parking band on that side, else the outermost lane
        side_idx = range(p["band"] - 1, -1, -1) if p["side"] > 0 else range(p["band"] + 1, len(bands))
        donor = None
        for k in side_idx:
            if bands[k]["kind"] == "parking":
                donor = k
                break
        if donor is None:
            lanes_ = [k for k in side_idx if bands[k]["kind"] == "lane"]
            donor = lanes_[-1] if lanes_ else None
        if donor is not None:
            W[:, donor] = np.maximum(W[:, donor] - p["w"] * f, 0.0)
    # a divided pair's median half follows the local gap to the twin carriageway (halves meet in the
    # middle wherever the pair converges or spreads); bands outside it move with it, lanes stay
    shift = np.zeros(len(s))
    mj = [k for k, b in enumerate(bands) if b.get("pair_median")]
    if mj and e.get("_twin_geom") is not None:
        import shapely
        j = mj[0]
        tw = shapely.LineString(e["_twin_geom"][:, :2])
        gap = shapely.distance(shapely.points(e["geom"][:, :2]), tw)
        curbs = [k for k, b in enumerate(bands) if b["kind"] == "curb"]
        half = sum(b["w"] for k, b in enumerate(bands[curbs[0]:curbs[-1] + 1]) if not b.get("pair_median")) / 2
        wl = np.clip(gap / 2 - half, 0.0, bands[j]["w"] + 6.0)
        lanes_ = [k for k, b in enumerate(bands) if b["kind"] == "lane"]
        if lanes_ and j < lanes_[0]:
            shift = wl - W[:, j]           # left side: everything left of the lanes moves out
        W[:, j] = wl
    # left offsets: the centre stays at the middle between the outermost curbs of the base asset
    base_left = np.array(a["offsets"])
    Lf = np.empty_like(W)
    Lf[:, 0] = base_left[0] + shift
    for k in range(1, len(bands)):
        Lf[:, k] = Lf[:, k - 1] - W[:, k - 1]
    return Lf, W


def lanes_and_paths(edges, nodes, node_of, assets, stops, tram_pts):
    """lane lines per lane band (vehicle classes from the asset), turning paths per movement,
    tram paths, and the pedestrian mesh (sidewalk centrelines, crosswalks, platform edges)."""
    lanes, paths, ped = [], [], []
    setback = {}
    for n_ in nodes:
        for r in n_["legs"]:
            setback[(r["edge"], r["end"])] = r["setback"]
    lane_ends = defaultdict(list)       # node id -> [(lane id, end xy, heading, dir in/out, classes, leg)]
    for e in edges:
        if e.get("internal"):
            continue
        a = assets[e["asset"]]
        if "band_left" not in e:
            e["platforms"] = find_platforms(e, a, stops)
            e["band_left"], e["band_w"] = layout(e, a)
        Lf, W = e["band_left"], e["band_w"]
        G, s = e["geom"], e["s"]
        t, nrm = normals(G)
        s0 = setback.get((e["id"], 0), 0.0)
        s1 = s[-1] - setback.get((e["id"], 1), 0.0)
        if s1 - s0 < 2:
            continue
        m = (s >= s0) & (s <= s1)
        for bi, b in enumerate(a["bands"]):
            mid = Lf[:, bi] - W[:, bi] / 2
            if b["kind"] in ("lane", "bike_lane"):
                P = G[m, :2] + nrm[m] * mid[m, None]
                Z = G[m, 2]
                d = b.get("dir", 1)
                pts = np.column_stack([P, Z])
                if len(pts) < 2:
                    continue
                if d < 0:
                    pts = pts[::-1]
                lid = len(lanes)
                lanes.append(dict(id=lid, edge=e["id"], band=bi, classes=b.get("classes", ["car"]), dir=d,
                                  width=b["w"], xyz=np.round(pts, 2).tolist()))
                for end in (0, 1):
                    nd = node_of.get(e["a"] if end == 0 else e["b"])
                    if nd is None:
                        continue
                    # lane end at this node: in-bound when the lane runs towards it
                    inbound = (d > 0) == (end == 1)
                    q = pts[-1] if inbound else pts[0]
                    q2 = pts[-2] if inbound else pts[1]
                    h = math.atan2(q[1] - q2[1], q[0] - q2[0]) if inbound else math.atan2(q2[1] - q[1], q2[0] - q[0])
                    lane_ends[nd["id"]].append(dict(lane=lid, xy=q, head=h, inbound=inbound, classes=b.get("classes", []),
                                                    edge=e["id"], band=bi, d=d))
            if b["kind"] == "sidewalk":
                P = G[m, :2] + nrm[m] * mid[m, None]
                ped.append(dict(kind="sidewalk", edge=e["id"], band=bi, width=b["w"],
                                xyz=np.round(np.column_stack([P, G[m, 2] + 0.15]), 2).tolist()))
            if b["kind"] == "transit_row":
                # tram tracks (fixed offsets from the base ROW centre) = tram lanes
                base_mid = a["offsets"][bi] - b["w"] / 2
                for off_t, dt in zip(b.get("tracks", []), b.get("track_dir", [1] * len(b.get("tracks", [])))):
                    P = G[m, :2] + nrm[m] * (base_mid + off_t)
                    pts = np.column_stack([P, G[m, 2]])
                    if len(pts) < 2:
                        continue
                    if dt < 0:
                        pts = pts[::-1]
                    lanes.append(dict(id=len(lanes), edge=e["id"], band=bi, classes=["tram"], dir=dt, width=2.6,
                                      xyz=np.round(pts, 2).tolist()))
        for p_ in e["platforms"]:
            bi = p_["band"]
            k0 = int(np.searchsorted(s, p_["s0"])); k1 = int(min(np.searchsorted(s, p_["s1"]), len(s) - 1))
            if k1 - k0 < 2:
                continue
            # the platform is the part of the (widened) ROW on its side beyond the base ROW edge
            edge_off = (Lf[k0:k1 + 1, bi] if p_["side"] > 0 else Lf[k0:k1 + 1, bi] - W[k0:k1 + 1, bi])
            off = edge_off - p_["side"] * p_["w"] / 2
            P = G[k0:k1 + 1, :2] + nrm[k0:k1 + 1] * off[:, None]
            ped.append(dict(kind="platform", edge=e["id"], stop=p_["stop"], width=p_["w"],
                            xyz=np.round(np.column_stack([P, G[k0:k1 + 1, 2] + p_["h"] + 0.15]), 2).tolist()))
    # turning paths per movement at junctions
    for n_ in nodes:
        ends = lane_ends.get(n_["id"], [])
        ins = [x for x in ends if x["inbound"]]
        outs = [x for x in ends if not x["inbound"]]
        for i_ in ins:
            for o_ in outs:
                if o_["edge"] == i_["edge"]:
                    continue
                cls = sorted(set(i_["classes"]) & set(o_["classes"]) - {"tram"})
                if not cls:
                    continue
                turn = math.remainder(o_["head"] - i_["head"], math.tau)
                mv = "through" if abs(turn) < math.radians(35) else ("left" if turn > 0 else "right")
                if abs(turn) > math.radians(150):
                    continue          # no U-turns
                paths.append(dict(node=n_["id"], from_lane=i_["lane"], to_lane=o_["lane"], movement=mv, classes=cls,
                                  xyz=bezier(i_["xy"], i_["head"], o_["xy"], o_["head"])))
    # crosswalks (one per leg, perpendicular) and sidewalk corners -> pedestrian mesh
    for n_ in nodes:
        if n_["type"] != "junction":
            continue
        p0 = np.array(n_["xyz"][:2])
        for r in n_["legs"]:
            h = np.array([math.cos(r["ang"]), math.sin(r["ang"])])
            nl = np.array([-h[1], h[0]])
            c = p0 + h * (r["setback"] + 1.5)
            a_ = c + nl * (r["hw_l"] + 0.5)
            b_ = c - nl * (r["hw_r"] + 0.5)
            z = n_["xyz"][2]
            ped.append(dict(kind="crosswalk", node=n_["id"], edge=r["edge"], width=3.0,
                            xyz=[[round(a_[0], 2), round(a_[1], 2), z], [round(b_[0], 2), round(b_[1], 2), z]]))
    # mesh links at junctions (INTERACTIONS.md "Pedestrian network"): around each node the sidewalk
    # ends in angular order; consecutive ends of different legs are a corner (the corner sidewalk),
    # and every crosswalk end ramps to the nearest sidewalk end of its leg
    for n_ in nodes:
        if n_["type"] != "junction":
            continue
        p0 = np.array(n_["xyz"][:2])
        z = n_["xyz"][2]
        leg_edges = {r["edge"] for r in n_["legs"]}
        ends = []
        for pd in ped:
            if pd["kind"] != "sidewalk" or pd.get("edge") not in leg_edges or len(pd["xyz"]) < 2:
                continue
            for q in (pd["xyz"][0], pd["xyz"][-1]):
                if np.hypot(q[0] - p0[0], q[1] - p0[1]) < 60:
                    ends.append((math.atan2(q[1] - p0[1], q[0] - p0[0]), pd["edge"], q))
        # keep for each sidewalk piece only its end nearest the node
        ends.sort(key=lambda t: t[0])
        for i_ in range(len(ends)):
            a_, b_ = ends[i_], ends[(i_ + 1) % len(ends)]
            if a_[1] != b_[1] and len(ends) > 1:
                ped.append(dict(kind="corner", node=n_["id"], width=2.0, xyz=[list(a_[2]), list(b_[2])]))
        for pd in [x for x in ped if x["kind"] == "crosswalk" and x.get("node") == n_["id"]]:
            for q in pd["xyz"]:
                cand = [e_ for e_ in ends if e_[1] == pd["edge"]]
                if not cand:
                    continue
                best = min(cand, key=lambda e_: math.hypot(e_[2][0] - q[0], e_[2][1] - q[1]))
                if math.hypot(best[2][0] - q[0], best[2][1] - q[1]) < 15:
                    ped.append(dict(kind="ramp", node=n_["id"], width=2.0, xyz=[list(q), list(best[2])]))
    return lanes, paths, ped


# ------------------------------------------------------------------ QA (slice)
def qa(out, edges, assets):
    """slice checks: band_overlap (two edges' cross-sections overlap away from their nodes),
    path_overlap (a walkable ribbon on another edge's carriageway), path_dangling (a walkable end
    within 3 m of another walkable element but not joined), unresolved_crossing (two edges
    crossing in plan without a shared node and without a resolved interaction).
    (Lanes are generated from the same band layout the geometry is swept from, so they lie in
    their bands by construction; agent-on-lane is checked in-app: window.__net2.agentCheck().)"""
    import shapely
    res = defaultdict(list)
    x0, y0, x1, y1 = out["bbox"]
    node_xy = {n_["id"]: (np.array(n_["xyz"][:2]), max((r["setback"] for r in n_["legs"]), default=0) + 6) for n_ in out["nodes"]}
    foot, carr = {}, {}
    for e in edges:
        if "band_left" not in e or e.get("lot") or e.get("internal") or len(e["geom"]) < 2:
            continue
        G, Lf, W = e["geom"], e["band_left"], e["band_w"]
        _, nrm = normals(G)
        a = assets[e["asset"]]
        curbs = [i for i, b in enumerate(a["bands"]) if b["kind"] == "curb"]
        left, right = Lf[:, 0], Lf[:, -1] - W[:, -1]
        pl = np.vstack([G[:, :2] + nrm * left[:, None], (G[:, :2] + nrm * right[:, None])[::-1]])
        g = shapely.Polygon(pl).buffer(0)
        if curbs:
            cl, cr = Lf[:, curbs[0]] - W[:, curbs[0]], Lf[:, curbs[-1]]
            cg = shapely.Polygon(np.vstack([G[:, :2] + nrm * cl[:, None], (G[:, :2] + nrm * cr[:, None])[::-1]])).buffer(0)
        else:
            cg = g
        # away from the nodes
        for nd in (e["a"], e["b"]):
            pass
        foot[e["id"]], carr[e["id"]] = cg, cg     # band_overlap between carriageways (curb to curb)
    ids = list(foot)
    geoms = [foot[i] for i in ids]
    tree = shapely.STRtree(geoms)
    nodes_by_key = {n_["key"]: n_ for n_ in out["nodes"]}
    def near_node(pt, e1, e2):
        for n_ in out["nodes"]:
            c, r = node_xy[n_["id"]]
            if np.hypot(*(pt - c)) < r + 8:
                return True
        return False
    ekey = {e["id"]: e for e in edges}
    for a_, b_ in zip(*tree.query(geoms, predicate="intersects")):
        if a_ >= b_:
            continue
        ea, eb = ekey[ids[a_]], ekey[ids[b_]]
        for inter in shapely.get_parts(geoms[a_].intersection(geoms[b_])):     # each overlap on its own
            if inter.area < 3.0:
                continue
            c = np.array([inter.centroid.x, inter.centroid.y])
            if not (x0 < c[0] < x1 and y0 < c[1] < y1) or near_node(c, ea, eb):
                continue
            za = ea["geom"][np.argmin(np.hypot(*(ea["geom"][:, :2] - c).T)), 2]
            zb = eb["geom"][np.argmin(np.hypot(*(eb["geom"][:, :2] - c).T)), 2]
            if abs(za - zb) >= GRADE_SEP:
                continue          # one passes over the other (grade_separation interaction)
            res["band_overlap"].append(dict(xy=c.round(1).tolist(), edges=[ea["id"], eb["id"]], area=round(inter.area, 1)))
    # unresolved plan crossings of carriageway centrelines without a shared node
    cl = {e["id"]: shapely.LineString(e["geom"][:, :2]) for e in edges if not e.get("lot") and not e.get("internal") and len(e["geom"]) >= 2}
    lids = list(cl)
    lt = shapely.STRtree([cl[i] for i in lids])
    resolved = [np.array(i["xy"]) for i in out["interactions"] if i["type"] in ("underpass", "level_crossing", "road_x_rail", "grade_separation") and "xy" in i]
    for a_, b_ in zip(*lt.query([cl[i] for i in lids], predicate="crosses")):
        if a_ >= b_:
            continue
        ea, eb = ekey[lids[a_]], ekey[lids[b_]]
        if {ea["a"], ea["b"]} & {eb["a"], eb["b"]}:
            continue
        x = cl[lids[a_]].intersection(cl[lids[b_]])
        for pt in shapely.get_parts(x):
            if pt.geom_type != "Point" or not (x0 < pt.x < x1 and y0 < pt.y < y1):
                continue
            q = np.array([pt.x, pt.y])
            if any(np.hypot(*(q - r)) < 15 for r in resolved) or near_node(q, ea, eb):
                continue
            res["unresolved_crossing"].append(dict(xy=q.round(1).tolist(), edges=[ea["id"], eb["id"]]))
    # pedestrian mesh
    walk = [p_ for p_ in out["ped"] if len(p_["xyz"]) >= 2]
    ends = []
    for k, p_ in enumerate(walk):
        for q in (p_["xyz"][0], p_["xyz"][-1]):
            ends.append((k, np.array(q[:2])))
    allpts = np.vstack([np.array(p_["xyz"])[:, :2] for p_ in walk])
    owner = np.concatenate([np.full(len(p_["xyz"]), k) for k, p_ in enumerate(walk)])
    pt_tree = cKDTree(allpts)
    for k, q in ends:
        if walk[k]["kind"] not in ("sidewalk", "platform"):
            continue
        if not (x0 + 20 < q[0] < x1 - 20 and y0 + 20 < q[1] < y1 - 20):
            continue
        near = [owner[j] for j in pt_tree.query_ball_point(q, 3.0) if owner[j] != k]
        joined = [owner[j] for j in pt_tree.query_ball_point(q, 0.75) if owner[j] != k]
        if near and not joined:
            res["path_dangling"].append(dict(xy=q.round(1).tolist(), kind=walk[k]["kind"]))
    # walkable ribbons on another edge's carriageway
    for p_ in walk:
        if p_["kind"] != "sidewalk":
            continue
        ls = shapely.LineString(np.array(p_["xyz"])[:, :2])
        for j in lt.query(ls, predicate="intersects"):
            eid = lids[j]
            if eid == p_.get("edge") or eid not in carr:
                continue
            inter = ls.intersection(carr[eid])
            if inter.length > 3.0:
                c = inter.centroid
                if (x0 < c.x < x1 and y0 < c.y < y1) and not near_node(np.array([c.x, c.y]), None, None):
                    res["path_overlap"].append(dict(xy=[round(c.x, 1), round(c.y, 1)], edge=p_.get("edge"), on=eid))
    counts = {k: len(v) for k, v in res.items()}
    for k in ("band_overlap", "unresolved_crossing", "path_dangling", "path_overlap"):
        counts.setdefault(k, 0)
    return counts, res


def bezier(p, hp, q, hq, n=12):
    p = np.asarray(p, float); q = np.asarray(q, float)
    d = float(np.hypot(*(q[:2] - p[:2])))
    k = 0.4 * d
    c1 = p[:2] + k * np.array([math.cos(hp), math.sin(hp)])
    c2 = q[:2] - k * np.array([math.cos(hq), math.sin(hq)])
    t = np.linspace(0, 1, n)[:, None]
    xy = (1 - t) ** 3 * p[:2] + 3 * (1 - t) ** 2 * t * c1 + 3 * (1 - t) * t ** 2 * c2 + t ** 3 * q[:2]
    z = (1 - t[:, 0]) * p[2] + t[:, 0] * q[2]
    return np.round(np.column_stack([xy, z]), 2).tolist()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", default="-1700,-1100,-600,-100")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    from pathlib import Path
    bb = tuple(float(v) for v in a.bbox.split(","))
    od = Path(a.out) if a.out else None
    build(bb, od)
    # second pass: junctions whose piece between them came out shorter than SHORT_BETWEEN are merged


if __name__ == "__main__":
    main()
