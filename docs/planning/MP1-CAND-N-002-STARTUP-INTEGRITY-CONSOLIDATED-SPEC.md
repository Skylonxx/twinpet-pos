# Twinpet POS — MP1 Candidate N-002: Consolidated Startup Integrity Specification

**Prepared:** 2026-11-22 (Asia/Bangkok)  
**Status:** `DESIGN_SPEC_READY / OWNER_APPROVED_DESIGN_ONLY / IMPLEMENTATION_NOT_AUTHORIZED`  
**Purpose:** one bounded startup-integrity design and acceptance contract; NOT a new implementation packet, review loop, test approval or release gate waiver.  
**Source baseline:** GitHub `main@f034301c46dd9e08190f869cc85dbb140ac28a3c` (read-only); **candidate is NOT in main**.  
**Preserved candidate:** `C:\Users\Narachat\TPOS-MP1-CAND-N-ISO-20261121` (existing detached clone). Latest Codex review reported only two unstaged modifications in `src-tauri/src/epoch_floor.rs` (+114/−22) and `src-tauri/src/durable_kv.rs` (+21/−12), `git diff --check` PASS. This is a *last reported snapshot*, not a current file-state claim.

## 1. Evidence grades and findings

### Source-confirmed / independent reports
- Independent Codex report `TPOS-MP1-CAND-N-002-FAILCLOSED-ENUMERATION-INDEPENDENT-CODEX-REPORT.md`, 2026-11-22 07:27 +07: `STATIC_REVIEW_FINDINGS` (not a runtime failure). The fallible domain scanner propagates ordinary `read_dir`, metadata and per-entry errors and all callers of its changed signature were source-inspected. Eight domain prefixes retained.
- **F-01 false absence via ancestor:** candidate `epoch_floor.rs:256–266`: `symlink_metadata(app_data/durable)` may return `NotFound` when `app_data` is a dangling symlink; following `metadata(app_data)` also returns `NotFound`, incorrectly admitting `Ok(false)` despite the existing broken ancestor entry. Windows realization NOT_RUN.
- **F-02 startup TOCTOU:** candidate `epoch_floor.rs:278–297` and `durable_kv.rs:667–704` use independent path probes. On `PermitVirgin`, `assert_startup_integrity` classifies a manifest path but ignores `RegularFile`, potentially permitting an authoritative, possibly invalid manifest appearing between reads without validation. On the compatible arm, manifest replacement/disappearance interleavings also remain possible. Existing `open_or_create_manifest_if_virgin` check-then-`Connection::open` creates another window (baseline `durable_kv.rs:362–379`). These are *source-level scenarios*, not reproduced races.
- **L-01 floor check suppresses error:** baseline `epoch_floor.rs:299–320` uses `!path.exists()` after failed `read_to_string`, potentially interpreting unreadability as absence. Candidate retains this behavior.
- **L-02 privileged-auth scan suppresses error:** baseline `epoch_floor.rs:135–216` has `Err(_) => false`, `flatten()` and `continue` on entry/type failures, so data-bearing security state might be missed. Empty/unrecognized OAC directories are deliberately not recognized as data; this rule must remain.
- **Existing partial concurrency control:** pinned `src-tauri/src/lib.rs:9–23` calls `single_instance::acquire_or_exit` before `epoch_floor::check_or_exit`, `assert_startup_integrity`, `write_floor_atomic` and engine creation. `src-tauri/src/single_instance.rs` uses a process-lifetime Windows named mutex `Local\\com.twinpet.pos.single-instance`. This restricts participating instances **within the mutex namespace/session**; it does not prove exclusive access by other user sessions, background helpers or noncooperating processes. It is not a directory/file-snapshot lock.
- Previous Owner-approved Policy A / RISK-008: floor present + manifest and recognized Phase-B domains *truly absent* may be treated as virgin for Phase-B initialization, even though complete past Phase-B data loss could have produced the same state. **No acceptance** of physically present but unreadable data, invalid/present manifest, missing individual committed domains, duplicates/lost bills, or release.
- A-N1…A-N8, new error/race scenarios, compile and runtime = **NOT_RUN / NOT_VERIFIED**. No M1 PASS.

