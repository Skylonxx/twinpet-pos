# Latest Report

> Rolling "latest report" for the stock-write security workstream. Updated at each phase boundary.

---

## TRACKER RECONCILIATION — 2026-06-23

> This reconciliation section supersedes the stale "Current state" note below. That note reflects Phase 7C-C3; the physical repo has advanced significantly since then (~35 commits).

**Current physical state (verified 2026-06-23):**
- HEAD: `889e23a fix(pos): make suspended bill ids LAN-safe`
- origin/main: `889e23a`
- Ahead/behind: `0 / 0`
- Working tree: clean before reconciliation
- Staging: empty before reconciliation
- stash@{0}: present and untouched — `On main: WIP: Batches 1-3 UI/settings/UOM/transfer-UI (unrelated to stock-security Phase 1)`
- Phase: `TWINPET-POS-TRACKER-RECONCILIATION-AFTER-REENTRY` (DOCS-ONLY / OPTION A)

**Docs-only reconciliation in progress — no implementation performed.**

### Recent commit ledger (physically verified, newest first)

| Hash | Message |
|------|---------|
| `889e23a` | fix(pos): make suspended bill ids LAN-safe |
| `602acea` | fix(pos): restore hold bill modal flow with DOM coverage |
| `287955e` | test(pos): add suspended bill hold/restore contract tests |
| `873997e` | style(pos): polish action button hierarchy |
| `8a4ce19` | style(pos): polish cart summary layout and resolve responsive constraints |
| `ab7eceb` | fix(pos): stabilize discount modal draft state |
| `85b3a31` | feat(pos): add per-unit item discount option |
| `1a68983` | fix(pos): repair discount badge and numpad touch behavior |
| `630b742` | style(pos): polish cart item row readability |
| `06bc831` | feat(pos): add product card display preferences |
| `3b3b909` | feat(pos): replace category modal with dropdown |
| `d13a9a1` | style(pos): restore modal header icons and simplify buttons |
| `521961f` | style(pos): refine seamless split cart layout |
| `b04f303` | feat(pos): sync categories and refine cashier macro layout |
| `ce49a82` | style(pos): polish refresh update state and focus recovery |
| `023cc8d` | fix(pos): recover scanner focus across cashier actions |
| `42ff3ed` | fix(pos): restore scanner focus after cashier actions |
| `bb9b1ad` | style(pos): refine search and barcode action bar |
| `3b6b8ed` | style(pos): add bump flash feedback for rescanned cart items |
| `c3f7193` | fix(pos): bump rescanned cart line to top |
| `1e83473` | fix(pos): stabilize product grid scrollbar gutter |
| `667093e` | feat(pos): add ui layout preferences and realistic local seed |
| `f9d11ec` | fix(pos): polish toast feedback and typography |
| `29995ea` | fix(pos): enforce stock oversell matrix |

### Tracker drift summary

- **Context.md**: "Current clean baseline" referenced `654c704` (7C-L2); actual HEAD is `889e23a` (~35 commits ahead). Multiple phases listed as "ACTIVE / NOT COMMITTED" are physically committed.
- **Task.md**: Header referenced "Phase 7C-UI-01-ANIMATION / AWAITING CODEX + AGY REVIEW"; all prior phases are committed.
- **latest-report.md**: "Current state" referenced "Phase 7C-C3" (`4262a25`); ~35 more commits exist.
- **docs/UI_MASTER_PLAN.md**: Missing — created by this reconciliation.
- **docs/STATE.md**: Missing — created by this reconciliation.

### UI-08 Status

**AMBIGUOUS / NEEDS SCOPE + PHYSICAL UAT RECONCILIATION** — CEO clarification pending on AppShell-header location and "Sync" control identity. No physical planning evidence or implementation exists.

### UI-09 Status

**NOT READY FOR PLANNING** — No physical planning evidence exists. Blocked until tracker reconciliation is accepted and UI-08 scope is clarified.

### Stash Warning

    stash@{0}: On main: WIP: Batches 1-3 UI/settings/UOM/transfer-UI (unrelated to stock-security Phase 1)

**Do NOT touch stash@{0}.**

### Confirmations

- No implementation performed
- No source code changes
- No test changes
- No package changes
- No checkout/payment/cart/stock logic changes
- No Firebase/functions/rules changes
- No Android artifact changes
- No .claude changes
- No staging, no commit, no push
- stash@{0} untouched
- agentchattr repo not touched

---

> **STALE "Current state" note below (historical — see reconciliation above):**
> **Current state:** **Phase 7C-C3 — Admin Dashboard / Report Namespace Isolation** — **CLOSED / COMMITTED — `4262a25 refactor(style): isolate admin dashboard and report css namespaces`** (Tech Lead / CEO authorized; Codex PASS WITH NOTES; structural CSS/DOM verification fallback accepted in place of live seeded UAT). Namespace-isolation-only refactor breaking two shared-CSS couplings from the C1-0 audit. **Admin Dashboard:** `dash-*` / `.dashboard-page` forked → `adash-*` / `.adash-page` (new `src/pages/admin/AdminDashboardPage.css`); `AdminDashboardPage.tsx` imports the local CSS; shared `DashboardPage.css` UNMODIFIED. **All Branches Stock Overview:** `sr-*` forked → `absr-*` (`AllBranchesStockOverview.css`); `AllBranchesStockOverview.tsx` drops the shared import; shared `StockReportPage.css` UNMODIFIED. No business logic/state/query/lifecycle/data/CSV-export behavior changed. No H7-F/write-path/forbidden contamination. Structural verification: 0 drift in forked rules after reverse mapping and full rendered-class coverage; live seeded visual UAT blocked by admin auth — structural fallback authorized by Tech Lead as closure-equivalent; no fake screenshots. Full web `npx vitest run` → **492 passed (29 files)**; `tsc -b` clean; forbidden-area diff EMPTY; `stash@{0}` untouched. **C1-0 (CSS namespace audit) and C2 (evidence-based no-op deferral) closed at `b757c65`.** **Next strategic decision pending: Admin UI polish leveraging `adash-*` / `absr-*`; POS Cashier UX Boundary Audit; or optional seeded admin visual UAT confidence check. No implementation without separate authorization.**
>
> **Prior state:** **Phase 7C-B1 — Manual Review Ops UI Polish** — **CLOSED / COMMITTED — `f4d9e7a style(pos): polish manual review ops durable rejection panel`** (Gemini / Tech Lead / CEO — Option A APPROVED; golden rule: Zero Behavioral Change; Codex PASS WITH NOTES). Presentation-only polish of `src/pages/ManualReviewOpsPage.tsx` (single production source file, +16/−9) improving the visual distinction between the actionable Manual Review Queue and the read-only Durable Rejection Forensic Log: the forensic section boundary is strengthened (`mt-6 … border-t … pt-6` → `mt-8 … border-t-2 … pt-8`); the forensic-log header gains a read-only badge (`<Badge>อ่านอย่างเดียว</Badge>`) beside the unchanged `<h2>บันทึกการปฏิเสธหลักฐาน (อุปกรณ์นี้)</h2>`; the forensic empty state is restyled from `<Alert color="gray">` to a dashed-border centered muted `<div>` (same Thai text/meaning); and timestamp cells in BOTH tables (`it.createdAt`, `r.createdAt`) gain `font-mono text-xs` for scannability. Tracker docs were also updated in the implementation commit. **Strictly cosmetic — no business-logic/state/query/`useEffect`/`useMemo` change; no change to `listQueue`/`listReversalRejections`/`resolveManualReview`/`buildManualReviewResolvePayload`; Manager/Admin gate and unauthorized behavior unchanged; queue resolve flow unchanged; durable panel remains read-only with NO resolve/delete/retry/sync/export/action button; Thai local-device disclaimer meaning preserved; `recordId` still internal-only (sole `key={r.recordId}`); no route/nav, no global/shared CSS, no inline styles, no cross-page Flowbite migration; no offline-schema/`DB_VERSION`/helper/model/log/store change; no Receiving/Transfer catch-site, server-resolver, or Firestore-rules change; no POS/cart/checkout/stock-mutation/write-path change.** No test changes — the 24 stabilized 7C-A assertions still pass unchanged. Focused `manualReviewOps` 24 passed; `recordEvidenceRejection`/`reversalRejectionLog`/`reversalLocalStore`/`offlineReversalQueue` 75 passed; **492 web (29 files)**, `tsc -b` clean, 43 functions resolveReversal (server unchanged). `git diff --stat` = 1 file (`ManualReviewOpsPage.tsx`); forbidden-area diff EMPTY; `stash@{0}` untouched. Codex accepted notes: tracker wording precision about "one file" meant one production source file; zero business logic or state changes occurred; source-level tests still rely on semantic source markers, accepted as test-maintenance risk. **No POS cashier UX or UI polish beyond 7C-B1 has started. Next step: strategic option selection for next Phase 7C slice — (C) Admin/Inventory visual consistency (batched, namespace-collision-aware); (B) POS cashier UX polish (highest value, requires read-only boundary audit first); or another separately authorized planning step. No Admin/Inventory or POS cashier UI work without separate authorization.**
>
> **Prior state:** **Phase 7C-A — Regression Stabilization Pass + Phase 7C-D1 — Operator Runbook** — **CLOSED / COMMITTED — `9ad2c51 test(pos): stabilize durable rejection tests and add operator runbook`** (Gemini / Tech Lead / CEO — Option B APPROVED; Codex PASS WITH NOTES; accepted notes: remaining source-level tests rely on stable semantic markers — materially better than exact whole-page button counts; CRLF warnings accepted; zero production code mutated). **7C-A** hardens the H7-G `?raw` source-level assertions in `src/lib/pos/offline/manualReviewOps.test.ts` (21 → 24 tests, no production code touched): brittle whole-page `<Button` count replaced by two intent-based tests — a region-scoped check asserting the panel contains NO `<Button` and NO action wiring, plus a positive check that the queue retains its resolve affordance; spacing-sensitive `recordId` negatives replaced by a robust single-use check (`r.recordId` appears EXACTLY ONCE as `key={r.recordId}`); a `GUARD` test + comment documents the in-memory store concurrent-write artifact (test-double-only; production unaffected). Safety coverage preserved/strengthened (net +3 tests). **7C-D1** adds `docs/operator-runbook-durable-rejection-panel.md`, a plain-Thai operator guide explaining the panel, local-device-only limitation, what it is NOT, what to do / not do. **No production source change (`ManualReviewOpsPage.tsx` and all offline/store/catch-site files untouched — forbidden-area diff EMPTY), no store/schema/`DB_VERSION` change, no UI behavior/layout/polish change, no POS cashier UX / cart / checkout / stock-mutation change, no server resolver / Firestore-rules change, no route/nav change.** Focused `manualReviewOps` 24 passed; **492 web (29 files)** (was 489; +3), `tsc -b` clean, 43 functions resolveReversal (server unchanged). `stash@{0}` untouched. **Baseline is hardened for visual/UI polish planning. No POS cashier UX or UI polish implementation has started. Next step: readiness status / planning for visual/UI polish slices — (A) Manual Review Ops UI polish; (C) Admin/Inventory visual consistency; (B) POS cashier UX polish as a separately authorized, write-path-bounded effort. No UI polish implementation without separate authorization.**
>
> **Prior state:** **Phase 7B-H7-G — Manual Review Ops Durable Rejection Panel** — **CLOSED / COMMITTED — `86a628e feat(pos): add read-only manual review ops durable rejection panel`** (Gemini / Tech Lead / CEO — Option B APPROVED WITH NOTES; Codex PASS WITH NOTES; notes resolved before commit). Surfaces the durable rejection logs (H7-A model, H7-C store, written by H7-E/H7-F) in the existing Manual Review Ops page as a LOCAL READ-ONLY forensic panel — the Admin/Ops surfacing slice. `src/pages/ManualReviewOpsPage.tsx` adds a section titled `บันทึกการปฏิเสธหลักฐาน (อุปกรณ์นี้)` BELOW the existing manual-review queue. It is gated by the SAME page-level Manager/Admin gate (`canViewManualReviewOps` early-returns the not-authorized Alert before any panel renders), reuses the EXISTING memoized `createIndexedDbReversalStore`, and reads ONLY via `listReversalRejections(store)` (newest-first) through an independent `refreshRejections` loader also gated on `canResolve` (clears data for non-authorized). Read-only columns: เวลา (`r.createdAt`), ประเภท (`r.sourceType` badge), เอกสาร (`r.sourceId`), สาขา (`r.branchId`), รหัส (`r.evidenceCode`), เหตุผล (`r.evidenceMessage`), ผู้ทำรายการ (`r.staffId ?? '—'`); row key is `r.recordId` (internal React rendering only; not displayed in cells). An `info` Alert disclaimer states the records are local-device forensic logs only — not server-synced, not a central audit log, not requiring resolution (`...เฉพาะเครื่องนี้เท่านั้น ไม่ได้ซิงก์ขึ้นเซิร์ฟเวอร์ ไม่ใช่ audit log กลาง และไม่ต้องปิดงานจากรายการนี้`); loading/error/empty states match the queue pattern. **Visibility-only:** NO resolve/delete/retry/sync/export/queue/stock/server action button is added (`<Button` count unchanged at 3 = queue resolve + 2 modal); `recordId`/hashes/`serializeReversalRejectionRecord`/raw payloads/qty-cost/`observedDocumentUpdatedAt` are NOT exposed in cells; NO write API (`recordEvidenceRejection`/`recordReversalRejection`) is imported or called in the page. The existing manual-review queue load/resolve/toast/gate/route behavior is unchanged (`listQueue`/`resolveManualReview`/`buildManualReviewResolvePayload` intact). **No catch-site change, no helper/model/log/store/schema change (`recordEvidenceRejection.ts`/`reversalRejectionRecord.ts`/`reversalRejectionLog.ts`/`reversalLocalStore.ts` untouched; no `DB_VERSION` bump; no index), no offline display-label helper, no new route/nav, no separate Admin page, no server resolver/Firestore-rules change, no validation/fail-closed change, no transfer/receiving write-path change, no server-sync/central-audit architecture.** Tests: `src/lib/pos/offline/manualReviewOps.test.ts` (+11 → 21) — a store-level read-path pair + 9 source-level `?raw` page assertions. Focused `manualReviewOps` 21 passed; `reversalRejectionLog`/`recordEvidenceRejection`/`reversalLocalStore`/`offlineReversalQueue` 75 passed; **489 web (29 files)** (was 478; +11), `tsc -b` clean, 43 functions resolveReversal (server unchanged). Forbidden-area diff EMPTY; `stash@{0}` untouched. **Phase 7B-H series is CLOSED / COMMITTED. Durable logging initiative complete: Receiving capture (H7-E), Transfer capture (H7-F), Admin/Ops local read-only surfacing (H7-G). Next step: Phase 7 completion summary and transition planning into Stabilization & UI Polish Phase.**
>
> **Prior state:** **Phase 7B-H7-F — Transfer Pair Catch-site Integration** — **CLOSED / COMMITTED — `872575a feat(pos): log transfer reversal evidence rejections`**. Wires the proven H7-E `recordEvidenceRejection` helper into BOTH transfer evidence-rejection catch sites. `src/pages/inventory/TransferHistoryPage.tsx` and `src/pages/admin/AdminTransferPage.tsx` each construct one `useMemo(() => createIndexedDbReversalStore(), [])` and, in the `TransferReversalEvidenceError` branch only, compute the existing operator message, `setToast(message)` exactly as before, then dispatch (un-awaited, fully guarded) `recordEvidenceRejection({ sourceType:'transfer', sourceId: cancelTarget.id, branchId: cancelTarget.fromBranchId, evidenceCode: err.code, evidenceMessage, staffId: user.id, observedDocumentUpdatedAt: toObservedDocumentUpdatedAtIso(cancelTarget.updatedAt) })`; the `finally { setBusy(false) }` cleanup is unchanged and non-evidence errors are NOT logged. `evidenceSource` omitted. Origin branch (`cancelTarget.fromBranchId`, not the auth branch) is the record's branch context, identical across both pages. **The durable rejection log now covers Receiving + both Transfer surfaces.** No helper/model/log/store/schema change, no `ReceivingEditPage` change, no server/rules/validation/write-path change, no Admin/Ops surfacing. 25 recordEvidenceRejection tests (13 H7-E + 12 H7-F: simulated transfer caller + source-level `?raw` assertions for both pages), 80 regression (model/log/store/queue/manualReviewOps), 478 web (29 files), `tsc -b` clean, 43 functions resolveReversal (server unchanged). Forbidden-area diff EMPTY; `stash@{0}` untouched. Approved: Gemini / Tech Lead / CEO Option B APPROVED WITH NOTES. **Admin/Ops surfacing remains future work. Next step: read-only strategic planning for Admin/Ops Surfacing.**
>
> **Prior state:** **Phase 7B-H7-E — Receiving-only Catch-site Integration** — **CLOSED / COMMITTED — `ad1ff61 feat(pos): log receiving reversal evidence rejections`**. The FIRST production caller of the durable rejection log, per the H7-D design audit (receiving-first). New bridge `src/lib/pos/offline/recordEvidenceRejection.ts` — `recordEvidenceRejection(store, input): void`: builds the H7-A record via `buildReversalRejectionRecord` and fire-and-forgets the H7-C `recordReversalRejection`; **both the (fail-closed) build and the async dispatch are guarded, the async promise carries `.catch(() => {})`, and it returns `void`** — so it never throws into the caller and leaves no unhandled rejection. `evidenceSource` omitted (unresolved at the throw). `src/pages/ReceivingEditPage.tsx` constructs one `useMemo(() => createIndexedDbReversalStore(), [])` and, in the `ReceivingReversalEvidenceError` branch only, computes the existing operator message, dispatches `recordEvidenceRejection({ sourceType:'receiving', sourceId: id, branchId, evidenceCode: err.code, evidenceMessage, staffId: user.id, observedDocumentUpdatedAt })`, then `throw new Error(message)` exactly as before — **operator message + throw-to-banner UX unchanged**; non-evidence errors still `throw err`. Receiving-only: no transfer-page integration, no Admin/Ops surfacing, no offline-schema (`reversalLocalStore.ts`/`reversalRejectionLog.ts` untouched)/server/rules/validation/write-path change. 13 recordEvidenceRejection tests (incl. source-level `?raw` page assertions), 80 regression (model/log/store/queue/manualReviewOps), 466 web (29 files), `tsc -b` clean, 43 functions resolveReversal (server unchanged). Forbidden-area diff EMPTY; `stash@{0}` untouched. Transfer catch-site integration and Admin/Ops surfacing remain future separately-authorized slices.
>
> **Prior state:** **Phase 7B-H7-C — Durable Rejection Log Store Wiring** — **CLOSED / COMMITTED — `76b7451 feat(pos): add latent durable reversal rejection log store`**. Latent wiring of the H7-A model into a durable local store, per the Codex-reviewed (PASS WITH NOTES) H7-B design. `src/lib/pos/offline/reversalLocalStore.ts` gains a `rejections` IndexedDB store (additive: `'rejections'` in `ReversalStoreName`/`REVERSAL_STORES`, **`DB_VERSION` 1 → 2**, in-memory `rejections` map); the `onupgradeneeded` loop creates only missing stores, so the v1→v2 upgrade preserves `intents`/`stock`/`ledger`/`markers` + data. New `src/lib/pos/offline/reversalRejectionLog.ts` exposes best-effort, **never-throwing** `recordReversalRejection(store, record) → 'recorded'|'duplicate'|'unavailable'|'failed'` (out-of-line key = content-addressed `recordId`; idempotent overwrite; distinct `createdAt` → distinct row) and read-only `listReversalRejections(store, filter?)` (newest-first by `createdAt`; optional `sourceType`/`branchId`). Touches ONLY the `rejections` store — no stock/ledger/intents/markers mutation, no queue-state control reads. **100% latent: no production caller, no catch-site/UI/Manual-Review-Ops surfacing, no server/rules/validation/write-path change.** A logging failure is best-effort and never blocks or alters the fail-closed F1/G1 UX. 16 reversalRejectionLog tests + 3 migration tests (real `openDb`/`onupgradeneeded` via an injected compact fake IndexedDB), 61 regression (model/queue/manualReviewOps), 453 web (28 files), `tsc -b` clean, 43 functions resolveReversal (server unchanged). Forbidden-area diff EMPTY; `stash@{0}` untouched. Catch-site integration and Admin/Ops UI surfacing remain future separately-authorized slices.
>
> **Prior state:** **Phase 7B-H7-A — Pure Latent Reversal Rejection Record** — CLOSED / COMMITTED — `749e6e6 feat(pos): add latent reversal rejection record model`. New pure file `src/lib/inventory/reversalRejectionRecord.ts` + 20-test suite defines the record model for a FUTURE durable local rejection log: a fail-closed transfer/receiving evidence rejection (F1/G1 made it momentarily *visible*) is thrown BEFORE any offline intent, so it leaves no durable forensic trail. The model captures the minimal forensic identity (sourceType transfer/receiving, sourceId, branchId, evidenceCode, already-computed friendly evidenceMessage, optional evidenceSource/staffId/observedDocumentUpdatedAt, caller-supplied createdAt) with `buildReversalRejectionRecord` / `createReversalRejectionRecordId` (deterministic `rej_<16hex>`) / `serializeReversalRejectionRecord` (canonical stable JSON) — all pure, no I/O, no `src/lib/pos/offline` import. **100% latent: no persistence wiring, no catch-site/UI/offline-queue/server/rules/write-path change; thrown errors + fail-closed semantics unchanged.** 20 reversalRejectionRecord tests, 111 reversalCoordinator, 434 web (26 files), `tsc -b` clean, 18 transferCrud, 41 transferReversalEvidence, 43 functions resolveReversal (server unchanged). `stash@{0}` untouched. Durable storage wiring, catch-site integration, and Admin/Ops UI surfacing remain future separately-authorized slices.
>
> **Prior state:** **Phase 7B-H6-G1 — Receiving Evidence Rejection Visibility & Void Error Handling** — CLOSED / COMMITTED — `e80b2a3 feat(pos): surface receiving reversal evidence rejection reasons`. UI/error-visibility only — the receiving symmetric counterpart of F1. A pure exhaustive `getReceivingReversalEvidenceMessage(code)` maps each `ReceivingReversalEvidenceCode` → friendly Thai message (unknown code → existing `RECEIVING_EVIDENCE_INCOMPLETE_MESSAGE`); `ReceivingEditPage.handleVoid` is wrapped in try/catch that, for a `ReceivingReversalEvidenceError`, re-throws the friendly message + raw code to `ReceivingForm`'s existing void-dialog error banner (non-evidence errors re-thrown unchanged; not swallowed). Audit confirmed the rejection was already caught + shown generically by `ReceivingForm` (not a true unhandled rejection) and that `AdminReceivingPage` uses the legacy `cancelReceiving` path (no parity needed; no scope expansion). The thrown error (type, `code`, generic `message`) and the fail-closed validation are UNCHANGED. **No validation/fail-closed/receiving-validator/offline-queue-schema/IndexedDB/`src/lib/pos/offline`/server-resolver/transfer-behavior change.** 111 reversalCoordinator tests, 18 transferCrud, 41 transferReversalEvidence, 414 web (25 files), `tsc -b` clean, `functions resolveReversal` 43 unchanged. No durable rejection log (future separately-authorized slice). **Transfer and Receiving fail-closed visibility paths are both closed.** `stash@{0}` present and untouched.
>
> **Prior state:** **Phase 7B-H6-F1 — Transfer Reversal Evidence Rejection Visibility** — CLOSED / COMMITTED — `3a3d202 feat(pos): surface transfer reversal evidence rejection reasons`. UI/display-only: a pure exhaustive `getTransferReversalEvidenceMessage(code)` maps each `TransferReversalEvidenceCode` → friendly Thai message (unknown code → existing generic fallback); the two transfer cancel pages' `catch` surfaces that message + raw code only when a `TransferReversalEvidenceError` is caught (non-evidence errors keep the existing fallback; control flow / `finally` / branch gating / success flow unchanged); Manual Review Ops gains a read-only `evidenceSource` label column via a **page-local** `getEvidenceSourceLabel`. The thrown error (type, `code`, generic `message`) and the fail-closed validation are UNCHANGED. **No validation/fail-closed/offline-queue-schema/IndexedDB-store/`src/lib/pos/offline`-runtime/server-resolver/transfer-write-path change.** 107 reversalCoordinator tests, 18 transferCrud, 41 transferReversalEvidence, 410 web tests (25 files), `tsc -b` clean, `functions resolveReversal` 43 unchanged. No durable rejection log (future separately-authorized slice). `stash@{0}` present and untouched.
>
> **Prior state:** **Transfer Reversal Evidence sequence fully closed.** H6-E2-C — Transfer Evidence Coordinator Validation — CLOSED / COMMITTED — `fe3ff44 feat(pos): validate transfer reversal header evidence`. The client coordinator now PREFERS the transfer header `reversalEvidence` snapshot and validates it fail-closed (`validateTransferHeaderEvidence` → `OriginalStockEffect[]`), with strict legacy item-subcollection fallback when absent (`resolveTransferReversalEffects`; `evidenceSource` = `header_snapshot`/`legacy_subcollection`). `TransferReversalInput` gains untrusted `transferHeaderEvidence?: unknown`; `assertTransferReversalInput` split into header-field + item gates; both cancel pages pass `cancelTarget.reversalEvidence`. Present-but-invalid header fails closed (no fallback, no write). 27 new H6-E2-C tests (103 reversalCoordinator; 406 web total), incl. the Codex blocker-fix regression (non-finite `totalQtyBase` rejection). **No transfer write-path change, no server resolver change, no offline queue schema change.** Server resolver remains authoritative (re-reads items); H6-E2-C is client-side local-correction hardening, not a server trust boundary. `stash@{0}` present and untouched.
>
> **Prior state:** **Phase 7B-H6-E2-B — Write Transfer Evidence Header at Completion** (CLOSED / COMMITTED — `82d3352`). `reversalEvidence?: TransferReversalEvidence` added to `InventoryTransfer`; `confirmBranchTransfer` builds + asserts + persists evidence atomically in the Phase-3 `tx.set`; `devConfirmBranchTransfer` mirrors this. Evidence `createdAt` is a client ISO string; header timestamps remain server-authoritative.
>
> **Prior state:** **Phase 7B-H6-E2-A — Pure Transfer Evidence Builder + Dual-Branch Invariant** (CLOSED / COMMITTED — `53a2123`). New pure file `src/lib/inventory/transferReversalEvidence.ts` + 41-test suite. `buildTransferReversalEvidence` models dest_gain + source_loss; `assertTransferReversalEvidenceCoversCompletion` proves dual-branch balance, checksum consistency, and branch-direction binding. No runtime wiring; stacked on H6-E1.
>
> **Prior state:** **Phase 7B-H6-E1 — Transfer `updatedAt` Stamping** (CLOSED / COMMITTED — `8a3d03f`). `confirmBranchTransfer` and `devConfirmBranchTransfer` stamp `updatedAt` at transfer completion alongside `createdAt`, activating the transfer stale-client guard end-to-end for new transfers. Timestamp-only: no evidence/checksum snapshot, no resolver/offline-queue change, no legacy backfill.
>
> **Prior state:** **Phase 7B-H6-D2 — UI Route Wiring & Legacy Path Retirement** (CLOSED / COMMITTED — `bb30881`; CEO Option B — APPROVED WITH NOTES). Flipped `decideReversalRoute('transfer')` to `transfer_queue_first`, migrated `TransferHistoryPage`/`AdminTransferPage` to the queue-first `executeTransferReversal`, retired the legacy direct `cancelBranchTransfer` from both pages, and added the `canBranchReverseTransfer` origin-branch gate (destination-only users blocked in the branch-scoped page; admin surface ungated). `transferCrud.ts` untouched.
>
> **Prior state:** **Phase 7B-H6-C — Server Resolver Activation + Tests** (CLOSED / COMMITTED — `68f46e2`) then **H6-D1 — latent queue-first transfer executor** (COMMITTED — `4aa8065`). H6-C activated the dormant transfer reversal resolver for the live model — `completed` is the reversible state (H6-B Option A), eligibility centralized in `isTransferStatusReversible`, admitted only into the existing strict guards. H6-D1 added the latent `executeTransferReversal` (dual-branch, queue-first) but did NOT wire it into any UI — superseded by H6-D2.
>
> **Prior state:** **Phase 7B-D4 — Docs/Context Sync After H5 Closure** (docs-only; not yet committed). H5 CLOSED / COMMITTED (`4762d97` — `feat(pos): wire client observation timestamp for reversals`; CEO Option B — APPROVED WITH NOTES). Post-commit working tree was **clean**. `stash@{0}` present and untouched. No forbidden areas touched. **End-to-End Receiving Reversal Hardening is functionally complete** (H4 server-side stale-client guard + H5 client/offline timestamp payload wiring). D3 closed and committed (`fb4c3b0`). H4 closed and committed (`4da7757`). H3 closed and committed (`4d69143`). D1 closed and committed (`dacccd1`). H2 closed and committed (`8b48513`). **Next after D4:** Phase 7B-H6 — Transfer Reversal Planning / Environment Audit (read-only planning only; no code changes; no implementation until Tech Lead approves).

