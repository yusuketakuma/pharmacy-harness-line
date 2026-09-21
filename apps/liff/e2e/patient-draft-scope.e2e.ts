import { expect, test, type Page } from '@playwright/test';

const url = (subject: string, liffId = 'e2e-liff') =>
  `http://127.0.0.1:4303/pharmacy/patient-intake?liffId=${liffId}&syntheticSubject=${subject}`;

async function mockReads(page: Page, existingPatient = false, samePatient = false) {
  page.on('dialog', dialog => dialog.accept());
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1'
    ? route.continue() : route.abort());
  await page.route('**/api/liff/config?**', route => route.fulfill({ json: { success: true, data: {
    accountName: '合成薬局', enabledFeatures: ['patient_intake'],
  } } }));
  await page.route('**/api/liff/pharmacy/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') return route.abort();
    if (path.endsWith('/feature-access')) return route.fulfill({ json: { data: { existingFeatures: [] } } });
    if (path.endsWith('/patients')) {
      const subject = new URL(page.url()).searchParams.get('syntheticSubject');
      return route.fulfill({ json: { patients: existingPatient ? [{
        id: samePatient ? 'patient-shared' : `patient-${subject}`, relationship: 'self', name: '合成患者',
        name_kana: 'ゴウセイカンジャ', birth_date: '1990-01-01', sex: 'female',
        updated_at: '2026-09-01T00:00:00.000Z', archived_at: null,
      }] : [] } });
    }
    if (path.endsWith('/privacy-policy')) return route.fulfill({ json: { policy: {
      purpose_text: '合成目的', purpose_url: '', contact_point: '合成薬局', entrustment_text: '',
      policy_version: 1, content_hash: 'a'.repeat(64),
    } } });
    if (path.endsWith('/intake')) return route.fulfill({ json: { intake: null } });
    if (path.endsWith('/access')) return route.fulfill({ json: { access: {
      access: 'self', permission: 'patient_intake_v1', proxyExpiresAt: null,
      privacy: 'active', notifications: 'enabled', controlVersion: 1,
    } } });
    return route.fulfill({ status: 404, json: {} });
  });
}

async function persisted(page: Page, text: string) {
  await expect.poll(() => page.evaluate(value => Object.values(localStorage).some(raw => raw.includes(value)), text)).toBe(true);
}

test('keeps new-patient input isolated by LINE user and pharmacy across reloads', async ({ page }) => {
  await mockReads(page);
  await page.goto(url('A'));
  const name = page.locator('input[autocomplete="name"]');
  await name.fill('合成利用者A');
  await persisted(page, '合成利用者A');
  await page.reload();
  await expect(name).toHaveValue('合成利用者A');
  await page.goto(url('B'));
  await expect(name).toHaveValue('');
  await name.fill('合成利用者B');
  await persisted(page, '合成利用者B');
  await page.goto(url('A', 'other-liff'));
  await expect(name).toHaveValue('');
  await page.goto(url('A'));
  await expect(name).toHaveValue('合成利用者A');
  await page.goto(url('B'));
  await expect(name).toHaveValue('合成利用者B');
});

test('does not adopt or delete unattributed legacy new-patient drafts', async ({ page }) => {
  await mockReads(page);
  await page.addInitScript(() => {
    for (const key of ['patient-profile:new', 'patient-profile:new:e2e-liff']) {
      localStorage.setItem(`pharmacy-liff-draft:v1:${key}`, JSON.stringify({
        savedAt: Date.now(), data: { patientDraft: { name: '未帰属の合成入力' } },
      }));
    }
  });
  await page.goto(url('A'));
  await expect(page.locator('input[autocomplete="name"]')).toHaveValue('');
  expect(await page.evaluate(() => Object.values(localStorage).filter(raw => raw.includes('未帰属の合成入力')).length)).toBe(2);
});

for (const samePatient of [false, true]) {
  test(`isolates questionnaire drafts without sweeping another user (shared patient=${samePatient})`, async ({ page }) => {
    await mockReads(page, true, samePatient);
    await page.goto(url('A'));
    const chooseYes = () => page.locator('label').filter({ has: page.locator('input[name="allergiesStatus"][value="yes"]') }).click();
    await chooseYes();
    const details = page.getByRole('textbox', { name: 'アレルギーの内容（任意）' });
    await details.fill('利用者Aの合成下書き');
    await persisted(page, '利用者Aの合成下書き');
    await page.goto(url('B'));
    await chooseYes();
    await expect(details).toHaveValue('');
    await persisted(page, '利用者Aの合成下書き');
    await details.fill('利用者Bの合成下書き');
    await persisted(page, '利用者Bの合成下書き');
    await page.goto(url('A'));
    await expect(details).toHaveValue('利用者Aの合成下書き');
  });
}
