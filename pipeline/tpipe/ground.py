"""Vector ground for level-0 tiles (docs/SPEC.md, "Vector ground").

Level-0 tiles carry the land cover as a planar partition of smooth polygons
(no holes, no overlaps) plus water bodies with their real surface level and
typed shorelines. The tile worker triangulates them on the terrain grid
(app/src/workers/ground.ts). Levels 1-2 keep the raster.

    uv run python -m tpipe.ground TX,TY [TX,TY ...]   # debug: stats for L0 tiles

Pieces
  * OSM land cover (osm_areas.npz), in painter order: land use (residential,
    commercial, ...) at the bottom, then parks / woods / pitches / parking by
    area (smaller features are more specific and sit on top), then water, then
    piers and breakwaters (they stand in the water).
  * leisure=pitch/track by sport (tpipe ground_extra pass): hard courts,
    ball diamonds, running tracks, with an oriented frame for line markings.
  * man_made=pier/breakwater/groyne (lines are buffered to their real width).
  * waterways >= 3.5 m wide, buffered.
  * uncovered land within 45 m of a motorway / trunk becomes mown verge
    (medians, interchange infields, shoulders); commercial and industrial lots
    get a 4 m landscaped verge along their edge.
  Natural boundaries (water, woods, sand, wetland) are smoothed by capped
  corner cutting; man-made ones keep their corners (lightly rounded).

Water level (datum m)
  Lake Ontario -0.3 (74.7 m ASL), Lake Erie 99.2. Other water: the terrain's
  local minimum (90 m min filter) along the shore -- flat for ponds and lakes,
  a sampled field for rivers (varies > 2 m along the shore). Nothing is lower
  than Lake Ontario.

Shores (edges of water against land, water on the left)
  1 dockwall (vertical concrete) · 2 revetment (armour stone) · 3 beach ·
  4 natural bank. Sand next to the water → beach; piers → dockwall;
  breakwaters → revetment; curated zones (pipeline/curated/shores.json);
  great-lake water against industrial / commercial / paved land → dockwall,
  against anything else → revetment; everything else → natural bank.

Terrain (33 x 33 at level 0, 32 m)
  Land within 1.5 grid cells (48 m) of a shore is raised to at least water level + freeboard of
  that shore type (dockwall 1.6 m, revetment 1.1, beach 0.25, natural 0.35), so
  the drawn shore never dips under the water; points in the water sit at the
  water level.
"""

from __future__ import annotations

import json
import math
import sys
import time

import numpy as np
import shapely
from scipy import ndimage
from scipy.spatial import cKDTree
from shapely.strtree import STRtree

from . import geo

S0 = geo.TILE_SIZE[0]
GRID = 33  # level-0 terrain samples per side (32 m)
MIN_AREA = 4.0  # m²: smaller land-cover scraps are dropped (what is below shows)
SIMPLIFY = 0.2  # m, after smoothing
Q = 65535.0 / S0  # u16 quantisation of tile-local metres

# ground classes (docs/SPEC.md)
C_LAND, C_WATER, C_GRASS, C_FOREST, C_RES, C_COM, C_IND, C_FARM, C_SAND = 0, 1, 2, 3, 4, 5, 6, 7, 8
C_RAIL, C_PARKING, C_CEM, C_GOLF, C_AERO, C_WET, C_INST, C_CONS = 10, 11, 12, 13, 14, 16, 17, 18
C_PITCH, C_RUNWAY, C_PLAZA, C_AIRFIELD = 19, 20, 21, 23
C_COURT, C_DIAMOND, C_TRACK, C_PIER, C_BREAKWATER, C_VERGE = 24, 25, 26, 27, 28, 29
FRAMED = (C_PITCH, C_COURT, C_DIAMOND, C_TRACK)

# shore types
SH_NONE, SH_DOCK, SH_REVET, SH_BEACH, SH_NATURAL = 0, 1, 2, 3, 4
FREEBOARD = {SH_DOCK: 1.6, SH_REVET: 1.1, SH_BEACH: 0.25, SH_NATURAL: 0.35}
SHORE_NAMES = {"dockwall": SH_DOCK, "revetment": SH_REVET, "beach": SH_BEACH, "natural": SH_NATURAL}

LAKE_ONTARIO = -0.3
LAKE_ERIE = 99.2
FIELD = -32768  # gw_level sentinel: level comes from the gw_field grid

TIER0 = {C_FARM, C_RES, C_COM, C_IND, C_INST, C_AERO, C_CONS, C_RAIL, C_RUNWAY}
SMOOTH = {C_WATER: 10.0, C_FOREST: 12.0, C_SAND: 8.0, C_WET: 10.0, C_GRASS: 3.0, C_GOLF: 6.0, C_CEM: 2.0}

COURT_SPORTS = {"tennis", "basketball", "pickleball", "volleyball", "badminton", "table_tennis", "four_square",
                "multi", "skateboard", "shuffleboard", "american_handball", "hockey", "ice_hockey", "netball"}
DIAMOND_SPORTS = {"baseball", "softball"}
SAND_SPORTS = {"beachvolleyball"}
TRACK_SPORTS = {"running", "athletics", "multi", None}

