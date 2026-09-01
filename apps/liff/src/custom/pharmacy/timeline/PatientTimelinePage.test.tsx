import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import PatientTimelinePage, {
  safeTimelineDestination,
  timelineDomainLabel,
  timelineNextActionLabel,
  timelineStatusLabel,
} from './PatientTimelinePage.js';

const source = readFileSync(new URL('./PatientTimelinePage.tsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../../../App.tsx', import.meta.url), 'utf8');

describe('patient timeline UI', () => {
  it('uses closed Japanese labels and safe fallbacks for future values', () => {
    expect(timelineDomainLabel('prescription')).toBe('処方せん');
    expect(timelineDomainLabel('future_domain')).toBe('利用状況');
    expect(timelineStatusLabel('action_required')).toBe('確認が必要です');
    expect(timelineStatusLabel('future_status')).toBe('状況を確認してください');
    expect(timelineNextActionLabel('wait')).toBe('薬局からの連絡をお待ちください。');
    expect(timelineNextActionLabel('future_action')).toBe('詳細画面で状況を確認してください。');
  });

  it('accepts only the fixed relative destination for each known domain', () => {
    expect(safeTimelineDestination({
      domain: 'prescription', detailPath: '/prescriptions?view=history',
    })).toBe('/prescriptions?view=history');
    expect(safeTimelineDestination({
      domain: 'prescription', detailPath: 'https://evil.example/steal',
    })).toBe('/prescriptions?view=history');
    expect(safeTimelineDestination({
      domain: 'future_domain', detailPath: '/admin',
    })).toBe('/pharmacy/menu');
  });

  it('renders an announced loading state and mounts the existing PharmacyShell route', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter><PatientTimelinePage /></MemoryRouter>,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('利用状況を読み込み中');
    expect(appSource).toContain('path="/pharmacy/timeline"');
    expect(appSource).toContain('screenTitle="利用状況"');
  });

  it('distinguishes an unsupported Worker from empty data and current failures', () => {
    expect(source).toContain('isUnsupportedPharmacyFeature(error)');
    expect(source).not.toContain("error.status === 404");
    expect(source).toContain("pharmacyErrorMessage(caught, '利用状況を読み込めませんでした。')");
    expect(source).not.toContain("error.message || '利用状況を読み込めませんでした。'");
    expect(source).toContain('この環境では、まとめ表示をまだ利用できません');
    expect(source).toContain('まだ利用履歴はありません');
    expect(source).toContain('role="alert"');
    expect(source).toContain('再試行');
    expect(source).toContain('aria-label={`${timelineDomainLabel(item.domain)}の詳細を確認`}');
  });

  it('does not persist timeline responses in browser storage', () => {
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|caches\./);
  });
});
