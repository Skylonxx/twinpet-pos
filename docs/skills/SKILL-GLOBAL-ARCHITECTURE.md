# SKILL: Global Architecture

Twinpet POS is designed as a multi-platform retail solution. This document describes the foundational architecture mandates for web and native deployments.

## 1. Capacitor Native Shell Mandate
Twinpet POS targets both Web and Native App deployment (Apple App Store / Google Play Store).
- **Single Codebase Rule**: The existing React codebase remains the single source of truth for all UI and business logic.
- **No React Native**: We do not rewrite UI/business logic into React Native. We deploy using Capacitor.
- **Native Shell**: Capacitor provides the native shell, bridging the web layer to native storage and hardware plugins.
- **Framework Agnostic**: UI and business logic must remain framework-agnostic React where possible. Platform-specific behavior must be strictly isolated behind adapter/service interfaces.

## 2. Native Storage Persistence Mandate
- **Browser Constraints**: Browser IndexedDB / Firestore web persistence remains highly useful for the Web mode. However, Native deployment must not rely solely on browser cache durability (e.g., Safari/Chrome cache eviction risks).
- **Native Target**: The Capacitor native storage path must be planned for critical offline POS data.
  - *Candidate layers*: Capacitor SQLite for structured durable offline operational data; Native Preferences only for small key/value settings (not large transactional queues).
- **Critical Offline Data Examples**:
  - Queued sales / async order intents.
  - Cart recovery / session state if required.
  - Device/branch settings.
  - Pending void/retry/local operational state where applicable.
- **Migration Plan**: Native storage must have a migration/versioning plan before production use.

## 3. Hardware SDK Readiness
Capacitor allows future native SDK plugin integrations without breaking the single codebase rule.
- **Future Integrations**: 
  - Bluetooth barcode scanners.
  - USB serial barcode scanners (where platform allows).
  - Bluetooth / LAN / USB POS printers.
  - Cash drawer / receipt printer integration where supported.
- **Interface Isolation**: Hardware integration must be isolated behind adapter interfaces later. Do not hard-code web-only assumptions into the future architecture.
- **Current MVP**: Keep current web-compatible behavior for the MVP. No hardware plugins are implemented at this phase.

## 4. App Store / Play Store Readiness Implications
Future phases for Native App deployment require:
- Capacitor project setup.
- iOS bundle identifier / Android applicationId configuration.
- App icons and splash screens.
- Native permissions review.
- Offline storage plugin selection.
- Native build pipeline integration.
- App Store / Play Store compliance checklist.
- Device testing plan.
- Firebase config handling per platform.
- Printer/scanner plugin feasibility review.

## 5. Risks & Open Decisions
- **Storage Plugin Selection**: Capacitor SQLite vs other storage plugins.
- **Data Mirroring Rules**: What exact data must be mirrored to native storage vs relying on Firestore offline persistence.
- **Conflict Strategy**: Sync conflict strategy for offline transactions.
- **Durability Rules**: Transaction queue durability rules.
- **Plugin Selection**: Printer/scanner plugin selection.
- **Validation**: iOS and Android offline storage behavior validation.
- **Deployment Timeline**: App Store / Play Store deployment timeline impact.
