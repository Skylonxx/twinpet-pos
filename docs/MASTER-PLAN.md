# Twinpet POS — Master Plan Rebaseline

**Version 1.6 — PLANNING DRAFT / OWNER APPROVES ONE-PASS UAT LEGACY CONSOLIDATION; EXECUTOR NOT RUN**  
**Prepared / updated:** 2026-11-21 · **Latest Owner decision:** accepted Policy A RISK-008 and separately approved Candidate N-002 **isolated** implementation and bounded offline synthetic Rust tests, but Claude has **not yet run**. Candidate N-001 remains BLOCKED; `main`, Cloud, merge, release NOT authorised.  
**Explicit non-authority:** this new file on a planning branch does NOT change the live workflow gate, authorize MP1 integration/implementation, MP2/MP3, code changes, merge or release.

## 0. Current Owner handoff — bounded decision

**2026-11-21 — M0_SCOPED_MP1_READ_ONLY_AUTHORIZED / FORMAL_PHASE_ADJUDICATION_PENDING.** The Owner directed continuation after reviewing the MP0 draft. MP1.1/MP1.2 **read-only evidence identification and source-delta classification** is the only newly authorized next action. The live workflow trio still says successor implementation = NONE; formal reconciliation is pending. MP1.3 integrations, code changes, builds, UAT, Git commits/merges to main, deployment and cloud work are not authorized by this handoff.

**MP1-R01 COMPLETE and MP1-P01 PLANNING DRAFT_READY (2026-11-21):** Product Owner authorized MP1-P01 design/planning only. See [MP1-P01 Native Custody & Identity Safety acceptance contract](planning/MP1-P01-NATIVE-CUSTODY-IDENTITY-SAFETY-PLAN.md). **Owner explicitly approved Candidate N isolated implementation (2026-11-21)** after accepting MP1-P01. Exact scope and guardrails are in [Candidate N implementation packet](planning/MP1-CAND-N-NATIVE-CUSTODY-IMPLEMENTATION-PACKET.md). Claude returned `BLOCKED_DESIGN_CONFLICT` with no source changes or tests. **Next action is Owner's explicit policy selection on floor-only classification**, not an automatic retry or independent code review. Candidate I and MP1.3 remain locked. MP1.3 implementation remains LOCKED; M1 OPEN and formal successor phase selection pending.

## 1. Authority and source precedence

1. Product Owner / explicit Gemini decision gates in `docs/agent-workflow/AUTHORITY_MATRIX.md` are final for product/phase, merge and Production.
2. `docs/skills/SKILL-OFFLINE-FIRST-POS.md`, `SKILL-GLOBAL-ARCHITECTURE.md`, `AGENTS.md`: mandatory technical/operating constraints.
3. **Existing live workflow trio:** `docs/agent-workflow/STATE.md`, `CURRENT_PACKET.md`, `NEXT_ACTION.md` — remains authoritative for active phase and packet until explicitly reconciled.
4. `Task.md`, `Context.md`, `docs/STATE.md`, UI-specific master plans: retain as historical/area trackers, not a single current product roadmap.
5. This **proposal**, `PROJECT-GOAL`, `DECISIONS`, `PROGRESS`, Gantt, and Todoist mirror: planning artifacts, not authority to execute until Owner closes M0.

**Current canonical gate:** `POST_SEC001_NEXT_PHASE_SELECTION_ADJUDICATION`; `SEC001_OVERALL_STATUS=CLOSED`; `ACTIVE_IMPLEMENTATION_PACKET=NONE`. MP0–MP3 are proposed portfolio workstream names, **not** original Phase A/B/C names or V5's technical unknown U1.

## 2. Reconciled existing portfolio (historical evidence, not a live host audit)

