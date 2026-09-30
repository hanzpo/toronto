//! Streaming road graph: tiles are added/removed at runtime, nodes are
//! unified by OSM id, each edge yields one directed *link* per travel
//! direction with its lane count. Slots are recycled through free lists and
//! carry a generation so agents can detect that their link disappeared.

use std::collections::HashMap;
use std::f32::consts::PI;

use crate::demand::{FLAG_LINK, FLAG_TUNNEL};
use crate::rng::{hash01, mix};
use crate::signal::{axis_diff, SignalPlan};

pub const NONE: u32 = u32::MAX;
pub const LANE_W: f32 = 3.5;
pub const MAXL: usize = 6;
pub const TILE: f64 = 1024.0;
const GRID: f64 = 64.0;
const SIGNAL_CLUSTER: f64 = 45.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Control {
    /// plain way split / merge: no control
    Free,
    Signal,
    /// stop sign: minor approaches (or all, if equal) must stop
    Stop,
    /// unsignalised junction: minor approaches yield
    Priority,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Turn {
    Straight,
    Right,
    Left,
    U,
}

#[inline]
pub fn wrap_pi(a: f32) -> f32 {
    let mut x = (a + PI).rem_euclid(2.0 * PI) - PI;
    if x < -PI {
        x += 2.0 * PI;
    }
    x
}

/// Turn class from the heading at the end of the incoming link to the heading
/// at the start of the outgoing one (radians CCW from east).
pub fn classify_turn(b_in: f32, b_out: f32) -> Turn {
    let d = wrap_pi(b_out - b_in);
    let deg = d.to_degrees();
    if deg.abs() > 150.0 {
        Turn::U
    } else if deg > 35.0 {
        Turn::Left
    } else if deg < -35.0 {
        Turn::Right
    } else {
        Turn::Straight
    }
}

pub struct Node {
    pub alive: bool,
    pub osm: u64,
    pub x: f64,
    pub y: f64,
    pub z: f32,
    pub flags: u8,
    pub refs: u32,
    pub edges: Vec<u32>,
    pub ins: Vec<u32>,
    pub outs: Vec<u32>,
    pub control: Control,
    pub plan: SignalPlan,
    /// stop line distance from the node centre (m)
    pub setback: f32,
    /// pedestrian corner distance from the node centre along each edge (m)
    pub ped_trim: f32,
    pub best_class: u8,
    /// every class among approaches equal (all-way stop)
    pub uniform: bool,
    pub dirty: bool,
    /// reservation of the junction box (monotonic sim s) and holder link
    pub busy_until: f64,
    pub busy_link: u32,
    /// conflict zone: controlled nodes joined by very short links (dual
    /// carriageways, split junctions) share one zone = index of its root node
    pub zone: u32,
}

pub struct Edge {
    pub alive: bool,
    pub gen: u32,
    pub tile: (i32, i32),
    pub idx: u32,
    pub from: u32,
    pub to: u32,
    pub pts: Vec<[f64; 3]>,
    pub cum: Vec<f32>,
    pub len: f32,
    pub class: u8,
    pub lanes_f: u8,
    pub lanes_b: u8,
    pub speed: f32,
    pub flags: u8,
    pub bottleneck: f32,
    pub links: [u32; 2],
    pub half_w: f32,
    /// lateral offset of the sidewalk centre from the edge centreline
    pub ped_off: f32,
    pub ped_ok: bool,
    /// sidewalk sides that are walkable: 1 = right of from→to, 2 = left
    /// (a side is dropped when it lies in another carriageway or a median)
    pub ped_sides: u8,
    /// sides with a sidewalk according to OSM tags (same bits)
    pub ped_tag: u8,
}

pub struct Link {
    pub alive: bool,
    pub gen: u32,
    pub edge: u32,
    pub rev: bool,
    pub from: u32,
    pub to: u32,
    pub lanes: u8,
    pub len: f32,
    pub speed: f32,
    pub class: u8,
    pub flags: u8,
    pub bearing_start: f32,
    pub bearing_end: f32,
    /// sorted-order bookkeeping, valid when `stamp` == current step
    pub stamp: u32,
    pub head: [u32; MAXL],
    pub tail: [u32; MAXL],
    /// measured speed accumulation (for congestion analytics)
    pub spd_sum: f32,
    pub spd_n: u32,
}

#[derive(Default)]
pub struct Graph {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub links: Vec<Link>,
    free_nodes: Vec<u32>,
    free_edges: Vec<u32>,
    free_links: Vec<u32>,
    pub node_map: HashMap<u64, u32>,
    pub tiles: HashMap<(i32, i32), Vec<u32>>,
    grid: HashMap<(i32, i32), Vec<u32>>,
    signal_grid: HashMap<(i32, i32), Vec<u32>>,
    /// bumps whenever the set of links changes
    pub version: u32,
    pub live_links: u32,
    pub live_edges: u32,
}

pub struct TileData<'a> {
    pub tx: i32,
    pub ty: i32,
    pub n_id: &'a [f64],
    pub n_xyz: &'a [f32],
    pub n_flags: &'a [u8],
    pub e_from: &'a [u32],
    pub e_to: &'a [u32],
    pub e_off: &'a [u32],
    pub e_xyz: &'a [f32],
    pub e_class: &'a [u8],
    pub e_lanes_fwd: &'a [u8],
    pub e_lanes_bwd: &'a [u8],
    pub e_speed: &'a [f32],
    pub e_flags: &'a [u8],
    pub bottleneck: &'a [f32],
    /// carriageway width (m) per edge; empty when the graph has no widths
    pub e_width: &'a [f32],
    /// OSM sidewalk code per edge (as render `r_side`); may be empty
    pub e_side: &'a [u8],
}

