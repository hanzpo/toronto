"""Drivable road graph, tiled for the local traffic simulation.

Ways are split at every OSM node shared by two or more drivable ways
(intersections) and at their ends, giving edges between graph nodes. Each
edge is stored in the level-0 tile containing its midpoint; each tile carries
the nodes its edges reference (duplicated across tiles and unified by OSM id
on the client).

    uv run python -m tpipe.graph
Output: data/graph/{tx}_{ty}.bin.gz (TBN1, see docs/SPEC.md "Road graph").
"""

from __future__ import annotations

import time

import numpy as np

from . import geo, grade, tbn
from .terrain import get as get_terrain

S0 = geo.TILE_SIZE[0]
DRIVABLE_MAX_CLASS = 6          # motorway .. service
DEFAULT_KMH = np.array([100, 80, 60, 50, 50, 40, 20], dtype=np.float32)
STEP = 12.0                     # geometry densification for smooth driving


def _offsets(counts):
    off = np.zeros(len(counts) + 1, dtype=np.int64)
    np.cumsum(counts, out=off[1:])
    return off


def main() -> None:
    t0 = time.time()
    d = np.load(geo.WORK / "osm_lines.npz", allow_pickle=True)
    kind, cls = d["kind"], d["cls"]
    loff = _offsets(d["len"].astype(np.int64))
    ways = np.nonzero((kind == 0) & (cls <= DRIVABLE_MAX_CLASS))[0]
    wlen = loff[ways + 1] - loff[ways]
    vidx = np.repeat(loff[ways] - _offsets(wlen)[:-1], wlen) + np.arange(wlen.sum())
    way_of = np.repeat(np.arange(len(ways)), wlen)          # index into `ways`
    xy = d["xy"][vidx]
    nid = d["nid"][vidx]
    print(f"{len(ways):,} drivable ways, {len(vidx):,} vertices", flush=True)

    # graph nodes: way endpoints + nodes used by more than one vertex
    uniq, inv, counts = np.unique(nid, return_inverse=True, return_counts=True)
    first = np.zeros(len(vidx), dtype=bool)
    last = np.zeros(len(vidx), dtype=bool)
    wo = _offsets(wlen)
    first[wo[:-1]] = True
    last[wo[1:] - 1] = True
    is_node = (counts[inv] > 1) | first | last
    cut = np.nonzero(is_node)[0]
    # edges between consecutive cuts of the same way
    same = way_of[cut[1:]] == way_of[cut[:-1]]
    ea, eb = cut[:-1][same], cut[1:][same]
    ew = way_of[ea]
    ok = eb > ea
    ea, eb, ew = ea[ok], eb[ok], ew[ok]
    print(f"{is_node.sum():,} node vertices, {len(ea):,} edges ({time.time() - t0:.0f}s)", flush=True)

    # densify every edge's polyline in one pass: segments are (k, k+1) for k in [ea, eb)
    seg_edge = np.repeat(np.arange(len(ea)), eb - ea)
    seg_a = np.repeat(ea - _offsets(eb - ea)[:-1], eb - ea) + np.arange((eb - ea).sum())
    p0, p1 = xy[seg_a], xy[seg_a + 1]
    slen = np.hypot(*(p1 - p0).T)
    nsub = np.maximum(1, np.ceil(slen / STEP).astype(np.int64))
    # points: each edge starts with its first vertex, then nsub points per segment
    pts_per_edge = np.bincount(seg_edge, weights=nsub, minlength=len(ea)).astype(np.int64) + 1
    poff = _offsets(pts_per_edge)
    P = np.empty((poff[-1], 2), dtype=np.float64)
    P[poff[:-1]] = xy[ea]
    sub_seg = np.repeat(np.arange(len(seg_a)), nsub)
    k = np.arange(len(sub_seg)) - np.repeat(_offsets(nsub)[:-1], nsub) + 1
    t = (k / nsub[sub_seg])[:, None]
    # destination slot: edge start + 1 + running index within the edge
    within = np.arange(len(sub_seg)) - np.repeat(_offsets(np.bincount(seg_edge, weights=nsub, minlength=len(ea)).astype(np.int64))[:-1], np.bincount(seg_edge, weights=nsub, minlength=len(ea)).astype(np.int64))
    dest = np.repeat(poff[:-1], pts_per_edge - 1) + 1 + within
    P[dest] = p0[sub_seg] + (p1[sub_seg] - p0[sub_seg]) * t
    terrain = get_terrain()
    Z = terrain.sample(P[:, 0], P[:, 1]).astype(np.float64)
    print(f"densified to {len(P):,} points ({time.time() - t0:.0f}s)", flush=True)

    gw = ways[ew]                       # global line index per edge
    flags = d["flags"][gw]
    layer = d["layer"][gw]
    for e in np.nonzero(flags & 6)[0]:
        a, b = poff[e], poff[e + 1]
        n = b - a
        lay = max(1, abs(int(layer[e]))) if layer[e] != 0 else 1
        f = int(flags[e])
        Z[a:b] = grade.profile(P[a:b], Z[a:b], np.full(n, bool(f & 2)), np.full(n, bool(f & 4)),
                               clearance=6.0 * lay, cover=9.0 * lay, ramp=60.0)
    elen = np.bincount(seg_edge, weights=slen, minlength=len(ea))

    c = cls[gw].astype(np.int64)
    oneway = (flags & 1).astype(bool)
    lanes = np.maximum(1, d["lanes"][gw].astype(np.int64))
    fwd = np.where(oneway, lanes, np.maximum(1, lanes // 2 + lanes % 2))
    bwd = np.where(oneway, 0, np.maximum(1, lanes // 2))
    sp = d["speed"][gw]
    kmh = np.where((sp > 5) & (sp < 140), sp, DEFAULT_KMH[c])

    nodes = np.load(geo.WORK / "osm_nodes.npz")
    sig = np.isin(nid, nodes["id"][nodes["kind"] == 0])
    stp = np.isin(nid, nodes["id"][nodes["kind"] == 1])
    nflag = sig.astype(np.uint8) | (stp.astype(np.uint8) << 1)

    mid = P[(poff[:-1] + poff[1:]) // 2]
    tx = np.floor(mid[:, 0] / S0).astype(np.int64)
    ty = np.floor(mid[:, 1] / S0).astype(np.int64)
    order = np.lexsort((ty, tx))
    key = np.stack([tx[order], ty[order]], 1)
    brk = np.nonzero(np.any(np.diff(key, axis=0) != 0, axis=1))[0] + 1
    names = d["name"]
    out = geo.OUT / "graph"
    total = 0
    ntiles = 0
    for chunk in np.split(order, brk):
        if not len(chunk):
            continue
        X, Y = int(tx[chunk[0]]), int(ty[chunk[0]])
        x0, y0 = X * S0, Y * S0
        E = np.sort(chunk)
        vend = np.concatenate([ea[E], eb[E]])            # vertex indices of endpoints
        uids, ui = np.unique(nid[vend], return_index=True)
        vsel = vend[ui]
        lookup = {int(u): i for i, u in enumerate(uids)}
        e_from = np.array([lookup[int(nid[v])] for v in ea[E]], dtype=np.uint32)
        e_to = np.array([lookup[int(nid[v])] for v in eb[E]], dtype=np.uint32)
        cnt = pts_per_edge[E]
        pidx = np.repeat(poff[E] - _offsets(cnt)[:-1], cnt) + np.arange(cnt.sum())
        name_list: list[str] = []
        name_idx: dict[str, int] = {}
        eni = np.full(len(E), 0xFFFF, dtype=np.uint16)
        for j, g in enumerate(gw[E]):
            nm = names[g]
            if nm:
                if nm not in name_idx:
                    name_idx[nm] = len(name_list)
                    name_list.append(nm)
                eni[j] = name_idx[nm]
        # node elevation: take it from the edge geometry at that endpoint
        nz = np.zeros(len(uids), dtype=np.float32)
        nz[e_from] = Z[poff[E]]
        nz[e_to] = Z[poff[E + 1] - 1]
        arrays = {
            "n_id": uids.astype(np.float64),
            "n_xyz": np.column_stack([xy[vsel, 0] - x0, xy[vsel, 1] - y0, nz]).astype(np.float32).ravel(),
            "n_flags": nflag[vsel],
            "e_from": e_from,
            "e_to": e_to,
            "e_off": _offsets(cnt).astype(np.uint32),
            "e_xyz": np.column_stack([P[pidx, 0] - x0, P[pidx, 1] - y0, Z[pidx]]).astype(np.float32).ravel(),
            "e_len": elen[E].astype(np.float32),
            "e_class": c[E].astype(np.uint8),
            "e_lanes_fwd": fwd[E].astype(np.uint8),
            "e_lanes_bwd": bwd[E].astype(np.uint8),
            "e_speed": (kmh[E] / 3.6).astype(np.float32),
            "e_osm": d["id"][gw[E]].astype(np.float64),
            "e_name": eni,
            "e_flags": flags[E].astype(np.uint8),
            # carriageway width as drawn by the render tiles (r_width) and OSM sidewalk code
            # (r_side), so the sim can put pedestrians on the rendered sidewalks
            "e_width": d["width"][gw[E]].astype(np.float32),
            "e_side": d["side"][gw[E]].astype(np.uint8),
        }
        total += tbn.write(out / f"{X}_{Y}.bin.gz", arrays, tx=X, ty=Y, names=name_list)
        ntiles += 1
    print(f"wrote {ntiles:,} graph tiles, {total / 1e6:.0f} MB in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
