"""Fill in building heights that OpenStreetMap doesn't have.

1. City of Toronto 3D Massing (surveyed roof heights, split into sections
   such as podium + tower). OSM buildings without height tags take the
   heights of the massing sections inside them; when the sections differ
   (tower on a podium) they become building parts, so the real stepped shape
   is kept.
2. Overture Maps buildings with `height` / `num_floors` (aggregated from
   OSM, Esri Community Maps and others) fill remaining untagged buildings
   anywhere in the region (raw/overture/buildings_heights.parquet, see run.sh).
3. Large untagged buildings still left get a height estimate from the
   Copernicus surface model (DSM minus the building-free terrain).

Applied to the extracted OSM building arrays before tiling.
"""

from __future__ import annotations

import glob
import time

import numpy as np
import shapely
from pyproj import Transformer
from shapely.strtree import STRtree

from . import geo
from .terrain import get as get_terrain, sample_dsm

STEP_M = 4.0          # sections within this height range are treated as one roof
DSM_MIN_AREA = 500.0  # m²; smaller footprints are below the DSM's 30 m resolution


def _offsets(counts):
    off = np.zeros(len(counts) + 1, dtype=np.int64)
    np.cumsum(counts, out=off[1:])
    return off


def _load_massing():
    from pyogrio.raw import read as ogr_read

    files = sorted(glob.glob(str(geo.RAW / "massing" / "*.shp")))
    if not files:
        return None
    meta, _, wkb, fields = ogr_read(files[-1], columns=["MAX_HEIGHT"])
    geoms = shapely.force_2d(shapely.from_wkb(wkb))
    tr = Transformer.from_crs("EPSG:3857", geo.PROJ, always_xy=True)
    geoms = shapely.transform(geoms, lambda c: np.column_stack(tr.transform(c[:, 0], c[:, 1])))
    return geoms, np.asarray(fields[0], dtype=np.float32)


def _polygonal(g):
    """Polygonal part of a geometry (overlays/make_valid can add lines/points)."""
    polys = [q for q in shapely.get_parts(shapely.make_valid(g)) if q.geom_type == "Polygon" and q.area > 0]
    if not polys:
        return None
    return shapely.MultiPolygon(polys) if len(polys) > 1 else polys[0]


def _disjoint_sections(parts):
    """Massing sections of one building overlap in plan (a tower footprint is
    also covered by the podium section, and some sections are duplicated).
    Extruding each from the ground makes coincident faces that z-fight, so
    make them disjoint: per building, taller sections claim their footprint
    first and lower ones keep only what's left (podium = podium - tower)."""
    by_b: dict[int, list] = {}
    for b, g, h in parts:
        by_b.setdefault(b, []).append((g, h))
    out = []
    for b, secs in by_b.items():
        secs.sort(key=lambda t: -t[1])
        taken = None
        for g, h in secs:
            g = _polygonal(g)
            if g is None:
                continue
            if taken is not None:
                g = _polygonal(shapely.difference(g, taken, grid_size=0.01))
            if g is None or g.area < 4:
                continue
            out.append((b, g, h))
            taken = g if taken is None else _polygonal(shapely.union(taken, g, grid_size=0.01))
    return out


