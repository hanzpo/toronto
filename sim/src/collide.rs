//! Collision helpers for the player car: oriented boxes (cars, transit
//! vehicles) and building footprints (outline segments on a uniform grid,
//! streamed per level-0 render tile by the worker while driving).

use std::collections::HashMap;

const CELL: f32 = 32.0;

/// Oriented rectangle: centre, unit heading, half length / half width.
#[derive(Clone, Copy, Debug)]
pub struct Obb {
    pub x: f64,
    pub y: f64,
    pub h: f32,
    pub hl: f32,
    pub hw: f32,
}

impl Obb {
    fn axes(&self) -> [(f32, f32); 2] {
        let (s, c) = self.h.sin_cos();
        [(c, s), (-s, c)]
    }
    fn radius_on(&self, ax: (f32, f32)) -> f32 {
        let [f, l] = self.axes();
        self.hl * (f.0 * ax.0 + f.1 * ax.1).abs() + self.hw * (l.0 * ax.0 + l.1 * ax.1).abs()
    }
}

/// Separating-axis test. Returns the minimum translation (unit axis pointing
/// from `b` to `a`, depth) when the boxes overlap.
pub fn obb_overlap(a: &Obb, b: &Obb) -> Option<((f32, f32), f32)> {
    let d = ((a.x - b.x) as f32, (a.y - b.y) as f32);
    let mut best: Option<((f32, f32), f32)> = None;
    for ax in a.axes().into_iter().chain(b.axes()) {
        let dist = d.0 * ax.0 + d.1 * ax.1;
        let pen = a.radius_on(ax) + b.radius_on(ax) - dist.abs();
        if pen <= 0.0 {
            return None;
        }
        if best.map_or(true, |bb| pen < bb.1) {
            let sgn = if dist >= 0.0 { 1.0 } else { -1.0 };
            best = Some(((ax.0 * sgn, ax.1 * sgn), pen));
        }
    }
    best
}

/// Building outline segments, bucketed by tile (for eviction) and grid cell.
#[derive(Default)]
pub struct Footprints {
    segs: Vec<[f32; 4]>,
    free: Vec<u32>,
    tiles: HashMap<(i32, i32), Vec<u32>>,
    grid: HashMap<(i32, i32), Vec<u32>>,
    /// world origin of the segment coordinates (tile 0,0 corner): world = seg
    pub count: usize,
}

#[inline]
fn gcell(x: f32, y: f32) -> (i32, i32) {
    ((x / CELL).floor() as i32, (y / CELL).floor() as i32)
}

impl Footprints {
    pub fn has_tile(&self, tx: i32, ty: i32) -> bool {
        self.tiles.contains_key(&(tx, ty))
    }

    /// `ring_off` [n+1] into `xy` (world E/N pairs, f32 is plenty for collisions).
    pub fn add_tile(&mut self, tx: i32, ty: i32, ring_off: &[u32], xy: &[f32]) {
        if self.has_tile(tx, ty) {
            return;
        }
        let mut ids = Vec::new();
        for r in ring_off.windows(2) {
            let (a, b) = (r[0] as usize, r[1] as usize);
            if b < a + 3 || b * 2 > xy.len() {
                continue;
            }
            for k in a..b {
                let k2 = if k + 1 == b { a } else { k + 1 };
                let s = [xy[k * 2], xy[k * 2 + 1], xy[k2 * 2], xy[k2 * 2 + 1]];
                if (s[2] - s[0]).hypot(s[3] - s[1]) < 0.05 {
                    continue;
                }
                let id = if let Some(i) = self.free.pop() {
                    self.segs[i as usize] = s;
                    i
                } else {
                    self.segs.push(s);
                    (self.segs.len() - 1) as u32
                };
                ids.push(id);
                for c in seg_cells(&s) {
                    self.grid.entry(c).or_default().push(id);
                }
            }
        }
        self.count += ids.len();
        self.tiles.insert((tx, ty), ids);
    }

