//! SEC-001 Packet C-B — Native Offline Verifier Execution and Lifecycle.
//!
//! Enforces:
//! - Strict fail-closed 20-step verification pipeline (R1–R7)
//! - Native time only (no WebView now_ms)
//! - OAC verified branch authority (no WebView branchId)
//! - Strict revocation epoch equality (R4)
//! - Length-prefixed binary SHA-256 evidence seed digest (R6)
//! - 32-byte CSPRNG raw nonce exposed as standard base64 (R7)
//! - Lockout FSM (5 attempts, 15m cooldown, LCT1 generation binding)

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use super::argon2_kdf;
use super::clock_guard;
use super::frames;
use super::lockout_state::{self, LockoutPrecheck};
use super::oac_keyset_frame;
use super::pepper_store;
use super::security_device_id;

static VERIFIER_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub const OAC_SCHEMA_VERSION: u32 = 1;
const B64_STD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn is_lowercase_hex32(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OacVerifierParamsDto {
    pub m: u32,
    pub t: u32,
    pub p: u32,
    pub salt_len: u32,
    pub hash_len: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredOacEnvelope {
    pub oac_id: String,
    pub schema_version: u32,
    pub manager_staff_id: String,
    pub manager_role: String,
    pub branch_id: String,
    pub device_id: String,
    pub allowed_actions: Vec<String>,
    pub auth_version_at_issue: u32,
    pub credential_version_at_issue: u32,
    pub revocation_epoch: u32,
    pub issued_at_server_ms: u64,
    pub freshness_expires_at_server_ms: u64,
    pub verifier_algo: String,
    pub verifier_params: OacVerifierParamsDto,
    pub verifier_salt: String,
    pub verifier: String,
    pub pepper_commitment: String,
    pub signing_key_id: String,
    pub signature: String,
}

pub fn validate_stored_oac(oac: &StoredOacEnvelope) -> Result<(), String> {
    if oac.schema_version != OAC_SCHEMA_VERSION {
        return Err(format!("unsupported schemaVersion: {}", oac.schema_version));
    }
    if !frames::is_canonical_identifier(&oac.oac_id) {
        return Err(format!("invalid oacId grammar: '{}'", oac.oac_id));
    }
    if !frames::is_canonical_identifier(&oac.manager_staff_id) {
        return Err(format!("invalid managerStaffId grammar: '{}'", oac.manager_staff_id));
    }
    if oac.manager_role != "manager" && oac.manager_role != "admin" {
        return Err(format!("unauthorized managerRole: '{}'", oac.manager_role));
    }
    if oac.branch_id.is_empty() || oac.branch_id == "ALL" {
        return Err(format!("invalid branchId: '{}'", oac.branch_id));
    }
    if !is_lowercase_hex32(&oac.device_id) {
        return Err("deviceId must be exactly 32 lowercase hex characters".to_string());
    }
    if oac.allowed_actions.is_empty() {
        return Err("allowedActions must not be empty".to_string());
    }
    let mut seen_actions = std::collections::HashSet::new();
    for action in &oac.allowed_actions {
        if action != "VOID_PENDING_SALE" && action != "VOID_SETTLED_SALE" {
            return Err(format!("unrecognized allowedAction: '{action}'"));
        }
        if !seen_actions.insert(action.as_str()) {
            return Err(format!("duplicate action in allowedActions: '{action}'"));
        }
    }
    if oac.issued_at_server_ms == 0 {
        return Err("issuedAtServerMs must be positive".to_string());
    }
    if oac.freshness_expires_at_server_ms <= oac.issued_at_server_ms {
        return Err("freshnessExpiresAtServerMs must be greater than issuedAtServerMs".to_string());
    }
    if oac.verifier_algo != "argon2id" {
        return Err(format!("unsupported verifierAlgo: '{}'", oac.verifier_algo));
    }
    if oac.verifier_params.m != 65536
        || oac.verifier_params.t != 3
        || oac.verifier_params.p != 1
        || oac.verifier_params.salt_len != 16
        || oac.verifier_params.hash_len != 32
    {
        return Err("verifierParams do not match frozen Argon2id contract".to_string());
    }
    let salt_bytes = base64_decode_std(&oac.verifier_salt).map_err(|e| format!("invalid verifierSalt: {e}"))?;
    if salt_bytes.len() != 16 {
        return Err(format!("verifierSalt must decode to 16 bytes, got {}", salt_bytes.len()));
    }
    let verifier_bytes = base64_decode_std(&oac.verifier).map_err(|e| format!("invalid verifier: {e}"))?;
    if verifier_bytes.len() != 32 {
        return Err(format!("verifier must decode to 32 bytes, got {}", verifier_bytes.len()));
    }
    let pepper_bytes = base64_decode_std(&oac.pepper_commitment).map_err(|e| format!("invalid pepperCommitment: {e}"))?;
    if pepper_bytes.len() != 32 {
        return Err(format!("pepperCommitment must decode to 32 bytes, got {}", pepper_bytes.len()));
    }
    if !frames::is_canonical_identifier(&oac.signing_key_id) {
        return Err(format!("invalid signingKeyId: '{}'", oac.signing_key_id));
    }
    let sig_bytes = base64_decode_std(&oac.signature).map_err(|e| format!("invalid signature: {e}"))?;
    if sig_bytes.len() != 64 {
        return Err(format!("signature must decode to 64 bytes, got {}", sig_bytes.len()));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrivilegedEvidenceSeedDto {
    pub oac_id: String,
    pub oac_schema_version: u32,
    pub revocation_epoch_at_issue: u32,
    pub manager_auth_version_at_issue: u32,
    pub manager_credential_version_at_issue: u32,
    pub nonce: String,
    pub attempt_count: u32,
    pub approval_result: String,
    pub approval_proof_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrivilegedVerifyOutcomeDto {
    pub ok: bool,
    pub verified_branch_id: Option<String>,
    pub evidence_seed: Option<PrivilegedEvidenceSeedDto>,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClearLockoutOutcomeDto {
    pub ok: bool,
    pub manager_staff_id: Option<String>,
    pub reopens_now: bool,
    pub cooldown_remaining_ms: u64,
    pub error_code: Option<String>,
}

pub fn base64_encode_std(bytes: &[u8]) -> String {
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = chunk.get(1).copied().unwrap_or(0) as usize;
        let b2 = chunk.get(2).copied().unwrap_or(0) as usize;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_STD[(triple >> 18) & 0x3f] as char);
        out.push(B64_STD[(triple >> 12) & 0x3f] as char);
        if chunk.len() > 1 {
            out.push(B64_STD[(triple >> 6) & 0x3f] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(B64_STD[triple & 0x3f] as char);
        } else {
            out.push('=');
        }
    }
    out
}

pub fn base64_decode_std(input: &str) -> Result<Vec<u8>, String> {
    let clean: String = input.chars().filter(|c| !c.is_whitespace()).collect();
    if clean.len() % 4 != 0 {
        return Err("invalid base64 length".to_string());
    }
    let mut out = Vec::with_capacity(clean.len() / 4 * 3);
    let bytes = clean.as_bytes();
    for chunk in bytes.chunks(4) {
        let mut vals = [0usize; 4];
        for (i, &b) in chunk.iter().enumerate() {
            if b == b'=' {
                vals[i] = 0;
            } else {
                let idx = B64_STD.iter().position(|&x| x == b).ok_or_else(|| "invalid base64 byte".to_string())?;
                vals[i] = idx;
            }
        }
        let triple = (vals[0] << 18) | (vals[1] << 12) | (vals[2] << 6) | vals[3];
        out.push(((triple >> 16) & 0xff) as u8);
        if chunk[2] != b'=' {
            out.push(((triple >> 8) & 0xff) as u8);
        }
        if chunk[3] != b'=' {
            out.push((triple & 0xff) as u8);
        }
    }
    Ok(out)
}

fn canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "null".to_string(),
        serde_json::Value::Bool(b) => if *b { "true".to_string() } else { "false".to_string() },
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string()),
        serde_json::Value::Array(arr) => {
            let elems: Vec<String> = arr.iter().map(canonical_json).collect();
            format!("[{}]", elems.join(","))
        }
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let pairs: Vec<String> = keys
                .into_iter()
                .map(|k| format!("{}:{}", serde_json::to_string(k).unwrap(), canonical_json(&map[k])))
                .collect();
            format!("{{{}}}", pairs.join(","))
        }
    }
}

pub fn compute_approval_proof_digest(
    oac_id: &str,
    nonce_raw: &[u8; 32],
    approval_result: &str,
    device_id_raw: &[u8; 16],
) -> String {
    let mut hasher = Sha256::new();

    // 1. oacId
    let oac_bytes = oac_id.as_bytes();
    hasher.update((oac_bytes.len() as u32).to_le_bytes());
    hasher.update(oac_bytes);

    // 2. nonce (raw 32 bytes)
    hasher.update((32u32).to_le_bytes());
    hasher.update(nonce_raw);

    // 3. approvalResult
    let result_bytes = approval_result.as_bytes();
    hasher.update((result_bytes.len() as u32).to_le_bytes());
    hasher.update(result_bytes);

    // 4. deviceId (raw 16 bytes)
    hasher.update((16u32).to_le_bytes());
    hasher.update(device_id_raw);

    let digest = hasher.finalize();
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
fn oac_store_dir(root: &Path) -> PathBuf {
    root.join("oac-store")
}

fn oks1_manifest_path(root: &Path) -> PathBuf {
    root.join("twinpet-oac-keyset-manifest.bin")
}

pub const LIFECYCLE_LOCK_FILENAME: &str = "twinpet-privileged-auth-lifecycle.lock";

pub fn lifecycle_lock_path(root: &Path) -> PathBuf {
    root.join(LIFECYCLE_LOCK_FILENAME)
}

pub struct LifecycleLockGuard {
    _file: fs::File,
}

#[cfg(windows)]
fn try_open_exclusive(path: &Path) -> std::io::Result<fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .share_mode(0) // dwShareMode = 0: exclusive handle across all processes/sessions
        .open(path)
}

#[cfg(not(windows))]
fn try_open_exclusive(path: &Path) -> std::io::Result<fs::File> {
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(path)
}

pub fn acquire_lifecycle_lock(root: &Path, timeout_ms: u64) -> Result<LifecycleLockGuard, String> {
    let path = lifecycle_lock_path(root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("cannot create lock directory: {e}"))?;
    }

    let start = std::time::Instant::now();
    loop {
        match try_open_exclusive(&path) {
            Ok(file) => return Ok(LifecycleLockGuard { _file: file }),
            Err(e) => {
                if start.elapsed().as_millis() as u64 >= timeout_ms {
                    return Err(format!("lifecycle lock timeout after {timeout_ms}ms: {e}"));
                }
                std::thread::sleep(std::time::Duration::from_millis(15));
            }
        }
    }
}

fn verify_oac_signature(
    envelope: &StoredOacEnvelope,
    manifest: &frames::OacKeysetManifestFrameV1,
) -> bool {
    let public_key_bytes = match oac_keyset_frame::find_signing_key(manifest, &envelope.signing_key_id) {
        Some(k) => k,
        None => return false,
    };
    let verifying_key = match VerifyingKey::from_bytes(public_key_bytes) {
        Ok(k) => k,
        Err(_) => return false,
    };

    let sig_bytes = match base64_decode_std(&envelope.signature) {
        Ok(b) if b.len() == 64 => b,
        _ => return false,
    };
    let mut sig_arr = [0u8; 64];
    sig_arr.copy_from_slice(&sig_bytes);
    let signature = Signature::from_bytes(&sig_arr);

    let val = match serde_json::to_value(envelope) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let mut obj = match val.as_object() {
        Some(m) => m.clone(),
        None => return false,
    };
    obj.remove("signature");
    let payload = canonical_json(&serde_json::Value::Object(obj));

    verifying_key.verify(payload.as_bytes(), &signature).is_ok()
}

