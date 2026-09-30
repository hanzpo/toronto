//! Rail agents on the real network and timetables (skipped when the data is absent):
//! app/public/data/rail/network.bin.gz + app/public/data/transit/{ttc,go,up,via}_weekday_rail.bin.gz.
//! Runs the morning peak around Union and along the Union - Bloor - Weston corridor
//! (GO Kitchener, UP Express, VIA share it) and asserts that no two trains ever
//! overlap, nobody overruns an authority and trains keep moving.

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
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../app/public/data")
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
    let agencies = ["ttc", "go", "up", "via"];
    for (id, ag) in ["ttc", "go", "up", "via"].iter().enumerate() {
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

struct Report {
    overlaps: u32,
    overruns: u32,
    max_trains: usize,
    stuck: usize,
    ms_per_step: f64,
    chained: usize,
    mean_abs_delay: f64,
}

fn run(sim: &mut RailSim, focus: (f64, f64), t0: f64, secs: f64, dt: f32) -> Report {
    sim.focus = focus;
    let mut t = t0;
    let mut max_trains = 0;
    let mut steps = 0;
    let start = std::time::Instant::now();
    let mut worst_held: HashMap<u32, f32> = HashMap::new();
    let trips_before: usize = 0;
    let mut chained = 0;
    let mut last_trip: HashMap<u32, u32> = HashMap::new();
    let mut delays = Vec::new();
    let mut cats: HashMap<String, usize> = HashMap::new();
    let (mut held_samples, mut total_samples) = (0u64, 0u64);
    while t < t0 + secs {
        sim.step(dt, t);
        steps += 1;
        if steps % 25 == 0 {
            let (oe, de) = sim.audit();
            assert!(oe == 0 && de == 0, "reservation tables inconsistent at t={t}: owner errors {oe}, dir errors {de}");
        }
        max_trains = max_trains.max(sim.trains.len());
        for tr in &sim.trains {
            let e = worst_held.entry(tr.id).or_insert(0.0);
            *e = e.max(tr.held_t);
            if let Some(&p) = last_trip.get(&tr.id) {
                if p != tr.trip {
                    chained += 1;
                }
            }
            last_trip.insert(tr.id, tr.trip);
            if steps % 50 == 0 {
                total_samples += 1;
                if tr.held_t > 30.0 { held_samples += 1; }
            }
            let _ = &cats;
            if tr.state == TState::Dwell && steps % 50 == 0 {
                delays.push(tr.delay.abs() as f64);
            }
        }
        if steps % 50 == 0 {
            for ti in 0..sim.trains.len() {
                if sim.trains[ti].held_t <= 30.0 { continue; }
                // follow to the root blocker
                let mut cur = ti;
                for _ in 0..40 {
                    match sim.blocker(cur).and_then(|id| if id == 0 { None } else { sim.trains.iter().position(|t| t.id == id) }) {
                        Some(j) if sim.trains[j].held_t > 1.0 && j != ti => cur = j,
                        _ => break,
                    }
                }
                let root_desc = { let r = &sim.trains[cur]; let p = &sim.plans[r.plan as usize]; format!(" root:{:?} stop {}/{} f{}", r.state, r.stop, p.stop_front.len(), r.feed) };
                let _ = &root_desc;
                let cat = match sim.blocker(cur) {
                    None => "none".to_string(),
                    Some(0) => "dirlock".to_string(),
                    Some(id) => match sim.trains.iter().find(|t| t.id == id) {
                        Some(o) => format!("{}{:?}{} v{:.0} gap{:.0}", if o.held_t > 1.0 { "held-" } else { "" }, o.state, if o.legs.is_empty() { "" } else { "+legs" }, o.v, (o.front - o.len) - sim.trains[cur].front),
                        None => "gone".to_string(),
                    },
                };
                let m = sim.plans[sim.trains[ti].plan as usize].mode;
                *cats.entry(format!("m{} {}", m, cat)).or_insert(0usize) += 1;
            }
        }
        t += dt as f64;
    }
    let mut cv: Vec<_> = cats.iter().collect();
    cv.sort_by_key(|x| std::cmp::Reverse(*x.1));
    eprintln!("  held causes: {:?}", &cv[..cv.len().min(14)]);
    let _ = trips_before;
    // root causes: follow blockers to a train that is not itself held
    let mut roots: HashMap<u32, usize> = HashMap::new();
    for ti in 0..sim.trains.len() {
        if sim.trains[ti].held_t < 60.0 {
            continue;
        }
        let mut cur = ti;
        let mut guard = 0;
        loop {
            guard += 1;
            match sim.blocker(cur) {
                Some(0) => { *roots.entry(u32::MAX).or_insert(0) += 1; break; }
                Some(id) => match sim.trains.iter().position(|t| t.id == id) {
                    Some(j) if guard < 50 && j != ti => cur = j,
                    _ => { *roots.entry(id).or_insert(0) += 1; break; }
                },
                None => { *roots.entry(sim.trains[cur].id).or_insert(0) += 1; break; }
            }
        }
    }
    for ti in 0..sim.trains.len() {
        if sim.trains[ti].state == TState::Terminal && sim.trains[ti].legs.is_empty() {
            let d = sim.debug_end(ti);
            eprintln!("  terminal feed {} trip {}: {}", sim.trains[ti].feed, sim.trains[ti].trip, d);
        }
    }
    let mut shown = 0;
    for ti in 0..sim.trains.len() {
        if sim.trains[ti].held_t > 30.0 && shown < 15 {
            shown += 1;
            let t = &sim.trains[ti];
            eprintln!("  HELD {:.0}s feed {} trip {} legs {} dh {} : {}", t.held_t, t.feed, t.trip, t.legs.len(), t.dh, sim.why(ti).chars().take(160).collect::<String>());
        }
    }
    let mut rv: Vec<_> = roots.into_iter().collect();
    rv.sort_by_key(|x| std::cmp::Reverse(x.1));
    for (id, n) in rv.iter().take(8) {
        if *id == u32::MAX { eprintln!("  root: direction lock x{n}"); continue; }
        if let Some(j) = sim.trains.iter().position(|t| t.id == *id) {
            let t = &sim.trains[j];
            eprintln!("  root x{n}: id {} feed {} trip {} v {:.1} state {:?} held {:.0} stop {} {}", t.id, t.feed, t.trip, t.v, t.state, t.held_t, t.stop, sim.why(j).chars().take(200).collect::<String>());
        } else { eprintln!("  root x{n}: id {id} (gone)"); }
    }
    let el = start.elapsed().as_secs_f64() * 1000.0;
    sim.check();
    Report {
        overlaps: sim.overlaps,
        overruns: sim.overruns,
        max_trains,
        stuck: (held_samples * 100 / total_samples.max(1)) as usize,
        ms_per_step: el / steps as f64,
        chained,
        mean_abs_delay: if delays.is_empty() { 0.0 } else { delays.iter().sum::<f64>() / delays.len() as f64 },
    }
}

#[test]
fn union_morning_peak() {
    let Some(mut sim) = load() else {
        eprintln!("rail data missing: skipped");
        return;
    };
    // Union Station, 7:30 - 8:30
    let r = run(&mut sim, (-120.0, -950.0), 7.5 * 3600.0, 3600.0, 0.2);
    eprintln!(
        "union: pullouts {} pullins {} parked {} turnbacks {} max trains {} overlaps {} overruns {} held>30s {}% chained {} mean |delay| {:.0}s  {:.3} ms/step",
        sim.pullouts, sim.pullins, sim.trains.iter().filter(|t| t.state == TState::Parked).count(), sim.turnbacks, r.max_trains, r.overlaps, r.overruns, r.stuck, r.chained, r.mean_abs_delay, r.ms_per_step
    );
    assert_eq!(r.overlaps, 0, "train bodies overlapped");
    assert_eq!(r.overruns, 0, "a train passed the end of its authority");
    assert!(r.max_trains > 40, "too few trains ({})", r.max_trains);
}

#[test]
fn union_bloor_weston_corridor() {
    let Some(mut sim) = load() else {
        eprintln!("rail data missing: skipped");
        return;
    };
    // Bloor GO / UP, where GO Kitchener, UP Express and VIA share the corridor; 16:00 - 18:00
    let r = run(&mut sim, (-5330.0, 490.0), 16.0 * 3600.0, 7200.0, 0.2);
    eprintln!(
        "corridor: max trains {} overlaps {} overruns {} held>30s {}% chained {} mean |delay| {:.0}s  {:.3} ms/step",
        r.max_trains, r.overlaps, r.overruns, r.stuck, r.chained, r.mean_abs_delay, r.ms_per_step
    );
    assert_eq!(r.overlaps, 0);
    assert_eq!(r.overruns, 0);
}

#[test]
fn early_morning_pullouts() {
    let Some(mut sim) = load() else { return };
    // 5:00 - 7:00 around Union: blocks start from the depots
    let r0 = run(&mut sim, (-120.0, -950.0), 5.0 * 3600.0, 60.0, 0.25);
    let _ = r0;
    let (i0, f0) = (sim.spawned_inside, sim.spawned_first);
    let r = run(&mut sim, (-120.0, -950.0), 5.0 * 3600.0 + 60.0, 7140.0, 0.25);
    eprintln!("after start-up: placed inside the radius {} (first of block {}) pull-out failures {:?}", sim.spawned_inside - i0, sim.spawned_first - f0, sim.po_fail);
    for l in sim.pop_log.iter().take(25) { eprintln!("  pop {l}"); }
    let parked = sim.trains.iter().filter(|t| t.state == TState::Parked).count();
    let active = sim.crossings.iter().filter(|c| c.state > 0).count();
    eprintln!("crossings active now: {active}, gate closures in the run: {}", sim.xing_closures);
    assert!(sim.xing_closures > 0, "no level crossing ever closed");
    eprintln!("morning: pullouts {} pullins {} parked {} max trains {} overlaps {} overruns {} held>30s {}%", sim.pullouts, sim.pullins, parked, r.max_trains, r.overlaps, r.overruns, r.stuck);
    assert_eq!(r.overlaps, 0);
    assert_eq!(r.overruns, 0);
    assert!(sim.pullouts > 20, "few pull-outs: {}", sim.pullouts);
}

#[test]
fn debug_tram_pullout() {
    let Some(mut sim) = load() else { return };
    sim.focus = (-120.0, -950.0);
    sim.step(0.25, 5.0 * 3600.0);
    for trip in [8usize, 15, 22] {
        eprintln!("{}", sim.debug_pullout(0, trip));
    }
}
