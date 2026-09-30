//! Stress test on the real road graph (skipped when the data is absent):
//! loads tiles around a moving focus, evicts far ones, and runs cars,
//! pedestrians and the player for many steps.

use std::collections::HashSet;
use std::io::Read;
use std::path::PathBuf;

use gta_sim::graph::TileData;
use gta_sim::world::World;

struct Arr {
    dt: String,
    bytes: Vec<u8>,
}

fn read_tbn(path: &PathBuf) -> Option<(std::collections::HashMap<String, Arr>, String)> {
    let raw = std::fs::read(path).ok()?;
    let mut d = flate2::read::GzDecoder::new(&raw[..]);
    let mut buf = Vec::new();
    d.read_to_end(&mut buf).ok()?;
    assert_eq!(&buf[0..4], b"TBN1");
    let hl = u32::from_le_bytes(buf[4..8].try_into().unwrap()) as usize;
    let header = String::from_utf8(buf[8..8 + hl].to_vec()).unwrap();
    let mut base = 8 + hl;
    base += (8 - base % 8) % 8;
    // minimal JSON scan of "arrays": {"name": ["dt", off, n], ...}
    let mut out = std::collections::HashMap::new();
    let a = header.find("\"arrays\":{").unwrap() + 10;
    let end = header[a..].find("}").unwrap() + a;
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
fn f64s(a: &Arr) -> Vec<f64> {
    a.bytes.chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect()
}
fn u32s(a: &Arr) -> Vec<u32> {
    a.bytes.chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect()
}

fn load(w: &mut World, dir: &PathBuf, tx: i32, ty: i32) -> bool {
    let Some((a, _)) = read_tbn(&dir.join(format!("{tx}_{ty}.bin.gz"))) else { return false };
    let _ = &a["e_class"].dt;
    let n_id = f64s(&a["n_id"]);
    let n_xyz = f32s(&a["n_xyz"]);
    let e_from = u32s(&a["e_from"]);
    let e_to = u32s(&a["e_to"]);
    let e_off = u32s(&a["e_off"]);
    let e_xyz = f32s(&a["e_xyz"]);
    let e_speed = f32s(&a["e_speed"]);
    let bn = vec![0.5f32; e_from.len()];
    w.g.add_tile(&TileData {
        tx,
        ty,
        n_id: &n_id,
        n_xyz: &n_xyz,
        n_flags: &a["n_flags"].bytes,
        e_from: &e_from,
        e_to: &e_to,
        e_off: &e_off,
        e_xyz: &e_xyz,
        e_class: &a["e_class"].bytes,
        e_lanes_fwd: &a["e_lanes_fwd"].bytes,
        e_lanes_bwd: &a["e_lanes_bwd"].bytes,
        e_speed: &e_speed,
        e_flags: &a["e_flags"].bytes,
        bottleneck: &bn,
        e_width: &a.get("e_width").map(f32s).unwrap_or_default(),
        e_side: a.get("e_side").map(|x| x.bytes.clone()).as_deref().unwrap_or(&[]),
    });
    true
}

#[test]
fn moving_focus_on_real_graph() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../app/public/data/graph");
    if !dir.exists() {
        eprintln!("no graph data, skipping");
        return;
    }
    let mut w = World::new(11, 12000, 8000);
    w.peds.set_stops(&[-250.0, -700.0, 80.0, 1800.0, 2600.0, 90.0]);
    let mut loaded: HashSet<(i32, i32)> = HashSet::new();
    let radius = 1500.0f64;
    // drive the focus from downtown up to the DVP and on to the 401
    let path = [(-250.0, -700.0), (1800.0, 2600.0), (3000.0, 12500.0), (-250.0, -700.0)];
    let mut steps = 0;
    let t0 = std::time::Instant::now();
    let mut max_cars = 0;
    for leg in path.windows(2) {
        for k in 0..300 {
            let t = k as f64 / 300.0;
            let fx = leg[0].0 + (leg[1].0 - leg[0].0) * t;
            let fy = leg[0].1 + (leg[1].1 - leg[0].1) * t;
            let r = radius + 250.0;
            for tx in ((fx - r) / 1024.0).floor() as i32..=((fx + r) / 1024.0).floor() as i32 {
                for ty in ((fy - r) / 1024.0).floor() as i32..=((fy + r) / 1024.0).floor() as i32 {
                    if !loaded.contains(&(tx, ty)) && load(&mut w, &dir, tx, ty) {
                        loaded.insert((tx, ty));
                    }
                }
            }
            let far: Vec<_> = loaded
                .iter()
                .copied()
                .filter(|&(tx, ty)| {
                    let cx = (tx as f64 + 0.5) * 1024.0;
                    let cy = (ty as f64 + 0.5) * 1024.0;
                    (cx - fx).hypot(cy - fy) > r + 1800.0
                })
                .collect();
            for t in far {
                w.g.remove_tile(t.0, t.1);
                loaded.remove(&t);
            }
            w.focus = (fx, fy);
            w.radius = radius;
            w.peds.radius = 900.0;
            if steps == 50 {
                assert!(w.spawn_player(fx, fy, 0.0));
            }
            for _ in 0..3 {
                w.player_step(0.1, 1.0, 0.0, 0.3, false, 80.0);
                w.step(0.1);
                steps += 1;
            }
            w.write_cars(0.0, 0.0);
            w.peds.write(&w.g, 0.0, 0.0);
            max_cars = max_cars.max(w.cars.len());
            if steps % 300 == 0 {
                let arr = w.measured();
                assert!(arr.len() % 4 == 0);
            }
        }
    }
    let el = t0.elapsed().as_secs_f64();
    eprintln!("{steps} steps, max {max_cars} cars, {} peds, {:.2} ms/step (native, incl. tile loading)", w.peds.list.len(), el * 1000.0 / steps as f64);
    assert!(max_cars > 500);
}

