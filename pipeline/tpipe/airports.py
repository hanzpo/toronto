"""Handcrafted airport surfaces: clean runway rectangles, smoothed taxiways with
fillets, aprons, and the marking geometry drawn on them (docs/AIR.md).

OSM supplies *where* things are; the shapes are rebuilt the way an airport is
actually laid out instead of rasterising OSM lines into blocky pixels:

- runways: one rectangle per designator pair (all OSM pieces with the same ref,
  incl. `runway=displaced_threshold` pieces, merged along their principal axis),
  true width (curated Transport Canada / CFS values, else `width`, else a
  default by length), displaced thresholds + stopways. Markings are procedural
  (client shader) from per-vertex parameters.
- taxiways: OSM centrelines buffered to their width with round joins, plus a
  swept "fillet" ribbon for every turn between two arms of a junction (radius
  38 m, the same arc aircraft follow in app/src/air/track.ts), then a small
  morphological closing; aprons are cleaned (make_valid, hole/spike removal).
  Runway rectangles are cut out so nothing overlaps.
- markings (yellow): taxiway centrelines (filleted at bends, curved junction
  lead-ins), double edge lines where a taxiway is not bordered by apron/runway,
  runway holding position markings (OSM `aeroway=holding_position` where mapped,
  else computed at the TP 312 distance), stand lead-in lines + stop bars.
- lights: runway edge / threshold / end, taxiway edge (instanced at night).
- airside service roads: OSM roads lying on the aprons are listed in
  airside_roads.json (the road mesh skips them) and painted as apron service
  roads instead (white edges, dashed centre, zipper where aircraft cross).
- stands: lead-in lines, stop bars, red safety envelopes, stand numbers, GSE
  staged at the head of stand; OSM jet bridges (docked to the stand's door);
  apron floodlight masts.

Output: app/public/data/air/surfaces.bin.gz (TBN1, layout in docs/AIR.md).

    uv run python -m tpipe.airports        # after tpipe.air (reads airports.json for stands)
"""

from __future__ import annotations

import json
import math
import re
from collections import defaultdict

import mapbox_earcut as earcut
import numpy as np
import shapely
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Point, Polygon, box
from shapely.ops import linemerge, unary_union

from . import geo, tbn
from .air import AEROWAY_PBF, AIRPORTS, MAG_VAR, _ensure_aeroway_pbf
from .terrain import get as terrain

OUT = geo.OUT / "air" / "surfaces.bin.gz"

FILLET_R = 38.0  # centreline turn radius (m) == aircraft taxi fillet in air/track.ts
CELL = 64.0  # polygon triangulation grid (aligned with the terrain grid)
PAVED = {"asphalt", "concrete", "paved", "concrete:plates", "concrete:lanes", "asphalt;concrete", "concrete;asphalt"}
TURF = {"grass", "turf", "ground", "dirt", "gravel", "fine_gravel", "earth", "unpaved", "compacted", "sand"}

# --------------------------------------------------------------------------- curated reference data
# Runway widths / displaced thresholds where OSM is missing or wrong. Sources:
# Wikipedia airport articles (runway tables, from the Canada Flight Supplement),
# OurAirports runway pages (ourairports.com/airports/<ICAO>/runways.html, which
# mirror the CFS incl. displaced thresholds), PortsToronto RESA study (CYTZ).
# key: (icao, "A/B") -> width m, disp {designator: m}, fix: corrected ref
RUNWAY_REF: dict[tuple[str, str], dict] = {
    ("CYYZ", "05/23"): dict(width=61, disp={"05": 41, "23": 148}),
    ("CYYZ", "06L/24R"): dict(width=61, disp={"06L": 0, "24R": 60}),
    ("CYYZ", "06R/24L"): dict(width=61, disp={"06R": 0, "24L": 0}),
    ("CYYZ", "15L/33R"): dict(width=61, disp={"15L": 0, "33R": 0}),
    ("CYYZ", "15R/33L"): dict(width=61, disp={"15R": 179, "33L": 179}),
    ("CYTZ", "08/26"): dict(width=45.7, disp={"08": 0, "26": 0}),  # 3,988 x 150 ft, no displacement
    ("CYTZ", "06/24"): dict(width=30.5, disp={"06": 0, "24": 0}),  # 2,460 x 100 ft
    ("CYHM", "12/30"): dict(width=60, disp={"12": 488, "30": 0}),  # OSM says 10 m (wrong): 10,006 x 197 ft; thr 12 displaced 1,600 ft
    ("CYHM", "06/24"): dict(width=45.7, disp={}),  # OSM says 76 m (wrong): 6,010 x 150 ft
    ("CYKF", "08/26"): dict(width=45.7, disp={}),
    ("CYKF", "14/32"): dict(width=45.7, disp={}),
    ("CYOO", "12/30"): dict(width=30.5, disp={}),
    ("CYOO", "15/23"): dict(width=30.5, disp={}, fix="05/23"),  # OSM ref typo
    ("CYOO", "05/23"): dict(width=30.5, disp={}),
    ("CZBA", "14/32"): dict(width=23, disp={"14": 27, "32": 99}),
    ("CZBA", "09/27"): dict(width=15, disp={"09": 145, "27": 52}),
}
# OSM aerodromes without an icao tag that we know
ICAO_BY_NAME = {"Burlington Executive Airport": "CZBA", "Brampton-Caledon Airport": "CNC3",
                "Niagara Central Dorothy Rungeling Airport": "CNQ3", "Collingwood Regional Airport": "CNY3",
                "Guelph Airpark": "CNC4", "Markham Airfield": "CNU8", "Grimsby Regional Airport": "CGR4"}
TAXI_WIDTH = {"CYTZ": 18.0}  # default taxiway width override (m)

RE_REF = re.compile(r"^\s*(\d{1,2})\s*([LCR]?)\s*[/-]\s*(\d{1,2})\s*([LCR]?)")
SUF = {"": 0, "L": 1, "C": 2, "R": 3}


def _metres(s):
    if not s:
        return float("nan")
    s = s.strip().lower().replace(",", ".")
    m = re.match(r"^([\d.]+)\s*(m|ft|')?", s)
    if not m:
        return float("nan")
    try:
        v = float(m.group(1))
    except ValueError:
        return float("nan")
    return v * 0.3048 if m.group(2) in ("ft", "'") else v


# --------------------------------------------------------------------------- OSM

