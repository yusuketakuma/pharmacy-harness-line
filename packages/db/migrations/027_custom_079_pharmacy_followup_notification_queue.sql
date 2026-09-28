-- Internal queue metadata; clinical due dates and versions are unchanged.
ALTER TABLE pharmacy_medication_followups ADD COLUMN notification_checked_at TEXT
  CHECK (notification_checked_at IS NULL OR unixepoch(notification_checked_at) IS NOT NULL);

CREATE INDEX idx_pharmacy_followup_notification_queue
  ON pharmacy_medication_followups (COALESCE(notification_checked_at, due_at), due_at, id)
  WHERE status IN ('scheduled', 'due');
