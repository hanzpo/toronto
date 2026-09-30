//! Pedestrians: walk along sidewalks (offset lines on both sides of class 2–6
//! roads), turn corners, cross at junctions (waiting for the walk phase at
//! signals) and wait in small crowds at transit stops.

use std::collections::HashMap;
use std::f32::consts::PI;

use crate::demand::{self, FLAG_BRIDGE, FLAG_TUNNEL};
use crate::graph::{wrap_pi, Control, Graph, NONE};
use crate::rng::{hash01, Rng};
use crate::signal::Light;

pub const WALK: u8 = 0;
pub const WAIT: u8 = 1;
pub const CROSS: u8 = 2;
pub const IDLE: u8 = 3;

/// floats per pedestrian record
pub const PED_STRIDE: usize = 6;

#[derive(Clone)]
pub struct Ped {
    pub edge: u32,
    pub egen: u32,
    pub side: f32,
    pub dir: f32,
    pub s: f32,
    pub speed: f32,
    pub phase: f32,
    pub color: u8,
    pub state: u8,
    pub jitter: f32,
    // crossing / waiting
    pub p0: [f64; 3],
    pub p1: [f64; 3],
    pub t: f32,
    pub clen: f32,
    pub node: u32,
    pub nx: (u32, u32, f32, f32, f32), // edge, gen, side, dir, s
    // idle at a stop
    pub stop: u32,
    pub life: f32,
    pub pos: [f64; 3],
    pub h: f32,
    pub dead: bool,
}

pub struct Peds {
    pub list: Vec<Ped>,
    pub max: usize,
    pub radius: f64,
    active: Vec<u32>,
    cum: Vec<f32>,
    pub target: f32,
    /// camera (peds never vanish / appear in plain view at steady state)
    pub camera: crate::view::Camera,
    active_version: u32,
    active_at: f64,
    active_focus: (f64, f64),
    pub stops: Vec<[f64; 3]>,
    stop_grid: HashMap<(i32, i32), Vec<u32>>,
    /// stop position snapped to the sidewalk: (x, y, z, along-heading, facing), graph version
    stop_snap: Vec<Option<([f64; 3], f32, f32)>>,
    stop_snap_ver: Vec<u32>,
    /// pedestrians on a crossing: (node, [x0, y0, x1, y1] relative to the node), sorted by node
    pub cross: Vec<(u32, [f32; 4])>,
    stop_want: Vec<u8>,
    stop_have: Vec<u8>,
    stop_trips: Vec<f32>,
    stops_at: f64,
    pub out: Vec<f32>,
}

/// busier near downtown Toronto (City Hall = origin)
#[inline]
fn downtown(x: f64, y: f64) -> f32 {
    let d = (x.hypot(y)) as f32;
    1.0 + 7.0 * (-d / 2200.0).exp() + 1.2 * (-d / 9000.0).exp()
}

impl Peds {
    pub fn new(max: usize) -> Self {
        Peds {
            list: Vec::new(),
            max,
            radius: 900.0,
            active: Vec::new(),
            cum: Vec::new(),
            target: 0.0,
            camera: None,
            active_version: u32::MAX,
            active_at: -1e9,
            active_focus: (1e12, 1e12),
            stops: Vec::new(),
            stop_grid: HashMap::new(),
            stop_snap: Vec::new(),
            stop_snap_ver: Vec::new(),
            cross: Vec::new(),
            stop_want: Vec::new(),
            stop_have: Vec::new(),
            stop_trips: Vec::new(),
            stops_at: -1e9,
            out: Vec::new(),
        }
    }

    pub fn set_stops(&mut self, xyz: &[f64]) {
        self.stops = xyz.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();
        self.stop_grid.clear();
        for (i, s) in self.stops.iter().enumerate() {
            self.stop_grid.entry(((s[0] / 64.0).floor() as i32, (s[1] / 64.0).floor() as i32)).or_default().push(i as u32);
        }
        self.stop_snap = vec![None; self.stops.len()];
        self.stop_snap_ver = vec![u32::MAX; self.stops.len()];
        self.stop_want = vec![0; self.stops.len()];
        self.stop_have = vec![0; self.stops.len()];
        self.stops_at = -1e9;
        for p in self.list.iter_mut() {
            if p.state == IDLE {
                p.dead = true;
            }
        }
    }

