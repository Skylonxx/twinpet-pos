# Next Action

## Current State

Developer Agent has completed the **7C-UI-02-SEARCH-BARCODE** implementation. Changes are **not staged and not committed**. The work is now routed to **AGY / Senior QA & UX Lead** for UX review (visual/UI polish is reviewed by AGY first).

## What Happens Next

1. **Human operator** reads the Developer report at `docs/reports/latest-developer-report.md`.
2. **Human operator** sends AGY the current packet (`docs/agent-workflow/CURRENT_PACKET.md`), the Developer report, and the **current diff**.
3. **AGY / Senior QA & UX Lead** reviews the UX (Impeccable Style, calm/consistent toolbar, scanner-first flow, no clutter, no regression).
4. If **AGY FAIL** → return to Principal Engineer Reviewer / Workflow Coordinator for remediation.
5. If **AGY PASS / PASS WITH NOTES** → route to **Codex Reviewer** for code/scope/keyboard-contract review.
6. If **Codex FAIL** → return to Principal Engineer Reviewer / Workflow Coordinator.
7. If **Codex PASS / PASS WITH NOTES** → route to **Tech Lead / CEO** for closure + exact staging/commit commands.

---

## Copy-Paste Instructions for Human Operator

### Step 1 — Send to AGY / Senior QA & UX Lead (DO THIS NEXT)

Paste the following to AGY:

```
ROLE: AGY / Senior QA & UX Lead
PHASE: 7C-UI-02-SEARCH-BARCODE
INPUT: Developer implementation complete (CSS-only top-bar / search & action-bar refactor).

Please review the UX first (this is visual/UI polish):
- docs/agent-workflow/CURRENT_PACKET.md (active packet)
- docs/reports/latest-developer-report.md (developer report)
- the current working-tree diff (git diff)

Confirm:
- Impeccable Style achieved (calm, rounded, soft focus ring, consistent Sort/Refresh/Select)
- No cramped/overwhelming button cluster, no harsh colors, no clutter
- Search input remains obvious, fast, keyboard-first; critical cashier controls still discoverable
- No UI-01 bump-flash regression; no layout shift
- Scope respected (top-bar / search & POSPage.css only)

Verdict: PASS / PASS WITH NOTES / FAIL, written to docs/reports/latest-agy-review.md.
```

### Step 2 — Send to Codex (ONLY after AGY returns PASS / PASS WITH NOTES)

Do **not** send to Codex until AGY confirms the UX.

```
ROLE: Codex Reviewer
PHASE: 7C-UI-02-SEARCH-BARCODE
SCOPE: code / scope / keyboard-contract review

Review src/pages/POSPage.css (and confirm POSPage.tsx top-bar unchanged), verify:
- Only authorized files changed; no forbidden areas touched
- Search / barcode / Ctrl+F / auto-focus / F12 / modal-focus contracts preserved
- tsc clean; POSPage.keyboard-contract.test.ts + full vitest green
Produce verdict in docs/reports/latest-codex-review.md.
```

### Step 3 — Route Codex result back to Tech Lead / CEO

Paste the Codex verdict to Tech Lead / CEO for a closure memo and exact staging/commit commands.

---

## Important Reminders

- Do **not** stage or commit until Tech Lead / CEO authorizes exact commands.
- Do **not** send to Codex yet — AGY UX review comes first.
- Do **not** start UI-03 or any other phase.
- `stash@{0}` is pre-existing unrelated WIP — do not touch.
- Old manual workflow remains available as fallback.
