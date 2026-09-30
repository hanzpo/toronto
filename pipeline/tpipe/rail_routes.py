"""Per-pattern routing of GTFS rail trips through the switch-level track graph
(`rail_graph`). See docs/RAIL.md.

A pattern becomes a directed path of graph edges from the platform of its first
stop to the platform of its last stop:

  * candidates per stop: every compatible track within reach of the GTFS shape
    at that stop, travelled in the shape's direction and allowed by the track's
    direction rule; the stop point on a candidate is where the consist *front*
    stops (platform end in the direction of travel, else the GTFS stop centred
    under the train; streetcars stop with the front door at the pole);
  * between consecutive stops: shortest valid path (Dijkstra over directed edge
    states, following only the movement rules at switches -- never reversing,
    never leg-to-leg) where an edge's cost is its length weighted by its
    distance to the GTFS shape *between those two stops* (so loops and
    out-and-back patterns work), with penalties for sidings / yards, running
    against the shape and, on main-line rail, left-hand running;
  * Viterbi over the stop candidates picks the consistent sequence (the track a
    train arrives on is the track it leaves from);
  * the route is extended back from the first stop by the consist length (so
    the train at its first stop stands on the route).

The route geometry (draped track) replaces the GTFS shape of the pattern.
"""

from __future__ import annotations

import heapq
import math

import numpy as np
from scipy.spatial import cKDTree

from .rail_graph import RailGraph

# graph kinds: 0 rail, 1 subway, 2 light_rail, 3 tram
MODE_KINDS = {
    "subway": {1, 2},
    "lrt": {2, 3, 1},
    "streetcar": {3, 2},
    "commuter_rail": {0},
    "airport_rail": {0},
    "intercity_rail": {0},
}
# typical consist length per mode (m), matching app/src/models/consists.ts
CONSIST_LEN = {"subway": 138.6, "lrt": 62.6, "streetcar": 30.0, "commuter_rail": 334.6, "airport_rail": 78.3, "intercity_rail": 152.8}
PLATFORM_MODES = {"subway", "lrt", "commuter_rail", "airport_rail", "intercity_rail"}
CAND_R = {"subway": 45.0, "lrt": 40.0, "streetcar": 25.0, "commuter_rail": 90.0, "airport_rail": 90.0, "intercity_rail": 90.0}
SIGMA = {"subway": 12.0, "lrt": 10.0, "streetcar": 7.0, "commuter_rail": 20.0, "airport_rail": 20.0, "intercity_rail": 25.0}
CORRIDOR = 160.0  # m: edges farther than this from the shape segment are not considered
SVC_W = {0: 1.0, 1: 1.25, 2: 3.0, 3: 1.0}
WRONG_WAY = 25.0  # cost per m of running against the shape
LEFT_HAND = 2.5  # cost per m of left-hand running on main-line double track (trains keep right: a wrong-track run shares one track with both directions, which the sim serializes)
DIVERGE = 15.0  # cost per diverging move (turn > 6 deg at a node)
STOP_MARGIN = {"subway": 4.0, "lrt": 3.0, "streetcar": 0.0, "commuter_rail": 8.0, "airport_rail": 6.0, "intercity_rail": 8.0}
SAMPLE = 5.0
# m of GTFS shape kept beyond each stop of a stop-to-stop piece (platform ends can be far from the stop point)
SUB_MARGIN = {"subway": 150.0, "lrt": 100.0, "streetcar": 40.0, "commuter_rail": 450.0, "airport_rail": 300.0, "intercity_rail": 450.0}


def consist_len(mode: str, route_short: str = "") -> float:
    if mode == "subway" and route_short.strip() == "4":
        return 92.6
    if mode == "lrt" and route_short.strip() == "6":
        return 47.6
    if mode == "lrt" and route_short.strip().upper() in ("301", "ION"):
        return 30.8  # GRT ION: single Flexity Freedom
    if mode == "commuter_rail" and route_short.strip().upper() in ("RH", "ST"):
        return 282.3
    return CONSIST_LEN[mode]


