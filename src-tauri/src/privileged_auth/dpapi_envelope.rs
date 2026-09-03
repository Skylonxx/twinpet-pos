//! SEC-001 Packet C-A — Windows DPAPI (CurrentUser scope) envelope
//! encryption for at-rest secrets (device private key, pepper). No
//! `CRYPTPROTECT_LOCAL_MACHINE` flag is ever passed, so the OS binds the
//! ciphertext to the current Windows user profile; `CRYPTPROTECT_UI_FORBIDDEN`
//! ensures a headless native command can never block on a Windows UI prompt.

use windows::Win32::Foundation::LocalFree;
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};
use windows::core::PWSTR;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DpapiError {
    ProtectFailed,
    UnprotectFailed,
    EmptyInput,
}

fn blob_from_slice(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    }
}

/// Copies a DPAPI output blob into an owned `Vec<u8>` and frees the
/// LocalAlloc'd buffer DPAPI handed back.
unsafe fn take_and_free(blob: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    let out = if blob.pbData.is_null() || blob.cbData == 0 {
        Vec::new()
    } else {
        std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec()
    };
    if !blob.pbData.is_null() {
        let _ = LocalFree(Some(windows::Win32::Foundation::HLOCAL(blob.pbData as *mut _)));
    }
    out
}

/// Encrypts `plaintext` for the current Windows user profile only.
pub fn dpapi_protect(plaintext: &[u8]) -> Result<Vec<u8>, DpapiError> {
    if plaintext.is_empty() {
        return Err(DpapiError::EmptyInput);
    }
    let input = blob_from_slice(plaintext);
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input,
            PWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|_| DpapiError::ProtectFailed)?;
        Ok(take_and_free(output))
    }
}

/// Decrypts a blob previously produced by `dpapi_protect` under the same
/// Windows user profile. Fails closed (does not panic) on any DPAPI error —
/// e.g. the blob was protected under a different user, or is corrupt.
pub fn dpapi_unprotect(ciphertext: &[u8]) -> Result<Vec<u8>, DpapiError> {
    if ciphertext.is_empty() {
        return Err(DpapiError::EmptyInput);
    }
    let input = blob_from_slice(ciphertext);
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|_| DpapiError::UnprotectFailed)?;
        Ok(take_and_free(output))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_arbitrary_bytes() {
        let plaintext = b"twinpet-pos device private key material".to_vec();
        let ciphertext = dpapi_protect(&plaintext).expect("protect");
        assert_ne!(ciphertext, plaintext);
        let decrypted = dpapi_unprotect(&ciphertext).expect("unprotect");
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn round_trips_large_payload() {
        let plaintext = vec![0xAB_u8; 4096];
        let ciphertext = dpapi_protect(&plaintext).expect("protect");
        let decrypted = dpapi_unprotect(&ciphertext).expect("unprotect");
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn rejects_empty_input() {
        assert_eq!(dpapi_protect(&[]), Err(DpapiError::EmptyInput));
        assert_eq!(dpapi_unprotect(&[]), Err(DpapiError::EmptyInput));
    }

    #[test]
    fn fails_closed_on_corrupt_ciphertext() {
        let plaintext = b"secret".to_vec();
        let mut ciphertext = dpapi_protect(&plaintext).expect("protect");
        // Corrupt the blob — DPAPI must reject it, not silently decrypt garbage.
        for b in ciphertext.iter_mut().take(8) {
            *b ^= 0xFF;
        }
        assert!(dpapi_unprotect(&ciphertext).is_err());
    }
}
