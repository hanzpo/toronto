//! The simulation world: road graph + car agents (IDM, lane changes, junction
//! control, routing) + pedestrians + the player car.

use std::f32::consts::PI;

use crate::demand::{self, FLAG_LINK};
use crate::graph::{classify_turn, wrap_pi, Control, Graph, Pose, Turn, MAXL, NONE};
use crate::idm::{self, IdmParams};
use crate::peds::Peds;
use crate::rng::Rng;
use crate::signal::Light;

pub const F_COMMIT: u8 = 1;
pub const F_PLAYER: u8 = 2;
pub const F_DEAD: u8 = 4;

/// floats per car record in the output buffer
pub const CAR_STRIDE: usize = 8;

#[derive(Clone)]
pub struct Car {
    pub id: u32,
    pub link: u32,
    pub lgen: u32,
    pub lane: u8,
    pub s: f32,
    pub v: f32,
    pub a: f32,
    pub next: u32,
    pub ngen: u32,
    pub turn: Turn,
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
    /// render-only lateral offset left over from a lane change (m)
    pub lat: f32,
    /// render-only positional offset left over from a link transition
    pub blend: [f32; 3],
    /// distance travelled since last output (for heading smoothing)
    pub odo: f32,
    pub lc_cool: f32,
    /// last rendered pose
    pub pose: Pose,
    pub posed: bool,
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
}

pub struct World {
    pub g: Graph,
    pub rng: Rng,
    pub cars: Vec<Car>,
    next_id: u32,
    keys: Vec<(u64, u32)>,
    order: Vec<u32>,
    lead: Vec<u32>,
    acc: Vec<f32>,
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
    tmp: Vec<u32>,
    /// true while sim time is being dropped (very high speed-ups)
    pub fast: bool,
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
            acc: Vec::new(),
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
            tmp: Vec::new(),
            fast: false,
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
        self.refresh_active(false);
        self.validate();
        // remove dead cars before sorting: `order` indices stay valid until the next step
        self.cull();
        self.sort();
        self.compute_accel(dt);
        self.lane_changes(dt);
        self.advance(dt);
        self.spawn();
        self.peds.step(&self.g, &mut self.rng, dt, self.tod, self.weekday, self.mono, self.focus);
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
            if c.next != NONE {
                let nl = &self.g.links[c.next as usize];
                if !nl.alive || nl.gen != c.ngen || nl.from != l.to {
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
            if vt < v0 {
                let d = (l.len - c.s).max(0.0);
                v0 = v0.min((vt * vt + 2.0 * 1.3 * d).sqrt());
            }
        }
        v0
    }

