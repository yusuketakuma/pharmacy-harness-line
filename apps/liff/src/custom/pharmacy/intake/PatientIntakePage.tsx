import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  patientIntakeApi,
  type MedicalHistoryTag,
  type PatientIntakeAnswers,
  type PatientRelationship,
  type PatientSex,
  type PharmacyPatient,
} from './api.js';

const relationshipLabels: Record<PatientRelationship, string> = {
  self: '本人', child: '子ども', spouse: '配偶者', parent: '親', other: 'その他',
};

const prefectures = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
  '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
] as const;

const medicalHistoryTagOptions: ReadonlyArray<{ value: MedicalHistoryTag; label: string }> = [
  { value: 'hypertension', label: '高血圧' },
  { value: 'diabetes', label: '糖尿病' },
  { value: 'dyslipidemia', label: '脂質異常症' },
  { value: 'heart_disease', label: '心臓の病気' },
  { value: 'kidney_disease', label: '腎臓の病気' },
  { value: 'liver_disease', label: '肝臓の病気' },
  { value: 'asthma', label: '喘息' },
  { value: 'other', label: 'その他' },
];

const statusOptions = [
  { value: 'none', label: 'なし' },
  { value: 'yes', label: 'あり' },
  { value: 'unknown', label: 'わからない' },
] as const;

const notebookOptions = [
  { value: 'paper', label: '紙' },
  { value: 'electronic', label: '電子' },
  { value: 'none', label: 'なし' },
  { value: 'unknown', label: 'わからない' },
] as const;

const pregnancyOptions = [
  { value: 'not_applicable', label: '該当しない' },
  { value: 'yes', label: 'あり' },
  { value: 'no', label: 'なし' },
  { value: 'unknown', label: 'わからない' },
] as const;

const smokingOptions = [
  { value: 'never', label: '吸わない' },
  { value: 'former', label: '過去に吸っていた' },
  { value: 'current', label: '現在吸っている' },
  { value: 'unknown', label: 'わからない' },
] as const;

const alcoholOptions = [
  { value: 'none', label: '飲まない' },
  { value: 'occasional', label: 'たまに' },
  { value: 'weekly', label: '週1〜2日' },
  { value: 'frequent', label: '週3日以上' },
  { value: 'unknown', label: 'わからない' },
] as const;

const adherenceOptions = [
  { value: 'none', label: 'ほぼない' },
  { value: 'sometimes', label: 'ときどきある' },
  { value: 'often', label: 'よくある' },
  { value: 'unknown', label: 'わからない' },
] as const;

const intakeSteps = ['安全確認', '体調・生活', '確認・送信'] as const;

