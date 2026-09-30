"""Pass 1: stream the OSM extract once and pull out everything the tiles need.

Output: pipeline/work/osm_{buildings,lines,areas}.npz — compact, projected
(world metres) flat arrays, so the tiling pass can fork workers cheaply.

    uv run python -m tpipe.osm_extract [path.osm.pbf]
"""

from __future__ import annotations

import re
import sys
import time
from array import array

import numpy as np
import osmium

from . import geo

# --- classification tables -------------------------------------------------

ROAD_CLASS = {
    "motorway": 0, "motorway_link": 0, "trunk": 1, "trunk_link": 1,
    "primary": 2, "primary_link": 2, "secondary": 3, "secondary_link": 3,
    "tertiary": 4, "tertiary_link": 4, "residential": 5, "unclassified": 5,
    "service": 6, "living_street": 7, "pedestrian": 7, "road": 5, "busway": 6,
    "footway": 8, "cycleway": 8, "path": 8, "steps": 8, "bridleway": 8,
    "track": 9,
}
# default lanes (both directions) and lane width
ROAD_LANES = {0: 3, 1: 4, 2: 4, 3: 2, 4: 2, 5: 2, 6: 1, 7: 1, 8: 1, 9: 1}
FOOT_WIDTH = {"footway": 2.0, "cycleway": 2.5, "path": 1.8, "steps": 2.0, "bridleway": 2.0}

RAIL_CLASS = {"rail": 0, "subway": 2, "light_rail": 3, "tram": 4, "narrow_gauge": 5, "monorail": 5, "funicular": 5}

# ground raster classes (docs/SPEC.md)
G_WATER, G_GRASS, G_FOREST, G_RES, G_COM, G_IND, G_FARM, G_SAND = 1, 2, 3, 4, 5, 6, 7, 8
G_ROAD, G_RAIL, G_PARKING, G_CEM, G_GOLF, G_AERO, G_MAJOR, G_WET, G_INST = 9, 10, 11, 12, 13, 14, 15, 16, 17
G_CONS, G_PITCH, G_RUNWAY, G_PLAZA = 18, 19, 20, 21

LANDUSE = {
    "residential": G_RES, "commercial": G_COM, "retail": G_COM, "industrial": G_IND,
    "port": G_IND, "railway": G_RAIL, "farmland": G_FARM, "farmyard": G_FARM,
    "orchard": G_FARM, "vineyard": G_FARM, "greenhouse_horticulture": G_FARM,
    "plant_nursery": G_FARM, "forest": G_FOREST, "grass": G_GRASS, "meadow": G_GRASS,
    "recreation_ground": G_GRASS, "village_green": G_GRASS, "cemetery": G_CEM,
    "education": G_INST, "institutional": G_INST, "religious": G_INST,
    "construction": G_CONS, "brownfield": G_CONS, "greenfield": G_GRASS,
    "reservoir": G_WATER, "basin": G_WATER, "military": G_IND, "quarry": G_SAND,
    "landfill": G_CONS, "allotments": G_FARM, "flowerbed": G_GRASS,
}
NATURAL = {
    "water": G_WATER, "wood": G_FOREST, "scrub": G_GRASS, "grassland": G_GRASS,
    "heath": G_GRASS, "wetland": G_WET, "beach": G_SAND, "sand": G_SAND,
    "bare_rock": G_SAND, "shingle": G_SAND, "tree_row": G_FOREST,
}
LEISURE = {
    "park": G_GRASS, "garden": G_GRASS, "golf_course": G_GOLF, "pitch": G_PITCH,
    "track": G_PITCH, "stadium": G_PITCH, "playground": G_GRASS, "dog_park": G_GRASS,
    "nature_reserve": G_GRASS, "common": G_GRASS, "marina": G_WATER, "swimming_pool": G_WATER,
}
AMENITY = {
    "parking": G_PARKING, "school": G_INST, "university": G_INST, "college": G_INST,
    "hospital": G_INST, "grave_yard": G_CEM,
}
WATERWAY_WIDTH = {"river": 25.0, "canal": 15.0, "stream": 4.0, "drain": 2.0, "ditch": 1.5}

