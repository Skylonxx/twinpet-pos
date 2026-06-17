# Next Action

## Current State

Developer Agent has completed the WORKFLOW-FILE-HANDOFF-INIT setup. Files are created but **not staged and not committed**.

## What Happens Next

1. **Human operator** reviews the Developer report below.
2. **Human operator** routes the report to **Principal Engineer Reviewer / Workflow Coordinator**.
3. **Principal Engineer Reviewer** confirms the package is clean (docs-only, no forbidden files touched).
4. If clean, **Principal Engineer Reviewer** authorizes Codex docs-only review.
5. Codex reviews and produces verdict in `docs/reports/latest-codex-review.md`.
6. Results return to **Principal Engineer Reviewer** for Tech Lead closure memo.
7. **Tech Lead / CEO** issues exact staging and commit commands.
8. **Commit Agent** executes the authorized commit.

---

## Copy-Paste Instructions for Human Operator

### Step 1 — Send to Principal Engineer Reviewer

Paste the following to ChatGPT / Principal Engineer Reviewer:

```
ROLE: Principal Engineer Reviewer / Workflow Coordinator
PHASE: WORKFLOW-FILE-HANDOFF-INIT
INPUT: Developer Agent has completed docs-only setup.

Please review the Developer report in docs/reports/latest-developer-report.md
and the created files under docs/agent-workflow/ and docs/reports/.

Confirm:
- Only authorized docs files were created
- No app code was touched
- Content is correct and complete
- Package is ready for Codex docs-only review

If clean, authorize Codex review.
If not clean, specify required fixes and return to Developer.
```

### Step 2 — Send to Codex (only after Principal Engineer Reviewer confirms)

Do **not** send to Codex until Principal Engineer Reviewer confirms the package is clean.

```
ROLE: Codex Reviewer
PHASE: WORKFLOW-FILE-HANDOFF-INIT
SCOPE: docs-only review

Review all files under docs/agent-workflow/ and docs/reports/.
Verify docs-only scope, correctness, completeness, and process quality.
Produce verdict in docs/reports/latest-codex-review.md format.
AGY review is NOT required for this phase.
```

### Step 3 — Route Codex result back to Principal Engineer Reviewer

Paste Codex verdict back to Principal Engineer Reviewer for Tech Lead closure memo.

---

## Important Reminders

- Do **not** stage or commit until Tech Lead / CEO authorizes exact commands.
- UI-02 remains **unauthorized**.
- Old manual workflow remains available as fallback.
- `stash@{0}` is pre-existing unrelated WIP — do not touch.
