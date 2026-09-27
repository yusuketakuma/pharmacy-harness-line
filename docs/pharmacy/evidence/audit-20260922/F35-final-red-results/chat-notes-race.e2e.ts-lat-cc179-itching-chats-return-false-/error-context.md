# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: chat-notes-race.e2e.ts >> late save preserves the current draft after switching chats (return=false)
- Location: e2e/chat-notes-race.e2e.ts:136:7

# Error details

```
Error: expect(locator).toHaveValue(expected) failed

Locator:  getByPlaceholder('メモを入力...')
Expected: "現在選択した相手の未保存メモ"
Received: "別の相手のメモ"
Timeout:  5000ms

Call log:
  - Expect "toHaveValue" with timeout 5000ms
  - waiting for getByPlaceholder('メモを入力...')
    14 × locator resolved to <input type="text" value="別の相手のメモ" placeholder="メモを入力..." class="flex-1 text-xs border border-gray-300 rounded-md px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-green-500 disabled:bg-gray-100"/>
       - unexpected value "別の相手のメモ"

```

```yaml
- textbox "メモを入力...": 別の相手のメモ
```

# Test source

```ts
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
  105 |   await expect(f.input).toHaveValue('未保存のメモ')
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
> 148 |     await expect(f.input).toHaveValue('現在選択した相手の未保存メモ')
      |                           ^ Error: expect(locator).toHaveValue(expected) failed
  149 |     expect(f.stored['friend-a']).toBe('Aへ送ったメモ')
  150 |     expect(f.stored['friend-b']).toBe('別の相手のメモ')
  151 |     expect(f.external).toEqual([])
  152 |   })
  153 | }
  154 | 
```