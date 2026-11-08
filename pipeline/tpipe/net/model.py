"""Map OSM onto the engine's primitives (docs/NETWORK.md layer 2): a clean topological network
of segments (asset, curve, profile) and nodes. Generated geometry, lanes and interactions are the
engine's job (app/src/net/core); this module only decides what is where.

Steps: classify ways -> split at shared nodes -> fold streetcar tracks into their streets ->
cluster junction nodes -> synthesize assets from tags -> solve elevations -> export per tile."""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass, field

import numpy as np
from scipy.spatial import cKDTree

from . import assets as A
from .osm import OsmNet, Way


@dataclass
class Edge:
    id: str
    way: int
    fam: str
    tags: dict[str, str]
    nodes: list[int]
    tracks: list[A.Track] = field(default_factory=list)
    asset: str = ""
    a: str = ""
    b: str = ""
    pts: list[tuple[float, float]] = field(default_factory=list)
    z: list[tuple[float, float]] = field(default_factory=list)
    off_a: float = 0.0
    off_b: float = 0.0
    dead: bool = False
    tile: tuple[int, int] = (0, 0)


@dataclass
class Node:
    id: str
    x: float
    y: float
    z: float = 0.0
    members: list[int] = field(default_factory=list)
    control: str = "auto"
    tram: list[tuple[str, str]] = field(default_factory=list)


@dataclass
class Network:
    edges: list[Edge]
    nodes: dict[str, Node]
    assets: A.AssetTable


def family(t: dict[str, str]) -> str | None:
    hw = t.get("highway")
    rw = t.get("railway")
    if rw in ("rail", "subway", "light_rail", "narrow_gauge"):
        if t.get("service") in ("crossover",) and False:
            return None
        return "rail"
    if rw == "tram":
        return "tram"
    if rw == "platform" or (t.get("public_transport") == "platform" and rw):
        return "platform"
    if hw in A.PATHS:
        if hw == "footway" and t.get("footway") in ("sidewalk", "crossing", "traffic_island"):
            return None
        if hw in ("cycleway", "path") and t.get("cycleway") == "crossing":
            return None
        if hw == "pedestrian" and t.get("area") == "yes":
            return None
        return "path"
    if hw in A.ROAD_RANK:
        if hw == "service" and t.get("service") in ("driveway", "parking_aisle", "drive-through", "emergency_access"):
            return None
        if t.get("access") in ("no",) and hw == "service":
            return None
        return "road"
    return None


def _len(pts: list[tuple[float, float]]) -> float:
    return sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


TILE = 1024.0


def tile_of(p: tuple[float, float]) -> tuple[int, int]:
    return (math.floor(p[0] / TILE), math.floor(p[1] / TILE))


def splits_family(t: dict[str, str]) -> bool:
    f = family(t)
    return f is not None and f != "platform"