/// rendered sidewalk width per road class (app/src/workers/roads.ts SIDEWALK_W)
pub const SIDEWALK_W: [f32; 7] = [0.0, 0.0, 3.2, 2.8, 2.4, 1.9, 0.0];
/// rendered default road width per class when a way has none (ROAD_W_DEFAULT)
pub const ROAD_W_DEFAULT: [f32; 7] = [24.0, 18.0, 14.0, 12.0, 10.0, 8.0, 5.0];

/// A point on a link: world position, heading (CCW from east), pitch.
#[derive(Clone, Copy, Debug, Default)]
pub struct Pose {
    pub x: f64,
    pub y: f64,
    pub z: f32,
    pub h: f32,
    pub p: f32,
}

#[inline]
fn cell(x: f64, y: f64, size: f64) -> (i32, i32) {
    ((x / size).floor() as i32, (y / size).floor() as i32)
}

impl Graph {
    pub fn has_tile(&self, tx: i32, ty: i32) -> bool {
        self.tiles.contains_key(&(tx, ty))
    }

    fn alloc_node(&mut self, n: Node) -> u32 {
        if let Some(i) = self.free_nodes.pop() {
            self.nodes[i as usize] = n;
            i
        } else {
            self.nodes.push(n);
            (self.nodes.len() - 1) as u32
        }
    }

    fn alloc_edge(&mut self, mut e: Edge) -> u32 {
        if let Some(i) = self.free_edges.pop() {
            e.gen = self.edges[i as usize].gen.wrapping_add(1);
            self.edges[i as usize] = e;
            i
        } else {
            self.edges.push(e);
            (self.edges.len() - 1) as u32
        }
    }

    fn alloc_link(&mut self, mut l: Link) -> u32 {
        if let Some(i) = self.free_links.pop() {
            l.gen = self.links[i as usize].gen.wrapping_add(1);
            self.links[i as usize] = l;
            i
        } else {
            self.links.push(l);
            (self.links.len() - 1) as u32
        }
    }

