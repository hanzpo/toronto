use serde::Deserialize;
use std::collections::HashMap;

#[derive(Deserialize)]
pub struct P3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[derive(Deserialize)]
pub struct SigRef {
    pub node: String,
    pub group: i32,
}

#[derive(Deserialize)]
pub struct ConfIn {
    pub lane: u32,
    pub s: f32,
    pub os: f32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneIn {
    pub kind: String,
    pub cls: Vec<String>,
    pub pts: Vec<P3>,
    pub width: f32,
    pub speed: f32,
    pub node: Option<String>,
    pub next: Vec<u32>,
    pub prev: Vec<u32>,
    pub bidir: bool,
    pub signal: Option<SigRef>,
    pub conflicts: Option<Vec<ConfIn>>,
    pub crosswalk: Option<bool>,
    pub turn: Option<String>,
    pub stop_sign: Option<bool>,
}

#[derive(Deserialize)]
pub struct GroupIn {
    pub lanes: Vec<u32>,
    pub peds: Vec<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalIn {
    pub node: String,
    pub groups: Vec<GroupIn>,
    pub green: f32,
    pub amber: f32,
    pub all_red: f32,
}

#[derive(Deserialize)]
pub struct NodeIn {
    pub id: String,
    pub kind: String,
}

#[derive(Deserialize)]
pub struct NetIn {
    pub lanes: Vec<LaneIn>,
    pub signals: Vec<SignalIn>,
    pub nodes: Vec<NodeIn>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Drive,
    Tram,
    Rail,
    Walk,
}

pub const C_CAR: u16 = 1;
pub const C_BUS: u16 = 2;
pub const C_TRUCK: u16 = 4;
pub const C_TRAM: u16 = 8;
pub const C_RAIL: u16 = 16;
pub const C_SUBWAY: u16 = 32;
pub const C_BIKE: u16 = 64;
pub const C_PED: u16 = 128;

pub struct Conf {
    pub lane: u32,
    pub s: f32,
    pub os: f32,
}

pub struct Lane {
    pub kind: Kind,
    pub cls: u16,
    pub pts: Vec<[f32; 3]>,
    pub cum: Vec<f32>,
    pub len: f32,
    pub speed: f32,
    pub width: f32,
    pub node: Option<u16>,
    pub next: Vec<u32>,
    pub prev: Vec<u32>,
    pub bidir: bool,
    pub signal: Option<(u16, i16)>,
    pub conflicts: Vec<Conf>,
    pub crosswalk: bool,
    pub turn: u8,
    pub stop_sign: bool,
    pub ped_mask: u32,
    pub ends: [Vec<(u32, i8)>; 2],
}

pub struct Signal {
    pub groups: usize,
    pub green: f32,
    pub amber: f32,
    pub all_red: f32,
}

pub struct Net {
    pub lanes: Vec<Lane>,
    pub signals: HashMap<u16, Signal>,
    pub node_kind: Vec<String>,
}

fn cls_bits(c: &[String]) -> u16 {
    let mut b = 0;
    for s in c {
        b |= match s.as_str() {
            "car" => C_CAR,
            "bus" => C_BUS,
            "truck" => C_TRUCK,
            "tram" => C_TRAM,
            "rail" => C_RAIL,
            "subway" => C_SUBWAY,
            "bike" => C_BIKE,
            "ped" => C_PED,
            _ => 0,
        };
    }
    b
}

impl Net {
    pub fn from_json(s: &str) -> Result<Net, String> {
        let inp: NetIn = serde_json::from_str(s).map_err(|e| e.to_string())?;
        let node_idx: HashMap<String, u16> = inp.nodes.iter().enumerate().map(|(i, n)| (n.id.clone(), i as u16)).collect();
        let mut lanes: Vec<Lane> = inp
            .lanes
            .iter()
            .map(|l| {
                let pts: Vec<[f32; 3]> = l.pts.iter().map(|p| [p.x, p.y, p.z]).collect();
                let mut cum = vec![0.0f32];
                for i in 1..pts.len() {
                    let d = ((pts[i][0] - pts[i - 1][0]).powi(2) + (pts[i][1] - pts[i - 1][1]).powi(2)).sqrt();
                    cum.push(cum[i - 1] + d);
                }
                let len = cum.last().copied().unwrap_or(0.0).max(0.01);
                Lane {
                    kind: match l.kind.as_str() {
                        "drive" | "bike" => Kind::Drive,
                        "tram" => Kind::Tram,
                        "rail" => Kind::Rail,
                        _ => Kind::Walk,
                    },
                    cls: cls_bits(&l.cls),
                    pts,
                    cum,
                    len,
                    speed: l.speed,
                    width: l.width,
                    node: l.node.as_ref().and_then(|n| node_idx.get(n).copied()),
                    next: l.next.clone(),
                    prev: l.prev.clone(),
                    bidir: l.bidir,
                    signal: l.signal.as_ref().and_then(|s| node_idx.get(&s.node).map(|&n| (n, s.group as i16))),
                    conflicts: l.conflicts.as_ref().map(|c| c.iter().map(|q| Conf { lane: q.lane, s: q.s, os: q.os }).collect()).unwrap_or_default(),
                    crosswalk: l.crosswalk.unwrap_or(false),
                    turn: match l.turn.as_deref() {
                        Some("right") => 1,
                        Some("left") => 2,
                        Some("u") => 3,
                        _ => 0,
                    },
                    stop_sign: l.stop_sign.unwrap_or(false),
                    ped_mask: 0,
                    ends: [Vec::new(), Vec::new()],
                }
            })
            .collect();
        let mut signals = HashMap::new();
        for s in &inp.signals {
            let Some(&n) = node_idx.get(&s.node) else { continue };
            for (g, grp) in s.groups.iter().enumerate() {
                for &p in &grp.peds {
                    if let Some(l) = lanes.get_mut(p as usize) {
                        l.ped_mask |= 1 << g;
                    }
                }
            }
            signals.insert(n, Signal { groups: s.groups.len().max(1), green: s.green, amber: s.amber, all_red: s.all_red });
        }
        let n = lanes.len();
        let mut refs: Vec<Vec<u32>> = vec![Vec::new(); n];
        for (i, l) in lanes.iter().enumerate() {
            for &j in l.next.iter().chain(l.prev.iter()) {
                refs[j as usize].push(i as u32);
                refs[i].push(j);
            }
        }
        for i in 0..n {
            let (a, b, bidir) = {
                let l = &lanes[i];
                (l.pts[0], *l.pts.last().unwrap(), l.bidir)
            };
            let mut e0 = Vec::new();
            let mut e1 = Vec::new();
            let mut cands: Vec<u32> = refs[i].clone();
            cands.sort();
            cands.dedup();
            for &j in &cands {
                if j as usize == i {
                    continue;
                }
                let o = &lanes[j as usize];
                let (oa, ob) = (o.pts[0], *o.pts.last().unwrap());
                let near = |p: [f32; 3], q: [f32; 3]| ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2)).sqrt() < 0.5;
                if !bidir && !o.bidir {
                    continue;
                }
                if near(b, oa) {
                    e1.push((j, 1));
                } else if near(b, ob) && o.bidir {
                    e1.push((j, -1));
                }
                if bidir {
                    if near(a, ob) && (o.bidir || lanes[i].prev.contains(&j)) {
                        e0.push((j, if o.bidir { -1 } else { -1 }));
                    } else if near(a, oa) && o.bidir {
                        e0.push((j, 1));
                    }
                }
            }
            if !bidir {
                for &j in &lanes[i].next {
                    if !e1.iter().any(|x| x.0 == j) {
                        e1.push((j, 1));
                    }
                }
            }
            lanes[i].ends = [e0, e1];
        }
        Ok(Net { lanes, signals, node_kind: inp.nodes.iter().map(|n| n.kind.clone()).collect() })
    }

    pub fn at(&self, lane: u32, s: f32) -> ([f32; 3], f32, f32) {
        let l = &self.lanes[lane as usize];
        let s = s.clamp(0.0, l.len);
        let mut lo = 0usize;
        let mut hi = l.cum.len() - 1;
        while hi - lo > 1 {
            let m = (lo + hi) / 2;
            if l.cum[m] <= s {
                lo = m
            } else {
                hi = m
            }
        }
        let (a, b) = (l.pts[lo], l.pts[hi.min(l.pts.len() - 1)]);
        let seg = (l.cum[hi] - l.cum[lo]).max(1e-6);
        let t = ((s - l.cum[lo]) / seg).clamp(0.0, 1.0);
        let p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        let h = (b[1] - a[1]).atan2(b[0] - a[0]);
        let pitch = ((b[2] - a[2]) / seg).atan();
        (p, h, pitch)
    }
}
