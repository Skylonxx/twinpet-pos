# Twinpet POS — Task Tracker

> Last reconciled: 2026-07-11
> HEAD: `8e6b2e6676eb055b7073287d8b2a0585899c3428` (docs: close packet 7c-b2 reconciliation)
> origin/main: `8e6b2e6676eb055b7073287d8b2a0585899c3428`
> Implementation: `3ef5fedef2b815592b26120ee6d4d5144a4c6955` (Packet 7C-B2)

---

## P1 Offline / Sync Resiliency — Packet 7C-B2 Close-Intent Reconciliation

**Status: CLOSED / COMMITTED / PUSHED** (`3ef5fed` — `feat(pos): reconcile offline shift close intents`) — first Codex review FAIL; remediation PASS; Codex re-review PASS WITH NOTES; Gemini commit/push AUTHORIZED; committed/pushed; post-push UAT **PASS WITH NOTES**

- [x] Packet 7C-B2 architecture report (read-only planning) completed — PASS
- [x] Codex architecture review — PASS WITH NOTES (implementation-ready)
- [x] Gemini 7C-B2 implementation authorization (`TWINPET-P1-OFFLINE-SYNC-GEMINI-PACKET-7C-B2-IMPLEMENTATION-AUTHORIZATION-001`)
- [x] 7C-B2 implementation — new `shiftCloseReconciler.ts` (pure), `shiftService.ts` confirmation-grade reader/normalizer + `whenServerConfirmed`, `ShiftModals` reactive badge states + `ShiftBootBlockedModal`, `POSPage` boot/reconnect sweep + RC-3 fail-closed fix, tests
- [x] Codex implementation review — **FAIL / implementation-ready-for-commit: NO** (built-mode `tsc -b`/`npm run build` failed on TS2345 + TS2459, despite Vitest + `tsc --noEmit` passing)
- [x] Remediation (`TWINPET-P1-OFFLINE-SYNC-PACKET-7C-B2-CODEX-FAIL-REMEDIATION-CLAUDE-001`) — Blocker 1 (nullable `closedAt` type), Blocker 2 (wrong type import), Medium (unmount guard), Low (journal transition `ok` handling); build path now green; +4 regression tests
- [x] Codex implementation re-review — PASS WITH NOTES / implementation-ready-for-commit: YES
- [x] Gemini commit authorization — AUTHORIZED (`TWINPET-P1-OFFLINE-SYNC-GEMINI-PACKET-7C-B2-COMMIT-PUSH-AUTHORIZATION-001`)
- [x] Exact-file validation, staging, commit, fast-forward push — `3ef5fed`
- [x] Post-push UAT — **PASS WITH NOTES** (`...\QA\twinpet-p1-offline-sync-packet-7c-b2-post-push-uat-report.md`): device-observed online same-runtime confirm, offline→reconnect, reload/boot sweep, regression all PASS; boot fail-closed + stale/attention + Variant C failure-path AUTOMATED-EVIDENCE-ONLY; no false confirmation, no unsafe reopen, no duplicate close
- [x] Docs-only closure (this execution)

**7C-B2 scope — delivered:** Variant C hybrid (local-journal-authoritative + one best-effort, device-scoped, single-field `syncState:'synced'` doc normalization per confirmed close). Confirmation-grade reads only (`getDocFromServer`, never cache/estimate). Full frozen-identity match before confirming. Fixes the RC-3 boot-guard fail-open gap (non-ok close-intent store read now blocks both live-drawer reopen and `OpenShiftModal`). Same-runtime Z-report reacts to real confirmation via `whenServerConfirmed` without ever delaying `closeShift`'s return; a mounted-ref guard prevents late confirmation from updating an unmounted Z-report. A failed local journal transition write is reported as retryable (`unreachable`), never as a completed transition.

**Files:** `src/lib/pos/offline/shiftCloseReconciler.ts` (new, +tests), `src/lib/pos/shiftService.ts` (+tests), `src/components/pos/ShiftModals.tsx` (+css, +tests), `src/pages/POSPage.tsx` (+new focused test file), `src/pages/POSPage.hold-bill-interaction.test.tsx` (mock-harness update only, no behavior change).

**Validation:** `npx tsc -b` exit 0; `npm run build` exit 0 (prebuild created no diff); full Vitest **1187/1187**; `tsc --noEmit` clean; ESLint 4 pre-existing `POSPage.tsx` findings only (lines 392/584/591/678, outside all diff hunks), 0 new; `git diff --check` clean.

**Packet 5:** Required for backend validation/audit/settlement/cross-device authority — **not implemented**. 7C-B2 only flags an identity mismatch; it never adjudicates.

