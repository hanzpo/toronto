mod idm;
mod net;
mod rng;

use net::{Kind, Net, C_BUS, C_CAR, C_PED, C_RAIL, C_SUBWAY, C_TRAM};
use rng::Rng;
use std::collections::VecDeque;
use wasm_bindgen::prelude::*;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AKind {
    Car = 0,
    Bus = 1,
    Tram = 2,
    Train = 3,
    Ped = 4,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Step {
    lane: u32,
    dir: i8,
}

pub struct Agent {
    pub kind: AKind,
    lane: u32,
    dir: i8,
    d: f32,
    v: f32,
    len: f32,
    v0: f32,
    route: VecDeque<Step>,
    hist: VecDeque<(Step, f32)>,
    stopped: f32,
    arrived: f64,
    variant: u8,
    lat: f32,
    dwell: f32,
    reserved: Vec<u32>,
    alive: bool,
    trip: i32,
    stops: VecDeque<(u32, f32, f64)>,
    stop_wait: f32,
    free: Option<Free>,
    id: u32,
    acc: f32,
}

#[derive(Clone, Copy, Default)]
pub struct Free {
    x: f32,
    y: f32,
    z: f32,
    h: f32,
    steer: f32,
    throttle: f32,
    brake: f32,
    handbrake: bool,
    ground: f32,
    on_road: bool,
}

const OFF_NET: u32 = u32::MAX;

#[wasm_bindgen]
pub struct World {
    net: Net,
    agents: Vec<Agent>,
    rng: Rng,
    t: f64,
    occ: Vec<Vec<(f32, u32)>>,
    owner: Vec<i32>,
    gate: Vec<f32>,
    out: Vec<f32>,
    target: [u32; 5],
    done: Vec<u32>,
    clock0: f64,
    next_id: u32,
}

const LOOK: f32 = 90.0;

impl World {
    fn lane_ok(&self, a: &Agent, l: u32) -> bool {
        let ln = &self.net.lanes[l as usize];
        match a.kind {
            AKind::Car => ln.kind == Kind::Drive && ln.cls & C_CAR != 0,
            AKind::Bus => ln.kind == Kind::Drive && ln.cls & C_BUS != 0,
            AKind::Tram => ln.cls & C_TRAM != 0,
            AKind::Train => ln.kind == Kind::Rail && ln.cls & (C_RAIL | C_SUBWAY) != 0,
            AKind::Ped => ln.kind == Kind::Walk && ln.cls & C_PED != 0,
        }
    }

    fn exits(&self, s: Step) -> Vec<Step> {
        let l = &self.net.lanes[s.lane as usize];
        let e = if s.dir > 0 { &l.ends[1] } else { &l.ends[0] };
        e.iter().map(|&(lane, dir)| Step { lane, dir }).collect()
    }

    fn plan(&mut self, i: usize) {
        if self.agents[i].trip >= 0 {
            return;
        }
        loop {
            let a = &self.agents[i];
            if a.route.len() >= 4 {
                return;
            }
            let last = a.route.back().copied().unwrap_or(Step { lane: a.lane, dir: a.dir });
            let mut opts: Vec<Step> = self.exits(last).into_iter().filter(|s| self.lane_ok(a, s.lane)).collect();
            if a.kind == AKind::Train || a.kind == AKind::Tram {
                let back: Vec<Step> = opts.iter().copied().filter(|s| !a.route.iter().any(|r| r.lane == s.lane) && s.lane != a.lane).collect();
                if !back.is_empty() {
                    opts = back;
                }
            }
            if opts.is_empty() {
                return;
            }
            let k = self.rng.below(opts.len() as u32) as usize;
            let pick = opts[k];
            self.agents[i].route.push_back(pick);
        }
    }

    fn signal_state(&self, node: u16, group: i16) -> u8 {
        if let Some(sg) = self.net.signals.get(&node) {
            let per = sg.green + sg.amber + sg.all_red;
            let cyc = per * sg.groups as f32;
            let t = (self.t as f32) % cyc;
            let g = (t / per) as i16;
            let r = t - g as f32 * per;
            if group < 0 {
                return 2;
            }
            if g != group {
                return 0;
            }
            return if r < sg.green { 2 } else if r < sg.green + sg.amber { 1 } else { 0 };
        }
        if self.net.node_kind.get(node as usize).map(|k| k == "level_crossing" || k == "tram_crossing").unwrap_or(false) {
            return if self.gate.get(node as usize).copied().unwrap_or(0.0) > 0.0 { 0 } else { 2 };
        }
        2
    }

    fn ped_walk(&self, lane: u32) -> bool {
        let l = &self.net.lanes[lane as usize];
        let Some((node, _)) = l.signal else { return true };
        let Some(sg) = self.net.signals.get(&node) else { return true };
        let per = sg.green + sg.amber + sg.all_red;
        let t = (self.t as f32) % (per * sg.groups as f32);
        let g = (t / per) as u32;
        let r = t - g as f32 * per;
        l.ped_mask & (1 << g) != 0 && r < sg.green - 6.0
    }

    fn agent_d_to(&self, b: &Agent, lane: u32, os: f32) -> Option<f32> {
        if b.lane == lane {
            let p = if b.dir > 0 { b.d } else { self.net.lanes[lane as usize].len - b.d };
            return Some(os - p);
        }
        if b.route.front().map(|s| s.lane) == Some(lane) {
            let rem = self.net.lanes[b.lane as usize].len - b.d;
            return Some(rem + os);
        }
        None
    }

    fn can_enter(&self, i: usize, l: u32) -> bool {
        self.why(i, l).is_none()
    }

    fn why(&self, i: usize, l: u32) -> Option<&'static str> {
        let a = &self.agents[i];
        let ln = &self.net.lanes[l as usize];
        let cur = &self.net.lanes[a.lane as usize];
        if a.kind == AKind::Ped {
            if ln.crosswalk && !self.ped_walk(l) {
                return Some("r1");
            }
            return None;
        }
        if a.kind == AKind::Train {
            return None;
        }
        if let Some((node, group)) = ln.signal {
            let st = self.signal_state(node, group);
            let dist = cur.len - a.d;
            if st == 0 {
                return Some("r2");
            }
            if st == 1 && dist > a.v * a.v / 6.0 + 1.0 {
                return Some("r3");
            }
        }
        if cur.stop_sign && a.stopped < 1.0 {
            return Some("r4");
        }
        let my_t = (cur.len - a.d) / a.v.max(2.0);
        for c in &ln.conflicts {
            let bl = &self.net.lanes[c.lane as usize];
            if bl.kind == Kind::Walk {
                if self.occ[c.lane as usize].iter().any(|&(_, j)| self.agents[j as usize].kind == AKind::Ped) {
                    return Some("r5");
                }
                continue;
            }
            if let (Some((n1, g1)), Some((n2, g2))) = (ln.signal, bl.signal) {
                if n1 == n2 && g1 != g2 && g1 >= 0 && g2 >= 0 {
                    continue;
                }
            }
            let mine_rank = ln.turn + if cur.stop_sign { 4 } else { 0 };
            let bprev_stop = bl.prev.iter().any(|&p| self.net.lanes[p as usize].stop_sign);
            let their_rank = bl.turn + if bprev_stop { 4 } else { 0 };
            for &(_, j) in &self.occ[c.lane as usize] {
                if j as usize == i {
                    continue;
                }
                let b = &self.agents[j as usize];
                let Some(dd) = self.agent_d_to(b, c.lane, c.os) else {
                    if b.lane != c.lane {
                        let _ = b;
                    }
                    return Some("r6");
                };
                if dd < -b.len - 1.0 {
                    continue;
                }
                if dd < 1.5 || b.v > 0.5 {
                    return Some("r7");
                }
            }
            for &p in &bl.prev {
                for &(_, j) in &self.occ[p as usize] {
                    if j as usize == i {
                        continue;
                    }
                    let b = &self.agents[j as usize];
                    if b.lane != p || b.route.front().map(|s| s.lane) != Some(c.lane) {
                        continue;
                    }
                    let pl = &self.net.lanes[p as usize];
                    let rem = pl.len - b.d;
                    if pl.stop_sign && cur.stop_sign {
                        if b.stopped > 0.5 && rem < 3.0 && (b.arrived < a.arrived || (b.arrived == a.arrived && j < i as u32)) {
                            return Some("r8");
                        }
                        continue;
                    }
                    let tt = rem / b.v.max(2.0);
                    if tt > 4.5 || (b.v < 0.5 && b.stopped > 1.5) {
                        continue;
                    }
                    let theirs = their_rank < mine_rank || (their_rank == mine_rank && (tt < my_t - 0.3 || ((tt - my_t).abs() <= 0.3 && j < i as u32)));
                    if theirs && !(pl.stop_sign && b.stopped < 0.9) {
                        return Some("r9");
                    }
                }
            }
        }
        if let Some(next) = a.route.get(1) {
            let nl = &self.net.lanes[next.lane as usize];
            if nl.kind != Kind::Walk {
                if let Some(&(d, _)) = self.occ[next.lane as usize].first() {
                    let room = d - 2.0;
                    if room < a.len + ln.len * 0.0 {
                        return Some("r10");
                    }
                }
            }
        }
        None
    }

    fn reserve(&mut self, i: usize) -> f32 {
        let a = &self.agents[i];
        let need = a.v * a.v / (2.0 * 0.7) + 60.0;
        let mut dist = self.net.lanes[a.lane as usize].len - a.d;
        let mut ok = dist;
        let mut take: Vec<u32> = Vec::new();
        for s in a.route.iter() {
            if dist > need {
                break;
            }
            let o = self.owner[s.lane as usize];
            if o >= 0 && o as usize != i {
                break;
            }
            take.push(s.lane);
            dist += self.net.lanes[s.lane as usize].len;
            ok = dist;
        }
        for l in take {
            self.owner[l as usize] = i as i32;
            if !self.agents[i].reserved.contains(&l) {
                self.agents[i].reserved.push(l);
            }
        }
        ok
    }

    fn spawn(&mut self, kind: AKind) -> bool {
        let n = self.net.lanes.len() as u32;
        for _ in 0..200 {
            let l = self.rng.below(n);
            let ln = &self.net.lanes[l as usize];
            if ln.node.is_some() && kind != AKind::Ped {
                continue;
            }
            let probe = Agent {
                kind, lane: l, dir: 1, d: 0.0, v: 0.0, len: 0.0, v0: 0.0, route: VecDeque::new(), hist: VecDeque::new(),
                stopped: 0.0, arrived: 0.0, variant: 0, lat: 0.0, dwell: 0.0, reserved: Vec::new(), alive: true,
                trip: -1, stops: VecDeque::new(), stop_wait: 0.0, free: None, id: 0, acc: 0.0,
            };
            if !self.lane_ok(&probe, l) {
                continue;
            }
            let len = match kind {
                AKind::Car => [4.7, 4.1, 4.9, 5.6, 5.3, 8.6][self.rng.below(6) as usize],
                AKind::Bus => 12.0,
                AKind::Tram => 30.0,
                AKind::Train => 4.0 * 26.0,
                AKind::Ped => 0.5,
            };
            if ln.len < len + 4.0 && kind != AKind::Ped {
                continue;
            }
            let d = self.rng.range(len, ln.len - 1.0).max(0.0);
            if kind != AKind::Ped && self.occ[l as usize].iter().any(|&(od, _)| (od - d).abs() < len + 8.0) {
                continue;
            }
            if kind == AKind::Train && self.owner[l as usize] >= 0 {
                continue;
            }
            let dir = if ln.bidir && self.rng.f32() < 0.5 { -1 } else { 1 };
            let v0 = ln.speed * self.rng.range(0.85, 1.1);
            let lat = if kind == AKind::Ped { self.rng.range(-0.35, 0.35) * ln.width.min(2.5) } else { 0.0 };
            let agent = Agent {
                kind, lane: l, dir, d, v: 0.0, len, v0, route: VecDeque::new(), hist: VecDeque::new(), stopped: 0.0, arrived: 0.0,
                variant: self.rng.below(8) as u8, lat, dwell: 0.0, reserved: vec![l], alive: true,
                trip: -1, stops: VecDeque::new(), stop_wait: 0.0, free: None, id: 0, acc: 0.0,
            };
            let idx = self.agents.len();
            self.agents.push(agent);
            self.next_id += 1;
            self.agents.last_mut().unwrap().id = self.next_id;
            if kind == AKind::Train {
                self.owner[l as usize] = idx as i32;
            }
            self.occ[l as usize].push((d, idx as u32));
            self.plan(idx);
            return true;
        }
        false
    }

    fn rebuild_occ(&mut self) {
        for o in self.occ.iter_mut() {
            o.clear();
        }
        for (i, a) in self.agents.iter().enumerate() {
            if !a.alive || a.lane == OFF_NET {
                continue;
            }
            self.occ[a.lane as usize].push((a.d, i as u32));
            let mut back = a.len - a.d;
            for (s, l) in a.hist.iter().rev() {
                if back <= 0.0 {
                    break;
                }
                let _ = l;
                self.occ[s.lane as usize].push((self.net.lanes[s.lane as usize].len - back.min(self.net.lanes[s.lane as usize].len), i as u32));
                back -= self.net.lanes[s.lane as usize].len;
            }
        }
        for o in self.occ.iter_mut() {
            o.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        }
    }

    fn leader_gap(&self, i: usize) -> (f32, f32) {
        let a = &self.agents[i];
        let mut best = (f32::INFINITY, 0.0f32);
        for &(d, j) in &self.occ[a.lane as usize] {
            if j as usize == i {
                continue;
            }
            let b = &self.agents[j as usize];
            if b.dir != a.dir && b.lane == a.lane {
                continue;
            }
            if d > a.d {
                let gap = d - a.d - if b.lane == a.lane { b.len } else { 0.0 };
                if gap < best.0 {
                    best = (gap, b.v);
                }
            }
        }
        if best.0.is_finite() {
            return best;
        }
        let mut dist = self.net.lanes[a.lane as usize].len - a.d;
        for s in a.route.iter() {
            if dist > LOOK {
                break;
            }
            let mut found = None;
            for &(d, j) in &self.occ[s.lane as usize] {
                if j as usize == i {
                    continue;
                }
                let b = &self.agents[j as usize];
                if b.lane == s.lane && b.dir != s.dir {
                    continue;
                }
                let tail = if b.lane == s.lane { d - b.len } else { d };
                let dd = if s.dir > 0 { tail } else { self.net.lanes[s.lane as usize].len - d - b.len };
                found = Some(found.map_or(dd, |f: f32| f.min(dd)));
                let _ = b;
            }
            if let Some(f) = found {
                let v = self.occ[s.lane as usize].first().map(|&(_, j)| self.agents[j as usize].v).unwrap_or(0.0);
                return (dist + f.max(0.0), v);
            }
            dist += self.net.lanes[s.lane as usize].len;
        }
        best
    }

    fn update_gates(&mut self, dt: f32) {
        let nn = self.net.node_kind.len();
        let mut want = vec![false; nn];
        for (i, a) in self.agents.iter().enumerate() {
            if !a.alive || !(a.kind == AKind::Train || a.kind == AKind::Tram) {
                continue;
            }
            let _ = i;
            let mut dist = -(self.net.lanes[a.lane as usize].len - a.d);
            let mut steps: Vec<(Step, f32)> = vec![(Step { lane: a.lane, dir: a.dir }, 0.0)];
            for s in a.route.iter() {
                dist += self.net.lanes[steps.last().unwrap().0.lane as usize].len;
                steps.push((*s, dist));
            }
            let _ = dist;
            let mut acc = -(a.d);
            for (k, (s, _)) in steps.iter().enumerate() {
                let ln = &self.net.lanes[s.lane as usize];
                if let Some(n) = ln.node {
                    let nk = &self.net.node_kind[n as usize];
                    if (nk == "level_crossing" && a.kind == AKind::Train) || (nk == "tram_crossing" && a.kind == AKind::Tram) {
                        let ahead = if k == 0 { 0.0 } else { acc };
                        let eta = ahead / a.v.max(3.0);
                        if ahead < 400.0 && eta < 28.0 {
                            want[n as usize] = true;
                        }
                    }
                }
                acc += ln.len;
            }
            let mut back = a.len - a.d;
            for (s, _) in a.hist.iter().rev() {
                if back <= 0.0 {
                    break;
                }
                if let Some(n) = self.net.lanes[s.lane as usize].node {
                    if self.net.node_kind[n as usize].ends_with("crossing") {
                        want[n as usize] = true;
                    }
                }
                back -= self.net.lanes[s.lane as usize].len;
            }
            if let Some(n) = self.net.lanes[a.lane as usize].node {
                if self.net.node_kind[n as usize].ends_with("crossing") {
                    want[n as usize] = true;
                }
            }
        }
        for n in 0..nn {
            let g = &mut self.gate[n];
            if want[n] {
                *g = (*g + dt / 8.0).min(1.0) + if *g == 0.0 { 1e-3 } else { 0.0 };
            } else {
                *g = (*g - dt / 6.0).max(0.0);
            }
        }
    }

    fn crossing_ok(&self, i: usize, l: u32) -> bool {
        let a = &self.agents[i];
        let ln = &self.net.lanes[l as usize];
        let Some(n) = ln.node else { return true };
        let nk = &self.net.node_kind[n as usize];
        if a.kind == AKind::Train && nk == "level_crossing" {
            return self.gate[n as usize] >= 0.98 || a.v > 2.0;
        }
        if a.kind == AKind::Tram && nk == "tram_crossing" {
            let clear = ln.conflicts.iter().all(|c| self.occ[c.lane as usize].is_empty());
            return (self.gate[n as usize] >= 0.45 && clear) || a.v > 2.0;
        }
        true
    }
}

