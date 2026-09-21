import { beforeEach, describe, expect, it, vi } from 'vitest';

const getClient = vi.fn();
vi.mock('../src/client.js', () => ({ getClient }));
const { registerCreateScenario } = await import('../src/tools/create-scenario.js');

function handler() {
  const server = { tool: vi.fn() };
  registerCreateScenario(server as never);
  return server.tool.mock.calls[0][3] as (input: Record<string, unknown>) => Promise<{
    isError?: boolean; content: Array<{ text: string }>;
  }>;
}

describe('create_scenario partial writes', () => {
  let record: { id: string; isActive: boolean; steps: unknown[] } | undefined;
  let activeDuringSteps: boolean[];
  const api = { create: vi.fn(), addStep: vi.fn(), update: vi.fn(), get: vi.fn(), delete: vi.fn() };
  const input = {
    name: 'synthetic', triggerType: 'friend_add', accountId: 'account-a',
    steps: [{ delay: '0m', type: 'text', content: 'one' }, { delay: '30m', type: 'text', content: 'two' }],
  };
  beforeEach(() => {
    for (const mock of Object.values(api)) mock.mockReset();
    record = undefined;
    activeDuringSteps = [];
    getClient.mockReturnValue({ scenarios: api });
    api.create.mockImplementation(async (body) => {
      record = { id: 'scenario-a', isActive: body.isActive !== false, steps: [] };
      return record;
    });
    api.addStep.mockImplementation(async (_id, step) => {
      activeDuringSteps.push(record!.isActive);
      record!.steps.push(step);
      return step;
    });
    api.update.mockImplementation(async (_id, body) => { record!.isActive = body.isActive; return record; });
    api.get.mockImplementation(async () => record);
    api.delete.mockImplementation(async () => { record = undefined; });
  });

  it('retains saved steps and a lookup ID when the last step response is lost', async () => {
    api.addStep.mockImplementation(async (_id, step) => {
      activeDuringSteps.push(record!.isActive);
      record!.steps.push(step);
      if (step.stepOrder === 2) throw new Error('synthetic response lost');
      return step;
    });
    const result = await handler()(input);
    expect(record?.steps).toHaveLength(2);
    expect(record?.isActive).toBe(false);
    expect(activeDuringSteps).toEqual([false, false]);
    expect(api.delete).not.toHaveBeenCalled();
    expect(api.update).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      success: false, scenarioId: 'scenario-a', confirmedStepCount: 1, outcome: 'unknown',
    });
  });

  it('activates only after all steps are saved and keeps the success output', async () => {
    const result = await handler()(input);
    expect(activeDuringSteps).toEqual([false, false]);
    expect(api.create).toHaveBeenCalledWith({
      name: 'synthetic', triggerType: 'friend_add', triggerTagId: undefined,
      lineAccountId: 'account-a', isActive: false,
    });
    expect(api.update).toHaveBeenCalledWith('scenario-a', { isActive: true });
    expect(record?.isActive).toBe(true);
    expect(result.content[0].text).toBe(JSON.stringify({ success: true, scenario: record }, null, 2));
  });

  it('retains an activated scenario if activation commits but its response is lost', async () => {
    api.update.mockImplementation(async () => {
      record!.isActive = true;
      throw new Error('synthetic activation response lost');
    });
    const result = await handler()(input);
    expect(record?.isActive).toBe(true);
    expect(record?.steps).toHaveLength(2);
    expect(api.delete).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      success: false, scenarioId: 'scenario-a', confirmedStepCount: 2, outcome: 'unknown',
    });
    expect(api.update).toHaveBeenCalledTimes(1);
  });

  it('validates all delays before creating anything', async () => {
    const result = await handler()({ ...input, steps: [...input.steps, { delay: 'invalid', type: 'text', content: 'bad' }] });
    expect(result.isError).toBe(true);
    expect(api.create).not.toHaveBeenCalled();
  });
});
