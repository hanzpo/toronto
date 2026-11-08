use super::*;

fn load(id: &str) -> World {
    let s = std::fs::read_to_string(format!("tests/data/{id}.json")).unwrap();
    World::new(&s, 7).ok().unwrap()
}

fn run(id: &str, cars: u32, trams: u32, trains: u32, peds: u32) -> (f32, usize, f32) {
    let mut w = load(id);
    w.populate(cars, 0, trams, trains, peds);
    let mut moved = 0.0f32;
    let mut samples = 0usize;
    let mut worst_overlap = 0.0f32;
    for k in 0..3000 {
        w.step(0.1);
        if k % 10 == 0 {
            for a in &w.agents {
                assert!(a.d.is_finite() && a.v.is_finite());
                if a.kind != AKind::Ped {
                    moved += a.v;
                    samples += 1;
                }
            }
            for (l, occ) in w.occ.iter().enumerate() {
                let _ = l;
                for p in 0..occ.len() {
                    for q in p + 1..occ.len() {
                        let (a, b) = (&w.agents[occ[p].1 as usize], &w.agents[occ[q].1 as usize]);
                        if a.kind == AKind::Ped || b.kind == AKind::Ped || occ[p].1 == occ[q].1 {
                            continue;
                        }
                        if a.lane == b.lane && a.dir == b.dir {
                            let (lo, hi) = if a.d < b.d { (a, b) } else { (b, a) };
                            let ov = lo.d - (hi.d - hi.len);
                            worst_overlap = worst_overlap.max(ov);
                        }
                    }
                }
            }
        }
    }
    (moved / samples.max(1) as f32, w.agents.len(), worst_overlap)
}

#[test]
fn layouts_flow() {
    for (id, cars, trams, trains, peds) in [
        ("arterial-x", 14, 0, 0, 30), ("king-spadina", 14, 4, 0, 30), ("local-t", 8, 0, 0, 10), ("allway", 10, 0, 0, 10),
        ("skew", 16, 0, 0, 20), ("level-crossing", 20, 0, 2, 10), ("tram-crossing", 15, 4, 0, 10), ("rail-yard", 0, 0, 3, 0),
        ("freeway-merge", 12, 0, 0, 0), ("overpass", 40, 0, 0, 10), ("paths", 15, 0, 0, 30),
    ] {
        let (avg, n, ov) = run(id, cars, trams, trains, peds);
        println!("{id}: avg speed {avg:.2} m/s, agents {n}, worst overlap {ov:.2} m");
    }
}

#[test]
fn diag_arterial() {
    let mut w = load("arterial-x");
    w.populate(40, 0, 0, 0, 0);
    for _ in 0..1500 { w.step(0.1); }
    w.rebuild_occ();
    let mut shown = 0;
    for i in 0..w.agents.len() {
        let a = &w.agents[i];
        if a.v > 0.5 || shown > 60 || ln_node_none(&w, a.lane) { continue; }
        shown += 1;
        let ln = &w.net.lanes[a.lane as usize];
        let nx = a.route.front().copied();
        let ce = nx.map(|s| w.can_enter(i, s.lane));
        let (gap, lv) = w.leader_gap(i);
        println!("a{i} lane {} node {:?} d {:.1}/{:.1} v {:.2} next {:?} can {:?} gap {:.1} lv {:.1} stop {:.1}", a.lane, ln.node, a.d, ln.len, a.v, nx.map(|s| (s.lane, w.net.lanes[s.lane as usize].node, w.net.lanes[s.lane as usize].signal)), ce, gap, lv, a.stopped);
    }
}
fn ln_node_none(w: &World, l: u32) -> bool { w.net.lanes[l as usize].node.is_none() }

