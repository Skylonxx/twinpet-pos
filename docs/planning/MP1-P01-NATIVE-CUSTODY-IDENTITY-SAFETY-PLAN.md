# Twinpet POS — MP1-P01 Native Custody & Identity Safety
## Planning-only acceptance contract (Owner-authorized draft)

**Prepared:** 2026-11-21 · **Document status:** `DESIGN_DRAFT_READY / NOT_IMPLEMENTATION_APPROVED`  
**Approval:** Product Owner approved **MP1-P01 planning only** after MP1-R01, not code/build/test/native/cloud/merge/release.  
**Current authority:** `POST_SEC001_NEXT_PHASE_SELECTION_ADJUDICATION`, `ACTIVE_IMPLEMENTATION_PACKET=NONE`; the workflow trio on `main` still prevails.  
**Source baseline:** GitHub `main` `f034301c46dd9e08190f869cc85dbb140ac28a3c`, separate preserved Stage056 tree and overlay 058 / patch 061.  
**Status distinction:** This is an architecture/acceptance **proposal** derived from MP1-R01 source risk review and selected main source reads; no independent Stage056 full replay, runtime test or production proof is claimed.

## 1. Product outcome (why this packet exists)

Protect the cashier's ability to accept a sale while offline **without allowing lost/duplicate bills, sequence reuse, unsafe identity restoration, or silent loss of native committed data**. An online response is not a prerequisite for local checkout; a corrupt/unverifiable committed local authority must **fail closed** rather than invent fresh trusted state. Keep honest UI states: locally accepted, pending sync, rejected/failed, server-confirmed.

This packet specifies safety invariants and a smallest-possible future implementation/proof boundary; it does **not** solve the remaining sale, stock, privileged-action, shift or release risks on its own.

## 2. Evidence already available (do not retest by default)

- **MP1-001:** Stage056 pins and selected patch hashes identified; SB63 SHA-256 `9f7fddf10ae89bd7364a973cbde670e0ddc2f81be1e93a347df54b9622159e91`; SB64/Stage065 copy `3caee049721e09735dc5a3c18b5cda786d91af5d6a4952d02db79b4efaa674a0`. A binary hash proves identity of bytes, not that a checkout passed.
- **MP1-002:** 1,364/1,366 *eligible* Stage056 entries matched manifest; two protected env files omitted, out-of-manifest extras not checked; 167 Stage056 changed paths triaged (64 production review, 101 tooling, 2 unknown). This does **not** authorize replay or integration.
- **MP1-R01:** `MP1_R01_REVIEW_COMPLETE_WITH_BLOCKERS`; native floor-only/virgin logic and device identity/sequence/journal atomicity are **blockers to future integration decision**, not observed runtime data loss.
- **Main source selectively inspected:** `src-tauri/src/durable_kv.rs` keeps a symlink-aware manifest path classifier and `open_kv_connection` validates existing domain schema; `src-tauri/src/epoch_floor.rs` tracks prior state; `src/lib/pos/deviceId.ts` documents dual localStorage/IndexedDB identity with a native committed store authority; `src/lib/pos/shiftCloseAuthoritativeClient.ts` defaults `SERVER_AUTHORITATIVE_CLOSE_ENABLED=false`.
- **Current UAT discrepancy:** overlay 058 switches the close gate to `true`. The official baseline remains `false`. This packet MUST NOT import/enable the UAT gate as a shortcut to completing a native UAT.

**Confidence labels:** `SOURCE_REVIEWED` for observed source constructs; `REPORT_ONLY` for old UAT outcomes; `PROPOSED` for the safety contract and future test criteria; `UNKNOWN` where runtime/atomicity remains unproven.

## 3. Invariants to design for (PROPOSED; require gate acceptance)

