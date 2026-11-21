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
| MP1 integration scope and test gates | MP1-002 triage done; decide targeted independent review before choosing any production hunks | TRIAGE_COMPLETE_PARTIAL / OWNER_DECISION_REQUIRED |
| U1/B1-R evidence acceptance | Headless EV-3 vs native GUI; EV-1; M1 mutant skipped | DEFERRED with release trigger; **not risk accepted** |
| Return/Refund activation | Separate owner/technology/cutover gate, retains gate OFF | LOCKED |
| EV-2, Android, cloud deployments, production upgrade/rollout | Separate scoped approval | NOT AUTHORIZED |

## Safety and non-decisions
No production data or live cloud was contacted in this planning pass. This log does not grant Merge/Deploy/Release. A PASS for focused tests is not a blanket release approval; U1/B1-R remains `EVIDENCE_COLLECTED / U1_NOT_ACCEPTED`.

**Related:** [Master Plan](MASTER-PLAN.md) · [Goal](PROJECT-GOAL.md) · [Progress](PROGRESS.md) · [Todoist](https://app.todoist.com/app/project/6j43w86FgC6PhQh6)
