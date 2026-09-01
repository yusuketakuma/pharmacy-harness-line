import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import packageJson from '../../../package.json';
import { getLiffId } from '../../lib/liff-auth.js';
import { pharmacyRoute } from './navigation.js';
import { requestPharmacyJson } from './request.js';

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
  retry: () => Promise<void>;
};

const PharmacyAccessContext = createContext<PharmacyAccessState>({
  accountName: '', enabledFeatures: [], existingFeatures: [], existingError: '',
  loading: true, configError: '', retry: async () => {},
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
    loading: true, configError: '',
  });
  const loadingRef = useRef(false);
  const mounted = useRef(true);

  const retry = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setAccess((current) => ({ ...current, loading: true, configError: '', existingError: '' }));
    try {
      const loaded = await loadPharmacyAccess();
      if (mounted.current) setAccess({ ...loaded, loading: false, configError: '' });
    } catch {
      if (mounted.current) setAccess((current) => ({
        ...current,
        loading: false,
        configError: '機能一覧を取得できませんでした。',
      }));
    } finally {
      loadingRef.current = false;
    }
  }, []);

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
        <p className="truncate text-sm font-bold text-green-800">{accountName || '薬局'}</p>
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
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (access.configError || access.existingError) alertRef.current?.focus();
  }, [access.configError, access.existingError]);

  return <div className="pharmacy-shell mx-auto max-w-md">
    <PharmacyShellHeader accountName={access.accountName} screenTitle={screenTitle} />
    {access.loading
          ? <section aria-labelledby="pharmacy-loading-title" className="p-6 text-center">
          <h2 id="pharmacy-loading-title" className="sr-only">{screenTitle}</h2>
            <p role="status" className="py-8 text-base text-gray-700">利用状況を確認しています...</p>
        </section>
      : access.configError
        ? <div ref={alertRef} tabIndex={-1} role="alert" className="m-4 rounded-xl bg-red-50 p-4 text-base text-red-800">
            <p>{access.configError} 通信状態を確認して再試行してください。</p>
            <button type="button" onClick={() => void access.retry()} className="pharmacy-control min-h-11 mt-3 rounded-lg border border-red-300 bg-white px-4 py-2 font-bold">再試行</button>
          </div>
        : <>
            {access.existingError && <div ref={alertRef} tabIndex={-1} role="alert" className="m-4 rounded-xl bg-amber-50 p-4 text-base text-amber-900">
              <p>{access.existingError} 有効な機能はそのまま利用できます。</p>
              <button type="button" onClick={() => void access.retry()} className="pharmacy-control min-h-11 mt-3 rounded-lg border border-amber-300 bg-white px-4 py-2 font-bold">再試行</button>
            </div>}
            {children}
          </>}
  </div>;
}