    pub fn remove_tile(&mut self, tx: i32, ty: i32) {
        let Some(ids) = self.tiles.remove(&(tx, ty)) else { return };
        for &id in &ids {
            let s = self.segs[id as usize];
            for c in seg_cells(&s) {
                if let Some(v) = self.grid.get_mut(&c) {
                    v.retain(|&x| x != id);
                    if v.is_empty() {
                        self.grid.remove(&c);
                    }
                }
            }
            self.free.push(id);
        }
        self.count -= ids.len();
    }

    pub fn tiles(&self) -> Vec<(i32, i32)> {
        self.tiles.keys().copied().collect()
    }

    /// Push a circle (x, y, r) out of every building outline it overlaps.
    /// Returns the accumulated push vector (world m) or None.
    pub fn push_circle(&self, x: f32, y: f32, r: f32) -> Option<(f32, f32)> {
        let (c0x, c0y) = gcell(x - r, y - r);
        let (c1x, c1y) = gcell(x + r, y + r);
        let mut push = (0.0f32, 0.0f32);
        let mut hit = false;
        for cx in c0x..=c1x {
            for cy in c0y..=c1y {
                let Some(v) = self.grid.get(&(cx, cy)) else { continue };
                for &id in v {
                    let s = self.segs[id as usize];
                    let (dx, dy) = (s[2] - s[0], s[3] - s[1]);
                    let l2 = dx * dx + dy * dy;
                    let t = (((x - s[0]) * dx + (y - s[1]) * dy) / l2).clamp(0.0, 1.0);
                    let (px, py) = (s[0] + dx * t, s[1] + dy * t);
                    let (ex, ey) = (x + push.0 - px, y + push.1 - py);
                    let d = ex.hypot(ey);
                    if d < r {
                        hit = true;
                        let (nx, ny) = if d > 1e-4 { (ex / d, ey / d) } else { (-dy / l2.sqrt(), dx / l2.sqrt()) };
                        push.0 += nx * (r - d);
                        push.1 += ny * (r - d);
                    }
                }
            }
        }
        if hit {
            Some(push)
        } else {
            None
        }
    }
}

fn seg_cells(s: &[f32; 4]) -> Vec<(i32, i32)> {
    let mut v = Vec::with_capacity(2);
    let n = (((s[2] - s[0]).hypot(s[3] - s[1])) / (CELL * 0.5)).ceil().max(1.0) as usize;
    for k in 0..=n {
        let t = k as f32 / n as f32;
        let c = gcell(s[0] + (s[2] - s[0]) * t, s[1] + (s[3] - s[1]) * t);
        if !v.contains(&c) {
            v.push(c);
        }
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boxes() {
        let a = Obb { x: 0.0, y: 0.0, h: 0.0, hl: 2.3, hw: 0.9 };
        let b = Obb { x: 4.0, y: 0.5, h: 0.2, hl: 2.3, hw: 0.9 };
        let (ax, d) = obb_overlap(&a, &b).unwrap();
        assert!(d > 0.0 && ax.0 < 0.0, "{ax:?} {d}");
        let c = Obb { x: 0.0, y: 2.5, h: 0.0, hl: 2.3, hw: 0.9 };
        assert!(obb_overlap(&a, &c).is_none());
    }

    #[test]
    fn footprint_push() {
        let mut f = Footprints::default();
        // 10 m square building at (100..110, 100..110)
        f.add_tile(0, 0, &[0, 4], &[100.0, 100.0, 110.0, 100.0, 110.0, 110.0, 100.0, 110.0]);
        let p = f.push_circle(99.5, 105.0, 1.0).unwrap();
        assert!(p.0 < -0.4 && p.1.abs() < 1e-3, "{p:?}");
        assert!(f.push_circle(95.0, 105.0, 1.0).is_none());
        f.remove_tile(0, 0);
        assert!(f.push_circle(99.5, 105.0, 1.0).is_none());
        assert_eq!(f.count, 0);
    }
}
