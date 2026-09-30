"""Validate rail pattern geometry against the OSM track network.

    cd pipeline && uv run python -m tpipe.transit_validate [agency ...] [--profile weekday] [--strict]

For every rail shape in app/public/data/transit/{agency}_{profile}_rail.bin.gz the
polyline is sampled every 2 m and each sample is measured against the nearest OSM
track of a class compatible with the pattern mode. A sample farther than TOL from
any track means the shape leaves the rails there — either a sideways jump between
parallel tracks (the chord between two vertices on different tracks) or a stretch
where matching fell back to GTFS points. Reported per route:

  len      shape km (unique shapes of the route)
  off%     share of the length farther than TOL from track
  jumps    off-track runs that leave the track steeply (slope > JUMP_SLOPE = a
           sideways hop between tracks)
  blends   gentle off-track runs < 300 m (S-curves bridging OSM topology gaps)
  maxdev   worst deviation (m)
  wrongdir for tram ways (mapped one way per direction): share of length run
           against the way's drawing direction (≈ left-hand running)

--strict exits non-zero if any shape has a jump.
"""

from __future__ import annotations

import sys
from collections import defaultdict

import numpy as np
from scipy.spatial import cKDTree

from . import tbn
from .transit_rail import MODE_KINDS, RailNet, densify_xy

OUT = __import__("pathlib").Path(__import__("os").environ.get("TRANSIT_OUT") or __import__("pathlib").Path(__file__).resolve().parents[2] / "app/public/data/transit")
MODES = ["subway", "lrt", "streetcar", "commuter_rail", "airport_rail", "intercity_rail", "bus"]
TOL = 0.5
SAMPLE = 2.0
JUMP_SLOPE = 0.25  # d(deviation)/d(distance) above which leaving the track is a sideways hop
VERBOSE = "-v" in sys.argv


