ALTER TABLE pharmacy_patient_proxy_grants
  ADD COLUMN superseded_at TEXT CHECK (
    superseded_at IS NULL OR unixepoch(superseded_at) IS NOT NULL
  );

ALTER TABLE pharmacy_patient_proxy_grants
  ADD COLUMN last_transition_id TEXT;

UPDATE pharmacy_patient_proxy_grants AS older
   SET superseded_at = older.updated_at
 WHERE older.revoked_at IS NULL
   AND EXISTS (
     SELECT 1 FROM pharmacy_patient_proxy_grants AS newer
      WHERE newer.line_account_id = older.line_account_id
        AND newer.patient_id = older.patient_id
        AND newer.actor_friend_id = older.actor_friend_id
        AND newer.permission_code = older.permission_code
        AND newer.revoked_at IS NULL
        AND (newer.granted_at > older.granted_at OR
             (newer.granted_at = older.granted_at AND newer.id > older.id))
   );

CREATE UNIQUE INDEX ux_pharmacy_patient_proxy_current
  ON pharmacy_patient_proxy_grants
    (line_account_id, patient_id, actor_friend_id, permission_code)
  WHERE revoked_at IS NULL AND superseded_at IS NULL;

ALTER TABLE pharmacy_patients
  ADD COLUMN registration_idempotency_key TEXT;

ALTER TABLE pharmacy_patients
  ADD COLUMN registration_request_hash TEXT CHECK (
    registration_request_hash IS NULL OR
    (length(registration_request_hash) = 64 AND
     registration_request_hash NOT GLOB '*[^0-9a-f]*')
  );

CREATE UNIQUE INDEX ux_pharmacy_patient_registration_idempotency
  ON pharmacy_patients
    (line_account_id, owner_friend_id, registration_idempotency_key)
  WHERE registration_idempotency_key IS NOT NULL;

ALTER TABLE pharmacy_patient_control_audit_events
  ADD COLUMN grant_id TEXT REFERENCES pharmacy_patient_proxy_grants(id);

ALTER TABLE pharmacy_patient_control_audit_events
  ADD COLUMN permission_code TEXT CHECK (
    permission_code IS NULL OR permission_code = 'patient_intake_v1'
  );

ALTER TABLE pharmacy_patient_control_audit_events
  ADD COLUMN basis_code TEXT CHECK (
    basis_code IS NULL OR length(basis_code) BETWEEN 1 AND 64
  );

ALTER TABLE pharmacy_patient_control_audit_events
  ADD COLUMN terms_version INTEGER CHECK (
    terms_version IS NULL OR terms_version >= 1
  );

ALTER TABLE pharmacy_patient_control_audit_events
  ADD COLUMN terms_hash TEXT CHECK (
    terms_hash IS NULL OR
    (length(terms_hash) = 64 AND terms_hash NOT GLOB '*[^0-9a-f]*')
  );

CREATE TRIGGER pharmacy_patient_proxy_grant_structure_immutable
BEFORE UPDATE OF
  line_account_id, patient_id, actor_friend_id, permission_code, basis_code,
  terms_version, terms_hash, granted_at, expires_at, created_at
ON pharmacy_patient_proxy_grants
BEGIN
  SELECT RAISE(ABORT, 'pharmacy patient proxy grant structure is immutable'); END;
