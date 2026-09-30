"""OSM rail network + snapping of GTFS rail shapes onto the real track geometry.

The network is every OSM way with railway in {rail, subway, light_rail, tram,
narrow_gauge} (yards excluded), split into ~15 m pieces for spatial lookup and
turned into a node graph for gap filling.

Map matching (per GTFS shape), an HMM solved with Viterbi:
  1. densify the shape (10 m; 20 m for main-line rail);
  2. candidates per point: up to K_CAND compatible track positions within RADIUS,
     roughly parallel to the shape. Emission cost = distance (Gaussian) + angle +
     siding penalty + right-hand running (tracks left of the rightmost parallel
     track cost more; tram ways drawn against the travel direction cost more,
     since Toronto's tram tracks are mapped one way per direction);
  3. transitions only along the track graph (`_reach`: no reversing, no turn
     sharper than acos(TURN_COS) at a node, i.e. no leg-to-leg at a switch), cost
     = |route length - shape length| / BETA. A parallel track is therefore only
     reachable through a real crossover, so the result never jumps sideways;
  4. rebuild the line along the chosen track path. Where no continuous transition
     exists the chain breaks; gaps are bridged by a bounded shortest path, else
     the GTFS points are kept (flagged, reported as fallback metres).
Each output vertex carries tunnel/bridge flags from its OSM way.
"""

from __future__ import annotations

import heapq

import numpy as np
from scipy import sparse
from scipy.sparse.csgraph import dijkstra
from scipy.spatial import cKDTree

from . import geo

KINDS = {"rail": 0, "subway": 1, "light_rail": 2, "tram": 3, "narrow_gauge": 0}
MODE_KINDS = {
    "subway": {1, 2},
    "lrt": {2, 3, 1},
    "streetcar": {3, 2},
    "commuter_rail": {0},
    "airport_rail": {0},
    "intercity_rail": {0},
}
STEP = 10.0
RADIUS = 50.0
# HMM map matching
PAR_EXTRA = 15.0  # m
K_CAND = 14  # candidate track positions per shape point (roughly parallel to it)
K_STEEP = 3  # extra candidates at a steep angle to the shape
BETA = 6.0  # m: scale of |track route length - shape length| in the transition cost
TURN_COS = 0.2  # a train path never turns more than ~78 deg at a node (no leg-to-leg at a switch)
RIGHT_W = 0.12  # cost per m (per point) of running left of the rightmost parallel track
TRAM_REV = 0.8  # cost per point of running against a (directional) tram way
DEBUG = False
GAP_SPAN = 50.0  # m: half length of the S-curve that bridges a short track gap
BREAK_PEN = 1000.0  # a non-continuous transition (gap): only where the network is really disconnected
SIG_REL = 6.0  # m: emission scale of the distance relative to the nearest candidate
SIG_ABS = 15.0  # m: emission scale of the absolute distance
SWITCH_PEN = 0.05  # per transition that changes segment (discourages needless hops)
PIECE = 15.0
CACHE = geo.WORK / "transit_rail.npz"


