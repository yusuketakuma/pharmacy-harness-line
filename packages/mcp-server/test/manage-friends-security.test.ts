import { expect, it, vi } from 'vitest';
import { registerManageFriends } from '../src/tools/manage-friends.js';
it('rejects friend and rich menu path injection at the tool schema', () => {
  const tool = vi.fn();
  registerManageFriends({ tool } as never);
  const schema = tool.mock.calls[0][2];
  for (const key of ['friendId', 'richMenuId']) {
    expect(schema[key].safeParse('../line-accounts/id?').success).toBe(false);
    expect(schema[key].safeParse('synthetic-id_123').success).toBe(true);
  }
});
