import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import MainMenuPage, {
  pharmacyMainMenuItems,
  sendPharmacyConsultation,
} from './MainMenuPage.js';

describe('pharmacy LIFF main menu', () => {
  it('provides a direct tenant-preserving URL for every patient-facing feature', () => {
    expect(pharmacyMainMenuItems('1234567890-AbCd').map(({ label, to }) => [label, to]))
      .toEqual([
        ['処方せん事前送信', '/prescriptions?view=send&liffId=1234567890-AbCd'],
        ['受付状況', '/prescriptions?view=history&liffId=1234567890-AbCd'],
        ['患者情報・アンケート', '/pharmacy/patient-intake?liffId=1234567890-AbCd'],
        ['お薬を受け取る', '/pharmacy/receive?liffId=1234567890-AbCd'],
        ['継続フォロー', '/pharmacy/continuity?liffId=1234567890-AbCd'],
        ['服薬後フォロー', '/pharmacy/medication-followup?liffId=1234567890-AbCd'],
        ['来局前確認', '/pharmacy/emergency-contraception?liffId=1234567890-AbCd'],
        ['薬局情報', '/pharmacy/info?liffId=1234567890-AbCd'],
      ]);
  });

  it('renders one accessible top-level link per feature plus consultation', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter><MainMenuPage /></MemoryRouter>,
    );
    expect(html).toContain('<h1');
    expect(html).toContain('すべての機能');
    for (const item of pharmacyMainMenuItems()) expect(html).toContain(item.label);
    expect(html).toContain('薬局へ相談');
  });

  it('sends only the fixed consultation message after confirmation', async () => {
    const sendMessages = vi.fn().mockResolvedValue(undefined);
    await expect(sendPharmacyConsultation(sendMessages, () => true, () => true)).resolves.toBe(true);
    expect(sendMessages).toHaveBeenCalledWith([{ type: 'text', text: '薬局へ相談' }]);

    sendMessages.mockClear();
    await expect(sendPharmacyConsultation(sendMessages, () => false, () => true)).resolves.toBe(false);
    expect(sendMessages).not.toHaveBeenCalled();
  });

  it('fails before confirmation outside the LINE app', async () => {
    const sendMessages = vi.fn();
    const confirm = vi.fn();
    await expect(sendPharmacyConsultation(sendMessages, confirm, () => false))
      .rejects.toThrow('LINE app');
    expect(confirm).not.toHaveBeenCalled();
    expect(sendMessages).not.toHaveBeenCalled();
  });
});
