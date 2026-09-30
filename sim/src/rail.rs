//! Rail vehicles as agents on the switch-level track graph (docs/RAIL.md).
//!
//! * `RailNet`   – the track graph from `data/rail/network.bin.gz`: edges with
//!   geometry and civil speed limits, movement rules at switches.
//! * resources  – every edge is cut into blocks (exclusive), every switch /
//!   diamond is an interlocking zone (exclusive; covers the fouling length of
//!   each arm) and every edge that loaded routes run in both directions carries
//!   a traffic-direction lock (shared by trains running the same way).
//! * `Plan`      – a GTFS pattern's route (from the pipeline) as the ordered
//!   list of resource *spans* it passes, grouped for atomic reservation: a
//!   junction is taken together with the blocks either side of it, and when a
//!   route enters a bidirectional run it locks the traffic direction of the
//!   whole run (so opposing trains never meet head-on / deadlock).
//! * `Train`     – consist on a plan: front position `front` (m along the
//!   route == along the pattern shape), speed, per-mode dynamics. It holds a
//!   *movement authority*: all spans from its tail up to the first span it
//!   could not reserve. It never passes the end of its authority (braking
//!   curves + a hard clamp), so two trains can never occupy the same block,
//!   junction or single-track run the wrong way -- collisions are impossible
//!   by construction.
//! * Scheduling: trips whose scheduled position is within the rail radius of
//!   the focus become agents (placed behind whatever occupies their block);
//!   they dwell at least the minimum time and never depart before the
//!   timetable; they are handed back to the timetable when they leave the
//!   radius. A trip that ends where the next trip of its vehicle block starts
//!   (same track, same or opposite direction) continues as that trip.
//! * One train can be driven by the player (throttle / brake from the UI,
//!   automatic train protection: running at a red / too fast for the
//!   authority applies the penalty brake to a stop).

use crate::graph::NONE;

/// mode ids (MODES in app/src/transit/format.ts)
pub const M_SUBWAY: u8 = 0;
pub const M_LRT: u8 = 1;
pub const M_STREETCAR: u8 = 2;
pub const M_COMMUTER: u8 = 3;
pub const M_AIRPORT: u8 = 4;
pub const M_INTERCITY: u8 = 5;

/// track kinds (e_kind)
pub const K_RAIL: u8 = 0;
pub const K_SUBWAY: u8 = 1;
pub const K_LRT: u8 = 2;
pub const K_TRAM: u8 = 3;

pub const N_SWITCH: u8 = 1;
pub const N_DIAMOND: u8 = 2;

/// floats per output record (see `write`)
pub const RAIL_STRIDE: usize = 12;
/// output flags
pub const RF_DWELL: u32 = 1;
pub const RF_DOORS: u32 = 2;
pub const RF_BRAKE: u32 = 4;
pub const RF_PLAYER: u32 = 8;
pub const RF_PENALTY: u32 = 16;
pub const RF_HELD: u32 = 32;
/// trip is managed by the rail sim but not (yet) placed: draw nothing
pub const RF_PENDING: u32 = 64;
/// sounding the horn (approaching a public level crossing)
pub const RF_HORN: u32 = 128;

/// Level crossing timing (Transport Canada Grade Crossings Standards: warning >= 20 s
/// before the train arrives, gates horizontal >= 5 s before; our gates take 8 s):
/// warning (lights, gates lowering) this long before arrival ...
pub const XING_WARN: f32 = 32.0;
/// ... gates down this long before arrival
pub const XING_DOWN: f32 = 21.0;
/// horn from this long before the crossing
pub const XING_HORN: f32 = 20.0;

pub struct Crossing {
    pub osm: f64,
    pub edge: u32,
    pub s: f32,
    pub x: f64,
    pub y: f64,
    /// 0 idle, 1 warning (lights, gates lowering), 2 gates down
    pub state: u8,
    pub changed: bool,
    /// last time a train was near (for the clear delay)
    pub last: f64,
}

/// s of ATP overspeed warning before the penalty brake (player)
const ATP_WARN: f32 = 3.0;
/// layovers longer than this (s) at a terminal with bays are spent in a bay
const BAY_LAYOVER: f64 = 150.0;
/// layovers longer than this (s) are spent in the depot
const LONG_LAYOVER: f64 = 1200.0;
const SP_BLOCK: u8 = 0;
const SP_JUNCTION: u8 = 1;
const SP_DIR: u8 = 2;

/// block length by track kind (m)
const BLOCK_LEN: [f32; 4] = [800.0, 150.0, 150.0, 120.0];
/// half length of an interlocking zone along each arm (fouling point), by kind
const FOUL: [f32; 4] = [55.0, 35.0, 28.0, 11.0];

#[derive(Clone, Copy, Debug)]
pub struct Dyn {
    /// max traction acceleration at low speed (m/s2)
    pub a0: f32,
    /// power limit: a <= p / v
    pub p: f32,
    /// service / emergency brake (m/s2)
    pub b: f32,
    pub be: f32,
    /// jerk limit (m/s3)
    pub j: f32,
    pub vmax: f32,
    /// stop before the end of the authority (m)
    pub margin: f32,
    /// minimum dwell (s)
    pub dwell: f32,
}

pub fn dyn_for(mode: u8) -> Dyn {
    match mode {
        // TTC TR / T1
        M_SUBWAY => Dyn { a0: 1.1, p: 18.0, b: 1.1, be: 1.6, j: 0.9, vmax: 24.4, margin: 8.0, dwell: 18.0 },
        // Flexity Freedom (Line 5) / Citadis Spirit (Line 6)
        M_LRT => Dyn { a0: 1.2, p: 16.0, b: 1.3, be: 2.5, j: 1.0, vmax: 22.2, margin: 6.0, dwell: 15.0 },
        // Flexity Outlook
        M_STREETCAR => Dyn { a0: 1.2, p: 14.0, b: 1.3, be: 2.8, j: 1.2, vmax: 19.4, margin: 4.0, dwell: 10.0 },
        // MP40PH-3C + 12 BiLevels (~730 t, 3 MW at rail)
        M_COMMUTER => Dyn { a0: 0.45, p: 4.2, b: 0.6, be: 1.0, j: 0.35, vmax: 41.7, margin: 15.0, dwell: 40.0 },
        // UP Express Nippon Sharyo DMU
        M_AIRPORT => Dyn { a0: 0.8, p: 9.0, b: 0.8, be: 1.3, j: 0.6, vmax: 36.1, margin: 12.0, dwell: 35.0 },
        // VIA Charger + Venture
        _ => Dyn { a0: 0.5, p: 6.0, b: 0.7, be: 1.2, j: 0.4, vmax: 44.4, margin: 15.0, dwell: 60.0 },
    }
}

impl Dyn {
    #[inline]
    pub fn amax(&self, v: f32) -> f32 {
        self.a0.min(self.p / v.max(0.1))
    }
}

// ============================================================================ network

#[derive(Default)]
pub struct RailNet {
    pub n_xyz: Vec<[f64; 3]>,
    pub n_flags: Vec<u8>,
    pub e_from: Vec<u32>,
    pub e_to: Vec<u32>,
    pub e_off: Vec<u32>,
    pub v_xyz: Vec<[f64; 3]>,
    /// horizontal distance of each vertex from its edge's start
    pub v_cum: Vec<f32>,
    /// speed limit (m/s) of the segment starting at the vertex
    pub v_lim: Vec<f32>,
    pub e_len: Vec<f32>,
    pub e_kind: Vec<u8>,
    pub e_svc: Vec<u8>,
    pub e_dir: Vec<u8>,
    pub e_flags: Vec<u8>,
    pub c_off: Vec<u32>,
    pub c_to: Vec<u32>,
    // resources
    pub blk_off: Vec<u32>,
    pub blk_res: Vec<u32>,
    pub junc_res: Vec<u32>,
    pub dir_res: Vec<u32>,
    pub n_res: u32,
}

impl RailNet {
    #[allow(clippy::too_many_arguments)]
    pub fn load(
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
    ) -> RailNet {
        let nn = n_flags.len();
        let ne = e_from.len();
        let mut net = RailNet {
            n_xyz: (0..nn).map(|i| [n_xyz[i * 3] as f64, n_xyz[i * 3 + 1] as f64, n_xyz[i * 3 + 2] as f64]).collect(),
            n_flags: n_flags.to_vec(),
            e_from: e_from.to_vec(),
            e_to: e_to.to_vec(),
            e_off: e_off.to_vec(),
            v_xyz: e_xyz.chunks_exact(3).map(|c| [c[0] as f64, c[1] as f64, c[2] as f64]).collect(),
            v_cum: vec![0.0; e_xyz.len() / 3],
            v_lim: e_vlim.iter().map(|&v| v as f32 * 0.5).collect(),
            e_len: e_len.to_vec(),
            e_kind: e_kind.to_vec(),
            e_svc: e_svc.to_vec(),
            e_dir: e_dir.to_vec(),
            e_flags: e_flags.to_vec(),
            c_off: c_off.to_vec(),
            c_to: c_to.to_vec(),
            ..Default::default()
        };
        for e in 0..ne {
            let (a, b) = (net.e_off[e] as usize, net.e_off[e + 1] as usize);
            let mut acc = 0.0f64;
            for v in a..b {
                if v > a {
                    let (p, q) = (net.v_xyz[v - 1], net.v_xyz[v]);
                    acc += (q[0] - p[0]).hypot(q[1] - p[1]);
                }
                net.v_cum[v] = acc as f32;
            }
            // lengths from the geometry itself (exactly consistent with positions)
            if b > a {
                net.e_len[e] = acc as f32;
            }
        }
        // resources
        let mut r = 0u32;
        net.blk_off.push(0);
        for e in 0..ne {
            let k = (net.e_kind[e] as usize).min(3);
            let n = ((net.e_len[e] / BLOCK_LEN[k]).ceil() as u32).max(1);
            for _ in 0..n {
                net.blk_res.push(r);
                r += 1;
            }
            net.blk_off.push(net.blk_res.len() as u32);
        }
        net.junc_res = vec![NONE; nn];
        for (n, f) in net.n_flags.iter().enumerate() {
            if f & (N_SWITCH | N_DIAMOND) != 0 {
                net.junc_res[n] = r;
                r += 1;
            }
        }
        net.dir_res = (0..ne).map(|i| r + i as u32).collect();
        r += ne as u32;
        net.n_res = r;
        net
    }

    #[inline]
    pub fn blocks(&self, e: usize) -> (usize, usize) {
        (self.blk_off[e] as usize, self.blk_off[e + 1] as usize)
    }

    /// point at distance `s` from the start of edge `e`
    pub fn point(&self, e: usize, s: f32) -> [f64; 3] {
        let (a, b) = (self.e_off[e] as usize, self.e_off[e + 1] as usize);
        if b <= a + 1 {
            return self.v_xyz[a];
        }
        let cum = &self.v_cum[a..b];
        let s = s.clamp(0.0, cum[cum.len() - 1]);
        let i = cum.partition_point(|&c| c <= s).clamp(1, cum.len() - 1) - 1;
        let d = cum[i + 1] - cum[i];
        let t = if d > 1e-6 { ((s - cum[i]) / d) as f64 } else { 0.0 };
        let (p, q) = (self.v_xyz[a + i], self.v_xyz[a + i + 1]);
        [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t]
    }

    /// movement allowed: leaving edge-end `end_out` into edge-end `end_in` (2*e + k)
    pub fn can_move(&self, end_out: u32, end_in: u32) -> bool {
        let (a, b) = (self.c_off[end_out as usize] as usize, self.c_off[end_out as usize + 1] as usize);
        self.c_to[a..b].contains(&end_in)
    }
}

// ============================================================================ plans

#[derive(Clone, Copy, Debug)]
pub struct Span {
    pub r0: f32,
    pub r1: f32,
    pub res: u32,
    pub kind: u8,
    /// travel direction on the edge (dir locks)
    pub dir: i8,
    /// acquisition group: spans [g0, g1)
    pub g0: u32,
    pub g1: u32,
    /// dir locks: last span index (inclusive) of the bidirectional run this lock belongs to
    pub chain_end: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct Item {
    pub edge: u32,
    pub dir: i8,
    /// route distance of the edge's travel-start end
    pub base: f32,
}

pub struct Plan {
    pub feed: u32,
    pub local: u32,
    pub mode: u8,
    pub len: f32,
    pub ok: bool,
    pub items: Vec<Item>,
    pub length: f32,
    pub spans: Vec<Span>,
    /// speed limit pieces (route distance where it starts, m/s)
    pub vlim: Vec<(f32, f32)>,
    /// stops: consist-front stop position and flags (1 = virtual pass-through)
    pub stop_front: Vec<f32>,
    pub stop_centre: Vec<f32>,
    pub stop_flag: Vec<u8>,
    /// route distance minus pattern-shape distance (0 for pattern plans; NaN for
    /// turnback legs that are not on the pattern)
    pub pshift: f32,
    /// safe stopping points: consist-front positions where the whole body stands on plain
    /// track (no junction zone, no two-way stretch); routes are set from one to the next
    pub ssp: Vec<f32>,
}

impl Plan {
    /// (edge, s on edge, dir) at route distance r
    pub fn locate(&self, net: &RailNet, r: f32) -> (u32, f32, i8) {
        let i = self.items.partition_point(|it| it.base <= r).max(1) - 1;
        let it = self.items[i];
        let l = net.e_len[it.edge as usize];
        let along = (r - it.base).clamp(0.0, l);
        (it.edge, if it.dir > 0 { along } else { l - along }, it.dir)
    }

    pub fn point(&self, net: &RailNet, r: f32) -> [f64; 3] {
        let (e, s, _) = self.locate(net, r);
        net.point(e as usize, s)
    }

    /// route distance where the plan passes (edge, s) travelling `dir` (±1), if it does
    pub fn find(&self, net: &RailNet, edge: u32, s: f32, dir: i8) -> Option<f32> {
        for it in &self.items {
            if it.edge == edge && it.dir == dir {
                let l = net.e_len[edge as usize];
                let along = if dir > 0 { s } else { l - s };
                let r = it.base + along;
                if r >= -1.0 && r <= self.length + 1.0 {
                    return Some(r);
                }
            }
        }
        None
    }

