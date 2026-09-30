//! Agent-based local traffic + pedestrian simulation for the GTA viewer.
//!
//! The crate is plain Rust (tested with `cargo test`); `Sim` is the thin
//! wasm-bindgen facade the Web Worker drives (see app/src/sim/sim.worker.ts).

pub mod bus;
pub mod collide;
pub mod demand;
pub mod graph;
pub mod idm;
pub mod peds;
pub mod rail;
pub mod rng;
pub mod signal;
pub mod view;
pub mod world;

use wasm_bindgen::prelude::*;

use graph::TileData;
use rail::{RailNet, RailSim};
use world::World;

/// Region-wide major-road segments for the statistical congestion tier.
#[derive(Default)]
struct Majors {
    class: Vec<u8>,
    flags: Vec<u8>,
    bottleneck: Vec<f32>,
    inbound: Vec<f32>,
    noise: Vec<f32>,
}

#[wasm_bindgen]
pub struct Sim {
    w: World,
    majors: Majors,
    rail: RailSim,
}

#[wasm_bindgen]
impl Sim {
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u32, max_cars: u32, max_peds: u32) -> Sim {
        Sim { w: World::new(seed as u64, max_cars as usize, max_peds as usize), majors: Majors::default(), rail: RailSim::default() }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn add_tile(
        &mut self,
        tx: i32,
        ty: i32,
        n_id: &[f64],
        n_xyz: &[f32],
        n_flags: &[u8],
        e_from: &[u32],
        e_to: &[u32],
        e_off: &[u32],
        e_xyz: &[f32],
        e_class: &[u8],
        e_lanes_fwd: &[u8],
        e_lanes_bwd: &[u8],
        e_speed: &[f32],
        e_flags: &[u8],
        bottleneck: &[f32],
        e_width: &[f32],
        e_side: &[u8],
    ) {
        self.w.g.add_tile(&TileData {
            tx,
            ty,
            n_id,
            n_xyz,
            n_flags,
            e_from,
            e_to,
            e_off,
            e_xyz,
            e_class,
            e_lanes_fwd,
            e_lanes_bwd,
            e_speed,
            e_flags,
            bottleneck,
            e_width,
            e_side,
        });
    }

    /// bumps whenever the loaded road graph changes
    pub fn graph_version(&self) -> u32 {
        self.w.g.version
    }

    /// fixed-time plans of all loaded signal nodes: [osmId, x, y, offset, axis, greenA, greenB]*
    pub fn signal_plans(&self) -> Vec<f64> {
        let mut out = Vec::new();
        for n in &self.w.g.nodes {
            if n.alive && n.control == graph::Control::Signal {
                let p = n.plan;
                out.extend_from_slice(&[n.osm as f64, n.x, n.y, p.offset as f64, p.axis as f64, p.green_a as f64, p.green_b as f64]);
            }
        }
        out
    }

    pub fn remove_tile(&mut self, tx: i32, ty: i32) {
        self.w.g.remove_tile(tx, ty);
    }

    pub fn has_tile(&self, tx: i32, ty: i32) -> bool {
        self.w.g.has_tile(tx, ty)
    }

    pub fn tile_count(&self) -> u32 {
        self.w.g.tiles.len() as u32
    }

    /// focus point (world E/N), car radius and pedestrian radius (m)
    pub fn set_view(&mut self, e: f64, n: f64, radius: f64, ped_radius: f64) {
        self.w.focus = (e, n);
        self.rail.focus = (e, n);
        self.w.radius = radius;
        self.w.peds.radius = ped_radius;
    }

    /// Toronto seconds since local midnight + weekday (0 = Sunday)
    pub fn set_time(&mut self, tod: f64, weekday: u32) {
        self.w.tod = tod;
        self.w.weekday = weekday;
    }

    pub fn step(&mut self, dt: f32) {
        self.w.step(dt);
    }

    /// advance the rail agents by `dt` s ending at time-of-day `tod` (independent of the
    /// road sim so trains keep up at high clock rates)
    /// cars stopped in junction boxes: [front past the stop line, rear in the exit box, inside a split junction]
    pub fn box_detail(&self) -> Vec<u32> {
        self.w.stopped_in_box_detail().to_vec()
    }

    pub fn rail_step(&mut self, dt: f32, tod: f64) {
        self.tram_road(tod);
        self.rail.step(dt, tod);
    }

    /// is the player driving a train?
    pub fn rail_has_player(&self) -> bool {
        self.rail.player.is_some()
    }

    pub fn set_fast(&mut self, fast: bool) {
        self.w.fast = fast;
    }

    /// write render records relative to (origin_e, origin_n)
    pub fn write_output(&mut self, origin_e: f64, origin_n: f64) {
        self.w.write_cars(origin_e, origin_n);
        self.w.peds.write(&self.w.g, origin_e, origin_n);
        self.w.write_signals(origin_e, origin_n);
        self.rail.write(origin_e, origin_n);
        self.w.write_buses(origin_e, origin_n);
    }

    // ------------------------------------------------------------------ buses (bus.rs)

    /// pattern shape (world E/N pairs) + stop centre distances / flags
    pub fn bus_pattern(&mut self, id: u32, xy: &[f64], stop_d: &[f32], stop_flag: &[u8]) {
        self.w.bus_pattern(id, xy, stop_d, stop_flag);
    }
    /// place bus trip `trip` with its front at `front` along pattern `pat`
    #[allow(clippy::too_many_arguments)]
    pub fn bus_spawn(&mut self, trip: u32, pat: u32, len: f32, front: f32, v: f32, arr: &[f64], dep: &[f64]) -> u8 {
        self.w.bus_spawn(trip, pat, len, front, v, arr, dep)
    }
    /// bus trip `trip` pulls out of the garage at (gx, gy) (see World::bus_pullout)
    #[allow(clippy::too_many_arguments)]
    pub fn bus_pullout(&mut self, trip: u32, pat: u32, len: f32, arr: &[f64], dep: &[f64], gx: f64, gy: f64) -> u8 {
        self.w.bus_pullout(trip, pat, len, arr, dep, gx, gy)
    }
    /// the out-of-service bus of trip `trip` drives to the garage at (gx, gy)
    pub fn bus_pullin(&mut self, trip: u32, gx: f64, gy: f64) -> bool {
        self.w.bus_pullin(trip, gx, gy)
    }
    /// the bus of trip `old` continues as `new` (same vehicle block)
    pub fn bus_retrip(&mut self, old: u32, new: u32, pat: u32, arr: &[f64], dep: &[f64]) -> bool {
        self.w.bus_retrip(old, new, pat, arr, dep)
    }
    pub fn bus_count(&self) -> u32 {
        (self.w.out_buses.len() / bus::BUS_STRIDE) as u32
    }
    pub fn bus_ptr(&self) -> *const f32 {
        self.w.out_buses.as_ptr()
    }
    pub fn bus_path_len(&self) -> u32 {
        (self.w.out_bus_path.len() / 3) as u32
    }
    pub fn bus_path_ptr(&self) -> *const f32 {
        self.w.out_bus_path.as_ptr()
    }
    /// buses that stopped being agents since the last call: [trip, delay]*
    pub fn bus_gone(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.w.bus_gone)
    }

    /// signalised approaches: [dE, dN, bearing, halfWidth, light]* (light 0 green, 1 amber, 2 red)
    pub fn signal_count(&self) -> u32 {
        (self.w.out_signals.len() / 5) as u32
    }
    pub fn signal_ptr(&self) -> *const f32 {
        self.w.out_signals.as_ptr()
    }

    /// External moving obstacles (surface transit), replacing the previous set:
    /// [e, n, heading, length, width, speed, flags]* with a front-centre pose.
    /// flags: 1 doors state known, 2 doors open, 4 rail vehicle (streetcar / LRT).
    pub fn set_obstacles(&mut self, data: &[f64]) {
        self.w.set_obstacles(data);
    }

    /// Building outlines of a level-0 tile for player collisions:
    /// `ring_off` [n+1] into `xy` (world E/N pairs).
    pub fn add_footprints(&mut self, tx: i32, ty: i32, ring_off: &[u32], xy: &[f32]) {
        self.w.fp.add_tile(tx, ty, ring_off, xy);
    }
    pub fn remove_footprints(&mut self, tx: i32, ty: i32) {
        self.w.fp.remove_tile(tx, ty);
    }
    pub fn has_footprints(&self, tx: i32, ty: i32) -> bool {
        self.w.fp.has_tile(tx, ty)
    }
    /// loaded footprint tiles, flat [tx, ty, ...]
    pub fn footprint_tiles(&self) -> Vec<i32> {
        self.w.fp.tiles().into_iter().flat_map(|(a, b)| [a, b]).collect()
    }

    pub fn car_count(&self) -> u32 {
        (self.w.out_cars.len() / world::CAR_STRIDE) as u32
    }
    pub fn car_ptr(&self) -> *const f32 {
        self.w.out_cars.as_ptr()
    }
    pub fn ped_count(&self) -> u32 {
        (self.w.peds.out.len() / peds::PED_STRIDE) as u32
    }
    pub fn ped_ptr(&self) -> *const f32 {
        self.w.peds.out.as_ptr()
    }

    /// transit stop positions, flat [E, N, elev, …]
    pub fn set_stops(&mut self, xyz: &[f64]) {
        self.w.peds.set_stops(xyz);
    }

    /// [target cars, target peds, cars, peds, live links, tiles, cars stopped in a junction box]
    pub fn stats(&self) -> Vec<f32> {
        vec![
            self.w.target_cars,
            self.w.peds.target,
            self.w.cars.len() as f32,
            self.w.peds.list.len() as f32,
            self.w.g.live_links as f32,
            self.w.g.tiles.len() as f32,
            self.w.stopped_in_box() as f32,
        ]
    }

    // ------------------------------------------------------------------ player

    pub fn spawn_player(&mut self, e: f64, n: f64, heading: f32) -> bool {
        self.w.spawn_player(e, n, heading)
    }
    pub fn take_over(&mut self, id: u32) -> bool {
        self.w.take_over(id)
    }
    pub fn release_player(&mut self) {
        self.w.release_player();
    }
    pub fn player_step(&mut self, dt: f32, throttle: f32, brake: f32, steer: f32, handbrake: bool, ground_z: f32) {
        self.w.player_step(dt, throttle, brake, steer, handbrake, ground_z);
    }
    /// [active, e, n, elev, heading, speed, pitch, onRoad, tileX, tileY, edgeIdx, carId, structure, bump]
    pub fn player_state(&self) -> Vec<f64> {
        match &self.w.player {
            None => vec![0.0; 14],
            Some(p) => {
                let (tx, ty, ei) = self.w.player_road().map(|(a, b, c)| (a as f64, b as f64, c as f64)).unwrap_or((0.0, 0.0, -1.0));
                vec![
                    1.0,
                    p.x,
                    p.y,
                    p.z as f64,
                    p.h as f64,
                    p.v as f64,
                    p.p as f64,
                    if p.on_road { 1.0 } else { 0.0 },
                    tx,
                    ty,
                    ei,
                    p.id as f64,
                    if p.structure { 1.0 } else { 0.0 },
                    p.bump as f64,
                ]
            }
        }
    }

    // ------------------------------------------------------------------ congestion tier

    /// `geo` = per segment [midE, midN, dirE, dirN] (unit direction)
    pub fn set_majors(&mut self, class: &[u8], flags: &[u8], bottleneck: &[f32], geo: &[f32]) {
        let n = class.len();
        let m = &mut self.majors;
        m.class = class.to_vec();
        m.flags = flags.to_vec();
        m.bottleneck = bottleneck.to_vec();
        m.inbound = (0..n)
            .map(|i| {
                let (mx, my, dx, dy) = (geo[i * 4], geo[i * 4 + 1], geo[i * 4 + 2], geo[i * 4 + 3]);
                let d = mx.hypot(my).max(1.0);
                // cosine with the direction towards downtown, fading out far away
                (-(mx * dx + my * dy) / d) * (1.0 - (d / 60000.0).min(0.7))
            })
            .collect();
        m.noise = (0..n).map(|i| rng::hash01(i as u64 * 2654435761)).collect();
    }

    /// speed ratio (0..255 = 0..1) per major segment at a time
    pub fn major_ratios(&self, tod: f64, weekday: u32) -> Vec<u8> {
        let m = &self.majors;
        (0..m.class.len())
            .map(|i| (demand::speed_ratio(m.class[i], m.flags[i], m.bottleneck[i], m.inbound[i], m.noise[i], tod, weekday) * 255.0).round() as u8)
            .collect()
    }

    /// measured speed ratios of local major links: [tx, ty, edgeIdx, ratio]*
    pub fn measured(&mut self) -> Vec<f32> {
        self.w.measured()
    }

    // ------------------------------------------------------------------ rail agents (rail.rs)

    #[allow(clippy::too_many_arguments)]
    pub fn rail_network(
        &mut self,
        n_xyz: &[f32],
        n_flags: &[u8],
        e_from: &[u32],
        e_to: &[u32],
        e_off: &[u32],
        e_xyz: &[f32],
        e_vlim: &[u8],
        e_len: &[f32],
        e_kind: &[u8],
        e_svc: &[u8],
        e_dir: &[u8],
        e_flags: &[u8],
        c_off: &[u32],
        c_to: &[u32],
    ) {
        let net = RailNet::load(n_xyz, n_flags, e_from, e_to, e_off, e_xyz, e_vlim, e_len, e_kind, e_svc, e_dir, e_flags, c_off, c_to);
        self.rail.set_net(net);
    }

    /// one agency's rail timetable (transit rail file of the current profile)
    #[allow(clippy::too_many_arguments)]
    pub fn rail_add_feed(
        &mut self,
        id: u32,
        pat_mode: &[u8],
        pat_len: &[f32],
        pat_rflags: &[u8],
        pat_rstart: &[f32],
        pat_redge_off: &[u32],
        pat_redge: &[u32],
        pat_stop_off: &[u32],
        pat_stop_dist: &[f32],
        pat_stop_flag: &[u8],
        tp_off: &[u32],
        tp_arr: &[u16],
        tp_dwell: &[u16],
        trip_start: &[i32],
        trip_pattern: &[u32],
        trip_tp: &[u32],
        trip_next: &[i32],
    ) {
        self.rail.add_feed(id, pat_mode, pat_len, pat_rflags, pat_rstart, pat_redge_off, pat_redge, pat_stop_off, pat_stop_dist, pat_stop_flag, tp_off, tp_arr, tp_dwell, trip_start, trip_pattern, trip_tp, trip_next);
    }

    /// depots: per depot track group and feed bit mask, storage edges [off[d], off[d+1])
    pub fn rail_set_depots(&mut self, group: &[u8], feeds: &[u32], off: &[u32], edges: &[u32]) {
        self.rail.set_depots(group, feeds, off, edges);
    }

    pub fn rail_clear_feeds(&mut self) {
        self.rail.clear_feeds();
    }

    /// radius (m) around the focus within which rail trips run as agents; 0 = off
    pub fn rail_set_radius(&mut self, r: f64) {
        self.rail.enabled = r > 0.0;
        if r <= 0.0 && !self.rail.trains.is_empty() {
            self.rail.clear_trains();
        }
        self.rail.radius = r;
    }

    /// drop all agents (the timetable takes over), e.g. while sim time is being dropped
    /// camera position and horizontal forward vector (spawns / removals avoid the view)
    pub fn rail_set_camera(&mut self, x: f64, y: f64, fx: f64, fy: f64) {
        let l = fx.hypot(fy);
        self.rail.camera = if l > 1e-6 { Some((x, y, fx / l, fy / l)) } else { Some((x, y, 1.0, 0.0)) };
        self.w.camera = self.rail.camera;
        self.w.peds.camera = self.rail.camera;
    }

    pub fn rail_reset(&mut self) {
        self.rail.clear_trains();
    }

    pub fn rail_count(&self) -> u32 {
        (self.rail.out.len() / rail::RAIL_STRIDE) as u32
    }
    pub fn rail_ptr(&self) -> *const f32 {
        self.rail.out.as_ptr()
    }
    pub fn rail_path_len(&self) -> u32 {
        (self.rail.out_path.len() / 3) as u32
    }
    pub fn rail_path_ptr(&self) -> *const f32 {
        self.rail.out_path.as_ptr()
    }
    /// [trains, overlaps (total), authority overruns (total), turnbacks, pull-outs, pull-ins, parked]
    pub fn rail_stats(&self) -> Vec<f64> {
        let parked = self.rail.trains.iter().filter(|t| t.state == rail::TState::Parked).count();
        vec![self.rail.trains.len() as f64, self.rail.overlaps as f64, self.rail.overruns as f64, self.rail.turnbacks as f64, self.rail.pullouts as f64, self.rail.pullins as f64, parked as f64]
    }

    pub fn rail_player_attach(&mut self, feed: u32, trip: u32) -> bool {
        self.rail.player_attach(feed, trip)
    }
    pub fn rail_player_release(&mut self) {
        self.rail.player_release();
    }
    /// cmd -1 (full brake) .. 1 (full power)
    pub fn rail_player_input(&mut self, cmd: f32, emergency: bool) {
        self.rail.player_input(cmd, emergency);
    }
    /// see RailSim::player_state
    pub fn rail_player_state(&self) -> Vec<f64> {
        self.rail.player_state()
    }
}

