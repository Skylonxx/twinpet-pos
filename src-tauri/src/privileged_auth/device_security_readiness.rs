//! TPOS-R7 native enrollment gate — strong, read-only device security
//! readiness. Backs `native_get_device_security_readiness`, the single
//! canonical command the WebView uses to decide whether any staff session
//! (Quick PIN, Username/Password, restored session) may become usable.
//!
//! `READY` is reported only when every local prerequisite the native staff
//! session path needs before claim stamping holds, using the existing trusted
//! primitives (no duplicated security parsing):
//!  1. the security device id exists and decodes (`read_persisted_security_device_id`);
//!  2. the committed-fence device key loads and decrypts (`load_enrolled_device_keypair`);
//!  3. `verify_local_enrollment` succeeds (committed fence + schema, key/meta
//!     hash pins, generation / security-device-id / key-version / public-key bindings);
//!  4. the stored security device id equals the enrollment metadata's;
//!  5. `resolve_active_manifest_path` succeeds (canonical digest pinned by the
//!     committed fence, digest match, OKS1 decode, root signature, non-empty).
//!
//! `NOT_ENROLLED` is reported only for a genuinely clean directory
//! (`classify_directory_artifacts(.., None) == TrulyClean`). Anything else —
//! partial, corrupt, unknown-newer, mismatched, or unreadable authority
//! artifacts — is `INVALID_OR_INCOMPLETE` (fail closed).
//!
//! Strictly read-only: never creates a staff challenge, never touches the
//! pending-challenge / lockout / manifest / enrollment state, never writes a
//! file. The result is a bare enum; no path, native error string, hash, key
//! material or manifest byte crosses to the WebView.

use super::device_proof::load_enrolled_device_keypair;
use super::enrollment_meta::{
    classify_directory_artifacts, resolve_active_manifest_path, verify_local_enrollment,
    CleanArtifactClassification,
};
use super::security_device_id::read_persisted_security_device_id;
use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DeviceSecurityReadiness {
    Ready,
    NotEnrolled,
    InvalidOrIncomplete,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSecurityReadinessDto {
    pub readiness: DeviceSecurityReadiness,
}

pub fn device_security_readiness(root: &Path) -> DeviceSecurityReadiness {
    match fs::symlink_metadata(root) {
        // A never-created app data directory holds no authority at all.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return DeviceSecurityReadiness::NotEnrolled
        }
        Err(_) => return DeviceSecurityReadiness::InvalidOrIncomplete,
        Ok(meta) if !meta.is_dir() => return DeviceSecurityReadiness::InvalidOrIncomplete,
        Ok(_) => {}
    }

    if classify_directory_artifacts(root, None) == CleanArtifactClassification::TrulyClean {
        return DeviceSecurityReadiness::NotEnrolled;
    }

    if local_enrollment_fully_valid(root) {
        DeviceSecurityReadiness::Ready
    } else {
        DeviceSecurityReadiness::InvalidOrIncomplete
    }
}

