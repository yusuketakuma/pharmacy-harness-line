import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import MedicationFollowUpPage, {
  PATIENT_RESPONSE_OPTIONS,
  needsPatientMedicationFollowUpResponse,
  patientMedicationFollowUpTimingLabel,
} from './MedicationFollowUpPage.js';

describe('patient medication follow-up page', () => {
  it('uses clear, non-judgemental fixed responses', () => {
    expect(PATIENT_RESPONSE_OPTIONS.map((option) => option.value)).toEqual([
      'no_issue', 'concern', 'pharmacist_requested',
    ]);
    expect(PATIENT_RESPONSE_OPTIONS.find((option) => option.value === 'concern')?.description)
      .toContain('飲み忘れ');
    expect(needsPatientMedicationFollowUpResponse('delivered')).toBe(true);
    expect(needsPatientMedicationFollowUpResponse('concern')).toBe(false);
  });

  it('shows the timestamp that matches what happened', () => {
    const base = {
      due_at: '2026-08-20T00:00:00Z',
      delivered_at: '2026-08-20T00:01:00Z',
      responded_at: '2026-08-20T01:00:00Z',
      closed_at: '2026-08-20T02:00:00Z',
    };
    expect(patientMedicationFollowUpTimingLabel({ ...base, status: 'scheduled' })).toContain('確認予定');
    expect(patientMedicationFollowUpTimingLabel({ ...base, status: 'delivered' })).toContain('回答依頼');
    expect(patientMedicationFollowUpTimingLabel({ ...base, status: 'concern' })).toContain('回答日時');
    expect(patientMedicationFollowUpTimingLabel({ ...base, status: 'closed' })).toContain('完了日時');
  });

  it('separates emergencies from the pharmacy reply and keeps actions accessible', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/pharmacy/medication-followup?followUpId=followup-1']}>
        <MedicationFollowUpPage />
      </MemoryRouter>,
    );
    expect(html).toContain('服薬後フォロー');
    expect(html).toContain('飲み忘れがあっても責めることはありません');
    expect(html).toContain('緊急時は119');

    const source = readFileSync(new URL('./MedicationFollowUpPage.tsx', import.meta.url), 'utf8');
    expect(source).toContain('window.confirm');
    expect(source).toContain('min-h-11');
    expect(source).toContain('disabled={busyId === item.id}');
    expect(source).toContain('aria-current={item.id === requestedId');
    expect(source).toContain('通信状態を確認して再読み込み');
    expect(source).toContain('onClick={() => void load()}');
  });

  it('is mounted under the pharmacy custom seam', () => {
    const app = readFileSync(new URL('../../../App.tsx', import.meta.url), 'utf8');
    expect(app).toContain("import MedicationFollowUpPage from './custom/pharmacy/medication-followup/MedicationFollowUpPage.js'; // custom:pharmacy-medication-followup");
    expect(app).toContain('<Route path="/pharmacy/medication-followup" element={<PharmacyPage screenTitle="服薬後フォロー" capability="medication_followup" allowExisting><MedicationFollowUpPage /></PharmacyPage>} /> {/* custom:pharmacy-medication-followup */}');
  });
});
