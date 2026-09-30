"""Deterministic street-level viewpoint set for the visual sweep (app/qa/sweep.js).

    cd pipeline && uv run python -m tpipe.qa.viewpoints [--seed 1] [--bbox E0,N0,E1,N1]

Writes app/public/data/qa/viewpoints.json. The poses are stratified by context
and seeded, so the same data and seed always give the same poses:
  motorway_along / motorway_above   one motorway/trunk sample per MW_CELL grid cell:
                                    shoulder-height view along the road + ~40 m above
  junction_signal / junction_roundabout / junction_ramp / junction_median / level_crossing
  bridge_below / bridge_deck        road bridges seen from under the deck and along it
  station                           every rail station in transit/index.json
  rail_curve                        rail graph edges with the tightest curves
  shoreline, park                   raster water edges / park land
  street_residential / street_commercial / street_industrial
  airport                           every airport in air/airports.json
Pose = orbit camera (CameraController.jumpTo): focus (e, n, h), dist, heading
(deg clockwise from north), pitch (deg below horizon); `cam` = camera E, N, z.
Tiles are read one at a time (small LRU); memory stays low.
"""

from __future__ import annotations

import argparse
import json
import math
import sys

import numpy as np

from .. import geo, tbn
from .data import F_BRIDGE, F_LINK, F_ROUNDABOUT, F_TUNNEL, S0, load_tile, manifest

OUT = geo.OUT / "qa" / "viewpoints.json"
MW_CELL = 1500.0  # m
CAP = {  # max poses per tag
    "junction_signal": 60, "junction_roundabout": 30, "junction_ramp": 50, "junction_median": 40, "level_crossing": 40,
    "bridge_below": 60, "bridge_deck": 60, "rail_curve": 60, "shoreline": 60, "park": 40,
    "street_residential": 60, "street_commercial": 60, "street_industrial": 50,
}
PER_TILE = 3  # candidates kept per tag per tile (seeded)


def _pose(tag, i, e, n, h, dist, bearing_math, pitch, note=""):
    """bearing_math: direction the camera looks, rad CCW from +E."""
    heading = (90.0 - math.degrees(bearing_math)) % 360.0
    hr, pr = math.radians(heading), math.radians(pitch)
    cam = [e - math.sin(hr) * math.cos(pr) * dist, n - math.cos(hr) * math.cos(pr) * dist, h + math.sin(pr) * dist]
    return {"id": f"{tag}-{i:04d}", "tag": tag, "e": round(e, 1), "n": round(n, 1), "h": round(h, 1), "dist": round(dist, 1),
            "heading": round(heading, 1), "pitch": round(pitch, 1), "cam": [round(c, 1) for c in cam], "note": note}


def _terrain(a, x, y):
    h = a.get("terrain_h")
    if h is None:
        return 0.0
    G = int(round(math.sqrt(len(h))))
    c = S0 / (G - 1)
    i, j = min(max(int(x / c), 0), G - 2), min(max(int(y / c), 0), G - 2)
    u, v = x / c - i, y / c - j
    g = h.reshape(G, G) / 10.0
    return float((g[j, i] * (1 - u) + g[j, i + 1] * u) * (1 - v) + (g[j + 1, i] * (1 - u) + g[j + 1, i + 1] * u) * v)


