"""Primitive-network geometry (docs/NETWORK.md, INTERSECTIONS.md): sections, sweeps, node meshes.

The structure (Cities: Skylines-style):
  * a SECTION is the ordered list of band-boundary offsets U (signed lateral, + left of the edge
    direction) at one station s of an edge: building line left, the left edge of every band,
    the right edge of the last band, building line right (nb + 3 values), with the station's
    centre point, normal and model z. `section(e, s)` is the only function that produces one.
  * an edge's SWEEP is its sections at stations s0 .. s1 (exactly the two leg setbacks, <= 2 m
    apart in between, plus the crosswalk stations). Sweep row 0 / row -1 IS the LEG RING of the
    edge at its a / b node: the node mesh never recomputes those points, it references them
    (the client builds both from the same exported row: net2/gen.ts legRing()).
  * a NODE MESH is generated only from its legs' rings: junction -> box (the carriageway points
    of every ring joined by curb returns), corner sidewalks and corner frontage between rings;
    continuation (2 legs) -> a transition band-by-band (or by semantic strips when the band sets
    differ) over >= 15 m; end -> nothing. Setbacks grow (logged) until the curves don't cross.
  * the pedestrian mesh is built from the same rows: sidewalk centrelines per sweep, corner
    links between ring sidewalk centres, crosswalk paths at the crosswalk stations.
"""
from __future__ import annotations

import math
from collections import defaultdict

import numpy as np

from .rail_geom import cumlen

H_WALK = 0.15
ROW_NOSE = 6.0          # m from a junction ring: the transit_row (and its curbs) is flush (nose)
CW_OFF = 1.8            # m: crosswalk centre beyond the ring
STOP_OFF = 4.4          # m: stop bar beyond the ring
TRANSITION = 7.5        # m per side at continuation nodes (>= 15 m taper)
RAISED = {"sidewalk", "furniture", "boulevard", "curb", "frontage", "frontage_walk", "building_edge", "transit_row", "median"}
FRONT_CAP = 4.5         # m: frontage modelled up to this (walk extension + building-edge zone)
EDGE_ZONE = 1.2         # m: building-edge zone at the facade (max)
PARALLEL = math.radians(15)   # adjacent legs closer than this in angle share no corner
MAX_GROW = 6.0          # m: setback growth beyond 2 x the carriageway half width


# ------------------------------------------------------------------ sections
def prepare(e, a):
    """per-station arrays on the edge's resampled model centreline (2 m)"""
    G = e["geom"]
    s = e["s"]
    t = np.gradient(G[:, :2], axis=0) if len(G) > 1 else np.array([[1.0, 0.0]])
    t /= np.maximum(np.hypot(t[:, 0], t[:, 1]), 1e-9)[:, None]
    n = np.stack([-t[:, 1], t[:, 0]], 1)
    Lf, W = e["band_left"], e["band_w"]
    fr = e.get("frontage") or [np.zeros(len(s)), np.zeros(len(s))]
    # frontage cross-section (CROSS_SECTION.md): the walk continues (clearway extension) and a
    # building-edge zone (patios, forecourts, entrances, loading) sits against the facade; capped
    # at FRONT_CAP -- beyond it the ground follows what is mapped
    zones = []
    for f in fr:
        f = np.minimum(np.asarray(f, np.float64), FRONT_CAP)
        edge = np.where(f > 1.5, np.minimum(EDGE_ZONE, 0.3 * f), 0.0)
        zones.append((f - edge, edge))
    (wl, el), (wr, er) = zones
    L0 = Lf[:, 0]
    R0 = Lf[:, -1] - W[:, -1]
    U = np.column_stack([L0 + wl + el, L0 + wl, Lf, R0, R0 - wr, R0 - wr - er])
    e["_p"] = dict(s=s, G=G, n=n, U=U)
    tram = any("tram" in b.get("classes", []) or b["kind"] == "transit_row" for b in a["bands"])
    e["_radius"] = 13.0 if tram else float(a.get("curb_radius", 7.0))
    kinds = ["building_edge", "frontage_walk"] + [b["kind"] for b in a["bands"]] + ["frontage_walk", "building_edge"]
    e["_kinds"] = kinds
    curbs = [i for i, b in enumerate(a["bands"]) if b["kind"] == "curb"]
    nb = len(a["bands"])
    row = [i for i, b in enumerate(a["bands"]) if b["kind"] == "transit_row"]
    row_set = set()
    for r in row:
        row_set |= {r, r - 1 if r > 0 and a["bands"][r - 1]["kind"] == "curb" else r,
                    r + 1 if r + 1 < nb and a["bands"][r + 1]["kind"] == "curb" else r}
    outer_curbs = [c for c in curbs if c not in row_set]
    # boundary indices in edge order (U index)
    # U index of band bi's left edge = bi + 2 (two frontage boundaries on the left)
    cwL = outer_curbs[0] + 3 if outer_curbs else 2
    cwR = outer_curbs[-1] + 2 if outer_curbs else nb + 2
    if not outer_curbs or cwL > cwR:
        cwL, cwR = 2, nb + 2
    sw = [i for i, b in enumerate(a["bands"]) if b["kind"] == "sidewalk"]
    e["_idx"] = dict(nb=nb, bldgL=0, walkL=2, cwL=cwL, cwR=cwR, walkR=nb + 2, bldgR=nb + 4,
                     swL=[i for i in sw if i + 3 <= cwL], swR=[i for i in sw if i + 2 >= cwR], row=sorted(row_set))
    if e.get("internal"):          # a piece inside a junction: carriageway fill only (no walks / frontage)
        U = e["_p"]["U"]
        U[:, :cwL] = U[:, cwL:cwL + 1]
        U[:, cwR + 1:] = U[:, cwR:cwR + 1]
        e["_idx"]["swL"], e["_idx"]["swR"] = [], []


def section(e, s):
    """centre (x, y, z), normal (nx, ny) and U at arclength s (linear interpolation)"""
    P = e["_p"]
    sv = P["s"]
    s = float(np.clip(s, sv[0], sv[-1]))
    k = int(np.clip(np.searchsorted(sv, s) - 1, 0, len(sv) - 2)) if len(sv) > 1 else 0
    if len(sv) == 1:
        return P["G"][0].copy(), P["n"][0].copy(), P["U"][0].copy()
    f = (s - sv[k]) / max(sv[k + 1] - sv[k], 1e-9)
    c = P["G"][k] * (1 - f) + P["G"][k + 1] * f
    n = P["n"][k] * (1 - f) + P["n"][k + 1] * f
    n /= max(np.hypot(*n), 1e-9)
    U = P["U"][k] * (1 - f) + P["U"][k + 1] * f
    return c, n, U


def heights(e, s, s0, s1, junc0, junc1):
    """per interval top height (nb + 2 intervals: frontage, bands..., frontage)"""
    kinds = e["_kinds"]
    rowb = set(i + 2 for i in e["_idx"]["row"])        # interval index = band index + 2
    near = (junc0 and s - s0 < ROW_NOSE) or (junc1 and s1 - s < ROW_NOSE)
    h = []
    for j, k in enumerate(kinds):
        if j in rowb and near:
            h.append(0.0)
        else:
            h.append(H_WALK if k in RAISED else 0.0)
    return h


# ------------------------------------------------------------------ sweeps
def sweep(e, s0, s1, extra, junc0, junc1):
    """sections at s0, s1 (exact), interior stations <= 2 m apart, plus `extra` stations"""
    sv = e["_p"]["s"]
    st = [s0] + [float(x) for x in sv if s0 + 0.05 < x < s1 - 0.05] + [s1]
    st += [x for x in extra if s0 + 0.05 < x < s1 - 0.05]
    st = sorted(set(round(x, 4) for x in st))
    rows = []
    for x in st:
        c, n, U = section(e, x)
        rows.append(dict(s=x, c=c, n=n, U=U, H=heights(e, x, s0, s1, junc0, junc1)))
    return rows


