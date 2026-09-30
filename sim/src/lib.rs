//! Agent-based local traffic + pedestrian simulation for the GTA viewer.
//!
//! The crate is plain Rust (tested with `cargo test`); `Sim` is the thin
//! wasm-bindgen facade the Web Worker drives (see app/src/sim/sim.worker.ts).

pub mod collide;
pub mod demand;
pub mod graph;
pub mod idm;
pub mod peds;
pub mod rng;
pub mod signal;
pub mod world;

use wasm_bindgen::prelude::*;

use graph::TileData;
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
}

#[wasm_bindgen]
impl Sim {
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u32, max_cars: u32, max_peds: u32) -> Sim {
        Sim { w: World::new(seed as u64, max_cars as usize, max_peds as usize), majors: Majors::default() }
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

    pub fn set_fast(&mut self, fast: bool) {
        self.w.fast = fast;
    }

    /// write render records relative to (origin_e, origin_n)
    pub fn write_output(&mut self, origin_e: f64, origin_n: f64) {
        self.w.write_cars(origin_e, origin_n);
        self.w.peds.write(&self.w.g, origin_e, origin_n);
        self.w.write_signals(origin_e, origin_n);
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

    /// [target cars, target peds, cars, peds, live links, tiles]
    pub fn stats(&self) -> Vec<f32> {
        vec![
            self.w.target_cars,
            self.w.peds.target,
            self.w.cars.len() as f32,
            self.w.peds.list.len() as f32,
            self.w.g.live_links as f32,
            self.w.g.tiles.len() as f32,
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
}
