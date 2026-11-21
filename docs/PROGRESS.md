# Twinpet POS — Progress / Evidence Register (MP0 DRAFT)

**Prepared / updated:** 2026-11-21 · Baseline main `f034301c46dd9e08190f869cc85dbb140ac28a3c`  
**Applies to:** proposed MP0 portfolio only. Actual live phase is still `POST_SEC001_NEXT_PHASE_SELECTION_ADJUDICATION` / active implementation NONE.

## Planned milestones
| Gate | Status | Evidence / next condition |
|---|---|---|
| MP0 planning started | IN_PROGRESS | Owner agreement to rebaseline and track in Todoist; this proposal branch |
| MP0.1 source-of-truth map | DRAFT_READY | GitHub tracked workflow trio, skills, historical Task/Context/UI trackers, prior reports |
| MP0.2 priority/dependencies | DRAFT_READY | `MASTER-PLAN.md`, Gantt; critical path proposal only |
| MP0.3 debt/risk register | DRAFT_READY | U1/B1-R 016–024 evidence retained; TD-001/RISK-002/UAT-004/GOV-003 |
| M0 Owner/Gemini phase selection | MP1_R01_REVIEW_ONLY_APPROVED / FORMAL_PENDING | Owner authorized focused independent pre-integration read-only review; no implementation successor chosen in live trio |
| MP1 preserve/integrate UAT | Candidate N ISOLATED_IMPLEMENTATION_OWNER_APPROVED / NOT_RUN | Claude implementer prompt prepared; original main and release untouched; independent Codex review pending; M1 OPEN, MP1.3 LOCKED |
| MP2 native offline E2E | LOCKED | M1 acceptance, safe isolated UAT environment |
| MP3 release readiness | LOCKED | M2 acceptance + explicit Owner GO/NO-GO |

## Evidence map (bounded historical sources)
| Item | Status | Do not overclaim |
|---|---|---|
| SEC-001 native/Rules | CLOSED per live workflow | Does not authorize successor packet |
| PK-1–PK-6 and Phase A/B/C | CLOSED / CLOSED_WITH_NOTES | Not a release acceptance of future candidate |
| UAT Stage056 + 058/061–065 | MP1-001 builds checked; MP1-002 1,364 source hashes matched, 167 paths triaged | 2 protected env files and extra files unchecked; UAT overlay gate ON vs official OFF; no full tree/runtime PASS |
| Report MP1-001 UAT baseline custody | MP1_001_PARTIAL_IDENTITY | SB63/SB64 file hashes match identities; Stage056 pins/patch manifest hashed; 1,366-file current-tree proof NOT_RUN; build IDs scratch Git; UAT flag true vs official false |
| Report MP1-002 source-delta triage | MP1_002_PARTIAL_CLASSIFICATION | 1,364/1,366 manifest matches; 64 production-review, 101 tooling, 2 unknown from 167 paths; no per-hunk review or integration acceptance |
| Report MP1-R01 independent risk review | MP1_R01_REVIEW_COMPLETE_WITH_BLOCKERS | Gate-ON/OFF, native floor-only, identity/journal, privileged scope atomicity block integration decisions; high inventory/ledger risks; no runtime exploits proven |
| Report 016 compile | PASS | Compile is not runtime |
| Reports 018+019 focused runtime | PASS 5/5 | Limited exact cases only |
| Report 020 behavioral mutations | PASS_LIMITED 3 KILLED; M1 SKIPPED | Not 4/4 and not full catalog |
| Report 022 headless EV-3 | EVIDENCE_COMPLETE_HEADLESS | Windows-linked manifest/domain config, not GUI app/process proof |
| Report 023 EV-4 | BINDINGS_VERIFIED | FFI imports/link, not full Windows semantics |
| Report 024 workflow adjudication | PLAN_AUTHORITY_UNRESOLVED | Current authority trio lacks latest UAT/selection |
| Native EV-1 / EV-2 / GUI EV-3 / offline operational UAT | NOT_RUN or NOT_AUTHORIZED | Do not infer PASS, release or durability |

