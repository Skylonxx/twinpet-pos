# SKILL: Offline-First POS

Twinpet is an offline-first POS environment. You must honor these constraints:

- POS must continue to function during an internet outage.
- Cart mutations and checkout steps are client-first; they rely on local IndexedDB persistence via Firebase JS SDK.
- Oversell is allowed and non-blocking (inventory reconciliation occurs server-side asynchronously).
- Async-safe wording is mandatory (e.g., "Received into device", "Pending sync").
- Do not block the checkout flow waiting for stock verification or server confirmation.
- No false completed/reconciled wording in the UI if the backend function has not definitively answered.
- Firestore offline persistence (`enableIndexedDbPersistence` or equivalent) and its caching assumptions must be respected in hook data loading.
