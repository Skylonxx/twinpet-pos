# SKILL: Global Architecture

Twinpet POS is a **TRUE-STANDALONE** product: an offline-capable Desktop/Mobile Native App with local durable storage and cloud sync. This skill records the Gemini-ratified architecture. It does **not** authorize implementation.

Binding architecture authority: `TWINPET-TRUE-STANDALONE-FINAL-ARCHITECTURE-ADJUDICATION-GEMINI-001`.

```text
TRUE_STANDALONE_ARCHITECTURE_STATUS: APPROVED_WITH_NOTES
ARCHITECTURE_PLANNING_GATE: CLOSED
CODEX_FINAL_ARCHITECTURE_REVIEW: PASS_WITH_NOTES
PHASE_A_IMPLEMENTATION_AUTHORIZED_NOW: NO
```

No TRUE-STANDALONE implementation has started. Phase A (`PLATFORM_PORT_LAYER_FOUNDATION`) is eligible for a **separate** Gemini implementation authorization after docs reconciliation closes. This skill grants none of that work.

## 1. Product Delivery Direction

- **Production target:** offline-capable Desktop/Mobile Native App with local storage sync.
- Twinpet POS is **explicitly not** a standard Web Application and is **not** a hosted web deployment.
- **Firebase Hosting is permanently out of scope.** Do not configure, suggest, or attempt to deploy Firebase Hosting.
- Cloud backend remains **Firestore + Firebase Cloud Functions only**.
- Browser/Web runtime remains useful for **development and test compatibility** only. It is **not** the production delivery target.
- Do not describe "Web mode" as production delivery.

## 2. D-1 Desktop Shell — `TAURI_V2_CONDITIONAL`

- Desktop shell target = **Tauri v2**.
- Conditional means native runtime compatibility must still be proven in Phase C. Do **not** claim Tauri runtime is already validated.
- Phase C acceptance must validate:
  - BrowserRouter History API behavior
  - Firestore Web SDK persistence
  - Firebase Auth persistence
  - Web Locks behavior
  - WebView2 runtime compatibility
- **Electron** remains a documented fallback if a materially different future hard requirement changes the tradeoff (for example mandatory silent/raw ESC/POS).
- No Tauri implementation is authorized by this docs skill alone.

## 3. D-2 Mobile Shell — `CAPACITOR_ANDROID_FIRST`

- Mobile shell = **Capacitor**.
- **Android first.**
- Existing `android/` scaffold is historical/package evidence only, **not** runtime proof.
- **iOS remains future / out of current scope.**
- `allowBackup` / applicable Android backup-data extraction rules must be reviewed **before** durable SQLite POS data is enabled.
- No Capacitor implementation, build, or sync is authorized by this docs skill alone.

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
- current accepted architecture recommendation = MSI family / canonical install identity
- no supported portable production mode
- no supported side-by-side production versions on the same data root
- supported downgrade must be blocked before launch
- exact WiX/MSI behavior must be validated later

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

Architecture boundary only. **Not implementation status.**

- First real day-one port consumer = ConnectivityPort.
- Existing composition seam = `src/components/AppShell.tsx`.
- Existing `useSyncOrchestrator()` composition accepts the dependency path.
- Phase A is intended to be behavior-preserving.
- No native dependency, shell, SQLite, or D-6 exception.
- No new production bare specifier.
- No new/changed IndexedDB open site.
- No Vite alias, TypeScript path alias, or new root tsconfig.
- No Row29 owner import/export amendment.

**Most important:** `PHASE_A_IMPLEMENTATION_AUTHORIZED_NOW: NO`. Do not imply otherwise.

## 7. D-6 Frozen-Contract Exception Model — `PHASE_SPECIFIC_B_D_ONLY_IF_EXACTLY_REQUIRED`

- Phase A: no exception.
- Phase C: no exception under the accepted non-bare `window.__TAURI__` bridge architecture.
- Phase B: exact native-storage plugin/config exception only if required, by separate Gemini authority.
- Phase D: exact Capacitor plugin/config exception only if required, by separate Gemini authority.
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

1. **Windows:** validate real upgrade, downgrade, repair, uninstall, and running-process replacement against production-equivalent/signed package behavior before Phase B completion.
2. **Android:** validate signing, `versionCode`, backup/data extraction, uninstall, and reinstall against production-equivalent APK behavior before durable SQLite is enabled.
3. **Unsupported stale binary:** archived/unsupported binary execution is an intentionally unprotected operational/business risk and must never be documented as a supported/safe rollback path.

## 10. Risks still deferred to later implementation gates

- Exact WiX/MSI authoring and signed-package proof
- Android backup/data-extraction finalization before SQLite production enablement
- Phase C WebView2 / Firebase / History API / Web Locks runtime proof
- Printer/scanner plugin selection
- App Store / Play Store timeline (iOS remains out of current scope)

Do not start Phase A, initialize Tauri/Capacitor/Electron, install SQLite/native plugins, or treat this skill as implementation authority.