class Route:
    """Result of routing one pattern."""

    def __init__(self) -> None:
        self.edges: list[tuple[int, int]] = []  # (edge, dir) dir +1 forward, -1 backward
        self.start = 0.0  # offset into the first edge (along travel) where the route begins
        self.length = 0.0
        self.fronts: list[float] = []  # route distance of the consist front at each stop
        self.platform: list[bool] = []
        self.ok = True
        self.breaks = 0
        self.xyz: np.ndarray | None = None
        self.maxdev = 0.0
        self.break_at: list = []


class Router:
    def __init__(self, g: RailGraph) -> None:
        self.g = g
        nE = len(g.e_from)
        xs, es, ss, ts = [], [], [], []
        self.cum = []
        for e in range(nE):
            P = g.geom[e][0]
            xy = P[:, :2]
            cum = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(xy, axis=0).T))])
            self.cum.append(cum)
            L = cum[-1]
            n = max(1, int(math.ceil(L / SAMPLE)))
            s = (np.arange(n) + 0.5) * (L / n)
            x = np.interp(s, cum, xy[:, 0])
            y = np.interp(s, cum, xy[:, 1])
            i = np.clip(np.searchsorted(cum, s, side="right") - 1, 0, len(xy) - 2)
            d = xy[i + 1] - xy[i]
            d = d / np.maximum(np.hypot(*d.T), 1e-9)[:, None]
            xs.append(np.column_stack([x, y]))
            es.append(np.full(n, e))
            ss.append(s)
            ts.append(d)
        self.S_xy = np.vstack(xs)
        self.S_e = np.concatenate(es)
        self.S_s = np.concatenate(ss)
        self.S_t = np.vstack(ts)
        self.S_off = np.concatenate([[0], np.cumsum([len(a) for a in es])])
        self.tree = cKDTree(self.S_xy)
        # movement table with turn angles
        self.succ: dict[tuple[int, int], list[tuple[int, int, bool]]] = {}
        for (e, k), outs in g.moves.items():
            arr = -g.tan[e, k]
            lst = []
            for e2, k2 in outs:
                c = float(arr @ g.tan[e2, k2])
                lst.append((e2, k2, c < math.cos(math.radians(6.0))))
            self.succ[(e, k)] = lst

    # ------------------------------------------------------------------ geometry helpers
    def point(self, e: int, s: float) -> np.ndarray:
        P = self.g.geom[e][0]
        cum = self.cum[e]
        return np.array([np.interp(s, cum, P[:, 0]), np.interp(s, cum, P[:, 1]), np.interp(s, cum, P[:, 2])])

    def allowed(self, e: int, d: int, kinds: set) -> bool:
        g = self.g
        if int(g.e_kind[e]) not in kinds or (g.e_kind[e] == 0 and g.e_svc[e] == 2):
            return False
        return bool(g.e_dir[e] & (1 if d > 0 else 2))

    # ------------------------------------------------------------------ routing
    def route(self, shape: np.ndarray, stop_d: np.ndarray, virtual: list[bool], mode: str, L: float) -> Route:
        """shape: (n,2) GTFS shape (world m); stop_d: stop distances along it; virtual: bbox-edge flags."""
        g = self.g
        kinds = MODE_KINDS[mode]
        sig = SIGMA[mode]
        cum = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(shape, axis=0).T))])
        dense, dd = _densify(shape, cum, 4.0)
        tan = _tangents(dense)
        nst = len(stop_d)
        self._stop_d = np.asarray(stop_d, float)
        # ------------------------------------------------ candidates per stop
        cands: list[list[tuple]] = []  # (edge, dir, s_front, s_proj, emission, has_platform)
        for k in range(nst):
            q, t = _at(dense, dd, tan, stop_d[k])
            cs = self._candidates(q, t, kinds, mode, L, virtual[k], CAND_R[mode])
            if not cs:
                cs = self._candidates(q, t, kinds, mode, L, virtual[k], CAND_R[mode] * 3)
            cands.append(cs)
        r = Route()
        valid = [k for k in range(nst) if cands[k]]
        if len(valid) < 2:
            r.ok = False
            return r
        # ------------------------------------------------ Viterbi over stops
        cost = np.array([c[4] for c in cands[valid[0]]])
        back = []
        paths = []
        for vi in range(1, len(valid)):
            ka, kb = valid[vi - 1], valid[vi]
            d0, d1 = stop_d[ka], stop_d[kb]
            mg = SUB_MARGIN[mode]
            m = (dd >= d0 - mg) & (dd <= d1 + mg)
            sub, subt = dense[m], tan[m]
            if len(sub) < 2:
                sub, subt = dense, tan
            ctx = _Corridor(self, sub, subt, kinds, sig, mode)
            A, B = cands[ka], cands[kb]
            tc = np.full((len(A), len(B)), np.inf)
            tp: dict = {}
            for i, a in enumerate(A):
                if not np.isfinite(cost[i]):
                    continue
                res = self._search(a, B, ctx, max(3.0 * (d1 - d0) + 500.0, 1500.0))
                for j, (c, p) in res.items():
                    tc[i, j] = c
                    tp[(i, j)] = p
            if not np.isfinite(tc).any():
                # no pruning: edges far from the shape are allowed at a (high) clipped cost
                ctx = _Corridor(self, sub, subt, kinds, sig * 2.0, mode, prune=False)
                for i, a in enumerate(A):
                    res = self._search(a, B, ctx, np.inf)
                    for j, (c, p) in res.items():
                        tc[i, j] = c
                        tp[(i, j)] = p
            tot = cost[:, None] + tc
            if not np.isfinite(tot).any():
                # break: restart the chain at kb
                r.breaks += 1
                r.break_at.append((ka, kb, _at(dense, dd, tan, d0)[0], _at(dense, dd, tan, d1)[0], [(c[0], c[1]) for c in A], [(c[0], c[1]) for c in B]))
                back.append(None)
                paths.append(None)
                cost = np.array([c[4] for c in B])
                continue
            bi = np.argmin(tot, axis=0)
            cost = tot[bi, np.arange(len(B))] + np.array([c[4] for c in B])
            back.append(bi)
            paths.append(tp)
        # backtrack
        j = int(np.argmin(cost))
        sel = [j]
        seg_paths = []
        for vi in range(len(valid) - 1, 0, -1):
            bi = back[vi - 1]
            if bi is None:
                seg_paths.append(None)
                # previous chain: pick its best end independently (unknown cost -> first cand)
                sel.append(0)
                continue
            i = int(bi[sel[-1]])
            seg_paths.append(paths[vi - 1].get((i, sel[-1])))
            sel.append(i)
        sel.reverse()
        seg_paths.reverse()
        chosen = [cands[valid[q]][sel[q]] for q in range(len(valid))]
        if r.breaks:
            r.ok = False
        self._assemble(r, chosen, seg_paths, valid, nst, virtual, L, dense, dd, tan)
        return r

    def _candidates(self, q, t, kinds, mode, L, virtual, R):
        g = self.g
        idx = self.tree.query_ball_point(q[:2], R)
        best: dict[tuple[int, int], tuple] = {}
        for j in idx:
            e = int(self.S_e[j])
            if int(g.e_kind[e]) not in kinds:
                continue
            c = float(self.S_t[j] @ t)
            if abs(c) < 0.8:
                continue
            d = 1 if c > 0 else -1
            if not self.allowed(e, d, kinds):
                continue
            # project q onto the edge near this sample
            s, dist = self._project(e, q[:2], float(self.S_s[j]))
            key = (e, d)
            if key not in best or dist < best[key][1]:
                best[key] = (s, dist)
        out = []
        dmin = min((v[1] for v in best.values()), default=0.0)
        for (e, d), (s, dist) in best.items():
            Le = float(g.e_len[e])
            has_p = False
            if virtual:
                front = s
            else:
                front = None
                if mode in PLATFORM_MODES:
                    pl = [p for p in g.plat[e] if p[0] - 150.0 <= s <= p[1] + 150.0]
                    if pl:
                        s0, s1, _ = min(pl, key=lambda p: max(p[0] - s, s - p[1], 0.0))
                        has_p = True
                        mg = STOP_MARGIN[mode]
                        if s1 - s0 >= L + 2 * mg:
                            front = (s1 - mg) if d > 0 else (s0 + mg)
                        else:
                            mid = 0.5 * (s0 + s1)
                            front = mid + d * L * 0.5
                if front is None:
                    front = s + d * (2.0 if mode == "streetcar" else L * 0.5)
                front = min(max(front, 0.0), Le)
            emis = ((dist - dmin) / 12.0) ** 2 + 0.3 * (dist / 30.0) ** 2
            if mode in PLATFORM_MODES and not has_p and not virtual:
                emis += 3.0
            if g.e_svc[e] == 2:
                emis += 5.0
            out.append((e, d, front, s, emis, has_p))
        return out

    def _project(self, e, p, s_hint):
        P = self.g.geom[e][0][:, :2]
        cum = self.cum[e]
        A = P[:-1]
        AB = P[1:] - A
        L2 = np.maximum((AB**2).sum(1), 1e-12)
        t = np.clip(((p - A) * AB).sum(1) / L2, 0, 1)
        Q = A + AB * t[:, None]
        d = np.hypot(*(Q - p).T)
        # only the part of the edge near the sample that found it (U-shaped loop edges)
        far = (cum[1:] < s_hint - 3 * SAMPLE) | (cum[:-1] > s_hint + 3 * SAMPLE)
        i = int(np.argmin(np.where(far, np.inf, d)))
        return float(cum[i] + t[i] * math.sqrt(L2[i])), float(d[i])

    def _search(self, a, B, ctx, limit):
        """Dijkstra from candidate a to the candidates B. Returns {j: (cost, path)} where
        path = list of (edge, dir) from a's edge to b's edge inclusive."""
        g = self.g
        ea, da, fa = a[0], a[1], a[2]
        targets: dict[tuple[int, int], list[int]] = {}
        for j, b in enumerate(B):
            targets.setdefault((b[0], b[1]), []).append(j)
        out: dict[int, tuple[float, list]] = {}
        # same edge, ahead
        for j in targets.get((ea, da), []):
            fb = B[j][2]
            if (fb - fa) * da >= -0.5:
                out[j] = (ctx.partial(ea, da, fa, fb), [(ea, da)])
        # leave edge a at its travel end
        La = float(g.e_len[ea])
        c0 = ctx.partial(ea, da, fa, La if da > 0 else 0.0)
        if not np.isfinite(c0):
            return out
        end_k = 1 if da > 0 else 0
        best = {(ea, da): 0.0}
        prev: dict = {}
        heap = [(c0, ea, da)]
        dist0 = {(ea, da): c0}
        found_best = min((v[0] for v in out.values()), default=np.inf)
        while heap:
            c, e, d = heapq.heappop(heap)
            if c > dist0.get((e, d), np.inf) + 1e-9:
                continue
            if c > found_best or c > limit * 3:
                break
            k_out = 1 if d > 0 else 0
            for e2, k2, div in self.succ[(e, k_out)]:
                d2 = 1 if k2 == 0 else -1
                if not self.allowed(e2, d2, ctx.kinds):
                    continue
                cc = c + (DIVERGE if div else 0.0)
                # targets on e2
                for j in targets.get((e2, d2), []):
                    fb = B[j][2]
                    cj = cc + ctx.partial(e2, d2, 0.0 if d2 > 0 else float(g.e_len[e2]), fb)
                    if cj < out.get(j, (np.inf,))[0]:
                        path = [(e2, d2)]
                        x = (e, d)
                        while x != (ea, da):
                            path.append(x)
                            x = prev[x]
                        path.append((ea, da))
                        path.reverse()
                        out[j] = (cj, path)
                        found_best = min(found_best, cj)
                ce = ctx.full(e2, d2)
                if not np.isfinite(ce):
                    continue
                c2 = cc + ce
                if c2 < dist0.get((e2, d2), np.inf):
                    dist0[(e2, d2)] = c2
                    prev[(e2, d2)] = (e, d)
                    heapq.heappush(heap, (c2, e2, d2))
        del best, end_k
        return out

    def _assemble(self, r: Route, chosen, seg_paths, valid, nst, virtual, L, dense, dd, tan):
        g = self.g
        # edge sequence with fronts
        edges: list[tuple[int, int]] = [(chosen[0][0], chosen[0][1])]
        fronts_local = [(0, chosen[0][2])]  # (index into edges, s on that edge)
        brk_after = []
        for q in range(1, len(chosen)):
            p = seg_paths[q - 1]
            c = chosen[q]
            if p is None:
                brk_after.append(len(edges) - 1)
                edges.append((c[0], c[1]))
            else:
                edges.extend(p[1:])
            fronts_local.append((len(edges) - 1, c[2]))
        # extend backwards from the first stop by L + 20 m (unless it is a virtual stop)
        e0, d0 = edges[0]
        s0 = chosen[0][2]
        need = 0.0 if virtual[valid[0]] else L + 20.0
        pre: list[tuple[int, int]] = []
        avail = s0 if d0 > 0 else float(g.e_len[e0]) - s0
        cur = (e0, d0)
        while avail < need:
            e, d = cur
            k_in = 0 if d > 0 else 1  # entering end
            opts = []
            for e2, k2, div in self.succ[(e, k_in)]:
                # travelling backwards from e into e2 through end k2 means the train
                # arrives on e2 through end k2 in the forward sense
                d2 = 1 if k2 == 1 else -1
                if not self.allowed(e2, d2, MODE_KINDS_ALL):
                    continue
                opts.append((div, g.e_svc[e2] != 0, -float(g.e_len[e2]), e2, d2))
            if not opts or len(pre) > 50:
                break
            opts.sort()
            _, _, _, e2, d2 = opts[0]
            if (e2, d2) in pre or (e2, d2) == (e0, d0):
                break
            pre.append((e2, d2))
            avail += float(g.e_len[e2])
            cur = (e2, d2)
        pre.reverse()
        # start offset on the first edge
        if pre:
            ef, df = pre[0]
            Lf = float(g.e_len[ef])
            extra = max(0.0, avail - need)
            start = extra if df > 0 else Lf - extra
            # offset measured along travel from the travel-start end
            r.start = extra
            del start
        else:
            r.start = (s0 - need) if d0 > 0 else (float(g.e_len[e0]) - s0 - need)
            r.start = max(0.0, r.start)
        all_edges = pre + edges
        off = len(pre)
        # route distance of each edge's travel-start
        base = []
        acc = 0.0
        for i, (e, d) in enumerate(all_edges):
            base.append(acc)
            Le = float(g.e_len[e])
            acc += (Le - r.start) if i == 0 else Le
        # fronts
        fr = []
        for (i, s) in fronts_local:
            e, d = all_edges[i + off]
            along = s if d > 0 else float(g.e_len[e]) - s
            if i + off == 0:
                along -= r.start
            fr.append(base[i + off] + along)
        # route ends at the last front
        r.length = fr[-1]
        r.fronts_valid = fr
        # map fronts to all stops (stops without candidates are interpolated)
        full = np.interp(self._stop_d, self._stop_d[valid], np.array(fr))
        r.fronts = [float(x) for x in np.maximum.accumulate(full)]
        plat = {valid[q]: bool(chosen[q][5]) for q in range(len(valid))}
        r.platform = [plat.get(k, False) for k in range(nst)]
        # trim edges beyond the end
        keep = [i for i in range(len(all_edges)) if base[i] < r.length - 1e-6 or i == 0]
        all_edges = [all_edges[i] for i in keep]
        r.edges = all_edges
        r.brk_after = [b + off for b in brk_after]
        r.xyz = self.geometry(r)

    def geometry(self, r: Route) -> np.ndarray:
        g = self.g
        out = []
        pos = 0.0
        for i, (e, d) in enumerate(r.edges):
            P = g.geom[e][0]
            cum = self.cum[e]
            Le = float(g.e_len[e])
            if d < 0:
                P = P[::-1]
                cum = Le - cum[::-1]
            a = r.start if i == 0 else 0.0
            b = min(Le, a + (r.length - pos))
            m = (cum > a + 1e-6) & (cum < b - 1e-6)
            pa = np.array([np.interp(a, cum, P[:, j]) for j in range(3)])
            pb = np.array([np.interp(b, cum, P[:, j]) for j in range(3)])
            seg = np.vstack([pa, P[m], pb])
            out.append(seg if not out else seg[1:] if np.hypot(*(seg[0, :2] - out[-1][-1, :2])) < 0.05 else seg)
            pos += b - a
            if pos >= r.length - 1e-6:
                break
        xyz = np.vstack(out)
        keep = np.ones(len(xyz), bool)
        keep[1:] = np.hypot(*np.diff(xyz[:, :2], axis=0).T) > 0.01
        return xyz[keep]


