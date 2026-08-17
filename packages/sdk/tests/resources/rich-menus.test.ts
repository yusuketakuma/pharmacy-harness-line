import { describe, expect, it, vi } from 'vitest'
import { RichMenusResource } from '../../src/resources/rich-menus.js'
import type { HttpClient } from '../../src/http.js'

function mockHttp(overrides: Partial<HttpClient> = {}): HttpClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  } as unknown as HttpClient
}

describe('RichMenusResource account scope', () => {
  it('propagates the configured account to every LINE rich-menu request', async () => {
    const http = mockHttp({
      get: vi.fn().mockResolvedValue({ success: true, data: [] }),
      post: vi.fn().mockResolvedValue({ success: true, data: { richMenuId: 'rm-1' } }),
      delete: vi.fn().mockResolvedValue({ success: true, data: null }),
    })
    const resource = new RichMenusResource(http, 'account-a')

    await resource.list()
    await resource.create({
      size: { width: 2500, height: 843 },
      selected: false,
      name: '薬局メニュー',
      chatBarText: 'メニュー',
      areas: [],
    })
    await resource.setDefault('rm-1')
    await resource.uploadImage('rm-1', 'aGVsbG8=', 'image/jpeg')
    await resource.delete('rm-1')

    expect(http.get).toHaveBeenCalledWith('/api/rich-menus?accountId=account-a')
    expect(http.post).toHaveBeenNthCalledWith(
      1,
      '/api/rich-menus?accountId=account-a',
      expect.objectContaining({ name: '薬局メニュー' }),
    )
    expect(http.post).toHaveBeenNthCalledWith(
      2,
      '/api/rich-menus/rm-1/default?accountId=account-a',
    )
    expect(http.post).toHaveBeenNthCalledWith(
      3,
      '/api/rich-menus/rm-1/image?accountId=account-a',
      { imageData: 'aGVsbG8=', contentType: 'image/jpeg' },
    )
    expect(http.delete).toHaveBeenCalledWith('/api/rich-menus/rm-1?accountId=account-a')
  })

  it('requires an account scope instead of silently using the Worker default', async () => {
    const http = mockHttp({ get: vi.fn().mockResolvedValue({ success: true, data: [] }) })
    const resource = new RichMenusResource(http)

    await expect(resource.list()).rejects.toThrow('lineAccountId is required')
    expect(http.get).not.toHaveBeenCalled()
  })
})
