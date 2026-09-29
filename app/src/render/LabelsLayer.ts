// Municipality labels from manifest.json, drawn as DOM elements positioned per frame.
import * as THREE from 'three/webgpu';
import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';
import { useApp } from '../state/store';

interface Lbl { el: HTMLDivElement; e: number; n: number; h: number }

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
    const show = useApp.getState().layers.labels && ctx.altitude > 1500;
    this.root.style.display = show ? '' : 'none';
    if (!show) return;
    const { width, height } = ctx.viewport;
    const cam = ctx.camera;
    for (const l of this.labels) {
      if (Number.isNaN(l.h) || ctx.frame % 60 === 0) l.h = this.engine.heightAt(l.e, l.n);
      this.v.set(l.e, l.h + 50, -l.n).project(cam);
      const dist = Math.hypot(l.e - ctx.cameraPos.x, -l.n - ctx.cameraPos.z, ctx.cameraPos.y);
      const vis = this.v.z > -1 && this.v.z < 1 && Math.abs(this.v.x) < 1.1 && Math.abs(this.v.y) < 1.1 && dist < 220000;
      if (!vis) { l.el.style.opacity = '0'; continue; }
      const x = (this.v.x * 0.5 + 0.5) * width, y = (-this.v.y * 0.5 + 0.5) * height;
      l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
      l.el.style.opacity = String(Math.max(0, Math.min(1, (ctx.altitude - 1500) / 2000)) * (dist < 150000 ? 1 : 0.6));
    }
  }

  dispose() {
    this.root.remove();
  }
}
