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
    let mut w = World::new(5, 16000, 12000);
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
        eprintln!("p0 {:?} p1 {:?} p2 {:?} arc {:?}", bp.bez.p0, bp.bez.p1, bp.bez.p2, bp.arc);
        let n = &w.g.nodes[la.to as usize];
        eprintln!("node {:.1},{:.1} setback {} control {:?}", n.x, n.y, n.setback, n.control);
        for k in 0..=10 { let (x, y, _) = bp.at(k as f32 / 10.0); eprint!("({:.1},{:.1}) ", x, y); }
        eprintln!();
    }
    assert!(w.cars.len() > 2000);
}