impl Sim {
    /// Streetcars / at-grade LRT against road traffic: the first car body across the
    /// track ahead and red / amber signals where the track enters a signalised junction
    /// become on-sight constraints of the train.
    fn tram_road(&mut self, tod: f64) {
        use std::collections::HashMap;
        let mut probes = Vec::new();
        self.rail.surface_probes(3.0, &mut probes);
        for t in 0..self.rail.trains.len() {
            self.rail.set_ext(t, f32::INFINITY, 0.0);
        }
        if probes.is_empty() {
            return;
        }
        // car grid (render poses, 16 m cells)
        let w = &self.w;
        let mut grid: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
        for (i, c) in w.cars.iter().enumerate() {
            if !c.posed || c.flags & world::F_DEAD != 0 {
                continue;
            }
            let k = ((c.pose.x / 16.0).floor() as i32, (c.pose.y / 16.0).floor() as i32);
            grid.entry(k).or_default().push(i as u32);
        }
        let mut near = Vec::new();
        let mut best: HashMap<u32, (f32, f32)> = HashMap::new();
        let mut signal_seen: HashMap<(u32, u32), ()> = HashMap::new();
        for &(ti, x, y, d, h, z) in &probes {
            if best.get(&ti).map_or(false, |b| b.0 <= d) {
                continue;
            }
            // cars: sample point inside a car body grown by the tram half width
            let (cx, cy) = ((x / 16.0).floor() as i32, (y / 16.0).floor() as i32);
            let mut hit: Option<f32> = None;
            for gx in cx - 1..=cx + 1 {
                for gy in cy - 1..=cy + 1 {
                    if let Some(l) = grid.get(&(gx, gy)) {
                        for &i in l {
                            let c = &w.cars[i as usize];
                            if (c.pose.z - z).abs() > 4.0 {
                                continue;
                            }
                            let (dx, dy) = ((x - c.pose.x) as f32, (y - c.pose.y) as f32);
                            let (s, co) = c.pose.h.sin_cos();
                            let along = dx * co + dy * s;
                            let lat = -dx * s + dy * co;
                            if along.abs() < c.len * 0.5 + 0.5 && lat.abs() < world::HALF_W[c.kind as usize % idm::KINDS] + 1.35 {
                                // speed along the track (0 for crossing traffic)
                                let vv = c.v * (c.pose.h - h).cos().max(0.0);
                                hit = Some(hit.map_or(vv, |a: f32| a.min(vv)));
                            }
                        }
                    }
                }
            }
            if let Some(vv) = hit {
                let gap = (d - 2.5).max(0.0);
                best.insert(ti, (gap, vv));
                continue;
            }
            // signals: the track enters the box of a signalised junction
            w.g.edges_near(x, y, 10.0, &mut near);
            for &eid in &near {
                let e = &w.g.edges[eid as usize];
                for nd in [e.from, e.to] {
                    let node = &w.g.nodes[nd as usize];
                    if node.control != graph::Control::Signal || signal_seen.contains_key(&(ti, nd)) {
                        continue;
                    }
                    let dist = ((node.x - x).hypot(node.y - y)) as f32;
                    if dist > node.setback.max(6.0) + 1.0 || (node.z - z).abs() > 4.0 {
                        continue;
                    }
                    signal_seen.insert((ti, nd), ());
                    let light = node.plan.light_for(tod, h);
                    let v = self.rail.trains[ti as usize].v;
                    let stop = match light {
                        signal::Light::Red => true,
                        signal::Light::Amber => d > v * v / (2.0 * 1.3) + 2.0,
                        _ => false,
                    };
                    // hold at the line (already at it and slow) or brake for it; a tram
                    // moving past the line is committed
                    if stop && (d > 1.0 || v < 2.0) {
                        best.insert(ti, ((d - 1.0).max(0.0), 0.0));
                    }
                }
            }
        }
        for (ti, (g, v)) in best {
            self.rail.set_ext(ti as usize, g, v);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::tests::load_cross;
    use crate::rail::tests::{add_feed, PatSpec};
    use crate::rail::{RailNet, K_TRAM, M_STREETCAR};

    /// streetcar track along the northbound lane of the cross's south / north arms
    fn tram_sim() -> Sim {
        let mut sim = Sim::new(3, 100, 10);
        load_cross(&mut sim.w.g, 1, [2, 2, 2, 2]);
        sim.w.g.refresh();
        sim.w.focus = (512.0, 512.0);
        sim.w.radius = 1000.0;
        sim.w.max_cars = 0;
        let x = 512.0 + 1.75f32;
        let n_xyz = [x, 312.0, 0.0, x, 712.0, 0.0];
        let net = RailNet::load(&n_xyz, &[0, 0], &[0], &[1], &[0, 2], &[x, 312.0, 0.0, x, 712.0, 0.0], &[40, 40], &[400.0], &[K_TRAM], &[0], &[3], &[0], &[0, 0, 0], &[]);
        sim.rail.set_net(net);
        sim.rail.focus = (512.0, 512.0);
        sim
    }

    #[test]
    fn streetcar_stops_at_red() {
        let mut sim = tram_sim();
        let plan = sim.w.g.nodes[sim.w.g.node_map[&1] as usize].plan;
        // phase A (east-west) green: the north-south approach is red
        let t0 = plan.cycle() as f64 * 400.0 - plan.offset as f64;
        let pat = PatSpec { edges: vec![0], start: 0.0, stops: vec![35.0, 380.0], len: 30.0, mode: M_STREETCAR };
        add_feed(&mut sim.rail, 1, &[pat], &[(0u32, t0 as i32, vec![0u16, 600], vec![1u16, 0], -1)]);
        let node = &sim.w.g.nodes[sim.w.g.node_map[&1] as usize];
        let sb = node.setback;
        eprintln!("control {:?} setback {} light N {:?} light E {:?}", node.control, sb, node.plan.light_for(t0 + 1.0, std::f32::consts::FRAC_PI_2), node.plan.light_for(t0 + 1.0, 0.0));
        let mut t = t0;
        let mut max_front_y: f64 = 0.0;
        for _ in 0..((plan.green_a as f64 - 3.0) / 0.1) as usize {
            t += 0.1;
            sim.w.tod = t;
            sim.rail_step(0.1, t);
            if let Some(tr) = sim.rail.trains.first() {
                max_front_y = max_front_y.max(312.0 + tr.front as f64);
                if ((t - t0) * 10.0).round() as i64 % 20 == 0 {
                    eprintln!("t {:.0} y {:.1} v {:.1} ext {:.1} state {:?} light {:?}", t - t0, 312.0 + tr.front, tr.v, tr.ext_gap, tr.state, sim.w.g.nodes[sim.w.g.node_map[&1] as usize].plan.light_for(t, 1.5708));
                }
            }
        }
        assert!(!sim.rail.trains.is_empty(), "streetcar spawned");
        let stop_y = 512.0 - sb as f64;
        assert!(max_front_y < stop_y + 0.5, "ran the red: front y {max_front_y} stop line {stop_y}");
        assert!(max_front_y > stop_y - 8.0, "stopped near the line: {max_front_y} vs {stop_y}");
        // green for north-south: it goes
        for _ in 0..600 {
            t += 0.1;
            sim.w.tod = t;
            sim.rail_step(0.1, t);
        }
        let tr = &sim.rail.trains[0];
        assert!(312.0 + (tr.front as f64) > 540.0, "crossed after green");
    }

    #[test]
    fn streetcar_waits_behind_car() {
        let mut sim = tram_sim();
        // a stopped car in the northbound lane 120 m north of the tram's first stop
        let link = (0..sim.w.g.links.len() as u32).find(|&l| {
            let lk = &sim.w.g.links[l as usize];
            sim.w.g.nodes[lk.from as usize].osm == 5 && sim.w.g.nodes[lk.to as usize].osm == 1
        }).unwrap();
        let i = sim.w.spawn_car(link, 0, 120.0, 0.0, 0);
        let pat = PatSpec { edges: vec![0], start: 0.0, stops: vec![35.0, 380.0], len: 30.0, mode: M_STREETCAR };
        add_feed(&mut sim.rail, 1, &[pat], &[(0u32, 30000, vec![0u16, 600], vec![1u16, 0], -1)]);
        let mut t = 30000.0;
        for _ in 0..600 {
            t += 0.1;
            sim.w.tod = t;
            // keep the car parked
            sim.w.cars[i].v = 0.0;
            sim.w.write_cars(0.0, 0.0);
            sim.rail_step(0.1, t);
        }
        let tr = &sim.rail.trains[0];
        let car_rear_y = sim.w.cars[i].pose.y - sim.w.cars[i].len as f64 * 0.5;
        let front_y = 312.0 + tr.front as f64;
        assert!(front_y < car_rear_y - 0.5, "tram front {front_y} into car rear {car_rear_y}");
        assert!(front_y > car_rear_y - 8.0, "tram closed up: {front_y} vs {car_rear_y}");
    }
}
