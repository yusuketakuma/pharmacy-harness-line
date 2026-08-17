-- Immutable pharmacist-owned fulfillment quotes for each submitted prescription.
-- The JSON is a bounded connector contract; clinical notes stay out of it.

CREATE TABLE pharmacy_fulfillment_quotes (
  id                    TEXT PRIMARY KEY,
  submission_id         TEXT NOT NULL,
  line_account_id       TEXT NOT NULL,
  revision              INTEGER NOT NULL CHECK (revision >= 1),
  decision              TEXT NOT NULL CHECK (decision IN
    ('fulfillable','conditional','needs_confirmation','not_fulfillable')),
  reason_codes_json     TEXT NOT NULL
    CHECK (json_valid(reason_codes_json) AND length(reason_codes_json) BETWEEN 2 AND 4096),
  requirements_json     TEXT NOT NULL
    CHECK (json_valid(requirements_json) AND length(requirements_json) BETWEEN 2 AND 8192),
  estimated_ready_at    TEXT,
  valid_until           TEXT,
  created_by            TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  UNIQUE (submission_id, line_account_id, revision),
  FOREIGN KEY (submission_id, line_account_id)
    REFERENCES pharmacy_prescription_submissions(id, line_account_id)
);

CREATE INDEX idx_pharmacy_fulfillment_quotes_submission
  ON pharmacy_fulfillment_quotes (line_account_id, submission_id, revision DESC, created_at DESC);

CREATE INDEX idx_pharmacy_fulfillment_quotes_decision
  ON pharmacy_fulfillment_quotes (line_account_id, decision, created_at DESC);