#[test]
fn diag_front() {
    let mut w = load("arterial-x");
    w.populate(40, 0, 0, 0, 0);
    for _ in 0..1500 { w.step(0.1); }
    w.rebuild_occ();
    for (l, occ) in w.occ.iter().enumerate() {
        let Some(&(_, j)) = occ.iter().filter(|&&(_, j)| w.agents[j as usize].lane == l as u32).last() else { continue };
        let a = &w.agents[j as usize];
        let nx = a.route.front().copied();
        println!("lane {l} front a{j} d {:.1}/{:.1} v {:.2} next {:?} why {:?} sig {:?}", a.d, w.net.lanes[l].len, a.v, nx.map(|s| s.lane), nx.map(|s| w.why(j as usize, s.lane)), nx.and_then(|s| w.net.lanes[s.lane as usize].signal.map(|(n,g)| w.signal_state(n,g))));
    }
}

#[test]
fn diag_flow() {
    let mut w = load("arterial-x");
    w.populate(14, 0, 0, 0, 0);
    let mut prev: Vec<u32> = w.agents.iter().map(|a| a.lane).collect();
    let mut entries = 0;
    for k in 0..3000 {
        w.step(0.1);
        for (i, a) in w.agents.iter().enumerate() {
            if i < prev.len() && prev[i] != a.lane && w.net.lanes[a.lane as usize].node == Some(0) { entries += 1; }
        }
        prev = w.agents.iter().map(|a| a.lane).collect();
        if k % 300 == 299 {
            w.rebuild_occ();
            let mut reasons = std::collections::HashMap::new();
            for (i, a) in w.agents.iter().enumerate() {
                if a.v > 0.3 { *reasons.entry("moving").or_insert(0) += 1; continue; }
                let (gap, _) = w.leader_gap(i);
                let rem = w.net.lanes[a.lane as usize].len - a.d;
                let r = if gap < rem - 1.0 { "queued" } else { a.route.front().and_then(|s| w.why(i, s.lane)).unwrap_or("none") };
                *reasons.entry(r).or_insert(0) += 1;
            }
            println!("t {:.0} entries {entries} {:?}", w.t, reasons);
        }
    }
}

#[test]
fn diag_one() {
    let mut w = load("arterial-x");
    w.populate(1, 0, 0, 0, 0);
    for k in 0..1200 {
        w.step(0.1);
        if k % 20 == 0 {
            w.rebuild_occ();
            let a = &w.agents[0];
            let (gap, lv) = w.leader_gap(0);
            println!("t {:.0} lane {} node {:?} d {:.1}/{:.1} v {:.2} route {:?} why {:?} gap {gap:.1} lv {lv:.1}", w.t, a.lane, w.net.lanes[a.lane as usize].node, a.d, w.net.lanes[a.lane as usize].len, a.v, a.route.iter().map(|s| s.lane).collect::<Vec<_>>(), a.route.front().map(|s| w.why(0, s.lane)));
        }
    }
}

fn crossing_safety(id: &str, kind: AKind) {
    let mut w = load(id);
    w.populate(14, 0, if kind == AKind::Tram { 4 } else { 0 }, if kind == AKind::Train { 2 } else { 0 }, 0);
    let xn = w.net.node_kind.iter().position(|k| k.ends_with("crossing")).unwrap() as u16;
    let mut downs = 0;
    let mut clashes = 0;
    let mut passes = 0;
    let mut was_on = false;
    for _ in 0..6000 {
        w.step(0.1);
        if w.gate[xn as usize] > 0.98 { downs += 1; }
        let on = |k: AKind| w.agents.iter().any(|a| a.kind == k && w.net.lanes[a.lane as usize].node == Some(xn));
        let t_on = on(kind);
        if t_on && !was_on { passes += 1; }
        was_on = t_on;
        if t_on && (on(AKind::Car)) { clashes += 1; }
    }
    println!("{id}: passes {passes}, gate-down steps {downs}, steps with a car and a {kind:?} in the crossing {clashes}");
    assert!(passes > 0);
    assert_eq!(clashes, 0);
}

#[test]
fn crossings_are_safe() {
    crossing_safety("level-crossing", AKind::Train);
    crossing_safety("tram-crossing", AKind::Tram);
}