#[wasm_bindgen]
impl World {
    #[wasm_bindgen(constructor)]
    pub fn new(json: &str, seed: u32) -> Result<World, JsValue> {
        let net = Net::from_json(json).map_err(|e| JsValue::from_str(&e))?;
        let n = net.lanes.len();
        let nn = net.node_kind.len();
        Ok(World { net, agents: Vec::new(), rng: Rng::new(seed as u64), t: 0.0, occ: vec![Vec::new(); n], owner: vec![-1; n], gate: vec![0.0; nn], out: Vec::new(), target: [0; 5], done: Vec::new(), clock0: 0.0, next_id: 0 })
    }

    pub fn set_targets(&mut self, cars: u32, buses: u32, trams: u32, trains: u32, peds: u32) {
        self.target = [cars, buses, trams, trains, peds];
    }

    pub fn populate(&mut self, cars: u32, buses: u32, trams: u32, trains: u32, peds: u32) {
        self.target = [cars, buses, trams, trains, peds];
        for _ in 0..trains {
            self.spawn(AKind::Train);
        }
        for _ in 0..trams {
            self.spawn(AKind::Tram);
        }
        for _ in 0..buses {
            self.spawn(AKind::Bus);
        }
        for _ in 0..cars {
            self.spawn(AKind::Car);
        }
        for _ in 0..peds {
            self.spawn(AKind::Ped);
        }
    }

