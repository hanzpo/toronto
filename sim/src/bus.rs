//! Buses as agents of the road traffic sim (world.rs): a bus is a `Car` with a
//! `BusAgent` attached. It drives the road graph like any car (lanes, IDM
//! car-following, signals, junction reservations, lane changes), but at every
//! junction it picks the outgoing link that follows its GTFS pattern shape, it
//! moves to the curb lane before its stops, stops there and dwells (at least a
//! minimum time, never leaving before the timetable), and reports its progress
//! along the pattern. After its last stop it is out of service and drives off
//! like ordinary traffic until it leaves the sim radius.
//!
//! Because it only ever occupies road lanes in their direction of travel, a bus
//! can never be off the carriageway or run against a one-way.

/// A pattern shape (world E/N) with its stops.
pub struct BusPattern {
    pub pts: Vec<[f64; 2]>,
    /// cumulative horizontal distance per vertex
    pub cum: Vec<f32>,
    /// consist-centre distance of each stop (as the timetable uses it)
    pub stop_d: Vec<f32>,
    /// 1 = virtual (bbox edge) point
    pub stop_flag: Vec<u8>,
}

impl BusPattern {
    pub fn new(xy: &[f64], stop_d: &[f32], stop_flag: &[u8]) -> BusPattern {
        let pts: Vec<[f64; 2]> = xy.chunks_exact(2).map(|c| [c[0], c[1]]).collect();
        let mut cum = Vec::with_capacity(pts.len());
        let mut acc = 0.0f64;
        for i in 0..pts.len() {
            if i > 0 {
                acc += (pts[i][0] - pts[i - 1][0]).hypot(pts[i][1] - pts[i - 1][1]);
            }
            cum.push(acc as f32);
        }
        BusPattern { pts, cum, stop_d: stop_d.to_vec(), stop_flag: stop_flag.to_vec() }
    }

    pub fn length(&self) -> f32 {
        self.cum.last().copied().unwrap_or(0.0)
    }

    /// point and unit tangent at distance `d`
    pub fn at(&self, d: f32) -> ([f64; 2], [f64; 2]) {
        let n = self.pts.len();
        if n < 2 {
            return (self.pts.first().copied().unwrap_or([0.0; 2]), [1.0, 0.0]);
        }
        let d = d.clamp(0.0, self.length());
        let i = self.cum.partition_point(|&c| c <= d).clamp(1, n - 1) - 1;
        let (a, b) = (self.pts[i], self.pts[i + 1]);
        let l = (self.cum[i + 1] - self.cum[i]).max(1e-6);
        let t = ((d - self.cum[i]) / l) as f64;
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let h = dx.hypot(dy).max(1e-9);
        ([a[0] + dx * t, a[1] + dy * t], [dx / h, dy / h])
    }

    /// nearest point of the shape to (x, y) with distance in [lo, hi]: (distance along, offset)
    pub fn project(&self, x: f64, y: f64, lo: f32, hi: f32) -> (f32, f32) {
        let n = self.pts.len();
        let mut best = (lo, f32::INFINITY);
        if n < 2 {
            return best;
        }
        let i0 = self.cum.partition_point(|&c| c < lo).max(1) - 1;
        for i in i0..n - 1 {
            if self.cum[i] > hi {
                break;
            }
            let (a, b) = (self.pts[i], self.pts[i + 1]);
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            let l2 = dx * dx + dy * dy;
            let t = if l2 > 1e-9 { (((x - a[0]) * dx + (y - a[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
            let (px, py) = (a[0] + dx * t, a[1] + dy * t);
            let d = ((x - px).hypot(y - py)) as f32;
            let s = self.cum[i] + (self.cum[i + 1] - self.cum[i]) * t as f32;
            if d < best.1 && s >= lo - 1.0 && s <= hi + 1.0 {
                best = (s, d);
            }
        }
        best
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BusState {
    Run,
    Dwell,
    /// after the last stop / lost the pattern: drives off as ordinary traffic
    OutOfService,
    /// pulling out of a garage along `route` to the first stop of its trip
    Deadhead,
}

pub struct BusAgent {
    pub trip: u32,
    pub pat: u32,
    /// front bumper position along the pattern (m)
    pub sd: f32,
    pub stop: usize,
    /// arrival / departure times per stop (service-day s)
    pub arr: Vec<f64>,
    pub dep: Vec<f64>,
    pub state: BusState,
    pub until: f64,
    pub delay: f32,
    pub len: f32,
    pub car_id: u32,
    /// deadhead route (links) and position in it
    pub route: Vec<u32>,
    pub ri: usize,
}

/// minimum dwell at a stop (s)
pub const BUS_DWELL: f64 = 8.0;
/// floats per bus output record: [trip, front along pattern, speed, flags, delay, length, path offset, path points]
pub const BUS_STRIDE: usize = 8;
pub const BF_DWELL: u32 = 1;
pub const BF_DOORS: u32 = 2;
pub const BF_BRAKE: u32 = 4;
pub const BF_NIS: u32 = 8;

impl BusAgent {
    /// consist-front position where the bus stops for stop k (front door at the pole)
    pub fn stop_front(&self, p: &BusPattern, k: usize) -> f32 {
        p.stop_d[k] + self.len * 0.5
    }
}
