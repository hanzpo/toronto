"""Niagara Falls: handcrafted crests, gorge pool and upper rapids (pipeline/curated/falls.json).

The river level field (tpipe.ground) is one continuous bilinear surface, so on
its own it ramps the Niagara River ~60 m down across the brink in a single
32 m cell -- and the Copernicus DEM's gorge runs ~250 m upstream of the real
crest, so the ramp is in the wrong place as well. Here:

  * River water is cut along the crest lines. The downstream part (the gorge
    component, inside `pool_zone`) becomes a flat water body at the Maid of the
    Mist pool level; the rest keeps following the field.
  * Inside each rapids zone the field is rebuilt as brink + grade x distance to
    the nearest crest (blended back into the DEM field toward the zone's reach), so
    the upper river meets every crest at its brink level and falls toward it
    over the cascades. Field water inside a rapids zone is flagged (`gw_level`
    RAPIDS) and drawn as whitewater.
  * `landmark_entries()` emits the waterfall entries of landmarks.json (crest,
    curtain foot / talus toe line, levels) for the client (landmarks/falls.ts).

    uv run python -m tpipe.falls     # rewrite the waterfall entries of OUT/landmarks.json
"""

from __future__ import annotations

import json
import os

import numpy as np
import shapely

from . import geo

PATH = geo.PIPE / "curated" / "falls.json"
FIELD = -32768  # gw_level: follows gw_field
RAPIDS = -32767  # gw_level: follows gw_field, whitewater rapids
EXTEND = 30.0  # m: crest ends are extended onto the banks so the cut crosses all the water
EDGE = 150.0  # m: the rapids field blends back into the DEM field over this band before a zone's reach


def _xy(ll):
    a = np.asarray(ll, np.float64)
    e, n = geo.project(a[:, 0], a[:, 1])
    return np.column_stack([e, n])


def _extend(p: np.ndarray, d: float) -> np.ndarray:
    def ext(a, b):
        v = a - b
        return a + v / max(np.hypot(*v), 1e-9) * d
    return np.vstack([ext(p[0], p[1]), p, ext(p[-1], p[-2])])


_cache: dict = {}


def load() -> dict | None:
    if "d" in _cache:
        return _cache["d"]
    if not PATH.exists():
        _cache["d"] = None
        return None
    d = json.loads(PATH.read_text())
    F = {
        "pool": d["pool_asl"] - geo.DATUM_M,
        "pool_zone": shapely.Polygon(_xy(d["pool_zone"])),
        "gorge_seeds": shapely.points(_xy(d["gorge_seeds"])),
        "upper_seeds": shapely.points(_xy(d["upper_seeds"])),
        "rapids": [(shapely.Polygon(_xy(r["zone"])), float(r["grade"]), float(r["reach"])) for r in d["rapids"]],
        "falls": [],
    }
    for f in d["falls"]:
        F["falls"].append({**f, "crest_xy": _xy(f["crest"]), "base_xy": _xy(f["base"]),
                           "brink": f["brink_asl"] - geo.DATUM_M, "foot": f["foot_asl"] - geo.DATUM_M})
    F["crests"] = shapely.MultiLineString([f["crest_xy"] for f in F["falls"]])
    F["cut"] = shapely.MultiLineString([_extend(f["crest_xy"], EXTEND) for f in F["falls"]]).buffer(0.05)
    # land the OSM riverbank still covers (removed from river water)
    F["land"] = shapely.union_all([shapely.Polygon(_xy(z["ring"])) for z in d.get("land", [])])
    F["bbox"] = shapely.union_all([F["pool_zone"], *[z for z, _, _ in F["rapids"]]]).envelope.buffer(200)
    _cache["d"] = F
    return F


def load_pool_level():
    F = load()
    return None if F is None else F["pool"]


