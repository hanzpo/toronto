"""Map an area onto network primitives and export engine tiles.

    uv run python -m tpipe.net --bbox=-2000,-1500,1000,1000 --name downtown
    uv run python -m tpipe.net --region            (8x8-tile blocks, 2 nice'd workers, resumable)
    uv run python -m tpipe.net --block=-1,-1

Output: $TPIPE_OUT/net/{tx}_{ty}.json.gz per level-0 tile: the network description the engine
builds (app/src/net/core/desc.ts) for the nodes and segments the tile owns, with the context it
needs (nodes and segments within MARGIN of the tile, every leg of those nodes, the end nodes of
those segments) and the assets they use; {tx}_{ty}.dtm.gz holds the bare-earth terrain as
little-endian uint16 centimetres above terrain.base, delta-coded along rows (2 m grid where LiDAR
is cached, 4 m elsewhere). Blocks read PAD around themselves so tiles near block borders come out
the same whichever block exports them."""

from __future__ import annotations

import argparse
import gzip
import json
import math
import resource
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

from .. import geo
from . import model, osm, vertical
from .dtm import Coarse, Dtm

S = geo.TILE_SIZE[0]
MARGIN = 48.0
CELL = 2.0
COARSE_CELL = 4.0
BLOCK = 8
PAD = 1200.0


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
    if vertical.tunnel(e) or vertical._level(e) < 0:
        v.append({"s0": 0, "s1": 1, "kind": "tunnel"})
    if v:
        d["variant"] = v
    if e.fam in ("rail",):
        d["dir"] = "both"
    if e.tags.get("name"):
        d["name"] = e.tags["name"]
    if e.events:
        d["events"] = [{"kind": k, "s": round(f, 4), "side": sd} for k, f, sd in e.events]
    return d


def node_json(n: model.Node) -> dict[str, object]:
    d: dict[str, object] = {"id": n.id, "x": round(n.x, 2), "y": round(n.y, 2), "z": n.z}
    if n.control != "auto":
        d["control"] = n.control
    if n.tram:
        d["tram"] = [list(m) for m in n.tram]
    return d


def terrain(dtm: Dtm, tx: int, ty: int, out: Path) -> dict[str, object]:
    cell = CELL if dtm.has_lidar(tx, ty) else COARSE_CELL
    x0, y0 = tx * S - MARGIN, ty * S - MARGIN
    n = int(round((S + 2 * MARGIN) / cell)) + 1
    t = np.arange(n) * cell
    h = np.empty((n, n), dtype=np.float32)
    for r in range(0, n, 64):
        gx, gy = np.meshgrid(x0 + t, y0 + t[r : r + 64])
        h[r : r + 64] = dtm.sample(gx, gy).reshape(gx.shape)
    base = float(math.floor(np.nanmin(h)))
    cm = np.clip(np.round((h - base) * 100), 0, 65535).astype(np.uint16)
    d = cm.copy()
    d[:, 1:] = np.diff(cm, axis=1)
    with gzip.open(out / f"{tx}_{ty}.dtm.gz", "wb", compresslevel=9) as f:
        f.write(d.astype("<u2").tobytes())
    return {"x0": x0, "y0": y0, "cell": cell, "nx": n, "ny": n, "base": base, "enc": "u16cm_dx"}


