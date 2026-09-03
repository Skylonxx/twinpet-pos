//! SEC-001 Packet C-A — generates the DRP1 (`DeviceRegistrationPossessionFrameV1`)
//! possession proof: the device's own security-device-id + device-proof
//! public key, bound to a server-issued nonce and the enrollment authorization
//! extracted from an imported enrollment file, self-signed with the device's
//! Ed25519 private key. Backs `native_generate_device_registration_proof`.

use super::device_proof::{resolve_or_create_device_keypair, DeviceProofError};
use super::frames::{drp1_signed_prefix, encode_drp1, DeviceRegistrationPossessionFrameV1, DRP1_TOTAL_BYTES};
use super::security_device_id::{resolve_or_create_security_device_id, SecurityDeviceIdError};
use ed25519_dalek::Signer;
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

/// Generates and self-signs a fresh DRP1 frame. Returns the exact 185-byte
/// wire encoding, ready to submit to `completeDeviceRegistration`.
pub fn generate_device_registration_proof(
    app_data_dir: &Path,
    enrollment_auth_id: &str,
    device_registration_nonce: [u8; 32],
) -> Result<[u8; DRP1_TOTAL_BYTES], DeviceRegistrationProofError> {
    if !is_lowercase_hex32(enrollment_auth_id) {
        return Err(DeviceRegistrationProofError::InvalidEnrollmentAuthId);
    }
    let security_device_id = resolve_or_create_security_device_id(app_data_dir)
        .map_err(|_: SecurityDeviceIdError| DeviceRegistrationProofError::DeviceIdUnavailable)?;
    let signing_key = resolve_or_create_device_keypair(app_data_dir)
        .map_err(|_: DeviceProofError| DeviceRegistrationProofError::DeviceKeyUnavailable)?;
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
    Ok(encode_drp1(&frame))
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
        let nonce = [0x42u8; 32];
        let bytes = generate_device_registration_proof(&dir, "00112233445566778899aabbccddeeff", nonce).unwrap();
        assert_eq!(bytes.len(), DRP1_TOTAL_BYTES);

        let decoded = decode_drp1(&bytes).unwrap();
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
        let result = generate_device_registration_proof(&dir, "not-hex", [0u8; 32]);
        assert_eq!(result, Err(DeviceRegistrationProofError::InvalidEnrollmentAuthId));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reuses_the_same_device_identity_across_calls() {
        let dir = temp_dir();
        let a = generate_device_registration_proof(&dir, "00112233445566778899aabbccddeeff", [1u8; 32]).unwrap();
        let b = generate_device_registration_proof(&dir, "00112233445566778899aabbccddeeff", [2u8; 32]).unwrap();
        let decoded_a = decode_drp1(&a).unwrap();
        let decoded_b = decode_drp1(&b).unwrap();
        assert_eq!(decoded_a.security_device_id, decoded_b.security_device_id);
        assert_eq!(decoded_a.dev_proof_public_key, decoded_b.dev_proof_public_key);
        let _ = fs::remove_dir_all(&dir);
    }
}