| Workstream | Verified/report-supported status | Boundaries |
|---|---|---|
| UI/payment/manager approvals | Large milestone series CLOSED/PUSHED | This does not prove complete current cashier E2E |
| Offline/Sync PK-1 through PK-6 | CLOSED/DELIVERED | New native candidate's end-to-end sale and close still not established |
| TRUE-STANDALONE Phases A/B/C | CLOSED or CLOSED_WITH_NOTES | No Production authorization |
| SEC-001 | CLOSED incl. native and Rules evidence | Does not auto-select successor phase |
| Return/Refund Packet 023 | SOURCE_CLOSED; `pos_return` OFF and server-authoritative close gate OFF | Activation, Functions/Rules release remain locked |
| Stage056 + 058/061–065 UAT line | MP1-001 verified SB63/SB64 identity; MP1-002 matched 1,364/1,366 manifest entries and grouped all 167 paths (64 production-review; 101 tooling; 2 UNKNOWN) | Protected env files and extras unchecked; no per-hunk production acceptance or full-tree proof |
| U1/B1-R 016–024 | Compile PASS, focused 5/5, selected mutants killed 3 (M1 skipped), EV-3 headless evidence, EV-4 Windows binding check | EV-1 and GUI EV-3 missing; U1 NOT ACCEPTED |
| Native production release/upgrade | NOT AUTHORIZED; candidate not ready for release | Real-data migration and installer proof pending |
| Android | DEFERRED | No Phase selection |

## 3. Critical path (proposed)

### MP0 — Planning / Rebaseline [NOW, PLANNING ONLY]
- MP0.1: audit only current workflow status, source identity and last reports; tag SOURCE_VERIFIED vs REPORT_ONLY vs UNKNOWN. Avoid broad repeat audits.
- MP0.2: classify every important gap into release blocker, integration risk, evidence retained/deferred validation, ordinary technical debt, or future feature.
- MP0.3: record U1/B1-R evidence from 016–024 without restarting its technical loop.
- **M0 Owner/Gemini decision:** agree goal, next *one* execution phase, accepted non-goals, roles, evidence acceptance, remaining gates. A planning draft is not an M0 PASS.
- MP0.4: after separate approval, reconcile current workflow trio and planning documents/Todoist; verify they agree. Docs-only changes must not invent implementation approval.

**M0 PASS criteria:** one approved next phase/work packet and Owner signoff; no contradictory authority; technical debt has reopen triggers; locked items remain locked.

### MP1 — Preserve / Integrate known-good UAT [MP1.1/1.2 READ-ONLY AUTHORIZED; IMPLEMENTATION LOCKED]
- **MP1.1 READ-ONLY:** record identity/hash of existing Stage056 + 058/061–065 source, binaries, patches, evidence, UAT-only guards. *Do not create/copy/move/delete a preservation archive or modify a manifest in the host*. Report observed paths/hashes only.
- **MP1.2 READ-ONLY:** compare actual working candidate and local main, classify required production delta / UAT-only / discard / unknown. If baseline missing/identity uncertain: report BLOCKED, do not reconstruct.
- Owner-authorized guarded integration branch with independent Code Review and bounded regressions, covering checkout, shift, stock and sync. No automatic merge into main.

**M1:** source→build traceability and reviewed integration baseline; existing UAT success preserved. MP1-001 verdict `MP1_001_PARTIAL_IDENTITY`; MP1-002 verdict `MP1_002_PARTIAL_CLASSIFICATION`: 1,364 Stage056 manifest file hashes match, two protected `.env` files skipped, extras unchecked. The 167 delta paths were clustered only, **not reviewed per hunk**. UAT overlay 058 sets close gate ON although main/raw Stage056 are OFF. Actual native runtime path UNKNOWN. **M1 still OPEN; MP1.3 implementation LOCKED.**

### MP2 — Native Offline Operational UAT [LOCKED pending M1]
- On a sanctioned, isolated native UAT environment: one offline sale → app restart → reconnect → exactly-one order/payment/stock effect.
- Offline shift close/open, pending/confirmed wording, sync and variance; receipt/reprint, parked bills, manager void, payments, history, branch isolation.
- Surface U1/B1-R/EV-1/GUI EV-3 remaining validation only when relevant to **this actual release candidate** and a safe environment exists. Do not call headless evidence GUI proof.

**M2:** critical-path cashier scenarios observed as PASS on traceable build; release-critical data/authorization gaps resolved or gate BLOCKED.

