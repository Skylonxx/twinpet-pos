import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

/**
 * Single Firebase Admin app + Firestore handle, pointed at the named `pos-db`
 * database (multi-database, asia-southeast1).
 *
 * App init is idempotent (`getApps()[0] ?? initializeApp()`) so it's safe no
 * matter which module imports this first — avoiding the re-export/hoisting
 * order trap where a trigger module evaluates before index.ts's init runs.
 * Every transaction/write in the deployment goes through this `db`, so all
 * Admin SDK access targets `pos-db`.
 */
const app: App = getApps()[0] ?? initializeApp();

export const db = getFirestore(app, 'pos-db');
