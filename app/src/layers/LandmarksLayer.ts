// Custom landmark models (CN Tower, TD Centre, City Hall, ...) plus animated
// sheets for the Niagara waterfalls. The tile renderer already skips the OSM
// buildings these replace (landmarks.json `suppress`).
//
// Draw calls: landmarks near each other are clustered (≤ 2.5 km) and each
// cluster is baked into one mesh per shared material, at two detail levels
// switched by the camera's distance to the cluster's nearest landmark. That
// turns ~75 per-landmark draws (+ ~30 shadow draws) downtown into ~25.
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute, color, float, fract, mix, sin, time, uv } from 'three/tsl';
import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';
import { LANDMARKS, createLandmarks, setNight, waterfalls, type LandmarkEntry } from '../landmarks';
import { useApp } from '../state/store';
import { OCC } from '../render/tiles/facadeMaterial';
import { CULL, SHADOW_ONLY_LAYER } from '../engine/view';

const CLUSTER_RADIUS = 2500;

interface Cluster {
  /** landmark positions (three coords x, z) and their LOD switch distances */
  pts: { x: number; y: number; z: number; lod: number }[];
  high: THREE.Group;
  low: THREE.Group;
}

/**
 * Untextured, non-emissive, opaque standard materials: their colour, roughness
 * and metalness move into vertex attributes so all of them bake into one mesh
 * per cluster (the downtown cluster has ~20 of these; each was its own draw in
 * the main and the shadow pass).
 */
function isPlain(mat: THREE.Material): mat is THREE.MeshStandardMaterial {
  const m = mat as THREE.MeshStandardMaterial;
  return CULL && m.type === 'MeshStandardMaterial' && !m.map && !m.emissiveMap && !m.normalMap && !m.roughnessMap && !m.metalnessMap
    && !m.aoMap && !m.alphaMap && !m.bumpMap && !m.lightMap && !m.envMap && !m.transparent && m.opacity === 1 && !m.vertexColors
    && m.emissive.r === 0 && m.emissive.g === 0 && m.emissive.b === 0 && !m.flatShading && !m.wireframe && m.alphaTest === 0;
}

const plainMats = new Map<number, THREE.MeshStandardNodeMaterial>();
function plainMaterial(side: THREE.Side): THREE.MeshStandardNodeMaterial {
  let m = plainMats.get(side);
  if (!m) {
    m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, side });
    m.name = 'plain';
    const rm = attribute('rm', 'vec2');
    m.roughnessNode = rm.x;
    m.metalnessNode = rm.y;
    plainMats.set(side, m);
  }
  return m;
}

