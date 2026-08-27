import type {
  ConnectivityEventType,
  ConnectivityListener,
  ConnectivityPort,
} from '../../ports/connectivityPort';

function liveNavigator(): Navigator | undefined {
  return typeof navigator !== 'undefined' ? navigator : undefined;
}

/**
 * Browser connectivity adapter. Reads the real Navigator and window online/offline
 * events — the same sources `syncOrchestrator.resolveDeps()` already defaults to.
 */
export function createBrowserConnectivityPort(): ConnectivityPort {
  const addEventListener = (type: ConnectivityEventType, listener: ConnectivityListener): void => {
    if (typeof window !== 'undefined') window.addEventListener(type, listener);
  };
  const removeEventListener = (
    type: ConnectivityEventType,
    listener: ConnectivityListener,
  ): void => {
    if (typeof window !== 'undefined') window.removeEventListener(type, listener);
  };

  return {
    isOnline(): boolean {
      return liveNavigator()?.onLine !== false;
    },
    subscribe(type: ConnectivityEventType, listener: ConnectivityListener): () => void {
      addEventListener(type, listener);
      return () => removeEventListener(type, listener);
    },
    addEventListener,
    removeEventListener,
    getNavigator: liveNavigator,
  };
}

export type BrowserSyncOrchestratorConnectivityDeps = {
  navigatorRef: Navigator | undefined;
  addEventListener: (type: ConnectivityEventType, listener: ConnectivityListener) => void;
  removeEventListener: (type: ConnectivityEventType, listener: ConnectivityListener) => void;
};

function buildBrowserSyncOrchestratorDeps(
  port: ConnectivityPort = createBrowserConnectivityPort(),
): BrowserSyncOrchestratorConnectivityDeps {
  return {
    navigatorRef: port.getNavigator(),
    addEventListener: (type, listener) => port.addEventListener(type, listener),
    removeEventListener: (type, listener) => port.removeEventListener(type, listener),
  };
}

let cachedOrchestratorDeps: BrowserSyncOrchestratorConnectivityDeps | undefined;

/** Stable existing `SyncOrchestratorDeps` connectivity slice for the AppShell seam. */
export function createBrowserSyncOrchestratorDeps(): BrowserSyncOrchestratorConnectivityDeps {
  cachedOrchestratorDeps ??= buildBrowserSyncOrchestratorDeps();
  return cachedOrchestratorDeps;
}

/** @internal test-only */
export function __resetBrowserSyncOrchestratorDepsForTests(): void {
  cachedOrchestratorDeps = undefined;
}