    /// trips per day calling at each stop (same order as set_stops; empty = unknown)
    pub fn set_stop_trips(&mut self, trips: &[f32]) {
        self.stop_trips = if trips.len() == self.stops.len() { trips.to_vec() } else { Vec::new() };
    }

    /// any transit stop within `r` of (x, y)
    pub fn stop_near(&self, x: f64, y: f64, r: f32) -> bool {
        let r = r as f64;
        let (c0x, c0y) = (((x - r) / 64.0).floor() as i32, ((y - r) / 64.0).floor() as i32);
        let (c1x, c1y) = (((x + r) / 64.0).floor() as i32, ((y + r) / 64.0).floor() as i32);
        for cx in c0x..=c1x {
            for cy in c0y..=c1y {
                if let Some(v) = self.stop_grid.get(&(cx, cy)) {
                    for &i in v {
                        let s = self.stops[i as usize];
                        if (s[0] - x).powi(2) + (s[1] - y).powi(2) <= r * r {
                            return true;
                        }
                    }
                }
            }
        }
        false
    }

    /// Where a stop's crowd waits: on the sidewalk next to the nearest road
    /// (streetcar stops are often mapped in the middle of the road).
    fn snap_stop(g: &Graph, s: [f64; 3], near: &mut Vec<u32>) -> ([f64; 3], f32, f32) {
        g.edges_near(s[0], s[1], 30.0, near);
        let mut best: Option<(u32, f32, f32, f32)> = None;
        for &eid in near.iter() {
            let e = &g.edges[eid as usize];
            if !e.alive || !e.ped_ok || e.ped_sides == 0 {
                continue;
            }
            let (se, lat, _, _) = g.project_on_edge(eid, s[0], s[1]);
            if se <= 0.0 || se >= e.len {
                continue;
            }
            // distance to the nearest walkable sidewalk line
            let mut d = f32::INFINITY;
            for (bit, side) in [(1u8, 1.0f32), (2u8, -1.0f32)] {
                if e.ped_sides & bit != 0 {
                    d = d.min((lat - side * e.ped_off).abs());
                }
            }
            if lat.abs() < e.half_w + 0.5 {
                d *= 0.5; // stop mapped on this carriageway: prefer its own sidewalk
            }
            if best.map_or(true, |b| d < b.3) {
                best = Some((eid, se, lat, d));
            }
        }
        let Some((eid, se, lat, _)) = best else { return (s, 0.0, 0.0) };
        let e = &g.edges[eid as usize];
        if lat.abs() > e.ped_off + 4.0 {
            return (s, 0.0, 0.0); // already off the road (terminal, plaza)
        }
        let want = if lat >= 0.0 { 1.0f32 } else { -1.0 };
        let side = if e.ped_sides & if want > 0.0 { 1 } else { 2 } != 0 { want } else { -want };
        let q = g.edge_pose(e, se, side * e.ped_off, false);
        // face the carriageway
        let face = wrap_pi(q.h + if side > 0.0 { PI * 0.5 } else { -PI * 0.5 });
        ([q.x, q.y, q.z as f64], q.h, face)
    }

    fn refresh(&mut self, g: &Graph, tod: f64, wd: u32, mono: f64, focus: (f64, f64)) {
        let moved = (focus.0 - self.active_focus.0).hypot(focus.1 - self.active_focus.1);
        if self.active_version == g.version && moved < 60.0 && mono - self.active_at < 4.0 {
            return;
        }
        self.active_version = g.version;
        self.active_at = mono;
        self.active_focus = focus;
        self.active.clear();
        self.cum.clear();
        let prof = demand::ped_profile(tod, wd);
        let r2 = self.radius * self.radius;
        let mut acc = 0.0f32;
        for (i, e) in g.edges.iter().enumerate() {
            if !e.alive || !e.ped_ok || e.ped_sides == 0 || e.len < 6.0 {
                continue;
            }
            let a = &g.nodes[e.from as usize];
            let b = &g.nodes[e.to as usize];
            let (mx, my) = ((a.x + b.x) * 0.5, (a.y + b.y) * 0.5);
            if (mx - focus.0).powi(2) + (my - focus.1).powi(2) > r2 {
                continue;
            }
            let deg = (a.edges.len() + b.edges.len()) as f32 * 0.5;
            let w = demand::PED_DENSITY[e.class as usize] * prof * downtown(mx, my) * (0.7 + 0.12 * deg.min(5.0)) * e.len * 0.001 * 2.0;
            if w <= 0.0 {
                continue;
            }
            acc += w;
            self.active.push(i as u32);
            self.cum.push(acc);
        }
        self.target = acc.min(self.max as f32 * 0.85);
    }

