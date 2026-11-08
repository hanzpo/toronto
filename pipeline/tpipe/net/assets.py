"""Tag -> network asset mapping. Every relevant OSM tag has a defined effect on the cross-section
(docs/INTERACTIONS.md "Tag modelling rules"); judgement only fills tags that are missing.

Assets are emitted in the engine's format (app/src/net/core/assets.ts) and deduplicated by content."""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass, field

ROAD_RANK = {
    "motorway": 0, "motorway_link": 1, "trunk": 1, "trunk_link": 1, "primary": 2, "primary_link": 3,
    "secondary": 3, "secondary_link": 3, "tertiary": 4, "tertiary_link": 4, "residential": 5, "unclassified": 5,
    "road": 5, "living_street": 5, "service": 6, "busway": 4,
}
PATHS = {"footway", "path", "cycleway", "pedestrian", "steps", "bridleway", "track"}

Json = dict[str, object]


@dataclass
class Track:
    lat: float
    dir: int
    kind: str = "embedded"


@dataclass
class RoadCtx:
    sidewalk_l: bool | None = None
    sidewalk_r: bool | None = None
    tracks: list[Track] = field(default_factory=list)
    dense: bool = True
    tram_row: bool = False


class AssetTable:
    def __init__(self) -> None:
        self.assets: dict[str, Json] = {}

    def add(self, a: Json) -> str:
        body = json.dumps(a, sort_keys=True)
        aid = f"{a['family']}_{hashlib.sha1(body.encode()).hexdigest()[:10]}"
        if aid not in self.assets:
            self.assets[aid] = {**a, "id": aid}
        return aid


def _num(v: str | None) -> float | None:
    if not v:
        return None
    m = re.search(r"[-+]?\d*\.?\d+", v.replace(",", "."))
    if not m:
        return None
    x = float(m.group())
    if "mph" in v:
        x *= 1.609
    return x


def _int(v: str | None) -> int | None:
    x = _num(v)
    return None if x is None else max(0, int(round(x)))


def is_oneway(t: dict[str, str]) -> int:
    o = t.get("oneway")
    if o in ("yes", "1", "true"):
        return 1
    if o == "-1":
        return -1
    if t.get("highway") in ("motorway", "motorway_link") or t.get("junction") in ("roundabout", "circular"):
        return 0 if o == "no" else 1
    return 0


def _side(t: dict[str, str], key: str, side: str) -> str | None:
    for k in (f"{key}:{side}", f"{key}:both", key):
        v = t.get(k)
        if v is None:
            continue
        if k == key and v in ("left", "right"):
            return "yes" if v == side else "no"
        if k == key and v == "both":
            return "yes"
        return v
    return None


def _lane(dir: int, cls: list[str], speed: float, track: str | None = None) -> Json:
    out: Json = {"dir": dir, "cls": cls, "speed": speed}
    if track:
        out["track"] = track
    return out


