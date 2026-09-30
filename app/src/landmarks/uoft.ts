// University of Toronto St. George campus + Queen's Park: University College,
// Hart House & Soldiers' Tower, Convocation Hall, Robarts Library, Knox
// College, Trinity College, Victoria College (Old Vic), the Ontario
// Legislative Building, the King's College Circle front lawn and the ROM's
// 1914/1933 heritage wings. Where OSM carries detailed 3D parts (UC, Knox,
// Con Hall, Legislature, ROM, Robarts) the exact massing is used with our
// materials and proper roofs; the rest is hand-built on the OSM footprints.
import { Parts, prism, slab, offsetPoly, loft, bbox, centroid, cyl, ellipse, ccw, rect, type V2 } from './kit'
import type { MatKey } from './materials'
import type { BuildCtx, OsmPart } from './types'
import {
  addHeritage, partOf, holesOf, zOf, osmPart, block, squareTower, turret, faceEdge, along, panel, edgeBox, dome,
  lift, rotRect,
} from './kit2'
import * as THREE from 'three/webgpu'

/** Tower on a heritage part: extra corner pinnacles on its top. */
function pinnaclesOn(P: Parts, p: OsmPart | undefined, h: number, wall: MatKey, roof: MatKey) {
  if (!p) return
  const poly = ccw(p.poly)
  const b = bbox(poly)
  const z = lift(p)
  for (const [x, y] of [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]] as V2[]) {
    P.add(wall, cyl(0.55, h * 0.55, z + (p.h ?? 20), 6, 0.55, x, y))
    P.add(roof, cyl(0.62, h * 0.45, z + (p.h ?? 20) + h * 0.55, 6, 0.02, x, y))
  }
}

// ---------------------------------------------------------------------------
// University College (Cumberland & Storm, 1859): Norman Romanesque quad.

export function buildUniversityCollege(ctx: BuildCtx) {
  const P = new Parts()
  addHeritage(P, ctx, () => ({ wall: 'ucStone', roof: 'slate', flat: 'slate' }))
  if (!ctx.entry?.osmParts?.length) block(P, partOf(ctx, 'uc', rect(120, 100)), [], 0, 15, 6, 6, 'ucStone', 'slate')
  // main tower pinnacles + tall arched entrance on King's College Circle
  const t = osmPart(ctx, 1039490587)
  pinnaclesOn(P, t, 4, 'ucStone', 'slate')
  if (t) {
    const poly = ccw(t.poly)
    const [a, b] = faceEdge(poly, [11, -200], 2)
    P.add('glassPod', panel(a, b, 0.3, 0.7, 0, 7, 0.1))
  }
  return P.build('university_college')
}

// ---------------------------------------------------------------------------
// Hart House (Sproatt & Rolph, 1919) + Soldiers' Tower (1924): Collegiate Gothic.

export function buildHartHouse(ctx: BuildCtx) {
  const hi = ctx.detail === 'high'
  const P = new Parts()
  const hh = partOf(ctx, 'hh', rect(120, 68))
  const holes = holesOf(ctx, 'hh')
  block(P, hh, holes, 0, 13.5, 5.5, 6.5, 'gothicStone', 'slate')
  // Great Hall: taller west range with a steep roof
  const b = bbox(hh)
  if (hi) {
    // crenellated parapet along the outer walls
    P.add('gothicStone', prism(offsetPoly(hh, -0.25), 13, 14.3, { top: false }))
  }
  // Soldiers' Tower (43.6 m)
  const tp = partOf(ctx, 'tower', rect(10, 10, b.x0 - 30, b.y0))
  const tb = bbox(tp)
  const c: V2 = [tb.cx, tb.cy], s = Math.min(tb.w, tb.d)
  const zt = zOf(ctx, 'tower')
  const g = new Parts()
  squareTower(g, c, s, 0, 35.5, 0, 'gothicStone', 'slate', { parapet: 1.6, pinnacles: 8 })
  // belfry: tall louvred lancets on each face
  const sq = rotRect(s, s, c)
  for (let i = 0; i < 4; i++) {
    const a = sq[i], bb = sq[(i + 1) % 4]
    g.add('glassPod', panel(a, bb, 0.33, 0.67, 26, 33.5, 0.08))
    g.add('glassPod', panel(a, bb, 0.36, 0.64, 9, 16, 0.08))
    g.add('crownLight', panel(a, bb, 0.38, 0.62, 19.5, 22.5, 0.12))
    if (hi) g.add('gothicStone', edgeBox(a, bb, 0.05, 0.95, 24.5, 25.2, 0.4))
  }
  P.addParts(g, zt ? new THREE.Matrix4().makeTranslation(0, zt, 0) : undefined)
  return P.build('hart_house')
}

// ---------------------------------------------------------------------------
// Convocation Hall (Darling & Pearson, 1907): domed rotunda, Ionic portico.

