"""Curated rail stations (TTC subway/LRT, GO, UP, VIA).

    uv run python -m tpipe.stations seed    # (re)seed pipeline/curated/stations.json from OSM
    uv run python -m tpipe.stations build   # curated → app/public/data/stations.json

`seed` groups the transit index's rail stations into physical station
complexes and pre-fills, per complex and mode, the platform layout (island /
side, count, length, width, orientation) from OSM platform ways and the
adjacent tracks, the grade (underground / at-grade / elevated) from the track
tags, entrances from `railway=subway_entrance|train_station_entrance` and
station `entrance=*` nodes, station buildings, bus terminals and GO parking.
Entries marked `"reviewed": true` in an existing curated file are kept
verbatim, so hand fixes survive a re-seed. The curated file is the source of
truth; see docs/STATIONS.md for the schema, the conventions and the sources
used per station.

`build` validates the curated file, projects every lat/lon to world E/N (see
docs/SPEC.md) and writes the compact runtime file read by
app/src/layers/StationsLayer.ts.
"""

from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

import numpy as np

from . import geo

CURATED = geo.PIPE / "curated" / "stations.json"
OSM_EXTRACT = geo.WORK / "stations" / "stn.osm.pbf"
INDEX = geo.OUT / "transit" / "index.json"

RAIL_MODES = ("subway", "lrt", "commuter_rail", "airport_rail", "intercity_rail")
HEAVY = ("commuter_rail", "airport_rail", "intercity_rail")
# transit_rail.npz track kinds per station mode
MODE_KIND = {"subway": (1,), "lrt": (2, 1), "commuter_rail": (0,), "airport_rail": (0,), "intercity_rail": (0,)}
DEFAULTS = {
    #               length width  platform height above rail
    "subway": dict(length=152.0, width=4.0, island_width=8.5, height=1.05),
    "lrt": dict(length=90.0, width=3.5, island_width=6.0, height=0.35),
    "commuter_rail": dict(length=310.0, width=5.0, island_width=8.0, height=0.8),
    "airport_rail": dict(length=100.0, width=5.0, island_width=8.0, height=1.05),
    "intercity_rail": dict(length=250.0, width=4.0, island_width=8.0, height=0.8),
}
SEARCH = {"subway": 260.0, "lrt": 160.0, "commuter_rail": 450.0, "airport_rail": 300.0, "intercity_rail": 450.0}

# index names that belong to the same physical complex but don't normalise alike
ALIAS = {
    "via:Toronto": "Union",
    "ttc:Bloor Station": "Bloor-Yonge",
    "ttc:Yonge Station": "Bloor-Yonge",
    "via:Niagara Falls Station": "Niagara Falls",
    "via:Oshawa": "Durham College Oshawa",
    "via:Guelph": "Guelph Central",
    "via:Brampton": "Brampton Innovation District",
    "via:St. Catharines": "St. Catharines",
    "up:UP Express Pearson Airport": "Pearson Airport",
    "ttc:York University": "York University",
}


def norm_name(sid: str, name: str) -> str:
    if sid in ALIAS:
        return ALIAS[sid]
    s = name
    s = re.sub(r"^UP Express\s+", "", s, flags=re.I)
    s = re.sub(r"\s*-\s*Subway$", "", s, flags=re.I)
    s = re.sub(r"\s+GO/UP$", "", s)
    s = re.sub(r"\s+GO Centre$", "", s)
    s = re.sub(r"\s+(GO|UP)(\s+Station)?$", "", s)
    s = re.sub(r"\s+(Station|Stn)$", "", s, flags=re.I)
    s = re.sub(r"\s+GO$", "", s)
    return s.strip()


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def ll(e: float, n: float) -> list[float]:
    lon, lat = geo.unproject(e, n)
    return [round(float(lat), 6), round(float(lon), 6)]


def en(lat: float, lon: float) -> tuple[float, float]:
    x, y = geo.project(lon, lat)
    return float(x), float(y)


# ---------------------------------------------------------------------------- OSM


def load_osm() -> dict:
    import osmium

    ents, plats, stns, blds, parks, buses = [], [], [], [], [], []
    fp = osmium.FileProcessor(str(OSM_EXTRACT)).with_locations().with_areas()
    for o in fp:
        t = dict(o.tags)
        if o.is_node():
            if not o.location.valid():
                continue
            rw = t.get("railway")
            if rw in ("subway_entrance", "train_station_entrance") or (
                "entrance" in t and (rw or t.get("public_transport") or "subway" in t or "train" in t)
            ):
                ents.append(dict(id=o.id, lon=o.location.lon, lat=o.location.lat, tags=t))
            elif t.get("public_transport") == "station" or rw in ("station", "halt"):
                stns.append(dict(id=o.id, lon=o.location.lon, lat=o.location.lat, tags=t))
            elif "entrance" in t:
                ents.append(dict(id=o.id, lon=o.location.lon, lat=o.location.lat, tags=t, generic=True))
            continue
        if o.is_way():
            if t.get("railway") == "platform" or (
                t.get("public_transport") == "platform" and t.get("highway") != "platform" and t.get("bus") != "yes"
            ):
                pts = [(n.lon, n.lat) for n in o.nodes if n.location.valid()]
                if len(pts) >= 2:
                    plats.append(dict(id=o.id, pts=pts, tags=t, closed=o.is_closed()))
            continue
        if o.is_area():
            ring = None
            for outer in o.outer_rings():
                pts = [(n.lon, n.lat) for n in outer if n.location.valid()]
                if ring is None or len(pts) > len(ring):
                    ring = pts
            if not ring or len(ring) < 3:
                continue
            rec = dict(id=o.orig_id(), pts=ring, tags=t)
            if t.get("building") in ("train_station", "transportation") or (
                t.get("building") and (t.get("railway") == "station" or t.get("public_transport") == "station")
            ):
                blds.append(rec)
            if t.get("amenity") == "parking":
                parks.append(rec)
            if t.get("amenity") == "bus_station":
                buses.append(rec)
            if t.get("railway") == "platform" and not t.get("building") and not o.from_way():
                plats.append(dict(id=o.orig_id(), pts=ring, tags=t, closed=True))
    out = {}
    for k, v in dict(ents=ents, plats=plats, stns=stns, blds=blds, parks=parks, buses=buses).items():
        for r in v:
            if "pts" in r:
                a = np.array(r["pts"])
                x, y = geo.project(a[:, 0], a[:, 1])
                r["xy"] = np.stack([x, y], 1)
            else:
                r["e"], r["n"] = en(r["lat"], r["lon"])
        out[k] = v
    print({k: len(v) for k, v in out.items()})
    return out


