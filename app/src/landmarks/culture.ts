// Markets, industrial heritage and culture: St. Lawrence Market (South Market,
// the new North Market, St. Lawrence Hall), the Distillery District, Toronto
// Reference Library, Art Gallery of Ontario, Meridian Hall, Roy Thomson Hall.
import * as THREE from 'three/webgpu'
import { Parts, prism, slab, bbox, cyl, lathe, offsetPoly, ccw, cleanPoly, rect, type V2 } from './kit'
import type { BuildCtx, OsmPart } from './types'
import {
  addHeritage, partOf, zOf, faceEdge, edgeBox, panel, vault, gableWing, along, slabHoles,
} from './kit2'

const T = (z: number) => (z ? new THREE.Matrix4().makeTranslation(0, z, 0) : undefined)

// ---------------------------------------------------------------------------
// St. Lawrence Market

export function buildStLawrenceMarket(ctx: BuildCtx) {
  const hi = ctx.detail === 'high'
  const P = new Parts()
  // South Market (1904 shed around the 1845 City Hall): brick walls under a
  // broad arched roof with a raised central clerestory; Front St frontage.
  const south = partOf(ctx, 'south', rect(46, 107))
  const sb = bbox(south)
  P.add('victorianBrick', prism(south, 0, 11, { top: false }))
  P.add('roofDark', slab(south, 10.9))
  vault(P, sb.x0 + 0.3, sb.x1 - 0.3, sb.y0 + 0.3, sb.y1 - 6, 11, 19, hi, 8, 'zinc', null)
  addHeritage(P, ctx, (p) => {
    if (p.whole) return null
    if (p.id === 304467236 || p.id === 1291184907) return { wall: 'glassGrey', roof: 'zinc', flat: 'zinc' }
    if (p.id >= 1290813301 && p.id <= 1290813314) {
      // North Market (Rogers Stirk Harbour + Adamson, 2025): glass under zinc vaults
      if (p.roof === 'round' || p.roof === 'gabled') return { wall: 'glassGrey', roof: 'zinc', flat: 'zinc' }
      return { wall: 'glassPlain', roof: 'zinc', flat: 'roofLight' }
    }
    // St. Lawrence Hall (1850): limestone, slate roofs, domed cupola
    if (p.minH >= 20 && p.id !== 1290821213) return { wall: 'white', roof: 'copper', flat: 'copper' }
    return { wall: 'limestone', roof: 'slate', flat: 'slate' }
  })
  // Front Street frontage of the South Market: three-storey brick front with
  // a central pediment and sign.
  const [a, b] = faceEdge(south, [sb.cx, sb.y1 + 200], 20)
  const fr = ccw([a, b, [b[0], b[1] - 7], [a[0], a[1] - 7]] as V2[])
  P.add('victorianBrick', prism(fr, 0, 15, { top: false }))
  P.add('slate', slab(fr, 15))
  const mid: V2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 3.5]
  gableWing(P, mid, [1, 0], 18, 7, 0, 15, 20, 'victorianBrick', 'slate')
  P.add('limestone', edgeBox(a, b, 0, 1, 0, 1.2, 0.3))
  P.add('limestone', edgeBox(a, b, 0.3, 0.7, 14.4, 15.2, 0.35))
  P.add('signWarm', edgeBox(a, b, 0.33, 0.67, 10.5, 12, 0.3, 0.1))
  P.add('storefront', panel(a, b, 0.05, 0.95, 0.5, 4.5, 0.06, [0, 1], true))
  // Jarvis St and Market St sides: arched market doors / shop windows along
  // the ground floor under a continuous green-painted steel awning
  for (const tgt of [[sb.x1 + 200, sb.cy], [sb.x0 - 200, sb.cy]] as V2[]) {
    const [c0, c1] = faceEdge(south, tgt, 30)
    P.add('storefront', panel(c0, c1, 0.03, 0.97, 0.4, 4.2, 0.06, [0, 1], true))
    P.add('copper', edgeBox(c0, c1, 0.03, 0.97, 4.3, 4.55, 1.8, 0.05))
    if (hi) {
      const L = Math.hypot(c1[0] - c0[0], c1[1] - c0[1])
      for (let t = 6; t < L - 3; t += 12) P.add('signWarm', edgeBox(c0, c1, t / L - 0.02, t / L + 0.02, 4.55, 5.2, 0.12, 0.3))
    }
  }
  return P.build('st_lawrence_market')
}

// ---------------------------------------------------------------------------
// Distillery District (Gooderham & Worts, 1859-1927): red-brick Victorian
// industrial buildings, the limestone Stone Distillery, and the chimney.

