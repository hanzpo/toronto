"""Rail corridor primitives for the network-model slice (docs/NETWORK.md, docs/SURFACE.md interface).

From the model (work/roadnet.npz rail pieces, the one source of track plan and z) and the slice's
street sweeps (tpipe.primgeom), inside the slice bbox:

  tracks      heavy-rail track bands (main 0 / siding 1): centreline xyz = formation level; drawn
              as the tile renderer does (ballast prism half width 1.8 / 1.4 m, top 0.6 m narrower
              at + 0.28 m, rails at +-0.7175 m, rail head + 0.44 m)
  bed         one shared bed: the union of the tracks' ballast footprints with gaps under 4 m closed
              (the yard fan is one bed, not a row of prisms), meshed (1.5 m cells, constrained
              Delaunay per cell) with z from the nearest tracks' formation level
  edges       at the bed's boundary, the lidar DTM outward decides: flush (< 0.5 m), a 1:2 slope
              (berm or cut) to the ground where it fits, or a retaining wall up / down to street
              level where it does not (a street or building within the slope's width, or the
              ground already steps: > 1:1)
  fences      1.8 m chain-link along the corridor's outer line (top of the slope / wall), open at
              level crossings and where the bbox clips the corridor
  structures  street-over-rail bridges: the slice edges' bridge stations (model vf bridge bit) ->
              deck footprint (walk edge to walk edge), abutment lines at both ends (deck z, seat
              = deck z - DECK_DEPTH), piers across the deck at <= SPAN_MAX spacing, placed only
              where the pier line clears every track band by PIER_CLEAR
  crossings   mapped level crossings (crossings.json, from the model) on slice streets: the
              crossing panel across the carriageway along the track, gate masts / arms / lights
              per tags

All z are datum m. Exported in primnet.json ("rail") and net2/surface.npz (rb_ / rt_ / rs_ / rw_ /
rf_ / st_ / sa_ / sp_ arrays; docs/SPEC.md).
"""
from __future__ import annotations

import json
import math

import numpy as np
from scipy.spatial import cKDTree

from . import geo

HW_BALLAST = {0: 1.8, 1: 1.4}
BED_CLOSE = 2.0           # m: closing radius (gaps under 2 x this between ballast footprints are bed)
FLUSH = 0.5               # m: bed edge within this of the ground: no slope / wall
SLOPE = 2.0               # horizontal per vertical (1:2)
STEEP = 1.0               # the ground itself rises faster than 1:1 next to the bed: a wall
RAY = 26.0                # m: outward search for the ground beyond the bed edge
EDGE_STEP = 4.0           # m: boundary sampling
FENCE_H = 1.8
DECK_DEPTH = 1.5
PARAPET_H = 1.05
SPAN_MAX = 35.0
PIER_CLEAR = 1.5          # m: pier faces clear of a track's ballast footprint
PIER_W = 1.2


def _clip_lines(P, V, bbox):
    """runs of P inside bbox (list of index arrays)"""
    x0, y0, x1, y1 = bbox
    m = (P[:, 0] > x0) & (P[:, 0] < x1) & (P[:, 1] > y0) & (P[:, 1] < y1)
    out, cur = [], []
    for k in range(len(P)):
        if m[k]:
            cur.append(k)
        elif cur:
            out.append(np.array(cur)); cur = []
    if cur:
        out.append(np.array(cur))
    return [r for r in out if len(r) >= 2]


def tracks_in(A, bbox):
    off = A["rail_off"].astype(np.int64)
    xyz, cls, vf = A["rail_xyz"], A["rail_cls"], A["rail_vf"].astype(np.int64)
    oo = A["rail_osm_off"].astype(np.int64) if "rail_osm_off" in A else None
    out = []
    for i in range(len(off) - 1):
        c = int(cls[i])
        if c > 1:
            continue
        P, V = xyz[off[i]:off[i + 1]].astype(np.float64), vf[off[i]:off[i + 1]]
        for r in _clip_lines(P, V, bbox):
            osm = [int(o) for o in A["rail_osm"][oo[i]:oo[i + 1]]] if oo is not None else []
            out.append(dict(piece=i, cls=c, xyz=P[r], vf=V[r], osm=osm, hw=HW_BALLAST.get(c, 1.8)))
    return out