/// Native offline PIN verification implementation (no WebView now_ms / branchId).
/// Serialized by VERIFIER_MUTEX across the entire security-critical verify transaction.
pub fn verify_offline_pin(
    root: &Path,
    manager_staff_id: &str,
    action_id: &str,
    pin: &str,
) -> Result<PrivilegedVerifyOutcomeDto, String> {
    let _lifecycle_guard = match acquire_lifecycle_lock(root, 120_000) {
        Ok(g) => g,
        Err(_) => {
            return Ok(PrivilegedVerifyOutcomeDto {
                ok: false,
                verified_branch_id: None,
                evidence_seed: None,
                error_code: Some("DENIED_UNVERIFIABLE".to_string()),
            });
        }
    };

    let _verifier_guard = match VERIFIER_MUTEX.lock() {
        Ok(g) => g,
        Err(_) => {
            return Ok(PrivilegedVerifyOutcomeDto {
                ok: false,
                verified_branch_id: None,
                evidence_seed: None,
                error_code: Some("DENIED_UNVERIFIABLE".to_string()),
            });
        }
    };

    if !frames::is_canonical_identifier(manager_staff_id) {
        return Ok(PrivilegedVerifyOutcomeDto {
            ok: false,
            verified_branch_id: None,
            evidence_seed: None,
            error_code: Some("DENIED_UNVERIFIABLE".to_string()),
        });
    }

    // 1. Device prerequisite
    let security_device_id_bytes = match security_device_id::resolve_or_create_security_device_id(root) {
        Ok(b) => b,
        Err(_) => {
            return Ok(PrivilegedVerifyOutcomeDto {
                ok: false,
                verified_branch_id: None,
                evidence_seed: None,
                error_code: Some("DENIED_UNVERIFIABLE".to_string()),
            });
        }
    };
    let device_id_hex: String = security_device_id_bytes.iter().map(|b| format!("{b:02x}")).collect();

    // 2. Resolve selected manager's active slot directly (no fallback)
    let active_slot_path = match super::manager_active_slot_path(root, manager_staff_id) {
        Ok(p) => p,
        Err(_) => {
            return Ok(PrivilegedVerifyOutcomeDto {
                ok: false,
                verified_branch_id: None,
                evidence_seed: None,
                error_code: Some("DENIED_UNVERIFIABLE".to_string()),
            });
        }
    };

    let content = match fs::read_to_string(&active_slot_path) {
        Ok(c) => c,
        Err(_) => {
            // Absent or unreadable => fail closed / reprovision required
            return Ok(PrivilegedVerifyOutcomeDto {
                ok: false,
                verified_branch_id: None,
                evidence_seed: None,
                error_code: Some("DENIED_UNVERIFIABLE".to_string()),
            });
        }
    };

    let oac: StoredOacEnvelope = match serde_json::from_str(&content) {
        Ok(env) => env,
        Err(_) => {
            // Malformed JSON => fail closed
            return Ok(PrivilegedVerifyOutcomeDto {
                ok: false,
                verified_branch_id: None,
                evidence_seed: None,
                error_code: Some("DENIED_UNVERIFIABLE".to_string()),
            });
        }
    };

    // 3. Strict schema validation
    if validate_stored_oac(&oac).is_err() {
        return Ok(PrivilegedVerifyOutcomeDto {
            ok: false,
            verified_branch_id: None,
            evidence_seed: None,
            error_code: Some("DENIED_UNVERIFIABLE".to_string()),
        });
    }

    // Embedded manager != requested manager => DENIED_UNVERIFIABLE
    if oac.manager_staff_id != manager_staff_id {
        return Ok(PrivilegedVerifyOutcomeDto {
            ok: false,
            verified_branch_id: None,
            evidence_seed: None,
            error_code: Some("DENIED_UNVERIFIABLE".to_string()),
        });
    }

    // 4. Cached OKS1 manifest verification
    let manifest_bytes = match fs::read(oks1_manifest_path(root)) {
        Ok(b) => b,
        Err(_) => {
            return Ok(PrivilegedVerifyOutcomeDto {
                ok: false,
                verified_branch_id: None,
                evidence_seed: None,
                error_code: Some("DENIED_UNVERIFIABLE".to_string()),
            });
        }
    };
    let manifest = match oac_keyset_frame::parse_and_verify_oac_keyset(&manifest_bytes) {
        Ok(m) => m,
        Err(_) => {
            return Ok(PrivilegedVerifyOutcomeDto {
                ok: false,
                verified_branch_id: None,
                evidence_seed: None,
                error_code: Some("DENIED_UNVERIFIABLE".to_string()),
            });
        }
    };

    // Signature verification against cached manifest
    if !verify_oac_signature(&oac, &manifest) {
        return Ok(PrivilegedVerifyOutcomeDto {
            ok: false,
            verified_branch_id: None,
            evidence_seed: None,
            error_code: Some("DENIED_UNVERIFIABLE".to_string()),
        });
    }

    // 5. Native device binding
    if oac.device_id.to_lowercase() != device_id_hex {
        return Ok(PrivilegedVerifyOutcomeDto {
            ok: false,
            verified_branch_id: None,
            evidence_seed: None,
            error_code: Some("DENIED_UNVERIFIABLE".to_string()),
        });
    }

    // 7. Action binding
    if !oac.allowed_actions.iter().any(|a| a == action_id) {
        return Ok(PrivilegedVerifyOutcomeDto {
            ok: false,
            verified_branch_id: None,
            evidence_seed: None,
            error_code: Some("MANAGER_NOT_AUTHORIZED".to_string()),
        });
    }

    // 8. Extract trusted branch
    let verified_branch_id = oac.branch_id.clone();

    // 9. Strict revocation epoch equality (R4)
    if oac.revocation_epoch != manifest.revocation_epoch {
        return Ok(PrivilegedVerifyOutcomeDto {
            ok: false,
            verified_branch_id: Some(verified_branch_id),
            evidence_seed: None,
            error_code: Some("DENIED_STALE".to_string()),
        });
    }

    // 10. Native clock sanity / rollback guard (R1, R5)
    let now_ms = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as u64,
        Err(_) => {
            return Ok(PrivilegedVerifyOutcomeDto {
                ok: false,
                verified_branch_id: Some(verified_branch_id),
                evidence_seed: None,
                error_code: Some("DENIED_UNVERIFIABLE".to_string()),
            });
        }
    };

    if clock_guard::assert_valid_and_advance_clock(root, now_ms).is_err() {
        return Ok(PrivilegedVerifyOutcomeDto {
            ok: false,
            verified_branch_id: Some(verified_branch_id),
            evidence_seed: None,
            error_code: Some("DENIED_UNVERIFIABLE".to_string()),
        });
    }

    // 11. OAC Freshness
    if now_ms < oac.issued_at_server_ms || now_ms > oac.freshness_expires_at_server_ms {
        return Ok(PrivilegedVerifyOutcomeDto {
            ok: false,
            verified_branch_id: Some(verified_branch_id),
            evidence_seed: None,
            error_code: Some("DENIED_STALE".to_string()),
        });
    }

    // 12. Cross-midnight UTC+7 check (R1)
    if clock_guard::is_cross_midnight_utc7(oac.issued_at_server_ms, now_ms) {
        return Ok(PrivilegedVerifyOutcomeDto {
            ok: false,
            verified_branch_id: Some(verified_branch_id),
            evidence_seed: None,
            error_code: Some("DENIED_STALE".to_string()),
        });
    }

    // 13. Lockout FSM check
    let lockout_check = match lockout_state::check_manager_lockout(root, manager_staff_id, now_ms) {
        Ok(c) => c,
        Err(_) => {
            return Ok(PrivilegedVerifyOutcomeDto {
                ok: false,
                verified_branch_id: Some(verified_branch_id),
                evidence_seed: None,
                error_code: Some("DENIED_UNVERIFIABLE".to_string()),
            });
        }
    };

    if let LockoutPrecheck::LockedOut { consecutive_failed_attempts, .. } = lockout_check {
        // Under lockout: do not compare PIN, do not increment attempt count
        let mut nonce_raw = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut nonce_raw);
        let digest = compute_approval_proof_digest(&oac.oac_id, &nonce_raw, "DENIED_LOCKED", &security_device_id_bytes);

        return Ok(PrivilegedVerifyOutcomeDto {
            ok: false,
            verified_branch_id: Some(verified_branch_id),
            evidence_seed: Some(PrivilegedEvidenceSeedDto {
                oac_id: oac.oac_id.clone(),
                oac_schema_version: oac.schema_version,
                revocation_epoch_at_issue: oac.revocation_epoch,
                manager_auth_version_at_issue: oac.auth_version_at_issue,
                manager_credential_version_at_issue: oac.credential_version_at_issue,
                nonce: base64_encode_std(&nonce_raw),
                attempt_count: consecutive_failed_attempts,
                approval_result: "DENIED_LOCKED".to_string(),
                approval_proof_digest: digest,
            }),
            error_code: Some("DENIED_LOCKED".to_string()),
        });
    }

    // 14. Exact PIN6 shape check
    let is_pin6 = pin.len() == 6 && pin.chars().all(|c| c.is_ascii_digit());

    // 15. Pepper commitment check
    let pepper = match pepper_store::resolve_or_create_pepper(root) {
        Ok(p) => p,
        Err(_) => {
            return Ok(PrivilegedVerifyOutcomeDto {
                ok: false,
                verified_branch_id: Some(verified_branch_id),
                evidence_seed: None,
                error_code: Some("DENIED_UNVERIFIABLE".to_string()),
            });
        }
    };
    let pepper_hash = Sha256::digest(pepper);
    let expected_pepper_b64 = base64_encode_std(&pepper_hash);
    if oac.pepper_commitment.trim() != expected_pepper_b64.trim() {
        return Ok(PrivilegedVerifyOutcomeDto {
            ok: false,
            verified_branch_id: Some(verified_branch_id),
            evidence_seed: None,
            error_code: Some("DENIED_UNVERIFIABLE".to_string()),
        });
    }

    // 16. Argon2 verify
    let salt = match base64_decode_std(&oac.verifier_salt) {
        Ok(s) if s.len() == 16 => s,
        _ => {
            return Ok(PrivilegedVerifyOutcomeDto {
                ok: false,
                verified_branch_id: Some(verified_branch_id),
                evidence_seed: None,
                error_code: Some("DENIED_UNVERIFIABLE".to_string()),
            });
        }
    };
    let expected_verifier = match base64_decode_std(&oac.verifier) {
        Ok(v) if v.len() == 32 => v,
        _ => {
            return Ok(PrivilegedVerifyOutcomeDto {
                ok: false,
                verified_branch_id: Some(verified_branch_id),
                evidence_seed: None,
                error_code: Some("DENIED_UNVERIFIABLE".to_string()),
            });
        }
    };

    let mut salt_arr = [0u8; 16];
    salt_arr.copy_from_slice(&salt);
    let mut verifier_arr = [0u8; 32];
    verifier_arr.copy_from_slice(&expected_verifier);

    let mut pin_bytes = pin.as_bytes().to_vec();
    let pin_match = if is_pin6 {
        argon2_kdf::verify_pin(&pin_bytes, &salt_arr, &pepper, &verifier_arr).unwrap_or(false)
    } else {
        false
    };
    pin_bytes.zeroize();

    // 17. Lockout transition
    let mut nonce_raw = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut nonce_raw);

    if pin_match {
        let _ = lockout_state::record_successful_pin_attempt(root, manager_staff_id, now_ms);
        let digest = compute_approval_proof_digest(&oac.oac_id, &nonce_raw, "APPROVED_LOCAL", &security_device_id_bytes);

        Ok(PrivilegedVerifyOutcomeDto {
            ok: true,
            verified_branch_id: Some(verified_branch_id),
            evidence_seed: Some(PrivilegedEvidenceSeedDto {
                oac_id: oac.oac_id.clone(),
                oac_schema_version: oac.schema_version,
                revocation_epoch_at_issue: oac.revocation_epoch,
                manager_auth_version_at_issue: oac.auth_version_at_issue,
                manager_credential_version_at_issue: oac.credential_version_at_issue,
                nonce: base64_encode_std(&nonce_raw),
                attempt_count: 0,
                approval_result: "APPROVED_LOCAL".to_string(),
                approval_proof_digest: digest,
            }),
            error_code: None,
        })
    } else {
        let updated = lockout_state::record_failed_pin_attempt(root, manager_staff_id, now_ms)
            .map_err(|e| e.to_string())?;

        let (result_str, err_code) = if updated.locked_out {
            ("DENIED_LOCKED", "DENIED_LOCKED")
        } else {
            ("DENIED_INVALID_PIN", "DENIED_INVALID_PIN")
        };

        let digest = compute_approval_proof_digest(&oac.oac_id, &nonce_raw, result_str, &security_device_id_bytes);

        Ok(PrivilegedVerifyOutcomeDto {
            ok: false,
            verified_branch_id: Some(verified_branch_id),
            evidence_seed: Some(PrivilegedEvidenceSeedDto {
                oac_id: oac.oac_id.clone(),
                oac_schema_version: oac.schema_version,
                revocation_epoch_at_issue: oac.revocation_epoch,
                manager_auth_version_at_issue: oac.auth_version_at_issue,
                manager_credential_version_at_issue: oac.credential_version_at_issue,
                nonce: base64_encode_std(&nonce_raw),
                attempt_count: updated.consecutive_failed_attempts,
                approval_result: result_str.to_string(),
                approval_proof_digest: digest,
            }),
            error_code: Some(err_code.to_string()),
        })
    }
}

