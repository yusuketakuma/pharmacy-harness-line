-- LINE webhookEventId is the provider retry/idempotency key. Keep it scoped
-- to both tenant and account so one account can never suppress another.
CREATE TABLE IF NOT EXISTS pharmacy_webhook_event_receipts (
  tenant_id        TEXT NOT NULL,
  line_account_id  TEXT NOT NULL,
  webhook_event_id TEXT NOT NULL,
  received_at      TEXT NOT NULL,
  PRIMARY KEY (tenant_id, line_account_id, webhook_event_id),
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts(tenant_id, line_account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_webhook_event_receipts_received
  ON pharmacy_webhook_event_receipts (received_at);
