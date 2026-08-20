import liff from '@line/liff';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import packageJson from '../../../../package.json';
import { getLiffId } from '../../../lib/liff-auth.js';
import { pharmacyRoute } from '../navigation.js';
import { requestPharmacyJson } from '../request.js';
import type { PatientFeature } from './PharmacyFeatureGate.js';

const CONSULTATION_MESSAGE = '薬局へ相談';
export const pharmacyAppVersion = packageJson.version;

async function loadEnabledPharmacyFeatures(): Promise<string[]> {
  const base = import.meta.env.VITE_API_BASE ?? '';
  const response = await fetch(`${base}/api/liff/config?liffId=${encodeURIComponent(getLiffId())}`, { cache: 'no-store' });
  const body = await response.json() as { success?: boolean; data?: { enabledFeatures?: unknown } };
  if (!response.ok || !body.success || !Array.isArray(body.data?.enabledFeatures)) throw new Error('invalid LIFF config');
  return body.data.enabledFeatures.filter((value): value is string => typeof value === 'string');
}

export function pharmacyMainMenuItems(liffId?: string, enabledFeatures?: readonly string[], existingFeatures: readonly string[] = []) {
  const items = [
    { capability: 'prescription_intake', allowExisting: false, label: '処方せん事前送信', description: '紙の処方せんを撮影して送る', icon: '送', to: pharmacyRoute('/prescriptions?view=send', liffId) },
    { capability: 'prescription_intake', allowExisting: true, label: '受付状況', description: '送信した処方せんの状況を確認', icon: '状', to: pharmacyRoute('/prescriptions?view=history', liffId) },
    { capability: 'electronic_prescription', allowExisting: true, label: '電子処方箋', description: '電子処方箋の手続きを始める', icon: '電', to: pharmacyRoute('/prescriptions?view=electronic', liffId) },
    { capability: 'patient_intake', allowExisting: true, label: '患者情報・アンケート', description: '患者情報と服薬状況を登録・更新', icon: '問', to: pharmacyRoute('/pharmacy/patient-intake', liffId) },
    { capability: 'continuity', allowExisting: true, label: '継続フォロー', description: '次回事前送信のお知らせを確認', icon: '続', to: pharmacyRoute('/pharmacy/continuity', liffId) },
    { capability: 'medication_followup', allowExisting: true, label: '服薬後フォロー', description: 'お薬を使った後の状況を回答', icon: '後', to: pharmacyRoute('/pharmacy/medication-followup', liffId) },
    { capability: 'emergency_contraception', allowExisting: true, label: '緊急避妊薬', description: '対応状況を確認して仮受付へ進む', icon: '緊', to: pharmacyRoute('/pharmacy/emergency-contraception', liffId) },
    { capability: 'pharmacy_info', allowExisting: false, label: '薬局情報', description: '営業時間・サービス・アクセスを確認', icon: '店', to: pharmacyRoute('/pharmacy/info', liffId) },
  ] as const satisfies ReadonlyArray<{ capability: PatientFeature; allowExisting: boolean; label: string; description: string; icon: string; to: string }>;
  return enabledFeatures === undefined ? [...items] : items.filter((item) =>
    enabledFeatures.includes(item.capability) || (item.allowExisting && existingFeatures.includes(item.capability)));
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
  const [enabledFeatures, setEnabledFeatures] = useState<string[] | null>(null);
  const [existingFeatures, setExistingFeatures] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const sending = useRef(false);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const enabled = await loadEnabledPharmacyFeatures();
        if (current) setEnabledFeatures(enabled);
        try {
          const projection = await requestPharmacyJson<{ data: { existingFeatures: string[] } }>(
            '/api/liff/pharmacy/feature-access', '機能利用状況の取得',
          );
          if (current) setExistingFeatures(projection.data.existingFeatures);
        } catch { /* Enabled features remain usable when optional history projection fails. */ }
      } catch {
        if (current) {
          setEnabledFeatures([]);
          setError('機能一覧を取得できませんでした。LINEから開き直してください。');
        }
      }
    })();
    return () => { current = false; };
  }, []);

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
    <main className="mx-auto min-h-screen max-w-md bg-gray-50 pb-10">
      <header className="border-b bg-white px-4 py-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold tracking-wide text-green-700">PHARMACY MENU</p>
            <h1 className="mt-1 text-xl font-bold text-gray-950">すべての機能</h1>
          </div>
          <span aria-label={`アプリバージョン v${pharmacyAppVersion}`} className="shrink-0 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-bold text-gray-600">
            v{pharmacyAppVersion}
          </span>
        </div>
        <p className="mt-1 text-sm leading-6 text-gray-600">利用したい機能を選んでください。</p>
      </header>
      <div className="grid grid-cols-2 gap-3 p-4">
        {enabledFeatures === null && <p className="col-span-2 py-8 text-center text-sm text-gray-500">機能一覧を読み込み中...</p>}
        {pharmacyMainMenuItems(undefined, enabledFeatures ?? [], existingFeatures).map((item) => (
          <Link
            key={item.label}
            to={item.to}
            className="min-h-32 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-600"
          >
            <span aria-hidden="true" className="flex size-10 items-center justify-center rounded-full bg-green-50 text-base font-bold text-green-800">{item.icon}</span>
            <span className="mt-3 block font-bold leading-5 text-gray-950">{item.label}</span>
            <span className="mt-1 block text-xs leading-5 text-gray-600">{item.description}</span>
          </Link>
        ))}
        {enabledFeatures?.includes('manual_chat') && <button
          type="button"
          onClick={() => void consult()}
          disabled={busy || sent}
          className="min-h-32 rounded-2xl border border-green-200 bg-green-50 p-4 text-left shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-600 disabled:opacity-50"
        >
          <span aria-hidden="true" className="flex size-10 items-center justify-center rounded-full bg-white text-base font-bold text-green-800">相</span>
          <span className="mt-3 block font-bold leading-5 text-gray-950">薬局へ相談</span>
          <span className="mt-1 block text-xs leading-5 text-gray-600">トークへ相談メッセージを送る</span>
        </button>}
      </div>
      {status && <p role="status" className="mx-4 rounded-xl bg-white p-3 text-sm text-gray-700">{status}</p>}
      {error && <p role="alert" className="mx-4 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    </main>
  );
}
