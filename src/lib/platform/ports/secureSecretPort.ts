/**
 * Capability contract only. Does not define PIN, token, or authorization policy.
 * Persistence semantics are adapter-defined; the browser adapter must not
 * silently persist secrets.
 */

export interface SecureSecretPort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
