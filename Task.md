# Twinpet POS — Task Tracker

> Last reconciled: 2026-07-07
> HEAD: `72354026046011f71db856a8ad9574676b034bcd`
> origin/main: `72354026046011f71db856a8ad9574676b034bcd`

---

## P1 Offline / Sync Resiliency — Packet 3B-3 Checkout Identity Preallocation

**Status: CLOSED / PUSHED**

- [x] Implementation pushed (`7235402`) — `useCheckout.ts`, `asyncCheckout.ts`, `asyncCheckout.w01.test.ts` (3 files)
- [x] Codex implementation review — PASS WITH NOTES
- [x] UAT — accepted by Gemini (owner-reported; Scenario 9 PASS WITH NOTES / UI-blocked)
- [x] `asyncCheckout.w01.test.ts` — 26/26
- [ ] Docs reconciliation (this pass) — in progress, unstaged

**Delivered:** `allocateOrderIdentity()` wired into checkout via `allocateLocalSeq()`; injected identity path verbatim; legacy path compatible; receipt/ID shape unchanged.

**Operational:** Hard refresh every open POS tab after deploy before claiming atomicity guarantee.

### P1 Packet 3B-2 — CLOSED / PUSHED

`30c32cd` + docs `c103112`. Atomic device sequence allocator primitive.

### P1 Packet 3A-2B — CLOSED / PUSHED

`cde8226` + docs `8ce68d3`. AppShell-mounted startup sweep boot wiring.

### P1 Packet 3A-2A / 3A-1 / Packet 2 / Packet 1 — CLOSED / PUSHED

### UI-11 Packet 1 / UI-10-C / UI-10-B / UI-10-A — CLOSED / PUSHED

### UI-10-D / UI-11 Packet 2 — NOT STARTED

### Next step

1. Formal Packet 3B-3 docs closure (this pass — unstaged)
2. Codex docs review
3. Gemini docs commit authorization

**Not active:** Printer/Thermal (cancelled/deferred), UI-10-D, UI-11 Packet 2.
