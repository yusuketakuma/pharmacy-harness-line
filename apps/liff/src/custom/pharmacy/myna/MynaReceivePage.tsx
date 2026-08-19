import liff from '@line/liff';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { patientIntakeApi, type PharmacyPatient } from '../intake/api.js';
import { mynaApi, type MynaHandoff, type MynaPatientReport } from './api.js';
import { pharmacyRoute } from '../navigation.js';

const reportOptions: Array<[MynaPatientReport, string]> = [
  ['COMPLETED', '手続きを終えた'],
  ['NO_PRESCRIPTION_FOUND', '処方箋が見つからなかった'],
  ['FAILED', '操作できなかった'],
  ['SWITCH_TO_PAPER', '紙の処方箋に切り替える'],
];

export default function MynaReceivePage() {
  const navigate = useNavigate();
  const [patients, setPatients] = useState<PharmacyPatient[]>([]);
  const [patientId, setPatientId] = useState('');
  const [active, setActive] = useState<MynaHandoff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    void patientIntakeApi.list().then((result) => {
      setPatients(result.patients);
      setPatientId(result.patients[0]?.id ?? '');
    }).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : '患者情報を読み込めませんでした。');
    });
  }, []);

  async function startElectronicPrescription() {
    setBusy(true); setError(null); setSuccess(null);
    try {
      const created = await mynaApi.create('E_PRESCRIPTION', crypto.randomUUID(), patientId || undefined);
      const launched = await mynaApi.launch(created.handoff.id);
      setActive(launched.handoff);
      await liff.openWindow({ url: launched.launchUrl, external: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'マイナ受付を開けませんでした。');
    } finally { setBusy(false); }
  }

  async function report(result: MynaPatientReport) {
    if (!active) return;
    setBusy(true); setError(null); setSuccess(null);
    try {
      const response = await mynaApi.report(active.id, result);
      setActive(response.handoff);
      setSuccess('操作内容を記録しました。薬局での確認が必要です。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '操作内容を記録できませんでした。');
    } finally { setBusy(false); }
  }

  async function startMedicalInstitutionSent() {
    setBusy(true); setError(null); setSuccess(null);
    try {
      const response = await mynaApi.create('MEDICAL_INSTITUTION_SENT', crypto.randomUUID(), patientId || undefined);
      setActive(response.handoff);
      setSuccess('薬局へ確認依頼を送信しました。薬局での確認が必要です。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '確認依頼を送信できませんでした。');
    } finally { setBusy(false); }
  }

  return (
    <main className="max-w-md mx-auto min-h-screen bg-gray-50 pb-10">
      <header className="bg-white border-b px-4 py-4">
        <h1 className="text-lg font-bold text-gray-900">お薬を受け取る</h1>
        <p className="mt-1 text-xs leading-5 text-gray-600">処方せんの受け付け方法を選んでください。</p>
      </header>
      <div className="space-y-4 p-4">
        {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        {success && <div role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-800">{success}</div>}
        {patients.length === 0 ? (
          <div className="rounded-xl bg-white p-4 text-sm text-gray-700">
            <p>家族を含む患者情報を先に登録してください。</p>
            <Link to={pharmacyRoute('/pharmacy/patient-intake')} className="mt-2 inline-block font-bold text-green-700 underline">患者アンケートを開く</Link>
          </div>
        ) : (
          <label className="block rounded-xl bg-white p-4 text-sm font-medium shadow-sm">
            患者を選択
            <select value={patientId} onChange={(event) => setPatientId(event.target.value)} className="mt-2 block w-full rounded-lg border border-gray-300 p-3" disabled={busy}>
              {patients.map((patient) => <option key={patient.id} value={patient.id}>{patient.name}（{patient.birth_date}）</option>)}
            </select>
          </label>
        )}

        <section className="space-y-3" aria-label="処方せんの受け付け方法">
          <button type="button" onClick={() => void startElectronicPrescription()} disabled={busy || !patientId} className="w-full rounded-xl bg-green-600 px-4 py-4 text-left font-bold text-white disabled:bg-gray-300">
            電子処方箋を送る
            <span className="mt-1 block text-xs font-normal">マイナ保険証を使って、この薬局へ提出します</span>
          </button>
          <button type="button" onClick={() => navigate(pharmacyRoute('/prescriptions'))} disabled={busy} className="w-full rounded-xl border border-green-600 bg-white px-4 py-4 text-left font-bold text-green-700">
            紙の処方箋を送る
            <span className="mt-1 block text-xs font-normal text-gray-600">処方箋を撮影して送ります</span>
          </button>
          <button type="button" onClick={() => void startMedicalInstitutionSent()} disabled={busy || !patientId} className="w-full rounded-xl border border-gray-300 bg-white px-4 py-4 text-left font-bold text-gray-800">
            病院から送信済み
            <span className="mt-1 block text-xs font-normal text-gray-600">FAXなどで病院から送られている場合</span>
          </button>
        </section>

        {active && active.method === 'E_PRESCRIPTION' && active.status !== 'CLOSED' && (
          <section className="rounded-xl border border-amber-200 bg-amber-50 p-4" aria-labelledby="myna-report-title">
            <h2 id="myna-report-title" className="font-bold">操作後の状況を教えてください</h2>
            <p className="mt-1 text-sm text-gray-700">ボタンを押しただけでは電子処方箋の受付完了になりません。薬局での確認が必要です。</p>
            <div className="mt-3 grid gap-2">{reportOptions.map(([value, label]) => <button key={value} type="button" onClick={() => void report(value)} disabled={busy} className="rounded-lg border border-amber-300 bg-white px-3 py-3 text-sm font-medium text-gray-800 disabled:opacity-50">{label}</button>)}</div>
          </section>
        )}
        <p className="text-xs leading-5 text-gray-600">電子処方箋の本人認証・同意・提出は公式画面で行います。薬局での確認が必要です。薬局は公的システムで正式な到着を確認します。</p>
      </div>
    </main>
  );
}