def bed(tracks, bbox):
    import shapely
    from .primgeom import box_patch
    segs = []
    for t in tracks:
        at = (t["vf"] & 3) == 0          # bridges / tunnels carry their own deck
        P = t["xyz"]
        k = 0
        while k < len(P) - 1:
            if not at[k]:
                k += 1
                continue
            j = k
            while j + 1 < len(P) and at[j + 1]:
                j += 1
            if j > k:
                segs.append(shapely.buffer(shapely.LineString(P[k:j + 1, :2]), t["hw"], cap_style="flat"))
            k = j + 1
    if not segs:
        return None, None
    U = shapely.union_all(segs).buffer(BED_CLOSE, join_style="round").buffer(-BED_CLOSE, join_style="round")
    U = U.intersection(shapely.box(*bbox))
    polys = [g for g in shapely.get_parts(U) if g.geom_type == "Polygon" and g.area > 5.0]
    # z: nearest tracks' formation level (inverse-distance over the 4 nearest track vertices)
    TP = np.vstack([t["xyz"] for t in tracks])
    tree = cKDTree(TP[:, :2])

    def zq(xy):
        d, k = tree.query(np.asarray(xy)[:, :2], k=4)
        w = 1.0 / np.maximum(d, 0.3) ** 2
        return (TP[k, 2] * w).sum(1) / w.sum(1)
    meshes = []
    for g in polys:
        # box_patch takes an outline [(xy, z)] and meshes it; the bed's z comes from the tracks
        # (holes: the patch is per outer ring, holes filled by their own interior samples)
        ring = np.asarray(g.exterior.coords)[:-1]
        if len(ring) < 3:
            continue
        pt = box_patch([(p, 0.0) for p in ring])
        if pt is None:
            continue
        V = np.array(pt["p"])
        keep = shapely.contains_xy(g.buffer(0.01), V[:, 0], V[:, 1])
        T = [t_ for t_ in pt["t"] if keep[t_[0]] and keep[t_[1]] and keep[t_[2]]
             or shapely.contains_xy(g, *V[t_].mean(0))]
        z = zq(V) + 0.03
        meshes.append(dict(p=np.round(V, 3).tolist(), z=np.round(z, 3).tolist(), t=T))
    return polys, dict(meshes=meshes, zq=zq)


