/**
 * TPOS-R7 0.1.6 — confirm-time ENR1 expiry gate.
 *
 * The native importer checks expiry only when the file is picked. A file
 * picked while valid but confirmed later used to run the whole ceremony
 * (staff-session clear, admin sign-out, server begin, native staging) and be
 * rejected only at completion. This gate runs at confirm, BEFORE
 * `prepareEnrollmentIdentity()`, so an expired or nearly expired file never
 * touches sessions, Firebase identity, the server or native authority.
 *
 * Best effort on the local clock (the server stays authoritative); it never
 * extends a TTL or alters any server timestamp.
 */

/**
 * Minimum remaining validity required to START the ceremony. The ceremony
 * itself takes seconds (≈7 s observed, more on a cold Functions start); the
 * rest of the margin absorbs local clock skew against server time, so a file
 * the server would reject by completion is refused up front. Authorizations
 * live 30 minutes from issuance begin, so a promptly used file always clears it.
 */
export const ENR1_CONFIRM_SAFETY_MARGIN_MS = 5 * 60 * 1000;

export type Enr1ConfirmWindow = 'ok' | 'expired' | 'too_close_to_expiry';

/**
 * `expired` at or after `expiresAtServerMs` (or for a non-finite input);
 * `too_close_to_expiry` while less than the safety margin remains; `ok` when
 * at least the full margin remains.
 */
export function classifyEnr1ConfirmWindow(expiresAtServerMs: number, nowMs: number): Enr1ConfirmWindow {
  if (!Number.isFinite(expiresAtServerMs) || !Number.isFinite(nowMs)) return 'expired';
  const remainingMs = expiresAtServerMs - nowMs;
  if (remainingMs <= 0) return 'expired';
  if (remainingMs < ENR1_CONFIRM_SAFETY_MARGIN_MS) return 'too_close_to_expiry';
  return 'ok';
}
