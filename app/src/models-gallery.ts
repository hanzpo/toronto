// Vehicle model gallery for visual checks: /models.html
//
// URL params:
//   only=subway,bus,...   subset (keys of VEHICLE_MODELS / EXTRA_MODELS)
//   az, el, dist           camera azimuth / elevation (deg) and distance (m)
//   tx, ty, tz             orbit target
//   shader=overlay         emulate MarkerOverlay's unlit "fake lighting" (with the proposed livery patch)
//   tint=0|1               apply each model's default tint to livery regions (default 1); tint=route uses a demo route colour
//   align=front            line the fronts up at x = 0 (default: centred)
//   labels=0               hide labels
import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { attribute, float, mix, normalLocal, uniform, vec3, vec4 } from 'three/tsl'
import { VEHICLE_MODELS, EXTRA_MODELS, triangleCount, type VehicleModel } from './models/vehicles'

const q = new URLSearchParams(location.search)
const num = (k: string, d: number) => (q.has(k) ? parseFloat(q.get(k)!) : d)

const DEMO_ROUTE: Record<string, number> = { subway: 0xf8c300, subway4: 0xa21a68, lrt: 0xff8000, lrt1: 0x969696, bus: 0x2a7de1, busArtic: 0x2a7de1 }

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
  scene.add(new THREE.HemisphereLight('#dfeaf5', '#6b6552', 1.6))
  const sun = new THREE.DirectionalLight('#fff4e0', 2.6)
  sun.position.set(-150, 300, 220)
  sun.castShadow = true
  sun.shadow.mapSize.set(4096, 4096)
  sun.shadow.bias = -0.0004
  sun.shadow.normalBias = 0.05
  const sc = sun.shadow.camera as THREE.OrthographicCamera
  sc.left = -200; sc.right = 200; sc.top = 200; sc.bottom = -200; sc.near = 10; sc.far = 1000
  scene.add(sun, sun.target)
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ color: '#8d9186', roughness: 1 }))
  ground.rotation.x = -Math.PI / 2
  ground.receiveShadow = true
  scene.add(ground)

  const all: Record<string, VehicleModel> = { ...VEHICLE_MODELS, ...EXTRA_MODELS }
  const only = q.get('only')?.split(',')
  const keys = Object.keys(all).filter((k) => !only || only.includes(k))
  const overlay = q.get('shader') === 'overlay'
  const tintMode = q.get('tint') ?? '1'
  const labelRoot = document.getElementById('labels')!
  const labels: { el: HTMLDivElement; pos: THREE.Vector3 }[] = []
  const rows: string[] = []
  let z = 0
  let maxL = 0
  for (const k of keys) {
    const m = all[k]
    const geo = m.geometry()
    const [L, H, W] = m.size
    maxL = Math.max(maxL, L)
    const tint = tintMode === 'route' ? DEMO_ROUTE[k] ?? m.defaultTint : tintMode === '0' ? 0xffffff : m.defaultTint
    const tintU = uniform(new THREE.Color(tint))
    const vc = attribute('color', 'vec3')
    const liv = attribute('livery', 'float')
    const base = vc.mul(mix(vec3(1, 1, 1), tintU, liv))
    let mat: THREE.Material
    if (overlay) {
      const mb = new THREE.MeshBasicNodeMaterial()
      mb.colorNode = vec4(base.mul(mix(float(0.62), float(1.08), normalLocal.y.mul(0.5).add(0.5))), 1)
      mat = mb
    } else {
      const ms = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0.1 })
      ms.colorNode = base
      mat = ms
    }
    const mesh = new THREE.Mesh(geo, mat)
    mesh.scale.set(L, H, W)
    const ox = q.get('align') === 'front' ? -L / 2 : 0
    mesh.position.set(ox, 0, z)
    mesh.castShadow = mesh.receiveShadow = true
    scene.add(mesh)
    // rails / road strip
    const strip = new THREE.Mesh(new THREE.BoxGeometry(L + 20, 0.05, W + 1.2), new THREE.MeshStandardMaterial({ color: k.startsWith('bus') ? '#555a5f' : '#6d6457' }))
    strip.position.set(ox, 0.02, z)
    strip.receiveShadow = true
    scene.add(strip)
    const tris = triangleCount(geo)
    rows.push(`${k}: ${m.name} · ${L.toFixed(1)}×${H.toFixed(2)}×${W.toFixed(2)} m · ${tris} tris`)
    if (q.get('labels') !== '0') {
      const el = document.createElement('div')
      el.className = 'lbl'
      el.textContent = `${m.name} — ${L.toFixed(1)} m, ${tris} tris`
      labelRoot.appendChild(el)
      labels.push({ el, pos: new THREE.Vector3(ox + L / 2, H + 1.5, z) })
    }
    z += W + 7
  }
  const cz = (z - 7) / 2
  const target = new THREE.Vector3(num('tx', maxL * 0.3), num('ty', 2), num('tz', cz))
  const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.5, 20000)
  const az = (num('az', 60) * Math.PI) / 180, el = (num('el', 22) * Math.PI) / 180, dist = num('dist', 160)
  camera.position.set(target.x + dist * Math.cos(el) * Math.sin(az), target.y + dist * Math.sin(el), target.z + dist * Math.cos(el) * Math.cos(az))
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.target.copy(target)
  controls.update()
  sun.target.position.copy(target)
  sun.position.copy(target).add(new THREE.Vector3(-150, 300, 220))

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(innerWidth, innerHeight)
  })
  const hud = document.getElementById('hud')!
  hud.style.whiteSpace = 'pre'
  hud.textContent = rows.join('\n')
  const v = new THREE.Vector3()
  renderer.setAnimationLoop(() => {
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
