// TRA-409 — user-facing toast notifications.
//
// Acceptance for TRA-409 requires "every async action shows success/failure
// feedback". This provides a small, dependency-free toast system: wrap the app
// in <ToastProvider>, render <ToastViewport/> once, and call useToast() from any
// component to surface success / error feedback after an async action.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

export interface ToastApi {
  /** Show a toast and return its id. */
  show: (kind: ToastKind, message: string, durationMs?: number) => number;
  success: (message: string, durationMs?: number) => number;
  error: (message: string, durationMs?: number) => number;
  info: (message: string, durationMs?: number) => number;
  dismiss: (id: number) => void;
}

/** Default auto-dismiss windows. Errors linger longer so they are not missed. */
const DEFAULT_DURATION: Record<ToastKind, number> = {
  success: 4000,
  info: 5000,
  error: 8000,
};

interface ToastState {
  toasts: readonly Toast[];
  api: ToastApi;
}

const ToastContext = createContext<ToastState | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const show = useCallback((kind: ToastKind, message: string, durationMs?: number) => {
    const id = nextId.current++;
    setToasts(prev => [...prev, { id, kind, message }]);
    const ms = durationMs ?? DEFAULT_DURATION[kind];
    if (ms > 0 && ms !== Infinity) {
      timers.current.set(id, setTimeout(() => dismiss(id), ms));
    }
    return id;
  }, [dismiss]);

  const api = useMemo<ToastApi>(() => ({
    show,
    success: (message, durationMs) => show('success', message, durationMs),
    error: (message, durationMs) => show('error', message, durationMs),
    info: (message, durationMs) => show('info', message, durationMs),
    dismiss,
  }), [show, dismiss]);

  const value = useMemo<ToastState>(() => ({ toasts, api }), [toasts, api]);

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

/** Access the toast API. Throws if used outside <ToastProvider>. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx.api;
}

/**
 * Render the live toast stack. Place this once near the app root, inside
 * <ToastProvider>. Each toast is an alert region so assistive tech announces it.
 */
export function ToastViewport() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('ToastViewport must be used within <ToastProvider>');
  const { toasts, api } = ctx;
  if (toasts.length === 0) return null;
  return (
    <div className="toast-viewport" aria-live="polite" aria-atomic="false">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`toast toast-${t.kind}`}
          role={t.kind === 'error' ? 'alert' : 'status'}
        >
          <span className="toast-message">{t.message}</span>
          <button
            type="button"
            className="toast-dismiss"
            aria-label="Dismiss notification"
            onClick={() => api.dismiss(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
