"""Rail geometry and routing checks.

Sources: the drawn tracks in level-0 tiles (l_*), the switch-level rail graph
(data/rail/network.bin.gz, docs/RAIL.md) and the rail pattern shapes and track
routes in data/transit/*_rail.bin.gz (pat_redge etc., docs/TRANSIT.md).

Categories:
  rail_kink             curve radius below the plausible minimum for the track kind
                        (tile tracks, graph edges, pattern shapes), or a heading
                        break through a switch / node movement
  rail_gap              drawn track ends dangling next to another track end
                        (hole in the track) or running into a track unconnected
  route_track_conflict  pattern without a continuous track route, a route using
                        an edge against its allowed direction, consecutive route
                        edges with no movement between them, and a route using one
                        double-track edge in both directions (opposing trains
                        sharing a track)
"""

from __future__ import annotations

import math

import numpy as np
from scipy.spatial import cKDTree

from .. import geo, tbn
from .core import finding
from .data import F_TUNNEL, Block

NETWORK = geo.OUT / "rail" / "network.bin.gz"
TRANSIT = geo.OUT / "transit"

# ----------------------------------------------------------------------------- thresholds
# minimum plausible radius (m) per tile rail class: main, siding/yard, subway, LRT, tram, other
R_MIN_TILE = [150.0, 60.0, 90.0, 25.0, 10.0, 30.0]
# per graph kind (rail, subway, light_rail, tram), running line / service track
R_MIN_NET = {0: 150.0, 1: 90.0, 2: 25.0, 3: 10.0}
R_MIN_NET_SERVICE = {0: 60.0, 1: 40.0, 2: 15.0, 3: 10.0}
R_MIN_SHAPE = {"subway": 90.0, "lrt": 25.0, "streetcar": 10.0, "commuter_rail": 150.0,
               "airport_rail": 150.0, "intercity_rail": 150.0}
MIN_TURN = math.radians(1.0)  # ignore smaller vertex turns
MIN_SEG = 0.2  # m: shorter segments are merged away
NODE_KINK = {0: 6.0, 1: 8.0, 2: 12.0, 3: 20.0}  # deg of heading change through a node movement
TAN_D = 1.0  # m used for edge-end tangents (first segment: the geometric break at the node)
GAP_D = 25.0  # m between two dangling ends = hole in the track
TEE_D = 2.0  # m: a dangling end this close to another track runs into it unconnected
KINK_CLUSTER = 40.0  # m: one finding per cluster
TWIN_MIN, TWIN_MAX = 2.5, 16.0  # m: parallel twin track distance
TWIN_COS = math.cos(math.radians(12))

KIND_NAME = ["rail", "subway", "light rail", "tram"]
TILE_NAME = ["main line", "siding", "subway", "light rail", "streetcar", "rail"]


def _turns(x, y):
    """per interior vertex: turning angle and radius estimate, after merging tiny segments."""
    if len(x) < 3:
        return np.zeros(0, np.int64), np.zeros(0), np.zeros(0)
    keep = [0]
    for k in range(1, len(x)):
        if math.hypot(x[k] - x[keep[-1]], y[k] - y[keep[-1]]) >= MIN_SEG:
            keep.append(k)
    keep = np.array(keep)
    if len(keep) < 3:
        return np.zeros(0, np.int64), np.zeros(0), np.zeros(0)
    X, Y = x[keep], y[keep]
    dx, dy = np.diff(X), np.diff(Y)
    ln = np.hypot(dx, dy)
    a = np.arctan2(dy, dx)
    th = np.abs((np.diff(a) + math.pi) % (2 * math.pi) - math.pi)
    R = ((ln[:-1] + ln[1:]) / 2) / np.maximum(th, 1e-9)
    return keep[1:-1], th, R


