// Extra geometry helpers for the pass-2 landmarks (heritage roofs, courtyard
// blocks, wall panels, towers). Same conventions as kit.ts: plan [x, y] with
// y = local north, three.js Z = -y, non-indexed geometry with metre UVs.
import * as THREE from 'three/webgpu'
import {
  Parts, prism, box, tube, P as P3, loft, slab, offsetPoly, area, centroid, ccw, cleanPoly, cyl, lathe, pyramid, rect, type V2,
} from './kit'
import type { MatKey } from './materials'
import { addOsmParts, type PartStyle } from './osmparts'
import type { BuildCtx, OsmPart } from './types'

export const partOf = (ctx: BuildCtx, name: string, fb: V2[]) => ccw(cleanPoly(ctx.part(name, fb)))

/** Terrain lift (m) of a named anchor footprint relative to the landmark base. */
export function zOf(ctx: BuildCtx, name: string): number {
  const z = (ctx.entry as unknown as { partZ?: Record<string, number> } | null)?.partZ?.[name]
  return z ?? 0
}

/** Courtyard rings of a named anchor (as CW rings, i.e. walls face the court). */
export function holesOf(ctx: BuildCtx, name: string): V2[][] {
  const hs = (ctx.entry as unknown as { holes?: Record<string, V2[][]> } | null)?.holes?.[name] ?? []
  return hs.map((h) => [...ccw(cleanPoly(h))].reverse())
}

/** OSM part lookup by id. */
export function osmPart(ctx: BuildCtx, id: number): OsmPart | undefined {
  return ctx.entry?.osmParts?.find((p) => p.id === id)
}

export const lift = (p: OsmPart) => (p as unknown as { z?: number }).z ?? 0

/** addOsmParts with per-part terrain lift and skipping of "outline" buildings. */
export function addParts(P: Parts, ctx: BuildCtx, style: (p: OsmPart) => PartStyle | null, filter?: (p: OsmPart) => boolean) {
  const e = ctx.entry
  if (!e?.osmParts) return
  // group by lift so each group can be translated as one Parts
  const groups = new Map<number, OsmPart[]>()
  for (const p of e.osmParts) {
    if ((p as unknown as { outline?: boolean }).outline) continue
    if (filter && !filter(p)) continue
    const z = Math.round(lift(p) * 10) / 10
    let g = groups.get(z)
    if (!g) groups.set(z, (g = []))
    g.push(p)
  }
  for (const [z, list] of groups) {
    const sub = new Parts()
    const sctx: BuildCtx = { ...ctx, entry: { ...e, osmParts: list } }
    addOsmParts(sub, sctx, style)
    P.addParts(sub, z ? new THREE.Matrix4().makeTranslation(0, z, 0) : undefined)
  }
}

/** Height (m) of an OSM part (explicit or from levels × storey height). */
export function hOf(p: OsmPart, storey = 3.4): number {
  return p.h ?? (p.levels != null ? p.levels * storey : 10)
}

// ---------------------------------------------------------------------------
// Polygons

function edgeDirs(poly: V2[]): V2[] {
  return poly.map((p, i) => {
    const q = poly[(i + 1) % poly.length]
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1
    return [(q[0] - p[0]) / l, (q[1] - p[1]) / l] as V2
  })
}

/** Largest inset ≤ d (CCW poly) whose offset polygon keeps every edge's direction. */
export function safeInset(poly: V2[], d: number): number {
  const d0 = edgeDirs(poly)
  let k = d
  for (let it = 0; it < 12; it++) {
    const o = offsetPoly(poly, k)
    const d1 = edgeDirs(o)
    let ok = area(o) * area(poly) > 0
    for (let i = 0; ok && i < d0.length; i++) {
      const lenO = Math.hypot(o[(i + 1) % o.length][0] - o[i][0], o[(i + 1) % o.length][1] - o[i][1])
      if (lenO > 1e-3 && d0[i][0] * d1[i][0] + d0[i][1] * d1[i][1] < 0.5) ok = false
    }
    if (ok) return k
    k *= 0.75
  }
  return 0
}

