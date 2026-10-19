// ?net=2: the primitive network slice (docs/NETWORK.md) -- segments and nodes generated from
// data/net2/primnet.json (tpipe.primnet) replace the tile road ribbons inside its bbox
// (the tile worker skips roads / junction surfaces / street track there).
import * as THREE from 'three/webgpu';
import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';
import { generate, type PrimNet } from './gen';
import { annotate, netMaterial, registerAssets } from './materials';
import { addDecals, NetProps } from './props';

export class NetLayer implements Layer {
  readonly id = 'net2';
  private engine!: Engine;
  private group = new THREE.Group();
  private net: PrimNet | null = null;
  private mesh: THREE.Mesh | null = null;
  private t = 0;
  private lastG = NaN;
  private ox = 0; private oy = 0;
  /** surface material (net2/materials.ts) and placed props (net2/props.ts) */
  private mat: THREE.Material | null = null;
  private props: NetProps | null = null;

  async init(engine: Engine) {
    this.engine = engine;
    engine.scene.add(this.group);
    try {
      const r = await fetch(`${engine.dataRoot}/net2/primnet.json`);
      if (r.ok) this.net = (await r.json()) as PrimNet;
    } catch { /* no slice */ }
    if (this.net) {
      const [x0, y0, x1, y1] = this.net.bbox;
      this.ox = (x0 + x1) / 2; this.oy = (y0 + y1) / 2;
      registerAssets(this.net.assets);
      this.props = new NetProps(this.ox, this.oy);
      this.group.add(this.props.group);
      Object.assign(window as object, { __net2: this });
    }
  }

