"""Derive the simulated region polygon.

Rule (region-agnostic, re-run when GO opens stations):
  1. Every GO *train* station from the GO GTFS feed.
  2. The lower-tier municipality (admin_level 8) containing each station.
     If that municipality belongs to a Regional Municipality (admin_level 6
     "... Region" or a single-tier city, not a County), include the
     whole upper tier too — "err on the side of more".
  3. Extras: Waterloo (no GO train, but fused with Kitchener) and a slice of
     New York around Niagara Falls.
  4. A corridor buffer around every GO/VIA/UP rail shape so trains never run
     through empty map.
Writes pipeline/work/region.wkb and region.json (municipality list).
"""

from __future__ import annotations

import csv
import io
import json
import zipfile

import numpy as np
import osmium
import shapely
from shapely import wkb
from shapely.geometry import LineString, Point, box
from shapely.ops import transform, unary_union

from . import geo

CORRIDOR_M = 3000.0
EXTRA_MUNICIPALITIES = {"Waterloo"}
# Niagara Falls NY, Lewiston and the US bank of the river (lon/lat box).
NY_SLICE = (-79.08, 42.95, -78.90, 43.27)


def _read_gtfs(zip_name: str, table: str):
    with zipfile.ZipFile(geo.RAW / "gtfs" / zip_name) as z:
        with z.open(f"{table}.txt") as f:
            yield from csv.DictReader(io.TextIOWrapper(f, "utf-8-sig"))


def rail_stations_and_shapes():
    """(station points lon/lat, rail shape linestrings lon/lat) for GO+UP+VIA."""
    stations: list[tuple[float, float]] = []
    lines: list[LineString] = []
    for feed, rail_types in (("go.zip", {"2"}), ("up.zip", {"2"}), ("via.zip", {"2"})):
        rail_routes = {r["route_id"] for r in _read_gtfs(feed, "routes") if r["route_type"] in rail_types}
        trips = [t for t in _read_gtfs(feed, "trips") if t["route_id"] in rail_routes]
        shape_ids = {t["shape_id"] for t in trips if t.get("shape_id")}
        trip_ids = {t["trip_id"] for t in trips}
        stop_ids = {st["stop_id"] for st in _read_gtfs(feed, "stop_times") if st["trip_id"] in trip_ids}
        if feed == "go.zip":
            stations += [
                (float(s["stop_lon"]), float(s["stop_lat"]))
                for s in _read_gtfs(feed, "stops")
                if s["stop_id"] in stop_ids
            ]
        pts: dict[str, list] = {}
        for p in _read_gtfs(feed, "shapes"):
            if p["shape_id"] in shape_ids:
                pts.setdefault(p["shape_id"], []).append(
                    (int(p["shape_pt_sequence"]), float(p["shape_pt_lon"]), float(p["shape_pt_lat"]))
                )
        for seq in pts.values():
            seq.sort()
            if len(seq) > 1:
                lines.append(LineString([(x, y) for _, x, y in seq]))
    return stations, lines


class _Admin(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.areas: list[tuple[str, str, object]] = []
        self.fab = osmium.geom.WKBFactory()

    def area(self, a):
        t = a.tags
        if t.get("boundary") != "administrative" or t.get("admin_level") not in ("6", "8"):
            return
        try:
            g = wkb.loads(self.fab.create_multipolygon(a), hex=True)
        except Exception:
            return
        self.areas.append((t.get("admin_level"), t.get("name", ""), g))


def _proj(g):
    return transform(lambda x, y, z=None: geo.project(x, y), g)


def build() -> None:
    stations, shapes = rail_stations_and_shapes()
    print(f"{len(stations)} GO train stations, {len(shapes)} rail shapes")

    h = _Admin()
    h.apply_file(str(geo.WORK / "admin.osm.pbf"), locations=True, idx="flex_mem")
    lvl6 = [(n, g) for lv, n, g in h.areas if lv == "6"]
    lvl8 = [(n, g) for lv, n, g in h.areas if lv == "8"]
    print(f"admin areas: {len(lvl6)} level-6, {len(lvl8)} level-8")

    pts = [Point(p) for p in stations]
    chosen: dict[str, object] = {}
    for p in pts:
        hit8 = [(n, g) for n, g in lvl8 if g.contains(p)]
        hit6 = [(n, g) for n, g in lvl6 if g.contains(p)]
        for n, g in hit6:
            # Regional municipalities and single-tier cities are taken whole;
            # counties only contribute the station's own municipality.
            if "County" not in n:
                chosen[n] = g
        for n, g in hit8:
            chosen[n] = g
    for n, g in lvl8:
        if n in EXTRA_MUNICIPALITIES or n.replace("City of ", "") in EXTRA_MUNICIPALITIES:
            chosen[n] = g
    # lower-tier municipalities inside chosen regional municipalities (for labels)
    regions = [g for n, g in chosen.items() if "Region" in n]
    members = {n: g for n, g in lvl8 if any(r.contains(g.representative_point()) for r in regions)}
    chosen.update(members)
    print("municipalities:", sorted(chosen))

    area_ll = unary_union(list(chosen.values()) + [box(*NY_SLICE)])
    region = _proj(area_ll)
    bx = _proj(box(*geo.BBOX_LONLAT))
    corridor = unary_union([_proj(s) for s in shapes]).buffer(CORRIDOR_M)
    region = unary_union([region, corridor]).intersection(bx)
    region = shapely.make_valid(region.buffer(0))
    print(f"region area {region.area / 1e6:,.0f} km²")

    geo.WORK.mkdir(parents=True, exist_ok=True)
    (geo.WORK / "region.wkb").write_bytes(region.wkb)
    labels = []
    for n, g in sorted(chosen.items()):
        if "Region" in n:
            continue
        c = _proj(g).representative_point()
        labels.append({"name": n.replace("City of ", "").replace("Town of ", ""), "label": [round(c.x), round(c.y)]})
    (geo.WORK / "region.json").write_text(json.dumps({"municipalities": labels}, indent=1))


def load():
    return wkb.loads((geo.WORK / "region.wkb").read_bytes())


if __name__ == "__main__":
    build()
