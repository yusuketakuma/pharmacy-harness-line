ALTER TABLE friends
  ADD COLUMN follow_state_changed_at TEXT CHECK (
    follow_state_changed_at IS NULL OR unixepoch(follow_state_changed_at) IS NOT NULL
  );

ALTER TABLE friends
  ADD COLUMN follow_state_event_id TEXT;

CREATE TABLE pharmacy_medication_followup_operations (
  line_account_id          TEXT PRIMARY KEY REFERENCES line_accounts(id) ON DELETE CASCADE,
  service_hours_text       TEXT NOT NULL CHECK (length(trim(service_hours_text)) BETWEEN 1 AND 2048),
  response_sla_json        TEXT NOT NULL CHECK (
    json_valid(response_sla_json) AND length(response_sla_json) BETWEEN 2 AND 4096
  ),
  primary_staff_id         TEXT NOT NULL REFERENCES staff_members(id),
  backup_staff_id          TEXT REFERENCES staff_members(id),
  after_hours_message_code TEXT NOT NULL CHECK (
    after_hours_message_code IN ('contact_pharmacy_during_hours', 'seek_urgent_care')
  ),
  emergency_message_code   TEXT NOT NULL CHECK (
    emergency_message_code IN ('contact_pharmacy_during_hours', 'seek_urgent_care')
  ),
  enabled                  INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  version                  INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at               TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
  updated_at               TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL),
  CHECK (backup_staff_id IS NULL OR backup_staff_id <> primary_staff_id)
);

CREATE INDEX idx_pharmacy_medication_followup_operations_enabled
  ON pharmacy_medication_followup_operations(line_account_id, enabled);
