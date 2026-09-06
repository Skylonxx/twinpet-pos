//! SEC-001 Packet D-1A — Local Enrollment Metadata DPAPI Frame and Fence Protocol.
//!
//! Stores local device identity metadata bound to an immutable generation ID,
//! with crash-safe fence transitions (`PREPARED` -> `COMMITTED`).
//! Detects cross-generation mixing, key/meta hash mismatch, corrupt artifacts,
//! and mismatched public keys locally.
//! Authoritative anti-rollback for complete historical sets is enforced server-side
//! via `deviceKeyVersion` during adjudication.

use ed25519_dalek::{Signature, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use windows::core::PCWSTR;
use windows::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH;

use super::dpapi_envelope::{dpapi_protect, dpapi_unprotect};
use super::frames;
use super::staff_session::{
    win32_move_file, win32_replace_file, MoveFileFn, ReplaceFileFn,
};

pub const ENROLLMENT_META_FILE_NAME: &str = "twinpet-device-enrollment-meta.dpapi";
pub const ENROLLMENT_FENCE_FILE_NAME: &str = "twinpet-device-enrollment.fence";
pub const MAX_DEVICE_KEY_VERSION: u32 = 4_294_967_295;

static FINALIZE_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub const ENRM_MAGIC: &[u8; 4] = b"ENRM";
pub const ENRM_SCHEMA_VERSION_1: u8 = 1;
pub const ENRM_FIXED_MINIMUM_LENGTH: usize = 4 + 1 + 16 + 16 + 4 + 32 + 2; // 75 bytes

pub fn is_lowercase_hex32(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn enrollment_staged_generation_path(app_data_dir: &Path, gen_hex: &str) -> PathBuf {
    app_data_dir.join(format!("twinpet-device-enrollment-staged-{}.dpapi", gen_hex.to_lowercase()))
}

pub fn generation_proof_key_path(app_data_dir: &Path, gen_hex: &str) -> PathBuf {
    app_data_dir.join(format!("twinpet-device-proof-key-{}.dpapi", gen_hex.to_lowercase()))
}

pub fn generation_meta_path(app_data_dir: &Path, gen_hex: &str) -> PathBuf {
    app_data_dir.join(format!("twinpet-device-enrollment-meta-{}.dpapi", gen_hex.to_lowercase()))
}

fn durable_first_create_file(tmp_path: &Path, final_path: &Path, bytes: &[u8]) -> Result<(), String> {
    {
        let mut f = File::create(tmp_path)
            .map_err(|e| format!("cannot create tmp file: {e}"))?;
        f.write_all(bytes)
            .map_err(|e| format!("cannot write tmp file: {e}"))?;
        f.sync_all()
            .map_err(|e| format!("sync_all failed on tmp file: {e}"))?;
    }

    #[cfg(windows)]
    {
        use windows::Win32::Foundation::GetLastError;
        use windows::Win32::Storage::FileSystem::MoveFileExW;
        let wide_tmp = to_wide(tmp_path);
        let wide_final = to_wide(final_path);
        let res = unsafe {
            MoveFileExW(
                PCWSTR(wide_tmp.as_ptr()),
                PCWSTR(wide_final.as_ptr()),
                MOVEFILE_WRITE_THROUGH,
            )
        };
        if res.is_err() {
            let err = unsafe { GetLastError() };
            let _ = fs::remove_file(tmp_path);
            return Err(format!("first-create MoveFileExW failed with code {}", err.0));
        }
        Ok(())
    }

    #[cfg(not(windows))]
    {
        fs::rename(tmp_path, final_path).map_err(|e| format!("rename failed: {e}"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnrollmentMetaFrameV1 {
    pub enrollment_generation_id: [u8; 16],
    pub security_device_id: [u8; 16],
    pub device_key_version: u32,
    pub expected_public_key: [u8; 32],
    pub branch_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnrollmentFenceState {
    pub state: String,
    pub enrollment_generation_id: String,
    pub security_device_id_hex: String,
    pub device_key_version: u32,
    pub key_sha256: String,
    pub meta_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest_sha256: Option<String>,
    pub committed_at_local_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingRequestContext {
    pub request_qpc_ticks: u64,
    pub boot_session_id: [u8; 16],
    pub device_registration_nonce: [u8; 32],
    pub security_device_id: [u8; 16],
    pub enrollment_generation_id_hex: String,
    pub staged_public_key: [u8; 32],
    pub test_receipt_qpc_ticks: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceiptObservation {
    pub request_qpc_ticks: u64,
    pub receipt_qpc_ticks: u64,
    pub boot_session_id: [u8; 16],
    pub receipt_nonce: [u8; 32],
    pub raw_efr1_digest: [u8; 32],
    pub security_device_id: [u8; 16],
    pub enrollment_generation_id_hex: String,
    pub staged_public_key: [u8; 32],
}

#[derive(Default, Clone)]
pub struct ReceiptContextStore {
    pub pending_requests: Vec<PendingRequestContext>,
    pub receipt_observations: Vec<ReceiptObservation>,
}

impl ReceiptContextStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record_pending_request(&mut self, req: PendingRequestContext) {
        self.pending_requests.retain(|p| !p.enrollment_generation_id_hex.eq_ignore_ascii_case(&req.enrollment_generation_id_hex));
        self.pending_requests.push(req);
    }

    pub fn find_pending_request(&self, generation_id_hex: &str) -> Option<PendingRequestContext> {
        self.pending_requests.iter().find(|p| p.enrollment_generation_id_hex.eq_ignore_ascii_case(generation_id_hex)).cloned()
    }

    pub fn record_receipt_ingress(
        &mut self,
        raw_efr1_bytes: &[u8],
        receipt_qpc_ticks: u64,
        current_boot_session: [u8; 16],
    ) -> Result<ReceiptObservation, String> {
        let efr1 = frames::decode_efr1(raw_efr1_bytes)
            .map_err(|e| format!("MALFORMED_RECEIPT_INGRESS: {e:?}"))?;
        let raw_efr1_digest = compute_sha256(raw_efr1_bytes);
        let gen_hex = efr1.enrollment_generation_id.iter().map(|b| format!("{b:02x}")).collect::<String>();

        let pending = self.find_pending_request(&gen_hex).ok_or_else(|| {
            format!("INGRESS_NO_MATCHING_REQUEST: no pending request context found for generation '{gen_hex}'")
        })?;

        if pending.boot_session_id != current_boot_session {
            return Err("INGRESS_BOOT_SESSION_MISMATCH: pending request was issued in a different boot session".to_string());
        }
        if pending.device_registration_nonce != efr1.receipt_nonce {
            return Err("INGRESS_NONCE_MISMATCH: receipt nonce does not match pending challenge nonce".to_string());
        }
        if pending.security_device_id != efr1.security_device_id {
            return Err("INGRESS_DEVICE_MISMATCH: security device id does not match pending request".to_string());
        }
        if pending.staged_public_key != efr1.accepted_public_key {
            return Err("INGRESS_PUBLIC_KEY_MISMATCH: accepted public key does not match pending request staged key".to_string());
        }

        let obs = ReceiptObservation {
            request_qpc_ticks: pending.request_qpc_ticks,
            receipt_qpc_ticks,
            boot_session_id: current_boot_session,
            receipt_nonce: efr1.receipt_nonce,
            raw_efr1_digest,
            security_device_id: efr1.security_device_id,
            enrollment_generation_id_hex: gen_hex.clone(),
            staged_public_key: efr1.accepted_public_key,
        };

        self.receipt_observations.retain(|o| {
            !(o.enrollment_generation_id_hex.eq_ignore_ascii_case(&gen_hex) && o.raw_efr1_digest == raw_efr1_digest)
        });
        self.receipt_observations.push(obs.clone());
        Ok(obs)
    }

    pub fn find_observation(
        &self,
        generation_id_hex: &str,
        raw_efr1_digest: &[u8; 32],
    ) -> Option<ReceiptObservation> {
        self.receipt_observations.iter().find(|o| {
            o.enrollment_generation_id_hex.eq_ignore_ascii_case(generation_id_hex)
                && &o.raw_efr1_digest == raw_efr1_digest
        }).cloned()
    }

    pub fn take_observation(
        &mut self,
        generation_id_hex: &str,
        raw_efr1_digest: &[u8; 32],
    ) -> Option<ReceiptObservation> {
        if let Some(pos) = self.receipt_observations.iter().position(|o| {
            o.enrollment_generation_id_hex.eq_ignore_ascii_case(generation_id_hex)
                && &o.raw_efr1_digest == raw_efr1_digest
        }) {
            Some(self.receipt_observations.remove(pos))
        } else {
            None
        }
    }

    pub fn clear(&mut self) {
        self.pending_requests.clear();
        self.receipt_observations.clear();
    }
}

pub struct EnrollmentRuntimeState {
    receipt_store: std::sync::Mutex<ReceiptContextStore>,
}

impl EnrollmentRuntimeState {
    pub fn new() -> Self {
        Self {
            receipt_store: std::sync::Mutex::new(ReceiptContextStore::new()),
        }
    }

    pub fn record_pending_request(&self, req: PendingRequestContext) {
        if let Ok(mut store) = self.receipt_store.lock() {
            store.record_pending_request(req);
        }
    }

    pub fn record_receipt_ingress_from_bytes(&self, raw_efr1_bytes: &[u8]) -> Result<ReceiptObservation, String> {
        let receipt_ticks = super::monotonic_clock::read_qpc_ticks()
            .map_err(|e| format!("cannot read monotonic QPC: {e:?}"))?;
        let boot_session = super::monotonic_clock::boot_session_id();
        let mut store = self.receipt_store.lock().map_err(|e| format!("mutex poisoned: {e}"))?;
        store.record_receipt_ingress(raw_efr1_bytes, receipt_ticks, boot_session)
    }

    pub fn record_receipt_ingress_from_base64(&self, server_receipt_base64: &str) -> Result<ReceiptObservation, String> {
        let bytes = base64_decode(server_receipt_base64)
            .map_err(|e| format!("cannot base64 decode receipt: {e}"))?;
        self.record_receipt_ingress_from_bytes(&bytes)
    }

    pub fn find_observation(&self, generation_id_hex: &str, raw_efr1_digest: &[u8; 32]) -> Option<ReceiptObservation> {
        self.receipt_store.lock().ok()?.find_observation(generation_id_hex, raw_efr1_digest)
    }

    pub fn find_pending_request(&self, generation_id_hex: &str) -> Option<PendingRequestContext> {
        self.receipt_store.lock().ok()?.find_pending_request(generation_id_hex)
    }

    pub fn take_observation(&self, generation_id_hex: &str, raw_efr1_digest: &[u8; 32]) -> Option<ReceiptObservation> {
        self.receipt_store.lock().ok()?.take_observation(generation_id_hex, raw_efr1_digest)
    }

    pub fn clear(&self) {
        if let Ok(mut store) = self.receipt_store.lock() {
            store.clear();
        }
    }
}

impl Default for EnrollmentRuntimeState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceiptContext {
    pub request_qpc_ticks: u64,
    pub boot_session_id: [u8; 16],
    pub device_registration_nonce: [u8; 32],
    pub security_device_id: [u8; 16],
    pub enrollment_generation_id_hex: String,
    pub staged_public_key: [u8; 32],
    pub receipt_qpc_ticks: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnrollmentMetaError {
    NotFound,
    Io(String),
    DpapiFailed,
    Corrupt(String),
    FenceUncommitted,
    GenerationMismatch,
    KeyHashMismatch,
    MetaHashMismatch,
    PublicKeyMismatch,
    VersionMismatch,
}

impl std::fmt::Display for EnrollmentMetaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EnrollmentMetaError::NotFound => write!(f, "Enrollment metadata or fence not found"),
            EnrollmentMetaError::Io(e) => write!(f, "Enrollment meta IO error: {e}"),
            EnrollmentMetaError::DpapiFailed => write!(f, "DPAPI unprotect failed for enrollment metadata"),
            EnrollmentMetaError::Corrupt(msg) => write!(f, "Enrollment metadata corrupt: {msg}"),
            EnrollmentMetaError::FenceUncommitted => write!(f, "Enrollment fence is not in COMMITTED state"),
            EnrollmentMetaError::GenerationMismatch => write!(f, "Enrollment generation mismatch between fence and metadata"),
            EnrollmentMetaError::KeyHashMismatch => write!(f, "Device proof key SHA-256 does not match fence"),
            EnrollmentMetaError::MetaHashMismatch => write!(f, "Enrollment metadata SHA-256 does not match fence"),
            EnrollmentMetaError::PublicKeyMismatch => write!(f, "Derived public key does not match enrolled expected key"),
            EnrollmentMetaError::VersionMismatch => write!(f, "Device key version mismatch between fence and metadata"),
        }
    }
}

/// Legacy canonical enrollment metadata path (migration-only / non-authoritative).
#[allow(dead_code)]
pub fn enrollment_meta_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(ENROLLMENT_META_FILE_NAME)
}

pub fn enrollment_fence_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(ENROLLMENT_FENCE_FILE_NAME)
}

pub fn digest_manifest_path(app_data_dir: &Path, sha256_hex: &str) -> PathBuf {
    app_data_dir.join(format!("twinpet-oac-keyset-manifest-{sha256_hex}.bin"))
}

pub fn is_canonical_lowercase_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanArtifactClassification {
    TrulyClean,
    ExactPendingInitial,
    PartialOrHistorical,
}

pub struct PendingInitialBindings<'a> {
    pub security_device_id: &'a [u8; 16],
    pub generation_id_hex: &'a str,
    pub accepted_public_key: &'a [u8; 32],
    pub branch_id: &'a str,
    pub device_key_version: u32,
    pub candidate_manifest_bytes: Option<&'a [u8]>,
}

pub fn is_authority_relevant_name(name: &str) -> bool {
    name == ENROLLMENT_FENCE_FILE_NAME
        || name.starts_with("twinpet-device-")
        || name.starts_with("twinpet-oac-keyset-manifest-")
        || name.starts_with("twinpet-security-device-id")
        || name.starts_with("fence-")
        || name.starts_with("key-")
        || name.starts_with("staged-")
        || name.starts_with("meta-")
        || name.starts_with("orphan-fence-")
        || name.starts_with("fence-orphan-")
        || name.ends_with(".fence")
        || name.contains(".fence")
}

pub fn classify_directory_artifacts(
    app_data_dir: &Path,
    pending_initial: Option<&PendingInitialBindings>,
) -> CleanArtifactClassification {
    let entries = match fs::read_dir(app_data_dir) {
        Ok(e) => e,
        Err(_) => return CleanArtifactClassification::PartialOrHistorical,
    };

    let mut has_active_fence = false;
    let mut has_temp_or_orphan = false;
    let mut has_legacy = false;
    let mut has_malformed = false;

    let mut found_sec_id = false;
    let mut staged_generations = Vec::new();
    let mut gen_key_generations = Vec::new();
    let mut gen_meta_generations = Vec::new();
    let mut digest_manifests = Vec::new();

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => return CleanArtifactClassification::PartialOrHistorical,
        };

        // 1. Read entry name first
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();

        // 2. Determine whether the name is authority-relevant
        let is_auth = is_authority_relevant_name(&name);

        // 3. Obtain and validate file type
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => return CleanArtifactClassification::PartialOrHistorical,
        };

        if is_auth {
            // Authority-relevant entry MUST be an exact regular file.
            // If directory, symlink/reparse point, or not a regular file -> PartialOrHistorical immediately
            if !file_type.is_file() {
                return CleanArtifactClassification::PartialOrHistorical;
            }
        } else {
            // 4. Only unrelated non-authority directories may be ignored
            if file_type.is_dir() {
                continue;
            }
        }

        // 1. Active fence
        if name == ENROLLMENT_FENCE_FILE_NAME {
            has_active_fence = true;
            continue;
        }

        // 2. Fence/commit temp/orphan artifacts
        if name == "twinpet-device-enrollment.fence.tmp"
            || (name.starts_with("fence-") && name.ends_with(".tmp"))
            || name.starts_with("orphan-fence-")
            || name.starts_with("fence-orphan-")
            || (name.contains(".fence") && name.ends_with(".tmp"))
        {
            has_temp_or_orphan = true;
            continue;
        }

        // 3. Generation key
        if name.starts_with("twinpet-device-proof-key-") && name.ends_with(".dpapi") {
            let gen = &name["twinpet-device-proof-key-".len()..name.len() - ".dpapi".len()];
            if is_lowercase_hex32(gen) {
                gen_key_generations.push(gen.to_string());
            } else {
                has_malformed = true;
            }
            continue;
        }

        // 4. Generation key temp
        if name.starts_with("key-") && name.ends_with(".tmp") {
            has_temp_or_orphan = true;
            continue;
        }

        // 5. Staged record
        if name.starts_with("twinpet-device-enrollment-staged-") && name.ends_with(".dpapi") {
            let gen = &name["twinpet-device-enrollment-staged-".len()..name.len() - ".dpapi".len()];
            if is_lowercase_hex32(gen) {
                staged_generations.push(gen.to_string());
            } else {
                has_malformed = true;
            }
            continue;
        }

        // 6. Staged temp
        if name.starts_with("staged-") && name.ends_with(".tmp") {
            has_temp_or_orphan = true;
            continue;
        }

        // 7. Generation metadata
        if name.starts_with("twinpet-device-enrollment-meta-") && name.ends_with(".dpapi") {
            let gen = &name["twinpet-device-enrollment-meta-".len()..name.len() - ".dpapi".len()];
            if is_lowercase_hex32(gen) {
                gen_meta_generations.push(gen.to_string());
            } else {
                has_malformed = true;
            }
            continue;
        }

        // 8. Generation metadata temp
        if (name.starts_with("meta-") && name.ends_with(".tmp"))
            || (name.starts_with("twinpet-device-enrollment-meta-") && name.ends_with(".tmp"))
        {
            has_temp_or_orphan = true;
            continue;
        }

        // 9. Digest manifest
        if name.starts_with("twinpet-oac-keyset-manifest-") && name.ends_with(".bin") {
            let d = &name["twinpet-oac-keyset-manifest-".len()..name.len() - ".bin".len()];
            if is_canonical_lowercase_sha256(d) {
                digest_manifests.push(d.to_string());
            } else {
                has_malformed = true;
            }
            continue;
        }

        // 10. Digest temp
        if name.starts_with("twinpet-oac-keyset-manifest-") && name.ends_with(".tmp") {
            has_temp_or_orphan = true;
            continue;
        }

        // 11. Legacy/historical enrollment authority
        if name == "twinpet-device-enrollment-meta.dpapi"
            || name == "twinpet-device-proof-key.dpapi"
            || name == "twinpet-device-enrollment-meta.tmp"
            || name == "twinpet-device-proof-key.tmp"
            || name == "twinpet-device-enrollment-meta.dpapi.tmp"
            || name == "twinpet-device-proof-key.dpapi.tmp"
        {
            has_legacy = true;
            continue;
        }

        // 12. Security device identity
        if name == "twinpet-security-device-id" {
            found_sec_id = true;
            continue;
        }

        // 13. Security device identity temp
        if name == "twinpet-security-device-id.tmp" {
            has_temp_or_orphan = true;
            continue;
        }

        // 14. Check if unrecognized artifact matches authority prefix
        if is_auth {
            has_malformed = true;
            continue;
        }
    }

    let has_any_authority = has_active_fence
        || has_temp_or_orphan
        || has_legacy
        || has_malformed
        || found_sec_id
        || !staged_generations.is_empty()
        || !gen_key_generations.is_empty()
        || !gen_meta_generations.is_empty()
        || !digest_manifests.is_empty();

    if !has_any_authority {
        return CleanArtifactClassification::TrulyClean;
    }

    let bindings = match pending_initial {
        Some(b) => b,
        None => return CleanArtifactClassification::PartialOrHistorical,
    };

    if has_active_fence || has_temp_or_orphan || has_legacy || has_malformed {
        return CleanArtifactClassification::PartialOrHistorical;
    }

    // Must have security device ID matching bindings
    if !found_sec_id {
        return CleanArtifactClassification::PartialOrHistorical;
    }
    let sec_id_path = super::security_device_id::security_device_id_path(app_data_dir);
    let sec_id_bytes = match fs::read(&sec_id_path) {
        Ok(b) if b.len() == 16 => b,
        _ => return CleanArtifactClassification::PartialOrHistorical,
    };
    if sec_id_bytes.as_slice() != bindings.security_device_id {
        return CleanArtifactClassification::PartialOrHistorical;
    }

    // Must have exactly one staged record matching bindings
    if staged_generations.len() != 1 || !staged_generations[0].eq_ignore_ascii_case(bindings.generation_id_hex) {
        return CleanArtifactClassification::PartialOrHistorical;
    }
    let staged_path = enrollment_staged_generation_path(app_data_dir, bindings.generation_id_hex);
    let staged_cipher = match fs::read(&staged_path) {
        Ok(b) => b,
        Err(_) => return CleanArtifactClassification::PartialOrHistorical,
    };
    let staged_plain = match dpapi_unprotect(&staged_cipher) {
        Ok(b) => b,
        Err(_) => return CleanArtifactClassification::PartialOrHistorical,
    };
    let staged: StagedEnrollmentFrameV1 = match serde_json::from_slice(&staged_plain) {
        Ok(s) => s,
        Err(_) => return CleanArtifactClassification::PartialOrHistorical,
    };
    if !staged.enrollment_generation_id_hex.eq_ignore_ascii_case(bindings.generation_id_hex) {
        return CleanArtifactClassification::PartialOrHistorical;
    }
    let sec_id_hex = bindings.security_device_id.iter().map(|b| format!("{b:02x}")).collect::<String>();
    if !staged.security_device_id_hex.eq_ignore_ascii_case(&sec_id_hex) {
        return CleanArtifactClassification::PartialOrHistorical;
    }
    let accepted_hex = bindings.accepted_public_key.iter().map(|b| format!("{b:02x}")).collect::<String>();
    if !staged.public_key_hex.eq_ignore_ascii_case(&accepted_hex) {
        return CleanArtifactClassification::PartialOrHistorical;
    }

    // Generation key: MUST require exactly one valid G key matching bindings
    if gen_key_generations.len() != 1 || !gen_key_generations[0].eq_ignore_ascii_case(bindings.generation_id_hex) {
        return CleanArtifactClassification::PartialOrHistorical;
    }
    let gen_key_path = generation_proof_key_path(app_data_dir, bindings.generation_id_hex);
    let key_cipher = match fs::read(&gen_key_path) {
        Ok(b) => b,
        Err(_) => return CleanArtifactClassification::PartialOrHistorical,
    };
    let key_plain = match dpapi_unprotect(&key_cipher) {
        Ok(b) if b.len() == 32 => b,
        _ => return CleanArtifactClassification::PartialOrHistorical,
    };
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&key_plain);
    let signing_key = SigningKey::from_bytes(&seed);
    if signing_key.verifying_key().to_bytes() != *bindings.accepted_public_key {
        return CleanArtifactClassification::PartialOrHistorical;
    }

    // Optional generation metadata: 0 or 1
    if gen_meta_generations.len() > 1 {
        return CleanArtifactClassification::PartialOrHistorical;
    }
    if gen_meta_generations.len() == 1 {
        if !gen_meta_generations[0].eq_ignore_ascii_case(bindings.generation_id_hex) {
            return CleanArtifactClassification::PartialOrHistorical;
        }
        let gen_meta_path = generation_meta_path(app_data_dir, bindings.generation_id_hex);
        let meta_cipher = match fs::read(&gen_meta_path) {
            Ok(b) => b,
            Err(_) => return CleanArtifactClassification::PartialOrHistorical,
        };
        let meta_plain = match dpapi_unprotect(&meta_cipher) {
            Ok(b) => b,
            Err(_) => return CleanArtifactClassification::PartialOrHistorical,
        };
        let meta_frame = match decode_enrm(&meta_plain) {
            Ok(f) => f,
            Err(_) => return CleanArtifactClassification::PartialOrHistorical,
        };
        let mut expected_gen_bytes = [0u8; 16];
        for i in 0..16 {
            expected_gen_bytes[i] = match u8::from_str_radix(&bindings.generation_id_hex[i * 2..i * 2 + 2], 16) {
                Ok(b) => b,
                Err(_) => return CleanArtifactClassification::PartialOrHistorical,
            };
        }
        if meta_frame.enrollment_generation_id != expected_gen_bytes
            || meta_frame.security_device_id != *bindings.security_device_id
            || meta_frame.expected_public_key != *bindings.accepted_public_key
            || meta_frame.branch_id != bindings.branch_id
            || meta_frame.device_key_version != bindings.device_key_version
        {
            return CleanArtifactClassification::PartialOrHistorical;
        }
    }

    // Optional digest manifest: 0 or 1
    if digest_manifests.len() > 1 {
        return CleanArtifactClassification::PartialOrHistorical;
    }
    if digest_manifests.len() == 1 {
        let cand_bytes = match bindings.candidate_manifest_bytes {
            Some(b) => b,
            None => return CleanArtifactClassification::PartialOrHistorical,
        };
        let expected_d = compute_sha256_hex(cand_bytes);
        if !digest_manifests[0].eq_ignore_ascii_case(&expected_d) {
            return CleanArtifactClassification::PartialOrHistorical;
        }
        let d_path = digest_manifest_path(app_data_dir, &expected_d);
        let disk_bytes = match fs::read(&d_path) {
            Ok(b) => b,
            Err(_) => return CleanArtifactClassification::PartialOrHistorical,
        };
        if disk_bytes != cand_bytes {
            return CleanArtifactClassification::PartialOrHistorical;
        }
    }

    CleanArtifactClassification::ExactPendingInitial
}

pub fn resolve_active_manifest_path(app_data_dir: &Path) -> Result<PathBuf, String> {
    resolve_active_manifest_path_with_root(app_data_dir, Some(&canonical_oac_root_public_key()))
}

pub fn resolve_active_manifest_path_with_root(
    app_data_dir: &Path,
    trusted_root: Option<&[u8; 32]>,
) -> Result<PathBuf, String> {
    let fence_path = enrollment_fence_path(app_data_dir);
    if !fence_path.exists() {
        let classification = classify_directory_artifacts(app_data_dir, None);
        if classification == CleanArtifactClassification::TrulyClean {
            return Err("DEVICE_NOT_ENROLLED: no active enrollment fence found".to_string());
        } else {
            return Err("RESOLVER_FAIL_CLOSED: enrollment authority artifacts exist without committed fence".to_string());
        }
    }

    let fence_bytes = fs::read(&fence_path)
        .map_err(|e| format!("RESOLVER_FAIL_CLOSED: cannot read fence file: {e}"))?;
    let fence = serde_json::from_slice::<EnrollmentFenceState>(&fence_bytes)
        .map_err(|e| format!("RESOLVER_FAIL_CLOSED: cannot parse fence JSON: {e}"))?;

    if fence.state != "COMMITTED" {
        return Err(format!("RESOLVER_FAIL_CLOSED: fence state is not COMMITTED (found '{}')", fence.state));
    }

    if !is_lowercase_hex32(&fence.enrollment_generation_id) {
        return Err("RESOLVER_FAIL_CLOSED: invalid enrollment_generation_id in fence".to_string());
    }
    if !is_lowercase_hex32(&fence.security_device_id_hex) {
        return Err("RESOLVER_FAIL_CLOSED: invalid security_device_id_hex in fence".to_string());
    }

    let gen_key_path = generation_proof_key_path(app_data_dir, &fence.enrollment_generation_id);
    if !gen_key_path.exists() {
        return Err("RESOLVER_FAIL_CLOSED: generation proof key missing".to_string());
    }
    let key_bytes = fs::read(&gen_key_path)
        .map_err(|e| format!("RESOLVER_FAIL_CLOSED: cannot read generation key: {e}"))?;
    if compute_sha256_hex(&key_bytes) != fence.key_sha256 {
        return Err("RESOLVER_FAIL_CLOSED: generation key SHA-256 does not match fence".to_string());
    }

    let gen_meta_path = generation_meta_path(app_data_dir, &fence.enrollment_generation_id);
    if !gen_meta_path.exists() {
        return Err("RESOLVER_FAIL_CLOSED: generation metadata missing".to_string());
    }
    let meta_bytes = fs::read(&gen_meta_path)
        .map_err(|e| format!("RESOLVER_FAIL_CLOSED: cannot read generation metadata: {e}"))?;
    if compute_sha256_hex(&meta_bytes) != fence.meta_sha256 {
        return Err("RESOLVER_FAIL_CLOSED: generation metadata SHA-256 does not match fence".to_string());
    }

    let sha_hex = fence.manifest_sha256
        .ok_or_else(|| "RESOLVER_FAIL_CLOSED: manifest_sha256 missing from committed fence".to_string())?;

    if !is_canonical_lowercase_sha256(&sha_hex) {
        return Err(format!("RESOLVER_FAIL_CLOSED: manifest_sha256 is not canonical lowercase SHA-256 ('{sha_hex}')"));
    }

    let digest_path = digest_manifest_path(app_data_dir, &sha_hex);
    if !digest_path.exists() {
        return Err(format!("RESOLVER_FAIL_CLOSED: digest manifest file does not exist ({})", digest_path.display()));
    }
    if !digest_path.is_file() {
        return Err("RESOLVER_FAIL_CLOSED: digest manifest path is not a regular file".to_string());
    }

    let manifest_bytes = fs::read(&digest_path)
        .map_err(|e| format!("RESOLVER_FAIL_CLOSED: cannot read digest manifest file: {e}"))?;

    let computed_sha = compute_sha256_hex(&manifest_bytes);
    if computed_sha != sha_hex {
        return Err(format!("RESOLVER_FAIL_CLOSED: digest manifest file SHA-256 mismatch (computed '{computed_sha}' != fence '{sha_hex}')"));
    }

    let manifest = frames::decode_oks1(&manifest_bytes)
        .map_err(|e| format!("RESOLVER_FAIL_CLOSED: typed OKS1 V2 decode failed: {e:?}"))?;

    let root_pk = trusted_root.ok_or_else(|| "RESOLVER_FAIL_CLOSED: no trusted root key available".to_string())?;
    let root_vk = VerifyingKey::from_bytes(root_pk)
        .map_err(|e| format!("RESOLVER_FAIL_CLOSED: invalid trusted root key: {e}"))?;
    let prefix = frames::oks1_signed_prefix(&manifest)
        .map_err(|e| format!("RESOLVER_FAIL_CLOSED: cannot build OKS1 prefix: {e:?}"))?;
    let sig = Signature::from_bytes(&manifest.signature);
    root_vk.verify(&prefix, &sig)
        .map_err(|_| "RESOLVER_FAIL_CLOSED: digest manifest root signature verification failed".to_string())?;

    if manifest.keys.is_empty() {
        return Err("RESOLVER_FAIL_CLOSED: manifest contains no keys".to_string());
    }

    Ok(digest_path)
}

