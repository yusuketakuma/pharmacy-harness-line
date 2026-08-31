import type { Dispatch, SetStateAction } from 'react';
import type {
  MedicalHistoryTag,
  PatientIntakeAnswers,
  TenantPrivacyPolicy,
} from './api.js';

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
export const INTAKE_STEP_COUNT = intakeSteps.length;

/** Form state: the four safety questions start unanswered ('') and must be chosen explicitly. */
export type IntakeAnswersDraft = Omit<PatientIntakeAnswers,
  'allergiesStatus' | 'adverseReactionStatus' | 'medicationStatus' | 'medicalHistoryStatus'> & {
  allergiesStatus: PatientIntakeAnswers['allergiesStatus'] | '';
  adverseReactionStatus: PatientIntakeAnswers['adverseReactionStatus'] | '';
  medicationStatus: PatientIntakeAnswers['medicationStatus'] | '';
  medicalHistoryStatus: PatientIntakeAnswers['medicalHistoryStatus'] | '';
};

const SAFETY_KEYS_BY_STEP: Record<number, ReadonlyArray<keyof IntakeAnswersDraft>> = {
  1: ['allergiesStatus', 'adverseReactionStatus', 'medicationStatus'],
  2: ['medicalHistoryStatus'],
};

export function safetyUnansweredKeys(answers: IntakeAnswersDraft, step: number): Array<keyof IntakeAnswersDraft> {
  return (SAFETY_KEYS_BY_STEP[step] ?? []).filter((key) => !answers[key]);
}

const labelOf = (options: ReadonlyArray<{ value: string; label: string }>, value: string | undefined) =>
  options.find((option) => option.value === value)?.label ?? '未回答';

function ChoiceField<T extends string>({
  name,
  label,
  value,
  options,
  required = false,
  error,
  onChange,
}: {
  name: keyof PatientIntakeAnswers;
  label: string;
  value: T | '';
  options: ReadonlyArray<{ value: T; label: string }>;
  required?: boolean;
  error?: string;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="space-y-2" aria-invalid={error ? true : undefined}>
    <legend className="text-base">{label}{required && <span className="ml-1 rounded bg-red-100 px-1.5 py-0.5 text-sm font-bold text-red-800">必須</span>}</legend>
      <div className="grid grid-cols-2 gap-2">
        {options.map((option) => (
          <label key={option.value} className="cursor-pointer">
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="peer sr-only"
            />
            <span className="pharmacy-control flex items-center justify-center rounded-lg border border-gray-300 px-3 py-2 text-base peer-checked:border-green-700 peer-checked:bg-green-50 peer-checked:font-bold peer-checked:before:mr-1 peer-checked:before:content-['✓'] peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-blue-700">
              {option.label}
            </span>
          </label>
        ))}
      </div>
      {error && <p role="alert" className="text-base font-bold text-red-700">{error}</p>}
    </fieldset>
  );
}

