"""Transit pipeline: GTFS feeds -> compact per-agency/profile TBN1 files.

    cd pipeline && uv run python -m tpipe.transit [--download] [agency ...]

Output (see docs/TRANSIT.md): app/public/data/transit/{agency}_{profile}_{rail|bus}.bin.gz
and app/public/data/transit/index.json.
"""

from __future__ import annotations

import json
import re
import sys
import time
import urllib.request
from collections import Counter, defaultdict

import numpy as np
import polars as pl
import shapely

from . import geo, tbn, terrain
from .grade import profile as grade_profile
from .transit_gtfs import PROFILES, Feed, parse_times, pick_dates, service_calendar
from .transit_rail import RailNet, densify_xy
from . import rail_graph
from .rail_routes import Router, consist_len
from .bus_roads import BusRouter, RoadNet
from .transit_sources import SOURCES

OUTDIR = geo.OUT / "transit"
GTFS = geo.RAW / "gtfs"

MODES = ["subway", "lrt", "streetcar", "commuter_rail", "airport_rail", "intercity_rail", "bus"]
RAIL_MODES = set(MODES[:6])
RAIL_AGENCIES = {"ttc", "go", "up", "via", "grt"}
# vertical profile parameters: (tunnel cover, bridge clearance)
COVER = {"subway": 14.0, "lrt": 10.0, "streetcar": 8.0}
DWELL = {"subway": 25, "lrt": 20, "streetcar": 12, "commuter_rail": 45, "airport_rail": 40, "intercity_rail": 60, "bus": 8}
# must match app/src/transit/motion.ts MODE_ACCEL
ACCEL = {"subway": 1.0, "lrt": 1.0, "streetcar": 1.1, "commuter_rail": 0.6, "airport_rail": 0.8, "intercity_rail": 0.5, "bus": 1.2}
VMAX = {"subway": 24.4, "lrt": 19.4, "streetcar": 16.7, "commuter_rail": 41.7, "airport_rail": 40.0, "intercity_rail": 44.4, "bus": 22.2}
BUS_SIMPLIFY = 1.5
PLATFORM = re.compile(r"\s*(-\s*)?\b(\w+bound\s+|LRT\s+)?platform\b.*$", re.I)
REPLACEMENT_BUS = re.compile(r"replacement bus|bus replacement|shuttle bus|bus shuttle", re.I)
BUS_DRAPE_STEP = 60.0
RAIL_DRAPE_STEP = 10.0
RAIL_TOL = 0.3


# ----------------------------------------------------------------------------
def download(keys) -> None:
    GTFS.mkdir(parents=True, exist_ok=True)
    for k in keys:
        dst = GTFS / f"{k}.zip"
        if dst.exists():
            continue
        for url in (SOURCES[k]["url"], SOURCES[k].get("mirror")):
            if not url:
                continue
            try:
                print(f"download {k}: {url}")
                req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                data = urllib.request.urlopen(req, timeout=120).read()
                if data[:2] == b"PK":
                    dst.write_bytes(data)
                    break
            except Exception as e:  # noqa: BLE001
                print(f"  failed: {e}")


def route_mode(src: dict, short: str, rtype: int) -> str | None:
    if short in src.get("route_modes", {}):
        return src["route_modes"][short]
    if rtype in (0, 900, 901, 902, 903, 904, 905, 906):
        return "streetcar"
    if rtype in (1, 400, 401, 402, 403, 404, 405):
        return "subway"
    if rtype == 2 or 100 <= rtype < 200:
        return src.get("rail_mode", "commuter_rail")
    if rtype == 12:
        return "lrt"
    if rtype in (3, 11) or 200 <= rtype < 300 or 700 <= rtype < 800:
        return "bus"
    return None  # ferries, cable cars, ... are skipped


# ----------------------------------------------------------------------------
def seg_project(xy: np.ndarray, cum: np.ndarray, p: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Distance from p to every segment of polyline xy and the along-line position."""
    A = xy[:-1]
    AB = xy[1:] - A
    L2 = np.maximum((AB**2).sum(1), 1e-9)
    t = np.clip(((p - A) * AB).sum(1) / L2, 0, 1)
    d = np.hypot(*(A + AB * t[:, None] - p).T)
    return d, cum[:-1] + t * np.sqrt(L2)


def project_stops(xy: np.ndarray, stops: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Monotone distance along `xy` for each stop (Viterbi over local minima).
    Returns (dist, offset_m)."""
    cum = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(xy, axis=0).T))])
    n = len(stops)
    if len(xy) < 2:
        return np.zeros(n), np.zeros(n)
    cands = []
    for p in stops:
        d, s = seg_project(xy, cum, p)
        # local minima of d along the line
        lm = np.nonzero((d <= np.r_[np.inf, d[:-1]]) & (d <= np.r_[d[1:], np.inf]))[0]
        dm = d[lm]
        order = np.argsort(dm)[:8]
        lm, dm = lm[order], dm[order]
        keep = dm <= dm[0] + 300.0
        c = sorted(zip(s[lm[keep]].tolist(), dm[keep].tolist()))
        cands.append(c)
    # DP: minimise sum of distances subject to non-decreasing s
    INF = 1e18
    cost = [np.array([d for _, d in cands[0]])]
    back = []
    for k in range(1, n):
        ps = np.array([s for s, _ in cands[k - 1]])
        pc = cost[-1]
        cs = np.array([s for s, _ in cands[k]])
        cd = np.array([d for _, d in cands[k]])
        ok = ps[None, :] <= cs[:, None] + 1e-6
        tot = np.where(ok, pc[None, :], INF)
        bi = np.argmin(tot, axis=1)
        best = tot[np.arange(len(cs)), bi]
        cost.append(best + cd)
        back.append(bi)
    j = int(np.argmin(cost[-1]))
    if cost[-1][j] >= INF:
        # infeasible (should not happen): greedy clamp
        s = np.maximum.accumulate(np.array([c[0][0] for c in cands]))
        return s, np.zeros(n)
    sel = [j]
    for k in range(n - 1, 0, -1):
        j = int(back[k - 1][j])
        sel.append(j)
    sel.reverse()
    s = np.array([cands[k][sel[k]][0] for k in range(n)])
    off = np.array([cands[k][sel[k]][1] for k in range(n)])
    return s, off