### MP3 — Release Readiness / Owner Decision [LOCKED pending M2]
- Controlled NSIS installer and upgrade from installed POS 0.1.12 using clone/test data root; prove data preservation and monotonic epoch/fail-closed.
- Evidence index, remaining risk acceptance and rollout plan; Owner release **GO/NO-GO** separately.
- No production activation, deploy, or physical store changes until separate explicit authorization.

**M3:** Owner release decision recorded, never inferred from a test PASS.

## 4. Technical Debt & Risk Register

| ID | Classification | State | Reopen trigger |
|---|---|---|---|
| TD-001 U1/B1-R | Evidence retained + pending validation, **not accepted risk** | 016–024: 5/5 focused; M2–M4 killed; M1 skipped; EV-3 headless complete; EV-4 binding verified; EV-1/GUI remaining | Affected durable code enters integration/release, or new material defect |
| RISK-002 UAT source/build drift | Integration / release risk (HIGH) | MP1-002: 1,364 manifest entries match; two `.env` protected + extras unchecked. 167 delta paths grouped into 64 production-review, 101 tooling, 2 UNKNOWN. Scratch Git build IDs not main commits. | Scope independent per-hunk review of cashier-critical deltas before any integration, not repeated broad rehash |
| RISK-006 UAT vs official shift-close gate | Integration / business-behavior risk (HIGH) | MP1-002 confirmed overlay 058 flips `false` to `true`, all SB61–SB64 script inputs include overlay, but actual executed native branch remains UNKNOWN | Owner decision on keeping official Gate-OFF and what UAT evidence can be reused; **no automatic Gate-ON adoption** |
| RISK-007 privileged action / ledger seams | Security and sale-integrity BLOCKER for privileged atomicity | MP1-R01: ledger now `PRODUCTION_REVIEW_REQUIRED` (HIGH); privileged scope check happens outside IndexedDB transaction, unsafe race remains unproven (BLOCKER) | Do not integrate until store/ingest/retry contract and scope-change proof; do not treat as accepted technical debt |
| RISK-008 Floor-only ambiguous prior loss | Owner-accepted design trade-off (HIGH residual risk; NOT RELEASE ACCEPTED) | If floor exists with all Phase-B manifest/domain files missing, accepted Policy A may silently reinitialize, masking total prior loss | Record explicit A acceptance; validate negative controls under a *separately approved* Candidate N-002 packet; re-evaluate at release gate |
| ENV-001 Windows Rust disk headroom | Implementation/test environment BLOCKER | N-002 `BLOCKED_DISK_CAPACITY`: C: free 0.359 GiB, no clone/code/tests. TPOS-DISK-001 PARTIAL inventory: TPOS023-UAT 7.19 GiB logical; candidate generated Rust target 2.49 GiB and review023 node_modules 0.51 GiB (combined 3.00 GiB *potential*). Not enough alone to meet 10 GiB gate. | Owner path-specific approval only after process/retention/rebuild checks; no automatic deletion or UAT evidence cleanup |
| GOV-003 stale workflow / plan gap | Process/governance debt (NOW) | live trio lacks later UAT line; no one consolidated product plan | MP0 + M0 reconciliation |
| UAT-004 native E2E | Release acceptance blocker | sale/restart/reconnect/stock/shift not signed off on a traceable candidate | MP2 |
| TEST-005 baseline shift tests | Verification readiness risk | Historical `shiftService.*` baseline failures on Node 26 (prior report) | Integration regression testing under MP1 |

**No blanket risk acceptance.** Anything risking duplicate/missing bills, unauthorized privileged action, inventory misstatement, or data loss requires mitigation or an explicit Owner gate before that candidate's release.

## 4.1 MP1-002 disposition and Owner review gate

**Triage evidence accepted, not production acceptance:** manifest 1,364/1,366 matched; two protected `.env` paths skipped, extras and concurrent changes unchecked. Parsed all 167 Stage056 source path names (90 added, 77 modified) but only selectively reviewed source; 64 require production risk review, 101 are tests/tooling, two remain UNKNOWN. No patch replay, new build or UAT runtime proof.

