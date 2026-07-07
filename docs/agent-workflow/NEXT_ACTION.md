# Next Action

## Current State

- HEAD: `421d3683fa319d801c148557ebd004e5edf50346`
- **P1 Offline / Sync Packet 3A-1 Lifecycle Sweep Primitives** — **CLOSED / PUSHED** (`421d368`)
- **P1 Offline / Sync Packet 2 Runtime Observer** — CLOSED / PUSHED (`d500bf9` + docs `371b537`)
- **P1 Offline / Sync Packet 1 Sale Intent Journal** — CLOSED / PUSHED (`3fe056e` + docs `644dc85`)
- **UI-11 Packet 1** — CLOSED / PUSHED (`ffa433c` + docs `cfc644c`)
- **UI-10-C / UI-10-B / UI-10-A** — CLOSED / PUSHED
- **P1 Packet 3A-2** — **NOT STARTED**
- **UI-11 Packet 2** — **NOT STARTED**
- **UI-10-D** — **NOT STARTED**

## What Happens Next

1. Formal Packet 3A-1 closure (this docs pass)
2. Optional Codex docs review after docs commit/push
3. P1 Packet 3A-2 only after separate Gemini authorization — boot trigger, auth readiness, concrete Firestore lookup, online/offline behavior, startup execution safety

**Not active:** Printer/Thermal (cancelled/deferred), P1 Packet 3A-2, UI-11 Packet 2, UI-10-D.

## Reminders

- `stash@{0}` — do not touch
- Sale Intent Journal is sidecar-only — not source of truth; no retry/resend
- No boot wiring or startup sweep execution exists yet
- Missing server doc ≠ failure; lookup permission-denied ≠ `rejected_by_rules` in sweep
- `POSPage.tsx`, `PaymentModal.tsx`, `useCheckout.ts` remain untouched
