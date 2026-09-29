// Decoding of transit TBN1 files ({agency}_{profile}_{rail|bus}.bin.gz). See docs/TRANSIT.md.

import { decodeTbn, type TypedArray } from '../data/tbn.ts';

export const MODES = ['subway', 'lrt', 'streetcar', 'commuter_rail', 'airport_rail', 'intercity_rail', 'bus'] as const;
export type Mode = (typeof MODES)[number];
/** Numeric mode ids (index into MODES). */
export const MODE_ID: Record<Mode, number> = {
  subway: 0, lrt: 1, streetcar: 2, commuter_rail: 3, airport_rail: 4, intercity_rail: 5, bus: 6,
};
export const RAIL_MODES: readonly Mode[] = MODES.slice(0, 6);

export type Profile = 'weekday' | 'saturday' | 'sunday';

export interface RouteMeta {
  id: string; // "{agency}:{route_id}"
  agency: string;
  short: string;
  long: string;
  mode: Mode;
  color: string; // "#RRGGBB"
  textColor: string;
}

export interface StationMeta {
  id: string;
  name: string;
  agency: string;
  pos: [number, number];
  modes: Mode[];
  routes: string[];
}

export interface FileMeta {
  file: string;
  bytes: number;
  trips: number;
  patterns: number;
  shapes: number;
  stops: number;
  vertices: number;
}

export interface AgencyMeta {
  id: string;
  name: string;
  profiles: Partial<Record<Profile, { date: string; files: { rail?: FileMeta; bus?: FileMeta } }>>;
}

export interface TransitIndex {
  version: number;
  generated: string;
  modes: Mode[];
  profiles: Profile[];
  agencies: AgencyMeta[];
  routes: RouteMeta[];
  stations: StationMeta[];
}

interface FeedHeader {
  version: number;
  agency: string;
  profile: Profile;
  date: string;
  kind: 'rail' | 'bus';
  modes: Mode[];
  routes: RouteMeta[];
  headsigns: string[];
  stopIds: string[];
  stopNames: string[];
  stopParents: string[];
  tripNames?: string[];
  maxDuration: number;
}

/** One decoded file. Index arrays may be Uint16Array or Uint32Array. */
export interface TransitFeed {
  agency: string;
  profile: Profile;
  date: string;
  kind: 'rail' | 'bus';
  routes: RouteMeta[];
  headsigns: string[];
  stopIds: string[];
  stopNames: string[];
  stopParents: string[];
  tripNames: string[] | null;
  maxDuration: number;

  stopXYZ: Float32Array;
  shapeOff: Uint32Array;
  shapeXYZ: Float32Array;
  /** cumulative distance along each shape, per vertex (starts at 0 for each shape) */
  shapeDist: Float32Array;
  patRoute: TypedArray;
  patShape: TypedArray;
  patMode: Uint8Array;
  patDir: Uint8Array;
  patHeadsign: TypedArray;
  patStopOff: Uint32Array;
  patStop: TypedArray;
  patStopDist: Float32Array;
  patStopFlag: Uint8Array;
  tpOff: Uint32Array;
  tpArr: Uint16Array;
  /** departure offsets (arr + dwell), expanded on load */
  tpDep: Uint16Array;
  tripStart: Int32Array;
  tripEnd: Int32Array;
  tripPattern: TypedArray;
  tripTp: TypedArray;
  maxEnd: number;
}

export function decodeFeed(buf: ArrayBuffer): TransitFeed {
  const { header, arrays: a } = decodeTbn<FeedHeader>(buf);
  const shapeOff = a.shape_off as Uint32Array;
  const shapeXYZ = a.shape_xyz as Float32Array;
  const nS = shapeOff.length - 1;
  const shapeDist = new Float32Array(shapeXYZ.length / 3);
  for (let s = 0; s < nS; s++) {
    let d = 0;
    const a0 = shapeOff[s], a1 = shapeOff[s + 1];
    shapeDist[a0] = 0;
    for (let v = a0 + 1; v < a1; v++) {
      const dx = shapeXYZ[3 * v] - shapeXYZ[3 * v - 3];
      const dy = shapeXYZ[3 * v + 1] - shapeXYZ[3 * v - 2];
      d += Math.sqrt(dx * dx + dy * dy);
      shapeDist[v] = d;
    }
  }
  const tpOff = a.tp_off as Uint32Array;
  const tpArr = a.tp_arr as Uint16Array;
  const tpDwell = a.tp_dwell as Uint16Array;
  const tpDep = new Uint16Array(tpArr.length);
  for (let i = 0; i < tpArr.length; i++) tpDep[i] = tpArr[i] + tpDwell[i];
  const tripStart = a.trip_start as Int32Array;
  const tripTp = a.trip_tp;
  const tripEnd = new Int32Array(tripStart.length);
  let maxEnd = 0;
  for (let i = 0; i < tripStart.length; i++) {
    const tp = tripTp[i];
    const e = tripStart[i] + tpArr[tpOff[tp + 1] - 1];
    tripEnd[i] = e;
    if (e > maxEnd) maxEnd = e;
  }
  return {
    agency: header.agency,
    profile: header.profile,
    date: header.date,
    kind: header.kind,
    routes: header.routes,
    headsigns: header.headsigns,
    stopIds: header.stopIds,
    stopNames: header.stopNames,
    stopParents: header.stopParents,
    tripNames: header.tripNames ?? null,
    maxDuration: header.maxDuration,
    stopXYZ: a.stop_xyz as Float32Array,
    shapeOff,
    shapeXYZ,
    shapeDist,
    patRoute: a.pat_route,
    patShape: a.pat_shape,
    patMode: a.pat_mode as Uint8Array,
    patDir: a.pat_dir as Uint8Array,
    patHeadsign: a.pat_headsign,
    patStopOff: a.pat_stop_off as Uint32Array,
    patStop: a.pat_stop,
    patStopDist: a.pat_stop_dist as Float32Array,
    patStopFlag: a.pat_stop_flag as Uint8Array,
    tpOff,
    tpArr,
    tpDep,
    tripStart,
    tripEnd,
    tripPattern: a.trip_pattern,
    tripTp,
    maxEnd,
  };
}
