import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { pharmacyRoute } from '../navigation.js';
import {
  emergencyContraceptionApi,
  type EmergencyIntake,
  type EmergencyIntakeStatus,
  type EmergencySafeContactMode,
  type EmergencyServiceOverview,
} from './api.js';

export const MHLW_EMERGENCY_CONTRACEPTION_URL =
  'https://www.mhlw.go.jp/stf/kinnkyuuhininnyaku.html';

export interface EmergencyIntakeDraft {
  intercourseAt: string;
  intercourseTimeUnknown: boolean;
  slotId: string;
  age: string;
  recentPurchaseCount: string;
  patientWillVisit: boolean;
  acceptsInPersonDose: boolean;
  safeContactMode: EmergencySafeContactMode | '';
  consentAccepted: boolean;
  manufacturerCheckAcknowledged: boolean;
}

export const EMPTY_EMERGENCY_DRAFT: EmergencyIntakeDraft = {
  intercourseAt: '',
  intercourseTimeUnknown: false,
  slotId: '',
  age: '',
  recentPurchaseCount: '',
  patientWillVisit: false,
  acceptsInPersonDose: false,
  safeContactMode: '',
  consentAccepted: false,
  manufacturerCheckAcknowledged: false,
};

const SAFE_CONTACT_OPTIONS: Array<{
  value: Extract<EmergencySafeContactMode, 'neutral_line' | 'no_notification'>;
  label: string;
}> = [
  { value: 'neutral_line', label: 'LINEで中立的な連絡を受けてもよい' },
  { value: 'no_notification', label: '通知しない（自分で画面を確認する）' },
];

const STATUS_LABELS: Record<EmergencyIntakeStatus, string> = {
  provisional: '仮受付（薬剤師確認前）',
  reviewed: '薬剤師が確認中',
  completed: '店頭対応完了（販売記録は紙で管理）',
  cancelled: '取消済み',
  expired: '期限切れ',
};

const SERVICE_REASON_LABELS: Record<NonNullable<EmergencyServiceOverview['reason']>, string> = {
  not_configured: 'この受付はまだ準備中です。',
  paused: 'この受付は現在停止中です。',
  requirements_incomplete: '薬局側の準備が整っていないため、現在受付できません。',
  out_of_stock: '現在、対応できる数量がありません。',
  no_slots: '現在、選択できる対応枠がありません。',
};

function safeExternalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

function formatTokyo(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short',
    }).format(date)
    : value;
}

function validDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00+09:00`);
  return Number.isFinite(date.getTime());
}

function validIntercourseAt(draft: EmergencyIntakeDraft): boolean {
  if (draft.intercourseTimeUnknown) return validDateOnly(draft.intercourseAt);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(draft.intercourseAt)) return false;
  return Number.isFinite(new Date(`${draft.intercourseAt}${draft.intercourseAt.length === 16 ? ':00' : ''}+09:00`).getTime());
}

function validInteger(value: string, minimum: number, maximum?: number): boolean {
  const number = Number(value);
  return value.trim() !== '' && Number.isInteger(number) && number >= minimum &&
    (maximum === undefined || number <= maximum);
}

export function canSubmitEmergencyIntake(
  draft: EmergencyIntakeDraft,
): boolean {
  return draft.consentAccepted && draft.manufacturerCheckAcknowledged &&
    Boolean(draft.slotId) && validIntercourseAt(draft) &&
    validInteger(draft.age, 0, 120) && validInteger(draft.recentPurchaseCount, 0) &&
    draft.patientWillVisit && draft.acceptsInPersonDose &&
    SAFE_CONTACT_OPTIONS.some((option) => option.value === draft.safeContactMode);
}

export function toIntercourseAtPayload(draft: Pick<
  EmergencyIntakeDraft, 'intercourseAt' | 'intercourseTimeUnknown'
>): string {
  if (draft.intercourseTimeUnknown) return draft.intercourseAt;
  if (!validIntercourseAt({ ...EMPTY_EMERGENCY_DRAFT, ...draft })) {
    throw new Error('性交日時を入力してください。');
  }
  return `${draft.intercourseAt}${draft.intercourseAt.length === 16 ? ':00' : ''}+09:00`;
}

function canCancel(status: EmergencyIntakeStatus): boolean {
  return status === 'provisional' || status === 'reviewed';
}

export function EmergencyAlternativeLinks({
  service,
}: {
  service: EmergencyServiceOverview | null;
}) {
  const partnerClinicUrl = safeExternalUrl(service?.partner_clinic_url ?? null);
  const supportCenterUrl = safeExternalUrl(service?.support_center_url ?? null);
  return (
    <section className="rounded-xl border border-blue-200 bg-blue-50 p-4" aria-labelledby="emergency-alternatives">
      <h2 id="emergency-alternatives" className="font-bold text-blue-950">受付できない場合の相談先</h2>
      <p className="mt-1 text-sm text-blue-900">
        期限や対応枠の都合でこの画面から受付できない場合は、以下の案内をご確認ください。
      </p>
      <div className="mt-3 grid gap-2">
        {partnerClinicUrl && <a
          href={partnerClinicUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="min-h-11 rounded-lg border border-blue-300 bg-white px-4 py-3 text-center font-bold text-blue-900"
        >
          連携医療機関へ相談（外部サイト）
        </a>}
        {supportCenterUrl && <a
          href={supportCenterUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="min-h-11 rounded-lg border border-blue-300 bg-white px-4 py-3 text-center font-bold text-blue-900"
        >
          相談窓口を確認（外部サイト）
        </a>}
        <a
          href={MHLW_EMERGENCY_CONTRACEPTION_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="min-h-11 rounded-lg border border-blue-300 bg-white px-4 py-3 text-center font-bold text-blue-900"
        >
          厚生労働省の案内・販売薬局一覧を確認（外部サイト）
        </a>
      </div>
      <Link
        to={pharmacyRoute('/prescriptions')}
        className="mt-3 block text-center text-sm font-bold text-blue-900 underline"
      >
        通常の受付へ戻る
      </Link>
    </section>
  );
}

function IntakeList({
  intakes,
  busy,
  onCancel,
}: {
  intakes: EmergencyIntake[];
  busy: string | null;
  onCancel: (intake: EmergencyIntake) => Promise<void>;
}) {
  return (
    <section className="rounded-xl bg-white p-4 shadow-sm" aria-labelledby="emergency-intakes">
      <h2 id="emergency-intakes" className="font-bold text-gray-900">これまでの仮受付</h2>
      {intakes.length === 0
        ? <p className="mt-3 text-sm text-gray-600">現在の仮受付はありません。</p>
        : <ul className="mt-3 space-y-3">{intakes.map((intake) => (
          <li key={intake.id} className="rounded-lg border border-gray-200 p-3">
            <p className="font-bold text-gray-900">受付番号：{intake.reference_code}</p>
            <p className="mt-1 text-sm text-gray-700">{STATUS_LABELS[intake.status]}</p>
            <p className="mt-1 text-xs text-gray-600">
              対応枠：{formatTokyo(intake.slot_starts_at)}〜{formatTokyo(intake.slot_ends_at)}
            </p>
            <p className="mt-1 text-xs text-gray-600">有効期限：{formatTokyo(intake.expires_at)}</p>
            {intake.status === 'provisional' && <p className="mt-2 text-xs text-amber-800">患者申告は薬剤師確認前です。</p>}
            {canCancel(intake.status) && <button
              type="button"
              onClick={() => void onCancel(intake)}
              disabled={busy !== null}
              className="mt-3 min-h-11 rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-bold text-red-800 disabled:opacity-50"
            >
              {busy === `cancel:${intake.id}` ? '取消中...' : 'この仮受付を取消'}
            </button>}
          </li>
        ))}</ul>}
    </section>
  );
}

function EmergencyIntakeForm({
  draft,
  service,
  busy,
  onDraftChange,
  onSubmit,
}: {
  draft: EmergencyIntakeDraft;
  service: EmergencyServiceOverview;
  busy: string | null;
  onDraftChange: <K extends keyof EmergencyIntakeDraft>(key: K, value: EmergencyIntakeDraft[K]) => void;
  onSubmit: () => Promise<void>;
}) {
  const disabled = busy !== null;
  return (
    <form
      className="space-y-4 rounded-xl bg-white p-4 shadow-sm"
      onSubmit={(event) => { event.preventDefault(); void onSubmit(); }}
    >
      <h2 className="text-base font-bold text-gray-900">来局前の最小確認</h2>
      <p className="text-sm text-gray-600">必要な項目だけ入力してください。</p>

      <fieldset className="space-y-2">
        <legend className="font-bold text-gray-900">性交日時</legend>
        <label className="block text-sm text-gray-700" htmlFor="emergency-intercourse-at">
          {draft.intercourseTimeUnknown ? '性交した日' : '性交した日時'}
        </label>
        <input
          id="emergency-intercourse-at"
          type={draft.intercourseTimeUnknown ? 'date' : 'datetime-local'}
          value={draft.intercourseAt}
          onChange={(event) => onDraftChange('intercourseAt', event.currentTarget.value)}
          disabled={disabled}
          required
          className="min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 py-2"
        />
        <label className="flex min-h-11 items-center gap-2 text-sm text-gray-800">
          <input
            type="checkbox"
            checked={draft.intercourseTimeUnknown}
            onChange={(event) => onDraftChange('intercourseTimeUnknown', event.currentTarget.checked)}
            disabled={disabled}
            className="size-5"
          />
          時刻不明（日付のみで確認）
        </label>
      </fieldset>

      <label className="block space-y-1 text-sm text-gray-700" htmlFor="emergency-slot">
        <span className="font-bold text-gray-900">希望する対応枠</span>
        <select
          id="emergency-slot"
          value={draft.slotId}
          onChange={(event) => onDraftChange('slotId', event.currentTarget.value)}
          disabled={disabled}
          required
          className="min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 py-2"
        >
          <option value="">対応枠を選択</option>
          {service.slots.map((slot) => <option key={slot.id} value={slot.id}>
            {formatTokyo(slot.starts_at)}〜{formatTokyo(slot.ends_at)}（残り{slot.remaining}）
          </option>)}
        </select>
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="block space-y-1 text-sm text-gray-700" htmlFor="emergency-age">
          <span className="font-bold text-gray-900">年齢</span>
          <input
            id="emergency-age"
            type="number"
            min="0"
            max="120"
            step="1"
            inputMode="numeric"
            value={draft.age}
            onChange={(event) => onDraftChange('age', event.currentTarget.value)}
            disabled={disabled}
            required
            className="min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 py-2"
          />
        </label>
        <label className="block space-y-1 text-sm text-gray-700" htmlFor="emergency-recent-count">
          <span className="font-bold text-gray-900">過去3か月の利用回数</span>
          <input
            id="emergency-recent-count"
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            value={draft.recentPurchaseCount}
            onChange={(event) => onDraftChange('recentPurchaseCount', event.currentTarget.value)}
            disabled={disabled}
            required
            className="min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 py-2"
          />
        </label>
      </div>

      <fieldset className="space-y-2">
        <legend className="font-bold text-gray-900">来局と服用方法の確認</legend>
        <label className="flex min-h-11 items-center gap-2 text-sm text-gray-800">
          <input
            type="checkbox"
            checked={draft.patientWillVisit}
            onChange={(event) => onDraftChange('patientWillVisit', event.currentTarget.checked)}
            disabled={disabled}
            className="size-5"
          />
          本人が薬局へ来局します
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm text-gray-800">
          <input
            type="checkbox"
            checked={draft.acceptsInPersonDose}
            onChange={(event) => onDraftChange('acceptsInPersonDose', event.currentTarget.checked)}
            disabled={disabled}
            className="size-5"
          />
          薬剤師の面前で服用します
        </label>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="font-bold text-gray-900">安全な連絡方法</legend>
        {SAFE_CONTACT_OPTIONS.map((option) => <label key={option.value} className="flex min-h-11 items-center gap-2 text-sm text-gray-800">
          <input
            type="radio"
            name="emergency-safe-contact"
            value={option.value}
            checked={draft.safeContactMode === option.value}
            onChange={() => onDraftChange('safeContactMode', option.value)}
            disabled={disabled}
            className="size-5"
          />
          {option.label}
        </label>)}
      </fieldset>

      {safeExternalUrl(service.manufacturer_check_url) && <div className="rounded-lg border border-green-200 bg-green-50 p-3">
        <a
          href={safeExternalUrl(service.manufacturer_check_url) ?? undefined}
          target="_blank"
          rel="noreferrer noopener"
          className="font-bold text-green-900 underline"
        >
          メーカー公式セルフチェック（外部サイト）
        </a>
        <p className="mt-2 text-xs text-gray-700">画像はLINEへ送らず、来局時に本人の端末で提示してください。</p>
        <label className="mt-2 flex min-h-11 items-center gap-2 text-sm text-gray-800">
          <input
            type="checkbox"
            checked={draft.manufacturerCheckAcknowledged}
            onChange={(event) => onDraftChange('manufacturerCheckAcknowledged', event.currentTarget.checked)}
            disabled={disabled}
            className="size-5"
          />
          セルフチェックを確認しました
        </label>
      </div>}

      <button
        type="submit"
        disabled={disabled}
        className="min-h-12 w-full rounded-xl bg-green-700 px-4 py-3 font-bold text-white disabled:opacity-50"
      >
        {busy === 'submit' ? '送信中...' : '仮受付を送信'}
      </button>
      <p className="text-xs text-gray-600">送信後も販売は確定しません。来局時に薬剤師が確認します。</p>
    </form>
  );
}

export default function EmergencyContraceptionPage() {
  const [service, setService] = useState<EmergencyServiceOverview | null>(null);
  const [intakes, setIntakes] = useState<EmergencyIntake[]>([]);
  const [draft, setDraft] = useState<EmergencyIntakeDraft>(EMPTY_EMERGENCY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await emergencyContraceptionApi.list();
      setService(result.service);
      setIntakes(result.intakes);
    } catch (err) {
      setService(null);
      setError(err instanceof Error
        ? err.message
        : '受付情報を読み込めませんでした。再読み込みしてください。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function changeDraft<K extends keyof EmergencyIntakeDraft>(
    key: K,
    value: EmergencyIntakeDraft[K],
  ) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function submit() {
    if (busy || !service?.consent || !canSubmitEmergencyIntake(draft)) {
      setError('同意、セルフチェック、確認項目をすべて確認してください。');
      return;
    }
    setBusy('submit');
    setError('');
    setSuccess('');
    try {
      const result = await emergencyContraceptionApi.create({
        slotId: draft.slotId,
        intercourseAt: toIntercourseAtPayload(draft),
        intercourseTimeUnknown: draft.intercourseTimeUnknown,
        age: Number(draft.age),
        recentPurchaseCount: Number(draft.recentPurchaseCount),
        patientWillVisit: draft.patientWillVisit,
        acceptsInPersonDose: draft.acceptsInPersonDose,
        safeContactMode: draft.safeContactMode as EmergencySafeContactMode,
        consentVersion: service.consent.version,
        manufacturerCheckAcknowledged: draft.manufacturerCheckAcknowledged,
        idempotencyKey: crypto.randomUUID(),
      });
      setIntakes((current) => [result.intake, ...current.filter((item) => item.id !== result.intake.id)]);
      setDraft(EMPTY_EMERGENCY_DRAFT);
      setSuccess(`仮受付番号 ${result.intake.reference_code} を受け付けました。販売は確定していません。`);
    } catch (err) {
      setError(err instanceof Error
        ? err.message
        : '仮受付を送信できませんでした。最新の空き状況を確認してください。');
      if (err && typeof err === 'object' && 'status' in err && err.status === 409) await load();
    } finally {
      setBusy(null);
    }
  }

  async function cancel(intake: EmergencyIntake) {
    if (busy || !window.confirm('この仮受付を取消しますか？')) return;
    setBusy(`cancel:${intake.id}`);
    setError('');
    setSuccess('');
    try {
      const result = await emergencyContraceptionApi.cancel(
        intake.id, intake.version, crypto.randomUUID(),
      );
      setIntakes((current) => current.map((item) => item.id === result.intake.id ? result.intake : item));
      setSuccess('仮受付を取消しました。');
    } catch (err) {
      await load();
      setError(err instanceof Error
        ? err.message
        : '仮受付を取消できませんでした。最新の状態を確認してください。');
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-md bg-gray-50 pb-10">
      <header className="border-b bg-white px-4 py-4">
        <h1 className="text-lg font-bold text-gray-900">緊急避妊薬の来局前確認</h1>
        <p className="mt-1 text-sm text-gray-700">
          来局前に必要な情報を確認し、薬局の対応枠を仮受付できます。
        </p>
      </header>
      <div className="space-y-4 p-4">
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          <p className="font-bold">仮受付であり、販売・服用・在庫を保証しません</p>
          <p className="mt-1">最終的な販売可否は、来局時に研修を修了した薬剤師が確認します。</p>
        </section>
        {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
          <p>{error}</p>
          <button type="button" onClick={() => void load()} className="mt-2 min-h-11 rounded-lg border border-red-300 bg-white px-4 py-2 font-bold">再読み込み</button>
        </div>}
        {success && <div role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-800">{success}</div>}
        {loading
          ? <p className="rounded-xl bg-white p-6 text-center text-sm text-gray-600">受付状況を読み込み中...</p>
          : service?.ready && service.consent
            ? <>
              <section className="space-y-3 rounded-xl bg-white p-4 shadow-sm" aria-labelledby="emergency-consent">
                <h2 id="emergency-consent" className="font-bold text-gray-900">説明と明示同意</h2>
                <dl className="space-y-1 text-sm text-gray-700">
                  <div><dt className="font-bold">利用目的</dt><dd>{service.consent.purpose}</dd></div>
                  <div><dt className="font-bold">保存期間</dt><dd>{service.consent.retention_days}日間</dd></div>
                  <div><dt className="font-bold">問い合わせ先</dt><dd>{service.consent.privacy_contact}</dd></div>
                </dl>
                <a
                  href={safeExternalUrl(service.consent.privacy_policy_url) ?? undefined}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-sm font-bold text-green-800 underline"
                >
                  個人情報の利用目的・問い合わせ先を確認（外部サイト）
                </a>
                <label className="flex min-h-11 items-center gap-2 text-sm text-gray-800">
                  <input
                    type="checkbox"
                    checked={draft.consentAccepted}
                    onChange={(event) => changeDraft('consentAccepted', event.currentTarget.checked)}
                    disabled={busy !== null}
                    className="size-5"
                  />
                  説明と利用目的を確認し、来局前確認に同意します
                </label>
              </section>
              {draft.consentAccepted && <EmergencyIntakeForm
                draft={draft}
                service={service}
                busy={busy}
                onDraftChange={changeDraft}
                onSubmit={submit}
              />}
              <IntakeList intakes={intakes} busy={busy} onCancel={cancel} />
            </>
            : <>
              <section className="rounded-xl bg-white p-4 shadow-sm">
                <h2 className="font-bold text-gray-900">現在この画面から受付できません</h2>
                <p className="mt-2 text-sm text-gray-700">
                  {service?.reason ? SERVICE_REASON_LABELS[service.reason] : '受付状況を確認できませんでした。'}
                </p>
              </section>
              {intakes.length > 0 && <IntakeList intakes={intakes} busy={busy} onCancel={cancel} />}
            </>}
        <EmergencyAlternativeLinks service={service} />
      </div>
    </main>
  );
}