  /** build (again) once the terrain under the slice is loaded / changed */
  private build() {
    if (!this.net) return;
    // a slice cut from the lidar-solved model (primnet.json z_source 'lidar') is drawn at its own z: the
    // tile terrain is coarser and would lift it; otherwise never below the drawn terrain until the
    // surface is conformed (docs/SURFACE.md)
    const lidar = (this.net as { z_source?: string }).z_source === 'lidar';
    const zAt = (e: number, n: number, z: number) => {
      if (lidar) return z + 0.04;
      const g = this.engine.heightAt(e, n);
      return (Number.isFinite(g) && g > z ? g : z) + 0.04;
    };
    const S = generate(this.net, this.ox, this.oy, zAt);
    addDecals(S, this.net as Parameters<typeof addDecals>[1], zAt);
    const A = annotate(S, this.net);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(S.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(S.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(S.col, 4));
    g.setAttribute('nb', new THREE.BufferAttribute(A.nb, 4));
    g.setAttribute('nc', new THREE.BufferAttribute(A.nc, 4));
    if (this.mesh) { this.group.remove(this.mesh); this.mesh.geometry.dispose(); }
    this.mat ??= netMaterial();
    this.mesh = new THREE.Mesh(g, this.mat);
    this.props?.build(this.net as Parameters<NetProps['build']>[0], zAt);
    this.mesh.receiveShadow = true;
    this.group.add(this.mesh);
  }

  update(ctx: FrameContext) {
    if (!this.net) return;
    this.t += ctx.dt ?? 1 / 60;
    const g = this.engine.heightAt(this.ox, this.oy);
    if (!this.mesh || (this.t > 1 && Math.abs(g - this.lastG) > 0.01 && this.t < 120)) {
      this.lastG = g;
      this.build();
    }
    // vertices are relative to the slice centre; the scene is in world coordinates (x = E, z = -N)
    this.group.position.set(this.ox, 0, -this.oy);
    this.props?.update(ctx, this.engine.scene);
  }

  /** slice bbox (world E0, N0, E1, N1) */
  get bbox(): number[] | null { return this.net?.bbox ?? null; }

  /** a TTC stop the slice draws itself (every stop inside the slice: island furniture or the curbside
   *  pole / shelter of net2/props.ts): other layers skip their pole / shelter there */
  ownsStop(e: number, n: number): boolean {
    if (!this.net) return false;
    const [x0, y0, x1, y1] = this.net.bbox;
    return e >= x0 && e <= x1 && n >= y0 && n <= y1;
  }

  /** QA (peds on the walk): every pedestrian inside the slice, by the band kind under it (nearest edge
   *  section; 'node' = outside every section, i.e. a junction box or corner) and by state
   *  (0 walk, 1 wait at a crossing, 2 crossing, 3 idle at a stop) */
  pedCheck() {
    const tr = (window as unknown as { __traffic?: { snapshot(): { pedCount: number; pf: Float32Array; pu: Uint32Array; oe: number; on: number } | null } }).__traffic;
    const snap = tr?.snapshot();
    if (!this.net || !snap) return null;
    const [x0, y0, x1, y1] = this.net.bbox;
    const out: Record<string, Record<string, number>> = {};
    const bad: number[][] = [];
    for (let i = 0; i < snap.pedCount; i++) {
      const o = i * 6, e = snap.pf[o] + snap.oe, n = snap.pf[o + 1] + snap.on;
      if (e < x0 + 30 || e > x1 - 30 || n < y0 + 30 || n > y1 - 30) continue;
      const state = (snap.pu[o + 5] >> 8) & 255;
      let kind = 'node', bd = Infinity;
      for (const ed of this.net.edges) {
        const sw = ed.sweep;
        if (!sw) continue;
        for (let k = 0; k < sw.c.length - 1; k++) {
          const c = sw.c[k], c2 = sw.c[k + 1];
          const dx = c2[0] - c[0], dy = c2[1] - c[1], L = Math.hypot(dx, dy) || 1;
          const t = ((e - c[0]) * dx + (n - c[1]) * dy) / L;
          if (t < -0.05 || t > L + 0.05) continue;
          const u = (e - c[0]) * sw.n[k][0] + (n - c[1]) * sw.n[k][1];
          const U = sw.U[k];
          if (u > U[0] || u < U[U.length - 1] || Math.abs(u) >= bd) continue;
          bd = Math.abs(u);
          let j = 0;
          while (j < U.length - 2 && u < U[j + 1]) j++;
          kind = sw.kinds[j];
        }
      }
      (out[state] ??= {})[kind] = (out[state][kind] ?? 0) + 1;
      if ((state === 1 || state === 3 || state === 0) && /lane|parking|curb|transit_row|bike|shoulder/.test(kind) && bad.length < 12) bad.push([Math.round(e), Math.round(n), state]);
    }
    return { byState: out, onCarriageway: bad };
  }

  /** placed-prop pools and counts (diagnostics) */
  propStats() { return this.props?.stats(); }

  /** QA (drawn = driven): every car inside the slice lies on a lane or turning path of its class
   *  (within half a lane + 0.35 m). Returns counts and the worst offenders. */
  agentCheck(maxOff = 2.0) {
    const net = this.net as (PrimNet & { lanes?: { classes: string[]; xyz: number[][] }[]; paths?: { classes: string[]; xyz: number[][] }[] }) | null;
    const tr = (window as unknown as { __traffic?: { snapshot(): { count: number; f: Float32Array; oe: number; on: number } | null } }).__traffic;
    const snap = tr?.snapshot();
    if (!net || !snap || !snap.count) return { cars: 0 };
    const [x0, y0, x1, y1] = net.bbox;
    const segs: number[][] = [];
    for (const l of [...(net.lanes ?? []), ...(net.paths ?? [])]) {
      if (!l.classes.includes('car')) continue;
      for (let k = 0; k < l.xyz.length - 1; k++) segs.push([l.xyz[k][0], l.xyz[k][1], l.xyz[k + 1][0], l.xyz[k + 1][1]]);
    }
    const cell = 25, grid = new Map<number, number[][]>();
    for (const sg of segs) {
      const i0 = Math.floor(Math.min(sg[0], sg[2]) / cell), i1 = Math.floor(Math.max(sg[0], sg[2]) / cell);
      const j0 = Math.floor(Math.min(sg[1], sg[3]) / cell), j1 = Math.floor(Math.max(sg[1], sg[3]) / cell);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = i * 100003 + j; if (!grid.has(k)) grid.set(k, []); grid.get(k)!.push(sg); }
    }
    const stride = snap.f.length / snap.count;
    let inBox = 0, off = 0;
    const worst: number[][] = [];
    for (let c = 0; c < snap.count; c++) {
      const e = snap.f[c * stride] + snap.oe, n = snap.f[c * stride + 1] + snap.on;
      if (e < x0 + 30 || e > x1 - 30 || n < y0 + 30 || n > y1 - 30) continue;
      inBox++;
      let best = Infinity;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        for (const sg of grid.get((Math.floor(e / cell) + di) * 100003 + Math.floor(n / cell) + dj) ?? []) {
          const dx = sg[2] - sg[0], dy = sg[3] - sg[1], l2 = dx * dx + dy * dy || 1;
          const t = Math.max(0, Math.min(1, ((e - sg[0]) * dx + (n - sg[1]) * dy) / l2));
          best = Math.min(best, Math.hypot(e - sg[0] - dx * t, n - sg[1] - dy * t));
        }
      }
      if (best > maxOff) { off++; if (worst.length < 12) worst.push([Math.round(e), Math.round(n), Math.round(best * 10) / 10]); }
    }
    return { cars: snap.count, inBox, off, worst };
  }

  dispose() {
    if (this.mesh) this.mesh.geometry.dispose();
    this.props?.dispose();
    this.engine?.scene.remove(this.group);
  }
}
