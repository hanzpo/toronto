// Curated station data (app/public/data/stations.json, written by
// `pipeline: uv run python -m tpipe.stations build` from
// pipeline/curated/stations.json — see docs/STATIONS.md). World E/N metres.
import type { Mode, StationMeta, TransitIndex } from '../../transit';
import type { StructureSpec } from './allen';

export type RailMode = 'subway' | 'lrt' | 'commuter_rail' | 'airport_rail' | 'intercity_rail';
export const RAIL_MODES: RailMode[] = ['subway', 'lrt', 'commuter_rail', 'airport_rail', 'intercity_rail'];
export const HEAVY = new Set<Mode>(['commuter_rail', 'airport_rail', 'intercity_rail']);

export type Grade = 'underground' | 'at-grade' | 'elevated' | 'trench';

export interface PlatRec {
  type: 'island' | 'side';
  /** centre E, N */
  c: [number, number];
  /** compass bearing of the platform axis (deg, 0–180) */
  b: number;
  len: number;
  /** full curated length (len = straight part fitted to the track, for QA) */
  lenFull?: number;
  w: number;
}

export interface LevelRec {
  mode: RailMode;
  line?: string;
  grade: Grade;
  layout: string;
  c: [number, number];
  bearing: number;
  len: number;
  tracks: number;
  /** platform top above rail (m) */
  h: number;
  /** rail below surface (m), underground levels */
  depth?: number;
  elevation?: number;
  /** 0 = upper … for stacked stations */
  level_order?: number;
  wall?: string;
  canopy_len?: number;
  /** platforms/canopies modelled by this landmark instead (e.g. union_station) */
  landmark?: string;
  /** Allen Road median station structure (enclosure, roof, concourse), see ./allen.ts */
  structure?: StructureSpec;
  plats: PlatRec[];
}

export interface EntRec {
  p: [number, number];
  k: 'pavilion' | 'stair' | 'building' | 'path' | 'elevator' | 'underground';
  b?: number;
  name?: string;
}

export interface BldRec { k: string; c: [number, number]; l: number; w: number; h: number; b: number }
export interface BusRec { c: [number, number]; l: number; w: number; b: number; bays: number }

export interface StationRec {
  id: string;
  name: string;
  /** transit index station ids (routes / badges come from there) */
  ids: string[];
  c: [number, number];
  /** label importance 1 (LRT stop) … 3 (major interchange / terminal) */
  rank: number;
  levels: LevelRec[];
  ents: EntRec[];
  blds: BldRec[];
  bus: BusRec[];
}

export async function loadStations(root: string): Promise<StationRec[] | null> {
  try {
    const r = await fetch(`${root}/stations.json`);
    if (!r.ok) return null;
    const j = (await r.json()) as { version: number; stations: StationRec[] };
    return j.stations;
  } catch {
    return null;
  }
}

const DEF: Record<RailMode, { len: number; h: number; layout: string }> = {
  subway: { len: 152, h: 1.05, layout: 'island' },
  lrt: { len: 90, h: 0.35, layout: 'side' },
  commuter_rail: { len: 310, h: 0.8, layout: 'side' },
  airport_rail: { len: 100, h: 1.05, layout: 'island' },
  intercity_rail: { len: 250, h: 0.8, layout: 'side' },
};

/** Stand-in records when stations.json is missing: one level per mode, platforms from the tracks. */
export function fallbackStations(index: TransitIndex): StationRec[] {
  const out: StationRec[] = [];
  for (const s of index.stations) {
    const modes = s.modes.filter((m): m is RailMode => (RAIL_MODES as Mode[]).includes(m));
    if (!modes.length) continue;
    out.push({
      id: s.id, name: s.name, ids: [s.id], c: [s.pos[0], s.pos[1]], rank: modes.includes('lrt') && modes.length === 1 ? 1 : 2,
      levels: modes.map((m) => ({ mode: m, grade: m === 'subway' ? 'underground' : 'at-grade', layout: DEF[m].layout, c: [s.pos[0], s.pos[1]], bearing: 0, len: DEF[m].len, tracks: 2, h: DEF[m].h, plats: [] })),
      ents: [], blds: [], bus: [],
    });
  }
  return out;
}

export function stationIndexMap(index: TransitIndex): Map<string, StationMeta> {
  return new Map(index.stations.map((s) => [s.id, s]));
}
