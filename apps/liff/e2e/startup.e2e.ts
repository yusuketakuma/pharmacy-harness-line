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
