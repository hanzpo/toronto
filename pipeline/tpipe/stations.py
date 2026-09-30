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


def seed() -> None:
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
            for b in osm["parks"]:
                c = b["xy"].mean(0)
                if math.hypot(c[0] - e0, c[1] - n0) > 600:
                    continue
                t = b["tags"]
                txt = " ".join(str(t.get(k, "")) for k in ("name", "operator", "park_ride", "access"))
                if not (re.search(r"\bGO\b|Metrolinx|GO Transit", txt) or t.get("park_ride") not in (None, "no")):
                    continue
                x, y = b["xy"][:, 0], b["xy"][:, 1]
                area = 0.5 * abs(float(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1))))
                pk.append(dict(center=ll(*c), area=round(area), osm=b["id"], name=t.get("name", "")))
            rec["parking"] = sorted(pk, key=lambda p: -p["area"])
        rec["sources"] = ["osm"]
        rec["reviewed"] = False
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


def build() -> None:
    cur = json.loads(CURATED.read_text())
    index = json.loads(INDEX.read_text())
    known = {s["id"] for s in index["stations"]}
    errs = []
    out = []
    seen = set()

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
            o = dict(mode=lv["mode"], grade=lv["grade"], layout=lv.get("layout", "side"), c=P(lv["center"]),
                     bearing=lv.get("bearing", 0.0), len=lv.get("length", D["length"]), tracks=lv.get("tracks", 2),
                     h=lv.get("platform_height", D["height"]), plats=plats)
            for k in ("line", "depth", "elevation", "wall", "canopy", "canopy_len", "level_order", "trim", "landmark"):
                if k in lv:
                    o[k] = lv[k]
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
    dst = geo.OUT / "stations.json"
    dst.write_text(json.dumps(dict(version=1, stations=out), separators=(",", ":")))
    print(f"{len(out)} stations, {sum(len(s['levels']) for s in out)} levels, {sum(len(s['ents']) for s in out)} entrances → {dst} ({dst.stat().st_size // 1024} KiB)")


def main(argv: list[str]) -> None:
    cmd = argv[0] if argv else "build"
    if cmd == "seed":
        seed()
    elif cmd == "build":
        build()
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
