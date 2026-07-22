// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ShiftCloseAlertDetailState } from '../lib/pos/shiftClose/useShiftCloseAlertDetail';
import { mapShiftCloseReviewRow } from '../lib/pos/shiftClose/shiftCloseReviewRows';
import { mapShiftCloseCaseProjection } from '../lib/pos/shiftClose/shiftCloseDetailProjection';

let mockUser: { role: string } | null = { role: 'manager' };
vi.mock('../lib/hooks/useAuth', () => ({
  useAuth: () => ({ user: mockUser }),
}));

let mockBranchId: string | null = 'BR-001';
vi.mock('../lib/hooks/useBranch', () => ({
  useBranch: () => ({ branchId: mockBranchId, branch: { name: 'สาขาทดสอบ' } }),
}));

let mockFirebaseConfigured = true;
vi.mock('../lib/firebase', () => ({
  get isFirebaseConfigured() {
    return mockFirebaseConfigured;
  },
}));

let detailState: ShiftCloseAlertDetailState;
// RC-2/§9.5 remediation: recorded so the "full-chain percent-ID" integration
// test can assert exactly what raw value React Router's useParams() decode
// hands to the hook — without this, the hook mock only proves the return
// value renders, not that the route-decode step preserved the ID.
let capturedHookArgs: unknown[] | null = null;
vi.mock('../lib/pos/shiftClose/useShiftCloseAlertDetail', async () => {
  const actual = await vi.importActual<typeof import('../lib/pos/shiftClose/useShiftCloseAlertDetail')>(
    '../lib/pos/shiftClose/useShiftCloseAlertDetail',
  );
  return {
    ...actual,
    useShiftCloseAlertDetail: (...args: unknown[]) => {
      capturedHookArgs = args;
      return detailState;
    },
  };
});

let ShiftCloseAlertDetailPage: typeof import('./ShiftCloseAlertDetailPage').default;

beforeAll(async () => {
  ShiftCloseAlertDetailPage = (await import('./ShiftCloseAlertDetailPage')).default;
});

afterEach(() => {
  cleanup();
  mockUser = { role: 'manager' };
  mockBranchId = 'BR-001';
  mockFirebaseConfigured = true;
  capturedHookArgs = null;
});

function baseState(overrides: Partial<ShiftCloseAlertDetailState> = {}): ShiftCloseAlertDetailState {
  return {
    routeValid: true,
    alert: { status: 'pending', fromCache: false, empty: false, errorType: null, row: null },
    case: { status: 'pending', fromCache: false, empty: false, errorType: null, projection: null },
    integrityCautions: [],
    ...overrides,
  };
}

function renderAtRoute(shiftId: string) {
  return render(
    createElement(
      MemoryRouter,
      { initialEntries: [`/shift-close-review/${encodeURIComponent(shiftId)}`] },
      createElement(
        Routes,
        null,
        createElement(Route, { path: '/shift-close-review/:shiftId', element: createElement(ShiftCloseAlertDetailPage) }),
      ),
    ),
  );
}

const alertRow = mapShiftCloseReviewRow('SHIFT-001', {
  shiftId: 'SHIFT-001',
  branchId: 'BR-001',
  alertState: 'open',
  reasonCode: 'drawer_discrepancy',
  caseVersion: 2,
});
const caseProjection = mapShiftCloseCaseProjection('SHIFT-001', {
  shiftId: 'SHIFT-001',
  branchId: 'BR-001',
  processingState: 'validated',
  settlementState: 'manual_review_required',
  caseVersion: 2,
  selectedRunId: 'run-1',
});

