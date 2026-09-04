//! SEC-001 Packet C-B — Native Lockout State Machine and Persistence.
//!
//! Enforces:
//! - 5 consecutive failed attempts => locked out + mint 32-byte CSPRNG lockoutId
//! - 15-minute cooldown period
//! - Signed LCT1 token generation binding
//! - Reopening requires BOTH 15-minute cooldown elapsed AND valid current-generation LCT1
//! - DPAPI-protected store with tamper-evident fail-closed integrity (R5)
//! - Manager isolation (each manager has independent lockout state)

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use rand::RngCore;
use serde::{Deserialize, Serialize};

use super::dpapi_envelope;

static LOCKOUT_MUTEX: Mutex<()> = Mutex::new(());

pub const LOCKOUT_STATE_FILENAME: &str = "twinpet-lockout-state.dpapi";
pub const MAX_FAILED_ATTEMPTS: u32 = 5;
pub const LOCKOUT_COOLDOWN_MS: u64 = 15 * 60 * 1000; // 900_000 ms = 15 minutes

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagerLockoutState {
    pub consecutive_failed_attempts: u32,
    pub locked_out: bool,
    pub locked_at_ms: Option<u64>,
    pub current_lockout_id_hex: Option<String>, // 64-char lowercase hex
    pub clear_token_recorded: bool,
    pub last_attempt_ms: u64,
}