def edges_of(polys, zq, terr, block, bbox, crossings_xy):
    """slopes / walls / fences along the bed's outer boundary"""
    import shapely
    x0, y0, x1, y1 = bbox
    slopes, walls, fences = [], [], []
    stats = dict(flush=0, slope=0, wall=0)
    for g in polys:
        ring = shapely.LineString(np.asarray(g.exterior.coords))
        L = ring.length
        n = max(4, int(L / EDGE_STEP))
        s = np.linspace(0, L, n + 1)[:-1]
        P = np.array([[ring.interpolate(v).x, ring.interpolate(v).y] for v in s])
        Q = np.roll(P, -1, axis=0) - np.roll(P, 1, axis=0)
        Q /= np.maximum(np.hypot(Q[:, 0], Q[:, 1]), 1e-9)[:, None]
        nrm = np.column_stack([Q[:, 1], -Q[:, 0]])
        out_ = ~shapely.contains_xy(g, P[:, 0] + nrm[:, 0] * 0.5, P[:, 1] + nrm[:, 1] * 0.5)
        nrm[~out_] *= -1                                     # outward
        on_bbox = (np.abs(P[:, 0] - x0) < 0.5) | (np.abs(P[:, 0] - x1) < 0.5) | (np.abs(P[:, 1] - y0) < 0.5) | (np.abs(P[:, 1] - y1) < 0.5)
        zb = zq(P)
        d = np.arange(1.0, RAY + 0.1, 1.0)
        RX = P[:, None, 0] + nrm[:, None, 0] * d[None, :]
        RY = P[:, None, 1] + nrm[:, None, 1] * d[None, :]
        H = terr.sample(RX, RY)
        kind, zout, dout = [], [], []
        for k in range(len(P)):
            if on_bbox[k]:
                kind.append("clip"); zout.append(zb[k]); dout.append(0.0)
                continue
            h = H[k]
            # the ground beyond the bed: the first sample after which the profile flattens (< 1:6)
            g_ = np.abs(np.diff(h)) < 1.0 / 6.0
            j = int(np.argmax(g_)) if g_.any() else len(h) - 1
            j = max(j, 1)
            zo = float(h[j]); dz = zo - zb[k]
            if abs(dz) < FLUSH:
                kind.append("flush"); zout.append(zo); dout.append(0.0)
                continue
            need = abs(dz) * SLOPE
            # obstacle along the ray (street / building / other corridor feature)
            ray = shapely.LineString([P[k], P[k] + nrm[k] * max(need, 1.0)])
            blocked = block is not None and block.intersects(ray)
            steep = abs(h[min(j, len(h) - 1)] - h[0]) / max(d[j] - d[0], 1.0) > STEEP if j > 0 else False
            if blocked or steep or need > RAY:
                kind.append("wall"); zout.append(zo); dout.append(0.0)
            else:
                kind.append("slope"); zout.append(zo); dout.append(need)
        kind = np.array(kind); zout = np.array(zout); dout = np.array(dout)
        for nm_ in ("flush", "slope", "wall"):
            stats[nm_] += int((kind == nm_).sum())
        # runs of one kind -> features (closed ring: rotate to start at a kind change)
        idx = list(range(len(P)))
        ch = [k for k in idx if kind[k] != kind[k - 1]]
        start = ch[0] if ch else 0
        order = idx[start:] + idx[:start]
        runs, cur = [], [order[0]]
        for k in order[1:]:
            if kind[k] == kind[cur[-1]]:
                cur.append(k)
            else:
                runs.append(cur); cur = [k]
        runs.append(cur)
        for r in runs:
            r2 = r + [r[-1] + 1 if r[-1] + 1 < len(P) else 0]           # close to the next sample
            K = kind[r[0]]
            if K == "slope":
                inner = np.column_stack([P[r2], zb[r2]])
                dd = dout[r2]
                outer = np.column_stack([P[r2] + nrm[r2] * dd[:, None], zout[r2]])
                slopes.append(dict(inner=np.round(inner, 3).tolist(), outer=np.round(outer, 3).tolist(),
                                   kind="cut" if (zout[r] > zb[r]).mean() > 0.5 else "berm"))
                line = outer
            elif K == "wall":
                walls.append(dict(xy=np.round(P[r2], 3).tolist(), zb=np.round(np.minimum(zb[r2], zout[r2]), 3).tolist(),
                                  zt=np.round(np.maximum(zb[r2], zout[r2]), 3).tolist(),
                                  retains="ground" if (zout[r] > zb[r]).mean() > 0.5 else "bed"))
                line = np.column_stack([P[r2], np.maximum(zb[r2], zout[r2])])
            elif K == "flush":
                line = np.column_stack([P[r2] + nrm[r2] * 1.0, zout[r2]])
            else:
                continue
            # fence along the outer line, open at level crossings
            keep = np.array([min((np.hypot(*(q[:2] - c)) for c in crossings_xy), default=99.0) > 8.0 for q in line])
            k = 0
            while k < len(line):
                if not keep[k]:
                    k += 1
                    continue
                j = k
                while j + 1 < len(line) and keep[j + 1]:
                    j += 1
                if j > k:
                    fences.append(dict(xyz=np.round(line[k:j + 1], 3).tolist(), h=FENCE_H))
                k = j + 1
    return slopes, walls, fences, stats


