# MP1 Candidate N-002 — GUARD-SYNTH-001 Isolated Guardian Synthetic-Only Approval

**Date:** 2026-11-22 (Asia/Bangkok)
**Status:** OWNER_APPROVED_SYNTHETIC_ONLY / PROMPT_PREPARED / WINDOWS_EXECUTION_PENDING

## Decision and baseline
Product Owner expressly approved creation of a new isolated Guardian prototype on D: and synthetic-process-only test execution based on the 2026-11-22 16:49 GUARD-AUDIT-001 read-only report (ROOT_CAUSE_INCONCLUSIVE). The prior OneDrive Prompt was readable on retry. Old Guardian single synchronous loop tied Stopwatch entry, C/D free-space queries, CSV flush, gap check and 150ms sleep; 291 npm CSV rows, only one 736ms >500ms; synthetic idle maximum 158ms. Exact blocking operation is not proven.

## ONE authorized bounded experiment
- Old D root READ-ONLY and preserved: D:\Twinpet-POS\Twinpet-N002-Build-20261122 (Guardian.cs, evidence, logs, partial npm-stage/node_modules, npm-cache, cargo-home). Verify seven existing evidence hashes before/after. No overwrite, edit, delete, move, cleanup or reuse.
- New writable root only if absent and no reparse/collision: D:\Twinpet-POS\Twinpet-N002-Guardian-Synthetic-20261122-001. Parent and external NTFS identity must be checked. Do not silently choose another path.
- Implement NEW Guardian source + harmless synthetic worker/harness inside new D root only. Local compilation of new Guardian prototype using ALREADY INSTALLED Windows/.NET tools is allowed, with TEMP/TMP/output on D. NO network, package restores, global settings changes, npm, Cargo, Twinpet POS Build/Test/GUI, Cloud/Production/ZORT, Source/Main/UAT023/real AppData or cleanup.
- Use owned Windows Job Object with suspended-child assignment and kill-on-close. Prove only owned synthetic child/grandchild are stopped and unrelated experiment-owned sentinel survives. Deadline/heartbeat supervisory path independent from C/D disk query and synchronous CSV logging. Bounded logging queue, fail-closed when valid disk data stale or watcher/queue fails; maintain original maximum 500ms disk-monitor criterion; heartbeat-only PASS is not disk sample PASS. No Windows hard-real-time guarantee claimed.
- Synthetic-only scenarios: idle baseline, <=64MiB total sandbox D I/O, injected slow C/D query, slow/broken log, stale heartbeat, watcher failure, simulated low-space and D disconnect (no actual disk filling or unplugging). <=120 sec total active synthetic runtime, <=20MiB logs; no repeated failed-case auto patch/retry, no deleting output evidence. End only experiment-owned processes.
- Stop at C <=2.25GiB early / <=2.0GiB mandatory; D <=10GiB/disconnect, watcher/guardian failure, path collision or unauthorized writes. This is NOT a change/waiver of the permanent C >=10GiB POS Build gate.

## Handoff
Full file: TPOS-MP1-CAND-N-002-GUARDIAN-SYNTHETIC-ONLY-REDESIGN-PROOF-CODEX-PROMPT.md
Owner saves full Markdown Prompt under C:\Users\Narachat\OneDrive\Ai-Report\twinpet-pos\Prompt\
Launcher: SHORT INLINE ONLY, never a Launcher file.
One new report under C:\Users\Narachat\OneDrive\Ai-Report\twinpet-pos\Codex\TPOS-MP1-CAND-N-002-GUARDIAN-SYNTHETIC-ONLY-REDESIGN-PROOF-CODEX-REPORT.md; timestamp suffix if collision, no overwrites.

**Outcome addendum (2026-11-22 17:34+07):** Codex reported `BLOCKED_TOOLING_OR_SANDBOX` at preflight without creating the new D root or building/running any synthetic Guardian code. The OneDrive Prompt was readable, built-in csc.exe present but NOT_INVOKED, seven old D evidence hashes unchanged. The previous one-shot GUARD-SYNTH-001 authority ENDED at STOP, and cannot be replayed automatically. See [two-stage next-decision analysis](planning/MP1-CAND-N-002-GUARD-SYNTH-001-PREFLIGHT-STOP-ADJUDICATION.md); future compile-only G1 then synthetic-only G2 need separate Owner permission. Preserve old D partial npm/cache untouched. F01/F02 OPEN, M1 NOT_PASS.

Prior DEPS-PROV-001 one-shot remains closed. A synthetic PASS means only measured sandbox tests passed, not npm/Cargo readiness or permission, not Build or M1 PASS. Any next provisioning or POS Build requires a NEW separate Owner approval and safe handling decision for the old partial npm staging. F-01/F-02 OPEN, Offline First/Gate-OFF unchanged. ChatGPT did not execute Windows Codex or touch user's D drive.
