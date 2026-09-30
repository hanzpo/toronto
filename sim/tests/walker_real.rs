//! The walking player on the real road graph (skipped when the data is absent):
//! AI cars approaching a pedestrian standing in their lane stop short of them.

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
fn cars_stop_for_the_walker_on_real_streets() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../app/public/data/graph");
    if !dir.exists() {
        eprintln!("no graph data, skipping");
        return;
    }
    // King & Spadina
    let (fx, fy) = (-1180.0f64, -620.0f64);
    let mut w = World::new(5, 6000, 2000);
    for tx in -3..=0 {
        for ty in -3..=1 {
            load(&mut w, &dir, tx, ty);
        }
    }
    w.focus = (fx, fy);
    w.radius = 1300.0;
    w.tod = 8.25 * 3600.0;
    w.weekday = 2;
    for _ in 0..900 {
        w.set_obstacles(&[]);
        w.step(0.1);
    }
    w.write_cars(0.0, 0.0);
    let (mut tested, mut stopped, mut through) = (0, 0, 0);
    let mut fails = Vec::new();
    let ids: Vec<u32> = w.cars.iter().filter(|c| c.v > 6.0 && c.link != u32::MAX && c.flags & 2 == 0).map(|c| c.id).collect();
    for id in ids {
        if tested >= 25 {
            break;
        }
        let Some(c) = w.cars.iter().find(|c| c.id == id) else { continue };
        let (link, lane, s) = (c.link, c.lane, c.s);
        let l = &w.g.links[link as usize];
        if !l.alive || l.len - s < 25.0 || (c.pose.x - fx).hypot(c.pose.y - fy) > 900.0 {
            continue;
        }
        let class = l.class;
        // stand in the middle of its lane 18 m ahead of the bumper
        let sw = s + 18.0;
        let pose = w.g.link_pose(link, sw, w.g.lane_offset(l, lane));
        tested += 1;
        let mut ok = true;
        let mut min_gap = f32::INFINITY;
        for _ in 0..100 {
            w.set_walker(pose.x, pose.y, pose.z, 0.5, 0.1);
            w.set_obstacles(&[]);
            w.step(0.1);
            let Some(c) = w.cars.iter().find(|c| c.id == id) else { break };
            if c.link == link && c.lane == lane {
                min_gap = min_gap.min(sw - c.s);
                if c.s > sw - 0.3 {
                    ok = false;
                }
            } else if c.link != link {
                break;
            }
        }
        w.set_walker(0.0, 0.0, 0.0, 0.0, 0.1);
        if ok {
            stopped += 1;
        } else {
            through += 1;
            fails.push((id, link, lane, s, min_gap, class));
        }
    }
    eprintln!("walker: {tested} cars tested, {stopped} stopped, {through} ran through {fails:?}");
    assert!(tested >= 5, "too few cars to test ({tested})");
    assert_eq!(through, 0, "cars drove through the walker: {fails:?}");
}
