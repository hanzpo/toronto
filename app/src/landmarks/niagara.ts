// Niagara Falls: Skylon Tower and Rainbow Bridge.
import * as THREE from 'three/webgpu'
import { Parts, prism, slab, lathe, cyl, box, beam, rect, P as P3 } from './kit'
import type { BuildCtx } from './types'
import { tower } from './financial'
import { addParts, zOf } from './kit2'

// Skylon Tower (160 m). Canonical frame = world (rotation 0): elevator rails
// at -8°, 112°, 232° as in OSM. Three yellow "bug" elevators ride outside.
export function buildSkylon(ctx: BuildCtx) {
  const hi = ctx.detail === 'high'
  const P = new Parts()
  const seg = hi ? 40 : 14
  // The tower rises out of its three-storey base complex (OSM building
  // 241004751 and its parts, suppressed and drawn here); the tower itself
  // stands on its own ground level (partZ.tower).
  const zt = zOf(ctx, 'tower')
  const TOWER = new Set([241004747, 241004754, 241004755, 241004758, 241004760, 241004763, 241004766, 241004767, 241004769,
    241004770, 241004771, 241004772, 241004774, 241004776, 241004777, 241004779, 241004781, 241004783, 1012630009])
  const baseP = new Parts()
  addParts(baseP, ctx, (p) => (p.whole || TOWER.has(p.id) ? null : { wall: 'concreteWin', roof: 'roofLight' }))
  if (ctx.entry?.osmParts?.some((p) => !TOWER.has(p.id) && !p.whole)) P.addParts(baseP)
  else tower(P, ctx.footprint(rect(30, 30)), zt, zt + 11, 'concreteWin', 'concrete')
  const T = new Parts()
  buildSkylonTower(T, hi, seg)
  P.addParts(T, zt ? new THREE.Matrix4().makeTranslation(0, zt, 0) : undefined)
  return P.build('skylon_tower')
}

function buildSkylonTower(P: Parts, hi: boolean, seg: number) {
  P.add('concrete', cyl(4.6, 118, 0, hi ? 20 : 10, 4.0))
  const rails = [-8, 112, 232].map((d) => (d * Math.PI) / 180)
  rails.forEach((a, k) => {
    const g = new THREE.BoxGeometry(2.2, 120, 2.4)
    g.translate(0, 60, 0)
    g.translate(5.3, 0, 0)
    g.rotateY(a)
    P.add('concrete', g)
    // elevator cab
    const hy = [34, 78, 104][k]
    const cab = new Parts()
    cab.add('yellow', lathe([[0, -3.2], [1.6, -2.9], [1.9, -1.5], [1.9, 1.5], [1.6, 2.9], [0, 3.2]], 12, true))
    cab.add('podLights', lathe([[1.95, -1.1], [1.95, 1.3]], 12))
    P.addParts(cab, new THREE.Matrix4().makeRotationY(a).multiply(new THREE.Matrix4().makeTranslation(8.4, hy, 0)))
  })
  // Pod: dining room (revolving) + observation deck + spire
  P.add('concrete', lathe([[4.2, 114], [9, 118.5], [14.5, 121.5], [17.4, 124]], seg))
  P.add('podLights', lathe([[17.4, 124], [18.1, 127], [18.1, 131], [17.6, 134.5]], seg))
  P.add('white', lathe([[17.6, 134.5], [17.2, 136], [15.6, 137.2]], seg))
  P.add('concrete', lathe([[15.6, 137.2], [15.2, 139], [12, 141.5], [7, 143]], seg))
  P.add('podLights', lathe([[6.3, 143], [6.4, 146]], seg))
  P.add('white', lathe([[6.4, 146], [4, 147.5], [1, 148.3]], seg))
  P.add('steelWhite', cyl(0.6, 12, 148, 8, 0.25))
  P.add('beacon', cyl(0.4, 0.8, 159.5, 8))
}

// Rainbow Bridge (1941): 290 m steel deck-arch across the Niagara gorge.
// Canonical: span along local x; origin = mid-span at deck level (base = rim).
export function buildRainbowBridge(ctx: BuildCtx) {
  const hi = ctx.detail === 'high'
  const P = new Parts()
  const e = ctx.entry
  const drop = e?.river != null ? Math.max(30, e.base - e.river) : 60
  const half = 145
  const total = Math.min(e?.span ?? 440, 460) / 2
  const crownY = -3.2, springY = -Math.min(drop - 12, 42)
  const arch = (x: number) => crownY + (springY - crownY) * Math.pow(x / half, 2)
  const ribs = [-7.5, 7.5]
  // deck girder + roadway + parapets
  P.add('metalDark', prism(rect(total * 2, 19), -2.6, -0.4, { bottom: true }))
  P.add('slate', slab(rect(total * 2, 19), -0.3))
  for (const s of [-1, 1]) P.add('concrete', box(total * 2, 1.1, 0.4, 0, 0.25, s * 9.3))
  // arch ribs
  const n = hi ? 24 : 10
  for (const z of ribs) {
    for (let i = 0; i < n; i++) {
      const x0 = -half + (2 * half * i) / n, x1 = -half + (2 * half * (i + 1)) / n
      P.add('metalDark', beam(P3(x0, arch(x0), z), P3(x1, arch(x1), z), 1.8, 4.2))
    }
  }
  // spandrel columns + cross bracing
  for (let x = -half + 14.5; x < half; x += 14.5) {
    const y = arch(x)
    if (crownY - y > 2) for (const z of ribs) P.add('metalDark', beam(P3(x, y, z), P3(x, -2.6, z), 1.0))
    if (hi) P.add('metalDark', beam(P3(x, y, ribs[0]), P3(x, y, ribs[1]), 0.7))
  }
  // approach piers beyond the arch, down to the gorge rim
  for (let x = half + 16; x < total; x += 18) {
    for (const s of [-1, 1]) for (const z of ribs) P.add('concrete', beam(P3(s * x, -14, z), P3(s * x, -2.6, z), 1.6))
  }
  // abutments at the springing points
  for (const s of [-1, 1]) P.add('concrete', box(10, 10, 22, s * (half + 3), springY - 2, 0))
  return P.build('rainbow_bridge')
}
