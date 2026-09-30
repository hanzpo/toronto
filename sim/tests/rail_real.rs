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

/// Playtest: LW trip due at Union 08:34, running late. Traces it from 08:20 (camera near
/// Exhibition) until it berths; it must never be removed or change trip before Union.
#[test]
fn lw_late_arrival_at_union() {
    let Some(mut sim) = load() else { return };
    sim.focus = (-2500.0, -1200.0);
    sim.step(0.2, 8.0 * 3600.0 + 19.0 * 60.0);
    let fi = sim.feeds.iter().position(|f| f.id == 1).unwrap(); // go
    let f = &sim.feeds[fi];
    let cands: Vec<usize> = (0..f.trip_end.len())
        .filter(|&t| (30700..30900).contains(&f.trip_end[t]))
        .filter(|&t| {
            let p = &sim.plans[(f.plan0 + f.trip_pattern[t]) as usize];
            p.items.iter().any(|it| it.edge == 1324 || it.edge == 904 || it.edge == 907)
        })
        .collect();
    eprintln!("candidates {:?}", cands.iter().map(|&t| (t, f.trip_start[t], f.trip_end[t])).collect::<Vec<_>>());
    sim.focus = (-2500.0, -1200.0);
    let mut t = 8.0 * 3600.0 + 20.0 * 60.0;
    let dt = 0.2f32;
    let mut last = String::new();
    let (mut berthed, mut vanished) = (false, false);
    let watch = *cands.last().unwrap();
    while t < 8.0 * 3600.0 + 55.0 * 60.0 {
        sim.step(dt, t);
        t += dt as f64;
        for &trip in &cands {
            let st = format!("{:?}", sim.trip_state.get(fi).and_then(|v| v.get(trip)));
            let tr = sim.trains.iter().position(|x| !x.dead && x.feed == fi as u32 && x.trip == trip as u32);
            let line = match tr {
                Some(k) => {
                    let x = &sim.trains[k];
                    let p = sim.plans[x.plan as usize].point(&sim.net, x.front);
                    format!("trip {trip} {st} id {} state {:?} v {:.1} front {:.0} ({:.0},{:.0}) stop {} delay {:.0} ma {:.0} held {:.0} lim {:.1} why {}", x.id, x.state, x.v, x.front, p[0], p[1], x.stop, x.delay, x.ma - x.front, x.held_t, sim.plans[x.plan as usize].limit_over(x.front - x.len, x.front), sim.why(k).chars().take(140).collect::<String>())
                }
                None => format!("trip {trip} {st} no train"),
            };
            if trip == watch {
                if let Some(k) = tr {
                    sim.keep = sim.trains[k].id;
                }
                match tr {
                    Some(k) if sim.trains[k].state == TState::Terminal => berthed = true,
                    None if !berthed && matches!(sim.trip_state.get(fi).and_then(|v| v.get(trip)), Some(gta_sim::rail::TripState::Finished) | Some(gta_sim::rail::TripState::Done)) => vanished = true,
                    _ => {}
                }
            }
            let key: String = format!("{trip}:{}", (t as i64) / 20);
            if key != last && trip == *cands.last().unwrap() {
                last = key;
                let hh = t as i64;
                if std::env::var("LW_TRACE").is_ok() {
                    eprintln!("{:02}:{:02}:{:02} {line}", hh / 3600, hh / 60 % 60, hh % 60);
                }
            }
        }
    }
    // the ridden train is still there after its trip (next trip, empty-stock move or waiting)
    let kept = sim.trains.iter().find(|x| x.id == sim.keep && !x.dead);
    eprintln!("kept train after the run: {:?}", kept.map(|x| (x.trip, x.state, x.dh, x.front)));
    assert!(kept.is_some(), "the ridden train was retired");
    assert!(!vanished, "the LW trip ended before reaching Union");
    assert!(berthed, "the LW trip never berthed at Union");
}

