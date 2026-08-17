import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import PatientIntakePage, { canSubmitIntake } from './PatientIntakePage.js';
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
});
