import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { FIRESTORE_DATABASE_ID } from './deployConfig';

/**
 * Single Firebase Admin app + Firestore handle, pointed at the named Firestore
 * database configured in firebase.json (firestore.database).
 *
 * App init is idempotent (`getApps()[0] ?? initializeApp()`) so it's safe no
 * matter which module imports this first — avoiding the re-export/hoisting
 * order trap where a trigger module evaluates before index.ts's init runs.
 * Every transaction/write in the deployment goes through this `db`, so all
 * Admin SDK access targets the configured database.
 */
const app: App = getApps()[0] ?? initializeApp();

export const db = getFirestore(app, FIRESTORE_DATABASE_ID);
