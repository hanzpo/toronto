"""Surface transit shapes against the drawn road network.

Vehicles follow their pattern shape (docs/TRANSIT.md): a bus shape that leaves
the carriageway puts the bus on bare ground (user report: bus beside the road),
and a shape that runs against a one-way ribbon shows a bus going the wrong way.

The shapes of every agency/profile (bus, streetcar, LRT patterns; subway and
main-line rail excluded) are sampled every SAMPLE m and de-duplicated on a
DEDUPE-m grid per heading sector (many patterns share a street), then each
block tests its samples against its own ribbons.

Categories:
  transit_route_off_road   sample farther than OFF_TOL outside every carriageway
                           ribbon (classes 0-7) and, for streetcar/LRT, not on a track
  transit_wrong_way        sample inside one-way ribbons only, all running opposite
                           (divided roads: the shape sits on the opposing carriageway)
"""

from __future__ import annotations

import json
import math

import numpy as np
import shapely

from .. import geo, tbn
from .core import finding
from .data import F_ONEWAY, F_TUNNEL, Block, seg_point_dist

TRANSIT = geo.OUT / "transit"
CACHE = geo.WORK / "qa_transit_samples.npz"

# ----------------------------------------------------------------------------- thresholds
SAMPLE = 8.0  # m between shape samples
DEDUPE = 5.0  # m grid for de-duplicating overlapping shapes
SECTORS = 8  # heading sectors for de-duplication
OFF_TOL = 1.0  # m outside the ribbon edge
TRACK_TOL = 2.5  # m from a streetcar / LRT track centreline counts as on track
TUNNEL = 3.0  # m under the terrain: in a tunnel, not checked
CLUSTER = 60.0  # m grid for grouping flagged samples into one finding
MIN_OFF_LEN = 20.0  # m of off-road samples per cluster
MIN_WRONG_LEN = 15.0
WRONG_COS = -0.7  # cos(angle) below this = against the one-way direction (> ~135 deg)
JUNCTION_PAD = 3.0  # m beyond the junction box radius: turning movements there are not checked
SURFACE_MODES = {"bus": 0, "streetcar": 1, "lrt": 1}
# rail modes are sampled too (mode 2) for vehicle_path_through_building; the road checks skip them
RAIL_MODES = {"subway": 2, "commuter_rail": 2, "airport_rail": 2, "intercity_rail": 2}
ALL_MODES = SURFACE_MODES | RAIL_MODES
CACHE_VERSION = 2


def _sources() -> list:
    return sorted(TRANSIT.glob("*_*_*.bin.gz"))


