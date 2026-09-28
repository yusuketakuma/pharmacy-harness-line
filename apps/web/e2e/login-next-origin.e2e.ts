import { expect, test } from '@playwright/test';

for (const { next, destination } of [
  { next: '/\t/evil.example', destination: '/' },
  { next: '/\t/admin.invalid', destination: '/' },
  { next: '/settings?view=synthetic#details', destination: '/settings' },
]) {
  test(`login validates next destination ${JSON.stringify(next)}`, async ({ page, baseURL }) => {
    const externalNavigations: string[] = [];
    const session = {
      success: true,
      csrfToken: 'synthetic-csrf-token',
      data: {
        id: 'synthetic-staff',
        name: '合成スタッフ',
        role: 'admin',
        tenantId: 'synthetic-tenant',
        tenantCode: 'synthetic',
        tenantName: '合成薬局',
        mustChangePassword: false,
      },
    };
    let loggedIn = false;
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/auth/session') {
        await route.fulfill({
          status: loggedIn ? 200 : 401,
          json: loggedIn ? session : { success: false },
        });
      } else if (url.pathname === '/api/auth/login') {
        loggedIn = true;
        await route.fulfill({ json: session });
      } else if (url.pathname.startsWith('/api/')) {
        await route.fulfill({ json: { success: true, data: [] } });
      } else if (url.origin === new URL(baseURL!).origin) {
        await route.continue();
      } else {
        if (route.request().isNavigationRequest()) externalNavigations.push(url.href);
        await route.fulfill({
          contentType: 'text/html',
          body: '<p>Blocked synthetic external destination</p>',
        });
      }
    });
    await page.goto(`/login?${new URLSearchParams({ next })}`);
    await page.getByLabel('薬局コード').fill('synthetic');
    await page.getByLabel('パスワード', { exact: true }).fill('synthetic-password');
    await page.getByRole('button', { name: 'ログイン', exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname === destination || externalNavigations.length > 0).toBe(true);
    expect(externalNavigations).toEqual([]);
    expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin);
    expect(new URL(page.url()).pathname).toBe(destination);
    if (destination === '/settings') {
      expect(new URL(page.url()).search).toBe('?view=synthetic');
      expect(new URL(page.url()).hash).toBe('#details');
    }
  });
}
