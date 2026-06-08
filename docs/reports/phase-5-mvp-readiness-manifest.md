# Phase 5: MVP Readiness / Pre-UAT Stabilization Manifest

## A. Phase 5 Purpose
* Stabilization before new feature work.
* UAT (User Acceptance Testing) preparation.
* Evidence collection.
* Workflow hardening.
* Code freeze, unless a blocker is found and the Tech Lead explicitly approves a separate patch.

## B. Scope
This phase is strictly limited to docs, checklists, and evidence gathering only.
* UAT script.
* Manual state checks.
* Responsive viewport checks.
* Production monitoring plan.
* Developer self-review gate.
* Deferred follow-up tracking.

## C. Code Freeze Rule
* No app code changes.
* No `firestore.rules` changes.
* No Cloud Functions changes.
* No test changes.
* No package scripts changes.
* *Exception:* Unless a UAT blocker is documented and the Tech Lead explicitly approves a separate patch.

## D. UAT Script Plan
Cashier-facing UAT checklist:
- [ ] PIN login
- [ ] Branch loading failure
- [ ] Add product
- [ ] Search product
- [ ] Oversell soft warning
- [ ] Increase/decrease quantity
- [ ] Remove item
- [ ] Clear cart
- [ ] F12 payment
- [ ] Cash payment/change
- [ ] Duplicate submit prevention
- [ ] Async-safe queued wording
- [ ] Offline/weak-network behavior
- [ ] Same-day void
- [ ] Cross-day void blocked
- [ ] Admin exception list
- [ ] `retryReconcile` failure red alert
- [ ] `retryReconcile` async-safe requested wording

## E. Manual State Checks
For Auth/PIN login, POS/cart, Void flow, Payment modal, and Admin Exception UI, check:
- [ ] loading state
- [ ] empty state
- [ ] error state
- [ ] pending state
- [ ] rejected state
- [ ] offline/queued state
- [ ] permission denied state

## F. Responsive Evidence Plan
**Viewports to check:** 320px, 768px, 1080px.
**Surfaces to check:**
- Auth/PIN login
- POS product grid/cart
- Payment modal
- Admin Exception UI

Evidence must be explicitly captured screenshots, OR a manual checklist with exact browser viewport sizes, OR honestly deferred with reason.

## G. Production Monitoring Plan
First live transaction monitoring checklist:
- [ ] `verifyPinLogin`
- [ ] `asyncOrders` creation
- [ ] `reconcileOrder` logs
- [ ] stock deduction
- [ ] exception queue
- [ ] `retryReconcile` availability
- [ ] void request / same-day rule
- [ ] Firestore rejected writes / red alerts

## H. Release Evidence Rules
Must follow `SKILL-RELEASE-EVIDENCE.md`.
Items must be marked clearly as:
- Passed
- Failed
- Not run
- Deferred
- Infrastructure blocker
- DO NOT OVERCLAIM.

## I. Deferred Backlog Tracking
Current known deferred items:
* Responsive viewport evidence.
* Manual loading/empty/error/pending checks.
* Toast accessibility (`role="alert"` / `aria-live`).
* Dev-server script arg-forwarding warning.
* Flowbite React primitive polish where still manual.
* First real sale reconciliation log monitoring.
* GCS `gcf-sources` / artifact IAM/lifecycle audit post-MVP.

## J. Phase 5 Paranoid Checklist
- [ ] **Business Logic Integrity**: Ensured no logic modified.
- [ ] **State Isolation / `stash@{0}`**: Kept safe.
- [ ] **Cross-contamination**: Ensured strict docs-only separation.
- [ ] **Developer Self-Review Gate applied**: Added to workflow.
- [ ] **Devil's Advocate hidden risk**: Failing to honestly report UAT failures and falsely claiming readiness.