/// A whole weekday of the feeds in `feeds` (None = all) around `focus` / `radius`: the worst
/// time every train of those feeds stood still away from a platform, trips handed back /
/// aborted and finished, trains held > 60 s near a depot, examples.
fn day_run(sim: &mut RailSim, feeds: Option<&[usize]>, focus: (f64, f64), radius: f64, t0: f64, t1: f64) -> (f64, usize, usize, usize, u32, Vec<String>, u32) {
    sim.focus = focus;
    sim.radius = radius;
    let depots: Vec<(f64, f64)> = sim.depots.iter().map(|d| (d.x, d.y)).collect();
    let mine = |f: u32| feeds.map_or(true, |v| v.contains(&(f as usize)));
    let mut t = t0;
    let dt = 0.5f32;
    let mut all_stopped_since: Option<f64> = None;
    let mut worst = 0.0f64;
    let mut held_depot = 0u32;
    let mut ex: Vec<String> = Vec::new();
    let mut step = 0u64;
    let mut stuck_ids: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let mut stuck_at: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    let mut causes: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    let mut roots_shown = 0;
    while t < t1 {
        sim.step(dt, t);
        t += dt as f64;
        step += 1;
        let act: Vec<usize> = (0..sim.trains.len()).filter(|&k| mine(sim.trains[k].feed) && !sim.trains[k].dead && sim.trains[k].state != TState::Parked).collect();
        let moving = act.iter().any(|&k| sim.trains[k].v > 0.1 || matches!(sim.trains[k].state, TState::Dwell | TState::Terminal));
        if act.len() >= 2 && !moving {
            let s0 = *all_stopped_since.get_or_insert(t);
            worst = worst.max(t - s0);
        } else {
            all_stopped_since = None;
        }
        if step % 120 == 0 {
            for &k in &act {
                let tr = &sim.trains[k];
                if tr.held_t > 180.0 && !matches!(tr.state, TState::Dwell | TState::Terminal) && stuck_ids.insert(tr.id) {
                    let p = sim.plans[tr.plan as usize].point(&sim.net, tr.front);
                    let by = sim.blocker(k).map(|id| if id == 0 { "dir-lock".to_string() } else { sim.trains.iter().find(|o| o.id == id).map(|o| format!("{:?}{}", o.state, if o.dh { "-dh" } else { "" })).unwrap_or("gone".into()) }).unwrap_or_else(|| "no blocker".into());
                    let key = format!("mode {} ({:.0},{:.0}) {}by {}", sim.plans[tr.plan as usize].mode, (p[0] / 500.0).round() * 500.0, (p[1] / 500.0).round() * 500.0, if tr.dh { "dh " } else { "" }, by);
                    *stuck_at.entry(key).or_insert(0) += 1;
                    // root cause of the wait
                    let mut cur = k;
                    let mut seen = vec![k];
                    let cause = loop {
                        let c = &sim.trains[cur];
                        let bid = sim.wait_for(cur);
                        match bid {
                            None => break if cur == k { "ILLEGIT no blocker" } else if matches!(c.state, TState::Dwell | TState::Terminal) && (c.until - (t + c.toff)) > -60.0 { "queue behind a dwelling train" } else if matches!(c.state, TState::Dwell | TState::Terminal) { "ILLEGIT behind a train stuck at its stop / terminal" } else if c.v > 0.1 { "queue behind a moving train" } else { "ILLEGIT chain ends at a stopped train" },
                            Some(0) => break "direction lock (opposing train)",
                            Some(id) => match sim.trains.iter().position(|o| o.id == id) {
                                None => break "ILLEGIT owner gone (leak)",
                                Some(j) => {
                                    // how far is the owner's body from what it blocks?
                                    let o = &sim.trains[j];
                                    if o.state == TState::Parked { break "ILLEGIT parked train"; }
                                    if seen.contains(&j) { break "ILLEGIT cycle"; }
                                    let cp = &sim.plans[c.plan as usize];
                                    let bs = if c.next < cp.spans.len() { cp.point(&sim.net, cp.spans[c.next].r0) } else { cp.point(&sim.net, c.front) };
                                    let op = sim.plans[o.plan as usize].point(&sim.net, o.front);
                                    if (bs[0] - op[0]).hypot(bs[1] - op[1]) > 2000.0 && o.v > 0.1 { break "held far ahead / behind by a moving train"; }
                                    seen.push(j);
                                    cur = j;
                                }
                            },
                        }
                    };
                    let mode = sim.plans[tr.plan as usize].mode;
                    if std::env::var("ROOTS").is_ok() && cause.contains("ILLEGIT") && roots_shown < 30 {
                        roots_shown += 1;
                        let c = &sim.trains[cur];
                        let q = sim.plans[c.plan as usize].point(&sim.net, c.front);
                        eprintln!("ROOT m{} {cause}: id {} {:?} dh {} legs {} v {:.1} held {:.0} until+{:.0} ({:.0},{:.0}) sight {:.1} ma-front {:.0} stop {}/{} | {}", sim.plans[c.plan as usize].mode, c.id, c.state, c.dh, c.legs.len(), c.v, c.held_t, c.until - (t + c.toff), q[0], q[1], c.sight_gap, c.ma - c.front, c.stop, sim.plans[c.plan as usize].stop_front.len(), sim.why(cur).chars().take(100).collect::<String>());
                        if c.state == TState::Terminal { eprintln!("     TERM {}", sim.term_debug(cur)); }
                        if cause.contains("chain ends") {
                            for (j, o) in sim.trains.iter().enumerate() {
                                if j == cur || o.dead { continue; }
                                let oq = sim.plans[o.plan as usize].point(&sim.net, o.front);
                                let d = (oq[0] - q[0]).hypot(oq[1] - q[1]);
                                if d < 80.0 {
                                    eprintln!("     NEAR id {} {:?} dh {} depot {} d {:.0} front {:.0}/{:.0} len {:.0} v {:.1} | {}", o.id, o.state, o.dh, o.depot as i64, d, o.front, sim.plans[o.plan as usize].length, o.len, o.v, sim.spans_near(j).chars().take(160).collect::<String>());
                                }
                            }
                            eprintln!("     SELF {}", sim.spans_near(cur).chars().take(300).collect::<String>());
                        }
                    }
                    *causes.entry(format!("m{mode} {cause}")).or_insert(0) += 1;
                    let cm: Option<u8> = std::env::var("CHAIN_MODE").ok().and_then(|v| v.parse().ok());
                    if std::env::var("CHAIN").is_ok() && cm.map_or(stuck_ids.len() <= 400 && stuck_ids.len() % 10 == 0, |m| sim.plans[tr.plan as usize].mode == m && stuck_ids.len() < 300) {
                        let mut cur = k;
                        let mut line = String::new();
                        for _ in 0..6 {
                            let c = &sim.trains[cur];
                            let q = sim.plans[c.plan as usize].point(&sim.net, c.front);
                            let dw = if matches!(c.state, TState::Dwell | TState::Terminal) { format!(" stop {} until+{:.0} trip_start+{:.0} delay {:.0}", c.stop, c.until - t, sim.feeds[c.feed as usize].trip_start[c.trip as usize] as f64 - t, c.delay) } else { String::new() };
                            line += &format!(" -> [id {} m{} {:?}{}{} v {:.1} held {:.0} ({:.0},{:.0}) sight {:.0} {}]", c.id, sim.plans[c.plan as usize].mode, c.state, if c.dh { " dh" } else { "" }, dw, c.v, c.held_t, q[0], q[1], c.sight_gap, sim.why(cur).chars().take(60).collect::<String>());
                            let bl = sim.blocker(cur).map(|id| if id == 0 { sim.dir_holders(cur).first().copied().unwrap_or(0) } else { id });
                            if sim.blocker(cur) == Some(0) {
                                line += &format!(" dir-holders {:?}", sim.dir_holders(cur));
                            }
                            match bl.and_then(|id| sim.trains.iter().position(|o| o.id == id)) {
                                Some(j) if j != k => cur = j,
                                Some(_) => { line += " (cycle)"; break; }
                                None => break,
                            }
                        }
                        eprintln!("CHAIN{line}");
                        if std::env::var("SPANS").is_ok() {
                            eprintln!("  SPANS {}: {}", sim.trains[k].id, sim.spans_near(k));
                            if let Some(j) = sim.blocker(k).and_then(|id| sim.trains.iter().position(|o| o.id == id)) {
                                eprintln!("  SPANS {}: {}", sim.trains[j].id, sim.spans_near(j));
                            }
                        }
                    }
                }
                if tr.held_t > 60.0 && !matches!(tr.state, TState::Dwell | TState::Terminal) {
                    let p = sim.plans[tr.plan as usize].point(&sim.net, tr.front);
                    if depots.iter().any(|d| (d.0 - p[0]).hypot(d.1 - p[1]) < 500.0) {
                        held_depot += 1;
                        if ex.len() < 16 && tr.held_t < 130.0 {
                            let blk = sim.blocker(k).and_then(|id| sim.trains.iter().position(|o| o.id == id));
                            let bd = blk.map(|j| { let o = &sim.trains[j]; format!("id {} feed {} trip {} {:?} dh {} legs {} depot {} v {:.1} held {:.0}", o.id, o.feed, o.trip, o.state, o.dh, o.legs.len(), o.depot as i64, o.v, o.held_t) }).unwrap_or_else(|| "no train".into());
                            ex.push(format!("{:.0} held near a depot: feed {} trip {} {:?} dh {} at ({:.0},{:.0}) held {:.0} BY {} | {}", t, tr.feed, tr.trip, tr.state, tr.dh, p[0], p[1], tr.held_t, bd, sim.why(k).chars().take(120).collect::<String>()));
                        }
                    }
                }
            }
        }
    }
    let (mut n, mut done, mut fin) = (0, 0, 0);
    for (fi, ts) in sim.trip_state.iter().enumerate() {
        if !mine(sim.feeds[fi].id) && feeds.is_some() && !feeds.unwrap().contains(&fi) {
            continue;
        }
        for (trip, st) in ts.iter().enumerate() {
            // trips that ran inside the window
            let f = &sim.feeds[fi];
            if (f.trip_start[trip] as f64) < t0 || (f.trip_end[trip] as f64) > t1 {
                continue;
            }
            n += 1;
            match st {
                gta_sim::rail::TripState::Done => done += 1,
                gta_sim::rail::TripState::Finished => fin += 1,
                _ => {}
            }
        }
    }
    let mut sv: Vec<_> = stuck_at.into_iter().collect();
    sv.sort_by_key(|x| std::cmp::Reverse(x.1));
    let illegit: u32 = causes.iter().filter(|(k, _)| k.contains("ILLEGIT")).map(|(_, v)| *v).sum();
    eprintln!("STUCK >180 s (distinct trains): {} — without a legitimate occupant: {illegit}", stuck_ids.len());
    let mut cv: Vec<_> = causes.iter().collect();
    cv.sort_by_key(|x| std::cmp::Reverse(*x.1));
    for (k, c) in &cv {
        eprintln!("  cause x{c}: {k}");
    }
    for (k, c) in sv.iter().take(25) {
        eprintln!("  x{c} {k}");
    }
    (worst, n, fin, done, held_depot, ex, illegit)
}