    /// `boxes`: junction paths of vehicles (node, samples relative to the node, first live sample), sorted by node
    pub fn step(&mut self, g: &Graph, rng: &mut Rng, dt: f32, tod: f64, wd: u32, mono: f64, focus: (f64, f64), boxes: &[(u32, [[f32; 2]; crate::world::NS], u8)]) {
        self.refresh(g, tod, wd, mono, focus);
        let r2 = (self.radius * 1.15 + 50.0).powi(2);
        for i in 0..self.list.len() {
            let p = &mut self.list[i];
            if p.dead {
                continue;
            }
            if p.state == IDLE {
                p.life -= dt;
                p.phase += dt * 0.7;
                if p.life <= 0.0 || (p.pos[0] - focus.0).powi(2) + (p.pos[1] - focus.1).powi(2) > r2 {
                    p.dead = true;
                }
                continue;
            }
            let e = &g.edges[p.edge as usize];
            if !e.alive || e.gen != p.egen || (p.state == WALK && e.ped_sides & side_bit(p.side) == 0) {
                p.dead = true;
                continue;
            }
            match p.state {
                WALK => {
                    p.s += p.dir * p.speed * dt;
                    p.phase += p.speed * dt * 4.4;
                    let trim_a = g.nodes[e.from as usize].ped_trim.min(e.len * 0.45);
                    let trim_b = g.nodes[e.to as usize].ped_trim.min(e.len * 0.45);
                    if p.dir > 0.0 && p.s >= e.len - trim_b {
                        p.s = e.len - trim_b;
                        Self::arrive(g, rng, p, e.to, tod);
                    } else if p.dir < 0.0 && p.s <= trim_a {
                        p.s = trim_a;
                        Self::arrive(g, rng, p, e.from, tod);
                    }
                }
                WAIT => {
                    let n = &g.nodes[p.node as usize];
                    p.phase += dt * 0.5;
                    let walk = if n.control == Control::Signal {
                        let bearing = ((p.p1[1] - p.p0[1]) as f32).atan2((p.p1[0] - p.p0[0]) as f32);
                        let phase = n.plan.phase_of(bearing);
                        n.plan.light(tod, phase) == Light::Green && n.plan.green_left(tod, phase) > p.clen / p.speed + 2.0
                    } else {
                        true
                    };
                    if walk && !Self::cars_in_way(g, p, boxes) {
                        p.state = CROSS;
                        p.t = 0.0;
                    }
                }
                CROSS => {
                    p.t += p.speed * dt / p.clen.max(0.1);
                    p.phase += p.speed * dt * 4.4;
                    if p.t >= 1.0 {
                        let (ne, ng, side, dir, s) = p.nx;
                        let ok = g.edges.get(ne as usize).map_or(false, |x| x.alive && x.gen == ng);
                        if !ok {
                            p.dead = true;
                            continue;
                        }
                        p.edge = ne;
                        p.egen = ng;
                        p.side = side;
                        p.dir = dir;
                        p.s = s;
                        p.state = WALK;
                        let ex = &g.edges[ne as usize];
                        let m = &g.nodes[if dir > 0.0 { ex.to } else { ex.from } as usize];
                        if (m.x - focus.0).powi(2) + (m.y - focus.1).powi(2) > r2 {
                            p.dead = true;
                        }
                    }
                }
                _ => {}
            }
        }
        self.list.retain(|p| !p.dead);
        self.spawn(g, rng, tod, wd, mono, focus);
        // crossings in use (cars yield to them)
        self.cross.clear();
        for p in &self.list {
            if p.state == CROSS && p.node != NONE {
                let z = zone(g, p.node);
                let n = &g.nodes[z as usize];
                let t = p.t.clamp(0.0, 1.0) as f64;
                let (x, y) = (p.p0[0] + (p.p1[0] - p.p0[0]) * t, p.p0[1] + (p.p1[1] - p.p0[1]) * t);
                self.cross.push((z, [(x - n.x) as f32, (y - n.y) as f32, (p.p1[0] - n.x) as f32, (p.p1[1] - n.y) as f32]));
            }
        }
        self.cross.sort_unstable_by_key(|c| c.0);
    }

