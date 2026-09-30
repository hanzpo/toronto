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
import { color, float, fract, mix, sin, time, uv } from 'three/tsl';
import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';
import { LANDMARKS, createLandmarks, setNight, waterfalls, type LandmarkEntry } from '../landmarks';
import { useApp } from '../state/store';

const CLUSTER_RADIUS = 2500;

interface Cluster {
  /** landmark positions (three coords x, z) and their LOD switch distances */
  pts: { x: number; y: number; z: number; lod: number }[];
  high: THREE.Group;
  low: THREE.Group;
}

/** Bake a group's meshes (world transforms applied) into one mesh per material + attribute layout. */
function bake(src: THREE.Object3D, name: string): THREE.Group {
  src.updateMatrixWorld(true);
  const buckets = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[] }>();
  src.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material)) return;
    const g = m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    g.morphAttributes = {};
    const key = `${(m.material as THREE.Material).uuid}|${Object.keys(g.attributes).sort().join(',')}|${g.index ? 1 : 0}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { mat: m.material as THREE.Material, geos: [] }));
    b.geos.push(g);
  });
  const out = new THREE.Group();
  out.name = name;
  for (const { mat, geos } of buckets.values()) {
    const g = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (!g) continue;
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = `${name}:${mat.name}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    out.add(mesh);
  }
  return out;
}

export class LandmarksLayer implements Layer {
  readonly id = 'landmarks';
  private group = new THREE.Group();
  private lastNight = -1;
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
      if ((o as THREE.Mesh).isMesh) {
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
    if (night !== this.lastNight) {
      setNight(night);
      this.lastNight = night;
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
