"""River surface levels: a smoothed downstream profile along each centreline, flat
across the channel, stepping only at curated weirs, dams and falls.

The terrain-derived level field (90 m min filter of the DSM) tilts narrow rivers
toward their valley walls and wanders up and down along them, so drawn river
water sloped 4-50 % in places (22 % of the Humber's water was steeper than 4 %).
Here each named river (OSM waterway centrelines, merged per name in their
downstream direction) is sampled every STEP m on that field and fitted with a
non-increasing profile (weighted isotonic regression), segment by segment between
the curated steps, then smoothed within each segment. Grid nodes near river water
take the level of the nearest centreline sample (so the surface is flat across
the channel). Water just below a step and inside curated rapids zones is flagged
as whitewater (gw_level RAPIDS).

pipeline/curated/rivers.json
  steps   [{osm, kind weir|dam|waterfall|lock_gate, name, lonlat, [off: true]}]
          seeded from OSM (`python -m tpipe.rivers --extract`); hand edits persist
          (entries are merged by osm id; `off` disables one)
  pins    [{lonlat, asl, note}]  force the level near a point (e.g. a gauge)
  rapids  [{name, zone: [[lon, lat], ...]}]  steep reaches drawn as whitewater
Niagara Falls has its own curated levels (tpipe.falls, applied after this).

    uv run python -m tpipe.rivers --extract   # refresh OSM steps into curated/rivers.json
"""

from __future__ import annotations

import json

import numpy as np
import shapely
from scipy import ndimage
from scipy.spatial import cKDTree

from . import geo

PATH = geo.PIPE / "curated" / "rivers.json"
STEP = 15.0  # m between profile samples
SMOOTH = 90.0  # m: Gaussian sigma of the profile within a segment
REACH = 220.0  # m: grid nodes this close to a centreline sample take its level
STEP_SNAP = 40.0  # m: a curated step applies to centrelines this close
RAPID_BELOW = 45.0  # m of whitewater below a weir / dam / waterfall


def load() -> dict:
    if not PATH.exists():
        return {"steps": [], "pins": [], "rapids": []}
    d = json.loads(PATH.read_text())
    for k in ("steps", "pins", "rapids"):
        d.setdefault(k, [])
    return d


def _pava(y: np.ndarray, w: np.ndarray) -> np.ndarray:
    """Weighted isotonic regression, non-increasing."""
    # fit non-decreasing on -y
    v = list(-y)
    ww = list(w)
    cnt = [1] * len(v)
    out_v, out_w, out_c = [], [], []
    for i in range(len(v)):
        out_v.append(v[i]); out_w.append(ww[i]); out_c.append(cnt[i])
        while len(out_v) > 1 and out_v[-2] > out_v[-1]:
            wv = out_w[-2] + out_w[-1]
            nv = (out_v[-2] * out_w[-2] + out_v[-1] * out_w[-1]) / wv
            nc = out_c[-2] + out_c[-1]
            out_v[-2:] = [nv]; out_w[-2:] = [wv]; out_c[-2:] = [nc]
    return -np.repeat(np.array(out_v), out_c)


def _chains(lines_xy: list[np.ndarray], names: list[str]) -> list[np.ndarray]:
    """Merge centrelines per name, keeping their (downstream) direction."""
    by: dict[str, list] = {}
    for p, nm in zip(lines_xy, names):
        by.setdefault(nm or "", []).append(shapely.LineString(p))
    out = []
    for nm, ls in by.items():
        merged = shapely.line_merge(shapely.MultiLineString(ls), directed=True)
        for g in shapely.get_parts(merged):
            if g.length > 2 * STEP:
                out.append(np.asarray(g.coords))
    return out


