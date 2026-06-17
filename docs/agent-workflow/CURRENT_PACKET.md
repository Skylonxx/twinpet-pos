# Current Work Packet

## Phase

**WORKFLOW-FILE-HANDOFF-INIT** — Initialize file-based agent handoff workflow

## Goal

Create standardized docs-only files so agents can coordinate through the repo while preserving all quality gates. This is structured human handoff, not automation.

## Status

Active — Developer Agent completing setup.

---

## Authorized Files

Only these files may be created or modified:

- `docs/agent-workflow/STATE.md`
- `docs/agent-workflow/CURRENT_PACKET.md`
- `docs/agent-workflow/NEXT_ACTION.md`
- `docs/reports/latest-developer-report.md`
- `docs/reports/latest-codex-review.md`
- `docs/reports/latest-agy-review.md`
- `docs/reports/latest-techlead-decision.md`

## Forbidden Files / Areas

All app code, tests, config, and infrastructure are off-limits. This includes but is not limited to:

- `src/` (all files)
- `useCart.ts`, `cartUtils.ts`, toast files, checkout/payment
- Firebase / functions / rules
- Android / Capacitor artifacts
- `.claude/`
- Seed data, stock matrix
- No automation or deploy scripts

---

## Role Sequence

```
Tech Lead / CEO
  → Principal Engineer Reviewer / Workflow Coordinator
    → Developer Agent
      → Codex Reviewer
        → Principal Engineer Reviewer
          → Tech Lead / CEO
            → Commit Agent
```

## Decision Rules

1. **Developer changes unauthorized files** → STOP. Return to Principal Engineer Reviewer immediately.
2. **Diff is docs-only and clean** → Proceed to Codex review.
3. **Codex verdict: FAIL** → Return to Principal Engineer Reviewer for remediation.
4. **Codex verdict: PASS or PASS WITH NOTES** → Return to Principal Engineer Reviewer for Tech Lead closure memo.
5. **AGY review** → Not required for this phase (docs only, no UI). Tech Lead may request if desired.
6. **Commit** → Not authorized until Tech Lead / CEO provides exact staging and commit commands.

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
