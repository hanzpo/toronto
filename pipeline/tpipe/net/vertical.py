"""Vertical profiles: every segment follows the bare earth unless it must not. Bridges span between
their abutments, tunnels stay under cover, and every plan crossing without a shared node gets the
clearance the lower asset needs. Raising (or lowering) a point spreads along the network at the
asset's maximum grade, which is what makes approach embankments and ramps (the engine then cuts
and fills the terrain to the profile)."""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Callable

import numpy as np
from shapely import STRtree
from shapely.geometry import LineString, Point

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


def tunnel(e: Edge) -> bool:
    return _flag(e, "tunnel") and not e.under


def _level(e: Edge) -> float:
    if e.fam not in ("path", "platform") or e.under:
        return 0.0
    v = e.tags.get("level", "").split(";")[0].strip()
    try:
        lv = float(v)
    except ValueError:
        lv = 0.0
    if lv == 0.0 and (e.tags.get("location") == "underground" or (e.tags.get("tunnel") == "yes" and e.tags.get("indoor") == "yes")):
        lv = -1.0
    return max(-4.0, min(4.0, lv))


def _layer(e: Edge) -> int:
    try:
        return int(e.tags.get("layer", "0"))
    except ValueError:
        return 0


class Profile:
    def __init__(self, e: Edge, dtm: Dtm, street: tuple[float, float] | None = None) -> None:
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
        lvl = _level(e)
        if lvl:
            g = g + 4.5 * lvl
        if street is not None:
            g = np.interp(self.s, [0.0, L], list(street))
        self.ground = g
        self.z = g.copy()
        self.pin = np.zeros(n, dtype=bool)
        self.lb = np.full(n, -np.inf)
        self.ub = np.full(n, np.inf)
        self.L = L
        self.bridge = _flag(e, "bridge")
        self.tunnel = tunnel(e)

    def at(self, s: float) -> float:
        return float(np.interp(s, self.s, self.z))

    def idx(self, s: float) -> int:
        return int(np.argmin(np.abs(self.s - s)))


def corridors(net: Network, prof: dict[str, Profile], dtm: Dtm) -> int:
    import json

    from .. import geo

    data = json.loads((geo.PIPE / "curated" / "corridors.json").read_text())["corridors"]
    pinned = 0
    for c in data:
        pts = [(*geo.project(lo, la), z) for lo, la, z in c["profile"]]
        line = LineString([(x, y) for x, y, _ in pts])
        cum = np.concatenate([[0.0], np.cumsum([math.dist(pts[i][:2], pts[i + 1][:2]) for i in range(len(pts) - 1)])])
        zs = [z for _, _, z in pts]
        kind = c.get("kind", "road")
        names = set(c.get("names") or [])
        ways = set(c.get("ways") or [])
        snap = float(c.get("snap", 40))
        mode = c.get("mode", "above_ground")
        for e in net.edges:
            fam = net.assets.assets[e.asset]["family"]
            if kind == "rail" and fam not in ("rail", "subway"):
                continue
            if kind != "rail" and fam != "road":
                continue
            if ways and e.way not in ways:
                continue
            if not ways and kind != "rail" and e.tags.get("name") not in names:
                continue
            if kind != "rail" and int(net.assets.assets[e.asset]["rank"]) > int(c.get("max_class", 9)):  # type: ignore[arg-type]
                continue
            p = prof[e.id]
            for i in range(len(p.s)):
                from shapely.geometry import Point
                q = Point(p.x[i], p.y[i])
                if line.distance(q) > snap:
                    continue
                along = line.project(q)
                if along <= 0 or along >= line.length:
                    continue
                if mode == "lidar_ground":
                    z = float(p.ground[i]) + float(c.get("ballast", 0.3)) + 0.4
                else:
                    zz = [v for v in zs]
                    if any(v is None for v in zz):
                        continue
                    z = float(np.interp(along, cum, zz))  # type: ignore[arg-type]
                    if mode != "absolute":
                        z += float(p.ground[i])
                    if c.get("level") == "formation":
                        z += 0.95
                p.lb[i] = p.ub[i] = z
                p.pin[i] = True
                pinned += 1
    return pinned


