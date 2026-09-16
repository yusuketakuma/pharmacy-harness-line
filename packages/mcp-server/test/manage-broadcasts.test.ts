import { beforeEach, describe, expect, it, vi } from 'vitest'

const getClient = vi.fn()
vi.mock('../src/client.js', () => ({ getClient }))

const { registerManageBroadcasts } = await import('../src/tools/manage-broadcasts.js')

function registeredHandler() {
  const server = { tool: vi.fn() }
  registerManageBroadcasts(server as never)
  return server.tool.mock.calls[0]?.[3] as (
    input: Record<string, unknown>,
  ) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>
}

describe('manage_broadcasts create_draft contract', () => {
  const create = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    create.mockResolvedValue({ id: 'broadcast-a', status: 'draft', scheduledAt: null })
    getClient.mockReturnValue({ broadcasts: { create, update: vi.fn() } })
  })

  it.each(['2026-09-17T00:00:00.000Z', ''])('rejects scheduledAt=%j before the API mutation', async (scheduledAt) => {
    const response = await registeredHandler()({
      action: 'create_draft',
      title: '合成下書き',
      messageType: 'text',
      messageContent: '合成本文',
      scheduledAt,
    })

    expect(response.isError).toBe(true)
    expect(JSON.parse(response.content[0].text).success).toBe(false)
    expect(create).not.toHaveBeenCalled()
  })

  it.each([undefined, null])('keeps scheduledAt=%j as an unscheduled draft', async (scheduledAt) => {
    await registeredHandler()({
      action: 'create_draft',
      title: '合成下書き',
      messageType: 'text',
      messageContent: '合成本文',
      scheduledAt,
    })

    expect(create).toHaveBeenCalledWith({
      title: '合成下書き',
      messageType: 'text',
      messageContent: '合成本文',
      targetType: 'all',
    })
  })

  it('keeps explicit update scheduling unchanged', async () => {
    const update = vi.fn().mockResolvedValue({ id: 'broadcast-a', status: 'scheduled' })
    getClient.mockReturnValue({ broadcasts: { create, update } })

    await registeredHandler()({ action: 'update', broadcastId: 'broadcast-a', scheduledAt: '2026-09-17T00:00:00.000Z' })

    expect(update).toHaveBeenCalledWith('broadcast-a', { scheduledAt: '2026-09-17T00:00:00.000Z' })
  })
})
