/**
 * Twinpet PIN policy contract (pure).
 *
 * Matched contract: keep in lockstep with `src/lib/auth/pinPolicy.ts`.
 * No cross-tree import. No hashing, persistence, UI, or callable wiring.
 *
 * Target policy: six digits for every role. Legacy 4-digit is a migration
 * shape only — never target-valid and never auto-converted. It is never
 * OAC-capable under the TARGET predicate `canProvisionOac`; the usable-POS
 * release path uses `canProvisionOacForAuthoritativeCredential` instead
 * (Tech Lead decision D-V5, see that function).
 */

export const PIN_LENGTH = 6 as const;
export const PIN_FORMAT = /^\d{6}$/;
export const PIN_APPLIES_TO_ALL_ROLES = true as const;
export const PIN_ROLES = ['staff', 'manager', 'admin'] as const;
export type PinRole = (typeof PIN_ROLES)[number];

export const LEGACY_PIN4_AUTO_CONVERSION_FORBIDDEN =
  'LEGACY_PIN4_AUTO_CONVERSION_FORBIDDEN' as const;

export const PIN_MIGRATION_DERIVED_STATES = {
  LEGACY_PIN4_REQUIRES_ROTATION: 'LEGACY_PIN4_REQUIRES_ROTATION',
  ROTATED_AUTHORITATIVE_PIN6: 'ROTATED_AUTHORITATIVE_PIN6',
} as const;

export type PinMigrationDerivedState =
  (typeof PIN_MIGRATION_DERIVED_STATES)[keyof typeof PIN_MIGRATION_DERIVED_STATES];

export type PinPresentedShape = 'PIN6' | 'PIN4' | 'INVALID';

export type PersistedCredentialState =
  | 'backfilled_not_trusted'
  | 'readers_cut_over_rotation_required'
  | 'rotated_authoritative';

export type DerivedPinCredentialClassification =
  | PinMigrationDerivedState
  | 'INVALID_OR_DISABLED'
  | 'UNDETERMINED_PENDING_ROTATION_PACKET';

/** Isolated legacy-shape detector. Not a validity check. Not a keypad max-length. */
const LEGACY_PIN4_SHAPE = /^\d{4}$/;

export function isTargetPinWellFormed(pin: string): boolean {
  return typeof pin === 'string' && PIN_FORMAT.test(pin);
}

/** Alias used by manager-approval core. Target contract only. */
export function isWellFormedPin(pin: string): boolean {
  return isTargetPinWellFormed(pin);
}

/**
 * Recognizes a 4-digit presented PIN as a legacy migration shape.
 * Must never be treated as target-policy compliant.
 */
export function isLegacyPin4Shape(pin: string): boolean {
  return typeof pin === 'string' && LEGACY_PIN4_SHAPE.test(pin);
}

/**
 * TEMPORARY live manager-approval PIN compare eligibility.
 * Accepts the current authoritative 4-digit credential shape only.
 * This is NOT target-policy validity, NOT OAC eligibility, and NOT a
 * six-digit claim. No 4→6 conversion. Removed by the future PIN6
 * migration/cutover packet.
 */
export function isLiveManagerApprovalPinCompareEligible(pin: string): boolean {
  return isLegacyPin4Shape(pin);
}

export function classifyPresentedPin(pin: string): PinPresentedShape {
  if (isTargetPinWellFormed(pin)) return 'PIN6';
  if (isLegacyPin4Shape(pin)) return 'PIN4';
  return 'INVALID';
}

export type LegacyPin4ConversionRefusal = {
  ok: false;
  code: typeof LEGACY_PIN4_AUTO_CONVERSION_FORBIDDEN;
};

function refuseLegacyPin4Conversion(_pin: string): LegacyPin4ConversionRefusal {
  return { ok: false, code: LEGACY_PIN4_AUTO_CONVERSION_FORBIDDEN };
}

export function convertLegacyPin4ToPin6(pin: string): LegacyPin4ConversionRefusal {
  return refuseLegacyPin4Conversion(pin);
}

export function padLegacyPin4(pin: string): LegacyPin4ConversionRefusal {
  return refuseLegacyPin4Conversion(pin);
}

