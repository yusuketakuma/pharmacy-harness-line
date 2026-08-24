-- Record one tenant-scoped attempt per stable event and webhook target.
-- `attempted` is not auto-reclaimed: the receiver may have accepted the HTTP
-- request even when the Worker could not settle D1, so replay needs the same
-- delivery id and an explicit reconciliation decision.
-- ponytail: metadata-only rows grow with stable events; add retention purge once operations define a safe window.

CREATE TABLE IF NOT EXISTS outgoing_webhook_deliveries (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  line_account_id TEXT,
  target_type     TEXT NOT NULL CHECK (target_type IN ('configured', 'automation')),
  target_id       TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  outcome         TEXT NOT NULL CHECK (outcome IN ('attempted', 'sent', 'failed')),
  claim_token     TEXT,
  attempt_count   INTEGER NOT NULL CHECK (attempt_count >= 1),
  http_status     INTEGER CHECK (http_status BETWEEN 100 AND 599),
  attempted_at    TEXT NOT NULL,
  settled_at      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK (
    (outcome = 'attempted' AND claim_token IS NOT NULL AND settled_at IS NULL)
    OR
    (outcome IN ('sent', 'failed') AND claim_token IS NULL AND settled_at IS NOT NULL)
  ),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts(tenant_id, line_account_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_outgoing_webhook_deliveries_reconcile
  ON outgoing_webhook_deliveries(tenant_id, line_account_id, outcome, updated_at);
