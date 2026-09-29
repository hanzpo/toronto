"""GTFS zip reading (polars) and service-day selection."""

from __future__ import annotations

import datetime as dt
import io
import zipfile

import polars as pl

from .transit_sources import HOLIDAYS

PROFILES = ("weekday", "saturday", "sunday")
TODAY = dt.date(2026, 9, 29)


class Feed:
    def __init__(self, path) -> None:
        self.zf = zipfile.ZipFile(path)
        self.names = {n.split("/")[-1]: n for n in self.zf.namelist()}

    def has(self, name: str) -> bool:
        return name in self.names

    def read(self, name: str, columns: list[str] | None = None) -> pl.DataFrame:
        raw = self.zf.read(self.names[name])
        if raw.startswith(b"\xef\xbb\xbf"):
            raw = raw[3:]
        df = pl.read_csv(io.BytesIO(raw), infer_schema=False, truncate_ragged_lines=True, quote_char='"')
        df = df.rename({c: c.strip() for c in df.columns})
        if columns is not None:
            for c in columns:
                if c not in df.columns:
                    df = df.with_columns(pl.lit(None, dtype=pl.String).alias(c))
            df = df.select(columns)
        return df.with_columns(pl.col(pl.String).str.strip_chars())


def _dates(s: str) -> dt.date:
    return dt.date(int(s[:4]), int(s[4:6]), int(s[6:8]))


def service_calendar(feed: Feed) -> dict[dt.date, set[str]]:
    """date -> active service_ids over the feed's whole validity range."""
    active: dict[dt.date, set[str]] = {}
    if feed.has("calendar.txt"):
        cal = feed.read("calendar.txt")
        days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
        for r in cal.iter_rows(named=True):
            try:
                d0, d1 = _dates(r["start_date"]), _dates(r["end_date"])
            except (TypeError, ValueError):
                continue
            mask = [r.get(d) == "1" for d in days]
            if not any(mask):
                continue
            d = d0
            while d <= d1:
                if mask[d.weekday()]:
                    active.setdefault(d, set()).add(r["service_id"])
                d += dt.timedelta(days=1)
    if feed.has("calendar_dates.txt"):
        cd = feed.read("calendar_dates.txt", ["service_id", "date", "exception_type"])
        for sid, ds, ex in cd.iter_rows():
            try:
                d = _dates(ds)
            except (TypeError, ValueError):
                continue
            if ex == "1":
                active.setdefault(d, set()).add(sid)
            elif ex == "2" and d in active:
                active[d].discard(sid)
    return {d: s for d, s in active.items() if s}


def pick_dates(active: dict[dt.date, set[str]], trips_per_service: dict[str, int]) -> dict[str, dt.date]:
    """Representative date per profile: nearest non-holiday date to TODAY (future
    preferred) of the right weekday kind; for weekdays prefer Tue-Thu and among the
    nearest few choose the one with the most trips."""
    out = {}
    count = {d: sum(trips_per_service.get(s, 0) for s in sids) for d, sids in active.items()}
    for prof in PROFILES:
        want = {"weekday": (1, 2, 3), "saturday": (5,), "sunday": (6,)}[prof]
        cands = [d for d in active if d.weekday() in want and d.strftime("%Y%m%d") not in HOLIDAYS and count[d] > 0]
        if not cands and prof == "weekday":
            cands = [d for d in active if d.weekday() < 5 and d.strftime("%Y%m%d") not in HOLIDAYS and count[d] > 0]
        if not cands:
            continue

        def key(d):
            delta = (d - TODAY).days
            return (0 if delta >= 0 else 1, abs(delta))

        cands.sort(key=key)
        near = cands[:3]
        mx = max(count[d] for d in near)
        out[prof] = next(d for d in near if count[d] >= 0.97 * mx)
    return out


def parse_times(col: pl.Expr) -> pl.Expr:
    """'HH:MM:SS' (HH may exceed 23) -> seconds (Int32), null for empty."""
    parts = col.str.split(":")
    return (
        parts.list.get(0, null_on_oob=True).cast(pl.Int32, strict=False) * 3600
        + parts.list.get(1, null_on_oob=True).cast(pl.Int32, strict=False) * 60
        + parts.list.get(2, null_on_oob=True).cast(pl.Int32, strict=False)
    )
