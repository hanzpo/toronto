// Shared layout + messages between the TrafficLayer (main thread) and the
// traffic simulation worker (sim.worker.ts → Rust/wasm `Sim`).
//
// SharedArrayBuffer layout (little endian):
//   [0, 256)            global header
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
//     f64[12..26) PLAYER    [active, e, n, elev, heading, speed, pitch, onRoad, tileX, tileY, edgeIdx, carId, structure, bump]
//   then 3 snapshot slots of SLOT_BYTES each:
//     i32[0] carCount · i32[1] pedCount · f64[1] originE · f64[2] originN · f64[3] simMs · i32[8] signalCount
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
export const HEADER_BYTES = 256;
export const SLOT_HEADER = 64;
export const SLOTS = 3;
export const SLOT_BYTES = SLOT_HEADER + MAX_CARS * CAR_STRIDE * 4 + MAX_PEDS * PED_STRIDE * 4 + MAX_SIGNALS * SIG_STRIDE * 4;
export const SIG_OFFSET = SLOT_HEADER + MAX_CARS * CAR_STRIDE * 4 + MAX_PEDS * PED_STRIDE * 4;
export const SAB_BYTES = HEADER_BYTES + SLOTS * SLOT_BYTES;

export const H = { SEQ: 0, SLOT: 1, BUSY: 2, TILES: 3, PENDING: 4, SUBSTEPS: 5, FAST: 6, ACK: 7 } as const;
export const HF = { STEP_MS: 8, STEP_AVG: 9, TARGET_CARS: 10, TARGET_PEDS: 11, PLAYER: 12 } as const;

export const CAR_FLAG = { BRAKE: 1, PLAYER: 2, LEFT: 4, RIGHT: 8 } as const;
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
  /** surface transit near the focus as moving obstacles (OB_STRIDE floats each), or absent */
  obst?: Float64Array;
}

export type ToWorker =
  | { type: 'init'; sab: SharedArrayBuffer; dataRoot: string; build: number; tiles: [number, number][] }
  | TickMsg
  | { type: 'stops'; xyz: Float64Array }
  | { type: 'spawnPlayer'; e: number; n: number; heading: number }
  | { type: 'takeOver'; id: number }
  | { type: 'releasePlayer' }
  | { type: 'majors' }
  | { type: 'congestion'; tod: number; weekday: number };

export type FromWorker =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'player'; roadName: string | null; ok?: boolean }
  | { type: 'majorsGeom'; off: Uint32Array; xyz: Float32Array; cls: Uint8Array; names: string[]; name: Uint16Array }
  | { type: 'majorsRatio'; ratio: Uint8Array; tod: number }
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