def load():
    import osmium

    _ensure_aeroway_pbf()
    wkb = osmium.geom.WKBFactory()
    F = defaultdict(list)

    def proj(g):
        return shapely.transform(g, lambda c: np.column_stack(geo.project(c[:, 0], c[:, 1])))

    for o in osmium.FileProcessor(str(AEROWAY_PBF)).with_locations().with_areas():
        a = o.tags.get("aeroway")
        if not a:
            continue
        t = o.type_str()
        tags = dict(o.tags)
        try:
            if t == "n":
                if a in ("holding_position", "parking_position", "aerodrome"):
                    x, y = geo.project(o.location.lon, o.location.lat)
                    F["n_" + a].append(dict(g=Point(x, y), tags=tags, id=o.id))
            elif t == "w":
                if a in ("runway", "taxiway", "taxilane", "parking_position", "stopway", "holding_position", "jet_bridge"):
                    ids = [n.ref for n in o.nodes]
                    g = proj(shapely.from_wkb(wkb.create_linestring(o)))
                    # keep node ids aligned with (deduplicated) coordinates
                    if len(ids) != len(g.coords):
                        continue
                    F["w_" + a].append(dict(g=g, ids=ids, tags=tags, id=o.id, closed=ids[0] == ids[-1]))
            elif t == "a":
                if a in ("apron", "aerodrome", "runway", "taxiway", "helipad", "terminal", "hangar"):
                    g = shapely.make_valid(proj(shapely.from_wkb(wkb.create_multipolygon(o))))
                    F["a_" + a].append(dict(g=g, tags=tags, id=o.id))
        except Exception:  # invalid / incomplete geometry
            continue
    return F


# --------------------------------------------------------------------------- grouping

def group_airports(F):
    """-> {key: dict(icao, name, poly, feats...)}; key = ICAO or osm-derived"""
    aps = []
    for a in F["a_aerodrome"]:
        tg = a["tags"]
        icao = tg.get("icao") or ICAO_BY_NAME.get(tg.get("name", ""))
        aps.append(dict(icao=icao, name=tg.get("name") or icao or f"aerodrome {a['id']}", poly=a["g"], id=a["id"]))
    nodes = [dict(icao=n["tags"].get("icao") or ICAO_BY_NAME.get(n["tags"].get("name", "")),
                  name=n["tags"].get("name"), pt=n["g"]) for n in F["n_aerodrome"]]
    tree = shapely.STRtree([a["poly"] for a in aps])

    def which(g):
        c = g.centroid if not isinstance(g, Point) else g
        hit = tree.query(c, predicate="intersects")
        if len(hit):
            return min(hit, key=lambda i: aps[i]["poly"].area)
        return None

    groups: dict = {}

    def get(key, **kw):
        if key not in groups:
            groups[key] = dict(key=key, rw=[], tw=[], ap=[], ta=[], hp=[], pp=[], ppn=[], hold=[], holdn=[], sw=[], rwa=[], bl=[],
                               jb=[], poly=None, **kw)
        return groups[key]

    def key_for(g, near_m=2500.0):
        i = which(g)
        if i is not None:
            a = aps[i]
            grp = get(a["icao"] or f"osm{a['id']}", icao=a["icao"], name=a["name"])
            grp["poly"] = grp["poly"] or a["poly"]
            return grp
        c = g.centroid
        best = min(nodes, key=lambda n: n["pt"].distance(c), default=None)
        if best and best["pt"].distance(c) < near_m:
            k = best["icao"] or best["name"] or f"n{int(best['pt'].x)}_{int(best['pt'].y)}"
            return get(k, icao=best["icao"], name=best["name"] or k)
        return None

    for w in F["w_runway"]:
        g = key_for(w["g"])
        if g is None:
            c = w["g"].centroid
            g = get(f"rw{w['id']}", icao=None, name=None)
            g["cx"] = (c.x, c.y)
        (g["rwa"] if w["closed"] and not RE_REF.match(w["tags"].get("ref", "") or "") else g["rw"]).append(w)
    for a in F["a_runway"]:
        g = key_for(a["g"])
        if g is not None:
            g["rwa"].append(dict(g=a["g"], tags=a["tags"], id=a["id"], closed=True, area=True))
    for kind, dst in (("w_taxiway", "tw"), ("w_taxilane", "tw"), ("a_apron", "ap"), ("a_taxiway", "ta"),
                      ("a_helipad", "hp"), ("w_parking_position", "pp"), ("n_parking_position", "ppn"),
                      ("w_holding_position", "hold"), ("n_holding_position", "holdn"), ("w_stopway", "sw"),
                      ("a_terminal", "bl"), ("a_hangar", "bl"), ("w_jet_bridge", "jb")):
        for f in F[kind]:
            g = key_for(f["g"], 3000.0)
            if g is not None:
                g[dst].append(f)
    return groups


# --------------------------------------------------------------------------- runways

def parse_ref(ref):
    m = RE_REF.match(ref or "")
    if not m:
        return None
    return (int(m.group(1)), m.group(2)), (int(m.group(3)), m.group(4))


def des_str(n, s):
    return f"{n:02d}{s}"


def build_runways(icao, ways):
    """merge OSM runway pieces by ref into rectangles"""
    by = defaultdict(list)
    anon = []
    for w in ways:
        ref = (w["tags"].get("ref") or "").replace(" ", "")
        fix = RUNWAY_REF.get((icao, ref), {}).get("fix")
        if fix:
            ref = fix
        if parse_ref(ref):
            key = "/".join(des_str(*d) for d in parse_ref(ref))
            by[key].append(w)
        else:
            anon.append(w)
    for w in anon:  # unnamed runway lines: merge with a named one if collinear & touching, else own
        by[f"?{w['id']}"].append(w)
    out = []
    for ref, pcs in by.items():
        P = np.vstack([np.asarray(p["g"].coords) for p in pcs])
        c = P.mean(0)
        _, _, vt = np.linalg.svd(P - c)
        d = vt[0]
        t = (P - c) @ d
        A, B = c + d * t.min(), c + d * t.max()
        L = float(t.max() - t.min())
        if L < 150:
            continue
        # orientation: end A is the threshold of the first designator (landing A -> B)
        hdg = (math.degrees(math.atan2(B[0] - A[0], B[1] - A[1])) + 360) % 360
        mag = (hdg - MAG_VAR) % 360
        pr = parse_ref(ref) if not ref.startswith("?") else None
        auto = max(1, round(mag / 10)) if round(mag / 10) else 36
        if pr is None:
            n0 = auto if auto <= 18 else auto - 18
            pr = ((n0, ""), (n0 + 18, ""))
        (n0, s0), (n1, s1) = pr
        if (n1 - n0) % 36 != 18:  # inconsistent pair: trust the one matching the axis
            def ok(n):
                return min(abs(n * 10 - mag) % 360, 360 - abs(n * 10 - mag) % 360) < 40 or \
                    min(abs(n * 10 - (mag + 180)) % 360, 360 - abs(n * 10 - (mag + 180)) % 360) < 40
            if ok(n0):
                n1 = (n0 + 18 - 1) % 36 + 1
            else:
                n0 = (n1 + 18 - 1) % 36 + 1
        diff = abs(((n0 * 10 - mag) + 180) % 360 - 180)
        if diff > 90:
            A, B = B, A
            d = -d
        u = (B - A) / L
        des = (des_str(n0, s0), des_str(n1, s1))
        key = f"{des[0]}/{des[1]}"
        tg = {}
        for p in sorted(pcs, key=lambda p: -p["g"].length):
            for k, v in p["tags"].items():
                tg.setdefault(k, v)
        surf = (tg.get("surface") or "").lower()
        cur = RUNWAY_REF.get((icao, key)) or RUNWAY_REF.get((icao, ref)) or {}
        closed = "closed" in (tg.get("ref") or "").lower() or tg.get("disused") == "yes"
        if surf in TURF:
            kind = 2
        elif surf in PAVED or cur or (surf == "" and not ref.startswith("?")):
            kind = 1 if "concrete" in surf else 0
        else:
            kind = 2 if surf else -1
        if kind < 0:
            continue  # unknown-surface anonymous CanVec strip: leave it to the grass raster
        w = cur.get("width") or _metres(tg.get("width"))
        default_w = 45 if L >= 1800 else 30 if L >= 1000 else 23 if L >= 700 else 18
        if not (w == w and 8 <= w <= 80) or (w > 1.6 * default_w + 10) or (L > 1500 and w < 20):
            w = default_w
        # displaced thresholds from OSM pieces at either end
        disp = [0.0, 0.0]
        longest = max(pcs, key=lambda p: p["g"].length)
        for p in pcs:
            if p["tags"].get("runway") == "displaced_threshold" and p is not longest and p["g"].length < 0.4 * L:
                q = np.asarray(p["g"].coords)
                s = (q - A) @ u
                if s.min() < 20:
                    disp[0] = max(disp[0], float(s.max()))
                elif s.max() > L - 20:
                    disp[1] = max(disp[1], float(L - s.min()))
        for i, dd in enumerate(des):
            if dd in cur.get("disp", {}):
                disp[i] = float(cur["disp"][dd])
        out.append(dict(des=des, A=A, B=B, u=u, L=L, w=float(w), hw=float(w) / 2, disp=disp, stop=[0.0, 0.0],
                        kind=kind, closed=closed, hdg=hdg))
    return out


