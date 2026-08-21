import { beforeEach, describe, expect, it, vi } from 'vitest'

const getClient = vi.fn()
vi.mock('../src/client.js', () => ({ getClient }))

const { registerPharmacyRichMenuTools } = await import(
  '../src/custom/pharmacy/rich-menu/tools.js',
)

function registeredHandler() {
  const server = { tool: vi.fn() }
  registerPharmacyRichMenuTools(server as never)
  return server.tool.mock.calls[0]?.[3] as (
    input: Record<string, unknown>,
  ) => Promise<{ content: Array<{ text: string }> }>
}

describe('pharmacy rich-menu MCP tools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('LINE_HARNESS_ACCOUNT_ID', 'account-a')
  })

  it('does not expose raw full-image saving', () => {
    const server = { tool: vi.fn() }
    registerPharmacyRichMenuTools(server as never)
    const schema = server.tool.mock.calls[0]?.[2] as {
      action: { safeParse: (value: unknown) => { success: boolean } }
    }

    expect(schema.action.safeParse('save_image').success).toBe(false)
  })

  it('previews a page-to-page tab switch without changing the group', async () => {
    const update = vi.fn()
    getClient.mockReturnValue({
      richMenuGroups: {
        get: vi.fn().mockResolvedValue({
          id: 'group-a',
          pages: [
            {
              id: 'page-a',
              name: '受付',
              orderIndex: 0,
              areas: [{
                id: 'area-a',
                boundsX: 0,
                boundsY: 0,
                boundsWidth: 100,
                boundsHeight: 100,
                actionType: 'message',
                actionData: { text: '切替' },
              }],
            },
            { id: 'page-b', name: '相談', orderIndex: 1, areas: [] },
          ],
        }),
        update,
      },
    })
    const handler = registeredHandler()

    const response = await handler({
      action: 'set_switch',
      accountId: 'account-a',
      groupId: 'group-a',
      sourcePageId: 'page-a',
      areaId: 'area-a',
      targetPageId: 'page-b',
      dryRun: true,
      confirm: false,
      force: false,
    })

    expect(JSON.parse(response.content[0].text)).toMatchObject({
      success: true,
      dryRun: true,
      operation: 'set_switch',
      sourcePageId: 'page-a',
      targetPageId: 'page-b',
    })
    expect(update).not.toHaveBeenCalled()

    update.mockResolvedValue({ id: 'group-a', pages: [] })
    await handler({
      action: 'set_switch',
      accountId: 'account-a',
      groupId: 'group-a',
      sourcePageId: 'page-a',
      areaId: 'area-a',
      targetPageId: 'page-b',
      dryRun: false,
      confirm: true,
      force: false,
    })
    expect(update).toHaveBeenCalledWith(
      'group-a',
      expect.objectContaining({
        pages: expect.arrayContaining([
          expect.objectContaining({
            id: 'page-a',
            areas: [expect.objectContaining({
              actionType: 'richmenuswitch',
              actionData: { targetPageId: 'page-b' },
            })],
          }),
        ]),
      }),
      'account-a',
    )
  })
})
