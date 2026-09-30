//! Camera view test shared by the sims: agents never appear / disappear in plain view.

/// camera position + unit horizontal forward (world E/N)
pub type Camera = Option<(f64, f64, f64, f64)>;

/// (x, y) within `max_d` of the camera and inside a ~130 deg horizontal cone (or very close)
#[inline]
pub fn in_view(cam: Camera, x: f64, y: f64, max_d: f64) -> bool {
    let Some((cx, cy, fx, fy)) = cam else { return false };
    let (dx, dy) = (x - cx, y - cy);
    let d = dx.hypot(dy);
    if d > max_d {
        return false;
    }
    d < 60.0 || (dx * fx + dy * fy) / d > 0.42
}
