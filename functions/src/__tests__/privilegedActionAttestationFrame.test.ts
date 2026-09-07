import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  PAA1_ACTION_KIND_VOID_PENDING_SALE,
  PAA1_ACTION_KIND_VOID_SETTLED_SALE,
  PAA1_APPROVAL_RESULT_APPROVED_LOCAL,
  PAA1_CANONICAL_PARITY_HEX,
  PAA1_DOMAIN_SEPARATOR,
  PAA1_FIXED_HEAD_BYTES,
  PAA1_MAGIC,
  PAA1_MANAGER_ROLE_ADMIN,
  PAA1_MANAGER_ROLE_MANAGER,
  PAA1_MINIMUM_TOTAL_BYTES,
  PAA1_SIGNATURE_LEN,
  PAA1_VERSION,
  decodePaa1,
  encodePaa1,
  paa1ActionKindToActionId,
  paa1AdjudicationId,
  paa1AttestationDigest,
  paa1CanonicalParityFrame,
  paa1ManagerRoleKindToRole,
  paa1SecurityDeviceIdHex,
  paa1SignaturePreimage,
  paa1SignedPrefix,
  type PrivilegedActionAttestationFrameV1,
} from '../privilegedActionAttestationFrame';

const repoRoot = resolve(__dirname, '../../..');

function frame(over: Partial<PrivilegedActionAttestationFrameV1> = {}): PrivilegedActionAttestationFrameV1 {
  return { ...paa1CanonicalParityFrame(), ...over };
}

