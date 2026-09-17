import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  medicationFollowUpApi,
  type MedicationFollowUpOperationsOutlook,
  type PatientMedicationFollowUp,
  type PatientMedicationFollowUpResponse,
  type PatientMedicationFollowUpStatus,
} from './api.js';
import { pharmacyUuid } from '../compat.js';
import { pharmacyRoute } from '../navigation.js';
import { formatTokyoDateTime as formatTokyo } from '../../../lib/datetime.js';
import { PharmacyLoading, PharmacySpinner, PharmacyStatusBlock, usePharmacyAutoRetry, usePharmacyOnline } from '../feedback.js';

export const PATIENT_RESPONSE_OPTIONS: Array<{
  value: PatientMedicationFollowUpResponse;
  label: string;
  description: string;
}> = [
  { value: 'no_issue', label: '問題なく使えている', description: '案内どおりに使えていて、気になる変化はありません' },
  { value: 'concern', label: '気になることがある', description: '飲み忘れ、使いにくさ、体調の変化などがあります' },
  { value: 'pharmacist_requested', label: '薬剤師に相談したい', description: '薬剤師からの連絡を希望します' },
];

const STATUS_LABELS: Record<PatientMedicationFollowUpStatus, string> = {
  scheduled: '確認予定', due: '送信準備中', delivered: '回答をお願いします',
  no_issue: '問題なしで回答済み', concern: '気になることを受付済み',
  pharmacist_requested: '薬剤師への相談を受付済み', assigned: '薬剤師が確認中',
  responded: '薬剤師が対応済み', escalated: '優先して確認中', closed: '完了', cancelled: '終了',
};

export function needsPatientMedicationFollowUpResponse(status: PatientMedicationFollowUpStatus): boolean {
  return status === 'delivered';
}

export function patientMedicationFollowUpTimingLabel(item: Pick<
  PatientMedicationFollowUp,
  'status' | 'due_at' | 'delivered_at' | 'responded_at' | 'closed_at'
>): string {
  if (item.status === 'scheduled' || item.status === 'due') {
    return `確認予定 ${formatTokyo(item.due_at)}`;
  }
  if (item.status === 'delivered') {
    return `回答依頼 ${formatTokyo(item.delivered_at ?? item.due_at)}`;
  }
  if (item.status === 'closed' || item.status === 'cancelled') {
    return `完了日時 ${formatTokyo(item.closed_at ?? item.responded_at ?? item.due_at)}`;
  }
  return `回答日時 ${formatTokyo(item.responded_at ?? item.delivered_at ?? item.due_at)}`;
}

function nextMedicationFollowUpAction(status: PatientMedicationFollowUpStatus): string {
  if (status === 'delivered') return '回答を1つ選んで薬局へ送信してください。';
  if (status === 'closed' || status === 'cancelled') return 'このフォローは完了しています。';
  if (status === 'assigned' || status === 'escalated') return '薬剤師の確認をお待ちください。';
  return '表示された確認予定を待ってください。';
}

export function followUpOperationsOutlookLines(outlook: MedicationFollowUpOperationsOutlook): string[] {
  const lines = [`対応時間：${outlook.serviceHoursText}`];
  if (outlook.responseEstimateMinutes !== null) {
    lines.push(`通常、約${outlook.responseEstimateMinutes}分以内にご返信します。`);
  }
  for (const code of new Set([outlook.afterHoursMessageCode, outlook.emergencyMessageCode])) {
    lines.push(code === 'seek_urgent_care'
      ? 'お急ぎの症状がある場合は、返信を待たずに最寄りの医療機関へご相談ください。'
      : '営業時間外のご連絡は、次の営業時間に順次ご対応します。');
  }
  return lines;
}

