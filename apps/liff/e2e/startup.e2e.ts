import { expect, test, type Page } from '@playwright/test';
import { STARTUP_ERROR_MESSAGE } from '../src/lib/startup-error.js';

const renderedPharmacyRoutes = [
  { path: '/pharmacy/menu', title: 'すべての機能', content: '今すぐ行う' },
  { path: '/prescriptions?view=send', title: '処方せん事前送信', content: '患者を選択' },
  { path: '/pharmacy/info', title: '薬局情報', content: '営業時間' },
  { path: '/pharmacy/patient-intake', title: '患者アンケート', content: '回答する患者' },
  { path: '/pharmacy/continuity', title: '継続フォロー', content: '現在、継続フォローはありません' },
  { path: '/pharmacy/receive', title: '処方せん事前送信', content: '患者を選択' },
  { path: '/pharmacy/medication-followup', title: '服薬後フォロー', content: '現在、確認が必要な服薬後フォローはありません' },
  { path: '/pharmacy/emergency-contraception', title: '緊急避妊薬', content: '現在この画面から受付できません' },
] as const;

async function mockAllPharmacyRoutes(page: Page): Promise<void> {
  await page.route('**/api/liff/config?**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      data: {
        accountName: '長い薬局名でも読みやすさを保つE2E確認薬局',
        enabledFeatures: [
          'prescription_intake', 'patient_intake', 'electronic_prescription',
          'continuity', 'medication_followup', 'emergency_contraception', 'pharmacy_info',
        ],
      },
    }),
  }));
  await page.route('**/api/liff/pharmacy/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const bodies: Record<string, unknown> = {
      '/api/liff/pharmacy/feature-access': { data: { existingFeatures: [] } },
      '/api/liff/pharmacy/prescriptions/me': { submissions: [] },
      '/api/liff/pharmacy/patients': { patients: [] },
      '/api/liff/pharmacy/privacy-policy': {
        policy: {
          purpose_text: '調剤と服薬支援に利用します。',
          purpose_url: '',
          contact_point: 'E2E薬局',
          entrustment_text: '',
          policy_version: 1,
          content_hash: 'a'.repeat(64),
        },
      },
      '/api/liff/pharmacy/myna-handoffs/active': { handoff: null },
      '/api/liff/pharmacy/continuity': { obligations: [], expectations: [] },
      '/api/liff/pharmacy/medication-followups': { followUps: [] },
      '/api/liff/pharmacy/emergency-contraception': {
        service: {
          ready: false,
          reason: 'not_configured',
          consent: null,
          manufacturer_check_url: null,
          partner_clinic_url: null,
          support_center_url: null,
          slots: [],
        },
        intakes: [],
        server_now: '2026-08-25T00:00:00.000Z',
      },
      '/api/liff/pharmacy/public-profile': {
        profile: {
          display_name: 'E2E確認薬局', phone: '', fax_number: '', postal_code: '', address: '',
          business_hours: '月曜から金曜 9時から18時', closure_notice: '', access_note: '',
          parking_note: '', google_maps_url: '', prescription_reception_hours: '',
          after_hours_note: '', services_note: '', accessibility_note: '', supported_languages: '',
          payment_methods: '', website_url: '', updated_at: null,
        },
      },
    };
    const body = bodies[pathname];
    return body
      ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
      : route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
}

test('keeps startup failures technical-detail-free', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('#root')).toHaveAttribute(
    'data-pharmacy-liff-build',
    'pharmacy-liff-multitenant-v1',
  );
  await expect(page.getByRole('heading', { name: '起動できませんでした' })).toBeVisible();
  await expect(page.getByText(STARTUP_ERROR_MESSAGE)).toBeVisible();
  await expect(page.locator('body')).not.toContainText('liffId not provided');
});

test('shows an accessible status while LIFF initializes', async ({ page }) => {
  await page.goto(
    'http://127.0.0.1:4303/pharmacy/menu?liffId=e2e-liff&liffInitDelay=1000',
    { waitUntil: 'domcontentloaded' },
  );

  await expect(page.getByRole('status')).toHaveText('アプリを起動しています…', { timeout: 300 });
});

