mod durable_kv;
mod epoch_floor;
mod privileged_auth;
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
    let enrollment_runtime = privileged_auth::enrollment_meta::EnrollmentRuntimeState::new();
    tauri::Builder::default()
        .manage(engine)
        .manage(enrollment_runtime)
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
            privileged_auth::native_import_device_enrollment_file,
            privileged_auth::native_generate_device_registration_proof,
            privileged_auth::native_complete_oac_provisioning,
            privileged_auth::native_argon2_benchmark,
            privileged_auth::native_get_device_registration_status,
            privileged_auth::native_verify_offline_pin,
            privileged_auth::native_clear_offline_lockout,
            privileged_auth::native_prepare_staff_session_challenge,
            privileged_auth::native_persist_staff_session_assertion,
            privileged_auth::native_clear_staff_session,
            privileged_auth::native_prepare_oac_reanchor_challenge,
            privileged_auth::native_persist_oac_reanchor,
            privileged_auth::native_finalize_device_enrollment,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
