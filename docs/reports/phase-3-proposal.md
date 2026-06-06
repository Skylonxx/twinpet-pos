# Phase 3 — Production Readiness & Environment Safety (PROPOSAL ONLY)

**Status:** Proposal. **Not implemented.** Reviewer recommendation: do Phase 3 *before* broader feature work.

**Goal:** Ensure the app cannot accidentally use emulator settings in production, cannot deploy to the wrong Firebase project/database/region, and has clear release/deploy safety checks + monitoring for reconciliation exceptions.

**Why now:** Phase 2 closed the *client-write spoofing / security-hardening* gaps for `productStocks`, `stockLots`, and the reconciliation exception flow; the next highest risk is *operational* — a wrong-project deploy, an emulator flag leaking to prod, a leftover public migration function, or a rules/functions change shipped without verification.

## PRODUCTION DEPLOY BLOCKER (must resolve in Phase 3)
> **`functions/src/index.ts` currently exports `migrateDataToPosDb` as a PUBLIC (`invoker: 'public'`) temporary one-shot migration function** (it copies the `(default)` database into the named `pos-db`, and its own header says "⚠️ DELETE THIS FUNCTION AFTER THE MIGRATION COMPLETES").
>
> **Phase 3 MUST remove, disable, or exclude `migrateDataToPosDb` before ANY production `functions` deploy.** A public endpoint that bulk-copies databases is a data-integrity/abuse risk if left deployed. **Treat this as a hard production deploy blocker until resolved** — no prod functions deploy may proceed while it is still exported/public. (Not touched in this docs amendment; flagged for Phase 3 execution.)

## Scope (proposed)

1. **Emulator vs production audit.** Verify `USE_EMULATOR` (`import.meta.env.DEV && VITE_USE_EMULATOR==='true'`) can never be true in a production build; confirm all SDKs (Firestore/Auth/Storage/Functions) honor one flag; assert prod builds never call `connect*Emulator`. Add a build-time guard/test.
2. **.env safety.** Document every `VITE_*` var; ensure `.env`/secrets are gitignored (they are); add a check that required prod env vars are present and that `VITE_USE_EMULATOR` is absent/false in prod; confirm `gen-deploy-config.mjs` is the single source (from `firebase.json`).
3. **Firebase project/region/database verification.** Pin and verify `project=twinpet-pos`, `region=asia-southeast1`, `database=pos-db` across `firebase.json`, generated `deployConfig.ts`/`.env`, and the Admin SDK (`functions/src/db.ts`). Add a preflight that fails if the active `firebase use` project ≠ expected.
4. **Deploy command safety.** Harden the deploy scripts: explicit `--project`, no `(default)` database, a confirm/dry-run step, and a guard that refuses deploy if emulator envs are set or the wrong project is active. Review the `functions` deploy allowlist (`verifyPinLogin,reconcileOrder,retryReconcile`) — and **ensure `migrateDataToPosDb` is removed/disabled/excluded (deploy BLOCKER above).**
5. **Rules/functions deployment checklist.** A written, ordered checklist: run `test:rules` (must be green) + `functions` unit tests before any `firebase deploy --only firestore:rules` / `--only functions`; verify indexes; never deploy rules without a green rules suite; **confirm the temporary public `migrateDataToPosDb` function is gone/disabled before any prod functions deploy (hard blocker).**
6. **Production smoke test checklist.** Post-deploy manual checks: login (PIN/username), a POS sale → reconcile settles, a void, a receiving, an inventory transfer, and the reconciliation-exceptions page loads for an admin. Include rollback steps.
7. **Monitoring/logging checklist for reconciliation exceptions.** Define how `reconcileStatus=='exception'` is surfaced (the admin page + Cloud Functions logs/alerts); recommend a log-based metric/alert on reconcile failures and on `reconcileAttempts` approaching the cap; document the `retryReconcile` audit fields.
8. **Dev/test/prod workflow documentation.** One doc covering: local emulator (`dev:emulator` + the `pos-db` snapshot layer), the `demo-twinpet` rules-test project, and the prod deploy path — with the env matrix and the safety guards above.

## Hard restrictions carried in
Do not touch `stash@{0}`; do not apply the Flowbite stash; do not start the transfer refactor; do not change app behavior. Phase 3 is environment/ops/docs + guards/tests — not feature work.

## Acceptance criteria (when Phase 3 runs)
- **`migrateDataToPosDb` is removed/disabled/excluded — no prod functions deploy until this is true (hard blocker).**
- A prod build provably cannot enable the emulator (guarded + tested).
- Deploy scripts refuse the wrong project/database/region or an emulator-tainted env.
- Written, followed checklists exist for rules/functions deploy, smoke test, and monitoring.
- Dev/test/prod workflow doc published.

## Out of scope (later phases)
Broader feature work; the Phase 2 backlog items (RTL/router tests, Flowbite upgrade, transfer dest isolation, stockLots read scoping, void value-level constraints) remain tracked in `latest-report.md` and are addressed on their own tracks.
