// Shared layout + messages between the TrafficLayer (main thread) and the
// traffic simulation worker (sim.worker.ts → Rust/wasm `Sim`).
//
// SharedArrayBuffer layout (little endian):
//   [0, 512)            global header
//     i32[0]  SEQ       bumped (Atomics) after each published snapshot
//     i32[1]  SLOT      slot index of the latest snapshot (0..2)
//     i32[2]  BUSY      1 while the worker processes a tick (back-pressure)
//     i32[3]  TILES     graph tiles loaded
//     i32[4]  PENDING   graph tiles being fetched
//     i32[5]  SUBSTEPS  sim sub-steps run for the last tick
//     i32[6]  FAST      1 when sim time is being dropped (very high speed-up)
//     i32[7]  ACK       ticks fully processed (main thread keeps one tick in flight)
//     f64[8]  STEP_MS   wasm time for the last tick (step + output), ms
//     f64[9]  STEP_AVG  exponential average of STEP_MS
//     f64[10] TARGET_CARS   f64[11] TARGET_PEDS
//     f64[12..26) PLAYER    [active, e, n, elev, heading, speed, pitch, surface (0 off-road, 1 road, 2 sidewalk), tileX, tileY, edgeIdx, carId, structure, bump]
//     f64[26..30) RAIL      [trains, overlaps (total, must stay 0), authority overruns (total), turnbacks]
//     f64[30..44) RAILP     player train: see Sim.rail_player_state (sim/src/rail.rs)
//     f64[44..47) RAILX     [pull-outs, pull-ins (totals), parked trains]
//     f64[55..58) CARS, PEDS active agents · BOX_STOPPED cars stopped inside a junction box / on a crosswalk
//     f64[58..63) PHASES   average ms per tick of the road sim: [validate+sort+paths+occupancy, car following, lane changes+advance, spawn, pedestrians]
//     f64[63]     OUT_MS   average ms per tick of write_output (render records)
//     f64[54]     RAIL_MS   exponential average of the rail step time per tick (ms)
//     f64[48..54) BUSX      bus spawn results (totals): [placed, unknown pattern, no road, road too far, at link end, no room]
//   then 3 snapshot slots of SLOT_BYTES each:
//     i32[0] carCount · i32[1] pedCount · f64[1] originE · f64[2] originN · f64[3] simMs · i32[8] signalCount
//     i32[9] railCount · i32[10] railPathPoints · i32[11] busCount · f64[6] busPathPoints (as number)
//     +64:             cars  MAX_CARS × CAR_STRIDE f32
//                      [dE, dN, elev, heading, pitch, speed, meta u32, id u32]   (body centre)
//                      meta = kind | colour << 8 | flags << 16 | ground << 24
//                        flags: 1 brake, 2 player, 4 indicator left, 8 indicator right
//                        ground: road class (bits 0-2) | 8 on a bridge / in a tunnel (use elev as is)
//     +64+carBytes:    peds  MAX_PEDS × PED_STRIDE f32
//                      [dE, dN, elev, heading, phase, meta u32]   meta = colour | state << 8 | structure << 16
//     +…+pedBytes:     signals MAX_SIGNALS × SIG_STRIDE f32
//                      [dE, dN, bearing, halfWidth, light]  stop line of a signalised approach
//                      (bearing = travel direction, light 0 green · 1 amber · 2 red)
//     +…+sigBytes:     rail  MAX_RAIL × RAIL_STRIDE f32 (rail agents, sim/src/rail.rs RailSim::write)
//                      [feed, trip, centreDist, speed, accel, flags u32, delay, authorityAhead, pattern, id u32, pathOff, pathN]
//                      feed = index into the 'railFeeds' agency list; trip / pattern = local indices in that
//                      agency's rail file; flags RAIL_FLAG; PENDING records have no position (hide the trip)
//     +…+railBytes:    rail paths MAX_RAIL_PTS × 3 f32: track under each consist, rear → front
//     +…:              buses MAX_BUS × BUS_STRIDE f32 (sim/src/bus.rs World::write_buses)
//                      [trip (global TransitSystem id), frontAlongPattern-len/2, speed, flags u32, delay, length, pathOff, pathN]
//                      flags BUS_FLAG
//     +…:              bus paths MAX_BUS_PTS × 3 f32 (lane path under the bus, rear → front)
// Positions are relative to the slot's origin (the renderer's floating anchor).

