use crate::epoch_floor::{self, durable_dir, MANIFEST_FILE_NAME, MAX_KNOWN_EPOCH_SCHEMA};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const SESSION_IDLE_TIMEOUT_MS: u64 = 5000;
pub const SESSION_ACQUIRE_TIMEOUT_MS: u64 = 5000;

#[cfg(windows)]
mod csprng {
    #[link(name = "advapi32")]
    extern "system" {
        pub fn SystemFunction036(buf: *mut u8, len: u32) -> u8;
    }
}

const ALLOWED_DATABASES: [&str; 9] = [
    "twinpet-offline-reversal",
    "twinpet-sale-intent-journal",
    "twinpet-shift-open-intent",
    "twinpet-shift-close-intent",
    "twinpet-active-cart-snapshot",
    "twinpet-sale-submission-evidence",
    "twinpet-device",
    "twinpet-suspended-bills",
    "twinpet-migration-manifest",
];

const DOMAIN_DATABASES: [&str; 8] = [
    "twinpet-offline-reversal",
    "twinpet-sale-intent-journal",
    "twinpet-shift-open-intent",
    "twinpet-shift-close-intent",
    "twinpet-active-cart-snapshot",
    "twinpet-sale-submission-evidence",
    "twinpet-device",
    "twinpet-suspended-bills",
];

const EPOCH_ID_PREFIX: &str = "epoch-";
const EPOCH_ID_HEX_LEN: usize = 32;
const EPOCH_ID_MAX_DIGITS: usize = 16;
const EPOCH_ID_MAX_LEN: usize = EPOCH_ID_PREFIX.len() + EPOCH_ID_MAX_DIGITS + 1 + EPOCH_ID_HEX_LEN;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TxnMode {
    Readonly,
    Readwrite,
}

impl TxnMode {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "readonly" => Ok(Self::Readonly),
            "readwrite" => Ok(Self::Readwrite),
            _ => Err(format!("unknown durable mode '{value}'")),
        }
    }
}

struct Session {
    conn: Connection,
    #[allow(dead_code)]
    database: String,
    stores: HashSet<String>,
    mode: TxnMode,
    webview_label: String,
    last_cmd: Instant,
}

struct EngineInner {
    root: PathBuf,
    sessions: HashMap<String, Session>,
    occupied: HashMap<String, String>,
}

pub struct DurableKvEngine {
    inner: Arc<Mutex<EngineInner>>,
}

fn random_session_id() -> String {
    let mut buf = [0u8; 16];
    fill_random_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(windows)]
fn fill_random_bytes(buf: &mut [u8]) {
    let ok = unsafe { csprng::SystemFunction036(buf.as_mut_ptr(), buf.len() as u32) };
    if ok == 0 {
        panic!("CSPRNG failed");
    }
}

#[cfg(not(windows))]
fn fill_random_bytes(buf: &mut [u8]) {
    use std::io::Read;
    std::fs::File::open("/dev/urandom")
        .expect("urandom")
        .read_exact(buf)
        .expect("urandom read");
}

fn assert_allowed_database(database: &str) -> Result<(), String> {
    if ALLOWED_DATABASES.contains(&database) {
        Ok(())
    } else {
        Err(format!("unknown durable database '{database}'"))
    }
}

fn is_ascii_hex_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Narrow canonical epoch id matching JS `newEpochId()`: `epoch-<digits>-<32 lowercase hex>`.
pub fn assert_canonical_epoch_id(epoch_id: &str) -> Result<(), String> {
    if epoch_id.is_empty() || epoch_id.trim().is_empty() {
        return Err("epoch id is empty".into());
    }
    if !epoch_id.is_ascii() {
        return Err("epoch id must be ascii".into());
    }
    if epoch_id.len() > EPOCH_ID_MAX_LEN {
        return Err("epoch id exceeds maximum length".into());
    }
    if epoch_id.contains('/')
        || epoch_id.contains('\\')
        || epoch_id.contains("..")
        || epoch_id.contains('\0')
        || epoch_id.chars().any(|c| c.is_control())
        || epoch_id.contains(':')
    {
        return Err("epoch id contains forbidden path or control characters".into());
    }
    let rest = epoch_id
        .strip_prefix(EPOCH_ID_PREFIX)
        .ok_or_else(|| "epoch id is not canonical".to_string())?;
    let (digits, hex) = rest
        .split_once('-')
        .ok_or_else(|| "epoch id is not canonical".to_string())?;
    if digits.is_empty()
        || digits.len() > EPOCH_ID_MAX_DIGITS
        || !digits.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("epoch id is not canonical".into());
    }
    if hex.len() != EPOCH_ID_HEX_LEN || !hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err("epoch id is not canonical".into());
    }
    Ok(())
}

fn domain_file_path(root: &Path, database: &str, epoch_id: &str) -> Result<PathBuf, String> {
    assert_allowed_database(database)?;
    if database == "twinpet-migration-manifest" {
        return Ok(durable_dir(root).join(MANIFEST_FILE_NAME));
    }
    assert_canonical_epoch_id(epoch_id)?;
    let filename = format!("{database}.{epoch_id}.sqlite");
    if filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
        || Path::new(&filename).is_absolute()
        || filename
            .as_bytes()
            .iter()
            .any(|b| *b == 0 || b.is_ascii_control())
    {
        return Err("sqlite filename escapes durable root".into());
    }
    let durable = durable_dir(root);
    let path = durable.join(&filename);
    if Path::new(&filename).components().any(|c| {
        matches!(
            c,
            Component::ParentDir | Component::Prefix(_) | Component::RootDir
        )
    }) {
        return Err("sqlite path escapes durable root".into());
    }
    match path.parent() {
        Some(parent) if parent == durable.as_path() => Ok(path),
        _ => Err("sqlite path escapes durable root".into()),
    }
}

