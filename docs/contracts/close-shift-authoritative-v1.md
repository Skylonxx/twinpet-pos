# `closeShiftAuthoritative` — contract v1 (Return/Refund V1, packet 012)

Status: **implemented in Functions source, NOT deployed, NOT called by any client.**
Rules are unchanged: the legacy direct client W3 is still allowed (a documented
pre-cutover risk). `pos_return` stays disabled.

Source: `functions/src/closeShiftAuthoritative.ts` (auth + transaction),
`functions/src/closeShiftAuthoritativeCore.ts` (pure decisions).

## 1. Purpose and authority split

The callable is the destination **only trusted W3 writer** (D1). It closes the
caller's own open shift in one Admin transaction and writes exactly the
existing W3 field set, with money recomputed by the server.

| Value | Authority in v1 |
|---|---|
| `payInTotal`, `payOutTotal` | **Server-recomputed** from `shifts/{id}.cashEntries` in integer satang. Not accepted from the client (no such request field). |
| Cash Return payouts (`rfd_<returnId>` entries) | **Server-audited** against `saleRefunds` + `saleReturns` (server-only collections). `cashTransactions` (client-creatable) is never used as the authority. |
| Manual pay-in / pay-out entries | Folded as recorded on the shift (`shift_recorded_unattested`): the server checks shape/precision/uniqueness, not legitimacy. |
| `expectedCash/Qr/Kbank/Card/Credit`, `totalBills` | **Client-attested, unverified** (`salesTotals.status = attested_unverified`, reason `sale_sync_completeness_not_provable`). See §7. |
| `actualCashCount`, `note` | Cashier input. |
| `startingCash` | Stored W0 value, never rewritten. |
| `deviceId` | Informational only (recorded; never grants authority). |

## 2. Request (`contractVersion: 1`)

Exactly these keys — any other key (e.g. `payOutTotal`, `variance`,
`branchId`, `staffId`, `pin`) is `invalid_request`:

| Field | Type / bound |
|---|---|
| `contractVersion` | `1` |
| `shiftId` | string `^[^/]{1,200}$`, no surrounding whitespace |
| `closeCorrelationId` | lowercase RFC-4122 v4 UUID (same pattern as Rules / client store) |
| `actualCashCount` | number, finite, `0 … 10,000,000,000`, ≤ 2 dp (satang-exact) |
| `note` | string, ≤ 1000 chars (client must pre-validate; UI has no limit today) |
| `attestedSales` | object with exactly `expectedCash`, `expectedQr`, `expectedKbank`, `expectedCard`, `expectedCredit` (each like `actualCashCount`) and `totalBills` (safe integer `0 … 100,000`) |
| `deviceId` | string, 1–200 chars, no surrounding whitespace |

Caller identity comes **only** from `request.auth.token.staffId` +
`authVersion`, evaluated against the live `users/{staffId}` doc read inside
the transaction.

## 3. Authorization (D7: owner only, no override)

Inside the transaction, in this order:
1. `users/{staffId}` exists, `isActive === true`, `deletedAt == null` → else `not_authorized`.
2. live `authVersion` (default 0) `===` token `authVersion` (default −1) → else `session_stale`.
3. live `role ∈ {admin, manager, staff}` → else `not_authorized`.
4. shift exists → else `shift_not_found`.
5. `shift.staffId === staffId` (current owner) → else `not_shift_owner` (also for managers/admins: **no manager override in v1**).
6. live branch: staff/manager exact `branchIds ∋ shift.branchId`; admin exact or `ALL` → else `branch_not_authorized`.

Only after 5–6 is anything about the shift's state revealed.

## 4. Transaction (all reads before any write)

Reads: `users/{staffId}`, `shifts/{shiftId}`, `shiftCloseAuthorityRecords/{shiftId}`,
`saleRefunds where shiftId == S limit 1001`,
`saleReturns where refund.shiftId == S limit 1001`.

Checks (any failure ⇒ typed refusal, **transaction aborted, zero writes**):
- `status === 'closed'` → idempotency path (§6). Any status other than `open` → `shift_state_invalid`. Open shift with an authority record → `close_record_inconsistent`.
- identity: `id === shiftId`, non-empty `branchId` (≠ `ALL`), `staffId`, string `staffName`, `openedAt` present, `startingCash` satang-exact → else `shift_record_invalid`.
- `cashEntries`: absent ⇒ `[]`; present non-list / non-object element / sparse hole / blank or non-string id / unknown type / amount not in `(0, 10,000,000]` ≤ 2 dp ⇒ `cash_entries_invalid`; duplicate id ⇒ `cash_entry_duplicate`; > 1000 entries ⇒ `cash_entries_over_cap`. Never deduped, dropped, rounded or repaired.
- refund audit (§5).
- money: `expectedDrawer = startingCash + expectedCash + payIn − payOut`, `variance = actualCashCount − expectedDrawer` in integer satang; totals and `|variance|` inside the Rules envelope (`amount_out_of_bounds`).

