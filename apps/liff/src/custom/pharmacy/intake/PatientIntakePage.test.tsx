import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import PatientIntakePage, { canSubmitIntake } from './PatientIntakePage.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  emptyPatientProfileDraft,
  PATIENT_PROXY_TERMS_HASH,
  PATIENT_PROXY_TERMS_TEXT,
  PatientProfileForm,
  patientProfileErrors,
} from './PatientProfileForm.js';
import {
  INITIAL_INTAKE_ANSWERS,
  PatientQuestionnaire,
  safetyUnansweredKeys,
} from './PatientQuestionnaire.js';

const answers = {
  allergiesStatus: 'none' as const,
  adverseReactionStatus: 'none' as const,
  medicationStatus: 'none' as const,
  medicalHistoryStatus: 'none' as const,
  medicalHistoryTags: [],
  medicationNotebook: 'unknown' as const,
  smokingStatus: 'unknown' as const,
  alcoholStatus: 'unknown' as const,
  medicationAdherence: 'unknown' as const,
};

const source = readFileSync(
  fileURLToPath(new URL('./PatientIntakePage.tsx', import.meta.url).href),
  'utf8',
);

describe('patient intake UI contract', () => {
  it('requires both consents and a complete status answer', () => {
    expect(canSubmitIntake(answers, false, true, false, true)).toBe(false);
    expect(canSubmitIntake(answers, true, false, false, true)).toBe(false);
    expect(canSubmitIntake(answers, true, true, true, true)).toBe(false);
    expect(canSubmitIntake(answers, true, true, false, true)).toBe(true);
    expect(canSubmitIntake(answers, true, true, false)).toBe(false);
  });

  it('renders family registration and pharmacy-safe questionnaire labels', () => {
    const page = renderToStaticMarkup(<MemoryRouter><PatientIntakePage /></MemoryRouter>);
    const profile = [false, true].map((showAddress) => renderToStaticMarkup(
      <PatientProfileForm
        draft={emptyPatientProfileDraft('child')}
        editing={false}
        busy={false}
        showAddress={showAddress}
        onChange={() => undefined}
        onToggleAddress={() => undefined}
        onSubmit={() => undefined}
      />,
    )).join('');
    const questionnaire = [1, 2].map((step) => renderToStaticMarkup(<PatientQuestionnaire
      answers={step === 2
        ? { ...INITIAL_INTAKE_ANSWERS, medicalHistoryStatus: 'yes' }
        : INITIAL_INTAKE_ANSWERS}
      step={step}
      busy={false}
      showPregnancyQuestions
      representativeConsent={false}
      privacyConsent={false}
      onAnswersChange={() => undefined}
      onRepresentativeConsentChange={() => undefined}
      onPrivacyConsentChange={() => undefined}
    />)).join('');
    const html = page + profile + questionnaire;

    expect(html).toContain('患者アンケート');
    expect(html).toContain('本人を登録');
    expect(html).toContain('回答する患者');
    expect(html).toContain('家族を追加');
    expect(html).toContain('電話番号');
    expect(html).toContain('住所を登録する');
    expect(html).toContain('お薬手帳');
    expect(html).toContain('服用中のお薬');
    expect(html).toContain('高血圧');
    expect(html).toContain('入力目安：約1分');
    expect(html).toContain('type="radio"');
    expect(html).toContain('喫煙');
    expect(html).toContain('飲酒');
    expect(html).toContain('飲み忘れ');
    expect(html).toContain('ステップ');
  });

  it('names radio groups by answer key and marks the chosen option', () => {
    const html = renderToStaticMarkup(<PatientQuestionnaire
      answers={INITIAL_INTAKE_ANSWERS}
      step={1}
      busy={false}
      showPregnancyQuestions={false}
      representativeConsent={false}
      privacyConsent={false}
      onAnswersChange={() => undefined}
      onRepresentativeConsentChange={() => undefined}
      onPrivacyConsentChange={() => undefined}
    />);
    expect(html).toContain('name="allergiesStatus"');
    expect(html).toContain('name="medicationStatus"');
    expect(html).not.toContain('name="アレルギー"');
    expect(html).toContain('peer-checked:before:content-');
  });

  it('keeps unfinished answers in memory only and warns before losing them', () => {
    expect(source).not.toContain('sessionStorage');
    expect(source).toContain('未送信の入力があります');
    expect(source).toContain('beforeunload');
  });

  it('shows the pharmacy-authored purpose of use in the consent section', () => {
    const html = renderToStaticMarkup(<PatientQuestionnaire
      answers={INITIAL_INTAKE_ANSWERS}
      step={3}
      busy={false}
      showPregnancyQuestions={false}
      representativeConsent={false}
      privacyConsent={false}
      privacyPolicy={{
        purpose_text: '調剤・服薬指導および必要な連絡のために利用します。',
        purpose_url: 'https://pharmacy-a.example/privacy',
        contact_point: '〇〇薬局 個人情報相談窓口 03-0000-0000',
        entrustment_text: 'システム運営を外部事業者に委託しています。',
        policy_version: 2,
        content_hash: 'a'.repeat(64),
      }}
      onAnswersChange={() => undefined}
      onRepresentativeConsentChange={() => undefined}
      onPrivacyConsentChange={() => undefined}
    />);

    expect(html).toContain('調剤・服薬指導および必要な連絡のために利用します。');
    expect(html).toContain('https://pharmacy-a.example/privacy');
    expect(html).toContain('〇〇薬局 個人情報相談窓口');
    expect(html).toContain('システム運営を外部事業者に委託しています。');
    expect(html).toContain('この薬局');
  });

  it('does not allow submission without a pharmacy privacy policy', () => {
    const html = renderToStaticMarkup(<PatientQuestionnaire
      answers={INITIAL_INTAKE_ANSWERS}
      step={3}
      busy={false}
      showPregnancyQuestions={false}
      representativeConsent={false}
      privacyConsent={false}
      privacyPolicy={null}
      onAnswersChange={() => undefined}
      onRepresentativeConsentChange={() => undefined}
      onPrivacyConsentChange={() => undefined}
    />);

    expect(html).toContain('薬局にお問い合わせください');
    expect(html).toContain('disabled=""');
    expect(canSubmitIntake(answers, true, true, false, false)).toBe(false);
    expect(source).toContain('patientIntakeApi.privacyPolicy()');
  });

  it('binds submission to the displayed policy and reloads it after a conflict', () => {
    expect(source).toContain('privacyPolicyVersion: privacyPolicy.policy_version');
    expect(source).toContain('privacyPolicyHash: privacyPolicy.content_hash');
    expect(source).toContain('status === 409');
    expect(source).toContain('await loadPrivacyPolicy()');
    expect(source).toContain('setPrivacyConsent(false);\n      setPrivacyPolicy(result.policy);');
  });

  it('offers a confirmed one-tap update from the last saved answers', () => {
    expect(source).toContain('前回から変更なしで更新');
    expect(source).toContain('if (!latestAnswers || busy || !privacyPolicy || !window.confirm(');
    expect(source).toContain('本人または代理人として');
    expect(source).toContain('個人情報の利用目的');
    expect(source).toContain('saveIntake(latestAnswers, true, true)');
  });
});