    /// a vehicle's junction path crosses this pedestrian's crossing
    fn cars_in_way(g: &Graph, p: &Ped, boxes: &[(u32, [[f32; 2]; crate::world::NS], u8)]) -> bool {
        let z = zone(g, p.node);
        let a = boxes.partition_point(|b| b.0 < z);
        let n = &g.nodes[z as usize];
        let seg = [(p.p0[0] - n.x) as f32, (p.p0[1] - n.y) as f32, (p.p1[0] - n.x) as f32, (p.p1[1] - n.y) as f32];
        for b in &boxes[a..] {
            if b.0 != z {
                break;
            }
            for q in &b.1[b.2 as usize..] {
                if seg_dist(seg, q[0], q[1]) < 2.4 {
                    return true;
                }
            }
        }
        false
    }

    fn walk_point(g: &Graph, edge: u32, s: f32, side: f32, jitter: f32) -> [f64; 3] {
        let e = &g.edges[edge as usize];
        let p = g.edge_pose(e, s, side * (e.ped_off + jitter), false);
        [p.x, p.y, p.z as f64]
    }

    /// Reached the corner at node `ni`: pick where to go next.
    fn arrive(g: &Graph, rng: &mut Rng, p: &mut Ped, ni: u32, tod: f64) {
        let here = Self::walk_point(g, p.edge, p.s, p.side, p.jitter);
        let node = &g.nodes[ni as usize];
        let e0 = &g.edges[p.edge as usize];
        let o = e0.ped_off.max(4.0);
        let mut cand: [(u32, f32, f32, f32, [f64; 3], f32); 16] = [(NONE, 0.0, 0.0, 0.0, [0.0; 3], 0.0); 16];
        let mut w = [0.0f32; 16];
        let mut k = 0;
        for &eid in &node.edges {
            let e = &g.edges[eid as usize];
            if !e.alive || !e.ped_ok || e.len < 4.0 {
                continue;
            }
            let at_from = e.from == ni;
            let other = if at_from { e.to } else { e.from };
            let trim = node.ped_trim.min(e.len * 0.45);
            let s = if at_from { trim } else { e.len - trim };
            let dir = if at_from { 1.0 } else { -1.0 };
            let _ = other;
            for side in [-1.0f32, 1.0] {
                if k >= 16 {
                    break;
                }
                if eid == p.edge && side == p.side {
                    continue; // straight back the way we came
                }
                if e.ped_sides & side_bit(side) == 0 {
                    continue; // no sidewalk there (median, other carriageway)
                }
                let q = Self::walk_point(g, eid, s, side, p.jitter);
                let d = ((q[0] - here[0]).hypot(q[1] - here[1])) as f32;
                let crossing = d > 0.6 * o;
                if d > 2.9 * o.max(e.ped_off) {
                    continue; // diagonal: two crossings
                }
                let mut ww = if eid == p.edge { 0.25 } else if crossing { 1.2 } else { 1.0 };
                if crossing && node.control != Control::Signal && e0.class.min(e.class) <= 3 {
                    ww *= 0.15; // rarely cross a big road without a light
                }
                cand[k] = (eid, side, dir, s, q, d);
                w[k] = ww;
                k += 1;
            }
        }
        let Some(j) = rng.pick(&w[..k]) else {
            p.dir = -p.dir; // dead end: turn around
            return;
        };
        let (eid, side, dir, s, q, d) = cand[j];
        p.p0 = here;
        p.p1 = q;
        p.t = 0.0;
        p.clen = d.max(0.3);
        p.node = ni;
        p.nx = (eid, g.edges[eid as usize].gen, side, dir, s);
        let _ = tod;
        let crossing = d > 0.6 * o;
        // crossings wait for the walk signal / a gap in turning traffic (see step)
        p.state = if crossing { WAIT } else { CROSS };
    }

