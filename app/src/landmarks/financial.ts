// Financial district towers. All use the downtown grid frame (x along King
// St, y up Bay St) and the exact OSM footprints exported in landmarks.json
// `parts`, with hand-set heights, materials and crowns.
import * as THREE from 'three/webgpu'
import {
  Parts, prism, slab, prismTopFn, offsetPoly, rect, centroid, bbox, box, cyl, movePoly,
  tube, P as P3, ccw, cleanPoly, type V2,
} from './kit'
import type { MatKey } from './materials'
import { addOsmParts, insideAny } from './osmparts'
import type { BuildCtx, OsmPart } from './types'

/** Plain tower: facade walls + flat roof slab. */
export function tower(P: Parts, poly: V2[], y0: number, y1: number, wall: MatKey, roof: MatKey = 'roofDark') {
  P.add(wall, prism(poly, y0, y1, { top: false, bottom: y0 > 0.1 }))
  P.add(roof, slab(poly, y1))
}

function part(ctx: BuildCtx, name: string, fb: V2[]) {
  return ccw(cleanPoly(ctx.part(name, fb)))
}

// ---------------------------------------------------------------------------
// Toronto-Dominion Centre (Mies van der Rohe): black steel & bronze glass.

function miesTower(P: Parts, poly: V2[], H: number, hi: boolean) {
  const lobbyH = 7.3
  const inner = offsetPoly(poly, 2.4)
  P.add('glassPlain', prism(inner, 0, lobbyH, { top: false }))
  P.add('roofDark', slab(inner, 0.05))
  P.add('tdBlack', prism(poly, lobbyH, H, { top: false, bottom: true }))
  // mechanical floors: slightly proud louvred band near the top + parapet
  P.add('roofDark', prism(offsetPoly(poly, -0.1), H - 1.2, H, { top: false, bottom: true }))
  P.add('roofDark', slab(poly, H))
  if (hi) {
    // exposed perimeter columns at the recessed lobby, ~9 m bays
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length]
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      const n = Math.max(1, Math.round(len / 9.1))
      for (let k = 0; k < n; k++) {
        const t = k / n
        const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t
        P.add('tdBlack', box(0.7, lobbyH, 0.7, x, lobbyH / 2, y))
      }
    }
  }
}

export function buildTdCentre(ctx: BuildCtx) {
  const hi = ctx.detail === 'high'
  const P = new Parts()
  miesTower(P, part(ctx, 'td_bank', rect(76, 40)), 222.9, hi)
  miesTower(P, part(ctx, 'td_north', rect(65, 38, -60, 61)), 182.9, hi)
  miesTower(P, part(ctx, 'td_south', rect(54, 37, -42, -92)), 153.6, hi)
  miesTower(P, part(ctx, 'td_west', rect(38, 47, -137, -5)), 128.0, hi)
  miesTower(P, part(ctx, 'bay222', rect(35, 60, 71, 7)), 133.2, hi)
  // Banking pavilion: single tall glass storey under a deep black roof.
  const pav = part(ctx, 'pavilion', rect(45, 46, 47, 61))
  P.add('glassPlain', prism(offsetPoly(pav, 1.6), 0, 7.2, { top: false }))
  P.add('tdBlack', prism(pav, 7.2, 9.4, { bottom: true, top: false }))
  P.add('roofDark', slab(pav, 9.4))
  return P.build('td_centre')
}

// ---------------------------------------------------------------------------
// First Canadian Place: 298 m white tower with notched corners.

export function buildFirstCanadianPlace(ctx: BuildCtx) {
  const P = new Parts()
  const poly = part(ctx, 'tower', notchedSquare(57.5, 4.5))
  tower(P, poly, 0, 290, 'fcpWhite', 'white')
  P.add('crownLight', prism(offsetPoly(poly, 0.6), 290, 297, { top: false }))
  P.add('roofDark', slab(offsetPoly(poly, 0.6), 296.5))
  P.add('white', prism(offsetPoly(poly, 6), 290, 298))
  return P.build('first_canadian_place')
}

function notchedSquare(s: number, n: number): V2[] {
  const h = s / 2
  return [
    [-h + n, -h], [h - n, -h], [h - n, -h + n], [h, -h + n], [h, h - n], [h - n, h - n], [h - n, h],
    [-h + n, h], [-h + n, h - n], [-h, h - n], [-h, -h + n], [-h + n, -h + n],
  ]
}

// ---------------------------------------------------------------------------
// Scotia Plaza: red granite, notched chevron plan, sloped chevron top.

export function buildScotiaPlaza(ctx: BuildCtx) {
  const P = new Parts()
  const poly = part(ctx, 'tower', notchedSquare(40, 4))
  const bb = bbox(poly)
  const H = 275, drop = 24
  // Ridge along the SW-NE diagonal: faces fall away to the NW and SE corners.
  const half = Math.hypot(bb.w, bb.d) / 2
  const f = (x: number, y: number) => {
    const u = ((x - bb.cx) - (y - bb.cy)) / Math.SQRT2
    return H - (drop * Math.abs(u)) / (half * 0.7)
  }
  P.add('scotiaRed', prismTopFn(poly, 0, (x, y) => Math.max(H - drop - 2, f(x, y))))
  // Rest of the block (the 1951 Bank of Nova Scotia building etc.)
  addOsmParts(P, ctx, () => ({ wall: 'limestone', roof: 'roofDark', pitched: 'copper' }),
    (p) => !insideAny(p, [poly]) && (p.h ?? 0) < 200)
  return P.build('scotia_plaza')
}

