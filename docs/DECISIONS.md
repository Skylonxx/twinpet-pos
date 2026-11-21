# Twinpet POS — Decision Log (MP0 DRAFT)

**Version:** 0.1 · 2026-11-21  
**Scope:** planning decisions only; does not replace `docs/agent-workflow/AUTHORITY_MATRIX.md` or live workflow trio.

## 2026-11-21 — Owner authorizes MP0 plan-first rebaseline
- Product Owner agrees to **stop ad-hoc technical packet chaining**, reconstruct product-level Master Plan, and use a Todoist board modeled on the Twinpet AI Assistant workflow.
- ChatGPT is to coordinate planning and evidence, keep technical debt/release-critical risks separately identified, and bring phase/priority decisions back to Owner before any new implementation.
- A *DRAFT-only* documentation branch and planning Todoist board are permitted as artifacts of MP0. This does **not** authorize merging docs into main, modifying source, native tests/build, UAT, cloud activity, or production deployment.
- Offline First / TRUE-STANDALONE is permanent and not reopened.
- Previously closed phase history stays intact; `docs/agent-workflow/{STATE,CURRENT_PACKET,NEXT_ACTION}.md` remains the current gate authority until explicit reconciliation.

## 2026-11-21 — Owner continuation: MP1 evidence-only authorization (scoped)

- From the Owner's instruction to proceed after MP0 planning review, **authorize only read-only MP1.1 / MP1.2 evidence discovery**: locate known-good UAT Stage056/058/061–065 artifacts, verify existing source/build identity, compare candidate to `main` and categorize differences without altering either.
- This is a **limited M0 handoff**, not unconditional M0 closure or approval of MP1.3 implementation. The formal successor implementation phase remains unselected in the authoritative workflow trio; it must be reconciled under an explicit separate Owner/Gemini gate.
- A single bounded Codex read-only evidence packet may be prepared and manually launched by the Owner. This permits **only its report write** to the designated OneDrive reporting folder. It does not authorize modifying/copying/deleting UAT trees, source code, Git metadata, binaries, build cache, AppData, cloud or Todoist tasks from the CLI.
- Current repository `main` remains unchanged. No merge or live deployment authorization. MP2/MP3 and Return/Refund/Android remain locked.
- M0 label for this decision: `M0_SCOPED_MP1_READ_ONLY_AUTHORIZED / FORMAL_PHASE_ADJUDICATION_PENDING`.

## 2026-11-21 — MP1-001 review & scoped MP1.2 routing

- Received `TPOS-MP1-001-UAT-BASELINE-CUSTODY-READONLY-CODEX-REPORT.md`, verdict `MP1_001_PARTIAL_IDENTITY`. MP1.1 evidence recorded: Stage056 pinned to base `f034301`, 167-file cumulative patch; selected patch/script/manifest hashes match; SB63/SB64 exe SHA-256 independently matched recorded `BUILD-IDENTITY`. Not a full source-tree proof or runtime PASS.
- **Unresolved:** current Stage056 tree vs historical 1,366-file manifest; scratch Git build IDs not main commits; separate 064 client vs Functions inputs; selected Stage056/main deltas; UAT SB61–64 build metadata says `SERVER_AUTHORITATIVE_CLOSE_ENABLED=true` whereas official main gate OFF. No source/production policy change authorized.
- Next single approved execution focus: **MP1.2 READ-ONLY source-delta and manifest classification** under previously scoped Owner continuation. Report only, no code changes, UAT execution, build, install, cloud/network, merge or cleanup.
- Local offline Codex host did not find remote-only GitHub planning branch; this is expected possible local-ref drift, not permission to fetch or change local Git. Planning docs are on GitHub draft branch.
- MP1.3 implementation remains locked; M0 formal successor phase decision remains pending.

## 2026-11-21 — MP1-002 accepted as *triage*, not integration review

