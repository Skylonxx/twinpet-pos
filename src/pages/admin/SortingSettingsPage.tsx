import { SortingSettingsContent } from '../../components/pos/SortingSettingsModal';

/**
 * Admin route wrapper (/admin/sorting). The full feature now lives in the
 * reusable `SortingSettingsContent` (also embedded as a modal in the POS screen).
 */
export default function SortingSettingsPage() {
  return <SortingSettingsContent />;
}
