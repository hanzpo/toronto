"""Vertical profiles: every segment follows the bare earth unless it must not. Bridges span between
their abutments, tunnels stay under cover, and every plan crossing without a shared node gets the
clearance the lower asset needs. Raising (or lowering) a point spreads along the network at the
asset's maximum grade, which is what makes approach embankments and ramps (the engine then cuts
and fills the terrain to the profile)."""

from __future__ import annotations

import math
from collections import defaultdict

import numpy as np
from shapely import STRtree
from shapely.geometry import LineString

from .dtm import Dtm
from .model import Edge, Network

STEP = 12.0


def grade(e: Edge, net: Network) -> float:
    a = net.assets.assets[e.asset]
    fam = a["family"]
    if fam == "rail":
        return 0.015
    if fam == "subway":
        return 0.035
    if fam == "tram":
        return 0.06
    if fam in ("path", "platform"):
        return 0.08
    return 0.04 if a["rank"] == 0 else 0.065  # type: ignore[comparison-overlap]


def _flag(e: Edge, key: str) -> bool:
    v = e.tags.get(key, "no")
    return v not in ("no", "") and not (key == "tunnel" and v == "building_passage")


def _layer(e: Edge) -> int:
    try:
        return int(e.tags.get("layer", "0"))
    except ValueError:
        return 0


class Profile:
    def __init__(self, e: Edge, dtm: Dtm) -> None:
        self.e = e
        pts = np.array(e.pts)
        seg = np.hypot(*np.diff(pts, axis=0).T)
        cum = np.concatenate([[0.0], np.cumsum(seg)])
        L = float(cum[-1])
        n = max(2, int(math.ceil(L / STEP)) + 1)
        self.s = np.linspace(0.0, L, n)
        self.x = np.interp(self.s, cum, pts[:, 0])
        self.y = np.interp(self.s, cum, pts[:, 1])
        g = dtm.sample(self.x, self.y)
        if n >= 5:
            k = np.ones(3) / 3
            g = np.concatenate([[g[0]], np.convolve(g, k, mode="valid"), [g[-1]]])
        self.ground = g
        self.z = g.copy()
        self.lb = np.full(n, -np.inf)
        self.ub = np.full(n, np.inf)
        self.L = L
        self.bridge = _flag(e, "bridge")
        self.tunnel = _flag(e, "tunnel") and e.tags.get("tunnel") != "building_passage"

    def at(self, s: float) -> float:
        return float(np.interp(s, self.s, self.z))

    def idx(self, s: float) -> int:
        return int(np.argmin(np.abs(self.s - s)))


def solve(net: Network, dtm: Dtm) -> None:
    prof = {e.id: Profile(e, dtm) for e in net.edges}
    at_node: dict[str, list[tuple[Profile, int]]] = defaultdict(list)
    for p in prof.values():
        at_node[p.e.a].append((p, 0))
        at_node[p.e.b].append((p, len(p.s) - 1))
    for p in prof.values():
        if p.tunnel:
            depth = 9.0 if net.assets.assets[p.e.asset]["family"] == "subway" else 7.0
            p.ub[1:-1] = p.ground[1:-1] - depth
    xings = crossings(net, prof)
    g = {e.id: grade(e, net) for e in net.edges}
    for _ in range(8):
        for up, su, lo, sl, need in xings:
            zl = lo.at(sl)
            iu = up.idx(su)
            if up.tunnel and not lo.tunnel:
                il = lo.idx(sl)
                lo.lb[il] = max(lo.lb[il], up.at(su) + need)
                continue
            if lo.tunnel and not up.bridge:
                il = lo.idx(sl)
                lo.ub[il] = min(lo.ub[il], up.at(su) - need)
                continue
            up.lb[iu] = max(up.lb[iu], zl + need)
        for key, ends in at_node.items():
            zs = [p.z[i] for p, i in ends]
            if not zs:
                continue
            hi = max(zs)
            lo_ = min(zs)
            target = hi if hi - lo_ < 30 else float(np.median(zs))
            for p, i in ends:
                p.lb[i] = max(p.lb[i], target - 0.01)
        for p in prof.values():
            gr = g[p.e.id]
            z = np.maximum(p.ground, p.lb)
            z = np.minimum(z, p.ub)
            if p.bridge and len(z) > 2:
                inner = np.interp(p.s[1:-1], [p.s[0], p.s[-1]], [z[0], z[-1]])
                z[1:-1] = np.maximum(inner, p.lb[1:-1])
            ds = np.diff(p.s)
            for i in range(1, len(z)):
                z[i] = max(z[i], z[i - 1] - gr * ds[i - 1]) if p.lb[i - 1] > -np.inf or z[i - 1] > p.ground[i - 1] + 0.2 else z[i]
            for i in range(len(z) - 2, -1, -1):
                z[i] = max(z[i], z[i + 1] - gr * ds[i]) if p.lb[i + 1] > -np.inf or z[i + 1] > p.ground[i + 1] + 0.2 else z[i]
            for i in range(1, len(z)):
                if z[i - 1] < p.ground[i - 1] - 0.2:
                    z[i] = min(z[i], z[i - 1] + gr * ds[i - 1])
            for i in range(len(z) - 2, -1, -1):
                if z[i + 1] < p.ground[i + 1] - 0.2:
                    z[i] = min(z[i], z[i + 1] + gr * ds[i])
            p.z = z
    for e in net.edges:
        p = prof[e.id]
        e.z = [(float(p.s[i] / max(p.L, 1e-6)), round(float(p.z[i]), 2)) for i in range(1, len(p.s) - 1)]
    for key, ends in at_node.items():
        if key in net.nodes:
            net.nodes[key].z = round(float(np.mean([p.z[i] for p, i in ends])), 2)


def crossings(net: Network, prof: dict[str, Profile]) -> list[tuple[Profile, float, Profile, float, float]]:
    lines = [LineString(e.pts) for e in net.edges]
    tree = STRtree(lines)
    out = []
    for i, e in enumerate(net.edges):
        for j in tree.query(lines[i], predicate="crosses"):
            j = int(j)
            if j <= i:
                continue
            f = net.edges[j]
            if {e.a, e.b} & {f.a, f.b}:
                continue
            fe, ff = net.assets.assets[e.asset]["family"], net.assets.assets[f.asset]["family"]
            if "platform" in (fe, ff):
                continue
            x = lines[i].intersection(lines[j])
            pts = [x] if x.geom_type == "Point" else list(getattr(x, "geoms", []))
            for p in pts:
                if p.geom_type != "Point":
                    continue
                se, sf = lines[i].project(p), lines[j].project(p)
                pe, pf = prof[e.id], prof[f.id]
                up, su, lo, sl = order(pe, se, pf, sf, net)
                la, ua = net.assets.assets[lo.e.asset], net.assets.assets[up.e.asset]
                need = float(la.get("clearance", 5.0)) + float(ua.get("deckDepth", 1.5))  # type: ignore[arg-type]
                out.append((up, su, lo, sl, need))
    return out


def order(a: Profile, sa: float, b: Profile, sb: float, net: Network) -> tuple[Profile, float, Profile, float]:
    def key(p: Profile) -> tuple[int, int, int, int]:
        fam = net.assets.assets[p.e.asset]["family"]
        rank = int(net.assets.assets[p.e.asset]["rank"])  # type: ignore[arg-type]
        return (1 if p.bridge else 0, _layer(p.e), -1 if p.tunnel else 0, -rank if fam == "road" else -2)
    return (a, sa, b, sb) if key(a) >= key(b) else (b, sb, a, sa)