- Received `TPOS-MP1-002-UAT-SOURCE-DELTA-CLASSIFICATION-READONLY-CODEX-REPORT.md` with exact verdict `MP1_002_PARTIAL_CLASSIFICATION`. This closes only the **bounded MP1.2 triage task**, not M1 or MP1.3.
- **Stage056 manifest:** 1,364/1,366 permitted entries matched size and SHA-256; `.env.example` and `.env.test` deliberately excluded, unlisted extras and atomic snapshot not examined. No verified mismatch/missing in checked paths; no whole-tree proof.
- **Source delta:** 167/167 paths grouped (90 added, 77 modified): 64 production-review, 101 test/tooling and 2 UNKNOWN (`useLocalLedger.ts`, `projectPrivilegedOfflineAction.ts`). Not a comprehensive per-hunk review or a proposed 167-file merge.
- **Gate discrepancy:** main and raw Stage056 hardcode `SERVER_AUTHORITATIVE_CLOSE_ENABLED=false`; overlay 058 flips it to `true`, historical SB61–SB64 scripts apply overlay. The actual Native execution branch during Owner testing remains UNKNOWN. No Gate-ON policy acceptance or release approval.
- **Next action = OWNER_ADJUDICATION_REQUIRED**, not another automatic Agent prompt. Recommended decision: define a **bounded independent pre-integration risk review** scope for cashier/security-critical deltas (native epoch, identity/sequences, sale journal, stock/FIFO, shift Gate-OFF/ON and two unknown privileged/ledger files), with UAT-only guards excluded from any implied production change.
- **Still LOCKED:** MP1.3 code/integration, tests/builds/native runtime, Cloud/Functions/Rules, local Git writes on Windows, protected AppData, installer, Production and merge; M1 not accepted, live workflow trio unchanged. No broad rehash of matching 1,364 files merely to claim whole-tree equivalence.

## 2026-11-21 — OWNER APPROVES MP1-R01 independent pre-integration READ-ONLY review

- Product Owner explicitly replied **"อนุมัติครับ"** to the proposal for an **independent, bounded pre-integration design/security review** of high-risk source delta paths after MP1-002.
- Approved scope **ONLY**: read selected original `main` and Stage056/overlay 058/patch 061–064 source hunks, analyze product/security impact, classify production-needed vs UAT-only vs reject/unknown, and write one report for the Owner. Areas: native durable epoch/migration; identity/sequence; order journal/dedupe; inventory/FIFO/branch; legacy Gate-OFF vs sandbox Gate-ON; the two UNKNOWN ledger/privileged seams; UAT trust anchor/enrollment.
- Default assignment: **Codex CLI as independent Reviewer / Tester / Project Manager**, in **READ-ONLY** mode (no test execution). Do not self-review code that Codex authored substantively; if found, flag conflict and STOP the affected area.
- **Explicit exclusions:** no file/source/Git edits in POS repo, tests/build, native GUI, installer, production data/cloud, Firebase Functions/Rules, network access, patch application, branch/merge/deploy, or env secrets. The sole executor write is the approved OneDrive report. Keep `SERVER_AUTHORITATIVE_CLOSE_ENABLED=false` as the official baseline; do not enable sandbox Gate-ON.
- Review completion is **not** MP1.3 integration approval, M1 acceptance, formal M0 successor implementation selection, Tech Debt risk acceptance, or release authorization. Next decision only after report review. Live workflow trio on main unchanged.
- Approval ID: `MP1_R01_REVIEW_ONLY_APPROVED`. Active task in Todoist Twinpet POS — Planning.

## 2026-11-21 — MP1-R01 review complete; **Owner next decision required**

