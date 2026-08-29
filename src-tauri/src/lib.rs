mod durable_kv;
mod epoch_floor;
mod single_instance;

use durable_kv::DurableKvEngine;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    single_instance::acquire_or_exit();
    let app_data = epoch_floor::resolve_app_data_dir();
    epoch_floor::check_or_exit(&app_data);
    if let Err(reason) = durable_kv::assert_startup_integrity(&app_data) {
        eprintln!("Twinpet POS cannot start: {reason}");
        std::process::exit(1);
    }
    let engine = DurableKvEngine::new(app_data);
    tauri::Builder::default()
        .manage(engine)
        .invoke_handler(tauri::generate_handler![
            durable_kv::durable_kv_txn_begin,
            durable_kv::durable_kv_txn_get,
            durable_kv::durable_kv_txn_get_all,
            durable_kv::durable_kv_txn_get_all_keys,
            durable_kv::durable_kv_txn_put,
            durable_kv::durable_kv_txn_delete,
            durable_kv::durable_kv_txn_commit,
            durable_kv::durable_kv_txn_abort,
            durable_kv::durable_manifest_get,
            durable_kv::durable_manifest_put_epoch,
            durable_kv::durable_manifest_lease_acquire,
            durable_kv::durable_manifest_lease_heartbeat,
            durable_kv::durable_manifest_lease_release,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