    pub fn add_tile(&mut self, d: &TileData) {
        if self.has_tile(d.tx, d.ty) {
            return;
        }
        let x0 = d.tx as f64 * TILE;
        let y0 = d.ty as f64 * TILE;
        let nn = d.n_id.len();
        let mut local = Vec::with_capacity(nn);
        for i in 0..nn {
            let osm = d.n_id[i] as u64;
            let idx = if let Some(&g) = self.node_map.get(&osm) {
                self.nodes[g as usize].refs += 1;
                g
            } else {
                let x = x0 + d.n_xyz[i * 3] as f64;
                let y = y0 + d.n_xyz[i * 3 + 1] as f64;
                let g = self.alloc_node(Node {
                    alive: true,
                    osm,
                    x,
                    y,
                    z: d.n_xyz[i * 3 + 2],
                    flags: d.n_flags[i],
                    refs: 1,
                    edges: Vec::new(),
                    ins: Vec::new(),
                    outs: Vec::new(),
                    control: Control::Free,
                    plan: SignalPlan::default(),
                    setback: 0.0,
                    ped_trim: 0.0,
                    best_class: 6,
                    uniform: true,
                    dirty: true,
                    busy_until: -1.0,
                    busy_link: NONE,
                    zone: NONE,
                });
                self.node_map.insert(osm, g);
                if d.n_flags[i] & 1 != 0 {
                    self.signal_grid.entry(cell(x, y, SIGNAL_CLUSTER)).or_default().push(g);
                }
                g
            };
            local.push(idx);
        }
        let ne = d.e_from.len();
        let mut tile_edges = Vec::with_capacity(ne);
        for e in 0..ne {
            let a = d.e_off[e] as usize;
            let b = d.e_off[e + 1] as usize;
            if b < a + 2 {
                continue;
            }
            let mut pts = Vec::with_capacity(b - a);
            let mut cum = Vec::with_capacity(b - a);
            let mut acc = 0.0f32;
            for k in a..b {
                let p = [x0 + d.e_xyz[k * 3] as f64, y0 + d.e_xyz[k * 3 + 1] as f64, d.e_xyz[k * 3 + 2] as f64];
                if let Some(q) = pts.last() {
                    let q: &[f64; 3] = q;
                    acc += ((p[0] - q[0]).hypot(p[1] - q[1])) as f32;
                }
                pts.push(p);
                cum.push(acc);
            }
            if acc < 0.5 {
                continue;
            }
            let from = local[d.e_from[e] as usize];
            let to = local[d.e_to[e] as usize];
            if from == to {
                continue;
            }
            let class = d.e_class[e].min(6);
            let lanes_f = d.e_lanes_fwd[e].clamp(1, MAXL as u8);
            let lanes_b = d.e_lanes_bwd[e].min(MAXL as u8);
            let flags = d.e_flags[e];
            // carriageway as rendered (render tiles draw r_width, curbs + sidewalks outside it)
            let w = d.e_width.get(e).copied().filter(|&w| w > 0.0 && w < 80.0).unwrap_or(ROAD_W_DEFAULT[class as usize]);
            let road_hw = w.max(if class <= 1 { 10.0 } else { 2.0 }) * 0.5;
            let half_w = ((lanes_f + lanes_b) as f32 * LANE_W * 0.5 + 0.3).max(road_hw);
            // sidewalk centre line: middle of the rendered sidewalk (service roads: just off the edge)
            let ped_off = if (2..=5).contains(&class) { road_hw + SIDEWALK_W[class as usize] * 0.5 } else { road_hw + 1.2 };
            let ped_ok = (2..=6).contains(&class) && flags & (FLAG_LINK | FLAG_TUNNEL | 2) == 0;
            let ped_tag = match d.e_side.get(e).copied().unwrap_or(0) {
                1 => 0,
                2 => 2,
                3 => 1,
                _ => 3,
            };
            let eid = self.alloc_edge(Edge {
                alive: true,
                gen: 0,
                tile: (d.tx, d.ty),
                idx: e as u32,
                from,
                to,
                pts,
                cum,
                len: acc,
                class,
                lanes_f,
                lanes_b,
                speed: d.e_speed[e].clamp(3.0, 36.0),
                flags,
                bottleneck: d.bottleneck.get(e).copied().unwrap_or(0.0),
                links: [NONE, NONE],
                half_w,
                ped_off,
                ped_ok,
                ped_sides: ped_tag,
                ped_tag,
            });
            // links
            let mut links = [NONE, NONE];
            for dir in 0..2 {
                let lanes = if dir == 0 { lanes_f } else { lanes_b };
                if lanes == 0 {
                    continue;
                }
                let rev = dir == 1;
                let (lf, lt) = if rev { (to, from) } else { (from, to) };
                let (bs, be) = self.edge_bearings(eid, rev);
                let l = self.alloc_link(Link {
                    alive: true,
                    gen: 0,
                    edge: eid,
                    rev,
                    from: lf,
                    to: lt,
                    lanes,
                    len: acc,
                    speed: d.e_speed[e].clamp(3.0, 36.0),
                    class,
                    flags,
                    bearing_start: bs,
                    bearing_end: be,
                    stamp: 0,
                    head: [NONE; MAXL],
                    tail: [NONE; MAXL],
                    spd_sum: 0.0,
                    spd_n: 0,
                });
                links[dir] = l;
                self.nodes[lf as usize].outs.push(l);
                self.nodes[lt as usize].ins.push(l);
                self.live_links += 1;
            }
            self.edges[eid as usize].links = links;
            self.nodes[from as usize].edges.push(eid);
            self.nodes[to as usize].edges.push(eid);
            self.nodes[from as usize].dirty = true;
            self.nodes[to as usize].dirty = true;
            self.grid_insert(eid);
            tile_edges.push(eid);
            self.live_edges += 1;
        }
        self.refresh_sidewalks(d.tx, d.ty, &tile_edges);
        self.tiles.insert((d.tx, d.ty), tile_edges);
        self.version = self.version.wrapping_add(1);
        self.refresh();
    }

    /// Re-derive walkable sidewalk sides for a new tile's edges and the
    /// already-loaded edges along its border.
    fn refresh_sidewalks(&mut self, tx: i32, ty: i32, new_edges: &[u32]) {
        let mut todo: Vec<u32> = new_edges.to_vec();
        let (x0, y0) = (tx as f64 * TILE, ty as f64 * TILE);
        let (c0x, c0y) = cell(x0 - 60.0, y0 - 60.0, GRID);
        let (c1x, c1y) = cell(x0 + TILE + 60.0, y0 + TILE + 60.0, GRID);
        let (i0x, i0y) = cell(x0 + 60.0, y0 + 60.0, GRID);
        let (i1x, i1y) = cell(x0 + TILE - 60.0, y0 + TILE - 60.0, GRID);
        for cx in c0x..=c1x {
            for cy in c0y..=c1y {
                if cx > i0x && cx < i1x && cy > i0y && cy < i1y {
                    continue;
                }
                if let Some(v) = self.grid.get(&(cx, cy)) {
                    for &e in v {
                        if self.edges[e as usize].tile != (tx, ty) && !todo.contains(&e) {
                            todo.push(e);
                        }
                    }
                }
            }
        }
        let mut near = Vec::new();
        for e in todo {
            let sides = self.sidewalk_sides(e, &mut near);
            self.edges[e as usize].ped_sides = sides;
        }
    }

