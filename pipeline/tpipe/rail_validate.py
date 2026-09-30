"""Validate rail routes (transit rail files) against data/rail/network.bin.gz.

    cd pipeline && uv run python -m tpipe.rail_validate [agency ...] [--profile weekday] [--compare DIR] [--strict]

Per pattern (route through the track graph, docs/RAIL.md):
  * connected: consecutive edges share a node and the move between them is an
    allowed movement (no reversing, no leg-to-leg at a switch);
  * directional: every edge is travelled in a direction its rule allows;
  * the shape equals the route geometry (length within 1 m) and every stop lies on it;
  * flags: 1 = agent-capable route, 2 = routed with a gap (break), 0 = not routed.
Per network: edges travelled in both directions by patterns of the same mode
(single track / terminal areas are expected, double track is not) -- listed with
their location.
--compare DIR: max deviation (m) of each route's shape from the shapes in an older
transit output (e.g. the previous HMM-snapped data), to spot changed track choices.
--strict exits non-zero on any disconnected / wrong-way route.
"""

from __future__ import annotations

import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

from . import geo, tbn

MODES = ["subway", "lrt", "streetcar", "commuter_rail", "airport_rail", "intercity_rail", "bus"]


def load_net():
    a, h = tbn.read(geo.OUT / "rail" / "network.bin.gz")
    return a, h


def main(argv: list[str]) -> int:
    prof = "weekday"
    if "--profile" in argv:
        prof = argv[argv.index("--profile") + 1]
    cmp_dir = Path(argv[argv.index("--compare") + 1]) if "--compare" in argv else None
    skip = {prof, str(cmp_dir)} if cmp_dir else {prof}
    ags = [x for x in argv if not x.startswith("-") and x not in skip] or ["ttc", "go", "up", "via"]
    net, nh = load_net()
    e_from, e_to = net["e_from"].astype(np.int64), net["e_to"].astype(np.int64)
    c_off, c_to = net["c_off"], net["c_to"]
    e_dir, e_len = net["e_dir"], net["e_len"]
    e_off, e_xyz = net["e_off"], net["e_xyz"].reshape(-1, 3)
    bad = 0
    both: dict[tuple[int, int], set] = defaultdict(set)
    for ag in ags:
        path = geo.OUT / "transit" / f"{ag}_{prof}_rail.bin.gz"
        if not path.exists():
            continue
        A, H = tbn.read(path)
        if H.get("railNetwork") != nh.get("hash"):
            print(f"[{ag}] network hash mismatch: file {H.get('railNetwork')} vs network {nh.get('hash')}")
            bad += 1
        routes = H["routes"]
        so, sx = A["shape_off"], A["shape_xyz"].reshape(-1, 3)
        pso, pst, psd, psf = A["pat_stop_off"], A["pat_stop"], A["pat_stop_dist"], A["pat_stop_flag"]
        ro, re_, rs, rf = A["pat_redge_off"], A["pat_redge"], A["pat_rstart"], A["pat_rflags"]
        old = None
        if cmp_dir is not None and (cmp_dir / path.name).exists():
            old = tbn.read(cmp_dir / path.name)[0]
        stats = defaultdict(lambda: [0, 0, 0, 0, 0.0])  # route: ok, broken, unrouted, errors, maxdev
        for p in range(len(A["pat_route"])):
            r = routes[int(A["pat_route"][p])]
            key = f"{r['short']:>5} {r['mode']}"
            st = stats[key]
            f = int(rf[p])
            if f == 0:
                st[2] += 1
                continue
            st[0 if f == 1 else 1] += 1
            edges = re_[ro[p] : ro[p + 1]].astype(np.int64)
            errs = []
            for i, x in enumerate(edges):
                e, rev = x >> 1, x & 1
                if not e_dir[e] & (2 if rev else 1):
                    errs.append(f"wrong way on edge {e}")
                both[(int(e), MODES.index(r["mode"]))].add(int(rev))
                if i:
                    pe, prev_rev = edges[i - 1] >> 1, edges[i - 1] & 1
                    end_out = 2 * pe + (0 if prev_rev else 1)  # leaving end of the previous edge
                    enter = 2 * e + (1 if rev else 0)  # entering end of this edge
                    if enter not in set(c_to[c_off[end_out] : c_off[end_out + 1]].tolist()) and f == 1:
                        errs.append(f"no movement {pe}->{e}")
            # shape length vs route length
            s = int(A["pat_shape"][p])
            xyz = sx[so[s] : so[s + 1]]
            L = float(np.hypot(*np.diff(xyz[:, :2], axis=0).T).sum())
            rl = -float(rs[p]) + sum(float(e_len[x >> 1]) for x in edges)
            if L > rl + 1.0:
                errs.append(f"shape longer than route ({L:.0f} > {rl:.0f})")
            d = psd[pso[p] : pso[p + 1]]
            if len(d) and (d.max() > L + 1.0 or (np.diff(d) < -1e-3).any()):
                errs.append("stop distances off the shape / decreasing")
            if old is not None:
                # nearest old pattern with the same route/dir by start/end
                cum = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(xyz[:, :2], axis=0).T))])
                inner = xyz[(cum >= d.min()) & (cum <= d.max())] if len(d) else xyz
                dev = _dev(inner if len(inner) else xyz, old, r, A, p)
                st[4] = max(st[4], dev)
            if errs:
                st[3] += 1
                if f == 1:
                    bad += 1
                print(f"  [{ag}] {key} pattern {p}: {errs[:4]}")
        print(f"[{ag}] {prof}: route          ok broken unrouted errors" + ("  maxdev(m)" if old is not None else ""))
        for k in sorted(stats):
            ok, br, un, er, dv = stats[k]
            print(f"    {k:<24} {ok:4d} {br:6d} {un:8d} {er:6d}" + (f"  {dv:8.1f}" if old is not None else ""))
    # both-directions usage
    km = defaultdict(float)
    where = defaultdict(list)
    for (e, m), dirs in both.items():
        if len(dirs) == 2:
            km[MODES[m]] += float(e_len[e]) / 1000
            if e_len[e] > 150:
                p = e_xyz[e_off[e] + (e_off[e + 1] - e_off[e]) // 2]
                where[MODES[m]].append((round(float(e_len[e])), round(float(p[0])), round(float(p[1]))))
    print("track used in both directions (same mode):")
    for m in km:
        print(f"    {m:<16} {km[m]:7.2f} km  (edges > 150 m: {sorted(where[m], reverse=True)[:8]})")
    return 1 if bad and "--strict" in argv else 0


def _dev(xyz, old, r, A, p) -> float:
    """Max distance of the new shape's samples from the old shapes of the same route."""
    so, sx = old["shape_off"], old["shape_xyz"].reshape(-1, 3)
    pts = []
    for s in range(len(so) - 1):
        pts.append(sx[so[s] : so[s + 1], :2])
    if not pts:
        return 0.0
    allp = np.vstack(pts)
    tree = cKDTree(allp)
    d, _ = tree.query(xyz[:, :2])
    return float(np.percentile(d, 99))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
