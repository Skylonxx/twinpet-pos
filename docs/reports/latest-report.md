# Latest Report

> Rolling "latest report" for the stock-write security workstream. Updated at each phase boundary.
> **Current state:** **Phase 5 (MVP Readiness / Pre-UAT Stabilization) Planning**.
> **See:** `docs/reports/phase-5-mvp-readiness-manifest.md` for the Phase 5 scope and UAT script details.
> 
> ## Phase 5 (Planning/Docs Only)
> - **Phase 5 Approved:** Phase 5 approved by Tech Lead / CEO via external directive. This report records the approval context, Developer Self-Review Gate, and MVP readiness manifest.
> - **Strategic Capacitor Pivot:** Twinpet POS architecture updated to target Native App deployment via Capacitor (`docs/skills/SKILL-GLOBAL-ARCHITECTURE.md`). This is a docs/architecture-only update; no code/packages/config changed. Phase 5 UAT remains paused until architecture docs are aligned.
> - **Pre-UAT Evidence Collected:** Automated evidence collected in `docs/reports/phase-5-batch-1-pre-uat-evidence.md`. Exact terminal output for `npm run build` and Playwright E2E checkout test is fully captured and recorded.
> - **Batch 2 UAT (Manual/Visual):** Logged in `docs/reports/phase-5-batch-2-uat-results.md`. All visual manual UI/responsive checks are explicitly marked DEFERRED as they require human interaction. MVP UAT remains blocked pending human manual UAT execution/evidence. No code patches requested or made. `git status` shows pre-existing `.claude/` which is out of scope.
> - **Self-Review Gate:** Created `docs/skills/SKILL-DEVELOPER-SELF-REVIEW.md` and `docs/reports/ai-failure-ledger.md` to enforce self-review before Codex handoff.
> - **Docs-only:** No app code, rules, functions, or tests were changed.
> 
> ```markdown
> ### Developer Self-Review Before Codex
> 
> - [x] **Scope implemented**: Capacitor native wrapper architecture docs + native storage planning only.
> - [x] **Files changed**: `docs/skills/SKILL-GLOBAL-ARCHITECTURE.md`, `docs/skills/SKILL-OFFLINE-FIRST-POS.md`, `docs/skills/README.md`, `docs/reports/phase-5-mvp-readiness-manifest.md`, `docs/reports/latest-report.md`
> - [x] **Forbidden files untouched**: app code, rules, functions, tests, package scripts, build config, scripts, android/, ios/, node_modules.
> - [x] **Business logic preserved**: no runtime behavior changed.
> - [x] **Offline-first / async-safe behavior**: architecture updated to require native durable storage planning no implementation yet.
> - [x] **Anti-silent-failure behavior**: no UI behavior changed.
> - [x] **Flowbite / Impeccable.style compliance**: not applicable except docs still preserve existing UI standards.
> - [x] **Security/rules impact**: none.
> - [x] **Tests/build run**: not run because docs-only.
> - [x] **Evidence captured**: Batch 2 captured documentation status only; manual screenshots not captured. Automated evidence reused Batch 1 or was rerun with output matching Batch 1.
> - [x] **Report accuracy**: Checked.
> - [x] **Failure ledger items checked**: no overclaiming native storage implemented no packages installed no runtime changes claimed.
> - [x] **Deferred items**: Capacitor setup, native storage plugin choice, SQLite schema/migration, hardware plugin feasibility, App Store/Play Store pipeline. All responsive/manual state checks remain deferred.
> - [x] **Known remaining risks**: storage sync/conflict strategy and plugin selection unresolved. UAT sign-off blocked until human manual evidence is collected.
> - [x] **Ready for Codex review**: Yes, after this cleanup.
> ```
> 
> ## Phase 4 Step 4 Implementation Summary
> - **Files Changed:** `docs/reports/latest-report.md`, `docs/reports/phase-4-step-4-admin-exception-ui-manifest.md`, `src/pages/admin/ReconciliationExceptionsPage.tsx`, `src/pages/admin/ReconciliationExceptionsPage.css`.
> - **Manifest Correction:** Clarified `retryReconcile` backend may return `{ success: true, status, attempts }`, but the UI must preserve `Promise<void>` wrapper usage and not depend on it. Tech Lead resolved the Route-Only strategy (keep as is) and Table Pagination (unpaginated MVP approved).
> - **Flowbite Migration:** Transformed the HTML `table` to use `flowbite-react` components (`Table`, `TableHead`, `TableRow`, etc.), along with `Card`, `Badge`, `Spinner`, `Button`, and `Alert`.
> - **Anti-Silent Failure UX:** Replaced plain text with color-coded `Alert` blocks. Red alerts prominently show permission, query, or retry errors.
> - **Async-Safe Wording:** A successful wrapper call triggers a green `Alert` with truthfully non-final wording: "ส่งคำขอ retry บิล {orderId} แล้ว ระบบจะประมวลผลต่อ" (Retry requested — processing).
> - **Admin Access:** Preserved `isAdmin` hook gate; non-admins never trigger a read.
> - **Build/Test Evidence:** 
>   - `npm run build` PASSED (690ms).
>   - **DEFERRED:** Manual state evidence (loading/empty/error/pending states) is deferred and was not manually checked in this pass. 
>   - **DEFERRED:** Responsive viewport checks at 320px / 768px / 1080px were not run in this pass. The table uses `overflow-x-auto` / responsive wrapping as implementation support, but that is not proof of viewport testing. Add as follow-up before MVP UAT.
> - **Untouched Files:** `App.tsx`, nav/dashboard files, `firestore.rules`, `functions/src/*`, POS/checkout flows, and `stash@{0}` were strictly untouched.
> - **Paranoid Checklist:** `retryReconcile` logic is fully preserved; UI uses the wrapper without direct mutation. Table wrapped in `overflow-x-auto` for 320px screens.
> 
> ## Phase 4 Step 3 Implementation Summary
> - **Files Changed:** `src/components/PaymentModal.tsx`, `src/components/PaymentModal.css`, `tests/pos-human-checkout.spec.ts`, `scripts/start-emulator.mjs`, `scripts/dev-after-emulators.mjs`.
> - **Wording Changes:** Replaced "ชำระเงินสำเร็จ" and "บันทึกการขายสำเร็จ" with async-safe wording: "รับรายการขายแล้ว รอระบบประมวลผล" (online) and "บันทึกรายการลงเครื่องแล้ว ระบบกำลังรอซิงก์" (offline hint via `navigator.onLine`).
> - **Duplicate-Submit Handling:** `pay-confirm` button disables immediately using `confirming || processing` states. Added visual 'กำลังบันทึกคำสั่งซื้อ...' text on the button.
> - **onConfirm Rejection Behavior:** Rejection from `onConfirm` is explicitly trapped. Raw errors are logged to the console, and a cashier-safe message is shown in the UI (`ไม่สามารถบันทึกรายการได้ กรุณาตรวจสอบการเชื่อมต่อหรือแจ้งผู้ดูแล`).
> - **Playwright Test Changes:** Fixed login PIN selector to use `page.getByRole('button', { name: digit })`. Updated selectors and comments from `Success` to `Accepted`.
> - **Build/Test Evidence:** `npm run build` PASSED (898ms). `npx playwright test tests/pos-human-checkout.spec.ts` **PASSED** (1 passed, 37.6s). All E2E checkout evidence is fully verified and passing.
> - **Responsive Checks:** 320px / 768px / 1080px (Deferred / manual-not-run).
> - **Untouched Files:** `POSPage.tsx`, `useCheckout.ts`, `firestore.rules`, `functions/src/*`, and `stash@{0}` were strictly untouched.
> - **Paranoid Checklist:** Business logic integrity preserved; State isolation maintained; Cross-contamination avoided.
> - **Void authorization (Option A2):** `firestore.rules` strictly prevents voiding orders created on previous operational days via a server-side timestamp comparison (`(request.time + duration.value(7, 'h')).date() == (resource.data.serverCreatedAt + duration.value(7, 'h')).date()`). Cross-day voids are definitively blocked at the database layer. 
> - **Legacy Doc Compatibility (`serverCreatedAt` missing or null):** The rules explicitly require `"serverCreatedAt" in resource.data` and `resource.data.serverCreatedAt != null`. Attempting to void legacy documents that lack this timestamp will automatically and safely be denied without throwing a runtime rule evaluation error.
> - **Actor identity:** The system uses Anonymous Auth on the device, meaning `request.auth.uid` is a randomized string. The POS PIN-login (`verifyPinLogin` CF) stamps the actual user's ID as a custom claim (`request.auth.token.staffId`). `firestore.rules` was strictly patched to validate `request.resource.data.voidedBy == request.auth.token.staffId`, completely protecting against spoofing while accurately logging identity. 
>   * *Auth limitation:* The username/password fallback login path may not carry the `token.staffId` custom claim, which would cause same-day cashier voids to be denied by `firestore.rules`. The PIN login path is the supported and proven path for cashier voids.
> - **UI / Backend Sync & Offline (Anti-Silent Failure):** `requestPendingVoid` no longer swallows the `updateDoc` promise rejection. The UI executes `setVoidOpen(false)` immediately and waits up to 300ms. If a synchronous rule rejection occurs (e.g. cross-day limit or offline write queue fails), the `.catch` explicitly traps the error and throws a visually distinct red `.sh-toast-error` toast (`❌ คำขอยกเลิกถูกปฏิเสธ`). Success states use the green `.sh-toast-success` variant and are never displayed for rejected writes.
> - **Boundary Check:** Unrelated sale-payload fields, server-owned reconcile fields, `PaymentModal.tsx`, and `useCheckout.ts` remain completely locked down and untouched.
> - **Build/Test Status:** `npm run build` PASSED. `npm run test:rules` PASSED (91 tests).
> 
> **Build Evidence (Sample from verification run):**
> *Note: Exact bundle sizes, file hashes, and build durations are point-in-time samples and will naturally drift in future runs.*
> Command: `npm run build`
> ```text
> > twinpet-pos@0.0.0 build
> > tsc -b && vite build
> 
> vite v8.0.14 building client environment for production...
> Generating .flowbite-react\class-list.json file...
> transforming...✓ 547 modules transformed.
> rendering chunks...
> computing gzip size...
> dist/index.html                             1.42 kB │ gzip:   0.62 kB
> dist/assets/index-B--aDUti.css            321.39 kB │ gzip:  49.92 kB
> dist/assets/rolldown-runtime-Bh1tDfsg.js    0.56 kB │ gzip:   0.36 kB
> dist/assets/react-router-BVImBSaZ.js       42.27 kB │ gzip:  15.07 kB
> dist/assets/vendor-CAze_z6h.js            109.15 kB │ gzip:  31.38 kB
> dist/assets/charts-xn6RU_C7.js            177.58 kB │ gzip:  61.51 kB
> dist/assets/react-vendor-CzRZBWxH.js      250.54 kB │ gzip:  80.54 kB
> dist/assets/firebase-BYlOybkJ.js          463.72 kB │ gzip: 139.79 kB
> dist/assets/index-BGnippa1.js             941.50 kB │ gzip: 214.98 kB
> 
> ✓ built in 791ms
> ```
>
> **Rules Test Evidence (Sample from verification run):**
> *Note: Exact test file counts and execution times are point-in-time samples and will naturally drift.*
> Command: `npm run test:rules`
> ```text
>  ✓ rules-tests/async-orders-phase2b.spec.ts (11 tests) 1032ms
>  ✓ rules-tests/async-orders.spec.ts (6 tests) 412ms
>  ✓ rules-tests/product-stocks-phase1.spec.ts (17 tests) 1207ms
>  ✓ rules-tests/stock-lots-phase2.spec.ts (19 tests) 1196ms
>  ✓ rules-tests/products.spec.ts (12 tests) 835ms
>  ✓ rules-tests/firestore-permissions.spec.ts (11 tests) 838ms
>  ✓ rules-tests/shifts-phase3.spec.ts (15 tests) 819ms
> 
>  Test Files  7 passed (7)
>       Tests  91 passed (91)
>    Start at  18:29:39
>    Duration  9.05s (transform 78ms, setup 0ms, import 879ms, tests 7.41s, environment 0ms)
> ```
> 
> **Follow-up Notes:** 
> 1. Replacing the manual spinner/button/select markup with project-standard Flowbite React primitives is tracked as a non-blocking follow-up polish item.
> 2. Add `role="alert"` / `aria-live` to toast accessibility in future polish pass.
> **Backlog Note:** GCS `gcf-sources` / deployment artifact IAM and lifecycle audit is deferred to post-MVP hardening.

