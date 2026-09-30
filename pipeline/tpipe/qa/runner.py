"""Worker-side task functions for tpipe.qa (importable, so the spawn start method works)."""

from __future__ import annotations

import time

from . import checks_landmarks, checks_objects, checks_rail, checks_roads, checks_transit, data

BLOCK_CATS = checks_roads.ROAD_CATS | checks_objects.OBJECT_CATS | checks_transit.TRANSIT_CATS | {"rail_kink", "rail_gap"}
GLOBAL_CATS = checks_rail.RAIL_CATS | {"landmark_overlap"}


def _block_task(args):
    bx, by, cats, bbox = args
    tileset = _TILESET
    B = data.Block(bx, by, tileset)
    out = []
    if not B.tiles:
        return out
    out += checks_roads.run(B, cats)
    out += checks_objects.run(B, cats)
    out += checks_transit.run(B, cats)
    out += checks_rail.run_block(B, cats)
    if bbox:
        out = [f for f in out if bbox[0] <= f["e"] < bbox[2] and bbox[1] <= f["n"] < bbox[3]]
    return out


def _global_task(args):
    which, cats, bbox = args
    if which == "rail":
        return checks_rail.run_global(cats, bbox)
    if which == "landmarks":
        return checks_landmarks.run_global(cats, bbox)
    return []


_TILESET: set = set()


def _init(tiles):
    global _TILESET
    _TILESET = tiles


def _run(task):
    kind, args = task
    t0 = time.time()
    res = _block_task(args) if kind == "block" else _global_task(args)
    return kind, args[:2] if kind == "block" else args[0], res, time.time() - t0


