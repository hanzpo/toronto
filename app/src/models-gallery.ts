// Vehicle / pedestrian model gallery for visual checks: /models.html
//
// URL params:
//   view=consists|cars|road|peds|all   what to show (default all)
//   focus=<car key>                     only that car / consist / road model, at the origin
//   az, el, dist                        camera azimuth / elevation (deg) and distance (m)
//   tx, ty, tz                          orbit target (default: scene centre / focused model)
//   shader=overlay                      MarkerOverlay-style unlit path (vehicleShade) instead of lit
//   night=0..1                          night factor (lamps / signs)
//   flags=<n>                           lamp flags for road vehicles (1 brake, 4 left, 8 right, 16 head)
//   lod=low                             use lowGeometry() for transit cars
//   labels=0                            hide labels
//   view=air                            aircraft (types=A320,B738… or all; airline=ACA or auto)
//     gear, flaps, spoiler (0..1), anim=1 cycles gear/flaps, lod=low far LOD; focus=<ICAO type>
import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { float, normalWorld, uniform } from 'three/tsl'
import { allCars, consistFor, consistLength, type CarSpec, type ConsistSpec } from './models/consists'
import { VEHICLE_MODELS, EXTRA_MODELS, triangleCount } from './models/vehicles'
import { vehicleMaterial, vehicleShade } from './models/material'
import { CAR_VARIANTS, carPalette, pedestrianGeometries, shirtPalette } from './layers/traffic/models'
import { U } from './render/uniforms'
import { AircraftRenderer } from './air/AircraftRenderer'
import { AIRCRAFT, TYPE_CODES } from './models/aircraft'

const q = new URLSearchParams(location.search)
const num = (k: string, d: number) => (q.has(k) ? parseFloat(q.get(k)!) : d)
const view = q.get('view') ?? 'all'
const focus = q.get('focus')
const overlay = q.get('shader') === 'overlay'
const lod = q.get('lod') === 'low'
U.night.value = num('night', 0)
U.sunDir.value.set(-0.45, 0.62, 0.64).normalize()

function tintFor(key: string): number {
  if (key.startsWith('tr') || key.startsWith('t1')) return 0xf8c300
  if (key.startsWith('freedom')) return 0xf58220
  if (key.startsWith('citadis')) return 0x969696
  if (key.startsWith('bus')) return 0xda251d
  return 0xffffff
}

function material(tint: number, liveryAttr: 'livery' | 'tint' = 'livery', flags = 0, tagged = true): THREE.Material {
  const t = uniform(new THREE.Color(tint))
  if (overlay) {
    const m = new THREE.MeshBasicNodeMaterial()
    m.colorNode = vehicleShade(normalWorld as never, { tint: t as never, liveryAttr, flags: float(flags) as never, tagged })
    return m
  }
  return vehicleMaterial({ tint: t as never, liveryAttr, flags: float(flags) as never, tagged })
}

