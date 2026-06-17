# Current Work Packet

## Phase

**7C-UI-02-HOTFIX-FOCUS** — Aggressive Scanner Focus Hotfix

## Goal

Ensure the barcode/search input regains focus immediately after any standard grid / top-bar / category / action interaction that should preserve scanner-first cashier flow — without disturbing modal-owned focus (UOM / Payment) or any cart/business behavior.

## Status

**In Progress** — Developer implementation complete; awaiting Codex Reviewer.

---

## Scope

### Authorized implementation files

- `src/pages/POSPage.tsx`
- `src/pages/POSPage.keyboard-contract.test.ts` (focus-contract tests)

### Authorized workflow / report files

- `docs/agent-workflow/STATE.md`
- `docs/agent-workflow/CURRENT_PACKET.md`
- `docs/agent-workflow/NEXT_ACTION.md`
- `docs/reports/latest-developer-report.md`

### Forbidden Files / Areas

- `src/pages/POSPage.css` (no style change this phase — CSS untouched)
- `useCart.ts`, `useCart.contract.test.ts`, `cartUtils.ts`, cart math
- Checkout / payment logic, stock matrix, seed data
- Toast files
- Firebase / functions / rules
- Android / Capacitor artifacts
- `.claude/`
- No new scripts, no new dependencies
- No UI-03+ work

---

## Role Sequence

```
Developer Agent          — ROLE FILE: docs/ai-roles/developer.md
  → Codex Reviewer       — ROLE FILE: docs/ai-roles/reviewer.md
    → Tech Lead / CEO    — ROLE FILE: docs/ai-roles/tech-lead.md
```

**AGY:** Bypassed for this phase — this is a behavioral focus hotfix, not visual UI polish. (May be requested explicitly by Tech Lead/CEO or Principal Engineer.)
AGY ROLE FILE (if needed): `docs/ai-roles/ux-lead.md`

### Required Handoff Header Format

Every handoff prompt must include these exact lines:

```
TO:
MODEL:
REASONING:
ROLE:
ROLE FILE:
MODE:
```

## Decision Rules

1. **Developer** completes implementation and writes `docs/reports/latest-developer-report.md`.
2. **Developer** updates `docs/agent-workflow/NEXT_ACTION.md` to route to Codex.
3. **If unauthorized files are changed** → STOP and report.
4. **If tests fail** → STOP and report.
5. **If Codex FAIL** → return to Principal Engineer Reviewer / Workflow Coordinator.
6. **If Codex PASS / PASS WITH NOTES** → route to Principal Engineer Reviewer / Workflow Coordinator for Tech Lead closure memo.
7. **No commit** until Tech Lead / CEO authorizes the exact staging and commit commands.

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
