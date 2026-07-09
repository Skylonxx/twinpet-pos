# Twinpet POS — Task Tracker

> Last reconciled: 2026-07-09
> HEAD: `9d4b811a1622fdefacbf76a2e5800b194b6161d9` (Packet 7C-B1 implementation this pass is unstaged, on top of this HEAD)
> origin/main: `9d4b811a1622fdefacbf76a2e5800b194b6161d9`

---

## P1 Offline / Sync Resiliency — Packet 7C-B1 Local Optimistic Offline Close (Option 2)

**Status: IMPLEMENTED + REMEDIATED (uncommitted) — pending Codex implementation re-review → Gemini commit authorization**

- [x] Packet 7C-B architecture report completed
- [x] Codex architecture review — REQUEST CHANGES (remediated)
- [x] Codex re-review — PASS WITH NOTES
- [x] Docs reconciliation (`9d4b811`)
- [x] Gemini 7C-B1 implementation authorization
- [x] 7C-B1 implementation — durable close-intent store, `closeShift` rewrite, `ShiftModals` optimistic path + pending badge, `POSPage` boot guard, tests
- [x] Codex implementation review — **REQUEST CHANGES** (queued shift-doc write omitted `closedAt: serverTimestamp()`, risking a permanently-null persisted close time)
- [x] Remediation — queued `updateDoc` now includes `closedAt: serverTimestamp()`; unused `closedAtServer:null` write removed; 2 new regression tests
- [ ] Codex implementation re-review
- [ ] Gemini commit authorization

**7C-B1 scope (Option 2) — delivered:** Durable local pending close only. `closeShift` verifies from local cache only (never awaits network), persists a durable close-intent before the queued shift-doc write, and returns a frozen client-built snapshot. Reliable post-reload ACK/rejection → **7C-B2 (not implemented)**.

**Files:** `src/lib/pos/offline/shiftCloseIntentStore.ts` (+types, +tests), `src/lib/pos/shiftService.ts` (+tests), `src/components/pos/ShiftModals.tsx` (+css, +tests), `src/pages/POSPage.tsx`, `src/lib/types.ts` (`closedAtLocal?: number`).

**Packet 5:** Required for backend validation/audit/settlement/cross-device authority — **not implemented**. Not required before honest local pending close.

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

## UI-10-D / UI-11 Packet 2 — NOT STARTED

### Next step

1. Packet 7C-B1 implementation — done, unstaged
2. Codex 7C-B1 implementation review — REQUEST CHANGES, remediated (this pass)
3. Codex 7C-B1 implementation re-review
4. Gemini commit authorization

**Not active:** 7C-B2, Packet 5, Packet 7B, PaymentModal W-12, Printer/Thermal, UI-10-D, UI-11 Packet 2.

**Roadmap priority after 7C-B1:** Packet 7C-B2 ACK/rejection reconciliation + Packet 5 Backend Deep Sync.