def adjust_field(wl: np.ndarray, x0: float, y0: float, cell: float) -> int:
    """Rebuild the river level field (datum m, rows = north) inside the rapids zones. In place."""
    F = load()
    if F is None:
        return 0
    b0, b1, b2, b3 = F["bbox"].bounds
    c0, c1 = max(int((b0 - x0) // cell), 0), min(int((b2 - x0) // cell) + 2, wl.shape[1])
    r0, r1 = max(int((b1 - y0) // cell), 0), min(int((b3 - y0) // cell) + 2, wl.shape[0])
    if c0 >= c1 or r0 >= r1:
        return 0
    gx, gy = np.meshgrid(x0 + np.arange(c0, c1) * cell, y0 + np.arange(r0, r1) * cell)
    pts = shapely.points(gx.ravel(), gy.ravel())
    sub = wl[r0:r1, c0:c1].astype(np.float64).ravel()
    # distance to the nearest crest and that crest's brink
    dist = np.full(len(sub), np.inf)
    brink = np.zeros(len(sub))
    for f in F["falls"]:
        d = shapely.distance(pts, shapely.LineString(f["crest_xy"]))
        m = d < dist
        dist[m], brink[m] = d[m], f["brink"]
    n = 0
    for zone, grade, reach in F["rapids"]:
        inside = shapely.contains(zone, pts)
        if not inside.any():
            continue
        # full design level near the crests, back to the DEM field at `reach` m upstream
        t = np.clip((reach - dist[inside]) / EDGE, 0.0, 1.0)
        t = t * t * (3 - 2 * t)
        want = brink[inside] + grade * dist[inside]
        sub[inside] = sub[inside] * (1 - t) + want * t
        n += int(inside.sum())
    wl[r0:r1, c0:c1] = sub.reshape(gx.shape).astype(wl.dtype)
    return n


def split_water(geoms, cls, tier, frames, levels, c_water: int):
    """Cut field water at the crests: gorge side -> flat pool level; rapids zones -> RAPIDS.
    Returns new (geoms, cls, tier, frames, levels) lists."""
    F = load()
    if F is None:
        return geoms, cls, tier, frames, levels
    near = F["bbox"]
    idx = [k for k in range(len(geoms)) if cls[k] == c_water and levels[k] == FIELD and geoms[k].intersects(near)]
    if not idx:
        return geoms, cls, tier, frames, levels
    land = F["land"]
    for k in idx:
        if not land.is_empty and geoms[k].intersects(land):
            geoms[k] = shapely.difference(shapely.make_valid(geoms[k]), land)
    U = shapely.intersection(shapely.union_all([geoms[k] for k in idx]), near)
    comps = [g for g in shapely.get_parts(shapely.difference(U, F["cut"])) if g.geom_type == "Polygon"]
    gorge = [g for g in comps if shapely.intersects(g, F["gorge_seeds"]).any()]
    leak = [g for g in gorge if shapely.intersects(g, F["upper_seeds"]).any()]
    if os.environ.get("TPIPE_FALLS_DEBUG"):
        import pickle
        with open(os.environ["TPIPE_FALLS_DEBUG"], "wb") as fh:
            pickle.dump({"U": U, "cut": F["cut"], "comps": comps, "src": [geoms[k] for k in idx]}, fh)
    if leak:
        print("!! falls: the crest cut does not separate the upper river from the gorge; skipping")
        return geoms, cls, tier, frames, levels
    pool = shapely.intersection(shapely.union_all(gorge), F["pool_zone"]) if gorge else None
    zones = [z for z, _, _ in F["rapids"]]
    sel = set(idx)
    G, C, T, R, L = [], [], [], [], []

    def put(g, k, lvl):
        for q in shapely.get_parts(g):
            if q.geom_type == "Polygon" and q.area >= 0.5:
                G.append(q); C.append(cls[k]); T.append(tier[k]); R.append(frames[k]); L.append(lvl)

    n_pool = n_rap = 0
    for k in range(len(geoms)):
        if k not in sel:
            G.append(geoms[k]); C.append(cls[k]); T.append(tier[k]); R.append(frames[k]); L.append(levels[k])
            continue
        g = shapely.make_valid(geoms[k])
        if pool is not None and g.intersects(pool):
            put(shapely.intersection(g, pool), k, F["pool"])
            g = shapely.difference(g, pool)
            n_pool += 1
        for z in zones:
            if g.is_empty or not g.intersects(z):
                continue
            put(shapely.intersection(g, z), k, RAPIDS)
            g = shapely.difference(g, z)
            n_rap += 1
        if not g.is_empty:
            put(g, k, FIELD)
    print(f"falls: {len(gorge)} gorge piece(s); {n_pool} water polygons cut to the pool "
          f"({F['pool'] + geo.DATUM_M:.1f} m ASL), {n_rap} flagged rapids")
    return G, C, T, R, L


C_GORGE = 40  # ground class: gorge wall rock / scree (docs/SPEC.md)
BAND = 110.0  # m: how far from the gorge water the wall band may reach
STEP = 5.0  # m: raster step for the band mask


def gorge_rock(terrain, pool_geoms: list, all_water: list | None = None) -> list:
    """Wall band of the Niagara gorge: steep land (> ~17°) within BAND of the gorge pool water
    that lies below 85 % of the way up to the local rim (DEM). The DEM's walls are ramps that
    the ground would paint as lawn; this is dolostone and scree. Polygons, water excluded."""
    from rasterio import features
    from rasterio.transform import from_origin
    from scipy import ndimage

    F = load()
    if F is None or not pool_geoms:
        return []
    water = shapely.union_all(pool_geoms)
    x0, y0, x1, y1 = water.buffer(BAND).bounds
    nx, ny = int((x1 - x0) / STEP) + 1, int((y1 - y0) / STEP) + 1
    xs, ys = x0 + np.arange(nx) * STEP, y1 - np.arange(ny) * STEP  # row 0 = north
    gx, gy = np.meshgrid(xs, ys)
    h = terrain.sample(gx, gy)
    rim = ndimage.maximum_filter(h, size=int(150 / STEP))
    below = h < F["pool"] + 0.85 * (rim - F["pool"])
    gy_, gx_ = np.gradient(ndimage.gaussian_filter(h, 1.5), STEP)
    steep = np.hypot(gx_, gy_) > 0.3  # the walls, not the rim-top parks or the landing plazas below
    near = shapely.contains_xy(water.buffer(BAND), gx.ravel(), gy.ravel()).reshape(h.shape)
    mask = (below & near & steep).astype(np.uint8)
    mask = ndimage.binary_opening(ndimage.binary_closing(mask, iterations=2), iterations=1).astype(np.uint8)
    tr = from_origin(x0 - STEP / 2, y1 + STEP / 2, STEP, STEP)
    polys = [shapely.geometry.shape(g) for g, v in features.shapes(mask, mask=mask.astype(bool), transform=tr) if v == 1]
    if not polys:
        return []
    # 5 m raster steps -> smooth outline (close, round, simplify across the stairs)
    band = shapely.union_all(polys).buffer(8, quad_segs=6).buffer(-10, quad_segs=6).buffer(2, quad_segs=6).simplify(3.0)
    wet = shapely.union_all([water, *[g for g in (all_water or []) if g.intersects(band)]])  # upper river too
    band = shapely.intersection(shapely.difference(band, wet), F["pool_zone"].buffer(BAND))
    out = [q for q in shapely.get_parts(band) if q.geom_type == "Polygon" and q.area > 200]
    print(f"falls: gorge wall band {sum(q.area for q in out) / 1e4:.1f} ha in {len(out)} polygon(s)")
    return out


def landmark_entries() -> list[dict]:
    """Waterfall entries for landmarks.json (world E, N; levels datum m)."""
    F = load()
    if F is None:
        return []
    out = []
    for f in F["falls"]:
        r = lambda p: [[round(float(x), 2), round(float(y), 2)] for x, y in p]  # noqa: E731
        out.append({
            "id": f["id"], "name": f["name"], "kind": "waterfall", "osm": f["osm"],
            "line": r(f["crest_xy"]), "toe": r(f["base_xy"]),
            "top": round(f["brink"], 2), "foot": round(f["foot"], 2), "bottom": round(F["pool"], 2),
            "talus": bool(f["talus"]), "flow": f["flow"],
        })
    return out


def main():
    path = geo.OUT / "landmarks.json"
    L = [e for e in json.loads(path.read_text()) if e.get("kind") != "waterfall"]
    W = landmark_entries()
    path.write_text(json.dumps(L + W, separators=(",", ":")))
    for w in W:
        print(f"{w['id']:20s} crest {len(w['line'])} pts top {w['top']} foot {w['foot']} pool {w['bottom']}")
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