    /// Which sidewalk sides of edge `eid` are usable (see `Edge::ped_sides`).
    pub fn sidewalk_sides(&self, eid: u32, near: &mut Vec<u32>) -> u8 {
        let e = &self.edges[eid as usize];
        if !e.alive || !e.ped_ok {
            return 0;
        }
        let one_way = e.lanes_b == 0;
        let mut sides = 0u8;
        for (bit, side) in [(1u8, 1.0f32), (2u8, -1.0f32)] {
            if e.ped_tag & bit == 0 {
                continue;
            }
            let mut bad = 0;
            let mut n = 0;
            for k in 0..5 {
                let s = e.len * (0.1 + 0.2 * k as f32);
                let q = self.edge_pose(e, s, side * e.ped_off, false);
                n += 1;
                self.edges_near(q.x, q.y, 16.0, near);
                for &o in near.iter() {
                    if o == eid {
                        continue;
                    }
                    let oe = &self.edges[o as usize];
                    if !oe.alive || oe.class > 5 || oe.flags & (FLAG_TUNNEL | 2) != 0 {
                        continue;
                    }
                    // cross streets meeting this edge at its ends are crossed at corners
                    if oe.from == e.from || oe.from == e.to || oe.to == e.from || oe.to == e.to {
                        continue;
                    }
                    let (so, lat, _, _) = self.project_on_edge(o, q.x, q.y);
                    if so > 1.0 && so < oe.len - 1.0 && lat.abs() < oe.half_w + 0.6 {
                        bad += 1;
                        break;
                    }
                }
            }
            if bad * 3 >= n {
                continue; // mostly inside another carriageway
            }
            // dual carriageway: no sidewalk in the median between the two one-way halves
            if one_way && e.class <= 4 {
                let m = self.edge_pose(e, e.len * 0.5, 0.0, false);
                let (rx, ry) = (m.h.sin(), -m.h.cos()); // right normal
                self.edges_near(m.x, m.y, 45.0, near);
                let mut median = false;
                for &o in near.iter() {
                    let oe = &self.edges[o as usize];
                    if o == eid || !oe.alive || oe.lanes_b != 0 || oe.class > 4 {
                        continue;
                    }
                    let (so, _, _, ho) = self.project_on_edge(o, m.x, m.y);
                    if so <= 0.5 || so >= oe.len - 0.5 || (wrap_pi(ho - m.h)).abs() < 2.6 {
                        continue;
                    }
                    let p = self.edge_pose(oe, so, 0.0, false);
                    let (dx, dy) = ((p.x - m.x) as f32, (p.y - m.y) as f32);
                    let lat = dx * rx + dy * ry;
                    let along = dx * m.h.cos() + dy * m.h.sin();
                    if lat * side > 0.0 && lat.abs() < 45.0 && along.abs() < 20.0 {
                        median = true;
                        break;
                    }
                }
                if median {
                    continue;
                }
            }
            sides |= bit;
        }
        sides
    }

    pub fn remove_tile(&mut self, tx: i32, ty: i32) {
        let Some(edges) = self.tiles.remove(&(tx, ty)) else { return };
        for eid in edges {
            self.grid_remove(eid);
            let (from, to, links) = {
                let e = &mut self.edges[eid as usize];
                e.alive = false;
                e.pts = Vec::new();
                e.cum = Vec::new();
                (e.from, e.to, e.links)
            };
            for l in links {
                if l == NONE {
                    continue;
                }
                let (lf, lt) = {
                    let lk = &mut self.links[l as usize];
                    lk.alive = false;
                    (lk.from, lk.to)
                };
                self.nodes[lf as usize].outs.retain(|&x| x != l);
                self.nodes[lt as usize].ins.retain(|&x| x != l);
                self.free_links.push(l);
                self.live_links -= 1;
            }
            for n in [from, to] {
                let nd = &mut self.nodes[n as usize];
                nd.edges.retain(|&x| x != eid);
                nd.dirty = true;
            }
            self.free_edges.push(eid);
            self.live_edges -= 1;
        }
        // drop nodes this tile referenced
        let x0 = tx as f64 * TILE;
        let y0 = ty as f64 * TILE;
        let _ = (x0, y0);
        let mut dead = Vec::new();
        for (&osm, &g) in self.node_map.iter() {
            let n = &self.nodes[g as usize];
            if n.edges.is_empty() {
                dead.push((osm, g));
            }
        }
        for (osm, g) in dead {
            self.node_map.remove(&osm);
            let (x, y, sig) = {
                let n = &mut self.nodes[g as usize];
                n.alive = false;
                n.refs = 0;
                (n.x, n.y, n.flags & 1 != 0)
            };
            if sig {
                if let Some(v) = self.signal_grid.get_mut(&cell(x, y, SIGNAL_CLUSTER)) {
                    v.retain(|&k| k != g);
                }
            }
            self.free_nodes.push(g);
        }
        self.version = self.version.wrapping_add(1);
        self.refresh();
    }

    fn edge_bearings(&self, eid: u32, rev: bool) -> (f32, f32) {
        let e = &self.edges[eid as usize];
        let n = e.pts.len();
        // measure over ~10 m for robustness against tiny kinks
        let probe = 10.0f32.min(e.len * 0.5);
        let pa = self.edge_point(e, probe);
        let pb = self.edge_point(e, e.len - probe);
        let s = e.pts[0];
        let t = e.pts[n - 1];
        let b_start = ((pa[1] - s[1]) as f32).atan2((pa[0] - s[0]) as f32);
        let b_end = ((t[1] - pb[1]) as f32).atan2((t[0] - pb[0]) as f32);
        if rev {
            (wrap_pi(b_end + PI), wrap_pi(b_start + PI))
        } else {
            (b_start, b_end)
        }
    }

