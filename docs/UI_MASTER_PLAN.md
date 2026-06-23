# UI MASTER PLAN

## Current Baseline

| Field | Value |
|-------|-------|
| HEAD | `889e23a fix(pos): make suspended bill ids LAN-safe` |
| origin/main | `889e23a` |
| Ahead/behind | `0 / 0` |
| Reconciliation | DOCS-ONLY / OPTION A — in progress (2026-06-23) |

## Recently Completed / Committed UI Work

All commits below are physically verified in `git log --oneline -n 40` at HEAD `889e23a`.

### POS Cashier UX & Cart

| Hash | Description |
|------|-------------|
| `889e23a` | Make suspended bill IDs LAN-safe |
| `602acea` | Restore hold bill modal flow with DOM coverage |
| `287955e` | Add suspended bill hold/restore contract tests |
| `873997e` | Polish action button hierarchy |
| `8a4ce19` | Polish cart summary layout and resolve responsive constraints |
| `630b742` | Polish cart item row readability |
| `521961f` | Refine seamless split cart layout |
| `3b6b8ed` | Add bump flash feedback for rescanned cart items |
| `c3f7193` | Bump rescanned cart line to top |
| `1e83473` | Stabilize product grid scrollbar gutter |
| `667093e` | Add UI layout preferences and realistic local seed |

### Product Grid & Category

| Hash | Description |
|------|-------------|
| `06bc831` | Add product card display preferences |
| `3b3b909` | Replace category modal with dropdown |
| `d13a9a1` | Restore modal header icons and simplify buttons |
| `b04f303` | Sync categories and refine cashier macro layout |

### Discount & Item Options

| Hash | Description |
|------|-------------|
| `85b3a31` | Add per-unit item discount option |
| `1a68983` | Repair discount badge and numpad touch behavior |
| `ab7eceb` | Stabilize discount modal draft state |

### Toast & Feedback

| Hash | Description |
|------|-------------|
| `f9d11ec` | Polish toast feedback and typography (UI-12 + UI-13 combined) |

### Stock Validation

| Hash | Description |
|------|-------------|
| `29995ea` | Enforce stock oversell matrix (3-tier: strict block / warn / silent) |

### Scanner & Focus

| Hash | Description |
|------|-------------|
| `ce49a82` | Polish refresh update state and focus recovery |
| `023cc8d` | Recover scanner focus across cashier actions |
| `42ff3ed` | Restore scanner focus after cashier actions |
| `bb9b1ad` | Refine search and barcode action bar |

### Prior Committed Work (at or before `07ed7c8`)

See Context.md for the full Phase 7B/7C history including:
- Phase 7B-H series (offline reversal lifecycle) — CLOSED / COMMITTED
- Phase 7C keyboard/focus/IME suite (D4-C-1..4) — CLOSED / COMMITTED
- Phase 7C-L1/L2/L3 (logic fixes + UOM display) — CLOSED / COMMITTED
- Phase 7C-UI-10-B/C (best seller system + strict local search) — CLOSED / COMMITTED
- Phase 7C-POS-Stock-Matrix (3-tier oversell control) — CLOSED / COMMITTED (`29995ea`)
- Phase 7C-UI-12/13 (toast system rebuild) — CLOSED / COMMITTED (`f9d11ec`)
- Phase 7C-UI-01 (layout, preferences, seed) — CLOSED / COMMITTED (`667093e`)

## UI-08 Status

**AMBIGUOUS / NEEDS SCOPE + PHYSICAL UAT RECONCILIATION**

UI-08 was referenced in the 7C-P1 triage plan (`d87110c`) as blocked on CEO clarification regarding:
1. The AppShell-header location (where it should live in the layout)
2. The "Sync" control identity (what it does and how it should behave)

No physical planning evidence or implementation exists for UI-08. Scope has not been defined. Cannot be authorized until the above clarifications are provided.

## UI-09 Status

**NOT READY FOR PLANNING**

No physical planning evidence exists for UI-09. It is not authorized and not ready for any work until:
1. Tracker reconciliation review is accepted
2. UI-08 scope is clarified
3. Explicit CEO / Tech Lead authorization is provided

## Deferred / Ambiguous Work

| Item | Status | Notes |
|------|--------|-------|
| UI-08 | AMBIGUOUS | Blocked on CEO clarification (see above) |
| UI-09 | NOT READY | No planning evidence, not authorized |
| Hardware scanner (iOS/iPad Safari) | DEFERRED | Strategically deferred to Native App / Capacitor wrapper phase |
| Flowbite migration (tables + modals) | DEFERRED | Batches 2+ deferred; stash@{0} holds WIP |
| Server sync / central audit (rejection logs) | FUTURE | Out of scope; local forensic panel (H7-G) is complete |

## Boundaries

- No implementation without explicit Tech Lead / CEO authorization
- No checkout/payment/cart math/stock math changes
- No Firebase/functions/rules changes
- stash@{0} must not be touched
- UI-01 through UI-09 traditional numbering is superseded by the physical commit history above

## Next Decision Gate

    REVIEW_RECONCILED_TRACKERS_BEFORE_IMPLEMENTATION

After tracker reconciliation review is accepted:
1. CEO / Tech Lead decides next implementation priority
2. UI-08 scope must be clarified before UI-08 work can begin
3. UI-09 cannot start until UI-08 is resolved
