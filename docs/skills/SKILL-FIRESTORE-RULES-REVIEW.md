# SKILL: Firestore Rules Review

Security in Twinpet is heavily enforced at the Firestore rules layer.

- **Field Allowlists:** Client updates must restrict writes strictly to approved fields (`affectedKeys().hasOnly([...])`).
- **Value Constraints:** Do not blindly trust client values. Freeze server-owned audit fields. 
- **Actor Identity Validation:** Enforce custom claims (e.g. `request.auth.token.staffId`) instead of relying solely on `request.auth.uid`.
- **Same-day Rules:** Use `request.time` vs server timestamps to enforce temporal limits (e.g. cross-day void blocking).
- **Deny Tombstones:** Deny deletion and missing/null values unless the backend explicitly handles tombstone states.
- **Test Coverage:** Emulated rules tests must cover both safe paths and malicious payload injections.
- **Defense in Depth:** Rules must NOT rely on UI-only gates for security.
- **Legacy Docs:** Missing or null timestamp behavior must be explicit and covered by tests to avoid runtime evaluation errors.