def samples(rebuild: bool = False) -> dict:
    """Deduplicated shape samples: x, y, z, heading, mode (0 bus, 1 rail), label index + labels."""
    srcs = _sources()
    stamp = json.dumps([CACHE_VERSION] + [[p.name, p.stat().st_mtime_ns] for p in srcs])
    if CACHE.exists() and not rebuild:
        d = np.load(CACHE, allow_pickle=False)
        if str(d["stamp"]) == stamp:
            return {k: d[k] for k in d.files} | {"labels": json.loads(str(d["labels"]))}
    X, Y, Z, H, M, LB = [], [], [], [], [], []
    seen_keys: set = set()
    labels: list[str] = []
    lindex: dict = {}
    seen_shapes = set()
    for p in srcs:
        a, h = tbn.read(p)
        modes = h.get("modes", [])
        routes = h.get("routes", [])
        if "shape_xyz" not in a or "pat_shape" not in a:
            continue
        off = a["shape_off"].astype(np.int64)
        xyz = a["shape_xyz"].reshape(-1, 3).astype(np.float64)
        shp_label: dict[int, str] = {}
        shp_mode: dict[int, int] = {}
        for pi in range(len(a["pat_shape"])):
            m = modes[int(a["pat_mode"][pi])] if int(a["pat_mode"][pi]) < len(modes) else "bus"
            if m not in ALL_MODES:
                continue
            s = int(a["pat_shape"][pi])
            r = routes[int(a["pat_route"][pi])] if int(a["pat_route"][pi]) < len(routes) else {}
            shp_label.setdefault(s, f"{r.get('agency', '?')} {r.get('short', '?')}")
            shp_mode[s] = max(shp_mode.get(s, 0), ALL_MODES[m])
        for s, lab in sorted(shp_label.items()):
            P = xyz[off[s]:off[s + 1]]
            if len(P) < 2:
                continue
            key = hash(P.tobytes())
            if key in seen_shapes:
                continue
            seen_shapes.add(key)
            d = np.hypot(np.diff(P[:, 0]), np.diff(P[:, 1]))
            cs = np.concatenate([[0], np.cumsum(d)])
            if cs[-1] < SAMPLE:
                continue
            t = np.arange(SAMPLE / 2, cs[-1], SAMPLE)
            sx, sy = np.interp(t, cs, P[:, 0]), np.interp(t, cs, P[:, 1])
            k = np.clip(np.searchsorted(cs, t) - 1, 0, len(P) - 2)
            hh = np.arctan2(P[k + 1, 1] - P[k, 1], P[k + 1, 0] - P[k, 0])
            sec = np.floor((hh + math.pi) / (2 * math.pi) * SECTORS).astype(np.int64) % SECTORS
            keys = (np.floor(sx / DEDUPE).astype(np.int64) * 1_000_003 + np.floor(sy / DEDUPE).astype(np.int64)) * 32 + sec * 2 + shp_mode[s]
            new = np.array([kk not in seen_keys for kk in keys.tolist()], bool)
            if not new.any():
                continue
            seen_keys.update(keys[new].tolist())
            X.append(sx[new].astype(np.float32))
            Y.append(sy[new].astype(np.float32))
            Z.append(np.interp(t[new], cs, P[:, 2]).astype(np.float32))
            H.append(hh[new].astype(np.float32))
            M.append(np.full(new.sum(), shp_mode[s], np.int8))
            if lab not in lindex:
                lindex[lab] = len(labels)
                labels.append(lab)
            LB.append(np.full(new.sum(), lindex[lab], np.int32))
    if not X:
        out = {k: np.zeros(0) for k in ("x", "y", "z", "h")} | {"mode": np.zeros(0, np.int8), "label": np.zeros(0, np.int32)}
    else:
        out = {"x": np.concatenate(X), "y": np.concatenate(Y), "z": np.concatenate(Z), "h": np.concatenate(H),
               "mode": np.concatenate(M), "label": np.concatenate(LB)}
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    np.savez(CACHE, stamp=stamp, labels=json.dumps(labels), **out)
    return out | {"labels": labels}


_SAMPLES: dict | None = None


def _get() -> dict:
    global _SAMPLES
    if _SAMPLES is None:
        _SAMPLES = samples()
    return _SAMPLES


def _clusters(x, y, flag_len, key_extra=()):
    g = np.stack([np.floor(x / CLUSTER), np.floor(y / CLUSTER)], 1)
    u, inv = np.unique(g, axis=0, return_inverse=True)
    return u, inv.ravel()