export function buildDistillery(ctx: BuildCtx) {
  const hi = ctx.detail === 'high'
  const P = new Parts()
  // The buildings themselves are drawn by the tile facade shader (render/tiles/heritage.ts:
  // Victorian loft brick with arched multi-pane sash, limestone for the Stone Distillery, shopfronts
  // on the lanes); this model keeps the lane paving, the catwalks and the chimney.
  // Brick-paved pedestrian lanes (Trinity St, Gristmill / Tank House / Case
  // Goods lanes) between the blocks, and the iron catwalks bridging them
  const lanes = (ctx.entry as unknown as { lanes?: { paving: { ring: V2[]; holes?: V2[][] }[]; catwalks: [V2, V2][] } } | null)?.lanes
  for (const pv of lanes?.paving ?? []) {
    const r = ccw(cleanPoly(pv.ring))
    if (r.length < 3) continue
    const hs = (pv.holes ?? []).map((h) => [...ccw(cleanPoly(h))].reverse())
    P.add('brickPaving', hs.length ? slabHoles(r, hs, 0.14) : slab(r, 0.14))
    P.add('granite', prism(r, -0.6, 0.14, { top: false }))
  }
  for (const [a, b] of lanes?.catwalks ?? []) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (L < 1) continue
    const d: V2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], n: V2 = [-d[1], d[0]]
    const q = (t: number, s_: number): V2 => [a[0] + d[0] * t + n[0] * s_, a[1] + d[1] * t + n[1] * s_]
    const deck = ccw([q(-0.5, -1), q(L + 0.5, -1), q(L + 0.5, 1), q(-0.5, 1)])
    P.add('metalDark', prism(deck, 7.2, 7.5, { bottom: true }))
    for (const s_ of [-1, 1]) {
      const rail = ccw([q(-0.5, s_ * 1 - 0.05), q(L + 0.5, s_ * 1 - 0.05), q(L + 0.5, s_ * 1 + 0.05), q(-0.5, s_ * 1 + 0.05)])
      P.add('metalDark', prism(rail, 8.4, 8.5, { bottom: true }))
      if (hi) for (let t = 0; t <= L; t += 1.5) { const p0 = q(t, s_ * 1); P.add('metalDark', cyl(0.03, 0.9, 7.5, 4, 0.03, p0[0], p0[1])) }
    }
  }
  // The Gooderham & Worts boiler-house chimney (~40 m)
  const bh = partOf(ctx, 'b', rect(39, 11, -11, 38))
  const cb = bbox(bh)
  const c: V2 = [cb.x0 - 4, cb.cy + 5]
  const z = zOf(ctx, 'b')
  P.addParts(new Parts()
    .add('victorianBrick', cyl(2.6, 4, 0, 10, 2.6, c[0], c[1]))
    .add('victorianBrick', cyl(2.3, 34, 4, 12, 1.5, c[0], c[1]))
    .add('concreteDark', cyl(1.9, 2, 38, 12, 1.9, c[0], c[1])), T(z))
  return P.build('distillery_district')
}

// ---------------------------------------------------------------------------
// Toronto Reference Library (Raymond Moriyama, 1977): brick with curving
// glazed terraces stepping around the atrium.

export function buildReferenceLibrary(ctx: BuildCtx) {
  const P = new Parts()
  addHeritage(P, ctx, (p) => {
    if (p.roof === 'skillion') return { wall: 'brick', roof: 'glassBlue', storey: 5 }
    return { wall: 'brick', roof: 'roofDark', flat: 'roofLight', storey: 5 }
  })
  if (!ctx.entry?.osmParts?.length) {
    const lib = partOf(ctx, 'lib', rect(99, 85))
    P.add('brick', prism(lib, 0, 26, { top: false }))
    P.add('roofLight', slab(lib, 26))
  }
  return P.build('reference_library')
}

// ---------------------------------------------------------------------------
// Art Gallery of Ontario (Frank Gehry's 2008 Transformation): the long
// curving glass-and-Douglas-fir Galleria Italia on Dundas St and the
// titanium-blue tower over Grange Park.

export function buildAgo(ctx: BuildCtx) {
  const hi = ctx.detail === 'high'
  const P = new Parts()
  const GLASS = (p: OsmPart) => p.id >= 959819127 && p.id <= 959819147 || p.id === 959903560
  addHeritage(P, ctx, (p) => {
    if (p.whole) return null
    if (p.id === 959819126 || (p.id >= 959903555 && p.id <= 959903558)) return { wall: 'titanium', roof: 'titanium', flat: 'titanium' }
    if (p.id >= 960781588) return { wall: 'wood', roof: 'wood', flat: 'wood' }
    if (GLASS(p)) return { wall: 'vaultGlass', roof: 'vaultGlass', flat: 'vaultGlass' }
    return { wall: 'concreteWin', roof: 'roofLight', flat: 'roofLight', storey: 4.5 }
  })
  // Douglas-fir ribs behind the Dundas St glass
  if (hi) {
    for (const p of ctx.entry?.osmParts ?? []) {
      if (!(p.id >= 959819129 && p.id <= 959819133)) continue
      const poly = ccw(p.poly)
      const b = bbox(poly)
      for (let x = b.x0 + 1.5; x < b.x1; x += 3.2) P.add('wood', prism(rect(0.35, b.d * 0.6, x, b.cy - 1), 4, 19))
    }
  }
  return P.build('ago')
}

