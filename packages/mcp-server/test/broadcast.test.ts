import { beforeEach, describe, expect, it, vi } from 'vitest';

const getClient = vi.fn();
vi.mock('../src/client.js', () => ({ getClient }));
const { registerBroadcast } = await import('../src/tools/broadcast.js');

function handler() {
  const server = { tool: vi.fn() };
  registerBroadcast(server as never);
  expect(server.tool.mock.calls[0][0]).toBe('broadcast');
  return server.tool.mock.calls[0][3] as (input: Record<string, unknown>) => Promise<{
    isError?: boolean; content: Array<{ text: string }>;
  }>;
}

describe('broadcast send outcome preservation', () => {
  const records = new Map<string, { id: string; status: string }>();
  const api = { create: vi.fn(), send: vi.fn(), sendToSegment: vi.fn(), delete: vi.fn() };
  const input = {
    title: 'synthetic', messageType: 'text', messageContent: 'synthetic',
    targetType: 'segment', segmentConditions: JSON.stringify({ operator: 'AND', rules: [] }),
    accountId: 'account-a', trackLinks: false,
  };

  beforeEach(() => {
    records.clear();
    for (const mock of Object.values(api)) mock.mockReset();
    getClient.mockReturnValue({ broadcasts: api });
    api.create.mockImplementation(async () => {
      const record = { id: 'broadcast-a', status: 'draft' };
      records.set(record.id, record);
      return record;
    });
    api.delete.mockImplementation(async (id: string) => records.delete(id));
  });

  it.each(['segment', 'all', 'tag'])('preserves an accepted %s send when its response is lost', async (targetType) => {
    const send = targetType === 'segment' ? api.sendToSegment : api.send;
    send.mockImplementation(async (id: string) => {
      records.set(id, { id, status: 'sending' });
      throw new Error('synthetic response lost');
    });
    const result = await handler()({ ...input, targetType, targetTagId: 'tag-a' });
    expect(result.isError).toBe(true);
    expect(records.get('broadcast-a')).toEqual({ id: 'broadcast-a', status: 'sending' });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      success: false, error: 'Error: synthetic response lost',
      broadcastId: 'broadcast-a', outcome: 'unknown',
    });
    expect(api.delete).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it('keeps the successful segment response and transport arguments', async () => {
    const queued = { id: 'broadcast-a', status: 'sending' };
    api.sendToSegment.mockResolvedValue(queued);
    const result = await handler()(input);
    expect(result.content[0].text).toBe(JSON.stringify({ success: true, broadcast: queued }, null, 2));
    expect(result.isError).toBeUndefined();
    expect(api.sendToSegment).toHaveBeenCalledWith('broadcast-a', { operator: 'AND', rules: [] });
    expect(api.create).toHaveBeenCalledWith({
      title: '[SEGMENT] synthetic', messageType: 'text', messageContent: 'synthetic',
      targetType: 'all', lineAccountId: 'account-a', altText: undefined, trackLinks: false,
    });
  });

  it('does not immediately send a scheduled broadcast', async () => {
    const result = await handler()({ ...input, targetType: 'all', scheduledAt: '2099-01-01T00:00:00Z' });
    expect(JSON.parse(result.content[0].text).success).toBe(true);
    expect(api.send).not.toHaveBeenCalled();
    expect(api.sendToSegment).not.toHaveBeenCalled();
  });

  it('keeps create failures distinct from unknown send outcomes', async () => {
    api.create.mockRejectedValue(new Error('synthetic creation failure'));
    const result = await handler()(input);
    expect(JSON.parse(result.content[0].text)).toEqual({ success: false, error: 'Error: synthetic creation failure' });
    expect(api.sendToSegment).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it.each([undefined, '{invalid'])('rejects invalid segment conditions before creating a broadcast: %s', async (segmentConditions) => {
    expect((await handler()({ ...input, segmentConditions })).isError).toBe(true);
    expect(api.create).not.toHaveBeenCalled();
  });
});
