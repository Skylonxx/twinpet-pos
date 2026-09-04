//! SEC-001 Packet C-A native privileged-auth module tree.
//!
//! Ten modules (each with a colocated `#[cfg(test)] mod tests`) plus the five
//! Tauri command wrappers exposed to the WebView. See
//! `docs/agent-workflow/CURRENT_PACKET.md` (C-A allowlist) for the frozen
//! module/command inventory. Exactly five commands are registered; nothing
//! else from this module tree is ever exposed to the WebView (no sign-
//! arbitrary-bytes, no pepper/DPAPI-blob/device-private-key getters, no raw
//! Argon2 verifier export, no arbitrary file read, no raw keyset-manifest-
//! bytes command).

pub mod argon2_benchmark;
pub mod argon2_kdf;
pub mod clock_guard;
pub mod device_proof;
pub mod device_registration_proof;
pub mod dpapi_envelope;
pub mod enrollment_import;
pub mod frames;
pub mod lockout_state;
pub mod oac_keyset_frame;
pub mod offline_verifier;
pub mod pepper_store;
pub mod security_device_id;

use argon2_benchmark::Argon2BenchmarkVerdict;
use device_registration_proof::generate_device_registration_proof;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use enrollment_import::import_enrollment_file;
use oac_keyset_frame::{find_signing_key, parse_and_verify_oac_keyset};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn app_data_dir() -> PathBuf {
    crate::epoch_floor::resolve_app_data_dir()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// --- Canonical JSON (matches functions/src/credentialStore.ts::canonicalJSON exactly) ---

fn canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .iter()
                .map(|k| format!("{}:{}", serde_json::to_string(k).unwrap(), canonical_json(&map[*k])))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        serde_json::Value::Array(arr) => {
            let parts: Vec<String> = arr.iter().map(canonical_json).collect();
            format!("[{}]", parts.join(","))
        }
        other => serde_json::to_string(other).unwrap(),
    }
}

// --- Local OAC store (a storage primitive only — not the Packet D evidence journal) ---

fn oac_store_dir(root: &Path) -> PathBuf {
    root.join("oac-store")
}

fn oks1_manifest_path(root: &Path) -> PathBuf {
    root.join("twinpet-oac-keyset-manifest.bin")
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

pub fn manager_active_slot_path(root: &Path, manager_staff_id: &str) -> Result<PathBuf, String> {
    if !frames::is_canonical_identifier(manager_staff_id) {
        return Err(format!("invalid managerStaffId grammar: '{manager_staff_id}'"));
    }
    Ok(root.join("oac-store").join("by-manager").join(format!("{manager_staff_id}.json")))
}

fn count_stored_oacs(root: &Path) -> u32 {
    fs::read_dir(oac_store_dir(root))
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_file() && e.path().extension().map(|x| x == "json").unwrap_or(false))
                .count() as u32
        })
        .unwrap_or(0)
}

