"""Landmarks: match hand-modelled landmarks to their OSM footprints.

Emits ``app/public/data/landmarks.json`` (see docs/SPEC.md "Landmarks"):

    [{id, name, pos:[E,N], base, rotation, suppress:[osm ids], height,
      footprint:[[x,y],...], parts:{alias:[[x,y],...]}}]
    + waterfall entries {id, name, kind:"waterfall", line:[[E,N],...], top, bottom}

``footprint``/``parts`` are in the model's *canonical local frame*: metres
relative to ``pos`` and rotated by ``-rotation`` (x = canonical "east",
y = canonical "north"). A world point is ``pos + R(rotation) @ local``. The
client builders use these exact polygons (e.g. the TD Centre towers) so the
models sit on the real footprints.

``rotation`` is derived from the footprint's dominant edge direction folded to
[-45°, 45°) — for downtown Toronto this is the street grid (~+17°), so the
canonical frame is "grid-aligned": +x along King St, +y up Bay St.

``suppress`` = anchor ids + every OSM building/building:part whose
representative point lies inside the (slightly buffered) anchor footprints,
+ explicit extras. Ways positive, relations negative (same as ``b_osm``).

Run: ``cd pipeline && uv run python -m tpipe.landmarks``
"""

from __future__ import annotations

import json
import math
import time

import numpy as np
import osmium
from shapely import wkb
from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.ops import transform, unary_union

from . import geo, terrain

# Areas we scan (lon/lat boxes): downtown/midtown Toronto, Niagara Falls, Pearson.
BOXES = [
    (-79.42, 43.635, -79.36, 43.682),
    (-79.10, 43.06, -79.04, 43.10),
    (-79.63, 43.67, -79.59, 43.70),
]

# Each landmark: anchors = {alias: osm id} (ways +, relations -). The first
# anchor defines pos/rotation unless `center`/`rot_from` says otherwise.
#  - contain: also suppress buildings/parts inside the anchors (default True)
#  - suppress_extra: explicit extra ids
#  - parts_only: suppress only these ids (+ anchors), no containment search
#  - lonlat: position when there is no OSM object (planned/new buildings)
#  - rotation_deg: explicit rotation override (degrees CCW)
LANDMARKS: list[dict] = [
    dict(id="cn_tower", name="CN Tower", height=553.3,
         anchors={"base": 32742038, "leg": 288273458}, rot="cn_leg"),
    dict(id="rogers_centre", name="Rogers Centre", height=86,
         anchors={"stadium": 7969701}, partfoot={"bowl": 1104122006}),
    dict(id="td_centre", name="Toronto-Dominion Centre", height=222.9,
         anchors={"td_bank": 141693728, "td_north": 141693739, "td_south": 27767631,
                  "td_west": 27767634, "bay222": 141693951, "pavilion": 110166031},
         center="td_bank"),
    dict(id="first_canadian_place", name="First Canadian Place", height=298,
         anchors={"tower": 27767627}),
    dict(id="scotia_plaza", name="Scotia Plaza", height=275,
         anchors={"tower": 141694075, "outline": 366234303}),
    dict(id="commerce_court", name="Commerce Court", height=239,
         anchors={"west": 27767628, "north": 43417400, "south": 111661581, "east": 142739261},
         center="west"),
    dict(id="royal_bank_plaza", name="Royal Bank Plaza", height=180,
         anchors={"south": 27767625, "north": 27767624, "atrium": 151519194},
         rotation_deg=16.4),
    dict(id="brookfield_place", name="Brookfield Place", height=261,
         anchors={"podium": 34111206, "tdct": 34111207, "bwt": 286525278,
                  "galleria": 205385072},
         partfoot={"tdct_tower": 340689679, "bwt_tower": 340695625}),
    dict(id="cibc_square", name="CIBC Square", height=241,
         anchors={"south": 680567507, "north": 1551442415},
         partfoot={"south_tower": 953052241, "south_tower2": 680567506}),
    dict(id="td_160_front", name="160 Front Street West", height=239.9,
         anchors={"tower": 686163960}),
    dict(id="toronto_city_hall", name="Toronto City Hall", height=99.5,
         anchors={"podium": 198500761},
         partfoot={"east": 27767544, "west": 27767543, "council": 27767545}),
    dict(id="old_city_hall", name="Old City Hall", height=103.6,
         anchors={"building": -3116}, partfoot={"clock": 178252639}),
    dict(id="union_station", name="Union Station", height=32.5,
         anchors={"station": 14744491},
         partfoot={"hall": 290168042, "hall_mid": 290168050, "hall_low": 290168028}),
    dict(id="scotiabank_arena", name="Scotiabank Arena", height=45,
         anchors={"arena": 19882585}, partfoot={"bowl": 1104128156}),
    dict(id="royal_york", name="Fairmont Royal York", height=124,
         anchors={"base": 177879879, "hotel": 31728160}, center="hotel"),
    dict(id="pinnacle_one_yonge", name="Pinnacle One Yonge SkyTower", height=351,
         lonlat=(-79.37425, 43.64135), size=(42, 36), rotation_deg=16.7),
    dict(id="aura", name="Aura at College Park", height=272,
         anchors={"tower": 261802899}),
    dict(id="one_bloor_east", name="One Bloor East", height=257,
         anchors={"site": 303709935}, partfoot={"tower": 991851853}),
    dict(id="st_regis", name="The St. Regis Toronto", height=277,
         anchors={"tower": 25108216}),
    dict(id="shangri_la", name="Shangri-La Toronto", height=214,
         anchors={"tower": 25491342}, partfoot={"slab": 231773826}),
    dict(id="l_tower", name="L Tower", height=205,
         anchors={"tower": 238264282}),
    dict(id="rom_crystal", name="ROM Michael Lee-Chin Crystal", height=39,
         anchors={}, center_lonlat=(-79.39485, 43.66815), rotation_deg=16.7,
         parts_only=[992716633, 992716634, 992716635, 992716636, 992716637, 992716638,
                     992716639, 992716640]),
    dict(id="casa_loma", name="Casa Loma", height=37,
         anchors={"castle": 198471666}),
    dict(id="gooderham", name="Gooderham Building", height=22,
         anchors={"building": 300884214}),
    dict(id="skylon_tower", name="Skylon Tower", height=160,
         anchors={"tower": 241004747}, rotation_deg=0.0),
    dict(id="rainbow_bridge", name="Rainbow Bridge", height=0,
         bridge=-14629795, contain=False),
    dict(id="pearson_t1", name="Pearson Terminal 1", height=40,
         anchors={"terminal": 59439578}),
]