fn load_around(w: &mut World, dir: &PathBuf, fx: f64, fy: f64, r: f64) {
    for tx in ((fx - r) / 1024.0).floor() as i32..=((fx + r) / 1024.0).floor() as i32 {
        for ty in ((fy - r) / 1024.0).floor() as i32..=((fy + r) / 1024.0).floor() as i32 {
            load(w, dir, tx, ty);
        }
    }
}

/// rendered car bodies that overlap: (count, pairs in junction boxes)
fn overlaps(w: &World) -> (usize, usize, Vec<String>) {
    use gta_sim::collide::{obb_overlap, Obb};
    use std::collections::HashMap;
    let mut grid: HashMap<(i32, i32), Vec<usize>> = HashMap::new();
    let mut boxes = Vec::new();
    for (i, c) in w.cars.iter().enumerate() {
        let (p, _) = w.car_pose(i);
        let b = Obb { x: p.x, y: p.y, h: p.h, hl: c.len * 0.5 - 0.15, hw: gta_sim::world::HALF_W[c.kind as usize] - 0.1 };
        grid.entry(((p.x / 10.0).floor() as i32, (p.y / 10.0).floor() as i32)).or_default().push(i);
        boxes.push((b, p.z));
    }
    let mut n = 0;
    let mut nbox = 0;
    let mut ex = Vec::new();
    for (i, c) in w.cars.iter().enumerate() {
        let (b, z) = boxes[i];
        let (cx, cy) = ((b.x / 10.0).floor() as i32, (b.y / 10.0).floor() as i32);
        for dx in -1..=1 {
            for dy in -1..=1 {
                if let Some(v) = grid.get(&(cx + dx, cy + dy)) {
                    for &j in v {
                        if j <= i || (boxes[j].1 - z).abs() > 3.0 {
                            continue;
                        }
                        if obb_overlap(&b, &boxes[j].0).map_or(false, |(_, pen)| pen > 0.35) {
                            n += 1;
                            let o = &w.cars[j];
                            let in_box = c.link != o.link || c.lane != o.lane;
                            if in_box {
                                nbox += 1;
                            }
                            if ex.len() < 8 {
                                let (l1, l2) = (&w.g.links[c.link as usize], &w.g.links[o.link as usize]);
                                let (n1, n2) = (&w.g.nodes[l1.to as usize], &w.g.nodes[l2.to as usize]);
                                let (pa, _) = w.car_pose(i);
                                let (pb, _) = w.car_pose(j);
                                ex.push(format!(
                                    "d={:.2} h={:.2}/{:.2} plane {}/{} @({:.0},{:.0}) link {}/{} len {:.0}/{:.0} cls {}/{} fl {}/{} ctl {:?}/{:?} same_to {} lane {}/{} s {:.1}/{:.1} lc {}/{} prev {}/{} next {}/{} turn {:?}/{:?} v {:.1}/{:.1} len {:.1}/{:.1}",
                                    (pa.x - pb.x).hypot(pa.y - pb.y), pa.h, pb.h, c.prev_lane, o.prev_lane, b.x, b.y, c.link, o.link, l1.len, l2.len, l1.class, l2.class, l1.flags, l2.flags, n1.control, n2.control, l1.to == l2.to,
                                    c.lane, o.lane, c.s, o.s, c.lc_from, o.lc_from, c.prev, o.prev, c.next, o.next, c.turn, o.turn, c.v, o.v, c.len, o.len
                                ));
                            }
                        }
                    }
                }
            }
        }
    }
    (n, nbox, ex)
}