def attach_stopways(rws, sws):
    for s in sws:
        q = np.asarray(s["g"].coords)
        for r in rws:
            v = (q - r["A"]) @ r["u"]
            off = np.abs((q - r["A"]) @ np.array([r["u"][1], -r["u"][0]]))
            if off.max() > r["hw"] + 10:
                continue
            if v.max() < 5 and v.min() > -400:
                r["stop"][0] = max(r["stop"][0], float(-v.min()))
            elif v.min() > r["L"] - 5 and v.max() < r["L"] + 400:
                r["stop"][1] = max(r["stop"][1], float(v.max() - r["L"]))


def rect(r, extra=0.0, lat=0.0):
    A, u = r["A"], r["u"]
    n = np.array([u[1], -u[0]])  # right of A->B
    a = A - u * (r["stop"][0] + extra)
    b = A + u * (r["L"] + r["stop"][1] + extra)
    h = r["hw"] + lat
    return Polygon([a + n * h, b + n * h, b - n * h, a - n * h])


def runway_area_rects(areas, rws):
    """clean OSM runway *areas* (no centreline mapped) -> runway dicts"""
    out = []
    for a in areas:
        g = a["g"] if a.get("area") else Polygon(a["g"].coords) if a["g"].is_ring else None
        if g is None or g.is_empty:
            continue
        if any(rect(r).intersects(g.centroid) for r in rws):
            continue
        mrr = g.minimum_rotated_rectangle
        xy = np.asarray(mrr.exterior.coords)[:4]
        e1, e2 = xy[1] - xy[0], xy[2] - xy[1]
        l1, l2 = np.linalg.norm(e1), np.linalg.norm(e2)
        L, W = max(l1, l2), min(l1, l2)
        if L < 300 or L / max(W, 1) < 8 or g.area / mrr.area < 0.75:
            continue  # blob (CanVec runway+taxiway+apron) or tiny: leave as grass
        tg = a["tags"]
        surf = (tg.get("surface") or "").lower()
        if surf not in PAVED:
            continue
        ax = e1 if l1 >= l2 else e2
        u = ax / np.linalg.norm(ax)
        c = np.asarray(mrr.centroid.coords[0])
        A, B = c - u * L / 2, c + u * L / 2
        hdg = (math.degrees(math.atan2(u[0], u[1])) + 360) % 360
        mag = (hdg - MAG_VAR) % 360
        n0 = round(mag / 10) or 36
        if n0 > 18:
            A, B, u, n0 = B, A, -u, n0 - 18
        out.append(dict(des=(des_str(n0, ""), des_str(n0 + 18, "")), A=A, B=B, u=u, L=L, w=W, hw=W / 2,
                        disp=[0.0, 0.0], stop=[0.0, 0.0], kind=0, closed=False, hdg=hdg))
    return out


# --------------------------------------------------------------------------- taxi network

class Net:
    """node graph of taxiway/taxilane (+ runway, for junction detection) ways"""

    def __init__(self):
        self.xy: dict[int, np.ndarray] = {}
        self.adj: dict[int, dict[int, tuple]] = defaultdict(dict)  # a -> b -> (kind, width)

    def add_way(self, ids, coords, kind, width):
        for i, (nid, p) in enumerate(zip(ids, coords)):
            self.xy.setdefault(nid, np.asarray(p, dtype=float))
            if i:
                a = ids[i - 1]
                if a != nid:
                    self.adj[a][nid] = (kind, width)
                    self.adj[nid][a] = (kind, width)

    def taxi_deg(self, n):
        return sum(1 for k, _ in self.adj[n].values() if k != "runway")

    def prune_stubs(self, keep_geom, min_len=35.0):
        """drop dead-end taxiway stubs shorter than min_len that end nowhere (not on apron/runway)"""
        changed = True
        while changed:
            changed = False
            for n in list(self.adj):
                if len(self.adj[n]) != 1:
                    continue
                if keep_geom is not None and keep_geom.distance(Point(self.xy[n])) < 3:
                    continue
                # walk to the next junction
                path = [n]
                prev, cur = None, n
                L = 0.0
                while True:
                    nb = [m for m in self.adj[cur] if m != prev]
                    if len(nb) != 1 or (len(self.adj[cur]) > 2 and cur != n):
                        break
                    nxt = nb[0]
                    L += float(np.linalg.norm(self.xy[nxt] - self.xy[cur]))
                    prev, cur = cur, nxt
                    path.append(cur)
                    if len(self.adj[cur]) != 2:
                        break
                if L < min_len and len(self.adj[cur]) >= 3:
                    if any(k == "runway" for k, _ in self.adj[path[0]].values()):
                        continue
                    for a, b in zip(path, path[1:]):
                        self.adj[a].pop(b, None)
                        self.adj[b].pop(a, None)
                    changed = True

    def chains(self):
        """maximal polylines between junctions (deg != 2) over taxi edges -> [(ids, kind, width)]"""
        seen = set()
        out = []
        taxi = {n: {m: kw for m, kw in nb.items() if kw[0] != "runway"} for n, nb in self.adj.items()}
        stops = {n for n in taxi if len(taxi[n]) != 2 or any(kw[0] == "runway" for kw in self.adj[n].values())}
        for s in list(taxi):
            for m in taxi[s]:
                if (s, m) in seen or (s not in stops and len(taxi[s]) == 2 and not self._loop_start(s, stops)):
                    continue
                path = [s, m]
                seen.add((s, m))
                seen.add((m, s))
                kind, width = taxi[s][m]
                while path[-1] not in stops:
                    cur = path[-1]
                    nxt = [q for q in taxi[cur] if q != path[-2]]
                    if not nxt or (cur, nxt[0]) in seen:
                        break
                    seen.add((cur, nxt[0]))
                    seen.add((nxt[0], cur))
                    path.append(nxt[0])
                    width = max(width, taxi[path[-2]][path[-1]][1])
                out.append((path, kind, width))
        return out

    def _loop_start(self, s, stops):
        return False