def ring_of(e, end):
    """leg ring (leaving order, left to right) from the sweep's first / last row:
    points (xy), z, U index map in leaving order, leaving tangent"""
    rows = e["_rows"]
    r = rows[0] if end == 0 else rows[-1]
    c, n, U = r["c"], r["n"], r["U"]
    pts = c[:2][None, :] + n[None, :] * U[:, None]
    t = np.array([n[1], -n[0]])                 # edge direction
    idx = dict(e["_idx"])
    m = len(U) - 1
    if end == 1:
        pts = pts[::-1]
        t = -t
        flip = lambda j: m - j  # noqa: E731
        idx = dict(idx, bldgL=flip(e["_idx"]["bldgR"]), walkL=flip(e["_idx"]["walkR"]), cwL=flip(e["_idx"]["cwR"]),
                   cwR=flip(e["_idx"]["cwL"]), walkR=flip(e["_idx"]["walkL"]), bldgR=flip(e["_idx"]["bldgL"]),
                   swL=e["_idx"]["swR"], swR=e["_idx"]["swL"])
    # leaving grade (dz/ds away from the node): the corner curves' vertical curves start on it
    r2 = (rows[1] if end == 0 else rows[-2]) if len(rows) > 1 else r
    ds = abs(float(r2["s"]) - float(r["s"]))
    g = float(np.clip((float(r2["c"][2]) - float(c[2])) / ds, -GRADE_MAX, GRADE_MAX)) if (len(rows) > 1 and ds > 0.05) else 0.0
    return dict(pts=pts, z=float(c[2]), g=g, idx=idx, t=t, end=end, edge=e)


GRADE_MAX = 0.12        # |dz/ds| used for the corner vertical curves


def curve_z(A, mid, B, za, ga, zb, gb):
    """heights of a corner curve's interior points (mid) from ring A to ring B: cubic Hermite over
    arc length, leaving A into the node (slope -ga) and B out along its leg (slope gb) -- the
    curb / walk / building-line profile is G1 with both legs' grades, not a straight ramp."""
    mid = np.asarray(mid, dtype=np.float64).reshape(-1, 2)
    if len(mid) == 0:
        return np.zeros(0)
    P = np.vstack([np.asarray(A, float)[:2], mid, np.asarray(B, float)[:2]])
    sl = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(P, axis=0).T))])
    L = sl[-1] if sl[-1] > 0 else 1.0
    u = sl[1:-1] / L
    return (2 * u**3 - 3 * u**2 + 1) * za + (u**3 - 2 * u**2 + u) * L * -ga + (-2 * u**3 + 3 * u**2) * zb + (u**3 - u**2) * L * gb


def sw_centres(e, row, left):
    """sidewalk band centre points (edge order) of one row, left or right side"""
    c, n, U = row["c"], row["n"], row["U"]
    out = []
    for b in (e["_idx"]["swL"] if left else e["_idx"]["swR"]):
        u = (U[b + 2] + U[b + 3]) / 2
        out.append(c[:2] + n * u)
    return out


# ------------------------------------------------------------------ node meshes
def _curve(A, tA, B, tB, n=8):
    """quadratic curve A -> B, control at the intersection of the two leaving lines (behind both rings)"""
    den = tA[0] * tB[1] - tA[1] * tB[0]
    C = (A + B) / 2
    if abs(den) > 1e-3:
        lam = ((B[0] - A[0]) * tB[1] - (B[1] - A[1]) * tB[0]) / den
        mu = ((B[0] - A[0]) * tA[1] - (B[1] - A[1]) * tA[0]) / den
        if -80 < lam < 0.5 and -80 < mu < 0.5:
            C = A + tA * lam
    t = np.linspace(0, 1, n + 2)[1:-1, None]
    return (1 - t) ** 2 * A + 2 * (1 - t) * t * C + t ** 2 * B


def ring_angle(nd):
    """order legs by the direction from the node centre to their ring centre (the ring as it is,
    after setbacks), which stays consistent with the geometry where leaving tangents cross"""
    c = np.asarray(nd["xyz"][:2], np.float64)
    def key(R):
        m = R["pts"].mean(0) - c
        return math.atan2(m[1], m[0])
    return key


ARC_STEP = 0.5          # m: curb-return sampling (and <= 5 degrees)


SKEW_DEG = 20.0          # corner angle more than this off 90 deg: three-centred compound curve
COMPOUND = ((2.0, 0.2), (1.0, 0.6), (2.0, 0.2))     # (radius factor, share of the deflection): 2R-R-2R


def _compound(uA, uB, X, delta, R, la, lb):
    """symmetric three-centred compound curb curve (AASHTO skewed-intersection practice): radii
    2R, R, 2R over 20 / 60 / 20 % of the deflection, so the long entry and exit arcs follow the
    design vehicle's swept path on a skewed corner. Built in a local frame (start heading +x,
    turning +y), scaled down where the rings leave less than the tangent length. Returns (T1, T2,
    interior curve points) or None."""
    def local(Rs):
        P = [np.zeros(2)]; h = 0.0
        for f, share in COMPOUND:
            r = f * Rs; th = share * delta
            n = max(2, int(math.ceil(max(th * r / ARC_STEP, th / math.radians(5)))))
            c = P[-1] + r * np.array([-math.sin(h), math.cos(h)])
            for k in range(1, n + 1):
                a = h + th * k / n
                P.append(c + r * np.array([math.sin(a), -math.cos(a)]))
            h += th
        return np.array(P)
    Q = local(1.0)
    E = Q[-1]
    if abs(math.sin(delta)) < 1e-6:
        return None
    T1u = E[0] - E[1] / math.sin(delta) * math.cos(delta)           # tangent length for R = 1
    if T1u <= 0:
        return None
    Rs = min(R, la / T1u, lb / T1u)
    if Rs < 0.5:
        return None
    Q = local(Rs)
    T = T1u * Rs
    side = 1.0 if (uA[0] * (-uB[1]) - uA[1] * (-uB[0])) > 0 else -1.0
    ex, ey = uA, side * np.array([-uA[1], uA[0]])
    T1 = X - uA * T
    W = T1 + Q[:, :1] * ex + Q[:, 1:] * ey
    return T1, W[-1], list(W[1:-1])


