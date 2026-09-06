//! SEC-001 Packet D-1A — Staff Session Assertion & OAC Re-Anchor Lifecycle.
//!
//! Owns:
//! - In-memory process-local mutex-protected single challenge slot with generation counter.
//! - One-time challenge lifecycle for SSA1_LOGIN, SSA1_REFRESH, and OAC_REANCHOR.
//! - Native SSCP1 minting with load-only enrolled device signing key.
//! - Deterministic SSCA1 cache envelope persistence using Windows ReplaceFileW/MoveFileExW.
//! - Fail-closed canonical-final-only authority contract: ONLY `twinpet-staff-session.dpapi`
//!   may ever be authoritative cache state; never promote `.tmp` or sibling artifacts.
//! - Full handling of Windows 1176 (ERROR_UNABLE_TO_MOVE_REPLACEMENT) and 1177 (ERROR_UNABLE_TO_MOVE_REPLACEMENT_2).

use ed25519_dalek::{Signature, Signer, Verifier, VerifyingKey};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Write;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use windows::core::PCWSTR;
use windows::Win32::Foundation::GetLastError;
use windows::Win32::Storage::FileSystem::{MoveFileExW, ReplaceFileW, MOVEFILE_WRITE_THROUGH};

use super::device_proof::{load_enrolled_device_keypair, DeviceProofError};
use super::dpapi_envelope::{dpapi_protect, dpapi_unprotect};
use super::enrollment_meta::verify_local_enrollment;
use super::frames::{
    decode_oks1, decode_srf1, decode_ssa1, decode_ssca1, encode_ssca1, encode_sscp1, is_canonical_identifier,
    srf1_signature_preimage, ssa1_signature_preimage, sscp1_signed_prefix,
    StaffSessionCacheEnvelopeV1, StaffSessionDeviceChallengeProofV1,
    SRF1_OBJECT_KIND_OAC, SRF1_OBJECT_KIND_SSA1, SSCP1_PURPOSE_LOGIN, SSCP1_PURPOSE_OAC_REANCHOR,
    SSCP1_PURPOSE_REFRESH,
};
use super::monotonic_clock::{boot_session_id, qpc_frequency, read_qpc_ticks, ticks_to_elapsed_ms};
use super::oac_keyset_frame::find_signing_key;
use super::security_device_id::{security_device_id_path, SECURITY_DEVICE_ID_LEN};

pub const STAFF_SESSION_CACHE_FILENAME: &str = "twinpet-staff-session.dpapi";
pub const STAFF_SESSION_CACHE_TMP_FILENAME: &str = "twinpet-staff-session.dpapi.tmp";

#[derive(Debug, Clone)]
pub struct PendingStaffSessionChallengeV1 {
    pub generation: u64,
    pub challenge_nonce: [u8; 32],
    pub purpose: String,
    pub intended_staff_id: String,
    pub branch_id: String,
    pub security_device_id: [u8; 16],
    pub device_key_version: u32,
    pub request_qpc_ticks: u64,
    pub boot_session_id: [u8; 16],
}

static PENDING_CHALLENGE: Mutex<Option<PendingStaffSessionChallengeV1>> = Mutex::new(None);
static CHALLENGE_GENERATION: AtomicU64 = AtomicU64::new(1);
static IN_PROCESS_CACHE_INVALIDATED: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StaffSessionChallengeDto {
    pub challenge_nonce_base64: String,
    pub sscp1_proof_base64: String,
    pub generation: u64,
}

pub fn staff_session_cache_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(STAFF_SESSION_CACHE_FILENAME)
}

pub fn staff_session_cache_tmp_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(STAFF_SESSION_CACHE_TMP_FILENAME)
}

fn to_wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

fn compute_sha256(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().into()
}

// --- Base64 helpers (Standard base64 matching transport) ---

