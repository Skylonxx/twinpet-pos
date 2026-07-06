// @vitest-environment jsdom
//
// UI-11 · Contract + behavior tests for the presentational Manager Approval
// Modal Primitive (ManagerPinModal).
//
// NOTE: this spec is a `.ts` file (per the packet allowlist), so it uses
// `createElement` rather than JSX. Assertions cover runtime behavior (touch
// keypad entry, submit/cancel gating, masked buffer) AND a source-level
// contract proving the shell stays presentational: no verifier, no client PIN
// source, no backend/storage, no editable input, no forbidden imports, and a
// self-contained `mpin-*` CSS namespace.

import { describe, test, expect, beforeAll, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ManagerPinModal from './ManagerPinModal';
import type { ManagerPinModalProps } from './ManagerPinModal';

// Only the component `?raw` source is loaded (build-safe: the repo already
// declares `*?raw` modules for tsc). Vitest maps `.css` imports to an empty
// stub, and Node built-ins (`node:fs`/`node:path`) are not available to the
// repo `tsc -b` build — so the CSS-namespace contract is asserted from the
// component's own class usage instead of by reading the .css file.
let componentSource: string;

beforeAll(async () => {
  componentSource = (await import('./ManagerPinModal.tsx?raw')).default;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const makeProps = (over: Partial<ManagerPinModalProps> = {}): ManagerPinModalProps => ({
  open: true,
  onSubmitPin: vi.fn(),
  onCancel: vi.fn(),
  ...over,
});

const filledDots = () =>
  screen.getByTestId('mpin-display').querySelectorAll('.mpin-dot--filled').length;

const clickKey = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

// ─── Render / open-close ─────────────────────────────────────────────────────
describe('ManagerPinModal · render', () => {
  test('renders a dialog when open', () => {
    render(createElement(ManagerPinModal, makeProps()));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  test('renders nothing when closed', () => {
    render(createElement(ManagerPinModal, makeProps({ open: false })));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

// ─── Cancel ──────────────────────────────────────────────────────────────────
describe('ManagerPinModal · cancel', () => {
  test('the cancel button fires onCancel', () => {
    const onCancel = vi.fn();
    render(createElement(ManagerPinModal, makeProps({ onCancel })));
    clickKey('ยกเลิก');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('a backdrop pointerdown fires onCancel', () => {
    const onCancel = vi.fn();
    render(createElement(ManagerPinModal, makeProps({ onCancel, 'data-testid': 'mpin-root' })));
    const overlay = screen.getByTestId('mpin-root');
    fireEvent.pointerDown(overlay);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('a backdrop pointerdown does NOT cancel while submitting', () => {
    const onCancel = vi.fn();
    render(
      createElement(
        ManagerPinModal,
        makeProps({ onCancel, isSubmitting: true, 'data-testid': 'mpin-root' }),
      ),
    );
    fireEvent.pointerDown(screen.getByTestId('mpin-root'));
    expect(onCancel).not.toHaveBeenCalled();
  });
});

// ─── Keypad entry / masked buffer ────────────────────────────────────────────
describe('ManagerPinModal · touch keypad', () => {
  test('digit button clicks build the masked buffer (dot count grows)', () => {
    render(createElement(ManagerPinModal, makeProps()));
    expect(filledDots()).toBe(0);
    clickKey('1');
    clickKey('2');
    clickKey('3');
    expect(filledDots()).toBe(3);
  });

  test('backspace removes the last digit', () => {
    render(createElement(ManagerPinModal, makeProps()));
    clickKey('1');
    clickKey('2');
    clickKey('3');
    fireEvent.click(screen.getByRole('button', { name: 'ลบ' }));
    expect(filledDots()).toBe(2);
  });

  test('clear empties the buffer', () => {
    render(createElement(ManagerPinModal, makeProps()));
    clickKey('1');
    clickKey('2');
    clickKey('ล้าง');
    expect(filledDots()).toBe(0);
  });

  test('the buffer is capped at maxLength', () => {
    render(createElement(ManagerPinModal, makeProps({ pinLength: 4, maxLength: 4 })));
    clickKey('1');
    clickKey('2');
    clickKey('3');
    clickKey('4');
    clickKey('5'); // ignored — over the cap
    expect(filledDots()).toBe(4);
  });
});

// ─── Submit gating / callback ────────────────────────────────────────────────
describe('ManagerPinModal · submit', () => {
  test('submit is disabled until pin.length reaches pinLength', () => {
    render(createElement(ManagerPinModal, makeProps({ pinLength: 4 })));
    const submit = () => screen.getByRole('button', { name: 'ยืนยัน' }) as HTMLButtonElement;
    clickKey('1');
    clickKey('2');
    clickKey('3');
    expect(submit().disabled).toBe(true);
    clickKey('4');
    expect(submit().disabled).toBe(false);
  });

  test('onSubmitPin fires with the exact entered digit string', () => {
    const onSubmitPin = vi.fn();
    render(createElement(ManagerPinModal, makeProps({ onSubmitPin, pinLength: 4 })));
    clickKey('9');
    clickKey('0');
    clickKey('4');
    clickKey('2');
    clickKey('ยืนยัน');
    expect(onSubmitPin).toHaveBeenCalledTimes(1);
    expect(onSubmitPin).toHaveBeenCalledWith('9042');
  });

  test('isSubmitting disables the keypad, submit, and blocks duplicate submit', () => {
    const onSubmitPin = vi.fn();
    render(createElement(ManagerPinModal, makeProps({ onSubmitPin, isSubmitting: true })));
    // Keypad is locked — a digit press does not register.
    clickKey('1');
    expect(filledDots()).toBe(0);
    // The pending submit button is disabled and does not re-fire.
    const pending = screen.getByRole('button', { name: 'กำลังส่งข้อมูล...' }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    fireEvent.click(pending);
    expect(onSubmitPin).not.toHaveBeenCalled();
  });
});

// ─── Passive display ─────────────────────────────────────────────────────────
describe('ManagerPinModal · passive display', () => {
  test('errorMessage renders when provided', () => {
    render(createElement(ManagerPinModal, makeProps({ errorMessage: 'PIN ไม่ถูกต้อง' })));
    expect(screen.getByRole('alert').textContent).toContain('PIN ไม่ถูกต้อง');
  });

  test('sessionDisplayName renders as passive text (not a control)', () => {
    render(createElement(ManagerPinModal, makeProps({ sessionDisplayName: 'คุณเอ' })));
    const node = screen.getByText(/คุณเอ/);
    expect(node).toBeTruthy();
    expect(node.tagName).not.toBe('INPUT');
    expect(node.tagName).not.toBe('BUTTON');
  });
});

// ─── OS virtual-keyboard suppression (no editable PIN path) ───────────────────
describe('ManagerPinModal · OS keyboard suppression', () => {
  test('renders NO editable input/textarea (button-driven entry only)', () => {
    render(createElement(ManagerPinModal, makeProps()));
    expect(document.querySelector('input')).toBeNull();
    expect(document.querySelector('textarea')).toBeNull();
  });
});

// ─── Source contract: presentational, no verifier, no backend, no fake security ─
describe('ManagerPinModal · source contract', () => {
  test('declares no editable input/textarea in source', () => {
    expect(componentSource).not.toContain('<input');
    expect(componentSource).not.toContain('<textarea');
  });

  test('executes no protected / cart / checkout / payment / inventory action', () => {
    for (const token of [
      'addToCart',
      'setLineQty',
      'setBillDiscValue',
      'confirmSale',
      'submitAsyncOrder',
      'useCheckout',
      'useCart',
      'asyncCheckout',
      'cartUtils',
      'inventory',
    ]) {
      expect(componentSource).not.toContain(token);
    }
  });

  test('uses no backend / Firebase / network / storage', () => {
    for (const token of [
      'firebase',
      'firestore',
      'httpsCallable',
      'getDoc',
      'getDocs',
      'onSnapshot',
      'fetch(',
      'localStorage',
      'sessionStorage',
    ]) {
      expect(componentSource).not.toContain(token);
    }
  });

  test('performs no internal PIN comparison and embeds no PIN/secret literal', () => {
    expect(componentSource).not.toMatch(/pin\s*===/i);
    expect(componentSource).not.toMatch(/===\s*['"]\d/);
    expect(componentSource).not.toMatch(/['"]\d{3,}['"]/); // no quoted multi-digit secret
    expect(componentSource).not.toContain('secret');
  });

  test('claims no verification / authorization semantics', () => {
    for (const token of [
      'verifyPin',
      'isValidPin',
      'authorizeManager',
      'authenticateManager',
      'authorize',
      'authenticate',
    ]) {
      expect(componentSource).not.toContain(token);
    }
  });

  test('does not import useAuth / role context', () => {
    expect(componentSource).not.toContain('useAuth');
  });

  test('owns no global keyboard / window / document listener', () => {
    expect(componentSource).not.toContain('addEventListener');
    expect(componentSource).not.toContain('onKeyDown');
  });

  test('imports none of the excluded POS surfaces', () => {
    for (const token of [
      'SharedNumpad',
      'NumpadDialog',
      'PaymentModal',
      'POSPage',
      'ItemDiscountModal',
    ]) {
      expect(componentSource).not.toContain(token);
    }
  });

  test('imports only its own CSS for styling', () => {
    expect(componentSource).toContain("import './ManagerPinModal.css'");
    expect((componentSource.match(/\.css'/g) || []).length).toBe(1);
  });
});

// ─── CSS / class namespace isolation ──────────────────────────────────────────
describe('ManagerPinModal · class namespace', () => {
  test('the component styles only via the mpin-* namespace (source)', () => {
    expect(componentSource).toContain('mpin-');
    // No foreign component-CSS prefix is referenced from the component.
    for (const prefix of ['pay-', 'npd-', 'snp-', 'pos-idp-', 'dc-']) {
      expect(componentSource).not.toContain(prefix);
    }
    expect(componentSource).toContain("import './ManagerPinModal.css'");
  });

  test('rendered elements emit only mpin-* component classes (no foreign prefixes)', () => {
    render(
      createElement(
        ManagerPinModal,
        makeProps({ errorMessage: 'x', sessionDisplayName: 'y' }),
      ),
    );
    const tokens = new Set<string>();
    document.querySelectorAll<HTMLElement>('[class]').forEach((el) => {
      el.classList.forEach((c) => tokens.add(c));
    });
    // Tabler icon utility classes (`ti`, `ti-*`) are third-party and allowed.
    const componentClasses = [...tokens].filter((c) => c !== 'ti' && !c.startsWith('ti-'));
    expect(componentClasses.length).toBeGreaterThan(0);
    for (const c of componentClasses) {
      expect(c.startsWith('mpin-')).toBe(true);
    }
  });
});