def _fillet(A, dA, B, dB, R, wA=0.0, wB=0.0):
    """corner curve from ring point A (leg direction dA pointing away from the node) to ring point B
    (dB): the curb lines run from A towards the node (-dA) and from B (-dB); they meet at X. The
    curve is: straight A -> T1, circular arc of radius R tangent to both lines (G1 at T1, T2),
    straight T2 -> B, with R reduced where the rings leave less than the tangent length. Offsets
    wA -> wB (outward, varying linearly along the curve) give the walk / building-line curves as
    exact offsets of the same curve. Returns interior points (without A and B), or None if the
    curb lines don't meet in front of both rings (then the caller uses a chord)."""
    uA, uB = -np.asarray(dA, float), -np.asarray(dB, float)
    den = uA[0] * uB[1] - uA[1] * uB[0]
    if abs(den) < 1e-6:
        return None
    d = B - A
    la = (d[0] * uB[1] - d[1] * uB[0]) / den
    lb = (d[0] * uA[1] - d[1] * uA[0]) / den
    if la <= 0.05 or lb <= 0.05:
        return None
    X = A + uA * la
    phi = math.acos(np.clip(float((A - X) @ (B - X)) / max(np.hypot(*(A - X)) * np.hypot(*(B - X)), 1e-9), -1, 1))  # A-X-B
    tanh = math.tan(phi / 2)
    delta = math.pi - phi                            # the curve's deflection
    if abs(math.degrees(phi) - 90.0) > SKEW_DEG and delta > math.radians(20):
        arc = _compound(uA, uB, X, delta, R, la, lb)
    else:
        arc = None
    if arc is not None:
        T1, T2, curve = arc
    else:
        T = min(R / max(tanh, 1e-6), la, lb)
        r = T * tanh
        T1 = X - uA * T
        T2 = X - uB * T
        bis = (A - X) / max(np.hypot(*(A - X)), 1e-9) + (B - X) / max(np.hypot(*(B - X)), 1e-9)
        bis /= max(np.hypot(*bis), 1e-9)
        Cc = X + bis * (r / max(math.sin(phi / 2), 1e-6))
        a1 = math.atan2(T1[1] - Cc[1], T1[0] - Cc[0])
        a2 = math.atan2(T2[1] - Cc[1], T2[0] - Cc[0])
        da = math.remainder(a2 - a1, math.tau)
        na = max(2, int(math.ceil(max(abs(da) * r / ARC_STEP, abs(da) / math.radians(5)))))
        curve = [Cc + r * np.array([math.cos(a1 + da * k / na), math.sin(a1 + da * k / na)]) for k in range(1, na)]
    pts = []
    nA = max(1, int(math.ceil(np.hypot(*(T1 - A)) / 2.0)))
    for k in range(1, nA + 1):
        pts.append(A + (T1 - A) * (k / nA))
    pts.extend(curve)
    nB = max(1, int(math.ceil(np.hypot(*(B - T2)) / 2.0)))
    for k in range(0, nB):
        pts.append(T2 + (B - T2) * (k / nB))
    P = np.array(pts)
    if wA == 0.0 and wB == 0.0:
        return P
    # exact offsets outward (away from the corner centre / towards the building), width varying A -> B
    full = np.vstack([A, P, B])
    sl = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(full, axis=0).T))])
    t = sl / max(sl[-1], 1e-9)
    tg = np.gradient(full, axis=0)
    tg /= np.maximum(np.hypot(tg[:, 0], tg[:, 1]), 1e-9)[:, None]
    nrm = np.stack([tg[:, 1], -tg[:, 0]], 1)           # right of travel A -> B = outward (CCW legs)
    off = wA * (1 - t) + wB * t
    return (full + nrm * off[:, None])[1:-1]


ROADWAY = None          # City edge-of-roadway (pavement) polygons for the current build (curb-radius fit)
RADII = (15.0, 12.0, 10.0, 8.0, 6.0, 4.5, 3.0)


def fit_radius(A, dA, B, dB, R_design):
    """curb radius for one corner from the City's surveyed pavement: the largest radius (not above
    the design radius) whose cut-off corner area (between the curb lines' corner and the arc) is
    less than 25% real pavement; the design radius where no survey exists."""
    import shapely
    if ROADWAY is None:
        return R_design
    for R in [r for r in RADII if r <= R_design + 1e-6] or [R_design]:
        P = _fillet(A, dA, B, dB, R)
        if P is None:
            return R_design
        uA, uB = -np.asarray(dA, float), -np.asarray(dB, float)
        den = uA[0] * uB[1] - uA[1] * uB[0]
        la = ((B - A)[0] * uB[1] - (B - A)[1] * uB[0]) / den
        X = A + uA * la
        cut = shapely.Polygon(np.vstack([X, A, P, B]))
        if not cut.is_valid or cut.area < 0.5:
            return R
        if cut.intersection(ROADWAY).area / cut.area < 0.25:
            return R
    return RADII[-1]


def node_mesh(legs):
    """junction mesh from ordered leg rings (sorted CCW around the node). Per corner the curb return,
    walk edge and building line are quadratic curves through the intersection of the two legs'
    lines; where a corner would self-intersect (legs close in angle with different setbacks) that
    corner is built with straight chords instead (a chamfered corner), then the box likewise.
    Returns box (list of (xy, z)), corners [(poly, kind, i)], returns, walk / bldg curves."""
    import shapely
    n = len(legs)

    def corner(i, straight_walk, straight_ret):
        L, R = legs[i], legs[(i + 1) % n]
        pi, pj = L["pts"], R["pts"]
        ii, jj = L["idx"], R["idx"]
        par = abs(math.remainder(math.atan2(R["t"][1], R["t"][0]) - math.atan2(L["t"][1], L["t"][0]), math.tau)) < PARALLEL
        line = lambda A, B: np.linspace(A, B, 10)[1:-1]  # noqa: E731
        rad = min(L["edge"].get("_radius", 7.0), R["edge"].get("_radius", 7.0))
        A_, B_ = pi[ii["cwL"]], pj[jj["cwR"]]
        rad = fit_radius(A_, L["t"], B_, R["t"], rad)
        ret = None if (par or straight_ret) else _fillet(A_, L["t"], B_, R["t"], rad)
        if ret is None:
            ret = line(A_, B_)
            straight_walk = True
        if straight_walk or par:
            wk, bd = line(pi[ii["walkL"]], pj[jj["walkR"]]), line(pi[ii["bldgL"]], pj[jj["bldgR"]])
        else:
            wa, wb = np.hypot(*(pi[ii["walkL"]] - A_)), np.hypot(*(pj[jj["walkR"]] - B_))
            ba, bb = np.hypot(*(pi[ii["bldgL"]] - A_)), np.hypot(*(pj[jj["bldgR"]] - B_))
            wk = _fillet(A_, L["t"], B_, R["t"], rad, wa, wb)
            bd = _fillet(A_, L["t"], B_, R["t"], rad, ba, bb)
        poly = [pi[k] for k in range(ii["cwL"], ii["walkL"] - 1, -1)] + list(wk) + \
               [pj[k] for k in range(jj["walkR"], jj["cwR"] - 1, -1)] + list(ret[::-1])
        fpoly = [pi[ii["walkL"]], pi[ii["bldgL"]]] + list(bd) + [pj[jj["bldgR"]], pj[jj["walkR"]]] + list(wk[::-1])
        return par, ret, wk, bd, np.array(poly), np.array(fpoly)

    def valid(P):
        return len(P) < 3 or shapely.Polygon(P).area <= 0.05 or shapely.Polygon(P).is_valid
    C = []
    ok = True
    bad = set()
    grow_box = False
    for i in range(n):
        res = corner(i, False, False)
        if not res[0] and not valid(res[4]):
            res = corner(i, True, False)
            if not valid(res[4]):
                res = corner(i, True, True)
        C.append(res)
    def box_of(C):
        box = []
        for i in range(n):
            L = legs[i]
            Rn = legs[(i + 1) % n]
            par_prev = C[(i - 1) % n][0]
            k0 = L["idx"]["bldgR"] if par_prev else L["idx"]["cwR"]
            k1 = L["idx"]["bldgL"] if C[i][0] else L["idx"]["cwL"]
            for k in range(k0, k1 - 1, -1):
                box.append((L["pts"][k], L["z"]))
            if C[i][0]:     # near-parallel neighbours: close outer edge to outer edge (the wedge is paved)
                box += [(p, (L["z"] + Rn["z"]) / 2) for p in np.linspace(L["pts"][L["idx"]["bldgL"]], Rn["pts"][Rn["idx"]["bldgR"]], 6)[1:-1]]
                continue
            ret = C[i][1]
            zr = curve_z(L["pts"][L["idx"]["cwL"]], ret, Rn["pts"][Rn["idx"]["cwR"]], L["z"], L["g"], Rn["z"], Rn["g"])
            box += [(p, float(z)) for p, z in zip(ret, zr)]
        return box
    box = box_of(C)
    if not valid(np.array([p for p, _ in box])):
        C = [corner(i, True, True) for i in range(n)]
        box = box_of(C)
        if not valid(np.array([p for p, _ in box])):
            # legs so short / close that even chords cross (service-lane and aisle clusters): grow first;
            # once growth is exhausted the box is the valid parts of the same outline
            grow_box = True
    corners, fok = [], []
    fixes, bad_corner = {}, set()
    for i, (par, ret, wk, bd, poly, fpoly) in enumerate(C):
        if par:
            corners.append((np.zeros((0, 2)), "walk", i)); corners.append((np.zeros((0, 2)), "frontage", i))
            fok.append(True)
            continue
        if not valid(poly):
            # the two legs' walk ends overlap (rings too close for a corner of their own): the corner is
            # the valid interpretation of the same boundary (its non-self-intersecting parts)
            parts = [np.asarray(g.exterior.coords)[:-1] for g in shapely.get_parts(shapely.make_valid(shapely.Polygon(poly)))
                     if g.geom_type == "Polygon" and g.area > 0.05]
            fixes[i] = parts
            bad_corner.add(i)
        corners.append((poly, "walk", i))
        corners.append((fpoly, "frontage", i))
        fok.append(bool(valid(fpoly)))
    # growth is still tried for such corners (fixes are the fallback once growth is exhausted)
    grow = set()
    for i in bad_corner:
        grow |= {i, (i + 1) % n}
    boxfix = None
    if grow_box:
        grow |= set(range(n))
        B = shapely.make_valid(shapely.Polygon(np.array([p for p, _ in box])))
        boxfix = [np.asarray(g.exterior.coords)[:-1] for g in shapely.get_parts(B) if g.geom_type == "Polygon" and g.area > 0.05]
    # heights of the corner curves (curb return, walk edge, building line): one vertical curve each
    rz, wz, bz = [], [], []
    for i, c in enumerate(C):
        L, Rn = legs[i], legs[(i + 1) % n]
        args = (L["z"], L["g"], Rn["z"], Rn["g"])
        rz.append(curve_z(L["pts"][L["idx"]["cwL"]], c[1], Rn["pts"][Rn["idx"]["cwR"]], *args))
        wz.append(curve_z(L["pts"][L["idx"]["walkL"]], c[2], Rn["pts"][Rn["idx"]["walkR"]], *args))
        bz.append(curve_z(L["pts"][L["idx"]["bldgL"]], c[3], Rn["pts"][Rn["idx"]["bldgR"]], *args))
    return dict(box=box, corners=corners, rets=[c[1] for c in C], walks=[c[2] for c in C], bldgs=[c[3] for c in C],
                retz=rz, walkz=wz, bldgz=bz,
                ok=ok, bad=bad | grow, grow_only=bool(grow) and ok, fok=fok, par=[bool(c[0]) for c in C], fixes=fixes,
                boxfix=boxfix)


