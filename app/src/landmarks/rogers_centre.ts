// Rogers Centre (SkyDome), 86 m. Canonical frame: the roof panels are stacked
// along local y (the retractable panels slide along the long axis). The
// exterior ring follows the OSM footprint (incl. the hotel block).
import * as THREE from 'three/webgpu'
import { Parts, prism, bbox, ellipse, P as P3, tube, type V2 } from './kit'
import type { BuildCtx } from './types'

const WALL = 31
const TOP = 86

export function buildRogersCentre(ctx: BuildCtx) {
  const hi = ctx.detail === 'high'
  const P = new Parts()
  const bowl = ctx.part('bowl', ellipse(101, 106, 48))
  const bb = bbox(bowl)
  const cx = bb.cx, cy = bb.cy
  // Plan of the roof: super-ellipse fit to the bowl bbox
  const Rx = bb.w / 2 - 1, Ry = bb.d / 2 - 1

  // Outer ring building (OSM footprint), windows + concrete piers
  const fp = ctx.footprint(ellipse(Rx + 6, Ry + 6, 48, cx, cy))
  P.add('concreteWin', prism(fp, 0, WALL - 3, { top: false }))
  P.add('concreteDark', prism(fp, WALL - 3.2, WALL - 3, { top: true }))
  // Ring wall under the roof springline
  const ring = superEllipse(Rx + 1.5, Ry + 1.5, hi ? 64 : 32, cx, cy)
  P.add('concrete', prism(ring, WALL - 4, WALL + 1.5))

  // Roof: 4 panels along y. Heights offset per panel for visible seams.
  const H = TOP - WALL
  const f = (x: number, y: number) => {
    const u = (x - cx) / Rx, v = (y - cy) / Ry
    const r2 = Math.pow(Math.abs(u), 2.4) + Math.pow(Math.abs(v), 2.4)
    return WALL + H * Math.sqrt(Math.max(0, 1 - Math.min(1, r2)))
  }
  const bands: [number, number, number][] = [
    [-1, -0.5, 0.0], [-0.5, 0.0, 1.6], [0.0, 0.5, 3.0], [0.5, 1.0, 1.4],
  ]
  const nx = hi ? 28 : 12, ny = hi ? 8 : 3
  bands.forEach(([v0, v1, dh], bi) => {
    const g = roofPanel(f, cx, cy, Rx, Ry, v0, v1, dh, nx, ny)
    P.add(bi % 2 ? 'roofLight' : 'white', g)
    if (hi) {
      // rib arches across the panel, plus a heavier rib at the panel's leading edge
      const nr = 4
      for (let r = 0; r <= nr; r++) {
        const v = v0 + ((v1 - v0) * r) / nr
        const y = cy + v * Ry
        const hw = halfWidth(Rx, v)
        const pts: THREE.Vector3[] = []
        for (let i = 0; i <= 16; i++) {
          const x = cx + (-1 + (2 * i) / 16) * hw * 0.995
          pts.push(P3(x, f(x, y) + dh + 0.35, y))
        }
        P.add(r === 0 || r === nr ? 'metalDark' : 'concreteDark', tube(pts, r === 0 || r === nr ? 0.9 : 0.4, 4))
      }
    }
  })
  return P.build('rogers_centre')
}

function halfWidth(Rx: number, v: number) {
  return Rx * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(v), 2.4)), 1 / 2.4)
}

function superEllipse(rx: number, ry: number, n: number, cx: number, cy: number): V2[] {
  const out: V2[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    const c = Math.cos(a), s = Math.sin(a)
    out.push([cx + rx * Math.sign(c) * Math.pow(Math.abs(c), 2 / 2.4), cy + ry * Math.sign(s) * Math.pow(Math.abs(s), 2 / 2.4)])
  }
  return out
}

/** Grid mesh over a band of the roof between normalised v0..v1 (along y). */
function roofPanel(f: (x: number, y: number) => number, cx: number, cy: number, Rx: number, Ry: number,
  v0: number, v1: number, dh: number, nx: number, ny: number) {
  const rows: V2[][] = []
  for (let j = 0; j <= ny; j++) {
    const v = v0 + ((v1 - v0) * j) / ny
    const hw = Math.max(halfWidth(Rx, v), 0.5)
    const row: V2[] = []
    for (let i = 0; i <= nx; i++) row.push([cx - hw + (2 * hw * i) / nx, cy + v * Ry])
    rows.push(row)
  }
  // Build as a stack of thin lofts is awkward; emit triangles via loft of degenerate strips.
  const geos = []
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = rows[j][i], b = rows[j][i + 1], c = rows[j + 1][i + 1], d = rows[j + 1][i]
      geos.push(quadGeo(
        P3(a[0], f(a[0], a[1]) + dh, a[1]), P3(b[0], f(b[0], b[1]) + dh, b[1]),
        P3(c[0], f(c[0], c[1]) + dh, c[1]), P3(d[0], f(d[0], d[1]) + dh, d[1])))
    }
  }
  // Panel lip (vertical face at the panel's south edge shows the overlap seam)
  const lipLo: V2[] = rows[0]
  const lip = lipLo.map(([x, y]) => P3(x, f(x, y) + dh, y))
  for (let i = 0; i < lip.length - 1; i++) {
    const a = lip[i], b = lip[i + 1]
    geos.push(quadGeo(a.clone().setY(a.y - 1.6), b.clone().setY(b.y - 1.6), b, a))
  }
  return geos
}

function quadGeo(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) {
  const g = new THREE.BufferGeometry()
  const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize()
  if (n.y < 0) {
    // keep roof faces pointing up/out
    ;[b, d] = [d, b]
    n.negate()
  }
  const pos = [a, b, c, a, c, d].flatMap((v) => [v.x, v.y, v.z])
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(Array(6).fill(0).flatMap(() => [n.x, n.y, n.z]), 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(12), 2))
  return g
}
