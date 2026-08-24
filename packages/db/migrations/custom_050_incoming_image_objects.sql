-- NEXT-4. Track the R2 key of every incoming LINE chat image.
--
-- Today the only record of an incoming image's R2 key is the JSON URL
-- embedded inside messages_log.content (see apps/worker/src/services/
-- incoming-image.ts and apps/worker/src/routes/integrations/webhook.ts).
-- That makes it impossible for a future retention job to find and delete
-- these objects without parsing message content. This is a forward-only,
-- additive tracking table: no purge, no backfill sweep, no ALTER of
-- messages_log.

CREATE TABLE IF NOT EXISTS pharmacy_incoming_image_objects (
  r2_key          TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  line_account_id TEXT NOT NULL,
  message_id      TEXT NOT NULL,
  stored_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_incoming_image_objects_account
  ON pharmacy_incoming_image_objects (line_account_id, stored_at);
