// Air traffic layer: schedule-driven aircraft at Pearson, Billy Bishop,
// Hamilton and Waterloo (docs/AIR.md). Evaluates every aircraft analytically
// from sim time, renders instanced models + lights, and handles its own
// screen-space picking (selection goes through the app store as
// { kind: 'aircraft', id: planeKey }; the panel lives in ui/panels/Panels.tsx).
import * as THREE from 'three/webgpu';
import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';
import { AirSystem } from '../air/AirSystem';
import { AircraftRenderer } from '../air/AircraftRenderer';
import { aircraftModel } from '../models/aircraft';
import { useApp } from '../state/store';

const PICK_PX = 14;

export class AirLayer implements Layer {
  readonly id = 'air';
  readonly system: AirSystem;
  readonly renderer = new AircraftRenderer();
  private engine!: Engine;
  private down: { x: number; y: number; t: number; btn: number } | null = null;
  private vp = new THREE.Matrix4();
  private lastCtx: FrameContext | null = null;

  constructor(dataRoot: string) {
    this.system = new AirSystem(dataRoot);
  }

  async init(engine: Engine) {
    this.engine = engine;
    engine.scene.add(this.renderer.root);
    const dom = engine.renderer.domElement;
    dom.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointerup', this.onUp);
    try {
      await this.system.load();
    } catch (e) {
      console.warn('air traffic data unavailable', e);
    }
  }

  get selectedKey(): string | null {
    const s = useApp.getState().selected;
    return s?.kind === 'aircraft' ? s.id : null;
  }

  update(ctx: FrameContext) {
    this.lastCtx = ctx;
    const on = useApp.getState().analytics.air;
    if (on) this.system.evaluate(ctx.simMs);
    else this.system.count = 0;
    this.renderer.update(ctx, this.system.planes, this.system.count, on, this.selectedKey);
  }

  /** screen-space pick; returns the plane key or null */
  pick(clientX: number, clientY: number): string | null {
    const ctx = this.lastCtx;
    if (!ctx || !this.system.count) return null;
    const cam = this.engine.camera;
    const r = this.engine.renderer.domElement.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    const m = this.vp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
    const proj = (e: number, n: number, h: number, out: number[]) => {
      const X = e, Y = h, Z = -n;
      const w = m[3] * X + m[7] * Y + m[11] * Z + m[15];
      if (w <= 0.01) return false;
      out[0] = ((m[0] * X + m[4] * Y + m[8] * Z + m[12]) / w * 0.5 + 0.5) * r.width;
      out[1] = (-(m[1] * X + m[5] * Y + m[9] * Z + m[13]) / w * 0.5 + 0.5) * r.height;
      return true;
    };
    const a = [0, 0], b = [0, 0];
    let best: string | null = null, bd = PICK_PX;
    for (const d of this.renderer.drawn) {
      const c = Math.cos(d.yaw) * Math.cos(d.pitch), s = Math.sin(d.yaw) * Math.cos(d.pitch);
      const L2 = d.len * 0.5;
      const lift = d.scale * 2.5;
      if (!proj(d.e + c * L2 * 1.1, d.n + s * L2 * 1.1, d.h + lift, a)) continue;
      if (!proj(d.e - c * L2 * 0.9, d.n - s * L2 * 0.9, d.h + lift, b)) continue;
      const dist = segDist(x, y, a[0], a[1], b[0], b[1]);
      if (dist < bd) { bd = dist; best = this.system.planes[d.idx].key; }
    }
    return best;
  }

  private onDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY, t: performance.now(), btn: e.button };
  };

  private onUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    if (!d || e.target !== this.engine.renderer.domElement || d.btn !== 0) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || performance.now() - d.t > 500) return;
    if (!useApp.getState().analytics.air) return;
    // runs after the InteractLayer's handler (registered earlier), so an
    // aircraft hit wins over its "clicked nothing" deselect
    const key = this.pick(e.clientX, e.clientY);
    if (key) {
      const pl = this.system.find(key);
      const info = pl ? this.system.info(pl) : null;
      useApp.getState().select({ kind: 'aircraft', id: key, label: info?.flight ?? key });
    }
  };

  /**
   * Keep the camera on a plane (null stops): a smoothed chase from 3/4 behind,
   * framed by the aircraft's size (≈ 2–2.3 lengths away — a 737 fills ~1/3 of the
   * view) and a little further at speed; low pitch so it reads against the sky.
   * Dragging the view changes the chase offset, which is then kept.
   */
  follow(key: string | null) {
    const c = this.engine.controls;
    if (!key) { c.follow(null); return; }
    const p0 = this.system.find(key);
    if (!p0) return;
    const len = aircraftModel(p0.type).spec.length;
    const air0 = p0.pose.h - this.engine.heightAt(p0.pose.e, p0.pose.n) > 30;
    let rel = Math.PI - 0.55; // camera heading relative to the nose bearing (3/4 rear, left side)
    let last = Math.PI / 2 - p0.pose.yaw + rel;
    let dist = len * (air0 ? 2.3 : 2.0);
    let t0 = performance.now();
    c.jumpTo({ heading: last });
    c.follow(() => {
      const p = this.system.find(key);
      if (!p) return null;
      const now = performance.now(), dt = Math.min(0.1, (now - t0) / 1000);
      t0 = now;
      const g = c.goal;
      // user dragged the heading → keep the new offset
      const du = Math.atan2(Math.sin(g.heading - last), Math.cos(g.heading - last));
      if (Math.abs(du) > 1e-4) rel += du;
      const brg = Math.PI / 2 - p.pose.yaw;
      const want = brg + rel;
      last += Math.atan2(Math.sin(want - last), Math.cos(want - last)) * (1 - Math.exp(-dt * 1.2));
      g.heading = last;
      // distance: size-based, +20 % at cruise speed; eased so zooming by hand still works briefly
      const target = len * (p.pose.phase >= 5 && p.pose.phase <= 9 ? 2.3 : 2.0) * (1 + Math.min(0.2, p.pose.v / 1000));
      dist += (target - dist) * (1 - Math.exp(-dt * 0.8));
      if (Math.abs(g.dist - dist) < len * 0.02 || !this.followInit) { g.dist = dist; }
      this.followInit = true;
      return { e: p.pose.e, n: p.pose.n, h: p.pose.h + len * 0.08 };
    }, { dist, pitch: air0 ? 0.1 : 0.2 });
    this.followInit = false;
  }
  private followInit = false;

  dispose() {
    this.engine.renderer.domElement.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointerup', this.onUp);
    this.renderer.dispose();
  }
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