export function buildConvocationHall(ctx: BuildCtx) {
  const P = new Parts()
  addHeritage(P, ctx, (p) => {
    if (p.id === 1013942077) return { wall: 'buffBrick', roof: 'copper' }
    if ((p.h ?? 0) <= 1) return { wall: 'granite', roof: 'granite', flat: 'granite' }
    if ((p.h ?? 0) <= 9.1 && p.minH > 0) return { wall: 'limestone', roof: 'limestone', flat: 'limestone' }
    return { wall: 'buffBrick', roof: 'slate', flat: 'roofDark' }
  })
  const d = osmPart(ctx, 1013942077)
  const c = d ? centroid(d.poly) : ([0, 0] as V2)
  P.add('copper', cyl(1.6, 2.2, 24, 8, 1.4, c[0], c[1]))
  P.add('copper', cyl(1.8, 1.2, 26.2, 8, 0.05, c[0], c[1]))
  if (!d) {
    P.add('buffBrick', cyl(22, 14, 0, 24))
    P.add('copper', dome(16, 8, 16, 24))
  }
  return P.build('convocation_hall')
}

// ---------------------------------------------------------------------------
// Robarts Library (Mathers & Haldenby, 1973): brutalist concrete "peacock".

export function buildRobartsLibrary(ctx: BuildCtx) {
  const hi = ctx.detail === 'high'
  const P = new Parts()
  const main = osmPart(ctx, 1030397928)
  const tri = main ? ccw(main.poly) : ccw([[-27, -46], [62, -46], [18, 43]])
  // recessed base, flaring out to the full floor plate, then 13 more storeys
  const base = offsetPoly(tri, 6)
  P.add('brutalist', prism(base, 0, 11, { top: false }))
  P.add('concrete', loft(base, 11, tri, 19, { top: false }))
  P.add('brutalist', prism(tri, 19, 58, { top: false }))
  P.add('concrete', prism(offsetPoly(tri, -0.4), 57.5, 60, { top: false, bottom: true }))
  P.add('roofDark', slab(tri, 59.6))
  addHeritage(P, ctx, (p) => {
    if (p.id === 1030397928 || p.whole) return null
    if (p.id === 1540353363) return { wall: 'glassGrey', roof: 'roofLight', flat: 'roofLight' }
    return { wall: 'concrete', roof: 'concrete', flat: 'concrete' }
  })
  // Robarts Common (2023 glass addition): the OSM part has no height
  const rc = osmPart(ctx, 1540353363)
  if (rc) {
    const poly = ccw(rc.poly)
    P.add('glassGrey', prism(poly, 10, 24, { top: false }))
    P.add('roofLight', slab(poly, 24))
  }
  if (hi) {
    // deep horizontal fins at the flare
    P.add('concrete', prism(offsetPoly(tri, -0.8), 18.4, 19.2, { bottom: true }))
  }
  return P.build('robarts_library')
}

// ---------------------------------------------------------------------------
// Knox College (Smith & Gemmell, 1915): Collegiate Gothic around a quad.

export function buildKnoxCollege(ctx: BuildCtx) {
  const P = new Parts()
  addHeritage(P, ctx, (p) => {
    if (p.kind === 'steps') return { wall: 'granite', roof: 'granite', flat: 'granite' }
    return { wall: 'gothicStone', roof: 'slate', flat: 'slate' }
  })
  pinnaclesOn(P, osmPart(ctx, 1108032039), 5, 'gothicStone', 'slate')
  pinnaclesOn(P, osmPart(ctx, 1108032043), 4, 'gothicStone', 'slate')
  if (!ctx.entry?.osmParts?.length) block(P, partOf(ctx, 'knox', rect(65, 83)), holesOf(ctx, 'knox'), 0, 15, 5, 5, 'gothicStone', 'slate')
  return P.build('knox_college')
}

// ---------------------------------------------------------------------------
// Trinity College (Darling & Pearson, 1925): buff brick Jacobethan quad; the
// Hoskin Avenue front has a central entrance tower flanked by two octagonal
// turrets with copper ogee caps.