def export(net: model.Network, dtm: Dtm, out: Path, tiles: set[tuple[int, int]] | None) -> list[dict[str, object]]:
    from shapely import STRtree, box
    from shapely.geometry import LineString

    out.mkdir(parents=True, exist_ok=True)
    by_node: dict[str, list[model.Edge]] = defaultdict(list)
    for e in net.edges:
        by_node[e.a].append(e)
        by_node[e.b].append(e)
    own_nodes: dict[tuple[int, int], list[str]] = defaultdict(list)
    own_segs: dict[tuple[int, int], list[model.Edge]] = defaultdict(list)
    for n in net.nodes.values():
        if n.id in by_node:
            own_nodes[(math.floor(n.x / S), math.floor(n.y / S))].append(n.id)
    for e in net.edges:
        own_segs[e.tile].append(e)
    keys = set(own_nodes) | set(own_segs)
    if tiles is not None:
        keys &= tiles
    lines = [LineString(e.pts) for e in net.edges]
    seg_tree = STRtree(lines)
    node_list = [n for n in net.nodes.values() if n.id in by_node]
    node_xy = np.array([(n.x, n.y) for n in node_list]) if node_list else np.zeros((0, 2))
    index = []
    for key in sorted(keys):
        x0, y0 = key[0] * S - MARGIN, key[1] * S - MARGIN
        x1, y1 = x0 + S + 2 * MARGIN, y0 + S + 2 * MARGIN
        near_segs = [net.edges[int(i)] for i in seg_tree.query(box(x0, y0, x1, y1), predicate="intersects")]
        near_nodes = [node_list[int(i)] .id for i in np.nonzero((node_xy[:, 0] >= x0) & (node_xy[:, 0] <= x1) & (node_xy[:, 1] >= y0) & (node_xy[:, 1] <= y1))[0]]
        segs = own_segs.get(key, [])
        seeds = segs + near_segs
        node_ids = set(own_nodes.get(key, [])) | set(near_nodes) | {e.a for e in seeds} | {e.b for e in seeds}
        ctx_segs = {e.id: e for n in node_ids for e in by_node[n]}
        for e in seeds:
            ctx_segs[e.id] = e
        all_nodes = node_ids | {e.a for e in ctx_segs.values()} | {e.b for e in ctx_segs.values()}
        used = {e.asset for e in ctx_segs.values()}
        desc = {
            "tile": list(key),
            "own": {"segs": sorted(e.id for e in segs), "nodes": sorted(own_nodes.get(key, []))},
            "nodes": [node_json(net.nodes[n]) for n in sorted(all_nodes)],
            "segments": [seg_json(ctx_segs[k]) for k in sorted(ctx_segs)],
            "assets": [net.assets.assets[a] for a in sorted(used)],
            "terrain": terrain(dtm, *key, out),
        }
        with gzip.open(out / f"{key[0]}_{key[1]}.json.gz", "wt", compresslevel=6) as f:
            json.dump(desc, f, separators=(",", ":"))
        index.append({"tile": list(key), "segs": len(segs)})
    return index


def write_index(out: Path, index: list[dict[str, object]]) -> None:
    index = sorted(index, key=lambda d: tuple(d["tile"]))  # type: ignore[arg-type]
    (out / "index.json").write_text(json.dumps({"tiles": index, "size": S}))


def region_tiles() -> set[tuple[int, int]]:
    from .. import region

    return region.level0_tiles()


def run_area(read_box: tuple[float, float, float, float], name: str, tiles: set[tuple[int, int]], out: Path, fresh: bool) -> dict[str, object]:
    t0 = time.time()
    cache = geo.WORK / "net" / "blocks" / f"{name}.osm.pbf"
    src = osm.extract(read_box, cache, fresh)
    data = osm.read(src)
    t_read = time.time() - t0
    net = model.build(data, osm.split_nodes(model.splits_family))
    big = [n for n in net.nodes.values() if len(n.members) > 1]
    wide = sorted(((round(max(math.dist(data.xy[m], (n.x, n.y)) for m in n.members), 1), n.id) for n in big), reverse=True)
    del data
    t_net = time.time() - t0
    dtm = Dtm(fetch=False)
    vertical.solve(net, dtm)
    t_vert = time.time() - t0
    index = export(net, dtm, out, tiles)
    if fresh:
        cache.unlink(missing_ok=True)
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return {
        "name": name, "tiles": index, "segments": len(net.edges), "nodes": len(net.nodes),
        "clusters": len(big), "max_cluster": max((len(n.members) for n in big), default=0),
        "t_read": round(t_read, 1), "t_net": round(t_net, 1), "t_vert": round(t_vert, 1), "t_total": round(time.time() - t0, 1),
        "rss_mb": round(rss / 2**20 if sys.platform == "darwin" else rss / 1024), "wide": [w for w in wide if w[0] > 30 and (math.floor(net.nodes[w[1]].x / S), math.floor(net.nodes[w[1]].y / S)) in tiles][:50],
    }