MODE_KINDS_ALL = {0, 1, 2, 3}


class _Corridor:
    """Edge traversal costs relative to one stop-to-stop piece of the GTFS shape."""

    def __init__(self, router: Router, sub: np.ndarray, subt: np.ndarray, kinds: set, sig: float, mode: str, corridor: float = CORRIDOR, prune: bool = True):
        self.prune = prune
        self.r = router
        self.g = router.g
        self.kinds = kinds
        self.sig = sig
        self.mode = mode
        self.sub = sub
        self.subt = subt
        self.tree = cKDTree(sub)
        self.corr = corridor
        self._cache: dict = {}

    def _samples(self, e: int, d: int):
        v = self._cache.get((e, d))
        if v is not None:
            return v
        r = self.r
        a, b = r.S_off[e], r.S_off[e + 1]
        pts = r.S_xy[a:b]
        dist, idx = self.tree.query(pts, distance_upper_bound=self.corr if self.prune else np.inf)
        ok = np.isfinite(dist)
        if not ok.all():
            v = None
        else:
            dist = np.minimum(dist, self.corr * 2.0)
            t = r.S_t[a:b] * d
            c = (t * self.subt[idx]).sum(1)
            u = 1.0 + (dist / self.sig) ** 2
            u = u + np.where(c < 0.0, WRONG_WAY, 0.0)
            g = self.g
            u = u * SVC_W[int(g.e_svc[e])]
            if g.e_kind[e] == 0 and g.twin_side[e] != 0 and g.twin_side[e] != d:
                u = u + LEFT_HAND
            s = r.S_s[a:b]
            Le = float(g.e_len[e])
            ds = np.full(len(s), Le / max(len(s), 1))
            v = (s, u, ds)
        self._cache[(e, d)] = v
        return v

    def full(self, e: int, d: int) -> float:
        v = self._samples(e, d)
        if v is None:
            return np.inf
        s, u, ds = v
        return float((u * ds).sum())

    def partial(self, e: int, d: int, s_from: float, s_to: float) -> float:
        """Cost of travelling edge e in direction d from edge position s_from to s_to."""
        v = self._samples(e, d)
        if v is None:
            # allow partial traversal if the part itself is inside the corridor
            r = self.r
            a, b = r.S_off[e], r.S_off[e + 1]
            lo, hi = min(s_from, s_to), max(s_from, s_to)
            m = (r.S_s[a:b] >= lo - SAMPLE) & (r.S_s[a:b] <= hi + SAMPLE)
            if not m.any():
                return abs(s_to - s_from)
            pts = r.S_xy[a:b][m]
            dist, idx = self.tree.query(pts)
            u = 1.0 + (np.minimum(dist, self.corr) / self.sig) ** 2
            return float(u.mean() * abs(s_to - s_from))
        s, u, ds = v
        lo, hi = min(s_from, s_to), max(s_from, s_to)
        if hi - lo < 1e-6:
            return 0.0
        m = (s >= lo) & (s <= hi)
        um = float(u[m].mean()) if m.any() else float(np.interp(0.5 * (lo + hi), s, u))
        return um * (hi - lo)


def _densify(xy: np.ndarray, cum: np.ndarray, step: float) -> tuple[np.ndarray, np.ndarray]:
    L = cum[-1]
    n = max(2, int(math.ceil(L / step)) + 1)
    d = np.linspace(0.0, L, n)
    return np.column_stack([np.interp(d, cum, xy[:, 0]), np.interp(d, cum, xy[:, 1])]), d


def _tangents(p: np.ndarray) -> np.ndarray:
    n = len(p)
    k = 3
    i0 = np.maximum(np.arange(n) - k, 0)
    i1 = np.minimum(np.arange(n) + k, n - 1)
    t = p[i1] - p[i0]
    return t / np.maximum(np.hypot(*t.T), 1e-9)[:, None]


def _at(p, d, t, s):
    i = int(np.clip(np.searchsorted(d, s), 0, len(d) - 1))
    return p[i], t[i]
