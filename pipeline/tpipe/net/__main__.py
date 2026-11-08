"""Map an area onto network primitives and export engine tiles.

    uv run python -m tpipe.net --bbox=-2000,-1500,1000,1000 --name downtown
    uv run python -m tpipe.net --region

Output: $TPIPE_OUT/net/{tx}_{ty}.json.gz per level-0 tile: the network description the engine
builds (app/src/net/core/desc.ts) for the nodes and segments the tile owns, with the context it
needs (every leg of an owned node), the assets they use and the bare-earth terrain."""

from __future__ import annotations

import argparse
import base64
import gzip
import json
import math
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

from .. import geo
from . import model, osm, vertical
from .dtm import Dtm

S = geo.TILE_SIZE[0]
MARGIN = 48.0
CELL = 2.0


def simplify(pts: list[tuple[float, float]], tol: float = 0.4) -> list[tuple[float, float]]:
    from shapely.geometry import LineString

    if len(pts) <= 2:
        return pts
    return list(LineString(pts).simplify(tol, preserve_topology=False).coords)  # type: ignore[arg-type]


def seg_json(e: model.Edge) -> dict[str, object]:
    inner = simplify(e.pts)[1:-1]
    d: dict[str, object] = {"id": e.id, "asset": e.asset, "a": e.a, "b": e.b, "pts": [{"x": round(x, 2), "y": round(y, 2)} for x, y in inner]}
    if e.z:
        d["z"] = [{"s": round(s, 4), "z": z} for s, z in e.z]
    if e.off_a:
        d["offA"] = round(e.off_a, 2)
    if e.off_b:
        d["offB"] = round(e.off_b, 2)
    v = []
    if vertical._flag(e, "bridge"):
        v.append({"s0": 0, "s1": 1, "kind": "bridge"})
    if vertical._flag(e, "tunnel"):
        v.append({"s0": 0, "s1": 1, "kind": "tunnel"})
    if v:
        d["variant"] = v
    if e.fam in ("rail",):
        d["dir"] = "both"
    if e.tags.get("name"):
        d["name"] = e.tags["name"]
    return d


def node_json(n: model.Node) -> dict[str, object]:
    d: dict[str, object] = {"id": n.id, "x": round(n.x, 2), "y": round(n.y, 2), "z": n.z}
    if n.control != "auto":
        d["control"] = n.control
    if n.tram:
        d["tram"] = [list(m) for m in n.tram]
    return d


def terrain_json(dtm: Dtm, tx: int, ty: int) -> dict[str, object]:
    x0, y0 = tx * S - MARGIN, ty * S - MARGIN
    n = int(round((S + 2 * MARGIN) / CELL)) + 1
    t = np.arange(n) * CELL
    gx, gy = np.meshgrid(x0 + t, y0 + t)
    h = dtm.sample(gx, gy).reshape(n, n)
    base = float(math.floor(np.nanmin(h)))
    cm = np.clip(np.round((h - base) * 100), 0, 65535).astype(np.uint16)
    return {"x0": x0, "y0": y0, "cell": CELL, "nx": n, "ny": n, "base": base, "cm": base64.b64encode(cm.tobytes()).decode()}


def export(net: model.Network, dtm: Dtm, out: Path, tiles: set[tuple[int, int]] | None) -> int:
    out.mkdir(parents=True, exist_ok=True)
    by_node: dict[str, list[model.Edge]] = defaultdict(list)
    for e in net.edges:
        by_node[e.a].append(e)
        by_node[e.b].append(e)
    own_nodes: dict[tuple[int, int], list[str]] = defaultdict(list)
    own_segs: dict[tuple[int, int], list[model.Edge]] = defaultdict(list)
    for n in net.nodes.values():
        own_nodes[(math.floor(n.x / S), math.floor(n.y / S))].append(n.id)
    for e in net.edges:
        m = e.pts[len(e.pts) // 2]
        if len(e.pts) == 2:
            m = ((e.pts[0][0] + e.pts[1][0]) / 2, (e.pts[0][1] + e.pts[1][1]) / 2)
        own_segs[(math.floor(m[0] / S), math.floor(m[1] / S))].append(e)
    keys = set(own_nodes) | set(own_segs)
    if tiles is not None:
        keys &= tiles
    index = []
    for key in sorted(keys):
        segs = own_segs.get(key, [])
        node_ids = set(own_nodes.get(key, [])) | {e.a for e in segs} | {e.b for e in segs}
        ctx_segs = {e.id: e for n in node_ids for e in by_node[n]}
        for e in segs:
            ctx_segs[e.id] = e
        all_nodes = set(node_ids) | {e.a for e in ctx_segs.values()} | {e.b for e in ctx_segs.values()}
        used = {e.asset for e in ctx_segs.values()}
        desc = {
            "tile": list(key),
            "own": {"segs": [e.id for e in segs], "nodes": sorted(own_nodes.get(key, []))},
            "nodes": [node_json(net.nodes[n]) for n in sorted(all_nodes)],
            "segments": [seg_json(e) for e in ctx_segs.values()],
            "assets": [net.assets.assets[a] for a in sorted(used)],
            "terrain": terrain_json(dtm, *key),
        }
        with gzip.open(out / f"{key[0]}_{key[1]}.json.gz", "wt", compresslevel=6) as f:
            json.dump(desc, f, separators=(",", ":"))
        index.append({"tile": list(key), "segs": len(segs)})
    (out / "index.json").write_text(json.dumps({"tiles": index, "size": S}))
    return len(index)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", type=str, default=None)
    ap.add_argument("--name", type=str, default="area")
    ap.add_argument("--region", action="store_true")
    ap.add_argument("--out", type=str, default=str(geo.OUT / "net"))
    args = ap.parse_args()
    t0 = time.time()
    bbox = tuple(float(v) for v in args.bbox.split(",")) if args.bbox else None
    pad = 400.0
    read_box = (bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad) if bbox else None
    src = osm.extract(read_box, geo.WORK / "net" / f"{args.name}.osm.pbf")  # type: ignore[arg-type]
    data = osm.read(src)
    print(f"read {len(data.ways)} ways in {time.time() - t0:.1f}s", flush=True)
    net = model.build(data)
    print(f"network: {len(net.edges)} segments, {len(net.nodes)} nodes, {len(net.assets.assets)} assets ({time.time() - t0:.1f}s)", flush=True)
    dtm = Dtm()
    vertical.solve(net, dtm)
    print(f"profiles solved ({time.time() - t0:.1f}s)", flush=True)
    tiles = None
    if bbox:
        tiles = {(tx, ty) for tx in range(math.floor(bbox[0] / S), math.floor(bbox[2] / S) + 1) for ty in range(math.floor(bbox[1] / S), math.floor(bbox[3] / S) + 1)}
    n = export(net, dtm, Path(args.out), tiles)
    print(f"exported {n} tiles to {args.out} ({time.time() - t0:.1f}s)", flush=True)


if __name__ == "__main__":
    main()
