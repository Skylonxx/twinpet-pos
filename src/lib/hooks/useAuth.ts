import { useContext } from 'react';
import { AuthContext, type AuthContextValue } from '../auth/AuthProvider';

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}

export { AuthProvider } from '../auth/AuthProvider';
export type { AuthContextValue } from '../auth/AuthProvider';
