import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { build } from '../net/core/build';
import { NetView } from '../net/view/NetView';
import { LAYOUTS } from './layouts';

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
const built = build(layout.desc());
const ms = performance.now() - t0;
const view = new NetView(built);
scene.add(view.group);

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
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
  frames++;
});
Object.assign(window as object, { __bench: { built, scene, camera, renderer, view, frames: () => frames } });
