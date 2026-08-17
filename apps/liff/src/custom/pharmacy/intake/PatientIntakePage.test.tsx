import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import PatientIntakePage, { canSubmitIntake } from './PatientIntakePage.js';

const answers = { allergiesStatus: 'none' as const, adverseReactionStatus: 'none' as const };

describe('patient intake UI contract', () => {
  it('requires both consents and a complete status answer', () => {
    expect(canSubmitIntake(answers, false, true, false)).toBe(false);
    expect(canSubmitIntake(answers, true, false, false)).toBe(false);
    expect(canSubmitIntake(answers, true, true, true)).toBe(false);
    expect(canSubmitIntake(answers, true, true, false)).toBe(true);
  });

  it('renders family registration and pharmacy-safe questionnaire labels', () => {
    const html = renderToStaticMarkup(<MemoryRouter><PatientIntakePage /></MemoryRouter>);
    expect(html).toContain('患者アンケート');
    expect(html).toContain('家族を追加');
    expect(html).toContain('回答する患者');
  });
});
