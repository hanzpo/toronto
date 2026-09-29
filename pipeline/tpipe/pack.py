"""Bundle tiles into one pack per level-2 tile for hosting on R2.

Each pack holds the L2 tile plus all its L1/L0 descendants, concatenated;
`{tx2}_{ty2}.idx.json` maps "L/tx_ty" -> [offset, length]. Road-graph tiles
are packed the same way as `g{tx2}_{ty2}` (keys "0/tx_ty"). The Worker serves
/data/tiles/L/tx_ty.bin.gz and /data/graph/tx_ty.bin.gz by range-reading packs, so URLs are identical
in dev (plain files) and production (packs). ~225 objects instead of ~16k.

    uv run python -m tpipe.pack [out_dir]
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

from . import geo


def parent_l2(level: int, tx: int, ty: int) -> tuple[int, int]:
    f = 4 ** (2 - level)
    return math.floor(tx / f), math.floor(ty / f)


def main(out: Path) -> None:
    manifest = json.loads((geo.OUT / "manifest.json").read_text())
    groups: dict[tuple[int, int], list[tuple[int, int, int]]] = {}
    for lv, tiles in manifest["tiles"].items():
        for tx, ty in tiles:
            groups.setdefault(parent_l2(int(lv), tx, ty), []).append((int(lv), tx, ty))
    write_packs(out, groups, lambda lv, tx, ty: geo.OUT / "tiles" / str(lv) / f"{tx}_{ty}.bin.gz", "")
    # road graph (level-0 grid) -> graph packs, keys "g/tx_ty"
    ggroups: dict[tuple[int, int], list[tuple[int, int, int]]] = {}
    for f in (geo.OUT / "graph").glob("*.bin.gz"):
        tx, ty = map(int, f.name.split(".")[0].split("_"))
        ggroups.setdefault(parent_l2(0, tx, ty), []).append((0, tx, ty))
    write_packs(out, ggroups, lambda lv, tx, ty: geo.OUT / "graph" / f"{tx}_{ty}.bin.gz", "g")


def write_packs(out: Path, groups, path_of, prefix: str) -> None:
    out.mkdir(parents=True, exist_ok=True)
    total = 0
    for (px, py), tiles in sorted(groups.items()):
        index = {}
        off = 0
        name = f"{prefix}{px}_{py}"
        with open(out / f"{name}.pack", "wb") as f:
            for lv, tx, ty in sorted(tiles, key=lambda t: (-t[0], t[1], t[2])):
                data = path_of(lv, tx, ty).read_bytes()
                f.write(data)
                index[f"{lv}/{tx}_{ty}"] = [off, len(data)]
                off += len(data)
        (out / f"{name}.idx.json").write_text(json.dumps(index, separators=(",", ":")))
        total += off
    print(f"{len(groups)} {prefix or 'tile'} packs, {total / 1e6:.0f} MB -> {out}")


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else geo.WORK / "packs")
