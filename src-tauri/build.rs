fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "durable_kv_txn_begin",
            "durable_kv_txn_get",
            "durable_kv_txn_get_all",
            "durable_kv_txn_get_all_keys",
            "durable_kv_txn_put",
            "durable_kv_txn_delete",
            "durable_kv_txn_commit",
            "durable_kv_txn_abort",
            "durable_manifest_get",
            "durable_manifest_put_epoch",
            "durable_manifest_lease_acquire",
            "durable_manifest_lease_heartbeat",
            "durable_manifest_lease_release",
        ]),
    ))
    .expect("failed to run tauri-build");
}
