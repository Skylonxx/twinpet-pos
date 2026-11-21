# Twinpet POS — Candidate N-002: Floor-only Policy A / Implementation Scope

**Prepared:** 2026-11-21  
**Decision status (2026-11-21):** `OWNER_APPROVED_CAND_N_002_ISOLATED_EXECUTION / EXECUTOR_NOT_RUN`  
**Scope type (Owner-approved now):** limited Claude CLI implementation in a new isolated clone, one-source-file write allowlist and targeted offline synthetic Rust tests **only if safe disk preflight passes**. No changes to original repo/main, Git commit/merge, deploy, Cloud or AppData.  
**Baseline:** GitHub `main@f034301c46dd9e08190f869cc85dbb140ac28a3c`; live workflow trio authority remains `POST_SEC001_NEXT_PHASE_SELECTION_ADJUDICATION / ACTIVE_IMPLEMENTATION_PACKET=NONE`.  
**Prior packet:** `TPOS-MP1-CAND-N-001` ended `BLOCKED_DESIGN_CONFLICT` (0 code changes; 0 tests), **not reusable as authorisation to execute this packet**.

## 1. Product Owner's explicit risk acceptance (narrowly scoped)

Owner explicitly chooses **A** after reading the Claude Candidate N-001 source-only report and the alternative policy comparison.

**Accepted trade-off for Native Phase-B root classification only:** when the epoch floor is present but **the migration manifest and all recognised Phase-B domain files are absent**, classify it as *virgin for manifest initialization purposes* rather than blocking creation solely because the floor exists. This restores the first-boot / legitimate privileged-auth-only floor path, but the same on-disk appearance can occur **after all previously committed Phase-B manifest/domain data have disappeared**. In that loss case the application may create a fresh native durable epoch **without warning that prior data existed**. This can mask evidence of prior loss and is not a data-recovery guarantee; prior unsynced sales/transactions could remain missing. **The Owner knowingly accepts this specific risk for the proposed implementation direction.**

**Boundary:** this is `RISK-008 OWNER_ACCEPTED_FOR_DESIGN_A` only, **not blanket acceptance** of lost bills, corrupt-but-present manifests, missing individual domain files, duplicate orders, sequence reuse, inventory errors, current on-disk customer data migration, or Production release. Release GO/NO-GO and deployment still require independent gates. The risk must remain explicit in release documentation; no claim that N1 is fully proven/achieved. Do not silently downgrade the RISK-008 register to "closed".

## 2. Evidence and why A needs a new packet

Claude Windows report `TPOS-MP1-CAND-N-001-NATIVE-CUSTODY-IMPLEMENTATION-CLAUDE-REPORT(1).md` assessed the pinned source:
- Normal first start / privileged-auth-only case: startup writes an epoch floor, then `prior_phase_b_state_exists` uses floor existence to block `manifest_get` and `open_or_create_manifest_if_virgin`; this is a first-install availability defect **derived from source/report**, not a Rust test PASS.
- Floor-only following *complete* prior manifest/domain loss has the same two recorded floor fields. Without a separate trusted provenance marker these states are indistinguishable in the reviewed source.
- Overlay 058 includes a **one-limb** deletion in `src-tauri/src/durable_kv.rs`; it also contains unrelated UAT-only changes that must **not** be imported.
- Main's `manifest_path_state` and existing committed inventory/version validation are separate security boundaries to retain.
- Tests **NOT_RUN_ENV_LIMIT**, Windows C: about 0.3 GiB free; prior isolated clone `C:\Users\Narachat\TPOS-MP1-CAND-N-ISO-20261121` is retained without edits.
- Source report extra observations O1–O3 are tracked as residual hardening/unknowns, not permission to expand this narrow packet.

## 3. Proposed implementation — for separate Owner approval ONLY

**Candidate N-002 target:** remove **only the floor-existence limb** from `prior_phase_b_state_exists(root)` in `src-tauri/src/durable_kv.rs`; keep any existing domain-file and `manifest_path_state` checks and error propagation. Re-check that this is the smallest safe, effective change on the exact pinned baseline; do not take diff 058 wholesale.

**Proposed source write allowlist (in a separate fresh isolated clone only):**
- `src-tauri/src/durable_kv.rs` — conditional one-limb change plus focused existing-file Rust test additions if needed.
- `src-tauri/src/epoch_floor.rs` — **read-only unless a specific necessary change receives a new Owner scope approval**; no default edit.
- Any other file: **NOT AUTHORIZED**. Even a seemingly needed `lib.rs` or test-file change must STOP and request a new allowlist decision.

