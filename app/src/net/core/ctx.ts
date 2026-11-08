import type { NetDesc } from './desc';
import { Sink, type P3 } from './mesh';
import type { Built, Footprint, Leg, LaneOut, LinearOut, Node, PropOut, Review, Seg, SignalPlan, TrackOut } from './model';
import type { LaneDef } from './assets';

export interface LegLane { lane: LaneOut; lat: number; inbound: boolean; def: LaneDef; w: number }

export interface Variant { s0: number; s1: number; kind: 'grade' | 'bridge' | 'tunnel' | 'wall' }

export class Ctx {
  sink = new Sink();
  props: PropOut[] = [];
  lanes: LaneOut[] = [];
  tracks: TrackOut[] = [];
  linear: LinearOut[] = [];
  signals: SignalPlan[] = [];
  review: Review[] = [];
  footprints: Footprint[] = [];
  segs: Seg[] = [];
  nodes: Node[] = [];
  legLanes = new Map<Leg, LegLane[]>();
  variants = new Map<Seg, Variant[]>();
  terrainOut: Built['terrain'];
  desc: NetDesc;
  constructor(desc: NetDesc) { this.desc = desc; }

  lane(l: Omit<LaneOut, 'id' | 'next' | 'prev'>): LaneOut {
    const out: LaneOut = { ...l, id: this.lanes.length, next: [], prev: [] };
    this.lanes.push(out);
    return out;
  }

  link(a: LaneOut, b: LaneOut) {
    if (!a.next.includes(b.id)) a.next.push(b.id);
    if (!b.prev.includes(a.id)) b.prev.push(a.id);
  }

  terrainAt(x: number, y: number): number | null {
    const t = this.desc.terrain;
    if (!t) return null;
    const fx = (x - t.x0) / t.cell, fy = (y - t.y0) / t.cell;
    const i = Math.max(0, Math.min(t.nx - 2, Math.floor(fx))), j = Math.max(0, Math.min(t.ny - 2, Math.floor(fy)));
    const u = Math.max(0, Math.min(1, fx - i)), v = Math.max(0, Math.min(1, fy - j));
    const h = t.h, nx = t.nx;
    const a = h[j * nx + i], b = h[j * nx + i + 1], c = h[(j + 1) * nx + i], d = h[(j + 1) * nx + i + 1];
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
  }

  prop(kind: PropOut['kind'], p: P3, h: number, extra?: Record<string, number>) {
    this.props.push({ kind, x: p.x, y: p.y, z: p.z, h, p: extra });
  }

  finish(): Built {
    const meshes: Built['meshes'] = new Map();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [m, b] of this.sink.bufs) {
      if (!b.idx.length) continue;
      meshes.set(m, { pos: new Float32Array(b.pos), uv: new Float32Array(b.uv), idx: new Uint32Array(b.idx) });
      for (let i = 0; i < b.pos.length; i += 3) {
        x0 = Math.min(x0, b.pos[i]); x1 = Math.max(x1, b.pos[i]);
        y0 = Math.min(y0, b.pos[i + 1]); y1 = Math.max(y1, b.pos[i + 1]);
      }
    }
    return {
      meshes, props: this.props, lanes: this.lanes, tracks: this.tracks, linear: this.linear, signals: this.signals,
      nodes: this.nodes.map((n) => ({ id: n.desc.id, kind: n.kind, x: n.p.x, y: n.p.y, z: n.z, control: n.control })),
      review: this.review, terrain: this.terrainOut, bounds: { x0, y0, x1, y1 },
    };
  }
}
