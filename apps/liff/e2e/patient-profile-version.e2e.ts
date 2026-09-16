import { expect, test } from '@playwright/test';

test('refreshes the saved patient version before a second profile edit', async ({ page }) => {
  let patient = {
    id: 'patient-a', relationship: 'self', name: '開始名', name_kana: 'カイシメイ',
    birth_date: '1990-01-01', sex: 'female', contact_phone: null, postal_code: null,
    prefecture: null, city: null, address_line1: null, address_line2: null,
    archived_at: null, updated_at: '2026-09-16T00:00:00.000Z',
  };
  const patchVersions: string[] = [];
  let failSavedVersionRead = true;
  await page.route('**/api/liff/config?**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data: {
      accountName: '合成薬局', enabledFeatures: ['patient_intake'],
    } }),
  }));
  await page.route('**/api/liff/pharmacy/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    let body: unknown;
    if (pathname === '/api/liff/pharmacy/feature-access') {
      body = { data: { existingFeatures: [] } };
    } else if (pathname === '/api/liff/pharmacy/patients' && route.request().method() === 'GET') {
      if (patchVersions.length === 1 && failSavedVersionRead) {
        failSavedVersionRead = false;
        return route.fulfill({ status: 503, body: '{}' });
      }
      body = { patients: [patient] };
    } else if (pathname === '/api/liff/pharmacy/patients/patient-a' && route.request().method() === 'PATCH') {
      const input = route.request().postDataJSON() as { expectedUpdatedAt: string; name: string };
      patchVersions.push(input.expectedUpdatedAt);
      if (input.expectedUpdatedAt !== patient.updated_at) {
        return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'patient update conflict' }) });
      }
      patient = { ...patient, name: input.name, updated_at: `2026-09-16T00:00:0${patchVersions.length}.000Z` };
      body = { status: 'updated' };
    } else if (pathname === '/api/liff/pharmacy/patients/patient-a/intake') {
      body = { intake: null };
    } else if (pathname === '/api/liff/pharmacy/patients/patient-a/access') {
      body = { access: { access: 'self', permission: 'patient_intake_v1', proxyExpiresAt: null, privacy: 'active', notifications: 'enabled', controlVersion: 1 } };
    } else if (pathname === '/api/liff/pharmacy/privacy-policy') {
      body = { policy: { purpose_text: '合成目的', purpose_url: '', contact_point: '合成薬局', entrustment_text: '', policy_version: 1, content_hash: 'a'.repeat(64) } };
    } else {
      return route.fulfill({ status: 404, body: '{}' });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.goto('http://127.0.0.1:4303/pharmacy/patient-intake?liffId=e2e-liff');
  await page.getByRole('button', { name: '患者情報を修正' }).click();
  await page.getByRole('textbox', { name: '氏名必須' }).fill('一回目');
  await page.getByRole('button', { name: '患者情報を更新する' }).click();
  await expect(page.getByRole('button', { name: '患者情報を再確認' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '氏名必須' })).toHaveValue('一回目');
  await expect(page.getByRole('button', { name: '患者情報を更新する' })).toBeDisabled();
  expect(patchVersions).toHaveLength(1);
  await page.getByRole('button', { name: '患者情報を再確認' }).click();
  await expect(page.getByRole('button', { name: '患者情報を修正' })).toBeVisible();
  await page.getByRole('button', { name: '患者情報を修正' }).click();
  await page.getByRole('textbox', { name: '氏名必須' }).fill('二回目');
  await page.getByRole('button', { name: '患者情報を更新する' }).click();
  await expect(page.getByRole('button', { name: '患者情報を修正' })).toBeVisible();
  expect(patchVersions).toEqual([
    '2026-09-16T00:00:00.000Z',
    '2026-09-16T00:00:01.000Z',
  ]);
});
