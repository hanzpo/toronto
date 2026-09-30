"""Air traffic: airport geometry (OSM) + representative daily flight schedules.

Outputs (docs/AIR.md):
    app/public/data/air/airports.json            runways, taxi graph, stands per airport
    app/public/data/air/schedule_{weekday,saturday,sunday}.json

Sources
- Geometry: OSM aeroway=* from raw/bbox.osm.pbf (runway, taxiway, taxilane,
  parking_position, terminal); elevations from the pipeline terrain grid.
- Flights: real callsign -> route pairs from the vradarserver "standing-data"
  route database (raw/air/sd, git sparse clone; CC0), filtered to carriers
  that currently serve each airport. Daily volumes, fleet mixes and time-of-day
  banks are *modelled* (see AIRLINES / PROFILES below): OpenSky's anonymous
  API no longer serves historical flights, so departure/arrival times are
  synthetic but follow the airports' published patterns (Pearson ~1,150
  movements/weekday, Billy Bishop curfew 23:00-06:45, Hamilton cargo night bank).

    uv run python -m tpipe.air
"""

from __future__ import annotations

import csv
import glob
import heapq
import json
import math
import random
import subprocess
from collections import defaultdict

import numpy as np

from . import geo
from .terrain import get as terrain

SD = geo.RAW / "air" / "sd"  # vradarserver standing-data sparse clone
AEROWAY_PBF = geo.WORK / "aeroway.osm.pbf"
OUT = geo.OUT / "air"

MAG_VAR = -10.0  # Toronto magnetic variation (deg, west negative): true = mag + var

# ----------------------------------------------------------------------------- airports

AIRPORTS: dict[str, dict] = {
    "CYYZ": dict(
        name="Toronto Pearson", iata="YYZ", lonlat=(-79.6306, 43.6777), radius=4500,
        terminals={"T1": (-79.6127, 43.6793), "T3": (-79.6205, 43.6850)},
        # stream -> runway designator per configuration. A* = arrival streams,
        # D* = departure streams, N = single mixed night stream.
        configs=[
            dict(name="west", weight=0.68, streams={"A1": "24R", "A2": "23", "D1": "24L", "N": "23"}),
            dict(name="east", weight=0.32, streams={"A1": "06L", "A2": "05", "D1": "06R", "N": "05"}),
        ],
        night=(0.5, 6.5), taxi_in=8, taxi_out=12,
    ),
    "CYTZ": dict(
        name="Billy Bishop", iata="YTZ", lonlat=(-79.3962, 43.6275), radius=1500,
        terminals={"T": (-79.3945, 43.6300)},
        configs=[
            dict(name="west", weight=0.68, streams={"M": "26"}),
            dict(name="east", weight=0.32, streams={"M": "08"}),
        ],
        curfew=(23.0, 6.75), taxi_in=3, taxi_out=4,
    ),
    "CYHM": dict(
        name="Hamilton", iata="YHM", lonlat=(-79.9350, 43.1736), radius=2600,
        terminals={"T": (-79.9275, 43.1700)},
        configs=[
            dict(name="west", weight=0.68, streams={"M": "30"}),
            dict(name="east", weight=0.32, streams={"M": "12"}),
        ],
        taxi_in=4, taxi_out=5,
    ),
    "CYKF": dict(
        name="Waterloo", iata="YKF", lonlat=(-80.3786, 43.4608), radius=2200,
        terminals={"T": (-80.3865, 43.4585)},
        configs=[
            dict(name="west", weight=0.68, streams={"M": "26"}),
            dict(name="east", weight=0.32, streams={"M": "08"}),
        ],
        taxi_in=3, taxi_out=4,
    ),
}

# Aircraft: wingspan (m) for stand fitting, class for turnaround / timing.
TYPES = {
    "DH8D": (28.4, "turboprop"), "CRJ9": (24.9, "regional"), "E75L": (26.0, "regional"),
    "E295": (35.1, "narrow"), "BCS3": (35.1, "narrow"), "A319": (35.8, "narrow"),
    "A320": (35.8, "narrow"), "A20N": (35.8, "narrow"), "A321": (35.8, "narrow"),
    "A21N": (35.8, "narrow"), "B737": (35.8, "narrow"), "B738": (35.8, "narrow"),
    "B38M": (35.9, "narrow"), "B39M": (35.9, "narrow"), "B752": (38.1, "narrow"),
    "B763": (47.6, "wide"), "B788": (60.1, "wide"), "B789": (60.1, "wide"),
    "A333": (60.3, "wide"), "A339": (64.0, "wide"), "A359": (64.8, "wide"), "B77W": (64.8, "wide"),
}
MIN_TURN = {"turboprop": 25, "regional": 35, "narrow": 45, "wide": 110}

