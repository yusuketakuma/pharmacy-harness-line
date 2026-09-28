ALTER TABLE pharmacy_account_capabilities
  ADD COLUMN beta_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (beta_enabled IN (0, 1));

CREATE TABLE pharmacy_beta_memberships (
  id                    TEXT PRIMARY KEY NOT NULL,
  line_account_id       TEXT NOT NULL,
  participant_friend_id TEXT NOT NULL,
  subject_patient_id    TEXT NOT NULL,
  subject_owner_friend_id TEXT NOT NULL,
  access_kind           TEXT NOT NULL CHECK (access_kind IN ('self', 'family')),
  status                TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'suspended', 'revoked')),
  starts_at             TEXT NOT NULL CHECK (unixepoch(starts_at) IS NOT NULL),
  expires_at            TEXT NOT NULL CHECK (
    unixepoch(expires_at) IS NOT NULL AND
    unixepoch(expires_at) > unixepoch(starts_at)
  ),
  revoked_at            TEXT CHECK (revoked_at IS NULL OR unixepoch(revoked_at) IS NOT NULL),
  revoke_reason_code    TEXT CHECK (
    revoke_reason_code IS NULL OR length(trim(revoke_reason_code)) BETWEEN 1 AND 64
  ),
  version               INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_transition_id    TEXT,
  created_at            TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
  updated_at            TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL),
  CHECK ((status = 'revoked' AND revoked_at IS NOT NULL) OR
         (status <> 'revoked' AND revoked_at IS NULL)),
  CHECK ((status = 'revoked' AND revoked_at IS NOT NULL AND revoke_reason_code IS NOT NULL) OR
         (status <> 'revoked' AND revoked_at IS NULL AND revoke_reason_code IS NULL)),
  FOREIGN KEY (participant_friend_id, line_account_id)
    REFERENCES friends(id, line_account_id) ON DELETE RESTRICT,
  FOREIGN KEY (subject_patient_id, line_account_id, subject_owner_friend_id)
    REFERENCES pharmacy_patients(id, line_account_id, owner_friend_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX ux_pharmacy_beta_membership_current
  ON pharmacy_beta_memberships(line_account_id, participant_friend_id, subject_patient_id)
  WHERE status IN ('active', 'suspended') AND revoked_at IS NULL;

CREATE INDEX idx_pharmacy_beta_memberships_participant
  ON pharmacy_beta_memberships(line_account_id, participant_friend_id, status, starts_at, expires_at);

CREATE INDEX idx_pharmacy_beta_memberships_subject
  ON pharmacy_beta_memberships(line_account_id, subject_patient_id, status, starts_at, expires_at);
