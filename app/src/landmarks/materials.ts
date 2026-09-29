// Shared landmark material palette. One material instance per key is shared by
// every landmark, so N landmarks cost at most (#keys used) programs and each
// landmark is a handful of draw calls (one merged mesh per material).
//
// Facade materials carry a procedural canvas texture (mullion/spandrel grid)
// plus an emissive map of randomly lit windows for night. Texture "module" is
// the size in metres one texture repeat covers; Parts.build() divides the
// metre-UVs by it.
import * as THREE from 'three/webgpu'

export interface MatSpec {
  material: THREE.MeshStandardMaterial
  /** [u, v] metres covered by one texture repeat (facade materials only) */
  module?: [number, number]
  /** emissive intensity at full night (0 = never glows) */
  night?: number
  /** emissive intensity during the day */
  day?: number
  castShadow?: boolean
}

interface FacadeOpts {
  cols: number // bays per texture
  rows: number // floors per texture
  bay: number // metres
  floor: number // metres
  frame: string // mullion / spandrel colour
  glass: string // window colour
  glass2?: string // alternate window shade (reflection variation)
  mullion?: number // fraction of bay width that is frame (0..1)
  spandrel?: number // fraction of floor height that is solid band
  vertical?: boolean // emphasise vertical piers (spandrel only thin)
  lit?: number // probability a window is lit at night
  warm?: string // lit window colour
  diag?: { color: string; width: number; floors: number } // diagonal bracing overlay
}

const PX = 512

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

function facadeTextures(o: FacadeOpts, seed = 1) {
  const W = PX, H = PX
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  const e = document.createElement('canvas')
  e.width = W
  e.height = H
  const ge = e.getContext('2d')!
  ge.fillStyle = '#000'
  ge.fillRect(0, 0, W, H)
  g.fillStyle = o.frame
  g.fillRect(0, 0, W, H)
  const cw = W / o.cols, ch = H / o.rows
  const mul = (o.mullion ?? 0.12) * cw
  const spd = (o.spandrel ?? 0.3) * ch
  const r = rng(seed)
  for (let j = 0; j < o.rows; j++) {
    // floors light up in runs (offices) -> row-level bias
    const rowBias = r() < 0.35 ? 0.9 : r() * 0.5
    for (let i = 0; i < o.cols; i++) {
      const x = i * cw + mul / 2, y = j * ch + spd
      const w = cw - mul, h = ch - spd
      g.fillStyle = o.glass2 && r() < 0.35 ? o.glass2 : o.glass
      g.fillRect(x, y, w, h)
      if (r() < (o.lit ?? 0.3) * (0.25 + rowBias)) {
        const k = 0.55 + r() * 0.45
        ge.globalAlpha = k
        ge.fillStyle = o.warm ?? (r() < 0.8 ? '#ffd9a0' : '#e8f0ff')
        ge.fillRect(x, y, w, h)
        ge.globalAlpha = 1
      }
    }
  }
  if (o.diag) {
    g.strokeStyle = o.diag.color
    g.lineWidth = o.diag.width
    // X bracing: one diamond per texture tile
    g.beginPath()
    g.moveTo(0, 0); g.lineTo(W, H)
    g.moveTo(W, 0); g.lineTo(0, H)
    g.stroke()
    ge.strokeStyle = '#000'
    ge.lineWidth = o.diag.width
    ge.beginPath()
    ge.moveTo(0, 0); ge.lineTo(W, H)
    ge.moveTo(W, 0); ge.lineTo(0, H)
    ge.stroke()
  }
  const map = new THREE.CanvasTexture(c)
  map.colorSpace = THREE.SRGBColorSpace
  const emap = new THREE.CanvasTexture(e)
  emap.colorSpace = THREE.SRGBColorSpace
  for (const t of [map, emap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.anisotropy = 8
    t.generateMipmaps = true
    t.minFilter = THREE.LinearMipmapLinearFilter
  }
  return { map, emap, module: [o.cols * o.bay, o.rows * o.floor] as [number, number] }
}

function plain(color: string, rough = 0.85, metal = 0, extra: Partial<THREE.MeshStandardMaterialParameters> = {}): MatSpec {
  return { material: new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra }) }
}