    pub fn step(&mut self, dt: f32) {
        self.t += dt as f64;
        self.rebuild_occ();
        self.update_gates(dt);
        let n = self.agents.len();
        for i in 0..n {
            if !self.agents[i].alive {
                continue;
            }
            if self.agents[i].free.is_some() {
                self.step_free(i, dt);
                continue;
            }
            self.plan(i);
            let kind = self.agents[i].kind;
            if kind == AKind::Ped {
                self.step_ped(i, dt);
                continue;
            }
            let limit = if kind == AKind::Train { self.reserve(i) } else { f32::INFINITY };
            let (mut gap, mut lv) = self.leader_gap(i);
            let a = &self.agents[i];
            let rem = self.net.lanes[a.lane as usize].len - a.d;
            if let Some(nx) = a.route.front().copied() {
                let entering_ok = self.crossing_ok(i, nx.lane) && (self.net.lanes[nx.lane as usize].node.is_none() || self.can_enter(i, nx.lane) || self.net.lanes[a.lane as usize].node.is_some());
                if !entering_ok && rem - 0.5 < gap {
                    gap = (rem - 0.5).max(0.0);
                    lv = 0.0;
                }
            }
            if let Some(nx) = self.agents[i].route.front().copied() {
                let vn = self.net.lanes[nx.lane as usize].speed;
                let a = &self.agents[i];
                if vn < a.v {
                    let allowed = (vn * vn + 2.0 * 1.8 * (rem - 2.0).max(0.0)).sqrt();
                    if allowed < a.v {
                        let b_need = (a.v * a.v - vn * vn) / (2.0 * (rem - 2.0).max(1.0));
                        let gap_eq = rem.max(1.0) * 1.8 / b_need.max(0.1) + 4.0;
                        if gap_eq < gap {
                            gap = gap_eq;
                            lv = vn;
                        }
                    }
                }
            }
            if limit < gap {
                gap = (limit - 8.0).max(0.0);
                lv = 0.0;
            }
            if let Some(&(sl, sd, dep)) = self.agents[i].stops.front() {
                let a = &self.agents[i];
                let mut ahead = None;
                if a.lane == sl {
                    ahead = Some(sd - a.d);
                } else {
                    let mut acc = self.net.lanes[a.lane as usize].len - a.d;
                    for s in a.route.iter() {
                        if s.lane == sl {
                            ahead = Some(acc + sd);
                            break;
                        }
                        acc += self.net.lanes[s.lane as usize].len;
                        if acc > 400.0 {
                            break;
                        }
                    }
                }
                if let Some(dist) = ahead {
                    let clock = self.clock0 + self.t;
                    if dist < 1.5 && a.v < 0.3 {
                        let a = &mut self.agents[i];
                        a.stop_wait += dt;
                        let min = match a.kind { AKind::Train => 30.0, AKind::Tram => 12.0, _ => 8.0 };
                        if a.stop_wait >= min && clock >= dep {
                            a.stops.pop_front();
                            a.stop_wait = 0.0;
                        } else {
                            gap = 0.0;
                            lv = 0.0;
                        }
                    } else if dist < gap + 0.5 {
                        gap = (dist - 0.3).max(0.0);
                        lv = 0.0;
                    }
                    if dist < -5.0 {
                        self.agents[i].stops.pop_front();
                    }
                }
            }
            let a = &mut self.agents[i];
            let p = match kind {
                AKind::Train => idm::IdmParams { a: 0.7, b: 0.9, t: 2.0, s0: 8.0 },
                AKind::Tram => idm::IdmParams { a: 1.1, b: 1.3, t: 1.8, s0: 4.0 },
                AKind::Bus => idm::IdmParams { a: 1.0, b: 1.7, t: 1.6, s0: 3.0 },
                _ => idm::params(a.variant % 6),
            };
            let v0 = a.v0.min(self.net.lanes[a.lane as usize].speed * 1.05).max(1.0);
            let acc = idm::accel(&p, a.v, v0, gap, a.v - lv);
            a.acc = acc;
            let nv = (a.v + acc * dt).max(0.0);
            let mv = ((a.v + nv) * 0.5 * dt).min(gap.max(0.0) + 0.05).max(0.0);
            a.v = nv;
            if a.v < 0.1 {
                if a.stopped == 0.0 {
                    a.arrived = self.t;
                }
                a.stopped += dt;
            } else if a.v > 1.5 {
                a.stopped = 0.0;
            }
            a.d += mv;
            self.advance(i);
        }
        self.agents.retain(|a| a.alive);
        let mut have = [0u32; 5];
        for a in &self.agents {
            if a.trip < 0 {
                have[a.kind as usize] += 1;
            }
        }
        for (k, kind) in [AKind::Car, AKind::Bus, AKind::Tram, AKind::Train, AKind::Ped].into_iter().enumerate() {
            if have[k] < self.target[k] {
                self.spawn(kind);
            }
        }
        for o in self.owner.iter_mut() {
            *o = -1;
        }
        let mut owners: Vec<(u32, i32)> = Vec::new();
        let lens: Vec<f32> = self.net.lanes.iter().map(|l| l.len).collect();
        for (i, a) in self.agents.iter_mut().enumerate() {
            if a.kind == AKind::Train {
                let mut keep = vec![a.lane];
                keep.extend(a.route.iter().map(|s| s.lane).filter(|l| a.reserved.contains(l)));
                let mut back = a.len - a.d;
                for (s, _) in a.hist.iter().rev() {
                    if back <= 0.0 {
                        break;
                    }
                    keep.push(s.lane);
                    back -= lens[s.lane as usize];
                }
                a.reserved.retain(|l| keep.contains(l));
                for &l in &keep {
                    owners.push((l, i as i32));
                }
            }
        }
        for (l, i) in owners {
            self.owner[l as usize] = i;
        }
    }