export default function MedicationFollowUpPage() {
  const [params] = useSearchParams();
  const requestedId = params.get('followUpId');
  const [items, setItems] = useState<PatientMedicationFollowUp[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyResponse, setBusyResponse] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<{ id: string; text: string } | null>(null);
  const [outlook, setOutlook] = useState<MedicationFollowUpOperationsOutlook | null>(null);
  const [loadFailures, setLoadFailures] = useState(0);
  // The message this load last raised; quiet successes clear the shared
  // error channel only while that message is still shown (a respond-error
  // banner must survive a background refresh).
  const loadErrorRef = useRef<string | null>(null);
  // Last-started load wins: a quiet refresh must never overwrite the list a
  // response submission just rewrote.
  const loadEpochRef = useRef(0);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    const epoch = ++loadEpochRef.current;
    try {
      const result = await medicationFollowUpApi.list();
      if (epoch !== loadEpochRef.current) return;
      setItems(result.followUps);
      setLoadFailures(0);
      setError((current) => current === loadErrorRef.current ? '' : current);
      medicationFollowUpApi.outlook()
        .then(({ outlook: next }) => setOutlook(next))
        .catch(() => setOutlook(null));
    } catch {
      if (epoch !== loadEpochRef.current) return;
      if (!quiet) {
        loadErrorRef.current = '服薬後フォローを読み込めませんでした。通信状態を確認して再読み込みしてください。';
        setError(loadErrorRef.current);
      }
      setLoadFailures((count) => count + 1);
    } finally {
      if (epoch === loadEpochRef.current) setLoading(false);
    }
  }, []);

  usePharmacyAutoRetry(loadFailures, () => void load(true));
  usePharmacyOnline(() => void load(true));

  useEffect(() => { void load(); }, [load]);

  const ordered = useMemo(() => requestedId
    ? [...items].sort((left, right) => Number(right.id === requestedId) - Number(left.id === requestedId))
    : items, [items, requestedId]);

  async function respond(item: PatientMedicationFollowUp, response: PatientMedicationFollowUpResponse) {
    const option = PATIENT_RESPONSE_OPTIONS.find((candidate) => candidate.value === response);
    if (!option || !window.confirm(`「${option.label}」として薬局へ送信します。送信後は変更できません。よろしいですか？`)) return;
    setBusyId(item.id);
    setBusyResponse(response);
    setError('');
    setSuccess(null);
    try {
      const result = await medicationFollowUpApi.respond(
        item.id, response, item.version, pharmacyUuid(),
      );
      loadEpochRef.current += 1;
      setItems((current) => current.map((candidate) =>
        candidate.id === result.followUp.id ? result.followUp : candidate));
      setSuccess({
        id: item.id,
        text: response === 'no_issue'
          ? '回答を薬局へ送りました。'
          : '回答を薬局へ送りました。薬剤師が内容を確認します。',
      });
    } catch {
      await load();
      setError('回答を送信できませんでした。状態が変わっている可能性があるため、再読み込みしてください。');
    } finally {
      setBusyId(null);
      setBusyResponse(null);
    }
  }

  return (
    <main className="pharmacy-main mx-auto max-w-md">
      <div className="space-y-4 p-4">
        <p className="pharmacy-supplemental">服薬後フォローでは、お薬を使ってからの状況を薬局へ伝えられます。飲み忘れがあっても責めることはありません。</p>
        <section className="pharmacy-card p-4" aria-labelledby="follow-up-summary">
          <h2 id="follow-up-summary" className="font-bold">現在の状態</h2>
          <p className="mt-1 text-base text-gray-800">{loading ? '確認中です。' : ordered.length > 0 ? `${ordered.length}件の服薬後フォローがあります。` : '現在、確認が必要な服薬後フォローはありません。'}</p>
          <h2 className="mt-3 font-bold">次の操作</h2>
          <p className="mt-1 text-base text-gray-800">{loading ? '読み込みが終わるまでお待ちください。' : '一覧から状態を確認し、表示された回答を選んでください。'}</p>
        </section>
        {outlook && (
          <section className="pharmacy-card p-4" aria-labelledby="follow-up-outlook">
            <h2 id="follow-up-outlook" className="font-bold">対応の見通し</h2>
            {followUpOperationsOutlookLines(outlook).map((line) => (
              <p key={line} className="mt-1 text-base text-gray-800">{line}</p>
            ))}
          </section>
        )}
        <section role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-base text-red-800">
          強い息苦しさ、意識がもうろうとするなど緊急性が高い場合、この画面の回答を待たず、緊急時は119へ連絡してください。
        </section>
        {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-base text-red-800"><p>{error}</p><button type="button" onClick={() => void load()} className="pharmacy-control mt-2 rounded-lg border border-red-300 bg-white px-4 py-2 font-bold">再読み込み</button></div>}
        {loading ? <PharmacyLoading label="読み込み中..." />
          : ordered.length === 0 ? <p className="pharmacy-card p-6 text-center pharmacy-supplemental">現在、確認が必要な服薬後フォローはありません。</p>
            : <ul className="space-y-3">{ordered.map((item) => (
              <li key={item.id} aria-current={item.id === requestedId ? 'true' : undefined} className={`pharmacy-card p-4 ${item.id === requestedId ? 'ring-2 ring-blue-700' : ''}`}>
                <section aria-label="服薬後フォローの現在の状態と次の操作">
                  <p className="font-bold">現在の状態</p>
                  <p className="mt-1 text-base text-gray-900">{item.patient_name}：{STATUS_LABELS[item.status]}</p>
                  <p className="mt-3 font-bold">次の操作</p>
                  <p className="mt-1 text-base text-gray-800">{nextMedicationFollowUpAction(item.status)}</p>
                </section>
                <p className="mt-2 text-base text-gray-700">{patientMedicationFollowUpTimingLabel(item)}</p>
                {success?.id === item.id && (
                  <PharmacyStatusBlock tone="success" className="mt-3">
                    <p>{success.text}</p>
                    {item.status !== 'no_issue' && outlook && followUpOperationsOutlookLines(outlook).map((line) => (
                      <p key={line} className="mt-1">{line}</p>
                    ))}
                    <Link to={pharmacyRoute('/pharmacy/menu')} className="pharmacy-control mt-2 inline-flex items-center font-bold underline">すべての機能へ戻る</Link>
                  </PharmacyStatusBlock>
                )}
                {needsPatientMedicationFollowUpResponse(item.status) && (
                  <div className="mt-4 grid gap-2">
                    {PATIENT_RESPONSE_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        disabled={busyId === item.id}
                        aria-busy={busyId === item.id && busyResponse === option.value}
                        onClick={() => void respond(item, option.value)}
                        className="pharmacy-control min-h-11 rounded-xl border border-green-200 bg-white px-4 py-3 text-left disabled:opacity-50"
                      >
                        <span className="block font-bold text-green-800">{busyId === item.id && busyResponse === option.value ? <PharmacySpinner label="送信中…" /> : option.label}</span>
                        <span className="mt-1 block text-base text-gray-700">{option.description}</span>
                      </button>
                    ))}
                  </div>
                )}
              </li>
            ))}</ul>}
      </div>
    </main>
  );
}
