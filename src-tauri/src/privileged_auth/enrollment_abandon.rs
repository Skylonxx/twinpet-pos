//! TPOS-R7 — explicit abandon of a never-committed, staged-only INITIAL
//! enrollment generation. Backs `native_abandon_device_enrollment_staging`.
//!
//! `native_generate_device_registration_proof` creates (at most) the security
//! device id, one staged record and one generation proof key BEFORE the server
//! completion. When the server then returns a definitive pre-commit rejection,
//! those files are ephemeral staging material for a generation the server never
//! accepted — but `classify_directory_artifacts(.., None)` (correctly) reports
//! them as `PartialOrHistorical`, so readiness stays INVALID_OR_INCOMPLETE and
//! the terminal can never enroll again.
//!
//! This is deliberately NOT a classifier relaxation. It is one explicit,
//! generation-bound operation that succeeds only when the authority root holds
//! EXACTLY the staged set of the caller-named generation and nothing else:
//!  - every authority-relevant name (per `is_authority_relevant_name`) must be
//!    one of `twinpet-security-device-id`,
//!    `twinpet-device-enrollment-staged-<gen>.dpapi`,
//!    `twinpet-device-proof-key-<gen>.dpapi`, and a regular file;
//!    any fence, fence temp/orphan, generation metadata, digest manifest,
//!    legacy committed key/meta, temp, malformed or other-generation name
//!    refuses the abandon (so committed or ambiguous authority is never touched);
//!  - all three members must be present;
//!  - the staged record must decrypt, pass the schema check, name exactly this
//!    generation and the persisted security device id, and its seed must derive
//!    its recorded public key; the proof key must decrypt to the same seed.
//!
//! Only then are exactly those three files deleted (proof key, staged record,
//! security device id), and the result must re-classify as `TrulyClean`.
//! Non-authority entries (`durable\`, `twinpet-committed-epoch-floor`, any
//! other directory) are never read or touched. A root that already holds no
//! authority at all reports `AlreadyClean` without mutating anything.
//!
//! The security device id is removed because, with no committed local
//! enrollment, it is only the identity minted for this staged attempt (the
//! fresh-enrollment path requires a TrulyClean root — no id file — before its
//! server begin), and its presence alone keeps readiness non-clean.
//!
//! Errors are fixed codes only; no path, key, id or OS error crosses to the WebView.

use super::device_proof::decode_device_proof_key_plaintext;
use super::dpapi_envelope::dpapi_unprotect;
use super::enrollment_meta::{
    check_staged_enrollment_schema_version, classify_directory_artifacts,
    enrollment_staged_generation_path, generation_proof_key_path, is_authority_relevant_name,
    is_lowercase_hex32, CleanArtifactClassification, StagedEnrollmentFrameV1, FINALIZE_MUTEX,
};
use super::security_device_id::{
    read_persisted_security_device_id, security_device_id_path, SECURITY_DEVICE_ID_FILE_NAME,
};
use ed25519_dalek::SigningKey;
use serde::Serialize;
use std::fs;
use std::path::Path;
use zeroize::Zeroize;

