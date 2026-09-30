//! The simulation world: road graph + car agents (IDM, lane changes, junction
//! control, routing) + pedestrians + the player car + external obstacles
//! (surface transit vehicles fed from the renderer).
//!
//! Car geometry: `s` is the position of the car's *front bumper* along its
//! link; the body occupies [s - len, s]. Every node is crossed on a smooth
//! quadratic path (the junction "box") from the stop line of the incoming
//! lane to the start of the outgoing lane; at controlled nodes cars reserve
//! their path before entering and never enter while a conflicting path is
//! occupied (see `can_enter`).

use std::f32::consts::PI;

use crate::bus::{BusAgent, BusPattern, BusState, BF_BRAKE, BF_DOORS, BF_DWELL, BF_NIS, BUS_DWELL, BUS_STRIDE};
use crate::collide::{obb_overlap, Footprints, Obb};
use crate::demand::{self, FLAG_BRIDGE, FLAG_LINK, FLAG_TUNNEL};
use crate::graph::{classify_turn, wrap_pi, Control, Graph, Pose, Turn, LANE_W, MAXL, NONE};
use crate::idm::{self, IdmParams};
use crate::peds::Peds;
use crate::rng::Rng;
use crate::signal::Light;

pub const F_COMMIT: u8 = 1;
pub const F_PLAYER: u8 = 2;
pub const F_DEAD: u8 = 4;
/// held at a junction gate this step (yielding / reservation refused)
pub const F_HELD: u8 = 8;

/// floats per car record in the output buffer
pub const CAR_STRIDE: usize = 8;
pub const NO_LANE: u8 = 255;
/// 12 m grid cell key of (x, y) shifted by (dx, dy) cells
#[inline]
fn pcell(x: f64, y: f64, dx: i64, dy: i64) -> u64 {
    let cx = (x / 12.0).floor() as i64 + dx + (1 << 20);
    let cy = (y / 12.0).floor() as i64 + dy + (1 << 20);
    ((cx as u64) << 22) | (cy as u64 & 0x3f_ffff)
}

/// links shorter than this: the link after them is chosen in advance (see choose_next)
const SHORT_LINK: f32 = 30.0;
/// samples along a junction path
pub const NS: usize = 13;
/// two junction paths conflict where they come closer than this (m)
const CONFLICT_D: f32 = 2.7;
/// half box on uncontrolled nodes: smooth corner / lane shift (m)
const FREE_SB: f32 = 4.0;
/// body half widths per vehicle kind (m)
pub const HALF_W: [f32; idm::KINDS] = [0.92, 0.9, 0.98, 1.01, 1.0, 1.25];
/// player car body (sedan)
const PLAYER_HL: f32 = 2.35;
const PLAYER_HW: f32 = 0.92;

/// obstacle flags (external vehicles)
pub const OB_DOORS_KNOWN: u8 = 1;
pub const OB_DOORS: u8 = 2;
pub const OB_RAIL: u8 = 4;
/// floats per obstacle in `set_obstacles`
pub const OB_STRIDE: usize = 7;

#[derive(Clone)]
pub struct Car {
    pub id: u32,
    pub link: u32,
    pub lgen: u32,
    pub lane: u8,
    /// front bumper position along the link (m)
    pub s: f32,
    pub v: f32,
    pub a: f32,
    pub next: u32,
    pub ngen: u32,
    pub turn: Turn,
    /// link (and lane) the car came from: its rear may still be there / in the box
    pub prev: u32,
    pub pgen: u32,
    pub prev_lane: u8,
    pub kind: u8,
    pub color: u8,
    pub len: f32,
    pub idm: IdmParams,
    /// desired-speed factor of this driver
    pub vf: f32,
    pub dest: [f64; 2],
    pub flags: u8,
    /// time spent stopped at a stop line
    pub wait: f32,
    /// time spent held at a junction gate by conflicts
    pub wait_conf: f32,
    /// lane change in progress: lane being left (NO_LANE = none), progress 0..1, duration s
    pub lc_from: u8,
    pub lc_t: f32,
    pub lc_dur: f32,
    /// render-only positional offset (e.g. after the player releases the car)
    pub blend: [f32; 3],
    pub lc_cool: f32,
    /// last rendered pose (centre of the body)
    pub pose: Pose,
    pub posed: bool,
    /// bus agent (index into World::buses) or NONE
    pub bus: u32,
    /// link chosen after the next one when the next is inside a split junction (NONE)
    pub next2: u32,
}

pub struct Player {
    pub x: f64,
    pub y: f64,
    pub z: f32,
    pub h: f32,
    pub p: f32,
    pub v: f32,
    pub steer: f32,
    pub on_road: bool,
    pub edge: u32,
    pub id: u32,
    pub placed: bool,
    /// on a bridge / in a tunnel: elevation is the graph's, not the terrain's
    pub structure: bool,
    /// last collision impulse (m/s), for effects
    pub bump: f32,
}

/// Quadratic junction path: stop line of the in-lane → start of the out-lane.
#[derive(Clone, Copy, Debug)]
pub struct Bez {
    pub p0: [f64; 3],
    pub c1: [f64; 2],
    pub c2: [f64; 2],
    pub p2: [f64; 3],
}

impl Bez {
    /// cubic from a quadratic control point
    pub fn quad(p0: [f64; 3], p1: [f64; 2], p2: [f64; 3]) -> Bez {
        let k = 2.0 / 3.0;
        Bez {
            p0,
            c1: [p0[0] + (p1[0] - p0[0]) * k, p0[1] + (p1[1] - p0[1]) * k],
            c2: [p2[0] + (p1[0] - p2[0]) * k, p2[1] + (p1[1] - p2[1]) * k],
            p2,
        }
    }
    #[inline]
    pub fn at(&self, u: f32) -> (f64, f64, f32) {
        let u = u.clamp(0.0, 1.0) as f64;
        let v = 1.0 - u;
        let (w0, w1, w2, w3) = (v * v * v, 3.0 * u * v * v, 3.0 * u * u * v, u * u * u);
        (
            w0 * self.p0[0] + w1 * self.c1[0] + w2 * self.c2[0] + w3 * self.p2[0],
            w0 * self.p0[1] + w1 * self.c1[1] + w2 * self.c2[1] + w3 * self.p2[1],
            (self.p0[2] + (self.p2[2] - self.p0[2]) * u) as f32,
        )
    }
    /// NS samples relative to (cx, cy)
    pub fn samples(&self, cx: f64, cy: f64) -> [[f32; 2]; NS] {
        let mut out = [[0.0f32; 2]; NS];
        for (k, o) in out.iter_mut().enumerate() {
            let (x, y, _) = self.at(k as f32 / (NS - 1) as f32);
            *o = [(x - cx) as f32, (y - cy) as f32];
        }
        out
    }
}

/// Cached junction path, parametrised by arc length.
#[derive(Clone, Copy)]
pub struct BoxPath {
    pub link: u32,
    pub next: u32,
    pub lane: u8,
    pub tl: u8,
    pub ver: u32,
    pub node: u32,
    pub bez: Bez,
    /// normalised cumulative arc length at u = k/8
    pub arc: [f32; 9],
    /// drawn length over the sim distance it stands for (setback in + setback out):
    /// < 1 where the path is shorter than the two legs it replaces (sharp turns)
    pub r: f32,
    /// NS samples at equal arc-length steps, relative to the node
    pub pts: [[f32; 2]; NS],
}

impl BoxPath {
    pub const NONE: BoxPath = BoxPath {
        link: NONE,
        next: NONE,
        lane: 0,
        tl: 0,
        ver: 0,
        node: NONE,
        bez: Bez { p0: [0.0; 3], c1: [0.0; 2], c2: [0.0; 2], p2: [0.0; 3] },
        arc: [0.0; 9],
        r: 1.0,
        pts: [[0.0; 2]; NS],
    };

    #[inline]
    pub fn matches(&self, link: u32, lane: u8, next: u32, tl: u8, ver: u32) -> bool {
        self.link == link && self.next == next && self.lane == lane && self.tl == tl && self.ver == ver
    }

    /// point at arc-length fraction `f`
    #[inline]
    pub fn at(&self, f: f32) -> (f64, f64, f32) {
        let f = f.clamp(0.0, 1.0);
        let mut k = 0;
        while k < 7 && self.arc[k + 1] < f {
            k += 1;
        }
        let d = self.arc[k + 1] - self.arc[k];
        let t = if d > 1e-6 { ((f - self.arc[k]) / d).clamp(0.0, 1.0) } else { 0.0 };
        self.bez.at((k as f32 + t) / 8.0)
    }
}

/// A vehicle occupying (or holding a reservation for) a junction.
#[derive(Clone, Copy)]
struct Occ {
    /// car index, or NONE for an external obstacle
    car: u32,
    in_link: u32,
    in_lane: u8,
    /// first sample still ahead of the vehicle's rear
    from: u8,
    nx: u32,
    pts: [[f32; 2]; NS],
}

/// External vehicle (surface transit) — front-centre pose.
#[derive(Clone, Copy, Debug)]
pub struct Obst {
    pub x: f64,
    pub y: f64,
    pub h: f32,
    pub len: f32,
    pub w: f32,
    pub v: f32,
    pub flags: u8,
}

/// An obstacle's footprint on one link: lanes (bit mask) and [s0, s1] along the link.
#[derive(Clone, Copy, Debug)]
pub struct ObLink {
    pub link: u32,
    pub mask: u8,
    pub s0: f32,
    pub s1: f32,
    pub v: f32,
}

pub struct World {
    pub g: Graph,
    pub rng: Rng,
    pub cars: Vec<Car>,
    next_id: u32,
    keys: Vec<(u64, u32)>,
    order: Vec<u32>,
    lead: Vec<u32>,
    /// per car: junction path drawn/sim length ratio under its body (see box_ratio)
    rbox: Vec<f32>,
    /// car body centres by 12 m cell (sorted (cell key, car)) for the physical look-ahead
    pgrid: Vec<(u64, u32)>,
    ov_young: u32,
    acc: Vec<f32>,
    lim: Vec<f32>,
    step_no: u32,
    pub tod: f64,
    pub weekday: u32,
    pub mono: f64,
    pub focus: (f64, f64),
    pub radius: f64,
    pub max_cars: usize,
    active: Vec<u32>,
    cum_w: Vec<f32>,
    pub target_cars: f32,
    active_version: u32,
    active_at: f64,
    active_focus: (f64, f64),
    pub peds: Peds,
    pub player: Option<Player>,
    pub out_cars: Vec<f32>,
    pub out_signals: Vec<f32>,
    tmp: Vec<u32>,
    /// true while sim time is being dropped (very high speed-ups)
    pub fast: bool,
    // junction occupancy (rebuilt every step): per-node list heads + touched nodes
    occ: Vec<Occ>,
    occ_head: Vec<u32>,
    occ_nodes: Vec<u32>,
    /// cached junction paths per car (aligned with `cars`): [approach, exit]
    bp: Vec<[BoxPath; 2]>,
    /// cars in the middle of a lane change: (link << 8 | lane being left, s, index), sorted
    ghosts: Vec<(u64, f32, u32)>,
    // external obstacles
    pub obst: Vec<Obst>,
    pub ob_links: Vec<ObLink>,
    ob_box: Vec<(u32, [[f32; 2]; NS])>,
    /// building outlines for player collisions
    pub fp: Footprints,
    ped_boxes: Vec<(u32, [[f32; 2]; NS], u8)>,
    /// accumulated ms per phase [validate sort occ accel lanechg advance spawn peds]
    pub prof: [f64; 8],
    // buses (bus.rs)
    pub bus_pats: std::collections::HashMap<u32, BusPattern>,
    pub buses: Vec<Option<BusAgent>>,
    bus_free: Vec<u32>,
    pub out_buses: Vec<f32>,
    pub out_bus_path: Vec<f32>,
    /// buses that stopped being agents since the last output: [trip, delay]
    pub bus_gone: Vec<f32>,
    /// camera (sims avoid spawning / removing agents in plain view)
    pub camera: crate::view::Camera,
    /// railway level crossings: (E, N, state 0 idle / 1 warning / 2 gates down)
    pub xings: Vec<(f64, f64, u8)>,
    /// crossing stop bars per road link: (crossing, stop bar s, far side s)
    xmarks: std::collections::HashMap<u32, Vec<(u32, f32, f32)>>,
    xmarks_ver: u32,
    xmarks_focus: (f64, f64),
}

/// phase timer (native: Instant; wasm: performance.now())
struct Prof {
    t: f64,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
extern "C" {
    #[wasm_bindgen::prelude::wasm_bindgen(js_namespace = performance, js_name = now)]
    fn perf_now() -> f64;
}

#[inline]
fn now_ms() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        perf_now()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        use std::sync::OnceLock;
        static T0: OnceLock<std::time::Instant> = OnceLock::new();
        T0.get_or_init(std::time::Instant::now).elapsed().as_secs_f64() * 1000.0
    }
}

impl Prof {
    #[inline]
    fn start() -> Self {
        Prof { t: now_ms() }
    }
    #[inline]
    fn lap(&mut self, acc: &mut f64) {
        let n = now_ms();
        *acc += n - self.t;
        self.t = n;
    }
}

#[inline]
fn quant_key(link: u32, lane: u8, s: f32) -> u64 {
    let q = (s.max(0.0) * 16.0) as u64;
    ((link as u64) << 32) | ((lane as u64) << 29) | (0x1FFF_FFFF - q.min(0x1FFF_FFFF))
}

/// lane on the next link after a turn
#[inline]
pub fn target_lane(lane: u8, lanes_next: u8, turn: Turn) -> u8 {
    match turn {
        Turn::Right => 0,
        Turn::Left | Turn::U => lanes_next - 1,
        Turn::Straight => lane.min(lanes_next - 1),
    }
}

