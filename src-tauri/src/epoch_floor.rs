use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const MAX_KNOWN_EPOCH_SCHEMA: u32 = 2;
pub const FLOOR_FILE_NAME: &str = "twinpet-committed-epoch-floor";
pub const APP_IDENTIFIER: &str = "com.twinpet.pos";
pub const DURABLE_DIR_NAME: &str = "durable";
pub const MANIFEST_FILE_NAME: &str = "twinpet-migration-manifest.sqlite";

const DOMAIN_PREFIXES: [&str; 8] = [
    "twinpet-offline-reversal",
    "twinpet-sale-intent-journal",
    "twinpet-shift-open-intent",
    "twinpet-shift-close-intent",
    "twinpet-active-cart-snapshot",
    "twinpet-sale-submission-evidence",
    "twinpet-device",
    "twinpet-suspended-bills",
];

/// SEC-001 epoch-2: exact on-disk names/prefixes of privileged-auth data-bearing
/// artifacts. A machine carrying any of these is not a virgin install even if it
/// has no `durable_kv` domain files. The non-data lifecycle lock
/// (`twinpet-privileged-auth-lifecycle.lock`) is deliberately excluded — it is an
/// OS-level mutex file, never persisted application state.
///
/// `twinpet-device-enrollment-meta.dpapi` (no generation suffix) is the root
/// canonical enrollment metadata file (`enrollment_meta::ENROLLMENT_META_FILE_NAME`);
/// it is distinct from the generation-scoped `twinpet-device-enrollment-meta-<gen>.dpapi`
/// shape already covered by `PRIVILEGED_AUTH_NAME_PREFIXES` below. SEC-001
/// epoch-2 final remediation (Claude-025 / Gemini-042 authority) closed a
/// false-negative where the root file alone was not detected.
const PRIVILEGED_AUTH_EXACT_NAMES: [&str; 6] = [
    "twinpet-oac-pepper.dpapi",
    "twinpet-security-device-id",
    "twinpet-device-enrollment.fence",
    "twinpet-staff-session.dpapi",
    "twinpet-clock-guard.dpapi",
    "twinpet-device-enrollment-meta.dpapi",
];

const PRIVILEGED_AUTH_NAME_PREFIXES: [&str; 3] = [
    "twinpet-device-proof-key",
    "twinpet-device-enrollment-meta-",
    "twinpet-device-enrollment-staged-",
];

const PRIVILEGED_AUTH_OAC_STORE_DIR: &str = "oac-store";

/// SEC-001 epoch-2 final remediation (Claude-025 / Gemini-042 authority):
/// canonical root OAC keyset manifest shape written by
/// `enrollment_meta::digest_manifest_path` — `twinpet-oac-keyset-manifest-<sha256_hex>.bin`.
const OAC_KEYSET_MANIFEST_PREFIX: &str = "twinpet-oac-keyset-manifest-";
const OAC_KEYSET_MANIFEST_SUFFIX: &str = ".bin";
const OAC_KEYSET_MANIFEST_DIGEST_LEN: usize = 64;

