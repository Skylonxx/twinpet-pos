fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "issuer_key_get_or_create_public_key",
            "issuer_key_sign_request",
            "bootstrap_import_parse",
            "file_export_write",
        ]),
    ))
    .expect("failed to run tauri-build");
}
