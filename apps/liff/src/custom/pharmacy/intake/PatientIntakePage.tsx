import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
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
  patientProfileErrors,
  PatientProfileForm,
  type PatientProfileDraft,
  type PatientProfileErrors,
} from './PatientProfileForm.js';
import {
  INITIAL_INTAKE_ANSWERS,
  INTAKE_STEP_COUNT,
  PatientQuestionnaire,
  safetyUnansweredKeys,
  type IntakeAnswersDraft,
} from './PatientQuestionnaire.js';
import { pharmacyRoute } from '../navigation.js';
import { pharmacyErrorMessage } from '../request.js';

const relationshipLabels: Record<PatientRelationship, string> = {
  self: '本人', child: '子ども', spouse: '配偶者', parent: '親', other: 'その他',
};

export function canSubmitIntake(
  answers: IntakeAnswersDraft,
  representativeConsent: boolean,
  privacyConsent: boolean,
  busy: boolean,
  privacyPolicyAvailable = false,
): boolean {
  return Boolean(
    answers.allergiesStatus && answers.adverseReactionStatus &&
    answers.medicationStatus && answers.medicalHistoryStatus && answers.medicationNotebook &&
    representativeConsent && privacyConsent && privacyPolicyAvailable && !busy,
  );
}

export default function PatientIntakePage() {
  const navigate = useNavigate();
  const [patients, setPatients] = useState<PharmacyPatient[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [latestRevision, setLatestRevision] = useState<number | null>(null);
  const [latestAnswers, setLatestAnswers] = useState<PatientIntakeAnswers | null>(null);
  const [answers, setAnswers] = useState<IntakeAnswersDraft>(INITIAL_INTAKE_ANSWERS);
  const [intakeStep, setIntakeStep] = useState(1);
  const [showStepErrors, setShowStepErrors] = useState(false);
  const [profileErrors, setProfileErrors] = useState<PatientProfileErrors>({});
  const [saved, setSaved] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const [representativeConsent, setRepresentativeConsent] = useState(false);
  const [privacyConsent, setPrivacyConsent] = useState(false);
  const [privacyPolicy, setPrivacyPolicy] = useState<TenantPrivacyPolicy | null>(null);
  const [privacyPolicyLoading, setPrivacyPolicyLoading] = useState(true);
  const [privacyPolicyError, setPrivacyPolicyError] = useState<string | null>(null);
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
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error || privacyPolicyError) {
      errorRef.current?.focus();
      errorRef.current?.scrollIntoView({ block: 'center' });
    }
  }, [error, privacyPolicyError]);

  useEffect(() => {
    if (!draftDirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const handleLinkClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest('a') : null;
      if (!target || target.target === '_blank' || target.hasAttribute('download')) return;
      if (!window.confirm('未送信の入力があります。画面を離れますか？')) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('click', handleLinkClick, true);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('click', handleLinkClick, true);
    };
  }, [draftDirty]);

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
      setError(pharmacyErrorMessage(err, '患者情報を読み込めませんでした。'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadPatients(); }, [loadPatients]);

  const loadPrivacyPolicy = useCallback(async (isActive: () => boolean = () => true) => {
    setPrivacyPolicyLoading(true);
    setPrivacyPolicy(null);
    setPrivacyPolicyError(null);
    try {
      const result = await patientIntakeApi.privacyPolicy();
      if (!isActive()) return;
      if (!result.policy) {
        setPrivacyPolicyError('この薬局では個人情報の利用目的が設定されていないため、アンケートを送信できません。薬局へお問い合わせください。');
        return;
      }
      setPrivacyConsent(false);
      setPrivacyPolicy(result.policy);
    } catch (err) {
      if (isActive()) {
        setPrivacyPolicyError(pharmacyErrorMessage(err, '個人情報の利用目的を確認できませんでした。再読み込みしてください。'));
      }
    } finally {
      if (isActive()) setPrivacyPolicyLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void loadPrivacyPolicy(() => active);
    return () => { active = false; };
  }, [loadPrivacyPolicy]);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    setDraftDirty(false);
    setIntakeStep(1);
    setLatestRevision(null);
    setLatestAnswers(null);
    void patientIntakeApi.latest(selectedId).then((result) => {
      if (!active) return;
      const intake = result.intake;
      if (!intake) {
        setAnswers(INITIAL_INTAKE_ANSWERS);
        setIntakeStep(1);
        return;
      }
      setLatestRevision(intake.revision);
      try {
        const savedAnswers = {
          ...INITIAL_INTAKE_ANSWERS,
          ...(JSON.parse(intake.answers_json) as PatientIntakeAnswers),
        };
        setLatestAnswers(savedAnswers);
        setAnswers(savedAnswers);
        setIntakeStep(1);
      } catch {
        setError('回答を読み込めませんでした。');
      }
    }).catch((err: unknown) => {
      if (!active) return;
      setError(pharmacyErrorMessage(err, '回答を読み込めませんでした。'));
    });
    return () => { active = false; };
  }, [selectedId]);

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
    const errors = patientProfileErrors(patientDraft);
    setProfileErrors(errors);
    if (Object.keys(errors).length > 0) {
      setError('赤く表示された項目を確認してください。');
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
      setProfileErrors({});
      setDraftDirty(false);
    } catch (err) {
      setError(pharmacyErrorMessage(err, '患者情報を登録できませんでした。'));
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
    if (!privacyPolicy) {
      setPrivacyPolicyError('個人情報の利用目的を確認できないため、アンケートを送信できません。薬局へお問い合わせください。');
      return;
    }
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await patientIntakeApi.submit(selectedId, {
        idempotencyKey: crypto.randomUUID(),
        answers: nextAnswers,
        representativeConsent: nextRepresentativeConsent,
        privacyConsent: nextPrivacyConsent,
        privacyPolicyVersion: privacyPolicy.policy_version,
        privacyPolicyHash: privacyPolicy.content_hash,
      });
      setLatestRevision(result.intake.revision);
      setLatestAnswers(nextAnswers);
      setAnswers(nextAnswers);
      setDraftDirty(false);
      setSuccess('アンケートを保存しました。');
      setSaved(true);
      setRepresentativeConsent(false);
      setPrivacyConsent(false);
      setShowStepErrors(false);
      window.scrollTo(0, 0);
    } catch (err) {
      if (err instanceof Error &&
          (err as Error & { status?: unknown }).status === 409) {
        setPrivacyConsent(false);
        await loadPrivacyPolicy();
      }
      setError(pharmacyErrorMessage(err, 'アンケートを送信できませんでした。'));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!canSubmitIntake(answers, representativeConsent, privacyConsent, busy, privacyPolicy !== null)) return;
    // canSubmitIntake guarantees the four safety answers are no longer ''.
    await saveIntake(answers as PatientIntakeAnswers, representativeConsent, privacyConsent);
  }

  function nextStep() {
    if (safetyUnansweredKeys(answers, intakeStep).length > 0) {
      setShowStepErrors(true);
      setError('赤く表示された質問に答えてから「次へ」を押してください。');
      return;
    }
    setShowStepErrors(false);
    setError(null);
    setDraftDirty(true);
    setIntakeStep((step) => Math.min(INTAKE_STEP_COUNT, step + 1));
  }

  const updateAnswers = useCallback((update: SetStateAction<IntakeAnswersDraft>) => {
    setAnswers(update);
    setDraftDirty(true);
    setSaved(false);
  }, []);

  async function confirmUnchanged() {
    if (!latestAnswers || busy || !privacyPolicy || !window.confirm(
      '前回の回答から変更がないことを確認します。本人または代理人として回答内容を薬局へ伝え、個人情報の利用目的を確認したうえで調剤・連絡に利用することに同意しますか？',
    )) return;
    await saveIntake(latestAnswers, true, true);
  }

  function updatePatientDraft<K extends keyof PatientProfileDraft>(
    key: K,
    value: PatientProfileDraft[K],
  ) {
    setPatientDraft((current) => ({ ...current, [key]: value }));
    setDraftDirty(true);
    setSaved(false);
  }

  function resetPatientForm(relationshipValue: PatientRelationship) {
    setProfileErrors({});
    setEditing(false);
    setPatientDraft(emptyPatientProfileDraft(relationshipValue));
    setShowAddress(false);
    setShowNewPatient(true);
  }

  function confirmIntakeNavigation(): boolean {
    if (draftDirty && !window.confirm('未送信の入力があります。画面を離れますか？')) return false;
    setDraftDirty(false);
    return true;
  }

  return (
    <main className="pharmacy-main max-w-md mx-auto">
      <div className="p-4 space-y-4">
        <p className="text-sm leading-6 text-gray-600">本人・ご家族の情報を薬局に伝えます。入力目安：約1分、選択式中心で詳細は任意です。</p>
        {error && <div ref={errorRef} tabIndex={-1} role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700 focus:outline-none">{error}</div>}
        {privacyPolicyLoading && <p role="status" className="rounded-lg bg-gray-50 p-3 text-sm text-gray-700">個人情報の利用目的を確認しています...</p>}
        {privacyPolicyError && <div ref={errorRef} tabIndex={-1} role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700 focus:outline-none">
          <p>{privacyPolicyError}</p>
          <button type="button" onClick={() => void loadPrivacyPolicy()} disabled={privacyPolicyLoading} className="pharmacy-control min-h-11 mt-2 rounded-lg border border-red-300 bg-white px-4 py-2 font-bold disabled:opacity-50">再読み込み</button>
        </div>}
        {success && <div role="status" className="rounded-lg border border-green-200 bg-green-50 p-4 text-base text-green-800">
          <p className="font-bold">{success}</p>
          {saved && <>
            <p className="mt-2 font-bold">次にすること</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              <li>続けて処方せんを送る場合は、下の「処方せん事前送信へ」を押してください。</li>
              <li>体調やお薬に変化があったときは、この画面から回答を更新できます。</li>
            </ul>
            <button type="button" onClick={() => { if (confirmIntakeNavigation()) navigate(pharmacyRoute('/pharmacy/menu')); }} className="pharmacy-control min-h-11 mt-3 w-full rounded-xl border border-green-700 bg-white px-4 py-2 font-bold text-green-800">すべての機能へ戻る</button>
          </>}
        </div>}

        <section className="rounded-xl bg-white p-4 shadow-sm space-y-3" aria-labelledby="patient-heading">
          <div className="flex items-center justify-between gap-3">
            <h2 id="patient-heading" className="font-bold">回答する患者</h2>
            <div className="flex gap-3">
              <button type="button" className="pharmacy-control min-h-11 text-base font-bold text-green-800" onClick={() => {
                if (showNewPatient) setShowNewPatient(false);
                else resetPatientForm(patients.length === 0 ? 'self' : 'child');
              }}>
                {showNewPatient ? '一覧に戻る' : patients.length === 0 ? '本人を登録' : '家族を追加'}
              </button>
              {selectedPatient && !showNewPatient && <button type="button" className="pharmacy-control min-h-11 text-base font-bold text-green-800" onClick={() => {
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
              errors={profileErrors}
              onChange={updatePatientDraft}
              onToggleAddress={() => setShowAddress((value) => !value)}
              onSubmit={() => void createPatient()}
            />
          ) : loading ? <p className="text-sm text-gray-500">読み込み中...</p> : patients.length === 0 ? <p className="text-sm text-gray-600">まず患者情報を登録してください。</p> : (
            <label className="block text-sm">患者を選択<select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} className="mt-1 block w-full rounded-lg border p-3" disabled={busy}>{patients.map((patient) => <option key={patient.id} value={patient.id}>{relationshipLabels[patient.relationship]}：{patient.name}</option>)}</select></label>
          )}
          {selectedPatient && <p className="text-sm text-gray-700">生年月日：{selectedPatient.birth_date}　回答版：{latestRevision ? `第${latestRevision}版` : '未回答'}</p>}
        </section>

        {!showNewPatient && selectedPatient && <>
          {latestAnswers && (
            <button
              type="button"
              onClick={() => void confirmUnchanged()}
              disabled={busy}
              className="w-full rounded-xl border border-green-700 bg-white px-4 py-3 font-bold text-green-800 disabled:opacity-50"
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
            showErrors={showStepErrors}
            onAnswersChange={updateAnswers}
            onRepresentativeConsentChange={(value) => { setRepresentativeConsent(value); setDraftDirty(true); setSaved(false); }}
            onPrivacyConsentChange={(value) => { setPrivacyConsent(value); setDraftDirty(true); setSaved(false); }}
          />
          {intakeStep === INTAKE_STEP_COUNT && !canSubmitIntake(answers, representativeConsent, privacyConsent, false, privacyPolicy !== null) && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <p className="font-bold">送信するには、次を確認してください</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {(['allergiesStatus', 'adverseReactionStatus', 'medicationStatus', 'medicalHistoryStatus'] as const).some((key) => !answers[key]) && <li>安全確認の質問（ステップ1・2）に未回答があります。「戻る」で回答してください。</li>}
              {!representativeConsent && <li>回答内容を薬局へ伝えることへの同意にチェックしてください。</li>}
              {!privacyConsent && <li>個人情報の利用目的への同意にチェックしてください。</li>}
              {!privacyPolicy && <li>個人情報の利用目的を確認できるまで送信できません。薬局へお問い合わせください。</li>}
            </ul>
          </div>}
          <div className="flex gap-3">
            <button type="button" onClick={() => setIntakeStep((step) => Math.max(1, step - 1))} disabled={intakeStep === 1 || busy} className="min-h-11 flex-1 rounded-xl border border-gray-300 bg-white px-4 py-3 font-bold text-gray-700 disabled:opacity-40">戻る</button>
            {intakeStep < INTAKE_STEP_COUNT ? <button type="button" onClick={nextStep} disabled={busy} className="min-h-11 flex-1 rounded-xl bg-green-700 px-4 py-3 font-bold text-white disabled:bg-gray-300">次へ</button> : <button type="button" onClick={() => void submit()} disabled={!canSubmitIntake(answers, representativeConsent, privacyConsent, busy, privacyPolicy !== null)} className="min-h-11 flex-1 rounded-xl bg-green-700 px-4 py-3 font-bold text-white disabled:bg-gray-300">{busy ? '保存中…' : latestRevision ? '回答を更新する' : 'アンケートを送信する'}</button>}
          </div>
          <button type="button" onClick={() => { if (confirmIntakeNavigation()) navigate(pharmacyRoute('/prescriptions')); }} className="pharmacy-control min-h-11 w-full rounded-xl border border-green-700 bg-white px-4 py-3 font-bold text-green-800">処方せん事前送信へ</button>
          <p className="text-sm leading-5 text-gray-700">回答内容は薬局の確認に使います。緊急時は医療機関へご相談ください。</p>
        </>}
      </div>
    </main>
  );
}
