//! The player: an arcade car (single-track model with tyre saturation, load
//! transfer, handbrake, reverse), surfaces (carriageway / sidewalk / off-road
//! with curbs), collisions with AI cars, transit and buildings, and the
//! player's bodies (car, walking pedestrian) as obstacles AI traffic brakes
//! and honks for.

use super::*;

/// mass (kg), yaw inertia (kg m²), CG → front / rear axle (m), CG height (m)
const M: f32 = 1450.0;
const IZ: f32 = 2450.0;
const LA: f32 = 1.12;
const LB: f32 = 1.58;
const WB: f32 = LA + LB;
const HCG: f32 = 0.55;
/// cornering stiffness per axle (N/rad)
const CF: f32 = 92_000.0;
const CR: f32 = 105_000.0;
const G: f32 = 9.81;
const VMAX: f32 = 50.0;
const VREV: f32 = 8.0;
/// physics sub-step (s)
const SUB: f32 = 1.0 / 120.0;
/// sidewalk band beyond the carriageway edge of a street with curbs (m)
const WALK_W: f32 = 4.5;

pub const SURF_OFF: u8 = 0;
pub const SURF_ROAD: u8 = 1;
pub const SURF_WALK: u8 = 2;

/// seconds a honking car keeps its horn on / before it may honk again
const HORN_ON: f32 = 1.1;
const HORN_CYCLE: f32 = 4.5;

impl Player {
    pub fn new(pose: Pose, v: f32, edge: u32, id: u32, structure: bool) -> Player {
        Player {
            x: pose.x,
            y: pose.y,
            z: pose.z,
            h: pose.h,
            p: pose.p,
            v,
            steer: 0.0,
            on_road: true,
            edge,
            id,
            placed: true,
            structure,
            bump: 0.0,
            vy: 0.0,
            r: 0.0,
            ax: 0.0,
            surface: SURF_ROAD,
            curb_cool: 0.0,
            ev_curb: 0.0,
            ev_hit: 0.0,
            autopilot: false,
        }
    }
}

/// grip factor, extra drag (m/s²) per surface
fn surface_params(s: u8) -> (f32, f32) {
    match s {
        SURF_ROAD => (1.0, 0.0),
        SURF_WALK => (0.88, 0.55),
        _ => (0.62, 1.6),
    }
}

impl World {
    /// Surface under (x, y): (surface, road class, edge heading) — nearest carriageway
    /// edge within reach decides (sidewalk band behind the curb on streets, else off-road).
    fn surface_at(&self, x: f64, y: f64, z: f32, near: &mut Vec<u32>) -> (u8, u8, f32) {
        self.g.edges_near(x, y, 16.0, near);
        let mut best: Option<(f32, u8, f32)> = None; // outside distance, class, heading
        for &eid in near.iter() {
            let ed = &self.g.edges[eid as usize];
            if !ed.alive || ed.class > 6 {
                continue;
            }
            let (_, lat, ez, hdg) = self.g.project_on_edge(eid, x, y);
            if (ez - z).abs() > 4.0 {
                continue;
            }
            let out = lat.abs() - ed.half_w;
            if best.map_or(true, |b| out < b.0) {
                best = Some((out, ed.class, hdg));
            }
        }
        match best {
            Some((out, _, h)) if out <= 0.0 => (SURF_ROAD, 0, h),
            Some((out, cls, h)) if out <= WALK_W && (2..=6).contains(&cls) => (SURF_WALK, cls, h),
            Some((_, cls, h)) => (SURF_OFF, cls, h),
            None => (SURF_OFF, 7, 0.0),
        }
    }

