"""Map-matching of bus pattern shapes onto the drivable road graph (data/graph, built by
`graph.py`), so that timetable-driven buses (beyond the traffic sim's radius) also drive
in the right lane of real roads, in their direction of travel. See docs/TRANSIT.md.

A pattern becomes a directed path of road edges from its first to its last stop
(stop-to-stop shortest paths weighted by the distance to the GTFS shape between
those stops, one-way streets respected, no U-turns except at dead ends); the new
shape is that path offset into the curb lane. Where no legal path exists (a road
missing from the graph, e.g. a station bus loop or busway), the GTFS shape is
kept for that stretch and the gap is reported (`work/bus_road_gaps.json`) so the
road data can be fixed.
"""

from __future__ import annotations

import heapq
import json
import math
import time
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

from . import geo, tbn

LANE_W = 3.5
CACHE = geo.WORK / "bus_roadnet.npz"
GAPS = geo.WORK / "bus_road_gaps.json"
SIGMA = 10.0
CORRIDOR = 90.0
CAND_R = 35.0
TURN_PEN = 4.0
SAMPLE = 20.0


class RoadNet:
    def __init__(self) -> None:
        src = geo.OUT / "graph"
        # keyed on the road graph's files (count, sizes, newest mtime): a regenerated graph rebuilds it
        files = sorted(src.glob("*.bin.gz"))
        sig = np.array([len(files), sum(p.stat().st_size for p in files), int(max((p.stat().st_mtime for p in files), default=0))], np.int64)
        d = None
        if CACHE.exists():
            d = dict(np.load(CACHE))
            if "sig" not in d or not np.array_equal(d["sig"], sig):
                d = None
        if d is None:
            d = self._load(src)
            d["sig"] = sig
            np.savez(CACHE, **d)
        self.frm, self.to = d["frm"], d["to"]
        self.off, self.xy = d["off"], d["xy"]
        self.lf, self.lb = d["lf"], d["lb"]
        self.cls, self.flags = d["cls"], d["flags"]
        nE = len(self.frm)
        self.len = np.array([float(np.hypot(*np.diff(self.xy[self.off[e] : self.off[e + 1]], axis=0).T).sum()) for e in range(nE)])
        nN = int(max(self.frm.max(), self.to.max())) + 1
        # adjacency: node -> [(edge, dir)] leaving the node
        self.out: list[list[tuple[int, int]]] = [[] for _ in range(nN)]
        for e in range(nE):
            if self.lf[e] > 0:
                self.out[self.frm[e]].append((e, 1))
            if self.lb[e] > 0:
                self.out[self.to[e]].append((e, -1))
        # heading at edge ends
        self.h0 = np.zeros(nE)
        self.h1 = np.zeros(nE)
        for e in range(nE):
            P = self.xy[self.off[e] : self.off[e + 1]]
            a, b = P[0], P[min(1, len(P) - 1)]
            c, dd = P[max(len(P) - 2, 0)], P[-1]
            self.h0[e] = math.atan2(b[1] - a[1], b[0] - a[0])
            self.h1[e] = math.atan2(dd[1] - c[1], dd[0] - c[0])
        # samples
        pts, own, ss, tg = [], [], [], []
        for e in range(nE):
            P = self.xy[self.off[e] : self.off[e + 1]]
            cum = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(P, axis=0).T))])
            L = cum[-1]
            n = max(1, int(math.ceil(L / SAMPLE)))
            s = (np.arange(n) + 0.5) * (L / n)
            x = np.interp(s, cum, P[:, 0])
            y = np.interp(s, cum, P[:, 1])
            i = np.clip(np.searchsorted(cum, s, side="right") - 1, 0, len(P) - 2)
            t = P[i + 1] - P[i]
            t = t / np.maximum(np.hypot(*t.T), 1e-9)[:, None]
            pts.append(np.column_stack([x, y]))
            own.append(np.full(n, e))
            ss.append(s)
            tg.append(t)
        self.S_xy = np.vstack(pts)
        self.S_e = np.concatenate(own)
        self.S_s = np.concatenate(ss)
        self.S_t = np.vstack(tg)
        self.S_off = np.concatenate([[0], np.cumsum([len(o) for o in own])])
        self.tree = cKDTree(self.S_xy)

    @staticmethod
    def _load(src: Path) -> dict:
        t0 = time.time()
        ids: dict[int, int] = {}
        frm, to, off, xy, lf, lb, cls, fl, width = [], [], [0], [], [], [], [], [], []
        for p in sorted(src.glob("*.bin.gz")):
            tx, ty = map(int, p.name.split(".")[0].split("_"))
            a, _ = tbn.read(p)
            x0, y0 = tx * 1024.0, ty * 1024.0
            nid = a["n_id"].astype(np.int64)
            eo = a["e_off"]
            ex = a["e_xyz"].reshape(-1, 3)
            for e in range(len(a["e_from"])):
                ia, ib = int(nid[a["e_from"][e]]), int(nid[a["e_to"][e]])
                u = ids.setdefault(ia, len(ids))
                v = ids.setdefault(ib, len(ids))
                P = ex[eo[e] : eo[e + 1], :2].astype(np.float64) + (x0, y0)
                # thin the 12 m densification (keep bends)
                if len(P) > 3:
                    keep = np.ones(len(P), bool)
                    d1 = P[1:-1] - P[:-2]
                    d2 = P[2:] - P[1:-1]
                    cr = np.abs(d1[:, 0] * d2[:, 1] - d1[:, 1] * d2[:, 0]) / np.maximum(np.hypot(*d1.T) * np.hypot(*d2.T), 1e-9)
                    keep[1:-1] = cr > 0.004
                    P = P[keep]
                frm.append(u)
                to.append(v)
                xy.append(P)
                off.append(off[-1] + len(P))
                lf.append(int(a["e_lanes_fwd"][e]))
                lb.append(int(a["e_lanes_bwd"][e]))
                cls.append(int(a["e_class"][e]))
                fl.append(int(a["e_flags"][e]))
                width.append(float(a["e_width"][e]) if "e_width" in a else 0.0)
        print(f"road graph: {len(frm)} edges, {len(ids)} nodes ({time.time() - t0:.0f}s)")
        return dict(frm=np.array(frm, np.int32), to=np.array(to, np.int32), off=np.array(off, np.int64), xy=np.vstack(xy),
                    lf=np.array(lf, np.int8), lb=np.array(lb, np.int8), cls=np.array(cls, np.int8), flags=np.array(fl, np.uint8))

    # ------------------------------------------------------------------ geometry
    def geom(self, e: int, d: int) -> np.ndarray:
        P = self.xy[self.off[e] : self.off[e + 1]]
        return P if d > 0 else P[::-1]

    def curb(self, e: int, d: int) -> float:
        """lateral offset (right of travel) of the curb lane centre"""
        n = self.lf[e] if d > 0 else self.lb[e]
        if self.lb[e] == 0 or self.lf[e] == 0:
            return (n * 0.5 - 0.5) * LANE_W
        return (n - 0.5) * LANE_W


