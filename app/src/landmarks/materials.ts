// Shared landmark material palette. One material instance per key is shared by
// every landmark, so N landmarks cost at most (#keys used) programs and each
// landmark is a handful of draw calls (one merged mesh per material).
//
// Facade materials carry a procedural canvas texture (mullion/spandrel grid)
// plus an emissive map of randomly lit windows for night. Texture "module" is
// the size in metres one texture repeat covers; Parts.build() divides the
// metre-UVs by it.
import * as THREE from 'three/webgpu'
import { floor, fract, mod, sin, smoothstep, texture, time, uv, vec2, float, color, mix } from 'three/tsl'

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

// Animated LED billboard screens (Yonge-Dundas Square). The atlas holds 4
// columns × 4 rows of generic ads; a panel's UV spans one column (u) and the
// full height (v); the shown row cycles with time, phase-shifted per column.
const SCREEN_COLS = 4, SCREEN_ROWS = 4

function screenAtlas(): THREE.CanvasTexture {
  const W = 1024, H = 1024
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  const cw = W / SCREEN_COLS, ch = H / SCREEN_ROWS
  const words = ['SALE', 'LIVE', 'NEW', 'TORONTO', 'FILM', 'MUSIC', 'SUMMER', 'COFFEE',
    'SPORTS', 'NEWS', 'GAME', 'TOUR', 'SHOP', 'FASHION', 'NIGHT', 'EVENT']
  const pals = [['#ff2d55', '#ffd60a'], ['#0a84ff', '#64d2ff'], ['#30d158', '#e5ff3a'], ['#bf5af2', '#ff9f0a'],
    ['#ff375f', '#ffffff'], ['#1c1c1e', '#ff453a'], ['#ff9f0a', '#1c1c1e'], ['#5e5ce6', '#ffd60a']]
  const r = rng(99)
  for (let j = 0; j < SCREEN_ROWS; j++) {
    for (let i = 0; i < SCREEN_COLS; i++) {
      const k = j * SCREEN_COLS + i
      const [a, b] = pals[(k * 3 + j) % pals.length]
      const x = i * cw, y = j * ch
      const grd = g.createLinearGradient(x, y, x + cw, y + ch)
      grd.addColorStop(0, a)
      grd.addColorStop(1, b)
      g.fillStyle = grd
      g.fillRect(x, y, cw, ch)
      // abstract product shape / face
      g.fillStyle = r() < 0.5 ? '#ffffffcc' : '#00000066'
      g.beginPath()
      g.arc(x + cw * (0.25 + r() * 0.5), y + ch * (0.3 + r() * 0.2), cw * (0.12 + r() * 0.12), 0, Math.PI * 2)
      g.fill()
      g.fillStyle = '#ffffff'
      g.font = `900 ${Math.round(ch * 0.2)}px Impact, Arial Black, sans-serif`
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText(words[k], x + cw / 2, y + ch * 0.72, cw * 0.9)
      g.fillStyle = '#00000055'
      g.fillRect(x, y + ch * 0.88, cw, ch * 0.12)
    }
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

function ledScreen(): MatSpec {
  const tex = screenAtlas()
  const m = new THREE.MeshStandardNodeMaterial({ color: '#0b0b0d', roughness: 0.35, metalness: 0.1 })
  const u = uv()
  const col = floor(u.x.mul(SCREEN_COLS))
  const row = mod(floor(time.div(7).add(col.mul(1.37))), SCREEN_ROWS)
  m.emissiveNode = texture(tex, vec2(u.x, row.add(u.y.clamp(0.01, 0.99)).div(SCREEN_ROWS))).mul(1.4)
  return { material: m as unknown as THREE.MeshStandardMaterial, castShadow: false }
}

/** UV rect for one screen panel showing atlas column `col` (0..3). */
export function screenUV(col: number): [number, number] {
  const c = ((col % SCREEN_COLS) + SCREEN_COLS) % SCREEN_COLS
  return [(c + 0.01) / SCREEN_COLS, (c + 0.99) / SCREEN_COLS]
}

// Granite paving: 0.6 × 1.2 m setts in two greys, darker 0.3 m bands every
// 6 m (Yonge-Dundas / Sankofa Square, forecourts). Metre UVs, module 6 m.
function paving(light: string, dark: string, band: string, seed: number): MatSpec {
  const S = 512, c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')!
  const r = rng(seed)
  const px = S / 6 // pixels per metre
  for (let y = 0; y < 6; y += 0.6) {
    for (let x = 0; x < 6; x += 1.2) {
      const off = (Math.round(y / 0.6) % 2) * 0.6
      const t = r()
      g.fillStyle = t < 0.5 ? light : t < 0.85 ? dark : '#9b978f'
      g.fillRect((x + off) * px, y * px, 1.2 * px - 2, 0.6 * px - 2)
      if (x + off + 1.2 > 6) g.fillRect((x + off - 6) * px, y * px, 1.2 * px - 2, 0.6 * px - 2)
    }
  }
  g.fillStyle = band
  g.fillRect(0, 0, S, 0.3 * px)
  g.fillRect(0, 0, 0.3 * px, S)
  const map = new THREE.CanvasTexture(c)
  map.colorSpace = THREE.SRGBColorSpace
  map.wrapS = map.wrapT = THREE.RepeatWrapping
  map.anisotropy = 8
  return { material: new THREE.MeshStandardMaterial({ color: '#ffffff', map, roughness: 0.8 }), module: [6, 6], castShadow: false }
}

// Distillery District lanes: old red clay pavers in herringbone with worn,
// darker joints (3 m module).
function brickPaving(): MatSpec {
  const S = 512, c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')!
  const r = rng(77)
  const px = S / 3, bw = 0.2 * px, bh = 0.1 * px
  g.fillStyle = '#5a3a2e'
  g.fillRect(0, 0, S, S)
  const cols = ['#9a4e3a', '#8c4533', '#a65a42', '#7e3d2f', '#b0664c']
  // herringbone: 45° pairs of bricks
  g.save()
  g.translate(S / 2, S / 2)
  g.rotate(Math.PI / 4)
  for (let y = -S; y < S; y += bh * 2) {
    for (let x = -S; x < S; x += bw + bh) {
      const o = ((y / (bh * 2)) % 2) * bh
      g.fillStyle = cols[Math.floor(r() * cols.length)]
      g.fillRect(x + o, y, bw - 2, bh - 2)
      g.fillStyle = cols[Math.floor(r() * cols.length)]
      g.fillRect(x + o + bw, y - bh, bh - 2, bw - 2)
    }
  }
  g.restore()
  const map = new THREE.CanvasTexture(c)
  map.colorSpace = THREE.SRGBColorSpace
  map.wrapS = map.wrapT = THREE.RepeatWrapping
  map.anisotropy = 8
  return { material: new THREE.MeshStandardMaterial({ color: '#ffffff', map, roughness: 0.9 }), module: [3, 3], castShadow: false }
}

// Fountain jets (Yonge-Dundas Square): crossed vertical quads, one jet per
// integer u (u = jet index + [0, 1]), v = 0 at the nozzle .. 1 at the jet's
// maximum height. Each jet rises and falls on its own phase; streaks scroll up.
function fountainJet(): MatSpec {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide })
  const u = uv()
  const id = floor(u.x)
  const lx = fract(u.x)
  const phase = fract(sin(id.mul(12.9898)).mul(43758.5453))
  const h = sin(time.mul(0.9).add(phase.mul(6.283))).mul(0.4).add(0.6) // current jet height (fraction of max)
  const core = smoothstep(0.5, 0.15, lx.sub(0.5).abs())
  const top = smoothstep(h, h.sub(0.12), u.y)
  const streak = fract(u.y.mul(5).sub(time.mul(2.2)).add(phase))
  m.colorNode = mix(color(0xcfe6f2), color(0xffffff), streak.pow(4))
  m.opacityNode = core.mul(top).mul(float(0.55).add(streak.mul(0.35)))
  return { material: m as unknown as THREE.MeshStandardMaterial, castShadow: false }
}

