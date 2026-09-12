import { expect, test, type Page, type Route } from '@playwright/test'

test.use({ timezoneId: 'America/Los_Angeles' })

const createdAt = '2026-09-05T01:00:00.000Z'
const submission = (id: string) => ({
  id, friend_id: `synthetic-friend-${id}`, patient_display_name: `合成患者${id}`,
  status: 'received', desired_pickup_at: null, desired_fulfillment_method: null,
  arrival_reported_at: null, requested_at: createdAt, created_at: createdAt,
  updated_at: createdAt, active_revision: 1, upload_revision: 1,
  resubmission_reason_code: null, closed_at: null,
})
const detail = (id: string) => ({
  submission: submission(id), files: [], events: [], source: null, validity: null,
})
const stats = {
  pending_count: 2, oldest_wait_at: createdAt, draft_count: 0, received_count: 2,
  needs_resubmission_count: 0, accepted_count: 0, ready_count: 0,
  closed_count: 0, cancelled_count: 0, total_count: 2,
}

async function settleRender(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function mockPharmacy(page: Page, intercept?: (route: Route, path: string) => Promise<boolean>) {
  const unexpected: string[] = []
  // All identities and API responses are synthetic. No live LINE or pharmacy API.
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (intercept && await intercept(route, path)) return
    let json: unknown
    if (path === '/api/auth/session') json = { success: true, data: { name: '合成スタッフ', role: 'owner' }, csrfToken: 'synthetic-csrf' }
    else if (path === '/api/line-accounts') json = { success: true, data: [{ id: 'synthetic-account', name: '合成薬局', isActive: true, pharmacyMode: true }] }
    else if (path.endsWith('/growth/config')) json = { success: true, data: { capabilities: ['prescription_intake', 'patient_intake', 'manual_chat'] } }
    else if (path.endsWith('/active-work')) json = { success: true, data: {} }
    else if (path.includes('/unanswered')) json = { success: true, data: { total: 0 } }
    else if (path === '/api/custom/pharmacy/prescriptions/stats') json = { stats }
    else if (path === '/api/custom/pharmacy/prescriptions') json = { items: [submission('A'), submission('B')], nextCursor: null }
    else if (/\/prescriptions\/[AB]$/.test(path)) json = detail(path.slice(-1))
    else if (path.includes('/fulfillment-quotes/')) json = { quote: null }
    else if (path.endsWith('/growth/sources')) json = { success: true, data: [] }
    else {
      unexpected.push(`${route.request().method()} ${path}`)
      await route.fulfill({ status: 500, json: { error: 'Unexpected synthetic request' } })
      return
    }
    await route.fulfill({ json })
  })
  await page.goto('/prescriptions')
  await expect(page.getByRole('button', { name: /合成患者A/ })).toBeVisible()
  return unexpected
}

for (const failureStatus of [409, 503]) test(`quote saves keep the editing revision and Japanese time, then require explicit recovery (${failureStatus})`, async ({ page }) => {
  let revision = 1
  const writes: Array<Record<string, unknown>> = []
  const unexpected = await mockPharmacy(page, async (route, path) => {
    if (!path.endsWith('/fulfillment-quotes/A')) return false
    if (route.request().method() === 'POST') {
      writes.push(route.request().postDataJSON())
      await route.fulfill({ status: failureStatus, json: { error: 'Synthetic quote save failure' } })
    } else await route.fulfill({ json: { quote: {
      id: `synthetic-quote-${revision}`, submission_id: 'A', line_account_id: 'synthetic-account',
      revision, decision: 'needs_confirmation', reasonCodes: [], requirements: [],
      estimatedReadyAt: '2026-09-05T06:30:00.000Z', validUntil: null,
      status: 'CHECKING', fulfillmentMethod: null, constraints: [],
    } } })
    return true
  })
  await page.getByRole('button', { name: /合成患者A/ }).click()
  const ready = page.getByLabel(/準備予定時刻/)
  await expect(ready).toHaveValue('2026-09-05T15:30')
  await expect(page.getByText('受付日時', { exact: true }).locator('..')).toContainText('2026/09/05 10:00')
  await ready.fill('2026-09-05T16:00')
  revision = 2
  const refreshed = page.waitForResponse((res) => res.url().includes('/fulfillment-quotes/A'))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await refreshed
  await expect(page.getByText(/第2版・/)).toBeVisible()
  const save = page.getByRole('button', { name: '受付内容を保存', exact: true })
  await save.click()
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]).toMatchObject({ expectedRevision: 1, estimatedReadyAt: '2026-09-05T07:00:00.000Z' })
  await expect(page.getByRole('alert').filter({ hasText: failureStatus === 409 ? '受付回答が変わりました' : '受付回答の保存結果を確認できませんでした' })).toBeVisible()
  await expect(ready).toHaveValue('2026-09-05T16:00')
  await expect(save).toBeDisabled()
  page.once('dialog', (dialog) => dialog.dismiss())
  await page.getByRole('button', { name: '受付回答の入力を破棄して再読み込み' }).click()
  await expect(save).toBeDisabled()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '受付回答の入力を破棄して再読み込み' }).click()
  await expect(ready).toHaveValue('2026-09-05T15:30')
  await expect(save).toBeEnabled()
  expect(writes).toHaveLength(1)
  expect(unexpected).toEqual([])
})