WATERFALLS = [
    # (id, name, osm way id, downstream reference lon/lat — the gorge side)
    ("horseshoe_falls", "Horseshoe Falls", 56539663, (-79.0735, 43.0833)),
    ("american_falls", "American Falls", 217355188, (-79.0725, 43.0850)),
    ("bridal_veil_falls", "Bridal Veil Falls", 515298933, (-79.0720, 43.0838)),
]
# Upper Niagara River at the brink ≈ 171.5 m ASL; Maid-of-the-Mist pool ≈ 100 m ASL.
FALLS_TOP_ASL = {"horseshoe_falls": 171.5, "american_falls": 170.0, "bridal_veil_falls": 170.0}
FALLS_BOTTOM_ASL = 100.0


def _in_boxes(lon: float, lat: float) -> bool:
    return any(a <= lon <= c and b <= lat <= d for a, b, c, d in BOXES)


def _proj(g):
    return transform(lambda x, y, z=None: geo.project(x, y), g)


def load_osm() -> tuple[dict, dict]:
    """Return (areas, lines): id -> (tags, projected geometry)."""
    fab = osmium.geom.WKBFactory()
    areas: dict[int, tuple[dict, object]] = {}
    lines: dict[int, tuple[dict, object]] = {}
    files = [geo.RAW / "bbox.osm.pbf"]
    ny = geo.RAW / "ny-niagara.osm.pbf"
    if ny.exists():
        files.append(ny)
    for f in files:
        fp = (osmium.FileProcessor(str(f)).with_locations().with_areas()
              .with_filter(osmium.filter.KeyFilter("building", "building:part", "waterway", "man_made")))
        for o in fp:
            try:
                if o.is_area():
                    g = wkb.loads(fab.create_multipolygon(o), hex=True)
                    oid = o.orig_id() if o.from_way() else -o.orig_id()
                    store = areas
                elif o.is_way() and "waterway" in o.tags:
                    g = wkb.loads(fab.create_linestring(o), hex=True)
                    oid = o.id
                    store = lines
                else:
                    continue
            except Exception:
                continue
            c = g.representative_point()
            if not _in_boxes(c.x, c.y) or oid in store:
                continue
            store[oid] = (dict(o.tags), _proj(g))
    return areas, lines


def _num(v):
    try:
        return round(float(str(v).split()[0].replace("m", "")), 2)
    except (TypeError, ValueError):
        return None