/** Triangulated flat polygon with holes, facing up. */
export function slabHoles(outer: V2[], holes: V2[][], y: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(ccw(outer).map(([x, z]) => new THREE.Vector2(x, z)))
  for (const h of holes) shape.holes.push(new THREE.Path([...ccw(h)].reverse().map(([x, z]) => new THREE.Vector2(x, z))))
  const g = new THREE.ShapeGeometry(shape)
  // ShapeGeometry lies in XY; rotate so plan y -> -Z, facing +Y
  g.rotateX(-Math.PI / 2)
  g.translate(0, y, 0)
  const ng = g.toNonIndexed()
  const pos = ng.getAttribute('position')
  const uv = ng.getAttribute('uv')
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i), -pos.getZ(i))
  return ng
}

/**
 * Hipped/mansard roof over an arbitrary footprint: slopes from the eaves up
 * to an inset flat top. `rise` over `run` metres; courtyard `holes` (CW) get
 * slopes rising away from the court.
 */
export function hipRoof(P: Parts, poly: V2[], holes: V2[][], y0: number, run: number, rise: number, mat: MatKey, top?: MatKey) {
  let k = safeInset(poly, run)
  for (const h of holes) k = Math.min(k, safeInset(h, run))
  const r = run > 0 ? (rise * k) / run : 0
  const inner = offsetPoly(poly, k)
  P.add(mat, loft(poly, y0, inner, y0 + r, { top: false }))
  const ih: V2[][] = []
  for (const h of holes) {
    const o = offsetPoly(h, k)
    P.add(mat, loft(h, y0, o, y0 + r, { top: false }))
    ih.push(o)
  }
  P.add(top ?? mat, holes.length ? slabHoles(inner, ih, y0 + r) : slab(inner, y0 + r))
}

/** Walls of a footprint (with optional courtyard holes, CW) from y0 to y1. */
export function walls(P: Parts, poly: V2[], holes: V2[][], y0: number, y1: number, mat: MatKey) {
  P.add(mat, prism(poly, y0, y1, { top: false }))
  for (const h of holes) P.add(mat, prism(h, y0, y1, { top: false }))
}

/** Heritage block: walls + hipped roof (+ flat top). */
export function block(P: Parts, poly: V2[], holes: V2[][], y0: number, eave: number, roofRun: number, roofRise: number, wall: MatKey, roof: MatKey, top?: MatKey) {
  walls(P, poly, holes, y0, eave, wall)
  if (roofRise > 0.05) hipRoof(P, poly, holes, eave, roofRun, roofRise, roof, top)
  else P.add(top ?? roof, holes.length ? slabHoles(poly, holes, eave) : slab(poly, eave))
}

// ---------------------------------------------------------------------------
// Oriented pieces (a local frame along a direction)

/** Matrix placing local (x along dir, y = up, z = -perp) at plan point p. */
export function frameAt(p: V2, dir: V2, y = 0): THREE.Matrix4 {
  const a = Math.atan2(dir[1], dir[0])
  return new THREE.Matrix4().makeRotationY(a).setPosition(p[0], y, -p[1])
}

/** Gabled wing: rectangle centred at c, length along dir, width w. */
export function gableWing(P: Parts, c: V2, dir: V2, len: number, w: number, y0: number, eave: number, ridge: number, wall: MatKey, roof: MatKey) {
  const g = new Parts()
  const r = rect(len, w)
  g.add(wall, prism(r, y0, eave, { top: false }))
  const hw = w / 2, hl = len / 2
  // roof: two slopes + gable triangles, with a small overhang
  const o = 0.4
  const pos = [
    // south slope
    -hl - o, eave, hw + o, hl + o, eave, hw + o, hl + o, ridge, 0,
    -hl - o, eave, hw + o, hl + o, ridge, 0, -hl - o, ridge, 0,
    // north slope
    hl + o, eave, -hw - o, -hl - o, eave, -hw - o, -hl - o, ridge, 0,
    hl + o, eave, -hw - o, -hl - o, ridge, 0, hl + o, ridge, 0,
  ]
  const rg = new THREE.BufferGeometry()
  rg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  rg.computeVertexNormals()
  const uvs: number[] = []
  for (let i = 0; i < pos.length; i += 3) uvs.push(pos[i], pos[i + 1] + Math.abs(pos[i + 2]))
  rg.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  g.add(roof, rg)
  const gp = [
    hl, eave, hw, hl, eave, -hw, hl, ridge, 0,
    -hl, eave, -hw, -hl, eave, hw, -hl, ridge, 0,
  ]
  const gg = new THREE.BufferGeometry()
  gg.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3))
  gg.computeVertexNormals()
  gg.setAttribute('uv', new THREE.Float32BufferAttribute([0, eave, w, eave, w / 2, ridge, 0, eave, w, eave, w / 2, ridge], 2))
  g.add(wall, gg)
  P.addParts(g, frameAt(c, dir))
}

