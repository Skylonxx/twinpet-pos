/**
 * Single source of truth for the browser-origin allowlist of every desktop /
 * browser-facing callable that supplies an explicit `cors` option.
 *
 * The installed Windows Tauri shell loads the app from the exact origin
 * `http://tauri.localhost`. A callable whose allowlist omits it fails the
 * webview CORS preflight before the request ever reaches Cloud Run, which the
 * client then reports as an unknown outcome. Callables that omit the `cors`
 * option use the platform default (any origin) and are not affected.
 *
 * Do not widen this list to `*`, `true`, other schemes or other
 * `*.localhost` hosts. The Tauri entry is an exact string on purpose: the
 * `cors` middleware compares strings by equality, so
 * `https://tauri.localhost`, `tauri://localhost`, `http://tauri.localhost:443`
 * and `http://tauri.localhost.evil.example` stay refused.
 */
export const TAURI_WINDOWS_PRODUCTION_ORIGIN = 'http://tauri.localhost';

/** Local development servers (any port), http or https. */
export const LOCALHOST_DEV_ORIGIN_PATTERN = /^https?:\/\/localhost:\d+$/;

/** Firebase Hosting default domains. */
export const FIREBASE_APP_ORIGIN_PATTERN = /^https:\/\/.*\.firebaseapp\.com$/;
export const FIREBASE_WEB_APP_ORIGIN_PATTERN = /^https:\/\/.*\.web\.app$/;

export const DESKTOP_CALLABLE_CORS: Array<string | RegExp> = [
  LOCALHOST_DEV_ORIGIN_PATTERN,
  FIREBASE_APP_ORIGIN_PATTERN,
  FIREBASE_WEB_APP_ORIGIN_PATTERN,
  TAURI_WINDOWS_PRODUCTION_ORIGIN,
];
