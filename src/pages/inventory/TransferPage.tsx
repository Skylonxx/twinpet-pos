import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import BranchTransferPage from './BranchTransferPage';
import TransferHistoryPage from './TransferHistoryPage';

type View = 'list' | 'create';

/**
 * Single transfer hub for the POS side (`/inventory/transfer`).
 *
 * Defaults to the history list and switches to the create form in-place — one
 * entry point instead of the old split between `/inventory/transfer` (create)
 * and `/inventory/transfer/history` (list). Returning to the list remounts the
 * history view, so a freshly-created transfer is fetched and shown.
 */
export default function TransferPage() {
  const navigate = useNavigate();
  const [view, setView] = useState<View>('list');

  if (view === 'create') {
    return <BranchTransferPage onExit={() => setView('list')} />;
  }

  return (
    <TransferHistoryPage
      onCreateNew={() => setView('create')}
      onBack={() => navigate('/inventory')}
    />
  );
}
