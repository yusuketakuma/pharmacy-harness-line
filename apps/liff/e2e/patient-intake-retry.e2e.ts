import { expect, test, type Page, type Route } from '@playwright/test';

async function mockPatientReads(page: Page, failedResource: 'intake' | 'access') {
  const reads = { intake: 0, access: 0 };
  const mutations: string[] = [];
  await page.route('**/api/liff/config?**', (route) => route.fulfill({
    json: { success: true, data: { accountName: '合成薬局', enabledFeatures: ['patient_intake'] } },
  }));
  await page.route('**/api/liff/pharmacy/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') mutations.push(pathname);
    if (pathname.endsWith('/feature-access')) return route.fulfill({ json: { data: { existingFeatures: [] } } });
    if (pathname.endsWith('/patients')) return route.fulfill({ json: { patients: [{
      id: 'patient-a', relationship: 'self', name: '合成患者', name_kana: 'ゴウセイカンジャ',
      birth_date: '1990-01-01', sex: 'female', updated_at: '2026-09-01T00:00:00.000Z', archived_at: null,
    }] } });
    if (pathname.endsWith('/privacy-policy')) return route.fulfill({ json: { policy: {
      purpose_text: '合成目的', purpose_url: '', contact_point: '合成薬局', entrustment_text: '',
      policy_version: 1, content_hash: 'a'.repeat(64),
    } } });
    for (const resource of ['intake', 'access'] as const) {
      if (!pathname.endsWith(`/${resource}`)) continue;
      reads[resource] += 1;
      if (resource === failedResource && reads[resource] === 1) return route.fulfill({ status: 503, json: {} });
      return route.fulfill({ json: resource === 'intake'
        ? { intake: { revision: 3, answers_json: JSON.stringify({ allergiesStatus: 'yes', allergiesDetail: '以前の合成回答' }) } }
        : { access: { access: 'self', permission: 'patient_intake_v1', proxyExpiresAt: null, privacy: 'active', notifications: 'enabled', controlVersion: 1 } } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  return { reads, mutations };
}

for (const resource of ['intake', 'access'] as const) {
  test(`recovers a failed ${resource} read without discarding unsent answers`, async ({ page }) => {
    const { reads, mutations } = await mockPatientReads(page, resource);
    await page.addInitScript(() => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('pharmacy-liff-draft:')) throw new Error('synthetic storage unavailable');
        setItem.call(this, key, value);
      };
    });
    await page.goto('http://127.0.0.1:4303/pharmacy/patient-intake?liffId=e2e-liff');
    await expect(page.getByText('この機能は現在利用できません。薬局にお問い合わせください。')).toBeVisible();
    await page.locator('label').filter({ has: page.locator('input[name="allergiesStatus"][value="yes"]') }).click();
    const details = page.getByRole('textbox', { name: 'アレルギーの内容（任意）' });
    await details.fill('未送信の合成回答');
    await page.getByRole('button', { name: '患者の回答と設定を再読み込み' }).click();
    await expect.poll(() => reads[resource]).toBe(2);
    await expect(page.getByRole('button', { name: '患者の回答と設定を再読み込み' })).toHaveCount(0);
    await expect(details).toHaveValue('未送信の合成回答');
    await expect(details).toBeEnabled();
    await expect(page.getByText('設定を確認しています...')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'お知らせを停止する' })).toBeEnabled();
    await expect(page.getByText('この機能は現在利用できません。薬局にお問い合わせください。')).toHaveCount(0);
    expect(mutations).toEqual([]);
  });
}

test('retries failed patient reads on reconnect without submitting', async ({ page }) => {
  const { reads, mutations } = await mockPatientReads(page, 'intake');
  await page.goto('http://127.0.0.1:4303/pharmacy/patient-intake?liffId=e2e-liff');
  await expect(page.getByText('この機能は現在利用できません。薬局にお問い合わせください。')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => reads.intake).toBe(2);
  await expect(page.getByRole('button', { name: '前回から変更なしで更新' })).toBeEnabled();
  expect(mutations).toEqual([]);
});

test('discards a retry response after switching patients', async ({ page }) => {
  await mockPatientReads(page, 'intake');
  await page.route('**/api/liff/pharmacy/patients?**', (route) => route.fulfill({ json: { patients:
    ['a', 'b'].map((id) => ({ id: `patient-${id}`, relationship: 'self', name: `合成患者${id}`,
      birth_date: '1990-01-01', sex: 'female', updated_at: '2026-09-01T00:00:00.000Z', archived_at: null })) },
  }));
  await page.route('**/patients/patient-b/intake?**', (route) => route.fulfill({ json: {
    intake: { revision: 5, answers_json: JSON.stringify({ allergiesStatus: 'yes', allergiesDetail: '患者Bの合成回答' }) },
  } }));
  await page.goto('http://127.0.0.1:4303/pharmacy/patient-intake?liffId=e2e-liff');
  await expect(page.getByText('この機能は現在利用できません。薬局にお問い合わせください。')).toBeVisible();
  let pending: Route | undefined;
  await page.route('**/patients/patient-a/intake?**', (route) => { pending = route; });
  await page.getByRole('button', { name: '患者の回答と設定を再読み込み' }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.getByLabel('患者を選択').selectOption('patient-b');
  const details = page.getByRole('textbox', { name: 'アレルギーの内容（任意）' });
  await expect(details).toHaveValue('患者Bの合成回答');
  const received = page.waitForResponse('**/patients/patient-a/intake?**');
  await pending!.fulfill({ json: { intake: { revision: 8, answers_json: JSON.stringify({
    allergiesStatus: 'yes', allergiesDetail: '患者Aの遅延回答',
  }) } } });
  await received;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByLabel('患者を選択')).toHaveValue('patient-b');
  await expect(details).toHaveValue('患者Bの合成回答');
  await expect(page.getByText(/回答版：第5版/)).toBeVisible();
});
