/* tslint:disable */
/* eslint-disable */

export class Sim {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Building outlines of a level-0 tile for player collisions:
     * `ring_off` [n+1] into `xy` (world E/N pairs).
     */
    add_footprints(tx: number, ty: number, ring_off: Uint32Array, xy: Float32Array): void;
    add_tile(tx: number, ty: number, n_id: Float64Array, n_xyz: Float32Array, n_flags: Uint8Array, e_from: Uint32Array, e_to: Uint32Array, e_off: Uint32Array, e_xyz: Float32Array, e_class: Uint8Array, e_lanes_fwd: Uint8Array, e_lanes_bwd: Uint8Array, e_speed: Float32Array, e_flags: Uint8Array, bottleneck: Float32Array, e_width: Float32Array, e_side: Uint8Array): void;
    car_count(): number;
    car_ptr(): number;
    /**
     * loaded footprint tiles, flat [tx, ty, ...]
     */
    footprint_tiles(): Int32Array;
    /**
     * bumps whenever the loaded road graph changes
     */
    graph_version(): number;
    has_footprints(tx: number, ty: number): boolean;
    has_tile(tx: number, ty: number): boolean;
    /**
     * speed ratio (0..255 = 0..1) per major segment at a time
     */
    major_ratios(tod: number, weekday: number): Uint8Array;
    /**
     * measured speed ratios of local major links: [tx, ty, edgeIdx, ratio]*
     */
    measured(): Float32Array;
    constructor(seed: number, max_cars: number, max_peds: number);
    ped_count(): number;
    ped_ptr(): number;
    /**
     * [active, e, n, elev, heading, speed, pitch, onRoad, tileX, tileY, edgeIdx, carId, structure, bump]
     */
    player_state(): Float64Array;
    player_step(dt: number, throttle: number, brake: number, steer: number, handbrake: boolean, ground_z: number): void;
    /**
     * one agency's rail timetable (transit rail file of the current profile)
     */
    rail_add_feed(id: number, pat_mode: Uint8Array, pat_len: Float32Array, pat_rflags: Uint8Array, pat_rstart: Float32Array, pat_redge_off: Uint32Array, pat_redge: Uint32Array, pat_stop_off: Uint32Array, pat_stop_dist: Float32Array, pat_stop_flag: Uint8Array, tp_off: Uint32Array, tp_arr: Uint16Array, tp_dwell: Uint16Array, trip_start: Int32Array, trip_pattern: Uint32Array, trip_tp: Uint32Array, trip_next: Int32Array): void;
    rail_clear_feeds(): void;
    rail_count(): number;
    /**
     * is the player driving a train?
     */
    rail_has_player(): boolean;
    rail_network(n_xyz: Float32Array, n_flags: Uint8Array, e_from: Uint32Array, e_to: Uint32Array, e_off: Uint32Array, e_xyz: Float32Array, e_vlim: Uint8Array, e_len: Float32Array, e_kind: Uint8Array, e_svc: Uint8Array, e_dir: Uint8Array, e_flags: Uint8Array, c_off: Uint32Array, c_to: Uint32Array): void;
    rail_path_len(): number;
    rail_path_ptr(): number;
    rail_player_attach(feed: number, trip: number): boolean;
    /**
     * cmd -1 (full brake) .. 1 (full power)
     */
    rail_player_input(cmd: number, emergency: boolean): void;
    rail_player_release(): void;
    /**
     * see RailSim::player_state
     */
    rail_player_state(): Float64Array;
    rail_ptr(): number;
    /**
     * drop all agents (the timetable takes over), e.g. while sim time is being dropped
     */
    rail_reset(): void;
    /**
     * radius (m) around the focus within which rail trips run as agents; 0 = off
     */
    rail_set_radius(r: number): void;
    /**
     * [trains, overlaps (total), authority overruns (total), turnbacks]
     */
    rail_stats(): Float64Array;
    /**
     * advance the rail agents by `dt` s ending at time-of-day `tod` (independent of the
     * road sim so trains keep up at high clock rates)
     */
    rail_step(dt: number, tod: number): void;
    release_player(): void;
    remove_footprints(tx: number, ty: number): void;
    remove_tile(tx: number, ty: number): void;
    set_fast(fast: boolean): void;
    /**
     * `geo` = per segment [midE, midN, dirE, dirN] (unit direction)
     */
    set_majors(_class: Uint8Array, flags: Uint8Array, bottleneck: Float32Array, geo: Float32Array): void;
    /**
     * External moving obstacles (surface transit), replacing the previous set:
     * [e, n, heading, length, width, speed, flags]* with a front-centre pose.
     * flags: 1 doors state known, 2 doors open, 4 rail vehicle (streetcar / LRT).
     */
    set_obstacles(data: Float64Array): void;
    /**
     * transit stop positions, flat [E, N, elev, …]
     */
    set_stops(xyz: Float64Array): void;
    /**
     * Toronto seconds since local midnight + weekday (0 = Sunday)
     */
    set_time(tod: number, weekday: number): void;
    /**
     * focus point (world E/N), car radius and pedestrian radius (m)
     */
    set_view(e: number, n: number, radius: number, ped_radius: number): void;
    /**
     * signalised approaches: [dE, dN, bearing, halfWidth, light]* (light 0 green, 1 amber, 2 red)
     */
    signal_count(): number;
    /**
     * fixed-time plans of all loaded signal nodes: [osmId, x, y, offset, axis, greenA, greenB]*
     */
    signal_plans(): Float64Array;
    signal_ptr(): number;
    spawn_player(e: number, n: number, heading: number): boolean;
    /**
     * [target cars, target peds, cars, peds, live links, tiles]
     */
    stats(): Float32Array;
    step(dt: number): void;
    take_over(id: number): boolean;
    tile_count(): number;
    /**
     * write render records relative to (origin_e, origin_n)
     */
    write_output(origin_e: number, origin_n: number): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_sim_free: (a: number, b: number) => void;
    readonly sim_add_footprints: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly sim_add_tile: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number, a1: number, b1: number, c1: number, d1: number, e1: number, f1: number, g1: number) => void;
    readonly sim_car_count: (a: number) => number;
    readonly sim_car_ptr: (a: number) => number;
    readonly sim_footprint_tiles: (a: number) => [number, number];
    readonly sim_graph_version: (a: number) => number;
    readonly sim_has_footprints: (a: number, b: number, c: number) => number;
    readonly sim_has_tile: (a: number, b: number, c: number) => number;
    readonly sim_major_ratios: (a: number, b: number, c: number) => [number, number];
    readonly sim_measured: (a: number) => [number, number];
    readonly sim_new: (a: number, b: number, c: number) => number;
    readonly sim_ped_count: (a: number) => number;
    readonly sim_ped_ptr: (a: number) => number;
    readonly sim_player_state: (a: number) => [number, number];
    readonly sim_player_step: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly sim_rail_add_feed: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number, a1: number, b1: number, c1: number, d1: number, e1: number, f1: number, g1: number, h1: number) => void;
    readonly sim_rail_clear_feeds: (a: number) => void;
    readonly sim_rail_count: (a: number) => number;
    readonly sim_rail_has_player: (a: number) => number;
    readonly sim_rail_network: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number, a1: number, b1: number, c1: number) => void;
    readonly sim_rail_path_len: (a: number) => number;
    readonly sim_rail_path_ptr: (a: number) => number;
    readonly sim_rail_player_attach: (a: number, b: number, c: number) => number;
    readonly sim_rail_player_input: (a: number, b: number, c: number) => void;
    readonly sim_rail_player_release: (a: number) => void;
    readonly sim_rail_player_state: (a: number) => [number, number];
    readonly sim_rail_ptr: (a: number) => number;
    readonly sim_rail_reset: (a: number) => void;
    readonly sim_rail_set_radius: (a: number, b: number) => void;
    readonly sim_rail_stats: (a: number) => [number, number];
    readonly sim_rail_step: (a: number, b: number, c: number) => void;
    readonly sim_release_player: (a: number) => void;
    readonly sim_remove_footprints: (a: number, b: number, c: number) => void;
    readonly sim_remove_tile: (a: number, b: number, c: number) => void;
    readonly sim_set_fast: (a: number, b: number) => void;
    readonly sim_set_majors: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly sim_set_obstacles: (a: number, b: number, c: number) => void;
    readonly sim_set_stops: (a: number, b: number, c: number) => void;
    readonly sim_set_time: (a: number, b: number, c: number) => void;
    readonly sim_set_view: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly sim_signal_count: (a: number) => number;
    readonly sim_signal_plans: (a: number) => [number, number];
    readonly sim_signal_ptr: (a: number) => number;
    readonly sim_spawn_player: (a: number, b: number, c: number, d: number) => number;
    readonly sim_stats: (a: number) => [number, number];
    readonly sim_step: (a: number, b: number) => void;
    readonly sim_take_over: (a: number, b: number) => number;
    readonly sim_tile_count: (a: number) => number;
    readonly sim_write_output: (a: number, b: number, c: number) => void;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
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