    /// civil limit over [a, b]
    pub fn limit_over(&self, a: f32, b: f32) -> f32 {
        let mut i = self.vlim.partition_point(|p| p.0 <= a).max(1) - 1;
        let mut v = f32::INFINITY;
        while i < self.vlim.len() && self.vlim[i].0 <= b {
            v = v.min(self.vlim[i].1);
            i += 1;
        }
        v
    }
}

/// signalled (block + interlocking) modes; streetcars run on sight (road integration)
#[inline]
pub fn signalled(mode: u8) -> bool {
    mode != M_STREETCAR
}

pub fn build_plan(net: &RailNet, feed: u32, local: u32, mode: u8, len: f32, ok: bool, start: f32, edges: &[u32], stop_centre: &[f32], stop_flag: &[u8], bidir: &[u8]) -> Plan {
    let mut items = Vec::with_capacity(edges.len());
    let mut r = -start;
    let ne = net.e_from.len() as u32;
    let mut ok = ok && !edges.is_empty();
    for &x in edges {
        let e = x >> 1;
        if e >= ne {
            ok = false;
            break;
        }
        let dir = if x & 1 == 0 { 1 } else { -1 };
        items.push(Item { edge: e, dir, base: r });
        r += net.e_len[e as usize];
    }
    // route end = last stop front (the shape ends there)
    let n = stop_centre.len();
    let stop_front: Vec<f32> = (0..n).map(|k| if stop_flag[k] & 1 != 0 { stop_centre[k] } else { stop_centre[k] + len * 0.5 }).collect();
    let length = stop_front.last().copied().unwrap_or(0.0).min(r.max(0.0));
    // connectivity check
    for w in items.windows(2) {
        let (a, b) = (w[0], w[1]);
        let out = 2 * a.edge + if a.dir > 0 { 1 } else { 0 };
        let inn = 2 * b.edge + if b.dir > 0 { 0 } else { 1 };
        if !net.can_move(out, inn) {
            ok = false;
        }
    }
    let mut spans: Vec<Span> = Vec::new();
    let mut vlim: Vec<(f32, f32)> = Vec::new();
    let sig = signalled(mode);
    let mk = |r0: f32, r1: f32, res: u32, kind: u8, dir: i8| Span { r0, r1, res, kind, dir, g0: 0, g1: 0, chain_end: 0 };
    for (i, it) in items.iter().enumerate() {
        let e = it.edge as usize;
        let l = net.e_len[e];
        let kind = (net.e_kind[e] as usize).min(3);
        // blocks (on-sight modes reserve only junctions and single-track runs)
        let (b0, b1) = net.blocks(e);
        let nb = (b1 - b0) as f32;
        // a two-way track: used both ways by timetabled routes, or run against the way they
        // use it (an empty-stock move running wrong-road): every train on it takes the
        // direction lock, and routes are set across it as a whole
        let ub = bidir.get(e).copied().unwrap_or(0);
        // (streetcars run on sight: an empty car running a street track the wrong way is
        // handled by sight, it does not make the street a single line)
        let two_way = ub == 3 || (sig && ub != 0 && ub & if it.dir > 0 { 1 } else { 2 } == 0);
        if sig || two_way {
            for k in b0..b1 {
                let (sa, sb) = ((k - b0) as f32 * l / nb, (k - b0 + 1) as f32 * l / nb);
                let (xa, xb) = if it.dir > 0 { (sa, sb) } else { (l - sb, l - sa) };
                let (r0, r1) = ((it.base + xa).max(0.0), (it.base + xb).min(length));
                if r1 > r0 + 1e-3 {
                    spans.push(mk(r0, r1, net.blk_res[k], SP_BLOCK, it.dir));
                }
            }
        }
        if two_way {
            let (r0, r1) = (it.base.max(0.0), (it.base + l).min(length));
            if r1 > r0 + 1e-3 {
                spans.push(mk(r0, r1, net.dir_res[e], SP_DIR, it.dir));
            }
        }
        // junction at the start of the first item / end of every item
        let foul = FOUL[kind];
        let junc = |node: u32, at: f32, spans: &mut Vec<Span>| {
            let jr = net.junc_res[node as usize];
            if jr != NONE {
                let (r0, r1) = ((at - foul).max(0.0), (at + foul).min(length));
                if r1 > r0 + 1e-3 {
                    spans.push(mk(r0, r1, jr, SP_JUNCTION, 0));
                }
            }
        };
        let (n_start, n_end) = if it.dir > 0 { (net.e_from[e], net.e_to[e]) } else { (net.e_to[e], net.e_from[e]) };
        if i == 0 {
            junc(n_start, it.base, &mut spans);
        }
        junc(n_end, it.base + l, &mut spans);
        // speed limit pieces
        let (a, b) = (net.e_off[e] as usize, net.e_off[e + 1] as usize);
        if b > a + 1 {
            for v in a..b - 1 {
                let (sa, sb) = (net.v_cum[v], net.v_cum[v + 1]);
                let x = if it.dir > 0 { sa } else { l - sb };
                let rr = it.base + x;
                vlim.push((rr, net.v_lim[v].max(2.0)));
            }
        }
    }
    vlim.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    if vlim.is_empty() {
        vlim.push((f32::NEG_INFINITY, 10.0));
    } else {
        vlim[0].0 = f32::NEG_INFINITY;
    }
    spans.sort_by(|a, b| a.r0.partial_cmp(&b.r0).unwrap_or(std::cmp::Ordering::Equal).then(a.kind.cmp(&b.kind)));
    // groups: spans that overlap (a junction zone binds the blocks either side of it, and
    // chains of junctions form one interlocking); direction locks join the group of the
    // blocks they start in but never extend it
    let ns = spans.len();
    let mut i = 0;
    while i < ns {
        let mut j = i + 1;
        // only junction zones extend a group: the authority may end at any block boundary
        // outside an interlocking, never inside one
        let mut hi = if spans[i].kind == SP_JUNCTION { spans[i].r1 } else { spans[i].r0 + 0.02 };
        while j < ns && spans[j].r0 < hi - 0.01 {
            if spans[j].kind == SP_JUNCTION {
                hi = hi.max(spans[j].r1);
            }
            j += 1;
        }
        for s in spans.iter_mut().take(j).skip(i) {
            s.g0 = i as u32;
            s.g1 = j as u32;
        }
        i = j;
    }
    // dir-lock runs: consecutive dir spans without a gap
    let dirs: Vec<usize> = (0..ns).filter(|&k| spans[k].kind == SP_DIR).collect();
    let mut k = 0;
    while k < dirs.len() {
        let mut m = k;
        while m + 1 < dirs.len() && spans[dirs[m + 1]].r0 <= spans[dirs[m]].r1 + 1.0 {
            m += 1;
        }
        for q in k..=m {
            spans[dirs[q]].chain_end = dirs[m] as u32;
        }
        k = m + 1;
    }
    // safe stopping points: block ends, stops, junction exits (where a body just clears the
    // zone) and the end of the plan, kept where the body behind them is plain
    let body = len.max(10.0) + 5.0;
    let mut cand: Vec<f32> = Vec::new();
    for s in &spans {
        match s.kind {
            SP_BLOCK => cand.push(s.r1),
            SP_JUNCTION => cand.push(s.r1 + body),
            _ => {}
        }
    }
    cand.extend(stop_front.iter().copied());
    cand.push(length);
    // (a two-way stretch is entered with its direction lock for the whole run, so trains may
    // follow each other block by block inside it: only junction zones are hard)
    let hard: Vec<(f32, f32)> = spans.iter().filter(|s| s.kind == SP_JUNCTION).map(|s| (s.r0, s.r1)).collect();
    let mut ssp: Vec<f32> = cand
        .into_iter()
        .filter(|&f| f > 0.0 && f <= length + 0.01)
        .filter(|&f| f >= length - 0.01 || !hard.iter().any(|&(a, b)| a < f - 0.01 && b > f - body))
        .collect();
    ssp.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    ssp.dedup_by(|a, b| (*a - *b).abs() < 0.5);
    Plan { feed, local, mode, len, ok, items, length, spans, vlim, stop_front, stop_centre: stop_centre.to_vec(), stop_flag: stop_flag.to_vec(), pshift: 0.0, ssp }
}

// ============================================================================ feeds / schedule

pub struct Feed {
    pub id: u32,
    pub plan0: u32,
    pub pat_mode: Vec<u8>,
    pub stop_off: Vec<u32>,
    pub trip_start: Vec<i32>,
    pub trip_pattern: Vec<u32>,
    pub trip_tp: Vec<u32>,
    pub trip_next: Vec<i32>,
    pub trip_end: Vec<i32>,
    pub tp_off: Vec<u32>,
    pub tp_arr: Vec<u16>,
    pub tp_dwell: Vec<u16>,
    pub max_dur: i32,
    /// previous trip of the same vehicle block (-1 none)
    pub trip_prev: Vec<i32>,
    // raw route data (plans are rebuilt when feeds change)
    pat_len: Vec<f32>,
    pat_rflags: Vec<u8>,
    pat_rstart: Vec<f32>,
    pat_redge_off: Vec<u32>,
    pat_redge: Vec<u32>,
    stop_dist: Vec<f32>,
    stop_flag: Vec<u8>,
}

/// accel for the trapezoid used by the schedule tier (app/src/transit/motion.ts MODE_ACCEL)
const MODE_ACCEL: [f32; 7] = [1.0, 1.0, 1.1, 0.6, 0.8, 0.5, 1.2];

/// position along a segment of length L done in T s at tau (see motion.ts segmentMotion)
pub fn segment_motion(l: f32, t: f32, tau: f32, a: f32, linear: bool) -> (f32, f32) {
    if t <= 0.0 || l <= 0.0 {
        return (l.max(0.0), 0.0);
    }
    if tau <= 0.0 {
        return (0.0, if linear { l / t } else { 0.0 });
    }
    if tau >= t {
        return (l, if linear { l / t } else { 0.0 });
    }
    if linear {
        return (l * tau / t, l / t);
    }
    let mut a = a;
    let need = 4.5 * l / (t * t);
    if need > a {
        if need > 2.5 * a {
            return (l * tau / t, l / t);
        }
        a = need;
    }
    let disc = a * a * t * t - 4.0 * a * l;
    let v = (a * t - disc.max(0.0).sqrt()) / 2.0;
    let ta = v / a;
    if tau < ta {
        (0.5 * a * tau * tau, a * tau)
    } else if tau <= t - ta {
        (0.5 * a * ta * ta + v * (tau - ta), v)
    } else {
        let r = t - tau;
        (l - 0.5 * a * r * r, a * r)
    }
}

impl Feed {
    #[inline]
    fn times(&self, trip: usize, k: usize) -> (f64, f64) {
        let q = self.trip_tp[trip] as usize;
        let i = self.tp_off[q] as usize + k;
        let arr = self.trip_start[trip] as f64 + self.tp_arr[i] as f64;
        (arr, arr + self.tp_dwell[i] as f64)
    }
}

// ============================================================================ trains

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TState {
    Run,
    Dwell,
    /// at its last stop
    Terminal,
    /// stabled in a depot / yard (no trip)
    Parked,
}

pub struct Train {
    pub id: u32,
    pub feed: u32,
    pub trip: u32,
    pub plan: u32,
    pub front: f32,
    pub v: f32,
    pub a: f32,
    pub len: f32,
    pub dy: Dyn,
    pub held: Vec<bool>,
    /// first span not yet reserved (spans before it are held or released)
    pub next: usize,
    /// first span that may still be held
    pub lo: usize,
    pub ma: f32,
    pub stop: usize,
    pub state: TState,
    pub until: f64,
    pub since: f64,
    pub delay: f32,
    pub player: bool,
    pub penalty: bool,
    /// time spent stopped short of the authority's end (s)
    pub held_t: f32,
    pub dead: bool,
    /// player controls (-1 full brake .. 1 full power), emergency
    pub cmd: f32,
    pub emerg: bool,
    /// added to the sim's service time for this train's timetable (previous-day trips)
    pub toff: f64,
    /// empty-stock move (turnback between trips): no timetable, short reversal stops
    pub dh: bool,
    /// further legs of a turnback (plan indices), each entered by changing ends
    pub legs: Vec<u32>,
    /// ATP warning time (player): the penalty brake applies if not corrected in time
    pub warn: f32,
    /// on-sight constraint from outside the rail sim (road traffic / red signals, set by
    /// the caller before `step`): distance ahead of the front and speed there
    pub ext_gap: f32,
    pub ext_v: f32,
    /// on-sight following: gap to the vehicle ahead on the same track and its speed
    pub sight_gap: f32,
    pub sight_v: f32,
    /// the vehicle the on-sight gap is measured to (NONE)
    pub sight_id: u32,
    /// depot it is parked in / heading for (NONE otherwise)
    pub depot: u32,
    pub horn: bool,
    /// service time until which the train does not reserve further ahead (lock breaker)
    pub backoff_until: f64,
    /// time stopped while running (any cause: authority, on-sight gap, ...)
    pub stopped_t: f32,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum TripState {
    None,
    Agent(u32),
    Pending(f64),
    /// handed back to the timetable (left the radius)
    Done,
    /// its vehicle finished it in the sim (arrived, continued as another trip, stabled):
    /// not drawn from the timetable any more
    Finished,
}

#[derive(Clone, Copy, Default)]
struct DirLock {
    dir: i8,
    count: u16,
}

/// A depot / yard / layover: storage tracks where trains are stabled between blocks.
pub struct Depot {
    pub group: u8,
    /// feeds (agencies) that use it (bit per feed id)
    pub feeds: u32,
    pub edges: Vec<u32>,
    pub x: f64,
    pub y: f64,
    /// parked trains have been placed since it came into the radius
    pub filled: bool,
    /// representative (feed index, pattern local, consist length, mode) for parked trains
    pub rep: Option<(u32, u32, f32, u8)>,
    /// a layover bay of a terminal loop (its loop / siding tracks): cars ending a trip wait
    /// here for their next one; never filled with stored cars
    pub bay: bool,
}

#[inline]
pub fn track_group(kind: u8) -> u8 {
    match kind {
        K_RAIL => 0,
        K_SUBWAY => 1,
        K_LRT => 2,
        _ => 3,
    }
}

#[inline]
pub fn mode_group(mode: u8) -> u8 {
    match mode {
        M_SUBWAY => 1,
        M_LRT => 2,
        M_STREETCAR => 3,
        _ => 0,
    }
}

pub struct RailSim {
    pub net: RailNet,
    pub feeds: Vec<Feed>,
    pub plans: Vec<Plan>,
    pub trains: Vec<Train>,
    owner: Vec<u32>,
    dirs: Vec<DirLock>,
    /// per feed, per trip
    pub trip_state: Vec<Vec<TripState>>,
    pub radius: f64,
    pub focus: (f64, f64),
    pub tod: f64,
    pub out: Vec<f32>,
    /// body polylines (rear -> front, 3 floats per point, relative to the output origin)
    pub out_path: Vec<f32>,
    next_id: u32,
    dirty: bool,
    spawn_acc: f32,
    pub enabled: bool,
    /// safety statistics (must stay 0): body overlaps found by `check`, authority overruns
    pub overlaps: u32,
    /// trains removed by the deadlock valve (held 10 min) inside the radius, and where
    pub stuck_removed: u32,
    /// empty-stock moves removed to break a head-on lock with a waiting train
    pub dh_yield: u32,
    /// cars that went to a layover bay
    pub bay_pullins: u32,
    /// layover bays of the terminal loops have been found for the loaded feeds
    bays_built: bool,
    /// trips whose car lays over in a bay before them (they pull out of it)
    bay_trips: std::collections::HashSet<(u32, u32)>,
    /// trip plans extended back to where a train stands (chain onto a trip starting just ahead)
    ext_cache: std::collections::HashMap<(u32, u32), u32>,
    /// deadlock cycles broken (back-offs and empty trains taken out)
    pub locks_broken: u32,
    pub stuck_log: Vec<String>,
    pub overruns: u32,
    pub player: Option<u32>,
    /// train being ridden (camera attached): never retired or handed back (NONE = none)
    pub keep: u32,
    pub hash: String,
    /// service-day seconds (4 am rollover, like the renderer's clock.serviceDay())
    pub stime: f64,
    bidir: Vec<u8>,
    /// turnback legs between the end of plan A and the start of plan B
    dh_cache: std::collections::HashMap<(u32, u32), Option<Vec<u32>>>,
    /// number of plans built from patterns (turnback plans follow)
    n_pat_plans: usize,
    /// resources used by timetabled routes (parking places must avoid them)
    service_res: Vec<bool>,
    /// empty-stock move to a siding from the end of a plan
    stable_cache: std::collections::HashMap<u32, Option<u32>>,
    pub depots: Vec<Depot>,
    /// park plans: (depot edge, consist length in dm) -> plan
    park_cache: std::collections::HashMap<(u32, u32), Option<u32>>,
    /// pull-outs tried recently: (feed, trip) -> time
    pullout_tried: std::collections::HashMap<(u32, u32), f64>,
    pub pullouts: u32,
    /// level-crossing closures (gates down) since reset
    pub xing_closures: u32,
    pub pullins: u32,
    /// trips placed from the timetable well inside the radius (after start-up: pops)
    pub spawned_inside: u32,
    pub spawned_first: u32,
    /// pull-out failures: no depot, depot outside radius, no free place, place failed, no path
    pub po_fail: [u32; 5],
    pub po_last: [u32; 5],
    pub pop_log: Vec<String>,
    /// camera (x, y, forward x, forward y); None = unknown (tests)
    pub camera: Option<(f64, f64, f64, f64)>,
    pub crossings: Vec<Crossing>,
    /// crossings each plan passes: (crossing index, route distance)
    plan_xings: std::collections::HashMap<u32, Vec<(u32, f32)>>,
    xing_by_edge: std::collections::HashMap<u32, Vec<u32>>,
    pub turnbacks: u32,
}

impl Default for RailSim {
    fn default() -> Self {
        RailSim {
            net: RailNet::default(),
            feeds: Vec::new(),
            plans: Vec::new(),
            trains: Vec::new(),
            owner: Vec::new(),
            dirs: Vec::new(),
            trip_state: Vec::new(),
            radius: 9000.0,
            focus: (0.0, 0.0),
            tod: 0.0,
            out: Vec::new(),
            out_path: Vec::new(),
            next_id: 1,
            dirty: false,
            spawn_acc: 1e9,
            enabled: true,
            overlaps: 0,
            stuck_removed: 0,
            dh_yield: 0,
            bay_pullins: 0,
            bays_built: false,
            bay_trips: std::collections::HashSet::new(),
            ext_cache: std::collections::HashMap::new(),
            locks_broken: 0,
            stuck_log: Vec::new(),
            overruns: 0,
            player: None,
            keep: NONE,
            hash: String::new(),
            stime: 0.0,
            bidir: Vec::new(),
            dh_cache: std::collections::HashMap::new(),
            n_pat_plans: 0,
            service_res: Vec::new(),
            stable_cache: std::collections::HashMap::new(),
            depots: Vec::new(),
            park_cache: std::collections::HashMap::new(),
            pullout_tried: std::collections::HashMap::new(),
            pullouts: 0,
            xing_closures: 0,
            pullins: 0,
            spawned_inside: 0,
            spawned_first: 0,
            po_fail: [0; 5],
            po_last: [0; 5],
            pop_log: Vec::new(),
            camera: None,
            crossings: Vec::new(),
            plan_xings: std::collections::HashMap::new(),
            xing_by_edge: std::collections::HashMap::new(),
            turnbacks: 0,
        }
    }
}

impl RailSim {
    pub fn set_net(&mut self, net: RailNet) {
        self.clear_trains();
        self.owner = vec![NONE; net.n_res as usize];
        self.dirs = vec![DirLock::default(); net.n_res as usize];
        self.net = net;
        self.dirty = true;
    }

    #[allow(clippy::too_many_arguments)]
    pub fn add_feed(
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
        self.feeds.retain(|f| f.id != id);
        let nt = trip_start.len();
        let mut trip_end = vec![0i32; nt];
        let mut max_dur = 0;
        for t in 0..nt {
            let q = trip_tp[t] as usize;
            let last = tp_off[q + 1] as usize - 1;
            trip_end[t] = trip_start[t] + tp_arr[last] as i32;
            max_dur = max_dur.max(tp_arr[last] as i32);
        }
        self.feeds.push(Feed {
            id,
            plan0: 0,
            pat_mode: pat_mode.to_vec(),
            stop_off: pat_stop_off.to_vec(),
            trip_start: trip_start.to_vec(),
            trip_pattern: trip_pattern.to_vec(),
            trip_tp: trip_tp.to_vec(),
            trip_next: if trip_next.len() == nt { trip_next.to_vec() } else { vec![-1; nt] },
            trip_end,
            tp_off: tp_off.to_vec(),
            tp_arr: tp_arr.to_vec(),
            tp_dwell: tp_dwell.to_vec(),
            max_dur,
            trip_prev: {
                let mut pv = vec![-1i32; nt];
                if trip_next.len() == nt {
                    for (i, &n) in trip_next.iter().enumerate() {
                        if n >= 0 && (n as usize) < nt {
                            pv[n as usize] = i as i32;
                        }
                    }
                }
                pv
            },
            pat_len: pat_len.to_vec(),
            pat_rflags: pat_rflags.to_vec(),
            pat_rstart: pat_rstart.to_vec(),
            pat_redge_off: pat_redge_off.to_vec(),
            pat_redge: pat_redge.to_vec(),
            stop_dist: pat_stop_dist.to_vec(),
            stop_flag: pat_stop_flag.to_vec(),
        });
        self.dirty = true;
    }

    pub fn clear_feeds(&mut self) {
        self.clear_trains();
        self.feeds.clear();
        self.plans.clear();
        self.trip_state.clear();
        self.dirty = true;
    }

    pub fn clear_trains(&mut self) {
        self.trains.clear();
        for o in self.owner.iter_mut() {
            *o = NONE;
        }
        for d in self.dirs.iter_mut() {
            *d = DirLock::default();
        }
        for ts in self.trip_state.iter_mut() {
            for s in ts.iter_mut() {
                *s = TripState::None;
            }
        }
        self.player = None;
        for d in self.depots.iter_mut() {
            d.filled = false;
        }
    }

    /// (re)build the plans after the network or the feeds changed
    /// pattern plans of every feed (plan0 set, trip states reset)
    fn build_pattern_plans(&mut self, bidir: &[u8]) {
        self.trip_state.clear();
        for fi in 0..self.feeds.len() {
            let plan0 = self.plans.len() as u32;
            let f = &self.feeds[fi];
            let mut plans = Vec::with_capacity(f.pat_mode.len());
            for p in 0..f.pat_mode.len() {
                let (so, sn) = (f.stop_off[p] as usize, f.stop_off[p + 1] as usize);
                let edges = &f.pat_redge[f.pat_redge_off[p] as usize..f.pat_redge_off[p + 1] as usize];
                plans.push(build_plan(
                    &self.net,
                    f.id,
                    p as u32,
                    f.pat_mode[p],
                    f.pat_len[p],
                    f.pat_rflags[p] & 1 != 0,
                    f.pat_rstart[p],
                    edges,
                    &f.stop_dist[so..sn],
                    &f.stop_flag[so..sn],
                    bidir,
                ));
            }
            self.plans.extend(plans);
            let nt = self.feeds[fi].trip_start.len();
            self.feeds[fi].plan0 = plan0;
            self.trip_state.push(vec![TripState::None; nt]);
        }
    }

    fn rebuild(&mut self) {
        self.dirty = false;
        self.clear_trains();
        self.plans.clear();
        let ne = self.net.e_from.len();
        if ne == 0 {
            return;
        }
        // edges that loaded routes use in both directions
        let mut used = vec![0u8; ne];
        for f in &self.feeds {
            for p in 0..f.pat_mode.len() {
                // every routed pattern counts (also ones routed with a gap: their trains run)
                if f.pat_rflags[p] & 3 == 0 {
                    continue;
                }
                for &x in &f.pat_redge[f.pat_redge_off[p] as usize..f.pat_redge_off[p + 1] as usize] {
                    let e = (x >> 1) as usize;
                    if e < ne {
                        used[e] |= if x & 1 == 0 { 1 } else { 2 };
                    }
                }
            }
        }
        // per edge: the directions timetabled routes run it (bit 1 forward, bit 2 backward)
        let bidir: Vec<u8> = used.clone();
        self.bidir = bidir.clone();
        self.dh_cache.clear();
        self.ext_cache.clear();
        self.stable_cache.clear();
        self.park_cache.clear();
        self.pullout_tried.clear();
        self.plan_xings.clear();
        for d in self.depots.iter_mut() {
            d.filled = false;
            d.rep = None;
        }
        self.build_pattern_plans(&bidir);
        // empty-stock turnbacks between the trips of each vehicle block may run a track the
        // wrong way (terminal reversals): those tracks are two-way too, so every train on them
        // takes the direction lock (a route is only granted when no one comes the other way)
        let mut used2 = used.clone();
        let mut pairs: Vec<(usize, usize)> = Vec::new();
        for f in &self.feeds {
            for t in 0..f.trip_next.len() {
                let nx = f.trip_next[t];
                if nx < 0 {
                    continue;
                }
                let (pa, pb) = ((f.plan0 + f.trip_pattern[t]) as usize, (f.plan0 + f.trip_pattern[nx as usize]) as usize);
                if pa != pb && !pairs.contains(&(pa, pb)) {
                    pairs.push((pa, pb));
                }
            }
        }
        self.n_pat_plans = self.plans.len();
        for (pa, pb) in pairs {
            if !self.plans[pa].ok || !self.plans[pb].ok {
                continue;
            }
            if let Some(legs) = self.plan_turnback(pa, pb) {
                for l in legs {
                    for it in &self.plans[l as usize].items {
                        let e = it.edge as usize;
                        if e < ne {
                            used2[e] |= if it.dir > 0 { 1 } else { 2 };
                        }
                    }
                }
            }
        }
        if used2 != used && std::env::var("NO_TWOPASS").is_err() {
            let bidir: Vec<u8> = used2.clone();
            self.bidir = bidir.clone();
            self.plans.clear();
            self.dh_cache.clear();
            self.build_pattern_plans(&bidir);
        } else {
            let n = self.n_pat_plans;
            self.plans.truncate(n);
            self.dh_cache.clear();
        }
        self.n_pat_plans = self.plans.len();
        // resources the timetabled routes run through: a parked train must never stand on one
        let mut sr = vec![false; self.owner.len()];
        for p in &self.plans {
            if !p.ok {
                continue;
            }
            for sp in &p.spans {
                if sp.kind != SP_DIR && (sp.res as usize) < sr.len() {
                    sr[sp.res as usize] = true;
                }
            }
        }
        self.service_res = sr;
    }

    // ------------------------------------------------------------------ resources

    fn span_free(&self, sp: &Span, me: u32) -> bool {
        match sp.kind {
            SP_DIR => {
                let d = self.dirs[sp.res as usize];
                d.count == 0 || d.dir == sp.dir
            }
            _ => {
                let o = self.owner[sp.res as usize];
                o == NONE || o == me
            }
        }
    }

    /// reserve span group starting at `gi` (plus the direction locks of any
    /// bidirectional run it touches) atomically for train `ti`
    /// The route train `ti` needs to get past span `k`: every span not yet held from `k` up to
    /// the next safe stopping point beyond it (whole berth included), and that point.
    fn route_spans(&self, ti: usize, k: usize) -> (Vec<usize>, f32) {
        let t = &self.trains[ti];
        let plan = &self.plans[t.plan as usize];
        let sk = plan.spans[k];
        let i = plan.ssp.partition_point(|&f| f < sk.r1 - 0.01);
        let target = plan.ssp.get(i).copied().unwrap_or(plan.length);
        let mut want = Vec::new();
        let mut q = k;
        while q < plan.spans.len() && plan.spans[q].r0 < target - 0.01 {
            if !t.held[q] {
                want.push(q);
            }
            q += 1;
        }
        // direction locks of a two-way stretch entered here: the whole stretch
        let mut extra = Vec::new();
        for &q in &want {
            let s = plan.spans[q];
            if s.kind == SP_DIR {
                for r in q..=s.chain_end as usize {
                    if plan.spans[r].kind == SP_DIR && !t.held[r] && !want.contains(&r) && !extra.contains(&r) {
                        extra.push(r);
                    }
                }
            }
        }
        want.extend(extra);
        (want, target)
    }