- Received independent scoped Codex report `TPOS-MP1-R01-INDEPENDENT-PREINTEGRATION-RISK-REVIEW-READONLY-CODEX-REPORT.md` with verdict **`MP1_R01_REVIEW_COMPLETE_WITH_BLOCKERS`**. No source writes/build/tests/Cloud or deployment in that pass; authoring independence is supported for reviewed source/patches but full historical authorship is not proven.
- Source-level blockers **to a future integration decision**: (A) UAT overlay 058 Gate-ON is not official Gate-OFF behavior; (B) native/device order sequence and sale journal safety are not proven atomic through restart/retry; (C) `durable_kv.rs` prior Phase-B floor-only virgin predicate changes; (E2) privileged offline action scope is checked outside the IndexedDB transaction. High-priority inventory/FIFO, ledger and sync checks remain. These are **not observed runtime failures**.
- UAT-only 058 trust anchor/app ID and 063/064 self-enrollment routes must not bleed into production. 064 Functions issuance reads/creates separate records without an observed transaction in the reviewed hunk, potential concurrency risk, not a proven exploit.
- Codex recommends a **single next OWNER DECISION**: accept/reject **MP1-P01 native custody & identity safety PLANNING ONLY** as the next design packet, under official Gate-OFF; define a bounded contract/proof plan. Do not launch it automatically. MP1.3 code/integration, build/test/native UAT, Git merge, cloud/production and release remain LOCKED; M1 NOT ACCEPTED. Live workflow trio `main` remains unchanged.
- No further 167-file sweep, manifest rehash or spontaneous EV-1/EV-3 test loop is authorized.

## 2026-11-21 — Owner approves MP1-P01 PLANNING ONLY; acceptance contract drafted

- Product Owner explicitly approved the proposal **MP1-P01 — Native Custody & Identity Safety (Planning Only)** after Codex MP1-R01. Approval scope: write/record a planning document and Todoist status **on the existing planning branch**, not editing operational source or running builds/tests.
- Created [MP1-P01 acceptance contract](planning/MP1-P01-NATIVE-CUSTODY-IDENTITY-SAFETY-PLAN.md): N1–N3 native manifest/epoch/floor invariants; I1–I4 device identity/sequence/scope/journal invariants; future state/proof matrix; two intentionally separate future candidate boundaries (N native custody, I device identity).
- Proposed default for ambiguous floor-only or orphan-sequence states: conservative **FAIL_CLOSED + OWNER_RECOVERY_REQUIRED** pending explicit Owner recovery-design decision. This is a proposal, not a signed-off behavior change. Historical UAT source review and prior test results are not presented as runtime PASS.
- **Not approved:** Candidate N or I source implementation, branch creation on Windows host, applying overlay 058/patch 061, enabling Gate-ON, targeted test/build, Native UAT, cloud, Firebase rules/functions, integration/merge, or release. M1 stays open; workflow trio stays canonical with active implementation NONE; roles must follow `AUTHORITY_MATRIX.md` until formally reconciled.
- **Next Owner gate:** review/accept/revise MP1-P01 planning contract, choose whether to authorize a separate bounded Candidate N implementation design/write packet with precise acceptance tests and isolated environment, or HOLD. No agent follow-up packet auto-starts.

## 2026-11-21 — Owner ACCEPTS MP1-P01 planning contract (implementation NOT granted)

- Product Owner replied **"อนุมัติครับ"** immediately after the MP1-P01 planning draft was presented for acceptance/revision.
- Decision: `MP1_P01_PLAN_OWNER_ACCEPTED`. The N1–N3 native floor/manifest/epoch and I1–I4 device identity/sequence/scope/idempotency invariants, state matrix and N/I separation are **approved as planning acceptance criteria**, **not** as achieved technical results.
- The proposed conservative `FAIL_CLOSED + OWNER_RECOVERY_REQUIRED` behavior for uncertain floor-only/orphan-identity states is accepted as a **planning safety default** only; an actual change to recovery behavior still requires a separate scoped decision and proof of compatibility.
- **Candidate N implementation authorization is PENDING**. No approval for source edits, new Windows Git branch/worktree, tests/builds, data root operations, UAT, cloud, merge, deployment, or official Gate-OFF change. Candidate I and MP1.3 remain LOCKED; live workflow trio still shows no formal successor implementation phase.
- Next decision: issue or withhold a separate **Candidate N narrowly scoped implementation gate**, including exact code allowlist, synthetic isolation and proof strategy, independent reviewer and stop conditions. Do not auto-start an agent.

## 2026-11-21 — Owner authorizes Candidate N isolated implementation (scoped)