| ID | Required invariant | Current uncertainty |
|---|---|---|
| N1 | A previously committed durable root is never silently treated as a fresh virgin root because manifest or domain files are missing, unreadable, dangling or corrupt. Only positively established virgin state may create new committed authority. | Overlay 058 removes floor-only state from prior-Phase-B predicate; floor-only after partial loss could look virgin. |
| N2 | Manifest presence/classification is consistent at *all* entrypoints; invalid manifest versions, dangling symlink, non-file or unreadable paths fail closed. No fallback to destructive initialisation. | Need confirm predicate transition across `begin`, startup integrity, migration and root-lock callers for exact target. |
| N3 | Epoch floor never regresses; interrupted migration/upgrade/restart cannot silently reset data or select a lower epoch. | Floor-only, interrupted write and existing version state remain runtime-unknown for Stage056 + 058. |
| I1 | A terminal's durable device identity and local sequence are stable; repeated start, cache loss or new first boot must not reuse a previously committed bill number. | `deviceId` main vs Stage056/061 differs, first-boot blank-id/seq0 path and orphan seq >0 need design decision. |
| I2 | Blank device-id and `seq=0` represent a distinct virgin/unprovisioned case, NOT proof a historical identity never existed. Nonzero orphan sequence must never be silently reset to zero. | Patch 061 changes dumper output in staged code; compatibility with main native authority unknown. |
| I3 | User/principal, device generation/epoch and branch scope cannot switch between reserving a sequence, constructing bill identity, durable enqueue and retry without detection or atomic rejection. | JavaScript fences may run outside native transaction; optional guards, late async A→B→A. |
| I4 | Local sale intent has stable idempotency key, immutable bill/branch/device identity and exactly-one committed/reconciled effect after restart/lost acknowledgement. | Source checks are mechanisms; no proof of native commit + Firestore authoritative effect as one end-to-end contract. |

**No policy decision is made by this document on how to recover a damaged production root or orphan identity.** The conservative default for design review is `FAIL_CLOSED + OWNER_RECOVERY_REQUIRED`; any recovery workflow, counter reset, trust reassignment or migration must receive a separate Owner decision.

## 4. State/acceptance matrix for a *future separately authorized* test plan

| Scenario | Proposed safe result / acceptance oracle | Evidence state now |
|---|---|---|
| Truly clean root: no floor/manifest/domain and no prior committed identity | Virgin initialisation only if positive source-level conditions are satisfied; creation atomic and uniquely identifiable | `PROPOSED`, not run |
| **Floor-only** root: epoch floor exists, no manifest/domain | **Do not silently accept virgin** until prior-state invariant and recovery rule are proven; fail closed is conservative default | `BLOCKER` |
| Valid existing manifest + domain with compatible floor | Reopen same epoch/identity, no reinitialisation or sequence regression | `UNKNOWN` in UAT target |
| Manifest path present but corrupt/unreadable/dangling/non-file | Fail closed with non-destructive error, never create new domain | Main classifier source reviewed; target runtime `UNKNOWN` |
| Interrupted manifest/epoch migration (including partial writes) | No silent fallback or rollback to earlier committed epoch; original records preserved | `UNKNOWN` |
| Blank first boot, blank id + seq 0 | No invented orphan persisted sequence; only controlled new identity where root virgin is proven | `UNKNOWN`; patch 061 source reviewed |
| Blank/missing id but seq > 0 | Preserve historical evidence; refuse unsafe counter reuse until owner-approved recovery | `UNKNOWN` |
| A→B→A branch / principal / device epoch switch between allocation and enqueue | Either durable commit under original verified scope or explicit fail; no foreign-scope bill/receipt | `UNKNOWN` |
| Local commit → app restart → lost ACK → retry/reconnect | One stable bill identity and exactly-one accepted order and stock effect; local pending→confirmed only on server proof | End-to-end `UNKNOWN`; MP2 Native UAT remains LOCKED |
| Candidate reports Gate-ON close, official build Gate-OFF | Keep policy OFF; do not infer equivalence or UAT PASS for official close | `KNOWN SOURCE DIVERGENCE` |