**Do not repeat** the 1,364 hash checks or blanket-scan 167 paths. Protected `.env` contents must not be opened for mere completeness. Treat unverified extras and provenance as evidence gaps, not automatically release-stopping defects; raise them when defining reproducible integrated candidate.

**OWNER APPROVED FOR MP1-R01 READ-ONLY REVIEW:** focused independent assessment of high-risk changed hunks: official Gate-OFF vs UAT Gate-ON, epoch/migration, device identity/sequence, sale journal/idempotency, inventory/FIFO/branch scope, the two UNKNOWN privileged/ledger files and UAT trust/enrollment guards. Require file:line evidence, risk severity, target Production vs UAT-only disposition and exactly one Owner decision recommendation. This review **does not authorize** source edits, integration branches, tests/builds, cloud, deployment, merge or release. No blanket scan of 167 paths or rehash of verified source entries.

## 4.2 MP1-R01 independent review disposition (2026-11-21)

**Verdict: `MP1_R01_REVIEW_COMPLETE_WITH_BLOCKERS` — review task done, integration acceptance BLOCKED.** Source evidence indicates design risks, not confirmed exploitation or actual customer-data loss.

| Area | Decision risk | Disposition |
|---|---|---|
| Official Gate-OFF vs UAT overlay Gate-ON | BLOCKER (behavior not interchangeable) | Gate-ON overlay `NOT_FOR_INTEGRATION` without a separate Owner policy gate; prove actual Gate-OFF close later on a controlled candidate |
| Native epoch / virgin state | BLOCKER (058 removes floor-only prior-state check) | Plan invariant/manifest/data preservation proof before adapting to main |
| Device identity, seq, journal | BLOCKER (fence not proven atomic over native commit, restart/retry) | Plan bounded identity/sequence proof and exactly-once contract |
| Privileged offline action | BLOCKER (JS scope check outside IndexedDB transaction) | Keep hold pending atomic ingest/retry authority proof |
| Inventory / FIFO / branch, local ledger | HIGH (late/cache-only and authoritative effects unproven) | Targeted semantics review in a later separately approved packet |
| UAT trust anchor/enrollment | BLOCKER *if production leakage* | Explicit `UAT_ONLY_GUARD`, exclude from production default; note 064 issuance concurrency risk |

**Owner decision now:** whether to select **MP1-P01 PLANNING ONLY — Native Custody & Identity Safety** as the one next bounded design packet. Scope candidate: `durable_kv.rs` virgin/floor/manifest invariant and device identity/sequence/source provenance; produce an acceptance contract and proposed implementation boundaries, **no source edits, tests/build, UAT, branch/merge or cloud changes**. Do not start until Owner authorizes it. All other areas remain tracked release/integration risks, not waived. U1/B1-R evidence retains prior status and must not restart by default.

## 4.3 MP1-P01 planning result (Owner-authorized; not accepted implementation)

[MP1-P01 — Native Custody & Identity Safety Plan](planning/MP1-P01-NATIVE-CUSTODY-IDENTITY-SAFETY-PLAN.md) is prepared as a **planning-only acceptance contract**. It defines 7 proposed invariants (N1–N3 native manifest/floor/epoch and I1–I4 device identity/sequence/scope/idempotency), a focused state/acceptance matrix, and two **separate, still unapproved** future candidates: N (native durability custody) then I (device identity/sequence). Source vs historical report vs future proof are explicitly distinguished; conservative design default is FAIL_CLOSED rather than silent virgin/sequence reset, subject to Owner recovery policy. The official shift-close Gate-OFF remains unchanged. This document **does not** complete M1, accept risk, approve code edits/tests or start integration.

**OWNER ACCEPTED MP1-P01 PLAN AND APPROVED CANDIDATE N ISOLATED IMPLEMENTATION (2026-11-21).** Allowed: ONLY `src-tauri/src/durable_kv.rs` and `src-tauri/src/epoch_floor.rs` in a NEW LOCAL CLONE, conditional minimum correction or no-change, bounded synthetic offline Rust tests, one Claude report. Crucial compatibility: legitimate privileged-auth-only epoch floor with no Phase-B manifest is not automatically corruption; do not blanket fail closed. Code may be edited in clone only; do not commit/push/merge, touch original main, UAT artifacts, APPDATA, live systems or Cloud. Independent reviewer remains future gate. Candidate I, privileged/stock/shift issues and MP2–MP3 remain locked.

