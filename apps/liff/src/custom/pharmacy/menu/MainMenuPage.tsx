import liff from '@line/liff';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getLiffId } from '../../../lib/liff-auth.js';
import { pharmacyRoute } from '../navigation.js';
import { pharmacyLiffVersion, usePharmacyAccess } from '../PharmacyShell.js';
import type { PatientFeature } from './PharmacyFeatureGate.js';

const CONSULTATION_MESSAGE = '薬局へ相談';
export const pharmacyAppVersion = pharmacyLiffVersion;

export type PharmacyMenuGroup = '今すぐ行う' | '送信後の確認・フォロー' | '薬局情報・相談';
export const PHARMACY_MENU_GROUPS: readonly PharmacyMenuGroup[] = [
  '今すぐ行う', '送信後の確認・フォロー', '薬局情報・相談',
];

export type PharmacyMenuItem = {
  capability?: PatientFeature;
  allowExisting: boolean;
  label: string;
  description: string;
  icon: string;
  to: string;
  group: PharmacyMenuGroup;
};
type PharmacyMenuItemWithState = PharmacyMenuItem & { isExisting: boolean };

async function loadEnabledPharmacyFeatures(): Promise<string[]> {
  const base = import.meta.env.VITE_API_BASE ?? '';
  const response = await fetch(`${base}/api/liff/config?liffId=${encodeURIComponent(getLiffId())}`, { cache: 'no-store' });
  const body = await response.json() as { success?: boolean; data?: { enabledFeatures?: unknown } };
  if (!response.ok || !body.success || !Array.isArray(body.data?.enabledFeatures)) throw new Error('invalid LIFF config');
  return body.data.enabledFeatures.filter((value): value is string => typeof value === 'string');
}

export function pharmacyMainMenuItems(liffId?: string, enabledFeatures?: readonly string[], existingFeatures: readonly string[] = []): PharmacyMenuItemWithState[] {
  const items = [
    { label: '利用状況', description: '送信やフォローの状態をまとめて確認', icon: '覧', group: '送信後の確認・フォロー', to: pharmacyRoute('/pharmacy/timeline', liffId), allowExisting: true },
    { capability: 'prescription_intake', allowExisting: false, label: '処方せん事前送信', description: '紙の処方せんを撮影して送る', icon: '送', group: '今すぐ行う', to: pharmacyRoute('/prescriptions?view=send', liffId) },
    { capability: 'prescription_intake', allowExisting: true, label: '受付状況', description: '送信した処方せんの状況を確認', icon: '状', group: '送信後の確認・フォロー', to: pharmacyRoute('/prescriptions?view=history', liffId) },
    { capability: 'electronic_prescription', allowExisting: true, label: '電子処方箋', description: '電子処方箋の手続きを始める', icon: '電', group: '今すぐ行う', to: pharmacyRoute('/prescriptions?view=electronic', liffId) },
    { capability: 'patient_intake', allowExisting: true, label: '患者情報・アンケート', description: '患者情報と服薬状況を登録・更新', icon: '問', group: '今すぐ行う', to: pharmacyRoute('/pharmacy/patient-intake', liffId) },
    { capability: 'continuity', allowExisting: true, label: '継続フォロー', description: '次回事前送信のお知らせを確認', icon: '続', group: '送信後の確認・フォロー', to: pharmacyRoute('/pharmacy/continuity', liffId) },
    { capability: 'medication_followup', allowExisting: true, label: '服薬後フォロー', description: 'お薬を使った後の状況を回答', icon: '後', group: '送信後の確認・フォロー', to: pharmacyRoute('/pharmacy/medication-followup', liffId) },
    { capability: 'emergency_contraception', allowExisting: true, label: '緊急避妊薬', description: '対応状況を確認して仮受付へ進む', icon: '緊', group: '今すぐ行う', to: pharmacyRoute('/pharmacy/emergency-contraception', liffId) },
    { capability: 'pharmacy_info', allowExisting: false, label: '薬局情報', description: '営業時間・サービス・アクセスを確認', icon: '店', group: '薬局情報・相談', to: pharmacyRoute('/pharmacy/info', liffId) },
  ] as const satisfies ReadonlyArray<PharmacyMenuItem>;
  return (enabledFeatures === undefined ? items : items.filter((item) =>
    !item.capability || enabledFeatures.includes(item.capability) ||
      (item.allowExisting && existingFeatures.includes(item.capability))))
    .map((item) => ({
      ...item,
      isExisting: Boolean(item.capability && enabledFeatures !== undefined &&
        !enabledFeatures.includes(item.capability) && item.allowExisting &&
        existingFeatures.includes(item.capability)),
    }));
}

export function pharmacyMenuGroups(items: readonly PharmacyMenuItemWithState[]) {
  return PHARMACY_MENU_GROUPS
    .map((group) => ({ group, items: items.filter((item) => item.group === group) }))
    .filter(({ items: groupItems }) => groupItems.length > 0);
}

