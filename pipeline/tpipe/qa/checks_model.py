"""Cross-layer checks against the network model (docs/ROADS.md "Source of truth").

The network model (tpipe.roadnet output + curated overrides) is the one source of road and rail
geometry and z; these checks catch consumers that disagree with it or with each other:

  duplicate_track           two different drawn track pieces on the same alignment and level
                            (a track drawn twice: an overlapping OSM way, a landmark's own rails)
  underpass_drawn_at_grade  a street crossing main-line / siding track where the model separates
                            them (rail bridge over the street, street tunnel / underpass, or rail
                            > 3 m above the street) but both are drawn within 2 m of each other,
                            or the track is set in crossing panels there
  drawn_rail_vs_train_path  the train path (rail/network.bin.gz, what the sims drive) off the drawn
                            track: plan > 0.6 m from any drawn track of its kind, or (heavy rail)
                            z > 0.3 m off
  graph_vs_model            a sim graph edge (graph tiles) off its model way (work/roadnet.npz
                            way_xyz): plan > 1 m or z > 0.3 m
"""
from __future__ import annotations

import functools
import math

import numpy as np
from scipy.spatial import cKDTree

from .. import geo, tbn
from .core import finding

MODEL_CATS = {"duplicate_track", "underpass_drawn_at_grade", "drawn_rail_vs_train_path", "graph_vs_model"}

V_BRIDGE, V_TUNNEL, V_EMBED = 1, 2, 8
ST_EXACT = 11


def _runs(mask):
    idx = np.nonzero(mask)[0]
    i = 0
    while i < len(idx):
        j = i
        while j + 1 < len(idx) and idx[j + 1] == idx[j] + 1:
            j += 1
        yield idx[i:j + 1]
        i = j + 1


def _densify(P: np.ndarray, step: float) -> np.ndarray:
    if len(P) < 2:
        return P
    d = np.hypot(*np.diff(P[:, :2], axis=0).T)
    s = np.concatenate([[0.0], np.cumsum(d)])
    t = np.linspace(0.0, s[-1], max(2, int(math.ceil(s[-1] / step)) + 1))
    return np.stack([np.interp(t, s, P[:, k]) for k in range(P.shape[1])], 1)


