// Generic extruder for the OSM building:part pieces a landmark replaces.
// Used for landmarks whose OSM 3D modelling is already accurate (setbacks,
// skillion crowns, spires): we render the exact massing with landmark
// materials and add signature details on top.
import { Parts, prism, slab, prismTopFn, pyramid, centroid, ccw, cleanPoly, scalePoly, loft, cyl, type V2 } from './kit'
import type { MatKey } from './materials'
import type { BuildCtx, OsmPart } from './types'

export interface PartStyle {
  wall: MatKey
  roof?: MatKey
  /** material for pitched (non-flat) roofs */
  pitched?: MatKey
}

export function partHeight(p: OsmPart): [number, number] {
  const h = p.h ?? (p.levels != null ? p.levels * 3.4 : 10)
  const minH = p.minH || (p.minLevel != null ? p.minLevel * 3.4 : 0)
  return [minH, Math.max(h, minH + 0.5)]
}

/**
 * Add parts to `P`. `style(p)` returns a style or null to skip.
 * `rotation` = entry rotation (needed to convert roof:direction).
 */
export function addOsmParts(P: Parts, ctx: BuildCtx, style: (p: OsmPart) => PartStyle | null, filter?: (p: OsmPart) => boolean) {
  const e = ctx.entry
  if (!e?.osmParts) return
  const rot = e.rotation
  for (const p of e.osmParts) {
    if (filter && !filter(p)) continue
    const st = style(p)
    if (!st) continue
    const poly = ccw(cleanPoly(p.poly))
    if (poly.length < 3) continue
    const [y0, y1] = partHeight(p)
    const roofMat = st.roof ?? 'roofDark'
    const pitched = st.pitched ?? roofMat
    if (p.kind === 'column' || (y0 > 150 && Math.abs(areaOf(poly)) < 80 && y1 - y0 > 4)) {
      const c = centroid(poly)
      const r = p.kind === 'column' ? Math.max(0.35, Math.sqrt(Math.abs(areaOf(poly)) / Math.PI)) : 1.1
      P.add(st.wall, cyl(r, y1 - y0, y0, ctx.detail === 'high' ? 10 : 6, p.kind === 'column' ? r : r * 0.4, c[0], c[1]))
      continue
    }
    const rh = Math.min(p.roofH || 0, y1 - y0)
    const wallTop = y1 - rh
    switch (p.roof) {
      case 'skillion': {
        if (rh <= 0.01) break
        // roof:direction = compass bearing the slope descends towards (world).
        const b = ((p.roofDir ?? 0) * Math.PI) / 180
        const wx = Math.sin(b), wy = Math.cos(b)
        const c = Math.cos(-rot), s = Math.sin(-rot)
        const dx = wx * c - wy * s, dy = wx * s + wy * c
        const proj = poly.map(([x, y]) => x * dx + y * dy)
        const lo = Math.min(...proj), hi = Math.max(...proj)
        const span = Math.max(hi - lo, 0.01)
        P.add(st.wall, prismTopFn(poly, y0, (x, y) => y1 - (rh * ((x * dx + y * dy) - lo)) / span))
        if (y0 > 0.5) P.add(st.wall, prism(poly, y0, y0 + 0.01, { top: false, bottom: true }))
        continue
      }
      case 'pyramidal':
      case 'hipped':
      case 'gabled':
        if (rh <= 0.01) break
        P.add(st.wall, prism(poly, y0, wallTop, { top: false, bottom: y0 > 0.5 }))
        P.add(pitched, pyramid(poly, wallTop, y1))
        continue
      case 'dome':
      case 'round':
      case 'onion': {
        if (rh <= 0.01) break
        P.add(st.wall, prism(poly, y0, wallTop, { top: false, bottom: y0 > 0.5 }))
        const n = 5
        let prev = poly, prevY = wallTop
        for (let i = 1; i <= n; i++) {
          const a = (i / n) * (Math.PI / 2)
          const k = Math.cos(a), yy = wallTop + rh * Math.sin(a)
          const next = i === n ? scalePoly(poly, 0.02) : scalePoly(poly, k)
          P.add(pitched, loft(prev, prevY, next, yy, { top: i === n }))
          prev = next
          prevY = yy
        }
        continue
      }
    }
    P.add(st.wall, prism(poly, y0, y1, { top: false, bottom: y0 > 0.5 }))
    P.add(roofMat, slab(poly, y1))
  }
}

function areaOf(poly: V2[]) {
  let a = 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return a / 2
}

/** True if the part's centroid lies inside any of the given polygons. */
export function insideAny(p: OsmPart, polys: V2[][]) {
  const c = centroid(p.poly)
  return polys.some((poly) => pointIn(c, poly))
}

export function pointIn([x, y]: V2, poly: V2[]) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
