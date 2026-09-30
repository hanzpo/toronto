"""Supplementary GTFS feeds merged into an agency's zip before tpipe.transit runs.

Some agencies publish a service in a separate static feed; e.g. Grand River
Transit's main feed (staticfeeds/1) carries buses only, while ION LRT route 301
is in staticfeeds/2. An agency in transit_sources.SOURCES may list

    "extra": [{"url": ..., "prefix": "ion", "platform_suffix": regex}]

and this module builds raw/gtfs/{key}.zip = {key}.base.zip + each extra feed, so
tpipe.transit ingests a single ordinary GTFS zip.

    cd pipeline && uv run python -m tpipe.transit_extra [--download] [agency ...]

  - the base feed is kept as raw/gtfs/{key}.base.zip (moved there from {key}.zip on
    first run), extra feeds as raw/gtfs/{key}+{prefix}.zip; --download refetches
    the extras (and the base, from SOURCES[key]["url"], if it is missing)
  - ids of the extra feed (stop, trip, service, shape, block, fare, and route ids
    that collide with the base) are prefixed with "{prefix}:" so feeds never clash
  - `trim_shape_spurs`: drop short (< 40 m) kinks at either end of a shape, where
    the shape starts at the stop pole and turns sharply onto the track (the rail
    router needs the shape's direction of travel at the terminal stop)
  - `platform_suffix`: platform stops whose names match it and that have no
    parent_station get a synthesised parent station (location_type 1) named by
    the stripped name, so e.g. "Allen Station - Northbound"/"- Southbound" group
    into one "Allen Station"
Rerunning is idempotent (always rebuilt from base + extras).
"""

from __future__ import annotations

import csv
import io
import math
import re
import ssl
import sys
import urllib.error
import urllib.request
import zipfile

from . import geo
from .transit_sources import SOURCES

GTFS = geo.RAW / "gtfs"

# column -> id namespace; values in the extra feed get "{prefix}:" prepended
ID_COLS = {
    "stop_id": "stop", "parent_station": "stop", "from_stop_id": "stop", "to_stop_id": "stop",
    "trip_id": "trip", "from_trip_id": "trip", "to_trip_id": "trip",
    "service_id": "service", "shape_id": "shape", "block_id": "block", "fare_id": "fare",
    "route_id": "route", "from_route_id": "route", "to_route_id": "route",
    "zone_id": "zone", "origin_id": "zone", "destination_id": "zone", "contains_id": "zone",
}
# files concatenated with the base; anything else in the extra feed is dropped
MERGE_FILES = [
    "agency.txt", "routes.txt", "trips.txt", "stop_times.txt", "stops.txt", "calendar.txt",
    "calendar_dates.txt", "shapes.txt", "frequencies.txt", "transfers.txt",
    "fare_attributes.txt", "fare_rules.txt",
]


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        data = urllib.request.urlopen(req, timeout=120).read()
    except urllib.error.URLError as e:
        if "DH_KEY_TOO_SMALL" not in str(e):
            raise
        # regionofwaterloo.ca still negotiates a 1024-bit DH key
        ctx = ssl.create_default_context()
        ctx.set_ciphers("DEFAULT:@SECLEVEL=1")
        data = urllib.request.urlopen(req, timeout=120, context=ctx).read()
    if data[:2] != b"PK":
        raise ValueError(f"not a zip: {url}")
    return data


def read_zip(path) -> dict[str, tuple[list[str], list[list[str]]]]:
    out = {}
    with zipfile.ZipFile(path) as z:
        for n in z.namelist():
            base = n.split("/")[-1]
            if not base.endswith(".txt"):
                continue
            raw = z.read(n).decode("utf-8-sig", errors="replace")
            rows = list(csv.reader(io.StringIO(raw)))
            if not rows:
                continue
            out[base] = ([c.strip() for c in rows[0]], [r for r in rows[1:] if any(x.strip() for x in r)])
    return out


def ids_in(tables, ns: str) -> set[str]:
    s = set()
    for hdr, rows in tables.values():
        for i, c in enumerate(hdr):
            if ID_COLS.get(c) == ns:
                s.update(r[i].strip() for r in rows if i < len(r) and r[i].strip())
    return s


def trim_spurs(table, max_len: float = 40.0, min_turn: float = 45.0) -> int:
    """Remove sharply-turning short end segments of every shape (in place)."""
    hdr, rows = table
    h = {c: i for i, c in enumerate(hdr)}
    by: dict[str, list] = {}
    for r in rows:
        by.setdefault(r[h["shape_id"]], []).append(r)
    kill = set()
    for pts in by.values():
        pts.sort(key=lambda r: int(float(r[h["shape_pt_sequence"]])))
        kx = math.cos(math.radians(float(pts[0][h["shape_pt_lat"]]))) * 111320.0
        xy = [(float(r[h["shape_pt_lon"]]) * kx, float(r[h["shape_pt_lat"]]) * 110540.0) for r in pts]
        for seq in (range(len(pts)), range(len(pts) - 1, -1, -1)):
            seq = list(seq)
            while len(seq) > 3:
                a, b, c = (xy[i] for i in seq[:3])
                u = (b[0] - a[0], b[1] - a[1])
                v = (c[0] - b[0], c[1] - b[1])
                lu, lv = math.hypot(*u), math.hypot(*v)
                if lu == 0.0:
                    kill.add(id(pts[seq[0]]))
                    seq.pop(0)
                    continue
                if lu > max_len or lv == 0.0:
                    break
                if (u[0] * v[0] + u[1] * v[1]) / (lu * lv) > math.cos(math.radians(min_turn)):
                    break
                kill.add(id(pts[seq[0]]))
                seq.pop(0)
    table[1][:] = [r for r in rows if id(r) not in kill]
    return len(kill)