def _kink_findings(x, y, z, rmin, label, osm, key_base, sub):
    v, th, R = _turns(x, y)
    bad = np.nonzero((th > MIN_TURN) & (R < rmin))[0]
    out = []
    last = None
    # worst per KINK_CLUSTER stretch
    groups = []
    for q in bad:
        i = v[q]
        if last is not None and math.hypot(x[i] - x[last], y[i] - y[last]) < KINK_CLUSTER:
            groups[-1].append(q)
        else:
            groups.append([q])
        last = i
    for gq in groups:
        q = min(gq, key=lambda t: R[t])
        i = v[q]
        b = math.atan2(y[min(i + 1, len(y) - 1)] - y[i - 1], x[min(i + 1, len(x) - 1)] - x[i - 1])
        out.append(finding("rail_kink", sub, rmin / max(R[q], 0.5), x[i], y[i], z[i] if z is not None else None, osm,
                           f"{label}: radius {R[q]:.0f} m (< {rmin:.0f} m), {math.degrees(th[q]):.0f} deg turn at one vertex",
                           key=("rail_kink", sub, key_base, round(x[i] / 10), round(y[i] / 10)), bearing=b))
    return out


# ============================================================================ per block (drawn tracks)
def run_block(B: Block, cats: set) -> list[dict]:
    L = B.rails
    out: list[dict] = []
    if not L.n or not ({"rail_kink", "rail_gap"} & cats):
        return out
    cls, flags, osm = L.attrs["class"], L.attrs["flags"], L.attrs["osm"]
    if "rail_kink" in cats:
        # stitch owned segments per piece into runs
        sp = L.seg_piece
        for p in np.unique(sp):
            if flags[p] & F_TUNNEL:
                continue
            s = L.seg[sp == p]
            # contiguous runs of owned segments
            brk = np.nonzero(np.diff(s) != 1)[0]
            for r in np.split(s, brk + 1):
                if len(r) < 2:
                    continue
                vi = np.concatenate([r, [r[-1] + 1]])
                c = min(int(cls[p]), 5)
                for fnd in _kink_findings(L.X[vi], L.Y[vi], L.Z[vi], R_MIN_TILE[c], f"drawn {TILE_NAME[c]} track (way {int(osm[p])})",
                                          [osm[p]], int(osm[p]), "tile_track"):
                    if B.in_core(fnd["e"], fnd["n"]):
                        out.append(fnd)
    if "rail_gap" in cats:
        E = B.piece_ends(L)
        if len(E["v"]):
            vt = cKDTree(np.column_stack([L.X, L.Y]))
            vp = L.vpiece()
            ex, ey = L.X[E["v"]], L.Y[E["v"]]
            eo = osm[E["p"]]
            dangling = np.array([not np.any(osm[vp[np.asarray(lst, np.int64)]] != eo[k]) if lst else True
                                 for k, lst in enumerate(vt.query_ball_point(np.column_stack([ex, ey]), 0.05))])
            live = dangling & ((flags[E["p"]] & F_TUNNEL) == 0)
            di = np.nonzero(live)[0]
            if len(di) > 1:
                dt = cKDTree(np.column_stack([ex[di], ey[di]]))
                for a, b in sorted(dt.query_pairs(GAP_D)):
                    i, j = di[a], di[b]
                    if eo[i] == eo[j] or cls[E["p"][i]] != cls[E["p"][j]]:
                        continue
                    # ends must face each other
                    dx, dy = ex[j] - ex[i], ey[j] - ey[i]
                    dd = math.hypot(dx, dy) or 1
                    if (E["dx"][i] * dx + E["dy"][i] * dy) / dd > -0.5 or (E["dx"][j] * -dx + E["dy"][j] * -dy) / dd > -0.5:
                        continue
                    x, y = (ex[i] + ex[j]) / 2, (ey[i] + ey[j]) / 2
                    if not B.in_core(x, y):
                        continue
                    c = min(int(cls[E["p"][i]]), 5)
                    out.append(finding("rail_gap", "hole", 2 + dd / 5, x, y, float(L.Z[E["v"][i]]), sorted([eo[i], eo[j]]),
                                       f"{dd:.1f} m hole between two {TILE_NAME[c]} track ends (ways {int(eo[i])}, {int(eo[j])})",
                                       key=("rail_gap", min(eo[i], eo[j]), max(eo[i], eo[j])), bearing=math.atan2(dy, dx)))
    return out


