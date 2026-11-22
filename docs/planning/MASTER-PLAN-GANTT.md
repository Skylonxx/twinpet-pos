# Twinpet POS — Master Plan Dependencies (MP0 DRAFT)

**Prepared / updated:** 2026-11-22. Candidate N-001 remains BLOCKED_DESIGN_CONFLICT; Owner accepted Policy A and approved Candidate N-002 source-only work in the existing isolated clone. Claude implemented two-file source-only changes; latest independent Codex STATIC_REVIEW_FINDINGS requires a consolidated startup-integrity Owner design decision. Cargo/build/tests NOT_RUN and >=10 GiB build gate unchanged. Main/Cloud/merge/release still forbidden.

```mermaid
flowchart LR
    P["MP0: Rebaseline existing plan"] --> M0{"M0: Product Owner / Gemini decision"}
    M0 -->|Not yet| HOLD["HOLD: Planning only"]
    M0 -->|Approved| P1["MP1: Preserve UAT + source reconciliation"]
    P1 --> M1{"M1: Source identity + independent review"}
    M1 -->|PASS| P2["MP2: Native Offline E2E UAT"]
    M1 -->|BLOCKED| FIX1["Owner-scoped fix; no automatic expansion"]
    FIX1 --> M1
    P2 --> M2{"M2: Cashier operational acceptance"}
    M2 -->|PASS| P3["MP3: Release Readiness / Upgrade"]
    M2 -->|BLOCKED| FIX2["Owner-scoped remediation"]
    FIX2 --> M2
    P3 --> M3{"M3: Owner GO / NO-GO"}
    M3 -->|No-Go| HOLD
    M3 -->|Go + separate authorization| R["Production rollout packet"]
    T["U1/B1-R evidence retained"] -. "Reopen only if relevant to candidate" .-> M2
    F["Return/Refund / Android / EV-2"] -. "Future, separately authorized" .-> HOLD
```

## MP0 tentative planning checkpoint (not deadline)
```mermaid
gantt
    title Twinpet POS — MP0 planning proposal ONLY
    dateFormat YYYY-MM-DD
    axisFormat %d %b
    section MP0
    Reconcile workflow and evidence :mp01, 2026-11-23, 3d
    Identify critical path and risks :mp02, after mp01, 1d
    Owner planning review (proposed) :milestone, m0, 2026-11-27, 0d
```

| Gate | Acceptance evidence | Current status |
|---|---|---|
| MP0/M0 | Approved Goal, phase, priorities, roles, lock list, authority reconciliation | SCOPED_READ_ONLY; FORMAL_PHASE_PENDING |
| MP1/M1 | UAT baseline and commit/build identity, reviewed integration delta | DEPS-PLAN-001 read-only Codex inspection returned READY_FOR_OWNER_RISK_DECISION: 1,088 npm locked official-host entries, 512 locked Cargo registry packages; no actual download/install/build. Explicit Owner risk choice A bounded official-registry provisioning-only, B enforceable egress sandbox first, C HOLD; M1 OPEN, MP1.3 LOCKED |
| MP2/M2 | Safe native offline E2E + cashier critical path on controlled build | LOCKED |
| MP3/M3 | Installer/upgrade proof and explicit Owner decision | LOCKED |

No MP1–MP3 delivery dates until formal successor phase decision. UAT cleanup finished at its bounded safe scope; N-002 **was attempted but BLOCKED at disk preflight** with no clone/code/tests, and later observed capacity remains under its 10 GiB threshold. No auto-retry/merge/Cloud. This does not close M1 or authorise other implementation phases. An approved evidence-only MP1.1/1.2 task does not authorize implementation. Todoist mirrors this proposal, not vice versa.
