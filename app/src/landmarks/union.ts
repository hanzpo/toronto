// Union Station, Toronto: the whole complex, handcrafted.
//
// References: Wikipedia "Union Station (Toronto)"; Metrolinx / City of
// Toronto Union Station Revitalization (2009–2021: restored Bush train shed,
// glass atrium over the centre tracks by Zeidler, York and Bay concourses
// under the tracks); OSM platform ways 32022881–32022893, 32023026 (track 3),
// 333175197 (UP Express 1A) and the OSM rail ways for track positions.
//
// Frame: landmarks.json `union_station` (origin 216.98 E, −940.4 N, base
// 1.81 m datum, rotated 16.5° with the downtown grid): x = east along Front
// Street, y (plan) = north, +height up. Rails sit at 8.3 m datum (6.5 m local):
// the tracks run on a deck above the concourses, ~6.5 m above Front Street.
//
//  • head house (1927, Ross & Macdonald): OSM building:parts massing (Great
//    Hall block, east/west wings, 22-column Tuscan colonnade on Front St)
//    plus plinths/capitals, cornices and the entablature band;
//  • track deck / concourse block between York St (x ≈ −169) and Bay St
//    (x ≈ 187) with glazed concourse fronts on the street underpasses;
//  • island platforms between every pair of the 11 through tracks (the
//    Union pattern: track, platform, track, platform …) + the track-3 side
//    platform along the north edge + the UP Express platform (1A) west of York;
//  • Bush train shed (1930): a low roof per platform on a centre row of
//    columns with smoke slots over every track;
//  • the glass atrium (2018) rising over the central tracks, steel arches.
import * as THREE from 'three/webgpu'
import { Parts, prism, rect, cyl, box, beam, P as P3, ccw, type V2 } from './kit'
import { addOsmParts } from './osmparts'
import type { BuildCtx } from './types'