    fn advance(&mut self, i: usize) {
        loop {
            let len = self.net.lanes[self.agents[i].lane as usize].len;
            if self.agents[i].d < len {
                return;
            }
            let Some(nx) = self.agents[i].route.pop_front() else {
                let a = &mut self.agents[i];
                if a.trip >= 0 {
                    a.alive = false;
                    self.done.push(a.trip as u32);
                    return;
                }
                if a.kind == AKind::Train || a.kind == AKind::Tram {
                    a.d = len;
                    a.v = 0.0;
                    a.dwell += 0.1;
                    if a.dwell > 30.0 && self.net.lanes[a.lane as usize].bidir {
                        a.dir = -a.dir;
                        a.d = (a.len).min(len);
                        a.hist.clear();
                        a.dwell = 0.0;
                    }
                    return;
                }
                a.alive = false;
                return;
            };
            let a = &mut self.agents[i];
            let over = a.d - len;
            a.hist.push_back((Step { lane: a.lane, dir: a.dir }, len));
            while a.hist.len() > 24 {
                a.hist.pop_front();
            }
            a.lane = nx.lane;
            a.dir = nx.dir;
            a.d = over;
        }
    }

    fn step_free(&mut self, i: usize, dt: f32) {
        let a = &mut self.agents[i];
        let mut f = a.free.unwrap();
        if a.kind != AKind::Ped {
            let fwd = f.throttle * 3.2 - f.brake * 7.5 * a.v.signum() - 0.015 * a.v * a.v.abs() - 0.15 * a.v.signum();
            let mut v = a.v + fwd * dt;
            if f.brake > 0.1 && a.v.abs() < 0.3 && f.throttle < 0.05 {
                v = (a.v - f.brake * 2.0 * dt).max(-4.0);
            }
            if f.handbrake {
                v *= (1.0 - 1.6 * dt).max(0.0);
            }
            if a.v.abs() < 0.05 && f.throttle == 0.0 && f.brake == 0.0 {
                v = 0.0;
            }
            a.v = v.clamp(-6.0, 45.0);
            let wheelbase = 2.8;
            let st = f.steer.clamp(-1.0, 1.0) * (0.55 - (a.v.abs() / 45.0) * 0.4);
            f.h += a.v / wheelbase * st.tan() * dt;
            f.x += f.h.cos() * a.v * dt;
            f.y += f.h.sin() * a.v * dt;
        }
        let (hx, hy) = if a.kind == AKind::Ped { (0.0, 0.0) } else { (f.h.cos(), f.h.sin()) };
        let want = Kind::Drive;
        let hit = self.net.project(f.x, f.y, hx, hy, if a.kind == AKind::Ped { 1.6 } else { 2.5 }, want);
        let a = &mut self.agents[i];
        match hit {
            Some((lane, s, z, _)) => {
                a.lane = lane;
                a.dir = 1;
                a.d = s + if a.kind == AKind::Ped { 0.4 } else { a.len * 0.5 };
                f.on_road = true;
                if a.kind != AKind::Ped {
                    f.z = z;
                }
            }
            None => {
                a.lane = OFF_NET;
                f.on_road = false;
                if a.kind != AKind::Ped {
                    f.z = f.ground;
                }
            }
        }
        a.free = Some(f);
    }