/** Square tower with pyramid (or spire) roof and optional corner pinnacles. */
export function squareTower(P: Parts, c: V2, s: number, y0: number, top: number, roofH: number, wall: MatKey, roof: MatKey, opts: { pinnacles?: number; parapet?: number; rot?: number } = {}) {
  const sq = rotRect(s, s, c, opts.rot ?? 0)
  P.add(wall, prism(sq, y0, top, { top: false }))
  if (opts.parapet) {
    P.add(wall, prism(offsetPoly(sq, -0.35), top - 1, top + opts.parapet, { top: false, bottom: true }))
    P.add(roof, slab(sq, top + opts.parapet - 0.6))
  }
  if (roofH > 0) P.add(roof, pyramid(opts.parapet ? offsetPoly(sq, 0.6) : sq, top, top + roofH))
  else if (!opts.parapet) P.add(roof, slab(sq, top))
  if (opts.pinnacles) {
    for (const p of sq) {
      P.add(wall, cyl(0.6, opts.pinnacles * 0.55, top, 6, 0.6, p[0], p[1]))
      P.add(roof, cyl(0.7, opts.pinnacles * 0.45, top + opts.pinnacles * 0.55, 6, 0.02, p[0], p[1]))
    }
  }
}

/** Round turret with a conical cap. */
export function turret(P: Parts, c: V2, r: number, y0: number, top: number, capH: number, wall: MatKey, roof: MatKey, n = 12) {
  P.add(wall, cyl(r, top - y0, y0, n, r, c[0], c[1]))
  P.add(roof, cyl(r * 1.08, capH, top, n, 0.02, c[0], c[1]))
}

/** Rectangle w × d centred at c rotated by a (radians). */
export function rotRect(w: number, d: number, c: V2, a = 0): V2[] {
  const cs = Math.cos(a), sn = Math.sin(a)
  return rect(w, d).map(([x, y]) => [c[0] + x * cs - y * sn, c[1] + x * sn + y * cs] as V2)
}

/** Dome: lathe of a (semi-)ellipse; r base radius, h height, from y0. */
export function dome(r: number, h: number, y0: number, seg = 24, rings = 6, c: V2 = [0, 0]): THREE.BufferGeometry {
  const prof: V2[] = []
  for (let i = 0; i <= rings; i++) {
    const a = (i / rings) * (Math.PI / 2)
    prof.push([r * Math.cos(a), y0 + h * Math.sin(a)])
  }
  return lathe(prof, seg, true).translate(c[0], 0, -c[1])
}

// ---------------------------------------------------------------------------
// Wall panels (signs, screens, glazing) on footprint edges

/** Edge (a, b) of a CCW polygon whose midpoint is nearest to `target` and faces it. */
export function faceEdge(poly: V2[], target: V2, minLen = 3): [V2, V2] {
  let best: [V2, V2] = [poly[0], poly[1]], bd = Infinity
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (len < minLen) continue
    const m: V2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    const nx = (b[1] - a[1]) / len, ny = -(b[0] - a[0]) / len
    const tx = target[0] - m[0], ty = target[1] - m[1]
    const tl = Math.hypot(tx, ty) || 1
    const facing = (nx * tx + ny * ty) / tl
    if (facing < 0.2) continue
    const d = tl * (1.6 - facing)
    if (d < bd) { bd = d; best = [a, b] }
  }
  return best
}

/**
 * Vertical quad on the outside of edge a→b (CCW poly), from fraction t0..t1
 * along it, heights y0..y1, standing `off` metres proud. UVs 0..1 unless given.
 */