describe('ShiftCloseAlertDetailPage — gate states', () => {
  test('Firebase not configured renders the not-ready message', () => {
    mockFirebaseConfigured = false;
    detailState = baseState();
    renderAtRoute('SHIFT-001');
    expect(screen.getByText('ระบบยังไม่พร้อมใช้งาน')).toBeTruthy();
  });

  test('non-manager/admin role renders the not-authorized message', () => {
    mockUser = { role: 'cashier' };
    detailState = baseState();
    renderAtRoute('SHIFT-001');
    expect(screen.getByText(/เฉพาะผู้จัดการ/)).toBeTruthy();
  });

  test('no branch / ALL branch renders the select-branch message', () => {
    mockBranchId = 'ALL';
    detailState = baseState();
    renderAtRoute('SHIFT-001');
    expect(screen.getByText('โปรดเลือกสาขาเพื่อดูข้อมูล')).toBeTruthy();
  });

  test('invalid route segment ("..") renders the invalid-link message', () => {
    detailState = baseState({ routeValid: false });
    renderAtRoute('..');
    expect(screen.getByText(/ลิงก์ไม่ถูกต้อง/)).toBeTruthy();
  });
});

describe('ShiftCloseAlertDetailPage — direct URL hydration', () => {
  test('hydrates the shiftId from the direct URL into the page header', () => {
    detailState = baseState({
      alert: { status: 'ready', fromCache: false, empty: false, errorType: null, row: alertRow },
      case: { status: 'ready', fromCache: false, empty: false, errorType: null, projection: caseProjection },
    });
    renderAtRoute('SHIFT-001');
    expect(screen.getByText(/SHIFT-001/)).toBeTruthy();
  });
});

describe('ShiftCloseAlertDetailPage — loading / error / offline / not-found', () => {
  test('loading state shows a spinner when either source is pending', () => {
    detailState = baseState();
    renderAtRoute('SHIFT-001');
    expect(screen.getByLabelText('Loading shift close alert detail')).toBeTruthy();
  });

  // Fallback A (frozen plan §8): missing-vs-denied is intentionally
  // ambiguous at the rules layer for a direct-by-ID read (see
  // useShiftCloseAlertDetail's module doc + rules-tests evidence) — the copy
  // is neutral and does not claim a specific cause.
  test('permission-denied on either source renders the neutral not-found-or-denied message', () => {
    detailState = baseState({
      alert: { status: 'error', fromCache: false, empty: false, errorType: 'permission-denied', row: null },
      case: { status: 'ready', fromCache: false, empty: false, errorType: null, projection: null },
    });
    renderAtRoute('SHIFT-001');
    expect(screen.getByText(/ไม่พบข้อมูลนี้ในสาขาที่เลือก หรือไม่มีสิทธิ์เข้าถึง/)).toBeTruthy();
  });

  test('generic error renders the generic error message', () => {
    detailState = baseState({
      alert: { status: 'error', fromCache: false, empty: false, errorType: 'generic', row: null },
      case: { status: 'ready', fromCache: false, empty: false, errorType: null, projection: null },
    });
    renderAtRoute('SHIFT-001');
    expect(screen.getByText('ไม่สามารถโหลดข้อมูลได้ โปรดลองอีกครั้ง')).toBeTruthy();
  });

  test('offline/cache-unconfirmed banner renders when either source is fromCache, and no not-found conclusion (overall or per-source) appears', () => {
    detailState = baseState({
      alert: { status: 'ready', fromCache: true, empty: true, errorType: null, row: null },
      case: { status: 'ready', fromCache: true, empty: true, errorType: null, projection: null },
    });
    renderAtRoute('SHIFT-001');
    expect(screen.getByText(/ข้อมูลออฟไลน์/)).toBeTruthy();
    expect(screen.queryByText(/ไม่พบรายการแจ้งเตือนกะการขายนี้ในสาขาที่เลือก/)).toBeNull();
    expect(screen.queryByText(/ไม่พบข้อมูลการแจ้งเตือนของรายการนี้ในสาขานี้/)).toBeNull();
    expect(screen.queryByText(/ไม่พบข้อมูลกรณีการตรวจสอบของรายการนี้ในสาขานี้/)).toBeNull();
  });

  test('server-confirmed empty on BOTH sources renders the truthful not-found message', () => {
    detailState = baseState({
      alert: { status: 'ready', fromCache: false, empty: true, errorType: null, row: null },
      case: { status: 'ready', fromCache: false, empty: true, errorType: null, projection: null },
    });
    renderAtRoute('SHIFT-001');
    expect(screen.getByText('ไม่พบรายการแจ้งเตือนกะการขายนี้ในสาขาที่เลือก')).toBeTruthy();
  });
});