const STAGED_PREFIX: &str = "twinpet-device-enrollment-staged-";
const PROOF_KEY_PREFIX: &str = "twinpet-device-proof-key-";
const DPAPI_SUFFIX: &str = ".dpapi";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AbandonStagedEnrollmentOutcome {
    /// The exact staged set was verified and deleted; the root is TrulyClean.
    Abandoned,
    /// The root held no authority artifact at all; nothing was changed.
    AlreadyClean,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AbandonStagedEnrollmentError {
    InvalidGenerationId,
    DirectoryUnreadable,
    /// Fence, metadata, manifest, legacy, temp/orphan, malformed or non-file authority entry.
    UnexpectedAuthorityArtifact,
    /// A staged record or proof key for another generation, or more than one generation.
    GenerationMismatch,
    /// One of security device id / staged record / proof key is missing.
    IncompleteStagedSet,
    /// The staged record or proof key failed to decrypt, parse or bind.
    StagedSetInvalid,
    Io,
    NotCleanAfterAbandon,
}

impl AbandonStagedEnrollmentError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidGenerationId => "ABANDON_INVALID_GENERATION_ID",
            Self::DirectoryUnreadable => "ABANDON_DIRECTORY_UNREADABLE",
            Self::UnexpectedAuthorityArtifact => "ABANDON_UNEXPECTED_AUTHORITY_ARTIFACT",
            Self::GenerationMismatch => "ABANDON_GENERATION_MISMATCH",
            Self::IncompleteStagedSet => "ABANDON_INCOMPLETE_STAGED_SET",
            Self::StagedSetInvalid => "ABANDON_STAGED_SET_INVALID",
            Self::Io => "ABANDON_IO_FAILED",
            Self::NotCleanAfterAbandon => "ABANDON_NOT_CLEAN_AFTER_ABANDON",
        }
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn generation_suffix<'a>(name: &'a str, prefix: &str) -> Option<&'a str> {
    name.strip_prefix(prefix)?.strip_suffix(DPAPI_SUFFIX)
}

/// Enumerates the authority root. Returns whether ANY authority artifact
/// exists, after enforcing that every authority entry is one of the three
/// staged-set members for `gen_hex`.
fn scan_staged_set(app_data_dir: &Path, gen_hex: &str) -> Result<bool, AbandonStagedEnrollmentError> {
    let entries = fs::read_dir(app_data_dir).map_err(|_| AbandonStagedEnrollmentError::DirectoryUnreadable)?;
    let mut sec_id = false;
    let mut staged = false;
    let mut key = false;
    for entry in entries {
        let entry = entry.map_err(|_| AbandonStagedEnrollmentError::DirectoryUnreadable)?;
        let file_name = entry.file_name();
        let name = file_name.to_str().ok_or(AbandonStagedEnrollmentError::UnexpectedAuthorityArtifact)?;
        if !is_authority_relevant_name(name) {
            continue;
        }
        let file_type = entry.file_type().map_err(|_| AbandonStagedEnrollmentError::DirectoryUnreadable)?;
        if !file_type.is_file() {
            return Err(AbandonStagedEnrollmentError::UnexpectedAuthorityArtifact);
        }
        if name == SECURITY_DEVICE_ID_FILE_NAME {
            sec_id = true;
        } else if let Some(gen) = generation_suffix(name, STAGED_PREFIX) {
            if !is_lowercase_hex32(gen) {
                return Err(AbandonStagedEnrollmentError::UnexpectedAuthorityArtifact);
            }
            if gen != gen_hex {
                return Err(AbandonStagedEnrollmentError::GenerationMismatch);
            }
            staged = true;
        } else if let Some(gen) = generation_suffix(name, PROOF_KEY_PREFIX) {
            if !is_lowercase_hex32(gen) {
                return Err(AbandonStagedEnrollmentError::UnexpectedAuthorityArtifact);
            }
            if gen != gen_hex {
                return Err(AbandonStagedEnrollmentError::GenerationMismatch);
            }
            key = true;
        } else {
            return Err(AbandonStagedEnrollmentError::UnexpectedAuthorityArtifact);
        }
    }
    let any = sec_id || staged || key;
    if any && !(sec_id && staged && key) {
        return Err(AbandonStagedEnrollmentError::IncompleteStagedSet);
    }
    Ok(any)
}

