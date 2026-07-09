# Twinpet POS — Task Tracker

> Last reconciled: 2026-07-09
> HEAD: `74a84c3432cac16a8effb3c8317725e6671dad1f`
> origin/main: `74a84c3432cac16a8effb3c8317725e6671dad1f`

---

## P1 Offline / Sync Resiliency — Packet 7C-A Offline-Safe Close-Shift UX Guard

**Status: IMPLEMENTED (UNCOMMITTED) — pending Codex re-review / Gemini commit authorization**

- [x] Offline pre-close guard (fail-fast, honest Thai error, no `closeShift` call, no Z-report)
- [x] Bounded 10s timeout backstop with attempt-id guard against stale late resolution
- [x] Online happy path unchanged; Packet 7A warning unchanged
- [x] `shiftService.ts` / shift math / write path untouched
- [x] Tests added (`ShiftModals.test.tsx`)
- [x] Stale tracker remediation (docs-only)
- [ ] Codex re-review (next gate)
- [ ] Staging / commit / push (pending authorization)

**This is a temporary UX stopgap only** — not true offline close. See roadmap directive below.

### Roadmap directive — Packet 7C-B / Packet 5 (next priority after 7C-A closes)

Owner/Tech Lead directive: after Packet 7C-A is closed, absolute next priority is **Packet 7C-B (True Optimistic Offline Close)** and **Packet 5 (Backend Deep Sync)**. Neither implemented in this pass.

## P1 Offline / Sync Resiliency — Packet 7A Shift Close Warning

**Status: CLOSED / PUSHED / UAT PASS WITH NOTES / DOCS CLOSED**

- [x] Implementation pushed (`cb2e9ef`) — 4 files
- [x] Codex review — PASS WITH NOTES
- [x] UAT — PASS WITH NOTES (dev/emulator)
- [x] Docs closure (`74a84c3`)

**Implementation commit:** `cb2e9ef32521f5e1c82a2379a617fbb65dac3c37`

**Delivered:** Non-blocking close-shift warning for this-terminal pending sync; close remains enabled; no Z-report warning; no shift math/write-path changes.

**UAT:** `...\UAT\twinpet-p1-offline-sync-packet-7a-shift-close-warning-uat-report.md`

### UAT scenario summary

| Scenario | Result |
|----------|--------|
| S1 Zero pending | PASS |
| S2 Pending warning | PASS WITH NOTES |
| S3 Non-blocking close | PASS WITH NOTES |
| S4 Stale variant | NOT RUN |
| S5 Z-report absent | PASS |
| S6 Wording audit | PASS |

**Out-of-scope (UAT finding):** `closeShift()` offline hang — addressed by Packet 7C-A UX stopgap; permanent fix is Packet 7C-B.

### P1 Packet 8 — DOCS CLOSED

- [x] Dev-emulator drill PASS WITH NOTES
- [x] Docs closure (`6526970`)

### P1 Packet 6 — CLOSED / PUSHED / DOCS CLOSED

### P1 Packet 3B-4 / 3B-3 / 3B-2 / 3A-* / Packet 2 / Packet 1 — CLOSED / PUSHED

### UI-11 Packet 1 / UI-10-C / UI-10-B / UI-10-A — CLOSED / PUSHED

### UI-10-D / UI-11 Packet 2 — NOT STARTED

### Next step

1. Packet 7C-A Codex re-review (next gate — after stale-tracker remediation)
2. Packet 7C-A staging / commit / push (pending authorization)
3. After Packet 7C-A closes: Packet 7C-B (True Optimistic Offline Close) + Packet 5 (Backend Deep Sync) — absolute next priority per Owner/Tech Lead directive

**Not active:** Packet 7C-B, Packet 7B, Packet 5, PaymentModal follow-up, Printer/Thermal, UI-10-D, UI-11 Packet 2.

**Future candidates (highest priority first):** Packet 7C-B true optimistic offline close, Packet 5 backend/deep sync, Packet 7B admin reconciliation, true physical hardware drill (optional).
