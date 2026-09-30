"""Pass 2: turn the extracted OSM arrays into the tile pyramid (docs/SPEC.md).

    uv run python -m tpipe.osm_tiles [--only-l2 TX,TY] [--workers N]

Work is split by level-2 tile (16 km): each worker writes one L2 tile, its
16 L1 children and 256 L0 grandchildren. Tile existence: L2 covers the whole
processing bbox (context terrain/lake); L1/L0 only where they touch the region.
"""

from __future__ import annotations

import argparse
import json
import math
import multiprocessing as mp
import os
import time

import numpy as np
import shapely
from rasterio import features
from rasterio.transform import Affine
from shapely.strtree import STRtree

from . import geo, grade, region as region_mod, tbn
from .terrain import get as get_terrain

S0, S1, S2 = geo.TILE_SIZE[0], geo.TILE_SIZE[1], geo.TILE_SIZE[2]
RES = geo.GROUND_RES
G_BUILDING = 22
G_WATER, G_ROAD, G_MAJOR, G_RAIL = 1, 9, 15, 10

# ---------------------------------------------------------------- buildings

DEFAULT_H = {1: 8.0, 2: 12.0, 3: 10.0, 4: 6.0, 5: 9.0, 6: 12.0, 7: 10.0, 8: 14.0, 9: 9.0,
             10: 20.0, 11: 3.2, 12: 22.0, 13: 30.0, 14: 12.0, 15: 5.0}
HOUSE_H = {0: 8.5, 1: 10.0, 2: 9.0, 3: 10.0, 4: 6.0, 5: 3.4}
HOUSE_TAGS = {"house": 0, "detached": 0, "semidetached_house": 2, "terrace": 3, "bungalow": 4,
              "garage": 5, "garages": 5, "shed": 5, "carport": 5, "hut": 5, "cabin": 4,
              "farm": 1, "residential": -1, "yes": -1, "farm_auxiliary": 5}


def _reduce_offsets(counts):
    off = np.zeros(len(counts) + 1, dtype=np.int64)
    np.cumsum(counts, out=off[1:])
    return off


def _outer_polys(xy, ring_off, outer, sel):
    """Vectorised shapely polygons from the outer rings of buildings `sel`."""
    r = outer[sel]
    lens = ring_off[r + 1] - ring_off[r]
    idx = np.repeat(ring_off[r] - _reduce_offsets(lens)[:-1], lens) + np.arange(lens.sum())
    rid = np.repeat(np.arange(len(sel)), lens)
    # close rings
    first = _reduce_offsets(lens)[:-1]
    coords = np.insert(xy[idx], first[1:].tolist() + [len(idx)], xy[idx][first], axis=0)
    rid = np.insert(rid, first[1:].tolist() + [len(idx)], np.arange(len(sel)))
    return shapely.polygons(shapely.linearrings(coords, indices=rid))


def _linestrings(parts):
    """Vectorised shapely linestrings from a list of (n,2) arrays."""
    lens = np.array([len(p) for p in parts])
    return shapely.linestrings(np.vstack(parts), indices=np.repeat(np.arange(len(parts)), lens))


