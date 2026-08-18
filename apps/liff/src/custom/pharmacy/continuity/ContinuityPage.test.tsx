import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import ContinuityPage, { NextIntakeExpectationCard } from './ContinuityPage.js';

describe('continuity patient hub', () => {
  it('renders a simple follow-up hub without clinical detail', () => {
    const html = renderToStaticMarkup(<MemoryRouter><ContinuityPage /></MemoryRouter>);
    expect(html).toContain('継続フォロー');
    expect(html).toContain('処方せん事前送信へ');
    expect(html).not.toContain('患者名');
  });

  it('asks the patient before enabling a next-intake reminder', () => {
    const html = renderToStaticMarkup(<NextIntakeExpectationCard
      expectation={{
        id: 'expectation-1',
        obligation_id: 'obligation-1',
        patient_id: 'patient-1',
        status: 'offered',
        timing_source: 'manual_supply_days',
        supply_days: 28,
        expected_from: '2026-09-15',
        expected_to: '2026-09-15',
        reminder_at: '2026-09-15T00:00:00.000Z',
        reminded_at: null,
        version: 1,
        created_at: '2026-08-18T00:00:00.000Z',
        updated_at: '2026-08-18T00:00:00.000Z',
      }}
      busy={false}
      onRespond={async () => undefined}
    />);

    expect(html).toContain('次回事前送信のお知らせ')
    expect(html).toContain('お知らせを受け取る')
    expect(html).toContain('今回は登録しない')
    expect(html).toContain('薬の確保や調剤を約束するものではありません')
  });
});
