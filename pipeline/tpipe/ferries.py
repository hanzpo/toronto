"""Waterfront life: ferry routes, marinas (moored-boat slips), sailing areas
and freighter lanes for app/src/layers/WaterLifeLayer.ts.

OSM supplies the geometry: `route=ferry` ways (Toronto Island ferries, the
Billy Bishop airport ferry), `amenity=ferry_terminal`, `leisure=marina` areas
and the `man_made=pier` pontoons inside them. Lake Ontario comes from
work/lakes.osm.pbf (see run.sh), plus the harbours / river mouths / basins
(`natural=water`, `waterway=dock|riverbank|canal`) connected to it.

Derived here:
- slips: one moored boat per berth along both sides of every marina pontoon
  (spacing ~ beam + fender gap, boat length drawn per slip), only where the
  whole hull footprint lies in open water;
- sailing loops: closed, smoothed polylines inside eroded water for each
  pleasure-boat zone (inner harbour, off the Islands, Humber Bay, Bluffer's,
  Port Credit, Bronte, Hamilton Harbour ...);
- tour loops (Harbourfront cruises) and freighter lanes from curated
  waypoints, validated against the water polygon;
- fixed berths: fireboat William Lyon Mackenzie, moored lakers.

Everything is Lake-Ontario level water (datum -0.3 m, see workers/ground.ts).

    uv run python -m tpipe.ferries          # -> app/public/data/water/ferries.json
    uv run python -m tpipe.ferries --debug  # + scratch PNGs of water / output
"""

from __future__ import annotations

import json
import math
import subprocess
import sys

import numpy as np
import osmium
import shapely
import shapely.prepared
from shapely import wkb
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import transform, unary_union

from . import geo, region as region_mod

SRC_PBF = geo.RAW / "bbox.osm.pbf"
PBF = geo.WORK / "water_life.osm.pbf"
OUT = geo.OUT / "water" / "ferries.json"
LAKE_LEVEL = -0.3  # datum m (workers/ground.ts LAKE_LEVELS)
RNG = np.random.default_rng(1793)  # Toronto (York) founded


def ll(lat: float, lon: float) -> tuple[float, float]:
    x, y = geo.project(lon, lat)
    return float(x), float(y)


# --------------------------------------------------------------------------- curated
# Pleasure-boat zones: box (E0, N0, E1, N1 world m), erosion from shore (m),
# boats per zone at peak (summer weekend afternoon, good weather).
ZONES = [
    dict(id="inner_harbour", name="Toronto Inner Harbour", box=(-1900, -3000, 2900, -1150), erode=35, peak=26),
    dict(id="off_islands", name="Off the Toronto Islands", box=(-5000, -7500, 6000, -3300), erode=120, peak=34),
    dict(id="humber_bay", name="Humber Bay", box=(-9500, -6500, -1900, -1700), erode=90, peak=22),
    dict(id="ashbridges", name="Ashbridge's Bay", box=(2900, -4000, 9000, -300), erode=90, peak=12),
    dict(id="bluffers", name="Bluffer's Park", box=(9000, 1500, 17000, 5800), erode=100, peak=12),
    dict(id="port_credit", name="Port Credit", box=(-20000, -15500, -13000, -10900), erode=120, peak=14),
    dict(id="oakville", name="Oakville / Bronte", box=(-30000, -31500, -20000, -23500), erode=150, peak=16),
    dict(id="hamilton", name="Hamilton Harbour", box=(-43000, -43800, -34000, -37000), erode=80, peak=18),
    dict(id="frenchmans", name="Frenchman's Bay / Pickering", box=(19500, 13500, 27000, 17200), erode=120, peak=8),
    dict(id="whitby", name="Whitby / Oshawa", box=(32000, 18500, 45000, 22500), erode=150, peak=8),
]