describe('PAA1 byte contract', () => {
  test('frozen constants match the ratified contract', () => {
    expect(PAA1_MAGIC).toBe('PAA1');
    expect(PAA1_VERSION).toBe(1);
    expect(PAA1_DOMAIN_SEPARATOR).toBe('TWINPET_PAA1_V1:');
    expect(Buffer.from(PAA1_DOMAIN_SEPARATOR, 'ascii')).toHaveLength(16);
    expect(PAA1_FIXED_HEAD_BYTES).toBe(228);
    expect(PAA1_MINIMUM_TOTAL_BYTES).toBe(308);
    expect(PAA1_FIXED_HEAD_BYTES + 8 * 2 + PAA1_SIGNATURE_LEN).toBe(PAA1_MINIMUM_TOTAL_BYTES);
  });

  test('fixed head is exactly 228 bytes and the tail begins immediately after it', () => {
    const bytes = encodePaa1(frame());
    expect(bytes.readUInt16LE(PAA1_FIXED_HEAD_BYTES)).toBe(Buffer.from('LDP-001', 'utf8').length);
    // Head field offsets, asserted positionally so a silent reorder fails.
    expect(bytes.toString('ascii', 0, 4)).toBe('PAA1');
    expect(bytes.readUInt8(4)).toBe(1);
    expect(bytes.subarray(5, 21).toString('hex')).toBe('000102030405060708090a0b0c0d0e0f');
    expect(bytes.readUInt8(21)).toBe(PAA1_ACTION_KIND_VOID_SETTLED_SALE);
    expect(bytes.readUInt8(22)).toBe(PAA1_APPROVAL_RESULT_APPROVED_LOCAL);
    expect(bytes.readUInt8(23)).toBe(PAA1_MANAGER_ROLE_MANAGER);
    expect(bytes.subarray(24, 40).toString('hex')).toBe('101112131415161718191a1b1c1d1e1f');
    expect(bytes.readUInt32LE(40)).toBe(3);
    expect(bytes.readUInt32LE(44)).toBe(1);
    expect(bytes.readUInt32LE(48)).toBe(7);
    expect(bytes.readUInt32LE(52)).toBe(11);
    expect(bytes.readUInt32LE(56)).toBe(13);
    expect(bytes.readUInt32LE(60)).toBe(17);
    expect(bytes.readUInt32LE(64)).toBe(0);
    expect(Number(bytes.readBigUInt64LE(68))).toBe(1_700_000_900_000);
    expect(Number(bytes.readBigUInt64LE(76))).toBe(1_700_000_000_000);
    expect(Number(bytes.readBigUInt64LE(84))).toBe(1_700_000_000_250);
    expect(Number(bytes.readBigUInt64LE(92))).toBe(1_700_060_400_000);
    expect(bytes.readUInt8(100)).toBe(0x21);
    expect(bytes.readUInt8(132)).toBe(0x22);
    expect(bytes.readUInt8(164)).toBe(0x23);
    expect(bytes.readUInt8(196)).toBe(0x24);
  });

  test('AC-11 — the canonical parity vector is byte-identical to the Rust vector', () => {
    const hex = encodePaa1(paa1CanonicalParityFrame()).toString('hex');
    expect(hex).toBe(PAA1_CANONICAL_PARITY_HEX);

    // The Rust side declares the same literal. Reading the source keeps the two
    // in lockstep without a build step, exactly as LCT1 parity already does.
    const rustSrc = readFileSync(resolve(repoRoot, 'src-tauri/src/privileged_auth/frames.rs'), 'utf8');
    expect(rustSrc).toContain(`pub const PAA1_CANONICAL_PARITY_HEX: &str = "${PAA1_CANONICAL_PARITY_HEX}"`);
    expect(rustSrc).toContain('pub const PAA1_FIXED_HEAD_BYTES: usize = 228;');
    expect(rustSrc).toContain('pub const PAA1_MINIMUM_TOTAL_BYTES: usize = 308;');
    expect(rustSrc).toContain('pub const PAA1_DOMAIN_SEPARATOR: &[u8] = b"TWINPET_PAA1_V1:";');
  });

  test('round-trips and preserves every field', () => {
    const original = frame();
    const decoded = decodePaa1(encodePaa1(original));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value).toEqual(original);
    expect(paa1AdjudicationId(decoded.value)).toBe('000102030405060708090a0b0c0d0e0f');
    expect(paa1SecurityDeviceIdHex(decoded.value)).toBe('101112131415161718191a1b1c1d1e1f');
    expect(paa1ActionKindToActionId(decoded.value.actionKind)).toBe('VOID_SETTLED_SALE');
    expect(paa1ManagerRoleKindToRole(decoded.value.managerRoleKind)).toBe('manager');
    expect(paa1ActionKindToActionId(PAA1_ACTION_KIND_VOID_PENDING_SALE)).toBe('VOID_PENDING_SALE');
    expect(paa1ManagerRoleKindToRole(PAA1_MANAGER_ROLE_ADMIN)).toBe('admin');
    expect(paa1ActionKindToActionId(0x03)).toBeNull();
    expect(paa1ManagerRoleKindToRole(0x03)).toBeNull();
  });

  test('signature preimage is the domain separator followed by every pre-signature byte', () => {
    const f = frame();
    const bytes = encodePaa1(f);
    const prefix = paa1SignedPrefix(f);
    expect(prefix).toEqual(bytes.subarray(0, bytes.length - PAA1_SIGNATURE_LEN));
    expect(paa1SignaturePreimage(f)).toEqual(
      Buffer.concat([Buffer.from(PAA1_DOMAIN_SEPARATOR, 'ascii'), prefix]),
    );
  });

  test('attestationDigest is sha256 over the exact submitted bytes', () => {
    const bytes = encodePaa1(frame());
    const flipped = Buffer.from(bytes);
    flipped[300] ^= 0xff;
    expect(paa1AttestationDigest(bytes)).toHaveLength(64);
    expect(paa1AttestationDigest(bytes)).not.toBe(paa1AttestationDigest(flipped));
  });

  test('rejects a trailing byte', () => {
    const bytes = Buffer.concat([encodePaa1(frame()), Buffer.from([0x00])]);
    expect(decodePaa1(bytes)).toEqual({ ok: false, code: 'wrong_total_length' });
  });

  test('rejects a truncated frame', () => {
    const bytes = encodePaa1(frame()).subarray(0, PAA1_MINIMUM_TOTAL_BYTES - 1);
    expect(decodePaa1(Buffer.from(bytes))).toEqual({ ok: false, code: 'wrong_total_length' });
  });

  test('rejects a bad magic and a bad version', () => {
    const bad = Buffer.from(encodePaa1(frame()));
    bad.write('PAA2', 0, 4, 'ascii');
    expect(decodePaa1(bad)).toEqual({ ok: false, code: 'bad_magic' });

    const badVersion = Buffer.from(encodePaa1(frame()));
    badVersion.writeUInt8(2, 4);
    expect(decodePaa1(badVersion)).toEqual({ ok: false, code: 'bad_version' });
  });

  test.each<[string, (b: Buffer) => void]>([
    ['zero attestationId', (b) => b.fill(0, 5, 21)],
    ['unknown actionKind', (b) => b.writeUInt8(0x03, 21)],
    ['non-APPROVED_LOCAL approvalResultKind', (b) => b.writeUInt8(0x02, 22)],
    ['unknown managerRoleKind', (b) => b.writeUInt8(0x09, 23)],
    ['zero deviceKeyVersion', (b) => b.writeUInt32LE(0, 40)],
    ['wrong oacSchemaVersion', (b) => b.writeUInt32LE(2, 44)],
    ['zero trustedApprovalLowerMs', (b) => b.writeBigUInt64LE(0n, 76)],
    ['upper below lower', (b) => b.writeBigUInt64LE(1_699_999_999_999n, 84)],
    ['pendingExpiry at or below lower', (b) => b.writeBigUInt64LE(1_700_000_000_000n, 92)],
    ['ssa1 expiry at or below upper', (b) => b.writeBigUInt64LE(1_700_000_000_250n, 68)],
  ])('strict decode rejects %s', (_label, mutate) => {
    const bytes = Buffer.from(encodePaa1(frame()));
    mutate(bytes);
    expect(decodePaa1(bytes)).toEqual({ ok: false, code: 'bad_field_format' });
  });

  test('encode refuses a self-approved frame (D1 bound into the bytes)', () => {
    expect(() => encodePaa1(frame({ approvingManagerStaffId: 'staff-1' }))).toThrow(/bad_field_format/);
  });

  test('encode refuses branchId ALL and a malformed UTC+7 date', () => {
    expect(() => encodePaa1(frame({ branchId: 'ALL' }))).toThrow(/bad_field_format/);
    expect(() => encodePaa1(frame({ targetOrderUtc7Date: '2025-11-4' }))).toThrow(/bad_field_format/);
  });

  test('decode rejects a non-canonical identifier in the tail', () => {
    const f = frame();
    const good = encodePaa1(f);
    // Rewrite `branchId` in place with the same length but an illegal character.
    const bad = Buffer.from(good);
    bad.write('LDP.001', PAA1_FIXED_HEAD_BYTES + 2, 7, 'utf8');
    expect(decodePaa1(bad)).toEqual({ ok: false, code: 'bad_field_format' });
  });

  test('decode rejects a length prefix that overruns the buffer', () => {
    const bad = Buffer.from(encodePaa1(frame()));
    bad.writeUInt16LE(0xffff, PAA1_FIXED_HEAD_BYTES);
    expect(decodePaa1(bad)).toEqual({ ok: false, code: 'bad_field_length' });
  });

  test('strict decode is a pure function of the bytes (PERM-1 support)', () => {
    const bytes = encodePaa1(frame());
    const a = decodePaa1(bytes);
    const b = decodePaa1(Buffer.from(bytes));
    expect(a).toEqual(b);
  });
});