export function panel(a: V2, b: V2, t0: number, t1: number, y0: number, y1: number, off = 0.15, u: [number, number] = [0, 1], metreUV = false): THREE.BufferGeometry {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
  const nx = (b[1] - a[1]) / len, ny = -(b[0] - a[0]) / len
  const p = (t: number): V2 => [a[0] + (b[0] - a[0]) * t + nx * off, a[1] + (b[1] - a[1]) * t + ny * off]
  const A = p(t0), B = p(t1)
  const pos = [A[0], y0, -A[1], B[0], y0, -B[1], B[0], y1, -B[1], A[0], y0, -A[1], B[0], y1, -B[1], A[0], y1, -A[1]]
  const w = len * (t1 - t0)
  const [u0, u1] = metreUV ? [0, w] : u
  const [v0, v1] = metreUV ? [y0, y1] : [0, 1]
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute([u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1], 2))
  g.computeVertexNormals()
  return g
}

/** Thin box slab standing proud of edge a→b (e.g. a cornice, a sign, a canopy). */
export function edgeBox(a: V2, b: V2, t0: number, t1: number, y0: number, y1: number, depth: number, off = 0): THREE.BufferGeometry {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
  const dx = (b[0] - a[0]) / len, dy = (b[1] - a[1]) / len
  const nx = dy, ny = -dx
  const p = (t: number, o: number): V2 => [a[0] + (b[0] - a[0]) * t + nx * o, a[1] + (b[1] - a[1]) * t + ny * o]
  const poly: V2[] = [p(t0, off), p(t1, off), p(t1, off + depth), p(t0, off + depth)]
  return prism(ccw(poly), y0, y1, { bottom: true })
}

/** Point at fraction t along a→b pushed `off` metres outward (CCW poly). */
export function along(a: V2, b: V2, t: number, off = 0): V2 {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
  const nx = (b[1] - a[1]) / len, ny = -(b[0] - a[0]) / len
  return [a[0] + (b[0] - a[0]) * t + nx * off, a[1] + (b[1] - a[1]) * t + ny * off]
}

export { centroid }

// ---------------------------------------------------------------------------
// Heritage part renderer: like addOsmParts but roofs (skillion, gabled,
// hipped, pyramidal, mansard, dome) get the roof material and gables the
// wall material. Heights: explicit, else levels × `storey`.

export interface HeritageStyle {
  wall: MatKey
  roof: MatKey
  /** flat-roof material (default roofDark) */
  flat?: MatKey
  storey?: number
  /** extra height scale (e.g. to fix under-tagged heights) */
  hScale?: number
}

function rectAxes(poly: V2[]) {
  // oriented bbox from the longest edge
  let best = 0, bl = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const l = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (l > bl) { bl = l; best = i }
  }
  const a = poly[best], b = poly[(best + 1) % poly.length]
  const ux: V2 = [(b[0] - a[0]) / bl, (b[1] - a[1]) / bl]
  const uy: V2 = [-ux[1], ux[0]]
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const p of poly) {
    const x = p[0] * ux[0] + p[1] * ux[1], y = p[0] * uy[0] + p[1] * uy[1]
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
  const c: V2 = [ux[0] * cx + uy[0] * cy, ux[1] * cx + uy[1] * cy]
  let L = x1 - x0, W = y1 - y0, dir = ux
  if (W > L) { [L, W] = [W, L]; dir = uy }
  return { c, L, W, dir, fill: Math.abs(area(poly)) / ((x1 - x0) * (y1 - y0)) }
}