COVER = 12.0
RISE = 3.0
SIDE = 15.0


def _chains(net: Network, idx: list[int]) -> list[list[tuple[int, bool]]]:
    """The tunnel edges of one way as runs of (edge index, reversed) from one open end to the
    other."""
    ends: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for i in idx:
        ends[net.edges[i].a].append((i, 0))
        ends[net.edges[i].b].append((i, 1))
    seen: set[int] = set()
    out = []
    for tip in [k for k, v in ends.items() if len(v) == 1]:
        chain: list[tuple[int, bool]] = []
        node = tip
        while True:
            nxt = [(i, end) for i, end in ends[node] if i not in seen]
            if not nxt:
                break
            i, end = nxt[0]
            seen.add(i)
            chain.append((i, end == 1))
            node = net.edges[i].a if end == 1 else net.edges[i].b
            if len(ends[node]) != 2:
                break
        if chain:
            out.append(chain)
    return out


def _run_line(net: Network, chain: list[tuple[int, bool]]) -> LineString:
    pts: list[tuple[float, float]] = []
    for i, rev in chain:
        p = net.edges[i].pts[::-1] if rev else net.edges[i].pts
        pts += p if not pts else p[1:]
    return LineString(pts)


def _street(net: Network, chain: list[tuple[int, bool]], ground: Callable[[float], float], out: dict[str, tuple[float, float]]) -> None:
    acc = 0.0
    for i, rev in chain:
        e = net.edges[i]
        L = LineString(e.pts).length
        za, zb = ground(acc), ground(acc + L)
        acc += L
        e.under = True
        out[e.id] = (zb, za) if rev else (za, zb)


def underpasses(net: Network, dtm: Dtm) -> dict[str, tuple[float, float]]:
    """A street mapped as a tunnel under a raised corridor (the USRC streets: tunnel=yes, layer=-1
    under the tracks) is an underpass: the street stays at grade and what passes over it goes on
    bridges. A tunnel way qualifies when the tracks or surface roads crossing it leave no gap
    longer than COVER between them (its ends may run up to 45 % of its length past the outermost
    crossing, under the rest of the deck) and stand at least RISE above the street's open ends,
    so a PATH walkway under a street or a dive-under below a rail at grade stays a tunnel. Tunnel
    footways running alongside an underpass street within SIDE (the teamways) are its sidewalks.
    The DTM under the cover is the deck or embankment, not ground: the street's ground runs
    straight between its open ends, and its sidewalks take the street's ground. Returns the
    ground at both ends of every underpass edge."""
    fam = lambda e: net.assets.assets[e.asset]["family"]
    lines = [LineString(e.pts) for e in net.edges]
    tree = STRtree(lines)
    ways: dict[tuple[str, int], list[int]] = defaultdict(list)
    for i, e in enumerate(net.edges):
        if fam(e) not in ("road", "path") or not _flag(e, "tunnel") or e.tags.get("indoor") == "yes" or e.tags.get("location") == "underground":
            continue
        if _layer(e) < -1 or _level(e) < -1:
            continue
        ways[(fam(e), e.way)].append(i)
    out: dict[str, tuple[float, float]] = {}
    streets: list[tuple[LineString, Callable[[float], float]]] = []
    for (kind, _), idx in ways.items():
        if kind != "road":
            continue
        for chain in _chains(net, idx):
            run = _run_line(net, chain)
            members = {i for i, _ in chain}
            p0, p1 = run.coords[0], run.coords[-1]
            g0, g1 = (float(v) for v in dtm.sample(np.array([p0[0], p1[0]]), np.array([p0[1], p1[1]])))
            ground = lambda s, g0=g0, g1=g1, L=run.length: g0 + (g1 - g0) * min(1.0, max(0.0, s / max(L, 1e-6)))
            hits: list[tuple[float, float]] = []
            for i, _ in chain:
                for j in tree.query(lines[i], predicate="crosses"):
                    f = net.edges[int(j)]
                    if int(j) in members or {net.edges[i].a, net.edges[i].b} & {f.a, f.b}:
                        continue
                    if fam(f) not in ("road", "rail", "tram", "subway") or _flag(f, "tunnel") or _level(f) < 0:
                        continue
                    x = lines[i].intersection(lines[int(j)])
                    for p in [x] if x.geom_type == "Point" else list(getattr(x, "geoms", [])):
                        if p.geom_type != "Point":
                            continue
                        up = lines[int(j)]
                        su = up.project(p)
                        near = [up.interpolate(min(up.length, max(0.0, su + d))) for d in (-12.0, -6.0, 0.0, 6.0, 12.0)]
                        hu = float(np.max(dtm.sample(np.array([q.x for q in near]), np.array([q.y for q in near]))))
                        s = run.project(p)
                        hits.append((s, hu - ground(s)))
            if not hits or float(np.median([h for _, h in hits])) < RISE:
                continue
            along = np.sort(np.array([s for s, _ in hits]))
            if along.size > 1 and float(np.max(np.diff(along))) > COVER:
                continue
            if max(along[0], run.length - along[-1]) > max(COVER, 0.45 * run.length):
                continue
            _street(net, chain, ground, out)
            streets.append((run, ground))
    if not streets:
        return out
    stree = STRtree([r for r, _ in streets])
    for (kind, _), idx in ways.items():
        if kind != "path":
            continue
        for chain in _chains(net, idx):
            run = _run_line(net, chain)
            samples = [run.interpolate(d) for d in np.arange(0.0, run.length + 1e-6, 2.0)]
            a, b = np.array(run.coords[0]), np.array(run.coords[-1])
            match = None
            for k in stree.query(run.buffer(SIDE)):
                st, sg = streets[int(k)]
                if any(st.distance(q) > SIDE for q in samples):
                    continue
                sa, sb = (np.array(st.interpolate(st.project(Point(*p))).coords[0]) for p in (a, b))
                if abs(float(np.dot(b - a, sb - sa))) >= 0.8 * float(np.hypot(*(b - a)) * np.hypot(*(sb - sa))) > 0:
                    match = (st, sg)
                    break
            if match is None:
                continue
            st, sg = match
            _street(net, chain, lambda s, st=st, sg=sg, run=run: sg(st.project(run.interpolate(s))), out)
    return out


