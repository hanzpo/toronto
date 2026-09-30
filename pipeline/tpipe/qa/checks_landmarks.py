"""landmark_overlap: hand-modelled landmarks vs the OSM buildings still drawn.

landmarks.json footprints/parts are in the model's local frame (metres from
`pos`, rotated by -rotation); world = pos + R(rotation) @ local. Any building
or house not in the landmark's `suppress` list whose footprint overlaps the
landmark footprint (or one of its parts) is drawn inside / against the model:
the walls z-fight or poke through (user report: CIBC Square).
Also reports landmark-vs-landmark footprint overlaps.
"""

from __future__ import annotations

import json
import math

import numpy as np
import shapely
from shapely.geometry import Polygon

from .. import geo
from .core import finding
from .data import BLOCK, S0, Block, manifest

LANDMARKS = geo.OUT / "landmarks.json"
MIN_AREA = 5.0  # m2 of overlap
MIN_FRAC = 0.03  # of the building footprint


def _world(L: dict, ring) -> Polygon | None:
    if not ring or len(ring) < 3:
        return None
    c, s = math.cos(L.get("rotation", 0.0)), math.sin(L.get("rotation", 0.0))
    ex, ny = L["pos"]
    pts = [(ex + c * x - s * y, ny + s * x + c * y) for x, y in ring]
    g = shapely.make_valid(Polygon(pts))
    return g if not g.is_empty else None


def run_global(cats: set, bbox=None) -> list[dict]:
    if "landmark_overlap" not in cats or not LANDMARKS.exists():
        return []
    Ls = [L for L in json.loads(LANDMARKS.read_text()) if L.get("pos") and L.get("footprint") and L.get("kind") != "waterfall"]
    tileset = set(map(tuple, manifest()["tiles"]["0"]))
    out = []
    blocks: dict = {}
    shapes = []
    for L in Ls:
        foot = _world(L, L["footprint"])
        if foot is None:
            continue
        parts = [g for g in (_world(L, r) for r in (L.get("parts") or {}).values()) if g is not None]
        shapes.append((L, shapely.union_all([foot] + parts)))
    for L, geom in shapes:
        x, y = L["pos"]
        if bbox and not (bbox[0] <= x < bbox[2] and bbox[1] <= y < bbox[3]):
            continue
        bk = (math.floor(x / S0 / BLOCK), math.floor(y / S0 / BLOCK))
        if bk not in blocks:
            B = Block(*bk, tileset)
            blocks[bk] = (B.buildings(), B.houses())
        (polys, A), (hp, H) = blocks[bk]
        sup = {int(o) for o in L.get("suppress", [])}
        for kind, P, att in (("building", polys, A), ("house", hp, H)):
            if len(P) == 0:
                continue
            hit = shapely.intersects(P, geom)
            for i in np.nonzero(hit)[0]:
                o = int(att["osm"][i])
                if o in sup:
                    continue
                inter = shapely.intersection(P[i], geom)
                ar = inter.area
                fr = ar / max(P[i].area, 1e-6)
                if ar < MIN_AREA or fr < MIN_FRAC:
                    continue
                c = inter.centroid
                out.append(finding("landmark_overlap", f"{kind}_not_suppressed", ar / 10 * (1 + fr), c.x, c.y,
                                   float(L.get("base", 0)) + float(att["height"][i]), [o],
                                   f"{L['name']}: OSM {kind} {o} ({att['height'][i]:.0f} m, not in suppress) overlaps the landmark "
                                   f"by {ar:.0f} m2 ({fr * 100:.0f}% of it)", key=("landmark_overlap", L["id"], o)))
    for a in range(len(shapes)):
        for b in range(a + 1, len(shapes)):
            ga, gb = shapes[a][1], shapes[b][1]
            if ga.intersects(gb):
                inter = ga.intersection(gb)
                if inter.area >= MIN_AREA:
                    c = inter.centroid
                    out.append(finding("landmark_overlap", "landmark_landmark", inter.area / 5, c.x, c.y, None, [],
                                       f"landmarks {shapes[a][0]['name']} and {shapes[b][0]['name']} overlap {inter.area:.0f} m2",
                                       key=("landmark_overlap", shapes[a][0]["id"], shapes[b][0]["id"])))
    return out
