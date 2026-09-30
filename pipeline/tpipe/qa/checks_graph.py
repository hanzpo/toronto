"""Road-graph QA (data/graph, tpipe.graph) against the drawn roads (render tiles):

  graph_connectivity         directed islands (strongly connected components cut off from
                             the main network) and dead ends at junction nodes
  hooked_edge                an edge whose centreline turns back on itself near an end
                             (overshoots its node and doubles back)
  micro_link                 edges shorter than 2 m (split junction nodes), with or without
                             a height jump
  carriageway_overlap        drawn carriageways of different roads overlapping away from
                             any junction (ramp over mainline, split carriageways)
  graph_vs_drawn_elevation   the graph edge's elevation differs from the drawn road surface
                             (cars floating over / sinking into the deck)

Run: uv run python -m tpipe.qa --categories graph_connectivity,hooked_edge,... (docs/QA.md)
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np

from .. import geo, tbn
from .core import finding

GRAPH_CATS = {"graph_connectivity", "hooked_edge", "micro_link", "carriageway_overlap", "graph_vs_drawn_elevation"}
GRAPH_DIR = Path(__import__("os").environ["QA_GRAPH_DIR"]) if __import__("os").environ.get("QA_GRAPH_DIR") else None
S0 = geo.TILE_SIZE[0]
HALO_TILES = 1


def _graph_dir() -> Path:
    return GRAPH_DIR or (geo.OUT / "graph")


def load_graph(tiles) -> dict | None:
    """Merge graph tiles into global arrays: node ids / xyz, edges (from, to, lanes, geometry)."""
    gdir = _graph_dir()
    nid, nxyz, ef, et, lf, lb, cls, osm, flags, geo_ = [], [], [], [], [], [], [], [], [], []
    node_index: dict[int, int] = {}
    for tx, ty in tiles:
        p = gdir / f"{tx}_{ty}.bin.gz"
        if not p.exists():
            continue
        a, _ = tbn.read(p)
        x0, y0 = tx * S0, ty * S0
        ids = a["n_id"].astype(np.int64)
        xyz = a["n_xyz"].reshape(-1, 3).astype(np.float64)
        loc = []
        for i, n in enumerate(ids.tolist()):
            k = node_index.get(n)
            if k is None:
                k = node_index[n] = len(nid)
                nid.append(n)
                nxyz.append([xyz[i, 0] + x0, xyz[i, 1] + y0, xyz[i, 2]])
            loc.append(k)
        off = a["e_off"]
        exyz = a["e_xyz"].reshape(-1, 3).astype(np.float64)
        for e in range(len(a["e_from"])):
            g = exyz[off[e]:off[e + 1]].copy()
            g[:, 0] += x0
            g[:, 1] += y0
            ef.append(loc[a["e_from"][e]]); et.append(loc[a["e_to"][e]])
            lf.append(int(a["e_lanes_fwd"][e])); lb.append(int(a["e_lanes_bwd"][e]))
            cls.append(int(a["e_class"][e])); osm.append(float(a["e_osm"][e])); flags.append(int(a["e_flags"][e]))
            geo_.append(g)
    if not ef:
        return None
    return dict(nid=np.array(nid), nxyz=np.array(nxyz), ef=np.array(ef), et=np.array(et), lf=np.array(lf), lb=np.array(lb),
                cls=np.array(cls), osm=np.array(osm), flags=np.array(flags), geo=geo_)


def _core(B, x, y):
    return B.in_core(x, y)


def check_connectivity(B, Gr, cats) -> list[dict]:
    from scipy.sparse import csr_matrix
    from scipy.sparse.csgraph import connected_components

    out = []
    n = len(Gr["nid"])
    fw = Gr["lf"] > 0
    bw = Gr["lb"] > 0
    src = np.concatenate([Gr["ef"][fw], Gr["et"][bw]])
    dst = np.concatenate([Gr["et"][fw], Gr["ef"][bw]])
    M = csr_matrix((np.ones(len(src)), (src, dst)), shape=(n, n))
    nc, lab = connected_components(M, directed=True, connection="strong")
    size = np.bincount(lab, minlength=nc)
    big = int(np.argmax(size))
    # distance of each node to the block's outer edge: islands touching the halo edge are artefacts
    x, y = Gr["nxyz"][:, 0], Gr["nxyz"][:, 1]
    bx0, by0 = B.tx0 * S0, B.ty0 * S0
    bx1, by1 = (B.tx0 + B.nt) * S0, (B.ty0 + B.nt) * S0
    edge_d = np.minimum.reduce([x - bx0, bx1 - x, y - by0, by1 - y])
    # nodes of drivable (non-service) roads only: a parking-lot aisle island is not interesting
    main_cls = np.zeros(n, bool)
    for e in range(len(Gr["ef"])):
        if Gr["cls"][e] <= 5:
            main_cls[Gr["ef"][e]] = True
            main_cls[Gr["et"][e]] = True
    seen = set()
    for c in range(nc):
        if c == big:
            continue
        mem = np.nonzero(lab == c)[0]
        if edge_d[mem].min() < 300 or not main_cls[mem].any():
            continue
        i = int(mem[0])
        if not _core(B, x[i], y[i]) or c in seen:
            continue
        seen.add(c)
        out.append(finding("graph_connectivity", "island", float(len(mem)), x[i], y[i], Gr["nxyz"][i, 2], [Gr["nid"][i]],
                           f"{len(mem)} graph node(s) cannot reach / be reached from the main network (directed)",
                           key=("graph_connectivity", "island", int(Gr["nid"][i]))))
    # dead ends: a node with outgoing but no incoming (or vice versa) drivable direction, on a street
    indeg = np.bincount(dst, minlength=n)
    outdeg = np.bincount(src, minlength=n)
    for i in np.nonzero(((indeg == 0) ^ (outdeg == 0)) & main_cls)[0]:
        if edge_d[i] < 300 or not _core(B, x[i], y[i]):
            continue
        sub = "no_exit" if outdeg[i] == 0 else "no_entry"
        out.append(finding("graph_connectivity", sub, 1.0, x[i], y[i], Gr["nxyz"][i, 2], [Gr["nid"][i]],
                           f"graph node with {'no way out' if sub == 'no_exit' else 'no way in'} (one-way dead end)"))
    return out


def check_edges(B, Gr, cats) -> list[dict]:
    out = []
    for e, g in enumerate(Gr["geo"]):
        if len(g) < 2:
            continue
        mx, my = g[len(g) // 2, 0], g[len(g) // 2, 1]
        if not _core(B, mx, my):
            continue
        d = np.diff(g[:, :2], axis=0)
        L = np.hypot(*d.T)
        tot = float(L.sum())
        if "micro_link" in cats and tot < 2.0:
            dz = abs(float(g[-1, 2] - g[0, 2]))
            out.append(finding("micro_link", "height_jump" if dz > 1.0 else "short", tot + dz, mx, my, g[0, 2], [Gr["osm"][e]],
                               f"graph link only {tot:.1f} m long{f', {dz:.1f} m height jump' if dz > 1 else ''}"))
            continue
        if "hooked_edge" in cats and len(g) >= 3:
            cum = np.concatenate([[0.0], np.cumsum(L)])
            ok = L > 1e-6
            u = np.zeros_like(d)
            u[ok] = d[ok] / L[ok, None]
            dot = (u[:-1] * u[1:]).sum(1)
            near_end = (cum[1:-1] <= 30) | (cum[1:-1] >= tot - 30)
            real = L > 0.5          # sub-half-metre wiggles are not hooks
            bad = np.nonzero((dot < -0.5) & near_end & real[:-1] & real[1:])[0]
            if len(bad):
                k = int(bad[0]) + 1
                end = 0 if cum[k] <= 30 else len(g) - 1
                over = float(np.max(np.hypot(g[:, 0] - g[end, 0], g[:, 1] - g[end, 1])[max(0, k - 3):k + 3]))
                out.append(finding("hooked_edge", "overshoot", over, g[k, 0], g[k, 1], g[k, 2], [Gr["osm"][e]],
                                   f"edge centreline turns back {math.degrees(math.acos(max(-1, dot[k - 1]))):.0f} deg near its node "
                                   f"(overshoot ~{over:.1f} m)"))
    return out


def _drawn_z(B, x, y, z, dz, vf):
    """The client's drawn elevation (workers/roads.ts): terrain + dz near the ground, blending to
    the solved z on decks and high embankments."""
    t = B.terrain(x, y)
    graded = (vf & 4) != 0
    br = (vf & 1) != 0
    w = np.where(br, 1.0, np.where(graded, np.clip((dz - 1.5) / 3, 0, 1), 0.0))
    zd = t + np.where(graded, dz, 0.0)
    return zd + (z - zd) * w


def check_elevation(B, Gr, cats) -> list[dict]:
    from scipy.spatial import cKDTree

    R = B.roads
    if not R.n:
        return []
    dz = np.concatenate([d.get("r_dz", np.zeros(len(d.get("r_xyz", [])) // 3)) for d in B.data if d.get("r_off") is not None])
    vf = np.concatenate([d.get("r_vf", np.zeros(len(d.get("r_xyz", [])) // 3, np.uint8)) for d in B.data if d.get("r_off") is not None])
    if len(dz) != len(R.X):
        return []
    zd = _drawn_z(B, R.X, R.Y, R.Z, dz, vf.astype(np.int64))
    vosm = R.attrs["osm"][R.vpiece()]
    tree = cKDTree(np.column_stack([R.X, R.Y]))
    out = []
    for e, g in enumerate(Gr["geo"]):
        m = g[len(g) // 2]
        if not _core(B, m[0], m[1]):
            continue
        worst = 0.0
        wp = None
        for p in g[:: max(1, len(g) // 6)]:
            idx = tree.query_ball_point(p[:2], 4.0)
            if not idx:
                continue
            idx = np.asarray(idx)
            same = idx[vosm[idx] == Gr["osm"][e]]
            if not len(same):
                continue
            dd = float(np.min(np.abs(zd[same] - p[2])))
            if dd > worst:
                worst, wp = dd, p
        if wp is not None and worst > 1.0:
            out.append(finding("graph_vs_drawn_elevation", "offset", worst, wp[0], wp[1], wp[2], [Gr["osm"][e]],
                               f"graph edge {worst:.1f} m off the drawn road surface"))
    return out


def check_overlap(B, cats) -> list[dict]:
    """Drawn carriageways (classes <= 6, per-vertex pavement offsets) of different ways overlapping
    away from junctions and shared nodes."""
    import shapely

    R = B.roads
    if not R.n:
        return []
    pl = np.concatenate([d.get("r_pl", np.zeros(0)) for d in B.data if d.get("r_off") is not None])
    pr = np.concatenate([d.get("r_pr", np.zeros(0)) for d in B.data if d.get("r_off") is not None])
    if len(pl) != len(R.X):
        return []
    vp = R.vpiece()
    cls, flags, osm = R.attrs["class"], R.attrs["flags"], R.attrs["osm"]
    polys, owner = [], []
    for k in range(len(R.X) - 1):
        p = vp[k]
        if vp[k + 1] != p or cls[p] > 6 or flags[p] & (4 | 32 | 64):
            continue
        x0, y0, x1, y1 = R.X[k], R.Y[k], R.X[k + 1], R.Y[k + 1]
        dx, dy = x1 - x0, y1 - y0
        L = math.hypot(dx, dy)
        if L < 0.3:
            continue
        nx, ny = -dy / L, dx / L
        # shrink 0.3 m on each side: touching edges are fine
        a0, b0 = max(pl[k] - 0.3, 0.2), max(pr[k] - 0.3, 0.2)
        a1, b1 = max(pl[k + 1] - 0.3, 0.2), max(pr[k + 1] - 0.3, 0.2)
        polys.append(shapely.Polygon([(x0 + nx * a0, y0 + ny * a0), (x1 + nx * a1, y1 + ny * a1),
                                      (x1 - nx * b1, y1 - ny * b1), (x0 - nx * b0, y0 - ny * b0)]))
        owner.append(k)
    if len(polys) < 2:
        return []
    polys = np.array(polys, dtype=object)
    owner = np.array(owner)
    tree = shapely.STRtree(polys)
    i, j = tree.query(polys, predicate="intersects")
    m = i < j
    i, j = i[m], j[m]
    pi, pj = vp[owner[i]], vp[owner[j]]
    m = osm[pi] != osm[pj]
    zi, zj = R.Z[owner[i]], R.Z[owner[j]]
    m &= np.abs(zi - zj) < 3.0
    i, j = i[m], j[m]
    if not len(i):
        return []
    inter = shapely.intersection(polys[i], polys[j])
    area = shapely.area(inter)
    m = area > 2.0
    i, j, inter, area = i[m], j[m], inter[m], area[m]
    if not len(i):
        return []
    cen = shapely.centroid(inter)
    cx, cy = shapely.get_x(cen), shapely.get_y(cen)
    # exempt: junction boxes and shared vertices (roads meeting at a node overlap near it)
    from scipy.spatial import cKDTree
    J = B.junc
    jt = cKDTree(np.column_stack([J["x"], J["y"]])) if len(J["x"]) else None
    jr = J["r"] if len(J["x"]) else None
    vt = cKDTree(np.column_stack([R.X, R.Y]))
    shared = np.zeros(len(R.X), bool)
    for a, b in vt.query_pairs(0.5):
        if osm[vp[a]] != osm[vp[b]]:
            shared[a] = shared[b] = True
    st = cKDTree(np.column_stack([R.X[shared], R.Y[shared]])) if shared.any() else None
    out = []
    agg: dict = {}
    for q in range(len(i)):
        x, y = cx[q], cy[q]
        if not _core(B, x, y):
            continue
        if jt is not None:
            d, k = jt.query([x, y])
            if d < jr[k] + 6:
                continue
        if st is not None and st.query([x, y])[0] < 25:
            continue
        key = (int(osm[vp[owner[i[q]]]]), int(osm[vp[owner[j[q]]]]))
        a = agg.setdefault(key, [0.0, x, y, R.Z[owner[i[q]]]])
        a[0] += float(area[q])
    for (oa, ob), (a, x, y, z) in agg.items():
        out.append(finding("carriageway_overlap", "overlap", a, x, y, z, [oa, ob],
                           f"carriageways of ways {oa} and {ob} overlap {a:.0f} m2 away from any junction",
                           key=("carriageway_overlap", min(oa, ob), max(oa, ob))))
    return out


def run(B, cats: set) -> list[dict]:
    cats = cats & GRAPH_CATS
    if not cats:
        return []
    out = []
    if "carriageway_overlap" in cats:
        out += check_overlap(B, cats)
    if cats & {"graph_connectivity", "hooked_edge", "micro_link", "graph_vs_drawn_elevation"}:
        Gr = load_graph(B.tiles)
        if Gr is None:
            return out
        if "graph_connectivity" in cats:
            out += check_connectivity(B, Gr, cats)
        if cats & {"hooked_edge", "micro_link"}:
            out += check_edges(B, Gr, cats)
        if "graph_vs_drawn_elevation" in cats:
            out += check_elevation(B, Gr, cats)
    return out
