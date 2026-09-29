// Geometry kit for procedural landmark models.
//
// Plan coordinates are `[x, y]` metres in the landmark's canonical local frame
// (x = local east, y = local north). 3D is three.js: X = x, Y = up, Z = -y.
// Every geometry produced here is non-indexed with position/normal/uv so it
// can be merged per material. UVs are in *metres* (u along the wall perimeter
// or plan x, v = height or plan y); Parts.build() rescales them per material
// to the facade texture module.
import * as THREE from 'three/webgpu'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { MATS, type MatKey } from './materials'

export type V2 = [number, number]

// ---------------------------------------------------------------------------
// Low-level triangle soup writer

class Soup {
  p: number[] = []
  n: number[] = []
  uv: number[] = []

  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, ua: V2, ub: V2, uc: V2, flatN?: THREE.Vector3) {
    const nrm = flatN ?? faceNormal(a, b, c)
    this.p.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
    for (let i = 0; i < 3; i++) this.n.push(nrm.x, nrm.y, nrm.z)
    this.uv.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1])
  }

  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, ua: V2, ub: V2, uc: V2, ud: V2) {
    const nrm = faceNormal(a, b, c)
    if (nrm.lengthSq() < 0.5) nrm.copy(faceNormal(a, c, d))
    this.tri(a, b, c, ua, ub, uc, nrm)
    this.tri(a, c, d, ua, uc, ud, nrm)
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    return g
  }
}

const _e1 = new THREE.Vector3()
const _e2 = new THREE.Vector3()
function faceNormal(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) {
  _e1.subVectors(b, a)
  _e2.subVectors(c, a)
  const n = new THREE.Vector3().crossVectors(_e1, _e2)
  const l = n.length()
  return l > 1e-12 ? n.multiplyScalar(1 / l) : n.set(0, 0, 0)
}

const v3 = (p: V2, y: number) => new THREE.Vector3(p[0], y, -p[1])

// ---------------------------------------------------------------------------
// Polygon helpers

export function area(poly: V2[]): number {
  let a = 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return a / 2
}

export function ccw(poly: V2[]): V2[] {
  return area(poly) < 0 ? [...poly].reverse() : poly
}

export function centroid(poly: V2[]): V2 {
  let a = 0, cx = 0, cy = 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length]
    const f = p[0] * q[1] - q[0] * p[1]
    a += f
    cx += (p[0] + q[0]) * f
    cy += (p[1] + q[1]) * f
  }
  if (Math.abs(a) < 1e-9) return poly[0]
  return [cx / (3 * a), cy / (3 * a)]
}

export function bbox(poly: V2[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of poly) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
  }
  return { x0, y0, x1, y1, w: x1 - x0, d: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 }
}

export function rect(w: number, d: number, cx = 0, cy = 0): V2[] {
  return [[cx - w / 2, cy - d / 2], [cx + w / 2, cy - d / 2], [cx + w / 2, cy + d / 2], [cx - w / 2, cy + d / 2]]
}

/** Rectangle with chamfered corners (c = chamfer leg length). */
export function chamferRect(w: number, d: number, c: number, cx = 0, cy = 0): V2[] {
  const x = w / 2, y = d / 2
  return [
    [-x + c, -y], [x - c, -y], [x, -y + c], [x, y - c], [x - c, y], [-x + c, y], [-x, y - c], [-x, -y + c],
  ].map(([a, b]) => [a + cx, b + cy] as V2)
}

export function circle(r: number, n: number, cx = 0, cy = 0, a0 = 0): V2[] {
  const out: V2[] = []
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * Math.PI * 2
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
  }
  return out
}

export function ellipse(rx: number, ry: number, n: number, cx = 0, cy = 0): V2[] {
  const out: V2[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)])
  }
  return out
}

/** Scale polygon about a point (default: its centroid). */
export function scalePoly(poly: V2[], sx: number, sy = sx, about?: V2): V2[] {
  const c = about ?? centroid(poly)
  return poly.map(([x, y]) => [c[0] + (x - c[0]) * sx, c[1] + (y - c[1]) * sy] as V2)
}