class Tracks:
    """Segment index over transit_rail.npz (OSM rail ways, projected)."""

    def __init__(self) -> None:
        d = np.load(geo.WORK / "transit_rail.npz")
        xy, off, kind, flags, service = d["xy"], d["off"], d["kind"], d["flags"], d["service"]
        a, b, k, f, s = [], [], [], [], []
        for w in range(len(kind)):
            i0, i1 = off[w], off[w + 1]
            for i in range(i0, i1 - 1):
                a.append(i)
                b.append(i + 1)
                k.append(kind[w])
                f.append(flags[w])
                s.append(service[w])
        self.a = xy[np.array(a)]
        self.b = xy[np.array(b)]
        self.kind = np.array(k)
        self.flags = np.array(f)
        self.service = np.array(s)
        self.mid = (self.a + self.b) / 2

    def near(self, e: float, n: float, r: float, kinds) -> np.ndarray:
        m = (np.abs(self.mid[:, 0] - e) < r + 60) & (np.abs(self.mid[:, 1] - n) < r + 60) & np.isin(self.kind, kinds)
        idx = np.nonzero(m)[0]
        if not len(idx):
            return idx
        d = self.dist(idx, e, n)
        return idx[d < r]

    def dist(self, idx, e, n):
        a, b = self.a[idx], self.b[idx]
        ab = b - a
        L2 = (ab**2).sum(1)
        t = np.clip(((e - a[:, 0]) * ab[:, 0] + (n - a[:, 1]) * ab[:, 1]) / np.maximum(L2, 1e-9), 0, 1)
        px, py = a[:, 0] + ab[:, 0] * t, a[:, 1] + ab[:, 1] * t
        return np.hypot(px - e, py - n)

    def offsets(self, e, n, ux, uy, r, kinds, maxang=25.0):
        """signed lateral offsets (left of axis u = +) of parallel tracks near (e, n)"""
        idx = self.near(e, n, r, kinds)
        out = []
        for i in idx:
            a, b = self.a[i], self.b[i]
            dx, dy = b - a
            L = math.hypot(dx, dy)
            if L < 0.5:
                continue
            c = abs((dx * ux + dy * uy) / L)
            if c < math.cos(math.radians(maxang)):
                continue
            # lateral offset of the segment's line at the query point
            nx, ny = -uy, ux
            t = np.clip(((e - a[0]) * dx + (n - a[1]) * dy) / (L * L), 0, 1)
            px, py = a[0] + dx * t, a[1] + dy * t
            along = (px - e) * ux + (py - n) * uy
            if abs(along) > 40:
                continue
            out.append(((px - e) * nx + (py - n) * ny, int(self.flags[i]), int(self.service[i])))
        out.sort()
        merged = []
        for o in out:
            if merged and abs(o[0] - merged[-1][0]) < 1.2:
                continue
            merged.append(o)
        return merged


class Buildings:
    """OSM building outer rings near the stations (work/osm_buildings.npz)."""

    def __init__(self, centres, r: float) -> None:
        d = np.load(geo.WORK / "osm_buildings.npz", allow_pickle=True)
        xy, nring, ringlen = d["xy"], d["nring"], d["ringlen"]
        from scipy.spatial import cKDTree

        z = np.zeros(1, np.int64)
        roff = np.concatenate([z, np.cumsum(ringlen.astype(np.int64))])
        first_ring = np.concatenate([z, np.cumsum(nring.astype(np.int64))])[:-1]
        v0 = roff[first_ring]
        v1 = roff[first_ring + 1]
        dist, _ = cKDTree(np.array(centres)).query(xy[v0])
        self.rings = [xy[v0[i]:v1[i]] for i in np.nonzero(dist < r)[0]]
        self.bb = np.array([[q[:, 0].min(), q[:, 1].min(), q[:, 0].max(), q[:, 1].max()] for q in self.rings])

    def distance(self, e: float, n: float) -> float:
        """0 inside a building, else distance to the nearest outline (capped at 50 m)"""
        m = (self.bb[:, 0] - 50 < e) & (self.bb[:, 2] + 50 > e) & (self.bb[:, 1] - 50 < n) & (self.bb[:, 3] + 50 > n)
        best = 50.0
        for i in np.nonzero(m)[0]:
            q = self.rings[i]
            if inside(q, e, n):
                return 0.0
            a, b = q, np.roll(q, -1, 0)
            ab = b - a
            L2 = np.maximum((ab**2).sum(1), 1e-9)
            t = np.clip(((e - a[:, 0]) * ab[:, 0] + (n - a[:, 1]) * ab[:, 1]) / L2, 0, 1)
            dd = np.hypot(a[:, 0] + ab[:, 0] * t - e, a[:, 1] + ab[:, 1] * t - n).min()
            best = min(best, float(dd))
        return best


def pca(xy: np.ndarray):
    c = xy.mean(0)
    d = xy - c
    if len(xy) < 2:
        return c, (1.0, 0.0), 0.0, 0.0
    w, v = np.linalg.eigh(d.T @ d)
    u = v[:, 1]
    along = d @ u
    across = d @ np.array([-u[1], u[0]])
    L = float(along.max() - along.min())
    W = float(across.max() - across.min())
    cmid = c + u * (along.max() + along.min()) / 2 + np.array([-u[1], u[0]]) * (across.max() + across.min()) / 2
    return cmid, (float(u[0]), float(u[1])), L, W


def bearing(ux: float, uy: float) -> float:
    """compass bearing (deg clockwise from north) of the unit vector (E, N), folded to [0, 180)"""
    b = math.degrees(math.atan2(ux, uy)) % 180.0
    return round(b, 1)


# ---------------------------------------------------------------------------- seed


def complexes(index: dict) -> list[dict]:
    rail = [s for s in index["stations"] if set(s["modes"]) & set(RAIL_MODES)]
    groups: list[dict] = []
    for s in rail:
        nm = norm_name(s["id"], s["name"])
        g = next((g for g in groups if g["name"] == nm and math.dist(g["pos"], s["pos"]) < 700), None)
        if g is None:
            g = dict(name=nm, pos=list(s["pos"]), members=[])
            groups.append(g)
        g["members"].append(s)
    for g in groups:
        g["pos"] = [float(np.mean([m["pos"][0] for m in g["members"]])), float(np.mean([m["pos"][1] for m in g["members"]]))]
    return groups


