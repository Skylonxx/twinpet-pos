//! SEC-001 Packet C-A — frozen Argon2id KDF contract for the offline PIN
//! verifier. Parameters match `OAC_VERIFIER_PARAM_MINIMUMS`
//! (`functions/src/privilegedActionRegistry.ts`) exactly: this native module
//! is the sole place a PIN is ever hashed — it never leaves the device.

use argon2::{Algorithm, Argon2, Params, Version};

pub const ARGON2_M_KIB: u32 = 65536;
pub const ARGON2_T: u32 = 3;
pub const ARGON2_P: u32 = 1;
pub const ARGON2_SALT_LEN: usize = 16;
pub const ARGON2_HASH_LEN: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Argon2KdfError {
    InvalidParams,
    HashFailed,
}

fn build_argon2() -> Result<Argon2<'static>, Argon2KdfError> {
    let params = Params::new(ARGON2_M_KIB, ARGON2_T, ARGON2_P, Some(ARGON2_HASH_LEN))
        .map_err(|_| Argon2KdfError::InvalidParams)?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

/// Derives the offline PIN verifier: Argon2id(pin || pepper, salt).
/// Concatenating the pepper onto the password (rather than the salt) keeps
/// `verifierSalt` free to be transmitted/stored non-secret, matching the OAC
/// envelope schema (`verifierSalt`, `verifier`, `pepperCommitment` are all
/// separate, independently-transmitted fields).
pub fn derive_verifier(
    pin: &[u8],
    salt: &[u8; ARGON2_SALT_LEN],
    pepper: &[u8],
) -> Result<[u8; ARGON2_HASH_LEN], Argon2KdfError> {
    let argon2 = build_argon2()?;
    let mut password = Vec::with_capacity(pin.len() + pepper.len());
    password.extend_from_slice(pin);
    password.extend_from_slice(pepper);
    let mut output = [0u8; ARGON2_HASH_LEN];
    argon2
        .hash_password_into(&password, salt, &mut output)
        .map_err(|_| Argon2KdfError::HashFailed)?;
    Ok(output)
}

/// Constant-time comparison — verifier equality must never leak timing.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub fn verify_pin(
    pin: &[u8],
    salt: &[u8; ARGON2_SALT_LEN],
    pepper: &[u8],
    expected_verifier: &[u8; ARGON2_HASH_LEN],
) -> Result<bool, Argon2KdfError> {
    let computed = derive_verifier(pin, salt, pepper)?;
    Ok(constant_time_eq(&computed, expected_verifier))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SALT: [u8; ARGON2_SALT_LEN] = [0x11; ARGON2_SALT_LEN];
    const PEPPER: [u8; 32] = [0x22; 32];

    #[test]
    fn is_deterministic_for_the_same_inputs() {
        let a = derive_verifier(b"123456", &SALT, &PEPPER).unwrap();
        let b = derive_verifier(b"123456", &SALT, &PEPPER).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn differs_across_pin_salt_or_pepper() {
        let base = derive_verifier(b"123456", &SALT, &PEPPER).unwrap();
        assert_ne!(derive_verifier(b"654321", &SALT, &PEPPER).unwrap(), base);
        assert_ne!(derive_verifier(b"123456", &[0x33; ARGON2_SALT_LEN], &PEPPER).unwrap(), base);
        assert_ne!(derive_verifier(b"123456", &SALT, &[0x44; 32]).unwrap(), base);
    }

    #[test]
    fn verify_pin_accepts_the_correct_pin_and_rejects_a_wrong_one() {
        let verifier = derive_verifier(b"123456", &SALT, &PEPPER).unwrap();
        assert_eq!(verify_pin(b"123456", &SALT, &PEPPER, &verifier), Ok(true));
        assert_eq!(verify_pin(b"999999", &SALT, &PEPPER, &verifier), Ok(false));
    }

    #[test]
    fn verify_pin_rejects_a_wrong_pepper_device_binding() {
        let verifier = derive_verifier(b"123456", &SALT, &PEPPER).unwrap();
        assert_eq!(verify_pin(b"123456", &SALT, &[0x99; 32], &verifier), Ok(false));
    }

    #[test]
    fn output_length_matches_the_frozen_hash_len() {
        let verifier = derive_verifier(b"123456", &SALT, &PEPPER).unwrap();
        assert_eq!(verifier.len(), ARGON2_HASH_LEN);
    }
}
