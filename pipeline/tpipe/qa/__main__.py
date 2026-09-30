"""Static QA over the built data -> app/public/data/qa/issues.json (+ issues_summary.json).

    cd pipeline && uv run python -m tpipe.qa [--categories a,b] [--bbox E0,N0,E1,N1]
                                             [--workers 2] [--max-per-cat 2000] [--record]

Before running the prop / tree categories, refresh the client placement dump
(`node app/qa/props_dump.mjs`; it is incremental). Without a dump those checks
fall back to OSM points.

The region is processed in blocks of 4x4 level-0 tiles plus a one-tile halo,
using worker processes (default 2, at most 4). Tile decoding is cached per
worker (a small LRU), and workers are recycled to bound memory. Output order
is deterministic: category, then severity descending, then E, N, OSM ids.
See docs/QA.md.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import multiprocessing as mp
import sys
import time

import numpy as np

from .. import geo
from . import checks_rail, checks_stations, checks_transit, data
from .core import dedupe, order, view_for
from .runner import BLOCK_CATS, GLOBAL_CATS, _init, _run

OUT = geo.OUT / "qa"
RESULTS_MD = geo.ROOT / "docs" / "qa-results.md"

ALL_CATS = sorted(BLOCK_CATS | GLOBAL_CATS)

NEAR_STATION = 500.0  # m: findings this close to a station get near_station + a rank boost
STATION_BOOST = 2.0  # score = sev x boost near stations; ranks follow score
OWNER = {  # which workstream fixes each category (docs/QA.md)
    **{c: "roads" for c in ("road_width_step", "bridge_width_anomaly", "road_overlap_nonjunction", "flat_crossing", "deck_below_clearance",
                            "junction_hardware_on_grade_sep", "elevation_jump", "road_below_terrain", "duplicate_footway",
                            "footway_as_road", "sidewalk_bridge_discontinuity", "dash_phase_break", "graph_connectivity",
                            "hooked_edge", "micro_link", "carriageway_overlap", "graph_vs_drawn_elevation")},
    **{c: "stations" for c in ("platform_track_clearance", "station_column_clearance", "tree_on_platform")},
    **{c: "rail" for c in ("rail_kink", "rail_gap", "route_track_conflict", "building_over_track")},
    **{c: "transit" for c in ("transit_route_off_road", "transit_wrong_way", "vehicle_path_through_building")},
    **{c: "buildings-props" for c in ("building_overlap", "floating_object", "prop_in_lane", "prop_in_crosswalk", "prop_in_building", "house_overlap",
                                      "building_over_road", "lot_over_building")},
    **{c: "vegetation" for c in ("tree_on_road", "tree_on_rail", "tree_over_track", "tree_on_airfield", "tree_on_water", "tree_in_building")},
    **{c: "landmarks" for c in ("landmark_overlap", "landmark_road_overlap")},
    "raster_shore": "ground",
    # cross-layer merge gate against the network model (docs/ROADS.md "Source of truth")
    **{c: "model" for c in ("rail_above_bed", "duplicate_track", "underpass_drawn_at_grade", "drawn_rail_vs_train_path",
                            "graph_vs_model", "sidewalk_between_carriageways", "lane_count_jump", "duplicate_crosswalk", "adjacent_track_z_step")},
}


def near_stations(findings: list[dict]) -> list[dict]:
    """Flag findings within NEAR_STATION of a station (stations.json + transit index) and boost their score."""
    from scipy.spatial import cKDTree

    pts = [s["c"] for s in data.stations() if s.get("c")]
    idx = geo.OUT / "transit" / "index.json"
    if idx.exists():
        pts += [s["pos"] for s in json.loads(idx.read_text()).get("stations", []) if s.get("pos")]
    tree = cKDTree(np.array(pts)) if pts else None
    for f in findings:
        n = False
        if tree is not None:
            d, _ = tree.query([f["e"], f["n"]])
            n = bool(d <= NEAR_STATION)
        f["near_station"] = n
        f["score"] = round(f["sev"] * (STATION_BOOST if n else 1.0), 3)
    return findings


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="tpipe.qa", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--categories", default="", help="comma list (default all): " + ",".join(ALL_CATS))
    ap.add_argument("--bbox", default="", help="E0,N0,E1,N1 world metres")
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--max-per-cat", type=int, default=2000, help="findings kept per category in issues.json")
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--record", action="store_true", help="append the counts to docs/qa-results.md")
    ap.add_argument("--note", default="", help="note for the --record row")
    a = ap.parse_args(argv)
    cats = set(ALL_CATS) if not a.categories else {c.strip() for c in a.categories.split(",") if c.strip()}
    bad = cats - set(ALL_CATS)
    if bad:
        ap.error(f"unknown categories: {sorted(bad)}")
    bbox = tuple(float(v) for v in a.bbox.split(",")) if a.bbox else None
    workers = max(1, min(4, a.workers))
    t0 = time.time()
    man = data.manifest()
    tiles = set(map(tuple, man["tiles"]["0"]))
    blocks = sorted({(math.floor(tx / data.BLOCK), math.floor(ty / data.BLOCK)) for tx, ty in tiles}, key=lambda b: (b[1], b[0]))
    if bbox:
        S = data.S0 * data.BLOCK
        blocks = [b for b in blocks if (b[0] + 1) * S > bbox[0] and b[0] * S < bbox[2] and (b[1] + 1) * S > bbox[1] and b[1] * S < bbox[3]]
    if checks_transit.TRANSIT_CATS & cats:
        n = len(checks_transit.samples()["x"])  # build/refresh the cache once, before forking
        print(f"transit samples: {n}", file=sys.stderr)
    tasks = []
    if checks_rail.RAIL_CATS & cats:
        tasks.append(("global", ("rail", cats, bbox)))
    if {"landmark_overlap", "landmark_road_overlap"} & cats:
        tasks.append(("global", ("landmarks", cats, bbox)))
    if checks_stations.STATION_CATS & cats:
        tasks.append(("global", ("stations", cats, bbox)))
    if BLOCK_CATS & cats:
        tasks += [("block", (bx, by, cats, bbox)) for bx, by in blocks]
    findings: list[dict] = []
    timing: dict = {}
    done = 0
    ctx = mp.get_context("spawn")  # fork is unsafe on macOS once native libs are initialised
    with ctx.Pool(workers, initializer=_init, initargs=(tiles,), maxtasksperchild=40) as pool:
        for kind, what, res, sec in pool.imap_unordered(_run, tasks, chunksize=1):
            findings += res
            timing[kind] = timing.get(kind, 0) + sec
            done += 1
            if done % 100 == 0 or kind == "global":
                print(f"  {done}/{len(tasks)} tasks, {len(findings)} findings, {time.time() - t0:.0f}s"
                      + (f" ({what}: {sec:.0f}s)" if kind == "global" else ""), file=sys.stderr)
    findings = order(near_stations(dedupe(findings)))
    counts: dict = {c: 0 for c in sorted(cats)}
    near: dict = {c: 0 for c in sorted(cats)}
    subs: dict = {}
    for f in findings:
        counts[f["cat"]] += 1
        near[f["cat"]] += bool(f["near_station"])
        subs.setdefault(f["cat"], {}).setdefault(f["sub"], 0)
        subs[f["cat"]][f["sub"]] += 1
    kept, rank = [], {}
    for f in findings:
        r = rank.get(f["cat"], 0) + 1
        rank[f["cat"]] = r
        if r > a.max_per_cat:
            continue
        g = {k: v for k, v in f.items() if not k.startswith("_")}
        g = {"id": f"{f['cat']}/{r}", "cat": f["cat"], "sub": f["sub"], "rank": r, **{k: g[k] for k in ("sev", "score", "e", "n", "z", "osm", "desc")},
             "near_station": f["near_station"], "owner": OWNER.get(f["cat"], "?"), "view": view_for(f)}
        kept.append(g)
    runtime = time.time() - t0
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    out = geo.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    meta = {"version": 1, "generated": now, "build": man.get("build"), "bbox": bbox, "categories": sorted(cats)}
    (out / "issues.json").write_text(json.dumps({**meta, "issues": kept}, separators=(",", ":")))
    summary = {**meta, "runtime_s": round(runtime, 1), "workers": workers, "blocks": len(blocks), "timing_s": {k: round(v, 1) for k, v in timing.items()},
               "counts": counts, "near_station": near, "owners": {c: OWNER.get(c, "?") for c in sorted(cats)}, "subs": subs, "kept": len(kept), "max_per_cat": a.max_per_cat}
    (out / "issues_summary.json").write_text(json.dumps(summary, indent=1))
    for c in sorted(cats):
        print(f"{c:34s} {counts[c]:7d}  {subs.get(c, {})}")
    print(f"{len(findings)} findings ({len(kept)} written) in {runtime:.0f}s -> {out / 'issues.json'}")
    if a.record:
        _record(summary, a.note)
    return 0


def _record(summary: dict, note: str) -> None:
    cats = [c for c in ALL_CATS]
    if not RESULTS_MD.exists():
        RESULTS_MD.write_text("# Static QA results\n\nOne row per `uv run python -m tpipe.qa --record` run "
                              "(counts per category; see docs/QA.md). Newest last.\n\n")
    txt = RESULTS_MD.read_text()
    hdr = "| date (UTC) | build | scope | runtime | " + " | ".join(cats) + " | note |"
    if hdr not in txt:
        txt += "\n" + hdr + "\n|" + "---|" * (len(cats) + 5) + "\n"
    scope = "region" if not summary["bbox"] else "bbox " + ",".join(f"{v:.0f}" for v in summary["bbox"])
    row = (f"| {summary['generated'][:16].replace('T', ' ')} | {summary['build']} | {scope} | {summary['runtime_s']:.0f}s | "
           + " | ".join(str(summary["counts"].get(c, "–")) for c in cats) + f" | {note} |")
    RESULTS_MD.write_text(txt.rstrip("\n") + "\n" + row + "\n")


if __name__ == "__main__":
    sys.exit(main())