/** rail elevation above the landmark base (8.3 m datum − 1.81 m) */
export const UNION_RAIL = 6.5
/** platform top above rail */
const PLAT_H = 0.9
/** track centrelines (local y), north → south, sampled every 15 m from x = −195 to 225 (OSM rail ways) */
const TX0 = -195, TDX = 15
const TRACK_TAB: number[][] = [
  [16.2, 10.38, 3.38, -3.0, -10.32, -18.86, -25.83, -34.39, -41.63, -50.17, -58.66],
  [17.12, 11.8, 4.01, -2.92, -10.36, -18.9, -25.83, -34.4, -41.65, -50.28, -58.83],
  [17.05, 12.37, 4.37, -2.87, -10.4, -18.93, -25.87, -34.43, -41.68, -50.37, -58.96],
  [17.0, 12.4, 4.38, -2.9, -10.42, -18.96, -25.96, -34.48, -41.7, -50.41, -58.98],
  [16.95, 12.44, 4.38, -2.93, -10.44, -18.98, -26.06, -34.52, -41.73, -50.45, -59.01],
  [16.9, 12.47, 4.38, -2.96, -10.46, -19.01, -26.16, -34.57, -41.75, -50.48, -59.03],
  [16.85, 12.51, 4.39, -2.99, -10.49, -19.04, -26.26, -34.62, -41.78, -50.52, -59.06],
  [16.8, 12.52, 4.39, -3.02, -10.51, -19.06, -26.35, -34.67, -41.8, -50.56, -59.08],
  [16.75, 12.52, 4.39, -3.05, -10.53, -19.09, -26.45, -34.72, -41.83, -50.6, -59.11],
  [16.69, 12.53, 4.4, -3.08, -10.55, -19.12, -26.55, -34.77, -41.86, -50.63, -59.13],
  [16.64, 12.53, 4.4, -3.11, -10.57, -19.14, -26.64, -34.81, -41.88, -50.67, -59.16],
  [16.59, 12.53, 4.4, -3.15, -10.6, -19.17, -26.74, -34.86, -41.91, -50.71, -59.18],
  [16.54, 12.53, 4.41, -3.18, -10.62, -19.2, -26.84, -34.91, -41.93, -50.74, -59.21],
  [16.49, 12.53, 4.41, -3.21, -10.64, -19.22, -26.94, -34.96, -41.96, -50.78, -59.23],
  [16.46, 12.53, 4.41, -3.24, -10.68, -19.25, -27.01, -35.0, -42.0, -50.81, -59.26],
  [16.45, 12.54, 4.42, -3.26, -10.75, -19.28, -27.05, -35.04, -42.07, -50.83, -59.28],
  [16.44, 12.54, 4.42, -3.29, -10.81, -19.3, -27.09, -35.07, -42.14, -50.85, -59.31],
  [16.43, 12.54, 4.42, -3.32, -10.88, -19.33, -27.13, -35.1, -42.21, -50.86, -59.33],
  [16.42, 12.54, 4.43, -3.35, -10.94, -19.36, -27.17, -35.14, -42.28, -50.88, -59.36],
  [16.41, 12.55, 4.43, -3.37, -11.01, -19.39, -27.21, -35.17, -42.35, -50.9, -59.38],
  [16.4, 12.55, 4.43, -3.4, -11.08, -19.41, -27.25, -35.21, -42.41, -50.92, -59.41],
  [16.39, 12.55, 4.44, -3.43, -11.14, -19.44, -27.29, -35.24, -42.48, -50.93, -59.44],
  [16.38, 12.55, 4.44, -3.46, -11.21, -19.47, -27.33, -35.28, -42.55, -50.95, -59.46],
  [16.37, 12.56, 4.45, -3.48, -11.27, -19.49, -27.37, -35.31, -42.62, -50.97, -59.49],
  [16.36, 12.56, 4.45, -3.51, -11.34, -19.52, -27.42, -35.35, -42.69, -50.99, -59.51],
  [14.75, 12.07, 4.45, -3.54, -11.4, -19.55, -27.46, -35.38, -42.75, -51.01, -59.54],
  [12.26, 12.26, 4.32, -3.68, -11.33, -19.6, -27.5, -35.45, -42.72, -51.11, -59.56],
  [9.89, 9.89, 3.58, -4.29, -11.38, -19.8, -27.54, -35.55, -42.62, -51.29, -59.58],
  [8.0, 8.0, 2.76, -4.9, -11.43, -20.0, -27.58, -35.63, -42.6, -51.43, -59.6],
]
const NT = 11
/** the UP Express track west of York (continuation of the north track), [x, y] */
const UP_TRACK: V2[] = [[-280, 9.5], [-262, 11.0], [-240, 12.7], [-220, 14.3], [-200, 15.8], [-190, 16.6], [-180, 17.12]]
const EDGE = 1.65
const DECK_X0 = -169, DECK_X1 = 187, DECK_Y0 = -78, DECK_Y1 = 34
const PLAT_X0 = -167, PLAT_X1 = 185
const SHED_X0 = -166, SHED_X1 = 184
const ATRIUM = { x0: -38, x1: 52, y0: -38, y1: 8 }
/** Bush shed eave above rail (a GO bilevel is 4.8 m tall) */
const EAVE = 5.9

export const trackY = (i: number, x: number) => {
  const f = Math.max(0, Math.min(TRACK_TAB.length - 1.0001, (x - TX0) / TDX))
  const k = Math.floor(f), u = f - k
  return TRACK_TAB[k][i] * (1 - u) + TRACK_TAB[k + 1][i] * u
}

const upY = (x: number) => {
  for (let i = 0; i < UP_TRACK.length - 1; i++) {
    const [xa, ya] = UP_TRACK[i], [xb, yb] = UP_TRACK[i + 1]
    if (x <= xb) return ya + ((yb - ya) * (x - xa)) / (xb - xa)
  }
  return UP_TRACK[UP_TRACK.length - 1][1]
}

