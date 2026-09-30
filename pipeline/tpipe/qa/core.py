"""Finding records, category registry and the suggested camera for each finding."""

from __future__ import annotations

import math

import numpy as np

# Camera distance (m) used to frame a finding of each category (tour / __qa.goto).
VIEW_DIST = {
    "raster_shore": 450.0, "landmark_overlap": 260.0, "building_overlap": 140.0,
    "bridge_width_anomaly": 120.0, "flat_crossing": 110.0, "deck_below_clearance": 110.0,
    "elevation_jump": 90.0, "road_below_terrain": 90.0, "route_track_conflict": 120.0,
    "rail_gap": 70.0, "rail_kink": 80.0, "transit_route_off_road": 80.0,
    "tree_on_road": 35.0, "tree_on_rail": 35.0, "tree_on_airfield": 60.0, "tree_on_water": 45.0,
    "prop_in_lane": 35.0, "floating_object": 80.0,
}
VIEW_DEFAULT_DIST = 60.0
VIEW_PITCH = 35.0  # deg below horizon


def finding(cat: str, sub: str, sev: float, x: float, y: float, z: float | None, osm, desc: str,
            key=None, bearing: float | None = None, dist: float | None = None) -> dict:
    """One finding. `bearing` = direction of the feature (rad CCW from +E) to aim the camera
    along it; `key` dedupes the same problem found from several blocks."""
    osm_l = [int(o) for o in (osm if isinstance(osm, (list, tuple, np.ndarray)) else [osm]) if o and math.isfinite(o)]
    if key is None:
        key = (cat, sub, round(float(x)), round(float(y)))
    return {
        "cat": cat, "sub": sub, "sev": round(float(sev), 3),
        "e": round(float(x), 1), "n": round(float(y), 1),
        "z": None if z is None or not math.isfinite(z) else round(float(z), 1),
        "osm": osm_l, "desc": desc, "_key": key,
        "_bearing": None if bearing is None or not math.isfinite(bearing) else float(bearing),
        "_dist": dist,
    }


def view_for(f: dict) -> dict:
    d = f.get("_dist") or VIEW_DIST.get(f["cat"], VIEW_DEFAULT_DIST)
    b = f.get("_bearing")
    # look along the feature, turned 35 deg so both sides show; heading = clockwise from north
    heading = 20.0 if b is None else (90.0 - math.degrees(b) + 35.0) % 360.0
    return {"dist": round(float(d), 1), "heading": round(heading, 1), "pitch": VIEW_PITCH}


def dedupe(findings: list[dict]) -> list[dict]:
    """Keep one finding per key: highest severity, then smallest (E, N)."""
    best: dict = {}
    for f in findings:
        k = f["_key"]
        o = best.get(k)
        if o is None or (f["sev"], -f["e"], -f["n"]) > (o["sev"], -o["e"], -o["n"]):
            best[k] = f
    return list(best.values())


def order(findings: list[dict]) -> list[dict]:
    """Deterministic order: category, severity desc, E, N, osm ids, sub."""
    return sorted(findings, key=lambda f: (f["cat"], -f["sev"], f["e"], f["n"], f["osm"], f["sub"]))
