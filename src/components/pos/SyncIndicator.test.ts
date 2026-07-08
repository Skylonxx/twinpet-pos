// @vitest-environment jsdom

// Packet 6 UX fix · SyncIndicator semantic-conflict coverage.
//
// SyncIndicator reflects the SERVER / Firestore sync channel. Its transient
// "✓ ซิงก์แล้ว" success note must be suppressed when the POS page signals that the
// device is offline OR its LOCAL journal still has pending bills — otherwise the
// header would show "synced" next to SaleIntentSyncPanel's "N บิลรอซิงก์". The
// honest "pending" chip is NEVER suppressed.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import { act, render, screen, cleanup } from '@testing-library/react';

// Capture the onSnapshot "next" callback so the test can drive pending → synced.
let snapshotNext: ((snap: { size: number }) => void) | null = null;

vi.mock('firebase/firestore', () => ({
  collection: () => ({}),
  query: () => ({}),
  where: () => ({}),
  onSnapshot: (_q: unknown, next: (snap: { size: number }) => void) => {
    snapshotNext = next;
    return () => {
      snapshotNext = null;
    };
  },
}));

vi.mock('../../lib/firebase', () => ({
  db: {},
  isFirebaseConfigured: true,
}));

vi.mock('../../lib/pos/deviceId', () => ({
  getDeviceId: () => 'dev-1',
}));

let SyncIndicator: typeof import('./SyncIndicator').default;

beforeEach(async () => {
  snapshotNext = null;
  SyncIndicator = (await import('./SyncIndicator')).default;
});

afterEach(() => cleanup());

function emit(size: number) {
  act(() => {
    snapshotNext?.({ size });
  });
}

describe('SyncIndicator · pending chip', () => {
  test('shows the pending chip while server-side bills are unsettled (never suppressed)', () => {
    render(createElement(SyncIndicator, { branchId: 'branch-1', suppressSyncedNotice: true }));
    emit(2);
    expect(screen.getByText(/บิลรอซิงก์/)).toBeTruthy();
  });
});

describe('SyncIndicator · "ซิงก์แล้ว" success note', () => {
  test('shows the synced note when the queue drains and nothing suppresses it', () => {
    render(createElement(SyncIndicator, { branchId: 'branch-1', suppressSyncedNotice: false }));
    emit(2); // pending
    emit(0); // drained → transient synced note
    expect(screen.getByText(/ซิงก์แล้ว/)).toBeTruthy();
  });

  test('suppresses the synced note when the POS page flags offline / local pending', () => {
    render(createElement(SyncIndicator, { branchId: 'branch-1', suppressSyncedNotice: true }));
    emit(2); // pending
    emit(0); // drained — but suppressed, so no misleading "synced"
    expect(screen.queryByText(/ซิงก์แล้ว/)).toBeNull();
  });
});
