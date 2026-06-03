import { initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth';
import {
  CACHE_SIZE_UNLIMITED,
  connectFirestoreEmulator,
  getFirestore,
  initializeFirestore,
  memoryLocalCache,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from 'firebase/firestore';
import { connectStorageEmulator, getStorage, type FirebaseStorage } from 'firebase/storage';

/**
 * Unified local-emulator switch. When `VITE_USE_EMULATOR=true` in a DEV build,
 * EVERY Firebase SDK (Firestore, Auth, Storage, and the Functions callables in
 * verifyPinLogin.ts) is pointed at the local emulator suite — so the browser →
 * local Firestore → local Functions trigger round-trip actually closes. Off (or
 * any production build) → the real cloud project, untouched. One flag for all
 * SDKs avoids the dangerous split-brain (e.g. functions local but Firestore cloud).
 */
export const USE_EMULATOR =
  import.meta.env.DEV && import.meta.env.VITE_USE_EMULATOR === 'true';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const isFirebaseConfigured = Object.values(firebaseConfig).every(
  (value) => typeof value === 'string' && value.length > 0,
);

let app: FirebaseApp | undefined;
let auth: Auth | undefined;
let db: Firestore | undefined;
let storage: FirebaseStorage | undefined;

/**
 * Named Firestore database this project uses. Sourced from the build-time env
 * (VITE_FIRESTORE_DATABASE_ID), which is generated from firebase.json by
 * scripts/gen-deploy-config.mjs (run automatically on dev/build). firebase.json
 * is the single source of truth — do not hardcode the id here.
 */
const FIRESTORE_DATABASE_ID = import.meta.env.VITE_FIRESTORE_DATABASE_ID;

function initFirestore(appInstance: FirebaseApp): Firestore {
  // Unlimited on-disk cache: the offline-first POS must hold the full catalog
  // (10,000+ items) in IndexedDB so the Repository can resolve snapshots from
  // cache without eviction during long offline stretches.
  // The 3rd arg pins every path to the configured named database.
  try {
    return initializeFirestore(
      appInstance,
      {
        localCache: persistentLocalCache({
          tabManager: persistentMultipleTabManager(),
          cacheSizeBytes: CACHE_SIZE_UNLIMITED,
        }),
      },
      FIRESTORE_DATABASE_ID,
    );
  } catch (err) {
    console.warn('[firebase] multi-tab persistence unavailable — trying single-tab', err);
  }

  try {
    return initializeFirestore(
      appInstance,
      { localCache: persistentLocalCache({ cacheSizeBytes: CACHE_SIZE_UNLIMITED }) },
      FIRESTORE_DATABASE_ID,
    );
  } catch (err) {
    console.warn('[firebase] IndexedDB persistence unavailable — using memory cache', err);
  }

  try {
    return initializeFirestore(
      appInstance,
      { localCache: memoryLocalCache() },
      FIRESTORE_DATABASE_ID,
    );
  } catch {
    return getFirestore(appInstance, FIRESTORE_DATABASE_ID);
  }
}

if (isFirebaseConfigured) {
  if (!FIRESTORE_DATABASE_ID) {
    // Guard against silently connecting to the (default) database — the cause of
    // the original missing-index / reconcile failures. The id is generated from
    // firebase.json; `npm run dev`/`build` regenerate it.
    throw new Error(
      'VITE_FIRESTORE_DATABASE_ID is not set. Run `node scripts/gen-deploy-config.mjs` ' +
        '(or any `npm run dev`/`build`) to regenerate .env from firebase.json.',
    );
  }
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = initFirestore(app);
  storage = getStorage(app);

  if (USE_EMULATOR) {
    // Must run before any read/write. Ports match firebase.json → emulators.
    try {
      connectFirestoreEmulator(db, '127.0.0.1', 8080);
      connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
      connectStorageEmulator(storage, '127.0.0.1', 9199);
      // Functions callables connect to :5001 in verifyPinLogin.ts (same flag).
      console.info(
        `[firebase] 🔌 LOCAL EMULATORS — Firestore:8080 Auth:9099 Storage:9199 Functions:5001 (db="${FIRESTORE_DATABASE_ID}")`,
      );
    } catch (err) {
      console.error('[firebase] failed to connect to local emulators', err);
    }
  }
}

export { app, auth, db, storage };

/** Top-level Firestore collection names (see docs/twinpet_firestore_schema.md) */
export const collections = {
  branches: 'branches',
  users: 'users',
  products: 'products',
  categories: 'categories',
  productStocks: 'productStocks',
  stockLots: 'stockLots',
  stockMovements: 'stockMovements',
  customers: 'customers',
  customerTiers: 'customerTiers',
  priceLevels: 'priceLevels',
  uomUnits: 'uomUnits',
  orders: 'orders',
  orderItems: 'orderItems',
  asyncOrders: 'asyncOrders',
  parkedOrders: 'parkedOrders',
  parkedItems: 'parkedItems',
  payments: 'payments',
  quotations: 'quotations',
  quotationItems: 'quotationItems',
  receivings: 'receivings',
  receivingItems: 'receivingItems',
  inventoryAdjustments: 'inventoryAdjustments',
  adjustmentItems: 'adjustmentItems',
  inventoryTransfers: 'inventoryTransfers',
  transferItems: 'transferItems',
  creditAccounts: 'creditAccounts',
  creditTransactions: 'creditTransactions',
  creditPayments: 'creditPayments',
  settings: 'settings',
  posDevices: 'posDevices',
  shifts: 'shifts',
  cashTransactions: 'cashTransactions',
  staffActivities: 'staffActivities',
  auditLogs: 'auditLogs',
  suppliers: 'suppliers',
} as const;

export type CollectionName = (typeof collections)[keyof typeof collections];

/** Internal Firebase Auth email for username/password sign-in */
export function authEmailForUsername(username: string): string {
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID ?? 'twinpet';
  return `${username.trim().toLowerCase()}@${projectId}.twinpet`;
}