def dominant_angle(poly) -> float:
    """Length-weighted dominant edge direction folded to [-45°, 45°) (radians)."""
    polys = list(poly.geoms) if isinstance(poly, MultiPolygon) else [poly]
    ang, w = [], []
    for p in polys:
        c = np.asarray(p.exterior.coords)
        d = np.diff(c, axis=0)
        ang.append(np.arctan2(d[:, 1], d[:, 0]))
        w.append(np.hypot(d[:, 0], d[:, 1]))
    a = np.concatenate(ang)
    wt = np.concatenate(w)
    # Average on the circle with 4-fold symmetry.
    z = np.sum(wt * np.exp(4j * a))
    r = np.angle(z) / 4.0
    return float((r + math.pi / 4) % (math.pi / 2) - math.pi / 4)


def to_local(g, pos, rot):
    c, s = math.cos(-rot), math.sin(-rot)
    return transform(lambda x, y, z=None: ((x - pos[0]) * c - (y - pos[1]) * s,
                                           (x - pos[0]) * s + (y - pos[1]) * c), g)


def ring(g, tol=0.3) -> list[list[float]]:
    """Largest polygon's exterior, simplified, CCW, not closed."""
    if isinstance(g, MultiPolygon):
        g = max(g.geoms, key=lambda p: p.area)
    g = g.simplify(tol, preserve_topology=True)
    ext = g.exterior
    if not ext.is_ccw:
        ext = LineString(list(ext.coords)[::-1])
    return [[round(x, 2), round(y, 2)] for x, y in list(ext.coords)[:-1]]


