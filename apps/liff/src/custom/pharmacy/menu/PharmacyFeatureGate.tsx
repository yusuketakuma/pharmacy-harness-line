import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getLiffId } from '../../../lib/liff-auth.js';
import { requestPharmacyJson } from '../request.js';
import { pharmacyRoute } from '../navigation.js';

export type PatientFeature = 'prescription_intake' | 'patient_intake' | 'electronic_prescription' |
  'continuity' | 'medication_followup' | 'emergency_contraception' | 'manual_chat' | 'pharmacy_info';

export function canAccessPharmacyFeature(
  enabled: readonly string[],
  existing: readonly string[],
  capability: PatientFeature,
  allowExisting: boolean,
): boolean {
  return enabled.includes(capability) || (allowExisting && existing.includes(capability));
}

export default function PharmacyFeatureGate({
  capability,
  allowExisting = false,
  children,
}: {
  capability: PatientFeature;
  allowExisting?: boolean;
  children: ReactNode;
}) {
  const [access, setAccess] = useState<'loading' | 'allowed' | 'disabled' | 'error'>('loading');

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const base = import.meta.env.VITE_API_BASE ?? '';
        const response = await fetch(`${base}/api/liff/config?liffId=${encodeURIComponent(getLiffId())}`, { cache: 'no-store' });
        const body = await response.json() as { success?: boolean; data?: { enabledFeatures?: unknown } };
        if (!response.ok || !body.success || !Array.isArray(body.data?.enabledFeatures)) throw new Error('invalid LIFF config');
        const enabled = body.data.enabledFeatures.filter((value): value is string => typeof value === 'string');
        if (enabled.includes(capability)) {
          if (current) setAccess('allowed');
          return;
        }
        if (!allowExisting) {
          if (current) setAccess('disabled');
          return;
        }
        const projection = await requestPharmacyJson<{ data: { existingFeatures: string[] } }>(
          '/api/liff/pharmacy/feature-access', '機能利用状況の取得',
        );
        if (current) setAccess(canAccessPharmacyFeature(enabled, projection.data.existingFeatures, capability, true)
          ? 'allowed' : 'disabled');
      } catch {
        if (current) setAccess('error');
      }
    })();
    return () => { current = false; };
  }, [allowExisting, capability]);

  if (access === 'allowed') return children;
  return <main className="mx-auto min-h-screen max-w-md bg-gray-50 p-6 text-center">
    {access === 'loading'
      ? <p className="py-12 text-sm text-gray-600">利用状況を確認しています...</p>
      : <>
          <h1 className="mt-8 text-xl font-bold text-gray-950">この機能は現在利用できません</h1>
          <p className="mt-3 text-sm leading-6 text-gray-600">
            {access === 'error' ? '利用状況を確認できませんでした。LINEから開き直してください。' : 'この薬局では現在、この機能を受け付けていません。'}
          </p>
          <Link className="mt-6 inline-flex min-h-11 items-center rounded-xl bg-green-700 px-5 font-bold text-white" to={pharmacyRoute('/pharmacy/menu', getLiffId())}>
            すべての機能へ戻る
          </Link>
        </>}
  </main>;
}