# ------------------------------------------------------------------ build
def build_geometry(edges, nodes, assets, report, bbox):
    """sections, sweeps and node meshes for every drawn edge / node; setbacks grown until node
    curves are simple; transition nodes; pedestrian mesh. Sets e['_rows'], node['mesh'], returns
    (ped, marks, poles, qa counts)."""
    x0, y0, x1, y1 = bbox
    E = {e["id"]: e for e in edges if "band_left" in e}
    global ROADWAY
    try:
        ROADWAY = city_roadway(bbox)
        if ROADWAY is not None:
            import shapely
            shapely.prepare(ROADWAY)
    except Exception as ex:          # the survey is optional
        print("primgeom: no City roadway survey:", ex)
        ROADWAY = None
    for e in E.values():
        prepare(e, assets[e["asset"]])
    # node types and initial setbacks
    grown = []
    for nd in nodes:
        legs = [r for r in nd["legs"] if r["edge"] in E]
        nd["legs"] = legs
        if nd["type"] == "continuation" or len(legs) == 2:
            nd["type"] = "continuation" if len(legs) == 2 else nd["type"]
            for r in legs:
                r["setback"] = TRANSITION
        elif len(legs) <= 1:
            for r in legs:
                r["setback"] = 0.0

    # overlapping parallel legs (a duplicated service lane / alley leaving beside a street in the same
    # direction): the narrower leg starts where it has separated from the wider one; if it never
    # separates it is absorbed into the wider leg's asset (dropped, logged)
    absorbed = []
    for nd in nodes:
        if len(nd["legs"]) < 2:
            continue
        for r in list(nd["legs"]):
            for o in nd["legs"]:
                if o is r or r["edge"] not in E or o["edge"] not in E:
                    continue
                if abs(math.remainder(r["ang"] - o["ang"], math.tau)) > PARALLEL:
                    continue
                er, eo = E[r["edge"]], E[o["edge"]]
                wr = float(np.median(er["_p"]["U"][:, 2] - er["_p"]["U"][:, -3]))
                wo = float(np.median(eo["_p"]["U"][:, 2] - eo["_p"]["U"][:, -3]))
                if wr > wo or (wr == wo and r["edge"] < o["edge"]):
                    continue                    # r is the wider one
                Gr = er["geom"] if r["end"] == 0 else er["geom"][::-1]
                sr = cumlen(Gr[:, :2])
                from scipy.spatial import cKDTree as _T
                d, _ = _T(eo["geom"][:, :2]).query(Gr[:, :2])
                need = (wr + wo) / 2 + 0.5
                sep = np.nonzero(d > need)[0]
                if not len(sep) or sr[sep[0]] > sr[-1] - 3.0:
                    er["_absorbed"] = True
                    absorbed.append(dict(edge=r["edge"], into=o["edge"], node=nd["id"]))
                break
    if absorbed:
        gone = {x["edge"] for x in absorbed}
        for nd in nodes:
            nd["legs"] = [r for r in nd["legs"] if r["edge"] not in gone]
        for k in gone:              # drawn as carriageway fill under the wider leg (no legs, no walks)
            e_ = E[k]
            e_["internal"] = True
            prepare(e_, assets[e_["asset"]])
        for nd in nodes:
            if nd["type"] == "junction" and len(nd["legs"]) == 2:
                nd["type"] = "continuation"
                for r in nd["legs"]:
                    r["setback"] = max(TRANSITION, r.get("_sb_min", 0.0))
    report["absorbed_legs"] = absorbed
    report["counts"]["absorbed_legs"] = len(absorbed)

    def sb_of(e, end):
        nd = e.get("_node", {}).get(end)
        return nd

    leg_of = {}
    node_by = {}
    for nd in nodes:
        for r in nd["legs"]:
            leg_of[(r["edge"], r["end"])] = (nd, r)
        node_by[nd["key"]] = nd

    def rebuild(e):
        L = e["_p"]["s"][-1]
        a0 = leg_of.get((e["id"], 0)); a1 = leg_of.get((e["id"], 1))
        s0 = a0[1]["setback"] if a0 else 0.0
        s1 = L - (a1[1]["setback"] if a1 else 0.0)
        if s1 - s0 < 0.5:                                  # short edge: split the length in proportion
            A_ = s0 if a0 else 0.0
            B_ = (L - s1) if a1 else 0.0
            k_ = max(L - 0.5, 0.0) / max(A_ + B_, 1e-9)
            s0, s1 = A_ * k_, L - B_ * k_
            if a0:
                a0[1]["setback"] = round(s0, 3)
            if a1:
                a1[1]["setback"] = round(L - s1, 3)
        j0 = bool(a0 and a0[0]["type"] == "junction"); j1 = bool(a1 and a1[0]["type"] == "junction")
        g0 = bool(j0 and a0[0].get("signal")); g1 = bool(j1 and a1[0].get("signal"))
        extra = []
        if j0:
            extra += [s0 + CW_OFF, s0 + STOP_OFF]
        if j1:
            extra += [s1 - CW_OFF, s1 - STOP_OFF]
        e["_s01"] = (s0, s1, j0, j1)
        e["_rows"] = sweep(e, s0, s1, extra, g0, g1)     # the ROW opens (flush nose) only at signals

    for e in E.values():
        rebuild(e)
    # junction meshes with setback growth (acute legs)
    for nd in nodes:
        if nd["type"] != "junction" or len(nd["legs"]) < 3:
            continue
        for it in range(40):
            rings = sorted([ring_of(E[r["edge"]], r["end"]) for r in nd["legs"]],
                           key=ring_angle(nd))
            M = node_mesh(rings)
            if M["ok"] and not M["grow_only"]:
                break
            moved = False
            for i in M["bad"]:
                eid, end = rings[i]["edge"]["id"], rings[i]["end"]
                _, r = leg_of[(eid, end)]
                e_ = E[eid]
                other = leg_of.get((eid, 1 - end))
                room = e_["_p"]["s"][-1] - (other[1]["setback"] if other else 0.0) - 0.5
                P_ = rings[i]["pts"]; I_ = rings[i]["idx"]
                cap = r.setdefault("_sb0", r["setback"]) + MAX_GROW + float(np.hypot(*(P_[I_["cwL"]] - P_[I_["cwR"]])))
                if r["setback"] + 1.0 <= min(room, cap):
                    r["setback"] = round(r["setback"] + 1.0, 2)
                    rebuild(e_)
                    moved = True
            if not moved:
                break
        if it:
            grown.append(dict(node=nd["id"], iterations=it, setbacks={r["edge"]: r["setback"] for r in nd["legs"]}, ok=M["ok"]))
            report["counts"]["setback_grown_nodes"] += 1
    # final pass: every node mesh from the final rows (a neighbour's growth may have moved a ring)
    bad_nodes = []
    for nd in nodes:
        if nd["type"] != "junction" or len(nd["legs"]) < 3:
            continue
        rings = sorted([ring_of(E[r["edge"]], r["end"]) for r in nd["legs"]],
                       key=ring_angle(nd))
        M = node_mesh(rings)
        nd["_rings"], nd["_mesh"] = rings, M
        if not M["ok"]:
            bad_nodes.append(nd["id"])
    report["node_mesh_invalid"] = bad_nodes
    # a transit_row runs unbroken through unsignalized junctions (right-in / right-out side streets)
    n_through = 0
    for nd in nodes:
        if nd["type"] != "junction" or nd.get("signal") or not nd.get("_rings"):
            continue
        rs = [R for R in nd["_rings"] if R["edge"]["_idx"]["row"]]
        best = None
        for i_ in range(len(rs)):
            for j_ in range(i_ + 1, len(rs)):
                dot = float(rs[i_]["t"] @ rs[j_]["t"])
                if dot < -0.9 and (best is None or dot < best[0]):
                    best = (dot, rs[i_], rs[j_])
        if best is None:
            continue
        _, A, B = best

        def edges_of(R):
            e_ = R["edge"]; row = e_["_idx"]["row"]; m = len(R["pts"]) - 1
            uL, uR = min(row) + 2, max(row) + 3                 # edge-order U indices
            if R["end"] == 1:
                uL, uR = m - uR, m - uL
            return R["pts"][uL], R["pts"][uR]                   # leaving-left, leaving-right
        al, ar = edges_of(A)
        bl, br = edges_of(B)
        nd["_row_through"] = dict(q=[al, ar, bl, br], za=A["z"], zb=B["z"])
        n_through += 1
    report["counts"]["row_through_nodes"] = n_through
    report["counts"]["node_mesh_invalid"] = len(bad_nodes)
    for nd in nodes:                               # continuation transitions
        if nd["type"] == "continuation" and len(nd["legs"]) == 2:
            nd["_trans"] = [ring_of(E[r["edge"]], r["end"]) for r in nd["legs"]]
            nd["_trows"] = transition_rows(*nd["_trans"])
    report["setback_grown"] = grown
    # pedestrian mesh and markings from the same rows
    ped, marks, poles = [], [], []
    for e in E.values():
        rows = e["_rows"]
        for left in (True, False):
            lst = [sw_centres(e, r, left) for r in rows]
            for b in range(len(lst[0]) if lst else 0):
                pts = [np.r_[l_[b], r["c"][2] + H_WALK] for l_, r in zip(lst, rows)]
                ped.append(dict(kind="sidewalk", edge=e["id"], width=2.0, xyz=np.round(pts, 3).tolist()))
        s0, s1, j0, j1 = e["_s01"]
        for end, jn in ((0, j0), (1, j1)):
            if not jn:
                continue
            scw = s0 + CW_OFF if end == 0 else s1 - CW_OFF
            r = min(rows, key=lambda q: abs(q["s"] - scw))
            L_ = sw_centres(e, r, True); R_ = sw_centres(e, r, False)
            if L_ and R_:
                ped.append(dict(kind="crosswalk", edge=e["id"], width=3.0,
                                xyz=np.round([np.r_[L_[-1], r["c"][2] + H_WALK], np.r_[R_[0], r["c"][2] + H_WALK]], 3).tolist()))
            # markings only at signalized junctions (Toronto: unsignalized side streets carry no marked
            # crosswalk or stop bar across the main street; the crossing stays in the pedestrian mesh)
            lo_ = leg_of.get((e["id"], end))
            if not (lo_ and lo_[0].get("signal")):
                continue
            # zebra bars across the carriageway (cwL..cwR, incl. a flush ROW), perpendicular to the leg
            ix = e["_idx"]
            cA, nA, UA = section(e, scw - 1.5)
            cB, nB, UB = section(e, scw + 1.5)
            ul, ur = UA[ix["cwL"]] - 0.4, UA[ix["cwR"]] + 0.4
            u = ul
            while u - 0.55 > ur:
                q = [cA[:2] + nA * u, cA[:2] + nA * (u - 0.55), cB[:2] + nB * (u - 0.55), cB[:2] + nB * u]
                marks.append(dict(kind="white", xyz=np.round([np.r_[p, cA[2] + 0.013] for p in q], 3).tolist()))
                u -= 1.1
            # stop bar across the inbound lanes
            sst = s0 + STOP_OFF if end == 0 else s1 - STOP_OFF
            c, nrm, U = section(e, sst)
            c2, n2, U2 = section(e, sst + (0.4 if end == 0 else -0.4))
            a = assets[e["asset"]]
            for bi, b in enumerate(a["bands"]):
                if b["kind"] != "lane" or "car" not in b.get("classes", []):
                    continue
                inbound = (b.get("dir", 1) < 0) if end == 0 else (b.get("dir", 1) > 0)
                if not inbound:
                    continue
                ua, ub = U[bi + 2], U[bi + 3]
                q = [c[:2] + nrm * ua, c[:2] + nrm * ub, c2[:2] + n2 * ub, c2[:2] + n2 * ua]
                marks.append(dict(kind="white", xyz=np.round([np.r_[p, c[2] + 0.013] for p in q], 3).tolist()))
    for nd in nodes:
        T = nd.get("_trans")
        if not T:
            continue
        A, B = T
        ra = A["edge"]["_rows"][0 if A["end"] == 0 else -1]
        rb = B["edge"]["_rows"][0 if B["end"] == 0 else -1]
        # leaving-left of A continues as leaving-right of B
        for la in (True, False):
            pa = sw_centres(A["edge"], ra, la if A["end"] == 0 else not la)
            pb = sw_centres(B["edge"], rb, (not la) if B["end"] == 0 else la)
            if pa and pb:
                ped.append(dict(kind="link", node=nd["id"], width=2.0,
                                xyz=np.round([np.r_[pa[0], A["z"] + H_WALK], np.r_[pb[0], B["z"] + H_WALK]], 3).tolist()))
    for nd in nodes:
        M = nd.get("_mesh")
        if not M:
            continue
        rings = nd["_rings"]
        n = len(rings)
        def side_pt(R, left):
            e_ = R["edge"]
            row = e_["_rows"][0 if R["end"] == 0 else -1]
            lst = sw_centres(e_, row, left if R["end"] == 0 else not left)
            if not lst:
                return None
            return lst[0] if (left == (R["end"] == 0)) else lst[-1]
        for i in range(n):
            L = rings[i]
            pa = side_pt(L, True)
            if pa is None:
                continue
            # the next leg (CCW) with a sidewalk on its right; legs without sidewalks between (alleys,
            # service lanes) are crossed -- the walk continues across their mouth
            for k in range(1, n):
                R = rings[(i + k) % n]
                pb = side_pt(R, False)
                if pb is not None:
                    ped.append(dict(kind="corner", node=nd["id"], width=2.0,
                                    xyz=np.round([np.r_[pa, L["z"] + H_WALK], np.r_[pb, R["z"] + H_WALK]], 3).tolist()))
                    break
                if side_pt(R, True) is not None:
                    break
        for i in range(n):
            L = rings[i]
            if nd.get("signal"):
                p = L["pts"][L["idx"]["walkL"]] * 0.35 + L["pts"][L["idx"]["cwL"]] * 0.65 - L["t"] * 0.8
                q = p + (L["pts"][L["idx"]["cwR"]] - L["pts"][L["idx"]["cwL"]]) * 0.35
                poles.append(np.round([p[0], p[1], L["z"] + H_WALK, q[0], q[1]], 3).tolist())
    props = prop_slots(E.values(), assets)
    report["counts"]["prop_slots"] = len(props)
    return ped, marks, poles, props


