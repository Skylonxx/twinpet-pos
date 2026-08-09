import type { User, UserRole } from '../types';

const SESSION_KEY = 'twinpet_session';

export const SESSION_SCHEMA_VERSION = 1;

export type AuthSession = {
  schemaVersion: number;
  /** Epoch ms from device clock — observability metadata only. */
  issuedAt: number | null;
  user: User;
  branchId: string;
};

const VALID_ROLES: ReadonlySet<UserRole> = new Set(['admin', 'manager', 'staff']);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isStructurallyValidSession(value: unknown): value is {
  schemaVersion?: unknown;
  issuedAt?: unknown;
  user: User;
  branchId: string;
} {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (!isNonEmptyString(obj.branchId)) return false;
  if (obj.user == null || typeof obj.user !== 'object' || Array.isArray(obj.user)) return false;
  const user = obj.user as Record<string, unknown>;
  if (!isNonEmptyString(user.id)) return false;
  if (!isStringArray(user.branchIds)) return false;
  if (typeof user.role !== 'string' || !VALID_ROLES.has(user.role as UserRole)) return false;
  if (typeof user.firstName !== 'string') return false;
  if (typeof user.lastName !== 'string') return false;
  return true;
}

export function loadSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!isStructurallyValidSession(parsed)) return null;

    const { user, branchId } = parsed;
    const schemaVersion = (parsed as { schemaVersion?: unknown }).schemaVersion;
    const issuedAtRaw = (parsed as { issuedAt?: unknown }).issuedAt;

    // Legacy: absent/undefined schemaVersion → in-memory upgrade only (do not rewrite storage).
    if (schemaVersion === undefined) {
      return {
        schemaVersion: SESSION_SCHEMA_VERSION,
        issuedAt: null,
        user,
        branchId,
      };
    }

    if (typeof schemaVersion !== 'number') return null;
    if (schemaVersion !== SESSION_SCHEMA_VERSION) return null;

    const issuedAt =
      typeof issuedAtRaw === 'number' && Number.isFinite(issuedAtRaw) ? issuedAtRaw : null;

    return {
      schemaVersion: SESSION_SCHEMA_VERSION,
      issuedAt,
      user,
      branchId,
    };
  } catch {
    return null;
  }
}

export function saveSession(session: AuthSession): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}