/** Platforms: lateral range between adjacent tracks (for StationsLayer / QA). */
export function unionPlatforms(): { y0: (x: number) => number; y1: (x: number) => number; x0: number; x1: number; name: string }[] {
  const out = []
  // track 3 (north side platform), ends where the north tracks converge
  out.push({ y0: (x: number) => trackY(0, x) + EDGE, y1: (x: number) => trackY(0, x) + EDGE + 3.8, x0: PLAT_X0, x1: 168, name: '3' })
  let n = 4
  for (let i = 1; i < NT - 1; i++) {
    const a = i, b = i + 1
    // only where the two tracks are far enough apart for a platform
    let x0 = PLAT_X0, x1 = PLAT_X1
    while (x0 < x1 && trackY(a, x0) - trackY(b, x0) < 2 * EDGE + 2.5) x0 += 5
    while (x1 > x0 && trackY(a, x1) - trackY(b, x1) < 2 * EDGE + 2.5) x1 -= 5
    out.push({ y0: (x: number) => trackY(b, x) + EDGE, y1: (x: number) => trackY(a, x) - EDGE, x0, x1, name: `${n}–${n + 1}` })
    n += 2
  }
  return out
}

function strip(y0: (x: number) => number, y1: (x: number) => number, x0: number, x1: number, step = 15): V2[] {
  const xs: number[] = []
  for (let x = x0; x < x1; x += step) xs.push(x)
  xs.push(x1)
  return [...xs.map((x) => [x, y0(x)] as V2), ...xs.reverse().map((x) => [x, y1(x)] as V2)]
}