# ============================================================================ global (graph + routes)
def _load_net():
    if not NETWORK.exists():
        return None
    a, h = tbn.read(NETWORK)
    return a


def _tangent(P, at_end: bool):
    """unit tangent pointing *out of* the edge at the given end, over TAN_D."""
    if at_end:
        Q = P[::-1]
    else:
        Q = P
    d = np.hypot(Q[1:, 0] - Q[0, 0], Q[1:, 1] - Q[0, 1])
    k = int(np.searchsorted(d, TAN_D)) + 1
    k = min(max(k, 1), len(Q) - 1)
    v = Q[0, :2] - Q[k, :2]
    n = np.hypot(*v) or 1
    return v / n


def run_global(cats: set, bbox=None) -> list[dict]:
    out: list[dict] = []
    if not ({"rail_kink", "rail_gap", "route_track_conflict"} & cats):
        return out
    a = _load_net()
    if a is None:
        return out
    off = a["e_off"].astype(np.int64)
    xyz = a["e_xyz"].reshape(-1, 3).astype(np.float64)
    kind, svc, edir = a["e_kind"].astype(int), a["e_service"].astype(int), a["e_dir"].astype(int)
    eflags = a["e_flags"].astype(int)
    eosm = a["e_osm"]
    ef, et = a["e_from"].astype(np.int64), a["e_to"].astype(np.int64)
    nxyz = a["n_xyz"].reshape(-1, 3)
    nfl = a["n_flags"].astype(int)
    c_off, c_to = a["c_off"].astype(np.int64), a["c_to"].astype(np.int64)
    nE = len(ef)
    geom = [xyz[off[e]:off[e + 1]] for e in range(nE)]
    tunnel = (eflags & 2) != 0

    def inb(x, y):
        return bbox is None or (bbox[0] <= x < bbox[2] and bbox[1] <= y < bbox[3])

    if "rail_kink" in cats:
        for e in range(nE):
            P = geom[e]
            if len(P) < 3:
                continue
            k = int(kind[e])
            rmin = (R_MIN_NET_SERVICE if svc[e] else R_MIN_NET)[k]
            lab = f"rail graph {KIND_NAME[k]}{' service' if svc[e] else ''} edge {e} (way {int(eosm[e])}){' tunnel' if tunnel[e] else ''}"
            out += [f for f in _kink_findings(P[:, 0], P[:, 1], P[:, 2], rmin, lab, [eosm[e]], f"e{e}", "graph_edge") if inb(f["e"], f["n"])]
        # heading change through movements at nodes
        seen = set()
        for e in range(nE):
            for kend in (0, 1):
                t1 = _tangent(geom[e], kend == 1)  # travel direction leaving e through this end
                for m in c_to[c_off[2 * e + kend]:c_off[2 * e + kend + 1]]:
                    e2, k2 = int(m) // 2, int(m) % 2
                    pair = tuple(sorted(((e, kend), (e2, k2))))
                    if pair in seen:
                        continue
                    seen.add(pair)
                    t2 = -_tangent(geom[e2], k2 == 1)  # travel direction entering e2
                    ang = math.degrees(math.acos(max(-1.0, min(1.0, float(t1 @ t2)))))
                    kk = max(int(kind[e]), int(kind[e2]))
                    lim = NODE_KINK[kk]
                    if ang > lim:
                        P = geom[e][-1] if kend == 1 else geom[e][0]
                        if not inb(P[0], P[1]):
                            continue
                        out.append(finding("rail_kink", "node_movement", ang / lim, P[0], P[1], P[2], [eosm[e], eosm[e2]],
                                           f"{KIND_NAME[kk]} movement edge {e} -> {e2} turns {ang:.0f} deg at the node (> {lim:.0f})",
                                           key=("rail_kink", "node", pair), bearing=math.atan2(t1[1], t1[0])))
    if "rail_gap" in cats:
        ends = np.nonzero(nfl & 4)[0]
        if len(ends):
            # segments of all edges for "runs into another track"
            segs_e = np.concatenate([np.full(max(len(g) - 1, 0), e) for e, g in enumerate(geom)])
            A = np.concatenate([g[:-1, :2] for g in geom if len(g) > 1])
            Bb = np.concatenate([g[1:, :2] for g in geom if len(g) > 1])
            mid = (A + Bb) / 2
            st = cKDTree(mid)
            half = float(np.max(np.hypot(*(Bb - A).T))) / 2
            node_edges = {}
            for e in range(nE):
                node_edges.setdefault(int(ef[e]), []).append(e)
                node_edges.setdefault(int(et[e]), []).append(e)
            et_ = cKDTree(nxyz[ends, :2])
            for i, j in sorted(et_.query_pairs(GAP_D)):
                ni, nj = ends[i], ends[j]
                x, y = (nxyz[ni, :2] + nxyz[nj, :2]) / 2
                if not inb(x, y):
                    continue
                ei, ej = node_edges[int(ni)][0], node_edges[int(nj)][0]
                if tunnel[ei] and tunnel[ej]:
                    continue
                ti = _tangent(geom[ei], et[ei] == ni)
                tj = _tangent(geom[ej], et[ej] == nj)
                dv = nxyz[nj, :2] - nxyz[ni, :2]
                dd = float(np.hypot(*dv)) or 1
                if ti @ dv / dd < 0.7 or tj @ -dv / dd < 0.7:
                    continue
                out.append(finding("rail_gap", "graph_gap", 2 + dd / 5, x, y, float(nxyz[ni, 2]), [eosm[ei], eosm[ej]],
                                   f"{KIND_NAME[kind[ei]]} track ends face each other {dd:.1f} m apart, not connected (graph nodes {ni}/{nj})",
                                   key=("rail_gap", "g", int(ni), int(nj))))
            for n in ends:
                P = nxyz[n]
                if not inb(P[0], P[1]):
                    continue
                own = set(node_edges[int(n)])
                cand = st.query_ball_point(P[:2], TEE_D + half)
                best = None
                for c in cand:
                    e2 = int(segs_e[c])
                    if e2 in own or kind[e2] != kind[next(iter(own))]:
                        continue
                    a0, a1 = A[c], Bb[c]
                    d = a1 - a0
                    t = np.clip(((P[:2] - a0) @ d) / max(d @ d, 1e-9), 0, 1)
                    dist = float(np.hypot(*(P[:2] - (a0 + d * t))))
                    if dist < TEE_D and (best is None or dist < best[0]):
                        best = (dist, e2)
                if best:
                    e1 = next(iter(own))
                    out.append(finding("rail_gap", "unconnected_tee", 3 - best[0], P[0], P[1], P[2], [eosm[e1], eosm[best[1]]],
                                       f"{KIND_NAME[kind[e1]]} track ends {best[0]:.1f} m from edge {best[1]} without a switch",
                                       key=("rail_gap", "t", int(n))))
    if "route_track_conflict" in cats or "rail_kink" in cats:
        out += _routes(geom, kind, svc, edir, eosm, c_off, c_to, cats, inb)
    return out


