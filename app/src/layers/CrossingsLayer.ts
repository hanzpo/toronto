// Railway level crossings (docs/ROADS.md "Level crossings"): masts with
// crossbucks (Transport Canada GCS: 1.22 m x 0.2 m blades at ±45°, white with a
// red border), flasher pairs and a bell housing, cantilever flashers over wide
// roads, and red/white gate arms with lights -- all from data/crossings.json
// (tpipe.roadnet.write_crossings). One instanced draw per part.
//
// Hook (driven by the transit sim from train positions):
//   window.__street.setCrossing(osmNodeId, state)   (also window.__crossings)
//     0 idle (gates up, lights dark) · 1 warning: lights flash, gates lower (8 s)
//     2 gates down, lights flash. Returning to 0 raises the gates (8 s).
import * as THREE from 'three/webgpu';
import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';

interface Approach { heading: number; mast: [number, number]; yaw: number; arm: number; cant: boolean }
export interface Crossing { id: number; e: number; n: number; kind: number; gates: boolean; lights: boolean; roads: number[]; tracks: number[]; approaches: Approach[] }

const RADIUS = 1400;      // m: crossings drawn around the camera
const REBUILD = 200;      // m: camera travel before the active set is recomputed
const GATE_S = 8;         // s: gate lowering / raising time
const CAP = 1024;