## Candidate N implementation authorization (2026-11-21)
- Owner approved Candidate N source changes **in a fresh isolated clone only**, restricted to native-custody files `src-tauri/src/durable_kv.rs` and `src-tauri/src/epoch_floor.rs` plus inline tests; no `main` checkout/modification, no Git commit/merge/Cloud/AppData/Production or Candidate I.
- Conditional minimal fix only if justified; `NO_CHANGE_REQUIRED` and `BLOCKED_DESIGN_CONFLICT` are valid verdicts. Legitimate privileged-auth-only floor epoch 2 without a Phase-B manifest must remain compatible; **do not blanket fail closed floor-only roots**.
- The [Candidate N boundary document](planning/MP1-CAND-N-NATIVE-CUSTODY-IMPLEMENTATION-PACKET.md) is a planned execution control, not runtime evidence. CLI prompt generated for manual Owner launch; no executor report yet and no independent Codex review.

## MP1-P01 Owner acceptance (2026-11-21)
- Owner explicitly accepted the MP1-P01 planning contract after reviewing the deliverables. `MP1_P01_PLAN_OWNER_ACCEPTED` is **planning status only**; this is not runtime/UAT acceptance.
- Conservative fail-closed default for ambiguous virgin/floor-only and missing/orphan sequence is a planning proposal accepted as a safety constraint; no changes to code or live recovery policy were executed.
- Candidate N **implementation authorization PENDING**; candidate I, MP1.3, native UAT and release LOCKED. No automatic Codex/Claude packet.

## MP1-P01 planning completed as draft (2026-11-21)
- Owner explicitly authorized **planning only** for Native Custody & Device Identity after MP1-R01.
- Created `docs/planning/MP1-P01-NATIVE-CUSTODY-IDENTITY-SAFETY-PLAN.md` on planning branch: proposed N1–N3 + I1–I4 invariants, safe state/acceptance matrix, two smaller future candidates N then I, explicit stop/no-go rules and source-vs-unknown evidence labels.
- Status is **PLANNING_DRAFT_READY / NOT_IMPLEMENTATION_APPROVED**. No source edits, code tests, native run, UAT, Cloud, merge or policy gate activation. The official workflow trio still has no successor implementation selected.
- One next owner action: **review/accept or revise MP1-P01 plan**; future Candidate N implementation is separately gated. Do not start another automatic CLI packet.

## MP1-R01 independent review result (2026-11-21)
- Received scoped Codex source/design review with `MP1_R01_REVIEW_COMPLETE_WITH_BLOCKERS`; no modification of source, Git, runtime, Cloud or protected data in the report.
- Integration blockers to resolve before accepting production deltas: UAT Gate-ON (058) vs official Gate-OFF, native floor-only prior-state predicate, identity/sequence + journal/restart atomicity, privileged offline scope check outside IndexedDB transaction. These are source/design concerns, not proven runtime failures.
- Inventory/FIFO and local ledger remain HIGH risk; two prior UNKNOWN seams reclassified: ledger `PRODUCTION_REVIEW_REQUIRED`/HIGH and privileged action `PRODUCTION_REVIEW_REQUIRED`/BLOCKER. UAT trust/enrollment guards remain UAT-only; 064 issuance concurrency review future.
- **Next: OWNER DECISION** on MP1-P01 native custody + identity safety *planning packet only*, not automatic Codex/Claude task. MP1.3/M1 remain LOCKED/OPEN; no new U1 EV test loop.

## Owner scoped review approval (2026-11-21)
- User explicitly approved the proposed **Independent Pre-Integration Review** after MP1-002. Approval ID `MP1_R01_REVIEW_ONLY_APPROVED`. No approval to fix, merge, test or deploy.
- Next agent Codex CLI, independent reviewer, read-only; one approved report in OneDrive. Planning branch/board updated; live `main` workflow remains unchanged.