# Harbourfront tour boats (Mariposa, Toronto Harbour Tours, Great Lakes
# Schooner Co.) out of York Quay / Queen's Quay: closed loops, world (E, N).
TOURS = [
    dict(id="harbour_tour_w", name="Harbour tour (west)", pts=[
        (250, -1830), (-300, -1970), (-560, -2090), (-150, -2560), (300, -2720), (1000, -2680),
        (1300, -2300), (900, -1850), (500, -1700)]),
    dict(id="harbour_tour_e", name="Harbour tour (east)", pts=[
        (800, -1650), (1600, -1900), (2250, -2150), (1500, -2500), (900, -2600), (500, -2300), (600, -1800)]),
]

# Freighter lanes, world (E, N): Welland Canal / Port Weller <-> Burlington
# Canal and Hamilton Harbour piers, <-> Toronto (outside the Eastern Gap),
# and the downbound lane east towards Kingston.
LANES = [
    dict(id="welland_hamilton", pts=[(13500, -46400), (-2000, -42000), (-20000, -37000), (-31000, -38400),
                                     (-33000, -39150), (-33700, -39380), (-34500, -39800), (-35600, -40500), (-36500, -41050)]),
    dict(id="welland_east", pts=[(13500, -46400), (22000, -42000), (60000, -26000)]),
    dict(id="welland_toronto", pts=[(13500, -46400), (9000, -25000), (4500, -6500), (3800, -4300)]),
]

# Fixed berths: approximate spot (E, N) snapped to the nearest quay wall.
# kind: fireboat (William Lyon Mackenzie, Fire Station 334, Queens Quay W),
# laker (lay-up / unloading), ccg (Canadian Coast Guard).
BERTHS = [
    dict(id="wlm", kind="fireboat", name="William Lyon Mackenzie", p=(-589, -1633), len=24.4),
    dict(id="redpath", kind="laker", name="Redpath Sugar dock", p=(1065, -1100), len=225.0),
    dict(id="ship_channel", kind="laker", name="Ship Channel lay-up", p=(3486, -1021), len=222.0),
    dict(id="ham_pier12", kind="laker", name="Port of Hamilton Pier 12", p=(-37300, -41650), len=225.0),
    dict(id="ham_steel", kind="laker", name="Hamilton steel mill slip", p=(-33900, -42100), len=225.0),
    dict(id="ccg_pc", kind="ccg", name="CCG Station Port Credit", p=(-16210, -11169), len=14.7),
    dict(id="ccg_bur", kind="ccg", name="CCG Burlington (CCIW)", p=(-33575, -38825), len=24.0),
]
# anchored / waiting (no snapping): heading deg (math, from +E)
ANCHORED = [dict(id="pw_anchor", kind="laker", name="Anchored off Port Weller", p=(12200, -44200), heading=250, len=225.0)]


# --------------------------------------------------------------------------- OSM
def ensure_pbf():
    if PBF.exists() and PBF.stat().st_mtime > SRC_PBF.stat().st_mtime:
        return
    subprocess.run([
        "osmium", "tags-filter", str(SRC_PBF),
        "nwr/route=ferry", "nwr/leisure=marina", "nwr/amenity=ferry_terminal",
        "nwr/man_made=pier,breakwater,groyne,quay", "nwr/natural=water",
        "nwr/waterway=dock,riverbank,canal", "nwr/leisure=slipway",
        "-o", str(PBF), "--overwrite"], check=True)


def _proj(g):
    return transform(lambda x, y, z=None: geo.project(x, y), g)