## Phase 7B-H7-F: Transfer Pair Catch-site Integration (CLOSED / COMMITTED — 872575a)

**Status:** CLOSED / COMMITTED — `872575a feat(pos): log transfer reversal evidence rejections`. Authorization: Gemini / Tech Lead / CEO — Option B APPROVED WITH NOTES. Clean baseline at commit: `97f33e1 docs: sync receiving rejection logging tracker after closure` (H7-E impl `ad1ff61` directly below).

### What this activates

The second + third production callers of the H7-A model + H7-C durable log. A fail-closed transfer evidence rejection (`TransferReversalEvidenceError`) on either transfer surface — previously only made *visible* by F1 via `setToast` — is now also durably recorded, best-effort, without changing the toast or `busy`-cleanup UX. Mirrors H7-E, except the transfer catch sites surface via `setToast` (not `throw`).

### What was added

- **`src/pages/inventory/TransferHistoryPage.tsx`** (MOD) — imports `createIndexedDbReversalStore` + `recordEvidenceRejection`; `const rejectionLogStore = useMemo(() => createIndexedDbReversalStore(), [])` (one per mount); in `handleCancel`'s `TransferReversalEvidenceError` branch only: compute `evidenceMessage`/`message` (toast text unchanged), `setToast(message)`, then un-awaited `recordEvidenceRejection(rejectionLogStore, { sourceType:'transfer', sourceId: cancelTarget.id, branchId: cancelTarget.fromBranchId, evidenceCode: err.code, evidenceMessage, staffId: user.id, observedDocumentUpdatedAt: toObservedDocumentUpdatedAtIso(cancelTarget.updatedAt) })`. `rejectionLogStore` added to the `useCallback` deps. Non-evidence `else` branch unchanged (not logged); `finally { setBusy(false) }` unchanged.
- **`src/pages/admin/AdminTransferPage.tsx`** (MOD) — identical change in its `handleCancel` `TransferReversalEvidenceError` branch; `rejectionLogStore` added to that `useCallback`'s deps. `editBranchTransfer` catch untouched.
- **`src/lib/pos/offline/recordEvidenceRejection.test.ts`** (MOD, +12 tests → 25 total) — `H7-F: simulated transfer caller path` (toast still set to the original message when logging fails; never throws) + `describeTransferCatchSiteSource` source-level `?raw` assertions for BOTH pages (one memoized store; `recordEvidenceRejection(` called exactly once ⇒ non-evidence branch does not log; `sourceType: 'transfer'`; `branchId: cancelTarget.fromBranchId`; not awaited; `setToast(message)` preserved).

### Execution order (enforced, both pages)

detect `TransferReversalEvidenceError` → compute operator message → `setToast(message)` → dispatch fire-and-forget log → existing `finally { setBusy(false) }` runs unchanged. Helper is synchronous/void/fully-guarded → cannot block, delay, swallow, or alter the toast/busy-cleanup behavior.

### What is NOT in this slice

No `ReceivingEditPage.tsx` change, no helper/model/log/store/schema change (`recordEvidenceRejection.ts`/`reversalRejectionRecord.ts`/`reversalRejectionLog.ts`/`reversalLocalStore.ts` untouched), no `DB_VERSION` bump, no Admin/Ops surfacing, no Manual Review Ops UI, no server resolver/Firestore-rules change, no validation/fail-closed/thrown-error change, no F1/G1/transfer evidence message-text change, no transfer/receiving write-path change.

### Files changed (code)

```
src/pages/inventory/TransferHistoryPage.tsx          (MOD — useMemo store + 1 helper call in the evidence-error branch)
src/pages/admin/AdminTransferPage.tsx                (MOD — useMemo store + 1 helper call in the evidence-error branch)
src/lib/pos/offline/recordEvidenceRejection.test.ts  (MOD — +12 H7-F tests; 25 file total)
```

### Evidence

- `npx vitest run recordEvidenceRejection` → **25 passed** (13 H7-E + 12 H7-F)
- `npx vitest run reversalRejectionRecord reversalRejectionLog reversalLocalStore offlineReversalQueue manualReviewOps` → **80 passed** (5 files, regression green)
- Full web `npx vitest run` → **478 passed** (29 files); `npx tsc -b` → clean
- `npm --prefix functions run test:unit -- resolveReversal` → **43 passed** (server UNCHANGED)
- `git diff --check` clean (benign CRLF only); forbidden-area diff EMPTY (`ReceivingEditPage`, helper/model/log/store, server resolver, Firestore rules, transfer write-path); `stash@{0}` untouched.

### Hidden risk

Unlike Receiving (which re-throws), both Transfer catch sites surface the rejection via `setToast(...)` and continue into `finally { setBusy(false) }`; the integration keeps logging an un-awaited, fully-guarded side effect inside the `TransferReversalEvidenceError` branch only — placing it elsewhere, awaiting it, or using the auth branch id instead of `cancelTarget.fromBranchId` could corrupt forensic records, log non-evidence failures, or subtly alter operator feedback.

### Closure

H7-F is **CLOSED / COMMITTED** — `872575a feat(pos): log transfer reversal evidence rejections`. Approved: Gemini / Tech Lead / CEO Option B APPROVED WITH NOTES. The durable rejection log is now active for both Receiving and Transfer. Admin/Ops surfacing remains future work. Next step: read-only strategic planning for Admin/Ops Surfacing.

### Final test evidence (H7-F commit)

```
recordEvidenceRejection: 25 passed
reversalRejectionRecord: 20 passed
reversalRejectionLog: 16 passed
reversalLocalStore: 3 passed
offlineReversalQueue: 31 passed
manualReviewOps: 10 passed
Full web vitest: 478 passed (29 files)
functions resolveReversal: 43 passed
npx.cmd tsc -b: PASS
```

---

## Phase 7B-H7-E: Receiving-only Catch-site Integration (CLOSED / COMMITTED — ad1ff61)

**Status:** CLOSED / COMMITTED — `ad1ff61 feat(pos): log receiving reversal evidence rejections`. Authorization: Gemini / Tech Lead / CEO — Option A APPROVED (receiving-only; Claude Opus 4.8 / High). Per the H7-D design audit (receiving-first). Clean baseline was: `76b7451`.

### What this activates

The first production caller of the H7-A model + H7-C durable log. A fail-closed receiving evidence rejection (`ReceivingReversalEvidenceError`), previously only made *visible* by G1, is now also durably recorded — best-effort, without changing the throw-to-banner UX.

### What was added

- **`src/lib/pos/offline/recordEvidenceRejection.ts`** (NEW) — bridge `recordEvidenceRejection(store, input): void`:
  - Builds the record via H7-A `buildReversalRejectionRecord`; dispatches via H7-C `recordReversalRejection`.
  - Returns `void` (no Promise to drop). **Both** the build (fail-closed; can throw) and the async dispatch are wrapped in try/catch, and the async promise carries `.catch(() => {})` — never throws into the caller; no unhandled rejection.
  - Omits `evidenceSource` (not resolved at the throw). Touches only the `rejections` store via the log API; no stock/ledger/intents/markers mutation, no schema change.
  - `EvidenceRejectionInput`: `sourceType`/`sourceId`/`branchId`/`evidenceCode`/`evidenceMessage` + optional `staffId`/`observedDocumentUpdatedAt`/`now` (injectable clock).
- **`src/pages/ReceivingEditPage.tsx`** (MOD) — imports `createIndexedDbReversalStore` + `recordEvidenceRejection`; `const rejectionLogStore = useMemo(() => createIndexedDbReversalStore(), [])` (one per mount, mirroring `ManualReviewOpsPage`); in the `ReceivingReversalEvidenceError` branch only: compute `evidenceMessage`/`message` (unchanged), `recordEvidenceRejection(rejectionLogStore, { sourceType:'receiving', sourceId: id, branchId, evidenceCode: err.code, evidenceMessage, staffId: user.id, observedDocumentUpdatedAt: toObservedDocumentUpdatedAtIso(receiving?.updatedAt) })`, then `throw new Error(message)`. Non-evidence errors still `throw err`.

### Execution order (enforced)

detect `ReceivingReversalEvidenceError` → compute operator message → dispatch fire-and-forget log → `throw new Error(message)`. Helper is synchronous/void/fully-guarded → cannot block, delay, swallow, or alter the throw-to-banner behavior.

### What is NOT in this slice

No transfer catch-site integration (`TransferHistoryPage`/`AdminTransferPage` untouched), no Admin/Ops surfacing, no Manual Review Ops UI, no offline store schema change (`reversalLocalStore.ts`/`reversalRejectionLog.ts` untouched), no server resolver/Firestore-rules change, no validation/fail-closed/thrown-error change, no F1/G1 message-text change, no receiving/transfer write-path change.

### Files changed (code)

```
src/lib/pos/offline/recordEvidenceRejection.ts        (NEW — void bridge helper)
src/lib/pos/offline/recordEvidenceRejection.test.ts   (NEW — 13 tests incl. source-level ?raw assertions)
src/pages/ReceivingEditPage.tsx                        (MOD — useMemo store + 1 helper call in the evidence-error branch)
```

### Tests

Helper: builds valid receiving + transfer-shaped records; persists via in-memory store; omits `evidenceSource`; returns `void`; swallows async storage failure (no throw); swallows synchronous build failure (no throw, no row); no unhandled rejection on async failure; simulated receiving caller still throws the original F1/G1 message when logging fails. Source-level `?raw` assertions on `ReceivingEditPage`: memoized store constructed; `recordEvidenceRejection` called in the receiving evidence branch; the call is **not** awaited; the branch still `throw new Error(message)`; non-evidence path still `throw err`.

### Evidence

- `npx vitest run recordEvidenceRejection` → **13 passed**
- `npx vitest run reversalRejectionRecord reversalRejectionLog reversalLocalStore offlineReversalQueue manualReviewOps` → **80 passed** (regression green)
- Full web `npx vitest run` → **466 passed** (29 files); `npx tsc -b` → clean
- `npm --prefix functions run test:unit -- resolveReversal` → **43 passed** (server UNCHANGED)
- `git diff --check` clean; forbidden-area diff EMPTY (transfer pages, offline store/log, server resolver, Firestore rules, transfer write-path); `stash@{0}` untouched.

### Hidden risk

H7-E is the first production caller of the durable rejection log; if the helper could throw, returned a dropped Promise, or were placed before message determination, the forensic log could disrupt the receiving fail-closed banner path it is meant to observe — the `void`/synchronous/fully-guarded contract and the after-message placement prevent that.

---

## Phase 7B-H7-C: Durable Rejection Log Store Wiring (CLOSED / COMMITTED — 76b7451)

**Status:** CLOSED / COMMITTED — `76b7451 feat(pos): add latent durable reversal rejection log store`. Authorization: Gemini / Tech Lead / CEO — Option A APPROVED (pure local store wiring; Claude Opus 4.8 / High). H7-B design reviewed by Codex: **PASS WITH NOTES**. Clean baseline was: `749e6e6`.

### What was added (latent only)

- **`src/lib/pos/offline/reversalLocalStore.ts`** (MOD, additive) — `'rejections'` added to `ReversalStoreName` + `REVERSAL_STORES`; **`DB_VERSION` 1 → 2**; in-memory `data` gains `rejections: new Map()`. `transact`, `openDb`, `onupgradeneeded` (additive create-if-missing loop), `dump`, and abort semantics are otherwise unchanged; the four existing stores (`intents`/`stock`/`ledger`/`markers`) and their data are preserved across the v1→v2 upgrade.
- **`src/lib/pos/offline/reversalRejectionLog.ts`** (NEW, latent, no UI imports):
  - `recordReversalRejection(store, record): Promise<'recorded'|'duplicate'|'unavailable'|'failed'>` — **best-effort, NEVER throws.** Writes the H7-A `ReversalRejectionRecord` into the `rejections` store keyed out-of-line by `record.recordId` (content-addressed → idempotent overwrite; a `get`-then-`put` reports `duplicate` when the row already exists; distinct `createdAt` → distinct `recordId` → distinct row). Any storage failure is caught and mapped to `unavailable` (IndexedDB absent) or `failed` (a best-effort hint — callers treat any non-`recorded`/`duplicate` identically).
  - `listReversalRejections(store, filter?)` — read-only; newest-first by `createdAt`; optional `sourceType`/`branchId` in-memory filters.
  - Touches ONLY the `rejections` store: no stock/ledger/intents/markers mutation, no marker idempotency, no queue-state control reads.

### Codex H7-B notes carried forward

1. `duplicate` vs `recorded` is not over-specified for concurrent tabs (content-addressed key → an identical record re-`put`s over itself, so no duplicate row arises regardless of race outcome).
2. `unavailable` vs `failed` is a best-effort hint only; documented as such.
3. The "caller still completes F1/G1 on logging failure" scenario is a small wrapper unit test — **no real catch-site wiring**.

### Best-effort failure policy (enforced)

A rejection-log write failure is swallowed (returns an outcome, never throws), never changes the fail-closed UX, never prevents the operator-visible F1/G1 message, never mutates the reversal result, and is never a second gate or a source of truth for stock. The log is forensic only.

### What is NOT in this slice

No catch-site integration (`TransferHistoryPage`/`AdminTransferPage`/`ReceivingEditPage` untouched), no UI/Manual Review Ops surfacing, no server resolver (`functions/`) / Firestore rules change, no validation/fail-closed/thrown-error change, no transfer/receiving write-path change. No production caller imports the new API.

### Files changed (code)

