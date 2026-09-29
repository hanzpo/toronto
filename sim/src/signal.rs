//! Fixed-time two-phase traffic signal plans.
//!
//! Phase A serves approaches whose axis is within 45° of `axis` (usually the
//! major road), phase B the cross street. Cycle: A green → amber → all red →
//! B green → amber → all red.

pub const AMBER: f32 = 4.0;
pub const ALL_RED: f32 = 2.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Light {
    Green,
    Amber,
    Red,
}

#[derive(Clone, Copy, Debug)]
pub struct SignalPlan {
    /// seconds added to time of day before taking the cycle phase
    pub offset: f32,
    /// axis of phase A (radians, direction mod π)
    pub axis: f32,
    pub green_a: f32,
    pub green_b: f32,
}

impl Default for SignalPlan {
    fn default() -> Self {
        SignalPlan { offset: 0.0, axis: 0.0, green_a: 35.0, green_b: 25.0 }
    }
}

/// difference between two axes (undirected), in [0, π/2]
#[inline]
pub fn axis_diff(a: f32, b: f32) -> f32 {
    let d = (a - b).rem_euclid(std::f32::consts::PI);
    d.min(std::f32::consts::PI - d)
}

impl SignalPlan {
    pub fn cycle(&self) -> f32 {
        self.green_a + self.green_b + 2.0 * (AMBER + ALL_RED)
    }
    /// 0 = phase A, 1 = phase B for an approach travelling along `bearing`
    pub fn phase_of(&self, bearing: f32) -> u8 {
        if axis_diff(bearing, self.axis) <= std::f32::consts::FRAC_PI_4 {
            0
        } else {
            1
        }
    }
    /// light for a phase at time-of-day `t` (s)
    pub fn light(&self, t: f64, phase: u8) -> Light {
        let c = self.cycle() as f64;
        let u = ((t + self.offset as f64).rem_euclid(c)) as f32;
        let a_end = self.green_a;
        let (start, green) = if phase == 0 { (0.0, self.green_a) } else { (a_end + AMBER + ALL_RED, self.green_b) };
        let x = u - start;
        if x >= 0.0 && x < green {
            Light::Green
        } else if x >= green && x < green + AMBER {
            Light::Amber
        } else {
            Light::Red
        }
    }
    pub fn light_for(&self, t: f64, bearing: f32) -> Light {
        self.light(t, self.phase_of(bearing))
    }
    /// seconds of green remaining for a phase (0 if not green)
    pub fn green_left(&self, t: f64, phase: u8) -> f32 {
        let c = self.cycle() as f64;
        let u = ((t + self.offset as f64).rem_euclid(c)) as f32;
        let (start, green) = if phase == 0 { (0.0, self.green_a) } else { (self.green_a + AMBER + ALL_RED, self.green_b) };
        let x = u - start;
        if x >= 0.0 && x < green {
            green - x
        } else {
            0.0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn phases_never_both_green() {
        let p = SignalPlan { offset: 7.0, axis: 0.3, green_a: 30.0, green_b: 20.0 };
        let mut greens = [0, 0];
        for i in 0..(p.cycle() as i32 * 10) {
            let t = i as f64 * 0.1;
            let a = p.light(t, 0);
            let b = p.light(t, 1);
            assert!(!(a != Light::Red && b != Light::Red), "conflict at {t}");
            if a == Light::Green {
                greens[0] += 1;
            }
            if b == Light::Green {
                greens[1] += 1;
            }
        }
        assert!((greens[0] as f32 / 10.0 - 30.0).abs() < 0.2);
        assert!((greens[1] as f32 / 10.0 - 20.0).abs() < 0.2);
    }
    #[test]
    fn approach_axis() {
        let p = SignalPlan { axis: 0.0, ..Default::default() };
        assert_eq!(p.phase_of(std::f32::consts::PI), 0); // opposite direction, same axis
        assert_eq!(p.phase_of(1.5), 1);
        assert_eq!(p.phase_of(-0.5), 0);
    }
    #[test]
    fn amber_follows_green() {
        let p = SignalPlan { offset: 0.0, axis: 0.0, green_a: 30.0, green_b: 20.0 };
        assert_eq!(p.light(29.0, 0), Light::Green);
        assert_eq!(p.light(31.0, 0), Light::Amber);
        assert_eq!(p.light(35.0, 0), Light::Red);
        assert_eq!(p.light(37.0, 1), Light::Green);
        assert!(p.green_left(10.0, 0) > 19.0);
    }
}
