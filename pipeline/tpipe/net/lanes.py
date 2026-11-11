"""The network model's vehicle lanes (baked by app/scripts/net-bake.mjs from the net tiles with the
engine) and matching of GTFS pattern shapes onto them, so timetable vehicles drive exactly the
lanes and tracks that are drawn and simulated.

A pattern becomes a path of lanes from its first to its last stop (stop-to-stop shortest paths
weighted by the distance to the GTFS shape between those stops, lane directions respected); the
shape is that path's lane centrelines with their solved z. Buses keep to the curb lane and change
lanes within a segment where a turn needs it. Where no path exists (lanes missing from the model),
the GTFS shape is kept for that stretch and the gap is reported.
"""

from __future__ import annotations

import heapq
import json
import math
import time
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

from .. import geo, tbn

LANES = geo.WORK / "net" / "lanes"
GAPS = geo.WORK / "transit_lane_gaps.json"

CAR, BUS, TRUCK, TRAM, RAIL, SUBWAY = 1, 2, 4, 8, 16, 32
VF_BRIDGE, VF_TUNNEL = 1, 2
MODE_CLS = {
    "bus": BUS, "streetcar": TRAM, "lrt": TRAM | SUBWAY | RAIL, "subway": SUBWAY,
    "commuter_rail": RAIL, "airport_rail": RAIL, "intercity_rail": RAIL,
}
SIGMA = {"bus": 10.0, "streetcar": 8.0}
SIGMA_RAIL = 12.0
CORRIDOR = 90.0
CAND_R = 35.0
TURN_PEN = 4.0
LANE_CHANGE = 12.0
CURB_PEN = 0.15
SAMPLE = 10.0
BLEND = 40.0
JOIN = 0.5


class Lanes:
    """Every baked lane of the region (or of the area baked), linked across blocks."""

    def __init__(self, src: Path = LANES) -> None:
        t0 = time.time()
        files = sorted(src.glob("*.bin.gz"))
        if not files:
            raise FileNotFoundError(f"no lanes in {src}: run app/scripts/net-bake.mjs --lanes")
        keys: list[str] = []
        nxt: list[list[str]] = []
        group: list[str] = []
        parts: dict[str, list[np.ndarray]] = {k: [] for k in ("xyz", "vf", "kind", "cls", "bidir", "rank", "rail", "speed")}
        lens = []
        for p in files:
            a, h = tbn.read(p)
            off = a["ln_off"].astype(np.int64)
            no = a["ln_next_off"].astype(np.int64)
            gs = h["groups"]
            for i in range(len(off) - 1):
                nxt.append(h["next"][no[i] : no[i + 1]])
                g = int(a["ln_group"][i])
                group.append(f"{p.stem}:{gs[g]}" if g != 0xFFFFFFFF else "")
            keys += h["keys"]
            lens.append(np.diff(off))
            parts["xyz"].append(a["ln_xyz"].reshape(-1, 3).astype(np.float64))
            parts["vf"].append(a["ln_vf"])
            for k, n in (("kind", "ln_kind"), ("cls", "ln_cls"), ("bidir", "ln_bidir"), ("rank", "ln_rank"), ("rail", "ln_rail"), ("speed", "ln_speed")):
                parts[k].append(a[n])
        self.xyz = np.vstack(parts["xyz"])
        self.vf = np.concatenate(parts["vf"])
        n = np.concatenate(lens)
        self.off = np.concatenate([[0], np.cumsum(n)]).astype(np.int64)
        for k in ("kind", "cls", "bidir", "rank", "rail", "speed"):
            setattr(self, k, np.concatenate(parts[k]))
        self.n = len(n)
        index = {k: i for i, k in enumerate(keys)}
        self.next = [[index[k] for k in ks if k in index] for ks in nxt]
        self.prev: list[list[int]] = [[] for _ in range(self.n)]
        for i, ks in enumerate(self.next):
            for j in ks:
                self.prev[j].append(i)
        gi: dict[str, list[int]] = {}
        for i, g in enumerate(group):
            if g:
                gi.setdefault(g, []).append(i)
        self.group = [gi[g] if g else [i] for i, g in enumerate(group)]
        seg = np.diff(self.xyz[:, :2], axis=0)
        sl = np.hypot(*seg.T)
        sl[self.off[1:-1] - 1] = 0.0
        cum = np.concatenate([[0.0], np.cumsum(sl)])
        self.cum = cum
        self.len = cum[self.off[1:] - 1] - cum[self.off[:-1]]
        print(f"lanes: {self.n} from {len(files)} blocks ({time.time() - t0:.0f}s)")

    def pts(self, i: int) -> np.ndarray:
        return self.xyz[self.off[i] : self.off[i + 1]]

    def flags(self, i: int) -> np.ndarray:
        return self.vf[self.off[i] : self.off[i + 1]]

    def geom(self, i: int, d: int) -> np.ndarray:
        P = self.pts(i)
        return P if d > 0 else P[::-1]

    def ends(self, i: int, d: int) -> tuple[np.ndarray, np.ndarray]:
        P = self.pts(i)
        return (P[0], P[-1]) if d > 0 else (P[-1], P[0])

    def succ(self, i: int, d: int) -> list[tuple[int, int]]:
        _, end = self.ends(i, d)
        out = []
        for j in set(self.next[i]) | set(self.prev[i]):
            P = self.pts(j)
            if np.hypot(*(P[0, :2] - end[:2])) < JOIN and (j in self.next[i] or self.bidir[i] or self.bidir[j]):
                out.append((j, 1))
            elif self.bidir[j] and np.hypot(*(P[-1, :2] - end[:2])) < JOIN:
                out.append((j, -1))
        return out


