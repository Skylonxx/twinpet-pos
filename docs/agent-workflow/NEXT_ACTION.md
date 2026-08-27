# Next Action

## Current State

- Phase A landing / source baseline (binding until this docs commit advances repository HEAD): `6ea48c1ce3792f91eaec7c44c4d025e004f63414` (`feat(pos): add platform port layer foundation`)
- TRUE-STANDALONE architecture docs ratification (historical): `765b54b3d61419593a59fe559f95402ca00e21d6` (`docs: ratify true standalone architecture`)
- SoftDelete follow-up landing/source commit (historical; do not overwrite with the later docs SHA): `4d9be50411d72dbcc2bc9c35aebcbfdfa0819d19` (`fix(auth): correct soft delete transaction ordering`)
- Final Model 2 runtime/source baseline (historical; not reopened; do not overwrite with the later docs SHA): `ffb8069690173c80455f355d432e141865c09a33` (`feat(auth): add delegated manager approval`)
- **Current phase:** TRUE-STANDALONE
- **Current gate:** `TRUE_STANDALONE_PHASE_A_DOCS_CLOSURE`
- **Architecture status:** `APPROVED_WITH_NOTES`
- **Architecture Planning Gate:** `CLOSED`
- **Gemini architecture authority:** `TWINPET-TRUE-STANDALONE-FINAL-ARCHITECTURE-ADJUDICATION-GEMINI-001` — `APPROVED_WITH_CONDITIONS`
- **Gemini Phase-A closure authority:** `TWINPET-TRUE-STANDALONE-PHASE-A-CLOSURE-NEXT-PHASE-GEMINI-001` — `APPROVED_WITH_CONDITIONS`
- **Codex final architecture review:** `PASS_WITH_NOTES`
- **Claude architecture planning:** COMPLETED (PLAN-004)
- **Phase A name:** `PLATFORM_PORT_LAYER_FOUNDATION`
- **Phase A status:** `CLOSED_WITH_NOTES`
- **Phase A landing:** `6ea48c1ce3792f91eaec7c44c4d025e004f63414`
- **Codex Phase-A final:** `PASS_WITH_NOTES` (blockers 0; request changes 0)
- **Phase A implementation active:** NO
- **D-1:** `TAURI_V2_CONDITIONAL` — desktop shell = Tauri v2; Phase C must still prove BrowserRouter History API, Firestore Web SDK persistence, Firebase Auth persistence, Web Locks, and WebView2 compatibility. Electron remains a documented fallback. Tauri runtime is **not** already validated.
- **D-2:** `CAPACITOR_ANDROID_FIRST` — mobile shell = Capacitor; Android first; existing `android/` scaffold is historical/package evidence only; iOS remains future/out of current scope; `allowBackup` / backup-data extraction must be reviewed before durable SQLite POS data is enabled.
- **D-3:** `SEPARATE_SHELLS_UNIFIED_APP_LAYER` — Desktop Tauri + Mobile Capacitor + shared React/Vite + shared domain/service + shared platform-port contracts; runtime DI selects adapters; separate platform packaging. Not one universal native shell.
- **D-4:** `ACCEPT_FINAL_PLAN_004` — SQLite behind Twinpet durable-store port; IndexedDB as browser adapter + first-migration source; no dual-write; monotonic committed epoch; fail-closed manifest; `COMMIT_IS_IRREVERSIBLE`; Windows MSI single-installed-product / Android `versionCode` supported production distribution. Archived old binaries are an unsupported bypass, not a supported rollback path.
- **D-5:** `PLATFORM_PORT_LAYER_FOUNDATION` — ConnectivityPort first; `src/components/AppShell.tsx` composition seam; behavior-preserving; no native/SQLite/shell. **CLOSED_WITH_NOTES** at `6ea48c1`. ConnectivityPort is the only production-wired Phase-A consumer. Six port contracts and six browser adapters landed. `syncOrchestrator.ts` unchanged. D-6 was not required.
- **D-6:** `PHASE_SPECIFIC_B_D_ONLY_IF_EXACTLY_REQUIRED` — Phase A no exception (none used). Phase C no exception under accepted non-bare `window.__TAURI__` bridge. Future Phase B/D exact plugin/config exceptions only by separate Gemini authority.
- **TRUE-STANDALONE implementation started:** YES (Phase A landed; later phases not started)
- **Next TRUE-STANDALONE phase:** `PHASE_C_DESKTOP_TAURI`
- **Next-phase selection reason:** Twinpet POS's primary physical POS operating environment remains desktop/Windows. Tauri/WebView2 compatibility must be exactified/proven before durable SQLite becomes authoritative.
- **Phase C implementation authorized now:** NO
- **Phase C started:** NO
- **Tauri implementation authorized now:** NO
- **Next eligible gate:** `PHASE_C_DESKTOP_TAURI_READONLY_EXACTIFICATION`
- **Conditional Phase-C read-only exactification:** AUTHORIZED after this docs closure (`GROK_CURSOR_AGENT`, reasoning HIGH)
- **Conditional Codex plan review:** AUTHORIZED after a successful Phase-C exactification report
- **Product delivery:** offline-capable Desktop/Mobile Native App. Browser/Web App is **not** the production delivery target. Browser runtime remains development/test compatibility only.
- **TRUE-STANDALONE / NO HOSTING:** BINDING
- **Stage 10 Hosting:** `SKIPPED_BY_TRUE_STANDALONE_USER_OVERRIDE`
- **Native/Tauri/Capacitor/SQLite/installer/Android:** NOT AUTHORIZED by this docs gate
- **Phase B SQLite:** NOT AUTHORIZED
- **Phase D Capacitor:** not selected as the immediate next phase
- **Phase E/F:** not authorized
- **PKT-2 implementation:** `NOT AUTHORIZED`
- **SoftDelete follow-up:** historical `CLOSED_WITH_NOTES` at landing `4d9be50`; docs `ec8c97c`
- **Model 2:** historical `CLOSED_WITH_NOTES` at `ffb8069` (not reopened)
- **Packet 2A:** historical `CLOSED_WITH_NOTES` at `88086f4`; docs `b0875d1`
- **PKT-1:** historical `CLOSED / DELIVERED / Runtime deployment complete` at `8abcd15`
- **PK-6** — historical `CLOSED / DELIVERED` at `e7ae008`; docs `acdae5f`
- **PK-5** — historical `CLOSED / DELIVERED` at `ef90d4e`; docs `cf9c6f3`
- **PK-4** — historical `CLOSED / DELIVERED` at `d27850a`; docs `6a82fef`
- **PK-3** — remains `CLOSED` at feature SHA `ec7cf8b`; docs commit `5e6675758`
- **Packet 5** — remains `CLOSED` (`PASS_WITH_NOTES`) at `292d51ff`
- **Binding sequence:** PK-1 → PK-2 → PK-3 → PK-4 → PK-5 → PK-6; PK-6 is the **final PK packet**
- **Next eligible PK packet:** `NONE`
- **PK-7:** `NOT DEFINED / DO NOT INVENT`
- **This pass** — authorized docs-only tracker reconciliation of Gemini Phase-A closure and Phase-C next-phase selection. Exact six frozen docs only. No source/test/config work. No Phase C implementation. Do not invent the next packet.
- For current working-tree/stage/stash state, use live Git. Stash remains `stash@{0}` = `7d03cfec7ba52ff7e25b7e175ca190efc258d874`.