async function main() {
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: q.get('webgl') === '1' })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setSize(innerWidth, innerHeight)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.shadowMap.enabled = true
  document.getElementById('c')!.appendChild(renderer.domElement)
  await renderer.init()

  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#a9c4dc')
  // same rig as render/atmosphere.ts (day)
  scene.add(new THREE.HemisphereLight(0xdfe9f5, 0x8a8472, 1.1 * (1 - U.night.value * 0.85)))
  const sun = new THREE.DirectionalLight(0xfff1d6, 2.2 * (1 - U.night.value * 0.95))
  sun.castShadow = true
  sun.shadow.mapSize.set(4096, 4096)
  sun.shadow.bias = -0.0004
  sun.shadow.normalBias = 0.05
  scene.add(sun, sun.target)
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.MeshStandardMaterial({ color: '#8d9186', roughness: 1 }))
  ground.rotation.x = -Math.PI / 2
  ground.receiveShadow = true
  scene.add(ground)

  const labelRoot = document.getElementById('labels')!
  const labels: { el: HTMLDivElement; pos: THREE.Vector3 }[] = []
  const rows: string[] = []
  const bounds = new THREE.Box3()
  const label = (text: string, pos: THREE.Vector3) => {
    if (q.get('labels') === '0') return
    const el = document.createElement('div')
    el.className = 'lbl'
    el.textContent = text
    labelRoot.appendChild(el)
    labels.push({ el, pos })
  }
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, size: [number, number, number] | null, pos: THREE.Vector3, heading: number) => {
    const m = new THREE.Mesh(geo, mat)
    if (size) m.scale.set(size[0], size[1], size[2])
    m.position.copy(pos)
    m.rotation.y = heading
    m.castShadow = m.receiveShadow = true
    scene.add(m)
    m.updateMatrixWorld()
    bounds.expandByObject(m)
    return m
  }
  const carGeo = (c: CarSpec) => (lod && c.lowGeometry ? c.lowGeometry() : c.geometry())

  /** lay a consist along an arc (radius R, centre of curvature to the left), front at `start`, travelling +x initially */
  const placeConsist = (c: ConsistSpec, start: THREE.Vector3, R: number, name: string) => {
    let s = 0
    const at = (d: number) => {
      const a = d / R
      return { p: new THREE.Vector3(start.x - R * Math.sin(a), 0, start.z - R * (1 - Math.cos(a))), h: -a }
    }
    let tris = 0
    c.cars.forEach((car, i) => {
      const L = car.size[0]
      const { p, h } = at(s + L / 2)
      const geo = carGeo(car)
      tris += triangleCount(geo)
      add(geo, material(tintFor(car.key)), car.size, p, h)
      s += L + (c.gaps[i] ?? 0)
    })
    const len = consistLength(c)
    rows.push(`${name}: ${c.cars.length} cars, ${len.toFixed(1)} m, ${tris} tris${c.articulated ? ' (articulated)' : ''}`)
    label(`${name}`, start.clone().add(new THREE.Vector3(0, 7, 0)))
  }

  const consistList: [string, string, ConsistSpec, number][] = [
    ['streetcar', 'TTC Flexity Outlook (504)', consistFor('streetcar', { agency: 'ttc', short: '504' }), 22],
    ['lrt5', 'Line 5 Flexity Freedom ×2', consistFor('lrt', { agency: 'ttc', short: '5' }), 60],
    ['lrt6', 'Line 6 Citadis Spirit', consistFor('lrt', { agency: 'ttc', short: '6' }), 40],
    ['subway1', 'Line 1 Toronto Rocket', consistFor('subway', { agency: 'ttc', short: '1' }), 250],
    ['subway2', 'Line 2 T1', consistFor('subway', { agency: 'ttc', short: '2' }), 250],
    ['subway4', 'Line 4 TR 4-car', consistFor('subway', { agency: 'ttc', short: '4' }), 200],
    ['go', 'GO Lakeshore West (MP40 + 12)', consistFor('commuter_rail', { agency: 'go', short: 'LW' }), 500],
    ['up', 'UP Express', consistFor('airport_rail', { agency: 'up', short: 'UP' }), 250],
    ['via', 'VIA Corridor', consistFor('intercity_rail', { agency: 'via', short: 'VIA' }), 400],
    ['bus', 'TTC bus 40\'', consistFor('bus', { agency: 'ttc', short: '504' }), 30],
    ['busartic', 'TTC bus artic (29)', consistFor('bus', { agency: 'ttc', short: '29' }), 20],
  ]

  const cars = allCars()
  const air = view === 'air' || (focus !== null && focus in AIRCRAFT)
  const airStatics: ReturnType<AircraftRenderer['addStatic']>[] = []
  const airR = air ? new AircraftRenderer() : null
  const AUTO: Record<string, string> = {
    DH8D: 'POE', AT76: 'NOS', CRJ9: 'JZA', E75L: 'UAL', E295: 'POE', BCS3: 'ACA', A319: 'ACA', A320: 'ACA', A20N: 'FLE', A321: 'ROU', A21N: 'TSC',
    B737: 'WJA', B738: 'SWG', B38M: 'WJA', B39M: 'UAL', B752: 'UPS', B763: 'CJT', B788: 'ACA', B789: 'WJA', A333: 'TSC', A339: 'DAL', A359: 'DLH', B77W: 'ACA',
  }
  if (air && airR) {
    scene.add(airR.root)
    const list = focus && focus in AIRCRAFT ? [focus] : (q.get('types') ?? 'all') === 'all' ? TYPE_CODES : q.get('types')!.split(',')
    const st = { gear: num('gear', 1), far: 0, flaps: num('flaps', 0), prop: 0.3, spoiler: num('spoiler', 0), lit: true }
    let z = 0
    const perRow = num('cols', 6)
    let xCur = 0, rowMaxSpan = 0
    list.forEach((code, i) => {
      const spec = AIRCRAFT[code]
      if (!spec) return
      if (i > 0 && i % perRow === 0) { z += rowMaxSpan + 8; xCur = 0; rowMaxSpan = 0 }
      const al = q.get('airline') && q.get('airline') !== 'auto' ? q.get('airline')! : AUTO[code] ?? 'ACA'
      const m = new THREE.Matrix4().makeTranslation(xCur, 0, z + spec.span / 2)
      const h = airR.addStatic(code, al, m, st, lod)
      airStatics.push(h)
      const g = lod ? h.model.low : h.model.geometry
      rows.push(`${code} ${spec.name} [${al}] L ${spec.length} span ${spec.span} H ${spec.height} · ${triangleCount(g)} tris (low ${triangleCount(h.model.low)})`)
      label(code, new THREE.Vector3(xCur, spec.height + 2, z + spec.span / 2))
      bounds.expandByPoint(new THREE.Vector3(xCur - spec.length * 0.5, 0, z)).expandByPoint(new THREE.Vector3(xCur + spec.length * 0.5, spec.height, z + spec.span))
      xCur -= spec.length + 10
      rowMaxSpan = Math.max(rowMaxSpan, spec.span)
    })
    ;(window as unknown as { __air: unknown }).__air = { airR, airStatics }
  } else if (focus) {
    const car = cars.find((c) => c.key === focus)
    const cons = consistList.find(([k]) => k === focus)
    const road = CAR_VARIANTS.find((v) => v.key === focus)
    if (car) {
      const geo = carGeo(car)
      add(geo, material(tintFor(car.key)), car.size, new THREE.Vector3(), 0)
      rows.push(`${car.key}: ${car.name} · ${car.size.map((v) => v.toFixed(2)).join('×')} m · ${triangleCount(geo)} tris (low ${car.lowGeometry ? triangleCount(car.lowGeometry()) : '-'})`)
    } else if (road) {
      add(road.geometry(), material(carPalette[num('color', 6)].getHex(), 'tint', num('flags', 0)), null, new THREE.Vector3(), 0)
      rows.push(`${road.key}: ${road.name} · ${triangleCount(road.geometry())} tris`)
    } else if (cons) {
      placeConsist(cons[2], new THREE.Vector3(0, 0, 0), num('R', cons[3]), cons[1])
    } else if (focus.startsWith('ped')) {
      pedestrianGeometries().forEach((g, i) => {
        add(g, material(shirtPalette[i * 3 % shirtPalette.length].getHex(), 'tint'), null, new THREE.Vector3(0, 0, i * 0.9 - 1.5), 0)
        rows.push(`ped ${i}: ${triangleCount(g)} tris`)
      })
    }
  } else {
    let z = 0
    if (view === 'all' || view === 'consists') {
      for (const [, name, c, R] of consistList) {
        placeConsist(c, new THREE.Vector3(0, 0, z), R, name)
        z += 14 + Math.min(R * (1 - Math.cos(Math.min(consistLength(c) / R, Math.PI))), 120)
      }
    }
    if (view === 'all' || view === 'cars') {
      let x = 0
      for (const car of cars) {
        const geo = carGeo(car)
        add(geo, material(tintFor(car.key)), car.size, new THREE.Vector3(x - car.size[0] / 2, 0, z + 10), 0)
        rows.push(`${car.key}: ${car.size[0].toFixed(2)}×${car.size[1].toFixed(2)}×${car.size[2].toFixed(2)} m · ${triangleCount(geo)} tris · low ${car.lowGeometry ? triangleCount(car.lowGeometry()) : '-'}`)
        label(car.key, new THREE.Vector3(x - car.size[0] / 2, car.size[1] + 1.5, z + 10))
        x -= car.size[0] + 3
      }
      z += 20
    }
    if (view === 'all' || view === 'road') {
      let x = 0
      CAR_VARIANTS.forEach((v, i) => {
        const g = v.geometry()
        add(g, material(carPalette[(i * 5 + 3) % carPalette.length].getHex(), 'tint', num('flags', 0)), null, new THREE.Vector3(x, 0, z + 6), 0)
        rows.push(`${v.key} (${v.name}, kind ${v.kind}, ${v.length} m): ${triangleCount(g)} tris`)
        label(v.key, new THREE.Vector3(x, 3, z + 6))
        x -= v.length + 2
      })
      z += 10
    }
    if (view === 'all' || view === 'peds') {
      pedestrianGeometries().forEach((g, i) => {
        for (let k = 0; k < 4; k++) {
          add(g, material(shirtPalette[(i * 4 + k) % shirtPalette.length].getHex(), 'tint'), null, new THREE.Vector3(-k * 1.2, 0, z + 4 + i * 1.2), 0)
        }
        rows.push(`ped ${i}: ${triangleCount(g)} tris`)
      })
    }
  }
  void VEHICLE_MODELS; void EXTRA_MODELS

  const c = bounds.getCenter(new THREE.Vector3())
  const sz = bounds.getSize(new THREE.Vector3())
  const target = new THREE.Vector3(num('tx', c.x), num('ty', Math.min(2, c.y)), num('tz', c.z))
  const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.1, 20000)
  const az = (num('az', 60) * Math.PI) / 180, el = (num('el', 22) * Math.PI) / 180
  const dist = num('dist', Math.max(sz.x, sz.z) * 1.1 + 5)
  camera.position.set(target.x + dist * Math.cos(el) * Math.sin(az), target.y + dist * Math.sin(el), target.z + dist * Math.cos(el) * Math.cos(az))
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.target.copy(target)
  controls.update()
  const sr = Math.max(sz.x, sz.z) * 0.6 + 20
  const scam = sun.shadow.camera as THREE.OrthographicCamera
  scam.left = -sr; scam.right = sr; scam.top = sr; scam.bottom = -sr; scam.near = 1; scam.far = 4 * sr + 400
  sun.target.position.copy(c)
  sun.position.copy(c).add(U.sunDir.value.clone().multiplyScalar(2 * sr + 100))

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(innerWidth, innerHeight)
  })
  const hud = document.getElementById('hud')!
  hud.style.whiteSpace = 'pre'
  hud.textContent = rows.join('\n')
  const v = new THREE.Vector3()
  const t0 = performance.now()
  renderer.setAnimationLoop(() => {
    U.time.value = (performance.now() - t0) / 1000
    if (airR && (q.get('anim') === '1' || q.has('prop'))) {
      const tt = U.time.value
      const gear = q.get('anim') === '1' ? Math.min(1, Math.max(0, 0.5 + 0.8 * Math.sin(tt * 0.6))) : num('gear', 1)
      for (const h of airStatics) airR.restate(h, { gear, far: 0, flaps: q.get('anim') === '1' ? gear : num('flaps', 0), prop: (tt * 14) % (Math.PI * 2), spoiler: num('spoiler', 0), lit: true })
    }
    controls.update()
    renderer.render(scene, camera)
    for (const l of labels) {
      v.copy(l.pos).project(camera)
      const vis = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1
      l.el.style.display = vis ? '' : 'none'
      if (vis) {
        l.el.style.left = `${((v.x + 1) / 2) * innerWidth}px`
        l.el.style.top = `${((1 - v.y) / 2) * innerHeight}px`
      }
    }
    ;(window as unknown as { __ready: boolean }).__ready = true
  })
}

main().catch((e) => {
  document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;top:30px;left:8px;color:#f33;white-space:pre-wrap">${e?.stack ?? e}</pre>`)
  console.error(e)
})