    fn compute_accel(&mut self, dt: f32) {
        let n = self.cars.len();
        self.acc.clear();
        self.acc.resize(n, 0.0);
        for i in 0..n {
            if self.cars[i].flags & (F_PLAYER | F_DEAD) != 0 {
                continue;
            }
            let v0 = self.desired_speed(i);
            let c = &self.cars[i];
            let (v, s, link, lane, next) = (c.v, c.s, c.link, c.lane, c.next);
            let p = c.idm;
            let l = &self.g.links[link as usize];
            let dist_end = l.len - s;
            let mut a;
            let li = self.lead[i];
            if li != NONE {
                let ld = &self.cars[li as usize];
                a = idm::accel(&p, v, v0, ld.s - ld.len - s, v - ld.v);
            } else {
                a = idm::accel(&p, v, v0, f32::INFINITY, 0.0);
                if next != NONE {
                    let nl = &self.g.links[next as usize];
                    let tl = target_lane(lane, nl.lanes, c.turn);
                    if let Some(t) = self.lane_tail(next, tl) {
                        let tc = &self.cars[t];
                        a = a.min(idm::accel(&p, v, v0, dist_end + tc.s - tc.len, v - tc.v));
                    }
                }
            }
            // dead end ahead (graph edge / unloaded tile): stop softly at the end
            if next == NONE && dist_end < 80.0 {
                a = a.min(idm::accel(&p, v, v0, dist_end + 4.0, v));
            }
            // merging streams at the node ahead
            if next != NONE && dist_end < 70.0 {
                let node = &self.g.nodes[l.to as usize];
                if node.ins.len() > 1 {
                    let nl = &self.g.links[next as usize];
                    let my_tl = target_lane(lane, nl.lanes, c.turn);
                    let controlled = node.control != Control::Free;
                    for &l2 in &node.ins {
                        if l2 == link {
                            continue;
                        }
                        let lk2 = &self.g.links[l2 as usize];
                        if lk2.stamp != self.step_no {
                            continue;
                        }
                        for ln in 0..(lk2.lanes as usize).min(MAXL) {
                            let hr = lk2.head[ln];
                            if hr == NONE {
                                continue;
                            }
                            let hc = &self.cars[self.order[hr as usize] as usize];
                            if hc.next != next || target_lane(hc.lane, nl.lanes, hc.turn) != my_tl {
                                continue;
                            }
                            if controlled && hc.flags & F_COMMIT == 0 {
                                continue;
                            }
                            let d2 = lk2.len - hc.s;
                            if d2 < dist_end || (d2 == dist_end && hc.id < c.id) {
                                a = a.min(idm::accel(&p, v, v0, dist_end - d2 - hc.len, v - hc.v));
                            }
                        }
                    }
                }
            }
            if let Some(gap) = self.control_gap(i, dt) {
                a = a.min(idm::accel(&p, v, v0, gap, v));
            }
            self.acc[i] = a;
        }
    }

    /// Junction control: gap to the stop line if the car must stop there.
    fn control_gap(&mut self, i: usize, dt: f32) -> Option<f32> {
        let (link, s, v, len, flags) = {
            let c = &self.cars[i];
            (c.link, c.s, c.v, c.len, c.flags)
        };
        if flags & F_COMMIT != 0 {
            return None;
        }
        let l = &self.g.links[link as usize];
        let (lclass, llen, bearing, lflags) = (l.class, l.len, l.bearing_end, l.flags);
        let ni = l.to as usize;
        let node = &self.g.nodes[ni];
        if node.control == Control::Free {
            return None;
        }
        let d = llen - node.setback - s;
        if d < -1.0 {
            self.cars[i].flags |= F_COMMIT;
            return None;
        }
        if d > 30.0 + v * v / 3.0 {
            return None;
        }
        match node.control {
            Control::Signal => match node.plan.light_for(self.tod, bearing) {
                Light::Green => {
                    if d < 0.5 {
                        self.cars[i].flags |= F_COMMIT;
                    }
                    None
                }
                Light::Amber => {
                    if d < 0.5 || d < v * v / 7.0 {
                        self.cars[i].flags |= F_COMMIT;
                        None
                    } else {
                        Some(d)
                    }
                }
                Light::Red => Some(d),
            },
            Control::Stop | Control::Priority => {
                let eff_class = if lflags & FLAG_LINK != 0 { lclass.max(3) } else { lclass };
                let major = eff_class <= node.best_class && !(node.control == Control::Stop && node.uniform);
                let clear = (2.0 * node.setback + len + 3.0) / v.max(4.0);
                let held_by_other = node.busy_until > self.mono && node.busy_link != link;
                let node = &mut self.g.nodes[ni];
                if major {
                    if held_by_other && node.busy_link != NONE && !self.g.links[node.busy_link as usize].alive {
                        node.busy_until = -1.0;
                    }
                    let tta = d.max(0.0) / v.max(0.5);
                    if tta < 5.0 {
                        // a committed minor-road car in the box: wait for it
                        if held_by_other && node.busy_minor() {
                            return Some(d);
                        }
                        let until = self.mono + (tta + clear) as f64;
                        if until > node.busy_until || node.busy_link == link {
                            node.busy_until = until.max(node.busy_until);
                            node.busy_link = link;
                            node.set_busy_minor(false);
                        }
                    }
                    if d < 0.5 {
                        self.cars[i].flags |= F_COMMIT;
                    }
                    None
                } else {
                    let free = !held_by_other;
                    let go = if node.control == Control::Stop {
                        if d < 3.0 && v < 0.5 {
                            self.cars[i].wait += dt;
                        }
                        self.cars[i].wait >= 1.0 && free
                    } else {
                        d < 14.0 && free
                    };
                    if go {
                        node.busy_until = self.mono + 2.5 + clear as f64;
                        node.busy_link = link;
                        node.set_busy_minor(true);
                        self.cars[i].flags |= F_COMMIT;
                        None
                    } else {
                        Some(d)
                    }
                }
            }
            Control::Free => None,
        }
    }

