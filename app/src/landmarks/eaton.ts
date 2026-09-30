// Yonge Street retail & theatre landmarks: CF Toronto Eaton Centre (+ the
// Hudson's Bay/Simpson's store, Simpson Tower and the Queen St skywalk),
// Yonge-Dundas Square with its LED screens, Massey Hall, and the Elgin &
// Winter Garden Theatre Centre. All in the downtown grid frame (x ≈ along
// Queen St, y ≈ up Yonge St) on the exact OSM footprints from landmarks.json.
import * as THREE from 'three/webgpu'
import { Parts, prism, slab, bbox, cyl, box, offsetPoly, rect, ccw, cleanPoly, beam, P as P3, type V2 } from './kit'
import { screenUV, type MatKey } from './materials'
import type { BuildCtx, OsmPart } from './types'
import {
  vault, addParts, partOf, zOf, osmPart, lift, panel, edgeBox, gableWing, along, faceEdge,
} from './kit2'

// ---------------------------------------------------------------------------
// CF Toronto Eaton Centre (Eberhard Zeidler / Bregman + Hamann, 1977)

const EC_GALLERIA = 964837800
const EC_TOWERS: Record<number, MatKey> = {
  34545732: 'bronzeGlass', // Cadillac Fairview Tower, 142 m
  54777875: 'bronzeGlass', // One Dundas West, 111 m
  117894877: 'glassTeal', // 250 Yonge, 151 m
  964837808: 'glassTeal', 964837809: 'glassTeal', 964837810: 'glassTeal', 964837811: 'glassTeal', 964837812: 'glassTeal',
}

export function buildEatonCentre(ctx: BuildCtx) {
  const hi = ctx.detail === 'high'
  const P = new Parts()
  const BAY: Record<number, [number, MatKey]> = {
    951764161: [29, 'sandstone'], // 1895 Simpson's store at Yonge & Queen (Burke)
    951764162: [41, 'limestone'], // 1929 Art Deco addition at Bay & Queen
  }
  addParts(P, ctx, (p) => {
    if (p.id === EC_GALLERIA || p.kind === 'roof') return null
    if (EC_TOWERS[p.id]) return { wall: EC_TOWERS[p.id], roof: 'roofDark' }
    if (BAY[p.id]) return null
    return { wall: 'ecPrecast', roof: 'roofLight' }
  })
  // Yonge Street frontage (local x ≈ 50–57 is the building line, Yonge's
  // centreline ≈ 64): shop fronts, entrance canopies and granite forecourts
  // filling the setback between the precast walls and the sidewalk.
  yongeFrontage(P, ctx, hi)
  // Hudson's Bay Queen Street (former Simpson's) + Simpson Tower on top of it
  for (const [id, [h, mat]] of Object.entries(BAY)) {
    const p = osmPart(ctx, +id)
    if (!p) continue
    const poly = ccw(cleanPoly(p.poly))
    const z = lift(p)
    P.add(mat, prism(poly, z, z + h, { top: false }))
    P.add('roofDark', slab(poly, z + h))
    P.add('storefront', prism(offsetPoly(poly, -0.1), z, z + 5, { top: false }))
    if (hi) P.add(mat, prism(offsetPoly(poly, -0.6), z + h - 1.6, z + h, { top: false, bottom: true }))
  }
  const simpson = partOf(ctx, 'simpson', rect(38, 34, -102, -247))
  const zs = zOf(ctx, 'simpson')
  P.add('bronzeGlass', prism(simpson, zs + 41, zs + 144, { top: false }))
  P.add('roofDark', slab(simpson, zs + 144))
  P.add('concreteDark', prism(offsetPoly(simpson, -0.3), zs + 138, zs + 144, { top: false }))

  // The Galleria: 264 m glass vault (after Milan's Galleria Vittorio Emanuele II)
  const gp = osmPart(ctx, EC_GALLERIA)
  const gpoly = gp ? ccw(cleanPoly(gp.poly)) : rect(19, 260, -2.5, -70)
  const gb = bbox(gpoly)
  const spring = 21, crown = 28.5
  P.add('ecPrecast', prism(gpoly, 0, spring, { top: false }))
  P.add('roofLight', slab(gpoly, spring - 0.2))
  // The glazed vault sits on the central 17 m of the part, full length
  const gx0 = gb.cx - 8.5, gx1 = gb.cx + 8.5
  vault(P, gx0, gx1, gb.y0 + 1, gb.y1 - 1, spring, crown, hi)

  // Queen Street skywalk (2017): glazed diagrid tube to the Bay store
  const bay = partOf(ctx, 'bay', rect(176, 65, -38, -262))
  const by = bbox(bay).y1
  const sy0 = gb.y0 - 1, sy1 = by - 4, sx = gb.cx - 2
  const skw = rect(6, sy0 - sy1, sx, (sy0 + sy1) / 2)
  P.add('vaultGlass', prism(skw, 7, 12, { bottom: true }))
  if (hi) {
    for (let y = sy1; y < sy0; y += 2.5) {
      P.add('steelWhite', box(6.3, 0.25, 0.25, sx, 12, y))
      P.add('steelWhite', box(6.3, 0.25, 0.25, sx, 7, y))
    }
  }
  P.add('steelWhite', box(6.4, 0.6, sy0 - sy1, sx, 7, (sy0 + sy1) / 2))

  // Big LED screens at the Yonge & Dundas corner (NE corner of the north block)
  const north = osmPart(ctx, 965074490)
  if (north) {
    const poly = ccw(cleanPoly(north.poly))
    const [a, b] = faceEdge(poly, [120, 175])
    const z = lift(north)
    P.add('ledScreen', panel(a, b, 0.62, 0.98, z + 9, z + 27, 0.4, screenUV(2)))
    P.add('metalDark', edgeBox(a, b, 0.61, 0.99, z + 8.4, z + 27.6, 0.3, 0.05))
    const [c, d] = faceEdge(poly, [20, 300])
    P.add('ledScreen', panel(c, d, 0.55, 0.95, z + 12, z + 26, 0.4, screenUV(3)))
  }
  return P.build('eaton_centre')
}

