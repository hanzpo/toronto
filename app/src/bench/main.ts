import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { build } from '../net/core/build';
import { NetView } from '../net/view/NetView';
import { LAYOUTS } from './layouts';
import { loadTile } from '../net/tiles';
import { NetVehicles } from '../net/view/vehicles';
import { simJson } from '../net/sim/encode';
import initSim, { World } from '../net/sim/pkg/netsim';

const q = new URLSearchParams(location.search);
const id = q.get('l') ?? LAYOUTS[0].id;
const layout = LAYOUTS.find((l) => l.id === id) ?? LAYOUTS[0];

const list = document.getElementById('list')!;
if (q.get('ui') === '0') { list.style.display = 'none'; document.getElementById('info')!.style.display = 'none'; }
for (const l of LAYOUTS) {
  const a = document.createElement('a');
  a.href = `?l=${l.id}`;
  a.textContent = l.title;
  if (l === layout) a.className = 'on';
  list.appendChild(a);
}

const renderer = new THREE.WebGPURenderer({ antialias: true });
await renderer.init();
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.getElementById('view')!.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xbcd0e2);
scene.fog = new THREE.Fog(0xbcd0e2, 400, 1400);
const camera = new THREE.PerspectiveCamera(50, 1, 0.2, 5000);
const hemi = new THREE.HemisphereLight(0xdde8f5, 0x8a8472, 1.2);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 2.6);
sun.position.set(-160, 260, 120);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
const sc = sun.shadow.camera as THREE.OrthographicCamera;
sc.left = sc.bottom = -220; sc.right = sc.top = 220; sc.near = 10; sc.far = 900;
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.05;
scene.add(sun);

const t0 = performance.now();
const mapArg = q.get('map');
let desc = layout.desc();
if (mapArg) {
  const [tx, ty] = mapArg.split(',').map(Number);
  const t = await loadTile('/data/net', tx, ty);
  if (t) desc = t;
}
const built = build(desc);
const ms = performance.now() - t0;
const view = new NetView(built);
scene.add(view.group);

await initSim();
const world = new World(simJson(built), 11);
const pop = layout.pop ?? [10, 0, 0, 0, 10];
world.populate(pop[0], pop[1], pop[2], pop[3], pop[4]);
const agents = new NetVehicles();
const anchor = { origin: new THREE.Vector3(), version: 1, toLocal: (e: number, n: number, z: number, o: THREE.Vector3) => o.set(e, z, -n) };
scene.add(agents.group);
const warm = Number(q.get('warm') ?? 40);
for (let i = 0; i < warm * 10; i++) world.step(0.1);
if (q.get('until') === 'gate') {
  const xs = built.nodes.map((n, i) => (n.kind.endsWith('crossing') ? i : -1)).filter((i) => i >= 0);
  for (let i = 0; i < 9000 && !xs.some((x) => world.gate(x) > 0.99); i++) world.step(0.1);
  for (let i = 0; i < 30; i++) world.step(0.1);
}
const speed = Number(q.get('speed') ?? 1);
const paused = q.get('pause') === '1';
const lights = ['red', 'amber', 'green'] as const;
function syncSim() {
  agents.push(performance.now(), new Float32Array(world.frame2()));
  view.props.setSignals((node, group) => lights[world.signal(node, group)] ?? 'green');
  view.props.setGates((node) => { const g = world.gate(node); return { down: Math.min(1, g * 1.4), flash: g > 0 && Math.floor(performance.now() / 500) % 2 === 0 }; });
}
syncSim();

if (q.get('lanes') === '1') {
  const pos: number[] = [], col: number[] = [];
  const C: Record<string, [number, number, number]> = { drive: [1, 0.2, 0.2], tram: [1, 0.8, 0], rail: [0.2, 0.6, 1], walk: [0.2, 1, 0.3], bike: [1, 0, 1] };
  for (const l of built.lanes) {
    const c = l.node ? [1, 1, 1] as [number, number, number] : C[l.kind] ?? [1, 1, 1];
    for (let i = 0; i < l.pts.length - 1; i++) {
      const a = l.pts[i], b = l.pts[i + 1];
      pos.push(a.x, a.z + 0.3, -a.y, b.x, b.z + 0.3, -b.y);
      col.push(...c, ...c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  scene.add(new THREE.LineSegments(g, new THREE.LineBasicNodeMaterial({ vertexColors: true, depthTest: false })));
}

const controls = new OrbitControls(camera, renderer.domElement);
const cam = (q.get('cam') ?? '').split(',').map(Number);
const [tx, ty, dist, hd, pt] = cam.length === 5 && cam.every((v) => !isNaN(v)) ? cam : layout.cam;
const target = new THREE.Vector3(tx, 0, -ty);
const h = (hd * Math.PI) / 180, p = (pt * Math.PI) / 180;
camera.position.set(tx + dist * Math.cos(p) * Math.sin(h), dist * Math.sin(p), -ty + dist * Math.cos(p) * Math.cos(h));
controls.target.copy(target);
controls.update();

const info = document.getElementById('info')!;
const nodes = built.nodes.filter((n) => n.kind !== 'end' && n.kind !== 'continue').map((n) => `${n.id} ${n.kind}${n.control !== 'auto' ? ' ' + n.control : ''}`);
info.textContent = `${layout.title}\nbuilt in ${ms.toFixed(0)} ms · lanes ${built.lanes.length} · props ${built.props.length}\n${nodes.join('\n')}${built.review.length ? '\nreview: ' + built.review.map((r) => r.kind).join(', ') : ''}`;

function resize() {
  const w = innerWidth, hh = innerHeight;
  renderer.setSize(w, hh);
  camera.aspect = w / hh;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

let frames = 0;
let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000) * speed;
  last = now;
  if (!paused && dt > 0) { let left = dt; while (left > 1e-4) { const h = Math.min(0.05, left); world.step(h); left -= h; } syncSim(); }
  agents.update(performance.now() + 100, anchor, camera.position.x, -camera.position.z, dt, () => null);
  controls.update();
  renderer.render(scene, camera);
  frames++;
});
Object.assign(window as object, { __bench: { built, scene, camera, renderer, view, world, frames: () => frames } });
