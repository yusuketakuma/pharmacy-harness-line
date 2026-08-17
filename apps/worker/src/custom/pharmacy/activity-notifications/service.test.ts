import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertMembership: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  claim: vi.fn(),
  acknowledge: vi.fn(),
  listEvents: vi.fn(),
}));

vi.mock('./repository.js', () => mocks);

import {
  acknowledgeActivityNotification,
  claimActivityNotification,
  enqueueActivityNotifications,
  listActivityNotificationEvents,
  listActivityNotifications,
} from './service.js';

const db = {} as D1Database;
const notification = {
  id: 'notification-1', line_account_id: 'account-1', staff_id: 'staff-1',
  activity_type: 'prescription_received', status: 'unread',
  claimed_by: null, claimed_at: null, acknowledged_by: null, acknowledged_at: null,
  created_at: '2026-08-18T00:00:00.000Z', updated_at: '2026-08-18T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertMembership.mockResolvedValue(undefined);
  mocks.create.mockImplementation(async (_db, input) => ({
    ...notification,
    id: `notification-${input.staffId}`,
    staff_id: input.staffId,
  }));
  mocks.list.mockResolvedValue([notification]);
  mocks.claim.mockResolvedValue({ ...notification, status: 'claimed', claimed_by: 'staff-1' });
  mocks.acknowledge.mockResolvedValue({ ...notification, status: 'acknowledged', acknowledged_by: 'staff-1' });
  mocks.listEvents.mockResolvedValue([{ id: 'event-1', event_type: 'created' }]);
});

describe('pharmacy activity notification service', () => {
  it('rejects unsupported event types before touching the repository', async () => {
    await expect(enqueueActivityNotifications(db, {
      lineAccountId: 'account-1',
      activityType: 'patient_name_changed' as never,
      staffIds: ['staff-1'],
      idempotencyKey: 'event-1',
    })).rejects.toThrow('invalid activity type');
    expect(mocks.assertMembership).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('deduplicates recipients and checks every recipient in the account before fan-out', async () => {
    await expect(enqueueActivityNotifications(db, {
      lineAccountId: 'account-1',
      activityType: 'prescription_received',
      staffIds: ['staff-1', 'staff-1', 'staff-2'],
      idempotencyKey: 'prescription:event-1',
    })).resolves.toHaveLength(2);
    expect(mocks.assertMembership).toHaveBeenNthCalledWith(1, db, 'account-1', 'staff-1');
    expect(mocks.assertMembership).toHaveBeenNthCalledWith(2, db, 'account-1', 'staff-2');
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.create).toHaveBeenCalledWith(db, expect.objectContaining({
      lineAccountId: 'account-1', activityType: 'prescription_received',
      staffId: 'staff-2', idempotencyKey: 'prescription:event-1',
    }));
  });

  it('checks all recipient memberships before creating any row', async () => {
    mocks.assertMembership
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('staff is not assigned to pharmacy account'));
    await expect(enqueueActivityNotifications(db, {
      lineAccountId: 'account-1',
      activityType: 'prescription_received',
      staffIds: ['staff-1', 'staff-2'],
      idempotencyKey: 'prescription:event-2',
    })).rejects.toThrow('not assigned');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('requires recipient membership for reads and state transitions', async () => {
    await listActivityNotifications(db, 'account-1', 'staff-1', { status: 'unread', limit: 20 });
    await claimActivityNotification(db, 'account-1', 'notification-1', 'staff-1');
    await acknowledgeActivityNotification(db, 'account-1', 'notification-1', 'staff-1');
    await listActivityNotificationEvents(db, 'account-1', 'notification-1', 'staff-1');
    expect(mocks.assertMembership).toHaveBeenCalledTimes(4);
    expect(mocks.list).toHaveBeenCalledWith(db, 'account-1', 'staff-1', { status: 'unread', limit: 20 });
    expect(mocks.claim).toHaveBeenCalledWith(db, 'account-1', 'notification-1', 'staff-1');
    expect(mocks.acknowledge).toHaveBeenCalledWith(db, 'account-1', 'notification-1', 'staff-1');
    expect(mocks.listEvents).toHaveBeenCalledWith(db, 'account-1', 'notification-1', 'staff-1');
  });
});
