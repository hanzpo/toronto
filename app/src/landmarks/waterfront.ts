// Waterfront & the Ex: Ontario Place (pods + Cinesphere), BMO Field, the
// Princes' Gates and the Coca-Cola Coliseum. Local frames from landmarks.json
// (grid-aligned, ~+17..21° rotation), OSM for semantics, real dimensions from
// the references below.
//
//  - Ontario Place (Eberhard Zeidler / Craig, Zeidler & Strong, 1971): five
//    27 m square pods hung from four pipe columns rising 32 m over the lake,
//    joined to each other and the shore by glazed steel bridges; the Cinesphere,
//    a triodetic dome of 19 m outer radius (the first permanent IMAX theatre).
//  - BMO Field (BBB Architects 2007, Gensler 2016): red seats in a two-tier
//    bowl around a 105 × 68 m pitch, canopy roofs over the east and west stands.
//  - Princes' Gates (Chapman & Oxley, 1927): Beaux-Arts triumphal arch with
//    curved colonnades of nine columns each side, the "Spirit of Progress"
//    winged figure on the attic.
//  - Coca-Cola Coliseum (1921): buff-brick arena with a barrel roof and domed
//    corner towers on the north front.
import * as THREE from 'three/webgpu'
import { Parts, prism, slab, lathe, cyl, box, rect, bbox, centroid, ccw, cleanPoly, offsetPoly, prismTopFn, beam, P as P3, type V2 } from './kit'
import type { BuildCtx, OsmPart } from './types'
import { addParts, addHeritage, partOf, zOf, lift, hOf } from './kit2'
import { addOsmParts } from './osmparts'

// ---------------------------------------------------------------------------
// Ontario Place

interface OpData { pods: { name: string; ring: V2[]; cols: V2[] }[]; bridges: V2[][] }

const POD_FLOOR = 15.5, POD_TOP = 26.5 // columns rise to 32 m (OSM part heights)
const BRIDGE_Y0 = 15.8, BRIDGE_Y1 = 19