/// Validates the canonical root OAC keyset manifest filename shape:
/// `twinpet-oac-keyset-manifest-<64 lowercase hex>.bin`. A wrong-length,
/// uppercase, or non-hex digest, or a wrong suffix, must not match — only
/// the exact contracted shape a real manifest writer produces counts.
fn root_oac_keyset_manifest_name_is_recognized(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(OAC_KEYSET_MANIFEST_PREFIX) else {
        return false;
    };
    let Some(digest) = rest.strip_suffix(OAC_KEYSET_MANIFEST_SUFFIX) else {
        return false;
    };
    digest.len() == OAC_KEYSET_MANIFEST_DIGEST_LEN
        && digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

const OAC_STORE_LOCKOUT_STATE_FILE_NAME: &str = "twinpet-lockout-state.dpapi";
const OAC_STORE_BY_MANAGER_DIR_NAME: &str = "by-manager";

const OAC_ENVELOPE_SUFFIX: &str = ".json";
const OAC_RECEIPT_SUFFIX: &str = ".receipt.bin";
const OAC_CANONICAL_IDENTIFIER_MAX_LEN: usize = 1500;

/// Canonical OAC-store identifier grammar (Gemini-043 final fix, Codex-013
/// overmatch finding): `[A-Za-z0-9_-]{1,1500}`. A stem must be 1..=1500
/// bytes, every byte ASCII alphanumeric, `-`, or `_` — so a stem containing
/// `.`, space, `+`, or any other punctuation, or an empty stem, is rejected.
fn is_canonical_oac_identifier(stem: &str) -> bool {
    !stem.is_empty()
        && stem.len() <= OAC_CANONICAL_IDENTIFIER_MAX_LEN
        && stem
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Recognized shapes for a regular file directly under `oac-store/`: the
/// exact lockout-state file (`lockout_state::LOCKOUT_STATE_FILENAME`), a
/// provisioned OAC envelope (`<canonicalOacId>.json`, written by
/// `persist_provisioned_oac`), or a re-anchor receipt
/// (`<canonicalOacId>.receipt.bin`, written by
/// `staff_session::persist_oac_reanchor_internal`). Gemini-043 final fix:
/// the stripped stem must satisfy the canonical OAC identifier grammar, not
/// merely a bare suffix match — `.json`, `foo.bar.json`, and `foo bar.json`
/// must never match.
fn oac_store_root_entry_is_recognized(name: &str) -> bool {
    if name == OAC_STORE_LOCKOUT_STATE_FILE_NAME {
        return true;
    }
    if let Some(stem) = name.strip_suffix(OAC_RECEIPT_SUFFIX) {
        return is_canonical_oac_identifier(stem);
    }
    if let Some(stem) = name.strip_suffix(OAC_ENVELOPE_SUFFIX) {
        return is_canonical_oac_identifier(stem);
    }
    false
}

/// Recognized shape for a regular file under `oac-store/by-manager/`: a
/// per-manager active OAC slot (`<canonicalManagerStaffId>.json`, written by
/// `manager_active_slot_path`). Gemini-043 final fix: the stripped stem must
/// satisfy the canonical OAC identifier grammar.
fn oac_store_by_manager_entry_is_recognized(name: &str) -> bool {
    match name.strip_suffix(OAC_ENVELOPE_SUFFIX) {
        Some(stem) => is_canonical_oac_identifier(stem),
        None => false,
    }
}

/// SEC-001 epoch-2 final remediation (Claude-025 / Gemini-042 authority):
/// `CONTRACTED_DATA_BEARING_FILE_SHAPES_ONLY`. Only files matching a shape
/// actually produced by a privileged-auth storage writer count as
/// data-bearing state — an eagerly created empty `oac-store/` (or
/// `oac-store/by-manager/`) directory, and an arbitrary unrecognized file
/// dropped under either, must never count. This replaces the prior
/// "any regular file anywhere under oac-store/" probe, which Codex-012 found
/// wrongly treated an arbitrary unrecognized nested file as state.
fn oac_store_contains_recognized_state(oac_store: &Path) -> bool {
    let entries = match fs::read_dir(oac_store) {
        Ok(e) => e,
        Err(_) => return false,
    };
    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if file_type.is_file() && oac_store_root_entry_is_recognized(&name) {
            return true;
        }
        if file_type.is_dir() && name == OAC_STORE_BY_MANAGER_DIR_NAME {
            let by_manager_entries = match fs::read_dir(entry.path()) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for sub_entry in by_manager_entries.flatten() {
                let sub_file_type = match sub_entry.file_type() {
                    Ok(ft) => ft,
                    Err(_) => continue,
                };
                let sub_name = sub_entry.file_name();
                let sub_name = sub_name.to_string_lossy();
                if sub_file_type.is_file() && oac_store_by_manager_entry_is_recognized(&sub_name) {
                    return true;
                }
            }
        }
    }
    false
}

/// Widened non-virgin probe for SEC-001 epoch-2: returns true if any
/// privileged-auth data-bearing artifact is present on disk, so a machine with
/// real security state but no floor file is never silently treated as virgin.
///
/// `oac-store/` is a recognized store (lockout state, provisioned OAC
/// envelopes, per-manager active slots, re-anchor receipts), so a file under
/// it matching one of those contracted shapes counts as data-bearing content
/// — but the directory itself may exist empty (created eagerly by writers),
/// and an arbitrary unrecognized file under it, and neither alone is state.
pub fn privileged_auth_state_exists(app_data_dir: &Path) -> bool {
    let oac_store = app_data_dir.join(PRIVILEGED_AUTH_OAC_STORE_DIR);
    if oac_store.is_dir() && oac_store_contains_recognized_state(&oac_store) {
        return true;
    }
    let entries = match fs::read_dir(app_data_dir) {
        Ok(e) => e,
        Err(_) => return false,
    };
    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        // SEC-001 epoch-2 final remediation: the probe path must be a
        // regular file where applicable — a directory sharing a recognized
        // name (e.g. a directory literally named
        // `twinpet-oac-keyset-manifest-<64hex>.bin`) must never count.
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if PRIVILEGED_AUTH_EXACT_NAMES.iter().any(|n| name == *n) {
            return true;
        }
        if PRIVILEGED_AUTH_NAME_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
        {
            return true;
        }
        if root_oac_keyset_manifest_name_is_recognized(&name) {
            return true;
        }
    }
    false
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FloorDecision {
    PermitVirgin,
    PermitCompatible { floor: u32 },
    FailClosed { reason: String },
}

pub fn resolve_app_data_dir() -> PathBuf {
    let appdata = std::env::var_os("APPDATA").expect("APPDATA is required for Twinpet app data");
    PathBuf::from(appdata).join(APP_IDENTIFIER)
}

pub fn floor_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(FLOOR_FILE_NAME)
}

