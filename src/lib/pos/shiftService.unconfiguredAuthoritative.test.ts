// @vitest-environment jsdom
// Return/Refund V1 packet 016 — Codex-015: with the server-authoritative close
// ON, an unconfigured Firebase (or an absent `db`) must REFUSE the close. The
// unconfigured dev mock (`devCloseShift`) may never stand in for the server: it
// would return a `closed` shift and a "confirmed" promise (a Z) with no callable
// response, no independent server read and no 007-B finalization.
// With the gate OFF the unconfigured dev behaviour stays exactly as it was.
//
// Provenance: only symbols that exist at the parent commit (bd46a0a) are
// imported and the refusal copy is a literal fragment, so on the parent the ON
// cases fail on BEHAVIOUR (the dev mock closes the shift), never on an import.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Shift } from '../types';
import type { ShiftCloseIntentJournal } from './offline/shiftCloseIntentStore';

const h = vi.hoisted(() => ({
  firebase: { isFirebaseConfigured: false, db: undefined as unknown },
  fs: {
    doc: vi.fn(() => ({ id: 'shift-doc' })),
    getDocFromCache: vi.fn(),
    getDocFromServer: vi.fn(),
    updateDoc: vi.fn(),
    runTransaction: vi.fn(),
    setDoc: vi.fn(),
  },
}));

vi.mock('../firebase', () => ({
  get isFirebaseConfigured() {
    return h.firebase.isFirebaseConfigured;
  },
  get db() {
    return h.firebase.db;
  },
  collections: { shifts: 'shifts', cashTransactions: 'cashTransactions' },
}));

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return { ...actual, ...h.fs };
});

vi.mock('./shiftDevMock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./shiftDevMock')>();
  return { ...actual, devCloseShift: vi.fn(actual.devCloseShift) };
});

import * as devMock from './shiftDevMock';
import { closeShift, type CloseShiftDeps } from './shiftService';

/** The refusal (new in 016) — literal fragment. */
const UNCONFIGURED = 'ยังไม่ได้ตั้งค่าการเชื่อมต่อเซิร์ฟเวอร์ (Firebase)';
/** Wording of outcomes that would claim a send / commit happened (never for this refusal). */
const COMMIT_CLAIMS = ['ส่งการปิดกะถึงเซิร์ฟเวอร์แล้ว', 'ยังยืนยันผลการปิดกะกับเซิร์ฟเวอร์ไม่ได้'];

const devCloseShift = vi.mocked(devMock.devCloseShift);

let staffSeq = 0;
/** A fresh open dev-mock shift (its own staff, so earlier tests' shifts never interfere). */
function openDevShift(): Shift {
  const staffId = `staff-016-${(staffSeq += 1)}`;
  devMock.devOpenShift('LDP-001', staffId, 'ทดสอบ ระบบ', 500);
  const shift = devMock.devGetActiveShift('LDP-001', staffId);
  if (!shift) throw new Error('fixture: dev shift not opened');
  return shift;
}

/** Every other side-effect seam of `closeShift`, recorded. */
function sideEffects() {
  const journalCalls: string[] = [];
  const journal = new Proxy({} as ShiftCloseIntentJournal, {
    get: (_t, key) => () => {
      journalCalls.push(String(key));
      return Promise.reject(new Error('journal touched'));
    },
  });
  const spies = {
    callable: vi.fn(async () => ({ data: {} })),
    readServerShift: vi.fn(async () => ({ ok: false as const })),
    runCloseTransaction: vi.fn(),
    waitForQueuedWrites: vi.fn(async () => true),
    readConfirmation: vi.fn(async () => ({ ok: false as const })),
    normalizeSyncState: vi.fn(),
    has: vi.fn(() => false),
    clear: vi.fn(),
    isOnline: vi.fn(() => true),
  };
  const deps = (gate: boolean | undefined): CloseShiftDeps =>
    ({
      ...(gate === undefined ? {} : { authoritativeCloseGate: gate }),
      journal,
      readConfirmation: spies.readConfirmation,
      normalizeSyncState: spies.normalizeSyncState,
      isOnline: spies.isOnline,
      serverCashPending: { has: spies.has, clear: spies.clear },
      runCloseTransaction: spies.runCloseTransaction,
      waitForQueuedWrites: spies.waitForQueuedWrites,
      authoritativeClose: {
        sales: [],
        callable: spies.callable,
        readServerShift: spies.readServerShift,
        reviewedDrawer: undefined,
      },
    }) as unknown as CloseShiftDeps;
  const expectUntouched = () => {
    expect(journalCalls).toEqual([]);
    for (const spy of Object.values(spies)) {
      if (spy !== spies.isOnline) expect(spy).not.toHaveBeenCalled();
    }
    for (const fn of Object.values(h.fs)) expect(fn).not.toHaveBeenCalled();
  };
  return { deps, expectUntouched };
}