## 4.4 Candidate N implementation gate — Owner authorization, EXECUTOR NOT RUN

**Packet:** [MP1-CAND-N Native Custody Implementation](planning/MP1-CAND-N-NATIVE-CUSTODY-IMPLEMENTATION-PACKET.md). 
**Decision:** `MP1_CAND_N_OWNER_APPROVED_ISOLATED_IMPLEMENTATION` (not M1 accepted). Claude may only work in a new standalone local clone of pinned `f034301`, editing `src-tauri/src/durable_kv.rs` and/or `src-tauri/src/epoch_floor.rs`, optionally inline tests. All Cargo runs offline and scoped to synthetic roots; `NO_CHANGE_REQUIRED` is valid. Independently review before any later integration. Preserve valid auth-only floor-only behavior, existing manifest validation, official Gate-OFF. If safe differentiation of floor-only partial loss requires extra trusted evidence, stop with `BLOCKED_DESIGN_CONFLICT` instead of a speculative fix. No code has been executed by ChatGPT through this planning record.

## 4.5 Candidate N execution result / decision gate (2026-11-21)

**Claude report:** `TPOS-MP1-CAND-N-001-NATIVE-CUSTODY-IMPLEMENTATION-CLAUDE-REPORT(1).md` received; `BLOCKED_DESIGN_CONFLICT`. Local Windows original repo and GitHub main both reference `f034301c46dd9e08190f869cc85dbb140ac28a3c`. In isolated clone, **0 files changed**, **0 Rust tests run** (`NOT_RUN_ENV_LIMIT`; host C: ≈0.3 GiB free). Report's N1–N3 state table is **source-derived, not test-verified**. Clone remains, no deletion authorised.

**Competing cases:** a legitimate floor-only root from virgin first boot or privileged-auth state (startup succeeds but `manifest_get`/creation blocks), versus a floor-only root after complete manifest+domain loss. Existing floor fields cannot distinguish these according to the Claude source analysis. Removing floor check as in isolated overlay 058 would let first migration proceed but **could silently create new state after prior data loss**. Provenance marker (BOOTSTRAP→SEALED) may disambiguate but requires a larger explicit design/compatibility/recovery and crash-window gate. Neither alternative is accepted by this record.

**Owner chose A explicitly:** Accept floor-only-as-virgin and its risk of silently starting a new Phase-B epoch after total Manifest/Domain loss. This supersedes the floor-only fail-closed default in MP1-P01 **only for the defined case**; do not treat as blanket safety or release acceptance. A new scoped Candidate N-002 document is prepared; **no implementation permission was given**. Before any authorised Rust build resolve disk headroom safely; no automatic cleanup on Windows.

**Process notes:** report found the prompt under a different OneDrive folder than the launcher; initial macOS preflight had been overwritten by the Windows pass, and the report admits a temporary scratch draft outside the strict one-report output set. These are reporting/traceability issues to correct for future packets, **not evidence of modified protected source**.

## 4.6 Owner Policy A acceptance / Candidate N-002 pending implementation gate (2026-11-21)

**Decision:** `RISK_008_OWNER_ACCEPTED_POLICY_A_DESIGN_ONLY` — Owner knowingly accepts that a root with an epoch floor but zero Phase-B manifest/domain files can be classified virgin even after **total prior Phase-B file loss**, with fresh-epoch creation possibly **without warning**. This is a deliberate trade-off to unblock legitimate first-boot/privileged-auth floor-only migration and does not prove data recovery, existing-bill preservation, idempotency or Production readiness. No automatic code edit or re-run of the blocked N-001 packet.