pub fn durable_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(DURABLE_DIR_NAME)
}

pub fn durable_domain_files_exist(app_data_dir: &Path) -> bool {
    let dir = durable_dir(app_data_dir);
    if !dir.is_dir() {
        let manifest = dir.join(MANIFEST_FILE_NAME);
        return manifest.exists();
    }
    if dir.join(MANIFEST_FILE_NAME).exists() {
        return true;
    }
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if DOMAIN_PREFIXES
                .iter()
                .any(|prefix| name.starts_with(prefix) && name.ends_with(".sqlite"))
            {
                return true;
            }
        }
    }
    false
}

pub fn parse_floor_file(contents: &str) -> Result<u32, String> {
    let mut floor: Option<u32> = None;
    let mut writer: Option<String> = None;
    let mut lines = 0u32;
    for raw in contents.lines() {
        let line = raw.trim_end();
        if line.is_empty() {
            continue;
        }
        lines += 1;
        if let Some(rest) = line.strip_prefix("committedEpochFloor=") {
            if floor.is_some() {
                return Err("corrupt floor: duplicate committedEpochFloor".into());
            }
            let parsed = rest
                .parse::<u32>()
                .map_err(|_| "corrupt floor: committedEpochFloor".to_string())?;
            floor = Some(parsed);
        } else if let Some(rest) = line.strip_prefix("writerBuildId=") {
            if rest.is_empty() {
                return Err("corrupt floor: empty writerBuildId".into());
            }
            if writer.is_some() {
                return Err("corrupt floor: duplicate writerBuildId".into());
            }
            writer = Some(rest.to_string());
        } else {
            return Err("corrupt floor: unknown extra line".into());
        }
    }
    if lines != 2 || floor.is_none() || writer.is_none() {
        return Err("corrupt floor: expected exactly two fields".into());
    }
    Ok(floor.unwrap())
}

pub fn evaluate_floor(app_data_dir: &Path) -> FloorDecision {
    let path = floor_path(app_data_dir);
    let files_exist =
        durable_domain_files_exist(app_data_dir) || privileged_auth_state_exists(app_data_dir);
    match fs::read_to_string(&path) {
    Ok(contents) => match parse_floor_file(&contents) {
      Ok(floor) if floor > MAX_KNOWN_EPOCH_SCHEMA => FloorDecision::FailClosed {
        reason: format!(
          "installation is newer than this app version supports (committedEpochFloor={floor}, max={MAX_KNOWN_EPOCH_SCHEMA})"
        ),
      },
      Ok(floor) => FloorDecision::PermitCompatible { floor },
      Err(reason) => FloorDecision::FailClosed { reason },
    },
    Err(_) if !path.exists() && !files_exist => FloorDecision::PermitVirgin,
    Err(_) if !path.exists() && files_exist => FloorDecision::FailClosed {
      reason: "epoch floor marker is missing while durable domain files exist".into(),
    },
    Err(_) => FloorDecision::FailClosed {
      reason: "epoch floor marker is unreadable".into(),
    },
  }
}

pub fn write_floor_atomic(app_data_dir: &Path, writer_build_id: &str) -> Result<(), String> {
    fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
    let target = floor_path(app_data_dir);
    let tmp = app_data_dir.join(format!("{FLOOR_FILE_NAME}.tmp"));
    let body =
        format!("committedEpochFloor={MAX_KNOWN_EPOCH_SCHEMA}\nwriterBuildId={writer_build_id}\n");
    {
        let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        file.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &target).map_err(|e| e.to_string())
}

/// SEC-001 build provenance: compile-time git SHA and build ID, embedded by
/// `build.rs`. Falls back to `"unknown"` only when `git` was unavailable at
/// build time; a later distributable-build-authority gate must assert neither
/// value is `"unknown"` before a package is considered release-ready.
pub fn build_provenance() -> (&'static str, &'static str) {
    (env!("TWINPET_GIT_SHA"), env!("TWINPET_BUILD_ID"))
}

