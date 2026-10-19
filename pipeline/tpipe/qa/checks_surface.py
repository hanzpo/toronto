"""Unified-surface checks (docs/SURFACE.md), run on level-0 tiles that carry sf_* arrays.

  surface_gap           the top surface does not cover the tile: an interior edge used by a
                        single triangle (crack / T-junction), or plan area short of 1024² m²
  surface_overlap       two top triangles over the same ground: an edge used by more than two
                        triangles, two triangles on the same side of a shared edge (fold), or
                        plan area above 1024² m²
  terrain_above_paving  the terrain-snapping invariant (NETWORK.md): inside the footprint of every
                        at-grade road / track of the network model -- sampled every 2 m at the
                        centreline and 5 cm inside both pavement / bed edges -- the surface must be
                        a paved / bed class (no ground triangle inside a footprint, so no terrain
                        above the paving anywhere); must be 0
  rail_above_bed        (with a net2 rail corridor, docs/SPEC.md) at the slice's track centrelines
                        (not on bridges) the surface is more than 0.5 m off the shared bed
                        (formation + 0.03); a surface above the bed + 0.05 there also counts as
                        terrain_above_paving
  surface_off_model     the paving there is more than 0.25 m off the model's z (roads: crossfall
                        allowed; track: bed profile allowed)

Standalone: uv run python -m tpipe.qa.checks_surface --data <data root> [--tiles TX,TY ...]
"""
from __future__ import annotations

import math

import numpy as np

from .. import geo, tbn
from .core import finding

S0 = float(geo.TILE_SIZE[0])
SURF_CATS = {"surface_gap", "surface_overlap", "terrain_above_paving", "surface_off_model"}
WALLS = {30, 33, 34, 80}
PAVED_MIN = 64
V_BRIDGE, V_TUNNEL = 1, 2


def _unvarint(b):
    b = np.asarray(b, np.uint64)
    end = (b & 0x80) == 0
    grp = np.concatenate([[0], np.cumsum(end)[:-1]])
    first = np.r_[0, np.nonzero(end)[0][:-1] + 1]
    pos = np.arange(len(b)) - first[grp]
    return np.bincount(grp, weights=((b & 0x7F) << (7 * pos.astype(np.uint64))).astype(np.float64)).astype(np.int64)


