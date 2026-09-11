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

/// SEC-001 epoch-2 rollback remediation (Claude-024 / Gemini-041 authority):
/// current versioned on-disk shape is a 1-byte version prefix followed by
/// the 16-byte id. The prior packet's writer deliberately stayed unversioned
/// because out-of-scope call sites (`staff_session.rs`, `mod.rs`,
/// `enrollment_meta.rs`) read this file directly with an exact-length
/// assumption; those call sites are now migrated to the centralized
/// `decode_security_device_id_bytes` below, so the writer emits the
/// versioned shape from this build onward. Exact legacy 16-byte files
/// remain fully readable (never rejected, never rewritten in place).
pub const SECURITY_DEVICE_ID_STORE_VERSION: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecurityDeviceIdError {
    Corrupt,
    Io,
    UnknownVersion,
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

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), SecurityDeviceIdError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| SecurityDeviceIdError::Io)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|_| SecurityDeviceIdError::Io)?;
    fs::rename(&tmp, path).map_err(|_| SecurityDeviceIdError::Io)
}

/// Current versioned on-disk payload: 1-byte version prefix + the 16-byte id.
pub fn versioned_payload(id: &[u8; SECURITY_DEVICE_ID_LEN]) -> Vec<u8> {
    let mut out = Vec::with_capacity(SECURITY_DEVICE_ID_LEN + 1);
    out.push(SECURITY_DEVICE_ID_STORE_VERSION);
    out.extend_from_slice(id);
    out
}

/// Centralized decode/validation for the on-disk security-device-id payload:
/// accepts the exact legacy unversioned 16-byte shape and the current
/// versioned 17-byte shape, rejects an unknown newer version, and rejects
/// any other length as corrupt/truncated. Every production consumer must go
/// through this (or `resolve_or_create_security_device_id`, which uses it)
/// rather than re-deriving its own length assumption.
pub fn decode_security_device_id_bytes(
    bytes: &[u8],
) -> Result<[u8; SECURITY_DEVICE_ID_LEN], SecurityDeviceIdError> {
    if bytes.len() == SECURITY_DEVICE_ID_LEN {
        let mut out = [0u8; SECURITY_DEVICE_ID_LEN];
        out.copy_from_slice(bytes);
        return Ok(out);
    }
    if bytes.len() != SECURITY_DEVICE_ID_LEN + 1 {
        return Err(SecurityDeviceIdError::Corrupt);
    }
    if bytes[0] != SECURITY_DEVICE_ID_STORE_VERSION {
        return Err(SecurityDeviceIdError::UnknownVersion);
    }
    let mut out = [0u8; SECURITY_DEVICE_ID_LEN];
    out.copy_from_slice(&bytes[1..]);
    Ok(out)
}

/// Reads the persisted device id via the centralized decoder, without
/// auto-creating. Returns `Ok(None)` only when the file does not exist;
/// any decode failure (corrupt bytes or an unknown newer version) is
/// propagated so a caller cannot silently treat unreadable prefixed content
/// as "not yet registered".
pub fn read_persisted_security_device_id(
    app_data_dir: &Path,
) -> Result<Option<[u8; SECURITY_DEVICE_ID_LEN]>, SecurityDeviceIdError> {
    let path = security_device_id_path(app_data_dir);
    match fs::read(&path) {
        Ok(bytes) => decode_security_device_id_bytes(&bytes).map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(SecurityDeviceIdError::Io),
    }
}