// --- DTOs (camelCase to match the JS-side WebView contract) ---

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedEnrollmentDto {
    enrollment_auth_id: String,
    branch_id: String,
    issued_at_server_ms: u64,
    expires_at_server_ms: u64,
    issuer_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Argon2BenchmarkDto {
    elapsed_ms: u64,
    verdict: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRegistrationStatusDto {
    security_device_id_hex: Option<String>,
    device_key_present: bool,
    stored_oac_count: u32,
}

// --- Command 1: native_import_device_enrollment_file ---
//
// The WebView never supplies a filesystem path: the command itself invokes a
// native, user-mediated file picker and only ever reads the single path the
// user selected in that picker. There is no caller-controlled path/file-read
// argument on this command (see `no_caller_controlled_path_argument` in
// `tests/privileged_auth_confinement.rs`).

/// Reads and parses the ENR1 bytes at `picked` (the native picker's result).
/// Split out from the tauri command wrapper so cancellation, malformed,
/// expired, and happy-path outcomes are unit-testable without driving a real
/// OS file dialog.
fn import_enrollment_from_picked_file(picked: Option<PathBuf>) -> Result<ImportedEnrollmentDto, String> {
    let path = picked.ok_or_else(|| "no enrollment file was selected".to_string())?;
    let bytes = fs::read(&path).map_err(|e| format!("cannot read enrollment file: {e}"))?;
    let imported = import_enrollment_file(&bytes, now_ms()).map_err(|e| format!("{e:?}"))?;
    Ok(ImportedEnrollmentDto {
        enrollment_auth_id: imported.enrollment_auth_id,
        branch_id: imported.branch_id,
        issued_at_server_ms: imported.issued_at_server_ms,
        expires_at_server_ms: imported.expires_at_server_ms,
        issuer_id: imported.issuer_id,
    })
}

#[tauri::command]
pub fn native_import_device_enrollment_file() -> Result<ImportedEnrollmentDto, String> {
    let picked = rfd::FileDialog::new()
        .set_title("Select Enrollment File")
        .add_filter("TwinPet Enrollment File", &["enr1"])
        .pick_file();
    import_enrollment_from_picked_file(picked)
}

// --- Command 2: native_generate_device_registration_proof ---

#[tauri::command]
pub fn native_generate_device_registration_proof(
    enrollment_auth_id: String,
    device_registration_nonce_base64: String,
) -> Result<String, String> {
    let nonce_bytes = base64_decode(&device_registration_nonce_base64)?;
    if nonce_bytes.len() != 32 {
        return Err("device_registration_nonce must decode to 32 bytes".to_string());
    }
    let mut nonce = [0u8; 32];
    nonce.copy_from_slice(&nonce_bytes);
    let drp1 = generate_device_registration_proof(&app_data_dir(), &enrollment_auth_id, nonce)
        .map_err(|e| format!("{e:?}"))?;
    Ok(base64_encode(&drp1))
}

// --- Command 3: native_complete_oac_provisioning ---
//
// Single command covering the whole native side of the OAC provisioning
// ceremony, dispatched by `phase` (the Functions round-trip in between the
// two phases must happen in the WebView/JS — a native command cannot itself
// call a Firebase callable):
//   "produce_proof"   — given the manager's PIN + the session/nonce from
//                        `beginPrivilegedOacIssuanceSession`, computes a fresh
//                        Argon2id verifier (pepper-bound) and returns signed
//                        PTP1 + PIN1 for the WebView to submit to
//                        `completePrivilegedOacIssuanceSession`.
//   "persist_result"  — given the signed OAC envelope that call returned
//                        (+ the OKS1 manifest fetched via `getOacKeysetManifest`),
//                        verifies the OAC's signature against the manifest and
//                        persists both to local storage.
// The PIN is used in-process for exactly one Argon2id derivation and is
// never itself persisted, logged, or returned.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProduceProvisioningProofDto {
    ptp1_base64: String,
    pin1_base64: String,
}

fn produce_provisioning_proof(
    root: &Path,
    pin: &str,
    session_id: &str,
    security_device_id_hex: &str,
    manager_staff_id: &str,
    nonce_base64: &str,
) -> Result<ProduceProvisioningProofDto, String> {
    if security_device_id_hex.len() != 32 || !security_device_id_hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("security_device_id_hex must be 32 hex characters".to_string());
    }
    let mut security_device_id = [0u8; 16];
    for i in 0..16 {
        security_device_id[i] =
            u8::from_str_radix(&security_device_id_hex[i * 2..i * 2 + 2], 16).map_err(|e| e.to_string())?;
    }
    let nonce_bytes = base64_decode(nonce_base64)?;
    if nonce_bytes.len() != 32 {
        return Err("nonce must decode to 32 bytes".to_string());
    }
    let mut nonce = [0u8; 32];
    nonce.copy_from_slice(&nonce_bytes);

    let signing_key = device_proof::resolve_or_create_device_keypair(root).map_err(|e| format!("{e:?}"))?;
    let dev_proof_public_key = signing_key.verifying_key().to_bytes();

    let ptp1_unsigned = frames::ProvisioningTupleProofFrameV1 {
        security_device_id,
        oac_issuance_session_id: session_id.to_string(),
        manager_staff_id: manager_staff_id.to_string(),
        nonce,
        dev_proof_public_key,
        signature: [0u8; 64],
    };
    let ptp1_prefix = frames::ptp1_signed_prefix(&ptp1_unsigned).map_err(|e| format!("{e:?}"))?;
    let ptp1_signature = ed25519_dalek::Signer::sign(&signing_key, &ptp1_prefix).to_bytes();
    let ptp1_bytes = frames::encode_ptp1(&frames::ProvisioningTupleProofFrameV1 {
        signature: ptp1_signature,
        ..ptp1_unsigned
    })
    .map_err(|e| format!("{e:?}"))?;

    let pepper = pepper_store::resolve_or_create_pepper(root).map_err(|e| format!("{e:?}"))?;
    let mut salt = [0u8; argon2_kdf::ARGON2_SALT_LEN];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut salt);
    let verifier = argon2_kdf::derive_verifier(pin.as_bytes(), &salt, &pepper).map_err(|e| format!("{e:?}"))?;
    // SHA-256 commitment to the pepper (never the pepper itself), so the
    // server/evidence layer can later detect a pepper rotation without ever
    // learning the pepper's value.
    let pepper_commitment: [u8; 32] = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(pepper);
        hasher.finalize().into()
    };

    let pin1_unsigned = frames::PinBindingFrameV1 {
        security_device_id,
        oac_issuance_session_id: session_id.to_string(),
        manager_staff_id: manager_staff_id.to_string(),
        verifier_algo: "argon2id".to_string(),
        m: argon2_kdf::ARGON2_M_KIB,
        t: argon2_kdf::ARGON2_T,
        p: argon2_kdf::ARGON2_P,
        verifier_salt: salt.to_vec(),
        verifier: verifier.to_vec(),
        pepper_commitment: pepper_commitment.to_vec(),
        dev_proof_public_key,
        signature: [0u8; 64],
    };
    let pin1_prefix = frames::pin1_signed_prefix(&pin1_unsigned).map_err(|e| format!("{e:?}"))?;
    let pin1_signature = ed25519_dalek::Signer::sign(&signing_key, &pin1_prefix).to_bytes();
    let pin1_bytes = frames::encode_pin1(&frames::PinBindingFrameV1 { signature: pin1_signature, ..pin1_unsigned })
        .map_err(|e| format!("{e:?}"))?;

    Ok(ProduceProvisioningProofDto {
        ptp1_base64: base64_encode(&ptp1_bytes),
        pin1_base64: base64_encode(&pin1_bytes),
    })
}

