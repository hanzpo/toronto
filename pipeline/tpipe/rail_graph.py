"""Switch-level rail track graph from OSM, with data repairs, draped geometry,
speed limits, per-track direction rules, movement rules at switches and
platform extents. See docs/RAIL.md.

    cd pipeline && uv run python -m tpipe.rail_graph        # build + report
    (normally built by `tpipe.transit`, which routes the rail patterns on it)

Graph
  node  = OSM node where tracks join/split/cross (switch, diamond), end of track
          (buffer stop / edge of the extract) or where the track class changes;
  edge  = the track between two nodes, with its (densified, draped) geometry.
  Movement rules: at a node a train may continue from one edge end into another
  only if the path turns by less than TURN_MAX (per class) there -- the trunk of
  a switch connects to both legs, the legs never connect to each other, a
  diamond connects opposite arms only.

Repairs of implausible OSM data (all logged):
  * distinct OSM nodes at the same spot (< MERGE_D, same layer) are merged
    (duplicated nodes break topology, e.g. at Union);
  * a dangling track end aligned with the end of another track within GAP_D is
    joined to it (mapping gaps);
  * a dangling track end that runs into another track within TEE_D laterally,
    at a switch-like angle, becomes a switch on that track (unconnected
    crossovers / sidings);
  * manual fixes in FIXES (by OSM id).

Directions (e_dir: 1 forward allowed, 2 backward allowed):
  * tram ways tagged railway:preferred_direction=forward|backward are one way
    (Toronto maps each streetcar track separately, drawn in travel direction);
  * subway / light rail / tram double track runs on the right: a track whose
    parallel twin (same class, 2.5-7.5 m away) lies consistently on one side is
    one way, travelling with the twin on its left;
  * everything else (main-line rail under CTC, single track, pocket tracks,
    crossovers, sidings, yards) is bidirectional -- signalling keeps it safe.
"""

from __future__ import annotations

import math
import pickle
import sys
import time
from collections import defaultdict

import numpy as np
from scipy.spatial import cKDTree

from . import geo, tbn, terrain
from .grade import profile as grade_profile
from .rail_geom import RAIL_RADIUS, fillet

KINDS = {"rail": 0, "subway": 1, "light_rail": 2, "tram": 3, "narrow_gauge": 0}
KIND_NAMES = ["rail", "subway", "light_rail", "tram"]
SERVICE = {None: 0, "siding": 1, "spur": 1, "yard": 2, "crossover": 3}
# edge flags
F_BRIDGE = 1
F_TUNNEL = 2
F_ELECTRIC = 4
F_REPAIR = 8  # contains a synthetic (repair) segment
# node flags
N_SWITCH = 1
N_DIAMOND = 2
N_END = 4
N_REPAIR = 8

MERGE_D = 0.6  # m
GAP_D = 25.0  # m: max gap bridged between two aligned dangling ends
GAP_ANG = math.radians(25)
TEE_D = 2.5  # m: max lateral distance from a dangling end to a track to make it a switch
TEE_REACH = 12.0  # m: how far past its end a dangling end may be extended onto a track
TEE_ANG = math.radians(35)
TURN_MAX = {0: 40.0, 1: 45.0, 2: 55.0, 3: 75.0}  # deg per class (tangent over TAN_D)
TAN_D = 8.0
DENSE = 10.0  # m: draping step
RDP_TOL = 0.2
COVER = {0: 10.0, 1: 14.0, 2: 10.0, 3: 8.0}
CLEARANCE = 6.0
RAMP = 150.0
# default speed limits (km/h) per class / service; lateral acceleration for curves (m/s2)
V_DEFAULT = {0: 130.0, 1: 80.0, 2: 70.0, 3: 40.0}
V_SERVICE = {1: 25.0, 2: 15.0, 3: 40.0}
V_SERVICE_TRANSIT = {1: 25.0, 2: 15.0, 3: 25.0}  # subway / LRT / tram sidings, yards, crossovers
A_LAT = {0: 1.1, 1: 1.0, 2: 0.9, 3: 0.9}
TWIN_MIN = 2.5
TWIN_MAX = {0: 7.5, 1: 16.0, 2: 16.0, 3: 7.5}  # m: subway / LRT twin-bore tunnels are far apart

LRT_SHARED_OPERATORS = {"Grand River Transit"}  # railway=rail track shared with an LRT (ION on the CN Waterloo Spur)
CACHE_OSM = geo.WORK / "rail_osm.pkl"
CACHE_GRAPH = geo.WORK / "rail_graph.pkl"
OUT = geo.OUT / "rail"

# Depots / yards / layover facilities where trains are stabled between blocks (approximate
# location; the yard tracks are the connected yard / siding component of the right track
# class nearest to it). Sources: Metrolinx / TTC facility lists, OSM.
DEPOTS = [
    # id, name, track group (0 main-line rail, 1 subway, 2 light rail, 3 tram), agencies, lat, lon
    ("willowbrook", "Willowbrook Yard (GO)", 0, ["go"], 43.6162, -79.4998),
    ("tmc", "Toronto Maintenance Centre (VIA)", 0, ["via"], 43.6200, -79.5080),
    ("don", "Don Yard (GO)", 0, ["go"], 43.6525, -79.3560),
    ("bathurst", "Bathurst North Yard (GO)", 0, ["go", "up"], 43.6415, -79.4030),
    ("whitby", "East Rail Maintenance Facility (GO, Whitby)", 0, ["go"], 43.8660, -78.9450),
    ("shirley", "Shirley Road layover (GO, Oshawa)", 0, ["go"], 43.8850, -78.8200),
    ("lincolnville", "Lincolnville layover (GO)", 0, ["go"], 43.9960, -79.2300),
    ("milton", "Milton layover (GO)", 0, ["go"], 43.5170, -79.8780),
    ("kitchener", "Kitchener layover (GO)", 0, ["go"], 43.4560, -80.4960),
    ("westharbour", "Hamilton / West Harbour layover (GO)", 0, ["go"], 43.2670, -79.8660),
    ("wilson", "Wilson Yard (TTC)", 1, ["ttc"], 43.7370, -79.4540),
    ("davisville", "Davisville Yard (TTC)", 1, ["ttc"], 43.6985, -79.3970),
    ("greenwood", "Greenwood Yard (TTC)", 1, ["ttc"], 43.6810, -79.3280),
    ("keele", "Keele Yard (TTC)", 1, ["ttc"], 43.6590, -79.4605),
    ("mountdennis", "Mount Dennis MSF (Line 5)", 2, ["ttc"], 43.6890, -79.4880),
    ("finchwest", "Finch West MSF (Line 6)", 2, ["ttc"], 43.7620, -79.5360),
    ("ionomsf", "ION Operations, Maintenance & Storage Facility (GRT)", 2, ["grt"], 43.4990, -80.5480),
    ("roncesvalles", "Roncesvalles Carhouse (TTC)", 3, ["ttc"], 43.6394, -79.4474),
    ("russell", "Russell Carhouse (TTC)", 3, ["ttc"], 43.6655, -79.3240),
    ("leslie", "Leslie Barns (TTC)", 3, ["ttc"], 43.6600, -79.3310),
]

