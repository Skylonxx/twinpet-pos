# Twinpet POS — Project Context

> Last reconciled: 2026-07-07
> HEAD: `421d3683fa319d801c148557ebd004e5edf50346`
> origin/main: `421d3683fa319d801c148557ebd004e5edf50346`

---

## Current Phase

**P1 Offline / Sync Resiliency — Packet 3A-1 Lifecycle Sweep Primitives: CLOSED / PUSHED**

Manual workflow remains active. `agentchattr` was not used as the executor for this phase.

### P1 Packet 3A-1 pushed commit

| Hash | Message |
|------|---------|
| `421d368` | feat(pos): add sale intent lifecycle sweep primitives |

### P1 Packet 3A-1 scope (4 new files only)

- `src/lib/pos/offline/saleIntentSweepLogic.ts` — pure sweep decision logic
- `src/lib/pos/offline/saleIntentSweepLogic.test.ts`
- `src/lib/pos/offline/saleIntentSweep.ts` — dependency-injected runner
- `src/lib/pos/offline/saleIntentSweep.test.ts`

No existing tracked files modified.

### P1 Packet 3A-1 behavior

- Pure sweep decision logic + dependency-injected runner
- 10-minute stale threshold
- Candidate statuses: `queued`, `flushed_to_cache`, `exception_observed`
- `rejected_by_rules` and `manual_review` remain parked/report-only
- Missing server docs → ambiguous no-transition skip
- Lookup errors (`permission-denied`, `unauthenticated`, `unavailable`, unknown) → ambiguous no-transition skip
- `exception_observed` + server exists → event-only / no illegal transition
- No retry / resend behavior; bounded and fail-open; sidecar-only
- Sale Intent Journal is not source of truth

### P1 Packet 3A-1 explicit non-scope

- No boot wiring; no startup sweep execution
- No `main.tsx`, `App.tsx`, AuthProvider, `POSPage.tsx`, `PaymentModal.tsx`, `useCheckout.ts` changes
- No Packet 1 / Packet 2 / `saleIntentObserver` mutation
- No transition-matrix extension; no concrete Firestore production lookup wiring
- No sequence hardening; no manual review UI; no production runtime behavior change

### Prior — Packet 2 Runtime Observer

| Hash | Message |
|------|---------|
| `d500bf9` | feat(pos): add sale intent observer wiring |
| `371b537` | docs: reconcile p1 offline sync packet 2 closure |

### Prior — Packet 1 Sale Intent Journal

| Hash | Message |
|------|---------|
| `3fe056e` | feat(pos): add sale intent journal sidecar |

### Validation (P1 Packet 3A-1)

| Check | Result |
|-------|--------|
| `npm run build` | PASS |
| `saleIntentSweepLogic.test.ts` | 29/29 |
| `saleIntentSweep.test.ts` | 15/15 |
| `asyncCheckout.w01.test.ts` | 12/12 |
| `saleIntentObserver.test.ts` | 9/9 |
| `saleIntentJournalLogic.test.ts` | 32/32 |
| `saleIntentJournalStore.test.ts` | 18/18 |
| `npm run test:rules` | 119/119 |
| `git diff --check` | PASS |
| Codex implementation review | PASS WITH NOTES (no blockers) |
| Push | PASS — HEAD == origin/main == `421d368` |

**Codex non-blocking note:** `decideSweepAction()` assumes candidate pre-filtering; current runner enforces this invariant correctly; future changes should preserve it or make helper defensive.

### Deferred / next gate

- **P1 Packet 3A-2** — NOT STARTED; requires separate Gemini authorization
  - Must decide: boot trigger point, auth/user/custom-claims readiness, concrete Firestore lookup implementation, online/offline behavior, startup execution safety
- **UI-11 Packet 2** — NOT STARTED
- **UI-10-D** — NOT STARTED
- **Printer / Thermal Receipt / Print Polish** — cancelled/deferred

### Known technical debt (unchanged)

- PaymentModal focus trap — deferred; see UI_MASTER_PLAN backlog