    fn step_ped(&mut self, i: usize, dt: f32) {
        let a = &self.agents[i];
        let ln = &self.net.lanes[a.lane as usize];
        let rem = ln.len - a.d;
        let speed = 1.25 + (a.variant as f32) * 0.03;
        let mut go = true;
        if rem < 0.6 {
            if let Some(nx) = a.route.front().copied() {
                go = self.can_enter(i, nx.lane);
            }
        }
        let a = &mut self.agents[i];
        a.v = if go { speed } else { 0.0 };
        a.d = (a.d + a.v * dt).min(if go { f32::INFINITY } else { ln.len - 0.3 });
        if a.d >= self.net.lanes[a.lane as usize].len {
            if a.route.is_empty() {
                a.dir = -a.dir;
                a.d = 0.0;
                return;
            }
            self.advance(i);
        }
    }

    pub fn take_over_nearest(&mut self, x: f32, y: f32, r: f32) -> bool {
        let mut best: Option<(usize, f32)> = None;
        for (i, a) in self.agents.iter().enumerate() {
            if a.kind != AKind::Car || a.free.is_some() || a.trip >= 0 || !a.alive || a.lane == OFF_NET {
                continue;
            }
            let l = &self.net.lanes[a.lane as usize];
            let s = if a.dir > 0 { a.d } else { l.len - a.d };
            let (p, _, _) = self.net.at(a.lane, s);
            let d = ((p[0] - x).powi(2) + (p[1] - y).powi(2)).sqrt();
            if d < r && best.map_or(true, |b| d < b.1) {
                best = Some((i, d));
            }
        }
        let Some((i, _)) = best else { return false };
        self.release_player();
        let a = &self.agents[i];
        let l = &self.net.lanes[a.lane as usize];
        let s = if a.dir > 0 { a.d } else { l.len - a.d };
        let (p, h, _) = self.net.at(a.lane, s);
        let h = if a.dir > 0 { h } else { h + std::f32::consts::PI };
        let a = &mut self.agents[i];
        a.free = Some(Free { x: p[0], y: p[1], z: p[2], h, ground: p[2], on_road: true, ..Default::default() });
        a.route.clear();
        true
    }

