# Owner Recovery / Break-glass Console — architecture note (principles only)

**Status:** principles frozen by TPOS-USABLE-POS-ADMIN-SECURITY-CENTER-V1-IMPLEMENT-CLAUDE-001. **Nothing is implemented or deployed by this note.** A separate, explicitly authorized packet must design and build it.

## Why a separate surface

Admin & Security Center V1 (`Settings → Admin & ความปลอดภัย`) covers day-to-day credential and authority administration from inside the POS. It needs a working primary username+password admin session.

The Owner Recovery Console covers what that surface cannot: no admin can log in, every admin is locked or disabled, or the only admin's credentials are lost.

## Frozen principles

1. **Separate surface.** Owner recovery is a distinct console. It is not part of the normal POS, not a hidden route, not a magic username, not a hard-coded PIN or password, not a bypass token, and not an admin-claim override.
2. **Built on the existing trust model.** It extends the existing Issuer Console (`admin-issuance-console/`) and its enrolled-device / registered-issuer trust (per-install asymmetric issuer keypair, signed requests, server verification). It never relies on a shared secret embedded in a client.
3. **Time-limited authority.** Recovery authority is granted per episode, bound to the issuer and the target, and expires quickly. Nothing is standing or reusable.
4. **Explicit, durable audit.** Every recovery action writes a server-authored audit record. Clients cannot forge these records (the same convention as `securityAuditEvents`). Audit records never contain a PIN, hash, token or key.
5. **Scope: identity and security state only.** It may recover user identity, credentials (set a new PIN or password, never reveal an old one), device enrollment/trust state, and approval state (lockout, offline approval capability).
6. **Never business data.** It cannot silently create, edit or delete sales, stock, payments, receipts or audit history. It is not a transaction authority and never bypasses requester ≠ approver, same-day rules, OAC binding, SSA1, native lockout or server adjudication.
7. **No implementation or deploy in this packet.** This note only records the boundary. Admin & Security Center V1 contains no owner-recovery code path.
