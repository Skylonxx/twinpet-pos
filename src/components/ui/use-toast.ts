import { useState, useEffect } from 'react';

export type ToastVariant = 'default' | 'destructive' | 'warning' | 'success';

export interface ToastProps {
  id: string;
  title: string;
  description?: string;
  variant?: ToastVariant;
  duration?: number;
}

// UI-12: a POS terminal must never show a vertical pile of toasts (rapid scanner
// errors used to stack and block the screen). The store keeps at most one visible
// toast; a new toast replaces the current one, and an identical toast just refreshes
// the dismiss timer instead of re-rendering a duplicate box.
const MAX_VISIBLE_TOASTS = 1;

let memoryState: ToastProps[] = [];
let listeners: ((state: ToastProps[]) => void)[] = [];
let dismissTimer: ReturnType<typeof setTimeout> | null = null;

function emit() {
  listeners.forEach((listener) => listener(memoryState));
}

function clearDismissTimer() {
  if (dismissTimer) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
}

function scheduleDismiss(id: string, duration: number) {
  clearDismissTimer();
  if (duration === Infinity) return;
  dismissTimer = setTimeout(() => {
    dismissTimer = null;
    dismiss(id);
  }, duration);
}

function dismiss(id: string) {
  const next = memoryState.filter((t) => t.id !== id);
  if (next.length !== memoryState.length) {
    memoryState = next;
    emit();
  }
}

function isSameContent(current: ToastProps, incoming: Omit<ToastProps, 'id'>): boolean {
  return (
    current.title === incoming.title &&
    current.description === incoming.description &&
    (current.variant ?? 'default') === (incoming.variant ?? 'default')
  );
}

/**
 * Stable, module-level dispatcher. Calling it never subscribes the caller to the
 * toast array — only the <Toaster /> reads `toasts` (via `useToast`). POS code must
 * use this (directly or through `useToastDispatcher`) so it does not re-render on
 * every toast add/dismiss.
 */
export function toast({
  title,
  description,
  variant = 'default',
  duration = 3000,
}: Omit<ToastProps, 'id'>): string {
  const incoming = { title, description, variant, duration };
  const current = memoryState[0];

  // Identical toast already on screen → just refresh its timer (dedupe), no re-render churn.
  if (current && isSameContent(current, incoming)) {
    scheduleDismiss(current.id, duration);
    return current.id;
  }

  // Otherwise the new toast REPLACES whatever is visible (max one).
  const id = Math.random().toString(36).slice(2, 11);
  const newToast: ToastProps = { id, title, description, variant, duration };
  memoryState = [newToast].slice(0, MAX_VISIBLE_TOASTS);
  emit();
  scheduleDismiss(id, duration);
  return id;
}

/**
 * Non-subscribing accessor for the stable dispatcher. Returns only `toast`, so a
 * component using it does NOT re-render when toast state changes.
 */
export function useToastDispatcher() {
  return toast;
}

/**
 * Subscribing reader — intended for <Toaster /> only. Components that render POS UI
 * must NOT call this, because it re-renders on every toast change.
 */
export function useToast() {
  const [toasts, setToasts] = useState<ToastProps[]>(memoryState);

  useEffect(() => {
    listeners.push(setToasts);
    setToasts(memoryState);
    return () => {
      const index = listeners.indexOf(setToasts);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    };
  }, []);

  return { toasts, toast };
}
