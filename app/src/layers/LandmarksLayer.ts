// Custom landmark models (CN Tower, TD Centre, City Hall, ...) plus animated
// sheets for the Niagara waterfalls. The tile renderer already skips the OSM
// buildings these replace (landmarks.json `suppress`).
import * as THREE from 'three/webgpu';
import { color, float, fract, mix, sin, time, uv } from 'three/tsl';
import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';
import { createLandmarks, setNight, waterfalls, type LandmarkEntry } from '../landmarks';
import { useApp } from '../state/store';

export class LandmarksLayer implements Layer {
  readonly id = 'landmarks';
  private group = new THREE.Group();
  private lastNight = -1;

  async init(engine: Engine) {
    const res = await fetch(`${engine.dataRoot}/landmarks.json`);
    if (!res.ok) return;
    const json = (await res.json()) as LandmarkEntry[];
    this.group.add(createLandmarks(json));
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