# Manual fixes (OSM ids). "join": [(node_a, node_b)] adds a track segment between two
# nodes; "drop_ways": ways ignored; "oneway": {way: +1|-1} forces a direction.
FIXES: dict = {"join": [], "drop_ways": [], "oneway": {}}


def _fillet_radius(kind: int, svc: int) -> float:
    """rail_geom design radius for a track (render classes: 0 main, 1 siding/yard, 2 subway,
    3 light rail, 4 tram)"""
    if kind == 3:
        return RAIL_RADIUS[4]
    if kind == 2:
        return RAIL_RADIUS[3]
    if kind == 1:
        return RAIL_RADIUS[2]
    return RAIL_RADIUS[1] if svc else RAIL_RADIUS[0]


# ----------------------------------------------------------------------------- OSM
def extract() -> dict:
    """Rail ways, platforms and rail node tags from bbox.osm.pbf (cached)."""
    src = geo.RAW / "bbox.osm.pbf"
    if CACHE_OSM.exists() and CACHE_OSM.stat().st_mtime > src.stat().st_mtime:
        return pickle.loads(CACHE_OSM.read_bytes())
    import osmium

    ways, platforms = [], []
    need_nodes: set[int] = set()
    pos: dict[int, tuple[float, float]] = {}
    fp = osmium.FileProcessor(str(src), osmium.osm.NODE | osmium.osm.WAY).with_locations()
    node_tags: dict[int, dict] = {}
    for o in fp:
        if o.is_node():
            t = o.tags
            rw = t.get("railway")
            pt = t.get("public_transport")
            if rw in ("stop", "buffer_stop", "switch", "railway_crossing", "level_crossing", "crossing", "signal") or pt == "stop_position":
                node_tags[o.id] = {k: v for k, v in t}
            continue
        if not o.is_way():
            continue
        t = o.tags
        rw = t.get("railway")
        if rw in KINDS:
            pts = [(n.ref, n.lon, n.lat) for n in o.nodes if n.location.valid()]
            if len(pts) >= 2:
                ways.append((o.id, {k: v for k, v in t}, pts))
        elif rw in ("platform", "platform_edge") or (t.get("public_transport") == "platform" and (t.get("train") or t.get("subway") or t.get("tram") or t.get("light_rail") or rw)):
            pts = [(n.ref, n.lon, n.lat) for n in o.nodes if n.location.valid()]
            if len(pts) >= 2:
                platforms.append((o.id, {k: v for k, v in t}, pts))
    d = {"ways": ways, "platforms": platforms, "node_tags": node_tags}
    CACHE_OSM.parent.mkdir(parents=True, exist_ok=True)
    CACHE_OSM.write_bytes(pickle.dumps(d, protocol=5))
    return d


def _layer(t: dict) -> int:
    try:
        return int(float(t.get("layer", "0").split(";")[0]))
    except ValueError:
        return 0


def _speed(t: dict) -> float | None:
    v = t.get("maxspeed")
    if not v:
        return None
    v = v.split(";")[0].strip()
    try:
        if v.endswith("mph"):
            return float(v[:-3]) * 1.609344
        return float(v.split()[0])
    except ValueError:
        return None


