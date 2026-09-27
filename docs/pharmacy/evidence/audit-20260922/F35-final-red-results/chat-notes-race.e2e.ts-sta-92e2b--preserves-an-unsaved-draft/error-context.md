# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: chat-notes-race.e2e.ts >> status refresh preserves an unsaved draft
- Location: e2e/chat-notes-race.e2e.ts:101:5

# Error details

```
Error: expect(locator).toHaveValue(expected) failed

Locator:  getByPlaceholder('メモを入力...')
Expected: "未保存のメモ"
Received: "保存済みメモ"
Timeout:  5000ms

Call log:
  - Expect "toHaveValue" with timeout 5000ms
  - waiting for getByPlaceholder('メモを入力...')
    14 × locator resolved to <input type="text" value="保存済みメモ" placeholder="メモを入力..." class="flex-1 text-xs border border-gray-300 rounded-md px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-green-500 disabled:bg-gray-100"/>
       - unexpected value "保存済みメモ"

```

```yaml
- textbox "メモを入力...": 保存済みメモ
```

# Test source

```ts
  5   |   const statuses: Record<string, string> = { 'friend-a': 'unread', 'friend-b': 'unread' }
  6   |   const writes: { id: string; body: Record<string, string> }[] = []
  7   |   const external: string[] = []
  8   |   let pending: Promise<void> | undefined
  9   |   let failNext = false
  10  |   const detail = (id: string) => ({
  11  |     id, friendId: id, friendName: id === 'friend-a' ? '合成の友だちA' : '合成の友だちB',
  12  |     friendPictureUrl: null, operatorId: null, status: statuses[id], notes: stored[id], messages: [],
  13  |     createdAt: '2023-01-01T00:00:00Z', updatedAt: '2023-01-01T00:00:00Z', lastMessageAt: null,
  14  |   })
  15  |   await page.route('**/*', async route => {
  16  |     const url = new URL(route.request().url())
  17  |     const id = url.pathname.split('/').at(-1)!
  18  |     if (url.pathname === '/api/auth/session') {
  19  |       await route.fulfill({ json: { success: true, csrfToken: 'synthetic-csrf', data: {
  20  |         id: 'synthetic-staff', name: '合成スタッフ', role: 'admin', tenantId: 'synthetic-tenant',
  21  |         tenantCode: 'synthetic', tenantName: '合成薬局', mustChangePassword: false,
  22  |       } } })
  23  |     } else if (url.pathname === '/api/line-accounts') {
  24  |       await route.fulfill({ json: { success: true, data: [{ id: 'account-a', name: '合成アカウント', channelId: 'synthetic-channel', isActive: true, pharmacyMode: false }] } })
  25  |     } else if (url.pathname.startsWith('/api/chats/') && id in stored) {
  26  |       if (route.request().method() === 'PUT') {
  27  |         const body = route.request().postDataJSON()
  28  |         writes.push({ id, body })
  29  |         await pending
  30  |         if (failNext) {
  31  |           failNext = false
  32  |           await route.fulfill({ status: 500, json: { success: false, error: '合成の保存失敗' } })
  33  |           return
  34  |         }
  35  |         if ('notes' in body) stored[id] = body.notes
  36  |         if ('status' in body) statuses[id] = body.status
  37  |       }
  38  |       await route.fulfill({ json: { success: true, data: detail(id) } })
  39  |     } else if (url.pathname === '/api/chats') {
  40  |       await route.fulfill({ json: { success: true, data: Object.keys(stored).map(detail) } })
  41  |     } else if (url.pathname.startsWith('/api/friends/') && id in stored) {
  42  |       await route.fulfill({ json: { success: true, data: { id, displayName: detail(id).friendName, pictureUrl: null, isFollowing: true, metadata: {}, refCode: null, createdAt: '2023-01-01T00:00:00Z', tags: [], formSubmissions: [] } } })
  43  |     } else if (url.pathname.includes('/mileage')) {
  44  |       await route.fulfill({ json: { success: false, error: '合成テストでは利用できません' } })
  45  |     } else if (url.pathname.startsWith('/api/')) {
  46  |       await route.fulfill({ json: { success: true, data: [] } })
  47  |     } else if (url.origin === new URL(baseURL).origin) {
  48  |       await route.continue()
  49  |     } else {
  50  |       external.push(url.origin)
  51  |       await route.abort()
  52  |     }
  53  |   })
  54  |   await page.goto('/chats?friend=friend-a')
  55  |   const input = page.getByPlaceholder('メモを入力...')
  56  |   const save = page.getByRole('button', { name: 'メモ保存', exact: true })
  57  |   await expect(input).toHaveValue(stored['friend-a'])
  58  |   await expect(input).toBeEnabled()
  59  |   return {
  60  |     input, save, stored, writes, external,
  61  |     holdSave() {
  62  |       let release!: () => void
  63  |       pending = new Promise<void>(resolve => { release = resolve })
  64  |       return () => { release(); pending = undefined }
  65  |     },
  66  |     failSave() { failNext = true },
  67  |     async refreshStatus() {
  68  |       await page.getByRole('button', { name: '対応中にする', exact: true }).click()
  69  |       await expect(page.getByRole('button', { name: '対応中にする', exact: true })).toHaveCount(0)
  70  |       await expect(input).toBeVisible()
  71  |     },
  72  |     async select(id: 'friend-a' | 'friend-b') {
  73  |       await page.locator('p').filter({ hasText: detail(id).friendName }).click()
  74  |       await expect(input).toHaveValue(stored[id])
  75  |     },
  76  |   }
  77  | }
  78  | 
  79  | test('saving a draft preserves edits made while the save is pending and allows saving them', async ({ page, baseURL }) => {
  80  |   const f = await setup(page, baseURL!)
  81  |   const release = f.holdSave()
  82  |   await f.input.fill('今回保存するメモ')
  83  |   await f.save.click()
  84  |   await expect.poll(() => f.writes.length).toBe(1)
  85  |   await f.input.fill('保存中に書き足したメモ')
  86  |   release()
  87  |   await expect(f.save).toBeEnabled()
  88  |   await f.refreshStatus()
  89  |   await expect(f.input).toHaveValue('保存中に書き足したメモ')
  90  |   expect(f.stored['friend-a']).toBe('今回保存するメモ')
  91  |   await f.save.click()
  92  |   await expect(f.save).toBeEnabled()
  93  |   expect(f.stored['friend-a']).toBe('保存中に書き足したメモ')
  94  |   expect(f.writes.filter(w => 'notes' in w.body)).toEqual([
  95  |     { id: 'friend-a', body: { notes: '今回保存するメモ' } },
  96  |     { id: 'friend-a', body: { notes: '保存中に書き足したメモ' } },
  97  |   ])
  98  |   expect(f.external).toEqual([])
  99  | })
  100 | 
  101 | test('status refresh preserves an unsaved draft', async ({ page, baseURL }) => {
  102 |   const f = await setup(page, baseURL!)
  103 |   await f.input.fill('未保存のメモ')
  104 |   await f.refreshStatus()
> 105 |   await expect(f.input).toHaveValue('未保存のメモ')
      |                         ^ Error: expect(locator).toHaveValue(expected) failed
  106 |   expect(f.stored['friend-a']).toBe('保存済みメモ')
  107 | })
  108 | 
  109 | test('successful unchanged save accepts subsequent server notes, including clearing notes', async ({ page, baseURL }) => {
  110 |   const f = await setup(page, baseURL!)
  111 |   await f.input.fill('')
  112 |   await f.save.click()
  113 |   await expect(f.save).toBeEnabled()
  114 |   await expect(f.input).toHaveValue('')
  115 |   expect(f.stored['friend-a']).toBe('')
  116 |   f.stored['friend-a'] = 'サーバーで更新されたメモ'
  117 |   await f.refreshStatus()
  118 |   await expect(f.input).toHaveValue('サーバーで更新されたメモ')
  119 | })
  120 | 
  121 | test('failed save retains its draft through refresh and can be retried', async ({ page, baseURL }) => {
  122 |   const f = await setup(page, baseURL!)
  123 |   await f.input.fill('再試行するメモ')
  124 |   f.failSave()
  125 |   await f.save.click()
  126 |   await expect(page.getByText('メモの保存に失敗しました。', { exact: true })).toBeVisible()
  127 |   await f.refreshStatus()
  128 |   await expect(f.input).toHaveValue('再試行するメモ')
  129 |   expect(f.stored['friend-a']).toBe('保存済みメモ')
  130 |   await f.save.click()
  131 |   await expect(f.save).toBeEnabled()
  132 |   expect(f.stored['friend-a']).toBe('再試行するメモ')
  133 | })
  134 | 
  135 | for (const returnToOriginal of [false, true]) {
  136 |   test(`late save preserves the current draft after switching chats (return=${returnToOriginal})`, async ({ page, baseURL }) => {
  137 |     const f = await setup(page, baseURL!)
  138 |     const release = f.holdSave()
  139 |     await f.input.fill('Aへ送ったメモ')
  140 |     await f.save.click()
  141 |     await expect.poll(() => f.writes.length).toBe(1)
  142 |     await f.select('friend-b')
  143 |     if (returnToOriginal) await f.select('friend-a')
  144 |     await f.input.fill('現在選択した相手の未保存メモ')
  145 |     release()
  146 |     await expect(f.save).toBeEnabled()
  147 |     await f.refreshStatus()
  148 |     await expect(f.input).toHaveValue('現在選択した相手の未保存メモ')
  149 |     expect(f.stored['friend-a']).toBe('Aへ送ったメモ')
  150 |     expect(f.stored['friend-b']).toBe('別の相手のメモ')
  151 |     expect(f.external).toEqual([])
  152 |   })
  153 | }
  154 | 
```