    /// Route setting: reserve the route past span `k` to the next safe stopping point
    /// atomically, or nothing (conflict check before granting).
    fn try_route(&mut self, ti: usize, k: usize) -> bool {
        let (want, target) = self.route_spans(ti, k);
        let (me, pi, len) = (self.trains[ti].id, self.trains[ti].plan as usize, self.trains[ti].len);
        {
            let plan = &self.plans[pi];
            for &q in &want {
                if !self.span_free(&plan.spans[q], me) {
                    return false;
                }
            }
            // on sight (no blocks on plain track): the berth beyond a junction must be clear of
            // vehicle bodies, so a car never waits inside a junction box
            if !signalled(plan.mode) && want.iter().any(|&q| plan.spans[q].kind == SP_JUNCTION) && target < plan.length - 1.0 {
                if !self.body_free(ti, pi, target - len - 4.0, (target + 2.0).min(plan.length)) {
                    return false;
                }
            }
        }
        let spans: Vec<Span> = want.iter().map(|&q| self.plans[pi].spans[q]).collect();
        let t = &mut self.trains[ti];
        for (&q, s) in want.iter().zip(&spans) {
            t.held[q] = true;
            match s.kind {
                SP_DIR => {
                    let d = &mut self.dirs[s.res as usize];
                    d.dir = s.dir;
                    d.count += 1;
                }
                _ => self.owner[s.res as usize] = me,
            }
        }
        true
    }

    fn release_span(&mut self, ti: usize, k: usize) {
        let t = &mut self.trains[ti];
        if !t.held[k] {
            return;
        }
        t.held[k] = false;
        let s = self.plans[t.plan as usize].spans[k];
        match s.kind {
            SP_DIR => {
                let d = &mut self.dirs[s.res as usize];
                d.count = d.count.saturating_sub(1);
            }
            _ => {
                // another span of this plan may use the same resource (a loop)
                let me = t.id;
                if self.owner[s.res as usize] == me {
                    let still = self.plans[t.plan as usize].spans.iter().enumerate().any(|(j, x)| j != k && t.held[j] && x.res == s.res && x.kind == s.kind);
                    if !still {
                        self.owner[s.res as usize] = NONE;
                    }
                }
            }
        }
    }

    fn release_all(&mut self, ti: usize) {
        let n = self.trains[ti].held.len();
        for k in 0..n {
            self.release_span(ti, k);
        }
    }

    /// release spans behind the tail, reserve ahead, update the authority
    fn authority(&mut self, ti: usize) {
        let (front, len, v, b, plan_i) = {
            let t = &self.trains[ti];
            (t.front, t.len, t.v, t.dy.b, t.plan as usize)
        };
        let tail = front - len;
        let n = self.plans[plan_i].spans.len();
        // a streetcar dwelling at a stop gives back the junctions it had claimed ahead (the
        // crossing lines are not held for its whole dwell); it claims them again as it leaves
        {
            let tr = &self.trains[ti];
            if !signalled(self.plans[plan_i].mode) && tr.state == TState::Dwell && self.stime + tr.toff < tr.until - 3.0 && !tr.player {
                let ahead: Vec<usize> = (0..n).filter(|&k| tr.held[k] && self.plans[plan_i].spans[k].kind == SP_JUNCTION && self.plans[plan_i].spans[k].r0 > front + 0.5).collect();
                if !ahead.is_empty() {
                    for k in ahead {
                        self.release_span(ti, k);
                    }
                    let tr = &mut self.trains[ti];
                    let p = &self.plans[plan_i];
                    tr.next = (0..n).find(|&k| !tr.held[k] && p.spans[k].r1 >= tail).unwrap_or(n);
                }
            }
        }
        // release
        let lo = self.trains[ti].lo;
        let hi = self.trains[ti].next.min(n);
        for k in lo..hi {
            if self.trains[ti].held[k] && self.plans[plan_i].spans[k].r1 < tail - 0.5 {
                self.release_span(ti, k);
            }
        }
        while self.trains[ti].lo < hi && !self.trains[ti].held[self.trains[ti].lo] && self.plans[plan_i].spans[self.trains[ti].lo].r1 < tail {
            self.trains[ti].lo += 1;
        }
        // reserve ahead: braking distance + a sighting margin
        // the player sees further (signals clear well ahead when the line is free)
        let on_sight = !signalled(self.plans[plan_i].mode);
        let look = if self.trains[ti].player {
            v * v / b + 1500.0
        } else if self.trains[ti].state == TState::Parked {
            0.0
        } else if on_sight {
            // streetcars claim a junction only as they come up to it (like a road vehicle at an
            // intersection), never while dwelling a block away: the crossing stays free for
            // the other line meanwhile
            if matches!(self.trains[ti].state, TState::Dwell | TState::Terminal) && self.stime + self.trains[ti].toff < self.trains[ti].until - 3.0 { 0.0 } else { v * v / (2.0 * b) + 25.0 }
        } else {
            v * v / (2.0 * b) + (v * 12.0).max(250.0)
        };
        let backing_off = self.stime < self.trains[ti].backoff_until;
        loop {
            let k = self.trains[ti].next;
            if k >= n {
                break;
            }
            let sp = self.plans[plan_i].spans[k];
            if backing_off && !self.trains[ti].held[k] && sp.r0 > front + 0.5 {
                break;
            }
            if self.trains[ti].held[k] {
                self.trains[ti].next += 1;
                continue;
            }
            if sp.r1 < tail {
                self.trains[ti].next += 1;
                continue;
            }
            if sp.r0 > front + look {
                break;
            }
            // on sight into a junction: only when the way out is clear for the whole body, so a
            // streetcar never stands inside a crossing waiting for the car ahead (and the other
            // line waiting for it)
            if !self.try_route(ti, k) {
                break;
            }
        }
        let t = &mut self.trains[ti];
        let plan = &self.plans[plan_i];
        t.ma = if t.next >= n { plan.length } else { plan.spans[t.next].r0.min(plan.length) };
    }

    // ------------------------------------------------------------------ spawning

    fn sched_centre(&self, fi: usize, trip: usize, t: f64) -> Option<(f32, f32, usize)> {
        let f = &self.feeds[fi];
        let plan = &self.plans[(f.plan0 + f.trip_pattern[trip]) as usize];
        let ns = plan.stop_centre.len();
        if ns == 0 || t < f.trip_start[trip] as f64 || t > f.trip_end[trip] as f64 {
            return None;
        }
        let acc = MODE_ACCEL[plan.mode as usize % 7];
        for k in 0..ns {
            let (arr, dep) = f.times(trip, k);
            if t < arr {
                // between k-1 and k
                let (_, dep0) = f.times(trip, k - 1);
                let (d0, d1) = (plan.stop_centre[k - 1], plan.stop_centre[k]);
                let lin = plan.stop_flag[k - 1] & 1 != 0 || plan.stop_flag[k] & 1 != 0;
                let (x, v) = segment_motion(d1 - d0, (arr - dep0) as f32, (t - dep0) as f32, acc, lin);
                return Some((d0 + x, v, k));
            }
            if t <= dep {
                return Some((plan.stop_centre[k], 0.0, k));
            }
        }
        None
    }

    /// try to place trip (fi, trip) as a train near its scheduled position
    fn spawn(&mut self, fi: usize, trip: usize, t: f64) -> bool {
        let Some((centre, v_s, k)) = self.sched_centre(fi, trip, t) else { return false };
        let f = &self.feeds[fi];
        let pi = (f.plan0 + f.trip_pattern[trip]) as usize;
        let plan = &self.plans[pi];
        if !plan.ok || plan.stop_front.len() < 2 || plan.length < plan.len + 20.0 {
            return false;
        }
        let len = plan.len.max(10.0);
        let dy = dyn_for(plan.mode);
        let n = plan.spans.len();
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1).max(1);
        let front0 = (centre + len * 0.5).min(plan.length);
        let dwell_at = if v_s < 0.01 { Some(k) } else { None };
        let mut tr = Train {
            id,
            feed: fi as u32,
            trip: trip as u32,
            plan: pi as u32,
            front: front0,
            v: v_s,
            a: 0.0,
            len,
            dy,
            held: vec![false; n],
            next: 0,
            lo: 0,
            ma: 0.0,
            stop: k,
            state: TState::Run,
            until: 0.0,
            since: t,
            delay: 0.0,
            player: false,
            penalty: false,
            held_t: 0.0,
            dead: false,
            cmd: 0.0,
            emerg: false,
            toff: t - self.stime,
            dh: false,
            legs: Vec::new(),
            warn: 0.0,
            ext_gap: f32::INFINITY,
            ext_v: 0.0,
            sight_gap: f32::INFINITY,
            sight_v: 0.0,
            sight_id: NONE,
            depot: NONE,
            horn: false,
            backoff_until: 0.0,
            stopped_t: 0.0,
        };
        if let Some(k) = dwell_at {
            let (_, dep) = f.times(trip, k);
            tr.state = if k + 1 >= plan.stop_centre.len() { TState::Terminal } else { TState::Dwell };
            tr.until = dep;
            tr.stop = k;
        }
        self.trains.push(tr);
        let ti = self.trains.len() - 1;
        // place: the body must be reservable; back off along the route if occupied
        let mut front = front0;
        for _ in 0..60 {
            if front < len - 1.0 {
                break;
            }
            if self.place(ti, front) {
                let tr = &mut self.trains[ti];
                if (front - front0).abs() > 1.0 {
                    // placed behind: start from rest-ish so it can stop before the authority
                    let room = (tr.ma - front - tr.dy.margin).max(0.0);
                    tr.v = tr.v.min((2.0 * tr.dy.b * room).sqrt());
                    if tr.state != TState::Run {
                        tr.state = TState::Run;
                    }
                    // the stop it is heading for: first stop ahead of the front
                    let p = &self.plans[pi];
                    let mut s = 0;
                    while s < p.stop_front.len() && p.stop_front[s] < front - 1.0 {
                        s += 1;
                    }
                    tr.stop = s.min(p.stop_front.len().saturating_sub(1));
                }
                let tr = &mut self.trains[ti];
                if tr.v > 0.01 && tr.ma - tr.front < tr.v * tr.v / (2.0 * tr.dy.b) + tr.dy.margin {
                    let room = (tr.ma - tr.front - tr.dy.margin).max(0.0);
                    tr.v = tr.v.min((2.0 * tr.dy.b * room).sqrt());
                }
                self.trip_state[fi][trip] = TripState::Agent(id);
                return true;
            }
            front -= 40.0;
        }
        self.trains.pop();
        false
    }

    /// reserve everything under the body at `front` (and the authority ahead); rolls back on failure
    fn place(&mut self, ti: usize, front: f32) -> bool {
        let pi = self.trains[ti].plan as usize;
        let len = self.trains[ti].len;
        if !signalled(self.plans[pi].mode) && !self.body_free(ti, pi, front - len - 6.0, front + 6.0) {
            return false;
        }
        self.trains[ti].front = front;
        let n = self.plans[pi].spans.len();
        // first span whose end is ahead of the tail
        let tail = front - len;
        let mut k = 0;
        while k < n && self.plans[pi].spans[k].r1 < tail {
            k += 1;
        }
        self.trains[ti].lo = k;
        self.trains[ti].next = k;
        while k < n && self.plans[pi].spans[k].r0 <= front {
            if !self.trains[ti].held[k] && !self.try_route(ti, k) {
                self.release_all(ti);
                return false;
            }
            k += 1;
        }
        self.trains[ti].next = self.trains[ti].lo;
        self.authority(ti);
        if self.trains[ti].ma >= front - 0.5 {
            return true;
        }
        self.release_all(ti);
        false
    }

    /// block starts in the next 25 minutes (their trains leave the depot ahead of time)
    fn pullout_pass(&mut self, t: f64) {
        if self.depots.is_empty() {
            return;
        }
        let r2 = self.radius * self.radius;
        for fi in 0..self.feeds.len() {
            let (lo, hi) = {
                let f = &self.feeds[fi];
                (f.trip_start.partition_point(|&s| (s as f64) <= t), f.trip_start.partition_point(|&s| (s as f64) <= t + 1500.0))
            };
            for trip in lo..hi {
                let f = &self.feeds[fi];
                if !self.block_start(fi, trip) || !matches!(self.trip_state[fi][trip], TripState::None) {
                    continue;
                }
                let pb = (f.plan0 + f.trip_pattern[trip]) as usize;
                let b = &self.plans[pb];
                if !b.ok || b.stop_front.is_empty() {
                    continue;
                }
                let p0 = b.point(&self.net, b.stop_front[0]);
                if (p0[0] - self.focus.0).powi(2) + (p0[1] - self.focus.1).powi(2) > r2 {
                    continue;
                }
                let key = (fi as u32, trip as u32);
                if self.pullout_tried.get(&key).map_or(false, |&at| t - at < 20.0) {
                    continue;
                }
                self.pullout_tried.insert(key, t);
                self.pull_out(fi, trip, t);
            }
        }
        if self.pullout_tried.len() > 20000 {
            self.pullout_tried.retain(|_, at| t - *at < 3600.0);
        }
    }

