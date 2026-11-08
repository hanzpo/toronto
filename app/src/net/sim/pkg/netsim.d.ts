/* tslint:disable */
/* eslint-disable */

export class World {
    free(): void;
    [Symbol.dispose](): void;
    count(): number;
    frame(): Float32Array;
    gate(node: number): number;
    constructor(json: string, seed: number);
    populate(cars: number, buses: number, trams: number, trains: number, peds: number): void;
    signal(node: number, group: number): number;
    step(dt: number): void;
    time(): number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_world_free: (a: number, b: number) => void;
    readonly world_count: (a: number) => number;
    readonly world_frame: (a: number) => [number, number];
    readonly world_gate: (a: number, b: number) => number;
    readonly world_new: (a: number, b: number, c: number) => [number, number, number];
    readonly world_populate: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly world_signal: (a: number, b: number, c: number) => number;
    readonly world_step: (a: number, b: number) => void;
    readonly world_time: (a: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
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