def structures(edges, A, tracks, bbox, report):
    """street-over-rail bridges on slice edges: deck, abutments, piers clear of the track bands"""
    import shapely
    ro, rx, rv, osm = A["road_off"].astype(np.int64), A["road_xyz"], A["road_vf"].astype(np.int64), A["road_osm"]
    by_way = {}
    for i in range(len(ro) - 1):
        by_way.setdefault(int(osm[i]), []).append(i)
    band = shapely.union_all([shapely.buffer(shapely.LineString(t["xyz"][:, :2]), t["hw"] + PIER_CLEAR) for t in tracks]) if tracks else None
    out = []
    for e in edges:
        rows = e.get("_rows")
        if not rows or e.get("lot") or e.get("internal"):
            continue
        pcs = [i for w in e["ways"] for i in by_way.get(int(w), [])]
        if not pcs:
            continue
        PV = np.vstack([np.column_stack([rx[ro[i]:ro[i + 1], :2], rv[ro[i]:ro[i + 1]]]) for i in pcs])
        tree = cKDTree(PV[:, :2])
        C = np.array([r["c"] for r in rows])
        d, k = tree.query(C[:, :2])
        ix_ = e["_idx"]
        reach = np.array([max(4.0, abs(float(r["U"][ix_["cwL"]])), abs(float(r["U"][ix_["cwR"]]))) for r in rows])
        br = ((PV[k, 2].astype(np.int64) & 1) != 0) & (d < reach)      # (a divided street's midline: its carriageways)
        if br.sum() < 2:
            continue
        ix = e["_idx"]
        j = 0
        while j < len(rows):
            if not br[j]:
                j += 1
                continue
            a_ = j
            while j + 1 < len(rows) and br[j + 1]:
                j += 1
            b_ = j
            j += 1
            if b_ - a_ < 1:
                continue
            R = rows[a_:b_ + 1]
            if not any(band is not None and band.intersects(shapely.LineString([r["c"][:2] for r in R])) for _ in [0]):
                continue          # a bridge over something else (a street, a creek): not this module's
            L_ = np.array([r["c"][:2] + r["n"] * r["U"][ix["walkL"]] for r in R])
            R_ = np.array([r["c"][:2] + r["n"] * r["U"][ix["walkR"]] for r in R])
            z = np.array([float(r["c"][2]) for r in R])
            deck = np.vstack([L_, R_[::-1]])
            s = np.array([float(r["s"]) for r in R])
            abut = [np.column_stack([np.vstack([L_[q], R_[q]]), [z[q], z[q]]]) for q in (0, -1)]
            # piers: candidate lines across the deck every metre, clear of the track bands
            piers, last = [], s[0]
            cand = []
            for sv in np.arange(s[0] + 3.0, s[-1] - 3.0, 1.0):
                q = int(np.clip(np.searchsorted(s, sv), 1, len(s) - 1))
                f = (sv - s[q - 1]) / max(s[q] - s[q - 1], 1e-9)
                pl, pr = L_[q - 1] * (1 - f) + L_[q] * f, R_[q - 1] * (1 - f) + R_[q] * f
                line = shapely.buffer(shapely.LineString([pl, pr]), PIER_W / 2)
                if band is None or not band.intersects(line):
                    cand.append((sv, pl, pr, z[q - 1] * (1 - f) + z[q] * f))
            while s[-1] - last > SPAN_MAX and cand:
                nxt = [c for c in cand if c[0] - last <= SPAN_MAX and c[0] > last + 4.0]
                c = max(nxt, key=lambda c: c[0]) if nxt else min((c for c in cand if c[0] > last + 4.0), key=lambda c: c[0], default=None)
                if c is None:
                    break
                sv, pl, pr, zz = c
                width = float(np.hypot(*(pr - pl)))
                ncol = max(2, int(round(width / 6.0)) + 1)
                u = (pr - pl) / max(width, 1e-9)
                v = np.array([-u[1], u[0]])
                cols = []
                for t_ in np.linspace(1.0, width - 1.0, ncol):
                    p0 = pl + u * t_
                    cols.append(np.round(np.array([p0 + (u + v) * PIER_W / 2, p0 + (-u + v) * PIER_W / 2,
                                                   p0 + (-u - v) * PIER_W / 2, p0 + (u - v) * PIER_W / 2]), 3).tolist())
                piers.append(dict(s=round(sv, 1), cols=cols, ztop=round(zz - DECK_DEPTH, 3)))
                last = sv
            spans = np.diff([s[0]] + [p["s"] for p in piers] + [s[-1]])
            out.append(dict(edge=e["id"], name=e["name"], ways=e["ways"], s0=round(s[0], 2), s1=round(s[-1], 2),
                            deck=np.round(deck, 3).tolist(), deck_z=np.round(z, 3).tolist(),
                            left=np.round(np.column_stack([L_, z]), 3).tolist(), right=np.round(np.column_stack([R_, z]), 3).tolist(),
                            abutments=[np.round(a, 3).tolist() for a in abut], seat=[round(z[0] - DECK_DEPTH, 3), round(z[-1] - DECK_DEPTH, 3)],
                            piers=piers, depth=DECK_DEPTH, parapet=PARAPET_H, max_span=round(float(spans.max()), 1) if len(spans) else 0.0))
            if len(spans) and spans.max() > SPAN_MAX + 0.5:
                report["counts"]["bridge_span_over_max"] += 1
    report["counts"]["rail_bridges"] = len(out)
    return out


