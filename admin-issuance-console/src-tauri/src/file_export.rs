//! SEC-001 Packet C-A — writes the final ENR1 enrollment-authorization bytes
//! (returned by `completeDeviceEnrollmentAuthorizationIssuance`) to a file
//! the operator transfers to the POS terminal (D17 — `OPTION_A_ENROLLMENT_FILE`).

use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileExportError {
    InvalidBase64,
    Empty,
    Io,
}

fn base64_std_index_of(c: u8) -> Option<u8> {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    ALPHABET.iter().position(|&x| x == c).map(|i| i as u8)
}

fn base64_decode_std(input: &str) -> Result<Vec<u8>, FileExportError> {
    let cleaned: Vec<u8> = input.bytes().filter(|&b| b != b'=' && !b.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(cleaned.len() * 3 / 4);
    for chunk in cleaned.chunks(4) {
        let vals: Vec<u8> = chunk
            .iter()
            .map(|&b| base64_std_index_of(b).ok_or(FileExportError::InvalidBase64))
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

/// Writes the decoded ENR1 bytes to `target_path`. The write is atomic
/// (write to a sibling `.tmp` then rename) so a crash never leaves a
/// half-written enrollment file for the operator to accidentally transfer.
pub fn export_enrollment_file(target_path: &Path, enr1_base64: &str) -> Result<(), FileExportError> {
    let bytes = base64_decode_std(enr1_base64)?;
    if bytes.is_empty() {
        return Err(FileExportError::Empty);
    }
    if let Some(parent) = target_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|_| FileExportError::Io)?;
        }
    }
    let tmp: PathBuf = target_path.with_extension("tmp");
    fs::write(&tmp, &bytes).map_err(|_| FileExportError::Io)?;
    fs::rename(&tmp, target_path).map_err(|_| FileExportError::Io)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "twinpet-file-export-test-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
            n
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn writes_the_decoded_bytes_to_disk() {
        let dir = temp_dir();
        let target = dir.join("enrollment.enr1");
        export_enrollment_file(&target, "aGVsbG8=").unwrap(); // "hello"
        assert_eq!(fs::read(&target).unwrap(), b"hello".to_vec());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_empty_content() {
        let dir = temp_dir();
        let target = dir.join("empty.enr1");
        assert_eq!(export_enrollment_file(&target, ""), Err(FileExportError::Empty));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_invalid_base64() {
        let dir = temp_dir();
        let target = dir.join("bad.enr1");
        assert_eq!(export_enrollment_file(&target, "***not-base64***"), Err(FileExportError::InvalidBase64));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn creates_missing_parent_directories() {
        let dir = temp_dir();
        let target = dir.join("nested").join("sub").join("enrollment.enr1");
        export_enrollment_file(&target, "aGVsbG8=").unwrap();
        assert!(target.exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
