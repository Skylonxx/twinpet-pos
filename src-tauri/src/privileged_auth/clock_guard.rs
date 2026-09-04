//! SEC-001 Packet C-B — Native Clock Guard and Rollback Detection.
//!
//! Enforces tamper-evident monotonic observation of native system time,
//! cross-midnight UTC+7 day boundaries, and DPAPI-envelope integrity.
//!
//! Conforms strictly to Gemini Ruling R1 (native time only, rollback fail-closed)
//! and R5 (PRESENT_INVALID = FAIL_CLOSED).

use std::fs;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

use super::dpapi_envelope;

pub const CLOCK_GUARD_FILENAME: &str = "twinpet-clock-guard.dpapi";
pub const THAILAND_UTC_OFFSET_MS: i64 = 7 * 60 * 60 * 1000; // 25_200_000 ms
pub const MS_PER_DAY: i64 = 24 * 60 * 60 * 1000; // 86_400_000 ms

use std::sync::Mutex;

static CLOCK_GUARD_MUTEX: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClockGuardState {
    pub last_observed_system_time_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClockGuardError {
    PresentMalformed(String),
    ClockRollbackDetected {
        now_ms: u64,
        last_observed_ms: u64,
    },
    IoError(String),
}

impl std::fmt::Display for ClockGuardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClockGuardError::PresentMalformed(msg) => write!(f, "Clock guard state present but invalid: {msg}"),
            ClockGuardError::ClockRollbackDetected { now_ms, last_observed_ms } => {
                write!(f, "Clock rollback detected: current time {now_ms} < last observed {last_observed_ms}")
            }
            ClockGuardError::IoError(msg) => write!(f, "Clock guard IO error: {msg}"),
        }
    }
}

pub fn clock_guard_path(root: &Path) -> PathBuf {
    root.join(CLOCK_GUARD_FILENAME)
}

/// Read the clock guard state.
/// - If file does not exist -> Ok(None) (absent)
/// - If file exists but cannot be decrypted by DPAPI, JSON is invalid, or invariant fails -> Err(ClockGuardError::PresentMalformed)
pub fn read_clock_guard_state(root: &Path) -> Result<Option<ClockGuardState>, ClockGuardError> {
    let path = clock_guard_path(root);
    let ciphertext = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(ClockGuardError::IoError(e.to_string())),
    };

    if ciphertext.is_empty() {
        return Err(ClockGuardError::PresentMalformed("file is empty".to_string()));
    }

    let plaintext = dpapi_envelope::dpapi_unprotect(&ciphertext)
        .map_err(|e| ClockGuardError::PresentMalformed(format!("DPAPI unprotect failed: {e:?}")))?;

    let state: ClockGuardState = serde_json::from_slice(&plaintext)
        .map_err(|e| ClockGuardError::PresentMalformed(format!("JSON parse failed: {e}")))?;

    if state.last_observed_system_time_ms == 0 {
        return Err(ClockGuardError::PresentMalformed("last_observed_system_time_ms must be positive".to_string()));
    }

    Ok(Some(state))
}

