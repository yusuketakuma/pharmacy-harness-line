-- Account-shared, PHI-free activity inbox. Dedupe input is stored only as SHA-256.

CREATE TABLE IF NOT EXISTS pharmacy_activity_notifications (
  id                TEXT PRIMARY KEY,
  line_account_id   TEXT NOT NULL,
  activity_type     TEXT NOT NULL CHECK (activity_type IN
    ('prescription_received', 'prescription_status_changed',
     'fulfillment_quote_created', 'myna_handoff_received')),
  dedupe_hash       TEXT NOT NULL
    CHECK (length(dedupe_hash) = 64 AND dedupe_hash NOT GLOB '*[^0-9a-f]*'),
  acknowledged_by  TEXT,
  acknowledged_at  TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK ((acknowledged_by IS NULL AND acknowledged_at IS NULL)
      OR (acknowledged_by IS NOT NULL AND acknowledged_at IS NOT NULL)),
  UNIQUE (id, line_account_id),
  UNIQUE (line_account_id, dedupe_hash),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_activity_notifications_open
  ON pharmacy_activity_notifications
     (line_account_id, acknowledged_at, created_at DESC, id DESC);