def level_crossings(edges, tracks, bbox):
    p = geo.WORK / "crossings.json"
    if not p.exists():
        return []
    x0, y0, x1, y1 = bbox
    data = json.loads(p.read_text()).get("crossings", [])
    by_way = {}
    for e in edges:
        for w in e["ways"]:
            by_way[int(w)] = e
    out = []
    for c in data:
        if not (x0 <= c["e"] <= x1 and y0 <= c["n"] <= y1):
            continue
        e = next((by_way[int(w)] for w in c.get("roads", []) if int(w) in by_way), None)
        # track direction at the crossing
        best = None
        for t in tracks:
            d = np.hypot(t["xyz"][:, 0] - c["e"], t["xyz"][:, 1] - c["n"])
            k = int(d.argmin())
            if best is None or d[k] < best[0]:
                k2 = min(k + 1, len(t["xyz"]) - 1); k1 = max(k - 1, 0)
                tv = t["xyz"][k2, :2] - t["xyz"][k1, :2]
                best = (d[k], t, float(t["xyz"][k, 2]), tv / max(np.hypot(*tv), 1e-9))
        zs = None
        if e is not None and e.get("_rows"):
            C = np.array([r["c"] for r in e["_rows"]])
            zs = round(float(C[int(np.argmin(np.hypot(C[:, 0] - c["e"], C[:, 1] - c["n"]))), 2]), 3)
        out.append(dict(id=c["id"], xy=[c["e"], c["n"]], edge=e["id"] if e else None, street_ways=c.get("roads", []), z_street=zs,
                        track_ways=c.get("tracks", []), gates=bool(c.get("gates")), lights=bool(c.get("lights")),
                        kind=c.get("kind"), z_track=round(best[2], 3) if best else None,
                        track_dir=np.round(best[3], 4).tolist() if best else None,
                        approaches=c.get("approaches", [])))
    return out


def yard_crossings(edges, tracks, mapped, report, tol=0.6):
    """a service road (class >= 6) meeting a track in plan at the same level (|dz| < tol) where no
    crossing is mapped: a private yard crossing (crossing panels, no gates) -- the resolver's
    'generate' outcome, logged as inferred"""
    import shapely
    out = []
    mxy = [np.array(c["xy"]) for c in mapped]
    for e in edges:
        rows = e.get("_rows")
        if not rows or len(rows) < 2 or e.get("internal") or e["cls"] < 6:
            continue
        C = np.array([r["c"] for r in rows])
        sl = shapely.LineString(C[:, :2])
        cs = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(C[:, :2], axis=0).T))])
        for t in tracks:
            P = t["xyz"]
            tl = shapely.LineString(P[:, :2])
            ts = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(P[:, :2], axis=0).T))])
            for pt in shapely.get_parts(sl.intersection(tl)):
                if pt.geom_type != "Point":
                    continue
                q = np.array([pt.x, pt.y])
                if any(np.hypot(*(q - m)) < 15 for m in mxy + [np.array(o["xy"]) for o in out]):
                    continue
                zs = float(np.interp(sl.project(pt), cs, C[:, 2]))
                zt = float(np.interp(tl.project(pt), ts, P[:, 2]))
                if abs(zs - zt) >= tol:
                    continue
                k = int(np.clip(np.searchsorted(ts, tl.project(pt)), 1, len(P) - 1))
                tv = P[k, :2] - P[k - 1, :2]
                out.append(dict(id=f"yard_{e['id']}_{round(pt.x)}_{round(pt.y)}", xy=[round(pt.x, 2), round(pt.y, 2)], edge=e["id"],
                                street_ways=e["ways"], track_ways=t["osm"], gates=False, lights=False, kind="yard",
                                inferred=True, z_track=round(zt, 3), z_street=round(zs, 3),
                                track_dir=np.round(tv / max(np.hypot(*tv), 1e-9), 4).tolist(), approaches=[]))
    report["counts"]["yard_crossings_inferred"] = len(out)
    return out