### Claim boundaries (must not overclaim)

- Do not claim Phase A is still pending, in progress, or unauthorized
- Do not claim Phase C started or implemented
- Do not claim Tauri runtime is already validated
- Do not claim Capacitor/`android/` scaffold is runtime proof
- Do not describe one universal native shell
- Do not describe Browser/Web App as the production delivery target
- Do not describe an archived old binary as a supported rollback path
- Do not treat the browser DurableStorePort adapter as Phase-B storage readiness
- Do not invent the next packet
- Do not reopen Model 2
- Do not authorize PKT-2 / native/SQLite/installer work
- Do not claim Hosting deployed
- Do not overwrite semantic Phase A source `6ea48c1ce3792f91eaec7c44c4d025e004f63414` with the later docs SHA
- Do not overwrite semantic Model 2 source baseline `ffb8069690173c80455f355d432e141865c09a33` with the later docs SHA
- Do not overwrite softDelete landing SHA `4d9be50411d72dbcc2bc9c35aebcbfdfa0819d19` with the later docs SHA
- Do not reopen Packet 2A, PKT-1 runtime Stages 0–13, Packet 5, PK-3, PK-4, or PK-5

### Accepted residuals (nonblocking)

- **Phase A Note 1 — default-parallel unit timeout debt.** Default parallel test execution showed timing/load timeout debt in existing tests. Serialized full suite `2591/2591` was accepted by Codex. Non-blocking Phase-A test-infrastructure debt; not a Phase-A functional regression. Do not reopen Phase A.
- **Phase A Note 2 — browser DurableStorePort scope.** Current browser durable adapter delegates only to the existing reversal KV store and remains unwired. It is not a universal Twinpet durable-store mapping and is not evidence that Phase B / SQLite durable storage is ready. Future durable-store wiring requires separate authority and single-source-of-truth preservation. Do not reopen Phase A.
- Codex architecture Note 1 — Windows: validate real upgrade/downgrade/repair/uninstall/running-process replacement against production-equivalent/signed package behavior before Phase B completion
- Codex architecture Note 2 — Android: validate signing/`versionCode`/backup/data extraction/uninstall/reinstall against production-equivalent APK behavior before durable SQLite is enabled
- Codex architecture Note 3 — Unsupported stale binary: archived/unsupported binary execution is an intentionally unprotected operational/business risk and must never be documented as a supported/safe rollback path
- Temporary UAT credential docs retained with `disabled=false` matching current canonical `softDelete`; profiles tombstoned; login unusable; Gemini accepted (historical Model 2/softDelete)
- Expired U-7 approval retained (fail-closed after TTL; no canonical approval-delete)
- UAT requester attempt bucket retained (no canonical attempt-delete)
- Immutable consumed approvals / command ledgers / audit events / create intents retained
- Unit in-memory transaction mock lacks rollback/retry/snapshot-isolation emulation; Codex classified this as non-blocking for the ordering-only remediation; do not claim rollback behavior is fully emulated
- Historical Packet 2A extra login re-entry: accepted bounded execution deviation with note
- Historical Packet 2A UAT-5: live source invalidation unmounted the PIN modal; page-level offline copy accepted as `PASS_WITH_NOTE`
- Historical Packet 2A external driver false-stop: nonblocking evidence-tooling note
- Historical Stage 2 / Stage 7 / Stage 8 rollout stops remain historical events; PKT-1 current/final state remains CLOSED
- Stage 10 Hosting skip is accepted, not a failure
- PK-5 B16/B18 accepted harness limitations under Gemini Option A; not product defects; historical PK-5 note
- PK-4 onRetry unexpected local-store exception may `CAN_ESCAPE_AFTER_FINALLY` — Gemini `ACCEPT_NONBLOCKING_NOTE` (historical PK-4 note)
- `ENTRY_STORE_RELATION: PARALLEL_FOR_RECORD_FRESHNESS_ONLY`