def seed_level(mode: str, pos, osm, tracks: Tracks, used: set, axis: str | None = None) -> dict:
    D = DEFAULTS[mode]
    kinds = MODE_KIND[mode]
    lvl: dict = dict(mode=mode)
    e0, n0 = pos
    # candidate OSM platforms: must have a track of this mode alongside
    found = []
    for p in osm["plats"]:
        if p["id"] in used:
            continue
        xy = p["xy"]
        c = xy.mean(0)
        if math.hypot(c[0] - e0, c[1] - n0) > SEARCH[mode]:
            continue
        cm, (ux, uy), L, W = pca(xy)
        if L < 20:
            continue
        if axis is not None:
            ns = abs(uy) > abs(ux)
            if (axis == "ns") != ns:
                continue
        offs = tracks.offsets(cm[0], cm[1], ux, uy, 16, kinds)
        if not offs:
            continue
        half = (W / 2 if p["closed"] and W > 1.5 else 0.0)
        left = [o for o in offs if 0 < o[0] <= half + 4.5]
        right = [o for o in offs if -half - 4.5 <= o[0] < 0]
        if not left and not right:
            continue
        typ = "island" if left and right else "side"
        if p["closed"] and W > 1.5:
            width = W
        else:
            width = D["island_width"] if typ == "island" else D["width"]
        found.append(dict(osm=p["id"], c=cm, u=(ux, uy), L=L, W=width, type=typ, flags=[o[1] for o in left + right]))
    # dedupe (area + line mapping of the same platform)
    plats = []
    for f in sorted(found, key=lambda f: -f["L"]):
        if any(math.hypot(f["c"][0] - g["c"][0], f["c"][1] - g["c"][1]) < max(3.0, g["W"] / 2) for g in plats):
            continue
        plats.append(f)
    for f in plats:
        used.add(f["osm"])
    # grade from the tracks near the station
    offs_c = []
    if plats:
        ce, cn = plats[0]["c"]
        ux, uy = plats[0]["u"]
    else:
        ce, cn = e0, n0
        idx = tracks.near(e0, n0, SEARCH[mode] * 0.5, kinds)
        if len(idx):
            d = tracks.dist(idx, e0, n0)
            i = idx[int(np.argmin(d))]
            dx, dy = tracks.b[i] - tracks.a[i]
            L = math.hypot(dx, dy) or 1
            ux, uy = dx / L, dy / L
            a, b = tracks.a[i], tracks.b[i]
            t = max(0, min(1, ((e0 - a[0]) * dx + (n0 - a[1]) * dy) / (L * L)))
            ce, cn = a[0] + dx * t, a[1] + dy * t
        else:
            ux, uy = 1.0, 0.0
    offs_c = tracks.offsets(ce, cn, ux, uy, 30, kinds)
    fl = [o[1] for o in offs_c] or [0]
    if any(f & 2 for f in fl):
        grade = "underground"
    elif sum(1 for f in fl if f & 1) > len(fl) / 2:
        grade = "elevated"
    else:
        grade = "at-grade"
    lvl["grade"] = grade
    if grade == "underground":
        lvl["depth"] = 12.0 if mode == "subway" else 14.0
    lvl["center"] = ll(ce, cn)
    lvl["bearing"] = bearing(ux, uy)
    lvl["tracks"] = max(1, len([o for o in offs_c if abs(o[0]) < 25]))
    if plats:
        lvl["platforms"] = [
            dict(type=f["type"], center=ll(*f["c"]), bearing=bearing(*f["u"]), length=round(min(f["L"], 420), 1), width=round(min(f["W"], 14), 1), osm=f["osm"])
            for f in plats
        ]
        lvl["length"] = round(max(p["length"] for p in lvl["platforms"]), 1)
        lvl["layout"] = (
            "island" if all(p["type"] == "island" for p in lvl["platforms"]) and len(plats) == 1
            else "side" if all(p["type"] == "side" for p in lvl["platforms"]) and len(plats) == 2
            else "mixed" if len(plats) > 2 else plats[0]["type"] if len(plats) == 1 else "mixed"
        )
    else:
        lvl["layout"] = "side" if mode in HEAVY else "island" if mode == "subway" else "side"
        lvl["length"] = D["length"]
        lvl["platforms"] = []
    lvl["source"] = "osm" if plats else "default"
    return lvl


def inside(xy: np.ndarray, e: float, n: float) -> bool:
    x, y = xy[:, 0], xy[:, 1]
    j = np.roll(np.arange(len(x)), 1)
    c = ((y > n) != (y[j] > n)) & (e < (x[j] - x) * (n - y) / (y[j] - y + 1e-12) + x)
    return bool(c.sum() % 2)


