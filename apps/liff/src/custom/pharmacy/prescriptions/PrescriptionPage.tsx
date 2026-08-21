import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { prescriptionApi, type PrescriptionSubmission } from './api.js';
import { patientIntakeApi, type PharmacyPatient } from '../intake/api.js';
import { pharmacyRoute } from '../navigation.js';
import { mynaApi, type MynaHandoff, type MynaPatientReport } from '../myna/api.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function canSubmitPrescription(
  imageCount: number,
  originalConsent: boolean,
  noticeConsent: boolean,
  busy: boolean,
): boolean {
  return imageCount >= 1 && imageCount <= 4 && originalConsent && noticeConsent && !busy;
}

export function prescriptionUnmetReasons(input: {
  imageCount: number;
  originalConsent: boolean;
  noticeConsent: boolean;
  patientSelected: boolean;
  intakeDone: boolean;
}): string[] {
  const reasons: string[] = [];
  if (!input.patientSelected) reasons.push('患者を選んでください');
  if (!input.intakeDone) reasons.push('患者アンケートに回答してください');
  if (input.imageCount < 1) reasons.push('処方せんの写真を1枚以上選んでください');
  if (input.imageCount > 4) reasons.push('処方せんの写真は4枚までにしてください');
  if (!input.originalConsent) reasons.push('「処方せん原本を持参します」にチェックしてください');
  if (!input.noticeConsent) reasons.push('「準備完了通知をLINEで受け取ります」にチェックしてください');
  return reasons;
}

export function validatePrescriptionImages(
  files: ArrayLike<{ type: string; size: number }>,
): string | null {
  if (files.length > 4) return '画像は4枚まで選択できます。';
  for (const file of Array.from(files)) {
    if (file.type !== 'image/jpeg' && file.type !== 'image/png') {
      return '画像はJPEGまたはPNGを選択してください。';
    }
    if (file.size > MAX_IMAGE_BYTES) return '画像1枚は10MB以下にしてください。';
  }
  return null;
}

const statusLabels: Record<string, string> = {
  draft: '送信準備中',
  received: '受付内容の確認待ち',
  needs_resubmission: '再撮影が必要',
  accepted: '受付済み',
  ready: 'お薬の準備完了',
  closed: '受け取り済み',
  cancelled: 'キャンセル済み',
};

const reasonLabels: Record<string, string> = {
  blurred: '画像がぼやけています',
  cropped: '処方せんの一部が切れています',
  glare: '光が反射しています',
  unreadable: '文字を読み取れません',
  missing_page: '不足しているページがあります',
};

const requirementLabels: Record<string, string> = {
  stock_check: '在庫を確認しています',
  original_required: '処方せん原本を確認します',
  patient_confirmation: '薬局から確認があります',
  pharmacist_review: '薬剤師が内容を確認しています',
};

const mynaStatusLabels: Record<string, string> = {
  CREATED: '手続き開始前',
  LAUNCH_REQUESTED: '外部画面で手続き中',
  PATIENT_REPORTED_COMPLETE: '完了を申告済み（薬局確認待ち）',
  PATIENT_REPORTED_NO_PRESCRIPTION: '処方せんが見つからなかったと申告済み',
  SUPPORT_NEEDED: '薬局が確認中',
  COMPLETED: '薬局で受領済み',
  CLOSED: '終了',
  EXPIRED: '期限切れ',
  CANCELLED: 'キャンセル済み',
};

export function mynaStatusLabel(status: string): string {
  return mynaStatusLabels[status] ?? '手続き中';
}

const MYNA_PATIENT_REPORT_OPTIONS = [
  ['COMPLETED', '手続きを終えた'],
  ['NO_PRESCRIPTION_FOUND', '処方せんが見つからなかった'],
  ['FAILED', '電子手続きを中止'],
  ['SWITCH_TO_PAPER', '紙の処方せんに切り替える'],
] as const satisfies ReadonlyArray<readonly [MynaPatientReport, string]>;

export function canLaunchMynaPatientHandoff(status: string): boolean {
  return status === 'CREATED' || status === 'LAUNCH_REQUESTED';
}

export function mynaPatientReportOptions(status: string) {
  if (canLaunchMynaPatientHandoff(status)) return MYNA_PATIENT_REPORT_OPTIONS;
  if (status === 'PATIENT_REPORTED_COMPLETE' || status === 'PATIENT_REPORTED_NO_PRESCRIPTION' || status === 'SUPPORT_NEEDED') {
    return MYNA_PATIENT_REPORT_OPTIONS.slice(3);
  }
  return [];
}

