import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import PatientIntakePage, { canSubmitIntake } from './PatientIntakePage.js';

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
    const html = renderToStaticMarkup(<MemoryRouter><PatientIntakePage /></MemoryRouter>);
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'PatientIntakePage.tsx'), 'utf8');
    expect(html).toContain('患者アンケート');
    expect(html).toContain('本人を登録');
    expect(html).toContain('回答する患者');
    expect(source).toContain('家族を追加');
    expect(source).toContain('電話番号');
    expect(source).toContain('住所を登録する');
    expect(source).toContain('お薬手帳');
    expect(source).toContain('服用中のお薬');
    expect(source).toContain('高血圧');
    expect(source).toContain('入力目安：約1分');
    expect(source).toContain('type="radio"');
    expect(source).toContain('喫煙');
    expect(source).toContain('飲酒');
    expect(source).toContain('飲み忘れ');
    expect(source).toContain('ステップ');
  });
});