# prop slots per zone (docs/CROSS_SECTION.md; the look-dev pass fills them): spacing along the band
# centre (m), kinds offered; slots within 6 m of a crosswalk / stop bar / driveway / platform are dropped
SLOTS = {"furniture": [(8.0, "tree_pit"), (25.0, "lamp"), (15.0, "bike_ring")],
         "frontage_walk": [],
         "building_edge": [(12.0, "edge_feature")]}


def prop_slots(edges, assets):
    out = []
    for e in edges:
        rows = e.get("_rows")
        if not rows or len(rows) < 2:
            continue
        kinds = e["_kinds"]
        s = np.array([r["s"] for r in rows])
        s0, s1 = s[0], s[-1]
        avoid = [s0, s1] + [d_["s"] for d_ in e.get("driveways", [])] + \
                [x for p_ in e.get("platforms", []) for x in (p_["s0"], p_["s1"])]
        for j, k in enumerate(kinds):
            for sp, kind in SLOTS.get(k, []):
                off = sp / 2 if kind != "lamp" else 0.0
                for st in np.arange(s0 + 6 + off, s1 - 6, sp):
                    if any(abs(st - a) < 6 for a in avoid):
                        continue
                    kk = int(np.clip(np.searchsorted(s, st), 1, len(s) - 1))
                    f = (st - s[kk - 1]) / max(s[kk] - s[kk - 1], 1e-9)
                    c = rows[kk - 1]["c"] * (1 - f) + rows[kk]["c"] * f
                    n = rows[kk - 1]["n"] * (1 - f) + rows[kk]["n"] * f
                    U = rows[kk - 1]["U"] * (1 - f) + rows[kk]["U"] * f
                    w = U[j] - U[j + 1]
                    if w < 0.8:
                        continue
                    u = (U[j] + U[j + 1]) / 2
                    out.append(dict(kind=kind, zone=k, edge=e["id"], s=round(float(st), 2),
                                    xyz=[round(float(c[0] + n[0] * u), 3), round(float(c[1] + n[1] * u), 3), round(float(c[2] + H_WALK), 3)],
                                    heading=round(float(math.atan2(-n[0], n[1])), 4), width=round(float(w), 2)))
    return out