/** Bake a group's meshes (world transforms applied) into one mesh per material + attribute layout. */
function bake(src: THREE.Object3D, name: string): THREE.Group {
  src.updateMatrixWorld(true);
  const buckets = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[] }>();
  src.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material)) return;
    let g = m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    g.morphAttributes = {};
    let mat = m.material as THREE.Material;
    if (isPlain(mat) && g.attributes.position && g.attributes.normal) {
      const n = g.attributes.position.count, pm = mat;
      const col = new Float32Array(n * 3), rm = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        col[i * 3] = pm.color.r; col[i * 3 + 1] = pm.color.g; col[i * 3 + 2] = pm.color.b;
        rm[i * 2] = pm.roughness; rm[i * 2 + 1] = pm.metalness;
      }
      const p = new THREE.BufferGeometry();
      p.setAttribute('position', g.attributes.position);
      p.setAttribute('normal', g.attributes.normal);
      p.setAttribute('color', new THREE.BufferAttribute(col, 3));
      p.setAttribute('rm', new THREE.BufferAttribute(rm, 2));
      p.setIndex(g.index);
      g = p;
      mat = plainMaterial(pm.side);
    }
    const key = `${mat.uuid}|${Object.keys(g.attributes).sort().join(',')}|${g.index ? 1 : 0}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { mat, geos: [] }));
    b.geos.push(g);
  });
  const out = new THREE.Group();
  out.name = name;
  const casters = new Map<THREE.Side, THREE.BufferGeometry[]>();
  for (const { mat, geos } of buckets.values()) {
    const g = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (!g) continue;
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = `${name}:${mat.name}`;
    // casts through the side's shadow proxy unless its shadow depends on the material (cut-outs, vertex motion, transparency)
    const nm = mat as THREE.Material & { alphaMap?: unknown; positionNode?: unknown; castShadowNode?: unknown; maskNode?: unknown };
    const proxied = CULL && !mat.transparent && mat.alphaTest === 0 && !nm.alphaMap && !nm.positionNode && !nm.castShadowNode && !nm.maskNode;
    mesh.castShadow = !proxied;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.userData.shadowProxy = proxied;
    out.add(mesh);
    if (proxied) {
      let list = casters.get(mat.side);
      if (!list) casters.set(mat.side, (list = []));
      list.push(g);
    }
  }
  // shadow casting: one depth-only proxy per face side instead of one shadow draw per material
  for (const [side, geos] of casters) {
    const proxy = new THREE.Mesh(positionsOnly(geos), shadowProxyMaterial(side));
    proxy.name = `${name}:shadow`;
    proxy.castShadow = true;
    proxy.receiveShadow = false;
    proxy.matrixAutoUpdate = false;
    proxy.layers.set(SHADOW_ONLY_LAYER);
    proxy.userData.shadowProxy = true;
    out.add(proxy);
  }
  return out;
}

/** positions (+ index) of several geometries in one indexed geometry */
function positionsOnly(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let nv = 0, ni = 0;
  for (const g of geos) { const n = g.attributes.position.count; nv += n; ni += g.index ? g.index.count : n; }
  const pos = new Float32Array(nv * 3);
  const idx = nv < 65536 ? new Uint16Array(ni) : new Uint32Array(ni);
  let v = 0, k = 0;
  for (const g of geos) {
    const p = g.attributes.position, n = p.count;
    for (let i = 0; i < n; i++) { pos[(v + i) * 3] = p.getX(i); pos[(v + i) * 3 + 1] = p.getY(i); pos[(v + i) * 3 + 2] = p.getZ(i); }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx[k++] = g.index.getX(i) + v;
    else for (let i = 0; i < n; i++) idx[k++] = v + i;
    v += n;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

const proxyMats = new Map<THREE.Side, THREE.Material>();
/** shadow-only proxy material: shadowSide follows the source side (Front → back faces cast, Double → both) */
function shadowProxyMaterial(side: THREE.Side): THREE.Material {
  let m = proxyMats.get(side);
  if (!m) {
    m = new THREE.MeshBasicNodeMaterial({ side });
    m.name = 'landmark-shadow';
    proxyMats.set(side, m);
  }
  return m;
}

export class LandmarksLayer implements Layer {
  readonly id = 'landmarks';
  private group = new THREE.Group();
  private lastNight = -1;
  private lastOcc = -1;
  private clusters: Cluster[] = [];

  async init(engine: Engine) {
    const res = await fetch(`${engine.dataRoot}/landmarks.json`);
    if (!res.ok) return;
    const json = (await res.json()) as LandmarkEntry[];
    // cluster modelled landmarks by proximity, then bake each cluster per material
    const members: LandmarkEntry[][] = [];
    const centres: [number, number][] = [];
    for (const e of json) {
      if (e.kind === 'waterfall' || !LANDMARKS[e.id]) continue;
      let k = centres.findIndex(([x, y]) => Math.hypot(e.pos[0] - x, e.pos[1] - y) < CLUSTER_RADIUS);
      if (k < 0) { k = centres.length; centres.push([e.pos[0], e.pos[1]]); members.push([]); }
      members[k].push(e);
    }
    members.forEach((list, i) => {
      const ids = list.map((e) => e.id);
      const high = bake(createLandmarks(json, { detail: 'high', include: ids }), `landmarks-${i}`);
      const low = bake(createLandmarks(json, { detail: 'low', include: ids }), `landmarks-${i}-low`);
      low.visible = false;
      this.group.add(high, low);
      this.clusters.push({
        high, low,
        pts: list.map((e) => ({ x: e.pos[0], y: e.base + (LANDMARKS[e.id].height || 0) / 2, z: -e.pos[1], lod: LANDMARKS[e.id].lodDistance ?? 1800 })),
      });
    });
    for (const w of waterfalls(json)) this.group.add(waterfallMesh(w));
    this.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && !o.userData.shadowProxy) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    engine.scene.add(this.group);
  }

  update(ctx: FrameContext) {
    this.group.visible = useApp.getState().layers.buildings;
    // cluster LOD: high detail while any member is within its switch distance
    const c = ctx.cameraPos;
    for (const cl of this.clusters) {
      let near = false;
      for (const p of cl.pts) if (Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z) < p.lod) { near = true; break; }
      cl.high.visible = near;
      cl.low.visible = !near;
    }
    const night = Math.round((1 - ctx.daylight) * 50) / 50;
    // office towers' lit windows also follow office occupancy (render/tiles/facadeMaterial OCC.y)
    const occ = Math.round((OCC.value as THREE.Vector3).y * 50);
    if (night !== this.lastNight || occ !== this.lastOcc) {
      setNight(night);
      this.lastNight = night;
      this.lastOcc = occ;
    }
  }

  dispose() {
    this.group.removeFromParent();
  }
}

function waterfallMesh(w: LandmarkEntry): THREE.Mesh {
  const line = (w as unknown as { line: [number, number][] }).line;
  const top = (w as unknown as { top: number }).top;
  const bottom = (w as unknown as { bottom: number }).bottom;
  const pos: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  let acc = 0;
  for (let i = 0; i < line.length; i++) {
    const [e, n] = line[i];
    if (i > 0) acc += Math.hypot(e - line[i - 1][0], n - line[i - 1][1]);
    pos.push(e, top, -n, e, bottom, -n);
    uvs.push(acc / 20, 1, acc / 20, 0);
    if (i > 0) {
      const a = (i - 1) * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, transparent: true });
  // falling streaks: bands scrolling down, broken up along the brink
  const streak = fract(uv().y.mul(6).add(time.mul(1.4)).add(sin(uv().x.mul(7.3)).mul(0.35)));
  m.colorNode = mix(color(0x9fc9d8), color(0xf4fbff), streak.pow(3));
  m.opacityNode = float(0.92);
  const mesh = new THREE.Mesh(g, m);
  mesh.name = w.id;
  return mesh;
}