describe('patient intake submit flow (WP-12)', () => {
  it('starts the four safety questions unanswered and blocks submission until answered', () => {
    expect(INITIAL_INTAKE_ANSWERS.allergiesStatus).toBe('');
    expect(INITIAL_INTAKE_ANSWERS.adverseReactionStatus).toBe('');
    expect(INITIAL_INTAKE_ANSWERS.medicationStatus).toBe('');
    expect(INITIAL_INTAKE_ANSWERS.medicalHistoryStatus).toBe('');
    expect(canSubmitIntake(INITIAL_INTAKE_ANSWERS, true, true, false, true)).toBe(false);
    expect(safetyUnansweredKeys(INITIAL_INTAKE_ANSWERS, 1)).toEqual([
      'allergiesStatus', 'adverseReactionStatus', 'medicationStatus',
    ]);
    expect(safetyUnansweredKeys({ ...INITIAL_INTAKE_ANSWERS, allergiesStatus: 'none' }, 1))
      .toEqual(['adverseReactionStatus', 'medicationStatus']);
    expect(safetyUnansweredKeys(INITIAL_INTAKE_ANSWERS, 2)).toEqual(['medicalHistoryStatus']);
    expect(safetyUnansweredKeys(answers, 1)).toEqual([]);
  });

  it('marks required safety questions and shows a field-level message when skipped', () => {
    const html = renderToStaticMarkup(<PatientQuestionnaire
      answers={INITIAL_INTAKE_ANSWERS}
      step={1}
      busy={false}
      showPregnancyQuestions={false}
      representativeConsent={false}
      privacyConsent={false}
      showErrors
      onAnswersChange={() => undefined}
      onRepresentativeConsentChange={() => undefined}
      onPrivacyConsentChange={() => undefined}
    />);
    expect(html).toContain('必須');
    expect(html).toContain('どれか1つを選んでください');
    expect(source).toContain('safetyUnansweredKeys(answers, intakeStep)');
  });

  it('shows the full answer summary before sending', () => {
    const html = renderToStaticMarkup(<PatientQuestionnaire
      answers={{ ...answers, allergiesStatus: 'yes', smokingStatus: 'never' }}
      step={3}
      busy={false}
      showPregnancyQuestions={false}
      representativeConsent={false}
      privacyConsent={false}
      onAnswersChange={() => undefined}
      onRepresentativeConsentChange={() => undefined}
      onPrivacyConsentChange={() => undefined}
    />);
    expect(html).toContain('送信内容の確認');
    expect(html).toContain('アレルギー');
    expect(html).toContain('吸わない');
    expect(html).not.toContain('回答済み');
  });

  it('validates the patient profile field by field', () => {
    expect(patientProfileErrors(emptyPatientProfileDraft('self'))).toEqual({
      name: '氏名を入力してください',
      nameKana: '氏名カナを入力してください',
      birthDate: '生年月日を入力してください',
    });
    expect(patientProfileErrors({
      ...emptyPatientProfileDraft('self'), name: '山田', nameKana: 'ヤマダ', birthDate: '1950-01-01', postalCode: '12',
    })).toEqual({
      postalCode: '郵便番号は 000-0000 の形式で入力してください',
      prefecture: '都道府県を選んでください',
      city: '市区町村を入力してください',
      addressLine1: '番地を入力してください',
    });
    expect(patientProfileErrors({
      ...emptyPatientProfileDraft('self'), name: '山田', nameKana: 'ヤマダ', birthDate: '1950-01-01',
    })).toEqual({});
    expect(patientProfileErrors({
      ...emptyPatientProfileDraft('child'), name: '子', nameKana: 'コ', birthDate: '2018-01-01',
    })).toMatchObject({ proxyConsentAccepted: '代理入力の条件を確認して同意してください' });
    expect(patientProfileErrors({
      ...emptyPatientProfileDraft('spouse'), name: '配偶者', nameKana: 'ハイグウシャ', birthDate: '2000-01-01',
    })).toMatchObject({ relationship: '成人のご家族は薬局で本人確認が必要です' });
  });

  it('renders required badges and field-level errors in the profile form', () => {
    const html = renderToStaticMarkup(
      <PatientProfileForm
        draft={emptyPatientProfileDraft('child')}
        editing={false}
        busy={false}
        showAddress={false}
        errors={{ name: '氏名を入力してください' }}
        onChange={() => undefined}
        onToggleAddress={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    expect(html).toContain('必須');
    expect(html).toContain('氏名を入力してください');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('90日間');
    expect(html).toContain('自動更新されず');
    expect(html).toContain('いつでも取り消せます');
  });

  it('blocks an adult child in place and keeps the displayed terms hash-bound', () => {
    const html = renderToStaticMarkup(
      <PatientProfileForm
        draft={{
          ...emptyPatientProfileDraft('child'),
          birthDate: '2000-01-01',
          proxyConsentAccepted: true,
        }}
        editing={false}
        busy={false}
        showAddress={false}
        onChange={() => undefined}
        onToggleAddress={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    expect(html).toContain('18歳以上のご家族は薬局で本人確認が必要です');
    expect(html).not.toContain(PATIENT_PROXY_TERMS_TEXT);
    expect(html).toContain('disabled=""');
    expect(createHash('sha256').update(PATIENT_PROXY_TERMS_TEXT).digest('hex'))
      .toBe(PATIENT_PROXY_TERMS_HASH);
  });

  it('wires explicit proxy consent and immediate revocation into the patient flow', () => {
    expect(source).toContain('proxyConsent: { accepted: proxyConsentAccepted, termsVersion: 1, termsHash: PATIENT_PROXY_TERMS_HASH }');
    expect(source).toContain('patientIntakeApi.revokeProxy(selectedPatient.id)');
    expect(source).toContain('代理権限を取り消す');
    expect(source).toContain('registrationIdempotencyKey: registrationIdempotencyKeyRef.current');
    expect(source).toContain("selectedPatient.relationship === 'self'");
    expect(source).toContain('result.proxyGrant.expiresAt');
  });

  it('loads and updates patient notification preferences independently', () => {
    expect(source).toContain('patientIntakeApi.access(selectedId)');
    expect(source).toContain('patientIntakeApi.setNotifications(selectedPatient.id');
    expect(source).toContain('お知らせを停止する');
    expect(source).toContain('お知らせを再開する');
    expect(source).toContain('代理権限や個人情報の同意状態は変わりません');
  });

  it('shows a success card with next steps and scrolls to top', () => {
    expect(source).toContain('window.scrollTo(0, 0)');
    expect(source).toContain('次にすること');
  });
});
