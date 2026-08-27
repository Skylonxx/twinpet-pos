/** Browser-equivalent print dialog capability. No native/ESC-POS concepts. */

export interface PrintPort {
  print(): void;
}
