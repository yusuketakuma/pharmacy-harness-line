-- Distinguish "event received" from "effects applied" so a Stripe retry after a
-- mid-handler failure re-runs the side effects instead of being swallowed by
-- the receipt check. Historical receipts stay complete: they were written only
-- after the old handler attempted its effects path.
ALTER TABLE stripe_events ADD COLUMN effects_completed_at TEXT;
UPDATE stripe_events SET effects_completed_at = processed_at;

-- Scoring was the only webhook effect with no replay guard. A nullable dedupe
-- key keeps existing callers unchanged while letting event-driven callers
-- (e.g. Stripe retries) re-apply rules exactly once.
ALTER TABLE friend_scores ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX idx_friend_scores_idempotency_key
  ON friend_scores (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
