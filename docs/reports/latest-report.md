# Latest Report — P1 Offline / Sync Packet 2 Runtime Observer

> Date: 2026-07-07
> HEAD: `d500bf99282f8edd8322ecc6f2b5e81e2b451a3d`
> origin/main: `d500bf99282f8edd8322ecc6f2b5e81e2b451a3d`
> Status: **P1 PACKET 2 CLOSED / PUSHED**

---

## Summary

P1 Offline / Sync Packet 2 is **closed and pushed** at `d500bf9 feat(pos): add sale intent observer wiring`. W-01 deterministic rejected-write evidence harness at `e3155ad`. Runtime observer wires raw Firestore `setDoc` promise into Sale Intent Journal sidecar for lifecycle observation.

## Scope Delivered

**Modified (3):**

- `src/lib/pos/asyncCheckout.ts`
- `src/hooks/pos/useCheckout.ts`
- `src/lib/pos/asyncCheckout.w01.test.ts`

**New (2):**

- `src/lib/pos/offline/saleIntentObserver.ts`
- `src/lib/pos/offline/saleIntentObserver.test.ts`

**Untouched:** `POSPage.tsx`, `PaymentModal.tsx`, checkout/cart/payment math, Firebase/functions/rules, package/config, UI/CSS, printer/thermal, platform.

## Runtime Behavior

- Raw Firestore `setDoc` promise captured before catch transformation
- Raw promise passed to `saleIntentObserver`
- `permission-denied` / terminal rule rejection → `rejected_by_rules`
- Server resolution → `server_acknowledged`
- Non-rule write/observer exception → `exception_observed`
- Sale Intent Journal remains sidecar-only (not source of truth)
- Cashier-visible `submitAsyncOrder` return flow remains non-blocking
- Observer does not retry or resend writes
- `server_acknowledged` records server resolution — does not imply checkout accepted before raw promise resolves

## Prerequisite — Packet 1

`3fe056e feat(pos): add sale intent journal sidecar` — 7 new offline journal files; sidecar durability/observability only.

## Validation

| Check | Result |
|-------|--------|
| `npm run build` | PASS |
| `asyncCheckout.w01.test.ts` | 12/12 |
| `saleIntentObserver.test.ts` | 9/9 |
| `saleIntentJournalLogic.test.ts` | 32/32 |
| `saleIntentJournalStore.test.ts` | 18/18 |
| `npm run test:rules` | 119/119 |
| `git diff --check` | PASS |
| Codex review | PASS WITH NOTES (no blockers) |
| Push | PASS |
| Working tree after push | clean |
| stash@{0} | untouched |

**Codex non-blocking note:** Developer report cited 10 observer tests; Codex observed 9 — coverage accepted.

## Deferred / Next Gate

**P1 Packet 3 — NOT STARTED.** Requires separate Gemini authorization. Suggested topics:

- Startup / lifecycle reconcile sweep
- Tab-close / reload recovery for incomplete journal lifecycle
- Sequence hardening / `nextLocalSeq` race
- Manual review / `rejected_by_rules` operational policy (if Gemini chooses)

No startup sweep, manual review UI, or sequence hardening implemented.

## Docs Reconciliation

Separate docs-only pass (TWINPET-P1-OFFLINE-SYNC-PACKET-2-COMBINED-DOCS-CLOSURE-CLAUDE-001). Not part of pushed commit `d500bf9`.