    fn spawn_pass(&mut self, t: f64) {
        let r2 = self.radius * self.radius;
        for fi in 0..self.feeds.len() {
            let nt = self.feeds[fi].trip_start.len();
            // trips possibly running at t
            for tt in [t] {
                let (lo, hi) = {
                    let f = &self.feeds[fi];
                    (f.trip_start.partition_point(|&s| (s as f64) < tt - f.max_dur as f64 - 1.0), f.trip_start.partition_point(|&s| (s as f64) <= tt))
                };
                for trip in lo..hi.min(nt) {
                    let f = &self.feeds[fi];
                    if (f.trip_end[trip] as f64) < tt {
                        continue;
                    }
                    let st = self.trip_state[fi][trip];
                    match st {
                        TripState::Agent(_) | TripState::Done | TripState::Finished => continue,
                        TripState::Pending(at) if tt - at < 2.0 && at <= tt => continue,
                        _ => {}
                    }
                    let pi = (f.plan0 + f.trip_pattern[trip]) as usize;
                    if !self.plans[pi].ok {
                        continue;
                    }
                    let (pv, tstart) = (f.trip_prev[trip], f.trip_start[trip] as f64);
                    let pv = if self.block_start(fi, trip) { -1 } else { pv };
                    if pv < 0 && !self.depots.is_empty() && tt < tstart + 60.0 {
                        // first trip of a block, due now: it comes out of the depot (pull_out)
                        let key = (fi as u32, trip as u32);
                        if self.pullout_tried.get(&key).map_or(true, |&at| tt - at > 20.0) {
                            self.pullout_tried.insert(key, tt);
                            if self.pull_out(fi, trip, tt) {
                                continue;
                            }
                        } else {
                            continue;
                        }
                    }
                    // the vehicle of this trip is still running its previous trip: it continues
                    // as this one (turnback) unless it is very late
                    if pv >= 0 {
                        if let TripState::Agent(_) = self.trip_state[fi][pv as usize] {
                            if tt < tstart + 900.0 {
                                continue;
                            }
                        }
                    }
                    let Some((c, _, _)) = self.sched_centre(fi, trip, tt) else { continue };
                    let p = self.plans[pi].point(&self.net, c);
                    let (dx, dy) = (p[0] - self.focus.0, p[1] - self.focus.1);
                    if dx * dx + dy * dy > r2 {
                        if matches!(st, TripState::Pending(_)) {
                            self.trip_state[fi][trip] = TripState::None;
                        }
                        continue;
                    }
                    // never materialise a train in front of the camera: the timetable keeps
                    // drawing it until it can be placed unseen
                    if self.in_view(p[0], p[1]) {
                        continue;
                    }
                    if !self.spawn(fi, trip, tt) {
                        self.trip_state[fi][trip] = TripState::Pending(tt);
                    } else {
                        // placed from the timetable inside the radius (not arriving from outside)
                        let d_edge = (self.radius - ((p[0] - self.focus.0).hypot(p[1] - self.focus.1))) > 1000.0;
                        if d_edge {
                            self.spawned_inside += 1;
                            if pv < 0 {
                                self.spawned_first += 1;
                                if self.pop_log.len() < 40 {
                                    let pl = &self.plans[pi];
                                    self.pop_log.push(format!("feed {} mode {} trip {} t-start {:.0} fail {:?} dist {:.0}", fi, pl.mode, trip, tt - tstart, self.po_last, (p[0] - self.focus.0).hypot(p[1] - self.focus.1)));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------------ stepping

    pub fn step(&mut self, dt: f32, tod: f64) {
        if self.dirty {
            self.rebuild();
        }
        self.tod = tod;
        let st = if tod < 4.0 * 3600.0 { tod + 86400.0 } else { tod };
        if (st - self.stime).abs() > 3600.0 {
            // service-day rollover / clock jump: start over from the timetable
            self.clear_trains();
        }
        self.stime = st;
        if !self.enabled || self.plans.is_empty() {
            return;
        }
        let t = st;
        if !self.bays_built {
            self.bays_built = true;
            self.build_bays();
        }
        self.spawn_acc += dt;
        if self.spawn_acc >= 1.0 {
            self.spawn_acc = 0.0;
            self.fill_depots(t);
            self.pullout_pass(t);
            self.spawn_pass(t);
            self.handoff();
            self.break_locks(t);
            // cars left in a layover bay (their next trip went another way): out of sight, away
            for ti in 0..self.trains.len() {
                let tr = &self.trains[ti];
                if !tr.dead && tr.state == TState::Parked && (tr.depot as usize) < self.depots.len() && self.depots[tr.depot as usize].bay && t - tr.since > 1800.0 && !self.train_seen(ti) {
                    self.remove(ti, false);
                }
            }
            self.check();
        }
        self.sight();
        let n = self.trains.len();
        for ti in 0..n {
            if self.trains[ti].dead {
                continue;
            }
            self.authority(ti);
            let tt = t + self.trains[ti].toff;
            self.drive(ti, dt, tt);
        }
        self.terminals(t);
        self.trains.retain(|tr| !tr.dead);
        self.crossings_step(t);
    }

    fn drive(&mut self, ti: usize, dt: f32, t: f64) {
        // ---- read-only phase: constraints and the commanded acceleration
        let (a, dwell_target, set_penalty, warn_now) = {
            let tr = &self.trains[ti];
            let plan = &self.plans[tr.plan as usize];
            let feed = &self.feeds[tr.feed as usize];
            let (front, v, len, dy) = (tr.front, tr.v, tr.len, tr.dy);
            let ma_stop = tr.ma - if tr.ma >= plan.length - 0.01 { 0.0 } else { dy.margin };
            // civil limit under the whole train
            let vl = plan.limit_over(front - len, front).min(dy.vmax);
            let mut target = vl;
            // constraints ahead: (distance from the front, speed there)
            let mut cons: [(f32, f32); 10] = [(f32::INFINITY, 0.0); 10];
            let mut nc = 0;
            cons[nc] = (ma_stop - front, 0.0);
            nc += 1;
            if tr.sight_gap.is_finite() {
                // on sight: keep 4 m behind the vehicle ahead
                cons[nc] = (tr.sight_gap - 4.0, tr.sight_v.min(v));
                nc += 1;
            }
            if tr.ext_gap.is_finite() {
                cons[nc] = (tr.ext_gap, tr.ext_v.min(v));
                nc += 1;
            }
            let mut dwell_target = None;
            if tr.state == TState::Run && tr.stop < plan.stop_front.len() && !tr.player {
                let sf = plan.stop_front[tr.stop];
                if plan.stop_flag[tr.stop] & 1 == 0 {
                    cons[nc] = (sf - front, 0.0);
                    nc += 1;
                    dwell_target = Some(sf);
                    // timetable as a guideline: drivers run at line speed and let the padding
                    // absorb the difference (timetables pad the run into terminals by minutes);
                    // only when well ahead (> 1 min at line speed) ease off, to 85 % of it
                    let (arr, _) = feed.times(tr.trip as usize, tr.stop);
                    let left = (arr - t) as f32;
                    let dist = sf - front;
                    if tr.dh {
                        // empty stock: moderate speed
                        target = target.min(0.6 * vl + 3.0);
                    } else if left > 5.0 && dist > 200.0 {
                        let at_line = dist / vl.max(1.0) + vl / dy.b * 0.5;
                        if left - at_line > 60.0 {
                            let need = dist / (left - vl / dy.b * 0.5).max(1.0);
                            target = target.min(need.max(0.85 * vl).max(8.0));
                        }
                    }
                }
            }
            // lower speed limits ahead within braking distance
            let brake_d = v * v / (2.0 * dy.b) + 60.0;
            let mut i = plan.vlim.partition_point(|p| p.0 <= front);
            while i < plan.vlim.len() && plan.vlim[i].0 < front + brake_d && nc < cons.len() {
                if plan.vlim[i].1 < v {
                    cons[nc] = (plan.vlim[i].0 - front, plan.vlim[i].1);
                    nc += 1;
                }
                i += 1;
            }
            let stopped = matches!(tr.state, TState::Dwell | TState::Terminal | TState::Parked);
            let mut set_penalty = false;
            let mut warn_now = false;
            let mut a;
            if tr.player {
                // player: traction / brake command, supervised by ATP (service braking curve to
                // the end of the authority and to lower limits ahead; overspeed on the limit)
                a = if tr.cmd >= 0.0 { tr.cmd * dy.amax(v) } else { tr.cmd * dy.b * 1.3 };
                for &(d, u) in &cons[..nc] {
                    let allow = (u * u + 2.0 * dy.b * (d - 1.0).max(0.0)).sqrt();
                    if v > allow + 1.0 {
                        set_penalty = true;
                    }
                }
                if v > vl + 2.8 {
                    set_penalty = true;
                }
                // warn first (tone + countdown in the cab), penalty only if not corrected:
                // a driver braking at least at the service rate is correcting
                if set_penalty && (tr.warn < ATP_WARN || a <= -0.8 * dy.b) {
                    set_penalty = false;
                    warn_now = true;
                }
                if tr.emerg || tr.penalty || set_penalty {
                    a = -dy.be;
                }
            } else if stopped {
                a = -dy.b;
            } else {
                a = if v < target { dy.amax(v).min((target - v) * 0.8 + 0.05) } else { ((target - v) * 0.8).max(-dy.b) };
                for &(d, u) in &cons[..nc] {
                    if v <= u {
                        continue;
                    }
                    let dd = (d - 0.3).max(0.01);
                    let req = (v * v - u * u) / (2.0 * dd);
                    if req >= 0.85 * dy.b || dd < 2.0 {
                        a = a.min(-req.min(dy.be));
                    } else {
                        // never accelerate beyond the braking curve
                        let vmax = (u * u + 2.0 * 0.85 * dy.b * dd).sqrt();
                        a = a.min((vmax - v) / dt.max(0.05));
                    }
                }
                for &(d, u) in &cons[..nc] {
                    if u == 0.0 && d < 0.4 {
                        a = a.min(-v / dt.max(0.05));
                    }
                }
            }
            // jerk limit (braking along a curve and emergencies are immediate)
            let prev = tr.a;
            if a > prev {
                a = a.min(prev + dy.j * dt);
            } else if !(tr.penalty || set_penalty || tr.emerg) && a > -dy.b {
                a = a.max(prev - dy.j * 2.0 * dt);
            }
            (a, dwell_target, set_penalty, warn_now)
        };
        // ---- integrate
        let tr = &mut self.trains[ti];
        if set_penalty {
            tr.penalty = true;
            tr.warn = 0.0;
        }
        tr.warn = if warn_now { tr.warn + dt } else { 0.0 };
        let v = tr.v;
        let mut nv = v + a * dt;
        let mut ds = if nv < 0.0 {
            nv = 0.0;
            if a < 0.0 { v * v / (2.0 * -a) } else { 0.0 }
        } else {
            (v + nv) * 0.5 * dt
        };
        // hard safety clamp at the end of the authority: a train never enters a
        // block / junction / run it has not reserved
        let mut lim = tr.ma;
        if tr.sight_gap.is_finite() {
            // on sight: never into the vehicle ahead
            lim = lim.min(tr.front + (tr.sight_gap - 1.0).max(0.0));
        }
        if tr.front + ds > lim {
            if tr.front + ds > tr.ma + 0.05 && ds > 0.05 && !tr.player {
                self.overruns += 1;
            }
            ds = (lim - tr.front).max(0.0);
            nv = 0.0;
            if tr.player {
                tr.penalty = true;
            }
        }
        if let Some(sf) = dwell_target {
            if tr.front + ds > sf + 2.0 {
                ds = (sf - tr.front).max(0.0);
                nv = 0.0;
            }
        }
        tr.front += ds;
        tr.v = nv;
        tr.a = a;
        if tr.v < 0.05 && tr.penalty && tr.cmd <= 0.0 && !tr.emerg {
            // penalty brake releases once stopped with the controller in brake / coast
            tr.penalty = false;
        }
        if tr.v < 0.1 && tr.state == TState::Run && tr.ma - tr.front < tr.dy.margin + 5.0 {
            tr.held_t += dt;
        } else {
            tr.held_t = 0.0;
        }
        if tr.v < 0.1 && tr.state == TState::Run {
            tr.stopped_t += dt;
        } else {
            tr.stopped_t = 0.0;
        }
        // ---- stops
        let plan = &self.plans[tr.plan as usize];
        let feed = &self.feeds[tr.feed as usize];
        match tr.state {
            TState::Run => {
                while tr.stop + 1 < plan.stop_front.len() && plan.stop_flag[tr.stop] & 1 != 0 && tr.front >= plan.stop_front[tr.stop] - 0.5 {
                    tr.stop += 1;
                }
                if !tr.player && tr.stop < plan.stop_front.len() && plan.stop_flag[tr.stop] & 1 == 0 {
                    let sf = plan.stop_front[tr.stop];
                    if tr.front >= sf - 1.2 && tr.v < 0.2 {
                        tr.v = 0.0;
                        tr.a = 0.0;
                        let (arr, dep) = feed.times(tr.trip as usize, tr.stop);
                        tr.since = t;
                        if tr.dh {
                            tr.until = t + 25.0;
                        } else {
                            tr.delay = (t - arr) as f32;
                            tr.until = dep.max(t + tr.dy.dwell as f64);
                        }
                        tr.state = if tr.stop + 1 >= plan.stop_front.len() { TState::Terminal } else { TState::Dwell };
                    }
                }
                if tr.state == TState::Run && tr.stop + 1 >= plan.stop_front.len() && tr.front >= plan.length - 0.6 && tr.v < 0.2 && !tr.player {
                    tr.state = TState::Terminal;
                    tr.since = t;
                    tr.until = t + tr.dy.dwell as f64;
                }
            }
            TState::Dwell => {
                if t >= tr.until {
                    let (_, dep) = feed.times(tr.trip as usize, tr.stop);
                    tr.delay = (t - dep) as f32;
                    tr.stop += 1;
                    tr.state = TState::Run;
                }
            }
            TState::Terminal | TState::Parked => {}
        }
    }

    /// trip `trip` ends with a long layover before the next trip of its block
    fn long_layover(&self, fi: usize, trip: usize) -> bool {
        let f = &self.feeds[fi];
        let nx = f.trip_next[trip];
        nx >= 0 && (f.trip_start[nx as usize] - f.trip_end[trip]) as f64 > LONG_LAYOVER
    }

    /// trip `trip` starts a vehicle block (or follows a long layover spent in the depot)
    fn block_start(&self, fi: usize, trip: usize) -> bool {
        let pv = self.feeds[fi].trip_prev[trip];
        pv < 0 || self.long_layover(fi, pv as usize) || self.bay_trips.contains(&(fi as u32, trip as u32))
    }

    /// trains at the end of their trip: continue as the next trip of their block, or leave
    fn terminals(&mut self, t0: f64) {
        let n = self.trains.len();
        for ti in 0..n {
            let t = t0 + self.trains[ti].toff;
            let tr = &self.trains[ti];
            if tr.dead || tr.state != TState::Terminal || tr.player {
                continue;
            }
            // being ridden: it stays berthed at the end of its run (no next trip, no empty-stock
            // move, never retired) until the rider leaves
            if tr.id == self.keep && tr.legs.is_empty() {
                continue;
            }
            let fi = tr.feed as usize;
            if !tr.legs.is_empty() {
                // turnback: change ends onto the next leg. An empty train about to enter its
                // first platform waits here (in the yard / on the tail track) until it is due,
                // rather than standing early on a platform the line needs
                let last_leg_ready = tr.legs.len() > 1 || tr.dh == false || {
                    let f = &self.feeds[fi];
                    let start = f.trip_start.get(tr.trip as usize).copied().unwrap_or(0) as f64;
                    let lp = &self.plans[tr.legs[0] as usize];
                    let vdh = (0.6 * tr.dy.vmax + 3.0).clamp(8.0, 25.0);
                    t >= start - (lp.length as f64 / vdh as f64 + 60.0)
                };
                if t >= tr.since + 20.0 && last_leg_ready {
                    let leg = self.trains[ti].legs[0];
                    let (plan_a, front, len) = (self.trains[ti].plan as usize, self.trains[ti].front, self.trains[ti].len);
                    let (er, sr, dr) = self.plans[plan_a].locate(&self.net, front - len);
                    if let Some(nf) = self.plans[leg as usize].find(&self.net, er, sr, -dr) {
                        if self.switch_plan(ti, leg as usize, nf) {
                            let last = {
                                let tr = &mut self.trains[ti];
                                tr.legs.remove(0);
                                tr.legs.is_empty()
                            };
                            let tr = &mut self.trains[ti];
                            tr.dh = !last;
                            tr.stop = 0;
                            tr.state = TState::Run;
                            tr.v = 0.0;
                            tr.a = 0.0;
                            tr.since = t;
                            continue;
                        }
                    } else {
                        self.trains[ti].legs.clear();
                        self.remove_unless_kept(ti);
                        continue;
                    }
                    // could not change ends (the way back is occupied): give up after a while
                    if t > self.trains[ti].since + 120.0 && !self.train_seen(ti) {
                        self.remove_unless_kept(ti);
                    }
                }
                continue;
            }
            if tr.dh {
                // end of an empty-stock move: parked in a depot, or stabled out of the way
                if self.trains[ti].depot != NONE {
                    let tr = &mut self.trains[ti];
                    tr.state = TState::Parked;
                    tr.dh = false;
                    tr.v = 0.0;
                    tr.a = 0.0;
                    tr.since = t;
                } else if t >= self.trains[ti].since + 10.0 {
                    let tr = &self.trains[ti];
                    let pos = self.plans[tr.plan as usize].point(&self.net, tr.front);
                    if !self.in_view(pos[0], pos[1]) {
                        self.remove_unless_kept(ti);
                    }
                }
                continue;
            }
            let mut nx = self.feeds[fi].trip_next[tr.trip as usize];
            // a long layover (> 20 min) is spent in the depot, not on the terminal tracks: the
            // next trip leaves the depot again as the start of a block
            if nx >= 0 && self.long_layover(fi, tr.trip as usize) {
                nx = -1;
            }
            // a layover at a terminal with bays (streetcar loops): wait in a bay, clear of the
            // arrival and departure tracks; the next trip pulls out of it when due
            if nx >= 0 && t >= tr.since + tr.dy.dwell as f64 * 0.5 && tr.id != self.keep {
                let nxu = nx as usize;
                let dep = self.feeds[fi].times(nxu, 0).1;
                if dep - t > BAY_LAYOVER && matches!(self.trip_state[fi][nxu], TripState::None | TripState::Pending(_)) && self.depots.iter().any(|d| d.bay) {
                    if self.pull_in_to(ti, t, true) {
                        self.bay_trips.insert((fi as u32, nxu as u32));
                        self.bay_pullins += 1;
                        continue;
                    }
                }
            }
            let tr = &self.trains[ti];
            if nx >= 0 && t >= tr.since + tr.dy.dwell as f64 * 0.5 {
                let nx = nx as usize;
                if matches!(self.trip_state[fi][nx], TripState::None | TripState::Pending(_)) && (self.chain(ti, nx, t) || self.turnback(ti, nx, t)) {
                    continue;
                }
            }
            // end of an empty-stock move: stabled
            if self.trains[ti].dh {
                if t >= self.trains[ti].since + 10.0 {
                    self.remove_unless_kept(ti);
                }
                continue;
            }
            // no continuation: after the dwell, run empty to the depot (else a siding / tail
            // track) and stable there; failing that, clear the platform
            let tr = &self.trains[ti];
            let waited = t - tr.since;
            if waited > tr.dy.dwell as f64 && (self.pull_in(ti, t) || self.stable(ti, t)) {
                continue;
            }
            let tr = &self.trains[ti];
            let pos = self.plans[tr.plan as usize].point(&self.net, tr.front);
            // (never in view: a train vanishing from a platform is a pop)
            let seen = self.train_seen(ti);
            if !seen && (waited > 240.0 || (waited > 45.0 && self.blocking(ti))) {
                self.remove_unless_kept(ti);
            }
        }
    }

    /// is anyone waiting for a resource train `ti` holds?
    fn blocking(&self, ti: usize) -> bool {
        let me = self.trains[ti].id;
        (0..self.trains.len()).any(|j| j != ti && !self.trains[j].dead && self.trains[j].held_t >= 5.0 && self.wait_for(j) == Some(me))
    }

    /// train `ti` (at the end of its trip) becomes trip `nx` of the same feed
    fn chain(&mut self, ti: usize, nx: usize, t: f64) -> bool {
        let (fi, plan_a, front, len) = {
            let tr = &self.trains[ti];
            (tr.feed as usize, tr.plan as usize, tr.front, tr.len)
        };
        let f = &self.feeds[fi];
        let pb = (f.plan0 + f.trip_pattern[nx]) as usize;
        if !self.plans[pb].ok || self.plans[pb].stop_front.is_empty() {
            return false;
        }
        let a = &self.plans[plan_a];
        let (ef, sf, df) = a.locate(&self.net, front);
        let (er, sr, dr) = a.locate(&self.net, front - len);
        let b = &self.plans[pb];
        let first = b.stop_front[0];
        // same direction (through-running) or reversed (change ends)
        let cand = [b.find(&self.net, ef, sf, df), b.find(&self.net, er, sr, -dr)];
        // streetcar loops: the car may have run past the next trip's first stop on the loop
        // track; it starts the trip from where it stands
        let over = if signalled(b.mode) { 2.0 } else { 300.0 };
        let mut pb = pb;
        let nf = match cand.into_iter().flatten().find(|&r| r <= first + over && r >= len * 0.5 - 1.0) {
            Some(nf) => nf,
            None => {
                // the next trip starts a little further along the track the train stands on
                // (a loop / terminal track): the same trip with its route extended back to here
                let it0 = b.items[0];
                if (it0.edge, it0.dir) != (ef, df) {
                    return false;
                }
                let l = self.net.e_len[ef as usize];
                let along = if df > 0 { sf } else { l - sf };
                let old_start = -it0.base;
                let new_start = along - len - 1.0;
                if new_start < 0.0 || along > old_start + len + 2.0 || old_start - along > 400.0 {
                    return false;
                }
                let key = (pb as u32, (new_start * 2.0) as u32);
                if let Some(&cp) = self.ext_cache.get(&key) {
                    pb = cp as usize;
                    return self.chain_to(ti, nx, pb, len + 1.0, t);
                }
                let shift = old_start - new_start;
                let edges: Vec<u32> = b.items.iter().map(|it| 2 * it.edge + if it.dir > 0 { 0 } else { 1 }).collect();
                let centres: Vec<f32> = b.stop_centre.iter().map(|c| c + shift).collect();
                let flags = b.stop_flag.clone();
                let (feed, local, mode, blen) = (b.feed, b.local, b.mode, b.len);
                let mut np = build_plan(&self.net, feed, local, mode, blen, true, new_start, &edges, &centres, &flags, &self.bidir);
                if !np.ok {
                    return false;
                }
                np.pshift = shift;
                self.plans.push(np);
                pb = self.plans.len() - 1;
                self.ext_cache.insert(key, pb as u32);
                len + 1.0
            }
        };
        self.chain_to(ti, nx, pb, nf, t)
    }

    /// train `ti` continues as trip `nx` on plan `pb`, its front at `nf` there
    fn chain_to(&mut self, ti: usize, nx: usize, pb: usize, nf: f32, t: f64) -> bool {
        let fi = self.trains[ti].feed as usize;
        let first = self.plans[pb].stop_front[0];
        if !self.switch_plan(ti, pb, nf) {
            return false;
        }
        let old_trip = self.trains[ti].trip as usize;
        self.trip_state[fi][old_trip] = TripState::Finished;
        self.trip_state[fi][nx] = TripState::Agent(self.trains[ti].id);
        let (_, dep) = self.feeds[fi].times(nx, 0);
        let tr = &mut self.trains[ti];
        tr.trip = nx as u32;
        tr.stop = 0;
        tr.v = 0.0;
        tr.a = 0.0;
        tr.since = t;
        tr.until = dep.max(t + tr.dy.dwell as f64);
        tr.state = if (nf - first).abs() < 3.0 { TState::Dwell } else { TState::Run };
        if nf > first + 2.0 {
            // past the first stop: depart from here (dwell until the departure time, then run
            // to the next stop ahead)
            let pb_ = &self.plans[pb];
            let k = pb_.stop_front.iter().position(|&x| x >= nf - 1.5).unwrap_or(pb_.stop_front.len() - 1);
            let tr = &mut self.trains[ti];
            tr.stop = k.saturating_sub(1);
            tr.state = TState::Dwell;
        }
        true
    }

    /// move train `ti` onto plan `pb` with its front at `nf` (same physical position):
    /// direction locks are released first (a reversal needs the opposite direction),
    /// blocks / junctions stay ours until the new plan holds them. On failure the old
    /// plan is restored (or the train removed).
    fn switch_plan(&mut self, ti: usize, pb: usize, nf: f32) -> bool {
        let front = self.trains[ti].front;
        let old_plan = self.trains[ti].plan;
        let mut old_held = std::mem::take(&mut self.trains[ti].held);
        for (k, h) in old_held.iter_mut().enumerate() {
            let s = self.plans[old_plan as usize].spans[k];
            if *h && s.kind == SP_DIR {
                let d = &mut self.dirs[s.res as usize];
                d.count = d.count.saturating_sub(1);
                *h = false;
            }
        }
        {
            let tr = &mut self.trains[ti];
            tr.plan = pb as u32;
            tr.held = vec![false; self.plans[pb].spans.len()];
            tr.front = nf;
        }
        let ok = self.place(ti, nf);
        {
            let me = self.trains[ti].id;
            let oldp = &self.plans[old_plan as usize];
            let newp = &self.plans[pb];
            let tr = &self.trains[ti];
            for (k, &h) in old_held.iter().enumerate() {
                if !h {
                    continue;
                }
                let s = oldp.spans[k];
                let reused = ok && newp.spans.iter().enumerate().any(|(j, x)| tr.held[j] && x.res == s.res && x.kind == s.kind);
                if !reused && self.owner[s.res as usize] == me {
                    self.owner[s.res as usize] = NONE;
                }
            }
        }
        if !ok {
            let tr = &mut self.trains[ti];
            tr.plan = old_plan;
            tr.held = vec![false; self.plans[old_plan as usize].spans.len()];
            if !self.place(ti, front) {
                self.remove(ti, true);
            }
            return false;
        }
        true
    }

    /// Turnback: the next trip of the vehicle starts on another track. Find an
    /// empty-stock move from here to the new trip's route (changing ends at most twice:
    /// here, at a dead end / tail track, or on a track long enough past a switch) and
    /// run it as legs.
    fn turnback(&mut self, ti: usize, nx: usize, t: f64) -> bool {
        let (fi, pa) = (self.trains[ti].feed as usize, self.trains[ti].plan as usize);
        let pb = (self.feeds[fi].plan0 + self.feeds[fi].trip_pattern[nx]) as usize;
        if pa >= self.n_pat_plans || !self.plans[pb].ok {
            return false;
        }
        let legs = match self.dh_cache.get(&(pa as u32, pb as u32)) {
            Some(v) => v.clone(),
            None => {
                let v = self.plan_turnback(pa, pb);
                self.dh_cache.insert((pa as u32, pb as u32), v.clone());
                v
            }
        };
        let Some(legs) = legs else { return false };
        // leg 0 continues from the train's current position in its direction
        let (ef, sf, df) = self.plans[pa].locate(&self.net, self.trains[ti].front);
        let Some(nf) = self.plans[legs[0] as usize].find(&self.net, ef, sf, df) else { return false };
        if !self.switch_plan(ti, legs[0] as usize, nf) {
            return false;
        }
        let old_trip = self.trains[ti].trip as usize;
        self.trip_state[fi][old_trip] = TripState::Finished;
        self.trip_state[fi][nx] = TripState::Agent(self.trains[ti].id);
        self.turnbacks += 1;
        let tr = &mut self.trains[ti];
        tr.trip = nx as u32;
        tr.legs = legs[1..].to_vec();
        tr.dh = !tr.legs.is_empty();
        tr.stop = 0;
        tr.state = TState::Run;
        tr.since = t;
        true
    }

    /// roughly in view of the camera (within 2 km, inside a 130 deg cone)?
    /// is any part of train `ti` in the camera's view
    fn train_seen(&self, ti: usize) -> bool {
        let tr = &self.trains[ti];
        let p = &self.plans[tr.plan as usize];
        let a = p.point(&self.net, tr.front);
        let b = p.point(&self.net, tr.front - tr.len);
        self.in_view(a[0], a[1]) || self.in_view(b[0], b[1])
    }

    pub fn in_view(&self, x: f64, y: f64) -> bool {
        let Some((cx, cy, fx, fy)) = self.camera else { return false };
        let (dx, dy) = (x - cx, y - cy);
        let d = dx.hypot(dy);
        if d > 2000.0 {
            return false;
        }
        d < 60.0 || (dx * fx + dy * fy) / d > 0.42
    }

    // ------------------------------------------------------------------ level crossings

    /// crossings: [osm id, edge, s, E, N]* (network header)
    pub fn set_crossings(&mut self, data: &[f64]) {
        let ne = self.net.e_from.len() as u32;
        self.crossings = data
            .chunks_exact(5)
            .filter(|c| (c[1] as u32) < ne)
            .map(|c| Crossing { osm: c[0], edge: c[1] as u32, s: c[2] as f32, x: c[3], y: c[4], state: 0, changed: false, last: -1e9 })
            .collect();
        self.plan_xings.clear();
        self.xing_by_edge.clear();
        for (ci, c) in self.crossings.iter().enumerate() {
            self.xing_by_edge.entry(c.edge).or_default().push(ci as u32);
        }
    }

    fn plan_crossings(&mut self, pi: u32) -> Vec<(u32, f32)> {
        if let Some(v) = self.plan_xings.get(&pi) {
            return v.clone();
        }
        let p = &self.plans[pi as usize];
        let mut v = Vec::new();
        for it in &p.items {
            if let Some(list) = self.xing_by_edge.get(&it.edge) {
                for &ci in list {
                    let c = &self.crossings[ci as usize];
                    let l = self.net.e_len[it.edge as usize];
                    let along = if it.dir > 0 { c.s } else { l - c.s };
                    v.push((ci, it.base + along));
                }
            }
        }
        self.plan_xings.insert(pi, v.clone());
        v
    }

    /// Crossing states from the trains' positions and speeds; horn flags.
    fn crossings_step(&mut self, t: f64) {
        if self.crossings.is_empty() {
            return;
        }
        let nc = self.crossings.len();
        let mut eta = vec![f32::INFINITY; nc];
        for ti in 0..self.trains.len() {
            let (pi, front, len, v, dead) = {
                let tr = &self.trains[ti];
                (tr.plan, tr.front, tr.len, tr.v, tr.dead)
            };
            if dead {
                continue;
            }
            let xs = self.plan_crossings(pi);
            let mut horn = false;
            for (ci, r) in xs {
                let d = r - front;
                if d < -len - 8.0 || d > 1500.0 {
                    continue;
                }
                let mut e = if d <= 0.0 { 0.0 } else { d / v.max(1.0) };
                // a train standing well before the crossing does not close it
                if d > 60.0 && v < 1.0 {
                    e = f32::INFINITY;
                }
                let k = ci as usize;
                eta[k] = eta[k].min(e);
                if d > 0.0 && e < XING_HORN && v > 3.0 {
                    horn = true;
                }
            }
            self.trains[ti].horn = horn;
        }
        for (k, c) in self.crossings.iter_mut().enumerate() {
            let e = eta[k];
            if e <= XING_WARN {
                c.last = t;
            }
            let mut want = if e <= XING_DOWN {
                2
            } else if e <= XING_WARN {
                c.state.max(1)
            } else if t - c.last < 4.0 {
                c.state // hold a few seconds after the train has passed
            } else {
                0
            };
            // warning always precedes gates down
            if want == 2 && c.state == 0 {
                want = 1;
            }
            if want != c.state {
                if want == 2 {
                    self.xing_closures += 1;
                }
                c.state = want;
                c.changed = true;
            }
        }
    }

    /// crossings whose state changed since the last call: [osm id, state]*
    pub fn crossing_changes(&mut self) -> Vec<f64> {
        let mut out = Vec::new();
        for c in self.crossings.iter_mut() {
            if c.changed {
                c.changed = false;
                out.extend_from_slice(&[c.osm, c.state as f64]);
            }
        }
        out
    }

    // ------------------------------------------------------------------ depots

    /// depots: per depot [group, feed mask] + storage edge list, centre point
    pub fn set_depots(&mut self, group: &[u8], feeds: &[u32], off: &[u32], edges: &[u32]) {
        self.depots.clear();
        self.bays_built = false;
        self.park_cache.clear();
        let ne = self.net.e_from.len() as u32;
        for d in 0..group.len() {
            let es: Vec<u32> = edges[off[d] as usize..off[d + 1] as usize].iter().copied().filter(|&e| e < ne).collect();
            if es.is_empty() {
                continue;
            }
            let (mut x, mut y, mut n) = (0.0, 0.0, 0.0);
            for &e in &es {
                let p = self.net.point(e as usize, self.net.e_len[e as usize] * 0.5);
                x += p[0];
                y += p[1];
                n += 1.0;
            }
            self.depots.push(Depot { group: group[d], feeds: feeds[d], edges: es, x: x / n, y: y / n, filled: false, rep: None, bay: false });
        }
    }

    /// Layover bays of the streetcar terminal loops: the tram tracks near where the
    /// streetcar patterns end that no pattern runs (the loop's other tracks and sidings, per
    /// OSM) become a small bay "depot" of that terminal.
    fn build_bays(&mut self) {
        self.depots.retain(|d| !d.bay);
        self.park_cache.clear();
        if self.plans.is_empty() {
            return;
        }
        let ne = self.net.e_from.len();
        let mut used = vec![false; ne];
        for p in &self.plans[..self.n_pat_plans.min(self.plans.len())] {
            for it in &p.items {
                used[it.edge as usize] = true;
            }
        }
        // terminal points (pattern ends) of streetcar patterns, per feed
        let mut ends: Vec<(f64, f64, u32)> = Vec::new();
        for (fi, f) in self.feeds.iter().enumerate() {
            for pat in 0..f.pat_mode.len() {
                let pl = &self.plans[(f.plan0 as usize) + pat];
                if !pl.ok || signalled(pl.mode) {
                    continue;
                }
                for r in [0.0, pl.length] {
                    let q = pl.point(&self.net, r);
                    match ends.iter_mut().find(|e| (e.0 - q[0]).hypot(e.1 - q[1]) < 300.0) {
                        Some(e) => e.2 |= 1 << (fi as u32).min(31),
                        None => ends.push((q[0], q[1], 1 << (fi as u32).min(31))),
                    }
                }
            }
        }
        for (x, y, mask) in ends {
            let mut es = Vec::new();
            for e in 0..ne {
                if used[e] || self.net.e_kind[e] != K_TRAM || self.net.e_len[e] < 30.0 || self.net.e_len[e] > 300.0 {
                    continue;
                }
                // the whole track at the terminal (not a street line leaving it)
                let (a, b) = (self.net.e_off[e] as usize, self.net.e_off[e + 1] as usize);
                let near = (a..b).all(|v| (self.net.v_xyz[v][0] - x).hypot(self.net.v_xyz[v][1] - y) < 250.0);
                if near {
                    es.push(e as u32);
                }
            }
            if !es.is_empty() {
                self.depots.push(Depot { group: track_group(K_TRAM), feeds: mask, edges: es, x, y, filled: true, rep: None, bay: true });
            }
        }
    }

    /// debugging: which bay tracks can hold a car of length `len`
    pub fn bay_debug(&mut self, len: f32) -> String {
        let mut out = String::new();
        let bays: Vec<(f64, f64, Vec<u32>)> = self.depots.iter().filter(|d| d.bay).map(|d| (d.x, d.y, d.edges.clone())).collect();
        for (x, y, es) in bays {
            let mut ok = 0;
            let mut why = Vec::new();
            for e in es {
                match self.build_park_plan(e, len, 0, 0, 2) {
                    None => why.push(format!("{e}:noplan")),
                    Some(p) => {
                        if self.parks_clear(&p, len) {
                            ok += 1
                        } else {
                            let front = p.length;
                            let bad: Vec<String> = p.spans.iter().filter(|s| s.kind != SP_DIR && s.r0 < front && s.r1 > front - len).map(|s| format!("{}{}[{:.0},{:.0}]/{:.0}", ["B", "J", "D"][s.kind as usize], if self.service_res.get(s.res as usize).copied().unwrap_or(false) { "S" } else { "" }, s.r0, s.r1, front)).collect();
                            why.push(format!("{e}:{}", bad.join(",")));
                        }
                    }
                }
            }
            out += &format!("bay ({x:.0},{y:.0}) usable {ok} {:?}\n", why);
        }
        out
    }

    /// nearest depot for a feed / track group within `max` m of (x, y)
    fn depot_near(&self, feed: u32, group: u8, x: f64, y: f64, max: f64) -> Option<usize> {
        self.depot_near_kind(feed, group, x, y, max, None)
    }

    /// ... only bays (Some(true)), only depots (Some(false)), either (None)
    fn depot_near_kind(&self, feed: u32, group: u8, x: f64, y: f64, max: f64, bay: Option<bool>) -> Option<usize> {
        let mut best = None;
        for (i, d) in self.depots.iter().enumerate() {
            if d.group != group || d.feeds & (1 << feed.min(31)) == 0 || bay.map_or(false, |b| b != d.bay) {
                continue;
            }
            let dd = (d.x - x).hypot(d.y - y);
            if dd < max && best.map_or(true, |(b, _)| dd < b) {
                best = Some((dd, i));
            }
        }
        best.map(|b| b.1)
    }

    /// a plan that parks a consist of length `len` on storage edge `e` (front near its far end,
    /// towards a buffer stop if there is one), extended back over the approach so the whole
    /// body is on it
    fn park_plan(&mut self, e: u32, len: f32, feed: u32, local: u32, mode: u8) -> Option<u32> {
        let key = (e, (len * 10.0) as u32);
        if let Some(v) = self.park_cache.get(&key) {
            return *v;
        }
        let v = self.build_park_plan(e, len, feed, local, mode).filter(|p| self.parks_clear(p, len));
        let v = v.map(|p| {
            self.plans.push(p);
            (self.plans.len() - 1) as u32
        });
        self.park_cache.insert(key, v);
        v
    }

    /// a parked body on plan `p` (front at its end) stands clear of every switch (junction
    /// foul zone: yard ladders stay free for moves in and out) and of every block the
    /// timetabled routes use
    fn parks_clear(&self, p: &Plan, len: f32) -> bool {
        let front = p.length;
        p.spans.iter().all(|s| {
            if s.kind == SP_DIR || s.r0 >= front || s.r1 <= front - len {
                return true;
            }
            s.kind != SP_JUNCTION && !self.service_res.get(s.res as usize).copied().unwrap_or(false)
        })
    }

    fn build_park_plan(&self, e: u32, len: f32, feed: u32, local: u32, mode: u8) -> Option<Plan> {
        let net = &self.net;
        let le = net.e_len[e as usize];
        if le < 12.0 {
            return None;
        }
        let dead = |end: u32| net.c_off[end as usize + 1] == net.c_off[end as usize];
        // direction: towards a dead end if there is one
        let d: i8 = if dead(2 * e + 1) { 1 } else if dead(2 * e) { -1 } else { 1 };
        let mut items: Vec<(u32, i8)> = vec![(e, d)];
        let mut avail = le - 8.0;
        let mut cur = (e, d);
        let mut guard = 0;
        while avail < len + 5.0 && guard < 12 {
            guard += 1;
            let (ce, cd) = cur;
            let k_in = if cd > 0 { 0 } else { 1 };
            let end = 2 * ce + k_in;
            let (a, b) = (net.c_off[end as usize] as usize, net.c_off[end as usize + 1] as usize);
            // predecessor: travelling backwards out through `end`
            let Some(&x) = net.c_to[a..b].first() else { return None };
            let (e2, k2) = (x >> 1, x & 1);
            let d2: i8 = if k2 == 1 { 1 } else { -1 };
            if items.contains(&(e2, d2)) {
                return None;
            }
            items.insert(0, (e2, d2));
            avail += net.e_len[e2 as usize];
            cur = (e2, d2);
        }
        if avail < len + 5.0 {
            return None;
        }
        let total: f32 = items.iter().map(|x| net.e_len[x.0 as usize]).sum();
        // towards a buffer stop: 8 m short of it; on a track with a switch at both ends (a loop
        // track, a siding): in the middle, clear of both switches
        let far_dead = if d > 0 { dead(2 * e + 1) } else { dead(2 * e) };
        let front_r = if far_dead { total - 8.0 } else { total - le + (le + len) * 0.5 };
        let start = (front_r - len - 5.0).max(0.0);
        let front = front_r - start;
        let edges: Vec<u32> = items.iter().map(|&(e, d)| 2 * e + if d > 0 { 0 } else { 1 }).collect();
        let mut p = build_plan(net, feed, local, mode, len, true, start, &edges, &[front - len * 0.5], &[0], &self.bidir);
        if !p.ok {
            return None;
        }
        p.pshift = f32::NAN;
        Some(p)
    }

    /// could a train of plan `pi` stand with its front at `front` (resources and bodies free)?
    fn can_stand(&self, pi: usize, front: f32, len: f32) -> bool {
        let p = &self.plans[pi];
        for s in &p.spans {
            if s.kind != SP_DIR && s.r0 < front && s.r1 > front - len && self.owner[s.res as usize] != NONE {
                return false;
            }
        }
        self.body_free(usize::MAX, pi, front - len - 8.0, front + 8.0)
    }

    /// a free parking place in depot `di` for a consist (plan index), or None
    fn free_slot(&mut self, di: usize, len: f32, feed: u32, local: u32, mode: u8) -> Option<u32> {
        let mut edges = self.depots[di].edges.clone();
        edges.sort_by(|a, b| self.net.e_len[*b as usize].partial_cmp(&self.net.e_len[*a as usize]).unwrap_or(std::cmp::Ordering::Equal));
        for e in edges {
            let Some(pp) = self.park_plan(e, len, feed, local, mode) else { continue };
            let p = &self.plans[pp as usize];
            if self.can_stand(pp as usize, p.length, len) {
                return Some(pp);
            }
        }
        None
    }

    /// Pull-in: the train's block is over; run empty to a free place in the nearest depot.
    fn pull_in(&mut self, ti: usize, t: f64) -> bool {
        self.pull_in_to(ti, t, false)
    }

    /// pull in to the nearest depot, or (`bay`) to a layover bay of this terminal
    fn pull_in_to(&mut self, ti: usize, t: f64, bay: bool) -> bool {
        let (fi, pa, len) = (self.trains[ti].feed as usize, self.trains[ti].plan as usize, self.trains[ti].len);
        if pa >= self.n_pat_plans || self.depots.is_empty() {
            return false;
        }
        let (mode, local) = (self.plans[pa].mode, self.plans[pa].local);
        let p = self.plans[pa].point(&self.net, self.trains[ti].front);
        let (maxd, kind) = if bay { (400.0, Some(true)) } else { (30000.0, Some(false)) };
        let Some(di) = self.depot_near_kind(fi as u32, mode_group(mode), p[0], p[1], maxd, kind) else { return false };
        // candidate places, nearest first by trying a few
        let mut edges = self.depots[di].edges.clone();
        edges.sort_by(|a, b| self.net.e_len[*b as usize].partial_cmp(&self.net.e_len[*a as usize]).unwrap_or(std::cmp::Ordering::Equal));
        for e in edges.into_iter().take(24) {
            let Some(pp) = self.park_plan(e, len, fi as u32, local, mode) else { continue };
            let front_pp = self.plans[pp as usize].length;
            if !self.can_stand(pp as usize, front_pp, len) {
                continue;
            }
            let legs = match self.dh_cache.get(&(pa as u32, pp)) {
                Some(v) => v.clone(),
                None => {
                    let v = self.plan_turnback(pa, pp as usize);
                    self.dh_cache.insert((pa as u32, pp), v.clone());
                    v
                }
            };
            let Some(legs) = legs else { continue };
            // the way in must not run into / through a parked train (reserved resources, and
            // for on-sight modes the bodies themselves)
            if legs.iter().any(|&lp| self.plans[lp as usize].spans.iter().any(|s| s.kind != SP_DIR && { let o = self.owner[s.res as usize]; o != NONE && self.trains.iter().any(|x| x.id == o && x.state == TState::Parked) })) {
                continue;
            }
            if legs.iter().any(|&lp| self.parked_on(ti, lp as usize)) {
                continue;
            }
            let (ef, sf, df) = self.plans[pa].locate(&self.net, self.trains[ti].front);
            let Some(nf) = self.plans[legs[0] as usize].find(&self.net, ef, sf, df) else { continue };
            if !self.switch_plan(ti, legs[0] as usize, nf) {
                return false;
            }
            let trip = self.trains[ti].trip as usize;
            self.trip_state[fi][trip] = TripState::Finished;
            self.pullins += 1;
            let tr = &mut self.trains[ti];
            tr.legs = legs[1..].to_vec();
            tr.dh = true;
            tr.depot = di as u32;
            tr.stop = 0;
            tr.state = TState::Run;
            tr.since = t;
            return true;
        }
        false
    }

    /// Pull-out: the first trip of a vehicle block starts soon near a depot within the radius:
    /// a parked train (or, with none there, a train put in a free place) runs empty to the
    /// trip's first platform in time for its departure.
    fn pull_out(&mut self, fi: usize, trip: usize, t: f64) -> bool {
        let before = self.po_fail;
        let r = self.pull_out_inner(fi, trip, t);
        for k in 0..5 {
            self.po_last[k] = self.po_fail[k] - before[k];
        }
        r
    }

    fn pull_out_inner(&mut self, fi: usize, trip: usize, t: f64) -> bool {
        let f = &self.feeds[fi];
        let pb = (f.plan0 + f.trip_pattern[trip]) as usize;
        let start = f.trip_start[trip] as f64;
        let b = &self.plans[pb];
        if !b.ok || b.stop_front.len() < 2 {
            return false;
        }
        let (mode, local, len) = (b.mode, b.local, b.len);
        let p0 = b.point(&self.net, b.stop_front[0]);
        let Some(di) = self.depot_near(fi as u32, mode_group(mode), p0[0], p0[1], 25000.0) else {
            self.po_fail[0] += 1;
            return false;
        };
        let d = &self.depots[di];
        let r2 = self.radius * self.radius;
        if (d.x - self.focus.0).powi(2) + (d.y - self.focus.1).powi(2) > r2 {
            // depot outside the radius: the empty train arrives across the radius boundary
            if self.pull_out_from_outside(fi, trip, di, t) {
                return true;
            }
            self.po_fail[1] += 1;
            return false;
        }
        // a parked train of this consist in the depot with a way out (else one put on a free
        // track of the depot)
        let mut cands: Vec<usize> = (0..self.trains.len())
            .filter(|&k| {
                let tr = &self.trains[k];
                !tr.dead && tr.state == TState::Parked && tr.depot == di as u32 && tr.feed == fi as u32 && (tr.len - len).abs() < 3.0
            })
            .collect();
        cands.truncate(8);
        let mut found = None;
        for k in cands {
            let pa = self.trains[k].plan as usize;
            let legs = match self.dh_cache.get(&(pa as u32, pb as u32)) {
                Some(v) => v.clone(),
                None => {
                    let v = self.plan_turnback(pa, pb);
                    self.dh_cache.insert((pa as u32, pb as u32), v.clone());
                    v
                }
            };
            if let Some(l) = legs {
                // the way out must not run through another parked train
                let me = self.trains[k].id;
                let blocked = l.iter().any(|&lp| self.plans[lp as usize].spans.iter().any(|s| s.kind != SP_DIR && { let o = self.owner[s.res as usize]; o != NONE && o != me && self.trains.iter().any(|x| x.id == o && x.state == TState::Parked) }));
                if blocked {
                    continue;
                }
                found = Some((k, l));
                break;
            }
        }
        if found.is_none() {
            for _ in 0..3 {
                let Some(pp) = self.free_slot(di, len, fi as u32, local, mode) else {
                    self.po_fail[2] += 1;
                    return false;
                };
                let legs = match self.dh_cache.get(&(pp, pb as u32)) {
                    Some(v) => v.clone(),
                    None => {
                        let v = self.plan_turnback(pp as usize, pb);
                        self.dh_cache.insert((pp, pb as u32), v.clone());
                        v
                    }
                };
                let Some(l) = legs else {
                    // no way out of this track: mark it unusable
                    self.park_cache.insert((self.plans[pp as usize].items.last().map(|x| x.edge).unwrap_or(0), (len * 10.0) as u32), None);
                    continue;
                };
                // (a train appearing on a visible depot track would be a pop)
                let q = { let pl = &self.plans[pp as usize]; pl.point(&self.net, pl.length) };
                if self.in_view(q[0], q[1]) {
                    return false;
                }
                if !self.spawn_parked(fi as u32, pp, di as u32, len, mode) {
                    self.po_fail[3] += 1;
                    return false;
                }
                found = Some((self.trains.len() - 1, l));
                break;
            }
        }
        let Some((ti, legs)) = found else {
            self.po_fail[4] += 1;
            return false;
        };
        let pa = self.trains[ti].plan as usize;
        // leave early enough: empty-stock speed ~ 8 m/s, a minute per change of ends
        // (arriving just in time: a train waiting early at its first platform blocks the line;
        // empty stock runs at ~60 % of line speed, ~11 m/s in yards and on leads)
        let dist: f32 = legs.iter().map(|&l| self.plans[l as usize].length).sum();
        let vdh = (0.6 * dyn_for(mode).vmax + 3.0).clamp(8.0, 25.0) * 0.85;
        // (from a terminal's layover bay it is a few metres: leave just as it is due, the
        // departure track is the arrival loop too)
        let need = if self.depots[di].bay { dist as f64 / vdh as f64 + 15.0 * legs.len() as f64 } else { dist as f64 / vdh as f64 + 40.0 * legs.len() as f64 + 45.0 };
        if t < start - need {
            return true; // not yet (the parked train waits)
        }
        // the departure platform must be free (or being left): a train still dwelling there
        // for an earlier departure would keep this one queued on the depot lead, blocking every
        // move behind it
        {
            let b = &self.plans[pb];
            let sf = b.stop_front[0];
            let me = self.trains[ti].id;
            let busy = b.spans.iter().any(|s| s.kind != SP_DIR && s.r0 < sf && s.r1 > sf - len && { let o = self.owner[s.res as usize]; o != NONE && o != me });
            if busy && t < start + 60.0 {
                return true;
            }
        }
        let (ef, sf, df) = self.plans[pa].locate(&self.net, self.trains[ti].front);
        let Some(nf) = self.plans[legs[0] as usize].find(&self.net, ef, sf, df) else { return false };
        if !self.switch_plan(ti, legs[0] as usize, nf) {
            return false;
        }
        self.pullouts += 1;
        self.trip_state[fi][trip] = TripState::Agent(self.trains[ti].id);
        let toff = t - self.stime;
        let tr = &mut self.trains[ti];
        tr.trip = trip as u32;
        tr.toff = toff;
        tr.legs = legs[1..].to_vec();
        tr.dh = !tr.legs.is_empty();
        tr.depot = NONE;
        tr.stop = 0;
        tr.state = TState::Run;
        tr.since = t;
        true
    }

    /// Pull-out from a depot outside the agent radius: the train is placed on the final leg
    /// of its empty-stock move where that enters the radius, timed to make the departure.
    fn pull_out_from_outside(&mut self, fi: usize, trip: usize, di: usize, t: f64) -> bool {
        let f = &self.feeds[fi];
        let pb = (f.plan0 + f.trip_pattern[trip]) as usize;
        let start = f.trip_start[trip] as f64;
        let (mode, local, len) = (self.plans[pb].mode, self.plans[pb].local, self.plans[pb].len);
        // a representative place in the depot (need not be free: the move starts out of sight)
        let mut edges = self.depots[di].edges.clone();
        edges.sort_by(|a, b| self.net.e_len[*b as usize].partial_cmp(&self.net.e_len[*a as usize]).unwrap_or(std::cmp::Ordering::Equal));
        let mut legs = None;
        for e in edges.into_iter().take(6) {
            let Some(pp) = self.park_plan(e, len, fi as u32, local, mode) else { continue };
            let v = match self.dh_cache.get(&(pp, pb as u32)) {
                Some(v) => v.clone(),
                None => {
                    let v = self.plan_turnback(pp as usize, pb);
                    self.dh_cache.insert((pp, pb as u32), v.clone());
                    v
                }
            };
            if v.is_some() {
                legs = v;
                break;
            }
        }
        let Some(legs) = legs else { return false };
        // the final leg (joins the trip); earlier legs (changes of ends) must be outside
        let last = *legs.last().unwrap() as usize;
        let lim = (self.radius - 300.0).max(0.0);
        let inside = |p: [f64; 3], s: &Self| (p[0] - s.focus.0).hypot(p[1] - s.focus.1) < lim;
        for &l in &legs[..legs.len() - 1] {
            let pl = &self.plans[l as usize];
            if inside(pl.point(&self.net, pl.length), self) {
                return false;
            }
        }
        let pl = &self.plans[last];
        let first = pl.stop_front[0];
        // first route position (from the leg start) that is inside the radius
        let mut r = len + 5.0;
        while r < first && !inside(pl.point(&self.net, r), self) {
            r += 50.0;
        }
        if r >= first || r < len {
            return false;
        }
        let need = ((first - r) as f64) / 10.0 + 60.0;
        if t < start - need {
            return true; // not yet
        }
        // place a train there
        let n = pl.spans.len();
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1).max(1);
        let toff = t - self.stime;
        self.trains.push(Train {
            id, feed: fi as u32, trip: trip as u32, plan: last as u32, front: r, v: 0.0, a: 0.0, len, dy: dyn_for(mode),
            held: vec![false; n], next: 0, lo: 0, ma: r, stop: 0, state: TState::Run, until: 0.0, since: t, delay: 0.0,
            player: false, penalty: false, held_t: 0.0, dead: false, cmd: 0.0, emerg: false, toff, dh: false, legs: Vec::new(),
            warn: 0.0, ext_gap: f32::INFINITY, ext_v: 0.0, sight_gap: f32::INFINITY, sight_v: 0.0, sight_id: NONE, depot: NONE, horn: false, backoff_until: 0.0, stopped_t: 0.0,
        });
        let ti = self.trains.len() - 1;
        if !self.place(ti, r) {
            self.trains.pop();
            return false;
        }
        let tr = &mut self.trains[ti];
        tr.v = (self.plans[last].limit_over(r - len, r).min(tr.dy.vmax) * 0.6).min((2.0 * tr.dy.b * (tr.ma - r - tr.dy.margin).max(0.0)).sqrt());
        self.trip_state[fi][trip] = TripState::Agent(id);
        self.pullouts += 1;
        true
    }

    /// a parked train on park plan `pp` of depot `di`
    fn spawn_parked(&mut self, feed: u32, pp: u32, di: u32, len: f32, mode: u8) -> bool {
        let n = self.plans[pp as usize].spans.len();
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1).max(1);
        let front = self.plans[pp as usize].length;
        self.trains.push(Train {
            id,
            feed,
            trip: 0,
            plan: pp,
            front,
            v: 0.0,
            a: 0.0,
            len,
            dy: dyn_for(mode),
            held: vec![false; n],
            next: 0,
            lo: 0,
            ma: front,
            stop: 0,
            state: TState::Parked,
            until: 0.0,
            since: self.stime,
            delay: 0.0,
            player: false,
            penalty: false,
            held_t: 0.0,
            dead: false,
            cmd: 0.0,
            emerg: false,
            toff: 0.0,
            dh: false,
            legs: Vec::new(),
            warn: 0.0,
            ext_gap: f32::INFINITY,
            ext_v: 0.0,
            sight_gap: f32::INFINITY,
            sight_v: 0.0,
            sight_id: NONE,
            depot: di,
            horn: false,
            backoff_until: 0.0,
            stopped_t: 0.0,
        });
        let ti = self.trains.len() - 1;
        if self.place(ti, front) {
            true
        } else {
            self.trains.pop();
            false
        }
    }

    /// Depots coming into the radius get the trains that are stabled there at this time
    /// of day (most at night, few in the peaks).
    fn fill_depots(&mut self, t: f64) {
        let h = (t / 3600.0) % 24.0;
        let frac = if h < 5.0 {
            0.85
        } else if h < 6.5 {
            0.6
        } else if (6.5..9.5).contains(&h) || (15.5..18.5).contains(&h) {
            0.2
        } else if h < 15.5 {
            0.4
        } else if h < 21.0 {
            0.45
        } else {
            0.7
        };
        let r = self.radius;
        for di in 0..self.depots.len() {
            if self.depots[di].bay {
                continue;
            }
            let (dx0, dy0, filled, dfeeds, dgroup) = {
                let d = &self.depots[di];
                (d.x, d.y, d.filled, d.feeds, d.group)
            };
            let inside = (dx0 - self.focus.0).hypot(dy0 - self.focus.1) < r - 300.0;
            if !inside {
                self.depots[di].filled = false;
                continue;
            }
            if filled {
                continue;
            }
            self.depots[di].filled = true;
            // representative consist: a pattern of a feed using the depot whose end is nearest
            if self.depots[di].rep.is_none() {
                let mut best: Option<(f64, (u32, u32, f32, u8))> = None;
                for f in &self.feeds {
                    if dfeeds & (1 << f.id.min(31)) == 0 {
                        continue;
                    }
                    let fi = self.feeds.iter().position(|x| x.id == f.id).unwrap() as u32;
                    for p in 0..f.pat_mode.len() {
                        let pl = &self.plans[(f.plan0 + p as u32) as usize];
                        if !pl.ok || mode_group(pl.mode) != dgroup || pl.stop_front.is_empty() {
                            continue;
                        }
                        let q = pl.point(&self.net, pl.length);
                        let dd = (q[0] - dx0).hypot(q[1] - dy0);
                        if best.map_or(true, |b| dd < b.0) {
                            best = Some((dd, (fi, p as u32, pl.len, pl.mode)));
                        }
                    }
                }
                self.depots[di].rep = best.map(|b| b.1);
            }
            let Some((fi, local, len, mode)) = self.depots[di].rep else { continue };
            let edges = self.depots[di].edges.clone();
            let mut cap = 0;
            let mut plans = Vec::new();
            for e in edges {
                if let Some(pp) = self.park_plan(e, len, self.feeds[fi as usize].id, local, mode) {
                    cap += 1;
                    plans.push(pp);
                }
            }
            let want = ((cap as f64) * frac).round() as usize;
            let mut made = 0;
            for (k, pp) in plans.into_iter().enumerate() {
                if made >= want {
                    break;
                }
                // spread over the tracks
                if cap > 0 && (k * want) % cap.max(1) >= want {
                    continue;
                }
                let front = self.plans[pp as usize].length;
                if self.can_stand(pp as usize, front, len) && self.spawn_parked(fi, pp, di as u32, len, mode) {
                    made += 1;
                }
            }
        }
    }

    /// Empty-stock move from the end of the train's trip to the nearest siding / yard /
    /// tail track ahead (within 3 km), where it is stabled (removed out of the way).
    fn stable(&mut self, ti: usize, t: f64) -> bool {
        let pa = self.trains[ti].plan as usize;
        if pa >= self.n_pat_plans {
            return false;
        }
        let leg = match self.stable_cache.get(&(pa as u32)) {
            Some(v) => *v,
            None => {
                let v = self.plan_stable(pa);
                self.stable_cache.insert(pa as u32, v);
                v
            }
        };
        let Some(leg) = leg else { return false };
        let (ef, sf, df) = self.plans[pa].locate(&self.net, self.trains[ti].front);
        let Some(nf) = self.plans[leg as usize].find(&self.net, ef, sf, df) else { return false };
        if !self.switch_plan(ti, leg as usize, nf) {
            return false;
        }
        let (fi, trip) = (self.trains[ti].feed as usize, self.trains[ti].trip as usize);
        self.trip_state[fi][trip] = TripState::Finished;
        let tr = &mut self.trains[ti];
        tr.dh = true;
        tr.stop = 0;
        tr.state = TState::Run;
        tr.since = t;
        true
    }

    fn plan_stable(&mut self, pa: usize) -> Option<u32> {
        let p = self.plan_stable_inner(pa)?;
        self.plans.push(p);
        Some((self.plans.len() - 1) as u32)
    }

    fn plan_stable_inner(&self, pa: usize) -> Option<Plan> {
        use std::collections::{BinaryHeap, HashMap};
        let net = &self.net;
        let a = &self.plans[pa];
        let len = a.len;
        let group = |k: u8| if k == K_RAIL { 0 } else { 1 };
        let g0 = group(net.e_kind[a.items[0].edge as usize]);
        let allowed = |e: usize| group(net.e_kind[e]) == g0 && !(net.e_kind[e] == K_RAIL && net.e_svc[e] == 2);
        let (e0, _, d0) = a.locate(net, a.length);
        let mut dist: HashMap<(u32, i8), f32> = HashMap::new();
        let mut prev: HashMap<(u32, i8), (u32, i8)> = HashMap::new();
        let mut heap: BinaryHeap<(std::cmp::Reverse<u32>, u32, i8)> = BinaryHeap::new();
        dist.insert((e0, d0), 0.0);
        heap.push((std::cmp::Reverse(0), e0, d0));
        let mut found: Option<((u32, i8), f32)> = None;
        while let Some((std::cmp::Reverse(c10), e, d)) = heap.pop() {
            let c = c10 as f32 / 10.0;
            if c > 3000.0 {
                break;
            }
            let out = 2 * e + if d > 0 { 1 } else { 0 };
            let (x0, x1) = (net.c_off[out as usize] as usize, net.c_off[out as usize + 1] as usize);
            let mut any = false;
            for &inn in &net.c_to[x0..x1] {
                let e2 = inn >> 1;
                let d2: i8 = if inn & 1 == 0 { 1 } else { -1 };
                if !allowed(e2 as usize) {
                    continue;
                }
                any = true;
                let l2 = net.e_len[e2 as usize];
                // a siding / yard / pocket long enough to hold the train
                if net.e_svc[e2 as usize] != 0 && net.e_svc[e2 as usize] != 3 && l2 >= len + 30.0 {
                    prev.insert((e2, d2), (e, d));
                    found = Some(((e2, d2), len + 20.0));
                    break;
                }
                let c2 = c + l2;
                if c2 < dist.get(&(e2, d2)).copied().unwrap_or(f32::INFINITY) {
                    dist.insert((e2, d2), c2);
                    prev.insert((e2, d2), (e, d));
                    heap.push((std::cmp::Reverse((c2 * 10.0) as u32), e2, d2));
                }
            }
            if found.is_some() {
                break;
            }
            if !any && (e, d) != (e0, d0) && net.e_len[e as usize] >= 20.0 {
                // dead end (tail track): stop at the buffer
                found = Some(((e, d), net.e_len[e as usize] - 8.0));
                break;
            }
        }
        let (end, at) = found?;
        let mut path = vec![end];
        let mut k = end;
        while k != (e0, d0) {
            k = *prev.get(&k)?;
            path.push(k);
        }
        path.reverse();
        let rear = a.length - len - 10.0;
        let i0 = a.items.partition_point(|it| it.base <= rear).max(1) - 1;
        let mut items: Vec<(u32, i8)> = a.items[i0..].iter().map(|it| (it.edge, it.dir)).collect();
        items.extend(path.into_iter().skip(1));
        let start = (rear - a.items[i0].base).max(0.0);
        let pre: f32 = items[..items.len() - 1].iter().map(|x| net.e_len[x.0 as usize]).sum();
        let end_r = pre - start + at;
        if end_r < a.length + 5.0 {
            return None;
        }
        let edges: Vec<u32> = items.iter().map(|&(e, d)| 2 * e + if d > 0 { 0 } else { 1 }).collect();
        let mut p = build_plan(net, a.feed, a.local, a.mode, len, true, start, &edges, &[end_r - len * 0.5], &[0], &self.bidir);
        if !p.ok {
            return None;
        }
        p.pshift = f32::NAN;
        Some(p)
    }

    /// legs (plan indices) for a turnback from the end of plan `pa` onto plan `pb`
    fn plan_turnback(&mut self, pa: usize, pb: usize) -> Option<Vec<u32>> {
        use std::collections::{BinaryHeap, HashMap};
        let net = &self.net;
        let a = &self.plans[pa];
        let b = &self.plans[pb];
        let len = a.len;
        let group = |k: u8| if k == K_RAIL { 0 } else { 1 };
        let g0 = group(net.e_kind[a.items[0].edge as usize]);
        // B's joinable items: those starting before its first stop
        let first = *b.stop_front.first()?;
        let mut join: HashMap<(u32, i8), usize> = HashMap::new();
        for (j, it) in b.items.iter().enumerate() {
            if it.base < first - len * 0.5 {
                join.entry((it.edge, it.dir)).or_insert(j);
            }
        }
        #[derive(Clone, Copy, PartialEq, Debug)]
        enum Op {
            Start,
            Move,
            /// changed ends: the train reversed with its front `at` metres into the edge (along the old travel)
            Rev(f32),
        }
        // state: (edge, dir, reversals) at the travel-end of the edge
        let (e0, _, d0) = a.locate(net, a.length);
        let (er, _, dr) = a.locate(net, a.length - len);
        let mut dist: HashMap<(u32, i8, u8), f32> = HashMap::new();
        let mut prev: HashMap<(u32, i8, u8), ((u32, i8, u8), Op)> = HashMap::new();
        let mut heap: BinaryHeap<(std::cmp::Reverse<u32>, u32, i8, u8)> = BinaryHeap::new();
        let key = |c: f32| std::cmp::Reverse((c * 10.0) as u32);
        // empty-stock moves may run wrong-road through terminal areas (at a cost)
        let allowed = |e: usize, _d: i8| group(net.e_kind[e]) == g0 && !(net.e_kind[e] == K_RAIL && net.e_svc[e] == 2);
        let wrong = |e: usize, d: i8| net.e_dir[e] & if d > 0 { 1 } else { 2 } == 0;
        dist.insert((e0, d0, 0), 0.0);
        heap.push((key(0.0), e0, d0, 0));
        prev.insert((e0, d0, 0), ((e0, d0, 0), Op::Start));
        // change ends in place (e.g. a through platform)
        if allowed(er as usize, -dr) {
            dist.insert((er, -dr, 1), 300.0);
            prev.insert((er, -dr, 1), ((e0, d0, 0), Op::Rev(-1.0)));
            heap.push((key(300.0), er, -dr, 1));
        }
        let mut found = None;
        while let Some((std::cmp::Reverse(c10), e, d, r)) = heap.pop() {
            let c = c10 as f32 / 10.0;
            if c > dist.get(&(e, d, r)).copied().unwrap_or(f32::INFINITY) + 0.5 || c > 250000.0 {
                continue;
            }
            if let Some(&j) = join.get(&(e, d)) {
                if (e, d, r) != (e0, d0, 0) {
                    found = Some(((e, d, r), j));
                    break;
                }
            }
            let out = 2 * e + if d > 0 { 1 } else { 0 };
            let (x0, x1) = (net.c_off[out as usize] as usize, net.c_off[out as usize + 1] as usize);
            let mut any = false;
            for &inn in &net.c_to[x0..x1] {
                let e2 = inn >> 1;
                let d2: i8 = if inn & 1 == 0 { 1 } else { -1 };
                if !allowed(e2 as usize, d2) {
                    continue;
                }
                any = true;
                let l2 = net.e_len[e2 as usize];
                let c2 = c + l2 * if wrong(e2 as usize, d2) { 4.0 } else { 1.0 };
                let k2 = (e2, d2, r);
                if c2 < dist.get(&k2).copied().unwrap_or(f32::INFINITY) {
                    dist.insert(k2, c2);
                    prev.insert(k2, ((e, d, r), Op::Move));
                    heap.push((key(c2), e2, d2, r));
                }
                // change ends on a long enough track beyond the switch
                if r < 3 && l2 >= len + 40.0 && allowed(e2 as usize, -d2) {
                    let k3 = (e2, -d2, r + 1);
                    let c3 = c + len + 20.0 + 300.0 + len + 20.0;
                    if c3 < dist.get(&k3).copied().unwrap_or(f32::INFINITY) {
                        dist.insert(k3, c3);
                        prev.insert(k3, ((e2, d2, r), Op::Rev(len + 20.0)));
                        heap.push((key(c3), e2, -d2, r + 1));
                    }
                }
            }
            // dead end (tail track / buffer): change ends here
            if !any && r < 3 && allowed(e as usize, -d) {
                let k3 = (e, -d, r + 1);
                let c3 = c + 300.0 + net.e_len[e as usize];
                if c3 < dist.get(&k3).copied().unwrap_or(f32::INFINITY) {
                    dist.insert(k3, c3);
                    prev.insert(k3, ((e, d, r), Op::Rev(net.e_len[e as usize] - 8.0)));
                    heap.push((key(c3), e, -d, r + 1));
                }
            }
        }
        let dbg = std::env::var("RAIL_DEBUG").is_ok();
        if dbg {
            eprintln!("turnback search: found {:?}", found);
        }
        let (end, j) = found?;
        // reconstruct ops from the start
        let mut ops: Vec<((u32, i8, u8), Op)> = Vec::new();
        let mut k = end;
        loop {
            let (p, op) = prev[&k];
            ops.push((k, op));
            if op == Op::Start {
                break;
            }
            k = p;
        }
        ops.reverse();
        // legs: sequences of (edge, dir) items with a start offset; every Rev closes a leg
        let enc = |v: &[(u32, i8)]| v.iter().map(|&(e, d)| 2 * e + if d > 0 { 0 } else { 1 }).collect::<Vec<u32>>();
        let elen = |e: u32| net.e_len[e as usize];
        let (feed, local, mode) = (b.feed, b.local, b.mode);
        // first leg: A's items from the one under the rear up to its last item, then the moves
        let rear = a.length - len - 10.0;
        let i0 = a.items.partition_point(|it| it.base <= rear).max(1) - 1;
        let mut cur: Vec<(u32, i8)> = a.items[i0..].iter().map(|it| (it.edge, it.dir)).collect();
        let mut start = (rear - a.items[i0].base).max(0.0);
        let mut out: Vec<Plan> = Vec::new();
        for (st, op) in ops.iter().skip(1) {
            match *op {
                Op::Move => cur.push((st.0, st.1)),
                Op::Rev(at) => {
                    let (end, next_items, next_start) = if at < 0.0 {
                        // change ends where the train stands (end of A)
                        let body: Vec<(u32, i8)> = cur.clone();
                        let pre: f32 = body[..body.len() - 1].iter().map(|x| elen(x.0)).sum();
                        let last = *body.last()?;
                        let along = a.length - a.items[a.items.len() - 1].base;
                        let end = pre - start + along;
                        let rev: Vec<(u32, i8)> = body.iter().rev().map(|&(e, d)| (e, -d)).collect();
                        (end, rev, elen(last.0) - along)
                    } else {
                        let last = *cur.last()?;
                        let pre: f32 = cur[..cur.len() - 1].iter().map(|x| elen(x.0)).sum();
                        (pre - start + at, vec![(last.0, -last.1)], elen(last.0) - at)
                    };
                    if dbg {
                        eprintln!("  leg {}: items {:?} start {start} end {end}", out.len(), cur);
                    }
                    if end < len - 1.0 {
                        return None;
                    }
                    let mut p = build_plan(net, feed, local, mode, len, true, start, &enc(&cur), &[end - len * 0.5], &[0], &self.bidir);
            p.pshift = f32::NAN;
                    if !p.ok {
                        if dbg {
                            eprintln!("  leg plan not ok");
                        }
                        return None;
                    }
                    out.push(p);
                    cur = next_items;
                    start = next_start;
                }
                Op::Start => {}
            }
        }
        let _ = j;
        // final leg joins B at the item matching the last state
        let jb = b.items.iter().position(|it| (it.edge, it.dir) == (end.0, end.1))?;
        if cur.last() == Some(&(end.0, end.1)) {
            cur.pop();
        }
        let pre_len: f32 = cur.iter().map(|x| elen(x.0)).sum();
        let final_items: Vec<(u32, i8)> = cur.iter().copied().chain(b.items[jb..].iter().map(|it| (it.edge, it.dir))).collect();
        let shift = pre_len - start - b.items[jb].base;
        let centres: Vec<f32> = b.stop_centre.iter().map(|c| c + shift).collect();
        if dbg {
            eprintln!("  final: {} items start {start} shift {shift}", final_items.len());
        }
        let mut p = build_plan(net, feed, local, mode, len, true, start, &enc(&final_items), &centres, &b.stop_flag.clone(), &self.bidir);
        p.pshift = shift;
        if !p.ok {
            if dbg {
                eprintln!("  final plan not ok");
            }
            return None;
        }
        out.push(p);
        let n0 = self.plans.len() as u32;
        let ids = (0..out.len() as u32).map(|i| n0 + i).collect();
        self.plans.extend(out);
        Some(ids)
    }

    /// end of the line for a train, unless it is being ridden: then it waits where it is
    /// ... and never in view (it waits until the camera looks away: no pop)
    fn remove_unless_kept(&mut self, ti: usize) {
        if self.trains[ti].id != self.keep && !self.train_seen(ti) {
            self.remove(ti, true);
        }
    }

    fn remove(&mut self, ti: usize, done: bool) {
        self.release_all(ti);
        let tr = &mut self.trains[ti];
        tr.dead = true;
        let (fi, trip) = (tr.feed as usize, tr.trip as usize);
        if self.player == Some(tr.id) {
            self.player = None;
        }
        if fi < self.trip_state.len() && trip < self.trip_state[fi].len() {
            self.trip_state[fi][trip] = if done { TripState::Finished } else { TripState::None };
        }
    }

    /// Lock breaker: trains waiting on each other in a cycle (each holds what the next one
    /// needs) for more than 45 s. A member whose contested resource lies ahead of its own
    /// body gives back everything it reserved ahead and stays put for 30 s, so the others can
    /// go first; an empty-stock member with nothing to give back is taken out of service
    /// (out of sight, or after 5 minutes).
    fn break_locks(&mut self, t: f64) {
        let n = self.trains.len();
        for ti in 0..n {
            if self.trains[ti].dead || self.trains[ti].stopped_t < 45.0 {
                continue;
            }
            // follow the wait-for chain
            let mut cyc = vec![ti];
            let mut cur = ti;
            let mut closed = false;
            for _ in 0..12 {
                let Some(id) = self.wait_for(cur).filter(|&id| id != 0) else { break };
                let Some(j) = self.trains.iter().position(|o| o.id == id && !o.dead) else { break };
                if j == ti {
                    closed = true;
                    break;
                }
                if cyc.contains(&j) || self.trains[j].stopped_t < 20.0 && !matches!(self.trains[j].state, TState::Dwell | TState::Terminal | TState::Parked) {
                    break;
                }
                cyc.push(j);
                cur = j;
            }
            if !closed || cyc.len() < 2 {
                continue;
            }
            // a member that can back off: the resource its predecessor waits for is reserved
            // ahead of its own body
            let mut done = false;
            for w in 0..cyc.len() {
                let j = cyc[w];
                let pred = cyc[(w + cyc.len() - 1) % cyc.len()];
                let tr = &self.trains[j];
                if tr.player || tr.state == TState::Parked {
                    continue;
                }
                let pj = &self.plans[tr.plan as usize];
                let front = tr.front;
                // resources pred waits for
                let pp = &self.plans[self.trains[pred].plan as usize];
                let pn = self.trains[pred].next;
                if pn >= pp.spans.len() {
                    continue;
                }
                let need: Vec<u32> = self.route_spans(pred, pn).0.iter().map(|&q| pp.spans[q].res).collect();
                let ahead: Vec<usize> = (0..pj.spans.len()).filter(|&k| tr.held[k] && pj.spans[k].r0 > front + 0.5 && pj.spans[k].kind != SP_DIR).collect();
                if ahead.iter().any(|&k| need.contains(&pj.spans[k].res)) {
                    for k in ahead {
                        self.release_span(j, k);
                    }
                    let tr = &mut self.trains[j];
                    let pj = &self.plans[tr.plan as usize];
                    let tail = tr.front - tr.len;
                    tr.next = (0..pj.spans.len()).find(|&k| !tr.held[k] && pj.spans[k].r1 >= tail).unwrap_or(pj.spans.len());
                    tr.backoff_until = t + 30.0;
                    self.locks_broken += 1;
                    done = true;
                    break;
                }
            }
            if done {
                continue;
            }
            // nothing to give back: an empty-stock member leaves service
            if let Some(&j) = cyc.iter().find(|&&j| self.trains[j].dh && self.trains[j].id != self.keep && !self.trains[j].player) {
                let q = self.plans[self.trains[j].plan as usize].point(&self.net, self.trains[j].front);
                if !self.in_view(q[0], q[1]) {
                    self.remove(j, true);
                    self.locks_broken += 1;
                }
            }
        }
    }

    /// trains that left the radius go back to the timetable; stuck trains far away too
    fn handoff(&mut self) {
        let r = self.radius + 800.0;
        let r2 = r * r;
        for ti in 0..self.trains.len() {
            let tr = &self.trains[ti];
            if tr.dead || tr.player || tr.id == self.keep {
                continue;
            }
            let p = self.plans[tr.plan as usize].point(&self.net, tr.front - tr.len * 0.5);
            let (dx, dy) = (p[0] - self.focus.0, p[1] - self.focus.1);
            let far = dx * dx + dy * dy > r2;
            // deadlock valve: stuck at a red for 10 minutes (e.g. a reversal blocked by a follower)
            // (never in view: a train vanishing in front of the camera is a pop)
            let mut stuck = tr.held_t > 600.0 && !self.in_view(p[0], p[1]);
            // an empty-stock move locked head-on with a train that waits for it (each holds
            // what the other needs): the empty train gives way (stabled out of sight)
            if !stuck && tr.dh && tr.held_t > 120.0 && tr.id != self.keep {
                let me = tr.id;
                if let Some(o) = self.blocker(ti).and_then(|id| self.trains.iter().position(|t| t.id == id)) {
                    let q = self.plans[tr.plan as usize].point(&self.net, tr.front);
                    if self.trains[o].held_t > 60.0 && self.blocker(o) == Some(me) && !self.in_view(q[0], q[1]) {
                        stuck = true;
                        self.dh_yield += 1;
                    }
                }
            }
            let tr_held_long = self.trains[ti].held_t > 600.0;
            if far || stuck {
                if stuck && !far && tr_held_long {
                    self.stuck_removed += 1;
                    if self.stuck_log.len() < 5000 {
                        let t = &self.trains[ti];
                        let blk = self.blocker(ti).and_then(|id| self.trains.iter().find(|o| o.id == id)).map(|o| format!("{:?} dh {} player {}", o.state, o.dh, o.player)).unwrap_or_else(|| "-".into());
                        self.stuck_log.push(format!("mode {} at ({:.0},{:.0}) dh {} legs {} depot {} | by {}", self.plans[t.plan as usize].mode, (p[0] / 200.0).round() * 200.0, (p[1] / 200.0).round() * 200.0, t.dh, t.legs.len(), t.depot as i64, blk));
                    }
                }
                self.remove(ti, true);
                if let Some(ts) = self.trip_state.get_mut(self.trains[ti].feed as usize) {
                    ts[self.trains[ti].trip as usize] = TripState::Done;
                }
            }
        }
    }

    // ------------------------------------------------------------------ checks / output

    /// count pairs of trains whose bodies overlap on an edge (must be 0)
    pub fn check(&mut self) -> u32 {
        let mut occ: Vec<(u32, f32, f32, u32)> = Vec::new();
        for tr in &self.trains {
            if tr.dead {
                continue;
            }
            let plan = &self.plans[tr.plan as usize];
            let (a, b) = (tr.front - tr.len, tr.front);
            for it in &plan.items {
                let l = self.net.e_len[it.edge as usize];
                let (r0, r1) = (it.base.max(a), (it.base + l).min(b));
                if r1 <= r0 {
                    continue;
                }
                let (x0, x1) = (r0 - it.base, r1 - it.base);
                let (s0, s1) = if it.dir > 0 { (x0, x1) } else { (l - x1, l - x0) };
                occ.push((it.edge, s0, s1, tr.id));
            }
        }
        occ.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal)));
        let mut n = 0;
        for i in 0..occ.len() {
            let mut j = i + 1;
            while j < occ.len() && occ[j].0 == occ[i].0 && occ[j].1 < occ[i].2 - 0.5 {
                if occ[j].3 != occ[i].3 {
                    n += 1;
                }
                j += 1;
            }
        }
        self.overlaps += n;
        n
    }

    /// render records: [feed, trip, centre dist, speed, accel, flags, delay, front-to-authority,
    /// pattern, id, path offset (points), path points]; the path is the track under the
    /// consist from 3 m behind its rear to 3 m ahead of its front, every <= 4 m
    pub fn write(&mut self, oe: f64, on: f64) {
        self.out.clear();
        self.out_path.clear();
        for tr in &self.trains {
            if tr.dead {
                continue;
            }
            let plan = &self.plans[tr.plan as usize];
            let mut f = 0u32;
            if matches!(tr.state, TState::Dwell | TState::Terminal) {
                f |= RF_DWELL;
                if !tr.dh {
                    f |= RF_DOORS;
                }
            }
            if tr.a < -0.15 || tr.v < 0.1 {
                f |= RF_BRAKE;
            }
            if tr.player {
                f |= RF_PLAYER;
            }
            if tr.penalty {
                f |= RF_PENALTY;
            }
            if tr.held_t > 1.0 {
                f |= RF_HELD;
            }
            if tr.horn {
                f |= RF_HORN;
            }
            let p0 = (self.out_path.len() / 3) as u32;
            let (a, b) = (tr.front - tr.len - 3.0, tr.front + 3.0);
            let n = ((b - a) / 4.0).ceil().max(1.0) as usize;
            for k in 0..=n {
                let r = a + (b - a) * k as f32 / n as f32;
                let q = plan.point(&self.net, r);
                self.out_path.extend_from_slice(&[(q[0] - oe) as f32, (q[1] - on) as f32, q[2] as f32]);
            }
            self.out.extend_from_slice(&[
                tr.feed as f32,
                if tr.state == TState::Parked { -1.0 } else { tr.trip as f32 },
                tr.front - tr.len * 0.5 - plan.pshift,
                tr.v,
                tr.a,
                f32::from_bits(f),
                tr.delay,
                tr.ma - tr.front,
                plan.local as f32,
                f32::from_bits(tr.id),
                p0 as f32,
                (n + 1) as f32,
            ]);
        }
        // pending trips inside the radius (hidden until placed) and trips finished in the sim
        // that the timetable still runs (hidden)
        let t = self.stime;
        for (fi, ts) in self.trip_state.iter().enumerate() {
            for (trip, s) in ts.iter().enumerate() {
                let hide = match s {
                    TripState::Pending(_) => true,
                    TripState::Finished => (t as i32) <= self.feeds[fi].trip_end[trip] + 60,
                    _ => false,
                };
                if hide {
                    let pl = self.feeds[fi].plan0 + self.feeds[fi].trip_pattern[trip];
                    self.out.extend_from_slice(&[fi as f32, trip as f32, 0.0, 0.0, 0.0, f32::from_bits(RF_PENDING), 0.0, 0.0, self.plans[pl as usize].local as f32, 0.0, 0.0, 0.0]);
                }
            }
        }
    }

    /// consistency of the reservation tables with the trains' held spans: (owner errors, dir-count errors)
    pub fn audit(&self) -> (usize, usize) {
        let mut cnt = vec![0u32; self.dirs.len()];
        let mut own = vec![NONE; self.owner.len()];
        let mut oe = 0;
        for tr in &self.trains {
            if tr.dead {
                continue;
            }
            let p = &self.plans[tr.plan as usize];
            for (k, &h) in tr.held.iter().enumerate() {
                if !h {
                    continue;
                }
                let s = p.spans[k];
                if s.kind == SP_DIR {
                    cnt[s.res as usize] += 1;
                } else {
                    if own[s.res as usize] != NONE && own[s.res as usize] != tr.id {
                        oe += 1;
                    }
                    own[s.res as usize] = tr.id;
                }
            }
        }
        for (r, &o) in self.owner.iter().enumerate() {
            if o != own[r] {
                oe += 1;
            }
        }
        let de = self.dirs.iter().zip(&cnt).filter(|(d, &c)| d.count as u32 != c).count();
        (oe, de)
    }

    /// id of the train (or 0 = direction lock) blocking train `ti`, if any
    pub fn blocker(&self, ti: usize) -> Option<u32> {
        let tr = &self.trains[ti];
        let p = &self.plans[tr.plan as usize];
        if tr.next >= p.spans.len() {
            return None;
        }
        let (want, target) = self.route_spans(ti, tr.next);
        for &q in &want {
            let s = p.spans[q];
            if !self.span_free(&s, tr.id) {
                return Some(if s.kind == SP_DIR { 0 } else { self.owner[s.res as usize] });
            }
        }
        // on sight: the berth beyond a junction is occupied
        if !signalled(p.mode) && want.iter().any(|&q| p.spans[q].kind == SP_JUNCTION) && target < p.length - 1.0 {
            if let Some(o) = self.body_occupant(ti, tr.plan as usize, target - tr.len - 4.0, (target + 2.0).min(p.length)) {
                return Some(self.trains[o].id);
            }
        }
        None
    }

    /// what train `ti` waits for: a route blocker, else (on sight) the vehicle just ahead
    pub fn wait_for(&self, ti: usize) -> Option<u32> {
        if let Some(b) = self.blocker(ti) {
            // a direction lock: the (first) train holding it the other way
            if b == 0 {
                return self.dir_holders(ti).first().copied().or(Some(0));
            }
            return Some(b);
        }
        let tr = &self.trains[ti];
        if tr.sight_gap.is_finite() && tr.sight_gap < 15.0 && tr.sight_id != NONE {
            return Some(tr.sight_id);
        }
        None
    }

    /// debugging: why a train at the end of its trip has not moved on
    pub fn term_debug(&self, ti: usize) -> String {
        let tr = &self.trains[ti];
        let f = &self.feeds[tr.feed as usize];
        let nx = f.trip_next.get(tr.trip as usize).copied().unwrap_or(-1);
        let st = if nx >= 0 { format!("{:?}", self.trip_state[tr.feed as usize][nx as usize]) } else { "-".into() };
        let pa = tr.plan;
        let pb = if nx >= 0 { f.plan0 + f.trip_pattern[nx as usize] } else { NONE };
        let legs = if nx >= 0 { format!("{:?}", self.dh_cache.get(&(pa, pb)).map(|v| v.as_ref().map(|l| l.len()))) } else { "-".into() };
        let nstart = if nx >= 0 { f.trip_start[nx as usize] as f64 - (self.stime + tr.toff) } else { 0.0 };
        format!("next trip {nx} {st} starts in {nstart:.0} s, same plan {}, turnback legs {legs}, blocking {}", pa == pb, self.blocking(ti))
    }

    /// debugging: the spans of train `ti`'s plan near its front (kind, range, res, held, edge dirs)
    pub fn spans_near(&self, ti: usize) -> String {
        let tr = &self.trains[ti];
        let p = &self.plans[tr.plan as usize];
        let mut out = String::new();
        for (k, s) in p.spans.iter().enumerate() {
            if s.r1 > tr.front - tr.len - 20.0 && s.r0 < tr.front + 300.0 {
                out += &format!(" {}:{}[{:.0},{:.0}]r{}{}", k, ["B", "J", "D"][s.kind as usize], s.r0, s.r1, s.res, if tr.held[k] { "*" } else { "" });
            }
        }
        let e: Vec<String> = p.items.iter().filter(|it| it.base < tr.front + 300.0 && it.base + self.net.e_len[it.edge as usize] > tr.front - tr.len).map(|it| format!("e{}{}{}", it.edge, if it.dir > 0 { "+" } else { "-" }, if self.bidir.get(it.edge as usize).copied().unwrap_or(0) == 3 { "(2way)" } else { "" })).collect();
        format!("{} | edges {} | pshift {} ssp near {:?}", out, e.join(" "), p.pshift, p.ssp.iter().filter(|&&f| f > tr.front - 50.0 && f < tr.front + 600.0).map(|f| f.round()).collect::<Vec<_>>())
    }

    /// debugging: trains holding the direction lock that blocks train `ti`
    pub fn dir_holders(&self, ti: usize) -> Vec<u32> {
        let tr = &self.trains[ti];
        let p = &self.plans[tr.plan as usize];
        if tr.next >= p.spans.len() {
            return Vec::new();
        }
        let (want, _) = self.route_spans(ti, tr.next);
        let mut out = Vec::new();
        for q in want {
            let s = p.spans[q];
            if s.kind == SP_DIR && !self.span_free(&s, tr.id) {
                for o in &self.trains {
                    let op = &self.plans[o.plan as usize];
                    if !o.dead && o.id != tr.id && op.spans.iter().enumerate().any(|(j, x)| o.held[j] && x.kind == SP_DIR && x.res == s.res) && !out.contains(&o.id) {
                        out.push(o.id);
                    }
                }
            }
        }
        out
    }

    /// debugging: what happens at the end of train `ti`'s trip
    pub fn debug_end(&mut self, ti: usize) -> String {
        let (fi, trip, pa) = (self.trains[ti].feed as usize, self.trains[ti].trip as usize, self.trains[ti].plan as usize);
        let nx = self.feeds[fi].trip_next[trip];
        if nx < 0 {
            return "no next trip".into();
        }
        let pb = (self.feeds[fi].plan0 + self.feeds[fi].trip_pattern[nx as usize]) as usize;
        let st = self.trip_state[fi][nx as usize];
        let a_end = self.plans[pa].locate(&self.net, self.plans[pa].length);
        let b0 = self.plans[pb].locate(&self.net, self.plans[pb].stop_front[0]);
        let tb = self.plan_turnback(pa, pb);
        format!("next {nx} state {st:?} pb {pb} ok {} A end {:?} B first {:?} turnback {:?}", self.plans[pb].ok, a_end, b0, tb)
    }

    pub fn debug_pullout(&mut self, fi: usize, trip: usize) -> String {
        let f = &self.feeds[fi];
        let pb = (f.plan0 + f.trip_pattern[trip]) as usize;
        let b = &self.plans[pb];
        let p0 = b.point(&self.net, b.stop_front[0]);
        let (mode, local, len) = (b.mode, b.local, b.len);
        let Some(di) = self.depot_near(fi as u32, mode_group(mode), p0[0], p0[1], 25000.0) else { return "no depot".into() };
        let d = &self.depots[di];
        let mut out = format!("trip {trip} first stop ({:.0},{:.0}) depot {di} at ({:.0},{:.0}) edges {} ", p0[0], p0[1], d.x, d.y, d.edges.len());
        let edges = d.edges.clone();
        let mut nplans = 0;
        for e in edges.into_iter().take(10) {
            if let Some(pp) = self.park_plan(e, len, fi as u32, local, mode) {
                nplans += 1;
                let r = self.plan_turnback(pp as usize, pb);
                out += &format!("[pp {pp} -> {:?}] ", r.map(|v| v.len()));
            }
        }
        out + &format!(" park plans {nplans}")
    }

    /// why is train `ti` held? (kind, resource, owner id / dir-lock state, span r0, front)
    pub fn why(&self, ti: usize) -> String {
        let tr = &self.trains[ti];
        let p = &self.plans[tr.plan as usize];
        if tr.next >= p.spans.len() {
            return format!("end of plan front {:.0} len {:.0} state {:?} stop {}/{}", tr.front, p.length, tr.state, tr.stop, p.stop_front.len());
        }
        let g = p.spans[tr.next];
        // first blocking span of the group or its direction runs
        let mut blocker = String::new();
        for k in g.g0 as usize..g.g1 as usize {
            let s0 = p.spans[k];
            let range: Vec<usize> = if s0.kind == SP_DIR { (k..=s0.chain_end as usize).filter(|&q| p.spans[q].kind == SP_DIR).collect() } else { vec![k] };
            for q in range {
                let s = p.spans[q];
                if !tr.held[q] && !self.span_free(&s, tr.id) {
                    let who = if s.kind == SP_DIR { format!("dir {} x{}", self.dirs[s.res as usize].dir, self.dirs[s.res as usize].count) } else { format!("owner {}", self.owner[s.res as usize]) };
                    blocker = format!("BLOCKER span {} kind {} [{:.0},{:.0}] {} | ", q, s.kind, s.r0, s.r1, who);
                    break;
                }
            }
            if !blocker.is_empty() {
                break;
            }
        }
        let mut out = blocker + &format!("mode {} front {:.0} ma {:.0} state {:?} next span {} [{:.0},{:.0}] group {}..{}: ", p.mode, tr.front, tr.ma, tr.state, tr.next, g.r0, g.r1, g.g0, g.g1);
        for k in g.g0 as usize..g.g1 as usize {
            let s = p.spans[k];
            let st = match s.kind {
                SP_DIR => format!("dir(res {} want {} have {} x{})", s.res, s.dir, self.dirs[s.res as usize].dir, self.dirs[s.res as usize].count),
                SP_JUNCTION => format!("junc(res {} owner {})", s.res, self.owner[s.res as usize] as i64),
                _ => format!("blk(res {} owner {})", s.res, self.owner[s.res as usize] as i64),
            };
            out += &format!("{} ", st);
        }
        out
    }

    /// no other train's body on plan `pi` between route distances a and b
    fn body_free(&self, me: usize, pi: usize, a: f32, b: f32) -> bool {
        self.body_occupant(me, pi, a, b).is_none()
    }

    /// is a parked train (other than `me`) standing anywhere on plan `pi`
    fn parked_on(&self, me: usize, pi: usize) -> bool {
        let len = self.plans[pi].length;
        let mut a = 0.0;
        while a < len {
            let b = (a + 400.0).min(len);
            if let Some(o) = self.body_occupant(me, pi, a, b) {
                if self.trains[o].state == TState::Parked {
                    return true;
                }
            }
            a = b;
        }
        false
    }

    /// the first other vehicle whose body lies on plan `pi` between route distances a..b
    fn body_occupant(&self, me: usize, pi: usize, a: f32, b: f32) -> Option<usize> {
        let plan = &self.plans[pi];
        let mut mine: Vec<(u32, f32, f32)> = Vec::new();
        let i0 = plan.items.partition_point(|it| it.base <= a).max(1) - 1;
        for it in &plan.items[i0..] {
            if it.base > b {
                break;
            }
            let l = self.net.e_len[it.edge as usize];
            let (r0, r1) = (it.base.max(a), (it.base + l).min(b));
            if r1 <= r0 {
                continue;
            }
            let (x0, x1) = (r0 - it.base, r1 - it.base);
            mine.push((it.edge, if it.dir > 0 { x0 } else { l - x1 }, if it.dir > 0 { x1 } else { l - x0 }));
        }
        for (tj, t) in self.trains.iter().enumerate() {
            if tj == me || t.dead {
                continue;
            }
            let p = &self.plans[t.plan as usize];
            let (a2, b2) = (t.front - t.len, t.front);
            let j0 = p.items.partition_point(|it| it.base <= a2).max(1) - 1;
            for it in &p.items[j0..] {
                if it.base > b2 {
                    break;
                }
                let l = self.net.e_len[it.edge as usize];
                let (r0, r1) = (it.base.max(a2), (it.base + l).min(b2));
                if r1 <= r0 {
                    continue;
                }
                let (x0, x1) = (r0 - it.base, r1 - it.base);
                let (s0, s1) = if it.dir > 0 { (x0, x1) } else { (l - x1, l - x0) };
                if mine.iter().any(|m| m.0 == it.edge && m.1 < s1 && m.2 > s0) {
                    return Some(tj);
                }
            }
        }
        None
    }

    /// On-sight following (streetcars): the nearest other vehicle body ahead on the
    /// edges of the train's route within braking distance + 60 m.
    fn sight(&mut self) {
        // occupancy: (edge, s0, s1, train index)
        let mut occ: Vec<(u32, f32, f32, u32)> = Vec::new();
        let mut any = false;
        for (ti, tr) in self.trains.iter().enumerate() {
            if tr.dead {
                continue;
            }
            let plan = &self.plans[tr.plan as usize];
            if !signalled(plan.mode) {
                any = true;
            }
            let (a, b) = (tr.front - tr.len, tr.front);
            let i0 = plan.items.partition_point(|it| it.base <= a).max(1) - 1;
            for it in &plan.items[i0..] {
                if it.base > b {
                    break;
                }
                let l = self.net.e_len[it.edge as usize];
                let (r0, r1) = (it.base.max(a), (it.base + l).min(b));
                if r1 <= r0 {
                    continue;
                }
                let (x0, x1) = (r0 - it.base, r1 - it.base);
                let (s0, s1) = if it.dir > 0 { (x0, x1) } else { (l - x1, l - x0) };
                occ.push((it.edge, s0, s1, ti as u32));
            }
        }
        if !any {
            return;
        }
        occ.sort_by(|a, b| a.0.cmp(&b.0));
        for ti in 0..self.trains.len() {
            let (plan_i, front, v, b) = {
                let t = &self.trains[ti];
                (t.plan as usize, t.front, t.v, t.dy.b)
            };
            let plan = &self.plans[plan_i];
            if signalled(plan.mode) {
                continue;
            }
            let look = v * v / (2.0 * b) + 60.0;
            let mut best = (f32::INFINITY, 0.0f32);
            let mut best_id = NONE;
            let i0 = plan.items.partition_point(|it| it.base <= front).max(1) - 1;
            for it in &plan.items[i0..] {
                if it.base > front + look {
                    break;
                }
                let l = self.net.e_len[it.edge as usize];
                let k0 = occ.partition_point(|o| o.0 < it.edge);
                for o in &occ[k0..] {
                    if o.0 != it.edge {
                        break;
                    }
                    if o.3 as usize == ti {
                        continue;
                    }
                    // near end of the other body in my route distance
                    let (x0, x1) = if it.dir > 0 { (o.1, o.2) } else { (l - o.2, l - o.1) };
                    let (r0, r1) = (it.base + x0, it.base + x1);
                    if r1 < front - 0.5 {
                        continue;
                    }
                    let mut gap = (r0 - front).max(0.0);
                    let mut ov = self.trains[o.3 as usize].v;
                    // coming the other way on the same track (a pull-in against the service
                    // direction): both close in, so each may only use half the gap
                    let op = &self.plans[self.trains[o.3 as usize].plan as usize];
                    if op.items.iter().any(|x| x.edge == it.edge && x.dir != it.dir) {
                        gap = (gap * 0.5 - 1.0).max(0.0);
                        ov = 0.0;
                    }
                    if gap < best.0 {
                        best = (gap, ov);
                        best_id = self.trains[o.3 as usize].id;
                    }
                }
            }
            let t = &mut self.trains[ti];
            t.sight_gap = best.0;
            t.sight_v = best.1;
            t.sight_id = best_id;
        }
    }

    /// streetcars / at-grade LRT: (train index, sample points ahead (x, y, distance), heading)
    /// for the caller's road checks; `step` = sample spacing (m)
    pub fn surface_probes(&self, step: f32, out: &mut Vec<(u32, f64, f64, f32, f32, f32)>) {
        out.clear();
        for (ti, tr) in self.trains.iter().enumerate() {
            if tr.dead || tr.player {
                continue;
            }
            let plan = &self.plans[tr.plan as usize];
            if !matches!(plan.mode, M_STREETCAR | M_LRT) {
                continue;
            }
            let look = tr.v * tr.v / (2.0 * tr.dy.b) + 30.0;
            let n = (look / step).ceil() as usize;
            let mut prev = plan.point(&self.net, tr.front - 2.0);
            for k in 0..=n {
                let d = k as f32 * step;
                let q = plan.point(&self.net, tr.front + d);
                let h = ((q[1] - prev[1]) as f32).atan2((q[0] - prev[0]) as f32);
                // skip tunnels / elevated sections (z far from the surface is checked by the caller)
                out.push((ti as u32, q[0], q[1], d, h, q[2] as f32));
                prev = q;
            }
        }
    }

    pub fn set_ext(&mut self, ti: usize, gap: f32, v: f32) {
        if let Some(t) = self.trains.get_mut(ti) {
            t.ext_gap = gap;
            t.ext_v = v;
        }
    }

    // ------------------------------------------------------------------ player

    /// the player takes over trip (feed, trip): its agent, or a new one at the scheduled position
    pub fn player_attach(&mut self, feed: u32, trip: u32) -> bool {
        self.player_release();
        let fi = self.feeds.iter().position(|f| f.id == feed);
        let Some(fi) = fi else { return false };
        if self.dirty {
            self.rebuild();
        }
        if trip as usize >= self.trip_state[fi].len() {
            return false;
        }
        let ti = match self.trip_state[fi][trip as usize] {
            TripState::Agent(id) => self.trains.iter().position(|t| t.id == id && !t.dead),
            _ => {
                let t = self.stime;
                if self.spawn(fi, trip as usize, t) {
                    Some(self.trains.len() - 1)
                } else {
                    None
                }
            }
        };
        let Some(ti) = ti else { return false };
        let tr = &mut self.trains[ti];
        tr.player = true;
        tr.state = TState::Run;
        tr.cmd = 0.0;
        self.player = Some(tr.id);
        true
    }

    /// A rider attaches to trip `trip` of feed `feed`: its train is placed now if the sim has
    /// not placed it yet (even in view: the camera is on it) and is kept (see `keep`).
    /// Returns the train id, NONE if the trip is not running.
    pub fn ride(&mut self, feed: u32, trip: u32) -> u32 {
        let Some(fi) = self.feeds.iter().position(|f| f.id == feed) else { return NONE };
        if self.dirty {
            self.rebuild();
        }
        if trip as usize >= self.trip_state[fi].len() {
            return NONE;
        }
        let id = match self.trip_state[fi][trip as usize] {
            TripState::Agent(id) if self.trains.iter().any(|t| t.id == id && !t.dead) => id,
            TripState::Done => return NONE,
            _ => {
                let t = self.stime;
                if !self.spawn(fi, trip as usize, t) {
                    return NONE;
                }
                self.trains[self.trains.len() - 1].id
            }
        };
        self.keep = id;
        id
    }

    pub fn player_release(&mut self) {
        if let Some(id) = self.player.take() {
            if let Some(tr) = self.trains.iter_mut().find(|t| t.id == id) {
                tr.player = false;
                tr.penalty = false;
                tr.emerg = false;
                // AI continues from here: next stop ahead
                let plan = &self.plans[tr.plan as usize];
                let mut s = tr.stop;
                while s < plan.stop_front.len() && plan.stop_front[s] < tr.front - 1.5 {
                    s += 1;
                }
                tr.stop = s.min(plan.stop_front.len().saturating_sub(1));
                tr.state = TState::Run;
            }
        }
    }

    pub fn player_input(&mut self, cmd: f32, emergency: bool) {
        if let Some(id) = self.player {
            if let Some(tr) = self.trains.iter_mut().find(|t| t.id == id) {
                tr.cmd = cmd.clamp(-1.0, 1.0);
                tr.emerg = emergency;
            }
        }
    }

    /// [active, feed, trip, centre, v, a, authority (m ahead of the front), aspect, penalty,
    ///  limit here, next lower limit, its distance, pattern, ATP warning countdown s (-1 none)]
    /// aspect: 0 clear, 1 approach (stop within 2 braking distances), 2 stop (authority ends
    /// within the braking distance + margin)
    pub fn player_state(&self) -> Vec<f64> {
        let Some(id) = self.player else { return vec![0.0; 14] };
        let Some(tr) = self.trains.iter().find(|t| t.id == id) else { return vec![0.0; 14] };
        let plan = &self.plans[tr.plan as usize];
        let ahead = tr.ma - tr.front;
        let bd = tr.v * tr.v / (2.0 * tr.dy.b);
        let aspect = if tr.ma >= plan.length - 0.01 {
            0.0
        } else if ahead < bd + tr.dy.margin + 30.0 {
            2.0
        } else if ahead < bd + 700.0 {
            1.0
        } else {
            0.0
        };
        let here = plan.limit_over(tr.front - tr.len, tr.front).min(tr.dy.vmax);
        let mut i = plan.vlim.partition_point(|p| p.0 <= tr.front);
        let (mut nl, mut nd) = (here as f64, 0.0);
        while i < plan.vlim.len() && plan.vlim[i].0 < tr.front + 2000.0 {
            if plan.vlim[i].1 < here - 0.5 {
                nl = plan.vlim[i].1 as f64;
                nd = (plan.vlim[i].0 - tr.front) as f64;
                break;
            }
            i += 1;
        }
        vec![
            1.0,
            self.feeds[tr.feed as usize].id as f64,
            tr.trip as f64,
            (tr.front - tr.len * 0.5 - plan.pshift) as f64,
            tr.v as f64,
            tr.a as f64,
            ahead as f64,
            aspect,
            if tr.penalty { 1.0 } else { 0.0 },
            here as f64,
            nl,
            nd,
            plan.local as f64,
            if tr.warn > 0.0 { (ATP_WARN - tr.warn).max(0.0) as f64 } else { -1.0 },
        ]
    }
}

// ============================================================================ tests

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A straight double-track line with a scissors-free crossover pair, built by hand:
    /// nodes 0..n along x, two tracks (east = edge ids even forward, west = odd backward).
    pub fn line_net(len: f32, parts: usize, kind: u8) -> RailNet {
        // single track of `parts` edges: node i at x = i * len/parts
        let n = parts + 1;
        let mut n_xyz = Vec::new();
        for i in 0..n {
            n_xyz.extend_from_slice(&[i as f32 * len / parts as f32, 0.0, 0.0]);
        }
        let n_flags = vec![0u8; n];
        let e_from: Vec<u32> = (0..parts as u32).collect();
        let e_to: Vec<u32> = (1..=parts as u32).collect();
        let mut e_off = vec![0u32];
        let mut e_xyz = Vec::new();
        for i in 0..parts {
            let x0 = i as f32 * len / parts as f32;
            let x1 = (i + 1) as f32 * len / parts as f32;
            e_xyz.extend_from_slice(&[x0, 0.0, 0.0, x1, 0.0, 0.0]);
            e_off.push(e_off.last().unwrap() + 2);
        }
        let e_vlim = vec![60u8; e_xyz.len() / 3];
        let e_len = vec![len / parts as f32; parts];
        let e_kind = vec![kind; parts];
        let e_svc = vec![0u8; parts];
        let e_dir = vec![3u8; parts];
        let e_flags = vec![0u8; parts];
        // moves: edge i end 1 -> edge i+1 end 0 and back
        let mut c_off = vec![0u32];
        let mut c_to = Vec::new();
        for e in 0..parts {
            for k in 0..2 {
                if k == 1 && e + 1 < parts {
                    c_to.push(2 * (e as u32 + 1));
                }
                if k == 0 && e > 0 {
                    c_to.push(2 * (e as u32 - 1) + 1);
                }
                c_off.push(c_to.len() as u32);
            }
        }
        RailNet::load(&n_xyz, &n_flags, &e_from, &e_to, &e_off, &e_xyz, &e_vlim, &e_len, &e_kind, &e_svc, &e_dir, &e_flags, &c_off, &c_to)
    }

    /// feed with patterns over a line net: each pattern = (edges as 2*e+rev, start offset,
    /// stop centres, len); trips = (pattern, start time, arrival offsets, dwell)
    pub struct PatSpec {
        pub edges: Vec<u32>,
        pub start: f32,
        pub stops: Vec<f32>,
        pub len: f32,
        pub mode: u8,
    }

    pub fn add_feed(sim: &mut RailSim, id: u32, pats: &[PatSpec], trips: &[(u32, i32, Vec<u16>, Vec<u16>, i32)]) {
        let mut pat_mode = vec![];
        let mut pat_len = vec![];
        let mut rflags = vec![];
        let mut rstart = vec![];
        let mut roff = vec![0u32];
        let mut redge = vec![];
        let mut soff = vec![0u32];
        let mut sd = vec![];
        let mut sf = vec![];
        for p in pats {
            pat_mode.push(p.mode);
            pat_len.push(p.len);
            rflags.push(1);
            rstart.push(p.start);
            redge.extend_from_slice(&p.edges);
            roff.push(redge.len() as u32);
            sd.extend_from_slice(&p.stops);
            sf.extend(p.stops.iter().map(|_| 0u8));
            soff.push(sd.len() as u32);
        }
        let mut tp_off = vec![0u32];
        let mut tp_arr = vec![];
        let mut tp_dw = vec![];
        let mut ts = vec![];
        let mut tpat = vec![];
        let mut ttp = vec![];
        let mut tnext = vec![];
        let mut order: Vec<usize> = (0..trips.len()).collect();
        order.sort_by_key(|&i| trips[i].1);
        for &i in &order {
            let (p, st, arr, dw, nx) = &trips[i];
            tp_arr.extend_from_slice(arr);
            tp_dw.extend_from_slice(dw);
            tp_off.push(tp_arr.len() as u32);
            ts.push(*st);
            tpat.push(*p);
            ttp.push((tp_off.len() - 2) as u32);
            tnext.push(*nx);
        }
        sim.add_feed(id, &pat_mode, &pat_len, &rflags, &rstart, &roff, &redge, &soff, &sd, &sf, &tp_off, &tp_arr, &tp_dw, &ts, &tpat, &ttp, &tnext);
    }

    fn run(sim: &mut RailSim, t0: f64, secs: f64, dt: f32) -> (u32, usize) {
        let mut t = t0;
        let mut max_trains = 0;
        let mut ov = 0;
        while t < t0 + secs {
            sim.step(dt, t);
            ov += sim.check();
            max_trains = max_trains.max(sim.trains.len());
            t += dt as f64;
        }
        (ov, max_trains)
    }

    fn east(parts: usize, len: f32) -> Vec<u32> {
        (0..parts as u32).map(|e| 2 * e).collect::<Vec<_>>().into_iter().take_while(|_| len > 0.0).collect()
    }
    fn west(parts: usize) -> Vec<u32> {
        (0..parts as u32).rev().map(|e| 2 * e + 1).collect()
    }

    #[test]
    fn following_trains_never_overlap() {
        // 6 km single line, subway blocks; three trains 40 s apart with an intermediate stop
        let mut sim = RailSim::default();
        sim.set_net(line_net(6000.0, 12, K_SUBWAY));
        let len = 138.0;
        let pat = PatSpec { edges: east(12, 6000.0), start: 0.0, stops: vec![len / 2.0 + 20.0, 3000.0, 5800.0], len, mode: M_SUBWAY };
        let trips: Vec<_> = (0..3).map(|k| (0u32, 30000 + k * 40, vec![0u16, 150, 300], vec![20u16, 20, 0], -1)).collect();
        add_feed(&mut sim, 1, &[pat], &trips);
        sim.focus = (3000.0, 0.0);
        let (ov, mx) = run(&mut sim, 29990.0, 900.0, 0.2);
        assert_eq!(ov, 0, "overlaps");
        assert_eq!(sim.overruns, 0, "authority overruns");
        assert!(mx >= 2, "trains ran concurrently ({mx})");
        // every trip reached its terminal
        assert!(sim.trip_state[0].iter().all(|s| matches!(s, TripState::Done | TripState::Finished | TripState::Agent(_))), "{:?}", sim.trip_state[0]);
    }

    #[test]
    fn opposing_trains_on_single_track_do_not_meet() {
        let mut sim = RailSim::default();
        sim.set_net(line_net(4000.0, 8, K_RAIL));
        let len = 150.0;
        let pe = PatSpec { edges: east(8, 4000.0), start: 0.0, stops: vec![len / 2.0 + 20.0, 3900.0], len, mode: M_COMMUTER };
        let pw = PatSpec { edges: west(8), start: 0.0, stops: vec![len / 2.0 + 20.0, 3900.0], len, mode: M_COMMUTER };
        let trips = vec![(0u32, 30000, vec![0u16, 300], vec![30u16, 0], -1), (1u32, 30000, vec![0u16, 300], vec![30u16, 0], -1)];
        add_feed(&mut sim, 1, &[pe, pw], &trips);
        sim.focus = (2000.0, 0.0);
        let (ov, _) = run(&mut sim, 29995.0, 1500.0, 0.2);
        assert_eq!(ov, 0);
        assert_eq!(sim.overruns, 0);
        // both completed (one after the other)
        assert!(sim.trip_state[0].iter().all(|s| matches!(s, TripState::Done | TripState::Finished)), "{:?}", sim.trip_state[0]);
    }

    #[test]
    fn never_departs_early() {
        let mut sim = RailSim::default();
        sim.set_net(line_net(3000.0, 6, K_SUBWAY));
        let len = 138.0;
        let pat = PatSpec { edges: east(6, 3000.0), start: 0.0, stops: vec![len / 2.0 + 20.0, 1500.0, 2900.0], len, mode: M_SUBWAY };
        // very slack timetable: 600 s to the middle stop, depart 60 s after arrival
        add_feed(&mut sim, 1, &[pat], &[(0u32, 30000, vec![0u16, 600, 1300], vec![10u16, 60, 0], -1)]);
        sim.focus = (1500.0, 0.0);
        let mut t = 29999.0;
        let mut left_middle = None;
        while t < 31500.0 {
            sim.step(0.2, t);
            if let Some(tr) = sim.trains.first() {
                if tr.stop >= 2 && left_middle.is_none() {
                    left_middle = Some(t);
                }
            }
            t += 0.2;
        }
        let tm = left_middle.expect("left the middle stop");
        assert!(tm >= 30660.0 - 0.5, "departed early at {tm}");
    }

    #[test]
    fn player_is_protected_behind_ai_train() {
        let mut sim = RailSim::default();
        sim.set_net(line_net(6000.0, 12, K_SUBWAY));
        let len = 138.0;
        let pat = PatSpec { edges: east(12, 6000.0), start: 0.0, stops: vec![len / 2.0 + 20.0, 5800.0], len, mode: M_SUBWAY };
        // AI train ahead (departs first, very slow timetable so it dwells), player behind
        add_feed(&mut sim, 1, &[pat], &[(0u32, 30000, vec![0u16, 2000], vec![10u16, 0], -1), (0u32, 30060, vec![0u16, 2000], vec![10u16, 0], -1)]);
        sim.focus = (3000.0, 0.0);
        run(&mut sim, 29999.0, 30.0, 0.2);
        let mut t = 30029.0;
        // wait until the second trip is placed
        while sim.trip_state[0][1] == TripState::None || matches!(sim.trip_state[0][1], TripState::Pending(_)) {
            sim.step(0.2, t);
            t += 0.2;
            assert!(t < 30300.0, "second trip never placed");
        }
        assert!(sim.player_attach(1, 1));
        let mut pen = false;
        for _ in 0..3000 {
            sim.player_input(1.0, false);
            sim.step(0.2, t);
            assert_eq!(sim.check(), 0);
            pen |= sim.player_state()[8] > 0.5;
            t += 0.2;
        }
        assert!(pen, "ATP never intervened");
        assert_eq!(sim.overlaps, 0);
    }
}
