import { expect, test } from '@playwright/test'

test('editing notes during a pending save preserves the newer local input', async ({ page, baseURL }) => {
  let storedNotes = '保存済みメモ'
  let detailReads = 0
  let releaseSave!: () => void
  const saving = new Promise<void>(resolve => { releaseSave = resolve })
  let saveStarted!: () => void
  const started = new Promise<void>(resolve => { saveStarted = resolve })
  const writes: unknown[] = []
  const external: string[] = []
  const detail = () => ({id:'friend-a',friendId:'friend-a',friendName:'合成の友だち',friendPictureUrl:null,operatorId:null,status:'unread',notes:storedNotes,messages:[],createdAt:'2023-01-01T00:00:00Z',updatedAt:'2023-01-01T00:00:00Z',lastMessageAt:null})
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    if (url.pathname === '/api/auth/session') {
      await route.fulfill({json:{success:true,csrfToken:'synthetic-csrf',data:{id:'synthetic-staff',name:'合成スタッフ',role:'admin',tenantId:'synthetic-tenant',tenantCode:'synthetic',tenantName:'合成薬局',mustChangePassword:false}}})
    } else if (url.pathname === '/api/line-accounts') {
      await route.fulfill({json:{success:true,data:[{id:'account-a',name:'合成アカウント',channelId:'synthetic-channel',isActive:true,pharmacyMode:false}]}})
    } else if (url.pathname === '/api/chats/friend-a' && method === 'PUT') {
      const body = route.request().postDataJSON(); writes.push(body); saveStarted(); await saving
      storedNotes = body.notes
      await route.fulfill({json:{success:true,data:detail()}})
    } else if (url.pathname === '/api/chats/friend-a') {
      detailReads++
      await route.fulfill({json:{success:true,data:detail()}})
    } else if (url.pathname === '/api/chats') {
      await route.fulfill({json:{success:true,data:[detail()]}})
    } else if (url.pathname === '/api/friends/friend-a') {
      await route.fulfill({json:{success:true,data:{id:'friend-a',displayName:'合成の友だち',pictureUrl:null,isFollowing:true,metadata:{},refCode:null,createdAt:'2023-01-01T00:00:00Z',tags:[],formSubmissions:[]}}})
    } else if (url.pathname.includes('/mileage')) {
      await route.fulfill({json:{success:false,error:'合成テストでは利用できません'}})
    } else if (url.pathname.startsWith('/api/')) {
      await route.fulfill({json:{success:true,data:[]}})
    } else if (url.origin === new URL(baseURL!).origin) {
      await route.continue()
    } else {
      external.push(url.origin)
      await route.abort()
    }
  })
  await page.goto('/chats?friend=friend-a')
  const input = page.getByPlaceholder('メモを入力...')
  await expect(input).toHaveValue('保存済みメモ')
  await expect(input).toBeEnabled()
  await input.fill('今回保存するメモ')
  const initialReads = detailReads
  await page.getByRole('button',{name:'メモ保存',exact:true}).click()
  await started
  await input.fill('保存中に書き足したメモ')
  releaseSave()
  await expect.poll(() => detailReads).toBeGreaterThan(initialReads)
  await expect(page.getByRole('button',{name:'メモ保存',exact:true})).toBeEnabled()
  expect(writes).toEqual([{notes:'今回保存するメモ'}])
  expect(storedNotes).toBe('今回保存するメモ')
  expect(external).toEqual([])
  await expect(input).toHaveValue('保存中に書き足したメモ')
})
