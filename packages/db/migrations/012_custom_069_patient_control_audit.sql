ALTER TABLE pharmacy_patient_owner_controls
  ADD COLUMN last_transition_id TEXT;

CREATE TABLE pharmacy_patient_control_audit_events (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL,
  patient_id      TEXT NOT NULL,
  owner_friend_id TEXT NOT NULL,
  actor_kind      TEXT NOT NULL CHECK (actor_kind IN ('patient', 'staff')),
  actor_id        TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  action          TEXT NOT NULL CHECK (action IN (
    'privacy_withdrawn',
    'privacy_reconsented',
    'notifications_stopped',
    'notifications_resumed',
    'binding_suspended',
    'proxy_granted',
    'proxy_revoked'
  )),
  control_version INTEGER NOT NULL CHECK (control_version >= 1),
  reason_code     TEXT CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 64),
  created_at      TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
  FOREIGN KEY (patient_id, line_account_id, owner_friend_id)
    REFERENCES pharmacy_patients(id, line_account_id, owner_friend_id)
);

CREATE INDEX idx_pharmacy_patient_control_audit_scope
  ON pharmacy_patient_control_audit_events
    (line_account_id, patient_id, owner_friend_id, created_at DESC, id DESC);

CREATE TRIGGER pharmacy_patient_control_audit_immutable_update
BEFORE UPDATE ON pharmacy_patient_control_audit_events
BEGIN
  SELECT RAISE(ABORT, 'pharmacy patient control audit is immutable'); END;

CREATE TRIGGER pharmacy_patient_control_audit_immutable_delete
BEFORE DELETE ON pharmacy_patient_control_audit_events
BEGIN
  SELECT RAISE(ABORT, 'pharmacy patient control audit is immutable'); END;