/// Cryptographically binds the three members to each other and to `gen_hex`.
fn verify_staged_set(app_data_dir: &Path, gen_hex: &str) -> Result<(), AbandonStagedEnrollmentError> {
    use AbandonStagedEnrollmentError::{Io, StagedSetInvalid};
    let sec_id = match read_persisted_security_device_id(app_data_dir) {
        Ok(Some(id)) => id,
        _ => return Err(StagedSetInvalid),
    };

    let staged_cipher = fs::read(enrollment_staged_generation_path(app_data_dir, gen_hex)).map_err(|_| Io)?;
    let mut staged_plain = dpapi_unprotect(&staged_cipher).map_err(|_| StagedSetInvalid)?;
    let parsed: Result<StagedEnrollmentFrameV1, _> = serde_json::from_slice(&staged_plain);
    staged_plain.zeroize();
    let mut staged = parsed.map_err(|_| StagedSetInvalid)?;
    let staged_ok = check_staged_enrollment_schema_version(staged.schema_version).is_ok()
        && staged.enrollment_generation_id_hex == gen_hex
        && staged.security_device_id_hex == hex_lower(&sec_id);
    let mut staged_seed = [0u8; 32];
    let seed_ok = staged.private_key_seed_hex.len() == 64
        && (0..32).all(|i| match u8::from_str_radix(&staged.private_key_seed_hex[i * 2..i * 2 + 2], 16) {
            Ok(b) => {
                staged_seed[i] = b;
                true
            }
            Err(_) => false,
        });
    let staged_public_hex = std::mem::take(&mut staged.public_key_hex);
    staged.private_key_seed_hex.zeroize();
    if !staged_ok || !seed_ok {
        staged_seed.zeroize();
        return Err(StagedSetInvalid);
    }
    let derived_public = SigningKey::from_bytes(&staged_seed).verifying_key().to_bytes();
    if hex_lower(&derived_public) != staged_public_hex {
        staged_seed.zeroize();
        return Err(StagedSetInvalid);
    }

    let key_cipher = match fs::read(generation_proof_key_path(app_data_dir, gen_hex)) {
        Ok(b) => b,
        Err(_) => {
            staged_seed.zeroize();
            return Err(Io);
        }
    };
    let key_result = dpapi_unprotect(&key_cipher).map_err(|_| StagedSetInvalid).and_then(|mut plain| {
        let seed = decode_device_proof_key_plaintext(&plain).map_err(|_| StagedSetInvalid);
        plain.zeroize();
        seed
    });
    let mut key_seed = match key_result {
        Ok(seed) => seed,
        Err(e) => {
            staged_seed.zeroize();
            return Err(e);
        }
    };
    let same = key_seed == staged_seed;
    key_seed.zeroize();
    staged_seed.zeroize();
    if same {
        Ok(())
    } else {
        Err(StagedSetInvalid)
    }
}

