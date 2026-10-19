"""model_vs_dtm: the network model's at-grade road and rail z against the HRDEM 1 m lidar DTM.

  model_vs_dtm   a run of at-grade model vertices (work/roadnet.npz; bridges and tunnels excluded)
                 whose z is more than TOL (1.0 m) off the bare-earth DTM. Roads (class <= 6) compare
                 their surface z; ballasted heavy rail compares its drawn ballast top (formation z +
                 0.28 m, the client's track drawing); embedded track compares z. Only where the DTM
                 is lidar (tpipe.lidar_terrain source 1); elsewhere the vertex is counted as
                 'no_lidar' and not judged. Not judged either (counted): 'covered' -- the 1 m DSM
                 more than COVER (3 m) above the DTM at the vertex (a deck, roof or canopy overhead:
                 the DTM there is interpolated, not measured ground) -- and 'dtm_void' -- a DTM
                 below VOID (-1 m datum, under the lake surface: no-return areas the DTM filled),
                 or, for track, more than 2 m below the DTM median around it (50 m). Vertices under
                 a model bridge deck (plan within its half width + 1 m, deck >= 3 m above) count as
                 covered too.

Per level-0 tile: n, median dz and p95 |dz| (roads and rail separately) ->
OUT/qa/model_vs_dtm.json. This is the gate for rolling the lidar vertical solve out region-wide.

    uv run python -m tpipe.qa.checks_dtm [--bbox E0,N0,E1,N1]
"""
from __future__ import annotations

import argparse
import json
import math

import numpy as np

from .. import geo
from .core import finding

DTM_CATS = {"model_vs_dtm"}
TOL = 1.0
COVER = 3.0
VOID = -1.0
LOCAL_VOID = 2.0


def _under_decks(A, bbox):
    """(n, 3) points -> mask of points under a model bridge deck (plan within the deck's half
    width + 1 m, deck >= 3 m above the point): the DTM there is the deck or an interpolation"""
    import shapely
    segs, zs = [], []
    for pre in ("road", "rail"):
        off = A[f"{pre}_off"].astype(np.int64)
        xyz, vf = A[f"{pre}_xyz"], A[f"{pre}_vf"].astype(np.int64)
        hw = np.maximum(A["road_pl"], A["road_pr"]) if pre == "road" else np.full(len(xyz), 2.5)
        for i in range(len(off) - 1):
            a, b = off[i], off[i + 1]
            br = (vf[a:b] & V_BRIDGE) != 0
            if not br.any():
                continue
            P = xyz[a:b]
            if bbox and not ((P[:, 0] > bbox[0] - 50) & (P[:, 0] < bbox[2] + 50) & (P[:, 1] > bbox[1] - 50) & (P[:, 1] < bbox[3] + 50)).any():
                continue
            for k in np.nonzero(br[:-1] | br[1:])[0]:
                segs.append(shapely.buffer(shapely.linestrings(P[k:k + 2, :2]), float(hw[a + k]) + 1.0))
                zs.append(min(P[k, 2], P[k + 1, 2]))
    if not segs:
        return lambda P: np.zeros(len(P), bool)
    tree = shapely.STRtree(segs)
    zs = np.array(zs)

    def f(P):
        out = np.zeros(len(P), bool)
        pi, si = tree.query(shapely.points(P[:, :2]), predicate="intersects")
        hit = zs[si] >= P[pi, 2] + 3.0
        out[pi[hit]] = True
        return out
    return f
BALLAST_TOP = 0.28
V_BRIDGE, V_TUNNEL, V_EMBED = 1, 2, 8


def _pieces(A, pre, max_cls):
    off = A[f"{pre}_off"].astype(np.int64)
    xyz, vf, cls = A[f"{pre}_xyz"], A[f"{pre}_vf"], A[f"{pre}_cls"]
    osm = A.get(f"{pre}_osm")
    for i in range(len(off) - 1):
        if cls[i] > max_cls:
            continue
        a, b = off[i], off[i + 1]
        yield i, xyz[a:b], vf[a:b].astype(np.int64), (osm[i] if osm is not None and pre == "road" else 0)