    pub fn set_player_input(&mut self, throttle: f32, brake: f32, steer: f32, handbrake: bool, ground: f32) {
        for a in self.agents.iter_mut() {
            if a.kind != AKind::Ped {
                if let Some(f) = a.free.as_mut() {
                    f.throttle = throttle;
                    f.brake = brake;
                    f.steer = steer;
                    f.handbrake = handbrake;
                    f.ground = ground;
                }
            }
        }
    }

    pub fn player(&self) -> Vec<f32> {
        for a in &self.agents {
            if a.kind != AKind::Ped {
                if let Some(f) = a.free {
                    return vec![f.x, f.y, f.z, f.h, a.v, if f.on_road { 1.0 } else { 0.0 }];
                }
            }
        }
        Vec::new()
    }

    pub fn release_player(&mut self) {
        for a in self.agents.iter_mut() {
            if a.kind != AKind::Ped && a.free.is_some() {
                a.alive = false;
            }
        }
        self.agents.retain(|a| a.alive);
    }

    pub fn set_walker(&mut self, x: f32, y: f32, z: f32) {
        if let Some(a) = self.agents.iter_mut().find(|a| a.kind == AKind::Ped && a.free.is_some()) {
            let f = a.free.as_mut().unwrap();
            f.x = x;
            f.y = y;
            f.z = z;
            return;
        }
        self.agents.push(Agent {
            kind: AKind::Ped, lane: OFF_NET, dir: 1, d: 0.0, v: 0.0, len: 0.8, v0: 0.0, route: VecDeque::new(), hist: VecDeque::new(), stopped: 0.0,
            arrived: 0.0, variant: 0, lat: 0.0, dwell: 0.0, reserved: Vec::new(), alive: true, trip: -1, stops: VecDeque::new(), stop_wait: 0.0,
            free: Some(Free { x, y, z, ..Default::default() }), id: 0, acc: 0.0,
        });
        self.next_id += 1;
        self.agents.last_mut().unwrap().id = self.next_id;
    }

