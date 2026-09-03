//! SEC-001 Packet C-A — canonical `securityDeviceId`: a random 16-byte
//! (UUID v4 shaped) identifier generated once per installation and persisted
//! to disk, so the same physical terminal always presents the same device
//! identity across restarts (and across a re-registration after wipe, if the
//! marker file survives). Not secret — it is the DRP1 `securityDeviceId`
//! field, transmitted in the clear.

use rand::RngCore;
use std::fs;
use std::path::{Path, PathBuf};

pub const SECURITY_DEVICE_ID_FILE_NAME: &str = "twinpet-security-device-id";
pub const SECURITY_DEVICE_ID_LEN: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecurityDeviceIdError {
    Corrupt,
    Io,
}

pub fn security_device_id_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(SECURITY_DEVICE_ID_FILE_NAME)
}

/// Sets the UUID v4 version/variant bits on 16 random bytes (RFC 4122 §4.4).
fn stamp_uuid_v4_bits(bytes: &mut [u8; SECURITY_DEVICE_ID_LEN]) {
    bytes[6] = (bytes[6] & 0x0F) | 0x40;
    bytes[8] = (bytes[8] & 0x3F) | 0x80;
}

fn generate_id() -> [u8; SECURITY_DEVICE_ID_LEN] {
    let mut bytes = [0u8; SECURITY_DEVICE_ID_LEN];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    stamp_uuid_v4_bits(&mut bytes);
    bytes
}

fn write_atomic(path: &Path, bytes: &[u8; SECURITY_DEVICE_ID_LEN]) -> Result<(), SecurityDeviceIdError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| SecurityDeviceIdError::Io)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|_| SecurityDeviceIdError::Io)?;
    fs::rename(&tmp, path).map_err(|_| SecurityDeviceIdError::Io)
}

/// Reads the persisted device id, or generates and persists a fresh one if
/// this is the first run. Fails closed (never silently regenerates) if the
/// marker file exists but is corrupt/wrong-length — a device losing its
/// identity mid-lifetime must be an explicit re-enrollment, not silent drift.
pub fn resolve_or_create_security_device_id(
    app_data_dir: &Path,
) -> Result<[u8; SECURITY_DEVICE_ID_LEN], SecurityDeviceIdError> {
    let path = security_device_id_path(app_data_dir);
    match fs::read(&path) {
        Ok(bytes) => {
            if bytes.len() != SECURITY_DEVICE_ID_LEN {
                return Err(SecurityDeviceIdError::Corrupt);
            }
            let mut out = [0u8; SECURITY_DEVICE_ID_LEN];
            out.copy_from_slice(&bytes);
            Ok(out)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let id = generate_id();
            write_atomic(&path, &id)?;
            Ok(id)
        }
        Err(_) => Err(SecurityDeviceIdError::Io),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        // A per-process atomic counter (not just a timestamp) guarantees
        // uniqueness across concurrently-running test threads even when the
        // OS clock's effective resolution is coarser than the time between
        // two calls (observed flakiness otherwise: two parallel tests could
        // otherwise collide on the same directory).
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "twinpet-device-id-test-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            n
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn first_run_generates_and_persists() {
        let dir = temp_dir();
        let id = resolve_or_create_security_device_id(&dir).unwrap();
        assert_eq!(id.len(), SECURITY_DEVICE_ID_LEN);
        // UUID v4 shape: version nibble 4, variant bits 10xx.
        assert_eq!(id[6] & 0xF0, 0x40);
        assert_eq!(id[8] & 0xC0, 0x80);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn second_run_returns_the_same_id() {
        let dir = temp_dir();
        let first = resolve_or_create_security_device_id(&dir).unwrap();
        let second = resolve_or_create_security_device_id(&dir).unwrap();
        assert_eq!(first, second);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn distinct_installs_get_distinct_ids() {
        let dir_a = temp_dir();
        let dir_b = temp_dir();
        let a = resolve_or_create_security_device_id(&dir_a).unwrap();
        let b = resolve_or_create_security_device_id(&dir_b).unwrap();
        assert_ne!(a, b);
        let _ = fs::remove_dir_all(&dir_a);
        let _ = fs::remove_dir_all(&dir_b);
    }

    #[test]
    fn corrupt_marker_fails_closed() {
        let dir = temp_dir();
        fs::write(security_device_id_path(&dir), b"short").unwrap();
        assert_eq!(resolve_or_create_security_device_id(&dir), Err(SecurityDeviceIdError::Corrupt));
        let _ = fs::remove_dir_all(&dir);
    }
}