# Carriers per airport: ICAO -> (weekday departures, fleet spec, terminal zone, hub?)
# fleet spec: list of (maxDistKm, {type: weight}) evaluated in order.
N_AC = [(4600, {"BCS3": 3, "B38M": 3, "A320": 2, "A321": 2, "A20N": 1}), (99999, {"B789": 4, "B788": 2, "A333": 2, "B77W": 3})]
N_JZA = [(750, {"DH8D": 5, "CRJ9": 3, "E75L": 1}), (99999, {"CRJ9": 6, "E75L": 3})]
N_ROU = [(99999, {"A321": 5, "A320": 3, "A319": 2})]
N_WJA = [(4800, {"B38M": 5, "B737": 2, "B738": 4}), (99999, {"B789": 1})]
N_SWG = [(99999, {"B738": 3, "B38M": 2})]
N_POE_YYZ = [(600, {"E295": 4, "DH8D": 1}), (99999, {"E295": 1})]
N_POE_YTZ = [(99999, {"DH8D": 1})]
N_TSC = [(4600, {"A21N": 1}), (99999, {"A21N": 1, "A333": 2})]
N_FLE = [(99999, {"B38M": 3, "B737": 1})]
N_NB_US = [(99999, {"A320": 2, "B738": 2, "B39M": 1, "A321": 1})]
N_RJ_US = [(99999, {"E75L": 3, "CRJ9": 2})]
N_WIDE = [(99999, {"B77W": 1})]
N_CARGO = [(99999, {"B763": 1})]
N_CJT = [(99999, {"B763": 3, "B752": 1})]


def wide(**w):
    return [(99999, w)]


CARRIERS: dict[str, dict[str, tuple]] = {
    # zone: T1 | T3 | cargo (Pearson terminal allocation; ignored elsewhere)
    "CYYZ": {
        "ACA": (170, N_AC, "T1", True), "JZA": (125, N_JZA, "T1", True), "ROU": (22, N_ROU, "T1", True),
        "WJA": (80, N_WJA, "T3", True), "POE": (45, N_POE_YYZ, "T3", True), "SWG": (10, N_SWG, "T3", False),
        "TSC": (14, N_TSC, "T3", False), "FLE": (10, N_FLE, "T3", False),
        "UAL": (6, N_NB_US, "T1", False), "SKW": (8, N_RJ_US, "T1", False), "RPA": (6, N_RJ_US, "T3", False),
        "AAL": (5, N_NB_US, "T3", False), "EGF": (4, N_RJ_US, "T3", False), "JIA": (3, N_RJ_US, "T3", False),
        "DAL": (3, N_NB_US, "T3", False), "EDV": (6, N_RJ_US, "T3", False),
        "BAW": (3, wide(B77W=2, B789=1), "T3", False), "DLH": (2, wide(A359=1, A333=1), "T1", False),
        "AFR": (2, wide(B77W=1, A359=1), "T3", False), "KLM": (1, wide(B789=1), "T3", False),
        "SWR": (1, wide(A333=1), "T1", False), "LOT": (1, wide(B788=1), "T1", False), "THY": (1, N_WIDE, "T1", False),
        "ELY": (1, wide(B789=1), "T3", False), "UAE": (1, N_WIDE, "T3", False), "ETD": (1, wide(B789=1), "T3", False),
        "ETH": (1, wide(B788=1), "T1", False), "AIC": (1, N_WIDE, "T1", False), "PIA": (1, N_WIDE, "T3", False),
        "CPA": (2, wide(A359=1, B77W=1), "T3", False), "EVA": (1, N_WIDE, "T1", False), "CAL": (1, N_WIDE, "T3", False),
        "KAL": (1, wide(B789=1, B77W=1), "T3", False), "CSN": (1, wide(B789=1), "T3", False), "PAL": (1, N_WIDE, "T3", False),
        "TAP": (1, [(99999, {"A21N": 1})], "T1", False), "RZO": (1, [(99999, {"A21N": 1})], "T3", False),
        "CFG": (1, wide(A339=1), "T3", False), "NOS": (1, wide(B789=1), "T3", False), "ITY": (1, wide(A333=1), "T3", False),
        "AMX": (3, [(99999, {"B38M": 1, "B738": 1})], "T3", False), "CMP": (2, [(99999, {"B38M": 1, "B738": 1})], "T1", False),
        "BWA": (2, [(99999, {"B38M": 1})], "T3", False), "DWI": (1, [(99999, {"B38M": 1})], "T3", False),
        "AVA": (1, [(99999, {"A320": 1})], "T1", False), "ICE": (1, [(99999, {"B38M": 1})], "T3", False),
        "FDX": (2, N_CARGO, "cargo", False), "CJT": (3, N_CJT, "cargo", False), "UPS": (1, N_CARGO, "cargo", False),
    },
    "CYTZ": {"POE": (72, N_POE_YTZ, "T", True), "JZA": (11, [(99999, {"DH8D": 1})], "T", False)},
    "CYHM": {
        "CJT": (16, N_CJT, "cargo", True), "UPS": (1, N_CARGO, "cargo", False),
        "WJA": (4, N_WJA, "T", False), "FLE": (1, N_FLE, "T", False), "POE": (1, [(99999, {"E295": 1})], "T", False),
    },
    "CYKF": {"FLE": (3, N_FLE, "T", False), "WJA": (2, N_WJA, "T", False)},
}
CARGO_AIRLINES = {"FDX", "UPS", "CJT", "BOX", "CKS", "GTI", "CLX"}
LEISURE = {"TSC", "SWG", "FLE", "ROU", "CFG", "NOS", "RZO", "DWI", "BWA", "AMX", "CMP"}
PROFILE_SCALE = {"weekday": 1.0, "saturday": 0.8, "sunday": 0.9}
LEISURE_SCALE = {"weekday": 1.0, "saturday": 1.1, "sunday": 1.0}
CARGO_SCALE = {"weekday": 1.0, "saturday": 0.3, "sunday": 0.55}