def read_osm(aoi):
    """ferry ways, terminals, marinas, piers, water polygons (projected)."""
    fab = osmium.geom.WKBFactory()
    ferries, terminals, marinas, piers, waters = [], [], [], [], []
    for o in osmium.FileProcessor(str(PBF)).with_locations().with_areas():
        t = o.tags
        try:
            if o.is_node():
                if t.get("leisure") == "marina" or t.get("amenity") == "ferry_terminal":
                    p = Point(geo.project(o.location.lon, o.location.lat))
                    if not aoi.intersects(p):
                        continue
                    (marinas if t.get("leisure") == "marina" else terminals).append((p, t.get("name")))
            elif o.is_way():
                if t.get("route") == "ferry":
                    ferries.append((_proj(wkb.loads(fab.create_linestring(o), hex=True)), t.get("name"), t.get("duration")))
                elif t.get("man_made") in ("pier", "breakwater", "groyne") and not o.is_closed():
                    g = _proj(wkb.loads(fab.create_linestring(o), hex=True))
                    if aoi.intersects(g):
                        w = t.get("width")
                        try:
                            w = float(w) if w else None
                        except ValueError:
                            w = None
                        piers.append((g, w, t.get("man_made"), t.get("floating") == "yes"))
            elif o.is_area():
                if not (t.get("leisure") == "marina" or t.get("man_made") in ("pier", "breakwater", "quay")
                        or t.get("natural") == "water" or t.get("waterway") in ("dock", "riverbank", "canal")
                        or t.get("amenity") == "ferry_terminal"):
                    continue
                g = _proj(wkb.loads(fab.create_multipolygon(o), hex=True))
                if not aoi.intersects(g):
                    continue
                if t.get("leisure") == "marina":
                    marinas.append((g, t.get("name")))
                elif t.get("amenity") == "ferry_terminal":
                    terminals.append((g.centroid, t.get("name")))
                elif t.get("man_made") in ("pier", "breakwater", "quay"):
                    piers.append((g, None, t.get("man_made"), False))
                else:
                    waters.append(g)
        except RuntimeError:
            continue  # broken geometry
    return ferries, terminals, marinas, piers, waters


# --------------------------------------------------------------------------- helpers
def chaikin(pts: np.ndarray, it=3, closed=True) -> np.ndarray:
    for _ in range(it):
        a = pts
        b = np.roll(a, -1, axis=0) if closed else a[1:]
        a2 = a if closed else a[:-1]
        q = 0.75 * a2 + 0.25 * b
        r = 0.25 * a2 + 0.75 * b
        out = np.empty((len(q) * 2, 2))
        out[0::2], out[1::2] = q, r
        pts = out if closed else np.vstack([pts[:1], out, pts[-1:]])
    return pts


def rnd(v, k=1):
    return round(float(v), k)


def make_loops(area, n_loops, legs=(5, 9), leg_len=(250, 1400)):
    """Closed smoothed loops of random waypoints; every leg lies in `area`."""
    if area.is_empty:
        return []
    prep = shapely.prepared.prep(area)
    x0, y0, x1, y1 = area.bounds
    loops = []
    tries = 0
    while len(loops) < n_loops and tries < n_loops * 400:
        tries += 1
        # start somewhere in the area
        p = None
        for _ in range(200):
            q = Point(RNG.uniform(x0, x1), RNG.uniform(y0, y1))
            if prep.contains(q):
                p = q
                break
        if p is None:
            break
        pts = [p]
        k = int(RNG.integers(legs[0], legs[1] + 1))
        ok = True
        for _ in range(k - 1):
            nxt = None
            for _ in range(60):
                a = RNG.uniform(0, 2 * math.pi)
                d = RNG.uniform(*leg_len)
                q = Point(pts[-1].x + d * math.cos(a), pts[-1].y + d * math.sin(a))
                if prep.contains(LineString([pts[-1], q])):
                    nxt = q
                    break
            if nxt is None:
                ok = False
                break
            pts.append(nxt)
        if not ok or not prep.contains(LineString([pts[-1], pts[0]])):
            continue
        arr = chaikin(np.array([[p.x, p.y] for p in pts]))
        ring = LineString(np.vstack([arr, arr[:1]]))
        if not prep.contains(ring) or ring.length < 800:
            continue
        loops.append(arr)
    return loops


def curated_loop(pts_ll, area, closed=True):
    arr = np.array([ll(a, b) for a, b in pts_ll])
    sm = chaikin(arr, 3, closed)
    line = LineString(np.vstack([sm, sm[:1]]) if closed else sm)
    bad = line.difference(area).length
    return sm, bad


