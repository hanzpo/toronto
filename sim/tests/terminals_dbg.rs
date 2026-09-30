//! debugging: terminals where the next trip's turnback is not found
use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;

use gta_sim::rail::{RailNet, RailSim, TState};

struct Arr {
    dt: String,
    bytes: Vec<u8>,
}

fn read_tbn(path: &PathBuf) -> Option<(HashMap<String, Arr>, String)> {
    let raw = std::fs::read(path).ok()?;
    let mut d = flate2::read::GzDecoder::new(&raw[..]);
    let mut buf = Vec::new();
    d.read_to_end(&mut buf).ok()?;
    assert_eq!(&buf[0..4], b"TBN1");
    let hl = u32::from_le_bytes(buf[4..8].try_into().unwrap()) as usize;
    let header = String::from_utf8(buf[8..8 + hl].to_vec()).unwrap();
    let mut base = 8 + hl;
    base += (8 - base % 8) % 8;
    let mut out = HashMap::new();
    let a = header.find("\"arrays\":{").unwrap() + 10;
    let end = header[a..].find('}').unwrap() + a;
    for item in header[a..end].split("],") {
        let item = item.trim_end_matches(']');
        let (name, rest) = item.split_once(":[").unwrap();
        let name = name.trim_matches('"').to_string();
        let parts: Vec<&str> = rest.split(',').collect();
        let dt = parts[0].trim_matches('"').to_string();
        let off: usize = parts[1].parse().unwrap();
        let n: usize = parts[2].parse().unwrap();
        let sz = match dt.as_str() {
            "u8" | "i8" => 1,
            "u16" | "i16" => 2,
            "u32" | "i32" | "f32" => 4,
            _ => 8,
        };
        out.insert(name, Arr { dt, bytes: buf[base + off..base + off + n * sz].to_vec() });
    }
    Some((out, header))
}

fn f32s(a: &Arr) -> Vec<f32> {
    a.bytes.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect()
}
fn u8s(a: &Arr) -> Vec<u8> {
    a.bytes.clone()
}
fn i32s(a: &Arr) -> Vec<i32> {
    a.bytes.chunks_exact(4).map(|c| i32::from_le_bytes(c.try_into().unwrap())).collect()
}
fn u16s(a: &Arr) -> Vec<u16> {
    a.bytes.chunks_exact(2).map(|c| u16::from_le_bytes(c.try_into().unwrap())).collect()
}
/// index arrays are u16 or u32
fn idx(a: &Arr) -> Vec<u32> {
    match a.dt.as_str() {
        "u16" => u16s(a).into_iter().map(|x| x as u32).collect(),
        "u8" => a.bytes.iter().map(|&x| x as u32).collect(),
        _ => a.bytes.chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect(),
    }
}

fn data() -> PathBuf {
    match std::env::var("RAIL_DATA") {
        Ok(d) => PathBuf::from(d),
        Err(_) => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../app/public/data"),
    }
}