export function buildUnionStation(ctx: BuildCtx) {
  const hi = ctx.detail === 'high'
  const P = new Parts()
  const R = UNION_RAIL

  // ---------------------------------------------------------------- head house
  buildHeadHouse(P, ctx, hi)

  // ---------------------------------------------------------------- track deck + concourses
  const deck = rect(DECK_X1 - DECK_X0, DECK_Y1 - DECK_Y0, (DECK_X0 + DECK_X1) / 2, (DECK_Y0 + DECK_Y1) / 2)
  // the terrain here is already raised to rail level (embankment): keep the deck just above it
  P.add('concrete', prism(deck, -2, R + 0.04))
  // glazed York / Bay concourse fronts on the street underpasses
  for (const [x, s] of [[DECK_X0 - 0.15, -1], [DECK_X1 + 0.15, 1]] as [number, number][]) {
    P.add('glassGrey', box(0.3, 4.6, 70, x, 2.5, -26))
    P.add('metalDark', box(0.6, 0.5, 72, x + s * 0.2, 5.0, -26))
  }
  // UP Express deck west of York St (follows the UP track)
  P.add('concrete', prism(ccw(strip((x) => upY(x) - 3.5, (x) => upY(x) + 8.5, -268, DECK_X0 + 1, 6)), -2, R + 0.04))

  // ---------------------------------------------------------------- platforms
  const plats = unionPlatforms()
  for (const pl of plats) {
    const poly = ccw(strip(pl.y0, pl.y1, pl.x0, pl.x1))
    P.add('concrete', prism(poly, R - 0.3, R + PLAT_H))
    if (hi) {
      // yellow tactile strips along the platform edges
      const t = 0.6
      P.add('yellow', prism(ccw(strip(pl.y0, (x) => pl.y0(x) + t, pl.x0, pl.x1)), R + PLAT_H, R + PLAT_H + 0.02, { top: true }))
      if (pl.name !== '3') P.add('yellow', prism(ccw(strip((x) => pl.y1(x) - t, pl.y1, pl.x0, pl.x1)), R + PLAT_H, R + PLAT_H + 0.02))
    }
  }
  // ballast / track bed under every track (dark), so the tracks read between the platforms
  for (let i = 0; i < NT; i++) {
    const t = (x: number) => trackY(i, x)
    P.add('roofDark', prism(ccw(strip((x) => t(x) - 1.65, (x) => t(x) + 1.65, DECK_X0, DECK_X1)), R + 0.04, R + 0.07))
    // running rails (standard gauge): the tile rails drape on the terrain below the deck
    if (hi) for (const g of [-0.7175, 0.7175]) P.add('metalDark', prism(ccw(strip((x) => t(x) + g - 0.04, (x) => t(x) + g + 0.04, DECK_X0, DECK_X1)), R + 0.07, R + 0.2))
  }
  // UP Express platform 1A (side platform north of the UP track, west of York)
  P.add('concrete', prism(ccw(strip((x) => upY(x) + EDGE, (x) => upY(x) + EDGE + 4.2, -262, -190, 6)), R - 0.3, R + 1.05))
  if (hi) P.add('yellow', prism(ccw(strip((x) => upY(x) + EDGE, (x) => upY(x) + EDGE + 0.6, -262, -190, 6)), R + 1.05, R + 1.07))
  // UP canopy: white steel, glass roof, set back from the platform edge
  P.add('steelWhite', prism(ccw(strip((x) => upY(x) + EDGE + 0.6, (x) => upY(x) + EDGE + 4.6, -260, -192, 6)), R + 4.9, R + 5.2))
  for (let x = -256; x <= -196; x += 8) P.add('steelWhite', cyl(0.18, 3.85, R + 1.05, 6, 0.18, x, upY(x) + EDGE + 3.4))

  // ---------------------------------------------------------------- Bush train shed
  // Per platform: a low gabled roof on a centre row of columns; open smoke
  // slots (~1.4 m) over every track between the roofs.
  const inAtrium = (x: number) => x > ATRIUM.x0 && x < ATRIUM.x1
  const shedSeg = (x0: number, x1: number, y0: (x: number) => number, y1: (x: number) => number, ridge: number) => {
    const eave = R + EAVE, rid = R + EAVE + ridge
    const xm = (x0 + x1) / 2
    const a0 = y0(xm), a1 = y1(xm)
    const mid = (a0 + a1) / 2
    // two roof planes (as thin prisms) + fascia (smoke deflector) at each slot edge
    const s1: V2[] = [[x0, a0], [x1, a0], [x1, mid], [x0, mid]]
    const s2: V2[] = [[x0, mid], [x1, mid], [x1, a1], [x0, a1]]
    P.add('roofDark', skewSlab(s1, [eave, eave, rid, rid], 0.35, true))
    P.add('roofDark', skewSlab(s2, [rid, rid, eave, eave], 0.35, true))
    P.add('shedUnder', skewSlab(s1, [eave, eave, rid, rid], 0.35, false))
    P.add('shedUnder', skewSlab(s2, [rid, rid, eave, eave], 0.35, false))
    P.add('concreteDark', box(x1 - x0, 0.6, 0.25, xm, eave - 0.2, a0 + 0.12))
    P.add('concreteDark', box(x1 - x0, 0.6, 0.25, xm, eave - 0.2, a1 - 0.12))
  }
  const bays: { y0: (x: number) => number; y1: (x: number) => number }[] = []
  bays.push({ y0: (x) => trackY(0, x) + 0.7, y1: (x) => trackY(0, x) + EDGE + 4.3 }) // track 3 platform
  for (let i = 1; i < NT - 1; i++) bays.push({ y0: (x) => trackY(i + 1, x) + 0.7, y1: (x) => trackY(i, x) - 0.7 })
  bays.push({ y0: (x) => trackY(NT - 1, x) - 4.5, y1: (x) => trackY(NT - 1, x) - 0.7 }) // south edge
  const segL = hi ? 15 : 30
  for (const b of bays) {
    for (let x = SHED_X0; x < SHED_X1 - 0.1; x += segL) {
      const x1 = Math.min(SHED_X1, x + segL)
      // leave the atrium opening
      const c0 = x, c1 = x1
      if (inAtrium((c0 + c1) / 2) && b.y1((c0 + c1) / 2) > ATRIUM.y0 && b.y0((c0 + c1) / 2) < ATRIUM.y1) {
        if (c0 < ATRIUM.x0) shedSeg(c0, ATRIUM.x0, b.y0, b.y1, 0.7)
        if (c1 > ATRIUM.x1) shedSeg(ATRIUM.x1, c1, b.y0, b.y1, 0.7)
        continue
      }
      shedSeg(c0, c1, b.y0, b.y1, 0.7)
    }
    // centre row of columns
    for (let x = SHED_X0 + 4; x < SHED_X1; x += 12) {
      const y = (b.y0(x) + b.y1(x)) / 2
      if (inAtrium(x) && y > ATRIUM.y0 && y < ATRIUM.y1) continue
      if (Math.abs(x - 151) < 3) continue // Bay St streetcar tunnel below (keep in sync with tpipe/stations.py)
      P.add('metalDark', box(0.4, EAVE - PLAT_H, 0.4, x, R + PLAT_H + (EAVE - PLAT_H) / 2, y))
    }
  }

  // ---------------------------------------------------------------- glass atrium (2018)
  {
    const { x0, x1, y0, y1 } = ATRIUM
    const span = y1 - y0, yc = (y0 + y1) / 2
    const spring = R + 9, crown = R + 18
    const nA = hi ? 10 : 6
    const arc = (k: number): [number, number] => {
      const t = k / nA
      const y = y0 + span * t
      const u = (y - yc) / (span / 2)
      return [y, spring + (crown - spring) * (1 - u * u)]
    }
    // glass vault (quads along x) + steel arches every 7.5 m
    const g: number[] = []
    for (let k = 0; k < nA; k++) {
      const [ya, za] = arc(k), [yb, zb] = arc(k + 1)
      g.push(x0, za, -ya, x1, za, -ya, x1, zb, -yb, x0, za, -ya, x1, zb, -yb, x0, zb, -yb)
    }
    const vg = new THREE.BufferGeometry()
    vg.setAttribute('position', new THREE.Float32BufferAttribute(g, 3))
    vg.computeVertexNormals()
    P.add('glassPlain', vg)
    const under = vg.clone()
    const pos = under.getAttribute('position') as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i += 3) { // flip winding for the underside
      const bx = pos.getX(i + 1), by = pos.getY(i + 1), bz = pos.getZ(i + 1)
      pos.setXYZ(i + 1, pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2))
      pos.setXYZ(i + 2, bx, by, bz)
    }
    under.computeVertexNormals()
    P.add('glassPlain', under)
    for (let x = x0; x <= x1 + 0.01; x += 7.5) {
      for (let k = 0; k < nA; k++) {
        const [ya, za] = arc(k), [yb, zb] = arc(k + 1)
        P.add('steelWhite', beam(P3(x, za + 0.3, ya), P3(x, zb + 0.3, yb), 0.35, 0.7))
      }
      // arch legs down to the platforms
      for (const y of [y0, y1]) P.add('steelWhite', beam(P3(x, R + PLAT_H, y), P3(x, spring + 0.3, y), 0.5))
    }
    // glazed gable ends
    for (const x of [x0, x1]) {
      const pts: number[] = []
      for (let k = 0; k < nA; k++) {
        const [ya, za] = arc(k), [yb, zb] = arc(k + 1)
        pts.push(x, spring, -ya, x, za, -ya, x, zb, -yb, x, spring, -ya, x, zb, -yb, x, spring, -yb)
      }
      const eg = new THREE.BufferGeometry()
      eg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
      eg.computeVertexNormals()
      P.add('glassPlain', eg)
    }
    // eaves beams along both long sides
    for (const y of [y0, y1]) P.add('steelWhite', box(x1 - x0, 0.8, 0.6, (x0 + x1) / 2, spring, y))
  }
  return P.build('union_station')
}

