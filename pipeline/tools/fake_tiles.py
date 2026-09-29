"""Emit a small synthetic but SPEC-exact tile dataset into app/public/data-synthetic/.

Run:  cd pipeline && uv run python tools/fake_tiles.py

Scene (~6x6 km of L0 around City Hall, 8x8 km of L1, 32x32 km of L2):
  - lake to the south (N < -2600 is water at datum 0), a river valley running
    NW->SE through the west side, rolling hills to the north
  - a street grid (200 m blocks, arterials every 1 km), an E-W motorway on a
    bridge over the valley, a diagonal main rail line, a subway (tunnel) on E=0
  - downtown towers (some with courtyards) + residential houses
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tpipe import tbn  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "app" / "public" / "data-synthetic"

TILE_SIZE = {0: 1024.0, 1: 4096.0, 2: 16384.0}
GRID = {0: 33, 1: 65, 2: 65}
GRES = 256
L0_RANGE = range(-3, 3)  # tx, ty in [-3, 2]
rng = np.random.default_rng(7)

# --------------------------------------------------------------------------- terrain


def valley_dist(e, n):
    # distance to the river line from (-2600, 3000) to (-1200, -2600)
    ax, ay, bx, by = -2600.0, 3000.0, -1200.0, -2600.0
    dx, dy = bx - ax, by - ay
    t = np.clip(((e - ax) * dx + (n - ay) * dy) / (dx * dx + dy * dy), 0, 1)
    px, py = ax + t * dx, ay + t * dy
    return np.hypot(e - px, n - py)


def height(e, n):
    e = np.asarray(e, dtype=np.float64)
    n = np.asarray(n, dtype=np.float64)
    base = np.clip((n + 2600.0) * 0.018, 0, None)  # rises northward from the lake
    base = base + 12 * np.sin(e / 1700.0) * np.cos(n / 2100.0) * (n > -2000)
    base = base + 0.00000035 * np.clip(n, 0, None) ** 2
    v = valley_dist(e, n)
    base = base - np.clip(35 - v * 0.12, 0, None) * (n > -2600)
    shore = n < -2600
    return np.where(shore, np.minimum(base, 0.0) * 0.0, np.maximum(base, 0.4))


def ground_class(e, n):
    h = height(e, n)
    c = np.full(e.shape, 4, np.uint8)  # residential
    c[(np.abs(e) < 900) & (np.abs(n + 600) < 900)] = 5  # downtown commercial
    c[(e > 1500) & (n < -1200)] = 6  # industrial
    c[(n > 1800) & (e > 800)] = 7  # farmland
    v = valley_dist(e, n)
    c[v < 260] = 3  # forest in valley
    c[v < 120] = 2  # park
    c[(np.hypot(e - 600, n - 900) < 250)] = 2  # a park
    c[(np.hypot(e + 300, n - 2200) < 300)] = 13  # golf
    c[(n < -2600) & (n > -2660)] = 8  # beach
    c[v < 18] = 1  # river
    c[n <= -2660] = 1  # lake
    c[(np.abs(e) > 3072 + 2048) | (np.abs(n) > 3072 + 2048)] = np.where(h > 0.5, 7, 1)[
        (np.abs(e) > 3072 + 2048) | (np.abs(n) > 3072 + 2048)
    ]
    # roads burned into raster
    road = (np.abs(((e + 100) % 200) - 100) < 5) | (np.abs(((n + 100) % 200) - 100) < 5)
    c[road & (c != 1) & (np.abs(e) < 3200) & (np.abs(n) < 3200)] = 9
    c[np.abs(n + 1800) < 14] = np.where(c[np.abs(n + 1800) < 14] == 1, 1, 15)
    return c


# --------------------------------------------------------------------------- features (world coords)

buildings = []  # dict(ring=[(e,n)...], holes=[...], h, min, kind, roof, color, osm)
houses = []
roads = []  # dict(pts=[(e,n,z)], cls, width, lanes, flags, osm)
rails = []

osm_id = 1000


def nid():
    global osm_id
    osm_id += 1
    return osm_id


def rect(cx, cy, w, d, ang=0.0):
    c, s = math.cos(ang), math.sin(ang)
    pts = []
    for x, y in ((-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2)):
        pts.append((cx + x * c - y * s, cy + x * s + y * c))
    return pts


# downtown towers
for bx in range(-4, 4):
    for by in range(-7, 2):
        cx, cy = bx * 200 + 100, by * 200 + 100
        if abs(cx) > 900 or abs(cy + 600) > 900:
            continue
        for k in range(rng.integers(1, 4)):
            ox, oy = rng.uniform(-45, 45, 2)
            w, d = rng.uniform(25, 60, 2)
            dist = math.hypot(cx, cy + 600)
            h = float(rng.uniform(20, 60) + max(0, 250 - dist * 0.25) * rng.uniform(0.3, 1.0))
            b = dict(ring=rect(cx + ox, cy + oy, w, d, rng.uniform(-0.05, 0.05)), holes=[], h=h,
                     min=0.0, kind=int(rng.choice([3, 3, 2, 13, 4])), roof=0, color=0, osm=nid())
            if k == 0 and rng.random() < 0.25:
                b["ring"] = rect(cx, cy, 90, 90)
                b["holes"] = [rect(cx, cy, 40, 40)[::-1]]
                b["h"] = 24.0
                b["kind"] = 6
            buildings.append(b)
# a couple of pitched-roof civic buildings + an overhang canopy
buildings.append(dict(ring=rect(-400, 300, 60, 30, 0.3), holes=[], h=18.0, min=0, kind=8, roof=1, color=0xC9B79C, osm=nid()))
buildings.append(dict(ring=rect(300, 450, 40, 40), holes=[], h=22.0, min=0, kind=6, roof=3, color=0, osm=nid()))
buildings.append(dict(ring=rect(-150, 480, 34, 22), holes=[], h=14.0, min=0, kind=7, roof=2, color=0, osm=nid()))
buildings.append(dict(ring=rect(150, 520, 20, 20), holes=[], h=16.0, min=0, kind=6, roof=4, color=0, osm=nid()))
buildings.append(dict(ring=rect(-700, -1000, 40, 18), holes=[], h=9.0, min=5.0, kind=15, roof=0, color=0, osm=nid()))
buildings.append(dict(ring=rect(-700, -1300, 16, 16), holes=[], h=30.0, min=0, kind=6, roof=5, color=0, osm=nid()))
# warehouses
for i in range(30):
    cx, cy = rng.uniform(1600, 2900), rng.uniform(-2400, -1300)
    buildings.append(dict(ring=rect(cx, cy, rng.uniform(40, 120), rng.uniform(30, 80)), holes=[],
                          h=float(rng.uniform(7, 14)), min=0.0, kind=5, roof=0, color=0, osm=nid()))

# houses in residential areas
for bx in range(-15, 15):
    for by in range(-12, 15):
        cx, cy = bx * 200 + 100, by * 200 + 100
        if abs(cx) < 950 and abs(cy + 600) < 950:
            continue
        if valley_dist(np.array(cx), np.array(cy)) < 300 or cy < -2500:
            continue
        if cx > 1500 and cy < -1200:
            continue
        if cy > 1800 and cx > 800:
            continue
        for side in (-1, 1):
            for k in range(-7, 8):
                x = cx + k * 11.5
                y = cy + side * 55
                t = int(rng.choice([0, 0, 0, 1, 2, 3, 4, 5]))
                ln, wd, hh = {0: (12, 9, 8), 1: (16, 12, 10), 2: (13, 7, 9), 3: (10, 6.5, 10), 4: (12, 10, 5.5), 5: (6, 4, 3.5)}[t]
                ang = math.pi / 2 + rng.normal(0, 0.03)
                houses.append(dict(e=x, n=y, ang=ang, len=ln * rng.uniform(0.9, 1.1), wid=wd * rng.uniform(0.9, 1.1),
                                   h=hh * rng.uniform(0.9, 1.15), type=t, var=int(rng.integers(0, 256)), osm=nid()))


def line(pts, step=8.0):
    out = []
    for (x0, y0), (x1, y1) in zip(pts[:-1], pts[1:]):
        L = math.hypot(x1 - x0, y1 - y0)
        k = max(1, int(math.ceil(L / step)))
        for i in range(k):
            t = i / k
            out.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))
    out.append(pts[-1])
    return out


def drape(pts, bridge=False):
    if not bridge:
        return [(x, y, float(height(x, y)) + 0.0) for x, y in pts]
    z0 = float(height(*pts[0]))
    z1 = float(height(*pts[-1]))
    n = len(pts) - 1
    return [(x, y, z0 + (z1 - z0) * i / max(1, n)) for i, (x, y) in enumerate(pts)]


# street grid
for i in range(-15, 16):
    c = i * 200
    cls = 2 if i % 5 == 0 else 5
    w = 18 if cls == 2 else 8
    roads.append(dict(pts=drape(line([(c, -2580), (c, 3000)])), cls=cls, width=w, lanes=4 if cls == 2 else 2, flags=0, osm=nid()))
    roads.append(dict(pts=drape(line([(-3000, c), (3000, c)])), cls=cls, width=w, lanes=4 if cls == 2 else 2, flags=0, osm=nid()))
# motorway with a bridge over the valley
vx = -1200 - 1400 * ((-1800 + 2600) / 5600.0)  # valley x at N=-1800 approx
mw = [(-3000, -1800), (vx - 350, -1800)]
roads.append(dict(pts=drape(line(mw)), cls=0, width=26, lanes=6, flags=0, osm=nid()))
roads.append(dict(pts=drape(line([(vx - 350, -1800), (vx + 350, -1800)]), bridge=True), cls=0, width=26, lanes=6, flags=2, osm=nid()))
roads.append(dict(pts=drape(line([(vx + 350, -1800), (3000, -1800)])), cls=0, width=26, lanes=6, flags=0, osm=nid()))
# a curved trunk road
curve = [(-3000 + t * 60, 2600 - 800 * math.sin(t / 30)) for t in range(0, 101)]
roads.append(dict(pts=drape(line(curve)), cls=1, width=16, lanes=4, flags=0, osm=nid()))
# rail: diagonal main line + subway tunnel on E=0
rails.append(dict(pts=drape(line([(-3000, -2400), (0, -1500), (3000, 1500)])), cls=0, flags=0, osm=nid()))
rails.append(dict(pts=[(x, y, z - 15) for x, y, z in drape(line([(0, -1600), (0, 3000)]))], cls=2, flags=4, osm=nid()))
rails.append(dict(pts=drape(line([(-3000, -1000), (3000, -1000)])), cls=4, flags=0, osm=nid()))

# --------------------------------------------------------------------------- tiling


def clip_polyline(pts, x0, y0, x1, y1):
    """Split a (dense) polyline into pieces inside [x0,x1)x[y0,y1] with interpolated boundary points."""
    pieces, cur = [], []

    def inside(p):
        return x0 <= p[0] <= x1 and y0 <= p[1] <= y1

    for a, b in zip(pts[:-1], pts[1:]):
        ia, ib = inside(a), inside(b)
        if ia and not cur:
            cur.append(a)
        if ia and ib:
            cur.append(b)
            continue
        # find crossing parameter(s)
        ts = []
        for axis, lo, hi in ((0, x0, x1), (1, y0, y1)):
            d = b[axis] - a[axis]
            if d != 0:
                for bound in (lo, hi):
                    t = (bound - a[axis]) / d
                    if 0 < t < 1:
                        ts.append(t)
        ts.sort()
        for t in ts:
            p = tuple(a[k] + (b[k] - a[k]) * t for k in range(3))
            p = (min(max(p[0], x0), x1), min(max(p[1], y0), y1), p[2])
            if cur:
                cur.append(p)
                pieces.append(cur)
                cur = []
            else:
                cur = [p]
        if ib and cur:
            cur.append(b)
        elif not ib and cur:
            if len(cur) > 1:
                pieces.append(cur)
            cur = []
    if len(cur) > 1:
        pieces.append(cur)
    return [p for p in pieces if len(p) >= 2]


def simplify(pts, step):
    if len(pts) <= 2:
        return pts
    out = [pts[0]]
    acc = 0.0
    for a, b in zip(pts[:-1], pts[1:]):
        acc += math.hypot(b[0] - a[0], b[1] - a[1])
        if acc >= step:
            out.append(b)
            acc = 0.0
    if out[-1] != pts[-1]:
        out.append(pts[-1])
    return out


def write_tile(L, tx, ty):
    S = TILE_SIZE[L]
    G = GRID[L]
    ox, oy = tx * S, ty * S
    ii = np.arange(G) * S / (G - 1)
    ee, nn = np.meshgrid(ox + ii, oy + ii)  # [j, i]
    th = np.round(height(ee, nn) * 10).astype(np.int16).ravel()
    pc = (np.arange(GRES) + 0.5) * S / GRES
    pe, pn = np.meshgrid(ox + pc, oy + pc)
    ground = ground_class(pe, pn).astype(np.uint8).ravel()

    arrays: dict[str, np.ndarray] = {"terrain_h": th, "ground": ground}

    min_h = {0: 0, 1: 12, 2: 35}[L]
    bsel = []
    for b in buildings:
        ring = np.array(b["ring"])
        cx, cy = ring.mean(0)
        if ox <= cx < ox + S and oy <= cy < oy + S and b["h"] >= min_h:
            bsel.append(b)
    ring_off, vert_off, xy = [0], [0], []
    bh, bm, bb, bk, br, bc, bo = [], [], [], [], [], [], []
    for b in bsel:
        rings = [b["ring"]] + b["holes"]
        for r in rings:
            for x, y in r:
                xy += [x - ox, y - oy]
            vert_off.append(len(xy) // 2)
        ring_off.append(len(vert_off) - 1)
        ring = np.array(b["ring"])
        bh.append(b["h"]); bm.append(b["min"])
        bb.append(float(np.min(height(ring[:, 0], ring[:, 1]))))
        bk.append(b["kind"]); br.append(b["roof"]); bc.append(b["color"]); bo.append(b["osm"])
    arrays.update(
        b_ring_off=np.array(ring_off, np.uint32), b_vert_off=np.array(vert_off, np.uint32),
        b_xy=np.array(xy, np.float32), b_height=np.array(bh, np.float32), b_min=np.array(bm, np.float32),
        b_base=np.array(bb, np.float32), b_kind=np.array(bk, np.uint8), b_roof=np.array(br, np.uint8),
        b_color=np.array(bc, np.uint32), b_osm=np.array(bo, np.float64),
    )

    if L == 0:
        hs = [h for h in houses if ox <= h["e"] < ox + S and oy <= h["n"] < oy + S]
        arrays.update(
            h_xy=np.array([v for h in hs for v in (h["e"] - ox, h["n"] - oy)], np.float32),
            h_angle=np.array([h["ang"] for h in hs], np.float32),
            h_len=np.array([h["len"] for h in hs], np.float32),
            h_wid=np.array([h["wid"] for h in hs], np.float32),
            h_height=np.array([h["h"] for h in hs], np.float32),
            h_base=np.array([float(height(h["e"], h["n"])) for h in hs], np.float32),
            h_type=np.array([h["type"] for h in hs], np.uint8),
            h_var=np.array([h["var"] for h in hs], np.uint8),
            h_osm=np.array([h["osm"] for h in hs], np.float64),
        )

    max_cls = {0: 99, 1: 3, 2: 1}[L]
    step = {0: 0, 1: 64, 2: 256}[L]
    r_off, r_xyz, r_cls, r_w, r_lanes, r_flags, r_layer, r_name, r_osm = [0], [], [], [], [], [], [], [], []
    for r in roads:
        if r["cls"] > max_cls:
            continue
        for piece in clip_polyline(r["pts"], ox, oy, ox + S, oy + S):
            if step:
                piece = simplify(piece, step)
            for x, y, z in piece:
                r_xyz += [x - ox, y - oy, z]
            r_off.append(len(r_xyz) // 3)
            r_cls.append(r["cls"]); r_w.append(r["width"]); r_lanes.append(r["lanes"])
            r_flags.append(r["flags"]); r_layer.append(1 if r["flags"] & 2 else 0)
            r_name.append(0 if r["cls"] == 0 else 0xFFFF); r_osm.append(r["osm"])
    arrays.update(
        r_off=np.array(r_off, np.uint32), r_xyz=np.array(r_xyz, np.float32), r_class=np.array(r_cls, np.uint8),
        r_width=np.array(r_w, np.float32), r_lanes=np.array(r_lanes, np.uint8), r_flags=np.array(r_flags, np.uint8),
        r_layer=np.array(r_layer, np.int8), r_name=np.array(r_name, np.uint16), r_osm=np.array(r_osm, np.float64),
    )
    l_off, l_xyz, l_cls, l_flags, l_osm = [0], [], [], [], []
    for r in rails:
        if L > 0 and r["cls"] not in (0, 2, 3):
            continue
        if L == 2 and r["cls"] != 0:
            continue
        for piece in clip_polyline(r["pts"], ox, oy, ox + S, oy + S):
            if step:
                piece = simplify(piece, step)
            for x, y, z in piece:
                l_xyz += [x - ox, y - oy, z]
            l_off.append(len(l_xyz) // 3)
            l_cls.append(r["cls"]); l_flags.append(r["flags"]); l_osm.append(r["osm"])
    arrays.update(
        l_off=np.array(l_off, np.uint32), l_xyz=np.array(l_xyz, np.float32), l_class=np.array(l_cls, np.uint8),
        l_flags=np.array(l_flags, np.uint8), l_osm=np.array(l_osm, np.float64),
    )
    tbn.write(OUT / "tiles" / str(L) / f"{tx}_{ty}.bin.gz", arrays, names=["Synthetic Expressway"],
              level=L, tx=tx, ty=ty)


def main():
    tiles = {"0": [], "1": [], "2": []}
    for tx in L0_RANGE:
        for ty in L0_RANGE:
            write_tile(0, tx, ty)
            tiles["0"].append([tx, ty])
    for tx in (-2, -1, 0, 1):
        for ty in (-2, -1, 0, 1):
            write_tile(1, tx, ty)
            tiles["1"].append([tx, ty])
    for tx in (-1, 0):
        for ty in (-1, 0):
            write_tile(2, tx, ty)
            tiles["2"].append([tx, ty])
    manifest = {
        "version": 1,
        "synthetic": True,
        "projection": "+proj=tmerc +lat_0=43.6532 +lon_0=-79.3832 +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs",
        "origin": [43.6532, -79.3832],
        "datum": 75,
        "tileSize": {k: v for k, v in {"0": 1024, "1": 4096, "2": 16384}.items()},
        "terrainGrid": {"0": 33, "1": 65, "2": 65},
        "groundRes": GRES,
        "bounds": [-16384, -16384, 16384, 16384],
        "tiles": tiles,
        "region": [[[-16384, -16384], [16384, -16384], [16384, 16384], [-16384, 16384]]],
        "municipalities": [{"name": "Synthetic Toronto", "label": [0, 0]}],
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "manifest.json").write_text(json.dumps(manifest))
    (OUT / "landmarks.json").write_text(json.dumps([]))
    print(f"wrote {sum(len(v) for v in tiles.values())} tiles, {len(buildings)} buildings, {len(houses)} houses -> {OUT}")


if __name__ == "__main__":
    main()