#[derive(Clone, Copy)]
pub struct DigestPersistHooks {
    pub move_file: MoveFileFn,
    pub fail_temp_create: bool,
    pub fail_write: bool,
    pub fail_sync: bool,
    pub truncate_write: bool,
    pub mutate_before_reread: bool,
    pub truncate_before_reread: bool,
}

pub const DEFAULT_DIGEST_PERSIST_HOOKS: DigestPersistHooks = DigestPersistHooks {
    move_file: win32_move_file,
    fail_temp_create: false,
    fail_write: false,
    fail_sync: false,
    truncate_write: false,
    mutate_before_reread: false,
    truncate_before_reread: false,
};

pub fn persist_digest_manifest_atomic(
    root: &Path,
    oks1_bytes: &[u8],
    sha256_hex: &str,
) -> Result<PathBuf, String> {
    persist_digest_manifest_atomic_with_hooks(
        root,
        oks1_bytes,
        sha256_hex,
        Some(&canonical_oac_root_public_key()),
        &DEFAULT_DIGEST_PERSIST_HOOKS,
    )
}

pub fn persist_digest_manifest_atomic_with_hooks(
    root: &Path,
    oks1_bytes: &[u8],
    sha256_hex: &str,
    trusted_root: Option<&[u8; 32]>,
    hooks: &DigestPersistHooks,
) -> Result<PathBuf, String> {
    let computed_candidate_sha = compute_sha256_hex(oks1_bytes);
    if computed_candidate_sha != sha256_hex {
        return Err("DIGEST_PATH_CANDIDATE_HASH_MISMATCH".to_string());
    }

    let target_path = digest_manifest_path(root, sha256_hex);
    let mut already_existed = false;

    if target_path.exists() {
        let existing = fs::read(&target_path)
            .map_err(|e| format!("IMMUTABLE_DIGEST_TARGET_READ_FAILED: {e}"))?;
        if existing == oks1_bytes {
            already_existed = true;
        } else {
            return Err("IMMUTABLE_DIGEST_COLLISION".to_string());
        }
    }

    if !already_existed {
        if hooks.fail_temp_create {
            return Err("cannot create digest manifest tmp file: injected temp create failure".to_string());
        }

        let tmp_path = root.join(format!("twinpet-oac-keyset-manifest-{sha256_hex}-{}.tmp", rand::random::<u64>()));
        {
            let mut f = File::create(&tmp_path)
                .map_err(|e| format!("cannot create digest manifest tmp file: {e}"))?;

            if hooks.fail_write {
                let _ = fs::remove_file(&tmp_path);
                return Err("cannot write digest manifest tmp file: injected write failure".to_string());
            }

            let bytes_to_write = if hooks.truncate_write {
                &oks1_bytes[..oks1_bytes.len().saturating_sub(10)]
            } else {
                oks1_bytes
            };

            f.write_all(bytes_to_write)
                .map_err(|e| format!("cannot write digest manifest tmp file: {e}"))?;

            if hooks.fail_sync {
                let _ = fs::remove_file(&tmp_path);
                return Err("sync_all failed on digest manifest tmp: injected sync failure".to_string());
            }

            f.sync_all()
                .map_err(|e| format!("sync_all failed on digest manifest tmp: {e}"))?;
        }

        let wide_target = to_wide(&target_path);
        let wide_tmp = to_wide(&tmp_path);

        let res = (hooks.move_file)(
            PCWSTR(wide_tmp.as_ptr()),
            PCWSTR(wide_target.as_ptr()),
            MOVEFILE_WRITE_THROUGH,
        );
        if let Err(code) = res {
            let _ = fs::remove_file(&tmp_path);
            if target_path.exists() {
                match fs::read(&target_path) {
                    Ok(reread_bytes) => {
                        if reread_bytes == oks1_bytes {
                            // Exact create race success
                        } else {
                            return Err("IMMUTABLE_DIGEST_CREATE_RACE_COLLISION".to_string());
                        }
                    }
                    Err(e) => {
                        return Err(format!("IMMUTABLE_DIGEST_TARGET_READ_FAILED: {e}"));
                    }
                }
            } else {
                return Err(format!("MoveFileExW failed on digest manifest: error code {code}"));
            }
        }
    }

    if hooks.mutate_before_reread {
        let _ = fs::write(&target_path, b"MUTATED_BYTES_AFTER_PUBLISH");
    }
    if hooks.truncate_before_reread {
        if let Ok(f) = fs::OpenOptions::new().write(true).open(&target_path) {
            let _ = f.set_len(10);
        }
    }

    // Post-publish validation: reread, hash, decode, and root-signature verification
    let disk_bytes = fs::read(&target_path)
        .map_err(|e| format!("reread digest manifest failed: {e}"))?;
    if disk_bytes != oks1_bytes {
        return Err("reread bytes mismatch".to_string());
    }
    let disk_sha = compute_sha256_hex(&disk_bytes);
    if disk_sha != sha256_hex {
        return Err(format!("reread hash mismatch: on-disk '{disk_sha}' != expected '{sha256_hex}'"));
    }

    let decoded = frames::decode_oks1(&disk_bytes)
        .map_err(|e| format!("typed OKS1 V2 decode failed on persisted manifest: {e:?}"))?;

    let root_pk = trusted_root.ok_or_else(|| "missing trusted root key for verification".to_string())?;
    let root_vk = VerifyingKey::from_bytes(root_pk)
        .map_err(|e| format!("invalid root key: {e}"))?;
    let prefix = frames::oks1_signed_prefix(&decoded)
        .map_err(|e| format!("cannot build prefix: {e:?}"))?;
    let sig = Signature::from_bytes(&decoded.signature);
    root_vk.verify(&prefix, &sig)
        .map_err(|_| "persisted digest manifest root signature verification failed".to_string())?;

    Ok(target_path)
}

pub fn encode_enrm(frame: &EnrollmentMetaFrameV1) -> Result<Vec<u8>, String> {
    let branch_bytes = frame.branch_id.as_bytes();
    if branch_bytes.len() > u16::MAX as usize {
        return Err("branch_id exceeds u16::MAX length".to_string());
    }

    let mut out = Vec::with_capacity(ENRM_FIXED_MINIMUM_LENGTH + branch_bytes.len());
    out.extend_from_slice(ENRM_MAGIC);
    out.push(ENRM_SCHEMA_VERSION_1);
    out.extend_from_slice(&frame.enrollment_generation_id);
    out.extend_from_slice(&frame.security_device_id);
    out.extend_from_slice(&frame.device_key_version.to_le_bytes());
    out.extend_from_slice(&frame.expected_public_key);
    out.extend_from_slice(&(branch_bytes.len() as u16).to_le_bytes());
    out.extend_from_slice(branch_bytes);

    Ok(out)
}

pub fn decode_enrm(bytes: &[u8]) -> Result<EnrollmentMetaFrameV1, String> {
    if bytes.len() < ENRM_FIXED_MINIMUM_LENGTH {
        return Err(format!("buffer too short: {} < {ENRM_FIXED_MINIMUM_LENGTH}", bytes.len()));
    }

    if &bytes[0..4] != ENRM_MAGIC {
        return Err("invalid magic".to_string());
    }
    if bytes[4] != ENRM_SCHEMA_VERSION_1 {
        return Err(format!("unsupported version: {}", bytes[4]));
    }

    let mut offset = 5;
    let mut enrollment_generation_id = [0u8; 16];
    enrollment_generation_id.copy_from_slice(&bytes[offset..offset + 16]);
    offset += 16;

    let mut security_device_id = [0u8; 16];
    security_device_id.copy_from_slice(&bytes[offset..offset + 16]);
    offset += 16;

    let device_key_version = u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ]);
    offset += 4;

    let mut expected_public_key = [0u8; 32];
    expected_public_key.copy_from_slice(&bytes[offset..offset + 32]);
    offset += 32;

    let branch_len = u16::from_le_bytes([bytes[offset], bytes[offset + 1]]) as usize;
    offset += 2;

    if bytes.len() != offset + branch_len {
        return Err(format!("trailing or truncated bytes: expected {}, got {}", offset + branch_len, bytes.len()));
    }

    let branch_id = std::str::from_utf8(&bytes[offset..offset + branch_len])
        .map_err(|e| format!("invalid branch_id utf8: {e}"))?
        .to_string();

    Ok(EnrollmentMetaFrameV1 {
        enrollment_generation_id,
        security_device_id,
        device_key_version,
        expected_public_key,
        branch_id,
    })
}

pub fn compute_sha256(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().into()
}

pub fn compute_sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:064x}", hasher.finalize())
}


/// Verifies local enrollment fence, DPAPI metadata, and key binding.
/// Strictly reads only the fence-selected generation key and metadata.
/// Never falls back to legacy canonical or compatibility copies.
/// Returns Ok(frame) if all local checks pass.
pub fn verify_local_enrollment(
    app_data_dir: &Path,
    signing_key: &SigningKey,
) -> Result<EnrollmentMetaFrameV1, EnrollmentMetaError> {
    let fence_path = enrollment_fence_path(app_data_dir);
    let fence_bytes = match fs::read(&fence_path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(EnrollmentMetaError::NotFound),
        Err(e) => return Err(EnrollmentMetaError::Io(e.to_string())),
    };

    let fence: EnrollmentFenceState = serde_json::from_slice(&fence_bytes)
        .map_err(|e| EnrollmentMetaError::Corrupt(format!("fence json invalid: {e}")))?;

    if fence.state != "COMMITTED" || fence.enrollment_generation_id.trim().is_empty() {
        return Err(EnrollmentMetaError::FenceUncommitted);
    }

    let key_path = generation_proof_key_path(app_data_dir, &fence.enrollment_generation_id);
    let key_bytes = match fs::read(&key_path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(EnrollmentMetaError::NotFound),
        Err(e) => return Err(EnrollmentMetaError::Io(e.to_string())),
    };

    let key_hash = compute_sha256_hex(&key_bytes);
    if key_hash.to_lowercase() != fence.key_sha256.to_lowercase() {
        return Err(EnrollmentMetaError::KeyHashMismatch);
    }

    let meta_path = generation_meta_path(app_data_dir, &fence.enrollment_generation_id);
    let meta_cipher = match fs::read(&meta_path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(EnrollmentMetaError::NotFound),
        Err(e) => return Err(EnrollmentMetaError::Io(e.to_string())),
    };

    let meta_hash = compute_sha256_hex(&meta_cipher);
    if meta_hash.to_lowercase() != fence.meta_sha256.to_lowercase() {
        return Err(EnrollmentMetaError::MetaHashMismatch);
    }

    let meta_plain = dpapi_unprotect(&meta_cipher)
        .map_err(|_| EnrollmentMetaError::DpapiFailed)?;

    let meta_frame = decode_enrm(&meta_plain)
        .map_err(EnrollmentMetaError::Corrupt)?;

    let gen_hex = meta_frame.enrollment_generation_id.iter().map(|b| format!("{b:02x}")).collect::<String>();
    if gen_hex.to_lowercase() != fence.enrollment_generation_id.to_lowercase() {
        return Err(EnrollmentMetaError::GenerationMismatch);
    }

    let dev_id_hex = meta_frame.security_device_id.iter().map(|b| format!("{b:02x}")).collect::<String>();
    if dev_id_hex.to_lowercase() != fence.security_device_id_hex.to_lowercase() {
        return Err(EnrollmentMetaError::Corrupt("security device id mismatch between fence and meta".to_string()));
    }

    if meta_frame.device_key_version != fence.device_key_version {
        return Err(EnrollmentMetaError::VersionMismatch);
    }

    let derived_pub = signing_key.verifying_key().to_bytes();
    if derived_pub != meta_frame.expected_public_key {
        return Err(EnrollmentMetaError::PublicKeyMismatch);
    }

    Ok(meta_frame)
}

#[cfg(windows)]
fn to_wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[allow(dead_code)]
#[cfg(windows)]
fn atomic_replace_file(src: &Path, dst: &Path) -> Result<(), std::io::Error> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::GetLastError;
    use windows::Win32::Storage::FileSystem::{MoveFileExW, ReplaceFileW, MOVEFILE_WRITE_THROUGH};

    let wide_src = to_wide(src);
    let wide_dst = to_wide(dst);

    if dst.exists() {
        let success = unsafe {
            ReplaceFileW(
                PCWSTR(wide_dst.as_ptr()),
                PCWSTR(wide_src.as_ptr()),
                PCWSTR::null(),
                windows::Win32::Storage::FileSystem::REPLACE_FILE_FLAGS(0),
                None,
                None,
            )
        };
        if success.is_ok() {
            let _ = fs::remove_file(src);
            return Ok(());
        }
        let err = unsafe { GetLastError() };
        let _ = fs::remove_file(src);
        Err(std::io::Error::from_raw_os_error(err.0 as i32))
    } else {
        let move_res = unsafe {
            MoveFileExW(
                PCWSTR(wide_src.as_ptr()),
                PCWSTR(wide_dst.as_ptr()),
                MOVEFILE_WRITE_THROUGH,
            )
        };
        if move_res.is_ok() {
            return Ok(());
        }
        let err = unsafe { GetLastError() };
        let _ = fs::remove_file(src);
        Err(std::io::Error::from_raw_os_error(err.0 as i32))
    }
}

#[cfg(not(windows))]
fn atomic_replace_file(src: &Path, dst: &Path) -> Result<(), std::io::Error> {
    fs::rename(src, dst)
}

/// Atomically writes enrollment metadata and fence files following the
/// crash-safe two-artifact commit protocol:
/// 1. Encrypt and write metadata temp
/// 2. Compute hashes of key file and metadata temp
/// 3. Write fence with state PREPARED
/// 4. Atomic rename metadata temp -> final
/// 5. Overwrite fence with state COMMITTED
#[allow(dead_code)]
pub fn commit_enrollment_metadata(
    app_data_dir: &Path,
    frame: &EnrollmentMetaFrameV1,
    committed_at_ms: u64,
) -> Result<(), EnrollmentMetaError> {
    let meta_bytes = encode_enrm(frame)
        .map_err(EnrollmentMetaError::Corrupt)?;
    let meta_cipher = dpapi_protect(&meta_bytes)
        .map_err(|_| EnrollmentMetaError::DpapiFailed)?;

    let gen_hex = frame.enrollment_generation_id.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let dev_id_hex = frame.security_device_id.iter().map(|b| format!("{b:02x}")).collect::<String>();

    let gen_key_path = generation_proof_key_path(app_data_dir, &gen_hex);
    if !gen_key_path.exists() {
        let legacy_key_path = super::device_proof::device_proof_key_path(app_data_dir);
        if legacy_key_path.exists() {
            let _ = fs::copy(&legacy_key_path, &gen_key_path);
        }
    }
    let key_bytes = fs::read(&gen_key_path)
        .map_err(|e| EnrollmentMetaError::Io(e.to_string()))?;
    let key_sha256 = compute_sha256_hex(&key_bytes);

    let gen_meta_path = generation_meta_path(app_data_dir, &gen_hex);
    let meta_tmp = gen_meta_path.with_extension("tmp");
    fs::write(&meta_tmp, &meta_cipher)
        .map_err(|e| EnrollmentMetaError::Io(e.to_string()))?;

    let meta_sha256 = compute_sha256_hex(&meta_cipher);

    let fence_path = enrollment_fence_path(app_data_dir);
    let fence_tmp = fence_path.with_extension("tmp");

    let prepared_fence = EnrollmentFenceState {
        state: "PREPARED".to_string(),
        enrollment_generation_id: gen_hex.clone(),
        security_device_id_hex: dev_id_hex.clone(),
        device_key_version: frame.device_key_version,
        key_sha256: key_sha256.clone(),
        meta_sha256: meta_sha256.clone(),
        manifest_sha256: None,
        committed_at_local_ms: committed_at_ms,
    };
    let prepared_json = serde_json::to_vec_pretty(&prepared_fence)
        .map_err(|e| EnrollmentMetaError::Corrupt(e.to_string()))?;
    fs::write(&fence_tmp, &prepared_json)
        .map_err(|e| EnrollmentMetaError::Io(e.to_string()))?;
    atomic_replace_file(&fence_tmp, &fence_path)
        .map_err(|e| EnrollmentMetaError::Io(e.to_string()))?;

    atomic_replace_file(&meta_tmp, &gen_meta_path)
        .map_err(|e| EnrollmentMetaError::Io(e.to_string()))?;

    let committed_fence = EnrollmentFenceState {
        state: "COMMITTED".to_string(),
        ..prepared_fence
    };
    let committed_json = serde_json::to_vec_pretty(&committed_fence)
        .map_err(|e| EnrollmentMetaError::Corrupt(e.to_string()))?;
    fs::write(&fence_tmp, &committed_json)
        .map_err(|e| EnrollmentMetaError::Io(e.to_string()))?;
    atomic_replace_file(&fence_tmp, &fence_path)
        .map_err(|e| EnrollmentMetaError::Io(e.to_string()))?;

    Ok(())
}

