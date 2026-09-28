import { expect, test } from '@playwright/test';

const root = '/api/custom/pharmacy/emergency-contraception';
const intake = (id: string) => ({
  id,
  reference_code: `SYNTHETIC-${id}`,
  slot_id: 'synthetic-slot',
  status: 'reviewed',
  expires_at: '2026-10-01T10:00:00+09:00',
  version: id === 'A' ? 3 : 7,
  slot_starts_at: '2026-10-01T09:00:00+09:00',
  slot_ends_at: '2026-10-01T09:30:00+09:00',
  age_band: 'adult',
  safe_contact_mode: 'none',
  consent_version: 'synthetic',
  risk_flags: [],
  self_reported: { intercourseAt: '2026-09-30T10:00:00+09:00', intercourseTimeUnknown: false },
});

test('clinical drafts belong to one intake, survive same-intake refresh, and never transfer to another patient', async ({
  page,
  baseURL,
}) => {
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const unexpected: string[] = [];
  let releaseDetails!: () => void;
  const delayedDetails = new Promise<void>((resolve) => {
    releaseDetails = resolve;
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (url.origin !== baseURL) {
      unexpected.push(url.origin);
      await route.abort();
      return;
    }
    if (!path.startsWith('/api/')) {
      await route.continue();
      return;
    }
    let json: unknown;
    if (path === '/api/auth/session')
      json = {
        success: true,
        csrfToken: 'synthetic-csrf',
        data: {
          id: 'synthetic-staff',
          name: '合成スタッフ',
          role: 'owner',
          tenantId: 'synthetic-tenant',
          tenantCode: 'SYNTHETIC',
          tenantName: '合成薬局',
          mustChangePassword: false,
        },
      };
    else if (path === '/api/line-accounts')
      json = {
        success: true,
        data: [{ id: 'synthetic-account', name: '合成薬局', isActive: true, pharmacyMode: true }],
      };
    else if (path.endsWith('/growth/config'))
      json = { success: true, data: { capabilities: ['emergency_contraception'] } };
    else if (path.endsWith('/active-work')) json = { success: true, data: {} };
    else if (path.includes('/unanswered')) json = { success: true, data: { total: 0 } };
    else if (path.endsWith('/prescriptions/stats')) json = { pending_count: 0 };
    else if (path === `${root}/config`) json = { settings: null, pharmacists: [], inventory: [], slots: [] };
    else if (path === `${root}/reminders`)
      json = { state: 'inactive', revision: 0, timeZone: 'Asia/Tokyo', updatedAt: null };
    else if (path === `${root}/intakes`) json = { intakes: [intake('A'), intake('B')], next_cursor: null };
    else if (/\/intakes\/[AB]$/.test(path)) json = { intake: intake(path.slice(-1)) };
    else if (path.includes('/counter-confirmations/')) {
      if (path.includes('/intakes/B/')) await delayedDetails;
      if (route.request().method() === 'PUT') writes.push({ path, body: route.request().postDataJSON() });
      json = { confirmation: path.includes('/intakes/A/') ? { staff_id: 'synthetic-A' } : null };
    } else if (path.endsWith('/sale')) {
      if (route.request().method() === 'POST') {
        writes.push({ path, body: route.request().postDataJSON() });
        await route.fulfill({ status: 409, json: { error: 'Synthetic conflict' } });
        return;
      }
      json = { sale: null };
    } else {
      unexpected.push(path);
      await route.fulfill({ status: 500, json: { error: 'Unexpected request' } });
      return;
    }
    await route.fulfill({ json });
  });
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/emergency-contraception');
  const rowA = page.locator('li').filter({ hasText: '受付番号: SYNTHETIC-A' });
  const rowB = page.locator('li').filter({ hasText: '受付番号: SYNTHETIC-B' });
  await rowA.getByRole('button', { name: '申告詳細を確認' }).click();
  await expect(rowA.getByRole('button', { name: '販売可として記録' })).toBeEnabled();
  await rowA.getByRole('combobox', { name: /^本人確認/ }).selectOption('document');
  await rowA.getByRole('combobox', { name: /^妊娠検査/ }).selectOption('negative');
  await rowA.getByRole('combobox', { name: /^面前服用/ }).selectOption('done');
  await rowA.getByLabel('紙チェックシート受領枚数').fill('2');
  await rowA.getByLabel('3週間後の確認', { exact: true }).check();
  await rowA.getByLabel('申告と相違があった項目').first().selectOption('lngAllergy');
  // Refresh hides detail but reopening the same intake must preserve unsent input.
  await page.getByRole('button', { name: '再読み込み', exact: true }).click();
  await rowA.getByRole('button', { name: '申告詳細を確認' }).click();
  await expect(rowA.getByRole('button', { name: '販売可として記録' })).toBeEnabled();
  await expect(rowA.getByRole('combobox', { name: /^妊娠検査/ })).toHaveValue('negative');
  await expect(rowA.getByLabel('申告と相違があった項目').first()).toHaveValues(['lngAllergy']);
  await rowB.getByRole('button', { name: '申告詳細を確認' }).click();
  // Detail is visible before its slower confirmation/sale requests finish.
  await expect(rowB.getByRole('button', { name: '販売可として記録' })).toBeDisabled();
  await expect(rowB.getByText('対面で確認した（synthetic-A）')).toHaveCount(0);
  await expect(rowB.getByRole('combobox', { name: /^本人確認/ })).toHaveValue('unverified');
  await expect(rowB.getByRole('combobox', { name: /^妊娠検査/ })).toHaveValue('not_done');
  await expect(rowB.getByRole('combobox', { name: /^面前服用/ })).toHaveValue('not_done');
  await expect(rowB.getByLabel('紙チェックシート受領枚数')).toHaveValue('0');
  await expect(rowB.getByLabel('3週間後の確認', { exact: true })).not.toBeChecked();
  await expect(rowB.getByLabel('申告と相違があった項目').first()).toHaveValues([]);
  releaseDetails();
  await expect(rowB.getByRole('button', { name: '販売可として記録' })).toBeEnabled();
  await expect(rowB.getByRole('combobox', { name: /^妊娠検査/ })).toHaveValue('not_done');
  await rowB.getByRole('button', { name: '対面で確認した', exact: true }).first().click();
  await expect(rowB.getByRole('button', { name: '販売可として記録' })).toBeEnabled();
  await rowB.getByRole('button', { name: '販売可として記録' }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[0]).toMatchObject({ path: `${root}/intakes/B/counter-confirmations/A`, body: { mismatchItems: [] } });
  expect(writes[1]).toMatchObject({
    path: `${root}/intakes/B/sale`,
    body: {
      expectedVersion: 7,
      identityCheck: 'unverified',
      pregnancyTest: 'not_done',
      inPersonDose: 'not_done',
      explained: [],
    },
  });
  expect(unexpected).toEqual([]);
});
