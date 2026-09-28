# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: chat-notes-race.e2e.ts >> editing notes during a pending save preserves the newer local input
- Location: e2e/chat-notes-race.e2e.ts:3:5

# Error details

```
Error: expect(locator).toHaveValue(expected) failed

Locator:  getByPlaceholder('メモを入力...')
Expected: "保存中に書き足したメモ"
Received: "今回保存するメモ"
Timeout:  5000ms

Call log:
  - Expect "toHaveValue" with timeout 5000ms
  - waiting for getByPlaceholder('メモを入力...')
    14 × locator resolved to <input type="text" value="今回保存するメモ" placeholder="メモを入力..." class="flex-1 text-xs border border-gray-300 rounded-md px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-green-500 disabled:bg-gray-100"/>
       - unexpected value "今回保存するメモ"

```

```yaml
- textbox "メモを入力...": 今回保存するメモ
```

# Test source

```ts
  1  | import { expect, test } from '@playwright/test'
  2  | 
  3  | test('editing notes during a pending save preserves the newer local input', async ({ page, baseURL }) => {
  4  |   let storedNotes = '保存済みメモ'
  5  |   let detailReads = 0
  6  |   let releaseSave!: () => void
  7  |   const saving = new Promise<void>(resolve => { releaseSave = resolve })
  8  |   let saveStarted!: () => void
  9  |   const started = new Promise<void>(resolve => { saveStarted = resolve })
  10 |   const writes: unknown[] = []
  11 |   const external: string[] = []
  12 |   const detail = () => ({id:'friend-a',friendId:'friend-a',friendName:'合成の友だち',friendPictureUrl:null,operatorId:null,status:'unread',notes:storedNotes,messages:[],createdAt:'2023-01-01T00:00:00Z',updatedAt:'2023-01-01T00:00:00Z',lastMessageAt:null})
  13 |   await page.route('**/*', async route => {
  14 |     const url = new URL(route.request().url())
  15 |     const method = route.request().method()
  16 |     if (url.pathname === '/api/auth/session') {
  17 |       await route.fulfill({json:{success:true,csrfToken:'synthetic-csrf',data:{id:'synthetic-staff',name:'合成スタッフ',role:'admin',tenantId:'synthetic-tenant',tenantCode:'synthetic',tenantName:'合成薬局',mustChangePassword:false}}})
  18 |     } else if (url.pathname === '/api/line-accounts') {
  19 |       await route.fulfill({json:{success:true,data:[{id:'account-a',name:'合成アカウント',channelId:'synthetic-channel',isActive:true,pharmacyMode:false}]}})
  20 |     } else if (url.pathname === '/api/chats/friend-a' && method === 'PUT') {
  21 |       const body = route.request().postDataJSON(); writes.push(body); saveStarted(); await saving
  22 |       storedNotes = body.notes
  23 |       await route.fulfill({json:{success:true,data:detail()}})
  24 |     } else if (url.pathname === '/api/chats/friend-a') {
  25 |       detailReads++
  26 |       await route.fulfill({json:{success:true,data:detail()}})
  27 |     } else if (url.pathname === '/api/chats') {
  28 |       await route.fulfill({json:{success:true,data:[detail()]}})
  29 |     } else if (url.pathname === '/api/friends/friend-a') {
  30 |       await route.fulfill({json:{success:true,data:{id:'friend-a',displayName:'合成の友だち',pictureUrl:null,isFollowing:true,metadata:{},refCode:null,createdAt:'2023-01-01T00:00:00Z',tags:[],formSubmissions:[]}}})
  31 |     } else if (url.pathname.includes('/mileage')) {
  32 |       await route.fulfill({json:{success:false,error:'合成テストでは利用できません'}})
  33 |     } else if (url.pathname.startsWith('/api/')) {
  34 |       await route.fulfill({json:{success:true,data:[]}})
  35 |     } else if (url.origin === new URL(baseURL!).origin) {
  36 |       await route.continue()
  37 |     } else {
  38 |       external.push(url.origin)
  39 |       await route.abort()
  40 |     }
  41 |   })
  42 |   await page.goto('/chats?friend=friend-a')
  43 |   const input = page.getByPlaceholder('メモを入力...')
  44 |   await expect(input).toHaveValue('保存済みメモ')
  45 |   await expect(input).toBeEnabled()
  46 |   await input.fill('今回保存するメモ')
  47 |   const initialReads = detailReads
  48 |   await page.getByRole('button',{name:'メモ保存',exact:true}).click()
  49 |   await started
  50 |   await input.fill('保存中に書き足したメモ')
  51 |   releaseSave()
  52 |   await expect.poll(() => detailReads).toBeGreaterThan(initialReads)
  53 |   await expect(page.getByRole('button',{name:'メモ保存',exact:true})).toBeEnabled()
  54 |   expect(writes).toEqual([{notes:'今回保存するメモ'}])
  55 |   expect(storedNotes).toBe('今回保存するメモ')
  56 |   expect(external).toEqual([])
> 57 |   await expect(input).toHaveValue('保存中に書き足したメモ')
     |                       ^ Error: expect(locator).toHaveValue(expected) failed
  58 | })
  59 | 
```