**Future test design must name** isolated synthetic root, ownership of the runner, expected results, data-preservation boundary, recorded source SHA/build ID, exact assertion oracle and stopping condition. Merely listing scenarios is not a PASS or permission to execute.

## 5. Minimal future handoff candidates (DESIGN ONLY; not implementation authorization)

**Candidate N — native custody contract:** assess `src-tauri/src/durable_kv.rs` manifest/virgin predicate together with `epoch_floor.rs` and only their directly coupled startup/migration/root-lock interfaces. Compare existing `main` invariants with isolated 058 hunk. Do not copy 058 wholesale. Output should be a table of existing/virgin/partial-loss states, whether fail-closed holds, and exact minimal proposed change (possibly **NO CHANGE** if main already satisfies it).

**Candidate I — device identity & sequence contract:** assess `src/lib/pos/deviceId.ts`, relevant `deviceIdForWrite.ts` / `deviceIdentityEpoch.ts` Stage056 design, patch 061 and their bounded persistence/checkout callers. Contract must bind identity/seq to durable commit, branch and principal; choose whether `main` needs adaptation rather than importing the 167 path set. Output should be a minimal file/commit plan with risk notes, not a commit.

**Hold later work:** full sale journal/idempotency, `projectPrivilegedOfflineAction.ts` transaction authority, `useLocalLedger.ts`, stock/FIFO, shift close Gate-OFF proof, UAT enrollment and full native UAT. These are **separate tracked integration/release blockers**, not declared safe by acceptance of N/I. No extra packet auto-starts.

## 6. MP1-P01 design gate / Definition of Done

P01 may be marked `PLANNING_DRAFT_READY` when:
1. Each N1–N3 / I1–I4 invariant and scenario has explicit **source claim vs unknown vs proposed proof** (never an invented PASS).
2. Future Candidate N and Candidate I file boundaries, dependencies, possible `NO CHANGE`, and no-go conditions are documented; no bulk patching.
3. Owner decision list is explicit: floor-only root recovery policy, orphan seq recovery policy, trusted production source/gate, reviewer/implementer separation and exact approval to write future code.
4. Prior MP1 evidence and U1/B1-R 016–024 are retained without duplicate tests or a spontaneous EV loop.
5. `main`, workflow trio, source, cloud, app data, UAT binary and retained evidence are not changed.

**Not sufficient for M1 PASS:** the design plan, 1,364 hash matches, source-line review and selected focused tests. M1 requires an independently reviewed, traceable candidate and separately approved proof.

## 7. Authority and stop conditions

The current `AUTHORITY_MATRIX.md` still places Product Owner as final authority, Gemini as Tech Lead/phase gate, ChatGPT as Architecture Engineer, Codex coordinator/reviewer as separate identities, Claude developer as implementer. The newer Todoist planning role shorthand must **not silently supersede this matrix**. Resolve role mapping at formal M0 before implementation.

**STOP on:** missing lineage, unsafe assumption that floor-only means virgin, sequence reuse, loss of branch/principal fence, protected env/credential access, bypassing official Gate-OFF, any source/git/build/test/installer/cloud/runtime write or renewed U1 EV rabbit-hole.

## 8. Next one Owner decision (AFTER P01 review, not implicit approval)

Choose to accept/revise this **planning acceptance contract**, then separately authorize **one design-to-implementation Candidate N** under a dedicated safety/isolation/verification packet *or* keep implementation on hold. Candidate I is downstream and remains unapproved. Formal M0 successor implementation phase and live workflow-trio reconciliation are still pending.

**Linked evidence:** MP1-001 custody report; MP1-002 delta report; MP1-R01 `MP1_R01_REVIEW_COMPLETE_WITH_BLOCKERS`.  
**Portfolio:** [Master Plan](../MASTER-PLAN.md) · [Decisions](../DECISIONS.md) · [Progress](../PROGRESS.md) · [Todoist](https://app.todoist.com/app/project/6j43w86FgC6PhQh6).