def snap_berth(pt, L, beam, free, prep_free):
    """Park a hull of length L alongside the quay wall nearest `pt`."""
    p = Point(pt)
    edges = free.boundary
    for r in (60, 150, 400):
        local = edges.intersection(p.buffer(r))
        if local.is_empty:
            continue
        cands = []
        for part in shapely.get_parts(local):
            c = np.asarray(part.coords)
            for i in range(len(c) - 1):
                a, b = c[i], c[i + 1]
                seg = np.linalg.norm(b - a)
                if seg < 1:
                    continue
                d = (b - a) / seg
                for f in np.linspace(0.05, 0.95, 7):
                    q = a + d * seg * f
                    cands.append((np.hypot(*(q - np.asarray(pt))), q, d))
        cands.sort(key=lambda c: c[0])
        for _, q, d in cands[:200]:
            nrm = np.array([-d[1], d[0]])
            for side in (1, -1):
                ctr = q + nrm * side * (beam / 2 + 1.0)
                hull = Polygon([ctr + d * L / 2 + nrm * beam / 2, ctr - d * L / 2 + nrm * beam / 2,
                                ctr - d * L / 2 - nrm * beam / 2, ctr + d * L / 2 - nrm * beam / 2])
                if prep_free.contains(hull):
                    return float(ctr[0]), float(ctr[1]), math.atan2(d[1], d[0])
    return None


# --------------------------------------------------------------------------- slips
def berth_boats(marina_geom, pier_geoms, free, prep_free):
    """Moored boats along both sides of each pontoon inside the marina."""
    zone = marina_geom.buffer(40)
    out = []
    for g, w, kind, floating in pier_geoms:
        if kind != "pier" or not zone.intersects(g):
            continue
        if g.geom_type in ("Polygon", "MultiPolygon"):
            r = g.minimum_rotated_rectangle
            c = np.array(r.exterior.coords)[:4]
            e = [np.linalg.norm(c[i + 1] - c[i]) for i in range(3)]
            if max(e[0], e[1]) < 12:
                continue
            if e[0] >= e[1]:
                a, b = (c[0] + c[3]) / 2, (c[1] + c[2]) / 2
                hw = e[1] / 2
            else:
                a, b = (c[0] + c[1]) / 2, (c[3] + c[2]) / 2
                hw = e[0] / 2
            lines = [LineString([a, b])]
        else:
            lines = [g.intersection(zone)] if g.intersects(zone) else []
            hw = (w or 2.0) / 2
        for ln in lines:
            for part in shapely.get_parts(ln):
                if part.geom_type != "LineString" or part.length < 10:
                    continue
                c = np.asarray(part.coords)
                for i in range(len(c) - 1):
                    p0, p1 = c[i], c[i + 1]
                    seg = np.linalg.norm(p1 - p0)
                    if seg < 6:
                        continue
                    d = (p1 - p0) / seg
                    nrm = np.array([-d[1], d[0]])
                    for side in (-1, 1):
                        s = 3.0
                        while s < seg - 2.5:
                            L = float(RNG.choice([7.5, 8.5, 9.5, 10.5, 11.5, 12.5, 14.0], p=[.1, .18, .2, .2, .14, .1, .08]))
                            beam = L * 0.34
                            if s + beam / 2 > seg - 1:
                                break
                            ctr = p0 + d * (s + beam / 2) + nrm * side * (hw + 0.6 + L / 2)
                            fwd = -nrm * side  # bow in toward the pontoon
                            hull = Polygon([
                                ctr + fwd * L / 2 + d * beam / 2, ctr + fwd * L / 2 - d * beam / 2,
                                ctr - fwd * L / 2 - d * beam / 2, ctr - fwd * L / 2 + d * beam / 2])
                            if prep_free.contains(hull):
                                out.append((ctr[0], ctr[1], math.atan2(fwd[1], fwd[0]), L))
                                s += beam + 1.1
                            else:
                                s += 2.0
    # de-duplicate overlapping (crossing / double-mapped pontoons)
    keep = []
    if out:
        pts = np.array([[o[0], o[1]] for o in out])
        taken = np.zeros(len(out), bool)
        from scipy.spatial import cKDTree

        tree = cKDTree(pts)
        for i, o in enumerate(out):
            if taken[i]:
                continue
            keep.append(o)
            for j in tree.query_ball_point(pts[i], r=o[3] * 0.33):
                taken[j] = True
    return keep