// ---------------------------------------------------------------------------
// Meridian Hall (ex-O'Keefe/Sony Centre, Peter Dickinson 1960): limestone
// box with a glass lobby on Front St and the tall fly tower.

export function buildMeridianHall(ctx: BuildCtx) {
  const P = new Parts()
  addHeritage(P, ctx, (p) => {
    if (p.id === 944918503 || p.id === 944918502) return { wall: 'glassPlain', roof: 'roofDark', flat: 'white', storey: 5 }
    return { wall: 'limestone', roof: 'roofDark', flat: 'roofDark', storey: 4.2 }
  })
  const hall = partOf(ctx, 'hall', rect(65, 94))
  const [a, b] = faceEdge(hall, [0, 300], 20)
  P.add('white', edgeBox(a, b, 0.05, 0.95, 9.2, 10.4, 5.5, 0))
  return P.build('meridian_hall')
}

// ---------------------------------------------------------------------------
// Roy Thomson Hall (Arthur Erickson, 1982): round, tent-like skin of mirrored
// glass on a diamond net, flat top.

export function buildRoyThomsonHall(ctx: BuildCtx) {
  const hi = ctx.detail === 'high'
  const P = new Parts()
  const hall = partOf(ctx, 'hall', rect(74, 74))
  const b = bbox(hall)
  const R = Math.min(b.w, b.d) / 2 - 0.5
  const H = 27
  const seg = hi ? 32 : 16
  const prof: V2[] = []
  for (let i = 0; i <= 8; i++) {
    const t = i / 8
    prof.push([R * (1 - 0.42 * Math.pow(t, 1.6)), 1 + (H - 1) * t])
  }
  P.add('rthGlass', lathe(prof, seg, false, Math.PI / seg).translate(b.cx, 0, -b.cy))
  P.add('concrete', cyl(R + 0.2, 1, 0, seg, R + 0.2, b.cx, b.cy))
  const rt = R * 0.58
  P.add('concrete', cyl(rt + 0.3, 1.2, H - 0.2, seg, rt + 0.3, b.cx, b.cy))
  P.add('roofLight', slab(ccw(Array.from({ length: seg }, (_, i) => [b.cx + rt * Math.cos((i / seg) * Math.PI * 2), b.cy + rt * Math.sin((i / seg) * Math.PI * 2)] as V2)), H + 1))
  return P.build('roy_thomson_hall')
}


// ---------------------------------------------------------------------------
// Hamilton City Hall (V. Stanley Roscoe, 1960): white-framed 8-storey slab
// on a glazed two-storey podium, domed council chamber.

export function buildHamiltonCityHall(ctx: BuildCtx) {
  const P = new Parts()
  addHeritage(P, ctx, (p) => {
    if (p.whole) return null
    if (p.roof === 'dome') return { wall: 'white', roof: 'white' }
    if ((p.h ?? 0) > 30) return { wall: 'fcpWhite', roof: 'roofLight', flat: 'roofLight' }
    return { wall: 'glassGrey', roof: 'white', flat: 'white' }
  })
  if (!ctx.entry?.osmParts?.length) {
    const hall = partOf(ctx, 'hall', rect(100, 68))
    P.add('glassGrey', prism(hall, 0, 9, { top: false }))
    P.add('white', slab(hall, 9))
  }
  return P.build('hamilton_city_hall')
}

// ---------------------------------------------------------------------------
// Kitchener City Hall (KPMB, 1993): limestone/brick office wings, glazed
// rotunda on King Street and the open-topped clock tower.

export function buildKitchenerCityHall(ctx: BuildCtx) {
  const P = new Parts()
  const hall = partOf(ctx, 'hall', rect(83, 89))
  const b = bbox(hall)
  P.add('buffBrick', prism(hall, 0, 24, { top: false }))
  P.add('roofDark', slab(hall, 24))
  // King St is to the world north-east of the building
  const rot = ctx.entry?.rotation ?? 0
  const wx = Math.SQRT1_2, wy = Math.SQRT1_2
  const dir: V2 = [wx * Math.cos(-rot) - wy * Math.sin(-rot), wx * Math.sin(-rot) + wy * Math.cos(-rot)]
  const [a, c] = faceEdge(hall, [b.cx + dir[0] * 300, b.cy + dir[1] * 300], 15)
  const m: V2 = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2]
  // glass rotunda half-proud of the front
  P.add('glassBlue', cyl(13, 18, 0, 20, 13, m[0], m[1]))
  P.add('roofLight', cyl(13.4, 1, 18, 20, 13.4, m[0], m[1]))
  // clock tower at one end of the front
  const t = along(a, c, 0.18, -4)
  const tw = rect(7, 7, t[0], t[1])
  P.add('buffBrick', prism(tw, 0, 38, { top: false }))
  P.add('metalDark', prism(offsetPoly(tw, 0.6), 38, 47, { top: false }))
  P.add('metalDark', slab(tw, 47.5, 0.5))
  for (let i = 0; i < 4; i++) P.add('signWarm', panel(tw[i], tw[(i + 1) % 4], 0.2, 0.8, 32, 36.2, 0.1))
  return P.build('kitchener_city_hall')
}
