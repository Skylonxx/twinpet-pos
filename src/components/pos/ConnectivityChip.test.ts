// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { act, render, screen, cleanup } from '@testing-library/react';
import ConnectivityChip from './ConnectivityChip';

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value });
}

const hasClass = (el: HTMLElement, cls: string) => el.classList.contains(cls);

describe('ConnectivityChip', () => {
  beforeEach(() => setOnline(true));
  afterEach(() => cleanup());

  test('renders an online chip when navigator.onLine is true', () => {
    render(createElement(ConnectivityChip));
    expect(hasClass(screen.getByTestId('p6cc-chip'), 'p6cc-chip--online')).toBe(true);
    expect(screen.getByText('ออนไลน์')).toBeTruthy();
  });

  test('renders an offline chip when navigator.onLine is false', () => {
    setOnline(false);
    render(createElement(ConnectivityChip));
    expect(hasClass(screen.getByTestId('p6cc-chip'), 'p6cc-chip--offline')).toBe(true);
    expect(screen.getByText(/ออฟไลน์/)).toBeTruthy();
  });

  test('never implies selling is blocked while offline', () => {
    setOnline(false);
    render(createElement(ConnectivityChip));
    expect(screen.getByText(/ขายต่อได้ตามปกติ/)).toBeTruthy();
  });

  test('flips to offline on a window "offline" event', () => {
    render(createElement(ConnectivityChip));
    expect(hasClass(screen.getByTestId('p6cc-chip'), 'p6cc-chip--online')).toBe(true);

    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event('offline'));
    });

    expect(hasClass(screen.getByTestId('p6cc-chip'), 'p6cc-chip--offline')).toBe(true);
  });

  test('flips back to online on a window "online" event', () => {
    setOnline(false);
    render(createElement(ConnectivityChip));
    expect(hasClass(screen.getByTestId('p6cc-chip'), 'p6cc-chip--offline')).toBe(true);

    act(() => {
      setOnline(true);
      window.dispatchEvent(new Event('online'));
    });

    expect(hasClass(screen.getByTestId('p6cc-chip'), 'p6cc-chip--online')).toBe(true);
  });
});
