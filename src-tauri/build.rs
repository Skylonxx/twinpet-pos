use std::path::{Path, PathBuf};

fn command_output(program: &str, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new(program)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn is_full_git_sha(sha: &str) -> bool {
    sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `[A-Za-z0-9][A-Za-z0-9._:-]{7,127}` — total length 8 to 128.
fn is_valid_build_id_grammar(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.len() < 8 || bytes.len() > 128 {
        return false;
    }
    if !bytes[0].is_ascii_alphanumeric() {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

/// `CARGO_MANIFEST_DIR` is `<repo>/src-tauri`; the repo root (and `.git`) is
/// one level up.
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from(".."))
}

/// Any *tracked* (staged or unstaged) change against HEAD. Untracked files —
/// including the four unrelated `ops/lib` build transients this repo may
/// carry — are deliberately excluded via `--untracked-files=no`. If `git`
/// itself is unavailable or the query fails, this fails closed (treated as
/// dirty) rather than assuming a clean tree.
fn tracked_source_is_dirty() -> bool {
    let root = repo_root();
    match std::process::Command::new("git")
        .args(["status", "--porcelain", "--untracked-files=no"])
        .current_dir(&root)
        .output()
    {
        Ok(out) if out.status.success() => !out.stdout.is_empty(),
        _ => true,
    }
}

/// Emits `cargo:rerun-if-changed` for `.git/HEAD` and, when HEAD is a
/// symbolic ref (the ordinary non-detached case), the resolved ref file too,
/// so embedded provenance is invalidated by a checkout/commit/branch switch.
/// A detached HEAD (a bare 40-hex SHA, no `ref:` prefix) has no ref file to
/// watch — `.git/HEAD` alone already covers that case.
fn emit_git_rerun_directives() {
    let git_dir = repo_root().join(".git");
    let head_path = git_dir.join("HEAD");
    println!("cargo:rerun-if-changed={}", head_path.display());
    if let Ok(head_contents) = std::fs::read_to_string(&head_path) {
        if let Some(ref_name) = head_contents.trim().strip_prefix("ref: ") {
            println!(
                "cargo:rerun-if-changed={}",
                git_dir.join(ref_name).display()
            );
        }
    }
}

/// SEC-001 build provenance: embeds the git SHA and a build ID so a
/// distributable build can be traced back to exact source.
///
/// Gemini-041 authority `TWINPET-TRUE-STANDALONE-SEC-001-NATIVE-ROLLBACK-REMEDIATION-FINDINGS-ADJUDICATION-GEMINI-041`
/// froze `RELEASE_BUILD_ID_POLICY: EXPLICIT_EXTERNAL_BUILD_ID_REQUIRED`: a
/// `release`-profile build fails unless a full 40-hex-character git SHA
/// resolves, `TWINPET_BUILD_ID_OVERRIDE` is present/non-blank/not-"unknown"
/// and matches the grammar `[A-Za-z0-9][A-Za-z0-9._:-]{7,127}`, and the
/// tracked source tree is clean relative to HEAD. Debug/non-distribution
/// builds keep the prior best-effort fallback chain (override, else commit
/// timestamp, else "unknown") — this build script only ever runs before
/// compilation, so this profile-conditional gate is the enforcement point;
/// there is no separate installer/package step that could bypass it.
fn emit_build_provenance() {
    emit_git_rerun_directives();
    println!("cargo:rerun-if-env-changed=TWINPET_BUILD_ID_OVERRIDE");

    let git_sha = command_output("git", &["rev-parse", "HEAD"]);
    let override_build_id = std::env::var("TWINPET_BUILD_ID_OVERRIDE")
        .ok()
        .filter(|v| !v.trim().is_empty());

    let is_release = std::env::var("PROFILE").as_deref() == Ok("release");

    if is_release {
        let sha = match git_sha.as_deref() {
            Some(s) if is_full_git_sha(s) => s.to_string(),
            _ => panic!(
                "TWINPET release build provenance (RELEASE_UNKNOWN_GIT_SHA): a resolvable full \
                 40-hex-character git SHA is required for a release build"
            ),
        };
        let build_id = match override_build_id.as_deref() {
            Some(v) if v != "unknown" && is_valid_build_id_grammar(v) => v.to_string(),
            Some(_) => panic!(
                "TWINPET release build provenance (RELEASE_INVALID_BUILD_ID): \
                 TWINPET_BUILD_ID_OVERRIDE must match [A-Za-z0-9][A-Za-z0-9._:-]{{7,127}} and must \
                 not be 'unknown'"
            ),
            None => panic!(
                "TWINPET release build provenance (RELEASE_UNKNOWN_BUILD_ID): \
                 TWINPET_BUILD_ID_OVERRIDE is required for a release build"
            ),
        };
        if tracked_source_is_dirty() {
            panic!(
                "TWINPET release build provenance (RELEASE_TRACKED_DIRTY_SOURCE): tracked source \
                 tree is not clean relative to HEAD"
            );
        }
        println!("cargo:rustc-env=TWINPET_GIT_SHA={sha}");
        println!("cargo:rustc-env=TWINPET_BUILD_ID={build_id}");
        return;
    }

    let git_sha = git_sha.unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=TWINPET_GIT_SHA={git_sha}");
    let build_id = override_build_id
        .or_else(|| command_output("git", &["show", "-s", "--format=%cI", "HEAD"]))
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=TWINPET_BUILD_ID={build_id}");
}

fn main() {
    emit_build_provenance();
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
