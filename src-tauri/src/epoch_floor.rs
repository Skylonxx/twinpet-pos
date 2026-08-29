use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const MAX_KNOWN_EPOCH_SCHEMA: u32 = 1;
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
    let files_exist = durable_domain_files_exist(app_data_dir);
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
            FloorDecision::PermitCompatible { floor: 1 }
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
