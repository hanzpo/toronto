// Municipality labels from manifest.json, drawn as DOM elements positioned per frame.
import * as THREE from 'three/webgpu';
import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';
import { useApp } from '../state/store';
import { labelBoard, visibleFrom } from './labelBoard';

interface Lbl { el: HTMLDivElement; e: number; n: number; h: number; occ?: boolean; occFrame?: number }

export class LabelsLayer implements Layer {
  readonly id = 'labels';
  private root = document.createElement('div');
  private labels: Lbl[] = [];
  private engine!: Engine;
  private v = new THREE.Vector3();

  init(engine: Engine) {
    this.engine = engine;
    this.root.className = 'labels-layer';
    engine.renderer.domElement.parentElement?.appendChild(this.root);
    for (const m of engine.tiles.manifest.municipalities ?? []) {
      const el = document.createElement('div');
      el.className = 'place-label';
      el.textContent = m.name;
      this.root.appendChild(el);
      this.labels.push({ el, e: m.label[0], n: m.label[1], h: NaN });
    }
  }

  update(ctx: FrameContext) {
    const show = useApp.getState().layers.labels && ctx.altitude > 1200;
    this.root.style.display = show ? '' : 'none';
    if (!show) return;
    const { width, height } = ctx.viewport;
    const cam = ctx.camera;
    const cp = ctx.cameraPos;
    const n = this.labels.length;
    for (let i = 0; i < n; i++) {
      const l = this.labels[i];
      if (Number.isNaN(l.h) || ctx.frame % 60 === 0) l.h = this.engine.heightAt(l.e, l.n);
      this.v.set(l.e, l.h + 50, -l.n).project(cam);
      const dist = Math.hypot(l.e - cp.x, -l.n - cp.z, cp.y);
      const inView = this.v.z > -1 && this.v.z < 1 && Math.abs(this.v.x) < 1.1 && Math.abs(this.v.y) < 1.1 && dist < 220000;
      if (!inView) continue;
      // terrain occlusion (the escarpment / Oak Ridges from low oblique views), staggered
      if (l.occFrame === undefined || (ctx.frame + i) % 20 === 0) {
        l.occ = !visibleFrom(this.engine, cp.x, cp.y, cp.z, l.e, l.n, l.h + 50, 300);
        l.occFrame = ctx.frame;
      }
      if (l.occ) continue;
      const x = (this.v.x * 0.5 + 0.5) * width, y = (-this.v.y * 0.5 + 0.5) * height;
      const want = Math.max(0, Math.min(1, (ctx.altitude - 1200) / 1800)) * (dist < 150000 ? 1 : 0.6);
      // nearer places win overlaps; municipality names rank above station labels
      labelBoard.submit(l.el, x, y, 10000 - dist / 100, want, { pad: 6 });
    }
  }

  dispose() {
    for (const l of this.labels) labelBoard.remove(l.el);
    this.root.remove();
  }
}
