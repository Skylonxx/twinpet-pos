# Twinpet POS — Project Context

> Last reconciled: 2026-07-09
> HEAD: `74a84c3432cac16a8effb3c8317725e6671dad1f`
> origin/main: `74a84c3432cac16a8effb3c8317725e6671dad1f`

---

## Current Phase

**P1 Offline / Sync Resiliency — Packet 7C-A Offline-Safe Close-Shift UX Guard: IMPLEMENTED (UNCOMMITTED) — pending Codex re-review / Gemini commit authorization**

Manual workflow remains active. `agentchattr` was not used as the executor for this phase.

### P1 Packet 7C-A Offline-Safe Close-Shift UX Guard

**Status:** IMPLEMENTED (UNCOMMITTED) — Gemini authorized (`TWINPET-P1-OFFLINE-SYNC-GEMINI-PACKET-7C-A-IMPLEMENT-AND-ROADMAP-UPDATE-001`); Codex initial review REQUEST CHANGES (stale tracker only); remediation complete, pending re-review.

**Scope (temporary UX stopgap only):**
- Fail-fast pre-close offline guard: if `navigator.onLine === false`, `CloseShiftModal.handleClose` shows a localized Thai error and never calls `closeShift`, never enters indefinite `กำลังปิดกะ...`, never renders Z-report, never claims queued/synced/settled/guaranteed success.
- Bounded 10s timeout backstop around the awaited `closeShift(...)` call: if it doesn't settle in time, submitting is released, an honest localized connectivity error is shown, and retry remains possible. A late resolution/rejection from the original attempt is ignored once a retry has started (attempt-id guard), so a stale response can never silently flip the UI to Z-report after the user has already retried.
- Online happy path and Packet 7A this-terminal pending-sync warning are unchanged.
- `shiftService.ts`, `closeShift`, shift math, drawer totals, variance, and Z-report totals are **not modified**.

**This is not true offline close.** It only prevents a cashier-facing dead end; see roadmap directive below.

### Roadmap directive — Packet 7C-B / Packet 5 priority

Per Owner/Tech Lead strategic directive (via Gemini authorization `TWINPET-P1-OFFLINE-SYNC-GEMINI-PACKET-7C-A-IMPLEMENT-AND-ROADMAP-UPDATE-001`):

> To strictly adhere to the Offline-First philosophy, after Packet 7C-A is closed, the absolute next priority must be the architectural design and implementation of True Optimistic Offline Close (Packet 7C-B) and Backend Deep Sync (Packet 5).

- Packet 7C-A is only a temporary UX stopgap, not true offline close.
- **Packet 7C-B** must design and implement true optimistic, local-first close-shift behavior.
- **Packet 5** (backend deep sync / reconciliation architecture) remains needed alongside 7C-B.
- Neither Packet 7C-B nor Packet 5 is implemented in this pass — design/implementation work is future scope, not started.

### P1 Packet 7A shift close warning (prior — CLOSED / PUSHED / DOCS CLOSED)

**Status:** CLOSED / PUSHED / UAT PASS WITH NOTES / DOCS CLOSED.

**Implementation commit:** `cb2e9ef32521f5e1c82a2379a617fbb65dac3c37` — `feat(pos): warn on pending sync before closing shift`

**Docs commit:** `74a84c3432cac16a8effb3c8317725e6671dad1f` — `docs: close p1 packet 7a shift warning`

**Delivered:**
- Non-blocking close-shift warning before close when this terminal has pending local sync bills
- Warning copy is this-terminal/device-local — no global/cross-terminal coverage claim
- Close/confirm remains enabled — not a hard gate
- No warning in Z-report view
- No shift math, closeShift write-path, drawer totals, variance, or Z-report math changes
- No PaymentModal / checkout / journal write / backend / rules / functions changes