### Inferences / not established
- Whether Windows ACL, reparse types or path replacement reproduces F-01/F-02; whether there are additional legitimate writers outside the named mutex; whether the candidate compiles. Do not recast these as tested facts.
- Original `main` is not the candidate source: implementation planning must compare against the **actual existing clone diff**, not silently replace it with pinned main.

## 2. Threat model — ONE bounded choice

**In scope:**
1. Legitimate first installation, privileged-auth-only prior state, valid restart, migration and controlled crash/restart.
2. Multiple ordinary Twinpet POS launches that share the **same named-mutex namespace** and app-data path, and multiple in-process writer/reader operations governed by documented application coordination. Confirm actual startup/writer order; do not assume a per-process lock also guards every file operation.
3. Nonmalicious Windows filesystem failures and ordinary OS interruption: `NotFound` on a leaf or ancestor, `PermissionDenied`, sharing violation, unusable/dangling symlink/junction/reparse target, incomplete enumeration, changed file between observations and failed/partial manifest init.
4. Normal application-controlled manifest creation/replacement relative to startup and phase transitions. Startup must not permit an observed existing authoritative manifest without validation.
5. Preservation of all existing Offline First, manifest/inventory/epoch, Gate-OFF and Policy A/RISK-008 boundaries.

**Out of scope / explicit non-guarantees:** hostile administrator or arbitrary external process actively substituting files between every check; cross-Windows-session instances sharing an app-data root unless architecture confirms they participate in an effective **common** coordination mechanism; network filesystems or unsupported reparse provider semantics. These are **not** safe to silently declare supported: if a normal deployment uses them, report `BLOCKED_DESIGN_CONCURRENCY` rather than an unqualified PASS. No security claim that repeat `exists()` calls eliminate all TOCTOU; stronger consistency may require an owned lock/handle and separate Owner-approved scope.

**Required writer inventory before future implementation:** show how `lib.rs` startup, named mutex, floor writer, manifest writer/lease, Phase-B migrator and any ordinary same-root helper share or do not share exclusive ownership. This is a **bounded design check**, not permission for a new project-wide audit or code changes.

## 3. Normative startup / state-machine contract

**S1 — True absence vs unknown:** Define `Absent` only after checking the *directory entry* of the relevant leaf and necessary ancestor(s) without turning a following-metadata `NotFound` for a dangling ancestor into absence. `symlink_metadata` / equivalent entry-presence checks, followed by target usability checks where applicable, must preserve errors. A genuine missing app-data/durable root with inspectable parent remains legitimate first install; broken/inaccessible ancestor or non-directory path -> `Err` / `FailClosed`. Honor supported valid links to usable targets without downgrading manifest-path validation. Reject paths with uncertain reparse behavior rather than treating them as empty.

**S2 — Floor:** A readable valid compatible floor -> existing `PermitCompatible`; too-new/corrupt/unreadable floor -> `FailClosed`. For a truly missing floor, treat recognizably present durable or privileged-auth data as non-virgin; if any required inventory is not inspectable -> `FailClosed`. Never infer absence from `Path::exists()==false` after a read error without confirming entry absence. Preserve explicitly modeled empty OAC directory/unrecognized file behavior; no wider auth rewrite or epoch schema alteration.

**S3 — Domain:** `Result<bool,String>` domain probe must return `Ok(false)` ONLY after positive absence/complete successful enumeration; `read_dir`, metadata, access, entry errors -> `Err`; eight recognized domain prefixes and manifest-classifier distinction preserved. This is partly implemented in the existing candidate, but F-01 violates the full ancestor contract.