export function movePoly(poly: V2[], dx: number, dy: number): V2[] {
  return poly.map(([x, y]) => [x + dx, y + dy] as V2)
}

export function rotatePoly(poly: V2[], a: number, about: V2 = [0, 0]): V2[] {
  const c = Math.cos(a), s = Math.sin(a)
  return poly.map(([x, y]) => {
    const dx = x - about[0], dy = y - about[1]
    return [about[0] + dx * c - dy * s, about[1] + dx * s + dy * c] as V2
  })
}

/**
 * Inset (negative = outset) a simple CCW polygon by `d` metres using mitred
 * offsets. Good enough for convex-ish towers and notched corners.
 */
export function offsetPoly(poly: V2[], d: number): V2[] {
  const n = poly.length
  const out: V2[] = []
  for (let i = 0; i < n; i++) {
    const p0 = poly[(i - 1 + n) % n], p1 = poly[i], p2 = poly[(i + 1) % n]
    const e0 = norm2([p1[0] - p0[0], p1[1] - p0[1]])
    const e1 = norm2([p2[0] - p1[0], p2[1] - p1[1]])
    // inward normals for CCW polygon: left of edge = (-ey, ex)
    const n0: V2 = [-e0[1], e0[0]]
    const n1: V2 = [-e1[1], e1[0]]
    const bis = norm2([n0[0] + n1[0], n0[1] + n1[1]])
    const cosH = bis[0] * n1[0] + bis[1] * n1[1]
    const k = d / Math.max(cosH, 0.25)
    out.push([p1[0] + bis[0] * k, p1[1] + bis[1] * k])
  }
  return out
}

function norm2(v: V2): V2 {
  const l = Math.hypot(v[0], v[1]) || 1
  return [v[0] / l, v[1] / l]
}

/** Remove near-duplicate/collinear vertices. */
export function cleanPoly(poly: V2[], eps = 0.05): V2[] {
  const out: V2[] = []
  for (const p of poly) {
    const q = out[out.length - 1]
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > eps) out.push(p)
  }
  if (out.length > 1) {
    const a = out[0], b = out[out.length - 1]
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= eps) out.pop()
  }
  return out
}

// ---------------------------------------------------------------------------
// Solids

export interface LoftOpts {
  top?: boolean
  bottom?: boolean
  /** u offset for facade texture continuity */
  u0?: number
}

/**
 * Loft between two plan polygons with identical vertex counts at heights
 * ya < yb. Walls are flat-shaded; optional flat caps. Handles tapering.
 */
export function loft(a: V2[], ya: number, b: V2[], yb: number, opts: LoftOpts = {}): THREE.BufferGeometry {
  const s = new Soup()
  const n = a.length
  let u = opts.u0 ?? 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const A = v3(a[i], ya), B = v3(a[j], ya), C = v3(b[j], yb), D = v3(b[i], yb)
    const len = Math.hypot(a[j][0] - a[i][0], a[j][1] - a[i][1])
    const lenT = Math.hypot(b[j][0] - b[i][0], b[j][1] - b[i][1])
    const slant = Math.hypot(yb - ya, Math.hypot(b[i][0] - a[i][0], b[i][1] - a[i][1]))
    const mid = (len - lenT) / 2
    s.quad(A, B, C, D, [u, ya], [u + len, ya], [u + len - mid, ya + slant], [u + mid, ya + slant])
    u += len
  }
  if (opts.top !== false) cap(s, b, yb, true)
  if (opts.bottom) cap(s, a, ya, false)
  return s.geometry()
}

export function prism(poly: V2[], y0: number, y1: number, opts: LoftOpts = {}) {
  return loft(poly, y0, poly, y1, opts)
}