/// Same prerequisite chain `prepare_staff_session_challenge_internal` and the
/// staff-session persist path enforce, evaluated without minting a challenge.
fn local_enrollment_fully_valid(root: &Path) -> bool {
    let stored_security_device_id = match read_persisted_security_device_id(root) {
        Ok(Some(id)) => id,
        _ => return false,
    };
    let signing_key = match load_enrolled_device_keypair(root) {
        Ok(key) => key,
        Err(_) => return false,
    };
    let enrollment = match verify_local_enrollment(root, &signing_key) {
        Ok(frame) => frame,
        Err(_) => return false,
    };
    if enrollment.security_device_id != stored_security_device_id {
        return false;
    }
    resolve_active_manifest_path(root).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::privileged_auth::device_proof::device_proof_key_path;
    use crate::privileged_auth::dpapi_envelope::dpapi_protect;
    use crate::privileged_auth::enrollment_meta::{
        commit_enrollment_metadata, compute_sha256_hex, digest_manifest_path, enrollment_fence_path,
        generation_meta_path, generation_proof_key_path, EnrollmentFenceState, EnrollmentMetaFrameV1,
        TEST_OAC_ROOT_SEED,
    };
    use crate::privileged_auth::frames::{
        encode_oks1, oks1_signed_prefix, OacKeyLifecycleStatus, OacKeysetManifestFrameV1,
        OacKeysetManifestKeyV1,
    };
    use crate::privileged_auth::security_device_id::{security_device_id_path, versioned_payload};
    use ed25519_dalek::{Signer, SigningKey};
    use rand::rngs::OsRng;
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    const GEN_HEX: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SEC_ID: [u8; 16] = [0x42u8; 16];

    fn temp_dir() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "twinpet-device-readiness-test-{}-{}-{}",
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

    /// Committed fence + generation key + metadata + security device id,
    /// built with the production commit path (no manifest yet).
    fn enroll(root: &Path) -> SigningKey {
        let dev_key = SigningKey::generate(&mut OsRng);
        fs::write(device_proof_key_path(root), dpapi_protect(&dev_key.to_bytes()).unwrap()).unwrap();
        fs::write(security_device_id_path(root), versioned_payload(&SEC_ID)).unwrap();
        let frame = EnrollmentMetaFrameV1 {
            enrollment_generation_id: [0xAAu8; 16],
            security_device_id: SEC_ID,
            device_key_version: 1,
            expected_public_key: dev_key.verifying_key().to_bytes(),
            branch_id: "B-HQ".to_string(),
        };
        commit_enrollment_metadata(root, &frame, 1000).unwrap();
        // Only the fence-selected generation key is authority; drop the legacy seed copy.
        fs::remove_file(device_proof_key_path(root)).unwrap();
        dev_key
    }

    fn signed_manifest_bytes(root_signer: &SigningKey, keys: usize) -> Vec<u8> {
        let server_key = SigningKey::generate(&mut OsRng);
        let unsigned = OacKeysetManifestFrameV1 {
            revocation_epoch: 0,
            generated_at_server_ms: 1000,
            keys: (0..keys)
                .map(|i| OacKeysetManifestKeyV1 {
                    signing_key_id: format!("oac-key-{i}"),
                    public_key: server_key.verifying_key().to_bytes(),
                    status: OacKeyLifecycleStatus::Active,
                    verify_until_server_ms: None,
                })
                .collect(),
            signature: [0u8; 64],
        };
        let prefix = oks1_signed_prefix(&unsigned).unwrap();
        let signature = root_signer.sign(&prefix).to_bytes();
        encode_oks1(&OacKeysetManifestFrameV1 { signature, ..unsigned }).unwrap()
    }

    fn read_fence(root: &Path) -> EnrollmentFenceState {
        serde_json::from_slice(&fs::read(enrollment_fence_path(root)).unwrap()).unwrap()
    }

    fn write_fence(root: &Path, fence: &EnrollmentFenceState) {
        fs::write(enrollment_fence_path(root), serde_json::to_vec_pretty(fence).unwrap()).unwrap();
    }

    /// Writes the manifest at its digest path and pins that digest in the fence.
    fn install_manifest(root: &Path, bytes: &[u8]) -> String {
        let sha = compute_sha256_hex(bytes);
        fs::write(digest_manifest_path(root, &sha), bytes).unwrap();
        let mut fence = read_fence(root);
        fence.manifest_sha256 = Some(sha.clone());
        write_fence(root, &fence);
        sha
    }

    fn ready_device() -> PathBuf {
        let root = temp_dir();
        enroll(&root);
        install_manifest(&root, &signed_manifest_bytes(&SigningKey::from_bytes(&TEST_OAC_ROOT_SEED), 1));
        assert_eq!(device_security_readiness(&root), DeviceSecurityReadiness::Ready);
        root
    }

    fn snapshot(root: &Path) -> BTreeMap<String, (Vec<u8>, std::time::SystemTime)> {
        fs::read_dir(root)
            .unwrap()
            .map(|e| {
                let e = e.unwrap();
                let meta = e.metadata().unwrap();
                (
                    e.file_name().to_string_lossy().into_owned(),
                    (fs::read(e.path()).unwrap_or_default(), meta.modified().unwrap()),
                )
            })
            .collect()
    }

    #[test]
    fn r7_readiness_01_truly_clean_device_is_not_enrolled() {
        let root = temp_dir();
        assert_eq!(device_security_readiness(&root), DeviceSecurityReadiness::NotEnrolled);
        // Unrelated non-authority content keeps it clean.
        fs::write(root.join("twinpet-compat-epoch-floor"), b"1").unwrap();
        fs::create_dir_all(root.join("durable")).unwrap();
        assert_eq!(device_security_readiness(&root), DeviceSecurityReadiness::NotEnrolled);
        // A never-created app data directory is clean too.
        let missing = root.join("never-created");
        assert_eq!(device_security_readiness(&missing), DeviceSecurityReadiness::NotEnrolled);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn r7_readiness_02_valid_enrollment_and_trusted_manifest_is_ready() {
        let root = ready_device();
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn r7_readiness_03_missing_security_device_id_is_not_ready() {
        let root = ready_device();
        fs::remove_file(security_device_id_path(&root)).unwrap();
        assert_eq!(device_security_readiness(&root), DeviceSecurityReadiness::InvalidOrIncomplete);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn r7_readiness_04_corrupt_or_unknown_newer_security_device_id_is_not_ready() {
        let root = ready_device();
        fs::write(security_device_id_path(&root), b"corrupt").unwrap();
        assert_eq!(device_security_readiness(&root), DeviceSecurityReadiness::InvalidOrIncomplete);

        let mut unknown_newer = versioned_payload(&SEC_ID);
        unknown_newer[0] = unknown_newer[0].wrapping_add(1);
        fs::write(security_device_id_path(&root), &unknown_newer).unwrap();
        assert_eq!(device_security_readiness(&root), DeviceSecurityReadiness::InvalidOrIncomplete);

        // A well-formed id that differs from the enrollment metadata's.
        fs::write(security_device_id_path(&root), versioned_payload(&[0x43u8; 16])).unwrap();
        assert_eq!(device_security_readiness(&root), DeviceSecurityReadiness::InvalidOrIncomplete);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn r7_readiness_05_key_present_but_fence_or_meta_missing_is_not_ready() {
        // Fence missing (key + meta + id remain): authority without a committed fence.
        let root = ready_device();
        fs::remove_file(enrollment_fence_path(&root)).unwrap();
        assert_eq!(device_security_readiness(&root), DeviceSecurityReadiness::InvalidOrIncomplete);
        let _ = fs::remove_dir_all(&root);

        // Metadata missing.
        let root = ready_device();
        fs::remove_file(generation_meta_path(&root, GEN_HEX)).unwrap();
        assert_eq!(device_security_readiness(&root), DeviceSecurityReadiness::InvalidOrIncomplete);
        let _ = fs::remove_dir_all(&root);

        // Fence not COMMITTED.
        let root = ready_device();
        let mut fence = read_fence(&root);
        fence.state = "PREPARED".to_string();
        write_fence(&root, &fence);
        assert_eq!(device_security_readiness(&root), DeviceSecurityReadiness::InvalidOrIncomplete);
        let _ = fs::remove_dir_all(&root);

        // Unknown-newer fence schema.
        let root = ready_device();
        let mut fence = read_fence(&root);
        fence.schema_version += 1;
        write_fence(&root, &fence);
        assert_eq!(device_security_readiness(&root), DeviceSecurityReadiness::InvalidOrIncomplete);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn r7_readiness_06_fence_hash_mismatch_is_not_ready() {
        let root = ready_device();
        let mut fence = read_fence(&root);
        fence.key_sha256 = "0".repeat(64);
        write_fence(&root, &fence);
        assert_eq!(device_security_readiness(&root), DeviceSecurityReadiness::InvalidOrIncomplete);
        let _ = fs::remove_dir_all(&root);

        let root = ready_device();
        let mut fence = read_fence(&root);
        fence.meta_sha256 = "0".repeat(64);
        write_fence(&root, &fence);
        assert_eq!(device_security_readiness(&root), DeviceSecurityReadiness::InvalidOrIncomplete);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn r7_readiness_07_metadata_key_public_key_binding_mismatch_is_not_ready() {
        // Generation key swapped for a different (validly encrypted) key whose
        // hash is re-pinned in the fence: only the public-key binding catches it.
        let root = ready_device();
        let other = SigningKey::generate(&mut OsRng);
        let other_cipher = dpapi_protect(&other.to_bytes()).unwrap();
        fs::write(generation_proof_key_path(&root, GEN_HEX), &other_cipher).unwrap();
        let mut fence = read_fence(&root);
        fence.key_sha256 = compute_sha256_hex(&other_cipher);
        write_fence(&root, &fence);
        assert_eq!(device_security_readiness(&root), DeviceSecurityReadiness::InvalidOrIncomplete);
        let _ = fs::remove_dir_all(&root);

        // Device-key-version binding.
        let root = ready_device();
        let mut fence = read_fence(&root);
        fence.device_key_version += 1;
        write_fence(&root, &fence);
        assert_eq!(device_security_readiness(&root), DeviceSecurityReadiness::InvalidOrIncomplete);
        let _ = fs::remove_dir_all(&root);

        // Security-device-id binding between fence and metadata.
        let root = ready_device();
        let mut fence = read_fence(&root);
        fence.security_device_id_hex = "43".repeat(16);
        write_fence(&root, &fence);
        assert_eq!(device_security_readiness(&root), DeviceSecurityReadiness::InvalidOrIncomplete);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn r7_readiness_08_manifest_missing_is_not_ready() {
        // Fence pins a digest whose file is absent.
        let root = ready_device();
        let sha = read_fence(&root).manifest_sha256.unwrap();
        fs::remove_file(digest_manifest_path(&root, &sha)).unwrap();
        assert_eq!(device_security_readiness(&root), DeviceSecurityReadiness::InvalidOrIncomplete);
        let _ = fs::remove_dir_all(&root);

        // Committed fence carries no manifest digest at all.
        let root = temp_dir();
        enroll(&root);
        assert_eq!(device_security_readiness(&root), DeviceSecurityReadiness::InvalidOrIncomplete);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn r7_readiness_09_manifest_digest_mismatch_is_not_ready() {
        let root = ready_device();
        let sha = read_fence(&root).manifest_sha256.unwrap();
        let mut bytes = fs::read(digest_manifest_path(&root, &sha)).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x01;
        fs::write(digest_manifest_path(&root, &sha), &bytes).unwrap();
        assert_eq!(device_security_readiness(&root), DeviceSecurityReadiness::InvalidOrIncomplete);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn r7_readiness_10_invalid_or_untrusted_manifest_is_not_ready() {
        // Signed by a key that is not the trusted root.
        let root = temp_dir();
        enroll(&root);
        install_manifest(&root, &signed_manifest_bytes(&SigningKey::generate(&mut OsRng), 1));
        assert_eq!(device_security_readiness(&root), DeviceSecurityReadiness::InvalidOrIncomplete);
        let _ = fs::remove_dir_all(&root);

        // Root-signed, then the signature tampered; the digest is re-pinned to
        // the tampered bytes so only the root-signature check can catch it.
        // (An empty-key manifest cannot even be encoded: encode_oks1 rejects it.)
        let root = temp_dir();
        enroll(&root);
        let mut tampered = signed_manifest_bytes(&SigningKey::from_bytes(&TEST_OAC_ROOT_SEED), 1);
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        install_manifest(&root, &tampered);
        assert_eq!(device_security_readiness(&root), DeviceSecurityReadiness::InvalidOrIncomplete);
        let _ = fs::remove_dir_all(&root);

        // Not an OKS1 frame at all (digest pinned correctly).
        let root = temp_dir();
        enroll(&root);
        install_manifest(&root, b"NOT_AN_OKS1_FRAME");
        assert_eq!(device_security_readiness(&root), DeviceSecurityReadiness::InvalidOrIncomplete);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn r7_readiness_11_check_is_read_only() {
        for root in [ready_device(), {
            let partial = temp_dir();
            enroll(&partial);
            partial
        }] {
            let before = snapshot(&root);
            for _ in 0..3 {
                let _ = device_security_readiness(&root);
            }
            assert_eq!(snapshot(&root), before, "readiness must not create, modify or delete any file");
            let _ = fs::remove_dir_all(&root);
        }

        // Source-level guard: the production half of this module never reaches
        // the staff-session challenge, lockout, or any write/mutation API.
        let source = include_str!("device_security_readiness.rs");
        let production: String = source
            .split("#[cfg(test)]")
            .next()
            .unwrap()
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        for forbidden in [
            "staff_session",
            "PENDING_CHALLENGE",
            "lockout",
            "fs::write",
            "fs::remove",
            "fs::rename",
            "fs::copy",
            "create_dir",
            "resolve_or_create",
            "persist_",
            "stage_",
            "commit_",
        ] {
            assert!(!production.contains(forbidden), "readiness production code must not reference `{forbidden}`");
        }
    }

    #[test]
    fn r7_readiness_dto_serializes_to_safe_screaming_snake_case() {
        let json = |r| serde_json::to_string(&DeviceSecurityReadinessDto { readiness: r }).unwrap();
        assert_eq!(json(DeviceSecurityReadiness::Ready), r#"{"readiness":"READY"}"#);
        assert_eq!(json(DeviceSecurityReadiness::NotEnrolled), r#"{"readiness":"NOT_ENROLLED"}"#);
        assert_eq!(
            json(DeviceSecurityReadiness::InvalidOrIncomplete),
            r#"{"readiness":"INVALID_OR_INCOMPLETE"}"#
        );
    }
}