#[test]
fn street_level_king_spadina() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../app/public/data/graph");
    if !dir.exists() {
        eprintln!("no graph data, skipping");
        return;
    }
    let (fx, fy) = (-1300.0, -900.0);
    let seed: u64 = std::env::var("SEED").ok().and_then(|x| x.parse().ok()).unwrap_or(5);
    let mut w = World::new(seed, 16000, 12000);
    load_around(&mut w, &dir, fx, fy, 2600.0);
    w.focus = (fx, fy);
    w.radius = 1900.0;
    w.peds.radius = 900.0;
    w.tod = 17.5 * 3600.0;
    w.weekday = 3;
    // a stopped streetcar on King westbound-ish and one crossing: exercise obstacles
    let obst = [fx + 40.0, fy + 3.0, std::f64::consts::PI, 30.2, 2.54, 0.0, 4.0, fx - 5.0, fy + 60.0, -1.4, 30.2, 2.54, 5.0, 4.0];
    let mut worst = 0.0f64;
    let mut total = 0.0f64;
    let mut max_ov = 0;
    let mut sum_ov = 0;
    let mut samples = 0;
    let mut ex = Vec::new();
    let t_all = std::time::Instant::now();
    let mut causes = [0u32; 10];
    let mut cex: Vec<Vec<String>> = vec![Vec::new(); 10];
    let mut young = u32::MAX;
    let mut uniq: Vec<std::collections::HashSet<String>> = vec![Default::default(); 10];
    for k in 0..1500 {
        if k % 3 == 0 {
            w.set_obstacles(&obst);
        }
        let t0 = std::time::Instant::now();
        w.step(0.2);
        w.write_cars(0.0, 0.0);
        w.peds.write(&w.g, 0.0, 0.0);
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        if k >= 300 {
            total += ms;
            worst = worst.max(ms);
        }
        if k >= 300 && k % 25 == 0 {
            let (cz, ce) = w.overlap_causes(young, 400);
            for e in ce.iter() {
                let kk: usize = e[1..2].parse().unwrap();
                let id = e.split(' ').nth(2).unwrap().to_string();
                uniq[kk].insert(id);
            }
            for q in 0..10 {
                causes[q] += cz[q];
            }
            if cz.iter().sum::<u32>() > 0 {
                for e in ce {
                    let kk: usize = e[1..2].parse().unwrap();
                    if cex[kk].len() < 5 && !cex[kk].iter().any(|x: &String| x.split(' ').nth(2) == e.split(' ').nth(2)) {
                        cex[kk].push(e);
                    }
                }
            }
            young = w.next_car_id();
            let (n, nb, e) = overlaps(&w);
            max_ov = max_ov.max(n);
            sum_ov += n;
            samples += 1;
            if n > 0 && ex.len() < 12 {
                ex.extend(e);
            }
            let _ = nb;
        }
    }
    let avg = total / 1200.0;
    eprintln!(
        "king&spadina: {} cars (target {:.0}), {} peds, avg {:.2} ms/step, worst {:.2} ms (native) | overlaps avg {:.2} max {} | total {:.1}s",
        w.cars.len(),
        w.target_cars,
        w.peds.list.len(),
        avg,
        worst,
        sum_ov as f64 / samples as f64,
        max_ov,
        t_all.elapsed().as_secs_f64()
    );
    let names = ["spawn", "lane change", "short link", "junction crossing", "same lane", "adjacent lanes", "merge", "other", "junction following", "structure vs street"];
    // bridge / tunnel cars over unconnected streets are drawn on another level: not visible
    let visible = causes[..9].iter().sum::<u32>() as f64 / samples.max(1) as f64;
    eprintln!("  overlaps on the same level: avg {visible:.2} per sample");
    assert!(visible <= 15.0, "car bodies overlap: {visible:.1} per sample");
    eprintln!("  overlap causes (sum over samples): {}", names.iter().zip(causes.iter()).map(|(a, b)| format!("{a} {b}")).collect::<Vec<_>>().join(", "));
    eprintln!("  distinct pairs: {}", names.iter().zip(uniq.iter()).map(|(a, b)| format!("{a} {}", b.len())).collect::<Vec<_>>().join(", "));
    if std::env::var("OV_EX").is_ok() {
        for (q, v) in cex.iter().enumerate() {
            for e in v {
                eprintln!("    {} {e}", names[q]);
            }
        }
    }
    eprintln!("  phases ms/step [validate sort occ accel lanechg advance spawn peds]: {:?}", w.prof.map(|x| (x / 1500.0 * 100.0).round() / 100.0));
    for e in ex.iter().take(12) {
        eprintln!("  {e}");
    }
    if let Ok(dbg) = std::env::var("DBG_LINKS") {
        let v: Vec<u32> = dbg.split(',').map(|x| x.parse().unwrap()).collect();
        let (a, b) = (v[0], v[1]);
        let la = &w.g.links[a as usize];
        let lb = &w.g.links[b as usize];
        eprintln!("in len {} lanes {} out len {} lanes {} sb_in {} sb_out {} to==from {}", la.len, la.lanes, lb.len, lb.lanes, w.sb_in(a), w.sb_out(b), la.to == lb.from);
        let bp = w.box_path(a, 0, b, 0);
        eprintln!("p0 {:?} c1 {:?} c2 {:?} p2 {:?} arc {:?}", bp.bez.p0, bp.bez.c1, bp.bez.c2, bp.bez.p2, bp.arc);
        let n = &w.g.nodes[la.to as usize];
        eprintln!("node {:.1},{:.1} setback {} control {:?}", n.x, n.y, n.setback, n.control);
        for k in 0..=10 { let (x, y, _) = bp.at(k as f32 / 10.0); eprint!("({:.1},{:.1}) ", x, y); }
        eprintln!();
    }
    assert!(w.cars.len() > 2000);
    // median waits: how far the body is turned off the gap it waits in
    let m = w.median_waits();
    let mut rows: Vec<(f32, f32, f32, f32, f32, f32, u32, u32)> = Vec::new();
    for r in m.chunks_exact(10) {
        // the body must point within the turn's sweep (from the road it left to the gap), ±20°
        let turn = graph_wrap(r[3] - r[4]);
        let rel = graph_wrap(r[2] - r[4]);
        let (lo, hi) = (turn.min(0.0) - 0.35, turn.max(0.0) + 0.35);
        let off = if r[4].is_nan() { 0.0 } else if rel < lo { lo - rel } else if rel > hi { rel - hi } else { 0.0 };
        let dp = graph_wrap(r[2] - r[4]).abs().to_degrees();
        rows.push((r[0], r[1], off.to_degrees(), dp, r[5], r[7], r[8] as u32, r[9] as u32));
    }
    rows.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap());
    eprintln!("median waits: {} (body outside the turn sweep by > 10 deg: {})", rows.len(), rows.iter().filter(|r| r.2 > 10.0).count());
    // (a few outliers are metric artefacts: hooked edge ends in the source geometry)
    assert!(rows.iter().filter(|r| r.2 > 30.0).count() * 50 <= rows.len().max(50), "cars turned off their path while waiting in medians");
    for r in rows.iter().take(6) {
        eprintln!("  at ({:.0}, {:.0}) outside sweep {:.0} deg, body-road {:.0} deg, gap len {:.1} m, s {:.1}", r.0, r.1, r.2, r.3, r.4, r.5);
        let dump = |li: u32| -> String {
            if li as usize >= w.g.links.len() { return "-".into(); }
            let l = &w.g.links[li as usize];
            (0..=4).map(|k| { let p = w.g.link_pose(li, l.len * k as f32 / 4.0, 0.0); format!("({:.1},{:.1} h{:.0})", p.x, p.y, p.h.to_degrees()) }).collect::<Vec<_>>().join(" ")
        };
        eprintln!("     gap  {}", dump(r.6));
        eprintln!("     prev {}", dump(r.7));
    }

}

