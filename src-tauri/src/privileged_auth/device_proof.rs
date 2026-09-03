//! SEC-001 Packet C-A — the POS terminal's own Ed25519 "device proof"
//! keypair. Generated once per installation, DPAPI-protected at rest
//! (CurrentUser scope); its public half is embedded in DRP1/PTP1/PIN1 frames
//! and its private half signs them, proving continued possession across the
//! device's whole enrollment/provisioning lifecycle.

use super::dpapi_envelope::{dpapi_protect, dpapi_unprotect};
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use std::fs;
use std::path::{Path, PathBuf};

pub const DEVICE_PROOF_KEY_FILE_NAME: &str = "twinpet-device-proof-key.dpapi";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceProofError {
    Corrupt,
    Io,
    DpapiFailed,
}

pub fn device_proof_key_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(DEVICE_PROOF_KEY_FILE_NAME)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), DeviceProofError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| DeviceProofError::Io)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|_| DeviceProofError::Io)?;
    fs::rename(&tmp, path).map_err(|_| DeviceProofError::Io)
}

/// Reads the persisted device-proof signing key, or generates and persists a
/// fresh one on first run. Fails closed on corruption or a DPAPI failure —
/// never silently regenerates (that would orphan every already-registered
/// device identity bound to the previous public key).
pub fn resolve_or_create_device_keypair(app_data_dir: &Path) -> Result<SigningKey, DeviceProofError> {
    let path = device_proof_key_path(app_data_dir);
    match fs::read(&path) {
        Ok(ciphertext) => {
            let plaintext = dpapi_unprotect(&ciphertext).map_err(|_| DeviceProofError::DpapiFailed)?;
            if plaintext.len() != 32 {
                return Err(DeviceProofError::Corrupt);
            }
            let mut seed = [0u8; 32];
            seed.copy_from_slice(&plaintext);
            Ok(SigningKey::from_bytes(&seed))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let signing_key = SigningKey::generate(&mut OsRng);
            let ciphertext =
                dpapi_protect(&signing_key.to_bytes()).map_err(|_| DeviceProofError::DpapiFailed)?;
            write_atomic(&path, &ciphertext)?;
            Ok(signing_key)
        }
        Err(_) => Err(DeviceProofError::Io),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Signer, Verifier};

    fn temp_dir() -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "twinpet-device-proof-test-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
            n
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn first_run_generates_a_usable_signing_key() {
        let dir = temp_dir();
        let signing_key = resolve_or_create_device_keypair(&dir).unwrap();
        let message = b"twinpet device proof";
        let signature: Signature = signing_key.sign(message);
        assert!(signing_key.verifying_key().verify(message, &signature).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn second_run_returns_the_same_keypair() {
        let dir = temp_dir();
        let first = resolve_or_create_device_keypair(&dir).unwrap();
        let second = resolve_or_create_device_keypair(&dir).unwrap();
        assert_eq!(first.to_bytes(), second.to_bytes());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn distinct_installs_get_distinct_keypairs() {
        let dir_a = temp_dir();
        let dir_b = temp_dir();
        let a = resolve_or_create_device_keypair(&dir_a).unwrap();
        let b = resolve_or_create_device_keypair(&dir_b).unwrap();
        assert_ne!(a.to_bytes(), b.to_bytes());
        let _ = fs::remove_dir_all(&dir_a);
        let _ = fs::remove_dir_all(&dir_b);
    }

    #[test]
    fn persisted_file_is_not_plaintext() {
        let dir = temp_dir();
        let signing_key = resolve_or_create_device_keypair(&dir).unwrap();
        let on_disk = fs::read(device_proof_key_path(&dir)).unwrap();
        assert_ne!(on_disk, signing_key.to_bytes().to_vec());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_ciphertext_fails_closed() {
        let dir = temp_dir();
        fs::write(device_proof_key_path(&dir), b"not a dpapi blob").unwrap();
        match resolve_or_create_device_keypair(&dir) {
            Err(DeviceProofError::DpapiFailed) => {}
            other => panic!("expected DpapiFailed, got {}", other.is_ok()),
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