fn load() -> Option<RailSim> {
    let (n, _) = read_tbn(&data().join("rail/network.bin.gz"))?;
    let net = RailNet::load(
        &f32s(&n["n_xyz"]),
        &u8s(&n["n_flags"]),
        &idx(&n["e_from"]),
        &idx(&n["e_to"]),
        &idx(&n["e_off"]),
        &f32s(&n["e_xyz"]),
        &u8s(&n["e_vlim"]),
        &f32s(&n["e_len"]),
        &u8s(&n["e_kind"]),
        &u8s(&n["e_service"]),
        &u8s(&n["e_dir"]),
        &u8s(&n["e_flags"]),
        &idx(&n["c_off"]),
        &idx(&n["c_to"]),
    );
    let mut sim = RailSim::default();
    sim.set_net(net);
    let (_, nh) = read_tbn(&data().join("rail/network.bin.gz"))?;
    let agencies = ["ttc", "go", "up", "via", "grt"];
    for (id, ag) in agencies.iter().enumerate() {
        let Some((a, _)) = read_tbn(&data().join(format!("transit/{ag}_weekday_rail.bin.gz"))) else { continue };
        if !a.contains_key("pat_redge") {
            return None;
        }
        sim.add_feed(
            id as u32,
            &u8s(&a["pat_mode"]),
            &f32s(&a["pat_len"]),
            &u8s(&a["pat_rflags"]),
            &f32s(&a["pat_rstart"]),
            &idx(&a["pat_redge_off"]),
            &idx(&a["pat_redge"]),
            &idx(&a["pat_stop_off"]),
            &f32s(&a["pat_stop_dist"]),
            &u8s(&a["pat_stop_flag"]),
            &idx(&a["tp_off"]),
            &u16s(&a["tp_arr"]),
            &u16s(&a["tp_dwell"]),
            &i32s(&a["trip_start"]),
            &idx(&a["trip_pattern"]),
            &idx(&a["trip_tp"]),
            &i32s(&a["trip_next"]),
        );
    }
    // depots from the network header: {"group":g,"agencies":[..],"edges":[..]}
    let (mut groups, mut masks, mut off, mut edges) = (Vec::new(), Vec::new(), vec![0u32], Vec::new());
    if let Some(a) = nh.find("\"depots\":[") {
        for item in nh[a..].split("{\"id\"").skip(1) {
            let num = |k: &str| -> Option<&str> { let i = item.find(k)? + k.len(); Some(&item[i..]) };
            let g: u8 = num("\"group\":").and_then(|r| r.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()).unwrap_or(0);
            let ags = num("\"agencies\":[").map(|r| r.split(']').next().unwrap_or("")).unwrap_or("");
            let mut mask = 0u32;
            for (i, ag) in agencies.iter().enumerate() {
                if ags.contains(&format!("\"{ag}\"")) { mask |= 1 << i; }
            }
            let es = num("\"edges\":[").map(|r| r.split(']').next().unwrap_or("")).unwrap_or("");
            let list: Vec<u32> = es.split(',').filter_map(|x| x.trim().parse().ok()).collect();
            if mask == 0 || list.is_empty() { continue; }
            groups.push(g); masks.push(mask); edges.extend(list); off.push(edges.len() as u32);
        }
    }
    sim.set_depots(&groups, &masks, &off, &edges);
    // level crossings: "crossings":[[osm,edge,s,e,n],...]
    if let Some(a) = nh.find("\"crossings\":[") {
        let body = &nh[a + 13..];
        let end = body.find("]]").map(|k| k + 1).unwrap_or(0);
        let v: Vec<f64> = body[..end].split(|c| c == '[' || c == ']' || c == ',').filter_map(|x| x.trim().parse().ok()).collect();
        sim.set_crossings(&v);
        eprintln!("crossings loaded: {}", sim.crossings.len());
    }
    eprintln!("depots loaded: {}", sim.depots.len());
    Some(sim)
}


#[test]
#[ignore]
fn terminal_turnbacks() {
    let Some(mut sim) = load() else { return };
    sim.focus = (-120.0, -950.0);
    sim.radius = 70000.0;
    let mut t = 5.0 * 3600.0;
    let mut seen = std::collections::HashSet::new();
    while t < 12.0 * 3600.0 {
        sim.step(0.5, t);
        t += 0.5;
        for ti in 0..sim.trains.len() {
            let tr = &sim.trains[ti];
            if tr.dead || tr.state != TState::Terminal || !tr.legs.is_empty() || tr.dh || t - tr.since < 60.0 {
                continue;
            }
            let key = (tr.feed, sim.plans[tr.plan as usize].local);
            if !seen.insert(key) {
                continue;
            }
            let p = sim.plans[tr.plan as usize].point(&sim.net, tr.front);
            let (feed, mode) = (tr.feed, sim.plans[tr.plan as usize].mode);
            let d = sim.debug_end(ti);
            eprintln!("TERMINAL feed {} mode {} at ({:.0},{:.0}): {}", feed, mode, p[0], p[1], d.chars().take(260).collect::<String>());
        }
    }
}
