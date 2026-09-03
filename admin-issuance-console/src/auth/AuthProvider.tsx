import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth'
import { auth } from '../firebase'

/**
 * Admin Issuance Console auth gate. Every issuer-registration/device-
 * enrollment callable requires "Admin Firebase Auth (role == admin)" per the
 * frozen issuer trust decision — this provider is the console's sole
 * identity source; it never reads Firestore directly (the `admin` role
 * claim comes from the ID token, matched server-side against the live
 * `users/{uid}` doc inside each callable, not trusted here alone).
 */

export type AuthStatus = 'loading' | 'signed-out' | 'signed-in-non-admin' | 'signed-in-admin'

export interface AuthContextValue {
  user: User | null
  status: AuthStatus
  error: string | null
  signIn: (email: string, password: string) => Promise<void>
  signOutUser: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!auth) {
      setStatus('signed-out')
      return
    }
    return onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser)
      if (!nextUser) {
        setStatus('signed-out')
        return
      }
      try {
        const tokenResult = await nextUser.getIdTokenResult(true)
        setStatus(tokenResult.claims.role === 'admin' ? 'signed-in-admin' : 'signed-in-non-admin')
      } catch {
        setStatus('signed-in-non-admin')
      }
    })
  }, [])

  const signIn = async (email: string, password: string): Promise<void> => {
    if (!auth) throw new Error('Firebase is not configured')
    setError(null)
    try {
      await signInWithEmailAndPassword(auth, email, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'เข้าสู่ระบบไม่สำเร็จ')
      throw err
    }
  }

  const signOutUser = async (): Promise<void> => {
    if (!auth) return
    await firebaseSignOut(auth)
  }

  return (
    <AuthContext.Provider value={{ user, status, error, signIn, signOutUser }}>{children}</AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