class TrackIndex:
    """Nearest compatible track segment for points (per kinds set)."""

    def __init__(self, net: RailNet, kinds: set) -> None:
        a = net.seg_a
        ok = np.isin(net.kind[net.vway[a]], sorted(kinds)) & (net.seglen > 0.01)
        self.a = a[ok]
        self.kind = net.kind[net.vway[self.a]]
        self.A = net.xy[self.a]
        self.B = net.xy[self.a + 1]
        self.dir = net.sdir[ok]
        pts, own = [], []
        for i, (p, q, L) in enumerate(zip(self.A, self.B, net.seglen[ok])):
            k = max(1, int(np.ceil(L / 5.0)))
            t = (np.arange(k) + 0.5) / k
            pts.append(p + (q - p) * t[:, None])
            own.append(np.full(k, i))
        self.own = np.concatenate(own)
        self.tree = cKDTree(np.vstack(pts))

    def nearest(self, p: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """(distance, segment index) per point."""
        hits = self.tree.query_ball_point(p, 10.0)
        d = np.full(len(p), np.inf)
        s = np.full(len(p), -1)
        for i, h in enumerate(hits):
            if not h:
                continue
            segs = np.unique(self.own[h])
            A, AB = self.A[segs], self.B[segs] - self.A[segs]
            t = np.clip(((p[i] - A) * AB).sum(1) / np.maximum((AB**2).sum(1), 1e-9), 0, 1)
            dd = np.hypot(*(A + AB * t[:, None] - p[i]).T)
            j = int(np.argmin(dd))
            d[i], s[i] = dd[j], segs[j]
        return d, s


def validate(agencies: list[str], profile: str, strict: bool) -> int:
    net = RailNet()
    idx: dict[frozenset, TrackIndex] = {}
    bad = 0
    print(f"{'route':<22}{'mode':<15}{'len km':>8}{'off%':>7}{'jumps':>7}{'blends':>7}{'maxdev':>8}{'wrongdir':>9}")
    for ag in agencies:
        f = OUT / f"{ag}_{profile}_rail.bin.gz"
        if not f.exists():
            continue
        arr, hdr = tbn.read(f)
        off, xyz = arr["shape_off"], arr["shape_xyz"].reshape(-1, 3)
        routes = hdr["routes"]
        seen = set()
        stats = defaultdict(lambda: [0.0, 0.0, 0, 0.0, 0.0, 0.0, 0])  # len, off, jumps, maxdev, tram len, wrong len, blends
        for p in range(len(arr["pat_shape"])):
            g = int(arr["pat_shape"][p])
            mode = MODES[int(arr["pat_mode"][p])]
            if mode == "bus" or g in seen:
                continue
            seen.add(g)
            kinds = frozenset(MODE_KINDS[mode])
            ti = idx.get(kinds) or idx.setdefault(kinds, TrackIndex(net, kinds))
            xy = xyz[off[g] : off[g + 1], :2].astype(np.float64)
            if len(xy) < 2:
                continue
            pts, seg = densify_xy(xy, SAMPLE)
            d, s = ti.nearest(pts)
            step = np.hypot(*np.diff(pts, axis=0).T)
            w = np.concatenate([[0.0], step])
            offm = d > TOL
            # off-track runs: a *jump* leaves the track steeply (> JUMP_SLOPE, i.e. a
            # sideways hop), a *blend* is a gentle S-curve across a topology gap
            dd = np.where(np.isfinite(d), d, 50.0)
            slope = np.abs(np.diff(dd)) / np.maximum(step, 1e-6)
            runs, start = [], None
            for i, o in enumerate(list(offm) + [False]):
                if o and start is None:
                    start = i
                if not o and start is not None:
                    a0, a1 = max(start - 1, 0), min(i, len(slope))
                    steep = float(slope[a0:a1].max()) if a1 > a0 else 0.0
                    runs.append((w[start:i].sum(), steep))
                    if VERBOSE and steep > JUMP_SLOPE:
                        print(f"    jump {mode} shape {g} at E {pts[start, 0]:.0f} N {pts[start, 1]:.0f} len {runs[-1][0]:.0f} m dev {dd[start:i].max():.1f}")
                    start = None
            key = routes[int(arr["pat_route"][p])]["short"] or routes[int(arr["pat_route"][p])]["id"]
            st = stats[(key, mode)]
            st[0] += w.sum()
            st[1] += w[offm].sum()
            nj = sum(1 for L, sl in runs if sl > JUMP_SLOPE)
            st[2] += nj
            st[6] += sum(1 for L, sl in runs if sl <= JUMP_SLOPE and L < 300.0)
            finite = d[np.isfinite(d)]
            st[3] = max(st[3], float(finite.max()) if len(finite) else 99.0, 99.0 if not np.isfinite(d).all() else 0.0)
            # direction on tram ways
            tan = np.gradient(pts, axis=0)
            tan /= np.maximum(np.hypot(*tan.T), 1e-9)[:, None]
            on = (s >= 0) & ~offm
            tram = on & (ti.kind[np.maximum(s, 0)] == 3)
            dot = (ti.dir[np.maximum(s, 0)] * tan).sum(1)
            st[4] += w[tram].sum()
            st[5] += w[tram & (dot < -0.5)].sum()
            if nj:
                bad += 1
        for (key, mode), (L, o, j, md, tl, wl, bl) in sorted(stats.items(), key=lambda kv: (MODES.index(kv[0][1]), kv[0][0])):
            wd = f"{100 * wl / tl:8.1f}%" if tl > 0 else "        -"
            print(f"{ag + ':' + key:<22}{mode:<15}{L / 1000:8.1f}{100 * o / max(L, 1):6.1f}%{j:7d}{bl:7d}{md:8.1f}{wd}")
    print(f"shapes with lateral jumps: {bad}")
    return 1 if (strict and bad) else 0


def main(argv: list[str]) -> None:
    profile = "weekday"
    if "--profile" in argv:
        profile = argv[argv.index("--profile") + 1]
    ags = [a for a in argv if not a.startswith("-") and a != profile] or ["ttc", "go", "up", "via"]
    sys.exit(validate(ags, profile, "--strict" in argv))


if __name__ == "__main__":
    main(sys.argv[1:])