def seed(add_missing: bool = False) -> None:
    """add_missing: keep every existing entry and only add complexes for new index stations."""
    index = json.loads(INDEX.read_text())
    osm = load_osm()
    tracks = Tracks()
    old = {}
    if CURATED.exists():
        for s in json.loads(CURATED.read_text())["stations"]:
            old[s["id"]] = s
    out = []
    used_plat: set = set()
    used_ent: set = set()
    groups = complexes(index)
    route_mode = {r["id"]: r["mode"] for r in index["routes"]}
    bld_index = Buildings([tuple(g["pos"]) for g in groups], 600.0)
    ids_taken: set = set()
    # bigger complexes first so shared platforms go to the right one
    have = {i for st in old.values() for i in st["ids"]}
    if add_missing:
        out.extend(old.values())
        ids_taken.update(old)
        groups = [g for g in groups if not all(m["id"] in have for m in g["members"])]
        for g in groups:
            g["members"] = [m for m in g["members"] if m["id"] not in have]
    for g in sorted(groups, key=lambda g: -len(g["members"])):
        sid = slug(g["name"])
        if sid in ids_taken:
            sid = sid + "-" + g["members"][0]["agency"]
        ids_taken.add(sid)
        if sid in old and old[sid].get("reviewed"):
            out.append(old[sid])
            continue
        modes = []
        for m in RAIL_MODES:
            if any(m in s["modes"] for s in g["members"]):
                modes.append(m)
        e0, n0 = g["pos"]
        rec: dict = dict(id=sid, name=g["name"], ids=sorted(s["id"] for s in g["members"]), center=ll(e0, n0))
        agencies = sorted({s["agency"] for s in g["members"]})
        rec["agencies"] = agencies
        levels = []
        for m in modes:
            if m == "airport_rail" and "commuter_rail" in modes:
                # UP shares GO platforms (Bloor, Weston, Mount Dennis, Union)
                continue
            if m == "intercity_rail" and "commuter_rail" in modes:
                continue
            mpos = [s["pos"] for s in g["members"] if m in s["modes"]]
            pos = (float(np.mean([p[0] for p in mpos])), float(np.mean([p[1] for p in mpos])))
            lines = sorted({r for s in g["members"] if m in s["modes"] for r in s["routes"] if route_mode.get(r) == m})
            if m in ("subway", "lrt"):
                # one level per line (stacked / crossing interchanges); TTC Line 1
                # runs north-south at every interchange, the others east-west
                multi = len({r for s in g["members"] for r in s["routes"] if route_mode.get(r) in ("subway", "lrt")}) > 1
                for r in [x for x in lines if x.startswith("ttc:")] or [None]:
                    axis = None if not multi or r is None else ("ns" if r == "ttc:1" else "ew")
                    lv = seed_level(m, pos, osm, tracks, used_plat, axis)
                    if r:
                        lv["line"] = r.split(":")[1]
                    levels.append(lv)
            else:
                lv = seed_level(m, pos, osm, tracks, used_plat)
                also = [x for x in modes if x in HEAVY and x != m]
                if also:
                    lv["shared"] = also
                levels.append(lv)
        rec["levels"] = levels
        # entrances
        ents = []
        R = 320 if "subway" in modes or "lrt" in modes else 450
        for en_ in osm["ents"]:
            if en_["id"] in used_ent:
                continue
            d = math.hypot(en_["e"] - e0, en_["n"] - n0)
            if d > R:
                continue
            t = en_["tags"]
            if en_.get("generic"):
                # plain building entrances only count when named after the station
                nm = (t.get("name") or "") + " " + (t.get("ref") or "")
                if g["name"].lower() not in nm.lower():
                    continue
            dist_b = bld_index.distance(en_["e"], en_["n"])
            if dist_b < 1.5:
                kind = "building"
            elif not ("subway" in modes or "lrt" in modes):
                kind = "path"
            else:
                kind = "stair" if dist_b < 15 else "pavilion"
            nm_ = (t.get("name") or "") + " " + (t.get("description") or "")
            if re.search(r"via PATH|\(PATH\)|PATH Access|Teamway", nm_) or t.get("level", "0").startswith("-"):
                kind = "underground"
            if any(math.hypot(en_["e"] - x["_e"], en_["n"] - x["_n"]) < 4 for x in ents):
                continue
            ents.append(dict(_e=en_["e"], _n=en_["n"], pos=ll(en_["e"], en_["n"]), kind=kind, name=t.get("name") or t.get("ref") or "", osm=en_["id"],
                             wheelchair=t.get("wheelchair") == "yes"))
            used_ent.add(en_["id"])
        for x in ents:
            del x["_e"], x["_n"]
        rec["entrances"] = ents
        # buildings, bus terminals, parking
        bl = []
        for b in osm["blds"]:
            c = b["xy"].mean(0)
            if math.hypot(c[0] - e0, c[1] - n0) < R:
                cm, (ux, uy), L, W = pca(b["xy"])
                bl.append(dict(kind="station_building", center=ll(*cm), length=round(L, 1), width=round(W, 1), bearing=bearing(ux, uy),
                               osm=b["id"], render=False))
        rec["buildings"] = bl
        bus = []
        for b in osm["buses"]:
            c = b["xy"].mean(0)
            if math.hypot(c[0] - e0, c[1] - n0) < R:
                cm, (ux, uy), L, W = pca(b["xy"])
                bus.append(dict(center=ll(*cm), length=round(L, 1), width=round(W, 1), bearing=bearing(ux, uy), osm=b["id"]))
        rec["bus"] = bus
        if "commuter_rail" in modes:
            pk = []
            for pr in osm["parks"]:
                c = pr["xy"].mean(0)
                if math.hypot(c[0] - e0, c[1] - n0) > 600:
                    continue
                t = pr["tags"]
                txt = " ".join(str(t.get(k, "")) for k in ("name", "operator", "park_ride", "access"))
                if not (re.search(r"\bGO\b|Metrolinx|GO Transit", txt) or t.get("park_ride") not in (None, "no")):
                    continue
                x, y = pr["xy"][:, 0], pr["xy"][:, 1]
                area = 0.5 * abs(float(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1))))
                pk.append(dict(center=ll(*c), area=round(area), osm=pr["id"], name=t.get("name", "")))
            rec["parking"] = sorted(pk, key=lambda p: -p["area"])
        rec["sources"] = ["OSM (platforms, entrances, buildings)"]
        rec["reviewed"] = False
        rec["label"] = g["name"]
        rec["rank"] = 1 if set(modes) <= {"lrt"} else 2
        out.append(rec)
    out.sort(key=lambda s: s["id"])
    CURATED.parent.mkdir(parents=True, exist_ok=True)
    CURATED.write_text(json.dumps(dict(version=1, stations=out), indent=1, ensure_ascii=False) + "\n")
    n_osm = sum(1 for s in out for lv in s["levels"] if lv.get("source") == "osm")
    n_lv = sum(len(s["levels"]) for s in out)
    print(f"{len(out)} complexes, {n_lv} levels ({n_osm} with OSM platforms), {sum(len(s['entrances']) for s in out)} entrances → {CURATED}")


# ---------------------------------------------------------------------------- build

GRADES = ("underground", "at-grade", "elevated", "trench")
LAYOUTS = ("island", "side", "mixed", "stacked", "single")
PTYPES = ("island", "side")
ENT_KINDS = ("pavilion", "stair", "building", "path", "elevator", "underground")
BLD_KINDS = ("station_building", "ttc_pavilion", "go_building", "bus_terminal", "trainshed", "shelter")


QA_KINDS = {"commuter_rail": (0,), "airport_rail": (0,), "intercity_rail": (0,), "subway": (1,), "lrt": (2, 3)}
EDGE_M = {"subway": 1.62, "lrt": 1.6, "commuter_rail": 1.65, "airport_rail": 1.65, "intercity_rail": 1.65}


class Network:
    """Rail graph edges (data/rail/network.bin.gz) as segments, for snapping platforms."""

    def __init__(self) -> None:
        from shapely import STRtree, linestrings

        from . import tbn

        a, _ = tbn.read(geo.OUT / "rail" / "network.bin.gz")
        off = a["e_off"].astype(np.int64)
        xyz = a["e_xyz"].reshape(-1, 3).astype(np.float64)
        last = np.zeros(len(xyz), bool)
        last[off[1:] - 1] = True
        s_ = np.nonzero(~last)[0]
        s_ = s_[s_ < len(xyz) - 1]
        e = np.repeat(np.arange(len(off) - 1), np.diff(off))[s_]
        self.p0 = xyz[s_, :2]
        self.p1 = xyz[s_ + 1, :2]
        self.kind = a["e_kind"][e].astype(int)
        self.edge = e
        self.lines = linestrings(np.stack([self.p0, self.p1], 1))
        self.tree = STRtree(self.lines)

    def near_any(self, x, y, r) -> bool:
        from shapely import Point

        return len(self.tree.query(Point(x, y), predicate="dwithin", distance=r)) > 0

    def lats(self, qx, qy, ux, uy, r, kinds, par=0.94):
        """lateral offsets (along v = (uy, -ux)) of parallel track centrelines through the normal at (qx, qy)"""
        from shapely import Point

        out = []
        for c in self.tree.query(Point(qx, qy), predicate="dwithin", distance=r):
            if self.kind[c] not in kinds:
                continue
            d = self.p1[c] - self.p0[c]
            L = math.hypot(*d)
            if L < 0.2 or abs((d[0] * ux + d[1] * uy) / L) < par:
                continue
            # intersect the line q + v*t with the segment
            vx, vy = uy, -ux
            den = d[0] * vy - d[1] * vx
            if abs(den) < 1e-9:
                continue
            wx, wy = self.p0[c][0] - qx, self.p0[c][1] - qy
            t = (wx * vy - wy * vx) / -den  # segment param
            if not (-0.01 <= t <= 1.01):
                continue
            px, py = self.p0[c][0] + d[0] * t, self.p0[c][1] + d[1] * t
            out.append((px - qx) * vx + (py - qy) * vy)
        return out