**Docs note (2026-06-07):** AI role/prompt instructions centralized in new `docs/ai-roles/` files (`developer`, `reviewer`, `tech-lead`, `environment-auditor`, `ui-implementer`, `README.md`) — **intentionally untracked until staged** as part of this docs-only patch. `AGENTS.md` prompt routing tightened (execute only on explicit `TO:` to the active agent; role-file name alone is not permission). `.cursor/rules/reviewer.md` points to `reviewer.md`. Antigravity documented in `README.md` (reuses `environment-auditor.md` / `developer.md`; no separate role file). Unrelated `rp.md` deletion excluded from this change set (file restored). `.claude/settings.local.json` is untracked, local-only, and out of scope for this role centralization change. No app/rules/functions change.

---

## Phase 3 — Gate 1: Production Functions Export Safety (DONE, no deploy)

**Goal:** ensure only intended production Cloud Functions can be deployed; remove the public temporary migration blocker. **No deployment was executed.**

### 1. Functions exported BEFORE this task (`functions/src/index.ts`)
- `reconcileOrder` — Firestore `onDocumentWritten` trigger (offline-sale reconciler). **Production-safe.**
- `retryReconcile` — `onCall`, admin-only manual repair. **Production-safe.**
- `verifyPinLogin` — `onCall`, PIN/username auth. **Production-safe.**
- `migrateDataToPosDb` — `onRequest`, **`invoker: 'public'`**, TEMPORARY one-shot (default)→pos-db DB copier. **NOT production-safe (blocker).**

