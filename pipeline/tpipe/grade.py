"""Vertical profiles for linear features (roads, rail, transit shapes).

Surface vertices sit on the terrain. Bridge runs are interpolated between the
run's anchor points (so viaducts span valleys) and kept at least `clearance`
above ground; tunnel runs are interpolated and kept `cover` below ground.
Clearance/cover ramp in over `ramp` metres from each end of the run.
"""

from __future__ import annotations

import numpy as np


def densify(xy: np.ndarray, step: float) -> tuple[np.ndarray, np.ndarray]:
    """Insert points so no segment exceeds `step`. Returns (xy, src_segment)
    where src_segment[k] is the original segment index vertex k lies on."""
    out = [xy[:1]]
    seg = [np.zeros(1, dtype=np.int32)]
    for i in range(len(xy) - 1):
        a, b = xy[i], xy[i + 1]
        n = max(1, int(np.ceil(np.hypot(*(b - a)) / step)))
        t = (np.arange(1, n + 1) / n)[:, None]
        out.append(a + (b - a) * t)
        seg.append(np.full(n, i, dtype=np.int32))
    return np.vstack(out), np.concatenate(seg)


def _runs(mask: np.ndarray):
    i, n = 0, len(mask)
    while i < n:
        if mask[i]:
            j = i
            while j + 1 < n and mask[j + 1]:
                j += 1
            yield i, j
            i = j + 1
        else:
            i += 1


def profile(
    xy: np.ndarray,
    ground: np.ndarray,
    bridge: np.ndarray | None = None,
    tunnel: np.ndarray | None = None,
    clearance: float = 6.0,
    cover: float = 10.0,
    ramp: float = 80.0,
    open_ends: bool = False,
) -> np.ndarray:
    """Elevation per vertex. `bridge`/`tunnel` are per-vertex bool masks.

    With `open_ends`, a run touching the first/last vertex continues past the
    end of the line (e.g. a subway terminus underground) instead of ramping
    back to the surface there."""
    z = ground.astype(np.float64).copy()
    if len(xy) < 2:
        return z
    d = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(xy, axis=0).T))])
    for mask, sign, amount in ((bridge, 1.0, clearance), (tunnel, -1.0, cover)):
        if mask is None or not mask.any():
            continue
        for i, j in _runs(mask):
            a = max(i - 1, 0)
            b = min(j + 1, len(xy) - 1)
            has_a = not open_ends or i > 0
            has_b = not open_ends or j < len(xy) - 1
            seg = d[i : j + 1]
            if has_a and has_b:
                span = d[b] - d[a]
                t = (seg - d[a]) / span if span > 0 else np.zeros(j - i + 1)
                interp = ground[a] + (ground[b] - ground[a]) * t
            else:  # an end is open: follow the terrain, ramping only at closed ends
                interp = None
            edge = np.minimum(seg - d[a] if has_a else np.inf, d[b] - seg if has_b else np.inf)
            k = np.clip(edge / ramp, 0.0, 1.0) if ramp > 0 else 1.0
            target = ground[i : j + 1] + sign * amount * k
            if interp is None:
                z[i : j + 1] = target
            else:
                z[i : j + 1] = np.maximum(interp, target) if sign > 0 else np.minimum(interp, target)
    return z