def prepare_buildings(terrain):
    from .heights import enrich

    d = enrich(dict(np.load(geo.WORK / "osm_buildings.npz", allow_pickle=True)))
    xy = d["xy"]
    nring = d["nring"].astype(np.int64)
    ringlen = d["ringlen"].astype(np.int64)
    ring_off = _reduce_offsets(ringlen)            # vertex offsets per ring
    b_ring_off = _reduce_offsets(nring)            # ring offsets per building
    nb = len(nring)
    outer = b_ring_off[:-1]                        # index of each building's outer ring
    print(f"buildings: {nb:,}, rings {len(ringlen):,}, verts {len(xy):,}")

    # signed area per ring (shoelace), enforce outer CCW / holes CW
    x, y = xy[:, 0], xy[:, 1]
    ring_of_vert = np.repeat(np.arange(len(ringlen)), ringlen)
    nxt = np.arange(len(xy)) + 1
    last = ring_off[1:] - 1
    nxt[last] = ring_off[:-1]
    cross = x * y[nxt] - x[nxt] * y
    ring_area = 0.5 * np.bincount(ring_of_vert, weights=cross, minlength=len(ringlen))
    is_outer = np.zeros(len(ringlen), dtype=bool)
    is_outer[outer] = True
    flip = (is_outer & (ring_area < 0)) | (~is_outer & (ring_area > 0))
    for r in np.nonzero(flip)[0]:
        a, b = ring_off[r], ring_off[r + 1]
        xy[a:b] = xy[a:b][::-1]
    area = np.abs(ring_area[outer])
    # centroid of outer ring (vertex mean is fine for tiling)
    ov = np.repeat(np.arange(nb), ringlen[outer])
    sel = np.concatenate([np.arange(ring_off[r], ring_off[r + 1]) for r in outer]) if nb < 50 else None
    # vectorised gather of outer-ring vertices
    starts = ring_off[outer]
    lens = ringlen[outer]
    idx = np.repeat(starts - _reduce_offsets(lens)[:-1], lens) + np.arange(lens.sum())
    cx = np.bincount(ov, weights=x[idx], minlength=nb) / lens
    cy = np.bincount(ov, weights=y[idx], minlength=nb) / lens
    del sel

    # base elevation = min terrain under outer ring
    ground = terrain.sample(x[idx], y[idx])
    base = np.minimum.reduceat(ground, _reduce_offsets(lens)[:-1]).astype(np.float32)

    # building:part handling: drop outlines that contain parts
    part = d["part"].astype(bool)
    drop = np.zeros(nb, dtype=bool)
    if part.any():
        outlines = np.nonzero(~part)[0]
        polys = _outer_polys(xy, ring_off, outer, outlines)
        tree = STRtree(polys)
        pts = shapely.points(cx[part], cy[part])
        pairs = tree.query(pts, predicate="within")
        drop[outlines[np.unique(pairs[1])]] = True
    print(f"  {part.sum():,} parts, {drop.sum():,} outlines replaced by parts")

    kind = d["kind"].copy()
    tag = d["tag"]
    h = d["height"].astype(np.float32).copy()
    levels = d["levels"]
    roofh = np.nan_to_num(d["roofh"], nan=0.0)
    from_levels = levels * 3.3 + roofh
    h = np.where(np.isnan(h), from_levels, h)
    mn = d["min"].astype(np.float32).copy()
    mn = np.where(np.isnan(mn), d["minlevel"] * 3.3, mn)
    mn = np.nan_to_num(mn, nan=0.0)
    # defaults
    dflt = np.full(nb, 8.0, dtype=np.float32)
    for k, v in DEFAULT_H.items():
        dflt[kind == k] = v
    generic = kind == 0
    dflt[generic & (area < 60)] = 3.5
    dflt[generic & (area >= 60) & (area < 400)] = 7.5
    dflt[generic & (area >= 400) & (area < 3000)] = 8.0
    dflt[generic & (area >= 3000)] = 10.0
    h = np.where(np.isnan(h) | (h <= 0), dflt, h).astype(np.float32)
    mn[kind == 15] = np.maximum(mn[kind == 15], 3.5)  # canopies float
    bad = h <= mn
    h[bad] = mn[bad] + 3.0

    # house candidates (final decision per tile, using the ground raster)
    htype = np.full(nb, -1, dtype=np.int8)
    tagtype = np.array([HOUSE_TAGS.get(t, -2) for t in tag], dtype=np.int8)
    cand = (~part) & (~drop) & (nring == 1) & (area > 12) & (area < 450) & (h <= 14) & (mn == 0) & (tagtype != -2)
    htype[cand] = tagtype[cand]
    # OBB for candidates
    ci = np.nonzero(cand)[0]
    polys = _outer_polys(xy, ring_off, outer, ci)
    rects = shapely.minimum_rotated_rectangle(polys)
    rc = shapely.get_coordinates(rects).reshape(-1, 5, 2)
    e1 = rc[:, 1] - rc[:, 0]
    e2 = rc[:, 2] - rc[:, 1]
    l1 = np.hypot(e1[:, 0], e1[:, 1])
    l2 = np.hypot(e2[:, 0], e2[:, 1])
    long_is_1 = l1 >= l2
    hl = np.where(long_is_1, l1, l2)
    hw = np.where(long_is_1, l2, l1)
    ev = np.where(long_is_1[:, None], e1, e2)
    ang = np.arctan2(ev[:, 1], ev[:, 0])
    rcx = rc[:, :4, 0].mean(axis=1)
    rcy = rc[:, :4, 1].mean(axis=1)
    t = htype[ci].astype(np.int16)
    a = area[ci]
    aspect = hl / np.maximum(hw, 0.1)
    auto = t < 0
    t = np.where(auto & (a < 45), 5, t)
    t = np.where(auto & (a >= 45) & (aspect > 2.6) & (hl > 18), 3, t)
    t = np.where(auto & (a >= 45) & (a < 150) & (t < 0), 4, t)
    t = np.where(auto & (a >= 260) & (t < 0), 1, t)
    t = np.where(t < 0, 0, t)
    t = np.where((t == 3) & (aspect < 1.8), 0, t)
    tagged_h = ~np.isnan(d["height"][ci]) | ~np.isnan(levels[ci])
    hh = np.where(tagged_h, h[ci], np.array([HOUSE_H[int(k)] for k in t], dtype=np.float32))
    houses = dict(idx=ci, cx=rcx, cy=rcy, ang=ang.astype(np.float32), len=hl.astype(np.float32),
                  wid=hw.astype(np.float32), h=hh.astype(np.float32), type=t.astype(np.uint8))
    print(f"  {len(ci):,} house candidates")

    return dict(
        xy=xy, ring_off=ring_off, b_ring_off=b_ring_off, cx=cx, cy=cy, area=area, base=base,
        height=h, min=mn, kind=kind, roof=d["roof"], color=d["color"], id=d["id"], keep=~drop,
        houses=houses, is_house=np.isin(np.arange(nb), ci),
    )


# ---------------------------------------------------------------- lines