def fillet(pts, radius):
    """same corner rounding as filletPath() in app/src/air/track.ts"""
    if len(pts) < 3:
        return [np.asarray(p, float) for p in pts]
    out = [np.asarray(pts[0], float)]
    for i in range(1, len(pts) - 1):
        a, p, b = out[-1], np.asarray(pts[i], float), np.asarray(pts[i + 1], float)
        d1, d2 = p - a, b - p
        l1, l2 = np.linalg.norm(d1), np.linalg.norm(d2)
        if l1 < 0.5 or l2 < 0.5:
            if l1 >= 0.5:
                out.append(p)
            continue
        u1, u2 = d1 / l1, d2 / l2
        th = math.atan2(u1[0] * u2[1] - u1[1] * u2[0], float(u1 @ u2))
        ath = abs(th)
        if ath < math.radians(3):
            out.append(p)
            continue
        t = min(radius * math.tan(ath / 2), l1 * 0.48, l2 * 0.48)
        r = t / math.tan(ath / 2)
        s = p - u1 * t
        sg = 1 if th > 0 else -1
        c = np.array([s[0] - u1[1] * r * sg, s[1] + u1[0] * r * sg])
        a0 = math.atan2(s[1] - c[1], s[0] - c[0])
        steps = max(2, math.ceil(ath / math.radians(7)))
        for k in range(steps + 1):
            ang = a0 + th * k / steps
            out.append(c + np.array([math.cos(ang), math.sin(ang)]) * r)
    out.append(np.asarray(pts[-1], float))
    return out


# --------------------------------------------------------------------------- terrain drape