export function prefixLegacyPin4(pin: string): LegacyPin4ConversionRefusal {
  return refuseLegacyPin4Conversion(pin);
}

export function suffixLegacyPin4(pin: string): LegacyPin4ConversionRefusal {
  return refuseLegacyPin4Conversion(pin);
}

export function rehashLegacyPin4AsPin6(pin: string): LegacyPin4ConversionRefusal {
  return refuseLegacyPin4Conversion(pin);
}

/**
 * Adapter only. Does not mutate persisted `credentialState`.
 * Bcrypt hashes do not encode PIN length; presented PIN is required to
 * distinguish PIN4 vs PIN6. Actual rotation belongs to a later packet.
 */
export function derivePinMigrationState(input: {
  persistedCredentialState: string | null;
  disabled?: boolean;
  presentedPin?: string | null;
}): DerivedPinCredentialClassification {
  if (input.disabled === true) return 'INVALID_OR_DISABLED';

  const persisted = input.persistedCredentialState;
  if (
    persisted === 'backfilled_not_trusted' ||
    persisted === 'readers_cut_over_rotation_required'
  ) {
    return PIN_MIGRATION_DERIVED_STATES.LEGACY_PIN4_REQUIRES_ROTATION;
  }

  if (persisted !== 'rotated_authoritative') {
    return 'INVALID_OR_DISABLED';
  }

  if (input.presentedPin == null || input.presentedPin === '') {
    return 'UNDETERMINED_PENDING_ROTATION_PACKET';
  }

  const shape = classifyPresentedPin(input.presentedPin);
  if (shape === 'PIN6') return PIN_MIGRATION_DERIVED_STATES.ROTATED_AUTHORITATIVE_PIN6;
  if (shape === 'PIN4') return PIN_MIGRATION_DERIVED_STATES.LEGACY_PIN4_REQUIRES_ROTATION;
  return 'INVALID_OR_DISABLED';
}

export function canProvisionOac(classification: DerivedPinCredentialClassification): boolean {
  return classification === PIN_MIGRATION_DERIVED_STATES.ROTATED_AUTHORITATIVE_PIN6;
}

/**
 * D-V5 (TPOS-USABLE-POS-VOID-OAC-DECISION-IMPLEMENT-CLAUDE-002) — OAC
 * provisioning eligibility for the CURRENT usable-POS release path.
 *
 * Deliberate Tech Lead product/security decision, not an accidental
 * relaxation: the coordinated PIN6 migration/cutover is DEFERRED, and the
 * live authoritative credential (`setUserAccount` / `verifyPinLogin`) is
 * 4 digits. A credential that is already `rotated_authoritative` may
 * provision an OAC with its currently valid authoritative PIN, whether that
 * PIN is the live 4-digit shape or the target 6-digit shape.
 *
 * This predicate classifies only. The caller MUST already have verified the
 * presented PIN against the stored credential (bcrypt) before asking —
 * a wrong PIN never reaches it. It still refuses: disabled credentials,
 * every non-`rotated_authoritative` (legacy / backfilled / cut-over /
 * unknown) state, and any malformed (non-4, non-6 digit) PIN.
 *
 * `canProvisionOac` (target policy, PIN6-only) is unchanged and remains the
 * post-cutover rule; this function is removed by the PIN6 cutover packet.
 */
export function canProvisionOacForAuthoritativeCredential(input: {
  persistedCredentialState: string | null;
  disabled?: boolean;
  presentedPin?: string | null;
}): boolean {
  if (input.disabled === true) return false;
  if (input.persistedCredentialState !== 'rotated_authoritative') return false;
  if (typeof input.presentedPin !== 'string' || input.presentedPin === '') return false;
  const shape = classifyPresentedPin(input.presentedPin);
  return shape === 'PIN6' || shape === 'PIN4';
}

export function isTargetPolicyCompliant(classification: DerivedPinCredentialClassification): boolean {
  return classification === PIN_MIGRATION_DERIVED_STATES.ROTATED_AUTHORITATIVE_PIN6;
}