**UAT report:** `C:\Users\Narachat\OneDrive\Ai-Report\twinpet-pos\UAT\twinpet-p1-offline-sync-packet-7a-shift-close-warning-uat-report.md`

**UAT environment:** local dev/emulator — Firebase emulators + Vite + headless Chromium / Playwright CDP offline toggle. **Not** physical hardware. **Not** production. No production Firestore touched.

### Scenario outcomes (Packet 7A UAT)

| Scenario | Result |
|----------|--------|
| S1 Zero pending: no warning | PASS |
| S2 Pending-sync warning with this-terminal count | PASS WITH NOTES |
| S3 Non-blocking close behavior | PASS WITH NOTES |
| S4 Stale variant | NOT RUN |
| S5 Warning absent after close / Z-report view | PASS |
| S6 No overclaim / wording audit | PASS |

### Key UAT evidence

- Zero pending → no warning
- Pending → warning with correct count; copy: `มีบิลรอซิงก์จากเครื่องนี้ 1 บิล` / `บิลเหล่านี้บันทึกในเครื่องแล้ว แต่อาจยังไม่ซิงก์ขึ้นระบบ กรุณาตรวจสอบก่อนปิดกะ`
- Close button remains enabled; warning is non-blocking
- Warning absent from Z-report; no global/cross-terminal or guaranteed-settlement overclaim

### Poll cadence note

Warning uses existing `SaleIntentSyncPanel` polling cadence. Count can lag up to ~5-second poll interval. Opening close shift immediately after offline sale may transiently show no warning until next poll. Acceptable — feature is non-blocking warning, not authoritative gate.

### Out-of-scope defect (addressed by 7C-A stopgap; permanent fix is Packet 7C-B)

`shiftService.closeShift()` offline hang while fully offline — Packet 7A did not cause this. Packet 7C-A adds UX guard only; does not permanently fix `closeShift` offline behavior. Permanent fix requires Packet 7C-B.

### Report references

- Implementation: `...\Developer\twinpet-p1-offline-sync-packet-7a-shift-close-warning-implementation-report.md` — PASS
- Codex review: `...\reviewer\twinpet-p1-offline-sync-packet-7a-shift-close-warning-codex-review-report.md` — PASS WITH NOTES
- Commit/push: `...\Developer\twinpet-p1-offline-sync-packet-7a-shift-close-warning-commit-push-report.md` — PASS

### No-overclaim boundaries

- No global/cross-terminal coverage claim
- No guaranteed settlement claim
- No true hardware or production validation claim
- No full offline cold-boot claim
- Packet 7C-A did not permanently fix offline close hang — 7C-B required
- Packet 7A is not a hard close-shift gate
- Packet 7C-A is not true offline close
- Pending count is not authoritative for all terminals

### P1 Packet 8 (prior — DOCS CLOSED)

Dev-emulator offline drill PASS WITH NOTES. Docs `6526970`. **Not** true physical hardware validation.

### P1 Packet 6 (prior — CLOSED / PUSHED / DOCS CLOSED)

`81d8a20` + `2a98f33` + docs `8197d64`. Owner visual UAT PASS WITH NOTES.

### Residuals / future

- Packet 7C-B true optimistic offline close (absolute next priority after 7C-A closes)
- Packet 7B admin reconciliation report (after Packet 5/backend clarity)
- Packet 5 backend/deep sync planning
- PaymentModal W-12 note
- Optional true hardware UAT supplement
- Stale variant live UAT not run

### Deferred / next gate

**Packet 7C-A Codex re-review** — after stale-tracker remediation. Then Gemini commit authorization for 7C-A implementation + roadmap update.

### Other deferred

- **UI-11 Packet 2** — NOT STARTED
- **UI-10-D** — NOT STARTED
- **Printer / Thermal** — cancelled/deferred

### Known technical debt (unchanged)

- PaymentModal focus trap — deferred; see UI_MASTER_PLAN backlog
- Sale Intent Journal is sidecar-only — not source of truth