def merge(key: str, download: bool = False) -> dict:
    src = SOURCES[key]
    extras = src.get("extra", [])
    if not extras:
        return {}
    dst = GTFS / f"{key}.zip"
    base_p = GTFS / f"{key}.base.zip"
    if not base_p.exists():
        if dst.exists():
            dst.rename(base_p)
        elif download:
            base_p.write_bytes(fetch(src["url"]))
        else:
            raise FileNotFoundError(base_p)
    tables = read_zip(base_p)
    base_routes = ids_in(tables, "route")
    stats = {}
    for ex in extras:
        pfx = ex["prefix"]
        ep = GTFS / f"{key}+{pfx}.zip"
        if download or not ep.exists():
            print(f"download {key}+{pfx}: {ex['url']}")
            ep.write_bytes(fetch(ex["url"]))
        et = read_zip(ep)
        # parent stations for direction-specific platforms
        if ex.get("platform_suffix") and "stops.txt" in et:
            rx = re.compile(ex["platform_suffix"])
            hdr, rows = et["stops.txt"]
            for c in ("location_type", "parent_station"):
                if c not in hdr:
                    hdr.append(c)
                    for r in rows:
                        r.append("")
            h = {c: i for i, c in enumerate(hdr)}
            groups: dict[str, list] = {}
            for r in rows:
                r += [""] * (len(hdr) - len(r))
                if r[h["location_type"]].strip() in ("", "0") and not r[h["parent_station"]].strip() and rx.search(r[h["stop_name"]]):
                    groups.setdefault(rx.sub("", r[h["stop_name"]]).strip(), []).append(r)
            for name, rs in groups.items():
                pid = "P_" + re.sub(r"\W+", "_", name).strip("_")
                p = [""] * len(hdr)
                p[h["stop_id"]] = pid
                p[h["stop_name"]] = name
                p[h["stop_lat"]] = f"{sum(float(r[h['stop_lat']]) for r in rs) / len(rs):.7f}"
                p[h["stop_lon"]] = f"{sum(float(r[h['stop_lon']]) for r in rs) / len(rs):.7f}"
                p[h["location_type"]] = "1"
                for r in rs:
                    r[h["parent_station"]] = pid
                rows.append(p)
        if ex.get("trim_shape_spurs") and "shapes.txt" in et:
            trim_spurs(et["shapes.txt"])
        # prefix ids (route ids only where they collide with the base)
        keep_routes = ids_in(et, "route") - base_routes
        for fname, (hdr, rows) in et.items():
            for i, c in enumerate(hdr):
                ns = ID_COLS.get(c)
                if ns is None or (ns == "route" and all(r[i].strip() in keep_routes for r in rows if i < len(r) and r[i].strip())):
                    continue
                for r in rows:
                    if i < len(r) and r[i].strip():
                        r[i] = f"{pfx}:{r[i].strip()}"
        # concatenate with union of columns
        n = 0
        for fname in MERGE_FILES:
            if fname not in et:
                continue
            ehdr, erows = et[fname]
            if fname == "agency.txt" and "agency.txt" in tables:
                aid = {r[ehdr.index("agency_id")] for r in erows} if "agency_id" in ehdr else set()
                bh, br = tables["agency.txt"]
                have = {r[bh.index("agency_id")] for r in br} if "agency_id" in bh else set()
                erows = [r for r in erows if "agency_id" not in ehdr or r[ehdr.index("agency_id")] not in have]
                if not aid - have and not erows:
                    continue
            bhdr, brows = tables.get(fname, (list(ehdr), []))
            hdr = bhdr + [c for c in ehdr if c not in bhdr]
            bpad = [r + [""] * (len(hdr) - len(r)) for r in brows]
            em = [ehdr.index(c) if c in ehdr else -1 for c in hdr]
            rows = bpad + [[(r[j] if 0 <= j < len(r) else "") for j in em] for r in erows]
            tables[fname] = (hdr, rows)
            n += len(erows)
        stats[pfx] = dict(rows=n, routes=sorted(ids_in(et, "route")))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for fname, (hdr, rows) in tables.items():
            s = io.StringIO()
            w = csv.writer(s, lineterminator="\n")
            w.writerow(hdr)
            w.writerows(rows)
            z.writestr(fname, s.getvalue())
    dst.write_bytes(buf.getvalue())
    print(f"{key}: merged {stats} -> {dst.name}")
    return stats


def main(argv: list[str]) -> None:
    keys = [a for a in argv if not a.startswith("-")] or [k for k, s in SOURCES.items() if s.get("extra")]
    for k in keys:
        merge(k, download="--download" in argv)


if __name__ == "__main__":
    main(sys.argv[1:])
