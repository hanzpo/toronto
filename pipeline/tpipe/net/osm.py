"""Read the network part of OSM with its tags: highways, railways, platforms and the nodes
that carry meaning for them (crossings, switches, signals, stops)."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import osmium

from .. import geo

NODE_KEYS = ("highway", "railway", "crossing", "crossing:barrier", "crossing:light", "public_transport", "barrier")


@dataclass
class Way:
    id: int
    tags: dict[str, str]
    nodes: list[int]


@dataclass
class OsmNet:
    ways: list[Way] = field(default_factory=list)
    xy: dict[int, tuple[float, float]] = field(default_factory=dict)
    ntags: dict[int, dict[str, str]] = field(default_factory=dict)


def wanted(t: dict[str, str]) -> bool:
    if t.get("area") == "yes" and t.get("highway") not in (None, "pedestrian"):
        return False
    hw = t.get("highway")
    if hw and hw not in ("proposed", "construction", "abandoned", "corridor", "elevator", "bus_stop", "platform", "raceway", "services", "rest_area"):
        return True
    rw = t.get("railway")
    if rw in ("rail", "subway", "light_rail", "tram", "narrow_gauge", "platform"):
        return True
    return t.get("public_transport") == "platform" and t.get("railway") is not None


class _Handler(osmium.SimpleHandler):
    def __init__(self, out: OsmNet, nmap: np.ndarray | None, wmap: np.ndarray | None) -> None:
        super().__init__()
        self.out = out
        self.nmap = nmap
        self.wmap = wmap

    def nid(self, i: int) -> int:
        return int(self.nmap[i - 1]) if self.nmap is not None else i

    def way(self, w: osmium.osm.Way) -> None:
        t = {k: v for k, v in w.tags}
        if not wanted(t):
            return
        refs = [n.ref for n in w.nodes]
        nodes = self.nmap[np.array(refs, dtype=np.int64) - 1].astype(np.int64).tolist() if self.nmap is not None else refs
        for n, oid in zip(w.nodes, nodes):
            if n.location.valid() and oid not in self.out.xy:
                x, y = geo.project(n.location.lon, n.location.lat)
                self.out.xy[oid] = (float(x), float(y))
        wid = int(self.wmap[w.id - 1]) if self.wmap is not None else w.id
        self.out.ways.append(Way(wid, t, nodes))

    def node(self, n: osmium.osm.Node) -> None:
        if not n.tags:
            return
        t = {k: v for k, v in n.tags if k in NODE_KEYS or k.startswith("traffic_signals")}
        if t:
            self.out.ntags[self.nid(n.id)] = t


def network_pbf() -> Path:
    src = geo.WORK / "combined.osm.pbf"
    out = geo.WORK / "net" / "network.osm.pbf"
    if out.exists() and out.stat().st_mtime >= src.stat().st_mtime:
        return out
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["osmium", "tags-filter", str(src), "w/highway", "w/railway", "w/public_transport=platform", "-o", str(out), "--overwrite"], check=True)
    return out


RENUM = geo.WORK / "net" / "renum"


def dense_pbf() -> Path:
    """The network renumbered to dense ids (osmium's id sets are sized by the largest id, which
    costs ~4 GB per extract on the original ids). read() maps the ids back."""
    src = network_pbf()
    out = geo.WORK / "net" / "network_dense.osm.pbf"
    if out.exists() and out.stat().st_mtime >= src.stat().st_mtime and (RENUM / "node.idx").exists():
        return out
    import shutil

    shutil.rmtree(RENUM, ignore_errors=True)
    RENUM.mkdir(parents=True)
    subprocess.run(["osmium", "renumber", "-i", str(RENUM), str(src), "-o", str(out), "--overwrite"], check=True)
    return out


def extract(bbox_world: tuple[float, float, float, float] | None, cache: Path, fresh: bool = False) -> Path:
    src = dense_pbf()
    if bbox_world is None:
        return src
    if cache.exists() and not fresh:
        return cache
    x0, y0, x1, y1 = bbox_world
    lo0, la0 = geo.unproject(x0, y0)
    lo1, la1 = geo.unproject(x1, y1)
    cache.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["osmium", "extract", "-b", f"{lo0},{la0},{lo1},{la1}", "-s", "smart", str(src), "-o", str(cache), "--overwrite"], check=True)
    return cache


def read(path: Path) -> OsmNet:
    out = OsmNet()
    dense = path.resolve() != network_pbf().resolve() and "combined" not in path.name
    nmap = np.fromfile(RENUM / "node.idx", dtype="<u8") if dense else None
    wmap = np.fromfile(RENUM / "way.idx", dtype="<u8") if dense else None
    h = _Handler(out, nmap, wmap)
    h.apply_file(str(path), locations=True)
    out.ways.sort(key=lambda w: w.id)
    return out


class _RefHandler(osmium.SimpleHandler):
    def __init__(self, keep) -> None:
        super().__init__()
        self.keep = keep
        self.chunks: list[np.ndarray] = []
        self.buf: list[int] = []

    def way(self, w: osmium.osm.Way) -> None:
        t = {k: v for k, v in w.tags}
        if not wanted(t) or not self.keep(t):
            return
        nodes = [n.ref for n in w.nodes]
        if len(nodes) < 2:
            return
        self.buf.extend(set(nodes))
        self.buf.append(nodes[0])
        self.buf.append(nodes[-1])
        if len(self.buf) > 1 << 20:
            self.flush()

    def flush(self) -> None:
        if self.buf:
            self.chunks.append(np.array(self.buf, dtype=np.int64))
            self.buf = []


def split_nodes(keep) -> np.ndarray:
    """Sorted ids of every node referenced at least twice by the network ways of the whole region
    (shared by two ways, or a way end on another way): the split points, computed once globally so
    that every block splits ways at the same nodes."""
    src = network_pbf()
    cache = geo.WORK / "net" / "split_nodes.npy"
    if cache.exists() and cache.stat().st_mtime >= src.stat().st_mtime:
        return np.load(cache)
    h = _RefHandler(keep)
    h.apply_file(str(src))
    h.flush()
    ids, counts = np.unique(np.concatenate(h.chunks), return_counts=True)
    out = ids[counts >= 2]
    np.save(cache, out)
    return out
