-- Account-scoped staff activity inbox.
-- Deliberately stores only an event kind and opaque idempotency key; callers
-- must not copy patient, prescription, or LINE identity data here.

-- SQLite requires a unique parent key for a composite foreign key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_id_line_account
  ON staff (id, line_account_id);

CREATE TABLE IF NOT EXISTS pharmacy_activity_notifications (
  id                TEXT PRIMARY KEY,
  line_account_id   TEXT NOT NULL,
  staff_id          TEXT NOT NULL
    CHECK (length(trim(staff_id)) BETWEEN 1 AND 160
           AND staff_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
  activity_type     TEXT NOT NULL CHECK (activity_type IN
    ('prescription_received', 'prescription_status_changed',
     'fulfillment_quote_created', 'myna_handoff_received',
     'patient_message_received', 'continuity_due', 'manual_activity')),
  idempotency_key   TEXT NOT NULL
    CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 160
           AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
  status            TEXT NOT NULL DEFAULT 'unread'
    CHECK (status IN ('unread', 'claimed', 'acknowledged')),
  claimed_by        TEXT,
  claimed_at        TEXT,
  acknowledged_by   TEXT,
  acknowledged_at   TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK (
    (status = 'unread' AND claimed_by IS NULL AND claimed_at IS NULL
      AND acknowledged_by IS NULL AND acknowledged_at IS NULL)
    OR
    (status = 'claimed' AND claimed_by IS NOT NULL AND claimed_at IS NOT NULL
      AND acknowledged_by IS NULL AND acknowledged_at IS NULL)
    OR
    (status = 'acknowledged' AND claimed_by IS NOT NULL AND claimed_at IS NOT NULL
      AND acknowledged_by IS NOT NULL AND acknowledged_at IS NOT NULL)
  ),
  UNIQUE (id, line_account_id),
  UNIQUE (line_account_id, staff_id, idempotency_key),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id),
  FOREIGN KEY (staff_id, line_account_id)
    REFERENCES staff(id, line_account_id)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_activity_notifications_inbox
  ON pharmacy_activity_notifications
     (line_account_id, staff_id, status, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS pharmacy_activity_notification_events (
  id                TEXT PRIMARY KEY,
  notification_id   TEXT NOT NULL,
  line_account_id   TEXT NOT NULL,
  event_type        TEXT NOT NULL CHECK (event_type IN
    ('created', 'claimed', 'acknowledged')),
  actor_type        TEXT NOT NULL CHECK (actor_type IN ('system', 'staff')),
  actor_id          TEXT,
  created_at        TEXT NOT NULL,
  CHECK ((actor_type = 'system' AND actor_id IS NULL)
      OR (actor_type = 'staff' AND actor_id IS NOT NULL)),
  FOREIGN KEY (notification_id, line_account_id)
    REFERENCES pharmacy_activity_notifications(id, line_account_id)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_activity_notification_events_history
  ON pharmacy_activity_notification_events
     (line_account_id, notification_id, created_at, id);