def snap_platform(net: Network, mode: str, p: dict):
    """Fit a platform rectangle (c, b, len, w, type) to the rail graph: edges E from the
    tracks it serves, never straddling another track; shortened where tracks converge.
    Returns the corrected dict or None when no track is near."""
    kinds = QA_KINDS.get(mode, (0, 1, 2, 3))
    E = EDGE_M.get(mode, 1.65)
    b = math.radians(p["b"])
    ux, uy = math.sin(b), math.cos(b)
    vx, vy = uy, -ux
    cx, cy = p["c"]
    L, W = p["len"], p["w"]
    ts = np.arange(-L / 2 + 2.5, L / 2 - 2.4, 5.0) if L > 6 else np.array([0.0])
    per = [net.lats(cx + ux * t, cy + uy * t, ux, uy, W / 2 + 7, kinds) for t in ts]
    allv = sorted(v for row in per for v in row)
    if not allv:
        return None
    # cluster lateral offsets into tracks (median per cluster)
    tracks, cur = [], [allv[0]]
    for v in allv[1:]:
        if v - cur[-1] < 1.2:
            cur.append(v)
        else:
            tracks.append(float(np.median(cur)))
            cur = [v]
    tracks.append(float(np.median(cur)))
    left = [t for t in tracks if t > 0]
    right = [t for t in tracks if t < 0]
    if p["type"] == "island" and left and right and min(left) - max(right) >= 2 * E + 2:
        a, bb = max(right) + E, min(left) - E
        serve = (max(right), min(left))
    else:
        t0 = min(tracks, key=abs)
        if t0 > 0:
            bb, a = t0 - E, t0 - E - W
        else:
            a, bb = t0 + E, t0 + E + W
        serve = (t0,)
        # the far side: stop short of any other track
        for t in tracks:
            if t in serve:
                continue
            if a - E < t < bb + E:
                if t0 > 0:
                    a = max(a, t + E)
                else:
                    bb = min(bb, t - E)
        if bb - a < 2.0:
            return None
    # follow the served tracks sample by sample; keep the longest run where they are
    # present, nearly straight relative to the rectangle (range ≤ 0.35 m) and no
    # other track enters the envelope
    ser = []
    for row in per:
        vals = []
        for s0 in serve:
            near = [v for v in row if abs(v - s0) < 1.5]
            vals.append(min(near, key=lambda v: abs(v - s0)) if near else None)
        ser.append(vals)
    n = len(ts)

    def clean(i):
        if any(v is None for v in ser[i]):
            return False
        lo_, hi_ = a - E + 0.25, bb + E - 0.25
        return all(not (lo_ < v < hi_) or any(abs(v - s0) < 1.5 for s0 in serve) for v in per[i])

    goods = [clean(i) for i in range(n)]
    best, bl = None, 0
    for i in range(n):
        if not goods[i]:
            continue
        lo = [ser[i][k] for k in range(len(serve))]
        hi = list(lo)
        j = i
        while j + 1 < n and goods[j + 1]:
            nl = [min(lo[k], ser[j + 1][k]) for k in range(len(serve))]
            nh = [max(hi[k], ser[j + 1][k]) for k in range(len(serve))]
            if max(h - l for l, h in zip(nl, nh)) > 0.2:
                break
            lo, hi, j = nl, nh, j + 1
        if j - i + 1 > bl:
            bl, best = j - i + 1, (i, j, lo, hi)
    if best is None:
        return None
    i0, i1, lo, hi = best
    t0_, t1_ = ts[i0] - 2.5, ts[i1] + 2.5
    if t1_ - t0_ < 12:
        return None
    # edges: never closer than E to any served-track sample in the run
    if len(serve) == 2:
        a, bb = hi[0] + E, lo[1] - E
    elif serve[0] > 0:
        w0 = bb - a
        bb = lo[0] - E
        a = bb - w0
    else:
        w0 = bb - a
        a = hi[0] + E
        bb = a + w0
    if len(serve) == 1:
        # a track just behind a side platform (fence-side bypass): keep it > 3.6 m
        # from the back edge, or take it in as an island when the platform would get too thin
        for t in tracks:
            if abs(t - serve[0]) < 1.5:
                continue
            if serve[0] > 0 and t < a and a - t < 3.6:
                if bb - (t + 3.6) >= 2.5:
                    a = t + 3.6
                else:
                    a = t + E
            if serve[0] < 0 and t > bb and t - bb < 3.6:
                if (t - 3.6) - a >= 2.5:
                    bb = t - 3.6
                else:
                    bb = t - E
    if bb - a < 2.0:
        return None
    tm = (t0_ + t1_) / 2
    m = (a + bb) / 2
    q = dict(p)
    q["c"] = [round(cx + ux * tm + vx * m, 2), round(cy + uy * tm + vy * m, 2)]
    q["len"] = round(t1_ - t0_, 1)
    # the straight rectangle only covers the part where it fits the track within 0.2 m;
    # the client follows the curve and uses the full curated length
    q["lenFull"] = round(L, 1)
    q["w"] = round(bb - a, 2)
    if p["type"] == "island" and len(serve) == 1:
        q["type"] = "side"
    if len(serve) == 1:
        q["track_side"] = 1 if serve[0] > 0 else -1
    return q


def canopy_columns(lv: dict, plats: list[dict]) -> list[list[float]]:
    """Canopy post positions as StationsLayer builds them (surface levels), world E/N."""
    mode, heavy = lv["mode"], lv["mode"] in HEAVY
    if lv["grade"] == "underground":
        return []
    cols = []
    for p in plats:
        L, w = p["len"], p["w"]
        if w < 2.4:
            continue
        if heavy:
            cl = lv.get("canopy_len") or min(L, 90 if mode == "airport_rail" else 40 if mode == "intercity_rail" else max(60, L * 0.4))
        elif mode == "subway":
            cl = L
        else:
            cl = min(28, L)
        b = math.radians(p["b"])
        ux, uy = math.sin(b), math.cos(b)
        vx, vy = uy, -ux
        lat = 0.0 if p["type"] == "island" else -p.get("track_side", 1) * (w / 2 - 0.6)
        step = 12 if heavy else 9
        t = -cl / 2
        while t <= cl / 2 + 0.01:
            cols.append([round(p["c"][0] + ux * t + vx * lat, 2), round(p["c"][1] + uy * t + vy * lat, 2)])
            t += step
    return cols