```
src/lib/pos/offline/reversalLocalStore.ts                 (MOD — rejections store + DB_VERSION 1→2 + in-memory parity)
src/lib/pos/offline/reversalRejectionLog.ts               (NEW — recordReversalRejection + listReversalRejections)
src/lib/pos/offline/reversalRejectionLog.test.ts          (NEW — 15 tests)
src/lib/pos/offline/reversalLocalStore.migration.test.ts  (NEW — 3 migration tests)
```

### Tests (mandatory matrix — all green)

DB_VERSION 1→2 upgrade fires and creates ONLY `rejections`; existing `intents`/`stock`/`ledger`/`markers` stores + data preserved; re-open without upgrade creates nothing (no data loss) — all via an injected compact deterministic fake IndexedDB exercising the real `openDb`/`onupgradeneeded` path (`fake-indexeddb` is not a project dependency; none added). Write/list round-trip; duplicate deterministic `recordId` (identical → one row + `duplicate`; distinct `createdAt` → two rows); best-effort failure returns `unavailable`/`failed` without throwing; simulated catch-site wrapper still yields its F1/G1 message when logging fails; transfer + receiving both round-trip; no over-collection (persisted keys ⊆ H7-A whitelist); in-memory parity (`dump().rejections` reflects committed rows; abort discards a write; rejection write does not disturb the four stock stores); newest-first ordering + `sourceType`/`branchId` filters.

### Evidence

- `npx vitest run reversalRejectionLog reversalLocalStore` → **19 passed** (2 files)
- `npx vitest run reversalRejectionRecord offlineReversalQueue manualReviewOps` → **61 passed** (regression green)
- Full web `npx vitest run` → **453 passed** (28 files); `npx tsc -b` → clean
- `npm --prefix functions run test:unit -- resolveReversal` → **43 passed** (server UNCHANGED)
- `git diff --check` clean (benign CRLF only); forbidden-area diff (UI pages/components, server resolver, Firestore rules, transfer write-path) EMPTY; `stash@{0}` untouched.

### Hidden risk

H7-C is the first edit to the protected offline/IndexedDB layer and the first DB schema-version bump; even with additive migration and best-effort logging, any accidental throw or coupling to stock/ledger/intent transactions could disturb the live reversal queue.

---

## Phase 7B-H7-A: Pure Latent Reversal Rejection Record (CLOSED / COMMITTED — `749e6e6`)

**Status:** CLOSED / COMMITTED — `749e6e6 feat(pos): add latent reversal rejection record model`. Authorization: Gemini / Tech Lead / CEO — Option A APPROVED. Clean baseline was: `e4afe1b` (docs sync, on `e80b2a3`).

### Problem

F1/G1 made fail-closed transfer/receiving evidence rejections (`TransferReversalEvidenceError` / `ReceivingReversalEvidenceError`) *visible* to the operator, but they are thrown BEFORE `createOfflineReversal` — so no intent, no local correction, no server call, and **no durable record** exist. Once the dialog closes, there is no forensic trail of what was blocked, when, on which document, or why. H7-A defines (model only) the foundation a future durable local rejection log can persist.

### Audit findings (gate before implementation)

- Rejection catch sites (left untouched): `TransferHistoryPage.tsx:166`, `AdminTransferPage.tsx:184`, `ReceivingEditPage.tsx:229`. Available at each throw: source doc id (`cancelTarget.id` / `receivingId`), branch (`fromBranchId` origin / receiving `branchId`), `staffId` (`user.id`), `observedDocumentUpdatedAt` (already ISO via `toObservedDocumentUpdatedAtIso`), and `err.code`. `evidenceSource` is generally NOT resolved at throw time → modeled optional.
- Error types: `ReceivingReversalEvidenceError` (17 codes), `TransferReversalEvidenceError` (26 codes), each carrying `.code`. Pure display helpers `get{Transfer,Receiving}ReversalEvidenceMessage(code)` already exist.
- A pure inventory-domain file is sufficient; **no `src/lib/pos/offline` touch required** (no scope expansion requested). The model imports nothing from the offline layer.

### What was added (pure latent only)

- **`src/lib/inventory/reversalRejectionRecord.ts`** (NEW) — self-contained, no I/O, no offline imports:
  - Types: `ReversalRejectionSourceType` (`'transfer' | 'receiving'`), `ReversalRejectionRecord`, `ReversalRejectionRecordInput`; error class `ReversalRejectionRecordError` (carries `field`).
  - `buildReversalRejectionRecord(input)` — fail-closed validation of required identity fields (sourceType must be transfer/receiving; sourceId/branchId/evidenceCode/evidenceMessage/createdAt non-empty after trim), omits absent optionals, derives a deterministic content-addressed `recordId`. Extra/unknown input keys are dropped (no over-collection).
  - `createReversalRejectionRecordId(input)` — deterministic `rej_<16hex>` id via a dependency-free FNV-1a-style 64-bit-ish hash over the canonical normalized content; matches the builder's embedded id; independent of input property order.
  - `serializeReversalRejectionRecord(record)` — canonical, fixed-key-order, stable JSON; omits absent optionals; safe for future durable storage.
- **`src/lib/inventory/reversalRejectionRecord.test.ts`** (NEW) — 20 tests: construction (transfer + receiving), required-field validation (fail-closed, per-field), optional omission (null/undefined/whitespace), no over-collected payload fields, unknown/future code safety, deterministic id (stable / matches builder / order-independent / changes on field diff), stable serialization (byte-identical, canonical order, optionals omitted), sourceType separation, plain-data JSON round-trip.

### Record fields (minimal; no over-collection)

`recordId`, `sourceType`, `sourceId`, `branchId`, `evidenceCode` (raw string — unknown-code safe, no union coupling), `evidenceMessage` (caller passes the already-computed friendly message), `evidenceSource?`, `staffId?`, `observedDocumentUpdatedAt?`, `createdAt` (caller-supplied so helpers stay pure/deterministic). **Deliberately excluded:** raw evidence payloads, item/lot/qty/cost lines, reason/note free-text, actor role, device fingerprint.

### What is NOT in this slice

No persistence wiring; no IndexedDB/localStorage/Firestore/network/queue write; no catch-site/UI change; no `src/lib/pos/offline` change; no server resolver (`functions/`) / Firestore rules change; no transfer/receiving write-path change; no validation/fail-closed/thrown-error change. Nothing in production references the new module yet.

### Files changed (code)

```
src/lib/inventory/reversalRejectionRecord.ts        (NEW — pure builder + serializer + id + types)
src/lib/inventory/reversalRejectionRecord.test.ts   (NEW — 20 tests)
```

### Evidence

- `npx vitest run reversalRejectionRecord` → **20 passed**
- `npx vitest run reversalCoordinator` → **111 passed** (regression green)
- Full web `npx vitest run` → **434 passed** (26 files); `npx tsc -b` → clean
- `npx vitest run transferCrud` → **18 passed**; `transferReversalEvidence` → **41 passed**; `npm --prefix functions run test:unit -- resolveReversal` → **43 passed** (server UNCHANGED)
- `git diff --check` clean; only the two new untracked files (no staged files); `stash@{0}` untouched; no diff under `src/lib/pos/offline`, `functions/src/resolveReversal.ts`, `firestore.rules`, transfer write-path, or UI pages/components.

### Hidden risk

H7-A defines the durable rejection record model, but actual persistence wiring remains a future separately authorized slice; wiring it too early would risk coupling a new write path to the protected offline/IndexedDB layer.

---

## Phase 7B-H6-G1: Receiving Evidence Rejection Visibility & Void Error Handling (CLOSED / COMMITTED — `e80b2a3`)

**Status:** CLOSED / COMMITTED — `e80b2a3 feat(pos): surface receiving reversal evidence rejection reasons`. Authorization: Gemini / Tech Lead / CEO — Option A APPROVED. Clean baseline was: `6b6a5fd` (D6 docs sync, on `3a3d202`).

### Audit findings (gate before implementation)