def run(B: Block, cats: set) -> list[dict]:
    want = {"transit_route_off_road", "transit_wrong_way"} & cats
    if not want:
        return []
    S = _get()
    if len(S["x"]) == 0:
        return []
    m = B.in_core(S["x"], S["y"]) & (S["mode"] < 2)
    if not m.any():
        return []
    idx = np.nonzero(m)[0]
    px, py, pz, ph = (S[k][idx].astype(np.float64) for k in ("x", "y", "z", "h"))
    pm, pl = S["mode"][idx], S["label"][idx]
    tz = B.terrain(px, py)
    surf = ~(pz < tz - TUNNEL)
    labels = S["labels"]
    R = B.roads
    out: list[dict] = []
    if not R.n:
        return out
    c, f = R.attrs["class"], R.attrs["flags"]
    sp = R.seg_piece
    k = (c[sp] <= 7) & ((f[sp] & F_TUNNEL) == 0)
    seg, sp = R.seg[k], sp[k]
    x0, y0, x1, y1 = R.X[seg], R.Y[seg], R.X[seg + 1], R.Y[seg + 1]
    hw = R.attrs["w"][sp] / 2
    tree = shapely.STRtree(shapely.linestrings(np.stack([np.stack([x0, y0], 1), np.stack([x1, y1], 1)], 1)))
    pts = shapely.points(px, py)
    a, b = tree.query(pts, predicate="dwithin", distance=float(hw.max()) + OFF_TOL)
    d, _ = seg_point_dist(px[a], py[a], x0[b], y0[b], x1[b], y1[b])
    inside = d < hw[b] + OFF_TOL
    a, b, d = a[inside], b[inside], d[inside]
    on = np.zeros(len(px), bool)
    on[a] = True
    # streetcar / LRT on track
    L = B.rails
    if L.n and (pm == 1).any():
        lc, lf = L.attrs["class"], L.attrs["flags"]
        lsp = L.seg_piece
        lk = np.isin(lc[lsp], [3, 4]) & ((lf[lsp] & F_TUNNEL) == 0)
        ls = L.seg[lk]
        if len(ls):
            lt = shapely.STRtree(shapely.linestrings(np.stack([np.stack([L.X[ls], L.Y[ls]], 1), np.stack([L.X[ls + 1], L.Y[ls + 1]], 1)], 1)))
            ri = np.nonzero(pm == 1)[0]
            ta, _ = lt.query(pts[ri], predicate="dwithin", distance=TRACK_TOL)
            on[ri[ta]] = True
    # ---- off road
    if "transit_route_off_road" in cats:
        off = np.nonzero(~on & surf)[0]
        if len(off):
            dist = np.full(len(off), np.nan)
            ni = tree.query_nearest(pts[off], return_distance=False)
            if ni.size:
                qa_, qb = ni
                dd, _ = seg_point_dist(px[off[qa_]], py[off[qa_]], x0[qb], y0[qb], x1[qb], y1[qb])
                edge = dd - hw[qb]
                best = np.full(len(off), np.inf)
                np.minimum.at(best, qa_, edge)
                dist = best
            u, inv = _clusters(px[off], py[off], None)
            for g in range(len(u)):
                mm = np.nonzero(inv == g)[0]
                ln = len(mm) * SAMPLE
                if ln < MIN_OFF_LEN:
                    continue
                q = mm[np.argmax(np.nan_to_num(dist[mm], posinf=99))]
                i = off[q]
                labs = sorted({labels[j] for j in pl[off[mm]]})
                mx = float(np.nan_to_num(dist[q], posinf=99.0))
                out.append(finding("transit_route_off_road", "streetcar" if pm[i] == 1 else "bus", ln / 10 * (1 + min(mx, 20) / 5),
                                   px[i], py[i], tz[i], [],
                                   f"{', '.join(labs[:4])}{' +' + str(len(labs) - 4) if len(labs) > 4 else ''}: {ln:.0f} m of shape off the "
                                   f"carriageway, up to {mx:.1f} m outside the nearest ribbon edge",
                                   key=("transit_route_off_road", int(u[g, 0]), int(u[g, 1])), bearing=float(ph[i])))
    # ---- wrong way
    if "transit_wrong_way" in cats and len(a):
        sdir = np.arctan2(y1[b] - y0[b], x1[b] - x0[b])
        ow = (f[sp[b]] & F_ONEWAY) != 0
        good = ~ow | (np.cos(ph[a] - sdir) >= WRONG_COS)
        ok = np.zeros(len(px), bool)
        ok[a[good]] = True
        wrong = np.zeros(len(px), bool)
        wrong[a[~good]] = True
        wrong &= ~ok & surf
        J = B.junc
        if len(J["x"]):
            from scipy.spatial import cKDTree

            jt = cKDTree(np.column_stack([J["x"], J["y"]]))
            rmax = float(J["r"].max()) + JUNCTION_PAD
            for q, lst in zip(np.nonzero(wrong)[0], jt.query_ball_point(np.column_stack([px[wrong], py[wrong]]), rmax)):
                if lst and np.any(np.hypot(J["x"][lst] - px[q], J["y"][lst] - py[q]) < J["r"][lst] + JUNCTION_PAD):
                    wrong[q] = False
        w = np.nonzero(wrong)[0]
        if len(w):
            # road name per wrong sample (first matching one-way segment)
            seg_of = np.full(len(px), -1)
            seg_of[a[~good]] = b[~good]
            u, inv = _clusters(px[w], py[w], None)
            for g in range(len(u)):
                mm = np.nonzero(inv == g)[0]
                ln = len(mm) * SAMPLE
                if ln < MIN_WRONG_LEN:
                    continue
                i = w[mm[len(mm) // 2]]
                s = seg_of[i]
                pce = int(sp[s])
                ni_ = int(R.attrs["name"][pce])
                names = B.data[R.tile[pce]].get("_names", [])
                rn = names[ni_] if 0 <= ni_ < len(names) else f"way {int(R.attrs['osm'][pce])}"
                labs = sorted({labels[j] for j in pl[w[mm]]})
                out.append(finding("transit_wrong_way", "streetcar" if pm[i] == 1 else "bus", ln / 10, px[i], py[i], tz[i],
                                   [R.attrs["osm"][pce]],
                                   f"{', '.join(labs[:4])}: {ln:.0f} m against one-way {rn}"
                                   f"{' (opposing carriageway of a divided road?)' if c[pce] <= 3 else ''}",
                                   key=("transit_wrong_way", int(u[g, 0]), int(u[g, 1])), bearing=float(ph[i])))
    return out


TRANSIT_CATS = {"transit_route_off_road", "transit_wrong_way"}