export function buildOntarioPlace(ctx: BuildCtx) {
  const hi = ctx.detail === 'high'
  const P = new Parts()
  const op = (ctx.entry as unknown as { op?: OpData } | null)?.op
  // pipe columns (OSM building:part column, 32 m): white steel
  addOsmParts(P, ctx, (p) => (p.kind === 'column' ? { wall: 'steelWhite' } : null))
  for (const pod of op?.pods ?? []) {
    const r = ccw(cleanPoly(pod.ring))
    if (r.length < 3) continue
    // truss "tray" under the floor, the three glazed storeys, roof truss band
    P.add('metalDark', prism(offsetPoly(r, 3), POD_FLOOR - 2.2, POD_FLOOR - 1.9, { bottom: true, top: false }))
    P.add('steelWhite', loftTray(r, POD_FLOOR - 2.2, POD_FLOOR))
    P.add('glassPod', prism(offsetPoly(r, 0.6), POD_FLOOR, POD_TOP - 1.2, { top: false }))
    for (let y = POD_FLOOR + 3.6; y < POD_TOP - 2; y += 3.6) P.add('steelWhite', prism(offsetPoly(r, 0.4), y - 0.35, y, { bottom: true, top: false }))
    P.add('steelWhite', prism(r, POD_TOP - 1.2, POD_TOP, { bottom: true }))
    P.add('roofDark', slab(offsetPoly(r, 0.4), POD_TOP + 0.02))
    // cross bracing of the columns under the pod
    if (hi && pod.cols.length === 4) {
      const c = pod.cols
      for (let i = 0; i < 4; i++) {
        const a = c[i], b = c[(i + 1) % 4]
        P.add('steelWhite', beam(P3(a[0], 1, a[1]), P3(b[0], POD_FLOOR - 2.4, b[1]), 0.35))
      }
    }
  }
  // glazed bridges between the pods, to the shore and to the Cinesphere
  for (const b of op?.bridges ?? []) {
    const r = ccw(cleanPoly(b))
    if (r.length < 3) continue
    P.add('metalDark', prism(r, BRIDGE_Y0 - 0.9, BRIDGE_Y0, { bottom: true }))
    P.add('glassGrey', prism(offsetPoly(r, 0.15), BRIDGE_Y0, BRIDGE_Y1, { top: false }))
    P.add('steelWhite', prism(r, BRIDGE_Y1, BRIDGE_Y1 + 0.5))
    // piers under long spans
    const bb = bbox(r)
    const L = Math.max(bb.w, bb.d)
    if (L > 40) {
      const alongX = bb.w > bb.d
      for (let t = 18; t < L - 10; t += 26) {
        const x = alongX ? bb.x0 + t : bb.cx, y = alongX ? bb.cy : bb.y0 + t
        P.add('steelWhite', cyl(0.5, BRIDGE_Y0 - 0.9 + 1, -1, 10, 0.5, x, y))
      }
    }
  }
  // Cinesphere: sphere of 19 m radius, centre 6 m up, clipped at the podium
  const cs = partOf(ctx, 'cinesphere', rect(37, 37, 0, -85))
  const cb = bbox(cs)
  const zc = zOf(ctx, 'cinesphere')
  const R = 19, yc = 6
  const t0 = Math.acos(yc / R)
  const prof: V2[] = []
  const n = hi ? 12 : 7
  for (let i = 0; i <= n; i++) {
    const t = t0 + ((Math.PI - t0) * i) / n
    prof.push([R * Math.sin(t), zc + yc - R * Math.cos(t)])
  }
  P.add('white', lathe(prof, hi ? 26 : 14, false).translate(cb.cx, 0, -cb.cy))
  P.add('concreteDark', cyl(R * 0.96, 1.2, zc - 0.6, hi ? 26 : 14, R * 0.96, cb.cx, cb.cy))
  // triodetic lattice: meridian ribs
  if (hi) {
    for (let k = 0; k < 13; k++) {
      const a = (k / 13) * Math.PI * 2
      const pts: THREE.Vector3[] = []
      for (let i = 0; i <= n; i += 2) {
        const t = t0 + ((Math.PI - t0) * i) / n
        const rr = R * Math.sin(t) + 0.05
        pts.push(P3(cb.cx + rr * Math.cos(a), zc + yc - R * Math.cos(t), cb.cy + rr * Math.sin(a)))
      }
      for (let i = 0; i < pts.length - 1; i++) P.add('steelWhite', beam(pts[i], pts[i + 1], 0.18))
    }
  }
  return P.build('ontario_place')
}

