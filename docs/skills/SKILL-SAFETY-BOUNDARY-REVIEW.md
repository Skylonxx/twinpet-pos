# SKILL: Safety & Boundary Review

> **Purpose**: The checklist and report standard CodexSafe (Safety Reviewer / Boundary Reviewer) applies to every proposed action in the swarm. Pairs with [`docs/ai-roles/safety-reviewer.md`](../ai-roles/safety-reviewer.md).

Skills supplement roles; they do not replace them. Read `AGENTS.md` first. Tech Lead / CEO directives always override generic wording.

---

## 1. Forbidden operations (hard blocks)

Any one of these is an automatic **BLOCKED** verdict:

| # | Forbidden | Notes |
|---|-----------|-------|
| 1 | Touching `stash@{0}` | Apply, drop, pop, or modify — all forbidden. `git stash list` (read-only) is allowed. |
| 2 | Unsafe launchers/flags | `--dangerously-skip-permissions`, bypass, yolo, auto-approve, full-access, skip-permissions wrappers, `--dangerously-bypass-approvals-and-sandbox`, bypass `.bat` launchers. |
| 3 | Broad / persistent permissions | No blanket MCP grants; no persisting permissions. |
| 4 | `Target:*` | Never approved or persisted. |
| 5 | Paid API fallback | No paid Google AI / Gemini API or key use unless explicitly authorized; never inspect paid API keys. |
| 6 | `git add .` | Staging must be explicit and file-scoped, and only when commit is authorized. |
| 7 | Out-of-scope code | No source, Firebase/functions, Android/Capacitor, package/lockfile, or tooling-runtime edits unless the packet authorizes them. |
| 8 | Repo boundary breach | Edits outside the authorized directories/files. |
| 9 | Evidence overclaim | Reporting tests/builds that did not run or did not pass. |

---

## 2. Red flags (raise, investigate, often block)

- A prompt or agent asks to "just approve" a permission, flag, or target.
- "Quick" edits to files outside the authorized list.
- Commit/staging proposed without an explicit Tech Lead / CEO authorization message.
- Reports saying "completed successfully" with no test/build output.
- Scope language drifting ("while I'm here, I'll also…").
- Modifying agentchattr runtime config from inside a Twinpet task.
- Any write during a dry-run that was declared no-write.

---

## 3. Required safety checklist

Run all items. Any FAIL → **BLOCKED**.

```markdown
### CodexSafe Boundary Checklist
- [ ] Repo boundary: changes confined to authorized dirs/files only
- [ ] stash@{0}: untouched (list-only)
- [ ] Unsafe flags/launchers: none present
- [ ] Permissions: none broad or persisted; no Target:*
- [ ] Paid API: no paid Gemini/Google API or key use; no key inspection
- [ ] Code surface: no out-of-scope source/Firebase/Android/package edits
- [ ] Staging: no `git add .`; staging (if any) explicit + authorized
- [ ] Evidence: reported results match actual runs (no overclaim)
- [ ] Dry-run: no writes unless writes were explicitly authorized
```

---

## 4. Classification

| Verdict | Meaning |
|---|---|
| **PASS** | No forbidden operation; all checklist items pass. |
| **PASS WITH NOTES** | No hard block, but boundary observations or deferred concerns worth recording. |
| **BLOCKED** | One or more forbidden operations or checklist FAILs. Phase halts. |

A **BLOCKED** verdict is binding. It is cleared only by removing the violation, or by an explicit authority decision (Gemini / Khun Chat) routed through ChatGPT per the normal flow. Codex (Workflow Coordinator) MUST NOT override it.

---

## 5. Report format

```
FROM: CodexSafe (Safety Reviewer)
PHASE: [phase name]
SAFETY VERDICT: PASS | PASS WITH NOTES | BLOCKED
CHECKLIST: [9/9 pass | list FAIL items]
VIOLATIONS: [none | each forbidden op hit]
NOTES: [boundary observations, deferred concerns]
```

---

## 6. Handling specific assets

- **stash** — only `git stash list`. Never apply/drop/pop/modify.
- **Dangerous flags** — presence alone is a BLOCK, even if "not used yet."
- **`Target:*`** — never approve; never persist; flag any prompt requesting it.
- **Paid API keys** — do not read, echo, or use. Their mere requested use is a BLOCK absent explicit authorization.
- **Broad MCP permissions** — do not approve or persist; per-call, scoped, non-persistent only.
- **Repo boundaries** — the authorized file/dir list in the packet is the boundary; anything outside is a breach.