def road(t: dict[str, str], ctx: RoadCtx) -> Json:
    hw = t.get("highway", "residential")
    rank = ROAD_RANK.get(hw, 5)
    one = is_oneway(t)
    speed = _num(t.get("maxspeed")) or {0: 100, 1: 80, 2: 60, 3: 50, 4: 50, 5: 40, 6: 20}[rank]
    n = _int(t.get("lanes"))
    nf, nb = _int(t.get("lanes:forward")), _int(t.get("lanes:backward"))
    if one:
        nf, nb = (n or nf or (3 if rank == 0 else 2 if rank <= 2 else 1)), 0
    else:
        if nf is None or nb is None:
            tot = n or (4 if rank <= 2 else 2)
            nb = tot // 2 if nb is None else nb
            nf = tot - nb if nf is None else nf
        nf, nb = max(1, nf), max(1, nb)
    lw = {0: 3.75, 1: 3.6, 2: 3.4, 3: 3.3, 4: 3.3, 5: 3.3, 6: 3.0}[rank]
    if rank == 5 and nf + nb == 2:
        lw = 4.0
    if hw == "service" and t.get("service") == "alley":
        lw = 2.5
    freeway = rank <= 1 and (one or hw in ("motorway", "motorway_link") or t.get("motorroad") == "yes")
    cls = ["car", "bus", "truck"] + ([] if freeway else ["bike"])
    psv = t.get("access") in ("no", "private") and (t.get("bus") == "yes" or t.get("psv") == "yes")
    if hw == "busway" or psv:
        cls = ["bus"]

    def sw_present(side: str, given: bool | None) -> bool:
        if given is not None:
            return given
        v = _side(t, "sidewalk", side)
        if v in ("no", "none"):
            return False
        if v in ("yes", "separate", "both", "left", "right"):
            return True
        return rank in (2, 3, 4, 5) and not freeway and hw != "service"

    swl, swr = sw_present("left", ctx.sidewalk_l), sw_present("right", ctx.sidewalk_r)
    bands: list[Json] = []
    sw_w = 2.4 if rank <= 3 else 1.8
    def walk_side(left: bool) -> list[Json]:
        out: list[Json] = [{"kind": "sidewalk", "w": sw_w, "h": 0.15, "mat": "concrete", "lanes": [{"dir": 1, "cls": ["ped"]}]}]
        if rank <= 3 and ctx.dense:
            out.append({"kind": "furniture", "w": 1.5, "h": 0.15, "mat": "pavers", "slots": [
                {"kind": "tree", "spacing": 12, "phase": 4 if left else 10, "at": 0},
                {"kind": "lamp", "spacing": 32, "phase": 15 if left else 0, "at": 0}]})
        elif rank <= 5:
            out.append({"kind": "boulevard", "w": 2.2 if rank >= 4 else 2.8, "h": 0.15, "mat": "grass", "slots": [
                {"kind": "tree", "spacing": 11, "phase": 4 if left else 9, "at": 0},
                {"kind": "lamp_res", "spacing": 38, "phase": 12 if left else 31, "at": 0.3}]})
        return out if left else list(reversed(out))

    def extras(side: str) -> list[Json]:
        out: list[Json] = []
        cy = _side(t, "cycleway", side)
        if cy in ("lane", "track", "shared_busway", "separate") and cy != "separate":
            out.append({"kind": "bike", "w": 1.8, "h": 0, "mat": "asphalt", "lanes": [{"dir": 1 if side == "right" else -1, "cls": ["bike"]}]})
        pk = _side(t, "parking", side) or _side(t, "parking:lane", side)
        if pk in ("lane", "parallel", "on_street", "street_side", "half_on_kerb", "diagonal"):
            out.append({"kind": "parking", "w": 2.4, "h": 0, "mat": "asphalt"})
        return out

    if freeway:
        bands.append({"kind": "verge", "w": 1.5, "h": -0.05, "h1": -0.5, "mat": "grass"})
        bands.append({"kind": "shoulder", "w": 1.2 if one else 2.5, "h": 0, "mat": "asphalt_dark"})
    else:
        if swl:
            bands += walk_side(True)
        bands += list(reversed(extras("left")))
    trams = sorted(ctx.tracks, key=lambda q: -q.lat)
    lanes_back = [{"kind": "lane", "w": lw, "h": 0, "mat": "asphalt", "lanes": [_lane(-1, cls, speed / 3.6)]} for _ in range(nb)]
    lanes_fwd = [{"kind": "lane", "w": lw, "h": 0, "mat": "asphalt", "lanes": [_lane(1, cls, speed / 3.6)]} for _ in range(nf)]
    lane_bands = lanes_back + lanes_fwd
    if trams and ctx.tram_row and lanes_back and lanes_fwd:
        lane_bands = lanes_back + [
            {"kind": "row_edge", "w": 0.8, "h": 0.15, "mat": "row_slab"},
            {"kind": "row", "w": 7.0, "h": 0.1, "mat": "row_slab", "lanes": [
                {"dir": -1, "cls": ["tram"], "off": -1.75, "track": "slab", "speed": 13.9},
                {"dir": 1, "cls": ["tram"], "off": 1.75, "track": "slab", "speed": 13.9}],
             "slots": [{"kind": "ocs_pole", "spacing": 32, "phase": 6, "at": 0}]},
            {"kind": "row_edge", "w": 0.8, "h": 0.15, "mat": "row_slab"},
        ] + lanes_fwd
        trams = []
    if trams:
        W = sum(float(b["w"]) for b in lane_bands)  # type: ignore[arg-type]
        x = W / 2
        centres = []
        for b in lane_bands:
            centres.append(x - float(b["w"]) / 2)  # type: ignore[arg-type]
            x -= float(b["w"])  # type: ignore[arg-type]
        for tr in trams:
            k = min(range(len(lane_bands)), key=lambda i: abs(centres[i] - tr.lat))
            ln = lane_bands[k]["lanes"][0]  # type: ignore[index]
            ln["cls"] = [*cls, "tram"]  # type: ignore[index]
            ln["track"] = "embedded"  # type: ignore[index]
    bands += lane_bands
    if freeway:
        bands.append({"kind": "shoulder", "w": 3.0 if one else 2.5, "h": 0, "mat": "asphalt_dark"})
        bands.append({"kind": "verge", "w": 2.0, "h": -0.05, "h1": -0.6, "mat": "grass"})
    else:
        bands += extras("right")
        if swr:
            bands += walk_side(False)
    two = not one
    centre = "none"
    if two and rank <= 4:
        centre = "double_yellow" if nf + nb >= 4 or rank <= 3 else "yellow"
    return {
        "family": "road", "rank": rank, "bands": bands, "speed": speed, "centre": centre,
        "laneLines": "white_dashed" if rank <= 5 else "none", "edgeLines": freeway,
        "radius": 0 if freeway else {2: 11, 3: 10, 4: 9, 5: 7, 6: 5}.get(rank, 9),
        "crosswalk": "zebra" if rank <= 3 else "lines" if rank == 4 else "none",
        "rv": 3000 if freeway else 600, "rh": 300 if freeway else 25, "skirt": 1.0 if freeway else 0.6,
        "maxEmbank": 9 if freeway else 6, "maxCut": 9 if freeway else 7, "clearance": 5.0, "deckDepth": 2.0 if freeway else 1.5,
    }


