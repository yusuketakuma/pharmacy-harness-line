import { expect, test, type Page } from '@playwright/test'

async function setup(page: Page, baseURL: string) {
  const stored: Record<string, string> = { 'friend-a': '保存済みメモ', 'friend-b': '別の相手のメモ' }
  const statuses: Record<string, string> = { 'friend-a': 'unread', 'friend-b': 'unread' }
  const writes: { id: string; body: Record<string, string> }[] = []
  const external: string[] = []
  let pending: Promise<void> | undefined
  let failNext = false
  const detail = (id: string) => ({
    id, friendId: id, friendName: id === 'friend-a' ? '合成の友だちA' : '合成の友だちB',
    friendPictureUrl: null, operatorId: null, status: statuses[id], notes: stored[id], messages: [],
    createdAt: '2023-01-01T00:00:00Z', updatedAt: '2023-01-01T00:00:00Z', lastMessageAt: null,
  })
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    const id = url.pathname.split('/').at(-1)!
    if (url.pathname === '/api/auth/session') {
      await route.fulfill({ json: { success: true, csrfToken: 'synthetic-csrf', data: {
        id: 'synthetic-staff', name: '合成スタッフ', role: 'admin', tenantId: 'synthetic-tenant',
        tenantCode: 'synthetic', tenantName: '合成薬局', mustChangePassword: false,
      } } })
    } else if (url.pathname === '/api/line-accounts') {
      await route.fulfill({ json: { success: true, data: [{ id: 'account-a', name: '合成アカウント', channelId: 'synthetic-channel', isActive: true, pharmacyMode: false }] } })
    } else if (url.pathname.startsWith('/api/chats/') && id in stored) {
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON()
        writes.push({ id, body })
        await pending
        if (failNext) {
          failNext = false
          await route.fulfill({ status: 500, json: { success: false, error: '合成の保存失敗' } })
          return
        }
        if ('notes' in body) stored[id] = body.notes
        if ('status' in body) statuses[id] = body.status
      }
      await route.fulfill({ json: { success: true, data: detail(id) } })
    } else if (url.pathname === '/api/chats') {
      await route.fulfill({ json: { success: true, data: Object.keys(stored).map(detail) } })
    } else if (url.pathname.startsWith('/api/friends/') && id in stored) {
      await route.fulfill({ json: { success: true, data: { id, displayName: detail(id).friendName, pictureUrl: null, isFollowing: true, metadata: {}, refCode: null, createdAt: '2023-01-01T00:00:00Z', tags: [], formSubmissions: [] } } })
    } else if (url.pathname.includes('/mileage')) {
      await route.fulfill({ json: { success: false, error: '合成テストでは利用できません' } })
    } else if (url.pathname.startsWith('/api/')) {
      await route.fulfill({ json: { success: true, data: [] } })
    } else if (url.origin === new URL(baseURL).origin) {
      await route.continue()
    } else {
      external.push(url.origin)
      await route.abort()
    }
  })
  await page.goto('/chats?friend=friend-a')
  const input = page.getByPlaceholder('メモを入力...')
  const save = page.getByRole('button', { name: 'メモ保存', exact: true })
  await expect(input).toHaveValue(stored['friend-a'])
  await expect(input).toBeEnabled()
  return {
    input, save, stored, writes, external,
    holdSave() {
      let release!: () => void
      pending = new Promise<void>(resolve => { release = resolve })
      return () => { release(); pending = undefined }
    },
    failSave() { failNext = true },
    async refreshStatus() {
      await page.getByRole('button', { name: '対応中にする', exact: true }).click()
      await expect(page.getByRole('button', { name: '対応中にする', exact: true })).toHaveCount(0)
      await expect(input).toBeVisible()
    },
    async select(id: 'friend-a' | 'friend-b') {
      await page.locator('p').filter({ hasText: detail(id).friendName }).click()
      await expect(input).toHaveValue(stored[id])
    },
  }
}

test('saving a draft preserves edits made while the save is pending and allows saving them', async ({ page, baseURL }) => {
  const f = await setup(page, baseURL!)
  const release = f.holdSave()
  await f.input.fill('今回保存するメモ')
  await f.save.click()
  await expect.poll(() => f.writes.length).toBe(1)
  await f.input.fill('保存中に書き足したメモ')
  release()
  await expect(f.save).toBeEnabled()
  await f.refreshStatus()
  await expect(f.input).toHaveValue('保存中に書き足したメモ')
  expect(f.stored['friend-a']).toBe('今回保存するメモ')
  await f.save.click()
  await expect(f.save).toBeEnabled()
  expect(f.stored['friend-a']).toBe('保存中に書き足したメモ')
  expect(f.writes.filter(w => 'notes' in w.body)).toEqual([
    { id: 'friend-a', body: { notes: '今回保存するメモ' } },
    { id: 'friend-a', body: { notes: '保存中に書き足したメモ' } },
  ])
  expect(f.external).toEqual([])
})

test('status refresh preserves an unsaved draft', async ({ page, baseURL }) => {
  const f = await setup(page, baseURL!)
  await f.input.fill('未保存のメモ')
  await f.refreshStatus()
  await expect(f.input).toHaveValue('未保存のメモ')
  expect(f.stored['friend-a']).toBe('保存済みメモ')
})

test('successful unchanged save accepts subsequent server notes, including clearing notes', async ({ page, baseURL }) => {
  const f = await setup(page, baseURL!)
  await f.input.fill('')
  await f.save.click()
  await expect(f.save).toBeEnabled()
  await expect(f.input).toHaveValue('')
  expect(f.stored['friend-a']).toBe('')
  f.stored['friend-a'] = 'サーバーで更新されたメモ'
  await f.refreshStatus()
  await expect(f.input).toHaveValue('サーバーで更新されたメモ')
})

test('failed save retains its draft through refresh and can be retried', async ({ page, baseURL }) => {
  const f = await setup(page, baseURL!)
  await f.input.fill('再試行するメモ')
  f.failSave()
  await f.save.click()
  await expect(page.getByText('メモの保存に失敗しました。', { exact: true })).toBeVisible()
  await f.refreshStatus()
  await expect(f.input).toHaveValue('再試行するメモ')
  expect(f.stored['friend-a']).toBe('保存済みメモ')
  await f.save.click()
  await expect(f.save).toBeEnabled()
  expect(f.stored['friend-a']).toBe('再試行するメモ')
})

for (const returnToOriginal of [false, true]) {
  test(`late save preserves the current draft after switching chats (return=${returnToOriginal})`, async ({ page, baseURL }) => {
    const f = await setup(page, baseURL!)
    const release = f.holdSave()
    await f.input.fill('Aへ送ったメモ')
    await f.save.click()
    await expect.poll(() => f.writes.length).toBe(1)
    await f.select('friend-b')
    if (returnToOriginal) await f.select('friend-a')
    await f.input.fill('現在選択した相手の未保存メモ')
    release()
    await expect(f.save).toBeEnabled()
    await f.refreshStatus()
    await expect(f.input).toHaveValue('現在選択した相手の未保存メモ')
    expect(f.stored['friend-a']).toBe('Aへ送ったメモ')
    expect(f.stored['friend-b']).toBe('別の相手のメモ')
    expect(f.external).toEqual([])
  })
}
