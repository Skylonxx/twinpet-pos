import type { FilePort } from '../../ports/filePort';

/**
 * Browser text export via Blob + object URL + `<a download>`, matching the
 * existing in-app CSV download mechanism. Unwired in Phase A.
 */
export function createBrowserFilePort(): FilePort {
  return {
    saveTextFile(name: string, mime: string, contents: string): void {
      if (typeof document === 'undefined' || typeof URL === 'undefined') return;
      const blob = new Blob([contents], { type: mime });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    },
  };
}
