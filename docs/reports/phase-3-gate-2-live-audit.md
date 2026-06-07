# Phase 3 Gate 2 — Live Firebase Audit Report

**Role:** Environment Auditor  
**Date:** 2026-06-07  
**Scope:** Phase 3 Gate 2 Live Firebase Audit  

---

## 1. Commands Executed

The following audit commands were run in the local environment to query the live Firebase environment:
1. `npx firebase use` — To verify the currently active project target.
2. `npx firebase projects:list` — To list all accessible Firebase projects and confirm active targeting.
3. `npx firebase functions:list --project twinpet-pos` — To retrieve the full inventory of live deployed Cloud Functions.

---

## 2. Captured Firebase Command Outputs

### npx firebase use
```text
twinpet-pos
```

### npx firebase projects:list
```text
- Preparing the list of your Firebase projects
✔ Preparing the list of your Firebase projects
┌──────────────────────┬───────────────────────┬────────────────┬──────────────────────┐
│ Project Display Name │ Project ID            │ Project Number │ Resource Location ID │
├──────────────────────┼───────────────────────┼────────────────┼──────────────────────┤
│ FleetTracking        │ fleettracking-6dde3   │ 1048208060245  │ us-central           │
├──────────────────────┼───────────────────────┼────────────────┼──────────────────────┤
│ twinpet-pos          │ twinpet-pos (current) │ 909096976893   │ [Not specified]      │
└──────────────────────┴───────────────────────┴────────────────┴──────────────────────┘

2 project(s) total.
```

### npx firebase functions:list --project twinpet-pos
```text
┌────────────────────┬─────────┬────────────────────────────────────────────┬─────────────────┬────────┬──────────┐
│ Function           │ Version │ Trigger                                    │ Location        │ Memory │ Runtime  │
├────────────────────┼─────────┼────────────────────────────────────────────┼─────────────────┼────────┼──────────┤
│ migrateDataToPosDb │ v2      │ https                                      │ asia-southeast1 │ 256    │ nodejs22 │
├────────────────────┼─────────┼────────────────────────────────────────────┼─────────────────┼────────┼──────────┤
│ reconcileOrder     │ v2      │ google.cloud.firestore.document.v1.written │ asia-southeast1 │ 256    │ nodejs22 │
├────────────────────┼─────────┼────────────────────────────────────────────┼─────────────────┼────────┼──────────┤
│ verifyPinLogin     │ v2      │ callable                                   │ asia-southeast1 │ 256    │ nodejs22 │
└────────────────────┴─────────┴────────────────────────────────────────────┴─────────────────┴────────┴──────────┘
```

---

## 3. Active Firebase Project ID
* **Active Project ID:** `twinpet-pos`
* **Verification:** Confirmed by `firebase use` and matching the `.firebaserc` default project target.

---

## 4. Functions Region
* **Functions Region:** `asia-southeast1`
* **Verification:** Confirmed by the location field in the live functions list, the `firestore.location` field in `firebase.json`, and the `FUNCTIONS_REGION` declaration in `functions/src/deployConfig.ts`.

---

## 5. Firestore Database Target
* **Firestore Named Database Target:** `pos-db`
* **Verification:** Target verified in `firebase.json` under `firestore.database`, compiled in `functions/src/deployConfig.ts` (`FIRESTORE_DATABASE_ID = "pos-db"`), and initialized in `functions/src/db.ts` to instantiate the Firestore database handle.

---

## 6. Live Deployed Functions List
1. `migrateDataToPosDb` (v2, HTTPS trigger)
2. `reconcileOrder` (v2, Firestore `onDocumentWritten` trigger)
3. `verifyPinLogin` (v2, HTTPS Callable trigger)

---

## 7. `migrateDataToPosDb` Live Status
* **Status:** **LIVE / DEPLOYED**
* **Security Risk:** This function remains deployed on Firebase even though its source export was removed from the codebase in Phase 3 Gate 1. It remains a production deploy blocker because it exposes a public HTTPS database migration utility.

---

## 8. Other Suspicious dev/mock/test/temp Live Functions
* **Status:** **None**
* **Findings:** No other functions containing patterns like `mock`, `test`, `dev`, or `temp` were found in the live output list.
* *Note:* The codebase-defined admin retry callable `retryReconcile` is not currently deployed in the live project environment.

---

## 9. Prepared Delete Command (NOT Executed)
To safely delete the legacy public db-copier from the live environment:
```bash
firebase functions:delete migrateDataToPosDb --project twinpet-pos --region asia-southeast1
```

---

## 10. Prepared Allowlist Deploy Command (NOT Executed)
To deploy only the approved codebase production functions:
```bash
firebase deploy --only functions:verifyPinLogin,functions:reconcileOrder,functions:retryReconcile --project twinpet-pos
```
*(Or the codebase package command: `npm --prefix functions run deploy`)*.

---

## 11. Safety Confirmations
* **No deploy executed:** Confirmed.
* **No delete executed:** Confirmed.
* **No destructive command executed:** Confirmed.
* **No app/code behavior changed:** Confirmed.
* **stash0 untouched:** Confirmed. `stash@{0}` remains unaltered in git storage.

---

## 12. Paranoid Checklist

### Business Logic Integrity
Confirmed. This task is strictly audit-only; no code executed locally modifies any backend databases, schemas, or application pathways.

### State Isolation / stash0
Confirmed. No stashes were popped, modified, or dropped. The active UI/UOM stash remains isolated.

### Cross-contamination
Confirmed. No changes were made to client app files or functions source logic. The only write is this report and a pointer link inside the latest report.

### Devil's Advocate (Hidden Risk)
* **Missing retryReconcile deployment:** Because `retryReconcile` is defined in the source code but is currently missing from the live project functions, accessing the admin exception portal (`/admin/reconciliation-exceptions`) and clicking "Retry" will result in a `NOT_FOUND` HTTPS callable exception at runtime. The administrative recovery UI is blocked until the allowlist deploy is performed.
* **Staging Code Remnants:** Even after executing the `functions:delete` command, the historical deployments of `migrateDataToPosDb` are stored as code archives in Google Cloud Storage deployment buckets. If IAM permissions are overly permissive, an attacker with Read access to those buckets could extract the source zip containing the deprecated migration helper logic. A storage cleanup lifecycle policy should be audited.
