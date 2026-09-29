// Residential / hotel supertalls: Pinnacle One Yonge SkyTower, Aura,
// One Bloor East, St. Regis, Shangri-La, L Tower.
import { Parts, prism, slab, chamferRect, offsetPoly, centroid, ccw, cleanPoly, rect, bbox, type V2 } from './kit'
import type { MatKey } from './materials'
import { addOsmParts } from './osmparts'
import type { BuildCtx, OsmPart } from './types'
import { tower } from './financial'

/** Resample a closed polygon at ~step metres. */
function resample(poly: V2[], step: number): V2[] {
  const out: V2[] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / step))
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n])
  }
  return out
}

/** Push each vertex outward (from centroid) by d(i). */
function bulge(poly: V2[], d: (i: number, ang: number) => number): V2[] {
  const c = centroid(poly)
  return poly.map(([x, y], i) => {
    const dx = x - c[0], dy = y - c[1], l = Math.hypot(dx, dy) || 1
    const k = d(i, Math.atan2(dy, dx))
    return [x + (dx / l) * k, y + (dy / l) * k] as V2
  })
}

// Pinnacle One Yonge SkyTower (351 m, 106 storeys). No OSM footprint yet:
// chamfered 42×36 m plan, white balcony banding, glazed crown.
export function buildPinnacle(ctx: BuildCtx) {
  const hi = ctx.detail === 'high'
  const P = new Parts()
  const body = chamferRect(42, 34, 6)
  tower(P, body, 0, 322, 'condoWhite')
  const up = offsetPoly(body, 2)
  tower(P, up, 322, 338, 'glassBlue')
  const crown = offsetPoly(body, 4)
  P.add('glassBlue', prism(crown, 338, 351, { top: false }))
  P.add('roofDark', slab(crown, 344))
  if (hi) P.add('crownLight', prism(offsetPoly(crown, -0.2), 349.5, 351, { top: false }))
  return P.build('pinnacle_one_yonge')
}

// Aura (272 m): glass tower with white bands; crown fins from OSM.
export function buildAura(ctx: BuildCtx) {
  const P = new Parts()
  if (ctx.entry?.osmParts?.length) {
    addOsmParts(P, ctx, (p) => {
      if (p.minH >= 250) return { wall: 'glassBlue', roof: 'crownLight' }
      if ((p.h ?? (p.levels ?? 0) * 3.4) > 60) return { wall: 'condoWhite', roof: 'roofDark' }
      return { wall: 'glassGrey', roof: 'roofDark' }
    })
  } else {
    tower(P, rect(40, 30), 0, 252, 'condoWhite')
  }
  return P.build('aura')
}

// One Bloor East (257 m): wavy white balconies around a glass core.
export function buildOneBloorEast(ctx: BuildCtx) {
  const hi = ctx.detail === 'high'
  const P = new Parts()
  const tw = ccw(cleanPoly(ctx.part('tower', chamferRect(36, 32, 8))))
  addOsmParts(P, ctx, () => ({ wall: 'glassGrey', roof: 'roofDark' }), (p: OsmPart) => (p.h ?? 0) < 100)
  const H = 250
  tower(P, tw, 0, H, 'glassTeal')
  P.add('glassTeal', prism(offsetPoly(tw, 3), H, 257, { top: true }))
  if (hi) {
    const ring = resample(tw, 2.2)
    for (let f = 0, y = 22; y < H - 2; f++, y += 3.15) {
      const out = bulge(ring, (_i, a) => 1.1 + 1.0 * Math.sin(a * 3 + f * 0.42) + 0.35 * Math.sin(a * 7 - f * 0.2))
      P.add('white', prism(out, y, y + 0.35, { bottom: true }))
    }
  }
  return P.build('one_bloor_east')
}

// The St. Regis (277 m to spire): dark glass, stepped crown with spire fins.
export function buildStRegis(ctx: BuildCtx) {
  const P = new Parts()
  if (ctx.entry?.osmParts?.length) {
    addOsmParts(P, ctx, (p) => {
      if (p.minH >= 200) return { wall: 'steelWhite', roof: 'steelWhite' }
      if ((p.h ?? 0) > 50) return { wall: 'glassGrey', roof: 'roofDark' }
      return { wall: 'granite', roof: 'roofDark' }
    })
    // spire to 277 m
    const sp = ctx.entry.osmParts.find((p) => p.id === 951725944)
    const c = sp ? centroid(sp.poly) : ([-15, 5] as V2)
    const b = bbox(sp?.poly ?? rect(4, 4, c[0], c[1]))
    P.add('steelWhite', prism(rect(Math.min(b.w, 3), Math.min(b.d, 3), c[0], c[1]), 250, 277))
  } else {
    tower(P, rect(38, 38), 0, 236.5, 'glassGrey')
  }
  return P.build('st_regis')
}

// Shangri-La (214 m): slender teal-glass slab over a stone podium.
export function buildShangriLa(ctx: BuildCtx) {
  const P = new Parts()
  const fp = ctx.footprint(rect(60, 60))
  const slabP = ccw(cleanPoly(ctx.part('slab', rect(55, 25))))
  tower(P, fp, 0, 14, 'granite')
  tower(P, slabP, 14, 204, 'glassTeal')
  tower(P, offsetPoly(slabP, 2.5), 204, 214, 'glassTeal', 'crownLight')
  addOsmParts(P, ctx, () => ({ wall: 'granite' as MatKey, roof: 'roofDark' as MatKey }), (p) => (p.h ?? 0) < 60 && p.id !== 231773826)
  return P.build('shangri_la')
}

// L Tower (205 m, Libeskind): sweeping skillion crown from the OSM parts.
export function buildLTower(ctx: BuildCtx) {
  const P = new Parts()
  if (ctx.entry?.osmParts?.length) {
    addOsmParts(P, ctx, () => ({ wall: 'glassBlue', roof: 'glassBlue' }))
  } else {
    tower(P, rect(40, 25), 0, 200, 'glassBlue')
  }
  return P.build('l_tower')
}