/** Inverted truss tray: smaller square at y0 up to the pod outline at y1. */
function loftTray(r: V2[], y0: number, y1: number) {
  return loftGeom(offsetPoly(r, 2.5), y0, r, y1)
}
function loftGeom(a: V2[], ya: number, b: V2[], yb: number) {
  // side walls only (tray), outward faces
  const pos: number[] = []
  for (let i = 0; i < a.length; i++) {
    const j = (i + 1) % a.length
    const A = [a[i][0], ya, -a[i][1]], B = [a[j][0], ya, -a[j][1]], C = [b[j][0], yb, -b[j][1]], D = [b[i][0], yb, -b[i][1]]
    pos.push(...A, ...B, ...C, ...A, ...C, ...D)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.computeVertexNormals()
  return g
}

// ---------------------------------------------------------------------------
// BMO Field

export function buildBmoField(ctx: BuildCtx) {
  const hi = ctx.detail === 'high'
  const P = new Parts()
  const pitch = partOf(ctx, 'pitch', rect(115, 78))
  const pc = centroid(pitch)
  // The rake is shared by all sections of a tier (same top height): seat
  // height grows with the rectangular distance from the pitch edge, so the
  // sections line up.
  const ax = pitchFrame(pitch)
  const rd = (x: number, y: number) => {
    const u = (x - ax.c[0]) * ax.u[0] + (y - ax.c[1]) * ax.u[1], v = (x - ax.c[0]) * -ax.u[1] + (y - ax.c[1]) * ax.u[0]
    return Math.max(Math.abs(u) - ax.hl, Math.abs(v) - ax.hw)
  }
  const steps = (ctx.entry?.osmParts ?? []).filter((p) => p.kind === 'steps' && !p.whole)
  const tiers = new Map<number, [number, number]>()
  for (const p of steps) {
    const h = hOf(p)
    const t = tiers.get(h) ?? [Infinity, -Infinity]
    for (const [x, y] of p.poly) { const d = rd(x, y); t[0] = Math.min(t[0], d); t[1] = Math.max(t[1], d) }
    tiers.set(h, t)
  }
  for (const p of steps) {
    const poly = ccw(cleanPoly(p.poly))
    if (poly.length < 3) continue
    const z = lift(p)
    const h = hOf(p)
    const [d0, d1] = tiers.get(h)!
    const front = h >= 26 ? h - 13 : 1.0
    const f = (x: number, y: number) => front + ((h - front) * Math.min(1, Math.max(0, rd(x, y) - d0))) / Math.max(1, d1 - d0)
    // concrete riser block + red seating surface (raked towards the pitch)
    const g = new Parts()
    g.add('concrete', prismTopFn(poly, 0, f))
    g.add('seatRed', raked(poly, f, 0.05))
    P.addParts(g, z ? new THREE.Matrix4().makeTranslation(0, z, 0) : undefined)
  }
  // other structure (concourse blocks, towers): plain concrete
  addParts(P, ctx, (p) => (p.kind === 'steps' || p.kind === 'roof' || p.whole ? null : { wall: 'concrete', roof: 'roofLight' }))
  // canopy roofs (2016; OSM building:part=roof at 32 / 42 m): a thin roof with a
  // steel fascia, carried by masts on the outer (back) edge, away from the seats
  for (const p of ctx.entry?.osmParts ?? []) {
    if (p.kind !== 'roof' || !p.h) continue
    const poly = ccw(cleanPoly(p.poly))
    if (poly.length < 3) continue
    const z = lift(p), top = p.h + z
    P.add('roofLight', prism(poly, top - 0.9, top, { bottom: true }))
    P.add('steelWhite', prism(offsetPoly(poly, -0.25), top - 1.6, top - 0.9, { top: false, bottom: true }))
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length]
      const L = Math.hypot(b[0] - a[0], b[1] - a[1])
      if (L < 12) continue
      const nx = (b[1] - a[1]) / L, ny = -(b[0] - a[0]) / L
      const mx = (a[0] + b[0]) / 2 - pc[0], my = (a[1] + b[1]) / 2 - pc[1]
      if (nx * mx + ny * my < 0.8 * Math.hypot(mx, my)) continue // not a back edge
      const n = Math.max(1, Math.round(L / 18))
      for (let k = 0; k <= n; k++) {
        const t = 0.04 + (0.92 * k) / n
        const x = a[0] + (b[0] - a[0]) * t - nx * 1.2, y = a[1] + (b[1] - a[1]) * t - ny * 1.2
        P.add('steelWhite', cyl(0.45, top - 0.9, 0, hi ? 8 : 6, 0.35, x, y))
        if (hi) P.add('steelWhite', beam(P3(x, top + 3, y), P3(x - nx * 22, top, y - ny * 22), 0.25))
        if (hi) P.add('steelWhite', cyl(0.3, 4, top - 1, 6, 0.2, x, y))
      }
    }
  }
  return P.build('bmo_field')
}