export async function sendPharmacyConsultation(
  sendMessages: (messages: Array<{ type: 'text'; text: string }>) => Promise<unknown>,
  confirm: (message: string) => boolean,
  isInClient: () => boolean,
  isEnabled: () => Promise<boolean>,
): Promise<boolean> {
  if (!isInClient()) throw new Error('LINE app is required');
  if (!confirm('「薬局へ相談」とトークへ送信します。よろしいですか？')) return false;
  if (!await isEnabled()) throw new Error('manual chat disabled');
  await sendMessages([{ type: 'text', text: CONSULTATION_MESSAGE }]);
  return true;
}

export default function MainMenuPage() {
  const { enabledFeatures, existingFeatures, loading } = usePharmacyAccess();
  const menuItems = pharmacyMainMenuItems(undefined, enabledFeatures, existingFeatures);
  const menuGroups = pharmacyMenuGroups(menuItems);
  const visibleMenuGroups = enabledFeatures.includes('manual_chat') &&
    !menuGroups.some(({ group }) => group === '薬局情報・相談')
    ? [...menuGroups, { group: '薬局情報・相談' as const, items: [] }]
    : menuGroups;
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const sending = useRef(false);

  async function consult() {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setStatus('');
    setError('');
    try {
      const sent = await sendPharmacyConsultation(
        (messages) => liff.sendMessages(messages),
        window.confirm,
        () => liff.isInClient(),
        async () => (await loadEnabledPharmacyFeatures()).includes('manual_chat'),
      );
      if (sent) {
        setSent(true);
        setStatus('トークへ相談メッセージを送りました。');
      } else {
        sending.current = false;
      }
    } catch (err) {
      sending.current = false;
      setError(err instanceof Error && err.message === 'manual chat disabled'
        ? 'この薬局では現在、相談メッセージを受け付けていません。'
        : 'LINEアプリ内で開いて、もう一度お試しください。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="pharmacy-main mx-auto max-w-md">
      <p className="pharmacy-supplemental px-4 pt-4">利用したい機能を選んでください。</p>
      <div className="space-y-6 p-4">
        {loading && <p className="pharmacy-card p-6 text-center text-base">機能一覧を読み込み中...</p>}
        {!loading && menuItems.length === 0 && !enabledFeatures.includes('manual_chat') && (
          <p className="pharmacy-card p-6 text-center pharmacy-supplemental">現在、この薬局で利用できる機能はありません。薬局へ直接お問い合わせください。</p>
        )}
        {!loading && visibleMenuGroups.map(({ group, items }) => (
          <section key={group} aria-labelledby={`pharmacy-menu-${group}`}>
            <h2 id={`pharmacy-menu-${group}`} className="mb-2 text-lg font-bold text-gray-950">{group}</h2>
            <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2">
              {items.map((item) => (
                <Link
                  key={item.label}
                  to={item.to}
                  aria-label={`${item.label}。利用可否：${item.isExisting ? '確認のみ' : '利用できます'}`}
                  className="pharmacy-card pharmacy-focus min-h-11 min-h-32 p-4"
                >
                  <span aria-hidden="true" className="flex size-10 items-center justify-center rounded-full bg-green-50 text-base font-bold text-green-800">{item.icon}</span>
                  <span className="mt-3 flex flex-wrap items-center gap-1 font-bold leading-5 text-gray-950">{item.label}
                    {item.isExisting && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-sm text-amber-900">確認のみ</span>}
                  </span>
                  <span className="mt-1 block text-base leading-6 text-gray-700">{item.description}</span>
                  <span className="mt-2 block text-sm font-bold text-gray-700">利用可否：{item.isExisting ? '確認のみ' : '利用できます'}</span>
                </Link>
              ))}
              {group === '薬局情報・相談' && enabledFeatures.includes('manual_chat') && <button
                type="button"
                onClick={() => void consult()}
                disabled={busy || sent}
                className="pharmacy-card pharmacy-focus min-h-11 min-h-32 p-4 text-left disabled:opacity-50"
              >
                <span aria-hidden="true" className="flex size-10 items-center justify-center rounded-full bg-green-50 text-base font-bold text-green-800">相</span>
                <span className="mt-3 block font-bold leading-5 text-gray-950">薬局へ相談</span>
                <span className="mt-1 block text-base leading-6 text-gray-700">トークへ相談メッセージを送る</span>
                <span className="mt-2 block text-sm font-bold text-gray-700">利用可否：利用できます</span>
              </button>}
            </div>
          </section>
        ))}
      </div>
      {status && <p role="status" className="pharmacy-card mx-4 p-3 text-base text-gray-700">{status}</p>}
      {error && <p role="alert" className="mx-4 rounded-xl bg-red-50 p-3 text-base text-red-800">{error}</p>}
    </main>
  );
}