/// Native offline lockout clear command (LCT1 verification and application).
/// Serialized by VERIFIER_MUTEX across the entire security-critical clear transaction.
pub fn clear_offline_lockout(
    root: &Path,
    lct1_bytes_base64: &str,
) -> Result<ClearLockoutOutcomeDto, String> {
    let _lifecycle_guard = match acquire_lifecycle_lock(root, 120_000) {
        Ok(g) => g,
        Err(_) => {
            return Ok(ClearLockoutOutcomeDto {
                ok: false,
                manager_staff_id: None,
                reopens_now: false,
                cooldown_remaining_ms: 0,
                error_code: Some("DENIED_UNVERIFIABLE".to_string()),
            });
        }
    };

    let _verifier_guard = match VERIFIER_MUTEX.lock() {
        Ok(g) => g,
        Err(_) => {
            return Ok(ClearLockoutOutcomeDto {
                ok: false,
                manager_staff_id: None,
                reopens_now: false,
                cooldown_remaining_ms: 0,
                error_code: Some("DENIED_UNVERIFIABLE".to_string()),
            });
        }
    };

    let lct1_bytes = match base64_decode_std(lct1_bytes_base64) {
        Ok(b) => b,
        Err(_) => {
            return Ok(ClearLockoutOutcomeDto {
                ok: false,
                manager_staff_id: None,
                reopens_now: false,
                cooldown_remaining_ms: 0,
                error_code: Some("invalid_request_shape".to_string()),
            });
        }
    };

    let lct1 = match frames::decode_lct1(&lct1_bytes) {
        Ok(f) => f,
        Err(_) => {
            return Ok(ClearLockoutOutcomeDto {
                ok: false,
                manager_staff_id: None,
                reopens_now: false,
                cooldown_remaining_ms: 0,
                error_code: Some("invalid_request_shape".to_string()),
            });
        }
    };

    if lct1.expires_at_server_ms <= lct1.issued_at_server_ms
        || lct1.expires_at_server_ms - lct1.issued_at_server_ms > frames::LOCKOUT_CLEAR_TOKEN_TTL_MS
    {
        return Ok(ClearLockoutOutcomeDto {
            ok: false,
            manager_staff_id: Some(lct1.manager_staff_id),
            reopens_now: false,
            cooldown_remaining_ms: 0,
            error_code: Some("DENIED_UNVERIFIABLE".to_string()),
        });
    }

    let security_device_id_bytes = match security_device_id::resolve_or_create_security_device_id(root) {
        Ok(b) => b,
        Err(_) => {
            return Ok(ClearLockoutOutcomeDto {
                ok: false,
                manager_staff_id: Some(lct1.manager_staff_id),
                reopens_now: false,
                cooldown_remaining_ms: 0,
                error_code: Some("DENIED_UNVERIFIABLE".to_string()),
            });
        }
    };

    if lct1.security_device_id != security_device_id_bytes {
        return Ok(ClearLockoutOutcomeDto {
            ok: false,
            manager_staff_id: Some(lct1.manager_staff_id),
            reopens_now: false,
            cooldown_remaining_ms: 0,
            error_code: Some("DENIED_UNVERIFIABLE".to_string()),
        });
    }

    let manifest_bytes = match fs::read(oks1_manifest_path(root)) {
        Ok(b) => b,
        Err(_) => {
            return Ok(ClearLockoutOutcomeDto {
                ok: false,
                manager_staff_id: Some(lct1.manager_staff_id),
                reopens_now: false,
                cooldown_remaining_ms: 0,
                error_code: Some("DENIED_UNVERIFIABLE".to_string()),
            });
        }
    };

    let manifest = match oac_keyset_frame::parse_and_verify_oac_keyset(&manifest_bytes) {
        Ok(m) => m,
        Err(_) => {
            return Ok(ClearLockoutOutcomeDto {
                ok: false,
                manager_staff_id: Some(lct1.manager_staff_id),
                reopens_now: false,
                cooldown_remaining_ms: 0,
                error_code: Some("DENIED_UNVERIFIABLE".to_string()),
            });
        }
    };

    let public_key_bytes = match oac_keyset_frame::find_signing_key(&manifest, &lct1.signing_key_id) {
        Some(k) => k,
        None => {
            return Ok(ClearLockoutOutcomeDto {
                ok: false,
                manager_staff_id: Some(lct1.manager_staff_id),
                reopens_now: false,
                cooldown_remaining_ms: 0,
                error_code: Some("DENIED_UNVERIFIABLE".to_string()),
            });
        }
    };

    let verifying_key = match VerifyingKey::from_bytes(public_key_bytes) {
        Ok(k) => k,
        Err(_) => {
            return Ok(ClearLockoutOutcomeDto {
                ok: false,
                manager_staff_id: Some(lct1.manager_staff_id),
                reopens_now: false,
                cooldown_remaining_ms: 0,
                error_code: Some("DENIED_UNVERIFIABLE".to_string()),
            });
        }
    };

    let payload = match frames::lct1_signed_prefix(&lct1) {
        Ok(p) => p,
        Err(_) => {
            return Ok(ClearLockoutOutcomeDto {
                ok: false,
                manager_staff_id: Some(lct1.manager_staff_id),
                reopens_now: false,
                cooldown_remaining_ms: 0,
                error_code: Some("DENIED_UNVERIFIABLE".to_string()),
            });
        }
    };

    let signature = Signature::from_bytes(&lct1.signature);
    if verifying_key.verify(&payload, &signature).is_err() {
        return Ok(ClearLockoutOutcomeDto {
            ok: false,
            manager_staff_id: Some(lct1.manager_staff_id),
            reopens_now: false,
            cooldown_remaining_ms: 0,
            error_code: Some("DENIED_UNVERIFIABLE".to_string()),
        });
    }

    let now_ms = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as u64,
        Err(_) => {
            return Ok(ClearLockoutOutcomeDto {
                ok: false,
                manager_staff_id: Some(lct1.manager_staff_id),
                reopens_now: false,
                cooldown_remaining_ms: 0,
                error_code: Some("DENIED_UNVERIFIABLE".to_string()),
            });
        }
    };

    if clock_guard::assert_valid_and_advance_clock(root, now_ms).is_err() {
        return Ok(ClearLockoutOutcomeDto {
            ok: false,
            manager_staff_id: Some(lct1.manager_staff_id),
            reopens_now: false,
            cooldown_remaining_ms: 0,
            error_code: Some("DENIED_UNVERIFIABLE".to_string()),
        });
    }

    if now_ms < lct1.issued_at_server_ms || now_ms > lct1.expires_at_server_ms {
        return Ok(ClearLockoutOutcomeDto {
            ok: false,
            manager_staff_id: Some(lct1.manager_staff_id),
            reopens_now: false,
            cooldown_remaining_ms: 0,
            error_code: Some("DENIED_STALE".to_string()),
        });
    }

    let record_res = match lockout_state::record_lockout_clear_token(
        root,
        &lct1.manager_staff_id,
        &lct1.lockout_id,
        now_ms,
    ) {
        Ok(r) => r,
        Err(lockout_state::LockoutError::LockoutIdMismatch) => {
            return Ok(ClearLockoutOutcomeDto {
                ok: false,
                manager_staff_id: Some(lct1.manager_staff_id),
                reopens_now: false,
                cooldown_remaining_ms: 0,
                error_code: Some("DENIED_UNVERIFIABLE".to_string()),
            });
        }
        Err(lockout_state::LockoutError::ManagerNotLockedOut) => {
            return Ok(ClearLockoutOutcomeDto {
                ok: false,
                manager_staff_id: Some(lct1.manager_staff_id),
                reopens_now: false,
                cooldown_remaining_ms: 0,
                error_code: Some("DENIED_UNVERIFIABLE".to_string()),
            });
        }
        Err(e) => return Err(e.to_string()),
    };

    Ok(ClearLockoutOutcomeDto {
        ok: true,
        manager_staff_id: Some(lct1.manager_staff_id),
        reopens_now: record_res.reopens_now,
        cooldown_remaining_ms: record_res.cooldown_remaining_ms,
        error_code: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Signer;
    use ed25519_dalek::SigningKey;

    fn temp_root() -> PathBuf {
        let n: u64 = rand::random();
        let path = std::env::temp_dir().join(format!("twinpet-verifier-test-{n}"));
        fs::create_dir_all(path.join("oac-store")).unwrap();
        path
    }

    #[test]
    fn deterministic_digest_test_vector() {
        let oac_id = "oac_001";
        let nonce_raw = [0x10u8; 32];
        let approval_result = "APPROVED_LOCAL";
        let device_id_raw = [0x20u8; 16];

        let digest = compute_approval_proof_digest(oac_id, &nonce_raw, approval_result, &device_id_raw);
        assert_eq!(digest, "a4e1afc190e14164b19f491f0399a1889ff2219a9c41ee30dbbe008b9b2bd23b");

        // Second calculation must match deterministically
        let digest2 = compute_approval_proof_digest(oac_id, &nonce_raw, approval_result, &device_id_raw);
        assert_eq!(digest, digest2);
    }

    #[test]
    fn base64_std_encodes_and_decodes() {
        let bytes = b"test payload 123";
        let encoded = base64_encode_std(bytes);
        let decoded = base64_decode_std(&encoded).unwrap();
        assert_eq!(decoded, bytes.to_vec());
    }

    fn setup_test_terminal(root: &Path, epoch: u32) -> (SigningKey, String) {
        let sec_dev_id = security_device_id::resolve_or_create_security_device_id(root).unwrap();
        let sec_dev_id_hex: String = sec_dev_id.iter().map(|b| format!("{b:02x}")).collect();

        let mut csprng = rand::rngs::OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        let manifest_frame = frames::OacKeysetManifestFrameV1 {
            revocation_epoch: epoch,
            generated_at_server_ms: 1_700_000_000_000,
            keys: vec![frames::OacKeysetManifestKeyV1 {
                signing_key_id: "test-signing-key".to_string(),
                public_key: signing_key.verifying_key().to_bytes(),
            }],
            signature: [0u8; 64],
        };
        let unsigned_prefix = frames::oks1_signed_prefix(&manifest_frame).unwrap();
        let manifest_sig = signing_key.sign(&unsigned_prefix);
        let mut signed_manifest = manifest_frame;
        signed_manifest.signature = manifest_sig.to_bytes();
        let encoded_manifest = frames::encode_oks1(&signed_manifest).unwrap();
        fs::write(oks1_manifest_path(root), encoded_manifest).unwrap();

        (signing_key, sec_dev_id_hex)
    }

    fn provision_test_oac(
        root: &Path,
        signing_key: &SigningKey,
        manager_staff_id: &str,
        branch_id: &str,
        device_id_hex: &str,
        pin: &str,
        epoch: u32,
        issued_at_server_ms: u64,
        freshness_expires_at_server_ms: u64,
        allowed_actions: Vec<&str>,
    ) -> String {
        let pepper = pepper_store::resolve_or_create_pepper(root).unwrap();
        let mut salt = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut salt);
        let verifier = argon2_kdf::derive_verifier(pin.as_bytes(), &salt, &pepper).unwrap();
        let pepper_hash = Sha256::digest(pepper);

        let oac_id = format!("oac-{}", rand::random::<u32>());
        let allowed_vec: Vec<String> = allowed_actions.into_iter().map(String::from).collect();

        let mut map = serde_json::Map::new();
        map.insert("allowedActions".to_string(), serde_json::to_value(&allowed_vec).unwrap());
        map.insert("authVersionAtIssue".to_string(), serde_json::json!(1));
        map.insert("branchId".to_string(), serde_json::json!(branch_id));
        map.insert("credentialVersionAtIssue".to_string(), serde_json::json!(1));
        map.insert("deviceId".to_string(), serde_json::json!(device_id_hex));
        map.insert("freshnessExpiresAtServerMs".to_string(), serde_json::json!(freshness_expires_at_server_ms));
        map.insert("issuedAtServerMs".to_string(), serde_json::json!(issued_at_server_ms));
        map.insert("managerRole".to_string(), serde_json::json!("manager"));
        map.insert("managerStaffId".to_string(), serde_json::json!(manager_staff_id));
        map.insert("oacId".to_string(), serde_json::json!(oac_id));
        map.insert("pepperCommitment".to_string(), serde_json::json!(base64_encode_std(&pepper_hash)));
        map.insert("revocationEpoch".to_string(), serde_json::json!(epoch));
        map.insert("schemaVersion".to_string(), serde_json::json!(1));
        map.insert("signingKeyId".to_string(), serde_json::json!("test-signing-key"));
        map.insert("verifier".to_string(), serde_json::json!(base64_encode_std(&verifier)));
        map.insert("verifierAlgo".to_string(), serde_json::json!("argon2id"));
        map.insert("verifierParams".to_string(), serde_json::json!({"m": 65536, "t": 3, "p": 1, "saltLen": 16, "hashLen": 32}));
        map.insert("verifierSalt".to_string(), serde_json::json!(base64_encode_std(&salt)));

        let canonical = canonical_json(&serde_json::Value::Object(map.clone()));
        let sig = signing_key.sign(canonical.as_bytes());
        map.insert("signature".to_string(), serde_json::json!(base64_encode_std(&sig.to_bytes())));

        let full_json = serde_json::to_string(&serde_json::Value::Object(map)).unwrap();
        fs::write(oac_store_dir(root).join(format!("{oac_id}.json")), &full_json).unwrap();
        let active_slot = super::super::manager_active_slot_path(root, manager_staff_id).unwrap();
        if let Some(p) = active_slot.parent() {
            fs::create_dir_all(p).unwrap();
        }
        fs::write(&active_slot, &full_json).unwrap();

        oac_id
    }

    #[test]
    fn test_valid_oac_correct_pin_approves_local() {
        let root = temp_root();
        let (signing_key, device_id_hex) = setup_test_terminal(&root, 1);
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;

        provision_test_oac(
            &root,
            &signing_key,
            "mgr-1",
            "B01",
            &device_id_hex,
            "123456",
            1,
            now_ms - 1000,
            now_ms + 3_600_000,
            vec!["VOID_PENDING_SALE"],
        );

        let res = verify_offline_pin(&root, "mgr-1", "VOID_PENDING_SALE", "123456").unwrap();
        assert!(res.ok);
        assert_eq!(res.verified_branch_id, Some("B01".to_string()));
        assert!(res.error_code.is_none());

        let seed = res.evidence_seed.unwrap();
        assert_eq!(seed.approval_result, "APPROVED_LOCAL");
        assert_eq!(seed.attempt_count, 0);
        assert_eq!(seed.approval_proof_digest.len(), 64);
        assert_eq!(seed.revocation_epoch_at_issue, 1);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_wrong_pin_and_lockout_progression() {
        let root = temp_root();
        let (signing_key, device_id_hex) = setup_test_terminal(&root, 1);
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;

        provision_test_oac(
            &root,
            &signing_key,
            "mgr-1",
            "B01",
            &device_id_hex,
            "123456",
            1,
            now_ms - 1000,
            now_ms + 3_600_000,
            vec!["VOID_PENDING_SALE"],
        );

        for attempt in 1..=4 {
            let res = verify_offline_pin(&root, "mgr-1", "VOID_PENDING_SALE", "000000").unwrap();
            assert!(!res.ok);
            assert_eq!(res.error_code, Some("DENIED_INVALID_PIN".to_string()));
            let seed = res.evidence_seed.unwrap();
            assert_eq!(seed.approval_result, "DENIED_INVALID_PIN");
            assert_eq!(seed.attempt_count, attempt);
        }

        // 5th attempt locks out
        let res5 = verify_offline_pin(&root, "mgr-1", "VOID_PENDING_SALE", "000000").unwrap();
        assert!(!res5.ok);
        assert_eq!(res5.error_code, Some("DENIED_LOCKED".to_string()));
        let seed5 = res5.evidence_seed.unwrap();
        assert_eq!(seed5.approval_result, "DENIED_LOCKED");
        assert_eq!(seed5.attempt_count, 5);

        // 6th attempt stays locked without increment
        let res6 = verify_offline_pin(&root, "mgr-1", "VOID_PENDING_SALE", "000000").unwrap();
        assert!(!res6.ok);
        assert_eq!(res6.error_code, Some("DENIED_LOCKED".to_string()));
        let seed6 = res6.evidence_seed.unwrap();
        assert_eq!(seed6.attempt_count, 5);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_unauthorized_action_fails_closed() {
        let root = temp_root();
        let (signing_key, device_id_hex) = setup_test_terminal(&root, 1);
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;

        provision_test_oac(
            &root,
            &signing_key,
            "mgr-1",
            "B01",
            &device_id_hex,
            "123456",
            1,
            now_ms - 1000,
            now_ms + 3_600_000,
            vec!["VOID_PENDING_SALE"],
        );

        let res = verify_offline_pin(&root, "mgr-1", "VOID_SETTLED_SALE", "123456").unwrap();
        assert!(!res.ok);
        assert_eq!(res.error_code, Some("MANAGER_NOT_AUTHORIZED".to_string()));
        assert!(res.evidence_seed.is_none());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_revocation_epoch_strict_equality() {
        let root = temp_root();
        let (signing_key, device_id_hex) = setup_test_terminal(&root, 2); // Manifest is epoch 2
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;

        // OAC issued under epoch 1 (stale/revoked)
        provision_test_oac(
            &root,
            &signing_key,
            "mgr-1",
            "B01",
            &device_id_hex,
            "123456",
            1,
            now_ms - 1000,
            now_ms + 3_600_000,
            vec!["VOID_PENDING_SALE"],
        );

        let res = verify_offline_pin(&root, "mgr-1", "VOID_PENDING_SALE", "123456").unwrap();
        assert!(!res.ok);
        assert_eq!(res.error_code, Some("DENIED_STALE".to_string()));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_deterministic_newest_selection_no_fallback() {
        let root = temp_root();
        let (signing_key, device_id_hex) = setup_test_terminal(&root, 2);
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;

        // Older OAC (epoch 2, matching manifest, but older timestamp)
        provision_test_oac(
            &root,
            &signing_key,
            "mgr-1",
            "B01",
            &device_id_hex,
            "123456",
            2,
            now_ms - 20_000,
            now_ms + 3_600_000,
            vec!["VOID_PENDING_SALE"],
        );

        // Newer OAC (epoch 1, revoked, newer timestamp)
        provision_test_oac(
            &root,
            &signing_key,
            "mgr-1",
            "B01",
            &device_id_hex,
            "123456",
            1,
            now_ms - 5_000,
            now_ms + 3_600_000,
            vec!["VOID_PENDING_SALE"],
        );

        // Must pick newest OAC (epoch 1) and reject with DENIED_STALE, NO fallback to older OAC
        let res = verify_offline_pin(&root, "mgr-1", "VOID_PENDING_SALE", "123456").unwrap();
        assert!(!res.ok);
        assert_eq!(res.error_code, Some("DENIED_STALE".to_string()));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_clear_offline_lockout_happy_path() {
        let root = temp_root();
        let (signing_key, device_id_hex) = setup_test_terminal(&root, 1);
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;

        provision_test_oac(
            &root,
            &signing_key,
            "mgr-1",
            "B01",
            &device_id_hex,
            "123456",
            1,
            now_ms - 1000,
            now_ms + 3_600_000,
            vec!["VOID_PENDING_SALE"],
        );

        // Fail 5 times to trigger lockout
        for _ in 1..=5 {
            let _ = verify_offline_pin(&root, "mgr-1", "VOID_PENDING_SALE", "000000").unwrap();
        }

        let pre_res = verify_offline_pin(&root, "mgr-1", "VOID_PENDING_SALE", "123456").unwrap();
        assert!(!pre_res.ok);
        assert_eq!(pre_res.error_code, Some("DENIED_LOCKED".to_string()));

        // Get current lockoutId from store
        let store = lockout_state::read_lockout_store(&root).unwrap();
        let entry = store.managers.get("mgr-1").unwrap();
        let lockout_id_hex = entry.current_lockout_id_hex.as_ref().unwrap();
        let mut lockout_id = [0u8; 32];
        for i in 0..32 {
            lockout_id[i] = u8::from_str_radix(&lockout_id_hex[i * 2..i * 2 + 2], 16).unwrap();
        }

        let sec_dev_id = security_device_id::resolve_or_create_security_device_id(&root).unwrap();

        // Mint LCT1 frame
        let lct1_frame = frames::LockoutClearTokenFrameV1 {
            security_device_id: sec_dev_id,
            manager_staff_id: "mgr-1".to_string(),
            lockout_id,
            issued_at_server_ms: now_ms - 500,
            expires_at_server_ms: now_ms - 500 + 900_000,
            token_nonce: [0x55u8; 32],
            signing_key_id: "test-signing-key".to_string(),
            signature: [0u8; 64],
        };
        let unsigned_prefix = frames::lct1_signed_prefix(&lct1_frame).unwrap();
        let sig = signing_key.sign(&unsigned_prefix);
        let mut signed_lct1 = lct1_frame;
        signed_lct1.signature = sig.to_bytes();
        let encoded_lct1 = frames::encode_lct1(&signed_lct1).unwrap();
        let lct1_b64 = base64_encode_std(&encoded_lct1);

        // Clear offline lockout
        let clear_res = clear_offline_lockout(&root, &lct1_b64).unwrap();
        assert!(clear_res.ok);
        assert_eq!(clear_res.manager_staff_id, Some("mgr-1".to_string()));
        assert!(!clear_res.reopens_now); // 15m hasn't elapsed yet
        assert!(clear_res.cooldown_remaining_ms > 0);

        // Store now has clear_token_recorded == true
        let store_after = lockout_state::read_lockout_store(&root).unwrap();
        assert!(store_after.managers.get("mgr-1").unwrap().clear_token_recorded);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_concurrent_wrong_pin_attempts_do_not_lose_increments() {
        let root = temp_root();
        let (signing_key, device_id_hex) = setup_test_terminal(&root, 1);
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;

        provision_test_oac(
            &root,
            &signing_key,
            "mgr-conc",
            "B01",
            &device_id_hex,
            "123456",
            1,
            now_ms - 1000,
            now_ms + 3_600_000,
            vec!["VOID_PENDING_SALE"],
        );

        let root_arc = std::sync::Arc::new(root);
        let mut handles = Vec::new();

        // 5 concurrent wrong PIN attempts
        for _ in 0..5 {
            let r = std::sync::Arc::clone(&root_arc);
            handles.push(std::thread::spawn(move || {
                verify_offline_pin(&r, "mgr-conc", "VOID_PENDING_SALE", "000000")
            }));
        }

        let mut results = Vec::new();
        for h in handles {
            results.push(h.join().unwrap().unwrap());
        }

        assert!(results.iter().all(|res| !res.ok));

        // The store must now be locked out at exactly attempt 5
        let store = lockout_state::read_lockout_store(&root_arc).unwrap();
        let entry = store.managers.get("mgr-conc").unwrap();
        assert_eq!(entry.consecutive_failed_attempts, 5);
        assert!(entry.locked_out);
        assert!(entry.current_lockout_id_hex.is_some());

        let _ = fs::remove_dir_all(&*root_arc);
    }

    #[test]
    fn test_simultaneous_attempt_5_cannot_produce_conflicting_generations() {
        let root = temp_root();
        let (signing_key, device_id_hex) = setup_test_terminal(&root, 1);
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;

        provision_test_oac(
            &root,
            &signing_key,
            "mgr-5",
            "B01",
            &device_id_hex,
            "123456",
            1,
            now_ms - 1000,
            now_ms + 3_600_000,
            vec!["VOID_PENDING_SALE"],
        );

        // Advance to 4 attempts first
        for _ in 1..=4 {
            let _ = verify_offline_pin(&root, "mgr-5", "VOID_PENDING_SALE", "000000");
        }

        let root_arc = std::sync::Arc::new(root);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));

        let mut handles = Vec::new();
        for _ in 0..2 {
            let r = std::sync::Arc::clone(&root_arc);
            let b = std::sync::Arc::clone(&barrier);
            handles.push(std::thread::spawn(move || {
                b.wait();
                verify_offline_pin(&r, "mgr-5", "VOID_PENDING_SALE", "000000")
            }));
        }

        let mut seeds = Vec::new();
        for h in handles {
            let res = h.join().unwrap().unwrap();
            assert!(!res.ok);
            assert_eq!(res.error_code, Some("DENIED_LOCKED".to_string()));
            if let Some(seed) = res.evidence_seed {
                seeds.push(seed);
            }
        }

        // Both observed DENIED_LOCKED
        assert_eq!(seeds.len(), 2);
        assert_eq!(seeds[0].approval_result, "DENIED_LOCKED");
        assert_eq!(seeds[1].approval_result, "DENIED_LOCKED");

        // Exactly one generation in store
        let store = lockout_state::read_lockout_store(&root_arc).unwrap();
        let entry = store.managers.get("mgr-5").unwrap();
        assert_eq!(entry.consecutive_failed_attempts, 5);
        assert!(entry.locked_out);

        let _ = fs::remove_dir_all(&*root_arc);
    }

    #[test]
    fn test_clear_vs_verify_race_cannot_reopen_incorrectly() {
        let root = temp_root();
        let (signing_key, device_id_hex) = setup_test_terminal(&root, 1);
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;

        provision_test_oac(
            &root,
            &signing_key,
            "mgr-cv",
            "B01",
            &device_id_hex,
            "123456",
            1,
            now_ms - 1000,
            now_ms + 3_600_000,
            vec!["VOID_PENDING_SALE"],
        );

        // Lock out
        for _ in 1..=5 {
            let _ = verify_offline_pin(&root, "mgr-cv", "VOID_PENDING_SALE", "000000");
        }

        let store = lockout_state::read_lockout_store(&root).unwrap();
        let lockout_id_hex = store.managers.get("mgr-cv").unwrap().current_lockout_id_hex.clone().unwrap();
        let mut lockout_id = [0u8; 32];
        for i in 0..32 {
            lockout_id[i] = u8::from_str_radix(&lockout_id_hex[i * 2..i * 2 + 2], 16).unwrap();
        }
        let sec_dev_id = security_device_id::resolve_or_create_security_device_id(&root).unwrap();

        let lct1_frame = frames::LockoutClearTokenFrameV1 {
            security_device_id: sec_dev_id,
            manager_staff_id: "mgr-cv".to_string(),
            lockout_id,
            issued_at_server_ms: now_ms - 500,
            expires_at_server_ms: now_ms - 500 + 900_000,
            token_nonce: [0x55u8; 32],
            signing_key_id: "test-signing-key".to_string(),
            signature: [0u8; 64],
        };
        let prefix = frames::lct1_signed_prefix(&lct1_frame).unwrap();
        let sig = signing_key.sign(&prefix);
        let mut signed = lct1_frame;
        signed.signature = sig.to_bytes();
        let lct1_b64 = base64_encode_std(&frames::encode_lct1(&signed).unwrap());

        let root_arc = std::sync::Arc::new(root);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));

        let r1 = std::sync::Arc::clone(&root_arc);
        let b1 = std::sync::Arc::clone(&barrier);
        let tok = lct1_b64.clone();
        let h_clear = std::thread::spawn(move || {
            b1.wait();
            clear_offline_lockout(&r1, &tok)
        });

        let r2 = std::sync::Arc::clone(&root_arc);
        let b2 = std::sync::Arc::clone(&barrier);
        let h_verify = std::thread::spawn(move || {
            b2.wait();
            verify_offline_pin(&r2, "mgr-cv", "VOID_PENDING_SALE", "123456")
        });

        let clear_res = h_clear.join().unwrap().unwrap();
        let verify_res = h_verify.join().unwrap().unwrap();

        assert!(clear_res.ok);
        // Verify outcome must be consistent (DENIED_LOCKED since 15m cooldown has not elapsed)
        assert!(!verify_res.ok);
        assert_eq!(verify_res.error_code, Some("DENIED_LOCKED".to_string()));

        let _ = fs::remove_dir_all(&*root_arc);
    }

    #[test]
    fn test_no_deadlock_under_repeated_verify_clear() {
        let root = temp_root();
        let (signing_key, device_id_hex) = setup_test_terminal(&root, 1);
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;

        provision_test_oac(
            &root,
            &signing_key,
            "mgr-loop",
            "B01",
            &device_id_hex,
            "123456",
            1,
            now_ms - 1000,
            now_ms + 3_600_000,
            vec!["VOID_PENDING_SALE"],
        );

        let root_arc = std::sync::Arc::new(root);
        let mut handles = Vec::new();

        for _ in 0..8 {
            let r = std::sync::Arc::clone(&root_arc);
            handles.push(std::thread::spawn(move || {
                for _ in 0..10 {
                    let _ = verify_offline_pin(&r, "mgr-loop", "VOID_PENDING_SALE", "000000");
                    let _ = clear_offline_lockout(&r, "invalid-token");
                }
            }));
        }

        for h in handles {
            h.join().unwrap();
        }

        let _ = fs::remove_dir_all(&*root_arc);
    }

    #[test]
    fn test_strict_oac_schema_rejects_malformed_and_unknown_fields() {
        let root = temp_root();
        let (_signing_key, device_id_hex) = setup_test_terminal(&root, 1);

        // 1. Unknown extra field in OAC JSON (rejected by deny_unknown_fields)
        let json_with_extra = serde_json::json!({
            "oacId": "oac-1",
            "schemaVersion": 1,
            "managerStaffId": "mgr-1",
            "managerRole": "manager",
            "branchId": "B01",
            "deviceId": device_id_hex,
            "allowedActions": ["VOID_PENDING_SALE"],
            "authVersionAtIssue": 1,
            "credentialVersionAtIssue": 1,
            "revocationEpoch": 1,
            "issuedAtServerMs": 1_700_000_000_000u64,
            "freshnessExpiresAtServerMs": 1_700_003_600_000u64,
            "verifierAlgo": "argon2id",
            "verifierParams": {"m": 65536, "t": 3, "p": 1, "saltLen": 16, "hashLen": 32},
            "verifierSalt": base64_encode_std(&[0u8; 16]),
            "verifier": base64_encode_std(&[0u8; 32]),
            "pepperCommitment": base64_encode_std(&[0u8; 32]),
            "signingKeyId": "test-key",
            "signature": base64_encode_std(&[0u8; 64]),
            "unauthorizedField": "forbidden"
        });

        let parsed: Result<StoredOacEnvelope, _> = serde_json::from_value(json_with_extra);
        assert!(parsed.is_err());

        // 2. verifierParams mismatch (m = 1024 instead of 65536)
        let mut valid_envelope = StoredOacEnvelope {
            oac_id: "oac-1".to_string(),
            schema_version: 1,
            manager_staff_id: "mgr-1".to_string(),
            manager_role: "manager".to_string(),
            branch_id: "B01".to_string(),
            device_id: device_id_hex.clone(),
            allowed_actions: vec!["VOID_PENDING_SALE".to_string()],
            auth_version_at_issue: 1,
            credential_version_at_issue: 1,
            revocation_epoch: 1,
            issued_at_server_ms: 1_700_000_000_000,
            freshness_expires_at_server_ms: 1_700_003_600_000,
            verifier_algo: "argon2id".to_string(),
            verifier_params: OacVerifierParamsDto { m: 1024, t: 3, p: 1, salt_len: 16, hash_len: 32 },
            verifier_salt: base64_encode_std(&[0u8; 16]),
            verifier: base64_encode_std(&[0u8; 32]),
            pepper_commitment: base64_encode_std(&[0u8; 32]),
            signing_key_id: "test-key".to_string(),
            signature: base64_encode_std(&[0u8; 64]),
        };
        assert!(validate_stored_oac(&valid_envelope).is_err());

        // 3. branchId == "ALL" (forbidden)
        valid_envelope.verifier_params.m = 65536;
        valid_envelope.branch_id = "ALL".to_string();
        assert!(validate_stored_oac(&valid_envelope).is_err());

        // 4. Duplicate allowedActions
        valid_envelope.branch_id = "B01".to_string();
        valid_envelope.allowed_actions = vec!["VOID_PENDING_SALE".to_string(), "VOID_PENDING_SALE".to_string()];
        assert!(validate_stored_oac(&valid_envelope).is_err());

        // 5. Invalid manager role
        valid_envelope.allowed_actions = vec!["VOID_PENDING_SALE".to_string()];
        valid_envelope.manager_role = "cashier".to_string();
        assert!(validate_stored_oac(&valid_envelope).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "camelCase")]
    struct HelperVerifyAttemptResult {
        ok: bool,
        approval_result: Option<String>,
        attempt_count: u32,
        locked_out: bool,
        error_code: Option<String>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "camelCase")]
    struct HelperResultPayload {
        protocol_version: String,
        op: String,
        status: String,
        result_code: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        approval_result: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        attempt_count: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        locked_out: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        lockout_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        clear_token_recorded: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error_code: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        attempts: Option<Vec<HelperVerifyAttemptResult>>,
    }

    const HELPER_RESULT_PREFIX: &str = "TWINPET_HELPER_RESULT=";
    const HELPER_READY_PREFIX: &str = "TWINPET_HELPER_READY=";

    fn wait_barrier_if_requested(op: &str) {
        if std::env::var("TWINPET_TWO_PROC_BARRIER").as_deref() == Ok("1") {
            use std::io::{BufRead, Write};
            println!("{HELPER_READY_PREFIX}{op}");
            std::io::stdout().flush().expect("flush ready marker");
            let mut line = String::new();
            let stdin = std::io::stdin();
            let mut handle = stdin.lock();
            handle.read_line(&mut line).expect("read GO signal from parent stdin");
            if line.trim() != "GO" {
                panic!("helper expected GO signal, got: {line:?}");
            }
        }
    }

    fn emit_helper_result(payload: &HelperResultPayload) {
        use std::io::Write;
        let json = serde_json::to_string(payload).expect("serialize helper result payload");
        println!("{HELPER_RESULT_PREFIX}{json}");
        std::io::stdout().flush().expect("flush helper result");
    }

    fn parse_single_helper_marker(stdout: &str, expected_op: &str) -> HelperResultPayload {
        let markers: Vec<&str> = stdout
            .lines()
            .map(|l| l.trim())
            .filter(|l| l.starts_with(HELPER_RESULT_PREFIX))
            .collect();

        assert_eq!(
            markers.len(),
            1,
            "child process must emit exactly one result marker; found: {}. Output:\n{stdout}",
            markers.len()
        );

        let json_str = &markers[0][HELPER_RESULT_PREFIX.len()..];
        let payload: HelperResultPayload = serde_json::from_str(json_str)
            .unwrap_or_else(|e| panic!("failed to parse helper JSON marker '{json_str}': {e}"));

        assert_eq!(payload.protocol_version, "1.0", "helper protocolVersion must be 1.0");
        assert_eq!(payload.op, expected_op, "helper op must match expected action");

        payload
    }

    fn spawn_helper_output(mode: &str, root: &Path, envs: &[(&str, &str)]) -> HelperResultPayload {
        let exe = std::env::current_exe().expect("current_exe");
        let mut cmd = std::process::Command::new(exe);
        cmd.arg("privileged_auth::offline_verifier::tests::two_process_helper_runner");
        cmd.arg("--exact");
        cmd.arg("--nocapture");
        cmd.env("TWINPET_TWO_PROC_MODE", mode);
        cmd.env("TWINPET_TWO_PROC_ROOT", root.to_str().unwrap());
        for (k, v) in envs {
            cmd.env(k, v);
        }
        let output = cmd.output().expect("failed to execute child process");
        assert_eq!(
            output.status.code(),
            Some(0),
            "child helper process must exit with 0, got {:?}. Stderr:\n{}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout_str = String::from_utf8_lossy(&output.stdout);
        parse_single_helper_marker(&stdout_str, mode)
    }

    struct BarrierChildHelper {
        child: std::process::Child,
        stdout_reader: std::io::BufReader<std::process::ChildStdout>,
        expected_op: String,
    }

    impl BarrierChildHelper {
        fn spawn(mode: &str, root: &Path, envs: &[(&str, &str)]) -> Self {
            use std::io::BufRead;
            let exe = std::env::current_exe().expect("current_exe");
            let mut cmd = std::process::Command::new(exe);
            cmd.arg("privileged_auth::offline_verifier::tests::two_process_helper_runner");
            cmd.arg("--exact");
            cmd.arg("--nocapture");
            cmd.stdin(std::process::Stdio::piped());
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());
            cmd.env("TWINPET_TWO_PROC_MODE", mode);
            cmd.env("TWINPET_TWO_PROC_ROOT", root.to_str().unwrap());
            cmd.env("TWINPET_TWO_PROC_BARRIER", "1");
            for (k, v) in envs {
                cmd.env(k, v);
            }
            let mut child = cmd.spawn().expect("failed to spawn barrier child helper");
            let mut stdout_reader = std::io::BufReader::new(child.stdout.take().expect("take stdout"));
            let ready_line = loop {
                let mut line = String::new();
                let bytes_read = stdout_reader.read_line(&mut line).expect("read line from child");
                if bytes_read == 0 {
                    panic!("child helper terminated without emitting READY marker");
                }
                if line.trim().starts_with(HELPER_READY_PREFIX) {
                    break line;
                }
            };
            let expected_ready = format!("{HELPER_READY_PREFIX}{mode}");
            assert_eq!(
                ready_line.trim(),
                expected_ready,
                "child helper did not report expected READY marker; got: {:?}",
                ready_line.trim()
            );
            Self {
                child,
                stdout_reader,
                expected_op: mode.to_string(),
            }
        }

        fn signal_go(&mut self) {
            use std::io::Write;
            let mut stdin = self.child.stdin.take().expect("take child stdin");
            stdin.write_all(b"GO\n").expect("write GO to child stdin");
            stdin.flush().expect("flush child stdin");
        }

        fn wait_result(mut self) -> HelperResultPayload {
            use std::io::Read;
            let mut remaining_stdout = String::new();
            self.stdout_reader
                .read_to_string(&mut remaining_stdout)
                .expect("read remaining child stdout");
            let status = self.child.wait().expect("wait on child process");
            assert_eq!(
                status.code(),
                Some(0),
                "child process must exit with 0, got {:?}",
                status.code()
            );
            parse_single_helper_marker(&remaining_stdout, &self.expected_op)
        }
    }

    #[test]
    fn two_process_helper_runner() {
        let mode = match std::env::var("TWINPET_TWO_PROC_MODE") {
            Ok(m) => m,
            Err(_) => return, // Normal cargo test run
        };
        let root_str = std::env::var("TWINPET_TWO_PROC_ROOT").expect("TWINPET_TWO_PROC_ROOT");
        let root = PathBuf::from(root_str);

        match mode.as_str() {
            "TRY_LOCK" => {
                let timeout_ms: u64 = std::env::var("TWINPET_TWO_PROC_TIMEOUT_MS")
                    .ok()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(200);
                wait_barrier_if_requested("TRY_LOCK");
                let result_code = match acquire_lifecycle_lock(&root, timeout_ms) {
                    Ok(_g) => {
                        let hold_ms: u64 = std::env::var("TWINPET_TWO_PROC_HOLD_MS")
                            .ok()
                            .and_then(|s| s.parse().ok())
                            .unwrap_or(0);
                        if hold_ms > 0 {
                            std::thread::sleep(std::time::Duration::from_millis(hold_ms));
                        }
                        "LOCK_ACQUIRED"
                    }
                    Err(_) => "LOCK_UNAVAILABLE",
                };
                emit_helper_result(&HelperResultPayload {
                    protocol_version: "1.0".to_string(),
                    op: "TRY_LOCK".to_string(),
                    status: "OK".to_string(),
                    result_code: result_code.to_string(),
                    approval_result: None,
                    attempt_count: None,
                    locked_out: None,
                    lockout_id: None,
                    clear_token_recorded: None,
                    error_code: None,
                    attempts: None,
                });
                std::process::exit(0);
            }
            "ATTEMPT_VERIFY" => {
                let mgr = std::env::var("TWINPET_TWO_PROC_MGR").unwrap_or_else(|_| "mgr-cross".to_string());
                let action = std::env::var("TWINPET_TWO_PROC_ACTION").unwrap_or_else(|_| "VOID_PENDING_SALE".to_string());
                let pin = std::env::var("TWINPET_TWO_PROC_PIN").unwrap_or_else(|_| "000000".to_string());
                let count: u32 = std::env::var("TWINPET_TWO_PROC_COUNT")
                    .ok()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(1);

                wait_barrier_if_requested("ATTEMPT_VERIFY");

                let mut attempt_results = Vec::new();
                let mut last_approval_result = None;
                let mut last_error_code = None;

                for _ in 0..count {
                    let outcome = verify_offline_pin(&root, &mgr, &action, &pin)
                        .expect("verify_offline_pin returned Err string");
                    let app_res = outcome.evidence_seed.as_ref().map(|s| s.approval_result.clone());
                    let att_cnt = outcome.evidence_seed.as_ref().map(|s| s.attempt_count).unwrap_or(0);
                    last_approval_result = app_res.clone();
                    last_error_code = outcome.error_code.clone();
                    attempt_results.push(HelperVerifyAttemptResult {
                        ok: outcome.ok,
                        approval_result: app_res,
                        attempt_count: att_cnt,
                        locked_out: outcome.error_code.as_deref() == Some("DENIED_LOCKED"),
                        error_code: outcome.error_code,
                    });
                }

                let store = lockout_state::read_lockout_store(&root).ok();
                let mgr_entry = store.as_ref().and_then(|s| s.managers.get(&mgr));
                let (durable_attempts, durable_locked_out, durable_lockout_id) = match mgr_entry {
                    Some(e) => (Some(e.consecutive_failed_attempts), Some(e.locked_out), e.current_lockout_id_hex.clone()),
                    None => (None, None, None),
                };

                emit_helper_result(&HelperResultPayload {
                    protocol_version: "1.0".to_string(),
                    op: "ATTEMPT_VERIFY".to_string(),
                    status: "OK".to_string(),
                    result_code: "VERIFY_COMPLETED".to_string(),
                    approval_result: last_approval_result,
                    attempt_count: durable_attempts,
                    locked_out: durable_locked_out,
                    lockout_id: durable_lockout_id,
                    clear_token_recorded: None,
                    error_code: last_error_code,
                    attempts: Some(attempt_results),
                });
                std::process::exit(0);
            }
            "CLEAR_LOCKOUT" => {
                let token_b64 = std::env::var("TWINPET_TWO_PROC_TOKEN").expect("token required");
                let mgr = std::env::var("TWINPET_TWO_PROC_MGR").unwrap_or_else(|_| "mgr-cvp".to_string());

                wait_barrier_if_requested("CLEAR_LOCKOUT");

                let res = clear_offline_lockout(&root, &token_b64);
                let (result_code, err_code) = match &res {
                    Ok(dto) => {
                        if dto.ok {
                            ("CLEAR_ACCEPTED", None)
                        } else {
                            ("CLEAR_DENIED", dto.error_code.clone())
                        }
                    }
                    Err(e) => ("CLEAR_ERROR", Some(e.clone())),
                };

                let store = lockout_state::read_lockout_store(&root).ok();
                let mgr_entry = store.as_ref().and_then(|s| s.managers.get(&mgr));
                let (clear_recorded, locked_out, lockout_id) = match mgr_entry {
                    Some(e) => (Some(e.clear_token_recorded), Some(e.locked_out), e.current_lockout_id_hex.clone()),
                    None => (None, None, None),
                };

                emit_helper_result(&HelperResultPayload {
                    protocol_version: "1.0".to_string(),
                    op: "CLEAR_LOCKOUT".to_string(),
                    status: "OK".to_string(),
                    result_code: result_code.to_string(),
                    approval_result: None,
                    attempt_count: None,
                    locked_out,
                    lockout_id,
                    clear_token_recorded: clear_recorded,
                    error_code: err_code,
                    attempts: None,
                });
                std::process::exit(0);
            }
            "CLOCK_ADVANCE" => {
                let ts: u64 = std::env::var("TWINPET_TWO_PROC_TIMESTAMP").unwrap().parse().unwrap();
                wait_barrier_if_requested("CLOCK_ADVANCE");
                let res = clock_guard::assert_valid_and_advance_clock(&root, ts);
                let (status, result_code, err_code) = match res {
                    Ok(_) => ("OK", "CLOCK_ADVANCED", None),
                    Err(clock_guard::ClockGuardError::ClockRollbackDetected { .. }) => {
                        ("OK", "CLOCK_ROLLBACK_REJECTED", Some("ClockRollbackDetected".to_string()))
                    }
                    Err(clock_guard::ClockGuardError::PresentMalformed(_)) => {
                        ("INTERNAL_ERROR", "CLOCK_INTERNAL_ERROR", Some("PresentMalformed".to_string()))
                    }
                    Err(clock_guard::ClockGuardError::IoError(_)) => {
                        ("INTERNAL_ERROR", "CLOCK_INTERNAL_ERROR", Some("IoError".to_string()))
                    }
                };
                emit_helper_result(&HelperResultPayload {
                    protocol_version: "1.0".to_string(),
                    op: "CLOCK_ADVANCE".to_string(),
                    status: status.to_string(),
                    result_code: result_code.to_string(),
                    approval_result: None,
                    attempt_count: None,
                    locked_out: None,
                    lockout_id: None,
                    clear_token_recorded: None,
                    error_code: err_code,
                    attempts: None,
                });
                std::process::exit(0);
            }
            "TEST_MUTEX_POISON" => {
                let _ = std::panic::catch_unwind(|| {
                    let _g = VERIFIER_MUTEX.lock().unwrap();
                    panic!("intentional poison");
                });
                assert!(VERIFIER_MUTEX.is_poisoned());
                let res = verify_offline_pin(&root, "mgr-1", "VOID_PENDING_SALE", "123456").unwrap();
                assert!(!res.ok && res.error_code == Some("DENIED_UNVERIFIABLE".to_string()));
                let res_c = clear_offline_lockout(&root, "bad").unwrap();
                assert!(!res_c.ok && res_c.error_code == Some("DENIED_UNVERIFIABLE".to_string()));

                emit_helper_result(&HelperResultPayload {
                    protocol_version: "1.0".to_string(),
                    op: "TEST_MUTEX_POISON".to_string(),
                    status: "OK".to_string(),
                    result_code: "POISON_FAILED_CLOSED".to_string(),
                    approval_result: None,
                    attempt_count: None,
                    locked_out: None,
                    lockout_id: None,
                    clear_token_recorded: None,
                    error_code: Some("DENIED_UNVERIFIABLE".to_string()),
                    attempts: None,
                });
                std::process::exit(0);
            }
            other => panic!("unknown helper mode: {other}"),
        }
    }

    #[test]
    fn test_two_process_lock_exclusion() {
        let root = temp_root();
        let parent_guard = acquire_lifecycle_lock(&root, 1000).expect("parent acquires lock");

        let out = spawn_helper_output("TRY_LOCK", &root, &[("TWINPET_TWO_PROC_TIMEOUT_MS", "200")]);
        assert_eq!(out.result_code, "LOCK_UNAVAILABLE", "child must fail to acquire while parent holds");
        assert_eq!(out.status, "OK");
        assert_eq!(out.op, "TRY_LOCK");

        drop(parent_guard);

        let out2 = spawn_helper_output("TRY_LOCK", &root, &[("TWINPET_TWO_PROC_TIMEOUT_MS", "2000")]);
        assert_eq!(out2.result_code, "LOCK_ACQUIRED", "child must succeed to acquire after parent drops");
        assert_eq!(out2.status, "OK");
        assert_eq!(out2.op, "TRY_LOCK");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_two_process_attempt_counting() {
        let root = temp_root();
        let (signing_key, device_id_hex) = setup_test_terminal(&root, 1);
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;

        provision_test_oac(
            &root,
            &signing_key,
            "mgr-cross",
            "B01",
            &device_id_hex,
            "123456",
            1,
            now_ms - 1000,
            now_ms + 3_600_000,
            vec!["VOID_PENDING_SALE"],
        );

        // Spawn child helper blocked on start barrier
        let mut helper = BarrierChildHelper::spawn(
            "ATTEMPT_VERIFY",
            &root,
            &[
                ("TWINPET_TWO_PROC_MGR", "mgr-cross"),
                ("TWINPET_TWO_PROC_PIN", "000000"),
                ("TWINPET_TWO_PROC_COUNT", "2"),
            ],
        );

        // Release barrier and run parent attempts concurrently
        helper.signal_go();
        let parent_res1 = verify_offline_pin(&root, "mgr-cross", "VOID_PENDING_SALE", "000000").unwrap();
        let parent_res2 = verify_offline_pin(&root, "mgr-cross", "VOID_PENDING_SALE", "000000").unwrap();

        let child_payload = helper.wait_result();

        // Assert parent outcomes
        assert!(!parent_res1.ok);
        assert_eq!(parent_res1.error_code, Some("DENIED_INVALID_PIN".to_string()));
        assert!(!parent_res2.ok);
        assert_eq!(parent_res2.error_code, Some("DENIED_INVALID_PIN".to_string()));

        // Assert child outcomes
        assert_eq!(child_payload.result_code, "VERIFY_COMPLETED");
        assert_eq!(child_payload.error_code, Some("DENIED_INVALID_PIN".to_string()));
        assert_eq!(child_payload.approval_result, Some("DENIED_INVALID_PIN".to_string()));
        let child_attempts = child_payload.attempts.expect("child attempts list");
        assert_eq!(child_attempts.len(), 2);
        for att in &child_attempts {
            assert!(!att.ok);
            assert_eq!(att.error_code, Some("DENIED_INVALID_PIN".to_string()));
            assert_eq!(att.approval_result, Some("DENIED_INVALID_PIN".to_string()));
        }

        // Final durable store must reflect exact sum: 2 parent + 2 child = 4 failed attempts
        let store = lockout_state::read_lockout_store(&root).unwrap();
        let entry = store.managers.get("mgr-cross").unwrap();
        assert_eq!(entry.consecutive_failed_attempts, 4, "no lost updates across 4 concurrent attempts");
        assert!(!entry.locked_out);
        assert!(entry.current_lockout_id_hex.is_none());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_two_process_attempt5_generation() {
        let root = temp_root();
        let (signing_key, device_id_hex) = setup_test_terminal(&root, 1);
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;

        provision_test_oac(
            &root,
            &signing_key,
            "mgr-gen5",
            "B01",
            &device_id_hex,
            "123456",
            1,
            now_ms - 1000,
            now_ms + 3_600_000,
            vec!["VOID_PENDING_SALE"],
        );

        // Arrange state at attempt 4
        for _ in 1..=4 {
            let res = verify_offline_pin(&root, "mgr-gen5", "VOID_PENDING_SALE", "000000").unwrap();
            assert_eq!(res.error_code, Some("DENIED_INVALID_PIN".to_string()));
        }

        // Spawn child helper with barrier waiting to execute 1 wrong-PIN attempt
        let mut helper = BarrierChildHelper::spawn(
            "ATTEMPT_VERIFY",
            &root,
            &[
                ("TWINPET_TWO_PROC_MGR", "mgr-gen5"),
                ("TWINPET_TWO_PROC_PIN", "000000"),
                ("TWINPET_TWO_PROC_COUNT", "1"),
            ],
        );

        // Release barrier and race parent wrong-PIN attempt
        helper.signal_go();
        let parent_res = verify_offline_pin(&root, "mgr-gen5", "VOID_PENDING_SALE", "000000").unwrap();
        let child_payload = helper.wait_result();

        // Assert both actor outcomes explicitly
        assert!(!parent_res.ok);
        assert_eq!(parent_res.error_code, Some("DENIED_LOCKED".to_string()));
        let parent_seed = parent_res.evidence_seed.expect("parent evidence seed");
        assert_eq!(parent_seed.approval_result, "DENIED_LOCKED");
        assert_eq!(parent_seed.attempt_count, 5);

        assert_eq!(child_payload.result_code, "VERIFY_COMPLETED");
        assert_eq!(child_payload.error_code, Some("DENIED_LOCKED".to_string()));
        assert_eq!(child_payload.approval_result, Some("DENIED_LOCKED".to_string()));
        assert_eq!(child_payload.attempt_count, Some(5));
        assert_eq!(child_payload.locked_out, Some(true));

        // Read durable state: exactly 5 attempts, locked out, single 64-char hex lockout ID
        let store = lockout_state::read_lockout_store(&root).unwrap();
        let entry = store.managers.get("mgr-gen5").unwrap();
        assert_eq!(entry.consecutive_failed_attempts, 5);
        assert!(entry.locked_out);
        let gen_id = entry.current_lockout_id_hex.as_ref().expect("durable lockout generation id");
        assert_eq!(gen_id.len(), 64);
        assert!(lockout_state::is_lowercase_hex64(gen_id));

        // Both observe same final generation/state and exactly one durable generation minted
        assert_eq!(child_payload.lockout_id.as_ref(), Some(gen_id));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_two_process_clear_vs_verify() {
        let root = temp_root();
        let (signing_key, device_id_hex) = setup_test_terminal(&root, 1);
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;

        provision_test_oac(
            &root,
            &signing_key,
            "mgr-cvp",
            "B01",
            &device_id_hex,
            "123456",
            1,
            now_ms - 1000,
            now_ms + 3_600_000,
            vec!["VOID_PENDING_SALE"],
        );

        for _ in 1..=5 {
            let _ = verify_offline_pin(&root, "mgr-cvp", "VOID_PENDING_SALE", "000000");
        }

        let store = lockout_state::read_lockout_store(&root).unwrap();
        let lockout_id_hex = store.managers.get("mgr-cvp").unwrap().current_lockout_id_hex.clone().unwrap();
        let mut lockout_id = [0u8; 32];
        for i in 0..32 {
            lockout_id[i] = u8::from_str_radix(&lockout_id_hex[i * 2..i * 2 + 2], 16).unwrap();
        }
        let sec_dev_id = security_device_id::resolve_or_create_security_device_id(&root).unwrap();

        let lct1_frame = frames::LockoutClearTokenFrameV1 {
            security_device_id: sec_dev_id,
            manager_staff_id: "mgr-cvp".to_string(),
            lockout_id,
            issued_at_server_ms: now_ms - 500,
            expires_at_server_ms: now_ms - 500 + 900_000,
            token_nonce: [0x55u8; 32],
            signing_key_id: "test-signing-key".to_string(),
            signature: [0u8; 64],
        };
        let prefix = frames::lct1_signed_prefix(&lct1_frame).unwrap();
        let sig = signing_key.sign(&prefix);
        let mut signed = lct1_frame;
        signed.signature = sig.to_bytes();
        let lct1_b64 = base64_encode_std(&frames::encode_lct1(&signed).unwrap());

        // Spawn child helper with barrier for CLEAR_LOCKOUT
        let mut helper = BarrierChildHelper::spawn(
            "CLEAR_LOCKOUT",
            &root,
            &[
                ("TWINPET_TWO_PROC_MGR", "mgr-cvp"),
                ("TWINPET_TWO_PROC_TOKEN", &lct1_b64),
            ],
        );

        // Release barrier and race parent PIN verification with valid PIN during cooldown
        helper.signal_go();
        let verify_res = verify_offline_pin(&root, "mgr-cvp", "VOID_PENDING_SALE", "123456").unwrap();
        let child_payload = helper.wait_result();

        // Assert child clear outcome: accepted and recorded
        assert_eq!(child_payload.result_code, "CLEAR_ACCEPTED");
        assert_eq!(child_payload.clear_token_recorded, Some(true));
        assert_eq!(child_payload.locked_out, Some(true));

        // Assert parent verify outcome: during cooldown, verify remains locked (no premature reopen)
        assert!(!verify_res.ok);
        assert_eq!(verify_res.error_code, Some("DENIED_LOCKED".to_string()));

        // Assert final durable state
        let store_after = lockout_state::read_lockout_store(&root).unwrap();
        let entry_after = store_after.managers.get("mgr-cvp").unwrap();
        assert!(entry_after.clear_token_recorded);
        assert!(entry_after.locked_out);
        assert_eq!(entry_after.consecutive_failed_attempts, 5);
        assert_eq!(entry_after.current_lockout_id_hex.as_ref(), Some(&lockout_id_hex));

        // Also assert that CLEAR_LOCKOUT with invalid token reports CLEAR_DENIED (distinguishes outcomes)
        let denied_child = spawn_helper_output(
            "CLEAR_LOCKOUT",
            &root,
            &[
                ("TWINPET_TWO_PROC_MGR", "mgr-cvp"),
                ("TWINPET_TWO_PROC_TOKEN", "bad-base64"),
            ],
        );
        assert_eq!(denied_child.result_code, "CLEAR_DENIED");
        assert_eq!(denied_child.status, "OK");

        let _ = fs::remove_dir_all(&root);
    }

    fn assert_is_semantic_clock_rollback(payload: &HelperResultPayload) {
        assert_eq!(payload.protocol_version, "1.0", "helper protocolVersion must be 1.0");
        assert_eq!(payload.op, "CLOCK_ADVANCE", "helper op must be CLOCK_ADVANCE");
        assert_eq!(payload.status, "OK", "rollback status must be OK");
        assert_eq!(payload.result_code, "CLOCK_ROLLBACK_REJECTED", "resultCode must be CLOCK_ROLLBACK_REJECTED");
        assert_eq!(
            payload.error_code.as_deref(),
            Some("ClockRollbackDetected"),
            "errorCode must identify ClockRollbackDetected"
        );
    }

    #[test]
    fn test_two_process_clock_high_water() {
        let root = temp_root();

        clock_guard::assert_valid_and_advance_clock(&root, 1_000_000).unwrap();

        let out = spawn_helper_output(
            "CLOCK_ADVANCE",
            &root,
            &[("TWINPET_TWO_PROC_TIMESTAMP", "1050000")],
        );
        assert_eq!(out.status, "OK");
        assert_eq!(out.result_code, "CLOCK_ADVANCED");

        let state = clock_guard::read_clock_guard_state(&root).unwrap().unwrap();
        assert_eq!(state.last_observed_system_time_ms, 1_050_000);

        let out_rb = spawn_helper_output(
            "CLOCK_ADVANCE",
            &root,
            &[("TWINPET_TWO_PROC_TIMESTAMP", "1040000")],
        );
        assert_is_semantic_clock_rollback(&out_rb);

        let state2 = clock_guard::read_clock_guard_state(&root).unwrap().unwrap();
        assert_eq!(state2.last_observed_system_time_ms, 1_050_000);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_clock_helper_io_error_cannot_masquerade_as_rollback() {
        let root = temp_root();

        // 1. Deliberately induce IoError by creating a directory at the clock guard file path
        let guard_target = clock_guard::clock_guard_path(&root);
        fs::create_dir_all(&guard_target).expect("create directory at clock guard path to induce IoError");

        let out_io = spawn_helper_output(
            "CLOCK_ADVANCE",
            &root,
            &[("TWINPET_TWO_PROC_TIMESTAMP", "1040000")],
        );

        // Child does NOT produce semantic CLOCK_ROLLBACK_REJECTED
        assert_ne!(
            out_io.result_code, "CLOCK_ROLLBACK_REJECTED",
            "I/O error must never produce CLOCK_ROLLBACK_REJECTED"
        );
        assert_ne!(out_io.status, "OK", "I/O error must never produce status OK");

        // Child produces CLOCK_INTERNAL_ERROR / INTERNAL_ERROR
        assert_eq!(out_io.status, "INTERNAL_ERROR");
        assert_eq!(out_io.result_code, "CLOCK_INTERNAL_ERROR");

        // Parent explicitly asserts the internal-error category
        assert_eq!(
            out_io.error_code.as_deref(),
            Some("IoError"),
            "errorCode must identify IoError"
        );

        // Standard rollback assertion helper would reject this result
        let rollback_assert_io_failed = std::panic::catch_unwind(|| {
            assert_is_semantic_clock_rollback(&out_io);
        })
        .is_err();
        assert!(
            rollback_assert_io_failed,
            "standard rollback assertion helper must reject IoError payload"
        );

        // Clean up the directory before testing PresentMalformed
        let _ = fs::remove_dir_all(&guard_target);

        // 2. Deliberately induce PresentMalformed by writing non-DPAPI malformed bytes
        fs::write(&guard_target, b"malformed-non-dpapi-content").expect("write malformed clock guard file");

        let out_malformed = spawn_helper_output(
            "CLOCK_ADVANCE",
            &root,
            &[("TWINPET_TWO_PROC_TIMESTAMP", "1040000")],
        );

        // Child does NOT produce semantic CLOCK_ROLLBACK_REJECTED
        assert_ne!(
            out_malformed.result_code, "CLOCK_ROLLBACK_REJECTED",
            "PresentMalformed must never produce CLOCK_ROLLBACK_REJECTED"
        );
        assert_ne!(out_malformed.status, "OK", "PresentMalformed must never produce status OK");

        // Child produces CLOCK_INTERNAL_ERROR / INTERNAL_ERROR
        assert_eq!(out_malformed.status, "INTERNAL_ERROR");
        assert_eq!(out_malformed.result_code, "CLOCK_INTERNAL_ERROR");

        // Parent explicitly asserts the internal-error category
        assert_eq!(
            out_malformed.error_code.as_deref(),
            Some("PresentMalformed"),
            "errorCode must identify PresentMalformed"
        );

        // Standard rollback assertion helper would reject this result
        let rollback_assert_malformed_failed = std::panic::catch_unwind(|| {
            assert_is_semantic_clock_rollback(&out_malformed);
        })
        .is_err();
        assert!(
            rollback_assert_malformed_failed,
            "standard rollback assertion helper must reject PresentMalformed payload"
        );

        // Clean up test-local directory only; no user %APPDATA% touched
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_verifier_mutex_poison_fails_closed() {
        let root = temp_root();
        let out = spawn_helper_output("TEST_MUTEX_POISON", &root, &[]);
        assert_eq!(out.status, "OK");
        assert_eq!(out.result_code, "POISON_FAILED_CLOSED", "mutex poisoning must fail closed with DENIED_UNVERIFIABLE");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_rc005_active_slot_suite() {
        let root = temp_root();
        let (signing_key, device_id_hex) = setup_test_terminal(&root, 1);
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;

        // 1. Valid selected manager active slot works
        let oac_id = provision_test_oac(
            &root,
            &signing_key,
            "mgr-active",
            "B01",
            &device_id_hex,
            "123456",
            1,
            now_ms - 1000,
            now_ms + 3_600_000,
            vec!["VOID_PENDING_SALE"],
        );
        let res1 = verify_offline_pin(&root, "mgr-active", "VOID_PENDING_SALE", "123456").unwrap();
        assert!(res1.ok);
        assert_eq!(res1.verified_branch_id, Some("B01".to_string()));
        assert_eq!(res1.evidence_seed.unwrap().approval_result, "APPROVED_LOCAL");

        // 2. Selected manager active slot malformed JSON => deny
        let slot_path = super::super::manager_active_slot_path(&root, "mgr-active").unwrap();
        let valid_slot_content = fs::read_to_string(&slot_path).unwrap();
        fs::write(&slot_path, b"not-valid-json").unwrap();
        let res2 = verify_offline_pin(&root, "mgr-active", "VOID_PENDING_SALE", "123456").unwrap();
        assert!(!res2.ok);
        assert_eq!(res2.error_code, Some("DENIED_UNVERIFIABLE".to_string()));

        // 3. Selected manager active slot unknown fields => deny
        let mut unknown_fields_val: serde_json::Value = serde_json::from_str(&valid_slot_content).unwrap();
        unknown_fields_val["unexpectedField"] = serde_json::json!("forbidden");
        fs::write(&slot_path, serde_json::to_string(&unknown_fields_val).unwrap()).unwrap();
        let res3 = verify_offline_pin(&root, "mgr-active", "VOID_PENDING_SALE", "123456").unwrap();
        assert!(!res3.ok);
        assert_eq!(res3.error_code, Some("DENIED_UNVERIFIABLE".to_string()));

        // 4. Manager mismatch => deny
        let mut mismatch_val: serde_json::Value = serde_json::from_str(&valid_slot_content).unwrap();
        mismatch_val["managerStaffId"] = serde_json::json!("mgr-other");
        fs::write(&slot_path, serde_json::to_string(&mismatch_val).unwrap()).unwrap();
        let res4 = verify_offline_pin(&root, "mgr-active", "VOID_PENDING_SALE", "123456").unwrap();
        assert!(!res4.ok);
        assert_eq!(res4.error_code, Some("DENIED_UNVERIFIABLE".to_string()));

        // 5. Bad signature => deny
        let mut bad_sig_val: serde_json::Value = serde_json::from_str(&valid_slot_content).unwrap();
        bad_sig_val["signature"] = serde_json::json!(base64_encode_std(&[0u8; 64]));
        fs::write(&slot_path, serde_json::to_string(&bad_sig_val).unwrap()).unwrap();
        let res5 = verify_offline_pin(&root, "mgr-active", "VOID_PENDING_SALE", "123456").unwrap();
        assert!(!res5.ok);
        assert_eq!(res5.error_code, Some("DENIED_UNVERIFIABLE".to_string()));

        // Restore valid slot content
        fs::write(&slot_path, &valid_slot_content).unwrap();

        // 7. Active slot absent + older historical file exists => deny/reprovision, NO fallback
        let _ = fs::remove_file(&slot_path);
        assert!(fs::read_to_string(oac_store_dir(&root).join(format!("{oac_id}.json"))).is_ok());
        let res7 = verify_offline_pin(&root, "mgr-active", "VOID_PENDING_SALE", "123456").unwrap();
        assert!(!res7.ok);
        assert_eq!(res7.error_code, Some("DENIED_UNVERIFIABLE".to_string()));

        // 8. Unrelated malformed historical file + valid selected slot => works
        fs::write(&slot_path, &valid_slot_content).unwrap();
        fs::write(oac_store_dir(&root).join("unrelated-malformed.json"), b"invalid-unrelated").unwrap();
        let res8 = verify_offline_pin(&root, "mgr-active", "VOID_PENDING_SALE", "123456").unwrap();
        assert!(res8.ok);
        assert_eq!(res8.verified_branch_id, Some("B01".to_string()));

        // 9. Newer provisioning atomically replaces only same-manager active slot
        let _oac_m2 = provision_test_oac(
            &root,
            &signing_key,
            "mgr-2",
            "B01",
            &device_id_hex,
            "654321",
            1,
            now_ms - 1000,
            now_ms + 3_600_000,
            vec!["VOID_SETTLED_SALE"],
        );
        let slot_m2_path = super::super::manager_active_slot_path(&root, "mgr-2").unwrap();
        let m2_content_before = fs::read_to_string(&slot_m2_path).unwrap();

        // Reprovision mgr-active with newer action
        let _oac_active_new = provision_test_oac(
            &root,
            &signing_key,
            "mgr-active",
            "B01",
            &device_id_hex,
            "123456",
            1,
            now_ms - 500,
            now_ms + 3_600_000,
            vec!["VOID_SETTLED_SALE"],
        );

        let res9_new = verify_offline_pin(&root, "mgr-active", "VOID_SETTLED_SALE", "123456").unwrap();
        assert!(res9_new.ok);
        let res9_old = verify_offline_pin(&root, "mgr-active", "VOID_PENDING_SALE", "123456").unwrap();
        assert!(!res9_old.ok);
        assert_eq!(res9_old.error_code, Some("MANAGER_NOT_AUTHORIZED".to_string()));

        // 10. Another manager slot remains unchanged
        let m2_content_after = fs::read_to_string(&slot_m2_path).unwrap();
        assert_eq!(m2_content_before, m2_content_after);
        let res10 = verify_offline_pin(&root, "mgr-2", "VOID_SETTLED_SALE", "654321").unwrap();
        assert!(res10.ok);

        let _ = fs::remove_dir_all(&root);
    }
}