    fn spawn(&mut self, g: &Graph, rng: &mut Rng, tod: f64, wd: u32, mono: f64, focus: (f64, f64)) {
        // stops
        if mono - self.stops_at > 5.0 && !self.stops.is_empty() {
            self.stops_at = mono;
            let prof = demand::ped_profile(tod, wd);
            let r2 = (self.radius * 0.9).powi(2);
            for h in self.stop_have.iter_mut() {
                *h = 0;
            }
            for p in &self.list {
                if p.state == IDLE && (p.stop as usize) < self.stop_have.len() {
                    self.stop_have[p.stop as usize] += 1;
                }
            }
            for (i, s) in self.stops.iter().enumerate() {
                let inside = (s[0] - focus.0).powi(2) + (s[1] - focus.1).powi(2) <= r2;
                self.stop_want[i] = if inside {
                    // busier stops (more service ~ more boardings) have bigger crowds: a stop
                    // with 100 trips a day is the reference; King / Spadina streetcar stops
                    // (~600) about 2.5x, a quiet suburban stop (~30) about half
                    let service = self.stop_trips.get(i).map_or(1.0, |&t| (t / 100.0).sqrt().clamp(0.35, 3.0));
                    let base = prof * downtown(s[0], s[1]).min(4.0) * 1.6 * service * (0.4 + 1.2 * hash01(i as u64 * 7919));
                    (base.round() as u8).min(30)
                } else {
                    0
                };
            }
            let mut near = Vec::new();
            for i in 0..self.stops.len() {
                let (want, have) = (self.stop_want[i], self.stop_have[i]);
                if have >= want || self.list.len() >= self.max {
                    continue;
                }
                if self.stop_snap_ver[i] != g.version {
                    self.stop_snap_ver[i] = g.version;
                    self.stop_snap[i] = Some(Self::snap_stop(g, self.stops[i], &mut near));
                }
                let (s, along, face) = self.stop_snap[i].unwrap_or((self.stops[i], 0.0, 0.0));
                let (ah, ac) = along.sin_cos();
                // waiting people take places along the curb ~1 m apart facing the road, a second
                // row further back, a few standing back near the buildings; places already
                // taken (also by the crowd of another stop at the same pole) are skipped
                let taken: Vec<[f64; 3]> = self.list.iter().filter(|p| p.state == IDLE && (p.pos[0] - s[0]).abs() < 12.0 && (p.pos[1] - s[1]).abs() < 12.0).map(|p| p.pos).collect();
                let mut placed: Vec<[f64; 3]> = Vec::new();
                let mut slot = 0usize;
                for _ in have..want {
                    let mut pos = s;
                    let mut ok = false;
                    while slot < 48 {
                        let k = slot;
                        slot += 1;
                        let (col, row) = ((k % 12) as f64, (k / 12) as f64);
                        // centre out: 0, +1, -1, +2, -2 ...
                        let u = if col as usize % 2 == 0 { col * 0.5 } else { -(col + 1.0) * 0.5 } * 1.05 + rng.range(-0.15, 0.15) as f64;
                        let back = rng.f32() < 0.15;
                        // + = towards the road (right of `along` is the carriageway side via `face`)
                        let w = if back { -1.6 } else { 0.45 - row * 1.05 } + rng.range(-0.12, 0.12) as f64;
                        let (fs, fc) = face.sin_cos();
                        let cand = [s[0] + u * ac as f64 + w * fc as f64, s[1] + u * ah as f64 + w * fs as f64, s[2]];
                        if taken.iter().chain(placed.iter()).all(|q| (q[0] - cand[0]).hypot(q[1] - cand[1]) > 0.8) {
                            pos = cand;
                            ok = true;
                            break;
                        }
                    }
                    if !ok {
                        break;
                    }
                    placed.push(pos);
                    self.list.push(Ped {
                        edge: NONE,
                        egen: 0,
                        side: 1.0,
                        dir: 1.0,
                        s: 0.0,
                        speed: 0.0,
                        phase: rng.f32() * 6.28,
                        color: rng.below(12) as u8,
                        state: IDLE,
                        jitter: 0.0,
                        p0: pos,
                        p1: pos,
                        t: 0.0,
                        clen: 0.0,
                        node: NONE,
                        nx: (NONE, 0, 0.0, 0.0, 0.0),
                        stop: i as u32,
                        life: rng.range(40.0, 420.0),
                        pos,
                        h: face + rng.range(-0.45, 0.45),
                        dead: false,
                    });
                }
            }
        }
        // sidewalks
        let walkers = self.list.iter().filter(|p| p.state != IDLE).count();
        let target = self.target as usize;
        if walkers >= target || self.active.is_empty() {
            if walkers > target + target / 8 + 10 {
                // thin out after demand drops
                let mut extra = (walkers - target) / 60 + 1;
                let cam = self.camera;
                for p in self.list.iter_mut() {
                    if extra == 0 {
                        break;
                    }
                    // (they "went inside": only where nobody sees it)
                    if p.state == WALK && rng.f32() < 0.1 && !crate::view::in_view(cam, p.pos[0], p.pos[1], 800.0) {
                        p.dead = true;
                        extra -= 1;
                    }
                }
                self.list.retain(|p| !p.dead);
            }
            return;
        }
        let deficit = target - walkers;
        let filling = walkers * 2 < target;
        let k = if filling { (deficit / 3).clamp(1, 1500) } else { (deficit / 30).clamp(1, 30) };
        let total = *self.cum.last().unwrap();
        for _ in 0..k {
            if self.list.len() >= self.max {
                break;
            }
            let r = rng.f32() * total;
            let j = self.cum.partition_point(|&x| x < r).min(self.active.len() - 1);
            let eid = self.active[j];
            let e = &g.edges[eid as usize];
            let trim_a = g.nodes[e.from as usize].ped_trim.min(e.len * 0.45);
            let trim_b = g.nodes[e.to as usize].ped_trim.min(e.len * 0.45);
            if e.len - trim_a - trim_b < 1.0 {
                continue;
            }
            let s = rng.range(trim_a, e.len - trim_b);
            if !filling {
                let q = g.edge_pose(e, s, 0.0, false);
                if (q.x - focus.0).hypot(q.y - focus.1) < self.radius * 0.35 && rng.f32() < 0.85 {
                    continue;
                }
            }
            let speed = (1.35 + 0.18 * rng.normal()).clamp(0.9, 1.9);
            let side = match e.ped_sides {
                1 => 1.0,
                2 => -1.0,
                _ => if rng.f32() < 0.5 { -1.0 } else { 1.0 },
            };
            self.list.push(Ped {
                edge: eid,
                egen: e.gen,
                side,
                dir: if rng.f32() < 0.5 { -1.0 } else { 1.0 },
                s,
                speed,
                phase: rng.f32() * 6.28,
                color: rng.below(12) as u8,
                state: WALK,
                jitter: rng.range(-0.7, 0.7),
                p0: [0.0; 3],
                p1: [0.0; 3],
                t: 0.0,
                clen: 0.0,
                node: NONE,
                nx: (NONE, 0, 0.0, 0.0, 0.0),
                stop: NONE,
                life: 0.0,
                pos: [0.0; 3],
                h: 0.0,
                dead: false,
            });
        }
    }

