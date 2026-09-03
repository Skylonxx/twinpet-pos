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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PepperStoreError {
    Corrupt,
    Io,
    DpapiFailed,
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
            let plaintext = dpapi_unprotect(&ciphertext).map_err(|_| PepperStoreError::DpapiFailed)?;
            if plaintext.len() != PEPPER_LEN {
                return Err(PepperStoreError::Corrupt);
            }
            let mut out = [0u8; PEPPER_LEN];
            out.copy_from_slice(&plaintext);
            Ok(out)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let pepper = generate_pepper();
            let ciphertext = dpapi_protect(&pepper).map_err(|_| PepperStoreError::DpapiFailed)?;
            write_atomic(&path, &ciphertext)?;
            Ok(pepper)
        }
        Err(_) => Err(PepperStoreError::Io),
    }
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
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
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
        assert_eq!(resolve_or_create_pepper(&dir), Err(PepperStoreError::DpapiFailed));
        let _ = fs::remove_dir_all(&dir);
    }
}
