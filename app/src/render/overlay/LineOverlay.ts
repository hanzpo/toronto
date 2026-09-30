// Thick screen-space polylines (Line2NodeMaterial / LineSegments2, WebGPU + WebGL2).
// Lines are batched per pixel-width into one draw call each.
import * as THREE from 'three/webgpu';
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { Engine } from '../../engine/Engine';
import type { FrameContext } from '../../engine/types';

export interface LineSpec {
  id: string;
  /** world coordinates, flat [E, N, elev, E, N, elev, …] (elev = datum metres) */
  points: ArrayLike<number>;
  /** 0xRRGGBB or CSS colour */
  color: number | string;
  /** pixel width (default: overlay default) */
  width?: number;
}

export type DepthMode =
  /** depth-tested normally, drawn on top in analytics mode (default) */
  | 'auto'
  /** always drawn on top of the map */
  | 'onTop'
  /** always depth-tested */
  | 'depth';

export interface LineOverlayOptions {
  name?: string;
  width?: number;
  depthMode?: DepthMode;
  /** metres added to every vertex elevation (default 4) */
  lift?: number;
  /** render order among overlays (higher = later) */
  order?: number;
  opacity?: number;
}

/**
 * Usage:
 *   const lines = new LineOverlay(engine, { width: 4 });
 *   lines.set([{ id: 'line1', points: [e0,n0,z0, e1,n1,z1, …], color: 0xf8c300 }]);
 *   // in your layer update: lines.update(ctx)
 */
export class LineOverlay {
  readonly group = new THREE.Group();
  private lines = new Map<string, LineSpec>();
  private meshes = new Map<number, LineSegments2>();
  private dirty = false;
  private opts: Required<LineOverlayOptions>;
  private lastOnTop: boolean | null = null;

  constructor(engine: Engine, opts: LineOverlayOptions = {}) {
    this.opts = { name: 'lines', width: 3, depthMode: 'auto', lift: 4, order: 100, opacity: 1, ...opts };
    this.group.name = this.opts.name;
    engine.overlayRoot.add(this.group);
  }

  set(lines: LineSpec[]) {
    this.lines.clear();
    for (const l of lines) this.lines.set(l.id, l);
    this.dirty = true;
  }
  add(line: LineSpec) { this.lines.set(line.id, line); this.dirty = true; }
  remove(id: string) { if (this.lines.delete(id)) this.dirty = true; }
  clear() { this.lines.clear(); this.dirty = true; }
  setVisible(v: boolean) { this.group.visible = v; }
  /** fade all lines (0..1); lines at 0 are hidden */
  setOpacity(o: number) {
    if (o === this.opts.opacity) return;
    this.opts.opacity = o;
    for (const m of this.meshes.values()) {
      const mat = m.material as THREE.Line2NodeMaterial;
      const tr = o < 1;
      if (mat.transparent !== tr) { mat.transparent = tr; mat.needsUpdate = true; }
      mat.opacity = o;
    }
  }
  get visible() { return this.group.visible; }

  /** call once per frame */
  update(ctx: FrameContext) {
    if (this.dirty) this.rebuild();
    const onTop = this.opts.depthMode === 'onTop' || (this.opts.depthMode === 'auto' && ctx.analyticsMode);
    if (onTop !== this.lastOnTop) {
      for (const m of this.meshes.values()) {
        const mat = m.material as THREE.Line2NodeMaterial;
        mat.depthTest = !onTop;
        mat.depthWrite = !onTop;
        mat.needsUpdate = true;
      }
      this.lastOnTop = onTop;
    }
  }

  private rebuild() {
    this.dirty = false;
    const byWidth = new Map<number, LineSpec[]>();
    for (const l of this.lines.values()) {
      const w = l.width ?? this.opts.width;
      let a = byWidth.get(w);
      if (!a) byWidth.set(w, (a = []));
      a.push(l);
    }
    for (const [w, m] of this.meshes) {
      if (!byWidth.has(w)) {
        this.group.remove(m);
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
        this.meshes.delete(w);
      }
    }
    const c = new THREE.Color();
    for (const [w, specs] of byWidth) {
      let nSeg = 0;
      for (const s of specs) nSeg += Math.max(0, s.points.length / 3 - 1);
      const pos = new Float32Array(nSeg * 6);
      const col = new Float32Array(nSeg * 6);
      let k = 0;
      const lift = this.opts.lift;
      for (const s of specs) {
        c.set(s.color as THREE.ColorRepresentation);
        const p = s.points;
        for (let i = 0; i + 5 < p.length; i += 3) {
          pos[k] = p[i]; pos[k + 1] = p[i + 2] + lift; pos[k + 2] = -p[i + 1];
          pos[k + 3] = p[i + 3]; pos[k + 4] = p[i + 5] + lift; pos[k + 5] = -p[i + 4];
          col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b; col[k + 3] = c.r; col[k + 4] = c.g; col[k + 5] = c.b;
          k += 6;
        }
      }
      let mesh = this.meshes.get(w);
      if (mesh) {
        mesh.geometry.dispose();
        mesh.geometry = new LineSegmentsGeometry();
      } else {
        const mat = new THREE.Line2NodeMaterial({ linewidth: w, vertexColors: true, worldUnits: false });
        mat.transparent = this.opts.opacity < 1;
        mat.opacity = this.opts.opacity;
        mesh = new LineSegments2(new LineSegmentsGeometry(), mat);
        mesh.frustumCulled = false;
        mesh.renderOrder = this.opts.order;
        mesh.name = `${this.opts.name}:${w}px`;
        this.group.add(mesh);
        this.meshes.set(w, mesh);
        this.lastOnTop = null;
      }
      if (nSeg > 0) {
        (mesh.geometry as LineSegmentsGeometry).setPositions(pos);
        (mesh.geometry as LineSegmentsGeometry).setColors(col);
      }
      mesh.visible = nSeg > 0;
    }
  }

  dispose() {
    for (const m of this.meshes.values()) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.group.removeFromParent();
  }
}