# building kinds (docs/SPEC.md)
BUILDING_KIND = {
    "house": 1, "detached": 1, "semidetached_house": 1, "terrace": 1, "bungalow": 1,
    "residential": 2, "apartments": 2, "dormitory": 2,
    "commercial": 3, "office": 3, "retail": 4, "supermarket": 4, "kiosk": 4,
    "industrial": 5, "warehouse": 5, "manufacture": 5, "storage_tank": 5, "hangar": 5,
    "civic": 6, "public": 6, "government": 6, "fire_station": 6, "townhall": 6,
    "school": 7, "university": 7, "college": 7, "kindergarten": 7,
    "church": 8, "mosque": 8, "temple": 8, "synagogue": 8, "cathedral": 8, "chapel": 8, "religious": 8,
    "train_station": 9, "transportation": 9, "station": 9,
    "hospital": 10, "garage": 11, "garages": 11, "shed": 11, "carport": 11, "hut": 11,
    "stadium": 12, "sports_hall": 12, "sports_centre": 12, "grandstand": 12,
    "hotel": 13, "parking": 14, "roof": 15, "canopy": 15,
    "farm": 1, "farm_auxiliary": 11, "barn": 5, "greenhouse": 5, "cabin": 1,
}
ROOF = {"flat": 0, "gabled": 1, "hipped": 2, "dome": 3, "pyramidal": 4, "skillion": 5,
        "half-hipped": 2, "gambrel": 1, "mansard": 2, "onion": 3, "round": 3}

_num = re.compile(r"[-+]?\d*\.?\d+")


def _metres(v: str | None) -> float:
    if not v:
        return np.nan
    m = _num.search(v.replace(",", "."))
    if not m:
        return np.nan
    x = float(m.group())
    if "'" in v or "ft" in v:
        x *= 0.3048
    return x


def _colour(v: str | None) -> int:
    if not v:
        return 0
    v = v.strip().lower()
    if v.startswith("#") and len(v) in (4, 7):
        if len(v) == 4:
            v = "#" + "".join(c * 2 for c in v[1:])
        try:
            return int(v[1:], 16)
        except ValueError:
            return 0
    return NAMED_COLOURS.get(v, 0)


NAMED_COLOURS = {
    "white": 0xF2F2EE, "black": 0x2A2A2A, "grey": 0x9A9A9A, "gray": 0x9A9A9A,
    "red": 0xA0443A, "brown": 0x7A5A44, "beige": 0xD8CCAE, "yellow": 0xD9C36A,
    "blue": 0x5B7FA6, "green": 0x6C8A5C, "tan": 0xC8AE88, "orange": 0xC8793A,
    "silver": 0xBFC3C7, "gold": 0xC9A64A, "maroon": 0x6E2A2A, "pink": 0xD8A0A0,
    "darkgray": 0x555555, "darkgrey": 0x555555, "lightgrey": 0xCCCCCC, "lightgray": 0xCCCCCC,
}


def _ground_class(t) -> int:
    for key, table in (("natural", NATURAL), ("leisure", LEISURE), ("landuse", LANDUSE), ("amenity", AMENITY)):
        v = t.get(key)
        if v and v in table:
            return table[v]
    if t.get("waterway") in ("riverbank", "dock", "canal") or "water" in t:
        return G_WATER
    ae = t.get("aeroway")
    if ae in ("runway", "taxiway", "apron", "helipad"):
        return G_RUNWAY
    if ae == "aerodrome":
        return G_AERO
    if t.get("highway") == "pedestrian" or t.get("place") == "square" or t.get("railway") == "platform" \
            or t.get("public_transport") == "platform":
        return G_PLAZA
    if t.get("man_made") in ("pier", "breakwater"):
        return G_PLAZA
    return 0


