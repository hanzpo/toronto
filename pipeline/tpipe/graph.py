"""Drivable road graph, tiled for the local traffic simulation.

Ways are split at every OSM node shared by two or more drivable ways
(intersections) and at their ends, giving edges between graph nodes. Each
edge is stored in the level-0 tile containing its midpoint; each tile carries
the nodes its edges reference (duplicated across tiles and unified by OSM id
on the client).

    uv run python -m tpipe.graph
Output: data/graph/{tx}_{ty}.bin.gz (TBN1, see docs/SPEC.md "Road graph").
"""

from __future__ import annotations

import time

import numpy as np

from . import geo, tbn

S0 = geo.TILE_SIZE[0]
DRIVABLE_MAX_CLASS = 6          # motorway .. service
DEFAULT_KMH = np.array([100, 80, 60, 50, 50, 40, 20], dtype=np.float32)
STEP = 12.0                     # geometry densification for smooth driving


def _offsets(counts):
    off = np.zeros(len(counts) + 1, dtype=np.int64)
    np.cumsum(counts, out=off[1:])
    return off


def main() -> None:
    """Edges follow the shared network model (tpipe.roadnet, work/roadnet.npz):
    the same smoothed centrelines, solved bridge / ramp / grade-separation
    elevations and sanity-checked lane counts the render tiles draw."""
    t0 = time.time()
    with np.load(geo.WORK / "osm_lines.npz", allow_pickle=True) as f:
        d = {k: f[k] for k in ("kind", "cls", "id", "speed", "name", "side", "nid", "xy")}
    # true OSM node positions: edges start / end exactly on their graph node (ramps pushed
    # beside the mainline for rendering still join the mainline node)
    nuq, nfirst = np.unique(d["nid"], return_index=True)
    nxy_all = d["xy"][nfirst]
    del d["xy"], d["nid"]
    with np.load(geo.WORK / "roadnet.npz", allow_pickle=True) as f:
        W = {k: f[k] for k in f.files if k.startswith("way_")}
    order_id = np.argsort(d["id"])
    sorted_id = d["id"][order_id]
    wid = W["way_id"]
    pos = np.searchsorted(sorted_id, wid)
    pos = np.clip(pos, 0, len(sorted_id) - 1)
    row = order_id[pos]
    ok = (sorted_id[pos] == wid) & (d["kind"][row] == 0) & (d["cls"][row] <= DRIVABLE_MAX_CLASS) \
        & ((W["way_flags"] & 32) == 0)
    ways = np.nonzero(ok)[0]
    print(f"{len(ways):,} drivable ways from the network model", flush=True)
    woff, wxyz, ws = W["way_off"], W["way_xyz"], W["way_s"]
    noff, nnode, nns = W["way_node_off"], W["way_node"], W["way_node_s"]
    # graph nodes: nodes used more than once by drivable ways, and way ends
    alln = np.concatenate([nnode[noff[w]:noff[w + 1]] for w in ways])
    uniq, cnt = np.unique(alln, return_counts=True)
    multi = set(uniq[cnt > 1].tolist())
    E_geo, E_way, E_from, E_to, E_len = [], [], [], [], []
    for w in ways:
        P = wxyz[woff[w]:woff[w + 1]]
        s = ws[woff[w]:woff[w + 1]]
        nodes = nnode[noff[w]:noff[w + 1]]
        ns = nns[noff[w]:noff[w + 1]].copy()
        if len(P) < 2 or len(nodes) < 2:
            continue
        ns[0], ns[-1] = 0.0, s[-1]
        bad = ~np.isfinite(ns) | (np.diff(np.concatenate([[0.0], ns])) < -0.5)
        if bad.any():  # fall back to proportional positions
            ns = np.linspace(0.0, s[-1], len(nodes))
        ns = np.maximum.accumulate(np.clip(ns, 0, s[-1]))
        cut = [k for k in range(len(nodes)) if k == 0 or k == len(nodes) - 1 or int(nodes[k]) in multi]
        for a, b in zip(cut[:-1], cut[1:]):
            sa, sb = ns[a], ns[b]
            if sb - sa < 0.3:
                continue
            inner = (s > sa + 1e-6) & (s < sb - 1e-6)
            S = np.concatenate([[sa], s[inner], [sb]])
            # densify for smooth driving
            seg = np.diff(S)
            k = np.maximum(1, np.ceil(seg / STEP).astype(np.int64))
            S2 = np.concatenate([[S[0]]] + [S[i] + seg[i] * np.arange(1, k[i] + 1) / k[i] for i in range(len(seg))])
            G = np.column_stack([np.interp(S2, s, P[:, c]) for c in range(3)])
            for end, nd in ((0, nodes[a]), (-1, nodes[b])):
                q = np.searchsorted(nuq, nd)
                if q < len(nuq) and nuq[q] == nd and np.hypot(*(nxy_all[q] - G[end, :2])) < 12.0:
                    G[end, :2] = nxy_all[q]
            E_geo.append(G)
            E_way.append(w)
            E_from.append(int(nodes[a]))
            E_to.append(int(nodes[b]))
            E_len.append(float(np.hypot(*np.diff(G[:, :2], axis=0).T).sum()))
    print(f"{len(E_geo):,} edges ({time.time() - t0:.0f}s)", flush=True)
    ne = len(E_geo)
    E_way = np.array(E_way, np.int64)
    r = row[E_way]
    c = d["cls"][r].astype(np.int64)
    flags = (W["way_flags"][E_way] & 31).astype(np.int64)
    fwd = W["way_nF"][E_way].astype(np.int64)
    bwd = W["way_nB"][E_way].astype(np.int64)
    oneway = (flags & 1) != 0
    fwd = np.maximum(1, fwd)
    bwd = np.where(oneway, 0, np.maximum(bwd, 0))
    sp = d["speed"][r]
    kmh = np.where((sp > 5) & (sp < 140), sp, DEFAULT_KMH[np.minimum(c, 6)])
    with np.load(geo.WORK / "osm_nodes.npz") as f:
        nk, nid_ = f["kind"], f["id"]
    sig_ids = set(nid_[nk == 0].tolist())
    stp_ids = set(nid_[nk == 1].tolist())
    mid = np.array([g[len(g) // 2, :2] for g in E_geo]) if ne else np.zeros((0, 2))
    tx = np.floor(mid[:, 0] / S0).astype(np.int64)
    ty = np.floor(mid[:, 1] / S0).astype(np.int64)
    order = np.lexsort((ty, tx))
    key = np.stack([tx[order], ty[order]], 1)
    brk = np.nonzero(np.any(np.diff(key, axis=0) != 0, axis=1))[0] + 1
    names = d["name"]
    d_id = d["id"]
    d_side = d["side"]
    out = geo.OUT / "graph"
    total = 0
    ntiles = 0
    for chunk in np.split(order, brk):
        if not len(chunk):
            continue
        X, Y = int(tx[chunk[0]]), int(ty[chunk[0]])
        x0, y0 = X * S0, Y * S0
        E = np.sort(chunk)
        lookup: dict[int, int] = {}
        n_id, n_xyz, n_fl = [], [], []

        def node(nid, p):
            k = lookup.get(nid)
            if k is None:
                k = lookup[nid] = len(n_id)
                n_id.append(float(nid))
                n_xyz.append(p)
                n_fl.append((1 if nid in sig_ids else 0) | (2 if nid in stp_ids else 0))
            return k
        e_from = np.array([node(E_from[e], E_geo[e][0]) for e in E], np.uint32)
        e_to = np.array([node(E_to[e], E_geo[e][-1]) for e in E], np.uint32)
        cnts = np.array([len(E_geo[e]) for e in E], np.int64)
        G = np.vstack([E_geo[e] for e in E])
        name_list: list[str] = []
        name_idx: dict[str, int] = {}
        eni = np.full(len(E), 0xFFFF, dtype=np.uint16)
        for j, e in enumerate(E):
            nm = names[r[e]]
            if nm:
                if nm not in name_idx:
                    name_idx[nm] = len(name_list)
                    name_list.append(nm)
                eni[j] = name_idx[nm]
        NX = np.array(n_xyz)
        arrays = {
            "n_id": np.array(n_id, np.float64),
            "n_xyz": np.column_stack([NX[:, 0] - x0, NX[:, 1] - y0, NX[:, 2]]).astype(np.float32).ravel(),
            "n_flags": np.array(n_fl, np.uint8),
            "e_from": e_from,
            "e_to": e_to,
            "e_off": _offsets(cnts).astype(np.uint32),
            "e_xyz": np.column_stack([G[:, 0] - x0, G[:, 1] - y0, G[:, 2]]).astype(np.float32).ravel(),
            "e_len": np.array([E_len[e] for e in E], np.float32),
            "e_class": c[E].astype(np.uint8),
            "e_lanes_fwd": fwd[E].astype(np.uint8),
            "e_lanes_bwd": bwd[E].astype(np.uint8),
            "e_speed": (kmh[E] / 3.6).astype(np.float32),
            "e_osm": d_id[r[E]].astype(np.float64),
            "e_name": eni,
            "e_flags": flags[E].astype(np.uint8),
            # pavement width as drawn by the render tiles (r_pl + r_pr), OSM sidewalk code (r_side)
            "e_width": W["way_width"][E_way[E]].astype(np.float32),
            "e_side": d_side[r[E]].astype(np.uint8),
        }
        total += tbn.write(out / f"{X}_{Y}.bin.gz", arrays, tx=X, ty=Y, names=name_list)
        ntiles += 1
    print(f"wrote {ntiles:,} graph tiles, {total / 1e6:.0f} MB in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
