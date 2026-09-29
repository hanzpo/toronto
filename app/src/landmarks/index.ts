// Landmark models: registry + placement.
//
// Usage (renderer):
//   const json = await (await fetch('/data/landmarks.json')).json()
//   const group = createLandmarks(json, { origin: [anchorE, anchorN] })
//   scene.add(group)
//   const skip = suppressedIds(json)   // tile renderer: skip b_osm in this set
//   setNight(0..1)                     // lights windows / CN Tower LEDs
//
// Each landmark is a THREE.LOD (high detail near, low detail beyond
// `lodDistance`), positioned at x = E - origin[0], z = -(N - origin[1]),
// y = base, rotated by `rotation` about +y. Each detail level is a Group of
// ≤ ~6 meshes (one merged geometry per shared material).
import * as THREE from 'three/webgpu'
import { ccw, cleanPoly, type V2 } from './kit'
import type { BuildCtx, Detail, LandmarkDef, LandmarkEntry } from './types'
import { buildCnTower } from './cn_tower'
import { buildRogersCentre } from './rogers_centre'
import {
  buildTdCentre, buildFirstCanadianPlace, buildScotiaPlaza, buildCommerceCourt, buildRoyalBankPlaza,
  buildBrookfieldPlace, buildCibcSquare, buildTd160Front,
} from './financial'
import {
  buildCityHall, buildOldCityHall, buildUnionStation, buildScotiabankArena, buildRoyalYork,
  buildGooderham, buildCasaLoma, buildRomCrystal, buildPearsonT1,
} from './civic'
import { buildPinnacle, buildAura, buildOneBloorEast, buildStRegis, buildShangriLa, buildLTower } from './towers'
import { buildSkylon, buildRainbowBridge } from './niagara'

export { setNight, setCnTowerColor, MATS } from './materials'
export type { LandmarkEntry, LandmarkDef, BuildCtx } from './types'

export const LANDMARKS: Record<string, LandmarkDef> = {
  cn_tower: { name: 'CN Tower', height: 553.3, build: buildCnTower, lodDistance: 2500 },
  rogers_centre: { name: 'Rogers Centre', height: 86, build: buildRogersCentre },
  td_centre: { name: 'Toronto-Dominion Centre', height: 222.9, build: buildTdCentre },
  first_canadian_place: { name: 'First Canadian Place', height: 298, build: buildFirstCanadianPlace },
  scotia_plaza: { name: 'Scotia Plaza', height: 275, build: buildScotiaPlaza },
  commerce_court: { name: 'Commerce Court', height: 239, build: buildCommerceCourt },
  royal_bank_plaza: { name: 'Royal Bank Plaza', height: 180, build: buildRoyalBankPlaza },
  brookfield_place: { name: 'Brookfield Place', height: 263, build: buildBrookfieldPlace },
  cibc_square: { name: 'CIBC Square', height: 246, build: buildCibcSquare },
  td_160_front: { name: '160 Front Street West', height: 239.9, build: buildTd160Front },
  toronto_city_hall: { name: 'Toronto City Hall', height: 99.5, build: buildCityHall },
  old_city_hall: { name: 'Old City Hall', height: 103.6, build: buildOldCityHall },
  union_station: { name: 'Union Station', height: 32.5, build: buildUnionStation },
  scotiabank_arena: { name: 'Scotiabank Arena', height: 40, build: buildScotiabankArena },
  royal_york: { name: 'Fairmont Royal York', height: 124, build: buildRoyalYork },
  pinnacle_one_yonge: { name: 'Pinnacle One Yonge SkyTower', height: 351, build: buildPinnacle },
  aura: { name: 'Aura', height: 272, build: buildAura },
  one_bloor_east: { name: 'One Bloor East', height: 257, build: buildOneBloorEast },
  st_regis: { name: 'The St. Regis Toronto', height: 277, build: buildStRegis },
  shangri_la: { name: 'Shangri-La Toronto', height: 214, build: buildShangriLa },
  l_tower: { name: 'L Tower', height: 205, build: buildLTower },
  rom_crystal: { name: 'ROM Michael Lee-Chin Crystal', height: 39, build: buildRomCrystal },
  casa_loma: { name: 'Casa Loma', height: 37, build: buildCasaLoma },
  gooderham: { name: 'Gooderham Building', height: 27, build: buildGooderham },
  skylon_tower: { name: 'Skylon Tower', height: 160, build: buildSkylon },
  rainbow_bridge: { name: 'Rainbow Bridge', height: 0, build: buildRainbowBridge, lodDistance: 1500 },
  pearson_t1: { name: 'Pearson Terminal 1', height: 40, build: buildPearsonT1 },
}