class Drape:
    """heights as the level-0 terrain mesh renders them (32 m grid, dm-quantised, bilinear)"""

    def __init__(self, T):
        self.T = T
        self.cache: dict = {}

    def __call__(self, x, y):
        x = np.asarray(x, float)
        y = np.asarray(y, float)
        g = 32.0
        i, j = np.floor(x / g), np.floor(y / g)
        fx, fy = x / g - i, y / g - j
        h = lambda ii, jj: np.round(self.T.sample(ii * g, jj * g) * 10) / 10  # noqa: E731
        h00, h10, h01, h11 = h(i, j), h(i + 1, j), h(i, j + 1), h(i + 1, j + 1)
        return (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy


# --------------------------------------------------------------------------- mesh builders

class Mesh:
    def __init__(self, nattr):
        self.pos: list = []
        self.attr: list = []
        self.idx: list = []
        self.n = 0
        self.nattr = nattr

    def add(self, xy, h, attr, tris):
        base = self.n
        self.pos.append(np.column_stack([xy[:, 0], h, xy[:, 1]]).astype(np.float64))
        self.attr.append(np.asarray(attr, np.float32).reshape(len(xy), self.nattr))
        self.idx.append(np.asarray(tris, np.int64).ravel() + base)
        self.n += len(xy)

    def arrays(self, origin):
        if not self.n:
            return np.zeros((0, 3), np.float32), np.zeros((0, self.nattr), np.float32), np.zeros(0, np.uint32)
        P = np.vstack(self.pos)
        P[:, 0] -= origin[0]
        P[:, 2] -= origin[1]
        P[:, 2] *= -1  # three: z = -N
        return P.astype(np.float32), np.vstack(self.attr), np.concatenate(self.idx).astype(np.uint32)


def polys_of(g):
    if g is None or g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    if isinstance(g, MultiPolygon):
        return list(g.geoms)
    if hasattr(g, "geoms"):
        return [p for q in g.geoms for p in polys_of(q)]
    return []


def lines_of(g):
    if g is None or g.is_empty:
        return []
    if isinstance(g, LineString):
        return [g]
    if hasattr(g, "geoms"):
        return [p for q in g.geoms for p in lines_of(q)]
    return []


def triangulate(poly):
    rings = [np.asarray(poly.exterior.coords)[:-1]] + [np.asarray(r.coords)[:-1] for r in poly.interiors]
    rings = [r for r in rings if len(r) >= 3]
    if not rings:
        return None, None
    V = np.vstack(rings)
    ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
    tri = earcut.triangulate_float64(V, ends)
    return V, np.asarray(tri, np.int64).reshape(-1, 3)


def add_polygon(mesh, geom, drape, surf):
    """clip to the CELL grid, triangulate, drape"""
    for poly in polys_of(geom):
        x0, y0, x1, y1 = poly.bounds
        i0, j0 = math.floor(x0 / CELL), math.floor(y0 / CELL)
        i1, j1 = math.floor(x1 / CELL), math.floor(y1 / CELL)
        boxes = [box(i * CELL, j * CELL, (i + 1) * CELL, (j + 1) * CELL)
                 for i in range(i0, i1 + 1) for j in range(j0, j1 + 1)]
        pieces = shapely.intersection(poly, np.array(boxes, dtype=object))
        for pc in pieces:
            for q in polys_of(pc):
                if q.area < 0.05:
                    continue
                V, T = triangulate(q)
                if V is None or not len(T):
                    continue
                mesh.add(V, drape(V[:, 0], V[:, 1]), np.full((len(V), 1), surf), T)


def fill_holes(g, amax):
    out = []
    for p in polys_of(g):
        out.append(Polygon(p.exterior, [r for r in p.interiors if Polygon(r).area > amax]))
    return unary_union(out) if out else Polygon()


def densify(xy, step):
    xy = np.asarray(xy, float)
    out = [xy[0]]
    for a, b in zip(xy[:-1], xy[1:]):
        L = np.linalg.norm(b - a)
        n = max(1, math.ceil(L / step))
        for k in range(1, n + 1):
            out.append(a + (b - a) * k / n)
    return np.array(out)


def add_ribbon(mesh, line_xy, drape, hw_geom, kind, line_hw, v0=0.0):
    """ribbon along a polyline; attr = (u across m, v along m, kind, line half-width)"""
    ls = LineString(line_xy)
    if len(line_xy) > 2:
        ls = ls.simplify(0.2)
    P = densify(np.asarray(ls.coords), 16.0)
    if len(P) < 2:
        return
    seg = np.diff(P, axis=0)
    sl = np.linalg.norm(seg, axis=1)
    keep = np.concatenate([[True], sl > 1e-3])
    P = P[keep]
    if len(P) < 2:
        return
    seg = np.diff(P, axis=0)
    sl = np.linalg.norm(seg, axis=1)
    t = seg / sl[:, None]
    tv = np.vstack([t[:1], t[:-1] + t[1:], t[-1:]])
    tv /= np.maximum(np.linalg.norm(tv, axis=1)[:, None], 1e-9)
    nrm = np.column_stack([tv[:, 1], -tv[:, 0]])  # right
    # miter length (bounded)
    cosh = np.ones(len(P))
    cosh[1:-1] = np.clip(np.einsum("ij,ij->i", tv[1:-1], t[:-1]), 0.5, 1)
    off = nrm * (hw_geom / cosh)[:, None]
    v = np.concatenate([[0], np.cumsum(sl)]) + v0
    V = np.empty((2 * len(P), 2))
    V[0::2] = P - off
    V[1::2] = P + off
    h = drape(P[:, 0], P[:, 1])
    H = np.repeat(h, 2)
    A = np.zeros((2 * len(P), 4))
    A[0::2, 0] = -hw_geom
    A[1::2, 0] = hw_geom
    A[:, 1] = np.repeat(v, 2)
    A[:, 2] = kind
    A[:, 3] = line_hw
    n = len(P) - 1
    k = np.arange(n) * 2
    T = np.column_stack([k, k + 1, k + 2, k + 1, k + 3, k + 2]).reshape(-1, 3)
    mesh.add(V, H, A, T)


# --------------------------------------------------------------------------- per airport

MK_CENTRE, MK_EDGE, MK_HOLD, MK_LEAD, MK_BAR, MK_SVC, MK_ZIP, MK_RED = 0, 1, 2, 3, 4, 5, 6, 7
BORDER = 16  # + kind: black border (yellow lines on light concrete, TP 312)
GSE_TUG, GSE_CART, GSE_BELT = 0, 1, 2
LT_EDGE, LT_THR, LT_END, LT_TAXI = 0, 1, 2, 3


def hold_distance(r):
    if r["w"] >= 44 and r["L"] >= 1800:
        return 90.0
    if r["w"] >= 29 or r["L"] >= 1200:
        return 75.0
    return 45.0


def build_group(g, drape, stands_json, roads=None):
    icao = g.get("icao")
    rws = build_runways(icao, g["rw"])
    rws += runway_area_rects(g["rwa"], rws)
    attach_stopways(rws, g["sw"])
    if not rws and not g["ap"]:
        return None
    paved_rws = [r for r in rws if r["kind"] != 2]
    maxw = max([r["w"] for r in paved_rws], default=23)
    tw_default = TAXI_WIDTH.get(icao) or (23.0 if maxw >= 44 else 15.0 if maxw >= 29 else 10.5)
    rw_rects = [rect(r) for r in rws]
    rw_union = unary_union(rw_rects) if rw_rects else Polygon()

    # ---- aprons (+ helipads, taxiway areas): clean outlines
    ap_polys = []
    for a in g["ap"] + g["hp"]:
        for p in polys_of(a["g"]):
            p = Polygon(p.exterior, [h for h in p.interiors if Polygon(h).area > 400])
            p = p.buffer(2.0, join_style="mitre").buffer(-4.0, join_style="mitre").buffer(2.0, join_style="mitre")
            p = p.simplify(0.6)
            if p.area > 150:
                ap_polys.append(p)
    aprons = unary_union(ap_polys) if ap_polys else Polygon()
    if not aprons.is_empty and g["bl"]:
        # aprons run right up to terminal / hangar facades: pave under buildings that
        # touch an apron and close the slivers between them (hidden under the building)
        near = [b["g"] for b in g["bl"] if b["g"].distance(aprons) < 15]
        if near:
            aprons = unary_union([aprons, *near]).buffer(10, join_style="mitre").buffer(-10, join_style="mitre")
    ta = unary_union([a["g"] for a in g["ta"]]) if g["ta"] else Polygon()

    # ---- taxi network
    net = Net()
    for w in g["tw"]:
        kind = w["tags"].get("aeroway")
        wd = _metres(w["tags"].get("width"))
        if not (wd == wd and 6 <= wd <= 60):
            wd = tw_default if kind == "taxiway" else min(tw_default, 15.0)
        net.add_way(w["ids"], list(w["g"].coords), kind, wd)
    for w in g["rw"]:
        net.add_way(w["ids"], list(w["g"].coords), "runway", 0.0)
    net.prune_stubs(unary_union([aprons, rw_union.buffer(5)]))

    centre_lines = []  # (xy, width, kind)
    for ids, kind, width in net.chains():
        pts = [net.xy[i] for i in ids]
        if len(pts) >= 2:
            centre_lines.append((np.array(fillet(pts, FILLET_R)), width, kind))
    # junction lead-in arcs between each pair of arms
    arcs = []
    for n, nb in net.adj.items():
        arms = [m for m in nb]
        if len(arms) < 3 and not (len(arms) == 2 and any(nb[m][0] == "runway" for m in arms)):
            continue
        p = net.xy[n]
        for i in range(len(arms)):
            for j in range(i + 1, len(arms)):
                ka, kb = nb[arms[i]], nb[arms[j]]
                if ka[0] == "runway" and kb[0] == "runway":
                    continue
                a, b = net.xy[arms[i]], net.xy[arms[j]]
                da, db = a - p, b - p
                la, lb = np.linalg.norm(da), np.linalg.norm(db)
                if la < 1 or lb < 1:
                    continue
                cosang = float(da @ db) / (la * lb)
                ang = math.degrees(math.acos(max(-1, min(1, cosang))))  # angle between arms
                if ang < 30 or ang > 158:
                    continue
                wd = max(ka[1], kb[1]) or tw_default
                arc = np.array(fillet([a, p, b], FILLET_R))
                if len(arc) > 3:
                    arcs.append((arc[1:-1], wd, "taxiway"))

    # ---- pavement: taxi ribbons + fillets + aprons + taxiway areas, closed, minus runways
    lines_all = [(LineString(xy), w, kind) for xy, w, kind in centre_lines + arcs if len(xy) >= 2]
    lines_all = [t for t in lines_all if t[0].length > 0.5]
    ribbons = [ln.buffer(w / 2, cap_style="flat", join_style="round", quad_segs=6) for ln, w, kind in lines_all]
    taxi = unary_union(ribbons + [ta]) if ribbons or not ta.is_empty else Polygon()
    taxi = taxi.buffer(4.0, quad_segs=6).buffer(-4.0, quad_segs=6)
    # aircraft corridors (for service-road zipper crossings)
    corridor = unary_union([ln.buffer(w / 2, cap_style="flat") for ln, w, kind in lines_all]) if lines_all else Polygon()

    # ---- airside service roads: roads lying on the aprons / taxi pavement are removed from
    # the road mesh (airside_roads.json) and drawn here as apron service-road markings
    svc = []  # (LineString, width, osm id)
    core = unary_union([taxi, aprons])
    if roads and g.get("poly") is not None and not core.is_empty:
        zone = core.buffer(3.0)
        poly = g["poly"].buffer(25)
        for rid, xy, wd in roads:
            ln = LineString(xy)
            if ln.length < 4 or not poly.intersects(ln) or ln.intersection(poly).length < 0.9 * ln.length:
                continue
            if ln.intersection(zone).length >= 0.35 * ln.length:
                svc.append((ln, float(min(max(wd, 6.0), 12.0)), rid))
    svc_pave = unary_union([ln.buffer(w / 2, cap_style="flat") for ln, w, _ in svc]) if svc else Polygon()

    # continuous pavement: close narrow gaps between aprons, taxiways, service roads and
    # terminals, and fill enclosed slivers (< 2500 m2; real grass islands are larger)
    pave = unary_union([taxi, aprons, svc_pave])
    pave = fill_holes(pave.buffer(8.0, quad_segs=4).buffer(-8.0, quad_segs=4), 2500)
    pave = pave.difference(rw_union).simplify(0.3)
    aprons_f = fill_holes(aprons.buffer(12.0, join_style="mitre").buffer(-12.0, join_style="mitre"), 2500) \
        if not aprons.is_empty else aprons
    apron_part = pave.intersection(aprons_f) if not aprons_f.is_empty else Polygon()
    taxi_part = pave.difference(aprons_f) if not aprons_f.is_empty else pave
    aprons = aprons_f
    apron_in = aprons_f.buffer(-0.6) if not aprons_f.is_empty else aprons_f
    # turf runways: nothing paved
    rw_paved = unary_union([rect(r) for r in paved_rws]) if paved_rws else Polygon()

    # ---- markings
    mk = Mesh(4)
    lights = []
    clip = rw_union.buffer(0.5)
    for ln, w, kind in lines_all:
        cl = ln.difference(clip)
        on = cl.intersection(apron_in) if not apron_in.is_empty else Polygon()
        off = cl.difference(apron_in) if not apron_in.is_empty else cl
        for part, border in ((off, 0), (on, BORDER)):
            for piece in lines_of(part):
                if piece.length > 2:
                    add_ribbon(mk, np.asarray(piece.coords), drape, 0.6, MK_CENTRE + border, 0.15)
    # apron service roads: white edge lines + dashed centreline; "zipper" edges where an
    # aircraft taxi route crosses (TP 312 / ICAO Annex 14 5.2.16 apron service road markings)
    airside_ids = []
    for ln, w, rid in svc:
        airside_ids.append(rid)
        cl = ln.difference(rw_union.buffer(1.0))
        zp = cl.intersection(corridor) if not corridor.is_empty else Polygon()
        nz = cl.difference(corridor) if not corridor.is_empty else cl
        for part, kind in ((nz, MK_SVC), (zp, MK_ZIP)):
            for piece in lines_of(part):
                if piece.length > 1.5:
                    add_ribbon(mk, np.asarray(piece.coords), drape, w / 2 + 0.4, kind, w / 2)
    # taxiway edge lines (double yellow) where the taxiway meets grass
    if not taxi_part.is_empty:
        inner = taxi_part.buffer(-0.9, join_style="mitre")
        edge = unary_union([ln for p in polys_of(inner) for ln in [p.exterior, *p.interiors]]) if not inner.is_empty else None
        if edge is not None and not edge.is_empty:
            edge = edge.difference(unary_union([aprons.buffer(3.0), rw_union.buffer(3.0), svc_pave.buffer(2.0)]))
            for piece in lines_of(linemerge(edge) if isinstance(edge, MultiLineString) else edge):
                if piece.length > 12:
                    xy = np.asarray(piece.simplify(0.4).coords)
                    add_ribbon(mk, xy, drape, 0.6, MK_EDGE, 0.1)
                    # blue edge lights every ~60 m
                    n = int(piece.length // 60)
                    for k in range(n):
                        q = piece.interpolate((k + 0.5) * piece.length / max(n, 1))
                        lights.append((q.x, q.y, LT_TAXI))
    # runway holding positions (TP 312 pattern A): a line parallel to the runway at the
    # holding distance, across the full taxiway pavement (fillets included) wherever a
    # taxiway centreline actually crosses it — one clean bar per entrance, never a
    # parallel taxiway that merely grazes the line
    taxi_lines = [LineString(xy) for xy, w, kind in centre_lines + arcs if kind == "taxiway" and len(xy) >= 2]
    for r in paved_rws:
        if r["closed"]:
            continue
        D = hold_distance(r)
        nrm = np.array([r["u"][1], -r["u"][0]])
        c = (r["A"] + r["B"]) / 2
        for side in (-1, 1):
            a = r["A"] - r["u"] * (r["stop"][0] + 40) + nrm * side * D
            b = r["B"] + r["u"] * (r["stop"][1] + 40) + nrm * side * D
            for sg in lines_of(LineString([a, b]).intersection(taxi_part)):
                if not 4 < sg.length < 140:
                    continue
                crossed = False
                for tl in taxi_lines:
                    if not tl.intersects(sg):
                        continue
                    q = tl.intersection(sg)
                    q = q if isinstance(q, Point) else q.centroid
                    d_ = tl.project(q)
                    p0, p1 = tl.interpolate(max(0, d_ - 4)), tl.interpolate(min(tl.length, d_ + 4))
                    t = np.array([p1.x - p0.x, p1.y - p0.y])
                    if np.linalg.norm(t) > 1e-6 and abs(float(t @ r["u"])) / np.linalg.norm(t) < 0.85:
                        crossed = True
                        break
                if not crossed or any(rr.buffer(3).intersects(sg) for rr in rw_rects):
                    continue
                xy = np.asarray(sg.coords)[[0, -1]]
                d = xy[1] - xy[0]
                if d[0] * (c - xy[0])[1] - d[1] * (c - xy[0])[0] < 0:  # runway must lie to the left
                    xy = xy[::-1]
                add_ribbon(mk, xy, drape, 1.4, MK_HOLD, 0.15)
    # stands: lead-in line, stop bar, stand safety envelope (red), stand number, GSE
    labels, gse, bridges, masts = [], [], [], []
    bld = unary_union([b["g"] for b in g["bl"]]) if g["bl"] else Polygon()
    free = lambda q: not bld.contains(Point(q)) and apron_in.contains(Point(q))  # noqa: E731
    for si, s in enumerate(stands_json or []):
        p = np.array(s["pos"], float)
        lead = np.array(s["lead"], float)
        hd = np.array(s["hdg"], float)
        rt = np.array([hd[1], -hd[0]])  # right of the nose direction
        bd = BORDER if apron_in.contains(Point(p)) else 0
        if np.linalg.norm(p - lead) > 2:
            add_ribbon(mk, np.array([lead, p]), drape, 0.6, MK_LEAD + bd, 0.15)
        add_ribbon(mk, np.array([p - rt * 2.5, p + rt * 2.5]), drape, 0.8, MK_BAR + bd, 0.3)
        span = float(s["span"])
        if span < 22:
            continue
        Lac = span * 1.05
        half = span / 2
        fl, fr = p + hd * 3 - rt * half, p + hd * 3 + rt * half
        bl_, br = p - hd * (Lac + 3) - rt * half, p - hd * (Lac + 3) + rt * half
        add_ribbon(mk, np.array([fl, bl_, br, fr, fl]), drape, 0.45, MK_RED, 0.1)
        if s.get("ref"):
            q = lead + (p - lead) / max(np.linalg.norm(p - lead), 1e-6) * 6 if np.linalg.norm(p - lead) > 12 else p - hd * (Lac + 8)
            labels.append((s["ref"], q[0], q[1], math.atan2(hd[0], hd[1])))
        # ground support equipment staged at the head of stand (outside the envelope)
        head = p + hd * 8
        for k, (off_r, ang_r, kind) in enumerate(((0.3, 0, GSE_TUG), (-0.05, 0, GSE_CART), (-0.2, 0, GSE_CART),
                                                  (-0.35, 0, GSE_CART), (0.42, 1, GSE_BELT))):
            q = head + rt * (off_r * span) + (hd * 3 if kind == GSE_BELT else 0)
            if free(q):
                ang = math.atan2(rt[1], rt[0]) if ang_r == 0 else math.atan2(-hd[1], -hd[0])
                gse.append((q[0], q[1], ang, kind))
    if stands_json is None:
        for pp in g["pp"]:
            xy = np.asarray(pp["g"].coords)
            if LineString(xy).length > 5:
                add_ribbon(mk, np.array(fillet(xy, 15.0)), drape, 0.6, MK_LEAD + BORDER, 0.15)
    # jet bridges (OSM aeroway=jet_bridge): rotunda at the terminal end; the cab docks at
    # the forward left door of the aircraft on the matched stand
    st = stands_json or []
    for jb in g["jb"]:
        xy = np.asarray(jb["g"].coords)
        e0, e1 = xy[0], xy[-1]
        best = None
        for si, s in enumerate(st):
            p = np.array(s["pos"], float)
            for rot, cab in ((e0, e1), (e1, e0)):
                d = float(np.linalg.norm(cab - p))
                if d < 45 and (best is None or d < best[0]):
                    best = (d, si, rot, cab)
        if best:
            _, si, rot, cab = best
            s = st[si]
            p, hd = np.array(s["pos"], float), np.array(s["hdg"], float)
            lf = np.array([-hd[1], hd[0]])
            wide = s["span"] >= 42
            door = p - hd * (8.5 if wide else 5.0) + lf * (3.6 if wide else 2.6)
            if 8 < np.linalg.norm(door - rot) < 50:
                cab = door
        else:
            si, rot, cab = -1, e0, e1
            if np.linalg.norm(e1 - e0) < 6:
                continue
        bridges.append((rot[0], rot[1], cab[0], cab[1], si, 5.2 if (best and st[si]["span"] >= 42) else 4.2))
    # apron floodlight masts along the apron edge, clear of taxi routes and buildings
    if not apron_part.is_empty and apron_part.area > 30000:
        keep_out = unary_union([corridor.buffer(12), bld.buffer(8), rw_union.buffer(60)])
        for poly in polys_of(apron_part):
            ring = poly.buffer(-5).exterior if not poly.buffer(-5).is_empty and isinstance(poly.buffer(-5), Polygon) else None
            if ring is None or ring.length < 200:
                continue
            for k in range(int(ring.length // 160)):
                q = ring.interpolate((k + 0.5) * ring.length / max(1, int(ring.length // 160)))
                if keep_out.contains(q) or any(math.hypot(q.x - m[0], q.y - m[1]) < 90 for m in masts):
                    continue
                masts.append((q.x, q.y))

    # ---- runway mesh + lights
    rwm = Mesh(12)
    for r in rws:
        A, u, L, hw = r["A"], r["u"], r["L"], r["hw"]
        nrm = np.array([u[1], -u[0]])
        v0, v1 = -r["stop"][0], L + r["stop"][1]
        nv = max(2, math.ceil((v1 - v0) / 30.0) + 1)
        vs = np.linspace(v0, v1, nv)
        us = np.array([-hw, -hw / 2, 0, hw / 2, hw])
        VV, UU = np.meshgrid(vs, us, indexing="ij")
        XY = A + VV.reshape(-1, 1) * u + UU.reshape(-1, 1) * nrm
        H = drape(XY[:, 0], XY[:, 1])
        nu = len(us)
        tris = []
        for i in range(nv - 1):
            for j in range(nu - 1):
                a = i * nu + j
                tris += [a, a + 1, a + nu, a + 1, a + nu + 1, a + nu]  # CCW seen from above (three: z = -N)
        (n0, s0), (n1, s1) = [(int(d[:2]), d[2:]) for d in r["des"]]
        code = lambda n, s: n * 4 + SUF.get(s, 0)  # noqa: E731
        flags = (1 if r["closed"] else 0)
        attr = np.zeros((len(XY), 12))
        attr[:, 0] = UU.ravel()
        attr[:, 1] = VV.ravel()
        attr[:, 2] = hw
        attr[:, 3] = L
        attr[:, 4:8] = [r["disp"][0], r["disp"][1], r["stop"][0], r["stop"][1]]
        attr[:, 8:12] = [code(n0, s0), code(n1, s1), r["kind"], flags]
        rwm.add(XY, H, attr, np.array(tris).reshape(-1, 3))
        if r["kind"] == 2 or r["closed"]:
            continue
        # edge lights every 60 m, threshold (green) + end (red) bars
        n = max(2, int(L // 60))
        for k in range(n + 1):
            v = L * k / n
            for sgn in (-1, 1):
                q = A + u * v + nrm * sgn * (hw + 1.5)
                lights.append((q[0], q[1], LT_EDGE))
        for end, v in ((0, r["disp"][0]), (1, L - r["disp"][1])):
            m = max(4, int(r["w"] / 3.5))
            for k in range(m + 1):
                q = A + u * v + nrm * (-hw + 2 * hw * k / m)
                lights.append((q[0], q[1], LT_THR))
            ve = 0.0 if end == 1 else L  # runway end lights (red) at the far end
            for k in range(m + 1):
                q = A + u * (ve + (1.0 if end == 0 else -1.0)) + nrm * (-hw + 2 * hw * k / m)
                lights.append((q[0], q[1], LT_END))

    # ---- pavement mesh: 0 taxiway asphalt, 1 apron concrete, 2 grass underlay
    pv = Mesh(1)
    add_polygon(pv, taxi_part, drape, 0)
    add_polygon(pv, apron_part, drape, 1)

    # origin: 64 m aligned (keeps world-periodic texture phases)
    allg = unary_union([pave, rw_union]) if not pave.is_empty or not rw_union.is_empty else None
    if allg is None or allg.is_empty:
        return None
    b = allg.bounds
    origin = (math.floor((b[0] + b[2]) / 2 / 64) * 64, math.floor((b[1] + b[3]) / 2 / 64) * 64)
    return dict(origin=origin, bbox=[round(v, 1) for v in b], rw=rwm, pv=pv, mk=mk, lights=lights,
                labels=labels, gse=gse, bridges=bridges, masts=masts, airside=airside_ids,
                runways=[dict(des="/".join(r["des"]), len=round(r["L"]), width=round(r["w"], 1),
                              disp=[round(d) for d in r["disp"]], kind=r["kind"]) for r in rws])


# --------------------------------------------------------------------------- main

def stands_for(icao, air):
    ap = air.get(icao)
    if not ap:
        return None
    out = []
    for s in ap["stands"]:
        nd = ap["nodes"][s["node"]]
        out.append(dict(pos=s["pos"], hdg=s["hdg"], lead=nd[:2], span=s["span"], ref=s["ref"]))
    return out


def load_roads(groups):
    """drivable roads (service / unclassified, not tunnels) near the aerodromes -> per group lists"""
    d = np.load(geo.WORK / "osm_lines.npz", allow_pickle=True)
    off = np.concatenate([[0], np.cumsum(d["len"].astype(np.int64))])
    kind, cls, fl = d["kind"], d["cls"], d["flags"]
    sel = np.nonzero((kind == 0) & np.isin(cls, [5, 6]) & ((fl & 4) == 0))[0]
    # NpzFile members decompress on every access: read each array once
    xy, ids, width = d["xy"], d["id"], d["width"]
    first = xy[off[sel]]
    out = {}
    for key, g in groups.items():
        if g.get("poly") is None or not g["ap"]:
            continue
        x0, y0, x1, y1 = g["poly"].bounds
        m = (first[:, 0] > x0 - 300) & (first[:, 0] < x1 + 300) & (first[:, 1] > y0 - 300) & (first[:, 1] < y1 + 300)
        out[key] = [(int(ids[i]), xy[off[i]:off[i + 1]], float(width[i])) for i in sel[m]]
    return out


def main():
    T = terrain()
    drape = Drape(T)
    print("airports: OSM")
    F = load()
    groups = group_airports(F)
    roads = load_roads(groups)
    airside = []
    try:
        airj = json.loads((geo.OUT / "air" / "airports.json").read_text())
        air = {a["icao"]: a for a in airj["airports"]}
    except FileNotFoundError:
        air = {}
    arrays = defaultdict(list)
    cnt = defaultdict(int)
    meta = []
    for key, g in sorted(groups.items(), key=lambda kv: str(kv[0])):
        try:
            res = build_group(g, drape, stands_for(g.get("icao"), air), roads.get(key))
        except Exception as e:  # keep going: one broken aerodrome shouldn't sink the region
            print(f"  ! {key}: {e}")
            continue
        if res is None:
            continue
        m = dict(key=key, icao=g.get("icao"), name=g.get("name"), origin=res["origin"], bbox=res["bbox"],
                 runways=res["runways"])
        for tag, mesh in (("rw", res["rw"]), ("pv", res["pv"]), ("mk", res["mk"])):
            P, A, I = mesh.arrays(res["origin"])
            m[tag] = [cnt[tag + "_v"], len(P), cnt[tag + "_i"], len(I)]
            arrays[tag + "_pos"].append(P.ravel())
            arrays[tag + "_attr"].append(A.ravel() if tag != "pv" else A.ravel().astype(np.uint8))
            arrays[tag + "_idx"].append(I)
            cnt[tag + "_v"] += len(P)
            cnt[tag + "_i"] += len(I)
        L = np.array(res["lights"], float).reshape(-1, 3)
        if len(L):
            h = drape(L[:, 0], L[:, 1]) + 0.35
            m["lt"] = [cnt["lt"], len(L)]
            arrays["lt_pos"].append(np.column_stack([L[:, 0] - res["origin"][0], h, -(L[:, 1] - res["origin"][1])]).astype(np.float32).ravel())
            arrays["lt_kind"].append(L[:, 2].astype(np.uint8))
            cnt["lt"] += len(L)
        else:
            m["lt"] = [cnt["lt"], 0]
        ox, oy = res["origin"]

        def put(name, rows, cols):
            rows = np.array(rows, float).reshape(-1, cols)
            m[name] = [cnt[name], len(rows)]
            cnt[name] += len(rows)
            return rows

        # jet bridges: rotunda (x, ground h, z), cab end (x, z), stand index, floor height
        J = put("jb", res["bridges"], 6)
        if len(J):
            arrays["jb"].append(np.column_stack([J[:, 0] - ox, drape(J[:, 0], J[:, 1]), -(J[:, 1] - oy), J[:, 2] - ox,
                                                 -(J[:, 3] - oy), J[:, 4], J[:, 5], drape(J[:, 2], J[:, 3])]).astype(np.float32).ravel())
        G_ = put("gse", res["gse"], 4)
        if len(G_):
            arrays["gse"].append(np.column_stack([G_[:, 0] - ox, drape(G_[:, 0], G_[:, 1]), -(G_[:, 1] - oy), G_[:, 2], G_[:, 3]]).astype(np.float32).ravel())
        M_ = put("mast", res["masts"], 2)
        if len(M_):
            arrays["mast"].append(np.column_stack([M_[:, 0] - ox, drape(M_[:, 0], M_[:, 1]), -(M_[:, 1] - oy)]).astype(np.float32).ravel())
        m["labels"] = [[ref, round(x - ox, 2), round(float(drape(np.array([x]), np.array([y]))[0]), 2), round(-(y - oy), 2), round(a, 4)]
                       for ref, x, y, a in res["labels"]]
        airside += res["airside"]
        meta.append(m)
        rs = ", ".join(f"{r['des']} {r['len']}x{r['width']}" + (f" disp{r['disp']}" if any(r["disp"]) else "") +
                       (" turf" if r["kind"] == 2 else "") for r in res["runways"])
        print(f"  {key:>10} {g.get('name') or '':<45.45} rw {m['rw'][3] // 3:>5} pv {m['pv'][3] // 3:>6} "
              f"mk {m['mk'][3] // 3:>6} lt {m['lt'][1]:>5}  {rs}")
    out = {k: np.concatenate(v) if v else np.zeros(0, np.float32) for k, v in arrays.items()}
    for k in ("rw_pos", "rw_attr", "pv_pos", "mk_pos", "mk_attr", "lt_pos", "jb", "gse", "mast"):
        out.setdefault(k, np.zeros(0, np.float32))
        out[k] = out[k].astype(np.float32)
    out["pv_attr"] = out["pv_attr"].astype(np.uint8)
    out["lt_kind"] = out.get("lt_kind", np.zeros(0, np.uint8)).astype(np.uint8)
    n = tbn.write(OUT, out, version=2, airports=meta)
    ids = sorted(set(airside))
    (OUT.parent / "airside_roads.json").write_text(json.dumps(ids))
    print(f"  airside_roads.json: {len(ids)} OSM road ways painted as apron service roads (road mesh skips them)")
    print(f"  {OUT.name}: {n / 1024:.0f} KB, {len(meta)} airports")


if __name__ == "__main__":
    main()