def mooring_field(marina_geom, prep_free, free, n_max=60):
    """Swing moorings for marinas without mapped pontoons (all boats head into the SW wind)."""
    area = marina_geom.buffer(30).intersection(free.buffer(-12))
    if area.is_empty:
        return []
    out = []
    x0, y0, x1, y1 = area.bounds
    ap = shapely.prepared.prep(area)
    for _ in range(n_max * 20):
        if len(out) >= n_max:
            break
        q = (RNG.uniform(x0, x1), RNG.uniform(y0, y1))
        if not ap.contains(Point(q)):
            continue
        if any((q[0] - o[0]) ** 2 + (q[1] - o[1]) ** 2 < 24 ** 2 for o in out):
            continue
        L = float(RNG.choice([7.5, 8.5, 9.5, 10.5, 12.0]))
        out.append((q[0], q[1], math.radians(225) + RNG.normal(0, 0.15), L))
    return out


# --------------------------------------------------------------------------- main
def build(debug=False):
    import pickle

    cache = geo.WORK / "ferries_cache.pkl"
    if "--cache" in sys.argv and cache.exists():
        region, lake, ferries, terminals, marinas, piers, waters = pickle.loads(cache.read_bytes())
    else:
        region, lake, ferries, terminals, marinas, piers, waters = _load()
        if "--cache" in sys.argv:
            cache.write_bytes(pickle.dumps((region, lake, ferries, terminals, marinas, piers, waters)))
    _build(region, lake, ferries, terminals, marinas, piers, waters, debug)


def _load():
    ensure_pbf()
    region = region_mod.load()
    from .osm_tiles import great_lakes

    # Lake Ontario only (Lake Erie, datum 99.2, lies south of N -60 km here)
    lakes = [g for g in great_lakes() if g.intersects(region) and g.representative_point().y > -60000]
    lake = unary_union(lakes).intersection(region.buffer(3000))
    # everything of interest lies on the Lake Ontario shore
    aoi = lake.boundary.buffer(8000, 4)
    ferries, terminals, marinas, piers, waters = read_osm(aoi)
    return region, lake, ferries, terminals, marinas, piers, waters