pub fn write_clock_guard_state(root: &Path, state: &ClockGuardState) -> Result<(), ClockGuardError> {
    if state.last_observed_system_time_ms == 0 {
        return Err(ClockGuardError::PresentMalformed("last_observed_system_time_ms must be positive".to_string()));
    }
    let path = clock_guard_path(root);
    let plaintext = serde_json::to_vec(state)
        .map_err(|e| ClockGuardError::PresentMalformed(format!("JSON serialize failed: {e}")))?;

    let ciphertext = dpapi_envelope::dpapi_protect(&plaintext)
        .map_err(|e| ClockGuardError::IoError(format!("DPAPI protect failed: {e:?}")))?;

    write_atomic(&path, &ciphertext).map_err(ClockGuardError::IoError)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("path has no parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Asserts native system time is sane (non-rollback) and advances clock guard.
/// Serialized by CLOCK_GUARD_MUTEX across the entire read-check-update lifecycle.
/// - If absent: initializes with `last_observed_system_time_ms = now_ms`.
/// - If present: checks `now_ms >= state.last_observed_system_time_ms`. Fails closed if rollback.
///   Advances state to `now_ms`.
pub fn assert_valid_and_advance_clock(root: &Path, now_ms: u64) -> Result<(), ClockGuardError> {
    let _guard = CLOCK_GUARD_MUTEX
        .lock()
        .map_err(|_| ClockGuardError::PresentMalformed("clock guard mutex poisoned".to_string()))?;

    if now_ms == 0 {
        return Err(ClockGuardError::PresentMalformed("now_ms must be positive".to_string()));
    }

    let existing = read_clock_guard_state(root)?;
    match existing {
        None => {
            let initial = ClockGuardState {
                last_observed_system_time_ms: now_ms,
            };
            write_clock_guard_state(root, &initial)?;
            Ok(())
        }
        Some(state) => {
            if now_ms < state.last_observed_system_time_ms {
                return Err(ClockGuardError::ClockRollbackDetected {
                    now_ms,
                    last_observed_ms: state.last_observed_system_time_ms,
                });
            }
            let updated = ClockGuardState {
                last_observed_system_time_ms: now_ms,
            };
            write_clock_guard_state(root, &updated)?;
            Ok(())
        }
    }
}

/// Checks whether `now_ms` has crossed a midnight boundary relative to `issued_at_server_ms`
/// under fixed UTC+7 Thailand calendar day.
pub fn is_cross_midnight_utc7(issued_at_server_ms: u64, now_ms: u64) -> bool {
    let issued_day = (issued_at_server_ms as i64 + THAILAND_UTC_OFFSET_MS) / MS_PER_DAY;
    let now_day = (now_ms as i64 + THAILAND_UTC_OFFSET_MS) / MS_PER_DAY;
    issued_day != now_day
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let n: u64 = rand::random();
        let path = std::env::temp_dir().join(format!("twinpet-clock-guard-test-{n}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn clock_guard_initializes_absent_state() {
        let root = temp_root();
        assert_eq!(read_clock_guard_state(&root), Ok(None));
        assert!(assert_valid_and_advance_clock(&root, 1_000_000).is_ok());

        let state = read_clock_guard_state(&root).unwrap().unwrap();
        assert_eq!(state.last_observed_system_time_ms, 1_000_000);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn clock_guard_advances_monotonically() {
        let root = temp_root();
        assert!(assert_valid_and_advance_clock(&root, 1_000_000).is_ok());
        assert!(assert_valid_and_advance_clock(&root, 1_005_000).is_ok());

        let state = read_clock_guard_state(&root).unwrap().unwrap();
        assert_eq!(state.last_observed_system_time_ms, 1_005_000);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn clock_guard_detects_rollback_and_fails_closed() {
        let root = temp_root();
        assert!(assert_valid_and_advance_clock(&root, 1_000_000).is_ok());

        // Rollback attempt
        let res = assert_valid_and_advance_clock(&root, 999_999);
        assert_eq!(
            res,
            Err(ClockGuardError::ClockRollbackDetected {
                now_ms: 999_999,
                last_observed_ms: 1_000_000,
            })
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn clock_guard_fails_closed_on_present_malformed() {
        let root = temp_root();
        let path = clock_guard_path(&root);
        fs::write(&path, b"garbage-corrupted-bytes").unwrap();

        let res = read_clock_guard_state(&root);
        assert!(matches!(res, Err(ClockGuardError::PresentMalformed(_))));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cross_midnight_utc7_behavior() {
        // Thailand is UTC+7.
        // 2026-09-03 23:59:00 UTC+7 is 2026-09-03 16:59:00 UTC.
        // Let timestamp T be 16:59:00 UTC on 2026-09-03.
        // 1783097940000 ms = Thu Sep 03 2026 16:59:00 GMT
        // 2 minutes later: 1783098060000 ms = Thu Sep 03 2026 17:01:00 GMT = Fri Sep 04 2026 00:01:00 UTC+7.
        let before_midnight_utc7 = 1_783_097_940_000u64;
        let same_day_later_utc7 = before_midnight_utc7 + 30_000; // +30s
        let after_midnight_utc7 = before_midnight_utc7 + 120_000; // +2m

        assert!(!is_cross_midnight_utc7(before_midnight_utc7, same_day_later_utc7));
        assert!(is_cross_midnight_utc7(before_midnight_utc7, after_midnight_utc7));
    }

    #[test]
    fn clock_guard_fails_on_zero_timestamp() {
        let root = temp_root();
        let res = assert_valid_and_advance_clock(&root, 0);
        assert!(matches!(res, Err(ClockGuardError::PresentMalformed(_))));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn clock_guard_high_water_concurrency() {
        let root = temp_root();
        let root_arc = std::sync::Arc::new(root);
        let mut handles = Vec::new();

        // 10 threads advancing monotonically
        for i in 1..=10 {
            let r = std::sync::Arc::clone(&root_arc);
            handles.push(std::thread::spawn(move || {
                let ts = 1_000_000 + i * 1_000;
                let _ = assert_valid_and_advance_clock(&r, ts);
            }));
        }

        for h in handles {
            h.join().unwrap();
        }

        let final_state = read_clock_guard_state(&root_arc).unwrap().unwrap();
        assert_eq!(final_state.last_observed_system_time_ms, 1_010_000);

        // A subsequent call with older timestamp MUST be rejected as rollback
        let rollback_res = assert_valid_and_advance_clock(&root_arc, 1_009_999);
        assert!(matches!(rollback_res, Err(ClockGuardError::ClockRollbackDetected { .. })));

        let _ = fs::remove_dir_all(&*root_arc);
    }
}