// RC-1 remediation: a per-source `fromCache && empty` read must never render
// that source's confirmed-absence copy — only a server-confirmed
// (`!fromCache`) empty read may claim "not found". Prior behavior rendered
// the offline banner AND a source-level "not found" statement at once for a
// ready-but-cache-derived source, which contradicts SKILL-OFFLINE-FIRST-POS's
// "no false confirmed conclusion" rule. These cases keep the overall page out
// of the `notFound` branch (one source has real data) so `DetailBody` is what
// renders, and its per-source branches are what's under test here.
describe('ShiftCloseAlertDetailPage — RC-1 per-source cache-derived absence', () => {
  test('alert source fromCache && empty shows neutral unconfirmed wording, not confirmed absence', () => {
    detailState = baseState({
      alert: { status: 'ready', fromCache: true, empty: true, errorType: null, row: null },
      case: { status: 'ready', fromCache: false, empty: false, errorType: null, projection: caseProjection },
    });
    renderAtRoute('SHIFT-001');
    expect(screen.getByText(/ข้อมูลการแจ้งเตือนยังไม่ยืนยันกับเซิร์ฟเวอร์/)).toBeTruthy();
    expect(screen.queryByText(/ไม่พบข้อมูลการแจ้งเตือนของรายการนี้ในสาขานี้/)).toBeNull();
  });

  test('case source fromCache && empty shows neutral unconfirmed wording, not confirmed absence', () => {
    detailState = baseState({
      alert: { status: 'ready', fromCache: false, empty: false, errorType: null, row: alertRow },
      case: { status: 'ready', fromCache: true, empty: true, errorType: null, projection: null },
    });
    renderAtRoute('SHIFT-001');
    expect(screen.getByText(/ข้อมูลกรณีตรวจสอบยังไม่ยืนยันกับเซิร์ฟเวอร์/)).toBeTruthy();
    expect(screen.queryByText(/ไม่พบข้อมูลกรณีการตรวจสอบของรายการนี้ในสาขานี้/)).toBeNull();
  });

  test('both sources fromCache && empty show neutral unconfirmed wording for both, never confirmed absence', () => {
    detailState = baseState({
      alert: { status: 'ready', fromCache: true, empty: true, errorType: null, row: null },
      case: { status: 'ready', fromCache: true, empty: true, errorType: null, projection: null },
    });
    renderAtRoute('SHIFT-001');
    expect(screen.getByText(/ข้อมูลการแจ้งเตือนยังไม่ยืนยันกับเซิร์ฟเวอร์/)).toBeTruthy();
    expect(screen.getByText(/ข้อมูลกรณีตรวจสอบยังไม่ยืนยันกับเซิร์ฟเวอร์/)).toBeTruthy();
    expect(screen.queryByText(/ไม่พบข้อมูลการแจ้งเตือนของรายการนี้ในสาขานี้/)).toBeNull();
    expect(screen.queryByText(/ไม่พบข้อมูลกรณีการตรวจสอบของรายการนี้ในสาขานี้/)).toBeNull();
  });

  test('server-confirmed empty source (not fromCache) still renders the truthful per-source absence copy', () => {
    detailState = baseState({
      alert: { status: 'ready', fromCache: false, empty: false, errorType: null, row: alertRow },
      case: { status: 'ready', fromCache: false, empty: true, errorType: null, projection: null },
      integrityCautions: ['case_missing_for_alert'],
    });
    renderAtRoute('SHIFT-001');
    expect(screen.getByText(/ไม่พบข้อมูลกรณีการตรวจสอบของรายการนี้ในสาขานี้/)).toBeTruthy();
    expect(screen.queryByText(/ข้อมูลกรณีตรวจสอบยังไม่ยืนยันกับเซิร์ฟเวอร์/)).toBeNull();
  });
});

