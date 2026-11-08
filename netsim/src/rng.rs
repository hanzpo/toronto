//! Small, fast deterministic RNG (SplitMix64) and hashing helpers.

#[derive(Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed ^ 0x9E37_79B9_7F4A_7C15)
    }
    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        mix(self.0)
    }
    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        (self.next_u64() >> 32) as u32
    }
    /// uniform in [0, 1)
    #[inline]
    pub fn f32(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 * (1.0 / 16_777_216.0)
    }
    #[inline]
    pub fn range(&mut self, a: f32, b: f32) -> f32 {
        a + (b - a) * self.f32()
    }
    #[inline]
    pub fn below(&mut self, n: u32) -> u32 {
        if n == 0 {
            0
        } else {
            ((self.next_u32() as u64 * n as u64) >> 32) as u32
        }
    }
    /// approx. standard normal (Irwin-Hall, 4 terms)
    pub fn normal(&mut self) -> f32 {
        (self.f32() + self.f32() + self.f32() + self.f32() - 2.0) * 1.732
    }
    /// pick an index from cumulative-free weights
    pub fn pick(&mut self, w: &[f32]) -> Option<usize> {
        let tot: f32 = w.iter().sum();
        if !(tot > 0.0) {
            return None;
        }
        let mut r = self.f32() * tot;
        for (i, &x) in w.iter().enumerate() {
            if r < x {
                return Some(i);
            }
            r -= x;
        }
        w.iter().rposition(|&x| x > 0.0)
    }
}

#[inline]
pub fn mix(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// hash → [0, 1)
#[inline]
pub fn hash01(x: u64) -> f32 {
    (mix(x) >> 40) as f32 * (1.0 / 16_777_216.0)
}