test('a late detail response cannot replace the currently selected prescription', async ({ page }) => {
  let releaseA!: () => void
  const heldA = new Promise<void>((resolve) => { releaseA = resolve })
  let requestedA!: () => void
  const startedA = new Promise<void>((resolve) => { requestedA = resolve })
  const unexpected = await mockPharmacy(page, async (route, path) => {
    if (path !== '/api/custom/pharmacy/prescriptions/A') return false
    requestedA()
    await heldA
    await route.fulfill({ json: detail('A') })
    return true
  })
  await page.getByRole('button', { name: /合成患者A/ }).click()
  await startedA
  await page.getByRole('button', { name: /合成患者B/ }).click()
  const chat = page.getByRole('link', { name: '個別チャットを開く' })
  await expect(chat).toHaveAttribute('href', '/chats?friend=synthetic-friend-B')
  const responseA = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/custom/pharmacy/prescriptions/A')
  releaseA()
  await responseA
  await settleRender(page)
  await expect(chat).toHaveAttribute('href', '/chats?friend=synthetic-friend-B')
  expect(unexpected).toEqual([])
})

test('switching accounts discards in-flight detail and never keeps the previous account patient', async ({ page }) => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  let started!: () => void
  const requested = new Promise<void>((resolve) => { started = resolve })
  const unexpected = await mockPharmacy(page, async (route, path) => {
    if (path === '/api/line-accounts') {
      await route.fulfill({ json: { success: true, data: [
        { id: 'synthetic-account', name: '合成薬局A', isActive: true, pharmacyMode: true },
        { id: 'synthetic-account-b', name: '合成薬局B', isActive: true, pharmacyMode: true },
      ] } })
      return true
    }
    const account = new URL(route.request().url()).searchParams.get('line_account_id')
    if (account === 'synthetic-account-b' && path === '/api/custom/pharmacy/prescriptions') {
      await route.fulfill({ json: { items: [submission('B')], nextCursor: null } })
      return true
    }
    if (path !== '/api/custom/pharmacy/prescriptions/A') return false
    if (account === 'synthetic-account-b') {
      await route.fulfill({ status: 404, json: { error: 'Prescription not found' } })
    } else {
      started()
      await pending
      await route.fulfill({ json: detail('A') })
    }
    return true
  })
  await page.getByRole('button', { name: /合成患者A/ }).click()
  await requested
  await page.getByRole('button', { name: /合成薬局A/ }).click()
  await page.getByRole('button', { name: /合成薬局B/ }).click()
  await expect(page.getByRole('button', { name: /合成患者A/ })).toHaveCount(0)
  await page.getByRole('button', { name: /合成患者B/ }).click()
  const chat = page.getByRole('link', { name: '個別チャットを開く' })
  await expect(chat).toHaveAttribute('href', '/chats?friend=synthetic-friend-B')
  const late = page.waitForResponse((res) => new URL(res.url()).pathname.endsWith('/prescriptions/A') &&
    new URL(res.url()).searchParams.get('line_account_id') === 'synthetic-account' && res.status() === 200)
  release()
  await late
  await settleRender(page)
  await expect(chat).toHaveAttribute('href', '/chats?friend=synthetic-friend-B')
  await expect(page.getByText('LINE表示名: 合成患者A')).toHaveCount(0)
  expect(unexpected).toEqual([])
})