def build(edges, A, bbox, report):
    """the slice's rail primitives (dict for primnet.json 'rail')"""
    import shapely
    import subprocess
    import sys
    from .lidar_terrain import GridTerrain
    trk = tracks_in(A, bbox)
    grid = geo.OUT / "net2" / "dtm_grid.npz"
    grid.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([sys.executable, "-m", "tpipe.lidar_terrain", "--grid=" + ",".join(str(v) for v in bbox), "--out", str(grid)],
                   check=True, capture_output=True, cwd=str(geo.PIPE))
    terrain = GridTerrain(grid)
    if not trk:
        return None
    polys, B = bed(trk, bbox)
    # obstacles for slopes: the slice's streets (walk edge to walk edge) and buildings
    blocks = []
    for e in edges:
        rows = e.get("_rows")
        if not rows or len(rows) < 2 or e.get("lot"):
            continue
        ix = e["_idx"]
        at = [r for r in rows]
        L_ = [r["c"][:2] + r["n"] * r["U"][ix["walkL"]] for r in at]
        R_ = [r["c"][:2] + r["n"] * r["U"][ix["walkR"]] for r in at]
        g = shapely.Polygon(np.vstack([L_, R_[::-1]])).buffer(0)
        if not g.is_empty:
            blocks.append(g)
    try:
        with np.load(geo.WORK / "osm_buildings.npz", allow_pickle=True) as f:
            ro = np.concatenate([[0], np.cumsum(f["ringlen"].astype(np.int64))])
            po = np.concatenate([[0], np.cumsum(f["nring"].astype(np.int64))])
            xy = f["xy"]
            first = xy[ro[po[:-1]]]
            x0, y0, x1, y1 = bbox
            near = np.nonzero((first[:, 0] > x0 - 50) & (first[:, 0] < x1 + 50) & (first[:, 1] > y0 - 50) & (first[:, 1] < y1 + 50))[0]
            for b in near:
                r0 = ro[po[b]]; r1 = ro[po[b] + 1]
                if r1 - r0 >= 4:
                    blocks.append(shapely.Polygon(xy[r0:r1]).buffer(0))
    except Exception:
        pass
    block = shapely.union_all(blocks) if blocks else None
    lx = level_crossings(edges, trk, bbox)
    lx += yard_crossings(edges, trk, lx, report)
    cxy = [np.array(c["xy"]) for c in lx]
    slopes, walls, fences, st = edges_of(polys, B["zq"], terrain, block, bbox, cxy) if polys else ([], [], [], {})
    stru = structures(edges, A, trk, bbox, report)
    report["counts"]["rail_tracks"] = len(trk)
    report["counts"]["rail_bed_m2"] = round(sum(p.area for p in polys), 1) if polys else 0
    for k, v in st.items():
        report["counts"][f"rail_edge_{k}"] = v
    report["counts"]["rail_fences_m"] = round(sum(float(np.hypot(*np.diff(np.array(f["xyz"])[:, :2], axis=0).T).sum()) for f in fences), 1)
    report["counts"]["level_crossings"] = len(lx)
    return dict(
        tracks=[dict(piece=t["piece"], cls=t["cls"], osm=t["osm"], hw=t["hw"], xyz=np.round(t["xyz"], 3).tolist(),
                     bridge=((t["vf"] & 1) != 0).astype(int).tolist()) for t in trk],
        bed=B["meshes"], slopes=slopes, walls=walls, fences=fences, structures=stru, crossings=lx,
        conv=dict(ballast_top=0.28, rail_head=0.44, gauge=1.435, ballast_top_inset=0.6))