class _Ctx:
    def __init__(self, net: RoadNet, sub: np.ndarray, subt: np.ndarray, prune: bool) -> None:
        self.net = net
        self.tree = cKDTree(sub)
        self.subt = subt
        self.prune = prune
        self.cache: dict = {}

    def cost(self, e: int, d: int) -> float:
        k = (e, d)
        v = self.cache.get(k)
        if v is not None:
            return v
        net = self.net
        a, b = net.S_off[e], net.S_off[e + 1]
        dist, idx = self.tree.query(net.S_xy[a:b])
        if self.prune and dist.max() > CORRIDOR:
            v = math.inf
        else:
            c = (net.S_t[a:b] * d * self.subt[idx]).sum(1)
            u = 1.0 + (np.minimum(dist, 300.0) / SIGMA) ** 2 + np.where(c < 0, 30.0, 0.0)
            v = float(u.mean() * net.len[e])
            if net.flags[e] & 32:
                v *= 2.0  # parking aisles / driveways (F_LOT): only where the shape really uses one (bus loops)
        self.cache[k] = v
        return v


def _turn(h_in: float, h_out: float) -> float:
    d = (h_out - h_in + math.pi) % (2 * math.pi) - math.pi
    return abs(d)


class BusRouter:
    def __init__(self, net: RoadNet) -> None:
        self.net = net
        self.gaps: list[dict] = []

    def candidates(self, q, t):
        net = self.net
        out = {}
        for j in net.tree.query_ball_point(q, CAND_R):
            e = int(net.S_e[j])
            c = float(net.S_t[j] @ t)
            if abs(c) < 0.6:
                continue
            d = 1 if c > 0 else -1
            if (net.lf[e] if d > 0 else net.lb[e]) == 0:
                continue
            dist = float(np.hypot(*(net.S_xy[j] - q)))
            if (e, d) not in out or dist < out[(e, d)][0]:
                out[(e, d)] = (dist, float(net.S_s[j]))
        return [(e, d, s if d > 0 else net.len[e] - s, dist) for (e, d), (dist, s) in out.items()]  # s along travel

    def search(self, a, B, ctx: _Ctx, limit: float):
        """Dijkstra from candidate a (e, d, s, dist) to candidates B; {j: (cost, path)}"""
        net = self.net
        ea, da, sa, _ = a
        out = {}
        for j, b in enumerate(B):
            if (b[0], b[1]) == (ea, da) and b[2] >= sa - 1.0:
                out[j] = (ctx.cost(ea, da) * (b[2] - sa) / max(net.len[ea], 1e-3), [(ea, da)])
        tgt: dict = {}
        for j, b in enumerate(B):
            tgt.setdefault((b[0], b[1]), []).append(j)
        c0 = ctx.cost(ea, da) * (net.len[ea] - sa) / max(net.len[ea], 1e-3)
        if not math.isfinite(c0):
            c0 = net.len[ea] - sa
        dist = {(ea, da): c0}
        prev = {}
        heap = [(c0, ea, da)]
        best = min((v[0] for v in out.values()), default=math.inf)
        while heap:
            c, e, d = heapq.heappop(heap)
            if c > dist.get((e, d), math.inf) + 1e-9:
                continue
            if c > best or c > limit:
                break
            node = net.to[e] if d > 0 else net.frm[e]
            h_in = net.h1[e] if d > 0 else net.h0[e] + math.pi
            outs = net.out[node]
            for e2, d2 in outs:
                if e2 == e and len(outs) > 1:
                    continue  # no U-turn except at a dead end
                h_out = net.h0[e2] if d2 > 0 else net.h1[e2] + math.pi
                cc = c + (TURN_PEN if _turn(h_in, h_out) > 0.5 else 0.0)
                for j in tgt.get((e2, d2), []):
                    cj = cc + ctx.cost(e2, d2) * B[j][2] / max(net.len[e2], 1e-3)
                    if math.isfinite(cj) and cj < out.get(j, (math.inf,))[0]:
                        path = [(e2, d2)]
                        x = (e, d)
                        while x != (ea, da):
                            path.append(x)
                            x = prev[x]
                        path.append((ea, da))
                        path.reverse()
                        out[j] = (cj, path)
                        best = min(best, cj)
                ce = ctx.cost(e2, d2)
                if not math.isfinite(ce):
                    continue
                c2 = cc + ce
                if c2 < dist.get((e2, d2), math.inf):
                    dist[(e2, d2)] = c2
                    prev[(e2, d2)] = (e, d)
                    heapq.heappush(heap, (c2, e2, d2))
        return out

    def route(self, shape: np.ndarray, stop_d: np.ndarray, label: str = "") -> np.ndarray | None:
        """Road-following geometry (curb lane) for a pattern, or None if nothing matched."""
        net = self.net
        cum = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(shape, axis=0).T))])
        L = cum[-1]
        if L < 5:
            return None
        n = max(2, int(math.ceil(L / 4.0)) + 1)
        dd = np.linspace(0, L, n)
        dense = np.column_stack([np.interp(dd, cum, shape[:, 0]), np.interp(dd, cum, shape[:, 1])])
        k = 3
        tan = dense[np.minimum(np.arange(n) + k, n - 1)] - dense[np.maximum(np.arange(n) - k, 0)]
        tan = tan / np.maximum(np.hypot(*tan.T), 1e-9)[:, None]

        def at(s):
            i = int(np.clip(np.searchsorted(dd, s), 0, n - 1))
            return dense[i], tan[i]

        stops = np.maximum.accumulate(np.clip(stop_d, 0, L))
        cands = [self.candidates(*at(s)) for s in stops]
        # chain of stop-to-stop paths (greedy Viterbi-light: best total per candidate)
        valid = [i for i in range(len(stops)) if cands[i]]
        if len(valid) < 2:
            return None
        cost = {j: cands[valid[0]][j][3] ** 2 / 100.0 for j in range(len(cands[valid[0]]))}
        back = []
        for vi in range(1, len(valid)):
            ka, kb = valid[vi - 1], valid[vi]
            m = (dd >= stops[ka] - 40) & (dd <= stops[kb] + 40)
            sub, subt = (dense[m], tan[m]) if m.sum() >= 2 else (dense, tan)
            A, B = cands[ka], cands[kb]
            seg = stops[kb] - stops[ka]
            res = {}
            # last attempt: start from every candidate at the stop, not only those the previous
            # leg reached (on smoothed curves / divided roads the previous leg can end on the
            # other carriageway or a neighbouring edge; the bus leaves the stop in its travel
            # direction on whichever edge it is really on)
            base = min(cost.values()) if cost else 0.0
            for prune, lim, any_start in ((True, 4 * seg + 800, False), (False, 8 * seg + 2000, False),
                                          (False, 8 * seg + 2000, True)):
                ctx = _Ctx(net, sub, subt, prune)
                for i, a in enumerate(A):
                    if i not in cost and not any_start:
                        continue
                    ci = cost.get(i, base + A[i][3] ** 2 / 100.0 + 50.0)
                    for j, (c, p) in self.search(a, B, ctx, lim).items():
                        tot = ci + c + B[j][3] ** 2 / 100.0
                        if j not in res or tot < res[j][0]:
                            res[j] = (tot, i, p)
                if res:
                    break
            if not res:
                q0, _ = at(stops[ka])
                q1, _ = at(stops[kb])
                self.gaps.append(dict(pattern=label, a=[round(float(q0[0])), round(float(q0[1]))], b=[round(float(q1[0])), round(float(q1[1]))]))
                back.append(None)
                cost = {j: B[j][3] ** 2 / 100.0 for j in range(len(B))}
                continue
            back.append(res)
            cost = {j: v[0] for j, v in res.items()}
        # backtrack into a list of (path or None-gap) pieces per stop pair
        j = min(cost, key=cost.get)
        pieces = []
        for vi in range(len(valid) - 1, 0, -1):
            r = back[vi - 1]
            if r is None:
                pieces.append(None)
                j = 0
                continue
            if j not in r:
                j = min(r, key=lambda k: r[k][0])
            tot, i, p = r[j]
            pieces.append((p, cands[valid[vi - 1]][i][2], cands[valid[vi]][j][2]))
            j = i
        pieces.reverse()
        # geometry
        out = []
        for vi, pc in enumerate(pieces):
            if pc is None:
                # keep the GTFS shape across the gap
                ka, kb = valid[vi], valid[vi + 1]
                m = (dd >= stops[ka]) & (dd <= stops[kb])
                out.append(dense[m])
                continue
            p, sa, sb = pc
            for q, (e, d) in enumerate(p):
                P = net.geom(e, d)
                c = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(P, axis=0).T))])
                a = sa if q == 0 else 0.0
                b = sb if q == len(p) - 1 else c[-1]
                if b <= a + 0.05:
                    continue
                mm = (c > a) & (c < b)
                seg = np.vstack([[np.interp(a, c, P[:, 0]), np.interp(a, c, P[:, 1])], P[mm], [np.interp(b, c, P[:, 0]), np.interp(b, c, P[:, 1])]])
                # curb-lane offset
                t = np.gradient(seg, axis=0)
                t = t / np.maximum(np.hypot(*t.T), 1e-9)[:, None]
                off = net.curb(e, d)
                seg = seg + np.column_stack([t[:, 1], -t[:, 0]]) * off
                out.append(seg)
        if not out:
            return None
        g = np.vstack(out)
        keep = np.ones(len(g), bool)
        keep[1:] = np.hypot(*np.diff(g, axis=0).T) > 0.3
        return g[keep]

    def write_gaps(self, agencies: list[str] | None = None) -> None:
        """Merge this run's gaps into the report (entries of re-run agencies are replaced)."""
        old = []
        if GAPS.exists():
            try:
                old = json.loads(GAPS.read_text())
            except ValueError:
                old = []
        if agencies:
            old = [g for g in old if g.get("pattern", "").split(":")[0] not in agencies]
        GAPS.write_text(json.dumps(old + self.gaps, indent=0))