class Builder:
    def __init__(self, osm: OsmNet, splits: np.ndarray | None = None) -> None:
        self.osm = osm
        self.splits = splits
        self.xy = osm.xy
        self.edges: list[Edge] = []
        self.table = A.AssetTable()
        self.uf: dict[int, int] = {}
        self.connectors: list[Edge] = []
        self.members: dict[int, list[int]] = {}
        self.deadends: set[int] = set()

    def run(self) -> Network:
        self.split()
        self.fold_trams()
        self.cluster()
        self.merge_chains()
        self.trim_paths()
        self.assign_assets()
        nodes = self.make_nodes()
        return Network([e for e in self.edges if not e.dead], nodes, self.table)

    def split(self) -> None:
        ways: list[tuple[Way, str]] = []
        for w in self.osm.ways:
            f = family(w.tags)
            if f is None:
                continue
            nodes = [n for n in w.nodes if n in self.xy]
            if len(nodes) < 2:
                continue
            if f == "road" and A.is_oneway(w.tags) == -1:
                nodes = nodes[::-1]
                w = Way(w.id, {**w.tags, "oneway": "yes"}, nodes)
            ways.append((Way(w.id, w.tags, nodes), f))
        if self.splits is not None:
            cand = np.fromiter({n for w, f in ways if f != "platform" for n in w.nodes}, dtype=np.int64)
            split = set(cand[np.isin(cand, self.splits)].tolist())
        else:
            ref: dict[int, int] = defaultdict(int)
            for w, f in ways:
                if f == "platform":
                    continue
                for n in set(w.nodes):
                    ref[n] += 1
                ref[w.nodes[0]] += 1
                ref[w.nodes[-1]] += 1
            split = {n for n, c in ref.items() if c >= 2}
        for w, f in ways:
            if f == "platform":
                if w.nodes[0] == w.nodes[-1]:
                    continue
                self.edges.append(Edge(f"p{w.id}", w.id, f, w.tags, w.nodes))
                continue
            cur = [w.nodes[0]]
            k = 0
            last = len(w.nodes) - 1
            for i in range(1, len(w.nodes)):
                n = w.nodes[i]
                cur.append(n)
                if i < last and n != w.nodes[-1] and (n in split or tile_of(self.xy[n]) != tile_of(self.xy[w.nodes[i - 1]])):
                    self.edges.append(Edge(f"w{w.id}_{k}", w.id, f, w.tags, cur))
                    k = i
                    cur = [n]
            if len(cur) >= 2:
                self.edges.append(Edge(f"w{w.id}_{k}", w.id, f, w.tags, cur))
        for e in self.edges:
            e.pts = [self.xy[n] for n in e.nodes]
            e.tile = tile_of(e.pts[0])
        self.edges = [e for e in self.edges if _len(e.pts) > 0.3 or e.fam != "path"]

    def road_index(self) -> tuple[cKDTree, list[tuple[Edge, int]]]:
        pts: list[tuple[float, float]] = []
        ref: list[tuple[Edge, int]] = []
        for e in self.edges:
            if e.fam != "road" or e.dead:
                continue
            for i in range(len(e.pts) - 1):
                a, b = e.pts[i], e.pts[i + 1]
                L = math.dist(a, b)
                n = max(1, int(L / 3))
                for k in range(n + 1):
                    t = k / n
                    pts.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
                    ref.append((e, i))
        return cKDTree(np.array(pts)), ref

    def fold_trams(self) -> None:
        if not any(e.fam == "tram" for e in self.edges):
            return
        tree, ref = self.road_index()
        hosts: dict[str, dict[int, list[tuple[float, int]]]] = defaultdict(lambda: defaultdict(list))
        loose: list[Edge] = []
        for e in self.edges:
            if e.fam != "tram":
                continue
            samples: list[tuple[float, float, float, float]] = []
            for i in range(len(e.pts) - 1):
                a, b = e.pts[i], e.pts[i + 1]
                L = math.dist(a, b)
                if L < 1e-6:
                    continue
                n = max(1, int(L / 4))
                for k in range(n):
                    t = (k + 0.5) / n
                    samples.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, (b[0] - a[0]) / L, (b[1] - a[1]) / L))
            if not samples:
                continue
            hit: list[tuple[Edge, float, int]] = []
            for x, y, tx, ty in samples:
                best = None
                for j in tree.query_ball_point((x, y), 12.0):
                    re, i = ref[j]
                    a, b = re.pts[i], re.pts[i + 1]
                    dx, dy = b[0] - a[0], b[1] - a[1]
                    L = math.hypot(dx, dy)
                    if L < 1e-6:
                        continue
                    ux, uy = dx / L, dy / L
                    cosang = tx * ux + ty * uy
                    if abs(cosang) < 0.94:
                        continue
                    t = max(0.0, min(1.0, ((x - a[0]) * ux + (y - a[1]) * uy) / L))
                    lat = ux * (y - a[1]) - uy * (x - a[0])
                    if t <= 0.0 or t >= 1.0:
                        continue
                    d = abs(lat)
                    if d > host_half(re):
                        continue
                    cand = (d, re, lat, 1 if cosang > 0 else -1)
                    if best is None or d < best[0]:
                        best = cand
                if best and best[0] < 9.0:
                    hit.append((best[1], best[2], best[3]))
            if len(hit) >= 0.75 * len(samples):
                for re, lat, sgn in hit:
                    hosts[re.id][0].append((lat, sgn))
                e.dead = True
            else:
                loose.append(e)
        byid = {e.id: e for e in self.edges}
        for rid, d in hosts.items():
            re = byid[rid]
            vals = d[0]
            lats = sorted(vals, key=lambda q: q[0])
            groups: list[list[tuple[float, int]]] = []
            for v in lats:
                if groups and abs(v[0] - groups[-1][-1][0]) < 1.5:
                    groups[-1].append(v)
                else:
                    groups.append([v])
            for g in groups:
                if len(g) < 2:
                    continue
                lat = sum(v[0] for v in g) / len(g)
                re.tracks.append(A.Track(lat=lat, dir=-1 if lat > 0.2 else 1))
        road_nodes: dict[int, int] = defaultdict(int)
        for e in self.edges:
            if e.fam == "road" and not e.dead:
                road_nodes[e.nodes[0]] += 1
                road_nodes[e.nodes[-1]] += 1
        jn = [n for n, c in road_nodes.items() if c >= 3]
        if jn:
            jt = cKDTree(np.array([self.xy[n] for n in jn]))
            for e in loose:
                L = _len(e.pts)
                if L > 70:
                    continue
                da, _ = jt.query(e.pts[0])
                db, _ = jt.query(e.pts[-1])
                if da < 30 and db < 30:
                    e.dead = True
                    self.connectors.append(e)

    def find(self, n: int) -> int:
        while self.uf.get(n, n) != n:
            self.uf[n] = self.uf.get(self.uf[n], self.uf[n])
            n = self.uf[n]
        return n

    def cluster(self) -> None:
        deg: dict[int, int] = defaultdict(int)
        rail_at: set[int] = set()
        adj: dict[int, list[Edge]] = defaultdict(list)
        for e in self.edges:
            if e.dead or e.fam == "platform":
                continue
            deg[e.nodes[0]] += 1
            deg[e.nodes[-1]] += 1
            if e.fam in ("rail", "tram"):
                rail_at.add(e.nodes[0])
                rail_at.add(e.nodes[-1])
            if e.fam == "road":
                adj[e.nodes[0]].append(e)
                adj[e.nodes[-1]].append(e)
        def junctionish(n: int) -> bool:
            return deg[n] >= 3 or n in rail_at
        pairs: set[tuple[int, int]] = set()
        def union(a: int, b: int) -> None:
            pairs.add((min(a, b), max(a, b)))
        for start in sorted(n for n in adj if junctionish(n)):
            for e0 in adj[start]:
                rank = A.ROAD_RANK.get(e0.tags.get("highway", ""), 5)
                lim = 28.0 if rank <= 4 else 10.0
                if start in rail_at:
                    lim = max(lim, 16.0)
                chain = [e0]
                cur = start
                length = 0.0
                e = e0
                while True:
                    length += _len(e.pts)
                    nxt = e.nodes[-1] if e.nodes[0] == cur else e.nodes[0]
                    if length > lim:
                        break
                    if junctionish(nxt):
                        if nxt != start:
                            for c in chain:
                                c.dead = True
                            union(start, nxt)
                        break
                    others = [o for o in adj[nxt] if o is not e]
                    if len(others) != 1:
                        break
                    e = others[0]
                    cur = nxt
                    chain.append(e)
        for a, b in sorted(pairs):
            ra, rb = self.find(a), self.find(b)
            if ra != rb and math.dist(self.xy[ra], self.xy[rb]) < 70:
                lo, hi = min(ra, rb), max(ra, rb)
                self.uf[hi] = lo
        for e in self.edges:
            if not e.dead and e.nodes[0] == e.nodes[-1] and e.fam == "road":
                e.dead = True
        members: dict[int, list[int]] = defaultdict(list)
        for n in list(self.uf.keys()) + list(self.uf.values()):
            members[self.find(n)].append(n)
        self.members = {r: sorted(set(m)) for r, m in members.items()}
        for e in self.edges:
            if not e.dead and self.find(e.nodes[0]) == self.find(e.nodes[-1]) and e.fam in ("road", "tram") and _len(e.pts) < 60:
                e.dead = True

    def merge_chains(self) -> None:
        at: dict[int, list[Edge]] = defaultdict(list)
        for e in self.edges:
            if e.dead or e.fam == "platform":
                continue
            at[self.find(e.nodes[0])].append(e)
            at[self.find(e.nodes[-1])].append(e)
        link: dict[str, list[tuple[int, Edge]]] = defaultdict(list)
        for n in sorted(at):
            live = at[n]
            if len(live) != 2 or len(self.members.get(n, [n])) > 1:
                continue
            e1, e2 = live
            if e1 is e2 or e1.fam != e2.fam or e1.tags != e2.tags or e1.tile != e2.tile:
                continue
            if A.is_oneway(e1.tags):
                ends1 = self.find(e1.nodes[-1]) == n
                ends2 = self.find(e2.nodes[-1]) == n
                if ends1 == ends2:
                    continue
            link[e1.id].append((n, e2))
            link[e2.id].append((n, e1))
        byid = {e.id: e for e in self.edges if e.id in link}
        seen: set[str] = set()
        for eid in sorted(link):
            if eid in seen:
                continue
            comp: dict[str, Edge] = {}
            stack = [byid[eid]]
            while stack:
                e = stack.pop()
                if e.id in comp:
                    continue
                comp[e.id] = e
                stack.extend(o for _, o in link[e.id])
            seen.update(comp)
            ends = sorted((e for e in comp.values() if len(link[e.id]) == 1), key=lambda e: e.id)
            if len(ends) != 2:
                continue
            one = A.is_oneway(ends[0].tags) != 0
            start = ends[0]
            if one:
                up = [e for e in ends if self.find(e.nodes[-1]) == link[e.id][0][0]]
                if len(up) != 1:
                    continue
                start = up[0]
            elif self.find(start.nodes[-1]) != link[start.id][0][0]:
                start.nodes.reverse()
                start.pts.reverse()
            chain = [start]
            prev = start
            n = link[start.id][0][0]
            while True:
                nxt = [o for m, o in link[prev.id] if m == n and o is not prev and o.id not in {c.id for c in chain}]
                if not nxt:
                    break
                e = nxt[0]
                if self.find(e.nodes[0]) != n:
                    e.nodes.reverse()
                    e.pts.reverse()
                chain.append(e)
                rest = [m for m, o in link[e.id] if m != n]
                if not rest:
                    break
                prev, n = e, rest[0]
            if len(chain) != len(comp):
                continue
            head = chain[0]
            head.nodes = head.nodes + [x for c in chain[1:] for x in c.nodes[1:]]
            head.pts = head.pts + [x for c in chain[1:] for x in c.pts[1:]]
            head.tracks = next((c.tracks for c in chain if c.tracks), [])
            head.id = min(comp)
            for c in chain[1:]:
                c.dead = True

    def trim_paths(self) -> None:
        deg: dict[int, int] = defaultdict(int)
        for e in self.edges:
            if not e.dead and e.fam == "road":
                deg[self.find(e.nodes[0])] += 1
                deg[self.find(e.nodes[-1])] += 1
        for e in self.edges:
            if e.dead or e.fam != "path":
                continue
            for end in (0, -1):
                r = self.find(e.nodes[end])
                if deg.get(r, 0) >= 3:
                    if _len(e.pts) < 18:
                        e.dead = True
                        break
                    pts = e.pts if end == -1 else e.pts[::-1]
                    acc = 0.0
                    cut = None
                    for i in range(len(pts) - 1, 0, -1):
                        acc += math.dist(pts[i], pts[i - 1])
                        if acc > 14:
                            cut = i - 1
                            break
                    if cut is None or cut < 1:
                        e.dead = True
                        break
                    keep = pts[: cut + 1]
                    if end == -1:
                        e.pts = keep
                        e.nodes = e.nodes[: cut + 1]
                    else:
                        e.pts = keep[::-1]
                        e.nodes = e.nodes[::-1][: cut + 1][::-1]
                    self.deadends.add(e.nodes[end])

    def assign_assets(self) -> None:
        import json
        from .. import geo
        rows = set(json.loads((geo.PIPE / "curated" / "tram_row.json").read_text())["streets"])
        for e in self.edges:
            if e.dead:
                continue
            if e.fam == "road":
                a = A.road(e.tags, A.RoadCtx(tracks=e.tracks, tram_row=e.tags.get("name") in rows))
            elif e.fam == "path":
                a = A.path(e.tags)
            elif e.fam in ("rail", "tram"):
                a = A.rail(e.tags)
            else:
                kind = "rail"
                w = A._num(e.tags.get("width")) or 6.0
                a = A.platform(kind, w)
            e.asset = self.table.add(a)

    def make_nodes(self) -> dict[str, Node]:
        nodes: dict[str, Node] = {}
        def nid(n: int) -> str:
            r = self.find(n)
            m = self.members.get(r)
            return f"c{r}" if m and len(m) > 1 else f"n{r}"
        for e in self.edges:
            if e.dead:
                continue
            for end in (0, -1):
                n = e.nodes[end]
                key = nid(n)
                if key not in nodes:
                    r = self.find(n)
                    mem = self.members.get(r, [r])
                    xs = [self.xy[m][0] for m in mem]
                    ys = [self.xy[m][1] for m in mem]
                    nd = Node(key, sum(xs) / len(xs), sum(ys) / len(ys), members=mem)
                    if any(self.osm.ntags.get(m, {}).get("highway") == "traffic_signals" or "traffic_signals" in self.osm.ntags.get(m, {}).get("crossing", "") for m in mem):
                        nd.control = "signal"
                    nodes[key] = nd
            e.a, e.b = nid(e.nodes[0]), nid(e.nodes[-1])
            if e.fam == "platform":
                e.a, e.b = f"pa{e.id}", f"pb{e.id}"
                nodes[e.a] = Node(e.a, *e.pts[0])
                nodes[e.b] = Node(e.b, *e.pts[-1])
                continue
            na, nb = nodes[e.a], nodes[e.b]
            pa, pb = e.pts[0], e.pts[-1]
            if math.dist(pa, (na.x, na.y)) > 0.3 and len(e.pts) >= 2:
                d = _dir(e.pts, 0)
                e.off_a = (pa[0] - na.x) * -d[1] + (pa[1] - na.y) * d[0]
            if math.dist(pb, (nb.x, nb.y)) > 0.3 and len(e.pts) >= 2:
                d = _dir(e.pts, -1)
                e.off_b = (pb[0] - nb.x) * -d[1] + (pb[1] - nb.y) * d[0]
        self.tram_moves(nodes)
        return nodes

    def tram_moves(self, nodes: dict[str, Node]) -> None:
        legs: dict[str, list[Edge]] = defaultdict(list)
        for e in self.edges:
            if e.dead or e.fam != "road":
                continue
            legs[e.a].append(e)
            legs[e.b].append(e)
        def leg_near(p: tuple[float, float]) -> tuple[str, Edge] | None:
            best = None
            for key, es in legs.items():
                nd = nodes[key]
                if math.dist(p, (nd.x, nd.y)) > 45:
                    continue
                for e in es:
                    if not e.tracks:
                        continue
                    end = e.pts[0] if e.a == key else e.pts[-1]
                    nxt = e.pts[1] if e.a == key else e.pts[-2]
                    d = _seg_dist(p, end, nxt)
                    if best is None or d < best[0]:
                        best = (d, key, e)
            return (best[1], best[2]) if best and best[0] < 15 else None
        for c in self.connectors:
            la, lb = leg_near(c.pts[0]), leg_near(c.pts[-1])
            if not la or not lb or la[0] != lb[0] or la[1] is lb[1]:
                continue
            nd = nodes[la[0]]
            mv = (la[1].id, lb[1].id)
            if mv not in nd.tram:
                nd.tram.append(mv)
        for key, es in legs.items():
            nd = nodes[key]
            if not nd.tram:
                continue
            tr = [e for e in es if e.tracks]
            for i, e1 in enumerate(tr):
                for e2 in tr[i + 1:]:
                    a1 = _leg_angle(e1, key)
                    a2 = _leg_angle(e2, key)
                    if abs(abs((a1 - a2 + math.pi) % (2 * math.pi) - math.pi) - math.pi) < 0.5:
                        for mv in ((e1.id, e2.id), (e2.id, e1.id)):
                            if mv not in nd.tram:
                                nd.tram.append(mv)


def host_half(e: Edge) -> float:
    t = e.tags
    one = A.is_oneway(t) != 0
    n = A._int(t.get("lanes")) or (1 if one else 2)
    return max(2.5, n * 3.4 / 2 + 0.6)


def _dir(pts: list[tuple[float, float]], end: int) -> tuple[float, float]:
    if end == 0:
        a, b = pts[0], pts[1]
    else:
        a, b = pts[-2], pts[-1]
    L = math.dist(a, b) or 1.0
    return ((b[0] - a[0]) / L, (b[1] - a[1]) / L)


def _seg_dist(p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2))
    return math.dist(p, (a[0] + dx * t, a[1] + dy * t))


def _leg_angle(e: Edge, key: str) -> float:
    if e.a == key:
        a, b = e.pts[0], e.pts[min(3, len(e.pts) - 1)]
    else:
        a, b = e.pts[-1], e.pts[max(-4, -len(e.pts))]
    return math.atan2(b[1] - a[1], b[0] - a[0])


def build(osm: OsmNet, splits: np.ndarray | None = None) -> Network:
    return Builder(osm, splits).run()
