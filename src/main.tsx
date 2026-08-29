import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AuthProvider } from './lib/hooks/useAuth'
import {
  bootNativeDurableStore,
  getDurableBootError,
  isDurableStartupBlocked,
} from './lib/platform/durableStore/bootDurableStore'
import { initDeviceIdentity } from './lib/pos/deviceId'
import './lib/pos/offline/reversalLocalStore'
import './lib/pos/offline/saleIntentJournalStore'
import './lib/pos/offline/shiftOpenIntentStore'
import './lib/pos/offline/shiftCloseIntentStore'
import './lib/pos/offline/activeCartSnapshotStore'
import './lib/pos/offline/saleSubmissionEvidenceStore'
import './lib/pos/suspendedBills'

function renderStartupFailure(message: string) {
  const root = document.getElementById('root')
  if (!root) return
  root.textContent = `Twinpet POS cannot start: ${message}`
}

function renderApp() {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AuthProvider>
        <App />
      </AuthProvider>
    </StrictMode>,
  )
}

void bootNativeDurableStore()
  .then(async () => {
    if (isDurableStartupBlocked()) {
      renderStartupFailure(getDurableBootError() ?? 'durable store is unusable')
      return
    }
    await initDeviceIdentity()
    renderApp()
  })
  .catch((err) => {
    renderStartupFailure(err instanceof Error ? err.message : String(err))
  })
