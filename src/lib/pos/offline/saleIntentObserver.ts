import type { AsyncOrder } from '../../types';
import type { SaleIntentJournal } from './saleIntentJournal';

/**
 * Detached, fire-and-forget observation sidecar around the existing `asyncOrders`
 * write. Never awaited by the caller and never a source of truth: it only records
 * what happened to the raw `setDoc` promise it is handed.
 */
export type SaleIntentObserver = {
  observe: (order: Readonly<AsyncOrder>, writePromise: Promise<unknown>) => void;
};

export type SaleIntentObserverDeps = {
  journal: SaleIntentJournal;
};

const PERMISSION_DENIED_CODE = 'permission-denied';

function extractErrorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return 'unknown';
}

/** OFF/no-op observer: the dev / no-Firebase / disabled default. Never touches the journal. */
export function createNoopSaleIntentObserver(): SaleIntentObserver {
  return {
    observe: () => {
      // intentionally inert
    },
  };
}

/**
 * Real observer. Every journal call is best-effort/fail-open — a journal failure
 * must never throw back into the checkout path. `markServerAcknowledged` /
 * `markRejectedByRules` are only attempted after the enqueue+flush sequence has
 * settled, so a still-pending enqueue can't race a fast promise settle into a
 * spurious `not_found` transition.
 */
export function createSaleIntentObserver(deps: SaleIntentObserverDeps): SaleIntentObserver {
  const { journal } = deps;

  function observe(order: Readonly<AsyncOrder>, writePromise: Promise<unknown>): void {
    const prepared = (async () => {
      try {
        await journal.enqueueSaleIntent({ order, payloadPolicy: 'redacted' });
        await journal.markFlushedToCache(order.id);
      } catch {
        // fail open — enqueue/flush observation is best-effort only.
      }
    })();

    writePromise.then(
      () => {
        void prepared.then(() => journal.markServerAcknowledged(order.id)).catch(() => {});
      },
      (err: unknown) => {
        void prepared
          .then(async () => {
            if (extractErrorCode(err) === PERMISSION_DENIED_CODE) {
              await journal.markRejectedByRules(order.id, err);
            } else {
              // transitionStatus carries no caller details; recordSaleIntentEvent
              // then attaches the fixed-key detail event against the new status.
              await journal.transitionStatus(order.id, 'exception_observed');
              await journal.recordSaleIntentEvent(order.id, 'exception_observed', {
                phase: 'observe',
                errorCode: extractErrorCode(err),
              });
            }
          })
          .catch(() => {});
      },
    );
  }

  return { observe };
}