test('finishing an action on the previous record does not reopen it or report success on another patient', async ({ page }) => {
  let releaseAction!: () => void
  const pendingAction = new Promise<void>((resolve) => { releaseAction = resolve })
  let actionStarted!: () => void
  const started = new Promise<void>((resolve) => { actionStarted = resolve })
  const unexpected = await mockPharmacy(page, async (route, path) => {
    if (!path.endsWith('/actions/accept')) return false
    actionStarted()
    await pendingAction
    await route.fulfill({ json: { status: 'accepted', statusEventId: 'synthetic-event', notification: { status: 'sent' } } })
    return true
  })
  await page.getByRole('button', { name: /合成患者A/ }).click()
  page.on('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '確認して受付する', exact: true }).click()
  await started
  await page.getByRole('button', { name: /合成患者B/ }).click()
  const chat = page.getByRole('link', { name: '個別チャットを開く' })
  await expect(chat).toHaveAttribute('href', '/chats?friend=synthetic-friend-B')
  const response = page.waitForResponse((res) => res.url().includes('/actions/accept'))
  releaseAction()
  await response
  await settleRender(page)
  await expect(chat).toHaveAttribute('href', '/chats?friend=synthetic-friend-B')
  await expect(page.getByRole('status').filter({ hasText: '状態を更新' })).toHaveCount(0)
  expect(unexpected).toEqual([])
})

test('refreshing the selected prescription preserves unsaved pharmacist review input', async ({ page }) => {
  const unexpected = await mockPharmacy(page, async (route, path) => {
    if (path !== '/api/custom/pharmacy/prescriptions/A') return false
    await route.fulfill({ json: { ...detail('A'), validity: {
      issued_on: '2026-09-04', valid_until: '2026-09-07', validity_basis: 'default_4_days',
      verification_status: 'unverified', verified_by: null, verified_at: null,
      reminder_due_at: null, reminder_sent_at: null, updated_at: createdAt,
    } } })
    return true
  })
  await page.getByRole('button', { name: /合成患者A/ }).click()
  const issuedOn = page.getByLabel('交付日', { exact: true })
  await expect(issuedOn).toHaveValue('2026-09-04')
  await issuedOn.fill('2026-09-05')
  const refreshed = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/custom/pharmacy/prescriptions/A')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await refreshed
  await settleRender(page)
  await expect(issuedOn).toHaveValue('2026-09-05')
  expect(unexpected).toEqual([])
})

test('a conflict stays visible after refetch and never claims an uncompleted refresh', async ({ page }) => {
  let conflict = false
  const unexpected = await mockPharmacy(page, async (route, path) => {
    if (path.endsWith('/actions/accept')) {
      conflict = true
      await route.fulfill({ status: 409, json: { error: 'Prescription changed or action is invalid' } })
      return true
    }
    if (conflict && path === '/api/custom/pharmacy/prescriptions/A') {
      await route.fulfill({ status: 503, json: { error: 'Unavailable' } })
      return true
    }
    return false
  })
  await page.getByRole('button', { name: /合成患者A/ }).click()
  const accept = page.getByRole('button', { name: '確認して受付する', exact: true })
  await expect(accept).toBeVisible()
  page.on('dialog', (dialog) => dialog.accept())
  await accept.click()
  await expect(page.getByRole('alert').filter({ hasText: /最新.*確認|再読み込み/ }).first()).toBeVisible()
  await expect(page.getByText('最新状態を読み込みました。', { exact: false })).toHaveCount(0)
  await expect(accept).toBeDisabled()
  expect(unexpected).toEqual([])
})

test('a failed print acknowledgement keeps images and retries only the same operation', async ({ page }) => {
  const operations: string[] = []
  await page.addInitScript(() => { window.print = () => undefined })
  const task = { id: 'synthetic-print-task', submission_id: 'A', revision: 1, status: 'handling' }
  const unexpected = await mockPharmacy(page, async (route, path) => {
    if (path.endsWith('/print/submissions/A/prepare') || path.endsWith('/print/tasks/synthetic-print-task/claim')) {
      await route.fulfill({ json: { task } })
    } else if (path.endsWith('/print/tasks/synthetic-print-task/ack')) {
      operations.push(route.request().postDataJSON().operationId)
      await route.fulfill(operations.length === 1
        ? { status: 503, json: { error: 'Unavailable' } }
        : { json: { task: { ...task, status: 'acknowledged' } } })
    } else if (path === '/api/custom/pharmacy/prescriptions/A') {
      await route.fulfill({ json: { ...detail('A'), files: [{ id: 'synthetic-image', revision: 1, position: 1, state: 'ready' }] } })
    } else if (path.includes('/files/synthetic-image')) {
      await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="white"/></svg>' })
    } else return false
    return true
  })
  await page.goto('/prescriptions/print?submission_id=A')
  page.on('dialog', (dialog) => dialog.accept())
  const record = page.getByRole('button', { name: '印刷操作済みとして記録', exact: true })
  await expect(record).toBeEnabled()
  await record.click()
  const recordingError = page.getByRole('alert').filter({ hasText: '記録を保存できませんでした' })
  await expect(recordingError).toBeVisible()
  await expect(page.getByRole('img', { name: '処方せん画像 1' })).toBeVisible()
  await expect(record).toBeEnabled()
  await record.click()
  await expect(page.getByRole('button', { name: '記録済み', exact: true })).toBeDisabled()
  await expect(recordingError).toHaveCount(0)
  expect(operations).toHaveLength(2)
  expect(operations[0]).toBe(operations[1])
  expect(unexpected).toEqual([])
})

test('review editing keeps its original version across refresh and requires explicit conflict recovery', async ({ page }) => {
  let currentVersion = createdAt
  const saves: Array<{ expectedUpdatedAt?: string | null }> = []
  const unexpected = await mockPharmacy(page, async (route, path) => {
    if (path === '/api/custom/pharmacy/prescriptions/A') {
      await route.fulfill({ json: { ...detail('A'), validity: {
        issued_on: '2026-09-04', valid_until: '2026-09-07', validity_basis: 'default_4_days',
        verification_status: 'unverified', updated_at: currentVersion,
      } } })
    } else if (path.endsWith('/growth/submissions/A/validity')) {
      saves.push(route.request().postDataJSON())
      await route.fulfill(saves.length === 1
        ? { status: 409, json: { success: false, error: 'Prescription review changed. Reload before saving.' } }
        : { json: { success: true } })
    } else return false
    return true
  })
  await page.getByRole('button', { name: /合成患者A/ }).click()
  const issuedOn = page.getByLabel('交付日', { exact: true })
  await expect(issuedOn).toHaveValue('2026-09-04')
  await issuedOn.fill('2026-09-05')
  currentVersion = '2026-09-05T02:00:00.000Z'
  const refreshed = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/custom/pharmacy/prescriptions/A')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await refreshed
  await settleRender(page)
  const save = page.getByRole('button', { name: '使用期限を保存', exact: true })
  await save.click()
  await expect(page.getByRole('alert').filter({ hasText: '確認結果が変わりました' })).toBeVisible()
  expect(saves[0].expectedUpdatedAt).toBe(createdAt)
  await expect(issuedOn).toHaveValue('2026-09-05')
  await expect(save).toBeDisabled()
  page.on('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '入力を破棄して再読み込み', exact: true }).click()
  await expect(issuedOn).toHaveValue('2026-09-04')
  await expect(save).toBeEnabled()
  await save.click()
  await expect.poll(() => saves.length).toBe(2)
  expect(saves[1].expectedUpdatedAt).toBe(currentVersion)
  expect(unexpected).toEqual([])
})

test('the staff journey remains keyboard operable at narrow width and enlarged text', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const unexpected = await mockPharmacy(page)
  const filter = page.getByRole('button', { name: /^すべて / })
  await expect(filter).toHaveAttribute('aria-pressed', 'false')
  await filter.focus()
  await page.keyboard.press('Enter')
  await expect(filter).toHaveAttribute('aria-pressed', 'true')
  const patient = page.getByRole('button', { name: /合成患者A/ })
  await patient.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('link', { name: '個別チャットを開く' })).toHaveAttribute('href', '/chats?friend=synthetic-friend-A')
  const form = page.getByRole('region', { name: '薬剤師確認' })
  for (const control of await form.locator('button, input, select').all()) {
    expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const detailPanel = page.getByRole('region', { name: '処方せん詳細' })
  for (const control of await detailPanel.locator('button, input, select, a').all()) {
    const box = (await control.boundingBox())!
    expect(box.x + box.width, await control.getAttribute('type') ?? await control.textContent() ?? 'control').toBeLessThanOrEqual(390)
  }
  await form.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('staff-narrow-enlarged-text.png'), fullPage: true })
  expect(unexpected).toEqual([])
})

test('detail separates the LINE display name and linked intake from a newer response', async ({ page }) => {
  const unexpected = await mockPharmacy(page, async (route, path) => {
    if (path !== '/api/custom/pharmacy/prescriptions/A') return false
    await route.fulfill({ json: { ...detail('A'), intake: {
      revision: 1, submitted_at: '2026-09-01T01:00:00.000Z',
      latest_revision: 2, latest_submitted_at: '2026-09-04T01:00:00.000Z', reviewed_at: null,
    } } })
    return true
  })
  await page.getByRole('button', { name: /合成患者A/ }).click()
  const panel = page.getByRole('region', { name: '処方せん詳細' })
  await expect(panel.getByText('LINE表示名: 合成患者A', { exact: true })).toBeVisible()
  await expect(panel.getByText('氏名は画像・アンケートと照合してください。', { exact: true })).toBeVisible()
  await expect(panel.getByText('この処方せんに紐付く回答: 第1版', { exact: false })).toBeVisible()
  await expect(panel.getByText('最新回答: 第2版', { exact: false })).toBeVisible()
  await expect(panel.getByRole('status')).toContainText('より新しい回答があります')
  expect(unexpected).toEqual([])
})