test('initializes LIFF and renders the pharmacy menu', async ({ page }) => {
  await page.route('**/api/liff/config?**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      data: {
        accountName: 'とても長い名称でも安全に表示できるE2E薬局',
        enabledFeatures: [
          'prescription_intake', 'patient_intake', 'electronic_prescription',
          'continuity', 'medication_followup', 'emergency_contraception', 'pharmacy_info',
        ],
      },
    }),
  }));
  await page.route('**/api/liff/pharmacy/feature-access?**', (route) => {
    expect(new URL(route.request().url()).searchParams.get('liffId')).toBe('e2e-liff');
    expect(route.request().headers().authorization).toBe('Bearer e2e-id-token');
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { existingFeatures: [] } }),
    });
  });

  await page.goto('http://127.0.0.1:4303/pharmacy/menu?liffId=e2e-liff');

  await expect(page.getByRole('heading', { name: 'すべての機能', level: 1 })).toBeVisible();
  await expect(page.getByText('とても長い名称でも安全に表示できるE2E薬局')).toBeVisible();
  await expect(page.getByRole('link', { name: /処方せん事前送信/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: '今すぐ行う', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: '送信後の確認・フォロー', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: '薬局情報・相談', level: 2 })).toBeVisible();
  const menuLinks = await page.locator('main a').evaluateAll((elements) => elements.map((element) => element.getAttribute('href')));
  expect(menuLinks.every((href) => href && new URL(href, 'http://127.0.0.1:4303').searchParams.get('liffId') === 'e2e-liff')).toBe(true);
  const sendLink = page.getByRole('link', { name: /処方せん事前送信/ });
  await sendLink.focus();
  await expect(sendLink).toBeFocused();
  await expect(sendLink).toHaveAttribute('aria-label', /利用可否：利用できます/);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const controls = await page.locator('a, button').evaluateAll((elements) => elements.map((element) => {
      const { width: controlWidth, height } = element.getBoundingClientRect();
      return { controlWidth, height };
    }));
    expect(controls.every(({ controlWidth, height }) => controlWidth >= 44 && height >= 44)).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole('heading', { name: '薬局情報・相談', level: 2 })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & { __LIFF_E2E_CALLS__?: string[] }
  ).__LIFF_E2E_CALLS__)).toEqual([
    'init:e2e-liff',
    'isLoggedIn',
    'getProfile',
    'getIDToken',
  ]);
});

test('keeps existing-only state and tenant navigation across browser history and reload', async ({ page }) => {
  await page.route('**/api/liff/config?**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      data: { accountName: 'E2E薬局', enabledFeatures: ['pharmacy_info'] },
    }),
  }));
  await page.route('**/api/liff/pharmacy/feature-access?**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ data: { existingFeatures: ['prescription_intake'] } }),
  }));
  await page.route('**/api/liff/pharmacy/public-profile?**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      profile: {
        display_name: 'E2E薬局', phone: '', fax_number: '', postal_code: '', address: '',
        business_hours: '', closure_notice: '', access_note: '', parking_note: '',
        google_maps_url: '', prescription_reception_hours: '', after_hours_note: '',
        services_note: '', accessibility_note: '', supported_languages: '',
        payment_methods: '', website_url: '', updated_at: null,
      },
    }),
  }));

  await page.goto('http://127.0.0.1:4303/pharmacy/menu?liffId=e2e-liff');
  await expect(page.getByRole('link', { name: /処方せん事前送信/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /受付状況。利用可否：確認のみ/ })).toBeVisible();
  await page.getByRole('link', { name: /薬局情報。利用可否：利用できます/ }).click();
  await expect(page.getByRole('heading', { name: '薬局情報', level: 1 })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('liffId')).toBe('e2e-liff');

  await page.goBack();
  await expect(page.getByRole('heading', { name: 'すべての機能', level: 1 })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: '薬局情報', level: 1 })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '薬局情報', level: 1 })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('liffId')).toBe('e2e-liff');
});

test('keeps enabled features usable when existing-work lookup fails and retries safely', async ({ page }) => {
  let accessAttempts = 0;
  await page.route('**/api/liff/config?**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      data: { accountName: 'E2E薬局', enabledFeatures: ['pharmacy_info'] },
    }),
  }));
  await page.route('**/api/liff/pharmacy/feature-access?**', (route) => {
    accessAttempts += 1;
    return accessAttempts === 1
      ? route.fulfill({ status: 503, body: '{}' })
      : route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ data: { existingFeatures: [] } }),
        });
  });
  await page.route('**/api/liff/pharmacy/public-profile?**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      profile: {
        display_name: 'E2E薬局', phone: '', fax_number: '', postal_code: '', address: '',
        business_hours: '', closure_notice: '', access_note: '', parking_note: '',
        google_maps_url: '', prescription_reception_hours: '', after_hours_note: '',
        services_note: '', accessibility_note: '', supported_languages: '',
        payment_methods: '', website_url: '', updated_at: null,
      },
    }),
  }));

  await page.goto('http://127.0.0.1:4303/pharmacy/info?liffId=e2e-liff');
  await expect(page.getByRole('alert')).toContainText('利用中の機能を確認できませんでした');
  await expect(page.getByRole('heading', { name: '営業時間', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: '再試行' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect.poll(() => accessAttempts).toBe(2);
});

for (const route of renderedPharmacyRoutes) {
  test(`renders ${route.path} (${route.title}) with keyboard and responsive contracts`, async ({ page }) => {
    await mockAllPharmacyRoutes(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const separator = route.path.includes('?') ? '&' : '?';
    await page.goto(`http://127.0.0.1:4303${route.path}${separator}liffId=e2e-liff`);

    const title = page.getByRole('heading', { name: route.title, level: 1 });
    await expect(title).toBeVisible();
    await expect(title).toBeFocused();
    await expect(page.getByText(route.content, { exact: false }).first()).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'すべての機能へ戻る' }).first()).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const controls = await page.locator('a:visible, button:visible').evaluateAll((elements) =>
      elements.map((element) => {
        const { width, height } = element.getBoundingClientRect();
        return { width, height, text: element.textContent?.trim() ?? '' };
      }));
    expect(controls.filter(({ width, height }) => width < 44 || height < 44)).toEqual([]);

    await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(title).toBeVisible();
  });
}
