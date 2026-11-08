/* tslint:disable */
/* eslint-disable */

export class World {
    free(): void;
    [Symbol.dispose](): void;
    add_trip(kind: number, variant: number, trip: number, lanes: Uint32Array | number[], dirs: Int8Array | number[], d: number, v: number, stop_step: Uint32Array | number[], stop_d: Float32Array | number[], stop_dep: Float64Array | number[]): boolean;
    clear_walker(): void;
    clock(): number;
    count(): number;
    frame(): Float32Array;
    gate(node: number): number;
    has_trip(trip: number): boolean;
    constructor(json: string, seed: number);
    player(): Float32Array;
    populate(cars: number, buses: number, trams: number, trains: number, peds: number): void;
    release_player(): void;
    set_clock(service_seconds: number): void;
    set_player_input(throttle: number, brake: number, steer: number, handbrake: boolean, ground: number): void;
    set_walker(x: number, y: number, z: number): void;
    signal(node: number, group: number): number;
    solids_near(x: number, y: number, r: number): Float32Array;
    step(dt: number): void;
    take_done(): Uint32Array;
    take_over_nearest(x: number, y: number, r: number): boolean;
    time(): number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_world_free: (a: number, b: number) => void;
    readonly world_add_trip: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number) => number;
    readonly world_clear_walker: (a: number) => void;
    readonly world_clock: (a: number) => number;
    readonly world_count: (a: number) => number;
    readonly world_frame: (a: number) => [number, number];
    readonly world_gate: (a: number, b: number) => number;
    readonly world_has_trip: (a: number, b: number) => number;
    readonly world_new: (a: number, b: number, c: number) => [number, number, number];
    readonly world_player: (a: number) => [number, number];
    readonly world_populate: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly world_release_player: (a: number) => void;
    readonly world_set_clock: (a: number, b: number) => void;
    readonly world_set_player_input: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly world_set_walker: (a: number, b: number, c: number, d: number) => void;
    readonly world_signal: (a: number, b: number, c: number) => number;
    readonly world_solids_near: (a: number, b: number, c: number, d: number) => [number, number];
    readonly world_step: (a: number, b: number) => void;
    readonly world_take_done: (a: number) => [number, number];
    readonly world_take_over_nearest: (a: number, b: number, c: number, d: number) => number;
    readonly world_time: (a: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
