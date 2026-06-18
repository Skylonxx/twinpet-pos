// ─── Phase 7C-UI-04: Product Grid Card + Settings Contract Tests (test-only) ──────
// Locks the UI-04 wiring between the localStorage-backed POS display preferences
// (usePOSPreferences), the POSPage product cards that CONSUME them, and the
// Settings page section that EDITS them.
//
// Strategy: source-level `?raw` assertions, mirroring POSPage.keyboard-contract.test.ts.
// The vitest unit config runs in a `node` environment with no DOM, and POSPage carries a
// heavy Firebase/router/auth/cart harness — so mounting is neither supported nor safe.
// These tests prove structural/wiring INTENT (preference defaults, consumption, conditional
// stock render, independent size classes) rather than runtime behavior. NO runtime source
// is modified by this slice.

import { describe, test, expect, beforeAll, afterEach } from 'vitest';
import { posPreferencesStore } from '../hooks/pos/usePOSPreferences';

let prefsSource: string;
let posSource: string;
let settingsSource: string;
let settingsNavSource: string;

beforeAll(async () => {
  prefsSource = (await import('../hooks/pos/usePOSPreferences.ts?raw')).default;
  posSource = (await import('./POSPage.tsx?raw')).default;
  settingsSource = (await import('./SettingsPage.tsx?raw')).default;
  settingsNavSource = (await import('../lib/settings/settingsNav.ts?raw')).default;
});

describe('UI-04 — usePOSPreferences store', () => {
  test('exposes the three new product-card preferences + setters', () => {
    for (const key of ['showStock', 'productNameFontSize', 'priceFontSize']) {
      expect(prefsSource, `store should expose ${key}`).toContain(key);
    }
    for (const setter of ['setShowStock', 'setProductNameFontSize', 'setPriceFontSize']) {
      expect(prefsSource, `store should expose ${setter}`).toContain(setter);
    }
  });

  test('defaults preserve the current presentation (stock on, scales normal)', () => {
    expect(prefsSource).toContain('DEFAULT_SHOW_STOCK = true');
    expect(prefsSource).toContain("DEFAULT_PRODUCT_NAME_FONT_SIZE: POSFontSize = 'normal'");
    expect(prefsSource).toContain("DEFAULT_PRICE_FONT_SIZE: POSFontSize = 'normal'");
  });

  test('stored values are validated before use (corrupt input falls back to defaults)', () => {
    // Booleans validated for showStock; font sizes validated via isFontSize.
    expect(prefsSource).toContain('isBoolean(obj.showStock)');
    expect(prefsSource).toContain('isFontSize(obj.productNameFontSize)');
    expect(prefsSource).toContain('isFontSize(obj.priceFontSize)');
  });

  test('is a single reactive source of truth (useSyncExternalStore, not per-instance useState)', () => {
    // The UAT-failure root cause was per-call useState: the Settings editor and the
    // POS grid held independent copies, so an edit never reached the mounted cards.
    // Lock the wiring fix structurally so a regression back to local state is caught.
    expect(prefsSource).toContain('useSyncExternalStore');
    expect(prefsSource).toContain('const listeners = new Set<() => void>()');
    // No per-instance React state for the prefs (the regression we are guarding).
    expect(prefsSource).not.toMatch(/useState</);
  });
});

// ─── Runtime reactivity: the actual bug fix ──────────────────────────────────
// The vitest unit config is a node env (no DOM/React render), so we exercise the
// shared store directly. This proves the behaviour the UAT failure needed: editing
// a preference (what the Settings setters do) updates the ONE snapshot every POS
// consumer reads AND notifies subscribers (what triggers the product-card re-render).
describe('UI-04 — shared preferences store reacts to setter changes', () => {
  // Module-level singleton: restore defaults after each test so order never matters.
  afterEach(() => {
    posPreferencesStore.setShowStock(true);
    posPreferencesStore.setProductNameFontSize('normal');
    posPreferencesStore.setPriceFontSize('normal');
  });

  test('every consumer reads ONE shared snapshot (no independent copies)', () => {
    // Two reads = two consumers (Settings editor + POS grid). A setter must move both.
    const before = posPreferencesStore.getSnapshot();
    posPreferencesStore.setShowStock(false);
    const after = posPreferencesStore.getSnapshot();
    expect(before.showStock).toBe(true);
    expect(after.showStock).toBe(false);
  });

  test('a setter notifies subscribers so the POS cards re-render', () => {
    let notified = 0;
    const unsubscribe = posPreferencesStore.subscribe(() => {
      notified += 1;
    });
    posPreferencesStore.setShowStock(false);
    expect(notified).toBe(1);
    // The snapshot reference changes on a real update (useSyncExternalStore contract).
    posPreferencesStore.setProductNameFontSize('large');
    expect(notified).toBe(2);
    unsubscribe();
    posPreferencesStore.setShowStock(true);
    expect(notified).toBe(2); // unsubscribed → no further notifications
  });

  test('showStock toggles both directions', () => {
    posPreferencesStore.setShowStock(false);
    expect(posPreferencesStore.getSnapshot().showStock).toBe(false);
    posPreferencesStore.setShowStock(true);
    expect(posPreferencesStore.getSnapshot().showStock).toBe(true);
  });

  test('independent product-name and price scales update separately', () => {
    posPreferencesStore.setProductNameFontSize('large');
    posPreferencesStore.setPriceFontSize('small');
    const snap = posPreferencesStore.getSnapshot();
    expect(snap.productNameFontSize).toBe('large');
    expect(snap.priceFontSize).toBe('small'); // price scale did not follow the name scale
  });

  test('invalid input is rejected (store stays on the last valid value)', () => {
    posPreferencesStore.setProductNameFontSize('large');
    // @ts-expect-error — deliberately invalid runtime input from a bad caller.
    posPreferencesStore.setProductNameFontSize('gigantic');
    expect(posPreferencesStore.getSnapshot().productNameFontSize).toBe('large');
  });

  test('a no-op set does not notify subscribers (no needless re-render)', () => {
    posPreferencesStore.setShowStock(false);
    let notified = 0;
    const unsubscribe = posPreferencesStore.subscribe(() => {
      notified += 1;
    });
    posPreferencesStore.setShowStock(false); // same value → no emit
    expect(notified).toBe(0);
    unsubscribe();
  });
});

describe('UI-04 — POSPage consumes the preferences', () => {
  test('reads showStock / productNameFontSize / priceFontSize from the store', () => {
    expect(posSource).toContain('usePOSPreferences()');
    for (const key of ['showStock', 'productNameFontSize', 'priceFontSize']) {
      expect(posSource, `POSPage should consume ${key}`).toContain(key);
    }
  });

  test('stock indicator renders only when showStock is on (no empty gap otherwise)', () => {
    expect(posSource).toContain('showStock && <span className="pos-prod-stock">');
  });

  test('applies independent name/price scale classes on the page root', () => {
    expect(posSource).toContain('pos-name-${productNameFontSize}');
    expect(posSource).toContain('pos-price-${priceFontSize}');
  });
});

describe('UI-04 — Settings page edits the preferences', () => {
  test('a pos-display nav item routes to the posDisplay section', () => {
    expect(settingsNavSource).toContain("slug: 'pos-display'");
    expect(settingsNavSource).toContain("section: 'posDisplay'");
  });

  test('the posDisplay section wires the three setters', () => {
    expect(settingsSource).toContain("section === 'posDisplay'");
    expect(settingsSource).toContain('onChange={setShowStock}');
    expect(settingsSource).toContain('onChange={setProductNameFontSize}');
    expect(settingsSource).toContain('onChange={setPriceFontSize}');
  });
});