// ---------------------------------------------------------------------------
// Commerce Court: CC West (239 m stainless, I.M. Pei), CC North (1931 stepped).

export function buildCommerceCourt(ctx: BuildCtx) {
  const hi = ctx.detail === 'high'
  const P = new Parts()
  const west = part(ctx, 'west', rect(55, 49))
  P.add('glassPlain', prism(offsetPoly(west, 2), 0, 8, { top: false }))
  tower(P, west, 8, 239, 'ccwSteel', 'metalDark')
  P.add('ccwSteel', prism(west, 7.9, 8, { top: false, bottom: true }))
  const east = part(ctx, 'east', rect(30, 60, 55, 5))
  tower(P, east, 0, 55, 'ccwSteel')
  const south = part(ctx, 'south', rect(50, 44, -20, -50))
  tower(P, south, 0, 21, 'ccwSteel')

  // Commerce Court North: stepped limestone tower with an arcaded crown.
  const n0 = part(ctx, 'north', rect(47, 52, -20, 55))
  const tiers: [number, number, number][] = [[0, 0, 62], [4.5, 62, 104], [7.5, 104, 118], [10.5, 118, 138], [13, 138, 142]]
  for (const [ins, y0, y1] of tiers) tower(P, ins ? offsetPoly(n0, ins) : n0, y0, y1, 'limestone', 'copper')
  const cc = centroid(n0)
  P.add('copper', cyl(3, 4, 142, 8, 1.2, cc[0], cc[1]))
  if (hi) {
    // tall arched openings in the crown
    const crown = offsetPoly(n0, 10.4)
    for (let i = 0; i < crown.length; i++) {
      const a = crown[i], b = crown[(i + 1) % crown.length]
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      if (len < 8) continue
      const nx = (b[1] - a[1]) / len, ny = -(b[0] - a[0]) / len
      for (const t of [0.3, 0.5, 0.7]) {
        const x = a[0] + (b[0] - a[0]) * t + nx * 0.15, y = a[1] + (b[1] - a[1]) * t + ny * 0.15
        const g = new THREE.BoxGeometry(3.2, 12, 0.3)
        g.rotateY(Math.atan2(ny, nx) + Math.PI / 2)
        g.translate(x, 127.5, -y)
        P.add('glassPod', g)
      }
    }
  }
  return P.build('commerce_court')
}

// ---------------------------------------------------------------------------
// Royal Bank Plaza: two gold sawtooth triangular towers + glass atrium.

export function buildRoyalBankPlaza(ctx: BuildCtx) {
  const P = new Parts()
  const south = part(ctx, 'south', [[-20, -40], [30, -40], [5, 10]])
  const north = part(ctx, 'north', [[-95, 25], [-45, 25], [-70, -20]])
  tower(P, south, 0, 180, 'rbpGold', 'roofDark')
  tower(P, north, 0, 114, 'rbpGold', 'roofDark')
  const atrium = part(ctx, 'atrium', rect(40, 30, -40, 0))
  tower(P, atrium, 0, 36, 'rbpGold', 'glassPlain')
  return P.build('royal_bank_plaza')
}

// ---------------------------------------------------------------------------
// Brookfield Place: TD Canada Trust Tower (261 m) + Bay Wellington Tower
// (207 m) from the OSM setback parts, granite podium, Allen Lambert Galleria.

