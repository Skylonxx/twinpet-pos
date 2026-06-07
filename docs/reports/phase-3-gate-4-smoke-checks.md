# Phase 3 Micro Gate 4 — Final Smoke Checks Report

**Role:** Environment Auditor / Production Smoke Tester  
**Date:** 2026-06-07  
**Scope:** Safely verify that the newly deployed Phase 3 backend functions are live, reachable, and active without polluting production data.

---

## 1. PIN Login Smoke Check (`verifyPinLogin`)

**Goal:** Verify the `verifyPinLogin` HTTPS callable is live and reachable without exposing real PINs or tokens.  
**Method:** Issue a non-mutating curl command with an empty payload to verify the function responds via the Firebase callable protocol.

**Command Executed:**
```bash
curl.exe -s -i -X POST https://asia-southeast1-twinpet-pos.cloudfunctions.net/verifyPinLogin -H "Content-Type: application/json" -d "{}"
```

**Captured Output Summary:**
```text
HTTP/1.1 400 Bad Request
content-type: application/json; charset=utf-8
{"error":{"message":"Bad Request","status":"INVALID_ARGUMENT"}}
```

**Result: PASS.** The endpoint is live, publicly reachable, and successfully parsing Firebase callable payloads (rejecting the empty payload safely via its validation layer).

---

## 2. Admin Retry Callable Smoke Check (`retryReconcile`)

**Goal:** Verify the `retryReconcile` HTTPS callable is live and reachable for administrative recovery.  
**Method:** Issue a non-mutating curl command with an empty payload.

**Command Executed:**
```bash
curl.exe -s -i -X POST https://asia-southeast1-twinpet-pos.cloudfunctions.net/retryReconcile -H "Content-Type: application/json" -d "{}"
```

**Captured Output Summary:**
```text
HTTP/1.1 400 Bad Request
content-type: application/json; charset=utf-8
{"error":{"message":"Bad Request","status":"INVALID_ARGUMENT"}}
```

**Result: PASS.** The endpoint is live and successfully returning a safe 400 protocol error indicating the function is active and enforcing its input requirements. No production exception data was mutated.

---

## 3. Sale Reconciliation Smoke Check (`reconcileOrder`)

**Goal:** Verify the `reconcileOrder` background trigger is live and correctly attached to Firestore.  
**Method:** Since a true end-to-end test would require mutating live customer data (creating a fake order), we fall back to a safe deployment-status verification via `firebase functions:list` as directed, avoiding production database pollution.

**Command Executed:**
```bash
npx firebase functions:list --project twinpet-pos
```

**Captured Output Summary:**
```text
┌────────────────┬─────────┬────────────────────────────────────────────┬─────────────────┬────────┬──────────┐
│ Function       │ Version │ Trigger                                    │ Location        │ Memory │ Runtime  │
├────────────────┼─────────┼────────────────────────────────────────────┼─────────────────┼────────┼──────────┤
│ reconcileOrder │ v2      │ google.cloud.firestore.document.v1.written │ asia-southeast1 │ 256    │ nodejs22 │
├────────────────┼─────────┼────────────────────────────────────────────┼─────────────────┼────────┼──────────┤
│ retryReconcile │ v2      │ callable                                   │ asia-southeast1 │ 256    │ nodejs22 │
├────────────────┼─────────┼────────────────────────────────────────────┼─────────────────┼────────┼──────────┤
│ verifyPinLogin │ v2      │ callable                                   │ asia-southeast1 │ 256    │ nodejs22 │
└────────────────┴─────────┴────────────────────────────────────────────┴─────────────────┴────────┴──────────┘
```

**Result: PASS.** The function is definitively deployed and correctly hooked to the `google.cloud.firestore.document.v1.written` event in `asia-southeast1`. `migrateDataToPosDb` remains completely absent.

---

## 4. Operation Confirmations

* **Production Data Mutation:** **None.** All smoke checks were strictly non-destructive. No dummy transactions or test users were created.
* **Deploy/Delete Executed:** **None.** No Firebase CLI deploy or delete commands were run.
* **`stash0` Untouched:** **Yes.** Git stash was not accessed.
* **App Behavior / Transfer Changes:** **None.** No frontend, rules, or logic files were modified.

---

## 5. Paranoid Checklist

* **Business Logic Integrity:** Confirmed. No POS checkout logic, stock decrement rules, or administrative paths were altered.
* **State Isolation:** Confirmed. `stash@{0}` remains perfectly isolated.
* **Cross-contamination:** Confirmed. No Flowbite layout changes, Firestore rules modifications, or frontend deployments occurred.
* **Devil's Advocate (Production Risk):** Given that we explicitly avoided creating a test order to prevent production data pollution, there is a minor residual risk that the `reconcileOrder` function could fail at runtime due to an unforeseen IAM, index, or downstream database configuration issue that is only triggered during an actual write event. Real-time monitoring of functions logs upon go-live is critical.

---

*(Note: GCS `gcf-sources` deployment artifact IAM and lifecycle cleanup audit remains deferred to post-MVP hardening.)*