# ----------------------------------------------------------------------------- graph
class RailGraph:
    """Switch-level track graph (see module doc). Attributes are numpy arrays / lists."""

    def __init__(self) -> None:
        self.log: list[str] = []

    # ---------------------------------------------------------------- build
    def build(self, osm: dict) -> None:
        t0 = time.time()
        drop = set(FIXES["drop_ways"])
        W = []  # way attrs
        for wid, t, pts in osm["ways"]:
            if wid in drop:
                continue
            if t.get("railway") == "narrow_gauge" and t.get("usage") == "tourism":
                continue
            kind = KINDS[t["railway"]]
            svc = SERVICE.get(t.get("service"), 1)
            lay = _layer(t)
            tun = t.get("tunnel", "no") not in ("no", "") or t.get("location") == "underground" or (lay < 0 and t.get("bridge", "no") == "no")
            bri = t.get("bridge", "no") not in ("no", "") or (lay > 0 and not tun)
            el = t.get("electrified", "no") not in ("no", "")
            pdir = 0
            pd = t.get("railway:preferred_direction")
            if pd == "forward" or t.get("oneway") == "yes":
                pdir = 1
            elif pd == "backward" or t.get("oneway") == "-1":
                pdir = -1
            pdir = FIXES["oneway"].get(wid, pdir)
            W.append(dict(id=wid, kind=kind, svc=svc, layer=lay, flags=(F_BRIDGE if bri else 0) | (F_TUNNEL if tun else 0) | (F_ELECTRIC if el else 0),
                          pdir=pdir, speed=_speed(t), usage=t.get("usage"), name=t.get("name", ""), pts=pts,
                          lrt=kind == 0 and el and t.get("operator") in LRT_SHARED_OPERATORS))
        self.ways = W
        # node positions
        ids, lon, lat = [], [], []
        for w in W:
            for r, x, y in w["pts"]:
                ids.append(r)
                lon.append(x)
                lat.append(y)
        ids = np.array(ids, dtype=np.int64)
        x, y = geo.project(np.array(lon), np.array(lat))
        uid, first = np.unique(ids, return_index=True)
        self.pos = {int(i): (float(x[k]), float(y[k])) for i, k in zip(uid, first)}
        # node layer (max |layer| of its ways, for merging)
        nlayer: dict[int, int] = {}
        for w in W:
            for r, _, _ in w["pts"]:
                nlayer[r] = w["layer"] if abs(w["layer"]) > abs(nlayer.get(r, 0)) else nlayer.get(r, 0)
        self.nlayer = nlayer
        # segments: (u, v, way index)
        segs = []
        for wi, w in enumerate(W):
            ns = [r for r, _, _ in w["pts"]]
            for a, b in zip(ns[:-1], ns[1:]):
                if a != b:
                    segs.append((a, b, wi))
        self.segs = segs
        self._repair()
        self._compact()
        self.log.append(f"graph: {len(self.W_used)} ways, {len(self.nxy)} nodes, {len(self.e_from)} edges ({time.time()-t0:.1f}s)")

    # ---------------------------------------------------------------- repairs
    def _repair(self) -> None:
        pos = self.pos
        ids = np.array(sorted(pos))
        P = np.array([pos[i] for i in ids])
        # 1) merge coincident distinct nodes
        tree = cKDTree(P)
        pairs = tree.query_pairs(MERGE_D, output_type="ndarray")
        parent = {int(i): int(i) for i in ids}

        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a

        merged = 0
        for i, j in pairs:
            a, b = int(ids[i]), int(ids[j])
            if self.nlayer.get(a, 0) != self.nlayer.get(b, 0):
                continue
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[max(ra, rb)] = min(ra, rb)
                merged += 1
        segs = []
        for a, b, wi in self.segs:
            a, b = find(a), find(b)
            if a != b:
                segs.append((a, b, wi))
        self.log.append(f"repair: merged {merged} coincident node pairs")
        # adjacency
        adj: dict[int, set] = defaultdict(set)
        for a, b, wi in segs:
            adj[a].add(b)
            adj[b].add(a)
        seg_way = {}
        for a, b, wi in segs:
            seg_way[(a, b)] = wi
            seg_way[(b, a)] = wi
        W = self.ways
        # 2/3) dangling ends
        ends = [n for n, s in adj.items() if len(s) == 1]
        # segment sample points (every 4 m) for the tee search
        sp, si = [], []
        for k, (a, b, _) in enumerate(segs):
            A, B = np.array(pos[a]), np.array(pos[b])
            m = max(1, int(math.ceil(float(np.hypot(*(B - A))) / 4.0)))
            t_ = np.arange(m + 1) / m
            sp.append(A + (B - A) * t_[:, None])
            si.append(np.full(m + 1, k))
        stree = cKDTree(np.vstack(sp))
        s_idx = np.concatenate(si)
        etree = cKDTree(np.array([pos[n] for n in ends])) if ends else None
        joined = tees = 0
        extra_segs: list[int] = []
        new_segs = []
        used_end = set()

        def end_dir(n):
            (m,) = adj[n]
            p, q = np.array(pos[n]), np.array(pos[m])
            d = p - q
            L = float(np.hypot(*d))
            return d / L if L > 1e-6 else None, seg_way[(n, m)]

        kind_group = lambda k: 0 if k == 0 else (1 if k in (1, 2) else 2)  # noqa: E731
        for n in ends:
            if n in used_end:
                continue
            dn, wn = end_dir(n)
            if dn is None:
                continue
            pn = np.array(pos[n])
            kn = W[wn]["kind"]
            best = None
            # (a) aligned dangling end nearby
            for j in etree.query_ball_point(pn, GAP_D):
                m = ends[j]
                if m == n or m in used_end:
                    continue
                dm, wm = end_dir(m)
                if dm is None or kind_group(W[wm]["kind"]) != kind_group(kn) or W[wm]["layer"] != W[wn]["layer"]:
                    continue
                g = np.array(pos[m]) - pn
                L = float(np.hypot(*g))
                if L < 1e-6:
                    continue
                gu = g / L
                # the gap continues both tracks: n points toward m, m points toward n
                if gu @ dn > math.cos(GAP_ANG) and -gu @ dm > math.cos(GAP_ANG) and -(dn @ dm) > math.cos(GAP_ANG):
                    if best is None or L < best[0]:
                        best = (L, "gap", m)
            if best is not None:
                m = best[2]
                new_segs.append((n, m, wn))
                used_end.update((n, m))
                joined += 1
                continue
            # (b) runs into another track: tee -> switch
            cand = {int(s_idx[j]) for j in stree.query_ball_point(pn + dn * TEE_REACH * 0.5, TEE_REACH * 0.5 + TEE_D + 3.0)}
            cand |= set(extra_segs)
            bt = None
            for k in sorted(cand):
                a, b, wk = segs[k]
                if n in (a, b) or kind_group(W[wk]["kind"]) != kind_group(kn) or W[wk]["layer"] != W[wn]["layer"]:
                    continue
                A, B = np.array(pos[a]), np.array(pos[b])
                AB = B - A
                L2 = float(AB @ AB)
                if L2 < 1e-6:
                    continue
                t = float(np.clip((pn - A) @ AB / L2, 0, 1))
                q = A + AB * t
                off = q - pn
                dist = float(np.hypot(*off))
                along = float(off @ dn)
                lat = abs(float(off[0] * dn[1] - off[1] * dn[0]))
                su = AB / math.sqrt(L2)
                ang = math.acos(min(1.0, abs(float(su @ dn))))
                if lat <= TEE_D and -1.0 <= along <= TEE_REACH and ang <= TEE_ANG and dist <= TEE_REACH + TEE_D:
                    if bt is None or dist < bt[0]:
                        bt = (dist, k, t, q)
            if bt is not None:
                dist, k, t, q = bt
                a, b, wk = segs[k]
                if t <= 0.02 or t >= 0.98:
                    m = a if t <= 0.02 else b
                else:
                    m = -(1_000_000 + len(pos))  # synthetic node id (negative)
                    pos[m] = (float(q[0]), float(q[1]))
                    self.nlayer[m] = W[wk]["layer"]
                    segs[k] = (a, m, wk)
                    segs.append((m, b, wk))
                    extra_segs.append(len(segs) - 1)
                    adj[a].discard(b)
                    adj[b].discard(a)
                    adj[a].add(m)
                    adj[m].update((a, b))
                    adj[b].add(m)
                    seg_way[(a, m)] = seg_way[(m, a)] = wk
                    seg_way[(m, b)] = seg_way[(b, m)] = wk
                if m != n:
                    new_segs.append((n, m, wn))
                    used_end.add(n)
                    tees += 1
        for a, b in FIXES["join"]:
            if a in pos and b in pos and adj[a]:
                new_segs.append((a, b, seg_way[(a, next(iter(adj[a])))]))
        self.repair_segs = set()
        for a, b, wi in new_segs:
            if wi is None:
                continue
            segs.append((a, b, wi))
            self.repair_segs.add((a, b))
            self.repair_segs.add((b, a))
        self.log.append(f"repair: joined {joined} track gaps, {tees} dangling ends made into switches")
        self.segs = segs

    # ---------------------------------------------------------------- compaction
    def _compact(self) -> None:
        pos, W = self.pos, self.ways
        adj: dict[int, list] = defaultdict(list)
        for a, b, wi in self.segs:
            adj[a].append((b, wi))
            adj[b].append((a, wi))
        # dedupe parallel duplicates (same node pair twice)
        for n in list(adj):
            seen = {}
            for m, wi in adj[n]:
                if m not in seen:
                    seen[m] = wi
            adj[n] = list(seen.items())
        key = lambda wi: (W[wi]["kind"], W[wi]["svc"])  # noqa: E731
        junction = set()
        for n, lst in adj.items():
            if len(lst) != 2 or key(lst[0][1]) != key(lst[1][1]):
                junction.add(n)
        visited = set()
        chains = []

        def walk(n0, m, wi):
            nodes, wis = [n0, m], [wi]
            visited.add((n0, m))
            visited.add((m, n0))
            prev, cur = n0, m
            while cur not in junction:
                (a, wa), (b, wb) = adj[cur]
                nxt, wn = (b, wb) if a == prev else (a, wa)
                if (cur, nxt) in visited:
                    break
                visited.add((cur, nxt))
                visited.add((nxt, cur))
                nodes.append(nxt)
                wis.append(wn)
                prev, cur = cur, nxt
                if cur == n0:
                    break
            return nodes, wis

        for n in sorted(junction):
            for m, wi in adj[n]:
                if (n, m) not in visited:
                    chains.append(walk(n, m, wi))
        # isolated loops without junctions
        for n in sorted(adj):
            for m, wi in adj[n]:
                if (n, m) not in visited:
                    junction.add(n)
                    chains.append(walk(n, m, wi))
        nodes = sorted({c[0][0] for c in chains} | {c[0][-1] for c in chains})
        nidx = {n: i for i, n in enumerate(nodes)}
        self.node_osm = np.array(nodes, dtype=np.int64)
        self.nxy = np.array([pos[n] for n in nodes])
        self.e_from = np.array([nidx[c[0][0]] for c in chains], dtype=np.int64)
        self.e_to = np.array([nidx[c[0][-1]] for c in chains], dtype=np.int64)
        self.e_nodes = [c[0] for c in chains]  # OSM node ids along the edge
        self.e_wis = [c[1] for c in chains]  # way index per segment
        self.e_kind = np.array([W[c[1][0]]["kind"] for c in chains], dtype=np.int8)
        for e, c in enumerate(chains):
            if self.e_kind[e] == 0 and any(W[wi].get("lrt") for wi in c[1]):
                self.e_kind[e] = KINDS["light_rail"]
        self.e_svc = np.array([W[c[1][0]]["svc"] for c in chains], dtype=np.int8)
        self.e_repair = np.array([any((a, b) in self.repair_segs for a, b in zip(c[0][:-1], c[0][1:])) for c in chains])
        self.W_used = {wi for c in chains for wi in c[1]}
        # polyline per edge (OSM vertices)
        self.e_xy0 = [np.array([pos[n] for n in c[0]]) for c in chains]

    # ---------------------------------------------------------------- geometry / attributes
    def finish(self) -> None:
        t0 = time.time()
        self._tangents()
        self._moves()
        self._drape()
        self._speeds()
        self._directions()
        self._node_flags()
        self.log.append(f"attributes ({time.time()-t0:.1f}s)")

    def _tangents(self) -> None:
        """Unit direction leaving each edge end (end 0 = at from, 1 = at to), over TAN_D."""
        nE = len(self.e_from)
        self.tan = np.zeros((nE, 2, 2))
        self.e_len = np.zeros(nE)
        for e, xy in enumerate(self.e_xy0):
            d = np.hypot(*np.diff(xy, axis=0).T)
            cum = np.concatenate([[0.0], np.cumsum(d)])
            L = cum[-1]
            self.e_len[e] = L
            for end, (p0, s) in enumerate(((xy[0], min(TAN_D, L)), (xy[-1], max(L - TAN_D, 0.0)))):
                q = np.array([np.interp(s, cum, xy[:, 0]), np.interp(s, cum, xy[:, 1])])
                v = q - p0
                n = float(np.hypot(*v))
                if n < 1e-6:
                    v = (xy[-1] - xy[0]) * (1 if end == 0 else -1)
                    n = float(np.hypot(*v)) or 1.0
                self.tan[e, end] = v / n

    def _moves(self) -> None:
        """Allowed movements: arriving through end (e, k) -> leaving through end (e2, k2)."""
        nN = len(self.nxy)
        ends_at = [[] for _ in range(nN)]
        for e in range(len(self.e_from)):
            ends_at[self.e_from[e]].append((e, 0))
            ends_at[self.e_to[e]].append((e, 1))
        self.ends_at = ends_at
        moves: dict[tuple, list] = {}
        for n, lst in enumerate(ends_at):
            for e, k in lst:
                arr = -self.tan[e, k]  # travel direction arriving at the node
                out = []
                for e2, k2 in lst:
                    if (e2, k2) == (e, k):
                        continue
                    lim = max(TURN_MAX[int(self.e_kind[e])], TURN_MAX[int(self.e_kind[e2])])
                    c = float(arr @ self.tan[e2, k2])
                    if c >= math.cos(math.radians(lim)):
                        out.append((e2, k2))
                moves[(e, k)] = out
        self.moves = moves

    def _drape(self) -> None:
        """Elevation: strokes (straightest continuations through nodes) are draped with the
        grade profile; node z comes from the longest stroke through it and other strokes
        are blended onto it within RAMP m."""
        ter = terrain.get()
        nE = len(self.e_from)
        # pair ends at each node: straightest first
        partner = {}
        for n, lst in enumerate(self.ends_at):
            cand = []
            for i, (e, k) in enumerate(lst):
                for j in range(i + 1, len(lst)):
                    e2, k2 = lst[j]
                    if e2 == e:
                        continue
                    c = float(-self.tan[e, k] @ self.tan[e2, k2])
                    if c > 0.5:
                        cand.append((-c, (e, k), (e2, k2)))
            cand.sort()
            for _, a, b in cand:
                if a not in partner and b not in partner:
                    partner[a] = b
                    partner[b] = a
        self.partner = partner
        seen = np.zeros(nE, bool)
        strokes = []
        for e0 in range(nE):
            if seen[e0]:
                continue
            seen[e0] = True
            # walk backward from end 0, forward from end 1
            fwd = [(e0, 1)]
            cur = (e0, 1)
            while cur in partner:
                e2, k2 = partner[cur]
                if seen[e2]:
                    break
                seen[e2] = True
                fwd.append((e2, 1 - k2))
                cur = (e2, 1 - k2)
            bwd = []
            cur = (e0, 0)
            while cur in partner:
                e2, k2 = partner[cur]
                if seen[e2]:
                    break
                seen[e2] = True
                bwd.append((e2, k2))  # travelled towards end k2's opposite... reversed below
                cur = (e2, 1 - k2)
            # stroke as list of (edge, forward?) in travel order
            st = [(e, k == 1) for e, k in reversed(bwd)] + [(e, k == 1) for e, k in fwd]
            strokes.append(st)
        strokes.sort(key=lambda s: -sum(self.e_len[e] for e, _ in s))
        node_z: dict[int, float] = {}
        self.e_xyz = [None] * nE
        cover_of = lambda e: COVER[int(self.e_kind[e])]  # noqa: E731
        W = self.ways
        for st in strokes:
            # raw stroke polyline, flag per segment, graph nodes (input vertex index)
            V, SF, RV, NI = [], [], [], []
            for e, fw in st:
                xy = self.e_xy0[e] if fw else self.e_xy0[e][::-1]
                wis = self.e_wis[e] if fw else self.e_wis[e][::-1]
                rad = _fillet_radius(int(self.e_kind[e]), int(self.e_svc[e]))
                if not V:
                    V.append(xy[0])
                    RV.append(rad)
                NI.append((len(V) - 1, int(self.e_from[e] if fw else self.e_to[e])))
                for i in range(len(xy) - 1):
                    V.append(xy[i + 1])
                    RV.append(rad)
                    SF.append(W[wis[i]]["flags"])
                NI.append((len(V) - 1, int(self.e_to[e] if fw else self.e_from[e])))
            V = np.array(V)
            # canonical smoothing (rail_geom.fillet, as the rendered track): graph nodes pinned
            pinned = np.zeros(len(V), bool)
            for vi, _ in NI:
                pinned[vi] = True
            Q, vmap = fillet(V, pinned, np.array(RV))
            # densify the smoothed line; segment flags follow the source segment
            seg_of = np.zeros(len(Q) - 1, dtype=np.int64)
            for k in range(len(V) - 1):
                seg_of[vmap[k] : max(vmap[k + 1], vmap[k] + 1)] = k
            pts, fl = [Q[0]], [SF[0] if SF else 0]
            qidx = np.zeros(len(Q), dtype=np.int64)
            for q in range(len(Q) - 1):
                a, b = Q[q], Q[q + 1]
                L = float(np.hypot(*(b - a)))
                k = max(1, int(math.ceil(L / DENSE)))
                f = SF[int(seg_of[q])] if SF else 0
                for jj in range(1, k + 1):
                    pts.append(a + (b - a) * (jj / k))
                    fl.append(f)
                qidx[q + 1] = len(pts) - 1
            node_pos = [(int(qidx[vmap[vi]]), n) for vi, n in NI]
            P = np.array(pts)
            F = np.array(fl)
            g = ter.sample(P[:, 0], P[:, 1])
            # vertex flags: a point is bridge/tunnel if its segment is
            bri = (F & F_BRIDGE) > 0
            tun = (F & F_TUNNEL) > 0
            cov = max(cover_of(e) for e, _ in st)
            z = grade_profile(P, g, bri, tun, clearance=CLEARANCE, cover=cov, ramp=RAMP, open_ends=True)
            cum = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(P, axis=0).T))])
            # blend onto nodes already fixed by longer strokes
            corr = np.zeros(len(P))
            for idx, n in node_pos:
                if n in node_z:
                    dz = node_z[n] - z[idx]
                    if abs(dz) > 1e-3:
                        w = np.clip(1.0 - np.abs(cum - cum[idx]) / RAMP, 0.0, 1.0)
                        corr += dz * w
            z = z + corr
            for idx, n in node_pos:
                if n not in node_z:
                    node_z[n] = float(z[idx])
                else:
                    z[idx] = node_z[n]
            # split back into edges
            for k, (e, fw) in enumerate(st):
                # the edge spans node_pos[2k] .. node_pos[2k+1]
                a, b = node_pos[2 * k][0], node_pos[2 * k + 1][0]
                seg = np.column_stack([P[a : b + 1], z[a : b + 1]])
                flg = F[a + 1 : b + 1] if b > a else F[a : a + 1]
                if not fw:
                    seg = seg[::-1]
                    flg = flg[::-1]
                self.e_xyz[e] = (seg, flg)
        self.node_z = np.array([node_z.get(n, 0.0) for n in range(len(self.nxy))])
        # enforce exact endpoints
        for e in range(nE):
            seg, flg = self.e_xyz[e]
            seg[0, 2] = self.node_z[self.e_from[e]]
            seg[-1, 2] = self.node_z[self.e_to[e]]

    def _speeds(self) -> None:
        """Per-vertex speed limit (m/s) of the segment starting there: min(tag/default, curve)."""
        W = self.ways
        nE = len(self.e_from)
        self.geom = [None] * nE  # (xyz simplified, vlim per vertex, flags per segment)
        self.e_flags = np.zeros(nE, dtype=np.uint8)
        for e in range(nE):
            P, F = self.e_xyz[e]
            kind = int(self.e_kind[e])
            svc = int(self.e_svc[e])
            xy = P[:, :2]
            n = len(P)
            cum = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(xy, axis=0).T))])
            # base limit per original way along the edge (per dense segment via flags owner is
            # lost; take the edge's ways: min of tagged speeds of the ways on this edge, weighted
            # locally is overkill for mostly-uniform edges)
            tagged = [W[wi]["speed"] for wi in self.e_wis[e] if W[wi]["speed"]]
            base = min(tagged) if tagged else V_DEFAULT[kind]
            if svc and not tagged:
                base = min(base, (V_SERVICE_TRANSIT if kind else V_SERVICE)[svc])
            vbase = base / 3.6
            # curvature over +-15 m
            R = np.full(n, np.inf)
            if cum[-1] > 5.0 and n >= 3:
                s0 = np.clip(cum - 15.0, 0, cum[-1])
                s1 = np.clip(cum + 15.0, 0, cum[-1])
                A = np.column_stack([np.interp(s0, cum, xy[:, 0]), np.interp(s0, cum, xy[:, 1])])
                C = np.column_stack([np.interp(s1, cum, xy[:, 0]), np.interp(s1, cum, xy[:, 1])])
                B = xy
                ab = np.hypot(*(B - A).T)
                bc = np.hypot(*(C - B).T)
                ca = np.hypot(*(A - C).T)
                cross = np.abs((B[:, 0] - A[:, 0]) * (C[:, 1] - A[:, 1]) - (B[:, 1] - A[:, 1]) * (C[:, 0] - A[:, 0]))
                ok = (cross > 1e-6) & (ab > 2.0) & (bc > 2.0)
                R[ok] = ab[ok] * bc[ok] * ca[ok] / (2.0 * cross[ok])
            vc = np.sqrt(A_LAT[kind] * np.maximum(R, 8.0))
            v = np.minimum(vbase, vc)
            # simplify (3-D RDP) keeping min speed per kept segment
            from .transit import rdp3

            keep = rdp3(P, RDP_TOL)
            ki = np.nonzero(keep)[0]
            vl = np.array([v[a : max(b, a + 1) + 1].min() for a, b in zip(ki[:-1], ki[1:])] + [v[ki[-1]]])
            fl = np.array([int(np.bitwise_or.reduce(F[a:b])) if b > a else int(F[min(a, len(F) - 1)]) for a, b in zip(ki[:-1], ki[1:])] or [0], dtype=np.uint8)
            self.geom[e] = (P[keep], vl, fl)
            ef = int(np.bitwise_or.reduce(fl)) & (F_BRIDGE | F_TUNNEL)
            if any(W[wi]["flags"] & F_ELECTRIC for wi in self.e_wis[e]):
                ef |= F_ELECTRIC
            if self.e_repair[e]:
                ef |= F_REPAIR
            self.e_flags[e] = ef
            self.e_len[e] = float(np.hypot(*np.diff(P[keep][:, :2], axis=0).T).sum())

    def _directions(self) -> None:
        W = self.ways
        nE = len(self.e_from)
        e_dir = np.full(nE, 3, dtype=np.uint8)
        self.dir_conflicts: list[int] = []
        self.twin_side = np.zeros(nE, dtype=np.int8)  # +1 twin on the left (forward = right-hand), -1 right
        # sample points for twin detection (main tracks of transit classes)
        grp = np.where(self.e_kind == 0, 0, np.where(self.e_kind == 3, 2, 1))
        S_xy, S_e, S_t = [], [], []
        for e in range(nE):
            if self.e_svc[e] != 0:
                continue
            P = self.geom[e][0][:, :2]
            cum = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(P, axis=0).T))])
            L = cum[-1]
            if L < 1.0:
                continue
            s = np.arange(2.5, L, 5.0)
            x = np.interp(s, cum, P[:, 0])
            y = np.interp(s, cum, P[:, 1])
            i = np.clip(np.searchsorted(cum, s) - 1, 0, len(P) - 2)
            d = P[i + 1] - P[i]
            d = d / np.maximum(np.hypot(*d.T), 1e-9)[:, None]
            S_xy.append(np.column_stack([x, y]))
            S_e.append(np.full(len(s), e))
            S_t.append(d)
        S_xy = np.vstack(S_xy)
        S_e = np.concatenate(S_e)
        S_t = np.vstack(S_t)
        tree = cKDTree(S_xy)
        for e in range(nE):
            kind = int(self.e_kind[e])
            pd = 0
            for wi in self.e_wis[e]:
                if W[wi]["pdir"]:
                    pd = W[wi]["pdir"]
            m = S_e == e
            if not m.any():
                continue
            pts, tg = S_xy[m], S_t[m]
            # skip samples within 30 m of the edge ends when the edge is long enough
            tmax = TWIN_MAX[kind]
            nb = tree.query_ball_point(pts, tmax)
            left = right = 0
            mine = {int(self.e_from[e]), int(self.e_to[e])}
            for p, t, lst in zip(pts, tg, nb):
                l = r = False
                for j in lst:
                    e2 = S_e[j]
                    if e2 == e or grp[e2] != grp[e]:
                        continue
                    # parallel tracks that meet each other (loop / siding / platform pairs)
                    # are not the two directions of a double-track line
                    if int(self.e_from[e2]) in mine or int(self.e_to[e2]) in mine:
                        continue
                    if abs(float(S_t[j] @ t)) < 0.95:
                        continue
                    off = S_xy[j] - p
                    lat = float(t[0] * off[1] - t[1] * off[0])
                    if TWIN_MIN <= abs(lat) <= tmax:
                        if lat > 0:
                            l = True
                        else:
                            r = True
                left += l and not r
                right += r and not l
            n = len(pts)
            side = 0
            if left >= max(0.3 * n, 5) and right <= 0.1 * left:
                side = 1
            elif right >= max(0.3 * n, 5) and left <= 0.1 * right:
                side = -1
            if n < 6:  # < 30 m: too short to judge (junction pieces); see propagation below
                side = 0
            self.twin_side[e] = side
            # right-hand running on double track wins over direction tags (Toronto's tram
            # tags disagree with the geometry about half of the time)
            if kind in (1, 2, 3) and side:
                e_dir[e] = 1 if side > 0 else 2
                if pd and (pd > 0) != (side > 0):
                    self.dir_conflicts.append(int(e))
        # propagate one-way running along straight continuations (partnered ends) into short
        # or twin-less pieces between switches, while both neighbours agree
        tag_dir = {}
        for e in range(nE):
            for wi in self.e_wis[e]:
                if W[wi]["pdir"]:
                    tag_dir[e] = W[wi]["pdir"]
        for _ in range(6):
            changed = False
            for e in range(nE):
                if e_dir[e] != 3 or self.e_kind[e] == 0 or self.e_svc[e] == 3 or self.e_len[e] > 30.0:
                    continue
                votes = []
                for k in (0, 1):
                    q = self.partner.get((e, k))
                    if q is None:
                        continue
                    e2, k2 = q
                    if e_dir[e2] == 3:
                        continue
                    # e2 allowed toward its end k2 (arriving at the shared node)?
                    arrive = (k2 == 1) == (e_dir[e2] == 1)
                    # arriving via e2 means leaving the node into e through end k: e travelled away from k
                    fwd = (k == 0) if arrive else (k == 1)
                    votes.append(1 if fwd else 2)
                # both straight neighbours one-way and agreeing (a piece of a double-track line)
                if len(votes) == 2 and votes[0] == votes[1]:
                    e_dir[e] = votes[0]
                    changed = True
            if not changed:
                break
        for e, pd in tag_dir.items():
            if e_dir[e] == 3 and self.twin_side[e] == 0 and self.e_kind[e] != 3:
                e_dir[e] = 1 if pd > 0 else 2
        self.e_dir = e_dir
        nd = int((e_dir != 3).sum())
        self.log.append(f"directions: {nd} one-way edges ({(self.e_len[e_dir != 3].sum() / 1000):.0f} km), "
                        f"{int((self.twin_side != 0).sum())} edges with a parallel twin, "
                        f"{len(self.dir_conflicts)} direction tags overridden by right-hand running "
                        f"(ways {sorted({self.ways[self.e_wis[e][0]]['id'] for e in self.dir_conflicts})[:12]})")

    def _node_flags(self) -> None:
        nN = len(self.nxy)
        fl = np.zeros(nN, dtype=np.uint8)
        for n, lst in enumerate(self.ends_at):
            if len(lst) == 1:
                fl[n] |= N_END
            elif len(lst) >= 3:
                # diamond: every end connects to exactly one other; switch otherwise
                outs = [len(self.moves[x]) for x in lst]
                if len(lst) == 4 and all(o == 1 for o in outs):
                    fl[n] |= N_DIAMOND
                else:
                    fl[n] |= N_SWITCH
            if self.node_osm[n] < 0:
                fl[n] |= N_REPAIR
        self.n_flags = fl

    # ---------------------------------------------------------------- platforms
    def platforms(self, osm: dict) -> None:
        """Platform extents along edges: self.plat[e] = [(s0, s1, side)], side +1 left of the
        edge's forward direction, -1 right."""
        pts, own = [], []
        for k, (pid, t, ps) in enumerate(osm["platforms"]):
            lon = np.array([p[1] for p in ps])
            lat = np.array([p[2] for p in ps])
            x, y = geo.project(lon, lat)
            xy = np.column_stack([x, y])
            d = np.hypot(*np.diff(xy, axis=0).T)
            for i, L in enumerate(d):
                m = max(1, int(math.ceil(L / 2.0)))
                t_ = (np.arange(m) + 0.5) / m
                pts.append(xy[i] + (xy[i + 1] - xy[i]) * t_[:, None])
                own.append(np.full(m, k))
        self.plat = [[] for _ in range(len(self.e_from))]
        if not pts:
            return
        pts = np.vstack(pts)
        own = np.concatenate(own)
        tree = cKDTree(pts)
        for e in range(len(self.e_from)):
            if self.e_svc[e] == 2:
                continue
            P = self.geom[e][0][:, :2]
            cum = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(P, axis=0).T))])
            L = cum[-1]
            if L < 5:
                continue
            s = np.arange(1.0, L, 2.0)
            x = np.interp(s, cum, P[:, 0])
            y = np.interp(s, cum, P[:, 1])
            i = np.clip(np.searchsorted(cum, s) - 1, 0, len(P) - 2)
            dvec = P[i + 1] - P[i]
            dvec = dvec / np.maximum(np.hypot(*dvec.T), 1e-9)[:, None]
            Q = np.column_stack([x, y])
            hits = tree.query_ball_point(Q, 6.5)
            by: dict[tuple, list] = defaultdict(list)
            for j, h in enumerate(hits):
                for q in h:
                    off = pts[q] - Q[j]
                    lat = float(dvec[j, 0] * off[1] - dvec[j, 1] * off[0])
                    if abs(lat) <= 6.5:
                        by[(int(own[q]), 1 if lat > 0 else -1)].append(s[j])
            for (k, side), ss in by.items():
                ss = np.unique(np.array(ss))
                # contiguous runs
                brk = np.nonzero(np.diff(ss) > 12.0)[0]
                for a, b in zip(np.r_[0, brk + 1], np.r_[brk, len(ss) - 1]):
                    s0, s1 = float(ss[a]) - 1.0, float(ss[b]) + 1.0
                    if s1 - s0 >= 15.0:
                        self.plat[e].append((max(0.0, s0), min(L, s1), side))
        n = sum(len(p) for p in self.plat)
        self.log.append(f"platforms: {n} platform extents on {sum(1 for p in self.plat if p)} edges")

    # ---------------------------------------------------------------- depots
    def depots(self) -> list[dict]:
        """Per DEPOTS entry: the storage tracks (graph edge ids) of the nearest connected
        yard / siding component of its track group."""
        grp = np.where(self.e_kind == 0, 0, np.where(self.e_kind == 3, 3, np.where(self.e_kind == 2, 2, 1)))
        store = (self.e_svc == 1) | (self.e_svc == 2)
        # components of storage edges joined at nodes
        parent = list(range(len(self.e_from)))

        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a

        for n, lst in enumerate(self.ends_at):
            es = [e for e, _ in lst if store[e]]
            for e in es[1:]:
                ra, rb = find(es[0]), find(e)
                if ra != rb:
                    parent[ra] = rb
        comps: dict[int, list[int]] = {}
        for e in np.nonzero(store)[0].tolist():
            comps.setdefault(find(e), []).append(e)
        out = []
        for did, name, g, ags, lat, lon in DEPOTS:
            x, y = geo.project(lon, lat)
            best = None
            for c, es in comps.items():
                if grp[es[0]] != g:
                    continue
                L = float(self.e_len[es].sum())
                if L < 250.0:
                    continue
                d = min(float(np.hypot(self.geom[e][0][:, 0] - x, self.geom[e][0][:, 1] - y).min()) for e in es)
                if d < 2500.0 and (best is None or d < best[0]):
                    best = (d, es, L)
            if best is None:
                self.log.append(f"depot {did}: no storage tracks found")
                continue
            d, es, L = best
            out.append(dict(id=did, name=name, group=g, agencies=ags, edges=sorted(es), km=round(L / 1000, 2), off=round(d)))
        self.log.append("depots: " + ", ".join(f"{o['id']} {o['km']} km ({len(o['edges'])} tracks, {o['off']} m)" for o in out))
        return out

    # ---------------------------------------------------------------- level crossings
    def crossings(self) -> list[tuple]:
        """railway=level_crossing / crossing (road and path) nodes on the graph: (osm id, edge, s along the edge, E, N)."""
        tags = getattr(self, "node_tags", None) or {}
        ids = [n for n, t in tags.items() if t.get("railway") in ("level_crossing", "crossing") and n in self.pos]
        where: dict[int, int] = {}
        for e, nodes in enumerate(self.e_nodes):
            for n in nodes:
                where.setdefault(n, e)
        out = []
        for n in ids:
            e = where.get(n)
            if e is None:
                continue
            x, y = self.pos[n]
            P = self.geom[e][0][:, :2]
            A, AB = P[:-1], P[1:] - P[:-1]
            L2 = np.maximum((AB**2).sum(1), 1e-12)
            t = np.clip(((np.array([x, y]) - A) * AB).sum(1) / L2, 0, 1)
            d = np.hypot(*(A + AB * t[:, None] - (x, y)).T)
            i = int(np.argmin(d))
            cum = np.concatenate([[0.0], np.cumsum(np.sqrt(L2))])
            out.append((int(n), int(e), float(cum[i] + t[i] * math.sqrt(L2[i])), float(x), float(y)))
        return out

    # ---------------------------------------------------------------- output
    def write(self, used: np.ndarray | None = None) -> dict:
        """Write data/rail/network.bin.gz. `used` = bool mask of edges to keep (default all but yards)."""
        nE = len(self.e_from)
        dep = self.depots()
        if used is None:
            used = ~((self.e_kind == 0) & (self.e_svc == 2))  # no freight / main-line yards...
            for d in dep:
                used[d["edges"]] = True  # ...except the passenger depots
            # keep the depots' tracks connected: main-line yard edges touching kept depot edges
        self.depot_list = dep
        cross = self.crossings()
        keep = np.nonzero(used)[0]
        emap = np.full(nE, -1, dtype=np.int64)
        emap[keep] = np.arange(len(keep))
        nodes = sorted(set(self.e_from[keep].tolist()) | set(self.e_to[keep].tolist()))
        nmap = np.full(len(self.nxy), -1, dtype=np.int64)
        nmap[nodes] = np.arange(len(nodes))
        e_off = [0]
        xyz, vl, sf = [], [], []
        for e in keep:
            P, v, f = self.geom[e]
            xyz.append(P)
            vl.append(np.clip(np.round(v * 2.0), 1, 255).astype(np.uint8))
            sf.append(np.append(f, 0).astype(np.uint8))
            e_off.append(e_off[-1] + len(P))
        # movements over edge ends (2*e + k)
        c_off = [0]
        c_to = []
        for e in keep:
            for k in (0, 1):
                for e2, k2 in self.moves[(e, k)]:
                    if emap[e2] >= 0:
                        c_to.append(2 * emap[e2] + k2)
                c_off.append(len(c_to))
        # platforms
        p_off = [0]
        p_s = []
        for e in keep:
            for s0, s1, side in self.plat[e]:
                p_s += [s0, s1, float(side)]
            p_off.append(len(p_s) // 3)
        arrays = {
            "n_xyz": np.column_stack([self.nxy[nodes], self.node_z[nodes]]).astype(np.float32).ravel(),
            "n_flags": self.n_flags[nodes].astype(np.uint8),
            "n_osm": self.node_osm[nodes].astype(np.float64),
            "e_from": nmap[self.e_from[keep]].astype(np.uint32),
            "e_to": nmap[self.e_to[keep]].astype(np.uint32),
            "e_off": np.array(e_off, dtype=np.uint32),
            "e_xyz": np.vstack(xyz).astype(np.float32).ravel(),
            "e_vlim": np.concatenate(vl),
            "e_vflags": np.concatenate(sf),
            "e_len": self.e_len[keep].astype(np.float32),
            "e_kind": self.e_kind[keep].astype(np.uint8),
            "e_service": self.e_svc[keep].astype(np.uint8),
            "e_dir": self.e_dir[keep].astype(np.uint8),
            "e_flags": self.e_flags[keep].astype(np.uint8),
            "e_osm": np.array([self.ways[self.e_wis[e][0]]["id"] for e in keep], dtype=np.float64),
            "c_off": np.array(c_off, dtype=np.uint32),
            "c_to": np.array(c_to, dtype=np.uint32),
            "p_off": np.array(p_off, dtype=np.uint32),
            "p_s": np.array(p_s, dtype=np.float32),
        }
        self.out_map = emap
        h = self.hash()
        depots = [dict(id=d["id"], name=d["name"], group=d["group"], agencies=d["agencies"], edges=[int(emap[e]) for e in d["edges"] if emap[e] >= 0]) for d in dep]
        crossings = [[c[0], int(emap[c[1]]), round(c[2], 2), round(c[3], 1), round(c[4], 1)] for c in cross if emap[c[1]] >= 0]
        size = tbn.write(OUT / "network.bin.gz", arrays, level=9, version=1, hash=h, kinds=KIND_NAMES, depots=depots, crossings=crossings)
        self.log.append(f"level crossings: {len(crossings)}")
        self.log.append(f"network.bin.gz: {size/1024:.0f} KiB, {len(keep)} edges, {len(nodes)} nodes, {len(np.vstack(xyz))} vertices")
        return {"file": "network.bin.gz", "bytes": size, "hash": h, "edges": int(len(keep))}

    def hash(self) -> str:
        import hashlib

        m = hashlib.sha1()
        m.update(self.e_from.tobytes())
        m.update(self.e_to.tobytes())
        m.update(np.round(self.e_len, 1).tobytes())
        return m.hexdigest()[:12]


def load(rebuild: bool = False) -> RailGraph:
    """Graph with attributes and platforms (cached in work/rail_graph.pkl)."""
    src = geo.RAW / "bbox.osm.pbf"
    if not rebuild and CACHE_GRAPH.exists() and CACHE_GRAPH.stat().st_mtime > max(src.stat().st_mtime, __import__("os").path.getmtime(__file__)):
        return pickle.loads(CACHE_GRAPH.read_bytes())
    osm = extract()
    g = RailGraph()
    g.node_tags = osm["node_tags"]
    g.build(osm)
    g.finish()
    g.platforms(osm)
    CACHE_GRAPH.write_bytes(pickle.dumps(g, protocol=5))
    return g


if __name__ == "__main__":
    t0 = time.time()
    from tpipe import rail_graph as _m  # pickle the class under its module name

    g = _m.load(rebuild="--rebuild" in sys.argv)
    for line in g.log:
        print(line)
    print(f"done in {time.time()-t0:.0f}s")
