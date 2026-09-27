-- Retry ordering is independent of the existing 15-minute delivery claim.
ALTER TABLE pharmacy_prescription_validities ADD COLUMN notification_checked_at TEXT
  CHECK (notification_checked_at IS NULL OR unixepoch(notification_checked_at) IS NOT NULL);

CREATE INDEX idx_pharmacy_validity_notification_queue
  ON pharmacy_prescription_validities (COALESCE(notification_checked_at, reminder_due_at), reminder_due_at, submission_id)
  WHERE verification_status = 'verified' AND reminder_sent_at IS NULL;