class Net:
    """The lanes one mode may use, sampled for candidate search."""

    def __init__(self, lanes: Lanes, mode: str) -> None:
        self.L = lanes
        self.mode = mode
        self.bus = mode == "bus"
        self.sigma = SIGMA.get(mode, SIGMA_RAIL)
        self.ok = (lanes.cls & MODE_CLS[mode]) != 0
        pts, own, ss, tg = [], [], [], []
        for e in np.nonzero(self.ok)[0]:
            P = lanes.pts(e)[:, :2]
            c = lanes.cum[lanes.off[e] : lanes.off[e + 1]] - lanes.cum[lanes.off[e]]
            Ln = c[-1]
            if Ln <= 0:
                continue
            k = max(1, int(math.ceil(Ln / SAMPLE)))
            s = (np.arange(k) + 0.5) * (Ln / k)
            i = np.clip(np.searchsorted(c, s, side="right") - 1, 0, len(P) - 2)
            t = P[i + 1] - P[i]
            t = t / np.maximum(np.hypot(*t.T), 1e-9)[:, None]
            pts.append(np.column_stack([np.interp(s, c, P[:, 0]), np.interp(s, c, P[:, 1])]))
            own.append(np.full(k, e))
            ss.append(s)
            tg.append(t)
        self.S_xy = np.vstack(pts) if pts else np.zeros((0, 2))
        self.S_e = np.concatenate(own) if own else np.zeros(0, int)
        self.S_s = np.concatenate(ss) if ss else np.zeros(0)
        self.S_t = np.vstack(tg) if tg else np.zeros((0, 2))
        order = np.argsort(self.S_e, kind="stable")
        self.S_xy, self.S_e, self.S_s, self.S_t = self.S_xy[order], self.S_e[order], self.S_s[order], self.S_t[order]
        self.first = {int(e): int(i) for i, e in reversed(list(enumerate(self.S_e)))}
        self.count = dict(zip(*np.unique(self.S_e, return_counts=True))) if len(self.S_e) else {}
        self.tree = cKDTree(self.S_xy) if len(self.S_xy) else None
        self._succ: dict[tuple[int, int], list[tuple[int, int, float]]] = {}

    def heading(self, e: int, d: int, at_end: bool) -> float:
        P = self.L.geom(e, d)
        a, b = (P[-2], P[-1]) if at_end else (P[0], P[1])
        return math.atan2(b[1] - a[1], b[0] - a[0])

    def succ(self, e: int, d: int) -> list[tuple[int, int, float]]:
        """(lane, dir, extra cost); a bus may leave any parallel lane of its segment (lane change)."""
        k = (e, d)
        v = self._succ.get(k)
        if v is not None:
            return v
        L = self.L
        out: dict[tuple[int, int], float] = {}
        src = [e] + ([g for g in L.group[e] if g != e] if self.bus and L.kind[e] == 0 else [])
        h_in = self.heading(e, d, True)
        for g in src:
            pen = 0.0 if g == e else LANE_CHANGE * abs(int(L.rank[g]) - int(L.rank[e]))
            for j, dj in L.succ(g, d):
                if not self.ok[j]:
                    continue
                h = self.heading(j, dj, False)
                turn = abs((h - h_in + math.pi) % (2 * math.pi) - math.pi)
                c = pen + (TURN_PEN if turn > 0.5 else 0.0)
                if c < out.get((j, dj), math.inf):
                    out[(j, dj)] = c
        v = [(j, dj, c) for (j, dj), c in out.items()]
        self._succ[k] = v
        return v


