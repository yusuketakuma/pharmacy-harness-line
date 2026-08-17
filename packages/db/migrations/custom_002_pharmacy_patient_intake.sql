-- Pharmacy-owned patient profiles and immutable intake revisions.
-- The LINE friend is the authenticated submitter; the patient may be a family member.

ALTER TABLE pharmacy_prescription_submissions
  ADD COLUMN intake_required INTEGER NOT NULL DEFAULT 0
  CHECK (intake_required IN (0, 1));

CREATE UNIQUE INDEX idx_pharmacy_prescription_submissions_scope
  ON pharmacy_prescription_submissions (id, line_account_id, friend_id);

CREATE UNIQUE INDEX idx_pharmacy_prescription_submissions_account
  ON pharmacy_prescription_submissions (id, line_account_id);

CREATE TABLE pharmacy_patients (
  id               TEXT PRIMARY KEY,
  line_account_id  TEXT NOT NULL REFERENCES line_accounts(id),
  owner_friend_id  TEXT NOT NULL,
  relationship     TEXT NOT NULL CHECK (relationship IN ('self','child','spouse','parent','other')),
  name             TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  name_kana        TEXT NOT NULL CHECK (length(trim(name_kana)) BETWEEN 1 AND 120),
  birth_date       TEXT NOT NULL CHECK (length(birth_date) = 10),
  sex              TEXT CHECK (sex IS NULL OR sex IN ('male','female','other','prefer_not_to_say')),
  contact_phone    TEXT,
  archived_at     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (id, line_account_id, owner_friend_id),
  FOREIGN KEY (owner_friend_id, line_account_id)
    REFERENCES friends(id, line_account_id)
);

CREATE UNIQUE INDEX idx_pharmacy_patients_active_self
  ON pharmacy_patients (line_account_id, owner_friend_id)
  WHERE relationship = 'self' AND archived_at IS NULL;

CREATE INDEX idx_pharmacy_patients_owner
  ON pharmacy_patients (line_account_id, owner_friend_id, archived_at, updated_at DESC, id);

CREATE TABLE pharmacy_patient_intake_responses (
  id                          TEXT PRIMARY KEY,
  line_account_id             TEXT NOT NULL,
  owner_friend_id             TEXT NOT NULL,
  patient_id                  TEXT NOT NULL,
  revision                    INTEGER NOT NULL CHECK (revision >= 1),
  schema_version              INTEGER NOT NULL CHECK (schema_version >= 1),
  patient_snapshot_json       TEXT NOT NULL CHECK (json_valid(patient_snapshot_json)),
  answers_json                TEXT NOT NULL
    CHECK (json_valid(answers_json) AND length(answers_json) BETWEEN 2 AND 32768),
  base_response_id            TEXT,
  idempotency_key             TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  representative_consent_at  TEXT NOT NULL,
  privacy_consent_at          TEXT NOT NULL,
  created_at                  TEXT NOT NULL,
  UNIQUE (id, patient_id, line_account_id, owner_friend_id),
  UNIQUE (line_account_id, patient_id, revision),
  UNIQUE (line_account_id, owner_friend_id, patient_id, idempotency_key),
  FOREIGN KEY (patient_id, line_account_id, owner_friend_id)
    REFERENCES pharmacy_patients(id, line_account_id, owner_friend_id),
  FOREIGN KEY (base_response_id)
    REFERENCES pharmacy_patient_intake_responses(id)
);

CREATE INDEX idx_pharmacy_intake_responses_patient
  ON pharmacy_patient_intake_responses (line_account_id, patient_id, revision DESC, id DESC);

CREATE TABLE pharmacy_prescription_patients (
  submission_id      TEXT PRIMARY KEY,
  line_account_id    TEXT NOT NULL,
  owner_friend_id    TEXT NOT NULL,
  patient_id         TEXT NOT NULL,
  intake_response_id TEXT NOT NULL,
  reviewed_at        TEXT,
  reviewed_by        TEXT,
  created_at         TEXT NOT NULL,
  UNIQUE (submission_id, line_account_id, owner_friend_id),
  FOREIGN KEY (submission_id, line_account_id, owner_friend_id)
    REFERENCES pharmacy_prescription_submissions(id, line_account_id, friend_id),
  FOREIGN KEY (patient_id, line_account_id, owner_friend_id)
    REFERENCES pharmacy_patients(id, line_account_id, owner_friend_id),
  FOREIGN KEY (intake_response_id, patient_id, line_account_id, owner_friend_id)
    REFERENCES pharmacy_patient_intake_responses(id, patient_id, line_account_id, owner_friend_id)
);

CREATE INDEX idx_pharmacy_prescription_patients_patient
  ON pharmacy_prescription_patients (line_account_id, patient_id, created_at DESC, submission_id);
