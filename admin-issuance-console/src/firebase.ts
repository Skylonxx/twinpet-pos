import { initializeApp, type FirebaseApp } from 'firebase/app'
import { getAuth, connectAuthEmulator, type Auth } from 'firebase/auth'
import { getFunctions, connectFunctionsEmulator, type Functions } from 'firebase/functions'

/**
 * Admin Issuance Console — Auth + Functions only. This console never touches
 * Firestore directly (no client SDK Firestore access at all): every
 * server-side effect goes through a Cloud Functions callable
 * (registerIssuer, revokeIssuerRegistration,
 * beginDeviceEnrollmentAuthorizationIssuance,
 * completeDeviceEnrollmentAuthorizationIssuance), matching the frozen issuer
 * trust model — the console proves identity via Admin Firebase Auth +
 * issuer-signed request frames, not via direct database access.
 */

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

export const FUNCTIONS_REGION = import.meta.env.VITE_FUNCTIONS_REGION ?? 'asia-southeast1'

export const isFirebaseConfigured = Object.values(firebaseConfig).every(
  (value) => typeof value === 'string' && value.length > 0,
)

export const USE_EMULATOR = import.meta.env.DEV && import.meta.env.VITE_USE_EMULATOR === 'true'

let app: FirebaseApp | undefined
let auth: Auth | undefined
let functions: Functions | undefined

if (isFirebaseConfigured) {
  app = initializeApp(firebaseConfig)
  auth = getAuth(app)
  functions = getFunctions(app, FUNCTIONS_REGION)

  if (USE_EMULATOR) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
    connectFunctionsEmulator(functions, '127.0.0.1', 5001)
    console.info('[issuer-console] 🔌 LOCAL EMULATORS — Auth:9099 Functions:5001')
  }
}

export { app, auth, functions }