(Non-function exports — `db`, `deployConfig` constants, `RECONCILE_RETRY_CAP`, `OVERSELL_LOT_ID`, and `sweeper.ts`'s `sweepStuckOrders`/`repairSettledOrder` — are NOT re-exported from `index.ts`, so they are **not** deployed as Cloud Functions; the sweeper is a script-invoked helper.)

### 2. Functions remaining enabled for production export
`verifyPinLogin`, `reconcileOrder`, `retryReconcile` — **exactly these three.**

### 3. Functions removed/disabled/excluded from production export
- `migrateDataToPosDb` — **REMOVED** from `functions/src/index.ts` (function + its private `copyCollection` helper deleted). Its own header said "DELETE AFTER MIGRATION"; the (default)→pos-db migration is complete.

### 4. What changed in `functions/src/index.ts`
- Deleted the `migrateDataToPosDb` export and the `copyCollection` helper.
- Removed now-unused imports: `getApps, initializeApp, App` (firebase-admin/app), `getFirestore` (firebase-admin/firestore), `onRequest` (firebase-functions/v2/https), `FIRESTORE_DATABASE_ID` (deployConfig).
- Added a guard comment documenting the removal + the production export allowlist.
- No other functions touched; no app/frontend behavior changed.

### 5. Deploy allowlist / checklist
- **Allowlist (already in `functions/package.json` `deploy`):** `firebase deploy --only functions:verifyPinLogin,functions:reconcileOrder,functions:retryReconcile` — only the three production functions are ever targeted (never a bare `--only functions`).
- **Checklist (documented):** before any `functions` deploy — (a) green `functions` unit tests + `test:rules`; (b) confirm **no** dev/mock/test/migration function is exported from `index.ts` (currently only the 3 above); (c) verify active `firebase use` project = `twinpet-pos`, database `pos-db`, region `asia-southeast1`; (d) use the explicit `--only` allowlist. (Broader Phase 3 gates will codify these as scripted guards.)

### 6–7. Confirmations
- **No deployment executed** — no `firebase deploy` was run (build + unit tests only).
- **`stash@{0}` untouched** — not applied, dropped, or modified.

### Build / test
- `functions` build (tsc): **green** (clean import removal). Functions unit tests: **43 passed (5 files)**. (No frontend/rules changes in this gate.)

### Paranoid Checklist (Gate 1)
1. **Business Logic Integrity:** the three production functions (auth, reconcile trigger, admin retry) are unchanged; only a public ops-migration endpoint the app never calls was removed → no runtime behavior change. Functions tests green (43).
2. **State Isolation / `stash@{0}`:** untouched — change is confined to `functions/src/index.ts` + this report.
3. **Cross-contamination:** no frontend, no rules, no transfer, no Flowbite/UI-stash, no unrelated edits; deploy allowlist already excluded it (defense in depth) — code removal makes it robust against a bare `--only functions`.
4. **Devil's Advocate (hidden risk):** removal is code-level; **the function may still exist as a *deployed* Cloud Function in the live project** from a prior deploy. A later Phase 3 deploy gate must explicitly **delete the deployed `migrateDataToPosDb`** (e.g. `firebase functions:delete migrateDataToPosDb`) — re-deploying with the allowlist alone will NOT remove an already-deployed function. Tracked for the deploy gate.

---

## Phase 2 — CLOSEOUT (COMPLETE)

**Phase 2 is officially complete.** Closeout documentation only — no code/behavior change in this entry.

**Scope clarification (important):** Phase 2 closed the **client-write spoofing / security-hardening gaps** for `productStocks`, `stockLots`, and the reconciliation exception flow. It does **not** mean all data risks are solved — several **deferred data risks remain open and documented** (notably transfer destination cross-branch isolation, `stockLots` read scoping, and value-level void-field constraints; see backlog #4–#6). A separate **production deploy blocker** is also outstanding: the temporary public `migrateDataToPosDb` Cloud Function (see Phase 3 / backlog #7).

### What's done
- **Track A — productStocks/stockLots security hardening: COMPLETE.**
  - `productStocks`: writes require `branchId == docId` (anti-spoof) + a stock-capable permission (blocks pos_sale-only cashiers); delete is genuinely admin-only; oversell and staff-initiated transfers preserved.
  - `stockLots`: create/update require a stock-capable permission; `branchId` present on create and **immutable** on update; delete remains manager/admin; reads intentionally unchanged.
- **Track B — reconciliation retry safety + route-only Admin UI: COMPLETE.**
  - Backend: enriched + sanitized exception logging; atomic (`FieldValue.increment`) attempt counting; admin-only `retryReconcile` callable (idempotent re-arm, cap = 3, `voidRequested` rejected, already-settled no-op); recovery audit (clear active error, preserve sanitized history); full `asyncOrders` client-write lockdown (create-spoof block + update field allowlist).
  - UI: route-only `/admin/reconciliation-exceptions` (direct URL, no dashboard/nav entry), admin-gated so non-admins start **no** Firestore read; repair only via the secured callable.

### Testing posture (accepted for now)
- Automated: rules suite (83), functions suite (43), and src pure-logic unit tests (gate/query-gate, row mapping, disable-reason, callable wrapper) — all green.
- **Deferred to backlog:** React UI **render tests** for the Admin Reconciliation Exceptions page (loading / error / toast / retry-click states) and a **router-level test** for `/admin/reconciliation-exceptions` — the current tooling has no jsdom/RTL.
- **Manual QA is accepted** for this internal, admin-only tool for now (low blast radius, server-enforced permissions + query gate).

### Technical debt / backlog (Phase 2 carry-over)
1. **React render tests — Admin Reconciliation Exceptions UI:** add jsdom + `@testing-library/react` (new test config) and cover loading/empty/error/toast/retry-disabled states. *Why deferred:* no RTL infra today; logic kept in node-tested pure helpers.
2. **Router-level test — `/admin/reconciliation-exceptions`:** assert the route mounts the page and a non-admin is handled (redirect/not-authorized) at the router level. *Why deferred:* needs RTL/router test harness.
3. **Flowbite upgrade for this isolated Admin UI:** after the security phases close **and** `stash@{0}` (Flowbite migration) is applied, migrate the plain `recex-` page to Flowbite (Table/Button/Badge/Modal). *Why deferred:* avoid conflict with the un-applied stash.
4. **Transfer destination isolation / server-side transfer flow:** move the cross-branch transfer destination `productStocks`/`stockLots` writes to a Cloud Function so client writes can be fully branch-isolated (`hasBranchAccess(docId)`). *Why deferred:* Phase 1/2 explicitly kept staff transfers working without a transfer refactor.
5. **stockLots read scoping review:** reads are currently any-staff (not branch-scoped) to preserve cross-branch visibility/transfer planning/reporting; audit read call-sites, then decide on branch scoping. *Why deferred:* needs a read-call-site audit to avoid breaking reports/FIFO.
6. **Value-level constraints for approved void fields:** the `asyncOrders` update allowlist controls *which* fields a `pos_void` client may change but not their *values* (e.g. forcing `status == 'voided'`). *Why deferred:* tightening values risks breaking the legitimate offline void flow.
7. **PRODUCTION DEPLOY BLOCKER — `migrateDataToPosDb`:** ✅ **code removed in Phase 3 Gate 1** (export + helper deleted from `functions/src/index.ts`). **Remaining:** if it was ever deployed, the **live deployed instance must still be deleted** (`firebase functions:delete migrateDataToPosDb`) during the Phase 3 deploy gate — re-deploying with the allowlist does not remove an already-deployed function.

### Secure-state summary
| Area | Status |
|---|---|
| **productStocks** | ✅ Hardened — anti-spoof (`branchId==docId`), permission-gated writes, admin-only delete; oversell + staff transfers preserved. |
| **stockLots** | ✅ Hardened — permission-gated create/update, `branchId` immutable on update; delete manager/admin. **Reads not branch-scoped** (deferred review #5). |
| **Reconciliation exception/retry** | ✅ Safe — atomic attempt counting, admin-only idempotent retry (cap 3), `voidRequested` rejected, recovery audit, sanitized errors; no double-deduction (atomic settle). |
| **Admin UI** | ✅ Route-only `/admin/reconciliation-exceptions`, admin-gated (non-admin starts no query), repair via secured callable. UI render tests deferred (#1/#2). |
| **Remaining deferred risks** | Transfer dest cross-branch writes still client-side (#4); stockLots reads unscoped (#5); void field values unconstrained (#6); UI render/router tests absent (#1/#2); **public `migrateDataToPosDb` migration fn = production deploy blocker (#7)**. These are documented/deferred — **not** all solved. None are *new* open client-write spoofing holes. |

### Next phase (proposed, not started)
**Phase 3 — Production Readiness & Environment Safety** → see `docs/reports/phase-3-proposal.md`. Goal: the app can't accidentally use emulator settings in prod, can't deploy to the wrong project/database/region, and has clear release/deploy/monitoring safety checks. **Includes a hard production deploy blocker: remove/disable/exclude the public `migrateDataToPosDb` function before any prod functions deploy.** Not implemented yet.

---

## Phase 2 — Track B, Step 2 PATCH: gate the exception query (security fix + honest coverage)

**Closes the Codex High findings on Step 2.**

- **Non-admins no longer start the exception query.** The page now computes `isAdmin = canViewReconciliationExceptions(user?.role)` and passes it to `useReconciliationExceptions(enabled)`. The hook's effect short-circuits via the pure `shouldStartExceptionsQuery(enabled, firebaseReady, dbPresent)` — when `enabled` is false (any non-admin), **no `onSnapshot`/read is ever started**. This is the authoritative gate; we do **NOT** rely on `AdminLayout` (which does not enforce `role === 'admin'`).
- **Real gate test added** (`adminGate.test.ts`): proves `shouldStartExceptionsQuery` is false for every non-admin role (`manager`/`staff`/`null`/`undefined`) even when Firestore is ready, and true only for admin + configured Firestore. Combined with the `canViewReconciliationExceptions` test this proves: non-admin → no query.
- **Coverage claim corrected (honesty).** The automated src tests are **pure-logic unit tests only** — the admin/query gate (`shouldStartExceptionsQuery`, `canViewReconciliationExceptions`), row mapping (`mapExceptionRow`), disable-reason (`retryDisableReason`), and the callable wrapper (`callRetryReconcile` + `mapRetryError`). There are **NO** React render tests: loading/empty/error/retry-click **UI states are NOT covered by automated tests** (no jsdom/RTL in the current tooling) — they are verified manually via the emulator. Adding RTL infra is a separate, approved step.

### Tests run / results (this patch)
- src unit: **103 passed (11 files)** — adds the `shouldStartExceptionsQuery` gate tests; existing reconciliation pure-logic tests still green.
- Web build `tsc -b && vite build`: **green**. Functions **43** / Rules **83**: unchanged (not affected).

---

## Phase 2 — Track B, Step 2: Reconciliation Exceptions Admin UI (ROUTE-ONLY, IMPLEMENTED)

**Implemented strictly route-only.** Direct-URL access only — **no** dashboard card, **no** nav link, **no** menu entry. `AdminDashboardPage.tsx`, navigation, settings/layout, Flowbite files, and `stash@{0}` were **not** touched.

### Direct URL path
`/admin/reconciliation-exceptions` (leaf under `AdminLayout`; reached only by typing the URL).

### Files created
- `src/pages/admin/ReconciliationExceptionsPage.tsx` — the page (admin-gated, read-only list + per-row Retry; plain JSX, no Flowbite).
- `src/pages/admin/ReconciliationExceptionsPage.css` — namespaced `recex-` plain CSS.
- `src/lib/reconciliation/adminGate.ts` — pure `canViewReconciliationExceptions(role)` gate.
- `src/lib/reconciliation/exceptionRows.ts` — pure view helpers (`mapExceptionRow`, `retryDisableReason`, `mapRetryError`, `RECONCILE_RETRY_CAP`).
- `src/lib/reconciliation/useReconciliationExceptions.ts` — read-only `onSnapshot` hook (equality-only query).
- `src/lib/reconciliation/retryReconcile.ts` — `httpsCallable` wrapper for the secured `retryReconcile` function.
- Tests: `src/lib/reconciliation/adminGate.test.ts`, `exceptionRows.test.ts`, `retryReconcile.test.ts`.

### Files modified
- `src/App.tsx` — **one** import + **one** `<Route path="reconciliation-exceptions" …/>` line under the existing `/admin` block (route-only). `App.tsx` is not in `stash@{0}`.
- `docs/reports/*` — this report + the revised Step 2 proposal/manifest.

### Query / backend
- Query: **single equality** `where('reconcileStatus','==','exception')`, no `orderBy` (newest-first sort done in-memory) → **no composite index**.
- Repair: ONLY via the admin-only `retryReconcile` callable; the UI never writes `asyncOrders` directly. Retry button is disabled at cap / when `voidRequested` / while in-flight (mirrors server guards).
- Permissions: admin-only — server callable role check + the page's own `canViewReconciliationExceptions` gate (degrades to a not-authorized state, never crashes).

### Tests run / results
- src unit (pure-logic ONLY — see the PATCH section above for the corrected coverage statement): `adminGate` (gate + query-start gate), `exceptionRows` (doc→row mapping + disable-reason), `retryReconcile` (callable invokes `{orderId}`, error propagation, `mapRetryError`). **No** React render/UI-state tests (no RTL in tooling).
- Web build: `tsc -b && vite build` **green**.
- Functions: **43 passed (5 files)** — unchanged. Rules: **83 passed (4 files)** — unchanged regression.

### Backlog note
After the security phases close **and** `stash@{0}` (the Flowbite migration) is applied, upgrade this isolated page to Flowbite components (Table/Button/Badge/Modal) for visual consistency. Until then it stays deliberately plain to remain conflict-free. A nav/dashboard entry (also deferred) can be added then.

### Step 2 Paranoid Checklist
1. **Business Logic Integrity:** POS create, oversell, and the void flow remain **untouched** — additive route + read-only list + the existing Step-1 callable; functions (43) and rules (83) suites green and unchanged.
2. **State Isolation:** `stash@{0}` remains **untouched** — only `App.tsx` (not in the stash) was edited in app code.
3. **Cross-contamination:** **no** `AdminDashboardPage.tsx`, navigation, settings/layout, Flowbite, or transfer changes; query/index scope not broadened (single equality `where`, no index).
4. **Devil's Advocate (one hidden risk):** `AdminLayout` does **not** enforce `role === 'admin'`, so it is **not** relied on. Enforcement is page-level: the query is gated by `isAdmin` (`enabled`) so a non-admin starts no read, and the page renders a not-authorized state. Remaining watch-items: UI render states are not RTL-tested (manual only), and the equality-only query must stay index-free if anyone later adds a branch filter/`orderBy`. (Superseded by the PATCH section above.)

---

## Phase 2 — Track B, Step 1 FINAL: paranoia tests + Step 1 closed

**Track B Step 1 is COMPLETE.** Backend retry safety + the full `asyncOrders` client-write lockdown are done and tested. This final patch is **test-only** (no rules/functions/behavior change) plus a Step 2 UI proposal (see below).

### Paranoia tests added (rules, test-only)
- **absent→null on protected fields:** explicit denial that a `pos_void` client can write `null` to a server-owned reconcile/audit field that is ABSENT on the stored doc (`reconcileError`, `lastReconcileError`, `lastReconcileErrorAt`, `firstFailedAt`, `previousReconcileError`, `reconcileRecoveredAt`, `adminRetryCount`, `lastRetryBy`, `lastRetryAt`, `reconciledAt`). The `diff().affectedKeys().hasOnly(...)` gate denies these because absent→null is an *added* key.
- **create reconciledAt spoofing:** explicit denial of a non-null `reconciledAt` on create (settled-timestamp spoof), plus proof that `reconciledAt: null` (the safe initial value POS checkout uses) is allowed.

### Test results
- Rules: **83 passed (4 files)**.
- Functions: **43 passed (5 files)** — unchanged (no function code touched).

### Tech-debt note (deferred)
**Value-level constraints on the approved void fields are intentionally deferred** to a future hardening pass. The current rule allowlists *which* fields a `pos_void` client may change (`voidRequested`, `status`, `voidReason`, `voidedBy`, `voidedAt`, `updatedAt`, `deviceId`) but does not constrain their *values* (e.g. forcing `voidRequested == true` or `status == 'voided'`). Tightening values now risks breaking the legitimate offline POS void flow (which legitimately varies `voidReason`/`deviceId`/timestamps); it is logged as future work, not a Step 1 blocker.

### Admin UI
Not implemented. Proposed in **Track B Step 2** — see `docs/reports/phase-2-track-b-step2-admin-ui-proposal.md` and the summary + Paranoid Checklist below.

### Track B Step 2 — Admin UI proposal summary (NOT implemented)
Full proposal: **`docs/reports/phase-2-track-b-step2-admin-ui-proposal.md`** (revised to ROUTE-ONLY per Codex).
- **Route:** `/admin/reconciliation-exceptions` (under `AdminLayout`). **ROUTE-ONLY / direct-URL access** — no dashboard card, no nav link, no menu entry. `AdminDashboardPage.tsx` and navigation files are NOT modified.
- **Isolated files:** `src/pages/admin/ReconciliationExceptionsPage.tsx` + `.css` (namespaced `recex-`, plain CSS — no Flowbite), `src/lib/reconciliation/useReconciliationExceptions.ts` (read-only `onSnapshot`), `src/lib/reconciliation/retryReconcile.ts` (callable wrapper), `src/lib/reconciliation/retryReconcile.test.ts`, and **one additive route line** in `App.tsx`.
- **Data:** exception rows (billId, branch, total, staff, createdAt, attempts vs cap, sanitized `lastReconcileError`, `firstFailedAt`, `adminRetryCount`, `lastRetryBy/At`, `voidRequested` badge); detail = lines/payments/sanitized errors.
- **Retry:** per-row button → confirm → `retryReconcile({orderId})` callable (re-arms server-side); disabled at cap / when `voidRequested` / while in-flight; live list auto-updates.
- **Consumes backend:** reads via Firestore `onSnapshot` (admin-readable); repairs ONLY via the `retryReconcile` `httpsCallable`; never writes reconcile fields from the client.
- **Permissions:** admin-only, defense-in-depth (callable role check + `AdminLayout` gate + existing rules); page degrades safely for a non-admin who hits the URL.
- **States:** loading / empty ("no exceptions 🎉") / error banner / per-row in-flight + disabled-with-reason.
- **Query:** single equality `where('reconcileStatus','==','exception')`, no `orderBy`, **no composite index** required.
- **stash conflict avoidance:** plain namespaced CSS + non-Flowbite primitives; no edits to stashed settings/nav/layout files, no `AdminDashboardPage.tsx` edit; only `App.tsx` (not in the stash) gets the additive route line.
- **Backlog:** upgrade this isolated page to Flowbite *after* security phases close and `stash@{0}` is applied.
- **Tests before impl:** route/admin-gate test, callable-wrapper error mapping, query-hook mapping (empty/error), pure disable-reason logic, rules regression. (Full RTL component tests need new infra — out of scope; view logic kept node-testable + emulator smoke test.)

### Paranoid Checklist (Track B Step 1 close)
1. **Business Logic Integrity:** POS `asyncOrders` create (safe baseline) ✅, oversell / negative stock ✅ (sale decrement is Admin-SDK, rules-exempt; create rule unchanged), and the legitimate offline void flow ✅ (full approved-field void merge passes) — all confirmed by green rules/functions tests.
2. **State Isolation:** `stash@{0}` (Batches 1–3 Flowbite/UI) remains **untouched** — not applied, dropped, or modified.
3. **Cross-contamination:** this work added **no UI code, no Flowbite, no transfer refactor, no unrelated cleanup** — Part 1 is rules-tests + report; Part 2 is a docs proposal only.
4. **Devil's Advocate (one easy-to-forget detail):** the future exceptions-list query is only index-free while it stays **equality-only** (`reconcileStatus == 'exception'`). The moment Step 2 adds a branch `where` + `orderBy(createdAt)`, it needs a **composite index** in `firestore.indexes.json` — and a missing index fails at runtime in a way that *looks* like a rules/permission error, which could send a debugger down the wrong path. (Secondary: value-level void-field constraints remain deferred — a compromised `pos_void` token could still set an odd `status` value within an otherwise-approved void update; low impact, logged as future hardening.)

---

## Phase 2 — Track B, Step 1 PATCH: Restrict pos_void updates to approved void fields (RULES ONLY)

**Closes the Codex High finding.** Previously a `pos_void` client update only had reconcile/audit fields frozen, so it could still mutate **sale-payload** fields (`lines`, `payments`, `total`, `creditAmt`, `staffId`, `branchId`, …) — and `handleVoidIntent` reads reversal inputs from the async order. Now a `pos_void` client update may change **only approved void-intent fields**; everything else is frozen. Rules-only; no functions, no Admin UI, no transfer/UI-stash changes.

### Approved void-intent fields (the ONLY keys a pos_void update may change)
`voidRequested`, `status`, `voidReason`, `voidedBy`, `voidedAt`, `updatedAt`, `deviceId`.

- New rules helper `voidIntentChangesOnly()` uses `request.resource.data.diff(resource.data).affectedKeys().hasOnly([...approved])`. This is strictly stronger than the prior per-field freeze: it blocks **sale-payload mutation** AND **all server-owned reconcile/audit fields** in one gate, and (via diff) also denies absent→null writes on protected fields. `branchId` is intentionally NOT in the allowlist — the void merge re-writes the same value (not an affected key); any real change is denied.
- `safeInitialReconcileState` (create) now also constrains `reconciledAt` to the safe baseline (`null`), so a create can't spoof a settled timestamp.
- Trusted backend paths (Admin-SDK reconciler / `retryReconcile` callable) still write all these fields — they bypass rules.

### Tests run / results
- Rules: **71 passed (4 files)** — adds `pos_void` sale-payload denial tests (`lines`, `payments`, `total`, `creditAmt`, `staffId`, `branchId`), a "void + sneak sale-payload edit → whole update denied" case, and a FULL legitimate void merge (all approved fields) that still passes; existing reconcile/audit freeze, create-spoofing denials, and normal POS create all still pass.
- Functions: **43 passed (5 files)** — unchanged (no function code touched).

### Remaining gaps
None known on the `asyncOrders` client-write surface: create-spoofing and update-spoofing are both closed; `pos_void` updates are restricted to approved void-intent fields; reconcile/audit + sale-payload fields are frozen. Admin UI (exceptions list, badge, retry button) remains the only deferred Track B item (standalone route/component; Flowbite upgrade = backlog/docs only).

---

## Phase 2 — Track B, Step 1 PATCH: Freeze ALL server-owned reconcile/audit fields (RULES ONLY)

**Closes the Codex High finding.** The previous `asyncOrders` update rule froze only `reconcileStatus` + `reconcileAttempts`, so a `pos_void` client could still mutate other server-owned reconcile/audit fields. **Now ALL of them are frozen on client updates.** Rules-only change; no functions, no Admin UI, no transfer/UI-stash changes.

- New rules helper `reconcileAuditFrozen(req, res)` requires every server-owned field to be **unchanged** on a client update: `reconcileStatus`, `reconcileAttempts`, `reconciledAt`, `reconcileError`, `lastReconcileError`, `lastReconcileErrorAt`, `firstFailedAt`, `previousReconcileError`, `reconcileRecoveredAt`, `adminRetryCount`, `lastRetryBy`, `lastRetryAt`. The `asyncOrders` update rule now gates on it (still requires `pos_void` + branch access).
- These fields move **only** via the Admin-SDK reconciler / `retryReconcile` callable, which bypass rules. Approved void fields (`voidRequested`, `status`, `voidReason`, `voidedBy`, `voidedAt`, `updatedAt`) remain writable, so the offline void-intent merge still works. POS checkout (create) and oversell are unaffected.

### Tests run / results
- Rules: **63 passed (4 files)** — adds a per-field update-denial test for each server-owned field (incl. `reconcileError`, `lastReconcileError`, `lastReconcileErrorAt`, `firstFailedAt`, `previousReconcileError`, `reconcileRecoveredAt`, `adminRetryCount`, `lastRetryBy`, `lastRetryAt`, `reconciledAt`) + a "sneak an audit field into a void merge → whole update denied" case; normal POS create, approved void merge, and create-spoofing denials still pass.
- Functions: **43 passed (5 files)** — unchanged (no function code touched); retry admin-only, voidRequested+exception rejection, concurrent-retry idempotency, and successful-retry audit behavior all still green.

### Remaining gaps
None known for the client-write surface: create-spoofing and update-spoofing of server-owned reconcile/audit fields are both closed. Admin UI (exceptions list, badge, retry button) remains the only deferred Track B item (standalone route/component; Flowbite upgrade = backlog/docs only).

---

## Phase 2 — Track B, Step 1 FOLLOW-UP: Hardened Retry Guards (BACKEND/RULES ONLY)

**Still backend-only — no Admin UI implemented** (no page, no dashboard badge, no retry button, no Flowbite migration). `stash@{0}` untouched; no transfer refactor; no unrelated app changes. Closes the remaining safety gaps before any UI work.

- **Client spoofing on `asyncOrders` create is blocked.** New rules helper `safeInitialReconcileState` permits only the safe baseline (`reconcileStatus` absent or `'pending_reconcile'`) and forbids seeding any server-owned control field (`reconcileAttempts`, `reconcileError`, `lastReconcileError`, `lastReconcileErrorAt`, `firstFailedAt`, `previousReconcileError`, `reconcileRecoveredAt`, `adminRetryCount`, `lastRetryBy`, `lastRetryAt`). Normal POS checkout + offline void-intent creates still pass.
- **Attempt counting is atomic/transaction-safe.** The exception path now writes `reconcileAttempts: FieldValue.increment(1)` (server-side increment against current stored state) instead of `priorAttempts + 1` from the (possibly stale) event payload — safe under duplicate trigger deliveries / concurrent attempts.
- **Concurrent retry is tested.** A simulated Admin double-click (two concurrent `performReconcileRetry`) re-arms **exactly once**: one fulfilled, one rejected (`failed-precondition`), `adminRetryCount == 1`, no stock/lot writes — proven against a serialized fake transaction.
- **voidRequested + exception conflict secured (tested).** Admin retry of an `exception` order with `voidRequested == true` is rejected (`failed-precondition`): not re-armed to `pending_reconcile`, no write, no stock mutation. The void path owns that order.
- **Audit preservation on successful retry.** New `buildRecoveryAuditPatch` (merged into `reconcileSale`'s settled write) **clears** the active error state (`reconcileError`/`lastReconcileError`/`lastReconcileErrorAt`/`firstFailedAt` via `FieldValue.delete()`) and, when a prior failure was recovered, **preserves** the sanitized previous error in `previousReconcileError` (+ `reconcileRecoveredAt`). Only the already-sanitized string is kept — never raw stack/internal detail.

### Tests run / results
- Functions: **43 passed (5 files)** — adds concurrent-retry idempotency, `buildRecoveryAuditPatch` (clear + history / first-time no-history), and atomic-increment assertions; existing reconcile/void/retry tests still green.
- Rules: **52 passed (4 files)** — adds create-spoofing denials (reconcileStatus/attempts/error/audit fields) + normal POS create + void-materialize create pass; Track A + Phase 1 still green.

### Still deferred (separate step)
Admin UI (exceptions list, dashboard badge, retry button) as a **standalone route/component**; the Flowbite upgrade for that UI remains **backlog/docs only**.

---

## Phase 2 — Track B, Step 1: Reconciliation Retry Safety (BACKEND ONLY)

**Scope executed = backend safety + tests + rules + docs only.** No Admin UI was implemented (no page, no dashboard badge, no retry button, no Flowbite migration). No transfer refactor, no UI/Flowbite `stash@{0}` changes, no unrelated app changes.

### Admin UI isolation strategy (for the later, separate step)
When the Admin UI is approved, it must be built as a **standalone component/route** (e.g. a dedicated "Reconciliation Exceptions" admin route + thin callable hook), and must **not** modify volatile layout/settings/navigation files that conflict with `stash@{0}` Flowbite work. The Flowbite upgrade needed for that future UI is **backlog/documentation only** at this time — not started here.

### What was implemented (backend)
- **Exception logging (enriched, sanitized):** on a failed settle, `reconcileOnWrite` now writes `reconcileStatus:'exception'`, `reconcileAttempts` (incremented), `lastReconcileError` + `lastReconcileErrorAt`, `reconciledAt`, and — **only on the first failure** — `reconcileError` + `firstFailedAt` (preserved debugging anchor). All admin-facing error fields go through `sanitizeReconcileError` (message only, single-lined, truncated to 300 chars). The raw/full error stays in Cloud Functions logs via the rethrow — never in Firestore.
- **Retry trigger (callable, admin-only):** new `retryReconcile` `onCall` (`functions/src/retryReconcile.ts`), core extracted as `performReconcileRetry(db, orderId, auth)` for unit testing. Requires `auth.token.role === 'admin'`; normal staff/clients cannot use it.
- **Server-owned status:** `firestore.rules` `asyncOrders` update tightened so non-admin clients **cannot** flip `reconcileStatus` or `reconcileAttempts` (immutable across client updates); the legitimate offline void-intent merge still passes. Reconcile state moves only via the Admin-SDK reconciler / callable (which bypass rules).

### Retry CAP = 3
`RECONCILE_RETRY_CAP = 3` total settlement attempts (initial automatic failure + admin retries combined; `reconcileAttempts` counts every failed settle, `adminRetryCount`/`lastRetryBy`/`lastRetryAt` give admin-retry audit). At/over the cap the callable refuses with `resource-exhausted` → **manual investigation required**.

### Idempotency strategy (no double stock deduction)
`reconcileSale` settles in **one atomic transaction**, so an `exception` means **nothing committed** → re-running cannot double-deduct. The callable **never calls `reconcileSale`**; it only transactionally re-arms `exception → pending_reconcile`, and the existing trigger re-runs the guarded settle (whose in-transaction `reconcileStatus !== 'pending_reconcile'` guard makes stale/duplicate deliveries no-ops). An already-`settled` order is a safe no-op; a non-`exception` order is rejected.

### voidRequested + exception handling
A `voidRequested` exception order is **never** re-armed to `pending_reconcile` (the callable rejects it with `failed-precondition`) — the void path owns it (the trigger routes `voidRequested → handleVoidIntent` first). Defined in code and covered by tests.

### Manual console repair = emergency-only fallback
Directly editing `reconcileStatus` in the Firestore console remains an **emergency-only** fallback and is **not normal operation**. The governed, audited path is the `retryReconcile` callable (admin-only, capped). Settled-but-orphaned read-model repair stays the separate `sweeper` tooling.

### Tests run / results
- Functions: **40 passed (5 files)** — adds `retryReconcile.test.ts` (admin-only; re-arm + idempotency; cap; voidRequested) and extends `reconcileException.test.ts` (attempt increment, first-error preservation, `sanitizeReconcileError` truncation/single-line). Existing reconcile/void behavior still green.
- Rules: **47 passed (4 files)** — adds `async-orders-phase2b.spec.ts` (non-admin cannot flip `reconcileStatus`/`reconcileAttempts`; legit void merge still passes; non-`pos_void` still blocked). Track A + Phase 1 still green.

### Deferred to the next (separate) step
Admin UI: exceptions list page, dashboard badge, retry button, and the Flowbite upgrade for that UI — **not implemented here**.

---

## Phase 2 — Track A: stockLots Write Hardening (COMPLETE)

**Status: Track A complete.** `stockLots` write hardening is finished: create is permission-gated and requires a branchId, update is permission-gated and the `branchId` invariant is enforced (immutable + non-removable). `stockLots` read behavior is intentionally unchanged. **Track B (reconciliation exception handling) remains deferred.**

### Rules (`firestore.rules`, `stockLots/{lotId}`) — final Track A state
- `allow create: if isStaff() && canMutateStock() && request.resource.data.branchId is string;`
- `allow update: if isStaff() && canMutateStock() && request.resource.data.get('branchId', null) == resource.data.branchId;`
- `allow read: if isStaff();` — **UNCHANGED** (intentional).
- `allow delete: if isManagerOrAdmin();` — **UNCHANGED**.

`canMutateStock()` (added in Phase 1) = `isAdmin()` OR any of `stock_receive` / `product_edit` / `pos_void` / `product_view`. It blocks `pos_sale`-only cashiers from fabricating/rewriting lot qty/cost, while preserving receiving (`stock_receive`), staff-initiated transfer dest-lot creation (regular staff carry `product_view`), and void restock (`pos_void`).

**branchId invariant (enforced + tested):** on create `branchId` must be present and a string; on update it must stay present and **equal** the existing value (`.get(_, null)` gives a clean deny on removal). Cross-branch dest-lot creation by stock-capable staff is intentionally still allowed (branch isolation of that leg is a later phase).

### Tests
- `rules-tests/stock-lots-phase2.spec.ts` (replaced the Phase 0 characterization spec): pos_sale-only create/update **DENIED**; create without `branchId` **DENIED**; **branchId mutation on update DENIED**; **branchId removal on update DENIED**; valid same-branchId update **ALLOWED**; receiving/transfer/void create+update **ALLOWED**; reads + delete **unchanged**.

### Test results
- Rules: **43 passed (3 files)** — `product-stocks-phase1`, `stock-lots-phase2`, `firestore-permissions`.
- Functions: **25 passed (4 files)** — unchanged (no function code touched).

### Behavior preserved
stockLots **reads intentionally unchanged** (cross-branch visibility / transfer planning / aggregate reporting intact); staff-initiated transfers; receiving; void restock; oversell/negative stock; productStocks Phase 1 behavior (still green); delete still manager/admin-only.

### Not touched
Track B / reconciliation logic, transfer refactor, `productStocks` rules, UI/Flowbite `stash@{0}`, app behavior.

---

## Phase 1 — productStocks Rules Hardening

### 0. Packaging (finalized)
Phase 1 was reviewed by Codex; packaging finalized (Phase 2 not started). The Phase 1 change set is **staged** (git index), separated from unrelated work:

**Staged (Phase 1 change set):**
- `firestore.rules` (modified)
- `docs/reports/latest-report.md` (added)
- `rules-tests/product-stocks-phase1.spec.ts` (added)
- `rules-tests/stock-lots-phase0.spec.ts` (added)
- `functions/src/reconcileException.test.ts` (added)

**Deliberately NOT in the Phase 1 change set:** `stash@{0}` (Batches 1–3 UI/settings work), and untracked `docs/reports/phase-0-characterization.md` (Phase 0 artifact), `.cursor/`, `AGENTS.md`, `docs/reviews/`.

**Re-verified results:** rules **36 passed (3 files)**; functions **25 passed (4 files)**. No productStocks logic change was required (no packaging/test mismatch).

### 1. Housekeeping summary
Before touching any rules/tests, the working tree was inspected. It carried unrelated tracked modifications from earlier batches (1–3: Flowbite UI / settings / UOM / transfer-UI). To avoid mixing UI refactoring with security hardening, those were **stashed** (reversible) so the Phase 1 staged package contains only the security-hardening artifacts: `firestore.rules`, `docs/reports/latest-report.md`, `rules-tests/product-stocks-phase1.spec.ts`, `rules-tests/stock-lots-phase0.spec.ts`, and `functions/src/reconcileException.test.ts`. Pre-existing **untracked** items (`.cursor/`, `AGENTS.md`, `docs/reviews/`) were left in place (they cannot leak into a tracked diff).

### 2. Files committed / stashed / separated before Phase 1
Stashed as `stash@{0}` — "WIP: Batches 1-3 UI/settings/UOM/transfer-UI (unrelated to stock-security Phase 1)":
`rp.md`, `src/lib/settings/devMock.ts`, `src/lib/settings/settingsNav.ts`, `src/lib/settings/systemTypes.ts`, `src/lib/settings/useUomUnits.ts`, `src/lib/types.ts`, `src/pages/SettingsPage.tsx`, `src/pages/inventory/TransferHistoryPage.tsx`, `src/pages/inventory/TransferPage.tsx`, `src/pages/settings/DocumentSettings.tsx`. Restore later with `git stash pop`.

### 3. Phase 1 files changed
- `firestore.rules` — productStocks hardening (the only rules-logic change in the package).
- `rules-tests/product-stocks-phase1.spec.ts` — added (replaces `product-stocks-phase0.spec.ts`, which was removed).
- `rules-tests/stock-lots-phase0.spec.ts` — unchanged (stockLots not in this phase).
- `functions/src/reconcileException.test.ts` — unchanged (Phase 0).
- `docs/reports/latest-report.md` — this report.

### 4. Rules changes summary
`products/{pid}/productStocks/{branch}` and the `collectionGroup('productStocks')` block were both hardened identically (rules grant on the **union** of matching blocks, so both must match):
- **Anti-spoof:** `request.resource.data.branchId == <docId>` is now required → branchId spoofing is impossible.
- **Permission gate:** writes require `canMutateStock()` (a new helper) — `isAdmin()` OR any of `stock_receive` / `product_edit` / `pos_void` / `product_view`. This **blocks pos_sale-only cashiers** while keeping regular staff (who carry `product_view`) able to initiate transfers.
- **Removed broad `allow write: if isStaff()`** → replaced with scoped `allow create, update`.
- **Delete is genuinely admin-only:** split into `allow create, update` + `allow delete: if isAdmin()`, so delete is no longer silently subsumed by a broad `write`.
- Removed the spoof-enabling `requestProductStockBranchId()` helper (now unused).

### 5. Tests updated
Phase 0 characterization (`product-stocks-phase0.spec.ts`) was converted into Phase 1 expected-behavior (`product-stocks-phase1.spec.ts`): the insecure cases (branchId spoof, pos_sale-only write, staff delete) now assert **DENIED**; own-branch writes, the cross-branch transfer-dest write, admin delete, and oversell assert **allowed**. Added a manager (non-admin) delete-denied case.

### 6. Test results
- Rules: **36 passed (3 files)** — `product-stocks-phase1`, `stock-lots-phase0`, `firestore-permissions`.
- Functions: **25 passed (4 files)**.

Acceptance criteria: all rules + function tests pass; Phase-0 insecure cases now fail (spoof, pos_sale-only, non-admin delete); own-branch ops pass; admin delete passes; non-admin delete fails; oversell preserved; staff-initiated transfer preserved.

### 7. Behavior intentionally preserved
- **Oversell / negative stock** — sales never reach these rules (POS checkout decrements via the `reconcileOrder` Cloud Function / Admin SDK, which bypasses rules); no client-side POS stock write was added.
- **Staff-initiated branch transfers** — the cross-branch destination write stays allowed (stamps `branchId == toBranch == docId`; regular staff carry `product_view`).
- **Receiving** — manager/admin carry `stock_receive`/`product_edit` → still write stock.
- **Void restock** — `pos_void` qualifies under `canMutateStock()`.

### 8. Known remaining risks
- **Cross-branch write breadth (accepted for now):** any stock-capable staffer can still write *another* branch's stock (needed for the transfer dest leg, since rules can't tell a transfer from an arbitrary write). branchId-spoof is closed, but branch isolation of the dest leg is not — that is Phase 2.
- **`stockLots` writes** were unscoped at Phase 1 time — **now hardened in Phase 2 Track A** (permission gate + branchId invariant); see the Phase 2 section above.
- **`product_view` as a write gate is intentionally weak** — it draws the line between a pos_sale-only terminal and a real staffer, not true least-privilege.
- **Value integrity** (absolute vs increment) is not enforceable in rules — only a Cloud Function can guarantee it.

### 9. Recommended Phase 2 note — transfer destination write isolation
Move the branch-transfer **destination** stock/lot write (and the cancel-reversal counterparty write) into a Cloud Function (Admin SDK), so the client only writes its **own** branch plus the `inventoryTransfers` doc. Once no legitimate cross-branch client write remains, tighten these rules further to `hasBranchAccess(stockBranchId)` for all client writes — closing the residual cross-branch breadth. This requires a transfer-flow refactor (explicitly deferred from Phase 1) and should be scoped/approved separately. The same `stockLots` hardening (branch scoping + transfer-dest carve-out) should ride along in that phase.

---

## Phase 0 — Stock-Write Risk Characterization (Option C)

### 1. Phase 0 summary
Read-only characterization of current Firestore-rules behavior for stock writes, scoped to `productStocks` write access, `stockLots` write access, and reconciliation exception handling. No `firestore.rules`, Cloud Function, transfer-flow, or app-behavior changes were made — only characterization tests and reporting. Finalized business decisions applied: (1) regular staff may execute branch transfers; (2) oversell/negative stock is allowed and POS must never block a sale; (3) Phase 0 is done when all Critical + highly-impactful High risks are proven with tests.

### 2. Tests added/updated
| File | Type | Status |
|---|---|---|
| `rules-tests/product-stocks-phase0.spec.ts` | rules (emulator) | added/updated |
| `rules-tests/stock-lots-phase0.spec.ts` | rules (emulator) | added |
| `functions/src/reconcileException.test.ts` | functions unit | added |

### 3. Test results
- Rules suite: **33 passed (3 files)** under `firebase emulators:exec --only firestore --project demo-twinpet "npx vitest run --config vitest.rules.config.ts"`.
- Functions suite: **25 passed (4 files)** under `npm --prefix functions run test:unit`.

### 4. Current behavior proven
- **productStocks writes are effectively `isStaff()` only** (two match blocks → permissive union; broad nested `allow write: if isStaff()` wins). Reads ARE branch-isolated.
- **`allow delete: if isAdmin()` is a NO-OP** — `allow write` subsumes delete, so any staff can delete any stock doc, including cross-branch.
- **branchId spoof passes** — writing branch B's doc while stamping `branchId:"A"` succeeds (payload trusted over doc id).
- **No permission scoping** — a `pos_sale`-only cashier can mutate stock.
- **Oversell never blocked** — sale create has no stock check; the Admin-SDK decrement (`reconcileOrder.ts:375-388`) has no sufficiency guard and may go negative (rules-exempt).
- **stockLots read/create/update = `isStaff()`**, no branch scoping, arbitrary qty/cost; **delete IS genuinely manager/admin-only** (explicit `delete` clause, not subsumed).
- **Reconcile exceptions are surfaced**: a failing sale settle is stamped `reconcileStatus:'exception'` + `reconcileError` and rethrown; already-`exception`/`settled` docs are no-ops on re-delivery (no reprocessing loop).

### 5. Critical/High risks covered
| ID | Sev | Risk |
|---|---|---|
| C1 | Critical | Any staff sets arbitrary `totalStockBase` on any product/branch |
| C2 | Critical | Any staff can delete any `productStocks` doc (admin-only clause is a no-op) |
| C3 | Critical | Any staff create/update arbitrary `stockLots` (qty/cost), any branch |
| H1 | High | branchId spoof defeats a naive branch rule |
| H2 | High | No permission scoping — `pos_sale`-only cashier can mutate stock & lots |
| H3 | High | Reconcile exception visibility + no reprocessing loop |
| H4 | High (accepted) | Cross-branch stock write needed for staff transfers, but unconstrained |
| I1 | High | `stockLots` reads not branch-scoped (cost-data leak) |
| D2 | required | Oversell must never block a sale |

### 6. Risks still uncovered and why
- **avgCost drift** — deferred per instruction.
- **End-to-end oversell settle (full FIFO)** — `reconcileSale` is not exported and uses transactional queries; characterized via rules + code evidence instead.
- **stockMovements write rules** — out of the three focus areas.
- **Live transfer transaction commit** — proved the rule permits it; no integration test (no behavior change allowed).
- **Void reversal correctness** — already covered by `voidIntent.test.ts` / `voidReversal.test.ts`.

### 7. Unrelated working-tree changes detected
Pre-existing modifications from earlier batches (1–3), NOT part of this workstream: `rp.md`, `src/lib/settings/{devMock,settingsNav,systemTypes,useUomUnits}.ts`, `src/lib/types.ts`, `src/pages/SettingsPage.tsx`, `src/pages/inventory/{TransferHistoryPage,TransferPage}.tsx`, `src/pages/settings/DocumentSettings.tsx`; plus untracked `.cursor/`, `AGENTS.md`, `docs/reviews/`. To be separated before Phase 1 so UI work isn't mixed with security hardening.

### 8. Recommended Phase 1 starting point
Harden `productStocks` rules (only): enforce `request.resource.data.branchId == docId` (anti-spoof), replace the broad `isStaff()` write with a stock-capable-staff gate that excludes `pos_sale`-only cashiers, and make delete genuinely admin-only (stop using `write` which subsumes delete). Preserve oversell and staff-initiated transfers. Mirror predicates across the nested and collection-group blocks. Full destination-leg branch isolation is deferred to Phase 2 (server-side transfer move).
