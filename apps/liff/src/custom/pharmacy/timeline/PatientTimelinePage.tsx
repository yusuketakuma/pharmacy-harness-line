import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { pharmacyRoute } from '../navigation.js';
import { isUnsupportedPharmacyFeature, pharmacyErrorMessage } from '../request.js';
import { patientTimelineApi, type PatientTimelineItem } from './api.js';

const DOMAIN_LABELS: Record<string, string> = {
  prescription: '処方せん',
  electronic_prescription: '電子処方箋',
  continuity: '継続フォロー',
  medication_follow_up: '服薬後フォロー',
};
const STATUS_LABELS: Record<string, string> = {
  pending: '確認中です',
  action_required: '確認が必要です',
  in_progress: '対応中です',
  completed: '完了しました',
  cancelled: '終了しました',
  unknown: '状況を確認してください',
};
const NEXT_ACTION_LABELS: Record<string, string> = {
  open_detail: '詳細画面で状況を確認してください。',
  wait: '薬局からの連絡をお待ちください。',
  review_required: '詳細画面を開いて、必要な内容を確認してください。',
  none: '現在、必要な操作はありません。',
};
const SAFE_DESTINATIONS: Record<string, string> = {
  prescription: '/prescriptions?view=history',
  electronic_prescription: '/prescriptions?view=electronic',
  continuity: '/pharmacy/continuity',
  medication_follow_up: '/pharmacy/medication-followup',
};

export function timelineDomainLabel(domain: string): string {
  return DOMAIN_LABELS[domain] ?? '利用状況';
}

export function timelineStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? STATUS_LABELS.unknown;
}

export function timelineNextActionLabel(nextAction: string): string {
  return NEXT_ACTION_LABELS[nextAction] ?? NEXT_ACTION_LABELS.open_detail;
}

export function safeTimelineDestination(item: { domain: string; detailPath: string }): string {
  const fixed = SAFE_DESTINATIONS[item.domain];
  return fixed && item.detailPath === fixed ? item.detailPath : fixed ?? '/pharmacy/menu';
}

function timelineDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('ja-JP') : '日時を確認できません';
}

const LEGACY_LINKS = [
  ['受付状況', '/prescriptions?view=history'],
  ['電子処方箋', '/prescriptions?view=electronic'],
  ['継続フォロー', '/pharmacy/continuity'],
  ['服薬後フォロー', '/pharmacy/medication-followup'],
] as const;

export default function PatientTimelinePage() {
  const [items, setItems] = useState<PatientTimelineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [legacyWorker, setLegacyWorker] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const errorRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    setLegacyWorker(false);
    setErrorMessage('');
    try {
      const result = await patientTimelineApi.load();
      if (mounted.current) setItems(result.items);
    } catch (caught) {
      if (!mounted.current) return;
      const error = caught as Error;
      if (isUnsupportedPharmacyFeature(error)) setLegacyWorker(true);
      else setErrorMessage(pharmacyErrorMessage(caught, '利用状況を読み込めませんでした。'));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);
  useEffect(() => {
    if (errorMessage) errorRef.current?.focus();
  }, [errorMessage]);

  if (loading) {
    return <main className="pharmacy-main mx-auto max-w-md p-4">
      <p role="status" className="pharmacy-card p-6 text-center text-base text-gray-700">
        利用状況を読み込み中...
      </p>
    </main>;
  }

  if (legacyWorker) {
    return <main className="pharmacy-main mx-auto max-w-md space-y-4 p-4">
      <section className="pharmacy-card p-4" aria-labelledby="timeline-legacy-title">
        <h2 id="timeline-legacy-title" className="font-bold">個別の画面から確認してください</h2>
        <p className="mt-2 text-base text-gray-700">この環境では、まとめ表示をまだ利用できません。</p>
        <ul className="mt-3 grid gap-2">
          {LEGACY_LINKS.map(([label, to]) => <li key={to}>
            <Link to={pharmacyRoute(to)} className="pharmacy-control pharmacy-focus flex min-h-11 items-center rounded-lg border border-gray-300 px-4 font-bold text-green-800">
              {label}
            </Link>
          </li>)}
        </ul>
      </section>
    </main>;
  }

  return <main className="pharmacy-main mx-auto max-w-md space-y-4 p-4">
    <p className="pharmacy-supplemental">送信やフォローの状態を、最近のものから確認できます。</p>
    {errorMessage && <div ref={errorRef} tabIndex={-1} role="alert" className="rounded-xl bg-red-50 p-4 text-base text-red-800 focus:outline-none">
      <p>{errorMessage}</p>
      <button type="button" onClick={() => void load()} className="pharmacy-control pharmacy-focus mt-3 min-h-11 rounded-lg border border-red-300 bg-white px-4 font-bold">再試行</button>
    </div>}
    {!errorMessage && items.length === 0 && <p className="pharmacy-card p-6 text-center text-base text-gray-700">まだ利用履歴はありません。</p>}
    {!errorMessage && items.length > 0 && <ol className="space-y-3" aria-label="利用状況">
      {items.map((item, index) => <li key={`${item.domain}-${item.occurredAt}-${index}`} className="pharmacy-card p-4">
        <article>
          <p className="text-sm font-bold text-green-800">{timelineDomainLabel(item.domain)}</p>
          <h2 className="mt-1 text-lg font-bold text-gray-950">{timelineStatusLabel(item.status)}</h2>
          <p className="mt-2 text-base text-gray-700">{timelineNextActionLabel(item.nextAction)}</p>
          <time className="mt-2 block text-sm text-gray-600" dateTime={item.occurredAt}>{timelineDate(item.occurredAt)}</time>
          <Link to={pharmacyRoute(safeTimelineDestination(item))} className="pharmacy-control pharmacy-focus mt-3 inline-flex min-h-11 items-center font-bold text-green-800 underline">
            詳細を確認
          </Link>
        </article>
      </li>)}
    </ol>}
  </main>;
}
