# MP1 Candidate N-002 — One-Pass Guarded Low-Disk Build/Run Authorization

**Owner authorization:** 2026-11-22 (Asia/Bangkok)  
**Status:** `OWNER_APPROVED_ONE_SHOT_BUILD_RUN / WINDOWS_EXECUTOR_NOT_RUN_IN_CHAT / RESULT_PENDING`  
**Purpose:** evidence-gathering Build and synthetic Run on **existing** N-002 candidate, not design remediation, source merge, release, or M1 acceptance.

## Exact authorization

Product Owner expressly approved one immediate guarded experiment with an **exception to the >=10 GiB preflight ONLY for this one run**, without weakening the permanent gate. Target **already-existing** detached local Windows clone:

`C:\Users\Narachat\TPOS-MP1-CAND-N-ISO-20261121` at `f034301c46dd9e08190f869cc85dbb140ac28a3c`.

The last independent Codex report observed exactly **two uncommitted candidate Source modifications** in `src-tauri/src/epoch_floor.rs` and `src-tauri/src/durable_kv.rs`. Original `C:\Users\Narachat\twinpet-pos` main at pinned commit is READ-ONLY. The last observation is historical and must be checked on Windows before execution. **Do not reset/replace/edit the candidate.** The separate consolidated Startup Integrity design spec is still `DESIGN_SPEC_READY`; F-01 dangling app-data ancestor, F-02 manifest TOCTOU, preexisting floor/privileged scanner errors are still OPEN; this Build/Run is experimental and only synthetic.

### Mandatory guard conditions

1. Measure actual C: free **before, during, after** (bytes). Initial <=2.25 GiB -> stop before launch; monitor each spawned build/test process hierarchy at least every 500 ms. If C: free <=2 GiB **terminate that job's child tree immediately**; proactively stop near 2.25 GiB for safety margin. STOP on other risk. Never kill unrelated processes; if watcher cannot reliably manage descendants -> BLOCK before Build.
2. **ONE** offline frozen native Rust build only (guarded `cargo build --frozen --bin app --jobs 1` from `src-tauri`, local target artifacts inside clone, `CARGO_INCREMENTAL=0` / dev debug=0 / jobs=1 to conserve disk). No fallback to `npm run build` (prebuild scripts generate config/provenance), no package install/fetch, new clone/workspace, retries or alternate modes. If build fails STOP and report with exit code, stderr, space and retained artifacts. `Cargo.lock` must remain unchanged.
3. If Build succeeds and all isolation/preflight checks continue to hold, run **at most one** targeted synthetic Rust test invocation with disposable `APPDATA`, `LOCALAPPDATA`, `TEMP` and `TMP` under existing clone, offline and monitored. The proposed filter `checked_domain_probe` selects existing three synthetic tests (source must be rechecked before running). No full UAT/other suites. Native GUI Run is permitted **only if** positively verified cloud/network isolation and fully disposable WebView2/profile, with no existing Twinpet POS instance sharing single-instance mutex; otherwise **skip GUI** and report it, never contact Firebase or actual POS credentials/data.
4. **NO** C: cleanup, deletion/movement of files, edits to UAT023, production/business data, real AppData, source, original main, Cloud/Firebase/ZORT, Gate-OFF or installed system settings; no firewall/adaptor changes; no commit/merge/push/deploy. Preserve generated build/test logs and artifacts for evidence. Report once.
5. Report statuses: Build exit; synthetic test and GUI outcome separately; free bytes before/min/after; stop reason and PID-tree termination; generated artifacts; post-run exact original + clone Git state; unresolved findings; `M1 NOT_PASS`. One Markdown report to `C:\Users\Narachat\OneDrive\Ai-Report\twinpet-pos\Codex\TPOS-MP1-CAND-N-002-GUARDED-LOWDISK-BUILD-RUN-REPORT.md` (append timestamp if exists).

**Prepared one-shot CLI prompt:** `TPOS-MP1-CAND-N-002-GUARDED-LOWDISK-BUILD-RUN-CODEX-PROMPT.md` (created in the conversation as a downloadable artifact; do not search Windows for an external prompt file). It is self-contained and for manual user dispatch. **No Windows runtime execution occurred in this ChatGPT conversation** because the connected tools lack direct access to that Windows host. An authorization is not a Build PASS.

**Owner's next one action:** paste the full one-shot prompt directly into Codex CLI on the Windows host, then provide its report. Do not request separate approvals for the authorized steps. No automatic retry if failed; one report and STOP.
