//! SEC-001 Packet C-A — parses/validates the one-time bootstrap credential
//! pasted by the operator from
//! `ops/issuerBootstrap/createIssuerBootstrapAuthorization.ts`'s console
//! output (`{tokenId}:{rawToken}`, tokenId = 32 lowercase hex chars, rawToken
//! = base64url of 32 random bytes). Structural validation only — the actual
//! bootstrap-token authorization decision is server-side
//! (`issuerRegistrationCore.ts::verifyBootstrapToken`).

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedBootstrapImport {
    pub token_id: String,
    pub raw_token: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BootstrapImportError {
    Malformed,
    InvalidTokenId,
    InvalidRawToken,
}

fn is_lowercase_hex32(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn base64url_index_of(c: u8) -> Option<u8> {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    ALPHABET.iter().position(|&x| x == c).map(|i| i as u8)
}

fn base64url_decode(input: &str) -> Option<Vec<u8>> {
    let cleaned: Vec<u8> = input.bytes().filter(|&b| b != b'=' && !b.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(cleaned.len() * 3 / 4);
    for chunk in cleaned.chunks(4) {
        let vals: Vec<u8> = chunk.iter().map(|&b| base64url_index_of(b)).collect::<Option<_>>()?;
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
    Some(out)
}

/// Parses the operator-pasted `{tokenId}:{rawToken}` credential string.
pub fn parse_bootstrap_import(input: &str) -> Result<ParsedBootstrapImport, BootstrapImportError> {
    let trimmed = input.trim();
    let mut parts = trimmed.splitn(2, ':');
    let token_id = parts.next().ok_or(BootstrapImportError::Malformed)?;
    let raw_token = parts.next().ok_or(BootstrapImportError::Malformed)?;
    if token_id.is_empty() || raw_token.is_empty() {
        return Err(BootstrapImportError::Malformed);
    }
    if !is_lowercase_hex32(token_id) {
        return Err(BootstrapImportError::InvalidTokenId);
    }
    let decoded = base64url_decode(raw_token).ok_or(BootstrapImportError::InvalidRawToken)?;
    if decoded.len() != 32 {
        return Err(BootstrapImportError::InvalidRawToken);
    }
    Ok(ParsedBootstrapImport { token_id: token_id.to_string(), raw_token: raw_token.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_raw_token() -> String {
        // base64url of 32 arbitrary bytes.
        "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8".to_string()
    }

    #[test]
    fn parses_a_well_formed_credential() {
        let input = format!("{}:{}", "00112233445566778899aabbccddeeff", sample_raw_token());
        let parsed = parse_bootstrap_import(&input).unwrap();
        assert_eq!(parsed.token_id, "00112233445566778899aabbccddeeff");
        assert_eq!(parsed.raw_token, sample_raw_token());
    }

    #[test]
    fn trims_surrounding_whitespace() {
        let input = format!("  {}:{}  \n", "00112233445566778899aabbccddeeff", sample_raw_token());
        assert!(parse_bootstrap_import(&input).is_ok());
    }

    #[test]
    fn rejects_a_missing_separator() {
        assert_eq!(parse_bootstrap_import("no-separator-here"), Err(BootstrapImportError::Malformed));
    }

    #[test]
    fn rejects_a_non_hex_token_id() {
        let input = format!("{}:{}", "not-32-hex-chars", sample_raw_token());
        assert_eq!(parse_bootstrap_import(&input), Err(BootstrapImportError::InvalidTokenId));
    }

    #[test]
    fn rejects_a_wrong_length_raw_token() {
        let input = "00112233445566778899aabbccddeeff:short".to_string();
        assert_eq!(parse_bootstrap_import(&input), Err(BootstrapImportError::InvalidRawToken));
    }
}