fn graph_wrap(a: f32) -> f32 {
    let mut a = a;
    while a > std::f32::consts::PI { a -= std::f32::consts::TAU; }
    while a < -std::f32::consts::PI { a += std::f32::consts::TAU; }
    a
}

/// Playtest: DVP at Bloor in the AM peak — southbound (inbound) must be the slow direction.
#[test]
fn dvp_am_peak_direction() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../app/public/data/graph");
    if !dir.exists() {
        return;
    }
    let (fx, fy): (f64, f64) = std::env::var("DVP_XY").ok().map(|v| { let p: Vec<f64> = v.split(',').map(|x| x.parse().unwrap()).collect(); (p[0], p[1]) }).unwrap_or((2150.0, 2100.0));
    let mut w = World::new(5, 16000, 12000);
    load_around(&mut w, &dir, fx, fy, 2600.0);
    w.focus = (fx, fy);
    w.radius = 1900.0;
    w.peds.radius = 300.0;
    w.tod = std::env::var("TOD").ok().and_then(|v| v.parse::<f64>().ok()).unwrap_or(8.0) * 3600.0;
    w.weekday = 3;
    w.tide_on = std::env::var("NO_TIDE").is_err();
    let (mut vs, mut ns, mut vn, mut nn) = (0.0f64, 0u32, 0.0f64, 0u32);
    let mut causes = [0u32; 10];
    let mut young = u32::MAX;
    for k in 0..1500 {
        w.step(0.2);
        w.write_cars(0.0, 0.0);
        if k > 300 && k % 25 == 0 {
            let (c, ex) = w.overlap_causes(young, 3);
            young = w.next_car_id();
            for q in 0..10 { causes[q] += c[q]; }
            if std::env::var("OV_EX").is_ok() { for e in ex { eprintln!("   {e}"); } }
        }
        if k > 600 && k % 10 == 0 {
            for (i, c) in w.cars.iter().enumerate() {
                let l = &w.g.links[c.link as usize];
                if l.class != 0 || !l.alive {
                    continue;
                }
                let (p, _) = w.car_pose(i);
                if (p.x - fx).hypot(p.y - fy) > 900.0 {
                    continue;
                }
                // "inbound" = heading towards City Hall along the road's main axis (N/S or E/W)
                let (tx, ty) = (-p.x, -p.y);
                let inb = if fx.abs() < fy.abs() * 1.5 { p.h.sin() as f64 * ty.signum() } else { p.h.cos() as f64 * tx.signum() };
                if inb > 0.5 {
                    vs += c.v as f64;
                    ns += 1;
                } else if inb < -0.5 {
                    vn += c.v as f64;
                    nn += 1;
                }
            }
        }
    }
    eprintln!("  overlap causes (48 samples): {:?}", causes);
    eprintln!("expressway 08:02-08:05 near ({fx},{fy}): inbound {:.1} m/s (n {ns}), outbound {:.1} m/s (n {nn})", vs / ns.max(1) as f64, vn / nn.max(1) as f64);
    assert!(vs / ns.max(1) as f64 <= vn / nn.max(1) as f64 + 0.5, "AM peak: inbound should be the slow direction");
}
