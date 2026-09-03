//! SEC-001 Packet C-A — imports an ENR1 enrollment file exported by the
//! Admin Issuance Console. Per D17, the POS terminal is not a trust anchor
//! for this frame — it only extracts the fields it needs to build its own
//! DRP1 possession proof; the server is what authoritatively re-validates
//! the enrollment authorization (and, server-side, the frame's signature) at
//! `completeDeviceRegistration` time. Backs `native_import_device_enrollment_file`.

use super::frames::decode_enr1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedEnrollment {
    pub enrollment_auth_id: String,
    pub branch_id: String,
    pub issued_at_server_ms: u64,
    pub expires_at_server_ms: u64,
    pub issuer_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnrollmentImportError {
    Malformed,
    /// Best-effort local clock check only — the server re-validates
    /// authoritatively at registration time regardless of this check.
    LocallyExpired,
}

/// Parses raw enrollment-file bytes. `now_ms` is the caller's local clock
/// (best-effort only, per D17 — not a substitute for server re-validation).
pub fn import_enrollment_file(file_bytes: &[u8], now_ms: u64) -> Result<ImportedEnrollment, EnrollmentImportError> {
    let frame = decode_enr1(file_bytes).map_err(|_| EnrollmentImportError::Malformed)?;
    if now_ms > frame.expires_at_server_ms {
        return Err(EnrollmentImportError::LocallyExpired);
    }
    Ok(ImportedEnrollment {
        enrollment_auth_id: frame.enrollment_auth_id,
        branch_id: frame.branch_id,
        issued_at_server_ms: frame.issued_at_server_ms,
        expires_at_server_ms: frame.expires_at_server_ms,
        issuer_id: frame.issuer_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::privileged_auth::frames::{encode_enr1, EnrollmentProofFrameV1};

    fn sample_enr1(expires_at_server_ms: u64) -> Vec<u8> {
        encode_enr1(&EnrollmentProofFrameV1 {
            enrollment_auth_id: "00112233445566778899aabbccddeeff".to_string(),
            branch_id: "LDP-001".to_string(),
            issued_at_server_ms: 1000,
            expires_at_server_ms,
            issuer_id: "issuer-1".to_string(),
            signature: [0x07; 64],
        })
        .unwrap()
    }

    #[test]
    fn imports_a_well_formed_unexpired_file() {
        let bytes = sample_enr1(10_000);
        let imported = import_enrollment_file(&bytes, 5000).unwrap();
        assert_eq!(imported.enrollment_auth_id, "00112233445566778899aabbccddeeff");
        assert_eq!(imported.branch_id, "LDP-001");
        assert_eq!(imported.issuer_id, "issuer-1");
    }

    #[test]
    fn rejects_malformed_bytes() {
        assert_eq!(import_enrollment_file(b"not an enrollment file", 0), Err(EnrollmentImportError::Malformed));
    }

    #[test]
    fn rejects_a_locally_expired_file() {
        let bytes = sample_enr1(1000);
        assert_eq!(import_enrollment_file(&bytes, 5000), Err(EnrollmentImportError::LocallyExpired));
    }
}
