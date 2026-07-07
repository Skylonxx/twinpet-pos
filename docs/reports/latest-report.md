# Latest Report — P1 Offline / Sync Packet 3A-2A asyncOrders Lookup Adapter

> Date: 2026-07-07
> HEAD: `535073e2431350d924825733c1ebafd803cf889a`
> origin/main: `535073e2431350d924825733c1ebafd803cf889a`
> Status: **P1 PACKET 3A-2A CLOSED / PUSHED**

---

## Summary

P1 Offline / Sync Packet 3A-2A is **closed and pushed** at `535073e feat(pos): add async order server lookup adapter`. Delivers an unwired `createAsyncOrderServerLookup` factory as an isolated read-only adapter — no boot wiring, no startup execution, no existing file modifications.

## Scope Delivered (2 new files)

- `src/lib/pos/offline/asyncOrderLookup.ts`
- `src/lib/pos/offline/asyncOrderLookup.test.ts`

## Adapter Behavior

- `createAsyncOrderServerLookup` factory — returns `null` when Firebase unconfigured or `db` unavailable
- `getDocFromServer`-only — no `getDoc`, no `getDocFromCache`
- Existence-only via `snap.exists()` — no `snap.data()`, no asyncOrder payload/body field reads
- Raw Firebase errors propagate to existing 3A-1 `normalizeLookupError`
- Staff missing-doc under branch-scoped rules may surface as `permission-denied`
- `exists=false` is clean admin-token path
- Sidecar-safe and read-only; no Firestore writes; no retry/resend

## Explicit Non-Scope

- No boot wiring; no `saleIntentSweepBoot`; no startup sweep execution
- No `main.tsx` / App / AuthProvider / AppShell / PosShellRoute / POSPage / PaymentModal / useCheckout changes
- No Packet 1 / Packet 2 / Packet 3A-1 / `saleIntentObserver` mutation
- No transition-matrix extension; no production runtime behavior change
- `asyncOrderLookup` not imported from any existing file

## Prior Phases

| Packet | Commit | Status |
|--------|--------|--------|
| Packet 3A-1 Sweep Primitives | `421d368` + docs `09cace8` | CLOSED / PUSHED |
| Packet 2 Runtime Observer | `d500bf9` + docs `371b537` | CLOSED / PUSHED |
| Packet 1 Sale Intent Journal | `3fe056e` + docs `644dc85` | CLOSED / PUSHED |

## Validation

| Check | Result |
|-------|--------|
| `npm run build` | PASS |
| `asyncOrderLookup.test.ts` | 13/13 |
| `saleIntentSweepLogic.test.ts` | 29/29 |
| `saleIntentSweep.test.ts` | 15/15 |
| `asyncCheckout.w01.test.ts` | 12/12 |
| `saleIntentObserver.test.ts` | 9/9 |
| `saleIntentJournalLogic.test.ts` | 32/32 |
| `saleIntentJournalStore.test.ts` | 18/18 |
| `npm run test:rules` | 119/119 |
| `git diff --check` | PASS |
| Codex implementation review | PASS (no blockers) |
| Push | PASS |
| stash@{0} | untouched |

## Deferred / Next Gate — Packet 3A-2B

**NOT STARTED.** Requires separate Gemini authorization. Must decide:

- Auth-ready boot trigger and mount point (Codex N1)
- Claims readiness gate; offline skip policy
- Web Locks / once-per-tab behavior; 10-second scheduling; batch bounds
- Physical UAT

**Codex N1:** Rules-of-hooks weakens PosShellRoute structural branch guarantee if hook called above early returns. Gemini must decide AppShell mount vs PosShellRoute with internal branch-validity gate. Did not block 3A-2A.

No boot wiring, startup sweep execution, or production lookup composition exists yet.

## Docs Reconciliation

Separate docs-only pass (TWINPET-P1-OFFLINE-SYNC-PACKET-3A-2A-DOCS-RECONCILIATION-CLAUDE-001). Not part of pushed commit `535073e`.