    fn edge_point(&self, e: &Edge, s: f32) -> [f64; 3] {
        let k = seg_index(&e.cum, s);
        let (a, b) = (e.pts[k], e.pts[k + 1]);
        let l = e.cum[k + 1] - e.cum[k];
        let t = if l > 1e-6 { ((s - e.cum[k]) / l).clamp(0.0, 1.0) } else { 0.0 } as f64;
        [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
    }

    fn grid_cells(&self, eid: u32) -> Vec<(i32, i32)> {
        let e = &self.edges[eid as usize];
        let mut v: Vec<(i32, i32)> = Vec::new();
        for w in e.pts.windows(2) {
            let n = (((w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1])) / (GRID * 0.5)).ceil().max(1.0) as usize;
            for k in 0..=n {
                let t = k as f64 / n as f64;
                let c = cell(w[0][0] + (w[1][0] - w[0][0]) * t, w[0][1] + (w[1][1] - w[0][1]) * t, GRID);
                if !v.contains(&c) {
                    v.push(c);
                }
            }
        }
        v
    }

    fn grid_insert(&mut self, eid: u32) {
        for c in self.grid_cells(eid) {
            self.grid.entry(c).or_default().push(eid);
        }
    }

    fn grid_remove(&mut self, eid: u32) {
        for c in self.grid_cells(eid) {
            if let Some(v) = self.grid.get_mut(&c) {
                v.retain(|&x| x != eid);
                if v.is_empty() {
                    self.grid.remove(&c);
                }
            }
        }
    }

    /// edges whose geometry passes within ~`r` of (x, y)
    pub fn edges_near(&self, x: f64, y: f64, r: f64, out: &mut Vec<u32>) {
        out.clear();
        let (c0x, c0y) = cell(x - r, y - r, GRID);
        let (c1x, c1y) = cell(x + r, y + r, GRID);
        for cx in c0x..=c1x {
            for cy in c0y..=c1y {
                if let Some(v) = self.grid.get(&(cx, cy)) {
                    for &e in v {
                        if !out.contains(&e) {
                            out.push(e);
                        }
                    }
                }
            }
        }
    }