describe('ShiftCloseAlertDetailPage — integrity cautions / pairing gap', () => {
  test('a pairing gap (alert present, case confirmed-empty) shows the integrity caution, not a clean state', () => {
    detailState = baseState({
      alert: { status: 'ready', fromCache: false, empty: false, errorType: null, row: alertRow },
      case: { status: 'ready', fromCache: false, empty: true, errorType: null, projection: null },
      integrityCautions: ['case_missing_for_alert'],
    });
    renderAtRoute('SHIFT-001');
    expect(screen.getByText(/พบข้อมูลที่ต้องตรวจสอบเพิ่มเติม/)).toBeTruthy();
    expect(screen.getByText(/ไม่พบข้อมูลกรณีการตรวจสอบ/)).toBeTruthy();
  });

  test('caseVersion drift caution renders without a false clean conclusion', () => {
    detailState = baseState({
      alert: { status: 'ready', fromCache: false, empty: false, errorType: null, row: alertRow },
      case: { status: 'ready', fromCache: false, empty: false, errorType: null, projection: caseProjection },
      integrityCautions: ['case_version_drift'],
    });
    renderAtRoute('SHIFT-001');
    expect(screen.getByText(/เวอร์ชันข้อมูลระหว่างการแจ้งเตือนกับกรณีตรวจสอบไม่ตรงกัน/)).toBeTruthy();
  });
});

