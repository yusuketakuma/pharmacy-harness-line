import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import PatientIntakePage, { canSubmitIntake } from './PatientIntakePage.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  emptyPatientProfileDraft,
  PatientProfileForm,
} from './PatientProfileForm.js';
import {
  INITIAL_INTAKE_ANSWERS,
  PatientQuestionnaire,
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
    expect(canSubmitIntake(answers, false, true, false)).toBe(false);
    expect(canSubmitIntake(answers, true, false, false)).toBe(false);
    expect(canSubmitIntake(answers, true, true, true)).toBe(false);
    expect(canSubmitIntake(answers, true, true, false)).toBe(true);
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

  it('restores an unfinished answer draft without persisting consent', () => {
    expect(source).toContain('sessionStorage.getItem(intakeDraftKey(patientId))');
    expect(source).toContain('sessionStorage.setItem(intakeDraftKey(selectedId)');
    expect(source).toContain('sessionStorage.removeItem(intakeDraftKey(selectedId))');
    expect(source).not.toMatch(/JSON\.stringify\(\{[^}]*Consent/s);
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

  it('falls back to neutral wording and never blocks submission without a notice', () => {
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
    expect(canSubmitIntake(answers, true, true, false)).toBe(true);
    expect(source).toContain('patientIntakeApi.privacyPolicy()');
  });

  it('offers a confirmed one-tap update from the last saved answers', () => {
    expect(source).toContain('前回から変更なしで更新');
    expect(source).toContain('if (!latestAnswers || busy || !window.confirm(');
    expect(source).toContain('本人または代理人として');
    expect(source).toContain('個人情報の利用目的');
    expect(source).toContain('saveIntake(latestAnswers, true, true)');
  });
});
