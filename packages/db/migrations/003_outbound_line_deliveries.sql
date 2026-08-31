ALTER TABLE friend_scenarios ADD COLUMN delivery_claim_token TEXT;

CREATE TABLE outbound_line_deliveries (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  line_account_id    TEXT NOT NULL,
  source             TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 64),
  delivery_type      TEXT NOT NULL CHECK (delivery_type IN ('push', 'reply', 'broadcast')),
  outcome            TEXT NOT NULL CHECK (outcome IN ('open', 'accepted', 'retired')),
  retry_key          TEXT UNIQUE,
  request_json       TEXT CHECK (request_json IS NULL OR json_valid(request_json)),
  prepare_token      TEXT NOT NULL,
  attempt_count      INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  retry_until        TEXT NOT NULL,
  first_attempted_at TEXT,
  attempted_at       TEXT,
  settled_at         TEXT,
  stop_reason        TEXT CHECK (stop_reason IS NULL OR stop_reason IN (
                       'retry_window_expired', 'reply_outcome_unknown', 'payload_unavailable',
                       'local_precondition_failed', 'reply_rejected'
                     )),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  CHECK (
    (delivery_type IN ('push', 'broadcast') AND retry_key IS NOT NULL)
    OR (delivery_type = 'reply' AND retry_key IS NULL)
  ),
  CHECK (
    (delivery_type = 'broadcast' AND request_json IS NOT NULL)
    OR (delivery_type IN ('push', 'reply') AND request_json IS NULL)
  ),
  CHECK (
    (outcome = 'open' AND settled_at IS NULL AND stop_reason IS NULL)
    OR (outcome = 'accepted' AND settled_at IS NOT NULL AND stop_reason IS NULL)
    OR (outcome = 'retired' AND settled_at IS NOT NULL AND stop_reason IS NOT NULL)
  ),
  UNIQUE (id, tenant_id, line_account_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts(tenant_id, line_account_id) ON DELETE RESTRICT
);

CREATE TABLE outbound_line_delivery_payloads (
  operation_id   TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  line_account_id TEXT NOT NULL,
  friend_id      TEXT NOT NULL,
  message_type  TEXT NOT NULL,
  log_content   TEXT NOT NULL,
  log_delivery_type TEXT NOT NULL CHECK (log_delivery_type IN ('push', 'reply', 'test')),
  request_json  TEXT CHECK (request_json IS NULL OR json_valid(request_json)),
  broadcast_id  TEXT REFERENCES broadcasts(id) ON DELETE SET NULL,
  scenario_enrollment_id TEXT REFERENCES friend_scenarios(id) ON DELETE SET NULL,
  scenario_step_id       TEXT REFERENCES scenario_steps(id) ON DELETE SET NULL,
  scenario_claim_token   TEXT,
  template_id_at_send    TEXT,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (operation_id, tenant_id, line_account_id)
    REFERENCES outbound_line_deliveries(id, tenant_id, line_account_id) ON DELETE CASCADE,
  FOREIGN KEY (friend_id, line_account_id)
    REFERENCES friends(id, line_account_id) ON DELETE CASCADE
);

ALTER TABLE messages_log
  ADD COLUMN outbound_operation_id TEXT REFERENCES outbound_line_deliveries(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX idx_messages_log_outbound_operation
  ON messages_log(outbound_operation_id)
  WHERE outbound_operation_id IS NOT NULL;

CREATE INDEX idx_outbound_line_deliveries_reconcile
  ON outbound_line_deliveries(tenant_id, line_account_id, outcome, updated_at);