def clearance(e: Edge, asset: dict[str, object]) -> float:
    v = e.tags.get("maxheight", "")
    try:
        mh = float(v)
    except ValueError:
        mh = 0.0
    return mh if 2.0 <= mh <= 8.0 else float(asset.get("clearance", 5.0))  # type: ignore[arg-type]


def solve(net: Network, dtm: Dtm) -> None:
    street = underpasses(net, dtm)
    prof = {e.id: Profile(e, dtm, street.get(e.id)) for e in net.edges}
    corridors(net, prof, dtm)
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
            if up.pin[iu]:
                il = lo.idx(sl)
                if not lo.pin[il] and not lo.bridge:
                    lo.ub[il] = min(lo.ub[il], up.at(su) - need)
                continue
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
            pins = [p.z[i] for p, i in ends if p.pin[i]]
            if pins:
                target = float(np.mean(pins))
            for p, i in ends:
                if not p.pin[i]:
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
            z = np.where(p.pin, p.lb, z)
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
                need = clearance(lo.e, la) + float(ua.get("deckDepth", 1.5))  # type: ignore[arg-type]
                out.append((up, su, lo, sl, need))
    return out


def order(a: Profile, sa: float, b: Profile, sb: float, net: Network) -> tuple[Profile, float, Profile, float]:
    def key(p: Profile) -> tuple[int, int, int, int]:
        fam = net.assets.assets[p.e.asset]["family"]
        rank = int(net.assets.assets[p.e.asset]["rank"])  # type: ignore[arg-type]
        return (1 if p.bridge else 0, _layer(p.e), -1 if p.tunnel else 0, -rank if fam == "road" else -2)
    return (a, sa, b, sb) if key(a) >= key(b) else (b, sb, a, sa)