    pub fn clear_walker(&mut self) {
        self.agents.retain(|a| !(a.kind == AKind::Ped && a.free.is_some()));
    }

    pub fn solids_near(&self, x: f32, y: f32, r: f32) -> Vec<f32> {
        let mut out = Vec::new();
        for a in &self.agents {
            if a.kind == AKind::Ped || a.free.is_some() || a.lane == OFF_NET {
                continue;
            }
            let l = &self.net.lanes[a.lane as usize];
            let s = if a.dir > 0 { a.d - a.len * 0.5 } else { l.len - a.d + a.len * 0.5 };
            let (p, h, _) = self.net.at(a.lane, s);
            if (p[0] - x).abs() > r || (p[1] - y).abs() > r {
                continue;
            }
            let w = match a.kind { AKind::Car => 1.9, AKind::Bus => 2.6, _ => 2.7 };
            out.extend_from_slice(&[p[0], p[1], p[2], h, a.len, w]);
        }
        out
    }

    pub fn set_clock(&mut self, service_seconds: f64) {
        self.clock0 = service_seconds - self.t;
    }

    pub fn clock(&self) -> f64 {
        self.clock0 + self.t
    }

    #[allow(clippy::too_many_arguments)]
    pub fn add_trip(&mut self, kind: u8, variant: u8, trip: u32, lanes: Vec<u32>, dirs: Vec<i8>, d: f32, v: f32, stop_step: Vec<u32>, stop_d: Vec<f32>, stop_dep: Vec<f64>) -> bool {
        if lanes.is_empty() {
            return false;
        }
        let kind = match kind { 1 => AKind::Bus, 2 => AKind::Tram, 3 => AKind::Train, _ => AKind::Car };
        let len = match kind { AKind::Bus => 12.0, AKind::Tram => 30.0, AKind::Train => if variant == 1 { 6.0 * 23.0 } else { 10.0 * 26.0 }, _ => 4.5 };
        let mut route: VecDeque<Step> = lanes.iter().zip(dirs.iter()).map(|(&lane, &dir)| Step { lane, dir }).collect();
        let first = route.pop_front().unwrap();
        let stops = stop_step.iter().zip(stop_d.iter()).zip(stop_dep.iter()).map(|((&k, &sd), &dep)| (lanes[k as usize], sd, dep)).collect();
        let lane_len = self.net.lanes[first.lane as usize].len;
        let a = Agent {
            kind, lane: first.lane, dir: first.dir, d: d.clamp(0.0, lane_len), v, len, v0: self.net.lanes[first.lane as usize].speed.max(8.0),
            route, hist: VecDeque::new(), stopped: 0.0, arrived: 0.0, variant, lat: 0.0, dwell: 0.0, reserved: Vec::new(), alive: true,
            trip: trip as i32, stops, stop_wait: 0.0, free: None, id: 0, acc: 0.0,
        };
        self.agents.push(a);
        self.next_id += 1;
        self.agents.last_mut().unwrap().id = self.next_id;
        true
    }

    pub fn has_trip(&self, trip: u32) -> bool {
        self.agents.iter().any(|a| a.trip == trip as i32)
    }

