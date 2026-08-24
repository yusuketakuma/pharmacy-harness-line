-- V032-4. Bounded disposition ledger for incoming LINE image retention.
--
-- The R2 key is intentionally kept only in this internal table.  Audit-facing
-- reports use status/reason_code and never copy message/friend/patient values.

CREATE TABLE IF NOT EXISTS pharmacy_incoming_image_dispositions (
  r2_key          TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  line_account_id TEXT NOT NULL,
  message_id      TEXT NOT NULL,
  stored_at       TEXT,
  stored_sha256   TEXT CHECK (stored_sha256 IS NULL OR length(stored_sha256) = 64),
  status          TEXT NOT NULL CHECK (status IN (
    'TRACKED', 'CLAIMED', 'CANCELLED_HELD', 'CANCELLED_UNKNOWN', 'CANCELLED_STALE',
    'DELETE_COMMITTED', 'FINALIZED_DELETED', 'OUTCOME_UNKNOWN',
    'ORPHAN', 'MISSING', 'OWNERSHIP_MISMATCH', 'UNKNOWN', 'BLOCKED'
  )),
  source          TEXT NOT NULL CHECK (source IN ('tracked_row', 'messages_log', 'r2_inventory', 'reconcile')),
  reason_code     TEXT NOT NULL CHECK (length(trim(reason_code)) BETWEEN 1 AND 120),
  hold_epoch      INTEGER NOT NULL DEFAULT 0 CHECK (hold_epoch >= 0),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts (tenant_id, line_account_id),
  UNIQUE (tenant_id, line_account_id, message_id, r2_key)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_incoming_image_dispositions_queue
  ON pharmacy_incoming_image_dispositions (status, updated_at, r2_key);

CREATE INDEX IF NOT EXISTS idx_pharmacy_incoming_image_dispositions_scope
  ON pharmacy_incoming_image_dispositions (tenant_id, line_account_id, status, stored_at);
