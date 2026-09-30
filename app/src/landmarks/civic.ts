// Civic & heritage landmarks: City Hall + Nathan Phillips Square, Old City
// Hall, Union Station, Scotiabank Arena, Royal York, Gooderham, Casa Loma,
// ROM Crystal, Pearson T1.
import * as THREE from 'three/webgpu'
import {
  Parts, prism, slab, lathe, cyl, box, rect, bbox, centroid, edgeWalls, offsetPoly, prismTopFn, loft,
  scalePoly, ccw, cleanPoly, pyramid, beam, P as P3, ellipse, type V2,
} from './kit'
import type { MatKey } from './materials'
import { addOsmParts } from './osmparts'
import type { BuildCtx, OsmPart } from './types'
import { tower } from './financial'

const part = (ctx: BuildCtx, name: string, fb: V2[]) => ccw(cleanPoly(ctx.part(name, fb)))

function crescent(cx: number, r0: number, r1: number, a0: number, a1: number, n: number, flip: boolean): V2[] {
  const out: V2[] = []
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n
    out.push([cx + (flip ? -1 : 1) * r1 * Math.cos(a), r1 * Math.sin(a)])
  }
  for (let i = n; i >= 0; i--) {
    const a = a0 + ((a1 - a0) * i) / n
    out.push([cx + (flip ? -1 : 1) * r0 * Math.cos(a), r0 * Math.sin(a)])
  }
  return ccw(out)
}

// ---------------------------------------------------------------------------
// Toronto City Hall (Viljo Revell, 1965)

export function buildCityHall(ctx: BuildCtx) {
  const hi = ctx.detail === 'high'
  const P = new Parts()
  const council = part(ctx, 'council', ellipse(24, 24, 24, -4, -12))
  const cc = centroid(council)
  const cb = bbox(council)
  const east = part(ctx, 'east', crescent(-4, 30, 38, -1.2, 1.2, 10, false))
  const west = part(ctx, 'west', crescent(-4, 30, 37, -1.0, 1.0, 10, true))
  const podium = part(ctx, 'podium', rect(115, 100, 0, -5))

  tower(P, podium, 0, 8, 'concreteWin', 'concrete')
  for (const [poly, H] of [[east, 99.5], [west, 79.4]] as [V2[], number][]) {
    // concave faces (towards the council chamber) = window grid; convex backs = ribbed shell
    const walls = edgeWalls(poly, 0, H, (i, nx, ny) => {
      const a = poly[i], b = poly[(i + 1) % poly.length]
      const tx = cc[0] - (a[0] + b[0]) / 2, ty = cc[1] - (a[1] + b[1]) / 2
      return (nx * tx + ny * ty > 0 ? 'glassGrey' : 'shellConcrete') as MatKey
    })
    for (const [k, g] of walls) P.add(k, g)
    P.add('concrete', slab(poly, H))
    if (hi) P.add('concrete', prism(offsetPoly(poly, 1.5), H, H + 2.5))
  }
  // Council chamber "saucer" on its column
  const r = Math.min(cb.w, cb.d) / 2
  const g = new Parts()
  g.add('concrete', cyl(5.5, 6, 8, 16))
  g.add('white', lathe([[5.5, 13], [r * 0.6, 14.2], [r * 0.95, 16.6], [r, 17.6], [r, 18.4]], hi ? 48 : 20))
  g.add('white', lathe([[r, 18.4], [r * 0.82, 21.3], [r * 0.5, 23.7], [0.1, 25]], hi ? 48 : 20))
  P.addParts(g, new THREE.Matrix4().makeTranslation(cc[0], 0, -cc[1]))

  // Nathan Phillips Square: reflecting pool, Freedom Arches, TORONTO sign
  const pb = bbox(podium)
  const poolC: V2 = [pb.cx - 8, pb.y0 - 52]
  const pool = rect(62, 26, poolC[0], poolC[1])
  P.add('concrete', prism(offsetPoly(pool, -1.2), 0, 0.5))
  P.add('water', slab(pool, 0.55))
  const archSpan = 30
  for (const dx of [-21, 0, 21]) {
    const pts: THREE.Vector3[] = []
    for (let i = 0; i <= 12; i++) {
      const t = -1 + (2 * i) / 12
      pts.push(P3(poolC[0] + dx, 0.5 + 9.5 * (1 - t * t), poolC[1] + (t * archSpan) / 2))
    }
    for (let i = 0; i < pts.length - 1; i++) P.add('white', beam(pts[i], pts[i + 1], 1.0, 1.4))
  }
  if (hi) {
    // TORONTO letters on the north edge of the pool
    for (let i = 0; i < 7; i++) P.add('white', box(2.4, 3, 0.8, poolC[0] - 10.5 + i * 3.5, 2.05, poolC[1] + 15.5))
  }
  return P.build('toronto_city_hall')
}