fn prior_phase_b_state_exists(root: &Path) -> bool {
    epoch_floor::floor_path(root).exists()
        || epoch_floor::durable_domain_files_exist(root)
        || durable_dir(root).join(MANIFEST_FILE_NAME).exists()
}

fn open_kv_connection(path: &Path, create: bool) -> Result<Connection, String> {
    if !create {
        if !path.is_file() {
            return Err("committed domain file is missing".into());
        }
    } else if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    if create {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS kv (
         store TEXT NOT NULL,
         key TEXT NOT NULL,
         value TEXT NOT NULL,
         PRIMARY KEY (store, key)
       );",
        )
        .map_err(|e| e.to_string())?;
        let version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if version == 0 {
            conn.pragma_update(None, "user_version", 1)
                .map_err(|e| e.to_string())?;
        } else if version != 1 {
            return Err(format!("unsupported sqlite user_version {version}"));
        }
    } else {
        let has_kv: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'kv'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if has_kv == 0 {
            return Err("committed domain file is corrupt: kv table missing".into());
        }
        let version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if version != 1 {
            return Err(format!("unsupported sqlite user_version {version}"));
        }
    }
    Ok(conn)
}

fn create_manifest_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS epochs (
         epoch_id TEXT PRIMARY KEY NOT NULL,
         status TEXT NOT NULL,
         schema_version INTEGER NOT NULL,
         created_at_ms INTEGER NOT NULL,
         inventory_json TEXT NOT NULL,
         error_code TEXT,
         error_detail TEXT
       );
       CREATE TABLE IF NOT EXISTS lease (
         slot INTEGER PRIMARY KEY CHECK (slot = 1),
         owner_id TEXT,
         expires_at_ms INTEGER,
         heartbeat_ms INTEGER
       );",
    )
    .map_err(|e| e.to_string())?;
    let version: i32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if version == 0 {
        conn.pragma_update(None, "user_version", 1)
            .map_err(|e| e.to_string())?;
    } else if version != 1 {
        return Err(format!("unsupported manifest user_version {version}"));
    }
    Ok(())
}

fn open_existing_manifest(path: &Path) -> Result<Connection, String> {
    if !path.is_file() {
        return Err("migration manifest is missing".into());
    }
    let conn =
        Connection::open(path).map_err(|e| format!("migration manifest is unreadable: {e}"))?;
    let has_epochs: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'epochs'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("migration manifest is corrupt: {e}"))?;
    if has_epochs == 0 {
        return Err("migration manifest is corrupt: epochs table missing".into());
    }
    Ok(conn)
}

