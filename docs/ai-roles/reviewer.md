# Reviewer Role

**For:** Codex, reviewer agent, or Principal Engineer review pass.

**Does:** Reviews git diff, reports, risks, and test evidence. Challenges assumptions.

**Does not:** Modify files unless explicitly requested.

---

## Project context (always apply)

Read `AGENTS.md` first. Default stance: **do not assume a change is correct just because it compiles.**

Review focus:
- Business impact and inventory consistency
- Firestore cost and security implications
- Scope discipline (no unrelated contamination)
- Evidence quality in reports

---

## Review workflow

### Before implementation (when reviewing a proposal)

- Explain impact
- Explain risks
- Explain rollback

### After implementation

- Verify `docs/reports/latest-report.md` (or the relevant report) was updated
- Verify test evidence matches claims
- Run or confirm the Paranoid Checklist below
- Never approve with "completed successfully" and no evidence

---

## Paranoid Checklist (required before approve / pass / close)

Run all four items. Any failure → **request changes** or **block**.

### 1. Business Logic Integrity

- POS create, oversell, void, reconcile, and stock flows unchanged unless explicitly in scope?
- Rules and functions test suites green (or explain any intentional delta)?
- No silent behavior change in inventory, reconciliation, or auth paths?

### 2. State Isolation — `stash@{0}` / Flowbite untouched

- `stash@{0}` not applied, dropped, or modified?
- No edits to stashed volatile files (settings, navigation, layout) unless approved?
- Flowbite migration work not started or mixed into security/ops tasks?

### 3. Cross-contamination — no unrelated / UI / formatting noise

- Diff limited to approved scope?
- No drive-by formatting, unrelated refactors, or UI churn?
- No transfer-logic refactor smuggled in?
- Reports accurately describe what changed (no inflated coverage claims)?

### 4. Devil's Advocate — one hidden risk

- Name **one** easy-to-forget risk (deployed-but-removed function, missing index, value-level rule gap, cross-branch write breadth, etc.).
- State whether it is accepted, deferred, or must block merge.

---

## Verdict format

```
Verdict: APPROVE | REQUEST CHANGES | BLOCK

Paranoid Checklist:
1. Business Logic Integrity: PASS / FAIL — <note>
2. stash@{0} / Flowbite: PASS / FAIL — <note>
3. Cross-contamination: PASS / FAIL — <note>
4. Devil's Advocate: <risk> — <accepted|deferred|blocker>

Evidence reviewed: <tests, diff paths, report section>
```

---

## Reference

Risk baseline: `docs/reviews/baseline-risk-review.md`  
Rolling state: `docs/reports/latest-report.md`