/** quad slab with per-corner top heights (poly = 4 corners), thickness t below */
function skewSlab(poly: V2[], h: number[], t: number, topFace: boolean): THREE.BufferGeometry {
  const top = poly.map(([x, y], i) => new THREE.Vector3(x, h[i], -y))
  const bot = poly.map(([x, y], i) => new THREE.Vector3(x, h[i] - t, -y))
  const tri: number[] = []
  const push = (...v: THREE.Vector3[]) => { for (const p of v) tri.push(p.x, p.y, p.z) }
  const up = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a))
    return n.y >= 0
  }
  if (topFace) {
    if (up(top[0], top[1], top[2])) push(top[0], top[1], top[2], top[0], top[2], top[3])
    else push(top[0], top[2], top[1], top[0], top[3], top[2])
  } else {
    if (up(bot[0], bot[1], bot[2])) push(bot[0], bot[2], bot[1], bot[0], bot[3], bot[2])
    else push(bot[0], bot[1], bot[2], bot[0], bot[2], bot[3])
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(tri, 3))
  g.computeVertexNormals()
  return g
}

// ---------------------------------------------------------------------------
// Head house (Ross & Macdonald / Hugh Jones, 1914–27): smooth Indiana
// limestone; 229 m along Front St. Central portico of 22 Tuscan columns
// (~12 m, 1.4 m diameter) standing ~5 m in front of the recessed Great Hall
// wall with its four tall windows, heavy entablature + attic; long east/west
// wings with a rusticated ground floor of tall openings and three storeys of
// punched windows above; end pavilions with pyramidal roofs.