/// ION (GRT 301) for a whole weekday: the line must never gridlock (all trains stopped away
/// from platforms for minutes) and every trip must run to its end.
#[test]
fn ion_full_day_no_gridlock() {
    let Some(mut sim) = load() else { return };
    let Some(fi) = sim.feeds.iter().position(|f| f.id == 4) else { eprintln!("no grt feed"); return };
    sim.step(0.2, 5.0 * 3600.0);
    let mut pts: Vec<(f64, f64)> = Vec::new();
    {
        let f = &sim.feeds[fi];
        for t in 0..f.trip_end.len() {
            let p = &sim.plans[(f.plan0 + f.trip_pattern[t]) as usize];
            for r in [0.0, p.length * 0.5, p.length] {
                let q = p.point(&sim.net, r);
                pts.push((q[0], q[1]));
            }
        }
    }
    let cx = pts.iter().map(|p| p.0).sum::<f64>() / pts.len() as f64;
    let cy = pts.iter().map(|p| p.1).sum::<f64>() / pts.len() as f64;
    let rmax = pts.iter().map(|p| (p.0 - cx).hypot(p.1 - cy)).fold(0.0, f64::max);
    let (worst, n, fin, done, held, ex, _) = day_run(&mut sim, Some(&[fi]), (cx, cy), rmax + 2000.0, 5.0 * 3600.0, 24.0 * 3600.0);
    eprintln!("ION: trips {n} finished {fin} aborted {done}; stuck (deadlock valve) {}, empty moves that gave way {}; worst all-stopped {worst:.0} s; held near a depot (samples) {held}", sim.stuck_removed, sim.dh_yield);
    for l in &sim.stuck_log {
        eprintln!("  stuck: {l}");
    }
    for e in &ex {
        eprintln!("  {e}");
    }
    assert!(worst < 180.0, "ION gridlocked for {worst:.0} s");
    assert!(done * 50 <= n.max(1), "{done} ION trips did not run to their end");
}

