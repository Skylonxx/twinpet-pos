//! SEC-001 Packet C-A — generates the DRP1 (`DeviceRegistrationPossessionFrameV1`)
//! possession proof: the device's own security-device-id + device-proof
//! public key, bound to a server-issued nonce and the enrollment authorization
//! extracted from an imported enrollment file, self-signed with the device's
//! Ed25519 private key. Backs `native_generate_device_registration_proof`.

use super::enrollment_meta::stage_device_enrollment;
use super::frames::{drp1_signed_prefix, encode_drp1, DeviceRegistrationPossessionFrameV1, DRP1_TOTAL_BYTES};
use super::security_device_id::{resolve_or_create_security_device_id, SecurityDeviceIdError};
use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceRegistrationProofError {
    InvalidEnrollmentAuthId,
    DeviceIdUnavailable,
    DeviceKeyUnavailable,
}

fn is_lowercase_hex32(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GenerateRegistrationProofOutcome {
    pub drp1_bytes: [u8; DRP1_TOTAL_BYTES],
    pub enrollment_generation_id_hex: String,
    pub staged_public_key_bytes: [u8; 32],
}

/// Generates and self-signs a fresh DRP1 frame under GD-001 Option A.
/// Durably stages the fresh private key and generation ID without affecting any committed generation.
/// Returns the typed outcome containing DRP1 wire encoding, exact enrollment generation ID, and staged public key.
pub fn generate_device_registration_proof(
    runtime: &super::enrollment_meta::EnrollmentRuntimeState,
    app_data_dir: &Path,
    enrollment_auth_id: &str,
    device_registration_nonce: [u8; 32],
) -> Result<GenerateRegistrationProofOutcome, DeviceRegistrationProofError> {
    if !is_lowercase_hex32(enrollment_auth_id) {
        return Err(DeviceRegistrationProofError::InvalidEnrollmentAuthId);
    }
    let security_device_id = resolve_or_create_security_device_id(app_data_dir)
        .map_err(|_: SecurityDeviceIdError| DeviceRegistrationProofError::DeviceIdUnavailable)?;
    let signing_key = SigningKey::generate(&mut OsRng);
    let staged = stage_device_enrollment(app_data_dir, security_device_id, &signing_key)
        .map_err(|_| DeviceRegistrationProofError::DeviceKeyUnavailable)?;
    let dev_proof_public_key = signing_key.verifying_key().to_bytes();

    let unsigned = DeviceRegistrationPossessionFrameV1 {
        enrollment_auth_id: enrollment_auth_id.to_string(),
        device_registration_nonce,
        security_device_id,
        dev_proof_public_key,
        signature: [0u8; 64],
    };
    let prefix = drp1_signed_prefix(&unsigned);
    let signature = signing_key.sign(&prefix).to_bytes();
    let frame = DeviceRegistrationPossessionFrameV1 { signature, ..unsigned };

    let request_qpc_ticks = super::monotonic_clock::read_qpc_ticks().unwrap_or(0);
    let boot_session_id = super::monotonic_clock::boot_session_id();
    runtime.record_pending_request(super::enrollment_meta::PendingRequestContext {
        request_qpc_ticks,
        boot_session_id,
        device_registration_nonce,
        security_device_id,
        enrollment_generation_id_hex: staged.enrollment_generation_id_hex.clone(),
        staged_public_key: dev_proof_public_key,
        test_receipt_qpc_ticks: None,
    });

    Ok(GenerateRegistrationProofOutcome {
        drp1_bytes: encode_drp1(&frame),
        enrollment_generation_id_hex: staged.enrollment_generation_id_hex,
        staged_public_key_bytes: dev_proof_public_key,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::privileged_auth::frames::decode_drp1;
    use ed25519_dalek::{Verifier, VerifyingKey};
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir() -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "twinpet-drp1-gen-test-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
            n
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn generates_a_valid_self_verifiable_drp1_frame() {
        let dir = temp_dir();
        let runtime = crate::privileged_auth::enrollment_meta::EnrollmentRuntimeState::new();
        let nonce = [0x42u8; 32];
        let outcome = generate_device_registration_proof(&runtime, &dir, "00112233445566778899aabbccddeeff", nonce).unwrap();
        assert_eq!(outcome.drp1_bytes.len(), DRP1_TOTAL_BYTES);
        assert_eq!(outcome.enrollment_generation_id_hex.len(), 32);

        let decoded = decode_drp1(&outcome.drp1_bytes).unwrap();
        assert_eq!(decoded.enrollment_auth_id, "00112233445566778899aabbccddeeff");
        assert_eq!(decoded.device_registration_nonce, nonce);

        let verifying_key = VerifyingKey::from_bytes(&decoded.dev_proof_public_key).unwrap();
        let prefix = drp1_signed_prefix(&decoded);
        let signature = ed25519_dalek::Signature::from_bytes(&decoded.signature);
        assert!(verifying_key.verify(&prefix, &signature).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_a_malformed_enrollment_auth_id() {
        let dir = temp_dir();
        let runtime = crate::privileged_auth::enrollment_meta::EnrollmentRuntimeState::new();
        let result = generate_device_registration_proof(&runtime, &dir, "not-hex", [0u8; 32]);
        assert_eq!(result, Err(DeviceRegistrationProofError::InvalidEnrollmentAuthId));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn stages_fresh_keypair_and_preserves_device_identity_across_calls() {
        let dir = temp_dir();
        let runtime = crate::privileged_auth::enrollment_meta::EnrollmentRuntimeState::new();
        let a = generate_device_registration_proof(&runtime, &dir, "00112233445566778899aabbccddeeff", [1u8; 32]).unwrap();
        let b = generate_device_registration_proof(&runtime, &dir, "00112233445566778899aabbccddeeff", [2u8; 32]).unwrap();
        let decoded_a = decode_drp1(&a.drp1_bytes).unwrap();
        let decoded_b = decode_drp1(&b.drp1_bytes).unwrap();
        // Stable device identity
        assert_eq!(decoded_a.security_device_id, decoded_b.security_device_id);
        // Distinct generation IDs
        assert_ne!(a.enrollment_generation_id_hex, b.enrollment_generation_id_hex);
        // Under GD-001 Option A: each prepare stages a fresh distinct keypair
        assert_ne!(decoded_a.dev_proof_public_key, decoded_b.dev_proof_public_key);
        // Both staged artifacts coexist durably on disk without mutual overwriting
        assert!(crate::privileged_auth::enrollment_meta::enrollment_staged_generation_path(&dir, &a.enrollment_generation_id_hex).exists());
        assert!(crate::privileged_auth::enrollment_meta::enrollment_staged_generation_path(&dir, &b.enrollment_generation_id_hex).exists());
        assert!(crate::privileged_auth::enrollment_meta::generation_proof_key_path(&dir, &a.enrollment_generation_id_hex).exists());
        assert!(crate::privileged_auth::enrollment_meta::generation_proof_key_path(&dir, &b.enrollment_generation_id_hex).exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
