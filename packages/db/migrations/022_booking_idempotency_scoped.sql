-- Keep caller-scoped receipts in a separate key space from legacy raw keys.
-- The legacy table remains readable and writable by previous Worker versions.
CREATE TABLE IF NOT EXISTS booking_idempotency_scoped (
  line_account_id TEXT NOT NULL,
  friend_id       TEXT NOT NULL,
  key             TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body   TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  expires_at      TEXT NOT NULL,
  PRIMARY KEY (line_account_id, friend_id, key)
);

CREATE INDEX IF NOT EXISTS idx_booking_idempotency_scoped_expires
  ON booking_idempotency_scoped(expires_at);
