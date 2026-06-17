# Current Work Packet

## Phase

**7C-UI-02-SEARCH-BARCODE** — Search & Barcode UI Refactor

## Goal

Refactor the Product Search and Action Bar to meet the **Impeccable Style** standard while preserving all barcode/search keyboard behavior. Standardize the buttons next to the search box (Sort, Refresh, Select) so they are visually consistent, calm, and uncluttered, and give the scan box a soft on-brand focus ring.

## Status

**In Progress** — Developer implementation complete; awaiting AGY / Senior QA & UX Lead review.

---

## Scope

### Authorized implementation files

- `src/pages/POSPage.tsx` — **top bar / Search section only**
- `src/pages/POSPage.css`

### Authorized workflow / report files

- `docs/agent-workflow/STATE.md`
- `docs/agent-workflow/CURRENT_PACKET.md`
- `docs/agent-workflow/NEXT_ACTION.md`
- `docs/reports/latest-developer-report.md`

### Forbidden Files / Areas

- `useCart.ts`, `useCart.contract.test.ts`, `cartUtils.ts`
- Checkout / payment logic, stock matrix, seed data
- Toast files
- UI-01 components (must not regress the committed bump-flash behavior)
- Firebase / functions / rules
- Android / Capacitor artifacts
- `.claude/`
- No new scripts, no new dependencies
- No cart refactor, no UI-03+ work

---

## Role Sequence

```
Developer
  → AGY / Senior QA & UX Lead
    → Codex Reviewer
      → Tech Lead / CEO
```

## Decision Rules

1. **Developer** completes implementation and writes `docs/reports/latest-developer-report.md`.
2. **Developer** updates `docs/agent-workflow/NEXT_ACTION.md` to route to AGY.
3. **If unauthorized files are changed** → STOP and report (return to Principal Engineer Reviewer / Workflow Coordinator).
4. **AGY reviews UX first** because this is visual/UI polish.
5. **If AGY FAIL** → return to Principal Engineer Reviewer / Workflow Coordinator.
6. **If AGY PASS / PASS WITH NOTES** → route to Codex for code/scope/keyboard review.
7. **If Codex FAIL** → return to Principal Engineer Reviewer / Workflow Coordinator.
8. **No commit** until Tech Lead / CEO authorizes the exact staging and commit commands.

---

## Report Requirements

Every agent must produce a report in its corresponding `docs/reports/latest-*-report.md` file. Every report must end with a STATE CARD block.

## STATE CARD Requirement

Every report must end with this exact block, filled in:

```
STATE CARD
Phase:
Current owner:
Verdict:
Files changed:
Tests/checks:
Staged:
Committed:
Required fixes:
Next owner:
Next action:
Stop condition:
```

---

## Fallback

If this workflow creates friction, revert to the previous manual routing process. The old workflow remains valid.
