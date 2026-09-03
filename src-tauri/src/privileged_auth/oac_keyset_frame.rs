//! SEC-001 Packet C-A — parses and integrity-checks the OKS1 keyset manifest
//! fetched (while online) via `getOacKeysetManifest` and cached on-device.
//! Verified against its own embedded primary (index 0) signing key as an
//! at-rest integrity check for the cached copy — authenticity in transit
//! already comes from the authenticated Functions-callable/TLS channel that
//! delivered it (see `functions/src/oacKeysetManifestCore.ts`).

use super::frames::{decode_oks1, oks1_signed_prefix, OacKeysetManifestFrameV1};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OacKeysetFrameError {
    Malformed,
    NoKeys,
    BadPrimaryKey,
    BadSignature,
}

/// Decodes an OKS1 blob and verifies it against its own embedded primary key.
pub fn parse_and_verify_oac_keyset(bytes: &[u8]) -> Result<OacKeysetManifestFrameV1, OacKeysetFrameError> {
    let frame = decode_oks1(bytes).map_err(|_| OacKeysetFrameError::Malformed)?;
    let primary = frame.keys.first().ok_or(OacKeysetFrameError::NoKeys)?;
    let verifying_key = VerifyingKey::from_bytes(&primary.public_key).map_err(|_| OacKeysetFrameError::BadPrimaryKey)?;
    let prefix = oks1_signed_prefix(&frame).map_err(|_| OacKeysetFrameError::Malformed)?;
    let signature = Signature::from_bytes(&frame.signature);
    verifying_key
        .verify(&prefix, &signature)
        .map_err(|_| OacKeysetFrameError::BadSignature)?;
    Ok(frame)
}

/// Looks up a specific signing key's raw public-key bytes by id, for
/// verifying an individual OAC envelope's signature.
pub fn find_signing_key<'a>(
    manifest: &'a OacKeysetManifestFrameV1,
    signing_key_id: &str,
) -> Option<&'a [u8; 32]> {
    manifest
        .keys
        .iter()
        .find(|k| k.signing_key_id == signing_key_id)
        .map(|k| &k.public_key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::privileged_auth::frames::{encode_oks1, OacKeysetManifestKeyV1};
    use ed25519_dalek::{Signer, SigningKey};
    use rand::rngs::OsRng;

    fn signed_manifest(signing_key: &SigningKey, revocation_epoch: u32) -> Vec<u8> {
        let public_key = signing_key.verifying_key().to_bytes();
        let unsigned = OacKeysetManifestFrameV1 {
            revocation_epoch,
            generated_at_server_ms: 1000,
            keys: vec![OacKeysetManifestKeyV1 { signing_key_id: "key-1".to_string(), public_key }],
            signature: [0u8; 64],
        };
        let prefix = oks1_signed_prefix(&unsigned).unwrap();
        let signature = signing_key.sign(&prefix).to_bytes();
        encode_oks1(&OacKeysetManifestFrameV1 { signature, ..unsigned }).unwrap()
    }

    #[test]
    fn parses_and_verifies_a_validly_signed_manifest() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let bytes = signed_manifest(&signing_key, 3);
        let manifest = parse_and_verify_oac_keyset(&bytes).unwrap();
        assert_eq!(manifest.revocation_epoch, 3);
        assert_eq!(manifest.keys.len(), 1);
    }

    #[test]
    fn rejects_a_tampered_manifest() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let mut bytes = signed_manifest(&signing_key, 3);
        // Flip a byte in the revocation epoch field (offset 5, right after magic+version).
        bytes[5] ^= 0xFF;
        assert_eq!(parse_and_verify_oac_keyset(&bytes), Err(OacKeysetFrameError::BadSignature));
    }

    #[test]
    fn rejects_malformed_bytes() {
        assert_eq!(parse_and_verify_oac_keyset(b"garbage"), Err(OacKeysetFrameError::Malformed));
    }

    #[test]
    fn find_signing_key_locates_the_right_key() {
        let signing_key = SigningKey::generate(&mut OsRng);
        let bytes = signed_manifest(&signing_key, 0);
        let manifest = parse_and_verify_oac_keyset(&bytes).unwrap();
        assert_eq!(find_signing_key(&manifest, "key-1"), Some(&signing_key.verifying_key().to_bytes()));
        assert_eq!(find_signing_key(&manifest, "missing"), None);
    }
}