# Hour-of-day weights (local) per market, [arrivals, departures].
H = {
    "short": ([.5, 0, 0, 0, 0, 0, .5, 2, 6, 7, 6, 5, 5, 6, 6, 6, 6, 6, 7, 7, 7, 6, 5, 2.5],
              [0, 0, 0, 0, 0, 0, 4, 8, 8, 6, 5, 5, 6, 6, 5, 6, 7, 8, 8, 6, 5, 4, 2, .5]),
    "west": ([2, 0, 0, 0, 0, 1, 5, 6, 2, 1, 1, 1, 2, 4, 5, 5, 5, 5, 5, 4, 4, 5, 5, 4],
             [0, 0, 0, 0, 0, 0, 1, 6, 5, 3, 2, 2, 2, 3, 2, 3, 4, 5, 6, 5, 4, 3, 2, 0]),
    "sun": ([1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 6, 6, 6, 5, 4, 4, 4, 3, 2],
            [0, 0, 0, 0, 0, 0, 6, 8, 8, 6, 5, 3, 2, 2, 2, 2, 3, 3, 2, 1, 1, 1, 0, 0]),
    "europe": ([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 6, 8, 9, 8, 7, 5, 2, 1, 0, 0, 0, 0, 0],
               [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 4, 8, 10, 9, 7, 5, 2]),
    "far": ([0, 0, 0, 0, 1, 3, 5, 5, 4, 2, 1, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0, 0, 0, 0],
            [3, 2, 0, 0, 0, 0, 0, 0, 0, 1, 3, 5, 5, 4, 2, 1, 1, 1, 2, 2, 2, 2, 3, 3]),
    "southam": ([0, 0, 0, 0, 1, 3, 6, 6, 4, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0],
                [2, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 3, 4, 6, 6, 4]),
    "cargo": ([5, 4, 3, 3, 4, 5, 3, 2, 1, .5, .5, .5, .5, .5, .5, .5, 1, 1, 1, 2, 4, 5, 6, 6],
              [6, 6, 5, 3, 1, 1, 3, 4, 2, 1, .5, .5, .5, .5, .5, .5, .5, 1, 1, 1, 2, 3, 4, 6]),
    "cargohub": ([6, 6, 3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, .5, 2, 5, 7],
                 [0, 0, 3, 7, 6, 3, 1, .5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, .5, 1, 2, 2, 1, 0]),
}

SEP = {"arr": 95, "dep": 70, "mixed": 110}  # min seconds between runway uses per stream
DAY0 = 3 * 3600  # air day runs 03:00 -> 27:00 local


# ----------------------------------------------------------------------------- geodesy

def gc(lat1, lon1, lat2, lon2):
    """great-circle distance (km) and initial bearing (deg true)"""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    d = 2 * 6371 * math.asin(min(1, math.sqrt(a)))
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return d, (math.degrees(math.atan2(y, x)) + 360) % 360


def market(lat, lon, dist, brg, airline):
    if airline in CARGO_AIRLINES:
        return "cargo"
    if dist < 1600:
        return "short"
    if lat < 30 and -125 < lon < -55 and dist < 5200:
        return "sun"
    if lat < 12 and dist > 3500:
        return "southam"
    if dist >= 9000 and (brg >= 290 or brg < 45):
        return "far"
    if dist >= 4500 and 15 <= brg <= 130:
        return "europe"
    if 200 <= brg <= 340:
        return "west"
    return "short"


# ----------------------------------------------------------------------------- OSM

def _ensure_aeroway_pbf():
    src = geo.RAW / "bbox.osm.pbf"
    if AEROWAY_PBF.exists() and AEROWAY_PBF.stat().st_mtime > src.stat().st_mtime:
        return
    subprocess.run(["osmium", "tags-filter", str(src), "nwr/aeroway", "-o", str(AEROWAY_PBF), "--overwrite"], check=True)