describe('ShiftCloseAlertDetailPage — ready detail rendering', () => {
  test('sensitive placeholder is present and neutral (UI-B2 deferral copy)', () => {
    detailState = baseState({
      alert: { status: 'ready', fromCache: false, empty: false, errorType: null, row: alertRow },
      case: { status: 'ready', fromCache: false, empty: false, errorType: null, projection: caseProjection },
    });
    renderAtRoute('SHIFT-001');
    expect(screen.getByText(/ต้องเปิดสิทธิ์เพิ่มเติม \(UI-B2\)/)).toBeTruthy();
  });

  test('caseVersion renders as muted diagnostic text', () => {
    detailState = baseState({
      alert: { status: 'ready', fromCache: false, empty: false, errorType: null, row: alertRow },
      case: { status: 'ready', fromCache: false, empty: false, errorType: null, projection: caseProjection },
    });
    renderAtRoute('SHIFT-001');
    expect(screen.getByText('v2')).toBeTruthy();
  });

  test('shiftId header uses truncate class and renders a copy affordance', () => {
    detailState = baseState({
      alert: { status: 'ready', fromCache: false, empty: false, errorType: null, row: alertRow },
      case: { status: 'ready', fromCache: false, empty: false, errorType: null, projection: caseProjection },
    });
    renderAtRoute('SHIFT-001');
    const shiftIdEl = screen.getByText(/กะ: SHIFT-001/);
    expect(shiftIdEl.className).toContain('truncate');
    expect(screen.getByLabelText('คัดลอกรหัสกะ')).toBeTruthy();
  });

  // RC-2.4 remediation: the truncate utility only bounds width inside a flex
  // row when the truncated element also has `min-w-0` (flex items default to
  // `min-width: auto`, which lets content overflow the row instead of
  // ellipsizing) — this proves the actual fix, not just the presence of
  // `truncate` alone. A long ID is used so the assertion is meaningful.
  test('long shiftId container is a min-w-0 flex row so the ID cannot force horizontal overflow', () => {
    const longId = `SHIFT-${'A'.repeat(200)}`;
    detailState = baseState({
      alert: { status: 'ready', fromCache: false, empty: false, errorType: null, row: alertRow },
      case: { status: 'ready', fromCache: false, empty: false, errorType: null, projection: caseProjection },
    });
    renderAtRoute(longId);
    const shiftIdEl = screen.getByText(new RegExp(`กะ: ${longId}`));
    expect(shiftIdEl.className).toContain('min-w-0');
    expect(shiftIdEl.className).toContain('truncate');
    const row = shiftIdEl.parentElement;
    expect(row?.className).toContain('min-w-0');
    expect(row?.className).not.toContain('flex-wrap');
  });

  // RC-2.1 remediation: the copy affordance must be the project-standard
  // Flowbite `Button`, not a hand-rolled `<button>` (SKILL-UI-IMPECCABLE §1).
  test('copy affordance renders as a real <button> element with the ≥44px touch target classes', () => {
    detailState = baseState({
      alert: { status: 'ready', fromCache: false, empty: false, errorType: null, row: alertRow },
      case: { status: 'ready', fromCache: false, empty: false, errorType: null, projection: caseProjection },
    });
    renderAtRoute('SHIFT-001');
    const copyButton = screen.getByLabelText('คัดลอกรหัสกะ');
    expect(copyButton.tagName).toBe('BUTTON');
    expect(copyButton.getAttribute('type')).toBe('button');
    expect(copyButton.className).toContain('min-h-11');
    expect(copyButton.className).toContain('min-w-11');
  });

  // RC-2.2 remediation: `writeText` returns a Promise; a rejected clipboard
  // write (e.g. insecure context, denied permission) must not surface as an
  // unhandled promise rejection or a thrown error inside the click handler.
  test('clicking copy when the clipboard write rejects does not throw or leave an unhandled rejection', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('clipboard denied'));
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    detailState = baseState({
      alert: { status: 'ready', fromCache: false, empty: false, errorType: null, row: alertRow },
      case: { status: 'ready', fromCache: false, empty: false, errorType: null, projection: caseProjection },
    });
    renderAtRoute('SHIFT-001');
    const copyButton = screen.getByLabelText('คัดลอกรหัสกะ');
    expect(() => copyButton.click()).not.toThrow();
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('SHIFT-001'));
    // Flush the rejected promise's microtask/.catch() chain before the test ends.
    await Promise.resolve();
    await Promise.resolve();
  });

  test('status badge container uses flex-wrap for small-viewport safety', () => {
    detailState = baseState({
      alert: { status: 'ready', fromCache: false, empty: false, errorType: null, row: alertRow },
      case: { status: 'ready', fromCache: false, empty: false, errorType: null, projection: caseProjection },
    });
    renderAtRoute('SHIFT-001');
    const badgeText = screen.getByText(alertRow.alertStateLabel);
    const container = badgeText.closest('div.flex-wrap');
    expect(container).toBeTruthy();
  });

  test('back-to-queue link points to /shift-close-review', () => {
    detailState = baseState({
      alert: { status: 'ready', fromCache: false, empty: false, errorType: null, row: alertRow },
      case: { status: 'ready', fromCache: false, empty: false, errorType: null, projection: caseProjection },
    });
    renderAtRoute('SHIFT-001');
    const link = screen.getByText('กลับไปหน้ารายการแจ้งเตือน').closest('a');
    expect(link?.getAttribute('href')).toBe('/shift-close-review');
  });

  test('no action buttons or acknowledge/resolve affordance are rendered (read-only)', () => {
    detailState = baseState({
      alert: { status: 'ready', fromCache: false, empty: false, errorType: null, row: alertRow },
      case: { status: 'ready', fromCache: false, empty: false, errorType: null, projection: caseProjection },
    });
    renderAtRoute('SHIFT-001');
    expect(screen.queryByText(/รับทราบ/)).toBeNull();
    expect(screen.queryByText(/^แก้ไข$/)).toBeNull();
  });
});

// RC-2 / Codex §9.5 note: `shiftCloseDetailGate.test.ts` proves
// `validateRouteShiftId` never re-decodes a legal percent-containing ID at
// the pure-validator boundary, but that alone doesn't prove the full chain —
// ShiftCloseReviewPage's `encodeURIComponent(row.id)` link, through
// MemoryRouter/`useParams()`'s single decode, into what this page actually
// hands the detail hook. `useShiftCloseAlertDetail` is mocked here (real
// Firestore is out of scope for this page-level test), but the mock now
// records its call arguments, so this closes the gap by asserting the exact
// raw string the hook receives as its shiftId input, plus the independently
// (non-mocked) `validateRouteShiftId`-derived header text — both must match
// the original ID byte-for-byte.
describe('ShiftCloseAlertDetailPage — full-chain percent-ID integration', () => {
  test('an encoded link containing a legal percent-sequence reaches the hook and the header byte-for-byte', () => {
    const legalId = 'SHIFT-2026%2520weird';
    detailState = baseState();
    renderAtRoute(legalId);

    expect(capturedHookArgs?.[2]).toBe(legalId);
    expect(screen.getByText(`กะ: ${legalId}`)).toBeTruthy();
  });
});
