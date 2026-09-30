"""Station clearances against the rail graph (data/stations.json vs data/rail/network.bin.gz).

  platform_track_clearance   (curated input: StationsLayer snaps platforms onto the tracks
                             at runtime, so this flags platforms the snap has to fix or
                             that it can't -- unmatched ones are drawn as curated)
                             for every platform rectangle (centre, compass bearing,
                             length, width): a track centreline running *through* the
                             platform, or the platform edge facing a parallel track
                             closer than EDGE_MIN (the train clips the platform) or
                             farther than EDGE_MAX (a visible gap) from its centreline.
                             Tracks of the platform's mode only (GO/UP/VIA main line,
                             subway, LRT/tram), parallel within PAR_DEG.
  station_column_clearance   canopy / structure columns closer than COLUMN_MIN to a
                             track centreline. Uses `columns` / `cols` ([[E, N], ...])
                             on stations.json levels or `blds` entries when exported;
                             skipped (0) until then.
"""

from __future__ import annotations

import math

import numpy as np
import shapely

from .. import geo, tbn
from .core import finding
from .data import platform_polys, stations

NETWORK = geo.OUT / "rail" / "network.bin.gz"

EDGE_MIN = 1.55  # m, platform edge to track centreline
EDGE_MAX = 1.75
EDGE_SEARCH = 3.5  # m: a track farther than this from an edge doesn't serve it
PAR_DEG = 20.0
EDGE_STEP = 5.0  # m sampling along the edge (central EDGE_SPAN of the length)
EDGE_SPAN = 0.8
THROUGH_SHRINK = 0.2  # m: centreline inside the platform shrunk by this = runs through it
COLUMN_MIN = 2.2  # m
MODE_KINDS = {"commuter_rail": {0}, "airport_rail": {0}, "intercity_rail": {0}, "subway": {1}, "lrt": {2, 3}, "streetcar": {3}}

STATION_CATS = {"platform_track_clearance", "station_column_clearance"}


def _tracks():
    if not NETWORK.exists():
        return None
    a, _ = tbn.read(NETWORK)
    off = a["e_off"].astype(np.int64)
    xyz = a["e_xyz"].reshape(-1, 3).astype(np.float64)
    last = np.zeros(len(xyz), bool)
    last[off[1:] - 1] = True
    s = np.nonzero(~last)[0]
    s = s[s < len(xyz) - 1]
    e = np.repeat(np.arange(len(off) - 1), np.diff(off))[s]
    return {"x0": xyz[s, 0], "y0": xyz[s, 1], "x1": xyz[s + 1, 0], "y1": xyz[s + 1, 1], "z": xyz[s, 2],
            "kind": a["e_kind"][e].astype(int), "osm": a["e_osm"][e], "edge": e}