W = {}  # prepared globals (shared with forked workers)

# ------------------------------------------------------------------ portals / trenches
# Rail kinds (rail_graph): 0 rail · 1 subway · 2 light rail · 3 tram.
# Tunnel mouth height above the rail (m) and the half-width of the cut per track.
MOUTH_H = {0: 7.0, 1: 5.0, 2: 5.6, 3: 5.6}
CUT_HW = {0: 2.9, 1: 2.4, 2: 2.5, 3: 2.3}
HEAD = 1.3  # headwall slab over the mouth
OPEN_D = 0.35  # the cut starts where the track is this far below the ground


def _portal_cfg():
    path = geo.PIPE / "curated" / "portals.json"
    if not path.exists():
        return []
    out = []
    for p in json.loads(path.read_text())["portals"]:
        e, n = geo.project(p["lon"], p["lat"])
        out.append(dict(p, e=float(e), n=float(n)))
    return out


def _trenches(terrain):
    """Open cuts where tunnel track (as the trains run it: rail_graph geometry)
    is below the ground but not yet deep enough to be in a tunnel; they end at a
    portal (headwall + mouth) where the depth reaches mouth height + HEAD."""
    try:
        from . import rail_graph
        g = rail_graph.load()
    except Exception as ex:  # rail graph not built: no portals
        print(f"ground: no rail graph ({ex}), no portals")
        return None
    cfg = _portal_cfg()
    skip = [c for c in cfg if c.get("skip")]
    pieces, tracks = [], []  # tracks: (xyz (n,3) of the cut part incl. depth, kind)
    for e in range(len(g.geom)):
        P, _, f = g.geom[e]
        if P.shape[0] < 2 or P.shape[1] < 3 or not (np.asarray(f) & 2).any():
            continue
        kind = int(g.e_kind[e])
        if int(g.e_svc[e]) != 0:
            continue  # sidings / yards (covered shop tracks are tagged as tunnels)
        P = np.asarray(P, np.float64)
        # densify to 2 m so depth crossings are found precisely
        seg = np.hypot(*np.diff(P[:, :2], axis=0).T)
        k = np.maximum(1, np.ceil(seg / 2.0)).astype(int)
        Q = [P[:1]]
        for i in range(len(P) - 1):
            t = (np.arange(1, k[i] + 1) / k[i])[:, None]
            Q.append(P[i] + (P[i + 1] - P[i]) * t)
        Q = np.vstack(Q)
        d = terrain.sample(Q[:, 0], Q[:, 1]) - Q[:, 2]
        D = MOUTH_H[kind] + HEAD
        m = (d > OPEN_D) & (d < D + 0.5)
        if not m.any() or d.max() < 2.0:
            continue  # shallow dips (DEM noise under a tunnel tag) are not portal ramps
        # runs of m
        i = 0
        while i < len(m):
            if not m[i]:
                i += 1
                continue
            j = i
            while j + 1 < len(m) and m[j + 1]:
                j += 1
            a, b = max(i - 1, 0), min(j + 1, len(Q) - 1)
            run = Q[a:b + 1]
            dr = d[a:b + 1]
            if len(run) >= 2 and np.hypot(*(run[-1, :2] - run[0, :2])) > 3.0:
                c = run[len(run) // 2]
                if not any(math.hypot(c[0] - s["e"], c[1] - s["n"]) < s.get("radius", 150.0) for s in skip):
                    ln = shapely.LineString(run[:, :2])
                    pieces.append(ln.buffer(CUT_HW[kind], cap_style="flat", join_style="round", quad_segs=3))
                    tracks.append((np.column_stack([run, dr]), kind))
            i = j + 1
    if not pieces:
        return None
    cut = shapely.union_all(pieces)
    cut = shapely.simplify(cut, 0.1)
    cuts = [q for q in _polys(cut) if q.area > 30]
    pts = np.vstack([t[0] for t in tracks])
    kinds = np.concatenate([np.full(len(t[0]), t[1]) for t in tracks])
    dirs = np.vstack([np.gradient(t[0][:, :2], axis=0) for t in tracks])
    dirs /= np.maximum(np.hypot(dirs[:, 0], dirs[:, 1]), 1e-9)[:, None]
    print(f"ground: {len(cuts)} open cuts / portal approaches from {len(tracks)} track runs")
    return dict(cuts=cuts, tree=STRtree(cuts), tracks=tracks, pts=pts, kinds=kinds, dirs=dirs,
                kd=cKDTree(pts[:, :2]), cfg=cfg)


def _tile_cuts(tile, x0, y0):
    """Cut polygons clipped to the tile, with per-edge types (0 wall · 1 portal · 2 open),
    and the track runs inside them."""
    T = W.get("trench")
    if T is None:
        return None, {}
    hits = T["tree"].query(tile, predicate="intersects")
    if len(hits) == 0:
        return None, {}
    polys = []
    for h in hits:
        c = shapely.intersection(T["cuts"][h], tile)
        polys += _split_holes(shapely.orient_polygons(c))
    polys = [q for q in polys if q.area > 1.0]
    if not polys:
        return None, {}
    union = shapely.union_all(polys)
    tb = shapely.box(x0 + 0.01, y0 + 0.01, x0 + S0 - 0.01, y0 + S0 - 0.01)
    off, xy, typ = [0], [], []
    for q in polys:
        r = np.asarray(q.exterior.coords)[:-1]
        nxt = np.roll(r, -1, axis=0)
        mid = (r + nxt) / 2
        ev = nxt - r
        el = np.maximum(np.hypot(ev[:, 0], ev[:, 1]), 1e-9)
        _, ii = T["kd"].query(mid)
        dp = T["pts"][ii, 3]
        kd = T["kinds"][ii]
        Dk = np.array([MOUTH_H[int(k)] + HEAD for k in kd])
        along = np.abs((ev[:, 0] * T["dirs"][ii, 0] + ev[:, 1] * T["dirs"][ii, 1]) / el)
        t = np.zeros(len(r), np.uint8)
        t[(dp >= Dk - 0.45) & (along < 0.6)] = 1
        t[(dp < OPEN_D + 0.25) & (along < 0.6)] = 2
        t[~shapely.contains_xy(tb, mid[:, 0], mid[:, 1])] = 2
        xy.append(r - [x0, y0])
        typ.append(t)
        off.append(off[-1] + len(r))
    arrays = {
        "pc_off": np.array(off, np.uint32),
        "pc_xy": np.clip(np.round(np.vstack(xy) * Q), 0, 65535).astype(np.uint16).ravel(),
        "pc_type": np.concatenate(typ),
    }
    # track runs through the cut (for the floor level, rails and heightAt)
    grow = union.buffer(3.0)
    toff, txyz, tk = [0], [], []
    for run, kind in T["tracks"]:
        if not grow.intersects(shapely.LineString(run[:, :2])):
            continue
        inside = shapely.contains_xy(grow, run[:, 0], run[:, 1])
        idx = np.nonzero(inside)[0]
        if len(idx) < 2:
            continue
        seg = run[idx[0]:idx[-1] + 1]
        txyz.append(np.column_stack([seg[:, 0] - x0, seg[:, 1] - y0, seg[:, 2]]))
        tk.append(kind)
        toff.append(toff[-1] + len(seg))
    if tk:
        arrays["pt_off"] = np.array(toff, np.uint32)
        arrays["pt_xyz"] = np.vstack(txyz).astype(np.float32).ravel()
        arrays["pt_kind"] = np.array(tk, np.uint8)
    return union, arrays



# ------------------------------------------------------------------ geometry helpers

def _smooth_ring(p: np.ndarray, rmax: float, iters: int = 2) -> np.ndarray:
    """Capped corner cutting (Chaikin with the cut limited to `rmax` metres)."""
    for _ in range(iters):
        n = len(p)
        if n < 3:
            return p
        nxt = np.roll(p, -1, axis=0)
        seg = nxt - p
        L = np.hypot(seg[:, 0], seg[:, 1])
        t = np.minimum(0.25, rmax / np.maximum(L, 1e-9))
        a = p + seg * t[:, None]          # near the start of each segment
        b = nxt - seg * t[:, None]        # near its end
        out = np.empty((2 * n, 2))
        out[0::2] = a
        out[1::2] = b
        p = out
    return p


def _smooth_poly(g, rmax: float, iters: int = 2):
    if g.is_empty or rmax <= 0:
        return g
    parts = []
    for q in shapely.get_parts(g):
        if q.geom_type != "Polygon":
            continue
        ext = _smooth_ring(np.asarray(q.exterior.coords)[:-1], rmax, iters)
        holes = [_smooth_ring(np.asarray(r.coords)[:-1], rmax, iters) for r in q.interiors]
        holes = [h for h in holes if len(h) >= 3]
        parts.append(shapely.Polygon(ext, holes))
    if not parts:
        return g
    out = shapely.make_valid(shapely.MultiPolygon(parts) if len(parts) > 1 else parts[0])
    return shapely.union_all([x for x in shapely.get_parts(out) if x.geom_type == "Polygon"]) if out.geom_type not in ("Polygon", "MultiPolygon") else out


def _split_holes(p) -> list:
    """Hole-free pieces of a polygon (cut vertically through each hole)."""
    if p.is_empty:
        return []
    out, stack = [], [p]
    while stack:
        q = stack.pop()
        if q.geom_type == "MultiPolygon" or q.geom_type == "GeometryCollection":
            stack += [x for x in shapely.get_parts(q) if x.geom_type == "Polygon" and not x.is_empty]
            continue
        if q.geom_type != "Polygon" or q.is_empty:
            continue
        if not q.interiors:
            out.append(q)
            continue
        h = shapely.Polygon(q.interiors[0])
        x = h.representative_point().x
        x0, y0, x1, y1 = q.bounds
        for box in (shapely.box(x0 - 1, y0 - 1, x, y1 + 1), shapely.box(x, y0 - 1, x1 + 1, y1 + 1)):
            r = shapely.intersection(q, box)
            if not r.is_empty:
                stack.append(r)
    return out


def _polys(g) -> list:
    return [x for x in shapely.get_parts(g) if x.geom_type == "Polygon" and not x.is_empty]


def _frame(g):
    """Oriented frame of a (pitch) polygon: cx, cy, angle of the long axis, half length, half width."""
    r = shapely.minimum_rotated_rectangle(g)
    c = np.asarray(r.exterior.coords)[:4] if r.geom_type == "Polygon" else None
    if c is None:
        b = g.bounds
        return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, 0.0, (b[2] - b[0]) / 2, (b[3] - b[1]) / 2)
    e1, e2 = c[1] - c[0], c[2] - c[1]
    l1, l2 = float(np.hypot(*e1)), float(np.hypot(*e2))
    ax = e1 if l1 >= l2 else e2
    ctr = c.mean(axis=0)
    return (float(ctr[0]), float(ctr[1]), float(math.atan2(ax[1], ax[0])), max(l1, l2) / 2, min(l1, l2) / 2)