def _build(region, lake, ferries, terminals, marinas, piers, waters, debug):
    print(f"osm: {len(ferries)} ferry ways, {len(terminals)} terminals, {len(marinas)} marinas, {len(piers)} piers, {len(waters)} water polys")

    # harbours / river mouths connected to the lake at lake level (within 300 m)
    lake_prep = shapely.prepared.prep(lake.buffer(300))
    conn = [w for w in waters if lake_prep.intersects(w)]
    # second hop (basins behind a canal polygon, e.g. Hamilton Harbour via the Burlington Canal)
    if conn:
        cu = shapely.prepared.prep(unary_union(conn).buffer(60))
        conn += [w for w in waters if w not in conn and cu.intersects(w) and w.area < 5e7]
    water = unary_union([lake] + conn).buffer(0)
    pier_obst = unary_union([
        (g if g.geom_type in ("Polygon", "MultiPolygon") else g.buffer(max((w or 2.5) / 2, 1.2), cap_style="flat"))
        for g, w, kind, fl in piers])
    free = water.difference(pier_obst)
    prep_free = shapely.prepared.prep(free)
    print(f"water: {water.area / 1e6:.0f} km2 ({len(conn)} connected basins)")

    out: dict = {"version": 1, "level": LAKE_LEVEL, "sources": [
        "OpenStreetMap contributors (ODbL): route=ferry, amenity=ferry_terminal, leisure=marina, man_made=pier, water",
        "City of Toronto ferry schedules (toronto.ca/ferry), PortsToronto Billy Bishop airport ferry",
    ]}

    # ---- ferry routes (Toronto Island + airport), oriented city -> island
    routes = []
    for g, name, dur in ferries:
        if not name or not (g.intersects(box(-3000, -4500, 3500, -900))):
            continue
        c = np.asarray(g.coords)
        if c[0][1] < c[-1][1]:
            c = c[::-1]
        key = ("airport" if "Airport" in name else "centre" if "Centre" in name else "hanlans" if "Hanlan" in name
               else "wards" if "Ward" in name else None)
        if not key:
            continue
        routes.append({"id": key, "name": name, "duration": dur, "pts": [[rnd(x), rnd(y)] for x, y in c]})
    out["routes"] = routes
    out["terminals"] = [{"name": n, "p": [rnd(p.x), rnd(p.y)]} for p, n in terminals if n and box(-3000, -4500, 3500, -900).contains(p)]
    print("routes:", [(r["id"], len(r["pts"])) for r in routes])

    # ---- marinas + berths
    mlist = []
    near = shapely.prepared.prep(water.buffer(400))
    for g, name in marinas:
        if not near.intersects(g) or not region.buffer(500).intersects(g):
            continue
        geom = g if g.geom_type != "Point" else g.buffer(120)
        boats = berth_boats(geom, piers, free, prep_free)
        kind = "slips"
        if len(boats) < 6 and geom.area > 2000:
            boats = mooring_field(geom, prep_free, free, n_max=int(min(80, max(10, geom.area / 1500))))
            kind = "moorings"
        if not boats:
            continue
        c = geom.centroid
        mlist.append({"name": name, "c": [rnd(c.x), rnd(c.y)], "kind": kind,
                      "boats": [[rnd(b[0]), rnd(b[1]), rnd(b[2], 3), rnd(b[3])] for b in boats]})
    # merge near-duplicate marina nodes/areas (same boats)
    mlist.sort(key=lambda m: -len(m["boats"]))
    seen: list = []
    final = []
    for m in mlist:
        pts = {(round(b[0]), round(b[1])) for b in m["boats"]}
        if any(len(pts & s) > len(pts) * 0.5 for s in seen):
            continue
        seen.append(pts)
        final.append(m)
    out["marinas"] = final
    print(f"marinas: {len(final)}, boats {sum(len(m['boats']) for m in final)}")
    for m in final[:25]:
        print(f"  {m['name']!s:40s} {m['kind']:8s} {len(m['boats']):4d}  @ {m['c']}")

    # ---- sailing zones
    zones = []
    for z in ZONES:
        area = free.intersection(box(*z["box"])).buffer(-z["erode"])
        # keep the largest pieces only (no loops in isolated slivers)
        parts = sorted(shapely.get_parts(area), key=lambda p: -p.area)
        area = unary_union([p for p in parts if p.area > 0.2e6][:3]) if parts else area
        big = z["erode"] >= 100
        loops = make_loops(area, 14, leg_len=(400, 1800) if big else (200, 900))
        zones.append({"id": z["id"], "name": z["name"], "peak": z["peak"],
                      "loops": [[[rnd(x), rnd(y)] for x, y in lp] for lp in loops]})
        print(f"zone {z['id']}: {area.area / 1e6:.2f} km2, {len(loops)} loops")
    out["zones"] = zones

    # ---- tours + lanes
    tour_area = free.buffer(-20)
    tours = []
    for t in TOURS:
        arr = np.array(t["pts"], float)
        sm = chaikin(arr, 3, True)
        bad = LineString(np.vstack([sm, sm[:1]])).difference(tour_area).length
        outside = LineString(np.vstack([sm, sm[:1]])).difference(tour_area)
        print(f"tour {t['id']}: {bad:.0f} m outside water", [(round(g.centroid.x), round(g.centroid.y), round(g.length)) for g in shapely.get_parts(outside) if not g.is_empty][:8])
        tours.append({"id": t["id"], "name": t["name"], "loop": [[rnd(x), rnd(y)] for x, y in sm]})
    out["tours"] = tours
    lane_area = water.buffer(-30)
    lanes = []
    for t in LANES:
        sm = chaikin(np.array(t["pts"], float), 3, False)
        bad = LineString(sm).difference(lane_area).length
        outside = LineString(sm).difference(lane_area)
        print(f"lane {t['id']}: {bad:.0f} m outside water", [(round(g.centroid.x), round(g.centroid.y), round(g.length)) for g in shapely.get_parts(outside) if not g.is_empty][:8])
        lanes.append({"id": t["id"], "pts": [[rnd(x), rnd(y)] for x, y in sm]})
    out["lanes"] = lanes

    berths = []
    for b in BERTHS:
        beam = {"laker": 23.8, "fireboat": 5.8, "ccg": 5.0}[b["kind"]]
        r = snap_berth(b["p"], b["len"], beam, free, prep_free)
        print(f"berth {b['id']}: {'ok' if r else 'FAILED'} {r}")
        if r:
            berths.append({"id": b["id"], "kind": b["kind"], "name": b["name"], "len": b["len"],
                           "p": [rnd(r[0]), rnd(r[1])], "h": rnd(r[2], 3)})
    for b in ANCHORED:
        berths.append({"id": b["id"], "kind": b["kind"], "name": b["name"], "len": b["len"],
                       "p": list(b["p"]), "h": rnd(math.radians(b["heading"]), 3)})
    out["berths"] = berths

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB)")
    if debug:
        _debug_png(water, pier_obst, out)