def rdp3(p: np.ndarray, tol: float) -> np.ndarray:
    """Ramer-Douglas-Peucker in 3D; returns a boolean keep mask."""
    keep = np.zeros(len(p), bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(p) - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        seg = p[b] - p[a]
        L2 = float(seg @ seg)
        q = p[a + 1 : b] - p[a]
        if L2 == 0:
            d = np.sqrt((q**2).sum(1))
        else:
            t = np.clip(q @ seg / L2, 0, 1)
            d = np.sqrt(((q - t[:, None] * seg) ** 2).sum(1))
        i = int(np.argmax(d))
        if d[i] > tol:
            m = a + 1 + i
            keep[m] = True
            stack.append((a, m))
            stack.append((m, b))
    return keep


def cumlen(xy: np.ndarray) -> np.ndarray:
    return np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(xy[:, :2], axis=0).T))])


def cut_line(xy: np.ndarray, cum: np.ndarray, d0: float, d1: float) -> np.ndarray:
    """Sub-polyline between along-line distances d0 < d1."""
    def at(d):
        i = int(np.clip(np.searchsorted(cum, d) - 1, 0, len(cum) - 2))
        L = cum[i + 1] - cum[i]
        t = 0.0 if L <= 0 else (d - cum[i]) / L
        return xy[i] + (xy[i + 1] - xy[i]) * t

    mid = xy[(cum > d0) & (cum < d1)]
    return np.vstack([at(d0), mid, at(d1)])


