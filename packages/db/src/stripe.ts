import { jstNow } from './utils.js';
// Stripe決済連携クエリヘルパー

export interface StripeEventRow {
  id: string;
  stripe_event_id: string;
  event_type: string;
  friend_id: string | null;
  amount: number | null;
  currency: string | null;
  metadata: string | null;
  processed_at: string;
  effects_completed_at: string | null;
}

export async function getStripeEvents(db: D1Database, opts: { friendId?: string; eventType?: string; limit?: number; tenantId?: string } = {}): Promise<StripeEventRow[]> {
  const limit = opts.limit ?? 100;
  const filters: string[] = [];
  const params: unknown[] = [];
  let from = 'stripe_events';
  if (opts.tenantId) {
    // Tenant callers only see events attributable to their own friends; events
    // without a friend cannot be attributed to a tenant and are excluded.
    from = `stripe_events
      JOIN friends AS friend ON friend.id = stripe_events.friend_id
      JOIN tenant_line_accounts AS tenant_map
        ON tenant_map.line_account_id = friend.line_account_id`;
    filters.push('tenant_map.tenant_id = ?');
    params.push(opts.tenantId);
  }
  if (opts.friendId) {
    filters.push('stripe_events.friend_id = ?');
    params.push(opts.friendId);
  }
  if (opts.eventType) {
    filters.push('stripe_events.event_type = ?');
    params.push(opts.eventType);
  }
  const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
  const result = await db
    .prepare(`SELECT stripe_events.* FROM ${from}${where} ORDER BY stripe_events.processed_at DESC LIMIT ?`)
    .bind(...params, limit)
    .all<StripeEventRow>();
  return result.results;
}

export async function getStripeEventByStripeId(db: D1Database, stripeEventId: string): Promise<StripeEventRow | null> {
  return db.prepare(`SELECT * FROM stripe_events WHERE stripe_event_id = ?`).bind(stripeEventId).first<StripeEventRow>();
}

export async function createStripeEvent(
  db: D1Database,
  input: { stripeEventId: string; eventType: string; friendId?: string; amount?: number; currency?: string; metadata?: string },
): Promise<StripeEventRow> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db.prepare(`INSERT INTO stripe_events (id, stripe_event_id, event_type, friend_id, amount, currency, metadata, processed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, input.stripeEventId, input.eventType, input.friendId ?? null, input.amount ?? null, input.currency ?? null, input.metadata ?? null, now).run();
  return (await db.prepare(`SELECT * FROM stripe_events WHERE id = ?`).bind(id).first<StripeEventRow>())!;
}

/** Mark the receipt's side effects complete after every retry-safe step ran. */
export async function markStripeEventEffectsComplete(
  db: D1Database,
  stripeEventId: string,
): Promise<void> {
  await db
    .prepare(`UPDATE stripe_events SET effects_completed_at = ? WHERE stripe_event_id = ?`)
    .bind(jstNow(), stripeEventId)
    .run();
}
