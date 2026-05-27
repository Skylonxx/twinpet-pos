import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';
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

if (isFirebaseConfigured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
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
} as const;

export type CollectionName = (typeof collections)[keyof typeof collections];

/** Internal Firebase Auth email for username/password sign-in */
export function authEmailForUsername(username: string): string {
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID ?? 'twinpet';
  return `${username.trim().toLowerCase()}@${projectId}.twinpet`;
}