# ---- Union Station (the union_station landmark models platforms, shed and atrium;
# these mirror app/src/landmarks/union.ts — keep TRACK_TAB in sync)
UNION_TX0, UNION_TDX = -195.0, 15.0
UNION_TRACKS = [
    [16.2, 10.38, 3.38, -3.0, -10.32, -18.86, -25.83, -34.39, -41.63, -50.17, -58.66],
    [17.12, 11.8, 4.01, -2.92, -10.36, -18.9, -25.83, -34.4, -41.65, -50.28, -58.83],
    [17.05, 12.37, 4.37, -2.87, -10.4, -18.93, -25.87, -34.43, -41.68, -50.37, -58.96],
    [17.0, 12.4, 4.38, -2.9, -10.42, -18.96, -25.96, -34.48, -41.7, -50.41, -58.98],
    [16.95, 12.44, 4.38, -2.93, -10.44, -18.98, -26.06, -34.52, -41.73, -50.45, -59.01],
    [16.9, 12.47, 4.38, -2.96, -10.46, -19.01, -26.16, -34.57, -41.75, -50.48, -59.03],
    [16.85, 12.51, 4.39, -2.99, -10.49, -19.04, -26.26, -34.62, -41.78, -50.52, -59.06],
    [16.8, 12.52, 4.39, -3.02, -10.51, -19.06, -26.35, -34.67, -41.8, -50.56, -59.08],
    [16.75, 12.52, 4.39, -3.05, -10.53, -19.09, -26.45, -34.72, -41.83, -50.6, -59.11],
    [16.69, 12.53, 4.4, -3.08, -10.55, -19.12, -26.55, -34.77, -41.86, -50.63, -59.13],
    [16.64, 12.53, 4.4, -3.11, -10.57, -19.14, -26.64, -34.81, -41.88, -50.67, -59.16],
    [16.59, 12.53, 4.4, -3.15, -10.6, -19.17, -26.74, -34.86, -41.91, -50.71, -59.18],
    [16.54, 12.53, 4.41, -3.18, -10.62, -19.2, -26.84, -34.91, -41.93, -50.74, -59.21],
    [16.49, 12.53, 4.41, -3.21, -10.64, -19.22, -26.94, -34.96, -41.96, -50.78, -59.23],
    [16.46, 12.53, 4.41, -3.24, -10.68, -19.25, -27.01, -35.0, -42.0, -50.81, -59.26],
    [16.45, 12.54, 4.42, -3.26, -10.75, -19.28, -27.05, -35.04, -42.07, -50.83, -59.28],
    [16.44, 12.54, 4.42, -3.29, -10.81, -19.3, -27.09, -35.07, -42.14, -50.85, -59.31],
    [16.43, 12.54, 4.42, -3.32, -10.88, -19.33, -27.13, -35.1, -42.21, -50.86, -59.33],
    [16.42, 12.54, 4.43, -3.35, -10.94, -19.36, -27.17, -35.14, -42.28, -50.88, -59.36],
    [16.41, 12.55, 4.43, -3.37, -11.01, -19.39, -27.21, -35.17, -42.35, -50.9, -59.38],
    [16.4, 12.55, 4.43, -3.4, -11.08, -19.41, -27.25, -35.21, -42.41, -50.92, -59.41],
    [16.39, 12.55, 4.44, -3.43, -11.14, -19.44, -27.29, -35.24, -42.48, -50.93, -59.44],
    [16.38, 12.55, 4.44, -3.46, -11.21, -19.47, -27.33, -35.28, -42.55, -50.95, -59.46],
    [16.37, 12.56, 4.45, -3.48, -11.27, -19.49, -27.37, -35.31, -42.62, -50.97, -59.49],
    [16.36, 12.56, 4.45, -3.51, -11.34, -19.52, -27.42, -35.35, -42.69, -50.99, -59.51],
    [14.75, 12.07, 4.45, -3.54, -11.4, -19.55, -27.46, -35.38, -42.75, -51.01, -59.54],
    [12.26, 12.26, 4.32, -3.68, -11.33, -19.6, -27.5, -35.45, -42.72, -51.11, -59.56],
    [9.89, 9.89, 3.58, -4.29, -11.38, -19.8, -27.54, -35.55, -42.62, -51.29, -59.58],
    [8.0, 8.0, 2.76, -4.9, -11.43, -20.0, -27.58, -35.63, -42.6, -51.43, -59.6],
]
UNION_EDGE = 1.65


def _union_ty(i: int, x: float) -> float:
    f = max(0.0, min(len(UNION_TRACKS) - 1.0001, (x - UNION_TX0) / UNION_TDX))
    k = int(f)
    u = f - k
    return UNION_TRACKS[k][i] * (1 - u) + UNION_TRACKS[k + 1][i] * u


def _union_world(x: float, y: float) -> list[float]:
    (ox, oy), r = UNION_LM["pos"], UNION_LM["rot"]
    return [round(ox + x * math.cos(r) - y * math.sin(r), 2), round(oy + x * math.sin(r) + y * math.cos(r), 2)]


def union_platforms() -> list[dict]:
    """Union platforms as rectangles in world coordinates (QA / labels), from the model's track table."""
    out = []
    brg = round((90 - math.degrees(UNION_LM["rot"])) % 360, 2)
    E = UNION_EDGE
    # track 3 side platform
    specs = [(0, None, -167.0, 168.0)]
    for i in range(1, 10):
        x0, x1 = -167.0, 185.0
        while x0 < x1 and _union_ty(i, x0) - _union_ty(i + 1, x0) < 2 * E + 2.5:
            x0 += 5
        while x1 > x0 and _union_ty(i, x1) - _union_ty(i + 1, x1) < 2 * E + 2.5:
            x1 -= 5
        specs.append((i, i + 1, x0, x1))
    for a, b, x0, x1 in specs:
        xs = np.linspace(x0, x1, 12)
        if b is None:
            lo = max(_union_ty(0, x) + E for x in xs)
            hi = lo + 3.8
            typ = "side"
        else:
            lo = max(_union_ty(b, x) + E for x in xs)
            hi = min(_union_ty(a, x) - E for x in xs)
            typ = "island"
        # 25 m pieces: the tracks converge slightly, a single rectangle can't follow them
        k = max(1, int(round((x1 - x0) / 25)))
        for j in range(k):
            xa, xb = x0 + (x1 - x0) * j / k, x0 + (x1 - x0) * (j + 1) / k
            xs = np.linspace(xa, xb, 6)
            if b is None:
                lo = max(_union_ty(0, x) + E for x in xs)
                hi = lo + 3.8
            else:
                lo = max(_union_ty(b, x) + E for x in xs)
                hi = min(_union_ty(a, x) - E for x in xs)
            xm, ym = (xa + xb) / 2, (lo + hi) / 2
            out.append(dict(type=typ, c=_union_world(xm, ym), b=brg, len=round(xb - xa, 1), w=round(hi - lo, 2)))
    return out


