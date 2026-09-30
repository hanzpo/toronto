/* @ts-self-types="./sim.d.ts" */

export class Sim {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SimFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_sim_free(ptr, 0);
    }
    /**
     * Building outlines of a level-0 tile for player collisions:
     * `ring_off` [n+1] into `xy` (world E/N pairs).
     * @param {number} tx
     * @param {number} ty
     * @param {Uint32Array} ring_off
     * @param {Float32Array} xy
     */
    add_footprints(tx, ty, ring_off, xy) {
        const ptr0 = passArray32ToWasm0(ring_off, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(xy, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        wasm.sim_add_footprints(this.__wbg_ptr, tx, ty, ptr0, len0, ptr1, len1);
    }
    /**
     * @param {number} tx
     * @param {number} ty
     * @param {Float64Array} n_id
     * @param {Float32Array} n_xyz
     * @param {Uint8Array} n_flags
     * @param {Uint32Array} e_from
     * @param {Uint32Array} e_to
     * @param {Uint32Array} e_off
     * @param {Float32Array} e_xyz
     * @param {Uint8Array} e_class
     * @param {Uint8Array} e_lanes_fwd
     * @param {Uint8Array} e_lanes_bwd
     * @param {Float32Array} e_speed
     * @param {Uint8Array} e_flags
     * @param {Float32Array} bottleneck
     * @param {Float32Array} e_width
     * @param {Uint8Array} e_side
     */
    add_tile(tx, ty, n_id, n_xyz, n_flags, e_from, e_to, e_off, e_xyz, e_class, e_lanes_fwd, e_lanes_bwd, e_speed, e_flags, bottleneck, e_width, e_side) {
        const ptr0 = passArrayF64ToWasm0(n_id, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(n_xyz, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray8ToWasm0(n_flags, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArray32ToWasm0(e_from, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArray32ToWasm0(e_to, wasm.__wbindgen_malloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passArray32ToWasm0(e_off, wasm.__wbindgen_malloc);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passArrayF32ToWasm0(e_xyz, wasm.__wbindgen_malloc);
        const len6 = WASM_VECTOR_LEN;
        const ptr7 = passArray8ToWasm0(e_class, wasm.__wbindgen_malloc);
        const len7 = WASM_VECTOR_LEN;
        const ptr8 = passArray8ToWasm0(e_lanes_fwd, wasm.__wbindgen_malloc);
        const len8 = WASM_VECTOR_LEN;
        const ptr9 = passArray8ToWasm0(e_lanes_bwd, wasm.__wbindgen_malloc);
        const len9 = WASM_VECTOR_LEN;
        const ptr10 = passArrayF32ToWasm0(e_speed, wasm.__wbindgen_malloc);
        const len10 = WASM_VECTOR_LEN;
        const ptr11 = passArray8ToWasm0(e_flags, wasm.__wbindgen_malloc);
        const len11 = WASM_VECTOR_LEN;
        const ptr12 = passArrayF32ToWasm0(bottleneck, wasm.__wbindgen_malloc);
        const len12 = WASM_VECTOR_LEN;
        const ptr13 = passArrayF32ToWasm0(e_width, wasm.__wbindgen_malloc);
        const len13 = WASM_VECTOR_LEN;
        const ptr14 = passArray8ToWasm0(e_side, wasm.__wbindgen_malloc);
        const len14 = WASM_VECTOR_LEN;
        wasm.sim_add_tile(this.__wbg_ptr, tx, ty, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, ptr8, len8, ptr9, len9, ptr10, len10, ptr11, len11, ptr12, len12, ptr13, len13, ptr14, len14);
    }
    /**
     * @returns {Uint32Array}
     */
    box_detail() {
        const ret = wasm.sim_box_detail(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {number}
     */
    bus_count() {
        const ret = wasm.sim_bus_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * buses that stopped being agents since the last call: [trip, delay]*
     * @returns {Float32Array}
     */
    bus_gone() {
        const ret = wasm.sim_bus_gone(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {number}
     */
    bus_path_len() {
        const ret = wasm.sim_bus_path_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    bus_path_ptr() {
        const ret = wasm.sim_bus_path_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * pattern shape (world E/N pairs) + stop centre distances / flags
     * @param {number} id
     * @param {Float64Array} xy
     * @param {Float32Array} stop_d
     * @param {Uint8Array} stop_flag
     */
    bus_pattern(id, xy, stop_d, stop_flag) {
        const ptr0 = passArrayF64ToWasm0(xy, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(stop_d, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray8ToWasm0(stop_flag, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        wasm.sim_bus_pattern(this.__wbg_ptr, id, ptr0, len0, ptr1, len1, ptr2, len2);
    }
    /**
     * @returns {number}
     */
    bus_ptr() {
        const ret = wasm.sim_bus_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * the out-of-service bus of trip `trip` drives to the garage at (gx, gy)
     * @param {number} trip
     * @param {number} gx
     * @param {number} gy
     * @returns {boolean}
     */
    bus_pullin(trip, gx, gy) {
        const ret = wasm.sim_bus_pullin(this.__wbg_ptr, trip, gx, gy);
        return ret !== 0;
    }
    /**
     * bus trip `trip` pulls out of the garage at (gx, gy) (see World::bus_pullout)
     * @param {number} trip
     * @param {number} pat
     * @param {number} len
     * @param {Float64Array} arr
     * @param {Float64Array} dep
     * @param {number} gx
     * @param {number} gy
     * @returns {number}
     */
    bus_pullout(trip, pat, len, arr, dep, gx, gy) {
        const ptr0 = passArrayF64ToWasm0(arr, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(dep, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.sim_bus_pullout(this.__wbg_ptr, trip, pat, len, ptr0, len0, ptr1, len1, gx, gy);
        return ret;
    }
    /**
     * the bus of trip `old` continues as `new` (same vehicle block)
     * @param {number} old
     * @param {number} _new
     * @param {number} pat
     * @param {Float64Array} arr
     * @param {Float64Array} dep
     * @returns {boolean}
     */
    bus_retrip(old, _new, pat, arr, dep) {
        const ptr0 = passArrayF64ToWasm0(arr, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(dep, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.sim_bus_retrip(this.__wbg_ptr, old, _new, pat, ptr0, len0, ptr1, len1);
        return ret !== 0;
    }
    /**
     * place bus trip `trip` with its front at `front` along pattern `pat`
     * @param {number} trip
     * @param {number} pat
     * @param {number} len
     * @param {number} front
     * @param {number} v
     * @param {Float64Array} arr
     * @param {Float64Array} dep
     * @returns {number}
     */
    bus_spawn(trip, pat, len, front, v, arr, dep) {
        const ptr0 = passArrayF64ToWasm0(arr, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(dep, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.sim_bus_spawn(this.__wbg_ptr, trip, pat, len, front, v, ptr0, len0, ptr1, len1);
        return ret;
    }
    /**
     * @returns {number}
     */
    car_count() {
        const ret = wasm.sim_car_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    car_ptr() {
        const ret = wasm.sim_car_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * loaded footprint tiles, flat [tx, ty, ...]
     * @returns {Int32Array}
     */
    footprint_tiles() {
        const ret = wasm.sim_footprint_tiles(this.__wbg_ptr);
        var v1 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * bumps whenever the loaded road graph changes
     * @returns {number}
     */
    graph_version() {
        const ret = wasm.sim_graph_version(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} tx
     * @param {number} ty
     * @returns {boolean}
     */
    has_footprints(tx, ty) {
        const ret = wasm.sim_has_footprints(this.__wbg_ptr, tx, ty);
        return ret !== 0;
    }
    /**
     * @param {number} tx
     * @param {number} ty
     * @returns {boolean}
     */
    has_tile(tx, ty) {
        const ret = wasm.sim_has_tile(this.__wbg_ptr, tx, ty);
        return ret !== 0;
    }
    /**
     * speed ratio (0..255 = 0..1) per major segment at a time
     * @param {number} tod
     * @param {number} weekday
     * @returns {Uint8Array}
     */
    major_ratios(tod, weekday) {
        const ret = wasm.sim_major_ratios(this.__wbg_ptr, tod, weekday);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * measured speed ratios of local major links: [tx, ty, edgeIdx, ratio]*
     * @returns {Float32Array}
     */
    measured() {
        const ret = wasm.sim_measured(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @param {number} seed
     * @param {number} max_cars
     * @param {number} max_peds
     */
    constructor(seed, max_cars, max_peds) {
        const ret = wasm.sim_new(seed, max_cars, max_peds);
        this.__wbg_ptr = ret;
        SimFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * cars stopped in junction boxes: [front past the stop line, rear in the exit box, inside a split junction]
     * QA: overlapping car bodies by cause (see World::overlap_causes)
     * @returns {Uint32Array}
     */
    overlap_counts() {
        const ret = wasm.sim_overlap_counts(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {number}
     */
    ped_count() {
        const ret = wasm.sim_ped_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    ped_ptr() {
        const ret = wasm.sim_ped_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * [curb jolt (m/s), collision impulse (m/s), surface (0 off-road, 1 road, 2 sidewalk)] since the last call
     * @returns {Float32Array}
     */
    player_events() {
        const ret = wasm.sim_player_events(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * [active, e, n, elev, heading, speed, pitch, onRoad, tileX, tileY, edgeIdx, carId, structure, bump]
     * onRoad: 0 off-road, 1 carriageway, 2 sidewalk (see player_events)
     * @returns {Float64Array}
     */
    player_state() {
        const ret = wasm.sim_player_state(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @param {number} dt
     * @param {number} throttle
     * @param {number} brake
     * @param {number} steer
     * @param {boolean} handbrake
     * @param {number} ground_z
     */
    player_step(dt, throttle, brake, steer, handbrake, ground_z) {
        wasm.sim_player_step(this.__wbg_ptr, dt, throttle, brake, steer, handbrake, ground_z);
    }
    /**
     * one agency's rail timetable (transit rail file of the current profile)
     * @param {number} id
     * @param {Uint8Array} pat_mode
     * @param {Float32Array} pat_len
     * @param {Uint8Array} pat_rflags
     * @param {Float32Array} pat_rstart
     * @param {Uint32Array} pat_redge_off
     * @param {Uint32Array} pat_redge
     * @param {Uint32Array} pat_stop_off
     * @param {Float32Array} pat_stop_dist
     * @param {Uint8Array} pat_stop_flag
     * @param {Uint32Array} tp_off
     * @param {Uint16Array} tp_arr
     * @param {Uint16Array} tp_dwell
     * @param {Int32Array} trip_start
     * @param {Uint32Array} trip_pattern
     * @param {Uint32Array} trip_tp
     * @param {Int32Array} trip_next
     */
    rail_add_feed(id, pat_mode, pat_len, pat_rflags, pat_rstart, pat_redge_off, pat_redge, pat_stop_off, pat_stop_dist, pat_stop_flag, tp_off, tp_arr, tp_dwell, trip_start, trip_pattern, trip_tp, trip_next) {
        const ptr0 = passArray8ToWasm0(pat_mode, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(pat_len, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray8ToWasm0(pat_rflags, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArrayF32ToWasm0(pat_rstart, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArray32ToWasm0(pat_redge_off, wasm.__wbindgen_malloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passArray32ToWasm0(pat_redge, wasm.__wbindgen_malloc);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passArray32ToWasm0(pat_stop_off, wasm.__wbindgen_malloc);
        const len6 = WASM_VECTOR_LEN;
        const ptr7 = passArrayF32ToWasm0(pat_stop_dist, wasm.__wbindgen_malloc);
        const len7 = WASM_VECTOR_LEN;
        const ptr8 = passArray8ToWasm0(pat_stop_flag, wasm.__wbindgen_malloc);
        const len8 = WASM_VECTOR_LEN;
        const ptr9 = passArray32ToWasm0(tp_off, wasm.__wbindgen_malloc);
        const len9 = WASM_VECTOR_LEN;
        const ptr10 = passArray16ToWasm0(tp_arr, wasm.__wbindgen_malloc);
        const len10 = WASM_VECTOR_LEN;
        const ptr11 = passArray16ToWasm0(tp_dwell, wasm.__wbindgen_malloc);
        const len11 = WASM_VECTOR_LEN;
        const ptr12 = passArray32ToWasm0(trip_start, wasm.__wbindgen_malloc);
        const len12 = WASM_VECTOR_LEN;
        const ptr13 = passArray32ToWasm0(trip_pattern, wasm.__wbindgen_malloc);
        const len13 = WASM_VECTOR_LEN;
        const ptr14 = passArray32ToWasm0(trip_tp, wasm.__wbindgen_malloc);
        const len14 = WASM_VECTOR_LEN;
        const ptr15 = passArray32ToWasm0(trip_next, wasm.__wbindgen_malloc);
        const len15 = WASM_VECTOR_LEN;
        wasm.sim_rail_add_feed(this.__wbg_ptr, id, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, ptr8, len8, ptr9, len9, ptr10, len10, ptr11, len11, ptr12, len12, ptr13, len13, ptr14, len14, ptr15, len15);
    }
    rail_clear_feeds() {
        wasm.sim_rail_clear_feeds(this.__wbg_ptr);
    }
    /**
     * @returns {number}
     */
    rail_count() {
        const ret = wasm.sim_rail_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * crossings whose state changed: [osm id, state (0 idle, 1 warning, 2 gates down)]*
     * @returns {Float64Array}
     */
    rail_crossing_changes() {
        const ret = wasm.sim_rail_crossing_changes(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * level crossings from the network header: [osm id, edge, s, E, N]*
     * @param {Float64Array} data
     */
    rail_crossings(data) {
        const ptr0 = passArrayF64ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.sim_rail_crossings(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * is the player driving a train?
     * a player-driven or ridden train is in the rail sim (it must not be reset)
     * @returns {boolean}
     */
    rail_has_player() {
        const ret = wasm.sim_rail_has_player(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * rail train being ridden (-1 = none): never retired or handed back while ridden
     * @param {number} id
     */
    rail_keep(id) {
        wasm.sim_rail_keep(this.__wbg_ptr, id);
    }
    /**
     * @param {Float32Array} n_xyz
     * @param {Uint8Array} n_flags
     * @param {Uint32Array} e_from
     * @param {Uint32Array} e_to
     * @param {Uint32Array} e_off
     * @param {Float32Array} e_xyz
     * @param {Uint8Array} e_vlim
     * @param {Float32Array} e_len
     * @param {Uint8Array} e_kind
     * @param {Uint8Array} e_svc
     * @param {Uint8Array} e_dir
     * @param {Uint8Array} e_flags
     * @param {Uint32Array} c_off
     * @param {Uint32Array} c_to
     */
    rail_network(n_xyz, n_flags, e_from, e_to, e_off, e_xyz, e_vlim, e_len, e_kind, e_svc, e_dir, e_flags, c_off, c_to) {
        const ptr0 = passArrayF32ToWasm0(n_xyz, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(n_flags, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray32ToWasm0(e_from, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArray32ToWasm0(e_to, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArray32ToWasm0(e_off, wasm.__wbindgen_malloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passArrayF32ToWasm0(e_xyz, wasm.__wbindgen_malloc);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passArray8ToWasm0(e_vlim, wasm.__wbindgen_malloc);
        const len6 = WASM_VECTOR_LEN;
        const ptr7 = passArrayF32ToWasm0(e_len, wasm.__wbindgen_malloc);
        const len7 = WASM_VECTOR_LEN;
        const ptr8 = passArray8ToWasm0(e_kind, wasm.__wbindgen_malloc);
        const len8 = WASM_VECTOR_LEN;
        const ptr9 = passArray8ToWasm0(e_svc, wasm.__wbindgen_malloc);
        const len9 = WASM_VECTOR_LEN;
        const ptr10 = passArray8ToWasm0(e_dir, wasm.__wbindgen_malloc);
        const len10 = WASM_VECTOR_LEN;
        const ptr11 = passArray8ToWasm0(e_flags, wasm.__wbindgen_malloc);
        const len11 = WASM_VECTOR_LEN;
        const ptr12 = passArray32ToWasm0(c_off, wasm.__wbindgen_malloc);
        const len12 = WASM_VECTOR_LEN;
        const ptr13 = passArray32ToWasm0(c_to, wasm.__wbindgen_malloc);
        const len13 = WASM_VECTOR_LEN;
        wasm.sim_rail_network(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, ptr8, len8, ptr9, len9, ptr10, len10, ptr11, len11, ptr12, len12, ptr13, len13);
    }
    /**
     * @returns {number}
     */
    rail_path_len() {
        const ret = wasm.sim_rail_path_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    rail_path_ptr() {
        const ret = wasm.sim_rail_path_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} feed
     * @param {number} trip
     * @returns {boolean}
     */
    rail_player_attach(feed, trip) {
        const ret = wasm.sim_rail_player_attach(this.__wbg_ptr, feed, trip);
        return ret !== 0;
    }
    /**
     * @param {number} cmd
     * @param {boolean} emergency
     */
    rail_player_input(cmd, emergency) {
        wasm.sim_rail_player_input(this.__wbg_ptr, cmd, emergency);
    }
    rail_player_release() {
        wasm.sim_rail_player_release(this.__wbg_ptr);
    }
    /**
     * see RailSim::player_state
     * @returns {Float64Array}
     */
    rail_player_state() {
        const ret = wasm.sim_rail_player_state(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @returns {number}
     */
    rail_ptr() {
        const ret = wasm.sim_rail_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    rail_reset() {
        wasm.sim_rail_reset(this.__wbg_ptr);
    }
    /**
     * cmd -1 (full brake) .. 1 (full power)
     * a rider attaches to a rail trip: placed now if needed and kept; its train id (-1: none)
     * @param {number} feed
     * @param {number} trip
     * @returns {number}
     */
    rail_ride(feed, trip) {
        const ret = wasm.sim_rail_ride(this.__wbg_ptr, feed, trip);
        return ret;
    }
    /**
     * drop all agents (the timetable takes over), e.g. while sim time is being dropped
     * camera position and horizontal forward vector (spawns / removals avoid the view)
     * @param {number} x
     * @param {number} y
     * @param {number} fx
     * @param {number} fy
     */
    rail_set_camera(x, y, fx, fy) {
        wasm.sim_rail_set_camera(this.__wbg_ptr, x, y, fx, fy);
    }
    /**
     * depots: per depot track group and feed bit mask, storage edges [off[d], off[d+1])
     * @param {Uint8Array} group
     * @param {Uint32Array} feeds
     * @param {Uint32Array} off
     * @param {Uint32Array} edges
     */
    rail_set_depots(group, feeds, off, edges) {
        const ptr0 = passArray8ToWasm0(group, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray32ToWasm0(feeds, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray32ToWasm0(off, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArray32ToWasm0(edges, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        wasm.sim_rail_set_depots(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
    }
    /**
     * radius (m) around the focus within which rail trips run as agents; 0 = off
     * @param {number} r
     */
    rail_set_radius(r) {
        wasm.sim_rail_set_radius(this.__wbg_ptr, r);
    }
    /**
     * [trains, overlaps (total), authority overruns (total), turnbacks, pull-outs, pull-ins, parked]
     * @returns {Float64Array}
     */
    rail_stats() {
        const ret = wasm.sim_rail_stats(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @param {number} dt
     * @param {number} tod
     */
    rail_step(dt, tod) {
        wasm.sim_rail_step(this.__wbg_ptr, dt, tod);
    }
    release_player() {
        wasm.sim_release_player(this.__wbg_ptr);
    }
    /**
     * @param {number} tx
     * @param {number} ty
     */
    remove_footprints(tx, ty) {
        wasm.sim_remove_footprints(this.__wbg_ptr, tx, ty);
    }
    /**
     * Remove the pedestrian nearest (e, n) within r m (the player takes their place).
     * @param {number} e
     * @param {number} n
     * @param {number} r
     * @returns {boolean}
     */
    remove_ped_near(e, n, r) {
        const ret = wasm.sim_remove_ped_near(this.__wbg_ptr, e, n, r);
        return ret !== 0;
    }
    /**
     * @param {number} tx
     * @param {number} ty
     */
    remove_tile(tx, ty) {
        wasm.sim_remove_tile(this.__wbg_ptr, tx, ty);
    }
    /**
     * @param {boolean} fast
     */
    set_fast(fast) {
        wasm.sim_set_fast(this.__wbg_ptr, fast);
    }
    /**
     * `geo` = per segment [midE, midN, dirE, dirN] (unit direction)
     * @param {Uint8Array} _class
     * @param {Uint8Array} flags
     * @param {Float32Array} bottleneck
     * @param {Float32Array} geo
     */
    set_majors(_class, flags, bottleneck, geo) {
        const ptr0 = passArray8ToWasm0(_class, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(flags, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayF32ToWasm0(bottleneck, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArrayF32ToWasm0(geo, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        wasm.sim_set_majors(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
    }
    /**
     * External moving obstacles (surface transit), replacing the previous set:
     * [e, n, heading, length, width, speed, flags]* with a front-centre pose.
     * flags: 1 doors state known, 2 doors open, 4 rail vehicle (streetcar / LRT).
     * @param {Float64Array} data
     */
    set_obstacles(data) {
        const ptr0 = passArrayF64ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.sim_set_obstacles(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * transit stop positions, flat [E, N, elev, …]
     * transit stops for waiting crowds: xyz, and trips per day calling there (crowd size)
     * @param {Float64Array} xyz
     * @param {Float32Array} trips
     */
    set_stops(xyz, trips) {
        const ptr0 = passArrayF64ToWasm0(xyz, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(trips, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        wasm.sim_set_stops(this.__wbg_ptr, ptr0, len0, ptr1, len1);
    }
    /**
     * Toronto seconds since local midnight + weekday (0 = Sunday)
     * @param {number} tod
     * @param {number} weekday
     */
    set_time(tod, weekday) {
        wasm.sim_set_time(this.__wbg_ptr, tod, weekday);
    }
    /**
     * focus point (world E/N), car radius and pedestrian radius (m)
     * @param {number} e
     * @param {number} n
     * @param {number} radius
     * @param {number} ped_radius
     */
    set_view(e, n, radius, ped_radius) {
        wasm.sim_set_view(this.__wbg_ptr, e, n, radius, ped_radius);
    }
    /**
     * The walking player at (e, n, elev) with body radius r (≤ 0: not walking): cars brake
     * and honk for them. `dt` = real seconds since the last call (horn timers).
     * @param {number} e
     * @param {number} n
     * @param {number} z
     * @param {number} r
     * @param {number} dt
     */
    set_walker(e, n, z, r, dt) {
        wasm.sim_set_walker(this.__wbg_ptr, e, n, z, r, dt);
    }
    /**
     * signalised approaches: [dE, dN, bearing, halfWidth, light]* (light 0 green, 1 amber, 2 red)
     * @returns {number}
     */
    signal_count() {
        const ret = wasm.sim_signal_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * fixed-time plans of all loaded signal nodes: [osmId, x, y, offset, axis, greenA, greenB]*
     * @returns {Float64Array}
     */
    signal_plans() {
        const ret = wasm.sim_signal_plans(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @returns {number}
     */
    signal_ptr() {
        const ret = wasm.sim_signal_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} e
     * @param {number} n
     * @param {number} heading
     * @returns {boolean}
     */
    spawn_player(e, n, heading) {
        const ret = wasm.sim_spawn_player(this.__wbg_ptr, e, n, heading);
        return ret !== 0;
    }
    /**
     * [target cars, target peds, cars, peds, live links, tiles, cars stopped in a junction box]
     * @returns {Float32Array}
     */
    stats() {
        const ret = wasm.sim_stats(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @param {number} dt
     */
    step(dt) {
        wasm.sim_step(this.__wbg_ptr, dt);
    }
    /**
     * @param {number} id
     * @returns {boolean}
     */
    take_over(id) {
        const ret = wasm.sim_take_over(this.__wbg_ptr, id);
        return ret !== 0;
    }
    /**
     * advance the rail agents by `dt` s ending at time-of-day `tod` (independent of the
     * road sim so trains keep up at high clock rates)
     * accumulated ms per road-sim phase since the last call
     * [validate, sort+paths, occupancy, car following, lane changes, advance, spawn, peds]
     * @returns {Float64Array}
     */
    take_prof() {
        const ret = wasm.sim_take_prof(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @returns {number}
     */
    tile_count() {
        const ret = wasm.sim_tile_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * write render records relative to (origin_e, origin_n)
     * @param {number} origin_e
     * @param {number} origin_n
     */
    write_output(origin_e, origin_n) {
        wasm.sim_write_output(this.__wbg_ptr, origin_e, origin_n);
    }
}
if (Symbol.dispose) Sim.prototype[Symbol.dispose] = Sim.prototype.free;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_error_81547f947fe942eb: function(arg0, arg1) {
            console.error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_now_87dd8f93ffbfb263: function() {
            const ret = performance.now();
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./sim_bg.js": import0,
    };
}

const SimFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_sim_free(ptr, 1));

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayI32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

let cachedInt32ArrayMemory0 = null;
function getInt32ArrayMemory0() {
    if (cachedInt32ArrayMemory0 === null || cachedInt32ArrayMemory0.byteLength === 0) {
        cachedInt32ArrayMemory0 = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint16ArrayMemory0 = null;
function getUint16ArrayMemory0() {
    if (cachedUint16ArrayMemory0 === null || cachedUint16ArrayMemory0.byteLength === 0) {
        cachedUint16ArrayMemory0 = new Uint16Array(wasm.memory.buffer);
    }
    return cachedUint16ArrayMemory0;
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray16ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 2, 2) >>> 0;
    getUint16ArrayMemory0().set(arg, ptr / 2);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedInt32ArrayMemory0 = null;
    cachedUint16ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('sim_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