**S4 — Manifest authority:** At the startup integrity decision point, `manifest_path_state` returns: `Absent` -> continue only if Floor/Domain/PrivAuth contract independently permits it; `RegularFile` -> validate authoritative manifest (SQLite schema/version/committed epoch/inventory) as required, or **fail closed**, never ignore it merely because an earlier probe indicated `PermitVirgin`; broken, nonregular, unreadable/dangling entry -> fail closed. Do not overwrite or implicitly initialize a previously existing manifest.

**S5 — Startup/writer consistency:** App-owned startup and manifest initialization must use a **documented serialization/ownership boundary** for normal legitimate writers (existing single-instance mutex may provide part of it, not complete proof). Validate the manifest at the latest safe decision before accepting startup. For create-if-absent, require an exclusive/atomic create-or-refuse strategy with an explicit `AlreadyExists` response; opening an unexpectedly appearing manifest as a virgin creation is forbidden. No promise against arbitrary hostile path replacement without an actual held synchronization/handle mechanism. If current architecture cannot meet this in the bounded files, `BLOCKED_DESIGN_CONCURRENCY` and request an Owner scope decision, not another `exists()` retry.

**S6 — Interruption/recovery:** If a manifest exists without a valid committed row after a crash, fail closed with a distinct diagnostic; never silently reset, erase or treat it as virgin. A separate migration recovery flow may be designed later, not invented here. Ordinary valid restart and privileged-auth-only floor state must remain available.

**S7 — Policy A and release:** Keep the narrow floor-only Policy A behavior exactly; RISK-008 remains OWNER_ACCEPTED_RISK and cannot be promoted to protected data-loss PASS. Preserve Offline First and `SERVER_AUTHORITATIVE_CLOSE_ENABLED=false`. No M1 source acceptance, merge or release from static-only review.

## 4. ONE proposed implementation packet — future Owner approval REQUIRED

**Proposed scope in the same existing detached N-001 clone, and nowhere else.** Initial custody must confirm pinned SHA `f034301c46dd9e08190f869cc85dbb140ac28a3c` and **exactly two existing unstaged, authorized candidate diffs**, with no staged or unexpected untracked changes; original main remains tracked-clean. Existing candidate MUST NOT be reset/cleaned/recloned or duplicated.

**Proposed source write allowlist (not yet approved for editing):**
- `src-tauri/src/epoch_floor.rs`: F-01 ancestor-entry validation, S2 floor read vs absence handling and S3 fallible privileged-auth/OAC inventory error propagation *as required for no false virgin*. Preserve recognized data-bearing shape rules and existing floor/first-install semantics. Add focused synthetic tests within this file if explicitly approved.
- `src-tauri/src/durable_kv.rs`: F-02 virgin/compatible manifest validation, creation/ownership consistency and static/invariant checks in existing manifest helpers; preserve Policy A, existing commit/epoch inventory validation and all source safety boundaries. Add targeted tests within this file if explicitly approved.
- `src-tauri/src/single_instance.rs` and `src-tauri/src/lib.rs`: **READ-ONLY dependencies**, not part of write allowlist. Existing order and mutex can be relied upon only to the extent demonstrated. If normal supported cross-session/shared-profile or other legitimate uncoordinated writer requires modifying either, **STOP / request a separate exact allowlist decision** rather than silently widening the current proposal.
- No edit to `privileged_auth` implementation or other modules. If fallible wrappers or call sites outside these two files are strictly required, STOP and bring a single blocker with exact dependency before modifying.

**Recommended sequencing within one future approved source-only run:**
1. Read-only custody + exact two-file preexisting diff comparison (no new clone/workspace).
2. Apply F-01 + L-01 + L-02 checked absence semantics and F-02 manifest-authority/normal-writer coordination **together** in the allowed files; do not patch-and-relaunch reviews mid-packet.
3. Static diff and changed-files allowlist; source-level trace of all callers, original first-install, valid floor, invalid manifest, race-related decisions, and tests as source text. One Claude report with unresolved uncertainties.
4. Then **one separate independent Codex read-only review** after Owner handoff, not automatically. If source reviewer still finds an unprovable concurrency condition, report `BLOCKED_DESIGN` instead of another autonomous patch loop.

