// @vitest-environment jsdom
//
// UI-10-A contract tests for the stateless SharedNumpad primitive.
//
// NOTE: this spec is deliberately a `.ts` file (per the packet allowlist), so it
// uses `createElement` rather than JSX — esbuild/tsc do not parse JSX inside a
// `.ts` module. Assertions cover both runtime behavior (key emission + gating)
// and a source-level contract proving the component stays logic-free.

import { describe, test, expect, beforeAll, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import SharedNumpad from './SharedNumpad';
import type { NumpadAccessory } from './SharedNumpad';

let numpadSource: string;

beforeAll(async () => {
  numpadSource = (await import('./SharedNumpad.tsx?raw')).default;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const makeAccessory = (over: Partial<NumpadAccessory> = {}): NumpadAccessory => ({
  id: 'bn-100',
  label: '฿100',
  gridRow: 1,
  gridColumn: '4',
  variant: 'banknote',
  onPress: vi.fn(),
  ...over,
});

// ─── Semantic key emission ───────────────────────────────────────────────────
describe('SharedNumpad · key emission', () => {
  test('a digit key press emits the correct semantic key', () => {
    const onKey = vi.fn();
    render(createElement(SharedNumpad, { layout: 'grid-3x4', onKey }));
    fireEvent.click(screen.getByRole('button', { name: '7' }));
    expect(onKey).toHaveBeenCalledTimes(1);
    expect(onKey).toHaveBeenCalledWith('7');
  });

  test('the decimal "." key emits the correct semantic key', () => {
    const onKey = vi.fn();
    render(createElement(SharedNumpad, { layout: 'grid-4x5-payment', onKey }));
    fireEvent.click(screen.getByRole('button', { name: '.' }));
    expect(onKey).toHaveBeenCalledWith('.');
  });

  test('the clear "C" key emits the correct semantic key', () => {
    const onKey = vi.fn();
    render(createElement(SharedNumpad, { layout: 'grid-3x4', onKey }));
    fireEvent.click(screen.getByRole('button', { name: 'C' }));
    expect(onKey).toHaveBeenCalledWith('C');
  });

  test('the literal backspace "⌫" key emits exactly "⌫"', () => {
    const onKey = vi.fn();
    render(createElement(SharedNumpad, { layout: 'grid-3x4', onKey }));
    // Queried by its visible glyph to prove the literal key round-trips unchanged.
    fireEvent.click(screen.getByText('⌫'));
    expect(onKey).toHaveBeenCalledWith('⌫');
  });
});

// ─── Disabled gating ─────────────────────────────────────────────────────────
describe('SharedNumpad · disabled gating', () => {
  test('a whole-pad `disabled` suppresses key presses', () => {
    const onKey = vi.fn();
    render(createElement(SharedNumpad, { layout: 'grid-3x4', onKey, disabled: true }));
    fireEvent.click(screen.getByRole('button', { name: '5' }));
    expect(onKey).not.toHaveBeenCalled();
  });

  test('`disabledKeys` suppresses only the listed keys', () => {
    const onKey = vi.fn();
    render(
      createElement(SharedNumpad, { layout: 'grid-3x4', onKey, disabledKeys: { '5': true } }),
    );
    fireEvent.click(screen.getByRole('button', { name: '5' }));
    expect(onKey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '6' }));
    expect(onKey).toHaveBeenCalledTimes(1);
    expect(onKey).toHaveBeenCalledWith('6');
  });
});

// ─── Accessories ─────────────────────────────────────────────────────────────
describe('SharedNumpad · accessories', () => {
  test('accessory cells render', () => {
    render(
      createElement(SharedNumpad, {
        layout: 'grid-4x5-payment',
        onKey: vi.fn(),
        accessories: [makeAccessory()],
      }),
    );
    expect(screen.getByRole('button', { name: '฿100' })).toBeTruthy();
  });

  test('accessory `onPress` fires on click', () => {
    const onPress = vi.fn();
    render(
      createElement(SharedNumpad, {
        layout: 'grid-4x5-payment',
        onKey: vi.fn(),
        accessories: [makeAccessory({ onPress })],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '฿100' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  test('a disabled accessory does not fire', () => {
    const onPress = vi.fn();
    render(
      createElement(SharedNumpad, {
        layout: 'grid-4x5-payment',
        onKey: vi.fn(),
        accessories: [makeAccessory({ onPress, disabled: true })],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '฿100' }));
    expect(onPress).not.toHaveBeenCalled();
  });

  test('a whole-pad `disabled` also disables accessories', () => {
    const onPress = vi.fn();
    render(
      createElement(SharedNumpad, {
        layout: 'grid-4x5-payment',
        onKey: vi.fn(),
        disabled: true,
        accessories: [makeAccessory({ onPress })],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '฿100' }));
    expect(onPress).not.toHaveBeenCalled();
  });
});

// ─── Layout variants ─────────────────────────────────────────────────────────
describe('SharedNumpad · layouts', () => {
  test('`grid-3x4` renders all twelve expected keys', () => {
    render(createElement(SharedNumpad, { layout: 'grid-3x4', onKey: vi.fn() }));
    for (const name of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'C']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    expect(screen.getByText('⌫')).toBeTruthy();
    expect(document.querySelector('.snp-grid--grid-3x4')).toBeTruthy();
  });

  test('`grid-4x5-payment` supports accessory placement (banknote column + fill span)', () => {
    const banknote = makeAccessory({
      id: 'bn',
      label: '฿500',
      gridRow: 2,
      gridColumn: '4',
      variant: 'banknote',
    });
    const fill = makeAccessory({
      id: 'fill',
      label: 'ใส่ยอดที่เหลือ',
      gridRow: 5,
      gridColumn: '1 / span 2',
      variant: 'fill',
      onPress: vi.fn(),
    });
    render(
      createElement(SharedNumpad, {
        layout: 'grid-4x5-payment',
        onKey: vi.fn(),
        accessories: [banknote, fill],
      }),
    );
    expect(screen.getByRole('button', { name: '฿500' }).className).toContain('snp-btn--banknote');
    expect(screen.getByRole('button', { name: 'ใส่ยอดที่เหลือ' }).className).toContain('snp-btn--fill');
    expect(document.querySelector('.snp-grid--grid-4x5-payment')).toBeTruthy();
  });
});

// ─── Stateless / no-ownership source contract ────────────────────────────────
describe('SharedNumpad · stateless source contract', () => {
  test('declares no value state (no useState)', () => {
    expect(numpadSource).not.toContain('useState');
  });

  test('performs no numeric parsing', () => {
    expect(numpadSource).not.toContain('parseFloat');
    expect(numpadSource).not.toContain('parseInt');
  });

  test('wires no keyboard handler', () => {
    expect(numpadSource).not.toContain('onKeyDown');
  });

  test('attaches no global listener', () => {
    expect(numpadSource).not.toContain('addEventListener');
  });

  test('mounts no portal', () => {
    expect(numpadSource).not.toContain('createPortal');
  });

  test('owns no confirm / submit action', () => {
    expect(numpadSource).not.toContain('onConfirm');
    expect(numpadSource).not.toContain('onSubmit');
    expect(numpadSource).not.toContain('type="submit"');
  });
});

// ─── Not yet wired into production ───────────────────────────────────────────
describe('SharedNumpad · isolation', () => {
  test('no production module imports SharedNumpad yet', () => {
    const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    const importers = Object.entries(sources)
      .filter(([path]) => !path.includes('SharedNumpad'))
      .filter(([, src]) => src.includes('SharedNumpad'))
      .map(([path]) => path);
    expect(importers).toEqual([]);
  });
});
