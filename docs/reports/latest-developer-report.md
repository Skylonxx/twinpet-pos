# Developer Report

## Phase

**7C-UI-02-HOTFIX-FOCUS** — Aggressive Scanner Focus Hotfix

---

## REVISION 2 — Codex FAIL Blocker Fix (focus sequencing)

**Codex verdict on the first pass: FAIL** (`docs/reports/latest-codex-review.md`). This revision addresses the single blocker; the original hotfix description (sections 1–11 below) is unchanged except where noted here.

- **Codex FAIL blocker addressed.** Confirming a multi-UOM product through the **Select picker** enqueued it (→ `UomModal` via the `uomQueue` drain) but the picker `onClose` then **unconditionally** called `focusSearch()`, focusing the scan box behind the about-to-open UOM modal. Fixed.
- **ProductPicker confirm + multi-UOM path fixed.** The picker `onConfirm` now resolves the selection in one pass, computes `willOpenUom = resolved.some((p) => p.uomOptions.length > 1)`, threads `{ skipFocus: willOpenUom }` into every `onProductClick(product, …)`, and records `pickerWillOpenUomRef.current = willOpenUom`. The picker `onClose` refocuses **only** when that flag is false, then resets it.
- **Search focus is skipped when UOM modal is pending/opening.** `onProductClick` gained an optional `{ skipFocus }` so a *single-UOM* add inside a UOM-opening batch is also suppressed (covers a mixed selection). The direct grid card click omits the option and refocuses exactly as before; the direct multi-UOM card click still never refocuses. A plain cancel / standard (no-UOM) picker confirm **still** refocuses the scan box. `UomModal` owns focus until its own `onSelect`/`onClose`.
- **Why a ref (not state):** `ProductPickerDialog` fires `onConfirm` then `onClose` synchronously in the same tick, before any state update is observable — a ref is read reliably across that pair.
- **New contract coverage** for the exact gap Codex flagged: a combined *ProductPicker-confirm + multi-UOM* test asserts `willOpenUom`, the `skipFocus` threading, and the recorded flag; the picker-close test now asserts the **guarded** refocus (`if (!pickerWillOpenUomRef.current) focusSearch();`) and that the old unconditional refocus is gone.
- **`POSPage.css` remains untouched** (verified `git diff -- src/pages/POSPage.css` is empty). **No staging / no commit.** **Next owner remains Codex Reviewer** (re-review).

### Revision 2 checks

| Check | Result |
|---|---|
| `git diff --check` | clean |
| `git diff -- src/pages/POSPage.css` | empty (untouched) |
| `npx.cmd tsc -b` | PASS |
| `npx.cmd vitest run src/pages/POSPage.keyboard-contract.test.ts` | **128 passed** |
| `npx.cmd vitest run` | **695 passed (31 files)** |

### Files changed by Revision 2

- `src/pages/POSPage.tsx` — added `pickerWillOpenUomRef`; `onProductClick` optional `{ skipFocus }`; picker `onConfirm` two-pass + `willOpenUom`; picker `onClose` guarded/reset.
- `src/pages/POSPage.keyboard-contract.test.ts` — added combined picker+multi-UOM test; updated picker close/confirm + standard-add assertions.
- Workflow/report docs (`STATE.md`, `NEXT_ACTION.md`, this report).

---

## 1. Summary

Restored scanner-first cashier flow. Previously, clicking a **standard product card** (single-UOM, no UOM modal), a **category tab**, or a **top-bar action** (Refresh / Sort / Select) left keyboard focus trapped on the clicked element, so the cashier had to click the search box again before the next scan. This hotfix returns focus to the barcode/search input after each of those interactions, reusing the existing rAF-deferred `focusSearch()` helper. Modal-owned focus (UOM, Payment) and all cart/business behavior are unchanged. **No CSS change.**

## 2. Files Changed

| File | Action | Description |
|---|---|---|
| `src/pages/POSPage.tsx` | Modified | Moved `focusSearch` declaration up (after `searchInputRef`) so early handlers can reuse it; added `focusSearch()` to the standard-add branch of `onProductClick`, to `selectCategory`, `selectQuickMenu`, `handleManualRefresh`, and to the `ProductPickerDialog` / `SortingSettingsModal` `onClose` handlers. |
| `src/pages/POSPage.keyboard-contract.test.ts` | Modified | Added a `7C-UI-02-HOTFIX-FOCUS` describe block (6 tests); updated 4 existing region end-markers shifted by the new dependency arrays / `onClose` blocks. |

`src/pages/POSPage.css` — **not modified** (no style change). `useCart.ts`, `cartUtils.ts`, checkout/payment, stock matrix, toast, seed, Firebase, Android, `.claude/` — untouched.

