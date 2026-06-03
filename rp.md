All 7 pass, temp files cleaned up. Let me confirm no stray permsClaimMissing references remain anywhere.

  Searched for 1 pattern (ctrl+o to expand)

● Clean — the only permsClaimMissing mentions left are in your own rp.md scratch notes (not code), and every other "legacy" hit is pre-existing, unrelated code. Nothing stray in
  firestore.rules, the spec, or the functions.

  ✅ Hard-cut complete — 7/7 pass, zero syntax errors

  Final cleaned-up firestore.rules blocks

  Helpers (transitional helper gone; only the two null-safe permission helpers remain):
  // Granular permission keys stamped into the token by verifyPinLogin (e.g.
  // ['pos_sale','pos_void',...]). `.get('permissions', [])` is null-safe.
  function tokenPerms() {
    return request.auth.token.get('permissions', []);
  }

  function hasPerm(p) {
    return isStaff() && (p in tokenPerms());
  }

  asyncOrders — checkout needs pos_sale, void-intent (create + update) needs pos_void:
  match /asyncOrders/{orderId} {
    allow read: if isAdmin() || (isStaff() && hasBranchAccess(resource.data.branchId));
    allow create: if hasBranchAccess(request.resource.data.branchId)
      && (
        (hasPerm('pos_sale') && stampedOwnStaffId(request.resource.data))
        || (hasPerm('pos_void')
          && request.resource.data.get('voidRequested', false) == true)
      );
    allow update: if hasPerm('pos_void')
      && hasBranchAccess(resource.data.branchId);
    allow delete: if isAdmin();
  }

  orders — create on pos_sale, update (void) on pos_void:
  allow create: if hasPerm('pos_sale')
    && hasBranchAccess(request.resource.data.branchId)
    && stampedOwnStaffId(request.resource.data);
  allow update: if hasPerm('pos_void')
    && hasBranchAccess(resource.data.branchId);
  allow delete: if isAdmin();

  (I also refreshed the stale asyncOrders header comment that still said "manager/admin only" → now describes the pos_sale/pos_void gates.)

  What changed in Phase 5

  ┌─────────────────────────────────────────────────────────────────────────┬────────────────────────────────────────────┐
  │                                  Item                                   │                   Status                   │
  ├─────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────┤
  │ permsClaimMissing() helper removed                                      │ ✅                                         │
  ├─────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────┤
  │ All 4 fallback clauses stripped (orders + asyncOrders, create + update) │ ✅                                         │
  ├─────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────┤
  │ Stale comment corrected                                                 │ ✅                                         │
  ├─────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────┤
  │ Legacy fallback tests + unused token shapes removed from spec           │ ✅ (10 → 7 tests)                          │
  ├─────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────┤
  │ Strict rules re-validated on emulator                                   │ ✅ 7/7 pass, rules compiled clean          │
  ├─────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────┤
  │ Temp emulator config + debug log                                        │ ✅ created & removed (nothing left behind) │
  └─────────────────────────────────────────────────────────────────────────┴────────────────────────────────────────────┘

  Heads-up for whenever you run npm run test:rules yourself: it targets port 8080 from firebase.json, which your dev emulator (PID 37628) currently occupies — stop that emulator first,  
  or it'll report "port taken." I validated on a temporary 8085 config to avoid disturbing your session.

  The follow-up item about "remove the transitional branch" is now done — the only remaining deploy note is the ordering one, which is moot since you're pre-production with no legacy    
  sessions. Ready for the frontend UI step whenever you are.

✻ Crunched for 2m 25s