    fn lane_changes(&mut self, dt: f32) {
        let n = self.cars.len();
        for i in 0..n {
            let c = &mut self.cars[i];
            if c.flags & (F_PLAYER | F_DEAD) != 0 {
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
            let node_sb = self.g.nodes[l.to as usize].setback;
            if dist_end < node_sb + 6.0 || s < 5.0 {
                continue;
            }
            let v0 = self.desired_speed(i);
            let li = self.lead[i];
            let a_cur = if li != NONE {
                let ld = &self.cars[li as usize];
                idm::accel(&p, v, v0, ld.s - ld.len - s, v - ld.v)
            } else {
                idm::accel(&p, v, v0, f32::INFINITY, 0.0)
            };
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
            let mut best: Option<(u8, f32)> = None;
            for dl in [-1i32, 1] {
                let nl = lane as i32 + dl;
                if nl < 0 || nl >= lanes as i32 {
                    continue;
                }
                let nl = nl as u8;
                let (ld, fl) = self.neighbours(link, nl, s, i);
                // physical room
                if let Some(x) = ld {
                    let lc = &self.cars[x];
                    if lc.s - lc.len - s < 1.5 {
                        continue;
                    }
                }
                if let Some(x) = fl {
                    let fc = &self.cars[x];
                    if s - len - fc.s < 1.5 {
                        continue;
                    }
                    // safety for the new follower
                    let fv0 = fc.v.max(10.0);
                    let af = idm::accel(&fc.idm, fc.v, fv0, s - len - fc.s, fc.v - v);
                    let bsafe = if want == dl { -4.5 } else { -2.5 };
                    if af < bsafe {
                        continue;
                    }
                }
                let a_new = match ld {
                    Some(x) => {
                        let lc = &self.cars[x];
                        idm::accel(&p, v, v0, lc.s - lc.len - s, v - lc.v)
                    }
                    None => idm::accel(&p, v, v0, f32::INFINITY, 0.0),
                };
                let mut gain = a_new - a_cur + if dl < 0 { 0.12 } else { -0.12 };
                if want == dl {
                    gain += 3.0;
                } else if want != 0 {
                    gain -= 3.0;
                }
                if v < 2.0 && want != dl {
                    continue;
                }
                if gain > 0.35 && best.map_or(true, |b| gain > b.1) {
                    best = Some((nl, gain));
                }
            }
            if let Some((nl, _)) = best {
                let lk = &self.g.links[link as usize];
                let d_off = self.g.lane_offset(lk, lane) - self.g.lane_offset(lk, nl);
                let c = &mut self.cars[i];
                c.lat += d_off;
                c.lane = nl;
                c.lc_cool = 3.5;
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
            let li = self.lead[i];
            let lim = if li != NONE {
                let ld = &self.cars[li as usize];
                Some((ld.s - ld.len - 0.4, ld.v))
            } else {
                None
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
            if let Some((smax, lv)) = lim {
                if c.s + ds > smax {
                    ds = (smax - c.s).max(0.0);
                    nv = nv.min(lv);
                }
            }
            c.v = nv;
            c.a = a;
            c.s += ds;
            c.odo += ds;
            let k = (-ds / 7.0).exp();
            c.blend = [c.blend[0] * k, c.blend[1] * k, c.blend[2] * k];
            c.lat *= (-dt / 1.3).exp();
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
        let (link, next, lane, lat, turn, dest) = {
            let c = &self.cars[i];
            (c.link, c.next, c.lane, c.lat, c.turn, c.dest)
        };
        if next == NONE {
            return false;
        }
        let l = &self.g.links[link as usize];
        let node = &self.g.nodes[l.to as usize];
        if (node.x - dest[0]).hypot(node.y - dest[1]) < 180.0 {
            return false;
        }
        let nl = &self.g.links[next as usize];
        if !nl.alive {
            return false;
        }
        let tl = target_lane(lane, nl.lanes, turn);
        let old = self.g.link_pose(link, l.len, self.g.lane_offset(l, lane) + lat);
        let new = self.g.link_pose(next, 0.0, self.g.lane_offset(nl, tl));
        let (ngen, llen) = (nl.gen, l.len);
        let c = &mut self.cars[i];
        c.blend[0] += (old.x - new.x) as f32;
        c.blend[1] += (old.y - new.y) as f32;
        c.blend[2] += old.z - new.z;
        c.s -= llen;
        c.link = next;
        c.lgen = ngen;
        c.lane = tl;
        c.lat = 0.0;
        c.flags &= !F_COMMIT;
        c.wait = 0.0;
        c.next = NONE;
        self.choose_next(i);
        true
    }

    /// routing: weighted random choice at the node ahead with a soft pull
    /// towards the car's destination
    fn choose_next(&mut self, i: usize) {
        let (link, dest) = (self.cars[i].link, self.cars[i].dest);
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
        let (nx, t) = match pick {
            Some(j) => (cand[j], turns[j]),
            None => {
                let u = node.outs.iter().copied().find(|&o| self.g.links[o as usize].alive);
                match u {
                    Some(o) => (o, Turn::U),
                    None => (NONE, Turn::Straight),
                }
            }
        };
        let c = &mut self.cars[i];
        c.next = nx;
        c.turn = t;
        c.ngen = if nx != NONE { self.g.links[nx as usize].gen } else { 0 };
    }

    fn cull(&mut self) {
        let mut i = 0;
        while i < self.cars.len() {
            if self.cars[i].flags & F_DEAD != 0 && self.cars[i].flags & F_PLAYER == 0 {
                self.cars.swap_remove(i);
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
            // demand dropped (time jump / fast mode): thin out
            let excess = n_ai - target;
            if excess > target / 10 + 5 {
                let k = (excess / 20).max(1);
                for _ in 0..k {
                    let j = self.rng.below(self.cars.len() as u32) as usize;
                    if self.cars[j].flags & F_PLAYER == 0 {
                        self.cars[j].flags |= F_DEAD;
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
        while made < k && tries < k * 3 {
            tries += 1;
            let r = self.rng.f32() * total;
            let j = self.cum_w.partition_point(|&x| x < r).min(self.active.len() - 1);
            let link = self.active[j];
            let l = &self.g.links[link as usize];
            if !l.alive || l.len < 10.0 {
                continue;
            }
            let lane = self.rng.below(l.lanes as u32) as u8;
            let s = self.rng.range(3.0, l.len - 3.0);
            // avoid popping cars into view at steady state
            if !filling {
                let p = self.g.link_pose(link, s, 0.0);
                let d = (p.x - self.focus.0).hypot(p.y - self.focus.1);
                if d < self.radius * 0.45 && self.rng.f32() < 0.9 {
                    continue;
                }
            }
            let (ld, fl) = self.neighbours(link, lane, s, usize::MAX);
            let kind = pick_kind(&mut self.rng, l.class);
            let len = idm::LENGTH[kind as usize];
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
            if l.len - s < 8.0 && node.control != Control::Free {
                continue;
            }
            self.spawn_car(link, lane, s, v.max(0.0), kind);
            made += 1;
        }
    }

    fn spawn_car(&mut self, link: u32, lane: u8, s: f32, v: f32, kind: u8) -> usize {
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
            kind,
            color,
            len: idm::LENGTH[kind as usize],
            idm: idm::params(kind),
            vf,
            dest,
            flags: 0,
            wait: 0.0,
            lat: 0.0,
            blend: [0.0; 3],
            odo: 0.0,
            lc_cool: self.rng.range(0.0, 2.0),
            pose: Pose::default(),
            posed: false,
        });
        let i = self.cars.len() - 1;
        self.choose_next(i);
        i
    }

    // ------------------------------------------------------------------ output

    /// Fill `out_cars` with render records relative to (oe, on).
    /// Record: [dE, dN, elev, heading, pitch, speed, meta(u32 bits), id(u32 bits)]
    /// meta: kind | color << 8 | flags << 16 (1 brake, 2 player, 4 turn-left, 8 turn-right)
    pub fn write_cars(&mut self, oe: f64, on: f64) {
        self.out_cars.clear();
        let n = self.cars.len();
        for i in 0..n {
            let c = &self.cars[i];
            if c.flags & F_DEAD != 0 {
                continue;
            }
            let (pose, speed, flags) = if c.flags & F_PLAYER != 0 {
                let Some(p) = &self.player else { continue };
                (Pose { x: p.x, y: p.y, z: p.z, h: p.h, p: p.p }, p.v, 2u32 | if p.v > 0.5 && self.cars[i].a < -1.0 { 1 } else { 0 })
            } else {
                let l = &self.g.links[c.link as usize];
                let off = self.g.lane_offset(l, c.lane) + c.lat;
                let mut p = self.g.link_pose(c.link, c.s, off);
                p.x += c.blend[0] as f64;
                p.y += c.blend[1] as f64;
                p.z += c.blend[2];
                // smooth heading by distance travelled (no spinning in place)
                if c.posed {
                    let k = (c.odo / 3.0).min(1.0);
                    p.h = wrap_pi(c.pose.h + wrap_pi(p.h - c.pose.h) * k);
                    p.p = c.pose.p + (p.p - c.pose.p) * (c.odo / 2.0).min(1.0);
                }
                let dist_end = l.len - c.s;
                let mut f = if c.a < -0.8 || (c.v < 0.3) { 1u32 } else { 0 };
                if dist_end < 45.0 {
                    f |= match c.turn {
                        Turn::Left | Turn::U => 4,
                        Turn::Right => 8,
                        _ => 0,
                    };
                }
                (p, c.v, f)
            };
            let c = &mut self.cars[i];
            c.pose = pose;
            c.posed = true;
            c.odo = 0.0;
            let meta = c.kind as u32 | (c.color as u32) << 8 | flags << 16;
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
        let l = &self.g.links[link as usize];
        let ls = if use_fwd { s } else { l.len - s };
        let pose = self.g.link_pose(link, ls, self.g.lane_offset(l, 0));
        let lgen = l.gen;
        let id = self.next_id;
        self.next_id += 1;
        self.cars.push(Car {
            id,
            link,
            lgen,
            lane: 0,
            s: ls,
            v: 0.0,
            a: 0.0,
            next: NONE,
            ngen: 0,
            turn: Turn::Straight,
            kind: idm::SEDAN,
            color: 5,
            len: idm::LENGTH[0],
            idm: idm::params(0),
            vf: 1.0,
            dest: [0.0, 0.0],
            flags: F_PLAYER,
            wait: 0.0,
            lat: 0.0,
            blend: [0.0; 3],
            odo: 0.0,
            lc_cool: 0.0,
            pose,
            posed: true,
        });
        self.player = Some(Player { x: pose.x, y: pose.y, z: pose.z, h: pose.h, p: pose.p, v: 0.0, steer: 0.0, on_road: true, edge: eid, id, placed: true });
        true
    }

    /// Turn an AI car into the player car.
    pub fn take_over(&mut self, id: u32) -> bool {
        let Some(i) = self.cars.iter().position(|c| c.id == id && c.flags & F_DEAD == 0) else { return false };
        self.release_player();
        let Some(i) = self.cars.iter().position(|c| c.id == id).or(Some(i)) else { return false };
        let c = &mut self.cars[i];
        c.flags |= F_PLAYER;
        let pose = if c.posed { c.pose } else { self.g.link_pose(c.link, c.s, 0.0) };
        let edge = self.g.links[c.link as usize].edge;
        let v = c.v;
        self.player = Some(Player { x: pose.x, y: pose.y, z: pose.z, h: pose.h, p: pose.p, v, steer: 0.0, on_road: true, edge, id, placed: true });
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
            let c = &mut self.cars[i];
            c.flags &= !F_PLAYER;
            c.v = p.v.max(0.0);
            // render continuity: offset from the lane pose to where the player was
            let l = &self.g.links[c.link as usize];
            let lp = self.g.link_pose(c.link, c.s, self.g.lane_offset(l, c.lane));
            c.blend = [(p.x - lp.x) as f32, (p.y - lp.y) as f32, p.z - lp.z];
            c.pose = Pose { x: p.x, y: p.y, z: p.z, h: p.h, p: p.p };
            let ang = self.rng.f32() * 2.0 * PI;
            c.dest = [p.x + 3000.0 * ang.cos() as f64, p.y + 3000.0 * ang.sin() as f64];
            self.choose_next(i);
        } else {
            self.cars.swap_remove(i);
        }
    }

    /// Kinematic bicycle model + road snapping. `dt` is real time.
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
        // road snapping (elevation, lane for the AI)
        let (px, py, pz, ph, pv) = (p.x, p.y, p.z, p.h, p.v);
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
        let p = self.player.as_mut().unwrap();
        let (tz, tp) = if let Some((eid, s, lat, z, hdg, _)) = best {
            p.on_road = true;
            p.edge = eid;
            let ed = &self.g.edges[eid as usize];
            let fwd = (ph - hdg).cos() >= 0.0;
            let link = if fwd { ed.links[0] } else { ed.links[1] };
            let pose = self.g.edge_pose(ed, s, 0.0, !fwd);
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
                c.s = ls.clamp(0.0, l.len - 0.01);
            } else {
                c.link = NONE;
            }
            (z, if pv >= 0.0 { pose.p } else { pose.p })
        } else {
            p.on_road = false;
            self.cars[pi].link = NONE;
            (ground_z, 0.0)
        };
        let p = self.player.as_mut().unwrap();
        if !p.placed {
            p.z = tz;
        }
        p.placed = true;
        p.z += (tz - p.z) * (dt * 10.0).min(1.0);
        p.p += (tp - p.p) * (dt * 6.0).min(1.0);
        let c = &mut self.cars[pi];
        c.a = a;
        c.v = p.v.max(0.0);
        c.pose = Pose { x: p.x, y: p.y, z: p.z, h: p.h, p: p.p };
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

// small helpers on Node for the minor-road reservation bit (kept out of graph.rs's
// public field list to keep that module focused on topology)
trait BusyMinor {
    fn busy_minor(&self) -> bool;
    fn set_busy_minor(&mut self, v: bool);
}
impl BusyMinor for crate::graph::Node {
    #[inline]
    fn busy_minor(&self) -> bool {
        self.flags & 0x80 != 0
    }
    #[inline]
    fn set_busy_minor(&mut self, v: bool) {
        if v {
            self.flags |= 0x80
        } else {
            self.flags &= !0x80
        }
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
}