def decode(a: dict):
    """sf_* v3 -> (positions xy (n,2) tile-local, z (n,), class per triangle (m,), triangles (m,3)).
    Faces are triangulated with earcut like the client (walls as quads)."""
    d = _unvarint(a["sf_pos"])
    d = np.where(d % 2 == 0, d // 2, -(d + 1) // 2).reshape(2, -1)
    q = np.cumsum(d, axis=1)
    xy = np.column_stack([q[0], q[1]]) / 32.0
    zz = _unvarint(a["sf_pz"])
    z = np.cumsum(np.where(zz % 2 == 0, zz // 2, -(zz + 1) // 2)) / 100.0 + float(a["sf_z0"][0])
    code = _unvarint(a["sf_idx"])
    corner = np.empty(len(code), np.int64)
    hw = 0
    for k, c in enumerate(code.tolist()):
        i = hw - c
        corner[k] = i
        if i == hw:
            hw += 1
    R = a["sf_run"].astype(np.int64).reshape(-1, 2)
    tris, tcls = [], []
    li, ci, ti = 0, 0, 0
    ln = _unvarint(a["sf_ln"])
    tl = _unvarint(a["sf_tl"]) if len(a["sf_tl"]) else np.zeros(0, np.int64)
    from ..surface import earcut_full
    nts = iter(a["sf_nt"].tolist())
    for run, nl, fk in zip(_unvarint(a["sf_face"]).tolist(), a["sf_nl"].tolist(), a["sf_fk"].tolist()):
        sizes = ln[li:li + nl]
        idx = corner[ci:ci + int(sizes.sum())]
        li += nl
        ci += int(sizes.sum())
        if fk == 2:
            nt = next(nts)
            loc = tl[ti:ti + 3 * nt].reshape(-1, 3)
            ti += 3 * nt
            for t in loc:
                tris.append([idx[t[0]], idx[t[1]], idx[t[2]]])
                tcls.append(R[run, 0])
        elif fk == 1:
            loc = earcut_full(xy[idx], sizes.tolist())
            if loc is None:
                continue  # shows up as a gap
            for t in loc:
                tris.append([idx[t[0]], idx[t[1]], idx[t[2]]])
                tcls.append(R[run, 0])
        else:  # fan over the loop (convex faces, wall quads)
            for j in range(1, len(idx) - 1):
                tris.append([idx[0], idx[j], idx[j + 1]])
                tcls.append(R[run, 0])
    return xy, z, np.array(tcls, np.int64), np.array(tris, np.int64).reshape(-1, 3)


def mesh_checks(tx: int, ty: int, a: dict):
    """(gap edges, overlap edges, folds, plan area, top triangles) of one tile."""
    xy, z, cls, tri = decode(a)
    top = ~np.isin(cls, list(WALLS))
    T = tri[top]
    p = xy[T]
    cross = (p[:, 1, 0] - p[:, 0, 0]) * (p[:, 2, 1] - p[:, 0, 1]) - (p[:, 2, 0] - p[:, 0, 0]) * (p[:, 1, 1] - p[:, 0, 1])
    area = float(0.5 * np.abs(cross).sum())
    # vertices are split per class / owner: weld by position for the topology check
    key = np.round(xy * 1000).astype(np.int64)
    _, pid = np.unique(key[:, 0] * 2_000_000 + key[:, 1], return_inverse=True)
    P = pid[T]
    e = np.concatenate([P[:, [0, 1]], P[:, [1, 2]], P[:, [2, 0]]])
    sgn = np.where(e[:, 0] < e[:, 1], 1, -1)
    lo, hi = np.minimum(e[:, 0], e[:, 1]), np.maximum(e[:, 0], e[:, 1])
    ek = lo * (P.max() + 1) + hi
    order = np.argsort(ek)
    ek, sgn = ek[order], sgn[order]
    uk, start, cnt = np.unique(ek, return_index=True, return_counts=True)
    ssum = np.add.reduceat(sgn, start)
    # border edges (both ends on the same tile edge) are legitimately single
    first = np.zeros(pid.max() + 1, np.int64)
    first[pid] = np.arange(len(pid))
    a_ = first[uk // (P.max() + 1)]
    b_ = first[uk % (P.max() + 1)]
    pa, pb = xy[a_], xy[b_]
    border = ((np.abs(pa[:, 0] - pb[:, 0]) < 1e-3) & ((np.abs(pa[:, 0]) < 0.02) | (np.abs(pa[:, 0] - S0) < 0.02))) | \
             ((np.abs(pa[:, 1] - pb[:, 1]) < 1e-3) & ((np.abs(pa[:, 1]) < 0.02) | (np.abs(pa[:, 1] - S0) < 0.02)))
    gap = (cnt == 1) & ~border
    over = cnt > 2
    fold = (cnt == 2) & (ssum != 0)
    mid = (pa + pb) / 2 + [tx * S0, ty * S0]
    return dict(gap=mid[gap], over=mid[over | fold], area=area, ntop=int(top.sum()), xy=xy, z=z, cls=cls[top], T=T)


def _locate(M, pts):
    """surface z and class at tile-local points (top triangles), NaN / 255 outside."""
    xy, z, cls, T = M["xy"], M["z"], M["cls"], M["T"]
    B = 64
    cs = S0 / B
    tmin = np.floor(xy[T].min(axis=1) / cs).astype(int).clip(0, B - 1)
    tmax = np.floor(xy[T].max(axis=1) / cs).astype(int).clip(0, B - 1)
    buckets: dict = {}
    for t in range(len(T)):
        for i in range(tmin[t, 0], tmax[t, 0] + 1):
            for j in range(tmin[t, 1], tmax[t, 1] + 1):
                buckets.setdefault((i, j), []).append(t)
    zs = np.full(len(pts), np.nan)
    cl = np.full(len(pts), 255)
    for k, (x, y) in enumerate(pts):
        for t in buckets.get((min(B - 1, int(x / cs)), min(B - 1, int(y / cs))), ()):
            a, b, c = T[t]
            ax, ay = xy[a]
            bx, by = xy[b]
            cx, cy = xy[c]
            d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
            if abs(d) < 1e-12:
                continue
            l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d
            l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d
            l3 = 1 - l1 - l2
            if min(l1, l2, l3) < -1e-6:
                continue
            zs[k] = l1 * z[a] + l2 * z[b] + l3 * z[c]
            cl[k] = cls[t]
            break
    return zs, cl


def load_ctx(root):
    """the slice's rail corridor and decks (net2/surface.npz + bbox.json under the data root), or None"""
    import json
    from pathlib import Path
    p, b = Path(root) / "net2" / "surface.npz", Path(root) / "net2" / "bbox.json"
    if not p.exists() or not b.exists():
        return None
    d = np.load(p)
    bb = json.loads(b.read_text())
    if not bb.get("rail") or "rt_off" not in d.files:
        return None
    import shapely
    decks = []
    if "st_off" in d.files:
        o = d["st_off"]
        decks = [shapely.make_valid(shapely.Polygon(d["st_xy"][o[i]:o[i + 1]])) for i in range(len(o) - 1) if o[i + 1] - o[i] >= 3]
    return dict(bbox=bb["bbox"], rt_off=d["rt_off"], rt_xyz=d["rt_xyz"], rt_bridge=d["rt_bridge"],
                decks=shapely.union_all(decks) if decks else None)


def rail_checks(tx: int, ty: int, M, ctx, step: float = 2.0):
    """slice tracks: (bad list as paving_checks, samples, rail_above_bed count)"""
    bad, n, rab = [], 0, 0
    if ctx is None:
        return bad, n, rab
    x0w, y0w = tx * S0, ty * S0
    o, P, br = ctx["rt_off"], ctx["rt_xyz"], ctx["rt_bridge"]
    C, zm = [], []
    for i in range(len(o) - 1):
        for v in range(o[i], o[i + 1] - 1):
            if br[v] or br[v + 1]:
                continue
            L = float(np.hypot(*(P[v + 1, :2] - P[v, :2])))
            m = max(1, int(math.ceil(L / step)))
            for t in (np.arange(m) + 0.5) / m:
                q_ = P[v] + (P[v + 1] - P[v]) * t
                lx, ly = q_[0] - x0w, q_[1] - y0w
                if 0.5 < lx < S0 - 0.5 and 0.5 < ly < S0 - 0.5:
                    C.append((lx, ly))
                    zm.append(q_[2] + 0.03)
    if not C:
        return bad, n, rab
    C, zm = np.array(C), np.array(zm)
    zs, cl = _locate(M, C)
    n = len(C)
    soft = ((cl < PAVED_MIN) & (cl != 35)) | np.isnan(zs) | (zs > zm + 0.05)
    for k in np.nonzero(soft)[0]:
        bad.append((C[k, 0] + x0w, C[k, 1] + y0w, zm[k], zs[k], int(cl[k]), "l", True))
    rab = int((np.abs(zs - zm) > 0.5).sum())
    return bad, n, rab


def paving_checks(tx: int, ty: int, a: dict, M, step: float = 2.0, ctx=None):
    """The terrain-snapping invariant and the model-z check.
    Footprints: surface.model_footprint_quads (the model's at-grade road footprint, the same
    function the builder puts into the arrangement) inset 5 cm, sampled on a 2 m grid (+ each
    quad's representative point); every sample must be a paved / bed class. Tracks: centreline
    samples must be bed / paved. z: road centreline samples within 0.25 m of the model.
    Returns (bad (x, y, z_model, z_surface, class, kind, is_invariant), samples)."""
    import shapely
    from ..surface import piece_footprint_quads, tile_feature_keys
    bad, n = [], 0
    keys = tile_feature_keys(a)
    x0w, y0w = tx * S0, ty * S0
    if "r_off" in a and "r_pl" in a:
        off, xyz, vf = a["r_off"], a["r_xyz"].reshape(-1, 3).astype(np.float64), a["r_vf"]
        cls, flags = a["r_class"], a.get("r_flags")
        pts = []
        cpts, czm = [], []
        for i in range(len(off) - 1):
            if cls[i] > 7 or (flags is not None and flags[i] & (32 | 64)) or off[i + 1] - off[i] < 2:
                continue
            for q in piece_footprint_quads(a, tx, ty, i, keys):
                qi = shapely.buffer(q, -0.05, join_style="mitre")
                if qi.is_empty:
                    continue
                bx0, by0, bx1, by1 = qi.bounds
                gx, gy = np.meshgrid(np.arange(bx0 + step / 2, bx1, step), np.arange(by0 + step / 2, by1, step))
                c = np.column_stack([gx.ravel(), gy.ravel()])
                c = c[shapely.contains_xy(qi, c[:, 0], c[:, 1])] if len(c) else c
                rp = shapely.point_on_surface(qi)
                edge = np.vstack([np.asarray(shapely.segmentize(r, 1.0).coords) for r in shapely.get_parts(shapely.boundary(qi))])
                c = np.vstack([c.reshape(-1, 2), [[rp.x, rp.y]], edge])  # interior grid + 5 cm inside every edge
                pts.append(c)
            for v in range(off[i], off[i + 1] - 1):
                if (vf[v] | vf[v + 1]) & (V_BRIDGE | V_TUNNEL):
                    continue
                L = float(np.hypot(*(xyz[v + 1, :2] - xyz[v, :2])))
                m = max(1, int(math.ceil(L / step)))
                for t in (np.arange(m) + 0.5) / m:
                    q_ = xyz[v] + (xyz[v + 1] - xyz[v]) * t
                    cpts.append(q_[:2])
                    czm.append(q_[2])
        if pts:
            W = np.vstack(pts) - [x0w, y0w]
            W = W[(W[:, 0] > 0.05) & (W[:, 0] < S0 - 0.05) & (W[:, 1] > 0.05) & (W[:, 1] < S0 - 0.05)]
            if ctx is not None and ctx["decks"] is not None:  # under a deck the surface is the ground below
                W = W[~shapely.contains_xy(ctx["decks"], W[:, 0] + x0w, W[:, 1] + y0w)]
            zs, cl = _locate(M, W)
            n += len(W)
            soft = ((cl < PAVED_MIN) & (cl != 35)) | np.isnan(zs)
            for k in np.nonzero(soft)[0]:
                bad.append((W[k, 0] + x0w, W[k, 1] + y0w, float("nan"), zs[k], int(cl[k]), "r", True))
        if cpts:
            C = np.array(cpts)
            zm = np.array(czm)
            ok = (C[:, 0] > 0.5) & (C[:, 0] < S0 - 0.5) & (C[:, 1] > 0.5) & (C[:, 1] < S0 - 0.5)
            C, zm = C[ok], zm[ok]
            zs, cl = _locate(M, C)
            for k in np.nonzero(np.abs(zs - zm) > 0.25)[0]:
                bad.append((C[k, 0] + x0w, C[k, 1] + y0w, zm[k], zs[k], int(cl[k]), "r", False))
    # track: centreline samples on a bed / paved class
    if "l_off" in a and "l_vf" in a:
        off, xyz, vf, cls = a["l_off"], a["l_xyz"].reshape(-1, 3), a["l_vf"], a["l_class"]
        C, zm = [], []
        for i in range(len(off) - 1):
            if cls[i] == 4:
                continue
            for v in range(off[i], off[i + 1] - 1):
                if (vf[v] | vf[v + 1]) & (V_BRIDGE | V_TUNNEL):
                    continue
                L = float(np.hypot(*(xyz[v + 1, :2] - xyz[v, :2])))
                m = max(1, int(math.ceil(L / step)))
                for t in (np.arange(m) + 0.5) / m:
                    q_ = xyz[v] + (xyz[v + 1] - xyz[v]) * t
                    if ctx is not None and cls[i] <= 1:
                        bx = ctx["bbox"]
                        if bx[0] < q_[0] + x0w < bx[2] and bx[1] < q_[1] + y0w < bx[3]:
                            continue  # the slice's tracks replace these (rail_checks)
                    if 0.5 < q_[0] < S0 - 0.5 and 0.5 < q_[1] < S0 - 0.5:
                        C.append(q_[:2])
                        zm.append(q_[2])
        if C:
            C, zm = np.array(C), np.array(zm)
            zs, cl = _locate(M, C)
            n += len(C)
            soft = ((cl < PAVED_MIN) & (cl != 35)) | np.isnan(zs)
            for k in np.nonzero(soft)[0]:
                bad.append((C[k, 0] + x0w, C[k, 1] + y0w, zm[k], zs[k], int(cl[k]), "l", True))
            for k in np.nonzero(~soft & (np.abs(zs - zm - 0.15) > 0.35))[0]:
                bad.append((C[k, 0] + x0w, C[k, 1] + y0w, zm[k], zs[k], int(cl[k]), "l", False))
    return bad, n


def run(B, cats: set) -> list[dict]:
    cats = cats & SURF_CATS
    out = []
    if not cats:
        return out
    x0, y0, x1, y1 = B.core
    for (tx, ty), a in zip(B.tiles, B.data):
        if "sf_face" not in a or not (x0 <= tx * S0 < x1 and y0 <= ty * S0 < y1):
            continue
        M = mesh_checks(tx, ty, a)
        if "surface_gap" in cats:
            for x, y in M["gap"]:
                out.append(finding("surface_gap", "open_edge", 3, x, y, None, [], f"surface crack (open edge) in tile {tx},{ty}"))
            if M["area"] < S0 * S0 - 1:
                out.append(finding("surface_gap", "area", 3, (tx + 0.5) * S0, (ty + 0.5) * S0, None, [],
                                   f"tile {tx},{ty} surface covers {M['area']:.0f} m² of {S0 * S0:.0f}"))
        if "surface_overlap" in cats:
            for x, y in M["over"]:
                out.append(finding("surface_overlap", "edge", 3, x, y, None, [], f"overlapping / folded surface in tile {tx},{ty}"))
            if M["area"] > S0 * S0 + 1:
                out.append(finding("surface_overlap", "area", 3, (tx + 0.5) * S0, (ty + 0.5) * S0, None, [],
                                   f"tile {tx},{ty} surface covers {M['area']:.0f} m² of {S0 * S0:.0f}"))
        if cats & {"terrain_above_paving", "surface_off_model"}:
            bad, _ = paving_checks(tx, ty, a, M)
            for x, y, zm, zs, cl, pre, ground in bad:
                what = "carriageway" if pre == "r" else "track"
                cat = "terrain_above_paving" if ground else "surface_off_model"
                if cat not in cats:
                    continue
                out.append(finding(cat, pre, 2, x, y, zm, [], f"model {what} at z {zm:.2f}: surface class {cl} at {zs:.2f}",
                                   key=(cat, round(x / 10), round(y / 10))))
    return out


def main():
    import argparse
    import json
    from pathlib import Path

    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--tiles", action="append", default=[])
    ap.add_argument("--show", type=int, default=0, help="print the first N failing samples per tile")
    args = ap.parse_args()
    root = Path(args.data) / "tiles" / "0"
    keys = [tuple(map(int, t.split(","))) for t in args.tiles] or \
        [tuple(map(int, p.name[:-7].split("_"))) for p in root.glob("*.bin.gz") if not p.is_symlink()]
    tot = dict(tiles=0, gap=0, overlap=0, samples=0, terrain_above_paving=0, off_model=0, rail_above_bed=0, rail_samples=0)
    ctx = load_ctx(args.data)
    for tx, ty in sorted(keys):
        a, _ = tbn.read(root / f"{tx}_{ty}.bin.gz")
        if "sf_face" not in a:
            continue
        a = {k: np.array(v) for k, v in a.items()}
        M = mesh_checks(tx, ty, a)
        bad, n = paving_checks(tx, ty, a, M, ctx=ctx)
        rb, rn, rab = rail_checks(tx, ty, M, ctx)
        bad += rb
        n += rn
        bc = sum(1 for b in bad if b[6])
        for b in bad[:args.show]:
            print("   ", tuple(round(v, 2) if isinstance(v, float) else v for v in b))
        row = dict(gap=len(M["gap"]) + (M["area"] < S0 * S0 - 1), overlap=len(M["over"]) + (M["area"] > S0 * S0 + 1),
                   area=round(M["area"], 1), samples=n, terrain_above_paving=bc, off_model=len(bad) - bc, rail_above_bed=rab, rail_samples=rn)
        print(f"{tx},{ty}: {json.dumps(row)}")
        tot["tiles"] += 1
        for k in ("gap", "overlap", "samples", "terrain_above_paving", "off_model", "rail_above_bed", "rail_samples"):
            tot[k] += row[k]
    print("total", json.dumps(tot))


if __name__ == "__main__":
    main()
