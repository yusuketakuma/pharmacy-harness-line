import { expect, test, type Page, type Route } from '@playwright/test'

const patient = {
  lineAccountId: 'synthetic-account',
  id: 'synthetic-patient',
  relationship: 'self',
  name: '合成患者',
  name_kana: 'ゴウセイカンジャ',
  birth_date: '1990-01-01',
  sex: 'prefer_not_to_say',
  contact_phone: null,
  postal_code: null,
  prefecture: null,
  city: null,
  address_line1: null,
  address_line2: null,
  archived_at: null,
}

async function platformRoute(page: Page, intercept: (route: Route, path: string) => Promise<boolean>) {
  const unexpected: string[] = []
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (await intercept(route, path)) return
    if (path === '/api/auth/session') {
      await route.fulfill({ json: { success: true, data: { id: 'synthetic-admin' } } })
      return
    }
    unexpected.push(`${route.request().method()} ${path}`)
    await route.fulfill({ status: 500, json: { error: 'Unexpected synthetic request' } })
  })
  return unexpected
}

test('support expiry clears the patient list and ignores stale responses', async ({ page }) => {
  let patientCalls = 0
  let releaseStale!: () => void
  const staleResponse = new Promise<void>((resolve) => { releaseStale = resolve })
  let staleRequested!: () => void
  const staleRequest = new Promise<void>((resolve) => { staleRequested = resolve })
  let forbiddenRequested!: () => void
  const forbiddenRequest = new Promise<void>((resolve) => { forbiddenRequested = resolve })

  const unexpected = await platformRoute(page, async (route, path) => {
    if (path === '/api/platform-admin/session') {
      await route.fulfill({ json: {
        success: true,
        data: { id: 'synthetic-admin', name: '合成管理者', mustChangePassword: false },
      } })
      return true
    }
    if (path === '/api/platform-admin/support-grants/active') {
      await route.fulfill({ json: { success: true, data: [] } })
      return true
    }
    if (path !== '/api/platform-admin/tenants/tenant-a/patients') return false
    patientCalls += 1
    // Next dev may mount effects twice; let both initial requests complete.
    if (patientCalls <= 2) {
      await route.fulfill({ json: { success: true, data: [patient] } })
      return true
    }
    if (patientCalls === 3) {
      staleRequested()
      await staleResponse
      await route.fulfill({ json: { success: true, data: [patient] } })
      return true
    }
    forbiddenRequested()
    await route.fulfill({ status: 403, json: { error: 'support required' } })
    return true
  })

  await page.goto('/platform-admin/tenants/patients?id=tenant-a')
  await expect(page.getByText('合成患者', { exact: true })).toBeVisible()

  await page.evaluate(() => window.dispatchEvent(new Event('lh-platform-admin-support-access-expired')))
  await staleRequest
  await expect(page.getByText('合成患者', { exact: true })).toHaveCount(0)

  await page.evaluate(() => window.dispatchEvent(new Event('lh-platform-admin-grants-changed')))
  await forbiddenRequest
  releaseStale()
  await expect(page.getByText('合成患者', { exact: true })).toHaveCount(0)
  await expect(page.getByText('このテナントの患者情報を見るにはサポートモードを開始してください')).toBeVisible()
  expect(unexpected).toEqual([])
})
