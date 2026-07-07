# Twinpet POS — Task Tracker

> Last reconciled: 2026-07-07
> HEAD: `535073e2431350d924825733c1ebafd803cf889a`
> origin/main: `535073e2431350d924825733c1ebafd803cf889a`

---

## P1 Offline / Sync Resiliency — Packet 3A-2A asyncOrders Lookup Adapter

**Status: CLOSED / PUSHED**

- [x] Implementation pushed (`535073e`) — 2 new files under `src/lib/pos/offline/asyncOrderLookup*`
- [x] Codex implementation review — PASS (no blockers)
- [x] `npm run build` — PASS
- [x] `asyncOrderLookup.test.ts` — 13/13
- [x] Adjacent offline tests — sweep 44/44, W-01 12/12, observer 9/9, journal 50/50, rules 119/119
- [ ] Docs reconciliation (this pass) — in progress

**Delivered:** Unwired `createAsyncOrderServerLookup` factory; `getDocFromServer`-only; existence-only; raw error propagation; sidecar-safe read-only adapter. Not imported from any runtime path.

**Non-scope:** No boot wiring, no startup sweep execution, no existing file modifications, no Firestore writes.

### P1 Packet 3A-1 — CLOSED / PUSHED

`421d368` + docs `09cace8`. Lifecycle sweep primitives.

### P1 Packet 3A-2B — NOT STARTED

Requires separate Gemini authorization. Boot trigger/mount (Codex N1), claims readiness, offline skip, Web Locks, scheduling, batch bounds, physical UAT.

### P1 Packet 2 — CLOSED / PUSHED

`d500bf9` + docs `371b537`.

### P1 Packet 1 — CLOSED / PUSHED

`3fe056e` + docs `644dc85`.

### UI-11 Packet 1 — CLOSED / PUSHED

`ffa433c` + docs `cfc644c`.

### UI-10-C / UI-10-B / UI-10-A — CLOSED / PUSHED

### UI-10-D / UI-11 Packet 2 — NOT STARTED

### Next step

1. Formal Packet 3A-2A closure (this docs pass)
2. Optional Codex docs review after docs commit/push
3. P1 Packet 3A-2B only after separate Gemini authorization

**Not active:** Printer/Thermal (cancelled/deferred), UI-10-D, UI-11 Packet 2, P1 Packet 3A-2B.