/** Walls + sloped top from f(x,y), roof surface in a separate material. */
function skillionSplit(P: Parts, poly: V2[], y0: number, f: (x: number, y: number) => number, wall: MatKey, roof: MatKey) {
  const g = prismTopFnWalls(poly, y0, f)
  P.add(wall, g)
  const hs = poly.map(([x, y]) => f(x, y))
  const contour = poly.map(([x, z]) => new THREE.Vector2(x, z))
  const tris = THREE.ShapeUtils.triangulateShape(contour, [])
  const pos: number[] = [], uv: number[] = []
  for (const t of tris) {
    // ensure upward normal: CCW poly in plan -> (x, h, -y) order a, b, c is CCW seen from above
    for (const k of t) { pos.push(poly[k][0], hs[k], -poly[k][1]); uv.push(poly[k][0], poly[k][1]) }
  }
  const rg = new THREE.BufferGeometry()
  rg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  rg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  rg.computeVertexNormals()
  const n = rg.getAttribute('normal')
  if (n.count && n.getY(0) < 0) {
    // flip winding
    const p = rg.getAttribute('position').array as Float32Array
    for (let i = 0; i < p.length; i += 9) for (let k = 0; k < 3; k++) { const t = p[i + 3 + k]; p[i + 3 + k] = p[i + 6 + k]; p[i + 6 + k] = t }
    rg.computeVertexNormals()
  }
  P.add(roof, rg)
}

function prismTopFnWalls(poly: V2[], y0: number, f: (x: number, y: number) => number): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = []
  let u = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const ha = f(a[0], a[1]), hb = f(b[0], b[1])
    pos.push(a[0], y0, -a[1], b[0], y0, -b[1], b[0], hb, -b[1], a[0], y0, -a[1], b[0], hb, -b[1], a[0], ha, -a[1])
    uv.push(u, y0, u + len, y0, u + len, hb, u, y0, u + len, hb, u, ha)
    u += len
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.computeVertexNormals()
  return g
}

/** Render one heritage part (local coords). */
export function heritagePart(P: Parts, p: OsmPart, st: HeritageStyle, rot: number, rotAll = 0) {
  const poly = ccw(cleanPoly(p.poly))
  if (poly.length < 3) return
  const storey = st.storey ?? 4
  const k = st.hScale ?? 1
  const y1 = (p.h ?? (p.levels != null ? p.levels * storey : 10)) * k
  const y0 = (p.minH || (p.minLevel != null ? p.minLevel * storey : 0)) * k
  if (y1 - y0 < 0.2) {
    P.add(st.flat ?? 'granite', prism(poly, y0, Math.max(y1, y0 + 0.2)))
    return
  }
  const rh = Math.min((p.roofH || 0) * k, y1 - y0)
  const eave = y1 - rh
  const flat = st.flat ?? 'roofDark'
  const bottom = y0 > 0.5
  const shape = rh > 0.05 ? p.roof : 'flat'
  if (p.kind === 'roof') {
    // free-standing roof (porch/canopy): just the roof shape on thin posts
    P.add(st.roof, prism(poly, eave - 0.4, eave, { bottom: true, top: false }))
    P.add(st.roof, pyramid(poly, eave, y1))
    return
  }
  switch (shape) {
    case 'skillion': {
      const b = ((p.roofDir ?? 0) * Math.PI) / 180
      const wx = Math.sin(b), wy = Math.cos(b)
      const c = Math.cos(-(rot + rotAll)), s = Math.sin(-(rot + rotAll))
      const dx = wx * c - wy * s, dy = wx * s + wy * c
      const proj = poly.map(([x, y]) => x * dx + y * dy)
      const lo = Math.min(...proj), hi = Math.max(...proj)
      const span = Math.max(hi - lo, 0.01)
      skillionSplit(P, poly, y0, (x, y) => y1 - (rh * ((x * dx + y * dy) - lo)) / span, st.wall, st.roof)
      if (bottom) P.add(st.wall, slab([...poly].reverse(), y0))
      return
    }
    case 'gabled':
    case 'hipped':
    case 'pyramidal':
    case 'mansard': {
      P.add(st.wall, prism(poly, y0, eave, { top: false, bottom }))
      const ax = rectAxes(poly)
      if (shape === 'pyramidal') { P.add(st.roof, pyramid(poly, eave, y1)); return }
      if (shape === 'gabled' && poly.length <= 6 && ax.fill > 0.85) {
        gableWing(P, ax.c, ax.dir, ax.L, ax.W, eave - 0.01, eave, y1, st.wall, st.roof)
        return
      }
      if (shape === 'mansard') { hipRoof(P, poly, [], eave, Math.min(2.5, ax.W * 0.3), rh * 0.8, st.roof, flat); return }
      hipRoof(P, poly, [], eave, ax.W / 2, rh, st.roof, st.roof)
      return
    }
    case 'dome':
    case 'round':
    case 'onion': {
      P.add(st.wall, prism(poly, y0, eave, { top: false, bottom }))
      const n = 6
      let prev = poly, prevY = eave
      for (let i = 1; i <= n; i++) {
        const a = (i / n) * (Math.PI / 2)
        const kk = Math.cos(a), yy = eave + rh * Math.sin(a)
        const cen = centroid(poly)
        const next = poly.map(([x, y]) => [cen[0] + (x - cen[0]) * Math.max(kk, 0.02), cen[1] + (y - cen[1]) * Math.max(kk, 0.02)] as V2)
        P.add(st.roof, loft(prev, prevY, next, yy, { top: i === n }))
        prev = next
        prevY = yy
      }
      return
    }
  }
  P.add(st.wall, prism(poly, y0, y1, { top: false, bottom }))
  P.add(flat, slab(poly, y1))
}

