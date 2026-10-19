"""Airside QA (docs/AIR.md "Apron"), run by tpipe.airports after it builds the surfaces:

- stand_off_apron     a stand stop point that isn't on apron / taxiway pavement
- aircraft_on_grass   the footprint of an aircraft type scheduled on a stand, parked the way the
                      client parks it (nose tip 3 m past the stop point), leaves the pavement
                      (fuselage strip by > 1 m², or > 5 % of the wingspan box)
- road_across_runway  a drawn road piece (level-0 tiles) or traffic-graph edge crosses a runway /
                      taxiway surface at grade after the client's airside filter
- traffic_on_airside  a traffic-graph edge the client would still load on runway / taxiway
                      pavement, or a service / perimeter road (class >= 5) mostly on the airside

The road categories emulate app/src/workers/airside.ts on the zone geometry (the client uses the
2 m raster of the same geometry), with rule "new" (apron + runway + airside planes) and rule
"old" (the first version: apron plane, classes >= 5 only) for before / after counts.

    report: <OUT>/air/qa_airside.json
"""

from __future__ import annotations

import json
import math

import numpy as np
import shapely
from shapely.geometry import Point, Polygon

from . import geo, tbn

STEP = 1.5


def _samples(xy, step=STEP):
    """points every <= step m along a polyline (N, 2)"""
    out = [xy[:1]]
    for a, b in zip(xy[:-1], xy[1:]):
        L = float(np.hypot(*(b - a)))
        m = max(1, math.ceil(L / step))
        t = (np.arange(1, m + 1) / m)[:, None]
        out.append(a + (b - a) * t)
    return np.vstack(out)


def _inside(geom, P):
    if geom is None or geom.is_empty or not len(P):
        return np.zeros(len(P), bool)
    return shapely.contains_xy(geom, P[:, 0], P[:, 1])


def _tiles(kind, bbox, cache):
    x0, y0, x1, y1 = bbox
    for tx in range(math.floor(x0 / 1024), math.floor(x1 / 1024) + 1):
        for ty in range(math.floor(y0 / 1024), math.floor(y1 / 1024) + 1):
            k = (kind, tx, ty)
            if k not in cache:
                f = geo.OUT / ("tiles/0" if kind == "r" else "graph") / f"{tx}_{ty}.bin.gz"
                cache[k] = tbn.read(f)[0] if f.exists() else None
            if cache[k] is not None:
                yield tx, ty, cache[k]


def _stand_checks(ap, find):
    pave = ap["paved"]
    if pave is None or pave.is_empty:
        return
    shapely.prepare(pave)
    from .airports import TYPE_LEN
    from .air import TYPES
    for s in ap.get("stands") or []:
        p = np.array(s["pos"], float)
        hd = np.array(s["hdg"], float)
        rt = np.array([hd[1], -hd[0]])
        if not pave.buffer(0.5).contains(Point(p)):
            find("stand_off_apron", ap, p, f"stand {s.get('ref') or '?'} stop point off the pavement", ref=s.get("ref"))
        nose = p + hd * 3.0
        for t in s.get("types") or []:
            L, W = TYPE_LEN.get(t, 40.0), TYPES.get(t, (35.0,))[0]
            fus = Polygon([nose + rt * 2.2, nose - rt * 2.2, nose - hd * L - rt * 2.2, nose - hd * L + rt * 2.2])
            box = Polygon([nose + rt * W / 2, nose - rt * W / 2, nose - hd * L - rt * W / 2, nose - hd * L + rt * W / 2])
            off_f = fus.difference(pave).area
            off_b = box.difference(pave).area / box.area
            if off_f > 1.0 or off_b > 0.05:
                find("aircraft_on_grass", ap, nose - hd * L / 2,
                     f"{t} on stand {s.get('ref') or '?'}: fuselage {off_f:.0f} m² / wings {off_b * 100:.0f} % off the pavement",
                     ref=s.get("ref"), type=t)
    for q in ap.get("pp") or []:
        if not pave.buffer(0.5).contains(Point(q)):
            find("stand_off_apron", ap, np.asarray(q), "OSM parking position off the pavement")


