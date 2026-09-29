//! Time-of-day demand model: the statistical tier shared by agent spawning
//! (local) and the region-wide congestion estimate.

/// Relative car demand per hour of a weekday (1.0 = peak hour). AM peak 7–9,
/// PM peak 16–18:30.
pub const WEEKDAY: [f32; 25] = [
    0.14, 0.09, 0.07, 0.06, 0.08, 0.22, 0.52, 0.88, 1.00, 0.86, 0.64, 0.62, 0.66, 0.66, 0.68, 0.80,
    0.95, 1.00, 0.97, 0.72, 0.54, 0.44, 0.34, 0.22, 0.14,
];
/// Weekend: no commuter peaks, broad midday plateau.
pub const WEEKEND: [f32; 25] = [
    0.22, 0.16, 0.11, 0.08, 0.06, 0.08, 0.14, 0.24, 0.38, 0.54, 0.68, 0.78, 0.84, 0.86, 0.86, 0.84,
    0.80, 0.74, 0.66, 0.56, 0.46, 0.40, 0.32, 0.26, 0.22,
];
/// Pedestrian activity (weekday): lunch + evening peaks.
pub const PED_WEEKDAY: [f32; 25] = [
    0.10, 0.06, 0.04, 0.03, 0.03, 0.06, 0.18, 0.55, 0.85, 0.70, 0.62, 0.75, 1.00, 0.92, 0.70, 0.72,
    0.85, 0.95, 0.85, 0.70, 0.55, 0.42, 0.30, 0.18, 0.10,
];
pub const PED_WEEKEND: [f32; 25] = [
    0.16, 0.10, 0.07, 0.04, 0.03, 0.04, 0.08, 0.16, 0.30, 0.48, 0.66, 0.82, 0.95, 1.00, 1.00, 0.96,
    0.90, 0.82, 0.74, 0.64, 0.52, 0.42, 0.32, 0.24, 0.16,
];

/// Peak densities (veh / km / lane) per road class at profile = 1.
pub const PEAK_DENSITY: [f32; 7] = [26.0, 20.0, 18.0, 14.0, 9.0, 2.6, 1.0];
/// Sidewalk pedestrians per km (per side) at profile = 1, by road class.
pub const PED_DENSITY: [f32; 7] = [0.0, 0.0, 26.0, 20.0, 12.0, 4.0, 1.5];

pub const FLAG_ONEWAY: u8 = 1;
pub const FLAG_BRIDGE: u8 = 2;
pub const FLAG_TUNNEL: u8 = 4;
pub const FLAG_LINK: u8 = 8;
pub const FLAG_ROUNDABOUT: u8 = 16;

#[inline]
fn interp(tab: &[f32; 25], sec_of_day: f64) -> f32 {
    let h = (sec_of_day.rem_euclid(86400.0) / 3600.0) as f32;
    let i = (h.floor() as usize).min(23);
    let t = h - i as f32;
    tab[i] + (tab[i + 1] - tab[i]) * t
}

#[inline]
pub fn is_weekend(weekday: u32) -> bool {
    weekday == 0 || weekday == 6
}

/// Relative car demand at a sim time (0..1).
pub fn profile(sec_of_day: f64, weekday: u32) -> f32 {
    interp(if is_weekend(weekday) { &WEEKEND } else { &WEEKDAY }, sec_of_day)
}

pub fn ped_profile(sec_of_day: f64, weekday: u32) -> f32 {
    interp(if is_weekend(weekday) { &PED_WEEKEND } else { &PED_WEEKDAY }, sec_of_day)
}

/// 0 off-peak … 1 at the height of a weekday rush hour.
pub fn peakness(sec_of_day: f64, weekday: u32) -> f32 {
    ((profile(sec_of_day, weekday) - 0.72) / 0.28).clamp(0.0, 1.0)
}

