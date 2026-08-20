import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  patientIntakeApi,
  type PatientIntakeAnswers,
  type PatientRelationship,
  type PharmacyPatient,
  type TenantPrivacyPolicy,
} from './api.js';
import {
  emptyPatientProfileDraft,
  patientProfileDraft,
  PatientProfileForm,
  type PatientProfileDraft,
} from './PatientProfileForm.js';
import {
  INITIAL_INTAKE_ANSWERS,
  INTAKE_STEP_COUNT,
  PatientQuestionnaire,
} from './PatientQuestionnaire.js';
import { pharmacyRoute } from '../navigation.js';

const relationshipLabels: Record<PatientRelationship, string> = {
  self: '本人', child: '子ども', spouse: '配偶者', parent: '親', other: 'その他',
};

const intakeDraftKey = (patientId: string) => `pharmacy_intake_draft:${patientId}`;

function readIntakeDraft(patientId: string): {
  answers: PatientIntakeAnswers
  intakeStep: number
} | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(intakeDraftKey(patientId)) ?? 'null') as {
      answers?: unknown
      intakeStep?: unknown
    } | null;
    return parsed && typeof parsed.answers === 'object' && parsed.answers !== null &&
      Number.isInteger(parsed.intakeStep) && Number(parsed.intakeStep) >= 1 &&
      Number(parsed.intakeStep) <= INTAKE_STEP_COUNT
      ? { answers: parsed.answers as PatientIntakeAnswers, intakeStep: Number(parsed.intakeStep) }
      : null;
  } catch {
    return null;
  }
}

export function canSubmitIntake(
  answers: PatientIntakeAnswers,
  representativeConsent: boolean,
  privacyConsent: boolean,
  busy: boolean,
): boolean {
  return Boolean(
    answers.allergiesStatus && answers.adverseReactionStatus &&
    answers.medicationStatus && answers.medicalHistoryStatus && answers.medicationNotebook &&
    representativeConsent && privacyConsent && !busy,
  );
}

