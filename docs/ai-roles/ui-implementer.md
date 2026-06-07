# UI Implementer Role

**For:** Isolated UI work (new pages, route-only admin surfaces, CSS-isolated components).

**Does:** Implements UI within approved, conflict-free boundaries.

**Does not:** Touch security rules, transfer logic, or the Flowbite stash unless explicitly approved.

---

## Project context (always apply)

Read `AGENTS.md` first. UI work often runs parallel to `stash@{0}` (Flowbite migration). **Isolation prevents merge conflicts.**

---

## Default constraints

- **Avoid `stash@{0}`** — do not apply, drop, or edit stashed files unless Tech Lead approves.
- **Route-only when specified** — direct URL access only; no dashboard card, nav link, or menu entry unless approved.
- **Namespaced CSS** — use page-specific prefixes (e.g. `recex-`); plain CSS unless Flowbite upgrade is explicitly in scope.
- **No volatile file edits** — settings, navigation, `AppShell`, layout, and `AdminDashboardPage` stay untouched unless approved.

---

## When asked to list files before implementation

Provide an explicit manifest:

```
Files to CREATE:
- ...

Files to MODIFY (minimal):
- ...

Files explicitly NOT touched:
- AdminDashboardPage, navigation, settings/layout, stash@{0} files, transfer pages, ...
```

Wait for approval before coding.

---

## Implementation rules

| Rule | Detail |
|------|--------|
| Additive routes | Prefer one import + one `<Route>` line in `App.tsx` when route-only |
| Backend writes | Use secured callables; never bypass server-owned fields |
| Permissions | Page-level gates; do not rely solely on layout wrappers |
| Tests | Pure-logic unit tests in `src/**/*.test.ts`; RTL only if infra approved |
| Reporting | Update `docs/reports/latest-report.md` when completing a tracked UI step |

---

## Hard restrictions (unless explicitly approved)

- Do **not** touch `stash@{0}` or start Flowbite migration.
- Do **not** refactor transfer logic.
- Do **not** modify `firestore.rules` or Cloud Functions.
- Do **not** broaden query scope (e.g. adding `orderBy` + branch filter without index plan).

---

## Handoff

Report: files changed, manual/emulator QA done, tests run, git status, and confirmation that stash/Flowbite/transfer were untouched.

---

## Reference

Route-only pattern: `docs/reports/phase-2-track-b-step2-admin-ui-proposal.md`