class _Ctx:
    def __init__(self, net: Net, sub: np.ndarray, subt: np.ndarray, prune: bool) -> None:
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
        a = net.first.get(e)
        if a is None:
            v = math.inf
        else:
            b = a + net.count[e]
            dist, idx = self.tree.query(net.S_xy[a:b])
            if self.prune and dist.max() > CORRIDOR:
                v = math.inf
            else:
                c = (net.S_t[a:b] * d * self.subt[idx]).sum(1)
                u = 1.0 + (np.minimum(dist, 300.0) / net.sigma) ** 2 + np.where(c < 0, 30.0, 0.0)
                v = float(u.mean() * net.L.len[e])
                if net.bus and net.L.kind[e] == 0 and net.L.rank[e] != 255:
                    v *= 1.0 + CURB_PEN * float(net.L.rank[e])
        self.cache[k] = v
        return v


class Matcher:
    """Pattern shapes onto lanes, per mode."""

    def __init__(self, lanes: Lanes) -> None:
        self.lanes = lanes
        self.nets: dict[str, Net] = {}
        self.gaps: list[dict] = []

    def net(self, mode: str) -> Net:
        n = self.nets.get(mode)
        if n is None:
            n = self.nets[mode] = Net(self.lanes, mode)
        return n

    def candidates(self, net: Net, q, t):
        out = {}
        if net.tree is None:
            return []
        for j in net.tree.query_ball_point(q, CAND_R):
            e = int(net.S_e[j])
            c = float(net.S_t[j] @ t)
            if c > 0.6:
                d = 1
            elif c < -0.6 and self.lanes.bidir[e]:
                d = -1
            else:
                continue
            dist = float(np.hypot(*(net.S_xy[j] - q)))
            if (e, d) not in out or dist < out[(e, d)][0]:
                out[(e, d)] = (dist, float(net.S_s[j]))
        L = self.lanes.len
        return [(e, d, s if d > 0 else L[e] - s, dist) for (e, d), (dist, s) in out.items()]

    def search(self, net: Net, a, B, ctx: _Ctx, limit: float):
        """Dijkstra from candidate a (e, d, s, dist) to candidates B: {j: (cost, path)}"""
        L = self.lanes.len
        ea, da, sa, _ = a
        out = {}
        for j, b in enumerate(B):
            if (b[0], b[1]) == (ea, da) and b[2] >= sa - 1.0:
                out[j] = (ctx.cost(ea, da) * (b[2] - sa) / max(L[ea], 1e-3), [(ea, da)])
        tgt: dict = {}
        for j, b in enumerate(B):
            tgt.setdefault((b[0], b[1]), []).append(j)
        c0 = ctx.cost(ea, da) * (L[ea] - sa) / max(L[ea], 1e-3)
        if not math.isfinite(c0):
            c0 = L[ea] - sa
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
            for e2, d2, pen in net.succ(e, d):
                if e2 == e:
                    continue
                cc = c + pen
                for j in tgt.get((e2, d2), []):
                    cj = cc + ctx.cost(e2, d2) * B[j][2] / max(L[e2], 1e-3)
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

    def piece(self, e: int, d: int, a: float, b: float) -> np.ndarray:
        P = self.lanes.geom(e, d)
        c = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(P[:, :2], axis=0).T))])
        a, b = max(0.0, a), min(c[-1], b)
        m = (c > a) & (c < b)
        at = lambda s: np.array([np.interp(s, c, P[:, k]) for k in range(3)])  # noqa: E731
        return np.vstack([at(a), P[m], at(b)])

    def route(self, mode: str, shape: np.ndarray, stop_d: np.ndarray, label: str = "") -> np.ndarray | None:
        """Lane-following geometry (E, N, z) for a pattern, or None if nothing matched."""
        net = self.net(mode)
        L = self.lanes.len
        cum = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(shape, axis=0).T))])
        total = cum[-1]
        if total < 5:
            return None
        n = max(2, int(math.ceil(total / 4.0)) + 1)
        dd = np.linspace(0, total, n)
        dense = np.column_stack([np.interp(dd, cum, shape[:, 0]), np.interp(dd, cum, shape[:, 1])])
        k = 3
        tan = dense[np.minimum(np.arange(n) + k, n - 1)] - dense[np.maximum(np.arange(n) - k, 0)]
        tan = tan / np.maximum(np.hypot(*tan.T), 1e-9)[:, None]

        def at(s):
            i = int(np.clip(np.searchsorted(dd, s), 0, n - 1))
            return dense[i], tan[i]

        stops = np.maximum.accumulate(np.clip(stop_d, 0, total))
        cands = [self.candidates(net, *at(s)) for s in stops]
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
            base = min(cost.values()) if cost else 0.0
            for prune, lim, any_start in ((True, 4 * seg + 800, False), (False, 8 * seg + 2000, False), (False, 8 * seg + 2000, True)):
                ctx = _Ctx(net, sub, subt, prune)
                for i, a in enumerate(A):
                    if i not in cost and not any_start:
                        continue
                    ci = cost.get(i, base + A[i][3] ** 2 / 100.0 + 50.0)
                    for j, (c, p) in self.search(net, a, B, ctx, lim).items():
                        tot = ci + c + B[j][3] ** 2 / 100.0
                        if j not in res or tot < res[j][0]:
                            res[j] = (tot, i, p)
                if res:
                    break
            if not res:
                q0, _ = at(stops[ka])
                q1, _ = at(stops[kb])
                self.gaps.append(dict(pattern=label, mode=mode, a=[round(float(q0[0])), round(float(q0[1]))], b=[round(float(q1[0])), round(float(q1[1]))]))
                back.append(None)
                cost = {j: B[j][3] ** 2 / 100.0 for j in range(len(B))}
                continue
            back.append(res)
            cost = {j: v[0] for j, v in res.items()}
        j = min(cost, key=cost.get)
        pieces = []
        for vi in range(len(valid) - 1, 0, -1):
            r = back[vi - 1]
            if r is None:
                pieces.append(None)
                j = 0
                continue
            if j not in r:
                j = min(r, key=lambda q: r[q][0])
            _, i, p = r[j]
            pieces.append((p, cands[valid[vi - 1]][i][2], cands[valid[vi]][j][2]))
            j = i
        pieces.reverse()
        out: list[np.ndarray] = []
        prev_end: tuple[int, int, float] | None = None
        for vi, pc in enumerate(pieces):
            if pc is None:
                ka, kb = valid[vi], valid[vi + 1]
                m = (dd >= stops[ka]) & (dd <= stops[kb])
                out.append(np.column_stack([dense[m], np.full(int(m.sum()), np.nan)]))
                prev_end = None
                continue
            p, sa, sb = pc
            for q, (e, d) in enumerate(p):
                a = sa if q == 0 else 0.0
                b = sb if q == len(p) - 1 else L[e]
                if q == 0 and prev_end is not None and prev_end[:2] == (e, d):
                    a = max(a, prev_end[2])
                if b <= a + 0.05:
                    continue
                seg = self.piece(e, d, a, b)
                if q + 1 < len(p) and p[q + 1] not in self.lanes.succ(e, d):
                    seg = self._change(seg, e, d, p[q + 1], a, b)
                out.append(seg)
            prev_end = (p[-1][0], p[-1][1], sb)
        if not out:
            return None
        g = np.vstack(out)
        keep = np.ones(len(g), bool)
        keep[1:] = np.hypot(*np.diff(g[:, :2], axis=0).T) > 0.3
        return g[keep]

    def _change(self, seg: np.ndarray, e: int, d: int, nxt: tuple[int, int], a: float, b: float) -> np.ndarray:
        """Blend the end of lane e into the parallel lane of its segment that the next lane continues from."""
        lanes = self.lanes
        g = next((g for g in lanes.group[e] if g != e and nxt in lanes.succ(g, d)), None)
        if g is None:
            return seg
        other = self.piece(g, d, a, b)
        c = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(seg[:, :2], axis=0).T))])
        co = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(other[:, :2], axis=0).T))])
        f = c / max(c[-1], 1e-9)
        o = np.column_stack([np.interp(f * co[-1], co, other[:, k]) for k in range(3)])
        span = min(BLEND, c[-1])
        w = np.clip((c - (c[-1] - span)) / max(span, 1e-9), 0, 1)
        w = w * w * (3 - 2 * w)
        return seg + (o - seg) * w[:, None]

    def write_gaps(self, agencies: list[str] | None = None) -> None:
        old = []
        if GAPS.exists():
            try:
                old = json.loads(GAPS.read_text())
            except ValueError:
                old = []
        if agencies:
            old = [g for g in old if g.get("pattern", "").split(":")[0] not in agencies]
        GAPS.write_text(json.dumps(old + self.gaps, indent=0))
