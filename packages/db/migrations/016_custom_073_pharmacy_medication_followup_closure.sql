ALTER TABLE pharmacy_medication_followups
  ADD COLUMN question_set_version INTEGER NOT NULL DEFAULT 1 CHECK (question_set_version >= 1);

ALTER TABLE pharmacy_medication_followups
  ADD COLUMN response_deadline_at TEXT CHECK (
    response_deadline_at IS NULL OR unixepoch(response_deadline_at) IS NOT NULL
  );

CREATE TABLE pharmacy_medication_followup_contact_records (
  id                 TEXT PRIMARY KEY,
  followup_id        TEXT NOT NULL,
  line_account_id    TEXT NOT NULL,
  channel            TEXT NOT NULL CHECK (channel IN ('line', 'phone')),
  outcome_code       TEXT NOT NULL CHECK (
    outcome_code IN ('answered', 'no_answer', 'resolved', 'follow_up_required', 'escalated')
  ),
  next_contact_at    TEXT CHECK (
    next_contact_at IS NULL OR unixepoch(next_contact_at) IS NOT NULL
  ),
  actor_staff_id     TEXT NOT NULL,
  idempotency_key    TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  occurred_at        TEXT NOT NULL CHECK (unixepoch(occurred_at) IS NOT NULL),
  created_at         TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
  CHECK (outcome_code <> 'follow_up_required' OR next_contact_at IS NOT NULL),
  UNIQUE (line_account_id, idempotency_key),
  FOREIGN KEY (followup_id, line_account_id)
    REFERENCES pharmacy_medication_followups(id, line_account_id) ON DELETE CASCADE,
  FOREIGN KEY (actor_staff_id)
    REFERENCES staff_members(id)
);

CREATE INDEX idx_pharmacy_medication_followup_contacts_followup
  ON pharmacy_medication_followup_contact_records
     (line_account_id, followup_id, occurred_at DESC, id DESC);