**Not authorized now or by this spec:** source edits, CLI launches, cloning/worktree, Cargo/rustc/build/tests, disk cleanup or capacity change, network, AppData/real device profiles, commit/push/merge, main, Firebase Cloud, production, Gate-OFF changes, reducing >=10 GiB Cargo/build preflight. Owner has explicitly declined further disk cleanup/expansion.

## 5. Acceptance matrix — required evidence, currently NOT_RUN

| ID | Oracle / decision | Evidence required later |
|---|---|---|
| SI-01 | Genuine empty new install (app-data absent; safe parent) -> startup allowed, no false error | Synthetic first-install fixture + startup path |
| SI-02 | Dangling app-data symlink or broken ancestor -> FailClosed, not `Ok(false)` | Focused Windows reparse/negative controls or explicit SKIP |
| SI-03 | Dangling `durable` symlink, existing non-directory durable, unreadable ancestor -> FailClosed | Filesystem error fixtures |
| SI-04 | `PermissionDenied`, `read_dir` failure, iterator error -> Err/FailClosed, never false virgin | Fault-injection/ACL where feasible |
| SI-05 | Missing floor + recognized durable or privileged-auth data -> FailClosed; unreadable security state -> FailClosed | Controlled synthetic datasets; retain OAC empty/unrecognized exemption |
| SI-06 | Valid compatible floor + Phase-B manifest truly absent, no recognized domains -> Policy A legal; RISK-008 explicit | Floor-only / privileged-auth-only fixtures |
| SI-07 | Manifest present during either startup branch -> validation; invalid/dangling/nonregular/unreadable -> FailClosed | Manifest creation/get/startup negative controls |
| SI-08 | Committed manifest + missing/bad domains / unsupported schema / epoch regression -> FailClosed | Existing A-N4…A-N8 and integrity checks |
| SI-09 | Manifest appears/disappears during normal *participating* writer/startup operations -> no unvalidated acceptance, no overwrite | Deterministic orchestration/fault injection; defined ownership/atomic-create behavior |
| SI-10 | Crash before/during manifest creation/floor write -> fail-closed or documented safe resume, never silent reset | Interrupted-init/restart fixtures |
| SI-11 | Same-session second Twinpet POS instance -> rejected under named mutex | Named-mutex synthetic/integration test |
| SI-12 | Out-of-namespace/cross-session writers sharing root -> no claim of protection unless common ownership proven | Architecture evidence or `BLOCKED_DESIGN_CONCURRENCY` |
| SI-13 | Preserved legacy data/inventory/Offline First/Gate-OFF | Diff invariants plus future runtime proof |
| A-N1..A-N8 | Preserve full original Policy A negative and positive controls | Actual synthetic runtime executions, no skipped-as-PASS |

**Evidence grades:** `STATIC_REVIEW_ONLY`, `NOT_RUN`, `NOT_VERIFIED`, `OWNER_ACCEPTED_RISK`, or actual test PASS/FAIL with pinned SHA and synthetic fixture; no treating static checks as runtime PASS. Before any Cargo/build test the existing **>=10 GiB verified free space gate** remains unchanged and is not currently met. Runtime proof is deferred, not waived; with Owner refusing added capacity and cleanup the project may remain STOPPED at M1, not falsely complete.

## 6. One final decision / stop rule

**Design work is COMPLETE as a proposal.** The **one** next Owner decision is whether to approve the **consolidated implementation scope in Section 4** (two writable files in same clone; additional source or mutex/session scope requires STOP), with explicit recognition that real tests/build are not authorized and cannot produce M1 PASS at current disk gate. If Owner declines, HOLD with existing two-file candidate intact.

Do **not** run Claude/Codex or make more source/audit loops merely because this document exists. Planning branch only; no live `agent-workflow` phase activation.