    /// Closest point on an edge: (s along edge, signed lateral offset (+ = right of from→to), z, heading from→to)
    pub fn project_on_edge(&self, eid: u32, x: f64, y: f64) -> (f32, f32, f32, f32) {
        let e = &self.edges[eid as usize];
        let mut best = (f64::INFINITY, 0.0f32, 0.0f32, 0.0f32, 0.0f32);
        for k in 0..e.pts.len() - 1 {
            let (a, b) = (e.pts[k], e.pts[k + 1]);
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            let l2 = dx * dx + dy * dy;
            let t = if l2 > 1e-9 { (((x - a[0]) * dx + (y - a[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
            let px = a[0] + dx * t;
            let py = a[1] + dy * t;
            let d2 = (x - px).powi(2) + (y - py).powi(2);
            if d2 < best.0 {
                let l = l2.sqrt();
                // right-hand normal of (dx, dy) is (dy, -dx)
                let lat = if l > 1e-9 { ((x - a[0]) * dy - (y - a[1]) * dx) / l } else { 0.0 };
                let z = a[2] + (b[2] - a[2]) * t;
                best = (d2, e.cum[k] + (e.cum[k + 1] - e.cum[k]) * t as f32, lat as f32, z as f32, (dy as f32).atan2(dx as f32));
            }
        }
        (best.1, best.2, best.3, best.4)
    }

    /// Lateral offset (right of travel direction) of a lane's centre; lane 0 = curb lane.
    #[inline]
    pub fn lane_offset(&self, l: &Link, lane: u8) -> f32 {
        let e = &self.edges[l.edge as usize];
        let n = l.lanes as f32;
        let i = lane as f32;
        if e.lanes_b == 0 {
            (n * 0.5 - i - 0.5) * LANE_W
        } else {
            (n - i - 0.5) * LANE_W
        }
    }

    /// Pose on a link at distance `s` with lateral offset `lat` (right of travel).
    pub fn link_pose(&self, link: u32, s: f32, lat: f32) -> Pose {
        let l = &self.links[link as usize];
        let e = &self.edges[l.edge as usize];
        let se = if l.rev { e.len - s } else { s }.clamp(0.0, e.len);
        self.edge_pose(e, se, if l.rev { -lat } else { lat }, l.rev)
    }

    /// Position on a link at `s` with lateral offset `lat` (right of travel) — no trig.
    #[inline]
    pub fn link_xyz(&self, link: u32, s: f32, lat: f32) -> (f64, f64, f32) {
        let l = &self.links[link as usize];
        let e = &self.edges[l.edge as usize];
        let se = if l.rev { e.len - s } else { s }.clamp(0.0, e.len);
        let lat = if l.rev { -lat } else { lat };
        let k = seg_index(&e.cum, se);
        let (a, b) = (e.pts[k], e.pts[k + 1]);
        let sl = e.cum[k + 1] - e.cum[k];
        let t = if sl > 1e-6 { ((se - e.cum[k]) / sl).clamp(0.0, 1.0) } else { 0.0 } as f64;
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let h = dx.hypot(dy);
        let (nx, ny) = if h > 1e-9 { (dy / h, -dx / h) } else { (0.0, 0.0) };
        (a[0] + dx * t + nx * lat as f64, a[1] + dy * t + ny * lat as f64, (a[2] + (b[2] - a[2]) * t) as f32)
    }

    /// Pose on an edge at `s` (from the edge start) with lateral offset right of from→to.
    pub fn edge_pose(&self, e: &Edge, s: f32, lat: f32, rev: bool) -> Pose {
        let k = seg_index(&e.cum, s);
        let (a, b) = (e.pts[k], e.pts[k + 1]);
        let l = e.cum[k + 1] - e.cum[k];
        let t = if l > 1e-6 { ((s - e.cum[k]) / l).clamp(0.0, 1.0) } else { 0.0 } as f64;
        let (dx, dy, dz) = (b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        let h = (dy as f32).atan2(dx as f32);
        let horiz = (dx.hypot(dy)) as f32;
        let p = if horiz > 1e-3 { (dz as f32).atan2(horiz) } else { 0.0 };
        let (sh, ch) = h.sin_cos();
        Pose {
            x: a[0] + dx * t + (sh * lat) as f64,
            y: a[1] + dy * t - (ch * lat) as f64,
            z: (a[2] + dz * t) as f32,
            h: if rev { wrap_pi(h + PI) } else { h },
            p: if rev { -p } else { p },
        }
    }

    /// Re-derive control, setbacks and signal plans for nodes whose edge set changed.
    pub fn refresh(&mut self) {
        let dirty: Vec<u32> = (0..self.nodes.len() as u32).filter(|&i| self.nodes[i as usize].alive && self.nodes[i as usize].dirty).collect();
        for &i in &dirty {
            self.refresh_node(i);
        }
        // signal clusters (after every node's own data is fresh)
        for &i in &dirty {
            if self.nodes[i as usize].control == Control::Signal {
                self.refresh_signal(i);
                // neighbours may have gained/lost a cluster member
                let (x, y) = (self.nodes[i as usize].x, self.nodes[i as usize].y);
                for j in self.signals_near(x, y) {
                    if j != i && !self.nodes[j as usize].dirty {
                        self.refresh_signal(j);
                    }
                }
            }
        }
        for &i in &dirty {
            self.refresh_zone(i);
        }
        for &i in &dirty {
            self.nodes[i as usize].dirty = false;
        }
    }

    /// Group controlled nodes connected by links shorter than ZONE_LINK into one zone.
    fn refresh_zone(&mut self, seed: u32) {
        const ZONE_LINK: f32 = 25.0;
        if !self.nodes[seed as usize].alive {
            return;
        }
        let mut comp = vec![seed];
        let mut k = 0;
        while k < comp.len() && comp.len() < 12 {
            let n = comp[k];
            k += 1;
            if self.nodes[n as usize].control == Control::Free {
                continue;
            }
            for &e in &self.nodes[n as usize].edges {
                let ed = &self.edges[e as usize];
                if !ed.alive || ed.len > ZONE_LINK {
                    continue;
                }
                let o = if ed.from == n { ed.to } else { ed.from };
                if self.nodes[o as usize].control != Control::Free && !comp.contains(&o) {
                    comp.push(o);
                }
            }
        }
        let root = *comp.iter().min_by_key(|&&n| self.nodes[n as usize].osm).unwrap();
        for n in comp {
            self.nodes[n as usize].zone = root;
        }
    }

    fn refresh_node(&mut self, i: u32) {
        let (deg, best, worst, max_hw, max_ped, all_fast) = {
            let n = &self.nodes[i as usize];
            let mut best = 6u8;
            let mut worst = 0u8;
            let mut max_hw = 0.0f32;
            let mut max_ped = 0.0f32;
            let mut all_fast = true;
            for &e in &n.edges {
                let ed = &self.edges[e as usize];
                let c = if ed.flags & FLAG_LINK != 0 { ed.class.max(3) } else { ed.class };
                best = best.min(c);
                worst = worst.max(c);
                max_hw = max_hw.max(ed.half_w);
                if ed.ped_ok {
                    max_ped = max_ped.max(ed.ped_off);
                }
                if !(ed.class <= 1) {
                    all_fast = false;
                }
            }
            (n.edges.len(), best, worst, max_hw, max_ped, all_fast)
        };
        let n = &mut self.nodes[i as usize];
        n.best_class = best;
        n.uniform = best == worst;
        n.control = if n.flags & 1 != 0 && deg >= 2 {
            Control::Signal
        } else if n.flags & 2 != 0 && deg >= 2 {
            Control::Stop
        } else if deg >= 3 && !all_fast {
            Control::Priority
        } else {
            Control::Free
        };
        n.ped_trim = if deg >= 3 { max_ped.min(20.0) } else { 0.0 };
        // stop line just before the crosswalk (crosswalk centre at ped_trim)
        n.setback = match n.control {
            Control::Free => 0.0,
            _ if deg <= 2 => 3.0,
            _ => (max_hw + 1.2).max(n.ped_trim + 2.2).clamp(3.0, 22.0),
        };
    }

    fn signals_near(&self, x: f64, y: f64) -> Vec<u32> {
        let (cx, cy) = cell(x, y, SIGNAL_CLUSTER);
        let mut v = Vec::new();
        for dx in -1..=1 {
            for dy in -1..=1 {
                if let Some(c) = self.signal_grid.get(&(cx + dx, cy + dy)) {
                    for &j in c {
                        let n = &self.nodes[j as usize];
                        if n.alive && (n.x - x).hypot(n.y - y) <= SIGNAL_CLUSTER {
                            v.push(j);
                        }
                    }
                }
            }
        }
        v
    }

    /// Signal plan shared by a cluster of nearby signal nodes (dual carriageways,
    /// signals tagged on approach nodes): same offset and phase axis.
    fn refresh_signal(&mut self, i: u32) {
        let (x, y) = (self.nodes[i as usize].x, self.nodes[i as usize].y);
        let cluster = self.signals_near(x, y);
        let mut key = self.nodes[i as usize].osm;
        // best approach: lowest class, then most lanes
        let mut best: Option<(u8, u8, f32)> = None;
        let mut n_axes = 0;
        for &j in cluster.iter().chain(std::iter::once(&i)) {
            let n = &self.nodes[j as usize];
            key = key.min(n.osm);
            for &e in &n.edges {
                let ed = &self.edges[e as usize];
                let lanes = ed.lanes_f + ed.lanes_b;
                let c = if ed.flags & FLAG_LINK != 0 { ed.class.max(3) } else { ed.class };
                let (bs, _) = self.edge_bearings(e, false);
                n_axes += 1;
                let better = match best {
                    None => true,
                    Some((bc, bl, _)) => c < bc || (c == bc && lanes > bl),
                };
                if better {
                    best = Some((c, lanes, bs));
                }
            }
        }
        let _ = n_axes;
        let (bc, _, axis) = best.unwrap_or((5, 2, 0.0));
        // is there a cross street at all among the cluster's approaches?
        let mut has_cross = false;
        for &j in cluster.iter().chain(std::iter::once(&i)) {
            for &e in &self.nodes[j as usize].edges {
                let (bs, _) = self.edge_bearings(e, false);
                if axis_diff(bs, axis) > 0.8 {
                    has_cross = true;
                }
            }
        }
        let h = hash01(key);
        let green_a = if bc <= 2 { 38.0 } else { 30.0 } + 8.0 * h;
        let green_b = if has_cross { 22.0 + 6.0 * hash01(key ^ 0x55) } else { 12.0 };
        let plan = SignalPlan { offset: (mix(key) % 997) as f32, axis, green_a, green_b };
        self.nodes[i as usize].plan = plan;
    }
}

impl Graph {
    /// Stop-line records of signalised approaches within `r` of (x, y):
    /// [dx, dy, bearing, half width, light (0 green, 1 amber, 2 red)] relative to (ox, oy).
    pub fn signal_approaches(&self, x: f64, y: f64, r: f64, tod: f64, ox: f64, oy: f64, out: &mut Vec<f32>) {
        let r2 = r * r;
        for cellv in self.signal_grid.values() {
            for &ni in cellv {
                let n = &self.nodes[ni as usize];
                if !n.alive || n.control != Control::Signal || (n.x - x).powi(2) + (n.y - y).powi(2) > r2 {
                    continue;
                }
                for &li in &n.ins {
                    let l = &self.links[li as usize];
                    if !l.alive {
                        continue;
                    }
                    let sb = n.setback.min(l.len * 0.45);
                    let a = self.lane_offset(l, 0);
                    let b = self.lane_offset(l, l.lanes - 1);
                    let p = self.link_pose(li, l.len - sb, (a + b) * 0.5);
                    let hw = (a - b).abs() * 0.5 + LANE_W * 0.5 + 0.5;
                    let light = match n.plan.light_for(tod, l.bearing_end) {
                        crate::signal::Light::Green => 0.0,
                        crate::signal::Light::Amber => 1.0,
                        crate::signal::Light::Red => 2.0,
                    };
                    out.extend_from_slice(&[(p.x - ox) as f32, (p.y - oy) as f32, l.bearing_end, hw, light]);
                }
            }
        }
    }
}

/// segment index k such that cum[k] <= s < cum[k+1] (clamped)
#[inline]
pub fn seg_index(cum: &[f32], s: f32) -> usize {
    let n = cum.len();
    if n < 2 {
        return 0;
    }
    let mut lo = 0usize;
    let mut hi = n - 1;
    while hi - lo > 1 {
        let m = (lo + hi) / 2;
        if cum[m] <= s {
            lo = m;
        } else {
            hi = m;
        }
    }
    lo.min(n - 2)
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A plus-shaped junction: 4 two-way arms of `arm` m around a centre node
    /// with the given flags, centred in tile (0, 0).
    pub fn cross_tile(center_flags: u8, arm: f32) -> (Vec<f64>, Vec<f32>, Vec<u8>, Vec<u32>, Vec<u32>, Vec<u32>, Vec<f32>) {
        let c = 512.0f32;
        let n_id = vec![1.0, 2.0, 3.0, 4.0, 5.0];
        let n_xyz = vec![c, c, 0.0, c + arm, c, 0.0, c, c + arm, 0.0, c - arm, c, 0.0, c, c - arm, 0.0];
        let n_flags = vec![center_flags, 0, 0, 0, 0];
        let e_from = vec![0, 0, 0, 0];
        let e_to = vec![1, 2, 3, 4];
        let mut e_off = vec![0u32];
        let mut e_xyz = Vec::new();
        for k in 1..5 {
            let (x1, y1) = (n_xyz[k * 3], n_xyz[k * 3 + 1]);
            let steps = 10;
            for s in 0..=steps {
                let t = s as f32 / steps as f32;
                e_xyz.extend_from_slice(&[c + (x1 - c) * t, c + (y1 - c) * t, 0.0]);
            }
            e_off.push((e_xyz.len() / 3) as u32);
        }
        (n_id, n_xyz, n_flags, e_from, e_to, e_off, e_xyz)
    }

    pub fn load_cross(g: &mut Graph, flags: u8, classes: [u8; 4]) {
        let (n_id, n_xyz, n_flags, e_from, e_to, e_off, e_xyz) = cross_tile(flags, 200.0);
        let lanes = [1u8; 4];
        let speed = [13.9f32; 4];
        let ef = [0u8; 4];
        let bn = [0.0f32; 4];
        g.add_tile(&TileData {
            tx: 0,
            ty: 0,
            n_id: &n_id,
            n_xyz: &n_xyz,
            n_flags: &n_flags,
            e_from: &e_from,
            e_to: &e_to,
            e_off: &e_off,
            e_xyz: &e_xyz,
            e_class: &classes,
            e_lanes_fwd: &lanes,
            e_lanes_bwd: &lanes,
            e_speed: &speed,
            e_flags: &ef,
            bottleneck: &bn,
            e_width: &[],
            e_side: &[],
        });
    }

    #[test]
    fn lane_graph_and_turns() {
        let mut g = Graph::default();
        load_cross(&mut g, 1, [2, 5, 2, 5]);
        assert_eq!(g.live_edges, 4);
        assert_eq!(g.live_links, 8);
        let c = g.node_map[&1];
        let n = &g.nodes[c as usize];
        assert_eq!(n.ins.len(), 4);
        assert_eq!(n.outs.len(), 4);
        assert_eq!(n.control, Control::Signal);
        assert!(n.setback >= 3.0);
        // arriving from the west (heading east): the link from node 4 (west) to centre
        let west_in = *n.ins.iter().find(|&&l| g.nodes[g.links[l as usize].from as usize].osm == 4).unwrap();
        let bin = g.links[west_in as usize].bearing_end;
        assert!(bin.abs() < 0.01, "{bin}");
        let mut turns = HashMap::new();
        for &o in &n.outs {
            let to = g.nodes[g.links[o as usize].to as usize].osm;
            turns.insert(to, classify_turn(bin, g.links[o as usize].bearing_start));
        }
        assert_eq!(turns[&2], Turn::Straight); // east
        assert_eq!(turns[&3], Turn::Left); // north
        assert_eq!(turns[&5], Turn::Right); // south
        assert_eq!(turns[&4], Turn::U);
        // major axis = class 2 road (east-west)
        assert!(axis_diff(n.plan.axis, 0.0) < 0.05);
        // lanes: right-hand traffic, curb lane right of travel direction
        let lk = &g.links[west_in as usize];
        let off = g.lane_offset(lk, 0);
        assert!(off > 0.0);
        let p = g.link_pose(west_in, 100.0, off);
        assert!(p.y < 512.0, "right of eastbound = south: {}", p.y);
    }

    #[test]
    fn unify_and_evict() {
        let mut g = Graph::default();
        load_cross(&mut g, 0, [3, 5, 3, 5]);
        let c = g.node_map[&1];
        assert_eq!(g.nodes[c as usize].control, Control::Priority);
        assert_eq!(g.nodes[c as usize].best_class, 3);
        let old_gen = g.links[0].gen;
        g.remove_tile(0, 0);
        assert_eq!(g.live_links, 0);
        assert!(g.node_map.is_empty());
        assert!(!g.links[0].alive);
        load_cross(&mut g, 2, [3, 5, 3, 5]);
        assert_eq!(g.live_links, 8);
        assert!(g.links.len() == 8, "slots recycled");
        assert_ne!(g.links[0].gen, old_gen);
        let c = g.node_map[&1];
        assert_eq!(g.nodes[c as usize].control, Control::Stop);
    }

    #[test]
    fn projection() {
        let mut g = Graph::default();
        load_cross(&mut g, 0, [3, 5, 3, 5]);
        let mut near = Vec::new();
        g.edges_near(612.0, 510.0, 20.0, &mut near);
        assert!(!near.is_empty());
        let e = *near.iter().find(|&&e| g.nodes[g.edges[e as usize].to as usize].osm == 2).unwrap();
        let (s, lat, _, h) = g.project_on_edge(e, 612.0, 510.0);
        assert!((s - 100.0).abs() < 0.1 && (lat - 2.0).abs() < 0.01 && h.abs() < 0.01);
    }
}