def _hermite_path(C, N):
    """the transition's path: a cubic Hermite curve from ring A to ring B, matching both rings'
    positions and travel tangents (tangent length = chord), so the swept section turns
    continuously however sharp the bend; sampled <= 0.5 m / <= 5 deg. z interpolates the model's."""
    p0, p1 = C[0, :2], C[-1, :2]
    t0 = np.array([N[0][1], -N[0][0]]); t1 = np.array([N[-1][1], -N[-1][0]])
    L = float(np.hypot(*(p1 - p0)))
    if L < 0.5:
        return C, N
    turn = abs(math.atan2(t0[0] * t1[1] - t0[1] * t1[0], t0 @ t1))
    n = int(max(math.ceil(L / 0.5), math.ceil(math.degrees(turn) / 5.0), 2)) + 1
    u = np.linspace(0.0, 1.0, n)[:, None]
    h00, h10, h01, h11 = 2 * u**3 - 3 * u**2 + 1, u**3 - 2 * u**2 + u, -2 * u**3 + 3 * u**2, u**3 - u**2
    P = h00 * p0 + h10 * L * t0 + h01 * p1 + h11 * L * t1
    D = (6 * u**2 - 6 * u) * p0 + (3 * u**2 - 4 * u + 1) * L * t0 + (-6 * u**2 + 6 * u) * p1 + (3 * u**2 - 2 * u) * L * t1
    D /= np.maximum(np.hypot(D[:, 0], D[:, 1]), 1e-9)[:, None]
    Nn = np.column_stack([-D[:, 1], D[:, 0]])
    Nn[0], Nn[-1] = N[0], N[-1]                          # exact ring frames at both ends
    P[0], P[-1] = p0, p1
    dz = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(C[:, :2], axis=0).T))])
    z = np.interp(u[:, 0], dz / max(dz[-1], 1e-9), C[:, 2])
    return np.column_stack([P, z]), Nn


SQUARE_TURN = 45.0      # deg: a lane / minor street bend sharper than this has a square outside corner


def _square_outside(C, N, U, ua, ub, eA, eB):
    """a sharp bend on a lane or minor street (Toronto laneways, service roads) is paved square on
    the outside: each outer boundary runs from ring A straight to the corner where the two legs'
    boundary lines meet and on to ring B (the inside keeps the curve). Offsets ray-cast per row."""
    import shapely
    if min(eA.get("cls", 9), eB.get("cls", 9)) < 6:
        return
    t0 = np.array([N[0][1], -N[0][0]]); t1 = np.array([N[-1][1], -N[-1][0]])
    cr = t0[0] * t1[1] - t0[1] * t1[0]
    turn = math.degrees(abs(math.atan2(cr, t0 @ t1)))
    if turn < SQUARE_TURN:
        return
    outer = [k for k in range(U.shape[1]) if (ua[k] < 0 if cr > 0 else ua[k] > 0)]
    for k in outer:
        a = C[0, :2] + N[0] * ua[k]; b = C[-1, :2] + N[-1] * ub[k]
        den = t0[0] * t1[1] - t0[1] * t1[0]
        la = ((b - a)[0] * t1[1] - (b - a)[1] * t1[0]) / den
        X = a + t0 * la
        if not (0 < la < 30):
            continue
        line = shapely.LineString([a, X, b])
        sg = 1.0 if ua[k] > 0 else -1.0
        for r in range(1, len(C) - 1):
            ray = shapely.LineString([C[r, :2], C[r, :2] + sg * N[r] * 40.0])
            ip = ray.intersection(line)
            if ip.is_empty:
                continue
            d = float(shapely.distance(shapely.Point(C[r, :2]), ip))
            U[r, k] = sg * max(d, abs(U[r, k]))