# ------------------------------------------------------------------ duplicate_track
def check_duplicate_track(B) -> list[dict]:
    L = B.rails
    out = []
    if L.n < 2:
        return out
    vp = L.vpiece()
    osm = L.attrs["osm"]
    cls = L.attrs["class"]
    vf = np.nan_to_num(L.vattrs.get("vf", np.zeros(len(L.X)))).astype(np.int64)
    z = L.ZD if L.ZD is not None else L.Z
    ok = (vf & V_TUNNEL) == 0
    P = np.column_stack([L.X, L.Y])
    tree = cKDTree(P[ok])
    oi = np.nonzero(ok)[0]
    dup = np.zeros(len(L.X), bool)
    for k in np.nonzero(ok & B.in_core(L.X, L.Y))[0]:
        for j in tree.query_ball_point(P[k], 0.8):
            q = oi[j]
            if vp[q] != vp[k] and osm[vp[q]] != osm[vp[k]] and cls[vp[q]] == cls[vp[k]] and abs(z[q] - z[k]) < 1.0:
                dup[k] = True
                break
    for r in _runs(dup):
        r = r[vp[r] == vp[r[0]]]
        # switches and streetcar special work share a few metres by design: > 25 m side by side
        if len(r) < 2 or np.hypot(L.X[r[-1]] - L.X[r[0]], L.Y[r[-1]] - L.Y[r[0]]) < 25.0:
            continue
        k = r[len(r) // 2]
        out.append(finding("duplicate_track", "overlap", 3, L.X[k], L.Y[k], float(z[k]), [osm[vp[k]]],
                           f"track way {int(osm[vp[k]])} drawn on top of another track for {len(r)} vertices",
                           key=("duplicate_track", int(osm[vp[k]]), round(float(L.X[k]) / 50), round(float(L.Y[k]) / 50))))
    return out


# ------------------------------------------------------------------ underpass_drawn_at_grade
def check_underpass(B) -> list[dict]:
    import shapely
    R, L = B.roads, B.rails
    out = []
    if not R.n or not L.n:
        return out
    rvp, lvp = R.vpiece(), L.vpiece()
    rvf = np.nan_to_num(R.vattrs.get("vf", np.zeros(len(R.X)))).astype(np.int64)
    lvf = np.nan_to_num(L.vattrs.get("vf", np.zeros(len(L.X)))).astype(np.int64)
    rz = R.ZD if R.ZD is not None else R.Z
    lz = L.ZD if L.ZD is not None else L.Z
    rails = [i for i in range(L.n) if L.attrs["class"][i] <= 1 and L.off[i + 1] - L.off[i] >= 2]
    roads = [i for i in range(R.n) if R.attrs["class"][i] <= 6 and R.off[i + 1] - R.off[i] >= 2]
    if not rails or not roads:
        return out
    rg = [shapely.LineString(np.column_stack([L.X[L.off[i]:L.off[i + 1]], L.Y[L.off[i]:L.off[i + 1]]])) for i in rails]
    tree = shapely.STRtree(rg)
    for i in roads:
        a, b = R.off[i], R.off[i + 1]
        if (rvf[a:b] & V_TUNNEL).all():
            continue
        g = shapely.LineString(np.column_stack([R.X[a:b], R.Y[a:b]]))
        for j in tree.query(g, predicate="intersects"):
            li = rails[j]
            c, d = L.off[li], L.off[li + 1]
            for pt in shapely.get_parts(shapely.intersection(g, rg[j])):
                if pt.geom_type != "Point" or not B.in_core(pt.x, pt.y):
                    continue
                kr = a + int(np.argmin(np.hypot(R.X[a:b] - pt.x, R.Y[a:b] - pt.y)))
                kl = c + int(np.argmin(np.hypot(L.X[c:d] - pt.x, L.Y[c:d] - pt.y)))
                sep = bool(lvf[kl] & V_BRIDGE) or bool(rvf[kr] & V_TUNNEL) or (rvf[kr] >> 4) == ST_EXACT \
                    or (L.Z[kl] - R.Z[kr]) > 3.0
                if not sep:
                    continue
                dz = float(lz[kl] - rz[kr])
                panels = bool(lvf[kl] & V_EMBED)
                if abs(dz) < 2.0 or panels:
                    out.append(finding("underpass_drawn_at_grade", "panels" if panels else "same_level", 4, pt.x, pt.y,
                                       float(lz[kl]), [R.attrs["osm"][rvp[kr]], L.attrs["osm"][lvp[kl]]],
                                       f"street {int(R.attrs['osm'][rvp[kr]])} passes under track {int(L.attrs['osm'][lvp[kl]])} in the model "
                                       f"(rail {L.Z[kl]:.1f} m, street {R.Z[kr]:.1f} m) but is drawn {dz:+.1f} m from it"
                                       + (" with crossing panels" if panels else ""),
                                       key=("underpass_drawn_at_grade", int(R.attrs["osm"][rvp[kr]]), int(L.attrs["osm"][lvp[kl]]))))
    return out


# ------------------------------------------------------------------ drawn_rail_vs_train_path
@functools.lru_cache(maxsize=1)
def _network():
    p = geo.OUT / "rail" / "network.bin.gz"
    if not p.exists():
        return None
    a, _ = tbn.read(p)
    return dict(off=a["e_off"].astype(np.int64), xyz=a["e_xyz"].reshape(-1, 3).astype(np.float64),
                kind=a["e_kind"].astype(np.int64), flags=a["e_flags"].astype(np.int64),
                vflags=a["e_vflags"].astype(np.int64) if "e_vflags" in a else None, osm=a["e_osm"])


# rail graph kind -> tile render classes
_KIND_CLS = {0: (0, 1, 5), 1: (2,), 2: (3,), 3: (4,)}


def check_train_path(B) -> list[dict]:
    N = _network()
    L = B.rails
    out = []
    if N is None or not L.n:
        return out
    x0, y0, x1, y1 = B.core
    lvf = np.nan_to_num(L.vattrs.get("vf", np.zeros(len(L.X)))).astype(np.int64)
    lz = L.ZD if L.ZD is not None else L.Z
    cls = L.attrs["class"][L.vpiece()]
    # drawn track resampled every 1 m (visible, not in tunnels)
    pts, zs, cs = [], [], []
    vp = L.vpiece()
    for i in range(L.n):
        a, b = L.off[i], L.off[i + 1]
        vis = (lvf[a:b] & V_TUNNEL) == 0
        for r in _runs(vis):
            if len(r) < 2:
                continue
            Q = _densify(np.column_stack([L.X[a + r], L.Y[a + r], lz[a + r]]), 1.0)
            pts.append(Q[:, :2]); zs.append(Q[:, 2]); cs.append(np.full(len(Q), cls[a]))
    if not pts:
        return out
    P = np.vstack(pts)
    Z = np.concatenate(zs)
    C = np.concatenate(cs)
    tree = cKDTree(P)
    for e in range(len(N["off"]) - 1):
        E = N["xyz"][N["off"][e]:N["off"][e + 1]]
        if len(E) < 2 or not ((E[:, 0] >= x0) & (E[:, 0] < x1) & (E[:, 1] >= y0) & (E[:, 1] < y1)).any():
            continue
        if N["flags"][e] & 2:           # tunnel edges are not drawn on the surface
            continue
        E = _densify(E, 4.0)
        E = E[(E[:, 0] >= x0) & (E[:, 0] < x1) & (E[:, 1] >= y0) & (E[:, 1] < y1)]
        if not len(E):
            continue
        want = _KIND_CLS.get(int(N["kind"][e]), (0, 1, 5))
        d, k = tree.query(E[:, :2], k=6, distance_upper_bound=3.0)
        dplan = np.full(len(E), np.inf)
        dz = np.full(len(E), np.nan)
        for j in range(6):
            kk = k[:, j]
            okj = np.isfinite(d[:, j]) & ~np.isfinite(dplan)
            okj[okj] &= np.isin(C[kk[okj]], want)
            dplan[okj] = d[okj, j]
            dz[okj] = E[okj, 2] - Z[kk[okj]]
        near = np.isfinite(dplan)
        if not near.any():
            continue               # track not drawn here at all (another layer's tunnel box etc.)
        bad_p = near & (dplan > 0.6)
        # street-running track (streetcar / LRT at grade) is draped with the road and its vehicles
        # snap to the drawn surface: z only for heavy rail (main / siding / subway)
        bad_z = near & (np.abs(np.nan_to_num(dz)) > 0.3) & (int(N["kind"][e]) in (0, 1))
        for sub, m, val in (("plan", bad_p, dplan), ("z", bad_z, dz)):
            if m.sum() < 3:
                continue
            q = int(np.nonzero(m)[0][np.argmax(np.abs(np.nan_to_num(val[m])))])
            out.append(finding("drawn_rail_vs_train_path", sub, 3 + min(abs(float(val[q])), 4), E[q, 0], E[q, 1], float(E[q, 2]),
                               [N["osm"][e]], f"train path (way {int(N['osm'][e])}) {float(val[q]):+.2f} m "
                               f"{'from the drawn track in plan' if sub == 'plan' else 'above the drawn track'} over {int(m.sum())} samples",
                               key=("drawn_rail_vs_train_path", sub, int(N["osm"][e]), round(float(E[q, 0]) / 100), round(float(E[q, 1]) / 100))))
    return out


# ------------------------------------------------------------------ graph_vs_model
@functools.lru_cache(maxsize=1)
def _model_ways():
    p = geo.WORK / "roadnet.npz"
    if not p.exists():
        return None
    with np.load(p, allow_pickle=True) as d:
        off, xyz = d["way_off"].astype(np.int64), d["way_xyz"]
    return dict(off=off, xyz=xyz)


def check_graph_model(B, Gr) -> list[dict]:
    """Graph edges vs the model ways (all of them: graph edges may merge micro ways)."""
    M = _model_ways()
    out = []
    if M is None or Gr is None:
        return out
    x0, y0, x1, y1 = B.core
    pad = 100.0
    off, xyz = M["off"], M["xyz"]
    wx = xyz[off[:-1], 0]
    wy = xyz[off[:-1], 1]
    sel = np.nonzero((wx > x0 - 2000) & (wx < x1 + 2000) & (wy > y0 - 2000) & (wy < y1 + 2000))[0]
    pts = []
    for i in sel:
        Q = xyz[off[i]:off[i + 1]]
        if ((Q[:, 0] > x0 - pad) & (Q[:, 0] < x1 + pad) & (Q[:, 1] > y0 - pad) & (Q[:, 1] < y1 + pad)).any():
            pts.append(_densify(Q, 1.0))
    if not pts:
        return out
    W = np.vstack(pts)
    t = cKDTree(W[:, :2])
    for e in range(len(Gr["geo"])):
        g = Gr["geo"][e]
        if len(g) < 2 or not B.in_core(g[len(g) // 2, 0], g[len(g) // 2, 1]):
            continue
        G = _densify(g, 2.0)
        # edge ends are snapped onto their graph node (a pushed ramp meets the main's node): skip 8 m
        sG = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(G[:, :2], axis=0).T))])
        G = G[(sG > 8.0) & (sG < sG[-1] - 8.0)]
        if not len(G):
            continue
        d, _ = t.query(G[:, :2])
        near = t.query_ball_point(G[:, :2], 1.0)
        dz = np.array([np.min(np.abs(W[k, 2] - G[j, 2])) if k else np.nan for j, k in enumerate(near)])
        bp = d > 1.0
        bz = np.isfinite(dz) & (dz > 0.3)
        for sub, m, val in (("plan", bp, d), ("z", bz, dz)):
            if not m.any():
                continue
            q = int(np.nonzero(m)[0][np.nanargmax(np.abs(val[m]))])
            out.append(finding("graph_vs_model", sub, 2 + min(abs(float(val[q])), 4), G[q, 0], G[q, 1], float(G[q, 2]),
                               [Gr["osm"][e]], f"sim graph edge of way {int(Gr['osm'][e])} {float(val[q]):.2f} m off the model "
                               f"{'in plan' if sub == 'plan' else 'in z'}",
                               key=("graph_vs_model", sub, int(Gr["osm"][e]), round(float(G[q, 0]) / 50), round(float(G[q, 1]) / 50))))
    return out


def run(B, cats: set) -> list[dict]:
    cats = cats & MODEL_CATS
    out = []
    if not cats:
        return out
    if "duplicate_track" in cats:
        out += check_duplicate_track(B)
    if "underpass_drawn_at_grade" in cats:
        out += check_underpass(B)
    if "drawn_rail_vs_train_path" in cats:
        out += check_train_path(B)
    if "graph_vs_model" in cats:
        from .checks_graph import load_graph
        out += check_graph_model(B, load_graph(B.tiles))
    return out