def _routes(geom, kind, svc, edir, eosm, c_off, c_to, cats, inb) -> list[dict]:
    out = []
    nE = len(geom)
    mids = np.array([g[len(g) // 2, :2] for g in geom])
    heads = np.array([math.atan2(g[-1, 1] - g[0, 1], g[-1, 0] - g[0, 0]) for g in geom])
    mt = cKDTree(mids)
    used: dict = {}  # (route id, edge) -> set of senses
    seen_pat = set()
    shape_seen = set()
    for p in sorted(TRANSIT.glob("*_rail.bin.gz")):
        a, h = tbn.read(p)
        routes = h.get("routes", [])
        modes = h.get("modes", [])
        if "pat_redge_off" not in a:
            continue
        ro, re_ = a["pat_redge_off"].astype(np.int64), a["pat_redge"].astype(np.int64)
        rfl = a["pat_rflags"]
        soff = a["shape_off"].astype(np.int64)
        sxyz = a["shape_xyz"].reshape(-1, 3).astype(np.float64)
        for pi in range(len(rfl)):
            r = routes[int(a["pat_route"][pi])]
            rid = r["id"]
            mode = modes[int(a["pat_mode"][pi])]
            if mode == "bus":
                continue
            edges = re_[ro[pi]:ro[pi + 1]]
            sig = (rid, int(a["pat_dir"][pi]), hash(edges.tobytes()), int(rfl[pi]))
            s = int(a["pat_shape"][pi])
            S = sxyz[soff[s]:soff[s + 1]]
            lab = f"{r.get('agency')} {r.get('short')} {r.get('long', '')[:40]} dir {int(a['pat_dir'][pi])}"
            # shape kinks (vehicles follow the shape)
            if "rail_kink" in cats and len(S) > 2:
                sk = hash(S.tobytes())
                if sk not in shape_seen:
                    shape_seen.add(sk)
                    rmin = R_MIN_SHAPE.get(mode, 25.0)
                    out += [f for f in _kink_findings(S[:, 0], S[:, 1], S[:, 2], rmin, f"{lab} shape", [], "shape", "pattern_shape")
                            if inb(f["e"], f["n"])]
            if sig in seen_pat or "route_track_conflict" not in cats:
                continue
            seen_pat.add(sig)
            if len(S) == 0:
                continue
            x0, y0, z0 = S[0]
            if rfl[pi] != 1:
                if inb(x0, y0):
                    out.append(finding("route_track_conflict", "unrouted" if rfl[pi] == 0 else "route_not_ok", 5.0, x0, y0, z0, [],
                                       f"{lab}: {'no track route (vehicles follow the raw GTFS shape)' if rfl[pi] == 0 else 'track route incomplete / bridged'}",
                                       key=("route_track_conflict", "r", sig)))
                if rfl[pi] == 0:
                    continue
            prev = None
            for m in edges:
                e, d = int(m) // 2, int(m) % 2
                if e >= nE:
                    break
                allowed = edir[e] & (1 if d == 0 else 2)
                g = geom[e]
                if not allowed:
                    x, y, z = g[len(g) // 2]
                    if inb(x, y):
                        out.append(finding("route_track_conflict", "against_track_direction", 4.0, x, y, z, [eosm[e]],
                                           f"{lab} runs edge {e} ({KIND_NAME[kind[e]]}) against its allowed direction",
                                           key=("route_track_conflict", "dir", rid, e, d), bearing=heads[e] + (math.pi if d else 0)))
                if prev is not None:
                    pe, pd = prev
                    kend = 1 if pd == 0 else 0
                    enter = 2 * e + (0 if d == 0 else 1)
                    if enter not in set(c_to[c_off[2 * pe + kend]:c_off[2 * pe + kend + 1]].tolist()):
                        x, y, z = geom[pe][-1] if kend == 1 else geom[pe][0]
                        if inb(x, y):
                            out.append(finding("route_track_conflict", "discontinuous", 6.0, x, y, z, [eosm[pe], eosm[e]],
                                               f"{lab}: no movement from edge {pe} to edge {e} (route jumps between tracks)",
                                               key=("route_track_conflict", "jump", rid, pe, e)))
                used.setdefault((rid, e), set()).add(d)
                prev = (e, d)
    if "route_track_conflict" in cats:
        for (rid, e), senses in sorted(used.items()):
            if len(senses) < 2 or kind[e] == 0 or svc[e]:
                continue
            # a parallel twin exists -> this should be double track, one direction each
            twin = False
            for c in mt.query_ball_point(mids[e], TWIN_MAX):
                if c == e or kind[c] != kind[e]:
                    continue
                dd = float(np.hypot(*(mids[c] - mids[e])))
                if dd >= TWIN_MIN and abs(math.cos(heads[c] - heads[e])) > TWIN_COS:
                    twin = True
                    break
            if twin:
                x, y, z = geom[e][len(geom[e]) // 2]
                if inb(x, y):
                    out.append(finding("route_track_conflict", "shared_double_track", 5.0, x, y, z, [eosm[e]],
                                       f"{rid}: both directions run on edge {e} ({KIND_NAME[kind[e]]}) although a parallel twin track exists",
                                       key=("route_track_conflict", "shared", rid, e), bearing=heads[e]))
    return out


RAIL_CATS = {"rail_kink", "rail_gap", "route_track_conflict"}