function facade(o: FacadeOpts, rough = 0.5, metal = 0.1, night = 1.2, seed = 1): MatSpec {
  night *= 0.5
  const t = facadeTextures(o, seed)
  const material = new THREE.MeshStandardMaterial({
    color: '#ffffff', map: t.map, roughness: rough, metalness: metal,
    emissive: '#ffffff', emissiveMap: t.emap, emissiveIntensity: 0,
  })
  return { material, module: t.module, night }
}

function glow(color: string, base: string, day: number, night: number): MatSpec {
  return {
    material: new THREE.MeshStandardMaterial({ color: base, emissive: color, emissiveIntensity: day, roughness: 0.6 }),
    day, night, castShadow: false,
  }
}

function build() {
  return {
    // --- plain surfaces
    concrete: plain('#d8d4cb', 0.9),
    concreteDark: plain('#9c9890', 0.9),
    white: plain('#f1f0ec', 0.7),
    roofLight: plain('#d6d8d8', 0.6, 0.1),
    roofDark: plain('#45484c', 0.9),
    metalDark: plain('#5d6268', 0.55, 0.3),
    steelWhite: plain('#eceeef', 0.45, 0.2),
    copper: plain('#6fa38d', 0.75),
    slate: plain('#4f5358', 0.85),
    stoneGrey: plain('#a39a8c', 0.95),
    granite: plain('#bdb6aa', 0.8),
    goldSolid: plain('#caa04a', 0.35, 0.35),
    yellow: plain('#f3c21b', 0.5),
    red: plain('#b8322a', 0.6),
    water: plain('#3f7390', 0.15, 0.1),
    glassPlain: plain('#44607a', 0.2, 0.3),
    glassPod: plain('#2c3a46', 0.25, 0.3),
    // --- emissive accents
    beacon: glow('#ff2a1a', '#7a1a14', 0.6, 6),
    cnLights: glow('#6f9bff', '#d8d4cb', 0.0, 4),
    crownLight: glow('#fff2d6', '#e9e6de', 0.0, 3),
    podLights: glow('#ffe0b0', '#2c3a46', 0.05, 2.5),

    // --- facades (bay metres × floor metres)
    tdBlack: facade({ cols: 8, rows: 8, bay: 1.52, floor: 3.66, frame: '#0c0c0d', glass: '#4b4a47', glass2: '#57585a', mullion: 0.16, spandrel: 0.26 }, 0.3, 0.15, 1.1, 11),
    fcpWhite: facade({ cols: 8, rows: 8, bay: 1.5, floor: 3.9, frame: '#f2f1ec', glass: '#4c5560', glass2: '#58626d', mullion: 0.55, spandrel: 0.12 }, 0.6, 0.05, 1.0, 12),
    scotiaRed: facade({ cols: 8, rows: 8, bay: 1.6, floor: 3.9, frame: '#a8402f', glass: '#43302c', glass2: '#4d3833', mullion: 0.45, spandrel: 0.4 }, 0.6, 0.05, 1.0, 13),
    ccwSteel: facade({ cols: 8, rows: 8, bay: 1.5, floor: 3.9, frame: '#bfc4c8', glass: '#3c434a', glass2: '#4a525a', mullion: 0.22, spandrel: 0.3 }, 0.4, 0.3, 1.0, 14),
    rbpGold: facade({ cols: 1, rows: 8, bay: 6, floor: 3.9, frame: '#a87a26', glass: '#e0b551', mullion: 0.0, spandrel: 0.1, lit: 0.25 }, 0.3, 0.3, 0.7, 15),
    brookGlass: facade({ cols: 8, rows: 8, bay: 1.5, floor: 3.9, frame: '#cbc5b9', glass: '#5d7686', glass2: '#6c8595', mullion: 0.3, spandrel: 0.18 }, 0.35, 0.15, 1.0, 16),
    glassBlue: facade({ cols: 8, rows: 8, bay: 1.5, floor: 3.2, frame: '#9fb0ba', glass: '#4f7489', glass2: '#5e8399', mullion: 0.08, spandrel: 0.12 }, 0.25, 0.2, 1.0, 17),
    glassTeal: facade({ cols: 8, rows: 8, bay: 1.5, floor: 3.2, frame: '#a7bcbd', glass: '#4b7876', glass2: '#588886', mullion: 0.08, spandrel: 0.14 }, 0.25, 0.2, 1.0, 18),
    glassGrey: facade({ cols: 8, rows: 8, bay: 1.5, floor: 3.2, frame: '#c4c8ca', glass: '#56646f', glass2: '#62717c', mullion: 0.1, spandrel: 0.18 }, 0.3, 0.2, 1.0, 19),
    cibcGlass: facade({ cols: 16, rows: 16, bay: 1.5, floor: 4.2, frame: '#b9c6cf', glass: '#5a7f96', glass2: '#6689a0', mullion: 0.08, spandrel: 0.12, diag: { color: '#eef2f4', width: 10, floors: 16 } }, 0.25, 0.2, 1.0, 20),
    limestone: facade({ cols: 8, rows: 4, bay: 2.4, floor: 4.2, frame: '#d9ceb6', glass: '#3b3f44', mullion: 0.55, spandrel: 0.4, lit: 0.3 }, 0.9, 0, 0.9, 21),
    sandstone: facade({ cols: 8, rows: 4, bay: 2.6, floor: 4.5, frame: '#a98a6c', glass: '#34383c', mullion: 0.6, spandrel: 0.45, lit: 0.25 }, 0.95, 0, 0.8, 22),
    castleStone: facade({ cols: 8, rows: 4, bay: 3.0, floor: 4.5, frame: '#b0a38e', glass: '#34383c', mullion: 0.65, spandrel: 0.5, lit: 0.3 }, 0.95, 0, 0.8, 23),
    brick: facade({ cols: 8, rows: 4, bay: 2.2, floor: 3.8, frame: '#9a4632', glass: '#2f3236', mullion: 0.55, spandrel: 0.4, lit: 0.3 }, 0.9, 0, 0.8, 24),
    concreteWin: facade({ cols: 8, rows: 4, bay: 4, floor: 4, frame: '#cfccc4', glass: '#4a5159', mullion: 0.55, spandrel: 0.55, lit: 0.3 }, 0.85, 0, 0.8, 25),
    romAlu: facade({ cols: 4, rows: 4, bay: 6, floor: 6, frame: '#cdd0d0', glass: '#cdd0d0', mullion: 0.9, spandrel: 0.9, lit: 0, diag: { color: '#46505a', width: 14, floors: 4 } }, 0.45, 0.35, 0.6, 26),
    condoWhite: facade({ cols: 8, rows: 8, bay: 1.5, floor: 3.1, frame: '#eef0f0', glass: '#4f7388', glass2: '#5b8196', mullion: 0.05, spandrel: 0.3, lit: 0.45 }, 0.3, 0.1, 1.1, 28),
    shellConcrete: facade({ cols: 16, rows: 8, bay: 1.2, floor: 3.6, frame: '#e4e0d6', glass: '#565c62', mullion: 0.72, spandrel: 0.04, lit: 0.3 }, 0.85, 0, 0.9, 29),
    hotelWarm: facade({ cols: 8, rows: 8, bay: 1.5, floor: 3.1, frame: '#9aa7ad', glass: '#3f5b6c', glass2: '#4a6878', mullion: 0.1, spandrel: 0.22, lit: 0.5 }, 0.3, 0.2, 1.1, 27),
  } satisfies Record<string, MatSpec>
}

