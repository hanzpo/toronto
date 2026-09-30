"""Interpenetration ("nothing clips into anything") checks, region-wide per block.

Buildings are the drawn ones: outer ring + holes, landmark-suppressed ids
removed (the tile worker skips them). A building "floats clear" of what runs
under it when its extruded part starts high enough (b_base + b_min above the
track / road surface by the clearance): station roofs, bridges-as-buildings,
overhangs. Props and trees come from the client placement dump (checks_objects).

Categories:
  building_over_track        drawn track centreline (tiles l_*, no tunnels) within
                             TRACK_HALF of a footprint the train can't pass under
  building_over_road         carriageway ribbon (classes 0-6, drawn at grade) inside
                             a footprint by >= ROAD_MIN_AREA
  prop_in_building           lamp / signal pole inside a footprint
  tree_in_building           tree trunk inside a footprint (or a house) where the
                             tree reaches the building's walls
  tree_on_platform           tree trunk on a station platform (stations.json)
  house_overlap              house instance overlapping a building, a road ribbon or
                             another house
  vehicle_path_through_building  surface bus / streetcar / train shape samples inside
                             a footprint (vehicles drive through walls)
  lot_over_building          parking lot polygon (gp_class 11; stalls, cars, lamps
                             drawn on it) overlapping a building
"""

from __future__ import annotations

import math

import numpy as np
import shapely

from . import checks_transit
from .checks_objects import Carriageway, load_props
from .core import finding
from .data import F_BRIDGE, F_TUNNEL, Block, ground_polys, platform_polys

# ----------------------------------------------------------------------------- thresholds
TRACK_HALF = 2.5  # m either side of a track centreline (rolling stock envelope)
TRACK_CLEAR = 5.0  # m: building part starting this far above the rail passes over it
ROAD_CLEAR = 4.5  # m above the road surface
ROAD_MIN_AREA = 8.0  # m2 of ribbon inside a footprint
PROP_INSIDE = 0.3  # m inside the wall
TREE_INSIDE = 0.5  # m inside the wall
HOUSE_MIN_AREA = 6.0  # m2 (house vs building / road / house)
PATH_MIN_LEN = 16.0  # m of vehicle path inside one building
LOT_MIN_AREA = 20.0  # m2 of parking lot over a building
LOT_EXEMPT_KINDS = {14, 15}  # parking structures, roofs / canopies

CLIP_CATS = {"building_over_track", "building_over_road", "prop_in_building", "tree_in_building", "tree_on_platform",
             "house_overlap", "vehicle_path_through_building", "lot_over_building"}
RAIL_NAME = ["main line", "siding", "subway", "light rail", "streetcar", "rail"]


def _bld_bottom(A, i):
    return A["base"][i] + A["min"][i]


def _contains_depth(polys, tree, px, py, depth):
    """(point idx, polygon idx) for points inside a polygon by more than `depth` m."""
    if len(px) == 0 or len(polys) == 0:
        return np.zeros(0, np.int64), np.zeros(0, np.int64)
    pts = shapely.points(px, py)
    a, b = tree.query(pts, predicate="within")
    if len(a) and depth > 0:
        d = shapely.distance(pts[a], shapely.boundary(polys[b]))
        k = d > depth
        a, b = a[k], b[k]
    return a, b


