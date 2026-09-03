//! SEC-001 Packet C-A — D15 `ARGON2_UNDERPOWERED_TERMINAL = HARD_FAIL`
//! benchmark. A terminal that cannot meet the frozen Argon2id benchmark
//! (>=250ms target, hard ceiling 1000ms at the frozen params) fails
//! provisioning closed with `native_secret_unavailable`. No automatic
//! parameter downgrade, no tiered security profile — this module only
//! measures and classifies; it never adjusts the KDF params.

use super::argon2_kdf::{derive_verifier, ARGON2_SALT_LEN};
use std::time::{Duration, Instant};

pub const ARGON2_BENCHMARK_TARGET_MS: u64 = 250;
pub const ARGON2_BENCHMARK_HARD_CEILING_MS: u64 = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Argon2BenchmarkVerdict {
    /// Runtime met or exceeded the 250ms target — comfortably provisionable.
    Pass,
    /// Runtime is between the target and the hard ceiling — provisioning may
    /// proceed, but the terminal is running close to underpowered.
    PassWithNote,
    /// Runtime exceeded the 1000ms hard ceiling — D15 HARD_FAIL. Provisioning
    /// must be refused (`native_secret_unavailable`); no downgrade.
    HardFail,
}

#[derive(Debug, Clone, Copy)]
pub struct Argon2BenchmarkResult {
    pub elapsed_ms: u64,
    pub verdict: Argon2BenchmarkVerdict,
}

pub fn classify_elapsed_ms(elapsed_ms: u64) -> Argon2BenchmarkVerdict {
    if elapsed_ms >= ARGON2_BENCHMARK_TARGET_MS && elapsed_ms <= ARGON2_BENCHMARK_HARD_CEILING_MS {
        Argon2BenchmarkVerdict::PassWithNote
    } else if elapsed_ms < ARGON2_BENCHMARK_TARGET_MS {
        Argon2BenchmarkVerdict::Pass
    } else {
        Argon2BenchmarkVerdict::HardFail
    }
}

/// Runs one real Argon2id hash at the frozen params on throwaway input and
/// classifies the elapsed wall-clock time. Never caches/skips — provisioning
/// re-benchmarks the actual terminal every time, since hardware/thermal/load
/// conditions can change between runs.
pub fn run_argon2_benchmark() -> Result<Argon2BenchmarkResult, super::argon2_kdf::Argon2KdfError> {
    let salt = [0x5Au8; ARGON2_SALT_LEN];
    let pepper = [0xA5u8; 32];
    let started = Instant::now();
    derive_verifier(b"000000", &salt, &pepper)?;
    let elapsed: Duration = started.elapsed();
    let elapsed_ms = elapsed.as_millis() as u64;
    Ok(Argon2BenchmarkResult { elapsed_ms, verdict: classify_elapsed_ms(elapsed_ms) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_below_target_as_pass() {
        assert_eq!(classify_elapsed_ms(0), Argon2BenchmarkVerdict::Pass);
        assert_eq!(classify_elapsed_ms(ARGON2_BENCHMARK_TARGET_MS - 1), Argon2BenchmarkVerdict::Pass);
    }

    #[test]
    fn classifies_between_target_and_ceiling_as_pass_with_note() {
        assert_eq!(classify_elapsed_ms(ARGON2_BENCHMARK_TARGET_MS), Argon2BenchmarkVerdict::PassWithNote);
        assert_eq!(classify_elapsed_ms(ARGON2_BENCHMARK_HARD_CEILING_MS), Argon2BenchmarkVerdict::PassWithNote);
        assert_eq!(classify_elapsed_ms(500), Argon2BenchmarkVerdict::PassWithNote);
    }

    #[test]
    fn classifies_above_hard_ceiling_as_hard_fail() {
        assert_eq!(classify_elapsed_ms(ARGON2_BENCHMARK_HARD_CEILING_MS + 1), Argon2BenchmarkVerdict::HardFail);
        assert_eq!(classify_elapsed_ms(5000), Argon2BenchmarkVerdict::HardFail);
    }

    #[test]
    fn runs_a_real_benchmark_and_returns_a_classified_result() {
        let result = run_argon2_benchmark().unwrap();
        // This dev machine is expected to be comfortably fast; the important
        // structural guarantee is that elapsed_ms and verdict are consistent.
        assert_eq!(classify_elapsed_ms(result.elapsed_ms), result.verdict);
    }
}