    /// Arcade single-track car + collisions + surfaces + road snapping. `dt` is real time.
    pub fn player_step(&mut self, dt: f32, throttle: f32, brake: f32, steer_in: f32, handbrake: bool, ground_z: f32) {
        let Some(pi) = self.player_index() else {
            self.player = None;
            return;
        };
        let dt = dt.min(0.05);
        let throttle = throttle.clamp(0.0, 1.0);
        let brake = brake.clamp(0.0, 1.0);
        if self.player.as_ref().unwrap().autopilot {
            let input = throttle > 0.0 || brake > 0.0 || steer_in.abs() > 0.05 || handbrake;
            let c = &mut self.cars[pi];
            let pose = c.pose;
            let (v, link) = (c.v, c.link);
            if input && c.posed {
                // the player takes the wheel
                c.flags |= F_PLAYER;
                c.flags &= !(F_COMMIT | F_HELD);
                c.lc_from = NO_LANE;
            }
            let edge = if link != NONE { self.g.links[link as usize].edge } else { NONE };
            let p = self.player.as_mut().unwrap();
            p.x = pose.x;
            p.y = pose.y;
            p.z = pose.z;
            p.h = pose.h;
            p.p = pose.p;
            p.v = v;
            p.vy = 0.0;
            p.r = 0.0;
            p.on_road = link != NONE;
            if edge != NONE {
                p.edge = edge;
            }
            p.surface = SURF_ROAD;
            if !input {
                return;
            }
            p.autopilot = false;
        }
        let mut near = std::mem::take(&mut self.tmp);
        let (grip, drag) = surface_params(self.player.as_ref().unwrap().surface);
        let p = self.player.as_mut().unwrap();
        // steering: rate-limited, less lock at speed
        let max_steer = 0.62 / (1.0 + p.v.abs() / 17.0);
        let target = steer_in.clamp(-1.0, 1.0) * max_steer;
        p.steer += (target - p.steer) * (dt * 8.0).min(1.0);
        let steer = p.steer;
        let n = ((dt / SUB).ceil() as usize).clamp(1, 8);
        let h = dt / n as f32;
        let mut a_long = 0.0f32;
        for _ in 0..n {
            let v = p.v;
            // axle loads with longitudinal load transfer (from last sub-step's acceleration)
            let tr = M * p.ax * HCG / WB;
            let nf = (M * G * LB / WB - tr).max(0.15 * M * G);
            let nr = (M * G * LA / WB + tr).max(0.15 * M * G);
            let mu = grip;
            // longitudinal: engine / brakes / reverse gear
            let mut fx = 0.0f32;
            if throttle > 0.0 {
                if v < -0.3 {
                    fx += 9.0 * M * throttle;
                } else {
                    fx += throttle * M * 5.2 * (1.0 - (v / VMAX).powi(2)).max(0.0) / (1.0 + v.max(0.0) / 30.0);
                }
            }
            if brake > 0.0 {
                if v > 0.3 {
                    fx -= 9.8 * M * brake;
                } else if v > -VREV {
                    fx -= 3.2 * M * brake;
                }
            }
            if handbrake {
                // rear wheels locked: they drag, and let go sideways
                fx -= v.signum() * (mu * nr * 0.75);
            }
            // tyres can't transmit more than the surface allows
            let fmax = mu * (nf + nr);
            fx = fx.clamp(-fmax, fmax);
            // resistance: aero, rolling, surface
            let res = 0.00055 * v * v.abs() + (0.12 + drag + 0.004 * drag * v.abs()) * v.signum();
            let mut ax_b = fx / M - res;
            // lateral dynamics (only meaningful when moving forward at some speed)
            let (sd, cd) = steer.sin_cos();
            let w = ((v - 2.5) / 3.0).clamp(0.0, 1.0);
            let mut vy = p.vy;
            let mut r = p.r;
            if w > 0.0 {
                let af = (vy + LA * r).atan2(v.max(0.5)) - steer;
                let ar = (vy - LB * r).atan2(v.max(0.5));
                let muf = mu * 0.93; // front lets go first: understeer at the limit
                let mur = mu * if handbrake { 0.35 } else { 1.0 };
                let fyf = (-CF * af).clamp(-muf * nf, muf * nf);
                let fyr = (-CR * ar).clamp(-mur * nr, mur * nr);
                ax_b += -fyf * sd / M + vy * r;
                let ay_b = (fyf * cd + fyr) / M - v * r;
                let rd = (LA * fyf * cd - LB * fyr) / IZ;
                vy += ay_b * h;
                r += rd * h;
                // a little yaw / slide damping keeps the arcade feel controllable
                r *= (-h * 0.35).exp();
            }
            // kinematic (no slip) at walking speed and in reverse
            let rk = v / WB * steer.tan() * if handbrake && v > 0.0 { 1.4 } else { 1.0 };
            let vyk = rk * LB;
            p.vy = vy * w + vyk * (1.0 - w);
            p.r = r * w + rk * (1.0 - w);
            let mut nv = v + ax_b * h;
            // resistances never reverse the direction of travel
            if throttle == 0.0 && v != 0.0 && nv.signum() != v.signum() && !(brake > 0.0 && v <= 0.3) {
                nv = 0.0;
            }
            nv = nv.clamp(-VREV, VMAX);
            if nv.abs() < 0.05 && throttle == 0.0 && brake == 0.0 {
                nv = 0.0;
                p.vy *= 0.5;
            }
            p.ax = (nv - v) / h;
            a_long = p.ax;
            p.v = nv;
            p.h = wrap_pi(p.h + p.r * h);
            let (hs, hc) = p.h.sin_cos();
            p.x += ((p.v * hc - p.vy * hs) * h) as f64;
            p.y += ((p.v * hs + p.vy * hc) * h) as f64;
        }
        p.ax = p.ax.clamp(-12.0, 8.0);
        p.bump *= (-dt * 4.0).exp();
        p.curb_cool = (p.curb_cool - dt).max(0.0);
        self.player_collide(pi);

        // surface + curbs
        let (px, py, pz) = {
            let p = self.player.as_ref().unwrap();
            (p.x, p.y, p.z)
        };
        let (surf, _, hdg) = self.surface_at(px, py, pz, &mut near);
        {
            let p = self.player.as_mut().unwrap();
            let prev = p.surface;
            if prev != surf && p.curb_cool <= 0.0 && (prev == SURF_WALK || surf == SURF_WALK) && (prev != SURF_OFF || surf != SURF_OFF) {
                // crossing the curb: speed component across it is what hurts
                let (hs, hc) = p.h.sin_cos();
                let (vx, vy) = (p.v * hc - p.vy * hs, p.v * hs + p.vy * hc);
                let vn = (vx * hdg.sin() - vy * hdg.cos()).abs();
                let jolt = vn.max(p.v.abs() * 0.15);
                if jolt > 0.4 {
                    let loss = (0.06 + 0.035 * vn).min(0.45);
                    p.v *= 1.0 - loss;
                    p.vy *= 1.0 - loss;
                    p.ev_curb = p.ev_curb.max(jolt);
                    p.curb_cool = 0.35;
                }
            }
            p.surface = surf;
        }

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
                c.s = (ls + c.len * 0.5).clamp(0.0, l.len - 0.01);
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
        c.a = a_long;
        c.v = p.v.max(0.0);
        c.pose = Pose { x: p.x, y: p.y, z: p.z, h: p.h, p: p.p };
    }

