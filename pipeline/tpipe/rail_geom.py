"""Canonical smoothed centrelines for tracks (and roads).

OSM draws curves as chords, so rendered track kinks at every vertex. This
module replaces each vertex by a tangent circular arc (a *fillet*) whose
radius is the class design radius, limited by the room the neighbouring
segments leave. Straights stay straight, curves become C1-continuous, and
vertices that must not move -- switches, diamonds, junctions, stroke ends --
are pinned (kept exactly, not filleted).

Everything that draws or drives on a track should use the same curve:

    from tpipe.rail_geom import fillet, RAIL_RADIUS, load_rail
    xy2, vmap = fillet(xy, pinned, RAIL_RADIUS[cls])     # any polyline
    rails = load_rail()   # the smoothed rail strokes as rendered (work/roadnet.npz)

`load_rail()` returns the rail strokes exactly as written to the render tiles
(`l_*` arrays, docs/SPEC.md): smoothed xy, solved elevation (bridges, tunnels,
grade separations; docs/ROADS.md) and the OSM way ids each stroke covers, so
the train simulation can follow the rendered rails. See docs/ROADS.md
("Rail geometry") for the contract.
"""

from __future__ import annotations

import math

import numpy as np

# design radius (m) per rail class (osm_extract RAIL_CLASS: 0 main, 1 siding/yard,
# 2 subway, 3 light rail, 4 tram, 5 other). TTC streetcar minimum radius is ~11 m
# (36 ft); main line curves in the GTA are 400-1000+ m.
RAIL_RADIUS = {0: 900.0, 1: 180.0, 2: 250.0, 3: 60.0, 4: 15.0, 5: 60.0}
# per road class (osm_extract ROAD_CLASS): motorway, trunk, primary, secondary,
# tertiary, residential, service, pedestrian, path, track; links use LINK_RADIUS
ROAD_RADIUS = {0: 900.0, 1: 400.0, 2: 150.0, 3: 120.0, 4: 80.0, 5: 30.0, 6: 12.0, 7: 10.0, 8: 8.0, 9: 20.0}
LINK_RADIUS = 70.0


def fillet(P: np.ndarray, pinned: np.ndarray | None, R: float | np.ndarray, step_deg: float = 4.0,
           max_turn_deg: float = 150.0) -> tuple[np.ndarray, np.ndarray]:
    """Round every unpinned interior vertex of polyline P (n,2) with a tangent arc.

    R: design radius (scalar or per vertex). Returns (Q, vmap): the new polyline
    and, per input vertex, the index in Q of its image (arc midpoint for filleted
    vertices, the vertex itself otherwise). First/last vertices never move."""
    P = np.asarray(P, dtype=np.float64)
    n = len(P)
    if n < 3:
        return P.copy(), np.arange(n)
    d = np.diff(P, axis=0)
    L = np.hypot(d[:, 0], d[:, 1])
    ok = L > 1e-6
    u = np.zeros_like(d)
    u[ok] = d[ok] / L[ok, None]
    c = u[:-1, 0] * u[1:, 1] - u[:-1, 1] * u[1:, 0]
    dt = (u[:-1] * u[1:]).sum(1)
    th = np.arctan2(c, dt)  # signed turn at interior vertices 1..n-2 (+ = left)
    a = np.abs(th)
    Rv = np.broadcast_to(np.asarray(R, dtype=np.float64), (n,))[1:-1]
    T = Rv * np.tan(np.minimum(a, math.radians(max_turn_deg)) / 2)
    bad = (a < math.radians(0.4)) | (a > math.radians(max_turn_deg)) | ~ok[:-1] | ~ok[1:]
    if pinned is not None:
        bad |= np.asarray(pinned[1:-1], dtype=bool)
    T[bad] = 0.0
    if not T.any():
        return P.copy(), np.arange(n)
    # share each segment between its two end vertices
    Tv = np.concatenate([[0.0], T, [0.0]])
    s = Tv[:-1] + Tv[1:]
    f = np.ones(n - 1)
    m = s > 0.98 * L
    f[m] = 0.98 * L[m] / s[m]
    Tv[1:-1] *= np.minimum(f[:-1], f[1:])
    out = [P[:1]]
    vmap = np.zeros(n, dtype=np.int64)
    k = 1
    step = math.radians(step_deg)
    for i in range(1, n - 1):
        t = Tv[i]
        if t < 0.05:
            out.append(P[i:i + 1])
            vmap[i] = k
            k += 1
            continue
        ui, uo = u[i - 1], u[i]
        ang = th[i - 1]
        r = t / math.tan(abs(ang) / 2)
        a0 = P[i] - ui * t
        sg = 1.0 if ang > 0 else -1.0
        nrm = np.array([-ui[1], ui[0]]) * sg  # toward the centre
        cen = a0 + nrm * r
        m_ = max(2, int(math.ceil(abs(ang) / step)))
        # also keep arc chords >= ~0.5 m
        m_ = max(2, min(m_, int(abs(ang) * r / 0.5) + 1))
        phi = np.linspace(0.0, ang, m_ + 1)
        v0 = a0 - cen
        cs, sn = np.cos(phi), np.sin(phi)
        pts = np.stack([cen[0] + v0[0] * cs - v0[1] * sn, cen[1] + v0[0] * sn + v0[1] * cs], 1)
        out.append(pts)
        vmap[i] = k + m_ // 2
        k += len(pts)
    out.append(P[-1:])
    vmap[-1] = k
    Q = np.vstack(out)
    # drop zero-length steps (arc ends coinciding with the next arc start)
    keep = np.ones(len(Q), dtype=bool)
    dd = np.hypot(*np.diff(Q, axis=0).T)
    keep[1:] = dd > 1e-4
    if not keep.all():
        newidx = np.cumsum(keep) - 1
        vmap = newidx[vmap]
        Q = Q[keep]
    return Q, vmap


def cumlen(P: np.ndarray) -> np.ndarray:
    s = np.zeros(len(P))
    if len(P) > 1:
        s[1:] = np.cumsum(np.hypot(*np.diff(P, axis=0).T))
    return s


def load_rail():
    """Rendered rail strokes: dict(off, xyz (world E, N, elev), cls, flags, vf, osm_off, osm).

    `osm[osm_off[i]:osm_off[i+1]]` lists the OSM way ids of stroke i in order."""
    from . import geo

    d = np.load(geo.WORK / "roadnet.npz", allow_pickle=True)
    return {k[5:]: d[k] for k in d.files if k.startswith("rail_")}
