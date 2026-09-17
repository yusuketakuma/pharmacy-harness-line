import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import packageJson from '../../../package.json';
import { getLiffId } from '../../lib/liff-auth.js';
import { pharmacyRoute } from './navigation.js';
import { requestPharmacyJson } from './request.js';
import { PharmacyLoading, PharmacyOfflineBanner, PharmacySpinner, usePharmacyAutoRetry, usePharmacyOnline } from './feedback.js';

export const pharmacyLiffVersion = packageJson.version;

type PharmacyAccess = {
  accountName: string;
  enabledFeatures: string[];
  existingFeatures: string[];
  existingError: string;
};

type PharmacyAccessState = PharmacyAccess & {
  loading: boolean;
  configError: string;
  /** A refresh is running while children stay mounted. */
  retrying: boolean;
  retry: () => Promise<void>;
};

const PharmacyAccessContext = createContext<PharmacyAccessState>({
  accountName: '', enabledFeatures: [], existingFeatures: [], existingError: '',
  loading: true, configError: '', retrying: false, retry: async () => {},
});

export async function loadPharmacyAccess(): Promise<PharmacyAccess> {
  const base = import.meta.env.VITE_API_BASE ?? '';
  const response = await fetch(
    `${base}/api/liff/config?liffId=${encodeURIComponent(getLiffId())}`,
    { cache: 'no-store' },
  );
  const body = await response.json() as {
    success?: boolean;
    data?: { accountName?: unknown; enabledFeatures?: unknown };
  };
  if (!response.ok || !body.success || typeof body.data?.accountName !== 'string' ||
      !Array.isArray(body.data.enabledFeatures)) {
    throw new Error('invalid LIFF config');
  }
  const enabledFeatures = body.data.enabledFeatures
    .filter((value): value is string => typeof value === 'string');
  try {
    const projection = await requestPharmacyJson<{ data: { existingFeatures: unknown } }>(
      '/api/liff/pharmacy/feature-access',
    );
    if (!Array.isArray(projection.data.existingFeatures)) throw new Error('invalid feature access');
    return {
      accountName: body.data.accountName,
      enabledFeatures,
      existingFeatures: projection.data.existingFeatures
        .filter((value): value is string => typeof value === 'string'),
      existingError: '',
    };
  } catch {
    return {
      accountName: body.data.accountName,
      enabledFeatures,
      existingFeatures: [],
      existingError: '利用中の機能を確認できませんでした。',
    };
  }
}

export function PharmacyAccessProvider({ children }: { children: ReactNode }) {
  const [access, setAccess] = useState<Omit<PharmacyAccessState, 'retry'>>({
    accountName: '', enabledFeatures: [], existingFeatures: [], existingError: '',
    loading: true, configError: '', retrying: false,
  });
  const [loadFailures, setLoadFailures] = useState(0);
  const [existingFailures, setExistingFailures] = useState(0);
  const loadingRef = useRef(false);
  const mounted = useRef(true);
  // Once the first load succeeded, children hold live form state — a later
  // retry (manual button, auto-retry, online reconnect) must run in the
  // background and never swap them back to the loading skeleton.
  const loadedOnceRef = useRef(false);

  const retry = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    const preserveChildren = loadedOnceRef.current;
    setAccess((current) => preserveChildren
      ? { ...current, retrying: true }
      : { ...current, loading: true, retrying: true, configError: '', existingError: '' });
    try {
      const loaded = await loadPharmacyAccess();
      if (mounted.current) {
        loadedOnceRef.current = true;
        setAccess({ ...loaded, loading: false, configError: '', retrying: false });
        setLoadFailures(0);
        setExistingFailures(loaded.existingError ? (count) => count + 1 : 0);
      }
    } catch {
      if (mounted.current) {
        setAccess((current) => preserveChildren
          ? { ...current, retrying: false, existingError: '利用中の機能を確認できませんでした。' }
          : { ...current, loading: false, retrying: false, configError: '機能一覧を取得できませんでした。' });
        if (preserveChildren) setExistingFailures((count) => count + 1);
        else setLoadFailures((count) => count + 1);
      }
    } finally {
      loadingRef.current = false;
    }
  }, []);

  usePharmacyAutoRetry(loadFailures, retry);
  // A missing feature-access projection is a degraded read, not a dead end —
  // retry it in the background like any other failed idempotent load.
  usePharmacyAutoRetry(existingFailures, retry);
  // Reconnect refresh is safe here because retry() preserves mounted
  // children; without it a configError after a network drop is a dead end.
  const retryAccess = useCallback(() => { void retry(); }, [retry]);
  usePharmacyOnline(retryAccess);

  useEffect(() => {
    mounted.current = true;
    void retry();
    return () => { mounted.current = false; };
  }, [retry]);

  return <PharmacyAccessContext.Provider value={{ ...access, retry }}>
    {children}
  </PharmacyAccessContext.Provider>;
}