## 3. Workflow Files Updated

- `docs/agent-workflow/STATE.md` — phase/owner/verdict/scope/pipeline/next-owner/stop-condition set for 7C-UI-02-HOTFIX-FOCUS; next owner = Codex.
- `docs/agent-workflow/CURRENT_PACKET.md` — active hotfix packet; role sequence Developer → Codex → Principal Engineer → Tech Lead/CEO; AGY bypassed.
- `docs/agent-workflow/NEXT_ACTION.md` — routes human operator to Codex with copy-paste block; AGY not used unless explicitly requested; no stage/commit; no UI-03.

## 4. Implementation Details

All runtime changes are in `src/pages/POSPage.tsx`:

- **Moved `focusSearch` up.** `selectCategory`, `selectQuickMenu`, and `handleManualRefresh` are declared *before* the old `focusSearch` location, so referencing it in their dependency arrays would have hit a temporal-dead-zone error at render. `focusSearch` (which only closes over the stable `searchInputRef`) is now declared right after the ref, available to every handler. Its body is unchanged — still `window.requestAnimationFrame(() => searchInputRef.current?.focus())`.
- **`onProductClick` (standard add only).** In the single-UOM `else` branch, after `cart.addToCart(...)`, it now calls `focusSearch()`. The multi-UOM `if` branch (which enqueues into `uomQueue` → opens `UomModal`) is **deliberately not refocused** — the modal owns focus until it closes, and its `onSelect`/`onClose` already call `focusSearch()`. Dependency array `[cart]` → `[cart, focusSearch]`.
- **`selectCategory` / `selectQuickMenu`.** Each appends `focusSearch()` after setting category state. Deps `[]` → `[focusSearch]`. This covers the physical category pills and the quick-menu pills. (The overlay path already routed through `closeCatModal`, which restores focus; calling it via `selectCategory` is harmless and idempotent.)
- **`handleManualRefresh`.** Appends `focusSearch()` after `refreshInventory()`. This control opens no modal, so focus would otherwise stay on the button; it covers both the Refresh action-bar button and the sync banner. Deps gain `focusSearch`.
- **`ProductPickerDialog.onClose` (Select) and `SortingSettingsModal.onClose` (Sort).** These actions open a modal, so focus is restored on **close** (not on open, to avoid fighting the modal's own focus). Each `onClose` now also calls `focusSearch()`.

### Focus timing / robustness

`focusSearch()` defers via `requestAnimationFrame`, so it runs *after* the click event and React state update have settled focus onto the clicked element — then moves it back to the scan box. This is the same proven mechanism already used by every modal-close path in the file, so no new timer/cleanup surface was introduced (rAF needs no teardown here).

## 5. Focus Behavior Changes

| Interaction | Before | After |
|---|---|---|
| Standard (single-UOM) product card | focus stuck on card | focus → scan box |
| Multi-UOM product card | opens UomModal | unchanged (modal owns focus; restores on close) |
| Category tab / Quick Menu pill | focus stuck on tab | focus → scan box |
| Refresh button / sync banner | focus stuck on button | focus → scan box |
| Select (เลือกสินค้า) picker | no focus return on close | focus → scan box on close |
| Sort (จัดเรียง) modal | no focus return on close | focus → scan box on close |
| Payment modal close | focus → scan box | unchanged |
| UOM modal select/close | focus → scan box | unchanged |

## 6. Keyboard / Search / Barcode Preservation Notes

- **Scanner logic** (`findByScanCode`, `handleSearchKeyDown`) — untouched.
- **Ctrl+F** — handler untouched.
- **Auto-focus** — `autoFocus` + `searchInputRef` untouched; `focusSearch` body unchanged.
- **UOM modal focus** — preserved (multi-UOM path intentionally excluded; modal `onSelect`/`onClose` still restore focus → test still asserts exactly 2 `focusSearch()` in that region).
- **Payment modal focus** — preserved (processing-guard + focus restore untouched).
- **F12 / payment open-gate** — untouched.
- **No cart math / business behavior** changed — focus restore is appended *after* existing actions only.

## 7. Tests / Checks Run

| Check | Result |
|---|---|
| `git status --short` | `M src/pages/POSPage.tsx`, `M src/pages/POSPage.keyboard-contract.test.ts` (+ workflow/report docs) |
| `git diff --name-only` | `POSPage.tsx`, `POSPage.keyboard-contract.test.ts` (+ workflow/report docs) |
| `git diff --stat` | `POSPage.tsx | 49`, `POSPage.keyboard-contract.test.ts | 63` |
| `git diff --check` | clean |
| `npx.cmd tsc -b` | PASS |
| `npx.cmd vitest run src/pages/POSPage.keyboard-contract.test.ts` | **127 passed** (was 121; +6 hotfix tests) |
| `npx.cmd vitest run` | **694 passed (31 files)** |

All required commands ran; nothing was blocked. `POSPage.css` shows 0 changed lines.

### New / updated tests

- **New describe `7C-UI-02-HOTFIX-FOCUS` (6 tests):** focusSearch early-declaration + rAF; standard-add refocus with multi-UOM excluded (exactly one `focusSearch()` in `onProductClick`); category + quick-menu refocus; Refresh refocus; Select picker close refocus; Sort modal close refocus.
- **Updated 4 existing region markers** shifted by the new dep arrays / `onClose` blocks: two `onProductClick` regions (`[cart],` → `[cart, focusSearch],`), the picker-confirm region end-marker (`onClose={() => setPickerOpen(false)}` → `onClose=`), and the `selectCategory` region (`}, []);` → `}, [focusSearch]);`). All assert the same intent as before.

## 8. Forbidden Areas Confirmation

- [x] Only authorized files changed
- [x] `POSPage.css` untouched (no style change)
- [x] `useCart.ts` / `useCart.contract.test.ts` / `cartUtils.ts` untouched
- [x] No cart math / business behavior change
- [x] Checkout / payment logic untouched
- [x] Stock matrix untouched
- [x] Seed data untouched
- [x] Toast files untouched
- [x] Firebase / functions / rules untouched
- [x] Android / Capacitor untouched
- [x] `.claude/` untouched
- [x] No scripts created; no new dependencies
- [x] No UI-03+ work
- [x] No staging, no commit; `stash@{0}` untouched (only `git stash list` used)

## 9. Hidden Risks / Notes

- **Multi-UOM exclusion is intentional and tested.** If a reviewer expects *every* card click to refocus, note the multi-UOM branch must not — it would fight `UomModal`'s focus. The test pins exactly one `focusSearch()` in `onProductClick`.
- **`onProductClick` is shared** by the grid click, the Enter-scan handler, and the picker-confirm loop. The added `focusSearch()` is idempotent/harmless in all three (Enter-scan already refocuses; picker closes via its own `onClose`, which also refocuses).
- **rAF only.** I kept the single-rAF helper rather than adding a `setTimeout(0)` fallback, because rAF is already proven for all existing modal-close refocus paths and avoids introducing timer cleanup or a focus-restore that could land after an intentionally-focused modal. If physical UAT still shows focus loss on a specific control, a layered rAF+timeout helper is the next lever — flagged for Codex.
- **No DOM/runtime test** (the suite is `node`, source-level `?raw` by design); coverage is structural-intent plus the existing contract assertions. Physical UAT remains the behavioral confirmation.

## 10. Next Recommendation

Route to **Codex Reviewer** for behavior / code / keyboard-contract review (AGY bypassed — behavioral hotfix). Provide Codex the current packet, this report, and the current `git diff`. On Codex PASS / PASS WITH NOTES, route to Principal Engineer Reviewer / Tech Lead for closure memo and exact staging/commit commands. Do not stage or commit. Do not start UI-03.

---

STATE CARD
Phase: 7C-UI-02-HOTFIX-FOCUS (Revision 2 — Codex FAIL blocker fix)
Current owner: Developer (fix complete) → Codex Reviewer (re-review)
Verdict: In Progress (re-review) — Codex FAIL blocker (picker confirm + multi-UOM refocus) resolved; awaiting Codex re-review
Files changed: src/pages/POSPage.tsx; src/pages/POSPage.keyboard-contract.test.ts; docs/agent-workflow/STATE.md; docs/agent-workflow/CURRENT_PACKET.md; docs/agent-workflow/NEXT_ACTION.md; docs/reports/latest-developer-report.md (POSPage.css NOT modified)
Tests/checks: git diff --check clean; POSPage.css diff empty; tsc -b PASS; POSPage.keyboard-contract 128 passed; full vitest 695 passed
Staged: None
Committed: None
Required fixes: None (Codex FAIL blocker addressed)
Next owner: Codex Reviewer (ROLE FILE: docs/ai-roles/reviewer.md)
Next action: Human operator sends Codex the current packet + this report + prior Codex FAIL + current diff for re-review using ROLE FILE: docs/ai-roles/reviewer.md; AGY bypassed unless explicitly requested
Stop condition: No staging, no commit, no UI-03+, no CSS change, no cart/checkout/stock work; stash@{0} untouched; wait for Codex re-review