const B64_STD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        out.push(B64_STD[(b0 >> 2) as usize] as char);
        out.push(B64_STD[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(B64_STD[(((b1 & 0x0F) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(B64_STD[(b2 & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    fn index_of(c: u8) -> Option<u8> {
        B64_STD.iter().position(|&x| x == c).map(|i| i as u8)
    }
    let cleaned: Vec<u8> = input.bytes().filter(|&b| b != b'=' && !b.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(cleaned.len() * 3 / 4);
    for chunk in cleaned.chunks(4) {
        let vals: Vec<u8> = chunk
            .iter()
            .map(|&b| index_of(b).ok_or_else(|| "invalid base64 character".to_string()))
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

fn load_security_device_id(root: &Path) -> Result<[u8; 16], String> {
    let path = security_device_id_path(root);
    let bytes = fs::read(&path).map_err(|e| format!("cannot read security device id: {e}"))?;
    if bytes.len() != SECURITY_DEVICE_ID_LEN {
        return Err(format!("security device id length mismatch: {} != {SECURITY_DEVICE_ID_LEN}", bytes.len()));
    }
    let mut id = [0u8; 16];
    id.copy_from_slice(&bytes);
    Ok(id)
}

/// Prepares a fresh staff session challenge, minting and signing SSCP1 with the enrolled device key.
/// Supersedes any prior pending challenge atomically.
pub fn prepare_staff_session_challenge_internal(
    root: &Path,
    purpose: &str,
    branch_id: &str,
    intended_staff_id: &str,
) -> Result<StaffSessionChallengeDto, String> {
    let purpose_byte = match purpose {
        "SSA1_LOGIN" => SSCP1_PURPOSE_LOGIN,
        "SSA1_REFRESH" => SSCP1_PURPOSE_REFRESH,
        "OAC_REANCHOR" => SSCP1_PURPOSE_OAC_REANCHOR,
        other => return Err(format!("unsupported challenge purpose: {other}")),
    };

    if !is_canonical_identifier(branch_id) {
        return Err(format!("invalid branch_id grammar: '{branch_id}'"));
    }
    if !is_canonical_identifier(intended_staff_id) {
        return Err(format!("invalid intended_staff_id grammar: '{intended_staff_id}'"));
    }

    let security_device_id = load_security_device_id(root)?;
    let signing_key = load_enrolled_device_keypair(root).map_err(|e| match e {
        DeviceProofError::NotFound => "DEVICE_KEY_UNAVAILABLE_REENROLL_REQUIRED".to_string(),
        other => format!("device proof key error: {other:?}"),
    })?;

    let enrollment = verify_local_enrollment(root, &signing_key)
        .map_err(|e| format!("LOCAL_ENROLLMENT_VERIFICATION_FAILED: {e}"))?;

    if enrollment.security_device_id != security_device_id {
        return Err("security device id mismatch between enrollment meta and stored device id".to_string());
    }
    let device_key_version = enrollment.device_key_version;

    let mut challenge_nonce = [0u8; 32];
    OsRng.fill_bytes(&mut challenge_nonce);

    let request_qpc_ticks = read_qpc_ticks().map_err(|e| format!("monotonic clock error: {e:?}"))?;
    let boot_session_id = boot_session_id();
    let generation = CHALLENGE_GENERATION.fetch_add(1, Ordering::SeqCst);

    let unsigned_sscp1 = StaffSessionDeviceChallengeProofV1 {
        purpose: purpose_byte,
        challenge_nonce,
        security_device_id,
        device_key_version,
        branch_id: branch_id.to_string(),
        challenge_generation: generation,
        intended_staff_id: intended_staff_id.to_string(),
        signature: [0u8; 64],
    };

    let prefix = sscp1_signed_prefix(&unsigned_sscp1)
        .map_err(|e| format!("cannot build SSCP1 prefix: {e:?}"))?;
    let signature = Signer::sign(&signing_key, &prefix).to_bytes();

    let signed_sscp1 = StaffSessionDeviceChallengeProofV1 {
        signature,
        ..unsigned_sscp1
    };
    let sscp1_bytes = encode_sscp1(&signed_sscp1)
        .map_err(|e| format!("cannot encode SSCP1: {e:?}"))?;

    let pending = PendingStaffSessionChallengeV1 {
        generation,
        challenge_nonce,
        purpose: purpose.to_string(),
        intended_staff_id: intended_staff_id.to_string(),
        branch_id: branch_id.to_string(),
        security_device_id,
        device_key_version,
        request_qpc_ticks,
        boot_session_id,
    };

    let mut lock = PENDING_CHALLENGE
        .lock()
        .map_err(|_| "challenge mutex poisoned".to_string())?;
    *lock = Some(pending);

    Ok(StaffSessionChallengeDto {
        challenge_nonce_base64: base64_encode(&challenge_nonce),
        sscp1_proof_base64: base64_encode(&sscp1_bytes),
        generation,
    })
}

pub type ReplaceFileFn = fn(
    lp_replaced_file_name: PCWSTR,
    lp_replacement_file_name: PCWSTR,
    lp_backup_file_name: PCWSTR,
    dw_replace_flags: windows::Win32::Storage::FileSystem::REPLACE_FILE_FLAGS,
    lp_exclude: Option<*const std::ffi::c_void>,
    lp_reserved: Option<*const std::ffi::c_void>,
) -> Result<(), u32>;

pub type MoveFileFn = fn(
    lp_existing_file_name: PCWSTR,
    lp_new_file_name: PCWSTR,
    dw_flags: windows::Win32::Storage::FileSystem::MOVE_FILE_FLAGS,
) -> Result<(), u32>;

#[derive(Clone, Copy)]
pub struct CacheCommitHooks {
    pub replace_file: ReplaceFileFn,
    pub move_file: MoveFileFn,
}

pub fn win32_replace_file(
    lp_replaced: PCWSTR,
    lp_replacement: PCWSTR,
    lp_backup: PCWSTR,
    flags: windows::Win32::Storage::FileSystem::REPLACE_FILE_FLAGS,
    exclude: Option<*const std::ffi::c_void>,
    reserved: Option<*const std::ffi::c_void>,
) -> Result<(), u32> {
    unsafe {
        ReplaceFileW(lp_replaced, lp_replacement, lp_backup, flags, exclude, reserved)
            .map_err(|_| GetLastError().0)
    }
}

pub fn win32_move_file(
    lp_existing: PCWSTR,
    lp_new: PCWSTR,
    flags: windows::Win32::Storage::FileSystem::MOVE_FILE_FLAGS,
) -> Result<(), u32> {
    unsafe {
        MoveFileExW(lp_existing, lp_new, flags)
            .map_err(|_| GetLastError().0)
    }
}

pub const DEFAULT_CACHE_COMMIT_HOOKS: CacheCommitHooks = CacheCommitHooks {
    replace_file: win32_replace_file,
    move_file: win32_move_file,
};

/// Independent validation of the canonical final cache file `twinpet-staff-session.dpapi`.
/// Returns Ok(envelope) only if the canonical file exists, is a regular file, and satisfies
/// all cryptographic, integrity, binding, and monotonic interval checks.
pub fn validate_canonical_final_cache_with_clock(
    root: &Path,
    current_boot_session: &[u8; 16],
    current_qpc_ticks: u64,
    freq: u64,
) -> Result<StaffSessionCacheEnvelopeV1, String> {
    // 1. In-process fail-closed invalidation gate
    if IN_PROCESS_CACHE_INVALIDATED.load(Ordering::SeqCst) {
        return Err("canonical staff session cache has been invalidated in-process".to_string());
    }

    // 2. Canonical file existence and regular file check
    let final_path = staff_session_cache_path(root);
    if !final_path.exists() {
        return Err("canonical staff session cache file does not exist".to_string());
    }

    let meta = fs::symlink_metadata(&final_path)
        .map_err(|e| format!("cannot inspect canonical cache metadata: {e}"))?;
    if !meta.file_type().is_file() {
        return Err("canonical staff session cache is not a regular file".to_string());
    }
    if meta.len() == 0 {
        return Err("canonical cache file is empty".to_string());
    }

    // 3. DPAPI decrypt ciphertext into plaintext SSCA1 envelope bytes
    let ciphertext = fs::read(&final_path)
        .map_err(|e| format!("cannot read canonical cache file: {e}"))?;
    let plaintext = dpapi_unprotect(&ciphertext)
        .map_err(|e| format!("DPAPI unprotect failed on canonical cache: {e:?}"))?;

    // 4. SSCA1 strict decode
    let envelope = decode_ssca1(&plaintext)
        .map_err(|e| format!("SSCA1 decode failed on canonical cache: {e:?}"))?;

    // 5. Envelope digest assertions
    if compute_sha256(&envelope.ssa1_bytes) != envelope.ssa1_digest {
        return Err("SSA1 digest mismatch in canonical cache".to_string());
    }
    if compute_sha256(&envelope.srf1_bytes) != envelope.srf1_digest {
        return Err("SRF1 digest mismatch in canonical cache".to_string());
    }

    // 6. Process continuity assertion (cross-boot replay prevention)
    if &envelope.boot_session_id != current_boot_session {
        return Err("canonical cache belongs to prior boot session; re-anchor required".to_string());
    }

    // 7. Decode embedded frames
    let ssa1 = decode_ssa1(&envelope.ssa1_bytes)
        .map_err(|e| format!("embedded SSA1 decode failed: {e:?}"))?;
    let srf1 = decode_srf1(&envelope.srf1_bytes)
        .map_err(|e| format!("embedded SRF1 decode failed: {e:?}"))?;

    // 8. Object binding assertions
    if srf1.object_kind != SRF1_OBJECT_KIND_SSA1 {
        return Err(format!("SRF1 objectKind mismatch: expected SSA1 ({SRF1_OBJECT_KIND_SSA1}), got {}", srf1.object_kind));
    }
    if srf1.object_digest != envelope.ssa1_digest {
        return Err("SRF1 objectDigest does not match ssa1_digest".to_string());
    }

    // 9. Field binding consistency assertions across envelope, SSA1, and SRF1
    if envelope.staff_id != ssa1.staff_id {
        return Err(format!("envelope staffId '{}' != ssa1 staffId '{}'", envelope.staff_id, ssa1.staff_id));
    }
    if envelope.branch_id != ssa1.branch_id || envelope.branch_id != srf1.branch_id {
        return Err("branchId mismatch across envelope, SSA1, and SRF1".to_string());
    }
    if envelope.security_device_id != ssa1.security_device_id || envelope.security_device_id != srf1.security_device_id {
        return Err("securityDeviceId mismatch across envelope, SSA1, and SRF1".to_string());
    }
    if envelope.expires_at_server_ms != ssa1.expires_at_server_ms {
        return Err("expires_at_server_ms mismatch between envelope and SSA1".to_string());
    }
    if envelope.server_sent_at_ms != srf1.server_sent_at_ms {
        return Err("server_sent_at_ms mismatch between envelope and SRF1".to_string());
    }

    // 10. Cryptographic verification against trusted OAC keyset manifest
    let manifest_path = super::enrollment_meta::resolve_active_manifest_path(root)
        .map_err(|e| format!("cannot resolve active OAC keyset manifest: {e}"))?;
    let manifest_bytes = fs::read(&manifest_path)
        .map_err(|e| format!("cannot read trusted OAC keyset manifest: {e}"))?;
    let manifest = decode_oks1(&manifest_bytes)
        .map_err(|e| format!("trusted OAC keyset manifest decode failed: {e:?}"))?;

    let ssa_pubkey_bytes = find_signing_key(&manifest, &ssa1.signing_key_id)
        .ok_or_else(|| format!("unknown SSA1 signingKeyId: '{}'", ssa1.signing_key_id))?;
    let ssa_vk = VerifyingKey::from_bytes(ssa_pubkey_bytes)
        .map_err(|e| format!("invalid SSA1 verifying key: {e}"))?;
    let ssa_preimage = ssa1_signature_preimage(&ssa1)
        .map_err(|e| format!("cannot build SSA1 preimage: {e:?}"))?;
    ssa_vk
        .verify(&ssa_preimage, &Signature::from_bytes(&ssa1.signature))
        .map_err(|_| "SSA1 server signature verification failed".to_string())?;

    let srf_pubkey_bytes = find_signing_key(&manifest, &srf1.signing_key_id)
        .ok_or_else(|| format!("unknown SRF1 signingKeyId: '{}'", srf1.signing_key_id))?;
    let srf_vk = VerifyingKey::from_bytes(srf_pubkey_bytes)
        .map_err(|e| format!("invalid SRF1 verifying key: {e}"))?;
    let srf_preimage = srf1_signature_preimage(&srf1)
        .map_err(|e| format!("cannot build SRF1 preimage: {e:?}"))?;
    srf_vk
        .verify(&srf_preimage, &Signature::from_bytes(&srf1.signature))
        .map_err(|_| "SRF1 server signature verification failed".to_string())?;

    // 11. Temporal authority: exact 24h max lifetime (DEC-D-06)
    if ssa1.expires_at_server_ms <= ssa1.issued_at_server_ms {
        return Err("SSA1 expires_at_server_ms is not strictly greater than issued_at_server_ms".to_string());
    }
    if ssa1.expires_at_server_ms - ssa1.issued_at_server_ms > 86_400_000 {
        return Err("SSA1 lifetime exceeds 24-hour maximum (DEC-D-06)".to_string());
    }

    // 12. Monotonic clock and DEC-D-07 guarded interval check
    check_dec_d07_temporal_bounds(
        envelope.server_sent_at_ms,
        envelope.expires_at_server_ms,
        envelope.request_qpc_ticks,
        envelope.receipt_qpc_ticks,
        current_qpc_ticks,
        freq,
    )?;

    Ok(envelope)
}

/// Pure DEC-D-07 temporal bound validator. Computes:
///   U = server_sent_at_ms + RTT_upper + elapsed
/// with checked addition, verifying request <= receipt <= current and positive QPC frequency.
pub fn check_dec_d07_temporal_bounds(
    server_sent_at_ms: u64,
    expires_at_server_ms: u64,
    request_qpc_ticks: u64,
    receipt_qpc_ticks: u64,
    current_qpc_ticks: u64,
    freq: u64,
) -> Result<u64, String> {
    if freq == 0 {
        return Err("invalid zero or negative QPC frequency".to_string());
    }
    if receipt_qpc_ticks < request_qpc_ticks {
        return Err("monotonic clock anomaly: receipt ticks prior to request ticks".to_string());
    }
    if current_qpc_ticks < receipt_qpc_ticks {
        return Err("monotonic clock anomaly: receipt ticks in future".to_string());
    }
    let rtt_upper_ms = ticks_to_elapsed_ms(request_qpc_ticks, receipt_qpc_ticks, freq)
        .map_err(|e| format!("rtt_upper ms conversion error: {e:?}"))?;
    let elapsed_ms = ticks_to_elapsed_ms(receipt_qpc_ticks, current_qpc_ticks, freq)
        .map_err(|e| format!("elapsed ms conversion error: {e:?}"))?;
    let estimated_server_upper_bound_ms = server_sent_at_ms
        .checked_add(rtt_upper_ms)
        .and_then(|t| t.checked_add(elapsed_ms))
        .ok_or_else(|| "overflow calculating estimated server upper bound time".to_string())?;
    if estimated_server_upper_bound_ms > expires_at_server_ms {
        return Err("canonical staff session has expired (DEC-D-07)".to_string());
    }

    Ok(estimated_server_upper_bound_ms)
}

/// Production entry point for validating and loading the canonical staff session cache.
pub fn load_and_validate_canonical_staff_session(root: &Path) -> Result<StaffSessionCacheEnvelopeV1, String> {
    let current_boot = boot_session_id();
    validate_canonical_final_cache(root, &current_boot)
}

pub fn validate_canonical_final_cache(
    root: &Path,
    current_boot_session: &[u8; 16],
) -> Result<StaffSessionCacheEnvelopeV1, String> {
    let current_qpc_ticks = read_qpc_ticks().map_err(|e| format!("monotonic clock error: {e:?}"))?;
    let freq = qpc_frequency().map_err(|e| format!("monotonic clock error: {e:?}"))?;
    validate_canonical_final_cache_with_clock(root, current_boot_session, current_qpc_ticks, freq)
}

#[cfg(test)]
pub fn reset_in_process_invalidation() {
    IN_PROCESS_CACHE_INVALIDATED.store(false, Ordering::SeqCst);
}

/// Persists the signed SSCA1 envelope to disk using the canonical-final-only recovery contract
/// through injectable Windows ReplaceFileW/MoveFileExW test seams.
pub fn commit_staff_session_cache_envelope_with_hooks(
    root: &Path,
    envelope: &StaffSessionCacheEnvelopeV1,
    hooks: &CacheCommitHooks,
) -> Result<(), String> {
    let final_path = staff_session_cache_path(root);
    let tmp_path = staff_session_cache_tmp_path(root);

    let ssca1_bytes = encode_ssca1(envelope)
        .map_err(|e| format!("SSCA1 encode error: {e:?}"))?;
    let ciphertext = dpapi_protect(&ssca1_bytes)
        .map_err(|e| format!("DPAPI protect error: {e:?}"))?;

    // Step 1: Write to temp in same directory and sync to disk
    {
        let mut f = File::create(&tmp_path)
            .map_err(|e| format!("cannot create cache tmp file: {e}"))?;
        f.write_all(&ciphertext)
            .map_err(|e| format!("cannot write cache tmp file: {e}"))?;
        f.sync_all()
            .map_err(|e| format!("sync_all failed on cache tmp: {e}"))?;
    } // Handle closed

    let wide_final = to_wide(&final_path);
    let wide_tmp = to_wide(&tmp_path);

    if final_path.exists() {
        // Branch A: Existing final file present -> ReplaceFileW
        let res = (hooks.replace_file)(
            PCWSTR(wide_final.as_ptr()),
            PCWSTR(wide_tmp.as_ptr()),
            PCWSTR::null(),
            windows::Win32::Storage::FileSystem::REPLACE_FILE_FLAGS(0),
            None,
            None,
        );

        match res {
            Ok(()) => {
                if !final_path.exists() {
                    return Err("ReplaceFileW reported success but final path does not exist".to_string());
                }
                let _ = fs::remove_file(&tmp_path);
                Ok(())
            }
            Err(err_code) => {
                // DO NOT clear challenge!
                let _ = fs::remove_file(&tmp_path);
                Err(format!("CACHE_COMMIT_FAILED: ReplaceFileW error code {err_code}"))
            }
        }
    } else {
        // Branch B: First-time creation -> MoveFileExW without MOVEFILE_REPLACE_EXISTING
        let res = (hooks.move_file)(
            PCWSTR(wide_tmp.as_ptr()),
            PCWSTR(wide_final.as_ptr()),
            MOVEFILE_WRITE_THROUGH,
        );

        match res {
            Ok(()) => {
                if !final_path.exists() {
                    return Err("MoveFileExW reported success but final path does not exist".to_string());
                }
                Ok(())
            }
            Err(err_code) => {
                // DO NOT clear challenge!
                let _ = fs::remove_file(&tmp_path);
                Err(format!("CACHE_COMMIT_FAILED: MoveFileExW error code {err_code}"))
            }
        }
    }
}

#[allow(dead_code)]
pub fn commit_staff_session_cache_envelope(
    root: &Path,
    envelope: &StaffSessionCacheEnvelopeV1,
) -> Result<(), String> {
    commit_staff_session_cache_envelope_with_hooks(root, envelope, &DEFAULT_CACHE_COMMIT_HOOKS)
}

/// Persists an issued or refreshed staff session assertion with injectable commit hooks.
pub fn persist_staff_session_assertion_internal_with_hooks(
    root: &Path,
    generation: u64,
    ssa1_base64: &str,
    srf1_base64: &str,
    oks1_base64: &str,
    hooks: &CacheCommitHooks,
) -> Result<(), String> {
    let ssa1_bytes = base64_decode(ssa1_base64)
        .map_err(|e| format!("cannot decode ssa1_base64: {e}"))?;
    let srf1_bytes = base64_decode(srf1_base64)
        .map_err(|e| format!("cannot decode srf1_base64: {e}"))?;
    let oks1_bytes = base64_decode(oks1_base64)
        .map_err(|e| format!("cannot decode oks1_base64: {e}"))?;

    let active_manifest_path = super::enrollment_meta::resolve_active_manifest_path(root)
        .map_err(|e| format!("cannot resolve active OAC keyset manifest: {e}"))?;
    let active_manifest_bytes = fs::read(&active_manifest_path)
        .map_err(|e| format!("cannot read active OAC keyset manifest: {e}"))?;
    if active_manifest_bytes != oks1_bytes {
        return Err("STAFF_SESSION_MANIFEST_MISMATCH: supplied OKS1 keyset bytes do not match active digest manifest; re-anchor required".to_string());
    }
    let manifest = decode_oks1(&active_manifest_bytes)
        .map_err(|e| format!("OKS1 keyset manifest decode failed: {e:?}"))?;

    let ssa1 = decode_ssa1(&ssa1_bytes)
        .map_err(|e| format!("SSA1 decode failed: {e:?}"))?;
    let srf1 = decode_srf1(&srf1_bytes)
        .map_err(|e| format!("SRF1 decode failed: {e:?}"))?;

    // Verify SSA1 server signature using domain-separated preimage
    let ssa_pubkey_bytes = find_signing_key(&manifest, &ssa1.signing_key_id)
        .ok_or_else(|| format!("unknown SSA1 signingKeyId: '{}'", ssa1.signing_key_id))?;
    let ssa_vk = VerifyingKey::from_bytes(ssa_pubkey_bytes)
        .map_err(|e| format!("invalid SSA1 verifying key: {e}"))?;
    let ssa_preimage = ssa1_signature_preimage(&ssa1)
        .map_err(|e| format!("cannot build SSA1 preimage: {e:?}"))?;
    ssa_vk
        .verify(&ssa_preimage, &Signature::from_bytes(&ssa1.signature))
        .map_err(|_| "SSA1 server signature verification failed".to_string())?;

    // Verify SRF1 server signature using domain-separated preimage
    let srf_pubkey_bytes = find_signing_key(&manifest, &srf1.signing_key_id)
        .ok_or_else(|| format!("unknown SRF1 signingKeyId: '{}'", srf1.signing_key_id))?;
    let srf_vk = VerifyingKey::from_bytes(srf_pubkey_bytes)
        .map_err(|e| format!("invalid SRF1 verifying key: {e}"))?;
    let srf_preimage = srf1_signature_preimage(&srf1)
        .map_err(|e| format!("cannot build SRF1 preimage: {e:?}"))?;
    srf_vk
        .verify(&srf_preimage, &Signature::from_bytes(&srf1.signature))
        .map_err(|_| "SRF1 server signature verification failed".to_string())?;

    // Verify SRF1 object binding
    if srf1.object_kind != SRF1_OBJECT_KIND_SSA1 {
        return Err(format!("SRF1 objectKind mismatch: expected SSA1 ({SRF1_OBJECT_KIND_SSA1}), got {}", srf1.object_kind));
    }
    let ssa1_digest = compute_sha256(&ssa1_bytes);
    if srf1.object_digest != ssa1_digest {
        return Err("SRF1 objectDigest does not match sha256(raw_ssa1_bytes)".to_string());
    }

    let receipt_qpc_ticks = read_qpc_ticks().map_err(|e| format!("monotonic clock error: {e:?}"))?;

    let mut lock = PENDING_CHALLENGE
        .lock()
        .map_err(|_| "challenge mutex poisoned".to_string())?;

    let pending = lock
        .as_ref()
        .ok_or_else(|| "CHALLENGE_NOT_FOUND_OR_ALREADY_CONSUMED".to_string())?;

    if pending.generation != generation {
        return Err(format!("challenge generation mismatch: pending {} != request {}", pending.generation, generation));
    }
    if pending.challenge_nonce != srf1.challenge_nonce {
        return Err("challenge nonce mismatch between pending challenge and SRF1".to_string());
    }
    if pending.purpose != "SSA1_LOGIN" && pending.purpose != "SSA1_REFRESH" {
        return Err(format!("invalid challenge purpose for staff session: {}", pending.purpose));
    }
    if pending.intended_staff_id != ssa1.staff_id {
        return Err(format!("staffId mismatch: intended '{}' != ssa1 '{}'", pending.intended_staff_id, ssa1.staff_id));
    }
    if pending.branch_id != ssa1.branch_id || pending.branch_id != srf1.branch_id {
        return Err("branchId mismatch across challenge, SSA1, and SRF1".to_string());
    }
    if pending.security_device_id != ssa1.security_device_id || pending.security_device_id != srf1.security_device_id {
        return Err("securityDeviceId mismatch across challenge, SSA1, and SRF1".to_string());
    }
    if receipt_qpc_ticks < pending.request_qpc_ticks {
        return Err("non-monotonic QPC ticks observed between request and receipt".to_string());
    }

    // DEC-D-06: 24h maximum lifetime constraint
    if ssa1.expires_at_server_ms <= ssa1.issued_at_server_ms {
        return Err("SSA1 expires_at_server_ms is not strictly greater than issued_at_server_ms".to_string());
    }
    if ssa1.expires_at_server_ms - ssa1.issued_at_server_ms > 86_400_000 {
        return Err("SSA1 lifetime exceeds 24-hour maximum (DEC-D-06)".to_string());
    }
    if srf1.server_sent_at_ms > ssa1.expires_at_server_ms {
        return Err("SRF1 server_sent_at_ms exceeds SSA1 expires_at_server_ms".to_string());
    }

    let srf1_digest = compute_sha256(&srf1_bytes);

    let envelope = StaffSessionCacheEnvelopeV1 {
        boot_session_id: pending.boot_session_id,
        request_qpc_ticks: pending.request_qpc_ticks,
        receipt_qpc_ticks,
        server_sent_at_ms: srf1.server_sent_at_ms,
        expires_at_server_ms: ssa1.expires_at_server_ms,
        device_key_version: pending.device_key_version,
        security_device_id: ssa1.security_device_id,
        staff_id: ssa1.staff_id.clone(),
        branch_id: ssa1.branch_id.clone(),
        ssa1_bytes,
        srf1_bytes,
        ssa1_digest,
        srf1_digest,
    };

    // Commit using canonical-final-only contract
    commit_staff_session_cache_envelope_with_hooks(root, &envelope, hooks)?;

    // Reset in-process invalidation flag on successful commit
    IN_PROCESS_CACHE_INVALIDATED.store(false, Ordering::SeqCst);

    // Atomically clear challenge slot ONLY upon successful commit
    *lock = None;

    Ok(())
}

/// Persists an issued or refreshed staff session assertion.
pub fn persist_staff_session_assertion_internal(
    root: &Path,
    generation: u64,
    ssa1_base64: &str,
    srf1_base64: &str,
    oks1_base64: &str,
) -> Result<(), String> {
    persist_staff_session_assertion_internal_with_hooks(
        root,
        generation,
        ssa1_base64,
        srf1_base64,
        oks1_base64,
        &DEFAULT_CACHE_COMMIT_HOOKS,
    )
}

pub type RemoveFileFn = fn(&Path) -> std::io::Result<()>;

/// Clears staff session cache from disk and in-memory slot with injectable deletion seam.
/// Fails closed if deletion fails and marks process-local cache as invalidated.
pub fn clear_staff_session_internal_with_hooks(
    root: &Path,
    remove_file_fn: RemoveFileFn,
) -> Result<(), String> {
    // 1. Mark in-process cache as invalidated immediately
    IN_PROCESS_CACHE_INVALIDATED.store(true, Ordering::SeqCst);

    // 2. Clear challenge slot
    if let Ok(mut lock) = PENDING_CHALLENGE.lock() {
        *lock = None;
    }

    // 3. Clean up tmp file best-effort
    let tmp_path = staff_session_cache_tmp_path(root);
    if tmp_path.exists() {
        let _ = remove_file_fn(&tmp_path);
    }

    // 4. Delete canonical final file; fail explicitly if deletion fails
    let final_path = staff_session_cache_path(root);
    if final_path.exists() {
        remove_file_fn(&final_path)
            .map_err(|e| format!("CANONICAL_CACHE_DELETION_FAILED: {e}"))?;
        if final_path.exists() {
            return Err("CANONICAL_CACHE_DELETION_FAILED: final path still exists after deletion".to_string());
        }
    }

    Ok(())
}

fn default_remove_file(path: &Path) -> std::io::Result<()> {
    fs::remove_file(path)
}

/// Clears staff session cache from disk and in-memory slot.
/// Fails closed if deletion fails and marks process-local cache as invalidated.
pub fn clear_staff_session_internal(root: &Path) -> Result<(), String> {
    clear_staff_session_internal_with_hooks(root, default_remove_file)
}

/// Persists an OAC re-anchoring receipt with injectable commit hooks.
pub fn persist_oac_reanchor_internal_with_hooks(
    root: &Path,
    generation: u64,
    oac_id: &str,
    srf1_base64: &str,
    oks1_base64: &str,
    _hooks: &CacheCommitHooks,
) -> Result<(), String> {
    let srf1_bytes = base64_decode(srf1_base64)
        .map_err(|e| format!("cannot decode srf1_base64: {e}"))?;
    let oks1_bytes = base64_decode(oks1_base64)
        .map_err(|e| format!("cannot decode oks1_base64: {e}"))?;

    let active_manifest_path = super::enrollment_meta::resolve_active_manifest_path(root)
        .map_err(|e| format!("cannot resolve active OAC keyset manifest: {e}"))?;
    let active_manifest_bytes = fs::read(&active_manifest_path)
        .map_err(|e| format!("cannot read active OAC keyset manifest: {e}"))?;
    if active_manifest_bytes != oks1_bytes {
        return Err("OAC_REANCHOR_MANIFEST_MISMATCH: supplied OKS1 keyset bytes do not match active digest manifest; re-anchor required".to_string());
    }
    let manifest = decode_oks1(&active_manifest_bytes)
        .map_err(|e| format!("OKS1 keyset manifest decode failed: {e:?}"))?;

    let srf1 = decode_srf1(&srf1_bytes)
        .map_err(|e| format!("SRF1 decode failed: {e:?}"))?;

    // Verify SRF1 signature using domain-separated preimage
    let srf_pubkey_bytes = find_signing_key(&manifest, &srf1.signing_key_id)
        .ok_or_else(|| format!("unknown SRF1 signingKeyId: '{}'", srf1.signing_key_id))?;
    let srf_vk = VerifyingKey::from_bytes(srf_pubkey_bytes)
        .map_err(|e| format!("invalid SRF1 verifying key: {e}"))?;
    let srf_preimage = srf1_signature_preimage(&srf1)
        .map_err(|e| format!("cannot build SRF1 preimage: {e:?}"))?;
    srf_vk
        .verify(&srf_preimage, &Signature::from_bytes(&srf1.signature))
        .map_err(|_| "SRF1 server signature verification failed".to_string())?;

    if srf1.object_kind != SRF1_OBJECT_KIND_OAC {
        return Err(format!("SRF1 objectKind mismatch: expected OAC ({SRF1_OBJECT_KIND_OAC}), got {}", srf1.object_kind));
    }

    // Read stored OAC
    let oac_store_dir = root.join("oac-store");
    let oac_file_path = oac_store_dir.join(format!("{oac_id}.json"));
    let raw_oac_bytes = fs::read(&oac_file_path)
        .map_err(|e| format!("cannot read stored OAC {oac_id}: {e}"))?;
    let oac_digest = compute_sha256(&raw_oac_bytes);
    if srf1.object_digest != oac_digest {
        return Err("SRF1 objectDigest does not match sha256(raw_oac_bytes)".to_string());
    }

    let receipt_qpc_ticks = read_qpc_ticks().map_err(|e| format!("monotonic clock error: {e:?}"))?;

    let mut lock = PENDING_CHALLENGE
        .lock()
        .map_err(|_| "challenge mutex poisoned".to_string())?;

    let pending = lock
        .as_ref()
        .ok_or_else(|| "CHALLENGE_NOT_FOUND_OR_ALREADY_CONSUMED".to_string())?;

    if pending.purpose != "OAC_REANCHOR" {
        return Err(format!("challenge purpose mismatch: expected OAC_REANCHOR, got {}", pending.purpose));
    }
    if pending.generation != generation {
        return Err(format!("challenge generation mismatch: pending {} != request {}", pending.generation, generation));
    }
    if pending.challenge_nonce != srf1.challenge_nonce {
        return Err("challenge nonce mismatch between pending challenge and SRF1".to_string());
    }
    if pending.branch_id != srf1.branch_id {
        return Err("branchId mismatch between challenge and SRF1".to_string());
    }
    if pending.security_device_id != srf1.security_device_id {
        return Err("securityDeviceId mismatch between challenge and SRF1".to_string());
    }
    if receipt_qpc_ticks < pending.request_qpc_ticks {
        return Err("non-monotonic QPC ticks observed between request and receipt".to_string());
    }

    // Write re-anchored receipt alongside OAC atomically
    if !oac_store_dir.exists() {
        let _ = fs::create_dir_all(&oac_store_dir);
    }
    let receipt_path = oac_store_dir.join(format!("{oac_id}.receipt.bin"));
    let tmp_receipt_path = oac_store_dir.join(format!("{oac_id}.receipt.bin.tmp"));
    {
        let mut f = File::create(&tmp_receipt_path)
            .map_err(|e| format!("cannot create receipt tmp file: {e}"))?;
        f.write_all(&srf1_bytes)
            .map_err(|e| format!("cannot write receipt tmp file: {e}"))?;
        f.sync_all()
            .map_err(|e| format!("sync_all failed on receipt tmp: {e}"))?;
    }
    fs::rename(&tmp_receipt_path, &receipt_path)
        .map_err(|e| format!("cannot rename receipt to final: {e}"))?;

    // Clear challenge slot ONLY upon complete success
    *lock = None;

    Ok(())
}

/// Persists an OAC re-anchoring receipt.
pub fn persist_oac_reanchor_internal(
    root: &Path,
    generation: u64,
    oac_id: &str,
    srf1_base64: &str,
    oks1_base64: &str,
) -> Result<(), String> {
    persist_oac_reanchor_internal_with_hooks(
        root,
        generation,
        oac_id,
        srf1_base64,
        oks1_base64,
        &DEFAULT_CACHE_COMMIT_HOOKS,
    )
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::privileged_auth::enrollment_meta::{commit_enrollment_metadata, EnrollmentMetaFrameV1};
    use crate::privileged_auth::frames::{
        encode_oks1, encode_srf1, encode_ssa1, srf1_signature_preimage, ssa1_signature_preimage,
        OacKeysetManifestFrameV1, OacKeysetManifestKeyV1, ServerReceiptFrameV1,
        StaffSessionAssertionFrameV1,
    };
    use ed25519_dalek::SigningKey;

    fn temp_dir() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "twinpet-staff-session-test-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
            n
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn setup_device_identity(root: &Path, branch_id: &str) -> (SigningKey, [u8; 16]) {
        let dev_key = SigningKey::generate(&mut OsRng);
        let key_path = super::super::device_proof::device_proof_key_path(root);
        let key_cipher = dpapi_protect(&dev_key.to_bytes()).unwrap();
        fs::write(&key_path, &key_cipher).unwrap();

        let sec_id = [0x42u8; 16];
        let sec_id_path = security_device_id_path(root);
        fs::write(&sec_id_path, &sec_id).unwrap();

        let frame = EnrollmentMetaFrameV1 {
            enrollment_generation_id: [0xAAu8; 16],
            security_device_id: sec_id,
            device_key_version: 1,
            expected_public_key: dev_key.verifying_key().to_bytes(),
            branch_id: branch_id.to_string(),
        };
        commit_enrollment_metadata(root, &frame, 1000).unwrap();

        (dev_key, sec_id)
    }

    fn make_test_manifest(root: &Path, server_signer: &SigningKey, key_id: &str) -> (Vec<u8>, String) {
        use ed25519_dalek::Signer;
        let root_signer = SigningKey::from_bytes(&super::super::enrollment_meta::TEST_OAC_ROOT_SEED);
        let public_key = server_signer.verifying_key().to_bytes();
        let unsigned = OacKeysetManifestFrameV1 {
            revocation_epoch: 0,
            generated_at_server_ms: 1000,
            keys: vec![OacKeysetManifestKeyV1 {
                signing_key_id: key_id.to_string(),
                public_key,
                status: super::super::frames::OacKeyLifecycleStatus::Active,
                verify_until_server_ms: None,
            }],
            signature: [0u8; 64],
        };
        let prefix = super::super::frames::oks1_signed_prefix(&unsigned).unwrap();
        let sig = root_signer.sign(&prefix).to_bytes();
        let signed = OacKeysetManifestFrameV1 {
            signature: sig,
            ..unsigned
        };
        let bytes = encode_oks1(&signed).unwrap();
        let b64 = base64_encode(&bytes);

        let sha256_hex = super::super::enrollment_meta::compute_sha256_hex(&bytes);
        let digest_path = super::super::enrollment_meta::digest_manifest_path(root, &sha256_hex);
        fs::write(&digest_path, &bytes).unwrap();

        let fence_path = super::super::enrollment_meta::enrollment_fence_path(root);
        if fence_path.exists() {
            let fence_bytes = fs::read(&fence_path).unwrap();
            let mut fence: super::super::enrollment_meta::EnrollmentFenceState =
                serde_json::from_slice(&fence_bytes).unwrap();
            fence.manifest_sha256 = Some(sha256_hex);
            let updated = serde_json::to_vec_pretty(&fence).unwrap();
            fs::write(&fence_path, &updated).unwrap();
        }

        (bytes, b64)
    }

    fn build_signed_ssa1(
        server_signer: &SigningKey,
        key_id: &str,
        ssa1_id: &str,
        staff_id: &str,
        security_device_id: [u8; 16],
        branch_id: &str,
        auth_version_at_issue: u32,
        issued_at_server_ms: u64,
        expires_at_server_ms: u64,
        use_domain_separator: bool,
    ) -> (Vec<u8>, [u8; 32]) {
        let unsigned = StaffSessionAssertionFrameV1 {
            ssa1_id: ssa1_id.to_string(),
            staff_id: staff_id.to_string(),
            security_device_id,
            branch_id: branch_id.to_string(),
            auth_version_at_issue,
            issued_at_server_ms,
            expires_at_server_ms,
            signing_key_id: key_id.to_string(),
            signature: [0u8; 64],
        };
        let preimage = if use_domain_separator {
            ssa1_signature_preimage(&unsigned).unwrap()
        } else {
            super::super::frames::ssa1_signed_prefix(&unsigned).unwrap()
        };
        let sig = server_signer.sign(&preimage).to_bytes();
        let signed = StaffSessionAssertionFrameV1 {
            signature: sig,
            ..unsigned
        };
        let bytes = encode_ssa1(&signed).unwrap();
        let digest = compute_sha256(&bytes);
        (bytes, digest)
    }

    fn build_signed_srf1(
        server_signer: &SigningKey,
        key_id: &str,
        nonce: [u8; 32],
        security_device_id: [u8; 16],
        branch_id: &str,
        object_kind: u8,
        object_digest: [u8; 32],
        server_sent_at_ms: u64,
        use_domain_separator: bool,
    ) -> Vec<u8> {
        let unsigned = ServerReceiptFrameV1 {
            challenge_nonce: nonce,
            security_device_id,
            branch_id: branch_id.to_string(),
            object_kind,
            object_digest,
            server_sent_at_ms,
            signing_key_id: key_id.to_string(),
            signature: [0u8; 64],
        };
        let preimage = if use_domain_separator {
            srf1_signature_preimage(&unsigned).unwrap()
        } else {
            super::super::frames::srf1_signed_prefix(&unsigned).unwrap()
        };
        let sig = server_signer.sign(&preimage).to_bytes();
        let signed = ServerReceiptFrameV1 {
            signature: sig,
            ..unsigned
        };
        encode_srf1(&signed).unwrap()
    }

    static TEST_SERIAL_MUTEX: Mutex<()> = Mutex::new(());

    #[test]
    fn prepare_challenge_increments_generation_and_signs_sscp1() {
        let _serial = TEST_SERIAL_MUTEX.lock().unwrap();
        reset_in_process_invalidation();
        let root = temp_dir();
        let (dev_key, sec_id) = setup_device_identity(&root, "BRANCH-1");

        let c1 = prepare_staff_session_challenge_internal(&root, "SSA1_LOGIN", "BRANCH-1", "STAFF-A").unwrap();
        assert!(c1.generation >= 1);

        let c2 = prepare_staff_session_challenge_internal(&root, "SSA1_REFRESH", "BRANCH-1", "STAFF-A").unwrap();
        assert_eq!(c2.generation, c1.generation + 1);

        // Verify SSCP1 signature in c2
        let sscp1_bytes = base64_decode(&c2.sscp1_proof_base64).unwrap();
        let sscp1 = super::super::frames::decode_sscp1(&sscp1_bytes).unwrap();
        assert_eq!(sscp1.purpose, SSCP1_PURPOSE_REFRESH);
        assert_eq!(sscp1.security_device_id, sec_id);
        assert_eq!(sscp1.branch_id, "BRANCH-1");
        assert_eq!(sscp1.intended_staff_id, "STAFF-A");

        let prefix = sscp1_signed_prefix(&sscp1).unwrap();
        assert!(dev_key.verifying_key().verify(&prefix, &Signature::from_bytes(&sscp1.signature)).is_ok());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn persist_staff_session_happy_path() {
        let _serial = TEST_SERIAL_MUTEX.lock().unwrap();
        reset_in_process_invalidation();
        let root = temp_dir();
        let (_dev_key, sec_id) = setup_device_identity(&root, "B01");
        let server_signer = SigningKey::generate(&mut OsRng);
        let (_oks1_bytes, oks1_b64) = make_test_manifest(&root, &server_signer, "server-k1");

        let challenge = prepare_staff_session_challenge_internal(&root, "SSA1_LOGIN", "B01", "S01").unwrap();
        let nonce_bytes = base64_decode(&challenge.challenge_nonce_base64).unwrap();
        let mut nonce = [0u8; 32];
        nonce.copy_from_slice(&nonce_bytes);

        // Mint SSA1 and SRF1 using domain-separated preimages
        let (ssa1_bytes, ssa1_digest) = build_signed_ssa1(
            &server_signer,
            "server-k1",
            "SSA-01",
            "S01",
            sec_id,
            "B01",
            1,
            10_000,
            10_000 + 86_400_000,
            true,
        );
        let srf1_bytes = build_signed_srf1(
            &server_signer,
            "server-k1",
            nonce,
            sec_id,
            "B01",
            SRF1_OBJECT_KIND_SSA1,
            ssa1_digest,
            10_005,
            true,
        );

        // Persist
        let res = persist_staff_session_assertion_internal(
            &root,
            challenge.generation,
            &base64_encode(&ssa1_bytes),
            &base64_encode(&srf1_bytes),
            &oks1_b64,
        );
        assert!(res.is_ok(), "Persistence should succeed: {:?}", res.err());

        // Canonical cache file must exist
        let cache_file = staff_session_cache_path(&root);
        assert!(cache_file.exists());

        // Validate canonical final using production entry point
        let validated = load_and_validate_canonical_staff_session(&root).unwrap();
        assert_eq!(validated.staff_id, "S01");
        assert_eq!(validated.branch_id, "B01");
        assert_eq!(validated.security_device_id, sec_id);

        // Challenge slot must be consumed (empty)
        let retry = persist_staff_session_assertion_internal(
            &root,
            challenge.generation,
            &base64_encode(&ssa1_bytes),
            &base64_encode(&srf1_bytes),
            &oks1_b64,
        );
        assert!(retry.is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_cross_language_domain_separation_exact_verification() {
        let _serial = TEST_SERIAL_MUTEX.lock().unwrap();
        reset_in_process_invalidation();
        let root = temp_dir();
        let (_dev_key, sec_id) = setup_device_identity(&root, "B01");
        let server_signer = SigningKey::generate(&mut OsRng);
        let (_oks1_bytes, oks1_b64) = make_test_manifest(&root, &server_signer, "server-k1");

        // 1. Positive: both SSA1 and SRF1 signed with domain separators
        let c1 = prepare_staff_session_challenge_internal(&root, "SSA1_LOGIN", "B01", "S01").unwrap();
        let nonce1: [u8; 32] = base64_decode(&c1.challenge_nonce_base64).unwrap().try_into().unwrap();
        let (ssa1_bytes, ssa1_digest) = build_signed_ssa1(&server_signer, "server-k1", "SSA-01", "S01", sec_id, "B01", 1, 10_000, 10_000 + 86_400_000, true);
        let srf1_bytes = build_signed_srf1(&server_signer, "server-k1", nonce1, sec_id, "B01", SRF1_OBJECT_KIND_SSA1, ssa1_digest, 10_005, true);

        let res = persist_staff_session_assertion_internal(
            &root,
            c1.generation,
            &base64_encode(&ssa1_bytes),
            &base64_encode(&srf1_bytes),
            &oks1_b64,
        );
        assert!(res.is_ok(), "Domain-separated SSA1 and SRF1 must succeed: {:?}", res.as_ref().err());
        assert!(load_and_validate_canonical_staff_session(&root).is_ok());

        // 2. Negative: SSA1 signed WITHOUT domain separator must reject
        let c2 = prepare_staff_session_challenge_internal(&root, "SSA1_LOGIN", "B01", "S01").unwrap();
        let nonce2: [u8; 32] = base64_decode(&c2.challenge_nonce_base64).unwrap().try_into().unwrap();
        let (undomain_ssa1, undomain_ssa1_digest) = build_signed_ssa1(&server_signer, "server-k1", "SSA-02", "S01", sec_id, "B01", 1, 20_000, 20_000 + 86_400_000, false);
        let srf1_valid = build_signed_srf1(&server_signer, "server-k1", nonce2, sec_id, "B01", SRF1_OBJECT_KIND_SSA1, undomain_ssa1_digest, 20_005, true);

        let res2 = persist_staff_session_assertion_internal(
            &root,
            c2.generation,
            &base64_encode(&undomain_ssa1),
            &base64_encode(&srf1_valid),
            &oks1_b64,
        );
        assert!(res2.is_err(), "SSA1 without domain separator must fail verification");
        assert!(res2.unwrap_err().contains("SSA1 server signature verification failed"));

        // 3. Negative: SRF1 signed WITHOUT domain separator must reject
        let c3 = prepare_staff_session_challenge_internal(&root, "SSA1_LOGIN", "B01", "S01").unwrap();
        let nonce3: [u8; 32] = base64_decode(&c3.challenge_nonce_base64).unwrap().try_into().unwrap();
        let (ssa1_valid3, ssa1_digest3) = build_signed_ssa1(&server_signer, "server-k1", "SSA-03", "S01", sec_id, "B01", 1, 30_000, 30_000 + 86_400_000, true);
        let undomain_srf1 = build_signed_srf1(&server_signer, "server-k1", nonce3, sec_id, "B01", SRF1_OBJECT_KIND_SSA1, ssa1_digest3, 30_005, false);

        let res3 = persist_staff_session_assertion_internal(
            &root,
            c3.generation,
            &base64_encode(&ssa1_valid3),
            &base64_encode(&undomain_srf1),
            &oks1_b64,
        );
        assert!(res3.is_err(), "SRF1 without domain separator must fail verification");
        assert!(res3.unwrap_err().contains("SRF1 server signature verification failed"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_oac_reanchor_domain_separated_srf1() {
        let _serial = TEST_SERIAL_MUTEX.lock().unwrap();
        reset_in_process_invalidation();
        let root = temp_dir();
        let (_dev_key, sec_id) = setup_device_identity(&root, "B01");
        let server_signer = SigningKey::generate(&mut OsRng);
        let (_oks1_bytes, oks1_b64) = make_test_manifest(&root, &server_signer, "server-k1");

        let oac_store_dir = root.join("oac-store");
        fs::create_dir_all(&oac_store_dir).unwrap();
        let dummy_oac_bytes = b"{\"oacId\":\"OAC-99\",\"version\":1}";
        fs::write(oac_store_dir.join("OAC-99.json"), dummy_oac_bytes).unwrap();
        let oac_digest = compute_sha256(dummy_oac_bytes);

        // Positive: domain-separated SRF1
        let c1 = prepare_staff_session_challenge_internal(&root, "OAC_REANCHOR", "B01", "MGR-1").unwrap();
        let nonce1: [u8; 32] = base64_decode(&c1.challenge_nonce_base64).unwrap().try_into().unwrap();
        let srf1_bytes = build_signed_srf1(&server_signer, "server-k1", nonce1, sec_id, "B01", SRF1_OBJECT_KIND_OAC, oac_digest, 10_000, true);

        let res = persist_oac_reanchor_internal(&root, c1.generation, "OAC-99", &base64_encode(&srf1_bytes), &oks1_b64);
        assert!(res.is_ok(), "OAC re-anchor must succeed with domain-separated SRF1");
        assert!(oac_store_dir.join("OAC-99.receipt.bin").exists());

        // Negative: undomain-separated SRF1 rejects
        let c2 = prepare_staff_session_challenge_internal(&root, "OAC_REANCHOR", "B01", "MGR-1").unwrap();
        let nonce2: [u8; 32] = base64_decode(&c2.challenge_nonce_base64).unwrap().try_into().unwrap();
        let undomain_srf1 = build_signed_srf1(&server_signer, "server-k1", nonce2, sec_id, "B01", SRF1_OBJECT_KIND_OAC, oac_digest, 20_000, false);

        let res2 = persist_oac_reanchor_internal(&root, c2.generation, "OAC-99", &base64_encode(&undomain_srf1), &oks1_b64);
        assert!(res2.is_err(), "OAC re-anchor must fail with undomain-separated SRF1");
        assert!(res2.unwrap_err().contains("SRF1 server signature verification failed"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_in_process_invalidation_and_fail_closed_clear() {
        let _serial = TEST_SERIAL_MUTEX.lock().unwrap();
        reset_in_process_invalidation();
        let root = temp_dir();
        let (_dev_key, sec_id) = setup_device_identity(&root, "B01");
        let server_signer = SigningKey::generate(&mut OsRng);
        let (_oks1_bytes, oks1_b64) = make_test_manifest(&root, &server_signer, "server-k1");

        let c1 = prepare_staff_session_challenge_internal(&root, "SSA1_LOGIN", "B01", "S01").unwrap();
        let nonce: [u8; 32] = base64_decode(&c1.challenge_nonce_base64).unwrap().try_into().unwrap();
        let (ssa1_bytes, ssa1_digest) = build_signed_ssa1(&server_signer, "server-k1", "SSA-01", "S01", sec_id, "B01", 1, 10_000, 10_000 + 86_400_000, true);
        let srf1_bytes = build_signed_srf1(&server_signer, "server-k1", nonce, sec_id, "B01", SRF1_OBJECT_KIND_SSA1, ssa1_digest, 10_005, true);

        persist_staff_session_assertion_internal(
            &root,
            c1.generation,
            &base64_encode(&ssa1_bytes),
            &base64_encode(&srf1_bytes),
            &oks1_b64,
        ).unwrap();

        assert!(load_and_validate_canonical_staff_session(&root).is_ok());

        // Clear session
        clear_staff_session_internal(&root).unwrap();
        let cache_file = staff_session_cache_path(&root);
        assert!(!cache_file.exists());

        // Simulate surviving cache file on disk
        fs::write(&cache_file, b"surviving-cache-data").unwrap();
        assert!(cache_file.exists());

        // In-process invalidation MUST reject despite file presence on disk
        let res = load_and_validate_canonical_staff_session(&root);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("invalidated in-process"));

        // Fresh login restores valid authority and resets invalidation flag
        let c2 = prepare_staff_session_challenge_internal(&root, "SSA1_LOGIN", "B01", "S01").unwrap();
        let nonce2: [u8; 32] = base64_decode(&c2.challenge_nonce_base64).unwrap().try_into().unwrap();
        let (ssa1_bytes2, ssa1_digest2) = build_signed_ssa1(&server_signer, "server-k1", "SSA-02", "S01", sec_id, "B01", 1, 20_000, 20_000 + 86_400_000, true);
        let srf1_bytes2 = build_signed_srf1(&server_signer, "server-k1", nonce2, sec_id, "B01", SRF1_OBJECT_KIND_SSA1, ssa1_digest2, 20_005, true);

        persist_staff_session_assertion_internal(
            &root,
            c2.generation,
            &base64_encode(&ssa1_bytes2),
            &base64_encode(&srf1_bytes2),
            &oks1_b64,
        ).unwrap();

        assert!(load_and_validate_canonical_staff_session(&root).is_ok());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_validate_canonical_final_cache_negative_matrix() {
        let _serial = TEST_SERIAL_MUTEX.lock().unwrap();
        reset_in_process_invalidation();
        let root = temp_dir();
        let (_dev_key, sec_id) = setup_device_identity(&root, "B01");
        let server_signer = SigningKey::generate(&mut OsRng);
        let (_oks1_bytes, oks1_b64) = make_test_manifest(&root, &server_signer, "server-k1");

        let c1 = prepare_staff_session_challenge_internal(&root, "SSA1_LOGIN", "B01", "S01").unwrap();
        let nonce: [u8; 32] = base64_decode(&c1.challenge_nonce_base64).unwrap().try_into().unwrap();
        let (ssa1_bytes, ssa1_digest) = build_signed_ssa1(&server_signer, "server-k1", "SSA-01", "S01", sec_id, "B01", 1, 10_000, 10_000 + 86_400_000, true);
        let srf1_bytes = build_signed_srf1(&server_signer, "server-k1", nonce, sec_id, "B01", SRF1_OBJECT_KIND_SSA1, ssa1_digest, 10_005, true);

        persist_staff_session_assertion_internal(
            &root,
            c1.generation,
            &base64_encode(&ssa1_bytes),
            &base64_encode(&srf1_bytes),
            &oks1_b64,
        ).unwrap();

        let current_boot = boot_session_id();
        let valid_envelope = validate_canonical_final_cache(&root, &current_boot).unwrap();

        // Helper to overwrite canonical cache with modified envelope
        let write_envelope = |env: &StaffSessionCacheEnvelopeV1| {
            let bytes = encode_ssca1(env).unwrap();
            let cipher = dpapi_protect(&bytes).unwrap();
            fs::write(staff_session_cache_path(&root), cipher).unwrap();
        };

        // 1. Altered staffId in summary
        let mut env_tamper_staff = valid_envelope.clone();
        env_tamper_staff.staff_id = "STAFF-ATTACKER".to_string();
        write_envelope(&env_tamper_staff);
        assert!(validate_canonical_final_cache(&root, &current_boot).is_err());

        // 2. Altered branchId in summary
        let mut env_tamper_branch = valid_envelope.clone();
        env_tamper_branch.branch_id = "BRANCH-ATTACKER".to_string();
        write_envelope(&env_tamper_branch);
        assert!(validate_canonical_final_cache(&root, &current_boot).is_err());

        // 3. Altered securityDeviceId in summary
        let mut env_tamper_device = valid_envelope.clone();
        env_tamper_device.security_device_id = [0xEEu8; 16];
        write_envelope(&env_tamper_device);
        assert!(validate_canonical_final_cache(&root, &current_boot).is_err());

        // 4. Bad SSA1 server signature
        let mut env_bad_ssa_sig = valid_envelope.clone();
        let mut bad_ssa = decode_ssa1(&env_bad_ssa_sig.ssa1_bytes).unwrap();
        bad_ssa.signature[0] ^= 0xFF;
        env_bad_ssa_sig.ssa1_bytes = encode_ssa1(&bad_ssa).unwrap();
        env_bad_ssa_sig.ssa1_digest = compute_sha256(&env_bad_ssa_sig.ssa1_bytes);
        write_envelope(&env_bad_ssa_sig);
        let res_bad_ssa = validate_canonical_final_cache(&root, &current_boot);
        assert!(res_bad_ssa.is_err());
        let err_bad_ssa = res_bad_ssa.unwrap_err();
        assert!(err_bad_ssa.contains("SRF1 objectDigest does not match") || err_bad_ssa.contains("SSA1 server signature verification failed"));

        // 5. Bad SRF1 server signature
        let mut env_bad_srf_sig = valid_envelope.clone();
        let mut bad_srf = decode_srf1(&env_bad_srf_sig.srf1_bytes).unwrap();
        bad_srf.signature[0] ^= 0xFF;
        env_bad_srf_sig.srf1_bytes = encode_srf1(&bad_srf).unwrap();
        env_bad_srf_sig.srf1_digest = compute_sha256(&env_bad_srf_sig.srf1_bytes);
        write_envelope(&env_bad_srf_sig);
        let res_bad_srf = validate_canonical_final_cache(&root, &current_boot);
        assert!(res_bad_srf.is_err());
        assert!(res_bad_srf.unwrap_err().contains("SRF1 server signature verification failed"));

        // 6. Monotonic clock anomaly: receipt ticks in future
        let mut env_future_receipt = valid_envelope.clone();
        env_future_receipt.receipt_qpc_ticks = u64::MAX;
        write_envelope(&env_future_receipt);
        let res_future = validate_canonical_final_cache(&root, &current_boot);
        assert!(res_future.is_err());
        assert!(res_future.unwrap_err().contains("monotonic clock anomaly"));

        // 7. Expired interval (DEC-D-07)
        let mut env_expired = valid_envelope.clone();
        env_expired.expires_at_server_ms = 1_000;
        env_expired.server_sent_at_ms = 1_000;
        // In embedded SSA1 as well
        let mut exp_ssa = decode_ssa1(&env_expired.ssa1_bytes).unwrap();
        exp_ssa.issued_at_server_ms = 500;
        exp_ssa.expires_at_server_ms = 1_000;
        let ssa_pre = ssa1_signature_preimage(&exp_ssa).unwrap();
        exp_ssa.signature = server_signer.sign(&ssa_pre).to_bytes();
        env_expired.ssa1_bytes = encode_ssa1(&exp_ssa).unwrap();
        env_expired.ssa1_digest = compute_sha256(&env_expired.ssa1_bytes);
        let mut exp_srf = decode_srf1(&env_expired.srf1_bytes).unwrap();
        exp_srf.object_digest = env_expired.ssa1_digest;
        exp_srf.server_sent_at_ms = 1_000;
        let srf_pre = srf1_signature_preimage(&exp_srf).unwrap();
        exp_srf.signature = server_signer.sign(&srf_pre).to_bytes();
        env_expired.srf1_bytes = encode_srf1(&exp_srf).unwrap();
        env_expired.srf1_digest = compute_sha256(&env_expired.srf1_bytes);
        write_envelope(&env_expired);
        let res_exp = validate_canonical_final_cache(&root, &current_boot);
        assert!(res_exp.is_err());
        assert!(res_exp.unwrap_err().contains("canonical staff session has expired (DEC-D-07)"));

        let _ = fs::remove_dir_all(&root);
    }

    // --- RR043 Matrix Seam Mocks ---

    unsafe fn pcwstr_to_path(p: PCWSTR) -> PathBuf {
        use std::os::windows::ffi::OsStringExt;
        let mut len = 0;
        while *p.0.add(len) != 0 {
            len += 1;
        }
        let slice = std::slice::from_raw_parts(p.0, len);
        std::ffi::OsString::from_wide(slice).into()
    }

    fn mock_replace_file_1176(
        replaced: PCWSTR,
        _replacement: PCWSTR,
        _backup: PCWSTR,
        _flags: windows::Win32::Storage::FileSystem::REPLACE_FILE_FLAGS,
        _exclude: Option<*const std::ffi::c_void>,
        _reserved: Option<*const std::ffi::c_void>,
    ) -> Result<(), u32> {
        let path = unsafe { pcwstr_to_path(replaced) };
        let _ = fs::remove_file(path);
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
        let path = unsafe { pcwstr_to_path(replaced) };
        let bak = path.with_extension("dpapi.bak");
        let _ = fs::rename(&path, &bak);
        Err(1177)
    }

    fn mock_replace_file_error_5(
        _replaced: PCWSTR,
        _replacement: PCWSTR,
        _backup: PCWSTR,
        _flags: windows::Win32::Storage::FileSystem::REPLACE_FILE_FLAGS,
        _exclude: Option<*const std::ffi::c_void>,
        _reserved: Option<*const std::ffi::c_void>,
    ) -> Result<(), u32> {
        Err(5) // Access Denied
    }

    static COLLISION_WINNER_ACTION: Mutex<Option<Box<dyn Fn(&Path) + Send + Sync>>> = Mutex::new(None);

    fn mock_move_file_183(
        _existing: PCWSTR,
        new: PCWSTR,
        flags: windows::Win32::Storage::FileSystem::MOVE_FILE_FLAGS,
    ) -> Result<(), u32> {
        assert_eq!(
            flags.0 & windows::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING.0,
            0,
            "must not use MOVEFILE_REPLACE_EXISTING on first create"
        );
        let dest = unsafe { pcwstr_to_path(new) };
        if let Ok(guard) = COLLISION_WINNER_ACTION.lock() {
            if let Some(ref action) = *guard {
                action(&dest);
            }
        }
        Err(183) // ERROR_ALREADY_EXISTS
    }

    #[test]
    fn test_rr043_row1_replacefile_1176_canonical_absent_fail_closed() {
        let _serial = TEST_SERIAL_MUTEX.lock().unwrap();
        reset_in_process_invalidation();
        let root = temp_dir();
        let (_dev_key, sec_id) = setup_device_identity(&root, "B01");
        let server_signer = SigningKey::generate(&mut OsRng);
        let (_oks1_bytes, oks1_b64) = make_test_manifest(&root, &server_signer, "server-k1");

        // Establish an existing canonical file first
        let cache_file = staff_session_cache_path(&root);
        fs::write(&cache_file, b"initial-canonical").unwrap();

        let c = prepare_staff_session_challenge_internal(&root, "SSA1_LOGIN", "B01", "S01").unwrap();
        let nonce: [u8; 32] = base64_decode(&c.challenge_nonce_base64).unwrap().try_into().unwrap();
        let (ssa1_bytes, ssa1_digest) = build_signed_ssa1(&server_signer, "server-k1", "SSA-01", "S01", sec_id, "B01", 1, 10_000, 10_000 + 86_400_000, true);
        let srf1_bytes = build_signed_srf1(&server_signer, "server-k1", nonce, sec_id, "B01", SRF1_OBJECT_KIND_SSA1, ssa1_digest, 10_005, true);

        // Hook simulates 1176 failure where canonical file is removed by Windows during crash/failure
        let hooks = CacheCommitHooks {
            replace_file: mock_replace_file_1176,
            move_file: win32_move_file,
        };

        let res = persist_staff_session_assertion_internal_with_hooks(
            &root,
            c.generation,
            &base64_encode(&ssa1_bytes),
            &base64_encode(&srf1_bytes),
            &oks1_b64,
            &hooks,
        );
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("1176"));

        // Challenge MUST be retained in memory
        let lock = PENDING_CHALLENGE.lock().unwrap();
        assert!(lock.is_some(), "Challenge slot must be retained on 1176 failure");
        drop(lock);

        // Canonical final absent -> validation fails closed, no temp promotion
        assert!(!cache_file.exists());
        let current_boot = boot_session_id();
        let val_res = validate_canonical_final_cache(&root, &current_boot);
        assert!(val_res.is_err());
        assert!(val_res.unwrap_err().contains("canonical staff session cache file does not exist"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_rr043_row2_replacefile_1177_canonical_renamed_fail_closed() {
        let _serial = TEST_SERIAL_MUTEX.lock().unwrap();
        reset_in_process_invalidation();
        let root = temp_dir();
        let (_dev_key, sec_id) = setup_device_identity(&root, "B01");
        let server_signer = SigningKey::generate(&mut OsRng);
        let (_oks1_bytes, oks1_b64) = make_test_manifest(&root, &server_signer, "server-k1");

        let cache_file = staff_session_cache_path(&root);
        let bak_file = root.join("twinpet-staff-session.dpapi.bak");
        fs::write(&cache_file, b"initial-canonical").unwrap();

        let c = prepare_staff_session_challenge_internal(&root, "SSA1_LOGIN", "B01", "S01").unwrap();
        let nonce: [u8; 32] = base64_decode(&c.challenge_nonce_base64).unwrap().try_into().unwrap();
        let (ssa1_bytes, ssa1_digest) = build_signed_ssa1(&server_signer, "server-k1", "SSA-01", "S01", sec_id, "B01", 1, 10_000, 10_000 + 86_400_000, true);
        let srf1_bytes = build_signed_srf1(&server_signer, "server-k1", nonce, sec_id, "B01", SRF1_OBJECT_KIND_SSA1, ssa1_digest, 10_005, true);

        // Hook simulates 1177 failure where canonical file was renamed to noncanonical sibling
        let hooks = CacheCommitHooks {
            replace_file: mock_replace_file_1177,
            move_file: win32_move_file,
        };

        let res = persist_staff_session_assertion_internal_with_hooks(
            &root,
            c.generation,
            &base64_encode(&ssa1_bytes),
            &base64_encode(&srf1_bytes),
            &oks1_b64,
            &hooks,
        );
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("1177"));

        // Challenge MUST be retained
        assert!(PENDING_CHALLENGE.lock().unwrap().is_some());

        // Canonical absent, sibling .bak must NOT confer authority
        assert!(!cache_file.exists());
        assert!(bak_file.exists());
        let current_boot = boot_session_id();
        assert!(validate_canonical_final_cache(&root, &current_boot).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_rr043_row3_generic_failure_with_valid_canonical() {
        let _serial = TEST_SERIAL_MUTEX.lock().unwrap();
        reset_in_process_invalidation();
        let root = temp_dir();
        let (_dev_key, sec_id) = setup_device_identity(&root, "B01");
        let server_signer = SigningKey::generate(&mut OsRng);
        let (_oks1_bytes, oks1_b64) = make_test_manifest(&root, &server_signer, "server-k1");

        // 1. Persist Session 1 successfully
        let c1 = prepare_staff_session_challenge_internal(&root, "SSA1_LOGIN", "B01", "S01").unwrap();
        let nonce1: [u8; 32] = base64_decode(&c1.challenge_nonce_base64).unwrap().try_into().unwrap();
        let (ssa1_bytes1, ssa1_digest1) = build_signed_ssa1(&server_signer, "server-k1", "SSA-01", "S01", sec_id, "B01", 1, 10_000, 10_000 + 86_400_000, true);
        let srf1_bytes1 = build_signed_srf1(&server_signer, "server-k1", nonce1, sec_id, "B01", SRF1_OBJECT_KIND_SSA1, ssa1_digest1, 10_005, true);

        persist_staff_session_assertion_internal(
            &root,
            c1.generation,
            &base64_encode(&ssa1_bytes1),
            &base64_encode(&srf1_bytes1),
            &oks1_b64,
        ).unwrap();

        let current_boot = boot_session_id();
        let session1 = validate_canonical_final_cache(&root, &current_boot).unwrap();
        assert_eq!(session1.staff_id, "S01");

        // 2. Prepare Session 2 and simulate commit failure (Access Denied / error 5)
        let c2 = prepare_staff_session_challenge_internal(&root, "SSA1_LOGIN", "B01", "S02").unwrap();
        let nonce2: [u8; 32] = base64_decode(&c2.challenge_nonce_base64).unwrap().try_into().unwrap();
        let (ssa1_bytes2, ssa1_digest2) = build_signed_ssa1(&server_signer, "server-k1", "SSA-02", "S02", sec_id, "B01", 1, 20_000, 20_000 + 86_400_000, true);
        let srf1_bytes2 = build_signed_srf1(&server_signer, "server-k1", nonce2, sec_id, "B01", SRF1_OBJECT_KIND_SSA1, ssa1_digest2, 20_005, true);

        let hooks = CacheCommitHooks {
            replace_file: mock_replace_file_error_5,
            move_file: win32_move_file,
        };

        let res2 = persist_staff_session_assertion_internal_with_hooks(
            &root,
            c2.generation,
            &base64_encode(&ssa1_bytes2),
            &base64_encode(&srf1_bytes2),
            &oks1_b64,
            &hooks,
        );
        assert!(res2.is_err());
        assert!(res2.unwrap_err().contains("5"));

        // Challenge 2 retained
        let lock = PENDING_CHALLENGE.lock().unwrap();
        assert_eq!(lock.as_ref().unwrap().generation, c2.generation);
        drop(lock);

        // Old canonical cache STILL independently valid for Session 1
        let session1_recheck = validate_canonical_final_cache(&root, &current_boot).unwrap();
        assert_eq!(session1_recheck.staff_id, "S01");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_rr043_row4_generic_failure_with_corrupt_canonical() {
        let _serial = TEST_SERIAL_MUTEX.lock().unwrap();
        reset_in_process_invalidation();
        let root = temp_dir();
        let (_dev_key, sec_id) = setup_device_identity(&root, "B01");
        let server_signer = SigningKey::generate(&mut OsRng);
        let (_oks1_bytes, oks1_b64) = make_test_manifest(&root, &server_signer, "server-k1");

        let cache_file = staff_session_cache_path(&root);
        fs::write(&cache_file, b"corrupted-ciphertext").unwrap();

        let c = prepare_staff_session_challenge_internal(&root, "SSA1_LOGIN", "B01", "S01").unwrap();
        let nonce: [u8; 32] = base64_decode(&c.challenge_nonce_base64).unwrap().try_into().unwrap();
        let (ssa1_bytes, ssa1_digest) = build_signed_ssa1(&server_signer, "server-k1", "SSA-01", "S01", sec_id, "B01", 1, 10_000, 10_000 + 86_400_000, true);
        let srf1_bytes = build_signed_srf1(&server_signer, "server-k1", nonce, sec_id, "B01", SRF1_OBJECT_KIND_SSA1, ssa1_digest, 10_005, true);

        let hooks = CacheCommitHooks {
            replace_file: mock_replace_file_error_5,
            move_file: win32_move_file,
        };

        let res = persist_staff_session_assertion_internal_with_hooks(
            &root,
            c.generation,
            &base64_encode(&ssa1_bytes),
            &base64_encode(&srf1_bytes),
            &oks1_b64,
            &hooks,
        );
        assert!(res.is_err());

        // Challenge retained
        assert!(PENDING_CHALLENGE.lock().unwrap().is_some());

        // Canonical cache fails closed (corrupt)
        let current_boot = boot_session_id();
        assert!(validate_canonical_final_cache(&root, &current_boot).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_rr043_row5_first_create_collision_valid_winner() {
        let _serial = TEST_SERIAL_MUTEX.lock().unwrap();
        reset_in_process_invalidation();
        let root = temp_dir();
        let (_dev_key, sec_id) = setup_device_identity(&root, "B01");
        let server_signer = SigningKey::generate(&mut OsRng);
        let (_oks1_bytes, oks1_b64) = make_test_manifest(&root, &server_signer, "server-k1");

        // Canonical file does not exist initially
        assert!(!staff_session_cache_path(&root).exists());

        // Prepare racing winner data (a completely valid staff session envelope)
        let (winner_ssa_bytes, winner_ssa_digest) = build_signed_ssa1(&server_signer, "server-k1", "SSA-WINNER", "S01", sec_id, "B01", 1, 10_000, 10_000 + 86_400_000, true);
        let winner_nonce = [0x77u8; 32];
        let winner_srf_bytes = build_signed_srf1(&server_signer, "server-k1", winner_nonce, sec_id, "B01", SRF1_OBJECT_KIND_SSA1, winner_ssa_digest, 10_005, true);
        let winner_srf_digest = compute_sha256(&winner_srf_bytes);
        let winner_ticks = read_qpc_ticks().unwrap();
        let current_boot = boot_session_id();
        let winner_env = StaffSessionCacheEnvelopeV1 {
            boot_session_id: current_boot,
            request_qpc_ticks: winner_ticks,
            receipt_qpc_ticks: winner_ticks,
            server_sent_at_ms: 10_005,
            expires_at_server_ms: 10_000 + 86_400_000,
            device_key_version: 1,
            security_device_id: sec_id,
            staff_id: "S01".to_string(),
            branch_id: "B01".to_string(),
            ssa1_bytes: winner_ssa_bytes,
            srf1_bytes: winner_srf_bytes,
            ssa1_digest: winner_ssa_digest,
            srf1_digest: winner_srf_digest,
        };
        let winner_raw = encode_ssca1(&winner_env).unwrap();
        let winner_ciphertext = dpapi_protect(&winner_raw).unwrap();

        // Inject collision action: write the valid winner file to destination before 183 is returned
        {
            let mut guard = COLLISION_WINNER_ACTION.lock().unwrap();
            *guard = Some(Box::new(move |dest: &Path| {
                fs::write(dest, &winner_ciphertext).unwrap();
            }));
        }

        let c = prepare_staff_session_challenge_internal(&root, "SSA1_LOGIN", "B01", "S01").unwrap();
        let nonce: [u8; 32] = base64_decode(&c.challenge_nonce_base64).unwrap().try_into().unwrap();
        let (ssa1_bytes, ssa1_digest) = build_signed_ssa1(&server_signer, "server-k1", "SSA-LOSER", "S01", sec_id, "B01", 1, 10_000, 10_000 + 86_400_000, true);
        let srf1_bytes = build_signed_srf1(&server_signer, "server-k1", nonce, sec_id, "B01", SRF1_OBJECT_KIND_SSA1, ssa1_digest, 10_005, true);

        let hooks = CacheCommitHooks {
            replace_file: win32_replace_file,
            move_file: mock_move_file_183,
        };

        let res = persist_staff_session_assertion_internal_with_hooks(
            &root,
            c.generation,
            &base64_encode(&ssa1_bytes),
            &base64_encode(&srf1_bytes),
            &oks1_b64,
            &hooks,
        );
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("183"));

        // Reset the action hook
        *COLLISION_WINNER_ACTION.lock().unwrap() = None;

        // Challenge slot must be retained for the losing attempt
        assert!(PENDING_CHALLENGE.lock().unwrap().is_some());

        // The racing winner independently validates successfully!
        let loaded_winner = validate_canonical_final_cache(&root, &current_boot).unwrap();
        assert_eq!(loaded_winner.staff_id, "S01");
        assert_eq!(loaded_winner.ssa1_digest, winner_ssa_digest);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_rr043_row5_first_create_collision_corrupt_winner() {
        let _serial = TEST_SERIAL_MUTEX.lock().unwrap();
        reset_in_process_invalidation();
        let root = temp_dir();
        let (_dev_key, sec_id) = setup_device_identity(&root, "B01");
        let server_signer = SigningKey::generate(&mut OsRng);
        let (_oks1_bytes, oks1_b64) = make_test_manifest(&root, &server_signer, "server-k1");

        // Canonical file does not exist initially
        assert!(!staff_session_cache_path(&root).exists());

        // Inject collision action: write corrupt bytes to destination before 183
        {
            let mut guard = COLLISION_WINNER_ACTION.lock().unwrap();
            *guard = Some(Box::new(|dest: &Path| {
                fs::write(dest, b"corrupt-racing-winner-garbage").unwrap();
            }));
        }

        let c = prepare_staff_session_challenge_internal(&root, "SSA1_LOGIN", "B01", "S01").unwrap();
        let nonce: [u8; 32] = base64_decode(&c.challenge_nonce_base64).unwrap().try_into().unwrap();
        let (ssa1_bytes, ssa1_digest) = build_signed_ssa1(&server_signer, "server-k1", "SSA-01", "S01", sec_id, "B01", 1, 10_000, 10_000 + 86_400_000, true);
        let srf1_bytes = build_signed_srf1(&server_signer, "server-k1", nonce, sec_id, "B01", SRF1_OBJECT_KIND_SSA1, ssa1_digest, 10_005, true);

        let hooks = CacheCommitHooks {
            replace_file: win32_replace_file,
            move_file: mock_move_file_183,
        };

        let res = persist_staff_session_assertion_internal_with_hooks(
            &root,
            c.generation,
            &base64_encode(&ssa1_bytes),
            &base64_encode(&srf1_bytes),
            &oks1_b64,
            &hooks,
        );
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("183"));

        // Reset hook
        *COLLISION_WINNER_ACTION.lock().unwrap() = None;

        // Challenge slot retained
        assert!(PENDING_CHALLENGE.lock().unwrap().is_some());

        // Canonical validator fails closed on corrupt winner
        let current_boot = boot_session_id();
        assert!(validate_canonical_final_cache(&root, &current_boot).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_manifest_persistence_failure_retains_challenge_and_blocks_cache_commit() {
        let _serial = TEST_SERIAL_MUTEX.lock().unwrap();
        reset_in_process_invalidation();
        let root = temp_dir();
        let (_dev_key, sec_id) = setup_device_identity(&root, "B01");
        let server_signer = SigningKey::generate(&mut OsRng);
        let (_oks1_bytes, oks1_b64) = make_test_manifest(&root, &server_signer, "server-k1");

        let c = prepare_staff_session_challenge_internal(&root, "SSA1_LOGIN", "B01", "S01").unwrap();
        let nonce: [u8; 32] = base64_decode(&c.challenge_nonce_base64).unwrap().try_into().unwrap();
        let (ssa1_bytes, ssa1_digest) = build_signed_ssa1(&server_signer, "server-k1", "SSA-01", "S01", sec_id, "B01", 1, 10_000, 10_000 + 86_400_000, true);
        let srf1_bytes = build_signed_srf1(&server_signer, "server-k1", nonce, sec_id, "B01", SRF1_OBJECT_KIND_SSA1, ssa1_digest, 10_005, true);

        let hooks = CacheCommitHooks {
            replace_file: win32_replace_file,
            move_file: win32_move_file,
        };

        let bad_oks1_b64 = base64_encode(b"mismatched_manifest_bytes");

        let res = persist_staff_session_assertion_internal_with_hooks(
            &root,
            c.generation,
            &base64_encode(&ssa1_bytes),
            &base64_encode(&srf1_bytes),
            &bad_oks1_b64,
            &hooks,
        );
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("STAFF_SESSION_MANIFEST_MISMATCH"));

        // Pending challenge MUST be retained
        assert!(PENDING_CHALLENGE.lock().unwrap().is_some());

        // Cache file must NOT exist
        assert!(!staff_session_cache_path(&root).exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_clear_staff_session_deletion_failure_seam() {
        let _serial = TEST_SERIAL_MUTEX.lock().unwrap();
        reset_in_process_invalidation();
        let root = temp_dir();
        let (_dev_key, sec_id) = setup_device_identity(&root, "B01");
        let server_signer = SigningKey::generate(&mut OsRng);
        let (_oks1_bytes, oks1_b64) = make_test_manifest(&root, &server_signer, "server-k1");

        // 1. Commit valid session
        let c = prepare_staff_session_challenge_internal(&root, "SSA1_LOGIN", "B01", "S01").unwrap();
        let nonce: [u8; 32] = base64_decode(&c.challenge_nonce_base64).unwrap().try_into().unwrap();
        let (ssa1_bytes, ssa1_digest) = build_signed_ssa1(&server_signer, "server-k1", "SSA-01", "S01", sec_id, "B01", 1, 10_000, 10_000 + 86_400_000, true);
        let srf1_bytes = build_signed_srf1(&server_signer, "server-k1", nonce, sec_id, "B01", SRF1_OBJECT_KIND_SSA1, ssa1_digest, 10_005, true);

        persist_staff_session_assertion_internal(
            &root,
            c.generation,
            &base64_encode(&ssa1_bytes),
            &base64_encode(&srf1_bytes),
            &oks1_b64,
        ).unwrap();

        let current_boot = boot_session_id();
        assert!(validate_canonical_final_cache(&root, &current_boot).is_ok());

        // 2. Clear staff session with failing remove_file seam
        fn mock_remove_file_denied(_p: &Path) -> std::io::Result<()> {
            Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "access denied"))
        }

        let clear_res = clear_staff_session_internal_with_hooks(&root, mock_remove_file_denied);
        assert!(clear_res.is_err());
        assert!(clear_res.unwrap_err().contains("CANONICAL_CACHE_DELETION_FAILED"));

        // 3. Proves: canonical file survives on disk
        let final_path = staff_session_cache_path(&root);
        assert!(final_path.exists());

        // 4. Proves: in-process cache invalidation is ACTIVE and rejects authorization!
        let post_clear_val = validate_canonical_final_cache(&root, &current_boot);
        assert!(post_clear_val.is_err());
        assert!(post_clear_val.unwrap_err().contains("canonical staff session cache has been invalidated in-process"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_dec_d07_reversed_qpc_ticks_fails_closed() {
        let _serial = TEST_SERIAL_MUTEX.lock().unwrap();
        reset_in_process_invalidation();
        let root = temp_dir();
        let (_dev_key, sec_id) = setup_device_identity(&root, "B01");
        let server_signer = SigningKey::generate(&mut OsRng);
        let (oks1_bytes, _oks1_b64) = make_test_manifest(&root, &server_signer, "server-k1");

        let current_boot = boot_session_id();
        let now_ticks = read_qpc_ticks().unwrap();

        let (ssa1_bytes, ssa1_digest) = build_signed_ssa1(&server_signer, "server-k1", "SSA-01", "S01", sec_id, "B01", 1, 10_000, 10_000 + 86_400_000, true);
        let srf1_bytes = build_signed_srf1(&server_signer, "server-k1", [0u8; 32], sec_id, "B01", SRF1_OBJECT_KIND_SSA1, ssa1_digest, 10_005, true);
        let srf1_digest = compute_sha256(&srf1_bytes);

        // Envelope where receipt_qpc_ticks < request_qpc_ticks (monotonic violation)
        let reversed_env = StaffSessionCacheEnvelopeV1 {
            boot_session_id: current_boot,
            request_qpc_ticks: now_ticks,
            receipt_qpc_ticks: now_ticks.saturating_sub(1000),
            server_sent_at_ms: 10_005,
            expires_at_server_ms: 10_000 + 86_400_000,
            device_key_version: 1,
            security_device_id: sec_id,
            staff_id: "S01".to_string(),
            branch_id: "B01".to_string(),
            ssa1_bytes,
            srf1_bytes,
            ssa1_digest,
            srf1_digest,
        };

        let raw = encode_ssca1(&reversed_env).unwrap();
        let ciphertext = dpapi_protect(&raw).unwrap();
        fs::write(staff_session_cache_path(&root), &ciphertext).unwrap();

        let res = validate_canonical_final_cache(&root, &current_boot);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("monotonic clock anomaly: receipt ticks prior to request ticks"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_rr043_row6_startup_canonical_only() {
        let root = temp_dir();
        let current_boot = boot_session_id();

        // Storing stray .tmp and .bak without canonical final
        let tmp_path = staff_session_cache_tmp_path(&root);
        fs::write(&tmp_path, b"stray-tmp-data").unwrap();
        let bak_path = root.join("twinpet-staff-session.dpapi.bak");
        fs::write(&bak_path, b"stray-bak-data").unwrap();

        // Must fail closed; neither .tmp nor .bak is ever promoted or validated
        let res = validate_canonical_final_cache(&root, &current_boot);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("canonical staff session cache file does not exist"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_canonical_final_rejects_prior_boot_session() {
        let _serial = TEST_SERIAL_MUTEX.lock().unwrap();
        reset_in_process_invalidation();
        let root = temp_dir();
        let (_dev_key, sec_id) = setup_device_identity(&root, "B01");
        let server_signer = SigningKey::generate(&mut OsRng);
        let (_oks1_bytes, oks1_b64) = make_test_manifest(&root, &server_signer, "server-k1");

        let challenge = prepare_staff_session_challenge_internal(&root, "SSA1_LOGIN", "B01", "S01").unwrap();
        let nonce_bytes = base64_decode(&challenge.challenge_nonce_base64).unwrap();
        let mut nonce = [0u8; 32];
        nonce.copy_from_slice(&nonce_bytes);

        let (ssa1_bytes, ssa1_digest) = build_signed_ssa1(&server_signer, "server-k1", "SSA-01", "S01", sec_id, "B01", 1, 10_000, 10_000 + 86_400_000, true);
        let srf1_bytes = build_signed_srf1(&server_signer, "server-k1", nonce, sec_id, "B01", SRF1_OBJECT_KIND_SSA1, ssa1_digest, 10_005, true);

        persist_staff_session_assertion_internal(
            &root,
            challenge.generation,
            &base64_encode(&ssa1_bytes),
            &base64_encode(&srf1_bytes),
            &oks1_b64,
        ).unwrap();

        // Valid with current boot session
        let current_boot = boot_session_id();
        assert!(validate_canonical_final_cache(&root, &current_boot).is_ok());

        // Fails closed with different boot session (simulating restart)
        let prior_boot = [0xFFu8; 16];
        let res = validate_canonical_final_cache(&root, &prior_boot);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("prior boot session"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_dec_d07_large_rtt_discriminator_falsifies_incomplete_formula() {
        let _serial = TEST_SERIAL_MUTEX.lock().unwrap();
        reset_in_process_invalidation();
        let root = temp_dir();
        let (_dev_key, sec_id) = setup_device_identity(&root, "B01");
        let server_signer = SigningKey::generate(&mut OsRng);
        let (oks1_bytes, _oks1_b64) = make_test_manifest(&root, &server_signer, "server-k1");

        let current_boot = boot_session_id();
        let freq: u64 = 10_000_000; // 10 MHz: 10,000 ticks = 1 ms
        let request_ticks: u64 = 0;
        let receipt_ticks: u64 = 100_000_000; // 10,000 ms = 10s RTT_upper
        let current_ticks: u64 = 100_010_000; // 1 ms elapsed since receipt
        let server_sent_at_ms: u64 = 1_000_000;
        let expires_at_server_ms: u64 = 1_005_000; // 5,000 ms window

        // Falsification proof:
        // 1. Incomplete formula (serverSentAtMs + elapsed <= expiresAtServerMs):
        //    1,000,000 + 1 = 1,000,001 <= 1,005,000 -> WOULD PASS (FALSE GREEN)!
        // 2. Exact DEC-D-07 formula (serverSentAtMs + RTT_upper + elapsed <= expiresAtServerMs):
        //    1,000,000 + 10,000 + 1 = 1,010,001 > 1,005,000 -> MUST REJECT!

        // Pure helper assertion
        let pure_res = check_dec_d07_temporal_bounds(
            server_sent_at_ms,
            expires_at_server_ms,
            request_ticks,
            receipt_ticks,
            current_ticks,
            freq,
        );
        assert!(pure_res.is_err());
        assert!(pure_res.unwrap_err().contains("canonical staff session has expired (DEC-D-07)"));

        // Validator-level assertion
        let (ssa1_bytes, ssa1_digest) = build_signed_ssa1(&server_signer, "server-k1", "SSA-01", "S01", sec_id, "B01", 1, server_sent_at_ms - 1000, expires_at_server_ms, true);
        let srf1_bytes = build_signed_srf1(&server_signer, "server-k1", [0u8; 32], sec_id, "B01", SRF1_OBJECT_KIND_SSA1, ssa1_digest, server_sent_at_ms, true);
        let srf1_digest = compute_sha256(&srf1_bytes);

        let env = StaffSessionCacheEnvelopeV1 {
            boot_session_id: current_boot,
            request_qpc_ticks: request_ticks,
            receipt_qpc_ticks: receipt_ticks,
            server_sent_at_ms,
            expires_at_server_ms,
            device_key_version: 1,
            security_device_id: sec_id,
            staff_id: "S01".to_string(),
            branch_id: "B01".to_string(),
            ssa1_bytes,
            srf1_bytes,
            ssa1_digest,
            srf1_digest,
        };

        let raw = encode_ssca1(&env).unwrap();
        let ciphertext = dpapi_protect(&raw).unwrap();
        fs::write(staff_session_cache_path(&root), &ciphertext).unwrap();

        let val_res = validate_canonical_final_cache_with_clock(&root, &current_boot, current_ticks, freq);
        assert!(val_res.is_err());
        assert!(val_res.unwrap_err().contains("canonical staff session has expired (DEC-D-07)"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_dec_d07_validator_checked_addition_overflow_fails_closed() {
        let _serial = TEST_SERIAL_MUTEX.lock().unwrap();
        reset_in_process_invalidation();
        let root = temp_dir();
        let (_dev_key, sec_id) = setup_device_identity(&root, "B01");
        let server_signer = SigningKey::generate(&mut OsRng);
        let (oks1_bytes, _oks1_b64) = make_test_manifest(&root, &server_signer, "server-k1");

        let current_boot = boot_session_id();
        let freq: u64 = 10_000_000;
        let request_ticks: u64 = 0;
        let receipt_ticks: u64 = 50_000_000; // 5000 ms
        let current_ticks: u64 = 60_000_000; // 1000 ms
        let server_sent_at_ms: u64 = u64::MAX - 2000; // Addition with 5000 + 1000 ms will overflow!
        let expires_at_server_ms: u64 = u64::MAX - 1000;
        let issued_at_server_ms: u64 = u64::MAX - 80_000_000; // Lifetime = 79,999,000 ms <= 86,400,000 ms (valid DEC-D-06)

        // Pure helper overflow assertion
        let pure_res = check_dec_d07_temporal_bounds(
            server_sent_at_ms,
            expires_at_server_ms,
            request_ticks,
            receipt_ticks,
            current_ticks,
            freq,
        );
        assert!(pure_res.is_err());
        assert!(pure_res.unwrap_err().contains("overflow calculating estimated server upper bound time"));

        // Validator-level overflow assertion
        let (ssa1_bytes, ssa1_digest) = build_signed_ssa1(&server_signer, "server-k1", "SSA-01", "S01", sec_id, "B01", 1, issued_at_server_ms, expires_at_server_ms, true);
        let srf1_bytes = build_signed_srf1(&server_signer, "server-k1", [0u8; 32], sec_id, "B01", SRF1_OBJECT_KIND_SSA1, ssa1_digest, server_sent_at_ms, true);
        let srf1_digest = compute_sha256(&srf1_bytes);

        let env = StaffSessionCacheEnvelopeV1 {
            boot_session_id: current_boot,
            request_qpc_ticks: request_ticks,
            receipt_qpc_ticks: receipt_ticks,
            server_sent_at_ms,
            expires_at_server_ms,
            device_key_version: 1,
            security_device_id: sec_id,
            staff_id: "S01".to_string(),
            branch_id: "B01".to_string(),
            ssa1_bytes,
            srf1_bytes,
            ssa1_digest,
            srf1_digest,
        };

        let raw = encode_ssca1(&env).unwrap();
        let ciphertext = dpapi_protect(&raw).unwrap();
        fs::write(staff_session_cache_path(&root), &ciphertext).unwrap();

        let val_res = validate_canonical_final_cache_with_clock(&root, &current_boot, current_ticks, freq);
        assert!(val_res.is_err());
        assert!(val_res.unwrap_err().contains("overflow calculating estimated server upper bound time"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_dec_d07_future_receipt_ticks_fails_closed() {
        let freq: u64 = 10_000_000;
        let request_ticks: u64 = 10_000;
        let receipt_ticks: u64 = 20_000;
        let current_ticks: u64 = 15_000; // current < receipt (future receipt anomaly)

        let res = check_dec_d07_temporal_bounds(
            1_000,
            2_000,
            request_ticks,
            receipt_ticks,
            current_ticks,
            freq,
        );
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("monotonic clock anomaly: receipt ticks in future"));
    }

    #[test]
    fn test_dec_d07_exact_boundary_conditions() {
        let freq: u64 = 10_000_000; // 10,000 ticks/ms
        let request_ticks: u64 = 0;
        let receipt_ticks: u64 = 20_000; // 2 ms RTT_upper
        let current_ticks: u64 = 30_000; // 1 ms elapsed
        let server_sent_at_ms: u64 = 1000;
        // Total estimated bound = 1000 + 2 + 1 = 1003 ms

        // Exactly on boundary: 1003 <= 1003 -> Passes
        let exact_pass = check_dec_d07_temporal_bounds(server_sent_at_ms, 1003, request_ticks, receipt_ticks, current_ticks, freq);
        assert_eq!(exact_pass, Ok(1003));

        // 1 ms past boundary: 1003 > 1002 -> Fails
        let exact_fail = check_dec_d07_temporal_bounds(server_sent_at_ms, 1002, request_ticks, receipt_ticks, current_ticks, freq);
        assert!(exact_fail.is_err());
        assert!(exact_fail.unwrap_err().contains("canonical staff session has expired (DEC-D-07)"));
    }
}
