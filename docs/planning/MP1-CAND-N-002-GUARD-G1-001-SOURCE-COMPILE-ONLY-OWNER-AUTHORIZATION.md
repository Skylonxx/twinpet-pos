# MP1 Candidate N-002 — GUARD-G1-001 Owner-Approved Source & Compile ONLY

**Date:** 2026-11-22 (Asia/Bangkok)  
**Status:** `OWNER_APPROVED_G1_SOURCE_COMPILE_ONLY / PROMPT_DELIVERED / WINDOWS_NOT_RUN_IN_CHAT`

## Decision and context

After `GUARD-SYNTH-001` returned `BLOCKED_TOOLING_OR_SANDBOX` at preflight without creating or compiling any new Guardian prototype, the Product Owner explicitly approved a **new narrower G1 packet**. The purpose is to write new C# Guardian source and compile it, not to execute it. Codex must not demand proof of the unbuilt runtime's safe process containment or <=500ms disk-sampling behavior before allowing authorized source creation and compilation.

Source evidence: `TPOS-MP1-CAND-N-002-GUARDIAN-SYNTHETIC-ONLY-REDESIGN-PROOF-CODEX-REPORT.md` 17:34 +07; earlier 16:49 read-only GUARD-AUDIT-001 confirmed 736ms old loop-entry gap (>500ms contract), independent root cause unresolved. The `csc.exe` at `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` was found by Codex but not invoked. The exact new D path was absent as of that report; recheck before making any directory.

## Single-run G1 scope

- **ONLY writable workspace (after rechecking path absent, NTFS serial and no reparse point):** `D:\Twinpet-POS\Twinpet-N002-Guardian-Synthetic-20261122-001`. Stop if it already exists. Do not choose another path, overwrite or cleanup.
- Preserve **entire old** `D:\Twinpet-POS\Twinpet-N002-Build-20261122` including old `guard\Guardian.cs`, evidence CSV, npm logs, npm-stage partial node_modules/cache and empty Cargo home. Seven prior source/evidence file hashes checked read-only before/after. No old-data reuse or cleanup.
- May write new auditable C# source and design note solely in new G1 root, **compile once into a DLL using installed .NET Framework csc.exe only** with temporary/output paths on D, inspect output hashes and record actual compile exit and diagnostics. No executing/loading DLL, synthetic processes, active Job Object, app runtime, guardian test or compiler re-run/auto-fix.
- Design (not yet experimentally verified): experiment-only Job Object child containment, independent monotonic watchdog, valid completed C & D disk samples (not heartbeat alone), bounded buffered logger, fail-closed threshold/stale-sample/queue/watcher paths. **<=500ms valid disk-sample criterion UNCHANGED**, Windows user-mode is not hard realtime. Source compile PASS does not prove these properties.
- No npm/Cargo install/fetch/download, POS frontend/native Build/Test, GUI, Firebase/Cloud/Production/ZORT, Source/Main/UAT023/real AppData, OS/global changes or cleanup. Permanent C>=10GiB POS Build policy unchanged; C <=2.25GiB early-stop, <=2.0GiB hard stop, D<=10GiB/disconnect remains experimental guardrail.
- Original repo main and detached candidate remain read-only; pinned original baseline `f034301c46dd9e08190f869cc85dbb140ac28a3c`. No new clone/worktree, modification to candidate's two Rust source changes or POS deployment.

## Deliverables / handoff

**Full downloadable Prompt**: `TPOS-MP1-CAND-N-002-GUARDIAN-G1-SOURCE-COMPILE-ONLY-CODEX-PROMPT.md` — Owner saves to `C:\Users\Narachat\OneDrive\Ai-Report\twinpet-pos\Prompt\`.

**Launcher:** short INLINE CODE BLOCK ONLY; no Launcher file. It points to the OneDrive full Prompt and the single Codex report. 

**Expected report path**: `C:\Users\Narachat\OneDrive\Ai-Report\twinpet-pos\Codex\TPOS-MP1-CAND-N-002-GUARDIAN-G1-SOURCE-COMPILE-ONLY-CODEX-REPORT.md` (timestamp suffix if existing; never overwrite). Include source/DLL hashes, compiler command/exit, static design checklist, seven old hash readbacks, and explicitly `PROTOTYPE_RUNTIME=NOT_RUN; SYNTHETIC_TESTS=NOT_RUN; NPM_CI=NOT_RUN; CARGO_FETCH=NOT_RUN; POS_BUILD=NOT_RUN; TEST=NOT_RUN; GUI=NOT_RUN`.

**Next Gate G2 not approved:** review G1 result then separately authorize bounded synthetic-only execution, preserving prior D partial npm and evidence. Any additional compile, synthetic runtime, npm/Cargo provisioning or POS Build requires NEW Product Owner authorization. `M1 NOT_PASS`, F-01/F-02 remain OPEN; no merge/release; Offline First and Gate-OFF unchanged.

**Execution attestation:** ChatGPT authored and verified the Prompt file but has **not run Windows Codex, compiler or a prototype**. This document is on the planning branch, not main.
