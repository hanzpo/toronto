// CN Tower (553.3 m). Canonical orientation: one of the three legs points +y
// (local north). Heights follow the OSM 3D parts (main pod 330–370 m, SkyPod
// 440–457 m, stepped antenna to 553 m).
import { Parts, loft, lathe, cyl, type V2 } from './kit'
import type { BuildCtx } from './types'

/** Y-shaped section: 3 arms of length L and width w around a core of radius rc. */
function yShape(L: number, w: number, rc: number): V2[] {
  const out: V2[] = []
  for (let k = 0; k < 3; k++) {
    const t = Math.PI / 2 + (k * 2 * Math.PI) / 3
    const d: V2 = [Math.cos(t), Math.sin(t)]
    const p: V2 = [-d[1], d[0]]
    const tip = (s: number): V2 => [d[0] * L + p[0] * s * w / 2, d[1] * L + p[1] * s * w / 2]
    const root = (s: number): V2 => [d[0] * rc * 0.9 + p[0] * s * w / 2, d[1] * rc * 0.9 + p[1] * s * w / 2]
    out.push(root(-1), tip(-1), tip(1), root(1))
    const tb = t + Math.PI / 3
    out.push([Math.cos(tb) * rc, Math.sin(tb) * rc])
  }
  return out
}

const LEG_TOP = 334
function legAt(h: number) {
  const f = Math.pow(1 - h / LEG_TOP, 1.25)
  return { L: 8.5 + 22 * f, w: 5.5 + 3 * f, rc: 7.2 + 1.2 * f }
}

export function buildCnTower(ctx: BuildCtx) {
  const hi = ctx.detail === 'high'
  const P = new Parts()
  const seg = hi ? 48 : 16

  // Y-shaped tapering legs + core, 0..LEG_TOP
  const levels = hi ? [0, 12, 30, 60, 100, 150, 200, 250, 300, LEG_TOP] : [0, 40, 120, 220, LEG_TOP]
  for (let i = 0; i < levels.length - 1; i++) {
    const a = legAt(levels[i]), b = legAt(levels[i + 1])
    P.add('concrete', loft(yShape(a.L, a.w, a.rc), levels[i], yShape(b.L, b.w, b.rc), levels[i + 1], { top: false }))
    if (hi) {
      // LED strips on each leg tip (glow at night)
      for (let k = 0; k < 3; k++) {
        const t = Math.PI / 2 + (k * 2 * Math.PI) / 3
        const strip = (L: number, w: number): V2[] => {
          const d: V2 = [Math.cos(t), Math.sin(t)], p: V2 = [-d[1], d[0]]
          const hw = w * 0.42
          return [
            [d[0] * (L - 0.1) - p[0] * hw, d[1] * (L - 0.1) - p[1] * hw],
            [d[0] * (L + 0.25) - p[0] * hw, d[1] * (L + 0.25) - p[1] * hw],
            [d[0] * (L + 0.25) + p[0] * hw, d[1] * (L + 0.25) + p[1] * hw],
            [d[0] * (L - 0.1) + p[0] * hw, d[1] * (L - 0.1) + p[1] * hw],
          ]
        }
        P.add('cnLights', loft(strip(a.L, a.w), levels[i], strip(b.L, b.w), levels[i + 1], { top: false }))
      }
    }
  }
  // Hexagonal core above the legs, through the pod, to the SkyPod
  const hex = (r: number) => Array.from({ length: 6 }, (_, i) => [r * Math.cos(Math.PI / 6 + (i * Math.PI) / 3), r * Math.sin(Math.PI / 6 + (i * Math.PI) / 3)] as V2)
  P.add('concrete', loft(hex(7.6), LEG_TOP, hex(6.2), 440, { top: false }))

  // Main pod (330–370 m): radome ring, glass look-out levels, 360 restaurant.
  P.add('concrete', lathe([[9.6, 328.5], [14, 331.5], [19.5, 334]], seg))
  P.add('white', lathe([[19.5, 334], [23.8, 335.8], [24.6, 338], [23.6, 340.2]], seg))
  P.add('podLights', lathe([[23.2, 340.2], [24.2, 345.5], [23.4, 348.5]], seg))
  P.add('white', lathe([[23.4, 348.5], [23.4, 353], [22.4, 355]], seg))
  P.add('podLights', lathe([[22.4, 355], [21.8, 358.5]], seg))
  P.add('concrete', lathe([[21.8, 358.5], [21, 361], [17, 365], [10, 367.5], [6.3, 368.5]], seg))

  // SkyPod (440–457 m)
  P.add('concrete', lathe([[6.2, 436], [9.5, 440], [11.6, 443]], seg))
  P.add('podLights', lathe([[11.6, 443], [12, 446], [11.4, 449.5]], seg))
  P.add('concrete', lathe([[11.4, 449.5], [10.2, 452.5], [7, 455.5], [5.6, 457]], seg))

  // Antenna mast: stepped, tapering (457–553 m)
  const n = hi ? 12 : 6
  P.add('white', cyl(5.6, 38, 457, n, 4.8))
  P.add('steelWhite', cyl(4.4, 15, 495, n, 3.9))
  P.add('white', cyl(3.4, 20, 510, n, 2.6))
  P.add('steelWhite', cyl(2.2, 12, 530, n, 1.7))
  P.add('white', cyl(1.4, 10, 542, n, 0.8))
  P.add('beacon', cyl(0.9, 1.3, 552, n, 0.5))
  P.add('beacon', cyl(4.2, 0.8, 494.5, n))
  return P.build('cn_tower')
}