    /// Record: [dE, dN, elev, heading, phase, meta(u32 bits)]; meta = color | state << 8 | on-structure << 16
    pub fn write(&mut self, g: &Graph, oe: f64, on: f64) {
        self.out.clear();
        for p in self.list.iter_mut() {
            let (pos, h) = match p.state {
                WALK => {
                    let e = &g.edges[p.edge as usize];
                    let q = g.edge_pose(e, p.s, p.side * (e.ped_off + p.jitter), false);
                    ([q.x, q.y, q.z as f64], if p.dir > 0.0 { q.h } else { wrap_pi(q.h + PI) })
                }
                WAIT => {
                    let h = ((p.p1[1] - p.p0[1]) as f32).atan2((p.p1[0] - p.p0[0]) as f32);
                    (p.p0, h)
                }
                CROSS => {
                    let t = p.t.clamp(0.0, 1.0) as f64;
                    let pos = [p.p0[0] + (p.p1[0] - p.p0[0]) * t, p.p0[1] + (p.p1[1] - p.p0[1]) * t, p.p0[2] + (p.p1[2] - p.p0[2]) * t];
                    (pos, ((p.p1[1] - p.p0[1]) as f32).atan2((p.p1[0] - p.p0[0]) as f32))
                }
                _ => (p.pos, p.h),
            };
            p.pos = pos;
            p.h = h;
            let structure = p.state != IDLE && p.edge != NONE && g.edges[p.edge as usize].flags & (FLAG_BRIDGE | FLAG_TUNNEL) != 0;
            let meta = p.color as u32 | (p.state as u32) << 8 | (structure as u32) << 16;
            self.out.extend_from_slice(&[(pos[0] - oe) as f32, (pos[1] - on) as f32, pos[2] as f32, h, p.phase, f32::from_bits(meta)]);
        }
    }
}