def prepare_lines(terrain):
    d = np.load(geo.WORK / "osm_lines.npz", allow_pickle=True)
    kind = d["kind"]
    off = _reduce_offsets(d["len"].astype(np.int64))
    xy = d["xy"]
    print(f"lines: {len(kind):,} ({(kind == 0).sum():,} roads, {(kind == 1).sum():,} rail)")
    names = d["name"]
    out = {}
    for level, step in ((0, 25.0), (1, 60.0), (2, 200.0)):
        if level == 0:
            m = (kind == 0) | (kind == 1)
            tol = 0.0
        elif level == 1:
            m = ((kind == 0) & (d["cls"] <= 3)) | ((kind == 1) & np.isin(d["cls"], [0, 2, 3]))
            tol = 3.0
        else:
            m = ((kind == 0) & (d["cls"] <= 1)) | ((kind == 1) & (d["cls"] == 0))
            tol = 12.0
        ids = np.nonzero(m)[0]
        pts_list = [xy[off[i]:off[i + 1]] for i in ids]
        if tol > 0:
            ls = shapely.simplify(_linestrings(pts_list), tol)
            pts_list = [shapely.get_coordinates(g) for g in ls]
        dens, lens = [], []
        for p in pts_list:
            q, _ = grade.densify(p, step) if len(p) > 1 else (p, None)
            dens.append(q)
            lens.append(len(q))
        lens = np.array(lens, dtype=np.int64)
        P = np.vstack(dens)
        loff = _reduce_offsets(lens)
        z = terrain.sample(P[:, 0], P[:, 1])
        flags = d["flags"][ids]
        layer = d["layer"][ids]
        for j in np.nonzero(flags & 6)[0]:
            a, b = loff[j], loff[j + 1]
            n = b - a
            lay = max(1, abs(int(layer[j]))) if layer[j] != 0 else 1
            br = np.full(n, bool(flags[j] & 2))
            tu = np.full(n, bool(flags[j] & 4))
            cover = 14.0 if (kind[ids[j]] == 1 and d["cls"][ids[j]] == 2) else 9.0
            z[a:b] = grade.profile(P[a:b], z[a:b], br, tu, clearance=6.0 * lay, cover=cover * lay, ramp=60.0)
        # distance along each line at every vertex (pieces carry their start offset
        # so lane-dash phase is continuous across tile borders)
        seg = np.zeros(len(P))
        seg[1:] = np.hypot(*np.diff(P, axis=0).T)
        seg[loff[:-1]] = 0.0
        cum = np.cumsum(seg)
        cum -= np.repeat(cum[loff[:-1]], np.diff(loff))
        out[level] = dict(ids=ids, xy=P, z=z.astype(np.float32), off=loff, cum=cum.astype(np.float32))
        print(f"  L{level}: {len(ids):,} lines, {len(P):,} verts")
    out["attr"] = dict(kind=kind, cls=d["cls"], width=d["width"], lanes=d["lanes"], flags=d["flags"],
                       layer=d["layer"], id=d["id"], name=names,
                       side=d["side"] if "side" in d.files else np.zeros(len(kind), np.uint8))
    # water/coast/runway lines for rasterisation
    wl = np.nonzero(kind >= 2)[0]
    out["raster_lines"] = dict(ids=wl, geoms=_linestrings([xy[off[i]:off[i + 1]] for i in wl]))
    return out