def path(t: dict[str, str]) -> Json:
    hw = t.get("highway", "footway")
    w = _num(t.get("width")) or {"cycleway": 3.0, "path": 2.0, "track": 3.0, "pedestrian": 4.0, "steps": 2.0}.get(hw, 2.0)
    w = max(1.2, min(w, 8.0))
    surf = t.get("surface", "")
    mat = "asphalt" if surf == "asphalt" or (hw == "cycleway" and surf in ("", "paved")) else "gravel" if surf in ("gravel", "dirt", "ground", "fine_gravel", "compacted", "unpaved", "grass") else "concrete"
    if hw in ("path", "track") and surf == "":
        mat = "gravel"
    cls = ["ped", "bike"] if hw != "steps" else ["ped"]
    return {
        "family": "path", "rank": 7, "speed": 5, "centre": "none", "laneLines": "none", "edgeLines": False, "radius": 1.5,
        "crosswalk": "none", "rv": 200, "rh": 2, "skirt": 0.25, "maxEmbank": 4, "maxCut": 4, "clearance": 2.5, "deckDepth": 0.8,
        "bands": [{"kind": "path", "w": w, "h": 0, "mat": mat, "lanes": [{"dir": 1, "cls": cls}]}],
    }


def rail(t: dict[str, str]) -> Json:
    rw = t.get("railway")
    svc = t.get("service")
    gauge = (_num(t.get("gauge")) or 1435) / 1000.0
    if rw == "subway":
        cls, fam, speed = "subway", "subway", 80
    elif rw == "light_rail":
        cls, fam, speed = "tram", "rail", 70
    elif rw == "tram":
        cls, fam, speed = "tram", "tram", 40
    else:
        cls, fam, speed = "rail", "rail", 25 if svc in ("yard", "siding", "spur") else (_num(t.get("maxspeed")) or 110)
    if rw == "tram":
        emb = t.get("embedded") == "yes" or t.get("embedded_rails") is not None
        return {
            "family": "tram", "rank": 4, "speed": speed, "centre": "none", "laneLines": "none", "edgeLines": False, "radius": 0,
            "crosswalk": "none", "rv": 800, "rh": 15, "skirt": 0.4, "maxEmbank": 4, "maxCut": 4, "clearance": 4.5, "deckDepth": 1.2,
            "gauge": gauge,
            "bands": [
                {"kind": "row_edge", "w": 0.5, "h": 0, "mat": "curb"},
                {"kind": "row", "w": 3.2, "h": 0, "mat": "asphalt" if emb else "ballast", "lanes": [{"dir": 1, "cls": ["tram"], "track": "embedded" if emb else "ballast"}]},
                {"kind": "row_edge", "w": 0.5, "h": 0, "mat": "curb"},
            ],
        }
    return {
        "family": fam, "rank": 0 if fam == "subway" else 1, "speed": speed, "centre": "none", "laneLines": "none", "edgeLines": False,
        "radius": 0, "crosswalk": "none", "rv": 3000 if svc else 8000, "rh": 150 if svc else 300, "skirt": 1.5,
        "maxEmbank": 8, "maxCut": 8, "clearance": 7.0 if fam == "rail" else 5.0, "deckDepth": 2.2, "gauge": gauge,
        "fenced": fam == "subway",
        "bands": [
            {"kind": "ballast", "w": 1.4, "h": -0.95, "h1": -0.4, "mat": "ballast"},
            {"kind": "track", "w": 3.0, "h": -0.4, "mat": "ballast", "lanes": [{"dir": 1, "cls": [cls], "track": "ballast"}]},
            {"kind": "ballast", "w": 1.4, "h": -0.4, "h1": -0.95, "mat": "ballast"},
        ],
    }


