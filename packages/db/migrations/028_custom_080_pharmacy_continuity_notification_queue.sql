-- Internal queue metadata; patient timing and clinical versions are unchanged.
ALTER TABLE pharmacy_next_intake_expectations ADD COLUMN notification_checked_at TEXT
  CHECK (notification_checked_at IS NULL OR unixepoch(notification_checked_at) IS NOT NULL);

CREATE INDEX idx_pharmacy_continuity_notification_queue
  ON pharmacy_next_intake_expectations (COALESCE(notification_checked_at, reminder_at), reminder_at, id)
  WHERE status IN ('accepted', 'active');