/// conflict zone of a node (see `Node::zone`)
#[inline]
fn zone(g: &Graph, node: u32) -> u32 {
    let z = g.nodes[node as usize].zone;
    if z == NONE || !g.nodes[z as usize].alive {
        node
    } else {
        z
    }
}

#[inline]
fn side_bit(side: f32) -> u8 {
    if side > 0.0 {
        1
    } else {
        2
    }
}

/// distance from (x, y) to segment [x0, y0, x1, y1]
fn seg_dist(s: [f32; 4], x: f32, y: f32) -> f32 {
    let (dx, dy) = (s[2] - s[0], s[3] - s[1]);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 1e-6 { (((x - s[0]) * dx + (y - s[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    (x - s[0] - dx * t).hypot(y - s[1] - dy * t)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::tests::load_cross;

    #[test]
    fn pedestrians_walk_and_wait_for_walk_signal() {
        let mut g = Graph::default();
        load_cross(&mut g, 1, [2, 5, 2, 5]);
        let mut rng = Rng::new(3);
        let mut peds = Peds::new(500);
        peds.radius = 1000.0;
        let mut tod = 12.5 * 3600.0;
        let mut crossed = 0;
        let mut waited = 0;
        for k in 0..3000 {
            peds.step(&g, &mut rng, 0.1, tod, 3, k as f64 * 0.1, (512.0, 512.0), &[]);
            tod += 0.1;
            for p in &peds.list {
                if p.state == WAIT {
                    waited += 1;
                    // a waiting pedestrian's phase is not green-with-time-left
                }
                if p.state == CROSS {
                    crossed += 1;
                }
            }
        }
        assert!(!peds.list.is_empty());
        assert!(waited > 0 && crossed > 0, "waited {waited} crossed {crossed}");
        peds.write(&g, 0.0, 0.0);
        assert_eq!(peds.out.len(), peds.list.len() * PED_STRIDE);
        // sidewalk offset: nobody walks on the carriageway centre line
        for p in &peds.list {
            if p.state == WALK {
                let e = &g.edges[p.edge as usize];
                assert!(e.ped_off > e.half_w);
            }
        }
    }

    #[test]
    fn stop_crowds() {
        let mut g = Graph::default();
        load_cross(&mut g, 1, [2, 5, 2, 5]);
        let mut rng = Rng::new(3);
        let mut peds = Peds::new(500);
        peds.set_stops(&[520.0, 520.0, 0.0, 530.0, 480.0, 0.0]);
        peds.step(&g, &mut rng, 0.1, 17.5 * 3600.0, 3, 10.0, (512.0, 512.0), &[]);
        assert!(peds.list.iter().any(|p| p.state == IDLE));
    }
}