export const MAX_CARS = 16384;
export const MAX_PEDS = 16384;
export const CAR_STRIDE = 8;
export const PED_STRIDE = 6;
export const MAX_SIGNALS = 4096;
export const SIG_STRIDE = 5;
/** floats per external obstacle in TickMsg.obst: [e, n, heading, length, width, speed, flags] */
export const OB_STRIDE = 7;
/** obstacle flags */
export const OB_FLAG = { DOORS_KNOWN: 1, DOORS_OPEN: 2, RAIL: 4 } as const;
export const HEADER_BYTES = 512;
export const MAX_RAIL = 1024;
export const RAIL_STRIDE = 12;
export const MAX_RAIL_PTS = 49152;
export const RAIL_FLAG = { DWELL: 1, DOORS: 2, BRAKE: 4, PLAYER: 8, PENALTY: 16, HELD: 32, PENDING: 64, HORN: 128 } as const;
/** m around the focus within which rail trips run as signalled agents */
export const RAIL_RADIUS = 9000;
export const SLOT_HEADER = 64;
export const SLOTS = 3;
export const SIG_OFFSET = SLOT_HEADER + MAX_CARS * CAR_STRIDE * 4 + MAX_PEDS * PED_STRIDE * 4;
export const RAIL_OFFSET = SIG_OFFSET + MAX_SIGNALS * SIG_STRIDE * 4;
export const RAIL_PATH_OFFSET = RAIL_OFFSET + MAX_RAIL * RAIL_STRIDE * 4;
export const MAX_BUS = 2048;
export const BUS_STRIDE = 8;
export const MAX_BUS_PTS = 32768;
export const BUS_FLAG = { DWELL: 1, DOORS: 2, BRAKE: 4, NIS: 8 } as const;
export const BUS_OFFSET = RAIL_PATH_OFFSET + MAX_RAIL_PTS * 3 * 4;
export const BUS_PATH_OFFSET = BUS_OFFSET + MAX_BUS * BUS_STRIDE * 4;
export const SLOT_BYTES = BUS_PATH_OFFSET + MAX_BUS_PTS * 3 * 4;
export const SAB_BYTES = HEADER_BYTES + SLOTS * SLOT_BYTES;

export const H = { SEQ: 0, SLOT: 1, BUSY: 2, TILES: 3, PENDING: 4, SUBSTEPS: 5, FAST: 6, ACK: 7 } as const;
export const HF = { STEP_MS: 8, STEP_AVG: 9, TARGET_CARS: 10, TARGET_PEDS: 11, PLAYER: 12, RAIL: 26, RAILP: 30, RAILX: 44, BUSX: 48, RAIL_MS: 54, CARS: 55, PEDS: 56, BOX_STOPPED: 57, PHASES: 58, OUT_MS: 63 } as const;
export const HF_COUNT = 64;
/** RAILP fields */
export const RAILP = { ACTIVE: 0, FEED: 1, TRIP: 2, CENTRE: 3, V: 4, A: 5, AHEAD: 6, ASPECT: 7, PENALTY: 8, LIMIT: 9, NEXT_LIMIT: 10, NEXT_LIMIT_DIST: 11, PATTERN: 12, WARN: 13 } as const;

/** order of the counts in the 'overlaps' message (sim World::overlap_causes) */
export const OVERLAP_CAUSES = ['spawn', 'laneChange', 'shortLink', 'junctionCrossing', 'sameLane', 'adjacentLanes', 'merge', 'other', 'junctionFollowing', 'structureVsStreet'] as const;

export const CAR_FLAG = { BRAKE: 1, PLAYER: 2, LEFT: 4, RIGHT: 8, HORN: 32 } as const;
export const PED_STATE = { WALK: 0, WAIT: 1, CROSS: 2, IDLE: 3 } as const;

