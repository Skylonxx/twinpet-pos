//! SEC-001 Packet C-A — the Admin Issuance Console's own per-install Ed25519
//! issuer keypair (`OPTION_I1_PER_INSTALL_ASYMMETRIC_ISSUER_KEYPAIR_OPS_BOOTSTRAP`).
//! Generated locally, DPAPI-CurrentUser-protected, and never leaves this
//! console. Signs the canonical-JSON payload of every issuer-signed request
//! (`registerIssuer` possession proof, `beginDeviceEnrollmentAuthorizationIssuance`,
//! `completeDeviceEnrollmentAuthorizationIssuance`) — the SAME canonicalization
//! algorithm as `functions/src/credentialStore.ts::canonicalJSON`.

use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;
use std::fs;
use std::path::{Path, PathBuf};
use windows::core::PWSTR;
use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

pub const APP_IDENTIFIER: &str = "com.twinpet.issuerconsole";
pub const ISSUER_KEY_FILE_NAME: &str = "twinpet-issuer-key.dpapi";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssuerKeyError {
    Corrupt,
    Io,
    DpapiFailed,
}

pub fn resolve_app_data_dir() -> PathBuf {
    let appdata = std::env::var_os("APPDATA").expect("APPDATA is required for the Issuer Console");
    PathBuf::from(appdata).join(APP_IDENTIFIER)
}

fn issuer_key_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(ISSUER_KEY_FILE_NAME)
}

fn blob_from_slice(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 }
}

unsafe fn take_and_free(blob: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    let out = if blob.pbData.is_null() || blob.cbData == 0 {
        Vec::new()
    } else {
        std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec()
    };
    if !blob.pbData.is_null() {
        let _ = LocalFree(Some(HLOCAL(blob.pbData as *mut _)));
    }
    out
}

fn dpapi_protect(plaintext: &[u8]) -> Result<Vec<u8>, IssuerKeyError> {
    let input = blob_from_slice(plaintext);
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(&input, PWSTR::null(), None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
            .map_err(|_| IssuerKeyError::DpapiFailed)?;
        Ok(take_and_free(output))
    }
}

fn dpapi_unprotect(ciphertext: &[u8]) -> Result<Vec<u8>, IssuerKeyError> {
    let input = blob_from_slice(ciphertext);
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
            .map_err(|_| IssuerKeyError::DpapiFailed)?;
        Ok(take_and_free(output))
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), IssuerKeyError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| IssuerKeyError::Io)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|_| IssuerKeyError::Io)?;
    fs::rename(&tmp, path).map_err(|_| IssuerKeyError::Io)
}

/// Reads the persisted issuer signing key, or generates and persists a fresh
/// one on first run. Fails closed on corruption/DPAPI failure — never
/// silently regenerates (that would orphan the issuer's server-registered
/// public key, requiring a brand-new bootstrap ceremony).
pub fn resolve_or_create_issuer_key(app_data_dir: &Path) -> Result<SigningKey, IssuerKeyError> {
    let path = issuer_key_path(app_data_dir);
    match fs::read(&path) {
        Ok(ciphertext) => {
            let plaintext = dpapi_unprotect(&ciphertext)?;
            if plaintext.len() != 32 {
                return Err(IssuerKeyError::Corrupt);
            }
            let mut seed = [0u8; 32];
            seed.copy_from_slice(&plaintext);
            Ok(SigningKey::from_bytes(&seed))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let signing_key = SigningKey::generate(&mut OsRng);
            let ciphertext = dpapi_protect(&signing_key.to_bytes())?;
            write_atomic(&path, &ciphertext)?;
            Ok(signing_key)
        }
        Err(_) => Err(IssuerKeyError::Io),
    }
}

/// Matches functions/src/credentialStore.ts::canonicalJSON exactly.
pub fn canonical_json(value: &serde_json::Value) -> String {
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

/// Signs `{purpose, requestId, ...fields}` (canonical JSON) with the local
/// issuer key — the exact payload shape `issuerRegistration.ts` /
/// `deviceEnrollment.ts` verify server-side via `issuerSignatureAuth.ts`.
pub fn sign_issuer_request(
    app_data_dir: &Path,
    purpose: &str,
    request_id: &str,
    fields: &serde_json::Map<String, serde_json::Value>,
) -> Result<[u8; 64], IssuerKeyError> {
    let signing_key = resolve_or_create_issuer_key(app_data_dir)?;
    let mut payload_map = fields.clone();
    payload_map.insert("purpose".to_string(), serde_json::Value::String(purpose.to_string()));
    payload_map.insert("requestId".to_string(), serde_json::Value::String(request_id.to_string()));
    let payload = canonical_json(&serde_json::Value::Object(payload_map));
    Ok(signing_key.sign(payload.as_bytes()).to_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Verifier, VerifyingKey};

    fn temp_dir() -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "twinpet-issuer-key-test-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
            n
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn first_run_generates_a_usable_signing_key() {
        let dir = temp_dir();
        let key = resolve_or_create_issuer_key(&dir).unwrap();
        let sig = key.sign(b"hello");
        assert!(key.verifying_key().verify(b"hello", &sig).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn second_run_returns_the_same_key() {
        let dir = temp_dir();
        let a = resolve_or_create_issuer_key(&dir).unwrap();
        let b = resolve_or_create_issuer_key(&dir).unwrap();
        assert_eq!(a.to_bytes(), b.to_bytes());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn persisted_file_is_not_plaintext() {
        let dir = temp_dir();
        let key = resolve_or_create_issuer_key(&dir).unwrap();
        let on_disk = fs::read(issuer_key_path(&dir)).unwrap();
        assert_ne!(on_disk, key.to_bytes().to_vec());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn canonical_json_sorts_keys() {
        let value = serde_json::json!({"b": 2, "a": 1});
        assert_eq!(canonical_json(&value), r#"{"a":1,"b":2}"#);
    }

    #[test]
    fn sign_issuer_request_produces_a_verifiable_signature_over_the_exact_canonical_payload() {
        let dir = temp_dir();
        let mut fields = serde_json::Map::new();
        fields.insert("issuerId".to_string(), serde_json::Value::String("issuer-1".to_string()));
        let signature = sign_issuer_request(&dir, "registerIssuer", "req-1", &fields).unwrap();

        let key = resolve_or_create_issuer_key(&dir).unwrap();
        let expected_payload = canonical_json(&serde_json::json!({
            "issuerId": "issuer-1", "purpose": "registerIssuer", "requestId": "req-1"
        }));
        let public_key: VerifyingKey = key.verifying_key();
        let sig = ed25519_dalek::Signature::from_bytes(&signature);
        assert!(public_key.verify(expected_payload.as_bytes(), &sig).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }
}