## What Happens Next

**Immediate next action:** RETURN_TO_CHATGPT_FOR_TRUE_STANDALONE_PHASE_C_READONLY_EXACTIFICATION_ROUTING

Do **not** start Phase C implementation. Do **not** initialize Tauri/Capacitor/Electron. Do **not** install SQLite/native plugins. Do **not** implement PKT-2. Do **not** authorize native/Capacitor. Do **not** invent the next packet. Do **not** deploy Hosting. Do **not** reopen Model 2 runtime. Do **not** start the Phase-C read-only exactification inside this docs run.

**Next implementation action:** NONE — Phase A is CLOSED_WITH_NOTES. Phase C is the selected next phase and is NOT AUTHORIZED to implement. Native/SQLite/Tauri/Capacitor NOT AUTHORIZED. PKT-2 NOT AUTHORIZED. Phase-C read-only exactification routing pending at ChatGPT.

1. TRUE-STANDALONE architecture — **APPROVED_WITH_NOTES** / Planning Gate **CLOSED**
2. Phase A (`PLATFORM_PORT_LAYER_FOUNDATION`) — **CLOSED_WITH_NOTES** at `6ea48c1`
3. Selected next phase — **`PHASE_C_DESKTOP_TAURI`**; implementation **NOT AUTHORIZED**; not started
4. Next eligible gate — **`PHASE_C_DESKTOP_TAURI_READONLY_EXACTIFICATION`**
5. Post Model 2 softDelete transaction-order follow-up — historical **CLOSED_WITH_NOTES** at landing `4d9be50`; exact `setUserAccount` deployed
6. UI-11 Packet 2 / Model 2 — historical **CLOSED_WITH_NOTES** at runtime/source baseline `ffb8069` (not reopened)
7. UI-11 Packet 2 / Packet 2A — historical **CLOSED_WITH_NOTES** at `88086f4` / docs `b0875d1`
8. UI-11 Packet 2 / PKT-1 — historical **CLOSED / DELIVERED / Runtime deployment complete** at `8abcd15`
9. PK-6 — historical **CLOSED / DELIVERED** at `e7ae008` / docs `acdae5f`
10. PK-5 — **CLOSED / DELIVERED** at `ef90d4e` / docs `cf9c6f3`
11. PK-4 — **CLOSED / DELIVERED** at `d27850a` / docs `6a82fef`
12. PK-3 — **CLOSED** (`PASS`) at feature SHA `ec7cf8b`; docs commit `5e6675758`; U1–U7 `PASS`
13. Packet 5 — **CLOSED** (`PASS_WITH_NOTES`) at `292d51ff`; R4 `36 / 36 PASS`
14. **NOT authorized now:** Phase C implementation, Tauri, Capacitor, Electron, SQLite, Windows installer, Android build, PKT-2, Hosting, native, PK-2C, PK-2D, PK-7, next packet implementation, stash operations
15. Closed-gate reopen: Phase A = CLOSED_WITH_NOTES (do not reopen); Model 2 runtime = CLOSED_WITH_NOTES; Packet 2A = CLOSED_WITH_NOTES; PKT-1 = CLOSED / DELIVERED; Packet 5 = CLOSED; PK-3 = CLOSED; PK-4 = CLOSED / DELIVERED; PK-5 = CLOSED / DELIVERED; PK-6 = CLOSED / DELIVERED

