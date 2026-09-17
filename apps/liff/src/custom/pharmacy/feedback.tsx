import { useEffect, useRef, type ReactNode } from 'react';

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

const MAX_AUTO_RETRIES = 2;

/**
 * Auto-retries an idempotent load when it fails, with backoff (3s, 6s).
 * `failures` is a counter the page increments in its load catch and resets on
 * success. Never wire this to submit/mutation paths — loads only.
 */
export function usePharmacyAutoRetry(failures: number, retry: () => void): void {
  const attempts = useRef(0);
  useEffect(() => {
    if (failures === 0) {
      attempts.current = 0;
      return;
    }
    if (attempts.current >= MAX_AUTO_RETRIES) return;
    attempts.current += 1;
    const timer = window.setTimeout(retry, 3000 * attempts.current);
    return () => window.clearTimeout(timer);
  }, [failures, retry]);
}

export function PharmacyErrorSummary({ items, title = '入力内容を確認してください' }: {
  items: ReadonlyArray<{ id: string; label: string }>;
  title?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.scrollIntoView({ block: 'nearest' });
  }, []);
  return <div ref={ref} tabIndex={-1} role="alert"
    className="rounded-lg border-2 border-red-300 bg-red-50 p-4 text-base focus:outline-none">
    <p className="font-bold text-red-800">{title}</p>
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
  useEffect(() => {
    if (!onMountFocus || !ref.current) return;
    ref.current.focus();
    ref.current.scrollIntoView({ block: 'nearest' });
  }, [onMountFocus]);
  const toneClass = tone === 'success'
    ? 'border-green-200 bg-green-50 text-green-800'
    : tone === 'error'
      ? 'border-red-200 bg-red-50 text-red-800'
      : 'border-amber-300 bg-amber-50 text-amber-900';
  return <div ref={ref} tabIndex={-1}
    role={tone === 'error' ? 'alert' : 'status'}
    className={`rounded-lg border p-4 text-base focus:outline-none ${toneClass} ${className}`}>
    {children}
  </div>;
}
