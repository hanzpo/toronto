"""Audit: building multipolygons with more than one outer ring (read-only).

    uv run python -m tpipe.multipoly_audit [path.osm.pbf] [--top N]

Before 2026-09-30 `osm_extract` kept only the first outer ring of a building
multipolygon, so every further outer ring (and its holes) was lost. This reads
the raw extract and reports how many buildings / rings / m² that affected.
Writes nothing.
"""

from __future__ import annotations

import sys
import time

import numpy as np
import osmium

from . import geo


def _area(ring) -> float:
    pts = np.array([(n.lon, n.lat) for n in ring], dtype=np.float64)
    if len(pts) < 4:
        return 0.0
    x, y = geo.project(pts[:, 0], pts[:, 1])
    return 0.5 * abs(float(np.dot(x[:-1], y[1:]) - np.dot(x[1:], y[:-1])))


def run(path: str, top: int = 25) -> None:
    t0 = time.time()
    fp = (
        osmium.FileProcessor(path)
        .with_locations(osmium.index.create_map("flex_mem"))
        .with_areas(osmium.filter.KeyFilter("building", "building:part"))
        .with_filter(osmium.filter.KeyFilter("building", "building:part"))
    )
    n_rel = n_multi = rings_lost = holes_lost = 0
    area_lost = area_total = 0.0
    rows = []
    for obj in fp:
        if not obj.is_area() or obj.from_way():
            continue
        t = obj.tags
        b, p = t.get("building"), t.get("building:part")
        if not ((b and b != "no") or (p and p != "no")):
            continue
        n_rel += 1
        outers = list(obj.outer_rings())
        areas = [_area(o) for o in outers]
        area_total += sum(areas)
        if len(outers) < 2:
            continue
        n_multi += 1
        rings_lost += len(outers) - 1
        holes_lost += sum(sum(1 for _ in obj.inner_rings(o)) for o in outers[1:])
        lost = sum(areas[1:])
        area_lost += lost
        rows.append((lost, obj.orig_id(), len(outers), sum(areas), t.get("name", ""), b or p))
    rows.sort(reverse=True)
    print(f"{path}: {n_rel:,} building multipolygon relations ({time.time() - t0:.0f}s)")
    print(f"  {n_multi:,} have >1 outer ring: {rings_lost:,} outer rings (+{holes_lost:,} holes) were dropped")
    print(f"  footprint lost: {area_lost / 1e6:.3f} km² of {area_total / 1e6:.3f} km² in multipolygon buildings")
    print(f"  top {min(top, len(rows))} by lost area:")
    for lost, rid, no, tot, name, tag in rows[:top]:
        print(f"    r{rid:<10d} {no:3d} outers  lost {lost:9.0f} of {tot:9.0f} m²  {tag:<14s} {name}")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    top = int(sys.argv[sys.argv.index("--top") + 1]) if "--top" in sys.argv else 25
    if "--top" in sys.argv:
        args = [a for a in args if a != str(top)]
    run(args[0] if args else str(geo.WORK / "combined.osm.pbf"), top)