def run(B: Block, cats: set) -> list[dict]:
    want = CLIP_CATS & cats
    if not want or not B.tiles:
        return []
    out: list[dict] = []
    polys, A = B.buildings(holes=True)
    btree = shapely.STRtree(polys) if len(polys) else None
    hp, H = B.houses()

    # ------------------------------------------------------------------ building_over_track
    L = B.rails
    if "building_over_track" in cats and btree is not None and L.n:
        lf, lc = L.attrs["flags"], L.attrs["class"]
        sp = L.seg_piece
        k = (lf[sp] & F_TUNNEL) == 0
        s, sp = L.seg[k], sp[k]
        if len(s):
            lines = shapely.linestrings(np.stack([np.stack([L.X[s], L.Y[s]], 1), np.stack([L.X[s + 1], L.Y[s + 1]], 1)], 1))
            a, b = btree.query(lines, predicate="dwithin", distance=TRACK_HALF)
            if len(a):
                zr = np.where(lf[sp[a]] & F_BRIDGE, (L.Z[s[a]] + L.Z[s[a] + 1]) / 2,
                              B.terrain((L.X[s[a]] + L.X[s[a] + 1]) / 2, (L.Y[s[a]] + L.Y[s[a] + 1]) / 2))
                zr = np.where(np.isfinite(zr), zr, (L.Z[s[a]] + L.Z[s[a] + 1]) / 2)
                clear = _bld_bottom(A, b) - zr >= TRACK_CLEAR
                top_below = A["base"][b] + A["height"][b] < zr + 0.5  # building entirely under a rail bridge
                k = ~clear & ~top_below
                a, b = a[k], b[k]
                if len(a):
                    inside = shapely.length(shapely.intersection(lines[a], shapely.buffer(polys[b], TRACK_HALF, quad_segs=2)))
                    best: dict = {}
                    for q in range(len(a)):
                        key = int(b[q])
                        best.setdefault(key, [0.0, q])
                        best[key][0] += inside[q]
                        if inside[q] > inside[best[key][1]]:
                            best[key][1] = q
                    for bi, (ln, q) in best.items():
                        if ln < 1.0:
                            continue
                        c = shapely.centroid(shapely.intersection(lines[a[q]], shapely.buffer(polys[bi], TRACK_HALF, quad_segs=2)))
                        x, y = shapely.get_x(c), shapely.get_y(c)
                        if not B.in_core(x, y):
                            continue
                        j = s[a[q]]
                        cls = min(int(lc[sp[a[q]]]), 5)
                        o = int(A["osm"][bi])
                        out.append(finding("building_over_track", RAIL_NAME[cls].replace(" ", "_"), ln * (2 if cls in (0, 2, 3) else 1), x, y,
                                           float(zr[q]), [o, L.attrs["osm"][sp[a[q]]]],
                                           f"{RAIL_NAME[cls]} track runs {ln:.0f} m through building {o} (kind {int(A['kind'][bi])}, "
                                           f"{A['height'][bi]:.0f} m, bottom {_bld_bottom(A, bi) - zr[q]:+.1f} m vs rail)",
                                           key=("building_over_track", o), bearing=math.atan2(L.Y[j + 1] - L.Y[j], L.X[j + 1] - L.X[j])))

    cw = Carriageway(B) if ({"building_over_road", "house_overlap"} & cats) else None
    # ------------------------------------------------------------------ building_over_road
    if "building_over_road" in cats and btree is not None and cw is not None and cw.ok:
        R = B.roads
        q_ = ribbon_quads_cw(cw)
        a, b = btree.query(q_, predicate="intersects")
        if len(a):
            clear = _bld_bottom(A, b) - cw.z[a] >= ROAD_CLEAR
            under = A["base"][b] + A["height"][b] < cw.z[a] + 0.5
            k = ~clear & ~under
            a, b = a[k], b[k]
            ar = shapely.area(shapely.intersection(q_[a], polys[b]))
            tot: dict = {}
            for q in range(len(a)):
                key = (int(b[q]), cw.osm[a[q]])
                t = tot.setdefault(key, [0.0, q])
                t[0] += ar[q]
                if ar[q] > ar[t[1]]:
                    t[1] = q
            for (bi, ro), (area, q) in tot.items():
                if area < ROAD_MIN_AREA:
                    continue
                s = a[q]
                c = shapely.centroid(shapely.intersection(q_[s], polys[bi]))
                x, y = shapely.get_x(c), shapely.get_y(c)
                if not B.in_core(x, y):
                    continue
                o = int(A["osm"][bi])
                cls = int(cw.cls[s])
                names = B.data[R.tile[cw.sp[s]]].get("_names", [])
                ni = int(R.attrs["name"][cw.sp[s]])
                nm = names[ni] if 0 <= ni < len(names) else ""
                sub = "motorway" if cls <= 1 else ("arterial" if cls <= 4 else ("local" if cls == 5 else "service"))
                out.append(finding("building_over_road", sub,
                                   area / 10 * (3 if cls <= 1 else 2 if cls <= 4 else 1 if cls == 5 else 0.4), x, y, float(cw.z[s]), [o, ro],
                                   f"building {o} ({A['height'][bi]:.0f} m) covers {area:.0f} m2 of {nm or 'way ' + str(int(ro))} "
                                   f"(class {cls}) carriageway at grade", key=("building_over_road", o, int(ro)),
                                   bearing=math.atan2(cw.y1[s] - cw.y0[s], cw.x1[s] - cw.x0[s])))

    # ------------------------------------------------------------------ props / trees in buildings
    P = None
    if {"prop_in_building", "tree_in_building", "tree_on_platform"} & cats:
        P = B.__dict__.get("_props") or load_props(B)
        B._props = P
    if "prop_in_building" in cats and btree is not None:
        for kind, D in (("lamp", P["lamps"]), ("signal_pole", P["signals"])):
            core = np.nonzero(B.in_core(D["x"], D["y"]))[0]
            a, b = _contains_depth(polys, btree, D["x"][core], D["y"][core], PROP_INSIDE)
            seen = set()
            for q, bi in zip(a, b):
                i = core[q]
                if i in seen or _bld_bottom(A, bi) - D["z"][i] > 9.0:
                    continue
                seen.add(i)
                o = int(A["osm"][bi])
                out.append(finding("prop_in_building", kind, 3.0 if kind == "signal_pole" else 2.0, D["x"][i], D["y"][i], D["z"][i], [o],
                                   f"{kind.replace('_', ' ')} stands inside building {o} ({A['height'][bi]:.0f} m)"))
    T = P["trees"] if P is not None else None
    if "tree_in_building" in cats and T is not None and len(T["x"]):
        core = np.nonzero(B.in_core(T["x"], T["y"]))[0]
        if btree is not None:
            a, b = _contains_depth(polys, btree, T["x"][core], T["y"][core], TREE_INSIDE)
            seen = set()
            for q, bi in zip(a, b):
                i = core[q]
                if i in seen or _bld_bottom(A, bi) - T["z"][i] > T["h"][i]:
                    continue  # tree fits under an overhang
                seen.add(i)
                o = int(A["osm"][bi])
                out.append(finding("tree_in_building", "building", 2.0 + T["h"][i] / 10, T["x"][i], T["y"][i], T["z"][i], [o],
                                   f"{T['h'][i]:.0f} m tree grows inside building {o} ({A['height'][bi]:.0f} m)"))
        if len(hp):
            ht = shapely.STRtree(hp)
            a, b = _contains_depth(hp, ht, T["x"][core], T["y"][core], TREE_INSIDE)
            seen = set()
            for q, bi in zip(a, b):
                i = core[q]
                if i in seen:
                    continue
                seen.add(i)
                out.append(finding("tree_in_building", "house", 1.5 + T["h"][i] / 10, T["x"][i], T["y"][i], T["z"][i], [H["osm"][bi]],
                                   f"{T['h'][i]:.0f} m tree grows inside house {int(H['osm'][bi])}"))
    if "tree_on_platform" in cats and T is not None and len(T["x"]):
        pp, info = platform_polys()
        if len(pp):
            core = np.nonzero(B.in_core(T["x"], T["y"]))[0]
            a, b = _contains_depth(pp, shapely.STRtree(pp), T["x"][core], T["y"][core], 0.0)
            for q, pi in zip(a, b):
                i = core[q]
                I = info[pi]
                if I.get("grade") == "underground":
                    continue
                out.append(finding("tree_on_platform", I["mode"] or "platform", 3.0 + T["h"][i] / 10, T["x"][i], T["y"][i], T["z"][i], [],
                                   f"{T['h'][i]:.0f} m tree on the {I['type']} platform of {I['station']} ({I['mode']})",
                                   key=("tree_on_platform", round(T["x"][i], 1), round(T["y"][i], 1))))

    # ------------------------------------------------------------------ houses
    if "house_overlap" in cats and len(hp):
        core = B.in_core(H["x"], H["y"])
        hc = np.nonzero(core)[0]
        if btree is not None and len(hc):
            a, b = btree.query(hp[hc], predicate="intersects")
            if len(a):
                ar = shapely.area(shapely.intersection(hp[hc[a]], polys[b]))
                for q in np.nonzero(ar >= HOUSE_MIN_AREA)[0]:
                    i, bi = hc[a[q]], b[q]
                    out.append(finding("house_overlap", "building", ar[q] / 10, H["x"][i], H["y"][i], H["base"][i] + H["height"][i],
                                       [H["osm"][i], A["osm"][bi]],
                                       f"house {int(H['osm'][i])} overlaps building {int(A['osm'][bi])} by {ar[q]:.0f} m2",
                                       key=("house_overlap", "b", int(H["osm"][i]), int(A["osm"][bi]))))
        if cw is not None and cw.ok and len(hc):
            q_ = ribbon_quads_cw(cw)
            rt = shapely.STRtree(q_)
            a, b = rt.query(hp[hc], predicate="intersects")
            if len(a):
                k = ~cw.bridge[b] | (cw.z[b] - H["base"][hc[a]] < H["height"][hc[a]])
                a, b = a[k], b[k]
                ar = shapely.area(shapely.intersection(hp[hc[a]], q_[b]))
                best: dict = {}
                for q in range(len(a)):
                    t = best.setdefault(int(a[q]), [0.0, q])
                    t[0] += ar[q]
                for ai, (area, q) in best.items():
                    if area < HOUSE_MIN_AREA:
                        continue
                    i, s = hc[ai], b[q]
                    out.append(finding("house_overlap", "road", area / 5, H["x"][i], H["y"][i], H["base"][i], [H["osm"][i], cw.osm[s]],
                                       f"house {int(H['osm'][i])} stands {area:.0f} m2 into the carriageway of way {int(cw.osm[s])} (class {int(cw.cls[s])})",
                                       key=("house_overlap", "r", int(H["osm"][i])),
                                       bearing=math.atan2(cw.y1[s] - cw.y0[s], cw.x1[s] - cw.x0[s])))
        if len(hc):
            ht = shapely.STRtree(hp)
            a, b = ht.query(hp[hc], predicate="intersects")
            k = hc[a] != b
            a, b = a[k], b[k]
            if len(a):
                ar = shapely.area(shapely.intersection(hp[hc[a]], hp[b]))
                for q in np.nonzero(ar >= HOUSE_MIN_AREA)[0]:
                    i, j = hc[a[q]], b[q]
                    oi, oj = sorted((int(H["osm"][i]), int(H["osm"][j])))
                    out.append(finding("house_overlap", "house", ar[q] / 10, H["x"][i], H["y"][i], H["base"][i] + H["height"][i], [oi, oj],
                                       f"houses {oi} and {oj} overlap {ar[q]:.0f} m2", key=("house_overlap", "h", oi, oj)))

    # ------------------------------------------------------------------ vehicle paths through buildings
    if "vehicle_path_through_building" in cats and btree is not None:
        S = checks_transit._get()
        m = B.in_core(S["x"], S["y"])
        if m.any():
            idx = np.nonzero(m)[0]
            px, py, pz = (S[k][idx].astype(np.float64) for k in ("x", "y", "z"))
            pm, pl = S["mode"][idx], S["label"][idx]
            tz = B.terrain(px, py)
            surf = ~(pz < tz - checks_transit.TUNNEL)
            a, b = _contains_depth(polys, btree, px, py, 0.5)
            k = surf[a]
            zveh = np.where(np.isfinite(tz[a]), np.maximum(pz[a], tz[a]), pz[a])
            k &= _bld_bottom(A, b) - zveh < TRACK_CLEAR  # passes under high structures
            k &= A["base"][b] + A["height"][b] > zveh + 0.5  # not a building below a viaduct
            a, b = a[k], b[k]
            groups: dict = {}
            for q in range(len(a)):
                groups.setdefault((int(b[q]), int(pm[a[q]])), []).append(a[q])
            labels = S["labels"]
            for (bi, mode), pts in groups.items():
                ln = len(pts) * checks_transit.SAMPLE
                if ln < PATH_MIN_LEN:
                    continue
                q = pts[len(pts) // 2]
                o = int(A["osm"][bi])
                labs = sorted({labels[j] for j in pl[pts]})
                what = ["bus", "streetcar/LRT", "train"][min(mode, 2)]
                out.append(finding("vehicle_path_through_building", what.split("/")[0], ln / 8 * (2 if mode == 2 else 1), px[q], py[q], pz[q],
                                   [o], f"{what} path ({', '.join(labs[:4])}) runs {ln:.0f} m through building {o} "
                                        f"(kind {int(A['kind'][bi])}, {A['height'][bi]:.0f} m)",
                                   key=("vehicle_path_through_building", o, mode)))

    # ------------------------------------------------------------------ parking lots over buildings
    if "lot_over_building" in cats and btree is not None:
        lots = ground_polys(B, 11)
        if len(lots):
            a, b = btree.query(lots, predicate="intersects")
            if len(a):
                k = ~np.isin(A["kind"][b].astype(np.int64), list(LOT_EXEMPT_KINDS))
                a, b = a[k], b[k]
                inter = shapely.intersection(lots[a], polys[b])
                ar = shapely.area(inter)
                cen = shapely.centroid(inter)
                cx, cy = shapely.get_x(cen), shapely.get_y(cen)
                for q in np.nonzero(ar >= LOT_MIN_AREA)[0]:
                    if not B.in_core(cx[q], cy[q]):
                        continue
                    bi = b[q]
                    o = int(A["osm"][bi])
                    fr = ar[q] / max(polys[bi].area, 1e-6)
                    out.append(finding("lot_over_building", "building", ar[q] / 20 * (1 + fr), cx[q], cy[q], None, [o],
                                       f"parking lot (stalls / parked cars / lamps) covers {ar[q]:.0f} m2 ({fr * 100:.0f}%) of building {o} "
                                       f"({A['height'][bi]:.0f} m)", key=("lot_over_building", o, round(cx[q]), round(cy[q]))))
    return out


def ribbon_quads_cw(cw: Carriageway):
    """Drawn pavement quads of the carriageway segments (per-vertex r_pl / r_pr on network-model tiles)."""
    return cw.quads()
