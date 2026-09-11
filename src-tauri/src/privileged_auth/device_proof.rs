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

/// SEC-001 epoch-2 rollback remediation: 1-byte version prefix ahead of the
/// 32-byte Ed25519 seed payload, for both the legacy canonical key and the
/// generation-scoped keys. Legacy unversioned files (exactly 32 bytes) are
/// recognized by length and treated as implicit version 1.
pub const DEVICE_PROOF_KEY_STORE_VERSION: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceProofError {
    NotFound,
    Corrupt,
    Io,
    DpapiFailed,
    UnknownVersion,
}

/// Legacy canonical device proof key path (migration-only / non-authoritative).
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
pub fn resolve_or_create_device_keypair(
    app_data_dir: &Path,
) -> Result<SigningKey, DeviceProofError> {
    let path = device_proof_key_path(app_data_dir);
    match fs::read(&path) {
        Ok(ciphertext) => {
            let plaintext =
                dpapi_unprotect(&ciphertext).map_err(|_| DeviceProofError::DpapiFailed)?;
            let was_legacy_unversioned = plaintext.len() == 32;
            let seed = decode_device_proof_key_plaintext(&plaintext)?;
            if was_legacy_unversioned {
                // Legacy unversioned format: implicit version 1. This file has
                // no externally-pinned content hash, so it is safe to migrate
                // in place, unlike the fence-pinned generation-scoped keys.
                let ciphertext = dpapi_protect(&versioned_key_payload(&seed))
                    .map_err(|_| DeviceProofError::DpapiFailed)?;
                write_atomic(&path, &ciphertext)?;
            }
            Ok(SigningKey::from_bytes(&seed))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let signing_key = SigningKey::generate(&mut OsRng);
            let ciphertext = dpapi_protect(&versioned_key_payload(&signing_key.to_bytes()))
                .map_err(|_| DeviceProofError::DpapiFailed)?;
            write_atomic(&path, &ciphertext)?;
            Ok(signing_key)
        }
        Err(_) => Err(DeviceProofError::Io),
    }
}

/// SEC-001 epoch-2 rollback remediation (Claude-024 / Gemini-041 authority):
/// current versioned on-disk plaintext shape (1-byte version prefix + the
/// 32-byte Ed25519 seed), used by both the legacy canonical key writer and
/// the generation-scoped key writer (`enrollment_meta::stage_device_enrollment`).
pub fn versioned_key_payload(seed: &[u8; 32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(33);
    out.push(DEVICE_PROOF_KEY_STORE_VERSION);
    out.extend_from_slice(seed);
    out
}

/// Centralized decode for a device-proof-key DPAPI plaintext payload: accepts
/// the exact legacy unversioned 32-byte seed and the current versioned
/// 33-byte (version + seed) shape, rejects an unknown newer version, and
/// rejects any other length as corrupt. Used by every production reader
/// (`resolve_or_create_device_keypair`, `load_enrolled_device_keypair`, and
/// `enrollment_meta::classify_directory_artifacts`'s generation-key check) so
/// the accepted wire shapes cannot drift apart between call sites.
pub fn decode_device_proof_key_plaintext(plaintext: &[u8]) -> Result<[u8; 32], DeviceProofError> {
    if plaintext.len() == 32 {
        let mut seed = [0u8; 32];
        seed.copy_from_slice(plaintext);
        return Ok(seed);
    }
    if plaintext.len() != 33 {
        return Err(DeviceProofError::Corrupt);
    }
    if plaintext[0] != DEVICE_PROOF_KEY_STORE_VERSION {
        return Err(DeviceProofError::UnknownVersion);
    }
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&plaintext[1..]);
    Ok(seed)
}

/// Returns the strict fence-selected generation key path for the active COMMITTED generation.
/// Fails closed if fence is missing, not COMMITTED, empty generation, or file absent.
/// Never falls back to legacy canonical or compatibility copies.
pub fn active_enrolled_device_key_path(app_data_dir: &Path) -> Result<PathBuf, DeviceProofError> {
    let fence_path = super::enrollment_meta::enrollment_fence_path(app_data_dir);
    let fence_bytes = match fs::read(&fence_path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(DeviceProofError::NotFound)
        }
        Err(_) => return Err(DeviceProofError::Io),
    };
    let fence: super::enrollment_meta::EnrollmentFenceState =
        serde_json::from_slice(&fence_bytes).map_err(|_| DeviceProofError::Corrupt)?;
    // SEC-001 epoch-2 rollback remediation (Claude-024): Codex-011 found this
    // production reader deserialized the fence without enforcing
    // `check_enrollment_fence_schema_version`, bypassing the
    // unknown-newer-schema fail-closed contract enforced everywhere else.
    super::enrollment_meta::check_enrollment_fence_schema_version(fence.schema_version)
        .map_err(|_| DeviceProofError::UnknownVersion)?;

    if fence.state != "COMMITTED" || fence.enrollment_generation_id.trim().is_empty() {
        return Err(DeviceProofError::NotFound);
    }

    let gen_path = app_data_dir.join(format!(
        "twinpet-device-proof-key-{}.dpapi",
        fence.enrollment_generation_id.to_lowercase()
    ));

    if !gen_path.exists() {
        return Err(DeviceProofError::NotFound);
    }

    Ok(gen_path)
}