// ---------------------------------------------------------------------------
// Sankofa Square, ex-Yonge-Dundas Square (Brown + Storey Architects, 2002)

export function buildYongeDundasSquare(ctx: BuildCtx) {
  const hi = ctx.detail === 'high'
  const P = new Parts()
  const top = 0.8
  // Plaza: irregular pentagon between Yonge, Dundas and Victoria
  const plaza: V2[] = ccw([[-19, 9.5], [80.5, 9.5], [81, 30], [61.5, 47.5], [-4.7, 78.5], [-19.5, 79]])
  P.add('granite', prism(plaza, 0, top, { top: false }))
  P.add('plazaPaving', slab(plaza, top))
  // Two rows of ten fountain grilles on the main east-west walkway; three
  // jets per grille rise and fall on their own phase (fountainJet material)
  let jet = 0
  for (const fy of [27, 33]) {
    for (let i = 0; i < 10; i++) {
      const fx = 6 + i * 5.2
      P.add('metalDark', slab(rect(2.2, 2.2, fx, fy), top + 0.02))
      for (let k = -1; k <= (hi ? 1 : -1); k++) {
        const hgt = 2.2 + ((i * 7 + k * 3 + fy) % 5) * 0.5
        P.add('fountainJet', jetQuads(fx + k * 0.7, fy, top + 0.03, hgt, 0.5, jet++))
      }
    }
  }
  // TO TIX booth (half-price theatre tickets): small glazed pavilion
  const kiosk = osmPart(ctx, YDS_KIOSK)
  if (kiosk) {
    const kp = ccw(cleanPoly(kiosk.poly))
    P.add('glassGrey', prism(offsetPoly(kp, 0.2), top, top + 3, { top: false }))
    P.add('metalDark', prism(offsetPoly(kp, -0.4), top + 3, top + 3.5, { bottom: true }))
    const [a, b] = faceEdge(kp, [0, 0])
    P.add('signWarm', panel(a, b, 0.15, 0.85, top + 3.55, top + 4.3, 0.1))
  }
  // Angled canopy on 11 concrete pillars along Dundas
  const canopy = partOf(ctx, 'canopy', [[-8.45, 68.9], [34.05, 55.43], [61.2, 42.14], [61.58, 47.31], [-0.89, 78.33], [-4.74, 78.08]])
  P.add('vaultGlass', prism(canopy, 8.2, 8.6, { bottom: true }))
  P.add('zinc', prism(offsetPoly(canopy, -0.3), 8.6, 9.0, { bottom: true, top: true }))
  const ca: V2 = [-6.5, 73.5], cb: V2 = [61.4, 44.7]
  for (let i = 0; i < 11; i++) {
    const t = i / 10
    P.add('concrete', cyl(0.45, 8.2 - top, top, 8, 0.45, ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t))
  }
  // Stage with its transparent canopy
  const stage = partOf(ctx, 'stage', rect(17.5, 9.7, 9.3, 72.4))
  P.add('granite', prism(stage, top, top + 1.1))
  P.add('vaultGlass', prism(offsetPoly(stage, -0.5), 7.2, 7.5, { bottom: true }))
  for (const p of stage) P.add('steelWhite', cyl(0.18, 6.4, top + 1.1, 6, 0.18, p[0], p[1]))
  // Zinc canopy along the southern boundary
  const zc = rect(58, 4.5, 50, 12.5)
  P.add('zinc', prism(zc, 5.6, 6.1, { bottom: true }))
  if (hi) for (let x = 24; x <= 78; x += 9) P.add('metalDark', cyl(0.15, 5.6 - top, top, 6, 0.15, x, 14.2))

  // Buildings with the screens: 1 Dundas East (ex-Hard Rock), 33 Dundas East
  // (Citytv, curved screen), 10 Dundas East (The Tenor, billboard walls).
  addParts(P, ctx, (p) => {
    if (p.id === 61014138 || p.id === 1105572886 || p.id === 127288086 || p.id === YDS_KIOSK) return null
    if (p.id === 23447959) return { wall: 'glassGrey', roof: 'roofDark' }
    return { wall: p.id >= 975464622 ? 'ecPrecast' : 'glassGrey', roof: 'roofDark' }
  })
  // 1 Dundas East: 3-storey retail block, a giant screen wraps the square side
  const hr = partOf(ctx, 'hardrock', rect(38, 18))
  P.add('storefront', prism(hr, 0, 5, { top: false }))
  P.add('victorianBrick', prism(hr, 5, 13, { top: false }))
  P.add('roofDark', slab(hr, 13))
  {
    const [a, b] = faceEdge(hr, [0, 60])
    P.add('ledScreen', panel(a, b, 0.02, 0.98, 12, 27, 0.9, screenUV(0)))
    P.add('metalDark', edgeBox(a, b, 0.0, 1.0, 11.5, 27.5, 0.8, 0.05))
    const [c, d] = faceEdge(hr, [-60, 0])
    P.add('ledScreen', panel(c, d, 0.02, 0.98, 12, 27, 0.9, screenUV(1)))
    P.add('metalDark', edgeBox(c, d, 0.0, 1.0, 11.5, 27.5, 0.8, 0.05))
  }
  // 33 Dundas East: curved LED display wrapping its north-west corner
  const ct = partOf(ctx, 'citytv', rect(36, 40, 100, 10))
  {
    const pts: V2[] = [[99.32, 13.64], [94.55, 20.14], [91.03, 24.04], [90.38, 27.76], [89.31, 29.01], [86.16, 30.32], [82.66, 28.93]]
    let u = 0
    const L = pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0)
    for (let i = 0; i < pts.length - 1; i++) {
      const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
      const [u0, u1] = screenUV(2)
      P.add('ledScreen', panel(pts[i], pts[i + 1], 0, 1, 3.5, 13, 0.8, [u0 + ((u1 - u0) * u) / L, u0 + ((u1 - u0) * (u + l)) / L]))
      u += l
    }
    // CityNews crawl under the curved screen
    u = 0
    for (let i = 0; i < pts.length - 1; i++) {
      const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
      P.add('ticker', panel(pts[i], pts[i + 1], 0, 1, 2.3, 3.2, 0.85, [u, u + l]))
      u += l
    }
    const [a, b] = faceEdge(ct, [0, 5])
    P.add('ledScreen', panel(a, b, 0.05, 0.6, 9, 22, 0.5, screenUV(3)))
  }
  // 10 Dundas East: billboards & screens on the Dundas and Yonge walls
  const tn = partOf(ctx, 'tenor', rect(85, 120, 22, 140))
  const zt = zOf(ctx, 'tenor')
  {
    const [a, b] = faceEdge(tn, [0, 40]) // Dundas frontage (west half)
    P.add('ledScreen', panel(a, b, 0.05, 0.45, zt + 14, zt + 30, 0.6, screenUV(1)))
    P.add('ledScreen', panel(a, b, 0.55, 0.95, zt + 9, zt + 22, 0.6, screenUV(0)))
    P.add('metalDark', edgeBox(a, b, 0.03, 0.97, zt + 8.5, zt + 30.5, 0.5, 0.05))
    const [c, d] = faceEdge(tn, [45, 40]) // diagonal south-east wall
    P.add('ledScreen', panel(c, d, 0.1, 0.9, zt + 10, zt + 26, 0.6, screenUV(3)))
    const [e, f] = faceEdge(tn, [-80, 130]) // Yonge wall
    P.add('ledScreen', panel(e, f, 0.02, 0.3, zt + 6, zt + 30, 0.6, screenUV(2)))
    P.add('ledScreen', panel(e, f, 0.4, 0.62, zt + 10, zt + 24, 0.6, screenUV(0)))
    // media tower on the Yonge/Dundas corner
    const mt: V2 = [-16, 101]
    P.add('metalDark', prism(rect(6, 6, mt[0], mt[1]), zt, zt + 44))
    P.add('ledScreen', panel([mt[0] - 3, mt[1] - 3], [mt[0] + 3, mt[1] - 3], 0, 1, zt + 14, zt + 42, 0.05, screenUV(1)))
    P.add('ledScreen', panel([mt[0] - 3, mt[1] + 3], [mt[0] - 3, mt[1] - 3], 0, 1, zt + 14, zt + 42, 0.05, screenUV(3)))
  }
  return P.build('yonge_dundas_square')
}