def run_global(cats: set, bbox=None) -> list[dict]:
    if not (STATION_CATS & cats):
        return []
    T = _tracks()
    if T is None:
        return []
    lines = shapely.linestrings(np.stack([np.stack([T["x0"], T["y0"]], 1), np.stack([T["x1"], T["y1"]], 1)], 1))
    tree = shapely.STRtree(lines)
    tang = np.arctan2(T["y1"] - T["y0"], T["x1"] - T["x0"])
    out: list[dict] = []

    def inb(x, y):
        return bbox is None or (bbox[0] <= x < bbox[2] and bbox[1] <= y < bbox[3])

    if "platform_track_clearance" in cats:
        polys, info = platform_polys()
        for P, I in zip(polys, info):
            cx, cy = I["c"]
            if not inb(cx, cy):
                continue
            kinds = MODE_KINDS.get(I["mode"], {0, 1, 2, 3})
            ux, uy = I["u"]
            vx, vy = I["v"]
            pb = math.atan2(uy, ux)
            cand = tree.query(P, predicate="dwithin", distance=EDGE_SEARCH)
            cand = np.array([c for c in cand if T["kind"][c] in kinds and abs(math.cos(tang[c] - pb)) > math.cos(math.radians(PAR_DEG))], dtype=np.int64)
            lab = f"{I['station']} {I['mode']} {I['type']} platform ({I['len']:.0f}x{I['w']:.1f} m, curated stations.json geometry)"
            if len(cand) == 0:
                continue
            inner = P.buffer(-THROUGH_SHRINK, join_style="mitre")
            thr = [c for c in cand if not inner.is_empty and lines[c].intersects(inner)]
            if thr:
                ln = sum(lines[c].intersection(inner).length for c in thr)
                if ln >= 1.0:
                    c = thr[0]
                    out.append(finding("platform_track_clearance", "track_through_platform", 10 + ln / 5, cx, cy, float(T["z"][c]),
                                       [T["osm"][c]], f"{lab}: track (graph edge {int(T['edge'][c])}) runs {ln:.0f} m through the platform",
                                       key=("platform_track_clearance", I["id"], round(cx), round(cy), "thr"), bearing=pb))
            # the two long edges
            n = max(2, int(I["len"] * EDGE_SPAN / EDGE_STEP))
            t = np.linspace(-I["len"] * EDGE_SPAN / 2, I["len"] * EDGE_SPAN / 2, n)
            for side in (1, -1):
                ex = cx + t * ux + side * I["w"] / 2 * vx
                ey = cy + t * uy + side * I["w"] / 2 * vy
                # distance from each edge sample to each candidate centreline, on the outside of the edge only
                best = np.full(n, np.inf)
                for c in cand:
                    dx, dy = T["x1"][c] - T["x0"][c], T["y1"][c] - T["y0"][c]
                    l2 = dx * dx + dy * dy or 1.0
                    tt = np.clip(((ex - T["x0"][c]) * dx + (ey - T["y0"][c]) * dy) / l2, 0, 1)
                    qx, qy = T["x0"][c] + dx * tt - ex, T["y0"][c] + dy * tt - ey
                    d = np.hypot(qx, qy)
                    outside = (qx * vx + qy * vy) * side > -0.05
                    best = np.where(outside & (tt > 0) & (tt < 1) & (d < best), d, best)
                ok = np.isfinite(best) & (best < EDGE_SEARCH)
                if ok.sum() < max(2, n // 3):
                    continue  # no track along this edge (side platform's back, or the far side)
                d = float(np.median(best[ok]))
                if d < EDGE_MIN or d > EDGE_MAX:
                    sub = "edge_too_close" if d < EDGE_MIN else "edge_gap"
                    sev = (EDGE_MIN - d) * 10 + 3 if d < EDGE_MIN else (d - EDGE_MAX) * 3
                    k = int(np.argmin(np.abs(best - d) + ~ok * 1e9))
                    out.append(finding("platform_track_clearance", sub, sev, float(ex[k]), float(ey[k]), None, [],
                                       f"{lab}: {'track side' if side > 0 else 'other side'} edge is {d:.2f} m from the track centreline "
                                       f"(want {EDGE_MIN}-{EDGE_MAX} m){'; the train clips the platform' if d < EDGE_MIN else ''}",
                                       key=("platform_track_clearance", I["id"], round(cx), round(cy), side), bearing=pb))
    if "station_column_clearance" in cats:
        for s in stations():
            cols = []
            for L in s.get("levels", []):
                cols += L.get("columns", []) or L.get("cols", []) or []
            for b in s.get("blds", []) or []:
                if isinstance(b, dict):
                    cols += b.get("columns", []) or b.get("cols", []) or []
            if not cols:
                continue
            C = np.array([c[:2] for c in cols], dtype=np.float64)
            a, b = tree.query(shapely.points(C[:, 0], C[:, 1]), predicate="dwithin", distance=COLUMN_MIN)
            seen = set()
            for q, c in zip(a, b):
                if q in seen or not inb(C[q, 0], C[q, 1]):
                    continue
                seen.add(q)
                d = float(shapely.distance(shapely.Point(C[q]), lines[c]))
                out.append(finding("station_column_clearance", "column", (COLUMN_MIN - d) * 5 + 2, C[q, 0], C[q, 1], float(T["z"][c]), [T["osm"][c]],
                                   f"{s.get('name')}: column {d:.2f} m from a track centreline (< {COLUMN_MIN} m)"))
    return out