def contained_hidden(d: dict) -> np.ndarray:
    """Buildings that are invisible duplicates: outer ring (almost) entirely
    inside another non-part building that is at least as tall. They only add
    coincident faces (z-fighting) — e.g. a store mapped inside its mall, or an
    outline repeated as a second record. Returns a bool mask to drop."""
    xy = d["xy"]
    nring = d["nring"].astype(np.int64)
    ring_off = _offsets(d["ringlen"].astype(np.int64))
    outer = _offsets(nring)[:-1]
    part = d["part"].astype(bool)
    h = np.nan_to_num(d["height"], nan=0.0)
    idx = np.arange(len(nring))
    r = outer[idx]
    lens = ring_off[r + 1] - ring_off[r]
    vi = np.repeat(ring_off[r] - _offsets(lens)[:-1], lens) + np.arange(lens.sum())
    polys = shapely.make_valid(shapely.polygons(shapely.linearrings(xy[vi], indices=np.repeat(idx, lens))))
    area = shapely.area(polys)
    tree = STRtree(polys)
    pts = shapely.point_on_surface(polys)
    pairs = tree.query(pts, predicate="within")  # [inner idx, container idx]
    a, c = pairs
    # pieces of one multipolygon (same OSM id, one record per outer ring) are never duplicates
    # of each other: an island outer ring sits inside its sibling's courtyard, not on top of it
    oid = d["id"]
    m = (a != c) & (oid[a] != oid[c]) & ~part[a] & ~part[c] & (area[c] >= area[a]) & (h[c] + 0.5 >= h[a])
    a, c = a[m], c[m]
    hidden = np.zeros(len(nring), dtype=bool)
    if len(a):
        inter = shapely.area(shapely.intersection(polys[a], polys[c], grid_size=0.01))
        full = inter >= 0.95 * area[a]
        # identical duplicates: keep exactly one of each pair
        dup = full & (np.abs(area[a] - area[c]) < 0.02 * area[a]) & (np.abs(h[a] - h[c]) < 0.5)
        hidden[a[full & ~dup]] = True
        hidden[np.maximum(a[dup], c[dup])] = True
    return hidden