#[inline]
fn smooth(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn conflict(a: &[[f32; 2]; NS], af: usize, b: &[[f32; 2]; NS], bf: usize) -> bool {
    let d2 = CONFLICT_D * CONFLICT_D;
    for p in &a[af..] {
        for q in &b[bf..] {
            let (dx, dy) = (p[0] - q[0], p[1] - q[1]);
            if dx * dx + dy * dy < d2 {
                return true;
            }
        }
    }
    false
}

const CLASS_W: [f32; 7] = [6.0, 5.0, 4.0, 3.0, 2.2, 1.0, 0.25];

fn pick_kind(rng: &mut Rng, class: u8) -> u8 {
    // share: sedan, hatch, suv, pickup, van, truck
    let w: [f32; 6] = if class <= 1 { [0.30, 0.10, 0.27, 0.11, 0.08, 0.14] } else { [0.36, 0.15, 0.28, 0.09, 0.07, 0.05] };
    rng.pick(&w).unwrap_or(0) as u8
}

impl World {
    pub fn new(seed: u64, max_cars: usize, max_peds: usize) -> Self {
        World {
            g: Graph::default(),
            rng: Rng::new(seed),
            cars: Vec::new(),
            next_id: 1,
            keys: Vec::new(),
            order: Vec::new(),
            lead: Vec::new(),
            rbox: Vec::new(),
            pgrid: Vec::new(),
            ov_young: 0,
            acc: Vec::new(),
            lim: Vec::new(),
            step_no: 1,
            tod: 8.0 * 3600.0,
            weekday: 2,
            mono: 0.0,
            focus: (0.0, 0.0),
            radius: 1500.0,
            max_cars,
            active: Vec::new(),
            cum_w: Vec::new(),
            target_cars: 0.0,
            active_version: u32::MAX,
            active_at: -1e9,
            active_focus: (1e12, 1e12),
            peds: Peds::new(max_peds),
            player: None,
            out_cars: Vec::new(),
            out_signals: Vec::new(),
            tmp: Vec::new(),
            fast: false,
            occ: Vec::new(),
            occ_head: Vec::new(),
            occ_nodes: Vec::new(),
            bp: Vec::new(),
            ghosts: Vec::new(),
            obst: Vec::new(),
            ob_links: Vec::new(),
            ob_box: Vec::new(),
            fp: Footprints::default(),
            ped_boxes: Vec::new(),
            prof: [0.0; 8],
            bus_pats: std::collections::HashMap::new(),
            buses: Vec::new(),
            bus_free: Vec::new(),
            out_buses: Vec::new(),
            out_bus_path: Vec::new(),
            bus_gone: Vec::new(),
            camera: None,
            xings: Vec::new(),
            xmarks: std::collections::HashMap::new(),
            xmarks_ver: u32::MAX,
            xmarks_focus: (1e12, 1e12),
        }
    }

    // ------------------------------------------------------------------ demand / active set

    fn refresh_active(&mut self, force: bool) {
        let moved = (self.focus.0 - self.active_focus.0).hypot(self.focus.1 - self.active_focus.1);
        if !force && self.active_version == self.g.version && moved < 60.0 && self.mono - self.active_at < 3.0 {
            return;
        }
        self.active_version = self.g.version;
        self.active_at = self.mono;
        self.active_focus = self.focus;
        self.active.clear();
        self.cum_w.clear();
        let r2 = self.radius * self.radius;
        let mut acc = 0.0f32;
        for (i, l) in self.g.links.iter().enumerate() {
            if !l.alive {
                continue;
            }
            let a = &self.g.nodes[l.from as usize];
            let b = &self.g.nodes[l.to as usize];
            let mx = (a.x + b.x) * 0.5 - self.focus.0;
            let my = (a.y + b.y) * 0.5 - self.focus.1;
            if mx * mx + my * my > r2 || l.len < 8.0 {
                continue;
            }
            let e = &self.g.edges[l.edge as usize];
            let d = demand::car_density(l.class, l.flags, e.bottleneck, self.tod, self.weekday)
                * if l.class >= 2 { demand::core_factor(mx + self.focus.0, my + self.focus.1) } else { 1.0 };
            let w = d * l.len * 0.001 * l.lanes as f32;
            if w <= 0.0 {
                continue;
            }
            acc += w;
            self.active.push(i as u32);
            self.cum_w.push(acc);
        }
        self.target_cars = acc.min(self.max_cars as f32);
    }

    // ------------------------------------------------------------------ main step

    pub fn step(&mut self, dt: f32) {
        self.tod += dt as f64;
        self.mono += dt as f64;
        self.step_no = self.step_no.wrapping_add(1).max(1);
        let mut t = Prof::start();
        self.refresh_active(false);
        self.validate();
        // remove dead cars before sorting: `order` indices stay valid until the next step
        self.cull();
        t.lap(&mut self.prof[0]);
        self.sort();
        self.update_paths();
        t.lap(&mut self.prof[1]);
        self.build_occupancy();
        self.refresh_xmarks();
        t.lap(&mut self.prof[2]);
        self.compute_accel(dt);
        t.lap(&mut self.prof[3]);
        self.lane_changes(dt);
        t.lap(&mut self.prof[4]);
        self.advance(dt);
        self.bus_stops();
        self.advance_obstacles(dt);
        t.lap(&mut self.prof[5]);
        self.spawn();
        t.lap(&mut self.prof[6]);
        // vehicle paths through junctions (pedestrians wait for them)
        let mut boxes = std::mem::take(&mut self.ped_boxes);
        boxes.clear();
        for &node in &self.occ_nodes {
            let mut k = self.occ_head[node as usize];
            while k != NONE {
                let o = &self.occ[k as usize];
                boxes.push((node, o.pts, o.from));
                k = o.nx;
            }
        }
        boxes.sort_unstable_by_key(|b| b.0);
        self.peds.step(&self.g, &mut self.rng, dt, self.tod, self.weekday, self.mono, self.focus, &boxes);
        self.ped_boxes = boxes;
        t.lap(&mut self.prof[7]);
    }

    /// drop cars whose link was evicted; re-route cars whose next link vanished
    fn validate(&mut self) {
        let r2 = (self.radius * 1.12 + 100.0).powi(2);
        let (fx, fy) = self.focus;
        for i in 0..self.cars.len() {
            let c = &self.cars[i];
            if c.flags & F_PLAYER != 0 {
                continue;
            }
            let l = &self.g.links[c.link as usize];
            if !l.alive || l.gen != c.lgen {
                self.cars[i].flags |= F_DEAD;
                continue;
            }
            let n = &self.g.nodes[l.to as usize];
            if (n.x - fx).powi(2) + (n.y - fy).powi(2) > r2 {
                self.cars[i].flags |= F_DEAD;
                continue;
            }
            if c.prev != NONE {
                let pl = &self.g.links[c.prev as usize];
                if !pl.alive || pl.gen != c.pgen || pl.to != l.from {
                    self.cars[i].prev = NONE;
                }
            }
            let c = &self.cars[i];
            if c.next != NONE {
                let nl = &self.g.links[c.next as usize];
                if !nl.alive || nl.gen != c.ngen || nl.from != l.to {
                    self.cars[i].flags &= !F_COMMIT;
                    self.choose_next(i);
                }
            }
        }
    }

    fn sort(&mut self) {
        self.keys.clear();
        for (i, c) in self.cars.iter().enumerate() {
            if c.link == NONE || c.flags & F_DEAD != 0 {
                continue;
            }
            self.keys.push((quant_key(c.link, c.lane, c.s), i as u32));
        }
        self.keys.sort_unstable_by_key(|k| k.0);
        self.order.clear();
        self.order.extend(self.keys.iter().map(|k| k.1));
        let stamp = self.step_no;
        for (r, &(k, _)) in self.keys.iter().enumerate() {
            let link = (k >> 32) as usize;
            let lane = ((k >> 29) & 7) as usize;
            let l = &mut self.g.links[link];
            if l.stamp != stamp {
                l.stamp = stamp;
                l.head = [NONE; MAXL];
                l.tail = [NONE; MAXL];
            }
            if lane < MAXL {
                if l.head[lane] == NONE {
                    l.head[lane] = r as u32;
                }
                l.tail[lane] = r as u32;
            }
        }
        self.lead.clear();
        self.lead.resize(self.cars.len(), NONE);
        for r in 1..self.keys.len() {
            if self.keys[r].0 >> 29 == self.keys[r - 1].0 >> 29 {
                self.lead[self.keys[r].1 as usize] = self.keys[r - 1].1;
            }
        }
        // lane changers still (partly) occupy the lane they are leaving
        self.ghosts.clear();
        for (i, c) in self.cars.iter().enumerate() {
            if c.lc_from != NO_LANE && c.flags & (F_DEAD | F_PLAYER) == 0 {
                self.ghosts.push((((c.link as u64) << 8) | c.lc_from as u64, c.s, i as u32));
            }
        }
        self.ghosts.sort_unstable_by(|a, b| a.0.cmp(&b.0).then(a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal)));
    }

    #[inline]
    fn lane_range(&self, link: u32, lane: u8) -> Option<(usize, usize)> {
        let l = &self.g.links[link as usize];
        if l.stamp != self.step_no || lane as usize >= MAXL || l.head[lane as usize] == NONE {
            return None;
        }
        Some((l.head[lane as usize] as usize, l.tail[lane as usize] as usize))
    }

    /// last (upstream-most) car in a lane
    #[inline]
    fn lane_tail(&self, link: u32, lane: u8) -> Option<usize> {
        self.lane_range(link, lane).map(|(_, t)| self.order[t] as usize)
    }

    /// cars ahead/behind position `s` in a lane: (leader, follower)
    fn neighbours(&self, link: u32, lane: u8, s: f32, skip: usize) -> (Option<usize>, Option<usize>) {
        let Some((h, t)) = self.lane_range(link, lane) else { return (None, None) };
        // order is by s descending within [h, t]
        let (mut lo, mut hi) = (h, t + 1);
        while lo < hi {
            let m = (lo + hi) / 2;
            if self.cars[self.order[m] as usize].s > s {
                lo = m + 1;
            } else {
                hi = m;
            }
        }
        let mut leader = if lo > h { Some(self.order[lo - 1] as usize) } else { None };
        let mut follower = if lo <= t { Some(self.order[lo] as usize) } else { None };
        if leader == Some(skip) {
            leader = if lo >= h + 2 { Some(self.order[lo - 2] as usize) } else { None };
        }
        if follower == Some(skip) {
            follower = if lo + 1 <= t { Some(self.order[lo + 1] as usize) } else { None };
        }
        (leader, follower)
    }

    /// nearest lane changer leaving (link, lane) ahead of `s`: (rear s, v)
    fn ghost_ahead(&self, link: u32, lane: u8, s: f32, skip: usize) -> Option<(f32, f32)> {
        if self.ghosts.is_empty() {
            return None;
        }
        let key = ((link as u64) << 8) | lane as u64;
        let a = self.ghosts.partition_point(|g| g.0 < key || (g.0 == key && g.1 <= s));
        for g in &self.ghosts[a..] {
            if g.0 != key {
                break;
            }
            if g.2 as usize == skip {
                continue;
            }
            let c = &self.cars[g.2 as usize];
            return Some((c.s - c.len, c.v));
        }
        None
    }

    /// any lane changer leaving (link, lane) whose body overlaps [lo, hi]
    fn ghost_near(&self, link: u32, lane: u8, lo: f32, hi: f32, skip: usize) -> bool {
        if self.ghosts.is_empty() {
            return false;
        }
        let key = ((link as u64) << 8) | lane as u64;
        let a = self.ghosts.partition_point(|g| g.0 < key || (g.0 == key && g.1 < lo));
        for g in &self.ghosts[a..] {
            if g.0 != key {
                break;
            }
            let c = &self.cars[g.2 as usize];
            if g.2 as usize != skip && c.s - c.len < hi {
                return true;
            }
        }
        false
    }

    // ------------------------------------------------------------------ junction geometry

    /// junction half-box on the incoming side of `link`'s end node (stop line distance)
    #[inline]
    pub fn sb_in(&self, link: u32) -> f32 {
        let l = &self.g.links[link as usize];
        let n = &self.g.nodes[l.to as usize];
        let sb = if n.setback > 0.0 { n.setback } else { FREE_SB };
        sb.min(l.len * 0.45)
    }

    /// junction half-box at the start of `link`
    #[inline]
    pub fn sb_out(&self, link: u32) -> f32 {
        let l = &self.g.links[link as usize];
        let n = &self.g.nodes[l.from as usize];
        let sb = if n.setback > 0.0 { n.setback } else { FREE_SB };
        sb.min(l.len * 0.45)
    }

    /// path through the node between two lanes
    pub fn bez(&self, link: u32, lane: u8, next: u32, tl: u8) -> Bez {
        let l = &self.g.links[link as usize];
        let nl = &self.g.links[next as usize];
        let a = self.sb_in(link);
        let b = self.sb_out(next);
        let pa = self.g.link_pose(link, l.len - a, self.g.lane_offset(l, lane.min(l.lanes - 1)));
        let pb = self.g.link_pose(next, b, self.g.lane_offset(nl, tl.min(nl.lanes - 1)));
        let (da, db) = ((pa.h.cos() as f64, pa.h.sin() as f64), (pb.h.cos() as f64, pb.h.sin() as f64));
        let (dx, dy) = (pb.x - pa.x, pb.y - pa.y);
        let chord = dx.hypot(dy);
        let (p0, p2) = ([pa.x, pa.y, pa.z as f64], [pb.x, pb.y, pb.z as f64]);
        let dot = da.0 * db.0 + da.1 * db.1;
        let cross = da.0 * db.1 - da.1 * db.0;
        if cross.abs() > 0.08 {
            // intersection of the two lane tangents
            let t = (dx * db.1 - dy * db.0) / cross;
            let u = (dx * da.1 - dy * da.0) / cross;
            if t > 0.05 * chord && t < 1.2 * chord && u > 0.05 * chord && u < 1.2 * chord {
                return Bez::quad(p0, [pa.x + da.0 * t, pa.y + da.1 * t], p2);
            }
        } else if chord > 0.5 && dot > 0.0 {
            // (nearly) straight through, possibly with a lane shift: S-free simple blend
            return Bez::quad(p0, [(pa.x + pb.x) * 0.5, (pa.y + pb.y) * 0.5], p2);
        }
        // sharp turns (U-turns through a median gap) and tangents that do not meet ahead:
        // leave along the lane and arrive along the next lane (a straight chord could point
        // sideways or backwards)
        // (a U-turn needs room to swing round even when both ends are close together)
        let k = if dot < -0.3 { (0.66 * chord).max(3.5) } else { (0.4 * chord).max(1.5) }.min(25.0);
        Bez { p0, c1: [pa.x + da.0 * k, pa.y + da.1 * k], c2: [pb.x - db.0 * k, pb.y - db.1 * k], p2 }
    }

    /// Junction path between two lanes, parametrised by arc length.
    pub fn box_path(&self, link: u32, lane: u8, next: u32, tl: u8) -> BoxPath {
        let bez = self.bez(link, lane, next, tl);
        let mut arc = [0.0f32; 9];
        let mut prev = bez.at(0.0);
        for k in 1..9 {
            let p = bez.at(k as f32 / 8.0);
            arc[k] = arc[k - 1] + ((p.0 - prev.0).hypot(p.1 - prev.1)) as f32;
            prev = p;
        }
        let total = arc[8].max(1e-3);
        for a in arc.iter_mut() {
            *a /= total;
        }
        let node = self.zone_of(self.g.links[link as usize].to);
        let n = &self.g.nodes[node as usize];
        let r = (total / (self.sb_in(link) + self.sb_out(next)).max(0.1)).min(1.5);
        let mut bp = BoxPath { link, next, lane, tl, ver: self.g.version, node, bez, arc, r, pts: [[0.0; 2]; NS] };
        for k in 0..NS {
            let (x, y, _) = bp.at(k as f32 / (NS - 1) as f32);
            bp.pts[k] = [(x - n.x) as f32, (y - n.y) as f32];
        }
        bp
    }

    /// approach path of car `i` (cached when fresh)
    fn path_in(&self, i: usize) -> BoxPath {
        let c = &self.cars[i];
        let nl = &self.g.links[c.next as usize];
        let tl = target_lane(c.lane, nl.lanes, c.turn);
        let bp = &self.bp[i][0];
        if bp.matches(c.link, c.lane, c.next, tl, self.g.version) {
            *bp
        } else {
            self.box_path(c.link, c.lane, c.next, tl)
        }
    }

    /// exit path of car `i` (from its previous link)
    fn path_out(&self, i: usize) -> BoxPath {
        let c = &self.cars[i];
        let bp = &self.bp[i][1];
        if bp.matches(c.prev, c.prev_lane, c.link, c.lane, self.g.version) {
            *bp
        } else {
            self.box_path(c.prev, c.prev_lane, c.link, c.lane)
        }
    }

    /// refresh cached junction paths of cars near a junction
    fn update_paths(&mut self) {
        let ver = self.g.version;
        for i in 0..self.cars.len() {
            let c = &self.cars[i];
            if c.flags & (F_DEAD | F_PLAYER) != 0 || c.link == NONE {
                continue;
            }
            let l = &self.g.links[c.link as usize];
            if c.next != NONE && self.g.links[c.next as usize].alive && l.len - c.s < self.sb_in(c.link) + 60.0 {
                let nl = &self.g.links[c.next as usize];
                let tl = target_lane(c.lane, nl.lanes, c.turn);
                if !self.bp[i][0].matches(c.link, c.lane, c.next, tl, ver) {
                    self.bp[i][0] = self.box_path(c.link, c.lane, c.next, tl);
                }
            }
            let c = &self.cars[i];
            if self.prev_ok(c) && c.s - c.len < self.sb_out(c.link) && !self.bp[i][1].matches(c.prev, c.prev_lane, c.link, c.lane, ver) {
                self.bp[i][1] = self.box_path(c.prev, c.prev_lane, c.link, c.lane);
            }
        }
    }

    /// conflict zone of a node (its cluster root)
    #[inline]
    pub fn zone_of(&self, node: u32) -> u32 {
        let z = self.g.nodes[node as usize].zone;
        if z == NONE || !self.g.nodes[z as usize].alive {
            node
        } else {
            z
        }
    }

    #[inline]
    fn structural(&self, link: u32) -> bool {
        self.g.links[link as usize].flags & (FLAG_BRIDGE | FLAG_TUNNEL) != 0
    }

    /// lateral offset left of a lane change at progress `t`
    #[inline]
    fn lc_lat(&self, c: &Car, t: f32) -> f32 {
        if c.lc_from == NO_LANE {
            return 0.0;
        }
        let l = &self.g.links[c.link as usize];
        if c.lc_from >= l.lanes {
            return 0.0;
        }
        (self.g.lane_offset(l, c.lc_from) - self.g.lane_offset(l, c.lane)) * (1.0 - smooth(t))
    }

    #[inline]
    fn prev_ok(&self, c: &Car) -> bool {
        if c.prev == NONE {
            return false;
        }
        let pl = &self.g.links[c.prev as usize];
        pl.alive && pl.gen == c.pgen && pl.to == self.g.links[c.link as usize].from
    }

    /// World point on car `i`'s path `back` metres behind its front bumper
    /// (x, y, z, on a structure). `t_lc` = lane change progress at that point.
    pub fn car_point(&self, i: usize, back: f32, t_lc: f32) -> (f64, f64, f32, bool) {
        let c = &self.cars[i];
        let l = &self.g.links[c.link as usize];
        let sp = c.s - back;
        if c.next != NONE && sp > 0.0 {
            let a = self.sb_in(c.link);
            if sp > l.len - a && self.g.links[c.next as usize].alive {
                let b = self.sb_out(c.next);
                let (x, y, z) = self.path_in(i).at((sp - (l.len - a)) / (a + b));
                return (x, y, z, self.structural(c.link) || self.structural(c.next));
            }
        }
        if self.prev_ok(c) {
            let pl = &self.g.links[c.prev as usize];
            let a = self.sb_in(c.prev);
            let b = self.sb_out(c.link);
            if sp < b && sp > -a {
                let (x, y, z) = self.path_out(i).at((a + sp) / (a + b));
                return (x, y, z, self.structural(c.link) || self.structural(c.prev));
            }
            if sp <= -a {
                let (x, y, z) = self.g.link_xyz(c.prev, (pl.len + sp).max(0.0), self.g.lane_offset(pl, c.prev_lane.min(pl.lanes - 1)));
                return (x, y, z, self.structural(c.prev));
            }
        }
        let (x, y, z) = self.g.link_xyz(c.link, sp.max(0.0), self.g.lane_offset(l, c.lane) + self.lc_lat(c, t_lc));
        (x, y, z, self.structural(c.link))
    }

    /// stop bars of the level crossings near the focus on the road links that cross them
    fn refresh_xmarks(&mut self) {
        if self.xings.is_empty() {
            return;
        }
        let moved = (self.focus.0 - self.xmarks_focus.0).hypot(self.focus.1 - self.xmarks_focus.1);
        if self.xmarks_ver == self.g.version && moved < 300.0 {
            return;
        }
        self.xmarks_ver = self.g.version;
        self.xmarks_focus = self.focus;
        self.xmarks.clear();
        let r = self.radius + 400.0;
        let mut near = Vec::new();
        for (ci, &(x, y, _)) in self.xings.iter().enumerate() {
            if (x - self.focus.0).hypot(y - self.focus.1) > r {
                continue;
            }
            self.g.edges_near(x, y, 12.0, &mut near);
            for &eid in &near {
                let e = &self.g.edges[eid as usize];
                if !e.alive || e.flags & crate::demand::FLAG_TUNNEL != 0 || e.flags & crate::demand::FLAG_BRIDGE != 0 {
                    continue;
                }
                let (se, lat, _, _) = self.g.project_on_edge(eid, x, y);
                if lat.abs() > e.half_w + 1.5 || se <= 0.5 || se >= e.len - 0.5 {
                    continue;
                }
                for (k, &link) in e.links.iter().enumerate() {
                    if link == NONE {
                        continue;
                    }
                    let sc = if k == 0 { se } else { e.len - se };
                    // Transport Canada / OTM Book 11: stop line ~5 m before the nearest rail
                    self.xmarks.entry(link).or_default().push((ci as u32, sc - 5.4, sc + 3.5));
                }
            }
        }
    }

    /// Level crossings: stop at the stop bar while the warning is on (unless too close to
    /// stop safely during the warning) or the gates are down, and never stop on the tracks
    /// (keep clear when the queue ahead would leave the car on them).
    fn crossing_gap(&self, i: usize) -> Option<f32> {
        if self.xmarks.is_empty() {
            return None;
        }
        let c = &self.cars[i];
        let (s, v) = (c.s, c.v);
        let l = &self.g.links[c.link as usize];
        let mut best: Option<f32> = None;
        let mut consider = |ss: f32, sf: f32, off: f32, ci: u32, ahead_same: bool| {
            let d = off + ss - s;
            if d < -0.3 || d > 150.0 {
                return;
            }
            let st = self.xings.get(ci as usize).map_or(0, |x| x.2);
            let stop = match st {
                2 => true,
                1 => v * v / (2.0 * d.max(0.1)) < 4.5,
                _ => {
                    // keep clear: a stopped queue ahead reaching back over the tracks
                    ahead_same
                        && self.lead[i] != NONE
                        && {
                            let ld = &self.cars[self.lead[i] as usize];
                            let rear = ld.s - ld.len;
                            rear > off + ss && rear < off + sf + c.len + 1.0 && ld.v < 2.5
                        }
                }
            };
            if stop {
                best = Some(best.map_or(d.max(0.0), |b: f32| b.min(d.max(0.0))));
            }
        };
        if let Some(ms) = self.xmarks.get(&c.link) {
            for &(ci, ss, sf) in ms {
                consider(ss, sf, 0.0, ci, true);
            }
        }
        if c.next != NONE {
            if let Some(ms) = self.xmarks.get(&c.next) {
                for &(ci, ss, sf) in ms {
                    if ss > 0.0 {
                        consider(ss, sf, l.len, ci, false);
                    }
                }
            }
        }
        best
    }

    /// cars whose body overlaps an occupied crossing (gates down) — must be 0
    pub fn cars_on_closed_crossing(&self) -> u32 {
        let mut n = 0;
        for c in &self.cars {
            if c.flags & F_DEAD != 0 || c.link == NONE {
                continue;
            }
            if let Some(ms) = self.xmarks.get(&c.link) {
                for &(ci, ss, sf) in ms {
                    let st = self.xings.get(ci as usize).map_or(0, |x| x.2);
                    if st == 2 && c.s > ss + 5.4 - 2.0 && c.s - c.len < sf - 3.5 + 2.0 {
                        n += 1;
                    }
                }
            }
        }
        n
    }

    /// a short link whose both ends belong to the same junction conflict zone
    #[inline]
    fn internal_link(&self, link: u32) -> bool {
        let l = &self.g.links[link as usize];
        l.len < 30.0 && self.g.nodes[l.from as usize].control != Control::Free && self.g.nodes[l.to as usize].control != Control::Free && self.zone_of(l.from) == self.zone_of(l.to)
    }

    /// cars stopped (v < 0.5) inside a junction box / on a crosswalk, or on the inside of a
    /// split junction, that are not clearing it (QA: must stay ~0)
    pub fn stopped_in_box(&self) -> u32 {
        // (waiting inside a split junction to complete a turn, e.g. in a median, is clearing)
        let d = self.stopped_in_box_detail();
        d[0] + d[1]
    }

    /// [front past the stop line, rear still in the exit box, on a split-junction inside link]
    pub fn stopped_in_box_detail(&self) -> [u32; 3] {
        let mut n = [0u32; 3];
        for c in &self.cars {
            if c.flags & (F_DEAD | F_PLAYER) != 0 || c.v >= 0.5 || c.link == NONE {
                continue;
            }
            let l = &self.g.links[c.link as usize];
            // (a car that entered legally and waits inside, e.g. to turn left, is clearing)
            let front_in = c.flags & F_COMMIT == 0 && self.g.nodes[l.to as usize].control != Control::Free && c.s > l.len - self.sb_in(c.link) + 0.8;
            let rear_in = self.prev_ok(c) && self.g.nodes[l.from as usize].control != Control::Free && c.s - c.len < self.sb_out(c.link) - 0.8;
            if self.internal_link(c.link) {
                if c.flags & F_COMMIT == 0 {
                    n[2] += 1;
                }
            } else if front_in {
                n[0] += 1;
            } else if rear_in {
                n[1] += 1;
            }
        }
        n
    }

    /// the next car id (cars with an id at or above a remembered value are younger)
    pub fn next_car_id(&self) -> u32 {
        self.next_id
    }

    /// overlap_causes counts, with "spawn" = cars placed since the previous call
    pub fn overlap_counts(&mut self) -> [u32; 10] {
        let young = if self.ov_young == 0 { u32::MAX } else { self.ov_young };
        let (c, _) = self.overlap_causes(young, 0);
        self.ov_young = self.next_id;
        c
    }

    /// junction zone a car's body is in (its entry or exit box), or NONE
    fn car_zone(&self, c: &Car) -> u32 {
        let l = &self.g.links[c.link as usize];
        if c.next != NONE && c.s > l.len - self.sb_in(c.link) {
            return self.zone_of(l.to);
        }
        if self.prev_ok(c) && c.s - c.len < self.sb_out(c.link) {
            return self.zone_of(l.from);
        }
        NONE
    }

    /// smallest drawn/sim length ratio of the junction paths car `i`'s body is on (1 = none)
    pub fn box_ratio(&self, i: usize) -> f32 {
        let c = &self.cars[i];
        let l = &self.g.links[c.link as usize];
        let mut r = 1.0f32;
        if c.next != NONE && self.g.links[c.next as usize].alive && c.s > l.len - self.sb_in(c.link) {
            r = r.min(self.path_in(i).r);
        }
        if self.prev_ok(c) && c.s - c.len < self.sb_out(c.link) {
            r = r.min(self.path_out(i).r);
        }
        r
    }

    /// QA: overlapping car bodies (OBB penetration > 0.35 m) by cause:
    /// [spawn, lane change, short link, junction: different movements, same lane, adjacent lanes,
    ///  merge / converging links, other, junction: one behind the other on the same movement,
    ///  bridge / tunnel against a street at the same height (road data)];
    /// plus up to `nex` examples
    pub fn overlap_causes(&self, young_id: u32, nex: usize) -> ([u32; 10], Vec<String>) {
        let mut out = [0u32; 10];
        let mut ex = Vec::new();
        let mut grid: std::collections::HashMap<(i32, i32), Vec<usize>> = std::collections::HashMap::new();
        let mut boxes = Vec::with_capacity(self.cars.len());
        for (i, c) in self.cars.iter().enumerate() {
            if c.flags & F_DEAD != 0 || c.link == NONE || !self.g.links[c.link as usize].alive {
                boxes.push(None);
                continue;
            }
            let (p, _) = self.car_pose(i);
            let b = Obb { x: p.x, y: p.y, h: p.h, hl: c.len * 0.5 - 0.15, hw: HALF_W[c.kind as usize] - 0.1 };
            grid.entry(((p.x / 10.0).floor() as i32, (p.y / 10.0).floor() as i32)).or_default().push(i);
            boxes.push(Some((b, p.z)));
        }
        for (i, c) in self.cars.iter().enumerate() {
            let Some((b, z)) = boxes[i] else { continue };
            let (cx, cy) = ((b.x / 10.0).floor() as i32, (b.y / 10.0).floor() as i32);
            for dx in -1..=1 {
                for dy in -1..=1 {
                    let Some(v) = grid.get(&(cx + dx, cy + dy)) else { continue };
                    for &j in v {
                        let Some((bj, zj)) = boxes[j] else { continue };
                        if j <= i || (zj - z).abs() > 3.0 {
                            continue;
                        }
                        if !obb_overlap(&b, &bj).map_or(false, |(_, pen)| pen > 0.35) {
                            continue;
                        }
                        let o = &self.cars[j];
                        let (l1, l2) = (&self.g.links[c.link as usize], &self.g.links[o.link as usize]);
                        let (z1, z2) = (self.car_zone(c), self.car_zone(o));
                        let k = if !self.same_level(c, o) {
                            9
                        } else if c.id >= young_id || o.id >= young_id {
                            0
                        } else if c.lc_from != NO_LANE || o.lc_from != NO_LANE {
                            1
                        } else if l1.len < c.len + 1.0 || l2.len < o.len + 1.0 {
                            2
                        } else if (z1 != NONE || z2 != NONE) && (z1 == z2 || c.link != o.link) {
                            let chain = |a: &Car, b: &Car| a.link == b.link && a.lane == b.lane || a.next == b.link || (a.prev == b.prev && a.link == b.link);
                            if chain(c, o) || chain(o, c) {
                                8
                            } else {
                                3
                            }
                        } else if c.link == o.link && c.lane == o.lane {
                            4
                        } else if c.link == o.link {
                            5
                        } else if self.zone_of(l1.to) == self.zone_of(l2.to) || c.next == o.link || o.next == c.link {
                            6
                        } else {
                            7
                        };
                        out[k] += 1;
                        if ex.len() < nex {
                            ex.push(format!(
                                "[{k}] ids {}-{} plane {}/{} plen {:.1}/{:.1} r {:.2}/{:.2} @({:.0},{:.0}) link {}/{} len {:.1}/{:.1} lanes {}/{} lane {}/{} s {:.1}/{:.1} v {:.1}/{:.1} zone {}/{} prev {}/{} next {}/{} lc {}/{} ctl {:?}/{:?} fl {}/{}",
                                c.id.min(o.id), c.id.max(o.id), c.prev_lane, o.prev_lane, if c.prev != NONE { self.g.links[c.prev as usize].len } else { -1.0 }, if o.prev != NONE { self.g.links[o.prev as usize].len } else { -1.0 }, self.box_ratio(i), self.box_ratio(j), b.x, b.y, c.link, o.link, l1.len, l2.len, l1.lanes, l2.lanes, c.lane, o.lane, c.s, o.s, c.v, o.v,
                                z1 as i64, z2 as i64, c.prev as i64, o.prev as i64, c.next as i64, o.next as i64, c.lc_from, o.lc_from,
                                self.g.nodes[l1.to as usize].control, self.g.nodes[l2.to as usize].control, l1.flags, l2.flags
                            ));
                        }
                    }
                }
            }
        }
        (out, ex)
    }

    /// QA: cars waiting inside a split junction (median): [x, y, car heading, link heading at
    /// the car, heading of the carriageway it came from, link length, car length, s, link, prev]*
    pub fn median_waits(&self) -> Vec<f32> {
        let mut out = Vec::new();
        for (i, c) in self.cars.iter().enumerate() {
            if c.flags & (F_DEAD | F_PLAYER) != 0 || c.v >= 0.5 || c.link == NONE || c.flags & F_COMMIT != 0 {
                continue;
            }
            if !self.internal_link(c.link) {
                continue;
            }
            let (p, _) = self.car_pose(i);
            let l = &self.g.links[c.link as usize];
            let lh = self.g.link_pose(c.link, (c.s - c.len * 0.5).clamp(0.5, (l.len - 0.5).max(0.5)), 0.0).h;
            let ph = if c.prev != NONE {
                let pl = &self.g.links[c.prev as usize];
                self.g.link_pose(c.prev, (pl.len - 1.0).max(0.0), 0.0).h
            } else {
                f32::NAN
            };
            out.extend_from_slice(&[p.x as f32, p.y as f32, p.h, lh, ph, l.len, c.len, c.s, c.link as f32, c.prev as f32]);
        }
        out
    }

    /// is `link` a major approach at its end node
    fn is_major(&self, link: u32) -> bool {
        let l = &self.g.links[link as usize];
        let node = &self.g.nodes[l.to as usize];
        let eff = if l.flags & FLAG_LINK != 0 { l.class.max(3) } else { l.class };
        eff <= node.best_class && !(node.control == Control::Stop && node.uniform)
    }

    // ------------------------------------------------------------------ obstacles (surface transit)

    fn ob_range(&self, link: u32) -> &[ObLink] {
        let a = self.ob_links.partition_point(|o| o.link < link);
        let b = self.ob_links.partition_point(|o| o.link <= link);
        &self.ob_links[a..b]
    }

    /// first obstacle in (link, lane) whose rear is ahead of `s` (- 1 m): (rear s, v)
    fn obst_ahead(&self, link: u32, lane: u8, s: f32) -> Option<(f32, f32)> {
        if self.ob_links.is_empty() || lane >= 8 {
            return None;
        }
        let mut best: Option<(f32, f32)> = None;
        for o in self.ob_range(link) {
            if o.mask & (1 << lane) != 0 && o.s0 >= s - 1.0 && best.map_or(true, |b| o.s0 < b.0) {
                best = Some((o.s0, o.v));
            }
        }
        best
    }

    /// any obstacle overlapping [lo, hi] in (link, lane)
    fn obst_block(&self, link: u32, lane: u8, lo: f32, hi: f32) -> bool {
        if self.ob_links.is_empty() || lane >= 8 {
            return false;
        }
        self.ob_range(link).iter().any(|o| o.mask & (1 << lane) != 0 && o.s0 < hi && o.s1 > lo)
    }

    /// nearest obstacle behind `s` in (link, lane): (front s, v)
    fn obst_behind(&self, link: u32, lane: u8, s: f32) -> Option<(f32, f32)> {
        if self.ob_links.is_empty() || lane >= 8 {
            return None;
        }
        let mut best: Option<(f32, f32)> = None;
        for o in self.ob_range(link) {
            if o.mask & (1 << lane) != 0 && o.s1 <= s && best.map_or(true, |b| o.s1 > b.0) {
                best = Some((o.s1, o.v));
            }
        }
        best
    }

    /// Replace the external obstacles: `data` = [e, n, heading, length, width, speed, flags] per vehicle
    /// (front-centre pose, heading CCW from east). Maps them onto lanes and junctions.
    pub fn set_obstacles(&mut self, data: &[f64]) {
        self.obst.clear();
        self.ob_links.clear();
        self.ob_box.clear();
        for c in data.chunks_exact(OB_STRIDE) {
            if !(c[0].is_finite() && c[1].is_finite() && c[2].is_finite()) {
                continue;
            }
            self.obst.push(Obst {
                x: c[0],
                y: c[1],
                h: c[2] as f32,
                len: (c[3] as f32).clamp(4.0, 80.0),
                w: (c[4] as f32).clamp(1.5, 3.5),
                v: (c[5] as f32).max(0.0),
                flags: c[6] as u8,
            });
        }
        let mut near = std::mem::take(&mut self.tmp);
        let mut acc: Vec<(u32, u8, f32, f32)> = Vec::new();
        let mut nodes: Vec<u32> = Vec::new();
        for k in 0..self.obst.len() {
            let o = self.obst[k];
            let (hs, hc) = o.h.sin_cos();
            let n = ((o.len / 4.0).ceil() as usize).max(2);
            acc.clear();
            nodes.clear();
            for j in 0..=n {
                let back = o.len * j as f32 / n as f32;
                let (px, py) = (o.x - (hc * back) as f64, o.y - (hs * back) as f64);
                self.g.edges_near(px, py, 12.0, &mut near);
                for &eid in &near {
                    let e = &self.g.edges[eid as usize];
                    if !e.alive || e.flags & FLAG_TUNNEL != 0 {
                        continue;
                    }
                    for nd in [e.from, e.to] {
                        let nn = &self.g.nodes[nd as usize];
                        if nn.control != Control::Free
                            && !nodes.contains(&nd)
                            && ((nn.x - px).hypot(nn.y - py) as f32) < nn.setback + 4.0 + o.w
                        {
                            nodes.push(nd);
                        }
                    }
                    let (se, lat, _, he) = self.g.project_on_edge(eid, px, py);
                    if se <= 0.05 || se >= e.len - 0.05 || lat.abs() > e.half_w + o.w * 0.5 {
                        continue;
                    }
                    let dh = wrap_pi(o.h - he);
                    let (link, sl, latl) = if dh.abs() < 0.6 {
                        (e.links[0], se, lat)
                    } else if dh.abs() > PI - 0.6 {
                        (e.links[1], e.len - se, -lat)
                    } else {
                        continue;
                    };
                    if link == NONE {
                        continue;
                    }
                    let lk = &self.g.links[link as usize];
                    let mut mask = 0u8;
                    for ln in 0..lk.lanes.min(8) {
                        if (self.g.lane_offset(lk, ln) - latl).abs() < LANE_W * 0.5 + o.w * 0.5 - 0.35 {
                            mask |= 1 << ln;
                        }
                    }
                    if mask == 0 {
                        continue;
                    }
                    if let Some(a) = acc.iter_mut().find(|a| a.0 == link) {
                        a.1 |= mask;
                        a.2 = a.2.min(sl);
                        a.3 = a.3.max(sl);
                    } else {
                        acc.push((link, mask, sl, sl));
                    }
                }
            }
            // Toronto: traffic stops behind a streetcar whose doors are open (no island)
            let rail = o.flags & OB_RAIL != 0 || o.len > 22.0;
            let boarding = o.v < 0.3
                && if o.flags & OB_DOORS_KNOWN != 0 { o.flags & OB_DOORS != 0 } else { rail && self.peds.stop_near(o.x - (hc * o.len * 0.5) as f64, o.y - (hs * o.len * 0.5) as f64, o.len * 0.5 + 12.0) };
            for &(link, mask, s0, s1) in &acc {
                let mut m = mask;
                let mut lo = s0;
                if boarding && rail {
                    m |= (1u8 << mask.trailing_zeros()) - 1; // curb-side lanes
                    lo -= 2.0;
                }
                self.ob_links.push(ObLink { link, mask: m, s0: lo, s1, v: o.v });
            }
            // junctions it is crossing: body + a short sweep ahead
            let mut zones: Vec<u32> = nodes.iter().map(|&n| self.zone_of(n)).collect();
            zones.sort_unstable();
            zones.dedup();
            for &nd in &zones {
                let nn = &self.g.nodes[nd as usize];
                let ahead = (o.v * 2.0).min(20.0);
                let mut pts = [[0.0f32; 2]; NS];
                for (j, p) in pts.iter_mut().enumerate() {
                    let d = -o.len + (o.len + ahead) * j as f32 / (NS - 1) as f32;
                    *p = [(o.x + (hc * d) as f64 - nn.x) as f32, (o.y + (hs * d) as f64 - nn.y) as f32];
                }
                self.ob_box.push((nd, pts));
            }
        }
        self.tmp = near;
        self.ob_links.sort_by_key(|o| o.link);
    }

    fn advance_obstacles(&mut self, dt: f32) {
        for o in self.ob_links.iter_mut() {
            o.s0 += o.v * dt;
            o.s1 += o.v * dt;
        }
    }

    // ------------------------------------------------------------------ junction occupancy

    fn push_occ(&mut self, node: u32, mut o: Occ) {
        let head = self.occ_head[node as usize];
        if head == NONE {
            self.occ_nodes.push(node);
        }
        o.nx = head;
        self.occ.push(o);
        self.occ_head[node as usize] = (self.occ.len() - 1) as u32;
    }

    #[inline]
    fn occ_first(&self, node: u32) -> u32 {
        self.occ_head.get(node as usize).copied().unwrap_or(NONE)
    }

    /// (node, occupant) for car `i` if it is inside / has reserved a controlled junction
    fn occupancy_of(&self, i: usize) -> Option<(u32, Occ)> {
        let c = &self.cars[i];
        if c.link == NONE {
            return None;
        }
        let l = &self.g.links[c.link as usize];
        let mk = |bp: &BoxPath, u_rear: f32, in_link: u32, in_lane: u8| {
            let from = ((u_rear.clamp(0.0, 1.0) * (NS - 1) as f32).floor() as usize).min(NS - 1) as u8;
            (bp.node, Occ { car: i as u32, in_link, in_lane, from, nx: NONE, pts: bp.pts })
        };
        if c.flags & F_COMMIT != 0 && c.next != NONE && self.g.links[c.next as usize].alive {
            let node = l.to;
            if self.g.nodes[node as usize].control != Control::Free {
                let a = self.sb_in(c.link);
                let b = self.sb_out(c.next);
                let u = (c.s - c.len - (l.len - a)) / (a + b);
                return Some(mk(&self.path_in(i), u, c.link, c.lane));
            }
        }
        if self.prev_ok(c) {
            let node = l.from;
            if self.g.nodes[node as usize].control != Control::Free {
                let a = self.sb_in(c.prev);
                let b = self.sb_out(c.link);
                if c.s - c.len < b {
                    return Some(mk(&self.path_out(i), (a + c.s - c.len) / (a + b), c.prev, c.prev_lane));
                }
            }
        }
        None
    }

    fn build_occupancy(&mut self) {
        self.occ.clear();
        for &n in &self.occ_nodes {
            if let Some(h) = self.occ_head.get_mut(n as usize) {
                *h = NONE;
            }
        }
        self.occ_nodes.clear();
        if self.occ_head.len() < self.g.nodes.len() {
            self.occ_head.resize(self.g.nodes.len(), NONE);
        }
        for i in 0..self.cars.len() {
            if self.cars[i].flags & F_DEAD != 0 {
                continue;
            }
            if self.cars[i].flags & F_PLAYER != 0 {
                self.player_occupancy(i);
                continue;
            }
            if let Some((node, o)) = self.occupancy_of(i) {
                self.push_occ(node, o);
            }
        }
        for k in 0..self.ob_box.len() {
            let (node, pts) = self.ob_box[k];
            self.push_occ(node, Occ { car: NONE, in_link: NONE, in_lane: NO_LANE, from: 0, nx: NONE, pts });
        }
    }

    /// the player's body (+ a short sweep ahead) blocks junctions it is in
    fn player_occupancy(&mut self, i: usize) {
        let Some(p) = &self.player else { return };
        let (px, py, ph, pv) = (p.x, p.y, p.h, p.v);
        let c = &self.cars[i];
        if c.link == NONE {
            return;
        }
        let l = &self.g.links[c.link as usize];
        let (hs, hc) = ph.sin_cos();
        let (za, zb) = (self.zone_of(l.from), self.zone_of(l.to));
        for (k, nd0) in [l.from, l.to].into_iter().enumerate() {
            let n0 = &self.g.nodes[nd0 as usize];
            if n0.control == Control::Free || ((n0.x - px).hypot(n0.y - py) as f32) > n0.setback + 8.0 || (k == 1 && za == zb) {
                continue;
            }
            let nd = if k == 0 { za } else { zb };
            let n = &self.g.nodes[nd as usize];
            let ahead = (pv.abs() * 1.5).min(15.0);
            let mut pts = [[0.0f32; 2]; NS];
            for (j, q) in pts.iter_mut().enumerate() {
                let d = -PLAYER_HL + (2.0 * PLAYER_HL + ahead) * j as f32 / (NS - 1) as f32;
                *q = [(px + (hc * d) as f64 - n.x) as f32, (py + (hs * d) as f64 - n.y) as f32];
            }
            self.push_occ(nd, Occ { car: i as u32, in_link: NONE, in_lane: NO_LANE, from: 0, nx: NONE, pts });
        }
    }

    fn commit(&mut self, i: usize) {
        let c = &mut self.cars[i];
        c.flags |= F_COMMIT;
        c.wait_conf = 0.0;
        if let Some((node, o)) = self.occupancy_of(i) {
            self.push_occ(node, o);
        }
    }

    /// May car `i` enter the junction ahead now? (free path, room on the exit, no priority traffic)
    fn can_enter(&self, i: usize) -> bool {
        let c = &self.cars[i];
        let (link, lane, next, turn, len) = (c.link, c.lane, c.next, c.turn, c.len);
        let l = &self.g.links[link as usize];
        let node = &self.g.nodes[l.to as usize];
        let ni = self.zone_of(l.to);
        let nl = &self.g.links[next as usize];
        let tl = target_lane(lane, nl.lanes, turn);
        // don't block the box: room for the whole car beyond the exit
        let b = self.sb_out(next);
        let need = (b + len + 1.0).min(nl.len - 0.5);
        if let Some(t) = self.lane_tail(next, tl) {
            let tc = &self.cars[t];
            // (a slowing queue counts as stopped: the car would end up stuck in the box)
            if tc.s - tc.len < need + 2.0 && (tc.v < 3.0 || tc.a < -1.0) {
                return false;
            }
        }
        // the exit is the inside of a split junction: it must be clear of queued cars on any
        // lane (a car stopping in there would sit rotated across the junction)
        if self.internal_link(next) {
            for ln in 0..nl.lanes {
                if self.lane_tail(next, ln).is_some() {
                    return false;
                }
            }
            // ... and there must be room where it comes out
            let n2 = c.next2;
            if n2 != NONE && self.g.links[n2 as usize].alive {
                let l2 = &self.g.links[n2 as usize];
                let need2 = (self.sb_out(n2) + len + 3.0).min(l2.len - 0.5);
                for ln in 0..l2.lanes {
                    if let Some(t) = self.lane_tail(n2, ln) {
                        let tc = &self.cars[t];
                        if tc.s - tc.len < need2 && (tc.v < 3.0 || tc.a < -1.0) {
                            return false;
                        }
                    }
                }
            }
        }
        if self.obst_block(next, tl, -1e3, need) {
            if let Some((_, ov)) = self.obst_ahead(next, tl, -1e3) {
                if ov < 3.0 {
                    return false;
                }
            }
        }
        let me = self.path_in(i).pts;
        // occupied / reserved conflicting paths
        let mut k = self.occ_first(ni);
        while k != NONE {
            let o = &self.occ[k as usize];
            k = o.nx;
            if o.car == i as u32 || (o.in_link == link && o.in_lane == lane) {
                continue;
            }
            if conflict(&me, 0, &o.pts, o.from as usize) {
                // inside a zone, two held cars could wait for each other forever
                if c.wait_conf > 8.0 && o.car != NONE {
                    let oc = &self.cars[o.car as usize];
                    if oc.flags & F_HELD != 0 && oc.v < 0.3 && oc.wait_conf > 8.0 {
                        continue;
                    }
                }
                return false;
            }
        }
        // pedestrians on a crossing the path goes over
        let pc = &self.peds.cross;
        let a = pc.partition_point(|x| x.0 < ni);
        for x in &pc[a..] {
            if x.0 != ni {
                break;
            }
            let (s0, s1) = ((x.1[0], x.1[1]), (x.1[2], x.1[3]));
            for q in &me {
                let (dx, dy) = (s1.0 - s0.0, s1.1 - s0.1);
                let l2 = dx * dx + dy * dy;
                let t = if l2 > 1e-6 { (((q[0] - s0.0) * dx + (q[1] - s0.1) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
                if (q[0] - s0.0 - dx * t).hypot(q[1] - s0.1 - dy * t) < 2.2 {
                    return false;
                }
            }
        }
        if c.wait_conf > 15.0 {
            return true; // deadlock valve: stop yielding to approaching traffic
        }
        // approaching traffic with priority
        let left = matches!(turn, Turn::Left | Turn::U);
        let major = self.is_major(link);
        for &l2 in &node.ins {
            if l2 == link {
                continue;
            }
            let lk2 = &self.g.links[l2 as usize];
            if !lk2.alive || lk2.stamp != self.step_no {
                continue;
            }
            let (prio, need_straight) = match node.control {
                Control::Signal => (left && node.plan.light_for(self.tod, lk2.bearing_end) != Light::Red, true),
                Control::Stop | Control::Priority => {
                    let major2 = self.is_major(l2);
                    if !major {
                        (major2, false)
                    } else {
                        (major2 && left, true)
                    }
                }
                Control::Free => (false, false),
            };
            if !prio {
                continue;
            }
            let sb2 = self.sb_in(l2);
            for ln in 0..(lk2.lanes as usize).min(MAXL) {
                let (h, t) = (lk2.head[ln], lk2.tail[ln]);
                if h == NONE {
                    continue;
                }
                for r in h..=(h + 1).min(t) {
                    let hc = &self.cars[self.order[r as usize] as usize];
                    if hc.flags & F_COMMIT != 0 || hc.next == NONE || hc.flags & F_PLAYER != 0 {
                        continue;
                    }
                    if need_straight && matches!(hc.turn, Turn::Left | Turn::U) {
                        continue;
                    }
                    let d2 = lk2.len - sb2 - hc.s;
                    if d2 < -0.5 {
                        continue;
                    }
                    let tta = if hc.v < 0.5 {
                        if d2 < 4.0 && hc.flags & F_HELD == 0 {
                            0.0
                        } else {
                            continue;
                        }
                    } else {
                        d2 / hc.v
                    };
                    if tta > 5.0 {
                        continue;
                    }
                    if !self.g.links[hc.next as usize].alive {
                        continue;
                    }
                    let p2 = self.path_in(self.order[r as usize] as usize).pts;
                    if conflict(&me, 0, &p2, 0) {
                        return false;
                    }
                }
            }
        }
        true
    }

    // ------------------------------------------------------------------ car following

    fn desired_speed(&self, i: usize) -> f32 {
        let c = &self.cars[i];
        let l = &self.g.links[c.link as usize];
        let mut v0 = l.speed * c.vf;
        if c.next != NONE {
            let nl = &self.g.links[c.next as usize];
            let vt = match c.turn {
                Turn::Straight => nl.speed * c.vf,
                Turn::Right => 6.0,
                Turn::Left => 7.5,
                Turn::U => 3.5,
            }
            .min(nl.speed * c.vf);
            let a = self.sb_in(c.link);
            let d = (l.len - a - c.s).max(0.0);
            if vt < v0 {
                v0 = v0.min((vt * vt + 2.0 * 1.3 * d).sqrt());
            }
            // minor approach to a yield junction: slow down to look
            if c.flags & F_COMMIT == 0 && self.g.nodes[l.to as usize].control == Control::Priority && !self.is_major(c.link) {
                v0 = v0.min((2.0 * 1.4 * d).sqrt() + 3.0);
            }
        }
        v0
    }

    fn compute_accel(&mut self, dt: f32) {
        let n = self.cars.len();
        self.acc.clear();
        self.acc.resize(n, 0.0);
        self.lim.clear();
        self.lim.resize(n, f32::INFINITY);
        let mut rbox = std::mem::take(&mut self.rbox);
        rbox.clear();
        for i in 0..n {
            let c = &self.cars[i];
            let ok = c.flags & F_DEAD == 0 && c.link != NONE && self.g.links[c.link as usize].alive;
            rbox.push(if ok { self.box_ratio(i).max(0.2) } else { 1.0 });
        }
        self.rbox = rbox;
        let mut pg = std::mem::take(&mut self.pgrid);
        pg.clear();
        for (i, c) in self.cars.iter().enumerate() {
            if c.posed && c.flags & F_DEAD == 0 {
                pg.push((pcell(c.pose.x, c.pose.y, 0, 0), i as u32));
            }
        }
        pg.sort_unstable();
        self.pgrid = pg;
        for i in 0..n {
            if self.cars[i].flags & (F_PLAYER | F_DEAD) != 0 {
                continue;
            }
            self.cars[i].flags &= !F_HELD;
            let v0 = self.desired_speed(i);
            let c = &self.cars[i];
            let (v, s, link, lane, next, turn, lc_from) = (c.v, c.s, c.link, c.lane, c.next, c.turn, c.lc_from);
            let mut p = c.idm;
            let l = &self.g.links[link as usize];
            if l.class <= 1 {
                p.t *= 0.8; // motorway headways ~1 s
            }
            let dist_end = l.len - s;
            let mut a = idm::accel(&p, v, v0, f32::INFINITY, 0.0);
            let mut lim = f32::INFINITY;
            let follow = |a: &mut f32, lim: &mut f32, rear: f32, lv: f32| {
                *a = a.min(idm::accel(&p, v, v0, rear - s, v - lv));
                *lim = lim.min(rear - 0.3);
            };
            // following through a junction path drawn shorter than the distance it stands for
            // (r < 1): keep the drawn gap, r * (leader front - own front) - leader length
            let rb = &self.rbox;
            let follow_r = |a: &mut f32, lim: &mut f32, front: f32, len: f32, lv: f32, r: f32| {
                if r >= 0.98 {
                    *a = a.min(idm::accel(&p, v, v0, front - len - s, v - lv));
                    *lim = lim.min(front - len - 0.3);
                } else {
                    *a = a.min(idm::accel(&p, v, v0, r * (front - s) - len, v - lv));
                    *lim = lim.min(front - (len + 0.3) / r);
                }
            };
            let li = self.lead[i];
            if li != NONE {
                let ld = &self.cars[li as usize];
                follow_r(&mut a, &mut lim, ld.s, ld.len, ld.v, rb[i].min(rb[li as usize]));
            }
            if let Some((rear, lv)) = self.ghost_ahead(link, lane, s, i) {
                follow(&mut a, &mut lim, rear, lv);
            }
            if lc_from != NO_LANE && lc_from < l.lanes {
                if let (Some(x), _) = self.neighbours(link, lc_from, s, i) {
                    let ld = &self.cars[x];
                    follow(&mut a, &mut lim, ld.s - ld.len, ld.v);
                }
                if let Some((rear, ov)) = self.obst_ahead(link, lc_from, s) {
                    follow(&mut a, &mut lim, rear, ov);
                }
            }
            if let Some((rear, ov)) = self.obst_ahead(link, lane, s) {
                follow(&mut a, &mut lim, rear, ov);
            }
            if next != NONE && dist_end < 160.0 {
                let nl = &self.g.links[next as usize];
                let tl = target_lane(lane, nl.lanes, turn);
                if let Some(t) = self.lane_tail(next, tl) {
                    let tc = &self.cars[t];
                    follow_r(&mut a, &mut lim, l.len + tc.s, tc.len, tc.v, rb[i].min(rb[t]));
                } else if nl.len < 40.0 {
                    // short links (clustered junctions): the car ahead may be further on
                    if let Some((front, t)) = self.tail_beyond(i, next, tl, l.len + nl.len) {
                        let tc = &self.cars[t];
                        follow_r(&mut a, &mut lim, front, tc.len, tc.v, rb[i].min(rb[t]));
                    }
                }
                if let Some((rear, ov)) = self.obst_ahead(next, tl, -1e3) {
                    follow(&mut a, &mut lim, l.len + rear, ov);
                }
            }
            // dead end ahead (graph edge / unloaded tile): stop softly at the end
            if next == NONE && dist_end < 80.0 {
                a = a.min(idm::accel(&p, v, v0, dist_end + 4.0, v));
            }
            // cars that crossed the junction ahead from this lane but went elsewhere (forks)
            // are followed until their tail is out of the box
            if next != NONE && dist_end < self.sb_in(link) + 40.0 {
                let mut k = self.occ_first(self.zone_of(l.to));
                while k != NONE {
                    let o = &self.occ[k as usize];
                    k = o.nx;
                    if o.car == NONE || o.car as usize == i || o.in_link != link || o.in_lane != lane {
                        continue;
                    }
                    let oc = &self.cars[o.car as usize];
                    if oc.prev == link && oc.link != next && oc.flags & F_PLAYER == 0 {
                        follow_r(&mut a, &mut lim, l.len + oc.s, oc.len, oc.v, rb[i].min(rb[o.car as usize]));
                    }
                }
            }
            // merging streams (zipper): follow the car just ahead in distance-to-node on every
            // other lane that heads for our target lane (uncontrolled merges, lane drops) or that
            // physically runs into ours (converging approaches drawn side by side)
            let merge_range = if l.class <= 1 { 130.0 } else { 70.0 };
            if next != NONE && dist_end < merge_range {
                let node = &self.g.nodes[l.to as usize];
                let free = node.control == Control::Free;
                let nl = &self.g.links[next as usize];
                let my_tl = target_lane(lane, nl.lanes, turn);
                let my_off = self.g.lane_offset(l, lane);
                for &l2 in &node.ins {
                    let lk2 = &self.g.links[l2 as usize];
                    let same = l2 == link;
                    let parallel = !same && wrap_pi(lk2.bearing_end - l.bearing_end).abs() < 0.5;
                    if lk2.stamp != self.step_no || !(free || same || parallel) || (same && lk2.lanes < 2) {
                        continue;
                    }
                    for ln in 0..(lk2.lanes).min(MAXL as u8) {
                        if same && ln == lane {
                            continue;
                        }
                        let s_eq = lk2.len - dist_end;
                        let (ld, _) = self.neighbours(l2, ln, s_eq, i);
                        let Some(x) = ld else { continue };
                        let hc = &self.cars[x];
                        let d2 = lk2.len - hc.s;
                        let stream = hc.next == next && target_lane(hc.lane, nl.lanes, hc.turn) == my_tl;
                        let close = if parallel || same {
                            let (x1, y1, _) = self.g.link_xyz(link, s, my_off);
                            let (x2, y2, _) = self.g.link_xyz(l2, s_eq.max(0.0), self.g.lane_offset(lk2, ln));
                            (x1 - x2).hypot(y1 - y2) < 2.8
                        } else {
                            false
                        };
                        if close {
                            follow(&mut a, &mut lim, l.len - d2 - hc.len, hc.v);
                        } else if stream && (free || same) && dist_end < 70.0 {
                            a = a.min(idm::accel(&p, v, v0, dist_end - d2 - hc.len, v - hc.v));
                        }
                    }
                }
            }
            if let Some(gap) = self.control_gap(i, dt) {
                a = a.min(idm::accel(&p, v, v0, gap, v));
            }
            // physical look-ahead: any body ahead in our path, whatever link it is on (roads drawn
            // over each other, auxiliary lanes, clustered junctions). Not needed by a car that
            // stays stopped anyway or whose lane leader is close ahead.
            let covered = (v < 0.3 && a <= 0.0)
                || (li != NONE && {
                    let ld = &self.cars[li as usize];
                    ld.s - ld.len - s < 12.0 && self.rbox[i] >= 0.98
                });
            if let Some((gap, lv)) = if covered { None } else { self.body_ahead(i) } {
                a = a.min(idm::accel(&p, v, v0, gap, v - lv));
                lim = lim.min(s + (gap - 0.3).max(0.0));
            }
            if let Some(gap) = self.crossing_gap(i) {
                a = a.min(idm::accel(&p, v, v0, gap + p.s0, v));
                lim = lim.min(self.cars[i].s + gap.max(0.0) + 0.3);
            }
            if self.cars[i].bus != NONE {
                if let Some(gap) = self.bus_stop_gap(i) {
                    // IDM keeps s0 to an obstacle: aim s0 beyond the stop point to stop at it
                    a = a.min(idm::accel(&p, v, v0, gap + p.s0, v));
                    lim = lim.min(self.cars[i].s + gap.max(0.0) + 0.3);
                }
            }
            self.acc[i] = a;
            self.lim[i] = lim;
        }
    }

    /// false for a car on a bridge / in a tunnel against one on an unconnected street (drawn on
    /// different levels; the graph's heights do not always tell them apart)
    fn same_level(&self, c: &Car, o: &Car) -> bool {
        if c.link == NONE || o.link == NONE {
            return true;
        }
        let (l1, l2) = (&self.g.links[c.link as usize], &self.g.links[o.link as usize]);
        (l1.flags ^ l2.flags) & (FLAG_BRIDGE | FLAG_TUNNEL) == 0 || c.link == o.link || c.next == o.link || o.next == c.link || c.prev == o.link || o.prev == c.link
    }

    /// is any car body centre (last rendered poses) within `r` (< 12 m) of (x, y)
    fn body_near(&self, x: f64, y: f64, r: f64) -> bool {
        for dx in -1..=1 {
            let (k0, k1) = (pcell(x, y, dx, -1), pcell(x, y, dx, 1));
            let a = self.pgrid.partition_point(|e| e.0 < k0);
            for &(k, j) in &self.pgrid[a..] {
                if k > k1 {
                    break;
                }
                let o = &self.cars[j as usize];
                if (o.pose.x - x).hypot(o.pose.y - y) < r {
                    return true;
                }
            }
        }
        false
    }

    /// Nearest body in front of car `i` (from the last rendered poses) that its own body would
    /// run into: same general direction (< 60°), laterally overlapping, not on a different level.
    /// (gap bumper to bumper along our heading, its speed along our heading)
    fn body_ahead(&self, i: usize) -> Option<(f32, f32)> {
        let c = &self.cars[i];
        if !c.posed {
            return None;
        }
        let (px, py, h) = (c.pose.x, c.pose.y, c.pose.h);
        let (hx, hy) = (h.cos() as f64, h.sin() as f64);
        let hw = HALF_W[c.kind as usize];
        let mut best: Option<(f32, f32)> = None;
        for dx in -1..=1 {
            // (cells (dx, -1..=1) have consecutive keys)
            let (k0, k1) = (pcell(px, py, dx, -1), pcell(px, py, dx, 1));
            let a = self.pgrid.partition_point(|e| e.0 < k0);
            {
                for &(k, j) in &self.pgrid[a..] {
                    if k > k1 {
                        break;
                    }
                    let j = j as usize;
                    if j == i {
                        continue;
                    }
                    let o = &self.cars[j];
                    if (o.pose.z - c.pose.z).abs() > 2.5 || !self.same_level(c, o) {
                        continue;
                    }
                    let dh = wrap_pi(o.pose.h - h);
                    if dh.abs() > 1.05 {
                        continue;
                    }
                    let (ex, ey) = (o.pose.x - px, o.pose.y - py);
                    let f = (ex * hx + ey * hy) as f32;
                    let lat = (-ex * hy + ey * hx) as f32;
                    // the other body's half extent across our heading
                    let ohw = HALF_W[o.kind as usize] * dh.cos().abs() + o.len * 0.5 * dh.sin().abs();
                    if f <= 0.0 || lat.abs() > hw + ohw - 0.15 {
                        continue;
                    }
                    // mutual: only the one further behind yields
                    let (ohx, ohy) = (o.pose.h.cos() as f64, o.pose.h.sin() as f64);
                    let f2 = (-(ex * ohx + ey * ohy)) as f32;
                    if f2 > 0.0 && (f2 > f || (f2 == f && j > i)) {
                        continue;
                    }
                    let ohl = o.len * 0.5 * dh.cos().abs() + HALF_W[o.kind as usize] * dh.sin().abs();
                    let gap = f - c.len * 0.5 - ohl;
                    if gap > 25.0 {
                        continue;
                    }
                    if best.map_or(true, |b| gap < b.0) {
                        best = Some((gap, o.v * dh.cos()));
                    }
                }
            }
        }
        best
    }

    /// Last car in the lane the car would take beyond the short link `link` (its end is `off`
    /// ahead of the car's link start): (its front in the car's link coordinates, index).
    /// Follows the car's pre-chosen exit (next2) or the only way on, up to 3 links / 60 m.
    fn tail_beyond(&self, i: usize, link: u32, lane: u8, off: f32) -> Option<(f32, usize)> {
        let (mut cur, mut ln, mut off) = (link, lane, off);
        let s0 = self.cars[i].s;
        for k in 0..3 {
            if off - s0 > 80.0 {
                return None;
            }
            let cl = &self.g.links[cur as usize];
            let nx = if k == 0 && self.cars[i].next2 != NONE {
                self.cars[i].next2
            } else {
                let node = &self.g.nodes[cl.to as usize];
                let mut only = NONE;
                for &o in &node.outs {
                    let ol = &self.g.links[o as usize];
                    if !ol.alive || ol.edge == cl.edge {
                        continue;
                    }
                    if only != NONE {
                        return None; // a choice we cannot predict
                    }
                    only = o;
                }
                only
            };
            if nx == NONE {
                return None;
            }
            let nl = &self.g.links[nx as usize];
            if !nl.alive || nl.from != cl.to {
                return None;
            }
            let turn = classify_turn(cl.bearing_end, nl.bearing_start);
            ln = target_lane(ln, nl.lanes, turn);
            if let Some(t) = self.lane_tail(nx, ln) {
                return Some((off + self.cars[t].s, t));
            }
            off += nl.len;
            cur = nx;
        }
        None
    }

    /// Junction control: gap to the stop line if the car must stop there.
    fn control_gap(&mut self, i: usize, dt: f32) -> Option<f32> {
        let (link, s, v, flags, next) = {
            let c = &self.cars[i];
            (c.link, c.s, c.v, c.flags, c.next)
        };
        if flags & F_COMMIT != 0 || next == NONE {
            return None;
        }
        let l = &self.g.links[link as usize];
        let (llen, bearing) = (l.len, l.bearing_end);
        let node = &self.g.nodes[l.to as usize];
        let control = node.control;
        if control == Control::Free {
            return None;
        }
        let d = llen - self.sb_in(link) - s;
        if d < -1.0 {
            self.commit(i); // spawned / arrived inside the box
            return None;
        }
        if d > 30.0 + v * v / 3.0 {
            return None;
        }
        let major = self.is_major(link);
        // inside a split junction (a short link between two nodes of one conflict zone, e.g.
        // across the median of a divided road) the entry signal governed: no second stop here
        let internal = self.internal_link(link);
        match control {
            Control::Signal if internal => {}
            Control::Signal => match node.plan.light_for(self.tod, bearing) {
                Light::Red => return Some(d),
                Light::Amber => {
                    if d > 0.5 && d > v * v / 7.0 {
                        return Some(d);
                    }
                    // too close to stop: go
                    self.commit(i);
                    return None;
                }
                Light::Green => {}
            },
            Control::Stop if !major => {
                if self.cars[i].wait < 1.0 {
                    if d < 3.0 && v < 0.5 {
                        self.cars[i].wait += dt;
                    }
                    return Some(d);
                }
            }
            _ => {}
        }
        let gate = (v * 1.3 + 3.0).max(if major || control == Control::Signal { 4.0 } else { 8.0 });
        if d > gate {
            return None;
        }
        if self.can_enter(i) {
            self.commit(i);
            None
        } else {
            let c = &mut self.cars[i];
            c.wait_conf += dt;
            c.flags |= F_HELD;
            Some(d)
        }
    }

    fn lane_changes(&mut self, dt: f32) {
        let n = self.cars.len();
        for i in 0..n {
            let c = &mut self.cars[i];
            if c.flags & (F_PLAYER | F_DEAD) != 0 || c.lc_from != NO_LANE {
                continue;
            }
            c.lc_cool -= dt;
            if c.lc_cool > 0.0 {
                continue;
            }
            c.lc_cool = 0.8 + (c.id % 7) as f32 * 0.15;
            let (link, lane, s, v, len, turn, p, next) = (c.link, c.lane, c.s, c.v, c.len, c.turn, c.idm, c.next);
            let l = &self.g.links[link as usize];
            let lanes = l.lanes;
            if lanes < 2 {
                continue;
            }
            let dist_end = l.len - s;
            let a_box = self.sb_in(link);
            let b_box = if self.prev_ok(&self.cars[i]) { self.sb_out(link) } else { 0.0 };
            // body fully clear of both junction boxes, room to finish before the stop line
            if s < b_box + len + 1.0 || s < 5.0 || dist_end < a_box + 8.0 {
                continue;
            }
            let v0 = self.desired_speed(i);
            let li = self.lead[i];
            let mut a_cur = match li {
                NONE => idm::accel(&p, v, v0, f32::INFINITY, 0.0),
                x => {
                    let ld = &self.cars[x as usize];
                    idm::accel(&p, v, v0, ld.s - ld.len - s, v - ld.v)
                }
            };
            let mut transit_block = false;
            if let Some((rear, ov)) = self.obst_ahead(link, lane, s) {
                a_cur = a_cur.min(idm::accel(&p, v, v0, rear - s, v - ov));
                transit_block = ov < 1.0 && rear - s < 40.0;
            }
            // mandatory: be in the right lane for the next turn / lane drop
            let mut want: i32 = 0;
            if next != NONE && dist_end < 220.0 {
                let nl = self.g.links[next as usize].lanes;
                match turn {
                    Turn::Right if lane > 0 => want = -1,
                    Turn::Left | Turn::U if lane + 1 < lanes => want = 1,
                    Turn::Straight if lane >= nl => want = -1,
                    _ => {}
                }
            }
            // buses: curb lane before their stop, stay there near it
            if self.cars[i].bus != NONE {
                if let Some(d) = self.bus_stop_ahead(i) {
                    if d < 220.0 {
                        if lane > 0 {
                            want = -1;
                        } else {
                            continue;
                        }
                    }
                }
            }
            // discretionary changes need room to complete (≈3 s) before the box
            if want == 0 && dist_end < a_box + v * 3.0 + 10.0 {
                continue;
            }
            let mut best: Option<(u8, f32)> = None;
            for dl in [-1i32, 1] {
                let nl = lane as i32 + dl;
                if nl < 0 || nl >= lanes as i32 {
                    continue;
                }
                let nl = nl as u8;
                if v < 2.0 && want != dl && !transit_block {
                    continue;
                }
                let (ld, fl) = self.neighbours(link, nl, s, i);
                // physical room
                if let Some(x) = ld {
                    let lc = &self.cars[x];
                    if lc.s - lc.len - s < 2.0 {
                        continue;
                    }
                }
                if let Some(x) = fl {
                    let fc = &self.cars[x];
                    if s - len - fc.s < 2.0 {
                        continue;
                    }
                    // safety for the new follower
                    let fv0 = fc.v.max(10.0);
                    let af = idm::accel(&fc.idm, fc.v, fv0, s - len - fc.s, fc.v - v);
                    let bsafe = if want == dl { -4.0 } else { -2.0 };
                    if af < bsafe {
                        continue;
                    }
                }
                if self.ghost_near(link, nl, s - len - 2.0, s + 2.0, i) {
                    continue;
                }
                // transit in the target lane (beside us, or closing in from behind)
                if self.obst_block(link, nl, s - len - 3.0, s + 3.0) {
                    continue;
                }
                if let Some((front, ov)) = self.obst_behind(link, nl, s) {
                    if s - len - front < 6.0 + (ov - v).max(0.0) * 3.0 {
                        continue;
                    }
                }
                let mut a_new = match ld {
                    Some(x) => {
                        let lc = &self.cars[x];
                        idm::accel(&p, v, v0, lc.s - lc.len - s, v - lc.v)
                    }
                    None => idm::accel(&p, v, v0, f32::INFINITY, 0.0),
                };
                if let Some((rear, ov)) = self.obst_ahead(link, nl, s) {
                    a_new = a_new.min(idm::accel(&p, v, v0, rear - s, v - ov));
                }
                let mut gain = a_new - a_cur + if dl < 0 { 0.12 } else { -0.12 };
                if want == dl {
                    gain += 3.0;
                } else if want != 0 {
                    gain -= 3.0;
                }
                if gain > 0.35 && best.map_or(true, |b| gain > b.1) {
                    best = Some((nl, gain));
                }
            }
            if let Some((nl, _)) = best {
                let mandatory = want != 0;
                let c = &mut self.cars[i];
                c.lc_from = c.lane;
                c.lane = nl;
                c.lc_t = 0.0;
                c.lc_dur = if mandatory { 2.4 } else { 3.2 };
                c.lc_cool = 4.0;
            }
        }
    }

    fn advance(&mut self, dt: f32) {
        let n = self.cars.len();
        for i in 0..n {
            if self.cars[i].flags & (F_PLAYER | F_DEAD) != 0 {
                continue;
            }
            let a = self.acc[i];
            let lim = self.lim[i];
            let (a_box, llen) = {
                let c = &self.cars[i];
                (if c.lc_from != NO_LANE { self.sb_in(c.link) } else { 0.0 }, self.g.links[c.link as usize].len)
            };
            let c = &mut self.cars[i];
            let v = c.v;
            let mut nv = v + a * dt;
            let mut ds = if nv < 0.0 {
                nv = 0.0;
                if a < 0.0 { -v * v / (2.0 * a) } else { 0.0 }
            } else {
                (v + nv) * 0.5 * dt
            };
            if c.s + ds > lim {
                ds = (lim - c.s).max(0.0);
                nv = nv.min(ds / dt);
            }
            c.v = nv;
            c.a = a;
            c.s += ds;
            if c.bus != NONE {
                if let Some(b) = self.buses[c.bus as usize].as_mut() {
                    b.sd += ds;
                }
            }
            let k = (-ds / 7.0).exp();
            c.blend = [c.blend[0] * k, c.blend[1] * k, c.blend[2] * k];
            // lane change progress; hurry up to finish before the junction box
            if c.lc_from != NO_LANE {
                let room = (llen - a_box - c.s - 1.0).max(0.5);
                let rate = (1.0 / c.lc_dur).max((1.0 - c.lc_t) * nv.max(1.0) / room);
                c.lc_t += rate * dt;
                if c.lc_t >= 1.0 {
                    c.lc_from = NO_LANE;
                    c.lc_t = 0.0;
                    c.lc_cool = c.lc_cool.max(2.0);
                }
            }
            // link statistics for congestion analytics
            let l = &mut self.g.links[c.link as usize];
            if l.class <= 2 {
                l.spd_sum += nv / l.speed;
                l.spd_n += 1;
            }
            // link transitions
            let mut guard = 0;
            while self.cars[i].s >= self.g.links[self.cars[i].link as usize].len && guard < 4 {
                guard += 1;
                if !self.transition(i) {
                    self.cars[i].flags |= F_DEAD;
                    break;
                }
            }
        }
    }

    /// move car `i` onto its next link; false = despawn
    fn transition(&mut self, i: usize) -> bool {
        let (link, next, ngen, lane, turn, dest) = {
            let c = &self.cars[i];
            (c.link, c.next, c.ngen, c.lane, c.turn, c.dest)
        };
        if next == NONE {
            return false;
        }
        let l = &self.g.links[link as usize];
        let node = &self.g.nodes[l.to as usize];
        let guided = self.cars[i].bus != NONE && self.buses[self.cars[i].bus as usize].as_ref().map_or(false, |b| b.state != BusState::OutOfService);
        if !guided && (node.x - dest[0]).hypot(node.y - dest[1]) < 180.0 {
            // arrived: vanish only out of sight, otherwise head somewhere else
            let surplus = self.cars.len() as f32 > self.target_cars * 1.05;
            let unseen = !crate::view::in_view(self.camera, node.x, node.y, 2500.0) && self.camera.is_some();
            if (node.x - self.focus.0).hypot(node.y - self.focus.1) > self.radius * 0.6 || (surplus && unseen) {
                return false;
            }
            let ang = self.rng.f32() * 2.0 * PI;
            let dist = self.rng.range(1500.0, 6000.0) as f64;
            self.cars[i].dest = [node.x + dist * ang.cos() as f64, node.y + dist * ang.sin() as f64];
        }
        let nl = &self.g.links[next as usize];
        if !nl.alive || nl.gen != ngen {
            return false;
        }
        let tl = target_lane(lane, nl.lanes, turn);
        let (lgen, llen, nlgen) = (l.gen, l.len, nl.gen);
        let ver = self.g.version;
        let bp = &mut self.bp[i];
        bp[1] = if bp[0].matches(link, lane, next, tl, ver) { bp[0] } else { BoxPath::NONE };
        bp[0] = BoxPath::NONE;
        let c = &mut self.cars[i];
        c.s -= llen;
        c.prev = link;
        c.pgen = lgen;
        c.prev_lane = lane;
        c.link = next;
        c.lgen = nlgen;
        c.lane = tl;
        c.lc_from = NO_LANE;
        c.lc_t = 0.0;
        c.flags &= !F_COMMIT;
        c.wait = 0.0;
        c.wait_conf = 0.0;
        c.next = NONE;
        self.bus_resync(i);
        self.choose_next(i);
        true
    }

    /// routing: weighted random choice at the node ahead with a soft pull
    /// towards the car's destination
    fn choose_next(&mut self, i: usize) {
        if self.cars[i].bus != NONE && self.bus_guide(i) {
            return;
        }
        let (link, dest) = (self.cars[i].link, self.cars[i].dest);
        // a choice made when entering a split junction (see below)
        let pre = self.cars[i].next2;
        if pre != NONE {
            self.cars[i].next2 = NONE;
            let pl = &self.g.links[pre as usize];
            if pl.alive && pl.from == self.g.links[link as usize].to {
                let t = classify_turn(self.g.links[link as usize].bearing_end, pl.bearing_start);
                let short = pl.len < SHORT_LINK;
                let c = &mut self.cars[i];
                c.next = pre;
                c.turn = t;
                c.ngen = pl.gen;
                if short {
                    let (n2, _) = self.pick_next(pre, dest);
                    self.cars[i].next2 = n2;
                }
                return;
            }
        }
        let (nx, t) = self.pick_next(link, dest);
        // entering a split junction: choose the way out now too, so the car only goes in
        // when it can come out (see can_enter); through short links (clustered junctions)
        // the way on is known too, so the car ahead beyond them is followed (tail_beyond)
        if nx != NONE && (self.internal_link(nx) || self.g.links[nx as usize].len < SHORT_LINK) {
            let (n2, _) = self.pick_next(nx, dest);
            self.cars[i].next2 = n2;
        }
        let c = &mut self.cars[i];
        c.next = nx;
        c.turn = t;
        c.ngen = if nx != NONE { self.g.links[nx as usize].gen } else { 0 };
    }

    /// routing: weighted random choice of the link after `link` (soft pull towards `dest`)
    fn pick_next(&mut self, link: u32, dest: [f64; 2]) -> (u32, Turn) {
        let l = &self.g.links[link as usize];
        let node = &self.g.nodes[l.to as usize];
        let b_in = l.bearing_end;
        let (dx, dy) = ((dest[0] - node.x) as f32, (dest[1] - node.y) as f32);
        let dd = dx.hypot(dy).max(1.0);
        let mut w = [0.0f32; 12];
        let mut cand = [NONE; 12];
        let mut turns = [Turn::Straight; 12];
        let mut k = 0;
        for &o in node.outs.iter() {
            if k >= 12 {
                break;
            }
            let ol = &self.g.links[o as usize];
            if !ol.alive || ol.len < 0.5 {
                continue;
            }
            let t = if ol.edge == l.edge { Turn::U } else { classify_turn(b_in, ol.bearing_start) };
            let tw = match t {
                Turn::Straight => 4.0,
                Turn::Right => 1.0,
                Turn::Left => 0.8,
                Turn::U => 0.0,
            };
            let mut ww = CLASS_W[ol.class as usize] * tw;
            if ol.flags & FLAG_LINK != 0 && l.flags & FLAG_LINK == 0 {
                ww *= 0.35;
            }
            // service roads are mostly dead ends / parking lots
            if ol.class == 6 && l.class < 6 {
                ww *= 0.3;
            }
            let cosd = (ol.bearing_start.cos() * dx + ol.bearing_start.sin() * dy) / dd;
            ww *= (1.1 * cosd).exp();
            cand[k] = o;
            turns[k] = t;
            w[k] = ww;
            k += 1;
        }
        let pick = self.rng.pick(&w[..k]);
        // only a U-turn possible (dead end): allow it
        match pick {
            Some(j) => (cand[j], turns[j]),
            None => {
                let u = node.outs.iter().copied().find(|&o| self.g.links[o as usize].alive);
                match u {
                    Some(o) => (o, Turn::U),
                    None => (NONE, Turn::Straight),
                }
            }
        }
    }

    fn cull(&mut self) {
        let mut i = 0;
        while i < self.cars.len() {
            if self.cars[i].flags & F_DEAD != 0 && self.cars[i].flags & F_PLAYER == 0 {
                let b = self.cars[i].bus;
                if b != NONE {
                    if let Some(bu) = self.buses[b as usize].take() {
                        self.bus_gone.extend_from_slice(&[bu.trip as f32, bu.delay]);
                    }
                    self.bus_free.push(b);
                }
                self.cars.swap_remove(i);
                self.bp.swap_remove(i);
            } else {
                i += 1;
            }
        }
    }

    fn spawn(&mut self) {
        self.refresh_active(false);
        let n_ai = self.cars.len();
        let target = self.target_cars as usize;
        if n_ai >= target {
            // demand dropped (evening / night, time jump, fast mode): retire the surplus out of
            // sight, a few per step so the population follows the demand curve smoothly
            let excess = n_ai - target;
            if excess > target / 20 + 3 {
                let k = (excess / 120).max(1);
                let mut done = 0;
                for _ in 0..k * 6 {
                    if done >= k {
                        break;
                    }
                    let j = self.rng.below(self.cars.len() as u32) as usize;
                    let c = &self.cars[j];
                    if c.flags & F_PLAYER != 0 || c.bus != NONE {
                        continue;
                    }
                    let unseen = !c.posed || !crate::view::in_view(self.camera, c.pose.x, c.pose.y, 2500.0);
                    let far = !c.posed || (c.pose.x - self.focus.0).hypot(c.pose.y - self.focus.1) > self.radius * 0.5;
                    if (far && unseen) || (unseen && self.camera.is_some()) || self.fast {
                        self.cars[j].flags |= F_DEAD;
                        done += 1;
                    }
                }
            }
            return;
        }
        if self.active.is_empty() {
            return;
        }
        let deficit = target - n_ai;
        let filling = n_ai * 2 < target;
        let k = if filling { (deficit / 3).clamp(1, 1500) } else { (deficit / 25).clamp(1, 40) };
        let total = *self.cum_w.last().unwrap();
        let mut tries = 0;
        let mut made = 0;
        // bodies placed in this call (not yet in the sorted lane lists): (link, lane, rear, front)
        let mut placed: Vec<(u32, u8, f32, f32)> = Vec::new();
        // no spawn onto a body already there (lanes of another link drawn over the same ground:
        // converging / auxiliary lanes); pgrid holds the bodies of the last rendered poses
        let mut near_new: Vec<[f64; 2]> = Vec::new();
        while made < k && tries < k * 3 {
            tries += 1;
            let r = self.rng.f32() * total;
            let j = self.cum_w.partition_point(|&x| x < r).min(self.active.len() - 1);
            let link = self.active[j];
            let l = &self.g.links[link as usize];
            if !l.alive || l.len < 10.0 {
                continue;
            }
            let kind = pick_kind(&mut self.rng, l.class);
            let len = idm::LENGTH[kind as usize];
            // keep the body out of both junction boxes
            let lo = self.sb_out(link) + len + 1.0;
            let hi = l.len - self.sb_in(link) - 2.0;
            if hi <= lo {
                continue;
            }
            let lane = self.rng.below(l.lanes as u32) as u8;
            let s = self.rng.range(lo, hi);
            // avoid popping cars into view at steady state
            if !filling {
                let p = self.g.link_pose(link, s, 0.0);
                let d = (p.x - self.focus.0).hypot(p.y - self.focus.1);
                if crate::view::in_view(self.camera, p.x, p.y, 2500.0) || (self.camera.is_none() && d < self.radius * 0.45 && self.rng.f32() < 0.9) {
                    continue;
                }
            }
            if self.obst_block(link, lane, s - len - 10.0, s + 10.0) || self.ghost_near(link, lane, s - len - 6.0, s + 6.0, usize::MAX) {
                continue;
            }
            if placed.iter().any(|&(pl, pn, r0, f0)| pl == link && pn == lane && s + 8.0 > r0 && s - len - 8.0 < f0) {
                continue;
            }
            let (cx, cy, _) = self.g.link_xyz(link, s - len * 0.5, self.g.lane_offset(l, lane));
            if near_new.iter().any(|p| (p[0] - cx).hypot(p[1] - cy) < 7.0) || self.body_near(cx, cy, 7.0) {
                continue;
            }
            let (ld, fl) = self.neighbours(link, lane, s, usize::MAX);
            let mut v = l.speed * self.rng.range(0.6, 1.0);
            if let Some(x) = ld {
                let gap = self.cars[x].s - self.cars[x].len - s;
                if gap < 6.0 {
                    continue;
                }
                v = v.min((gap - 4.0) / 1.5).min(self.cars[x].v + 2.0);
            }
            if let Some(x) = fl {
                if s - len - self.cars[x].s < 6.0 {
                    continue;
                }
            }
            // don't spawn right before a red/stop line at full speed
            let node = &self.g.nodes[l.to as usize];
            if node.control != Control::Free && l.len - s < 40.0 {
                v = v.min(4.0);
            }
            self.spawn_car(link, lane, s, v.max(0.0), kind);
            placed.push((link, lane, s - len, s));
            near_new.push([cx, cy]);
            made += 1;
        }
    }

    pub fn spawn_car(&mut self, link: u32, lane: u8, s: f32, v: f32, kind: u8) -> usize {
        let l = &self.g.links[link as usize];
        let ang = self.rng.f32() * 2.0 * PI;
        let dist = self.rng.range(1500.0, 6000.0) as f64;
        let node = &self.g.nodes[l.to as usize];
        let dest = [node.x + dist * ang.cos() as f64, node.y + dist * ang.sin() as f64];
        let color = if kind == idm::TRUCK || kind == idm::VAN {
            if self.rng.f32() < 0.6 { 0 } else { self.rng.below(16) as u8 }
        } else {
            self.rng.below(16) as u8
        };
        let vf = (1.0 + 0.08 * self.rng.normal()).clamp(0.85, 1.2) * if kind == idm::TRUCK { 0.92 } else { 1.0 };
        let mut p = idm::params(kind);
        // driver variation: accelerations and headways
        p.a *= (1.0 + 0.12 * self.rng.normal()).clamp(0.75, 1.3);
        p.t *= (1.0 + 0.1 * self.rng.normal()).clamp(0.8, 1.25);
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1).max(1);
        let lgen = l.gen;
        self.cars.push(Car {
            id,
            link,
            lgen,
            lane,
            s,
            v,
            a: 0.0,
            next: NONE,
            ngen: 0,
            turn: Turn::Straight,
            prev: NONE,
            pgen: 0,
            prev_lane: 0,
            kind,
            color,
            len: idm::LENGTH[kind as usize],
            idm: p,
            vf,
            dest,
            flags: 0,
            wait: 0.0,
            wait_conf: 0.0,
            lc_from: NO_LANE,
            lc_t: 0.0,
            lc_dur: 3.0,
            blend: [0.0; 3],
            lc_cool: self.rng.range(0.0, 2.0),
            pose: Pose::default(),
            posed: false,
            bus: NONE,
            next2: NONE,
        });
        self.bp.push([BoxPath::NONE; 2]);
        let i = self.cars.len() - 1;
        self.choose_next(i);
        i
    }

    // ------------------------------------------------------------------ buses (bus.rs)

    /// service-day seconds (4 am rollover) of the sim clock
    #[inline]
    fn service_time(&self) -> f64 {
        if self.tod < 4.0 * 3600.0 { self.tod + 86400.0 } else { self.tod }
    }

    pub fn bus_pattern(&mut self, id: u32, xy: &[f64], stop_d: &[f32], stop_flag: &[u8]) {
        self.bus_pats.insert(id, BusPattern::new(xy, stop_d, stop_flag));
    }

    /// Place bus trip `trip` (pattern `pat`) with its front at `front` along the pattern, in
    /// the curb lane of the road link under it. Returns false if no road / no room.
    #[allow(clippy::too_many_arguments)]
    pub fn bus_spawn(&mut self, trip: u32, pat: u32, len: f32, front: f32, v: f32, arr: &[f64], dep: &[f64]) -> u8 {
        if self.buses.iter().flatten().any(|b| b.trip == trip) {
            return 0;
        }
        let Some(p) = self.bus_pats.get(&pat) else { return 1 };
        let (q, t) = p.at(front);
        let hb = (t[1] as f32).atan2(t[0] as f32);
        let mut near = std::mem::take(&mut self.tmp);
        self.g.edges_near(q[0], q[1], 30.0, &mut near);
        let mut best: Option<(f32, u32, f32)> = None;
        for &eid in &near {
            let e = &self.g.edges[eid as usize];
            if !e.alive || e.class > 6 {
                continue;
            }
            let (se, lat, _, he) = self.g.project_on_edge(eid, q[0], q[1]);
            let dh = wrap_pi(hb - he);
            let (link, sl, latl) = if dh.abs() < 0.7 {
                (e.links[0], se, lat)
            } else if dh.abs() > PI - 0.7 {
                (e.links[1], e.len - se, -lat)
            } else {
                continue;
            };
            if link == NONE {
                continue;
            }
            let score = latl.abs() + dh.abs().min((PI - dh.abs()).abs()) * 5.0;
            if best.map_or(true, |b| score < b.0) {
                best = Some((score, link, sl));
            }
        }
        self.tmp = near;
        let Some((score, link, sl)) = best else { return 2 };
        if score > 20.0 {
            return 3;
        }
        let l = &self.g.links[link as usize];
        // near a link end (buses stop at junctions): shift it onto the link a little
        let sl = if sl < len + 1.0 && len + 1.0 - sl < 16.0 { len + 1.0 } else if sl > l.len - 1.5 && sl - (l.len - 1.5) < 12.0 { l.len - 1.5 } else { sl };
        if sl < len + 1.0 || sl > l.len - 1.0 {
            return 4;
        }
        let lane = 0u8;
        // room in the lane: ordinary cars in the way are taken out when away from the focus
        // (the bus takes their place out of sight), else the bus waits for a later try
        let far = {
            let (x, y, _) = self.g.link_xyz(link, sl, 0.0);
            (x - self.focus.0).hypot(y - self.focus.1) > 250.0
        };
        let (ld, fl) = self.neighbours(link, lane, sl, usize::MAX);
        for x in [ld, fl].into_iter().flatten() {
            let c = &self.cars[x];
            let clash = (c.s - c.len - sl < 2.0 && c.s > sl - len - 2.0) || (sl - len - c.s < 2.0 && c.s - c.len < sl + 2.0);
            if clash {
                if far && c.bus == NONE && c.flags & F_PLAYER == 0 {
                    self.cars[x].flags |= F_DEAD;
                } else {
                    return 5;
                }
            }
        }
        if self.obst_block(link, lane, sl - len - 2.0, sl + 2.0) {
            return 5;
        }
        // first stop ahead of the front
        let mut stop = 0;
        while stop < p.stop_d.len() && p.stop_d[stop] + len * 0.5 < front - 3.0 {
            stop += 1;
        }
        let vv = v.min(l.speed);
        let i = self.spawn_car_kind(link, lane, sl, vv, idm::TRUCK, len);
        let slot = match self.bus_free.pop() {
            Some(k) => k,
            None => {
                self.buses.push(None);
                (self.buses.len() - 1) as u32
            }
        };
        let id = self.cars[i].id;
        self.buses[slot as usize] = Some(BusAgent {
            trip,
            pat,
            sd: front,
            stop,
            arr: arr.to_vec(),
            dep: dep.to_vec(),
            state: BusState::Run,
            until: 0.0,
            delay: 0.0,
            len,
            car_id: id,
            route: Vec::new(),
            ri: 0,
        });
        let c = &mut self.cars[i];
        c.bus = slot;
        c.vf = 1.0;
        c.color = 0;
        c.next = NONE;
        self.choose_next(i);
        0
    }

    /// Bus of trip `old` (out of service after its last stop) continues as trip `new` of the
    /// same vehicle block: back on its pattern from here. False if it is not there / too far.
    pub fn bus_retrip(&mut self, old: u32, new: u32, pat: u32, arr: &[f64], dep: &[f64]) -> bool {
        let Some(slot) = self.buses.iter().position(|b| b.as_ref().map_or(false, |b| b.trip == old && b.state == BusState::OutOfService)) else { return false };
        let Some(ci) = self.cars.iter().position(|c| c.bus == slot as u32 && c.flags & F_DEAD == 0) else { return false };
        let Some(p) = self.bus_pats.get(&pat) else { return false };
        if !self.g.links[self.cars[ci].link as usize].alive {
            return false; // (its tile was unloaded: the bus is about to be evicted)
        }
        let (x, y, _, _) = self.car_point(ci, 0.0, 0.0);
        let (sd, d) = p.project(x, y, 0.0, 400.0);
        if d > 60.0 {
            return false;
        }
        let bu = self.buses[slot].as_mut().unwrap();
        bu.trip = new;
        bu.pat = pat;
        bu.sd = sd;
        bu.stop = 0;
        bu.arr = arr.to_vec();
        bu.dep = dep.to_vec();
        bu.state = BusState::Run;
        let c = &mut self.cars[ci];
        c.flags &= !F_COMMIT;
        c.next = NONE;
        self.choose_next(ci);
        true
    }

    /// fastest route of links from `l0` to `l1` (loaded graph, no U-turns), if any
    fn road_route(&self, l0: u32, l1: u32) -> Option<Vec<u32>> {
        let mut dist: std::collections::HashMap<u32, f32> = std::collections::HashMap::new();
        let mut prev: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();
        let mut heap = std::collections::BinaryHeap::new();
        dist.insert(l0, 0.0);
        heap.push((std::cmp::Reverse(0u32), l0));
        let mut found = false;
        while let Some((std::cmp::Reverse(c10), l)) = heap.pop() {
            let c = c10 as f32 / 10.0;
            if c > dist.get(&l).copied().unwrap_or(f32::INFINITY) + 0.05 || c > 1500.0 {
                continue;
            }
            if l == l1 {
                found = true;
                break;
            }
            let lk = &self.g.links[l as usize];
            let node = &self.g.nodes[lk.to as usize];
            for &o in &node.outs {
                let ol = &self.g.links[o as usize];
                if !ol.alive || ol.edge == lk.edge {
                    continue;
                }
                let c2 = c + ol.len / ol.speed.max(3.0) + 2.0;
                if c2 < dist.get(&o).copied().unwrap_or(f32::INFINITY) {
                    dist.insert(o, c2);
                    prev.insert(o, l);
                    heap.push((std::cmp::Reverse((c2 * 10.0) as u32), o));
                }
            }
        }
        if !found {
            return None;
        }
        let mut route = vec![l1];
        let mut k = l1;
        while k != l0 {
            k = prev[&k];
            route.push(k);
        }
        route.reverse();
        Some(route)
    }

    /// Pull-in: the out-of-service bus of trip `trip` (its block is over) drives to the garage
    /// at (gx, gy) and leaves the road there.
    pub fn bus_pullin(&mut self, trip: u32, gx: f64, gy: f64) -> bool {
        let Some(slot) = self.buses.iter().position(|b| b.as_ref().map_or(false, |b| b.trip == trip && b.state == BusState::OutOfService)) else { return false };
        let Some(ci) = self.cars.iter().position(|c| c.bus == slot as u32 && c.flags & F_DEAD == 0) else { return false };
        if !self.g.links[self.cars[ci].link as usize].alive {
            return false;
        }
        let mut near = std::mem::take(&mut self.tmp);
        self.g.edges_near(gx, gy, 150.0, &mut near);
        let mut best: Option<(f32, u32)> = None;
        for &eid in near.iter() {
            let e = &self.g.edges[eid as usize];
            if !e.alive || e.class > 6 {
                continue;
            }
            let (_, lat, _, _) = self.g.project_on_edge(eid, gx, gy);
            for &l in &e.links {
                if l != NONE && best.map_or(true, |b| lat.abs() < b.0) {
                    best = Some((lat.abs(), l));
                }
            }
        }
        self.tmp = near;
        let Some((_, l1)) = best else { return false };
        let l0 = self.cars[ci].link;
        let Some(route) = self.road_route(l0, l1) else { return false };
        let bu = self.buses[slot].as_mut().unwrap();
        bu.state = BusState::Deadhead;
        bu.route = route;
        bu.ri = usize::MAX; // to the garage (not a trip start)
        let c = &mut self.cars[ci];
        c.flags &= !F_COMMIT;
        c.next = NONE;
        self.choose_next(ci);
        true
    }

    /// Pull-out: bus trip `trip` leaves the garage at (gx, gy) and drives (not in service)
    /// along the shortest road route to the link of its first stop, where it starts its
    /// trip. 0 = placed, else a failure reason (1 pattern, 2 no road at the garage, 3 no
    /// road at the first stop, 4 no route, 5 no room).
    #[allow(clippy::too_many_arguments)]
    pub fn bus_pullout(&mut self, trip: u32, pat: u32, len: f32, arr: &[f64], dep: &[f64], gx: f64, gy: f64) -> u8 {
        if self.buses.iter().flatten().any(|b| b.trip == trip) {
            return 0;
        }
        let Some(p) = self.bus_pats.get(&pat) else { return 1 };
        let front0 = (p.stop_d.first().copied().unwrap_or(0.0) + len * 0.5).min(p.length());
        let (q, t) = p.at(front0);
        // target link: under the first stop, travelling with the pattern
        let mut near = std::mem::take(&mut self.tmp);
        let pick = |w: &World, x: f64, y: f64, hb: Option<f32>, near: &mut Vec<u32>| -> Option<(u32, f32)> {
            w.g.edges_near(x, y, 60.0, near);
            let mut best: Option<(f32, u32, f32)> = None;
            for &eid in near.iter() {
                let e = &w.g.edges[eid as usize];
                if !e.alive || e.class > 6 {
                    continue;
                }
                let (se, lat, _, he) = w.g.project_on_edge(eid, x, y);
                for (k, dh0) in [(0usize, 0.0f32), (1, PI)] {
                    let link = e.links[k];
                    if link == NONE {
                        continue;
                    }
                    let dh = hb.map_or(0.0, |h| wrap_pi(h - he - dh0).abs());
                    if dh > 0.7 {
                        continue;
                    }
                    let s = if k == 0 { se } else { e.len - se };
                    let score = lat.abs() + dh * 5.0;
                    if best.map_or(true, |b| score < b.0) {
                        best = Some((score, link, s));
                    }
                }
            }
            best.map(|b| (b.1, b.2))
        };
        let hb = (t[1] as f32).atan2(t[0] as f32);
        let target = pick(self, q[0], q[1], Some(hb), &mut near);
        let start = pick(self, gx, gy, None, &mut near);
        self.tmp = near;
        let Some((l0, s0)) = start else { return 2 };
        let Some((l1, _)) = target else { return 3 };
        let Some(route) = self.road_route(l0, l1) else { return 4 };
        let ll = self.g.links[l0 as usize].len;
        let s = s0.clamp(len + 1.0, (ll - 1.0).max(len + 1.0));
        if s > ll - 0.5 {
            return 5;
        }
        let (ld, fl) = self.neighbours(l0, 0, s, usize::MAX);
        for x in [ld, fl].into_iter().flatten() {
            let c = &self.cars[x];
            if c.s > s - len - 3.0 && c.s - c.len < s + 3.0 {
                return 5;
            }
        }
        let i = self.spawn_car_kind(l0, 0, s, 0.0, idm::TRUCK, len);
        let slot = match self.bus_free.pop() {
            Some(k) => k,
            None => {
                self.buses.push(None);
                (self.buses.len() - 1) as u32
            }
        };
        let id = self.cars[i].id;
        self.buses[slot as usize] = Some(BusAgent {
            trip,
            pat,
            sd: 0.0,
            stop: 0,
            arr: arr.to_vec(),
            dep: dep.to_vec(),
            state: BusState::Deadhead,
            until: 0.0,
            delay: 0.0,
            len,
            car_id: id,
            route,
            ri: 0,
        });
        let c = &mut self.cars[i];
        c.bus = slot;
        c.vf = 1.0;
        c.color = 0;
        c.next = NONE;
        self.choose_next(i);
        0
    }

    fn spawn_car_kind(&mut self, link: u32, lane: u8, s: f32, v: f32, kind: u8, len: f32) -> usize {
        let i = self.spawn_car(link, lane, s, v, kind);
        self.cars[i].len = len;
        i
    }

    /// Guided routing: the outgoing link that follows the bus's pattern. False (and the
    /// bus goes out of service) when no link does.
    fn bus_guide(&mut self, i: usize) -> bool {
        let b = self.cars[i].bus as usize;
        let Some(bu) = self.buses[b].as_ref() else { return false };
        if bu.state == BusState::OutOfService {
            return false;
        }
        if bu.state == BusState::Deadhead {
            // next link of the pull-out route; at its end the bus joins its pattern
            let link = self.cars[i].link;
            let k = bu.route.iter().position(|&l| l == link);
            if let Some(k) = k {
                if k + 1 < bu.route.len() {
                    let o = bu.route[k + 1];
                    let l = &self.g.links[link as usize];
                    let t = classify_turn(l.bearing_end, self.g.links[o as usize].bearing_start);
                    let c = &mut self.cars[i];
                    c.next = o;
                    c.turn = t;
                    c.ngen = self.g.links[o as usize].gen;
                    return true;
                }
            }
            // on the last route link: from here on the pattern guides (pull-out), or the bus
            // turns into its garage (pull-in)
            let bu = self.buses[b].as_mut().unwrap();
            if bu.ri == usize::MAX {
                self.cars[i].flags |= F_DEAD;
                return true;
            }
            bu.state = BusState::Run;
        }
        let Some(bu) = self.buses[b].as_ref() else { return false };
        let Some(p) = self.bus_pats.get(&bu.pat) else { return false };
        let link = self.cars[i].link;
        let l = &self.g.links[link as usize];
        let node = &self.g.nodes[l.to as usize];
        let rem = (l.len - self.cars[i].s).max(0.0);
        let sd0 = bu.sd + rem;
        if sd0 > p.length() - 2.0 {
            return false; // end of the pattern
        }
        let b_in = l.bearing_end;
        let mut best: Option<(f32, u32, Turn)> = None;
        for &o in node.outs.iter() {
            let ol = &self.g.links[o as usize];
            if !ol.alive || ol.len < 0.5 {
                continue;
            }
            // how well does the link follow the shape ahead?
            let mut err = 0.0f32;
            let mut n = 0.0f32;
            for &k in &[6.0f32, 18.0, 35.0] {
                if k > ol.len + 2.0 && n > 0.0 {
                    break;
                }
                let (x, y, _) = self.g.link_xyz(o, k.min(ol.len), 0.0);
                let (_, d) = p.project(x, y, sd0 - 15.0, sd0 + k + 40.0);
                err += d;
                n += 1.0;
            }
            let err = err / n.max(1.0);
            let t = if ol.edge == l.edge { Turn::U } else { classify_turn(b_in, ol.bearing_start) };
            let pen = if t == Turn::U { 25.0 } else { 0.0 };
            if best.map_or(true, |bb| err + pen < bb.0) {
                best = Some((err + pen, o, t));
            }
        }
        match best {
            Some((err, o, t)) if err < 16.0 => {
                let c = &mut self.cars[i];
                c.next = o;
                c.turn = t;
                c.ngen = self.g.links[o as usize].gen;
                true
            }
            _ => {
                // the pattern leaves the road graph here: out of service from now on
                if let Some(bu) = self.buses[b].as_mut() {
                    bu.state = BusState::OutOfService;
                }
                false
            }
        }
    }

    /// after moving onto a new link: re-sync the progress along the pattern
    fn bus_resync(&mut self, i: usize) {
        let b = self.cars[i].bus;
        if b == NONE {
            return;
        }
        let (x, y, _) = self.g.link_xyz(self.cars[i].link, self.cars[i].s.max(0.0), 0.0);
        let Some(bu) = self.buses[b as usize].as_mut() else { return };
        let Some(p) = self.bus_pats.get(&bu.pat) else { return };
        if bu.state == BusState::Deadhead {
            return;
        }
        let (sd, d) = p.project(x, y, bu.sd - 40.0, bu.sd + 60.0);
        if d < 25.0 {
            bu.sd = sd;
        }
    }

    /// distance from the bus front to its next stop point (m), if it is running to one
    fn bus_stop_ahead(&self, i: usize) -> Option<f32> {
        let bu = self.buses[self.cars[i].bus as usize].as_ref()?;
        if bu.state != BusState::Run {
            return None;
        }
        let p = self.bus_pats.get(&bu.pat)?;
        let mut k = bu.stop;
        while k < p.stop_d.len() && p.stop_flag[k] & 1 != 0 {
            k += 1;
        }
        if k >= p.stop_d.len() {
            return None;
        }
        Some(bu.stop_front(p, k) - bu.sd)
    }

    /// gap (m) the bus must stop within: its stop ahead, or 0 while dwelling
    fn bus_stop_gap(&self, i: usize) -> Option<f32> {
        let bu = self.buses[self.cars[i].bus as usize].as_ref()?;
        match bu.state {
            BusState::Dwell => Some(0.0),
            BusState::Run => {
                let d = self.bus_stop_ahead(i)?;
                if d < 150.0 && d > -2.0 {
                    Some(d.max(0.0))
                } else {
                    None
                }
            }
            BusState::OutOfService | BusState::Deadhead => None,
        }
    }

    /// stop arrivals / departures, end of trip
    fn bus_stops(&mut self) {
        if self.buses.is_empty() {
            return;
        }
        let t = self.service_time();
        for i in 0..self.cars.len() {
            let b = self.cars[i].bus;
            if b == NONE || self.cars[i].flags & F_DEAD != 0 {
                continue;
            }
            let v = self.cars[i].v;
            let Some(bu) = self.buses[b as usize].as_mut() else { continue };
            let Some(p) = self.bus_pats.get(&bu.pat) else { continue };
            match bu.state {
                BusState::Run => {
                    // skip virtual points and stops already passed (missed)
                    while bu.stop < p.stop_d.len() && (p.stop_flag[bu.stop] & 1 != 0 || bu.sd > bu.stop_front(p, bu.stop) + 12.0) {
                        bu.stop += 1;
                    }
                    if bu.stop >= p.stop_d.len() {
                        bu.state = BusState::OutOfService;
                        continue;
                    }
                    let d = bu.stop_front(p, bu.stop) - bu.sd;
                    if d < 3.0 && v < 0.4 {
                        let k = bu.stop;
                        let (arr, dep) = (bu.arr.get(k).copied().unwrap_or(t), bu.dep.get(k).copied().unwrap_or(t));
                        bu.delay = (t - arr) as f32;
                        bu.until = dep.max(t + BUS_DWELL);
                        bu.state = if k + 1 >= p.stop_d.len() { BusState::OutOfService } else { BusState::Dwell };
                        if bu.state == BusState::OutOfService {
                            bu.until = t + BUS_DWELL;
                        }
                    }
                }
                BusState::Dwell => {
                    if t >= bu.until {
                        bu.stop += 1;
                        bu.state = BusState::Run;
                    }
                }
                BusState::OutOfService | BusState::Deadhead => {}
            }
        }
    }

    /// bus render records (BUS_STRIDE floats) + body paths (rear -> front, every 2 m)
    pub fn write_buses(&mut self, oe: f64, on: f64) {
        self.out_buses.clear();
        self.out_bus_path.clear();
        for i in 0..self.cars.len() {
            let c = &self.cars[i];
            if c.bus == NONE || c.flags & F_DEAD != 0 {
                continue;
            }
            let Some(bu) = self.buses[c.bus as usize].as_ref() else { continue };
            let mut f = 0u32;
            match bu.state {
                BusState::Dwell => f |= BF_DWELL | BF_DOORS,
                BusState::OutOfService | BusState::Deadhead => f |= BF_NIS,
                _ => {}
            }
            if c.a < -0.8 || c.v < 0.3 {
                f |= BF_BRAKE;
            }
            let p0 = (self.out_bus_path.len() / 3) as u32;
            let len = c.len;
            let n = ((len + 2.0) / 2.0).ceil() as usize;
            let dt_lc = |back: f32| if c.lc_from != NO_LANE { c.lc_t - back / (c.v.max(2.0) * c.lc_dur) } else { 0.0 };
            for k in 0..=n {
                let back = len + 1.0 - (len + 2.0) * k as f32 / n as f32; // rear -> front
                let (x, y, z, _) = self.car_point(i, back.max(-1.0), dt_lc(back));
                self.out_bus_path.extend_from_slice(&[(x - oe) as f32, (y - on) as f32, z]);
            }
            self.out_buses.extend_from_slice(&[bu.trip as f32, bu.sd - len * 0.5, c.v, f32::from_bits(f), bu.delay, len, p0 as f32, (n + 1) as f32]);
        }
        let _ = BUS_STRIDE;
    }

    // ------------------------------------------------------------------ output

    /// Render pose of an AI car (body centre, heading from rear to front axle).
    pub fn car_pose(&self, i: usize) -> (Pose, bool) {
        let c = &self.cars[i];
        let d_axle = c.len * 0.3;
        let half = c.len * 0.5;
        let dt_lc = if c.lc_from != NO_LANE { d_axle / (c.v.max(2.0) * c.lc_dur) } else { 0.0 };
        let (xf, yf, zf, sf) = self.car_point(i, half - d_axle, c.lc_t + dt_lc);
        let (xr, yr, zr, sr) = self.car_point(i, half + d_axle, c.lc_t - dt_lc);
        let (dx, dy) = ((xf - xr) as f32, (yf - yr) as f32);
        let horiz = dx.hypot(dy);
        let h = if horiz > 1e-3 { dy.atan2(dx) } else { c.pose.h };
        let p = if horiz > 1e-3 { (zf - zr).atan2(horiz) } else { 0.0 };
        (
            Pose {
                x: (xf + xr) * 0.5 + c.blend[0] as f64,
                y: (yf + yr) * 0.5 + c.blend[1] as f64,
                z: (zf + zr) * 0.5 + c.blend[2],
                h,
                p,
            },
            sf || sr,
        )
    }

    /// Fill `out_cars` with render records relative to (oe, on).
    /// Record: [dE, dN, elev, heading, pitch, speed, meta(u32 bits), id(u32 bits)]
    /// meta: kind | color << 8 | flags << 16 | ground << 24
    ///   flags: 1 brake, 2 player, 4 indicator left, 8 indicator right
    ///   ground: road class (bits 0-2) | 8 on a bridge/in a tunnel (elevation from the graph)
    pub fn write_cars(&mut self, oe: f64, on: f64) {
        self.update_paths();
        self.out_cars.clear();
        let n = self.cars.len();
        for i in 0..n {
            let c = &self.cars[i];
            if c.flags & F_DEAD != 0 {
                continue;
            }
            if c.bus != NONE {
                // drawn by the transit layer (write_buses); keep the pose for queries
                let (pose, _) = self.car_pose(i);
                let c = &mut self.cars[i];
                c.pose = pose;
                c.posed = true;
                continue;
            }
            let (pose, speed, flags, ground) = if c.flags & F_PLAYER != 0 {
                let Some(p) = &self.player else { continue };
                let cls = if c.link != NONE && p.on_road { self.g.links[c.link as usize].class.min(7) as u32 } else { 7 };
                (
                    Pose { x: p.x, y: p.y, z: p.z, h: p.h, p: p.p },
                    p.v,
                    2u32 | if p.v > 0.5 && c.a < -1.0 { 1 } else { 0 },
                    cls | if p.structure { 8 } else { 0 },
                )
            } else {
                let (pose, structure) = self.car_pose(i);
                let l = &self.g.links[c.link as usize];
                let dist_end = l.len - c.s;
                let mut f = if c.a < -0.8 || c.v < 0.3 || c.flags & F_HELD != 0 { 1u32 } else { 0 };
                if c.lc_from != NO_LANE {
                    // higher lane index = further left
                    f |= if c.lane > c.lc_from { 4 } else { 8 };
                } else if dist_end < 50.0 || (self.prev_ok(c) && c.s < c.len + 4.0) {
                    let t = if dist_end < 50.0 { c.turn } else { Turn::Straight };
                    f |= match t {
                        Turn::Left | Turn::U => 4,
                        Turn::Right => 8,
                        _ => 0,
                    };
                }
                (pose, c.v, f, l.class.min(7) as u32 | if structure { 8 } else { 0 })
            };
            let c = &mut self.cars[i];
            c.pose = pose;
            c.posed = true;
            let meta = c.kind as u32 | (c.color as u32) << 8 | flags << 16 | ground << 24;
            self.out_cars.extend_from_slice(&[
                (pose.x - oe) as f32,
                (pose.y - on) as f32,
                pose.z,
                pose.h,
                pose.p,
                speed,
                f32::from_bits(meta),
                f32::from_bits(c.id),
            ]);
        }
    }

    /// Signal approaches around the focus (see `Graph::signal_approaches`).
    pub fn write_signals(&mut self, oe: f64, on: f64) {
        let mut out = std::mem::take(&mut self.out_signals);
        out.clear();
        self.g.signal_approaches(self.focus.0, self.focus.1, self.radius, self.tod, oe, on, &mut out);
        self.out_signals = out;
    }

    // ------------------------------------------------------------------ player

    fn player_index(&self) -> Option<usize> {
        let id = self.player.as_ref()?.id;
        self.cars.iter().position(|c| c.id == id)
    }

    /// Place the player car on the nearest drivable lane.
    pub fn spawn_player(&mut self, e: f64, n: f64, heading: f32) -> bool {
        self.release_player();
        let mut near = std::mem::take(&mut self.tmp);
        let mut best: Option<(u32, f32, f32)> = None; // edge, s, dist
        for r in [40.0, 150.0, 400.0] {
            self.g.edges_near(e, n, r, &mut near);
            for &eid in &near {
                let ed = &self.g.edges[eid as usize];
                if !ed.alive || ed.class > 5 {
                    continue;
                }
                let (s, lat, _, _) = self.g.project_on_edge(eid, e, n);
                let d = lat.abs();
                if best.map_or(true, |b| d < b.2) {
                    best = Some((eid, s, d));
                }
            }
            if best.is_some() {
                break;
            }
        }
        self.tmp = near;
        let Some((eid, s, _)) = best else { return false };
        let ed = &self.g.edges[eid as usize];
        let (_, _, _, hdg) = self.g.project_on_edge(eid, e, n);
        let fwd_ok = ed.links[0] != NONE;
        let bwd_ok = ed.links[1] != NONE;
        let use_fwd = if fwd_ok && bwd_ok { (heading - hdg).cos() >= 0.0 } else { fwd_ok };
        let link = if use_fwd { ed.links[0] } else { ed.links[1] };
        let structure = ed.flags & (FLAG_BRIDGE | FLAG_TUNNEL) != 0;
        let l = &self.g.links[link as usize];
        let ls = if use_fwd { s } else { l.len - s };
        let pose = self.g.link_pose(link, ls, self.g.lane_offset(l, 0));
        let lgen = l.gen;
        let llen = l.len;
        let id = self.next_id;
        self.next_id += 1;
        self.cars.push(Car {
            id,
            link,
            lgen,
            lane: 0,
            s: (ls + PLAYER_HL).min(llen - 0.01),
            v: 0.0,
            a: 0.0,
            next: NONE,
            ngen: 0,
            turn: Turn::Straight,
            prev: NONE,
            pgen: 0,
            prev_lane: 0,
            kind: idm::SEDAN,
            color: 5,
            len: idm::LENGTH[0],
            idm: idm::params(0),
            vf: 1.0,
            dest: [0.0, 0.0],
            flags: F_PLAYER,
            wait: 0.0,
            wait_conf: 0.0,
            lc_from: NO_LANE,
            lc_t: 0.0,
            lc_dur: 3.0,
            blend: [0.0; 3],
            lc_cool: 0.0,
            pose,
            posed: true,
            bus: NONE,
            next2: NONE,
        });
        self.bp.push([BoxPath::NONE; 2]);
        self.player = Some(Player { x: pose.x, y: pose.y, z: pose.z, h: pose.h, p: pose.p, v: 0.0, steer: 0.0, on_road: true, edge: eid, id, placed: true, structure, bump: 0.0 });
        true
    }

    /// Turn an AI car into the player car.
    pub fn take_over(&mut self, id: u32) -> bool {
        if !self.cars.iter().any(|c| c.id == id && c.flags & F_DEAD == 0) {
            return false;
        }
        self.release_player();
        let Some(i) = self.cars.iter().position(|c| c.id == id) else { return false };
        let pose = if self.cars[i].posed { self.cars[i].pose } else { self.car_pose(i).0 };
        let structure = self.structural(self.cars[i].link);
        let c = &mut self.cars[i];
        c.flags |= F_PLAYER;
        c.flags &= !(F_COMMIT | F_HELD);
        c.lc_from = NO_LANE;
        let edge = self.g.links[c.link as usize].edge;
        let v = c.v;
        self.player = Some(Player { x: pose.x, y: pose.y, z: pose.z, h: pose.h, p: pose.p, v, steer: 0.0, on_road: true, edge, id, placed: true, structure, bump: 0.0 });
        true
    }

    /// Hand the player car back to the AI (if on a lane) or remove it.
    pub fn release_player(&mut self) {
        let Some(i) = self.player_index() else {
            self.player = None;
            return;
        };
        let p = self.player.take().unwrap();
        let on_lane = self.cars[i].link != NONE && self.g.links[self.cars[i].link as usize].alive;
        if on_lane {
            {
                let c = &mut self.cars[i];
                c.flags &= !F_PLAYER;
                c.v = p.v.max(0.0);
                c.prev = NONE;
                c.lc_from = NO_LANE;
                c.blend = [0.0; 3];
            }
            // render continuity: offset from the lane pose to where the player was
            let (lp, _) = self.car_pose(i);
            let c = &mut self.cars[i];
            c.blend = [(p.x - lp.x) as f32, (p.y - lp.y) as f32, p.z - lp.z];
            c.pose = Pose { x: p.x, y: p.y, z: p.z, h: p.h, p: p.p };
            let ang = self.rng.f32() * 2.0 * PI;
            c.dest = [p.x + 3000.0 * ang.cos() as f64, p.y + 3000.0 * ang.sin() as f64];
            self.choose_next(i);
        } else {
            self.cars.swap_remove(i);
            self.bp.swap_remove(i);
        }
    }

    /// Kinematic bicycle model + collisions (AI cars, transit, buildings) + road snapping.
    /// `dt` is real time.
    pub fn player_step(&mut self, dt: f32, throttle: f32, brake: f32, steer_in: f32, handbrake: bool, ground_z: f32) {
        let Some(pi) = self.player_index() else {
            self.player = None;
            return;
        };
        let dt = dt.min(0.05);
        let mut near = std::mem::take(&mut self.tmp);
        let p = self.player.as_mut().unwrap();
        const WHEELBASE: f32 = 2.8;
        const VMAX: f32 = 39.0;
        let max_steer = 0.55 / (1.0 + p.v.abs() / 11.0);
        let target = steer_in.clamp(-1.0, 1.0) * max_steer;
        p.steer += (target - p.steer) * (dt * 7.0).min(1.0);
        let mut a = 0.0f32;
        if throttle > 0.0 {
            a += if p.v < -0.2 { 8.0 * throttle } else { throttle * 4.6 * (1.0 - (p.v / VMAX).powi(2)).max(0.0) + 0.0 };
        }
        if brake > 0.0 {
            if p.v > 0.3 {
                a -= 9.0 * brake;
            } else if p.v > -6.0 {
                a -= 2.5 * brake;
            }
        }
        // rolling resistance + aero drag
        a -= 0.00045 * p.v * p.v.abs() + if throttle == 0.0 && brake == 0.0 { 0.25 * p.v.signum() } else { 0.0 };
        if handbrake {
            a -= 7.0 * p.v.signum();
        }
        let nv = (p.v + a * dt).clamp(-6.0, VMAX);
        p.v = if p.v.signum() != nv.signum() && throttle == 0.0 && p.v != 0.0 && !(brake > 0.0 && p.v <= 0.3) { 0.0 } else { nv };
        if p.v.abs() < 0.05 && throttle == 0.0 && brake == 0.0 {
            p.v = 0.0;
        }
        let yaw = p.v / WHEELBASE * p.steer.tan() * if handbrake { 1.5 } else { 1.0 };
        p.h = wrap_pi(p.h + yaw * dt);
        p.x += (p.v * p.h.cos() * dt) as f64;
        p.y += (p.v * p.h.sin() * dt) as f64;
        p.bump *= (-dt * 4.0).exp();
        self.player_collide(pi);
        // road snapping (elevation, lane for the AI)
        let p = self.player.as_ref().unwrap();
        let (px, py, pz, ph) = (p.x, p.y, p.z, p.h);
        self.g.edges_near(px, py, 14.0, &mut near);
        let mut best: Option<(u32, f32, f32, f32, f32, f32)> = None; // edge, s, lat, z, hdg, score
        for &eid in &near {
            let ed = &self.g.edges[eid as usize];
            if !ed.alive {
                continue;
            }
            let (s, lat, z, hdg) = self.g.project_on_edge(eid, px, py);
            if lat.abs() > ed.half_w + 1.2 {
                continue;
            }
            let dz = (z - pz).abs();
            if dz > 4.0 {
                continue;
            }
            let score = lat.abs() / ed.half_w.max(1.0) + dz;
            if best.map_or(true, |b| score < b.5) {
                best = Some((eid, s, lat, z, hdg, score));
            }
        }
        self.tmp = near;
        let (tz, tp, structure) = if let Some((eid, s, lat, z, hdg, _)) = best {
            let ed = &self.g.edges[eid as usize];
            let fwd = (ph - hdg).cos() >= 0.0;
            let link = if fwd { ed.links[0] } else { ed.links[1] };
            let pose = self.g.edge_pose(ed, s, 0.0, !fwd);
            let structure = ed.flags & (FLAG_BRIDGE | FLAG_TUNNEL) != 0;
            let c = &mut self.cars[pi];
            if link != NONE {
                let l = &self.g.links[link as usize];
                let ls = if fwd { s } else { l.len - s };
                let lat_dir = if fwd { lat } else { -lat };
                let mut lane = 0u8;
                let mut bd = f32::INFINITY;
                for k in 0..l.lanes {
                    let d = (self.g.lane_offset(l, k) - lat_dir).abs();
                    if d < bd {
                        bd = d;
                        lane = k;
                    }
                }
                c.link = link;
                c.lgen = l.gen;
                c.lane = lane;
                // `s` is the front bumper; the player position is the body centre
                c.s = (ls + PLAYER_HL).clamp(0.0, l.len - 0.01);
            } else {
                c.link = NONE;
            }
            let p = self.player.as_mut().unwrap();
            p.on_road = true;
            p.edge = eid;
            (z, pose.p, structure)
        } else {
            let p = self.player.as_mut().unwrap();
            p.on_road = false;
            self.cars[pi].link = NONE;
            (ground_z, 0.0, false)
        };
        let p = self.player.as_mut().unwrap();
        if !p.placed {
            p.z = tz;
        }
        p.placed = true;
        p.structure = structure;
        p.z += (tz - p.z) * (dt * 10.0).min(1.0);
        p.p += (tp - p.p) * (dt * 6.0).min(1.0);
        let c = &mut self.cars[pi];
        c.a = a;
        c.v = p.v.max(0.0);
        c.pose = Pose { x: p.x, y: p.y, z: p.z, h: p.h, p: p.p };
    }

    /// Resolve overlaps of the player car with AI cars, transit and buildings:
    /// push it out and bounce with a small impulse.
    fn player_collide(&mut self, pi: usize) {
        let p = self.player.as_ref().unwrap();
        let (mut x, mut y, h, mut v) = (p.x, p.y, p.h, p.v);
        let mut bump = 0.0f32;
        let (hs, hc) = h.sin_cos();
        let mut hit_ai: Vec<usize> = Vec::new();
        let mut resolve = |x: &mut f64, y: &mut f64, v: &mut f32, other: &Obb| {
            let me = Obb { x: *x, y: *y, h, hl: PLAYER_HL, hw: PLAYER_HW };
            if let Some((ax, pen)) = obb_overlap(&me, other) {
                *x += (ax.0 * (pen + 0.02)) as f64;
                *y += (ax.1 * (pen + 0.02)) as f64;
                // velocity component into the other body
                let vn = *v * (hc * ax.0 + hs * ax.1);
                if vn < 0.0 {
                    bump = bump.max(-vn);
                    *v = -*v * 0.25;
                }
                true
            } else {
                false
            }
        };
        for (j, c) in self.cars.iter().enumerate() {
            if j == pi || c.flags & F_DEAD != 0 || !c.posed {
                continue;
            }
            if (c.pose.x - x).powi(2) + (c.pose.y - y).powi(2) > 144.0 {
                continue;
            }
            let ob = Obb { x: c.pose.x, y: c.pose.y, h: c.pose.h, hl: c.len * 0.5, hw: HALF_W[c.kind as usize % idm::KINDS] };
            if resolve(&mut x, &mut y, &mut v, &ob) {
                hit_ai.push(j);
            }
        }
        for o in &self.obst {
            let (os, oc) = o.h.sin_cos();
            let (cx, cy) = (o.x - (oc * o.len * 0.5) as f64, o.y - (os * o.len * 0.5) as f64);
            if (cx - x).powi(2) + (cy - y).powi(2) > ((o.len * 0.5 + 6.0) as f64).powi(2) {
                continue;
            }
            resolve(&mut x, &mut y, &mut v, &Obb { x: cx, y: cy, h: o.h, hl: o.len * 0.5, hw: o.w * 0.5 });
        }
        // buildings: three circles along the body
        if self.fp.count > 0 {
            for _ in 0..2 {
                let mut total = (0.0f32, 0.0f32);
                for k in [-1.5f32, 0.0, 1.5] {
                    let (cx, cy) = (x as f32 + hc * k, y as f32 + hs * k);
                    if let Some(pu) = self.fp.push_circle(cx, cy, PLAYER_HW + 0.05) {
                        total.0 += pu.0;
                        total.1 += pu.1;
                    }
                }
                let l = total.0.hypot(total.1);
                if l < 1e-4 {
                    break;
                }
                x += total.0 as f64;
                y += total.1 as f64;
                let vn = v * (hc * total.0 + hs * total.1) / l;
                if vn < 0.0 {
                    bump = bump.max(-vn);
                    v = -v * 0.2;
                }
            }
        }
        for j in hit_ai {
            let c = &mut self.cars[j];
            c.v = 0.0;
            c.lc_cool = 3.0;
        }
        let p = self.player.as_mut().unwrap();
        p.x = x;
        p.y = y;
        p.v = v;
        p.bump = p.bump.max(bump);
    }

    pub fn player_road(&self) -> Option<(i32, i32, u32)> {
        let p = self.player.as_ref()?;
        if !p.on_road {
            return None;
        }
        let e = &self.g.edges[p.edge as usize];
        if !e.alive {
            return None;
        }
        Some((e.tile.0, e.tile.1, e.idx))
    }

    /// average measured speed ratio per major link since the last call:
    /// [tx, ty, edgeIdx, ratio] quadruples
    pub fn measured(&mut self) -> Vec<f32> {
        let mut out = Vec::new();
        for l in self.g.links.iter_mut() {
            if l.alive && l.spd_n >= 30 {
                let e = &self.g.edges[l.edge as usize];
                out.extend_from_slice(&[e.tile.0 as f32, e.tile.1 as f32, e.idx as f32, (l.spd_sum / l.spd_n as f32).min(1.0)]);
            }
            l.spd_sum = 0.0;
            l.spd_n = 0;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::tests::load_cross;

    fn world_with_cross(flags: u8, classes: [u8; 4]) -> World {
        let mut w = World::new(7, 2000, 100);
        load_cross(&mut w.g, flags, classes);
        w.focus = (512.0, 512.0);
        w.radius = 1000.0;
        w
    }

    fn link_between(w: &World, from: u64, to: u64) -> u32 {
        let f = w.g.node_map[&from];
        let t = w.g.node_map[&to];
        (0..w.g.links.len() as u32).find(|&l| w.g.links[l as usize].from == f && w.g.links[l as usize].to == t).unwrap()
    }

    #[test]
    fn stops_at_red_light() {
        let mut w = world_with_cross(1, [2, 5, 2, 5]);
        // approach from the south (minor road, class 5): phase B
        let link = link_between(&w, 5, 1);
        let plan = w.g.nodes[w.g.node_map[&1] as usize].plan;
        // pick a time where phase B is red for a long while: start of phase A green
        w.tod = (plan.cycle() as f64 * 100.0) - plan.offset as f64;
        w.max_cars = 0;
        let i = w.spawn_car(link, 0, 100.0, 12.0, 0);
        let sb = w.g.nodes[w.g.node_map[&1] as usize].setback;
        for _ in 0..(plan.green_a as usize * 10 - 20) {
            w.step(0.1);
        }
        let c = &w.cars[i];
        assert_eq!(c.link, link, "still on the approach");
        assert!(c.v < 0.2, "stopped: v={}", c.v);
        let stop_line = 200.0 - sb;
        assert!(c.s < stop_line && c.s > stop_line - 4.0, "at the line: s={} line={}", c.s, stop_line);
        // wait for green: it must go
        for _ in 0..400 {
            w.step(0.1);
        }
        assert!(w.cars.is_empty() || w.cars[0].link != link, "moved on after green");
    }

    #[test]
    fn queue_and_no_overlap() {
        let mut w = world_with_cross(1, [2, 5, 2, 5]);
        let link = link_between(&w, 5, 1);
        w.max_cars = 0;
        for k in 0..8 {
            w.spawn_car(link, 0, 10.0 + k as f32 * 16.0, 8.0, (k % 6) as u8);
        }
        for _ in 0..600 {
            w.step(0.1);
            // no two cars on the same lane overlap
            let mut v: Vec<(u32, u8, f32, f32)> = w.cars.iter().map(|c| (c.link, c.lane, c.s, c.len)).collect();
            v.sort_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)).then(b.2.partial_cmp(&a.2).unwrap()));
            for p in v.windows(2) {
                if p[0].0 == p[1].0 && p[0].1 == p[1].1 {
                    assert!(p[0].2 - p[0].3 - p[1].2 > -0.01, "overlap {:?}", p);
                }
            }
        }
    }

    #[test]
    fn spawns_to_demand_and_evicts() {
        let mut w = world_with_cross(0, [2, 2, 2, 2]);
        w.tod = 8.0 * 3600.0;
        for _ in 0..50 {
            w.step(0.1);
        }
        assert!(w.target_cars > 5.0);
        assert!(w.cars.len() as f32 >= w.target_cars * 0.5, "{} of {}", w.cars.len(), w.target_cars);
        w.write_cars(0.0, 0.0);
        assert_eq!(w.out_cars.len(), w.cars.len() * CAR_STRIDE);
        w.g.remove_tile(0, 0);
        w.step(0.1);
        assert!(w.cars.is_empty());
    }

    #[test]
    fn player_drives_and_ai_follows() {
        let mut w = world_with_cross(0, [2, 2, 2, 2]);
        assert!(w.spawn_player(612.0, 505.0, 0.0));
        for _ in 0..60 {
            w.player_step(1.0 / 30.0, 1.0, 0.0, 0.0, false, 0.0);
            w.step(1.0 / 30.0);
        }
        let p = w.player.as_ref().unwrap();
        assert!(p.v > 3.0 && p.x > 612.0, "v={} x={}", p.v, p.x);
        assert!(p.on_road);
        assert!(w.player_road().is_some());
        w.release_player();
        assert!(w.player.is_none());
    }

    #[test]
    fn bus_stops_at_its_stop_and_keeps_schedule() {
        let mut w = world_with_cross(0, [2, 2, 2, 2]);
        w.max_cars = 0;
        // pattern: south arm northbound through the junction to the north arm
        let xy = [512.0, 330.0, 512.0, 700.0];
        let len = 12.2;
        // stops (centre distances): 20 m (start), 120 m (a stop on the south arm), 360 m
        w.bus_pattern(7, &xy, &[20.0, 120.0, 360.0], &[0, 0, 0]);
        let t0 = 30000.0;
        w.tod = t0;
        let arr = [t0, t0 + 20.0, t0 + 90.0];
        let dep = [t0, t0 + 40.0, t0 + 90.0];
        assert_eq!(w.bus_spawn(5, 7, len, 45.0, 8.0, &arr, &dep), 0, "spawned");
        let mut dwell_seen = false;
        let mut left_at = None;
        for _ in 0..1200 {
            w.step(0.1);
            let Some(b) = w.buses.iter().flatten().next() else { eprintln!("bus gone at {}", w.tod - t0); break };
            if ((w.tod - t0) * 10.0).round() as i64 % 20 == 0 {
                let c = w.cars.iter().find(|c| c.id == b.car_id).unwrap();
                eprintln!("t {:.0} sd {:.1} stop {} state {:?} v {:.1} lane {} link {} s {:.1}", w.tod - t0, b.sd, b.stop, b.state, c.v, c.lane, c.link, c.s);
            }
            if b.state == BusState::Dwell && b.stop == 1 {
                dwell_seen = true;
                let c = w.cars.iter().find(|c| c.id == b.car_id).unwrap();
                assert_eq!(c.lane, 0, "curb lane at the stop");
                let sf = b.stop_front(&w.bus_pats[&7], 1);
                assert!((b.sd - sf).abs() < 3.0, "stopped at the pole: {} vs {}", b.sd, sf);
            }
            if dwell_seen && left_at.is_none() && b.stop >= 2 {
                left_at = Some(w.tod);
            }
        }
        assert!(dwell_seen, "the bus stopped at its stop");
        let t = left_at.expect("left the stop");
        assert!(t >= t0 + 40.0 - 0.2, "left before the timetable: {}", t - t0);
    }
}