const YDS_KIOSK = 1105572885

/** Sidewalk back edge on Yonge in the Eaton Centre frame (local x). */
const YONGE_BACK = 55.5

function yongeFrontage(P: Parts, ctx: BuildCtx, hi: boolean) {
  let k = 0
  for (const p of ctx.entry?.osmParts ?? []) {
    if (p.whole || p.minH > 1 || p.id === EC_GALLERIA) continue
    const poly = ccw(cleanPoly(p.poly))
    const z = lift(p)
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length]
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      if (len < 4) continue
      const nx = (b[1] - a[1]) / len, ny = -(b[0] - a[0]) / len
      const mx = (a[0] + b[0]) / 2
      if (nx < 0.85 || mx < 38 || mx > YONGE_BACK) continue
      // shop fronts: lit glazing 0.3–5.2 m with a dark frieze above
      P.add('storefront', panel(a, b, 0.02, 0.98, z + 0.3, z + 5.2, 0.12, [0, 1], true))
      P.add('metalDark', edgeBox(a, b, 0.01, 0.99, z + 5.2, z + 6.0, 0.25, 0.05))
      // entrance canopies every ~30 m
      const n = Math.max(1, Math.round(len / 30))
      for (let j = 0; j < n; j++) {
        const t = (j + 0.5) / n
        const w = Math.min(0.4, 7 / len)
        P.add('steelWhite', edgeBox(a, b, t - w / 2, t + w / 2, z + 4.3, z + 4.6, 2.4, 0.1))
        if (hi) P.add('signWarm', edgeBox(a, b, t - w / 3, t + w / 3, z + 4.6, z + 5.1, 0.12, 2.3))
        k++
      }
      // forecourt paving out to the sidewalk (sits just under the sidewalk top where they meet)
      const d = Math.min(9, (YONGE_BACK + 1 - mx) / nx)
      if (d > 0.4) {
        const f: V2[] = ccw([a, b, [b[0] + nx * d, b[1] + ny * d], [a[0] + nx * d, a[1] + ny * d]])
        P.add('forecourt', prism(f, z - 0.3, z + 0.12))
      }
    }
  }
  return k
}