function ChoiceField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm">{label}</legend>
      <div className="grid grid-cols-2 gap-2">
        {options.map((option) => (
          <label key={option.value} className="cursor-pointer">
            <input
              type="radio"
              name={label}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="peer sr-only"
            />
            <span className="flex min-h-11 items-center justify-center rounded-lg border border-gray-300 px-3 py-2 text-sm peer-checked:border-green-600 peer-checked:bg-green-50 peer-checked:font-bold peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-green-600">
              {option.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const initialAnswers: PatientIntakeAnswers = {
  allergiesStatus: 'none',
  adverseReactionStatus: 'none',
  medicationStatus: 'none',
  medicationSummary: '',
  medicalHistoryStatus: 'none',
  medicalHistoryTags: [],
  medicalHistory: '',
  medicationNotebook: 'unknown',
  smokingStatus: 'unknown',
  alcoholStatus: 'unknown',
  medicationAdherence: 'unknown',
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
    answers.medicationStatus && answers.medicalHistoryStatus && answers.medicationNotebook &&
    representativeConsent && privacyConsent && !busy,
  );
}

export default function PatientIntakePage() {
  const navigate = useNavigate();
  const [patients, setPatients] = useState<PharmacyPatient[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [latestRevision, setLatestRevision] = useState<number | null>(null);
  const [answers, setAnswers] = useState<PatientIntakeAnswers>(initialAnswers);
  const [intakeStep, setIntakeStep] = useState(1);
  const [representativeConsent, setRepresentativeConsent] = useState(false);
  const [privacyConsent, setPrivacyConsent] = useState(false);
  const [relationship, setRelationship] = useState<PatientRelationship>('self');
  const [name, setName] = useState('');
  const [nameKana, setNameKana] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [sex, setSex] = useState<PatientSex | null>(null);
  const [contactPhone, setContactPhone] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [prefecture, setPrefecture] = useState('');
  const [city, setCity] = useState('');
  const [addressLine1, setAddressLine1] = useState('');
  const [addressLine2, setAddressLine2] = useState('');
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
  const patientSex = showNewPatient ? sex : selectedPatient?.sex;
  const showPregnancyQuestions = patientSex !== 'male' ||
    answers.pregnancyStatus !== 'not_applicable' || answers.breastfeedingStatus !== 'not_applicable';

  const loadPatients = useCallback(async () => {
    setLoading(true);
    try {
      const result = await patientIntakeApi.list();
      setPatients(result.patients);
      setSelectedId((current) => current || result.patients[0]?.id || '');
      if (result.patients.length === 0) {
        setRelationship('self');
        setShowNewPatient(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '患者情報を読み込めませんでした。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadPatients(); }, [loadPatients]);

  useEffect(() => {
    if (!selectedId) return;
    setIntakeStep(1);
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
      setName(''); setNameKana(''); setBirthDate(''); setSex(null);
      setContactPhone(''); setPostalCode(''); setPrefecture(''); setCity('');
      setAddressLine1(''); setAddressLine2(''); setShowAddress(false);
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

  function resetPatientForm(relationshipValue: PatientRelationship) {
    setEditing(false);
    setRelationship(relationshipValue);
    setName(''); setNameKana(''); setBirthDate(''); setSex(null);
    setContactPhone(''); setPostalCode(''); setPrefecture(''); setCity('');
    setAddressLine1(''); setAddressLine2(''); setShowAddress(false);
    setShowNewPatient(true);
  }

  function toggleMedicalHistoryTag(tag: MedicalHistoryTag) {
    setAnswers((current) => ({
      ...current,
      medicalHistoryTags: current.medicalHistoryTags.includes(tag)
        ? current.medicalHistoryTags.filter((value) => value !== tag)
        : [...current.medicalHistoryTags, tag],
    }));
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
                setEditing(true); setShowNewPatient(true); setRelationship(selectedPatient.relationship);
                setName(selectedPatient.name); setNameKana(selectedPatient.name_kana); setBirthDate(selectedPatient.birth_date);
                setSex(selectedPatient.sex); setContactPhone(selectedPatient.contact_phone ?? '');
                setPostalCode(selectedPatient.postal_code ?? ''); setPrefecture(selectedPatient.prefecture ?? '');
                setCity(selectedPatient.city ?? ''); setAddressLine1(selectedPatient.address_line1 ?? '');
                setAddressLine2(selectedPatient.address_line2 ?? '');
                setShowAddress(Boolean(selectedPatient.postal_code || selectedPatient.prefecture || selectedPatient.city || selectedPatient.address_line1 || selectedPatient.address_line2));
              }}>患者情報を修正</button>}
            </div>
          </div>
          {showNewPatient ? (
            <div className="space-y-3" aria-label="家族を追加">
              <label className="block text-sm">続柄<select value={relationship} onChange={(event) => setRelationship(event.target.value as PatientRelationship)} className="mt-1 block w-full rounded-lg border p-3"><option value="self">本人</option><option value="child">子ども</option><option value="spouse">配偶者</option><option value="parent">親</option><option value="other">その他</option></select></label>
              <label className="block text-sm">氏名<input required autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} className="mt-1 block w-full rounded-lg border p-3" /></label>
              <label className="block text-sm">氏名カナ<input required autoComplete="off" value={nameKana} onChange={(event) => setNameKana(event.target.value)} className="mt-1 block w-full rounded-lg border p-3" /></label>
              <label className="block text-sm">生年月日<input required type="date" autoComplete="bday" value={birthDate} onChange={(event) => setBirthDate(event.target.value)} className="mt-1 block w-full rounded-lg border p-3" /></label>
              <label className="block text-sm">性別（任意）<select value={sex ?? ''} onChange={(event) => setSex((event.target.value || null) as PatientSex | null)} className="mt-1 block w-full rounded-lg border p-3"><option value="">回答しない</option><option value="male">男性</option><option value="female">女性</option><option value="other">その他</option></select></label>
              <label className="block text-sm">電話番号（任意）<input type="tel" inputMode="tel" autoComplete="tel" value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} className="mt-1 block w-full rounded-lg border p-3" placeholder="薬局からの連絡用" maxLength={40} /></label>
              <button type="button" className="text-left text-sm font-bold text-green-700" onClick={() => setShowAddress((value) => !value)}>{showAddress ? '住所を閉じる' : '住所を登録する（配送・訪問時に使用）'}</button>
              {showAddress && <div className="space-y-3 rounded-lg bg-gray-50 p-3">
                <label className="block text-sm">郵便番号<input inputMode="numeric" autoComplete="postal-code" value={postalCode} onChange={(event) => setPostalCode(event.target.value)} className="mt-1 block w-full rounded-lg border p-3" placeholder="000-0000" maxLength={8} /></label>
                <label className="block text-sm">都道府県<select autoComplete="address-level1" value={prefecture} onChange={(event) => setPrefecture(event.target.value)} className="mt-1 block w-full rounded-lg border p-3"><option value="">選択してください</option>{prefectures.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
                <label className="block text-sm">市区町村<input autoComplete="address-level2" value={city} onChange={(event) => setCity(event.target.value)} className="mt-1 block w-full rounded-lg border p-3" maxLength={120} /></label>
                <label className="block text-sm">番地<input autoComplete="street-address" value={addressLine1} onChange={(event) => setAddressLine1(event.target.value)} className="mt-1 block w-full rounded-lg border p-3" maxLength={240} /></label>
                <label className="block text-sm">建物名・部屋番号（任意）<input autoComplete="address-line2" value={addressLine2} onChange={(event) => setAddressLine2(event.target.value)} className="mt-1 block w-full rounded-lg border p-3" maxLength={240} /></label>
              </div>}
              <button type="button" onClick={() => void createPatient()} disabled={busy} className="w-full rounded-lg bg-green-600 px-4 py-3 font-bold text-white disabled:bg-gray-300">{editing ? '患者情報を更新する' : '患者を登録する'}</button>
            </div>
          ) : loading ? <p className="text-sm text-gray-500">読み込み中...</p> : patients.length === 0 ? <p className="text-sm text-gray-600">まず患者情報を登録してください。</p> : (
            <label className="block text-sm">患者を選択<select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} className="mt-1 block w-full rounded-lg border p-3" disabled={busy}>{patients.map((patient) => <option key={patient.id} value={patient.id}>{relationshipLabels[patient.relationship]}：{patient.name}</option>)}</select></label>
          )}
          {selectedPatient && <p className="text-xs text-gray-600">生年月日：{selectedPatient.birth_date}　回答版：{latestRevision ? `第${latestRevision}版` : '未回答'}</p>}
        </section>

        {!showNewPatient && selectedPatient && <>
          <section className="rounded-xl bg-white p-4 shadow-sm space-y-4" aria-labelledby="health-heading">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 id="health-heading" className="font-bold">患者アンケート</h2>
                <span className="text-xs text-gray-500">ステップ {intakeStep} / {intakeSteps.length}</span>
              </div>
              <ol aria-label="アンケートのステップ" className="grid grid-cols-3 gap-2">
                {intakeSteps.map((step, index) => <li key={step} className={`rounded-lg px-2 py-2 text-center text-xs ${intakeStep === index + 1 ? 'bg-green-100 font-bold text-green-800' : 'bg-gray-100 text-gray-500'}`}>{index + 1}. {step}</li>)}
              </ol>
            </div>

            {intakeStep === 1 && <div className="space-y-4">
              <h3 className="font-bold">安全確認</h3>
              <ChoiceField label="アレルギー" value={answers.allergiesStatus} options={statusOptions} onChange={(value) => updateAnswer('allergiesStatus', value)} />
              {answers.allergiesStatus === 'yes' && <label className="block text-sm">アレルギーの内容（任意）<textarea value={answers.allergiesDetail ?? ''} onChange={(event) => updateAnswer('allergiesDetail', event.target.value)} className="mt-1 block w-full rounded-lg border p-3" rows={2} maxLength={2000} /></label>}
              <ChoiceField label="お薬で具合が悪くなった経験" value={answers.adverseReactionStatus} options={statusOptions} onChange={(value) => updateAnswer('adverseReactionStatus', value)} />
              {answers.adverseReactionStatus === 'yes' && <label className="block text-sm">その内容（任意）<textarea value={answers.adverseReactionDetail ?? ''} onChange={(event) => updateAnswer('adverseReactionDetail', event.target.value)} className="mt-1 block w-full rounded-lg border p-3" rows={2} maxLength={2000} /></label>}
              <ChoiceField label="服用中のお薬" value={answers.medicationStatus} options={statusOptions} onChange={(value) => updateAnswer('medicationStatus', value)} />
              {answers.medicationStatus === 'yes' && <label className="block text-sm">薬・サプリメントの名前（任意）<textarea value={answers.medicationSummary ?? ''} onChange={(event) => updateAnswer('medicationSummary', event.target.value)} className="mt-1 block w-full rounded-lg border p-3" rows={2} maxLength={2000} /></label>}
            </div>}

            {intakeStep === 2 && <div className="space-y-4">
              <h3 className="font-bold">体調・生活</h3>
              <ChoiceField label="既往歴・通院中の病気" value={answers.medicalHistoryStatus} options={statusOptions} onChange={(value) => updateAnswer('medicalHistoryStatus', value)} />
              {answers.medicalHistoryStatus === 'yes' && <fieldset className="space-y-2"><legend className="text-sm">当てはまる病気（複数選択・任意）</legend><div className="grid grid-cols-2 gap-2">{medicalHistoryTagOptions.map((option) => <label key={option.value} className="flex min-h-11 items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm"><input type="checkbox" checked={answers.medicalHistoryTags.includes(option.value)} onChange={() => toggleMedicalHistoryTag(option.value)} className="h-5 w-5" />{option.label}</label>)}</div></fieldset>}
              {answers.medicalHistoryStatus === 'yes' && <label className="block text-sm">病名・通院内容の補足（任意）<textarea value={answers.medicalHistory ?? ''} onChange={(event) => updateAnswer('medicalHistory', event.target.value)} className="mt-1 block w-full rounded-lg border p-3" rows={2} maxLength={2000} /></label>}
              <ChoiceField label="お薬手帳" value={answers.medicationNotebook} options={notebookOptions} onChange={(value) => updateAnswer('medicationNotebook', value)} />
              <ChoiceField label="喫煙" value={answers.smokingStatus} options={smokingOptions} onChange={(value) => updateAnswer('smokingStatus', value)} />
              <ChoiceField label="飲酒" value={answers.alcoholStatus} options={alcoholOptions} onChange={(value) => updateAnswer('alcoholStatus', value)} />
              <ChoiceField label="お薬の飲み忘れ" value={answers.medicationAdherence} options={adherenceOptions} onChange={(value) => updateAnswer('medicationAdherence', value)} />
              {showPregnancyQuestions && <><ChoiceField label="妊娠の可能性（該当する方のみ）" value={answers.pregnancyStatus ?? 'not_applicable'} options={pregnancyOptions} onChange={(value) => updateAnswer('pregnancyStatus', value)} /><ChoiceField label="授乳中（該当する方のみ）" value={answers.breastfeedingStatus ?? 'not_applicable'} options={pregnancyOptions} onChange={(value) => updateAnswer('breastfeedingStatus', value)} /></>}
            </div>}

            {intakeStep === 3 && <div className="space-y-4">
              <h3 className="font-bold">確認・送信</h3>
              <p className="text-sm text-gray-600">回答内容を確認し、薬局に伝えたいことがあれば入力してください。</p>
              <label className="block text-sm">薬局に伝えたいこと（任意）<textarea value={answers.notes ?? ''} onChange={(event) => updateAnswer('notes', event.target.value)} className="mt-1 block w-full rounded-lg border p-3" rows={3} maxLength={2000} /></label>
              <div className="space-y-3 rounded-lg bg-gray-50 p-3 text-sm">
                <p>安全確認：アレルギー {answers.allergiesStatus === 'yes' ? 'あり' : answers.allergiesStatus === 'none' ? 'なし' : 'わからない'} / 服用中の薬 {answers.medicationStatus === 'yes' ? 'あり' : answers.medicationStatus === 'none' ? 'なし' : 'わからない'}</p>
                <p>生活確認：喫煙・飲酒・飲み忘れを回答済み</p>
              </div>
              <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={representativeConsent} onChange={(event) => setRepresentativeConsent(event.target.checked)} className="mt-1 h-5 w-5" disabled={busy} /><span>本人または代理人として、回答内容を薬局へ伝えることに同意します。</span></label>
              <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={privacyConsent} onChange={(event) => setPrivacyConsent(event.target.checked)} className="mt-1 h-5 w-5" disabled={busy} /><span>個人情報の利用目的を確認し、薬局での調剤・連絡に同意します。</span></label>
            </div>}
          </section>
          <div className="flex gap-3">
            <button type="button" onClick={() => setIntakeStep((step) => Math.max(1, step - 1))} disabled={intakeStep === 1 || busy} className="min-h-11 flex-1 rounded-xl border border-gray-300 bg-white px-4 py-3 font-bold text-gray-700 disabled:opacity-40">戻る</button>
            {intakeStep < intakeSteps.length ? <button type="button" onClick={() => setIntakeStep((step) => Math.min(intakeSteps.length, step + 1))} disabled={busy} className="min-h-11 flex-1 rounded-xl bg-green-600 px-4 py-3 font-bold text-white disabled:bg-gray-300">次へ</button> : <button type="button" onClick={() => void submit()} disabled={!canSubmitIntake(answers, representativeConsent, privacyConsent, busy)} className="min-h-11 flex-1 rounded-xl bg-green-600 px-4 py-3 font-bold text-white disabled:bg-gray-300">{busy ? '保存中…' : latestRevision ? '回答を更新する' : 'アンケートを送信する'}</button>}
          </div>
          <button type="button" onClick={() => navigate('/prescriptions')} className="w-full rounded-xl border border-green-600 bg-white px-4 py-3 font-bold text-green-700">処方せん事前送信へ</button>
          <p className="text-xs leading-5 text-gray-600">回答内容は薬局の確認に使います。緊急時は医療機関へご相談ください。</p>
        </>}
      </div>
    </main>
  );
}
