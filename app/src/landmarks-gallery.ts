// Standalone landmark gallery for visual testing: /landmarks.html
//
// URL params:
//   mode=real|grid   real = true relative positions (default), grid = lineup
//   focus=<id>       show a single landmark (local coords)
//   az, el, dist     camera azimuth/elevation (deg) and distance (m)
//   tx, ty, tz       orbit target (world metres, relative to origin)
//   night=0..1       night factor
//   detail=high|low|auto
//   webgl=1          force the WebGL2 backend
//   labels=0         hide labels
//   src=<url>        landmarks.json to load (default /data/landmarks.json)
import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { createLandmarks, buildLandmark, setNight, stats, LANDMARKS, type LandmarkEntry } from './landmarks'

const q = new URLSearchParams(location.search)
const num = (k: string, d: number) => (q.has(k) ? parseFloat(q.get(k)!) : d)

const ORIGIN: [number, number] = [200, -800] // near Union Station / financial district

async function main() {
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: q.get('webgl') === '1' })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setSize(innerWidth, innerHeight)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.shadowMap.enabled = q.get('shadows') !== '0'
  document.getElementById('c')!.appendChild(renderer.domElement)
  await renderer.init()

  const night = num('night', 0)
  const scene = new THREE.Scene()
  const sky = new THREE.Color().lerpColors(new THREE.Color('#a9c4dc'), new THREE.Color('#0c1424'), night)
  scene.background = sky
  scene.fog = new THREE.Fog(sky, 4000, 20000)

  const hemi = new THREE.HemisphereLight('#dfeaf5', '#6b6552', 1.6 * (1 - night * 0.85))
  scene.add(hemi)
  const sun = new THREE.DirectionalLight('#fff4e0', 2.6 * (1 - night * 0.95))
  sun.position.set(-600, 900, 500)
  sun.castShadow = true
  sun.shadow.mapSize.set(4096, 4096)
  const sc = sun.shadow.camera as THREE.OrthographicCamera
  sc.left = -1400; sc.right = 1400; sc.top = 1400; sc.bottom = -1400; sc.near = 10; sc.far = 4000
  sun.shadow.bias = -0.0005
  scene.add(sun, sun.target)

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(40000, 40000),
    new THREE.MeshStandardMaterial({ color: night > 0.5 ? '#1c1f22' : '#8d9186', roughness: 1 }),
  )
  ground.rotation.x = -Math.PI / 2
  ground.receiveShadow = true
  scene.add(ground)

  const json: LandmarkEntry[] = await (await fetch(q.get('src') ?? '/data/landmarks.json')).json()
  const byId = new Map(json.map((e) => [e.id, e]))
  const mode = q.get('mode') ?? 'real'
  const focus = q.get('focus')
  const detail = (q.get('detail') ?? 'high') as 'high' | 'low' | 'auto'
  const labels: { el: HTMLDivElement; pos: THREE.Vector3 }[] = []
  const labelRoot = document.getElementById('labels')!
  const addLabel = (text: string, pos: THREE.Vector3) => {
    if (q.get('labels') === '0') return
    const el = document.createElement('div')
    el.className = 'lbl'
    el.textContent = text
    labelRoot.appendChild(el)
    labels.push({ el, pos })
  }

  const target = new THREE.Vector3()
  let defaultDist = 1800
  let t0 = performance.now()
  const root = new THREE.Group()
  scene.add(root)
  if (focus) {
    const e = byId.get(focus) ?? null
    const obj = buildLandmark(focus, e, detail === 'auto' ? 'high' : detail)
    if (obj) {
      root.add(obj)
      const bb = new THREE.Box3().setFromObject(obj)
      if (bb.min.y < -1) ground.position.y = bb.min.y - 1 // e.g. Rainbow Bridge gorge
    }
    const h = LANDMARKS[focus]?.height || 60
    target.set(0, h * 0.45, 0)
    defaultDist = Math.max(h * 1.9, 180)
    // show the OSM footprint outline for reference
    if (e?.footprint) {
      const pts = e.footprint.map(([x, y]) => new THREE.Vector3(x, 0.3, -y))
      pts.push(pts[0].clone())
      root.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#ff3366' })))
    }
  } else if (mode === 'grid') {
    const ids = Object.keys(LANDMARKS).filter((id) => q.get('only')?.split(',').includes(id) ?? true)
    const cols = 7, sp = 330
    ids.forEach((id, i) => {
      const obj = buildLandmark(id, byId.get(id) ?? null, detail === 'auto' ? 'high' : detail)
      if (!obj) return
      const x = (i % cols - (cols - 1) / 2) * sp, z = Math.floor(i / cols) * sp
      obj.position.set(x, 0, z)
      root.add(obj)
      addLabel(LANDMARKS[id].name, new THREE.Vector3(x, LANDMARKS[id].height + 20, z))
    })
    target.set(0, 120, 500)
    defaultDist = 2600
  } else {
    const g = createLandmarks(json, { origin: ORIGIN, detail })
    // keep only the Toronto core within 6 km in real mode
    for (const c of [...g.children]) {
      if (c.position.length() > 6000) g.remove(c)
    }
    for (const c of g.children) {
      const id = c.userData.landmark as string
      c.position.y = 0 // flat ground in the gallery; real base is c.userData.entry.base
      addLabel(LANDMARKS[id].name, c.position.clone().setY(LANDMARKS[id].height + 15))
    }
    root.add(g)
    target.set(0, 80, 0)
  }
  const buildMs = performance.now() - t0
  target.set(num('tx', target.x), num('ty', target.y), num('tz', target.z))

  setNight(night)

  const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 1, 60000)
  const az = (num('az', 35) * Math.PI) / 180, el = (num('el', 18) * Math.PI) / 180, dist = num('dist', defaultDist)
  camera.position.set(
    target.x + dist * Math.cos(el) * Math.sin(az),
    target.y + dist * Math.sin(el),
    target.z + dist * Math.cos(el) * Math.cos(az),
  )
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.target.copy(target)
  controls.update()

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(innerWidth, innerHeight)
  })

  const st = stats(root)
  const hud = document.getElementById('hud')!
  const v = new THREE.Vector3()
  let frames = 0
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
    if (++frames % 10 === 1) {
      const info = renderer.info.render
      hud.textContent = `${(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2'} · meshes ${st.meshes} · tris ${Math.round(st.tris).toLocaleString()} · draws ${info.drawCalls} · build ${buildMs.toFixed(0)} ms`
      ;(window as unknown as { __ready: boolean }).__ready = true
    }
  })
  ;(window as unknown as { __stats: unknown }).__stats = { ...st, buildMs }
}

main().catch((e) => {
  document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;top:30px;left:8px;color:#f33;white-space:pre-wrap">${e?.stack ?? e}</pre>`)
  console.error(e)
})
