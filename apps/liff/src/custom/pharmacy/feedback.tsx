import { useEffect, useRef, useState, type ReactNode } from 'react';

export function PharmacySpinner({ label }: { label?: string }) {
  return <span className="inline-flex items-center gap-2">
    <span className="pharmacy-spinner" aria-hidden="true" />
    {label !== undefined ? <span>{label}</span> : null}
  </span>;
}

export function PharmacySkeletonLines({ lines = 3 }: { lines?: number }) {
  return <div className="pharmacy-card space-y-3 p-4" aria-hidden="true">
    {Array.from({ length: lines }, (_, i) => (
      <div key={i} className="pharmacy-skeleton h-5" style={{ width: i === lines - 1 ? '60%' : '100%' }} />
    ))}
  </div>;
}

export function PharmacyLoading({ label, lines = 3 }: { label: string; lines?: number }) {
  return <div role="status">
    <span className="sr-only">{label}</span>
    <PharmacySkeletonLines lines={lines} />
  </div>;
}

const AUTO_RETRY_DELAYS_MS = [3000, 6000] as const;

/** Backoff for the next retry, or null once the retry budget is spent. */
export function nextAutoRetryDelay(attemptsMade: number): number | null {
  return attemptsMade < AUTO_RETRY_DELAYS_MS.length
    ? AUTO_RETRY_DELAYS_MS[attemptsMade]
    : null;
}

/**
 * Auto-retries ONE idempotent load when it fails, with backoff (3s, 6s).
 * Call once per load — `failures` is a counter the page increments in that
 * load's catch and resets on success. The attempt counter is only consumed
 * when the timer actually fires, so StrictMode's dev double-mount cannot
 * double-spend the retry budget. Never wire this to submit/mutation paths.
 */
export function usePharmacyAutoRetry(failures: number, retry: () => void): void {
  const attempts = useRef(0);
  const retryRef = useRef(retry);
  useEffect(() => { retryRef.current = retry; });
  useEffect(() => {
    if (failures === 0) {
      attempts.current = 0;
      return;
    }
    const delay = nextAutoRetryDelay(attempts.current);
    if (delay === null) return;
    const timer = window.setTimeout(() => {
      attempts.current += 1;
      retryRef.current();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [failures]);
}

/**
 * Tracks browser connectivity. `onReconnect` fires on the offline→online
 * transition only and must be an idempotent READ — never a form submit, image
 * upload, or any mutation (a reconnect must not send anything on its own).
 */
export function usePharmacyOnline(onReconnect?: () => void): boolean {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  const onReconnectRef = useRef(onReconnect);
  useEffect(() => { onReconnectRef.current = onReconnect; });
  useEffect(() => {
    const markOffline = () => setOnline(false);
    const markOnline = () => {
      setOnline(true);
      onReconnectRef.current?.();
    };
    window.addEventListener('offline', markOffline);
    window.addEventListener('online', markOnline);
    return () => {
      window.removeEventListener('offline', markOffline);
      window.removeEventListener('online', markOnline);
    };
  }, []);
  return online;
}

export function PharmacyOfflineBanner({ online }: { online: boolean }) {
  if (online) return null;
  return <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-base text-amber-900">
    通信が切れています。電波のよい場所で再度お試しください。入力中の内容はこの画面に残っています。
  </p>;
}

export function PharmacyErrorSummary({ items, title = '入力内容を確認してください', hint }: {
  items: ReadonlyArray<{ id: string; label: string }>;
  title?: string;
  /** Optional patient-facing instruction shown under the title. */
  hint?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.scrollIntoView({ block: 'nearest' });
  }, []);
  // No role="alert": moving focus is the single announcement channel. A live
  // region that also takes focus is spoken twice by screen readers.
  return <div ref={ref} tabIndex={-1}
    className="rounded-lg border-2 border-red-300 bg-red-50 p-4 text-base focus:outline-none">
    <p className="font-bold text-red-800">{title}</p>
    {hint && <p className="mt-1 text-base text-red-800">{hint}</p>}
    <ul className="mt-2 list-disc space-y-1 pl-5 text-red-800">
      {items.map((item) => <li key={`${item.id}:${item.label}`}>
        <button type="button" onClick={() => {
          const target = document.getElementById(item.id);
          target?.scrollIntoView({ block: 'center' });
          target?.focus();
        }} className="pharmacy-control min-h-11 font-bold underline">{item.label}</button>
      </li>)}
    </ul>
  </div>;
}

export function PharmacyStatusBlock({ tone, onMountFocus = true, children, className = '' }: {
  tone: 'success' | 'error' | 'info';
  onMountFocus?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // One announcement channel per tone: success/info announce via the polite
  // live region and only scroll into view (focusing a live region makes screen
  // readers speak it twice); error announces via focus, so it carries no live
  // region role.
  const isError = tone === 'error';
  useEffect(() => {
    if (!ref.current) return;
    if (isError && onMountFocus) ref.current.focus();
    ref.current.scrollIntoView({ block: 'nearest' });
  }, [isError, onMountFocus]);
  const toneClass = tone === 'success'
    ? 'border-green-200 bg-green-50 text-green-800'
    : isError
      ? 'border-red-200 bg-red-50 text-red-800'
      : 'border-amber-300 bg-amber-50 text-amber-900';
  return <div ref={ref} tabIndex={isError ? -1 : undefined}
    role={isError ? undefined : 'status'}
    className={`rounded-lg border p-4 text-base focus:outline-none ${toneClass} ${className}`}>
    {children}
  </div>;
}
