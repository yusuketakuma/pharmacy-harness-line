CREATE TABLE pharmacy_patient_proxy_grants (
  id                 TEXT PRIMARY KEY,
  line_account_id    TEXT NOT NULL,
  patient_id         TEXT NOT NULL,
  actor_friend_id    TEXT NOT NULL,
  permission_code    TEXT NOT NULL CHECK (permission_code = 'patient_intake_v1'),
  basis_code         TEXT NOT NULL CHECK (length(basis_code) BETWEEN 1 AND 64),
  terms_version      INTEGER NOT NULL CHECK (terms_version >= 1),
  terms_hash         TEXT NOT NULL CHECK (
    length(terms_hash) = 64 AND terms_hash NOT GLOB '*[^0-9a-f]*'
  ),
  granted_at         TEXT NOT NULL CHECK (unixepoch(granted_at) IS NOT NULL),
  expires_at         TEXT NOT NULL CHECK (
    unixepoch(expires_at) IS NOT NULL AND unixepoch(expires_at) > unixepoch(granted_at)
  ),
  revoked_at         TEXT CHECK (revoked_at IS NULL OR unixepoch(revoked_at) IS NOT NULL),
  revoke_reason_code TEXT,
  version            INTEGER NOT NULL CHECK (version >= 1),
  created_at         TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
  updated_at         TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL),
  CHECK (
    (revoked_at IS NULL AND revoke_reason_code IS NULL) OR
    (revoked_at IS NOT NULL AND length(revoke_reason_code) BETWEEN 1 AND 64)
  ),
  FOREIGN KEY (patient_id, line_account_id, actor_friend_id)
    REFERENCES pharmacy_patients(id, line_account_id, owner_friend_id)
);

CREATE INDEX idx_pharmacy_patient_proxy_grants_access
  ON pharmacy_patient_proxy_grants
    (line_account_id, patient_id, actor_friend_id, permission_code, revoked_at, expires_at);

CREATE TABLE pharmacy_patient_owner_controls (
  line_account_id          TEXT NOT NULL,
  patient_id               TEXT NOT NULL,
  owner_friend_id          TEXT NOT NULL,
  privacy_withdrawn_at     TEXT CHECK (
    privacy_withdrawn_at IS NULL OR unixepoch(privacy_withdrawn_at) IS NOT NULL
  ),
  privacy_reconsented_at   TEXT CHECK (
    privacy_reconsented_at IS NULL OR unixepoch(privacy_reconsented_at) IS NOT NULL
  ),
  privacy_policy_version   INTEGER CHECK (
    privacy_policy_version IS NULL OR privacy_policy_version >= 1
  ),
  privacy_policy_hash      TEXT CHECK (
    privacy_policy_hash IS NULL OR
    (length(privacy_policy_hash) = 64 AND privacy_policy_hash NOT GLOB '*[^0-9a-f]*')
  ),
  notifications_stopped_at TEXT CHECK (
    notifications_stopped_at IS NULL OR unixepoch(notifications_stopped_at) IS NOT NULL
  ),
  notifications_resumed_at TEXT CHECK (
    notifications_resumed_at IS NULL OR unixepoch(notifications_resumed_at) IS NOT NULL
  ),
  binding_suspended_at     TEXT CHECK (
    binding_suspended_at IS NULL OR unixepoch(binding_suspended_at) IS NOT NULL
  ),
  binding_reason_code      TEXT,
  version                  INTEGER NOT NULL CHECK (version >= 1),
  updated_at               TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL),
  PRIMARY KEY (line_account_id, patient_id),
  CHECK (
    (privacy_policy_version IS NULL) = (privacy_policy_hash IS NULL)
  ),
  CHECK (
    (binding_suspended_at IS NULL AND binding_reason_code IS NULL) OR
    (binding_suspended_at IS NOT NULL AND length(binding_reason_code) BETWEEN 1 AND 64)
  ),
  FOREIGN KEY (patient_id, line_account_id, owner_friend_id)
    REFERENCES pharmacy_patients(id, line_account_id, owner_friend_id)
);

ALTER TABLE pharmacy_patient_intake_responses
  ADD COLUMN proxy_grant_id TEXT REFERENCES pharmacy_patient_proxy_grants(id);