# ----------------------------------------------------------------------------
class Agency:
    def __init__(self, key: str, rail: RailNet | None, router: Router | None = None, bus_router: BusRouter | None = None) -> None:
        self.key = key
        self.router = router
        self.bus_router = bus_router
        self.bus_matched = [0, 0]
        self.route_stats: list = []
        self.src = SOURCES[key]
        self.feed = Feed(GTFS / f"{key}.zip")
        self.railnet = rail
        self.ter = terrain.get()

    def load(self) -> None:
        f = self.feed
        t0 = time.time()
        routes = f.read("routes.txt", ["route_id", "route_short_name", "route_long_name", "route_type", "route_color", "route_text_color"])
        self.routes = {}
        for rid, short, long_, rtype, color, tcolor in routes.iter_rows():
            try:
                rt = int(rtype)
            except (TypeError, ValueError):
                continue
            short = short or ""
            mode = route_mode(self.src, short, rt)
            if mode is None:
                continue
            color = self.src.get("route_colors", {}).get(short) or self.src.get("mode_colors", {}).get(mode) or color
            tcolor = self.src.get("text_colors", {}).get(short) or tcolor
            color = (color or ("555555" if mode == "bus" else "888888")).lstrip("#").upper()
            if not tcolor:
                r, g, b = (int(color[i : i + 2], 16) for i in (0, 2, 4))
                tcolor = "000000" if 0.299 * r + 0.587 * g + 0.114 * b > 150 else "FFFFFF"
            self.routes[rid] = dict(
                id=f"{self.key}:{rid}", agency=self.key, short=short, long=long_ or "",
                mode=mode, color="#" + color, textColor="#" + tcolor.lstrip("#").upper(),
            )
        trips = f.read("trips.txt", ["route_id", "service_id", "trip_id", "trip_headsign", "trip_short_name", "direction_id", "shape_id", "block_id"])
        trips = trips.filter(pl.col("route_id").is_in(list(self.routes)))
        active = service_calendar(f)
        tps = Counter(trips["service_id"].to_list())
        self.dates = pick_dates(active, tps)
        prof_trips = {}
        for prof, d in self.dates.items():
            prof_trips[prof] = set(trips.filter(pl.col("service_id").is_in(list(active[d])))["trip_id"].to_list())
        used = set().union(*prof_trips.values()) if prof_trips else set()
        self.prof_trips = prof_trips
        self.trips = {r[2]: r for r in trips.filter(pl.col("trip_id").is_in(list(used))).iter_rows()}
        print(f"  [{self.key}] routes={len(self.routes)} trips used={len(used)} dates={ {k: str(v) for k, v in self.dates.items()} } ({time.time()-t0:.1f}s)")

        st = f.read("stop_times.txt", ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"])
        st = st.filter(pl.col("trip_id").is_in(list(used)))
        st = st.with_columns(
            parse_times(pl.col("arrival_time")).alias("arr"),
            parse_times(pl.col("departure_time")).alias("dep"),
            pl.col("stop_sequence").cast(pl.Int64, strict=False).alias("seq"),
        ).sort(["trip_id", "seq"])
        stops = f.read("stops.txt", ["stop_id", "stop_name", "stop_lat", "stop_lon", "parent_station", "location_type"])
        stops = stops.filter(pl.col("stop_lat").is_not_null() & pl.col("stop_lon").is_not_null())
        self.stop_ids = stops["stop_id"].to_list()
        self.stop_index = {s: i for i, s in enumerate(self.stop_ids)}
        self.stop_name = stops["stop_name"].fill_null("").to_list()
        self.stop_parent = stops["parent_station"].to_list()
        lon = stops["stop_lat"].cast(pl.Float64, strict=False).to_numpy()
        lat = lon
        lon = stops["stop_lon"].cast(pl.Float64, strict=False).to_numpy()
        lat = stops["stop_lat"].cast(pl.Float64, strict=False).to_numpy()
        self.stop_ll = np.stack([lon, lat], 1)
        x, y = geo.project(lon, lat)
        self.stop_xy = np.stack([x, y], 1)

        tid = st["trip_id"].to_numpy()
        brk = np.nonzero(tid[1:] != tid[:-1])[0] + 1
        starts = np.r_[0, brk]
        ends = np.r_[brk, len(tid)]
        sidx = np.array([self.stop_index.get(s, -1) for s in st["stop_id"].to_list()], dtype=np.int64)
        arr = st["arr"].fill_null(-1).to_numpy()
        dep = st["dep"].fill_null(-1).to_numpy()
        self.stop_times = {}
        for a, b in zip(starts, ends):
            s = sidx[a:b]
            ok = s >= 0
            if ok.sum() < 2:
                continue
            self.stop_times[tid[a]] = (s[ok], arr[a:b][ok], dep[a:b][ok])
        self.freqs = defaultdict(list)
        if f.has("frequencies.txt"):
            fr = f.read("frequencies.txt", ["trip_id", "start_time", "end_time", "headway_secs"])
            fr = fr.with_columns(parse_times(pl.col("start_time")).alias("s"), parse_times(pl.col("end_time")).alias("e"))
            for t, s, e, h in fr.select(["trip_id", "s", "e", "headway_secs"]).iter_rows():
                if t in self.trips and h:
                    self.freqs[t].append((s, e, int(h)))
        # shapes
        self.shapes = {}
        if f.has("shapes.txt"):
            sh = f.read("shapes.txt", ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"])
            want = {r[6] for r in self.trips.values() if r[6]}
            sh = sh.filter(pl.col("shape_id").is_in(list(want))).with_columns(
                pl.col("shape_pt_sequence").cast(pl.Int64, strict=False),
                pl.col("shape_pt_lat").cast(pl.Float64, strict=False),
                pl.col("shape_pt_lon").cast(pl.Float64, strict=False),
            ).drop_nulls().sort(["shape_id", "shape_pt_sequence"])
            sid = sh["shape_id"].to_numpy()
            lo = sh["shape_pt_lon"].to_numpy()
            la = sh["shape_pt_lat"].to_numpy()
            if len(sid):
                brk = np.nonzero(sid[1:] != sid[:-1])[0] + 1
                for a, b in zip(np.r_[0, brk], np.r_[brk, len(sid)]):
                    ll = np.stack([lo[a:b], la[a:b]], 1)
                    self.shapes[sid[a]] = ll
        print(f"  [{self.key}] stop_times trips={len(self.stop_times)} shapes={len(self.shapes)} ({time.time()-t0:.1f}s)")

    # ------------------------------------------------------------------
    def build(self) -> None:
        """Patterns, geometry, time profiles, trip records."""
        t0 = time.time()
        w, s, e, n = geo.BBOX_LONLAT
        pat_key = {}
        self.patterns = []  # dicts
        self.trip_recs = []  # (trip_id, pattern, arr, dep)
        geom_cache = {}
        for tid, (sidx, arr, dep) in self.stop_times.items():
            r = self.trips.get(tid)
            if r is None:
                continue
            rid, _, _, head, tshort, direc, shp, _blk = r
            key = (rid, direc, shp, sidx.tobytes(), head)
            p = pat_key.get(key)
            if p is None:
                p = self._make_pattern(rid, direc, shp, sidx, head, geom_cache, (w, s, e, n))
                pat_key[key] = p
            if p < 0:
                continue
            self.trip_recs.append((tid, p, arr, dep))
        print(f"  [{self.key}] patterns={len(self.patterns)} geoms={len(geom_cache)} ({time.time()-t0:.1f}s)")

    def _make_pattern(self, rid, direc, shp, sidx, head, cache, bbox) -> int:
        mode = self.routes[rid]["mode"]
        if mode in RAIL_MODES and REPLACEMENT_BUS.search(head or ""):
            mode = "bus"  # bus replacing a rail service (diversions, shuttles)
        ll = self.stop_ll[sidx]
        w, s, e, n = bbox
        inside = (ll[:, 0] >= w) & (ll[:, 0] <= e) & (ll[:, 1] >= s) & (ll[:, 1] <= n)
        if inside.sum() == 0:
            return -1
        # longest contiguous inside run
        runs, cur = [], None
        for i, v in enumerate(inside):
            if v and cur is None:
                cur = i
            if not v and cur is not None:
                runs.append((cur, i - 1))
                cur = None
        if cur is not None:
            runs.append((cur, len(inside) - 1))
        i0, i1 = max(runs, key=lambda r: r[1] - r[0])
        if i1 == i0 and i0 == 0 and i1 == len(sidx) - 1:
            return -1
        # full raw shape
        if shp and shp in self.shapes:
            sll = self.shapes[shp]
        else:
            sll = ll
        sxy = np.stack(geo.project(sll[:, 0], sll[:, 1]), 1)
        if len(sxy) < 2:
            return -1
        dist, _ = project_stops(sxy, self.stop_xy[sidx])
        cum = cumlen(sxy)
        virt_lo = virt_hi = None
        d_lo, d_hi = dist[i0], dist[i1]
        if i0 > 0:  # entering bbox between stop i0-1 and i0
            virt_lo = self._crossing(sll, cum, dist[i0 - 1], dist[i0], bbox, entering=True)
            d_lo = virt_lo
        if i1 < len(sidx) - 1:
            virt_hi = self._crossing(sll, cum, dist[i1], dist[i1 + 1], bbox, entering=False)
            d_hi = virt_hi
        clipped = virt_lo is not None or virt_hi is not None
        if d_hi - d_lo < 1.0:
            return -1
        part = cut_line(sxy, cum, d_lo, d_hi)
        if mode in RAIL_MODES and self.router is not None:
            p = self._make_rail_pattern(rid, direc, head, mode, sidx, i0, i1, dist, d_lo, d_hi, virt_lo, virt_hi, part, cache)
            if p is not None:
                return p
        if mode == "bus" and self.bus_router is not None:
            # follow the road graph in the curb lane (bus_roads.py)
            sdp = np.clip(np.asarray(dist[i0 : i1 + 1], float) - d_lo, 0.0, d_hi - d_lo)
            rkey = ("road", np.round(part, 0).tobytes(), np.round(sdp, 0).tobytes())
            rg = cache.get(rkey)
            if rg is None:
                rg = self.bus_router.route(np.asarray(part, float)[:, :2], sdp, f"{self.key}:{self.routes[rid]['short']}:{head}")
                cache[rkey] = rg if rg is not None else False
            self.bus_matched[0] += 1
            if rg is not False and rg is not None and len(rg) >= 2:
                part = rg
                self.bus_matched[1] += 1
        gkey = (np.round(part, 0).tobytes(), mode)
        g = cache.get(gkey)
        if g is None:
            g = self._geometry(part, mode)
            cache[gkey] = g
        gid, gxy = g
        # stop list (with virtual boundary stops)
        stops = list(sidx[i0 : i1 + 1])
        flags = [0] * len(stops)
        vxy = []
        if virt_lo is not None:
            stops.insert(0, -1)
            flags.insert(0, 1)
        if virt_hi is not None:
            stops.append(-2)
            flags.append(1)
        pxy = []
        for sv in stops:
            if sv == -1:
                pxy.append(gxy[0])
            elif sv == -2:
                pxy.append(gxy[-1])
            else:
                pxy.append(self.stop_xy[sv])
        sd, _ = project_stops(gxy, np.array(pxy))
        if virt_lo is not None:
            sd[0] = 0.0
        if virt_hi is not None:
            sd[-1] = cumlen(gxy)[-1]
        self.patterns.append(dict(
            route=rid, dir=int(direc) if direc not in (None, "") else 0, head=head or "",
            geom=gid, stops=stops, flags=flags, dist=sd, mode=mode,
            # mapping from original stop_times rows -> pattern rows
            i0=i0, i1=i1, vlo=virt_lo, vhi=virt_hi, rawdist=dist,
        ))
        return len(self.patterns) - 1

    def _make_rail_pattern(self, rid, direc, head, mode, sidx, i0, i1, dist, d_lo, d_hi, virt_lo, virt_hi, part, cache):
        """Pattern routed through the rail graph (rail_routes); None if routing failed."""
        stops = list(sidx[i0 : i1 + 1])
        flags = [0] * len(stops)
        sd = list(np.asarray(dist[i0 : i1 + 1], float) - d_lo)
        if virt_lo is not None:
            stops.insert(0, -1)
            flags.insert(0, 1)
            sd.insert(0, 0.0)
        if virt_hi is not None:
            stops.append(-2)
            flags.append(1)
            sd.append(d_hi - d_lo)
        sd = np.maximum.accumulate(np.clip(np.array(sd), 0.0, d_hi - d_lo))
        L = consist_len(mode, self.routes[rid]["short"])
        pxy = np.asarray(part, float)[:, :2]
        gkey = ("rail", np.round(pxy, 0).tobytes(), mode, np.round(sd, 0).tobytes(), round(L, 1))
        g = cache.get(gkey)
        if g is None:
            rr = self.router.route(pxy, sd, [bool(f) for f in flags], mode, L)
            if rr.xyz is None or len(rr.xyz) < 2:
                cache[gkey] = False
                return None
            if not hasattr(self, "geoms"):
                self.geoms = []
                self.snap_stats = []
            self.geoms.append(rr.xyz)
            self.snap_stats.append(1.0 if rr.ok else 0.0)
            self.route_stats.append((self.routes[rid]["short"], mode, rr.ok, rr.breaks, len(rr.edges)))
            g = (len(self.geoms) - 1, rr)
            cache[gkey] = g
        elif g is False:
            return None
        gid, rr = g
        fr = np.array(rr.fronts)
        cen = np.where(np.array(flags) > 0, fr, fr - L * 0.5)
        cen = np.maximum.accumulate(np.clip(cen, 0.0, rr.length))
        self.patterns.append(dict(
            route=rid, dir=int(direc) if direc not in (None, "") else 0, head=head or "",
            geom=gid, stops=stops, flags=flags, dist=cen, mode=mode,
            i0=i0, i1=i1, vlo=virt_lo, vhi=virt_hi, rawdist=dist, rr=rr, clen=L,
        ))
        return len(self.patterns) - 1

    def _crossing(self, sll, cum, da, db, bbox, entering):
        """Along-line distance where the shape crosses the bbox between da and db."""
        w, s, e, n = bbox
        idx = np.nonzero((cum >= da) & (cum <= db))[0]
        if len(idx) == 0:
            return (da + db) / 2
        ins = (sll[idx, 0] >= w) & (sll[idx, 0] <= e) & (sll[idx, 1] >= s) & (sll[idx, 1] <= n)
        if entering:
            k = np.nonzero(ins)[0]
            return float(cum[idx[k[0]]]) if len(k) else float(db)
        k = np.nonzero(~ins)[0]
        return float(cum[idx[k[0] - 1]]) if len(k) and k[0] > 0 else float(da)

    def _geometry(self, xy: np.ndarray, mode: str):
        if not hasattr(self, "geoms"):
            self.geoms = []
            self.snap_stats = []
        if mode in RAIL_MODES and self.railnet is not None:
            sxy, bri, tun, frac = self.railnet.snap(xy, mode)
            self.snap_stats.append(frac)
            dxy, seg = densify_xy(sxy, RAIL_DRAPE_STEP)
            # flags: a densified vertex takes the flag of its source segment when both ends agree
            b2 = bri[seg] & bri[np.minimum(seg + 1, len(bri) - 1)]
            t2 = tun[seg] & tun[np.minimum(seg + 1, len(tun) - 1)]
            b2[0], t2[0] = bri[0], tun[0]
            ground = self.ter.sample(dxy[:, 0], dxy[:, 1])
            z = grade_profile(dxy, ground, b2, t2, clearance=6.0, cover=COVER.get(mode, 10.0), ramp=150.0,
                              open_ends=True)
            out = np.column_stack([dxy, z])
            out = out[rdp3(out, RAIL_TOL)]
        else:
            ls = shapely.LineString(xy)
            if mode == "bus":
                ls = ls.simplify(BUS_SIMPLIFY)
            dxy, _ = densify_xy(np.asarray(ls.coords), BUS_DRAPE_STEP)
            z = self.ter.sample(dxy[:, 0], dxy[:, 1])
            out = np.column_stack([dxy, z])
            out = out[rdp3(out, 1.0)]
        self.geoms.append(out)
        return len(self.geoms) - 1, out[:, :2]

    # ------------------------------------------------------------------
    def timetable(self, pat: dict, arr: np.ndarray, dep: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Absolute (arr, dep) seconds for the pattern's stops."""
        arr = arr.astype(np.float64)
        dep = dep.astype(np.float64)
        arr = np.where(arr < 0, dep, arr)
        dep = np.where(dep < 0, arr, dep)
        raw = pat["rawdist"]
        # interpolate missing times by distance
        miss = arr < 0
        if miss.any():
            ok = ~miss
            if ok.sum() < 2:
                return None, None
            arr = np.interp(raw, raw[ok], arr[ok])
            dep = np.where(miss, arr, dep)
        dep = np.maximum(dep, arr)
        # monotone
        for k in range(1, len(arr)):
            if arr[k] < dep[k - 1]:
                arr[k] = dep[k - 1]
                dep[k] = max(dep[k], arr[k])
        # spread flat (rounded-minute) runs by distance
        tk = dep.copy()
        k = 0
        n = len(arr)
        while k < n - 1:
            j = k
            while j + 1 < n and arr[j + 1] == dep[k] and arr[j + 1] == dep[j + 1]:
                j += 1
            if j > k and j + 1 < n:
                d0, d1 = raw[k], raw[j + 1]
                t0, t1 = dep[k], arr[j + 1]
                if d1 > d0 and t1 > t0:
                    for q in range(k + 1, j + 1):
                        arr[q] = dep[q] = t0 + (t1 - t0) * (raw[q] - d0) / (d1 - d0)
            k = j + 1 if j > k else k + 1
        del tk
        i0, i1 = pat["i0"], pat["i1"]
        a = list(arr[i0 : i1 + 1])
        d = list(dep[i0 : i1 + 1])
        if pat["vlo"] is not None:
            da, db = raw[i0 - 1], raw[i0]
            f = (pat["vlo"] - da) / (db - da) if db > da else 1.0
            t = dep[i0 - 1] + (arr[i0] - dep[i0 - 1]) * f
            a.insert(0, t)
            d.insert(0, t)
        if pat["vhi"] is not None:
            da, db = raw[i1], raw[i1 + 1]
            f = (pat["vhi"] - da) / (db - da) if db > da else 0.0
            t = dep[i1] + (arr[i1 + 1] - dep[i1]) * f
            a.append(t)
            d.append(t)
        a = np.array(a)
        d = np.array(d)
        # synthetic dwell where arrival == departure at real intermediate stops
        mode = pat["mode"]
        dw = DWELL[mode]
        acc, vmax = ACCEL[mode], VMAX[mode]
        fl = pat["flags"]
        dist = pat["dist"]
        for k in range(1, len(a) - 1):
            if d[k] - a[k] < 1 and not fl[k]:
                room = a[k] - d[k - 1]
                L = dist[k] - dist[k - 1]
                # minimum running time with accel/brake `acc` and top speed `vmax`
                tmin = L / vmax + vmax / acc if L >= vmax * vmax / acc else 2.0 * np.sqrt(max(L, 0.0) / acc)
                x = min(dw, room - tmin * 1.05)
                if x >= 3:
                    a[k] -= x
        return np.round(a).astype(np.int64), np.round(d).astype(np.int64)

    # ------------------------------------------------------------------
    def write(self) -> dict:
        tp_key = {}
        tps = []  # (arr_off, dep_off)
        recs = []  # (tid, pattern, tp, start)
        for tid, p, arr, dep in self.trip_recs:
            pat = self.patterns[p]
            a, d = self.timetable(pat, arr, dep)
            if a is None:
                continue
            instances = [0]
            fr = self.freqs.get(tid)
            base = int(a[0])
            if fr:
                instances = []
                for s, e, h in fr:
                    t = s
                    while t < e:
                        instances.append(t - base)
                        t += h
            ao = a - base
            do = d - base
            if ao[-1] > 65535:
                continue
            k = (p, ao.tobytes(), do.tobytes())
            q = tp_key.get(k)
            if q is None:
                q = tp_key[k] = len(tps)
                tps.append((ao.astype(np.uint16), do.astype(np.uint16)))
            for j, sh in enumerate(instances):
                recs.append((tid if len(instances) == 1 else f"{tid}#{j}", p, q, base + sh, base + sh + int(ao[-1])))
        info = {"id": self.key, "name": self.src["name"], "profiles": {}}
        for prof, date in self.dates.items():
            active = self.prof_trips[prof]
            info["profiles"][prof] = {"date": date.isoformat(), "files": {}}
            for kind in ("rail", "bus"):
                sel = [r for r in recs if r[0].split("#")[0] in active and ((self.patterns[r[1]]["mode"] in RAIL_MODES) == (kind == "rail"))]
                if not sel:
                    continue
                fn = f"{self.key}_{prof}_{kind}.bin.gz"
                size, meta = self._write_file(OUTDIR / fn, sel, tps, kind, prof, date)
                info["profiles"][prof]["files"][kind] = {"file": fn, "bytes": size, **meta}
                print(f"  [{self.key}] {fn}: {size/1024:.0f} KiB {meta}")
        return info

    def _write_file(self, path, recs, tps, kind, prof, date):
        recs.sort(key=lambda r: r[3])
        pats = sorted({r[1] for r in recs})
        pmap = {p: i for i, p in enumerate(pats)}
        tpl = sorted({r[2] for r in recs})
        tmap = {t: i for i, t in enumerate(tpl)}
        geoms = sorted({self.patterns[p]["geom"] for p in pats})
        gmap = {g: i for i, g in enumerate(geoms)}
        routes = sorted({self.patterns[p]["route"] for p in pats})
        rmap = {r: i for i, r in enumerate(routes)}
        # stops, including virtual edge stops (unique per pattern end)
        stop_list: list = []
        smap: dict = {}
        stop_z: list = []
        heads: dict[str, int] = {}
        pat_stop, pat_dist, pat_flag, pat_off = [], [], [], [0]
        geom_arrays = [self.geoms[g] for g in geoms]
        for p in pats:
            pat = self.patterns[p]
            gxyz = self.geoms[pat["geom"]]
            gcum = cumlen(gxyz)
            for k, (sv, fl, dd) in enumerate(zip(pat["stops"], pat["flags"], pat["dist"])):
                if sv < 0:
                    key = ("edge", pat["geom"], sv)
                else:
                    key = sv
                if key not in smap:
                    smap[key] = len(stop_list)
                    zz = float(np.interp(dd, gcum, gxyz[:, 2]))
                    if sv < 0:
                        pt = gxyz[0 if sv == -1 else -1]
                        stop_list.append((f"~edge{len(stop_list)}", "", float(pt[0]), float(pt[1]), None))
                    else:
                        stop_list.append((self.stop_ids[sv], self.stop_name[sv], *self.stop_xy[sv], self.stop_parent[sv]))
                    stop_z.append(zz)
                pat_stop.append(smap[key])
                pat_dist.append(dd)
                pat_flag.append(fl)
            pat_off.append(len(pat_stop))
            heads.setdefault(pat["head"], len(heads))

        def idx(a, n):
            a = np.asarray(a)
            return a.astype(np.uint16 if n < 65535 else np.uint32)

        shape_off = np.cumsum([0] + [len(g) for g in geom_arrays]).astype(np.uint32)
        shape_xyz = np.vstack(geom_arrays).astype(np.float32).ravel() if geom_arrays else np.zeros(0, np.float32)
        tp_off = np.cumsum([0] + [len(tps[t][0]) for t in tpl]).astype(np.uint32)
        arrays = {
            "stop_xyz": np.array([[s[2], s[3], z] for s, z in zip(stop_list, stop_z)], dtype=np.float32).ravel(),
            "shape_off": shape_off,
            "shape_xyz": shape_xyz,
            "pat_route": idx([rmap[self.patterns[p]["route"]] for p in pats], len(routes)),
            "pat_shape": idx([gmap[self.patterns[p]["geom"]] for p in pats], len(geoms)),
            "pat_mode": np.array([MODES.index(self.patterns[p]["mode"]) for p in pats], dtype=np.uint8),
            "pat_dir": np.array([self.patterns[p]["dir"] for p in pats], dtype=np.uint8),
            "pat_headsign": idx([heads[self.patterns[p]["head"]] for p in pats], len(heads)),
            "pat_stop_off": np.array(pat_off, dtype=np.uint32),
            "pat_stop": idx(pat_stop, len(stop_list)),
            "pat_stop_dist": np.array(pat_dist, dtype=np.float32),
            "pat_stop_flag": np.array(pat_flag, dtype=np.uint8),
            "tp_off": tp_off,
            "tp_arr": np.concatenate([tps[t][0] for t in tpl]).astype(np.uint16),
            "tp_dep": np.concatenate([tps[t][1] for t in tpl]).astype(np.uint16),
            "trip_start": np.array([r[3] for r in recs], dtype=np.int32),
            "trip_pattern": idx([pmap[r[1]] for r in recs], len(pats)),
            "trip_tp": idx([tmap[r[2]] for r in recs], len(tpl)),
        }
        # store tp_dep as dwell (dep - arr) -> mostly zeros, compresses well
        arrays["tp_dwell"] = (arrays["tp_dep"].astype(np.int32) - arrays["tp_arr"]).astype(np.uint16)
        del arrays["tp_dep"]
        route_meta = [self.routes[r] for r in routes]
        header = dict(
            laneShapes=bool(kind == "bus" and self.bus_router is not None),
            version=1, agency=self.key, profile=prof, date=date.isoformat(), kind=kind,
            modes=MODES, routes=route_meta,
            headsigns=list(heads), stopIds=[s[0] for s in stop_list], stopNames=[s[1] for s in stop_list],
            stopParents=[s[4] or "" for s in stop_list],
        )
        durs = np.array([tps[r[2]][0][-1] for r in recs])
        header["maxDuration"] = int(durs.max()) if len(durs) else 0
        if kind == "rail":
            self._rail_arrays(arrays, recs, pats, header)
        else:
            arrays["trip_next"] = self._trip_next(recs)
            tripnames = []
            for r in recs:
                tr = self.trips[r[0].split("#")[0]]
                # trip_short_name, else the trailing number of the trip_id (GO: "20261127-LW-1619")
                m = re.search(r"(\d{2,5})$", tr[2]) if self.src.get("rail_mode") == "commuter_rail" else None
                tripnames.append(tr[4] or (m.group(1) if m else ""))
            header["tripNames"] = tripnames
        size = tbn.write(path, arrays, level=9, **header)
        meta = dict(trips=len(recs), patterns=len(pats), shapes=len(geoms), stops=len(stop_list), vertices=int(shape_off[-1]))
        self.last_stops = (stop_list, stop_z, pats, pat_off, pat_stop)
        return size, meta

    def _rail_arrays(self, arrays: dict, recs: list, pats: list, header: dict) -> None:
        """Rail routes through data/rail/network.bin.gz + vehicle blocks (see docs/RAIL.md)."""
        emap = getattr(self.router, "out_map", None) if self.router is not None else None
        r_off, r_edge, r_start, r_flags, p_len = [0], [], [], [], []
        for p in pats:
            pat = self.patterns[p]
            rr = pat.get("rr")
            ok = rr is not None and emap is not None and all(emap[e] >= 0 for e, _ in rr.edges)
            if ok:
                for e, d in rr.edges:
                    r_edge.append(int(emap[e]) * 2 + (0 if d > 0 else 1))
                r_start.append(rr.start)
                r_flags.append(1 if rr.ok else 2)
            else:
                r_start.append(0.0)
                r_flags.append(0)
            r_off.append(len(r_edge))
            p_len.append(pat.get("clen", 0.0))
        arrays["pat_len"] = np.array(p_len, dtype=np.float32)
        arrays["pat_rflags"] = np.array(r_flags, dtype=np.uint8)
        arrays["pat_rstart"] = np.array(r_start, dtype=np.float32)
        arrays["pat_redge_off"] = np.array(r_off, dtype=np.uint32)
        arrays["pat_redge"] = np.array(r_edge, dtype=np.uint32)
        arrays["trip_next"] = self._trip_next(recs)
        header["railNetwork"] = getattr(self.router, "net_hash", "")

    def _trip_next(self, recs: list) -> np.ndarray:
        """Next trip (index in `recs`) of the same GTFS vehicle block that starts at the stop
        where this one ends, within 90 min; -1 if none."""
        blk: dict = {}
        for i, r in enumerate(recs):
            b = self.trips[r[0].split("#")[0]][7]
            if b and "#" not in r[0]:
                blk.setdefault(b, []).append(i)
        nxt = np.full(len(recs), -1, dtype=np.int32)
        stop_of = lambda p, k: self.patterns[p]["stops"][k]  # noqa: E731
        for b, lst in blk.items():
            lst.sort(key=lambda i: recs[i][3])
            for a, c in zip(lst[:-1], lst[1:]):
                ra, rc = recs[a], recs[c]
                if 0 <= rc[3] - ra[4] <= 5400:
                    sa, sc = stop_of(ra[1], -1), stop_of(rc[1], 0)
                    same = sa == sc or (sa >= 0 and sc >= 0 and (
                        (self.stop_parent[sa] and self.stop_parent[sa] == self.stop_parent[sc])
                        or PLATFORM.sub("", self.stop_name[sa]) == PLATFORM.sub("", self.stop_name[sc])
                        or float(np.hypot(*(self.stop_xy[sa] - self.stop_xy[sc]))) < 250.0))
                    if same:
                        nxt[a] = c
        return nxt

    def stations(self) -> list[dict]:
        """Rail stations summary (grouped by parent station or name)."""
        groups: dict = {}
        for p in self.patterns:
            if p["mode"] not in RAIL_MODES or p["mode"] == "streetcar":
                continue
            r = self.routes[p["route"]]
            for sv in p["stops"]:
                if sv < 0:
                    continue
                parent = self.stop_parent[sv] or ""
                name = PLATFORM.sub("", self.stop_name[sv])
                key = parent or name
                g = groups.setdefault(key, dict(name=name, agency=self.key, pts=[], modes=set(), routes=set()))
                if parent and parent in self.stop_index:
                    g["name"] = PLATFORM.sub("", self.stop_name[self.stop_index[parent]])
                g["pts"].append(self.stop_xy[sv])
                g["modes"].add(r["mode"])
                g["routes"].add(r["id"])
        out = []
        for key, g in groups.items():
            pt = np.mean(np.array(g["pts"]), 0)
            out.append(dict(id=f"{self.key}:{key}", name=g["name"], agency=self.key, pos=[round(float(pt[0]), 1), round(float(pt[1]), 1)],
                            modes=sorted(g["modes"]), routes=sorted(g["routes"])))
        return out


def bus_roads_gaps_path():
    from .bus_roads import GAPS

    return GAPS


def main(argv: list[str]) -> None:
    keys = [a for a in argv if not a.startswith("-")] or list(SOURCES)
    if "--download" in argv:
        download(keys)
    keys = [k for k in keys if (GTFS / f"{k}.zip").exists()]
    OUTDIR.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    rail = RailNet()
    print(f"rail network: {len(rail.kind)} ways ({time.time()-t0:.1f}s)")
    bus_router = None
    if "--no-bus-roads" not in argv:
        rn = RoadNet()
        bus_router = BusRouter(rn)
        print(f"road net for buses: {len(rn.frm)} edges ({time.time()-t0:.0f}s)")
    router = None
    if any(k in RAIL_AGENCIES for k in keys):
        g = rail_graph.load()
        for line in g.log:
            print("  " + line)
        info = g.write()
        print("  " + g.log[-1])
        router = Router(g)
        router.out_map = g.out_map
        router.net_hash = info["hash"]
    idx_path = OUTDIR / "index.json"
    old = json.loads(idx_path.read_text()) if idx_path.exists() else {}
    agencies = {a["id"]: a for a in old.get("agencies", [])}
    routes = {r["id"]: r for r in old.get("routes", [])}
    stations = {s["id"]: s for s in old.get("stations", [])}
    for k in keys:
        print(f"== {k}")
        ag = Agency(k, rail, router if k in RAIL_AGENCIES else None, bus_router)
        ag.load()
        ag.build()
        if ag.bus_matched[0]:
            print(f"  [{k}] bus shapes on roads: {ag.bus_matched[1]}/{ag.bus_matched[0]} patterns")
        if ag.route_stats:
            bad = [r for r in ag.route_stats if not r[2]]
            print(f"  [{k}] rail routes: {len(ag.route_stats)}, broken {len(bad)} {sorted({(b[0], b[3]) for b in bad})[:20]}")
        if getattr(ag, "snap_stats", None):
            st = np.array(ag.snap_stats)
            print(f"  [{k}] rail snap: {len(st)} shapes, mean matched {st.mean():.2f}, min {st.min():.2f}")
        info = ag.write()
        agencies[k] = info
        routes = {rid: r for rid, r in routes.items() if r["agency"] != k}
        used_routes = {p["route"] for p in ag.patterns}
        for rid in used_routes:
            r = ag.routes[rid]
            routes[r["id"]] = r
        stations = {sid: s for sid, s in stations.items() if s["agency"] != k}
        for s in ag.stations():
            stations[s["id"]] = s
    order = list(SOURCES)
    index = dict(
        version=1,
        generated=time.strftime("%Y-%m-%dT%H:%M:%S"),
        modes=MODES,
        profiles=list(PROFILES),
        agencies=sorted(agencies.values(), key=lambda a: order.index(a["id"]) if a["id"] in order else 99),
        routes=sorted(routes.values(), key=lambda r: (MODES.index(r["mode"]), r["agency"], r["short"].zfill(6))),
        stations=sorted(stations.values(), key=lambda s: s["id"]),
    )
    idx_path.write_text(json.dumps(index, separators=(",", ":")))
    if bus_router is not None:
        bus_router.write_gaps()
        print(f"bus road gaps (missing roads): {len(bus_router.gaps)} -> {bus_roads_gaps_path()}")
    print(f"done in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main(sys.argv[1:])