**Next scoped approval document:** [Candidate N-002 — Policy A implementation scope](planning/MP1-CAND-N-002-FLOOR-ONLY-POLICY-A-IMPLEMENTATION-SCOPE.md). Proposed minimal change is removing the floor-existence limb from `prior_phase_b_state_exists` *only* in `src-tauri/src/durable_kv.rs`; preserve domain-presence and manifest-path fail-closed guards, inventory/version validation, and official shift-close Gate-OFF. Proposed future synthetic oracles include first-install auth-only, missing manifest with remaining domains, corrupt/nonfile/dangling manifest, valid committed domains, and acknowledged all-files-lost risk. `epoch_floor.rs` remains read-only absent a new separate scope approval.

**Owner approved Candidate N-002 isolated implementation** with strict guardrails. **Next one action:** Owner manually runs Claude CLI using `TPOS-MP1-CAND-N-002-POLICY-A-ISOLATED-IMPLEMENTATION-CLAUDE-PROMPT.md`; new separate clone, `durable_kv.rs` only, min 10 GiB verified free before clone/build, bounded offline Rust synthetic checks, one report. If low space or any boundary fails, STOP `BLOCKED_*` with no clone/edit/test. Independent Codex reviewer follows only after Claude report as a separate step. Candidate I, MP1.3 integration, native UAT, Git main merge, release and cloud stay locked.

## 4.7 Candidate N-002 Owner code gate approved (EXECUTOR_NOT_RUN)

Owner explicitly approved implementing Policy A in a fresh isolated clone of `main@f034301`, **one-file source allowlist `src-tauri/src/durable_kv.rs`**, targeted offline synthetic Rust tests **if and only if** disk safety preflight is satisfied. `epoch_floor.rs` is **read-only**. Approved code intent: remove only the floor-existence limb in `prior_phase_b_state_exists`; keep missing-domain and manifest invalid/present paths fail closed, preserve legal epoch/inventory validation and official Gate-OFF. `RISK-008` is an Owner-accepted *specific* residual risk of full prior Phase-B file loss masquerading as virgin, not a blanket safety waiver.

**Execution preflight:** N-001 Windows C: ≈0.3 GiB free; runnable prompt uses a conservative **10 GiB verified free threshold before clone or Cargo**. If not met, report `BLOCKED_DISK_CAPACITY` without any disk cleanup or code change. Exact one-time manual Prompt: `TPOS-MP1-CAND-N-002-POLICY-A-ISOLATED-IMPLEMENTATION-CLAUDE-PROMPT.md`. Report to `OneDrive/Ai-Report/twinpet-pos/Claude/`; no retry of N-001, no auto-call Codex. After a Claude report, Owner/ChatGPT open a separate independent Codex review gate. **No code executed by ChatGPT**, no release/merge or M1 closure.

## 4.8 Disk-blocked execution and UAT storage triage (2026-11-21)

Claude N-002 report `BLOCKED_DISK_CAPACITY`: original baseline pinned, 0.359 GiB free, no clone/source edits/Cargo/tests. **Do not rerun unchanged**. Codex `TPOS-DISK-001-UAT-STORAGE-INVENTORY-REPORT.md` scanned `C:\Users\Narachat\TPOS023-UAT` **read-only** and reported PARTIAL (the intended prompt path was absent). Enumerated 7.19 GiB logical across 205,469 files, excluding 23 reparse-point directories; not a disk allocation/recovery guarantee.

Two *conditional candidate* cleanup targets: `integration-u1-b1r-impl-20261118\src-tauri\target` 2.49 GiB, `scratchpad\review023-independent\node_modules` 0.51 GiB; together 3.00 GiB logical. Require explicit Owner approval and pre-delete verification of exact paths, use by processes, original ownership/evidence-retention and rebuild/offline-dependency availability. Do not delete parent folders. An additional 0.70 GiB of stage028 Rust targets remains **protected pending evidence review**. The UAT source, Stage056, binaries, patches, evidence, profiles, .git/stashes and backups remain protected. Even ideal 3.00 GiB recovery plus 0.359 GiB free would remain well under 10 GiB; seek further safe capacity outside a blind UAT cleanup. No delete/move yet.

## 4.9 Owner-authorized disk cleanup scope (2026-11-21; executor NOT RUN)

