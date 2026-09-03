import { describe, expect, test } from 'vitest';
import {
  PIN_APPLIES_TO_ALL_ROLES,
  PIN_FORMAT,
  PIN_LENGTH,
  PIN_MIGRATION_DERIVED_STATES,
  PIN_ROLES,
  canProvisionOac,
  classifyPresentedPin,
  convertLegacyPin4ToPin6,
  derivePinMigrationState,
  isLegacyPin4Shape,
  isLiveManagerApprovalPinCompareEligible,
  isTargetPinWellFormed,
  isTargetPolicyCompliant,
  isWellFormedPin,
  padLegacyPin4,
  prefixLegacyPin4,
  rehashLegacyPin4AsPin6,
  suffixLegacyPin4,
} from './pinPolicy';

describe('PIN target contract', () => {
  test('is six digits for all roles and not four', () => {
    expect(PIN_LENGTH).toBe(6);
    expect(PIN_LENGTH).not.toBe(4);
    expect(PIN_FORMAT.source).toBe('^\\d{6}$');
    expect(PIN_APPLIES_TO_ALL_ROLES).toBe(true);
    expect([...PIN_ROLES]).toEqual(['staff', 'manager', 'admin']);
    expect(isTargetPinWellFormed('123456')).toBe(true);
    expect(isWellFormedPin('123456')).toBe(true);
    expect(isTargetPinWellFormed('1234')).toBe(false);
    expect(isWellFormedPin('000000')).toBe(true);
    expect(isTargetPinWellFormed('12345')).toBe(false);
    expect(isTargetPinWellFormed('1234567')).toBe(false);
    expect(isTargetPinWellFormed('12345a')).toBe(false);
  });

  test('legacy PIN4 is a migration shape only', () => {
    expect(isLegacyPin4Shape('1234')).toBe(true);
    expect(isLegacyPin4Shape('123456')).toBe(false);
    expect(classifyPresentedPin('1234')).toBe('PIN4');
    expect(classifyPresentedPin('123456')).toBe('PIN6');
    expect(classifyPresentedPin('12')).toBe('INVALID');
    expect(isLiveManagerApprovalPinCompareEligible('1234')).toBe(true);
    expect(isLiveManagerApprovalPinCompareEligible('123456')).toBe(false);
    expect(isTargetPinWellFormed('1234')).toBe(false);
  });

  test('refuses every auto-conversion path', () => {
    const forbidden = { ok: false, code: 'LEGACY_PIN4_AUTO_CONVERSION_FORBIDDEN' };
    expect(convertLegacyPin4ToPin6('1234')).toEqual(forbidden);
    expect(padLegacyPin4('1234')).toEqual(forbidden);
    expect(prefixLegacyPin4('1234')).toEqual(forbidden);
    expect(suffixLegacyPin4('1234')).toEqual(forbidden);
    expect(rehashLegacyPin4AsPin6('1234')).toEqual(forbidden);
  });

  test('derived migration state does not mutate persisted credentialState', () => {
    expect(
      derivePinMigrationState({
        persistedCredentialState: 'rotated_authoritative',
        presentedPin: '123456',
      }),
    ).toBe(PIN_MIGRATION_DERIVED_STATES.ROTATED_AUTHORITATIVE_PIN6);
    expect(
      derivePinMigrationState({
        persistedCredentialState: 'rotated_authoritative',
        presentedPin: '1234',
      }),
    ).toBe(PIN_MIGRATION_DERIVED_STATES.LEGACY_PIN4_REQUIRES_ROTATION);
    expect(
      derivePinMigrationState({
        persistedCredentialState: 'rotated_authoritative',
      }),
    ).toBe('UNDETERMINED_PENDING_ROTATION_PACKET');
    expect(
      derivePinMigrationState({
        persistedCredentialState: 'readers_cut_over_rotation_required',
        presentedPin: '1234',
      }),
    ).toBe(PIN_MIGRATION_DERIVED_STATES.LEGACY_PIN4_REQUIRES_ROTATION);
    expect(
      derivePinMigrationState({
        persistedCredentialState: 'rotated_authoritative',
        disabled: true,
        presentedPin: '123456',
      }),
    ).toBe('INVALID_OR_DISABLED');
  });

  test('only rotated authoritative PIN6 may provision OAC', () => {
    expect(canProvisionOac(PIN_MIGRATION_DERIVED_STATES.ROTATED_AUTHORITATIVE_PIN6)).toBe(true);
    expect(canProvisionOac(PIN_MIGRATION_DERIVED_STATES.LEGACY_PIN4_REQUIRES_ROTATION)).toBe(false);
    expect(canProvisionOac('UNDETERMINED_PENDING_ROTATION_PACKET')).toBe(false);
    expect(isTargetPolicyCompliant(PIN_MIGRATION_DERIVED_STATES.LEGACY_PIN4_REQUIRES_ROTATION)).toBe(
      false,
    );
  });
});