## MP1.2 evidence reviewed (2026-11-21)
- MP1-002 verdict `MP1_002_PARTIAL_CLASSIFICATION`. Matched 1,364 of 1,366 manifest paths; `.env.example` and `.env.test` skipped as protected; unchecked extras and non-atomic source snapshot mean whole-tree equivalence UNKNOWN, not a discovered mismatch.
- 167 path names triaged: 64 `PRODUCTION_REVIEW_REQUIRED`, 101 `TEST_OR_TOOLING`, 2 `UNKNOWN` (`useLocalLedger.ts`, `projectPrivilegedOfflineAction.ts`). No comprehensive per-hunk assessment.
- Source-verified UAT overlay 058 sets `SERVER_AUTHORITATIVE_CLOSE_ENABLED=true` while raw Stage056 and main are `false`. Recorded SB61–SB64 scripts apply overlay; actual runtime branch UNKNOWN.
- MP1.2 bounded evidence task complete with partial outcome. M1 NOT ACCEPTED; MP1.3 implementation LOCKED. No automatic Agent next packet.

## MP1.1 evidence reviewed (2026-11-21)
- MP1-001 report `MP1_001_PARTIAL_IDENTITY`: SHA-256 of SB63 `9f7fddf10ae89bd7364a973cbde670e0ddc2f81be1e93a347df54b9622159e91`; SB64 & Stage065 copied EXE `3caee049721e09735dc5a3c18b5cda786d91af5d6a4952d02db79b4efaa674a0`. These hashes establish existing bytes, not runtime proof.
- Stage056 source pins/cumulative diff/base `f034301` found; tree not git repo; manifest 1,366 entries (historical) not rechecked; cumulative diff reports 167 changed files; UAT build identities use scratch commit, not main.
- Release/config risk: UAT metadata `SERVER_AUTHORITATIVE_CLOSE_ENABLED=true` versus official main `false`; no decision to flip flag; enter read-only MP1.2 classification.
- Repository local `planning/mp0-rebaseline-20261121` ref missing in offline Codex host; draft branch on GitHub still exists. No local fetch authorized.

## MP0 actions performed
- Inspected current GitHub main plan/workflow and selected prior reports; existing tracked UI plan is not a product-level Master Plan.
- Created separate Todoist board: [Twinpet POS — Planning](https://app.todoist.com/app/project/6j43w86FgC6PhQh6) with 8 sections / 25 planning tasks; **no MP1–MP3 due dates**, no automatic authorization.
- Created proposal branch `planning/mp0-rebaseline-20261121` containing Goal, Master Plan, Gantt, Decisions and this Progress file; **main untouched**, existing live gate unchanged.
- No Source Code, tests, build, native app/profile, Cloud, Rules/Functions, release or data cleanup in this pass.

## Next one action
**Next one action:** Owner manually runs `TPOS-MP1-CAND-N-001-NATIVE-CUSTODY-ISOLATED-IMPLEMENTATION-CLAUDE-PROMPT.md` in Claude CLI on Windows. It may create a new isolated clone, conditionally edit only two native custody files and run bounded offline synthetic tests, then STOP with one report. No autonomous CLI execution by ChatGPT. **After the report**, ChatGPT reviews whether independent Codex read-only inspection is warranted and asks Owner by buttons. M1 OPEN; MP1.3, Candidate I, MP2/3 and main merge remain LOCKED.

**Formal M0 phase registration and workflow-trio reconciliation:** still pending; this scoped authorization does not change the live `ACTIVE_IMPLEMENTATION_PACKET=NONE`.

**Operating rule:** after approved scope changes, reconcile Master Plan, Gantt, Decisions, Progress and Todoist together; otherwise keep proposal status and backlog separate.