def _extract() -> dict[str, np.ndarray]:
    import osmium

    tf = osmium.filter.TagFilter(*[("railway", k) for k in KINDS])
    fp = (
        osmium.FileProcessor(str(geo.RAW / "bbox.osm.pbf"), osmium.osm.NODE | osmium.osm.WAY)
        .with_locations()
        .with_filter(osmium.filter.EntityFilter(osmium.osm.WAY))
        .with_filter(tf)
    )
    lon, lat, ref, off, kind, flags, service, wid = [], [], [], [0], [], [], [], []
    for w in fp:
        t = w.tags
        svc = t.get("service")
        if svc == "yard":
            continue
        pts = [(n.ref, n.lon, n.lat) for n in w.nodes if n.location.valid()]
        if len(pts) < 2:
            continue
        for r, x, y in pts:
            ref.append(r)
            lon.append(x)
            lat.append(y)
        off.append(len(ref))
        kind.append(KINDS[t.get("railway")])
        layer = t.get("layer", "0")
        try:
            layer = int(float(layer.split(";")[0]))
        except ValueError:
            layer = 0
        tun = t.get("tunnel", "no") not in ("no", "") or t.get("location") == "underground" or (
            layer < 0 and t.get("bridge", "no") == "no"
        )
        bri = t.get("bridge", "no") not in ("no", "") or (layer > 0 and not tun)
        flags.append((1 if bri else 0) | (2 if tun else 0))
        service.append(0 if svc is None else (1 if svc in ("siding", "spur") else 2))
        wid.append(w.id)
    x, y = geo.project(np.array(lon), np.array(lat))
    arrs = dict(
        xy=np.stack([x, y], 1).astype(np.float64),
        ref=np.array(ref, dtype=np.int64),
        off=np.array(off, dtype=np.int64),
        kind=np.array(kind, dtype=np.int8),
        flags=np.array(flags, dtype=np.int8),
        service=np.array(service, dtype=np.int8),
        wid=np.array(wid, dtype=np.int64),
    )
    geo.WORK.mkdir(parents=True, exist_ok=True)
    np.savez(CACHE, **arrs)
    return arrs