fn persist_provisioned_oac(root: &Path, oac_envelope_json: &str, oks1_base64: &str) -> Result<(), String> {
    let oks1_bytes = base64_decode(oks1_base64)?;
    let manifest = parse_and_verify_oac_keyset(&oks1_bytes).map_err(|e| format!("{e:?}"))?;

    let envelope: serde_json::Value =
        serde_json::from_str(oac_envelope_json).map_err(|e| format!("invalid OAC envelope JSON: {e}"))?;
    let obj = envelope.as_object().ok_or("OAC envelope must be a JSON object")?;
    let oac_id = obj.get("oacId").and_then(|v| v.as_str()).ok_or("OAC envelope missing oacId")?.to_string();
    let manager_staff_id = obj
        .get("managerStaffId")
        .and_then(|v| v.as_str())
        .ok_or("OAC envelope missing managerStaffId")?;
    if !frames::is_canonical_identifier(manager_staff_id) {
        return Err(format!("invalid managerStaffId grammar: '{manager_staff_id}'"));
    }
    let signing_key_id = obj
        .get("signingKeyId")
        .and_then(|v| v.as_str())
        .ok_or("OAC envelope missing signingKeyId")?;
    let signature_b64 = obj.get("signature").and_then(|v| v.as_str()).ok_or("OAC envelope missing signature")?;
    let signature_bytes = base64_decode_std(signature_b64)?;
    if signature_bytes.len() != 64 {
        return Err("OAC signature must decode to 64 bytes".to_string());
    }
    let mut signature_arr = [0u8; 64];
    signature_arr.copy_from_slice(&signature_bytes);

    let mut unsigned = obj.clone();
    unsigned.remove("signature");
    let payload = canonical_json(&serde_json::Value::Object(unsigned));

    let public_key_bytes = find_signing_key(&manifest, signing_key_id).ok_or("unknown signingKeyId")?;
    let verifying_key = VerifyingKey::from_bytes(public_key_bytes).map_err(|e| e.to_string())?;
    let signature = Signature::from_bytes(&signature_arr);
    verifying_key
        .verify(payload.as_bytes(), &signature)
        .map_err(|_| "OAC envelope signature verification failed".to_string())?;

    write_atomic(&oac_store_dir(root).join(format!("{oac_id}.json")), oac_envelope_json.as_bytes())?;
    let active_slot = manager_active_slot_path(root, manager_staff_id)?;
    write_atomic(&active_slot, oac_envelope_json.as_bytes())?;
    write_atomic(&oks1_manifest_path(root), &oks1_bytes)?;
    Ok(())
}

