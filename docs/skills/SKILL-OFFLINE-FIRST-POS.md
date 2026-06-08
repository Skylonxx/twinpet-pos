# SKILL: Offline-First POS

Twinpet is an offline-first POS environment. You must honor these constraints:

- POS must continue to function during an internet outage.
- Cart mutations and checkout steps are client-first; they rely on local IndexedDB persistence via Firebase JS SDK.
- Oversell is allowed and non-blocking (inventory reconciliation occurs server-side asynchronously).
- Async-safe wording is mandatory (e.g., "Received into device", "Pending sync").
- Do not block the checkout flow waiting for stock verification or server confirmation.
- No false completed/reconciled wording in the UI if the backend function has not definitively answered.
- Firestore offline persistence (`enableIndexedDbPersistence` or equivalent) and its caching assumptions must be respected in hook data loading.
- **Native App Durability Target**: For Capacitor Native App deployment, persistence upgrades from browser-only IndexedDB assumptions to a native durable storage plan (e.g., Capacitor SQLite). Firestore offline persistence may remain part of the sync model, but must not be the sole durability guarantee for Native POS due to iOS/Android webview cache eviction risks.
- Local queue state must explicitly distinguish:
  - locally accepted
  - pending sync
  - sync failed/rejected
  - reconciled/confirmed (only when backend proves it)
