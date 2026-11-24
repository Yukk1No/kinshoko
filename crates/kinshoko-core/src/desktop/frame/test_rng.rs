//! 性质测试用的确定性伪随机数（xorshift64*），不为测试引入依赖。

pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed.max(1))
    }

    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    /// `[low, high)` 里的整数。
    pub fn range(&mut self, low: i64, high: i64) -> i64 {
        low + (self.next() % (high - low) as u64) as i64
    }

    /// `[low, high)` 里的小数。
    pub fn float(&mut self, low: f64, high: f64) -> f64 {
        low + (self.next() >> 11) as f64 / (1u64 << 53) as f64 * (high - low)
    }
}