def qa(rail, edges, interactions):
    """the four rail checks on the slice's drawn rail (counts + items):
    rail_above_bed (track formation vs the bed mesh under it, > 0.5 m), adjacent_track_z_step
    (parallel tracks within 8 m differing by > 0.3 m, bridges excluded), duplicate_track (two tracks
    within 0.5 m over >= 10 m at one level), underpass_drawn_at_grade (a street and a track crossing
    in plan within 2 m of each other in z, not a mapped level crossing)"""
    import shapely
    res = {"rail_above_bed": [], "adjacent_track_z_step": [], "duplicate_track": [], "underpass_drawn_at_grade": [],
           "mapped_crossing_not_at_grade": []}
    if not rail:
        return res
    T = [(np.array(t["xyz"]), np.array(t["bridge"], bool)) for t in rail["tracks"]]
    # bed z at points: barycentric on the bed meshes
    tri_g, tri_z = [], []
    for m in rail["bed"]:
        V, Z = np.array(m["p"]), np.array(m["z"])
        for a, b, c in m["t"]:
            tri_g.append(shapely.Polygon(V[[a, b, c]])); tri_z.append((V[[a, b, c]], Z[[a, b, c]]))
    tree = shapely.STRtree(tri_g) if tri_g else None

    def bed_z(p):
        if tree is None:
            return np.nan
        for i in tree.query(shapely.Point(p), predicate="intersects"):
            V, Z = tri_z[i]
            M = np.array([[V[1, 0] - V[0, 0], V[2, 0] - V[0, 0]], [V[1, 1] - V[0, 1], V[2, 1] - V[0, 1]]])
            try:
                u, v = np.linalg.solve(M, np.asarray(p) - V[0])
            except np.linalg.LinAlgError:
                continue
            return float(Z[0] + u * (Z[1] - Z[0]) + v * (Z[2] - Z[0]))
        return np.nan
    for P, br in T:
        for k in range(0, len(P), 3):
            if br[k]:
                continue
            bz = bed_z(P[k, :2])
            if np.isfinite(bz) and abs((P[k, 2] + 0.03) - bz) > 0.5:
                res["rail_above_bed"].append(dict(xy=np.round(P[k, :2], 1).tolist(), dz=round(float(P[k, 2] + 0.03 - bz), 2)))
    # adjacent tracks
    allp = [(i, P[k], br[k]) for i, (P, br) in enumerate(T) for k in range(len(P))]
    XY = np.array([p[1][:2] for p in allp]); Z = np.array([p[1][2] for p in allp])
    ID = np.array([p[0] for p in allp]); BR = np.array([p[2] for p in allp])
    kt = cKDTree(XY)
    for a, b in kt.query_pairs(8.0):
        if ID[a] == ID[b] or BR[a] or BR[b]:
            continue
        if abs(Z[a] - Z[b]) > 0.3:
            res["adjacent_track_z_step"].append(dict(xy=np.round((XY[a] + XY[b]) / 2, 1).tolist(), dz=round(float(Z[a] - Z[b]), 2)))
    # duplicates
    for i, (P, _) in enumerate(T):
        for j in range(i + 1, len(T)):
            Q = T[j][0]
            d, k = cKDTree(Q[:, :2]).query(P[:, :2])
            m = (d < 0.5) & (np.abs(P[:, 2] - Q[k, 2]) < 0.5)
            if m.sum() >= 2 and np.hypot(*np.diff(P[m, :2], axis=0).T).sum() >= 10.0:
                res["duplicate_track"].append(dict(xy=np.round(P[m][0, :2], 1).tolist(), tracks=[i, j]))
    for c in rail.get("crossings", []):
        if c.get("z_street") is not None and c.get("z_track") is not None and abs(c["z_street"] - c["z_track"]) > 0.5:
            res["mapped_crossing_not_at_grade"].append(dict(xy=c["xy"], dz=round(c["z_street"] - c["z_track"], 2)))
    # streets x tracks
    lx = [np.array(c["xy"]) for c in rail.get("crossings", [])]
    for e in edges:
        rows = e.get("_rows")
        if not rows or e.get("internal"):
            continue
        C = np.array([r["c"] for r in rows])
        sl = shapely.LineString(C[:, :2])
        for P, br in T:
            tl = shapely.LineString(P[:, :2])
            for pt in shapely.get_parts(sl.intersection(tl)):
                if pt.geom_type != "Point":
                    continue
                q = np.array([pt.x, pt.y])
                zs = float(np.interp(sl.project(pt), np.concatenate([[0], np.cumsum(np.hypot(*np.diff(C[:, :2], axis=0).T))]), C[:, 2]))
                zt = float(np.interp(tl.project(pt), np.concatenate([[0], np.cumsum(np.hypot(*np.diff(P[:, :2], axis=0).T))]), P[:, 2]))
                if abs(zs - zt) < 2.0 and not any(np.hypot(*(q - c)) < 15 for c in lx):
                    res["underpass_drawn_at_grade"].append(dict(xy=np.round(q, 1).tolist(), edge=e["id"], dz=round(zs - zt, 2)))
    return res