# ------------------------------------------------------------------ prepare (once)

def _extras():
    """Pitches by sport and piers / breakwaters / groynes from work/ground_extra.osm.pbf
    (osmium tags-filter, see run.sh)."""
    import osmium
    from shapely import wkb

    path = geo.WORK / "ground_extra.osm.pbf"
    sport, lines, areas = {}, [], []
    if not path.exists():
        print("ground: work/ground_extra.osm.pbf missing, no sport/pier detail")
        return sport, lines, areas
    fab = osmium.geom.WKBFactory()
    for o in osmium.FileProcessor(str(path)).with_locations().with_areas():
        t = o.tags
        le, mm = t.get("leisure"), t.get("man_made")
        if o.is_area():
            oid = float(o.orig_id() if o.from_way() else -o.orig_id())
            if le in ("pitch", "track"):
                sp = (t.get("sport") or "").split(";")[0].strip() or None
                if le == "track":
                    sport[oid] = ("track", sp)
                else:
                    sport[oid] = ("pitch", sp)
            elif mm in ("pier", "breakwater", "groyne", "quay"):
                try:
                    g = wkb.loads(fab.create_multipolygon(o), hex=True)
                except Exception:
                    continue
                areas.append((mm, g))
        elif o.is_way() and mm in ("pier", "breakwater", "groyne") and not o.is_closed():
            pts = [(n.lon, n.lat) for n in o.nodes if n.location.valid()]
            if len(pts) >= 2:
                wd = t.get("width")
                try:
                    wd = float(wd) if wd else None
                except ValueError:
                    wd = None
                lines.append((mm, pts, wd))
    return sport, lines, areas