// ---------------------------------------------------------------------------
// Old City Hall (E.J. Lennox, 1899): Romanesque sandstone + clock tower.

export function buildOldCityHall(ctx: BuildCtx) {
  const P = new Parts()
  const fp = ctx.footprint(rect(90, 70))
  P.add('sandstone', prism(fp, 0, 18, { top: false }))
  P.add('slate', slab(fp, 18))
  let clock: OsmPart | undefined
  addOsmParts(P, ctx, (p) => {
    if (p.minH >= 70) return { wall: 'sandstone', pitched: 'copper', roof: 'copper' }
    if (p.kind === 'steps') return { wall: 'granite' }
    return { wall: 'sandstone', roof: 'slate', pitched: 'slate' }
  })
  clock = ctx.entry?.osmParts?.find((p) => p.id === 178252639)
  const cpoly = clock ? ccw(cleanPoly(clock.poly)) : rect(9.5, 9.5, 1, -40)
  const cb = bbox(cpoly)
  if (!clock) {
    tower(P, cpoly, 0, 78, 'sandstone')
    P.add('copper', pyramid(cpoly, 78, 103.6))
  }
  // Clock faces on the four sides
  for (const [nx, ny, w] of [[1, 0, cb.d], [-1, 0, cb.d], [0, 1, cb.w], [0, -1, cb.w]] as [number, number, number][]) {
    const x = cb.cx + (nx * (cb.w / 2 + 0.2)), y = cb.cy + (ny * (cb.d / 2 + 0.2))
    const g = new THREE.CylinderGeometry(Math.min(3.2, w * 0.36), Math.min(3.2, w * 0.36), 0.3, 20)
    g.rotateX(Math.PI / 2)
    g.rotateY(Math.atan2(nx, -ny) + Math.PI)
    g.translate(x, 66, -y)
    P.add('crownLight', g)
  }
  return P.build('old_city_hall')
}

// Union Station: see ./union.ts (whole complex, handcrafted).

// ---------------------------------------------------------------------------
// Scotiabank Arena: bowl behind the 1941 Postal Delivery Building facade.

export function buildScotiabankArena(ctx: BuildCtx) {
  const P = new Parts()
  const fp = ctx.footprint(rect(130, 125))
  const bowl = part(ctx, 'bowl', rect(110, 100))
  P.add('limestone', prism(fp, 0, 19, { top: false }))
  P.add('roofDark', slab(fp, 19))
  P.add('glassBlue', prism(bowl, 0, 33, { top: false }))
  P.add('roofLight', loft(bowl, 33, scalePoly(bowl, 0.86), 38))
  P.add('metalDark', prism(offsetPoly(bowl, -0.4), 30.5, 33, { top: false }))
  return P.build('scotiabank_arena')
}

// ---------------------------------------------------------------------------
// Fairmont Royal York: stepped limestone chateau with copper roofs.

