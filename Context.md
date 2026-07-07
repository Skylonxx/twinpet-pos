# Twinpet POS — Project Context

> Last reconciled: 2026-07-07
> HEAD: `535073e2431350d924825733c1ebafd803cf889a`
> origin/main: `535073e2431350d924825733c1ebafd803cf889a`

---

## Current Phase

**P1 Offline / Sync Resiliency — Packet 3A-2A asyncOrders Lookup Adapter: CLOSED / PUSHED**

Manual workflow remains active. `agentchattr` was not used as the executor for this phase.

### P1 Packet 3A-2A pushed commit

| Hash | Message |
|------|---------|
| `535073e` | feat(pos): add async order server lookup adapter |

### P1 Packet 3A-2A scope (2 new files only)

- `src/lib/pos/offline/asyncOrderLookup.ts`
- `src/lib/pos/offline/asyncOrderLookup.test.ts`

No existing tracked files modified. Not imported from any runtime path.

### P1 Packet 3A-2A behavior

- Unwired `asyncOrders` lookup adapter
- `createAsyncOrderServerLookup` factory
- Returns `null` when Firebase is unconfigured or `db` unavailable
- `getDocFromServer`-only — no `getDoc`, no `getDocFromCache`
- Existence-only via `snap.exists()` — no `snap.data()`, no payload/body field reads
- Raw Firebase errors propagate to existing 3A-1 `normalizeLookupError`
- Staff missing-doc under branch-scoped rules may surface as `permission-denied`
- `exists=false` is clean admin-token path
- Sidecar-safe and read-only; no Firestore writes; no retry/resend

### P1 Packet 3A-2A explicit non-scope

- No boot wiring; no startup sweep execution; no `saleIntentSweepBoot`
- No `main.tsx` / App / AuthProvider / AppShell / PosShellRoute / POSPage / PaymentModal / useCheckout changes
- No Packet 1 / Packet 2 / Packet 3A-1 / `saleIntentObserver` mutation
- No transition-matrix extension; no production runtime behavior change
- `asyncOrderLookup` not imported from any existing file

### Prior — Packet 3A-1 Lifecycle Sweep Primitives

| Hash | Message |
|------|---------|
| `421d368` | feat(pos): add sale intent lifecycle sweep primitives |
| `09cace8` | docs: reconcile p1 offline sync packet 3a-1 closure |

### Validation (P1 Packet 3A-2A)

| Check | Result |
|-------|--------|
| `npm run build` | PASS |
| `asyncOrderLookup.test.ts` | 13/13 |
| `saleIntentSweepLogic.test.ts` | 29/29 |
| `saleIntentSweep.test.ts` | 15/15 |
| `asyncCheckout.w01.test.ts` | 12/12 |
| `saleIntentObserver.test.ts` | 9/9 |
| `saleIntentJournalLogic.test.ts` | 32/32 |
| `saleIntentJournalStore.test.ts` | 18/18 |
| `npm run test:rules` | 119/119 |
| `git diff --check` | PASS |
| Codex implementation review | PASS (no blockers) |
| Push | PASS — HEAD == origin/main == `535073e` |

### Deferred / next gate — Packet 3A-2B

**NOT STARTED** — requires separate Gemini authorization. Must decide:

- Auth-ready boot trigger and mount point (see Codex N1 below)
- Claims readiness gate; offline skip policy
- Web Locks / once-per-tab behavior; 10-second scheduling; batch bounds
- Physical UAT

**Codex N1 (3A-2B-scoped, did not block 3A-2A):** Rules-of-hooks weakens the PosShellRoute structural branch guarantee if the hook is called above early returns. Before 3A-2B boot wiring, Gemini must decide either mount in AppShell (structurally past PosShellRoute guards), or keep PosShellRoute but add an internal branch-validity gate so admin/invalid-branch redirects do not rely solely on mount structure.

### Other deferred

- **UI-11 Packet 2** — NOT STARTED
- **UI-10-D** — NOT STARTED
- **Printer / Thermal** — cancelled/deferred

### Known technical debt (unchanged)

- PaymentModal focus trap — deferred; see UI_MASTER_PLAN backlog
