# Current Work Packet

## Phase

**7C-UI-06-FIX-ICON-RESTORE-AND-BUTTON-PURGE** — Restore Modal Header Icons and Purge Decorative Button Icons (emergency patch)

## Goal

Restore Modal Header Icons for contextual communication while removing decorative icons inside buttons so buttons become minimal, clean, and text-centered. **This emergency patch supersedes the prior UI-06 closure/commit path** (the old header-icon-purge package must NOT be committed). **AGY visual review is required before Codex.**

## CEO Emergency Directive

Prior UI-06 removed modal header icons; Codex passed app-level review, but before commit the CEO changed direction after Physical UAT. New decision: **(A) restore modal header icons** (clipboard on Z-Report, swap on Cash In/Out, lock on Close Shift, and any similar removed glyph) — they aid contextual communication; **(B) remove decorative icons inside buttons** (e.g. ✅ on บันทึก / ตกลง / เปิดกะ, 🔒 on ปิดกะ, 🖨️ on print) so button labels are text only.

## Implementation Directives (A / B / C)

**A — Restore Modal Header Icons.** Restore all modal header icons to the prior working visual design (don't over-style, don't redesign the header).

**B — Purge Decorative Button Icons.** Remove decorative symbols/icons inside buttons; leave button labels as text only — minimal, clean, intentional, premium.

**C — Alignment After Button Icon Removal.** Button text stays centered; clean proportions; no awkward left gap / missing-icon spacing / lopsided padding / broken flex; buttons still look clickable and balanced.

## Strict Protection Rules

Do NOT touch functional icons in Navigation, Category Tabs, Product Cards, Product Grid, or Main Navigation. Do NOT alter the Select Customer button, UI-05 macro layout, category sync, or focus recovery. Preserve button click handlers, disabled/loading states, variants, and keyboard behavior. No broad redesign.

## AGY Review Requirement (MANDATORY before Codex)

AGY must verify: header icons are restored and aid contextual communication (not noisy); button decorative icons are removed; button labels remain centered; buttons look minimal/clean/premium with no awkward empty spacing; the modals feel more usable/balanced than the prior icon-purged-header version; nav / category-tab / product-card / product-grid functional icons are untouched; and there is no focus / modal / scanner / keyboard / checkout regression and no broad redesign.

## Status

**In Progress** — Developer implementation complete; **awaiting AGY visual/UX review (before Codex)**.

---

## Scope

### Authorized implementation files (app)

- `src/components/pos/ShiftModals.tsx` + `ShiftModals.css` (Open/Close-Shift + Z-Report headers & buttons)
- `src/components/pos/CashTransactionModal.tsx` + `CashTransactionModal.css` (Cash In/Out header & buttons)
- Only the four prior-UI-06 modal component files / related modal CSS — do NOT broaden. (`POSPage.tsx/.css` NOT touched — these modals do not live there. No button-alignment CSS change was needed.)

### Authorized workflow / report files

- `docs/agent-workflow/STATE.md`
- `docs/agent-workflow/CURRENT_PACKET.md`
- `docs/agent-workflow/NEXT_ACTION.md`
- `docs/reports/latest-developer-report.md`

### Forbidden Files / Areas

- **Functional icons** in Navigation, Category Tabs, Product Cards, Product Grid, Main Navigation — do NOT touch
- **Select Customer button styling / dashed border** — do NOT touch
- `useCart.ts`, `useCart.contract.test.ts`, `cartUtils.ts`, cart math
- Checkout / payment business logic, stock matrix, seed data
- Toast files; Firebase / functions / rules; Android / Capacitor; `.claude/`
- Modal open/close, focus-trap, submit/cancel/disabled/loading behavior; button click handlers
- UI-05 macro layout; category sync; focus recovery
- No new scripts, no new dependencies; no UI-07 work; do not commit the old UI-06 header-purge package

### Preservation note

Header icons were RESTORED to the prior working design (the 4 modal files were reverted to HEAD, so the headers are byte-identical to the committed UI-05 baseline). Only decorative button emoji were removed (✅ / 🔒 / 🖨️ → text). Button handlers, disabled/loading states, variants, and keyboard behavior are unchanged. The category listener, `visibleCategories`, `.pos-cat-bar` scroll, focus-recovery handlers, the Seamless Split (`.pos-cart`), and all functional icons remain untouched.

---

## Role Sequence

```
Developer Agent              — ROLE FILE: docs/ai-roles/developer.md
  → Senior QA & UX Lead/AGY  — ROLE FILE: docs/ai-roles/ux-lead.md
    → Codex Reviewer         — ROLE FILE: docs/ai-roles/reviewer.md
      → Tech Lead / CEO      — ROLE FILE: docs/ai-roles/tech-lead.md
```

**AGY:** **REQUIRED for this phase (before Codex)** — this phase includes visual UI polish, so AGY visual/UX validation gates the handoff to Codex.
AGY ROLE FILE: `docs/ai-roles/ux-lead.md`

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
2. **Developer** updates `docs/agent-workflow/NEXT_ACTION.md` to route to **AGY first** (visual review), not Codex.
3. **If unauthorized files are changed** → STOP and report.
4. **If tests fail** → STOP and report.
5. **AGY reviews UX/visuals first** (Impeccable Style + zero layout shift + no visual regression).
6. **If AGY FAIL** → return to Developer / Principal Engineer Reviewer for remediation.
7. **If AGY PASS / PASS WITH NOTES** → route to **Codex Reviewer** for code/scope/keyboard review.
8. **If Codex FAIL** → return to Principal Engineer Reviewer / Workflow Coordinator.
9. **If Codex PASS / PASS WITH NOTES** → route to Principal Engineer Reviewer / Workflow Coordinator for Tech Lead closure memo.
10. **No commit** until Tech Lead / CEO authorizes the exact staging and commit commands.

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