def _debug_png(water, piers, out):
    """Scratch rasters (water blue, piers grey, output overlays) for eyeballing."""
    import rasterio
    from rasterio import features
    from rasterio.transform import Affine

    views = {
        "toronto": (-2500, -4000, 3500, -800, 4.0),
        "hamilton": (-44000, -44500, -33000, -36500, 10.0),
        "lake": (-45000, -52000, 20000, 0, 60.0),
    }
    for name, (x0, y0, x1, y1, px) in views.items():
        W, H = int((x1 - x0) / px), int((y1 - y0) / px)
        tr = Affine(px, 0, x0, 0, -px, y1)
        bb = box(x0, y0, x1, y1)
        img = np.full((3, H, W), 235, np.uint8)
        def burn(geoms, rgb, width=0.0):
            gs = [g.buffer(width) if width else g for g in geoms if g is not None and not g.is_empty and g.intersects(bb)]
            gs = [g.intersection(bb) for g in gs]
            gs = [g for g in gs if not g.is_empty]
            if not gs:
                return
            m = features.rasterize(gs, (H, W), transform=tr, fill=0, default_value=1, dtype=np.uint8).astype(bool)
            for k in range(3):
                img[k][m] = rgb[k]
        burn([water], (120, 170, 215))
        burn([piers], (90, 90, 90))
        w = px * 0.8
        burn([LineString(r["pts"]) for r in out["routes"]], (220, 30, 30), w)
        for z in out["zones"]:
            burn([LineString(lp + lp[:1]) for lp in z["loops"]], (30, 150, 60), w * 0.6)
        burn([LineString(t["loop"] + t["loop"][:1]) for t in out["tours"]], (230, 140, 0), w)
        burn([LineString(t["pts"]) for t in out["lanes"]], (120, 0, 160), w * 1.5)
        for b in out["berths"]:
            c, sn = math.cos(b["h"]), math.sin(b["h"])
            e, n = b["p"]
            burn([LineString([(e - c * b["len"] / 2, n - sn * b["len"] / 2), (e + c * b["len"] / 2, n + sn * b["len"] / 2)])], (200, 0, 0), max(px, 3))
        pts = [Point(b[0], b[1]) for m in out["marinas"] for b in m["boats"]]
        burn(pts, (255, 255, 255), max(px * 0.7, 2.5))
        # 1 km grid
        step = 1000 if px < 20 else 10000
        for gx in range(int(math.ceil(x0 / step)) * step, int(x1), step):
            c = min(int((gx - x0) / px), W - 1)
            img[:, :, c] = img[:, :, c] // 2
        for gy in range(int(math.ceil(y0 / step)) * step, int(y1), step):
            r = min(int((y1 - gy) / px), H - 1)
            img[:, r, :] = img[:, r, :] // 2
        p = geo.WORK / f"ferries_debug_{name}.png"
        with rasterio.open(p, "w", driver="PNG", width=W, height=H, count=3, dtype="uint8") as d:
            d.write(img)
        print("debug:", p, f"origin E{x0} N{y1} (top-left), {px} m/px, grid {step} m")


if __name__ == "__main__":
    build(debug="--debug" in sys.argv)