def load_osm():
    import osmium

    _ensure_aeroway_pbf()
    cent = {k: geo.project(*a["lonlat"]) for k, a in AIRPORTS.items()}
    out = {k: dict(ways=[], pp_nodes=[], gates=[], terminals=[]) for k in AIRPORTS}

    def which(x, y):
        for k, (cx, cy) in cent.items():
            if (x - cx) ** 2 + (y - cy) ** 2 < AIRPORTS[k]["radius"] ** 2:
                return k
        return None

    for o in osmium.FileProcessor(str(AEROWAY_PBF)).with_locations():
        a = o.tags.get("aeroway")
        if o.type_str() == "n":
            if a not in ("parking_position", "gate"):
                continue
            x, y = geo.project(o.location.lon, o.location.lat)
            k = which(x, y)
            if k:
                (out[k]["pp_nodes"] if a == "parking_position" else out[k]["gates"]).append(
                    dict(x=x, y=y, ref=o.tags.get("ref")))
            continue
        if o.type_str() != "w" or a not in ("runway", "taxiway", "taxilane", "parking_position", "terminal"):
            continue
        try:
            ids = [n.ref for n in o.nodes]
            ll = [(n.lon, n.lat) for n in o.nodes]
        except osmium.InvalidLocationError:
            continue
        xs, ys = geo.project(np.array([p[0] for p in ll]), np.array([p[1] for p in ll]))
        k = which(float(np.mean(xs)), float(np.mean(ys)))
        if not k:
            continue
        out[k]["ways"].append(dict(kind=a, ids=ids, x=list(map(float, xs)), y=list(map(float, ys)),
                                   ref=o.tags.get("ref"), name=o.tags.get("name")))
    return out


# ----------------------------------------------------------------------------- geometry

class Graph:
    def __init__(self):
        self.idx: dict = {}
        self.xy: list[list[float]] = []
        self.adj: dict[int, dict[int, int]] = defaultdict(dict)  # a -> b -> kind

    def node(self, key, x, y):
        i = self.idx.get(key)
        if i is None:
            i = len(self.xy)
            self.idx[key] = i
            self.xy.append([x, y])
        return i

    def edge(self, a, b, kind):
        if a == b:
            return
        k = min(self.adj[a].get(b, 9), kind)
        self.adj[a][b] = k
        self.adj[b][a] = k

    def remove_edge(self, a, b):
        self.adj[a].pop(b, None)
        self.adj[b].pop(a, None)


KIND = {"taxiway": 0, "taxilane": 1, "runway": 2, "lead": 3}


def runway_ends(ways):
    """merge runway ways by ref -> [(des, thrXY, otherXY)]"""
    by = defaultdict(list)
    for w in ways:
        if w["kind"] == "runway" and w["ref"] and "/" in w["ref"]:
            by[w["ref"].replace(" ", "")].extend(zip(w["x"], w["y"]))
    ends = []
    for ref, pts in by.items():
        P = np.array(pts)
        c = P.mean(0)
        u, s, vt = np.linalg.svd(P - c)
        d = vt[0]
        t = (P - c) @ d
        a, b = c + d * t.min(), c + d * t.max()
        des = ref.split("/")
        hdg_ab = (math.degrees(math.atan2(b[0] - a[0], b[1] - a[1])) + 360) % 360
        mag_ab = (hdg_ab - MAG_VAR) % 360
        n0 = int("".join(ch for ch in des[0] if ch.isdigit()))
        # does des[0] fly a->b ?
        diff = abs(((n0 * 10 - mag_ab) + 180) % 360 - 180)
        if diff < 90:
            ends += [(des[0], a, b), (des[1], b, a)]
        else:
            ends += [(des[0], b, a), (des[1], a, b)]
    return ends