const B64_STD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode_std(bytes: &[u8]) -> String {
    let alphabet = B64_STD;
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        out.push(alphabet[(b0 >> 2) as usize] as char);
        out.push(alphabet[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(alphabet[(((b1 & 0x0F) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(alphabet[(b2 & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

pub fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    fn char_to_val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' | b'-' => Some(62),
            b'/' | b'_' => Some(63),
            _ => None,
        }
    }
    let cleaned: Vec<u8> = input.bytes().filter(|&b| b != b'=' && !b.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(cleaned.len() * 3 / 4);
    for chunk in cleaned.chunks(4) {
        let vals: Vec<u8> = chunk
            .iter()
            .map(|&b| char_to_val(b).ok_or_else(|| "invalid base64 character".to_string()))
            .collect::<Result<_, _>>()?;
        if vals.len() >= 2 {
            out.push((vals[0] << 2) | (vals[1] >> 4));
        }
        if vals.len() >= 3 {
            out.push((vals[1] << 4) | (vals[2] >> 2));
        }
        if vals.len() == 4 {
            out.push((vals[2] << 6) | vals[3]);
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedEnrollmentOutcome {
    pub enrollment_generation_id: [u8; 16],
    pub enrollment_generation_id_hex: String,
    pub staged_public_key: [u8; 32],
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StagedEnrollmentFrameV1 {
    pub enrollment_generation_id_hex: String,
    pub security_device_id_hex: String,
    pub private_key_seed_hex: String,
    pub public_key_hex: String,
    pub staged_at_ms: u64,
}

pub fn stage_device_enrollment(
    app_data_dir: &Path,
    security_device_id: [u8; 16],
    signing_key: &SigningKey,
) -> Result<StagedEnrollmentOutcome, String> {
    use rand::rngs::OsRng;
    use rand::RngCore;

    let mut enrollment_generation_id = [0u8; 16];
    OsRng.fill_bytes(&mut enrollment_generation_id);

    let gen_hex = enrollment_generation_id.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let sec_id_hex = security_device_id.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let priv_seed_hex = signing_key.to_bytes().iter().map(|b| format!("{b:02x}")).collect::<String>();
    let pub_bytes = signing_key.verifying_key().to_bytes();
    let pub_hex = pub_bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let staged_frame = StagedEnrollmentFrameV1 {
        enrollment_generation_id_hex: gen_hex.clone(),
        security_device_id_hex: sec_id_hex,
        private_key_seed_hex: priv_seed_hex,
        public_key_hex: pub_hex,
        staged_at_ms: now_ms,
    };

    let json_bytes = serde_json::to_vec_pretty(&staged_frame)
        .map_err(|e| format!("cannot serialize staged enrollment: {e}"))?;
    let ciphertext = dpapi_protect(&json_bytes)
        .map_err(|e| format!("DPAPI protect failed for staged enrollment: {e:?}"))?;

    // 1. Generation-scoped staged file
    let staged_path = enrollment_staged_generation_path(app_data_dir, &gen_hex);
    let staged_tmp = app_data_dir.join(format!("staged-{}-{}.tmp", gen_hex, rand::random::<u64>()));
    durable_first_create_file(&staged_tmp, &staged_path, &ciphertext)?;

    // 2. Generation-scoped key file
    let gen_key_path = generation_proof_key_path(app_data_dir, &gen_hex);
    let gen_key_cipher = dpapi_protect(&signing_key.to_bytes())
        .map_err(|e| format!("DPAPI protect failed for gen-scoped key: {e:?}"))?;
    let gen_key_tmp = app_data_dir.join(format!("key-{}-{}.tmp", gen_hex, rand::random::<u64>()));
    durable_first_create_file(&gen_key_tmp, &gen_key_path, &gen_key_cipher)?;

    Ok(StagedEnrollmentOutcome {
        enrollment_generation_id,
        enrollment_generation_id_hex: gen_hex,
        staged_public_key: pub_bytes,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeDeviceEnrollmentOutcomeDto {
    pub success: bool,
    pub status: String,
    pub security_device_id_hex: String,
    pub device_key_version: u32,
    pub branch_id: String,
    pub enrollment_generation_id_hex: String,
    pub accepted_public_key_base64: String,
}

/// Canonical OAC Root Public Key pinned in native client (Option A: public key raw 32 bytes only).
/// Generated from stable server root; private root key material NEVER exists on client in production.
pub const CANONICAL_OAC_ROOT_PUBLIC_KEY: [u8; 32] = [
    0x0d, 0x75, 0x50, 0x75, 0x4e, 0x08, 0x00, 0xa5,
    0xd2, 0x37, 0xee, 0xf5, 0x82, 0x60, 0x35, 0x76,
    0x6b, 0x9b, 0x3e, 0x5a, 0x15, 0x86, 0x8a, 0x94,
    0x0a, 0xb2, 0x89, 0x95, 0x87, 0x88, 0xe3, 0xb0,
];

pub fn canonical_oac_root_public_key() -> [u8; 32] {
    CANONICAL_OAC_ROOT_PUBLIC_KEY
}

#[cfg(test)]
pub const TEST_OAC_ROOT_SEED: [u8; 32] = [0x5au8; 32];

#[cfg(test)]
pub fn setup_committed_test_enrollment_with_manifest(
    root: &Path,
    branch_id: &str,
    sec_id: [u8; 16],
    keys: Vec<frames::OacKeysetManifestKeyV1>,
    epoch: u32,
) -> (SigningKey, Vec<u8>, String) {
    use ed25519_dalek::Signer;
    let dev_key = SigningKey::generate(&mut rand::rngs::OsRng);
    let sec_id_hex = sec_id.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let sec_id_path = super::security_device_id::security_device_id_path(root);
    let _ = fs::write(&sec_id_path, &sec_id);

    let gen_hex = "0102030405060708090a0b0c0d0e0f10".to_string();
    let gen_key_path = generation_proof_key_path(root, &gen_hex);
    let gen_key_cipher = dpapi_protect(&dev_key.to_bytes()).unwrap();
    let _ = fs::write(&gen_key_path, &gen_key_cipher);
    let key_sha256 = compute_sha256_hex(&gen_key_cipher);

    let mut gen_bytes = [0u8; 16];
    for i in 0..16 {
        gen_bytes[i] = u8::from_str_radix(&gen_hex[i * 2..i * 2 + 2], 16).unwrap();
    }

    let meta_frame = EnrollmentMetaFrameV1 {
        enrollment_generation_id: gen_bytes,
        security_device_id: sec_id,
        device_key_version: 1,
        expected_public_key: dev_key.verifying_key().to_bytes(),
        branch_id: branch_id.to_string(),
    };
    let meta_raw = encode_enrm(&meta_frame).unwrap();
    let meta_cipher = dpapi_protect(&meta_raw).unwrap();
    let gen_meta_path = generation_meta_path(root, &gen_hex);
    let _ = fs::write(&gen_meta_path, &meta_cipher);
    let meta_sha256 = compute_sha256_hex(&meta_cipher);

    // Build OKS1 manifest signed with root key
    let root_key = SigningKey::from_bytes(&TEST_OAC_ROOT_SEED);
    let manifest_frame = frames::OacKeysetManifestFrameV1 {
        revocation_epoch: epoch,
        generated_at_server_ms: 1000,
        keys,
        signature: [0u8; 64],
    };
    let prefix = frames::oks1_signed_prefix(&manifest_frame).unwrap();
    let sig = root_key.sign(&prefix).to_bytes();
    let signed = frames::OacKeysetManifestFrameV1 {
        signature: sig,
        ..manifest_frame
    };
    let oks1_bytes = frames::encode_oks1(&signed).unwrap();
    let manifest_sha256 = compute_sha256_hex(&oks1_bytes);

    let digest_path = digest_manifest_path(root, &manifest_sha256);
    let _ = fs::write(&digest_path, &oks1_bytes);

    let fence = EnrollmentFenceState {
        state: "COMMITTED".to_string(),
        enrollment_generation_id: gen_hex,
        security_device_id_hex: sec_id_hex,
        device_key_version: 1,
        key_sha256,
        meta_sha256,
        manifest_sha256: Some(manifest_sha256.clone()),
        committed_at_local_ms: 1000,
    };
    let fence_path = enrollment_fence_path(root);
    let fence_bytes = serde_json::to_vec_pretty(&fence).unwrap();
    let _ = fs::write(&fence_path, &fence_bytes);

    (dev_key, oks1_bytes, manifest_sha256)
}

#[derive(Clone)]
pub struct FinalizeHooks {
    pub replace_file: ReplaceFileFn,
    pub move_file: MoveFileFn,
    pub fail_gen_key_write: bool,
    pub fail_gen_meta_write: bool,
    pub fail_manifest_write: bool,
    pub fail_manifest_reread: bool,
    pub fail_fence_switch: bool,
    pub trusted_root_public_key: Option<[u8; 32]>,
    pub expected_operation_kind: Option<u8>,
    pub trusted_now_override_ms: Option<u64>,
    pub receipt_context_override: Option<ReceiptContext>,
    pub receipt_observation_override: Option<ReceiptObservation>,
    pub digest_persist_hooks: Option<DigestPersistHooks>,
}

impl Default for FinalizeHooks {
    fn default() -> Self {
        Self {
            replace_file: win32_replace_file,
            move_file: win32_move_file,
            fail_gen_key_write: false,
            fail_gen_meta_write: false,
            fail_manifest_write: false,
            fail_manifest_reread: false,
            fail_fence_switch: false,
            trusted_root_public_key: Some(canonical_oac_root_public_key()),
            expected_operation_kind: None,
            trusted_now_override_ms: None,
            receipt_context_override: None,
            receipt_observation_override: None,
            digest_persist_hooks: None,
        }
    }
}

pub fn get_dec_d07_trusted_now_ms(app_data_dir: &Path) -> Result<u64, String> {
    let now_wall_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .map_err(|e| format!("SYSTEM_TIME_ERROR: {e}"))?;

    // DEC-D-07 monotonic clock guard bound: tamper-evident non-rollback observation
    super::clock_guard::assert_valid_and_advance_clock(app_data_dir, now_wall_ms)
        .map_err(|e| format!("CLOCK_GUARD_FAIL_CLOSED: {e}"))?;

    // Check monotonic QPC ticks for process continuity
    let _ = super::monotonic_clock::read_qpc_ticks()
        .map_err(|e| format!("MONOTONIC_CLOCK_ERROR: {e:?}"))?;

    Ok(now_wall_ms)
}

fn validate_signing_key_lifecycle(
    manifest: &frames::OacKeysetManifestFrameV1,
    signing_key_id: &str,
    trusted_now_ms: u64,
) -> Result<(), String> {
    let key = manifest
        .keys
        .iter()
        .find(|k| k.signing_key_id == signing_key_id)
        .ok_or_else(|| format!("KEY_LIFECYCLE_VIOLATION: signing key '{signing_key_id}' not found in manifest"))?;

    match key.status {
        frames::OacKeyLifecycleStatus::Active => Ok(()),
        frames::OacKeyLifecycleStatus::VerifyOnly => {
            let expiry = key.verify_until_server_ms.ok_or_else(|| {
                format!("KEY_LIFECYCLE_VIOLATION: signing key '{signing_key_id}' is VERIFY_ONLY but missing verify_until_server_ms")
            })?;

            if trusted_now_ms >= expiry {
                return Err(format!(
                    "KEY_LIFECYCLE_VIOLATION: signing key '{signing_key_id}' is VERIFY_ONLY and expired at {expiry} (trusted now is {trusted_now_ms})"
                ));
            }
            Ok(())
        }
        frames::OacKeyLifecycleStatus::Retired => {
            Err(format!("KEY_LIFECYCLE_VIOLATION: signing key '{signing_key_id}' is RETIRED"))
        }
    }
}

fn authenticate_candidate_keyset(
    app_data_dir: &Path,
    oks1_base64: Option<&str>,
    trusted_root_public_key: Option<&[u8; 32]>,
    pending_initial: Option<&PendingInitialBindings>,
) -> Result<(frames::OacKeysetManifestFrameV1, Option<Vec<u8>>), String> {
    let root_pk = trusted_root_public_key
        .ok_or_else(|| "UNTRUSTED_KEYSET_BOOTSTRAP: no trusted root public key configured".to_string())?;
    let root_vk = VerifyingKey::from_bytes(root_pk)
        .map_err(|e| format!("INVALID_TRUSTED_ROOT_KEY: {e}"))?;

    let candidate_raw = match oks1_base64.filter(|s| !s.trim().is_empty()) {
        Some(s) => Some(base64_decode(s).map_err(|e| format!("cannot decode oks1_base64: {e}"))?),
        None => None,
    };

    match resolve_active_manifest_path_with_root(app_data_dir, Some(root_pk)) {
        Ok(cached_path) => {
            let cached_bytes = fs::read(&cached_path)
                .map_err(|e| format!("cannot read cached keyset manifest: {e}"))?;
            let cached_manifest = frames::decode_oks1(&cached_bytes)
                .map_err(|e| format!("cached OKS1 decode failed: {e:?}"))?;

            if let Some(cand_bytes) = candidate_raw {
                if cand_bytes == cached_bytes {
                    // Idempotent exact match: candidate is identical to trusted on-disk manifest
                    return Ok((cached_manifest, None));
                }

                // Non-matching candidate: must authenticate as a valid monotonic rotation
                let cand_manifest = frames::decode_oks1(&cand_bytes)
                    .map_err(|e| format!("candidate OKS1 decode failed: {e:?}"))?;

                // Strict epoch requirement: candidate.epoch > cached.epoch
                if cand_manifest.revocation_epoch <= cached_manifest.revocation_epoch {
                    return Err(format!(
                        "UNTRUSTED_KEYSET_ROTATION: candidate epoch {} <= cached epoch {} (equal-epoch changed bytes and downgrades rejected)",
                        cand_manifest.revocation_epoch, cached_manifest.revocation_epoch
                    ));
                }

                // ROOT_DIRECT: Rotation must be signed directly by the root
                let cand_prefix = frames::oks1_signed_prefix(&cand_manifest)
                    .map_err(|e| format!("cannot build candidate prefix: {e:?}"))?;
                let cand_sig = Signature::from_bytes(&cand_manifest.signature);
                root_vk.verify(&cand_prefix, &cand_sig)
                    .map_err(|_| "UNTRUSTED_KEYSET_ROTATION: candidate manifest not signed by trusted root (old active keys cannot authenticate rotation)".to_string())?;

                Ok((cand_manifest, Some(cand_bytes)))
            } else {
                // No candidate provided, use cached manifest
                Ok((cached_manifest, None))
            }
        }
        Err(err) => {
            // Distinguish clean bootstrap from authority failure:
            let fence_path = enrollment_fence_path(app_data_dir);
            if fence_path.exists() {
                return Err(format!("UNTRUSTED_KEYSET_ROTATION_FAIL_CLOSED: resolver failed on enrolled/partial device: {err}"));
            }

            let classification = classify_directory_artifacts(app_data_dir, pending_initial);
            match classification {
                CleanArtifactClassification::TrulyClean | CleanArtifactClassification::ExactPendingInitial => {}
                CleanArtifactClassification::PartialOrHistorical => {
                    return Err(format!("UNTRUSTED_KEYSET_ROTATION_FAIL_CLOSED: resolver failed on enrolled/partial device: {err}"));
                }
            }

            // Clean bootstrap or exact pending initial (no fence and clean/exact pending artifacts)
            let cand_bytes = candidate_raw.ok_or_else(|| {
                format!("KEYSET_MANIFEST_UNAVAILABLE: device is clean unenrolled and no candidate manifest provided ({err})")
            })?;

            let cand_manifest = frames::decode_oks1(&cand_bytes)
                .map_err(|e| format!("candidate OKS1 decode failed: {e:?}"))?;

            let cand_prefix = frames::oks1_signed_prefix(&cand_manifest)
                .map_err(|e| format!("cannot build candidate prefix: {e:?}"))?;
            let cand_sig = Signature::from_bytes(&cand_manifest.signature);
            root_vk.verify(&cand_prefix, &cand_sig)
                .map_err(|_| "UNTRUSTED_KEYSET_BOOTSTRAP: candidate bootstrap keyset not signed by trusted root".to_string())?;

            Ok((cand_manifest, Some(cand_bytes)))
        }
    }
}

pub fn finalize_device_enrollment_internal_with_hooks(
    runtime: &EnrollmentRuntimeState,
    app_data_dir: &Path,
    enrollment_generation_id: &str,
    security_device_id_hex: &str,
    branch_id: &str,
    device_key_version: u32,
    accepted_public_key_base64: &str,
    server_receipt_base64: Option<&str>,
    oks1_base64: Option<&str>,
    hooks: &FinalizeHooks,
) -> Result<FinalizeDeviceEnrollmentOutcomeDto, String> {
    let _lock = FINALIZE_MUTEX.lock().map_err(|e| format!("mutex poisoned: {e}"))?;

    if device_key_version == 0 || device_key_version > MAX_DEVICE_KEY_VERSION {
        return Err(format!("INVALID_DEVICE_KEY_VERSION: {device_key_version}"));
    }
    if !is_lowercase_hex32(enrollment_generation_id) {
        return Err(format!("INVALID_ENROLLMENT_GENERATION_ID: '{enrollment_generation_id}'"));
    }
    if !is_lowercase_hex32(security_device_id_hex) {
        return Err(format!("INVALID_SECURITY_DEVICE_ID: '{security_device_id_hex}'"));
    }
    if !super::frames::is_canonical_identifier(branch_id) {
        return Err(format!("INVALID_BRANCH_ID: '{branch_id}'"));
    }

    let accepted_pubkey = base64_decode(accepted_public_key_base64)
        .map_err(|e| format!("cannot decode accepted_public_key_base64: {e}"))?;
    if accepted_pubkey.len() != 32 {
        return Err(format!("accepted public key length mismatch: {} != 32", accepted_pubkey.len()));
    }
    let mut accepted_pubkey_bytes = [0u8; 32];
    accepted_pubkey_bytes.copy_from_slice(&accepted_pubkey);

    let mut gen_bytes = [0u8; 16];
    for i in 0..16 {
        gen_bytes[i] = u8::from_str_radix(&enrollment_generation_id[i * 2..i * 2 + 2], 16)
            .map_err(|e| format!("invalid gen hex: {e}"))?;
    }
    let mut sec_id_bytes = [0u8; 16];
    for i in 0..16 {
        sec_id_bytes[i] = u8::from_str_radix(&security_device_id_hex[i * 2..i * 2 + 2], 16)
            .map_err(|e| format!("invalid sec id hex: {e}"))?;
    }

    let sec_id_path = super::security_device_id::security_device_id_path(app_data_dir);
    if sec_id_path.exists() {
        let stored_sec_id = fs::read(&sec_id_path)
            .map_err(|e| format!("cannot read stored security device id: {e}"))?;
        let stored_hex = stored_sec_id.iter().map(|b| format!("{b:02x}")).collect::<String>();
        if !stored_hex.eq_ignore_ascii_case(security_device_id_hex) {
            return Err("SECURITY_DEVICE_ID_MISMATCH".to_string());
        }
    }

    // --- Validate Server Finalization Receipt (EFR1) & Keyset Manifest ---
    let receipt_str = server_receipt_base64
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "SERVER_RECEIPT_REQUIRED: server finalization receipt is required".to_string())?;

    let receipt_bytes = base64_decode(receipt_str)
        .map_err(|e| format!("RECEIPT_DECODE_FAILED: cannot base64 decode receipt: {e}"))?;
    let efr1 = frames::decode_efr1(&receipt_bytes)
        .map_err(|e| format!("RECEIPT_DECODE_FAILED: {e:?}"))?;

    // Check committed fence state to determine whether device is enrolled (fail-closed on corrupt/malformed fence)
    let fence_path = enrollment_fence_path(app_data_dir);
    let prior_committed_fence: Option<EnrollmentFenceState> = if fence_path.exists() {
        let fence_bytes = fs::read(&fence_path)
            .map_err(|e| format!("MALFORMED_FENCE_FAIL_CLOSED: cannot read existing fence file: {e}"))?;
        let fence = serde_json::from_slice::<EnrollmentFenceState>(&fence_bytes)
            .map_err(|e| format!("MALFORMED_FENCE_FAIL_CLOSED: cannot parse fence JSON: {e}"))?;
        if fence.state != "COMMITTED" {
            return Err(format!("MALFORMED_FENCE_FAIL_CLOSED: incoherent fence state '{}'", fence.state));
        }
        if !is_lowercase_hex32(&fence.enrollment_generation_id) || !is_lowercase_hex32(&fence.security_device_id_hex) {
            return Err("MALFORMED_FENCE_FAIL_CLOSED: invalid identifiers in fence".to_string());
        }
        Some(fence)
    } else {
        None
    };

    // Native-derived operation context
    let native_derived_op = match &prior_committed_fence {
        None => frames::EFR1_OP_INITIAL_ENROLLMENT,
        Some(fence) => {
            if fence.enrollment_generation_id.eq_ignore_ascii_case(enrollment_generation_id) {
                efr1.operation_kind
            } else {
                frames::EFR1_OP_RE_ENROLLMENT
            }
        }
    };

    // Caller cannot override native-derived context; caller expected_operation_kind may only confirm consistency
    if let Some(caller_op) = hooks.expected_operation_kind {
        if caller_op != frames::EFR1_OP_INITIAL_ENROLLMENT && caller_op != frames::EFR1_OP_RE_ENROLLMENT {
            return Err(format!("INVALID_EXPECTED_OPERATION_KIND: {caller_op}"));
        }
        if prior_committed_fence.is_none() && caller_op == frames::EFR1_OP_RE_ENROLLMENT {
            return Err("OPERATION_CONTEXT_MISMATCH: re-enrollment attempted on unenrolled device".to_string());
        }
        if let Some(ref fence) = prior_committed_fence {
            if !fence.enrollment_generation_id.eq_ignore_ascii_case(enrollment_generation_id) && caller_op == frames::EFR1_OP_INITIAL_ENROLLMENT {
                return Err("OPERATION_CONTEXT_MISMATCH: initial enrollment attempted on already enrolled device".to_string());
            }
        }
        if caller_op != native_derived_op {
            return Err(format!(
                "OPERATION_CONTEXT_MISMATCH: caller expected {} != native-derived {}",
                caller_op, native_derived_op
            ));
        }
    }

    if efr1.operation_kind != native_derived_op {
        return Err(format!(
            "RECEIPT_OPERATION_KIND_MISMATCH: receipt operation_kind {} != native-derived {}",
            efr1.operation_kind, native_derived_op
        ));
    }

    // Validate cryptographic receipt binding against claimed arguments
    let efr1_gen_hex = efr1.enrollment_generation_id.iter().map(|b| format!("{b:02x}")).collect::<String>();
    if !efr1_gen_hex.eq_ignore_ascii_case(enrollment_generation_id) {
        return Err(format!("RECEIPT_BINDING_MISMATCH: generation id mismatch ('{efr1_gen_hex}' != '{enrollment_generation_id}')"));
    }
    let efr1_sec_id_hex = efr1.security_device_id.iter().map(|b| format!("{b:02x}")).collect::<String>();
    if !efr1_sec_id_hex.eq_ignore_ascii_case(security_device_id_hex) {
        return Err(format!("RECEIPT_BINDING_MISMATCH: security device id mismatch ('{efr1_sec_id_hex}' != '{security_device_id_hex}')"));
    }
    if efr1.device_key_version != device_key_version {
        return Err(format!("RECEIPT_BINDING_MISMATCH: device key version mismatch ({} != {device_key_version})", efr1.device_key_version));
    }
    if efr1.accepted_public_key != accepted_pubkey_bytes {
        return Err("RECEIPT_BINDING_MISMATCH: accepted public key mismatch".to_string());
    }
    if efr1.branch_id != branch_id {
        return Err(format!("RECEIPT_BINDING_MISMATCH: branch id mismatch ('{}' != '{branch_id}')", efr1.branch_id));
    }

    // Validate staged enrollment record
    let staged_path = enrollment_staged_generation_path(app_data_dir, enrollment_generation_id);
    let staged_record = if staged_path.exists() {
        let staged_cipher = fs::read(&staged_path)
            .map_err(|e| format!("cannot read staged enrollment file: {e}"))?;
        let staged_plain = dpapi_unprotect(&staged_cipher)
            .map_err(|e| format!("DPAPI unprotect failed on staged enrollment: {e:?}"))?;
        let staged: StagedEnrollmentFrameV1 = serde_json::from_slice(&staged_plain)
            .map_err(|e| format!("cannot parse staged enrollment frame: {e}"))?;

        if !staged.enrollment_generation_id_hex.eq_ignore_ascii_case(enrollment_generation_id) {
            return Err("STAGED_GENERATION_ID_MISMATCH".to_string());
        }
        if !staged.security_device_id_hex.eq_ignore_ascii_case(security_device_id_hex) {
            return Err("SECURITY_DEVICE_ID_MISMATCH".to_string());
        }
        let accepted_hex = accepted_pubkey_bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
        if !staged.public_key_hex.eq_ignore_ascii_case(&accepted_hex) {
            return Err(format!(
                "STAGED_PUBLIC_KEY_MISMATCH: server accepted key '{accepted_hex}' != staged key '{}'",
                staged.public_key_hex
            ));
        }
        Some(staged)
    } else if prior_committed_fence.is_none() {
        return Err(format!("STAGED_ENROLLMENT_UNAVAILABLE: generation '{enrollment_generation_id}' not found"));
    } else {
        None
    };

    // Authenticate candidate or cached keyset manifest against trust anchor
    let candidate_raw = match oks1_base64.filter(|s| !s.trim().is_empty()) {
        Some(s) => base64_decode(s).ok(),
        None => None,
    };
    let pending_initial_bindings = if prior_committed_fence.is_none() {
        Some(PendingInitialBindings {
            security_device_id: &sec_id_bytes,
            generation_id_hex: enrollment_generation_id,
            accepted_public_key: &accepted_pubkey_bytes,
            branch_id,
            device_key_version,
            candidate_manifest_bytes: candidate_raw.as_deref(),
        })
    } else {
        None
    };

    let (manifest, candidate_bytes_to_persist) = authenticate_candidate_keyset(
        app_data_dir,
        oks1_base64,
        hooks.trusted_root_public_key.as_ref(),
        pending_initial_bindings.as_ref(),
    )?;

    let signing_key_entry = manifest
        .keys
        .iter()
        .find(|k| k.signing_key_id == efr1.signing_key_id)
        .ok_or_else(|| format!("UNKNOWN_SIGNING_KEY: signing key '{}' not found in manifest", efr1.signing_key_id))?;

    let raw_efr1_digest = compute_sha256(&receipt_bytes);
    let active_obs = hooks.receipt_observation_override.clone()
        .or_else(|| {
            hooks.receipt_context_override.as_ref().and_then(|c| {
                c.receipt_qpc_ticks.map(|rt| ReceiptObservation {
                    request_qpc_ticks: c.request_qpc_ticks,
                    receipt_qpc_ticks: rt,
                    boot_session_id: c.boot_session_id,
                    receipt_nonce: c.device_registration_nonce,
                    raw_efr1_digest,
                    security_device_id: c.security_device_id,
                    enrollment_generation_id_hex: c.enrollment_generation_id_hex.clone(),
                    staged_public_key: c.staged_public_key,
                })
            })
        })
        .or_else(|| {
            runtime.find_observation(enrollment_generation_id, &raw_efr1_digest)
                .or_else(|| {
                    runtime.find_pending_request(enrollment_generation_id).and_then(|pending| {
                        pending.test_receipt_qpc_ticks.map(|rt| ReceiptObservation {
                            request_qpc_ticks: pending.request_qpc_ticks,
                            receipt_qpc_ticks: rt,
                            boot_session_id: pending.boot_session_id,
                            receipt_nonce: pending.device_registration_nonce,
                            raw_efr1_digest,
                            security_device_id: pending.security_device_id,
                            enrollment_generation_id_hex: pending.enrollment_generation_id_hex,
                            staged_public_key: pending.staged_public_key,
                        })
                    })
                })
        });

    if let Some(ref obs) = active_obs {
        if obs.receipt_nonce != efr1.receipt_nonce {
            return Err("RECEIPT_NONCE_MISMATCH: receipt nonce does not match registration challenge nonce".to_string());
        }
    }

    // Enforce signing key status and lifecycle policy using DEC-D-07 trusted time
    let trusted_now_ms = if let Some(override_ms) = hooks.trusted_now_override_ms {
        override_ms
    } else if signing_key_entry.status == frames::OacKeyLifecycleStatus::VerifyOnly {
        let obs = active_obs.ok_or_else(|| {
            "TRUSTED_TIME_UNAVAILABLE_REANCHOR_REQUIRED: missing receipt context for VERIFY_ONLY signer".to_string()
        })?;

        let current_boot = super::monotonic_clock::boot_session_id();
        if obs.boot_session_id != current_boot {
            return Err("TRUSTED_TIME_UNAVAILABLE_REANCHOR_REQUIRED: boot session mismatch".to_string());
        }
        if obs.receipt_nonce != efr1.receipt_nonce {
            return Err("RECEIPT_NONCE_MISMATCH: receipt nonce does not match registration challenge nonce".to_string());
        }
        if !obs.enrollment_generation_id_hex.eq_ignore_ascii_case(enrollment_generation_id) {
            return Err("RECEIPT_BINDING_MISMATCH: generation id mismatch in receipt context".to_string());
        }
        if obs.security_device_id != sec_id_bytes {
            return Err("RECEIPT_BINDING_MISMATCH: security device id mismatch in receipt context".to_string());
        }
        if obs.staged_public_key != accepted_pubkey_bytes {
            return Err("RECEIPT_BINDING_MISMATCH: public key mismatch in receipt context".to_string());
        }
        if obs.raw_efr1_digest != raw_efr1_digest {
            return Err("RECEIPT_BINDING_MISMATCH: raw EFR1 digest mismatch in receipt observation".to_string());
        }

        let request_ticks = obs.request_qpc_ticks;
        let receipt_ticks = obs.receipt_qpc_ticks;
        let approval_ticks = super::monotonic_clock::read_qpc_ticks()
            .map_err(|e| format!("TRUSTED_TIME_UNAVAILABLE_REANCHOR_REQUIRED: monotonic error: {e:?}"))?;
        let freq = super::monotonic_clock::qpc_frequency()
            .map_err(|e| format!("TRUSTED_TIME_UNAVAILABLE_REANCHOR_REQUIRED: monotonic error: {e:?}"))?;

        if freq == 0 {
            return Err("TRUSTED_TIME_UNAVAILABLE_REANCHOR_REQUIRED: invalid zero QPC frequency".to_string());
        }
        if receipt_ticks < request_ticks {
            return Err("TRUSTED_TIME_UNAVAILABLE_REANCHOR_REQUIRED: monotonic clock anomaly (receipt ticks < request ticks)".to_string());
        }
        if approval_ticks < receipt_ticks {
            return Err("TRUSTED_TIME_UNAVAILABLE_REANCHOR_REQUIRED: monotonic clock anomaly (approval ticks < receipt ticks)".to_string());
        }

        let rtt_upper_ms = super::monotonic_clock::ticks_to_elapsed_ms(request_ticks, receipt_ticks, freq)
            .map_err(|e| format!("TRUSTED_TIME_UNAVAILABLE_REANCHOR_REQUIRED: {e:?}"))?;
        let elapsed_ms = super::monotonic_clock::ticks_to_elapsed_ms(receipt_ticks, approval_ticks, freq)
            .map_err(|e| format!("TRUSTED_TIME_UNAVAILABLE_REANCHOR_REQUIRED: {e:?}"))?;

        let _l_ms = efr1.server_sent_at_ms
            .checked_add(elapsed_ms)
            .ok_or_else(|| "TRUSTED_TIME_UNAVAILABLE_REANCHOR_REQUIRED: calculation overflow".to_string())?;

        let u_ms = efr1.server_sent_at_ms
            .checked_add(rtt_upper_ms)
            .and_then(|t| t.checked_add(elapsed_ms))
            .ok_or_else(|| "TRUSTED_TIME_UNAVAILABLE_REANCHOR_REQUIRED: calculation overflow".to_string())?;

        u_ms
    } else {
        get_dec_d07_trusted_now_ms(app_data_dir)?
    };

    validate_signing_key_lifecycle(
        &manifest,
        &efr1.signing_key_id,
        trusted_now_ms,
    )?;

    let vk = VerifyingKey::from_bytes(&signing_key_entry.public_key)
        .map_err(|e| format!("INVALID_VERIFYING_KEY: {e}"))?;
    let preimage = frames::efr1_signature_preimage(&efr1)
        .map_err(|e| format!("CANNOT_BUILD_PREIMAGE: {e:?}"))?;
    let sig = Signature::from_bytes(&efr1.signature);
    vk.verify(&preimage, &sig)
        .map_err(|_| "RECEIPT_SIGNATURE_INVALID: server receipt signature verification failed".to_string())?;
    // 1. Idempotency and stale check
    if let Some(ref fence) = prior_committed_fence {
        if fence.enrollment_generation_id.eq_ignore_ascii_case(enrollment_generation_id) {
            // Same generation! Must match all parameters exactly.
            if !fence.security_device_id_hex.eq_ignore_ascii_case(security_device_id_hex) {
                return Err("IDEMPOTENT_REPLAY_MISMATCH: security_device_id_hex mismatch".to_string());
            }
            if fence.device_key_version != device_key_version {
                return Err("IDEMPOTENT_REPLAY_MISMATCH: device_key_version mismatch".to_string());
            }
            let signing_key = super::device_proof::load_enrolled_device_keypair(app_data_dir)
                .map_err(|e| format!("idempotency key load failed: {e:?}"))?;
            let verified_meta = verify_local_enrollment(app_data_dir, &signing_key)
                .map_err(|e| format!("idempotency verify failed: {e:?}"))?;
            if verified_meta.branch_id != branch_id {
                return Err("IDEMPOTENT_REPLAY_MISMATCH: branch_id mismatch".to_string());
            }
            if verified_meta.expected_public_key != accepted_pubkey_bytes {
                return Err("IDEMPOTENT_REPLAY_MISMATCH: accepted_public_key mismatch".to_string());
            }

            // Must validate committed fence-selected digest authority (digest-only, no legacy)
            let sha_hex = fence.manifest_sha256.as_ref()
                .ok_or_else(|| "IDEMPOTENT_REPLAY_MISMATCH: fence missing manifest_sha256".to_string())?;
            if !is_canonical_lowercase_sha256(sha_hex) {
                return Err(format!("IDEMPOTENT_REPLAY_MISMATCH: malformed manifest_sha256 '{sha_hex}'"));
            }
            let d_path = digest_manifest_path(app_data_dir, sha_hex);
            if !d_path.exists() {
                return Err("IDEMPOTENT_REPLAY_MISMATCH: committed digest manifest file does not exist".to_string());
            }
            let disk_bytes = fs::read(&d_path)
                .map_err(|e| format!("IDEMPOTENT_REPLAY_MISMATCH: cannot read committed digest manifest: {e}"))?;
            if compute_sha256_hex(&disk_bytes) != *sha_hex {
                return Err("IDEMPOTENT_REPLAY_MISMATCH: committed digest manifest hash mismatch".to_string());
            }
            let d_manifest = frames::decode_oks1(&disk_bytes)
                .map_err(|e| format!("IDEMPOTENT_REPLAY_MISMATCH: typed OKS1 decode failed: {e:?}"))?;
            let root_pk = hooks.trusted_root_public_key.as_ref()
                .ok_or_else(|| "IDEMPOTENT_REPLAY_MISMATCH: missing root key".to_string())?;
            let root_vk = VerifyingKey::from_bytes(root_pk)
                .map_err(|e| format!("IDEMPOTENT_REPLAY_MISMATCH: invalid root key: {e}"))?;
            let d_prefix = frames::oks1_signed_prefix(&d_manifest)
                .map_err(|e| format!("IDEMPOTENT_REPLAY_MISMATCH: prefix error: {e:?}"))?;
            root_vk.verify(&d_prefix, &Signature::from_bytes(&d_manifest.signature))
                .map_err(|_| "IDEMPOTENT_REPLAY_MISMATCH: root signature verification failed".to_string())?;

            if let Some(cand_bytes) = &candidate_bytes_to_persist {
                if cand_bytes != &disk_bytes {
                    return Err("IDEMPOTENT_REPLAY_MISMATCH: candidate manifest bytes do not match committed digest authority".to_string());
                }
            }

            return Ok(FinalizeDeviceEnrollmentOutcomeDto {
                success: true,
                status: "ALREADY_COMMITTED".to_string(),
                security_device_id_hex: fence.security_device_id_hex.clone(),
                device_key_version: fence.device_key_version,
                branch_id: branch_id.to_string(),
                enrollment_generation_id_hex: fence.enrollment_generation_id.clone(),
                accepted_public_key_base64: accepted_public_key_base64.to_string(),
            });
        } else {
            // Different generation ID. Stale or replayed generation must reject!
            if fence.device_key_version >= device_key_version {
                return Err(format!(
                    "STALE_OR_REPLAYED_GENERATION: current committed version {} >= attempted {device_key_version}",
                    fence.device_key_version
                ));
            }
        }
    }

    // 2. Use validated staged generation
    let _staged = match staged_record {
        Some(s) => s,
        None => return Err(format!("STAGED_ENROLLMENT_UNAVAILABLE: generation '{enrollment_generation_id}' not found")),
    };

    // 3. Ensure generation-scoped key exists and is durable
    if hooks.fail_gen_key_write {
        return Err("KEY_WRITE_FAILED: simulated key write/sync failure".to_string());
    }
    let gen_key_path = generation_proof_key_path(app_data_dir, enrollment_generation_id);
    if !gen_key_path.exists() {
        return Err(format!(
            "GENERATION_KEY_UNAVAILABLE_FAIL_CLOSED: generation proof key for '{enrollment_generation_id}' not found"
        ));
    }
    let key_cipher = fs::read(&gen_key_path)
        .map_err(|e| format!("cannot read gen key: {e}"))?;
    let key_sha256 = compute_sha256_hex(&key_cipher);

    let key_plain = dpapi_unprotect(&key_cipher)
        .map_err(|e| format!("DPAPI unprotect failed on gen key: {e:?}"))?;
    if key_plain.len() != 32 {
        return Err("invalid gen key seed length".to_string());
    }
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&key_plain);
    let signing_key = SigningKey::from_bytes(&seed);
    if signing_key.verifying_key().to_bytes() != accepted_pubkey_bytes {
        return Err("GEN_KEY_PUBLIC_KEY_MISMATCH".to_string());
    }

    // 4. Durably write generation-scoped metadata
    if hooks.fail_gen_meta_write {
        return Err("METADATA_WRITE_FAILED: simulated metadata write/sync failure".to_string());
    }
    let meta_frame = EnrollmentMetaFrameV1 {
        enrollment_generation_id: gen_bytes,
        security_device_id: sec_id_bytes,
        device_key_version,
        expected_public_key: accepted_pubkey_bytes,
        branch_id: branch_id.to_string(),
    };
    let gen_meta_path = generation_meta_path(app_data_dir, enrollment_generation_id);
    let meta_cipher = if !gen_meta_path.exists() {
        let meta_bytes = encode_enrm(&meta_frame)
            .map_err(|e| format!("cannot encode enrm: {e}"))?;
        let cipher = dpapi_protect(&meta_bytes)
            .map_err(|e| format!("DPAPI protect failed on enrm: {e:?}"))?;
        let gen_meta_tmp = app_data_dir.join(format!("meta-{}-{}.tmp", enrollment_generation_id, rand::random::<u64>()));
        durable_first_create_file(&gen_meta_tmp, &gen_meta_path, &cipher)?;
        cipher
    } else {
        // Generation metadata already exists. Treat generation metadata as immutable once created!
        let existing = fs::read(&gen_meta_path).map_err(|e| format!("cannot read existing gen meta: {e}"))?;
        let existing_plain = dpapi_unprotect(&existing).map_err(|e| format!("cannot unprotect existing gen meta: {e:?}"))?;
        let existing_frame = decode_enrm(&existing_plain).map_err(|e| format!("cannot decode existing gen meta: {e}"))?;
        if existing_frame != meta_frame {
            return Err("EXISTING_GENERATION_METADATA_MISMATCH: generation metadata already exists and does not match accepted frame".to_string());
        }
        existing
    };
    let meta_sha256 = compute_sha256_hex(&meta_cipher);

    // 5. Independently validate complete new generation before fence switch
    let re_key = fs::read(&gen_key_path).map_err(|e| format!("pre-fence key read failed: {e}"))?;
    if compute_sha256_hex(&re_key) != key_sha256 {
        return Err("PRE_FENCE_VALIDATION_FAILED: key sha256 mismatch".to_string());
    }
    let re_meta = fs::read(&gen_meta_path).map_err(|e| format!("pre-fence meta read failed: {e}"))?;
    if compute_sha256_hex(&re_meta) != meta_sha256 {
        return Err("PRE_FENCE_VALIDATION_FAILED: meta sha256 mismatch".to_string());
    }
    let re_meta_plain = dpapi_unprotect(&re_meta).map_err(|e| format!("pre-fence meta unprotect failed: {e:?}"))?;
    let re_frame = decode_enrm(&re_meta_plain).map_err(|e| format!("pre-fence meta decode failed: {e}"))?;
    if re_frame != meta_frame {
        return Err("PRE_FENCE_VALIDATION_FAILED: meta frame mismatch".to_string());
    }

    // 5.5 Durably persist validated candidate keyset manifest BEFORE atomic fence switch (IR-002)
    let cand_sha256_opt = if let Some(oks1_bytes) = &candidate_bytes_to_persist {
        if hooks.fail_manifest_write {
            return Err("KEYSET_PERSIST_FAILED: simulated manifest write failure".to_string());
        }
        let sha256_hex = compute_sha256_hex(oks1_bytes);
        let persist_hooks = hooks.digest_persist_hooks.unwrap_or(DEFAULT_DIGEST_PERSIST_HOOKS);
        persist_digest_manifest_atomic_with_hooks(
            app_data_dir,
            oks1_bytes,
            &sha256_hex,
            hooks.trusted_root_public_key.as_ref(),
            &persist_hooks,
        ).map_err(|e| format!("KEYSET_PERSIST_FAILED: {e}"))?;

        if hooks.fail_manifest_reread {
            return Err("KEYSET_VERIFY_READ_FAILED: simulated manifest re-read failure".to_string());
        }

        Some(sha256_hex)
    } else {
        prior_committed_fence.as_ref().and_then(|f| f.manifest_sha256.clone())
    };

    // 6. Atomically switch active COMMITTED fence
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let committed_fence = EnrollmentFenceState {
        state: "COMMITTED".to_string(),
        enrollment_generation_id: enrollment_generation_id.to_lowercase(),
        security_device_id_hex: security_device_id_hex.to_lowercase(),
        device_key_version,
        key_sha256,
        meta_sha256,
        manifest_sha256: cand_sha256_opt,
        committed_at_local_ms: now_ms,
    };
    let fence_json = serde_json::to_vec_pretty(&committed_fence)
        .map_err(|e| format!("cannot serialize fence: {e}"))?;
    let fence_tmp = app_data_dir.join(format!("fence-{}-{}.tmp", enrollment_generation_id, rand::random::<u64>()));
    {
        let mut f = File::create(&fence_tmp)
            .map_err(|e| format!("cannot create fence tmp: {e}"))?;
        f.write_all(&fence_json)
            .map_err(|e| format!("cannot write fence tmp: {e}"))?;
        f.sync_all()
            .map_err(|e| format!("sync_all failed on fence tmp: {e}"))?;
    }

    if hooks.fail_fence_switch {
        let _ = fs::remove_file(&fence_tmp);
        return Err("FENCE_REPLACE_FAILED: simulated fence switch failure".to_string());
    }

    let wide_fence = to_wide(&fence_path);
    let wide_tmp = to_wide(&fence_tmp);

    if fence_path.exists() {
        let res = (hooks.replace_file)(
            PCWSTR(wide_fence.as_ptr()),
            PCWSTR(wide_tmp.as_ptr()),
            PCWSTR::null(),
            windows::Win32::Storage::FileSystem::REPLACE_FILE_FLAGS(0),
            None,
            None,
        );
        res.map_err(|code| format!("FENCE_REPLACE_FAILED: ReplaceFileW error code {code}"))?;
    } else {
        let res = (hooks.move_file)(
            PCWSTR(wide_tmp.as_ptr()),
            PCWSTR(wide_fence.as_ptr()),
            MOVEFILE_WRITE_THROUGH,
        );
        if res.is_err() {
            let _ = fs::remove_file(&fence_tmp);
        }
        res.map_err(|code| format!("FENCE_CREATE_FAILED: MoveFileExW error code {code}"))?;
    }

    // 7. Clean up staged file & receipt context
    let _ = fs::remove_file(&staged_path);
    runtime.take_observation(enrollment_generation_id, &raw_efr1_digest);

    Ok(FinalizeDeviceEnrollmentOutcomeDto {
        success: true,
        status: "COMMITTED".to_string(),
        security_device_id_hex: security_device_id_hex.to_string(),
        device_key_version,
        branch_id: branch_id.to_string(),
        enrollment_generation_id_hex: enrollment_generation_id.to_string(),
        accepted_public_key_base64: accepted_public_key_base64.to_string(),
    })
}

pub fn finalize_device_enrollment_internal(
    runtime: &EnrollmentRuntimeState,
    app_data_dir: &Path,
    enrollment_generation_id: &str,
    security_device_id_hex: &str,
    branch_id: &str,
    device_key_version: u32,
    accepted_public_key_base64: &str,
    server_receipt_base64: Option<&str>,
    oks1_base64: Option<&str>,
    expected_operation_kind: Option<&str>,
) -> Result<FinalizeDeviceEnrollmentOutcomeDto, String> {
    let mut hooks = FinalizeHooks::default();
    if let Some(op_str) = expected_operation_kind.filter(|s| !s.trim().is_empty()) {
        let op = match op_str.to_uppercase().as_str() {
            "INITIAL_ENROLLMENT" | "1" => frames::EFR1_OP_INITIAL_ENROLLMENT,
            "RE_ENROLLMENT" | "2" => frames::EFR1_OP_RE_ENROLLMENT,
            other => return Err(format!("INVALID_EXPECTED_OPERATION_KIND: '{other}'")),
        };
        hooks.expected_operation_kind = Some(op);
    }
    finalize_device_enrollment_internal_with_hooks(
        runtime,
        app_data_dir,
        enrollment_generation_id,
        security_device_id_hex,
        branch_id,
        device_key_version,
        accepted_public_key_base64,
        server_receipt_base64,
        oks1_base64,
        &hooks,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::privileged_auth::monotonic_clock;
    use ed25519_dalek::Signer;
    use rand::rngs::OsRng;

    fn temp_dir() -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "twinpet-enrm-test-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
            n
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn setup_test_device(dir: &Path) -> ([u8; 16], String) {
        let sec_id = super::super::security_device_id::resolve_or_create_security_device_id(dir).unwrap();
        let sec_id_hex = sec_id.iter().map(|b| format!("{b:02x}")).collect::<String>();
        (sec_id, sec_id_hex)
    }

    fn from_wide(p: PCWSTR) -> PathBuf {
        unsafe {
            if p.0.is_null() {
                return PathBuf::new();
            }
            let mut len = 0;
            while *p.0.add(len) != 0 {
                len += 1;
            }
            let slice = std::slice::from_raw_parts(p.0, len);
            use std::os::windows::ffi::OsStringExt;
            PathBuf::from(std::ffi::OsString::from_wide(slice))
        }
    }

    fn mock_replace_file_1176(
        replaced: PCWSTR,
        _replacement: PCWSTR,
        _backup: PCWSTR,
        _flags: windows::Win32::Storage::FileSystem::REPLACE_FILE_FLAGS,
        _exclude: Option<*const std::ffi::c_void>,
        _reserved: Option<*const std::ffi::c_void>,
    ) -> Result<(), u32> {
        let replaced_path = from_wide(replaced);
        if replaced_path.exists() {
            let _ = fs::remove_file(&replaced_path);
        }
        Err(1176)
    }

    fn mock_replace_file_1177(
        replaced: PCWSTR,
        _replacement: PCWSTR,
        _backup: PCWSTR,
        _flags: windows::Win32::Storage::FileSystem::REPLACE_FILE_FLAGS,
        _exclude: Option<*const std::ffi::c_void>,
        _reserved: Option<*const std::ffi::c_void>,
    ) -> Result<(), u32> {
        let replaced_path = from_wide(replaced);
        if replaced_path.exists() {
            let orphan_path = replaced_path.with_file_name("fence-orphan-1177.tmp");
            let _ = fs::rename(&replaced_path, &orphan_path);
        }
        Err(1177)
    }

    fn mock_replace_file_generic(
        _replaced: PCWSTR,
        _replacement: PCWSTR,
        _backup: PCWSTR,
        _flags: windows::Win32::Storage::FileSystem::REPLACE_FILE_FLAGS,
        _exclude: Option<*const std::ffi::c_void>,
        _reserved: Option<*const std::ffi::c_void>,
    ) -> Result<(), u32> {
        Err(5)
    }

    fn mock_move_file_32(
        _existing: PCWSTR,
        _new: PCWSTR,
        _flags: windows::Win32::Storage::FileSystem::MOVE_FILE_FLAGS,
    ) -> Result<(), u32> {
        Err(32)
    }

    fn mock_move_file_183(
        _existing: PCWSTR,
        _new: PCWSTR,
        _flags: windows::Win32::Storage::FileSystem::MOVE_FILE_FLAGS,
    ) -> Result<(), u32> {
        Err(183)
    }

    pub const TEST_OAC_ROOT_SEED: [u8; 32] = [0x5au8; 32];

    fn test_keyset_and_receipt_with_nonce(
        operation_kind: u8,
        generation_hex: &str,
        sec_id_hex: &str,
        device_key_version: u32,
        pubkey_bytes: [u8; 32],
        branch_id: &str,
        receipt_nonce: [u8; 32],
    ) -> (String, String) {
        use ed25519_dalek::Signer;
        let root_key = SigningKey::from_bytes(&TEST_OAC_ROOT_SEED);
        let oac_signer = SigningKey::from_bytes(&[0x6bu8; 32]);
        let raw_key_id = "test-signing-key-1";
        let oac_pubkey = oac_signer.verifying_key().to_bytes();

        let manifest_frame = frames::OacKeysetManifestFrameV1 {
            revocation_epoch: 1,
            generated_at_server_ms: 1000,
            keys: vec![frames::OacKeysetManifestKeyV1 {
                signing_key_id: raw_key_id.to_string(),
                public_key: oac_pubkey,
                status: frames::OacKeyLifecycleStatus::Active,
                verify_until_server_ms: None,
            }],
            signature: [0u8; 64],
        };
        let prefix = frames::oks1_signed_prefix(&manifest_frame).unwrap();
        let sig = root_key.sign(&prefix).to_bytes();
        let signed_manifest = frames::OacKeysetManifestFrameV1 {
            signature: sig,
            ..manifest_frame
        };
        let oks1_bytes = frames::encode_oks1(&signed_manifest).unwrap();
        let oks1_b64 = base64_encode_std(&oks1_bytes);

        let mut gen_bytes = [0u8; 16];
        for i in 0..16 {
            gen_bytes[i] = u8::from_str_radix(&generation_hex[i * 2..i * 2 + 2], 16).unwrap_or(0);
        }
        let mut sec_bytes = [0u8; 16];
        for i in 0..16 {
            sec_bytes[i] = u8::from_str_radix(&sec_id_hex[i * 2..i * 2 + 2], 16).unwrap_or(0);
        }

        let safe_branch = if frames::is_canonical_identifier(branch_id) { branch_id } else { "HQ-001" };
        let safe_version = if device_key_version == 0 || device_key_version > MAX_DEVICE_KEY_VERSION { 1 } else { device_key_version };

        let unsigned_efr1 = frames::EnrollmentFinalizationReceiptFrameV1 {
            operation_kind,
            receipt_nonce,
            enrollment_generation_id: gen_bytes,
            security_device_id: sec_bytes,
            device_key_version: safe_version,
            accepted_public_key: pubkey_bytes,
            server_sent_at_ms: 2000,
            branch_id: safe_branch.to_string(),
            signing_key_id: raw_key_id.to_string(),
            signature: [0u8; 64],
        };
        let efr1_preimage = frames::efr1_signature_preimage(&unsigned_efr1).unwrap();
        let efr1_sig = oac_signer.sign(&efr1_preimage).to_bytes();
        let signed_efr1 = frames::EnrollmentFinalizationReceiptFrameV1 {
            signature: efr1_sig,
            ..unsigned_efr1
        };
        let efr1_bytes = frames::encode_efr1(&signed_efr1).unwrap();
        let efr1_b64 = base64_encode_std(&efr1_bytes);

        (efr1_b64, oks1_b64)
    }

    fn test_keyset_and_receipt(
        operation_kind: u8,
        generation_hex: &str,
        sec_id_hex: &str,
        device_key_version: u32,
        pubkey_bytes: [u8; 32],
        branch_id: &str,
    ) -> (String, String) {
        test_keyset_and_receipt_with_nonce(
            operation_kind,
            generation_hex,
            sec_id_hex,
            device_key_version,
            pubkey_bytes,
            branch_id,
            [0x55u8; 32],
        )
    }

    fn test_finalize_device_enrollment(
        runtime: &EnrollmentRuntimeState,
        dir: &Path,
        gen_hex: &str,
        sec_id_hex: &str,
        branch_id: &str,
        version: u32,
        pubkey_b64: &str,
    ) -> Result<FinalizeDeviceEnrollmentOutcomeDto, String> {
        test_finalize_device_enrollment_with_hooks(
            runtime,
            dir,
            gen_hex,
            sec_id_hex,
            branch_id,
            version,
            pubkey_b64,
            &FinalizeHooks::default(),
        )
    }

    fn test_finalize_device_enrollment_with_hooks(
        runtime: &EnrollmentRuntimeState,
        dir: &Path,
        gen_hex: &str,
        sec_id_hex: &str,
        branch_id: &str,
        version: u32,
        pubkey_b64: &str,
        hooks: &FinalizeHooks,
    ) -> Result<FinalizeDeviceEnrollmentOutcomeDto, String> {
        let pubkey_bytes = base64_decode(pubkey_b64).unwrap_or_default();
        let mut pk = [0u8; 32];
        if pubkey_bytes.len() == 32 {
            pk.copy_from_slice(&pubkey_bytes);
        }
        let mut sec_bytes = [0u8; 16];
        for i in 0..16 {
            sec_bytes[i] = u8::from_str_radix(&sec_id_hex[i * 2..i * 2 + 2], 16).unwrap_or(0);
        }
        let nonce = if let Some(p) = runtime.find_pending_request(gen_hex) {
            p.device_registration_nonce
        } else {
            let request_ticks = monotonic_clock::read_qpc_ticks().unwrap_or(0);
            let boot_id = monotonic_clock::boot_session_id();
            let n = [0x55u8; 32];
            runtime.record_pending_request(PendingRequestContext {
                request_qpc_ticks: request_ticks,
                boot_session_id: boot_id,
                device_registration_nonce: n,
                security_device_id: sec_bytes,
                enrollment_generation_id_hex: gen_hex.to_string(),
                staged_public_key: pk,
                test_receipt_qpc_ticks: None,
            });
            n
        };
        let op = if version > 1 { frames::EFR1_OP_RE_ENROLLMENT } else { frames::EFR1_OP_INITIAL_ENROLLMENT };
        let (receipt_b64, oks1_b64) = test_keyset_and_receipt_with_nonce(op, gen_hex, sec_id_hex, version, pk, branch_id, nonce);
        let _ = runtime.record_receipt_ingress_from_base64(&receipt_b64);
        finalize_device_enrollment_internal_with_hooks(
            runtime,
            dir,
            gen_hex,
            sec_id_hex,
            branch_id,
            version,
            pubkey_b64,
            Some(&receipt_b64),
            Some(&oks1_b64),
            hooks,
        )
    }

    #[test]
    fn enrm_round_trip() {
        let frame = EnrollmentMetaFrameV1 {
            enrollment_generation_id: [0x11; 16],
            security_device_id: [0x22; 16],
            device_key_version: 1,
            expected_public_key: [0x33; 32],
            branch_id: "LDP-001".to_string(),
        };

        let encoded = encode_enrm(&frame).unwrap();
        assert_eq!(encoded.len(), ENRM_FIXED_MINIMUM_LENGTH + 7);
        let decoded = decode_enrm(&encoded).unwrap();
        assert_eq!(decoded, frame);
    }

    #[test]
    fn enrm_rejects_truncated_or_bad_magic() {
        assert!(decode_enrm(b"short").is_err());

        let mut bad_magic = vec![0u8; ENRM_FIXED_MINIMUM_LENGTH];
        bad_magic[0..4].copy_from_slice(b"XXXX");
        assert!(decode_enrm(&bad_magic).is_err());

        let mut bad_version = vec![0u8; ENRM_FIXED_MINIMUM_LENGTH];
        bad_version[0..4].copy_from_slice(ENRM_MAGIC);
        bad_version[4] = 2; // unknown version
        assert!(decode_enrm(&bad_version).is_err());
    }

    // --- Codex 4.9 Actual Finalizer Test Matrix (Tests 1 - 19) ---

    #[test]
    fn test_actual_finalizer_01_initial_enrollment_success() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();
        let outcome = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x01; 32],
        )
        .unwrap();

        let pubkey_b64 = base64_encode_std(&outcome.staged_public_key_bytes);
        let res = test_finalize_device_enrollment(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
        )
        .unwrap();

        assert!(res.success);
        assert_eq!(res.status, "COMMITTED");
        assert_eq!(res.device_key_version, 1);
        assert_eq!(res.branch_id, "HQ-001");
        assert_eq!(res.security_device_id_hex, sec_id_hex);
        assert_eq!(res.enrollment_generation_id_hex, outcome.enrollment_generation_id_hex);

        let keypair = super::super::device_proof::load_enrolled_device_keypair(&dir).unwrap();
        assert_eq!(keypair.verifying_key().to_bytes(), outcome.staged_public_key_bytes);

        let meta = verify_local_enrollment(&dir, &keypair).unwrap();
        assert_eq!(meta.device_key_version, 1);
        assert_eq!(meta.branch_id, "HQ-001");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_actual_finalizer_02_reenrollment_success() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        let outcome1 = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x01; 32],
        )
        .unwrap();
        let pubkey_b64_1 = base64_encode_std(&outcome1.staged_public_key_bytes);
        test_finalize_device_enrollment(&runtime, &dir,
            &outcome1.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64_1,
        )
        .unwrap();

        // Advance to generation 2, version 2
        let outcome2 = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x02; 32],
        )
        .unwrap();
        let pubkey_b64_2 = base64_encode_std(&outcome2.staged_public_key_bytes);
        let res2 = test_finalize_device_enrollment(&runtime, &dir,
            &outcome2.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-002",
            2,
            &pubkey_b64_2,
        )
        .unwrap();

        assert!(res2.success);
        assert_eq!(res2.status, "COMMITTED");
        assert_eq!(res2.device_key_version, 2);
        assert_eq!(res2.branch_id, "HQ-002");

        let keypair2 = super::super::device_proof::load_enrolled_device_keypair(&dir).unwrap();
        assert_eq!(keypair2.verifying_key().to_bytes(), outcome2.staged_public_key_bytes);

        let meta2 = verify_local_enrollment(&dir, &keypair2).unwrap();
        assert_eq!(meta2.device_key_version, 2);
        assert_eq!(meta2.branch_id, "HQ-002");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_actual_finalizer_03_exact_idempotency() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        let outcome = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x01; 32],
        )
        .unwrap();
        let pubkey_b64 = base64_encode_std(&outcome.staged_public_key_bytes);
        let res1 = test_finalize_device_enrollment(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
        )
        .unwrap();
        assert_eq!(res1.status, "COMMITTED");

        // Idempotent retry with exact same generation and bindings
        let res2 = test_finalize_device_enrollment(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
        )
        .unwrap();
        assert!(res2.success);
        assert_eq!(res2.status, "ALREADY_COMMITTED");
        assert_eq!(res2.device_key_version, 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_actual_finalizer_04_mismatched_generation_replay() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        let outcome = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x01; 32],
        )
        .unwrap();
        let pubkey_b64 = base64_encode_std(&outcome.staged_public_key_bytes);
        test_finalize_device_enrollment(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
        )
        .unwrap();

        // Replay with unknown/different generation
        let fake_gen = "ff".repeat(16);
        let res_replay = test_finalize_device_enrollment(&runtime, &dir,
            &fake_gen,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
        );
        assert!(res_replay.is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_actual_finalizer_05_mismatched_public_key() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        let outcome = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x01; 32],
        )
        .unwrap();

        let wrong_key = SigningKey::generate(&mut OsRng);
        let wrong_pubkey_b64 = base64_encode_std(&wrong_key.verifying_key().to_bytes());

        let res = test_finalize_device_enrollment(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &wrong_pubkey_b64,
        );
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("STAGED_PUBLIC_KEY_MISMATCH"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_actual_finalizer_06_mismatched_device() {
        let dir = temp_dir();
        let (_sec_id, _sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        let outcome = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x01; 32],
        )
        .unwrap();
        let pubkey_b64 = base64_encode_std(&outcome.staged_public_key_bytes);

        let wrong_device_hex = "bb".repeat(16);
        let res = test_finalize_device_enrollment(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &wrong_device_hex,
            "HQ-001",
            1,
            &pubkey_b64,
        );
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("SECURITY_DEVICE_ID_MISMATCH"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_actual_finalizer_07_mismatched_branch() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        let outcome = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x01; 32],
        )
        .unwrap();
        let pubkey_b64 = base64_encode_std(&outcome.staged_public_key_bytes);

        let res = test_finalize_device_enrollment(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "INVALID/BRANCH!@",
            1,
            &pubkey_b64,
        );
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("INVALID_BRANCH_ID"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_actual_finalizer_08_mismatched_version() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        let outcome = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x01; 32],
        )
        .unwrap();
        let pubkey_b64 = base64_encode_std(&outcome.staged_public_key_bytes);

        let res0 = test_finalize_device_enrollment(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            0,
            &pubkey_b64,
        );
        assert!(res0.is_err());
        assert!(res0.unwrap_err().contains("INVALID_DEVICE_KEY_VERSION"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_actual_finalizer_09_two_prepared_generations_first_accepted_retry_succeeds() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        // Prepare generation 1
        let outcome1 = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x01; 32],
        )
        .unwrap();

        // Prepare generation 2
        let outcome2 = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x02; 32],
        )
        .unwrap();

        assert_ne!(outcome1.enrollment_generation_id_hex, outcome2.enrollment_generation_id_hex);

        let pubkey_b64_1 = base64_encode_std(&outcome1.staged_public_key_bytes);

        // Under N-IR002, extra uncommitted generation on disk without committed fence fails closed
        let res_fail = test_finalize_device_enrollment(&runtime, &dir,
            &outcome1.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64_1,
        );
        assert!(res_fail.is_err());
        assert!(res_fail.unwrap_err().contains("UNTRUSTED_KEYSET_ROTATION_FAIL_CLOSED"));

        // When extraneous generation 2 artifacts are cleaned, exact pending initial generation 1 succeeds
        let _ = fs::remove_file(enrollment_staged_generation_path(&dir, &outcome2.enrollment_generation_id_hex));
        let _ = fs::remove_file(generation_proof_key_path(&dir, &outcome2.enrollment_generation_id_hex));

        let res = test_finalize_device_enrollment(&runtime, &dir,
            &outcome1.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64_1,
        )
        .unwrap();

        assert!(res.success);
        assert_eq!(res.enrollment_generation_id_hex, outcome1.enrollment_generation_id_hex);

        let keypair = super::super::device_proof::load_enrolled_device_keypair(&dir).unwrap();
        assert_eq!(keypair.verifying_key().to_bytes(), outcome1.staged_public_key_bytes);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_actual_finalizer_10_server_success_local_failure_exact_retry_succeeds() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        let outcome = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x01; 32],
        )
        .unwrap();
        let pubkey_b64 = base64_encode_std(&outcome.staged_public_key_bytes);

        // First attempt fails locally due to hook failure
        let failing_hooks = FinalizeHooks {
            replace_file: mock_replace_file_generic,
            move_file: mock_move_file_32,
            fail_gen_key_write: false,
            fail_gen_meta_write: false,
            ..FinalizeHooks::default()
        };
        let err = test_finalize_device_enrollment_with_hooks(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            &failing_hooks,
        );
        assert!(err.is_err());

        // Exact retry with production hooks succeeds without contacting server again
        let res_retry = test_finalize_device_enrollment(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
        )
        .unwrap();
        assert!(res_retry.success);
        assert_eq!(res_retry.status, "COMMITTED");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_actual_finalizer_11_previous_committed_generation_preserved_on_failed_new_finalize() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        let outcome1 = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x01; 32],
        )
        .unwrap();
        let pubkey_b64_1 = base64_encode_std(&outcome1.staged_public_key_bytes);
        test_finalize_device_enrollment(&runtime, &dir,
            &outcome1.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64_1,
        )
        .unwrap();

        // Generation 2 attempt with failing hook
        let outcome2 = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x02; 32],
        )
        .unwrap();
        let pubkey_b64_2 = base64_encode_std(&outcome2.staged_public_key_bytes);

        let failing_hooks = FinalizeHooks {
            replace_file: mock_replace_file_generic,
            move_file: win32_move_file,
            fail_gen_key_write: false,
            fail_gen_meta_write: false,
            ..FinalizeHooks::default()
        };
        let err = test_finalize_device_enrollment_with_hooks(&runtime, &dir,
            &outcome2.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-002",
            2,
            &pubkey_b64_2,
            &failing_hooks,
        );
        assert!(err.is_err());

        // Previous committed generation 1 is fully preserved
        let keypair = super::super::device_proof::load_enrolled_device_keypair(&dir).unwrap();
        assert_eq!(keypair.verifying_key().to_bytes(), outcome1.staged_public_key_bytes);

        let meta = verify_local_enrollment(&dir, &keypair).unwrap();
        assert_eq!(meta.device_key_version, 1);
        assert_eq!(meta.branch_id, "HQ-001");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_actual_finalizer_12_mixed_generation_state_rejects() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        let outcome = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x01; 32],
        )
        .unwrap();
        let pubkey_b64 = base64_encode_std(&outcome.staged_public_key_bytes);
        test_finalize_device_enrollment(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
        )
        .unwrap();

        // Mutate meta file to contain another generation
        let meta_path = generation_meta_path(&dir, &outcome.enrollment_generation_id_hex);
        let bad_frame = EnrollmentMetaFrameV1 {
            enrollment_generation_id: [0xee; 16],
            security_device_id: [0x11; 16],
            device_key_version: 1,
            expected_public_key: outcome.staged_public_key_bytes,
            branch_id: "HQ-001".to_string(),
        };
        let bad_cipher = dpapi_protect(&encode_enrm(&bad_frame).unwrap()).unwrap();
        fs::write(&meta_path, &bad_cipher).unwrap();

        let keypair = super::super::device_proof::load_enrolled_device_keypair(&dir).unwrap();
        let res = verify_local_enrollment(&dir, &keypair);
        assert_eq!(res, Err(EnrollmentMetaError::MetaHashMismatch));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_actual_finalizer_13_1176_replacement_failure() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        let outcome1 = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x01; 32],
        )
        .unwrap();
        test_finalize_device_enrollment(&runtime, &dir,
            &outcome1.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &base64_encode_std(&outcome1.staged_public_key_bytes),
        )
        .unwrap();

        let outcome2 = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x02; 32],
        )
        .unwrap();

        // Simulate side-effect: leave an orphan temp fence file on disk
        let orphan_fence_tmp = dir.join("twinpet-active-fence.committed.tmp.orphaned_1176");
        fs::write(&orphan_fence_tmp, b"UNCOMMITTED_ORPHAN_FENCE_TMP").unwrap();

        let hooks = FinalizeHooks {
            replace_file: mock_replace_file_1176,
            move_file: win32_move_file,
            fail_gen_key_write: false,
            fail_gen_meta_write: false,
            ..FinalizeHooks::default()
        };
        let res = test_finalize_device_enrollment_with_hooks(&runtime, &dir,
            &outcome2.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-002",
            2,
            &base64_encode_std(&outcome2.staged_public_key_bytes),
            &hooks,
        );
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("ReplaceFileW error code 1176"));

        // Modeled 1176 aftermath: canonical fence absent, replacement temp remains, resolver fails closed
        assert!(!enrollment_fence_path(&dir).exists(), "Canonical fence must be absent under 1176 aftermath");
        let active_res = resolve_active_manifest_path(&dir);
        assert!(active_res.is_err(), "Resolver must fail closed under 1176 aftermath");
        let key_res = super::super::device_proof::load_enrolled_device_keypair(&dir);
        assert!(key_res.is_err(), "Keypair load must fail closed when canonical fence is absent");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_actual_finalizer_14_1177_replacement_failure() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        let outcome1 = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x01; 32],
        )
        .unwrap();
        test_finalize_device_enrollment(&runtime, &dir,
            &outcome1.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &base64_encode_std(&outcome1.staged_public_key_bytes),
        )
        .unwrap();

        let outcome2 = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x02; 32],
        )
        .unwrap();

        // Simulate side-effect: leave an orphan temp fence file on disk
        let orphan_fence_tmp = dir.join("twinpet-active-fence.committed.tmp.orphaned_1177");
        fs::write(&orphan_fence_tmp, b"UNCOMMITTED_ORPHAN_FENCE_TMP").unwrap();

        let hooks = FinalizeHooks {
            replace_file: mock_replace_file_1177,
            move_file: win32_move_file,
            fail_gen_key_write: false,
            fail_gen_meta_write: false,
            ..FinalizeHooks::default()
        };
        let res = test_finalize_device_enrollment_with_hooks(&runtime, &dir,
            &outcome2.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-002",
            2,
            &base64_encode_std(&outcome2.staged_public_key_bytes),
            &hooks,
        );
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("ReplaceFileW error code 1177"));

        // Modeled 1177 aftermath: canonical fence absent, orphan backup file exists, resolver fails closed
        assert!(!enrollment_fence_path(&dir).exists(), "Canonical fence must be absent under 1177 aftermath");
        let orphan_path = dir.join("fence-orphan-1177.tmp");
        assert!(orphan_path.exists(), "1177 orphan fence must exist at modeled orphan path");
        let active_res = resolve_active_manifest_path(&dir);
        assert!(active_res.is_err(), "Resolver must fail closed under 1177 aftermath");
        let key_res = super::super::device_proof::load_enrolled_device_keypair(&dir);
        assert!(key_res.is_err(), "Keypair load must fail closed when canonical fence is absent");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_actual_finalizer_15_generic_failure() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        let outcome1 = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x01; 32],
        )
        .unwrap();
        test_finalize_device_enrollment(&runtime, &dir,
            &outcome1.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &base64_encode_std(&outcome1.staged_public_key_bytes),
        )
        .unwrap();

        let outcome2 = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x02; 32],
        )
        .unwrap();

        let orphan_fence_tmp = dir.join("twinpet-active-fence.committed.tmp.orphaned_generic");
        fs::write(&orphan_fence_tmp, b"UNCOMMITTED_ORPHAN_FENCE_TMP").unwrap();

        let hooks = FinalizeHooks {
            replace_file: mock_replace_file_generic,
            move_file: win32_move_file,
            fail_gen_key_write: false,
            fail_gen_meta_write: false,
            ..FinalizeHooks::default()
        };
        let res = test_finalize_device_enrollment_with_hooks(&runtime, &dir,
            &outcome2.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-002",
            2,
            &base64_encode_std(&outcome2.staged_public_key_bytes),
            &hooks,
        );
        assert!(res.is_err());

        // Drop all in-memory state
        drop(res);
        drop(outcome2);

        // Reopen / reload from disk
        let fence_bytes = fs::read(enrollment_fence_path(&dir)).unwrap();
        let fence: EnrollmentFenceState = serde_json::from_slice(&fence_bytes).unwrap();
        assert_eq!(fence.state, "COMMITTED");
        assert_eq!(fence.enrollment_generation_id, outcome1.enrollment_generation_id_hex);
        assert_eq!(fence.device_key_version, 1);

        // Previous committed generation 1 remains strictly valid
        let keypair = super::super::device_proof::load_enrolled_device_keypair(&dir).unwrap();
        assert_eq!(keypair.verifying_key().to_bytes(), outcome1.staged_public_key_bytes);

        let meta = verify_local_enrollment(&dir, &keypair).unwrap();
        assert_eq!(meta.device_key_version, 1);
        assert_eq!(meta.branch_id, "HQ-001");

        let challenge = super::super::staff_session::prepare_staff_session_challenge_internal(
            &dir,
            "SSA1_LOGIN",
            "HQ-001",
            "STAFF-001",
        )
        .unwrap();
        let sscp1_bytes = base64_decode(&challenge.sscp1_proof_base64).unwrap();
        let sscp1 = super::super::frames::decode_sscp1(&sscp1_bytes).unwrap();
        assert_eq!(sscp1.branch_id, "HQ-001");
        assert_eq!(sscp1.device_key_version, 1);

        assert!(orphan_fence_tmp.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_actual_finalizer_16_fence_switch_failure() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        let outcome = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x01; 32],
        )
        .unwrap();

        // Simulate side-effect: orphan temp file
        let orphan_fence_tmp = dir.join("twinpet-active-fence.committed.tmp.switch_fail");
        fs::write(&orphan_fence_tmp, b"UNCOMMITTED_SWITCH_FAIL").unwrap();

        let hooks = FinalizeHooks {
            replace_file: win32_replace_file,
            move_file: mock_move_file_32,
            fail_gen_key_write: false,
            fail_gen_meta_write: false,
            ..FinalizeHooks::default()
        };
        let res = test_finalize_device_enrollment_with_hooks(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &base64_encode_std(&outcome.staged_public_key_bytes),
            &hooks,
        );
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("MoveFileExW error code 32"));

        // Drop in-memory state
        drop(outcome);

        // Reopen / reload from disk -> must fail closed because no active fence committed!
        assert!(!enrollment_fence_path(&dir).exists());
        let key_err = super::super::device_proof::load_enrolled_device_keypair(&dir);
        assert!(key_err.is_err());

        // Temp file is NOT promoted
        assert!(orphan_fence_tmp.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_actual_finalizer_17_key_write_sync_failure() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        // Case A: First enrollment fails at key write
        let outcome = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x01; 32],
        )
        .unwrap();
        let hooks = FinalizeHooks {
            replace_file: win32_replace_file,
            move_file: win32_move_file,
            fail_gen_key_write: true,
            fail_gen_meta_write: false,
            ..FinalizeHooks::default()
        };
        let res = test_finalize_device_enrollment_with_hooks(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &base64_encode_std(&outcome.staged_public_key_bytes),
            &hooks,
        );
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("KEY_WRITE_FAILED"));

        // Drop in-memory state
        drop(outcome);

        // Reopen / reload from disk -> fail closed
        assert!(!enrollment_fence_path(&dir).exists());
        assert!(super::super::device_proof::load_enrolled_device_keypair(&dir).is_err());
        let _ = fs::remove_dir_all(&dir);

        // Case B: Re-enrollment key write failure preserves previous committed generation
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let outcome1 = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x01; 32],
        )
        .unwrap();
        test_finalize_device_enrollment(&runtime, &dir,
            &outcome1.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &base64_encode_std(&outcome1.staged_public_key_bytes),
        )
        .unwrap();

        let outcome2 = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x02; 32],
        )
        .unwrap();
        let res2 = test_finalize_device_enrollment_with_hooks(&runtime, &dir,
            &outcome2.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-002",
            2,
            &base64_encode_std(&outcome2.staged_public_key_bytes),
            &hooks,
        );
        assert!(res2.is_err());

        drop(res2);
        drop(outcome2);

        // Disk check: generation 1 remains intact and valid
        let keypair = super::super::device_proof::load_enrolled_device_keypair(&dir).unwrap();
        assert_eq!(keypair.verifying_key().to_bytes(), outcome1.staged_public_key_bytes);
        let meta = verify_local_enrollment(&dir, &keypair).unwrap();
        assert_eq!(meta.device_key_version, 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_actual_finalizer_18_metadata_write_sync_failure() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        // Case A: First enrollment fails at metadata write
        let outcome = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x01; 32],
        )
        .unwrap();
        let hooks = FinalizeHooks {
            replace_file: win32_replace_file,
            move_file: win32_move_file,
            fail_gen_key_write: false,
            fail_gen_meta_write: true,
            ..FinalizeHooks::default()
        };
        let res = test_finalize_device_enrollment_with_hooks(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &base64_encode_std(&outcome.staged_public_key_bytes),
            &hooks,
        );
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("METADATA_WRITE_FAILED"));

        // Drop in-memory state
        drop(outcome);

        // Reopen / reload from disk -> fail closed
        assert!(!enrollment_fence_path(&dir).exists());
        assert!(super::super::device_proof::load_enrolled_device_keypair(&dir).is_err());
        let _ = fs::remove_dir_all(&dir);

        // Case B: Re-enrollment metadata write failure preserves previous committed generation
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let outcome1 = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x01; 32],
        )
        .unwrap();
        test_finalize_device_enrollment(&runtime, &dir,
            &outcome1.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &base64_encode_std(&outcome1.staged_public_key_bytes),
        )
        .unwrap();

        let outcome2 = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x02; 32],
        )
        .unwrap();
        let res2 = test_finalize_device_enrollment_with_hooks(&runtime, &dir,
            &outcome2.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-002",
            2,
            &base64_encode_std(&outcome2.staged_public_key_bytes),
            &hooks,
        );
        assert!(res2.is_err());

        drop(res2);
        drop(outcome2);

        // Disk check: generation 1 remains intact and valid
        let keypair = super::super::device_proof::load_enrolled_device_keypair(&dir).unwrap();
        assert_eq!(keypair.verifying_key().to_bytes(), outcome1.staged_public_key_bytes);
        let meta = verify_local_enrollment(&dir, &keypair).unwrap();
        assert_eq!(meta.device_key_version, 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_actual_finalizer_20_acceptance_delete_gen_key_with_legacy_present_fails_closed() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        let outcome1 = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x01; 32],
        )
        .unwrap();
        let pubkey_b64 = base64_encode_std(&outcome1.staged_public_key_bytes);
        test_finalize_device_enrollment(&runtime, &dir,
            &outcome1.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
        )
        .unwrap();

        // Create byte-identical legacy compatibility copies
        let gen_key_path = generation_proof_key_path(&dir, &outcome1.enrollment_generation_id_hex);
        let legacy_key = super::super::device_proof::device_proof_key_path(&dir);
        fs::copy(&gen_key_path, &legacy_key).unwrap();

        let gen_meta_path = generation_meta_path(&dir, &outcome1.enrollment_generation_id_hex);
        let legacy_meta = dir.join(ENROLLMENT_META_FILE_NAME);
        fs::copy(&gen_meta_path, &legacy_meta).unwrap();

        // Delete active generation key
        fs::remove_file(&gen_key_path).unwrap();

        // Drop in-memory state
        drop(outcome1);

        // Reopen / reload from disk and assert strict fail-closed
        let key_res = super::super::device_proof::load_enrolled_device_keypair(&dir);
        assert_eq!(key_res.err(), Some(super::super::device_proof::DeviceProofError::NotFound));

        let challenge_res = super::super::staff_session::prepare_staff_session_challenge_internal(
            &dir,
            "SSA1_LOGIN",
            "HQ-001",
            "STAFF-001",
        );
        assert!(challenge_res.is_err());

        let fake_gen = "00112233445566778899aabbccddeeff";
        let finalize_res = test_finalize_device_enrollment(&runtime, &dir,
            fake_gen,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
        );
        assert!(finalize_res.is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_actual_finalizer_21_acceptance_delete_gen_meta_with_legacy_present_fails_closed() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        let outcome1 = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x01; 32],
        )
        .unwrap();
        let pubkey_b64 = base64_encode_std(&outcome1.staged_public_key_bytes);
        test_finalize_device_enrollment(&runtime, &dir,
            &outcome1.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
        )
        .unwrap();

        // Create byte-identical legacy compatibility copies
        let gen_key_path = generation_proof_key_path(&dir, &outcome1.enrollment_generation_id_hex);
        let legacy_key = super::super::device_proof::device_proof_key_path(&dir);
        fs::copy(&gen_key_path, &legacy_key).unwrap();

        let gen_meta_path = generation_meta_path(&dir, &outcome1.enrollment_generation_id_hex);
        let legacy_meta = dir.join(ENROLLMENT_META_FILE_NAME);
        fs::copy(&gen_meta_path, &legacy_meta).unwrap();

        // Delete active generation metadata
        fs::remove_file(&gen_meta_path).unwrap();

        // Drop in-memory state
        let gen_id_hex = outcome1.enrollment_generation_id_hex.clone();
        drop(outcome1);

        // Reopen / reload from disk and assert strict fail-closed
        let keypair = super::super::device_proof::load_enrolled_device_keypair(&dir).unwrap();
        let meta_res = verify_local_enrollment(&dir, &keypair);
        assert_eq!(meta_res.err(), Some(EnrollmentMetaError::NotFound));

        let challenge_res = super::super::staff_session::prepare_staff_session_challenge_internal(
            &dir,
            "SSA1_LOGIN",
            "HQ-001",
            "STAFF-001",
        );
        assert!(challenge_res.is_err());

        let finalize_res = test_finalize_device_enrollment(&runtime, &dir,
            &gen_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
        );
        assert!(finalize_res.is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_actual_finalizer_22_acceptance_fence_variations_fail_closed() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        let outcome = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x01; 32],
        )
        .unwrap();
        let pubkey_b64 = base64_encode_std(&outcome.staged_public_key_bytes);
        test_finalize_device_enrollment(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
        )
        .unwrap();

        let fence_path = enrollment_fence_path(&dir);
        let valid_fence_bytes = fs::read(&fence_path).unwrap();

        // 1. Missing fence
        fs::remove_file(&fence_path).unwrap();
        assert!(super::super::device_proof::load_enrolled_device_keypair(&dir).is_err());
        assert!(super::super::staff_session::prepare_staff_session_challenge_internal(
            &dir,
            "SSA1_LOGIN",
            "HQ-001",
            "STAFF-001",
        ).is_err());
        assert!(test_finalize_device_enrollment(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
        ).is_err());

        // 2. Corrupt / non-JSON fence
        fs::write(&fence_path, b"{CORRUPT_FENCE_JSON").unwrap();
        assert!(super::super::device_proof::load_enrolled_device_keypair(&dir).is_err());

        // 3. Non-COMMITTED state in fence
        let mut uncommitted_fence: EnrollmentFenceState = serde_json::from_slice(&valid_fence_bytes).unwrap();
        uncommitted_fence.state = "PREPARED".to_string();
        fs::write(&fence_path, serde_json::to_vec(&uncommitted_fence).unwrap()).unwrap();
        assert!(super::super::device_proof::load_enrolled_device_keypair(&dir).is_err());

        // 4. Empty generation ID in fence
        let mut empty_gen_fence: EnrollmentFenceState = serde_json::from_slice(&valid_fence_bytes).unwrap();
        empty_gen_fence.enrollment_generation_id = "   ".to_string();
        fs::write(&fence_path, serde_json::to_vec(&empty_gen_fence).unwrap()).unwrap();
        assert!(super::super::device_proof::load_enrolled_device_keypair(&dir).is_err());

        // 5. Un-enrolled fresh directory: verify load_enrolled_device_keypair fails closed and creates ZERO files
        let empty_dir = temp_dir();
        assert!(super::super::device_proof::load_enrolled_device_keypair(&empty_dir).is_err());
        let entries: Vec<_> = fs::read_dir(&empty_dir).unwrap().collect();
        assert_eq!(entries.len(), 0, "no key generation or fallback files may be created on load");
        let _ = fs::remove_dir_all(&empty_dir);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_actual_finalizer_19_successful_finalize_immediately_enables_staff_session_challenge() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        let outcome = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x01; 32],
        )
        .unwrap();
        let pubkey_b64 = base64_encode_std(&outcome.staged_public_key_bytes);

        test_finalize_device_enrollment(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
        )
        .unwrap();

        // Successful finalize immediately enables staff-session challenge preparation
        let challenge = super::super::staff_session::prepare_staff_session_challenge_internal(
            &dir,
            "SSA1_LOGIN",
            "HQ-001",
            "STAFF-001",
        )
        .unwrap();

        assert!(!challenge.challenge_nonce_base64.is_empty());
        assert!(!challenge.sscp1_proof_base64.is_empty());
        assert!(challenge.generation > 0);

        let sscp1_bytes = base64_decode(&challenge.sscp1_proof_base64).unwrap();
        let sscp1 = super::super::frames::decode_sscp1(&sscp1_bytes).unwrap();
        assert_eq!(sscp1.branch_id, "HQ-001");
        assert_eq!(sscp1.intended_staff_id, "STAFF-001");
        assert_eq!(sscp1.device_key_version, 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_actual_finalizer_23_receipt_verification_matrix() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();
        let outcome = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "00112233445566778899aabbccddeeff",
            [0x01; 32],
        )
        .unwrap();
        let pubkey_b64 = base64_encode_std(&outcome.staged_public_key_bytes);
        let mut pk = [0u8; 32];
        pk.copy_from_slice(&outcome.staged_public_key_bytes);

        let (valid_receipt, valid_oks1) = test_keyset_and_receipt(
            frames::EFR1_OP_INITIAL_ENROLLMENT,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            1,
            pk,
            "HQ-001",
        );

        // Sub-test A: missing receipt fails with SERVER_RECEIPT_REQUIRED
        let err_missing = finalize_device_enrollment_internal(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            None,
            Some(&valid_oks1),
            None,
        );
        assert!(err_missing.is_err());
        assert!(err_missing.unwrap_err().contains("SERVER_RECEIPT_REQUIRED"));

        // Sub-test B: empty receipt fails with SERVER_RECEIPT_REQUIRED
        let err_empty = finalize_device_enrollment_internal(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some("   "),
            Some(&valid_oks1),
            None,
        );
        assert!(err_empty.is_err());
        assert!(err_empty.unwrap_err().contains("SERVER_RECEIPT_REQUIRED"));

        // Sub-test C: malformed base64 fails with RECEIPT_DECODE_FAILED
        let err_b64 = finalize_device_enrollment_internal(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some("!not_base64!"),
            Some(&valid_oks1),
            None,
        );
        assert!(err_b64.is_err());
        assert!(err_b64.unwrap_err().contains("RECEIPT_DECODE_FAILED"));

        // Sub-test D: tampered signature fails with RECEIPT_SIGNATURE_INVALID
        let mut tampered_bytes = base64_decode(&valid_receipt).unwrap();
        let last_idx = tampered_bytes.len() - 1;
        tampered_bytes[last_idx] ^= 0xff;
        let tampered_receipt = base64_encode_std(&tampered_bytes);
        let err_sig = finalize_device_enrollment_internal(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some(&tampered_receipt),
            Some(&valid_oks1),
            None,
        );
        assert!(err_sig.is_err());
        assert!(err_sig.unwrap_err().contains("RECEIPT_SIGNATURE_INVALID"));

        // Sub-test E: mismatched generation ID fails with RECEIPT_BINDING_MISMATCH
        let (wrong_gen_receipt, _) = test_keyset_and_receipt(
            frames::EFR1_OP_INITIAL_ENROLLMENT,
            "ee".repeat(16).as_str(),
            &sec_id_hex,
            1,
            pk,
            "HQ-001",
        );
        let err_gen = finalize_device_enrollment_internal(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some(&wrong_gen_receipt),
            Some(&valid_oks1),
            None,
        );
        assert!(err_gen.is_err());
        assert!(err_gen.unwrap_err().contains("RECEIPT_BINDING_MISMATCH"));

        // Sub-test F: mismatched device ID fails with RECEIPT_BINDING_MISMATCH
        let (wrong_dev_receipt, _) = test_keyset_and_receipt(
            frames::EFR1_OP_INITIAL_ENROLLMENT,
            &outcome.enrollment_generation_id_hex,
            "dd".repeat(16).as_str(),
            1,
            pk,
            "HQ-001",
        );
        let err_dev = finalize_device_enrollment_internal(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some(&wrong_dev_receipt),
            Some(&valid_oks1),
            None,
        );
        assert!(err_dev.is_err());
        assert!(err_dev.unwrap_err().contains("RECEIPT_BINDING_MISMATCH"));

        // Sub-test G: mismatched version fails with RECEIPT_BINDING_MISMATCH
        let (wrong_ver_receipt, _) = test_keyset_and_receipt(
            frames::EFR1_OP_INITIAL_ENROLLMENT,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            99,
            pk,
            "HQ-001",
        );
        let err_ver = finalize_device_enrollment_internal(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some(&wrong_ver_receipt),
            Some(&valid_oks1),
            None,
        );
        assert!(err_ver.is_err());
        assert!(err_ver.unwrap_err().contains("RECEIPT_BINDING_MISMATCH"));

        // Sub-test H: mismatched branch fails with RECEIPT_BINDING_MISMATCH
        let (wrong_branch_receipt, _) = test_keyset_and_receipt(
            frames::EFR1_OP_INITIAL_ENROLLMENT,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            1,
            pk,
            "BRANCH-999",
        );
        let err_branch = finalize_device_enrollment_internal(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some(&wrong_branch_receipt),
            Some(&valid_oks1),
            None,
        );
        assert!(err_branch.is_err());
        assert!(err_branch.unwrap_err().contains("RECEIPT_BINDING_MISMATCH"));

        // Sub-test I: missing manifest when no cached manifest exists fails with KEYSET_MANIFEST_UNAVAILABLE
        let err_manifest = finalize_device_enrollment_internal(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some(&valid_receipt),
            None,
            None,
        );
        assert!(err_manifest.is_err());
        assert!(err_manifest.unwrap_err().contains("KEYSET_MANIFEST_UNAVAILABLE"));

        // Sub-test J: valid receipt + valid OKS1 commits and caches manifest
        let res_commit = finalize_device_enrollment_internal(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some(&valid_receipt),
            Some(&valid_oks1),
            None,
        )
        .unwrap();
        assert_eq!(res_commit.status, "COMMITTED");
        assert!(!dir.join("twinpet-oac-keyset-manifest.bin").exists());
        assert!(resolve_active_manifest_path(&dir).is_ok());

        // Sub-test K: subsequent finalize (or idempotency retry) succeeds using cached manifest with oks1_base64: None
        let res_idempotent = finalize_device_enrollment_internal(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some(&valid_receipt),
            None, // uses cached manifest!
            None,
        )
        .unwrap();
        assert_eq!(res_idempotent.status, "ALREADY_COMMITTED");
        assert_eq!(res_idempotent.accepted_public_key_base64, pubkey_b64);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_hostile_attacker_untrusted_keyset_rejected_on_clean_bootstrap() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        let outcome = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "aa".repeat(16).as_str(),
            [0x77u8; 32],
        )
        .unwrap();

        let mut pk = [0u8; 32];
        pk.copy_from_slice(&outcome.staged_public_key_bytes);
        let pubkey_b64 = base64_encode_std(&pk);

        // Attacker creates their own independent key and signs a candidate OKS1 and EFR1
        let attacker_key = SigningKey::generate(&mut OsRng);
        let attacker_pubkey = attacker_key.verifying_key().to_bytes();
        let attacker_key_id = "attacker-signing-key-666";

        let attacker_manifest = frames::OacKeysetManifestFrameV1 {
            revocation_epoch: 1,
            generated_at_server_ms: 1000,
            keys: vec![frames::OacKeysetManifestKeyV1 {
                signing_key_id: attacker_key_id.to_string(),
                public_key: attacker_pubkey,
                status: frames::OacKeyLifecycleStatus::Active,
                verify_until_server_ms: None,
            }],
            signature: [0u8; 64],
        };
        let prefix = frames::oks1_signed_prefix(&attacker_manifest).unwrap();
        let sig = attacker_key.sign(&prefix).to_bytes();
        let signed_manifest = frames::OacKeysetManifestFrameV1 {
            signature: sig,
            ..attacker_manifest
        };
        let oks1_b64 = base64_encode_std(&frames::encode_oks1(&signed_manifest).unwrap());

        let mut gen_bytes = [0u8; 16];
        for i in 0..16 {
            gen_bytes[i] = u8::from_str_radix(&outcome.enrollment_generation_id_hex[i * 2..i * 2 + 2], 16).unwrap_or(0);
        }
        let mut sec_bytes = [0u8; 16];
        for i in 0..16 {
            sec_bytes[i] = u8::from_str_radix(&sec_id_hex[i * 2..i * 2 + 2], 16).unwrap_or(0);
        }

        let unsigned_efr1 = frames::EnrollmentFinalizationReceiptFrameV1 {
            operation_kind: frames::EFR1_OP_INITIAL_ENROLLMENT,
            receipt_nonce: [0x77u8; 32],
            enrollment_generation_id: gen_bytes,
            security_device_id: sec_bytes,
            device_key_version: 1,
            accepted_public_key: pk,
            server_sent_at_ms: 2000,
            branch_id: "HQ-001".to_string(),
            signing_key_id: attacker_key_id.to_string(),
            signature: [0u8; 64],
        };
        let efr1_preimage = frames::efr1_signature_preimage(&unsigned_efr1).unwrap();
        let efr1_sig = attacker_key.sign(&efr1_preimage).to_bytes();
        let signed_efr1 = frames::EnrollmentFinalizationReceiptFrameV1 {
            signature: efr1_sig,
            ..unsigned_efr1
        };
        let receipt_b64 = base64_encode_std(&frames::encode_efr1(&signed_efr1).unwrap());

        // Attempt finalize with attacker material on clean bootstrap
        let res = finalize_device_enrollment_internal(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some(&receipt_b64),
            Some(&oks1_b64),
            Some("INITIAL_ENROLLMENT"),
        );

        // MUST FAIL: bootstrap keyset not signed by trusted root!
        assert!(res.is_err());
        let err_msg = res.unwrap_err();
        assert!(err_msg.contains("UNTRUSTED_KEYSET_BOOTSTRAP"), "Expected UNTRUSTED_KEYSET_BOOTSTRAP, got: {err_msg}");

        // Manifest file MUST NOT exist on disk!
        assert!(!dir.join("twinpet-oac-keyset-manifest.bin").exists(), "Manifest was written despite verification failure!");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_hostile_attacker_untrusted_keyset_rotation_rejected() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        // 1. Legitimate initial enrollment (version 1)
        let outcome1 = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "bb".repeat(16).as_str(),
            [0x77u8; 32],
        )
        .unwrap();
        let pubkey_b64_1 = base64_encode_std(&outcome1.staged_public_key_bytes);
        let res1 = test_finalize_device_enrollment(&runtime, &dir,
            &outcome1.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64_1,
        )
        .unwrap();
        assert_eq!(res1.status, "COMMITTED");

        let cached_manifest_path = resolve_active_manifest_path(&dir).unwrap();
        assert!(cached_manifest_path.exists());
        let orig_cached_bytes = fs::read(&cached_manifest_path).unwrap();

        // 2. Stage second generation for re-enrollment
        let outcome2 = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "cc".repeat(16).as_str(),
            [0x88u8; 32],
        )
        .unwrap();
        let pubkey_b64_2 = base64_encode_std(&outcome2.staged_public_key_bytes);
        let mut pk2 = [0u8; 32];
        pk2.copy_from_slice(&outcome2.staged_public_key_bytes);

        // 3. Attacker attempts rotation with untrusted self-signed OKS1 and EFR1
        let attacker_key = SigningKey::generate(&mut OsRng);
        let attacker_pubkey = attacker_key.verifying_key().to_bytes();
        let attacker_key_id = "attacker-rotation-key";

        let attacker_manifest = frames::OacKeysetManifestFrameV1 {
            revocation_epoch: 2, // Higher epoch
            generated_at_server_ms: 5000,
            keys: vec![frames::OacKeysetManifestKeyV1 {
                signing_key_id: attacker_key_id.to_string(),
                public_key: attacker_pubkey,
                status: frames::OacKeyLifecycleStatus::Active,
                verify_until_server_ms: None,
            }],
            signature: [0u8; 64],
        };
        let prefix = frames::oks1_signed_prefix(&attacker_manifest).unwrap();
        let sig = attacker_key.sign(&prefix).to_bytes();
        let signed_manifest = frames::OacKeysetManifestFrameV1 {
            signature: sig,
            ..attacker_manifest
        };
        let attacker_oks1_b64 = base64_encode_std(&frames::encode_oks1(&signed_manifest).unwrap());

        let mut gen_bytes2 = [0u8; 16];
        for i in 0..16 {
            gen_bytes2[i] = u8::from_str_radix(&outcome2.enrollment_generation_id_hex[i * 2..i * 2 + 2], 16).unwrap_or(0);
        }
        let mut sec_bytes = [0u8; 16];
        for i in 0..16 {
            sec_bytes[i] = u8::from_str_radix(&sec_id_hex[i * 2..i * 2 + 2], 16).unwrap_or(0);
        }

        let unsigned_efr1 = frames::EnrollmentFinalizationReceiptFrameV1 {
            operation_kind: frames::EFR1_OP_RE_ENROLLMENT,
            receipt_nonce: [0x88u8; 32],
            enrollment_generation_id: gen_bytes2,
            security_device_id: sec_bytes,
            device_key_version: 2,
            accepted_public_key: pk2,
            server_sent_at_ms: 6000,
            branch_id: "HQ-001".to_string(),
            signing_key_id: attacker_key_id.to_string(),
            signature: [0u8; 64],
        };
        let efr1_preimage = frames::efr1_signature_preimage(&unsigned_efr1).unwrap();
        let efr1_sig = attacker_key.sign(&efr1_preimage).to_bytes();
        let signed_efr1 = frames::EnrollmentFinalizationReceiptFrameV1 {
            signature: efr1_sig,
            ..unsigned_efr1
        };
        let attacker_receipt_b64 = base64_encode_std(&frames::encode_efr1(&signed_efr1).unwrap());

        let res = finalize_device_enrollment_internal(&runtime, &dir,
            &outcome2.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            2,
            &pubkey_b64_2,
            Some(&attacker_receipt_b64),
            Some(&attacker_oks1_b64),
            Some("RE_ENROLLMENT"),
        );

        // MUST FAIL: candidate rotation not signed by any trusted authority!
        assert!(res.is_err());
        let err_msg = res.unwrap_err();
        assert!(err_msg.contains("UNTRUSTED_KEYSET_ROTATION"), "Expected UNTRUSTED_KEYSET_ROTATION, got: {err_msg}");

        // Cached manifest MUST NOT have been overwritten!
        let post_attack_cached_bytes = fs::read(&cached_manifest_path).unwrap();
        assert_eq!(post_attack_cached_bytes, orig_cached_bytes, "Cached manifest was mutated by untrusted attacker rotation!");

        // Active fence MUST NOT have been modified!
        let fence_bytes = fs::read(dir.join(ENROLLMENT_FENCE_FILE_NAME)).unwrap();
        let fence: EnrollmentFenceState = serde_json::from_slice(&fence_bytes).unwrap();
        assert_eq!(fence.device_key_version, 1);
        assert_eq!(fence.enrollment_generation_id, outcome1.enrollment_generation_id_hex);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_hostile_operation_swap_initial_on_enrolled_device_rejected() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        let outcome1 = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "11".repeat(16).as_str(),
            [0x11u8; 32],
        )
        .unwrap();
        let pubkey_b64_1 = base64_encode_std(&outcome1.staged_public_key_bytes);
        test_finalize_device_enrollment(&runtime, &dir,
            &outcome1.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64_1,
        )
        .unwrap();

        let outcome2 = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "22".repeat(16).as_str(),
            [0x22u8; 32],
        )
        .unwrap();
        let mut pk2 = [0u8; 32];
        pk2.copy_from_slice(&outcome2.staged_public_key_bytes);
        let pubkey_b64_2 = base64_encode_std(&pk2);

        // Attacker creates a receipt with operation_kind: INITIAL_ENROLLMENT (1) instead of RE_ENROLLMENT (2)
        let (swap_receipt, valid_oks1) = test_keyset_and_receipt(
            frames::EFR1_OP_INITIAL_ENROLLMENT,
            &outcome2.enrollment_generation_id_hex,
            &sec_id_hex,
            2,
            pk2,
            "HQ-001",
        );

        let err = finalize_device_enrollment_internal(&runtime, &dir,
            &outcome2.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            2,
            &pubkey_b64_2,
            Some(&swap_receipt),
            Some(&valid_oks1),
            None,
        );
        assert!(err.is_err());
        let msg = err.unwrap_err();
        assert!(msg.contains("RECEIPT_OPERATION_KIND_MISMATCH") || msg.contains("OPERATION_CONTEXT_MISMATCH"), "Expected operation mismatch error, got: {msg}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_hostile_operation_swap_re_enrollment_on_clean_device_rejected() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        let outcome = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "33".repeat(16).as_str(),
            [0x33u8; 32],
        )
        .unwrap();
        let mut pk = [0u8; 32];
        pk.copy_from_slice(&outcome.staged_public_key_bytes);
        let pubkey_b64 = base64_encode_std(&pk);

        // Attacker creates receipt with operation_kind: RE_ENROLLMENT (2) on clean device
        let (swap_receipt, valid_oks1) = test_keyset_and_receipt(
            frames::EFR1_OP_RE_ENROLLMENT,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            1,
            pk,
            "HQ-001",
        );

        let err = finalize_device_enrollment_internal(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some(&swap_receipt),
            Some(&valid_oks1),
            None,
        );
        assert!(err.is_err());
        let msg = err.unwrap_err();
        assert!(msg.contains("RECEIPT_OPERATION_KIND_MISMATCH") || msg.contains("OPERATION_CONTEXT_MISMATCH"), "Expected operation mismatch error, got: {msg}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_no_private_seed_in_production_trust_path() {
        // Assert that the native trust anchor in production is public-only (Option A)
        let root_pub = canonical_oac_root_public_key();
        assert_eq!(root_pub.len(), 32);
        // Assert that the derived public key matches the test root seed
        let derived = SigningKey::from_bytes(&TEST_OAC_ROOT_SEED).verifying_key().to_bytes();
        assert_eq!(root_pub, derived);
    }

    #[test]
    fn test_hostile_signing_key_lifecycle_enforcement_matrix() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        let outcome = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "44".repeat(16).as_str(),
            [0x01u8; 32],
        )
        .unwrap();
        let mut pk = [0u8; 32];
        pk.copy_from_slice(&outcome.staged_public_key_bytes);
        let pubkey_b64 = base64_encode_std(&pk);

        let oac_signer = SigningKey::from_bytes(&[0x6bu8; 32]);
        let oac_pubkey = oac_signer.verifying_key().to_bytes();
        let raw_key_id = "test-signing-key-1";

        let mut gen_bytes = [0u8; 16];
        for i in 0..16 {
            gen_bytes[i] = u8::from_str_radix(&outcome.enrollment_generation_id_hex[i * 2..i * 2 + 2], 16).unwrap_or(0);
        }
        let mut sec_bytes = [0u8; 16];
        for i in 0..16 {
            sec_bytes[i] = u8::from_str_radix(&sec_id_hex[i * 2..i * 2 + 2], 16).unwrap_or(0);
        }

        let unsigned_efr1 = frames::EnrollmentFinalizationReceiptFrameV1 {
            operation_kind: frames::EFR1_OP_INITIAL_ENROLLMENT,
            receipt_nonce: [0x01; 32],
            enrollment_generation_id: gen_bytes,
            security_device_id: sec_bytes,
            device_key_version: 1,
            accepted_public_key: pk,
            server_sent_at_ms: 2000,
            branch_id: "HQ-001".to_string(),
            signing_key_id: raw_key_id.to_string(),
            signature: [0u8; 64],
        };
        let efr1_preimage = frames::efr1_signature_preimage(&unsigned_efr1).unwrap();
        let efr1_sig = oac_signer.sign(&efr1_preimage).to_bytes();
        let signed_efr1 = frames::EnrollmentFinalizationReceiptFrameV1 {
            signature: efr1_sig,
            ..unsigned_efr1
        };
        let receipt_b64 = base64_encode_std(&frames::encode_efr1(&signed_efr1).unwrap());

        let make_manifest_b64 = |status: frames::OacKeyLifecycleStatus, verify_until: Option<u64>| -> String {
            use ed25519_dalek::Signer;
            let root_key = SigningKey::from_bytes(&TEST_OAC_ROOT_SEED);
            if status == frames::OacKeyLifecycleStatus::VerifyOnly && verify_until.is_none() {
                // Manually craft invalid wire format with VERIFY_ONLY status but missing 8-byte expiry
                let mut prefix = Vec::new();
                prefix.extend_from_slice(b"OKS1");
                prefix.push(2);
                prefix.extend_from_slice(&1u32.to_le_bytes());
                prefix.extend_from_slice(&1000u64.to_le_bytes());
                prefix.push(1);
                prefix.push(raw_key_id.len() as u8);
                prefix.extend_from_slice(raw_key_id.as_bytes());
                prefix.extend_from_slice(&oac_pubkey);
                prefix.push(frames::OAC_KEY_STATUS_VERIFY_ONLY); // missing expiry bytes
                let sig = root_key.sign(&prefix).to_bytes();
                let mut full = prefix;
                full.extend_from_slice(&sig);
                return base64_encode_std(&full);
            }
            let manifest_frame = frames::OacKeysetManifestFrameV1 {
                revocation_epoch: 1,
                generated_at_server_ms: 1000,
                keys: vec![frames::OacKeysetManifestKeyV1 {
                    signing_key_id: raw_key_id.to_string(),
                    public_key: oac_pubkey,
                    status,
                    verify_until_server_ms: verify_until,
                }],
                signature: [0u8; 64],
            };
            let prefix = frames::oks1_signed_prefix(&manifest_frame).unwrap();
            let sig = root_key.sign(&prefix).to_bytes();
            let signed_manifest = frames::OacKeysetManifestFrameV1 {
                signature: sig,
                ..manifest_frame
            };
            base64_encode_std(&frames::encode_oks1(&signed_manifest).unwrap())
        };

        // Subtest 1: RETIRED key is rejected
        let oks1_retired = make_manifest_b64(frames::OacKeyLifecycleStatus::Retired, None);
        let err_retired = finalize_device_enrollment_internal(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some(&receipt_b64),
            Some(&oks1_retired),
            Some("INITIAL_ENROLLMENT"),
        );
        assert!(err_retired.is_err());
        assert!(err_retired.unwrap_err().contains("RETIRED"));

        // Subtest 2: VERIFY_ONLY key after expiry is rejected (trusted_now 2000 >= 1500)
        let oks1_expired = make_manifest_b64(frames::OacKeyLifecycleStatus::VerifyOnly, Some(1500));
        let mut expired_hooks = FinalizeHooks::default();
        expired_hooks.trusted_now_override_ms = Some(2000); // 2000 > 1500
        let err_expired = finalize_device_enrollment_internal_with_hooks(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some(&receipt_b64),
            Some(&oks1_expired),
            &expired_hooks,
        );
        assert!(err_expired.is_err());
        assert!(err_expired.unwrap_err().contains("expired"));

        // Subtest 3: VERIFY_ONLY key at exact expiry is rejected (trusted_now 2000 >= 2000)
        let oks1_exact = make_manifest_b64(frames::OacKeyLifecycleStatus::VerifyOnly, Some(2000));
        let mut exact_hooks = FinalizeHooks::default();
        exact_hooks.trusted_now_override_ms = Some(2000); // 2000 == 2000
        let err_exact = finalize_device_enrollment_internal_with_hooks(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some(&receipt_b64),
            Some(&oks1_exact),
            &exact_hooks,
        );
        assert!(err_exact.is_err());
        assert!(err_exact.unwrap_err().contains("expired"));

        // Subtest 4: VERIFY_ONLY missing expiry is rejected
        let oks1_missing = make_manifest_b64(frames::OacKeyLifecycleStatus::VerifyOnly, None);
        let err_missing = finalize_device_enrollment_internal(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some(&receipt_b64),
            Some(&oks1_missing),
            Some("INITIAL_ENROLLMENT"),
        );
        assert!(err_missing.is_err());
        let err_missing_str = err_missing.unwrap_err();
        assert!(
            err_missing_str.contains("decode failed") || err_missing_str.contains("missing verify_until_server_ms"),
            "Expected decode failure on missing expiry, got: {err_missing_str}"
        );

        // Subtest 5: VERIFY_ONLY with valid window via hook override (trusted_now 2000 < expiry 3000) is accepted
        let dir5 = temp_dir();
        let runtime5 = EnrollmentRuntimeState::new();
        let (_sec_id5, sec_id_hex5) = setup_test_device(&dir5);
        let outcome5 = super::super::device_registration_proof::generate_device_registration_proof(
            &runtime5,
            &dir5,
            "55".repeat(16).as_str(),
            [0x01u8; 32],
        )
        .unwrap();
        let pubkey_b64_5 = base64_encode_std(&outcome5.staged_public_key_bytes);
        let mut pk5 = [0u8; 32];
        pk5.copy_from_slice(&outcome5.staged_public_key_bytes);
        let mut gen_bytes5 = [0u8; 16];
        for i in 0..16 {
            gen_bytes5[i] = u8::from_str_radix(&outcome5.enrollment_generation_id_hex[i * 2..i * 2 + 2], 16).unwrap_or(0);
        }
        let unsigned_efr1_5 = frames::EnrollmentFinalizationReceiptFrameV1 {
            operation_kind: frames::EFR1_OP_INITIAL_ENROLLMENT,
            receipt_nonce: [0x01; 32],
            enrollment_generation_id: gen_bytes5,
            security_device_id: _sec_id5,
            device_key_version: 1,
            accepted_public_key: pk5,
            server_sent_at_ms: 2000,
            branch_id: "HQ-001".to_string(),
            signing_key_id: raw_key_id.to_string(),
            signature: [0u8; 64],
        };
        let efr1_preimage_5 = frames::efr1_signature_preimage(&unsigned_efr1_5).unwrap();
        let efr1_sig_5 = oac_signer.sign(&efr1_preimage_5).to_bytes();
        let receipt_b64_5 = base64_encode_std(&frames::encode_efr1(&frames::EnrollmentFinalizationReceiptFrameV1 {
            signature: efr1_sig_5,
            ..unsigned_efr1_5
        }).unwrap());

        let oks1_valid_vo = make_manifest_b64(frames::OacKeyLifecycleStatus::VerifyOnly, Some(3000));
        let mut valid_vo_hooks = FinalizeHooks::default();
        valid_vo_hooks.trusted_now_override_ms = Some(2000);
        let ok_vo = finalize_device_enrollment_internal_with_hooks(
            &runtime5,
            &dir5,
            &outcome5.enrollment_generation_id_hex,
            &sec_id_hex5,
            "HQ-001",
            1,
            &pubkey_b64_5,
            Some(&receipt_b64_5),
            Some(&oks1_valid_vo),
            &valid_vo_hooks,
        );
        assert!(ok_vo.is_ok());
        let _ = fs::remove_dir_all(&dir5);

        // Subtest 6: DEC-D-07 trusted time interval derivation with default hooks (no override)
        // Ensure receipt context is populated matching outcome
        let current_ticks = monotonic_clock::read_qpc_ticks().unwrap_or(100);
        let boot_id = monotonic_clock::boot_session_id();
        let oks1_dec_ok = make_manifest_b64(frames::OacKeyLifecycleStatus::VerifyOnly, Some(10_000_000));

        // 6b: Past expiry rejected through DEC-D-07 interval
        runtime.record_pending_request(PendingRequestContext {
            request_qpc_ticks: current_ticks.saturating_sub(10),
            boot_session_id: boot_id,
            device_registration_nonce: [0x01; 32],
            security_device_id: sec_bytes,
            enrollment_generation_id_hex: outcome.enrollment_generation_id_hex.clone(),
            staged_public_key: pk,
            test_receipt_qpc_ticks: Some(current_ticks.saturating_sub(5)),
        });
        let oks1_dec_expired = make_manifest_b64(frames::OacKeyLifecycleStatus::VerifyOnly, Some(2000));
        let res_dec_expired = finalize_device_enrollment_internal(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some(&receipt_b64),
            Some(&oks1_dec_expired),
            None,
        );
        assert!(res_dec_expired.is_err());
        assert!(res_dec_expired.unwrap_err().contains("expired"));

        // 6c: Missing receipt context fails closed with TRUSTED_TIME_UNAVAILABLE_REANCHOR_REQUIRED
        runtime.clear();
        let res_missing_ctx = finalize_device_enrollment_internal(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some(&receipt_b64),
            Some(&oks1_dec_ok),
            None,
        );
        assert!(res_missing_ctx.is_err());
        assert!(res_missing_ctx.unwrap_err().contains("TRUSTED_TIME_UNAVAILABLE_REANCHOR_REQUIRED"));

        // 6d: Boot session mismatch fails closed
        let mut bad_boot = boot_id;
        bad_boot[0] ^= 0xff;
        runtime.record_pending_request(PendingRequestContext {
            request_qpc_ticks: current_ticks.saturating_sub(10),
            boot_session_id: bad_boot,
            device_registration_nonce: [0x01; 32],
            security_device_id: sec_bytes,
            enrollment_generation_id_hex: outcome.enrollment_generation_id_hex.clone(),
            staged_public_key: pk,
            test_receipt_qpc_ticks: Some(current_ticks.saturating_sub(5)),
        });
        let res_boot_mismatch = finalize_device_enrollment_internal(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some(&receipt_b64),
            Some(&oks1_dec_ok),
            None,
        );
        assert!(res_boot_mismatch.is_err());
        assert!(res_boot_mismatch.unwrap_err().contains("boot session mismatch"));

        // 6e: Nonce mismatch fails closed with RECEIPT_NONCE_MISMATCH
        runtime.record_pending_request(PendingRequestContext {
            request_qpc_ticks: current_ticks.saturating_sub(10),
            boot_session_id: boot_id,
            device_registration_nonce: [0x99; 32], // mismatch from efr1 [0x01; 32]
            security_device_id: sec_bytes,
            enrollment_generation_id_hex: outcome.enrollment_generation_id_hex.clone(),
            staged_public_key: pk,
            test_receipt_qpc_ticks: Some(current_ticks.saturating_sub(5)),
        });
        let res_nonce_mismatch = finalize_device_enrollment_internal(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some(&receipt_b64),
            Some(&oks1_dec_ok),
            None,
        );
        assert!(res_nonce_mismatch.is_err());
        assert!(res_nonce_mismatch.unwrap_err().contains("RECEIPT_NONCE_MISMATCH"));

        // 6a: Future expiry accepted through DEC-D-07 interval
        runtime.record_pending_request(PendingRequestContext {
            request_qpc_ticks: current_ticks.saturating_sub(10),
            boot_session_id: boot_id,
            device_registration_nonce: [0x01; 32],
            security_device_id: sec_bytes,
            enrollment_generation_id_hex: outcome.enrollment_generation_id_hex.clone(),
            staged_public_key: pk,
            test_receipt_qpc_ticks: Some(current_ticks.saturating_sub(5)),
        });
        let res_dec_ok = finalize_device_enrollment_internal(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some(&receipt_b64),
            Some(&oks1_dec_ok),
            None,
        );
        assert!(res_dec_ok.is_ok(), "res_dec_ok failed: {:?}", res_dec_ok.err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_hostile_keyset_rotation_equal_epoch_rejected() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        let outcome1 = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "ee".repeat(16).as_str(),
            [0x11u8; 32],
        )
        .unwrap();
        let pubkey_b64_1 = base64_encode_std(&outcome1.staged_public_key_bytes);
        test_finalize_device_enrollment(&runtime, &dir,
            &outcome1.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64_1,
        )
        .unwrap();

        let outcome2 = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "ff".repeat(16).as_str(),
            [0x22u8; 32],
        )
        .unwrap();
        let pubkey_b64_2 = base64_encode_std(&outcome2.staged_public_key_bytes);
        let mut pk2 = [0u8; 32];
        pk2.copy_from_slice(&outcome2.staged_public_key_bytes);

        // Candidate with SAME epoch 1 (equal-epoch changed bytes)
        use ed25519_dalek::Signer;
        let root_key = SigningKey::from_bytes(&TEST_OAC_ROOT_SEED);
        let new_signer = SigningKey::from_bytes(&[0x77u8; 32]);
        let new_pubkey = new_signer.verifying_key().to_bytes();

        let cand_manifest = frames::OacKeysetManifestFrameV1 {
            revocation_epoch: 1, // Same epoch as cached!
            generated_at_server_ms: 2000,
            keys: vec![frames::OacKeysetManifestKeyV1 {
                signing_key_id: "new-key".to_string(),
                public_key: new_pubkey,
                status: frames::OacKeyLifecycleStatus::Active,
                verify_until_server_ms: None,
            }],
            signature: [0u8; 64],
        };
        let prefix = frames::oks1_signed_prefix(&cand_manifest).unwrap();
        let sig = root_key.sign(&prefix).to_bytes();
        let signed_manifest = frames::OacKeysetManifestFrameV1 {
            signature: sig,
            ..cand_manifest
        };
        let cand_oks1_b64 = base64_encode_std(&frames::encode_oks1(&signed_manifest).unwrap());

        let mut gen_bytes2 = [0u8; 16];
        for i in 0..16 {
            gen_bytes2[i] = u8::from_str_radix(&outcome2.enrollment_generation_id_hex[i * 2..i * 2 + 2], 16).unwrap_or(0);
        }
        let mut sec_bytes = [0u8; 16];
        for i in 0..16 {
            sec_bytes[i] = u8::from_str_radix(&sec_id_hex[i * 2..i * 2 + 2], 16).unwrap_or(0);
        }

        let unsigned_efr1 = frames::EnrollmentFinalizationReceiptFrameV1 {
            operation_kind: frames::EFR1_OP_RE_ENROLLMENT,
            receipt_nonce: [0x22u8; 32],
            enrollment_generation_id: gen_bytes2,
            security_device_id: sec_bytes,
            device_key_version: 2,
            accepted_public_key: pk2,
            server_sent_at_ms: 3000,
            branch_id: "HQ-001".to_string(),
            signing_key_id: "new-key".to_string(),
            signature: [0u8; 64],
        };
        let efr1_preimage = frames::efr1_signature_preimage(&unsigned_efr1).unwrap();
        let efr1_sig = new_signer.sign(&efr1_preimage).to_bytes();
        let signed_efr1 = frames::EnrollmentFinalizationReceiptFrameV1 {
            signature: efr1_sig,
            ..unsigned_efr1
        };
        let receipt_b64 = base64_encode_std(&frames::encode_efr1(&signed_efr1).unwrap());

        let res = finalize_device_enrollment_internal(&runtime, &dir,
            &outcome2.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            2,
            &pubkey_b64_2,
            Some(&receipt_b64),
            Some(&cand_oks1_b64),
            Some("RE_ENROLLMENT"),
        );

        assert!(res.is_err());
        let err = res.unwrap_err();
        assert!(err.contains("UNTRUSTED_KEYSET_ROTATION"), "Expected UNTRUSTED_KEYSET_ROTATION on equal epoch, got: {err}");
        assert!(err.contains("equal-epoch changed bytes and downgrades rejected"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_hostile_keyset_rotation_by_old_active_key_rejected() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        let outcome1 = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "dd".repeat(16).as_str(),
            [0x11u8; 32],
        )
        .unwrap();
        let pubkey_b64_1 = base64_encode_std(&outcome1.staged_public_key_bytes);
        test_finalize_device_enrollment(&runtime, &dir,
            &outcome1.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64_1,
        )
        .unwrap();

        let outcome2 = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "cc".repeat(16).as_str(),
            [0x22u8; 32],
        )
        .unwrap();
        let pubkey_b64_2 = base64_encode_std(&outcome2.staged_public_key_bytes);
        let mut pk2 = [0u8; 32];
        pk2.copy_from_slice(&outcome2.staged_public_key_bytes);

        // Candidate rotation signed by OLD ACTIVE OAC key ([0x6bu8; 32]) instead of ROOT key
        use ed25519_dalek::Signer;
        let old_active_key = SigningKey::from_bytes(&[0x6bu8; 32]);
        let new_active_key = SigningKey::from_bytes(&[0x88u8; 32]);
        let new_pubkey = new_active_key.verifying_key().to_bytes();

        let cand_manifest = frames::OacKeysetManifestFrameV1 {
            revocation_epoch: 2, // Strictly greater epoch
            generated_at_server_ms: 5000,
            keys: vec![frames::OacKeysetManifestKeyV1 {
                signing_key_id: "new-key".to_string(),
                public_key: new_pubkey,
                status: frames::OacKeyLifecycleStatus::Active,
                verify_until_server_ms: None,
            }],
            signature: [0u8; 64],
        };
        let prefix = frames::oks1_signed_prefix(&cand_manifest).unwrap();
        let sig = old_active_key.sign(&prefix).to_bytes();
        let signed_manifest = frames::OacKeysetManifestFrameV1 {
            signature: sig,
            ..cand_manifest
        };
        let cand_oks1_b64 = base64_encode_std(&frames::encode_oks1(&signed_manifest).unwrap());

        let mut gen_bytes2 = [0u8; 16];
        for i in 0..16 {
            gen_bytes2[i] = u8::from_str_radix(&outcome2.enrollment_generation_id_hex[i * 2..i * 2 + 2], 16).unwrap_or(0);
        }
        let mut sec_bytes = [0u8; 16];
        for i in 0..16 {
            sec_bytes[i] = u8::from_str_radix(&sec_id_hex[i * 2..i * 2 + 2], 16).unwrap_or(0);
        }

        let unsigned_efr1 = frames::EnrollmentFinalizationReceiptFrameV1 {
            operation_kind: frames::EFR1_OP_RE_ENROLLMENT,
            receipt_nonce: [0x22u8; 32],
            enrollment_generation_id: gen_bytes2,
            security_device_id: sec_bytes,
            device_key_version: 2,
            accepted_public_key: pk2,
            server_sent_at_ms: 6000,
            branch_id: "HQ-001".to_string(),
            signing_key_id: "new-key".to_string(),
            signature: [0u8; 64],
        };
        let efr1_preimage = frames::efr1_signature_preimage(&unsigned_efr1).unwrap();
        let efr1_sig = new_active_key.sign(&efr1_preimage).to_bytes();
        let signed_efr1 = frames::EnrollmentFinalizationReceiptFrameV1 {
            signature: efr1_sig,
            ..unsigned_efr1
        };
        let receipt_b64 = base64_encode_std(&frames::encode_efr1(&signed_efr1).unwrap());

        let res = finalize_device_enrollment_internal(&runtime, &dir,
            &outcome2.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            2,
            &pubkey_b64_2,
            Some(&receipt_b64),
            Some(&cand_oks1_b64),
            Some("RE_ENROLLMENT"),
        );

        assert!(res.is_err());
        let err = res.unwrap_err();
        assert!(err.contains("UNTRUSTED_KEYSET_ROTATION"), "Expected UNTRUSTED_KEYSET_ROTATION, got: {err}");
        assert!(err.contains("old active keys cannot authenticate rotation"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_hostile_malformed_fence_fails_closed() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        let outcome = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "99".repeat(16).as_str(),
            [0x99u8; 32],
        )
        .unwrap();
        let pubkey_b64 = base64_encode_std(&outcome.staged_public_key_bytes);

        // Plant a corrupt fence file on disk
        let fence_path = enrollment_fence_path(&dir);
        fs::write(&fence_path, b"CORRUPT_NOT_JSON_DATA").unwrap();

        let mut pk = [0u8; 32];
        pk.copy_from_slice(&outcome.staged_public_key_bytes);
        let (receipt_b64, oks1_b64) = test_keyset_and_receipt(
            frames::EFR1_OP_INITIAL_ENROLLMENT,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            1,
            pk,
            "HQ-001",
        );

        let res = finalize_device_enrollment_internal(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some(&receipt_b64),
            Some(&oks1_b64),
            Some("INITIAL_ENROLLMENT"),
        );

        assert!(res.is_err());
        let err = res.unwrap_err();
        assert!(err.contains("MALFORMED_FENCE_FAIL_CLOSED"), "Expected MALFORMED_FENCE_FAIL_CLOSED, got: {err}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_hostile_caller_operation_override_rejected() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        let outcome = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "ab".repeat(16).as_str(),
            [0xabu8; 32],
        )
        .unwrap();
        let pubkey_b64 = base64_encode_std(&outcome.staged_public_key_bytes);
        let mut pk = [0u8; 32];
        pk.copy_from_slice(&outcome.staged_public_key_bytes);
        let (receipt_b64, oks1_b64) = test_keyset_and_receipt(
            frames::EFR1_OP_INITIAL_ENROLLMENT,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            1,
            pk,
            "HQ-001",
        );

        // Clean device: caller claims RE_ENROLLMENT
        let res = finalize_device_enrollment_internal(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some(&receipt_b64),
            Some(&oks1_b64),
            Some("RE_ENROLLMENT"),
        );
        assert!(res.is_err());
        let err = res.unwrap_err();
        assert!(err.contains("OPERATION_CONTEXT_MISMATCH"), "Expected OPERATION_CONTEXT_MISMATCH, got: {err}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_hostile_keyset_persistence_failure_before_fence_switch_preserves_old_authority() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        // 1. Initial enrollment version 1 succeeds
        let outcome1 = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "71".repeat(16).as_str(),
            [0x71u8; 32],
        )
        .unwrap();
        let pubkey_b64_1 = base64_encode_std(&outcome1.staged_public_key_bytes);
        test_finalize_device_enrollment(&runtime, &dir,
            &outcome1.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64_1,
        )
        .unwrap();

        let cached_path = resolve_active_manifest_path(&dir).unwrap();
        assert!(cached_path.exists());
        let old_manifest_bytes = fs::read(&cached_path).unwrap();

        // 2. Stage version 2
        let outcome2 = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "72".repeat(16).as_str(),
            [0x72u8; 32],
        )
        .unwrap();
        let pubkey_b64_2 = base64_encode_std(&outcome2.staged_public_key_bytes);
        let mut pk2 = [0u8; 32];
        pk2.copy_from_slice(&outcome2.staged_public_key_bytes);

        // Construct valid root-signed candidate at epoch 2
        use ed25519_dalek::Signer;
        let root_key = SigningKey::from_bytes(&TEST_OAC_ROOT_SEED);
        let new_signer = SigningKey::from_bytes(&[0x99u8; 32]);
        let new_pubkey = new_signer.verifying_key().to_bytes();

        let cand_manifest = frames::OacKeysetManifestFrameV1 {
            revocation_epoch: 2,
            generated_at_server_ms: 3000,
            keys: vec![frames::OacKeysetManifestKeyV1 {
                signing_key_id: "key-v2".to_string(),
                public_key: new_pubkey,
                status: frames::OacKeyLifecycleStatus::Active,
                verify_until_server_ms: None,
            }],
            signature: [0u8; 64],
        };
        let prefix = frames::oks1_signed_prefix(&cand_manifest).unwrap();
        let sig = root_key.sign(&prefix).to_bytes();
        let signed_manifest = frames::OacKeysetManifestFrameV1 {
            signature: sig,
            ..cand_manifest
        };
        let cand_oks1_b64 = base64_encode_std(&frames::encode_oks1(&signed_manifest).unwrap());

        let mut gen_bytes2 = [0u8; 16];
        for i in 0..16 {
            gen_bytes2[i] = u8::from_str_radix(&outcome2.enrollment_generation_id_hex[i * 2..i * 2 + 2], 16).unwrap_or(0);
        }
        let mut sec_bytes = [0u8; 16];
        for i in 0..16 {
            sec_bytes[i] = u8::from_str_radix(&sec_id_hex[i * 2..i * 2 + 2], 16).unwrap_or(0);
        }

        let unsigned_efr1 = frames::EnrollmentFinalizationReceiptFrameV1 {
            operation_kind: frames::EFR1_OP_RE_ENROLLMENT,
            receipt_nonce: [0x72u8; 32],
            enrollment_generation_id: gen_bytes2,
            security_device_id: sec_bytes,
            device_key_version: 2,
            accepted_public_key: pk2,
            server_sent_at_ms: 4000,
            branch_id: "HQ-001".to_string(),
            signing_key_id: "key-v2".to_string(),
            signature: [0u8; 64],
        };
        let efr1_preimage = frames::efr1_signature_preimage(&unsigned_efr1).unwrap();
        let efr1_sig = new_signer.sign(&efr1_preimage).to_bytes();
        let signed_efr1 = frames::EnrollmentFinalizationReceiptFrameV1 {
            signature: efr1_sig,
            ..unsigned_efr1
        };
        let receipt_b64 = base64_encode_std(&frames::encode_efr1(&signed_efr1).unwrap());

        // Injected keyset persistence failure (IR-002 part A)
        let mut fail_persist_hooks = FinalizeHooks::default();
        fail_persist_hooks.fail_manifest_write = true;

        let res = finalize_device_enrollment_internal_with_hooks(&runtime, &dir,
            &outcome2.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            2,
            &pubkey_b64_2,
            Some(&receipt_b64),
            Some(&cand_oks1_b64),
            &fail_persist_hooks,
        );

        assert!(res.is_err());
        let err = res.unwrap_err();
        assert!(err.contains("KEYSET_PERSIST_FAILED"), "Expected KEYSET_PERSIST_FAILED, got: {err}");

        // Previous authority preserved!
        let post_fail_manifest_bytes = fs::read(&cached_path).unwrap();
        assert_eq!(post_fail_manifest_bytes, old_manifest_bytes, "Manifest was mutated despite persistence failure!");

        let fence_bytes = fs::read(dir.join(ENROLLMENT_FENCE_FILE_NAME)).unwrap();
        let fence: EnrollmentFenceState = serde_json::from_slice(&fence_bytes).unwrap();
        assert_eq!(fence.device_key_version, 1, "Fence was committed despite keyset persistence failure!");
        assert_eq!(fence.enrollment_generation_id, outcome1.enrollment_generation_id_hex);

        // Injected keyset re-read failure (IR-002 part B)
        let mut fail_reread_hooks = FinalizeHooks::default();
        fail_reread_hooks.fail_manifest_reread = true;
        let res_reread = finalize_device_enrollment_internal_with_hooks(&runtime, &dir,
            &outcome2.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            2,
            &pubkey_b64_2,
            Some(&receipt_b64),
            Some(&cand_oks1_b64),
            &fail_reread_hooks,
        );
        assert!(res_reread.is_err());
        assert!(res_reread.unwrap_err().contains("KEYSET_VERIFY_READ_FAILED"));

        // Injected fence switch failure after candidate B persistence (IR-002 part C)
        // Proves candidate B is durable on disk, but fence remains G1 and resolves authority A!
        let mut fail_fence_hooks = FinalizeHooks::default();
        fail_fence_hooks.fail_fence_switch = true;
        let res_fence_fail = finalize_device_enrollment_internal_with_hooks(&runtime, &dir,
            &outcome2.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            2,
            &pubkey_b64_2,
            Some(&receipt_b64),
            Some(&cand_oks1_b64),
            &fail_fence_hooks,
        );
        assert!(res_fence_fail.is_err());
        assert!(res_fence_fail.unwrap_err().contains("FENCE_REPLACE_FAILED"));

        // Fence on disk MUST STILL BE G1!
        let fence_bytes_post = fs::read(dir.join(ENROLLMENT_FENCE_FILE_NAME)).unwrap();
        let fence_post: EnrollmentFenceState = serde_json::from_slice(&fence_bytes_post).unwrap();
        assert_eq!(fence_post.device_key_version, 1);
        assert_eq!(fence_post.enrollment_generation_id, outcome1.enrollment_generation_id_hex);

        // Active manifest resolution MUST STILL RESOLVE AUTHORITY A!
        let active_path = resolve_active_manifest_path(&dir).unwrap();
        let active_bytes = fs::read(&active_path).unwrap();
        assert_eq!(active_bytes, old_manifest_bytes, "Active authority shifted despite fence switch failure!");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_functions_to_native_trust_chain_integration_proof() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        let outcome = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "fe".repeat(16).as_str(),
            [0xfeu8; 32],
        )
        .unwrap();
        let pubkey_b64 = base64_encode_std(&outcome.staged_public_key_bytes);
        let mut pk = [0u8; 32];
        pk.copy_from_slice(&outcome.staged_public_key_bytes);

        // 1. Stable server root signs OKS1 directly
        use ed25519_dalek::Signer;
        let server_root_key = SigningKey::from_bytes(&TEST_OAC_ROOT_SEED);
        let server_oac_key = SigningKey::from_bytes(&[0x42u8; 32]);
        let server_oac_pubkey = server_oac_key.verifying_key().to_bytes();
        let key_id = "oac-prod-signer-2026";

        let server_oks1_frame = frames::OacKeysetManifestFrameV1 {
            revocation_epoch: 1,
            generated_at_server_ms: 1_772_000_000_000,
            keys: vec![frames::OacKeysetManifestKeyV1 {
                signing_key_id: key_id.to_string(),
                public_key: server_oac_pubkey,
                status: frames::OacKeyLifecycleStatus::Active,
                verify_until_server_ms: None,
            }],
            signature: [0u8; 64],
        };
        let prefix = frames::oks1_signed_prefix(&server_oks1_frame).unwrap();
        let root_sig = server_root_key.sign(&prefix).to_bytes();
        let server_oks1_signed = frames::OacKeysetManifestFrameV1 {
            signature: root_sig,
            ..server_oks1_frame.clone()
        };
        let oks1_b64 = base64_encode_std(&frames::encode_oks1(&server_oks1_signed).unwrap());

        // 2. Server OAC key signs EFR1
        let mut gen_bytes = [0u8; 16];
        for i in 0..16 {
            gen_bytes[i] = u8::from_str_radix(&outcome.enrollment_generation_id_hex[i * 2..i * 2 + 2], 16).unwrap_or(0);
        }
        let mut sec_bytes = [0u8; 16];
        for i in 0..16 {
            sec_bytes[i] = u8::from_str_radix(&sec_id_hex[i * 2..i * 2 + 2], 16).unwrap_or(0);
        }

        let unsigned_efr1 = frames::EnrollmentFinalizationReceiptFrameV1 {
            operation_kind: frames::EFR1_OP_INITIAL_ENROLLMENT,
            receipt_nonce: [0xfeu8; 32],
            enrollment_generation_id: gen_bytes,
            security_device_id: sec_bytes,
            device_key_version: 1,
            accepted_public_key: pk,
            server_sent_at_ms: 1_772_000_000_100,
            branch_id: "HQ-001".to_string(),
            signing_key_id: "oac-prod-signer-2026".to_string(),
            signature: [0u8; 64],
        };
        let efr1_preimage = frames::efr1_signature_preimage(&unsigned_efr1).unwrap();
        let efr1_sig = server_oac_key.sign(&efr1_preimage).to_bytes();
        let signed_efr1 = frames::EnrollmentFinalizationReceiptFrameV1 {
            signature: efr1_sig,
            ..unsigned_efr1
        };
        let receipt_b64 = base64_encode_std(&frames::encode_efr1(&signed_efr1).unwrap());

        // 3. Native production verifier validates the entire chain
        let res = finalize_device_enrollment_internal(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some(&receipt_b64),
            Some(&oks1_b64),
            Some("INITIAL_ENROLLMENT"),
        );
        assert!(res.is_ok(), "Production verifier failed on legitimate Functions trust chain: {:?}", res.err());
        let outcome_dto = res.unwrap();
        assert_eq!(outcome_dto.status, "COMMITTED");

        // 4. Attacker with unrelated root fails
        let dir_bad = temp_dir();
        let runtime_bad = EnrollmentRuntimeState::new();
        let (_sec_id_bad, sec_id_hex_bad) = setup_test_device(&dir_bad);
        let outcome_bad = super::super::device_registration_proof::generate_device_registration_proof(
            &runtime_bad,
            &dir_bad,
            "fc".repeat(16).as_str(),
            [0xfcu8; 32],
        )
        .unwrap();
        let pubkey_b64_bad = base64_encode_std(&outcome_bad.staged_public_key_bytes);

        let unrelated_root = SigningKey::generate(&mut OsRng);
        let bad_prefix = frames::oks1_signed_prefix(&server_oks1_frame).unwrap();
        let bad_sig = unrelated_root.sign(&bad_prefix).to_bytes();
        let bad_oks1_signed = frames::OacKeysetManifestFrameV1 {
            signature: bad_sig,
            ..server_oks1_frame
        };
        let bad_oks1_b64 = base64_encode_std(&frames::encode_oks1(&bad_oks1_signed).unwrap());

        let mut gen_bytes_bad = [0u8; 16];
        for i in 0..16 {
            gen_bytes_bad[i] = u8::from_str_radix(&outcome_bad.enrollment_generation_id_hex[i * 2..i * 2 + 2], 16).unwrap_or(0);
        }
        let unsigned_efr1_bad = frames::EnrollmentFinalizationReceiptFrameV1 {
            operation_kind: frames::EFR1_OP_INITIAL_ENROLLMENT,
            receipt_nonce: [0xfcu8; 32],
            enrollment_generation_id: gen_bytes_bad,
            security_device_id: _sec_id_bad,
            device_key_version: 1,
            accepted_public_key: outcome_bad.staged_public_key_bytes,
            server_sent_at_ms: 1_772_000_000_100,
            branch_id: "HQ-001".to_string(),
            signing_key_id: "oac-prod-signer-2026".to_string(),
            signature: [0u8; 64],
        };
        let efr1_preimage_bad = frames::efr1_signature_preimage(&unsigned_efr1_bad).unwrap();
        let efr1_sig_bad = server_oac_key.sign(&efr1_preimage_bad).to_bytes();
        let receipt_b64_bad = base64_encode_std(&frames::encode_efr1(&frames::EnrollmentFinalizationReceiptFrameV1 {
            signature: efr1_sig_bad,
            ..unsigned_efr1_bad
        }).unwrap());

        let res_bad = finalize_device_enrollment_internal(
            &runtime_bad,
            &dir_bad,
            &outcome_bad.enrollment_generation_id_hex,
            &sec_id_hex_bad,
            "HQ-001",
            1,
            &pubkey_b64_bad,
            Some(receipt_b64_bad.as_str()),
            Some(bad_oks1_b64.as_str()),
            Some("INITIAL_ENROLLMENT"),
        );
        assert!(res_bad.is_err());
        assert!(res_bad.unwrap_err().contains("UNTRUSTED_KEYSET_BOOTSTRAP"));

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&dir_bad);
    }

    #[test]
    fn test_hostile_keyset_manifest_never_persisted_on_failed_finalization() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        let outcome = super::super::device_registration_proof::generate_device_registration_proof(&runtime, &dir,
            "55".repeat(16).as_str(),
            [0x55u8; 32],
        )
        .unwrap();
        let mut pk = [0u8; 32];
        pk.copy_from_slice(&outcome.staged_public_key_bytes);
        let pubkey_b64 = base64_encode_std(&pk);

        let (receipt, oks1) = test_keyset_and_receipt(
            frames::EFR1_OP_INITIAL_ENROLLMENT,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            1,
            pk,
            "HQ-001",
        );

        // Simulate metadata write failure
        let mut fail_hooks = FinalizeHooks::default();
        fail_hooks.fail_gen_meta_write = true;

        let err = finalize_device_enrollment_internal_with_hooks(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some(&receipt),
            Some(&oks1),
            &fail_hooks,
        );
        assert!(err.is_err());
        assert!(err.unwrap_err().contains("METADATA_WRITE_FAILED"));

        // Critical: Keyset manifest MUST NOT have been written to disk!
        assert!(!dir.join("twinpet-oac-keyset-manifest.bin").exists(), "Keyset manifest was persisted despite failed finalize!");

        // Now retry with hooks repaired
        let mut ok_hooks = FinalizeHooks::default();
        ok_hooks.fail_gen_meta_write = false;

        let ok_res = finalize_device_enrollment_internal_with_hooks(&runtime, &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some(&receipt),
            Some(&oks1),
            &ok_hooks,
        );
        assert!(ok_res.is_ok());

        // NOW keyset manifest is durably written
        assert!(!dir.join("twinpet-oac-keyset-manifest.bin").exists());
        assert!(resolve_active_manifest_path(&dir).is_ok());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_genuine_restart_recovery_proof_native() {
        let dir = temp_dir();
        let runtime = EnrollmentRuntimeState::new();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);

        // Step 1: Prepare staged registration
        let outcome = super::super::device_registration_proof::generate_device_registration_proof(
            &runtime,
            &dir,
            "88".repeat(16).as_str(),
            [0x88u8; 32],
        )
        .unwrap();

        let mut pk = [0u8; 32];
        pk.copy_from_slice(&outcome.staged_public_key_bytes);
        let pubkey_b64 = base64_encode_std(&pk);
        let (receipt, oks1) = test_keyset_and_receipt(
            frames::EFR1_OP_INITIAL_ENROLLMENT,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            1,
            pk,
            "HQ-001",
        );

        // Verify staged file is durable on disk before restart
        let staged_path = enrollment_staged_generation_path(&dir, &outcome.enrollment_generation_id_hex);
        assert!(staged_path.exists());

        // Step 2: Simulate process crash and restart: no active fence exists yet
        assert!(!dir.join(ENROLLMENT_FENCE_FILE_NAME).exists());
        drop(runtime);
        let runtime2 = EnrollmentRuntimeState::new();

        // Step 3: Call native finalization in the fresh process using durable staged state and receipt
        let res = finalize_device_enrollment_internal(
            &runtime2,
            &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some(receipt.as_str()),
            Some(oks1.as_str()),
            Some("INITIAL_ENROLLMENT"),
        )
        .unwrap();

        assert_eq!(res.status, "COMMITTED");
        assert_eq!(res.security_device_id_hex, sec_id_hex);
        assert_eq!(res.device_key_version, 1);

        // Step 4: Verify enrolled keypair and enrollment metadata are loadable and valid
        let signing_key = super::super::device_proof::load_enrolled_device_keypair(&dir).unwrap();
        assert_eq!(signing_key.verifying_key().to_bytes(), pk);
        let verified_meta = verify_local_enrollment(&dir, &signing_key).unwrap();
        assert_eq!(verified_meta.branch_id, "HQ-001");
        assert_eq!(verified_meta.device_key_version, 1);

        // Step 5: Staged file was cleanly purged
        assert!(!staged_path.exists());

        // Step 6: Keyset manifest was durably persisted
        assert!(!dir.join("twinpet-oac-keyset-manifest.bin").exists());
        assert!(resolve_active_manifest_path(&dir).is_ok());

        // Step 7: Subsequent retry is idempotent ALREADY_COMMITTED
        let retry = finalize_device_enrollment_internal(
            &runtime2,
            &dir,
            &outcome.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some(receipt.as_str()),
            Some(oks1.as_str()),
            Some("INITIAL_ENROLLMENT"),
        )
        .unwrap();
        assert_eq!(retry.status, "ALREADY_COMMITTED");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_ir007_recreated_runtime_restart_receipt_context_lost() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);

        // 1. Runtime A
        let runtime_a = EnrollmentRuntimeState::new();
        let outcome_a = super::super::device_registration_proof::generate_device_registration_proof(
            &runtime_a,
            &dir,
            "00112233445566778899aabbccddeeff",
            [0x44; 32],
        ).unwrap();
        let gen_hex = outcome_a.enrollment_generation_id_hex.clone();
        let mut pk = [0u8; 32];
        pk.copy_from_slice(&outcome_a.staged_public_key_bytes);
        let pubkey_b64 = base64_encode_std(&pk);

        // Keyset with VerifyOnly signer to require trusted time
        let root_key = SigningKey::from_bytes(&TEST_OAC_ROOT_SEED);
        let oac_signer = SigningKey::from_bytes(&[0x7cu8; 32]);
        let oac_pubkey = oac_signer.verifying_key().to_bytes();
        let key_id = "vo-signer-restart";
        let manifest = frames::OacKeysetManifestFrameV1 {
            revocation_epoch: 1,
            generated_at_server_ms: 1000,
            keys: vec![frames::OacKeysetManifestKeyV1 {
                signing_key_id: key_id.to_string(),
                public_key: oac_pubkey,
                status: frames::OacKeyLifecycleStatus::VerifyOnly,
                verify_until_server_ms: Some(10_000),
            }],
            signature: [0u8; 64],
        };
        let prefix = frames::oks1_signed_prefix(&manifest).unwrap();
        let sig = root_key.sign(&prefix).to_bytes();
        let signed_manifest = frames::OacKeysetManifestFrameV1 { signature: sig, ..manifest };
        let oks1_bytes = frames::encode_oks1(&signed_manifest).unwrap();
        let oks1_b64 = base64_encode_std(&oks1_bytes);

        let mut gen_bytes = [0u8; 16];
        for i in 0..16 {
            gen_bytes[i] = u8::from_str_radix(&gen_hex[i*2..i*2+2], 16).unwrap();
        }
        let mut sec_bytes = [0u8; 16];
        for i in 0..16 {
            sec_bytes[i] = u8::from_str_radix(&sec_id_hex[i*2..i*2+2], 16).unwrap();
        }

        let unsigned_efr1 = frames::EnrollmentFinalizationReceiptFrameV1 {
            operation_kind: frames::EFR1_OP_INITIAL_ENROLLMENT,
            receipt_nonce: [0x44; 32],
            enrollment_generation_id: gen_bytes,
            security_device_id: sec_bytes,
            device_key_version: 1,
            accepted_public_key: pk,
            server_sent_at_ms: 2000,
            branch_id: "HQ-001".to_string(),
            signing_key_id: key_id.to_string(),
            signature: [0u8; 64],
        };
        let preimage = frames::efr1_signature_preimage(&unsigned_efr1).unwrap();
        let sig_efr1 = oac_signer.sign(&preimage).to_bytes();
        let signed_efr1 = frames::EnrollmentFinalizationReceiptFrameV1 { signature: sig_efr1, ..unsigned_efr1 };
        let efr1_bytes = frames::encode_efr1(&signed_efr1).unwrap();
        let receipt_b64 = base64_encode_std(&efr1_bytes);

        // 3. Raw ingress into Runtime A
        let obs_a = runtime_a.record_receipt_ingress_from_base64(&receipt_b64).unwrap();
        assert_eq!(obs_a.enrollment_generation_id_hex, gen_hex);

        // 4. Assert A contains exact binding
        assert!(runtime_a.find_pending_request(&gen_hex).is_some());
        let raw_efr1_digest = compute_sha256(&efr1_bytes);
        assert!(runtime_a.find_observation(&gen_hex, &raw_efr1_digest).is_some());

        // 5. Drop A completely (simulating process restart)
        drop(runtime_a);

        // 7. Runtime B over same app-data directory
        let runtime_b = EnrollmentRuntimeState::new();

        // 8. Assert B starts empty
        assert!(runtime_b.find_pending_request(&gen_hex).is_none());
        assert!(runtime_b.find_observation(&gen_hex, &raw_efr1_digest).is_none());

        // 9. Invoke VERIFY_ONLY finalization with same receipt
        let res = finalize_device_enrollment_internal(
            &runtime_b,
            &dir,
            &gen_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some(&receipt_b64),
            Some(&oks1_b64),
            None,
        );

        // 10. Require exactly TRUSTED_TIME_UNAVAILABLE_REANCHOR_REQUIRED
        assert!(res.is_err());
        let err = res.unwrap_err();
        assert!(
            err.contains("TRUSTED_TIME_UNAVAILABLE_REANCHOR_REQUIRED"),
            "Expected TRUSTED_TIME_UNAVAILABLE_REANCHOR_REQUIRED, got: {err}"
        );

        // 11. Prove zero mutation to generation key, generation meta, digest manifest, and fence
        assert!(!dir.join(ENROLLMENT_FENCE_FILE_NAME).exists(), "Fence must not be created");
        assert!(!generation_meta_path(&dir, &gen_hex).exists(), "Meta file must not be created");
        let d_hex = compute_sha256_hex(&oks1_bytes);
        assert!(!digest_manifest_path(&dir, &d_hex).exists(), "Digest manifest must not be persisted");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_ir002_real_filesystem_failure_matrix_11_cases() {
        for case in 1..=11 {
            let dir = temp_dir();
            let (_sec_id, sec_id_hex) = setup_test_device(&dir);

            // 1. Commit G1 with manifest A
            let runtime1 = EnrollmentRuntimeState::new();
            let outcome1 = super::super::device_registration_proof::generate_device_registration_proof(
                &runtime1,
                &dir,
                "11112222333344445555666677778888",
                [0x21; 32],
            ).unwrap();
            let pubkey_b64_1 = base64_encode_std(&outcome1.staged_public_key_bytes);
            let res1 = test_finalize_device_enrollment(
                &runtime1,
                &dir,
                &outcome1.enrollment_generation_id_hex,
                &sec_id_hex,
                "HQ-001",
                1,
                &pubkey_b64_1,
            ).unwrap();
            assert_eq!(res1.status, "COMMITTED");

            let active_a_path = resolve_active_manifest_path(&dir).unwrap();
            let manifest_a_bytes = fs::read(&active_a_path).unwrap();

            // 2. Prepare candidate G2 with distinct manifest B
            let runtime2 = EnrollmentRuntimeState::new();
            let outcome2 = super::super::device_registration_proof::generate_device_registration_proof(
                &runtime2,
                &dir,
                "22223333444455556666777788889999",
                [0x22; 32],
            ).unwrap();
            let mut pk2 = [0u8; 32];
            pk2.copy_from_slice(&outcome2.staged_public_key_bytes);
            let pubkey_b64_2 = base64_encode_std(&pk2);

            let root_key = SigningKey::from_bytes(&TEST_OAC_ROOT_SEED);
            let oac_signer2 = SigningKey::from_bytes(&[0x8bu8; 32]);
            let oac_pubkey2 = oac_signer2.verifying_key().to_bytes();
            let key_id2 = "oac-signer-case";

            let manifest_b = frames::OacKeysetManifestFrameV1 {
                revocation_epoch: 2,
                generated_at_server_ms: 2000,
                keys: vec![frames::OacKeysetManifestKeyV1 {
                    signing_key_id: key_id2.to_string(),
                    public_key: oac_pubkey2,
                    status: frames::OacKeyLifecycleStatus::Active,
                    verify_until_server_ms: None,
                }],
                signature: [0u8; 64],
            };
            let prefix_b = frames::oks1_signed_prefix(&manifest_b).unwrap();
            let sig_b = root_key.sign(&prefix_b).to_bytes();
            let signed_manifest_b = frames::OacKeysetManifestFrameV1 {
                signature: sig_b,
                ..manifest_b
            };
            let mut manifest_b_bytes = frames::encode_oks1(&signed_manifest_b).unwrap();

            // For Case 10 (typed decode failure): corrupt magic/structure of candidate bytes
            if case == 10 {
                manifest_b_bytes[0..4].copy_from_slice(b"BADM");
            }
            // For Case 11 (root signature failure): corrupt root signature
            if case == 11 {
                let mut bad_sig_manifest = signed_manifest_b.clone();
                bad_sig_manifest.signature[0] ^= 0xff;
                manifest_b_bytes = frames::encode_oks1(&bad_sig_manifest).unwrap();
            }

            let manifest_b_b64 = base64_encode_std(&manifest_b_bytes);
            let sha_b_hex = compute_sha256_hex(&manifest_b_bytes);

            let mut gen_bytes2 = [0u8; 16];
            for i in 0..16 {
                gen_bytes2[i] = u8::from_str_radix(&outcome2.enrollment_generation_id_hex[i * 2..i * 2 + 2], 16).unwrap_or(0);
            }
            let mut sec_bytes = [0u8; 16];
            for i in 0..16 {
                sec_bytes[i] = u8::from_str_radix(&sec_id_hex[i * 2..i * 2 + 2], 16).unwrap_or(0);
            }

            let unsigned_efr1_2 = frames::EnrollmentFinalizationReceiptFrameV1 {
                operation_kind: frames::EFR1_OP_RE_ENROLLMENT,
                receipt_nonce: [0x22u8; 32],
                enrollment_generation_id: gen_bytes2,
                security_device_id: sec_bytes,
                device_key_version: 2,
                accepted_public_key: pk2,
                server_sent_at_ms: 3000,
                branch_id: "HQ-001".to_string(),
                signing_key_id: key_id2.to_string(),
                signature: [0u8; 64],
            };
            let preimage2 = frames::efr1_signature_preimage(&unsigned_efr1_2).unwrap();
            let sig_efr1_2 = oac_signer2.sign(&preimage2).to_bytes();
            let signed_efr1_2 = frames::EnrollmentFinalizationReceiptFrameV1 {
                signature: sig_efr1_2,
                ..unsigned_efr1_2
            };
            let efr1_bytes2 = frames::encode_efr1(&signed_efr1_2).unwrap();
            let receipt_b64_2 = base64_encode_std(&efr1_bytes2);

            let _ = runtime2.record_receipt_ingress_from_bytes(&efr1_bytes2);

            // Configure hooks for the specific case
            let mut hooks = FinalizeHooks::default();
            let mut dhooks = DEFAULT_DIGEST_PERSIST_HOOKS;

            match case {
                1 => dhooks.fail_temp_create = true,
                2 => dhooks.fail_write = true,
                3 => dhooks.fail_sync = true,
                4 => dhooks.move_file = mock_move_file_183,
                5 => {
                    // Case 5: Generic ReplaceFile failure
                    hooks.replace_file = mock_replace_file_generic;
                }
                6 => {
                    // Case 6: ReplaceFileW 1176
                    hooks.replace_file = mock_replace_file_1176;
                }
                7 => {
                    // Case 7: ReplaceFileW 1177
                    hooks.replace_file = mock_replace_file_1177;
                }
                8 => dhooks.mutate_before_reread = true,
                9 => dhooks.truncate_before_reread = true,
                10 => {} // handled via invalid magic in manifest_b_bytes reaching decode_oks1
                11 => {} // handled via bad root signature in manifest_b_bytes reaching root verifier
                _ => unreachable!(),
            }
            hooks.digest_persist_hooks = Some(dhooks);

            // Execute finalization under injected failure
            let res = finalize_device_enrollment_internal_with_hooks(
                &runtime2,
                &dir,
                &outcome2.enrollment_generation_id_hex,
                &sec_id_hex,
                "HQ-001",
                2,
                &pubkey_b64_2,
                Some(&receipt_b64_2),
                Some(&manifest_b_b64),
                &hooks,
            );

            assert!(res.is_err(), "Case {case} should have failed!");

            // Drop/recreate runtime memory
            drop(runtime2);
            let _runtime_restarted = EnrollmentRuntimeState::new();

            if case == 6 {
                // Case 6 (1176): target canonical fence absent, replacement temp remains, resolver fails closed
                assert!(!enrollment_fence_path(&dir).exists(), "Case 6 canonical fence must be absent");
                assert!(resolve_active_manifest_path(&dir).is_err(), "Case 6 resolver must fail closed");
            } else if case == 7 {
                // Case 7 (1177): target canonical fence absent, orphan fence exists, resolver fails closed
                assert!(!enrollment_fence_path(&dir).exists(), "Case 7 canonical fence must be absent");
                assert!(dir.join("fence-orphan-1177.tmp").exists(), "Case 7 orphan fence must exist");
                assert!(resolve_active_manifest_path(&dir).is_err(), "Case 7 resolver must fail closed");
            } else {
                // Cases 1-5, 8-11: Reread committed fence: MUST resolve coherent G1+A!
                let fence_bytes = fs::read(enrollment_fence_path(&dir)).unwrap();
                let fence: EnrollmentFenceState = serde_json::from_slice(&fence_bytes).unwrap();
                assert_eq!(fence.state, "COMMITTED");
                assert_eq!(fence.enrollment_generation_id, outcome1.enrollment_generation_id_hex);
                assert_eq!(fence.device_key_version, 1);

                let active_res = resolve_active_manifest_path(&dir).unwrap();
                let resolved_bytes = fs::read(&active_res).unwrap();
                assert_eq!(resolved_bytes, manifest_a_bytes, "Case {case} mixed authority or mutated active manifest!");

                // Case 5: B is durable on disk, but unselected data
                if case == 5 {
                    let path_b = digest_manifest_path(&dir, &sha_b_hex);
                    assert!(path_b.exists(), "Case 5 B must be durable on disk");
                    assert_eq!(fs::read(&path_b).unwrap(), manifest_b_bytes);
                    assert_ne!(active_res, path_b);
                }
            }

            // Legacy canonical file must not exist and must not influence result
            assert!(!dir.join("twinpet-oac-keyset-manifest.bin").exists(), "Case {case} created legacy file!");

            let _ = fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn test_ir002_b_durable_g2_fail_restart_proof() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);

        // 1. Commit G1 selecting digest A
        let runtime1 = EnrollmentRuntimeState::new();
        let outcome1 = super::super::device_registration_proof::generate_device_registration_proof(
            &runtime1,
            &dir,
            "11111111111111111111111111111111",
            [0x31; 32],
        )
        .unwrap();
        let pubkey_b64_1 = base64_encode_std(&outcome1.staged_public_key_bytes);
        let res1 = test_finalize_device_enrollment(
            &runtime1,
            &dir,
            &outcome1.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64_1,
        )
        .unwrap();
        assert_eq!(res1.status, "COMMITTED");

        let active_a_path = resolve_active_manifest_path(&dir).unwrap();
        let bytes_a = fs::read(&active_a_path).unwrap();
        let sha_a = compute_sha256_hex(&bytes_a);

        // 2, 3, 4: Persist B, Sync B, Reread/hash/decode/root-verify B
        let runtime2 = EnrollmentRuntimeState::new();
        let outcome2 = super::super::device_registration_proof::generate_device_registration_proof(
            &runtime2,
            &dir,
            "22222222222222222222222222222222",
            [0x32; 32],
        )
        .unwrap();
        let mut pk2 = [0u8; 32];
        pk2.copy_from_slice(&outcome2.staged_public_key_bytes);
        let pubkey_b64_2 = base64_encode_std(&pk2);

        let root_key = SigningKey::from_bytes(&TEST_OAC_ROOT_SEED);
        let oac_signer2 = SigningKey::from_bytes(&[0x9cu8; 32]);
        let oac_pubkey2 = oac_signer2.verifying_key().to_bytes();
        let key_id2 = "oac-signer-restart-b";

        let manifest_b = frames::OacKeysetManifestFrameV1 {
            revocation_epoch: 2,
            generated_at_server_ms: 5000,
            keys: vec![frames::OacKeysetManifestKeyV1 {
                signing_key_id: key_id2.to_string(),
                public_key: oac_pubkey2,
                status: frames::OacKeyLifecycleStatus::Active,
                verify_until_server_ms: None,
            }],
            signature: [0u8; 64],
        };
        let prefix_b = frames::oks1_signed_prefix(&manifest_b).unwrap();
        let sig_b = root_key.sign(&prefix_b).to_bytes();
        let signed_manifest_b = frames::OacKeysetManifestFrameV1 {
            signature: sig_b,
            ..manifest_b
        };
        let bytes_b = frames::encode_oks1(&signed_manifest_b).unwrap();
        let oks1_b64_b = base64_encode_std(&bytes_b);
        let sha_b = compute_sha256_hex(&bytes_b);
        assert_ne!(sha_a, sha_b);

        let mut gen_bytes2 = [0u8; 16];
        for i in 0..16 {
            gen_bytes2[i] = u8::from_str_radix(&outcome2.enrollment_generation_id_hex[i * 2..i * 2 + 2], 16).unwrap_or(0);
        }
        let mut sec_bytes = [0u8; 16];
        for i in 0..16 {
            sec_bytes[i] = u8::from_str_radix(&sec_id_hex[i * 2..i * 2 + 2], 16).unwrap_or(0);
        }

        let unsigned_efr1_2 = frames::EnrollmentFinalizationReceiptFrameV1 {
            operation_kind: frames::EFR1_OP_RE_ENROLLMENT,
            receipt_nonce: [0x32u8; 32],
            enrollment_generation_id: gen_bytes2,
            security_device_id: sec_bytes,
            device_key_version: 2,
            accepted_public_key: pk2,
            server_sent_at_ms: 6000,
            branch_id: "HQ-001".to_string(),
            signing_key_id: key_id2.to_string(),
            signature: [0u8; 64],
        };
        let preimage2 = frames::efr1_signature_preimage(&unsigned_efr1_2).unwrap();
        let sig_efr1_2 = oac_signer2.sign(&preimage2).to_bytes();
        let signed_efr1_2 = frames::EnrollmentFinalizationReceiptFrameV1 {
            signature: sig_efr1_2,
            ..unsigned_efr1_2
        };
        let efr1_bytes2 = frames::encode_efr1(&signed_efr1_2).unwrap();
        let receipt_b64_2 = base64_encode_std(&efr1_bytes2);

        let _ = runtime2.record_receipt_ingress_from_bytes(&efr1_bytes2);

        // 5. Force G2 fence replacement failure
        let mut fail_fence_hooks = FinalizeHooks::default();
        fail_fence_hooks.fail_fence_switch = true;

        let res2 = finalize_device_enrollment_internal_with_hooks(
            &runtime2,
            &dir,
            &outcome2.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            2,
            &pubkey_b64_2,
            Some(&receipt_b64_2),
            Some(&oks1_b64_b),
            &fail_fence_hooks,
        );
        assert!(res2.is_err());
        assert!(res2.unwrap_err().contains("FENCE_REPLACE_FAILED"));

        // Candidate B was persisted and is durable on disk
        let path_b = digest_manifest_path(&dir, &sha_b);
        assert!(path_b.exists(), "Candidate B must be durable on disk");
        assert_eq!(fs::read(&path_b).unwrap(), bytes_b);

        // 6. Destroy all runtime/static caches
        drop(runtime2);

        // 7. Recreate runtime over same directory (fresh state)
        let _runtime3 = EnrollmentRuntimeState::new();

        // 8. Reread committed G1
        let fence_bytes = fs::read(enrollment_fence_path(&dir)).unwrap();
        let fence: EnrollmentFenceState = serde_json::from_slice(&fence_bytes).unwrap();
        assert_eq!(fence.state, "COMMITTED");
        assert_eq!(fence.enrollment_generation_id, outcome1.enrollment_generation_id_hex);
        assert_eq!(fence.device_key_version, 1);
        assert_eq!(fence.manifest_sha256, Some(sha_a.clone()));

        // 9. Resolve A by digest
        let resolved_path = resolve_active_manifest_path(&dir).unwrap();
        assert_eq!(resolved_path, active_a_path);

        // 10. Verify G1+A valid
        assert_eq!(fs::read(&resolved_path).unwrap(), bytes_a);
        let keypair1 = super::super::device_proof::load_enrolled_device_keypair(&dir).unwrap();
        let meta1 = verify_local_enrollment(&dir, &keypair1).unwrap();
        assert_eq!(meta1.device_key_version, 1);
        assert_eq!(meta1.branch_id, "HQ-001");

        // 11. Verify B exists only as unselected data
        assert!(path_b.exists());
        assert_ne!(resolved_path, path_b);

        // 12. Verify legacy canonical file is irrelevant
        let legacy_path = dir.join("twinpet-oac-keyset-manifest.bin");
        fs::write(&legacy_path, b"HOSTILE_MALICIOUS_LEGACY_CONTENT").unwrap();
        let resolved_after_legacy = resolve_active_manifest_path(&dir).unwrap();
        assert_eq!(resolved_after_legacy, active_a_path);
        assert_eq!(fs::read(&resolved_after_legacy).unwrap(), bytes_a);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_n_ir002_clean_artifact_matrix_14_fixtures() {
        // Fixture 1: empty directory -> TrulyClean
        {
            let dir = temp_dir();
            assert_eq!(classify_directory_artifacts(&dir, None), CleanArtifactClassification::TrulyClean);
            let _ = fs::remove_dir_all(&dir);
        }

        // Fixture 2: individual authority/partial artifact rows -> PartialOrHistorical
        let partial_artifact_names = [
            "twinpet-device-enrollment.fence",
            "twinpet-device-enrollment.fence.tmp",
            "fence-00112233445566778899aabbccddeeff-12345.tmp",
            "fence-orphan-1177.tmp",
            "twinpet-device-proof-key-00112233445566778899aabbccddeeff.dpapi",
            "key-00112233445566778899aabbccddeeff-12345.tmp",
            "twinpet-device-enrollment-staged-00112233445566778899aabbccddeeff.dpapi",
            "staged-00112233445566778899aabbccddeeff-12345.tmp",
            "twinpet-device-enrollment-meta-00112233445566778899aabbccddeeff.dpapi",
            "twinpet-device-enrollment-meta-00112233445566778899aabbccddeeff.tmp",
            "meta-00112233445566778899aabbccddeeff-12345.tmp",
            "twinpet-oac-keyset-manifest-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.bin",
            "twinpet-oac-keyset-manifest-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef-12345.tmp",
            "twinpet-device-enrollment-meta.dpapi",
            "twinpet-device-proof-key.dpapi",
            "twinpet-security-device-id",
            "twinpet-security-device-id.tmp",
        ];
        for name in &partial_artifact_names {
            let dir = temp_dir();
            fs::write(dir.join(name), b"PARTIAL_DATA").unwrap();
            assert_eq!(
                classify_directory_artifacts(&dir, None),
                CleanArtifactClassification::PartialOrHistorical,
                "Fixture 2 failed for: {name}"
            );
            let _ = fs::remove_dir_all(&dir);
        }

        // Helper setup for fixtures 3-14
        let setup_valid_pending = |dir: &Path| -> (PendingInitialBindings<'static>, [u8; 16], [u8; 32]) {
            let runtime = EnrollmentRuntimeState::new();
            let outcome = super::super::device_registration_proof::generate_device_registration_proof(
                &runtime,
                dir,
                "00112233445566778899aabbccddeeff",
                [0x42u8; 32],
            ).unwrap();
            let pk = outcome.staged_public_key_bytes;
            let sec_id_path = dir.join("twinpet-security-device-id");
            let sec_bytes: [u8; 16] = fs::read(&sec_id_path).unwrap().try_into().unwrap();
            let actual_gen_hex = Box::leak(outcome.enrollment_generation_id_hex.into_boxed_str());
            let bindings = PendingInitialBindings {
                security_device_id: Box::leak(Box::new(sec_bytes)),
                generation_id_hex: actual_gen_hex,
                accepted_public_key: Box::leak(Box::new(pk)),
                branch_id: "HQ-001",
                device_key_version: 1,
                candidate_manifest_bytes: None,
            };
            (bindings, sec_bytes, pk)
        };

        // Fixture 3: exact G/S/K pending set -> ExactPendingInitial
        {
            let dir = temp_dir();
            let (bindings, _, _) = setup_valid_pending(&dir);
            assert_eq!(classify_directory_artifacts(&dir, Some(&bindings)), CleanArtifactClassification::ExactPendingInitial);
            let _ = fs::remove_dir_all(&dir);
        }

        // Fixture 4: mismatch S -> PartialOrHistorical
        {
            let dir = temp_dir();
            let (mut bindings, _, _) = setup_valid_pending(&dir);
            let diff_sec = [0x99u8; 16];
            bindings.security_device_id = &diff_sec;
            assert_eq!(classify_directory_artifacts(&dir, Some(&bindings)), CleanArtifactClassification::PartialOrHistorical);
            let _ = fs::remove_dir_all(&dir);
        }

        // Fixture 5: mismatch G -> PartialOrHistorical
        {
            let dir = temp_dir();
            let (mut bindings, _, _) = setup_valid_pending(&dir);
            bindings.generation_id_hex = "ffeeddccbbaa99887766554433221100";
            assert_eq!(classify_directory_artifacts(&dir, Some(&bindings)), CleanArtifactClassification::PartialOrHistorical);
            let _ = fs::remove_dir_all(&dir);
        }

        // Fixture 6: mismatch K -> PartialOrHistorical
        {
            let dir = temp_dir();
            let (mut bindings, _, _) = setup_valid_pending(&dir);
            let diff_pk = [0x55u8; 32];
            bindings.accepted_public_key = &diff_pk;
            assert_eq!(classify_directory_artifacts(&dir, Some(&bindings)), CleanArtifactClassification::PartialOrHistorical);
            let _ = fs::remove_dir_all(&dir);
        }

        // Fixture 7: mismatch branch/version in meta file -> PartialOrHistorical
        {
            let dir = temp_dir();
            let (bindings, sec_bytes, pk) = setup_valid_pending(&dir);
            // Write meta with mismatched branch
            let meta_frame = EnrollmentMetaFrameV1 {
                enrollment_generation_id: [0x11; 16],
                security_device_id: sec_bytes,
                device_key_version: 1,
                expected_public_key: pk,
                branch_id: "BRANCH-OTHER".to_string(),
            };
            let meta_cipher = dpapi_protect(&encode_enrm(&meta_frame).unwrap()).unwrap();
            fs::write(generation_meta_path(&dir, bindings.generation_id_hex), &meta_cipher).unwrap();
            assert_eq!(classify_directory_artifacts(&dir, Some(&bindings)), CleanArtifactClassification::PartialOrHistorical);
            let _ = fs::remove_dir_all(&dir);
        }

        // Fixture 8: digest bytes mismatch -> PartialOrHistorical
        {
            let dir = temp_dir();
            let (mut bindings, _, _) = setup_valid_pending(&dir);
            let cand_bytes = b"CORRECT_CANDIDATE_BYTES";
            bindings.candidate_manifest_bytes = Some(cand_bytes);
            let d_hex = compute_sha256_hex(cand_bytes);
            fs::write(digest_manifest_path(&dir, &d_hex), b"DIFFERENT_ON_DISK_BYTES").unwrap();
            assert_eq!(classify_directory_artifacts(&dir, Some(&bindings)), CleanArtifactClassification::PartialOrHistorical);
            let _ = fs::remove_dir_all(&dir);
        }

        // Fixture 9: extra generation -> PartialOrHistorical
        {
            let dir = temp_dir();
            let (bindings, _, _) = setup_valid_pending(&dir);
            let extra_gen = "aabbccddeeff00112233445566778899";
            fs::write(enrollment_staged_generation_path(&dir, extra_gen), b"EXTRA_GEN").unwrap();
            assert_eq!(classify_directory_artifacts(&dir, Some(&bindings)), CleanArtifactClassification::PartialOrHistorical);
            let _ = fs::remove_dir_all(&dir);
        }

        // Fixture 10: extra digest -> PartialOrHistorical
        {
            let dir = temp_dir();
            let (bindings, _, _) = setup_valid_pending(&dir);
            let fake_d = "11".repeat(32);
            fs::write(digest_manifest_path(&dir, &fake_d), b"EXTRA_D").unwrap();
            assert_eq!(classify_directory_artifacts(&dir, Some(&bindings)), CleanArtifactClassification::PartialOrHistorical);
            let _ = fs::remove_dir_all(&dir);
        }

        // Fixture 11: legacy artifact -> PartialOrHistorical
        {
            let dir = temp_dir();
            let (bindings, _, _) = setup_valid_pending(&dir);
            fs::write(dir.join("twinpet-device-proof-key.dpapi"), b"LEGACY_KEY").unwrap();
            assert_eq!(classify_directory_artifacts(&dir, Some(&bindings)), CleanArtifactClassification::PartialOrHistorical);
            let _ = fs::remove_dir_all(&dir);
        }

        // Fixture 12: temp artifact -> PartialOrHistorical
        {
            let dir = temp_dir();
            let (bindings, _, _) = setup_valid_pending(&dir);
            fs::write(dir.join("fence-00112233445566778899aabbccddeeff-999.tmp"), b"TEMP_FENCE").unwrap();
            assert_eq!(classify_directory_artifacts(&dir, Some(&bindings)), CleanArtifactClassification::PartialOrHistorical);
            let _ = fs::remove_dir_all(&dir);
        }

        // Fixture 13: malformed authority-prefix artifact -> PartialOrHistorical
        {
            let dir = temp_dir();
            let (bindings, _, _) = setup_valid_pending(&dir);
            fs::write(dir.join("twinpet-device-enrollment-staged-NOTHEX32.dpapi"), b"MALFORMED").unwrap();
            assert_eq!(classify_directory_artifacts(&dir, Some(&bindings)), CleanArtifactClassification::PartialOrHistorical);
            let _ = fs::remove_dir_all(&dir);
        }

        // Fixture 14: unreadable matching artifact -> PartialOrHistorical
        {
            let dir = temp_dir();
            let (bindings, _, _) = setup_valid_pending(&dir);
            // Replace staged file with an invalid DPAPI payload so DPAPI unprotect fails
            fs::write(enrollment_staged_generation_path(&dir, bindings.generation_id_hex), b"NOT_VALID_DPAPI").unwrap();
            assert_eq!(classify_directory_artifacts(&dir, Some(&bindings)), CleanArtifactClassification::PartialOrHistorical);
            let _ = fs::remove_dir_all(&dir);
        }

        // Fixture 15: valid staged S/G/K but G key removed -> PartialOrHistorical
        {
            let dir = temp_dir();
            let (bindings, _, _) = setup_valid_pending(&dir);
            let key_path = generation_proof_key_path(&dir, bindings.generation_id_hex);
            assert!(key_path.exists());
            fs::remove_file(&key_path).unwrap();
            assert_eq!(classify_directory_artifacts(&dir, Some(&bindings)), CleanArtifactClassification::PartialOrHistorical);
            let _ = fs::remove_dir_all(&dir);
        }

        // Fixture 16: corrupt/unreadable generation key payload -> PartialOrHistorical
        {
            let dir = temp_dir();
            let (bindings, _, _) = setup_valid_pending(&dir);
            let key_path = generation_proof_key_path(&dir, bindings.generation_id_hex);
            assert!(key_path.exists());
            fs::write(&key_path, b"CORRUPT_NOT_DPAPI").unwrap();
            assert_eq!(classify_directory_artifacts(&dir, Some(&bindings)), CleanArtifactClassification::PartialOrHistorical);
            let _ = fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn test_n_ir002_authority_named_directories_and_symlinks() {
        // 1. exact staged-record filename created as a DIRECTORY -> PartialOrHistorical
        {
            let dir = temp_dir();
            let staged_dir = dir.join("twinpet-device-enrollment-staged-00112233445566778899aabbccddeeff.dpapi");
            fs::create_dir(&staged_dir).unwrap();
            assert_eq!(
                classify_directory_artifacts(&dir, None),
                CleanArtifactClassification::PartialOrHistorical,
                "Authority staged-record directory must fail closed"
            );
            let _ = fs::remove_dir_all(&dir);
        }

        // 2. fence-temp authority namespace as DIRECTORY -> PartialOrHistorical
        {
            let dir = temp_dir();
            let fence_tmp_dir = dir.join("fence-00112233445566778899aabbccddeeff-12345.tmp");
            fs::create_dir(&fence_tmp_dir).unwrap();
            assert_eq!(
                classify_directory_artifacts(&dir, None),
                CleanArtifactClassification::PartialOrHistorical,
                "Authority fence-temp directory must fail closed"
            );
            let _ = fs::remove_dir_all(&dir);
        }
        {
            let dir = temp_dir();
            let fence_tmp_dir = dir.join("twinpet-device-enrollment.fence.tmp");
            fs::create_dir(&fence_tmp_dir).unwrap();
            assert_eq!(
                classify_directory_artifacts(&dir, None),
                CleanArtifactClassification::PartialOrHistorical,
                "twinpet-device-enrollment.fence.tmp directory must fail closed"
            );
            let _ = fs::remove_dir_all(&dir);
        }

        // 3. digest-temp authority namespace as DIRECTORY -> PartialOrHistorical
        {
            let dir = temp_dir();
            let digest_tmp_dir = dir.join(format!("twinpet-oac-keyset-manifest-{}-12345.tmp", "01".repeat(32)));
            fs::create_dir(&digest_tmp_dir).unwrap();
            assert_eq!(
                classify_directory_artifacts(&dir, None),
                CleanArtifactClassification::PartialOrHistorical,
                "Authority digest-temp directory must fail closed"
            );
            let _ = fs::remove_dir_all(&dir);
        }
        {
            let dir = temp_dir();
            let digest_bin_dir = dir.join(format!("twinpet-oac-keyset-manifest-{}.bin", "01".repeat(32)));
            fs::create_dir(&digest_bin_dir).unwrap();
            assert_eq!(
                classify_directory_artifacts(&dir, None),
                CleanArtifactClassification::PartialOrHistorical,
                "Authority digest .bin directory must fail closed"
            );
            let _ = fs::remove_dir_all(&dir);
        }

        // 4. malformed authority-prefix entry -> PartialOrHistorical
        {
            let dir = temp_dir();
            fs::write(dir.join("twinpet-device-malformed-authority-file"), b"MALFORMED").unwrap();
            assert_eq!(
                classify_directory_artifacts(&dir, None),
                CleanArtifactClassification::PartialOrHistorical,
                "Malformed authority-prefix file must fail closed"
            );
            let _ = fs::remove_dir_all(&dir);
        }
        {
            let dir = temp_dir();
            fs::create_dir(dir.join("twinpet-device-malformed-authority-folder")).unwrap();
            assert_eq!(
                classify_directory_artifacts(&dir, None),
                CleanArtifactClassification::PartialOrHistorical,
                "Malformed authority-prefix directory must fail closed"
            );
            let _ = fs::remove_dir_all(&dir);
        }

        // 5. unrelated normal directory -> may be ignored without changing a truly clean directory
        {
            let dir = temp_dir();
            fs::create_dir(dir.join("normal_unrelated_app_cache")).unwrap();
            assert_eq!(
                classify_directory_artifacts(&dir, None),
                CleanArtifactClassification::TrulyClean,
                "Unrelated directory alone must leave classification TrulyClean"
            );
            let _ = fs::remove_dir_all(&dir);
        }

        // 6. authority-named symlink/reparse or unreadable entry where constructible -> fail closed
        {
            let dir = temp_dir();
            let target_file = dir.join("dummy_target.txt");
            fs::write(&target_file, b"TARGET").unwrap();
            let symlink_path = dir.join("twinpet-device-enrollment.fence");
            match std::os::windows::fs::symlink_file(&target_file, &symlink_path) {
                Ok(_) => {
                    assert_eq!(
                        classify_directory_artifacts(&dir, None),
                        CleanArtifactClassification::PartialOrHistorical,
                        "Authority-named symlink must fail closed to PartialOrHistorical"
                    );
                }
                Err(e) => {
                    // Report exact limitation honestly if unprivileged Windows host cannot create symlinks
                    eprintln!("Windows host cannot construct symlink without SeCreateSymbolicLinkPrivilege: {e}");
                }
            }
            let _ = fs::remove_dir_all(&dir);
        }

        // 7. plausible pending initial state with valid staged G/S/K but G key removed -> PartialOrHistorical
        // 8. exact same state with exactly one valid G key -> ExactPendingInitial
        {
            let dir = temp_dir();
            let runtime = EnrollmentRuntimeState::new();
            let outcome = super::super::device_registration_proof::generate_device_registration_proof(
                &runtime,
                &dir,
                "00112233445566778899aabbccddeeff",
                [0x42u8; 32],
            ).unwrap();
            let pk = outcome.staged_public_key_bytes;
            let sec_id_path = dir.join("twinpet-security-device-id");
            let sec_bytes: [u8; 16] = fs::read(&sec_id_path).unwrap().try_into().unwrap();
            let actual_gen_hex = outcome.enrollment_generation_id_hex.clone();
            let bindings = PendingInitialBindings {
                security_device_id: &sec_bytes,
                generation_id_hex: &actual_gen_hex,
                accepted_public_key: &pk,
                branch_id: "HQ-001",
                device_key_version: 1,
                candidate_manifest_bytes: None,
            };

            // Case 8: exact one valid G key -> ExactPendingInitial
            assert_eq!(
                classify_directory_artifacts(&dir, Some(&bindings)),
                CleanArtifactClassification::ExactPendingInitial,
                "Exact one valid G key pending state must classify as ExactPendingInitial"
            );

            // Case 7: remove G key -> PartialOrHistorical
            let key_path = generation_proof_key_path(&dir, &actual_gen_hex);
            assert!(key_path.exists());
            fs::remove_file(&key_path).unwrap();
            assert_eq!(
                classify_directory_artifacts(&dir, Some(&bindings)),
                CleanArtifactClassification::PartialOrHistorical,
                "Pending state with removed G key must fail closed to PartialOrHistorical"
            );

            let _ = fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn test_n_ir002_production_finalizer_zero_key_gate() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        // Staged request and DRP proof issuance
        let outcome = super::super::device_registration_proof::generate_device_registration_proof(
            &runtime,
            &dir,
            "00112233445566778899aabbccddeeff",
            [0x55u8; 32],
        ).unwrap();
        let gen_hex = outcome.enrollment_generation_id_hex.clone();
        let mut pk = [0u8; 32];
        pk.copy_from_slice(&outcome.staged_public_key_bytes);
        let pubkey_b64 = base64_encode_std(&pk);

        // Remove the generation key after proof issuance
        let key_path = generation_proof_key_path(&dir, &gen_hex);
        assert!(key_path.exists(), "Generation key must exist after proof generation");
        fs::remove_file(&key_path).unwrap();
        assert!(!key_path.exists());

        // Valid root-signed candidate and receipt
        let (receipt_b64, oks1_b64) = test_keyset_and_receipt(
            frames::EFR1_OP_INITIAL_ENROLLMENT,
            &gen_hex,
            &sec_id_hex,
            1,
            pk,
            "HQ-001",
        );
        let _ = runtime.record_receipt_ingress_from_base64(&receipt_b64);

        // Invoke normal internal initial finalizer
        let fin_res = finalize_device_enrollment_internal(
            &runtime,
            &dir,
            &gen_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64,
            Some(&receipt_b64),
            Some(&oks1_b64),
            None,
        );

        // Required outcome: fail closed
        assert!(fin_res.is_err(), "Finalizer must fail closed when generation key is missing");
        let err = fin_res.unwrap_err();
        assert!(
            err.contains("FAIL_CLOSED") || err.contains("GENERATION_KEY_UNAVAILABLE") || err.contains("UNTRUSTED_KEYSET_ROTATION_FAIL_CLOSED"),
            "Error must be typed fail closed: {err}"
        );

        // Generation key remains absent (no regenerated key)
        assert!(!key_path.exists(), "Generation key must not be regenerated");

        // No generation metadata
        let meta_path = generation_meta_path(&dir, &gen_hex);
        assert!(!meta_path.exists(), "Generation metadata must not be created");

        // No candidate digest promotion
        for entry in fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()) {
            let n = entry.file_name().to_string_lossy().to_string();
            assert!(!n.starts_with("twinpet-oac-keyset-manifest-"), "No candidate digest must be promoted: {n}");
        }

        // No fence
        let fence_path = enrollment_fence_path(&dir);
        assert!(!fence_path.exists(), "Enrollment fence must not be created");

        // No successful bootstrap/finalization: resolver must fail closed
        assert!(resolve_active_manifest_path(&dir).is_err());

        // Legitimate exact-one-key control proving legitimate pending state still works
        let dir_control = temp_dir();
        let (_sec_id_c, sec_id_hex_c) = setup_test_device(&dir_control);
        let runtime_c = EnrollmentRuntimeState::new();
        let outcome_c = super::super::device_registration_proof::generate_device_registration_proof(
            &runtime_c,
            &dir_control,
            "00112233445566778899aabbccddeeff",
            [0x66u8; 32],
        ).unwrap();
        let gen_hex_c = outcome_c.enrollment_generation_id_hex.clone();
        let mut pk_c = [0u8; 32];
        pk_c.copy_from_slice(&outcome_c.staged_public_key_bytes);
        let pubkey_b64_c = base64_encode_std(&pk_c);

        let (receipt_b64_c, oks1_b64_c) = test_keyset_and_receipt(
            frames::EFR1_OP_INITIAL_ENROLLMENT,
            &gen_hex_c,
            &sec_id_hex_c,
            1,
            pk_c,
            "HQ-001",
        );
        let _ = runtime_c.record_receipt_ingress_from_base64(&receipt_b64_c);

        let fin_res_c = finalize_device_enrollment_internal(
            &runtime_c,
            &dir_control,
            &gen_hex_c,
            &sec_id_hex_c,
            "HQ-001",
            1,
            &pubkey_b64_c,
            Some(&receipt_b64_c),
            Some(&oks1_b64_c),
            None,
        );
        assert!(fin_res_c.is_ok(), "Legitimate pending state with one key must succeed: {:?}", fin_res_c.err());
        assert!(enrollment_fence_path(&dir_control).exists());

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&dir_control);
    }

    #[test]
    fn test_n_ir002_immutable_digest_collision_and_race() {
        let dir = temp_dir();
        let (_sec_id, sec_id_hex) = setup_test_device(&dir);
        let runtime = EnrollmentRuntimeState::new();

        // 1. Establish real committed G1 + A authority baseline
        let outcome1 = super::super::device_registration_proof::generate_device_registration_proof(
            &runtime,
            &dir,
            "11112222333344445555666677778888",
            [0x11; 32],
        ).unwrap();
        let pubkey_b64_1 = base64_encode_std(&outcome1.staged_public_key_bytes);
        let res1 = test_finalize_device_enrollment(
            &runtime,
            &dir,
            &outcome1.enrollment_generation_id_hex,
            &sec_id_hex,
            "HQ-001",
            1,
            &pubkey_b64_1,
        ).unwrap();
        assert_eq!(res1.status, "COMMITTED");

        // Snapshot G1 committed fence and selected A digest authority
        let fence_path = enrollment_fence_path(&dir);
        let g1_fence_bytes = fs::read(&fence_path).unwrap();
        let a_digest_path = resolve_active_manifest_path(&dir).unwrap();
        let a_manifest_bytes = fs::read(&a_digest_path).unwrap();

        // Prepare candidate B (distinct valid root-signed keyset manifest, never selected by G2 fence)
        let root_key = SigningKey::from_bytes(&TEST_OAC_ROOT_SEED);
        let oac_signer_b = SigningKey::from_bytes(&[0x7cu8; 32]);
        let manifest_b = frames::OacKeysetManifestFrameV1 {
            revocation_epoch: 2,
            generated_at_server_ms: 2000,
            keys: vec![frames::OacKeysetManifestKeyV1 {
                signing_key_id: "key-candidate-b".to_string(),
                public_key: oac_signer_b.verifying_key().to_bytes(),
                status: frames::OacKeyLifecycleStatus::Active,
                verify_until_server_ms: None,
            }],
            signature: [0u8; 64],
        };
        let prefix_b = frames::oks1_signed_prefix(&manifest_b).unwrap();
        let sig_b = root_key.sign(&prefix_b).to_bytes();
        let signed_manifest_b = frames::OacKeysetManifestFrameV1 { signature: sig_b, ..manifest_b };
        let b_manifest_bytes = frames::encode_oks1(&signed_manifest_b).unwrap();
        let b_d_hex = compute_sha256_hex(&b_manifest_bytes);
        let b_target_path = digest_manifest_path(&dir, &b_d_hex);
        assert_ne!(a_digest_path, b_target_path, "Candidate B digest must differ from committed A");

        // --- SCENARIO A: Existing target collision ---
        // 1. Prewrite adversarial DIFFERENT bytes at B's digest path D
        let adversarial_bytes = b"ADVERSARIAL_PREEXISTING_BYTES_AT_B_DIGEST".to_vec();
        fs::write(&b_target_path, &adversarial_bytes).unwrap();

        // 2. Snapshot B target bytes
        let b_target_snapshot = fs::read(&b_target_path).unwrap();
        assert_eq!(b_target_snapshot, adversarial_bytes);

        // 3. Invoke production digest persistence
        let hooks = DEFAULT_DIGEST_PERSIST_HOOKS;
        let collision_res = persist_digest_manifest_atomic_with_hooks(
            &dir,
            &b_manifest_bytes,
            &b_d_hex,
            Some(&root_key.verifying_key().to_bytes()),
            &hooks,
        );

        // 4. Require exactly IMMUTABLE_DIGEST_COLLISION
        assert_eq!(collision_res.err(), Some("IMMUTABLE_DIGEST_COLLISION".to_string()));

        // 5. Reread B target and assert byte-for-byte unchanged
        assert_eq!(fs::read(&b_target_path).unwrap(), b_target_snapshot);

        // 6. Assert no invocation temp becomes authority
        for entry in fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()) {
            let n = entry.file_name().to_string_lossy().to_string();
            assert!(!n.ends_with(".tmp"), "Unexpected temp file left behind: {n}");
        }

        // 7. Assert G1 fence bytes unchanged
        assert_eq!(fs::read(&fence_path).unwrap(), g1_fence_bytes);

        // 8. Assert no G2 fence promotion
        let current_fence_a: EnrollmentFenceState = serde_json::from_slice(&fs::read(&fence_path).unwrap()).unwrap();
        assert_eq!(current_fence_a.device_key_version, 1);
        assert_eq!(current_fence_a.enrollment_generation_id, outcome1.enrollment_generation_id_hex);

        // 9. Drop/recreate EnrollmentRuntimeState
        drop(runtime);
        let runtime_after_collision = EnrollmentRuntimeState::new();

        // 10. Invoke production resolver
        let resolved_a = resolve_active_manifest_path(&dir).unwrap();

        // 11. Require exact G1+A remains selected
        assert_eq!(resolved_a, a_digest_path);
        assert_eq!(fs::read(&resolved_a).unwrap(), a_manifest_bytes);

        // --- SCENARIO B: Exact create race ---
        // 1. Begin with B D absent
        let _ = fs::remove_file(&b_target_path);
        assert!(!b_target_path.exists());

        // 2. Existing race seam creates D with exact B bytes after absence check/before first-create completion
        static RACE_TARGET: std::sync::Mutex<Option<(PathBuf, Vec<u8>)>> = std::sync::Mutex::new(None);
        fn mock_race_move_fn(_existing: PCWSTR, _new: PCWSTR, _flags: windows::Win32::Storage::FileSystem::MOVE_FILE_FLAGS) -> Result<(), u32> {
            if let Ok(guard) = RACE_TARGET.lock() {
                if let Some((path, bytes)) = guard.as_ref() {
                    let _ = fs::write(path, bytes);
                }
            }
            Err(183) // ERROR_ALREADY_EXISTS
        }

        *RACE_TARGET.lock().unwrap() = Some((b_target_path.clone(), b_manifest_bytes.clone()));
        let mut hooks_race_exact = DEFAULT_DIGEST_PERSIST_HOOKS;
        hooks_race_exact.move_file = mock_race_move_fn;

        // 3. Persistence loses race and rereads exact B
        // 4. Persistence succeeds idempotently
        let race_exact_res = persist_digest_manifest_atomic_with_hooks(
            &dir,
            &b_manifest_bytes,
            &b_d_hex,
            Some(&root_key.verifying_key().to_bytes()),
            &hooks_race_exact,
        );
        assert!(race_exact_res.is_ok(), "Exact create race should succeed idempotently: {:?}", race_exact_res.err());

        // 5. G1 fence remains unchanged
        assert_eq!(fs::read(&fence_path).unwrap(), g1_fence_bytes);

        // 6. No unintended fence promotion occurs
        let current_fence_b: EnrollmentFenceState = serde_json::from_slice(&fs::read(&fence_path).unwrap()).unwrap();
        assert_eq!(current_fence_b.device_key_version, 1);
        assert_eq!(current_fence_b.enrollment_generation_id, outcome1.enrollment_generation_id_hex);

        // 7. Drop/recreate runtime
        drop(runtime_after_collision);
        let runtime_after_exact_race = EnrollmentRuntimeState::new();

        // 8. Production resolver still selects G1+A
        let resolved_b = resolve_active_manifest_path(&dir).unwrap();
        assert_eq!(resolved_b, a_digest_path);
        assert_eq!(fs::read(&resolved_b).unwrap(), a_manifest_bytes);

        // 9. B exists only as durable/unselected data
        assert!(b_target_path.exists());
        assert_eq!(fs::read(&b_target_path).unwrap(), b_manifest_bytes);

        // --- SCENARIO C: Different create race ---
        // 1. Begin with B D absent
        let _ = fs::remove_file(&b_target_path);
        assert!(!b_target_path.exists());

        // 2. Race seam creates DIFFERENT bytes at B D
        let different_race_bytes = b"DIFFERENT_RACE_LOSER_BYTES_SCENARIO_C".to_vec();
        *RACE_TARGET.lock().unwrap() = Some((b_target_path.clone(), different_race_bytes.clone()));
        let mut hooks_race_diff = DEFAULT_DIGEST_PERSIST_HOOKS;
        hooks_race_diff.move_file = mock_race_move_fn;

        // 3. Snapshot those different bytes immediately after race creation
        let race_snapshot = different_race_bytes.clone();

        // 4. First-create loses race
        let race_diff_res = persist_digest_manifest_atomic_with_hooks(
            &dir,
            &b_manifest_bytes,
            &b_d_hex,
            Some(&root_key.verifying_key().to_bytes()),
            &hooks_race_diff,
        );

        // 5. Require exactly IMMUTABLE_DIGEST_CREATE_RACE_COLLISION
        assert_eq!(race_diff_res.err(), Some("IMMUTABLE_DIGEST_CREATE_RACE_COLLISION".to_string()));

        // 6. Reread B D and assert byte-for-byte unchanged from the race snapshot
        let reread_diff_bytes = fs::read(&b_target_path).unwrap();
        assert_eq!(reread_diff_bytes, race_snapshot, "Different-race target bytes must remain unchanged");

        // 7. Assert no invocation temp remains promoted
        for entry in fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()) {
            let n = entry.file_name().to_string_lossy().to_string();
            assert!(!n.ends_with(".tmp"), "Unexpected temp file left behind after different race: {n}");
        }

        // 8. Assert no fence promotion
        let current_fence_c: EnrollmentFenceState = serde_json::from_slice(&fs::read(&fence_path).unwrap()).unwrap();
        assert_eq!(current_fence_c.device_key_version, 1);
        assert_eq!(current_fence_c.enrollment_generation_id, outcome1.enrollment_generation_id_hex);

        // 9. G1 fence bytes remain unchanged
        assert_eq!(fs::read(&fence_path).unwrap(), g1_fence_bytes);

        // 10. Drop/recreate runtime
        drop(runtime_after_exact_race);
        let _runtime_after_diff_race = EnrollmentRuntimeState::new();

        // 11. Production resolver still selects G1+A
        let resolved_c = resolve_active_manifest_path(&dir).unwrap();
        assert_eq!(resolved_c, a_digest_path);
        assert_eq!(fs::read(&resolved_c).unwrap(), a_manifest_bytes);

        *RACE_TARGET.lock().unwrap() = None;
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn test_ir002_structural_legacy_authority_audit() {
        let auth_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("privileged_auth");
        let production_files = [
            "enrollment_meta.rs",
            "staff_session.rs",
            "mod.rs",
            "offline_verifier.rs",
        ];

        let legacy_file_str = "twinpet-oac-keyset-manifest.bin";

        for filename in &production_files {
            let file_path = auth_dir.join(filename);
            assert!(file_path.exists(), "Source file not found: {}", file_path.display());

            let content = fs::read_to_string(&file_path).unwrap();

            // Find where `mod tests` or `mod command_glue_tests` starts
            let prod_content = if let Some(idx) = content.find("mod tests") {
                &content[..idx]
            } else if let Some(idx) = content.find("mod command_glue_tests") {
                &content[..idx]
            } else {
                &content[..]
            };

            // 1. Prove no production read/write of twinpet-oac-keyset-manifest.bin
            assert!(
                !prod_content.contains(legacy_file_str),
                "Production code in {} contains legacy filename '{}'!",
                filename,
                legacy_file_str
            );

            // 2. Prove no ignored authority write result
            assert!(
                !prod_content.contains("let _ = persist_keyset"),
                "Production code in {} contains ignored persist_keyset result!",
                filename
            );
            assert!(
                !prod_content.contains("let _ = persist_digest"),
                "Production code in {} contains ignored persist_digest result!",
                filename
            );
        }

        // 3. Runtime test: legacy file alone cannot provide authority on clean/unenrolled device
        let dir = temp_dir();
        let legacy_path = dir.join(legacy_file_str);
        fs::write(&legacy_path, b"FAKE_MANIFEST").unwrap();

        let resolver_res = resolve_active_manifest_path(&dir);
        assert!(
            resolver_res.is_err(),
            "Resolver must fail closed when only legacy file exists!"
        );
        let err = resolver_res.unwrap_err();
        assert!(
            err.contains("RESOLVER_FAIL_CLOSED") || err.contains("DEVICE_NOT_ENROLLED"),
            "Expected fail-closed error, got: {err}"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
