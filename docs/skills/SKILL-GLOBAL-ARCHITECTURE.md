# SKILL: Global Architecture

Twinpet POS is a **TRUE-STANDALONE** product: an offline-capable Desktop/Mobile Native App with local durable storage and cloud sync. This skill records the Gemini-ratified architecture plus landed Phase A / Phase C / Phase B status. It does **not** authorize the next implementation phase, production activation, deployment, or public release.

Binding architecture authority: `TWINPET-TRUE-STANDALONE-FINAL-ARCHITECTURE-ADJUDICATION-GEMINI-001`.

```text
TRUE_STANDALONE_ARCHITECTURE_STATUS: APPROVED_WITH_NOTES
ARCHITECTURE_PLANNING_GATE: CLOSED
CODEX_FINAL_ARCHITECTURE_REVIEW: PASS_WITH_NOTES
PHASE_A_STATUS: CLOSED_WITH_NOTES
PHASE_C_STATUS: CLOSED_WITH_NOTES
PHASE_B_STATUS: CLOSED
B13_OVERALL_STATUS: CLOSED_WITH_NOTES
NEXT_TRUE_STANDALONE_PHASE: UNDECIDED
PRODUCTION_RUNTIME_ACTIVATION: NOT_AUTHORIZED
PUBLIC_RELEASE: NOT_AUTHORIZED
```

TRUE-STANDALONE implementation has started and the first three implementation phases are closed: Phase A (`PLATFORM_PORT_LAYER_FOUNDATION`) `CLOSED_WITH_NOTES` at `6ea48c1ce3792f91eaec7c44c4d025e004f63414`; Phase C (`DESKTOP_TAURI`) `CLOSED_WITH_NOTES` at `92351999bb897c326a7cbefa3c97311887b5c5a1`; Phase B (`SQLITE_DURABLE_STORE`) `CLOSED` at SQLite source `54bb622aa3aff5ed662bf287e00f8e70f3aac500` and B13 packaging `40a3e10ce9805e851081c7aa512115026754776e`. B13 is `CLOSED_WITH_NOTES`. W1–W22 runtime UAT is complete (W8 = `PASS_WITH_NOTE`; W1–W7 / W9–W22 = `PASS`). No implementation regression was established. This skill grants none of the next-phase, production, deployment, signing, or public-release work.

## 1. Product Delivery Direction

- **Production target:** offline-capable Desktop/Mobile Native App with local storage sync.
- Twinpet POS is **explicitly not** a standard Web Application and is **not** a hosted web deployment.
- **Firebase Hosting is permanently out of scope.** Do not configure, suggest, or attempt to deploy Firebase Hosting.
- Cloud backend remains **Firestore + Firebase Cloud Functions only**.
- Browser/Web runtime remains useful for **development and test compatibility** only. It is **not** the production delivery target.
- Do not describe "Web mode" as production delivery.

## 2. D-1 Desktop Shell — `TAURI_V2_CONDITIONAL`

- Desktop shell target = **Tauri v2**.
- Phase C (`DESKTOP_TAURI`) is **CLOSED_WITH_NOTES** at `92351999`. Windows native Tauri v2 / WebView2 compatibility is **validated**, including BrowserRouter, Firestore persistent IndexedDB cache, Firebase Auth persistence, Web Locks, offline full-process startup, reconnect, username/password login, PIN login / `verifyPinLogin`, and native privileged capability confinement.
- **Electron** remains a documented fallback if a materially different future hard requirement changes the tradeoff (for example mandatory silent/raw ESC/POS).
- Production runtime activation, installer signing, and public release remain **NOT AUTHORIZED**. This skill does not authorize a next desktop packaging phase.

## 3. D-2 Mobile Shell — `CAPACITOR_ANDROID_FIRST`

- Mobile shell = **Capacitor**.
- **Android first.**
- Existing `android/` scaffold is historical/package evidence only, **not** runtime proof.
- **iOS remains future / out of current scope.**
- `allowBackup` / applicable Android backup-data extraction rules must be reviewed **before** durable SQLite POS data is enabled on Android.
- Phase D / Capacitor / Android is **not selected**. No Capacitor implementation, build, or sync is authorized by this docs skill.

## 4. D-3 Shell Strategy — `SEPARATE_SHELLS_UNIFIED_APP_LAYER`

- Desktop = Tauri v2.
- Mobile = Capacitor.
- One shared React/Vite application.
- One shared domain/service layer.
- One shared platform-port contract layer.
- Runtime dependency injection selects adapters.
- Platform packaging and runtime shells remain **separate**.
- Do **not** describe one universal native shell.
- Do **not** rewrite UI/business logic into React Native.

## 5. D-4 Local Durable Store and Distribution — `ACCEPT_FINAL_PLAN_004`

### Storage

- SQLite behind one Twinpet durable-store port.
- Preserve KV semantics for the first migration. No relational redesign in the first migration.
- IndexedDB retained as the **browser adapter** and **first-migration source**.
- No dual-write.

### Epoch

- Active epoch = highest committed epoch (`ACTIVE_EPOCH = max(epoch) where status == COMMITTED`).
- An incomplete newer migration attempt never replaces an older committed epoch.
- Committed active epoch is monotonic.
- No IndexedDB fallback after SQLite commit.

### Manifest

After a committed epoch may exist:

