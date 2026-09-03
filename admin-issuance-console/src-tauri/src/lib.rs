mod bootstrap_import;
mod file_export;
mod issuer_key;

use serde::Serialize;

fn base64url_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        out.push(ALPHABET[(b0 >> 2) as usize] as char);
        out.push(ALPHABET[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(((b1 & 0x0F) << 2) | (b2 >> 6)) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(b2 & 0x3F) as usize] as char);
        }
    }
    out
}

fn base64_std_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        out.push(ALPHABET[(b0 >> 2) as usize] as char);
        out.push(ALPHABET[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(((b1 & 0x0F) << 2) | (b2 >> 6)) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[(b2 & 0x3F) as usize] as char } else { '=' });
    }
    out
}

#[tauri::command]
fn issuer_key_get_or_create_public_key() -> Result<String, String> {
    let root = issuer_key::resolve_app_data_dir();
    let key = issuer_key::resolve_or_create_issuer_key(&root).map_err(|e| format!("{e:?}"))?;
    Ok(base64url_encode(&key.verifying_key().to_bytes()))
}

#[tauri::command]
fn issuer_key_sign_request(purpose: String, request_id: String, fields_json: String) -> Result<String, String> {
    let root = issuer_key::resolve_app_data_dir();
    let fields: serde_json::Value = serde_json::from_str(&fields_json).map_err(|e| e.to_string())?;
    let fields_obj = fields.as_object().ok_or("fields_json must be a JSON object")?;
    let signature = issuer_key::sign_issuer_request(&root, &purpose, &request_id, fields_obj)
        .map_err(|e| format!("{e:?}"))?;
    Ok(base64_std_encode(&signature))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ParsedBootstrapImportDto {
    token_id: String,
    raw_token: String,
}

#[tauri::command]
fn bootstrap_import_parse(input: String) -> Result<ParsedBootstrapImportDto, String> {
    let parsed = bootstrap_import::parse_bootstrap_import(&input).map_err(|e| format!("{e:?}"))?;
    Ok(ParsedBootstrapImportDto { token_id: parsed.token_id, raw_token: parsed.raw_token })
}

#[tauri::command]
fn file_export_write(target_path: String, enr1_base64: String) -> Result<(), String> {
    file_export::export_enrollment_file(std::path::Path::new(&target_path), &enr1_base64)
        .map_err(|e| format!("{e:?}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            issuer_key_get_or_create_public_key,
            issuer_key_sign_request,
            bootstrap_import_parse,
            file_export_write,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Issuer Console tauri application");
}