def enrich(d: dict) -> dict:
    t0 = time.time()
    d = {k: np.array(v) for k, v in d.items()}
    xy = d["xy"]
    nring = d["nring"].astype(np.int64)
    ringlen = d["ringlen"].astype(np.int64)
    ring_off = _offsets(ringlen)
    b_ring = _offsets(nring)
    outer = b_ring[:-1]
    nb = len(nring)
    unknown = (d["part"] == 0) & np.isnan(d["height"]) & np.isnan(d["levels"])

    # outer-ring polygons for untagged buildings
    cand = np.nonzero(unknown)[0]
    r = outer[cand]
    lens = ring_off[r + 1] - ring_off[r]
    idx = np.repeat(ring_off[r] - _offsets(lens)[:-1], lens) + np.arange(lens.sum())
    rid = np.repeat(np.arange(len(cand)), lens)
    polys = shapely.polygons(shapely.linearrings(xy[idx], indices=rid))
    polys = shapely.make_valid(polys)
    tree = STRtree(polys)

    new_parts = []  # (building index, polygon, height)
    massing = _load_massing()
    n_set = n_split = 0
    if massing is not None:
        mgeoms, mh = massing
        pts = shapely.point_on_surface(mgeoms)
        pairs = tree.query(pts, predicate="within")  # [massing idx, cand idx]
        order = np.argsort(pairs[1], kind="stable")
        ms, cs = pairs[0][order], pairs[1][order]
        brk = np.nonzero(np.diff(cs))[0] + 1
        for grp_m, grp_c in zip(np.split(ms, brk), np.split(cs, brk)):
            if not len(grp_c):
                continue
            b = cand[grp_c[0]]
            hs = mh[grp_m]
            ok = hs > 1.5
            if not ok.any():
                continue
            grp_m, hs = grp_m[ok], hs[ok]
            if len(hs) == 1 or hs.max() - hs.min() < STEP_M:
                d["height"][b] = float(hs.max())
                n_set += 1
            else:
                for mi, h in zip(grp_m, hs):
                    new_parts.append((b, mgeoms[mi], float(h)))
                n_split += 1
        print(f"  massing: {len(mgeoms):,} sections -> {n_set:,} heights, {n_split:,} buildings split into parts")

    # Overture heights for the rest
    ov = geo.RAW / "overture" / "buildings_heights.parquet"
    if ov.exists() and ov.stat().st_size > 0:
        import duckdb

        rows = duckdb.sql(f"select wkb, height, num_floors from '{ov}'").fetchnumpy()
        og = shapely.from_wkb(np.array([bytes(b) for b in rows["wkb"]], dtype=object))
        tr = Transformer.from_crs("EPSG:4326", geo.PROJ, always_xy=True)
        og = shapely.transform(og, lambda c: np.column_stack(tr.transform(c[:, 0], c[:, 1])))
        oh = np.asarray(rows["height"], dtype=np.float64)
        fl = np.asarray(rows["num_floors"], dtype=np.float64)
        oh = np.where(np.isnan(oh), fl * 3.3, oh)
        pairs = tree.query(shapely.point_on_surface(og), predicate="within")
        todo = np.isnan(d["height"][cand[pairs[1]]]) & (oh[pairs[0]] > 2) & (oh[pairs[0]] < 400)
        best = {}
        for mi, ci in zip(pairs[0][todo], pairs[1][todo]):
            best[ci] = max(best.get(ci, 0.0), oh[mi])
        for ci, h in best.items():
            d["height"][cand[ci]] = h
        print(f"  overture: {len(og):,} buildings with heights -> {len(best):,} OSM buildings filled")

    # DSM estimate for large buildings still without a height
    terrain = get_terrain()
    still = np.nonzero(np.isnan(d["height"][cand]) & (shapely.area(polys) > DSM_MIN_AREA))[0]
    split_b = {p[0] for p in new_parts}
    still = np.array([i for i in still if cand[i] not in split_b], dtype=np.int64)
    if len(still):
        c = shapely.get_coordinates(shapely.centroid(polys[still]))
        inner = shapely.get_coordinates(shapely.buffer(polys[still], -6.0, quad_segs=1), return_index=True)
        dsm_c = sample_dsm(terrain, c[:, 0], c[:, 1])
        top = dsm_c.copy()
        if len(inner[0]):
            pts, which = inner
            v = sample_dsm(terrain, pts[:, 0], pts[:, 1])
            np.maximum.at(top, which, v)
        bc = shapely.get_coordinates(polys[still], return_index=True)
        g = terrain.sample(bc[0][:, 0], bc[0][:, 1])
        ground = np.full(len(still), np.inf)
        np.minimum.at(ground, bc[1], g)
        est = top - ground
        good = (est > 12.0) & (est < 300.0)
        d["height"][cand[still[good]]] = est[good].astype(np.float32)
        print(f"  dsm: {good.sum():,} of {len(still):,} large untagged buildings got estimated heights")

    if new_parts:
        new_parts = _disjoint_sections(new_parts)
        add_xy, add_len, add_nring, add_b, add_h = [], [], [], [], []
        for b, g, h in new_parts:
            for p in shapely.get_parts(g):
                if p.geom_type != "Polygon" or p.area < 4:
                    continue
                p = shapely.orient_polygons(p)
                rings = [np.asarray(p.exterior.coords)[:-1]] + [np.asarray(i.coords)[:-1] for i in p.interiors]
                rings = [q for q in rings if len(q) >= 3]
                add_xy += rings
                add_len += [len(q) for q in rings]
                add_nring.append(len(rings))
                add_b.append(b)
                add_h.append(h)
        add_b = np.array(add_b, dtype=np.int64)
        k = len(add_b)
        d["xy"] = np.vstack([d["xy"]] + add_xy)
        d["ringlen"] = np.concatenate([d["ringlen"], np.array(add_len, dtype=d["ringlen"].dtype)])
        d["nring"] = np.concatenate([d["nring"], np.array(add_nring, dtype=d["nring"].dtype)])
        d["part"] = np.concatenate([d["part"], np.ones(k, dtype=d["part"].dtype)])
        d["height"] = np.concatenate([d["height"], np.array(add_h, dtype=np.float32)])
        for key, fill in (("min", 0.0), ("levels", np.nan), ("minlevel", np.nan), ("roofh", np.nan)):
            d[key] = np.concatenate([d[key], np.full(k, fill, dtype=d[key].dtype)])
        for key in ("id", "kind", "roof", "color", "tag"):
            d[key] = np.concatenate([d[key], d[key][add_b]])
        print(f"  added {k:,} massing parts")
    d["hidden"] = contained_hidden(d)
    print(f"  hidden {int(d['hidden'].sum()):,} buildings fully inside an equal-or-taller building")
    print(f"  heights enriched in {time.time() - t0:.0f}s ({nb:,} buildings)")
    return d