def main() -> None:
    t0 = time.time()
    areas, lines = load_osm()
    print(f"loaded {len(areas)} areas, {len(lines)} waterway lines in {time.time() - t0:.0f}s")
    ter = terrain.get()
    bld = {i: (t, g) for i, (t, g) in areas.items() if "building" in t or "building:part" in t}
    reps = {i: g.representative_point() for i, (t, g) in bld.items()}

    out = []
    for L in LANDMARKS:
        anchors = L.get("anchors", {})
        missing = [a for a, i in anchors.items() if i not in areas]
        if missing:
            print(f"!! {L['id']}: missing anchors {missing}")
        geoms = {a: areas[i][1] for a, i in anchors.items() if i in areas}
        suppress: set[int] = set(i for i in anchors.values() if i in areas)

        if "bridge" in L:
            bg = areas[L["bridge"]][1]
            union = bg
        elif geoms:
            union = unary_union(list(geoms.values()))
        elif "parts_only" in L:
            union = unary_union([areas[i][1] for i in L["parts_only"] if i in areas])
        else:
            lon, lat = L["lonlat"]
            e, n = geo.project(lon, lat)
            w, d = L["size"]
            rr = math.radians(L.get("rotation_deg", 0))
            union = Polygon([(e + x * math.cos(rr) - y * math.sin(rr), n + x * math.sin(rr) + y * math.cos(rr))
                             for x, y in [(-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2)]])

        if L.get("contain", True) and "parts_only" not in L:
            claim = union.buffer(1.0)
            for i, p in reps.items():
                if claim.contains(p):
                    suppress.add(i)
        for i in L.get("parts_only", []) + L.get("suppress_extra", []):
            suppress.add(i)

        # Position & rotation
        if "center" in L:
            main_g = geoms[L["center"]]
        elif "center_lonlat" in L:
            main_g = Point(*geo.project(*L["center_lonlat"]))
        elif geoms:
            main_g = next(iter(geoms.values()))
        else:
            main_g = union
        cen = main_g.centroid
        pos = (cen.x, cen.y)
        if L.get("rot") == "cn_leg":
            leg = geoms["leg"].centroid
            a = math.atan2(leg.y - pos[1], leg.x - pos[0])
            # canonical: one leg points +y (90°); legs are 120° apart
            rot = (a - math.pi / 2 + math.pi / 3) % (2 * math.pi / 3) - math.pi / 3
        elif "rotation_deg" in L:
            rot = math.radians(L["rotation_deg"])
        elif "bridge" in L:
            mrr = union.minimum_rotated_rectangle
            c = np.asarray(mrr.exterior.coords)
            e = np.diff(c, axis=0)
            k = int(np.argmax(np.hypot(e[:, 0], e[:, 1])))
            rot = math.atan2(e[k, 1], e[k, 0])  # canonical: span along +x
            rot = (rot + math.pi / 2) % math.pi - math.pi / 2
        else:
            rot = dominant_angle(main_g if main_g.geom_type != "Point" else union)

        # Base elevation = min terrain under the footprint.
        pts = np.asarray(union.exterior.coords if union.geom_type == "Polygon"
                         else max(union.geoms, key=lambda p: p.area).exterior.coords)
        samp = np.vstack([pts, [[pos[0], pos[1]]]])
        base = float(np.min(ter.sample(samp[:, 0], samp[:, 1])))
        if "bridge" in L:
            # Origin at deck level: deck ≈ gorge rim; river surface from terrain at centre.
            c, s_ = math.cos(rot), math.sin(rot)
            ends = [(pos[0] + k * c * 180, pos[1] + k * s_ * 180) for k in (-1, 1)]
            rim = float(np.max(ter.sample(np.array([e[0] for e in ends]), np.array([e[1] for e in ends]))))
            river = float(ter.sample(np.array([pos[0]]), np.array([pos[1]]))[0])
            base = rim

        entry = {
            "id": L["id"], "name": L["name"],
            "pos": [round(pos[0], 2), round(pos[1], 2)],
            "base": round(base, 2), "rotation": round(rot, 5),
            "height": L["height"],
            "suppress": sorted(suppress, key=lambda v: (v < 0, abs(v))),
            "footprint": ring(to_local(union if "bridge" in L or not geoms else main_g, pos, rot)),
        }
        parts = {a: ring(to_local(g, pos, rot)) for a, g in geoms.items()}
        for a, i in L.get("partfoot", {}).items():
            if i in areas:
                parts[a] = ring(to_local(areas[i][1], pos, rot))
                entry["suppress"] = sorted(set(entry["suppress"]) | {i}, key=lambda v: (v < 0, abs(v)))
            else:
                print(f"!! {L['id']}: missing part {a}={i}")
        if "parts_only" in L:
            parts["crystal"] = ring(to_local(union, pos, rot))
        if parts:
            entry["parts"] = parts
        # Raw OSM 3D parts (building:part) replaced by this landmark, in the local
        # frame — builders may use them for exact massing.
        op = []
        for i in entry["suppress"]:
            if i not in bld or "building:part" not in bld[i][0]:
                continue
            t, g = bld[i]
            if g.area < 0.3:
                continue
            op.append({"id": i, "poly": ring(to_local(g, pos, rot), 0.2),
                       "h": _num(t.get("height")), "minH": _num(t.get("min_height")) or 0.0,
                       "roof": t.get("roof:shape", "flat"), "roofH": _num(t.get("roof:height")) or 0.0,
                       "roofDir": _num(t.get("roof:direction")),
                       "levels": _num(t.get("building:levels")), "minLevel": _num(t.get("building:min_level")),
                       "kind": t.get("building:part")})
        if op:
            entry["osmParts"] = op
        if "bridge" in L:
            entry["suppress"] = []
            b = union.minimum_rotated_rectangle
            lb = to_local(b, pos, rot).bounds
            entry["span"] = round(lb[2] - lb[0], 1)
            entry["river"] = round(river, 1)
        out.append(entry)
        print(f"{L['id']:22s} pos=({pos[0]:8.1f},{pos[1]:8.1f}) base={base:6.1f} "
              f"rot={math.degrees(rot):6.1f}° suppress={len(entry['suppress'])}")

    # Waterfalls: brink lines.
    for fid, name, wid, ref in WATERFALLS:
        if wid not in lines and wid not in areas:
            print(f"!! waterfall {fid} ({wid}) not found")
            continue
        g = lines[wid][1] if wid in lines else areas[wid][1].exterior
        coords = np.asarray(g.coords)
        rx, ry = geo.project(*ref)
        if np.allclose(coords[0], coords[-1]) and len(coords) > 4:
            # Closed outline: split at the two mutually farthest vertices and
            # keep the arc farther from the gorge (the upstream crest).
            c = coords[:-1]
            dmat = np.hypot(c[:, None, 0] - c[None, :, 0], c[:, None, 1] - c[None, :, 1])
            i, j = np.unravel_index(np.argmax(dmat), dmat.shape)
            i, j = sorted((int(i), int(j)))
            arc1 = c[i:j + 1]
            arc2 = np.vstack([c[j:], c[:i + 1]])

            def dist(a):
                return float(np.mean(np.hypot(a[:, 0] - rx, a[:, 1] - ry)))

            coords = arc1 if dist(arc1) > dist(arc2) else arc2
        top = FALLS_TOP_ASL[fid] - geo.DATUM_M
        out.append({
            "id": fid, "name": name, "kind": "waterfall", "osm": wid,
            "line": [[round(float(x), 2), round(float(y), 2)] for x, y in coords],
            "top": round(top, 1), "bottom": round(FALLS_BOTTOM_ASL - geo.DATUM_M, 1),
        })
        print(f"{fid:22s} {len(coords)} pts top={top:.1f}")

    geo.OUT.mkdir(parents=True, exist_ok=True)
    path = geo.OUT / "landmarks.json"
    path.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {path} ({len(out)} entries) in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
