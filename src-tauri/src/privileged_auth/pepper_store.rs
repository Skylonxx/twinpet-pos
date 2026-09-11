//! SEC-001 Packet C-A — local Argon2id pepper. A 32-byte device-bound secret,
//! generated once and DPAPI-protected at rest (CurrentUser scope), mixed
//! into every offline PIN verifier so a stolen `verifier`/`verifierSalt` pair
//! (e.g. exfiltrated from a synced OAC) cannot be brute-forced offline
//! without also possessing this specific device's Windows user profile.

use super::dpapi_envelope::{dpapi_protect, dpapi_unprotect};
use rand::RngCore;
use std::fs;
use std::path::{Path, PathBuf};

pub const PEPPER_FILE_NAME: &str = "twinpet-oac-pepper.dpapi";
pub const PEPPER_LEN: usize = 32;

/// SEC-001 epoch-2 rollback remediation: 1-byte version prefix ahead of the
/// fixed-length payload. A legacy pre-remediation file (exactly `PEPPER_LEN`
/// bytes, no prefix) is recognized by its length alone and is treated as
/// implicit version 1 on read, then rewritten in place with the explicit
/// prefix using the same atomic write path.
pub const PEPPER_STORE_VERSION: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PepperStoreError {
    Corrupt,
    Io,
    DpapiFailed,
    UnknownVersion,
}

pub fn pepper_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(PEPPER_FILE_NAME)
}

fn generate_pepper() -> [u8; PEPPER_LEN] {
    let mut bytes = [0u8; PEPPER_LEN];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), PepperStoreError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| PepperStoreError::Io)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|_| PepperStoreError::Io)?;
    fs::rename(&tmp, path).map_err(|_| PepperStoreError::Io)
}

/// Reads the persisted, DPAPI-protected pepper, or generates and persists a
/// fresh one on first run. Fails closed on corruption or a DPAPI failure
/// (e.g. the blob was protected under a different Windows user profile) —
/// never silently regenerates a pepper that would silently invalidate every
/// already-provisioned OAC's verifier.
pub fn resolve_or_create_pepper(app_data_dir: &Path) -> Result<[u8; PEPPER_LEN], PepperStoreError> {
    let path = pepper_path(app_data_dir);
    match fs::read(&path) {
        Ok(ciphertext) => {
            let plaintext =
                dpapi_unprotect(&ciphertext).map_err(|_| PepperStoreError::DpapiFailed)?;
            if plaintext.len() == PEPPER_LEN {
                // Legacy unversioned format: implicit version 1. Migrate in
                // place so future reads see the explicit version prefix.
                let mut out = [0u8; PEPPER_LEN];
                out.copy_from_slice(&plaintext);
                let ciphertext = dpapi_protect(&versioned_payload(&out))
                    .map_err(|_| PepperStoreError::DpapiFailed)?;
                write_atomic(&path, &ciphertext)?;
                return Ok(out);
            }
            if plaintext.len() != PEPPER_LEN + 1 {
                return Err(PepperStoreError::Corrupt);
            }
            if plaintext[0] != PEPPER_STORE_VERSION {
                return Err(PepperStoreError::UnknownVersion);
            }
            let mut out = [0u8; PEPPER_LEN];
            out.copy_from_slice(&plaintext[1..]);
            Ok(out)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let pepper = generate_pepper();
            let ciphertext = dpapi_protect(&versioned_payload(&pepper))
                .map_err(|_| PepperStoreError::DpapiFailed)?;
            write_atomic(&path, &ciphertext)?;
            Ok(pepper)
        }
        Err(_) => Err(PepperStoreError::Io),
    }
}