#[tauri::command]
pub fn native_complete_oac_provisioning(
    phase: String,
    pin: Option<String>,
    session_id: Option<String>,
    security_device_id_hex: Option<String>,
    manager_staff_id: Option<String>,
    nonce_base64: Option<String>,
    oac_envelope_json: Option<String>,
    oks1_base64: Option<String>,
) -> Result<serde_json::Value, String> {
    let root = app_data_dir();
    match phase.as_str() {
        "produce_proof" => {
            let dto = produce_provisioning_proof(
                &root,
                &pin.ok_or("pin is required for phase=produce_proof")?,
                &session_id.ok_or("session_id is required for phase=produce_proof")?,
                &security_device_id_hex.ok_or("security_device_id_hex is required for phase=produce_proof")?,
                &manager_staff_id.ok_or("manager_staff_id is required for phase=produce_proof")?,
                &nonce_base64.ok_or("nonce_base64 is required for phase=produce_proof")?,
            )?;
            serde_json::to_value(dto).map_err(|e| e.to_string())
        }
        "persist_result" => {
            persist_provisioned_oac(
                &root,
                &oac_envelope_json.ok_or("oac_envelope_json is required for phase=persist_result")?,
                &oks1_base64.ok_or("oks1_base64 is required for phase=persist_result")?,
            )?;
            Ok(serde_json::Value::Null)
        }
        other => Err(format!("unknown phase: {other}")),
    }
}

// --- Command 4: native_argon2_benchmark ---

#[tauri::command]
pub fn native_argon2_benchmark() -> Result<Argon2BenchmarkDto, String> {
    let result = argon2_benchmark::run_argon2_benchmark().map_err(|e| format!("{e:?}"))?;
    let verdict = match result.verdict {
        Argon2BenchmarkVerdict::Pass => "PASS",
        Argon2BenchmarkVerdict::PassWithNote => "PASS_WITH_NOTE",
        Argon2BenchmarkVerdict::HardFail => "HARD_FAIL",
    };
    Ok(Argon2BenchmarkDto { elapsed_ms: result.elapsed_ms, verdict: verdict.to_string() })
}

// --- Command 5: native_get_device_registration_status ---

#[tauri::command]
pub fn native_get_device_registration_status() -> Result<DeviceRegistrationStatusDto, String> {
    let root = app_data_dir();
    let security_device_id_hex = fs::read(security_device_id::security_device_id_path(&root))
        .ok()
        .filter(|b| b.len() == security_device_id::SECURITY_DEVICE_ID_LEN)
        .map(|b| b.iter().map(|byte| format!("{byte:02x}")).collect::<String>());
    let device_key_present = fs::metadata(device_proof::device_proof_key_path(&root)).is_ok();
    let stored_oac_count = count_stored_oacs(&root);
    Ok(DeviceRegistrationStatusDto { security_device_id_hex, device_key_present, stored_oac_count })
}

// --- Command 6: native_verify_offline_pin ---

#[tauri::command]
pub fn native_verify_offline_pin(
    manager_staff_id: String,
    action_id: String,
    pin: String,
) -> Result<offline_verifier::PrivilegedVerifyOutcomeDto, String> {
    let root = app_data_dir();
    offline_verifier::verify_offline_pin(&root, &manager_staff_id, &action_id, &pin)
}

// --- Command 7: native_clear_offline_lockout ---

#[tauri::command]
pub fn native_clear_offline_lockout(
    lct1_bytes_base64: String,
) -> Result<offline_verifier::ClearLockoutOutcomeDto, String> {
    let root = app_data_dir();
    offline_verifier::clear_offline_lockout(&root, &lct1_bytes_base64)
}

// --- Minimal base64 (standard + url-safe), no external dependency ---