export function usePharmacyAccess(): PharmacyAccessState {
  return useContext(PharmacyAccessContext);
}

export function PharmacyShellHeader({ accountName, screenTitle, liffId }: {
  accountName: string;
  screenTitle: string;
  liffId?: string;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { titleRef.current?.focus(); }, [screenTitle]);
  return <header className="border-b bg-white px-4 py-4">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="break-words text-sm font-bold text-green-800">{accountName || '薬局'}</p>
        <h1 ref={titleRef} tabIndex={-1} className="mt-1 text-xl font-bold text-gray-950 focus:outline-none">{screenTitle}</h1>
      </div>
      <span className="shrink-0 rounded-full bg-gray-100 px-2.5 py-1 text-sm font-bold text-gray-700">
        <span className="sr-only">アプリバージョン </span>v{pharmacyLiffVersion}
      </span>
    </div>
    <Link to={pharmacyRoute('/pharmacy/menu', liffId)} className="pharmacy-control min-h-11 pharmacy-focus mt-3 inline-flex items-center font-bold text-green-800 underline">
      すべての機能へ戻る
    </Link>
  </header>;
}

export function PharmacyShell({ screenTitle, children }: {
  screenTitle: string;
  children: ReactNode;
}) {
  const access = usePharmacyAccess();
  const online = usePharmacyOnline();
  const alertRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const locationKey = location.pathname;
  const scrollKey = `${location.pathname}${location.search}`;
  useEffect(() => { window.scrollTo(0, 0); }, [scrollKey]);
  useEffect(() => {
    document.title = `${screenTitle}｜${access.accountName || '薬局'}`;
  }, [screenTitle, access.accountName]);
  // Banner changes announce themselves by focus — except while the patient
  // is typing: a background retry (auto-retry / reconnect) must not steal
  // focus out of a form field mid-edit.
  useEffect(() => {
    if (!access.configError && !access.existingError) return;
    const active = document.activeElement;
    const typing = active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement;
    if (!typing) alertRef.current?.focus();
  }, [access.configError, access.existingError]);

  return <div className="pharmacy-shell mx-auto max-w-md">
    <PharmacyShellHeader accountName={access.accountName} screenTitle={screenTitle} />
    {!online && <div className="px-4 pt-3"><PharmacyOfflineBanner online={online} /></div>}
    {access.loading
          ? <section aria-labelledby="pharmacy-loading-title" className="p-6">
          <h2 id="pharmacy-loading-title" className="sr-only">{screenTitle}</h2>
            <PharmacyLoading label="利用状況を確認しています..." lines={4} />
        </section>
      : access.configError
        ? <div ref={alertRef} tabIndex={-1} className="m-4 rounded-xl bg-red-50 p-4 text-base text-red-800">
            <p>{access.configError} 通信状態を確認して再試行してください。</p>
            <button type="button" onClick={() => void access.retry()} className="pharmacy-control min-h-11 mt-3 rounded-lg border border-red-300 bg-white px-4 py-2 font-bold">再試行</button>
          </div>
        : <div key={locationKey} className="pharmacy-page-enter">
            {access.existingError && <div ref={alertRef} tabIndex={-1} data-testid="existing-work-error" className="m-4 rounded-xl bg-amber-50 p-4 text-base text-amber-900">
              <p>{access.existingError} 有効な機能はそのまま利用できます。</p>
              <button type="button" onClick={() => void access.retry()} disabled={access.retrying} aria-busy={access.retrying} className="pharmacy-control min-h-11 mt-3 rounded-lg border border-amber-300 bg-white px-4 py-2 font-bold disabled:opacity-50">
                {access.retrying ? <PharmacySpinner label="確認中…" /> : '再試行'}
              </button>
            </div>}
            {children}
          </div>}
  </div>;
}
