import { useEffect, useState } from 'react';
import { getActiveShift } from '../pos/shiftService';
import type { Shift } from '../types';

export function useActiveShift(branchId: string | null, staffId: string | null) {
  const [activeShift, setActiveShift] = useState<Shift | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!branchId || !staffId) {
      setActiveShift(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    void getActiveShift(branchId, staffId).then((shift) => {
      if (!cancelled) {
        setActiveShift(shift);
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [branchId, staffId]);

  return { activeShift, loading };
}