impl Default for ManagerLockoutState {
    fn default() -> Self {
        Self {
            consecutive_failed_attempts: 0,
            locked_out: false,
            locked_at_ms: None,
            current_lockout_id_hex: None,
            clear_token_recorded: false,
            last_attempt_ms: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LockoutStore {
    pub managers: HashMap<String, ManagerLockoutState>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LockoutError {
    PresentMalformed(String),
    LockoutIdMismatch,
    ManagerNotLockedOut,
    IoError(String),
}

impl std::fmt::Display for LockoutError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LockoutError::PresentMalformed(msg) => write!(f, "Lockout state present but invalid: {msg}"),
            LockoutError::LockoutIdMismatch => write!(f, "LCT1 lockoutId does not match current lockout generation"),
            LockoutError::ManagerNotLockedOut => write!(f, "Manager is not currently locked out"),
            LockoutError::IoError(msg) => write!(f, "Lockout IO error: {msg}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LockoutPrecheck {
    Unlocked {
        consecutive_failed_attempts: u32,
    },
    LockedOut {
        consecutive_failed_attempts: u32,
        current_lockout_id_hex: String,
        locked_at_ms: u64,
        cooldown_remaining_ms: u64,
        clear_token_recorded: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClearTokenRecordResult {
    pub reopens_now: bool,
    pub cooldown_remaining_ms: u64,
}

pub fn lockout_state_path(root: &Path) -> PathBuf {
    root.join("oac-store").join(LOCKOUT_STATE_FILENAME)
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn is_lowercase_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn is_canonical_identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Explicit invariant validator.
/// Fails closed (Err(PresentMalformed)) on ANY impossible state.
pub fn validate_manager_lockout_state(manager_staff_id: &str, state: &ManagerLockoutState) -> Result<(), LockoutError> {
    if !is_canonical_identifier(manager_staff_id) {
        return Err(LockoutError::PresentMalformed(format!(
            "invalid manager_staff_id grammar: '{manager_staff_id}'"
        )));
    }

    if state.last_attempt_ms == 0 {
        return Err(LockoutError::PresentMalformed(
            "persisted state invariant violated: last_attempt_ms must be positive".to_string(),
        ));
    }

    if !state.locked_out {
        if state.consecutive_failed_attempts >= MAX_FAILED_ATTEMPTS {
            return Err(LockoutError::PresentMalformed(format!(
                "unlocked state cannot have {} consecutive failed attempts (must be < {})",
                state.consecutive_failed_attempts, MAX_FAILED_ATTEMPTS
            )));
        }
        if state.locked_at_ms.is_some() {
            return Err(LockoutError::PresentMalformed(
                "unlocked state invariant violated: locked_at_ms must be None".to_string(),
            ));
        }
        if state.current_lockout_id_hex.is_some() {
            return Err(LockoutError::PresentMalformed(
                "unlocked state invariant violated: current_lockout_id_hex must be None".to_string(),
            ));
        }
        if state.clear_token_recorded {
            return Err(LockoutError::PresentMalformed(
                "unlocked state invariant violated: clear_token_recorded cannot be true without active lockout".to_string(),
            ));
        }
    } else {
        if state.consecutive_failed_attempts != MAX_FAILED_ATTEMPTS {
            return Err(LockoutError::PresentMalformed(format!(
                "locked state invariant violated: consecutive_failed_attempts must be exactly {}, got {}",
                MAX_FAILED_ATTEMPTS, state.consecutive_failed_attempts
            )));
        }
        match state.locked_at_ms {
            Some(ts) if ts > 0 => {}
            _ => {
                return Err(LockoutError::PresentMalformed(
                    "locked state invariant violated: locked_at_ms must be Some(positive integer)".to_string(),
                ));
            }
        }
        match &state.current_lockout_id_hex {
            Some(id) if is_lowercase_hex64(id) => {}
            _ => {
                return Err(LockoutError::PresentMalformed(
                    "locked state invariant violated: current_lockout_id_hex must be exactly 64 lowercase hex chars".to_string(),
                ));
            }
        }
    }

    Ok(())
}

pub fn validate_lockout_store(store: &LockoutStore) -> Result<(), LockoutError> {
    for (manager_id, state) in &store.managers {
        validate_manager_lockout_state(manager_id, state)?;
    }
    Ok(())
}

pub fn read_lockout_store(root: &Path) -> Result<LockoutStore, LockoutError> {
    let path = lockout_state_path(root);
    let ciphertext = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(LockoutStore::default()),
        Err(e) => return Err(LockoutError::IoError(e.to_string())),
    };

    if ciphertext.is_empty() {
        return Err(LockoutError::PresentMalformed("file is empty".to_string()));
    }

    let plaintext = dpapi_envelope::dpapi_unprotect(&ciphertext)
        .map_err(|e| LockoutError::PresentMalformed(format!("DPAPI unprotect failed: {e:?}")))?;

    let store: LockoutStore = serde_json::from_slice(&plaintext)
        .map_err(|e| LockoutError::PresentMalformed(format!("JSON parse failed: {e}")))?;

    validate_lockout_store(&store)?;

    Ok(store)
}

pub fn write_lockout_store(root: &Path, store: &LockoutStore) -> Result<(), LockoutError> {
    validate_lockout_store(store)?;

    let path = lockout_state_path(root);
    let plaintext = serde_json::to_vec(store)
        .map_err(|e| LockoutError::PresentMalformed(format!("JSON serialize failed: {e}")))?;

    let ciphertext = dpapi_envelope::dpapi_protect(&plaintext)
        .map_err(|e| LockoutError::IoError(format!("DPAPI protect failed: {e:?}")))?;

    write_atomic(&path, &ciphertext).map_err(LockoutError::IoError)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("path has no parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Checks lockout status for a manager before PIN verification.
/// Reopens if BOTH 15-minute cooldown elapsed AND clear token recorded.
pub fn check_manager_lockout(
    root: &Path,
    manager_staff_id: &str,
    now_ms: u64,
) -> Result<LockoutPrecheck, LockoutError> {
    let _guard = LOCKOUT_MUTEX
        .lock()
        .map_err(|_| LockoutError::PresentMalformed("lockout mutex poisoned".to_string()))?;

    if !is_canonical_identifier(manager_staff_id) {
        return Err(LockoutError::PresentMalformed(format!(
            "invalid manager_staff_id grammar: '{manager_staff_id}'"
        )));
    }

    let mut store = read_lockout_store(root)?;
    let entry = match store.managers.get_mut(manager_staff_id) {
        None => return Ok(LockoutPrecheck::Unlocked { consecutive_failed_attempts: 0 }),
        Some(e) => e,
    };

    if !entry.locked_out {
        return Ok(LockoutPrecheck::Unlocked {
            consecutive_failed_attempts: entry.consecutive_failed_attempts,
        });
    }

    let locked_at = entry.locked_at_ms.ok_or_else(|| {
        LockoutError::PresentMalformed("locked state missing locked_at_ms".to_string())
    })?;
    let elapsed = now_ms.saturating_sub(locked_at);
    let cooldown_remaining = LOCKOUT_COOLDOWN_MS.saturating_sub(elapsed);

    // Reopen condition: BOTH 15m elapsed AND clear token recorded
    if cooldown_remaining == 0 && entry.clear_token_recorded {
        // Reopen as fresh attempt cycle
        entry.consecutive_failed_attempts = 0;
        entry.locked_out = false;
        entry.locked_at_ms = None;
        entry.current_lockout_id_hex = None;
        entry.clear_token_recorded = false;
        entry.last_attempt_ms = now_ms;
        write_lockout_store(root, &store)?;
        return Ok(LockoutPrecheck::Unlocked { consecutive_failed_attempts: 0 });
    }

    let lockout_id = entry.current_lockout_id_hex.as_ref().ok_or_else(|| {
        LockoutError::PresentMalformed("locked state missing current_lockout_id_hex".to_string())
    })?.clone();

    Ok(LockoutPrecheck::LockedOut {
        consecutive_failed_attempts: entry.consecutive_failed_attempts,
        current_lockout_id_hex: lockout_id,
        locked_at_ms: locked_at,
        cooldown_remaining_ms: cooldown_remaining,
        clear_token_recorded: entry.clear_token_recorded,
    })
}

/// Records a failed PIN attempt.
/// Increments attempts. At 5: locks out and mints new 32-byte CSPRNG lockoutId.
pub fn record_failed_pin_attempt(
    root: &Path,
    manager_staff_id: &str,
    now_ms: u64,
) -> Result<ManagerLockoutState, LockoutError> {
    let _guard = LOCKOUT_MUTEX
        .lock()
        .map_err(|_| LockoutError::PresentMalformed("lockout mutex poisoned".to_string()))?;

    if !is_canonical_identifier(manager_staff_id) {
        return Err(LockoutError::PresentMalformed(format!(
            "invalid manager_staff_id grammar: '{manager_staff_id}'"
        )));
    }

    let mut store = read_lockout_store(root)?;
    let entry = store.managers.entry(manager_staff_id.to_string()).or_default();

    entry.last_attempt_ms = now_ms;

    if !entry.locked_out {
        entry.consecutive_failed_attempts += 1;
        if entry.consecutive_failed_attempts >= MAX_FAILED_ATTEMPTS {
            entry.consecutive_failed_attempts = MAX_FAILED_ATTEMPTS;
            entry.locked_out = true;
            entry.locked_at_ms = Some(now_ms);

            let mut raw = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut raw);
            entry.current_lockout_id_hex = Some(hex_encode(&raw));
            entry.clear_token_recorded = false;
        }
    }

    let result = entry.clone();
    write_lockout_store(root, &store)?;
    Ok(result)
}

/// Records a successful PIN verification, resetting the cycle.
pub fn record_successful_pin_attempt(
    root: &Path,
    manager_staff_id: &str,
    now_ms: u64,
) -> Result<(), LockoutError> {
    let _guard = LOCKOUT_MUTEX
        .lock()
        .map_err(|_| LockoutError::PresentMalformed("lockout mutex poisoned".to_string()))?;

    if !is_canonical_identifier(manager_staff_id) {
        return Err(LockoutError::PresentMalformed(format!(
            "invalid manager_staff_id grammar: '{manager_staff_id}'"
        )));
    }

    let mut store = read_lockout_store(root)?;
    let entry = store.managers.entry(manager_staff_id.to_string()).or_default();

    entry.consecutive_failed_attempts = 0;
    entry.locked_out = false;
    entry.locked_at_ms = None;
    entry.current_lockout_id_hex = None;
    entry.clear_token_recorded = false;
    entry.last_attempt_ms = now_ms;

    write_lockout_store(root, &store)
}

/// Records a verified LCT1 token.
/// Checks that manager is locked out and lockoutId matches the current generation.
pub fn record_lockout_clear_token(
    root: &Path,
    manager_staff_id: &str,
    lockout_id_raw: &[u8; 32],
    now_ms: u64,
) -> Result<ClearTokenRecordResult, LockoutError> {
    let _guard = LOCKOUT_MUTEX
        .lock()
        .map_err(|_| LockoutError::PresentMalformed("lockout mutex poisoned".to_string()))?;

    if !is_canonical_identifier(manager_staff_id) {
        return Err(LockoutError::PresentMalformed(format!(
            "invalid manager_staff_id grammar: '{manager_staff_id}'"
        )));
    }

    let mut store = read_lockout_store(root)?;
    let entry = match store.managers.get_mut(manager_staff_id) {
        None => return Err(LockoutError::ManagerNotLockedOut),
        Some(e) => e,
    };

    if !entry.locked_out {
        return Err(LockoutError::ManagerNotLockedOut);
    }

    let expected_hex = entry.current_lockout_id_hex.as_deref().ok_or_else(|| {
        LockoutError::PresentMalformed("locked state missing current_lockout_id_hex".to_string())
    })?;
    let presented_hex = hex_encode(lockout_id_raw);
    if expected_hex != presented_hex {
        return Err(LockoutError::LockoutIdMismatch);
    }

    entry.clear_token_recorded = true;

    let locked_at = entry.locked_at_ms.ok_or_else(|| {
        LockoutError::PresentMalformed("locked state missing locked_at_ms".to_string())
    })?;
    let elapsed = now_ms.saturating_sub(locked_at);
    let cooldown_remaining = LOCKOUT_COOLDOWN_MS.saturating_sub(elapsed);

    if cooldown_remaining == 0 {
        // Reopen immediately
        entry.consecutive_failed_attempts = 0;
        entry.locked_out = false;
        entry.locked_at_ms = None;
        entry.current_lockout_id_hex = None;
        entry.clear_token_recorded = false;
        entry.last_attempt_ms = now_ms;
        write_lockout_store(root, &store)?;
        Ok(ClearTokenRecordResult {
            reopens_now: true,
            cooldown_remaining_ms: 0,
        })
    } else {
        // Token recorded, but 15m minimum cooldown still running
        write_lockout_store(root, &store)?;
        Ok(ClearTokenRecordResult {
            reopens_now: false,
            cooldown_remaining_ms: cooldown_remaining,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let n: u64 = rand::random();
        let path = std::env::temp_dir().join(format!("twinpet-lockout-test-{n}"));
        fs::create_dir_all(path.join("oac-store")).unwrap();
        path
    }

    #[test]
    fn wrong_attempts_1_to_4_increment_and_remain_open() {
        let root = temp_root();
        let mgr = "mgr-1";
        let mut now = 1_000_000u64;

        for attempt in 1..=4 {
            let state = record_failed_pin_attempt(&root, mgr, now).unwrap();
            assert_eq!(state.consecutive_failed_attempts, attempt);
            assert!(!state.locked_out);
            assert!(state.current_lockout_id_hex.is_none());

            let check = check_manager_lockout(&root, mgr, now).unwrap();
            assert_eq!(check, LockoutPrecheck::Unlocked { consecutive_failed_attempts: attempt });
            now += 1000;
        }

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn attempt_5_locks_out_and_mints_lockout_id() {
        let root = temp_root();
        let mgr = "mgr-1";
        let now = 1_000_000u64;

        for _ in 1..=4 {
            record_failed_pin_attempt(&root, mgr, now).unwrap();
        }

        let state5 = record_failed_pin_attempt(&root, mgr, now).unwrap();
        assert_eq!(state5.consecutive_failed_attempts, 5);
        assert!(state5.locked_out);
        assert_eq!(state5.locked_at_ms, Some(now));
        assert!(state5.current_lockout_id_hex.is_some());
        let lockout_id = state5.current_lockout_id_hex.unwrap();
        assert_eq!(lockout_id.len(), 64);

        // Before 15m, check says LockedOut
        let check = check_manager_lockout(&root, mgr, now + 1000).unwrap();
        match check {
            LockoutPrecheck::LockedOut { current_lockout_id_hex, cooldown_remaining_ms, clear_token_recorded, .. } => {
                assert_eq!(current_lockout_id_hex, lockout_id);
                assert_eq!(cooldown_remaining_ms, LOCKOUT_COOLDOWN_MS - 1000);
                assert!(!clear_token_recorded);
            }
            _ => panic!("expected LockedOut"),
        }

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn reopen_requires_both_15m_cooldown_and_valid_clear_token() {
        let root = temp_root();
        let mgr = "mgr-1";
        let now = 1_000_000u64;

        for _ in 1..=5 {
            record_failed_pin_attempt(&root, mgr, now).unwrap();
        }

        let store = read_lockout_store(&root).unwrap();
        let lockout_id_hex = store.managers.get(mgr).unwrap().current_lockout_id_hex.clone().unwrap();
        let mut raw_lockout_id = [0u8; 32];
        for i in 0..32 {
            raw_lockout_id[i] = u8::from_str_radix(&lockout_id_hex[i * 2..i * 2 + 2], 16).unwrap();
        }

        // 1. After 16m without clear token => STILL LOCKED
        let check_no_token = check_manager_lockout(&root, mgr, now + LOCKOUT_COOLDOWN_MS + 60_000).unwrap();
        assert!(matches!(check_no_token, LockoutPrecheck::LockedOut { clear_token_recorded: false, .. }));

        // 2. Clear token recorded at 5m (before 15m) => recorded, but cannot reopen until 15m
        let res_5m = record_lockout_clear_token(&root, mgr, &raw_lockout_id, now + 300_000).unwrap();
        assert!(!res_5m.reopens_now);
        assert_eq!(res_5m.cooldown_remaining_ms, LOCKOUT_COOLDOWN_MS - 300_000);

        let check_at_10m = check_manager_lockout(&root, mgr, now + 600_000).unwrap();
        assert!(matches!(check_at_10m, LockoutPrecheck::LockedOut { clear_token_recorded: true, .. }));

        // 3. At 15m+1ms (BOTH conditions satisfied) => REOPENS!
        let check_reopen = check_manager_lockout(&root, mgr, now + LOCKOUT_COOLDOWN_MS + 1).unwrap();
        assert_eq!(check_reopen, LockoutPrecheck::Unlocked { consecutive_failed_attempts: 0 });

        // 4. Old LCT1 cannot be reused (generation was consumed/closed)
        let res_replay = record_lockout_clear_token(&root, mgr, &raw_lockout_id, now + LOCKOUT_COOLDOWN_MS + 2);
        assert_eq!(res_replay, Err(LockoutError::ManagerNotLockedOut));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn manager_isolation() {
        let root = temp_root();
        let now = 1_000_000u64;

        // Lock out mgr-1
        for _ in 1..=5 {
            record_failed_pin_attempt(&root, "mgr-1", now).unwrap();
        }

        // mgr-2 is unaffected
        let check2 = check_manager_lockout(&root, "mgr-2", now).unwrap();
        assert_eq!(check2, LockoutPrecheck::Unlocked { consecutive_failed_attempts: 0 });

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn corrupt_and_truncated_dpapi_fails_closed_without_wiping() {
        let root = temp_root();
        let path = lockout_state_path(&root);

        // 1. Truncated / empty file
        fs::write(&path, b"").unwrap();
        let res_empty = read_lockout_store(&root);
        assert!(matches!(res_empty, Err(LockoutError::PresentMalformed(_))));

        // 2. Corrupted ciphertext
        fs::write(&path, b"corrupted-ciphertext-not-dpapi").unwrap();
        let res_corrupt = read_lockout_store(&root);
        assert!(matches!(res_corrupt, Err(LockoutError::PresentMalformed(_))));

        // Verify file was NOT wiped or deleted
        assert!(path.exists());
        assert_eq!(fs::read(&path).unwrap(), b"corrupted-ciphertext-not-dpapi");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn valid_dpapi_plaintext_with_malformed_json_fails_closed() {
        let root = temp_root();
        let path = lockout_state_path(&root);

        let malformed_plaintext = b"not-a-json-object";
        let ciphertext = dpapi_envelope::dpapi_protect(malformed_plaintext).unwrap();
        write_atomic(&path, &ciphertext).unwrap();

        let res = read_lockout_store(&root);
        assert!(matches!(res, Err(LockoutError::PresentMalformed(_))));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn impossible_states_fail_closed() {
        let root = temp_root();
        let path = lockout_state_path(&root);

        let test_cases = [
            // 1. Locked out but lockedAtMs is null
            r#"{"managers":{"mgr-1":{"consecutiveFailedAttempts":5,"lockedOut":true,"lockedAtMs":null,"currentLockoutIdHex":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","clearTokenRecorded":false,"lastAttemptMs":1000}}}"#,
            // 2. Locked out but currentLockoutIdHex is null
            r#"{"managers":{"mgr-1":{"consecutiveFailedAttempts":5,"lockedOut":true,"lockedAtMs":1000,"currentLockoutIdHex":null,"clearTokenRecorded":false,"lastAttemptMs":1000}}}"#,
            // 3. Unlocked but currentLockoutIdHex is present
            r#"{"managers":{"mgr-1":{"consecutiveFailedAttempts":2,"lockedOut":false,"lockedAtMs":null,"currentLockoutIdHex":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","clearTokenRecorded":false,"lastAttemptMs":1000}}}"#,
            // 4. Unlocked but clearTokenRecorded is true
            r#"{"managers":{"mgr-1":{"consecutiveFailedAttempts":0,"lockedOut":false,"lockedAtMs":null,"currentLockoutIdHex":null,"clearTokenRecorded":true,"lastAttemptMs":1000}}}"#,
            // 5. Impossible attempt counter (6 attempts)
            r#"{"managers":{"mgr-1":{"consecutiveFailedAttempts":6,"lockedOut":true,"lockedAtMs":1000,"currentLockoutIdHex":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","clearTokenRecorded":false,"lastAttemptMs":1000}}}"#,
            // 6. 5 attempts but lockedOut: false
            r#"{"managers":{"mgr-1":{"consecutiveFailedAttempts":5,"lockedOut":false,"lockedAtMs":null,"currentLockoutIdHex":null,"clearTokenRecorded":false,"lastAttemptMs":1000}}}"#,
            // 7. Non-lowercase hex lockoutId (uppercase hex)
            r#"{"managers":{"mgr-1":{"consecutiveFailedAttempts":5,"lockedOut":true,"lockedAtMs":1000,"currentLockoutIdHex":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","clearTokenRecorded":false,"lastAttemptMs":1000}}}"#,
            // 8. Non-64 char lockoutId (short)
            r#"{"managers":{"mgr-1":{"consecutiveFailedAttempts":5,"lockedOut":true,"lockedAtMs":1000,"currentLockoutIdHex":"abcd","clearTokenRecorded":false,"lastAttemptMs":1000}}}"#,
            // 9. Unknown/extra fields (deny_unknown_fields)
            r#"{"managers":{"mgr-1":{"consecutiveFailedAttempts":0,"lockedOut":false,"lockedAtMs":null,"currentLockoutIdHex":null,"clearTokenRecorded":false,"lastAttemptMs":1000,"extraField":123}}}"#,
            // 10. Malformed manager identifier
            r#"{"managers":{"   ":{"consecutiveFailedAttempts":0,"lockedOut":false,"lockedAtMs":null,"currentLockoutIdHex":null,"clearTokenRecorded":false,"lastAttemptMs":1000}}}"#,
        ];

        for (idx, json_str) in test_cases.iter().enumerate() {
            let ciphertext = dpapi_envelope::dpapi_protect(json_str.as_bytes()).unwrap();
            write_atomic(&path, &ciphertext).unwrap();

            let res = read_lockout_store(&root);
            assert!(
                matches!(res, Err(LockoutError::PresentMalformed(_))),
                "Case {idx} must fail closed with PresentMalformed, got: {res:?}"
            );

            // Also check that check_manager_lockout fails closed
            let check_res = check_manager_lockout(&root, "mgr-1", 2000);
            assert!(
                matches!(check_res, Err(LockoutError::PresentMalformed(_))),
                "Case {idx} check_manager_lockout must fail closed, got: {check_res:?}"
            );
        }

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_rc002_encrypted_dpapi_last_attempt_invariants() {
        let root = temp_root();
        let path = lockout_state_path(&root);

        // 1. Invalid states with lastAttemptMs = 0 must fail closed
        let invalid_cases = [
            ("attempts1_zero_last_attempt", r#"{"managers":{"mgr-1":{"consecutiveFailedAttempts":1,"lockedOut":false,"lockedAtMs":null,"currentLockoutIdHex":null,"clearTokenRecorded":false,"lastAttemptMs":0}}}"#),
            ("attempts4_zero_last_attempt", r#"{"managers":{"mgr-1":{"consecutiveFailedAttempts":4,"lockedOut":false,"lockedAtMs":null,"currentLockoutIdHex":null,"clearTokenRecorded":false,"lastAttemptMs":0}}}"#),
            ("reset_count0_zero_last_attempt", r#"{"managers":{"mgr-1":{"consecutiveFailedAttempts":0,"lockedOut":false,"lockedAtMs":null,"currentLockoutIdHex":null,"clearTokenRecorded":false,"lastAttemptMs":0}}}"#),
        ];

        for (name, json_str) in invalid_cases {
            let ciphertext = dpapi_envelope::dpapi_protect(json_str.as_bytes()).unwrap();
            write_atomic(&path, &ciphertext).unwrap();

            // Store initial raw ciphertext
            let raw_before = fs::read(&path).unwrap();

            // Attempt read
            let read_res = read_lockout_store(&root);
            assert!(
                matches!(read_res, Err(LockoutError::PresentMalformed(_))),
                "{name} read_lockout_store must fail closed with PresentMalformed, got: {read_res:?}"
            );

            // Attempt check_manager_lockout
            let check_res = check_manager_lockout(&root, "mgr-1", 1_000_000);
            assert!(
                matches!(check_res, Err(LockoutError::PresentMalformed(_))),
                "{name} check_manager_lockout must fail closed with PresentMalformed, got: {check_res:?}"
            );

            // Attempt record_failed_pin_attempt
            let record_res = record_failed_pin_attempt(&root, "mgr-1", 1_000_000);
            assert!(
                matches!(record_res, Err(LockoutError::PresentMalformed(_))),
                "{name} record_failed_pin_attempt must fail closed with PresentMalformed, got: {record_res:?}"
            );

            // Invariant: rejected PRESENT_INVALID file remains intact and is NOT replaced or reset
            let raw_after = fs::read(&path).unwrap();
            assert_eq!(raw_before, raw_after, "{name} file must remain intact and not be overwritten/reset");
        }

        // 2. Corresponding positive timestamp states must be accepted as valid
        let valid_cases = [
            ("attempts1_positive_last_attempt", r#"{"managers":{"mgr-1":{"consecutiveFailedAttempts":1,"lockedOut":false,"lockedAtMs":null,"currentLockoutIdHex":null,"clearTokenRecorded":false,"lastAttemptMs":500000}}}"#, 1),
            ("attempts4_positive_last_attempt", r#"{"managers":{"mgr-1":{"consecutiveFailedAttempts":4,"lockedOut":false,"lockedAtMs":null,"currentLockoutIdHex":null,"clearTokenRecorded":false,"lastAttemptMs":500000}}}"#, 4),
            ("reset_count0_positive_last_attempt", r#"{"managers":{"mgr-1":{"consecutiveFailedAttempts":0,"lockedOut":false,"lockedAtMs":null,"currentLockoutIdHex":null,"clearTokenRecorded":false,"lastAttemptMs":500000}}}"#, 0),
        ];

        for (name, json_str, expected_attempts) in valid_cases {
            let ciphertext = dpapi_envelope::dpapi_protect(json_str.as_bytes()).unwrap();
            write_atomic(&path, &ciphertext).unwrap();

            let store = read_lockout_store(&root).unwrap_or_else(|e| panic!("{name} must be readable: {e:?}"));
            let entry = store.managers.get("mgr-1").expect("mgr-1 entry present");
            assert_eq!(entry.consecutive_failed_attempts, expected_attempts);
            assert_eq!(entry.last_attempt_ms, 500000);

            let check = check_manager_lockout(&root, "mgr-1", 1_000_000).unwrap_or_else(|e| panic!("{name} check must succeed: {e:?}"));
            assert_eq!(check, LockoutPrecheck::Unlocked { consecutive_failed_attempts: expected_attempts });
        }

        let _ = fs::remove_dir_all(&root);
    }
}
