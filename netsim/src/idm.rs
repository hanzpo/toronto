//! Intelligent Driver Model + per-vehicle-type parameters.

#[derive(Clone, Copy, Debug)]
pub struct IdmParams {
    /// max acceleration m/s²
    pub a: f32,
    /// comfortable deceleration m/s²
    pub b: f32,
    /// desired time headway s
    pub t: f32,
    /// jam distance m
    pub s0: f32,
}

/// Vehicle kinds (index = render variant).
pub const SEDAN: u8 = 0;
pub const HATCH: u8 = 1;
pub const SUV: u8 = 2;
pub const PICKUP: u8 = 3;
pub const VAN: u8 = 4;
pub const TRUCK: u8 = 5;
pub const KINDS: usize = 6;

/// body length (m) per kind — matches the render models
pub const LENGTH: [f32; KINDS] = [4.7, 4.1, 4.9, 5.6, 5.3, 8.6];

pub fn params(kind: u8) -> IdmParams {
    match kind {
        SEDAN => IdmParams { a: 1.7, b: 2.2, t: 1.25, s0: 2.0 },
        HATCH => IdmParams { a: 1.6, b: 2.2, t: 1.3, s0: 2.0 },
        SUV => IdmParams { a: 1.5, b: 2.0, t: 1.35, s0: 2.2 },
        PICKUP => IdmParams { a: 1.4, b: 2.0, t: 1.4, s0: 2.3 },
        VAN => IdmParams { a: 1.2, b: 1.8, t: 1.5, s0: 2.5 },
        _ => IdmParams { a: 0.9, b: 1.6, t: 1.8, s0: 3.0 },
    }
}

/// IDM acceleration. `gap` = bumper-to-bumper distance to the leader (m),
/// `dv` = v - v_leader. Pass `f32::INFINITY` as gap for a free road.
#[inline]
pub fn accel(p: &IdmParams, v: f32, v0: f32, gap: f32, dv: f32) -> f32 {
    let v0 = v0.max(0.5);
    let r = v / v0;
    let free = 1.0 - r * r * r * r;
    if !gap.is_finite() {
        return (p.a * free).max(-9.0);
    }
    let s_star = p.s0 + (v * p.t + v * dv / (2.0 * (p.a * p.b).sqrt())).max(0.0);
    let g = gap.max(0.1);
    let q = s_star / g;
    (p.a * (free - q * q)).clamp(-9.0, p.a)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn free_road_accelerates_to_v0() {
        let p = params(SEDAN);
        let mut v = 0.0f32;
        for _ in 0..600 {
            v += accel(&p, v, 15.0, f32::INFINITY, 0.0) * 0.1;
        }
        assert!((v - 15.0).abs() < 0.8, "{v}");
    }
    #[test]
    fn stops_behind_obstacle() {
        let p = params(SEDAN);
        let (mut s, mut v) = (0.0f32, 14.0f32);
        let wall = 120.0;
        for _ in 0..2000 {
            let a = accel(&p, v, 14.0, wall - s, v);
            let nv = (v + a * 0.1).max(0.0);
            s += (v + nv) * 0.05;
            v = nv;
        }
        assert!(s < wall && s > wall - p.s0 - 1.5, "{s}");
        assert!(v < 0.05);
    }
    #[test]
    fn follower_keeps_headway() {
        let p = params(SEDAN);
        // equilibrium: leader at 10 m/s
        let a = accel(&p, 10.0, 15.0, p.s0 + 10.0 * p.t, 0.0);
        assert!(a < 0.0 && a > -2.0, "{a}");
    }
}