/// Reads the persisted device id, or generates and persists a fresh one if
/// this is the first run. Fails closed (never silently regenerates) if the
/// marker file exists but is corrupt/wrong-length — a device losing its
/// identity mid-lifetime must be an explicit re-enrollment, not silent drift.
/// The writer emits the current versioned shape; legacy unversioned files
/// remain readable and are never rewritten by this function.
pub fn resolve_or_create_security_device_id(
    app_data_dir: &Path,
) -> Result<[u8; SECURITY_DEVICE_ID_LEN], SecurityDeviceIdError> {
    let path = security_device_id_path(app_data_dir);
    match fs::read(&path) {
        Ok(bytes) => decode_security_device_id_bytes(&bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let id = generate_id();
            write_atomic(&path, &versioned_payload(&id))?;
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
        assert_eq!(
            resolve_or_create_security_device_id(&dir),
            Err(SecurityDeviceIdError::Corrupt)
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_unversioned_id_reads_unchanged_and_is_not_rewritten() {
        // A pre-existing legacy (unversioned, exactly 16-byte) file must
        // remain fully readable and must never be rewritten in place by the
        // read path, even though the writer now emits the versioned shape
        // for fresh installs.
        let dir = temp_dir();
        let mut legacy = [0u8; SECURITY_DEVICE_ID_LEN];
        for (i, b) in legacy.iter_mut().enumerate() {
            *b = i as u8;
        }
        fs::write(security_device_id_path(&dir), legacy).unwrap();

        let read_back = resolve_or_create_security_device_id(&dir).unwrap();
        assert_eq!(read_back, legacy);

        let on_disk = fs::read(security_device_id_path(&dir)).unwrap();
        assert_eq!(on_disk, legacy);

        let second = resolve_or_create_security_device_id(&dir).unwrap();
        assert_eq!(second, legacy);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_current_versioned_shape_round_trips_and_a_fresh_write_emits_it() {
        let dir = temp_dir();
        let id = [9u8; SECURITY_DEVICE_ID_LEN];
        fs::write(security_device_id_path(&dir), versioned_payload(&id)).unwrap();

        let read_back = resolve_or_create_security_device_id(&dir).unwrap();
        assert_eq!(read_back, id);

        // SEC-001 epoch-2 rollback remediation (Claude-024): a fresh
        // first-run creation now writes the current versioned shape.
        let fresh_dir = temp_dir();
        let fresh = resolve_or_create_security_device_id(&fresh_dir).unwrap();
        let on_disk = fs::read(security_device_id_path(&fresh_dir)).unwrap();
        assert_eq!(on_disk.len(), SECURITY_DEVICE_ID_LEN + 1);
        assert_eq!(on_disk[0], SECURITY_DEVICE_ID_STORE_VERSION);
        assert_eq!(&on_disk[1..], &fresh[..]);

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&fresh_dir);
    }

    /// SEC-001 epoch-2 rollback remediation (Claude-024): a device-not-yet-
    /// registered probe (`read_persisted_security_device_id`) must return
    /// `Ok(None)` only for a genuinely absent file, and must not silently
    /// collapse a versioned (or any other decode-failure) file into "absent".
    #[test]
    fn read_persisted_security_device_id_distinguishes_absent_from_unreadable() {
        let dir = temp_dir();
        assert_eq!(read_persisted_security_device_id(&dir), Ok(None));

        let id = resolve_or_create_security_device_id(&dir).unwrap();
        assert_eq!(read_persisted_security_device_id(&dir), Ok(Some(id)));
        let _ = fs::remove_dir_all(&dir);

        let corrupt_dir = temp_dir();
        fs::write(security_device_id_path(&corrupt_dir), b"short").unwrap();
        assert_eq!(
            read_persisted_security_device_id(&corrupt_dir),
            Err(SecurityDeviceIdError::Corrupt)
        );
        let _ = fs::remove_dir_all(&corrupt_dir);
    }

    #[test]
    fn unknown_newer_id_version_fails_closed() {
        let dir = temp_dir();
        let mut payload = vec![SECURITY_DEVICE_ID_STORE_VERSION + 1];
        payload.extend_from_slice(&[5u8; SECURITY_DEVICE_ID_LEN]);
        fs::write(security_device_id_path(&dir), &payload).unwrap();
        assert_eq!(
            resolve_or_create_security_device_id(&dir),
            Err(SecurityDeviceIdError::UnknownVersion)
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
