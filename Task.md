# Twinpet POS — Task Tracker

> Last reconciled: 2026-07-07
> HEAD: `30c32cd2f927a080b9729567bfa2f9f6f0832c16`
> origin/main: `30c32cd2f927a080b9729567bfa2f9f6f0832c16`

---

## P1 Offline / Sync Resiliency — Packet 3B-2 Atomic Device Sequence Allocator

**Status: CLOSED / PUSHED**

- [x] Implementation pushed (`30c32cd`) — `allocateLocalSeq()` + `deviceSeqAllocator.test.ts` (2 files)
- [x] Codex implementation review — PASS WITH NOTES (no blocking findings)
- [x] `npm run build` — PASS
- [x] `deviceSeqAllocator.test.ts` — 18/18
- [x] Regression suites — 150/150 Vitest subtotal, rules 119/119
- [ ] Docs reconciliation (this pass) — in progress

**Delivered:** Unwired atomic local sequence allocator primitive via IndexedDB readwrite transaction; bounded fail-open fallback to legacy `nextLocalSeq()`; existing public APIs compatible. `allocateOrderIdentity()` deferred to 3B-3. No checkout integration.

**Explicit non-scope:** No `useCheckout` / `asyncCheckout` changes; no asyncOrder ID/receipt format change; no Sale Intent Journal change; no 3B-3 work.

### P1 Packet 3A-2B — CLOSED / PUSHED

`cde8226` + docs `8ce68d3`. AppShell-mounted startup sweep boot wiring.

### P1 Packet 3A-2A — CLOSED / PUSHED

`535073e` + docs `944acfc`. asyncOrders lookup adapter.

### P1 Packet 3A-1 — CLOSED / PUSHED

`421d368` + docs `09cace8`. Sweep primitives.

### 3B-3 Decision Gate — NOT STARTED

Gemini may choose: authorize 3B-3 checkout preallocation integration, additional 3B-2 degraded-mode tightening, or hold.

### P1 Packet 2 / Packet 1 — CLOSED / PUSHED

### UI-11 Packet 1 / UI-10-C / UI-10-B / UI-10-A — CLOSED / PUSHED

### UI-10-D / UI-11 Packet 2 — NOT STARTED

### Next step

1. Formal Packet 3B-2 closure (this docs pass)
2. Optional Codex docs review after docs commit/push
3. 3B-3 Decision Gate — Gemini authorization only

**Not active:** Printer/Thermal (cancelled/deferred), UI-10-D, UI-11 Packet 2, 3B-3 checkout integration.
