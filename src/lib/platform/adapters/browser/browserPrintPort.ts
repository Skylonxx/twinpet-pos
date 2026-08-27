import type { PrintPort } from '../../ports/printPort';

/** Delegates to the current browser print dialog (`window.print()`). */
export function createBrowserPrintPort(): PrintPort {
  return {
    print(): void {
      if (typeof window !== 'undefined' && typeof window.print === 'function') {
        window.print();
      }
    },
  };
}
