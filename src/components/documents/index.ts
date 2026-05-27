export { default as ThermalReceipt } from './ThermalReceipt';
export { default as A4Invoice } from './A4Invoice';
export type {
  A4DocType,
  A4InvoiceProps,
  BranchDocumentSettings,
  ThermalReceiptMode,
  ThermalReceiptProps,
} from '../../lib/documents/types';
export {
  A4_DOC_TYPES,
  DEFAULT_BRANCH_DOCUMENT_SETTINGS,
  mergeBranchDocumentSettings,
} from '../../lib/documents/types';