export type MatKey = keyof ReturnType<typeof build>

let _mats: Record<MatKey, MatSpec> | null = null

/** Lazily-created shared material table (needs `document` for canvas textures). */
export const MATS: Record<MatKey, MatSpec> = new Proxy({} as Record<MatKey, MatSpec>, {
  get(_t, k: string) {
    if (!_mats) _mats = build()
    return _mats[k as MatKey]
  },
  ownKeys() {
    if (!_mats) _mats = build()
    return Reflect.ownKeys(_mats)
  },
  getOwnPropertyDescriptor(_t, k) {
    if (!_mats) _mats = build()
    return Reflect.getOwnPropertyDescriptor(_mats, k)
  },
})

/**
 * Night factor 0 (day) .. 1 (night): lights windows, CN Tower LEDs, beacons.
 * Cheap: only touches uniforms of the shared materials.
 */
export function setNight(t: number) {
  const k = Math.max(0, Math.min(1, t))
  for (const key of Object.keys(MATS) as MatKey[]) {
    const s = MATS[key]
    if (s.night === undefined) continue
    s.material.emissiveIntensity = (s.day ?? 0) * (1 - k) + s.night * k
  }
}

/** Recolour the CN Tower LED lighting (e.g. for events). */
export function setCnTowerColor(color: THREE.ColorRepresentation) {
  MATS.cnLights.material.emissive.set(color)
}
