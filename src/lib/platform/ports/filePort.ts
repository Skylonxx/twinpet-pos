/** Browser-equivalent text export/download capability. No native filesystem. */

export interface FilePort {
  saveTextFile(name: string, mime: string, contents: string): void;
}