def profile_field(wl: np.ndarray, x0: float, y0: float, cell: float, water: list, lines) -> tuple[np.ndarray, list]:
    """Rebuild the river level field `wl` (datum m, rows north) from centreline profiles.
    `water`: field-level water polygons; `lines`: (xy arrays, names) of waterway centrelines.
    Returns (field, whitewater polygons)."""
    from affine import Affine
    from rasterio import features

    C = load()
    steps = [s for s in C["steps"] if not s.get("off")]
    step_pts = np.array([geo.project(*s["lonlat"]) for s in steps]) if steps else np.zeros((0, 2))
    step_tree = cKDTree(step_pts) if len(step_pts) else None
    pins = [(np.array(geo.project(*p["lonlat"])), p["asl"] - geo.DATUM_M) for p in C["pins"]]

    def field_at(x, y):
        c = (np.asarray(x) - x0) / cell
        r = (np.asarray(y) - y0) / cell
        return ndimage.map_coordinates(wl, [r, c], order=1, mode="nearest")

    # centrelines that run in river water
    wtree = shapely.STRtree(water)
    lxy, lnm = [], []
    for p, nm in zip(*lines):
        if len(p) < 2:
            continue
        mid = shapely.points(p[:: max(1, len(p) // 8)])
        if len(wtree.query(mid, predicate="intersects")[0]):
            lxy.append(p); lnm.append(nm)
    chains = _chains(lxy, lnm)
    SX, SY, SZ = [], [], []
    white = []
    n_steps = 0
    for p in chains:
        ln = shapely.LineString(p)
        n = max(2, int(ln.length / STEP) + 1)
        d = np.linspace(0, ln.length, n)
        pts = shapely.line_interpolate_point(ln, d)
        xy = shapely.get_coordinates(pts)
        z = field_at(xy[:, 0], xy[:, 1]).astype(np.float64)
        w = np.ones(n)
        for pp, lv in pins:
            m = np.hypot(xy[:, 0] - pp[0], xy[:, 1] - pp[1]) < 30
            z[m], w[m] = lv, 1e6
        # segment breaks at curated steps near this chain
        cuts = []
        if step_tree is not None:
            for k in set(sum(step_tree.query_ball_point(xy, STEP_SNAP), [])):
                cuts.append(float(shapely.line_locate_point(ln, shapely.Point(step_pts[k]))))
                if steps[k].get("kind") in ("weir", "dam", "waterfall"):
                    below = shapely.substring(ln, cuts[-1], cuts[-1] + RAPID_BELOW)
                    if below.length > 1:
                        white.append(below.buffer(25, cap_style="flat"))
        edges = np.searchsorted(d, sorted(cuts))
        out = np.empty(n)
        for a, b in zip(np.r_[0, edges], np.r_[edges, n]):
            if b <= a:
                continue
            seg = _pava(z[a:b], w[a:b])
            if b - a > 3:
                seg = ndimage.gaussian_filter1d(seg, SMOOTH / STEP, mode="nearest")
            out[a:b] = seg
        # keep the whole chain non-increasing (steps only go down)
        out = np.minimum.accumulate(out)
        n_steps += len(cuts)
        SX.append(xy[:, 0]); SY.append(xy[:, 1]); SZ.append(out)
    if not SX:
        return wl, white
    SX, SY, SZ = np.concatenate(SX), np.concatenate(SY), np.concatenate(SZ)
    tree = cKDTree(np.column_stack([SX, SY]))

    # nodes near river water take the nearest profile level (flat across the channel)
    tr = Affine(cell, 0, x0 - cell / 2, 0, cell, y0 - cell / 2)  # row index grows north, like the grid
    mask = features.rasterize(((g, 1) for g in water), out_shape=wl.shape, transform=tr, all_touched=True, dtype="uint8")
    mask = ndimage.binary_dilation(mask, iterations=2)
    r, c = np.nonzero(mask)
    X, Y = x0 + c * cell, y0 + r * cell
    dist, idx = tree.query(np.column_stack([X, Y]), distance_upper_bound=REACH)
    ok = np.isfinite(dist)
    out = wl.copy()
    out[r[ok], c[ok]] = SZ[idx[ok]]
    print(f"rivers: {len(chains):,} centreline chains, {len(SZ):,} profile samples, {n_steps} steps, "
          f"{int(ok.sum()):,} / {len(ok):,} river nodes from profiles, {len(white)} whitewater reaches")
    for z in C["rapids"]:
        white.append(shapely.Polygon(np.column_stack(geo.project(*np.array(z["zone"]).T))))
    return out.astype(np.float32), white


def flag_rapids(geoms, cls, tier, frames, levels, c_water: int, white: list):
    """Field-level water inside the whitewater polygons -> RAPIDS pieces."""
    from .falls import FIELD, RAPIDS

    if not white:
        return geoms, cls, tier, frames, levels
    W = shapely.union_all(white)
    tree = shapely.STRtree([W])
    G, C, T, R, L = [], [], [], [], []
    n = 0
    for k in range(len(geoms)):
        g = geoms[k]
        if cls[k] == c_water and levels[k] == FIELD and len(tree.query(g, predicate="intersects")):
            g = shapely.make_valid(g)
            for part, lv in ((shapely.intersection(g, W), RAPIDS), (shapely.difference(g, W), FIELD)):
                for q in shapely.get_parts(part):
                    if q.geom_type == "Polygon" and q.area >= 0.5:
                        G.append(q); C.append(cls[k]); T.append(tier[k]); R.append(frames[k]); L.append(lv)
            n += 1
            continue
        G.append(g); C.append(cls[k]); T.append(tier[k]); R.append(frames[k]); L.append(levels[k])
    print(f"rivers: {n} water polygons with whitewater reaches")
    return G, C, T, R, L


# ------------------------------------------------------------------ OSM step extraction

def extract():
    """Seed curated steps from OSM (waterway=weir|dam|waterfall|lock_gate); keeps hand edits."""
    import osmium

    kinds = {"weir", "dam", "waterfall", "lock_gate"}
    found = {}
    for f in [geo.RAW / "bbox.osm.pbf", geo.RAW / "ny-niagara.osm.pbf"]:
        if not f.exists():
            continue
        fp = osmium.FileProcessor(str(f)).with_locations().with_filter(osmium.filter.KeyFilter("waterway"))
        for o in fp:
            ww = o.tags.get("waterway")
            if ww not in kinds:
                continue
            try:
                if o.is_node():
                    ll = (o.location.lon, o.location.lat)
                    oid = f"n{o.id}"
                elif o.is_way():
                    pts = [(n.lon, n.lat) for n in o.nodes]
                    ll = tuple(np.mean(np.array(pts), axis=0))
                    oid = f"w{o.id}"
                else:
                    continue
            except Exception:
                continue
            found[oid] = {"osm": oid, "kind": ww, "name": o.tags.get("name", ""), "lonlat": [round(ll[0], 6), round(ll[1], 6)]}
    d = load()
    old = {s.get("osm"): s for s in d["steps"]}
    steps = []
    for oid, s in found.items():
        steps.append({**s, **{k: v for k, v in old.get(oid, {}).items() if k in ("off", "note", "drop")}})
    steps += [s for s in d["steps"] if s.get("osm") not in found]  # hand-added entries
    d["steps"] = sorted(steps, key=lambda s: (s["kind"], s["osm"]))
    d.setdefault("_doc", __doc__.split("pipeline/curated/rivers.json")[1].split("Niagara")[0].strip())
    PATH.write_text(json.dumps(d, indent=1))
    print(f"rivers: {len(found)} OSM steps -> {PATH}")


if __name__ == "__main__":
    import sys

    if "--extract" in sys.argv:
        extract()
