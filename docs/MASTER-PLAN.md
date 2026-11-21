# Twinpet POS — Master Plan Rebaseline

**Version 0.3 — PLANNING DRAFT / MP1.1 REVIEWED; MP1.2 READ-ONLY NEXT**  
**Prepared:** 2026-11-21 · **Current approved scope:** MP0 planning + MP1.1/MP1.2 read-only evidence collection only  
**Explicit non-authority:** this new file on a planning branch does NOT change the live workflow gate, authorize MP1 integration/implementation, MP2/MP3, code changes, merge or release.

## 0. Current Owner handoff — bounded decision

**2026-11-21 — M0_SCOPED_MP1_READ_ONLY_AUTHORIZED / FORMAL_PHASE_ADJUDICATION_PENDING.** The Owner directed continuation after reviewing the MP0 draft. MP1.1/MP1.2 **read-only evidence identification and source-delta classification** is the only newly authorized next action. The live workflow trio still says successor implementation = NONE; formal reconciliation is pending. MP1.3 integrations, code changes, builds, UAT, Git commits/merges to main, deployment and cloud work are not authorized by this handoff.

**Next execution packet after review of MP1-001:** Codex MP1.2 read-only Stage056 manifest-equivalence and source-delta classification (no build/tests/merge). MP1.1 is completed with partial identity; formal phase gate remains pending.

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
| Stage056 + 058/061–065 UAT line | MP1-001 verified selected artifact hashes and SB63/SB64 EXE hashes; prior Owner results remain report-only | Current full Stage056 manifest equivalence, scratch/source provenance and main drift unresolved |
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

**M1:** source→build traceability and reviewed integration baseline; existing UAT success preserved. **MP1-001 verdict `MP1_001_PARTIAL_IDENTITY`**: selected hash chain valid for SB63/SB64 and Stage056 patch pins; current manifest equivalence not checked and UAT gate toggle differs from official source. MP1.1 evidence documented, M1 still OPEN; MP1.2 report cannot alone close M1.

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
| RISK-002 UAT source/build drift | Integration / release risk (HIGH) | MP1-001: Stage056 1,366-file manifest not compared to current tree; 167-file cumulative delta vs main; SB63/SB64 hashed and identity files matched; scratch Git IDs are not main commits | MP1.2 read-only complete classification, then separate Owner integration gate |
| RISK-006 UAT vs official shift-close gate | Integration / business-behavior risk (HIGH) | MP1-001: identity files report `SERVER_AUTHORITATIVE_CLOSE_ENABLED=true` for SB61–64 whereas official main/source closure records `false`; configuration/behavior parity unproven | MP1.2 identify exact config delta and isolate UAT-only semantics; no gate flip/deploy without Owner |
| GOV-003 stale workflow / plan gap | Process/governance debt (NOW) | live trio lacks later UAT line; no one consolidated product plan | MP0 + M0 reconciliation |
| UAT-004 native E2E | Release acceptance blocker | sale/restart/reconnect/stock/shift not signed off on a traceable candidate | MP2 |
| TEST-005 baseline shift tests | Verification readiness risk | Historical `shiftService.*` baseline failures on Node 26 (prior report) | Integration regression testing under MP1 |

**No blanket risk acceptance.** Anything risking duplicate/missing bills, unauthorized privileged action, inventory misstatement, or data loss requires mitigation or an explicit Owner gate before that candidate's release.

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
