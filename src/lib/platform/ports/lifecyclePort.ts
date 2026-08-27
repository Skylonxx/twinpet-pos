/**
 * Browser page/document visibility lifecycle only.
 * No native resume/pause/quit plugin semantics.
 */

export type BrowserLifecycleState = 'visible' | 'hidden';

export type LifecycleListener = (state: BrowserLifecycleState) => void;

export interface LifecyclePort {
  getState(): BrowserLifecycleState | 'unknown';
  subscribe(listener: LifecycleListener): () => void;
}
