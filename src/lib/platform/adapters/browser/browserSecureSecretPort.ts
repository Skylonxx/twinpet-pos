import type { SecureSecretPort } from '../../ports/secureSecretPort';

export const BROWSER_SECURE_SECRET_UNSUPPORTED = 'BROWSER_SECURE_SECRET_UNSUPPORTED';

/** Explicit fail-closed error: the browser adapter never persists secrets. */
export class BrowserSecureSecretUnsupportedError extends Error {
  readonly code = BROWSER_SECURE_SECRET_UNSUPPORTED;

  constructor(operation: string) {
    super(
      `Browser SecureSecretPort does not persist secrets (${operation}). ` +
        'PIN, tokens, credential hashes, and authority state must not be stored in ' +
        'localStorage or IndexedDB.',
    );
    this.name = 'BrowserSecureSecretUnsupportedError';
  }
}

function reject(operation: string): never {
  throw new BrowserSecureSecretUnsupportedError(operation);
}

/**
 * Unsupported / no-persistent-secret browser capability.
 * Fails explicitly rather than silently persisting secrets.
 */
export function createBrowserSecureSecretPort(): SecureSecretPort {
  return {
    async get(key: string): Promise<string | null> {
      void key;
      reject('get');
    },
    async set(key: string, value: string): Promise<void> {
      void key;
      void value;
      reject('set');
    },
    async delete(key: string): Promise<void> {
      void key;
      reject('delete');
    },
  };
}
