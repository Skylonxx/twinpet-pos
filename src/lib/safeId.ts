/**
 * Non-cryptographic ID generator safe on LAN HTTP (non-secure context).
 *
 * Prefer `crypto.randomUUID()` when available; otherwise fall back to a
 * time/counter/random suffix. Not for secrets, auth tokens, or passwords.
 */

let fallbackCounter = 0;

export function createSafeId(prefix = 'id'): string {
  try {
    const randomUUID = globalThis.crypto?.randomUUID;
    if (typeof randomUUID === 'function') {
      return randomUUID.call(globalThis.crypto);
    }
  } catch {
    // Fall through to non-secure-context fallback.
  }

  fallbackCounter += 1;
  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${time}-${fallbackCounter.toString(36)}-${random}`;
}