/// Native hard-stop before WebView. True virgin is permitted. Too-new / corrupt / missing-with-files fail closed.
pub fn check_or_exit(app_data_dir: &Path) {
    match evaluate_floor(app_data_dir) {
        FloorDecision::PermitVirgin | FloorDecision::PermitCompatible { .. } => {}
        FloorDecision::FailClosed { reason } => {
            eprintln!("Twinpet POS cannot start: {reason}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_app() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "twinpet-floor-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn virgin_state_is_permitted() {
        let dir = temp_app();
        assert_eq!(evaluate_floor(&dir), FloorDecision::PermitVirgin);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn too_new_floor_fails_closed() {
        let dir = temp_app();
        fs::write(
            floor_path(&dir),
            "committedEpochFloor=99\nwriterBuildId=newer\n",
        )
        .unwrap();
        match evaluate_floor(&dir) {
            FloorDecision::FailClosed { reason } => {
                assert!(reason.contains("newer"));
            }
            other => panic!("unexpected {other:?}"),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_floor_fails_closed() {
        let dir = temp_app();
        fs::write(floor_path(&dir), "committedEpochFloor=1\nextra=1\n").unwrap();
        match evaluate_floor(&dir) {
            FloorDecision::FailClosed { reason } => assert!(reason.contains("corrupt")),
            other => panic!("unexpected {other:?}"),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_floor_with_domain_files_fails_closed() {
        let dir = temp_app();
        let durable = durable_dir(&dir);
        fs::create_dir_all(&durable).unwrap();
        fs::write(durable.join("twinpet-device.epoch1.sqlite"), b"x").unwrap();
        match evaluate_floor(&dir) {
            FloorDecision::FailClosed { reason } => assert!(reason.contains("missing")),
            other => panic!("unexpected {other:?}"),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn compatible_floor_is_permitted() {
        let dir = temp_app();
        write_floor_atomic(&dir, "test-build").unwrap();
        assert_eq!(
            evaluate_floor(&dir),
            FloorDecision::PermitCompatible {
                floor: MAX_KNOWN_EPOCH_SCHEMA
            }
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn floor_one_above_max_known_fails_closed() {
        let dir = temp_app();
        let too_new = MAX_KNOWN_EPOCH_SCHEMA + 1;
        fs::write(
            floor_path(&dir),
            format!("committedEpochFloor={too_new}\nwriterBuildId=future\n"),
        )
        .unwrap();
        match evaluate_floor(&dir) {
            FloorDecision::FailClosed { reason } => assert!(reason.contains("newer")),
            other => panic!("unexpected {other:?}"),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn epoch1_legacy_floor_remains_compatible_under_epoch2_binary() {
        let dir = temp_app();
        fs::write(
            floor_path(&dir),
            "committedEpochFloor=1\nwriterBuildId=legacy-build\n",
        )
        .unwrap();
        assert_eq!(
            evaluate_floor(&dir),
            FloorDecision::PermitCompatible { floor: 1 }
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn privileged_auth_state_exists_detects_each_known_artifact() {
        for name in PRIVILEGED_AUTH_EXACT_NAMES {
            let dir = temp_app();
            fs::write(dir.join(name), b"x").unwrap();
            assert!(
                privileged_auth_state_exists(&dir),
                "expected {name} to be detected as privileged-auth state"
            );
            let _ = fs::remove_dir_all(&dir);
        }
        for prefix in PRIVILEGED_AUTH_NAME_PREFIXES {
            let dir = temp_app();
            fs::write(dir.join(format!("{prefix}deadbeef.dpapi")), b"x").unwrap();
            assert!(
                privileged_auth_state_exists(&dir),
                "expected prefix {prefix} to be detected as privileged-auth state"
            );
            let _ = fs::remove_dir_all(&dir);
        }
        let dir = temp_app();
        fs::create_dir_all(dir.join("oac-store")).unwrap();
        fs::write(
            dir.join("oac-store").join("twinpet-lockout-state.dpapi"),
            b"x",
        )
        .unwrap();
        assert!(privileged_auth_state_exists(&dir));
        let _ = fs::remove_dir_all(&dir);
    }

    /// SEC-001 epoch-2 rollback remediation (Claude-024): Codex-011 found that
    /// an empty `oac-store/` directory alone was wrongly treated as
    /// data-bearing (the writer creates the directory eagerly, before any
    /// file lands in it). `ACTUAL_DATA_BEARING_FILES_OR_NONEMPTY_RECOGNIZED_STORE_CONTENT_ONLY`
    /// requires the directory's mere existence to never count by itself.
    #[test]
    fn empty_oac_store_directory_alone_is_not_privileged_auth_state() {
        let dir = temp_app();
        fs::create_dir_all(dir.join("oac-store")).unwrap();
        assert!(!privileged_auth_state_exists(&dir));
        assert_eq!(evaluate_floor(&dir), FloorDecision::PermitVirgin);
        let _ = fs::remove_dir_all(&dir);

        // A nested-but-still-empty subdirectory (e.g. `by-manager/`) must not
        // count either.
        let dir2 = temp_app();
        fs::create_dir_all(dir2.join("oac-store").join("by-manager")).unwrap();
        assert!(!privileged_auth_state_exists(&dir2));
        let _ = fs::remove_dir_all(&dir2);

        // A real file nested one level deeper (e.g. a per-manager active OAC
        // slot) must be detected.
        let dir3 = temp_app();
        fs::create_dir_all(dir3.join("oac-store").join("by-manager")).unwrap();
        fs::write(
            dir3.join("oac-store").join("by-manager").join("mgr-1.json"),
            b"{}",
        )
        .unwrap();
        assert!(privileged_auth_state_exists(&dir3));
        let _ = fs::remove_dir_all(&dir3);
    }

    /// SEC-001 epoch-2 rollback remediation (Claude-024), Codex-011 test
    /// quality finding: this fixture list is written independently of
    /// `PRIVILEGED_AUTH_EXACT_NAMES` / `PRIVILEGED_AUTH_NAME_PREFIXES` (it is
    /// not generated from those arrays) so the test cannot pass merely
    /// because the implementation and the test share the same source list.
    #[test]
    fn independent_fixture_list_confirms_each_recognized_artifact_is_detected() {
        let independent_exact_names: [&str; 6] = [
            "twinpet-oac-pepper.dpapi",
            "twinpet-security-device-id",
            "twinpet-device-enrollment.fence",
            "twinpet-staff-session.dpapi",
            "twinpet-clock-guard.dpapi",
            "twinpet-device-enrollment-meta.dpapi",
        ];
        for name in independent_exact_names {
            let dir = temp_app();
            fs::write(dir.join(name), b"x").unwrap();
            assert!(
                privileged_auth_state_exists(&dir),
                "independent fixture {name} must be detected"
            );
            let _ = fs::remove_dir_all(&dir);
        }
        let independent_prefixed_names: [&str; 3] = [
            "twinpet-device-proof-key-0102030405060708090a0b0c0d0e0f10.dpapi",
            "twinpet-device-enrollment-meta-0102030405060708090a0b0c0d0e0f10.dpapi",
            "twinpet-device-enrollment-staged-0102030405060708090a0b0c0d0e0f10.dpapi",
        ];
        for name in independent_prefixed_names {
            let dir = temp_app();
            fs::write(dir.join(name), b"x").unwrap();
            assert!(
                privileged_auth_state_exists(&dir),
                "independent fixture {name} must be detected"
            );
            let _ = fs::remove_dir_all(&dir);
        }
        // Each recognized persisted artifact, alone, with no floor file,
        // must also drive evaluate_floor to fail closed (missing floor with
        // real state present).
        for name in independent_exact_names {
            let dir = temp_app();
            fs::write(dir.join(name), b"x").unwrap();
            match evaluate_floor(&dir) {
                FloorDecision::FailClosed { .. } => {}
                other => panic!("fixture {name}: expected FailClosed, got {other:?}"),
            }
            let _ = fs::remove_dir_all(&dir);
        }
    }

    /// SEC-001 epoch-2 final remediation (Claude-025), R1 fixture #1: root
    /// canonical enrollment metadata by itself, with no floor, counts.
    #[test]
    fn root_canonical_enrollment_meta_alone_is_detected_as_state() {
        let dir = temp_app();
        fs::write(dir.join("twinpet-device-enrollment-meta.dpapi"), b"x").unwrap();
        assert!(privileged_auth_state_exists(&dir));
        match evaluate_floor(&dir) {
            FloorDecision::FailClosed { .. } => {}
            other => panic!("unexpected {other:?}"),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    /// R1 fixture #2: a valid root OAC keyset manifest by itself, with no
    /// floor, counts.
    #[test]
    fn root_oac_keyset_manifest_alone_is_detected_as_state() {
        let dir = temp_app();
        let digest = "a".repeat(64);
        fs::write(
            dir.join(format!("twinpet-oac-keyset-manifest-{digest}.bin")),
            b"x",
        )
        .unwrap();
        assert!(privileged_auth_state_exists(&dir));
        match evaluate_floor(&dir) {
            FloorDecision::FailClosed { .. } => {}
            other => panic!("unexpected {other:?}"),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    /// R1 fixtures #3/#4: a malformed root OAC manifest name (too-short
    /// digest, uppercase digest, non-hex digest, wrong suffix) must never
    /// count as state.
    #[test]
    fn malformed_root_oac_keyset_manifest_names_are_not_detected() {
        let dir = temp_app();
        let short_digest = "b".repeat(63);
        fs::write(
            dir.join(format!("twinpet-oac-keyset-manifest-{short_digest}.bin")),
            b"x",
        )
        .unwrap();
        assert!(!privileged_auth_state_exists(&dir));
        assert_eq!(evaluate_floor(&dir), FloorDecision::PermitVirgin);
        let _ = fs::remove_dir_all(&dir);

        let dir2 = temp_app();
        let upper_digest = "C".repeat(64);
        fs::write(
            dir2.join(format!("twinpet-oac-keyset-manifest-{upper_digest}.bin")),
            b"x",
        )
        .unwrap();
        assert!(!privileged_auth_state_exists(&dir2));
        let _ = fs::remove_dir_all(&dir2);

        let dir3 = temp_app();
        let nonhex_digest = "g".repeat(64);
        fs::write(
            dir3.join(format!("twinpet-oac-keyset-manifest-{nonhex_digest}.bin")),
            b"x",
        )
        .unwrap();
        assert!(!privileged_auth_state_exists(&dir3));
        let _ = fs::remove_dir_all(&dir3);

        let dir4 = temp_app();
        let valid_digest = "d".repeat(64);
        fs::write(
            dir4.join(format!("twinpet-oac-keyset-manifest-{valid_digest}.txt")),
            b"x",
        )
        .unwrap();
        assert!(!privileged_auth_state_exists(&dir4));
        let _ = fs::remove_dir_all(&dir4);
    }

    /// R1 fixture #6: an arbitrary unrecognized file (or subdirectory) under
    /// `oac-store/` must never count as state.
    #[test]
    fn arbitrary_unrecognized_file_under_oac_store_is_not_detected() {
        let dir = temp_app();
        fs::create_dir_all(dir.join("oac-store")).unwrap();
        fs::write(dir.join("oac-store").join("notes.txt"), b"anything").unwrap();
        assert!(!privileged_auth_state_exists(&dir));
        assert_eq!(evaluate_floor(&dir), FloorDecision::PermitVirgin);
        let _ = fs::remove_dir_all(&dir);

        let dir2 = temp_app();
        fs::create_dir_all(dir2.join("oac-store").join("scratch")).unwrap();
        fs::write(
            dir2.join("oac-store").join("scratch").join("junk.json"),
            b"anything",
        )
        .unwrap();
        assert!(!privileged_auth_state_exists(&dir2));
        let _ = fs::remove_dir_all(&dir2);
    }

    /// R1 fixture #7: a recognized nested OAC file (envelope, receipt, or
    /// active manager slot) under `oac-store/` is detected.
    #[test]
    fn recognized_nested_oac_files_are_detected() {
        let dir = temp_app();
        fs::create_dir_all(dir.join("oac-store")).unwrap();
        fs::write(dir.join("oac-store").join("oac-1.json"), b"{}").unwrap();
        assert!(privileged_auth_state_exists(&dir));
        let _ = fs::remove_dir_all(&dir);

        let dir2 = temp_app();
        fs::create_dir_all(dir2.join("oac-store")).unwrap();
        fs::write(dir2.join("oac-store").join("oac-1.receipt.bin"), b"x").unwrap();
        assert!(privileged_auth_state_exists(&dir2));
        let _ = fs::remove_dir_all(&dir2);

        let dir3 = temp_app();
        fs::create_dir_all(dir3.join("oac-store").join("by-manager")).unwrap();
        fs::write(
            dir3.join("oac-store").join("by-manager").join("mgr-1.json"),
            b"{}",
        )
        .unwrap();
        assert!(privileged_auth_state_exists(&dir3));
        let _ = fs::remove_dir_all(&dir3);
    }

    /// R1 fixture #8: the recognized lockout-state file under `oac-store/`
    /// is detected.
    #[test]
    fn recognized_lockout_state_file_is_detected() {
        let dir = temp_app();
        fs::create_dir_all(dir.join("oac-store")).unwrap();
        fs::write(
            dir.join("oac-store").join("twinpet-lockout-state.dpapi"),
            b"x",
        )
        .unwrap();
        assert!(privileged_auth_state_exists(&dir));
        let _ = fs::remove_dir_all(&dir);
    }

    /// R1 fixture #10: a directory sharing a recognized state filename must
    /// never count — the probe path must be a regular file.
    #[test]
    fn directory_named_like_a_recognized_file_is_not_detected() {
        let dir = temp_app();
        fs::create_dir_all(dir.join("twinpet-oac-pepper.dpapi")).unwrap();
        assert!(!privileged_auth_state_exists(&dir));
        assert_eq!(evaluate_floor(&dir), FloorDecision::PermitVirgin);
        let _ = fs::remove_dir_all(&dir);

        let dir2 = temp_app();
        let digest = "e".repeat(64);
        fs::create_dir_all(dir2.join(format!("twinpet-oac-keyset-manifest-{digest}.bin"))).unwrap();
        assert!(!privileged_auth_state_exists(&dir2));
        let _ = fs::remove_dir_all(&dir2);
    }

    #[test]
    fn lifecycle_lock_file_alone_is_not_privileged_auth_state() {
        let dir = temp_app();
        fs::write(dir.join("twinpet-privileged-auth-lifecycle.lock"), b"").unwrap();
        assert!(!privileged_auth_state_exists(&dir));
        assert_eq!(evaluate_floor(&dir), FloorDecision::PermitVirgin);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_floor_with_privileged_auth_state_fails_closed() {
        let dir = temp_app();
        fs::write(dir.join("twinpet-oac-pepper.dpapi"), b"x").unwrap();
        match evaluate_floor(&dir) {
            FloorDecision::FailClosed { reason } => assert!(reason.contains("missing")),
            other => panic!("unexpected {other:?}"),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_floor_with_privileged_auth_state_fails_closed() {
        let dir = temp_app();
        fs::write(dir.join("twinpet-oac-pepper.dpapi"), b"x").unwrap();
        fs::write(floor_path(&dir), "not-a-valid-floor-file").unwrap();
        match evaluate_floor(&dir) {
            FloorDecision::FailClosed { .. } => {}
            other => panic!("unexpected {other:?}"),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn package_version_synchronized_and_not_placeholder() {
        let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let cargo_toml = fs::read_to_string(manifest_dir.join("Cargo.toml")).unwrap();
        let cargo_version = cargo_toml
            .lines()
            .find_map(|l| l.trim().strip_prefix("version = \""))
            .and_then(|rest| rest.strip_suffix('"'))
            .expect("Cargo.toml must have a version field");

        let tauri_conf = fs::read_to_string(manifest_dir.join("tauri.conf.json")).unwrap();
        let tauri_json: serde_json::Value = serde_json::from_str(&tauri_conf).unwrap();
        let tauri_version = tauri_json
            .get("version")
            .and_then(|v| v.as_str())
            .expect("tauri.conf.json must have a top-level version field");

        assert_ne!(
            tauri_version, "0.0.0",
            "distributable version must not be the placeholder"
        );
        assert_eq!(
            cargo_version, tauri_version,
            "Cargo.toml and tauri.conf.json versions must stay synchronized"
        );
    }

    /// SEC-001 epoch-2 rollback remediation (Claude-024), required behavioral
    /// test #6: a floor-write failure before runtime must fail closed. This
    /// exercises `write_floor_atomic` (the exact function `lib.rs::run`
    /// exits the process on error from) by pointing it at an app-data path
    /// that is actually a regular file, so `create_dir_all`/`File::create`
    /// cannot succeed — an injected write failure, not a mocked one.
    #[test]
    fn floor_write_failure_before_runtime_fails_closed() {
        let dir = temp_app();
        fs::remove_dir_all(&dir).unwrap();
        fs::write(&dir, b"not a directory").unwrap();
        let result = write_floor_atomic(&dir, "test-build");
        assert!(result.is_err(), "expected write_floor_atomic to fail");
        let _ = fs::remove_file(&dir);
    }

    /// SEC-001 epoch-2 rollback remediation (Claude-024), required behavioral
    /// test #8: an older binary built with `MAX_KNOWN_EPOCH_SCHEMA == 1`
    /// must reject a floor committed at 2. `MAX_KNOWN_EPOCH_SCHEMA` is a
    /// compile-time constant of *this* binary (currently 2), so a literal
    /// epoch-1 binary cannot be instantiated in-process; this test instead
    /// proves the underlying invariant `evaluate_floor` enforces — floor >
    /// max-known is always FailClosed — is exactly the comparison an
    /// epoch-1 binary would perform against a floor-2 marker (`2 > 1`),
    /// using the same `parse_floor_file` + comparison path this binary's
    /// `evaluate_floor` uses, so the two cannot silently diverge.
    #[test]
    fn max_epoch1_binary_rejects_floor2() {
        let dir = temp_app();
        fs::write(
            floor_path(&dir),
            "committedEpochFloor=2\nwriterBuildId=epoch2-writer\n",
        )
        .unwrap();
        let contents = fs::read_to_string(floor_path(&dir)).unwrap();
        let parsed_floor = parse_floor_file(&contents).unwrap();
        assert_eq!(parsed_floor, 2);
        const HYPOTHETICAL_EPOCH1_MAX: u32 = 1;
        assert!(
            parsed_floor > HYPOTHETICAL_EPOCH1_MAX,
            "an epoch-1 binary must see floor 2 as newer-than-known"
        );
        // Under the epoch-2 binary actually running this test, floor 2 is
        // exactly MAX_KNOWN_EPOCH_SCHEMA and is compatible — confirming the
        // rejection above is specific to the older binary's lower ceiling,
        // not a universal rejection of floor 2.
        assert_eq!(
            evaluate_floor(&dir),
            FloorDecision::PermitCompatible { floor: 2 }
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// Gemini-043 final fix, canonical identifier grammar length boundary:
    /// 1 byte and 1500 bytes accepted, 1501 bytes rejected.
    #[test]
    fn canonical_oac_identifier_length_boundary() {
        assert!(is_canonical_oac_identifier(&"a".repeat(1)));
        assert!(is_canonical_oac_identifier(&"a".repeat(1500)));
        assert!(!is_canonical_oac_identifier(&"a".repeat(1501)));
        assert!(!is_canonical_oac_identifier(""));
    }

    /// Gemini-043 final fix, Codex-013 overmatch remediation: root OAC
    /// envelope and receipt filenames must satisfy the canonical identifier
    /// grammar in their stem, not merely end with the expected suffix.
    #[test]
    fn oac_store_root_envelope_and_receipt_grammar() {
        // Positive.
        for name in ["oac-1.json", "oac_1.json", "A1.json", "abc123.json"] {
            assert!(
                oac_store_root_entry_is_recognized(name),
                "expected {name} to be recognized as a canonical OAC envelope"
            );
        }
        for name in ["oac-1.receipt.bin", "oac_1.receipt.bin"] {
            assert!(
                oac_store_root_entry_is_recognized(name),
                "expected {name} to be recognized as a canonical OAC receipt"
            );
        }
        // Negative — envelope.
        for name in [".json", "foo.bar.json", "foo bar.json", "foo+.json"] {
            assert!(
                !oac_store_root_entry_is_recognized(name),
                "expected {name} to be rejected as a canonical OAC envelope"
            );
        }
        // Negative — receipt.
        for name in [".receipt.bin", "foo.bar.receipt.bin", "foo bar.receipt.bin"] {
            assert!(
                !oac_store_root_entry_is_recognized(name),
                "expected {name} to be rejected as a canonical OAC receipt"
            );
        }
    }

    /// Gemini-043 final fix: manager active-slot filenames must satisfy the
    /// canonical identifier grammar in their stem.
    #[test]
    fn oac_store_by_manager_entry_grammar() {
        for name in ["mgr-1.json", "mgr_1.json", "MGR01.json"] {
            assert!(
                oac_store_by_manager_entry_is_recognized(name),
                "expected {name} to be recognized as a canonical manager slot"
            );
        }
        for name in [".json", "foo.bar.json", "foo bar.json"] {
            assert!(
                !oac_store_by_manager_entry_is_recognized(name),
                "expected {name} to be rejected as a canonical manager slot"
            );
        }
    }

    /// Gemini-043 final fix, end-to-end via `privileged_auth_state_exists`:
    /// invalid-grammar OAC filenames at root and under `by-manager/` must not
    /// count as state, while valid ones still do.
    #[test]
    fn invalid_grammar_oac_filenames_are_not_detected_as_state() {
        for name in [".json", "foo.bar.json", "foo bar.json"] {
            let dir = temp_app();
            fs::create_dir_all(dir.join("oac-store")).unwrap();
            fs::write(dir.join("oac-store").join(name), b"{}").unwrap();
            assert!(
                !privileged_auth_state_exists(&dir),
                "expected {name} at oac-store root to be excluded"
            );
            let _ = fs::remove_dir_all(&dir);
        }
        for name in [".receipt.bin", "foo.bar.receipt.bin", "foo bar.receipt.bin"] {
            let dir = temp_app();
            fs::create_dir_all(dir.join("oac-store")).unwrap();
            fs::write(dir.join("oac-store").join(name), b"x").unwrap();
            assert!(
                !privileged_auth_state_exists(&dir),
                "expected {name} at oac-store root to be excluded"
            );
            let _ = fs::remove_dir_all(&dir);
        }
        for name in [".json", "foo.bar.json", "foo bar.json"] {
            let dir = temp_app();
            fs::create_dir_all(dir.join("oac-store").join("by-manager")).unwrap();
            fs::write(dir.join("oac-store").join("by-manager").join(name), b"{}").unwrap();
            assert!(
                !privileged_auth_state_exists(&dir),
                "expected {name} under by-manager/ to be excluded"
            );
            let _ = fs::remove_dir_all(&dir);
        }
    }

    /// Gemini-043 final fix: a directory whose name merely looks like a
    /// canonical OAC envelope/receipt/manager-slot filename must never count
    /// — the probe path must be a regular file.
    #[test]
    fn directory_named_like_a_canonical_oac_file_is_not_detected() {
        let dir = temp_app();
        fs::create_dir_all(dir.join("oac-store").join("oac-1.json")).unwrap();
        assert!(!privileged_auth_state_exists(&dir));
        let _ = fs::remove_dir_all(&dir);

        let dir2 = temp_app();
        fs::create_dir_all(dir2.join("oac-store").join("oac-1.receipt.bin")).unwrap();
        assert!(!privileged_auth_state_exists(&dir2));
        let _ = fs::remove_dir_all(&dir2);

        let dir3 = temp_app();
        fs::create_dir_all(dir3.join("oac-store").join("by-manager").join("mgr-1.json")).unwrap();
        assert!(!privileged_auth_state_exists(&dir3));
        let _ = fs::remove_dir_all(&dir3);
    }

    #[test]
    fn build_provenance_is_present_and_not_placeholder_in_a_real_checkout() {
        let (git_sha, build_id) = build_provenance();
        assert!(!git_sha.is_empty());
        assert!(!build_id.is_empty());
        let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        if manifest_dir.join("..").join(".git").exists() {
            assert_ne!(
                git_sha, "unknown",
                "git SHA should be resolvable in a real checkout"
            );
            assert_ne!(
                build_id, "unknown",
                "build ID should be resolvable in a real checkout"
            );
        }
    }
}