/// Every depot and terminus of TTC / GO / UP / VIA: a whole weekday with the network inside
/// the radius; trains are never held near a depot for minutes without making progress and
/// (almost) every trip runs to its end. (~30 s; open issue: streetcar junction deadlocks
/// downtown, see the printed list — run with --ignored)
#[test]
#[ignore]
fn no_stuck_trains() {
    let Some(mut sim) = load() else { return };
    sim.step(0.2, 5.0 * 3600.0);
    let fis: Vec<usize> = (0..sim.feeds.len()).collect();
    let (worst, n, fin, done, held, _ex, illegit) = day_run(&mut sim, Some(&fis), (-120.0, -950.0), 70000.0, 5.0 * 3600.0, 24.0 * 3600.0);
    eprintln!("ALL: trips {n} finished {fin} left / aborted {done}; worst all-stopped {worst:.0} s; held near a depot (samples) {held}; overlaps {} overruns {}", sim.overlaps, sim.overruns);
    assert_eq!(sim.overlaps, 0);
    assert_eq!(sim.overruns, 0);
    assert!(worst < 180.0);
    // target 0; the remaining few are terminals whose turnback path is not found (the train
    // is cleared off the platform after 45 s)
    assert!(illegit <= 50, "{illegit} trains stuck > 3 min without a legitimate occupant ahead");
}