export function buildTrinityCollege(ctx: BuildCtx) {
  const hi = ctx.detail === 'high'
  const P = new Parts()
  const tc = partOf(ctx, 'tc', rect(93, 110))
  const holes = holesOf(ctx, 'tc')
  block(P, tc, holes, 0, 13, 5, 6.5, 'buffBrick', 'slate')
  const b = bbox(tc)
  const [a, c] = faceEdge(tc, [b.cx, b.y0 - 300], 20)
  const len = Math.hypot(c[0] - a[0], c[1] - a[1])
  const dir: V2 = [(c[0] - a[0]) / len, (c[1] - a[1]) / len]
  const m = along(a, c, 0.5, -4)
  const rotA = Math.atan2(dir[1], dir[0])
  // central tower block
  const tw = rotRect(12, 10, m, rotA)
  P.add('buffBrick', prism(tw, 0, 22, { top: false }))
  P.add('slate', slab(tw, 22))
  if (hi) P.add('buffBrick', prism(offsetPoly(tw, -0.3), 21, 23.2, { top: false, bottom: true }))
  P.add('glassPod', panel(tw[0], tw[1], 0.3, 0.7, 8, 17, 0.08))
  P.add('limestone', panel(tw[0], tw[1], 0.35, 0.65, 0, 5.5, 0.08))
  // flanking octagonal turrets with ogee caps
  for (const s of [-1, 1]) {
    const tcn: V2 = [m[0] + dir[0] * s * 7.2 - dir[1] * 3.5, m[1] + dir[1] * s * 7.2 + dir[0] * 3.5]
    P.add('buffBrick', cyl(2.4, 27, 0, 8, 2.4, tcn[0], tcn[1]))
    P.add('copper', cyl(2.7, 1.6, 27, 8, 2.1, tcn[0], tcn[1]))
    P.add('copper', cyl(2.1, 3.4, 28.6, 8, 0.05, tcn[0], tcn[1]))
    P.add('copper', cyl(0.18, 2, 32, 4, 0.02, tcn[0], tcn[1]))
  }
  return P.build('trinity_college')
}

// ---------------------------------------------------------------------------
// Victoria College "Old Vic" (W.G. Storm, 1892): Richardsonian Romanesque,
// red sandstone, massive square tower and a round corner turret.

export function buildVictoriaCollege(ctx: BuildCtx) {
  const P = new Parts()
  const vic = partOf(ctx, 'vic', rect(48, 40))
  block(P, vic, [], 0, 16, 7, 8, 'pinkSandstone', 'slate')
  const b = bbox(vic)
  // entrance tower on the west (Queen's Park) front
  const [a, c] = faceEdge(vic, [b.x0 - 300, b.cy], 10)
  const m = along(a, c, 0.5, -3.5)
  const len = Math.hypot(c[0] - a[0], c[1] - a[1])
  const rotA = Math.atan2((c[1] - a[1]) / len, (c[0] - a[0]) / len)
  squareTower(P, m, 9, 0, 30, 8.5, 'pinkSandstone', 'slate', { rot: rotA })
  const sq = rotRect(9, 9, m, rotA)
  for (let i = 0; i < 4; i++) P.add('glassPod', panel(sq[i], sq[(i + 1) % 4], 0.3, 0.7, 22, 28, 0.08))
  // round turret on the south-west corner
  const sw: V2 = [b.x0 + 3, b.y0 + 3]
  turret(P, sw, 3.4, 0, 20, 7, 'pinkSandstone', 'slate', 12)
  return P.build('victoria_college')
}

// ---------------------------------------------------------------------------
// Ontario Legislative Building (R.A. Waite, 1893): Richardsonian Romanesque,
// pink Credit Valley sandstone, slate roofs.

export function buildLegislature(ctx: BuildCtx) {
  const P = new Parts()
  addHeritage(P, ctx, (p) => {
    if ((p.h ?? 0) <= 1) return { wall: 'granite', roof: 'granite', flat: 'granite' }
    if (p.roof === 'dome') return { wall: 'pinkSandstone', roof: 'copper' }
    return { wall: 'pinkSandstone', roof: 'slate', flat: 'slate' }
  })
  if (!ctx.entry?.osmParts?.length) block(P, partOf(ctx, 'leg', rect(150, 60)), [], 0, 20, 8, 10, 'pinkSandstone', 'slate')
  // flagpoles on the central tower pair
  for (const id of [960958866, 960958864]) {
    const p = osmPart(ctx, id)
    if (!p) continue
    const c = centroid(p.poly)
    P.add('metalDark', cyl(0.12, 7, 60, 4, 0.06, c[0], c[1]))
  }
  return P.build('ontario_legislature')
}

// ---------------------------------------------------------------------------
// King's College Circle: the front campus lawn (artificial turf since 2021)
// ringed by the road.

export function buildKingsCollegeCircle(ctx: BuildCtx) {
  const P = new Parts()
  const ring = ellipse(68, 53, 40)
  const lawn = ellipse(62, 47, 40)
  P.add('granite', slab(ring, 0.12))
  P.add('grass', slab(lawn, 0.2))
  void ctx
  return P.build('kings_college_circle')
}

// ---------------------------------------------------------------------------
// Royal Ontario Museum: the 1914 west wing and 1933 east wing along Queen's
// Park (buff brick/stone), minus the Crystal (a separate landmark).

export function buildRomHeritage(ctx: BuildCtx) {
  const P = new Parts()
  addHeritage(P, ctx, (p) => {
    if (p.whole) return null
    if (p.kind === 'steps' || (p.h ?? 0) <= 1.5) return { wall: 'granite', roof: 'granite', flat: 'granite' }
    if (p.id === 992716632) return { wall: 'romAlu', roof: 'romAlu', flat: 'romAlu' }
    if (p.roof === 'pyramidal') return { wall: 'buffBrick', roof: 'copper' }
    return { wall: 'buffBrick', roof: 'slate', flat: 'roofDark' }
  })
  return P.build('rom_heritage')
}