/** All osmParts of the entry through heritagePart, with terrain lift. */
export function addHeritage(P: Parts, ctx: BuildCtx, style: (p: OsmPart) => HeritageStyle | null) {
  const e = ctx.entry
  if (!e?.osmParts) return
  for (const p of e.osmParts) {
    if (p.outline) continue
    const st = style(p)
    if (!st) continue
    const z = lift(p)
    if (z) {
      const sub = new Parts()
      heritagePart(sub, p, st, e.rotation)
      P.addParts(sub, new THREE.Matrix4().makeTranslation(0, z, 0))
    } else heritagePart(P, p, st, e.rotation)
  }
}

// ---------------------------------------------------------------------------
// Barrel vaults

/** Segmental glass vault between x0..x1 along y0..y1, springing at ys to crown yc. */
export function vault(P: Parts, x0: number, x1: number, y0: number, y1: number, ys: number, yc: number, hi: boolean, ribStep = 6, glass: MatKey = 'vaultGlass', rib: MatKey | null = 'steelWhite') {
  const n = hi ? 12 : 6
  const w = x1 - x0, xc = (x0 + x1) / 2
  // circular segment through (x0, ys), (x1, ys), (xc, yc)
  const s = yc - ys, R = (w * w / 4 + s * s) / (2 * s)
  const a0 = Math.asin(w / 2 / R)
  const arc: V2[] = []
  for (let i = 0; i <= n; i++) {
    const a = -a0 + (2 * a0 * i) / n
    arc.push([xc + R * Math.sin(a), ys + (R * Math.cos(a) - (R - s))])
  }
  const pos: number[] = [], uv: number[] = []
  for (let i = 0; i < n; i++) {
    const [xa, ha] = arc[i], [xb, hb] = arc[i + 1]
    // faces up/outwards: winding (a,y0) (a,y1) (b,y1)
    pos.push(xa, ha, -y0, xb, hb, -y0, xb, hb, -y1, xa, ha, -y0, xb, hb, -y1, xa, ha, -y1)
    uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1)
  }
  // end gables (fans)
  for (const [y, flip] of [[y0, false], [y1, true]] as [number, boolean][]) {
    for (let i = 0; i < n; i++) {
      const [xa, ha] = arc[i], [xb, hb] = arc[i + 1]
      if (!flip) pos.push(xc, ys, -y, xb, hb, -y, xa, ha, -y)
      else pos.push(xc, ys, -y, xa, ha, -y, xb, hb, -y)
      uv.push(0, 0, 1, 0, 0, 1)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.computeVertexNormals()
  P.add(glass, g)
  // white steel ribs + ridge / eave purlins
  if (!rib) return
  if (hi) {
    for (let y = y0; y <= y1 + 0.01; y += ribStep) {
      P.add(rib, tube(arc.map(([x, h]) => P3(x, h + 0.15, y)), 0.22, 4))
    }
    P.add(rib, box(0.5, 0.5, y1 - y0, xc, yc + 0.2, (y0 + y1) / 2))
  }
  P.add(rib, box(0.8, 0.8, y1 - y0, x0, ys, (y0 + y1) / 2))
  P.add(rib, box(0.8, 0.8, y1 - y0, x1, ys, (y0 + y1) / 2))
}

