import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import {
  CACHE_SIZE_UNLIMITED,
  getFirestore,
  initializeFirestore,
  memoryLocalCache,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from 'firebase/firestore';
import { getStorage, type FirebaseStorage } from 'firebase/storage';

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

function initFirestore(appInstance: FirebaseApp): Firestore {
  // Unlimited on-disk cache: the offline-first POS must hold the full catalog
  // (10,000+ items) in IndexedDB so the Repository can resolve snapshots from
  // cache without eviction during long offline stretches.
  try {
    return initializeFirestore(appInstance, {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
        cacheSizeBytes: CACHE_SIZE_UNLIMITED,
      }),
    });
  } catch (err) {
    console.warn('[firebase] multi-tab persistence unavailable — trying single-tab', err);
  }

  try {
    return initializeFirestore(appInstance, {
      localCache: persistentLocalCache({ cacheSizeBytes: CACHE_SIZE_UNLIMITED }),
    });
  } catch (err) {
    console.warn('[firebase] IndexedDB persistence unavailable — using memory cache', err);
  }

  try {
    return initializeFirestore(appInstance, {
      localCache: memoryLocalCache(),
    });
  } catch {
    return getFirestore(appInstance);
  }
}

if (isFirebaseConfigured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = initFirestore(app);
  storage = getStorage(app);
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