Writes (only after every check):
- `tx.update(shifts/{id})` with exactly the client `closeWritePayload` / Rules
  `isW3ShiftClose` key set: `status:'closed'`, `closedAt: serverTimestamp()`,
  `actualCashCount`, `variance`, `note`, the five `expected*`, `totalBills`,
  `payInTotal`, `payOutTotal`, `closedOffline: true`, `syncState: 'pending'`,
  `deviceId`, `closeCorrelationId`. **No other field is added to `shifts`.**
- `tx.create(shiftCloseAuthorityRecords/{shiftId})` (new server-only collection,
  covered by the Rules catch-all deny): contract/protocol version, caller,
  correlation id, request digest, the 17-field snapshot, all satang minors,
  cash audit (entry count + digest, manual sums, refund count/total/returnIds),
  `salesVerification`, `closedAt` (same commit timestamp as the shift).

**Stored `variance`:** the exact client expression
`actualCashCount − (startingCash + expectedCash + payInTotal − payOutTotal)`
over the stored doubles, so the client strict parser (`parseCommittedOwnClose`)
holds bit-for-bit; it must equal the satang variance to < 0.01 satang, else
`money_precision_unsafe`.

## 5. Return refund audit and completeness argument

Every server cash refund `r` with `r.shiftId == S` must satisfy: doc id ==
`refundId` == `returnId`, `method 'cash'`, `executionMode 'cash_drawer'`,
`branchId == shift.branchId`, `requesterStaffId == shift.staffId`,
`cashEntryId == 'rfd_' + returnId`, satang-exact amount, schema 1
(`refund_record_invalid`). Its `saleReturns/{returnId}` (status `completed`,
same branch/staff, `refund.{method,refundId,shiftId,cashEntryId,amount}`)
must exist with the same amount (`refund_return_mismatch`, both directions).
Each must pair with exactly one `pay_out` entry of the same id and satang
amount (`refund_missing_in_shift`, `refund_entry_mismatch`); every `rfd_`
entry must pair with a refund (`orphan_refund_entry`). More than 1000 records
⇒ `refund_set_over_cap`; a failed/unreadable query ⇒ `refund_audit_unavailable`.

**Why the queried set is complete (source-backed, see report §5):**
- The only writer of `saleRefunds` / `saleReturns` is the Admin
  `performSubmitSaleReturn` transaction (clients: catch-all deny / read-only).
- For a cash refund on S that transaction `tx.get(shifts/S)` (requires `open`,
  branch, owner) and `tx.update(shifts/S)` in the **same commit** that creates
  both records.
- The close transaction also reads and writes `shifts/S`. Firestore
  transactions are serializable, so the two cannot interleave: a Return
  committed before the close's (re)run is fully visible to its reads (records
  included); a Return after the close re-reads `closed` and refuses
  (`shift_required`).
- Limits: the guarantee is about records referencing S. Records written by
  any *future* non-transactional writer, or by out-of-band admin tooling,
  would break it — none exists at HEAD. Equality queries on `shiftId` and
  `refund.shiftId` use automatic single-field indexes; no exemption exists in
  `firestore.indexes.json`, **live index exemptions are UNVERIFIED** (deploy
  gate). If an index were missing the query fails ⇒ refusal, never a partial set.
- Bounded alternative if ever needed: maintain a server-only per-shift refund
  ledger doc (`shiftRefundLedgers/{shiftId}`: count, total, ids) inside the
  Return transaction and read it by key instead of querying (requires a
  backfill for already-open shifts).

## 6. Responses and idempotency

Success (`ok: true`), built **only** from the durable shift doc + authority
record (first commit is read back; replays read the same):