/// +1 in the AM peak (inbound heavy), -1 in the PM peak (outbound heavy).
pub fn tidal(sec_of_day: f64, weekday: u32) -> f32 {
    if is_weekend(weekday) {
        return 0.0;
    }
    let h = (sec_of_day.rem_euclid(86400.0) / 3600.0) as f32;
    let am = (1.0 - ((h - 8.0) / 1.6).abs()).max(0.0);
    let pm = (1.0 - ((h - 17.2) / 1.8).abs()).max(0.0);
    am - pm
}

/// Car density (veh/km/lane) wanted on a road at this time.
/// `bottleneck` is the extra peak load factor of known congested corridors
/// (0 = none, ~1 = DVP / Gardiner / 401).
pub fn car_density(class: u8, flags: u8, bottleneck: f32, sec_of_day: f64, weekday: u32) -> f32 {
    let c = (class as usize).min(6);
    let mut d = PEAK_DENSITY[c] * profile(sec_of_day, weekday);
    if flags & FLAG_LINK != 0 {
        d *= 0.55;
    }
    d * (1.0 + bottleneck * 1.3 * peakness(sec_of_day, weekday))
}

/// Urban-core multiplier for local car density (City Hall = origin).
pub fn core_factor(x: f64, y: f64) -> f32 {
    let d = x.hypot(y) as f32;
    1.0 + 0.7 * (-d / 3000.0).exp()
}

/// Base volume/capacity ratio at profile = 1 per class.
const BASE_VC: [f32; 7] = [0.82, 0.78, 0.74, 0.62, 0.5, 0.3, 0.2];

/// Region-wide congestion estimate: travel-speed / free-flow-speed for a road
/// segment (BPR curve on a time-of-day volume/capacity ratio).
/// `inbound` is the cosine between the segment direction and the direction to
/// downtown (tidal flow), `noise` in [0, 1) a per-segment constant.
pub fn speed_ratio(class: u8, flags: u8, bottleneck: f32, inbound: f32, noise: f32, sec_of_day: f64, weekday: u32) -> f32 {
    let c = (class as usize).min(6);
    let p = profile(sec_of_day, weekday);
    let tide = 1.0 + 0.22 * inbound * tidal(sec_of_day, weekday);
    let mut vc = BASE_VC[c] * p * tide * (0.85 + 0.3 * noise);
    if flags & FLAG_LINK != 0 {
        vc *= 0.9;
    }
    vc *= 1.0 + bottleneck * 0.45 * peakness(sec_of_day, weekday);
    // arterials: signals cap the ratio even when empty
    let signal_cap = if c >= 2 { 0.82 } else { 1.0 };
    (signal_cap / (1.0 + 0.9 * vc.powi(5))).clamp(0.05, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn peaks() {
        let wd = 2;
        assert!(profile(8.0 * 3600.0, wd) > 0.95);
        assert!(profile(3.0 * 3600.0, wd) < 0.1);
        assert!(profile(17.0 * 3600.0, wd) > 0.95);
        assert!(profile(8.0 * 3600.0, 0) < 0.5);
        assert!(peakness(8.0 * 3600.0, wd) > 0.9 && peakness(13.0 * 3600.0, wd) == 0.0);
        assert!(tidal(8.0 * 3600.0, wd) > 0.9 && tidal(17.2 * 3600.0, wd) < -0.9);
    }
    #[test]
    fn congestion_ratio() {
        let dvp_peak = speed_ratio(0, 0, 1.0, 1.0, 0.5, 8.0 * 3600.0, 2);
        let dvp_night = speed_ratio(0, 0, 1.0, 1.0, 0.5, 3.0 * 3600.0, 2);
        let plain_peak = speed_ratio(0, 0, 0.0, 0.0, 0.5, 8.0 * 3600.0, 2);
        assert!(dvp_night > 0.95, "{dvp_night}");
        assert!(dvp_peak < 0.5, "{dvp_peak}");
        assert!(plain_peak > dvp_peak);
        assert!(car_density(0, 0, 1.0, 8.0 * 3600.0, 2) > car_density(5, 0, 0.0, 8.0 * 3600.0, 2) * 5.0);
    }
}