**Not active:** Phase C implementation, Tauri, Capacitor, SQLite, PKT-2, Hosting, native, or any new feature packet. TRUE-STANDALONE architecture is approved with notes. Phase A is closed with notes. `NEXT_ELIGIBLE_PK_PACKET: NONE`. Phase-C read-only exactification routing pending.

## Reminders

- `stash@{0}` — do not touch (`7d03cfec7ba52ff7e25b7e175ca190efc258d874`)
- TRUE-STANDALONE architecture is APPROVED_WITH_NOTES; this docs pass is docs-only
- Semantic Phase A source remains `6ea48c1ce3792f91eaec7c44c4d025e004f63414` after the docs SHA advances
- Semantic Model 2 source baseline remains `ffb8069690173c80455f355d432e141865c09a33` after the docs SHA advances
- SoftDelete landing SHA remains `4d9be50411d72dbcc2bc9c35aebcbfdfa0819d19` after the docs SHA advances
- TRUE-STANDALONE / NO HOSTING guardrail remains binding
- Stage 10 Hosting remains `SKIPPED_BY_TRUE_STANDALONE_USER_OVERRIDE`
- Browser/Web App is not the production delivery target
- Phase A is CLOSED_WITH_NOTES; do not reopen
- Phase C implementation is not authorized by Phase-A closure or this docs gate
- Native/Tauri/Capacitor/SQLite implementation is not authorized
- PKT-2 remains NOT AUTHORIZED
- U-14 through U-19 remain `DEFERRED_TO_AUTOMATED_EVIDENCE`
- Do not claim the unit mock fully emulates Firestore rollback/retry/snapshot isolation
- Packet 5 remains CLOSED; do not reopen
- PK-3 remains CLOSED; do not reopen
- PK-4 remains CLOSED / DELIVERED; do not reopen
- PK-5 remains CLOSED / DELIVERED; do not reopen
- PK-6 remains CLOSED / DELIVERED; final packet of the binding PK sequence
- PK-7 is NOT DEFINED / DO NOT INVENT
- PK-2D remains record-only / not active / not authorized
- PaymentModal boundary remains CLOSED
- Checkout write path remains CLOSED
- `docs/skills/SKILL-GLOBAL-ARCHITECTURE.md` was not in this allowlist and still contains pre-Phase-A "NOT AUTHORIZED" wording; live workflow authority (`STATE.md` / this file / `CURRENT_PACKET.md`) wins on gate/status conflict
- **Billing (O-15) — Completed with notes, 2026-07-20:** Owner completed the paid-account upgrade, THB 25 Owner-accepted / Owner-managed budget; no engineering action currently pending