export default function PatientIntakePage() {
  const navigate = useNavigate();
  const [patients, setPatients] = useState<PharmacyPatient[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [latestRevision, setLatestRevision] = useState<number | null>(null);
  const [latestAnswers, setLatestAnswers] = useState<PatientIntakeAnswers | null>(null);
  const [answers, setAnswers] = useState<PatientIntakeAnswers>(INITIAL_INTAKE_ANSWERS);
  const [intakeStep, setIntakeStep] = useState(1);
  const [draftPatientId, setDraftPatientId] = useState('');
  const [representativeConsent, setRepresentativeConsent] = useState(false);
  const [privacyConsent, setPrivacyConsent] = useState(false);
  const [privacyPolicy, setPrivacyPolicy] = useState<TenantPrivacyPolicy | null>(null);
  const [patientDraft, setPatientDraft] = useState<PatientProfileDraft>(
    () => emptyPatientProfileDraft('self'),
  );
  const [showAddress, setShowAddress] = useState(false);
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
  const patientSex = showNewPatient ? patientDraft.sex : selectedPatient?.sex;
  const showPregnancyQuestions = patientSex !== 'male' ||
    answers.pregnancyStatus !== 'not_applicable' || answers.breastfeedingStatus !== 'not_applicable';

  const loadPatients = useCallback(async () => {
    setLoading(true);
    try {
      const result = await patientIntakeApi.list();
      setPatients(result.patients);
      setSelectedId((current) => current || result.patients[0]?.id || '');
      if (result.patients.length === 0) {
        setPatientDraft(emptyPatientProfileDraft('self'));
        setShowNewPatient(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '患者情報を読み込めませんでした。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadPatients(); }, [loadPatients]);

  // 薬局が掲示する利用目的。未設定でも同意欄は中立文言で表示し、送信は妨げない。
  useEffect(() => {
    let active = true;
    patientIntakeApi.privacyPolicy()
      .then((result) => { if (active) setPrivacyPolicy(result.policy); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    setDraftPatientId('');
    setIntakeStep(1);
    setLatestRevision(null);
    setLatestAnswers(null);
    void patientIntakeApi.latest(selectedId).then((result) => {
      if (!active) return;
      const intake = result.intake;
      const draft = readIntakeDraft(selectedId);
      if (!intake) {
        setAnswers(draft?.answers ?? INITIAL_INTAKE_ANSWERS);
        setIntakeStep(draft?.intakeStep ?? 1);
        return;
      }
      setLatestRevision(intake.revision);
      try {
        const savedAnswers = {
          ...INITIAL_INTAKE_ANSWERS,
          ...(JSON.parse(intake.answers_json) as PatientIntakeAnswers),
        };
        setLatestAnswers(savedAnswers);
        setAnswers(draft?.answers ?? savedAnswers);
        setIntakeStep(draft?.intakeStep ?? 1);
      } catch {
        setError('回答を読み込めませんでした。');
      }
    }).catch((err: unknown) => {
      if (!active) return;
      const draft = readIntakeDraft(selectedId);
      if (draft) {
        setAnswers(draft.answers);
        setIntakeStep(draft.intakeStep);
      }
      setError(err instanceof Error ? err.message : '回答を読み込めませんでした。');
    }).finally(() => {
      if (active) setDraftPatientId(selectedId);
    });
    return () => { active = false; };
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId || draftPatientId !== selectedId) return;
    sessionStorage.setItem(intakeDraftKey(selectedId), JSON.stringify({ answers, intakeStep }));
  }, [answers, draftPatientId, intakeStep, selectedId]);

  async function createPatient() {
    const {
      relationship,
      name,
      nameKana,
      birthDate,
      sex,
      contactPhone,
      postalCode,
      prefecture,
      city,
      addressLine1,
      addressLine2,
    } = patientDraft;
    if (!name.trim() || !nameKana.trim() || !birthDate) {
      setError('氏名・カナ・生年月日を入力してください。');
      return;
    }
    const hasAddress = Boolean(
      postalCode.trim() || prefecture || city.trim() || addressLine1.trim() || addressLine2.trim(),
    );
    if (hasAddress && (!/^\d{3}-?\d{4}$/.test(postalCode.trim()) || !prefecture || !city.trim() || !addressLine1.trim())) {
      setError('住所を登録する場合は、郵便番号・都道府県・市区町村・番地を入力してください。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const profile = {
        relationship, name, nameKana, birthDate, sex,
        contactPhone: contactPhone.trim() || null,
        postalCode: postalCode.trim() || null,
        prefecture: prefecture || null,
        city: city.trim() || null,
        addressLine1: addressLine1.trim() || null,
        addressLine2: addressLine2.trim() || null,
      };
      if (editing && selectedPatient) {
        await patientIntakeApi.updatePatient(selectedPatient.id, {
          ...profile, expectedUpdatedAt: selectedPatient.updated_at,
        });
        setPatients((current) => current.map((patient) => patient.id === selectedPatient.id
          ? {
            ...patient, relationship, name, name_kana: nameKana, birth_date: birthDate, sex,
            contact_phone: profile.contactPhone, postal_code: profile.postalCode,
            prefecture: profile.prefecture, city: profile.city,
            address_line1: profile.addressLine1, address_line2: profile.addressLine2,
          }
          : patient));
      } else {
        const result = await patientIntakeApi.createPatient(profile);
        setPatients((current) => [...current, result.patient]);
        setSelectedId(result.patient.id);
      }
      setShowNewPatient(false);
      setEditing(false);
      setPatientDraft(emptyPatientProfileDraft(relationship));
      setShowAddress(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '患者情報を登録できませんでした。');
    } finally {
      setBusy(false);
    }
  }

  async function saveIntake(
    nextAnswers: PatientIntakeAnswers,
    nextRepresentativeConsent: boolean,
    nextPrivacyConsent: boolean,
  ) {
    if (!selectedId || busy) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await patientIntakeApi.submit(selectedId, {
        idempotencyKey: crypto.randomUUID(),
        answers: nextAnswers,
        representativeConsent: nextRepresentativeConsent,
        privacyConsent: nextPrivacyConsent,
      });
      setLatestRevision(result.intake.revision);
      setLatestAnswers(nextAnswers);
      setAnswers(nextAnswers);
      sessionStorage.removeItem(intakeDraftKey(selectedId));
      setSuccess('アンケートを保存しました。処方せん事前送信へ進めます。');
      setRepresentativeConsent(false);
      setPrivacyConsent(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'アンケートを送信できませんでした。');
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!canSubmitIntake(answers, representativeConsent, privacyConsent, busy)) return;
    await saveIntake(answers, representativeConsent, privacyConsent);
  }

  async function confirmUnchanged() {
    if (!latestAnswers || busy || !window.confirm(
      '前回の回答から変更がないことを確認します。本人または代理人として回答内容を薬局へ伝え、個人情報の利用目的を確認したうえで調剤・連絡に利用することに同意しますか？',
    )) return;
    await saveIntake(latestAnswers, true, true);
  }

  function updatePatientDraft<K extends keyof PatientProfileDraft>(
    key: K,
    value: PatientProfileDraft[K],
  ) {
    setPatientDraft((current) => ({ ...current, [key]: value }));
  }

  function resetPatientForm(relationshipValue: PatientRelationship) {
    setEditing(false);
    setPatientDraft(emptyPatientProfileDraft(relationshipValue));
    setShowAddress(false);
    setShowNewPatient(true);
  }

  return (
    <main className="max-w-md mx-auto min-h-screen bg-gray-50 pb-10">
      <header className="bg-white border-b px-4 py-4">
        <h1 className="text-lg font-bold text-gray-900">患者アンケート</h1>
        <p className="text-xs text-gray-600 mt-1">本人・ご家族の情報を薬局に伝えます。</p>
        <p className="mt-2 text-xs font-medium text-green-700">入力目安：約1分　選択式中心・詳細は任意</p>
      </header>
      <div className="p-4 space-y-4">
        {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        {success && <div role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-800">{success}</div>}

        <section className="rounded-xl bg-white p-4 shadow-sm space-y-3" aria-labelledby="patient-heading">
          <div className="flex items-center justify-between gap-3">
            <h2 id="patient-heading" className="font-bold">回答する患者</h2>
            <div className="flex gap-3">
              <button type="button" className="text-sm font-bold text-green-700" onClick={() => {
                if (showNewPatient) setShowNewPatient(false);
                else resetPatientForm(patients.length === 0 ? 'self' : 'child');
              }}>
                {showNewPatient ? '一覧に戻る' : patients.length === 0 ? '本人を登録' : '家族を追加'}
              </button>
              {selectedPatient && !showNewPatient && <button type="button" className="text-sm font-bold text-green-700" onClick={() => {
                setEditing(true);
                setShowNewPatient(true);
                setPatientDraft(patientProfileDraft(selectedPatient));
                setShowAddress(Boolean(selectedPatient.postal_code || selectedPatient.prefecture || selectedPatient.city || selectedPatient.address_line1 || selectedPatient.address_line2));
              }}>患者情報を修正</button>}
            </div>
          </div>
          {showNewPatient ? (
            <PatientProfileForm
              draft={patientDraft}
              editing={editing}
              busy={busy}
              showAddress={showAddress}
              onChange={updatePatientDraft}
              onToggleAddress={() => setShowAddress((value) => !value)}
              onSubmit={() => void createPatient()}
            />
          ) : loading ? <p className="text-sm text-gray-500">読み込み中...</p> : patients.length === 0 ? <p className="text-sm text-gray-600">まず患者情報を登録してください。</p> : (
            <label className="block text-sm">患者を選択<select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} className="mt-1 block w-full rounded-lg border p-3" disabled={busy}>{patients.map((patient) => <option key={patient.id} value={patient.id}>{relationshipLabels[patient.relationship]}：{patient.name}</option>)}</select></label>
          )}
          {selectedPatient && <p className="text-xs text-gray-600">生年月日：{selectedPatient.birth_date}　回答版：{latestRevision ? `第${latestRevision}版` : '未回答'}</p>}
        </section>

        {!showNewPatient && selectedPatient && <>
          {latestAnswers && (
            <button
              type="button"
              onClick={() => void confirmUnchanged()}
              disabled={busy}
              className="w-full rounded-xl border border-green-600 bg-white px-4 py-3 font-bold text-green-700 disabled:opacity-50"
            >
              {busy ? '更新中…' : '前回から変更なしで更新'}
            </button>
          )}
          <PatientQuestionnaire
            answers={answers}
            step={intakeStep}
            busy={busy}
            showPregnancyQuestions={showPregnancyQuestions}
            representativeConsent={representativeConsent}
            privacyConsent={privacyConsent}
            privacyPolicy={privacyPolicy}
            onAnswersChange={setAnswers}
            onRepresentativeConsentChange={setRepresentativeConsent}
            onPrivacyConsentChange={setPrivacyConsent}
          />
          <div className="flex gap-3">
            <button type="button" onClick={() => setIntakeStep((step) => Math.max(1, step - 1))} disabled={intakeStep === 1 || busy} className="min-h-11 flex-1 rounded-xl border border-gray-300 bg-white px-4 py-3 font-bold text-gray-700 disabled:opacity-40">戻る</button>
            {intakeStep < INTAKE_STEP_COUNT ? <button type="button" onClick={() => setIntakeStep((step) => Math.min(INTAKE_STEP_COUNT, step + 1))} disabled={busy} className="min-h-11 flex-1 rounded-xl bg-green-600 px-4 py-3 font-bold text-white disabled:bg-gray-300">次へ</button> : <button type="button" onClick={() => void submit()} disabled={!canSubmitIntake(answers, representativeConsent, privacyConsent, busy)} className="min-h-11 flex-1 rounded-xl bg-green-600 px-4 py-3 font-bold text-white disabled:bg-gray-300">{busy ? '保存中…' : latestRevision ? '回答を更新する' : 'アンケートを送信する'}</button>}
          </div>
          <button type="button" onClick={() => navigate(pharmacyRoute('/prescriptions'))} className="w-full rounded-xl border border-green-600 bg-white px-4 py-3 font-bold text-green-700">処方せん事前送信へ</button>
          <p className="text-xs leading-5 text-gray-600">回答内容は薬局の確認に使います。緊急時は医療機関へご相談ください。</p>
        </>}
      </div>
    </main>
  );
}