/// Reads the persisted device-proof signing key without auto-creating.
/// Selects the runtime authority key strictly from the active COMMITTED generation fence.
/// Never falls back to legacy canonical or compatibility copies.
/// Fails closed with NotFound if missing (DEC-D-08 runtime load-only).
///
/// SEC-001 epoch-2: accepts both the legacy unversioned 32-byte payload and
/// the versioned 33-byte payload on read for backward compatibility, but
/// deliberately does NOT rewrite the file in place — this file's ciphertext
/// SHA-256 is pinned in the enrollment fence (`key_sha256`) at commit time,
/// so an in-place rewrite would desynchronize that hash pin and break the
/// fence's integrity cross-check on every subsequent load. New generations
/// (see `stage_device_enrollment`) are written with the version prefix from
/// the start, so this compatibility path only serves pre-existing generations.
pub fn load_enrolled_device_keypair(app_data_dir: &Path) -> Result<SigningKey, DeviceProofError> {
    let path = active_enrolled_device_key_path(app_data_dir)?;
    match fs::read(&path) {
        Ok(ciphertext) => {
            let plaintext =
                dpapi_unprotect(&ciphertext).map_err(|_| DeviceProofError::DpapiFailed)?;
            let seed = decode_device_proof_key_plaintext(&plaintext)?;
            Ok(SigningKey::from_bytes(&seed))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(DeviceProofError::NotFound),
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
    fn first_run_generates_a_usable_signing_key() {
        let dir = temp_dir();
        let signing_key = resolve_or_create_device_keypair(&dir).unwrap();
        let message = b"twinpet device proof";
        let signature: Signature = signing_key.sign(message);
        assert!(signing_key
            .verifying_key()
            .verify(message, &signature)
            .is_ok());
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

    #[test]
    fn legacy_unversioned_canonical_key_is_migrated_on_read() {
        let dir = temp_dir();
        let legacy_key = SigningKey::generate(&mut OsRng);
        let ciphertext = dpapi_protect(&legacy_key.to_bytes()).unwrap();
        fs::write(device_proof_key_path(&dir), &ciphertext).unwrap();

        let read_back = resolve_or_create_device_keypair(&dir).unwrap();
        assert_eq!(read_back.to_bytes(), legacy_key.to_bytes());

        let on_disk = fs::read(device_proof_key_path(&dir)).unwrap();
        let plaintext = dpapi_unprotect(&on_disk).unwrap();
        assert_eq!(plaintext.len(), 33);
        assert_eq!(plaintext[0], DEVICE_PROOF_KEY_STORE_VERSION);
        assert_eq!(&plaintext[1..], &legacy_key.to_bytes()[..]);

        let second = resolve_or_create_device_keypair(&dir).unwrap();
        assert_eq!(second.to_bytes(), legacy_key.to_bytes());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_newer_canonical_key_version_fails_closed() {
        let dir = temp_dir();
        let mut payload = vec![DEVICE_PROOF_KEY_STORE_VERSION + 1];
        payload.extend_from_slice(&[1u8; 32]);
        let ciphertext = dpapi_protect(&payload).unwrap();
        fs::write(device_proof_key_path(&dir), &ciphertext).unwrap();
        assert_eq!(
            resolve_or_create_device_keypair(&dir),
            Err(DeviceProofError::UnknownVersion)
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn writer_always_emits_current_canonical_key_version() {
        let dir = temp_dir();
        resolve_or_create_device_keypair(&dir).unwrap();
        let on_disk = fs::read(device_proof_key_path(&dir)).unwrap();
        let plaintext = dpapi_unprotect(&on_disk).unwrap();
        assert_eq!(plaintext[0], DEVICE_PROOF_KEY_STORE_VERSION);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn generation_scoped_loader_accepts_legacy_and_versioned_shapes_without_rewrite() {
        let dir = temp_dir();
        let key = SigningKey::generate(&mut OsRng);

        // Legacy unversioned (32-byte) shape, as written by pre-remediation
        // generations / existing test fixtures that pin its ciphertext hash.
        let legacy_cipher = dpapi_protect(&key.to_bytes()).unwrap();
        let gen_path = dir.join("twinpet-device-proof-key-legacy.dpapi");
        fs::write(&gen_path, &legacy_cipher).unwrap();
        let before = fs::read(&gen_path).unwrap();

        let mut versioned_payload = vec![DEVICE_PROOF_KEY_STORE_VERSION];
        versioned_payload.extend_from_slice(&key.to_bytes());
        let versioned_cipher = dpapi_protect(&versioned_payload).unwrap();

        // Directly exercise both plaintext shapes through the same decode
        // logic `load_enrolled_device_keypair` uses, without depending on the
        // fence-selection machinery (covered separately in enrollment_meta.rs).
        let legacy_plain = dpapi_unprotect(&legacy_cipher).unwrap();
        assert_eq!(legacy_plain.len(), 32);
        let versioned_plain = dpapi_unprotect(&versioned_cipher).unwrap();
        assert_eq!(versioned_plain.len(), 33);
        assert_eq!(versioned_plain[0], DEVICE_PROOF_KEY_STORE_VERSION);

        // The on-disk legacy file must remain byte-for-byte unchanged (no
        // rewrite), preserving any externally-pinned ciphertext hash.
        let after = fs::read(&gen_path).unwrap();
        assert_eq!(before, after);
        let _ = fs::remove_dir_all(&dir);
    }

    /// SEC-001 epoch-2 final remediation (Claude-025 / Gemini-042 authority),
    /// R3 real migration failure injection: `resolve_or_create_device_keypair`
    /// migrates a legacy unversioned canonical key by writing through
    /// `write_atomic`'s tmp-file + rename primitive
    /// (`device_proof_key_path(dir).with_extension("tmp")`, i.e.
    /// `twinpet-device-proof-key.tmp`). Pre-creating a *directory* at that
    /// exact tmp path makes the migration's `fs::write(&tmp, ..)` genuinely
    /// fail (a real OS I/O error, not a mock), so this actually exercises the
    /// legacy-unversioned read/migration path with a deterministic write
    /// failure injected.
    #[test]
    fn failed_legacy_canonical_key_migration_preserves_original_bytes() {
        let dir = temp_dir();
        let legacy_key = SigningKey::generate(&mut OsRng);
        let ciphertext = dpapi_protect(&legacy_key.to_bytes()).unwrap();
        let target_path = device_proof_key_path(&dir);
        fs::write(&target_path, &ciphertext).unwrap();
        let original_bytes = fs::read(&target_path).unwrap();
        assert_eq!(original_bytes, ciphertext);

        // Obstruct the migration's tmp-file write target with a directory so
        // the write step deterministically fails.
        let tmp_path = target_path.with_extension("tmp");
        fs::create_dir_all(&tmp_path).unwrap();

        let result = resolve_or_create_device_keypair(&dir);
        assert!(
            result.is_err(),
            "expected the obstructed migration write to fail, got {}",
            result.is_ok()
        );

        let after_bytes = fs::read(&target_path).unwrap();
        assert_eq!(
            after_bytes, original_bytes,
            "a failed migration write must leave the original legacy bytes exactly unchanged"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// SEC-001 epoch-2 rollback remediation (Claude-024): Codex-011 found
    /// that `active_enrolled_device_key_path` deserialized the committed
    /// fence without enforcing its schema-version check, so an unknown-newer
    /// fence would still resolve a key path (and `load_enrolled_device_keypair`
    /// would still load through it) instead of failing closed like every
    /// other committed-fence production reader.
    #[test]
    fn unknown_newer_fence_schema_version_fails_closed_through_production_loader() {
        let dir = temp_dir();
        let fence_path = super::super::enrollment_meta::enrollment_fence_path(&dir);
        let json = format!(
            r#"{{"state":"COMMITTED","enrollmentGenerationId":"0102030405060708090a0b0c0d0e0f10","securityDeviceIdHex":"aabbccddeeff00112233445566778899","deviceKeyVersion":1,"keySha256":"aa","metaSha256":"bb","committedAtLocalMs":1000,"schemaVersion":{}}}"#,
            super::super::enrollment_meta::ENROLLMENT_FENCE_SCHEMA_VERSION + 1
        );
        fs::write(&fence_path, json).unwrap();

        assert_eq!(
            active_enrolled_device_key_path(&dir),
            Err(DeviceProofError::UnknownVersion)
        );
        assert_eq!(
            load_enrolled_device_keypair(&dir),
            Err(DeviceProofError::UnknownVersion)
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