def transition_rows(A, B):
    """continuation node: sections swept along the model centreline from A's ring through the node
    to B's ring (the parts of both edges inside their setbacks), the boundary offsets blended
    band by band (same band set) or by the six semantic boundaries (building line, walk edge,
    carriageway edge per side) with smoothstep easing -- no kinks, no straight chords. Rows in
    travel order A -> B; offsets + left of travel."""
    eA, eB = A["edge"], B["edge"]
    LA, LB = eA["_p"]["s"][-1], eB["_p"]["s"][-1]
    s0A, s1A = eA["_s01"][0], eA["_s01"][1]
    s0B, s1B = eB["_s01"][0], eB["_s01"][1]
    # stations: along A from its ring to the node, then along B from the node to its ring
    if A["end"] == 0:
        sa = np.linspace(s0A, 0.0, max(2, int(math.ceil(s0A / 1.0)) + 1)); fa = -1
    else:
        sa = np.linspace(s1A, LA, max(2, int(math.ceil((LA - s1A) / 1.0)) + 1)); fa = 1
    if B["end"] == 0:
        sb = np.linspace(0.0, s0B, max(2, int(math.ceil(s0B / 1.0)) + 1)); fb = 1
    else:
        sb = np.linspace(LB, s1B, max(2, int(math.ceil((LB - s1B) / 1.0)) + 1)); fb = -1
    st = [(eA, x, fa) for x in sa] + [(eB, x, fb) for x in sb[1:]]
    C, N = [], []
    for e_, x, f in st:
        c, n, _ = section(e_, x)
        C.append(c); N.append(n * f)                  # normal in travel direction's left
    C, N = np.array(C), np.array(N)
    C, N = _hermite_path(C, N)
    d = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(C[:, :2], axis=0).T))])
    t = d / max(d[-1], 1e-9)
    t = t * t * (3 - 2 * t)
    # boundary offsets at both rings in travel frame
    def offs(R, c, n):
        return (R["pts"] - c[:2]) @ n
    uA = offs(A, C[0], N[0])                      # A ring in its leaving order (= reversed travel order)
    uB = ((B["pts"] - C[-1][:2]) @ N[-1])
    kA = list(A["edge"]["_kinds"]) if A["end"] == 0 else list(A["edge"]["_kinds"])[::-1]     # leaving order
    kB = list(B["edge"]["_kinds"]) if B["end"] == 0 else list(B["edge"]["_kinds"])[::-1]
    same = len(A["pts"]) == len(B["pts"]) and kA[::-1] == kB
    iA, iB = A["idx"], B["idx"]
    if same:
        # arriving along A = A's leaving order reversed; B leaving order is travel order
        ua, ub = uA[::-1], uB
        kinds = kB
    else:
        keyA = [iA["bldgR"], iA["walkR"], iA["cwR"], iA["cwL"], iA["walkL"], iA["bldgL"]]
        keyB = [iB["bldgL"], iB["walkL"], iB["cwL"], iB["cwR"], iB["walkR"], iB["bldgR"]]
        ua, ub = uA[keyA], uB[keyB]
        kinds = ["frontage", "sidewalk", "lane", "sidewalk", "frontage"]
    U = ua[None, :] * (1 - t[:, None]) + ub[None, :] * t[:, None]
    _square_outside(C, N, U, ua, ub, eA, eB)
    U = np.minimum.accumulate(U, axis=1)            # bands tile: offsets non-increasing
    z = np.array([c[2] for c in C])
    hts = [H_WALK if k in RAISED else 0.0 for k in kinds]
    return dict(c=C, n=N, U=U, z=z, H=hts, kinds=kinds)


def export_edge(e):
    rows = e["_rows"]
    return dict(s=[round(r["s"], 3) for r in rows], c=[np.round(r["c"], 4).tolist() for r in rows],
                n=[np.round(r["n"], 7).tolist() for r in rows], U=[np.round(r["U"], 4).tolist() for r in rows],
                H=[r["H"] for r in rows], kinds=e["_kinds"],
                idx={k: v for k, v in e["_idx"].items()})


PATCH_CELL = 1.5        # m: interior grid of the junction box surface


def box_patch(box):  # noqa: C901
    """plan mesh of a junction box for its smooth surface: the box polygon clipped by a PATCH_CELL
    grid, each cell triangulated (constrained Delaunay), vertices shared. Boundary vertices carry a
    float index into the box outline (k + f = f of the way from box[k] to box[k+1]); the client
    takes their heights from the leg rings / returns and fills the interior with the harmonic
    (n-sided Coons) interpolant. None when the outline is not a valid simple polygon."""
    import shapely
    P = np.array([p for p, _ in box], dtype=np.float64)
    poly = shapely.Polygon(P)
    if len(P) < 3 or not poly.is_valid:
        return None
    x0, y0, x1, y1 = poly.bounds
    xs = np.arange(math.floor(x0 / PATCH_CELL), math.ceil(x1 / PATCH_CELL)) * PATCH_CELL
    ys = np.arange(math.floor(y0 / PATCH_CELL), math.ceil(y1 / PATCH_CELL)) * PATCH_CELL
    cells = shapely.box(*np.meshgrid(xs, ys), *np.meshgrid(xs + PATCH_CELL, ys + PATCH_CELL))
    cells = cells.ravel()
    shapely.prepare(poly)
    cells = cells[shapely.intersects(poly, cells)]
    look, V, T = {}, [], []

    def vid(x, y):
        k = (round(x, 4), round(y, 4))
        if k not in look:
            look[k] = len(V); V.append(k)
        return look[k]
    for c in shapely.intersection(poly, cells):
        for g in getattr(c, "geoms", [c]):
            if g.geom_type != "Polygon" or g.area < 1e-4:
                continue
            tr = shapely.constrained_delaunay_triangles(g)
            for t in tr.geoms:
                q = np.asarray(t.exterior.coords)[:3]
                if abs((q[1, 0] - q[0, 0]) * (q[2, 1] - q[0, 1]) - (q[1, 1] - q[0, 1]) * (q[2, 0] - q[0, 0])) < 1e-6:
                    continue
                T.append([vid(*q[0]), vid(*q[1]), vid(*q[2])])
    V = np.array(V)
    # boundary vertices: on the outline -> float index
    seg_a, seg_b = P, np.roll(P, -1, axis=0)
    d = seg_b - seg_a
    L2 = np.maximum((d ** 2).sum(1), 1e-12)
    bp = []
    for i, v in enumerate(V):
        f = np.clip(((v - seg_a) * d).sum(1) / L2, 0, 1)
        q = seg_a + d * f[:, None]
        e = np.hypot(*(q - v).T)
        k = int(e.argmin())
        if e[k] < 2e-3:
            bp.append([i, round(k + float(f[k]), 5)])
    # heights: boundary from the outline (ring z, return vertical curves), interior the discrete
    # harmonic interpolant (uniform graph Laplacian, exact sparse solve) -- the n-sided Coons patch
    import scipy.sparse as sp
    import scipy.sparse.linalg as spl
    bzv = np.array([z for _, z in box], dtype=np.float64)
    m = len(bzv)
    z = np.zeros(len(V))
    fixed = np.zeros(len(V), bool)
    for i, f in bp:
        k = int(math.floor(f)) % m
        fr = f - math.floor(f)
        z[i] = bzv[k] * (1 - fr) + bzv[(k + 1) % m] * fr
        fixed[i] = True
    free = np.where(~fixed)[0]
    if len(free):
        E = set()
        for a, b, c in T:
            E |= {(a, b), (b, a), (b, c), (c, b), (a, c), (c, a)}
        E = np.array(sorted(E))
        W = sp.csr_matrix((np.ones(len(E)), (E[:, 0], E[:, 1])), shape=(len(V), len(V)))
        Lap = sp.diags(np.asarray(W.sum(1)).ravel()) - W
        rhs = -Lap[free][:, np.where(fixed)[0]] @ z[fixed]
        z[free] = spl.spsolve(Lap[free][:, free].tocsc(), rhs)
    return dict(p=np.round(V, 3).tolist(), z=np.round(z, 3).tolist(), t=T, b=bp)


def export_node(nd):
    M = nd.get("_mesh")
    rs = nd.get("_rings") or nd.get("_trans") or []
    T = nd.get("_trows")
    out = dict(kind="junction" if nd.get("_rings") else "transition" if nd.get("_trans") else "end",
               legs=[dict(edge=R["edge"]["id"], end=R["end"]) for R in rs])
    if T is not None:
        out["trans"] = dict(c=np.round(T["c"], 3).tolist(), n=np.round(T["n"], 6).tolist(), U=np.round(T["U"], 3).tolist(),
                            H=T["H"], kinds=T["kinds"])
    if M:
        r3 = lambda A: np.round(np.asarray(A), 3).tolist()  # noqa: E731
        out.update(ret=[r3(x) for x in M["rets"]], walk=[r3(x) for x in M["walks"]], bldg=[r3(x) for x in M["bldgs"]],
                   fok=M.get("fok", []), ok=M["ok"], par=M.get("par", []),
                   fix={str(k): [r3(p) for p in v] for k, v in M.get("fixes", {}).items()},
                   boxfix=[r3(p) for p in M["boxfix"]] if M.get("boxfix") else None,
                   patch=nd.get("_patch"),
                   bz=[round(float(z), 3) for _, z in M["box"]],
                   retz=[np.round(x, 3).tolist() for x in M["retz"]], walkz=[np.round(x, 3).tolist() for x in M["walkz"]],
                   bldgz=[np.round(x, 3).tolist() for x in M["bldgz"]],
                   row=dict(q=[r3(p) for p in nd["_row_through"]["q"]], za=nd["_row_through"]["za"], zb=nd["_row_through"]["zb"])
                   if nd.get("_row_through") else None)
    return out


