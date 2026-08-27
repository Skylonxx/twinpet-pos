import type {
  BrowserLifecycleState,
  LifecycleListener,
  LifecyclePort,
} from '../../ports/lifecyclePort';

function readVisibilityState(): BrowserLifecycleState | 'unknown' {
  if (typeof document === 'undefined') return 'unknown';
  return document.visibilityState === 'hidden' ? 'hidden' : 'visible';
}

/** Document visibilitychange only. No native app-lifecycle plugins. */
export function createBrowserLifecyclePort(): LifecyclePort {
  return {
    getState: readVisibilityState,
    subscribe(listener: LifecycleListener): () => void {
      if (typeof document === 'undefined') return () => undefined;
      const onChange = () => {
        const state = readVisibilityState();
        if (state !== 'unknown') listener(state);
      };
      document.addEventListener('visibilitychange', onChange);
      return () => document.removeEventListener('visibilitychange', onChange);
    },
  };
}