- Owner explicitly replied **"อนุมัติครับ"** to: **Candidate N Implementation** under a limited native-custody scope and synthetic testing, with no Production or `main`. Decision: `MP1_CAND_N_OWNER_APPROVED_ISOLATED_IMPLEMENTATION`.
- The bounded implementation packet is [MP1-CAND-N](planning/MP1-CAND-N-NATIVE-CUSTODY-IMPLEMENTATION-PACKET.md). Implementer: Claude CLI; next independent reviewer: distinct Codex instance *after* report and a separate review handoff. Owner to launch locally. Source-edit allowlist in **fresh isolated clone only**: `src-tauri/src/durable_kv.rs`, `src-tauri/src/epoch_floor.rs`, including narrow inline Rust tests. Targeted offline Cargo tests only in synthetic test roots; stop if dependencies/environment unsafe or scope must expand.
- **Key compatibility safeguard:** official source documents privileged-auth-only floor/epoch 2 without a Phase-B manifest as a legitimate restart. Owner-approved planning default `FAIL_CLOSED` for ambiguous partial loss must **not** be implemented as blanket floor-only rejection. Preserve compatibility and all existing manifest/epoch controls; if indistinguishable, report `BLOCKED_DESIGN_CONFLICT` and escalate.
- No mandatory code change: `NO_CHANGE_REQUIRED` is valid if pinned main already satisfies safe invariants. No silent import of UAT overlay 058, `SERVER_AUTHORITATIVE_CLOSE_ENABLED` Gate-ON, trust anchors, device identity Candidate I, sales/stock or privileged action paths.
- **NOT authorized:** edits/checkout/reset/clean in original Windows `main` or protected untracked/stash, commit/push/merge (even clone commit postponed), live AppData, native app/installer/UAT, Cloud/Functions/Rules, network, production rollout, Candidate I, MP1.3. Authorization does NOT claim M0 or M1 formal closure; the canonical workflow trio remains as-is until separate adjudication.
- User also requested **clickable Approve/Do-not-approve buttons at the next approval gate** rather than typed confirmation. In the ChatGPT interaction, use actions to submit their explicit choice; do not turn a displayed button into implicit approval.

## Planning policy to review at M0 (PROPOSED, not final)
- Immediate goal: reliable Native POS for real cashier operations before nonessential feature expansion.
- Proposed sequence: MP1 preserve/reconcile UAT → MP2 native offline operational UAT → MP3 release-readiness and Owner GO/NO-GO.
- Default agents consistent with recent Twinpet AI Assistant governance: ChatGPT Technical Lead, Claude implementer, Codex independent Reviewer/Tester/PM. No same-agent self-review; Owner may override assignments.
- A project task does not convey authority to run it. Scope changes require Owner approval and synchronized edits to Repo/Todoist.

## Pending decisions (NOT APPROVED by this log)
| Decision | Options/dependency | Current disposition |
|---|---|---|
| M0 next implementation phase | MP1.1/MP1.2 evidence-only handoff approved; MP1.3 implementation separately requires gate | SCOPED_READ_ONLY; FORMAL_PHASE_PENDING |
| Canonical status reconciliation | Exact allowed `STATE/CURRENT_PACKET/NEXT_ACTION` changes & their approval authority | PENDING |
| MP1 integration scope and test gates | Candidate N isolated implementation + bounded offline synthetic tests Owner-authorized; independent review, main merge and later phases not authorized | MP1_CAND_N_OWNER_APPROVED_ISOLATED_IMPLEMENTATION / M1_OPEN / MP1_3_LOCKED |
| U1/B1-R evidence acceptance | Headless EV-3 vs native GUI; EV-1; M1 mutant skipped | DEFERRED with release trigger; **not risk accepted** |
| Return/Refund activation | Separate owner/technology/cutover gate, retains gate OFF | LOCKED |
| EV-2, Android, cloud deployments, production upgrade/rollout | Separate scoped approval | NOT AUTHORIZED |

## Safety and non-decisions
No production data or live cloud was contacted in this planning pass. This log does not grant Merge/Deploy/Release. A PASS for focused tests is not a blanket release approval; U1/B1-R remains `EVIDENCE_COLLECTED / U1_NOT_ACCEPTED`.

**Related:** [Master Plan](MASTER-PLAN.md) · [Goal](PROJECT-GOAL.md) · [Progress](PROGRESS.md) · [Todoist](https://app.todoist.com/app/project/6j43w86FgC6PhQh6)
