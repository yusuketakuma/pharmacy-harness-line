import { describe, it, expect, vi } from 'vitest';
import { Workflows } from '../src/workflows.js';
import type { FriendsResource } from '../src/resources/friends.js';
import type { ScenariosResource } from '../src/resources/scenarios.js';
import type { BroadcastsResource } from '../src/resources/broadcasts.js';

function mockFriends(): FriendsResource {
  return {
    list: vi.fn(),
    get: vi.fn(),
    count: vi.fn(),
    addTag: vi.fn(),
    removeTag: vi.fn(),
    sendMessage: vi.fn(),
  } as unknown as FriendsResource;
}

function mockScenarios(): ScenariosResource {
  return {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    addStep: vi.fn(),
    updateStep: vi.fn(),
    deleteStep: vi.fn(),
    enroll: vi.fn(),
  } as unknown as ScenariosResource;
}

function mockBroadcasts(): BroadcastsResource {
  return {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    send: vi.fn(),
  } as unknown as BroadcastsResource;
}

describe('Workflows', () => {
  it('createStepScenario creates scenario then adds steps with parsed delays', async () => {
    const friends = mockFriends();
    const scenarios = mockScenarios();
    const broadcasts = mockBroadcasts();
    const workflows = new Workflows(friends, scenarios, broadcasts);

    const createdScenario = { id: 'sc-1', name: 'Test', triggerType: 'friend_add', isActive: true };
    (scenarios.create as any).mockResolvedValue(createdScenario);
    (scenarios.addStep as any).mockResolvedValue({});
    (scenarios.get as any).mockResolvedValue({ ...createdScenario, steps: [] });

    await workflows.createStepScenario('Test', 'friend_add', [
      { delay: '0m', type: 'text', content: 'Hello' },
      { delay: '1d', type: 'text', content: 'Day 2' },
    ]);

    expect(scenarios.create).toHaveBeenCalledWith({ name: 'Test', triggerType: 'friend_add', isActive: false });
    expect(scenarios.addStep).toHaveBeenCalledTimes(2);
    expect(scenarios.addStep).toHaveBeenCalledWith('sc-1', {
      stepOrder: 1,
      delayMinutes: 0,
      messageType: 'text',
      messageContent: 'Hello',
    });
    expect(scenarios.addStep).toHaveBeenCalledWith('sc-1', {
      stepOrder: 2,
      delayMinutes: 1440,
      messageType: 'text',
      messageContent: 'Day 2',
    });
    expect(scenarios.get).toHaveBeenCalledWith('sc-1');
    expect(scenarios.update).toHaveBeenCalledWith('sc-1', { isActive: true });
    expect(vi.mocked(scenarios.update).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(scenarios.addStep).mock.invocationCallOrder[1],
    );
    expect(vi.mocked(scenarios.get).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(scenarios.update).mock.invocationCallOrder[0],
    );
  });

  it('keeps a partially constructed scenario inactive when a step write fails', async () => {
    const scenarios = mockScenarios();
    let active = true;
    const writtenSteps: string[] = [];
    vi.mocked(scenarios.create).mockImplementation(async (input) => {
      active = input.isActive !== false;
      return { id: 'sc-1', ...input } as Awaited<ReturnType<ScenariosResource['create']>>;
    });
    const failure = new Error('step write failed');
    vi.mocked(scenarios.addStep).mockImplementation(async (_id, step) => {
      if (writtenSteps.length === 1) throw failure;
      writtenSteps.push(step.messageContent);
      return {} as Awaited<ReturnType<ScenariosResource['addStep']>>;
    });
    const workflows = new Workflows(mockFriends(), scenarios, mockBroadcasts());

    await expect(
      workflows.createStepScenario('Test', 'friend_add', [
        { delay: '0m', type: 'text', content: 'First' },
        { delay: '1d', type: 'text', content: 'Second' },
      ]),
    ).rejects.toBe(failure);

    expect(writtenSteps).toEqual(['First']);
    expect(active).toBe(false);
    expect(scenarios.update).not.toHaveBeenCalled();
    expect(scenarios.get).not.toHaveBeenCalled();
  });

  it('propagates activation failure without reporting an active completed scenario', async () => {
    const scenarios = mockScenarios();
    vi.mocked(scenarios.create).mockResolvedValue({ id: 'sc-1' } as any);
    vi.mocked(scenarios.addStep).mockResolvedValue({} as any);
    const failure = new Error('activation failed');
    vi.mocked(scenarios.update).mockRejectedValue(failure);
    const workflows = new Workflows(mockFriends(), scenarios, mockBroadcasts());

    await expect(
      workflows.createStepScenario('Test', 'friend_add', [{ delay: '0m', type: 'text', content: 'First' }]),
    ).rejects.toBe(failure);
    expect(scenarios.get).not.toHaveBeenCalled();
  });

  it('broadcastText creates and sends broadcast', async () => {
    const friends = mockFriends();
    const scenarios = mockScenarios();
    const broadcasts = mockBroadcasts();
    const workflows = new Workflows(friends, scenarios, broadcasts);

    const created = { id: 'bc-1', title: 'Hello', status: 'draft' };
    const sent = { ...created, status: 'sent' };
    (broadcasts.create as any).mockResolvedValue(created);
    (broadcasts.send as any).mockResolvedValue(sent);

    const result = await workflows.broadcastText('Hello world!');

    expect(broadcasts.create).toHaveBeenCalledWith({
      title: 'Hello world!',
      messageType: 'text',
      messageContent: 'Hello world!',
      targetType: 'all',
    });
    expect(broadcasts.send).toHaveBeenCalledWith('bc-1');
    expect(result.status).toBe('sent');
  });

  it('broadcastToTag creates tagged broadcast and sends', async () => {
    const friends = mockFriends();
    const scenarios = mockScenarios();
    const broadcasts = mockBroadcasts();
    const workflows = new Workflows(friends, scenarios, broadcasts);

    const created = { id: 'bc-2', status: 'draft' };
    const sent = { ...created, status: 'sent' };
    (broadcasts.create as any).mockResolvedValue(created);
    (broadcasts.send as any).mockResolvedValue(sent);

    await workflows.broadcastToTag('tag-1', 'text', 'VIP only');

    expect(broadcasts.create).toHaveBeenCalledWith({
      title: 'VIP only',
      messageType: 'text',
      messageContent: 'VIP only',
      targetType: 'tag',
      targetTagId: 'tag-1',
    });
    expect(broadcasts.send).toHaveBeenCalledWith('bc-2');
  });

  it('sendTextToFriend sends text message', async () => {
    const friends = mockFriends();
    const scenarios = mockScenarios();
    const broadcasts = mockBroadcasts();
    const workflows = new Workflows(friends, scenarios, broadcasts);

    (friends.sendMessage as any).mockResolvedValue({ messageId: 'msg-1' });

    const result = await workflows.sendTextToFriend('friend-1', 'Hello!');

    expect(friends.sendMessage).toHaveBeenCalledWith('friend-1', 'Hello!', 'text');
    expect(result.messageId).toBe('msg-1');
  });

  it('sendFlexToFriend sends flex message', async () => {
    const friends = mockFriends();
    const scenarios = mockScenarios();
    const broadcasts = mockBroadcasts();
    const workflows = new Workflows(friends, scenarios, broadcasts);

    const flexJson = '{"type":"bubble","body":{"type":"box","layout":"vertical","contents":[]}}';
    (friends.sendMessage as any).mockResolvedValue({ messageId: 'msg-2' });

    const result = await workflows.sendFlexToFriend('friend-1', flexJson);

    expect(friends.sendMessage).toHaveBeenCalledWith('friend-1', flexJson, 'flex');
    expect(result.messageId).toBe('msg-2');
  });
});
