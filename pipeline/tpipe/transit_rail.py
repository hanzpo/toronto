"""OSM rail network + snapping of GTFS rail shapes onto the real track geometry.

The network is every OSM way with railway in {rail, subway, light_rail, tram,
narrow_gauge} (yards excluded), split into ~15 m pieces for spatial lookup and
turned into a node graph for gap filling.

Snapping (per GTFS shape):
  1. densify the shape to STEP m;
  2. for each point pick a nearby track segment of a compatible class within
     RADIUS m, preferring to stay on the way used by the previous point
     (avoids zig-zagging between parallel tracks);
  3. rebuild the line along OSM geometry: consecutive matches on the same way
     copy that way's vertices in between; matches on different ways are joined
     by a bounded shortest path on the track graph; runs without a match (or
     with implausible paths) fall back to the GTFS points.
Each output vertex carries tunnel/bridge flags from its OSM way.
"""

from __future__ import annotations

import numpy as np
from scipy import sparse
from scipy.sparse.csgraph import dijkstra
from scipy.spatial import cKDTree

from . import geo

KINDS = {"rail": 0, "subway": 1, "light_rail": 2, "tram": 3, "narrow_gauge": 0}
MODE_KINDS = {
    "subway": {1, 2},
    "lrt": {2, 3, 1},
    "streetcar": {3, 2},
    "commuter_rail": {0},
    "airport_rail": {0},
    "intercity_rail": {0},
}
STEP = 10.0
RADIUS = 40.0
STICKY = 8.0  # stay on current way unless another is this much closer
PIECE = 15.0
CACHE = geo.WORK / "transit_rail.npz"


def _extract() -> dict[str, np.ndarray]:
    import osmium

    tf = osmium.filter.TagFilter(*[("railway", k) for k in KINDS])
    fp = (
        osmium.FileProcessor(str(geo.RAW / "bbox.osm.pbf"), osmium.osm.NODE | osmium.osm.WAY)
        .with_locations()
        .with_filter(osmium.filter.EntityFilter(osmium.osm.WAY))
        .with_filter(tf)
    )
    lon, lat, ref, off, kind, flags, service, wid = [], [], [], [0], [], [], [], []
    for w in fp:
        t = w.tags
        svc = t.get("service")
        if svc == "yard":
            continue
        pts = [(n.ref, n.lon, n.lat) for n in w.nodes if n.location.valid()]
        if len(pts) < 2:
            continue
        for r, x, y in pts:
            ref.append(r)
            lon.append(x)
            lat.append(y)
        off.append(len(ref))
        kind.append(KINDS[t.get("railway")])
        layer = t.get("layer", "0")
        try:
            layer = int(float(layer.split(";")[0]))
        except ValueError:
            layer = 0
        tun = t.get("tunnel", "no") not in ("no", "") or t.get("location") == "underground" or (
            layer < 0 and t.get("bridge", "no") == "no"
        )
        bri = t.get("bridge", "no") not in ("no", "") or (layer > 0 and not tun)
        flags.append((1 if bri else 0) | (2 if tun else 0))
        service.append(0 if svc is None else (1 if svc in ("siding", "spur") else 2))
        wid.append(w.id)
    x, y = geo.project(np.array(lon), np.array(lat))
    arrs = dict(
        xy=np.stack([x, y], 1).astype(np.float64),
        ref=np.array(ref, dtype=np.int64),
        off=np.array(off, dtype=np.int64),
        kind=np.array(kind, dtype=np.int8),
        flags=np.array(flags, dtype=np.int8),
        service=np.array(service, dtype=np.int8),
        wid=np.array(wid, dtype=np.int64),
    )
    geo.WORK.mkdir(parents=True, exist_ok=True)
    np.savez(CACHE, **arrs)
    return arrs