def platform(kind: str, width: float) -> Json:
    w = max(2.5, min(width, 14.0))
    slots: list[Json]
    if kind == "rail":
        slots = [{"kind": "canopy", "spacing": 12, "phase": 6, "at": 0}, {"kind": "bench", "spacing": 24, "phase": 12, "at": 0.25}]
    elif kind == "subway":
        slots = [{"kind": "platform_lamp", "spacing": 10, "phase": 5, "at": 0}]
    else:
        slots = [{"kind": "shelter", "spacing": 30, "phase": 10, "at": 0.1}]
    return {
        "family": "platform", "rank": 7, "speed": 5, "centre": "none", "laneLines": "none", "edgeLines": False, "radius": 0,
        "crosswalk": "none", "rv": 200, "rh": 5, "skirt": 1.2, "maxEmbank": 3, "maxCut": 3, "clearance": 2.5, "deckDepth": 0.5,
        "bands": [
            {"kind": "platform", "w": 0.6, "h": 0, "mat": "tactile"},
            {"kind": "platform", "w": w - 1.2, "h": 0, "mat": "platform", "lanes": [{"dir": 1, "cls": ["ped"]}], "slots": slots},
            {"kind": "platform", "w": 0.6, "h": 0, "mat": "tactile"},
        ],
    }


def half_width(a: Json) -> float:
    return sum(float(b["w"]) for b in a["bands"]) / 2  # type: ignore[union-attr,arg-type]


def carriage_half(a: Json) -> float:
    ks = {"lane", "parking", "bike", "shoulder", "median", "row", "row_edge", "barrier", "track", "path", "platform"}
    bands = a["bands"]  # type: ignore[assignment]
    W = sum(float(b["w"]) for b in bands)  # type: ignore[union-attr,arg-type]
    x = W / 2
    lo, hi = math.inf, -math.inf
    for b in bands:  # type: ignore[union-attr]
        l, r = x, x - float(b["w"])  # type: ignore[index,arg-type]
        x = r
        if b["kind"] in ks:  # type: ignore[index]
            hi = max(hi, l)
            lo = min(lo, r)
    return max(abs(lo), abs(hi)) if math.isfinite(lo) else W / 2
