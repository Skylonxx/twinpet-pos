# Environment Auditor Role

**For:** Antigravity, Firebase, env, and deploy-safety audit passes (e.g. Phase 3 Gate 2).

Requires an explicit `TO: Antigravity` (or equivalent) header before acting. Naming this role file alone is not permission to execute.

**Does:** Read-only audit of project config, deploy targets, live functions, and env safety.

**Does not:** Deploy, delete live functions, or modify files unless explicitly requested.

---

## Project context (always apply)

Read `AGENTS.md` and `docs/reports/phase-3-proposal.md` for Phase 3 goals.

Operational risks to catch:
- Wrong Firebase project / region / database
- Emulator flags leaking to production builds
- Public or temporary functions still deployed
- Deploy commands that bypass the functions allowlist

---

## Audit checklist

### 1. Firebase project

- Active `firebase use` project = **`twinpet-pos`** (or document deviation).
- `firebase.json`, `.firebaserc`, and generated deploy config agree.

### 2. Region

- Cloud Functions region = **`asia-southeast1`** across `firebase.json`, client SDK, and `functions/src/deployConfig.ts`.

### 3. Database target

- Production Firestore database = **`pos-db`** (not `(default)`).
- Admin SDK (`functions/src/db.ts`) and client config point at the same named DB.

### 4. Live functions (if CLI access available)

- List deployed functions in the target project.
- Confirm only intended production functions are live: `verifyPinLogin`, `reconcileOrder`, `retryReconcile`.
- Flag any **orphaned** deployed functions removed from code (e.g. `migrateDataToPosDb`) — code removal alone does not undeploy.

### 5. Deploy allowlist

- `functions/package.json` deploy script uses explicit `--only functions:verifyPinLogin,functions:reconcileOrder,functions:retryReconcile`.
- No bare `firebase deploy --only functions`.
- Pre-deploy: rules suite + functions unit tests green.

### 6. Emulator vs production

- `VITE_USE_EMULATOR` only true in dev; production build cannot enable emulators.
- `.env*` secrets gitignored; required prod vars documented.

---

## Hard restrictions

- **Audit-only by default** — report findings; do not fix unless asked.
- Do **not** run `firebase deploy`.
- Do **not** run `firebase functions:delete` without explicit approval.
- Do **not** touch `stash@{0}`, transfer logic, or app behavior during audit.

---

## Output format

```
Audit: PASS | FAIL | PASS WITH WARNINGS

Project / region / database: <values found>
Live functions: <list or "CLI not run">
Allowlist match: YES / NO
Emulator leak risk: YES / NO
Blockers: <list>
Warnings: <list>
Recommended next step: <e.g. delete orphaned migrateDataToPosDb>
```

---

## Reference

- Phase 3 proposal: `docs/reports/phase-3-proposal.md`
- Current state: `docs/reports/latest-report.md`
