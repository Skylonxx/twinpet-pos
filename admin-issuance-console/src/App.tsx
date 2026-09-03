import { AuthProvider } from './auth/AuthProvider'
import { IssuerConsolePage } from './pages/IssuerConsolePage'

export function App() {
  return (
    <AuthProvider>
      <IssuerConsolePage />
    </AuthProvider>
  )
}