def union_columns() -> list[list[float]]:
    """Bush shed columns (bay centres every 12 m) + atrium arch legs, world E/N."""
    cols = []
    bays = [lambda x: (_union_ty(0, x) + 0.7, _union_ty(0, x) + UNION_EDGE + 4.3)]
    for i in range(1, 10):
        bays.append(lambda x, i=i: (_union_ty(i + 1, x) + 0.7, _union_ty(i, x) - 0.7))
    bays.append(lambda x: (_union_ty(10, x) - 4.5, _union_ty(10, x) - 0.7))
    ax0, ax1, ay0, ay1 = -38, 52, -38, 8
    for f in bays:
        x = -162.0
        while x < 184:
            y0, y1 = f(x)
            y = (y0 + y1) / 2
            if not (ax0 < x < ax1 and ay0 < y < ay1) and abs(x - 151) > 3:  # Bay St streetcar tunnel below
                cols.append(_union_world(x, y))
            x += 12
    x = ax0
    while x <= ax1 + 0.01:
        for y in (ay0, ay1):
            cols.append(_union_world(x, y))
        x += 7.5
    return cols


def build() -> None:
    cur = json.loads(CURATED.read_text())
    index = json.loads(INDEX.read_text())
    known = {s["id"] for s in index["stations"]}
    errs = []
    out = []
    seen = set()
    net = Network()
    dropped: list = []

    def P(p):
        e, n = en(p[0], p[1])
        return [round(e, 2), round(n, 2)]

    for s in cur["stations"]:
        for i in s["ids"]:
            if i not in known:
                errs.append(f"{s['id']}: unknown index station {i}")
            if i in seen:
                errs.append(f"{s['id']}: {i} listed twice")
            seen.add(i)
        lv_out = []
        for lv in s["levels"]:
            if lv["mode"] not in RAIL_MODES:
                errs.append(f"{s['id']}: bad mode {lv['mode']}")
            if lv.get("grade") not in GRADES:
                errs.append(f"{s['id']}: bad grade {lv.get('grade')}")
            D = DEFAULTS[lv["mode"]]
            plats = []
            for p in lv.get("platforms", []):
                if p["type"] not in PTYPES:
                    errs.append(f"{s['id']}: bad platform type {p['type']}")
                plats.append(dict(type=p["type"], c=P(p["center"]), b=p.get("bearing", lv.get("bearing", 0.0)), len=p.get("length", lv.get("length", D["length"])),
                                  w=p.get("width", D["island_width"] if p["type"] == "island" else D["width"]),
                                  **({"side": p["side"]} if "side" in p else {})))
            snapped = []
            for p_ in plats:
                q_ = snap_platform(net, lv["mode"], p_)
                if q_ is not None:
                    snapped.append(q_)
                else:
                    dropped.append(f"{s['id']}:{lv['mode']}")
            plats = snapped
            cols = [c for c in canopy_columns(lv, plats) if not net.near_any(c[0], c[1], 2.2)]
            if lv.get("landmark") == "union_station":
                plats = union_platforms()
                cols = union_columns()
            o = dict(mode=lv["mode"], grade=lv["grade"], layout=lv.get("layout", "side"), c=P(lv["center"]),
                     bearing=lv.get("bearing", 0.0), len=lv.get("length", D["length"]), tracks=lv.get("tracks", 2),
                     h=lv.get("platform_height", D["height"]), plats=[{k: v for k, v in q.items() if k != "track_side"} for q in plats])
            if cols:
                o["columns"] = cols
            for k in ("line", "depth", "elevation", "wall", "canopy", "canopy_len", "level_order", "trim", "landmark"):
                if k in lv:
                    o[k] = lv[k]
            if lv.get("structure"):
                # Allen Road median station structure (app/src/layers/stations/allen.ts); walkway ends → E/N
                st_ = dict(lv["structure"])
                if st_.get("walks"):
                    st_["walks"] = [dict(**{k: P(w[k]) for k in ("from", "to")}) for w in st_["walks"]]
                o["structure"] = st_
            lv_out.append(o)
        ents = []
        for e_ in s.get("entrances", []):
            if e_.get("kind") not in ENT_KINDS:
                errs.append(f"{s['id']}: bad entrance kind {e_.get('kind')}")
            d = dict(p=P(e_["pos"]), k=e_["kind"])
            if e_.get("bearing") is not None:
                d["b"] = e_["bearing"]
            if e_.get("name"):
                d["name"] = e_["name"]
            ents.append(d)
        blds = []
        for b in s.get("buildings", []):
            if not b.get("render"):
                continue
            if b["kind"] not in BLD_KINDS:
                errs.append(f"{s['id']}: bad building kind {b['kind']}")
            blds.append(dict(k=b["kind"], c=P(b["center"]), l=b["length"], w=b["width"], h=b.get("height", 5.0), b=b.get("bearing", 0.0)))
        bus = [dict(c=P(b["center"]), l=b["length"], w=b["width"], b=b.get("bearing", 0.0), bays=b.get("bays", 0))
               for b in s.get("bus", []) if b.get("render")]
        out.append(dict(id=s["id"], name=s.get("label", s["name"]), ids=s["ids"], c=P(s["center"]), rank=s.get("rank", 1),
                        levels=lv_out, ents=ents, blds=blds, bus=bus))
    missing = known - seen
    rail_known = {s["id"] for s in index["stations"] if set(s["modes"]) & set(RAIL_MODES)}
    if rail_known - seen:
        errs.append(f"index stations not in curated table: {sorted(rail_known - seen)}")
    del missing
    if errs:
        print("\n".join(errs))
        raise SystemExit(1)
    print(f"platforms snapped to the rail graph; {len(dropped)} dropped (no track fit): {dropped[:12]}")
    zones = station_zones(out)
    suppress, report = clearance_suppress(zones)
    suppress |= {int(x["osm"]) for x in cur.get("suppress_extra", [])}
    (geo.WORK / "stations").mkdir(parents=True, exist_ok=True)
    (geo.WORK / "stations" / "clearance_report.json").write_text(json.dumps(report, indent=1))
    print(f"zones: {len(zones)}, buildings suppressed (clipping tracks/platforms): {len(suppress)} → work/stations/clearance_report.json")
    dst = geo.OUT / "stations.json"
    dst.write_text(json.dumps(dict(version=1, stations=out,
                                   zones=[[round(v, 1) for xy in z for v in xy] for z in zones],
                                   suppress=sorted(suppress)), separators=(",", ":")))
    print(f"{len(out)} stations, {sum(len(s['levels']) for s in out)} levels, {sum(len(s['ents']) for s in out)} entrances → {dst} ({dst.stat().st_size // 1024} KiB)")


# ---------------------------------------------------------------------------- station zones + clearance