- `ReceivingEditPage.handleVoid` (`src/pages/ReceivingEditPage.tsx`) calls `executeReceivingReversal` and previously had **no try/catch** — but its caller `ReceivingForm.handleVoidConfirm` already wraps `onVoid` in try/catch and renders `err.message` in the `rcv-error-banner` (the void dialog stays open). So a fail-closed receiving rejection was **caught and shown, but only via the single generic `RECEIVING_EVIDENCE_INCOMPLETE_MESSAGE`** shared by all 17 codes — the specific code was discarded. This is the same message-granularity gap F1 closed for transfers, **not** a true unhandled-promise rejection (the roadmap's worst-case framing was over-stated; corrected here).
- `AdminReceivingPage` voids through the **legacy `cancelReceiving`** path (no `executeReceivingReversal`, no `ReceivingReversalEvidenceError`), so it needs no parity. The authorized file list (`reversalCoordinator.ts(.test)`, `ReceivingEditPage.tsx`) was therefore sufficient — **no scope expansion requested**.
- The fix stays entirely in `ReceivingEditPage.tsx`: catch `ReceivingReversalEvidenceError` and re-throw a friendly message to `ReceivingForm`'s existing banner. `ReceivingForm.tsx` is NOT edited.

### What was added (display-only)

- **`src/lib/inventory/reversalCoordinator.ts`** — `RECEIVING_REVERSAL_EVIDENCE_MESSAGES: Record<ReceivingReversalEvidenceCode, string>` (exhaustive — TS build fails on an unmapped code) + pure `getReceivingReversalEvidenceMessage(code): string`; unknown/unexpected code falls back to `RECEIVING_EVIDENCE_INCOMPLETE_MESSAGE`. Mirrors the F1 transfer helper. The thrown error type/`code`/`message` and all receiving validation are unchanged.
- **`src/pages/ReceivingEditPage.tsx`** — `handleVoid` wrapped in try/catch. On `ReceivingReversalEvidenceError`, re-throws `new Error(getReceivingReversalEvidenceMessage(err.code) + " (รหัส: <code>)")` so the existing void-dialog banner shows the specific reason; any other error is re-thrown unchanged (not swallowed → dialog keeps its prior generic fallback). Success toast / navigation / manual-review wording, validation order, authority gating, and the form's busy/`finally` cleanup are all unchanged; no success/navigation path runs on failure.

### What is NOT in this slice

No change to `resolveReceivingReversalEffects` / `validateReceivingHeaderEvidence` / `executeReceivingReversal` control flow, the thrown error, the fail-closed policy, `createOfflineReversal`, the offline queue schema / IndexedDB stores / `src/lib/pos/offline`, the server resolver, transfer behavior, `transferCrud`/`transferDevMock`/`transferTypes`, `ReceivingForm.tsx`, `AdminReceivingPage`, `cancelReceiving`. **No durable local rejection log** (a future separately-authorized slice).

### Files changed (code)

```
src/lib/inventory/reversalCoordinator.ts        (+ receiving message map + getReceivingReversalEvidenceMessage)
src/lib/inventory/reversalCoordinator.test.ts   (+4 H6-G1 tests; 111 file total)
src/pages/ReceivingEditPage.tsx                 (handleVoid try/catch: evidence-error display only)
```

### Evidence

- `npx vitest run reversalCoordinator` → **111 passed** (+4 H6-G1)
- `npx vitest run transferCrud` → **18 passed**; `transferReversalEvidence` → **41 passed** (regression green)
- Full web `npx vitest run` → **414 passed** (25 files); `npx tsc -b` → clean
- `npm --prefix functions run test:unit -- resolveReversal` → **43 passed** (server UNCHANGED)
- `git diff --check` clean; `stash@{0}` untouched; **no diff under `src/lib/pos/offline`**, no server resolver diff, no transfer write-path diff.

### Hidden risk

G1 improves receiving void rejection visibility, but it does not create a durable rejection log; durable local rejection logging remains a future separately authorized slice.

---

## Phase 7B-H6-F1: Transfer Reversal Evidence Rejection Visibility (CLOSED / COMMITTED — `3a3d202`)

**Status:** CLOSED / COMMITTED — `3a3d202 feat(pos): surface transfer reversal evidence rejection reasons`. Authorization: Gemini / Tech Lead / CEO — Option A APPROVED. Clean baseline was: `638e3a0` (docs sync after H6-E2-C closure, on `fe3ff44`).

### Problem

When H6-E2-C rejects malformed transfer header evidence, it throws `TransferReversalEvidenceError` BEFORE `createOfflineReversal` — so no intent, no local correction, no server call, no durable record. The operator previously saw only one generic Thai message for all 26 distinct codes, and the specific code was discarded. F1 makes the already-computed reason legible **without changing the fail-closed behavior**.

### What was added (display-only)

- **`src/lib/inventory/reversalCoordinator.ts`** — `TRANSFER_REVERSAL_EVIDENCE_MESSAGES: Record<TransferReversalEvidenceCode, string>` (exhaustive — TS build fails on an unmapped code) + pure `getTransferReversalEvidenceMessage(code): string`. Unknown/unexpected code falls back to `TRANSFER_EVIDENCE_INCOMPLETE_MESSAGE`. The thrown error type/`code`/`message` and all validation are unchanged.
- **`src/pages/inventory/TransferHistoryPage.tsx`** & **`src/pages/admin/AdminTransferPage.tsx`** — the cancel-handler `catch` adds an `instanceof TransferReversalEvidenceError` branch that toasts `getTransferReversalEvidenceMessage(err.code)` + `(รหัส: <code>)`. The `else` keeps the prior generic fallback. No change to validation call order, executor input, branch-permission logic, cancellation/success flow, or `finally` busy-cleanup. Admin's separate `editBranchTransfer` catch is untouched.
- **`src/pages/ManualReviewOpsPage.tsx`** — a **page-local** `getEvidenceSourceLabel(source): string` (`header_snapshot`→หลักฐานจากหัวเอกสาร; `legacy_subcollection`→รายการย่อยเดิม; absent/unknown→ไม่ระบุ) and a read-only "แหล่งหลักฐาน" column rendering it over the existing `it.evidenceSource` intent field. The helper is defined inside the page module — **no runtime helper added to `src/lib/pos/offline`**. No query/schema/store/mutation change.

### Codex blocker fix (offline runtime scope violation)

Codex returned FAIL: the first cut added a runtime helper `getEvidenceSourceLabel` (+ test) to `src/lib/pos/offline/manualReviewOps.ts(.test.ts)`, but `src/lib/pos/offline` runtime code was strictly out of scope. Fix: both offline files reverted to **no diff** (`git checkout`); the label mapping inlined page-local in `ManualReviewOpsPage.tsx`. The 3 removed offline-helper tests dropped the full web count 413 → **410**. No other behavior changed.

### What is NOT in this slice

No change to `validateTransferHeaderEvidence` / `resolveTransferReversalEffects` / `executeTransferReversal` control flow, the thrown error, the fail-closed policy, `createOfflineReversal`, the offline queue schema / IndexedDB stores, **any `src/lib/pos/offline` runtime code**, the server resolver, the H6-E2-B write path, transfer creation, receiving, `cancelBranchTransfer`/`editBranchTransfer`. **No durable local rejection log** (a future separately-authorized slice).

### Files changed (code)

```
src/lib/inventory/reversalCoordinator.ts        (+ message map + getTransferReversalEvidenceMessage)
src/lib/inventory/reversalCoordinator.test.ts   (+4 H6-F1 message-map tests; 107 file total)
src/pages/inventory/TransferHistoryPage.tsx     (catch: evidence-error display only)
src/pages/admin/AdminTransferPage.tsx           (cancel catch: evidence-error display only)
src/pages/ManualReviewOpsPage.tsx               (+ page-local getEvidenceSourceLabel + read-only evidenceSource column)
```

### Evidence

- `npx vitest run reversalCoordinator` → **107 passed** (+4 H6-F1)
- `npx vitest run transferCrud` → **18 passed**; `transferReversalEvidence` → **41 passed** (regression green)
- Full web `npx vitest run` → **410 passed** (25 files); `npx tsc -b` → clean
- `npm --prefix functions run test:unit -- resolveReversal` → **43 passed** (server UNCHANGED)
- `git diff --check` clean; `stash@{0}` untouched; **no diff under `src/lib/pos/offline`**, no server resolver diff, no transfer write-path diff.

### Hidden risk

H6-F1 improves operator visibility for local pre-queue rejection reasons, but it does not create a durable rejection log; durable local rejection logging remains a future separately authorized slice.

---

## Phase 7B-H6-E2-C: Transfer Evidence Coordinator Validation (CLOSED / COMMITTED — `fe3ff44`)

**Status:** CLOSED / COMMITTED — `fe3ff44 feat(pos): validate transfer reversal header evidence`. Authorization: CEO Option A — APPROVED. Clean baseline was: `82d3352` (H6-E2-B).

### Policy

```
valid header evidence present   → use header evidence / evidenceSource: header_snapshot
invalid header evidence present → reject / NO fallback (no queue write, no local correction)
header evidence absent          → legacy item-subcollection fallback / evidenceSource: legacy_subcollection
```

Hardens queue-first local correction integrity against a partial/empty item-subcollection fetch. Server authority is UNCHANGED — the resolver re-reads transfer items and ignores client evidence.

### What was added (`src/lib/inventory/reversalCoordinator.ts`)

- **`TransferReversalInput.transferHeaderEvidence?: unknown`** — the transfer header `reversalEvidence` snapshot from the loaded Firestore doc, UNTRUSTED at this boundary (never typed as `TransferReversalEvidence`).
- **`TransferReversalOutcome.evidenceSource: ReversalEvidenceSource`** — mirrors the receiving outcome.
- **`TransferReversalEvidenceCode`** extended with 15 `header_*` codes (`header_not_object`, `header_unsupported_version`, `header_wrong_source`, `header_branch_mismatch`, `header_empty_effects`, `header_malformed_effect`, `header_missing_product_id`, `header_invalid_direction`, `header_invalid_branch`, `header_invalid_lot_id`, `header_non_finite_qty`, `header_non_positive_qty`, `header_item_count_mismatch`, `header_total_qty_mismatch`, `header_balance_mismatch`).
- **`assertTransferReversalHeaderFields` / `assertTransferReversalItems`** — `assertTransferReversalInput` split: header fields (transferId/branches/staff/reason) validated on BOTH paths; item validation only on the legacy path (so the header path succeeds even with empty/partial items). Original `assertTransferReversalInput` retained as a composed wrapper.
- **`validateTransferHeaderEvidence(raw, fromBranchId, toBranchId): OriginalStockEffect[]`** — fail-closed, untrusted-boundary type-guards FIRST (object/version/source/branch-match), then per-effect validity + direction-bound branch (`dest_gain`→to, `source_loss`→from), then checksums (`itemCount` = source rows, `totalQtyBase` = Σ source qty, with an explicit `Number.isFinite` guard so a `NaN`/±Infinity total cannot slip through `Math.abs(NaN) > EPSILON === false`) + dual-branch per-product balance + row-count parity, all against the RAW persisted entries. Projects `dest_gain`→`{to, lotId:null, +qty}` and `source_loss`→`{from, lotId:e.lotId??null, -qty}` (matching `buildTransferReversalEffects`). Self-consistent; does NOT consult the item subcollection.
- **`resolveTransferReversalEffects(input)`** — precedence: header present → validate-or-throw (no fallback) → `header_snapshot`; header absent → legacy item gate + `buildTransferReversalEffects` → `legacy_subcollection`.
- **`executeTransferReversal`** — runs `assertTransferReversalHeaderFields` → `resolveTransferReversalEffects` → sets `evidenceSource` on `CreateReversalInput` and the returned outcome.

### Page activation (data argument only)

- **`src/pages/inventory/TransferHistoryPage.tsx`** and **`src/pages/admin/AdminTransferPage.tsx`** pass `transferHeaderEvidence: cancelTarget.reversalEvidence` to `executeTransferReversal`. No route logic, branch gating, modal behavior, layout, or cancel/edit behavior changed. Loaders already spread the full `InventoryTransfer` doc, so the evidence is in hand with no loader change.

### What is NOT in this slice

No transfer write-path change (`transferCrud.ts`/`transferDevMock.ts`/`transferTypes.ts` untouched). No server resolver change (`functions/src/resolveReversal.ts` untouched — re-reads items, remains authoritative). No offline queue schema change (`evidenceSource` already existed as optional on `CreateReversalInput`/`OfflineReversalIntent`). No new enum value. No new files. No receiving/manual-review/POS change.

### Files changed (code)

```
src/lib/inventory/reversalCoordinator.ts       (transferHeaderEvidence, validateTransferHeaderEvidence, resolveTransferReversalEffects, gate split, evidenceSource)
src/lib/inventory/reversalCoordinator.test.ts  (+27 H6-E2-C tests; 103 file total)
src/pages/inventory/TransferHistoryPage.tsx     (+transferHeaderEvidence arg)
src/pages/admin/AdminTransferPage.tsx           (+transferHeaderEvidence arg)
```

### Evidence

- `npx vitest run reversalCoordinator` → **103 passed** (+27 H6-E2-C)
- `npx vitest run transferCrud` → **18 passed**; `npx vitest run transferReversalEvidence` → **41 passed** (regression green)
- Full web `npx vitest run` → **406 passed** (25 files); `npx tsc -b` → clean
- `npm --prefix functions run test:unit -- resolveReversal` → **43 passed** (server UNCHANGED)
- `git diff --check` clean; `stash@{0}` untouched; forbidden-path diff (write-path/server/offline schema) EMPTY.

### Codex blocker fix (non-finite `totalQtyBase`)

Codex review returned FAIL on one blocker: `validateTransferHeaderEvidence` accepted `totalQtyBase: NaN` because `typeof NaN === 'number'` and `Math.abs(NaN) > EPSILON === false`. Fixed by adding `!Number.isFinite(ev.totalQtyBase)` to the checksum guard (same `header_total_qty_mismatch` rejection). +3 regression tests (`NaN`, `Infinity`, `-Infinity`) prove fail-closed (no queue write, no local correction, no fallback). No other behavior changed.

### Hidden risk

H6-E2-C activates fail-closed header evidence preference, so malformed post-E2-B evidence will BLOCK local queue-first reversal (→ manual review) rather than silently falling back; this is intentional, and server authority remains unchanged.

---

## Phase 7B-H6-E2-B: Write Transfer Evidence Header at Completion (CLOSED / COMMITTED — `82d3352`)

**Status:** CLOSED / COMMITTED (`82d3352`). Authorization: CEO Option A — APPROVED. Clean baseline: `53a2123` (H6-E2-A).

### What was added

- **`src/lib/inventory/transferTypes.ts`** — `import type { TransferReversalEvidence }` from `./transferReversalEvidence`; `reversalEvidence?: TransferReversalEvidence` added as optional field on `InventoryTransfer` (absent on legacy docs — no backfill).
- **`src/lib/inventory/transferCrud.ts`** — in `confirmBranchTransfer`, after `linePlans` finalization (end of Phase 2) and before Phase-3 writes: builds `TransferReversalEvidenceInput` from `linePlans` (with FIFO `sourceLotDetails`, `receivedAtMs ?? null`, `costPerUnit`), calls `buildTransferReversalEvidence` then `assertTransferReversalEvidenceCoversCompletion` fail-closed, then writes `reversalEvidence` on the `tx.set(transferRef, {...})` atomically. Evidence `createdAt: new Date().toISOString()` (client ISO string, audit-only); `createdBy: form.staffId`. Header `createdAt`/`updatedAt` remain `serverTimestamp()`.
- **`src/lib/inventory/transferDevMock.ts`** — `devConfirmBranchTransfer` mirrors production: builds evidence input from `savedItems`, calls builder + assertion, writes `reversalEvidence` on the in-memory `InventoryTransfer` doc (`now.toISOString()` for `createdAt`).

### What is NOT in this slice

No coordinator validation of the persisted evidence at reversal time. `reversalCoordinator.ts`, `TransferHistoryPage`, `AdminTransferPage`, server resolver, offline queue, Firestore rules — all UNCHANGED. H6-E2-C (coordinator validation) remains a future slice.

### Files changed (code)

```
src/lib/inventory/transferTypes.ts       (+ reversalEvidence?: TransferReversalEvidence field)
src/lib/inventory/transferCrud.ts        (evidence build + tx.set update)
src/lib/inventory/transferDevMock.ts     (evidence build + doc update)
src/lib/inventory/transferCrud.test.ts   (+8 H6-E2-B tests; 18 transferCrud total)
```

### Evidence

- `npx vitest run transferCrud` → **18 passed** (+8 H6-E2-B)
- `npx vitest run transferReversalEvidence` → **41 passed** (regression green)
- Full web `npx vitest run` → **379 passed** (25 files); `npx tsc -b` → clean
- `npm --prefix functions run test:unit -- resolveReversal` — resolver UNCHANGED; prior run **43 passed**
- `git diff --check` clean; `stash@{0}` untouched; no diff in any forbidden file.

### Hidden risk

H6-E2-B persists the evidence snapshot but does not yet validate it at reversal time — until H6-E2-C wires the coordinator to read and verify the header evidence before accepting a transfer reversal, the snapshot is audit-only (not fail-closed on the reversal path for transfers).

---

## Phase 7B-H6-E2-A: Pure Transfer Evidence Builder + Dual-Branch Invariant (CLOSED / COMMITTED — `53a2123`)

**Status:** closed and committed. **Commit:** `53a2123 feat(pos): implement dual-branch transfer reversal evidence builder and invariants`. Authorization: CEO Option A — APPROVED. Clean baseline: `8a3d03f` (H6-E1, which is itself stacked on `bb30881`).

### What was added

New pure file `src/lib/inventory/transferReversalEvidence.ts` (no Firestore, no runtime queue). New test file `src/lib/inventory/transferReversalEvidence.test.ts`.

#### Evidence shape

```ts
version: 1
source: 'transfer_completion'
fromBranchId, toBranchId
itemCount      // derived: number of input items (NOT number of effect rows)
totalQtyBase   // derived: sum of input transferQty values
effects: TransferReversalEvidenceEffect[]  // see below
createdAt: string
createdBy?: string | null
```

Each effect row:
```ts
{ productId, branchId, direction: 'dest_gain' | 'source_loss', qtyBase, lotId?: string | null }
```

#### Builder behavior (`buildTransferReversalEvidence`)

- Validates input fail-closed: missing/empty `fromBranchId`/`toBranchId`/`items`/`productId`, same branch, zero/negative/non-finite `transferQty` all throw `TransferReversalEvidenceError` before any effects are produced.
- For each item, emits exactly two effects:
  - `dest_gain`: `branchId = toBranchId`, positive `qtyBase = transferQty`, `lotId = null`.
  - `source_loss`: `branchId = fromBranchId`, positive `qtyBase = transferQty`, `lotId` = single-lot audit id or `null` for multi-lot (consistent with `buildTransferReversalEffects`).
- Derives `itemCount` and `totalQtyBase` — they cannot drift from effects.
- Sorts effects deterministically: `productId | direction | branchId | lotId` — output is order-stable regardless of input order.

#### Completeness invariant (`assertTransferReversalEvidenceCoversCompletion`)

Proves (throws fail-closed on any violation):
1. `evidence.version === 1`, `evidence.source === 'transfer_completion'`.
2. `fromBranchId` / `toBranchId` present in evidence.
3. Every effect: non-empty `productId`, valid direction, `branchId` matches from/to, positive finite `qtyBase`.
4. Input items valid (non-empty, each has productId + positive finite transferQty).
5. `evidence.itemCount === input.items.length`.
6. `evidence.totalQtyBase === Σ(input.transferQty)` (float tolerance `1e-9`).
7. Per-product dual-branch balance: for every product, `Σdest_gain == Σsource_loss == Σinput`. Extra products in effects that aren't in input also fail closed.

#### Source lot identity

Audit-only. Builder uses `null` for multi-lot source transfers. The invariant does NOT require a non-null `lotId` on source_loss effects — no over-rejection gate.

### What is NOT in this slice

No runtime wiring. No header write at completion. No coordinator read/validation. No evidence persistence. No Firestore rule change. `transferCrud.ts`, `reversalCoordinator.ts`, `transferDevMock.ts`, UI pages, server resolver, offline queue — all UNCHANGED.

**H6-E2-B (header write at transfer completion) is now delivered (see section above). H6-E2-C (coordinator validation) remains a future slice.**

### Files changed (code)

```
src/lib/inventory/transferReversalEvidence.ts       (NEW — pure builder + invariant)
src/lib/inventory/transferReversalEvidence.test.ts  (NEW — 41 tests)
```

### Evidence

- `npx vitest run transferReversalEvidence` → **41 passed** (36 original + 5 branch-direction blocker-fix tests)
- `npx vitest run transferCrud` → **10 passed** (regression green)
- `npx vitest run reversalCoordinator` → **76 passed** (regression green)
- Full web `npx vitest run` → **371 passed** (25 files); `npx tsc -b` → clean
- `npm --prefix functions run test:unit -- resolveReversal` → **43 passed** (resolver UNCHANGED)
- `git diff --check` clean; no diff in transferCrud / reversalCoordinator / transferDevMock / TransferHistoryPage / AdminTransferPage / resolveReversal / offline queue; `stash@{0}` present and untouched.

### Hidden risk

H6-E2-A proves the evidence math but remains latent; it does not yet protect live queue-first local correction until a later write/validation slice is authorized.

---

## Phase 7B-H6-E1: Transfer `updatedAt` Stamping (CLOSED / COMMITTED — `8a3d03f`)

**Status:** closed and committed. **Commit:** `8a3d03f feat(pos): stamp updatedAt on transfer completion for stale-client protection`. Authorization: CEO Option A — APPROVED (timestamp-only). Clean baseline before H6-E1: `bb30881`.

### Problem closed

Pre-E1, a freshly `completed` transfer carried `createdAt` but **no** `updatedAt` (neither `confirmBranchTransfer` nor `devConfirmBranchTransfer` wrote it; only `cancelBranchTransfer` did). The server H4/H6-C stale-client guard `isClientObservationStale` reads `serverDoc.updatedAt`; with it absent the guard returned "not stale" (doubly inert alongside the omitted client observation). So the transfer stale-client protection was fail-open / fresh-by-default for new transfers.

### What was added / changed

- `src/lib/inventory/transferCrud.ts` — `confirmBranchTransfer` Phase-3 header `tx.set` now writes `updatedAt: now` next to `createdAt: now` (both `serverTimestamp()`). `updatedAt === createdAt` at inception is expected.
- `src/lib/inventory/transferDevMock.ts` — `devConfirmBranchTransfer` writes `updatedAt: ts(now)` on the created doc, mirroring the production shape.
- No other write path changed: `cancelBranchTransfer` already stamped `updatedAt`; `editBranchTransfer` creates the new transfer via `confirmBranchTransfer` so edit-created docs inherit the stamp. `InventoryTransfer.updatedAt` was already optional (no type change).
- **No** page/coordinator/resolver/offline-queue change — H6-D2's `toObservedDocumentUpdatedAtIso(cancelTarget.updatedAt)` capture now simply starts receiving a real value, so the guard activates end-to-end.

### Tests (`src/lib/inventory/transferCrud.test.ts`)

- Production: `confirmBranchTransfer` created header includes a timestamp-compatible `updatedAt` and `createdAt` remains present (`status: 'completed'`).
- Dev/mock: `devConfirmBranchTransfer` created doc includes a timestamp-compatible `updatedAt` and `createdAt`.
- The transfer stale-client server regression already exists in `functions/src/resolveReversal.test.ts` (lines 454–468: stale → `stale_client_observation` mutation-free; fresh → confirmed) and remains green — no resolver-test edit needed.

### Evidence

- `npx vitest run transferCrud` → **10 passed**; `npx vitest run reversalCoordinator` → **76 passed**; full web `npx vitest run` → **330 passed** (24 files); `npx tsc -b` → clean.
- `npm --prefix functions run test:unit -- resolveReversal` → **43 passed** (resolver unchanged).
- `git diff --check` clean; `stash@{0}` untouched; no UI / coordinator / resolver / offline-queue diff.

### Legacy docs policy (accepted)

No backfill. Existing transfers without `updatedAt` stay fresh-by-default (guard inert for them); the server reversal mutation remains authoritative through the existing guards. New transfers get reliable `updatedAt`.

### Out of scope (unchanged)

Transfer header evidence/checksum snapshot (future **H6-E2**), server resolver implementation, offline queue schema, Firestore rules, receiving behavior, H6-D2 UI route wiring/coordinator, `cancelBranchTransfer`/`editBranchTransfer` behavior, `sent→received` lifecycle refactor.

### Hidden risk

Legacy transfer docs without `updatedAt` remain fresh-by-default (stale-client guard inert for them), but new transfers now activate the guard end-to-end; separately, a metadata-only `reportTransferDiscrepancy` writes a subcollection without advancing the header `updatedAt`, so a discrepancy report is not seen as a state advance by the guard (acceptable — it mutates no stock).

---

## Phase 7B-H6-D2: UI Route Wiring & Legacy Path Retirement (CLOSED / COMMITTED — `bb30881`)

**Status:** implemented + Codex blocker fixed; not committed; not closed. Authorization: CEO Option A — APPROVED. Clean baseline before H6-D2: `4aa8065`.

### Codex blocker fix — origin-branch authority gate

**Codex returned FAIL:** `TransferHistoryPage` lists both outgoing (`fromBranchId`) and incoming (`toBranchId`) transfers, and the queue-first executor applies the local IndexedDB correction + queue write BEFORE server sync, using `fromBranchId` as the authority branch — so a destination-branch user could locally apply/queue a reversal for an origin branch they don't control (server would only reject it afterwards). **Fix:** new pure, fail-closed predicate `canBranchReverseTransfer(currentBranchId, fromBranchId)` (`reversalCoordinator.ts`) — `true` only when the active branch trim-equals the transfer origin, `false` for any missing/empty/whitespace id or a destination-only branch. `TransferHistoryPage` uses it to gate (a) the modal entry point — `onCancelTransfer` is only wired when active branch === origin, so an incoming transfer offers no reversal control — and (b) `handleCancel`, which hard early-returns (with a Thai "only the source branch can reverse" toast) BEFORE `executeTransferReversal`, so no local correction or queue write occurs on the destination path. `AdminTransferPage` is the HQ global-admin surface (server `hasBranchAccess` returns `true` for an `admin` token), so it intentionally remains ungated. Verified against the server model: `resolveTransferReversal` checks origin-branch authority via `checkActorAuthority(..., fromBranchId)` and `hasBranchAccess` grants admins all branches.

### What was added / changed

- **D2-α prerequisite cleanup** (`reversalCoordinator.ts`):
  - Removed the stale `TRANSFER_REVERSAL_DEFERRED_NOTE` constant + its JSDoc/test references. After H6-C (resolver activation) and H6-D1 (latent executor) its claim that completed transfers were not resolver-compatible was false. The module doc-comment + H6-D1 banner were refreshed to the queue-first-live wording.
  - Tightened `assertTransferReversalInput`: whitespace-only `productId` now fails closed as `missing_product_id` (`.trim()` check); trim-equal `fromBranchId`/`toBranchId` now fail closed as `same_branch`.
- **D2-β UI route wiring:**
  - `decideReversalRoute('transfer')` now returns `transfer_queue_first` (and `transfer_legacy_executor` is removed from the `ReversalRoute` union).
  - `TransferHistoryPage` + `AdminTransferPage` confirmed-cancel handlers call `executeTransferReversal(createDefaultReversalCoordinatorDeps(), …)` queue-first. Each fetches transfer items fresh via `fetchTransferItems(cancelTarget.id)` and builds the payload: `transferId`, `fromBranchId`, `toBranchId`, mapped items (`productId`/`transferQty`/`sourceLotDetails`), `reason` (+ `note` on TransferHistory), `actorRole: user.role`, `staffId`, and `observedDocumentUpdatedAt: toObservedDocumentUpdatedAtIso(cancelTarget.updatedAt)`. Outcome wording mirrors the receiving reversal UX (manual-review / server-accepted / queued-offline).
  - Legacy `cancelBranchTransfer` import + call removed from BOTH pages. `AdminTransferPage` keeps its `editBranchTransfer` import/use; `transferCrud.ts` is untouched, so `editBranchTransfer` still performs its internal `cancelBranchTransfer` cancel-then-recreate step.

### Tests (`reversalCoordinator.test.ts`)

- `decideReversalRoute('transfer')` → `transfer_queue_first` (route flip); the H6-D1 "route NOT flipped" assertion inverted accordingly.
- New D2-α validation cases: whitespace-only `productId` → `missing_product_id`; trim-equal branch ids → `same_branch`.
- New H6-D2 **source-level mutual-exclusion** suite (via Vite `?raw` imports of the two pages + `transferCrud.ts`): neither page imports/calls `cancelBranchTransfer`; both call `executeTransferReversal` with the required payload fields; `AdminTransferPage` keeps `editBranchTransfer`; `editBranchTransfer` in `transferCrud.ts` still awaits `cancelBranchTransfer` internally. (Page components carry a heavy Firebase/router/auth/modal harness, so the guarantees are proven by source inspection rather than mounting — the deliberate D2 limitation.)

### Evidence (post blocker fix)

- `npx vitest run reversalCoordinator` → **76 passed**; full web `npx vitest run` → **328 passed** (24 files); `npx tsc -b` → clean.
- `npm --prefix functions run test:unit -- resolveReversal` → **43 passed** (server resolver unchanged — regression green).
- `git diff --check` clean; `stash@{0}` untouched; no forbidden areas touched.

### Out of scope (unchanged)

Server resolver (`functions/src/resolveReversal.ts(.test.ts)`), offline-queue schema, Firestore rules, receiving/POS/cart/checkout/returns/RTV, `transferCrud.ts` (`cancelBranchTransfer`/`editBranchTransfer` behavior), transfer header evidence/checksum snapshot, `updatedAt` stamping at transfer completion (H6-E), `sent→received` lifecycle refactor.

### Hidden risk

Page-component guarantees are proven by source-level import/call regex inspection (the pages carry a heavy runtime harness), so a future refactor re-introducing a legacy `cancelBranchTransfer` call through an alias or indirection could evade the guards without failing the suite.

---

## Phase 7B-H6-C: Server Resolver Activation + Tests (IMPLEMENTED — AWAITING CODEX REVIEW)

**Status:** implemented; not committed; not closed. Authorization: CEO Option A — APPROVED (server resolver + tests only). Clean baseline before H6-C: `7bd74c1`.

### What was added

- **Centralized transfer reversible-state policy** in `functions/src/resolveReversal.ts`: `REVERSIBLE_TRANSFER_STATES = {'completed'}` (single source of truth) + `isTransferStatusReversible(status)` predicate, consulted at the one resolver gate. `completed` is the live reversible state (H6-B Option A) — "eligible under the strict guards," **not** unconditionally reversible. No scattered `status === 'completed'` checks.
- **Guard ordering preserved:** `source_document_not_found` → authority/PIN → H4 stale-client guard → `already_reversed` (cancelled/reversedBy, before the eligibility gate) → eligibility gate → dest stock-counter + active-lot sufficiency → dual-branch writes → intent/audit. Header doc-comment updated to Option A.
- **No client/UI/offline-queue change.** Activation is latent in production (no caller currently queues a `transfer_reversal`).

### Tests (`functions/src/resolveReversal.test.ts`)

- Existing transfer/H4-transfer assertions updated to the live model (`seedTransfer` default `completed`; the old `sent`/`received`-reversible assertions intentionally inverted per Option A).
- New coverage: `completed` confirmed; `sent`/`received` not live-eligible → `source_document_not_reversible`; `cancelled` → `already_reversed` (zero mutation, before gate); `completed` + dest stock insufficient → `stock_conflict` (zero mutation); + dest lot insufficient → `lot_conflict` (zero mutation); stale-client guard fires for `completed`; valid reversal restores source lots at original `costPerUnit`+`receivedAt` and writes dual `stockMovements`, marking the transfer reversed only after mutation; oversell-remainder restoration; idempotency (duplicate → `duplicate_confirmed`, single audit) + already-reversed-by-different-key; Staff wrong-PIN → `invalid_pin` zero mutation.

### Evidence

- `npm --prefix functions run build` → clean.
- `npx vitest run resolveReversal` → **43 passed**; full functions `npx vitest run` → **112 passed** (8 files). Receiving + H4 tests green.
- `git diff --check` clean; `stash@{0}` untouched; no forbidden areas touched.

### Out of scope (unchanged)

Client queue-first transfer reversal / `executeTransferReversal`, transfer UI/Admin routing, legacy `cancelBranchTransfer` retirement, transfer evidence/checksum snapshot, `updatedAt` stamping at completion, `sent→received` lifecycle refactor, Firestore rules, receiving paths.

### Hidden risk

The server gate now reverses `completed` transfers, but no client queues a transfer reversal yet — so the capability is inert in production until H6-D; a premature direct callable invocation would now execute a real dual-branch reversal (still under all guards).

---

## Phase 7B-D4: Docs/Context Sync After H5 Closure (IN PROGRESS — not yet committed)

**Status:** docs-only; not committed; not closed. H5 commit: `4762d97`. No source code or tests modified. D4 updates `Task.md`, `Context.md`, and this report to reflect H5 closure, record End-to-End Receiving Reversal Hardening as functionally complete, and queue H6 as read-only planning only.

### Authorization

CEO Option A approved. D4 executing immediately after H5 closure.

### H5 closure baseline

- H5 commit: `4762d97` — `feat(pos): wire client observation timestamp for reversals`.
- Post-H5-commit working tree was **clean** — confirmed by `git status --short` before D4 edits.
- `stash@{0}` present and untouched throughout.

### What D4 updated

- `Task.md` — H5 marked CLOSED/COMMITTED; commit recorded; milestone recorded; D4 section added; H6 queued as read-only planning.
- `Context.md` — H5 moved to closed tracks; End-to-End Receiving Reversal Hardening recorded as complete; H6 queued as read-only planning; key boundaries updated.
- `docs/reports/latest-report.md` — this section; H5 section updated to CLOSED/COMMITTED.

### Next step after D4

**Phase 7B-H6: Transfer Reversal Planning / Environment Audit** — read-only planning only. Inspect transfer lifecycle, Sent/Received/Completed states, existing transfer reversal resolver branch, and map how Transfer can safely join the queue-first pattern. **No code changes.** No implementation until Tech Lead approves a small proposal.

---

## Phase 7B-H5: Wire Client Observation Timestamp Payload (CLOSED / COMMITTED)

**Status:** closed and committed. **Commit:** `4762d97` — `feat(pos): wire client observation timestamp for reversals`. Authorization: Option A — APPROVED (receiving-only). CEO Option B — APPROVED WITH NOTES (closure). Post-commit working tree **clean**. `stash@{0}` present and untouched. No forbidden areas touched. **Milestone: End-to-End Receiving Reversal Hardening functionally complete** (H4 server guard + H5 client payload wiring).

### What was added (receiving-only client/offline payload wiring)

- `ReceivingEditPage.handleVoid` captures the loaded receiving doc's `updatedAt` and converts it defensively to ISO 8601 via the new exported helper `toObservedDocumentUpdatedAtIso` (handles Firestore `Timestamp`, `Date`, epoch millis, ISO string, `{seconds,nanoseconds}`; returns `undefined` — omit — on missing/malformed input).
- The value flows `ReceivingReversalInput` → `CreateReversalInput` → durable `OfflineReversalIntent` as the optional **internal** field `observedDocumentUpdatedAt` (ISO 8601), persisted so a later (possibly much-delayed) sync forwards the SAME observation.
- `toResolveRequest` maps the internal field to the **server wire** field `clientObservedDocumentUpdatedAt` ONLY when present — omitting it (never `''`/`null`) otherwise.

### Behavior guarantees (proven by tests)

- **End-to-end activation:** a receiving reversal now carries `clientObservedDocumentUpdatedAt`, so the H4 guard can detect a stale client view.
- **Backward compatible:** legacy queued intents (no `observedDocumentUpdatedAt`) → request omits the field → H4 guard stays inert (fresh). No migration.
- **Idempotency unchanged:** the observation is excluded from `deriveReversalIds` (id / idempotencyKey / localMutationId); two intents differing only by the observation derive identical ids.
- **Local stock correction unchanged:** immediate IndexedDB deltas/counters are identical with and without the observation.

### Files changed

- `src/pages/ReceivingEditPage.tsx`, `src/lib/inventory/reversalCoordinator.ts`, `src/lib/pos/offline/offlineReversalTypes.ts`, `src/lib/pos/offline/offlineReversalLogic.ts`, `src/lib/pos/offline/syncOfflineReversals.ts`.
- Tests: `offlineReversalQueue.test.ts` (+3), `offlineReversalLogic.test.ts` (+3), `reversalCoordinator.test.ts` (+8).
- Docs: `Task.md`, `Context.md`, this report.

### Evidence

- Web `npx vitest run` → **298 passed** (24 files). Server `functions` `npx vitest run resolveReversal` → **39 passed** (unchanged).
- `npx tsc -b` (web) → clean; `npm --prefix functions run build` → clean.
- `git diff --check` clean; `stash@{0}` present and untouched; no forbidden areas touched.

### Out of scope (unchanged)

Transfer wiring (out of scope for that phase; at that time the legacy executor / dormant resolver path — since superseded by H6-C activation, H6-D1 executor, and H6-D2 UI wiring); manual-review server calls (local-only); global Admin UI; multi-device propagation; POS/cart/checkout/returns/RTV; Firestore rules; `functions/src/resolveReversal.ts(.test.ts)`.

### Hidden risk

The observation is captured from the page's already-loaded receiving doc at void time; a staler in-memory copy could trigger a guard rejection of a reversal the operator believes is current — surfaced via the existing manual-review path, never silent loss.

## Phase 7B-H4: Resolver Hardening / Stale Client Guard (CLOSED / COMMITTED)

**Status:** closed and committed. **Commit:** `4da7757` — `feat(pos): harden resolver against stale client observations)`. Authorization: Option B — APPROVED WITH NOTES (CEO). Post-commit working tree **clean**. `stash@{0}` present and untouched. No forbidden areas touched.

### What was added

- A **server-authoritative stale-client guard** in `functions/src/resolveReversal.ts`. When a reversal request carries the client-observed source-document version (`clientObservedDocumentUpdatedAt`) and the **live** server document `updatedAt` is strictly newer, the resolver rejects with the structured reject code **`stale_client_observation`** (status `rejected`). The client's outdated view is never trusted to drive a destructive path.
- Helpers `toEpochMs` (normalizes ISO string / epoch millis / Firestore `Timestamp` / `{seconds,nanoseconds}` to epoch ms) and `isClientObservationStale` (pure, read-only comparison of an already-loaded document).
- Guard is evaluated **after** authority (branch access + Staff PIN re-auth) and **before** every status check and write, in both `resolveReceivingReversal` and `resolveTransferReversal`.

### Behavior guarantees (proven by tests)

- Rejected stale attempts mutate **zero stock**, **zero lots**, do **not** advance reversal/manual-review state (source stays `completed`/`sent`, no `reversedBy`), and write **no audit doc and no intent-ledger entry**.
- **Deterministic & idempotent:** identical inputs → identical result; repeated stale attempts have no cumulative effect.
- **Conservative:** absent observation ⇒ not stale (legacy callers unchanged); no comparable server `updatedAt` ⇒ not stale; equal instants ⇒ fresh (safe retries).

### Files changed

- `functions/src/resolveReversal.ts` — guard, helpers, new reject code.
- `functions/src/resolveReversal.test.ts` — 11 new H4 tests.

### Evidence

- `npx vitest run resolveReversal` → **39 passed**.
- Full functions suite `npx vitest run` → **108 passed** (8 files).
- `npm run build` (tsc) → **clean**.
- `git diff --check` clean; post-commit working tree **clean**; `stash@{0}` untouched; no forbidden areas touched.

### Hidden risk (accepted — primary H5 requirement)

The guard is inert until the offline-queue client populates `clientObservedDocumentUpdatedAt` (deliberately out of this slice's scope), so end-to-end staleness is not yet detected in production traffic. **Accepted by CEO (Option B) as a non-blocking known risk.** Wiring `clientObservedDocumentUpdatedAt` into the client/offline resolver payload is the primary Phase 7B-H5 requirement.

## Phase 7B-D3: Docs/Context Sync After H4 Closure (CLOSED / COMMITTED)

**Status:** **CLOSED / COMMITTED.** **Commit:** `fb4c3b0` — `docs: sync phase 7b tracker after h4 closure`. Docs-only; no source code or tests modified. D3 is no longer active — it is the clean baseline before H5.

### Authorization

CEO Option A approved. D3 executed immediately after H4 closure and is committed at `fb4c3b0`.

### Verification baseline (post-H4 commit)

- H4 commit: `4da7757` — `feat(pos): harden resolver against stale client observations`.
- Post-H4-commit working tree was **clean** — confirmed by `git status --short` before D3 edits.
- `stash@{0}` present and untouched throughout.

### What D3 updated

- `Task.md` — H4 marked CLOSED/COMMITTED; commit recorded; hidden risk carried; H5 queued (now superseded — H5 is implemented below).
- `Context.md` — H4 moved to closed tracks; H5 added to queued next; key boundaries updated.
- `docs/reports/latest-report.md` — this section; H4 section updated to CLOSED/COMMITTED.

### Next step after D3

**Phase 7B-H5: Wire Client Observation Timestamp Payload** — **CLOSED / COMMITTED** (`4762d97`). See the H5 section near the top of this report.

## Phase 7B-D2: Docs Cleanup & Phase Tracker Hygiene (CLOSED)

**Status:** superseded by D3; closed.

### Verification baseline (post-H3 commit)

- H3 post-commit working tree was **clean** — no staged or unstaged changes after `4d69143`.
- `stash@{0}` remains **present and untouched**.

### H3 Codex result

**PASS WITH NOTES** — no blockers, no required fixes before commit.

### H3 architectural boundaries (confirmed)

- Local/device-visible UI only — NOT a global Firestore dashboard.
- No stock mutation.
- No server resolver changes.
- Firestore reconciliation remains an external manual admin process.

### Next step (was D2)

Phase 7B-H4 — implemented and committed as `4da7757` (see H4 section above).

---

## Phase 7B-H3: Manual Review Operations UI (CLOSED / COMMITTED)

**Commit:** `4d69143` — `feat(pos): add manual review ops UI`
> **Status:** **closed and committed**. **LOCAL/device-visible** queue UI only — NOT a global Firestore admin dashboard. No global Firestore queries, no stock mutation, no Firestore reconciliation (that stays an external manual admin process).

### What was added

- **Pure UI helpers** `src/lib/pos/offline/manualReviewOps.ts` (node-testable, dependency-free): `canViewManualReviewOps(role)` — the authority gate, **delegating** to the canonical H2 rule `isOfflineReversalAuthoritySupported` (Manager/Admin only) so the UI gate can never drift from the helper's own guard; and `buildManualReviewResolvePayload(actor, form)` — maps actor + form to the exact `ManualReviewResolveInput`, enforcing required `reasonCode` and re-checking authority (defense-in-depth), omitting a blank `note`.
- **Page** `src/pages/ManualReviewOpsPage.tsx` (Flowbite React, route-only `/manual-review` under the authenticated POS shell): a read-only table of THIS DEVICE's `manual_review_required` intents (read via the existing `listQueue(store, ['manual_review_required'])` abstraction — no queue-internal changes), a Manager/Admin-only resolve action behind a modal with `reasonCode` (required) + `note` (optional), success/error Alert + toast, and a not-authorized Alert for Staff. Copy explicitly states **"เฉพาะอุปกรณ์นี้" (this device only)** and that it does not mutate stock/server.
- **Route** added to `src/App.tsx` (one import + one `<Route>` line under the existing PosShellRoute group). No nav/menu changes, no route-guard changes.

### Safety boundaries (verified)

- **Authority:** Manager/Admin only; Staff sees the not-authorized state and the resolve action is never rendered; the payload builder returns `unauthorized` for Staff; and the H2 helper itself throws `ManualReviewResolveError` for a staff role (defense-in-depth).
- **Data source:** the local/offline IndexedDB reversal queue only (`listQueue`) — device-scoped, no Firestore query, no cross-device/global scan.
- **No stock mutation / no Firestore reconciliation:** the page calls only `resolveManualReview` (H2), which leaves the internal stock counter untouched; reconciliation remains external.
- **Untouched:** `offlineReversalLogic.ts`, `offlineReversalQueue.ts`, `reversalStockOverlay.ts`, `resolveReversal.ts`, Firestore rules, POS/cart/checkout, returns/RTV, IndexedDB schema, Android/Capacitor, `.claude/`, `stash@{0}`.

### Tests (this pass — all green)

- `manualReviewOps.test.ts` (NEW): **10 passed** — gate (Manager/Admin true; Staff/unknown/null false); payload mapping (note included/omitted, reasonCode trimmed, missing reason blocks, Staff/missing-id unauthorized); integration against the real in-memory store (built payload → `resolveManualReview` → `resolved`, intent leaves the `manual_review_required` list, internal counter unchanged); Staff blocked at payload boundary + H2 helper throws; data source lists only `manual_review_required`; resolve flow makes no network call.
- **Full web unit suite:** **284 passed** (24 files). `tsc -b --noEmit`: clean.

### Test-infra note (honest)

The repo has no `@testing-library/react` / jsdom harness and adding test-framework deps is out of scope, so the security-relevant logic was extracted into pure helpers and covered by node unit + real-store integration tests rather than DOM-render tests. The page is a thin Flowbite shell over those tested helpers.

### Deferred

- DOM/component render tests (needs a jsdom + testing-library setup — separate infra task).
- Multi-device/server-broadcast propagation of resolution (still per-device, from H2).
- Nav/menu entry for the page (currently route-only by direct URL).

## Phase 7B-H2: Manual Review Operational Guard (CLOSED / COMMITTED)

> **Status:** **closed and committed**. Commit: `8b48513` — `feat(pos): add manual review resolution state`. Single-device/local-intent cleanup only — no Admin UI, no server/rules changes.

### Problem closed

`manual_review_required` intents stay in `reversalStockOverlay` while `localCorrection.applied === true && reversed === false` (correct while unresolved). But if a Manager/Admin reconciles Firestore `productStocks` and the local intent stays `manual_review_required`, that device keeps overlaying the delta and can show **ghost stock**. H2 adds a local transition so the overlay drops after manual reconciliation.

### What was added (approved decisions)

- **New terminal status `manual_review_resolved`** (`offlineReversalTypes.ts`) + optional audit block `manualReviewResolution { resolvedAt, resolvedByStaffId, resolvedByRole, reasonCode, note? }` on `OfflineReversalIntent`. No `firestoreReconciled` flag (Decision B — unverifiable locally).
- **Pure helpers** (`offlineReversalLogic.ts`): `isManualReviewResolvable` (eligibility), `assertManualReviewResolveInput` (authority + required fields), `buildResolvedManualReviewIntent` (status → `manual_review_resolved`, stamp metadata, **preserve** `localCorrection` — `applied` stays true, `reversed` stays false), and `ManualReviewResolveError`.
- **Orchestration** (`offlineReversalQueue.ts`): `resolveManualReview(store, intentId, input, deps?)` runs the whole read-check-write in ONE `transact(['intents'],'readwrite')`.
- **Overlay** (`reversalStockOverlay.ts`): **predicate unchanged** — `manual_review_resolved` is simply not in `POS_OVERLAY_STATUSES`, so the existing `POS_OVERLAY_STATUSES.has(status) && applied && !reversed` gate excludes it. Doc comment updated to list it as deliberately excluded.

### Approved semantics

- **Internal local stock counter is NOT touched** (Decision C) and `localCorrection.reversed` is **NOT** set to true — the overlay reads intents (not the counter), Firestore is authoritative post-reconciliation, and inverting the counter would risk double-correction. The correction history is preserved for audit.
- **Outcome contract** (Decision D): discriminated outcomes `resolved | already_resolved | not_found | not_eligible`; throws `ManualReviewResolveError` **only** for authority (Staff) or missing required fields (actor id / reason).
- **Eligibility:** only `manual_review_required` with `applied && !reversed`. `server_rejected` is **not** resolvable (Decision F — already safely rolled back / overlay-excluded). `queued`/`syncing`/`retryable_error`/`server_accepted`/`manual_review_resolved` → `not_eligible`.
- **Idempotency:** first call → `resolved` + metadata; second call → `already_resolved`, **no mutation**, original metadata preserved; unknown id → `not_found`.
- **Sync-path inert:** `manual_review_resolved` is terminal — `isClaimable` already excludes it, so it is never re-claimed or re-synced (no sync-path code changed).
- **Multi-device propagation deferred** (Decision E): clearing is per-device/local; a true server-broadcast resolution is a future phase.

### Files changed

- `src/lib/pos/offline/offlineReversalTypes.ts` — `manual_review_resolved` status + `ManualReviewResolution` type + `manualReviewResolution?` field.
- `src/lib/pos/offline/offlineReversalLogic.ts` — eligibility/guard/build pure helpers + `ManualReviewResolveError`.
- `src/lib/pos/offline/offlineReversalQueue.ts` — `resolveManualReview` orchestration + outcome types.
- `src/lib/pos/offline/reversalStockOverlay.ts` — doc comment only (exclusion note).
- `src/lib/pos/offline/manualReviewResolution.test.ts` (NEW) — helper/eligibility/guard/idempotency/outcome/inertness tests.
- `src/lib/pos/offline/reversalStockOverlay.test.ts` — `manual_review_resolved` exclusion test.

### Tests (this pass — all green)

- `manualReviewResolution.test.ts` (NEW): **15 passed** — overlays while unresolved; transition drops overlay; metadata recorded; counter & `reversed` untouched; idempotent (metadata preserved); Staff/missing-actor/missing-reason throw; `not_found`/`not_eligible`/`server_rejected not resolvable`; `manual_review_resolved` not claimable.
- `reversalStockOverlay.test.ts`: **19 passed** (added `manual_review_resolved` exclusion; queued/syncing/retryable/server_accepted/server_rejected behavior unchanged).
- `offlineReversalQueue.test.ts`: **28 passed**; `offlineReversalLogic.test.ts`: **16 passed** (no regression).
- **Full web unit suite:** **274 passed** (23 files). `tsc -b --noEmit`: clean. `tests/pos-safety.spec.ts` (Playwright): **2 passed**. functions `resolveReversal.test.ts`: **29 passed** (server resolver unchanged).

### Scope of the H2 guarantee (honest boundary)

- **H2 guarantees** that a Manager/Admin can locally clear a `manual_review_required` intent so the POS overlay on that device stops showing the pending delta and returns to the Firestore snapshot — without rolling back the local correction or changing server state.
- **H2 does not** verify that Firestore was actually reconciled (operator-declared, like the rest of the manual-review path), and does **not** propagate the resolution to other devices' local queues (deferred).

## Phase 7B-H1: Receiving Evidence Hardening (CLOSED / COMMITTED)

**Commit:** `e56561b` — `feat(receiving): persist reversal evidence snapshot`
> **Status:** **closed and committed**. Closes the Track A "no independent receiving-header completeness signal" note by persisting a header `reversalEvidence` snapshot at completion and preferring it (fail-closed) at reversal time.

### Blocker fix — lot-effect segment evidence (this pass)

Codex re-review (FAIL) found the header evidence modelled **one effect per line under a single `primaryLotId` with the full `qtyBase`**, while a line can actually mutate **multiple lots** (ghost-lot reconciliation(s) + a new lot). The checksum could pass while the lot evidence was incomplete. Also, the reversal validator rejected duplicate `productId+lotId`, which can legitimately occur. Fixed:

- **Lot-effect segment model (Blocker 1).** Completion now records **one segment per actual lot mutation**: each ghost reconciliation under the **ghost lotId** with the reconciled quantity, and the remainder under the **new lotId**. `confirmReceiving` builds `plan.lotEffects` during planning (the dev mirror builds `lotSegments`); the header `reversalEvidence.effects` and the checksums derive from that **same** segment set. Example: a line of qty 10 that reconciles `ghost-A` 3, `ghost-B` 2 and creates `new-C` 5 persists three segments `[{A,3},{B,2},{C,5}]`, matching the real lot mutations — not one `{primaryLot,10}`.
- **Per-product coverage invariant.** Since a line maps to many segments, `assertReversalEvidenceCoversCompletion` now proves coverage **per product** (summed segment qty == summed line qty for every product) plus a grand-total checksum, instead of one-effect-per-line. It still runs before any write, so a divergence aborts completion.
- **Duplicate aggregation (Blocker 2 — Option A + safe projection).** `aggregateLotEffects` sums duplicate `(productId, lotId)` segments (e.g. two lines reconciling the same ghost lot) into a deterministic, duplicate-free set **before persisting**. The reversal-time `validateReceivingHeaderEvidence` no longer rejects duplicates — it **aggregates** them (summed once) during projection, verifying `itemCount`/`totalQtyBase` against the **raw persisted** entries first. So a valid duplicate/aggregated same-lot scenario is accepted and the local correction never double-applies beyond the summed quantity.
- **productStocks consistency:** product-level increments use each line's `qtyBase`, which equals that line's segment total by construction, so stock totals stay consistent with the segment evidence.

**Files (this fix):** `reversalEvidence.ts` (segment-aware invariant + `aggregateLotEffects`, new codes), `confirmReceiving.ts` + `devMock.ts` (per-lot segments → aggregated canonical set), `reversalCoordinator.ts` (validator aggregates duplicates, drops `header_duplicate_effect`), tests below.

**Tests (this fix):** `reversalEvidence.test.ts` (segment split passes, per-product coverage/total rejections, aggregation); `reversalCoordinator.test.ts` (lot-segment projection preserved, duplicate accepted+aggregated, duplicate same-lot reversal does **not** double-apply, lot-segment reversal applies correct product correction); `confirmReceiving.evidence.test.ts` (completion persists separate ghost/new-lot segments, two-lines-same-ghost aggregates).

### Earlier blocker fix — canonical completeness invariant

> _Refined by the lot-effect segment fix above: the invariant is now PER-PRODUCT (a line maps to many lot segments), not one-effect-per-line. The pre-write, fail-closed, single-canonical-set discipline below is unchanged._

Codex correctly noted a checksum only proves the snapshot **matches itself**, not that it **covers every stock-affecting line**. Fixed by making the completion path enforce a single **canonical stock-effect set** and proving the snapshot equals it:

- **Canonical segments from the same planning values.** At completion, `confirmReceiving` derives the canonical **lot-effect segments** from the same planning variables used for the lot writes (each ghost-reconcile quantity and the new-lot remainder), then aggregates them by `productId+lotId`. `productStocks` increments use **product-level line totals** (`qtyBase`), while the header `reversalEvidence.effects` stores the **aggregated lot-level segment** detail (the dev mirror does the same). The guard verifies per-product and grand-total agreement between line totals and segment totals before any completion write, so the two cannot diverge silently.
- **Pre-write invariant.** Pure `assertReversalEvidenceCoversCompletion(canonicalLines, plannedEffects)` (in `reversalEvidence.ts`) runs in `confirmReceiving` **Phase 2 — before any `tx` write** (and in the dev mirror before the receiving is marked completed). It throws `ReceivingCompletionEvidenceError` (fail-closed) when: the grand-total qtyBase differs, a product's summed segment qty ≠ its summed line qty (per-product coverage), a product is present on only one side, a canonical line is missing productId / non-finite / ≤ 0 qty, or a lot segment is missing productId/lotId / non-finite / ≤ 0 qty. Because it runs before writes, completion **aborts before stock mutation** on any divergence.
- **Why this is real completeness, not self-consistency:** the snapshot is built from the proven canonical segment set, so if a future completion path ever applies a stock effect outside the segment set (or drops a line), the per-product/grand-total agreement breaks and the receiving never completes — rather than certifying an incomplete-but-self-consistent snapshot. **Accepted note:** the current implementation derives lot write quantities and evidence segments from the same local planning values tightly enough for this phase; future maintainers must preserve the segment invariant, and any future partial/async receiving completion must model stock-effect segments explicitly or preserve equivalent per-segment evidence. The checksum is **not** a standalone proof of completeness.

**Files (blocker fix):** `reversalEvidence.ts` (+ invariant, error type), `confirmReceiving.ts` + `devMock.ts` (single canonical set + pre-write guard), `reversalEvidence.test.ts` (+19 invariant tests), `confirmReceiving.guard.test.ts` (NEW — proves the guard is wired into new-doc & draft-finalize and aborts completion on throw).

### Problem closed

Track A's receiving-reversal gate validated the loaded item subcollection but still **assumed `loadItems()` returned the complete set of lines** — there was no independent header completeness signal (itemCount / total-qty checksum / source-effect snapshot). H1 adds that signal.

### What was added

- **Header snapshot (Option C).** New `Receiving.reversalEvidence` (`src/lib/types.ts`): `{ version: 1, source: 'receiving_completion', itemCount, totalQtyBase, effects: [{ productId, lotId, qtyBase }], createdAt, createdBy }`. `itemCount`/`totalQtyBase` are integrity checksums derived from `effects`.
- **Atomic persistence at completion (Decision C).** `confirmReceiving` builds the snapshot from the **same `writePlans` that increase stock**, inside the **same `runTransaction`**, and writes it on the receiving header (both the new-doc `tx.set` and the draft-finalize `tx.update`). The dev mirror (`devConfirmReceiving`) does the same from `savedItems`. A pure builder (`src/lib/receiving/reversalEvidence.ts`) derives the checksums so they can never drift.
- **Header-preferred reversal (Decision D), fail-closed.** `executeReceivingReversal` now resolves effects via `resolveReceivingReversalEffects`:
  - **Case 1** header present & valid → use header effects (`evidenceSource = header_snapshot`); does **not** depend on item-subcollection completeness.
  - **Case 2** header present & invalid → **THROW before any queue write / local mutation / sync** (no fallback — a present-but-corrupt snapshot is a danger signal).
  - **Case 3** header absent → strict **legacy** item-subcollection gate (Option 1 fallback; `evidenceSource = legacy_subcollection`).
  - **Case 4** header absent AND legacy invalid → fail closed.
- **Evidence-source audit (Decision E).** `CreateReversalInput` + `OfflineReversalIntent` carry an optional `evidenceSource` (`header_snapshot | legacy_subcollection`), recorded durably on the queued intent and returned on `ReceivingReversalOutcome`. Carried conditionally so it never adds an `undefined` key (idempotency/shape unchanged).
- **Page wiring.** `ReceivingEditPage` passes `headerEvidence: receiving?.reversalEvidence ?? null`; the coordinator falls back to `items` only for legacy records.

### Header validation rules (all fail-closed, before any write)

`validateReceivingHeaderEvidence` rejects: non-object/array (`header_not_object`), unsupported `version` (`header_unsupported_version`), empty `effects` (`header_empty_effects`), non-object effect (`header_malformed_effect`), missing `productId`/`lotId`, non-finite or `≤ 0` `qtyBase`, and the `itemCount` / `totalQtyBase` checksum mismatches (`header_item_count_mismatch` / `header_total_qty_mismatch`, the latter with a 1e-9 float tolerance; checksums are verified against the **raw persisted** entries before aggregation). Duplicate `(productId, lotId)` effects are **aggregated by summed `qtyBase` before persistence**, and reversal-time validation **aggregates duplicate persisted entries defensively** (summed once) rather than rejecting — so the local correction never double-applies beyond the summed quantity.

### Files inspected

`confirmReceiving.ts`, `devMock.ts`, `receiving/types.ts`, `lib/types.ts` (Receiving/ReceivingItem), `reversalCoordinator.ts` (+ test), `offlineReversalTypes.ts`, `offlineReversalLogic.ts` (`buildOfflineReversalIntent`), `offlineReversalQueue.ts`, `reversalStockOverlay.ts`, `ReceivingEditPage.tsx`, `receivingId.ts`, `vitest.config.ts`.

### Files changed

- `src/lib/types.ts` — `ReversalEvidence` / `ReversalEvidenceEffect` types + `Receiving.reversalEvidence?`.
- `src/lib/receiving/reversalEvidence.ts` (NEW) — pure evidence builder, `REVERSAL_EVIDENCE_VERSION`, `aggregateLotEffects`, and the per-product completeness invariant `assertReversalEvidenceCoversCompletion`.
- `src/lib/receiving/confirmReceiving.ts` — capture per-lot segments, aggregate, run the pre-write invariant, persist evidence atomically (new + draft-finalize).
- `src/lib/receiving/devMock.ts` — same lot-segment capture + aggregate for the dev completion mirror.
- `src/lib/pos/offline/offlineReversalTypes.ts` — `ReversalEvidenceSource` + `evidenceSource?` on input/intent.
- `src/lib/pos/offline/offlineReversalLogic.ts` — carry `evidenceSource` onto the intent (conditional).
- `src/lib/inventory/reversalCoordinator.ts` — header validator (aggregates duplicates) + header-preferred resolution + `evidenceSource` on outcome/createInput.
- `src/pages/ReceivingEditPage.tsx` — pass `headerEvidence`.
- Tests (NEW): `reversalEvidence.test.ts`, `confirmReceiving.evidence.test.ts`, `confirmReceiving.guard.test.ts`; (UPDATED) `reversalCoordinator.test.ts`.

### Tests (latest Codex-verified run — all green)

- `npx.cmd tsc -b --noEmit` → **PASS**
- `npx.cmd vitest run` → **PASS — 22 files, 258 tests**
- Receiving H1 suites (`reversalEvidence.test.ts`, `confirmReceiving.evidence.test.ts`, `confirmReceiving.guard.test.ts`) → **PASS — 3 files, 29 tests** (segment split passes; per-product coverage/total rejections; duplicate aggregation; completion persists separate ghost/new-lot segments; two-lines-same-ghost aggregates; guard wired into new-doc & draft-finalize and aborts on throw).
- `reversalCoordinator.test.ts` → **PASS — 38 tests** (header preferred & recorded `header_snapshot`; lot-segment projection preserved; duplicate `(productId, lotId)` accepted + aggregated, same-lot reversal does **not** double-apply; present-but-invalid header fails closed; legacy fallback only when header missing; Staff authority preserved).
- `reversalStockOverlay.test.ts` → **PASS — 18 tests** (no regression).
- `npx.cmd playwright test tests/pos-safety.spec.ts` → **PASS — 2 tests**.
- `npm.cmd --prefix functions run test:unit -- resolveReversal.test.ts` → **PASS — 29 tests** (server resolver unchanged).
- `git diff --check` → **PASS — LF/CRLF warnings only**.

### Scope of the H1 guarantee (honest boundary)

- **H1 guarantees** `reversalEvidence` matches the **transaction's completed stock effects** — every ghost-lot reconciliation and new-lot remainder is represented as a lot-level segment, proven per-product and by grand total before any write.
- **H1 does not prove** that upstream UI/draft assembly captured the **user's full intent** before `confirmReceiving` was called — if a stock-affecting line is dropped before the completion call receives it, both the stock writes and the evidence omit it consistently and the guard still passes.

### Still deferred (not claimed closed)

- Backfill of `reversalEvidence` onto **pre-H1 historical records** (they use the strict legacy fallback by design).
- Completed-transfer reversal is **no longer deferred** *(historical note from this earlier phase; since delivered)*: H6-C activated the server resolver for current-model `completed` transfers under strict guards, H6-D1 added the latent queue-first executor, and H6-D2 wires `TransferHistoryPage`/`AdminTransferPage` transfer reversal to queue-first (legacy direct cancel retired from those surfaces). Remaining unrelated deferred items, if still applicable: `AdminReceivingPage` wiring and `ReceivingVoidDialog → DestructiveConfirmModal` standardization.

### Boundaries preserved

No transfer lifecycle, POS destructive-confirm, POS overlay, server-resolver, Firestore-rules, Android/Capacitor, `.claude/`, Returns/RTV, inventory-adjustment-reversal, or settings/UOM changes. `stash@{0}` untouched.

## Phase 7B Post-Commit: Destructive Reversal Flow Integration + POS Overlay (CLOSED / COMMITTED)

**Commit:** `645896c` — `fix(pos): overlay offline reversal stock in inventory`
> **Status:** **closed and committed**. Post-merge integration of the 7B-3D-3 offline engine into the live POS / Receiving / Transfer screens, plus the POS-visible stock overlay. Reflects the mainline state after the latest audit's blocker fixes. **Supersedes the "engine only — not wired into any screen" framing of the 7B-3D-3 section below**, which described the pre-integration engine.

### What is now wired into live screens

- **POS Clear Cart / Cancel Parked Order** are **modal-confirmed** (`DestructiveConfirmModal` / suspended-bill modals) — no `window.confirm` remains in the POS safety path. Covered by `tests/pos-safety.spec.ts` (2 passing).
- **`ReceivingEditPage`** routes a confirmed void through **queue-first `executeReceivingReversal`** behind the existing **`ReceivingVoidDialog`** (no instant execution; the legacy direct `cancelReceiving` is off the confirmed path). Receiving **evidence is fail-closed before any queue write / local correction** (`assertReceivingReversalEvidence` — missing/empty/malformed items, missing `lotId`, non-finite or `≤ 0` `qtyBase` all reject all-or-nothing). A Staff actor is rejected before any write.
- **`TransferHistoryPage`** is **modal-gated with `DestructiveConfirmModal`**; on confirm it routes the cancel through the **queue-first `executeTransferReversal`** (Phase 7B-H6-D2 — supersedes the prior legacy `cancelBranchTransfer` path described in earlier audits). `AdminTransferPage` was migrated identically. The H6-C server resolver reverses `completed` transfers under origin-branch authority.
- **POS inventory now overlays pending local reversal deltas** (NEW — this audit's Blocker 1 fix). `inventoryRepository.getInventorySnapshot` presents `visible stock = Firestore productStocks snapshot + pending reversal deltas`, so the queue's immediate local correction is reflected in the grid instead of being invisible until server sync.

### POS-visible reversal overlay (Blocker 1 fix)

- **New module** `src/lib/pos/offline/reversalStockOverlay.ts` (read-only — no IndexedDB mutation): derives, from the durable intent queue, the **net pending reversal delta per product** at a branch and overlays it on the Firestore snapshot in `inventoryRepository`.
- **Derived from intents, not the queue's internal `stock` counter**, so the overlay is status-aware. **Included** statuses: `queued`, `syncing`, `retryable_error`, `manual_review_required` — and only while `localCorrection.applied && !reversed`. **Excluded**: `server_accepted` and any rolled-back (`reversed`) correction.
- **Double-correction bound:** `server_accepted` is **excluded** because the server is becoming authoritative and Firestore `productStocks` will reflect the reversal — there is **no reliable local "Firestore caught up" marker yet**, so keeping the overlay would risk a **permanent double-count**. The conservative trade-off is a **transient under-correction** in the brief window between server-accept and the next snapshot refresh. Idempotent intent ids (one record per source+action) mean a delta is never summed twice; a replay does not double the overlay.
- **Fail-safe:** if the local store is unavailable (SSR / no IndexedDB) or the read throws, the overlay is empty and the POS degrades to plain Firestore stock — it never breaks.
- **Comment corrections:** `offlineReversalTypes.ts` no longer claims the engine is "not wired into any screen" nor that the internal local counter "is what the POS grid reads"; both now describe the real overlay path.

### Tests (this pass — all green)

- **POS overlay** `src/lib/pos/offline/reversalStockOverlay.test.ts` (NEW): **18 passed** — eligibility per status; branch scoping; queued/retryable/manual deltas overlaid; `server_accepted` and reversed excluded (no permanent double-count); summing multiple intents; durable-queue integration (POS-visible delta immediately after an offline receiving reversal, idempotent replay not doubled, other-branch isolation, no-pending → empty, throwing-store fail-safe).
- **Receiving reversal evidence gate** `src/lib/inventory/reversalCoordinator.test.ts`: **19 passed** (fail-closed before queue write on missing/empty/malformed items, missing/null `lotId`, `qtyBase` 0/negative/NaN/Infinity, mixed all-or-nothing; valid lot-backed set still queues + applies local correction).
- **Offline engine** `offlineReversalLogic.test.ts` + `offlineReversalQueue.test.ts`: **39 passed** (unchanged).
- **Full web unit suite:** **210 passed** (19 files). Server `resolveReversal.test.ts`: **29 passed** (unchanged). `tests/pos-safety.spec.ts` (Playwright): **2 passed**. `tsc -b --noEmit`: clean.

### Still deferred (not claimed closed)

- **Completed-transfer queue-first reversal** — *(historical note from this earlier phase; SINCE DELIVERED)* H6-C activated the server resolver for `completed` transfers under strict guards, H6-D1 added the latent queue-first executor, and H6-D2 wired the targeted UI surfaces (legacy direct cancel retired from them). H6-E remains pending for reliable `updatedAt`/evidence hardening.
- **`AdminReceivingPage`** reversal integration — deferred. (**`AdminTransferPage`** transfer-reversal integration was since delivered in H6-D2.)
- **Receiving header checksum / itemCount / original-effects snapshot** hardening (defence against a silently truncated item subcollection) — future hardening.
- **Staff online-PIN receiving reversal** — out of scope (Staff rejected before any offline write).
- **`ReceivingVoidDialog` → `DestructiveConfirmModal`** UI standardization — deferred.

### Boundaries preserved

No server-resolver, Firestore-rules, Android/Capacitor, `.claude/`, Returns/RTV, inventory-adjustment-reversal, or settings/UOM changes. `stash@{0}` untouched.

## Phase 7B-3D-3: Offline Reversal Queue + Immediate IndexedDB Stock Correction (engine — superseded framing)

> **Status:** implementation in progress, **awaiting Codex re-review**. Does NOT claim closure. No commit made. The first pass returned Codex `FAIL`; this section reflects the state **after** the blocker fixes below.

### Scope delivered (engine layer)

A dedicated client-side durable queue (`src/lib/pos/offline/`) that lets a Manager/Admin create a void/reverse **intent** for a Goods-Receiving or branch Transfer while offline, **immediately corrects local IndexedDB stock** so selling can continue, durably queues the intent (survives reload/crash), and reconciles with the server `resolveReversal` resolver on reconnect. _(Historical note: this section described the engine before screen integration. It is **now wired** into Receiving/Transfer/POS and surfaced in the grid via the overlay — see the **Phase 7B Post-Commit** section at the top.)_

- **Files added** (all under `src/lib/pos/offline/`): `offlineReversalTypes.ts`, `offlineReversalLogic.ts` (pure), `reversalLocalStore.ts` (atomic IndexedDB store + in-memory test store), `offlineReversalQueue.ts` (orchestration), `syncOfflineReversals.ts` (sync worker → callable), plus `offlineReversalLogic.test.ts` and `offlineReversalQueue.test.ts`. `docs/reports/latest-report.md` (this section).
- **Immediate local correction:** create runs the 9-step order inside ONE IndexedDB `readwrite` transaction (assert mutation-marker not applied → write intent → apply stock delta → write ledger rows → write marker → finalise) so the corrected counter is visible the instant the call resolves. Idempotent: a replay of the same source/action returns the existing intent without re-applying.

### Codex blocker fixes (this pass)

- **Blocker 1 — Recoverable sync lease (no stranded `syncing` items).** Claims now write a lease (`syncLeaseOwner`, `syncLeaseExpiresAt`, `syncAttempt`, `lastSyncAttemptAt`). An item is claimable when `queued`/`retryable_error`, **or** `syncing` with an **expired** lease (crash/reload recovery); a live lease locks out concurrent workers. `applyServerResult` releases the lease in every outcome. `listClaimable`/`syncPendingReversals` drain expired-lease items too.
- **Blocker 1b — Stale-worker claim token (no terminal downgrade).** `claimForSync` returns a `SyncClaimToken` (`{ intentId, syncLeaseOwner, syncAttempt }`) that `syncOneReversal` captures before the network call and passes into `applyServerResult`, which **re-verifies it inside the transaction**: if the item is no longer `syncing` or the owner/attempt no longer matches (a newer claim reclaimed an expired lease and bumped `syncAttempt`), the late result is a `stale_noop` and the item is left untouched. A stalled, superseded worker can therefore never downgrade a newer terminal state (e.g. `server_accepted → retryable_error`). `applyServerResult` now returns `{ outcome: 'applied' | 'stale_noop' | 'not_found', intent }`.
- **Blocker 2 — Offline reversal is Manager/Admin only.** A Staff actor (`actorRole: 'staff'`) is rejected **before** any local write (`OfflineReversalRejectedError` / `offline_staff_authority_unsupported`) — no stock correction, no queue item — because the server resolver requires a server-verified raw PIN for Staff that an offline queue cannot (and must not) satisfy. No insecure offline PIN protocol; no raw PIN stored.
- **Blocker 3 — Rollback is fail-closed.** A definitive server rejection auto-rolls-back the local correction **only when comprehensive dependency safety is explicitly proven** (`proveRollbackSafe` returns `true`). Missing / unknown / incomplete / throwing evidence (the default — there is no POS/local-stock-consumer probe yet) ⇒ `manual_review_required` with the correction preserved and the reject code/message kept. By design this almost always fail-closes.
- **Blocker 4 — This report updated** honestly: 7B-3D-3 is under review, not closed.

### Known policy (this phase)
- Offline **Staff** reversal is **not supported** unless an approved offline authority proof exists (none does yet) → rejected before queue creation.
- **Unsafe / unproven rollback** of a rejected reversal goes to **`manual_review_required`** (never auto-reverses local stock).
- Sync claims use a **recoverable lease** so a crash mid-sync cannot strand a queue item.

### Tests (engine pass — all green; superseded counts updated in the top section)
- `offlineReversalLogic.test.ts` + `offlineReversalQueue.test.ts`: **39 passed** (covers durable create, immediate correction, atomic abort, mutation-id/replay no-double-apply, accept-no-re-apply + confirmed, network→retryable keeps correction, manual-review, fail-closed rollback by default / unknown / proof-false, rollback only when proven, Staff rejected before write + no correction, Manager/Admin queue, lease recovery after crash, live-lease lockout).
- _(Engine-pass suite total was 168/17 files; the current mainline total is **210 passed / 19 files** — see the top section.)_ Server `resolveReversal.test.ts`: **29 passed** (unchanged). Rules suite: **114 passed** (unchanged — no rules touched).

### Boundaries preserved (engine pass)
_(The engine pass touched no live UI; screen wiring landed later — see the top section.)_ Returns/RTV, inventory-adjustment reversal, Flowbite/styling, Android/Capacitor, Firestore rules, and server-resolver changes remain untouched. `.claude/` untouched; `stash@{0}` untouched.

### Known risks
- The default rollback path fail-closes to manual review because **no comprehensive local dependency probe exists yet** (POS/offline-sales integration is deferred) — Managers will see more manual-review items until that probe is built and injected.
- The lease is advisory (single-device durability via IndexedDB); cross-tab concurrency relies on the atomic claim transaction, not OS-level locks.

## Phase 7B-3B: Branch Void-Password Setting + Rules (Settings-only batch)

> **Baseline:** committed on top of Phase 7B-2 (`5eebb2b feat(inventory): enforce origin-controlled transfer discrepancy resolution`). Preflight was clean (no staged/unstaged diff, HEAD = 7B-2) before any 7B-3B change.

### ⚠️ CEO Correction Captured — Void/Reversal must support OFFLINE execution (future 7B-3D)

Per the CEO correction, **Void/Reversal must NOT be online-only.** When the internet is down, the cashier must be able to void/reverse **locally** (correct local stock in IndexedDB), keep selling, and **queue the void action** for automatic Cloud Function sync on reconnect. The earlier 7B-3 design note that recommended "require connectivity for reversals" is **superseded**: future **7B-3D must include an Offline Sync Queue for Void actions** + local IndexedDB stock correction, reconciled by the server resolver when back online (analogous to the existing async-checkout → `reconcileOrder` pattern). **None of that offline machinery is implemented in 7B-3B** — this batch is settings + rules only; the note is recorded so 7B-3D plans for it.

### Scope delivered (7B-3B — settings + rules ONLY)

- **Branch setting** `requiresPasswordForVoid: boolean`, **default `true`** (security-first) when the field is missing, stored on the per-branch settings doc `settings/{branchId}` (the `Settings` type). When enabled, a future void/reversal flow will require a Staff to enter their own PIN; Manager/Admin bypass the PIN but still confirm.
- **Default-on-read everywhere:** `useSettings.defaultSettings` (`true`), `settingsToForm` (`?? true`), `formToSettings` (`?? true`), and the runtime `useBranchSettings` hook (new `requiresPasswordForVoid` + `DEFAULT_REQUIRES_PASSWORD_FOR_VOID = true`, returned for 7B-3D to consume). A legacy settings doc without the field reads as `true`.
- **Settings UI toggle** in **Settings → Admin & ความปลอดภัย** (`SettingsPage.tsx`): a new "ความปลอดภัยการ Void / ยกเลิกเอกสาร" card with a toggle + helper text. Enabled for **Manager/Admin**, disabled (with a hint) for **Staff**. It persists immediately via a **narrow, field-scoped writer** (`useSettings.saveVoidPasswordSetting`) that writes only `{ requiresPasswordForVoid, updatedAt }` — because the existing full-settings Save is Admin-only, this is the path a Manager is permitted to use. Reuses existing `Toggle`/`stg-card`/`stg-toggle-row` styles (no new/inline styles).
- **Firestore field-scoped rule:** added to `match /settings/{settingId}` an `allow update` for `isManagerOrAdmin() && hasBranchAccess(settingId) && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['requiresPasswordForVoid','updatedAt'])`. The existing Admin-only full-doc `allow write` is unchanged; the narrow grant cannot touch any other field or another branch. Staff have neither path.

### How the boundary is enforced
- **Staff denied:** not `isManagerOrAdmin()` → fails the narrow `allow update`; not admin → fails the full `allow write`. UI toggle is also `disabled` for Staff.
- **Manager/Admin, own branch only:** `hasBranchAccess(settingId)` (settingId = branchId) gates to authorized branches; another branch → denied.
- **Field-only:** `affectedKeys().hasOnly([...])` blocks changing any unrelated setting through the narrow path; a Manager full-doc write is still denied (Admin-only).
- **No weakening / no broad rules:** the existing settings/stock rules are untouched; no stock/productStocks/stockLots rules were added or relaxed.

### Files inspected
`src/lib/types.ts` (Settings/Branch/User/UserRole), `src/lib/settings/types.ts`, `src/lib/settings/useSettings.ts`, `src/lib/hooks/useBranchSettings.ts`, `src/lib/settings/settingsNav.ts`, `src/pages/SettingsPage.tsx`, `src/components/ProtectedRoute.tsx`, `src/App.tsx`, `firestore.rules`, `rules-tests/firestore-permissions.spec.ts`.

### Files changed
- `src/lib/types.ts` — `requiresPasswordForVoid?: boolean` on `Settings`.
- `src/lib/settings/useSettings.ts` — default `true`; narrow `saveVoidPasswordSetting` writer.
- `src/lib/settings/types.ts` — default-on-read in `settingsToForm` + pass-through in `formToSettings`.
- `src/lib/hooks/useBranchSettings.ts` — expose `requiresPasswordForVoid` (default true) + `DEFAULT_REQUIRES_PASSWORD_FOR_VOID`.
- `src/pages/SettingsPage.tsx` — Admin/Security toggle card + `isManagerOrAdmin` + narrow-write handler.
- `firestore.rules` — field-scoped Manager/Admin settings `allow update`.
- `rules-tests/settings-void-password-phase7b3b.spec.ts` (NEW) — 6 field-scoped rules tests.
- `src/lib/settings/voidPasswordSetting.test.ts` (NEW) — 5 default-on-read unit tests.
- `docs/reports/latest-report.md`.

### Tests
- **Unit (`voidPasswordSetting.test.ts`, 5):** missing field → `true`; explicit false/true preserved; `formToSettings` round-trip + legacy (no field) → `true`; `DEFAULT_REQUIRES_PASSWORD_FOR_VOID === true`.
- **Rules (`settings-void-password-phase7b3b.spec.ts`, 6):** Manager toggles own branch (allowed); Admin toggles (allowed); Staff denied; Manager other-branch denied; Manager unrelated-field-via-narrow-path denied; Manager full write denied.
- **No Settings *component* test exists** in the repo (the page is an untested large page); honest gap — covered instead by the unit (default-on-read) + rules (permission) tests, which carry the security-relevant behavior. UI wiring (toggle visibility/disable + narrow writer) is verified by tsc + manual reading.
- 7B-1/7B-2 suites remain green (web 118, functions unchanged, rules 114).

### Commands run (all PASS)
`git status`/diff/`--check`; `tsc -b --noEmit` (web, no errors); `npx.cmd vitest run` (118, 14 files); `npm run test:rules` (114, 6 files). (Full results in the handoff.)

### Boundaries preserved
No Confirmation Modal, PIN input, PIN verification, Cloud Function reversal resolver, offline queue, IndexedDB stock correction, receiving/transfer/adjustment reversal logic, Customer Returns, RTV, 7B-4, POS/cart/checkout/offline/cache implementation, native/SQLite, or Android. No unrelated UI/Flowbite changes. `.claude/` excluded; `stash@{0}` untouched.

### Known risks / notes
- The Manager toggle persists immediately (narrow write) rather than via the main Save button (which is Admin-only). If `settings/{branchId}` does not yet exist (brand-new branch), the narrow `update` path has no doc to update — the Admin initializes the settings doc first (normal flow); a Manager on a doc-less branch cannot create it (by design).
- `requiresPasswordForVoid` is read but **not yet consumed** by any void flow — there is no void/reversal behavior change in 7B-3B (intentional).

## Phase 7B-2 Blocker-Fix #3: Remove Third FIFO Source in Server Resolver

- **Codex BLOCKED reason**: `functions/src/resolveTransferDiscrepancy.ts` defined its own **copied** FIFO primitives (`planFifoCutFromState`, `mergeLotCuts`, plus `parseReceivedAtMs`/`roundMoney`/lot shapes), duplicating the ones in `functions/src/reconcileOrder.ts`. That is a **third FIFO source of truth**, violating the explicit "no third FIFO source" gate. Codex accepted the rest of the 7B-2 boundary (origin-only server resolver, destination cannot resolve, parent-transfer source of truth, identity validation, generic-adjustment residual, all suites green).
- **Fix (Option A — extract a shared server helper)**: Created `functions/src/fifo.ts` as the **single canonical server-side FIFO source** (lot shapes `LotRef`/`MutableLot`/`LotCut`, `roundMoney`, `parseReceivedAtMs`, `planFifoCutFromState`, `mergeLotCuts`). Both `reconcileOrder.ts` and `resolveTransferDiscrepancy.ts` now **import the same module**; their local copies were deleted. The extracted primitives are byte-for-byte the ones `reconcileOrder` already shipped, so `reconcileOrder` behavior is unchanged.
- **Files inspected**: `functions/src/reconcileOrder.ts`, `functions/src/resolveTransferDiscrepancy.ts`, `functions/src/{retryReconcile,voidIntent,voidReversal,sweeper,db,deployConfig,index}.ts`, `functions/tsconfig.json`, `functions/src/*.test.ts`, `src/lib/fifo.ts`, `docs/reports/latest-report.md`.
- **Files changed**:
  - `functions/src/fifo.ts` (NEW) — canonical server FIFO primitives.
  - `functions/src/fifo.test.ts` (NEW) — 9 unit tests for the shared helper.
  - `functions/src/reconcileOrder.ts` — removed local `LotRef`/`MutableLot`/`LotCut`/`roundMoney`/`parseReceivedAtMs`/`planFifoCutFromState`/`mergeLotCuts`; now imports them from `./fifo`. No behavior change (`resolveOversellCost` + `OVERSELL_LOT_ID` stay local — sale-specific, not FIFO-cut primitives).
  - `functions/src/resolveTransferDiscrepancy.ts` — removed the copied FIFO block + the now-unused `Timestamp` import; imports `./fifo`; comment corrected.
  - `docs/reports/latest-report.md`.
- **Shared FIFO source**: `functions/src/fifo.ts` is the lone server FIFO module. `reconcileOrder.ts` imports `{ roundMoney, parseReceivedAtMs, planFifoCutFromState, mergeLotCuts, LotRef, MutableLot, LotCut }`; `resolveTransferDiscrepancy.ts` imports `{ roundMoney, parseReceivedAtMs, planFifoCutFromState, mergeLotCuts, MutableLot, LotCut }`. There is **no copied FIFO logic in the resolver** and no second/subtly-different helper. (It does NOT import the browser/web-SDK `src/lib/fifo.ts`, avoiding bundling/runtime risk — the server helper is the Admin-SDK twin.)
- **Business logic**: The 7B-2 server resolver is unchanged in behavior — same origin-authority check, same parent-transfer identity validation, same atomic Admin-SDK transaction, same audit markers. Only the FIFO functions it calls now come from `./fifo`.
- **FIFO safety**: No copied FIFO logic remains in the resolver; `reconcileOrder` uses the identical extracted code (no regression — proven by its existing unit tests + build); Phase 7B-1 transfer cost/chronology untouched (client transfer path is a separate concern in `src/lib`).
- **Tests** (this pass): `functions/src/fifo.test.ts` (9) covers `roundMoney`, `parseReceivedAtMs` (Timestamp/`{seconds}`/unknown), `planFifoCutFromState` (oldest-first, in-place mutation, oversell remainder, skip-empty), `mergeLotCuts` (collapse/drop). `resolveTransferDiscrepancy.test.ts` (17) still passes through the shared helper; all reconcile/void function tests still pass. Web suites + rules suite unchanged.
- **Commands run** (all PASS): see the verification block below.
- **Boundaries preserved**: No Customer Returns / RTV / 7B-3 / 7B-4 / Post-Receipt Reversal / POS / cart / checkout / offline / cache / native / SQLite / Android / UI. `.claude/` excluded; `stash@{0}` untouched.
- **Hygiene (final staging pass)**: Comment-only wording fixes applied before staging — no runtime/logic/assertion changes: (1) `src/lib/inventory/transferCrud.ts` banner updated to remove stale `confirmInventoryAdjustment` reference and clearly state server-authoritative Cloud Function resolution; (2) `rules-tests/transfer-discrepancy-phase7b2.spec.ts` file-level docblock updated to say all client updates are denied (not "origin may resolve via update"); (3) this report — historical note added before the original Phase 7B-2 section.
- **Known risks**: (a) `reconcileOrder` has no dedicated FIFO-path integration test that asserts cut quantities; the guarantee is that the extracted code is identical to what it already ran + the functions build/test suite passes + the new `fifo.test.ts` covers the primitives directly (documented gap, not overclaimed). (b) Two FIFO implementations still exist *by design* — client (`src/lib/fifo.ts`, web SDK) and server (`functions/src/fifo.ts`, Admin SDK); these are intentionally separate runtimes, and the gate is about not having a *third* (duplicate within a runtime), which is now satisfied.

## Phase 7B-2 Blocker-Fix #2: Server-Side Origin-Controlled Resolver

- **Codex BLOCKED reason**: The previous pass enforced origin control only via client logic + the "marked adjustment" rule, but the *stock mutation* boundary was still open: a destination user can create an **unmarked generic** `inventoryAdjustments` doc for their own branch and mutate destination stock outside the discrepancy workflow (`productStocks`/`stockLots` writes are not branch-isolated). Codex deemed "generic adjustment cannot mark the discrepancy resolved" insufficient — stock mutation itself is the control boundary, and an out-of-band correction risks double-correction.
- **Why generic own-branch adjustment was not acceptable**: leaving the discrepancy open is audit evidence but does not *prevent* a destination branch from absorbing/pre-correcting the shortage in its own stock; that can hide operational issues and double-correct if origin later resolves.
- **Chosen authority-boundary design (move resolution server-side)**: Resolution is now performed **only** by a Cloud Function (`resolveTransferDiscrepancy`, Admin SDK), mirroring the `reconcileOrder` precedent. The function authenticates the caller, verifies **origin authority from verified custom claims** (not client input), validates the discrepancy against the **parent transfer as source of truth**, re-derives every line's expected/difference from the immutable transfer items, performs the FIFO-correct adjustment, and flips the discrepancy to `resolved` — **all in one Admin SDK transaction**. Firestore rules now deny *all* client-side resolution: no client may `update` a discrepancy, and no client may create a marker-bearing (`refTransferId`/`refDiscrepancyId`) adjustment. The client keeps only the metadata REPORT path and a thin caller that invokes the function.
- **Files inspected**: `functions/src/{index,reconcileOrder,retryReconcile,db,deployConfig}.ts`, `functions/package.json`, `functions/src/retryReconcile.test.ts`, `src/lib/reconciliation/retryReconcile.{ts,test.ts}`, `src/lib/auth/verifyPinLogin.ts`, `src/lib/inventory/{transferCrud,confirmInventoryAdjustment,types,transferTypes}.ts`, `firestore.rules` (inventoryAdjustments/productStocks/stockLots/stockMovements), `rules-tests/transfer-discrepancy-phase7b2.spec.ts`, `src/lib/inventory/transferCrud.test.ts`, `docs/reports/latest-report.md`.
- **Files changed**:
  - `functions/src/resolveTransferDiscrepancy.ts` (NEW) — `performResolveTransferDiscrepancy` + `resolveTransferDiscrepancy` callable.
  - `functions/src/resolveTransferDiscrepancy.test.ts` (NEW) — 17 unit tests (fake Admin Firestore).
  - `functions/src/index.ts` — export the callable.
  - `functions/package.json` — add `resolveTransferDiscrepancy` to the deploy allowlist.
  - `src/lib/inventory/resolveTransferDiscrepancy.ts` (NEW) — thin client→CF caller; `resolveTransferDiscrepancy.test.ts` (NEW) — wrapper tests.
  - `src/lib/inventory/transferCrud.ts` — REMOVED the client-side direct-mutation resolver (+ its `confirmInventoryAdjustment`/`updateDoc` imports); `reportTransferDiscrepancy` unchanged (metadata-only).
  - `firestore.rules` — `transferDiscrepancies` `update: if false` (server-only); `inventoryAdjustments` create denies any marked adjustment (`!isDiscrepancyResolutionAdjustment()`); removed obsolete origin-resolve helpers.
  - `src/lib/inventory/transferCrud.test.ts` — removed client-resolve tests (moved server-side); kept REPORT tests.
  - `rules-tests/transfer-discrepancy-phase7b2.spec.ts` — server-only abuse matrix.

### Codex blockers → fixes

- **Stock-level bypass — CLOSED for the resolution path; CONSTRAINED for generic adjustments.** Resolution stock writes now happen exclusively in the Cloud Function under Admin SDK authority; **no client can perform or mark a resolution**. The discrepancy is server-flipped to `resolved` only after a successful, atomic correction.
- **Server resolver is authoritative.** Origin authority is read from the caller's verified token claims (`role`/`branchIds`), never from the request body; the destination and unrelated branches get `permission-denied`.
- **Client-side direct resolution removed.** `transferCrud.ts` no longer mutates stock for resolution; `resolveTransferDiscrepancy.ts` only invokes the callable. Rules deny client disc `update` and client marked-adjustment `create`.

### Generic adjustment bypass — exact status (honest)

A destination branch can still create a **generic, unmarked** adjustment on its own branch — this is a legitimate inventory capability, and `productStocks`/`stockLots` writes are **not branch-isolated** in the current rules (a documented, pre-existing Cloud-Function deferral, like `reconcileOrder`). What is now enforced:

- A generic adjustment **cannot resolve** a discrepancy: it carries no markers (rules reject markers from clients) and cannot flip the discrepancy `status` (client `update` denied) — only the server resolver can.
- Therefore the destination cannot use a generic adjustment to *resolve/close* a discrepancy; it can only make a separately-audited generic adjustment that leaves the discrepancy open.
- **Not yet closed (documented, not overclaimed):** fully *preventing* a destination branch from mutating its own stock while a discrepancy is open requires branch-isolating `productStocks`/`stockLots` writes — the broader stock-write Cloud-Function migration (same direction as `reconcileOrder`). That is a cross-cutting architectural change beyond 7B-2 scope and is **recommended as the next phase**. Per the directive, this is documented rather than faked with an unsafe broad rule.

### Server resolver — how it works

- **Origin authority**: `hasBranchAccess(auth, transfer.fromBranchId)` using `auth.token.role === 'admin'` or `branchIds` containing `'ALL'`/the origin branch — from verified claims only. Destination/unrelated → `permission-denied`.
- **Parent transfer = source of truth**: rejects unless `disc.transferId`/`fromBranchId`/`toBranchId`/`reportedByBranchId` match the transfer and `disc.status === 'reported'`; re-derives each line's `expectedQty`/`difference` from the immutable transfer items and rejects tampered facts or products not in the transfer.
- **Stock correction**: one Admin SDK transaction — FIFO-cut dest lots for a short receipt (or create a lot at standard cost for an over receipt), decrement/increment `productStocks`, write `adjustmentItems` + `stockMovements`, tag the adjustment with `refTransferId`/`refDiscrepancyId`.
- **Resolved only after correction**: the `status → resolved` flip + audit (`resolvedByBranchId = transfer.fromBranchId`, `resolutionAdjustmentId`) is in the SAME transaction; a second call re-reads `resolved` and is rejected — no double correction.
- **No destination write access required**: runs under Admin SDK, so a pure origin-only resolver no longer needs destination-branch write permission (the earlier client limitation).

### FIFO safety (7B-1 not regressed)

No third FIFO source. (Update — Blocker-Fix #3: the CF originally *copied* the lot-cut primitives; that copy has since been replaced by an import of the shared canonical `functions/src/fifo.ts`, the same module `reconcileOrder` uses.) Branch transfers are untouched, so Phase 7B-1 cost carry-over + source-receipt chronology are intact. The four 7B-1 transfer tests still pass.

### Tests

- **functions/src/resolveTransferDiscrepancy.test.ts (17)**: unauthenticated/invalid-argument; **destination denied** (permission-denied, nothing mutated); unrelated branch denied; **origin short-receipt success** (dest stock 10→8, oldest FIFO lot cut, disc resolved + linked, `adjust` movement); **admin success**; **over-receipt** creates a new lot at standard cost; **resolve-twice rejected** (no double correction); identity abuse — tampered `toBranchId`/`fromBranchId`/`transferId`/`reportedByBranchId`/`difference`/`expectedQty`, unknown product, already-resolved, zero-difference — all rejected with **no writes**.
- **src/lib/inventory/resolveTransferDiscrepancy.test.ts (2)**: client wrapper invokes the callable with server-relevant fields only; propagates `permission-denied`.
- **rules-tests/transfer-discrepancy-phase7b2.spec.ts**: report create matrix (destination-only, branch/transferId/status/reportedBy validation, no resolution fields); **update server-only** (origin AND destination denied; any client mutation denied); **marked adjustment server-only** (origin AND destination denied; even a single marker denied; generic own-branch allowed; cross-branch generic denied).
- **src/lib/inventory/transferCrud.test.ts**: retained metadata REPORT tests (destination-only, no stock mutation, immutable transferQty, origin-cannot-report, zero-difference report) + the four 7B-1 tests.
- **Commands run** (all PASS): `git status`/diff/`--check`; `tsc -b --noEmit` (web, no errors); `npm --prefix functions run build` (functions tsc, no errors); `npx.cmd vitest run src/lib/inventory/transferCrud.test.ts`; `npx.cmd vitest run src/lib/inventory`; `npx.cmd vitest run` (web full); `npm --prefix functions run test:unit`; `npm run test:rules`; stash checks. (Pass counts in the verification block below.)
- **Boundaries preserved**: No Customer Returns / RTV / 7B-3 / 7B-4 / Post-Receipt Reversal / POS / cart / checkout / offline / cache / native / SQLite / Android / UI. `.claude/` excluded; `stash@{0}` untouched.
- **Known risks / limitations**: (a) generic destination adjustments remain possible (documented above; needs the deferred stock-write isolation phase). (b) The CF tolerates a resulting negative dest stock rather than blocking a resolution (matches the `reconcileOrder` oversell philosophy; a short receipt normally stays ≥ 0). (c) `resolvedByStaffName` is display-only from the request; the authoritative resolver identity is the verified-claim `staffId`. (d) Cloud Function logic is covered by unit tests with a fake Admin Firestore (no functions-emulator integration test in this pass); rules denial is covered by the emulator rules suite.

## Phase 7B-2 Blocker-Fix: Enforce Origin-Controlled Discrepancy at the System Boundary

- **Codex BLOCKED reason**: The first 7B-2 pass enforced the discrepancy rule only at the app layer. Codex found (1) destination staff could still mutate destination stock through a generic `inventoryAdjustments` write, (2) `resolveTransferDiscrepancy` trusted the discrepancy doc's own branch fields instead of the parent transfer, (3) `transferDiscrepancies` rules were too loose (only `status == 'reported'`, no field/branch/immutability constraints), and (4) a pure origin-only user might fail the stock-write rules — requiring a Cloud Function or a tighter rules path.
- **Files inspected**: `src/lib/inventory/transferCrud.ts`, `transferTypes.ts`, `transferCrud.test.ts`, `confirmInventoryAdjustment.ts`, `inventory/types.ts`, `fifo.ts`, `firestore.rules` (incl. `productStocks`/`stockLots`/`stockMovements`/`inventoryAdjustments` rules), `rules-tests/transfer-discrepancy-phase7b2.spec.ts`, `docs/reports/latest-report.md`.
- **Files changed**: `src/lib/inventory/transferCrud.ts` (hardened `resolveTransferDiscrepancy` identity validation + adjustment markers), `src/lib/inventory/types.ts` (optional `refTransferId`/`refDiscrepancyId` on adjustment input + doc), `src/lib/inventory/confirmInventoryAdjustment.ts` (persist markers when present), `firestore.rules` (tight discrepancy create/update rules + origin-gated marked-adjustment rule + helpers), `src/lib/inventory/transferCrud.test.ts` (+7 domain abuse tests + marker assertions), `rules-tests/transfer-discrepancy-phase7b2.spec.ts` (full abuse-case matrix), `docs/reports/latest-report.md`.

### Codex blockers → fixes

- **Blocker 2 (identity trust) — FIXED.** `resolveTransferDiscrepancy` now treats the **parent transfer as the sole source of truth**: it rejects unless `disc.transferId === transfer.id`, `disc.fromBranchId === transfer.fromBranchId`, `disc.toBranchId === transfer.toBranchId`, `disc.reportedByBranchId === transfer.toBranchId`, and `disc.status === 'reported'`. Each line's `expectedQty`/`difference` is **re-derived from the immutable transfer items** and rejected if it disagrees (tamper detection) or references a product not in the transfer. The adjustment target is `transfer.toBranchId` and the resolver-authority branch is `transfer.fromBranchId` — never the trusted disc fields.
- **Blocker 3 (loose rules) — FIXED.** `transferDiscrepancies` rules now: **create** requires `validDiscrepancyReport` (status `reported`; `transferId`/`fromBranchId`/`toBranchId` match the parent; `reportedByBranchId == toBranchId`; destination branch access; non-empty `lines`; **no** resolution fields). **update** requires `validDiscrepancyResolve` (origin branch access; `reported → resolved` transition; `diff().affectedKeys().hasOnly([...resolution fields])` so reported facts — lines, reason, branch ids, `reportedBy*`, `transferId` — are immutable). delete is admin-only.
- **Blocker 1 (generic-adjustment bypass) — CONTROLLED via marker rule.** A discrepancy resolution adjustment is tagged with `refTransferId` + `refDiscrepancyId`. The `inventoryAdjustments` create rule now gates any **marked** adjustment to the referenced transfer's **origin** branch and requires it to target the transfer's destination — so a destination user **cannot forge a resolution-marked adjustment**, and only origin can produce an adjustment that links to (and is used to resolve) a discrepancy. Combined with the origin-only discrepancy `update` rule, the discrepancy record's resolution is fully origin-gated.
- **Blocker 4 (origin resolver vs. stock-write rules) — DESIGN NOTE (no unsafe broad rule).** See below.

### Blocker 4 / residual Blocker 1 — design note (honest scope boundary)

The codebase intentionally does **not** branch-isolate `productStocks` / `stockLots` writes at the rules layer: both allow any `canMutateStock()` staff to write any branch (the rules comments document this as a deferred Cloud-Function migration, mirroring `reconcileOrder` for POS). Consequences, stated plainly:

- A destination user can still move destination stock with a **generic (unmarked)** adjustment — but that is **not** a discrepancy resolution: it carries no markers, cannot mark the discrepancy `resolved` (origin-only), and leaves the reported discrepancy as a permanent open audit record. Fully preventing a branch from adjusting its own stock would break the legitimate adjustment feature and requires the deferred stock-write isolation, **not** a rule I can safely add here.
- A **pure origin-only (non-admin)** user cannot *complete* the resolution stock-write client-side, because `stockMovements` create for `refType: 'inventoryAdjustment'` requires own-branch (destination) access. Broadening that rule to recognise a "resolution" movement would be fragile and over-broad (it cannot validate the not-yet-committed sibling adjustment within the same transaction). **I did not broaden it.**
- **Recommendation (smallest safe fix):** move the *stock-mutating* resolution to a **Cloud Function / Admin SDK resolver** (`resolveTransferDiscrepancy` server-side) that validates origin authority + discrepancy identity and performs the adjustment with Admin privileges — exactly the established `reconcileOrder` pattern. Until then, the client `resolveTransferDiscrepancy` is the interim path for **admin / global-`ALL` / cross-access** resolvers; it enforces all identity + authority validation at the app layer, and the marker rule guarantees a destination user can never forge a resolution regardless.

### Verification

- **Tests added/updated**: `transferCrud.test.ts` now 15 tests — +6 identity-validation abuse cases (tampered `toBranchId`/`fromBranchId`/`transferId`, tampered `difference`, forged `expectedQty`, unknown product) + marker assertions on the happy-path resolution. `rules-tests/transfer-discrepancy-phase7b2.spec.ts` (25 cases) covers: destination-create allowed / origin-create denied / wrong-status / wrong from/to/transferId / wrong reportedByBranchId / resolution-fields-on-create denied; origin-resolve allowed / destination-resolve denied / reported-facts-immutable / branch-field-mutation denied / no-transition denied / read scoping; marked-adjustment origin-only & destination-forge denied / wrong-target denied / generic adjustment unaffected.
- **FIFO safety (7B-1 not regressed)**: No third FIFO source. Resolution still delegates to `confirmInventoryAdjustment` → `planFifoCutFromState`; the four 7B-1 tests (cost carry-over, cancel restore, chronology inheritance, depletion ordering) pass unchanged; the resolution test still asserts the inherited oldest dest lot is consumed first.
- **Commands run** (all PASS): `git status --short` / `--porcelain=v1 -uall`, `git diff --name-only` / `--cached --name-only`, `git diff --stat` / `--cached --stat`, `git diff --check` / `--cached --check` (clean), `./node_modules/.bin/tsc.cmd -b --noEmit` (no errors), `npx.cmd vitest run src/lib/inventory/transferCrud.test.ts` (15 passed), `npx.cmd vitest run src/lib/inventory` (25 passed), `npx.cmd vitest run` (118 passed, 12 files), `npm run test:rules` (110 passed, 5 files), stash checks (`stash@{0}` = `7d03cfe`, unchanged).
- **Boundaries preserved**: No Customer Returns / RTV / Post-Receipt Reversal / 7B-3 / 7B-4 / POS / cart / checkout / offline / cache / native / SQLite / Android / UI. `.claude/` excluded; `stash@{0}` untouched.
- **Honest git status**: The rules spec `rules-tests/transfer-discrepancy-phase7b2.spec.ts` is now **staged** (Codex flagged it as untracked last round). Remaining 7B-2 changes are working-tree modifications; nothing else staged; no `.claude/` or `android/` artifacts.

> **Historical note (Phase 7B-2 evolution):** The original Phase 7B-2 section below and the "Blocker-Fix" section above it document earlier implementation attempts where resolution was performed **client-side** via `confirmInventoryAdjustment` directly in `transferCrud.ts`. That path is **superseded**. The accepted design (Blocker-Fix #2, refined in #3) is **server-authoritative Cloud Function resolution**: the client only invokes the `resolveTransferDiscrepancy` callable; all stock mutation happens in the Admin SDK Cloud Function; Firestore rules deny all client-side resolution updates. Do not follow the client-resolution pattern described in the sections below.

## Phase 7B-2: Origin-Controlled Discrepancy Handling

- **Business rule**: A destination branch that receives a quantity differing from what the origin shipped may ONLY *report* the discrepancy (metadata). It must not edit the received quantity, mutate destination stock/lots, or create an adjustment to absorb the difference. The **origin branch holds sole authority** to resolve the discrepancy, and resolution flows exclusively through the existing Inventory Adjustment path — preserving full auditability (origin + destination identity, expected qty, actual qty, difference, who reported, who resolved, timestamps, and the resolving adjustment id).
- **Phase 7B-1 commit baseline**: `585e29f` (`feat(inventory): branch-transfer FIFO cost + source receipt chronology carry-over (Phase 7B-1)`), preceded by `e7b5f93` (`chore(gitignore): exclude .claude/`). 7B-1 was uncommitted at handoff; it was committed first to establish this baseline before 7B-2 work.
- **Codebase reality found**: Branch transfers are atomic and immediate (`confirmBranchTransfer` writes `status: 'completed'` and credits destination stock in one transaction). There is **no destination "receive" step**, and Firestore rules already deny destination writes to the transfer doc (`write` requires `hasBranchAccess(fromBranchId)`). So the destination already cannot edit received quantity; 7B-2 adds a *controlled, metadata-only* report channel plus an origin-only resolution.
- **Files inspected**: `src/lib/inventory/transferCrud.ts`, `src/lib/inventory/transferTypes.ts`, `src/lib/inventory/transferCrud.test.ts`, `src/lib/inventory/confirmInventoryAdjustment.ts`, `src/lib/inventory/types.ts`, `src/lib/fifo.ts`, `src/lib/firebase.ts`, `firestore.rules`, `rules-tests/firestore-permissions.spec.ts`, `docs/reports/latest-report.md`.
- **Files changed**: `src/lib/inventory/transferTypes.ts` (discrepancy types + `generateDiscrepancyId`), `src/lib/inventory/transferCrud.ts` (`reportTransferDiscrepancy` + `resolveTransferDiscrepancy`), `src/lib/firebase.ts` (`transferDiscrepancies` collection constant), `firestore.rules` (destination-create / origin-resolve subcollection rules), `src/lib/inventory/transferCrud.test.ts` (mock `setDoc`/`updateDoc` + 5 new domain tests), `rules-tests/transfer-discrepancy-phase7b2.spec.ts` (new rules spec), `docs/reports/latest-report.md`.
- **How destination is prevented from resolving**: `reportTransferDiscrepancy` writes ONLY a `transferDiscrepancies` metadata doc — it touches no `productStocks`, `stockLots`, or `stockMovements` — and throws unless the caller's `branchId === transfer.toBranchId`. `resolveTransferDiscrepancy` throws unless the caller's `branchId === transfer.fromBranchId`, so the destination is rejected. At the rules layer, the destination can only `create` (status `'reported'`) and cannot `update` (resolve); origin can only `update`.
- **How origin authority is enforced**: Resolution is origin-gated (service branch check + rules `update` gated on `fromBranchId`) and the only inventory mutation it performs is via the canonical `confirmInventoryAdjustment` — applied to the destination branch with `adjustQty = actual − expected` — which reuses the existing FIFO source of truth. The discrepancy is then stamped `status: 'resolved'` with resolver identity, timestamp, and `resolutionAdjustmentId`.
- **Tests added/updated**: 5 domain tests in `transferCrud.test.ts` (report-as-metadata-no-stock-change; cannot-hide-discrepancy; destination-cannot-resolve & origin-cannot-report; origin-resolution-is-only-path + FIFO-aware oldest-lot-first + idempotent; zero-difference no-op). New `rules-tests/transfer-discrepancy-phase7b2.spec.ts` (6 cases) proves destination-create / origin-resolve at the rules layer.
- **FIFO safety (7B-1 not regressed)**: No third FIFO source. Resolution delegates to `confirmInventoryAdjustment` → `planFifoCutFromState`. The four 7B-1 tests (cost carry-over, cancel restore, chronology inheritance, depletion ordering) still pass unchanged. The resolution FIFO test asserts the correction consumes the inherited oldest dest lot first.
- **Commands run** (all PASS): `git status --short` / `--porcelain=v1 -uall`, `git diff --name-only` / `--cached --name-only`, `git diff --check` / `--cached --check` (clean, exit 0), `./node_modules/.bin/tsc.cmd -b --noEmit` (no errors), `npx.cmd vitest run src/lib/inventory/transferCrud.test.ts` (9 passed), `npx.cmd vitest run src/lib/inventory` (19 passed), `npx.cmd vitest run` (112 passed, 12 files), `npm run test:rules` (97 passed, 5 files — incl. new spec), `git stash list/-reflog/-show` (stash@{0} = `7d03cfe`, unchanged).
- **Scope boundaries preserved**: No Customer Returns, RTV, Post-Receipt Reversal/Undo/Void, POS cart/checkout, offline/cache, native/hardware/SQLite, Android artifacts, or 7B-3/7B-4 work. No UI/Flowbite changes. `.claude/` excluded; `stash@{0}` untouched.
- **Honest git status**: Working tree changes are all 7B-2 (above) — nothing staged, no `.claude/` or `android/` artifacts. (A benign Git LF→CRLF warning appears on the test file.)
- **Known consideration**: The reconciling adjustment is created on the *destination* branch via the existing `inventoryAdjustments` rules, which require the actor to have branch access to that branch (or be admin/`ALL`). In practice the origin-authorised resolution is performed by an origin-side manager/admin or HQ user with that access; the broader cross-branch role model was intentionally left untouched (out of scope).

## Phase 7B-1 Revision: Destination FIFO Must Inherit Original Source Receipt Time

- **Tech Lead / CEO rejection reason**: Closure of 7B-1 was rejected (Option C selected). The destination FIFO ordering used the *transfer arrival time* as the FIFO sort key. For Twinpet's livestock-feed business this artificially refreshes inventory age and risks older / expiring goods remaining unsold. Mandatory rule: **the destination stock lot must inherit the original source lot receipt time as the primary FIFO sort key**, so stock age continues seamlessly across branches.
- **What changed**: The original source lot `receivedAt` (in ms) is now carried through the FIFO cut and persisted on each transfer item's `sourceLotDetails`. Destination lots are created with `receivedAt = Timestamp.fromMillis(originalSourceReceivedAtMs)` instead of `serverTimestamp()`. Cancel-restore likewise recreates source lots at their original receipt time. Cost carry-over is byte-for-byte unchanged.
- **Files inspected**: `src/lib/fifo.ts`, `src/lib/inventory/transferCrud.ts`, `src/lib/inventory/transferTypes.ts`, `src/lib/types.ts`, `src/lib/inventory/transferCrud.test.ts`, `docs/reports/latest-report.md`. Verified `src/lib/fifo.ts`'s `planFifoCutFromState` lot-refs flow ONLY into `transferCrud.ts` on the client (adjustments consume `cuts` only; checkout/`reconcileOrder` use their own server-side FIFO copy), so the change is contained.
- **Files changed**: `src/lib/fifo.ts` (carry `receivedAtMs` on `LotCut` + cut output), `src/lib/types.ts` (optional `receivedAtMs` on `LotRef`), `src/lib/inventory/transferTypes.ts` (optional `receivedAtMs` on `TransferLotDetail`), `src/lib/inventory/transferCrud.ts` (dest + cancel-restore lots inherit `receivedAt`), `src/lib/inventory/transferCrud.test.ts` (mock `Timestamp.fromMillis` + 2 new tests), `docs/reports/latest-report.md`, `.gitignore` (repo-local `.claude/` exclusion — see tooling hygiene note below).
- **FIFO source of truth preserved**: No third FIFO source created. `planFifoCutFromState` in `src/lib/fifo.ts` remains the only client FIFO authority; the change only *carries an additional field* (the source receipt time) along the existing cut.
- **Original source receipt time inheritance rule**: For every destination lot created from a source FIFO cut — dest cost = source cut cost, dest qty = source cut qty, **dest `receivedAt` = original source lot `receivedAt`**. The oversell/drift remainder (no source lot) keeps the transfer time. `createdAt` still records the true creation time for audit; only the FIFO key (`receivedAt`) is inherited.
- **Test evidence**: `src/lib/inventory/transferCrud.test.ts` — 4 tests pass. New: (1) *"Destination lots inherit ORIGINAL source receivedAt, not the transfer arrival time"* asserts dest lots carry the source `receivedAt` (1000 / 2000), are strictly less than `Date.now()` taken before the transfer, and persist `receivedAtMs` in `sourceLotDetails`; (2) *"Destination FIFO depletion consumes the OLDEST original source receipt first"* seeds a pre-existing dest lot whose receipt time sits between the two source lots — only inheritance makes the oldest source lot deplete first; it would fail if arrival time were used. Existing cost-carry-over and cancel-restore tests still pass.
- **Commands run**: `git status --short`, `git status --porcelain=v1 -uall`, `git diff --name-only`, `git diff --cached --name-only`, `git diff --check` / `--cached --check` (clean), `./node_modules/.bin/tsc.cmd -b --noEmit` (PASS, no errors), `npx.cmd vitest run src/lib/inventory/transferCrud.test.ts` (4 passed), `npx.cmd vitest run src/lib/inventory` (14 passed), fifo/adjustment suite (10 passed).
- **Scope boundaries preserved**: No Customer Returns, RTV, Origin-Controlled Discrepancy, Post-Receipt Reversal, POS cart/checkout, offline/cache, native/hardware/SQLite, Android artifacts, `.claude/`, or UI/Flowbite changes. No 7B-2/7B-3/7B-4 work. `stash@{0}` untouched.
- **Tooling hygiene — `.claude/` exclusion**: `.gitignore` was updated (separate tooling-hygiene pass) to explicitly add `.claude/` to the repo-local ignore list. The global user gitignore (`C:\Users\Narachat\.config\git\ignore`) already excluded `.claude/settings.local.json`, but the repo-local rule makes the exclusion portable and visible to all scanners (including Codex). `.claude/settings.local.json` is local Claude Code CLI config (permission allowlist only — no tokens or secrets); it remains on disk locally and is **not staged or committed**. `git check-ignore -v .claude/settings.local.json` confirms the match: `.gitignore:32:.claude/`.
- **Honest git status (final staged package)**: All seven intended Phase 7B-1 + tooling files are staged: `.gitignore`, `docs/reports/latest-report.md`, `src/lib/fifo.ts`, `src/lib/types.ts`, `src/lib/inventory/transferTypes.ts`, `src/lib/inventory/transferCrud.ts`, `src/lib/inventory/transferCrud.test.ts`. `git diff --name-only` is clean (no unstaged tracked changes). No `.claude/` or `android/` artifacts appear in status.

## Phase 7B-1: Strict FIFO Cost Carry-over for Branch Transfers
- **Phase 7B-1 Approved**: Executed as a blocker-fix to remove TS errors and enforce exact scope. Option A selected.
- **Files Inspected**: `src/lib/fifo.ts`, `src/lib/inventory/transferCrud.ts`, `src/lib/inventory/transferTypes.ts`, `src/lib/types.ts`.
- **Files Changed**: `src/lib/inventory/transferCrud.test.ts` (added test file) and `docs/reports/latest-report.md` (this report). `src/lib/fifo.ts` and `transferCrud.ts` were reverted to their pristine state to remove `expiryDate` propagation, adhering to Option A (remove non-essential metadata changes).
- **FIFO Source of Truth**: Reused `planFifoCutFromState` and `readProductLotsInTransaction` in `src/lib/fifo.ts`. No new or third FIFO calculation was added. Transfer lines accurately cut and carry the exact unit cost from the source lots via `sourceLotDetails`.
- **Dest Lots Preservation**: Branch transfer logic creates exact mirror lots at the destination using `destLotPlan` rather than falling back to average cost (unless oversold). Canceling accurately restores the original exact FIFO layers at the source branch.
- **Tests Added**: Added `transferCrud.test.ts` providing domain test coverage for FIFO cost carry-over and cancel restoration without broad Firestore/UI changes.
- **Commands Run**: `npx.cmd vitest run src/lib/inventory/transferCrud.test.ts` (PASSED - explicitly using npx.cmd for Windows). `tsc -b --noEmit` (PASSED). `git status --porcelain=v1 -uall` (Shows test file and report as staged, no `.claude/` or `android/` artifacts).
- **Boundaries Preserved**: `stash@{0}` untouched. UI, offline POS, Customer Returns (7B-2/3) excluded.
- **ExpiryDate Decision**: ExpiryDate changes were reverted (Option A) to remain strictly focused on FIFO cost tracking and fix the TS blocker.
- **Open Tech Lead Decision**: ~~Should destination branch FIFO order use transfer arrival time or original source lot receipt time?~~ **RESOLVED (Option C)** — destination FIFO must inherit the original source lot receipt time. See the *Phase 7B-1 Revision* section at the top of this report for the implementation.

> ## Phase 5 (Planning/Docs Only)
> - **Phase 5 Approved:** Phase 5 approved by Tech Lead / CEO via external directive. This report records the approval context, Developer Self-Review Gate, and MVP readiness manifest.
> - **Strategic Capacitor Pivot:** Twinpet POS architecture updated to target Native App deployment via Capacitor (`docs/skills/SKILL-GLOBAL-ARCHITECTURE.md`). This is a docs/architecture-only update; no code/packages/config changed. Phase 5 UAT remains paused until architecture docs are aligned.
> - **Pre-UAT Evidence Collected:** Automated evidence collected in `docs/reports/phase-5-batch-1-pre-uat-evidence.md`. Exact terminal output for `npm run build` and Playwright E2E checkout test is fully captured and recorded.
> - **Batch 2, 3, & 4 UAT (Manual/Visual & Offline):** Logged in `docs/reports/phase-5-batch-2-uat-results.md`, `docs/reports/phase-5-batch-3-offline-uat-results.md`, and `docs/reports/phase-5-batch-4-human-offline-uat.md`. All visual manual UI/responsive and offline flow checks are explicitly marked DEFERRED as they require human interaction and network throttling. MVP UAT remains blocked pending real human manual UAT execution/evidence. No code patches requested or made. `git status` shows pre-existing `.claude/` which is out of scope.
> - **DEFECT-UAT-001 Patched:** Addressed offline product grid cache wipe issue by strictly scoping cache fallback to offline/transport errors. Changed app files: `src/lib/pos/inventoryRepository.ts`, `src/lib/pos/productSorting.ts`, `src/lib/admin/quickMenuStore.ts`, `src/hooks/pos/usePosInventory.ts`, `src/pages/POSPage.tsx`. Confirmed that rules, functions, checkout, payment, void, admin exception flow, auth, stock receiving, transfer, package scripts, native storage, and `node_modules` were untouched.
> - **Self-Review Gate:** Created `docs/skills/SKILL-DEVELOPER-SELF-REVIEW.md` and `docs/reports/ai-failure-ledger.md` to enforce self-review before Codex handoff.
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
> - [x] **Evidence captured**: Batch 2, 3 & 4 captured documentation status only; manual screenshots not captured. Automated evidence reused Batch 1.
> - [x] **Report accuracy**: Checked.
> - [x] **Failure ledger items checked**: no overclaiming native storage implemented no packages installed no runtime changes claimed.
> - [x] **Deferred items**: Capacitor setup, native storage plugin choice, SQLite schema/migration, hardware plugin feasibility, App Store/Play Store pipeline. All responsive/manual state/offline checks remain deferred.
> - [x] **Known remaining risks**: storage sync/conflict strategy and plugin selection unresolved. UAT sign-off blocked until human manual evidence is collected. Entire offline flow remains visually untested.
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