def split_by_tile(L, level):
    """Group polyline pieces by tile. Returns {(tx,ty): [(line_idx, a, b), ...]}"""
    s = geo.TILE_SIZE[level]
    xy, off = L["xy"], L["off"]
    tx = np.floor(xy[:, 0] / s).astype(np.int64)
    ty = np.floor(xy[:, 1] / s).astype(np.int64)
    key = (tx + 100000) * 1000000 + (ty + 100000)
    line_of = np.repeat(np.arange(len(off) - 1), np.diff(off))
    brk = np.ones(len(xy), dtype=bool)
    brk[1:] = (key[1:] != key[:-1]) | (line_of[1:] != line_of[:-1])
    starts = np.nonzero(brk)[0]
    ends = np.append(starts[1:], len(xy))
    # extend each piece by one vertex into the next piece of the same line
    ext = ends.copy()
    same = np.zeros(len(starts), dtype=bool)
    same[:-1] = line_of[starts[1:]] == line_of[starts[:-1]]
    ext[same] += 1
    # and include the previous vertex at the start (so pieces overlap across borders)
    st = starts.copy()
    prev_same = np.zeros(len(starts), dtype=bool)
    prev_same[1:] = same[:-1]
    st[prev_same] -= 1
    groups: dict[tuple[int, int], list] = {}
    kk = key[starts]
    lo = line_of[starts]
    for i in range(len(starts)):
        k = (int(kk[i] // 1000000 - 100000), int(kk[i] % 1000000 - 100000))
        groups.setdefault(k, []).append((int(lo[i]), int(st[i]), int(ext[i])))
    return groups


# ---------------------------------------------------------------- areas

PRIORITY = {  # drawn in ascending order; within a class larger first
    7: 0, 4: 1, 5: 1, 6: 1, 17: 2, 14: 2, 18: 2, 3: 3, 2: 4, 13: 4, 12: 4, 16: 4, 8: 5,
    19: 6, 11: 7, 21: 7, 20: 8, 10: 2, 1: 9,
}


def prepare_areas():
    d = np.load(geo.WORK / "osm_areas.npz", allow_pickle=True)
    ring_off = _reduce_offsets(d["ringlen"].astype(np.int64))
    p_ring = _reduce_offsets(d["nring"].astype(np.int64))
    xy = d["xy"]
    polys = []
    for i in range(len(d["cls"])):
        r0, r1 = p_ring[i], p_ring[i + 1]
        rings = [xy[ring_off[r]:ring_off[r + 1]] for r in range(r0, r1)]
        polys.append(shapely.Polygon(rings[0], rings[1:]))
    polys = np.array(polys, dtype=object)
    polys = shapely.make_valid(polys)
    cls = d["cls"]
    order = np.lexsort((-shapely.area(polys), np.array([PRIORITY.get(int(c), 5) for c in cls])))
    print(f"areas: {len(polys):,}")
    return dict(geoms=polys[order], cls=cls[order], tree=STRtree(polys[order]))


def prepare_junctions():
    """Road junctions (>= 3 arms of class <= 5) with per-arm box radius, for
    junction-aware road markings, crosswalks, stop bars and signal heads.

    An arm's box radius is how far along that arm the junction surface reaches:
    the half-width of the widest road crossing it (divided by sin of the angle).
    """
    from scipy.spatial import cKDTree

    d = np.load(geo.WORK / "osm_lines.npz", allow_pickle=True)
    kind, cls, flags, width = d["kind"], d["cls"], d["flags"], d["width"]
    off = _reduce_offsets(d["len"].astype(np.int64))
    xy, nid = d["xy"], d["nid"]
    ways = np.nonzero((kind == 0) & (cls <= 5) & ((flags & 4) == 0))[0]
    lens = off[ways + 1] - off[ways]
    vi = np.concatenate([np.arange(off[w], off[w + 1]) for w in ways])
    wv = np.repeat(ways, lens)
    first = np.zeros(len(vi), bool)
    first[_reduce_offsets(lens)[:-1]] = True
    last = np.zeros(len(vi), bool)
    last[_reduce_offsets(lens)[1:] - 1] = True
    # arms: towards the previous and the next vertex of the same way
    a_v = np.concatenate([vi[~first], vi[~last]])
    a_n = np.concatenate([vi[~first] - 1, vi[~last] + 1])
    a_w = np.concatenate([wv[~first], wv[~last]])
    dv = xy[a_n] - xy[a_v]
    ang = np.arctan2(dv[:, 1], dv[:, 0])
    hw = np.maximum(width[a_w], 2.0) / 2
    uniq, inv, cnt = np.unique(nid[a_v], return_inverse=True, return_counts=True)
    jmask = cnt >= 3
    order = np.argsort(inv, kind="stable")
    grp = _reduce_offsets(cnt)
    sig_nodes = np.load(geo.WORK / "osm_nodes.npz")
    nk, nxy, nnid = sig_nodes["kind"], sig_nodes["xy"], sig_nodes["id"]
    sig_ids = set(nnid[nk == 0].tolist())
    sig_tree = cKDTree(nxy[nk == 0]) if (nk == 0).any() else None
    stop_xy = nxy[nk == 1]
    stop_tree = cKDTree(stop_xy) if len(stop_xy) else None
    J = dict(xy=[], osm=[], flags=[], arm_off=[0], arm_ang=[], arm_r=[], arm_hw=[], arm_flags=[])
    for j in np.nonzero(jmask)[0]:
        arms = order[grp[j]:grp[j + 1]]
        p = xy[a_v[arms[0]]]
        A, H = ang[arms], hw[arms]
        f = 0
        if int(uniq[j]) in sig_ids or (sig_tree is not None and sig_tree.query_ball_point(p, 20.0)):
            f |= 1
        stops = stop_tree.query_ball_point(p, 30.0) if stop_tree is not None else []
        J["xy"].append(p)
        J["osm"].append(float(uniq[j]))
        J["flags"].append(f)
        for k in range(len(arms)):
            s = np.abs(np.sin(A - A[k]))
            cross = (s > 0.35) & (np.arange(len(arms)) != k)
            if cross.any():
                r = float(np.max(np.minimum(H[cross] / s[cross], H[cross] * 2.5))) + 0.5
            else:
                others = np.arange(len(arms)) != k
                r = float(H[others].max()) if others.any() else 0.0
            af = 0
            for si in stops:
                q = stop_xy[si] - p
                dist = math.hypot(q[0], q[1])
                if dist > 2 and abs(math.remainder(math.atan2(q[1], q[0]) - A[k], math.tau)) < 0.5:
                    af |= 1
            J["arm_ang"].append(float(A[k]))
            J["arm_r"].append(r)
            J["arm_hw"].append(float(H[k]))
            J["arm_flags"].append(af)
        J["arm_off"].append(len(J["arm_ang"]))
    out = dict(xy=np.array(J["xy"]).reshape(-1, 2), osm=np.array(J["osm"]), flags=np.array(J["flags"], np.uint8),
               arm_off=np.array(J["arm_off"], np.int64), arm_ang=np.array(J["arm_ang"], np.float32),
               arm_r=np.array(J["arm_r"], np.float32), arm_hw=np.array(J["arm_hw"], np.float32),
               arm_flags=np.array(J["arm_flags"], np.uint8))
    # group by level-0 tile, duplicating junctions within 80 m of a neighbour tile
    groups: dict[tuple[int, int], list[int]] = {}
    pad = 80.0
    for i, (x, y) in enumerate(out["xy"]):
        for tx in {math.floor((x - pad) / S0), math.floor((x + pad) / S0)}:
            for ty in {math.floor((y - pad) / S0), math.floor((y + pad) / S0)}:
                groups.setdefault((tx, ty), []).append(i)
    print(f"junctions: {len(out['osm']):,} ({int((out['flags'] & 1).sum()):,} signalized)")
    return out, {k: np.array(v, np.int64) for k, v in groups.items()}


def prepare_points():
    """Street points grouped by level-0 tile. Unmarked crossings are dropped."""
    d = np.load(geo.WORK / "osm_nodes.npz")
    kind = d["kind"]
    var = d["var"] if "var" in d.files else np.zeros(len(kind), np.uint8)
    keep = (kind != 2) | (var > 0)
    nodes = dict(kind=kind[keep], var=var[keep], id=d["id"][keep].astype(np.float64), xy=d["xy"][keep])
    tx = np.floor(nodes["xy"][:, 0] / S0).astype(np.int64)
    ty = np.floor(nodes["xy"][:, 1] / S0).astype(np.int64)
    order = np.lexsort((ty, tx))
    k2 = np.stack([tx[order], ty[order]], 1)
    groups = {}
    if len(order):
        brk = np.nonzero(np.any(np.diff(k2, axis=0) != 0, axis=1))[0] + 1
        for chunk in np.split(np.arange(len(order)), brk):
            groups[(int(k2[chunk[0], 0]), int(k2[chunk[0], 1]))] = order[chunk]
    print(f"points: {len(order):,} by kind {np.bincount(nodes['kind'], minlength=5).tolist()}")
    return nodes, groups


def great_lakes():
    """Lake Ontario / Lake Erie multipolygons (assembled from ON + NY data in
    work/lakes.osm.pbf, see run.sh). Their shores cross provincial/state
    extracts, so they are not complete in the region extract itself."""
    import osmium
    from shapely import wkb
    from shapely.ops import transform

    fab = osmium.geom.WKBFactory()
    x0, y0, x1, y1 = geo.projected_bbox()
    frame = shapely.box(x0 - 20000, y0 - 20000, x1 + 20000, y1 + 20000)
    out = []
    for o in osmium.FileProcessor(str(geo.WORK / "lakes.osm.pbf")).with_locations().with_areas():
        if o.is_area() and o.tags.get("natural") == "water" and o.tags.get("name") in ("Lake Ontario", "Lake Erie"):
            g = wkb.loads(fab.create_multipolygon(o), hex=True)
            g = shapely.clip_by_rect(g, -81.3, 42.5, -77.9, 45.0)
            g = transform(lambda x, y, z=None: geo.project(x, y), g).intersection(frame)
            out += list(shapely.get_parts(g))
    print(f"great lakes: {len(out)} polygons")
    return out


# ---------------------------------------------------------------- per tile

G = {}  # globals shared with forked workers


def rasterize_ground(level, tx, ty):
    s = geo.TILE_SIZE[level]
    x0, y0 = tx * s, ty * s
    px = s / RES
    tr = Affine(px, 0, x0, 0, -px, y0 + s)  # rasterio: row 0 = north
    tile = shapely.box(x0, y0, x0 + s, y0 + s)
    shapes = [(w.intersection(tile), G_WATER) for w in G["coast_water"] if w.intersects(tile)]
    A = G["areas"]
    hits = np.sort(A["tree"].query(tile, predicate="intersects"))
    min_area = (px * 1.5) ** 2 if level > 0 else 0
    for i in hits:
        g = A["geoms"][i]
        if level > 0 and g.area < min_area:
            continue
        shapes.append((g, int(A["cls"][i])))
    # waterways / runways (buffered lines)
    RL = G["lines"]["raster_lines"]
    hit = RL["tree"].query(tile, predicate="intersects")
    attr = G["lines"]["attr"]
    for j in hit:
        li = RL["ids"][j]
        k = attr["kind"][li]
        if k == 3:  # coastline: lakes come from great_lakes()
            continue
        w = max(float(attr["width"][li]), px * (0.7 if level else 0.5))
        if level > 0 and k == 2 and attr["width"][li] < px * 0.4:
            continue
        shapes.append((RL["geoms"][j].buffer(w / 2, cap_style="flat"), G_WATER if k == 2 else 20))
    # far levels: roads, rail and buildings go into the raster
    if level > 0:
        L = G["lines"][level]
        pieces = G["pieces"][level].get((tx, ty), [])
        for li, a, b in pieces:
            gi = L["ids"][li]
            k, c = attr["kind"][gi], attr["cls"][gi]
            if attr["flags"][gi] & 4:
                continue
            w = max(float(attr["width"][gi]), px * (0.9 if c <= 1 else 0.6))
            shapes.append((shapely.LineString(L["xy"][a:b]).buffer(w / 2, cap_style="flat"),
                           G_RAIL if k == 1 else (G_MAJOR if c <= 2 else G_ROAD)))
        B = G["b"]
        bi = G["bidx"][level].get((tx, ty))
        if bi is not None and len(bi):
            ro, bro = B["ring_off"], B["b_ring_off"]
            polys = [shapely.Polygon(B["xy"][ro[bro[i]]:ro[bro[i] + 1]]) for i in bi if B["area"][i] > px * px * 0.3]
            shapes += [(p, G_BUILDING) for p in polys]
    if not shapes:
        return np.zeros((RES, RES), dtype=np.uint8)
    img = features.rasterize(shapes, out_shape=(RES, RES), transform=tr, fill=0, dtype="uint8",
                             all_touched=level > 0)
    return img[::-1].copy()  # row 0 = south


def build_tile(level, tx, ty):
    s = geo.TILE_SIZE[level]
    x0, y0 = tx * s, ty * s
    arrays = {}
    n = geo.TERRAIN_GRID[level]
    th = G["terrain"].grid(x0, y0, s, n)
    arrays["terrain_h"] = np.clip(np.round(th * 10), -32768, 32767).astype(np.int16).ravel()
    ground = rasterize_ground(level, tx, ty)
    arrays["ground"] = ground.ravel()

    # ---- buildings
    B = G["b"]
    bi = G["bidx"][level].get((tx, ty), np.zeros(0, dtype=np.int64))
    suppress_house = np.zeros(len(bi), dtype=bool)
    if level == 0 and len(bi):
        # houses: candidates not on commercial/industrial ground become instances
        hmask = B["is_house"][bi]
        if hmask.any():
            hb = bi[hmask]
            H = G["h_lookup"]
            hi = H[hb]
            HS = B["houses"]
            px = np.clip(((HS["cx"][hi] - x0) / s * RES).astype(int), 0, RES - 1)
            py = np.clip(((HS["cy"][hi] - y0) / s * RES).astype(int), 0, RES - 1)
            gcls = ground[py, px]
            ok = ~np.isin(gcls, [5, 6, 17, 14])
            hb, hi = hb[ok], hi[ok]
            suppress_house[np.nonzero(hmask)[0][ok]] = True
            arrays["h_xy"] = np.stack([HS["cx"][hi] - x0, HS["cy"][hi] - y0], 1).astype(np.float32).ravel()
            arrays["h_angle"] = HS["ang"][hi]
            arrays["h_len"] = HS["len"][hi]
            arrays["h_wid"] = HS["wid"][hi]
            arrays["h_height"] = HS["h"][hi]
            arrays["h_base"] = B["base"][hb]
            arrays["h_type"] = HS["type"][hi]
            arrays["h_var"] = (B["id"][hb].astype(np.int64) * 2654435761 >> 7 & 255).astype(np.uint8)
            arrays["h_osm"] = B["id"][hb]
    bi = bi[~suppress_house]
    if level > 0 and len(bi):
        bi = bi[B["height"][bi] + 0 >= (12.0 if level == 1 else 35.0)]
    ring_counts, verts = [], []
    ro, bro = B["ring_off"], B["b_ring_off"]
    tol = {0: 0.0, 1: 1.5, 2: 5.0}[level]
    for i in bi:
        r0, r1 = bro[i], bro[i + 1]
        if level > 0:
            ring = B["xy"][ro[r0]:ro[r0 + 1]]
            if tol and len(ring) > 5:
                g = shapely.simplify(shapely.Polygon(ring), tol)
                if g.is_empty or g.geom_type != "Polygon":
                    continue
                ring = np.asarray(g.exterior.coords)[:-1]
                if shapely.Polygon(ring).exterior.is_ccw is False:
                    ring = ring[::-1]
            verts.append([ring])
            ring_counts.append(1)
        else:
            verts.append([B["xy"][ro[r]:ro[r + 1]] for r in range(r0, r1)])
            ring_counts.append(r1 - r0)
    if len(bi) and len(verts) != len(bi):
        # simplification dropped some; recompute bi to match
        pass
    if verts:
        keep_bi = bi[: len(verts)] if level == 0 else np.array([i for i in bi][: len(verts)])
        rings = [r for v in verts for r in v]
        rl = np.array([len(r) for r in rings], dtype=np.uint32)
        arrays["b_ring_off"] = _reduce_offsets(np.array(ring_counts)).astype(np.uint32)
        arrays["b_vert_off"] = _reduce_offsets(rl).astype(np.uint32)
        allv = np.vstack(rings)
        arrays["b_xy"] = (allv - [x0, y0]).astype(np.float32).ravel()
        arrays["b_height"] = B["height"][keep_bi].astype(np.float32)
        arrays["b_min"] = B["min"][keep_bi].astype(np.float32)
        arrays["b_base"] = B["base"][keep_bi].astype(np.float32)
        arrays["b_kind"] = B["kind"][keep_bi].astype(np.uint8)
        arrays["b_roof"] = B["roof"][keep_bi].astype(np.uint8)
        arrays["b_color"] = B["color"][keep_bi].astype(np.uint32)
        arrays["b_osm"] = B["id"][keep_bi].astype(np.float64)

    # ---- roads & rail
    L = G["lines"][level]
    attr = G["lines"]["attr"]
    pieces = G["pieces"][level].get((tx, ty), [])
    names: list[str] = []
    name_idx: dict[str, int] = {}
    for prefix, want in (("r", 0), ("l", 1)):
        sel = [(li, a, b) for li, a, b in pieces if attr["kind"][L["ids"][li]] == want]
        if not sel:
            continue
        gids = np.array([L["ids"][li] for li, _, _ in sel])
        lens = np.array([b - a for _, a, b in sel], dtype=np.int64)
        idx = np.concatenate([np.arange(a, b) for _, a, b in sel])
        xyz = np.column_stack([L["xy"][idx, 0] - x0, L["xy"][idx, 1] - y0, L["z"][idx]]).astype(np.float32)
        arrays[f"{prefix}_off"] = _reduce_offsets(lens).astype(np.uint32)
        arrays[f"{prefix}_xyz"] = xyz.ravel()
        arrays[f"{prefix}_class"] = attr["cls"][gids].astype(np.uint8)
        arrays[f"{prefix}_flags"] = attr["flags"][gids].astype(np.uint8)
        arrays[f"{prefix}_osm"] = attr["id"][gids].astype(np.float64)
        if want == 0:
            arrays["r_width"] = attr["width"][gids].astype(np.float32)
            arrays["r_lanes"] = attr["lanes"][gids].astype(np.uint8)
            arrays["r_layer"] = attr["layer"][gids].astype(np.int8)
            arrays["r_side"] = attr["side"][gids].astype(np.uint8)
            arrays["r_v0"] = np.array([L["cum"][a] for _, a, _ in sel], dtype=np.float32)
            ni = []
            for g in gids:
                nm = attr["name"][g]
                if not nm:
                    ni.append(0xFFFF)
                    continue
                if nm not in name_idx and len(names) < 0xFFFE:
                    name_idx[nm] = len(names)
                    names.append(nm)
                ni.append(name_idx.get(nm, 0xFFFF))
            arrays["r_name"] = np.array(ni, dtype=np.uint16)
    # ---- street points (level 0): signals, stop signs, marked crossings, trees, lamps
    if level == 0:
        pi = G["points"].get((tx, ty))
        if pi is not None and len(pi):
            NP = G["nodes"]
            arrays["p_xy"] = (NP["xy"][pi] - [x0, y0]).astype(np.float32).ravel()
            arrays["p_kind"] = NP["kind"][pi].astype(np.uint8)
            arrays["p_var"] = NP["var"][pi].astype(np.uint8)
            arrays["p_osm"] = NP["id"][pi].astype(np.float64)
        ji = G["jtiles"].get((tx, ty))
        if ji is not None and len(ji):
            J = G["junc"]
            ao = J["arm_off"]
            arms = np.concatenate([np.arange(ao[i], ao[i + 1]) for i in ji])
            arrays["j_xy"] = (J["xy"][ji] - [x0, y0]).astype(np.float32).ravel()
            arrays["j_osm"] = J["osm"][ji].astype(np.float64)
            arrays["j_flags"] = J["flags"][ji]
            arrays["j_arm_off"] = _reduce_offsets(ao[ji + 1] - ao[ji]).astype(np.uint32)
            arrays["j_arm_ang"] = J["arm_ang"][arms]
            arrays["j_arm_r"] = J["arm_r"][arms]
            arrays["j_arm_hw"] = J["arm_hw"][arms]
            arrays["j_arm_flags"] = J["arm_flags"][arms]
    path = geo.OUT / "tiles" / str(level) / f"{tx}_{ty}.bin.gz"
    size = tbn.write(path, arrays, level=level, tx=tx, ty=ty, names=names)
    return size


def work_l2(key):
    """Write one L2 tile and its descendants. Children come in complete sets
    of 16: a tile either has no children or all of them (filling cells just
    outside the region), so refining a tile never leaves holes."""
    tx2, ty2 = key
    out = {0: [], 1: [], 2: []}
    size = build_tile(2, tx2, ty2)
    out[2].append((tx2, ty2))
    reg = G["region_prep"]
    b2 = shapely.box(tx2 * S2, ty2 * S2, (tx2 + 1) * S2, (ty2 + 1) * S2)
    if not reg.intersects(b2):
        return key, out, size
    for j1 in range(4):
        for i1 in range(4):
            tx1, ty1 = tx2 * 4 + i1, ty2 * 4 + j1
            size += build_tile(1, tx1, ty1)
            out[1].append((tx1, ty1))
            b1 = shapely.box(tx1 * S1, ty1 * S1, (tx1 + 1) * S1, (ty1 + 1) * S1)
            if not reg.intersects(b1):
                continue
            for j0 in range(4):
                for i0 in range(4):
                    tx0, ty0 = tx1 * 4 + i0, ty1 * 4 + j0
                    size += build_tile(0, tx0, ty0)
                    out[0].append((tx0, ty0))
    return key, out, size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only-l2", default=None, help="tx,ty of a single level-2 tile (debug)")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 4) - 1))
    args = ap.parse_args()
    t0 = time.time()
    terrain = get_terrain()
    G["terrain"] = terrain
    region = region_mod.load()
    shapely.prepare(region)
    G["region_prep"] = region
    B = prepare_buildings(terrain)
    G["b"] = B
    lookup = np.full(len(B["cx"]), -1, dtype=np.int64)
    lookup[B["houses"]["idx"]] = np.arange(len(B["houses"]["idx"]))
    G["h_lookup"] = lookup
    keep = np.nonzero(B["keep"])[0]
    G["bidx"] = {}
    for level in (0, 1, 2):
        s = geo.TILE_SIZE[level]
        tx = np.floor(B["cx"][keep] / s).astype(np.int64)
        ty = np.floor(B["cy"][keep] / s).astype(np.int64)
        order = np.lexsort((ty, tx))
        k2 = np.stack([tx[order], ty[order]], 1)
        brk = np.nonzero(np.any(np.diff(k2, axis=0) != 0, axis=1))[0] + 1
        groups = {}
        for chunk in np.split(np.arange(len(order)), brk):
            if len(chunk):
                groups[(int(k2[chunk[0], 0]), int(k2[chunk[0], 1]))] = keep[order[chunk]]
        G["bidx"][level] = groups
    print(f"prepared buildings in {time.time() - t0:.0f}s")
    lines = prepare_lines(terrain)
    lines["raster_lines"]["tree"] = STRtree(lines["raster_lines"]["geoms"])
    G["lines"] = lines
    G["pieces"] = {lv: split_by_tile(lines[lv], lv) for lv in (0, 1, 2)}
    print(f"prepared lines in {time.time() - t0:.0f}s")
    G["nodes"], G["points"] = prepare_points()
    G["junc"], G["jtiles"] = prepare_junctions()
    print(f"prepared junctions in {time.time() - t0:.0f}s")
    G["areas"] = prepare_areas()
    G["coast_water"] = great_lakes()
    print(f"prepared areas in {time.time() - t0:.0f}s")

    x0, y0, x1, y1 = geo.projected_bbox()
    keys = [(i, j) for j in range(math.floor(y0 / S2), math.floor(y1 / S2) + 1)
            for i in range(math.floor(x0 / S2), math.floor(x1 / S2) + 1)]
    if args.only_l2:
        a, b = map(int, args.only_l2.split(","))
        keys = [(a, b)]
    # biggest work first (L2 tiles touching the region)
    keys.sort(key=lambda k: -region.intersection(shapely.box(k[0] * S2, k[1] * S2, (k[0] + 1) * S2, (k[1] + 1) * S2)).area)
    tiles = {0: [], 1: [], 2: []}
    total = 0
    ctx = mp.get_context("fork")
    with ctx.Pool(args.workers) as pool:
        for n, (key, out, size) in enumerate(pool.imap_unordered(work_l2, keys), 1):
            for lv in out:
                tiles[lv] += out[lv]
            total += size
            print(f"  [{n}/{len(keys)}] L2 {key}: {len(out[0])} L0, {len(out[1])} L1, {size / 1e6:.1f} MB "
                  f"({time.time() - t0:.0f}s)", flush=True)
    write_manifest(tiles, region, args.only_l2 is not None)
    print(f"done: {sum(len(v) for v in tiles.values())} tiles, {total / 1e6:.0f} MB in {time.time() - t0:.0f}s")


def write_manifest(tiles, region, partial):
    path = geo.OUT / "manifest.json"
    if partial and path.exists():
        old = json.loads(path.read_text())
        for lv in ("0", "1", "2"):
            s = {tuple(t) for t in old["tiles"][lv]} | {tuple(t) for t in tiles[int(lv)]}
            tiles[int(lv)] = sorted(s)
    simp = shapely.simplify(region, 200)
    polys = shapely.get_parts(simp)
    x0, y0, x1, y1 = geo.projected_bbox()
    muni = json.loads((geo.WORK / "region.json").read_text())["municipalities"]
    manifest = {
        "version": 1,
        # bumps on every build; clients append ?v=build to tile URLs (cache busting)
        "build": int(time.time()),
        "projection": geo.PROJ,
        "origin": [geo.ORIGIN_LAT, geo.ORIGIN_LON],
        "datum": geo.DATUM_M,
        "tileSize": {str(k): v for k, v in geo.TILE_SIZE.items()},
        "terrainGrid": {str(k): v for k, v in geo.TERRAIN_GRID.items()},
        "groundRes": RES,
        "bounds": [round(x0), round(y0), round(x1), round(y1)],
        "tiles": {str(lv): sorted([list(t) for t in tiles[lv]]) for lv in (0, 1, 2)},
        "region": [[[round(x), round(y)] for x, y in np.asarray(p.exterior.coords)] for p in polys],
        "municipalities": muni,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, separators=(",", ":")))


if __name__ == "__main__":
    main()