## P1 Offline / Sync Resiliency — Packet 7C-B1 Local Optimistic Offline Close (Option 2)

**Status: CLOSED / COMMITTED / PUSHED — post-commit UAT PASS WITH NOTES**

- [x] Packet 7C-B architecture report completed
- [x] Codex architecture review — REQUEST CHANGES (remediated)
- [x] Codex re-review — PASS WITH NOTES
- [x] Gemini 7C-B1 implementation authorization
- [x] 7C-B1 implementation — durable close-intent store, `closeShift` rewrite, `ShiftModals` optimistic path + pending badge, `POSPage` boot guard, tests
- [x] Codex implementation review — REQUEST CHANGES (remediated)
- [x] Codex implementation re-review — PASS WITH NOTES
- [x] Gemini commit authorization
- [x] Commit/push (`1e41b0e` — `feat(pos): add local optimistic shift close`)
- [x] Post-commit UAT — PASS WITH NOTES (evidence: perpetual-pending gap, now addressed by 7C-B2 above)

**7C-B1 scope (Option 2) — delivered:** Durable local pending close only. `closeShift` verifies from local cache only (never awaits network), persists a durable close-intent before the queued shift-doc write, and returns a frozen client-built snapshot. Reliable post-reload ACK/rejection was 7C-B2's job — implemented this pass (above), pending its own review/commit.

**Files:** `src/lib/pos/offline/shiftCloseIntentStore.ts` (+types, +tests), `src/lib/pos/shiftService.ts` (+tests), `src/components/pos/ShiftModals.tsx` (+css, +tests), `src/pages/POSPage.tsx`, `src/lib/types.ts` (`closedAtLocal?: number`).

## P1 Offline / Sync Resiliency — Packet 7C-A Offline-Safe Close-Shift UX Guard

**Status: CLOSED / COMMITTED / PUSHED — hard offline block superseded by 7C-B1's optimistic path**

- [x] Offline pre-close guard + 10s timeout backstop
- [x] Codex review + re-review — PASS WITH NOTES
- [x] Stale tracker remediation
- [x] Commit/push (`34a3d24`)

**Commit:** `34a3d24de69751d3bdf9c9ace0cc8cf491845265` — `fix(pos): guard offline shift close ux`

**Limitation:** Temporary UX stopgap — not true offline close. Packet 7C-B1 removes the hard `navigator.onLine` block from `handleClose`; the one-shot guard and timeout backstop remain as a defensive fallback only.

## P1 Offline / Sync Resiliency — Packet 7A Shift Close Warning

**Status: CLOSED / PUSHED / DOCS CLOSED**

- [x] Implementation (`cb2e9ef`) + docs (`74a84c3`)

## P1 Packet 8 — DOCS CLOSED (`6526970`)

## P1 Packet 6 — CLOSED / DOCS CLOSED (`8197d64`)

## P1 Packet 3B-4 / 3B-3 / 3B-2 / 3A-* / Packet 2 / Packet 1 — CLOSED / PUSHED

## UI-11 Packet 1 / UI-10-C / UI-10-B / UI-10-A — CLOSED / PUSHED

## Future Phase — True Standalone (Desktop & Native Mobile) (`TRUE-STANDALONE`)

**Status: FUTURE / NOT STARTED / NOT AUTHORIZED**

- [ ] Desktop app packaging (Tauri/Electron — technology not decided)
- [ ] Native mobile packaging (iPad/Android — Capacitor or reviewed alternative)
- [ ] Native local storage migration (SQLite candidate — IndexedDB remains until reviewed migration/rollback)

**Position:** After P1 stabilization (Packet 5 + Packet 7B as documented). Does not interrupt Packet 5 read-only planning. Future Gemini gate required.

**Not authorized:** implementation, dependencies, native projects, storage migration, or absolute data-loss guarantees.

## UI-10-D / UI-11 Packet 2 — NOT STARTED

### Next step

1. Packet 7C-B2 — **CLOSED** (impl `3ef5fed`, docs `8e6b2e6`); post-push UAT PASS WITH NOTES
2. Next roadmap planning priority: **Packet 5** — deferred / not implemented
3. Gemini Packet 5 read-only architecture/planning decision

**Not active:** Packet 5 implementation, Packet 7B, TRUE-STANDALONE implementation, PaymentModal W-12, Printer/Thermal, UI-10-D, UI-11 Packet 2.

**Roadmap priority:** Packet 5 Backend Deep Sync (planning). TRUE-STANDALONE is a later architectural phase.