class Collector:
    def __init__(self):
        # buildings
        self.b_id = array("d")
        self.b_part = array("b")
        self.b_nring = array("I")
        self.b_ringlen = array("I")
        self.b_lon = array("d")
        self.b_lat = array("d")
        self.b_height = array("f")
        self.b_min = array("f")
        self.b_levels = array("f")
        self.b_minlevel = array("f")
        self.b_roofh = array("f")
        self.b_kind = array("B")
        self.b_roof = array("B")
        self.b_color = array("I")
        self.b_tag = []  # raw building value (for house heuristics)
        # lines (roads, rail, waterways, coastline)
        self.l_kind = array("B")  # 0 road, 1 rail, 2 waterway, 3 coastline, 4 runway/taxiway
        self.l_class = array("B")
        self.l_id = array("d")
        self.l_len = array("I")
        self.l_lon = array("d")
        self.l_lat = array("d")
        self.l_nid = array("q")
        self.l_speed = array("f")
        self.l_width = array("f")
        self.l_lanes = array("B")
        self.l_flags = array("B")
        self.l_layer = array("b")
        self.l_name = []
        self.l_side = array("B")  # sidewalk code (SIDEWALK below)
        # landcover areas
        self.a_class = array("B")
        self.a_id = array("d")
        self.a_nring = array("I")
        self.a_ringlen = array("I")
        self.a_lon = array("d")
        self.a_lat = array("d")
        # nodes of interest: 0 signals, 1 stop sign, 2 crossing, 3 tree, 4 street lamp
        self.n_kind = array("B")
        self.n_var = array("B")  # crossing: 0 unmarked, 1 zebra/ladder, 2 lines · tree: 0 broadleaf, 1 conifer
        self.n_id = array("q")
        self.n_lon = array("d")
        self.n_lat = array("d")
        # natural=tree_row ways (sampled into tree points after projection)
        self.tr_len = array("I")
        self.tr_lon = array("d")
        self.tr_lat = array("d")

    # ---- helpers
    def _rings(self, a, lon, lat, ringlen) -> int:
        n = 0
        for outer in a.outer_rings():
            k = self._ring(outer, lon, lat, ringlen)
            if k:
                n += 1
            for inner in a.inner_rings(outer):
                if self._ring(inner, lon, lat, ringlen):
                    n += 1
            break  # buildings/landcover: first outer ring is enough for buildings
        return n

    def _all_rings(self, a, lon, lat, ringlen, nring, cls_arr, cls, id_arr, oid) -> None:
        # each outer ring (with its holes) becomes its own polygon record
        for outer in a.outer_rings():
            n = 0
            if self._ring(outer, lon, lat, ringlen):
                n += 1
                for inner in a.inner_rings(outer):
                    if self._ring(inner, lon, lat, ringlen):
                        n += 1
                nring.append(n)
                cls_arr.append(cls)
                id_arr.append(oid)

    @staticmethod
    def _ring(ring, lon, lat, ringlen) -> bool:
        pts = [(n.lon, n.lat) for n in ring]
        if len(pts) < 4:
            return False
        pts = pts[:-1]  # drop closing vertex
        for x, y in pts:
            lon.append(x)
            lat.append(y)
        ringlen.append(len(pts))
        return True

    # ---- handlers
    def area(self, a) -> None:
        t = a.tags
        oid = float(a.orig_id() if a.from_way() else -a.orig_id())
        bval = t.get("building")
        part = t.get("building:part")
        if (bval and bval != "no") or (part and part != "no"):
            n = self._rings(a, self.b_lon, self.b_lat, self.b_ringlen)
            if not n:
                return
            self.b_nring.append(n)
            self.b_id.append(oid)
            self.b_part.append(1 if (part and part != "no" and not bval) else 0)
            self.b_height.append(_metres(t.get("height")))
            self.b_min.append(_metres(t.get("min_height")))
            self.b_levels.append(_metres(t.get("building:levels")))
            self.b_minlevel.append(_metres(t.get("building:min_level")))
            self.b_roofh.append(_metres(t.get("roof:height")))
            kind = BUILDING_KIND.get(bval or part or "", 0)
            if kind == 0:
                if t.get("amenity") in ("place_of_worship",):
                    kind = 8
                elif t.get("amenity") in ("school", "university", "college"):
                    kind = 7
                elif t.get("amenity") == "hospital":
                    kind = 10
                elif t.get("shop"):
                    kind = 4
                elif t.get("office"):
                    kind = 3
                elif t.get("tourism") == "hotel":
                    kind = 13
            self.b_kind.append(kind)
            self.b_roof.append(ROOF.get(t.get("roof:shape", ""), 0))
            self.b_color.append(_colour(t.get("building:colour") or t.get("colour")))
            self.b_tag.append(bval or "part")
            return
        cls = _ground_class(t)
        if cls:
            self._all_rings(a, self.a_lon, self.a_lat, self.a_ringlen, self.a_nring,
                            self.a_class, cls, self.a_id, oid)

    def way(self, w) -> None:
        t = w.tags
        if t.get("natural") == "tree_row":
            pts = [(n.lon, n.lat) for n in w.nodes if n.location.valid()]
            if len(pts) >= 2:
                for x, y in pts:
                    self.tr_lon.append(x)
                    self.tr_lat.append(y)
                self.tr_len.append(len(pts))
            return
        hw = t.get("highway")
        rw = t.get("railway")
        ww = t.get("waterway")
        kind = cls = None
        width = 0.0
        lanes = 0
        if hw in ROAD_CLASS and t.get("area") != "yes":
            kind, cls = 0, ROAD_CLASS[hw]
            ln = _metres(t.get("lanes"))
            oneway = t.get("oneway") in ("yes", "1", "true", "-1") or t.get("junction") == "roundabout" \
                or (cls == 0 and t.get("oneway") != "no")
            lanes = int(ln) if ln == ln and ln > 0 else (ROAD_LANES[cls] if not oneway else max(1, ROAD_LANES[cls] // 2 + (cls <= 1)))
            w_tag = _metres(t.get("width"))
            if w_tag == w_tag and 1 < w_tag < 60:
                width = w_tag
            elif cls == 8:
                width = FOOT_WIDTH.get(hw, 2.0)
            elif cls == 9:
                width = 3.0
            else:
                width = lanes * (3.6 if cls <= 1 else 3.3) + (3.0 if cls <= 1 else 1.0)
        elif rw in RAIL_CLASS and t.get("service") is None and t.get("usage") not in ("tourism",):
            kind, cls = 1, RAIL_CLASS[rw]
            width = 3.2
        elif rw in RAIL_CLASS:
            kind, cls = 1, 1  # sidings / yards / spurs
            width = 3.2
        elif ww in WATERWAY_WIDTH and t.get("tunnel") not in ("culvert", "yes"):
            kind, cls = 2, 0
            width = _metres(t.get("width"))
            if not (width == width and 0.5 < width < 400):
                width = WATERWAY_WIDTH[ww]
        elif t.get("natural") == "coastline":
            kind, cls = 3, 0
        elif t.get("aeroway") in ("runway", "taxiway"):
            kind, cls = 4, 0
            width = _metres(t.get("width"))
            if not (width == width and 5 < width < 100):
                width = 45.0 if t.get("aeroway") == "runway" else 23.0
        else:
            return
        pts = [(n.lon, n.lat, n.ref) for n in w.nodes if n.location.valid()]
        if len(pts) < 2:
            return
        flags = 0
        if t.get("oneway") in ("yes", "1", "true") or t.get("junction") == "roundabout":
            flags |= 1
        if t.get("oneway") == "-1":
            flags |= 1
            pts.reverse()
        if kind == 0 and cls == 0 and t.get("oneway") != "no":
            flags |= 1
        if t.get("bridge") not in (None, "no"):
            flags |= 2
        if t.get("tunnel") not in (None, "no") or t.get("covered") == "yes" and kind == 1:
            flags |= 4
        if hw and hw.endswith("_link"):
            flags |= 8
        if t.get("junction") == "roundabout":
            flags |= 16
        layer = _metres(t.get("layer"))
        for x, y, ref in pts:
            self.l_lon.append(x)
            self.l_lat.append(y)
            self.l_nid.append(ref)
        self.l_len.append(len(pts))
        self.l_kind.append(kind)
        self.l_class.append(cls)
        self.l_id.append(float(w.id))
        self.l_width.append(width)
        self.l_lanes.append(min(lanes, 255))
        self.l_flags.append(flags)
        self.l_layer.append(int(max(-5, min(5, layer))) if layer == layer else 0)
        self.l_name.append(t.get("name") or t.get("ref") or "")
        self.l_side.append(_sidewalk(t) if kind == 0 else 0)
        sp = _metres(t.get("maxspeed"))
        if sp == sp and "mph" in (t.get("maxspeed") or ""):
            sp *= 1.609
        self.l_speed.append(sp)

    def node(self, n) -> None:
        t = n.tags
        hw = t.get("highway")
        k = {"traffic_signals": 0, "stop": 1, "crossing": 2, "street_lamp": 4}.get(hw)
        var = 0
        if k is None and t.get("natural") == "tree":
            k = 3
            var = 1 if t.get("leaf_type") == "needleleaved" else 0
        if k is None:
            return
        if k == 2:
            var = _crossing_markings(t)
        self.n_kind.append(k)
        self.n_var.append(var)
        self.n_id.append(n.id)
        self.n_lon.append(n.location.lon)
        self.n_lat.append(n.location.lat)


# r_side codes (docs/SPEC.md): 0 untagged, 1 none, 2 left, 3 right, 4 both, 5 separate,
# 6 footway=sidewalk, 7 footway=crossing
SIDEWALK = {"no": 1, "none": 1, "left": 2, "right": 3, "both": 4, "yes": 4, "separate": 5}


def _sidewalk(t) -> int:
    fw = t.get("footway")
    if fw == "sidewalk" or t.get("path") == "sidewalk" or t.get("cycleway") == "sidewalk":
        return 6
    if fw == "crossing" or t.get("cycleway") == "crossing" or t.get("path") == "crossing":
        return 7
    v = t.get("sidewalk") or t.get("sidewalk:both")
    if v in SIDEWALK:
        return SIDEWALK[v]
    left = t.get("sidewalk:left") in ("yes", "separate")
    right = t.get("sidewalk:right") in ("yes", "separate")
    if t.get("sidewalk:left") == "separate" and t.get("sidewalk:right") == "separate":
        return 5
    if left and right:
        return 4
    if left:
        return 2
    if right:
        return 3
    if t.get("sidewalk:left") == "no" and t.get("sidewalk:right") == "no":
        return 1
    return 0


def _crossing_markings(t) -> int:
    """0 unmarked, 1 zebra/ladder (continental bars), 2 two transverse lines."""
    m = t.get("crossing:markings")
    c = t.get("crossing")
    ref = t.get("crossing_ref")
    if m in ("no", "surface"):
        return 0
    if m in ("zebra", "ladder", "ladder:skewed", "zebra:double", "dashes") or c == "zebra" or ref == "zebra":
        return 1
    if m in ("lines", "lines:paired", "dots", "yes") or c in ("marked", "traffic_signals", "uncontrolled"):
        return 2
    return 0


KEYS = ("building", "building:part", "highway", "railway", "waterway", "natural", "landuse",
        "leisure", "amenity", "aeroway", "water", "place", "man_made", "public_transport")


def run(path: str) -> None:
    c = Collector()
    t0 = time.time()
    fp = (
        osmium.FileProcessor(path)
        .with_locations(osmium.index.create_map("flex_mem"))
        .with_areas()
        .with_filter(osmium.filter.KeyFilter(*KEYS))
    )
    n = 0
    for obj in fp:
        n += 1
        if obj.is_area():
            c.area(obj)
        elif obj.is_way():
            c.way(obj)
        elif obj.is_node():
            c.node(obj)
        if n % 2_000_000 == 0:
            print(f"  {n:,} objects, {len(c.b_id):,} buildings, {len(c.l_len):,} lines, {time.time() - t0:.0f}s", flush=True)
    print(f"parsed in {time.time() - t0:.0f}s: {len(c.b_id):,} buildings, {len(c.l_len):,} lines, {len(c.a_class):,} areas")

    def proj(lon, lat):
        x, y = geo.project(np.frombuffer(lon, dtype=np.float64), np.frombuffer(lat, dtype=np.float64))
        return np.stack([x, y], axis=1).astype(np.float64)

    def arr(a, dt):
        return np.frombuffer(a, dtype=dt) if len(a) else np.zeros(0, dtype=dt)

    geo.WORK.mkdir(parents=True, exist_ok=True)
    np.savez(
        geo.WORK / "osm_buildings.npz",
        id=arr(c.b_id, np.float64), part=arr(c.b_part, np.int8), nring=arr(c.b_nring, np.uint32),
        ringlen=arr(c.b_ringlen, np.uint32), xy=proj(c.b_lon, c.b_lat),
        height=arr(c.b_height, np.float32), min=arr(c.b_min, np.float32),
        levels=arr(c.b_levels, np.float32), minlevel=arr(c.b_minlevel, np.float32),
        roofh=arr(c.b_roofh, np.float32), kind=arr(c.b_kind, np.uint8), roof=arr(c.b_roof, np.uint8),
        color=arr(c.b_color, np.uint32), tag=np.array(c.b_tag, dtype=object),
    )
    np.savez(
        geo.WORK / "osm_lines.npz",
        kind=arr(c.l_kind, np.uint8), cls=arr(c.l_class, np.uint8), id=arr(c.l_id, np.float64),
        len=arr(c.l_len, np.uint32), xy=proj(c.l_lon, c.l_lat), width=arr(c.l_width, np.float32),
        lanes=arr(c.l_lanes, np.uint8), flags=arr(c.l_flags, np.uint8), layer=arr(c.l_layer, np.int8),
        name=np.array(c.l_name, dtype=object), nid=arr(c.l_nid, np.int64), speed=arr(c.l_speed, np.float32),
        side=arr(c.l_side, np.uint8),
    )
    np.savez(
        geo.WORK / "osm_areas.npz",
        cls=arr(c.a_class, np.uint8), id=arr(c.a_id, np.float64), nring=arr(c.a_nring, np.uint32),
        ringlen=arr(c.a_ringlen, np.uint32), xy=proj(c.a_lon, c.a_lat),
    )
    nx, ny = geo.project(np.frombuffer(c.n_lon, dtype=np.float64), np.frombuffer(c.n_lat, dtype=np.float64)) \
        if len(c.n_lon) else (np.zeros(0), np.zeros(0))
    kind, var, nid = arr(c.n_kind, np.uint8), arr(c.n_var, np.uint8), arr(c.n_id, np.int64)
    nxy = np.stack([nx, ny], axis=1)
    # tree rows -> one tree every ~8 m along each row
    if len(c.tr_len):
        tx, ty = geo.project(np.frombuffer(c.tr_lon, dtype=np.float64), np.frombuffer(c.tr_lat, dtype=np.float64))
        toff = np.concatenate([[0], np.cumsum(np.frombuffer(c.tr_len, dtype=np.uint32))]).astype(np.int64)
        rows = []
        for i in range(len(toff) - 1):
            p = np.stack([tx[toff[i]:toff[i + 1]], ty[toff[i]:toff[i + 1]]], 1)
            seg = np.hypot(*np.diff(p, axis=0).T)
            cum = np.concatenate([[0], np.cumsum(seg)])
            if cum[-1] < 1:
                continue
            k = max(1, int(round(cum[-1] / 8.0)))
            s = (np.arange(k) + 0.5) * cum[-1] / k
            rows.append(np.stack([np.interp(s, cum, p[:, 0]), np.interp(s, cum, p[:, 1])], 1))
        if rows:
            R = np.vstack(rows)
            nxy = np.vstack([nxy, R])
            kind = np.concatenate([kind, np.full(len(R), 3, np.uint8)])
            var = np.concatenate([var, np.zeros(len(R), np.uint8)])
            nid = np.concatenate([nid, np.zeros(len(R), np.int64)])
        print(f"tree rows: {len(toff) - 1:,} -> {sum(len(r) for r in rows):,} trees")
    print("nodes by kind:", np.bincount(kind, minlength=5).tolist())
    np.savez(geo.WORK / "osm_nodes.npz", kind=kind, var=var, id=nid, xy=nxy)
    print(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 else str(geo.WORK / "combined.osm.pbf"))
