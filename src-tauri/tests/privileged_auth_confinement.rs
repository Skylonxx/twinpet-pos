//! SEC-001 Packet C-A — native command surface confinement.
//!
//! Exactly five `privileged_auth` commands may ever be exposed to the
//! WebView, and nothing else from the module tree — no sign-arbitrary-bytes,
//! no pepper/DPAPI-blob/device-private-key getter, no raw Argon2 verifier
//! export, no arbitrary file read, no raw keyset-manifest-bytes command.
//! This is checked structurally against the actual shipped
//! `capabilities/default.json` and `src/privileged_auth/mod.rs`, so a future
//! change that adds a sixth command or a forbidden getter fails this test
//! even if nobody remembers to update a hand-maintained list.

use std::fs;
use std::path::PathBuf;

const EXACT_FIVE_COMMANDS: &[&str] = &[
    "native_import_device_enrollment_file",
    "native_generate_device_registration_proof",
    "native_complete_oac_provisioning",
    "native_argon2_benchmark",
    "native_get_device_registration_status",
];

const FORBIDDEN_NAME_FRAGMENTS: &[&str] = &[
    "sign_arbitrary",
    "get_pepper",
    "get_dpapi",
    "dpapi_blob",
    "get_device_private_key",
    "device_private_key",
    "raw_argon2",
    "argon2_verifier",
    "read_file",
    "arbitrary_file",
    "keyset_manifest_bytes",
    "raw_keyset",
];

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn capabilities_json() -> serde_json::Value {
    let path = manifest_dir().join("capabilities").join("default.json");
    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("cannot parse {}: {e}", path.display()))
}

fn granted_native_permissions() -> Vec<String> {
    let json = capabilities_json();
    let permissions = json["permissions"].as_array().expect("permissions array");
    permissions
        .iter()
        .filter_map(|p| p.as_str())
        .filter(|p| p.starts_with("allow-native-"))
        .map(|p| p.to_string())
        .collect()
}

fn mod_rs_source() -> String {
    let path = manifest_dir().join("src").join("privileged_auth").join("mod.rs");
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

fn lib_rs_source() -> String {
    let path = manifest_dir().join("src").join("lib.rs");
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

#[test]
fn exactly_five_native_commands_are_granted_in_capabilities() {
    let granted = granted_native_permissions();
    let mut expected: Vec<String> =
        EXACT_FIVE_COMMANDS.iter().map(|c| format!("allow-{}", c.replace('_', "-"))).collect();
    expected.sort();
    let mut actual = granted.clone();
    actual.sort();
    assert_eq!(actual, expected, "capabilities/default.json must grant exactly the five frozen commands");
}

#[test]
fn exactly_five_tauri_command_functions_are_defined_in_mod_rs() {
    let source = mod_rs_source();
    let defined: Vec<&str> = EXACT_FIVE_COMMANDS
        .iter()
        .filter(|name| source.contains(&format!("pub fn {name}(")))
        .copied()
        .collect();
    assert_eq!(defined.len(), 5, "expected exactly 5 command functions defined, found: {defined:?}");

    let command_attr_count = source.matches("#[tauri::command]").count();
    assert_eq!(command_attr_count, 5, "expected exactly 5 #[tauri::command]-annotated functions in mod.rs");
}

#[test]
fn exactly_five_commands_are_registered_in_generate_handler() {
    let source = lib_rs_source();
    for name in EXACT_FIVE_COMMANDS {
        assert!(
            source.contains(&format!("privileged_auth::{name}")),
            "lib.rs generate_handler! must register privileged_auth::{name}"
        );
    }
}

#[test]
fn no_forbidden_command_name_fragment_appears_in_granted_permissions() {
    let granted = granted_native_permissions();
    for permission in &granted {
        for fragment in FORBIDDEN_NAME_FRAGMENTS {
            assert!(
                !permission.replace('-', "_").contains(fragment),
                "granted permission '{permission}' matches forbidden fragment '{fragment}'"
            );
        }
    }
}

#[test]
fn no_forbidden_public_tauri_command_exists_in_mod_rs() {
    let source = mod_rs_source();
    for line in source.lines() {
        if !line.trim_start().starts_with("pub fn ") {
            continue;
        }
        let lower = line.to_ascii_lowercase();
        for fragment in FORBIDDEN_NAME_FRAGMENTS {
            assert!(!lower.contains(fragment), "public function line matches a forbidden fragment: {line}");
        }
    }
}

#[test]
fn native_import_device_enrollment_file_has_no_caller_controlled_path_argument() {
    let source = mod_rs_source();
    let signature_line = source
        .lines()
        .find(|line| line.trim_start().starts_with("pub fn native_import_device_enrollment_file("))
        .expect("native_import_device_enrollment_file signature line must exist in mod.rs");
    assert!(
        signature_line.contains("native_import_device_enrollment_file()"),
        "native_import_device_enrollment_file must take zero WebView-supplied arguments \
         (no caller-controlled file path), found: {signature_line}"
    );
}

#[test]
fn all_ten_privileged_auth_modules_are_declared() {
    let source = mod_rs_source();
    let expected_modules = [
        "argon2_benchmark",
        "argon2_kdf",
        "device_proof",
        "device_registration_proof",
        "dpapi_envelope",
        "enrollment_import",
        "frames",
        "oac_keyset_frame",
        "pepper_store",
        "security_device_id",
    ];
    for module in expected_modules {
        assert!(
            source.contains(&format!("mod {module};")),
            "mod.rs must declare `pub mod {module};`"
        );
    }
}