def build_airport(icao, osm, T):
    ap = AIRPORTS[icao]
    g = Graph()
    for w in osm["ways"]:
        if w["kind"] not in ("taxiway", "taxilane", "runway"):
            continue
        k = KIND[w["kind"]]
        prev = None
        for nid, x, y in zip(w["ids"], w["x"], w["y"]):
            i = g.node(nid, x, y)
            if prev is not None:
                g.edge(prev, i, k)
            prev = i
    ends = runway_ends(osm["ways"])
    rw_nodes = {i for i in range(len(g.xy)) if any(k == 2 for k in g.adj[i].values())}

    # --- stands
    stands = []
    taxi_edges = [(a, b) for a in list(g.adj) for b, k in g.adj[a].items() if a < b and k in (0, 1)]
    XY = np.array(g.xy)

    def nearest_edge(px, py, maxd=160.0):
        best = None
        for a, b in taxi_edges:
            ax, ay = XY[a]
            bx, by = XY[b]
            dx, dy = bx - ax, by - ay
            L2 = dx * dx + dy * dy
            if L2 < 1e-6:
                continue
            t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
            qx, qy = ax + t * dx, ay + t * dy
            d = math.hypot(px - qx, py - qy)
            if d < maxd and (best is None or d < best[0]):
                best = (d, a, b, t, qx, qy)
        return best

    raw = []
    for w in osm["ways"]:
        if w["kind"] != "parking_position":
            continue
        p0, p1 = (w["x"][0], w["y"][0]), (w["x"][-1], w["y"][-1])
        if math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < 5:
            raw.append(dict(stop=((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2), lead=None, ref=w["ref"]))
            continue
        e0, e1 = nearest_edge(*p0, 400), nearest_edge(*p1, 400)
        d0 = e0[0] if e0 else 1e9
        d1 = e1[0] if e1 else 1e9
        # the lead-in starts at the end nearer the taxi network; the nose stops at the other
        raw.append(dict(stop=p1 if d0 <= d1 else p0, lead=p0 if d0 <= d1 else p1, ref=w["ref"]))
    for n in osm["pp_nodes"]:
        raw.append(dict(stop=(n["x"], n["y"]), lead=None, ref=n["ref"]))
    # drop duplicates / MARS sub-stands (within 18 m of a kept stand)
    raw.sort(key=lambda s: (s["lead"] is None, (s["ref"] or "~").endswith(("A", "B", "L", "R")), s["ref"] or "~"))
    kept = []
    for s in raw:
        if all(math.hypot(s["stop"][0] - k["stop"][0], s["stop"][1] - k["stop"][1]) > 18 for k in kept):
            kept.append(s)
    for s in kept:
        sx, sy = s["stop"]
        e = nearest_edge(*(s["lead"] or s["stop"]), 220)
        if not e:
            continue
        d, a, b, t, qx, qy = e
        # split edge a-b at the projection
        kind = g.adj[a][b]
        j = g.node(("j", len(g.xy)), qx, qy)
        g.remove_edge(a, b)
        g.edge(a, j, kind)
        g.edge(j, b, kind)
        taxi_edges.remove((a, b)) if (a, b) in taxi_edges else None
        taxi_edges += [(min(a, j), max(a, j)), (min(j, b), max(j, b))]
        XY = np.array(g.xy)
        lead = s["lead"] or (qx, qy)
        hx, hy = sx - lead[0], sy - lead[1]
        if math.hypot(hx, hy) < 3:
            hx, hy = sx - qx, sy - qy
        L = math.hypot(hx, hy) or 1
        ln = g.node(("lead", len(g.xy)), lead[0], lead[1]) if s["lead"] else j
        if s["lead"]:
            g.edge(j, ln, 3)
        stands.append(dict(ref=s["ref"] or "", x=sx, y=sy, hx=hx / L, hy=hy / L, node=ln))

    # spacing -> max wingspan (nearest neighbour stop distance, roughly lateral)
    for s in stands:
        d = min((math.hypot(s["x"] - o["x"], s["y"] - o["y"]) for o in stands if o is not s), default=80)
        s["span"] = round(min(80.0, max(20.0, d * 1.02 - 2)), 1)
        best = min(ap["terminals"].items(), key=lambda kv: math.dist(geo.project(*kv[1]), (s["x"], s["y"])))
        dz = math.dist(geo.project(*best[1]), (s["x"], s["y"]))
        s["zone"] = best[0] if dz < 1100 else "remote"

    # keep the largest connected component
    comp = [-1] * len(g.xy)
    sizes = []
    for i in range(len(g.xy)):
        if comp[i] >= 0 or not g.adj[i]:
            continue
        c = len(sizes)
        st = [i]
        comp[i] = c
        n = 0
        while st:
            u = st.pop()
            n += 1
            for v in g.adj[u]:
                if comp[v] < 0:
                    comp[v] = c
                    st.append(v)
        sizes.append(n)
    main = int(np.argmax(sizes))
    keep = [i for i in range(len(g.xy)) if comp[i] == main]
    remap = {o: n for n, o in enumerate(keep)}
    stands = [s for s in stands if s["node"] in remap]
    for s in stands:
        s["node"] = remap[s["node"]]
    XY = np.array([g.xy[i] for i in keep])
    H_ = T.sample(XY[:, 0], XY[:, 1]).astype(float)
    edges = sorted({(min(remap[a], remap[b]), max(remap[a], remap[b]), k)
                    for a in keep for b, k in g.adj[a].items() if b in remap})
    rwset = {remap[i] for i in rw_nodes if i in remap}
    adj = defaultdict(list)
    for a, b, k in edges:
        adj[a].append((b, k))
        adj[b].append((a, k))

    # --- runway ends: centreline nodes, entry node for departures, exits for arrivals
    rwys = []
    for des, thr, oth in ends:
        u = (oth - thr) / np.linalg.norm(oth - thr)
        L = float(np.linalg.norm(oth - thr))
        on = []
        for i in rwset:
            p = XY[i] - thr
            along = float(p @ u)
            off = abs(float(p[0] * u[1] - p[1] * u[0]))
            if off < 40 and -30 < along < L + 30:
                on.append((along, i))
        on.sort()
        exits, entry = [], None
        for along, i in on:
            for j, k in adj[i]:
                if k == 2:
                    continue
                v = XY[j] - XY[i]
                ang = math.degrees(math.atan2(v[0] * u[1] - v[1] * u[0], v @ u))
                # ang: angle of taxiway leaving relative to landing direction (signed)
                if abs(ang) <= 120:
                    exits.append([i, round(along, 1), round(ang, 1)])
                if entry is None and along < 450:
                    entry = i
        if entry is None and on:
            entry = on[0][1]
        th = float(T.sample(np.array([thr[0]]), np.array([thr[1]]))[0])
        ho = float(T.sample(np.array([oth[0]]), np.array([oth[1]]))[0])
        hdg = (math.degrees(math.atan2(u[0], u[1])) + 360) % 360
        rwys.append(dict(des=des, thr=[round(float(thr[0]), 1), round(float(thr[1]), 1), round(th, 1)],
                         end=[round(float(oth[0]), 1), round(float(oth[1]), 1), round(ho, 1)],
                         hdg=round(hdg, 2), len=round(L, 1), entry=entry, exits=exits))
    cx, cy = geo.project(*ap["lonlat"])
    elev = float(T.sample(np.array([cx]), np.array([cy]))[0])
    print(f"  {icao}: {len(XY)} nodes, {len(edges)} edges, {len(stands)} stands, runways {[r['des'] for r in rwys]}")
    for r in rwys:
        print(f"     {r['des']}: hdg {r['hdg']:.0f} len {r['len']:.0f} entry {r['entry']} exits {len(r['exits'])}")
    return dict(
        icao=icao, iata=ap["iata"], name=ap["name"], pos=[round(cx, 1), round(cy, 1), round(elev, 1)],
        configs=ap["configs"], curfew=ap.get("curfew"),
        nodes=[[round(float(x), 1), round(float(y), 1), round(float(h), 1)] for (x, y), h in zip(XY, H_)],
        edges=[[a, b, k] for a, b, k in edges],
        runways=rwys,
        stands=[dict(ref=s["ref"], pos=[round(s["x"], 1), round(s["y"], 1)], hdg=[round(s["hx"], 4), round(s["hy"], 4)],
                     node=s["node"], span=s["span"], zone=s["zone"]) for s in stands],
    )


# ----------------------------------------------------------------------------- routes

def load_routes():
    places = {}
    for f in glob.glob(str(SD / "airports" / "schema-01" / "*" / "*.csv")):
        for r in csv.DictReader(open(f, encoding="utf-8-sig")):
            if r["ICAO"]:
                try:
                    places[r["ICAO"]] = (r["IATA"], r["Location"] or r["Name"], float(r["Latitude"]), float(r["Longitude"]), r["Name"])
                except ValueError:
                    pass
    names = {}
    for r in csv.DictReader(open(SD / "airlines" / "schema-01" / "airlines.csv", encoding="utf-8-sig")):
        if r["ICAO"]:
            names[r["ICAO"]] = (r["Name"], r["IATA"])
    legs = {k: {"arr": defaultdict(list), "dep": defaultdict(list)} for k in AIRPORTS}
    for f in glob.glob(str(SD / "routes" / "schema-01" / "*" / "*.csv")):
        for r in csv.DictReader(open(f, encoding="utf-8-sig")):
            codes = r["AirportCodes"].split("-")
            al = r["AirlineCode"]
            for i, c in enumerate(codes):
                if c not in legs:
                    continue
                if i > 0 and codes[i - 1] in places:
                    legs[c]["arr"][al].append((r["Callsign"], codes[i - 1]))
                if i < len(codes) - 1 and codes[i + 1] in places:
                    legs[c]["dep"][al].append((r["Callsign"], codes[i + 1]))
    return places, names, legs


# ----------------------------------------------------------------------------- schedule

def pick_type(fleet, dist, rng):
    for maxd, mix in fleet:
        if dist <= maxd:
            ks = list(mix)
            return rng.choices(ks, [mix[k] for k in ks])[0]
    return list(fleet[-1][1])[0]


def sample_time(weights, rng, curfew=None):
    for _ in range(200):
        h = rng.choices(range(24), weights)[0]
        s = h * 3600 + rng.random() * 3600
        hh = s / 3600
        if curfew and (hh >= curfew[0] or hh < curfew[1]):
            continue
        return s + (86400 if s < DAY0 else 0)
    return 12 * 3600.0


def airday(s):
    s %= 86400
    return s + 86400 if s < DAY0 else s


def in_night(s, night):
    if not night:
        return False
    h = (s % 86400) / 3600
    return night[0] <= h < night[1]


def build_schedule(icao, apdata, profile, places, legs, rng):
    ap = AIRPORTS[icao]
    alat, alon = ap["lonlat"][1], ap["lonlat"][0]
    curfew = ap.get("curfew")
    rots = []
    for al, (n0, fleet, zone, hub) in CARRIERS[icao].items():
        scale = CARGO_SCALE[profile] if al in CARGO_AIRLINES else LEISURE_SCALE[profile] if al in LEISURE else PROFILE_SCALE[profile]
        n = max(1, round(n0 * scale)) if n0 * scale >= 0.5 else 0
        deps = list(dict.fromkeys(legs["dep"].get(al, [])))
        arrs = list(dict.fromkeys(legs["arr"].get(al, [])))
        if not deps or not arrs:
            print(f"    ! {icao} {al}: no route legs")
            continue
        rng.shuffle(deps)
        if all(TYPES[t][1] == "wide" for _, mix in fleet for t in mix):
            far = [d for d in deps if gc(alat, alon, places[d[1]][2], places[d[1]][3])[0] > 3500]
            deps = far or deps
            far = [a for a in arrs if gc(alat, alon, places[a[1]][2], places[a[1]][3])[0] > 3500]
            arrs = far or arrs
        used_a: set = set()
        for i in range(n):
            dcs, dto = deps[i % len(deps)]
            if i >= len(deps):  # reuse flight numbers only when the DB runs out
                dcs = dcs  # same callsign flies twice (rare; e.g. shuttles)
            dd, db = gc(alat, alon, places[dto][2], places[dto][3])
            ty = pick_type(fleet, dd, rng)
            cls = TYPES[ty][1]
            # arrival leg: out-and-back for non-hub carriers, else any leg in range
            cand = [a for a in arrs if a not in used_a]
            if not cand:
                cand = arrs
            if not hub:
                same = [a for a in cand if a[1] == dto]
                if same:
                    cand = same
            if cls == "wide":
                far = [a for a in cand if gc(alat, alon, places[a[1]][2], places[a[1]][3])[0] > 3000]
                cand = far or cand
            elif cls in ("turboprop", "regional"):
                near = [a for a in cand if gc(alat, alon, places[a[1]][2], places[a[1]][3])[0] < (900 if cls == "turboprop" else 2600)]
                cand = near or cand
            else:
                mid = [a for a in cand if gc(alat, alon, places[a[1]][2], places[a[1]][3])[0] < 6500]
                cand = mid or cand
            # prefer the paired flight number (n-1 / n+1) when it exists
            try:
                num = int("".join(ch for ch in dcs[3:] if ch.isdigit()))
                pair = [a for a in cand if a[0][3:].isdigit() and abs(int(a[0][3:]) - num) == 1]
                if pair:
                    cand = pair
            except ValueError:
                pass
            acs, afrom = rng.choice(cand)
            used_a.add((acs, afrom))
            ad, ab = gc(alat, alon, places[afrom][2], places[afrom][3])
            ma = market(places[afrom][2], places[afrom][3], ad, ab, al)
            md = market(places[dto][2], places[dto][3], dd, db, al)
            if al == "CJT" and icao == "CYHM":
                ma = md = "cargohub"
            turn = MIN_TURN[cls] * 60
            ta = sample_time(H[ma][0], rng, curfew)
            wd = H[md][1]
            wmax = max(wd)
            td = None
            hh = (ta % 86400) / 3600
            if (hh >= 20 or hh < 3) and rng.random() < 0.75:
                # overnight: morning departure the next day
                for _ in range(100):
                    t = sample_time(wd, rng, curfew)
                    if (t % 86400) < 11 * 3600 and (t % 86400) >= 5 * 3600:
                        td = t
                        break
            if td is None:
                mean = {"turboprop": 20, "regional": 30, "narrow": 45, "wide": 80}[cls] * 60
                if al in CARGO_AIRLINES:
                    mean = 150 * 60
                for _ in range(200):
                    t = ta + turn + rng.expovariate(1 / mean)
                    h = int((t % 86400) // 3600)
                    if curfew and ((t % 86400) / 3600 >= curfew[0] or (t % 86400) / 3600 < curfew[1]):
                        continue
                    if rng.random() * wmax <= max(wd[h], wmax * 0.08):
                        td = airday(t)
                        break
            if td is None:
                td = airday(ta + turn)
            rots.append(dict(al=al, ty=ty, zone=zone, acs=acs, afrom=afrom, ta=ta, dcs=dcs, dto=dto, td=td, cls=cls))

    # --- runway streams + separation
    night = ap.get("night")
    streams = list(ap["configs"][0]["streams"])
    ev = []
    for r in rots:
        for kind in ("a", "d"):
            t = r["ta"] if kind == "a" else r["td"]
            if "M" in streams:
                s = "M"
            elif in_night(t, night):
                s = "N"
            elif kind == "d":
                s = "D1"
            else:
                _, b = gc(alat, alon, places[r["afrom"]][2], places[r["afrom"]][3])
                s = "A1" if (b >= 135 and b < 315) else "A2"
            r["s" + kind] = s
            ev.append((t, kind, r))
    by = defaultdict(list)
    for t, kind, r in ev:
        by[r["s" + kind]].append((t, kind, r))
    for s, lst in by.items():
        lst.sort(key=lambda e: e[0])
        last = -1e9
        lastk = None
        for t, kind, r in lst:
            sep = SEP["mixed"] if s in ("M", "N") else SEP["arr"] if kind == "a" else SEP["dep"]
            if lastk and lastk != kind:
                sep = SEP["mixed"]
            t2 = max(t, last + sep)
            r["t" + kind] = t2
            last, lastk = t2, kind

    # --- stands (circular day intervals)
    stands = apdata["stands"]
    occ_list = []
    P = np.array([s_["pos"] for s_ in stands])
    dist = np.hypot(P[:, None, 0] - P[None, :, 0], P[:, None, 1] - P[None, :, 1])
    tin, tout = ap["taxi_in"] * 60, ap["taxi_out"] * 60
    buf = 8 * 60
    miss = 0
    for r in sorted(rots, key=lambda r: r["ta"]):
        a = r["ta"] + tin
        b = r["td"] - tout - 5 * 60
        if r["td"] < r["ta"]:
            b += 86400
        if b < a:
            b = a + 10 * 60
        span = TYPES[r["ty"]][0]
        best = None
        for si, s in enumerate(stands):
            if span > 50 and s["span"] < 44:
                continue
            ok = True
            for (sj, x0, x1, sp2) in occ_list:
                d = dist[si][sj]
                if d > max(span, sp2) * 0.85:
                    continue
                for sh in (-86400, 0, 86400):
                    if a < x1 + sh + buf and x0 + sh < b + buf:
                        ok = False
                        break
                if not ok:
                    break
            if not ok:
                continue
            pen = max(0.0, s["span"] - span) * 0.1
            zone = r["zone"]
            if zone in ("T1", "T3"):
                pen += 0 if s["zone"] == zone else 25 if s["zone"] != "remote" else 40
            elif zone == "cargo":
                pen += 0 if s["zone"] == "remote" else 30
            else:
                pen += 0 if s["zone"] != "remote" else 10
            pen += rng.random() * 3
            if best is None or pen < best[0]:
                best = (pen, si)
        if best is None:
            miss += 1
            r["st"] = -1
            continue
        r["st"] = best[1]
        occ_list.append((best[1], a, b, span))

    rots = [r for r in rots if r["st"] >= 0]
    rots.sort(key=lambda r: r["ta"])
    print(f"    {icao} {profile}: {len(rots)} rotations = {2 * len(rots)} movements"
          f"{f' ({miss} dropped: no stand)' if miss else ''}")
    return rots


def main():
    rng = random.Random(20260929)
    T = terrain()
    print("air: OSM")
    osm = load_osm()
    aps = {k: build_airport(k, osm[k], T) for k in AIRPORTS}
    print("air: routes")
    places, names, legs = load_routes()
    OUT.mkdir(parents=True, exist_ok=True)
    used = set()
    scheds = {}
    for profile in ("weekday", "saturday", "sunday"):
        sched = {}
        for icao in AIRPORTS:
            rots = build_schedule(icao, aps[icao], profile, places, legs[icao], rng)
            types = sorted({r["ty"] for r in rots})
            airl = sorted({r["al"] for r in rots})
            for r in rots:
                used.add(r["afrom"])
                used.add(r["dto"])
            sched[icao] = dict(
                types=types, airlines=airl,
                rot=dict(
                    al=[airl.index(r["al"]) for r in rots], ty=[types.index(r["ty"]) for r in rots],
                    st=[r["st"] for r in rots],
                    acs=[r["acs"] for r in rots], afrom=[r["afrom"] for r in rots], ta=[round(r["ta"]) for r in rots],
                    sa=[r["sa"] for r in rots],
                    dcs=[r["dcs"] for r in rots], dto=[r["dto"] for r in rots], td=[round(r["td"]) for r in rots],
                    sd=[r["sd"] for r in rots],
                ),
            )
        scheds[profile] = sched
    allair = sorted({al for s in scheds.values() for a in s.values() for al in a["airlines"]})
    meta = dict(
        airlines={al: dict(name=names.get(al, (al, ""))[0], iata=names.get(al, ("", ""))[1]) for al in allair},
        places={p: dict(iata=places[p][0], city=places[p][1], name=places[p][4], lat=places[p][2], lon=places[p][3])
                for p in sorted(used)},
    )
    for profile, sched in scheds.items():
        doc = dict(version=1, profile=profile, synthetic_times=True, day_start=DAY0,
                   source="routes: vradarserver standing-data (CC0); times/volumes: modelled (docs/AIR.md)",
                   airports=sched)
        (OUT / f"schedule_{profile}.json").write_text(json.dumps(doc, separators=(",", ":")))
    (OUT / "airports.json").write_text(json.dumps(dict(version=1, airports=list(aps.values()), **meta), separators=(",", ":")))
    for f in sorted(OUT.iterdir()):
        print(f"  {f.name}: {f.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