def prepare(terrain, coast_water):
    """Build the global inputs (smoothed polygons, levels, trees). Stored in W."""
    t0 = time.time()
    d = np.load(geo.WORK / "osm_areas.npz", allow_pickle=True)
    ring_off = np.zeros(len(d["ringlen"]) + 1, np.int64)
    np.cumsum(d["ringlen"], out=ring_off[1:])
    p_ring = np.zeros(len(d["nring"]) + 1, np.int64)
    np.cumsum(d["nring"], out=p_ring[1:])
    xy = d["xy"]
    cls_all, ids = d["cls"].astype(np.int64), d["id"]
    sport, xlines, xareas = _extras()

    geoms, cls, tier, frames, levels = [], [], [], [], []

    def add(g, c, tr, frame=None, level=None):
        g = shapely.make_valid(g)
        for q in _polys(g):
            if q.area < 0.5:
                continue
            geoms.append(q)
            cls.append(c)
            tier.append(tr)
            frames.append(frame)
            levels.append(level)

    for i in range(len(cls_all)):
        c = int(cls_all[i])
        r0, r1 = p_ring[i], p_ring[i + 1]
        rings = [xy[ring_off[r]:ring_off[r + 1]] for r in range(r0, r1)]
        g = shapely.Polygon(rings[0], rings[1:])
        frame = None
        if c in (C_AERO, C_RUNWAY):
            c = C_AIRFIELD
        if c == C_PITCH:
            kind, sp = sport.get(float(ids[i]), ("pitch", None))
            if kind == "track":
                c = C_TRACK if sp in TRACK_SPORTS else C_SAND if sp in ("horse_racing", "equestrian") else C_TRACK
            elif sp in COURT_SPORTS:
                c = C_COURT
            elif sp in DIAMOND_SPORTS:
                c = C_DIAMOND
            elif sp in SAND_SPORTS:
                c = C_SAND
            g = shapely.make_valid(g)
            if not g.is_empty:
                frame = _frame(g)
        if g.area < MIN_AREA:
            continue
        if c in SMOOTH:
            g = _smooth_poly(shapely.make_valid(shapely.simplify(g, 0.3)), SMOOTH[c], 2 if SMOOTH[c] >= 6 else 1)
        g = shapely.simplify(g, SIMPLIFY)
        tr = 0 if c in TIER0 or c == C_AIRFIELD else 2 if c == C_WATER else 1
        add(g, c, tr, frame)
    print(f"ground: {len(geoms):,} land-cover polygons ({time.time() - t0:.0f}s)")

    # piers / breakwaters (they stand in the water: top tier)
    for mm, pts, wd in xlines:
        e, n = geo.project(np.array([p[0] for p in pts]), np.array([p[1] for p in pts]))
        ln = shapely.LineString(np.column_stack([e, n]))
        w = wd if wd and 1 < wd < 60 else {"pier": 4.0, "breakwater": 12.0, "groyne": 6.0}[mm]
        add(ln.buffer(w / 2, cap_style="flat" if mm == "pier" else "round", join_style="mitre" if mm == "pier" else "round"),
            C_PIER if mm == "pier" else C_BREAKWATER, 3)
    from shapely.ops import transform
    for mm, g in xareas:
        g = transform(lambda x, y, z=None: geo.project(x, y), g)
        add(g, C_BREAKWATER if mm in ("breakwater", "groyne") else C_PIER, 3)

    # waterways (>= 3.5 m), smoothed centreline, buffered
    ln = np.load(geo.WORK / "osm_lines.npz", allow_pickle=True)
    lk, lw = ln["kind"], ln["width"]
    loff = np.zeros(len(lk) + 1, np.int64)
    np.cumsum(ln["len"], out=loff[1:])
    lxy = ln["xy"]
    nw = 0
    for i in np.nonzero((lk == 2) & (lw >= 3.5))[0]:
        p = lxy[loff[i]:loff[i + 1]]
        if len(p) < 2:
            continue
        q = shapely.LineString(p)
        add(q.buffer(float(lw[i]) / 2, cap_style="round", join_style="round", quad_segs=4), C_WATER, 2, level=FIELD)
        nw += 1
    # motorway / trunk centrelines for verges
    hw = np.nonzero((lk == 0) & (ln["cls"] <= 1) & ((ln["flags"] & 4) == 0))[0]
    W["hwy"] = [shapely.LineString(lxy[loff[i]:loff[i + 1]]) for i in hw if loff[i + 1] - loff[i] >= 2]
    W["hwy_tree"] = STRtree(W["hwy"])

    # great lakes
    for g in coast_water:
        c = shapely.centroid(g)
        lvl = LAKE_ERIE if c.y < -60000 else LAKE_ONTARIO
        g = shapely.simplify(_smooth_poly(shapely.make_valid(shapely.simplify(g, 0.3)), 8.0), SIMPLIFY)
        add(g, C_WATER, 2, level=lvl)
    print(f"ground: +{nw:,} waterways, {len(coast_water)} lake polygons ({time.time() - t0:.0f}s)")

    # water level field: 90 m min filter of the terrain, lightly smoothed; nothing below Lake Ontario
    wl = ndimage.grey_erosion(terrain.h, size=(3, 3))
    wl = ndimage.gaussian_filter(wl, 1.0)
    wl = np.maximum(wl, LAKE_ONTARIO).astype(np.float32)
    W["wl"] = wl
    W["wl_x0"], W["wl_y0"], W["wl_cell"] = terrain.x0, terrain.y0, terrain.cell

    # levels of flat water bodies
    for k in range(len(geoms)):
        if cls[k] != C_WATER or levels[k] is not None:
            continue
        ring = shapely.segmentize(geoms[k].exterior, 10.0)
        pts = np.asarray(ring.coords)
        v = water_field(pts[:, 0], pts[:, 1])
        lo, hi = np.percentile(v, [10, 90])
        if hi - lo > 2.0:
            levels[k] = FIELD
        else:
            lvl = float(lo)
            if lvl < LAKE_ONTARIO + 1.5 and shapely.centroid(geoms[k]).y > -60000:
                lvl = LAKE_ONTARIO  # harbours, lagoons, river mouths at lake level
            levels[k] = lvl

    W["geoms"] = np.array(geoms, dtype=object)
    W["cls"] = np.array(cls, np.int64)
    W["tier"] = np.array(tier, np.int64)
    W["area"] = shapely.area(W["geoms"])
    W["frames"] = frames
    W["levels"] = levels
    W["tree"] = STRtree(W["geoms"])
    W["curated"] = _curated_shores()
    W["trench"] = _trenches(terrain)
    print(f"ground: prepared {len(geoms):,} polygons in {time.time() - t0:.0f}s")