/** Two crossed vertical quads for one fountain jet; u = id + [0, 1], v = 0..1 up the jet. */
function jetQuads(x: number, y: number, z: number, h: number, w: number, id: number): THREE.BufferGeometry {
  const pos: number[] = [], uvs: number[] = []
  for (const [dx, dy] of [[w / 2, 0], [0, w / 2]]) {
    const a = [x - dx, -(y - dy)], b = [x + dx, -(y + dy)]
    pos.push(a[0], z, a[1], b[0], z, b[1], b[0], z + h, b[1], a[0], z, a[1], b[0], z + h, b[1], a[0], z + h, a[1])
    uvs.push(id, 0, id + 1, 0, id + 1, 1, id, 0, id + 1, 1, id, 1)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  g.computeVertexNormals()
  return g
}

// ---------------------------------------------------------------------------
// Massey Hall (Sidney Badgley, 1894): Palladian brick front on Shuter Street,
// big gabled hall, and the glass Allied Music Centre addition to the south.

export function buildMasseyHall(ctx: BuildCtx) {
  const hi = ctx.detail === 'high'
  const P = new Parts()
  const hall = partOf(ctx, 'hall', rect(36, 48))
  const b = bbox(hall)
  P.add('victorianBrick', prism(hall, 0, 17, { top: false }))
  gableWing(P, [b.cx, b.cy], [0, 1], b.d - 0.4, b.w - 0.4, 16.9, 17, 25, 'victorianBrick', 'slate')
  // Shuter Street (north) front: limestone base, three tall arched windows, sign
  const [a, c] = faceEdge(hall, [b.cx, b.y1 + 40])
  P.add('limestone', edgeBox(a, c, 0, 1, 0, 4.2, 0.35))
  P.add('limestone', edgeBox(a, c, 0, 1, 16.4, 17.4, 0.6))
  for (const t of [0.3, 0.5, 0.7]) {
    P.add('glassPod', panel(a, c, t - 0.07, t + 0.07, 7.5, 14.5, 0.08))
    if (hi) P.add('limestone', edgeBox(a, c, t - 0.085, t + 0.085, 14.5, 15.3, 0.2))
  }
  // vertical red "MASSEY HALL" blade sign by the entrance
  {
    const s0 = along(a, c, 0.24, 0.3), s1 = along(a, c, 0.24, 2.6)
    P.add('signRed', prism(ccw([[s0[0] - 0.25, s0[1]], [s0[0] + 0.25, s0[1]], [s1[0] + 0.25, s1[1]], [s1[0] - 0.25, s1[1]]] as V2[]), 3.5, 10, { bottom: true }))
  }
  for (const t of [0.35, 0.5, 0.65]) P.add('red', panel(a, c, t - 0.035, t + 0.035, 0, 3.4, 0.4))
  // the iconic black fire escapes zig-zagging across the front
  if (hi) {
    for (const [t0, t1] of [[0.04, 0.22], [0.78, 0.96]]) {
      let up = true
      for (let lv = 0; lv < 3; lv++) {
        const h0 = 4 + lv * 4.4, h1 = h0 + 4.4
        const [ta, tb] = up ? [t0, t1] : [t1, t0]
        const pa = along(a, c, ta, 1.1), pb = along(a, c, tb, 1.1)
        P.add('metalDark', beam(P3(pa[0], h0, pa[1]), P3(pb[0], h1, pb[1]), 1.1, 0.25))
        P.add('metalDark', edgeBox(a, c, Math.min(t0, t1) - 0.02, Math.max(t0, t1) + 0.02, h1 - 0.15, h1, 1.6, 0.3))
        up = !up
      }
    }
  }
  // Allied Music Centre (2021): 7-storey glass addition on the south side
  const amc = rect(b.w - 12, 9, b.cx + 2, b.y0 - 4.5)
  P.add('glassGrey', prism(amc, 0, 29, { top: false }))
  P.add('roofDark', slab(amc, 29))
  return P.build('massey_hall')
}

// ---------------------------------------------------------------------------
// Elgin & Winter Garden (Thomas Lamb, 1913): stacked theatres. Narrow white
// terracotta Yonge St front with the vertical blade sign; brick auditorium
// block stretching back to Victoria St.

export function buildElginWinterGarden(ctx: BuildCtx) {
  const hi = ctx.detail === 'high'
  const P = new Parts()
  const body = osmPart(ctx, 965009581)
  const bpoly = body ? ccw(cleanPoly(body.poly)) : rect(61, 62, -5.5, 7)
  P.add('victorianBrick', prism(bpoly, 0, 30, { top: false }))
  P.add('roofDark', slab(bpoly, 30))
  if (hi) P.add('victorianBrick', prism(offsetPoly(bpoly, -0.3), 28.8, 30.8, { top: false, bottom: true }))
  addParts(P, ctx, (p: OsmPart) => (p.id === 965009581 || p.id === 104934674) ? null : { wall: 'brick', roof: 'roofDark' })
  const front = partOf(ctx, 'front', rect(37, 20, -39.5, -2))
  const fh = 23
  P.add('limestone', prism(front, 0, fh, { top: false }))
  P.add('roofDark', slab(front, fh))
  P.add('storefront', prism(offsetPoly(front, -0.1), 0, 4.5, { top: false }))
  // Yonge (west) face: blade sign + marquee
  const [a, c] = faceEdge(front, [-100, -2])
  const m = along(a, c, 0.5, 0)
  const len = Math.hypot(c[0] - a[0], c[1] - a[1])
  const dir: V2 = [(c[0] - a[0]) / len, (c[1] - a[1]) / len]
  const nrm: V2 = [dir[1], -dir[0]]
  P.add('signRed', prism(ccw([
    [m[0] + nrm[0] * 0.3 - dir[0] * 0.4, m[1] + nrm[1] * 0.3 - dir[1] * 0.4],
    [m[0] + nrm[0] * 0.3 + dir[0] * 0.4, m[1] + nrm[1] * 0.3 + dir[1] * 0.4],
    [m[0] + nrm[0] * 4.3 + dir[0] * 0.4, m[1] + nrm[1] * 4.3 + dir[1] * 0.4],
    [m[0] + nrm[0] * 4.3 - dir[0] * 0.4, m[1] + nrm[1] * 4.3 - dir[1] * 0.4],
  ]), 6, 21, { bottom: true }))
  P.add('signWarm', edgeBox(a, c, 0.15, 0.85, 4.6, 6, 3.2, 0))
  // Victoria St (east) marquee on the auditorium block
  const [e, f] = faceEdge(bpoly, [200, 7])
  P.add('signWarm', edgeBox(e, f, 0.35, 0.65, 4.2, 5.4, 2.6, 0))
  return P.build('elgin_winter_garden')
}