def build(seed: int = 1, bbox=None) -> dict:
    man = manifest()
    tiles = sorted(map(tuple, man["tiles"]["0"]), key=lambda t: (t[1], t[0]))
    if bbox:
        tiles = [t for t in tiles if (t[0] + 1) * S0 > bbox[0] and t[0] * S0 < bbox[2] and (t[1] + 1) * S0 > bbox[1] and t[1] * S0 < bbox[3]]
    cand: dict[str, list] = {k: [] for k in CAP}
    mw: dict = {}  # cell -> (score, candidate)
    for tx, ty in tiles:
        a = load_tile(tx, ty)
        if a is None:
            continue
        rng = np.random.default_rng([seed, tx & 0xFFFFFFFF, ty & 0xFFFFFFFF])
        ox, oy = tx * S0, ty * S0
        names = a.get("_names", [])
        g = a.get("ground")
        gat = (lambda x, y: int(g[min(255, max(0, int(y / 4))) * 256 + min(255, max(0, int(x / 4)))])) if g is not None else (lambda x, y: 0)
        roff = a.get("r_off")
        segs = []  # (x, y, bearing, cls, flags, name, osm, piece len)
        if roff is not None and len(roff) > 1:
            xyz = a["r_xyz"].reshape(-1, 3)
            for p in range(len(roff) - 1):
                v0, v1 = int(roff[p]), int(roff[p + 1])
                if v1 - v0 < 2:
                    continue
                c, f = int(a["r_class"][p]), int(a["r_flags"][p])
                if f & F_TUNNEL or c > 6:
                    continue
                k = (v0 + v1 - 1) // 2
                k = min(k, v1 - 2)
                x, y = float(xyz[k, 0]), float(xyz[k, 1])
                if not (0 <= x < S0 and 0 <= y < S0):
                    continue
                b = math.atan2(xyz[k + 1, 1] - xyz[k, 1], xyz[k + 1, 0] - xyz[k, 0])
                ni = int(a["r_name"][p]) if "r_name" in a else 0xFFFF
                nm = names[ni] if ni < len(names) else ""
                ln = float(np.sum(np.hypot(*np.diff(xyz[v0:v1, :2], axis=0).T)))
                segs.append((x, y, b, c, f, nm, float(a["r_osm"][p]), ln, float(xyz[k, 2])))
        for s in segs:
            x, y, b, c, f, nm, o, ln, z = s
            E, N = ox + x, oy + y
            if c <= 1 and not f & F_LINK:
                cell = (math.floor(E / MW_CELL), math.floor(N / MW_CELL))
                r = float(rng.random())
                if cell not in mw or r < mw[cell][0]:
                    mw[cell] = (r, (E, N, z if f & F_BRIDGE else _terrain(a, x, y), b, nm or ("motorway" if c == 0 else "trunk")))
            if f & F_BRIDGE and c <= 5 and ln > 30:
                cand["bridge_deck"].append((E, N, z, b, nm or "bridge", rng.random()))
                cand["bridge_below"].append((E, N, _terrain(a, x, y), b + math.pi / 2, nm or "bridge", rng.random()))
            if 3 <= c <= 5 and not f & (F_BRIDGE | F_LINK):
                gc = gat(x, y)
                tag = {4: "street_residential", 5: "street_commercial", 6: "street_industrial"}.get(gc)
                if tag:
                    cand[tag].append((E, N, _terrain(a, x, y), b, nm, rng.random()))
            if f & F_ROUNDABOUT:
                cand["junction_roundabout"].append((E, N, _terrain(a, x, y), b, nm or "roundabout", rng.random()))
        # junctions
        jxy = a.get("j_xy")
        if jxy is not None and len(jxy):
            p = jxy.reshape(-1, 2)
            ao = a["j_arm_off"]
            lxy = a.get("l_xyz")
            lcl = a.get("l_class")
            lr = None
            if lxy is not None and len(lxy):
                L = lxy.reshape(-1, 3)
                lo = a["l_off"]
                lr = L[:, :2][np.isin(np.repeat(np.arange(len(lo) - 1), np.diff(lo.astype(np.int64))), np.nonzero(lcl == 3)[0])]
            for q in range(len(p)):
                x, y = float(p[q, 0]), float(p[q, 1])
                if not (0 <= x < S0 and 0 <= y < S0):
                    continue
                arms = range(int(ao[q]), int(ao[q + 1]))
                b = float(a["j_arm_ang"][ao[q]]) if len(arms) else 0.0
                E, N, h = ox + x, oy + y, _terrain(a, x, y)
                item = (E, N, h, b + math.pi, f"junction {int(a['j_osm'][q])}", rng.random())
                if a["j_flags"][q] & 1:
                    cand["junction_signal"].append(item)
                if lr is not None and len(lr) and np.min(np.hypot(lr[:, 0] - x, lr[:, 1] - y)) < 30:
                    cand["junction_median"].append(item)
                elif len(arms) >= 5:
                    cand["junction_median"].append(item)
        # ramps: junction-free link ends near motorways -> use link midpoints
        links = [s for s in segs if s[4] & F_LINK]
        for s in links[:PER_TILE]:
            cand["junction_ramp"].append((ox + s[0], oy + s[1], s[8], s[2], s[5] or "ramp", rng.random()))
        # level crossings: road vertex == rail vertex
        if roff is not None and lxy is not None and len(lxy) and len(roff) > 1:
            R = a["r_xyz"].reshape(-1, 3)[:, :2]
            L = lxy.reshape(-1, 3)[:, :2]
            rk = {(round(float(u), 1), round(float(v), 1)) for u, v in R}
            for u, v in L:
                if (round(float(u), 1), round(float(v), 1)) in rk and 0 <= u < S0 and 0 <= v < S0:
                    cand["level_crossing"].append((ox + float(u), oy + float(v), _terrain(a, u, v), 0.3, "level crossing", rng.random()))
                    break
        # ground: shoreline + park
        if g is not None and len(g) == 65536:
            G2 = g.reshape(256, 256)
            w = G2 == 1
            edge = np.nonzero(w[:, 1:] != w[:, :-1])
            if len(edge[0]):
                k = int(rng.integers(len(edge[0])))
                j, i = edge[0][k], edge[1][k]
                x, y = (i + 1) * 4.0, (j + 0.5) * 4.0
                cand["shoreline"].append((ox + x, oy + y, max(_terrain(a, x, y), 0.0), 0.0 if w[j, i + 1] else math.pi, "shore", rng.random()))
            pk = np.nonzero(G2 == 2)
            if len(pk[0]) > 400:
                k = int(rng.integers(len(pk[0])))
                x, y = (pk[1][k] + 0.5) * 4, (pk[0][k] + 0.5) * 4
                cand["park"].append((ox + x, oy + y, _terrain(a, x, y), float(rng.random() * 2 * math.pi), "park", rng.random()))
        # keep candidate lists bounded: per tile, the lowest random keys win later anyway
        for k in cand:
            if len(cand[k]) > 4000:
                cand[k] = sorted(cand[k], key=lambda t: t[-1])[:2000]
    poses = []
    # motorways
    for i, cell in enumerate(sorted(mw)):
        E, N, h, b, nm = mw[cell][1]
        poses.append(_pose("motorway_along", i, E + math.cos(b) * 25, N + math.sin(b) * 25, h, 30.0, b, 10.0, nm))
        poses.append(_pose("motorway_above", i, E, N, h, 60.0, b + 0.6, 42.0, nm))
    view = {  # tag -> (dist, pitch, look offset)
        "junction_signal": (45, 30), "junction_roundabout": (70, 35), "junction_ramp": (60, 30), "junction_median": (50, 30),
        "level_crossing": (45, 25), "bridge_below": (35, 4), "bridge_deck": (35, 10), "rail_curve": (70, 30),
        "shoreline": (70, 20), "park": (40, 15), "street_residential": (30, 10), "street_commercial": (30, 10),
        "street_industrial": (35, 12),
    }
    # rail curves from the graph
    net = geo.OUT / "rail" / "network.bin.gz"
    if net.exists():
        r, _ = tbn.read(net)
        off = r["e_off"].astype(np.int64)
        P = r["e_xyz"].reshape(-1, 3)
        rng = np.random.default_rng([seed, 7])
        for e in range(len(off) - 1):
            Q = P[off[e]:off[e + 1]]
            if len(Q) < 3 or r["e_flags"][e] & 2:
                continue
            ang = np.arctan2(np.diff(Q[:, 1]), np.diff(Q[:, 0]))
            turn = abs((ang[-1] - ang[0] + math.pi) % (2 * math.pi) - math.pi)
            ln = float(r["e_len"][e])
            if turn > math.radians(20) and ln > 50:
                m = Q[len(Q) // 2]
                if bbox and not (bbox[0] <= m[0] < bbox[2] and bbox[1] <= m[1] < bbox[3]):
                    continue
                cand["rail_curve"].append((float(m[0]), float(m[1]), float(m[2]), float(ang[len(ang) // 2]) + math.pi / 2,
                                           f"rail edge {e}", float(rng.random())))
    for tag, lst in sorted(cand.items()):
        lst = sorted(lst, key=lambda t: t[-1])[:CAP[tag]]
        d, p = view[tag]
        for i, (E, N, h, b, nm, _) in enumerate(lst):
            poses.append(_pose(tag, i, E, N, h, d, b, p, nm))
    # stations + airports: all
    idx = json.loads((geo.OUT / "transit" / "index.json").read_text()) if (geo.OUT / "transit" / "index.json").exists() else {}
    for i, s in enumerate(sorted(idx.get("stations", []), key=lambda s: s["id"])):
        E, N = s["pos"]
        if bbox and not (bbox[0] <= E < bbox[2] and bbox[1] <= N < bbox[3]):
            continue
        poses.append(_pose("station", i, E, N, _ground_at(E, N), 120.0, math.radians(30), 35.0, s["name"]))
    ap = geo.OUT / "air" / "airports.json"
    if ap.exists():
        for i, A in enumerate(json.loads(ap.read_text()).get("airports", [])):
            E, N, h = A["pos"]
            if bbox and not (bbox[0] <= E < bbox[2] and bbox[1] <= N < bbox[3]):
                continue
            poses.append(_pose("airport", i, E, N, h, 900.0, math.radians(20), 30.0, A["name"]))
    return {"version": 1, "seed": seed, "build": man.get("build"), "bbox": bbox, "viewpoints": poses}


def _ground_at(E, N):
    tx, ty = math.floor(E / S0), math.floor(N / S0)
    a = load_tile(tx, ty)
    return _terrain(a, E - tx * S0, N - ty * S0) if a is not None else 0.0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="tpipe.qa.viewpoints")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--bbox", default="")
    ap.add_argument("--out", default=str(OUT))
    a = ap.parse_args(argv)
    bbox = tuple(float(v) for v in a.bbox.split(",")) if a.bbox else None
    d = build(a.seed, bbox)
    out = geo.Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(d, separators=(",", ":")))
    tags: dict = {}
    for p in d["viewpoints"]:
        tags[p["tag"]] = tags.get(p["tag"], 0) + 1
    print(json.dumps(tags))
    print(f"{len(d['viewpoints'])} viewpoints -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