    /// Resolve overlaps of the player car with AI cars, transit and buildings:
    /// push it out, kill the velocity into the obstacle (small bounce), scrub
    /// speed along it. AI cars that are hit stop and honk.
    fn player_collide(&mut self, pi: usize) {
        let p = self.player.as_ref().unwrap();
        let (mut x, mut y, h) = (p.x, p.y, p.h);
        let (hs, hc) = h.sin_cos();
        // world velocity
        let mut vel = (p.v * hc - p.vy * hs, p.v * hs + p.vy * hc);
        let mut hit = 0.0f32;
        let mut spin = 0.0f32;
        let mut hit_ai: Vec<usize> = Vec::new();
        let respond = |vel: &mut (f32, f32), n: (f32, f32), restitution: f32, hit: &mut f32| {
            let vn = vel.0 * n.0 + vel.1 * n.1;
            if vn < 0.0 {
                *hit = hit.max(-vn);
                // normal: bounce; tangential: scrape
                let (tx, ty) = (vel.0 - vn * n.0, vel.1 - vn * n.1);
                let keep = (1.0 - 0.25 * (-vn / 10.0).min(1.0)).max(0.4);
                *vel = (tx * keep - restitution * vn * n.0, ty * keep - restitution * vn * n.1);
            }
        };
        // the body of whatever was taken over (sedan … box truck)
        let (bhl, bhw) = {
            let c = &self.cars[pi];
            (c.len * 0.5, HALF_W[c.kind as usize % idm::KINDS])
        };
        let body = |x: f64, y: f64| Obb { x, y, h, hl: bhl, hw: bhw };
        for (j, c) in self.cars.iter().enumerate() {
            if j == pi || c.flags & F_DEAD != 0 || !c.posed {
                continue;
            }
            if (c.pose.x - x).powi(2) + (c.pose.y - y).powi(2) > 144.0 {
                continue;
            }
            let ob = Obb { x: c.pose.x, y: c.pose.y, h: c.pose.h, hl: c.len * 0.5, hw: HALF_W[c.kind as usize % idm::KINDS] };
            if let Some((ax, pen)) = obb_overlap(&body(x, y), &ob) {
                x += (ax.0 * (pen + 0.02)) as f64;
                y += (ax.1 * (pen + 0.02)) as f64;
                // the other car is a moving body too: relative velocity
                let (os, oc) = c.pose.h.sin_cos();
                let ov = (c.v * oc, c.v * os);
                let mut rel = (vel.0 - ov.0, vel.1 - ov.1);
                let before = rel;
                respond(&mut rel, ax, 0.2, &mut hit);
                vel = (vel.0 + rel.0 - before.0, vel.1 + rel.1 - before.1);
                // off-centre hits twist the car
                let (dx, dy) = ((ob.x - x) as f32, (ob.y - y) as f32);
                spin += (hc * dy - hs * dx).signum() * -0.08 * (before.0 * ax.0 + before.1 * ax.1).min(0.0).abs().min(10.0);
                hit_ai.push(j);
            }
        }
        for o in &self.obst {
            let (os, oc) = o.h.sin_cos();
            let (cx, cy) = (o.x - (oc * o.len * 0.5) as f64, o.y - (os * o.len * 0.5) as f64);
            if (cx - x).powi(2) + (cy - y).powi(2) > ((o.len * 0.5 + 6.0) as f64).powi(2) {
                continue;
            }
            if let Some((ax, pen)) = obb_overlap(&body(x, y), &Obb { x: cx, y: cy, h: o.h, hl: o.len * 0.5, hw: o.w * 0.5 }) {
                x += (ax.0 * (pen + 0.02)) as f64;
                y += (ax.1 * (pen + 0.02)) as f64;
                respond(&mut vel, ax, 0.15, &mut hit);
            }
        }
        // buildings: three circles along the body
        if self.fp.count > 0 {
            for _ in 0..3 {
                let mut total = (0.0f32, 0.0f32);
                let reach = (bhl - bhw).max(0.5);
                for k in [-reach, -reach * 0.5, 0.0, reach * 0.5, reach] {
                    let (cx, cy) = (x as f32 + hc * k, y as f32 + hs * k);
                    if let Some(pu) = self.fp.push_circle(cx, cy, bhw + 0.05) {
                        total.0 += pu.0;
                        total.1 += pu.1;
                        spin += k.signum() * (hc * pu.1 - hs * pu.0) * 0.4;
                    }
                }
                let l = total.0.hypot(total.1);
                if l < 1e-4 {
                    break;
                }
                x += total.0 as f64;
                y += total.1 as f64;
                respond(&mut vel, (total.0 / l, total.1 / l), 0.15, &mut hit);
            }
        }
        for j in hit_ai {
            let id = self.cars[j].id;
            let c = &mut self.cars[j];
            c.v = 0.0;
            c.lc_cool = 3.0;
            self.honk(id, true);
        }
        let p = self.player.as_mut().unwrap();
        p.x = x;
        p.y = y;
        p.v = vel.0 * hc + vel.1 * hs;
        p.vy = -vel.0 * hs + vel.1 * hc;
        if hit > 0.5 {
            p.r = p.r * 0.5 + spin.clamp(-2.0, 2.0);
            p.bump = p.bump.max(hit);
            p.ev_hit = p.ev_hit.max(hit);
        }
    }

