import type { Asset, BandLayout, Mat, PropKind, TrackKind, VClass } from './assets';
import type { Control, NodeDesc, SegDesc } from './desc';
import type { V2 } from './geom';
import type { Path } from './path';
import type { P3 } from './mesh';

export interface LegBand { band: BandLayout['band']; l: number; r: number; hl: number; hr: number }

export interface Leg {
  seg: Seg;
  end: 'a' | 'b';
  node: Node;
  o: V2;
  u: V2;
  n: V2;
  ang: number;
  bands: LegBand[];
  curbL: number;
  curbR: number;
  rowL: number;
  rowR: number;
  setback: number;
  cut: { p: V2; d: V2 } | null;
  tStop: number;
  tExit: number;
  markEnd: number;
  crosswalk: boolean;
  z: number;
  bandT?: number[];
}

export interface Seg {
  desc: SegDesc;
  asset: Asset;
  path: Path;
  lay: BandLayout[];
  legA: Leg;
  legB: Leg;
  dir: 'both' | 'fwd' | 'back';
}

export type NodeKind =
  | 'end' | 'continue' | 'transition' | 'junction' | 'merge' | 'level_crossing' | 'tram_crossing'
  | 'switch' | 'diamond' | 'path_junction' | 'crosswalk' | 'review';

export interface Node {
  desc: NodeDesc;
  p: V2;
  z: number;
  legs: Leg[];
  kind: NodeKind;
  control: Control;
  note?: string;
}

export interface LaneOut {
  id: number;
  kind: 'drive' | 'tram' | 'rail' | 'walk' | 'bike';
  cls: VClass[];
  pts: P3[];
  width: number;
  speed: number;
  seg?: string;
  node?: string;
  next: number[];
  prev: number[];
  bidir: boolean;
  stopLine?: boolean;
  signal?: { node: string; group: number };
  yieldTo?: number[];
  conflicts?: { lane: number; s: number; os: number }[];
  track?: TrackKind;
  gauge?: number;
  crosswalk?: boolean;
  turn?: 'through' | 'right' | 'left' | 'u';
  stopSign?: boolean;
}

export interface PropOut { kind: PropKind; x: number; y: number; z: number; h: number; p?: Record<string, number> }

export interface TrackOut { kind: TrackKind; gauge: number; pts: P3[]; lane: number; flush: boolean; tieLong?: boolean }

export interface LinearOut { kind: 'jersey' | 'fence' | 'guardrail' | 'parapet' | 'handrail'; pts: P3[]; h: number }

export interface SignalPlan { node: string; groups: { lanes: number[]; peds: number[] }[]; green: number; amber: number; allRed: number }

export interface Footprint { pts: P3[]; kind: 'grade' | 'cut' | 'fill' | 'bridge' | 'tunnel' | 'node'; slope: number; wall: boolean }

export interface Review { at: V2; kind: string; note: string }

export interface Built {
  meshes: Map<Mat, { pos: Float32Array; uv: Float32Array; idx: Uint32Array }>;
  props: PropOut[];
  lanes: LaneOut[];
  tracks: TrackOut[];
  linear: LinearOut[];
  signals: SignalPlan[];
  nodes: { id: string; kind: NodeKind; x: number; y: number; z: number; control: Control }[];
  review: Review[];
  terrain?: { x0: number; y0: number; cell: number; nx: number; ny: number; h: Float32Array };
  bounds: { x0: number; y0: number; x1: number; y1: number };
}
