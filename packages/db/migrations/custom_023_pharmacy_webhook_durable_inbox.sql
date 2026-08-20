-- H-3: turn the webhook receipt into a durable inbox entry.
--
-- The receipt row used to be a dedup claim only. The Worker wrote the claim,
-- returned 200 to LINE, and processed the event in waitUntil(). An isolate
-- evicted between the ACK and the deferred handler lost the event for good:
-- LINE redelivery is best-effort, and a redelivery that did arrive was
-- silently dropped by the claim it left behind.
--
-- Keeping the state on the existing row (instead of a second table) preserves
-- the tenant/account-scoped primary key and the ON DELETE CASCADE that already
-- express the isolation guarantee.
--
-- Existing rows default to 'completed': they were written by the claim-only
-- path, carry no payload, and must keep suppressing redelivery.

ALTER TABLE pharmacy_webhook_event_receipts
  ADD COLUMN payload TEXT;

ALTER TABLE pharmacy_webhook_event_receipts
  ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed'));

ALTER TABLE pharmacy_webhook_event_receipts
  ADD COLUMN lease_until TEXT;

ALTER TABLE pharmacy_webhook_event_receipts
  ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE pharmacy_webhook_event_receipts
  ADD COLUMN dead_lettered_at TEXT;

-- Cron sweep: unfinished rows whose lease has expired, oldest first.
CREATE INDEX IF NOT EXISTS idx_pharmacy_webhook_event_receipts_sweep
  ON pharmacy_webhook_event_receipts (lease_until, received_at)
  WHERE status <> 'completed' AND dead_lettered_at IS NULL;
