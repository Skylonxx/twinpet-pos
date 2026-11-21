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
| MP1 integration scope and test gates | Which Stage056/058/061–065 deltas land or remain UAT-only | READ_ONLY_CLASSIFICATION_ALLOWED; IMPLEMENTATION_PENDING |
| U1/B1-R evidence acceptance | Headless EV-3 vs native GUI; EV-1; M1 mutant skipped | DEFERRED with release trigger; **not risk accepted** |
| Return/Refund activation | Separate owner/technology/cutover gate, retains gate OFF | LOCKED |
| EV-2, Android, cloud deployments, production upgrade/rollout | Separate scoped approval | NOT AUTHORIZED |

## Safety and non-decisions
No production data or live cloud was contacted in this planning pass. This log does not grant Merge/Deploy/Release. A PASS for focused tests is not a blanket release approval; U1/B1-R remains `EVIDENCE_COLLECTED / U1_NOT_ACCEPTED`.

**Related:** [Master Plan](MASTER-PLAN.md) · [Goal](PROJECT-GOAL.md) · [Progress](PROGRESS.md) · [Todoist](https://app.todoist.com/app/project/6j43w86FgC6PhQh6)