    pub fn take_done(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.done)
    }

    pub fn export_state(&self) -> Vec<f32> {
        let mut out = Vec::new();
        for a in &self.agents {
            if a.free.is_some() || !a.alive || a.lane == OFF_NET {
                continue;
            }
            out.extend_from_slice(&[a.id as f32, a.kind as u8 as f32, a.variant as f32, a.trip as f32, a.lane as f32, a.dir as f32, a.d, a.v, a.len, a.lat, a.route.len() as f32, a.stops.len() as f32]);
            for s in &a.route {
                out.extend_from_slice(&[s.lane as f32, s.dir as f32]);
            }
            for &(l, d, dep) in &a.stops {
                out.extend_from_slice(&[l as f32, d, (dep - self.clock0 - self.t) as f32]);
            }
        }
        out
    }

    pub fn import_state(&mut self, data: Vec<f32>, map: Vec<i32>) -> u32 {
        let mut i = 0;
        let mut n = 0;
        let clock = self.clock0 + self.t;
        let m = |l: f32| -> i32 { map.get(l as usize).copied().unwrap_or(-1) };
        while i + 12 <= data.len() {
            let h = &data[i..i + 12];
            let (nr, ns) = (h[10] as usize, h[11] as usize);
            let body = &data[i + 12..i + 12 + nr * 2 + ns * 3];
            i += 12 + nr * 2 + ns * 3;
            let lane = m(h[4]);
            if lane < 0 {
                continue;
            }
            let mut route = VecDeque::new();
            for k in 0..nr {
                let l = m(body[k * 2]);
                if l < 0 {
                    break;
                }
                route.push_back(Step { lane: l as u32, dir: body[k * 2 + 1] as i8 });
            }
            let mut stops = VecDeque::new();
            for k in 0..ns {
                let o = nr * 2 + k * 3;
                let l = m(body[o]);
                if l >= 0 {
                    stops.push_back((l as u32, body[o + 1], clock + body[o + 2] as f64));
                }
            }
            let kind = match h[1] as u8 { 1 => AKind::Bus, 2 => AKind::Tram, 3 => AKind::Train, 4 => AKind::Ped, _ => AKind::Car };
            let trip = h[3] as i32;
            if trip >= 0 && route.is_empty() {
                continue;
            }
            let id = h[0] as u32;
            self.next_id = self.next_id.max(id);
            self.agents.push(Agent {
                kind, lane: lane as u32, dir: h[5] as i8, d: h[6], v: h[7], len: h[8], v0: self.net.lanes[lane as usize].speed.max(1.0), route, hist: VecDeque::new(),
                stopped: 0.0, arrived: 0.0, variant: h[2] as u8, lat: h[9], dwell: 0.0, reserved: Vec::new(), alive: true, trip, stops, stop_wait: 0.0,
                free: None, id, acc: 0.0,
            });
            n += 1;
        }
        n
    }

    pub fn trips(&self) -> Vec<u32> {
        self.agents.iter().filter(|a| a.trip >= 0).map(|a| a.trip as u32).collect()
    }

    pub fn frame2(&mut self) -> Vec<f32> {
        let mut out = Vec::with_capacity(self.agents.len() * 14);
        for a in &self.agents {
            let flags = if a.acc < -0.6 || a.v < 0.2 { 1.0 } else { 0.0 };
            if let Some(f) = a.free {
                let (c, s) = (f.h.cos(), f.h.sin());
                let half = if a.kind == AKind::Ped { 0.2 } else { a.len * 0.5 };
                out.extend_from_slice(&[a.id as f32, a.kind as u8 as f32, a.variant as f32, a.trip as f32, a.v, flags, 2.0]);
                out.extend_from_slice(&[f.x + c * half, f.y + s * half, f.z, f.x - c * half, f.y - s * half, f.z]);
                continue;
            }
            let (n, step) = match a.kind {
                AKind::Car | AKind::Ped => (2usize, if a.kind == AKind::Ped { 0.4 } else { a.len }),
                _ => ((a.len / 3.0).ceil() as usize + 2, 3.0),
            };
            out.extend_from_slice(&[a.id as f32, a.kind as u8 as f32, a.variant as f32, a.trip as f32, a.v, flags, n as f32]);
            for k in 0..n {
                let p = self.sample(a, k as f32 * step);
                let (mut x, mut y) = (p[0], p[1]);
                if a.lat != 0.0 {
                    let q = self.sample(a, k as f32 * step + 0.5);
                    let h = (p[1] - q[1]).atan2(p[0] - q[0]);
                    x += -h.sin() * a.lat;
                    y += h.cos() * a.lat;
                }
                out.extend_from_slice(&[x, y, p[2]]);
            }
        }
        out
    }

    pub fn time(&self) -> f64 {
        self.t
    }

    pub fn count(&self) -> u32 {
        self.agents.len() as u32
    }

    pub fn signal(&self, node: u32, group: i32) -> u8 {
        self.signal_state(node as u16, group as i16)
    }

    pub fn gate(&self, node: u32) -> f32 {
        self.gate.get(node as usize).copied().unwrap_or(0.0)
    }

    pub fn frame(&mut self) -> Vec<f32> {
        let mut out = std::mem::take(&mut self.out);
        out.clear();
        for a in &self.agents {
            if let Some(f) = a.free {
                if a.kind == AKind::Ped {
                    continue;
                }
                out.extend_from_slice(&[f.x, f.y, f.z, f.h, 0.0, a.kind as u8 as f32, a.len, a.variant as f32, a.v]);
                continue;
            }
            let sections: Vec<(f32, f32)> = match a.kind {
                AKind::Tram => vec![(0.0, 10.0), (10.4, 9.4), (20.2, 9.6)],
                AKind::Train => {
                    let (n, l) = if a.trip >= 0 && a.variant == 1 { (6, 23.0) } else if a.trip >= 0 { (10, 26.0) } else { (4, 26.0) };
                    (0..n).map(|k| (k as f32 * l, l - 0.4)).collect()
                }
                _ => vec![(0.0, a.len)],
            };
            for (k, (off, slen)) in sections.iter().enumerate() {
                let f = self.sample(a, off + slen * 0.5);
                let fa = self.sample(a, *off);
                let fb = self.sample(a, off + slen);
                let h = (fa[1] - fb[1]).atan2(fa[0] - fb[0]);
                let pitch = ((fa[2] - fb[2]) / slen.max(0.1)).atan();
                let mut x = f[0];
                let mut y = f[1];
                if a.lat != 0.0 {
                    x += -h.sin() * a.lat;
                    y += h.cos() * a.lat;
                }
                out.extend_from_slice(&[x, y, f[2], h, pitch, a.kind as u8 as f32, *slen, a.variant as f32 + k as f32 * 0.0, a.v]);
            }
        }
        let r = out.clone();
        self.out = out;
        r
    }
}

impl World {
    fn sample(&self, a: &Agent, back: f32) -> [f32; 3] {
        let mut d = a.d - back;
        let mut lane = a.lane;
        let mut dir = a.dir;
        let mut k = a.hist.len();
        while d < 0.0 && k > 0 {
            k -= 1;
            let (s, len) = a.hist[k];
            lane = s.lane;
            dir = s.dir;
            d += len;
        }
        let l = &self.net.lanes[lane as usize];
        let s = if dir > 0 { d.max(0.0) } else { l.len - d.max(0.0) };
        self.net.at(lane, s).0
    }
}

#[cfg(test)]
mod tests;