Owner approved deletion of **exactly two generated-cache candidates**, only after non-following canonical path/reparse checks, in-use/process, Git tracked-status, unique evidence retention and reconstruction safety are confirmed. Exact paths relative to `C:\Users\Narachat\TPOS023-UAT`:
- `integration-u1-b1r-impl-20261118\src-tauri\target` — 2.49 GiB logical (Rust target)
- `scratchpad\review023-independent\node_modules` — 0.51 GiB logical (Node dependencies)

Combined **potential** 3.00 GiB logical, not guaranteed freed disk bytes. If a candidate cannot pass any check, it is BLOCKED, **not** replaced by another folder. No deletion has been executed by ChatGPT. Manual Codex Prompt: `TPOS-DISK-002-UAT-EXACT2-CLEANUP-AND-LEGACY-CACHE-INVENTORY-CODEX-PROMPT.md`; report canonical `C:\Users\Narachat\OneDrive\Ai-Report\twinpet-pos\Codex\TPOS-DISK-002-UAT-EXACT2-CLEANUP-AND-LEGACY-CACHE-INVENTORY-CODEX-REPORT.md`.

Same run separately produces a **READ-ONLY TOP-15** inventory of historical Rust/Tauri/Node test caches including stage028, stage024 and replay targets; **no additional deletion** (especially protected evidence, Stage056, UAT binaries, profiles, backups, Git). Old N-002 remains disk-blocked; do not automatically retry. Reassess disk headroom and actual reclaim only after report. This is a single bounded cleanup authorization, not a general 'delete test history' policy.

## 4.10 TPOS-DISK-003 — exact generated compilation artifacts only (Owner-approved; NOT RUN)

**Owner explicit scope update, 2026-11-21:** Previous TPOS-DISK-002 found **0 deleted**: Rust `target` contains protected `focused-runtime-017-scratch` with SQLite manifest, provenance and committed-epoch data; `review023-independent\node_modules` is junction-backed by `review027`, hence unsafe to remove wholesale. TPOS-DISK-002 measurement C: around 2.10 GiB free. This replaces the earlier exact-two whole-directory delete approach; do **not** retry it.

**New approved action, manual Codex CLI direct-paste prompt only:** inspect then conditionally remove **positively identified Rust/Tauri generated compilation/cache material within** `C:\Users\Narachat\TPOS023-UAT\integration-u1-b1r-impl-20261118\src-tauri\target`. Confine deletion to validated Cargo-produced build subtrees and known compiled extensions within `debug\deps`, with explicit protection of `focused-runtime-017-scratch`, every SQLite, manifest, provenance, committed epoch/marker, unique UAT evidence, executables/images needed as proof and any user/test data. Reject any reparse point, junction, active-use conflict or ambiguous contents; delete **only safe siblings/files**, not `target` or `debug` parent. No deletion of shared `node_modules`, profile, Stage056, older proof runs or other paths; no source/Git/Cloud/Production/build/test/N-002 retry. No automatic process termination. **The risk of any ambiguous file should be resolved by SKIP, not by destroying data.**

**Evidence:** Codex measures free C: before and after and reports actual byte delta (not theoretical logical target size) and list of exact deleted/skipped entries, protected fixture verification and next cleanup candidates (read-only). One report to `C:\Users\Narachat\OneDrive\Ai-Report\twinpet-pos\Codex\TPOS-DISK-003-GENERATED-RUST-CACHE-CLEANUP-REPORT.md`. No file deletion occurred by ChatGPT. Original main and build/release gates remain unchanged.

## 4.11 TPOS-UAT-CONSOLIDATE-001 — Owner-approved one-pass historical UAT consolidation (NOT RUN)

Owner explicitly requested to **finish UAT folder cleanup in one pass** instead of iterating on narrow Rust cache checks, after accepting the proposal to preserve only MP1-critical source, patch, known binaries and proof while removing old generated/test outputs. This supersedes the prior DISK-002 whole-folder deletion attempt and DISK-003 single-target approach, **without relaxing source/data/evidence protection**. The UAT root `C:\Users\Narachat\TPOS023-UAT` is a historical staging tree, not the live POS installation. No independent current host execution is claimed.