export const INITIAL_INTAKE_ANSWERS: IntakeAnswersDraft = {
  allergiesStatus: '',
  adverseReactionStatus: '',
  medicationStatus: '',
  medicationSummary: '',
  medicalHistoryStatus: '',
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

export function PatientQuestionnaire({
  answers,
  step,
  busy,
  showPregnancyQuestions,
  representativeConsent,
  privacyConsent,
  privacyPolicy = null,
  showErrors = false,
  onAnswersChange,
  onRepresentativeConsentChange,
  onPrivacyConsentChange,
}: {
  answers: IntakeAnswersDraft;
  step: number;
  busy: boolean;
  showPregnancyQuestions: boolean;
  representativeConsent: boolean;
  privacyConsent: boolean;
  privacyPolicy?: TenantPrivacyPolicy | null;
  showErrors?: boolean;
  onAnswersChange: Dispatch<SetStateAction<IntakeAnswersDraft>>;
  onRepresentativeConsentChange: (value: boolean) => void;
  onPrivacyConsentChange: (value: boolean) => void;
}) {
  const unanswered = showErrors ? safetyUnansweredKeys(answers, step) : [];
  const safetyError = (key: keyof IntakeAnswersDraft) =>
    unanswered.includes(key) ? 'どれか1つを選んでください' : undefined;

  function updateAnswer<K extends keyof IntakeAnswersDraft>(
    key: K,
    value: IntakeAnswersDraft[K],
  ) {
    onAnswersChange((current) => ({ ...current, [key]: value }));
  }

  function toggleMedicalHistoryTag(tag: MedicalHistoryTag) {
    onAnswersChange((current) => ({
      ...current,
      medicalHistoryTags: current.medicalHistoryTags.includes(tag)
        ? current.medicalHistoryTags.filter((value) => value !== tag)
        : [...current.medicalHistoryTags, tag],
    }));
  }

  return (
    <section className="rounded-xl bg-white p-4 shadow-sm space-y-4" aria-labelledby="health-heading">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 id="health-heading" className="font-bold">患者アンケート</h2>
          <span className="text-base text-gray-700">ステップ {step} / {intakeSteps.length}</span>
        </div>
        <ol aria-label="アンケートのステップ" className="grid grid-cols-3 gap-2">
          {intakeSteps.map((label, index) => <li key={label} aria-current={step === index + 1 ? 'step' : undefined} className={`pharmacy-control rounded-lg px-2 py-2 text-center text-sm ${step === index + 1 ? 'bg-green-100 font-bold text-green-800' : 'bg-gray-100 text-gray-700'}`}>{index + 1}. {label}</li>)}
        </ol>
      </div>

      {step === 1 && <div className="space-y-4">
        <h3 className="font-bold">安全確認</h3>
        <ChoiceField required error={safetyError('allergiesStatus')} name="allergiesStatus" label="アレルギー" value={answers.allergiesStatus} options={statusOptions} onChange={(value) => updateAnswer('allergiesStatus', value)} />
        {answers.allergiesStatus === 'yes' && <label className="block text-sm">アレルギーの内容（任意）<textarea value={answers.allergiesDetail ?? ''} onChange={(event) => updateAnswer('allergiesDetail', event.target.value)} className="mt-1 block w-full rounded-lg border p-3" rows={2} maxLength={2000} /></label>}
        <ChoiceField required error={safetyError('adverseReactionStatus')} name="adverseReactionStatus" label="お薬で具合が悪くなった経験" value={answers.adverseReactionStatus} options={statusOptions} onChange={(value) => updateAnswer('adverseReactionStatus', value)} />
        {answers.adverseReactionStatus === 'yes' && <label className="block text-sm">その内容（任意）<textarea value={answers.adverseReactionDetail ?? ''} onChange={(event) => updateAnswer('adverseReactionDetail', event.target.value)} className="mt-1 block w-full rounded-lg border p-3" rows={2} maxLength={2000} /></label>}
        <ChoiceField required error={safetyError('medicationStatus')} name="medicationStatus" label="服用中のお薬" value={answers.medicationStatus} options={statusOptions} onChange={(value) => updateAnswer('medicationStatus', value)} />
        {answers.medicationStatus === 'yes' && <label className="block text-sm">薬・サプリメントの名前（任意）<textarea value={answers.medicationSummary ?? ''} onChange={(event) => updateAnswer('medicationSummary', event.target.value)} className="mt-1 block w-full rounded-lg border p-3" rows={2} maxLength={2000} /></label>}
      </div>}

      {step === 2 && <div className="space-y-4">
        <h3 className="font-bold">体調・生活</h3>
        <ChoiceField required error={safetyError('medicalHistoryStatus')} name="medicalHistoryStatus" label="既往歴・通院中の病気" value={answers.medicalHistoryStatus} options={statusOptions} onChange={(value) => updateAnswer('medicalHistoryStatus', value)} />
        {answers.medicalHistoryStatus === 'yes' && <fieldset className="space-y-2"><legend className="text-sm">当てはまる病気（複数選択・任意）</legend><div className="grid grid-cols-2 gap-2">{medicalHistoryTagOptions.map((option) => <label key={option.value} className="flex min-h-11 items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm"><input type="checkbox" checked={answers.medicalHistoryTags.includes(option.value)} onChange={() => toggleMedicalHistoryTag(option.value)} className="h-5 w-5" />{option.label}</label>)}</div></fieldset>}
        {answers.medicalHistoryStatus === 'yes' && <label className="block text-sm">病名・通院内容の補足（任意）<textarea value={answers.medicalHistory ?? ''} onChange={(event) => updateAnswer('medicalHistory', event.target.value)} className="mt-1 block w-full rounded-lg border p-3" rows={2} maxLength={2000} /></label>}
        <ChoiceField name="medicationNotebook" label="お薬手帳" value={answers.medicationNotebook} options={notebookOptions} onChange={(value) => updateAnswer('medicationNotebook', value)} />
        <ChoiceField name="smokingStatus" label="喫煙" value={answers.smokingStatus} options={smokingOptions} onChange={(value) => updateAnswer('smokingStatus', value)} />
        <ChoiceField name="alcoholStatus" label="飲酒" value={answers.alcoholStatus} options={alcoholOptions} onChange={(value) => updateAnswer('alcoholStatus', value)} />
        <ChoiceField name="medicationAdherence" label="お薬の飲み忘れ" value={answers.medicationAdherence} options={adherenceOptions} onChange={(value) => updateAnswer('medicationAdherence', value)} />
        {showPregnancyQuestions && <><ChoiceField name="pregnancyStatus" label="妊娠の可能性（該当する方のみ）" value={answers.pregnancyStatus ?? 'not_applicable'} options={pregnancyOptions} onChange={(value) => updateAnswer('pregnancyStatus', value)} /><ChoiceField name="breastfeedingStatus" label="授乳中（該当する方のみ）" value={answers.breastfeedingStatus ?? 'not_applicable'} options={pregnancyOptions} onChange={(value) => updateAnswer('breastfeedingStatus', value)} /></>}
      </div>}

      {step === 3 && <div className="space-y-4">
        <h3 className="font-bold">確認・送信</h3>
        <p className="text-sm text-gray-600">回答内容を確認し、薬局に伝えたいことがあれば入力してください。</p>
        <label className="block text-sm">薬局に伝えたいこと（任意）<textarea value={answers.notes ?? ''} onChange={(event) => updateAnswer('notes', event.target.value)} className="mt-1 block w-full rounded-lg border p-3" rows={3} maxLength={2000} /></label>
        <div className="rounded-lg border-2 border-green-700 bg-white p-3 text-sm" role="group" aria-labelledby="intake-confirm-heading">
          <p id="intake-confirm-heading" className="font-bold">送信内容の確認</p>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-gray-800">
            <dt className="text-gray-600">アレルギー</dt><dd>{labelOf(statusOptions, answers.allergiesStatus)}</dd>
            <dt className="text-gray-600">具合が悪くなった経験</dt><dd>{labelOf(statusOptions, answers.adverseReactionStatus)}</dd>
            <dt className="text-gray-600">服用中のお薬</dt><dd>{labelOf(statusOptions, answers.medicationStatus)}</dd>
            <dt className="text-gray-600">既往歴・通院中の病気</dt><dd>{labelOf(statusOptions, answers.medicalHistoryStatus)}</dd>
            <dt className="text-gray-600">お薬手帳</dt><dd>{labelOf(notebookOptions, answers.medicationNotebook)}</dd>
            <dt className="text-gray-600">喫煙</dt><dd>{labelOf(smokingOptions, answers.smokingStatus)}</dd>
            <dt className="text-gray-600">飲酒</dt><dd>{labelOf(alcoholOptions, answers.alcoholStatus)}</dd>
            <dt className="text-gray-600">お薬の飲み忘れ</dt><dd>{labelOf(adherenceOptions, answers.medicationAdherence)}</dd>
            {showPregnancyQuestions && <>
              <dt className="text-gray-600">妊娠の可能性</dt><dd>{labelOf(pregnancyOptions, answers.pregnancyStatus)}</dd>
              <dt className="text-gray-600">授乳中</dt><dd>{labelOf(pregnancyOptions, answers.breastfeedingStatus)}</dd>
            </>}
          </dl>
          <p className="mt-2 text-sm text-gray-700">内容を直す場合は「戻る」で前のステップへ戻れます。</p>
        </div>
        <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={representativeConsent} onChange={(event) => onRepresentativeConsentChange(event.target.checked)} className="mt-1 h-5 w-5" disabled={busy} /><span>本人または代理人として、回答内容を薬局へ伝えることに同意します。</span></label>
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm leading-5 text-gray-700 space-y-1">
          <p className="font-bold text-gray-800">この薬局による個人情報の取扱いについて</p>
          {privacyPolicy ? <>
            <p>利用目的：{privacyPolicy.purpose_text}</p>
            {privacyPolicy.entrustment_text && <p>委託について：{privacyPolicy.entrustment_text}</p>}
            <p>問い合わせ窓口：{privacyPolicy.contact_point}</p>
            {privacyPolicy.purpose_url && <p><a href={privacyPolicy.purpose_url} target="_blank" rel="noreferrer" className="font-bold text-green-800 underline">利用目的の詳細を見る</a></p>}
          </> : <p>利用目的の詳細は、この薬局にお問い合わせください。</p>}
        </div>
        <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={privacyConsent} onChange={(event) => onPrivacyConsentChange(event.target.checked)} className="mt-1 h-5 w-5" disabled={busy || !privacyPolicy} /><span>個人情報の利用目的を確認し、薬局での調剤・連絡に同意します。</span></label>
      </div>}
    </section>
  );
}