**Separate approval now granted:** Owner subsequently explicitly approved **Candidate N-002 Implementation**, including (a) a **new** isolated clone of pinned main, (b) conditional one-file change, (c) targeted Rust offline synthetic tests **after safe disk-space check**, and (d) independent Codex review **after the Claude report as a separate review handoff**. Exact runnable prompt: `TPOS-MP1-CAND-N-002-POLICY-A-ISOLATED-IMPLEMENTATION-CLAUDE-PROMPT.md`. It is for manual Owner launch; no CLI execution/commit/merge/release is implicit in this document.

## 4. Proposed acceptance checks (to run only after separate approval & safe environment)

| Check | Required expected behavior / oracle |
|---|---|
| A-N1: Virgin first start → epoch floor written → `manifest_get` / `manifest_put_epoch` / `lease_acquire` | May initialize manifest and continue first Phase-B migration; valid floor alone does not block |
| A-N2: Privileged-auth-only floor (epoch 2), no Phase-B manifest/domain | Restart and first migration remain supported; no user state reset due merely to floor |
| A-N3: **Floor-only after complete prior Phase-B manifest + domain loss** | **KNOWN ACCEPTED RISK:** can be treated as virgin; mark test evidence explicitly as `RISK_ACCEPTED_BEHAVIOR`, not protection PASS |
| A-N4: Domain files remain but manifest absent | Must **fail closed**, no silent virgin creation |
| A-N5: Manifest present but malformed, unsupported `user_version`, missing table, non-file or dangling symlink | Must **fail closed**, cannot be misclassified as absent |
| A-N6: Valid committed manifest but missing/invalid any required domain | Must **fail closed**; no fresh epoch substitution |
| A-N7: Valid committed manifest and complete inventory | Reopen without epoch regression, data mutation, or manifest re-creation |
| A-N8: Interrupted migration / incompatible epoch floor | Existing legal-epoch and monotonic/fail-closed rules remain intact |

**Evidence grade:** tests only pass when actually executed with explicit assertions, command, isolated path, baseline SHA, reproducible fixture and result. Source reading alone = `SOURCE_DERIVED`, not `TEST_PASS`. Windows symlink tests may be skipped with recorded permissions constraint; don't mark skipped as passing.

## 5. Environment & safety gates before any implementation

1. Before any Cargo compile/test, address `ENV-001`: Windows C: had ≈0.3 GiB free. Confirm adequate verified disk headroom for offline Tauri/Rust deps (Claude estimated ≈8–10 GiB; **estimate, not guarantee**) without deleting OneDrive, AppData, original repo/stash/`ops/lib`, UAT artifacts, backups or retained clone. No auto-cleanup.
2. Use a **new, positively absent isolated clone destination** from local pinned main; never change original `C:\Users\Narachat\twinpet-pos` or preserved Stage056/UAT. Keep no network/fetch, no protected secrets/env reads.
3. Source changes only after separate Owner-approved runnable packet. Do **not** launch app/NSIS installer, access real device profile, or touch Cloud/Rules/Functions/Production. Official `SERVER_AUTHORITATIVE_CLOSE_ENABLED=false` remains unchanged.
4. After focused tests, obtain **independent Codex code review** on exact diff & proof with explicit A-risk acknowledgement; report to Owner. Do not self-review, merge, push or close M1 automatically.
5. Stop on unexpected source SHA, dirty original, unverified isolation, new out-of-scope issue, non-synthetic path, or proposed code expansion. Report the blocker, not a new autonomous fix packet.

## 6. Definitions of done and subsequent decisions

**Implementation readiness (not execution):** this document records the Owner's Policy A risk acceptance, minimum patch target, expected negative controls, environment constraints, and reviewer roles. **Owner implementation gate APPROVED**. This document is now a runnable **scope reference**, not a result: execution is `NOT_RUN`. Next one action is Owner manually launches the exact Claude CLI Prompt after ensuring it exists at the specified local path. Completion is a source diff plus real test evidence or a safe `BLOCKED_*` report; independent Codex review remains a separate phase. No commit/push/merge/release is approved.

**After a future implementation report (not now):** separately initiate independent read-only Codex review and seek Owner acceptance; formal M0/M1/governance gate remains pending. Disk threshold in the runnable Prompt is **10 GiB minimum verified free before cloning/building** (a safety preflight threshold, not a predicted exact build size); any shortage must produce `BLOCKED_DISK_CAPACITY`, never cleanup. Candidate I/MP1.3 and MP2/MP3 remain locked.

## 7. Source links

- Prior [Candidate N-001 blocked packet](MP1-CAND-N-NATIVE-CUSTODY-IMPLEMENTATION-PACKET.md)
- [MP1-P01 accepted planning contract](MP1-P01-NATIVE-CUSTODY-IDENTITY-SAFETY-PLAN.md) — **Policy A explicitly supersedes only the prior conservative floor-only fail-closed proposal; all other invariants and gates stay**.
- [Master Plan](../MASTER-PLAN.md) · [Decisions](../DECISIONS.md) · [Progress](../PROGRESS.md)
