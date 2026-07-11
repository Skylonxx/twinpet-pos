# Next Action

## Current State

- HEAD: `8e6b2e6676eb055b7073287d8b2a0585899c3428` (docs closure); Packet 7C-B2 impl `3ef5fed`
- Working tree: **dirty** (TRUE-STANDALONE roadmap docs update — unstaged; not committed per authorization)
- **P1 Packet 7C-B2 Close-Intent Reconciliation** — **CLOSED / COMMITTED / PUSHED** (`3ef5fed` — `feat(pos): reconcile offline shift close intents`); post-push UAT **PASS WITH NOTES** (`...\QA\twinpet-p1-offline-sync-packet-7c-b2-post-push-uat-report.md`)
- **P1 Packet 7C-B1** — CLOSED / COMMITTED / PUSHED (`1e41b0e`); post-commit UAT PASS WITH NOTES (perpetual-pending gap — now fixed by 7C-B2)
- **P1 Packet 7C-A** — CLOSED / COMMITTED / PUSHED (`34a3d24`); hard offline block superseded by 7C-B1's optimistic path
- **P1 Packet 7A** — CLOSED / DOCS CLOSED (`cb2e9ef` + `74a84c3`)
- **P1 Packet 8** — DOCS CLOSED (`6526970`)
- **P1 Packet 6** — CLOSED / DOCS CLOSED (`8197d64`)
- **P1 Packet 3B-4 / 3B-3 / 3B-2 / 3A-* / Packet 2 / Packet 1** — CLOSED / PUSHED
- **UI-11 Packet 1 / UI-10-C / UI-10-B / UI-10-A** — CLOSED / PUSHED
- **UI-11 Packet 2 / UI-10-D** — **NOT STARTED**

## What Happens Next

1. Packet 7C-B2 CLOSED (impl `3ef5fed`, docs `8e6b2e6`); post-push UAT PASS WITH NOTES — **DONE**
2. **Packet 5** — next roadmap planning priority (backend validation/audit/settlement/cross-device authority) — **deferred / not implemented**
3. **Future Phase TRUE-STANDALONE** — documented; FUTURE / NOT STARTED / NOT AUTHORIZED
4. Gemini Packet 5 read-only architecture/planning authorization or execution decision

**Not active:** Packet 5 implementation, Packet 7B, TRUE-STANDALONE implementation, PaymentModal W-12, Printer/Thermal, UI-10-D, UI-11 Packet 2.

## Future Phase — True Standalone (Desktop & Native Mobile) (`TRUE-STANDALONE`)

**Status: FUTURE / NOT STARTED / NOT AUTHORIZED FOR IMPLEMENTATION**

Positioned after P1 Offline/Sync stabilization (Packet 5; Packet 7B where documented). Does not displace Packet 5 as next planning priority. Requires future Gemini gate — no automatic activation after 7C-B2.

| Pillar | Scope (planning only) |
|--------|----------------------|
| Desktop App Upgrade | Package web POS for PC; Tauri or Electron candidates — technology not decided; no implementation authorized |
| Native Mobile App Upgrade | iPad/Android tablets; Capacitor or reviewed shell; web foundation exists; no native/store work authorized |
| Native Local Storage Migration | SQLite candidate to supplement/replace IndexedDB; durable app-controlled persistence; 100% data safety is architectural goal not guarantee; IndexedDB retained until reviewed migration/rollback |

## Reminders

- `stash@{0}` — do not touch
- Validate this packet with the BUILD path (`npx tsc -b` + `npm run build`), not just `tsc --noEmit` — the first Codex FAIL was a `tsc -b`-only build error that `tsc --noEmit -p tsconfig.json` did not catch (the solution tsconfig type-checks via project references)
- 7C-B2 delivered: pure reconciler (`shiftCloseReconciler.ts`), confirmation-grade reader (`getDocFromServer`) + Variant C normalizer in `shiftService.ts`, `closeShift`'s `whenServerConfirmed` handle, reactive Z-report badge states (`pending`/`stale`/`confirmed`/`attention`) with a mounted-ref unmount guard, `POSPage` boot + reconnect sweeps, and the RC-3 boot-guard fail-closed fix (`shiftBootBlocked` + `ShiftBootBlockedModal`)
- A failed local journal transition write (`markSynced`/`markRejectedManualAttention` returning `ok:false`) is reported as retryable `unreachable` — never as a completed transition
- Confirmation NEVER comes from cache/estimate — only `getDocFromServer` + a resolved server `closedAt` + full frozen-identity match (branch/staff/device/every drawer total)
- Variant C normalization writes ONLY `syncState:'synced'`, is device-scoped, and is best-effort/no-guaranteed-retry — do not overclaim eventual consistency
- 7C-B2 only flags an identity mismatch (`rejected_manual_attention`) — it never adjudicates; that is Packet 5's role
- Packet 5 required for backend authority — not implemented; not required before honest local pending close
- Do not claim backend accepted/settled/synced while pending
- Sale Intent Journal is sidecar-only — not source of truth
