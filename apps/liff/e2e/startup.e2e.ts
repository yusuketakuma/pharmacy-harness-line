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
      data: { accountName: 'E2E薬局', enabledFeatures: ['prescription_intake'] },
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
  await expect(page.getByText('E2E薬局')).toBeVisible();
  await expect(page.getByRole('link', { name: /処方せん事前送信/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & { __LIFF_E2E_CALLS__?: string[] }
  ).__LIFF_E2E_CALLS__)).toEqual([
    'init:e2e-liff',
    'isLoggedIn',
    'getProfile',
    'getIDToken',
  ]);
});
