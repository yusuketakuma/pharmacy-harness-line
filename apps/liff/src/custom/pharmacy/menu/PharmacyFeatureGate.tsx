import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { getLiffId } from '../../../lib/liff-auth.js';
import { pharmacyRoute } from '../navigation.js';
import { usePharmacyAccess } from '../PharmacyShell.js';

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
  const pharmacy = usePharmacyAccess();
  const access = pharmacy.loading || pharmacy.configError
    ? 'loading'
    : pharmacy.enabledFeatures.includes(capability)
      ? 'allowed'
      : allowExisting && pharmacy.existingError
        ? 'error'
        : canAccessPharmacyFeature(
          pharmacy.enabledFeatures, pharmacy.existingFeatures, capability, allowExisting,
        ) ? 'allowed' : 'disabled';

  if (access === 'allowed') return children;
  return <section className="p-6 text-center pharmacy-supplemental" aria-labelledby="pharmacy-feature-state-title">
    {access === 'loading'
      ? <p className="py-12 text-base text-gray-700">利用状況を確認しています...</p>
      : <>
          <h2 id="pharmacy-feature-state-title" className="mt-8 text-xl font-bold text-gray-950">{access === 'error' ? '利用状況を確認できません' : 'この機能は現在利用できません'}</h2>
          <p className="mt-3 text-base leading-6 text-gray-700">
            {access === 'error' ? '利用中の記録があるか確認できませんでした。再試行してください。' : 'この薬局では現在、この機能を受け付けていません。'}
          </p>
          <Link className="pharmacy-control pharmacy-focus mt-6 inline-flex min-h-11 items-center rounded-xl bg-green-700 px-5 font-bold text-white" to={pharmacyRoute('/pharmacy/menu', getLiffId())}>
            すべての機能へ戻る
          </Link>
        </>}
  </section>;
}