// Scrolling news ticker (the CityNews crawl on 33 Dundas East): emissive text
// band; u in metres along the band, scrolls with time.
function ticker(): MatSpec {
  const W = 2048, H = 64
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  g.fillStyle = '#0a1a3a'
  g.fillRect(0, 0, W, H)
  g.fillStyle = '#ffd200'
  g.font = '700 40px Arial, sans-serif'
  g.textBaseline = 'middle'
  const items = ['CITY NEWS', 'TTC: LINE 1 SERVICE NORMAL', 'LEAFS WIN 4-2', 'WEATHER 18°C SUNNY', 'GARDINER EXPRESSWAY: LANE CLOSURES',
    'TORONTO', 'YONGE-DUNDAS']
  let x = 10
  for (const t of items) {
    g.fillStyle = '#ffd200'
    g.fillText('\u25B6', x, H / 2)
    g.fillStyle = '#ffffff'
    g.fillText(t, x + 44, H / 2)
    x += 44 + g.measureText(t).width + 40
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.RepeatWrapping
  const m = new THREE.MeshStandardNodeMaterial({ color: '#050608', roughness: 0.4 })
  const u = uv()
  // 1 texture repeat = 60 m of band; crawl at 6 m/s
  m.emissiveNode = texture(tex, vec2(u.x.div(60).add(time.mul(0.1)), u.y)).mul(1.3)
  return { material: m as unknown as THREE.MeshStandardMaterial, castShadow: false }
}

function grass(): MatSpec {
  const material = new THREE.MeshStandardMaterial({ color: '#5f8a3e', roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
  return { material, castShadow: false }
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
    /** smooth Indiana limestone (no window texture): Union Station head house */
    limestoneSmooth: plain('#d7cfbb', 0.88),
    /** train-shed roof soffits: faint bounce light so they don't go black in their own shadow */
    shedUnder: plain('#a9a59c', 0.9, 0, { emissive: '#4a4740', emissiveIntensity: 1 }),
    limestone: facade({ cols: 8, rows: 4, bay: 2.4, floor: 4.2, frame: '#d9ceb6', glass: '#3b3f44', mullion: 0.55, spandrel: 0.4, lit: 0.3 }, 0.9, 0, 0.9, 21),
    sandstone: facade({ cols: 8, rows: 4, bay: 2.6, floor: 4.5, frame: '#a98a6c', glass: '#34383c', mullion: 0.6, spandrel: 0.45, lit: 0.25 }, 0.95, 0, 0.8, 22),
    castleStone: facade({ cols: 8, rows: 4, bay: 3.0, floor: 4.5, frame: '#b0a38e', glass: '#34383c', mullion: 0.65, spandrel: 0.5, lit: 0.3 }, 0.95, 0, 0.8, 23),
    brick: facade({ cols: 8, rows: 4, bay: 2.2, floor: 3.8, frame: '#9a4632', glass: '#2f3236', mullion: 0.55, spandrel: 0.4, lit: 0.3 }, 0.9, 0, 0.8, 24),
    concreteWin: facade({ cols: 8, rows: 4, bay: 4, floor: 4, frame: '#cfccc4', glass: '#4a5159', mullion: 0.55, spandrel: 0.55, lit: 0.3 }, 0.85, 0, 0.8, 25),
    romAlu: facade({ cols: 4, rows: 4, bay: 6, floor: 6, frame: '#cdd0d0', glass: '#cdd0d0', mullion: 0.9, spandrel: 0.9, lit: 0, diag: { color: '#46505a', width: 14, floors: 4 } }, 0.45, 0.35, 0.6, 26),
    condoWhite: facade({ cols: 8, rows: 8, bay: 1.5, floor: 3.1, frame: '#eef0f0', glass: '#4f7388', glass2: '#5b8196', mullion: 0.05, spandrel: 0.3, lit: 0.45 }, 0.3, 0.1, 1.1, 28),
    shellConcrete: facade({ cols: 16, rows: 8, bay: 1.2, floor: 3.6, frame: '#e4e0d6', glass: '#565c62', mullion: 0.72, spandrel: 0.04, lit: 0.3 }, 0.85, 0, 0.9, 29),
    // --- pass 2 (Eaton Centre, UofT, markets, culture)
    vaultGlass: { material: new THREE.MeshStandardMaterial({ color: '#a9c3cf', roughness: 0.12, metalness: 0.45, emissive: '#ffe2b0', emissiveIntensity: 0 }), day: 0, night: 0.55 },
    wood: plain('#b27a48', 0.7),
    titanium: plain('#8fb2cc', 0.4, 0.25),
    zinc: plain('#8c9396', 0.5, 0.5),
    grass: grass(),
    ledScreen: ledScreen(),
    plazaPaving: paving('#c9c5bd', '#b3aea5', '#5d5f63', 41),
    forecourt: paving('#bdb8ae', '#a9a499', '#8b8781', 42),
    fountainJet: fountainJet(),
    seatRed: plain('#a3262a', 0.8),
    brickPaving: brickPaving(),
    ticker: ticker(),
    signRed: glow('#ff3b2f', '#9a1d16', 0.35, 3),
    signWarm: glow('#ffd68a', '#d9c7a0', 0.15, 3),
    bronzeGlass: facade({ cols: 8, rows: 8, bay: 1.5, floor: 3.8, frame: '#4a3d33', glass: '#6a5646', glass2: '#7a6552', mullion: 0.14, spandrel: 0.3 }, 0.3, 0.3, 1.0, 31),
    ecPrecast: facade({ cols: 8, rows: 4, bay: 3, floor: 4.6, frame: '#c3ae93', glass: '#3a3f45', mullion: 0.2, spandrel: 0.72, lit: 0.35 }, 0.85, 0, 0.9, 32),
    victorianBrick: facade({ cols: 8, rows: 4, bay: 2.4, floor: 4.2, frame: '#a4503a', glass: '#2c2f33', mullion: 0.62, spandrel: 0.45, lit: 0.35 }, 0.9, 0, 0.9, 33),
    buffBrick: facade({ cols: 8, rows: 4, bay: 2.6, floor: 4.4, frame: '#c7a57a', glass: '#33373c', mullion: 0.6, spandrel: 0.45, lit: 0.3 }, 0.9, 0, 0.8, 34),
    pinkSandstone: facade({ cols: 8, rows: 4, bay: 2.8, floor: 5, frame: '#b4786a', glass: '#2e3034', mullion: 0.62, spandrel: 0.48, lit: 0.3 }, 0.95, 0, 0.8, 35),
    ucStone: facade({ cols: 8, rows: 4, bay: 2.6, floor: 4.6, frame: '#a9967a', glass: '#2f3236', mullion: 0.64, spandrel: 0.46, lit: 0.3 }, 0.95, 0, 0.8, 36),
    gothicStone: facade({ cols: 8, rows: 4, bay: 2.2, floor: 4.4, frame: '#b2a893', glass: '#2d3034', mullion: 0.7, spandrel: 0.42, lit: 0.3 }, 0.95, 0, 0.8, 37),
    brutalist: facade({ cols: 16, rows: 4, bay: 1.4, floor: 4.5, frame: '#b9b4aa', glass: '#3b3f44', mullion: 0.72, spandrel: 0.2, lit: 0.35 }, 0.9, 0, 0.8, 38),
    rthGlass: facade({ cols: 8, rows: 8, bay: 2.2, floor: 2.2, frame: '#c7d0d6', glass: '#6b8799', glass2: '#7c98aa', mullion: 0.04, spandrel: 0.04, lit: 0.2, diag: { color: '#dfe6ea', width: 6, floors: 8 } }, 0.2, 0.5, 0.8, 39),
    storefront: facade({ cols: 4, rows: 1, bay: 4, floor: 5, frame: '#2f3134', glass: '#56646e', glass2: '#62717c', mullion: 0.12, spandrel: 0.18, lit: 0.8 }, 0.3, 0.3, 1.2, 40),
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