/// See the module documentation. Serialized with native finalize.
pub fn abandon_staged_initial_enrollment(
    app_data_dir: &Path,
    enrollment_generation_id_hex: &str,
) -> Result<AbandonStagedEnrollmentOutcome, AbandonStagedEnrollmentError> {
    if !is_lowercase_hex32(enrollment_generation_id_hex) {
        return Err(AbandonStagedEnrollmentError::InvalidGenerationId);
    }
    let _lock = FINALIZE_MUTEX.lock().map_err(|_| AbandonStagedEnrollmentError::Io)?;

    if !scan_staged_set(app_data_dir, enrollment_generation_id_hex)? {
        return if classify_directory_artifacts(app_data_dir, None) == CleanArtifactClassification::TrulyClean {
            Ok(AbandonStagedEnrollmentOutcome::AlreadyClean)
        } else {
            Err(AbandonStagedEnrollmentError::NotCleanAfterAbandon)
        };
    }
    verify_staged_set(app_data_dir, enrollment_generation_id_hex)?;

    // Most sensitive first. A failure part-way leaves a non-clean root
    // (readiness stays INVALID_OR_INCOMPLETE) — never a falsely clean one.
    for path in [
        generation_proof_key_path(app_data_dir, enrollment_generation_id_hex),
        enrollment_staged_generation_path(app_data_dir, enrollment_generation_id_hex),
        security_device_id_path(app_data_dir),
    ] {
        fs::remove_file(&path).map_err(|_| AbandonStagedEnrollmentError::Io)?;
    }

    if classify_directory_artifacts(app_data_dir, None) == CleanArtifactClassification::TrulyClean {
        Ok(AbandonStagedEnrollmentOutcome::Abandoned)
    } else {
        Err(AbandonStagedEnrollmentError::NotCleanAfterAbandon)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::privileged_auth::device_security_readiness::{device_security_readiness, DeviceSecurityReadiness};
    use crate::privileged_auth::dpapi_envelope::dpapi_protect;
    use crate::privileged_auth::enrollment_meta::{
        digest_manifest_path, enrollment_fence_path, generation_meta_path, stage_device_enrollment,
        STAGED_ENROLLMENT_SCHEMA_VERSION,
    };
    use crate::privileged_auth::security_device_id::resolve_or_create_security_device_id;
    use rand::rngs::OsRng;
    use std::path::PathBuf;

    fn temp_dir() -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "twinpet-abandon-test-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
            n
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Exactly what a fresh first-enrollment proof leaves behind, plus the
    /// non-authority neighbours that must survive untouched.
    fn staged_only(dir: &Path) -> String {
        fs::create_dir_all(dir.join("durable")).unwrap();
        fs::write(dir.join("durable").join("store.sqlite"), b"db").unwrap();
        fs::write(dir.join("twinpet-committed-epoch-floor"), b"floor").unwrap();
        let sec_id = resolve_or_create_security_device_id(dir).unwrap();
        let signing_key = SigningKey::generate(&mut OsRng);
        stage_device_enrollment(dir, sec_id, &signing_key).unwrap().enrollment_generation_id_hex
    }

    fn assert_untouched_staged_set(dir: &Path, gen: &str) {
        assert!(security_device_id_path(dir).exists());
        assert!(enrollment_staged_generation_path(dir, gen).exists());
        assert!(generation_proof_key_path(dir, gen).exists());
        assert_eq!(device_security_readiness(dir), DeviceSecurityReadiness::InvalidOrIncomplete);
    }

    fn other_gen(gen: &str) -> String {
        if gen == "11111111111111111111111111111111" {
            "22222222222222222222222222222222".to_string()
        } else {
            "11111111111111111111111111111111".to_string()
        }
    }

    #[test]
    fn exact_staged_only_set_is_abandoned_to_truly_clean_not_enrolled() {
        let dir = temp_dir();
        let gen = staged_only(&dir);
        assert_eq!(device_security_readiness(&dir), DeviceSecurityReadiness::InvalidOrIncomplete);

        assert_eq!(abandon_staged_initial_enrollment(&dir, &gen), Ok(AbandonStagedEnrollmentOutcome::Abandoned));

        assert!(!security_device_id_path(&dir).exists());
        assert!(!enrollment_staged_generation_path(&dir, &gen).exists());
        assert!(!generation_proof_key_path(&dir, &gen).exists());
        assert_eq!(fs::read(dir.join("durable").join("store.sqlite")).unwrap(), b"db");
        assert_eq!(fs::read(dir.join("twinpet-committed-epoch-floor")).unwrap(), b"floor");
        assert_eq!(classify_directory_artifacts(&dir, None), CleanArtifactClassification::TrulyClean);
        assert_eq!(device_security_readiness(&dir), DeviceSecurityReadiness::NotEnrolled);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_root_with_no_authority_reports_already_clean_without_mutation() {
        let dir = temp_dir();
        fs::write(dir.join("twinpet-committed-epoch-floor"), b"floor").unwrap();
        assert_eq!(
            abandon_staged_initial_enrollment(&dir, "0123456789abcdef0123456789abcdef"),
            Ok(AbandonStagedEnrollmentOutcome::AlreadyClean)
        );
        assert_eq!(fs::read(dir.join("twinpet-committed-epoch-floor")).unwrap(), b"floor");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_malformed_or_uppercase_generation_id_is_refused() {
        let dir = temp_dir();
        let gen = staged_only(&dir);
        for bad in ["", "not-hex", &gen.to_uppercase(), &gen[..31]] {
            assert_eq!(
                abandon_staged_initial_enrollment(&dir, bad),
                Err(AbandonStagedEnrollmentError::InvalidGenerationId)
            );
        }
        assert_untouched_staged_set(&dir, &gen);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_wrong_generation_id_is_refused() {
        let dir = temp_dir();
        let gen = staged_only(&dir);
        assert_eq!(
            abandon_staged_initial_enrollment(&dir, &other_gen(&gen)),
            Err(AbandonStagedEnrollmentError::GenerationMismatch)
        );
        assert_untouched_staged_set(&dir, &gen);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_staged_record_is_refused() {
        let dir = temp_dir();
        let gen = staged_only(&dir);
        fs::remove_file(enrollment_staged_generation_path(&dir, &gen)).unwrap();
        assert_eq!(
            abandon_staged_initial_enrollment(&dir, &gen),
            Err(AbandonStagedEnrollmentError::IncompleteStagedSet)
        );
        assert!(security_device_id_path(&dir).exists());
        assert!(generation_proof_key_path(&dir, &gen).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_proof_key_is_refused() {
        let dir = temp_dir();
        let gen = staged_only(&dir);
        fs::remove_file(generation_proof_key_path(&dir, &gen)).unwrap();
        assert_eq!(
            abandon_staged_initial_enrollment(&dir, &gen),
            Err(AbandonStagedEnrollmentError::IncompleteStagedSet)
        );
        assert!(security_device_id_path(&dir).exists());
        assert!(enrollment_staged_generation_path(&dir, &gen).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_security_device_id_is_refused() {
        let dir = temp_dir();
        let gen = staged_only(&dir);
        fs::remove_file(security_device_id_path(&dir)).unwrap();
        assert_eq!(
            abandon_staged_initial_enrollment(&dir, &gen),
            Err(AbandonStagedEnrollmentError::IncompleteStagedSet)
        );
        assert!(enrollment_staged_generation_path(&dir, &gen).exists());
        assert!(generation_proof_key_path(&dir, &gen).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_security_device_id_alone_is_refused() {
        let dir = temp_dir();
        resolve_or_create_security_device_id(&dir).unwrap();
        assert_eq!(
            abandon_staged_initial_enrollment(&dir, "0123456789abcdef0123456789abcdef"),
            Err(AbandonStagedEnrollmentError::IncompleteStagedSet)
        );
        assert!(security_device_id_path(&dir).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn multiple_staged_generations_are_refused() {
        let dir = temp_dir();
        let gen = staged_only(&dir);
        let sec_id = read_persisted_security_device_id(&dir).unwrap().unwrap();
        let second = stage_device_enrollment(&dir, sec_id, &SigningKey::generate(&mut OsRng))
            .unwrap()
            .enrollment_generation_id_hex;
        for target in [&gen, &second] {
            assert_eq!(
                abandon_staged_initial_enrollment(&dir, target),
                Err(AbandonStagedEnrollmentError::GenerationMismatch)
            );
        }
        assert_untouched_staged_set(&dir, &gen);
        assert!(enrollment_staged_generation_path(&dir, &second).exists());
        assert!(generation_proof_key_path(&dir, &second).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_proof_key_for_another_generation_is_refused() {
        let dir = temp_dir();
        let gen = staged_only(&dir);
        let other = other_gen(&gen);
        fs::copy(generation_proof_key_path(&dir, &gen), generation_proof_key_path(&dir, &other)).unwrap();
        assert_eq!(
            abandon_staged_initial_enrollment(&dir, &gen),
            Err(AbandonStagedEnrollmentError::GenerationMismatch)
        );
        assert_untouched_staged_set(&dir, &gen);
        let _ = fs::remove_dir_all(&dir);
    }

    /// Each committed / in-flight / historical authority shape refuses the abandon and is left intact.
    #[test]
    fn any_committed_or_unrelated_authority_artifact_is_refused() {
        let cases: Vec<(&str, Box<dyn Fn(&Path, &str) -> PathBuf>)> = vec![
            ("fence", Box::new(|d, _| enrollment_fence_path(d))),
            ("fence tmp", Box::new(|d, _| d.join("twinpet-device-enrollment.fence.tmp"))),
            ("orphan fence", Box::new(|d, _| d.join("orphan-fence-1"))),
            ("committed metadata", Box::new(|d, g| generation_meta_path(d, g))),
            ("legacy metadata", Box::new(|d, _| d.join("twinpet-device-enrollment-meta.dpapi"))),
            ("legacy proof key", Box::new(|d, _| d.join("twinpet-device-proof-key.dpapi"))),
            (
                "digest manifest",
                Box::new(|d, _| digest_manifest_path(d, &"ab".repeat(32))),
            ),
            ("staged temp", Box::new(|d, g| d.join(format!("staged-{g}-1.tmp")))),
            ("key temp", Box::new(|d, g| d.join(format!("key-{g}-1.tmp")))),
            ("security id temp", Box::new(|d, _| d.join("twinpet-security-device-id.tmp"))),
            ("malformed staged", Box::new(|d, _| d.join("twinpet-device-enrollment-staged-XYZ.dpapi"))),
            ("unknown device artifact", Box::new(|d, _| d.join("twinpet-device-something"))),
        ];
        for (label, path_for) in cases {
            let dir = temp_dir();
            let gen = staged_only(&dir);
            let extra = path_for(&dir, &gen);
            fs::write(&extra, b"x").unwrap();
            assert_eq!(
                abandon_staged_initial_enrollment(&dir, &gen),
                Err(AbandonStagedEnrollmentError::UnexpectedAuthorityArtifact),
                "{label}"
            );
            assert!(extra.exists(), "{label}: the extra artifact must not be touched");
            assert_untouched_staged_set(&dir, &gen);
            let _ = fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn an_authority_named_directory_is_refused() {
        let dir = temp_dir();
        let gen = staged_only(&dir);
        fs::create_dir_all(dir.join("twinpet-device-enrollment.fence")).unwrap();
        assert_eq!(
            abandon_staged_initial_enrollment(&dir, &gen),
            Err(AbandonStagedEnrollmentError::UnexpectedAuthorityArtifact)
        );
        assert_untouched_staged_set(&dir, &gen);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_staged_record_bound_to_another_security_device_id_is_refused() {
        let dir = temp_dir();
        let gen = staged_only(&dir);
        fs::write(security_device_id_path(&dir), crate::privileged_auth::security_device_id::versioned_payload(&[0x11; 16]))
            .unwrap();
        assert_eq!(
            abandon_staged_initial_enrollment(&dir, &gen),
            Err(AbandonStagedEnrollmentError::StagedSetInvalid)
        );
        assert!(security_device_id_path(&dir).exists());
        assert!(enrollment_staged_generation_path(&dir, &gen).exists());
        assert!(generation_proof_key_path(&dir, &gen).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_proof_key_that_does_not_match_the_staged_seed_is_refused() {
        let dir = temp_dir();
        let gen = staged_only(&dir);
        let foreign = dpapi_protect(&crate::privileged_auth::device_proof::versioned_key_payload(
            &SigningKey::generate(&mut OsRng).to_bytes(),
        ))
        .unwrap();
        fs::write(generation_proof_key_path(&dir, &gen), foreign).unwrap();
        assert_eq!(
            abandon_staged_initial_enrollment(&dir, &gen),
            Err(AbandonStagedEnrollmentError::StagedSetInvalid)
        );
        assert_untouched_staged_set(&dir, &gen);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_or_unknown_schema_staged_record_is_refused() {
        // Corrupt ciphertext.
        let dir = temp_dir();
        let gen = staged_only(&dir);
        fs::write(enrollment_staged_generation_path(&dir, &gen), b"not-dpapi").unwrap();
        assert_eq!(
            abandon_staged_initial_enrollment(&dir, &gen),
            Err(AbandonStagedEnrollmentError::StagedSetInvalid)
        );
        assert_untouched_staged_set(&dir, &gen);
        let _ = fs::remove_dir_all(&dir);

        // Unknown newer schema version.
        let dir = temp_dir();
        let gen = staged_only(&dir);
        let path = enrollment_staged_generation_path(&dir, &gen);
        let mut frame: StagedEnrollmentFrameV1 =
            serde_json::from_slice(&dpapi_unprotect(&fs::read(&path).unwrap()).unwrap()).unwrap();
        frame.schema_version = STAGED_ENROLLMENT_SCHEMA_VERSION + 1;
        fs::write(&path, dpapi_protect(&serde_json::to_vec(&frame).unwrap()).unwrap()).unwrap();
        assert_eq!(
            abandon_staged_initial_enrollment(&dir, &gen),
            Err(AbandonStagedEnrollmentError::StagedSetInvalid)
        );
        assert_untouched_staged_set(&dir, &gen);
        let _ = fs::remove_dir_all(&dir);
    }

    /// Opens `path` readable by others but NOT deletable (FILE_SHARE_READ only).
    #[cfg(windows)]
    fn hold_undeletable(path: &Path) -> fs::File {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x1;
        fs::OpenOptions::new().read(true).share_mode(FILE_SHARE_READ).open(path).unwrap()
    }

    /// The first delete (proof key) fails: nothing is removed, never reported clean.
    #[cfg(windows)]
    #[test]
    fn an_io_failure_on_the_first_delete_fails_closed_without_mutation() {
        let dir = temp_dir();
        let gen = staged_only(&dir);
        let held = hold_undeletable(&generation_proof_key_path(&dir, &gen));
        assert_eq!(abandon_staged_initial_enrollment(&dir, &gen), Err(AbandonStagedEnrollmentError::Io));
        drop(held);
        assert_untouched_staged_set(&dir, &gen);
        // Once the handle is released the same exact abandon succeeds.
        assert_eq!(abandon_staged_initial_enrollment(&dir, &gen), Ok(AbandonStagedEnrollmentOutcome::Abandoned));
        assert_eq!(device_security_readiness(&dir), DeviceSecurityReadiness::NotEnrolled);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A later delete fails part-way: the root stays non-clean (INVALID_OR_INCOMPLETE)
    /// and a retry refuses the now-incomplete set — fail closed, never falsely clean.
    #[cfg(windows)]
    #[test]
    fn an_io_failure_part_way_leaves_a_non_clean_root_and_is_not_resumed() {
        let dir = temp_dir();
        let gen = staged_only(&dir);
        let held = hold_undeletable(&enrollment_staged_generation_path(&dir, &gen));
        assert_eq!(abandon_staged_initial_enrollment(&dir, &gen), Err(AbandonStagedEnrollmentError::Io));
        drop(held);
        assert!(!generation_proof_key_path(&dir, &gen).exists());
        assert!(enrollment_staged_generation_path(&dir, &gen).exists());
        assert!(security_device_id_path(&dir).exists());
        assert_eq!(device_security_readiness(&dir), DeviceSecurityReadiness::InvalidOrIncomplete);
        assert_eq!(
            abandon_staged_initial_enrollment(&dir, &gen),
            Err(AbandonStagedEnrollmentError::IncompleteStagedSet)
        );
        assert_eq!(device_security_readiness(&dir), DeviceSecurityReadiness::InvalidOrIncomplete);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_second_abandon_after_success_reports_already_clean() {
        let dir = temp_dir();
        let gen = staged_only(&dir);
        assert_eq!(abandon_staged_initial_enrollment(&dir, &gen), Ok(AbandonStagedEnrollmentOutcome::Abandoned));
        assert_eq!(abandon_staged_initial_enrollment(&dir, &gen), Ok(AbandonStagedEnrollmentOutcome::AlreadyClean));
        let _ = fs::remove_dir_all(&dir);
    }
}
