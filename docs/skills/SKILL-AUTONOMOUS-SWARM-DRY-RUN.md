# SKILL: Autonomous Swarm Dry-Run

> **Purpose**: Define how to run a **simulated** multi-agent pass before any real autonomous swarm operation. A dry-run rehearses coordination, role responses, and stop conditions **without changing the repo**.

Skills supplement roles; they do not replace them. Read `AGENTS.md` first. This skill does **not** declare the autonomous swarm production-ready — it is a rehearsal harness only.

---

## 1. Core rule: no-write by default

- A dry-run is **no-write by default**: no file edits, no staging, no commit, no deploy, no tooling-runtime changes.
- File edits are allowed **only** if ChatGPT (and, where authority is required, Gemini / Khun Chat) explicitly authorized writes for that run, naming the exact files.
- If no write authorization is stated, every role responds in **simulation** — describing what it *would* do, not doing it.

---

## 2. Roles and exact response headings

The coordinator (Codex) drives turns in this order. Each role MUST use its exact heading.

```
### Claude — Developer (dry-run)
PLAN: [what would be implemented, files that would change]
SIMULATED DIFF: [described, not applied]
TESTS THAT WOULD RUN: [commands]
SELF-REVIEW: [per SKILL-DEVELOPER-SELF-REVIEW.md, simulated]
```

```
### CodexSafe — Safety Reviewer (dry-run)
SAFETY VERDICT: PASS | PASS WITH NOTES | BLOCKED
CHECKLIST: [per SKILL-SAFETY-BOUNDARY-REVIEW.md]
VIOLATIONS: [none | list]
```

```
### AGY — UI/UX Reviewer (dry-run)
UX VERDICT: PASS | REJECT
IMPECCABLE.STYLE: [per SKILL-UI-IMPECCABLE.md — layout shift, feedback, tokens, cognitive load]
NOTES: [visual concerns]
```

```
### Codex — Workflow Coordinator (dry-run)
COLLATED VERDICT: [PASS / PASS WITH NOTES / BLOCKED / NEEDS DECISION]
ESCALATION NEEDED: [none | architecture | product | phase | commit]
NEXT TURN OR STOP: [...]
```

---

## 3. Loop / drift stop conditions

Codex MUST stop the dry-run and report up when any occurs:

- Same proposal/message repeats without new information (≈2 cycles).
- Scope drifts beyond the authorized packet.
- Any role requests an unsafe flag, broad permission, `Target:*`, or paid-API fallback.
- CodexSafe returns **BLOCKED**.
- A required response heading or field is missing and cannot be supplied.
- A write is attempted in a no-write dry-run.

---

## 4. Command / report / escalation path

```
ChatGPT (System Architect, outside)
   │  issues dry-run packet (phase, scope, no-write/authorized-files)
   ▼
Codex (Workflow Coordinator, inside)
   │  sequences turns: Claude → CodexSafe → AGY
   │  collates results
   ▼
Codex → ChatGPT  (collated summary)
   │
ChatGPT fixes prompt/workflow directly, OR
ChatGPT escalates → Gemini (Tech Lead) → Khun Chat (CEO / Product Owner)
   when authority / product / phase / commit / closure is needed
```

---

## 5. When to stop and ask ChatGPT

Codex stops the swarm and hands back to ChatGPT when:

- The dry-run hits a loop/drift stop condition (§3).
- The simulation surfaces a workflow, prompt, or report-format defect.
- A role disagrees and the resolution is procedural (not authority-bound).

## 6. When ChatGPT must escalate to Gemini

ChatGPT escalates (and Gemini may escalate to Khun Chat) when the dry-run reveals a need for:

- Architecture or design decision with production impact.
- Product scope / business-rule decision.
- Phase-gate go/no-go.
- Commit / staging authorization.
- Final result closure.

---

## 7. Dry-run readiness note

A successful dry-run rehearses coordination only. It does **not** authorize real autonomous operation, real writes, or commits. Promotion from dry-run to live operation requires explicit Gemini / Khun Chat authorization through the standard Twinpet flow.

Related: [`SKILL-SAFETY-BOUNDARY-REVIEW.md`](./SKILL-SAFETY-BOUNDARY-REVIEW.md), [`SKILL-DEVELOPER-SELF-REVIEW.md`](./SKILL-DEVELOPER-SELF-REVIEW.md), [`SKILL-UI-IMPECCABLE.md`](./SKILL-UI-IMPECCABLE.md), [`docs/agent-workflow/AUTHORITY_MATRIX.md`](../agent-workflow/AUTHORITY_MATRIX.md).
