"""Read the network part of OSM with its tags: highways, railways, platforms and the nodes
that carry meaning for them (crossings, switches, signals, stops)."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from pathlib import Path

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
    def __init__(self, out: OsmNet) -> None:
        super().__init__()
        self.out = out
        self.need: set[int] = set()

    def way(self, w: osmium.osm.Way) -> None:
        t = {k: v for k, v in w.tags}
        if not wanted(t):
            return
        nodes = [n.ref for n in w.nodes]
        for n in w.nodes:
            if n.location.valid():
                if n.ref not in self.out.xy:
                    x, y = geo.project(n.location.lon, n.location.lat)
                    self.out.xy[n.ref] = (float(x), float(y))
        self.out.ways.append(Way(w.id, t, nodes))

    def node(self, n: osmium.osm.Node) -> None:
        if not n.tags:
            return
        t = {k: v for k, v in n.tags if k in NODE_KEYS or k.startswith("traffic_signals")}
        if t:
            self.out.ntags[n.id] = t


def extract(bbox_world: tuple[float, float, float, float] | None, cache: Path) -> Path:
    src = geo.WORK / "combined.osm.pbf"
    if bbox_world is None:
        return src
    if cache.exists():
        return cache
    x0, y0, x1, y1 = bbox_world
    lo0, la0 = geo.unproject(x0, y0)
    lo1, la1 = geo.unproject(x1, y1)
    cache.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["osmium", "extract", "-b", f"{lo0},{la0},{lo1},{la1}", "-s", "smart", str(src), "-o", str(cache), "--overwrite"], check=True)
    return cache


def read(path: Path) -> OsmNet:
    out = OsmNet()
    h = _Handler(out)
    h.apply_file(str(path), locations=True)
    return out