def _curated_shores():
    path = geo.PIPE / "curated" / "shores.json"
    if not path.exists():
        return []
    out = []
    for z in json.loads(path.read_text())["zones"]:
        ll = np.array(z["polygon"], dtype=np.float64)
        e, n = geo.project(ll[:, 0], ll[:, 1])
        out.append((shapely.Polygon(np.column_stack([e, n])), SHORE_NAMES[z["type"]]))
    return out


def water_field(x, y):
    """Water level field (datum m) at world x, y (bilinear)."""
    c = (np.asarray(x, np.float64) - W["wl_x0"]) / W["wl_cell"]
    r = (np.asarray(y, np.float64) - W["wl_y0"]) / W["wl_cell"]
    return ndimage.map_coordinates(W["wl"], [np.ravel(r), np.ravel(c)], order=1, mode="nearest").reshape(np.shape(x))


# ------------------------------------------------------------------ per tile

MARGIN = 40.0  # partition computed on the tile + margin so shores near the edge shape both tiles alike


def _partition(box):
    """Painter-order land cover inside `box` → list of (polygon, class, source index)."""
    hits = W["tree"].query(box, predicate="intersects")
    if len(hits) == 0:
        return [(box, C_LAND, -1)]
    # painter order: tier, then larger first (smaller = more specific, on top)
    order = hits[np.lexsort((-W["area"][hits], W["tier"][hits]))]
    clip = shapely.intersection(W["geoms"][order], box)
    keep = ~shapely.is_empty(clip)
    order, clip = order[keep], clip[keep]
    out = []
    covered = None
    # top-down: each feature keeps what nothing above it covers
    for k in range(len(order) - 1, -1, -1):
        g = clip[k]
        if covered is not None:
            g = shapely.difference(g, covered, grid_size=None)
        if not g.is_empty and g.area > 0.05:
            out.append((g, int(W["cls"][order[k]]), int(order[k])))
        covered = clip[k] if covered is None else shapely.union(covered, clip[k])
    rest = shapely.difference(box, covered)
    if not rest.is_empty:
        out.append((rest, C_LAND, -1))
    return out