- missing / corrupt / unreadable / unrecognized manifest = fail closed
- inconsistent committed domain state = fail closed
- missing manifest must **not** imply virgin reset

### Migration

- Candidate migration state is isolated until commit.
- Later N→N+1 copies from active N, **not** stale IndexedDB.
- An interrupted candidate leaves active N unchanged.
- One store bundle/epoch per process.
- No per-store fallback.
- R4/R6/evidence/cart/retry state cannot cross epochs.

### Irreversibility

- `COMMIT_IS_IRREVERSIBLE`
- After commit, active epoch never decreases.
- Recovery is forward-only.

### Supported production distribution

Windows:

- single installed product
- Tauri production distribution expected as a managed installed product
- Phase B B13 accepted and landed **NSIS** (not MSI/WiX) as the Windows packaging family: `mainBinaryName = TwinpetPOS`, `bundle.targets = nsis`, `allowDowngrades = false`, `nsis.installMode = currentUser` at `40a3e10ce9805e851081c7aa512115026754776e`
- no supported portable production mode
- no supported side-by-side production versions on the same data root
- supported downgrade is blocked before launch (`allowDowngrades = false`)
- unsigned NSIS W1–W22 runtime UAT is complete; Authenticode signing, production deployment, and public release remain **NOT AUTHORIZED**

Android:

- stable app identity/signing
- monotonic `versionCode`
- normal production downgrade blocked by OS package-manager semantics
- debug/ADB downgrade = unsupported production path
- backup/data-extraction rules finalized before SQLite production enablement

### Unsupported bypass boundary

Current architecture does **not** guarantee prevention of:

- manually launched archived old binaries
- portable copies outside the supported production path
- debug/ADB administrative bypass
- deliberate OS-level restore/tampering
- malware/admin filesystem access

Do **not** describe an archived old binary as a supported rollback path. No backend client-version fence is required by the accepted architecture.

## 6. D-5 First Implementation Phase — `PLATFORM_PORT_LAYER_FOUNDATION`

Historical architecture boundary. Phase A is **CLOSED_WITH_NOTES** at `6ea48c1`.

- First real day-one port consumer = ConnectivityPort.
- Existing composition seam = `src/components/AppShell.tsx`.
- Existing `useSyncOrchestrator()` composition accepts the dependency path.
- Phase A was behavior-preserving: six port contracts, six browser adapters, ConnectivityPort only production-wired consumer, no native/SQLite/shell in Phase A.
- Do not reopen Phase A.

## 7. D-6 Frozen-Contract Exception Model — `PHASE_SPECIFIC_B_D_ONLY_IF_EXACTLY_REQUIRED`

- Phase A: no exception.
- Phase C: no exception under the accepted non-bare `window.__TAURI__` bridge architecture.
- Phase B: exact native-storage plugin/config exception was authorized separately and is **closed** with B13 `CLOSED_WITH_NOTES`. Do not reopen Phase B to invent a broader native exception.
- Phase D: exact Capacitor plugin/config exception only if required, by separate Gemini authority. Phase D is **not selected**.
- Each future exception requires separate Gemini authority, a named frozen constant/item, and mandatory Codex line-by-line review.
- No broad native exception. No authority inheritance across phases.
- This skill grants none of those future exceptions.

## 8. Hardware SDK Readiness

Hardware integration remains future and isolated behind adapter interfaces. Do not hard-code web-only assumptions into the architecture.

Future integrations (not authorized now):

- Bluetooth barcode scanners
- USB serial barcode scanners (where the platform allows)
- Bluetooth / LAN / USB POS printers
- Cash drawer / receipt printer integration where supported

Current MVP keeps web-compatible behavior for development/test. No hardware plugins are implemented in this phase.

## 9. Accepted non-blocking Codex notes (future acceptance criteria)

These are **not** current blockers.

1. **Windows signed production package:** unsigned NSIS W1–W22 runtime UAT completed in B13 (`CLOSED_WITH_NOTES`). Authenticode signing, production-equivalent signed-package proof, production deployment, and public release remain **NOT AUTHORIZED** and are outside Phase B.
2. **Android:** validate signing, `versionCode`, backup/data extraction, uninstall, and reinstall against production-equivalent APK behavior before durable SQLite is enabled on Android. Phase D is **not selected**.
3. **Unsupported stale binary:** archived/unsupported binary execution is an intentionally unprotected operational/business risk and must never be documented as a supported/safe rollback path.
4. **W8 `PASS_WITH_NOTE`:** parked-bill UI was blocked by the upstream `ShiftBootBlockedModal` / missing `activeShift` environment limitation; backend durability of the W8 fixture survived N→N+1. Not a SQLite durable-store regression. Do not reopen W8 or Phase B.

## 10. Risks still deferred to later implementation gates

- Authenticode signing and production-equivalent signed-package proof
- Production runtime activation / deployment / public release
- Android backup/data-extraction finalization before SQLite production enablement on Android
- Printer/scanner plugin selection
- App Store / Play Store timeline (iOS remains out of current scope)
- Next TRUE-STANDALONE implementation phase (unselected)

Do not select or start a next implementation phase. Do not reopen Phase A, Phase C, or Phase B. Do not implement Capacitor/Android. Do not sign, deploy, or publicly release. Do not treat this skill as next-phase or production authority.