class RailNet:
    def __init__(self) -> None:
        if CACHE.exists() and CACHE.stat().st_mtime > (geo.RAW / "bbox.osm.pbf").stat().st_mtime:
            d = dict(np.load(CACHE))
        else:
            d = _extract()
        self.xy = d["xy"]
        self.off = d["off"]
        self.kind = d["kind"]
        self.flags = d["flags"]
        self.service = d["service"]
        nw = len(self.kind)
        self.vway = np.repeat(np.arange(nw), np.diff(self.off))
        # graph over unique OSM node ids
        uniq, inv = np.unique(d["ref"], return_inverse=True)
        self.vnode = inv  # vertex -> graph node
        self.nxy = np.zeros((len(uniq), 2))
        self.nxy[inv] = self.xy
        a = np.arange(len(self.xy) - 1)
        a = a[self.vway[a] == self.vway[a + 1]]  # segments within a way
        self.seg_a = a  # segment i: vertices a, a+1
        seglen = np.hypot(*(self.xy[a + 1] - self.xy[a]).T)
        self.seglen = seglen
        # cumulative distance per vertex along its way
        cum = np.zeros(len(self.xy))
        cum[a + 1] = seglen
        self.vdist = np.zeros(len(self.xy))
        for w in range(nw):
            s, e = self.off[w], self.off[w + 1]
            self.vdist[s:e] = np.cumsum(cum[s:e])
        self.kinds = {}
        n = len(uniq)
        self.graph_kind: dict[frozenset, sparse.csr_matrix] = {}
        self._edges = (inv[a], inv[a + 1], seglen, self.kind[self.vway[a]])
        self._n = n
        # spatial index over segment pieces
        pts, pseg = [], []
        for i, (ai, L) in enumerate(zip(a, seglen)):
            k = max(1, int(np.ceil(L / PIECE)))
            t = (np.arange(k) + 0.5) / k
            p = self.xy[ai] + (self.xy[ai + 1] - self.xy[ai]) * t[:, None]
            pts.append(p)
            pseg.append(np.full(k, i))
        self.piece_seg = np.concatenate(pseg)
        self.tree = cKDTree(np.vstack(pts))
        ab = self.xy[a + 1] - self.xy[a]
        self.sdir = ab / np.maximum(seglen, 1e-9)[:, None]  # unit direction per segment
        # zero-length segments (duplicate positions) take the direction of a neighbour in their way
        for i in np.nonzero(seglen <= 0.01)[0].tolist():
            for j in (i - 1, i + 1, i - 2, i + 2):
                if 0 <= j < len(a) and self.vway[a[j]] == self.vway[a[i]] and seglen[j] > 0.01:
                    self.sdir[i] = self.sdir[j]
                    break
        self._adj_cache: dict = {}
        self._reach_cache: dict = {}
        self.last_stats: dict = {}

    def graph(self, kinds: frozenset) -> sparse.csr_matrix:
        g = self.graph_kind.get(kinds)
        if g is None:
            u, v, w, k = self._edges
            m = np.isin(k, list(kinds))
            g = sparse.coo_matrix(
                (np.concatenate([w[m], w[m]]), (np.concatenate([u[m], v[m]]), np.concatenate([v[m], u[m]]))),
                shape=(self._n, self._n),
            ).tocsr()
            self.graph_kind[kinds] = g
        return g

    # ------------------------------------------------------------------
    def _way_run(self, w: int, s0: float, s1: float) -> tuple[np.ndarray, int]:
        """Points of way w strictly between along-way distances s0 and s1 (either order)."""
        a, b = self.off[w], self.off[w + 1]
        vd = self.vdist[a:b]
        if s1 >= s0:
            idx = np.nonzero((vd > s0) & (vd < s1))[0]
        else:
            idx = np.nonzero((vd < s0) & (vd > s1))[0][::-1]
        return self.xy[a + idx], int(self.flags[w])

    # ------------------------------------------------------------------ map matching
    def _adj(self, kinds: frozenset) -> list:
        """Adjacency per graph node: (segment, other node, length, dir) with dir = +1 when
        leaving the node runs along the way's drawing direction."""
        adj = self._adj_cache.get(kinds)
        if adj is not None:
            return adj
        adj = [[] for _ in range(self._n)]
        ok = np.isin(self.kind[self.vway[self.seg_a]], list(kinds))
        a = self.seg_a
        u = self.vnode[a]
        v = self.vnode[a + 1]
        for i in np.nonzero(ok)[0].tolist():
            L = float(self.seglen[i])
            adj[u[i]].append((i, int(v[i]), L, 1))
            adj[v[i]].append((i, int(u[i]), L, -1))
        self._adj_cache[kinds] = adj
        return adj

    def _reach(self, s: int, d: int, adj: list, lim: float) -> dict:
        """Track-continuous search from the exit end of segment s travelled in direction d.
        Returns {(seg, dir): (cost to the entry of seg, previous (seg, dir))}. Paths never
        reverse and never turn more than acos(TURN_COS) at a node (no leg-to-leg at a switch)."""
        key = (s, d, lim)
        r = self._reach_cache.get(key)
        if r is not None:
            return r
        a = self.seg_a[s]
        n0 = int(self.vnode[a + 1] if d > 0 else self.vnode[a])
        sd = self.sdir
        best: dict = {}
        seen = {(n0, s): 0.0}
        heap = [(0.0, n0, s, d)]
        while heap:
            c, n, vs, vd = heapq.heappop(heap)
            if seen.get((n, vs), np.inf) < c:
                continue
            ux, uy = sd[vs, 0] * vd, sd[vs, 1] * vd
            for s2, n2, L, d2 in adj[n]:
                if s2 == vs:
                    continue
                if ux * sd[s2, 0] * d2 + uy * sd[s2, 1] * d2 < TURN_COS:
                    continue
                k = (s2, d2)
                b = best.get(k)
                if b is None or c < b[0]:
                    best[k] = (c, (vs, vd))
                c2 = c + L
                if c2 > lim or seen.get((n2, s2), np.inf) <= c2:
                    continue
                seen[(n2, s2)] = c2
                heapq.heappush(heap, (c2, n2, s2, d2))
        if len(self._reach_cache) > 400_000:
            self._reach_cache.clear()
        self._reach_cache[key] = best
        return best

    def _match_cands(self, pts: np.ndarray, tang: np.ndarray, kinds: set):
        """Per point: arrays (seg, t, dir, cost) of up to K_CAND candidate track positions."""
        hits = self.tree.query_ball_point(pts, RADIUS + PAR_EXTRA + PIECE)
        kinds_arr = np.array(sorted(kinds))
        out = []
        for p, tg, h in zip(pts, tang, hits):
            if not h:
                out.append(None)
                continue
            segs = np.unique(self.piece_seg[h])
            segs = segs[np.isin(self.kind[self.vway[self.seg_a[segs]]], kinds_arr) & (self.seglen[segs] > 0.01)]
            if len(segs) == 0:
                out.append(None)
                continue
            A = self.xy[self.seg_a[segs]]
            AB = self.xy[self.seg_a[segs] + 1] - A
            L2 = np.maximum((AB**2).sum(1), 1e-9)
            t = np.clip(((p - A) * AB).sum(1) / L2, 0, 1)
            q = A + AB * t[:, None]
            d = np.hypot(*(q - p).T)
            cos = self.sdir[segs] @ tg
            m = np.abs(cos) > 0.4
            if not m.any() or d[m].min() >= RADIUS:
                out.append(None)
                continue
            # every track within PAR_EXTRA of the nearest aligned one competes (parallel
            # tracks); tracks at a steep angle to the shape are kept too (both directions,
            # angle-penalised) for where the GTFS shape cuts a corner differently than the
            # track does — the track graph decides whether they are reachable
            near = d < d[m].min() + PAR_EXTRA
            ways_all = self.vway[self.seg_a[segs]]
            along_all = (self.vdist[self.seg_a[segs]] + t * self.seglen[segs]) // 30.0
            picks: list[tuple[int, int]] = []  # (index, dir)
            for aligned, cap in ((True, K_CAND), (False, K_STEEP)):
                sel = np.nonzero(near & (m if aligned else ~m))[0]
                sel = sel[np.argsort(d[sel])]
                seen, cnt = set(), 0
                for o in sel.tolist():
                    k = (int(ways_all[o]), int(along_all[o]))  # one per (way, 30 m stretch)
                    if k in seen:
                        continue
                    seen.add(k)
                    if aligned:
                        picks.append((o, 1 if cos[o] >= 0 else -1))
                    else:
                        picks += [(o, 1), (o, -1)]
                    cnt += 1
                    if cnt >= cap:
                        break
            keep = np.array([o for o, _ in picks])
            dirs = np.array([dd for _, dd in picks])
            segs, t, q, d, cos, ways = segs[keep], t[keep], q[keep], d[keep], cos[keep], ways_all[keep]
            lat = (q - p) @ np.array([tg[1], -tg[0]])  # + = right of travel
            # relative distance (the GTFS shape is often offset from all tracks alike) + a weak absolute term
            cost = 0.5 * ((d - d.min()) / SIG_REL) ** 2 + 0.5 * (d / SIG_ABS) ** 2 + 3.0 * (1 - np.abs(cos)) + 0.6 * (self.service[ways] > 0)
            # right-hand running: penalise tracks left of the rightmost parallel one
            par = (d < d.min() + 10.0) & (np.abs(cos) > 0.9)
            if par.sum() > 1:
                cost = cost + np.where(par, RIGHT_W * np.maximum(0.0, lat[par].max() - lat), 0.0)
            # tram tracks are mapped per direction, drawn in the direction of travel
            cost = cost + np.where((self.kind[ways] == 3) & (dirs < 0), TRAM_REV, 0.0)
            out.append((segs, t, dirs, cost))
        return out

    def snap(self, xy: np.ndarray, mode: str) -> tuple[np.ndarray, np.ndarray, np.ndarray, float]:
        """Map-match shape `xy` (world m) onto one continuous path through the track graph
        (HMM / Viterbi). Returns (xy, bridge_mask, tunnel_mask, matched_fraction)."""
        kinds = MODE_KINDS[mode]
        heavy = mode in ("commuter_rail", "airport_rail", "intercity_rail")
        step = 20.0 if heavy else STEP
        pts, _ = densify_xy(xy, step)
        n = len(pts)
        # smoothed tangent (±2 points)
        k = 2
        fwd = pts[np.minimum(np.arange(n) + k, n - 1)] - pts[np.maximum(np.arange(n) - k, 0)]
        tang = fwd / np.maximum(np.hypot(*fwd.T), 1e-9)[:, None]
        cands = self._match_cands(pts, tang, kinds)
        adj = self._adj(frozenset(kinds))
        cum = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(pts, axis=0).T))])
        seglen = self.seglen

        def route_len(sa, ta, da, sb, tb, db, od):
            """Track distance from state a to state b (None if not track-continuous)."""
            La, Lb = seglen[sa], seglen[sb]
            if sa == sb and da == db:
                prog = (tb - ta) * La * da
                if prog >= -1.0:
                    return max(prog, 0.0), False
            lim = min(2000.0, od * 2.0 + 40.0)
            lim = float(2 ** np.ceil(np.log2(lim)))  # few distinct limits -> cache hits
            r = self._reach(sa, da, adj, lim)
            e = r.get((sb, db))
            if e is None:
                return None, False
            return ((1 - ta) * La if da > 0 else ta * La) + e[0] + (tb * Lb if db > 0 else (1 - tb) * Lb), e[1][0] != sa

        def trans(ca, ia, cb, ib, od):
            L, sw = route_len(int(ca[0][ia]), float(ca[1][ia]), int(ca[2][ia]),
                              int(cb[0][ib]), float(cb[1][ib]), int(cb[2][ib]), od)
            if L is None:
                return BREAK_PEN
            return abs(L - od) / BETA + SWITCH_PEN * sw

        # Viterbi over the points that have candidates. A transition that is not
        # track-continuous costs BREAK_PEN (a gap, bridged later), so the optimum
        # uses as few gaps as possible and never chooses one to change tracks.
        obs = [i for i in range(n) if cands[i] is not None]
        self.last_stats = {"chains": 0, "fallback_m": 0.0}
        if len(obs) < 2:
            return pts, np.zeros(n, bool), np.zeros(n, bool), 0.0
        cost = cands[obs[0]][3].copy()
        back: list[np.ndarray] = []
        for q in range(1, len(obs)):
            i, ip = obs[q], obs[q - 1]
            c, p = cands[i], cands[ip]
            od = float(cum[i] - cum[ip])
            nb = len(c[0])
            new = np.full(nb, np.inf)
            bp = np.zeros(nb, dtype=np.int32)
            for a in range(len(p[0])):
                ca = cost[a]
                for b in range(nb):
                    v = ca + trans(p, a, c, b, od)
                    if v < new[b]:
                        new[b] = v
                        bp[b] = a
            cost = new + c[3]
            back.append(bp)
        j = int(np.argmin(cost))
        seq = [j]
        for bp in reversed(back):
            j = int(bp[j])
            seq.append(j)
        seq.reverse()
        path = list(zip(obs, seq))

        out_xy: list[np.ndarray] = []
        out_fl: list[np.ndarray] = []
        FALLBACK = 4

        def emit(p, fl):
            p = np.atleast_2d(p)
            if len(p):
                out_xy.append(p)
                out_fl.append(np.full(len(p), fl, dtype=np.int8))

        def state(i, j):
            c = cands[i]
            return int(c[0][j]), float(c[1][j]), int(c[2][j])

        def point(s, t):
            a = self.seg_a[s]
            return self.xy[a] + (self.xy[a + 1] - self.xy[a]) * t

        def sflag(s):
            return int(self.flags[self.vway[self.seg_a[s]]])

        def exit_node(s, d):
            a = self.seg_a[s]
            return int(self.vnode[a + 1] if d > 0 else self.vnode[a])

        g = None
        chains = 1
        # short gaps (disconnected OSM topology between close tracks, e.g. at Union) are
        # replaced by a smooth S-curve spanning GAP_SPAN m either side, like a crossover
        npth = len(path)
        feas = [route_len(*state(*path[q]), *state(*path[q + 1]), float(cum[path[q + 1][0]] - cum[path[q][0]]))[0] is not None
                for q in range(npth - 1)]
        skip = np.zeros(npth, bool)
        blend_to = {}  # kept state q0 -> kept state q1 joined by a Hermite curve
        for q in range(npth - 1):
            od = float(cum[path[q + 1][0]] - cum[path[q][0]])
            if feas[q] or od > 80.0:
                continue
            q0, q1 = q, q + 1
            while q0 > 0 and cum[path[q][0]] - cum[path[q0][0]] < GAP_SPAN and not skip[q0 - 1] and feas[q0 - 1]:
                q0 -= 1
            while q1 < npth - 1 and cum[path[q1][0]] - cum[path[q + 1][0]] < GAP_SPAN and feas[q1]:
                q1 += 1
            skip[q0 + 1 : q1] = True
            blend_to[q0] = q1
        if path[0][0] > 0:
            emit(pts[: path[0][0]], FALLBACK)
        s, t, d = state(*path[0])
        emit(point(s, t), sflag(s))
        q = 0
        while q < npth - 1:
            (ia, ja) = path[q]
            if q in blend_to:
                q1 = blend_to[q]
                ib, jb = path[q1]
                sa, ta, da = state(ia, ja)
                sb, tb, db = state(ib, jb)
                chains += 1
                p0, p1 = point(sa, ta), point(sb, tb)
                L = float(np.hypot(*(p1 - p0)))
                m0, m1 = self.sdir[sa] * da * L, self.sdir[sb] * db * L
                k = max(2, int(L / 5.0))
                u = (np.arange(1, k) / k)[:, None]
                h00, h10, h01, h11 = 2 * u**3 - 3 * u**2 + 1, u**3 - 2 * u**2 + u, -2 * u**3 + 3 * u**2, u**3 - u**2
                emit(h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1, sflag(sa) & sflag(sb))
                emit(p1, sflag(sb))
                if DEBUG:
                    print("blend at", p1.round(1), "over", round(L), "m")
                    for qq in range(q, q1):
                        if not feas[qq]:
                            (x0, y0), (x1, y1) = path[qq], path[qq + 1]
                            print("   infeasible", state(x0, y0), int(self.vway[self.seg_a[state(x0, y0)[0]]]), "->", state(x1, y1), int(self.vway[self.seg_a[state(x1, y1)[0]]]), pts[x0].round(1), pts[x1].round(1))
                q = q1
                continue
            ib, jb = path[q + 1]
            sa, ta, da = state(ia, ja)
            sb, tb, db = state(ib, jb)
            od = float(cum[ib] - cum[ia])
            if not feas[q]:
                # long gap: bounded shortest path on the track graph, else the GTFS points
                chains += 1
                if DEBUG:
                    print("gap at", pts[ib].round(1), "after", round(od), "m", "from way", int(self.vway[self.seg_a[sa]]), sa, round(ta, 3), da, "to way", int(self.vway[self.seg_a[sb]]), sb, round(tb, 3), db)
                pm = (int(self.vway[self.seg_a[sa]]), sa, float(self.vdist[self.seg_a[sa]] + ta * seglen[sa]))
                m = (int(self.vway[self.seg_a[sb]]), sb, float(self.vdist[self.seg_a[sb]] + tb * seglen[sb]))
                if g is None:
                    g = self.graph(frozenset(kinds))
                gp = self._path(g, pm, m, gtfs_len=od)
                if gp is None:
                    emit(pts[ia + 1 : ib], FALLBACK)
                else:
                    for pp, fl in gp:
                        emit(pp, fl)
            elif not (sa == sb and da == db and (tb - ta) * da * seglen[sa] >= -1.0):
                lim = float(2 ** np.ceil(np.log2(min(2000.0, od * 2.0 + 40.0))))
                r = self._reach(sa, da, adj, lim)
                segs = []
                k = (sb, db)
                while k != (sa, da):
                    segs.append(k)
                    k = r[k][1]
                segs.reverse()  # intermediate segments ..., then (sb, db)
                emit(self.nxy[exit_node(sa, da)], sflag(sa))
                for s2, d2 in segs[:-1]:
                    emit(self.nxy[exit_node(s2, d2)], sflag(s2))
            emit(point(sb, tb), sflag(sb))
            q += 1
        i_end = path[-1][0]
        if i_end < n - 1:
            emit(pts[i_end + 1 :], FALLBACK)
        rxy = np.vstack(out_xy)
        rfl = np.concatenate(out_fl)
        # drop duplicate consecutive points
        keep = np.ones(len(rxy), bool)
        keep[1:] = np.hypot(*np.diff(rxy, axis=0).T) > 0.05
        rxy, rfl = rxy[keep], rfl[keep]
        # fallback vertices inherit tunnel flag when both neighbours are tunnel
        fb = (rfl & FALLBACK) > 0
        tun = (rfl & 2) > 0
        bri = (rfl & 1) > 0
        if fb.any():
            idx = np.arange(len(rfl))
            good = ~fb
            if good.any():
                gi = idx[good]
                lo = np.searchsorted(gi, idx, side="right") - 1
                hi = np.searchsorted(gi, idx, side="left")
                lo_t = np.where(lo >= 0, tun[gi[np.clip(lo, 0, len(gi) - 1)]], False)
                hi_t = np.where(hi < len(gi), tun[gi[np.clip(hi, 0, len(gi) - 1)]], False)
                tun = np.where(fb, lo_t & hi_t, tun)
        seg = np.hypot(*np.diff(rxy, axis=0).T)
        on_track = float(seg[~(fb[:-1] | fb[1:])].sum() / max(seg.sum(), 1e-9))
        self.last_stats["chains"] = chains
        self.last_stats["fallback_m"] = float(seg[fb[:-1] | fb[1:]].sum())
        return rxy, bri, tun, on_track

    def _path(self, g, pm, m, gtfs_len: float):
        """Track path between two matches on (possibly) different ways, as a list of
        (points, flags) chunks, or None if implausible."""
        w0, s0, d0 = pm
        w1, s1, d1 = m
        a0 = self.seg_a[s0]
        a1 = self.seg_a[s1]
        # exits from the first segment: its two end vertices with partial lengths
        ex = [(a0, d0 - self.vdist[a0]), (a0 + 1, self.vdist[a0 + 1] - d0)]
        en = [(a1, d1 - self.vdist[a1]), (a1 + 1, self.vdist[a1 + 1] - d1)]
        limit = gtfs_len * 1.6 + 150.0
        src = np.array([self.vnode[v] for v, _ in ex])
        dist, pred = dijkstra(g, indices=src, return_predecessors=True, limit=limit)
        best = None
        for i, (v0, l0) in enumerate(ex):
            for v1, l1 in en:
                L = l0 + dist[i, self.vnode[v1]] + l1
                if np.isfinite(L) and (best is None or L < best[0]):
                    best = (L, i, v0, v1)
        if best is None or best[0] > limit:
            return None
        L, i, v0, v1 = best
        nodes = []
        n = self.vnode[v1]
        s = self.vnode[v0]
        while n != s and n >= 0:
            nodes.append(n)
            n = pred[i, n]
        if n < 0:
            return None
        nodes.append(s)
        nodes.reverse()
        # flags per node from the source ways (approx: flag of whichever way used)
        chunks = []
        fl0 = int(self.flags[w0])
        fl1 = int(self.flags[w1])
        pts = self.nxy[np.array(nodes)]
        # flags: midpoint lookup of nearest way-vertex flag is costly; use the
        # stronger of the endpoint flags on short paths, else ends.
        fl = fl0 if fl0 == fl1 else 0
        chunks.append((pts, fl))
        return chunks


def densify_xy(xy: np.ndarray, step: float) -> tuple[np.ndarray, np.ndarray]:
    """Like grade.densify but vectorized."""
    d = np.hypot(*np.diff(xy, axis=0).T)
    n = np.maximum(1, np.ceil(d / step).astype(int))
    seg = np.repeat(np.arange(len(d)), n)
    k = np.concatenate([np.arange(c) for c in n]) if len(n) else np.zeros(0, int)
    t = ((k + 1) / np.repeat(n, n))[:, None]
    body = xy[seg] + (xy[seg + 1] - xy[seg]) * t
    return np.vstack([xy[:1], body]), np.concatenate([[0], seg])
