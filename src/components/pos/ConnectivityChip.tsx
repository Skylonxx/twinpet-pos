import { useEffect, useState } from 'react';
import './ConnectivityChip.css';

// Packet 6 · Connectivity chip. Presentational only — reflects the browser's
// own `navigator.onLine` signal so the cashier always knows the network state
// of THIS terminal. Never blocks a sale and never claims a durability
// guarantee either way; offline copy only reassures that selling can continue.

function readOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

export default function ConnectivityChip() {
  const [online, setOnline] = useState(readOnline);

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (online) {
    return (
      <div
        className="p6cc-chip p6cc-chip--online"
        role="status"
        data-testid="p6cc-chip"
        title="เชื่อมต่ออินเทอร์เน็ตอยู่"
      >
        <i className="ti ti-wifi" aria-hidden="true" />
        <span>ออนไลน์</span>
      </div>
    );
  }

  return (
    <div
      className="p6cc-chip p6cc-chip--offline"
      role="status"
      aria-live="polite"
      data-testid="p6cc-chip"
      title="ไม่มีอินเทอร์เน็ต — ยังขายต่อได้ตามปกติในเครื่องนี้"
    >
      <i className="ti ti-wifi-off" aria-hidden="true" />
      {/* Packet 6 UX fix: keep the "can still sell" reassurance but compact it so
          the header status cluster no longer overflows on tablet widths. The
          reassurance drops to icon + "ออฟไลน์" on narrow screens (full copy stays
          in the title tooltip and the aria label below for confidence). */}
      <span>ออฟไลน์</span>
      <span className="p6cc-note"> · ขายต่อได้</span>
    </div>
  );
}