class RailNet:
    def __init__(self) -> None:
        if CACHE.exists() and CACHE.stat().st_mtime > (geo.RAW / "bbox.osm.pbf").stat().st_mtime:
            d = dict(np.load(CACHE))
        else:
            d = _extract()
        self.xy = d["xy"]
        self.off = d["off"]
        self.kind = d["kind"]
        self.flags = d["flags"]
        self.service = d["service"]
        nw = len(self.kind)
        self.vway = np.repeat(np.arange(nw), np.diff(self.off))
        # graph over unique OSM node ids
        uniq, inv = np.unique(d["ref"], return_inverse=True)
        self.vnode = inv  # vertex -> graph node
        self.nxy = np.zeros((len(uniq), 2))
        self.nxy[inv] = self.xy
        a = np.arange(len(self.xy) - 1)
        a = a[self.vway[a] == self.vway[a + 1]]  # segments within a way
        self.seg_a = a  # segment i: vertices a, a+1
        seglen = np.hypot(*(self.xy[a + 1] - self.xy[a]).T)
        self.seglen = seglen
        # cumulative distance per vertex along its way
        cum = np.zeros(len(self.xy))
        cum[a + 1] = seglen
        self.vdist = np.zeros(len(self.xy))
        for w in range(nw):
            s, e = self.off[w], self.off[w + 1]
            self.vdist[s:e] = np.cumsum(cum[s:e])
        self.kinds = {}
        n = len(uniq)
        self.graph_kind: dict[frozenset, sparse.csr_matrix] = {}
        self._edges = (inv[a], inv[a + 1], seglen, self.kind[self.vway[a]])
        self._n = n
        # spatial index over segment pieces
        pts, pseg = [], []
        for i, (ai, L) in enumerate(zip(a, seglen)):
            k = max(1, int(np.ceil(L / PIECE)))
            t = (np.arange(k) + 0.5) / k
            p = self.xy[ai] + (self.xy[ai + 1] - self.xy[ai]) * t[:, None]
            pts.append(p)
            pseg.append(np.full(k, i))
        self.piece_seg = np.concatenate(pseg)
        self.tree = cKDTree(np.vstack(pts))

    def graph(self, kinds: frozenset) -> sparse.csr_matrix:
        g = self.graph_kind.get(kinds)
        if g is None:
            u, v, w, k = self._edges
            m = np.isin(k, list(kinds))
            g = sparse.coo_matrix(
                (np.concatenate([w[m], w[m]]), (np.concatenate([u[m], v[m]]), np.concatenate([v[m], u[m]]))),
                shape=(self._n, self._n),
            ).tocsr()
            self.graph_kind[kinds] = g
        return g

    # ------------------------------------------------------------------
    def _candidates(self, pts: np.ndarray, kinds: set) -> list[list[tuple[float, int, float]]]:
        """Per point: list of (dist, segment, t) for compatible segments within RADIUS."""
        hits = self.tree.query_ball_point(pts, RADIUS + PIECE)
        out = []
        kinds_arr = np.array(sorted(kinds))
        for p, h in zip(pts, hits):
            if not h:
                out.append([])
                continue
            segs = np.unique(self.piece_seg[h])
            segs = segs[np.isin(self.kind[self.vway[self.seg_a[segs]]], kinds_arr)]
            if len(segs) == 0:
                out.append([])
                continue
            A = self.xy[self.seg_a[segs]]
            B = self.xy[self.seg_a[segs] + 1]
            AB = B - A
            L2 = np.maximum((AB**2).sum(1), 1e-9)
            t = np.clip(((p - A) * AB).sum(1) / L2, 0, 1)
            d = np.hypot(*(A + AB * t[:, None] - p).T)
            d = d + 6.0 * (self.service[self.vway[self.seg_a[segs]]] > 0)
            m = d < RADIUS
            out.append(sorted(zip(d[m].tolist(), segs[m].tolist(), t[m].tolist())))
        return out

    def _way_run(self, w: int, s0: float, s1: float) -> tuple[np.ndarray, int]:
        """Points of way w strictly between along-way distances s0 and s1 (either order)."""
        a, b = self.off[w], self.off[w + 1]
        vd = self.vdist[a:b]
        if s1 >= s0:
            idx = np.nonzero((vd > s0) & (vd < s1))[0]
        else:
            idx = np.nonzero((vd < s0) & (vd > s1))[0][::-1]
        return self.xy[a + idx], int(self.flags[w])

    def snap(self, xy: np.ndarray, mode: str) -> tuple[np.ndarray, np.ndarray, np.ndarray, float]:
        """Snap shape `xy` (world m). Returns (xy, bridge_mask, tunnel_mask, matched_fraction)."""
        kinds = MODE_KINDS[mode]
        pts, _ = densify_xy(xy, STEP)
        cands = self._candidates(pts, kinds)
        # choose one match per point
        match: list[tuple[int, int, float] | None] = []  # (way, seg, along-way s)
        cur_way = -1
        for c in cands:
            if not c:
                match.append(None)
                continue
            best = c[0]
            if cur_way >= 0:
                for d, s, t in c:
                    if self.vway[self.seg_a[s]] == cur_way and d <= best[0] + STICKY:
                        best = (d, s, t)
                        break
            d, s, t = best
            w = int(self.vway[self.seg_a[s]])
            cur_way = w
            match.append((w, s, float(self.vdist[self.seg_a[s]] + t * self.seglen[s])))
        g = self.graph(frozenset(kinds))
        out_xy: list[np.ndarray] = []
        out_fl: list[np.ndarray] = []

        def emit(p, fl):
            p = np.atleast_2d(p)
            if len(p):
                out_xy.append(p)
                out_fl.append(np.full(len(p), fl, dtype=np.int8))

        def point_of(m):
            w, s, _ = m
            ai = self.seg_a[s]
            L = self.seglen[s]
            t = (m[2] - self.vdist[ai]) / L if L > 0 else 0.0
            return self.xy[ai] + (self.xy[ai + 1] - self.xy[ai]) * t

        prev_i = None  # index of last matched point
        n_matched = 0
        FALLBACK = 4  # flag bit for unmatched vertices
        for i, m in enumerate(match):
            if m is None:
                continue
            n_matched += 1
            if prev_i is None:
                # leading unmatched points: GTFS geometry
                if i > 0:
                    emit(pts[:i], FALLBACK)
                emit(point_of(m), self.flags[m[0]])
                prev_i = i
                continue
            pm = match[prev_i]
            gap_ok = True
            if pm[0] == m[0] and i - prev_i <= 3:
                run, fl = self._way_run(m[0], pm[2], m[2])
                emit(run, fl)
            else:
                path = self._path(g, pm, m, gtfs_len=(i - prev_i) * STEP)
                if path is None:
                    gap_ok = False
                else:
                    for p, fl in path:
                        emit(p, fl)
            if not gap_ok:
                emit(pts[prev_i + 1 : i], FALLBACK)
            emit(point_of(m), self.flags[m[0]])
            prev_i = i
        if prev_i is None:
            return pts, np.zeros(len(pts), bool), np.zeros(len(pts), bool), 0.0
        if prev_i < len(pts) - 1:
            emit(pts[prev_i + 1 :], FALLBACK)
        rxy = np.vstack(out_xy)
        rfl = np.concatenate(out_fl)
        # drop duplicate consecutive points
        keep = np.ones(len(rxy), bool)
        keep[1:] = np.hypot(*np.diff(rxy, axis=0).T) > 0.05
        rxy, rfl = rxy[keep], rfl[keep]
        # fallback vertices inherit tunnel flag when both neighbours are tunnel
        fb = (rfl & FALLBACK) > 0
        tun = (rfl & 2) > 0
        bri = (rfl & 1) > 0
        if fb.any():
            idx = np.arange(len(rfl))
            good = ~fb
            if good.any():
                gi = idx[good]
                lo = np.searchsorted(gi, idx, side="right") - 1
                hi = np.searchsorted(gi, idx, side="left")
                lo_t = np.where(lo >= 0, tun[gi[np.clip(lo, 0, len(gi) - 1)]], False)
                hi_t = np.where(hi < len(gi), tun[gi[np.clip(hi, 0, len(gi) - 1)]], False)
                tun = np.where(fb, lo_t & hi_t, tun)
        seg = np.hypot(*np.diff(rxy, axis=0).T)
        on_track = float(seg[~(fb[:-1] | fb[1:])].sum() / max(seg.sum(), 1e-9))
        return rxy, bri, tun, on_track

    def _path(self, g, pm, m, gtfs_len: float):
        """Track path between two matches on (possibly) different ways, as a list of
        (points, flags) chunks, or None if implausible."""
        w0, s0, d0 = pm
        w1, s1, d1 = m
        a0 = self.seg_a[s0]
        a1 = self.seg_a[s1]
        # exits from the first segment: its two end vertices with partial lengths
        ex = [(a0, d0 - self.vdist[a0]), (a0 + 1, self.vdist[a0 + 1] - d0)]
        en = [(a1, d1 - self.vdist[a1]), (a1 + 1, self.vdist[a1 + 1] - d1)]
        limit = gtfs_len * 1.6 + 150.0
        src = np.array([self.vnode[v] for v, _ in ex])
        dist, pred = dijkstra(g, indices=src, return_predecessors=True, limit=limit)
        best = None
        for i, (v0, l0) in enumerate(ex):
            for v1, l1 in en:
                L = l0 + dist[i, self.vnode[v1]] + l1
                if np.isfinite(L) and (best is None or L < best[0]):
                    best = (L, i, v0, v1)
        if best is None or best[0] > limit:
            return None
        L, i, v0, v1 = best
        nodes = []
        n = self.vnode[v1]
        s = self.vnode[v0]
        while n != s and n >= 0:
            nodes.append(n)
            n = pred[i, n]
        if n < 0:
            return None
        nodes.append(s)
        nodes.reverse()
        # flags per node from the source ways (approx: flag of whichever way used)
        chunks = []
        fl0 = int(self.flags[w0])
        fl1 = int(self.flags[w1])
        pts = self.nxy[np.array(nodes)]
        # flags: midpoint lookup of nearest way-vertex flag is costly; use the
        # stronger of the endpoint flags on short paths, else ends.
        fl = fl0 if fl0 == fl1 else 0
        chunks.append((pts, fl))
        return chunks


def densify_xy(xy: np.ndarray, step: float) -> tuple[np.ndarray, np.ndarray]:
    """Like grade.densify but vectorized."""
    d = np.hypot(*np.diff(xy, axis=0).T)
    n = np.maximum(1, np.ceil(d / step).astype(int))
    seg = np.repeat(np.arange(len(d)), n)
    k = np.concatenate([np.arange(c) for c in n]) if len(n) else np.zeros(0, int)
    t = ((k + 1) / np.repeat(n, n))[:, None]
    body = xy[seg] + (xy[seg + 1] - xy[seg]) * t
    return np.vstack([xy[:1], body]), np.concatenate([[0], seg])