# ------------------------------------------------------------------ invariants
def city_roadway(bbox, pad=100.0):
    """City of Toronto edge-of-roadway polygons (surveyed pavement, raw/toronto_topo) in the bbox,
    projected to world metres; None when the file is missing"""
    import shapely
    from . import geo
    p = geo.PIPE / "raw" / "toronto_topo" / "edge-of-roadway-4326.gpkg"
    if not p.exists():
        return None
    import pyogrio
    from pyproj import Transformer
    tr = Transformer.from_crs("EPSG:4326", geo.PROJ, always_xy=True)
    inv = Transformer.from_proj(geo.PROJ, "EPSG:4326", always_xy=True)
    x0, y0, x1, y1 = bbox
    a = inv.transform(x0 - pad, y0 - pad)
    b = inv.transform(x1 + pad, y1 + pad)
    from pyogrio.raw import read as _read
    res = _read(p, bbox=(a[0], a[1], b[0], b[1]), read_geometry=True, columns=[])
    wkb = res[2]
    if wkb is None or not len(wkb):
        return None
    g = shapely.from_wkb(wkb)
    g = shapely.transform(g, lambda xy: np.column_stack(tr.transform(xy[:, 0], xy[:, 1])))
    return shapely.union_all(shapely.make_valid(g))


def invariants(edges, nodes, assets, bbox, tiles_dir, curated_names):
    """node_segment_gap (max distance between a leg ring as exported and the node boundary built
    from it -- recomputed from the exported rounded numbers the way the client does), row_gap
    (curated transit_row streets: stations without the ROW band), dropped_uncovered (tile street
    area dropped in the bbox and not covered by the net2 footprints, parts > 5 m2)."""
    import shapely
    from . import tbn
    x0, y0, x1, y1 = bbox
    out = {}
    # node_segment_gap: rebuild each ring from the exported row and compare with the node mesh
    gap = 0.0
    E = {e["id"]: e for e in edges if "_rows" in e}
    for nd in nodes:
        M = nd.get("_mesh")
        if not M:
            continue
        ex = {k: export_edge(R["edge"]) for k, R in enumerate(nd["_rings"])}
        for k, R in enumerate(nd["_rings"]):
            x = ex[k]
            j = 0 if R["end"] == 0 else -1
            c, nn, U = np.array(x["c"][j]), np.array(x["n"][j]), np.array(x["U"][j])
            pts = c[:2][None, :] + nn[None, :] * U[:, None]
            if R["end"] == 1:
                pts = pts[::-1]
            gap = max(gap, float(np.abs(pts - R["pts"]).max()))
    out["node_segment_gap_m"] = round(gap, 4)
    out["node_segment_gap"] = int(gap > 0.001)
    # row continuity on curated ROW streets
    rowgap = 0
    for e in E.values():
        a = assets[e["asset"]]
        if e["name"] in curated_names and not any(b["kind"] == "transit_row" for b in a["bands"]):
            G = e["geom"]
            if ((G[:, 0] > x0) & (G[:, 0] < x1) & (G[:, 1] > y0) & (G[:, 1] < y1)).any():
                rowgap += 1
    out["row_gap"] = rowgap
    # footprints
    polys = []
    for e in E.values():
        rows = e["_rows"]
        L = [r["c"][:2] + r["n"] * r["U"][0] for r in rows]
        R = [r["c"][:2] + r["n"] * r["U"][-1] for r in rows]
        if len(rows) >= 2:
            polys.append(shapely.Polygon(L + R[::-1]).buffer(0))
    for nd in nodes:
        M = nd.get("_mesh")
        if not M:
            continue
        b = np.array([p for p, _ in M["box"]])
        if len(b) >= 3:
            polys.append(shapely.make_valid(shapely.Polygon(b)))
        for q in (M.get("boxfix") or []):
            polys.append(shapely.Polygon(q))
        for poly, kind, _ in M["corners"]:
            if len(poly) >= 3:
                polys.append(shapely.make_valid(shapely.Polygon(poly)))
        for parts in M.get("fixes", {}).values():
            for q in parts:
                polys.append(shapely.Polygon(q))
        # continuation transitions: the strip between the two rings
    for nd in nodes:
        if nd["type"] != "continuation":
            continue
        T = nd.get("_trows")
        if T is not None and len(T["c"]) >= 2:
            Lp = T["c"][:, :2] + T["n"] * T["U"][:, :1]
            Rp = T["c"][:, :2] + T["n"] * T["U"][:, -1:]
            polys.append(shapely.make_valid(shapely.Polygon(np.vstack([Lp, Rp[::-1]]))))
    cover = shapely.union_all(polys) if polys else shapely.Polygon()
    dropped, accepted = [], []
    roadway = city_roadway(bbox)
    S0 = 1024.0
    for tx in range(int(x0 // S0), int(x1 // S0) + 1):
        for ty in range(int(y0 // S0), int(y1 // S0) + 1):
            p = tiles_dir / f"{tx}_{ty}.bin.gz"
            if not p.exists():
                continue
            a, _ = tbn.read(p)
            off, xyz = a["r_off"], a["r_xyz"].reshape(-1, 3).astype(np.float64)
            cls, fl = a["r_class"], a["r_flags"]
            pl, pr = a["r_pl"], a["r_pr"]
            for i in range(len(off) - 1):
                o, e_ = off[i], off[i + 1]
                if cls[i] > 6 or fl[i] & 96 or e_ - o < 2:
                    continue
                P = xyz[o:e_, :2] + [tx * S0, ty * S0]
                m = P[(e_ - o - 1) // 2]
                if not (x0 < m[0] < x1 and y0 < m[1] < y1):
                    continue
                t = np.gradient(P, axis=0); t /= np.maximum(np.hypot(t[:, 0], t[:, 1]), 1e-9)[:, None]
                nn = np.stack([-t[:, 1], t[:, 0]], 1)
                Lp = P + nn * pl[o:e_, None]; Rp = P - nn * pr[o:e_, None]
                g = shapely.Polygon(np.vstack([Lp, Rp[::-1]])).buffer(0)
                d = g.intersection(shapely.box(x0, y0, x1, y1)).difference(cover)
                for part in shapely.get_parts(d):
                    if part.geom_type != "Polygon" or part.area <= 5.0:
                        continue
                    c = part.centroid
                    # judged against the City's surveyed edge-of-roadway (pavement) polygons (docs/SOURCES.md):
                    # mostly real pavement -> the model misses it; mostly off the pavement -> the old tile
                    # footprint overshot (accepted, logged); in between -> review
                    inside = part.intersection(roadway).area / part.area if roadway is not None else 0.5
                    rec = dict(xy=[round(c.x, 1), round(c.y, 1)], area=round(part.area, 1), way=int(a["r_osm"][i]),
                               on_pavement=round(float(inside), 2))
                    if inside < 0.2:
                        accepted.append(rec)
                    else:
                        rec["verdict"] = "model_misses_pavement" if inside > 0.5 else "unclear"
                        dropped.append(rec)
    out["dropped_uncovered"] = len(dropped)
    out["dropped_uncovered_m2"] = round(sum(x["area"] for x in dropped), 1)
    out["old_footprint_overshoot_accepted"] = len(accepted)
    out["old_footprint_overshoot_m2"] = round(sum(x["area"] for x in accepted), 1)
    return out, dropped, accepted