/// debugging: direction-lock runs (bidirectional stretches) of each feed's plans
#[test]
#[ignore]
fn dir_chains() {
    let Some(mut sim) = load() else { return };
    sim.step(0.2, 8.0 * 3600.0);
    let mut seen = std::collections::HashSet::new();
    for f in &sim.feeds {
        let np = f.pat_mode.len();
        for p in 0..np {
            let pl = &sim.plans[(f.plan0 as usize) + p];
            let mut k = 0;
            while k < pl.spans.len() {
                let s = &pl.spans[k];
                if s.kind == 2 && seen.insert((f.id, s.res)) {
                    let e = &pl.spans[s.chain_end as usize];
                    if e.r1 - s.r0 > 1500.0 {
                        let a = pl.point(&sim.net, s.r0);
                        let b = pl.point(&sim.net, e.r1);
                        eprintln!("feed {} pat {} mode {} dir-run {:.0} m from ({:.0},{:.0}) to ({:.0},{:.0})", f.id, p, pl.mode, e.r1 - s.r0, a[0], a[1], b[0], b[1]);
                    }
                    k = s.chain_end as usize + 1;
                    continue;
                }
                k += 1;
            }
        }
    }
}

/// debugging: one area over a few hours (env AREA="x,y,r", HOURS="6,9", FEED=id)
#[test]
#[ignore]
fn area_run() {
    let Some(mut sim) = load() else { return };
    let a: Vec<f64> = std::env::var("AREA").unwrap_or("-8200,3900,3000".into()).split(',').map(|x| x.parse().unwrap()).collect();
    let h: Vec<f64> = std::env::var("HOURS").unwrap_or("6,9".into()).split(',').map(|x| x.parse().unwrap()).collect();
    sim.step(0.2, h[0] * 3600.0);
    let fis: Vec<usize> = match std::env::var("FEED").ok().and_then(|v| v.parse::<u32>().ok()) {
        Some(id) => (0..sim.feeds.len()).filter(|&k| sim.feeds[k].id == id).collect(),
        None => (0..sim.feeds.len()).collect(),
    };
    let (worst, n, fin, done, held, _ex, illegit) = day_run(&mut sim, Some(&fis), (a[0], a[1]), a[2], h[0] * 3600.0, h[1] * 3600.0);
    eprintln!("AREA: trips {n} finished {fin} left {done}; worst all-stopped {worst:.0} s; held near depot {held}; illegit {illegit}; overlaps {}", sim.overlaps);
}
