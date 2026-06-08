# SKILL: Developer Self-Review Gate

> **Purpose**: Define the strict self-review checklist every Developer agent must output before requesting Codex review.

## 1. Fail-Fast Rule
If the Developer agent cannot definitively answer a self-review item, the Developer must **STOP and report** instead of guessing or proceeding to review.

## 2. Reviewer Rule
Codex (or any Reviewer agent) should treat missing or shallow self-review as a review failure or at least a Medium/High finding.

## 3. Definition of Done Before Codex
Developer cannot request Codex review unless:
- `git status` is understood and summarized.
- Changed files list matches the report explicitly.
- Forbidden files are confirmed untouched.
- Build/test commands are run, OR honestly marked not run/deferred.
- Reports do not overclaim success.
- Manifest matches implementation explicitly.
- Async/offline wording is truthful (no false success claims).
- Failure UI is visible to the user, not just console-only.
- Responsive evidence is captured or honestly deferred.
- If rules are touched, allowlists and value constraints are tested.
- If UI is touched, `SKILL-UI-IMPECCABLE.md` is applied (Flowbite preferred).
- If external skills are mentioned, vendor/`node_modules` skills are completely ignored.

## 4. Developer Self-Review Gate Template
Every Developer agent must produce this exact copyable section before asking for Codex review:

```markdown
### Developer Self-Review Before Codex

- [ ] **Scope implemented**: (Briefly describe what was done)
- [ ] **Files changed**: (List exact files changed)
- [ ] **Forbidden files untouched**: (Confirm files that were explicitly off-limits)
- [ ] **Business logic preserved**: (Confirm existing logic was not broken)
- [ ] **Offline-first / async-safe behavior**: (Confirm wording and pending states)
- [ ] **Anti-silent-failure behavior**: (Confirm errors show prominent visual alerts)
- [ ] **Flowbite / Impeccable.style compliance**: (Confirm Flowbite React usage)
- [ ] **Security/rules impact**: (Explain if rules were touched and tested)
- [ ] **Tests/build run**: (List commands run, e.g., `npm run build`)
- [ ] **Evidence captured**: (Link to outputs or summarize)
- [ ] **Report accuracy**: (Confirm `latest-report.md` matches reality)
- [ ] **Failure ledger items checked**: (Confirm no AI Failure Ledger mistakes repeated)
- [ ] **Deferred items**: (List explicitly deferred checks like responsive or manual states)
- [ ] **Known remaining risks**: (What could still go wrong)
- [ ] **Ready for Codex review**: Yes/No
```
