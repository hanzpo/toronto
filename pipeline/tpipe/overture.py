"""Download Overture Maps buildings that carry a height or floor count, for
the processing bbox, into raw/overture/buildings_heights.parquet (~15 min)."""

from __future__ import annotations

import duckdb

from . import geo

RELEASE = "2026-09-23.1"


def main() -> None:
    w, s, e, n = geo.BBOX_LONLAT
    out = geo.RAW / "overture" / "buildings_heights.parquet"
    out.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2'")
    con.execute(f"""
        COPY (
          SELECT id, height, num_floors, ST_AsWKB(geometry) AS wkb
          FROM read_parquet('s3://overturemaps-us-west-2/release/{RELEASE}/theme=buildings/type=building/*',
                            hive_partitioning=1)
          WHERE bbox.xmin > {w} AND bbox.xmax < {e} AND bbox.ymin > {s} AND bbox.ymax < {n}
            AND (height IS NOT NULL OR num_floors IS NOT NULL)
        ) TO '{out}' (FORMAT PARQUET)
    """)
    print(con.execute(f"select count(*) from '{out}'").fetchone())


if __name__ == "__main__":
    main()
