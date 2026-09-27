import { expect, test, type Route } from '@playwright/test';

for (const status of [200, 503]) {
  test(`keeps every response locked until the pending submission settles (${status})`, async ({ page }) => {
    const followUps = ['a', 'b'].map((id) => ({
      id,
      patient_name: `合成患者${id}`,
      status: 'delivered',
      version: 1,
      due_at: '2026-09-01T00:00:00.000Z',
      delivered_at: '2026-09-01T00:00:00.000Z',
      responded_at: null,
      closed_at: null,
    }));
    const submissions: Route[] = [];
    page.on('dialog', (dialog) => dialog.accept());
    await page.route('**/api/liff/config?**', (route) =>
      route.fulfill({
        json: {
          success: true,
          data: { accountName: '合成薬局', enabledFeatures: ['medication_followup'] },
        },
      }),
    );
    await page.route('**/api/liff/pharmacy/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith('/respond')) {
        submissions.push(route);
        return;
      }
      if (pathname.endsWith('/feature-access')) return route.fulfill({ json: { data: { existingFeatures: [] } } });
      if (pathname.endsWith('/outlook')) return route.fulfill({ json: { outlook: null } });
      if (pathname.endsWith('/medication-followups')) return route.fulfill({ json: { followUps } });
      return route.fulfill({ status: 404, json: {} });
    });
    await page.goto('http://127.0.0.1:4303/pharmacy/medication-followup?liffId=e2e-liff');
    const first = page.getByRole('listitem').filter({ hasText: '合成患者a' });
    const second = page.getByRole('listitem').filter({ hasText: '合成患者b' });
    await first.getByRole('button', { name: /問題なく使えている/ }).click();
    await expect.poll(() => submissions.length).toBe(1);
    for (const button of await page.getByRole('listitem').getByRole('button').all()) {
      await expect(button).toBeDisabled();
    }
    expect(submissions[0].request().postDataJSON()).toMatchObject({
      response: 'no_issue',
      expectedVersion: 1,
    });

    await submissions[0].fulfill({
      status,
      json: status === 200 ? { followUp: { ...followUps[0], status: 'no_issue', version: 2 } } : {},
    });
    await expect(second.getByRole('button', { name: /問題なく使えている/ })).toBeEnabled();
    if (status === 503)
      await expect(page.getByRole('alert').filter({ hasText: '回答を送信できませんでした' })).toBeVisible();
    else await expect(first).toContainText('回答を薬局へ送りました');
    await second.getByRole('button', { name: /問題なく使えている/ }).click();
    await expect.poll(() => submissions.length).toBe(2);
    expect(submissions[1].request().url()).toContain('/b/respond');
    await submissions[1].fulfill({
      json: { followUp: { ...followUps[1], status: 'no_issue', version: 2 } },
    });
    await expect(second).toContainText('回答を薬局へ送りました');
  });
}
