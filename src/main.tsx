import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AuthProvider } from './lib/hooks/useAuth'
import { initDeviceIdentity } from './lib/pos/deviceId'

function renderApp() {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AuthProvider>
        <App />
      </AuthProvider>
    </StrictMode>,
  )
}

// Recover the device identity (id + seq + label) from the IndexedDB mirror before
// the first render, so a localStorage wipe never silently mints a new terminal.
void initDeviceIdentity().finally(renderApp)
