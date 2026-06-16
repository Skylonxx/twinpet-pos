import type { ToastProps, ToastVariant } from './use-toast';

// UI-12 Flowbite-style soft variants. No emoji icons — the glyph is a clean inline SVG
// rendered by the component, so message strings stay text-only (no double icons).
const containerStyles: Record<ToastVariant, string> = {
  default: 'bg-white text-gray-800 border border-gray-200',
  destructive: 'bg-red-50 text-red-800 border border-red-200 border-l-4 border-l-red-500',
  warning: 'bg-yellow-50 text-yellow-800 border border-yellow-200 border-l-4 border-l-yellow-400',
  success: 'bg-green-50 text-green-800 border border-green-200 border-l-4 border-l-green-500',
};

const iconWrapStyles: Record<ToastVariant, string> = {
  default: 'bg-gray-100 text-gray-500',
  destructive: 'bg-red-100 text-red-500',
  warning: 'bg-yellow-100 text-yellow-500',
  success: 'bg-green-100 text-green-500',
};

function ToastIcon({ variant }: { variant: ToastVariant }) {
  const common = 'h-5 w-5';
  switch (variant) {
    case 'destructive':
      return (
        <svg className={common} aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 20 20">
          <path d="M10 .5a9.5 9.5 0 1 0 9.5 9.5A9.51 9.51 0 0 0 10 .5Zm3.707 11.793a1 1 0 1 1-1.414 1.414L10 11.414l-2.293 2.293a1 1 0 0 1-1.414-1.414L8.586 10 6.293 7.707a1 1 0 0 1 1.414-1.414L10 8.586l2.293-2.293a1 1 0 0 1 1.414 1.414L11.414 10l2.293 2.293Z" />
        </svg>
      );
    case 'warning':
      return (
        <svg className={common} aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 20 20">
          <path d="M10 .5a9.5 9.5 0 1 0 9.5 9.5A9.51 9.51 0 0 0 10 .5ZM10 15a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm1-4a1 1 0 0 1-2 0V6a1 1 0 0 1 2 0v5Z" />
        </svg>
      );
    case 'success':
      return (
        <svg className={common} aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 20 20">
          <path d="M10 .5a9.5 9.5 0 1 0 9.5 9.5A9.51 9.51 0 0 0 10 .5Zm3.707 8.207-4 4a1 1 0 0 1-1.414 0l-2-2a1 1 0 0 1 1.414-1.414L9 10.586l3.293-3.293a1 1 0 0 1 1.414 1.414Z" />
        </svg>
      );
    case 'default':
    default:
      return (
        <svg className={common} aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 20 20">
          <path d="M10 .5a9.5 9.5 0 1 0 9.5 9.5A9.51 9.51 0 0 0 10 .5ZM9 6a1 1 0 1 1 2 0 1 1 0 0 1-2 0Zm2 8a1 1 0 0 1-2 0V9a1 1 0 0 1 2 0v5Z" />
        </svg>
      );
  }
}

// UI-13: the description is a `\n`-joined structured string built in useCart (use-toast.ts
// types it as string, so it can't be a React node). Both Strict Block and Warning Pass share
// ONE layout: line 1 = product name (normal), the `คงเหลือ:` remaining-stock line is rendered
// visually distinct (bold/darker), and any further line (the strict-only explanation) is
// smaller/lighter. Only the semantic color + icon differ between variants.
function ToastDescription({ description }: { description: string }) {
  const lines = description.split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  return (
    <div className="mt-1 flex flex-col gap-0.5">
      {lines.map((line, index) => {
        const isRemaining = line.startsWith('คงเหลือ:');
        const className = isRemaining
          ? 'text-sm font-semibold'
          : index === 0
            ? 'text-sm font-normal opacity-90'
            : 'text-xs font-normal opacity-80';
        return (
          <span key={index} className={className}>
            {line}
          </span>
        );
      })}
    </div>
  );
}

export function Toast({ title, description, variant = 'default' }: Omit<ToastProps, 'id'>) {
  return (
    <div
      className={`pointer-events-auto flex w-full max-w-[400px] items-start gap-3 rounded-lg p-4 shadow-md ${containerStyles[variant]}`}
      role="status"
      aria-live="polite"
    >
      <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${iconWrapStyles[variant]}`}>
        <ToastIcon variant={variant} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{title}</div>
        {description && <ToastDescription description={description} />}
      </div>
    </div>
  );
}