    /// Start honking (once per cycle; `force` skips the "some drivers don't" dice).
    fn honk(&mut self, id: u32, force: bool) {
        if self.horns.iter().any(|h| h.0 == id) {
            return;
        }
        if !force && (id.wrapping_mul(2654435761) >> 29) >= 5 {
            // ~3 in 8 drivers just brake
            self.horns.push((id, HORN_CYCLE - HORN_ON));
            return;
        }
        self.horns.push((id, HORN_CYCLE));
    }

    /// is this car's horn sounding?
    pub fn horn_on(&self, id: u32) -> bool {
        !self.horns.is_empty() && self.horns.iter().any(|h| h.0 == id && h.1 > HORN_CYCLE - HORN_ON)
    }

    /// The walking player (None / radius ≤ 0 = not walking). Cars brake for them;
    /// `dt` (real s) advances the horn timers and driver reactions.
    pub fn set_walker(&mut self, e: f64, n: f64, z: f32, r: f32, dt: f32) {
        self.walker = if r > 0.0 && e.is_finite() && n.is_finite() { Some((e, n, z, r.min(3.0))) } else { None };
        for h in self.horns.iter_mut() {
            h.1 -= dt;
        }
        self.horns.retain(|h| h.1 > 0.0);
        // drivers closing in on the player's body (car across their lane, walker in it) honk
        if self.body_links.is_empty() {
            return;
        }
        let mut honk: Vec<u32> = Vec::new();
        for c in &self.cars {
            if c.flags & (F_DEAD | F_PLAYER) != 0 || c.link == NONE || c.bus != NONE || c.lane >= 8 {
                continue;
            }
            for b in &self.body_links {
                if b.link == c.link && b.mask & (1 << c.lane) != 0 && b.s0 > c.s - 1.0 {
                    let gap = b.s0 - c.s;
                    if gap < 7.0 + c.v * 1.3 && (c.v > 1.5 || gap < 5.0) {
                        honk.push(c.id);
                    }
                }
            }
        }
        for id in honk {
            self.honk(id, false);
        }
    }