const FRONT = 75 // plan y of the Front St wall line
const PORT_X0 = -33, PORT_X1 = 48 // portico (colonnade) extent
const RECESS = 5.2

function buildHeadHouse(P: Parts, ctx: BuildCtx, hi: boolean) {
  const S = 'limestoneSmooth' as const
  const skip = new Set([-12810367, 290168028, 951328327, 951328329, 951328331, 951328341])
  addOsmParts(P, ctx, (p) => {
    if (p.kind === 'roof' || p.kind === 'column') return null
    return { wall: S, roof: 'roofDark', pitched: 'copper' }
  }, (p) => !skip.has(p.id))
  // main block (wings + centre) to the cornice, with the portico recess
  const main: V2[] = [
    [-109, 20], [120, 20], [120, FRONT], [PORT_X1, FRONT], [PORT_X1, FRONT - RECESS],
    [PORT_X0, FRONT - RECESS], [PORT_X0, FRONT], [-109, FRONT],
  ]
  P.add(S, prism(ccw(main), -1, 17))
  // rusticated base course + belt courses, main cornice, attic
  for (const [x0, x1] of [[-109, PORT_X0], [PORT_X1, 120]] as [number, number][]) {
    const w = x1 - x0, cx = (x0 + x1) / 2
    P.add('granite', box(w, 0.9, 0.5, cx, 0.45, FRONT + 0.2))
    P.add(S, box(w, 0.4, 0.35, cx, 5.6, FRONT + 0.15))
    P.add(S, box(w, 0.9, 1.1, cx, 16.4, FRONT + 0.5)) // cornice
    P.add(S, box(w, 2.2, 0.4, cx, 17.9, FRONT - 0.3)) // attic parapet
  }
  // centre block behind the portico: raised to the entablature, attic above
  P.add(S, prism(ccw([[PORT_X0, 33], [PORT_X1, 33], [PORT_X1, FRONT - RECESS], [PORT_X0, FRONT - RECESS]]), 16.2, 19))
  // ---- colonnade: 22 Tuscan columns
  const n = 22
  const cy = FRONT - 1.4
  for (let i = 0; i < n; i++) {
    const x = PORT_X0 + 1.6 + ((PORT_X1 - PORT_X0 - 3.2) * i) / (n - 1)
    P.add('granite', box(1.9, 0.8, 1.9, x, 0.4, cy))
    P.add(S, cyl(0.86, 0.3, 0.8, hi ? 16 : 8, 0.8, x, cy))
    P.add(S, cyl(0.72, 9.9, 1.1, hi ? 16 : 8, 0.6, x, cy)) // entasis: shaft tapers
    P.add(S, cyl(0.62, 0.35, 11.0, hi ? 16 : 8, 0.85, x, cy)) // echinus
    P.add(S, box(1.9, 0.45, 1.9, x, 11.57, cy)) // abacus
  }
  // stylobate (steps up to the portico)
  P.add('granite', box(PORT_X1 - PORT_X0 + 2, 0.5, RECESS + 2.4, (PORT_X0 + PORT_X1) / 2, 0.25, FRONT - RECESS / 2 + 1.1))
  // entablature: architrave, frieze (inscription band), cornice, attic
  const ex = (PORT_X0 + PORT_X1) / 2, ew = PORT_X1 - PORT_X0 + 1.2
  P.add(S, box(ew, 1.3, RECESS + 1.6, ex, 12.45, FRONT - RECESS / 2 + 0.5))
  P.add(S, box(ew, 1.6, RECESS + 1.4, ex, 13.9, FRONT - RECESS / 2 + 0.4))
  P.add(S, box(ew + 1, 0.8, RECESS + 2.4, ex, 15.1, FRONT - RECESS / 2 + 0.7))
  P.add(S, box(ew - 2, 2.6, RECESS + 0.6, ex, 16.8, FRONT - RECESS / 2 + 0.1))
  // (the UNION STATION inscription on the frieze is not modelled: block letters read as windows at this scale)
  // ---- windows: recessed Great Hall wall (4 tall windows between columns)
  const win = (x: number, y0: number, w: number, h: number, yN: number, arch = false) => {
    P.add('glassPlain', box(w, h, 0.12, x, y0 + h / 2, yN + 0.02))
    P.add(S, box(w + 0.7, 0.35, 0.45, x, y0 - 0.1, yN + 0.2)) // sill
    if (arch) P.add(S, box(w + 0.9, 0.7, 0.35, x, y0 + h + 0.35, yN + 0.15)) // lintel / voussoir band
  }
  // the recessed wall reads darker (in the portico's shade)
  P.add('stoneGrey', box(PORT_X1 - PORT_X0, 11.8, 0.06, (PORT_X0 + PORT_X1) / 2, 5.9, FRONT - RECESS + 0.03))
  for (const f of [0.2, 0.4, 0.6, 0.8]) win(PORT_X0 + (PORT_X1 - PORT_X0) * f, 2.2, 4.4, 8.6, FRONT - RECESS, true)
  // doors between the windows
  for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) P.add('metalDark', box(2.6, 3.6, 0.12, PORT_X0 + (PORT_X1 - PORT_X0) * f, 2.3, FRONT - RECESS + 0.02))
  // wings: tall ground-floor openings (arched), three storeys of punched windows
  for (const [x0, x1] of [[-107, PORT_X0 - 2], [PORT_X1 + 2, 118]] as [number, number][]) {
    const bay = 3.9
    const nb = Math.floor((x1 - x0) / bay)
    const off = x0 + ((x1 - x0) - nb * bay) / 2 + bay / 2
    for (let i = 0; i < nb; i++) {
      const x = off + i * bay
      if (i % 2 === 0) win(x + bay / 2, 1.2, 2.6, 3.9, FRONT, true)
      for (const y of [6.6, 9.6, 12.6]) win(x, y, 1.35, 2.1, FRONT)
    }
  }
}
