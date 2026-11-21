# Twinpet POS — Candidate N-002 low-disk source-only adaptation

**Date:** 2026-11-22 · **State:** OWNER_APPROVED_SOURCE_ONLY / EXECUTOR_NOT_RUN / TESTS_NOT_RUN
**Policy:** A / RISK-008 previously Owner-accepted for floor-only with total previous Phase-B file loss; no general data safety or release waiver.

## Technical assessment of the 10 GiB gate
- Original N-002 packet required >=10 GiB free BEFORE new isolated clone and Cargo/Rust synthetic tests. This was a conservative estimated headroom gate, **not a measured source-edit size requirement**.
- N-001 report: an existing detached local isolated clone at C:\Users\Narachat\TPOS-MP1-CAND-N-ISO-20261121 was clean and pinned to f034301c46dd9e08190f869cc85dbb140ac28a3c when created, ~43 MB. Its CURRENT existence, identity and cleanliness must be verified; never assume they are unchanged.
- N-002 result: BLOCKED_DISK_CAPACITY (then C: 0.359 GiB), no new clone, no source changes, no Cargo/Rust tests.
- Final UAT consolidation result: C: free 5,365,436,416 bytes (~5.00 GiB) after cleanup at last measurement; may have changed since. Owner explicitly refuses more cleanup or storage addition.
- N-001 suggested 8–10 GiB for Tauri build, without running a build or measuring true incremental requirements. It does NOT prove an exact minimum. It also does NOT prove 5 GiB sufficient for compilation.
- Source main@f034301 in src-tauri/src/durable_kv.rs uses floor-path existence OR durable-domain-file existence before manifest_path_state classifier. The sole proposed Policy-A change is to remove the floor-path existence limb, preserving domain evidence and classifier.

## Owner-approved path: source-only patch by reusing N-001 clone (2026-11-22)
1. Owner explicitly approved this changed execution method in chat on 2026-11-22. Before any code write, Claude READ-ONLY verifies original Windows repo remains main at exact f034301 SHA/tracked clean, with untracked ops/lib/stash, secrets and AppData untouched. Verify already-existing N-001 clone is a real, non-junction independent clone at the exact path, detached at exact pin, no tracked/untracked/ignored modifications, and no conflicting active use. If clone is absent/dirty/wrong SHA or unsafe, STOP; do NOT create/reset/clean/re-clone/worktree/fetch.
2. If approved and verified, edit ONLY src-tauri/src/durable_kv.rs IN THE EXISTING CLONE. Remove floor-existence subexpression alone in prior_phase_b_state_exists. Keep durable_domain_files_exist, manifest_path_state, invalid-present manifest handling, epoch/inventory guards, official Gate-OFF, and the previously accepted narrow A-risk unchanged. Do NOT copy UAT overlay 058 wholesale.
3. NO Cargo, build, rustc compilation, tests, dependencies, new workspace, disk cleanup, app launch, Git commit/push/merge, Live data, Cloud or Production. The original >=10 GiB **Cargo/build gate is NOT relaxed**; this distinct source-only stage simply does not perform any Cargo/build activity.
4. Small static-only checks: read exact diff/changed-file list, git diff --check, inspect retained condition/error branches, verify no scope drift; standalone rustfmt --check only if it does not write or invoke Cargo. If checks require build/new files, record NOT_RUN and STOP.
5. Write ONE Claude report to C:\Users\Narachat\OneDrive\Ai-Report\twinpet-pos\Claude\TPOS-MP1-CAND-N-002-LOW-DISK-SOURCE-ONLY-CLAUDE-REPORT.md (never overwrite; use timestamp suffix if occupied) with pinned SHA, clone custody, one-file diff, scope verification, C: free before/after, RISK-008 explicit residual, A-N1…A-N8 marked NOT_RUN; no claimed runtime PASS. Retain clone unchanged after reporting except the authorized diff.
6. Later, independent Codex review of exact diff can be separately dispatched READ-ONLY after receiving the Claude report; the review must not run Cargo or mutate code. SOURCE_REVIEW_ONLY is not M1 PASS.

## Boundaries and release rule
- Owner **specifically approved** the source-only method 2026-11-22. It supersedes the original N-002 new-clone-plus-tests execution method **for this bounded phase only**. The prior N-002 blocked report stays historical; no rerun or automatic retry. No existing 10 GiB build/test safety gate was reduced.
- Synthetic/runtime A-N1…A-N8 and native Offline First negative controls remain NOT_RUN. No M1 acceptance, integration, release or deployment until a separately approved way to produce real test evidence exists. No expectation that Owner add disk capacity.
- RISK-008 remains Owner-accepted narrowly for total Phase-B file loss indistinguishable from first-boot floor-only state, not a blanket waiver.

**One next action (now approved):** Owner manually pastes the full self-contained N-002 source-only instruction into Claude CLI (no prompt file lookup). Claude verifies original + existing clone read-only, edits only durable_kv.rs in the reused clone if verified clean/pinned, records static diff and one report. After receiving that report, request independent Codex **read-only** review; do not automatically launch Codex or claim Rust tests passed.