```
{ ok: true, contractVersion: 1, closeProtocol: 'server_authoritative_v1',
  idempotentReplay, shiftId, closeCorrelationId, closedAtMillis,
  snapshot: { 17 ShiftCloseIntentBusinessSnapshot fields, exact stored values },
  persistedClose: { status: 'closed', closedOffline: true, syncStateAtClose: 'pending' },
  money: { startingCashMinor, expected{Cash,Qr,Kbank,Card,Credit}Minor, payInMinor,
           payOutMinor, expectedDrawerMinor, actualCashCountMinor, varianceMinor },
  provenance: { cashMovements: 'server_recomputed',
                returnRefunds: { status: 'server_audit_matched', count, totalMinor },
                manualCashEntries: { status: 'shift_recorded_unattested', count, payInMinor, payOutMinor },
                salesTotals: { status: 'attested_unverified', reason: 'sale_sync_completeness_not_provable' },
                clientJournal: 'not_finalized_by_server' } }
```

Idempotency (shift already `closed`, after the owner/branch checks; never writes):
| Situation | Result |
|---|---|
| same UUID, same request digest, consistent authority record | the canonical success, `idempotentReplay: true` (W4 `pending→synced` tolerated) |
| same UUID, different content (incl. `deviceId`) | `idempotency_conflict` |
| different / absent UUID | `already_closed` |
| same UUID, no authority record (closed by a direct client W3) | `closed_outside_authority` — never reported as server-verified |
| record and shift disagree | `close_record_inconsistent` |

Failure (`ok: false, code`): `invalid_request`, `unauthenticated`,
`not_authorized`, `session_stale`, `branch_not_authorized`, `shift_not_found`,
`not_shift_owner`, `shift_record_invalid`, `shift_state_invalid`,
`already_closed`, `closed_outside_authority`, `idempotency_conflict`,
`close_record_inconsistent`, `cash_entries_invalid`, `cash_entries_over_cap`,
`cash_entry_duplicate`, `refund_audit_unavailable`, `refund_set_over_cap`,
`refund_record_invalid`, `refund_return_mismatch`, `refund_missing_in_shift`,
`refund_entry_mismatch`, `orphan_refund_entry`, `amount_out_of_bounds`,
`money_precision_unsafe` — all definitive: **nothing written**.

`committed_unconfirmed`: the transaction committed but the read-back failed —
retry with the same UUID to obtain the canonical replay. An unexpected error
(contention exhausted, transport) surfaces as `HttpsError('unavailable')`:
outcome unknown, never success; a same-UUID retry is safe.

## 7. Sale-derived totals (D3) — explicit limit

The server cannot prove that every sale of the shift has synced (terminals
sell offline; no server-known per-shift sale count/sequence exists), so v1
**never** verifies or relabels the sale totals: `salesTotals.status` is always
`attested_unverified`. P5-D detection remains the after-the-fact check. A
future "verified when provably complete" mode needs a server-checkable
completeness witness (e.g. a terminal-signed per-shift sale sequence/count)
and is a separate decision. Consequence for the Return rollout: the server
guarantees Return payouts cannot be dropped or misstated in a callable close;
it does **not** certify sale totals.

## 8. Future client adapter (later packet — NOT implemented)

The adapter replaces only the `tx.update(closeWritePayload)` inside
`closeShiftOnline` with this call and keeps: durable prepared attempt +
correlation id before the call (B2); 006-A strict authoritative server read +
`snapshotsEqual` against `response.snapshot`; 007-B exact-attempt finalize;
008 W4 retry. `ok:true` proves the server commit only — the journal/Z still
require the client's own proof. Unknown outcome / `committed_unconfirmed` ⇒
keep the attempt and retry with the same UUID. Online-only for the Return
rollout (D2); offline close must fail closed explicitly before the seal.

## 9. Text-only Rules cutover specification (NOT applied)

Later Rules packet, deployed only with release authority after callable +
client readiness: remove `isW3ShiftClose()` from the `shifts` update
disjunction (keep W1 incl. 009/010 prefix + `rfd_` reservation, W2, W4);
add `!txId.matches('(?s)rfd_.*')` to `cashTransactions` create; emulator
proof that a malicious/old-client W3 is denied and the callable close + W4
still work; invert `rules-tests/shift-close-authoritative-precutover.spec.ts`
risk cases to `assertFails`; migrate the specs that drive client W3.

## 10. Release ordering and rollback (document only)

012 server core (this) → independent review → 013+ client adapter (online-only
close for Return, offline fail-closed) → Rules seal packet (local) → deploy
additive callable → validate upgraded client in a controlled environment →
fleet operational readiness + manager fallback → read-only historical audit →
deploy sealed Rules (explicit authority) → verify old W3 denied, callable
works → separately enable `pos_return`. Never enable Return while direct W3
is allowed. Rollback: disable Return first, then any Rules rollback under
controlled authority. Installed 0.1.12 bytes and the browser/PWA fleet are
UNVERIFIED release-checklist items (D5/D9).