UNION_LM = dict(pos=(216.98, -940.4), rot=0.2879)  # landmarks.json union_station frame
UNION_RECTS = [(-195, -80, 218, 34), (-262, 10, -168, 25)]  # deck + platforms, UP deck (local x0 y0 x1 y1)


def _rect_world(cx, cy, ux, uy, hl, hw):
    vx, vy = -uy, ux
    return [(cx + ux * a * hl + vx * b * hw, cy + uy * a * hl + vy * b * hw) for a, b in ((-1, -1), (1, -1), (1, 1), (-1, 1))]


def station_zones(out: list[dict]) -> list[list[tuple[float, float]]]:
    """Paved, tree/house-free areas: the Union complex and every surface platform (snapped, + margin)."""
    zones = []
    (ox, oy), r = UNION_LM["pos"], UNION_LM["rot"]
    c, s_ = math.cos(r), math.sin(r)
    for x0, y0, x1, y1 in UNION_RECTS:
        zones.append([(ox + x * c - y * s_, oy + x * s_ + y * c) for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))])
    for st in out:
        for lv in st["levels"]:
            if lv.get("landmark") or lv["grade"] == "underground":
                continue
            for p in lv["plats"]:
                b = math.radians(p["b"])
                zones.append(_rect_world(p["c"][0], p["c"][1], math.sin(b), math.cos(b), p["len"] / 2 + 4, p["w"] / 2 + 2.5))
    return zones


def clearance_suppress(zones) -> tuple[set, list]:
    """OSM buildings that clip trains or platforms: footprint within 3 m of an at-grade
    track centreline (within 2 km of Union or 400 m of a station zone) or overlapping a
    station zone, and reaching down to the ground (min_height < 5.5 m)."""
    from shapely import STRtree
    from shapely.geometry import LineString, Polygon, Point
    from shapely.ops import unary_union

    zpolys = [Polygon(z) for z in zones]
    union_c = Point(UNION_LM["pos"])
    near_st = unary_union([zp.buffer(400) for zp in zpolys]).union(union_c.buffer(2000))
    d = np.load(geo.WORK / "transit_rail.npz")
    xy, off, flags, kind = d["xy"], d["off"], d["flags"], d["kind"]
    tracks = []
    for w in range(len(flags)):
        if flags[w] & 3 or kind[w] == 3:  # tunnels/bridges (trains above/below), street-running trams
            continue
        ls = LineString(xy[off[w]:off[w + 1]])
        if ls.length > 0 and ls.intersects(near_st):
            tracks.append(ls.intersection(near_st))
    corridor = unary_union([t.buffer(3.0, cap_style=2) for t in tracks] + zpolys)
    b = np.load(geo.WORK / "osm_buildings.npz", allow_pickle=True)
    ids, nring, ringlen, bxy, hmin, height, tag = b["id"], b["nring"], b["ringlen"], b["xy"], b["min"], b["height"], b["tag"]
    z0 = np.zeros(1, np.int64)
    roff = np.concatenate([z0, np.cumsum(ringlen.astype(np.int64))])
    first = np.concatenate([z0, np.cumsum(nring.astype(np.int64))])[:-1]
    minx, miny, maxx, maxy = corridor.bounds
    v0 = roff[first]
    cand = np.nonzero((bxy[v0, 0] > minx - 500) & (bxy[v0, 0] < maxx + 500) & (bxy[v0, 1] > miny - 500) & (bxy[v0, 1] < maxy + 500))[0]
    polys, idx = [], []
    for i in cand:
        ring = bxy[roff[first[i]]:roff[first[i] + 1]]
        if len(ring) < 3:
            continue
        pg = Polygon(ring)
        if not pg.is_valid:
            pg = pg.buffer(0)
        polys.append(pg)
        idx.append(i)
    tree = STRtree(polys)
    pieces = list(getattr(corridor, "geoms", [corridor]))
    hit = set()
    for piece in pieces:
        for k in tree.query(piece, predicate="intersects"):
            hit.add(int(k))
    out, report = set(), []
    for k in sorted(hit):
        i = idx[k]
        mh = float(hmin[i]) if np.isfinite(hmin[i]) else 0.0
        if mh >= 5.5:
            continue
        ov = polys[k].intersection(corridor).area
        tg = str(tag[i])
        if tg == "bridge" or (tg == "roof" and np.isfinite(height[i]) and height[i] >= 7):
            continue  # footbridges and high canopies span the tracks
        stationish = tg in ("train_station", "transportation", "roof", "part", "platform", "bridge")
        # real buildings beside the tracks that OSM draws a little into the buffer stay
        if not (ov >= 0.25 * polys[k].area or (stationish and ov >= 60)):
            continue
        oid = int(ids[i])
        out.add(oid)
        c = polys[k].centroid
        report.append(dict(osm=oid, e=round(c.x, 1), n=round(c.y, 1), area=round(polys[k].area), overlap=round(ov, 1),
                           height=float(height[i]), tag=str(tag[i])[:60]))
    return out, report


def suppress_from_qa(path: str) -> None:
    """Add buildings the QA finds over tracks (building_over_track / vehicle_path_through_building,
    rail vehicles, bottom below rail + 4.8 m) near a station or within 2 km of Union to the
    curated `suppress_extra` list (with the QA description as the reason)."""
    d = json.loads(Path(path).read_text())
    L = d["issues"] if isinstance(d, dict) else d
    cur = json.loads(CURATED.read_text())
    extra = {int(x["osm"]): x for x in cur.get("suppress_extra", [])}
    n0 = len(extra)
    for x in L:
        if x["cat"] not in ("building_over_track", "vehicle_path_through_building") or not x.get("osm"):
            continue
        desc = x["desc"]
        if x["cat"] == "vehicle_path_through_building" and not re.match(r"train path", desc):
            continue
        if x["cat"] == "building_over_track" and desc.startswith("streetcar") and not x.get("near_station"):
            continue
        m = re.search(r"bottom ([+-]?[\d.]+) m vs rail", desc)
        if m and float(m.group(1)) >= 4.8:
            continue
        near_union = math.hypot(x["e"] - UNION_LM["pos"][0], x["n"] - UNION_LM["pos"][1]) < 2000
        if not (x.get("near_station") or near_union):
            continue
        oid = int(x["osm"][0])
        extra.setdefault(oid, dict(osm=oid, e=x["e"], n=x["n"], reason=desc[:160]))
    cur["suppress_extra"] = sorted(extra.values(), key=lambda r: r["osm"])
    CURATED.write_text(json.dumps(cur, indent=1, ensure_ascii=False) + "\n")
    print(f"suppress_extra: {n0} → {len(extra)}")


def main(argv: list[str]) -> None:
    cmd = argv[0] if argv else "build"
    if cmd == "seed":
        seed(add_missing="--add-missing" in argv)
    elif cmd == "suppress-from-qa":
        suppress_from_qa(argv[1])
    elif cmd == "build":
        build()
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