function cap(s: Soup, poly: V2[], y: number, up: boolean, heights?: number[]) {
  const contour = poly.map(([x, z]) => new THREE.Vector2(x, z))
  const tris = THREE.ShapeUtils.triangulateShape(contour, [])
  for (const [i, j, k] of tris) {
    const A = v3(poly[i], heights ? heights[i] : y)
    const B = v3(poly[j], heights ? heights[j] : y)
    const C = v3(poly[k], heights ? heights[k] : y)
    const nrm = faceNormal(A, B, C)
    if (up === nrm.y < 0) s.tri(A, C, B, poly[i], poly[k], poly[j])
    else s.tri(A, B, C, poly[i], poly[j], poly[k])
  }
}

/**
 * Vertical walls of a polygon with a per-edge material choice.
 * pick(i, nx, ny) gets the edge index and its outward plan normal.
 */
export function edgeWalls<K extends string>(poly: V2[], y0: number, y1: number, pick: (i: number, nx: number, ny: number) => K): Map<K, THREE.BufferGeometry> {
  const soups = new Map<K, Soup>()
  let u = 0
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length
    const dx = poly[j][0] - poly[i][0], dy = poly[j][1] - poly[i][1]
    const len = Math.hypot(dx, dy)
    if (len < 1e-6) continue
    const k = pick(i, dy / len, -dx / len)
    let s = soups.get(k)
    if (!s) soups.set(k, (s = new Soup()))
    s.quad(v3(poly[i], y0), v3(poly[j], y0), v3(poly[j], y1), v3(poly[i], y1), [u, y0], [u + len, y0], [u + len, y1], [u, y1])
    u += len
  }
  const out = new Map<K, THREE.BufferGeometry>()
  for (const [k, s] of soups) out.set(k, s.geometry())
  return out
}

/** Flat polygon (e.g. a plaza or roof slab) facing up. */
export function slab(poly: V2[], y: number, thickness = 0): THREE.BufferGeometry {
  if (thickness > 0) return prism(poly, y - thickness, y, { bottom: true })
  const s = new Soup()
  cap(s, poly, y, true)
  return s.geometry()
}

/** Prism whose top vertex heights are given by f(x, y) (sloped roofs). */
export function prismTopFn(poly: V2[], y0: number, f: (x: number, y: number) => number): THREE.BufferGeometry {
  const s = new Soup()
  const n = poly.length
  const hs = poly.map(([x, y]) => f(x, y))
  let u = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const len = Math.hypot(poly[j][0] - poly[i][0], poly[j][1] - poly[i][1])
    s.quad(v3(poly[i], y0), v3(poly[j], y0), v3(poly[j], hs[j]), v3(poly[i], hs[i]),
      [u, y0], [u + len, y0], [u + len, hs[j]], [u, hs[i]])
    u += len
  }
  cap(s, poly, 0, true, hs)
  return s.geometry()
}

/** Pyramid over a polygon from height y0 to apex at y1 (apex over centroid unless given). */
export function pyramid(poly: V2[], y0: number, y1: number, apex?: V2): THREE.BufferGeometry {
  const s = new Soup()
  const c = apex ?? centroid(poly)
  const top = v3(c, y1)
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length
    const len = Math.hypot(poly[j][0] - poly[i][0], poly[j][1] - poly[i][1])
    s.tri(v3(poly[i], y0), v3(poly[j], y0), top, [0, y0], [len, y0], [len / 2, y1])
  }
  return s.geometry()
}

/** Lathe around +Y from a [radius, y] profile (bottom to top). Smooth or flat. */
export function lathe(profile: V2[], segments: number, smooth = true, phase = 0): THREE.BufferGeometry {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 1e-4), y))
  let g: THREE.BufferGeometry = new THREE.LatheGeometry(pts, segments, phase, Math.PI * 2)
  // metre UVs: u = arc length at radius, v = height
  const pos = g.getAttribute('position')
  const uv = g.getAttribute('uv')
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
    const r = Math.hypot(x, z)
    uv.setXY(i, uv.getX(i) * 2 * Math.PI * r, y)
  }
  g = g.toNonIndexed()
  if (!smooth) g.computeVertexNormals()
  return g
}