def stats(bbox=None):
    """per-vertex dz arrays and per-tile summary"""
    from ..lidar_terrain import SRC_HRDEM, get
    with np.load(geo.WORK / "roadnet.npz", allow_pickle=True) as d:
        A = {k: d[k] for k in ("road_off", "road_xyz", "road_vf", "road_cls", "road_osm", "road_pl", "road_pr",
                               "rail_off", "rail_xyz", "rail_vf", "rail_cls")}
    under = _under_decks(A, bbox)
    T = get()
    rows = {}
    for kind, pre, mc in (("road", "road", 6), ("rail", "rail", 4)):
        P, V, piece, osm = [], [], [], []
        for i, xyz, vf, o in _pieces(A, pre, mc):
            m = (vf & (V_BRIDGE | V_TUNNEL)) == 0
            if bbox:
                m &= (xyz[:, 0] >= bbox[0]) & (xyz[:, 0] < bbox[2]) & (xyz[:, 1] >= bbox[1]) & (xyz[:, 1] < bbox[3])
            if not m.any():
                continue
            P.append(xyz[m]); V.append(vf[m]); piece.append(np.full(int(m.sum()), i)); osm.append(np.full(int(m.sum()), o))
        if not P:
            rows[kind] = None
            continue
        P, V, piece, osm = np.vstack(P), np.concatenate(V), np.concatenate(piece), np.concatenate(osm)
        h, src = T.sample_src(P[:, 0], P[:, 1])
        z = P[:, 2] + (np.where((V & V_EMBED) != 0, 0.0, BALLAST_TOP) if kind == "rail" else 0.0)
        lid = src == SRC_HRDEM
        cov = np.zeros(len(P), bool)
        if lid.any():
            cov[lid] = (T.dsm(P[lid, 0], P[lid, 1]) - h[lid]) > COVER
        void = lid & (h < VOID)
        if kind == "rail" and lid.sum() > 10:
            # a no-return patch the DTM filled: far below the ground around the same tracks
            from scipy.spatial import cKDTree
            ix = np.nonzero(lid)[0]
            tr = cKDTree(P[ix, :2])
            loc = np.array([np.median(h[ix[q]]) for q in tr.query_ball_point(P[ix, :2], 50.0)])
            void[ix] |= h[ix] < loc - LOCAL_VOID
            cov[ix] |= h[ix] > loc + COVER          # a deck over the track classified as ground
        cov |= under(P)
        judged = lid & ~cov & ~void
        dz = np.where(judged, z - h, np.nan)
        rows[kind] = dict(P=P, dz=dz, piece=piece, osm=osm, why=np.where(~lid, 1, np.where(cov, 2, np.where(void, 3, 0))))
    S = geo.TILE_SIZE[0]
    tiles = {}
    for kind, r in rows.items():
        if r is None:
            continue
        tk = np.floor(r["P"][:, 0] / S).astype(int), np.floor(r["P"][:, 1] / S).astype(int)
        for t in set(zip(*tk)):
            m = (tk[0] == t[0]) & (tk[1] == t[1])
            d = r["dz"][m]
            ok = np.isfinite(d)
            e = tiles.setdefault(f"{t[0]}_{t[1]}", {})
            w = r["why"][m]
            e[kind] = dict(n=int(ok.sum()), no_lidar=int((w == 1).sum()), covered=int((w == 2).sum()), dtm_void=int((w == 3).sum()),
                           median=round(float(np.median(d[ok])), 2) if ok.any() else None,
                           p95_abs=round(float(np.percentile(np.abs(d[ok]), 95)), 2) if ok.any() else None,
                           over_tol=int((np.abs(d[ok]) > TOL).sum()))
    return rows, tiles


def run_global(cats, bbox):
    if not (cats & DTM_CATS):
        return []
    rows, tiles = stats(bbox)
    out = []
    for kind, r in rows.items():
        if r is None:
            continue
        bad = np.isfinite(r["dz"]) & (np.abs(r["dz"]) > TOL)
        idx = np.nonzero(bad)[0]
        i = 0
        while i < len(idx):
            j = i
            while j + 1 < len(idx) and idx[j + 1] == idx[j] + 1 and r["piece"][idx[j + 1]] == r["piece"][idx[i]]:
                j += 1
            run = idx[i:j + 1]
            k = run[np.argmax(np.abs(r["dz"][run]))]
            x, y, z = r["P"][k]
            dz = float(r["dz"][k])
            out.append(finding("model_vs_dtm", f"{kind}_{'above' if dz > 0 else 'below'}", 1 + min(abs(dz), 8), x, y, z,
                               [r["osm"][k]], f"model {kind} z {dz:+.1f} m off the lidar DTM over {len(run)} vertices",
                               key=("model_vs_dtm", kind, int(r["piece"][k]), round(x / 50), round(y / 50))))
            i = j + 1
    p = geo.OUT / "qa"
    p.mkdir(parents=True, exist_ok=True)
    (p / "model_vs_dtm.json").write_text(json.dumps(dict(tol=TOL, bbox=bbox, tiles=tiles,
                                                     findings=[{k: v for k, v in f.items() if not k.startswith("_")} for f in out]),
                                                indent=1, default=float))
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="tpipe.qa.checks_dtm", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bbox", default="")
    a = ap.parse_args(argv)
    bbox = tuple(float(v) for v in a.bbox.split(",")) if a.bbox else None
    f = run_global(DTM_CATS, bbox)
    tiles = json.loads((geo.OUT / "qa" / "model_vs_dtm.json").read_text())["tiles"]
    print(f"model_vs_dtm: {len(f)} findings (> {TOL} m)")
    for t, v in sorted(tiles.items(), key=lambda kv: tuple(map(int, kv[0].split("_")))):
        print(t, " ".join(f"{k}: n={s['n']} med={s['median']} p95={s['p95_abs']} >tol={s['over_tol']}"
                          for k, s in v.items() if s["n"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
