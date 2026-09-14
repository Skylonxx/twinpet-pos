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

/// SEC-001 Codex-005 remediation (Claude-046, same Gemini-062 authority): the
/// manifest limb of this predicate was `durable_dir(root).join(..).exists()`,
/// which follows symlinks. A dangling manifest symlink — a directory entry that
/// exists — therefore contributed `false`, and with no floor and no domain
/// files the whole predicate answered "no prior durable state". That answer is
/// what `open_or_create_manifest_if_virgin` and `manifest_get` consult before
/// treating the pathname as virgin, so the false absence propagated straight
/// into manifest creation and into the empty-manifest view.
///
/// The manifest limb now goes through the shared `manifest_path_state`
/// classifier: only genuine pathname absence contributes `false`, `RegularFile`
/// (direct or via a symlink resolving to a regular file) contributes `true`,
/// and every unusable-but-present or unreadable pathname is an `Err` that
/// callers must propagate rather than a boolean they can misread as absence.
///
/// The floor and domain limbs still use `epoch_floor`'s existence semantics.
/// `epoch_floor::durable_domain_files_exist` is outside this packet's
/// one-file allowlist and keeps following symlinks, but it can now only ever
/// *understate* prior state for the manifest pathname specifically — and that
/// pathname is decided here by the classifier, which fails closed.
fn prior_phase_b_state_exists(root: &Path) -> Result<bool, String> {
    if epoch_floor::floor_path(root).exists() || epoch_floor::durable_domain_files_exist(root) {
        return Ok(true);
    }
    Ok(match manifest_path_state(&durable_dir(root).join(MANIFEST_FILE_NAME))? {
        ManifestPathState::Absent => false,
        ManifestPathState::RegularFile => true,
    })
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
        conn.pragma_update(None, "user_version", CURRENT_MANIFEST_SQLITE_USER_VERSION)
            .map_err(|e| e.to_string())?;
    } else if version != CURRENT_MANIFEST_SQLITE_USER_VERSION {
        return Err(format!("unsupported manifest user_version {version}"));
    }
    Ok(())
}

/// SEC-001 existing-manifest version gate (Claude-042 / Gemini-062 authority
/// `TWINPET-TRUE-STANDALONE-SEC-001-SCENARIO08R-MANIFEST-USER-VERSION-ADJUDICATION-GEMINI-062`):
/// the migration-manifest SQLite file's own `PRAGMA user_version` is a schema
/// contract for the manifest file alone. It is intentionally decoupled from
/// `MAX_KNOWN_EPOCH_SCHEMA`, `inventory_json.schemaVersion`, domain SQLite
/// `user_version`, and `epochs.schema_version` — none of those may be
/// substituted for it. AGY-003 proved `open_existing_manifest` never checked
/// this pragma at all, so a manifest hand-mutated to an unknown-newer version
/// (e.g. 2) was silently trusted through startup.
const CURRENT_MANIFEST_SQLITE_USER_VERSION: i32 = 1;

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
    // Existing (nonvirgin) manifest: require exact version equality. A
    // nonvirgin file left at 0 is not entitled to virgin treatment — only a
    // genuinely new file (handled in `create_manifest_schema`) may start at 0.
    let version: i32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| format!("migration manifest is corrupt: {e}"))?;
    if version != CURRENT_MANIFEST_SQLITE_USER_VERSION {
        return Err(format!("unsupported manifest user_version {version}"));
    }
    Ok(conn)
}

/// SEC-001 Codex-005 blocking-finding remediation (Claude-046, same Gemini-062
/// authority): the presence test here was `path.exists()`, which follows
/// symlinks. On a dangling manifest symlink it reported `false`, the helper
/// took the virgin branch, and `Connection::open(&path)` then *followed the
/// link and created the missing target* — potentially outside the durable
/// directory — initializing it as an authoritative manifest at
/// `user_version` 1. Every public manifest/lease writer reaches this helper, so
/// the create was production-reachable.
///
/// Pathname presence is now decided by the shared `manifest_path_state`
/// classifier before anything opens the path: creation is reachable only from
/// `Absent`, i.e. no directory entry at the manifest pathname at all. A
/// pathname that resolves to a regular file (directly or through a symlink)
/// keeps its existing accepted behaviour — it is authoritative and goes through
/// the `open_existing_manifest` version gate, never re-created. A dangling
/// symlink, a nonregular target, or a metadata error fails closed, so
/// `Connection::open` can no longer materialize a missing symlink target.
fn open_or_create_manifest_if_virgin(root: &Path) -> Result<Connection, String> {
    let path = durable_dir(root).join(MANIFEST_FILE_NAME);
    match manifest_path_state(&path)? {
        // Present and usable: authoritative, validated, never re-created.
        ManifestPathState::RegularFile => return open_existing_manifest(&path),
        // Genuine pathname absence is the only state entitled to creation.
        ManifestPathState::Absent => {}
    }
    if prior_phase_b_state_exists(root)? {
        return Err("migration manifest is missing while prior durable state exists".into());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    create_manifest_schema(&conn)?;
    Ok(conn)
}

/// Directory-entry state of the migration-manifest pathname, kept deliberately
/// distinct from the state of whatever that pathname resolves to. Only
/// `Absent` — no directory entry at the pathname at all — may be read as "no
/// manifest"; every other non-usable state is an `Err` from
/// `manifest_path_state`, never a variant callers can mistake for absence.
enum ManifestPathState {
    /// No directory entry exists at the manifest pathname.
    Absent,
    /// The pathname yields a regular file, either directly or through a
    /// symlink whose target is a regular file.
    RegularFile,
}

/// SEC-001 Codex-004 remediation (Claude-045, Gemini-062 authority): the single
/// manifest-pathname classifier shared by the `DurableKvEngine::begin` status
/// read and the `assert_startup_integrity` startup gate, so both sides of the
/// manifest boundary answer "is there a manifest here?" the same way.
///
/// The distinction that matters is pathname presence versus target presence.
/// `std::fs::metadata` and `Path::exists` both follow symlinks, so a dangling
/// manifest symlink — a directory entry that very much exists — reports
/// `NotFound`/`false` and reads as genuine absence. `symlink_metadata` is
/// therefore used first: it never follows the link, so `ErrorKind::NotFound`
/// from it is the only genuine nonexistence signal.
///
/// A symlink that resolves to a regular manifest keeps its existing accepted
/// behaviour: it is `RegularFile`, and the caller puts it through
/// `open_existing_manifest` and the full manifest version/table validation
/// exactly as for a direct regular file. Being a symlink is not itself
/// rejected — only a symlink that cannot yield a regular file is.
fn manifest_path_state(path: &Path) -> Result<ManifestPathState, String> {
    let entry = match std::fs::symlink_metadata(path) {
        Ok(entry) => entry,
        // Pathname-level not-found: no directory entry at all. The only
        // condition entitled to be read as absence.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ManifestPathState::Absent)
        }
        Err(e) => return Err(format!("migration manifest path is unreadable: {e}")),
    };
    if entry.file_type().is_symlink() {
        // The pathname exists. Only the target's usability is still open, and
        // an unusable target is an error about a present manifest path — never
        // absence.
        return match std::fs::metadata(path) {
            Ok(target) if target.is_file() => Ok(ManifestPathState::RegularFile),
            Ok(_) => Err("migration manifest path is not a regular file".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                Err("migration manifest symlink target is missing".into())
            }
            Err(e) => Err(format!("migration manifest path is unreadable: {e}")),
        };
    }
    if entry.is_file() {
        return Ok(ManifestPathState::RegularFile);
    }
    Err("migration manifest path is not a regular file".into())
}