/** Box centred at (x, y, z) in plan terms: x, height centre y, plan-north yN. */
export function box(w: number, h: number, d: number, x = 0, y = 0, yN = 0): THREE.BufferGeometry {
  return prism(rect(w, d, x, yN), y - h / 2, y + h / 2, { bottom: true })
}

/** Cylinder standing on y0, height h, radius r (top radius rt). */
export function cyl(r: number, h: number, y0 = 0, n = 16, rt = r, x = 0, yN = 0): THREE.BufferGeometry {
  return lathe([[0, y0], [r, y0], [rt, y0 + h], [0, y0 + h]], n, false).translate(x, 0, -yN)
}

/** Tube along a polyline of 3D points (plan x, y, north). */
export function tube(points: THREE.Vector3[], radius: number, radial = 6): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0)
  const g = new THREE.TubeGeometry(curve, Math.max(2, points.length * 2), radius, radial, false)
  return g.toNonIndexed()
}

/** Straight beam between two 3D points (square section). */
export function beam(a: THREE.Vector3, b: THREE.Vector3, w: number, h = w): THREE.BufferGeometry {
  const len = a.distanceTo(b)
  const g = new THREE.BoxGeometry(w, h, len).toNonIndexed()
  const m = new THREE.Matrix4().lookAt(a, b, new THREE.Vector3(Math.abs(b.x - a.x) + Math.abs(b.z - a.z) < 1e-6 ? 1 : 0, Math.abs(b.x - a.x) + Math.abs(b.z - a.z) < 1e-6 ? 0 : 1, 0))
  m.setPosition(a.clone().add(b).multiplyScalar(0.5))
  g.applyMatrix4(m)
  return g
}

/** 3D point helper from plan coords. */
export const P = (x: number, y: number, north: number) => new THREE.Vector3(x, y, -north)

// ---------------------------------------------------------------------------
// Parts bin: collect geometry per material, merge into one mesh per material.

export class Parts {
  private bins = new Map<MatKey, THREE.BufferGeometry[]>()

  add(mat: MatKey, g: THREE.BufferGeometry | THREE.BufferGeometry[], m?: THREE.Matrix4): this {
    const list = Array.isArray(g) ? g : [g]
    let bin = this.bins.get(mat)
    if (!bin) this.bins.set(mat, (bin = []))
    for (let geo of list) {
      if (geo.index) geo = geo.toNonIndexed()
      if (!geo.getAttribute('uv')) {
        const n = geo.getAttribute('position').count
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2))
      }
      if (!geo.getAttribute('normal')) geo.computeVertexNormals()
      for (const k of Object.keys(geo.attributes)) {
        if (k !== 'position' && k !== 'normal' && k !== 'uv') geo.deleteAttribute(k)
      }
      if (m) geo.applyMatrix4(m)
      bin.push(geo)
    }
    return this
  }

  /** Merge another Parts into this one (optionally transformed). */
  addParts(o: Parts, m?: THREE.Matrix4): this {
    for (const [k, list] of o.bins) this.add(k, list.map((g) => g.clone()), m)
    return this
  }

  build(name = ''): THREE.Group {
    const group = new THREE.Group()
    group.name = name
    for (const [key, list] of this.bins) {
      if (!list.length) continue
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false)
      if (!merged) continue
      const spec = MATS[key]
      if (spec.module) {
        const uv = merged.getAttribute('uv')
        const [mu, mv] = spec.module
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / mu, uv.getY(i) / mv)
      }
      merged.computeBoundingSphere()
      const mesh = new THREE.Mesh(merged, spec.material)
      mesh.name = `${name}:${key}`
      mesh.castShadow = spec.castShadow !== false
      mesh.receiveShadow = true
      group.add(mesh)
    }
    return group
  }
}