fn open_or_create_manifest_if_virgin(root: &Path) -> Result<Connection, String> {
    let path = durable_dir(root).join(MANIFEST_FILE_NAME);
    if path.exists() {
        return open_existing_manifest(&path);
    }
    if prior_phase_b_state_exists(root) {
        return Err("migration manifest is missing while prior durable state exists".into());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    create_manifest_schema(&conn)?;
    Ok(conn)
}

fn epoch_status_from_manifest(root: &Path, epoch_id: &str) -> Option<String> {
    let path = durable_dir(root).join(MANIFEST_FILE_NAME);
    if !path.is_file() {
        return None;
    }
    let conn = Connection::open(path).ok()?;
    conn.query_row(
        "SELECT status FROM epochs WHERE epoch_id = ?1",
        params![epoch_id],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

fn legal_epoch_transition(from: Option<&str>, to: &str) -> Result<(), String> {
    const ALLOWED: [&str; 5] = ["COPYING", "VERIFYING", "COMMITTED", "ABORTED", "FAILED"];
    if !ALLOWED.contains(&to) {
        return Err(format!("unknown epoch status '{to}'"));
    }
    match (from, to) {
        (None, "COPYING") => Ok(()),
        (None, _) => Err(format!("epoch cannot be created in status '{to}'")),
        (Some("COPYING"), "COPYING" | "VERIFYING" | "COMMITTED" | "ABORTED" | "FAILED") => Ok(()),
        (Some("VERIFYING"), "VERIFYING" | "COMMITTED" | "ABORTED" | "FAILED") => Ok(()),
        (Some("ABORTED"), "ABORTED") => Ok(()),
        (Some("FAILED"), "FAILED") => Ok(()),
        (Some("COMMITTED"), "COMMITTED") => Ok(()),
        (Some("COMMITTED"), _) => Err("COMMITTED epoch cannot be demoted".into()),
        (Some(prev), next) => Err(format!("invalid epoch transition {prev} -> {next}")),
    }
}

fn validate_committed_inventory(
    root: &Path,
    epoch_id: &str,
    inventory_json: &str,
) -> Result<(), String> {
    assert_canonical_epoch_id(epoch_id)?;
    let parsed: Value = serde_json::from_str(inventory_json)
        .map_err(|_| "committed inventory_json is corrupt".to_string())?;
    let schema = parsed
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| "committed inventory missing schemaVersion".to_string())?;
    if schema != MAX_KNOWN_EPOCH_SCHEMA as u64 {
        return Err(format!("committed schemaVersion {schema} is unsupported"));
    }
    let domains = parsed
        .get("domains")
        .and_then(Value::as_array)
        .ok_or_else(|| "committed inventory domains missing".to_string())?;
    if domains.len() != DOMAIN_DATABASES.len() {
        return Err("committed inventory does not contain all eight domains".into());
    }
    let mut seen = HashSet::new();
    for domain in domains {
        let database = domain
            .get("database")
            .and_then(Value::as_str)
            .ok_or_else(|| "committed domain missing database".to_string())?;
        if !DOMAIN_DATABASES.contains(&database) {
            return Err(format!(
                "committed domain database '{database}' is not allowed"
            ));
        }
        if !seen.insert(database.to_string()) {
            return Err("committed inventory has duplicate domain".into());
        }
        let digest = domain
            .get("digestSha256")
            .and_then(Value::as_str)
            .ok_or_else(|| "committed domain missing digest".to_string())?;
        if !is_ascii_hex_digest(digest) {
            return Err("committed domain digest is invalid".into());
        }
        let path = domain_file_path(root, database, epoch_id)?;
        if !path.is_file() {
            return Err(format!("committed domain file is missing: {database}"));
        }
    }
    if seen.len() != DOMAIN_DATABASES.len() {
        return Err("committed inventory is missing a required domain".into());
    }
    let p13 = parsed
        .get("p13")
        .ok_or_else(|| "committed P-13 inventory evidence is missing".to_string())?;
    let branch_ids = p13
        .get("branchIds")
        .and_then(Value::as_array)
        .ok_or_else(|| "committed P-13 branchIds missing".to_string())?;
    for branch_id in branch_ids {
        if !branch_id.is_string() {
            return Err("committed P-13 branchIds must be strings".into());
        }
    }
    if p13.get("rowCount").and_then(Value::as_i64).is_none() {
        return Err("committed P-13 rowCount missing".into());
    }
    let p13_digest = p13
        .get("digestSha256")
        .and_then(Value::as_str)
        .ok_or_else(|| "committed P-13 digest missing".to_string())?;
    if !is_ascii_hex_digest(p13_digest) {
        return Err("committed P-13 digest is invalid".into());
    }
    Ok(())
}

fn validate_existing_committed_state(root: &Path) -> Result<(), String> {
    let path = durable_dir(root).join(MANIFEST_FILE_NAME);
    if !path.exists() {
        return Err("migration manifest is missing while a committed epoch floor exists".into());
    }
    let conn = open_existing_manifest(&path)?;
    let row: Option<(String, String, String)> = conn
        .query_row(
            "SELECT epoch_id, status, inventory_json FROM epochs WHERE status = 'COMMITTED' ORDER BY created_at_ms DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| format!("migration manifest is unreadable: {e}"))?;
    let Some((epoch_id, status, inventory_json)) = row else {
        return Err("committed epoch floor exists without a COMMITTED manifest row".into());
    };
    if status != "COMMITTED" {
        return Err("committed manifest row is inconsistent".into());
    }
    validate_committed_inventory(root, &epoch_id, &inventory_json)
}

/// Fail-closed native startup gate. True virgin may proceed. Any prior committed
/// Phase-B state must have a readable manifest, valid inventory, and all eight files.
pub fn assert_startup_integrity(app_data: &Path) -> Result<(), String> {
    match epoch_floor::evaluate_floor(app_data) {
        epoch_floor::FloorDecision::PermitVirgin => Ok(()),
        epoch_floor::FloorDecision::FailClosed { reason } => Err(reason),
        epoch_floor::FloorDecision::PermitCompatible { .. } => {
            validate_existing_committed_state(app_data)
        }
    }
}

impl DurableKvEngine {
    pub fn new(app_data_dir: PathBuf) -> Self {
        let engine = Self {
            inner: Arc::new(Mutex::new(EngineInner {
                root: app_data_dir,
                sessions: HashMap::new(),
                occupied: HashMap::new(),
            })),
        };
        engine.spawn_watchdog();
        engine
    }

    fn spawn_watchdog(&self) {
        let inner = Arc::clone(&self.inner);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(250));
            let mut guard = inner.lock().expect("engine mutex");
            let now = Instant::now();
            let expired: Vec<String> = guard
                .sessions
                .iter()
                .filter(|(_, session)| {
                    now.duration_since(session.last_cmd)
                        >= Duration::from_millis(SESSION_IDLE_TIMEOUT_MS)
                })
                .map(|(id, _)| id.clone())
                .collect();
            for id in expired {
                let _ = rollback_session(&mut guard, &id);
            }
        });
    }

    pub fn begin(
        &self,
        webview_label: &str,
        database: &str,
        stores: Vec<String>,
        mode: &str,
        epoch_id: &str,
    ) -> Result<String, String> {
        assert_allowed_database(database)?;
        if database == "twinpet-migration-manifest" {
            return Err("manifest file is not a domain KV session".into());
        }
        if stores.is_empty() {
            return Err("stores required".into());
        }
        assert_canonical_epoch_id(epoch_id)?;
        let parsed_mode = TxnMode::parse(mode)?;
        let occupancy_key = format!("{database}:{epoch_id}");
        let store_set: HashSet<String> = stores.into_iter().collect();
        let deadline = Instant::now() + Duration::from_millis(SESSION_ACQUIRE_TIMEOUT_MS);
        loop {
            {
                let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
                if !guard.occupied.contains_key(&occupancy_key) {
                    let path = domain_file_path(&guard.root, database, epoch_id)?;
                    let committed = epoch_status_from_manifest(&guard.root, epoch_id)
                        .is_some_and(|status| status == "COMMITTED");
                    if committed && !path.is_file() {
                        return Err(format!("committed domain file is missing: {database}"));
                    }
                    let conn = open_kv_connection(&path, !committed)?;
                    match parsed_mode {
                        TxnMode::Readonly => conn
                            .execute_batch("BEGIN DEFERRED")
                            .map_err(|e| e.to_string())?,
                        TxnMode::Readwrite => conn
                            .execute_batch("BEGIN IMMEDIATE")
                            .map_err(|e| e.to_string())?,
                    }
                    let session_id = random_session_id();
                    guard
                        .occupied
                        .insert(occupancy_key.clone(), session_id.clone());
                    guard.sessions.insert(
                        session_id.clone(),
                        Session {
                            conn,
                            database: database.to_string(),
                            stores: store_set.clone(),
                            mode: parsed_mode,
                            webview_label: webview_label.to_string(),
                            last_cmd: Instant::now(),
                        },
                    );
                    return Ok(session_id);
                }
            }
            if Instant::now() >= deadline {
                return Err("durable session acquire timed out".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn with_session<T>(
        &self,
        session_id: &str,
        webview_label: &str,
        mutator: impl FnOnce(&mut Session) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        match guard.sessions.get_mut(session_id) {
            Some(session) if session.webview_label == webview_label => {
                session.last_cmd = Instant::now();
                mutator(session)
            }
            Some(_) => Err("session ownership mismatch".into()),
            None => Err("unknown durable session".into()),
        }
    }

    pub fn get(
        &self,
        webview_label: &str,
        session_id: &str,
        store: &str,
        encoded_key: &str,
    ) -> Result<Option<Value>, String> {
        self.with_session(session_id, webview_label, |session| {
            assert_store(session, store)?;
            let value: Option<String> = session
                .conn
                .query_row(
                    "SELECT value FROM kv WHERE store = ?1 AND key = ?2",
                    params![store, encoded_key],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            match value {
                Some(raw) => serde_json::from_str(&raw).map_err(|e| e.to_string()),
                None => Ok(None),
            }
        })
    }

    pub fn get_all(
        &self,
        webview_label: &str,
        session_id: &str,
        store: &str,
    ) -> Result<Vec<Value>, String> {
        self.with_session(session_id, webview_label, |session| {
            assert_store(session, store)?;
            let mut stmt = session
                .conn
                .prepare("SELECT value FROM kv WHERE store = ?1 ORDER BY key COLLATE BINARY")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![store], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for row in rows {
                let raw = row.map_err(|e| e.to_string())?;
                out.push(serde_json::from_str(&raw).map_err(|e| e.to_string())?);
            }
            Ok(out)
        })
    }

    pub fn get_all_keys(
        &self,
        webview_label: &str,
        session_id: &str,
        store: &str,
    ) -> Result<Vec<String>, String> {
        self.with_session(session_id, webview_label, |session| {
            assert_store(session, store)?;
            let mut stmt = session
                .conn
                .prepare("SELECT key FROM kv WHERE store = ?1 ORDER BY key COLLATE BINARY")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![store], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.map(|r| r.map_err(|e| e.to_string())).collect()
        })
    }

    pub fn put(
        &self,
        webview_label: &str,
        session_id: &str,
        store: &str,
        encoded_key: &str,
        value: &Value,
    ) -> Result<(), String> {
        self.with_session(session_id, webview_label, |session| {
            assert_store(session, store)?;
            if session.mode != TxnMode::Readwrite {
                return Err("readonly session cannot mutate".into());
            }
            let raw = serde_json::to_string(value).map_err(|e| e.to_string())?;
            session
                .conn
                .execute(
                    "INSERT INTO kv(store, key, value) VALUES (?1, ?2, ?3)
           ON CONFLICT(store, key) DO UPDATE SET value = excluded.value",
                    params![store, encoded_key, raw],
                )
                .map_err(|e| e.to_string())?;
            Ok(())
        })
    }

    pub fn delete(
        &self,
        webview_label: &str,
        session_id: &str,
        store: &str,
        encoded_key: &str,
    ) -> Result<(), String> {
        self.with_session(session_id, webview_label, |session| {
            assert_store(session, store)?;
            if session.mode != TxnMode::Readwrite {
                return Err("readonly session cannot mutate".into());
            }
            session
                .conn
                .execute(
                    "DELETE FROM kv WHERE store = ?1 AND key = ?2",
                    params![store, encoded_key],
                )
                .map_err(|e| e.to_string())?;
            Ok(())
        })
    }

    pub fn commit(&self, webview_label: &str, session_id: &str) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        {
            let session = guard
                .sessions
                .get(session_id)
                .ok_or_else(|| "unknown durable session".to_string())?;
            if session.webview_label != webview_label {
                return Err("session ownership mismatch".into());
            }
            session
                .conn
                .execute_batch("COMMIT")
                .map_err(|e| e.to_string())?;
        }
        drop_session(&mut guard, session_id);
        Ok(())
    }

    pub fn abort(&self, webview_label: &str, session_id: &str) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        {
            let session = guard
                .sessions
                .get(session_id)
                .ok_or_else(|| "unknown durable session".to_string())?;
            if session.webview_label != webview_label {
                return Err("session ownership mismatch".into());
            }
        }
        rollback_session(&mut guard, session_id)
    }

    pub fn manifest_get(&self) -> Result<Value, String> {
        let root = self.inner.lock().map_err(|e| e.to_string())?.root.clone();
        let path = durable_dir(&root).join(MANIFEST_FILE_NAME);
        if !path.exists() {
            if prior_phase_b_state_exists(&root) {
                return Err(
                    "migration manifest is missing while prior durable state exists".into(),
                );
            }
            return Ok(serde_json::json!({
              "activeCommitted": null,
              "epochs": [],
              "lease": null,
            }));
        }
        let conn = open_existing_manifest(&path)?;
        let mut stmt = conn
      .prepare("SELECT epoch_id, status, schema_version, created_at_ms, inventory_json, error_code, error_detail FROM epochs ORDER BY created_at_ms ASC")
      .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(serde_json::json!({
                  "epochId": row.get::<_, String>(0)?,
                  "status": row.get::<_, String>(1)?,
                  "schemaVersion": row.get::<_, i64>(2)?,
                  "createdAtMs": row.get::<_, i64>(3)?,
                  "inventoryJson": row.get::<_, String>(4)?,
                  "errorCode": row.get::<_, Option<String>>(5)?,
                  "errorDetail": row.get::<_, Option<String>>(6)?,
                }))
            })
            .map_err(|e| e.to_string())?;
        let epochs: Result<Vec<Value>, String> =
            rows.map(|r| r.map_err(|e| e.to_string())).collect();
        let epochs = epochs?;
        let active = epochs
            .iter()
            .rev()
            .find(|row| row.get("status") == Some(&Value::String("COMMITTED".into())))
            .cloned();
        if let Some(committed) = active.as_ref() {
            let epoch_id = committed
                .get("epochId")
                .and_then(Value::as_str)
                .ok_or_else(|| "committed epoch id is missing".to_string())?;
            let inventory_json = committed
                .get("inventoryJson")
                .and_then(Value::as_str)
                .ok_or_else(|| "committed inventory is missing".to_string())?;
            validate_committed_inventory(&root, epoch_id, inventory_json)?;
        }
        let lease = conn
            .query_row(
                "SELECT owner_id, expires_at_ms, heartbeat_ms FROM lease WHERE slot = 1",
                [],
                |row| {
                    Ok(serde_json::json!({
                      "ownerId": row.get::<_, Option<String>>(0)?,
                      "expiresAtMs": row.get::<_, Option<i64>>(1)?,
                      "heartbeatMs": row.get::<_, Option<i64>>(2)?,
                    }))
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(serde_json::json!({
          "activeCommitted": active,
          "epochs": epochs,
          "lease": lease,
        }))
    }

    pub fn manifest_put_epoch(
        &self,
        epoch_id: &str,
        status: &str,
        inventory_json: &str,
        error_code: Option<String>,
        error_detail: Option<String>,
    ) -> Result<(), String> {
        assert_canonical_epoch_id(epoch_id)?;
        let root = self.inner.lock().map_err(|e| e.to_string())?.root.clone();
        let conn = open_or_create_manifest_if_virgin(&root)?;
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        let existing: Option<(String, String, Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT status, inventory_json, error_code, error_detail FROM epochs WHERE epoch_id = ?1",
                params![epoch_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|e| {
                let _ = conn.execute_batch("ROLLBACK");
                e.to_string()
            })?;
        if let Err(err) =
            legal_epoch_transition(existing.as_ref().map(|(s, _, _, _)| s.as_str()), status)
        {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(err);
        }
        if let Some((prev_status, prev_inventory, prev_code, prev_detail)) = existing.as_ref() {
            if prev_status == "COMMITTED" {
                let same_inventory = prev_inventory == inventory_json;
                let same_code = prev_code.as_deref() == error_code.as_deref();
                let same_detail = prev_detail.as_deref() == error_detail.as_deref();
                if !(same_inventory && same_code && same_detail) {
                    let _ = conn.execute_batch("ROLLBACK");
                    return Err(
                        "COMMITTED epoch evidence is immutable and cannot be replaced".into(),
                    );
                }
                let _ = conn.execute_batch("ROLLBACK");
                return Ok(());
            }
        }
        if status == "COMMITTED" {
            if let Err(err) = validate_committed_inventory(&root, epoch_id, inventory_json) {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(err);
            }
        }
        let now = now_ms();
        conn
      .execute(
        "INSERT INTO epochs(epoch_id, status, schema_version, created_at_ms, inventory_json, error_code, error_detail)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(epoch_id) DO UPDATE SET
           status = excluded.status,
           inventory_json = excluded.inventory_json,
           error_code = excluded.error_code,
           error_detail = excluded.error_detail",
        params![
          epoch_id,
          status,
          MAX_KNOWN_EPOCH_SCHEMA as i64,
          now,
          inventory_json,
          error_code,
          error_detail
        ],
      )
      .map_err(|e| {
        let _ = conn.execute_batch("ROLLBACK");
        e.to_string()
      })?;
        conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        if status == "COMMITTED" {
            epoch_floor::write_floor_atomic(&root, env!("CARGO_PKG_VERSION"))?;
        }
        Ok(())
    }

    pub fn lease_acquire(&self, owner_id: &str, ttl_ms: i64) -> Result<bool, String> {
        let root = self.inner.lock().map_err(|e| e.to_string())?.root.clone();
        let conn = open_or_create_manifest_if_virgin(&root)?;
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        let now = now_ms();
        let existing: Option<(Option<String>, Option<i64>)> = conn
            .query_row(
                "SELECT owner_id, expires_at_ms FROM lease WHERE slot = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let can_take = match existing {
            None => true,
            Some((None, _)) => true,
            Some((Some(owner), Some(exp))) if owner == owner_id || exp <= now => true,
            Some((Some(_), None)) => true,
            Some(_) => false,
        };
        if !can_take {
            let _ = conn.execute_batch("ROLLBACK");
            return Ok(false);
        }
        conn
      .execute(
        "INSERT INTO lease(slot, owner_id, expires_at_ms, heartbeat_ms)
         VALUES (1, ?1, ?2, ?3)
         ON CONFLICT(slot) DO UPDATE SET owner_id = excluded.owner_id, expires_at_ms = excluded.expires_at_ms, heartbeat_ms = excluded.heartbeat_ms",
        params![owner_id, now + ttl_ms, now],
      )
      .map_err(|e| e.to_string())?;
        conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        Ok(true)
    }

    pub fn lease_heartbeat(&self, owner_id: &str, ttl_ms: i64) -> Result<(), String> {
        let root = self.inner.lock().map_err(|e| e.to_string())?.root.clone();
        let conn = open_or_create_manifest_if_virgin(&root)?;
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        let now = now_ms();
        let changed = conn
      .execute(
        "UPDATE lease SET expires_at_ms = ?1, heartbeat_ms = ?2 WHERE slot = 1 AND owner_id = ?3",
        params![now + ttl_ms, now, owner_id],
      )
      .map_err(|e| e.to_string())?;
        if changed == 0 {
            let _ = conn.execute_batch("ROLLBACK");
            return Err("lease heartbeat rejected".into());
        }
        conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn lease_release(&self, owner_id: &str) -> Result<(), String> {
        let root = self.inner.lock().map_err(|e| e.to_string())?.root.clone();
        let conn = open_or_create_manifest_if_virgin(&root)?;
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        conn
      .execute(
        "UPDATE lease SET owner_id = NULL, expires_at_ms = NULL, heartbeat_ms = NULL WHERE slot = 1 AND owner_id = ?1",
        params![owner_id],
      )
      .map_err(|e| e.to_string())?;
        conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn assert_store(session: &Session, store: &str) -> Result<(), String> {
    if session.stores.contains(store) {
        Ok(())
    } else {
        Err(format!("store '{store}' is not in session scope"))
    }
}

fn rollback_session(guard: &mut EngineInner, session_id: &str) -> Result<(), String> {
    if let Some(session) = guard.sessions.get(session_id) {
        let _ = session.conn.execute_batch("ROLLBACK");
    }
    drop_session(guard, session_id);
    Ok(())
}

fn drop_session(guard: &mut EngineInner, session_id: &str) {
    if let Some(session) = guard.sessions.remove(session_id) {
        guard
            .occupied
            .retain(|_, occupied_id| occupied_id != session_id);
        drop(session);
    }
}

fn webview_label(window: &tauri::Window) -> String {
    window.label().to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginResult {
    session_id: String,
}

#[tauri::command]
pub fn durable_kv_txn_begin(
    window: tauri::Window,
    engine: tauri::State<DurableKvEngine>,
    database: String,
    stores: Vec<String>,
    mode: String,
    epoch_id: String,
) -> Result<BeginResult, String> {
    let session_id = engine.begin(&webview_label(&window), &database, stores, &mode, &epoch_id)?;
    Ok(BeginResult { session_id })
}

#[tauri::command]
pub fn durable_kv_txn_get(
    window: tauri::Window,
    engine: tauri::State<DurableKvEngine>,
    session_id: String,
    store: String,
    encoded_key: String,
) -> Result<Option<Value>, String> {
    engine.get(&webview_label(&window), &session_id, &store, &encoded_key)
}

#[tauri::command]
pub fn durable_kv_txn_get_all(
    window: tauri::Window,
    engine: tauri::State<DurableKvEngine>,
    session_id: String,
    store: String,
) -> Result<Vec<Value>, String> {
    engine.get_all(&webview_label(&window), &session_id, &store)
}

#[tauri::command]
pub fn durable_kv_txn_get_all_keys(
    window: tauri::Window,
    engine: tauri::State<DurableKvEngine>,
    session_id: String,
    store: String,
) -> Result<Vec<String>, String> {
    engine.get_all_keys(&webview_label(&window), &session_id, &store)
}

#[tauri::command]
pub fn durable_kv_txn_put(
    window: tauri::Window,
    engine: tauri::State<DurableKvEngine>,
    session_id: String,
    store: String,
    encoded_key: String,
    value: Value,
) -> Result<(), String> {
    engine.put(
        &webview_label(&window),
        &session_id,
        &store,
        &encoded_key,
        &value,
    )
}

#[tauri::command]
pub fn durable_kv_txn_delete(
    window: tauri::Window,
    engine: tauri::State<DurableKvEngine>,
    session_id: String,
    store: String,
    encoded_key: String,
) -> Result<(), String> {
    engine.delete(&webview_label(&window), &session_id, &store, &encoded_key)
}

#[tauri::command]
pub fn durable_kv_txn_commit(
    window: tauri::Window,
    engine: tauri::State<DurableKvEngine>,
    session_id: String,
) -> Result<(), String> {
    engine.commit(&webview_label(&window), &session_id)
}

#[tauri::command]
pub fn durable_kv_txn_abort(
    window: tauri::Window,
    engine: tauri::State<DurableKvEngine>,
    session_id: String,
) -> Result<(), String> {
    engine.abort(&webview_label(&window), &session_id)
}

#[tauri::command]
pub fn durable_manifest_get(engine: tauri::State<DurableKvEngine>) -> Result<Value, String> {
    engine.manifest_get()
}

#[tauri::command]
pub fn durable_manifest_put_epoch(
    engine: tauri::State<DurableKvEngine>,
    epoch_id: String,
    status: String,
    inventory_json: String,
    error_code: Option<String>,
    error_detail: Option<String>,
) -> Result<(), String> {
    engine.manifest_put_epoch(
        &epoch_id,
        &status,
        &inventory_json,
        error_code,
        error_detail,
    )
}

#[tauri::command]
pub fn durable_manifest_lease_acquire(
    engine: tauri::State<DurableKvEngine>,
    owner_id: String,
    ttl_ms: i64,
) -> Result<bool, String> {
    engine.lease_acquire(&owner_id, ttl_ms)
}

#[tauri::command]
pub fn durable_manifest_lease_heartbeat(
    engine: tauri::State<DurableKvEngine>,
    owner_id: String,
    ttl_ms: i64,
) -> Result<(), String> {
    engine.lease_heartbeat(&owner_id, ttl_ms)
}

#[tauri::command]
pub fn durable_manifest_lease_release(
    engine: tauri::State<DurableKvEngine>,
    owner_id: String,
) -> Result<(), String> {
    engine.lease_release(&owner_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_EPOCH: &str = "epoch-1700000000000-0123456789abcdef0123456789abcdef";

    fn engine() -> (DurableKvEngine, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "twinpet-kv-test-{}-{}",
            std::process::id(),
            random_session_id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        (DurableKvEngine::new(dir.clone()), dir)
    }

    fn hex64() -> String {
        "a".repeat(64)
    }

    fn committed_inventory(branch_ids: &[&str]) -> String {
        let digest = hex64();
        let domains: Vec<Value> = DOMAIN_DATABASES
            .iter()
            .map(|database| {
                serde_json::json!({
                  "database": database,
                  "stores": ["kv"],
                  "rowCount": 0,
                  "digestSha256": digest,
                })
            })
            .collect();
        serde_json::json!({
          "schemaVersion": MAX_KNOWN_EPOCH_SCHEMA,
          "domains": domains,
          "p13": {
            "branchIds": branch_ids,
            "rowCount": 0,
            "identicalDuplicateCount": 0,
            "malformedBranchErrors": 0,
            "invalidBillErrors": 0,
            "divergentDuplicateErrors": 0,
            "allCartLinesSchemaValid": true,
            "digestSha256": digest
          }
        })
        .to_string()
    }

    fn seed_domain_files(root: &Path, epoch: &str) {
        for database in DOMAIN_DATABASES {
            let path = domain_file_path(root, database, epoch).unwrap();
            open_kv_connection(&path, true).unwrap();
        }
    }

    fn begin_device(engine: &DurableKvEngine, mode: &str) -> String {
        engine
            .begin(
                "main",
                "twinpet-device",
                vec!["kv".into()],
                mode,
                TEST_EPOCH,
            )
            .unwrap()
    }

    #[test]
    fn commit_persists_and_rollback_discards() {
        let (engine, dir) = engine();
        let sid = begin_device(&engine, "readwrite");
        engine
            .put("main", &sid, "kv", "B8:deviceId", &serde_json::json!("ABC"))
            .unwrap();
        engine.commit("main", &sid).unwrap();

        let sid2 = begin_device(&engine, "readonly");
        let got = engine.get("main", &sid2, "kv", "B8:deviceId").unwrap();
        engine.commit("main", &sid2).unwrap();
        assert_eq!(got, Some(serde_json::json!("ABC")));

        let sid3 = begin_device(&engine, "readwrite");
        engine
            .put("main", &sid3, "kv", "B9:deviceSeq", &serde_json::json!(1))
            .unwrap();
        engine.abort("main", &sid3).unwrap();
        let sid4 = begin_device(&engine, "readonly");
        let seq = engine.get("main", &sid4, "kv", "B9:deviceSeq").unwrap();
        engine.commit("main", &sid4).unwrap();
        assert_eq!(seq, None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn readonly_put_is_rejected() {
        let (engine, dir) = engine();
        let sid = begin_device(&engine, "readonly");
        let err = engine
            .put("main", &sid, "kv", "B8:deviceId", &serde_json::json!("x"))
            .unwrap_err();
        assert!(err.contains("readonly"));
        let _ = engine.abort("main", &sid);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unknown_session_is_rejected() {
        let (engine, dir) = engine();
        let err = engine.get("main", "deadbeef", "kv", "B1:x").unwrap_err();
        assert!(err.contains("unknown"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn crash_before_commit_leaves_no_rows() {
        let (engine, dir) = engine();
        let sid = begin_device(&engine, "readwrite");
        engine
            .put("main", &sid, "kv", "B8:deviceId", &serde_json::json!("XYZ"))
            .unwrap();
        drop(engine);
        let engine2 = DurableKvEngine::new(dir.clone());
        let sid2 = engine2
            .begin(
                "main",
                "twinpet-device",
                vec!["kv".into()],
                "readonly",
                TEST_EPOCH,
            )
            .unwrap();
        let got = engine2.get("main", &sid2, "kv", "B8:deviceId").unwrap();
        engine2.commit("main", &sid2).unwrap();
        assert_eq!(got, None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn committed_epoch_cannot_demote() {
        let (engine, dir) = engine();
        engine
            .manifest_put_epoch(TEST_EPOCH, "COPYING", "{}", None, None)
            .unwrap();
        seed_domain_files(&dir, TEST_EPOCH);
        let inventory = committed_inventory(&["empty-branch"]);
        engine
            .manifest_put_epoch(TEST_EPOCH, "COMMITTED", &inventory, None, None)
            .unwrap();
        for status in ["FAILED", "COPYING", "ABORTED", "VERIFYING"] {
            let err = engine
                .manifest_put_epoch(TEST_EPOCH, status, "{}", None, None)
                .unwrap_err();
            assert!(
                err.contains("COMMITTED"),
                "status {status} should be rejected: {err}"
            );
        }
        engine
            .manifest_put_epoch(TEST_EPOCH, "COMMITTED", &inventory, None, None)
            .unwrap();
        let conflict = engine
            .manifest_put_epoch(
                TEST_EPOCH,
                "COMMITTED",
                &committed_inventory(&["other"]),
                None,
                None,
            )
            .unwrap_err();
        assert!(conflict.contains("immutable"));
        let snapshot = engine.manifest_get().unwrap();
        assert_eq!(
            snapshot["activeCommitted"]["epochId"],
            Value::String(TEST_EPOCH.into())
        );
        assert_eq!(
            snapshot["activeCommitted"]["status"],
            Value::String("COMMITTED".into())
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn pre_commit_failure_may_mark_failed() {
        let (engine, dir) = engine();
        engine
            .manifest_put_epoch(TEST_EPOCH, "COPYING", "{}", None, None)
            .unwrap();
        engine
            .manifest_put_epoch(
                TEST_EPOCH,
                "FAILED",
                "{}",
                Some("m2_failed".into()),
                Some("digest".into()),
            )
            .unwrap();
        let snapshot = engine.manifest_get().unwrap();
        assert_eq!(snapshot["activeCommitted"], Value::Null);
        assert_eq!(
            snapshot["epochs"][0]["status"],
            Value::String("FAILED".into())
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn epoch_path_traversal_is_rejected() {
        let (engine, dir) = engine();
        let overlength = format!("epoch-{}-{}", "1".repeat(17), "a".repeat(32));
        let bad = [
            "../",
            "..\\",
            "../../../outside",
            "slash/id",
            "back\\slash",
            "C:\\Windows\\x",
            "\\\\server\\share",
            "",
            "   ",
            "epoch-1",
            overlength.as_str(),
        ];
        for epoch in bad {
            let err = engine
                .begin(
                    "main",
                    "twinpet-device",
                    vec!["kv".into()],
                    "readonly",
                    epoch,
                )
                .unwrap_err();
            assert!(
                err.contains("epoch") || err.contains("canonical") || err.contains("empty"),
                "epoch {epoch:?} => {err}"
            );
            let put_err = engine
                .manifest_put_epoch(epoch, "COPYING", "{}", None, None)
                .unwrap_err();
            assert!(
                put_err.contains("epoch")
                    || put_err.contains("canonical")
                    || put_err.contains("empty"),
                "put {epoch:?} => {put_err}"
            );
        }
        let outside = dir.join("outside.sqlite");
        assert!(!outside.exists());
        let durable = durable_dir(&dir);
        if durable.exists() {
            for entry in std::fs::read_dir(&durable).unwrap().flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                assert!(!name.contains(".."), "{name}");
            }
        }
        let sid = begin_device(&engine, "readonly");
        engine.commit("main", &sid).unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn manifest_invalid_epoch_is_rejected_before_sqlite_open() {
        let (engine, dir) = engine();
        epoch_floor::write_floor_atomic(&dir, "test-build").unwrap();
        let manifest = durable_dir(&dir).join(MANIFEST_FILE_NAME);
        std::fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        let conn = Connection::open(&manifest).unwrap();
        create_manifest_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO epochs(epoch_id, status, schema_version, created_at_ms, inventory_json, error_code, error_detail)
             VALUES (?1, 'COMMITTED', 1, 1, '{}', NULL, NULL)",
            params!["../../../outside"],
        )
        .unwrap();
        drop(conn);
        let err = assert_startup_integrity(&dir).unwrap_err();
        assert!(
            err.contains("canonical") || err.contains("epoch") || err.contains("forbidden"),
            "{err}"
        );
        assert!(!dir.join("outside.sqlite").exists());
        let begin_err = engine
            .begin(
                "main",
                "twinpet-device",
                vec!["kv".into()],
                "readonly",
                "../../../outside",
            )
            .unwrap_err();
        assert!(begin_err.contains("epoch") || begin_err.contains("forbidden"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn true_virgin_startup_is_permitted() {
        let dir = std::env::temp_dir().join(format!(
            "twinpet-kv-virgin-{}-{}",
            std::process::id(),
            random_session_id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(assert_startup_integrity(&dir).is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn valid_floor_missing_manifest_fails_closed() {
        let dir = std::env::temp_dir().join(format!(
            "twinpet-kv-floor-{}-{}",
            std::process::id(),
            random_session_id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        epoch_floor::write_floor_atomic(&dir, "test-build").unwrap();
        let err = assert_startup_integrity(&dir).unwrap_err();
        assert!(err.contains("manifest"), "{err}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_manifest_fails_closed() {
        let dir = std::env::temp_dir().join(format!(
            "twinpet-kv-corrupt-{}-{}",
            std::process::id(),
            random_session_id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        epoch_floor::write_floor_atomic(&dir, "test-build").unwrap();
        let manifest = durable_dir(&dir).join(MANIFEST_FILE_NAME);
        std::fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        std::fs::write(&manifest, b"not-a-sqlite-database").unwrap();
        let err = assert_startup_integrity(&dir).unwrap_err();
        assert!(
            err.contains("corrupt") || err.contains("unreadable") || err.contains("manifest"),
            "{err}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn committed_missing_domain_file_fails_closed_without_creating_substitute() {
        let (engine, dir) = engine();
        engine
            .manifest_put_epoch(TEST_EPOCH, "COPYING", "{}", None, None)
            .unwrap();
        seed_domain_files(&dir, TEST_EPOCH);
        let missing = domain_file_path(&dir, "twinpet-device", TEST_EPOCH).unwrap();
        std::fs::remove_file(&missing).unwrap();
        let err = engine
            .manifest_put_epoch(
                TEST_EPOCH,
                "COMMITTED",
                &committed_inventory(&[]),
                None,
                None,
            )
            .unwrap_err();
        assert!(err.contains("missing"), "{err}");
        assert!(!missing.exists());
        epoch_floor::write_floor_atomic(&dir, "test-build").unwrap();
        let startup = assert_startup_integrity(&dir).unwrap_err();
        assert!(
            startup.contains("COMMITTED")
                || startup.contains("manifest")
                || startup.contains("missing"),
            "{startup}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn committed_incomplete_inventory_and_invalid_digest_fail_closed() {
        let (engine, dir) = engine();
        engine
            .manifest_put_epoch(TEST_EPOCH, "COPYING", "{}", None, None)
            .unwrap();
        seed_domain_files(&dir, TEST_EPOCH);
        let incomplete = serde_json::json!({
          "schemaVersion": 1,
          "domains": [{
            "database": "twinpet-device",
            "digestSha256": hex64()
          }]
        })
        .to_string();
        let err = engine
            .manifest_put_epoch(TEST_EPOCH, "COMMITTED", &incomplete, None, None)
            .unwrap_err();
        assert!(err.contains("eight") || err.contains("domains"), "{err}");
        let bad_digest = committed_inventory(&[]).replace(&hex64(), "zzzz");
        let err = engine
            .manifest_put_epoch(TEST_EPOCH, "COMMITTED", &bad_digest, None, None)
            .unwrap_err();
        assert!(
            err.contains("digest") || err.contains("eight") || err.contains("P-13"),
            "{err}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn consistent_committed_state_is_discoverable() {
        let (engine, dir) = engine();
        engine
            .manifest_put_epoch(TEST_EPOCH, "COPYING", "{}", None, None)
            .unwrap();
        seed_domain_files(&dir, TEST_EPOCH);
        engine
            .manifest_put_epoch(
                TEST_EPOCH,
                "COMMITTED",
                &committed_inventory(&["empty-branch"]),
                None,
                None,
            )
            .unwrap();
        assert!(assert_startup_integrity(&dir).is_ok());
        let snapshot = engine.manifest_get().unwrap();
        assert_eq!(
            snapshot["activeCommitted"]["epochId"],
            Value::String(TEST_EPOCH.into())
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