def _verges(parts, box):
    """Uncovered land near motorways → verge; commercial / industrial lots get a 4 m verge band."""
    out = []
    hw_near = W["hwy_tree"].query(box.buffer(45.0), predicate="intersects")
    hwy_zone = shapely.union_all([W["hwy"][i] for i in hw_near]).buffer(45.0) if len(hw_near) else None
    for g, c, src in parts:
        if c == C_LAND and hwy_zone is not None:
            v = shapely.intersection(g, hwy_zone)
            if not v.is_empty and v.area > 1:
                out.append((v, C_VERGE, src))
                g = shapely.difference(g, hwy_zone)
            if not g.is_empty and g.area > 0.05:
                out.append((g, c, src))
            continue
        if c in (C_COM, C_IND) and src >= 0:
            inner = shapely.buffer(W["geoms"][src], -4.0, join_style="mitre")
            band = shapely.difference(g, inner)
            if not band.is_empty and band.area > 1:
                out.append((band, C_VERGE, src))
                g = shapely.intersection(g, inner)
        if not g.is_empty and g.area > 0.05:
            out.append((g, c, src))
    return out


def build(tx: int, ty: int, terrain):
    """Level-0 tile: shaped terrain grid (GRID x GRID, datum m) and vector ground arrays."""
    x0, y0 = tx * S0, ty * S0
    tile = shapely.box(x0, y0, x0 + S0, y0 + S0)
    ext = shapely.box(x0 - MARGIN, y0 - MARGIN, x0 + S0 + MARGIN, y0 + S0 + MARGIN)
    parts = _verges(_partition(ext), ext)
    cut_union, cut_arrays = _tile_cuts(tile, x0, y0)

    # ---- water: level per piece, shores
    water = [(g, src) for g, c, src in parts if c == C_WATER]
    land = [(g, c) for g, c, src in parts if c != C_WATER]
    wu = shapely.union_all([g for g, _ in water]) if water else None
    land_geoms = np.array([g for g, _ in land], dtype=object)
    land_cls = np.array([c for _, c in land], np.int64)
    land_tree = STRtree(land_geoms) if len(land_geoms) else None

    def level_of(src):
        return W["levels"][src] if src >= 0 and W["levels"][src] is not None else FIELD

    shores = []  # (xy (n,2) world, type, z (n,))
    if wu is not None and not wu.is_empty:
        # a water piece's level: its own source body (field for rivers)
        wgeoms = np.array([g for g, _ in water], dtype=object)
        wtree = STRtree(wgeoms)
        wlev = [level_of(src) for _, src in water]
        big = shapely.box(x0 - MARGIN + 0.01, y0 - MARGIN + 0.01, x0 + S0 + MARGIN - 0.01, y0 + S0 + MARGIN - 0.01)
        wu_o = shapely.orient_polygons(wu)
        for poly in _polys(wu_o):
            for ring in [poly.exterior, *poly.interiors]:
                p = np.asarray(shapely.segmentize(ring, 4.0).coords)
                if len(p) < 3:
                    continue
                a, b = p[:-1], p[1:]
                mid = (a + b) / 2
                dv = b - a
                L = np.hypot(dv[:, 0], dv[:, 1])
                ok = L > 1e-6
                nrm = np.zeros_like(dv)
                nrm[ok] = np.column_stack([dv[ok, 1], -dv[ok, 0]]) / L[ok, None]  # right = land side
                # edges on the extended box boundary are not shores
                inside = shapely.contains_xy(big, mid[:, 0], mid[:, 1])
                typ = np.full(len(mid), SH_NATURAL, np.int64)
                typ[~inside | ~ok] = SH_NONE
                # water body at each edge (for its level and lake-ness)
                probe = mid - nrm * 0.3
                qi = wtree.query(shapely.points(probe), predicate="intersects")
                body = np.full(len(mid), -1, np.int64)
                body[qi[0]] = qi[1]
                lvl = np.array([wlev[k] if k >= 0 else FIELD for k in body], np.float64)
                lake = (lvl != FIELD) & (np.abs(lvl - LAKE_ONTARIO) < 0.01)
                bigw = np.array([k >= 0 and wgeoms[k].area > 2e5 for k in body])
                # land class on the other side
                lc = np.full(len(mid), C_LAND, np.int64)
                if land_tree is not None:
                    li = land_tree.query(shapely.points(mid + nrm * 1.0), predicate="intersects")
                    lc[li[0]] = land_cls[li[1]]
                t = typ
                sel = t != SH_NONE
                t[sel & (lake | bigw) & np.isin(lc, [C_COM, C_IND, C_PLAZA, C_PARKING, C_RAIL, C_CONS])] = SH_DOCK
                t[sel & (lake | bigw) & ~np.isin(lc, [C_COM, C_IND, C_PLAZA, C_PARKING, C_RAIL, C_CONS])] = SH_REVET
                for zp, zt in W["curated"]:
                    if zp.intersects(ext):
                        m = sel & shapely.contains_xy(zp, mid[:, 0], mid[:, 1])
                        t[m] = zt
                t[sel & (lc == C_PIER)] = SH_DOCK
                t[sel & (lc == C_BREAKWATER)] = SH_REVET
                t[sel & (lc == C_SAND)] = SH_BEACH
                # water level per vertex (vertex k: from edge k)
                zf = water_field(a[:, 0], a[:, 1])
                z = np.where(lvl == FIELD, zf, lvl)
                # runs of equal type
                k = 0
                n = len(t)
                while k < n:
                    j = k
                    while j + 1 < n and t[j + 1] == t[k] and lvl[j + 1] == lvl[k]:
                        j += 1
                    if t[k] != SH_NONE:
                        pts = np.vstack([a[k:j + 1], b[j:j + 1]])
                        dense, dz = pts, np.append(z[k:j + 1], z[j])
                        # drop the 4 m classification samples: straight shores need no
                        # mid vertices (revetments keep ~3 m spacing for their rocks)
                        ln = shapely.simplify(shapely.LineString(pts), 0.15)
                        if int(t[k]) == SH_REVET:
                            ln = shapely.segmentize(ln, 3.0)
                        pts = np.asarray(ln.coords)
                        lv = lvl[k]
                        zz = water_field(pts[:, 0], pts[:, 1]) if lv == FIELD else np.full(len(pts), lv)
                        shores.append((pts, int(t[k]), zz, dense, dz))
                    k = j + 1
        # join runs across the ring start (same type, touching)
    # ---- terrain grid, shaped at the shores
    tgrid = np.linspace(0.0, S0, GRID)
    gx, gy = np.meshgrid(x0 + tgrid, y0 + tgrid)
    h = terrain.sample(gx, gy).astype(np.float64)
    if shores:
        P = np.vstack([s[3] for s in shores])
        Z = np.concatenate([s[4] + FREEBOARD[s[1]] for s in shores])
        tr = cKDTree(P)
        d, i = tr.query(np.column_stack([gx.ravel(), gy.ravel()]), distance_upper_bound=1.5 * S0 / (GRID - 1))
        m = np.isfinite(d)
        hf = h.ravel()
        hf[m] = np.maximum(hf[m], Z[i[m]])
        h = hf.reshape(h.shape)
    if wu is not None:
        inw = shapely.contains_xy(wu, gx.ravel(), gy.ravel()).reshape(h.shape)
        if inw.any():
            # open water (away from shores): the water surface
            lv = water_field(gx[inw], gy[inw])
            wlv = np.full(inw.sum(), np.nan)
            wgeoms = [g for g, _ in water]
            for (g, src) in water:
                lvl = level_of(src)
                if lvl == FIELD:
                    continue
                mm = shapely.contains_xy(g, gx[inw], gy[inw])
                wlv[mm] = lvl
            lv = np.where(np.isnan(wlv), lv, wlv)
            near = np.zeros(h.shape, bool)
            if shores:
                near.ravel()[m] = True
            sel = inw & ~near
            h[sel] = lv[sel[inw]]
            del wgeoms

    # ---- output arrays (clipped to the tile)
    arrays = {}
    polys, pcls, psrc = [], [], []
    for g, c, src in parts:
        g = shapely.intersection(g, tile)
        if cut_union is not None:
            g = shapely.difference(g, cut_union)
        if g.is_empty:
            continue
        g = shapely.orient_polygons(g)
        for q in _split_holes(g):
            if q.area < 0.2:
                continue
            polys.append(q)
            pcls.append(c)
            psrc.append(src)
    off = [0]
    xy = []
    for q in polys:
        r = np.asarray(q.exterior.coords)[:-1]
        xy.append(r)
        off.append(off[-1] + len(r))
    if polys:
        allv = np.vstack(xy) - [x0, y0]
        arrays["gp_off"] = np.array(off, np.uint32)
        arrays["gp_xy"] = np.clip(np.round(allv * Q), 0, 65535).astype(np.uint16).ravel()
        arrays["gp_class"] = np.array(pcls, np.uint8)
        # frames (pitches, courts, diamonds, tracks)
        fi, fr = [], []
        for k, (c, src) in enumerate(zip(pcls, psrc)):
            if c in FRAMED and src >= 0 and W["frames"][src] is not None:
                cx, cy, ang, hl, hw = W["frames"][src]
                fi.append(k)
                fr += [cx - x0, cy - y0, ang, hl, hw]
        if fi:
            arrays["gf_poly"] = np.array(fi, np.uint32)
            arrays["gf"] = np.array(fr, np.float32)
        # water levels
        wi, wl = [], []
        field = False
        for k, (c, src) in enumerate(zip(pcls, psrc)):
            if c != C_WATER:
                continue
            lvl = level_of(src)
            wi.append(k)
            if lvl == FIELD:
                field = True
                wl.append(-32768)
            else:
                wl.append(int(round(lvl * 10)))
        if wi:
            arrays["gw_poly"] = np.array(wi, np.uint32)
            arrays["gw_level"] = np.array(wl, np.int16)
        if field:
            t33 = np.linspace(0.0, S0, 33)
            fx, fy = np.meshgrid(x0 + t33, y0 + t33)
            arrays["gw_field"] = np.round(water_field(fx, fy) * 10).astype(np.int16).ravel()
    # shores clipped to the tile
    soff, sxy, sz, st = [0], [], [], []
    for pts, typ, zz, _, _ in shores:
        ln = shapely.LineString(np.column_stack([pts, zz]))
        c = shapely.intersection(ln, tile)
        for part in shapely.get_parts(c):
            if part.geom_type != "LineString" or part.length < 0.3:
                continue
            q = np.asarray(part.coords)
            if q.shape[1] < 3:
                continue
            sxy.append(q[:, :2] - [x0, y0])
            sz.append(q[:, 2])
            st.append(typ)
            soff.append(soff[-1] + len(q))
    if st:
        arrays["sh_off"] = np.array(soff, np.uint32)
        arrays["sh_xy"] = np.clip(np.round(np.vstack(sxy) * Q), 0, 65535).astype(np.uint16).ravel()
        arrays["sh_z"] = np.round(np.concatenate(sz) * 10).astype(np.int16)
        arrays["sh_type"] = np.array(st, np.uint8)
    arrays.update(cut_arrays)
    return h, arrays


