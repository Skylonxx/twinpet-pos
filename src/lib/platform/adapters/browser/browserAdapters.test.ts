// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import durableAdapterRaw from './browserDurableStorePort.ts?raw';
import secretAdapterRaw from './browserSecureSecretPort.ts?raw';
import printAdapterRaw from './browserPrintPort.ts?raw';
import fileAdapterRaw from './browserFilePort.ts?raw';
import lifecycleAdapterRaw from './browserLifecyclePort.ts?raw';
import connectivityAdapterRaw from './browserConnectivityPort.ts?raw';
import { createInMemoryReversalStore } from '../../../pos/offline/reversalLocalStore';
import {
  __resetBrowserSyncOrchestratorDepsForTests,
  createBrowserConnectivityPort,
  createBrowserSyncOrchestratorDeps,
} from './browserConnectivityPort';
import { createBrowserDurableStorePort } from './browserDurableStorePort';
import {
  BROWSER_SECURE_SECRET_UNSUPPORTED,
  BrowserSecureSecretUnsupportedError,
  createBrowserSecureSecretPort,
} from './browserSecureSecretPort';
import { createBrowserPrintPort } from './browserPrintPort';
import { createBrowserFilePort } from './browserFilePort';
import { createBrowserLifecyclePort } from './browserLifecyclePort';

const originalOnLine = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');
const originalVisibility =
  Object.getOwnPropertyDescriptor(document, 'visibilityState') ??
  Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');

function setOnline(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value });
}

function restoreBrowserGlobals(): void {
  vi.restoreAllMocks();
  if (originalOnLine) Object.defineProperty(window.navigator, 'onLine', originalOnLine);
  else Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
  if (originalVisibility) {
    try {
      Object.defineProperty(document, 'visibilityState', originalVisibility);
    } catch {
      Object.defineProperty(Document.prototype, 'visibilityState', originalVisibility);
    }
  }
}

describe('browser connectivity adapter', () => {
  beforeEach(() => {
    __resetBrowserSyncOrchestratorDepsForTests();
    setOnline(true);
  });

  afterEach(() => {
    __resetBrowserSyncOrchestratorDepsForTests();
    restoreBrowserGlobals();
  });

  test('current online value is derived from the real navigator', () => {
    setOnline(true);
    expect(createBrowserConnectivityPort().isOnline()).toBe(true);
    expect(createBrowserConnectivityPort().getNavigator()).toBe(window.navigator);
  });

  test('offline value is derived from the real navigator.onLine flag', () => {
    setOnline(false);
    expect(createBrowserConnectivityPort().isOnline()).toBe(false);
    expect(createBrowserConnectivityPort().getNavigator()).toBe(window.navigator);
  });

  test('online event subscription matches window scheduling and unsubscribes', () => {
    const port = createBrowserConnectivityPort();
    const seen: string[] = [];
    const unsub = port.subscribe('online', () => seen.push('online'));
    window.dispatchEvent(new Event('online'));
    expect(seen).toEqual(['online']);
    unsub();
    window.dispatchEvent(new Event('online'));
    expect(seen).toEqual(['online']);
  });

  test('offline event subscription matches window scheduling and unsubscribes', () => {
    const port = createBrowserConnectivityPort();
    const seen: string[] = [];
    const unsub = port.subscribe('offline', () => seen.push('offline'));
    window.dispatchEvent(new Event('offline'));
    expect(seen).toEqual(['offline']);
    unsub();
    window.dispatchEvent(new Event('offline'));
    expect(seen).toEqual(['offline']);
  });

  test('exports the actual Navigator and injects that same reference into orchestrator deps', () => {
    const port = createBrowserConnectivityPort();
    expect(port.getNavigator()).toBe(navigator);
    expect(port.getNavigator()).toBe(window.navigator);
    const deps = createBrowserSyncOrchestratorDeps();
    expect(deps.navigatorRef).toBe(navigator);
    expect(deps.navigatorRef).toBe(port.getNavigator());
    expect(deps.navigatorRef).not.toEqual({ onLine: true });
    expect(Object.keys(deps.navigatorRef ?? {})).not.toEqual(['onLine']);
  });

  test('orchestrator deps add/remove listeners preserve window online/offline event semantics', () => {
    const deps = createBrowserSyncOrchestratorDeps();
    const seen: string[] = [];
    const onOnline = () => seen.push('online');
    const onOffline = () => seen.push('offline');
    deps.addEventListener('online', onOnline);
    deps.addEventListener('offline', onOffline);
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('offline'));
    expect(seen).toEqual(['online', 'offline']);
    deps.removeEventListener('online', onOnline);
    deps.removeEventListener('offline', onOffline);
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('offline'));
    expect(seen).toEqual(['online', 'offline']);
  });

  test('adapter source keeps the real navigator and does not synthesize an onLine-only object', () => {
    expect(connectivityAdapterRaw).toContain('typeof navigator !== \'undefined\' ? navigator : undefined');
    expect(connectivityAdapterRaw).not.toMatch(/navigatorRef\s*:\s*\{\s*onLine/);
    expect(connectivityAdapterRaw).not.toContain('indexedDB.open');
  });
});