export function makeCtx(entry: LandmarkEntry | null, detail: Detail): BuildCtx {
  return {
    entry,
    detail,
    part(name: string, fallback: V2[]) {
      const p = entry?.parts?.[name]
      return p && p.length >= 3 ? ccw(cleanPoly(p)) : fallback
    },
    footprint(fallback: V2[]) {
      const p = entry?.footprint
      return p && p.length >= 3 ? ccw(cleanPoly(p)) : fallback
    },
  }
}

/** Build one landmark in local coordinates (no placement). */
export function buildLandmark(id: string, entry: LandmarkEntry | null, detail: Detail = 'high'): THREE.Object3D | null {
  const def = LANDMARKS[id]
  if (!def) return null
  const obj = def.build(makeCtx(entry, detail))
  obj.name = id
  obj.userData.landmark = id
  return obj
}

export interface CreateOpts {
  /** world [E, N] subtracted from positions (floating origin). Default [0, 0]. */
  origin?: [number, number]
  /** 'auto' = THREE.LOD high+low (default); or force one level */
  detail?: 'auto' | Detail
  /** multiply every def's LOD switch distance */
  lodScale?: number
  /** only these ids */
  include?: string[]
}

/** Instantiate every modelled entry of landmarks.json, placed in world space. */
export function createLandmarks(json: LandmarkEntry[], opts: CreateOpts = {}): THREE.Group {
  const [oe, on] = opts.origin ?? [0, 0]
  const group = new THREE.Group()
  group.name = 'landmarks'
  for (const entry of json) {
    if (entry.kind === 'waterfall') continue
    const def = LANDMARKS[entry.id]
    if (!def) continue
    if (opts.include && !opts.include.includes(entry.id)) continue
    let obj: THREE.Object3D
    const detail = opts.detail ?? 'auto'
    if (detail === 'auto') {
      const lod = new THREE.LOD()
      lod.addLevel(buildLandmark(entry.id, entry, 'high')!, 0)
      lod.addLevel(buildLandmark(entry.id, entry, 'low')!, (def.lodDistance ?? 1800) * (opts.lodScale ?? 1))
      obj = lod
    } else {
      obj = buildLandmark(entry.id, entry, detail)!
    }
    obj.name = entry.id
    obj.userData.landmark = entry.id
    obj.userData.entry = entry
    obj.position.set(entry.pos[0] - oe, entry.base, -(entry.pos[1] - on))
    obj.rotation.y = entry.rotation
    obj.updateMatrix()
    group.add(obj)
  }
  return group
}

/** All OSM building ids replaced by landmark models (for the tile renderer). */
export function suppressedIds(json: LandmarkEntry[]): Set<number> {
  const s = new Set<number>()
  for (const e of json) if (LANDMARKS[e.id]) for (const id of e.suppress ?? []) s.add(id)
  return s
}

/** Waterfall brink lines exported alongside the landmarks. */
export function waterfalls(json: LandmarkEntry[]) {
  return json.filter((e) => e.kind === 'waterfall')
}

/** Draw-call / triangle stats of an object tree (visible LOD level 0 only). */
export function stats(obj: THREE.Object3D) {
  let meshes = 0, tris = 0
  obj.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    meshes++
    const g = m.geometry
    tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3
  })
  return { meshes, tris }
}