/// SEC-001 Codex-002 remediation (Claude-043, same Gemini-062 authority): this
/// status read previously called `Connection::open` directly and collapsed every
/// failure to `None`, bypassing the `open_existing_manifest` version gate. An
/// existing manifest at `user_version` 0/2/99 was therefore still trusted here
/// even though startup rejects it, and `DurableKvEngine::begin` read that `None`
/// as "no committed epoch" — the exact false-uncommitted classification that
/// permits domain creation. The read now goes through the single validated
/// existing-manifest path, so absence of the manifest file is the only condition
/// that yields `None`; an existing-but-invalid manifest returns `Err`.
///
/// SEC-001 Codex-003 remediation (Claude-044, same Gemini-062 authority): the
/// absence test itself was still `!path.is_file()`, a convenience boolean that
/// collapses "genuinely not there" together with "exists but is not a regular
/// file" (for example a directory named `twinpet-migration-manifest.sqlite`)
/// and with metadata inspection failures. Those existing-but-invalid path
/// states therefore became `Ok(None)`, which `DurableKvEngine::begin` read as
/// "no committed epoch" — the same false-uncommitted classification, reached by
/// a different route, that lets `open_kv_connection(.., create = true)` create a
/// domain SQLite file under a manifest path that was never validated. The check
/// became explicit instead: only `ErrorKind::NotFound` may yield `Ok(None)`; an
/// existing non-file path and any other metadata error both fail closed.
///
/// SEC-001 Codex-004 remediation (Claude-045, same Gemini-062 authority): that
/// check used `std::fs::metadata`, which *follows* symlinks and therefore
/// reports the state of the target rather than of the pathname. A manifest
/// pathname present as a symlink whose target does not exist yielded
/// `ErrorKind::NotFound` from the target lookup, which the absence branch read
/// as genuine nonexistence — a third route to the same false-uncommitted
/// classification, under a manifest pathname that exists and was never
/// validated. Pathname presence is now decided by `manifest_path_state`, which
/// inspects the directory entry itself before ever following it.
fn epoch_status_from_manifest(root: &Path, epoch_id: &str) -> Result<Option<String>, String> {
    let path = durable_dir(root).join(MANIFEST_FILE_NAME);
    match manifest_path_state(&path)? {
        ManifestPathState::Absent => return Ok(None),
        ManifestPathState::RegularFile => {}
    }
    let conn = open_existing_manifest(&path)?;
    conn.query_row(
        "SELECT status FROM epochs WHERE epoch_id = ?1",
        params![epoch_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| format!("migration manifest is unreadable: {e}"))
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

/// SEC-001 schema-1 compatibility remediation (Claude-040 / Gemini-059 authority
/// `OPTION_A_DECOUPLE_KEEP_CURRENT_INVENTORY_SCHEMA_1`): the migration-inventory
/// contract version carried in `inventory_json.schemaVersion` is intentionally
/// independent from the global epoch schema (`MAX_KNOWN_EPOCH_SCHEMA`, defined in
/// `epoch_floor.rs`). AGY-001 proved a historical committed manifest legitimately
/// persisted with `schemaVersion=1` before any global epoch bump was being
/// rejected only because this validator compared it against the global constant
/// instead of the inventory contract's own version. The inventory contract has
/// not changed shape, so its supported set remains `{1}` regardless of later,
/// unrelated global epoch bumps; a future inventory contract change must bump
/// this constant explicitly, not implicitly track the global epoch.
const CURRENT_MIGRATION_INVENTORY_SCHEMA_VERSION: u64 = 1;

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
    if schema != CURRENT_MIGRATION_INVENTORY_SCHEMA_VERSION {
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
    // SEC-001 Codex-005 remediation (Claude-046): this presence test was
    // `!path.exists()`. It already failed closed either way, so it was never a
    // false-absence hole, but it recreated independent pathname semantics
    // alongside the shared classifier. It now uses `manifest_path_state` so
    // every manifest-pathname decision in this file has exactly one source.
    match manifest_path_state(&path)? {
        ManifestPathState::Absent => {
            return Err("migration manifest is missing while a committed epoch floor exists".into())
        }
        ManifestPathState::RegularFile => {}
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
///
/// SEC-001 epoch-2 rollback remediation (Claude-024 / Gemini-041 authority
/// `GLOBAL_FLOOR_INDEPENDENT_OF_LEGACY_MANIFEST`): the committed epoch floor
/// can legitimately exist with no legacy Phase-B manifest ever having been
/// created — e.g. a machine that only ever exercised privileged-auth state,
/// which commits floor 2 independently of Phase-B migration. A committed
/// floor therefore does *not* by itself imply a manifest must exist; only
/// actual legacy Phase-B durable state (the manifest file itself, or domain
/// `.sqlite` files) does. Codex-011 found the prior version of this function
/// conflated the two, incorrectly failing closed on a legitimate
/// privileged-auth-only clean-install restart.
///
/// SEC-001 Codex-005 remediation (Claude-046, same Gemini-062 authority): the
/// `PermitVirgin` arm returned `Ok(())` immediately, before any manifest
/// pathname was ever inspected, so the Claude-045 pathname validation on the
/// `PermitCompatible` arm was simply never reached on the no-floor path.
/// `epoch_floor::durable_domain_files_exist` decides presence with
/// symlink-following existence semantics and lives outside this packet's
/// one-file allowlist, so with no floor, no domain files and a dangling
/// manifest symlink the floor evaluation legitimately answers `PermitVirgin` —
/// and startup was then permitted under a manifest pathname that exists and is
/// unusable, letting `lib.rs` proceed to the floor write and WebView start.
///
/// The manifest pathname is therefore classified on this arm too, before the
/// virgin return. This deliberately changes nothing about floor/virgin policy:
/// both `Ok` classifications stay permitted exactly as before (a resolvable
/// manifest is in any case unreachable here — `durable_domain_files_exist`
/// follows the pathname, so it would already have made `evaluate_floor` fail
/// closed). Only the error half is new: a present-but-unusable manifest
/// pathname now fails closed instead of passing as virgin startup. Nothing is
/// created and no runtime state is mutated by the check.
pub fn assert_startup_integrity(app_data: &Path) -> Result<(), String> {
    match epoch_floor::evaluate_floor(app_data) {
        epoch_floor::FloorDecision::PermitVirgin => {
            let manifest_path = durable_dir(app_data).join(MANIFEST_FILE_NAME);
            let _ = manifest_path_state(&manifest_path)?;
            Ok(())
        }
        epoch_floor::FloorDecision::FailClosed { reason } => Err(reason),
        epoch_floor::FloorDecision::PermitCompatible { .. } => {
            let manifest_path = durable_dir(app_data).join(MANIFEST_FILE_NAME);
            // SEC-001 Codex-004 remediation (Claude-045): this was
            // `manifest_path.exists()`, which follows symlinks. A compatible
            // floor with no domain files and a dangling manifest symlink
            // therefore fell through both branches below and startup was
            // *permitted* — the same pathname-versus-target confusion Codex-004
            // found in the `begin` status read, on the startup side of the same
            // boundary. `manifest_path_state` decides pathname presence, so an
            // unusable-but-present manifest pathname now fails closed here too.
            match manifest_path_state(&manifest_path)? {
                ManifestPathState::RegularFile => {
                    // A manifest exists (whatever its state) — it is
                    // authoritative and must validate.
                    return validate_existing_committed_state(app_data);
                }
                ManifestPathState::Absent => {}
            }
            if epoch_floor::durable_domain_files_exist(app_data) {
                // Legacy Phase-B durable state exists but its manifest is
                // missing: this is exactly the case the manifest is required
                // to explain. Fail closed.
                return Err(
                    "migration manifest is missing while durable domain files exist".into(),
                );
            }
            // No manifest and no legacy Phase-B domain files: the committed
            // floor reflects privileged-auth-only (or otherwise non-legacy)
            // state, which never required a Phase-B manifest. Permit.
            Ok(())
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
                    // Codex-002 remediation: an existing-but-unsupported manifest
                    // must abort the session here rather than degrade into the
                    // `committed == false` branch below, which would let
                    // `open_kv_connection` create a domain file.
                    let committed = epoch_status_from_manifest(&guard.root, epoch_id)?
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

    /// SEC-001 Codex-005 remediation (Claude-046, same Gemini-062 authority):
    /// the absence test was `!path.exists()`, which follows symlinks, so a
    /// dangling manifest symlink took the absence branch and — with no floor
    /// and no domain files — returned the empty/virgin manifest payload. A
    /// present-but-unusable manifest pathname was thereby reported to callers
    /// as "no epochs, no lease, nothing committed". Pathname presence is now
    /// decided by the shared `manifest_path_state` classifier: only genuine
    /// pathname absence may yield the empty view, a resolvable regular file
    /// (direct or through a symlink) is read through the validated
    /// `open_existing_manifest` gate as before, and dangling/nonregular/
    /// unreadable fails closed.
    pub fn manifest_get(&self) -> Result<Value, String> {
        let root = self.inner.lock().map_err(|e| e.to_string())?.root.clone();
        let path = durable_dir(&root).join(MANIFEST_FILE_NAME);
        match manifest_path_state(&path)? {
            ManifestPathState::Absent => {
                if prior_phase_b_state_exists(&root)? {
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
            ManifestPathState::RegularFile => {}
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

    /// Builds a syntactically-complete committed inventory with an explicit
    /// `schemaVersion`, passed in by the caller as a plain literal so each
    /// call site controls its own version independently of any named
    /// constant.
    fn inventory_with_schema(schema_version: u64, branch_ids: &[&str]) -> String {
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
          "schemaVersion": schema_version,
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

    fn committed_inventory(branch_ids: &[&str]) -> String {
        inventory_with_schema(CURRENT_MIGRATION_INVENTORY_SCHEMA_VERSION, branch_ids)
    }

    /// SEC-001 Claude-040 historical literal schema-1 regression fixture.
    /// The `1` here is a hardcoded literal — deliberately NOT
    /// `CURRENT_MIGRATION_INVENTORY_SCHEMA_VERSION` and NOT
    /// `MAX_KNOWN_EPOCH_SCHEMA` — so a future bump of either named constant
    /// cannot silently rewrite this fixture out from under the regression it
    /// exists to prove: that bytes literally persisted with
    /// `"schemaVersion": 1` before any global epoch bump remain acceptable.
    fn historical_literal_schema1_inventory(branch_ids: &[&str]) -> String {
        inventory_with_schema(1, branch_ids)
    }

    /// Creates `link` as a **file** symlink pointing at `target`, which is not
    /// required to exist. Per the Claude-045 test-portability requirement the
    /// symlink regressions must never be silently skipped or degraded, so a
    /// creation failure panics loudly with the exact OS error instead.
    fn symlink_file_for_test(target: &Path, link: &Path) {
        #[cfg(windows)]
        let result = std::os::windows::fs::symlink_file(target, link);
        #[cfg(unix)]
        let result = std::os::unix::fs::symlink(target, link);
        if let Err(e) = result {
            panic!(
                "BLOCKED_TEST_ENVIRONMENT_SYMLINK_CREATION: file symlink {link:?} -> \
                 {target:?} failed: kind={:?} raw={:?}: {e}",
                e.kind(),
                e.raw_os_error()
            );
        }
    }

    /// Creates `link` as a **directory** symlink pointing at `target`. Used to
    /// build the symlink-to-nonregular-target fixture, which on Windows must
    /// be a directory symlink for the target to resolve at all.
    fn symlink_dir_for_test(target: &Path, link: &Path) {
        #[cfg(windows)]
        let result = std::os::windows::fs::symlink_dir(target, link);
        #[cfg(unix)]
        let result = std::os::unix::fs::symlink(target, link);
        if let Err(e) = result {
            panic!(
                "BLOCKED_TEST_ENVIRONMENT_SYMLINK_CREATION: dir symlink {link:?} -> \
                 {target:?} failed: kind={:?} raw={:?}: {e}",
                e.kind(),
                e.raw_os_error()
            );
        }
    }

    /// Asserts the fixture really is the pathname-present/target-missing state
    /// Codex-004 described, so the regressions below cannot pass vacuously
    /// against a fixture that silently failed to materialize.
    fn assert_dangling_symlink(link: &Path) {
        let entry = std::fs::symlink_metadata(link)
            .expect("manifest pathname must exist as a directory entry");
        assert!(
            entry.file_type().is_symlink(),
            "fixture must be a symlink at the manifest pathname"
        );
        let target = std::fs::metadata(link);
        assert!(
            target.is_err(),
            "fixture target must be missing, but metadata resolved"
        );
        assert_eq!(
            target.unwrap_err().kind(),
            std::io::ErrorKind::NotFound,
            "fixture target must be missing with NotFound"
        );
        assert!(
            !link.exists(),
            "Path::exists() must report false here — this is exactly the \
             follow-the-symlink false-absence signal the fix stops trusting"
        );
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

    /// SEC-001 epoch-2 rollback remediation (Claude-024), required behavioral
    /// test #2/#3: a committed floor with no legacy Phase-B durable state
    /// (no domain `.sqlite` files) and no manifest must PASS — this is the
    /// clean-install / privileged-auth-only restart case Codex-011 found
    /// incorrectly failing closed under the prior (pre-remediation) logic,
    /// which required the previous version of this same test to assert the
    /// opposite outcome.
    #[test]
    fn floor2_no_legacy_state_no_manifest_passes() {
        let dir = std::env::temp_dir().join(format!(
            "twinpet-kv-floor-nolegacy-{}-{}",
            std::process::id(),
            random_session_id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        epoch_floor::write_floor_atomic(&dir, "test-build").unwrap();
        assert!(assert_startup_integrity(&dir).is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// SEC-001 epoch-2 rollback remediation (Claude-024), required behavioral
    /// test #3: privileged-auth-only state (no legacy Phase-B artifacts) plus
    /// a committed floor and no legacy manifest must PASS.
    #[test]
    fn privileged_auth_only_state_with_floor2_and_no_legacy_manifest_passes() {
        let dir = std::env::temp_dir().join(format!(
            "twinpet-kv-floor-privauth-{}-{}",
            std::process::id(),
            random_session_id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("twinpet-oac-pepper.dpapi"), b"x").unwrap();
        epoch_floor::write_floor_atomic(&dir, "test-build").unwrap();
        assert!(assert_startup_integrity(&dir).is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// SEC-001 epoch-2 rollback remediation (Claude-024), required behavioral
    /// test #1: a true virgin machine that commits floor 2 at startup and is
    /// then restarted with no legacy manifest ever having existed must PASS
    /// on the simulated restart.
    #[test]
    fn virgin_floor2_commit_then_restart_with_no_legacy_manifest_passes() {
        let (_, dir) = engine();
        assert!(assert_startup_integrity(&dir).is_ok());
        epoch_floor::write_floor_atomic(&dir, "test-build").unwrap();
        // Simulated restart: re-evaluate from disk state only.
        assert!(assert_startup_integrity(&dir).is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// SEC-001 epoch-2 rollback remediation (Claude-024), required behavioral
    /// test #4: legacy Phase-B durable state (domain `.sqlite` files) that
    /// actually requires a manifest, with the manifest missing, must fail
    /// closed — this is the real defect the manifest requirement protects
    /// against, and must remain intact after distinguishing it from the
    /// no-legacy-state case above.
    #[test]
    fn legacy_durable_domain_files_without_manifest_fails_closed() {
        let dir = std::env::temp_dir().join(format!(
            "twinpet-kv-floor-legacy-nomanifest-{}-{}",
            std::process::id(),
            random_session_id()
        ));
        let durable = durable_dir(&dir);
        std::fs::create_dir_all(&durable).unwrap();
        std::fs::write(durable.join("twinpet-device.epoch1.sqlite"), b"x").unwrap();
        epoch_floor::write_floor_atomic(&dir, "test-build").unwrap();
        let err = assert_startup_integrity(&dir).unwrap_err();
        assert!(err.contains("manifest") && err.contains("domain"), "{err}");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// SEC-001 epoch-2 rollback remediation (Claude-024), required behavioral
    /// test #7: an epoch-1 legacy floor with no legacy Phase-B state and no
    /// manifest must remain permitted under this (epoch-2) binary, exactly
    /// like the epoch-2 case above — the manifest-requirement fix must not
    /// regress epoch-1 compatibility.
    #[test]
    fn epoch1_floor_with_no_legacy_state_passes_under_epoch2_binary() {
        let dir = std::env::temp_dir().join(format!(
            "twinpet-kv-floor-epoch1-nolegacy-{}-{}",
            std::process::id(),
            random_session_id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            epoch_floor::floor_path(&dir),
            "committedEpochFloor=1\nwriterBuildId=legacy-build\n",
        )
        .unwrap();
        assert!(assert_startup_integrity(&dir).is_ok());
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

    /// SEC-001 Claude-042 / Gemini-062 full-startup regression matching the
    /// AGY-003 runtime evidence exactly: a source-valid COMMITTED manifest
    /// with valid domain files and a compatible floor, whose manifest SQLite
    /// `user_version` is then mutated to 2 (a value SQLite itself accepts —
    /// `PRAGMA integrity_check` remains `ok`), must fail closed through the
    /// real `assert_startup_integrity` entrypoint rather than being silently
    /// trusted. Fails on pre-remediation source; passes after the gate in
    /// `open_existing_manifest`.
    #[test]
    fn existing_manifest_user_version_2_fails_full_startup_integrity() {
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

        let manifest = durable_dir(&dir).join(MANIFEST_FILE_NAME);
        let conn = Connection::open(&manifest).unwrap();
        conn.pragma_update(None, "user_version", 2).unwrap();
        let integrity: String = conn
            .pragma_query_value(None, "integrity_check", |row| row.get(0))
            .unwrap();
        assert_eq!(integrity, "ok");
        drop(conn);

        let err = assert_startup_integrity(&dir).unwrap_err();
        assert!(err.contains("unsupported manifest user_version 2"), "{err}");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// SEC-001 Claude-042 / Gemini-062 existing-manifest version matrix: v1
    /// is the only accepted existing manifest SQLite `user_version`; v2, v99,
    /// and a nonvirgin v0 must all fail closed. Nonvirgin v0 is deliberately
    /// distinct from true virgin initialization (see
    /// `virgin_manifest_zero_to_one_initialization` below) — here the
    /// manifest schema/table already exists, so being left at 0 is not
    /// entitled to virgin treatment.
    #[test]
    fn existing_manifest_version_matrix() {
        for (version, should_pass) in [(1i32, true), (2, false), (99, false), (0, false)] {
            let dir = std::env::temp_dir().join(format!(
                "twinpet-kv-manifest-matrix-{version}-{}-{}",
                std::process::id(),
                random_session_id()
            ));
            let manifest = durable_dir(&dir).join(MANIFEST_FILE_NAME);
            std::fs::create_dir_all(manifest.parent().unwrap()).unwrap();
            let conn = Connection::open(&manifest).unwrap();
            create_manifest_schema(&conn).unwrap();
            conn.pragma_update(None, "user_version", version).unwrap();
            drop(conn);

            let result = open_existing_manifest(&manifest);
            assert_eq!(
                result.is_ok(),
                should_pass,
                "existing manifest user_version {version} expected pass={should_pass}, got {result:?}"
            );
            if !should_pass {
                let err = result.unwrap_err();
                assert!(
                    err.contains(&format!("unsupported manifest user_version {version}")),
                    "{err}"
                );
            }
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    /// SEC-001 Claude-042 / Gemini-062: a genuinely virgin manifest (the
    /// SQLite file does not exist yet) must still initialize 0 -> 1 and the
    /// resulting file must then be immediately acceptable as an existing
    /// manifest under the new version gate.
    #[test]
    fn virgin_manifest_zero_to_one_initialization() {
        let dir = std::env::temp_dir().join(format!(
            "twinpet-kv-manifest-virgin-init-{}-{}",
            std::process::id(),
            random_session_id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let conn = open_or_create_manifest_if_virgin(&dir).unwrap();
        let version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_MANIFEST_SQLITE_USER_VERSION);
        drop(conn);

        let manifest = durable_dir(&dir).join(MANIFEST_FILE_NAME);
        assert!(open_existing_manifest(&manifest).is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// SEC-001 Codex-002 blocking-finding regression (Claude-043): the
    /// `DurableKvEngine::begin` production path must not consume an existing
    /// manifest whose SQLite `user_version` is unsupported, even though its
    /// `epochs` state is perfectly readable and SQLite itself reports the file
    /// as structurally sound.
    ///
    /// Both pre-remediation failure shapes are pinned, because the direct
    /// `Connection::open` bypass had two distinct consequences:
    ///
    /// * Phase 1 — a readable `COMMITTED` row on a `user_version = 2` manifest
    ///   was taken at face value, so `begin` proceeded into committed-domain
    ///   handling and reported only `committed domain file is missing` — an
    ///   unsupported manifest was still being trusted to classify the epoch.
    /// * Phase 2 — an epoch with no row yielded `None`, which `begin` read as
    ///   "no committed epoch", letting `open_kv_connection` *create* a domain
    ///   file under a manifest the startup gate rejects.
    ///
    /// Both must now fail with the manifest version error itself. Non-vacuity
    /// is anchored by the phase-1 baseline: the identical sequence succeeds at
    /// `user_version = 1` immediately before the mutation.
    #[test]
    fn begin_fails_closed_on_existing_manifest_user_version_2() {
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

        // Baseline at the supported version: begin succeeds, so the failures
        // asserted below are attributable to the version mutation alone.
        let sid = begin_device(&engine, "readonly");
        engine.commit("main", &sid).unwrap();

        let manifest = durable_dir(&dir).join(MANIFEST_FILE_NAME);
        let conn = Connection::open(&manifest).unwrap();
        conn.pragma_update(None, "user_version", 2).unwrap();
        let integrity: String = conn
            .pragma_query_value(None, "integrity_check", |row| row.get(0))
            .unwrap();
        assert_eq!(integrity, "ok");
        let readable_status: String = conn
            .query_row(
                "SELECT status FROM epochs WHERE epoch_id = ?1",
                params![TEST_EPOCH],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(readable_status, "COMMITTED");
        drop(conn);

        // Phase 1: the readable COMMITTED row must no longer be consulted at
        // all; the manifest version error must surface instead of the
        // downstream committed-domain error.
        let device_path = domain_file_path(&dir, "twinpet-device", TEST_EPOCH).unwrap();
        std::fs::remove_file(&device_path).unwrap();
        let err = engine
            .begin(
                "main",
                "twinpet-device",
                vec!["kv".into()],
                "readwrite",
                TEST_EPOCH,
            )
            .unwrap_err();
        assert!(err.contains("unsupported manifest user_version 2"), "{err}");
        assert!(
            !device_path.is_file(),
            "begin must not fabricate a domain file for an unsupported manifest"
        );

        // Phase 2: an epoch absent from the same unsupported manifest must not
        // be classified as uncommitted, which previously permitted creation.
        let unknown_epoch = "epoch-1700000000001-0123456789abcdef0123456789abcdef";
        let unknown_path = domain_file_path(&dir, "twinpet-device", unknown_epoch).unwrap();
        assert!(!unknown_path.exists());
        let err = engine
            .begin(
                "main",
                "twinpet-device",
                vec!["kv".into()],
                "readwrite",
                unknown_epoch,
            )
            .unwrap_err();
        assert!(err.contains("unsupported manifest user_version 2"), "{err}");
        assert!(
            !unknown_path.exists(),
            "begin must not create a domain file under an unsupported manifest"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// SEC-001 Codex-002 remediation guard (Claude-043): absence of the manifest
    /// file stays the only condition that means "no manifest status". Tightening
    /// the status read must not turn a virgin root into a begin failure.
    #[test]
    fn absent_manifest_status_is_none_and_begin_proceeds() {
        let (engine, dir) = engine();
        let manifest = durable_dir(&dir).join(MANIFEST_FILE_NAME);
        assert!(!manifest.exists());
        assert_eq!(epoch_status_from_manifest(&dir, TEST_EPOCH).unwrap(), None);

        let sid = begin_device(&engine, "readwrite");
        engine.commit("main", &sid).unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    /// SEC-001 Codex-003 remediation regression (Claude-044): the manifest
    /// pathname exists but is a **directory**, not a regular file. Before the
    /// path-state fix, `!path.is_file()` was true here exactly as it is for a
    /// genuinely absent manifest, so `epoch_status_from_manifest` returned
    /// `Ok(None)`, `begin` classified the epoch as uncommitted and
    /// `open_kv_connection(.., create = true)` fabricated a domain SQLite file
    /// under a manifest path that had never been validated. This exercises the
    /// real `DurableKvEngine::begin` entry point (not the private status
    /// helper alone) and proves both halves: the error surfaces, and no domain
    /// file is created.
    ///
    /// Non-vacuity: the identical root/epoch/domain triple succeeds and does
    /// create the domain file in
    /// `absent_manifest_status_is_none_and_begin_proceeds`, so the directory at
    /// the manifest pathname is the only differing condition. With the
    /// path-state fix reverted to `!path.is_file()` this test fails at the
    /// `unwrap_err()` below, because `begin` succeeds instead.
    #[test]
    fn directory_at_manifest_path_fails_begin_before_domain_creation() {
        let (engine, dir) = engine();
        let manifest = durable_dir(&dir).join(MANIFEST_FILE_NAME);
        std::fs::create_dir_all(&manifest).unwrap();
        assert!(manifest.is_dir());
        assert!(
            !manifest.is_file(),
            "fixture must reproduce the is_file()-false-but-present state"
        );

        // Status helper: an existing non-file manifest pathname is an error,
        // never absence.
        let status_err = epoch_status_from_manifest(&dir, TEST_EPOCH).unwrap_err();
        assert!(
            status_err.contains("migration manifest path is not a regular file"),
            "{status_err}"
        );

        // Real begin path: the error must propagate before the
        // committed/uncommitted decision and before any domain-file creation.
        let device_path = domain_file_path(&dir, "twinpet-device", TEST_EPOCH).unwrap();
        assert!(!device_path.exists());
        let err = engine
            .begin(
                "main",
                "twinpet-device",
                vec!["kv".into()],
                "readwrite",
                TEST_EPOCH,
            )
            .unwrap_err();
        assert!(
            err.contains("migration manifest path is not a regular file"),
            "{err}"
        );
        assert!(
            !device_path.exists(),
            "begin must not create a domain file under an invalid manifest path"
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    /// SEC-001 Codex-003 remediation guard (Claude-044): tightening the
    /// path-state check must not convert "valid manifest, no row for the
    /// requested epoch" into a path error. That case is still `Ok(None)` and
    /// `begin` still proceeds, which is what keeps a fresh epoch startable
    /// against an already-initialized manifest.
    #[test]
    fn valid_manifest_without_epoch_row_is_none_and_begin_proceeds() {
        let (engine, dir) = engine();
        let manifest = durable_dir(&dir).join(MANIFEST_FILE_NAME);
        std::fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        let conn = Connection::open(&manifest).unwrap();
        create_manifest_schema(&conn).unwrap();
        drop(conn);
        assert!(manifest.is_file());

        assert_eq!(epoch_status_from_manifest(&dir, TEST_EPOCH).unwrap(), None);

        let sid = begin_device(&engine, "readwrite");
        engine.commit("main", &sid).unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    /// SEC-001 Codex-004 blocking-finding regression (Claude-045): the manifest
    /// pathname exists as a **symlink whose target is missing**. This is not
    /// pathname absence — the directory entry is there — but `std::fs::metadata`
    /// follows the link and reports the *target's* `ErrorKind::NotFound`, which
    /// the Claude-044 absence branch accepted as genuine nonexistence. `begin`
    /// therefore classified the epoch as uncommitted and
    /// `open_kv_connection(.., create = true)` fabricated a domain SQLite file
    /// under a manifest pathname that was never validated — the same
    /// false-uncommitted defect as the directory case, reached through a third
    /// route. This runs the real `DurableKvEngine::begin` entry point and pins
    /// both halves: the error surfaces, and no domain file is created.
    ///
    /// Non-vacuity: the fixture is asserted to be genuinely
    /// pathname-present/target-missing (including that `Path::exists()` reports
    /// `false`, the exact misleading signal), and the identical root/epoch/domain
    /// triple succeeds and *does* create the domain file in
    /// `absent_manifest_status_is_none_and_begin_proceeds`, so the dangling
    /// symlink is the only differing condition. With `manifest_path_state`
    /// reverted to a symlink-following `std::fs::metadata` check this test fails
    /// at the `unwrap_err()` below, because `begin` succeeds instead.
    #[test]
    fn dangling_manifest_symlink_fails_begin_before_domain_creation() {
        let (engine, dir) = engine();
        let manifest = durable_dir(&dir).join(MANIFEST_FILE_NAME);
        std::fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        // Target deliberately never created.
        let missing_target = durable_dir(&dir).join("twinpet-migration-manifest.absent");
        symlink_file_for_test(&missing_target, &manifest);
        assert_dangling_symlink(&manifest);
        assert!(!missing_target.exists());

        // Status helper: a present-but-dangling manifest pathname is an error,
        // never absence.
        let status_err = epoch_status_from_manifest(&dir, TEST_EPOCH).unwrap_err();
        assert!(
            status_err.contains("migration manifest symlink target is missing"),
            "{status_err}"
        );

        // Real begin path: the error must propagate through the existing `?`
        // seam before the committed/uncommitted classification, before any
        // `create = true` decision, and before any domain-file creation.
        let device_path = domain_file_path(&dir, "twinpet-device", TEST_EPOCH).unwrap();
        assert!(!device_path.exists());
        let err = engine
            .begin(
                "main",
                "twinpet-device",
                vec!["kv".into()],
                "readwrite",
                TEST_EPOCH,
            )
            .unwrap_err();
        assert!(
            err.contains("migration manifest symlink target is missing"),
            "{err}"
        );
        assert!(
            !device_path.exists(),
            "begin must not create a domain file under a dangling manifest symlink"
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    /// SEC-001 Codex-004 remediation guard (Claude-045): distinguishing the
    /// pathname from its target must not newly reject a manifest pathname that
    /// is a symlink **resolving to a valid regular manifest**. That accepted
    /// compatibility behaviour is unchanged: the link is followed, the resolved
    /// regular file goes through `open_existing_manifest`, normal status reads
    /// work, and `begin` proceeds.
    ///
    /// The second half proves the validation genuinely follows the link rather
    /// than stopping at the entry: mutating the *target's* manifest SQLite
    /// `user_version` to 2 must fail the read closed through the same gate that
    /// guards a direct regular file.
    #[test]
    fn valid_manifest_symlink_to_regular_file_is_followed_and_validated() {
        let (engine, dir) = engine();
        let durable = durable_dir(&dir);
        std::fs::create_dir_all(&durable).unwrap();
        // Real manifest lives outside the durable directory so only the symlink
        // occupies the manifest pathname.
        let target = dir.join("real-manifest-target.sqlite");
        let conn = Connection::open(&target).unwrap();
        create_manifest_schema(&conn).unwrap();
        drop(conn);
        assert!(target.is_file());

        let manifest = durable.join(MANIFEST_FILE_NAME);
        symlink_file_for_test(&target, &manifest);
        assert!(
            std::fs::symlink_metadata(&manifest)
                .unwrap()
                .file_type()
                .is_symlink(),
            "fixture must be a symlink at the manifest pathname"
        );
        assert!(
            manifest.is_file(),
            "fixture symlink must resolve to a regular file"
        );

        // Followed and validated: a valid manifest with no row for this epoch
        // is still `Ok(None)`, and `begin` still proceeds.
        assert!(open_existing_manifest(&manifest).is_ok());
        assert_eq!(epoch_status_from_manifest(&dir, TEST_EPOCH).unwrap(), None);
        let sid = begin_device(&engine, "readwrite");
        engine.commit("main", &sid).unwrap();

        // SEC-001 Codex-005 compatibility guard (Claude-046): routing the
        // create helper and `manifest_get` through the pathname classifier must
        // not newly reject — or re-create, or report as virgin — a symlink that
        // resolves to a valid regular manifest. The helper opens the resolved
        // file through `open_existing_manifest` and leaves the pathname as the
        // symlink it was; the write lands in the target; the read comes back
        // through the link as real content, not the empty/virgin payload.
        drop(open_or_create_manifest_if_virgin(&dir).unwrap());
        assert!(
            std::fs::symlink_metadata(&manifest)
                .unwrap()
                .file_type()
                .is_symlink(),
            "the manifest pathname must still be the symlink, not a re-created file"
        );
        engine
            .manifest_put_epoch(TEST_EPOCH, "COPYING", "{}", None, None)
            .unwrap();
        let snapshot = engine.manifest_get().unwrap();
        assert_eq!(
            snapshot["epochs"].as_array().unwrap().len(),
            1,
            "manifest_get must read through the valid symlink, not report a virgin view"
        );
        assert_eq!(
            epoch_status_from_manifest(&dir, TEST_EPOCH).unwrap(),
            Some("COPYING".to_string())
        );

        // Validation follows the link: mutating the target's version fails the
        // read closed exactly as for a direct regular file.
        let conn = Connection::open(&target).unwrap();
        conn.pragma_update(None, "user_version", 2).unwrap();
        drop(conn);
        let err = epoch_status_from_manifest(&dir, TEST_EPOCH).unwrap_err();
        assert!(err.contains("unsupported manifest user_version 2"), "{err}");

        let _ = std::fs::remove_dir_all(dir);
    }

    /// SEC-001 Codex-004 remediation (Claude-045): a manifest pathname that is
    /// a symlink resolving to a **non-regular** target (here a directory) is
    /// present, not absent, and is not usable as a manifest. It must fail
    /// closed like the direct-directory case rather than yielding `Ok(None)`.
    #[test]
    fn manifest_symlink_to_directory_target_fails_closed() {
        let (engine, dir) = engine();
        let durable = durable_dir(&dir);
        std::fs::create_dir_all(&durable).unwrap();
        let target_dir = dir.join("manifest-target-dir");
        std::fs::create_dir_all(&target_dir).unwrap();

        let manifest = durable.join(MANIFEST_FILE_NAME);
        symlink_dir_for_test(&target_dir, &manifest);
        assert!(
            std::fs::symlink_metadata(&manifest)
                .unwrap()
                .file_type()
                .is_symlink(),
            "fixture must be a symlink at the manifest pathname"
        );
        assert!(manifest.is_dir(), "fixture target must resolve to a dir");
        assert!(!manifest.is_file());

        let status_err = epoch_status_from_manifest(&dir, TEST_EPOCH).unwrap_err();
        assert!(
            status_err.contains("migration manifest path is not a regular file"),
            "{status_err}"
        );

        let device_path = domain_file_path(&dir, "twinpet-device", TEST_EPOCH).unwrap();
        assert!(!device_path.exists());
        let err = engine
            .begin(
                "main",
                "twinpet-device",
                vec!["kv".into()],
                "readwrite",
                TEST_EPOCH,
            )
            .unwrap_err();
        assert!(
            err.contains("migration manifest path is not a regular file"),
            "{err}"
        );
        assert!(
            !device_path.exists(),
            "begin must not create a domain file under a nonregular manifest target"
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    /// SEC-001 Codex-004 Part-E regression (Claude-045): the same
    /// pathname-versus-target confusion existed on the startup side.
    /// `assert_startup_integrity` tested `manifest_path.exists()`, which follows
    /// symlinks, so with a compatible floor and no legacy domain files a
    /// dangling manifest symlink fell through *both* branches — neither
    /// "manifest exists, validate it" nor "domain files exist without a
    /// manifest" — and startup was **permitted** under a manifest pathname that
    /// exists and is unusable. It must now fail closed.
    ///
    /// Non-vacuity is anchored inline: the identical floor-only root is asserted
    /// to pass `assert_startup_integrity` immediately before the symlink is
    /// created, so the dangling symlink is the only differing condition. With
    /// the startup check reverted to `manifest_path.exists()` this test fails at
    /// the `unwrap_err()` below, because startup returns `Ok(())` instead.
    #[test]
    fn dangling_manifest_symlink_fails_startup_integrity() {
        let dir = std::env::temp_dir().join(format!(
            "twinpet-kv-startup-dangling-symlink-{}-{}",
            std::process::id(),
            random_session_id()
        ));
        let durable = durable_dir(&dir);
        std::fs::create_dir_all(&durable).unwrap();
        std::fs::write(
            epoch_floor::floor_path(&dir),
            "committedEpochFloor=1\nwriterBuildId=legacy-build\n",
        )
        .unwrap();
        assert_eq!(
            epoch_floor::evaluate_floor(&dir),
            epoch_floor::FloorDecision::PermitCompatible { floor: 1 }
        );
        assert!(
            !epoch_floor::durable_domain_files_exist(&dir),
            "fixture must have no legacy domain files"
        );
        // Baseline: floor-compatible, no domain files, no manifest pathname at
        // all is legitimately permitted.
        assert_eq!(assert_startup_integrity(&dir), Ok(()));

        let manifest = durable.join(MANIFEST_FILE_NAME);
        let missing_target = durable.join("twinpet-migration-manifest.absent");
        symlink_file_for_test(&missing_target, &manifest);
        assert_dangling_symlink(&manifest);
        assert!(
            !epoch_floor::durable_domain_files_exist(&dir),
            "dangling symlink must not be counted as a domain file either"
        );

        let err = assert_startup_integrity(&dir).unwrap_err();
        assert!(
            err.contains("migration manifest symlink target is missing"),
            "{err}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// SEC-001 Codex-005 finding-1 regression (Claude-046): the Claude-045
    /// pathname validation lived only on the `PermitCompatible` arm of
    /// `assert_startup_integrity`, while the `PermitVirgin` arm returned
    /// `Ok(())` before any manifest pathname was inspected. With **no floor**,
    /// no domain files, and a dangling manifest symlink,
    /// `epoch_floor::durable_domain_files_exist` (symlink-following, and
    /// outside this packet's one-file allowlist) reports `false`, so
    /// `evaluate_floor` legitimately answers `PermitVirgin` — and startup was
    /// therefore *permitted* under a present, unusable manifest pathname, with
    /// `lib.rs` free to continue to the floor write and WebView start.
    ///
    /// Non-vacuity is anchored inline three ways: the identical root is proved
    /// to pass `assert_startup_integrity` in the true-virgin baseline
    /// immediately before the symlink is created, so the dangling symlink is
    /// the only differing condition; `evaluate_floor` is asserted to still
    /// return `PermitVirgin` *after* the symlink exists, so the test really
    /// exercises the virgin arm rather than silently falling into the
    /// already-fixed compatible arm; and the fixture is asserted to be
    /// genuinely pathname-present/target-missing. With the virgin-arm
    /// classification removed this test fails at the `unwrap_err()` below,
    /// because startup returns `Ok(())` instead.
    #[test]
    fn no_floor_dangling_manifest_symlink_fails_startup_integrity() {
        let dir = std::env::temp_dir().join(format!(
            "twinpet-kv-startup-nofloor-dangling-{}-{}",
            std::process::id(),
            random_session_id()
        ));
        let durable = durable_dir(&dir);
        std::fs::create_dir_all(&durable).unwrap();
        let floor = epoch_floor::floor_path(&dir);
        let manifest = durable.join(MANIFEST_FILE_NAME);
        let missing_target = durable.join("twinpet-migration-manifest.absent");

        // True-virgin baseline: no floor, no domain files, and no directory
        // entry at all at the manifest pathname. This must stay permitted.
        assert!(!floor.exists(), "fixture must have no floor marker");
        assert!(
            !epoch_floor::durable_domain_files_exist(&dir),
            "fixture must have no legacy domain files"
        );
        assert!(
            std::fs::symlink_metadata(&manifest).is_err(),
            "fixture must start with no manifest directory entry"
        );
        assert_eq!(
            epoch_floor::evaluate_floor(&dir),
            epoch_floor::FloorDecision::PermitVirgin
        );
        assert_eq!(assert_startup_integrity(&dir), Ok(()));

        // Only differing condition: a dangling symlink at the manifest pathname.
        symlink_file_for_test(&missing_target, &manifest);
        assert_dangling_symlink(&manifest);
        assert!(!missing_target.exists());
        // The bypass precondition itself: floor evaluation still says virgin.
        assert!(
            !epoch_floor::durable_domain_files_exist(&dir),
            "a dangling manifest symlink must not be counted as a domain file"
        );
        assert_eq!(
            epoch_floor::evaluate_floor(&dir),
            epoch_floor::FloorDecision::PermitVirgin,
            "this regression must exercise the PermitVirgin arm"
        );

        let err = assert_startup_integrity(&dir).unwrap_err();
        assert!(
            err.contains("migration manifest symlink target is missing"),
            "{err}"
        );

        // The startup check itself must create nothing and mutate nothing.
        assert!(!floor.exists(), "startup integrity must not write a floor");
        assert!(
            !missing_target.exists(),
            "startup integrity must not materialize the symlink target"
        );
        assert_dangling_symlink(&manifest);
        assert!(!epoch_floor::durable_domain_files_exist(&dir));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// SEC-001 Codex-005 finding-2 create-path regression (Claude-046):
    /// `open_or_create_manifest_if_virgin` decided presence with
    /// `path.exists()`, which follows symlinks. On a dangling manifest symlink
    /// that reported `false`, `prior_phase_b_state_exists` agreed (its manifest
    /// limb used the same following `.exists()`), and `Connection::open(&path)`
    /// then followed the link and **created the missing target** — here
    /// deliberately outside the durable directory — initializing it as an
    /// authoritative manifest at `user_version` 1. Both public writers that
    /// reach the helper are exercised: the epoch writer and the lease writer.
    ///
    /// Non-vacuity: the fixture is asserted genuinely
    /// pathname-present/target-missing, and the control block proves the very
    /// same `manifest_put_epoch` call on a root whose manifest pathname is
    /// truly absent still creates the manifest and succeeds — so the dangling
    /// symlink is the only differing condition. With the classifier removed
    /// from the helper this test fails at the first `unwrap_err()`, because the
    /// write succeeds and materializes `missing_target`.
    #[test]
    fn dangling_manifest_symlink_fails_create_path_without_materializing_target() {
        // Built first: the local `engine` binding below shadows the fixture
        // helper of the same name.
        let (control_engine, control_dir) = engine();
        let (engine, dir) = engine();
        let durable = durable_dir(&dir);
        std::fs::create_dir_all(&durable).unwrap();
        let manifest = durable.join(MANIFEST_FILE_NAME);
        // Target outside the durable directory: creating it through the link is
        // exactly the escape Codex-005 described.
        let missing_target = dir.join("outside-durable-manifest.sqlite");
        symlink_file_for_test(&missing_target, &manifest);
        assert_dangling_symlink(&manifest);
        assert!(!missing_target.exists());

        // Public epoch writer.
        let err = engine
            .manifest_put_epoch(TEST_EPOCH, "COPYING", "{}", None, None)
            .unwrap_err();
        assert!(
            err.contains("migration manifest symlink target is missing"),
            "{err}"
        );
        assert!(
            !missing_target.exists(),
            "the manifest write must not materialize the dangling symlink target"
        );

        // Public lease writer, same helper, same fail-closed requirement.
        let lease_err = engine.lease_acquire("owner-046", 60_000).unwrap_err();
        assert!(
            lease_err.contains("migration manifest symlink target is missing"),
            "{lease_err}"
        );
        assert!(
            !missing_target.exists(),
            "the lease write must not materialize the dangling symlink target"
        );

        // Nothing authoritative was materialized anywhere on the pathname.
        assert_dangling_symlink(&manifest);
        assert!(
            !epoch_floor::floor_path(&dir).exists(),
            "no floor may be written by a rejected manifest write"
        );

        // Non-vacuity control: the identical call on a genuinely absent
        // manifest pathname still creates the manifest and succeeds.
        control_engine
            .manifest_put_epoch(TEST_EPOCH, "COPYING", "{}", None, None)
            .unwrap();
        assert!(
            durable_dir(&control_dir).join(MANIFEST_FILE_NAME).is_file(),
            "control must prove the create path is otherwise reachable"
        );
        let _ = std::fs::remove_dir_all(control_dir);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// SEC-001 Codex-005 finding-2 read regression (Claude-046): `manifest_get`
    /// tested `!path.exists()`, which follows symlinks, so a dangling manifest
    /// symlink took the absence branch and returned the empty/virgin payload —
    /// `activeCommitted: null`, no epochs, no lease — for a manifest pathname
    /// that exists and is unusable. It must fail closed instead.
    ///
    /// Non-vacuity: the control block proves genuine pathname absence still
    /// returns the empty view, so the dangling symlink is the only differing
    /// condition. With the classifier removed this test fails at the
    /// `unwrap_err()`, because `manifest_get` returns the empty payload.
    #[test]
    fn dangling_manifest_symlink_fails_manifest_get_without_empty_view() {
        // Built first: the local `engine` binding below shadows the fixture
        // helper of the same name.
        let (control_engine, control_dir) = engine();
        let (engine, dir) = engine();
        let durable = durable_dir(&dir);
        std::fs::create_dir_all(&durable).unwrap();
        let manifest = durable.join(MANIFEST_FILE_NAME);
        let missing_target = durable.join("twinpet-migration-manifest.absent");
        symlink_file_for_test(&missing_target, &manifest);
        assert_dangling_symlink(&manifest);

        let err = engine.manifest_get().unwrap_err();
        assert!(
            err.contains("migration manifest symlink target is missing"),
            "{err}"
        );
        assert!(
            !missing_target.exists(),
            "manifest_get must not materialize the dangling symlink target"
        );
        assert_dangling_symlink(&manifest);

        // Non-vacuity control: genuine pathname absence keeps the empty view.
        let snapshot = control_engine.manifest_get().unwrap();
        assert!(snapshot["activeCommitted"].is_null());
        assert!(snapshot["epochs"].as_array().unwrap().is_empty());
        assert!(snapshot["lease"].is_null());
        assert!(
            std::fs::symlink_metadata(durable_dir(&control_dir).join(MANIFEST_FILE_NAME)).is_err(),
            "the empty view must not have created a manifest"
        );
        let _ = std::fs::remove_dir_all(control_dir);
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
          "schemaVersion": CURRENT_MIGRATION_INVENTORY_SCHEMA_VERSION,
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

    /// SEC-001 epoch-2 regression: the existing 8-domain Phase-B COMMITTED
    /// path must remain unaffected by the `MAX_KNOWN_EPOCH_SCHEMA` bump from
    /// 1 to 2 — `manifest_put_epoch`'s existing floor commit now durably
    /// writes floor 2, and startup integrity must still validate cleanly.
    #[test]
    fn epoch2_bump_does_not_break_existing_committed_domain_path() {
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
        assert_eq!(
            epoch_floor::evaluate_floor(&dir),
            epoch_floor::FloorDecision::PermitCompatible {
                floor: epoch_floor::MAX_KNOWN_EPOCH_SCHEMA
            }
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// SEC-001 Claude-040 / Gemini-059 historical literal schema-1 regression.
    /// Before this remediation, `validate_committed_inventory` compared
    /// `schemaVersion` against `MAX_KNOWN_EPOCH_SCHEMA` (2), so this literal
    /// `1` fixture would have been rejected with "committed schemaVersion 1
    /// is unsupported" — exactly the AGY-001 UAT fatal. After decoupling to
    /// `CURRENT_MIGRATION_INVENTORY_SCHEMA_VERSION` (1), it must be accepted.
    #[test]
    fn historical_literal_schema1_inventory_is_accepted_by_validator() {
        let (_engine, dir) = engine();
        seed_domain_files(&dir, TEST_EPOCH);
        let inventory = historical_literal_schema1_inventory(&["empty-branch"]);
        assert_eq!(
            validate_committed_inventory(&dir, TEST_EPOCH, &inventory),
            Ok(())
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// SEC-001 Claude-040 / Gemini-059 full real-state compatibility
    /// regression, modeling the AGY-001 finding as closely as this module's
    /// test architecture allows: a `committedEpochFloor=1` marker (written
    /// literally, not via `write_floor_atomic`, which always stamps the
    /// current global max) alongside a COMMITTED manifest row carrying the
    /// historical literal `inventory_json.schemaVersion=1`, exact 8-domain
    /// inventory, valid SHA-256 digests, and a valid p13 block, while the
    /// current global epoch max is 2. This exercises the full
    /// `assert_startup_integrity` startup-integrity boundary, not just a
    /// trivial schema helper call.
    #[test]
    fn historical_schema1_committed_state_passes_full_startup_integrity() {
        let (engine, dir) = engine();
        engine
            .manifest_put_epoch(TEST_EPOCH, "COPYING", "{}", None, None)
            .unwrap();
        seed_domain_files(&dir, TEST_EPOCH);
        engine
            .manifest_put_epoch(
                TEST_EPOCH,
                "COMMITTED",
                &historical_literal_schema1_inventory(&["empty-branch"]),
                None,
                None,
            )
            .unwrap();
        std::fs::write(
            epoch_floor::floor_path(&dir),
            "committedEpochFloor=1\nwriterBuildId=legacy-build\n",
        )
        .unwrap();
        assert_eq!(
            epoch_floor::evaluate_floor(&dir),
            epoch_floor::FloorDecision::PermitCompatible { floor: 1 }
        );
        assert_eq!(assert_startup_integrity(&dir), Ok(()));
        let snapshot = engine.manifest_get().unwrap();
        assert_eq!(
            snapshot["activeCommitted"]["epochId"],
            Value::String(TEST_EPOCH.into())
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// SEC-001 Claude-040 / Gemini-059: Option A keeps the supported
    /// migration-inventory schema set at `{1}`. An unknown-newer inventory
    /// schema (e.g. `2`, which happens to equal the unrelated global
    /// `MAX_KNOWN_EPOCH_SCHEMA`) must still fail closed with no compatibility
    /// fallback.
    #[test]
    fn unknown_newer_inventory_schema_fails_closed() {
        let (_engine, dir) = engine();
        seed_domain_files(&dir, TEST_EPOCH);
        let newer = inventory_with_schema(2, &["empty-branch"]);
        let err = validate_committed_inventory(&dir, TEST_EPOCH, &newer).unwrap_err();
        assert!(err.contains("schemaVersion 2 is unsupported"), "{err}");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Regression for the exact validator lines this remediation touched:
    /// a committed inventory with no `schemaVersion` key must still fail
    /// closed after decoupling from `MAX_KNOWN_EPOCH_SCHEMA`.
    #[test]
    fn missing_inventory_schema_fails_closed() {
        let (_engine, dir) = engine();
        seed_domain_files(&dir, TEST_EPOCH);
        let missing = serde_json::json!({
          "domains": [],
          "p13": {}
        })
        .to_string();
        let err = validate_committed_inventory(&dir, TEST_EPOCH, &missing).unwrap_err();
        assert!(err.contains("missing schemaVersion"), "{err}");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Regression for the exact validator lines this remediation touched:
    /// a non-numeric `schemaVersion` must still fail closed after decoupling
    /// from `MAX_KNOWN_EPOCH_SCHEMA`.
    #[test]
    fn malformed_inventory_schema_fails_closed() {
        let (_engine, dir) = engine();
        seed_domain_files(&dir, TEST_EPOCH);
        let malformed = serde_json::json!({
          "schemaVersion": "1",
          "domains": [],
          "p13": {}
        })
        .to_string();
        let err = validate_committed_inventory(&dir, TEST_EPOCH, &malformed).unwrap_err();
        assert!(err.contains("missing schemaVersion"), "{err}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