export function buildRoyalYork(ctx: BuildCtx) {
  const P = new Parts()
  addOsmParts(P, ctx, (p) => {
    if ((p.h ?? 0) > 90) return { wall: 'copper', roof: 'copper', pitched: 'copper' }
    return { wall: 'limestone', roof: 'copper', pitched: 'copper' }
  })
  if (!ctx.entry?.osmParts?.length) {
    tower(P, rect(90, 100), 0, 25, 'limestone')
    tower(P, rect(60, 90), 25, 87, 'limestone', 'copper')
  }
  // Rooftop lantern to the real 124 m
  const hot = ctx.entry?.osmParts?.find((p) => p.id === 231977104)
  const c = hot ? centroid(hot.poly) : ([0, 0] as V2)
  P.add('copper', cyl(2.2, 6, 114, 8, 1.6, c[0], c[1]))
  P.add('copper', cyl(1.4, 4, 120, 8, 0.1, c[0], c[1]))
  return P.build('royal_york')
}

// ---------------------------------------------------------------------------
// Gooderham (Flatiron) Building: brick wedge, copper mansard, apex turret.

export function buildGooderham(ctx: BuildCtx) {
  const P = new Parts()
  const fp = ctx.footprint([[-20, -8], [18, -6], [18, 8], [-22, 2]])
  P.add('brick', prism(fp, 0, 17, { top: false }))
  const inner = offsetPoly(fp, 2.2)
  P.add('copper', loft(fp, 17, inner, 22.5))
  // turret at the sharpest vertex
  let best = 0, bestA = Infinity
  for (let i = 0; i < fp.length; i++) {
    const a = fp[(i - 1 + fp.length) % fp.length], b = fp[i], c = fp[(i + 1) % fp.length]
    const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]]
    const ang = Math.acos((v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(v1[0], v1[1]) * Math.hypot(v2[0], v2[1]) + 1e-9))
    if (ang < bestA) { bestA = ang; best = i }
  }
  const cen = centroid(fp)
  const ap = fp[best]
  const dir = [cen[0] - ap[0], cen[1] - ap[1]]
  const dl = Math.hypot(dir[0], dir[1])
  const tx = ap[0] + (dir[0] / dl) * 2.8, ty = ap[1] + (dir[1] / dl) * 2.8
  P.add('brick', cyl(3, 20, 0, 12, 3, tx, ty))
  P.add('copper', cyl(3.3, 6.5, 20, 12, 0.3, tx, ty))
  return P.build('gooderham')
}

// ---------------------------------------------------------------------------
// Casa Loma: OSM 3D parts in castle stone with copper/slate roofs.

export function buildCasaLoma(ctx: BuildCtx) {
  const P = new Parts()
  const fp = ctx.footprint(rect(70, 40))
  P.add('castleStone', prism(fp, 0, 5, { top: false }))
  P.add('slate', slab(fp, 5))
  addOsmParts(P, ctx, (p) => {
    if (p.kind === 'column') return { wall: 'castleStone' }
    return { wall: 'castleStone', roof: 'slate', pitched: p.roof === 'pyramidal' ? 'copper' : 'slate' }
  })
  if (!ctx.entry?.osmParts?.length) tower(P, rect(70, 40), 0, 22, 'castleStone', 'slate')
  return P.build('casa_loma')
}

// ---------------------------------------------------------------------------
// ROM Michael Lee-Chin Crystal: aluminium-clad crystalline prisms.

export function buildRomCrystal(ctx: BuildCtx) {
  const P = new Parts()
  addOsmParts(P, ctx, () => ({ wall: 'romAlu', roof: 'romAlu', pitched: 'romAlu' }))
  if (!ctx.entry?.osmParts?.length) {
    P.add('romAlu', prismTopFn([[-30, -20], [20, -25], [35, 10], [-10, 30]], 0, (x, y) => 25 + 0.25 * x + 0.2 * y))
  }
  return P.build('rom_crystal')
}

// ---------------------------------------------------------------------------
// Pearson Terminal 1: glass processor under a gently arched roof.

export function buildPearsonT1(ctx: BuildCtx) {
  const P = new Parts()
  const fp = ctx.footprint(rect(500, 200))
  P.add('glassBlue', prism(fp, 0, 16, { top: false }))
  P.add('roofLight', prism(offsetPoly(fp, 1.5), 16, 19))
  return P.build('pearson_t1')
}