export function pendingRequirementLabels(value: string | null): string[] {
  try {
    const requirements = JSON.parse(value ?? '[]') as Array<{ code?: unknown; status?: unknown }>;
    if (!Array.isArray(requirements)) return [];
    return requirements
      .filter((item) => item?.status === 'pending')
      .map((item) => requirementLabels[String(item.code)] ?? '薬局から確認があります');
  } catch {
    return [];
  }
}

export function requestedPrescriptionId(search: string): string | null {
  const value = new URLSearchParams(search).get('submissionId');
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}

export function initialPrescriptionView(search: string): 'send' | 'electronic' | 'history' {
  const view = new URLSearchParams(search).get('view');
  return view === 'history' || view === 'electronic' ? view : 'send';
}

export default function PrescriptionPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const requestedSubmissionId = requestedPrescriptionId(location.search);
  const tab = initialPrescriptionView(location.search);
  const openView = useCallback((view: 'send' | 'electronic' | 'history') => {
    navigate(pharmacyRoute(`/prescriptions?view=${view}`));
  }, [navigate]);
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [originalConsent, setOriginalConsent] = useState(false);
  const [noticeConsent, setNoticeConsent] = useState(false);
  const [desiredPickupAt, setDesiredPickupAt] = useState('');
  const [desiredFulfillmentMethod, setDesiredFulfillmentMethod] = useState<'PICKUP' | 'DELIVERY'>('PICKUP');
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [history, setHistory] = useState<PrescriptionSubmission[]>([]);
  const [patients, setPatients] = useState<PharmacyPatient[]>([]);
  const [selectedPatientId, setSelectedPatientId] = useState('');
  const [intakeResponseId, setIntakeResponseId] = useState('');
  const [loadingPatients, setLoadingPatients] = useState(true);
  const [replacement, setReplacement] = useState<PrescriptionSubmission | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [sentSubmission, setSentSubmission] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const [mynaHandoff, setMynaHandoff] = useState<MynaHandoff | null>(null);
  const [loadingMyna, setLoadingMyna] = useState(true);
  const mynaBusy = useRef(false);
  // datetime-local expects local time without seconds; past slots cannot be requested.
  const pickupMin = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

  const refreshHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      const result = await prescriptionApi.history();
      setHistory(result.submissions);
      if (requestedSubmissionId) openView('history');
      return result.submissions;
    } catch (err) {
      setError(err instanceof Error ? err.message : '履歴を読み込めませんでした。');
      return [];
    } finally {
      setLoadingHistory(false);
    }
  }, [openView, requestedSubmissionId]);

  useEffect(() => { void refreshHistory(); }, [refreshHistory]);
  useEffect(() => {
    if (error) {
      errorRef.current?.focus();
      errorRef.current?.scrollIntoView({ block: 'center' });
    }
  }, [error]);
  useEffect(() => {
    let active = true;
    void mynaApi.active().then((result) => {
      if (active) setMynaHandoff(result.handoff);
    }).catch((err: unknown) => {
      if (active) setError(err instanceof Error ? err.message : '電子処方箋の状況を読み込めませんでした。');
    }).finally(() => {
      if (active) setLoadingMyna(false);
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    void patientIntakeApi.list().then((result) => {
      if (!active) return;
      setPatients(result.patients);
      setSelectedPatientId((current) => current || result.patients[0]?.id || '');
    }).catch((err: unknown) => {
      if (active) setError(err instanceof Error ? err.message : '患者情報を読み込めませんでした。');
    }).finally(() => {
      if (active) setLoadingPatients(false);
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!selectedPatientId) {
      setIntakeResponseId('');
      return;
    }
    let active = true;
    setIntakeResponseId('');
    void patientIntakeApi.latest(selectedPatientId).then((result) => {
      if (active) setIntakeResponseId(result.intake?.id ?? '');
    }).catch((err: unknown) => {
      if (active) setError(err instanceof Error ? err.message : 'アンケートを読み込めませんでした。');
    });
    return () => { active = false; };
  }, [selectedPatientId]);
  useEffect(() => {
    const urls = files.map((file) => URL.createObjectURL(file));
    setPreviews(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [files]);

  function chooseFiles(selected: FileList | null) {
    if (!selected) return;
    setFiles((current) => {
      const next = [...current, ...Array.from(selected)];
      const validation = validatePrescriptionImages(next);
      setError(validation);
      return validation ? current : next;
    });
  }

  const unmetReasons = prescriptionUnmetReasons({
    imageCount: files.length,
    originalConsent,
    noticeConsent,
    patientSelected: Boolean(selectedPatientId),
    intakeDone: Boolean(intakeResponseId),
  });
  const selectedPatient = patients.find((patient) => patient.id === selectedPatientId);

  async function send() {
    if (!canSubmitPrescription(files.length, originalConsent, noticeConsent, busy)) return;
    if (!selectedPatientId || !intakeResponseId) {
      setError('先に患者アンケートを回答してください。');
      return;
    }
    setConfirming(false);
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const submission = replacement ?? (await prescriptionApi.reserve({
        idempotencyKey,
        desiredPickupAt: desiredPickupAt ? new Date(desiredPickupAt).toISOString() : null,
        desiredFulfillmentMethod,
        originalPrescriptionConsent: originalConsent,
        readinessNoticeConsent: noticeConsent,
        patientId: selectedPatientId,
        intakeResponseId,
      })).submission;
      for (const [index, file] of files.entries()) {
        await prescriptionApi.upload(submission.id, index + 1, file);
      }
      await prescriptionApi.submit(submission.id, {
        expectedUpdatedAt: submission.updated_at,
        desiredPickupAt: desiredPickupAt ? new Date(desiredPickupAt).toISOString() : null,
        desiredFulfillmentMethod,
        originalPrescriptionConsent: originalConsent,
        readinessNoticeConsent: noticeConsent,
      });
      setFiles([]);
      setReplacement(null);
      setOriginalConsent(false);
      setNoticeConsent(false);
      setDesiredPickupAt('');
      setDesiredFulfillmentMethod('PICKUP');
      setIdempotencyKey(crypto.randomUUID());
      setSuccess('処方せんを送信しました。薬局からの連絡をお待ちください。');
      setSentSubmission(true);
      await refreshHistory();
      openView('history');
      window.scrollTo(0, 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : '送信に失敗しました。もう一度お試しください。');
    } finally {
      setBusy(false);
    }
  }

  async function cancel(item: PrescriptionSubmission) {
    if (!window.confirm('この処方せん送信をキャンセルしますか？')) return;
    setBusy(true);
    setError(null);
    try {
      await prescriptionApi.cancel(item.id, item.updated_at);
      await refreshHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'キャンセルできませんでした。');
    } finally {
      setBusy(false);
    }
  }

  async function startResubmission(item: PrescriptionSubmission) {
    setBusy(true);
    setError(null);
    try {
      await prescriptionApi.reserveResubmission(item.id, item.updated_at);
      const updated = (await refreshHistory()).find((entry) => entry.id === item.id);
      if (!updated) throw new Error('再提出情報を読み込めませんでした。');
      setReplacement(updated);
      setDesiredFulfillmentMethod(updated.desired_fulfillment_method ?? 'PICKUP');
      setFiles([]);
      setConfirming(false);
      setSentSubmission(false);
      openView('send');
    } catch (err) {
      setError(err instanceof Error ? err.message : '再提出を開始できませんでした。');
    } finally {
      setBusy(false);
    }
  }

  async function reportArrival(item: PrescriptionSubmission) {
    if (busy || !window.confirm('薬局に到着したことを通知します。よろしいですか？')) return;
    setBusy(true);
    setError(null);
    try {
      await prescriptionApi.arrive(item.id, item.updated_at);
      setSuccess('来局しました。薬局へ到着を通知しました。');
      await refreshHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : '到着を通知できませんでした。');
    } finally {
      setBusy(false);
    }
  }

  async function launchElectronic() {
    if (mynaBusy.current) return;
    mynaBusy.current = true;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const handoff = mynaHandoff ?? (await mynaApi.create(
        'E_PRESCRIPTION', crypto.randomUUID(), selectedPatientId || undefined,
      )).handoff;
      const launched = await mynaApi.launch(handoff.id);
      setMynaHandoff(launched.handoff);
      window.location.assign(launched.launchUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : '電子処方箋の手続きを開始できませんでした。');
      mynaBusy.current = false;
    } finally {
      setBusy(false);
    }
  }

  async function reportElectronic(result: MynaPatientReport) {
    if (!mynaHandoff || mynaBusy.current) return;
    mynaBusy.current = true;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await mynaApi.report(mynaHandoff.id, result);
      setMynaHandoff(response.handoff);
      setSuccess(result === 'COMPLETED'
        ? '手続き完了の申告を記録しました。薬局での受領確認はまだ完了していません。'
        : '電子処方箋の状況を記録しました。');
      if (result === 'SWITCH_TO_PAPER') openView('send');
    } catch (err) {
      setError(err instanceof Error ? err.message : '電子処方箋の状況を更新できませんでした。');
    } finally {
      mynaBusy.current = false;
      setBusy(false);
    }
  }

  return (
    <main className="max-w-md mx-auto min-h-screen bg-gray-50 pb-10">
      <nav className="grid grid-cols-3 bg-white border-b" aria-label="処方せんメニュー">
        {(['send', 'electronic', 'history'] as const).map((view) => <Link
          key={view}
          to={pharmacyRoute(`/prescriptions?view=${view}`)}
          aria-current={tab === view ? 'page' : undefined}
          className={`min-h-11 py-3 text-center text-sm ${tab === view ? 'border-b-2 border-green-600 font-bold text-green-700' : 'text-gray-600'}`}
        >{view === 'send' ? '処方せんを送る' : view === 'electronic' ? '電子処方箋' : '受付状況'}</Link>)}
      </nav>

      <div className="p-4 space-y-4">
        <p className="text-sm leading-6 text-gray-600">処方せん受付では、紙の事前送信または電子処方箋を選べます。</p>
        {error && <div ref={errorRef} tabIndex={-1} role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700 focus:outline-none">{error}</div>}
        {success && <div role="status" className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">
          <p className="font-bold">{success}</p>
          {sentSubmission && <>
            <p className="mt-2 font-bold">次にすること</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              <li>薬局からの確認連絡をLINEでお待ちください。</li>
              <li>来局時は処方せんの原本をお持ちください。</li>
              <li>状況はこの「受付状況」画面でいつでも確認できます。</li>
            </ul>
          </>}
        </div>}

        {tab === 'electronic' ? (
          <section className="space-y-4" aria-labelledby="electronic-prescription-heading">
            <div className="rounded-xl bg-white p-4 shadow-sm">
              <h2 id="electronic-prescription-heading" className="font-bold">電子処方箋を利用</h2>
              <p className="mt-2 text-sm leading-6 text-gray-700">外部の受付画面で手続きします。患者情報・LINE ID・LIFF IDは外部URLへ付けません。</p>
              <p className="mt-2 text-xs leading-5 text-amber-800">「手続きを終えた」は患者からの申告です。薬局で確認するまで正式な受領にはなりません。</p>
              {loadingMyna ? <p className="py-6 text-center text-sm text-gray-500">状況を読み込み中...</p> : <>
                {mynaHandoff && <div className="mt-4 rounded-lg bg-gray-50 p-3 text-sm"><p className="font-medium">電子処方箋の手続き状況</p><p className="mt-1 text-gray-600">状態: {mynaStatusLabel(mynaHandoff.status)} / 期限: {new Date(mynaHandoff.expires_at).toLocaleString('ja-JP')}</p></div>}
                {(!mynaHandoff || canLaunchMynaPatientHandoff(mynaHandoff.status)) && <button type="button" onClick={() => void launchElectronic()} disabled={busy} className="mt-4 min-h-11 w-full rounded-xl bg-green-600 px-4 py-3 font-bold text-white disabled:opacity-50">{busy ? '処理中…' : mynaHandoff ? '外部画面へ戻る' : '電子処方箋の手続きを始める'}</button>}
                {mynaHandoff && mynaPatientReportOptions(mynaHandoff.status).length > 0 && <div className="mt-4 grid gap-2">{mynaPatientReportOptions(mynaHandoff.status).map(([result, label]) => <button key={result} type="button" onClick={() => void reportElectronic(result)} disabled={busy} className="min-h-11 rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:opacity-50">{label}</button>)}</div>}
              </>}
            </div>
          </section>
        ) : tab === 'send' ? (
          <section className="space-y-4" aria-labelledby="upload-heading">
            <div className="rounded-xl bg-white p-4 shadow-sm space-y-3">
              <h2 className="font-bold">患者を選択</h2>
              {loadingPatients ? <p className="text-sm text-gray-500">患者情報を読み込み中...</p> : patients.length === 0 ? (
                <p className="text-sm text-gray-600"><Link to={pharmacyRoute('/pharmacy/patient-intake')} className="font-bold text-green-700 underline">患者アンケート</Link>から患者情報を登録してください。</p>
              ) : <>
                <select value={selectedPatientId} onChange={(event) => setSelectedPatientId(event.target.value)} className="block w-full rounded-lg border border-gray-300 p-3" disabled={busy} aria-label="処方せんの患者">
                  {patients.map((patient) => <option key={patient.id} value={patient.id}>{patient.name}（{patient.birth_date}）</option>)}
                </select>
                {!intakeResponseId && <p className="text-sm text-amber-700"><Link to={pharmacyRoute('/pharmacy/patient-intake')} className="font-bold underline">この患者のアンケートに回答</Link>してから送信してください。</p>}
              </>}
            </div>
            <div className="rounded-xl bg-white p-4 shadow-sm">
              <h2 id="upload-heading" className="font-bold">{replacement ? '処方せんを再撮影' : '処方せん画像'}</h2>
              <p className="mt-1 text-xs text-gray-600">全体が入り、文字が読める明るい写真を1〜4枚選んでください。</p>
              <label className="mt-3 block cursor-pointer rounded-lg border-2 border-dashed border-gray-300 p-5 text-center text-sm font-medium text-green-700">
                カメラで撮影・画像を選択
                <input
                  className="sr-only"
                  type="file"
                  accept="image/jpeg,image/png"
                  capture="environment"
                  multiple
                  onChange={(event) => chooseFiles(event.target.files)}
                  disabled={busy}
                />
              </label>
              {previews.length > 0 && (
                <ul className="mt-3 grid grid-cols-2 gap-2" aria-label="選択した画像">
                  {previews.map((url, index) => (
                    <li key={url} className="relative">
                      <img src={url} alt={`選択した処方せん ${index + 1}`} className="aspect-[4/3] w-full rounded-lg object-cover" />
                      <button type="button" onClick={() => setFiles((items) => items.filter((_, i) => i !== index))} className="absolute right-1 top-1 min-h-11 rounded bg-black/70 px-3 py-2 text-base text-white" aria-label={`画像${index + 1}を削除`}>削除</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-xl bg-white p-4 shadow-sm space-y-3">
              <label className="block text-sm font-medium">
                希望受取日時（任意）
                <input type="datetime-local" min={pickupMin} value={desiredPickupAt} onChange={(event) => setDesiredPickupAt(event.target.value)} className="mt-1 block w-full rounded-lg border border-gray-300 p-3" disabled={busy} />
              </label>
              <fieldset className="space-y-2 text-sm">
                <legend className="font-medium">希望する受け取り方法</legend>
                <label className="flex items-center gap-3"><input type="radio" name="fulfillment-method" value="PICKUP" checked={desiredFulfillmentMethod === 'PICKUP'} onChange={() => setDesiredFulfillmentMethod('PICKUP')} disabled={busy} className="h-5 w-5" />薬局で受け取る</label>
                <label className="flex items-center gap-3"><input type="radio" name="fulfillment-method" value="DELIVERY" checked={desiredFulfillmentMethod === 'DELIVERY'} onChange={() => setDesiredFulfillmentMethod('DELIVERY')} disabled={busy} className="h-5 w-5" />配送を希望（薬局の確認後に確定）</label>
              </fieldset>
              {replacement && <p className="text-xs text-amber-700">再提出のため、同意事項に再度チェックしてください。</p>}
              <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={originalConsent} onChange={(event) => setOriginalConsent(event.target.checked)} className="mt-1 h-5 w-5" disabled={busy} /><span>処方せん原本を持参します</span></label>
              <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={noticeConsent} onChange={(event) => setNoticeConsent(event.target.checked)} className="mt-1 h-5 w-5" disabled={busy} /><span>準備完了通知をLINEで受け取ります</span></label>
            </div>

            {unmetReasons.length > 0 && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <p className="font-bold">送信するには、次を確認してください</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">{unmetReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            </div>}
            {confirming ? (
              <div className="space-y-3 rounded-xl border-2 border-green-600 bg-white p-4" role="group" aria-labelledby="confirm-heading">
                <h2 id="confirm-heading" className="font-bold">送信内容の確認</h2>
                <ul className="space-y-1 text-sm text-gray-800">
                  <li>患者: {selectedPatient ? selectedPatient.name : '未選択'}</li>
                  <li>処方せんの写真: {files.length}枚</li>
                  <li>希望受取日時: {desiredPickupAt ? new Date(desiredPickupAt).toLocaleString('ja-JP') : '指定なし'}</li>
                  <li>受け取り方法: {desiredFulfillmentMethod === 'PICKUP' ? '薬局で受け取る' : '配送を希望'}</li>
                  <li>原本の持参・LINE通知: 同意済み</li>
                </ul>
                <button type="button" onClick={() => void send()} disabled={busy} className="min-h-11 w-full rounded-xl bg-green-600 px-4 py-4 font-bold text-white disabled:bg-gray-300">
                  {busy ? '送信中…' : 'この内容で送信する'}
                </button>
                <button type="button" onClick={() => setConfirming(false)} disabled={busy} className="min-h-11 w-full rounded-xl border border-gray-300 bg-white px-4 py-3 font-bold text-gray-700 disabled:opacity-50">修正する</button>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirming(true)} disabled={unmetReasons.length > 0 || busy} className="min-h-11 w-full rounded-xl bg-green-600 px-4 py-4 font-bold text-white disabled:bg-gray-300">
                {busy ? '送信中…' : replacement ? '再提出の内容を確認する' : '送信内容を確認する'}
              </button>
            )}
            <p className="text-xs leading-5 text-gray-600">この送信だけでは受付完了ではありません。薬局の受付内容の確認連絡をご確認ください。</p>
          </section>
        ) : (
          <section aria-labelledby="history-heading">
            <h2 id="history-heading" className="font-bold">受付状況</h2>
            {loadingHistory ? <p className="py-8 text-center text-gray-500">読み込み中...</p> : history.length === 0 ? <p className="py-8 text-center text-gray-500">送信履歴はありません。</p> : (
              <ul className="mt-3 space-y-3">
                {history.map((item) => (
                  <li key={item.id} className="rounded-xl bg-white p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3"><div><p className="font-bold">{statusLabels[item.status] ?? item.status}</p><p className="mt-1 text-xs text-gray-600">{new Date(item.created_at).toLocaleString('ja-JP')}</p></div><span className="rounded-full bg-gray-100 px-2 py-1 text-xs">第{item.upload_revision}版</span></div>
                    <div className="mt-3 rounded-lg bg-green-50 p-3 text-sm" aria-label="受付状況">
                      <p className="font-bold text-green-800">受付状況</p>
                      <p className="mt-1 text-gray-700">準備予定: {item.estimated_ready_at
                        ? new Date(item.estimated_ready_at).toLocaleString('ja-JP')
                        : '薬局で確認中'}</p>
                      {item.desired_pickup_at && <p className="mt-1 text-gray-700">希望受取: {new Date(item.desired_pickup_at).toLocaleString('ja-JP')}</p>}
                      {pendingRequirementLabels(item.requirements_json).map((label) => (
                        <p key={label} className="mt-1 text-amber-800">確認事項: {label}</p>
                      ))}
                    </div>
                    {item.resubmission_reason_code && <p className="mt-3 rounded bg-amber-50 p-2 text-sm text-amber-800">{reasonLabels[item.resubmission_reason_code] ?? '画像をご確認ください'}</p>}
                    <div className="mt-3 flex justify-end gap-3">
                      {(item.status === 'draft' || item.status === 'received') && <button type="button" disabled={busy} onClick={() => void cancel(item)} className="min-h-11 rounded-lg border border-red-300 bg-white px-3 text-sm font-bold text-red-700 disabled:opacity-50">送信を取り消す</button>}
                      {item.status === 'needs_resubmission' && <button type="button" disabled={busy} onClick={() => void startResubmission(item)} className="min-h-11 rounded-lg bg-green-600 px-4 py-2 text-base font-bold text-white disabled:opacity-50">再撮影する</button>}
                      {(item.status === 'accepted' || item.status === 'ready') && !item.arrival_reported_at && <button type="button" disabled={busy} onClick={() => void reportArrival(item)} className="min-h-11 rounded-lg bg-green-600 px-4 py-2 text-base font-bold text-white disabled:opacity-50">来局しました</button>}
                      {item.arrival_reported_at && <span className="text-sm font-medium text-green-700">到着通知済み</span>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