def run_block(bx: int, by: int, out: Path) -> None:
    frag = geo.WORK / "net" / "frag" / f"{bx}_{by}.json"
    tiles = {(tx, ty) for tx, ty in region_tiles() if tx // BLOCK == bx and ty // BLOCK == by}
    x0, y0 = bx * BLOCK * S, by * BLOCK * S
    x1, y1 = x0 + BLOCK * S, y0 + BLOCK * S
    r = run_area((x0 - PAD, y0 - PAD, x1 + PAD, y1 + PAD), f"b{bx}_{by}", tiles, out, True)
    frag.parent.mkdir(parents=True, exist_ok=True)
    frag.write_text(json.dumps(r))
    print(f"block {bx},{by}: {len(r['tiles'])} tiles, {r['segments']} segs, {r['t_total']}s, {r['rss_mb']} MB", flush=True)  # type: ignore[arg-type]


def run_region(out: Path, workers: int) -> None:
    import subprocess
    from concurrent.futures import ThreadPoolExecutor

    osm.split_nodes(model.splits_family)
    Coarse()
    blocks = sorted({(tx // BLOCK, ty // BLOCK) for tx, ty in region_tiles()}, key=lambda b: (abs(b[0]) + abs(b[1]), b))
    fdir = geo.WORK / "net" / "frag"
    todo = [b for b in blocks if not (fdir / f"{b[0]}_{b[1]}.json").exists()]
    print(f"{len(blocks)} blocks, {len(todo)} to do", flush=True)
    t0 = time.time()

    def one(b: tuple[int, int]) -> int:
        cmd = ["nice", "-n", "10", sys.executable, "-m", "tpipe.net", f"--block={b[0]},{b[1]}", f"--out={out}"]
        r = subprocess.run(cmd, capture_output=True, text=True)
        tail = (r.stdout + r.stderr).strip().splitlines()[-1:] if r.returncode == 0 else (r.stdout + r.stderr).strip().splitlines()[-15:]
        print(f"[{time.time() - t0:7.0f}s] {b}: rc={r.returncode} " + "\n".join(tail), flush=True)
        return r.returncode

    with ThreadPoolExecutor(workers) as ex:
        codes = list(ex.map(one, todo))
    bad = sum(c != 0 for c in codes)
    index = []
    for b in blocks:
        f = fdir / f"{b[0]}_{b[1]}.json"
        if f.exists():
            index += json.loads(f.read_text())["tiles"]
    keep = {f"{t['tile'][0]}_{t['tile'][1]}" for t in index}
    for p in out.glob("*.gz"):
        if p.name.split(".")[0] not in keep:
            p.unlink()
    write_index(out, index)
    print(f"region: {len(index)} tiles, {bad} failed blocks, {time.time() - t0:.0f}s", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", type=str, default=None)
    ap.add_argument("--name", type=str, default="area")
    ap.add_argument("--region", action="store_true")
    ap.add_argument("--block", type=str, default=None)
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--out", type=str, default=str(geo.OUT / "net"))
    args = ap.parse_args()
    out = Path(args.out)
    if args.region:
        run_region(out, min(2, args.workers))
        return
    if args.block:
        bx, by = (int(v) for v in args.block.split(","))
        run_block(bx, by, out)
        return
    bbox = tuple(float(v) for v in args.bbox.split(","))
    tiles = {(tx, ty) for tx in range(math.floor(bbox[0] / S), math.floor(bbox[2] / S) + 1) for ty in range(math.floor(bbox[1] / S), math.floor(bbox[3] / S) + 1)}
    r = run_area((bbox[0] - PAD, bbox[1] - PAD, bbox[2] + PAD, bbox[3] + PAD), args.name, tiles, out, False)
    write_index(out, r["tiles"])  # type: ignore[arg-type]
    print(json.dumps({k: v for k, v in r.items() if k not in ("tiles", "wide")}), flush=True)


if __name__ == "__main__":
    main()
