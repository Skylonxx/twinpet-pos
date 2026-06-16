import { useToast } from './use-toast';
import { Toast } from './toast';

// UI-12: <Toaster /> is the ONLY subscriber to toast state. It renders at most one
// toast (the store enforces MAX_VISIBLE_TOASTS = 1), top-center, with a non-blocking
// container so the POS surface stays interactive — only the toast box itself captures
// pointer events.
export function Toaster() {
  const { toasts } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed left-1/2 top-4 z-[9999] w-[min(92vw,420px)] -translate-x-1/2">
      {toasts.map((t) => (
        <Toast
          key={t.id}
          title={t.title}
          description={t.description}
          variant={t.variant}
        />
      ))}
    </div>
  );
}