const B64_STD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn base64_encode_with(bytes: &[u8], alphabet: &[u8; 64]) -> String {
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

fn base64_decode_with(input: &str, alphabet: &[u8; 64]) -> Result<Vec<u8>, String> {
    fn index_of(alphabet: &[u8; 64], c: u8) -> Option<u8> {
        alphabet.iter().position(|&x| x == c).map(|i| i as u8)
    }
    let cleaned: Vec<u8> = input.bytes().filter(|&b| b != b'=' && !b.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(cleaned.len() * 3 / 4);
    for chunk in cleaned.chunks(4) {
        let vals: Vec<u8> = chunk
            .iter()
            .map(|&b| index_of(alphabet, b).ok_or_else(|| "invalid base64 character".to_string()))
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

/// Base64url (matches Buffer.toString('base64url') on the Functions side).
fn base64_encode(bytes: &[u8]) -> String {
    base64_encode_with(bytes, B64_URL).trim_end_matches('=').to_string()
}
fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    base64_decode_with(input, B64_URL)
}
/// Standard base64 (matches Buffer.toString('base64') for signature/OKS1 fields).
fn base64_decode_std(input: &str) -> Result<Vec<u8>, String> {
    base64_decode_with(input, B64_STD)
}

#[cfg(test)]
mod command_glue_tests {
    use super::*;

    #[test]
    fn canonical_json_sorts_keys_and_matches_json_stringify_shape() {
        let value = serde_json::json!({"b": 2, "a": 1, "c": [3, "x"]});
        assert_eq!(canonical_json(&value), r#"{"a":1,"b":2,"c":[3,"x"]}"#);
    }

    #[test]
    fn base64url_round_trips() {
        let bytes = vec![0u8, 1, 2, 253, 254, 255, 10, 20, 30];
        let encoded = base64_encode(&bytes);
        assert!(!encoded.contains('+') && !encoded.contains('/'));
        assert_eq!(base64_decode(&encoded).unwrap(), bytes);
    }

    #[test]
    fn base64_std_decodes_a_known_vector() {
        // "hello" -> base64 "aGVsbG8="
        assert_eq!(base64_decode_std("aGVsbG8=").unwrap(), b"hello".to_vec());
    }

    fn temp_dir() -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "twinpet-mod-glue-test-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
            n
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_enr1_bytes(expires_at_server_ms: u64) -> Vec<u8> {
        frames::encode_enr1(&frames::EnrollmentProofFrameV1 {
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
    fn import_enrollment_from_picked_file_cancellation_fails_safely() {
        let result = import_enrollment_from_picked_file(None);
        assert!(result.is_err());
    }

    #[test]
    fn import_enrollment_from_picked_file_selected_file_happy_path() {
        let dir = temp_dir();
        let path = dir.join("enrollment.enr1");
        fs::write(&path, sample_enr1_bytes(u64::MAX)).unwrap();

        let dto = import_enrollment_from_picked_file(Some(path)).unwrap();
        assert_eq!(dto.enrollment_auth_id, "00112233445566778899aabbccddeeff");
        assert_eq!(dto.branch_id, "LDP-001");
        assert_eq!(dto.issuer_id, "issuer-1");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_enrollment_from_picked_file_rejects_malformed_bytes() {
        let dir = temp_dir();
        let path = dir.join("bad.enr1");
        fs::write(&path, b"not an enrollment file").unwrap();

        let result = import_enrollment_from_picked_file(Some(path));
        assert!(result.is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_enrollment_from_picked_file_rejects_an_expired_file() {
        let dir = temp_dir();
        let path = dir.join("expired.enr1");
        fs::write(&path, sample_enr1_bytes(1000)).unwrap();

        let result = import_enrollment_from_picked_file(Some(path));
        assert!(result.is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_enrollment_from_picked_file_reports_unreadable_path_safely() {
        let dir = temp_dir();
        let missing_path = dir.join("does-not-exist.enr1");
        let result = import_enrollment_from_picked_file(Some(missing_path));
        assert!(result.is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn produce_provisioning_proof_returns_self_verifiable_ptp1_and_pin1() {
        let dir = temp_dir();
        let nonce = base64_encode(&[7u8; 32]);
        let dto =
            produce_provisioning_proof(&dir, "123456", "sess-1", "00112233445566778899aabbccddeeff", "staff-1", &nonce)
                .unwrap();

        let ptp1_bytes = base64_decode(&dto.ptp1_base64).unwrap();
        let ptp1 = frames::decode_ptp1(&ptp1_bytes).unwrap();
        assert_eq!(ptp1.oac_issuance_session_id, "sess-1");
        assert_eq!(ptp1.manager_staff_id, "staff-1");
        let ptp1_prefix = frames::ptp1_signed_prefix(&ptp1).unwrap();
        let ptp1_vk = VerifyingKey::from_bytes(&ptp1.dev_proof_public_key).unwrap();
        assert!(ptp1_vk.verify(&ptp1_prefix, &Signature::from_bytes(&ptp1.signature)).is_ok());

        let pin1_bytes = base64_decode(&dto.pin1_base64).unwrap();
        let pin1 = frames::decode_pin1(&pin1_bytes).unwrap();
        assert_eq!(pin1.verifier_algo, "argon2id");
        assert_eq!(pin1.dev_proof_public_key, ptp1.dev_proof_public_key);
        let pin1_prefix = frames::pin1_signed_prefix(&pin1).unwrap();
        assert!(ptp1_vk.verify(&pin1_prefix, &Signature::from_bytes(&pin1.signature)).is_ok());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn produce_provisioning_proof_rejects_a_malformed_device_id() {
        let dir = temp_dir();
        let result = produce_provisioning_proof(&dir, "123456", "sess-1", "not-hex", "staff-1", &base64_encode(&[0u8; 32]));
        assert!(result.is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    fn signed_oac_test_manifest() -> (String, ed25519_dalek::SigningKey) {
        let signing_key = ed25519_dalek::SigningKey::generate(&mut rand::rngs::OsRng);
        let public_key = signing_key.verifying_key().to_bytes();
        let unsigned = frames::OacKeysetManifestFrameV1 {
            revocation_epoch: 0,
            generated_at_server_ms: 1000,
            keys: vec![frames::OacKeysetManifestKeyV1 { signing_key_id: "key-1".to_string(), public_key }],
            signature: [0u8; 64],
        };
        let prefix = frames::oks1_signed_prefix(&unsigned).unwrap();
        let signature = ed25519_dalek::Signer::sign(&signing_key, &prefix).to_bytes();
        let bytes = frames::encode_oks1(&frames::OacKeysetManifestFrameV1 { signature, ..unsigned }).unwrap();
        (base64_encode(&bytes), signing_key)
    }

    fn signed_oac_envelope(signing_key: &ed25519_dalek::SigningKey, oac_id: &str) -> String {
        let unsigned = serde_json::json!({
            "oacId": oac_id,
            "schemaVersion": 1,
            "managerStaffId": "staff-1",
            "managerRole": "manager",
            "branchId": "LDP-001",
            "deviceId": "device-hex",
            "allowedActions": ["VOID_PENDING_SALE", "VOID_SETTLED_SALE"],
            "authVersionAtIssue": 1,
            "credentialVersionAtIssue": 1,
            "revocationEpoch": 0,
            "issuedAtServerMs": 1000,
            "freshnessExpiresAtServerMs": 2000,
            "verifierAlgo": "argon2id",
            "verifierParams": {"m": 65536, "t": 3, "p": 1, "saltLen": 16, "hashLen": 32},
            "verifierSalt": "c2FsdA==",
            "verifier": "dmVyaWZpZXI=",
            "pepperCommitment": "cGVwcGVy",
            "signingKeyId": "key-1",
        });
        let payload = canonical_json(&unsigned);
        let signature = ed25519_dalek::Signer::sign(signing_key, payload.as_bytes()).to_bytes();
        let mut full = unsigned.as_object().unwrap().clone();
        full.insert(
            "signature".to_string(),
            serde_json::Value::String(base64_encode_with(&signature, B64_STD)),
        );
        serde_json::to_string(&serde_json::Value::Object(full)).unwrap()
    }

    #[test]
    fn persist_provisioned_oac_accepts_a_validly_signed_envelope_and_stores_it() {
        let dir = temp_dir();
        let (oks1_base64, signing_key) = signed_oac_test_manifest();
        let envelope_json = signed_oac_envelope(&signing_key, "oac-1");

        persist_provisioned_oac(&dir, &envelope_json, &oks1_base64).unwrap();

        let stored = fs::read_to_string(oac_store_dir(&dir).join("oac-1.json")).unwrap();
        assert_eq!(stored, envelope_json);
        let active_slot = manager_active_slot_path(&dir, "staff-1").unwrap();
        let stored_active = fs::read_to_string(&active_slot).unwrap();
        assert_eq!(stored_active, envelope_json);
        assert_eq!(count_stored_oacs(&dir), 1);
        assert!(oks1_manifest_path(&dir).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn persist_provisioned_oac_rejects_a_tampered_signature() {
        let dir = temp_dir();
        let (oks1_base64, signing_key) = signed_oac_test_manifest();
        let envelope_json = signed_oac_envelope(&signing_key, "oac-2");
        let mut value: serde_json::Value = serde_json::from_str(&envelope_json).unwrap();
        value["branchId"] = serde_json::Value::String("TAMPERED".to_string());
        let tampered_json = serde_json::to_string(&value).unwrap();

        let result = persist_provisioned_oac(&dir, &tampered_json, &oks1_base64);
        assert!(result.is_err());
        assert!(!oac_store_dir(&dir).join("oac-2.json").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
