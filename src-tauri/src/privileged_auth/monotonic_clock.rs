//! SEC-001 Packet D — Monotonic Clock & Process Continuity (QPC).
//!
//! Provides raw QPC tick observation, process-local `bootSessionId` generation,
//! and NBI-003 overflow-safe QPC-to-millisecond conversion.
//!
//! Raw ticks are strictly process-local; cross-process QPC authority is forbidden.

use std::sync::OnceLock;
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

pub const BOOT_SESSION_ID_LEN: usize = 16;

static BOOT_SESSION_ID: OnceLock<[u8; BOOT_SESSION_ID_LEN]> = OnceLock::new();
static CACHED_FREQUENCY: OnceLock<u64> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonotonicClockError {
    QpcFailed,
    ZeroFrequency,
    NegativeDelta,
    Overflow,
}

impl std::fmt::Display for MonotonicClockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MonotonicClockError::QpcFailed => write!(f, "QueryPerformanceCounter/Frequency failed"),
            MonotonicClockError::ZeroFrequency => write!(f, "QPC frequency is zero or invalid"),
            MonotonicClockError::NegativeDelta => write!(f, "Monotonic tick delta is negative (end < start)"),
            MonotonicClockError::Overflow => write!(f, "QPC tick conversion arithmetic overflow"),
        }
    }
}

impl std::error::Error for MonotonicClockError {}

/// Returns the process-unique 16-byte boot session ID.
pub fn boot_session_id() -> [u8; BOOT_SESSION_ID_LEN] {
    *BOOT_SESSION_ID.get_or_init(|| {
        use rand::RngCore;
        let mut id = [0u8; BOOT_SESSION_ID_LEN];
        rand::rngs::OsRng.fill_bytes(&mut id);
        id
    })
}

/// Reads the raw QPC counter ticks.
pub fn read_qpc_ticks() -> Result<u64, MonotonicClockError> {
    let mut count = 0i64;
    unsafe {
        QueryPerformanceCounter(&mut count).map_err(|_| MonotonicClockError::QpcFailed)?;
    }
    if count < 0 {
        return Err(MonotonicClockError::QpcFailed);
    }
    Ok(count as u64)
}

/// Reads or retrieves the cached system QPC frequency (counts per second).
pub fn qpc_frequency() -> Result<u64, MonotonicClockError> {
    if let Some(&freq) = CACHED_FREQUENCY.get() {
        return Ok(freq);
    }
    let mut freq = 0i64;
    unsafe {
        QueryPerformanceFrequency(&mut freq).map_err(|_| MonotonicClockError::QpcFailed)?;
    }
    if freq <= 0 {
        return Err(MonotonicClockError::ZeroFrequency);
    }
    let u_freq = freq as u64;
    let _ = CACHED_FREQUENCY.set(u_freq);
    Ok(u_freq)
}

/// Converts a raw QPC tick difference into elapsed milliseconds using overflow-safe arithmetic (NBI-003).
///
/// Formula: `elapsed_ms = (delta_ticks * 1000) / frequency`
///
/// Implements:
/// - checked nonnegative subtraction
/// - frequency > 0 validation
/// - overflow-safe `u128` arithmetic
pub fn ticks_to_elapsed_ms(
    start_ticks: u64,
    end_ticks: u64,
    frequency: u64,
) -> Result<u64, MonotonicClockError> {
    let delta = end_ticks
        .checked_sub(start_ticks)
        .ok_or(MonotonicClockError::NegativeDelta)?;

    if frequency == 0 {
        return Err(MonotonicClockError::ZeroFrequency);
    }

    let delta_u128 = delta as u128;
    let freq_u128 = frequency as u128;

    // delta * 1000 can exceed u64::MAX for large delta, so u128 checked_mul is required:
    let product = delta_u128
        .checked_mul(1000)
        .ok_or(MonotonicClockError::Overflow)?;

    let ms_u128 = product / freq_u128;

    u64::try_from(ms_u128).map_err(|_| MonotonicClockError::Overflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boot_session_id_is_stable_and_non_zero() {
        let id1 = boot_session_id();
        let id2 = boot_session_id();
        assert_eq!(id1, id2);
        assert_ne!(id1, [0u8; 16]);
    }

    #[test]
    fn live_qpc_ticks_and_frequency_are_valid() {
        let freq = qpc_frequency().expect("frequency must be queryable");
        assert!(freq > 0);

        let t1 = read_qpc_ticks().expect("t1 queryable");
        std::thread::sleep(std::time::Duration::from_millis(10));
        let t2 = read_qpc_ticks().expect("t2 queryable");
        assert!(t2 >= t1);

        let elapsed = ticks_to_elapsed_ms(t1, t2, freq).expect("conversion valid");
        assert!(elapsed >= 5); // At least 5ms given 10ms sleep
    }

    #[test]
    fn nbi003_zero_delta() {
        let freq = 10_000_000u64; // 10 MHz standard
        let ms = ticks_to_elapsed_ms(100, 100, freq).unwrap();
        assert_eq!(ms, 0);
    }

    #[test]
    fn nbi003_ordinary_delta() {
        let freq = 10_000_000u64; // 10 MHz = 10,000 ticks per ms
        let start = 1_000_000u64;
        let end = start + 50_000u64; // 5 ms
        let ms = ticks_to_elapsed_ms(start, end, freq).unwrap();
        assert_eq!(ms, 5);
    }

    #[test]
    fn nbi003_rounding_down_behavior() {
        let freq = 10_000_000u64;
        let start = 0;
        let end = 19_999; // 1.9999 ms
        let ms = ticks_to_elapsed_ms(start, end, freq).unwrap();
        assert_eq!(ms, 1); // Truncates/floors toward zero
    }

    #[test]
    fn nbi003_negative_delta_fails_closed() {
        let freq = 10_000_000u64;
        let err = ticks_to_elapsed_ms(200, 100, freq).unwrap_err();
        assert_eq!(err, MonotonicClockError::NegativeDelta);
    }

    #[test]
    fn nbi003_zero_frequency_fails_closed() {
        let err = ticks_to_elapsed_ms(100, 200, 0).unwrap_err();
        assert_eq!(err, MonotonicClockError::ZeroFrequency);
    }

    #[test]
    fn nbi003_large_delta_near_u64_max_overflow_safe() {
        let freq = 10_000_000u64;
        // delta_ticks * 1000 would overflow u64 if delta > u64::MAX / 1000 = ~1.84e16.
        // Let's test a delta of 10^17 ticks (which overflows u64 * 1000, but fits in u128):
        let start = 0u64;
        let delta = 100_000_000_000_000_000u64; // 10^17 ticks
        let ms = ticks_to_elapsed_ms(start, delta, freq).unwrap();
        // 10^17 * 1000 / 10^7 = 10^13 ms (~317 years)
        assert_eq!(ms, 10_000_000_000_000u64);
    }

    #[test]
    fn nbi003_extreme_u64_max_delta() {
        let freq = 10_000_000u64;
        let start = 0u64;
        let end = u64::MAX;
        // u64::MAX * 1000 = 1.84e22, which fits in u128 (u128::MAX is ~3.4e38).
        // (u64::MAX * 1000) / 10^7 = 1.8446744e15 ms.
        let ms = ticks_to_elapsed_ms(start, end, freq).unwrap();
        assert_eq!(ms, (u64::MAX as u128 * 1000 / freq as u128) as u64);
    }
}