fn versioned_payload(pepper: &[u8; PEPPER_LEN]) -> Vec<u8> {
    let mut out = Vec::with_capacity(PEPPER_LEN + 1);
    out.push(PEPPER_STORE_VERSION);
    out.extend_from_slice(pepper);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "twinpet-pepper-test-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            n
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn first_run_generates_and_persists() {
        let dir = temp_dir();
        let pepper = resolve_or_create_pepper(&dir).unwrap();
        assert_eq!(pepper.len(), PEPPER_LEN);
        assert!(pepper_path(&dir).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn second_run_returns_the_same_pepper() {
        let dir = temp_dir();
        let first = resolve_or_create_pepper(&dir).unwrap();
        let second = resolve_or_create_pepper(&dir).unwrap();
        assert_eq!(first, second);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn persisted_file_is_not_plaintext() {
        let dir = temp_dir();
        let pepper = resolve_or_create_pepper(&dir).unwrap();
        let on_disk = fs::read(pepper_path(&dir)).unwrap();
        assert_ne!(on_disk, pepper.to_vec());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn distinct_installs_get_distinct_peppers() {
        let dir_a = temp_dir();
        let dir_b = temp_dir();
        let a = resolve_or_create_pepper(&dir_a).unwrap();
        let b = resolve_or_create_pepper(&dir_b).unwrap();
        assert_ne!(a, b);
        let _ = fs::remove_dir_all(&dir_a);
        let _ = fs::remove_dir_all(&dir_b);
    }

    #[test]
    fn corrupt_ciphertext_fails_closed() {
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        fs::write(pepper_path(&dir), b"not a real dpapi blob").unwrap();
        assert_eq!(
            resolve_or_create_pepper(&dir),
            Err(PepperStoreError::DpapiFailed)
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_unversioned_pepper_is_migrated_on_read() {
        let dir = temp_dir();
        let legacy_pepper = [7u8; PEPPER_LEN];
        let ciphertext = dpapi_protect(&legacy_pepper).unwrap();
        fs::create_dir_all(&dir).unwrap();
        fs::write(pepper_path(&dir), &ciphertext).unwrap();

        let read_back = resolve_or_create_pepper(&dir).unwrap();
        assert_eq!(read_back, legacy_pepper);

        let on_disk = fs::read(pepper_path(&dir)).unwrap();
        let plaintext = dpapi_unprotect(&on_disk).unwrap();
        assert_eq!(plaintext.len(), PEPPER_LEN + 1);
        assert_eq!(plaintext[0], PEPPER_STORE_VERSION);
        assert_eq!(&plaintext[1..], &legacy_pepper[..]);

        let second = resolve_or_create_pepper(&dir).unwrap();
        assert_eq!(second, legacy_pepper);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_newer_pepper_version_fails_closed() {
        let dir = temp_dir();
        let mut payload = vec![PEPPER_STORE_VERSION + 1];
        payload.extend_from_slice(&[9u8; PEPPER_LEN]);
        let ciphertext = dpapi_protect(&payload).unwrap();
        fs::create_dir_all(&dir).unwrap();
        fs::write(pepper_path(&dir), &ciphertext).unwrap();
        assert_eq!(
            resolve_or_create_pepper(&dir),
            Err(PepperStoreError::UnknownVersion)
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn writer_always_emits_current_pepper_version() {
        let dir = temp_dir();
        resolve_or_create_pepper(&dir).unwrap();
        let on_disk = fs::read(pepper_path(&dir)).unwrap();
        let plaintext = dpapi_unprotect(&on_disk).unwrap();
        assert_eq!(plaintext[0], PEPPER_STORE_VERSION);
        let _ = fs::remove_dir_all(&dir);
    }

    /// SEC-001 epoch-2 final remediation (Claude-025 / Gemini-042 authority),
    /// R3 real migration failure injection: `resolve_or_create_pepper`
    /// migrates a legacy unversioned pepper by writing through
    /// `write_atomic`'s tmp-file + rename primitive
    /// (`pepper_path(dir).with_extension("tmp")`, i.e. `twinpet-oac-pepper.tmp`).
    /// Pre-creating a *directory* at that exact tmp path makes the migration's
    /// `fs::write(&tmp, ..)` genuinely fail (a real OS I/O error, not a mock),
    /// so this actually exercises the legacy-unversioned read/migration path
    /// with a deterministic write failure injected, rather than merely
    /// reasoning that atomic rename would preserve old bytes.
    #[test]
    fn failed_migration_write_preserves_original_legacy_bytes() {
        let dir = temp_dir();
        let legacy_pepper = [3u8; PEPPER_LEN];
        let ciphertext = dpapi_protect(&legacy_pepper).unwrap();
        fs::create_dir_all(&dir).unwrap();
        let target_path = pepper_path(&dir);
        fs::write(&target_path, &ciphertext).unwrap();
        let original_bytes = fs::read(&target_path).unwrap();
        assert_eq!(original_bytes, ciphertext);

        // Obstruct the migration's tmp-file write target with a directory so
        // the write step deterministically fails.
        let tmp_path = target_path.with_extension("tmp");
        fs::create_dir_all(&tmp_path).unwrap();

        let result = resolve_or_create_pepper(&dir);
        assert!(
            result.is_err(),
            "expected the obstructed migration write to fail, got {result:?}"
        );

        let after_bytes = fs::read(&target_path).unwrap();
        assert_eq!(
            after_bytes, original_bytes,
            "a failed migration write must leave the original legacy bytes exactly unchanged"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