beforeEach(() => {
  h.firebase.isFirebaseConfigured = false;
  h.firebase.db = undefined;
  devCloseShift.mockClear();
  for (const fn of Object.values(h.fs)) fn.mockClear();
});

afterEach(() => {
  h.firebase.isFirebaseConfigured = false;
  h.firebase.db = undefined;
});

describe('016 — authoritative ON never closes through the unconfigured dev mock', () => {
  test.each([
    ['Firebase unconfigured, db absent', false, undefined],
    ['Firebase configured, db absent', true, undefined],
    ['Firebase unconfigured, db present', false, {}],
  ])('[RED-parent] %s ⇒ typed refusal; no dev close, no Z, nothing sent or written', async (_label, configured, db) => {
    h.firebase.isFirebaseConfigured = configured as boolean;
    h.firebase.db = db;
    const shift = openDevShift();
    const { deps, expectUntouched } = sideEffects();

    let result: unknown;
    let error: unknown;
    try {
      result = await closeShift(shift, 500, 'ทดสอบ', deps(true));
    } catch (err) {
      error = err;
    }

    // No closed snapshot and no "confirmed" promise ever reach the caller (the modal's Z source).
    expect(result).toBeUndefined();
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(UNCONFIGURED);
    for (const claim of COMMIT_CLAIMS) expect(message).not.toContain(claim);
    expect((error as Error & { cause?: unknown }).cause).toEqual({ reason: 'firebase_unconfigured' });

    expect(devCloseShift).not.toHaveBeenCalled();
    // Observable effect of the dev mock: the dev shift is still open.
    expect(devMock.devGetActiveShift(shift.branchId, shift.staffId)?.status).toBe('open');
    expectUntouched();
  });
});

describe('016 — gate OFF keeps the unconfigured dev behaviour exactly', () => {
  test.each([
    ['explicit OFF override', false],
    ['no override (hardcoded production gate)', undefined],
  ])('[GREEN-guard] %s, Firebase unconfigured ⇒ the legacy mock close and its confirmed promise', async (_label, gate) => {
    const shift = openDevShift();
    const { deps, expectUntouched } = sideEffects();

    const result = await closeShift(shift, 480, 'ขาด 20', deps(gate));

    expect(devCloseShift).toHaveBeenCalledTimes(1);
    expect(devCloseShift).toHaveBeenCalledWith(shift.id, 480, 'ขาด 20');
    const closed = devCloseShift.mock.results[0].value as Shift;
    expect(result).toEqual({ ...closed, whenServerConfirmed: expect.any(Promise) });
    expect(result).toMatchObject({ status: 'closed', actualCashCount: 480, variance: -20, note: 'ขาด 20' });
    const closedAt = (closed.closedAt as { toDate: () => Date }).toDate();
    await expect(result.whenServerConfirmed).resolves.toEqual({ outcome: 'confirmed', closedAt });
    expect(devMock.devGetActiveShift(shift.branchId, shift.staffId)).toBeNull();
    expectUntouched();
  });

  test('[GREEN-guard] gate OFF, Firebase configured but db absent ⇒ the same legacy mock close', async () => {
    h.firebase.isFirebaseConfigured = true;
    const shift = openDevShift();
    const { deps, expectUntouched } = sideEffects();

    const result = await closeShift(shift, 500, '', deps(false));

    expect(devCloseShift).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'closed', actualCashCount: 500, variance: 0 });
    await expect(result.whenServerConfirmed).resolves.toMatchObject({ outcome: 'confirmed' });
    expectUntouched();
  });
});

describe('016 — a configured Firebase is unaffected by the guard', () => {
  // Packet 023: offline no longer refuses (it records a deferred close), so the
  // authoritative path is observed by its own cache check (cache unreadable ⇒ its refusal, not 016).
  test('[GREEN-guard] gate ON, configured + db ⇒ the server-authoritative close runs (offline ⇒ its own cache check, not 016)', async () => {
    h.firebase.isFirebaseConfigured = true;
    h.firebase.db = {};
    const shift = openDevShift();
    const { deps } = sideEffects();
    const d = deps(true) as CloseShiftDeps & { isOnline: () => boolean };
    d.isOnline = () => false;
    h.fs.getDocFromCache.mockRejectedValueOnce(new Error('cache unavailable'));

    await expect(closeShift(shift, 500, '', d)).rejects.toThrow('ไม่สามารถยืนยันสถานะกะจากข้อมูลในเครื่องได้');
    expect(devCloseShift).not.toHaveBeenCalled();
    expect(devMock.devGetActiveShift(shift.branchId, shift.staffId)?.status).toBe('open');
  });
});
