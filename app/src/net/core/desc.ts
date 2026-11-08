import type { V2 } from './geom';

export type Control = 'auto' | 'signal' | 'stop' | 'allstop' | 'yield' | 'none';

export interface NodeDesc {
  id: string;
  x: number;
  y: number;
  z: number;
  control?: Control;
  tram?: [string, string][];
  rail?: [string, string][];
}

export type VariantKind = 'auto' | 'grade' | 'bridge' | 'tunnel' | 'wall';

export interface EventDesc {
  kind: 'bus_stop' | 'tram_stop' | 'crosswalk' | 'taper' | 'rail_signal';
  s: number;
  s1?: number;
  side?: 1 | -1;
  band?: number;
}

export interface SegDesc {
  id: string;
  asset: string;
  a: string;
  b: string;
  pts?: V2[];
  curve?: 'fillet' | 'hermite' | 'raw';
  r?: number;
  ta?: V2;
  tb?: V2;
  z?: { s: number; z: number }[];
  variant?: { s0: number; s1: number; kind: VariantKind }[];
  events?: EventDesc[];
  dir?: 'both' | 'fwd' | 'back';
  offA?: number;
  offB?: number;
  corridor?: string;
  name?: string;
}

export interface TerrainDesc {
  x0: number;
  y0: number;
  cell: number;
  nx: number;
  ny: number;
  h: Float32Array;
}

export interface NetDesc {
  nodes: NodeDesc[];
  segments: SegDesc[];
  terrain?: TerrainDesc;
}

export class NetBuilder {
  nodes: NodeDesc[] = [];
  segments: SegDesc[] = [];
  private n = 0;

  node(x: number, y: number, z = 0, opts: Partial<NodeDesc> = {}): string {
    const id = opts.id ?? `n${this.n++}`;
    this.nodes.push({ id, x, y, z, ...opts });
    return id;
  }

  seg(asset: string, a: string, b: string, opts: Partial<SegDesc> = {}): string {
    const id = opts.id ?? `s${this.segments.length}`;
    this.segments.push({ id, asset, a, b, ...opts });
    return id;
  }

  get(id: string) {
    const n = this.nodes.find((q) => q.id === id);
    if (!n) throw new Error(id);
    return n;
  }

  desc(terrain?: TerrainDesc): NetDesc {
    return { nodes: this.nodes, segments: this.segments, terrain };
  }
}