def _road_checks(ap, find, cache, rule):
    z0, z1, z2 = ap["planes"] if ap.get("planes") else (None, None, None)
    rw = ap["runways"]
    if rw is None or rw.is_empty:
        return
    rw_in = rw.buffer(-1.0)
    for g in (z0, z1, z2, rw_in):
        if g is not None and not g.is_empty:
            shapely.prepare(g)
    old_z0 = z0 if ap.get("had_svc") else None
    b = rw.buffer(200).bounds
    for tx, ty, a in _tiles("r", b, cache):
        if "r_off" not in a:
            continue
        off, xyz = a["r_off"], a["r_xyz"].reshape(-1, 3)
        cls, fl, osm = a["r_class"], a["r_flags"], a["r_osm"]
        for i in range(len(off) - 1):
            if fl[i] & 6:
                continue
            P = _samples(xyz[off[i]:off[i + 1], :2].astype(float) + (tx * 1024, ty * 1024))
            if not rw_in.intersects(shapely.linestrings(P)):
                continue
            hit = _inside(rw_in, P)
            if rule == "new":
                drop = _inside(z1, P) | ((cls[i] >= 5) & _inside(z0, P))
            else:
                drop = (cls[i] >= 5) & _inside(old_z0, P)
            left = hit & ~drop
            if left.any():
                q = P[np.nonzero(left)[0][0]]
                find("road_across_runway", ap, q, f"road (class {cls[i]}) drawn across a runway at grade", osm=int(osm[i]), sub="road")
    for tx, ty, a in _tiles("g", b, cache):
        if "e_off" not in a:
            continue
        off, xyz = a["e_off"], a["e_xyz"].reshape(-1, 3)
        cls, fl, osm = a["e_class"], a["e_flags"], a["e_osm"]
        for e in range(len(off) - 1):
            if fl[e] & 6:
                continue
            P = _samples(xyz[off[e]:off[e + 1], :2].astype(float) + (tx * 1024, ty * 1024))
            on_rw = _inside(rw_in, P).any()
            if rule == "new":
                in1 = _inside(z1, P).any()
                air = (_inside(z0, P) | _inside(z2, P)).mean() if len(P) else 0
                kept = not (in1 or (cls[e] >= 5 and air >= 0.5))
            else:
                air0 = _inside(old_z0, P).mean() if len(P) else 0
                kept = not (cls[e] >= 5 and air0 >= 0.5)
                in1 = _inside(z1, P).any()
                air = (_inside(z0, P) | _inside(z2, P)).mean() if len(P) else 0
            if not kept:
                continue
            if on_rw:
                find("road_across_runway", ap, P[len(P) // 2], f"traffic edge (class {cls[e]}) across a runway", osm=int(osm[e]), sub="graph")
            if in1 or (cls[e] >= 5 and air >= 0.5):
                find("traffic_on_airside", ap, P[len(P) // 2], f"traffic edge (class {cls[e]}) on the airside", osm=int(osm[e]))


def run(airports, write=True):
    """airports: [{key, icao, name, paved, runways, planes (z0, z1, z2), had_svc, stands, pp}]"""
    report = {}
    cache = {}
    for rule in ("old", "new"):
        findings = []

        def find(cat, ap, p, desc, **kw):
            findings.append(dict(category=cat, airport=ap.get("icao") or ap["key"], e=round(float(p[0]), 1),
                                 n=round(float(p[1]), 1), desc=desc, **kw))
        for ap in airports:
            if rule == "new":
                _stand_checks(ap, find)
            _road_checks(ap, find, cache, rule)
        report[rule] = findings
    counts = {rule: {} for rule in report}
    for rule, fs in report.items():
        for f in fs:
            k = (f["category"], f["airport"])
            counts[rule][k] = counts[rule].get(k, 0) + 1
    cats = ("stand_off_apron", "aircraft_on_grass", "road_across_runway", "traffic_on_airside")
    tot = {rule: {c: sum(v for (cc, _), v in counts[rule].items() if cc == c) for c in cats} for rule in counts}
    print("  airside QA (old filter rule -> new):")
    for c in cats:
        per = sorted({a for (cc, a) in list(counts["new"]) + list(counts["old"]) if cc == c})
        detail = ", ".join(f"{a} {counts['old'].get((c, a), 0) if c.startswith(('road', 'traffic')) else '-'}->{counts['new'].get((c, a), 0)}" for a in per)
        old = tot["old"][c] if c.startswith(("road", "traffic")) else "-"
        print(f"    {c:<20} {old} -> {tot['new'][c]}   {detail}")
    if write:
        out = dict(version=1, totals=tot, findings=report["new"], findings_old_rule=[f for f in report["old"] if f["category"].startswith(("road", "traffic"))])
        (geo.OUT / "air" / "qa_airside.json").write_text(json.dumps(out, indent=1))
    return tot