    /// Map a disc (the walker, or part of the player car) moving with world velocity
    /// (vx, vy) onto the lanes it covers, both directions: AI cars brake for it.
    fn add_body(&mut self, x: f64, y: f64, z: f32, r: f32, vel: (f32, f32), junctions: bool, near: &mut Vec<u32>) {
        self.g.edges_near(x, y, 12.0, near);
        for &eid in near.iter() {
            let e = &self.g.edges[eid as usize];
            if !e.alive || e.class > 6 {
                continue;
            }
            let (se, lat, ez, he) = self.g.project_on_edge(eid, x, y);
            if (ez - z).abs() > 3.5 || se <= 0.05 || se >= e.len - 0.05 || lat.abs() > e.half_w + r {
                continue;
            }
            let (hs, hc) = he.sin_cos();
            let along = vel.0 * hc + vel.1 * hs;
            for (k, &link) in e.links.iter().enumerate() {
                if link == NONE {
                    continue;
                }
                let (sl, latl, v) = if k == 0 { (se, lat, along) } else { (e.len - se, -lat, -along) };
                let lk = &self.g.links[link as usize];
                let mut mask = 0u8;
                for ln in 0..lk.lanes.min(8) {
                    if (self.g.lane_offset(lk, ln) - latl).abs() < LANE_W * 0.5 + r - 0.2 {
                        mask |= 1 << ln;
                    }
                }
                if mask == 0 {
                    continue;
                }
                let ob = ObLink { link, mask, s0: sl - r, s1: sl + r, v: v.max(0.0) };
                self.ob_links.push(ob);
                self.body_links.push(ob);
            }
        }
        if junctions {
            // standing in a junction box: conflicting paths wait
            for &eid in near.iter() {
                let e = &self.g.edges[eid as usize];
                if !e.alive {
                    continue;
                }
                for nd in [e.from, e.to] {
                    let nn = &self.g.nodes[nd as usize];
                    if nn.control == Control::Free || ((nn.x - x).hypot(nn.y - y) as f32) > nn.setback + 2.0 + r {
                        continue;
                    }
                    let zn = self.zone_of(nd);
                    if self.ob_box.iter().any(|b| b.0 == zn) {
                        continue;
                    }
                    let c = &self.g.nodes[zn as usize];
                    let pt = [(x - c.x) as f32, (y - c.y) as f32];
                    self.ob_box.push((zn, [pt; NS]));
                }
            }
        }
    }

    /// Player bodies as obstacles (called at the end of `set_obstacles`).
    pub(super) fn add_player_bodies(&mut self, near: &mut Vec<u32>) {
        self.body_links.clear();
        if let Some((e, n, z, r)) = self.walker {
            self.add_body(e, n, z, r, (0.0, 0.0), true, near);
        }
        if let (Some(p), Some(pi)) = (self.player.as_ref().filter(|p| !p.autopilot), self.player_index()) {
            let (x, y, z, h, v, vy) = (p.x, p.y, p.z, p.h, p.v, p.vy);
            let (hs, hc) = h.sin_cos();
            let vel = (v * hc - vy * hs, v * hs + vy * hc);
            let reach = (self.cars[pi].len * 0.5 - 1.0).max(0.5);
            for k in [-reach, 0.0, reach] {
                self.add_body(x + (hc * k) as f64, y + (hs * k) as f64, z, 1.05, vel, false, near);
            }
        }
    }