export interface TickMsg {
  type: 'tick';
  simMs: number;
  /** Toronto seconds since midnight */
  tod: number;
  weekday: number;
  /** sim seconds to advance */
  simDt: number;
  /** real seconds (player physics) */
  realDt: number;
  focusE: number;
  focusN: number;
  /** car radius (m); 0 = sim suspended (too high) */
  radius: number;
  pedRadius: number;
  originE: number;
  originN: number;
  player?: { throttle: number; brake: number; steer: number; handbrake: boolean; groundZ: number };
  /** the walking player [E, N, elevation, body radius]: AI cars brake and honk for them */
  walker?: [number, number, number, number];
  /** surface transit near the focus as moving obstacles (OB_STRIDE floats each), or absent */
  obst?: Float64Array;
  /** transit service profile the renderer shows (rail agents follow the same timetable) */
  railProfile?: 'weekday' | 'saturday' | 'sunday';
  /** rail agent radius (m, 0 = off) */
  railRadius?: number;
  /** camera position + horizontal forward (E, N) — rail spawns / removals avoid the view */
  camera?: [number, number, number, number];
  /** bus patterns first needed by `busSpawn` (sent once per pattern) */
  busPatterns?: { id: number; xy: Float64Array; stopD: Float32Array; stopFlag: Uint8Array }[];
  /** bus trips to place as agents at their scheduled positions */
  busSpawn?: { trip: number; pat: number; len: number; front: number; v: number; arr: Float64Array; dep: Float64Array }[];
  /** first trips of bus blocks leaving a garage (gx, gy) */
  busPullout?: { trip: number; pat: number; len: number; arr: Float64Array; dep: Float64Array; gx: number; gy: number }[];
  /** out-of-service buses whose block is over drive to a garage (gx, gy) */
  busPullin?: { trip: number; gx: number; gy: number }[];
  /** buses whose trip ended continue as the next trip of their block */
  busRetrip?: { old: number; trip: number; pat: number; arr: Float64Array; dep: Float64Array }[];
  /** player train command (-1 brake .. 1 power) */
  railCmd?: { cmd: number; emergency: boolean };
}

export type ToWorker =
  | { type: 'init'; sab: SharedArrayBuffer; dataRoot: string; build: number; tiles: [number, number][] }
  | TickMsg
  | { type: 'stops'; xyz: Float64Array }
  | { type: 'spawnPlayer'; e: number; n: number; heading: number }
  | { type: 'takeOver'; id: number }
  | { type: 'releasePlayer' }
  /** the player takes this pedestrian's place: remove the one nearest (e, n) */
  | { type: 'removePed'; e: number; n: number }
  | { type: 'majors' }
  | { type: 'railPlayer'; feed: number; trip: number }
  | { type: 'railRelease' }
  | { type: 'congestion'; tod: number; weekday: number };

export type FromWorker =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'player'; roadName: string | null; ok?: boolean }
  /** player car effects since the last tick: curb jolt / collision impulse (m/s across), surface (0 off-road, 1 road, 2 sidewalk) */
  | { type: 'playerFx'; curb: number; hit: number; surface: number }
  | { type: 'majorsGeom'; off: Uint32Array; xyz: Float32Array; cls: Uint8Array; names: string[]; name: Uint16Array }
  | { type: 'majorsRatio'; ratio: Uint8Array; tod: number }
  /** rail feeds loaded for agents: feed id = index, agency ids */
  | { type: 'railFeeds'; profile: string; agencies: string[] }
  | { type: 'railPlayer'; ok: boolean }
  /** level crossings whose state changed: [osmNodeId, state (0 idle, 1 warning, 2 gates down)]* */
  | { type: 'crossings'; data: Float64Array }
  /** QA: overlapping car bodies by cause (OVERLAP_CAUSES order), every ~2 s */
  | { type: 'overlaps'; counts: number[] }
  /** signal plans of the loaded graph: [osmId, e, n, offset, axis, greenA, greenB]* */
  | { type: 'plans'; plans: Float64Array };

/**
 * Extra peak load of known bottleneck corridors, by road name (0 = none).
 * Used by the demand model for local agent density and the region-wide
 * congestion estimate.
 */
export function bottleneckOf(name: string | null | undefined): number {
  if (!name) return 0;
  const n = name.toLowerCase();
  if (n.includes('don valley')) return 1.2;
  if (n.includes('gardiner')) return 1.15;
  if (/\b401\b/.test(n) && n.includes('collector')) return 1.0;
  if (/\b401\b/.test(n) && n.includes('express')) return 0.9;
  if (/\b401\b/.test(n) || n.includes('macdonald')) return 1.0;
  if (n.includes('queen elizabeth') || /\bqew\b/.test(n)) return 0.95;
  if (/\b404\b/.test(n)) return 0.9;
  if (/\b427\b/.test(n)) return 0.85;
  if (n.includes('allen')) return 0.8;
  if (/\b400\b/.test(n) || /\b410\b/.test(n) || /\b403\b/.test(n)) return 0.6;
  if (n.includes('lake shore') || n.includes('lakeshore')) return 0.5;
  if (/\b407\b/.test(n)) return 0.1;
  return 0;
}
