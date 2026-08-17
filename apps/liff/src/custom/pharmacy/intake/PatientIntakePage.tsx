import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  patientIntakeApi,
  type PatientIntakeAnswers,
  type PatientRelationship,
  type PatientSex,
  type PharmacyPatient,
} from './api.js';

const relationshipLabels: Record<PatientRelationship, string> = {
  self: '本人', child: '子ども', spouse: '配偶者', parent: '親', other: 'その他',
};

const initialAnswers: PatientIntakeAnswers = {
  allergiesStatus: 'none',
  adverseReactionStatus: 'none',
  medicationSummary: '',
  medicalHistory: '',
  pregnancyStatus: 'not_applicable',
  breastfeedingStatus: 'not_applicable',
  notes: '',
};

export function canSubmitIntake(
  answers: PatientIntakeAnswers,
  representativeConsent: boolean,
  privacyConsent: boolean,
  busy: boolean,
): boolean {
  return Boolean(
    answers.allergiesStatus && answers.adverseReactionStatus &&
    representativeConsent && privacyConsent && !busy,
  );
}

export default function PatientIntakePage() {
  const navigate = useNavigate();
  const [patients, setPatients] = useState<PharmacyPatient[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [latestRevision, setLatestRevision] = useState<number | null>(null);
  const [answers, setAnswers] = useState<PatientIntakeAnswers>(initialAnswers);
  const [representativeConsent, setRepresentativeConsent] = useState(false);
  const [privacyConsent, setPrivacyConsent] = useState(false);
  const [relationship, setRelationship] = useState<PatientRelationship>('self');
  const [name, setName] = useState('');
  const [nameKana, setNameKana] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [sex, setSex] = useState<PatientSex | null>(null);
  const [showNewPatient, setShowNewPatient] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const selectedPatient = useMemo(
    () => patients.find((patient) => patient.id === selectedId) ?? null,
    [patients, selectedId],
  );

  const loadPatients = useCallback(async () => {
    setLoading(true);
    try {
      const result = await patientIntakeApi.list();
      setPatients(result.patients);
      setSelectedId((current) => current || result.patients[0]?.id || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : '患者情報を読み込めませんでした。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadPatients(); }, [loadPatients]);

  useEffect(() => {
    if (!selectedId) return;
    setLatestRevision(null);
    void patientIntakeApi.latest(selectedId).then((result) => {
      const intake = result.intake;
      if (!intake) {
        setAnswers(initialAnswers);
        return;
      }
      setLatestRevision(intake.revision);
      try {
        setAnswers({ ...initialAnswers, ...(JSON.parse(intake.answers_json) as PatientIntakeAnswers) });
      } catch {
        setError('回答を読み込めませんでした。');
      }
    }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : '回答を読み込めませんでした。');
    });
  }, [selectedId]);

  async function createPatient() {
    if (!name.trim() || !nameKana.trim() || !birthDate) {
      setError('氏名・カナ・生年月日を入力してください。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const profile = {
        relationship, name, nameKana, birthDate, sex, contactPhone: null,
      };
      if (editing && selectedPatient) {
        await patientIntakeApi.updatePatient(selectedPatient.id, {
          ...profile, expectedUpdatedAt: selectedPatient.updated_at,
        });
        setPatients((current) => current.map((patient) => patient.id === selectedPatient.id
          ? { ...patient, relationship, name, name_kana: nameKana, birth_date: birthDate, sex }
          : patient));
      } else {
        const result = await patientIntakeApi.createPatient(profile);
        setPatients((current) => [...current, result.patient]);
        setSelectedId(result.patient.id);
      }
      setShowNewPatient(false);
      setEditing(false);
      setName(''); setNameKana(''); setBirthDate(''); setSex(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '患者情報を登録できませんでした。');
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!selectedId || !canSubmitIntake(answers, representativeConsent, privacyConsent, busy)) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await patientIntakeApi.submit(selectedId, {
        idempotencyKey: crypto.randomUUID(),
        answers,
        representativeConsent,
        privacyConsent,
      });
      setLatestRevision(result.intake.revision);
      setSuccess('アンケートを保存しました。処方せん事前送信へ進めます。');
      setRepresentativeConsent(false);
      setPrivacyConsent(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'アンケートを送信できませんでした。');
    } finally {
      setBusy(false);
    }
  }

  function updateAnswer<K extends keyof PatientIntakeAnswers>(key: K, value: PatientIntakeAnswers[K]) {
    setAnswers((current) => ({ ...current, [key]: value }));
  }

  return (
    <main className="max-w-md mx-auto min-h-screen bg-gray-50 pb-10">
      <header className="bg-white border-b px-4 py-4">
        <h1 className="text-lg font-bold text-gray-900">患者アンケート</h1>
        <p className="text-xs text-gray-600 mt-1">本人・ご家族の情報を薬局に伝えます。</p>
      </header>
      <div className="p-4 space-y-4">
        {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        {success && <div role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-800">{success}</div>}

        <section className="rounded-xl bg-white p-4 shadow-sm space-y-3" aria-labelledby="patient-heading">
          <div className="flex items-center justify-between gap-3">
            <h2 id="patient-heading" className="font-bold">回答する患者</h2>
            <div className="flex gap-3">
              <button type="button" className="text-sm font-bold text-green-700" onClick={() => { setEditing(false); setShowNewPatient((value) => !value); }}>
                {showNewPatient ? '一覧に戻る' : '家族を追加'}
              </button>
              {selectedPatient && !showNewPatient && <button type="button" className="text-sm font-bold text-green-700" onClick={() => { setEditing(true); setShowNewPatient(true); setRelationship(selectedPatient.relationship); setName(selectedPatient.name); setNameKana(selectedPatient.name_kana); setBirthDate(selectedPatient.birth_date); setSex(selectedPatient.sex); }}>患者情報を修正</button>}
            </div>
          </div>
          {showNewPatient ? (
            <div className="space-y-3" aria-label="家族を追加">
              <label className="block text-sm">続柄<select value={relationship} onChange={(event) => setRelationship(event.target.value as PatientRelationship)} className="mt-1 block w-full rounded-lg border p-3"><option value="self">本人</option><option value="child">子ども</option><option value="spouse">配偶者</option><option value="parent">親</option><option value="other">その他</option></select></label>
              <label className="block text-sm">氏名<input value={name} onChange={(event) => setName(event.target.value)} className="mt-1 block w-full rounded-lg border p-3" /></label>
              <label className="block text-sm">氏名カナ<input value={nameKana} onChange={(event) => setNameKana(event.target.value)} className="mt-1 block w-full rounded-lg border p-3" /></label>
              <label className="block text-sm">生年月日<input type="date" value={birthDate} onChange={(event) => setBirthDate(event.target.value)} className="mt-1 block w-full rounded-lg border p-3" /></label>
              <button type="button" onClick={() => void createPatient()} disabled={busy} className="w-full rounded-lg bg-green-600 px-4 py-3 font-bold text-white disabled:bg-gray-300">{editing ? '患者情報を更新する' : '患者を登録する'}</button>
            </div>
          ) : loading ? <p className="text-sm text-gray-500">読み込み中...</p> : patients.length === 0 ? <p className="text-sm text-gray-600">まず患者情報を登録してください。</p> : (
            <label className="block text-sm">患者を選択<select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} className="mt-1 block w-full rounded-lg border p-3" disabled={busy}>{patients.map((patient) => <option key={patient.id} value={patient.id}>{relationshipLabels[patient.relationship]}：{patient.name}</option>)}</select></label>
          )}
          {selectedPatient && <p className="text-xs text-gray-600">生年月日：{selectedPatient.birth_date}　回答版：{latestRevision ? `第${latestRevision}版` : '未回答'}</p>}
        </section>

        {!showNewPatient && selectedPatient && <>
          <section className="rounded-xl bg-white p-4 shadow-sm space-y-4" aria-labelledby="health-heading">
            <h2 id="health-heading" className="font-bold">お薬に関する確認</h2>
            <label className="block text-sm">アレルギー<select value={answers.allergiesStatus} onChange={(event) => updateAnswer('allergiesStatus', event.target.value as PatientIntakeAnswers['allergiesStatus'])} className="mt-1 block w-full rounded-lg border p-3"><option value="none">なし</option><option value="yes">あり</option><option value="unknown">わからない</option></select></label>
            <label className="block text-sm">アレルギーの内容（任意）<textarea value={answers.allergiesDetail ?? ''} onChange={(event) => updateAnswer('allergiesDetail', event.target.value)} className="mt-1 block w-full rounded-lg border p-3" rows={2} maxLength={2000} /></label>
            <label className="block text-sm">お薬で具合が悪くなった経験<select value={answers.adverseReactionStatus} onChange={(event) => updateAnswer('adverseReactionStatus', event.target.value as PatientIntakeAnswers['adverseReactionStatus'])} className="mt-1 block w-full rounded-lg border p-3"><option value="none">なし</option><option value="yes">あり</option><option value="unknown">わからない</option></select></label>
            <label className="block text-sm">その内容（任意）<textarea value={answers.adverseReactionDetail ?? ''} onChange={(event) => updateAnswer('adverseReactionDetail', event.target.value)} className="mt-1 block w-full rounded-lg border p-3" rows={2} maxLength={2000} /></label>
            <label className="block text-sm">現在使っている薬・サプリメント（任意）<textarea value={answers.medicationSummary ?? ''} onChange={(event) => updateAnswer('medicationSummary', event.target.value)} className="mt-1 block w-full rounded-lg border p-3" rows={3} maxLength={2000} /></label>
            <label className="block text-sm">既往歴・通院中の病気（任意）<textarea value={answers.medicalHistory ?? ''} onChange={(event) => updateAnswer('medicalHistory', event.target.value)} className="mt-1 block w-full rounded-lg border p-3" rows={3} maxLength={2000} /></label>
            <label className="block text-sm">薬局に伝えたいこと（任意）<textarea value={answers.notes ?? ''} onChange={(event) => updateAnswer('notes', event.target.value)} className="mt-1 block w-full rounded-lg border p-3" rows={3} maxLength={2000} /></label>
          </section>
          <section className="rounded-xl bg-white p-4 shadow-sm space-y-3">
            <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={representativeConsent} onChange={(event) => setRepresentativeConsent(event.target.checked)} className="mt-1 h-5 w-5" disabled={busy} /><span>本人または代理人として、回答内容を薬局へ伝えることに同意します。</span></label>
            <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={privacyConsent} onChange={(event) => setPrivacyConsent(event.target.checked)} className="mt-1 h-5 w-5" disabled={busy} /><span>個人情報の利用目的を確認し、薬局での調剤・連絡に同意します。</span></label>
          </section>
          <button type="button" onClick={() => void submit()} disabled={!canSubmitIntake(answers, representativeConsent, privacyConsent, busy)} className="w-full rounded-xl bg-green-600 px-4 py-4 font-bold text-white disabled:bg-gray-300">{busy ? '保存中…' : latestRevision ? '回答を更新する' : 'アンケートを送信する'}</button>
          <button type="button" onClick={() => navigate('/prescriptions')} className="w-full rounded-xl border border-green-600 bg-white px-4 py-3 font-bold text-green-700">処方せん事前送信へ</button>
          <p className="text-xs leading-5 text-gray-600">回答内容は薬局の確認に使います。緊急時は医療機関へご相談ください。</p>
        </>}
      </div>
    </main>
  );
}
