import { describe, expect, it, vi } from 'vitest'
import { RichMenuGroupsResource } from '../../src/resources/rich-menu-groups.js'
import type { HttpClient } from '../../src/http.js'

function mockHttp(overrides: Partial<HttpClient> = {}): HttpClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    postBinary: vi.fn(),
    ...overrides,
  } as unknown as HttpClient
}

describe('RichMenuGroupsResource', () => {
  it('lists and prepares pharmacy menus in the configured account', async () => {
    const group = {
      id: 'group-1',
      accountId: 'account-a',
      name: '薬局初期メニュー',
      chatBarText: 'メニュー',
      size: 'compact' as const,
      defaultPageId: 'page-1',
      isDefaultForAll: false,
      selected: true,
      status: 'draft' as const,
      publishingAt: null,
      pages: [],
    }
    const http = mockHttp({
      get: vi.fn().mockResolvedValue({ success: true, data: [group] }),
      post: vi.fn().mockResolvedValue({
        success: true,
        data: { group, reused: false, status: 'prepared' },
      }),
    })
    const resource = new RichMenuGroupsResource(http, 'account-a')

    await expect(resource.list()).resolves.toEqual([group])
    await expect(resource.preparePharmacy({ initial: true })).resolves.toMatchObject({
      reused: false,
    })

    expect(http.get).toHaveBeenCalledWith('/api/rich-menu-groups?accountId=account-a')
    expect(http.post).toHaveBeenCalledWith(
      '/api/custom/pharmacy/rich-menus/prepare?accountId=account-a',
      { initial: true },
    )
  })

  it('requires explicit confirmation for live operations and exposes dry-run payloads', async () => {
    const http = mockHttp({
      post: vi.fn().mockResolvedValue({
        success: true,
        data: { dryRun: true, confirmationToken: 'confirm-1', affected: 0 },
      }),
    })
    const resource = new RichMenuGroupsResource(http, 'account-a')

    await expect(resource.applyToTag('group-1', {
      mode: 'set-default',
      dryRun: true,
    })).resolves.toMatchObject({ dryRun: true })

    expect(http.post).toHaveBeenCalledWith(
      '/api/rich-menu-groups/group-1/apply-to-tag?accountId=account-a',
      { mode: 'set-default', dryRun: true },
    )
  })
})