function box(w: number, h: number, d: number, x = 0, y = 0, z = 0, rgb = [1, 1, 1]): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  const c = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < c.length; i += 3) { c[i] = rgb[0]; c[i + 1] = rgb[1]; c[i + 2] = rgb[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], nrm: number[] = [], col: number[] = [];
  for (const p of parts) {
    const q = p.index ? p.toNonIndexed() : p;
    pos.push(...(q.attributes.position.array as Float32Array));
    nrm.push(...(q.attributes.normal.array as Float32Array));
    col.push(...(q.attributes.color.array as Float32Array));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

const WHITE = [0.92, 0.92, 0.9], RED = [0.72, 0.08, 0.06], BLACK = [0.05, 0.05, 0.05], GREY = [0.62, 0.62, 0.6];

/** mast (local frame: +x across the road toward the lanes, +y up, +z along the approach) */
function mastGeometry(): THREE.BufferGeometry {
  const parts = [box(0.14, 4.6, 0.14, 0, 2.3, 0, GREY), box(0.5, 0.35, 0.5, 0, 0.17, 0, GREY)];
  // crossbuck: two blades at ±45° (white face, red border as a slightly larger red backing)
  for (const a of [Math.PI / 4, -Math.PI / 4]) {
    for (const [w, h, d, rgb] of [[1.22, 0.2, 0.03, RED], [1.14, 0.13, 0.035, WHITE]] as [number, number, number, number[]][]) {
      const b = box(w, h, d, 0, 0, 0.03, rgb);
      b.rotateZ(a);
      b.translate(0, 3.9, 0.08);
      parts.push(b);
    }
  }
  // flasher cross-arm + two light housings (lenses are a separate instanced mesh) + bell
  parts.push(box(1.05, 0.08, 0.08, 0, 2.75, 0.1, GREY));
  for (const x of [-0.38, 0.38]) parts.push(box(0.34, 0.34, 0.12, x, 2.75, 0.18, BLACK));
  const bell = box(0.22, 0.22, 0.22, 0, 4.72, 0, BLACK);
  parts.push(bell);
  return merge(parts);
}

function armGeometry(): THREE.BufferGeometry {
  // unit-length arm along +x (scaled per instance), red/white 0.4 m-ish stripes (8 segments)
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 8; i++) parts.push(box(1 / 8, 0.09, 0.06, (i + 0.5) / 8, 0, 0, i % 2 ? WHITE : RED));
  return merge(parts);
}

function cantGeometry(): THREE.BufferGeometry {
  // cantilever: vertical post + horizontal arm along +x (unit length, scaled) carrying flashers
  return merge([box(1, 0.18, 0.18, 0.5, 0, 0, GREY)]);
}

export class CrossingsLayer implements Layer {
  readonly id = 'crossings';
  private engine!: Engine;
  private list: Crossing[] = [];
  private byId = new Map<number, Crossing>();
  private state = new Map<number, { s: number; t: number; from: number }>();
  private group = new THREE.Group();
  private masts!: THREE.InstancedMesh;
  private arms!: THREE.InstancedMesh;
  private cants!: THREE.InstancedMesh;
  private lamps!: THREE.InstancedMesh;
  private active: { c: Crossing; a: Approach; z: number }[] = [];
  private last = new THREE.Vector3(1e9, 0, 1e9);
  private anchorVer = -1;
  private time = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private sc = new THREE.Vector3();
  private col = new THREE.Color();

  async init(engine: Engine) {
    this.engine = engine;
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const mk = (g: THREE.BufferGeometry, m: THREE.Material, name: string) => {
      const im = new THREE.InstancedMesh(g, m, CAP);
      im.name = name; im.count = 0; im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(im);
      return im;
    };
    this.masts = mk(mastGeometry(), mat, 'crossingMasts');
    this.arms = mk(armGeometry(), mat, 'crossingGates');
    this.cants = mk(cantGeometry(), mat, 'crossingCantilevers');
    this.lamps = mk(new THREE.BoxGeometry(0.2, 0.2, 0.04), lampMat, 'crossingLamps');
    this.lamps.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3 * 4), 3);
    this.lamps.instanceColor.setUsage(THREE.DynamicDrawUsage);
    engine.scene.add(this.group);
    try {
      const r = await fetch(`${engine.dataRoot}/crossings.json`);
      if (r.ok) {
        const j = await r.json();
        this.list = j.crossings ?? [];
        for (const c of this.list) this.byId.set(c.id, c);
      }
    } catch { /* no crossings file: nothing to draw */ }
    Object.assign(window as object, { __crossings: this });
  }

  /** 0 idle · 1 warning (lights, gates lowering) · 2 gates down */
  setCrossing(osmNodeId: number, st: 0 | 1 | 2) {
    const cur = this.state.get(osmNodeId);
    const from = cur ? this.gateDown(cur) : 0;
    if (cur && cur.s === st) return;
    this.state.set(osmNodeId, { s: st, t: this.time, from });
  }

  /** crossings for the sim: id, position, road / track ways, approach headings */
  crossings(): readonly Crossing[] { return this.list; }

  /** gate lowered fraction 0 (up) .. 1 (down) */
  private gateDown(st: { s: number; t: number; from: number }): number {
    const k = Math.min(1, (this.time - st.t) / GATE_S);
    const target = st.s === 0 ? 0 : 1;
    return st.from + (target - st.from) * (k * k * (3 - 2 * k));
  }

  update(ctx: FrameContext) {
    this.time += ctx.dt ?? 1 / 60;
    // attach the hook to the street layer's global once it exists
    const w = window as unknown as { __street?: { setCrossing?: unknown } };
    if (w.__street && !w.__street.setCrossing) Object.assign(w.__street, { setCrossing: (id: number, s: 0 | 1 | 2) => this.setCrossing(id, s) });
    const cam = ctx.cameraPos;
    const E = cam.x, N = -cam.z;
    const alt = cam.y - this.engine.heightAt(E, N);
    this.group.visible = alt < 900 && this.list.length > 0;
    if (!this.group.visible) return;
    if (Math.hypot(E - this.last.x, N - this.last.z) > REBUILD || this.anchorVer !== ctx.anchor.version) {
      this.last.set(E, 0, N);
      this.anchorVer = ctx.anchor.version;
      this.active = [];
      for (const c of this.list) {
        if (Math.abs(c.e - E) > RADIUS || Math.abs(c.n - N) > RADIUS) continue;
        for (const a of c.approaches) this.active.push({ c, a, z: this.engine.heightAt(a.mast[0], a.mast[1]) });
        if (this.active.length >= CAP - 8) break;
      }
      this.writeStatic(ctx);
    }
    this.writeDynamic(ctx);
  }

  private place(e: number, n: number, z: number, yaw: number, pitch: number, sx: number, ctx: FrameContext) {
    ctx.anchor.toLocal(e, n, z, this.v);
    // local +x -> world direction yaw (CCW from +E); three.js: rotation about +y by yaw (z = -N)
    const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const qp = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), pitch);
    this.q.copy(qy).multiply(qp);
    this.sc.set(sx, 1, 1);
    this.m.compose(this.v, this.q, this.sc);
  }

  private writeStatic(ctx: FrameContext) {
    let nm = 0, nc = 0;
    for (const { c, a, z } of this.active) {
      if (!c.lights && !c.gates && c.kind === 6) continue;
      // mast faces the approaching traffic: its local +x points across the road (a.yaw)
      this.place(a.mast[0], a.mast[1], z, a.yaw, 0, 1, ctx);
      this.masts.setMatrixAt(nm++, this.m);
      if (a.cant && c.lights) {
        this.place(a.mast[0], a.mast[1], z + 5.6, a.yaw, 0, Math.min(a.arm, 9), ctx);
        this.cants.setMatrixAt(nc++, this.m);
      }
    }
    this.masts.count = nm; this.cants.count = nc;
    this.masts.instanceMatrix.needsUpdate = true; this.cants.instanceMatrix.needsUpdate = true;
  }

  private writeDynamic(ctx: FrameContext) {
    let na = 0, nl = 0;
    const flashOn = Math.floor(this.time * 1.1) % 2 === 0; // ~35-65 flashes / min, alternating pair
    for (const { c, a, z } of this.active) {
      const st = this.state.get(c.id);
      const down = st ? this.gateDown(st) : 0;
      const warn = st ? st.s > 0 : false;
      if (c.gates) {
        // pivot 0.5 m off the mast toward the road, 1.0 m up; raised = ~85°
        const pe = a.mast[0] + Math.cos(a.yaw) * 0.45, pn = a.mast[1] + Math.sin(a.yaw) * 0.45;
        this.place(pe, pn, z + 1.0, a.yaw, (1 - down) * 1.48, a.arm, ctx);
        this.arms.setMatrixAt(na++, this.m);
      }
      if (c.lights) {
        const cy = Math.cos(a.yaw), sy = Math.sin(a.yaw);
        // lens pair on the mast cross-arm, facing the approach (-heading)
        const fx = -Math.cos(a.heading) * 0.26, fy = -Math.sin(a.heading) * 0.26;
        for (const [k, off] of [[0, -0.38], [1, 0.38]] as [number, number][]) {
          const on = warn && ((k === 0) === flashOn);
          this.place(a.mast[0] + cy * off + fx, a.mast[1] + sy * off + fy, z + 2.75, a.yaw, 0, 1, ctx);
          this.lamps.setMatrixAt(nl, this.m);
          this.lamps.setColorAt(nl++, this.col.setRGB(on ? 3.0 : 0.18, on ? 0.12 : 0.02, on ? 0.08 : 0.02));
        }
      }
    }
    this.arms.count = na; this.lamps.count = nl;
    this.arms.instanceMatrix.needsUpdate = true; this.lamps.instanceMatrix.needsUpdate = true;
    if (this.lamps.instanceColor) this.lamps.instanceColor.needsUpdate = true;
  }

  dispose() {
    this.group.removeFromParent();
    for (const im of [this.masts, this.arms, this.cants, this.lamps]) { im?.geometry.dispose(); im?.dispose(); }
  }
}