# ------------------------------------------------------------------ tile patching

GROUND_KEYS = ("gp_off", "gp_xy", "gp_class", "gf_poly", "gf", "gw_poly", "gw_level", "gw_field",
               "sh_off", "sh_xy", "sh_z", "sh_type", "pc_off", "pc_xy", "pc_type", "pt_off", "pt_xyz", "pt_kind")


def patch(key):
    """Rewrite one level-0 tile with the shaped 65x65 terrain and the vector ground arrays."""
    from . import tbn
    from .terrain import get as get_terrain

    tx, ty = key
    path = geo.OUT / "tiles" / "0" / f"{tx}_{ty}.bin.gz"
    if not path.exists():
        return key, 0, 0
    arrays, header = tbn.read(path)
    arrays = {k: v for k, v in arrays.items() if k not in GROUND_KEYS}
    h, ga = build(tx, ty, get_terrain())
    arrays["terrain_h"] = np.clip(np.round(h * 10), -32768, 32767).astype(np.int16).ravel()
    arrays.update(ga)
    extra = {k: v for k, v in header.items() if k != "arrays"}
    size = tbn.write(path, arrays, **extra)
    return key, size, len(ga.get("gp_class", []))


def main():
    """uv run python -m tpipe.ground [--workers N] [--tiles TX,TY ...] [--bbox E0,N0,E1,N1]
    Patches level-0 tiles in place (run after tpipe.osm_tiles)."""
    import argparse
    import multiprocessing as mp

    from .osm_tiles import great_lakes
    from .terrain import get as get_terrain

    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--tiles", nargs="*", default=None)
    ap.add_argument("--bbox", action="append", default=None, help="E0,N0,E1,N1 (world metres), repeatable")
    args = ap.parse_args()
    t0 = time.time()
    t = get_terrain()
    prepare(t, great_lakes())
    man = json.loads((geo.OUT / "manifest.json").read_text())
    keys = [tuple(k) for k in man["tiles"]["0"]]
    if args.tiles:
        keys = [tuple(map(int, k.split(","))) for k in args.tiles]
    if args.bbox:
        boxes = [tuple(map(float, bb.split(","))) for bb in args.bbox]
        keys = [k for k in keys if any((k[0] + 1) * S0 > e0 and k[0] * S0 < e1 and (k[1] + 1) * S0 > n0 and k[1] * S0 < n1
                                       for e0, n0, e1, n1 in boxes)]
    total = 0
    ctx = mp.get_context("fork")
    with ctx.Pool(max(1, args.workers)) as pool:
        for n, (key, size, npoly) in enumerate(pool.imap_unordered(patch, keys, chunksize=4), 1):
            total += size
            if n % 200 == 0 or len(keys) < 50:
                print(f"  [{n}/{len(keys)}] L0 {key}: {npoly} polys, {size / 1e3:.0f} kB ({time.time() - t0:.0f}s)", flush=True)
    print(f"ground: patched {len(keys)} L0 tiles, {total / 1e6:.0f} MB in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
