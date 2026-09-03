import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  PIN_FORMAT,
  PIN_LENGTH,
  canProvisionOac,
  convertLegacyPin4ToPin6,
  isLiveManagerApprovalPinCompareEligible,
  isTargetPinWellFormed,
  isWellFormedPin,
} from '../pinPolicy';
import {
  ACTION_REQUIREMENTS,
  PRIVILEGED_ACTION_IDS,
  privilegedActionSecurityContractManifest,
} from '../privilegedActionRegistry';
import * as clientPinPolicy from '../../../src/lib/auth/pinPolicy';
import { privilegedActionSecurityContractManifest as clientManifest } from '../../../src/lib/auth/privilegedAction/privilegedActionTypes';

const repoRoot = resolve(__dirname, '../../..');

describe('Part A matched-contract parity', () => {
  test('PIN policy source stays lockstep with the client file', () => {
    const functionsSrc = readFileSync(resolve(repoRoot, 'functions/src/pinPolicy.ts'), 'utf8');
    const clientSrc = readFileSync(resolve(repoRoot, 'src/lib/auth/pinPolicy.ts'), 'utf8');
    const stripHeader = (src: string) => src.replace(/\/\*\*[\s\S]*?\*\//, '').trim();
    expect(stripHeader(functionsSrc)).toBe(stripHeader(clientSrc));
    expect(PIN_LENGTH).toBe(6);
    expect(PIN_FORMAT.source).toBe('^\\d{6}$');
    expect(functionsSrc).not.toMatch(/PIN_LENGTH = 4/);
    expect(clientSrc).not.toMatch(/PIN_LENGTH = 4/);
    expect(isTargetPinWellFormed('123456')).toBe(true);
    expect(isWellFormedPin('1234')).toBe(false);
    expect(isLiveManagerApprovalPinCompareEligible('1234')).toBe(true);
    expect(isLiveManagerApprovalPinCompareEligible('123456')).toBe(false);
    expect(canProvisionOac('LEGACY_PIN4_REQUIRES_ROTATION')).toBe(false);
    expect(convertLegacyPin4ToPin6('1234')).toEqual({
      ok: false,
      code: 'LEGACY_PIN4_AUTO_CONVERSION_FORBIDDEN',
    });
    expect(clientPinPolicy.PIN_LENGTH).toBe(PIN_LENGTH);
    expect(clientPinPolicy.PIN_FORMAT.source).toBe(PIN_FORMAT.source);
    expect(clientPinPolicy.isWellFormedPin('123456')).toBe(true);
    expect(clientPinPolicy.isLiveManagerApprovalPinCompareEligible('1234')).toBe(true);
  });

  test('privileged-action security contract manifests match across trees', () => {
    const functionsManifest = privilegedActionSecurityContractManifest();
    const client = clientManifest();
    expect(functionsManifest).toEqual(client);
    expect([...functionsManifest.actionIds]).toEqual(['VOID_PENDING_SALE', 'VOID_SETTLED_SALE']);
    expect([...PRIVILEGED_ACTION_IDS]).toEqual([...functionsManifest.actionIds]);
    expect(Object.keys(ACTION_REQUIREMENTS)).toEqual([...functionsManifest.actionIds]);
    for (const actionId of functionsManifest.actionIds) {
      const requirement = functionsManifest.requirements[actionId];
      expect(requirement.audience).toBe('privilegedVoid');
      expect(requirement.requesterPermission).toBe('pos_void');
      expect(requirement.approverPermission).toBe('pos_void');
      expect([...requirement.approverRoles]).toEqual(['manager', 'admin']);
      expect(requirement.exactBranchRequired).toBe(true);
    }
  });
});