/** Pitch rectangle frame: centre, long-axis unit vector, half length / width. */
function pitchFrame(poly: V2[]) {
  let u: V2 = [1, 0], bl = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const l = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (l > bl) { bl = l; u = [(b[0] - a[0]) / l, (b[1] - a[1]) / l] }
  }
  const c = centroid(poly)
  let hl = 0, hw = 0
  for (const [x, y] of poly) {
    hl = Math.max(hl, Math.abs((x - c[0]) * u[0] + (y - c[1]) * u[1]))
    hw = Math.max(hw, Math.abs((x - c[0]) * -u[1] + (y - c[1]) * u[0]))
  }
  return { c, u, hl, hw }
}

/** Top surface of a raked part (seat colour), lifted `dy` over f. */
function raked(poly: V2[], f: (x: number, y: number) => number, dy: number) {
  const contour = poly.map(([x, z]) => new THREE.Vector2(x, z))
  const tris = THREE.ShapeUtils.triangulateShape(contour, [])
  const pos: number[] = []
  for (const t of tris) for (const k of t) pos.push(poly[k][0], f(poly[k][0], poly[k][1]) + dy, -poly[k][1])
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.computeVertexNormals()
  const nrm = g.getAttribute('normal')
  if (nrm.count && nrm.getY(0) < 0) {
    const p = g.getAttribute('position').array as Float32Array
    for (let i = 0; i < p.length; i += 9) for (let k = 0; k < 3; k++) { const s = p[i + 3 + k]; p[i + 3 + k] = p[i + 6 + k]; p[i + 6 + k] = s }
    g.computeVertexNormals()
  }
  return g
}

// ---------------------------------------------------------------------------
// Princes' Gates

export function buildPrincesGates(ctx: BuildCtx) {
  const hi = ctx.detail === 'high'
  const P = new Parts()
  // OSM carries the whole massing (piers, attic, colonnade entablatures, end
  // pylons, 18 columns): cast stone
  addParts(P, ctx, (p: OsmPart) => (p.whole ? null : p.kind === 'column' ? { wall: 'limestoneSmooth' } : { wall: 'limestoneSmooth', roof: 'limestoneSmooth' }))
  if (!ctx.entry?.osmParts?.length) P.add('limestoneSmooth', prism(rect(11, 18), 0, 16))
  // "Spirit of Progress": winged Victory on the attic (top of the pedestal at 20 m)
  const ped = ctx.entry?.osmParts?.find((p) => p.id === 957388508)
  const c = ped ? centroid(ped.poly) : ([0, 0] as V2)
  const zt = (ped?.h ?? 20) + (ped ? lift(ped) : 0)
  P.add('copper', cyl(0.7, 3.2, zt, hi ? 10 : 6, 0.45, c[0], c[1])) // robed figure
  P.add('copper', cyl(0.28, 0.5, zt + 3.2, 8, 0.28, c[0], c[1])) // head
  for (const s of [-1, 1]) {
    // raised wings
    P.add('copper', beam(P3(c[0], zt + 2.6, c[1]), P3(c[0] + s * 0.4, zt + 5.2, c[1] + s * 1.6), 0.25, 0.9))
  }
  P.add('copper', beam(P3(c[0], zt + 3.0, c[1]), P3(c[0] + 1.3, zt + 4.6, c[1]), 0.18))
  return P.build('princes_gates')
}

// ---------------------------------------------------------------------------
// Coca-Cola Coliseum

export function buildColiseum(ctx: BuildCtx) {
  const P = new Parts()
  addHeritage(P, ctx, (p) => {
    if (p.whole) return null
    if (p.roof === 'dome') return { wall: 'buffBrick', roof: 'copper' }
    if (p.kind === 'roof') return { wall: 'metalDark', roof: 'metalDark' }
    if (p.roof === 'round') return { wall: 'buffBrick', roof: 'zinc' }
    return { wall: 'buffBrick', roof: 'roofDark', flat: 'roofDark' }
  })
  if (!ctx.entry?.osmParts?.length) {
    const fp = ctx.footprint(rect(150, 120))
    P.add('buffBrick', prism(fp, 0, 20, { top: false }))
    P.add('roofDark', slab(fp, 20))
  }
  void box
  return P.build('coliseum')
}
