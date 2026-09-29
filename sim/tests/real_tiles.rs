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