export function buildBrookfieldPlace(ctx: BuildCtx) {
  const hi = ctx.detail === 'high'
  const P = new Parts()
  const gal = part(ctx, 'galleria', rect(116, 20, -23, -14))
  // The galleria polygon is L-shaped; the vault runs along its long straight run.
  const gb = bbox(gal)
  const vaultY0 = gb.y1 - 20.3, vaultY1 = gb.y1
  const vaultPoly = rect(gb.w, vaultY1 - vaultY0, gb.cx, (vaultY0 + vaultY1) / 2)
  const style = (p: OsmPart) => {
    const h = p.h ?? 0
    if (p.minH > 220 && h > 250) return { wall: 'steelWhite' as MatKey, roof: 'steelWhite' as MatKey }
    if (h > 40) return { wall: 'brookGlass' as MatKey, roof: 'granite' as MatKey }
    return { wall: 'granite' as MatKey, roof: 'roofDark' as MatKey }
  }
  if (ctx.entry?.osmParts?.length) {
    addOsmParts(P, ctx, style, (p) => !insideAny(p, [vaultPoly]) && p.kind !== 'roof')
  } else {
    tower(P, part(ctx, 'tdct_tower', rect(55, 35, -58, -65)), 0, 261, 'brookGlass')
    tower(P, part(ctx, 'bwt_tower', rect(60, 32, -3, 12)), 0, 207, 'brookGlass')
  }
  // Allen Lambert Galleria: parabolic white steel ribs + glass vault
  const x0 = gb.x0, x1 = gb.x1, yc = (vaultY0 + vaultY1) / 2, hw = (vaultY1 - vaultY0) / 2
  const spring = 9, crown = 26
  const arch = (y: number) => spring + (crown - spring) * (1 - Math.pow((y - yc) / hw, 2))
  const nSeg = 10
  const sec: V2[] = []
  for (let i = 0; i <= nSeg; i++) {
    const y = yc - hw + (2 * hw * i) / nSeg
    sec.push([y, arch(y)])
  }
  const glass = new THREE.BufferGeometry()
  const pos: number[] = []
  for (let i = 0; i < nSeg; i++) {
    const [ya, ha] = sec[i], [yb, hb] = sec[i + 1]
    pos.push(x0, ha, -ya, x1, ha, -ya, x1, hb, -yb, x0, ha, -ya, x1, hb, -yb, x0, hb, -yb)
  }
  glass.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  glass.computeVertexNormals()
  const flip = glass.clone()
  const idx = flip.getAttribute('position').array as Float32Array
  for (let t = 0; t < idx.length; t += 9) {
    for (let k = 0; k < 3; k++) {
      const a = idx[t + 3 + k]; idx[t + 3 + k] = idx[t + 6 + k]; idx[t + 6 + k] = a
    }
  }
  flip.computeVertexNormals()
  P.add('glassPlain', [glass, flip])
  P.add('granite', prism(rect(gb.w, 1.2, gb.cx, vaultY0 - 0.6), 0, spring + 0.5))
  P.add('granite', prism(rect(gb.w, 1.2, gb.cx, vaultY1 + 0.6), 0, spring + 0.5))
  if (hi) {
    for (let x = x0 + 2; x < x1; x += 5.5) {
      const pts = sec.map(([y, h]) => P3(x, h + 0.3, y))
      P.add('steelWhite', tube(pts, 0.35, 4))
      P.add('steelWhite', cyl(0.5, spring, 0, 6, 0.5, x, vaultY0))
      P.add('steelWhite', cyl(0.5, spring, 0, 6, 0.5, x, vaultY1))
    }
  }
  return P.build('brookfield_place')
}

// ---------------------------------------------------------------------------
// CIBC Square: 81 Bay (south) & 141 Bay (north), diagonal-braced glass.

export function buildCibcSquare(ctx: BuildCtx) {
  const P = new Parts()
  const t1 = part(ctx, 'south_tower', rect(35, 42, -25, -18))
  const t2 = part(ctx, 'south_tower2', rect(38, 32, -21, 15))
  const style = (p: OsmPart) => {
    const h = p.h ?? 0
    if (p.minH > 150) return { wall: 'steelWhite' as MatKey }
    if (h > 100) return { wall: 'cibcGlass' as MatKey, roof: 'roofDark' as MatKey }
    return { wall: 'glassGrey' as MatKey, roof: 'roofDark' as MatKey }
  }
  if (ctx.entry?.osmParts?.length) {
    addOsmParts(P, ctx, style, (p) => p.kind !== 'column' || true)
  } else {
    tower(P, t1, 0, 219, 'cibcGlass')
    tower(P, t2, 0, 241, 'cibcGlass')
  }
  // 141 Bay: same architecture on the north site (OSM lacks its tower parts).
  const north = part(ctx, 'north', rect(90, 50, 20, 135))
  const nb = bbox(north)
  const sb = bbox([...t1, ...t2])
  const dx = nb.x0 + 6 - sb.x0, dy = nb.cy - sb.cy + 6
  tower(P, movePoly(t1, dx, dy), 0, 229, 'cibcGlass')
  tower(P, movePoly(t2, dx, dy), 0, 243, 'cibcGlass')
  tower(P, north, 0, 22, 'glassGrey')
  // Elevated park over the rail corridor, between the two sites.
  const parkY0 = bbox([...t1, ...t2]).y1 + 25, parkY1 = nb.y0 - 2
  if (parkY1 > parkY0 + 5) {
    const park = rect(40, parkY1 - parkY0, sb.cx + 10, (parkY0 + parkY1) / 2)
    P.add('concrete', prism(park, 11.5, 13.5, { top: false, bottom: true }))
    P.add('granite', slab(park, 13.5))
  }
  return P.build('cibc_square')
}

// ---------------------------------------------------------------------------
// 160 Front Street West: glass tower with sloped/serrated corner facets.

export function buildTd160Front(ctx: BuildCtx) {
  const P = new Parts()
  if (ctx.entry?.osmParts?.length) {
    addOsmParts(P, ctx, (p) => {
      const h = p.h ?? 0
      if (h > 100) return { wall: 'glassBlue', roof: 'roofDark' }
      if (h > 12) return { wall: 'brick', roof: 'roofDark' }
      return { wall: 'glassGrey', roof: 'roofDark' }
    })
  } else {
    tower(P, rect(45, 46), 0, 239.9, 'glassBlue')
  }
  return P.build('td_160_front')
}