    /// [curb jolt (m/s across the curb), collision impulse (m/s), surface] since the last call
    pub fn player_events(&mut self) -> [f32; 3] {
        match self.player.as_mut() {
            None => [0.0, 0.0, 0.0],
            Some(p) => {
                let ev = [p.ev_curb, p.ev_hit, p.surface as f32];
                p.ev_curb = 0.0;
                p.ev_hit = 0.0;
                ev
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::tests::world_with_cross;

    #[test]
    fn handbrake_turn_slides_and_reverse_works() {
        let mut w = world_with_cross(0, [2, 2, 2, 2]);
        w.max_cars = 0;
        assert!(w.spawn_player(612.0, 505.0, 0.0));
        for _ in 0..150 {
            w.player_step(1.0 / 30.0, 1.0, 0.0, 0.0, false, 0.0);
        }
        let v0 = w.player.as_ref().unwrap().v;
        assert!(v0 > 15.0, "v={v0}");
        // hard left with the handbrake: the rear steps out (lateral slide)
        let mut slide = 0.0f32;
        for _ in 0..20 {
            w.player_step(1.0 / 30.0, 0.0, 0.0, 1.0, true, 0.0);
            slide = slide.max(w.player.as_ref().unwrap().vy.abs());
        }
        assert!(slide > 1.0, "slide {slide}");
        // stop, then reverse
        for _ in 0..200 {
            w.player_step(1.0 / 30.0, 0.0, 1.0, 0.0, false, 0.0);
        }
        let p = w.player.as_ref().unwrap();
        assert!(p.v < -2.0, "reverse v={}", p.v);
    }

    #[test]
    fn taken_over_car_stays_on_its_lane_until_driven() {
        let mut w = world_with_cross(0, [2, 2, 2, 2]);
        for _ in 0..300 {
            w.step(0.1);
        }
        w.write_cars(0.0, 0.0);
        let id = w.cars.iter().find(|c| c.flags & F_DEAD == 0 && c.v > 3.0).expect("a moving car").id;
        assert!(w.take_over(id));
        for _ in 0..40 {
            w.set_obstacles(&[]);
            w.step(0.1);
            w.write_cars(0.0, 0.0);
            w.player_step(0.1, 0.0, 0.0, 0.0, false, 0.0);
            let Some(c) = w.cars.iter().find(|c| c.id == id) else { break };
            let p = w.player.as_ref().unwrap();
            assert!(p.autopilot && c.flags & F_PLAYER == 0 && c.link != NONE);
            assert!((p.x - c.pose.x).abs() < 1e-6 && (p.y - c.pose.y).abs() < 1e-6);
        }
        if w.cars.iter().any(|c| c.id == id) {
            w.player_step(0.1, 1.0, 0.0, 0.0, false, 0.0);
            let p = w.player.as_ref().unwrap();
            assert!(!p.autopilot);
            assert!(w.cars.iter().find(|c| c.id == id).unwrap().flags & F_PLAYER != 0);
        }
    }

    #[test]
    fn cars_brake_for_the_walker() {
        let mut w = world_with_cross(0, [2, 2, 2, 2]);
        for _ in 0..300 {
            w.step(0.1);
        }
        // a car on some link, walker 25 m ahead of it in its lane
        let i = w.cars.iter().position(|c| c.flags & F_DEAD == 0 && c.v > 3.0 && w.g.links[c.link as usize].len - c.s > 40.0).expect("a moving car");
        let (link, lane, s, id) = (w.cars[i].link, w.cars[i].lane, w.cars[i].s, w.cars[i].id);
        let off = w.g.lane_offset(&w.g.links[link as usize], lane);
        let pose = w.g.link_pose(link, s + 25.0, off);
        w.set_walker(pose.x, pose.y, pose.z, 0.4, 0.1);
        for _ in 0..100 {
            w.set_obstacles(&[]);
            w.step(0.1);
            w.set_walker(pose.x, pose.y, pose.z, 0.4, 0.1);
        }
        let c = w.cars.iter().find(|c| c.id == id).expect("car still there");
        assert_eq!((c.link, c.lane), (link, lane), "car left its lane");
        assert!(c.s < s + 25.0 - 0.3, "car ran over the walker: s={} walker at {}", c.s, s + 25.0);
        assert!(c.v < 0.5, "car still moving at {}", c.v);
        assert!(!w.horns.is_empty(), "nobody honked");
    }
}
