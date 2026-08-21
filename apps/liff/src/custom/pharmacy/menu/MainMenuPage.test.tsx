import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import MainMenuPage, {
  pharmacyAppVersion,
  pharmacyMainMenuItems,
  sendPharmacyConsultation,
} from './MainMenuPage.js';

describe('pharmacy LIFF main menu', () => {
  it('provides a direct tenant-preserving URL for every patient-facing feature', () => {
    expect(pharmacyMainMenuItems('1234567890-AbCd').map(({ label, to }) => [label, to]))
      .toEqual([
        ['処方せん事前送信', '/prescriptions?view=send&liffId=1234567890-AbCd'],
        ['受付状況', '/prescriptions?view=history&liffId=1234567890-AbCd'],
        ['電子処方箋', '/prescriptions?view=electronic&liffId=1234567890-AbCd'],
        ['患者情報・アンケート', '/pharmacy/patient-intake?liffId=1234567890-AbCd'],
        ['継続フォロー', '/pharmacy/continuity?liffId=1234567890-AbCd'],
        ['服薬後フォロー', '/pharmacy/medication-followup?liffId=1234567890-AbCd'],
        ['緊急避妊薬', '/pharmacy/emergency-contraception?liffId=1234567890-AbCd'],
        ['薬局情報', '/pharmacy/info?liffId=1234567890-AbCd'],
      ]);
  });

  it('shows only account-enabled features in the server allowlist order', () => {
    expect(pharmacyMainMenuItems('liff-a', ['pharmacy_info', 'emergency_contraception'])
      .map(({ label }) => label)).toEqual(['緊急避妊薬', '薬局情報']);
    expect(pharmacyMainMenuItems('liff-a', []).map(({ label }) => label)).toEqual([]);
  });

  it('keeps only the read/drain entry for an existing disabled feature', () => {
    expect(pharmacyMainMenuItems('liff-a', [], ['prescription_intake'])
      .map(({ label, isExisting }) => [label, isExisting])).toEqual([['受付状況', true]]);
    expect(pharmacyMainMenuItems('liff-a', [], ['electronic_prescription'])
      .map(({ label }) => label)).toEqual(['電子処方箋']);
  });

  it('fails closed until the account feature config is loaded', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter><MainMenuPage /></MemoryRouter>,
    );
    expect(html).toContain('機能一覧を読み込み中')
    for (const item of pharmacyMainMenuItems()) expect(html).not.toContain(item.label);
    expect(html).not.toContain('薬局へ相談');
    expect(pharmacyAppVersion).toBe('0.30.0');
  });

  it('renders an explicit read-only badge for disabled features with owned history', () => {
    const source = readFileSync(new URL('./MainMenuPage.tsx', import.meta.url), 'utf8');
    expect(source).toContain("item.isExisting && <span");
    expect(source).toContain('確認のみ');
    expect(source).not.toContain('利用中</span>');
    expect(source).not.toContain('text-[11px]');
  });

  it('explains an empty menu instead of showing a blank grid', () => {
    const source = readFileSync(new URL('./MainMenuPage.tsx', import.meta.url), 'utf8');
    expect(source).toContain('利用できる機能はありません');
  });

  it('sends only the fixed consultation message after confirmation', async () => {
    const sendMessages = vi.fn().mockResolvedValue(undefined);
    await expect(sendPharmacyConsultation(sendMessages, () => true, () => true, async () => true)).resolves.toBe(true);
    expect(sendMessages).toHaveBeenCalledWith([{ type: 'text', text: '薬局へ相談' }]);

    sendMessages.mockClear();
    await expect(sendPharmacyConsultation(sendMessages, () => false, () => true, async () => true)).resolves.toBe(false);
    expect(sendMessages).not.toHaveBeenCalled();
  });

  it('fails before confirmation outside the LINE app', async () => {
    const sendMessages = vi.fn();
    const confirm = vi.fn();
    await expect(sendPharmacyConsultation(sendMessages, confirm, () => false, async () => true))
      .rejects.toThrow('LINE app');
    expect(confirm).not.toHaveBeenCalled();
    expect(sendMessages).not.toHaveBeenCalled();
  });

  it('rechecks manual chat immediately before sending and fails closed after OFF', async () => {
    const sendMessages = vi.fn();
    await expect(sendPharmacyConsultation(
      sendMessages, () => true, () => true, async () => false,
    )).rejects.toThrow('disabled');
    expect(sendMessages).not.toHaveBeenCalled();
  });
});