describe('browser durable-store adapter', () => {
  afterEach(() => {
    restoreBrowserGlobals();
  });
  test('delegates get / getAll / put / delete / transaction to the existing factory contract', async () => {
    const memory = createInMemoryReversalStore();
    const transact = vi.spyOn(memory, 'transact');
    const port = createBrowserDurableStorePort(memory);
    await port.transact(['intents'], 'readwrite', async (txn) => {
      await txn.put('intents', 'k1', { n: 1 });
      expect(await txn.get('intents', 'k1')).toEqual({ n: 1 });
      await txn.put('intents', 'k2', { n: 2 });
      expect(await txn.getAll('intents')).toEqual([{ n: 1 }, { n: 2 }]);
      await txn.delete('intents', 'k1');
      expect(await txn.get('intents', 'k1')).toBeUndefined();
      expect(await txn.getAll('intents')).toEqual([{ n: 2 }]);
    });
    expect(transact).toHaveBeenCalledTimes(1);
    expect(transact.mock.calls[0]?.[0]).toEqual(['intents']);
    expect(transact.mock.calls[0]?.[1]).toBe('readwrite');
  });

  test('preserves abort semantics of the delegated store', async () => {
    const memory = createInMemoryReversalStore();
    const port = createBrowserDurableStorePort(memory);
    await expect(
      port.transact(['intents'], 'readwrite', async (txn) => {
        await txn.put('intents', 'x', 1);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(memory.dump().intents).toEqual({});
  });

  test('does not open IndexedDB itself and defaults to the existing reversal factory', () => {
    expect(durableAdapterRaw).not.toContain('indexedDB.open');
    expect(durableAdapterRaw).not.toContain('indexedDB.open(');
    expect(durableAdapterRaw).toContain('createIndexedDbReversalStore');
    expect(durableAdapterRaw).not.toContain('activeCartSnapshotStore');
    expect(durableAdapterRaw).not.toContain('saleSubmissionEvidenceStore');
  });
});

describe('browser secure-secret adapter', () => {
  test('unsupported persistence fails explicitly and introduces no secret store', async () => {
    const port = createBrowserSecureSecretPort();
    await expect(port.get('pin')).rejects.toBeInstanceOf(BrowserSecureSecretUnsupportedError);
    await expect(port.set('pin', '1234')).rejects.toMatchObject({
      code: BROWSER_SECURE_SECRET_UNSUPPORTED,
    });
    await expect(port.delete('token')).rejects.toThrow(/does not persist secrets/);
    expect(secretAdapterRaw).not.toContain('indexedDB.open');
    expect(secretAdapterRaw).not.toMatch(/localStorage\.setItem/);
    expect(secretAdapterRaw).not.toMatch(/localStorage\.getItem/);
    expect(secretAdapterRaw).not.toMatch(/sessionStorage/);
  });
});

describe('browser print adapter', () => {
  afterEach(() => {
    restoreBrowserGlobals();
  });

  test('delegates to window.print', () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    createBrowserPrintPort().print();
    expect(print).toHaveBeenCalledTimes(1);
    expect(printAdapterRaw).toContain('window.print()');
    expect(printAdapterRaw).not.toContain('indexedDB.open');
  });
});

describe('browser file adapter', () => {
  afterEach(() => {
    restoreBrowserGlobals();
  });

  test('preserves browser download via Blob object URL and anchor click', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    createBrowserFilePort().saveTextFile('export.csv', 'text/csv', 'a,b');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith('blob:fake');
    expect(fileAdapterRaw).toContain('URL.createObjectURL');
    expect(fileAdapterRaw).toContain('a.download');
    expect(fileAdapterRaw).not.toContain('indexedDB.open');
  });
});

describe('browser lifecycle adapter', () => {
  afterEach(() => {
    restoreBrowserGlobals();
  });

  test('visibility subscription/cleanup uses document lifecycle only', () => {
    const port = createBrowserLifecyclePort();
    expect(port.getState() === 'visible' || port.getState() === 'hidden' || port.getState() === 'unknown').toBe(
      true,
    );
    const seen: string[] = [];
    const unsub = port.subscribe((state) => seen.push(state));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(seen).toEqual(['hidden']);
    unsub();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(seen).toEqual(['hidden']);
    expect(lifecycleAdapterRaw).toContain('visibilitychange');
    expect(lifecycleAdapterRaw).not.toContain('@capacitor');
    expect(lifecycleAdapterRaw).not.toContain('__TAURI__');
    expect(lifecycleAdapterRaw).not.toContain('indexedDB.open');
  });
});