**Authorised manual Codex one-pass task:** `TPOS-UAT-CONSOLIDATE-001-ONE-PASS-CLEANUP-CODEX-PROMPT.md` supplied as a downloadable text file and a **self-contained direct-paste instruction**, not a dependency on a OneDrive prompt. Before deletion, create a *small logical retention index* under canonical `C:\Users\Narachat\OneDrive\Ai-Report\twinpet-pos\Codex\` mapping retained source/Stage056, overlay058/061–065, identity/binary hashes, evidence, manifests/SQLite, `focused-runtime-017-scratch`, profiles, .git, backups and any unique test state **in place**. No bulk copy/migration to OneDrive on low disk space. Then conditionally delete only positively verified obsolete generated build/dependency cache material **anywhere within the UAT root** including old `stage028` generated Rust targets and `integration-u1-b1r-impl-20261118` compilation caches. Skip ambiguous content or any active-use/reparse hazard **per item**, not whole task; preserve linked `node_modules` if retained replay consumers depend on it. No deletion of UAT root, original POS repo, Stage056/patch source, evidence, retained binaries, profile, real AppData, OneDrive history, or out-of-root targets.

**Deliverables:** one exact-byte before/after C: free-space report + deleted/skipped path inventory and retained-index under `Ai-Report\twinpet-pos\Codex`, no report in source repository; do not build/test, alter Git, run N-002 or touch Cloud/Production. This is a **cleanup execution approval**, not proof any files were deleted yet, not permission for future indiscriminate cleanup, and not M1/Release acceptance. After report, decide on storage/safe N-002 approach based on measured reclaimed bytes, not a guessed 10 GiB reclaim requirement.

## 5. Other initiatives / deferred (LOCKED)
Return/Refund activation and sealing Rules; Android/Capacitor; EV-2 VM hard reset; broad mutation matrix; unrelated UI polish; unapproved Cloud/deployment or live POS data contact.

## 6. Operating model — same principle as Twinpet AI Assistant
- **Owner:** business goal, scope/phase/cost/risk authorization; can override agent assignment.
- **ChatGPT:** Technical Lead, roadmap/M0–M3 coordination, one bounded prompt after gate authorization.
- **Claude CLI:** default Implementer on authorized code work.
- **Codex CLI:** default independent Reviewer/Tester/Project Manager. **No same-agent self-review**.
- **Todoist:** Board mirrors master plan and approved execution, *not* permission to run tasks.
- **GitHub:** canonical documents, evidence/decision record and source. One active implementation workstream after M0; max one next authorized packet at a time.
- **Change request:** new issue → record in backlog/technical debt → assess impact/priority → Owner approves reprioritization → update Master Plan, decisions, Gantt, Todoist and workflow trio together.
- **STOP:** scope drift, stale plan, repeated testing without new evidence, missing candidate custody/safe isolation, uncontrolled live data/cloud, implicit merge/deploy authorization.

## 7. Planning calendar
No binding due dates for MP1–MP3. `docs/planning/MASTER-PLAN-GANTT.md` shows dependencies and MP0-only *tentative* planning window. Milestone dates and capacity require M0 review.

## 8. Source/evidence index
- Live authority: [STATE](agent-workflow/STATE.md) · [CURRENT_PACKET](agent-workflow/CURRENT_PACKET.md) · [NEXT_ACTION](agent-workflow/NEXT_ACTION.md) · [AUTHORITY_MATRIX](agent-workflow/AUTHORITY_MATRIX.md)
- Permanent rules: [Offline First](skills/SKILL-OFFLINE-FIRST-POS.md) · [Global Architecture](skills/SKILL-GLOBAL-ARCHITECTURE.md)
- Historical: [Task](../Task.md) · [Context](../Context.md) · [UI plan](UI_MASTER_PLAN.md)
- Prior status reports: `TPOS-MASTER-PLAN-STATUS-GAP-READONLY-001-REPORT.md`; `TPOS-POSTUAT-U1-B1R-...-CODEX-016..024-REPORT.md` (historical, not rerun).
- [Todoist planning board](https://app.todoist.com/app/project/6j43w86FgC6PhQh6)

**DRAFT branch review required before changing live phase authority or merging.**
