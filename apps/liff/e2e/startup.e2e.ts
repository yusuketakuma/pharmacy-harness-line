import { expect, test } from '@playwright/test';
import { STARTUP_ERROR_MESSAGE } from '../src/lib/startup-error.js';

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

  await page.goto('http://127.0.0.1:4174/pharmacy/menu?liffId=e2e-liff');

  await expect(page.getByRole('heading', { name: 'すべての機能', level: 1 })).toBeVisible();
  await expect(page.getByText('とても長い名称でも安全に表示できるE2E薬局')).toBeVisible();
  await expect(page.getByRole('link', { name: /処方せん事前送信/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: '今すぐ行う', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: '送信後の確認・フォロー', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: '薬局情報・相談', level: 2 })).toBeVisible();
  const menuLinks = await page.locator('main a').evaluateAll((elements) => elements.map((element) => element.getAttribute('href')));
  expect(menuLinks.every((href) => href && new URL(href, 'http://127.0.0.1:4174').searchParams.get('liffId') === 'e2e-liff')).toBe(true);
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

  await page.goto('http://127.0.0.1:4174/pharmacy/menu?liffId=e2e-liff');
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

  await page.goto('http://127.0.0.1:4174/pharmacy/info?liffId=e2e-liff');
  await expect(page.getByRole('alert')).toContainText('利用中の機能を確認できませんでした');
  await expect(page.getByRole('heading', { name: '営業時間', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: '再試行' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect.poll(() => accessAttempts).toBe(2);
});
